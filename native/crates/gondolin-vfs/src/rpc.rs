//! Host side of the sandboxfs RPC (`guest/ARCHITECTURE.md` §6): the wire
//! format of the node engine's `FsRpcService` over [`FsCore`].
//!
//! Requests are processed strictly one after another (sandboxfs has one
//! request in flight; a guest pipelining requests gets them answered in
//! order).

use std::sync::Arc;
use std::time::Instant;

use gondolin_wire::cbor;
use gondolin_wire::value::Value;
use gondolin_wire::{FrameReader, FrameWriter, WireError};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::core::{EntryOut, FsCore};
pub use crate::core::{Listing, Metrics, ReaddirCache};
use crate::error::{VfsError, VfsResult, errno};
use crate::types::{Attr, StatFs};

pub const DEFAULT_ENTRY_TTL_MS: u64 = 1000;
pub const DEFAULT_ATTR_TTL_MS: u64 = 1000;
pub const DEFAULT_NEGATIVE_TTL_MS: u64 = 250;
/// Largest `read`/`write` payload in `bytes`; advertised to sandboxfs as
/// `max_data` in the `mounts` reply (guests that don't read it stay at 60 KiB).
pub const MAX_RPC_DATA: usize = 1024 * 1024;

/// Fields of an `fs_response` payload.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcReply {
    /// Linux errno (0 = success)
    pub err: i32,
    pub res: Option<Value>,
    pub message: Option<String>,
}

/// Answer of the guest's `mounts` request.
#[derive(Debug, Clone)]
pub struct MountsInfo {
    pub mount: String,
    pub binds: Vec<String>,
}

/// The sandboxfs RPC of one guest over the shared [`FsCore`].
pub struct RpcSession {
    core: Arc<FsCore>,
    mounts: Option<MountsInfo>,
    /// serializes requests
    order: tokio::sync::Mutex<()>,
}

// ---- CBOR helpers ----

fn text(s: &str) -> Value {
    Value::Text(s.to_string())
}

fn int(v: u64) -> Value {
    Value::Integer(v as i128)
}

fn sint(v: i64) -> Value {
    Value::Integer(v as i128)
}

fn map(pairs: Vec<(&str, Value)>) -> Value {
    Value::Map(pairs.into_iter().map(|(k, v)| (text(k), v)).collect())
}

fn get<'a>(m: &'a Value, key: &str) -> Option<&'a Value> {
    match m {
        Value::Map(pairs) => pairs.iter().find(|(k, _)| k.as_text() == Some(key)).map(|(_, v)| v),
        _ => None,
    }
}

fn einval(op: &str, field: &str) -> VfsError {
    VfsError::op(errno::EINVAL, op, field)
}

fn uint(req: &Value, key: &str, op: &str, default: Option<u64>) -> VfsResult<u64> {
    match get(req, key) {
        None | Some(Value::Null) => default.ok_or_else(|| einval(op, key)),
        Some(Value::Integer(i)) => u64::try_from(*i).map_err(|_| einval(op, key)),
        Some(_) => Err(einval(op, key)),
    }
}

fn string(req: &Value, key: &str, op: &str) -> VfsResult<String> {
    match get(req, key) {
        Some(Value::Text(s)) => Ok(s.clone()),
        _ => Err(einval(op, key)),
    }
}

fn bytes<'a>(req: &'a Value, key: &str, op: &str) -> VfsResult<&'a [u8]> {
    match get(req, key) {
        Some(Value::Bytes(b)) => Ok(b),
        _ => Err(einval(op, key)),
    }
}

fn attr_value(ino: u64, a: &Attr) -> Value {
    map(vec![
        ("ino", int(ino)),
        ("mode", int(a.mode as u64)),
        ("nlink", int(a.nlink as u64)),
        ("uid", int(a.uid as u64)),
        ("gid", int(a.gid as u64)),
        ("size", int(a.size)),
        ("atime_ms", sint(a.atime_ms)),
        ("mtime_ms", sint(a.mtime_ms)),
        ("ctime_ms", sint(a.ctime_ms)),
    ])
}

fn entry_value(ino: u64, a: &Attr) -> Value {
    map(vec![
        ("ino", int(ino)),
        ("attr", attr_value(ino, a)),
        ("attr_ttl_ms", int(DEFAULT_ATTR_TTL_MS)),
        ("entry_ttl_ms", int(DEFAULT_ENTRY_TTL_MS)),
    ])
}

