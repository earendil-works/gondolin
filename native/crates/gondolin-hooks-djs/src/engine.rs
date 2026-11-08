//! The adapter over djs (`djs-embed`): the only module that names a djs type.
//!
//! [`Program::compile`] builds a snapshot from the shim and the policy (a
//! script or an ES module with in-memory imports); [`Program::call`] runs one
//! entry point of the shim in an instance reset to that snapshot, serves the
//! host functions (URL parsing, console, lazy body reads) and returns the
//! settled decision as plain data ([`gondolin_wire::Value`]). Every failure
//! (exception, budget, panic, non-data result) is an `Err` text: callers fail
//! closed.

use std::sync::Mutex;
use std::time::Duration;

use djs_embed::{
    CallId, Data, Error, HostFn, Instance, Limits as DjsLimits, ModuleMap, Snapshot, Source, Step,
    Throw, Value,
};
use gondolin_egress::{IpAllowInfo, RequestHead, ResponseHead};
use gondolin_wire::Value as Wire;

const SHIM: &str = include_str!("shim.js");

const URL_PARSE: u32 = 1;
const BODY_READ: u32 = 2;
const LOG: u32 = 3;

/// Idle instances kept for reuse
const MAX_POOLED: usize = 16;
/// Heap an idle instance keeps in `bytes` (a reset keeps the allocation a
/// call grew; beyond this it is returned). A header-only call needs ~320 KiB
/// (the snapshot), a 256 KiB body ~640 KiB.
pub const IDLE_HEAP_CAP: usize = 1 << 20;
/// Fuel per slice (about 1 ms): how often a long call yields its runtime worker
const SLICE_FUEL: u64 = 200_000;
/// Fuel budget of the setup (shim + policy top level)
const SETUP_FUEL: u64 = 1_000_000_000;
/// Longest console line kept in `bytes`
const MAX_LOG_BYTES: usize = 8 * 1024;

/// How a policy source is evaluated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// global functions
    Script,
    /// an ES module's exports
    Module,
    /// an ES module in TypeScript
    TypeScript,
}

/// A policy to compile.
#[derive(Debug, Clone)]
pub struct PolicySource<'a> {
    pub source: &'a str,
    /// stack-trace name and the module key of a module policy
    pub filename: &'a str,
    pub kind: SourceKind,
    /// importable modules by specifier (module policies)
    pub modules: Vec<(&'a str, &'a str)>,
}

/// Per-call budgets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// fuel per call
    pub fuel: u64,
    /// heap cap in `bytes`
    pub memory: usize,
    /// wall-clock time per call, body reads included
    pub timeout: Duration,
}

/// Which hook phases the policy defines.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Phases {
    pub is_request_allowed: bool,
    pub is_ip_allowed: bool,
    pub on_request: bool,
    pub on_response: bool,
}

/// Host side of a call's async and logging host functions.
pub trait Host: Send {
    /// Console output of the policy.
    fn log(&mut self, level: &str, text: &str);
    /// Reads host body `stream` whole (`Err`: a message for the script's `TypeError`).
    fn read_body(
        &mut self,
        stream: i32,
    ) -> impl Future<Output = Result<bytes::Bytes, String>> + Send;
}

