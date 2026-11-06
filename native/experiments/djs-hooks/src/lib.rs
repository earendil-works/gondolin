//! Prototype: djs (tier 2) as an egress `HookBackend` inside gondolind.
//!
//! A policy script is compiled once together with the hook shim (`shim.js`)
//! into a VM whose image is kept as a snapshot. Each `on_request` then runs in
//! either a fresh VM made from that snapshot (no state across requests) or a
//! pooled, long-lived VM. Heads go in as wire-encoded plain data, the body
//! stays on the host until the script awaits `req.text()`/`bytes()` (an async
//! host function), and the decision comes back as JSON. Any failure (syntax
//! error, exception, fuel or memory exhausted, engine error) fails closed.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Fuel the last finished call used (for the benchmark's report).
pub static LAST_FUEL: AtomicU64 = AtomicU64::new(0);

use async_trait::async_trait;
use djs_core::compiler::CompileOptions;
use djs_core::interp::{Intrinsic, intrinsic};
use djs_core::value::Value;
use djs_core::vm::{ErrorKind, Status, Vm, VmOptions};
use gondolin_egress::{
    Blocked, BodyChoice, BodyHandle, HookBackend, HookError, RequestDecision, RequestHead,
    ResponseHead, full_body,
};
use gondolin_proto::net::{BodyHookRegistration, HookRegistrations};

const SHIM: &str = include_str!("shim.js");

const URL_PARSE: u32 = 1;
const BODY_READ: u32 = 2;
const LOG: u32 = 3;
const SETTLE: u32 = 4;

/// How hook calls get a VM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// a fresh VM from the policy snapshot per call (isolation, no state)
    Fresh,
    /// long-lived VMs from a pool (globals persist across calls)
    Pooled,
}

/// Limits of one hook call.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// fuel budget of one call
    pub fuel: u64,
    /// fuel per `run` slice (how often the host regains control)
    pub slice: u64,
    /// heap cap in `bytes`
    pub memory: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { fuel: 50_000_000, slice: 200_000, memory: 64 << 20 }
    }
}

/// The compiled policy.
pub struct DjsHooks {
    image: Vec<u8>,
    opts: VmOptions,
    limits: Limits,
    mode: Mode,
    pool: Mutex<Vec<Vm>>,
    body: bool,
}

fn vm_opts(limits: &Limits) -> VmOptions {
    VmOptions { memory_limit: limits.memory, frozen_builtins: true, ..VmOptions::default() }
}

/// Runs the VM until the call settles, serving sync host calls; async calls
/// (body reads) are answered by `serve_async`. Returns the decision's JSON text
/// or a failure text.
async fn drive(vm: &mut Vm, limits: &Limits, body: Option<&BodyHandle>) -> Result<String, String> {
    let mut used = 0u64;
    let mut cache: Option<bytes::Bytes> = None;
    let mut settled: Option<Result<String, String>> = None;
    loop {
        // Engine panics are djs bugs; they fail the call closed and the VM is dropped.
        let run =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| vm.run_metered(limits.slice)));
        let Ok((status, fuel)) = run else {
            return Err("hook engine panicked".into());
        };
        used += fuel;
        match status {
            Status::Done(_) => {
                LAST_FUEL.store(used, Ordering::Relaxed);
                return settled.unwrap_or_else(|| Err("hook never settled".into()));
            }
            Status::Threw(e) => {
                let shown = vm.error_stack(e).unwrap_or_else(|| vm.display(e));
                return Err(format!("hook threw: {shown}"));
            }
            Status::OutOfFuel => {
                if used >= limits.fuel {
                    vm.abort();
                    return Err(format!("hook exceeded its fuel budget ({} units)", limits.fuel));
                }
                // Give the runtime its worker back between slices.
                tokio::task::yield_now().await;
            }
            Status::HostCall { call_id, fn_id } if fn_id == SETTLE => {
                let info = vm.host_call(call_id).ok_or("lost host call")?;
                let ok = info.args.first().and_then(|v| v.as_bool()).unwrap_or(false);
                let text = arg_string(vm, info.args.get(1)).unwrap_or_default();
                settled = Some(if ok { Ok(text) } else { Err(format!("hook threw: {text}")) });
                vm.resolve_host_call(call_id, Ok(Value::UNDEFINED))
                    .map_err(|e| format!("{e:?}"))?;
            }
            Status::HostCall { call_id, fn_id } => {
                let result = serve_sync(vm, call_id, fn_id);
                vm.resolve_host_call(call_id, result).map_err(|e| format!("{e:?}"))?;
            }
            Status::Idle => {
                let calls = vm.new_host_calls();
                if calls.is_empty() {
                    if let Some(s) = settled {
                        LAST_FUEL.store(used, Ordering::Relaxed);
                        return s;
                    }
                    vm.abort();
                    return Err("hook is waiting on nothing (unresolved promise)".into());
                }
                for id in calls {
                    let result = serve_async(vm, id, body, &mut cache).await;
                    vm.resolve_host_call(id, result).map_err(|e| format!("{e:?}"))?;
                }
            }
            Status::HostOutOfMemory => return Err("hook ran out of host memory".into()),
        }
    }
}