/// `readdirplus`: readdir with each entry's lookup (sandboxfs READDIRPLUS).
/// Every entry with an `entry` is a lookup reference the kernel returns with
/// FORGET, so only entries that fit the guest's reply (`max_bytes`) are
/// returned at all.
async fn readdirplus(core: &FsCore, ino: u64, offset: u64, max_bytes: usize) -> VfsResult<Value> {
    let max = (max_bytes / direntplus_size(0)).clamp(1, 4096);
    let page = core.readdir(ino, offset, max).await?;
    let mut used = 0;
    let mut entries = Vec::new();
    for e in page.entries.iter() {
        let size = direntplus_size(e.name.len());
        if used + size > max_bytes {
            break;
        }
        used += size;
        let mut fields = vec![
            ("ino", int(e.ino)),
            ("name", text(&e.name)),
            ("type", int(e.kind as u64)),
            ("offset", int(e.offset)),
        ];
        // gone since the listing: a plain entry (the kernel skips it)
        if let Ok(entry) = core.lookup(ino, &e.name).await {
            fields.push(("entry", entry_value(entry.ino, &entry.attr)));
        }
        entries.push(map(fields));
    }
    Ok(map(vec![("entries", Value::Array(entries)), ("entry_ttl_ms", int(DEFAULT_ENTRY_TTL_MS))]))
}

/// Size of a FUSE `fuse_direntplus` record for a `name_len`-byte name in
/// `bytes`: `fuse_entry_out` (128) and `fuse_dirent` (24) plus the name,
/// padded to 8.
pub fn direntplus_size(name_len: usize) -> usize {
    (128 + 24 + name_len).next_multiple_of(8)
}

/// FUSE `FOPEN_NOFLUSH`: the kernel sends no FLUSH when a descriptor of the
/// handle is closed (Linux 5.19+; older kernels send it and get an answer).
const FOPEN_NOFLUSH: u64 = 1 << 5;

/// `open_flags` of a new handle: FOPEN_NOFLUSH unless its flush commits
/// something (sandboxfs then forwards FLUSH, see `flush`).
fn open_flags(core: &FsCore, fh: u64) -> u64 {
    match core.file_handle(fh) {
        Ok(handle) if handle.wants_flush() => 0,
        _ => FOPEN_NOFLUSH,
    }
}

fn statfs_value(s: StatFs) -> Value {
    map(vec![
        ("blocks", int(s.blocks)),
        ("bfree", int(s.bfree)),
        ("bavail", int(s.bavail)),
        ("files", int(s.files)),
        ("ffree", int(s.ffree)),
        ("bsize", int(s.bsize)),
        ("frsize", int(s.frsize)),
        ("namelen", int(s.namelen)),
    ])
}

fn entry_res(e: &EntryOut) -> Value {
    map(vec![("entry", entry_value(e.ino, &e.attr))])
}

impl RpcSession {
    pub fn new(core: Arc<FsCore>, mounts: Option<MountsInfo>) -> RpcSession {
        RpcSession { core, mounts, order: tokio::sync::Mutex::new(()) }
    }

    pub fn core(&self) -> &Arc<FsCore> {
        &self.core
    }

    /// Serves `fs_request` frames on `stream` until EOF.
    pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(
        &self,
        stream: S,
    ) -> Result<(), WireError> {
        let (r, w) = tokio::io::split(stream);
        let mut reader = FrameReader::new(r);
        let mut writer = FrameWriter::new(w);
        while let Some(frame) = reader.read_frame().await? {
            // §3.3 guest rules: i64 integers, no floats
            let Ok(value) = gondolin_wire::decode_guest::<Value>(&frame) else {
                gondolin_log::debug!("vfs: undecodable frame ({} bytes)", frame.len());
                continue;
            };
            if let Some(response) = self.handle_message(&value).await {
                writer.write_frame(&cbor::encode(&response)).await?;
                writer.flush().await?;
            }
        }
        Ok(())
    }