/// One call's entry point and arguments.
pub enum Entry<'a> {
    IsRequestAllowed(&'a RequestHead),
    IsIpAllowed(&'a IpAllowInfo),
    /// head, body stream (`-1`: none)
    OnRequest(&'a RequestHead, i32),
    /// head, body stream (`-1`: none), final request head
    OnResponse(&'a ResponseHead, i32, &'a RequestHead),
}

/// A compiled policy: its snapshot and a pool of instances.
pub struct Program {
    snapshot: Snapshot,
    limits: Limits,
    phases: Phases,
    pool: Mutex<Vec<Instance>>,
    /// reuse instances (reset to the snapshot) instead of a fresh one per call
    pooling: std::sync::atomic::AtomicBool,
    /// heap an idle instance keeps in `bytes`
    idle_heap_cap: std::sync::atomic::AtomicUsize,
}

impl std::fmt::Debug for Program {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Program")
            .field("image_len", &self.snapshot.image_len())
            .field("limits", &self.limits)
            .field("phases", &self.phases)
            .finish()
    }
}

fn djs_limits(limits: &Limits) -> DjsLimits {
    DjsLimits {
        memory: limits.memory,
        fuel: limits.fuel,
        slice: SLICE_FUEL.min(limits.fuel.max(1)),
        deadline: Some(limits.timeout),
    }
}

impl Program {
    /// Compiles the shim and `policy` into a snapshot; a syntax, link or
    /// top-level error is the `Err` text.
    pub fn compile(policy: &PolicySource<'_>, limits: Limits) -> Result<Program, String> {
        let mut builder = Snapshot::builder()
            .host_fn(HostFn::sync(URL_PARSE, "__url_parse"))
            .host_fn(HostFn::asynchronous(BODY_READ, "__body_read"))
            .host_fn(HostFn::sync(LOG, "__log"))
            .memory(limits.memory)
            .fuel(SETUP_FUEL)
            .source(Source::script("<gondolin-hooks>", SHIM));
        match policy.kind {
            SourceKind::Script => {
                if !policy.modules.is_empty() {
                    return Err("modules can only be imported by a module policy".into());
                }
                // Global lexical bindings (`const onRequest = ...`) are not
                // properties of the global object: name them directly.
                let bind = "__gondolin_bind({\n\
                    isRequestAllowed: typeof isRequestAllowed === \"function\" ? isRequestAllowed : undefined,\n\
                    isIpAllowed: typeof isIpAllowed === \"function\" ? isIpAllowed : undefined,\n\
                    onRequest: typeof onRequest === \"function\" ? onRequest : undefined,\n\
                    onResponse: typeof onResponse === \"function\" ? onResponse : undefined,\n\
                });";
                builder = builder
                    .source(Source::script(policy.filename, policy.source))
                    .source(Source::script("<gondolin-bind>", bind));
            }
            SourceKind::Module | SourceKind::TypeScript => {
                // the policy is loaded through the map, imported by the binder
                let mut map = ModuleMap::new();
                for (key, text) in &policy.modules {
                    map.insert(*key, module_source(key, text));
                }
                let own = match policy.kind {
                    SourceKind::TypeScript => djs_embed::ModuleSource::typescript(policy.source),
                    _ => djs_embed::ModuleSource::js(policy.source),
                };
                map.insert(policy.filename, own);
                let key = gondolin_wire::json::to_string(&Wire::Text(policy.filename.into()));
                builder = builder.loader(map).source(Source::module(
                    "<gondolin-bind>",
                    format!("import * as policy from {key};\n__gondolin_bind(policy);\n"),
                ));
            }
        }
        let snapshot = builder.build().map_err(|e| e.to_string())?;
        let mut program = Program {
            snapshot,
            limits,
            phases: Phases::default(),
            pool: Mutex::new(Vec::new()),
            pooling: std::sync::atomic::AtomicBool::new(true),
            idle_heap_cap: std::sync::atomic::AtomicUsize::new(IDLE_HEAP_CAP),
        };
        let mut no_host = NoHost;
        let phases = block_on(program.run("__gondolin_phases", &[], &mut no_host))?;
        let flag = |k: &str| matches!(phases.get(k), Some(Wire::Bool(true)));
        program.phases = Phases {
            is_request_allowed: flag("isRequestAllowed"),
            is_ip_allowed: flag("isIpAllowed"),
            on_request: flag("onRequest"),
            on_response: flag("onResponse"),
        };
        Ok(program)
    }

    pub fn phases(&self) -> Phases {
        self.phases
    }

    /// Heap an idle pooled instance keeps in `bytes` (benchmarks).
    pub fn set_idle_heap_cap(&self, bytes: usize) {
        self.idle_heap_cap.store(bytes, std::sync::atomic::Ordering::Relaxed);
    }

    /// Heap sizes of the idle pooled instances in `bytes` (tests).
    pub fn idle_heap_sizes(&self) -> Vec<usize> {
        self.pool.lock().unwrap().iter().map(Instance::heap_size).collect()
    }

    /// Whether instances are reused (reset to the snapshot after each call,
    /// the default) or made fresh per call (benchmarks).
    pub fn set_pooling(&self, on: bool) {
        self.pooling.store(on, std::sync::atomic::Ordering::Relaxed);
        if !on {
            self.pool.lock().unwrap().clear();
        }
    }

    /// Size of the snapshot image in `bytes`.
    pub fn image_len(&self) -> usize {
        self.snapshot.image_len()
    }

    /// Runs one hook call; the settled decision as plain data.
    pub async fn call<H: Host>(&self, entry: Entry<'_>, host: &mut H) -> Result<Wire, String> {
        // a request head as a djs object borrowing the host's strings
        macro_rules! request_value {
            ($head:expr => $fields:ident) => {
                let pairs = header_pairs(&$head.headers);
                let headers: Vec<Value<'_>> = pairs.iter().map(|p| Value::Array(p)).collect();
                let $fields = [
                    ("method", Value::Str(&$head.method)),
                    ("url", Value::Str(&$head.url)),
                    ("headers", Value::Array(&headers)),
                ];
            };
        }
        match entry {
            Entry::IsRequestAllowed(head) => {
                request_value!(head => req);
                self.run("__gondolin_is_request_allowed", &[Value::Object(&req)], host).await
            }
            Entry::IsIpAllowed(info) => {
                let ip = info.ip.to_string();
                let fields = [
                    ("hostname", Value::Str(&info.hostname)),
                    ("ip", Value::Str(&ip)),
                    ("family", Value::Number(if info.ip.is_ipv6() { 6.0 } else { 4.0 })),
                    ("port", Value::Number(f64::from(info.port))),
                    ("protocol", Value::Str(info.protocol)),
                ];
                self.run("__gondolin_is_ip_allowed", &[Value::Object(&fields)], host).await
            }
            Entry::OnRequest(head, stream) => {
                request_value!(head => req);
                let args = [Value::Object(&req), Value::Number(f64::from(stream))];
                self.run("__gondolin_on_request", &args, host).await
            }
            Entry::OnResponse(head, stream, request) => {
                let pairs = header_pairs(&head.headers);
                let headers: Vec<Value<'_>> = pairs.iter().map(|p| Value::Array(p)).collect();
                let res = [
                    ("status", Value::Number(f64::from(head.status))),
                    ("statusText", Value::Str(&head.status_text)),
                    ("headers", Value::Array(&headers)),
                ];
                request_value!(request => req);
                let args =
                    [Value::Object(&res), Value::Number(f64::from(stream)), Value::Object(&req)];
                self.run("__gondolin_on_response", &args, host).await
            }
        }
    }

    fn take(&self) -> Result<Instance, String> {
        if let Some(i) = self.pool.lock().unwrap().pop() {
            return Ok(i);
        }
        self.snapshot.instantiate(djs_limits(&self.limits)).map_err(|e| e.to_string())
    }

    fn put(&self, mut instance: Instance) {
        if !self.pooling.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        // back to the snapshot's state: no call sees what an earlier one left
        if instance.reset().is_err() {
            return;
        }
        // a reset keeps the allocation the call grew the heap to: give back
        // what is beyond the cap, so idle instances stay small
        let cap = self.idle_heap_cap.load(std::sync::atomic::Ordering::Relaxed);
        if instance.heap_size() > cap && instance.shrink_heap(cap).is_err() {
            return;
        }
        let mut pool = self.pool.lock().unwrap();
        if pool.len() < MAX_POOLED {
            pool.push(instance);
        }
    }

    async fn run<H: Host>(
        &self,
        entry: &str,
        args: &[Value<'_>],
        host: &mut H,
    ) -> Result<Wire, String> {
        let mut instance = self.take()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        let result = async {
            instance.set_now(now).map_err(describe)?;
            instance.start(entry, args).map_err(describe)?;
            drive(&mut instance, host).await
        }
        .await;
        // a failed call may have left half-done state (or poisoned the
        // instance): only clean instances go back
        if result.is_ok() {
            self.put(instance);
        }
        result
    }
}

/// An importable module; the key's extension picks the language.
fn module_source(key: &str, text: &str) -> djs_embed::ModuleSource {
    if [".ts", ".mts", ".cts"].iter().any(|e| key.ends_with(e)) {
        djs_embed::ModuleSource::typescript(text)
    } else if key.ends_with(".json") {
        djs_embed::ModuleSource::json(text)
    } else {
        djs_embed::ModuleSource::js(text)
    }
}

fn describe(e: Error) -> String {
    match e {
        Error::Exception(ex) => match ex.stack {
            Some(stack) if !stack.is_empty() => format!("hook threw {}\n{stack}", ex.message),
            _ => format!("hook threw {}", ex.message),
        },
        Error::OutOfFuel { budget } => format!("hook exceeded its fuel budget ({budget})"),
        Error::Deadline => "hook exceeded its time limit".into(),
        Error::OutOfMemory => "hook exceeded its memory limit".into(),
        Error::NeverSettles => "hook never settles (waits on nothing)".into(),
        Error::Data(m) => format!("hook returned an invalid decision: {m}"),
        Error::Panicked(m) => format!("hook engine panicked: {m}"),
        e => format!("hook failed: {e}"),
    }
}

fn header_pairs(headers: &[(String, String)]) -> Vec<[Value<'_>; 2]> {
    headers.iter().map(|(k, v)| [Value::Str(k), Value::Str(v)]).collect()
}

/// Runs the call to its end.
async fn drive<H: Host>(instance: &mut Instance, host: &mut H) -> Result<Wire, String> {
    // body bytes per stream, read once (clones read the cache)
    let mut bodies: Vec<(i32, bytes::Bytes)> = Vec::new();
    loop {
        match instance.step().map_err(describe)? {
            Step::Done => {
                let data = instance.result().map_err(describe)?.to_data().map_err(describe)?;
                return Ok(to_wire(data));
            }
            // a slice ended: give the runtime its worker back
            Step::Yield => tokio::task::yield_now().await,
            Step::HostCall(id) => serve_sync(instance, id, host)?,
            Step::Wait(ids) => {
                if ids.is_empty() {
                    return Err("hook waits on host calls nobody answers".into());
                }
                for id in ids {
                    serve_async(instance, id, host, &mut bodies).await?;
                }
            }
        }
    }
}

fn serve_sync<H: Host>(instance: &mut Instance, id: CallId, host: &mut H) -> Result<(), String> {
    let call = instance.host_call(id).map_err(describe)?;
    let reply = match call.fn_id() {
        URL_PARSE => {
            let input = call.arg(0).as_str().map(|s| s.into_owned());
            let base = call.arg(1).as_str().map(|s| s.into_owned());
            match input {
                Some(input) => match crate::url::components(&input, base.as_deref()) {
                    Ok(c) => {
                        let fields: Vec<(&str, Value<'_>)> =
                            c.iter().map(|(k, v)| (*k, Value::Str(v))).collect();
                        return call.reply(Ok(Value::Object(&fields))).map_err(describe);
                    }
                    Err(msg) => Err(Throw::type_error(msg)),
                },
                None => Err(Throw::type_error("Invalid URL")),
            }
        }
        LOG => {
            let level = call.arg(0).as_str().map(|s| s.into_owned()).unwrap_or_default();
            let mut text = call.arg(1).as_str().map(|s| s.into_owned()).unwrap_or_default();
            if text.len() > MAX_LOG_BYTES {
                let mut end = MAX_LOG_BYTES;
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
                text.push('…');
            }
            host.log(&level, &text);
            Ok(Value::Undefined)
        }
        f => Err(Throw::type_error(format!("unknown host function {f}"))),
    };
    call.reply(reply).map_err(describe)
}

async fn serve_async<H: Host>(
    instance: &mut Instance,
    id: CallId,
    host: &mut H,
    bodies: &mut Vec<(i32, bytes::Bytes)>,
) -> Result<(), String> {
    let (fn_id, stream, text) = {
        let call = instance.host_call(id).map_err(describe)?;
        let stream = call.arg(0).as_number().unwrap_or(-1.0);
        let text = call.arg(1).as_str().is_some_and(|k| k == "text");
        (call.fn_id(), stream, text)
    };
    if fn_id != BODY_READ || stream < 0.0 || stream > f64::from(i32::MAX) {
        return instance.resolve(id, Err(Throw::type_error("no such body"))).map_err(describe);
    }
    let stream = stream as i32;
    let cached = bodies.iter().find(|(s, _)| *s == stream).map(|(_, b)| b.clone());
    let read = match cached {
        Some(b) => Ok(b),
        None => {
            let deadline = instance.deadline().map(tokio::time::Instant::from_std);
            let read = host.read_body(stream);
            let result = match deadline {
                Some(at) => match tokio::time::timeout_at(at, read).await {
                    Ok(r) => r,
                    Err(_) => return Err("hook exceeded its time limit (reading the body)".into()),
                },
                None => read.await,
            };
            if let Ok(b) = &result {
                bodies.push((stream, b.clone()));
            }
            result
        }
    };
    let reply = match &read {
        // the VM decodes text (UTF-8, invalid sequences replaced, as `text()`)
        Ok(b) if text => Ok(Value::Utf8(b)),
        Ok(b) => Ok(Value::Bytes(b)),
        Err(msg) => Err(Throw::type_error(msg.clone())),
    };
    instance.resolve(id, reply).map_err(describe)
}

/// djs plain data as gondolin's data model (numbers that are integers become
/// integers; `undefined` and holes become null).
fn to_wire(d: Data) -> Wire {
    match d {
        Data::Undefined | Data::Null | Data::Hole => Wire::Null,
        Data::Bool(b) => Wire::Bool(b),
        Data::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
                Wire::Integer(n as i128)
            } else {
                Wire::Float(n)
            }
        }
        Data::String(s) => Wire::Text(s),
        Data::Bytes(b) => Wire::Bytes(b),
        Data::Array(items) => Wire::Array(items.into_iter().map(to_wire).collect()),
        Data::Object(entries) => {
            Wire::Map(entries.into_iter().map(|(k, v)| (Wire::Text(k), to_wire(v))).collect())
        }
    }
}

/// The setup-time call (`__gondolin_phases`) has no host work to await.
struct NoHost;

impl Host for NoHost {
    fn log(&mut self, _level: &str, _text: &str) {}
    async fn read_body(&mut self, _stream: i32) -> Result<bytes::Bytes, String> {
        Err("no body".into())
    }
}

/// Polls a future that never waits on I/O to completion (the phases query
/// at compile time, which at most yields between fuel slices).
fn block_on<F: Future>(f: F) -> F::Output {
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    let mut f = std::pin::pin!(f);
    loop {
        if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}