fn arg_string(vm: &Vm, v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v.as_string()).map(|s| vm.heap().str_to_string(s))
}

fn type_error(vm: &mut Vm, msg: &str) -> Value {
    vm.new_error(ErrorKind::TypeError, msg).unwrap_or(Value::UNDEFINED)
}

fn serve_sync(vm: &mut Vm, call_id: u32, fn_id: u32) -> Result<Value, Value> {
    let Some(info) = vm.host_call(call_id) else {
        return Err(Value::UNDEFINED);
    };
    match fn_id {
        URL_PARSE => {
            let input = arg_string(vm, info.args.first()).unwrap_or_default();
            let base = arg_string(vm, info.args.get(1));
            let parsed = match base {
                Some(b) => url::Url::parse(&b).and_then(|b| b.join(&input)),
                None => url::Url::parse(&input),
            };
            match parsed {
                Ok(u) => {
                    let port = u.port().map(|p| p.to_string()).unwrap_or_default();
                    let host = match u.port() {
                        Some(p) => format!("{}:{p}", u.host_str().unwrap_or("")),
                        None => u.host_str().unwrap_or("").to_string(),
                    };
                    let mut w = wire::Writer::new();
                    w.object(&[
                        ("href", wire::V::Str(u.as_str())),
                        ("origin", wire::V::Str(&u.origin().ascii_serialization())),
                        ("protocol", wire::V::Str(&format!("{}:", u.scheme()))),
                        ("username", wire::V::Str(u.username())),
                        ("password", wire::V::Str(u.password().unwrap_or(""))),
                        ("host", wire::V::Str(&host)),
                        ("hostname", wire::V::Str(u.host_str().unwrap_or(""))),
                        ("port", wire::V::Str(&port)),
                        ("pathname", wire::V::Str(u.path())),
                        (
                            "search",
                            wire::V::Str(&u.query().map(|q| format!("?{q}")).unwrap_or_default()),
                        ),
                        (
                            "hash",
                            wire::V::Str(
                                &u.fragment().map(|f| format!("#{f}")).unwrap_or_default(),
                            ),
                        ),
                    ]);
                    decode(vm, &w.finish()).map_err(|e| type_error(vm, &e))
                }
                Err(e) => Err(type_error(vm, &format!("Invalid URL: {input} ({e})"))),
            }
        }
        LOG => {
            let text = arg_string(vm, info.args.first()).unwrap_or_default();
            eprintln!("[hook] {text}");
            Ok(Value::UNDEFINED)
        }
        _ => Err(type_error(vm, "unknown host function")),
    }
}

async fn serve_async(
    vm: &mut Vm,
    call_id: u32,
    body: Option<&BodyHandle>,
    cache: &mut Option<bytes::Bytes>,
) -> Result<Value, Value> {
    let Some(info) = vm.host_call(call_id) else {
        return Err(Value::UNDEFINED);
    };
    if info.fn_id != BODY_READ {
        return Err(type_error(vm, "unknown host function"));
    }
    let kind = arg_string(vm, info.args.get(1)).unwrap_or_default();
    let Some(body) = body else {
        return Err(type_error(vm, "no body"));
    };
    // Read once per call; clones of the request read the cached bytes.
    let bytes = match cache {
        Some(b) => b.clone(),
        None => match body.read_to_end().await {
            Ok(b) => cache.insert(b).clone(),
            Err(e) => return Err(type_error(vm, &format!("body read failed: {e}"))),
        },
    };
    let mut w = wire::Writer::new();
    if kind == "text" {
        match std::str::from_utf8(&bytes) {
            Ok(text) => w.str(text),
            Err(_) => w.str(&String::from_utf8_lossy(&bytes)),
        }
    } else {
        w.bytes(&bytes);
    }
    decode(vm, &w.finish()).map_err(|e| type_error(vm, &e))
}