    /// Handles one decoded message; `None` for anything that is not a valid
    /// `fs_request` (ignored like the node engine does).
    pub async fn handle_message(&self, msg: &Value) -> Option<Value> {
        if get(msg, "t").and_then(Value::as_text) != Some("fs_request") {
            return None;
        }
        let id = match get(msg, "id") {
            Some(Value::Integer(i)) => u32::try_from(*i).ok()?,
            _ => return None,
        };
        let p = get(msg, "p")?;
        let op = get(p, "op").and_then(Value::as_text).unwrap_or("").to_string();
        let empty = Value::Map(Vec::new());
        let req = get(p, "req").unwrap_or(&empty);
        let reply = self.reply(&op, req).await;
        let mut payload = vec![("op", text(&op)), ("err", int(reply.err as u64))];
        if let Some(res) = reply.res {
            payload.push(("res", res));
        }
        if let Some(message) = reply.message {
            payload.push(("message", text(&message)));
        }
        Some(map(vec![
            ("v", int(1)),
            ("t", text("fs_response")),
            ("id", int(id as u64)),
            ("p", map(payload)),
        ]))
    }

    /// Runs one operation and builds the `fs_response` fields (negative
    /// lookups carry a short `entry_ttl_ms`).
    pub async fn reply(&self, op: &str, req: &Value) -> RpcReply {
        match self.handle(op, req).await {
            Ok(res) => RpcReply { err: 0, res: Some(res), message: None },
            Err(e) => RpcReply {
                err: e.errno,
                res: (op == "lookup" && e.is(errno::ENOENT))
                    .then(|| map(vec![("entry_ttl_ms", int(DEFAULT_NEGATIVE_TTL_MS))])),
                message: Some(e.message),
            },
        }
    }

    /// Runs one operation; returns the `res` map or an error.
    pub async fn handle(&self, op: &str, req: &Value) -> VfsResult<Value> {
        let _order = self.order.lock().await;
        let start = Instant::now();
        let result = self.dispatch(op, req).await;
        self.core.record(op, result.is_ok());
        if let Err(e) = &result {
            gondolin_log::debug!(
                "vfs op {op} failed: errno {} ({} µs)",
                e.errno,
                start.elapsed().as_micros()
            );
        } else {
            gondolin_log::trace!("vfs op {op} ({} µs)", start.elapsed().as_micros());
        }
        result
    }