fn decode(vm: &mut Vm, buf: &[u8]) -> Result<Value, String> {
    let heap = vm.heap_mut();
    let opts = djs_core::wire::DecodeOptions {
        object_proto: intrinsic(heap, Intrinsic::ObjectProto).as_object(),
        array_proto: intrinsic(heap, Intrinsic::ArrayProto).as_object(),
        ..Default::default()
    };
    djs_core::wire::decode(heap, buf, &opts).map_err(|e| e.text())
}

impl DjsHooks {
    /// Compiles `policy` (a script defining `onRequest(request)`) into a snapshot.
    pub fn new(policy: &str, mode: Mode, limits: Limits, body: bool) -> Result<Self, String> {
        let opts = vm_opts(&limits);
        let mut vm = djs_prelude::new_vm(opts).map_err(|e| format!("{e:?}"))?;
        for (id, name, is_async) in [
            (URL_PARSE, "__url_parse", false),
            (BODY_READ, "__body_read", true),
            (LOG, "__log", false),
            (SETTLE, "__settle", false),
        ] {
            let f = if is_async {
                vm.new_async_host_function(id, name)
            } else {
                vm.new_host_function(id, name)
            }
            .map_err(|e| format!("{e:?}"))?;
            vm.define_global(name, f).map_err(|e| format!("{e:?}"))?;
        }
        for (name, src) in [("<gondolin-hooks>", SHIM), ("policy.js", policy)] {
            let f = vm
                .compile(src.as_bytes(), &CompileOptions::script(name))
                .map_err(|e| format!("{name}: {e}"))?;
            vm.call(f, Value::object(vm.global()), &[]).map_err(|e| format!("{e:?}"))?;
            match vm.run(limits.fuel) {
                Status::Done(_) => {}
                Status::Threw(e) => return Err(format!("{name}: {}", vm.display(e))),
                s => return Err(format!("{name}: did not finish ({s:?})")),
            }
        }
        vm.collect().map_err(|e| format!("{e:?}"))?;
        let image = vm.image().to_vec();
        Ok(DjsHooks { image, opts, limits, mode, pool: Mutex::new(Vec::new()), body })
    }

    pub fn image_len(&self) -> usize {
        self.image.len()
    }

    fn take_vm(&self) -> Result<Vm, String> {
        if self.mode == Mode::Pooled
            && let Some(vm) = self.pool.lock().unwrap().pop()
        {
            return Ok(vm);
        }
        Vm::from_bytes_trusted(self.image.clone(), self.opts).map_err(|e| format!("{e:?}"))
    }

    fn put_vm(&self, vm: Vm) {
        if self.mode == Mode::Pooled {
            self.pool.lock().unwrap().push(vm);
        }
    }

    /// Runs `onRequest`; `Err` text means fail closed.
    pub async fn run_on_request(
        &self,
        head: &RequestHead,
        body: Option<&BodyHandle>,
    ) -> Result<serde_json::Value, String> {
        let mut vm = self.take_vm()?;
        let result = async {
            let f = vm.global_path("__gondolin_on_request").ok_or("shim missing")?;
            let headers: Vec<wire::V> = head
                .headers
                .iter()
                .map(|(k, v)| wire::V::Arr(vec![wire::V::Str(k), wire::V::Str(v)]))
                .collect();
            let mut w = wire::Writer::new();
            w.object(&[
                ("method", wire::V::Str(&head.method)),
                ("url", wire::V::Str(&head.url)),
                ("headers", wire::V::Arr(headers)),
            ]);
            let arg = decode(&mut vm, &w.finish())?;
            let stream = Value::number(if body.is_some() { 1.0 } else { -1.0 });
            vm.call(f, Value::UNDEFINED, &[arg, stream]).map_err(|e| format!("{e:?}"))?;
            let text = drive(&mut vm, &self.limits, body).await?;
            serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string())
        }
        .await;
        // A VM whose call failed (or panicked) may hold half-done state: only reuse clean ones.
        if result.is_ok() {
            self.put_vm(vm);
        }
        result
    }
}

fn pairs(v: &serde_json::Value) -> Vec<(String, String)> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| Some((p[0].as_str()?.to_string(), p[1].as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn body_choice(v: &serde_json::Value) -> BodyChoice {
    match v["kind"].as_str() {
        Some("original") => BodyChoice::Original,
        Some("text") => BodyChoice::Body(full_body(v["text"].as_str().unwrap_or("").to_string())),
        Some("bytes") => BodyChoice::Body(full_body(
            v["bytes"]
                .as_array()
                .map(|a| a.iter().filter_map(|b| b.as_u64()).map(|b| b as u8).collect::<Vec<_>>())
                .unwrap_or_default(),
        )),
        _ => BodyChoice::None,
    }
}

#[async_trait]
impl HookBackend for DjsHooks {
    fn registrations(&self) -> HookRegistrations {
        HookRegistrations {
            on_request: Some(BodyHookRegistration { body: self.body }),
            ..Default::default()
        }
    }

    async fn on_request(
        &self,
        request: RequestHead,
        body: Option<BodyHandle>,
    ) -> Result<RequestDecision, HookError> {
        let d = self.run_on_request(&request, body.as_ref()).await.map_err(HookError::Failed)?;
        match d["action"].as_str() {
            Some("continue") => Ok(RequestDecision::Continue),
            Some("request") => Ok(RequestDecision::Request {
                head: RequestHead {
                    method: d["head"]["method"].as_str().unwrap_or("GET").to_string(),
                    url: d["head"]["url"].as_str().unwrap_or_default().to_string(),
                    headers: pairs(&d["head"]["headers"]),
                },
                body: body_choice(&d["body"]),
            }),
            Some("respond") => Ok(RequestDecision::Respond {
                head: ResponseHead {
                    status: d["head"]["status"].as_u64().unwrap_or(200) as u16,
                    status_text: d["head"]["statusText"].as_str().unwrap_or("").to_string(),
                    headers: pairs(&d["head"]["headers"]),
                },
                body: body_choice(&d["body"]),
            }),
            Some("block") => Err(HookError::Blocked(Blocked::new(
                d["status"].as_u64().unwrap_or(403) as u16,
                d["statusText"].as_str().unwrap_or("Forbidden"),
                d["message"].as_str().unwrap_or("request blocked"),
            ))),
            _ => Err(HookError::Failed(format!("bad hook decision: {d}"))),
        }
    }
}

/// Minimal encoder of djs's inbound wire format (docs/wire.md).
pub mod wire {
    pub enum V<'a> {
        Str(&'a str),
        Arr(Vec<V<'a>>),
    }

    pub struct Writer {
        out: Vec<u8>,
        keys: Vec<String>,
    }

    impl Default for Writer {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Writer {
        pub fn new() -> Writer {
            Writer { out: b"DJW\x01".to_vec(), keys: Vec::new() }
        }

        fn varint(&mut self, mut v: usize) {
            while v >= 0x80 {
                self.out.push((v as u8 & 0x7f) | 0x80);
                v >>= 7;
            }
            self.out.push(v as u8);
        }

        pub fn str(&mut self, s: &str) {
            self.out.push(0x10);
            // The format wants the UTF-16 length up front; ASCII is the common case.
            let units = if s.is_ascii() { s.len() } else { s.encode_utf16().count() };
            self.varint(units);
            self.varint(s.len());
            self.out.extend_from_slice(s.as_bytes());
        }

        pub fn bytes(&mut self, b: &[u8]) {
            self.out.push(0x30);
            self.varint(b.len());
            self.out.extend_from_slice(b);
        }

        fn value(&mut self, v: &V<'_>) {
            match v {
                V::Str(s) => self.str(s),
                V::Arr(items) => {
                    self.out.push(0x20);
                    self.varint(items.len());
                    for i in items {
                        self.value(i);
                    }
                }
            }
        }

        pub fn object(&mut self, fields: &[(&str, V<'_>)]) {
            self.out.push(0x21);
            self.varint(fields.len());
            for (k, v) in fields {
                match self.keys.iter().position(|x| x == k) {
                    Some(i) => self.varint(i + 1),
                    None => {
                        self.varint(0);
                        self.keys.push((*k).to_string());
                        self.str(k);
                    }
                }
                self.value(v);
            }
        }

        pub fn finish(self) -> Vec<u8> {
            self.out
        }
    }
}