    async fn dispatch(&self, op: &str, req: &Value) -> VfsResult<Value> {
        let core = &self.core;
        let u = |key: &str| uint(req, key, op, None);
        let ud = |key: &str, d: u64| uint(req, key, op, Some(d));
        let s = |key: &str| string(req, key, op);
        Ok(match op {
            "lookup" => entry_res(&core.lookup(u("parent_ino")?, &s("name")?).await?),
            "getattr" => {
                let ino = u("ino")?;
                let attr = core.getattr(ino).await?;
                map(vec![
                    ("attr", attr_value(ino, &attr)),
                    ("attr_ttl_ms", int(DEFAULT_ATTR_TTL_MS)),
                ])
            }
            "readlink" => map(vec![("target", text(&core.readlink(u("ino")?).await?))]),
            "readdir" => {
                let ino = u("ino")?;
                let offset = ud("offset", 0)?;
                let max = ud("max_entries", 1024)?.clamp(1, 4096) as usize;
                let page = core.readdir(ino, offset, max).await?;
                let entries = page
                    .entries
                    .iter()
                    .map(|e| {
                        map(vec![
                            ("ino", int(e.ino)),
                            ("name", text(&e.name)),
                            ("type", int(e.kind as u64)),
                            ("offset", int(e.offset)),
                        ])
                    })
                    .collect();
                map(vec![
                    ("entries", Value::Array(entries)),
                    ("next_offset", int(page.next_offset)),
                    ("entry_ttl_ms", int(DEFAULT_ENTRY_TTL_MS)),
                ])
            }
            "readdirplus" => {
                let ino = u("ino")?;
                let offset = ud("offset", 0)?;
                let max_bytes = ud("max_bytes", 4096)?.clamp(256, 1 << 20) as usize;
                // one blocking task for the listing and every entry's lstat,
                // made inline, instead of a blocking-pool hop per entry
                let core = core.clone();
                let rt = tokio::runtime::Handle::current();
                tokio::task::spawn_blocking(move || {
                    crate::host::with_inline_blocking(|| {
                        rt.block_on(readdirplus(&core, ino, offset, max_bytes))
                    })
                })
                .await
                .map_err(|e| VfsError::new(errno::EIO, format!("readdirplus task failed: {e}")))??
            }
            "open" => {
                let fh = core.open(u("ino")?, u("flags")?).await?;
                map(vec![("fh", int(fh)), ("open_flags", int(open_flags(core, fh)))])
            }
            "read" => {
                let size = ud("size", 0)? as usize;
                if size > MAX_RPC_DATA {
                    return Err(VfsError::op(errno::EINVAL, "read", ""));
                }
                let data = core.read(u("fh")?, ud("offset", 0)?, size).await?;
                map(vec![("data", Value::Bytes(data))])
            }
            "write" => {
                let fh = u("fh")?;
                let offset = ud("offset", 0)?;
                let data = bytes(req, "data", op)?;
                if data.len() > MAX_RPC_DATA {
                    return Err(VfsError::op(errno::EINVAL, "write", ""));
                }
                let n = core.write(fh, offset, data).await?;
                map(vec![("size", int(n as u64))])
            }
            "create" => {
                let parent = u("parent_ino")?;
                let name = s("name")?;
                let mode = ud("mode", 0o644)?;
                let flags = ud("flags", 0)?;
                let (e, fh) = core.create(parent, &name, (mode & 0o7777) as u32, flags).await?;
                map(vec![
                    ("entry", entry_value(e.ino, &e.attr)),
                    ("fh", int(fh)),
                    ("open_flags", int(open_flags(core, fh))),
                ])
            }
            "mkdir" => {
                let parent = u("parent_ino")?;
                let name = s("name")?;
                let mode = ud("mode", 0o755)?;
                entry_res(&core.mkdir(parent, &name, (mode & 0o7777) as u32).await?)
            }
            "symlink" => {
                let parent = u("parent_ino")?;
                let name = s("name")?;
                let target = s("target")?;
                entry_res(&core.symlink(parent, &name, &target).await?)
            }
            "unlink" | "rmdir" => {
                core.unlink(u("parent_ino")?, &s("name")?, op == "rmdir").await?;
                map(vec![])
            }
            "rename" => {
                core.rename(
                    u("old_parent_ino")?,
                    &s("old_name")?,
                    u("new_parent_ino")?,
                    &s("new_name")?,
                    ud("flags", 0)?,
                )
                .await?;
                map(vec![])
            }
            "link" => {
                let old = u("old_ino")?;
                let parent = u("new_parent_ino")?;
                let name = s("new_name")?;
                entry_res(&core.link(old, parent, &name).await?)
            }
            "access" => {
                core.access(u("ino")?, ud("mask", 0)?, ud("uid", 0)?, ud("gid", 0)?).await?;
                map(vec![])
            }
            "truncate" => {
                core.truncate(u("ino")?, None, ud("size", 0)?).await?;
                map(vec![])
            }
            "chmod" => {
                core.chmod(u("ino")?, (u("mode")? & 0o7777) as u32).await?;
                map(vec![])
            }
            "fallocate" => {
                core.fallocate(u("fh")?, ud("offset", 0)?, ud("length", 0)?, ud("mode", 0)?)
                    .await?;
                map(vec![])
            }
            "copy_file_range" => {
                let size = core
                    .copy_file_range(
                        u("fh_in")?,
                        ud("off_in", 0)?,
                        u("fh_out")?,
                        ud("off_out", 0)?,
                        ud("len", 0)?,
                        ud("flags", 0)?,
                        MAX_RPC_DATA,
                    )
                    .await?;
                map(vec![("size", int(size))])
            }
            "release" => {
                core.release(u("fh")?).await?;
                map(vec![])
            }
            // `close()` of a descriptor: buffering providers commit here and
            // the error reaches the guest program (only for handles opened
            // without FOPEN_NOFLUSH)
            "flush" => {
                core.flush(u("fh")?).await?;
                map(vec![])
            }
            "fsync" => {
                core.fsync(u("fh")?).await?;
                map(vec![])
            }
            "statfs" => map(vec![("statfs", statfs_value(core.statfs(u("ino")?).await?))]),
            "mounts" => self.mounts()?,
            _ => return Err(VfsError::op(errno::ENOSYS, op, "")),
        })
    }

    fn mounts(&self) -> VfsResult<Value> {
        match &self.mounts {
            Some(m) => Ok(map(vec![
                ("mount", text(&m.mount)),
                ("binds", Value::Array(m.binds.iter().map(|b| text(b)).collect())),
            ])),
            None => Err(VfsError::new(errno::EAGAIN, "boot configuration unavailable")),
        }
    }

    /// Closes every open handle (`FsRpcService.close`).
    pub async fn close(&self) {
        self.core.close().await;
    }

    /// Number of open guest handles.
    pub fn open_handles(&self) -> usize {
        self.core.open_handles()
    }
}
