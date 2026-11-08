//! `/etc/gondolin`: a small in-memory tree served to the daemon as an object
//! mount (`vfs_call`), like the node CLI's `MemoryProvider` behind
//! `createGondolinEtcMount`. It holds the ingress `listeners` file; changes
//! to it are announced on a watch channel.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use gondolin_proto::vfs::{EntryKind, ObjectDirEntry, ObjectStat, VfsCall, VfsCallResult, VfsOp};
use gondolin_wire::Value;
use tokio::sync::watch;

#[derive(Debug, Clone)]
enum Entry {
    File { data: Vec<u8>, mode: u32, mtime_ms: i64 },
    Dir { mode: u32, mtime_ms: i64 },
}

/// The tree (paths relative to the mount, `/` = the mount root).
pub struct EtcStore {
    entries: Mutex<BTreeMap<String, Entry>>,
    /// pending chunked `write_file` contents
    staged: Mutex<BTreeMap<String, Vec<u8>>>,
    listeners_changed: watch::Sender<u64>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn parent(p: &str) -> String {
    match p.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => p[..i].to_string(),
    }
}

fn norm(p: &str) -> String {
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    format!("/{}", parts.join("/"))
}

type R = Result<VfsCallResult, &'static str>;

fn ok() -> VfsCallResult {
    VfsCallResult { ok: true, ..Default::default() }
}

impl EtcStore {
    /// A tree with an empty (canonical) `listeners` file.
    pub fn new() -> EtcStore {
        let mut entries = BTreeMap::new();
        entries.insert("/".into(), Entry::Dir { mode: 0o755, mtime_ms: now_ms() });
        entries.insert(
            "/listeners".into(),
            Entry::File { data: b"\n".to_vec(), mode: 0o644, mtime_ms: now_ms() },
        );
        EtcStore {
            entries: Mutex::new(entries),
            staged: Mutex::new(BTreeMap::new()),
            listeners_changed: watch::channel(0).0,
        }
    }

    /// Notified whenever `/listeners` may have changed.
    pub fn listeners_changed(&self) -> watch::Receiver<u64> {
        self.listeners_changed.subscribe()
    }

    /// Current contents of a file.
    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        match self.entries.lock().unwrap().get(&norm(path)) {
            Some(Entry::File { data, .. }) => Some(data.clone()),
            _ => None,
        }
    }

    /// Replaces a file (host side).
    pub fn write(&self, path: &str, data: Vec<u8>) {
        self.entries
            .lock()
            .unwrap()
            .insert(norm(path), Entry::File { data, mode: 0o644, mtime_ms: now_ms() });
    }

    /// Serves one `vfs_call` payload; answers the `vfs_call_result` payload.
    pub fn handle(&self, payload: &Value) -> Value {
        let result = match gondolin_wire::from_value::<VfsCall>(payload.clone()) {
            Ok(call) => {
                let touched = touched_paths(&call.op);
                let r = self.op(call.op);
                if r.as_ref().is_ok_and(|r| r.ok) && touched.iter().any(|p| p == "/listeners") {
                    self.listeners_changed.send_modify(|n| *n += 1);
                }
                r.unwrap_or_else(|code| VfsCallResult {
                    ok: false,
                    code: Some(code.into()),
                    message: Some(code.into()),
                    ..Default::default()
                })
            }
            Err(err) => VfsCallResult {
                ok: false,
                code: Some("EINVAL".into()),
                message: Some(err.to_string()),
                ..Default::default()
            },
        };
        gondolin_wire::to_value(&result).unwrap_or(Value::Null)
    }

    fn op(&self, op: VfsOp) -> R {
        let mut entries = self.entries.lock().unwrap();
        let dir_exists = |entries: &BTreeMap<String, Entry>, p: &str| {
            matches!(entries.get(p), Some(Entry::Dir { .. }))
        };
        match op {
            VfsOp::Stat { path, .. } => {
                let p = norm(&path);
                let stat = match entries.get(&p).ok_or("ENOENT")? {
                    Entry::File { data, mode, mtime_ms } => ObjectStat {
                        kind: EntryKind::File,
                        size: data.len() as u64,
                        mode: Some(*mode),
                        mtime_ms: Some(*mtime_ms),
                        ctime_ms: Some(*mtime_ms),
                        atime_ms: None,
                        nlink: Some(1),
                        uid: None,
                        gid: None,
                    },
                    Entry::Dir { mode, mtime_ms } => ObjectStat {
                        kind: EntryKind::Dir,
                        size: 0,
                        mode: Some(*mode),
                        mtime_ms: Some(*mtime_ms),
                        ctime_ms: Some(*mtime_ms),
                        atime_ms: None,
                        nlink: Some(2),
                        uid: None,
                        gid: None,
                    },
                };
                Ok(VfsCallResult { stat: Some(stat), ..ok() })
            }
            VfsOp::Readdir { path } => {
                let p = norm(&path);
                if !dir_exists(&entries, &p) {
                    return Err(if entries.contains_key(&p) { "ENOTDIR" } else { "ENOENT" });
                }
                let list = entries
                    .iter()
                    .filter(|(k, _)| *k != "/" && parent(k) == p)
                    .map(|(k, e)| ObjectDirEntry {
                        name: k.rsplit('/').next().unwrap_or("").to_string(),
                        kind: match e {
                            Entry::File { .. } => EntryKind::File,
                            Entry::Dir { .. } => EntryKind::Dir,
                        },
                    })
                    .collect();
                Ok(VfsCallResult { entries: Some(list), ..ok() })
            }
            VfsOp::ReadFile { path, offset, length } => {
                let Some(Entry::File { data, .. }) = entries.get(&norm(&path)) else {
                    return Err("ENOENT");
                };
                let start = (offset as usize).min(data.len());
                let end = match length {
                    Some(l) => (start + l as usize).min(data.len()),
                    None => data.len(),
                };
                Ok(VfsCallResult { data: Some(data[start..end].to_vec()), ..ok() })
            }
            VfsOp::WriteFile { path, data, offset, last, mode } => {
                let p = norm(&path);
                if !dir_exists(&entries, &parent(&p)) {
                    return Err("ENOENT");
                }
                if dir_exists(&entries, &p) {
                    return Err("EISDIR");
                }
                let mut staged = self.staged.lock().unwrap();
                let buf = staged.entry(p.clone()).or_default();
                if offset == 0 {
                    buf.clear();
                }
                buf.extend_from_slice(&data);
                if last {
                    let data = staged.remove(&p).unwrap_or_default();
                    let mode = mode.or(match entries.get(&p) {
                        Some(Entry::File { mode, .. }) => Some(*mode),
                        _ => None,
                    });
                    entries.insert(
                        p,
                        Entry::File { data, mode: mode.unwrap_or(0o644), mtime_ms: now_ms() },
                    );
                }
                Ok(ok())
            }
            VfsOp::Write { path, offset, data } => {
                let Some(Entry::File { data: file, mtime_ms, .. }) = entries.get_mut(&norm(&path))
                else {
                    return Err("ENOENT");
                };
                let end = offset as usize + data.len();
                if file.len() < end {
                    file.resize(end, 0);
                }
                file[offset as usize..end].copy_from_slice(&data);
                *mtime_ms = now_ms();
                Ok(ok())
            }
            VfsOp::Truncate { path, size } => {
                let Some(Entry::File { data, mtime_ms, .. }) = entries.get_mut(&norm(&path)) else {
                    return Err("ENOENT");
                };
                data.resize(size as usize, 0);
                *mtime_ms = now_ms();
                Ok(ok())
            }
            VfsOp::Unlink { path } => match entries.get(&norm(&path)) {
                Some(Entry::File { .. }) => {
                    entries.remove(&norm(&path));
                    Ok(ok())
                }
                Some(Entry::Dir { .. }) => Err("EISDIR"),
                None => Err("ENOENT"),
            },
            VfsOp::Rename { from, to } => {
                let (from, to) = (norm(&from), norm(&to));
                if from == "/" || to == "/" || to.starts_with(&format!("{from}/")) {
                    return Err("EINVAL");
                }
                if !entries.contains_key(&from) {
                    return Err("ENOENT");
                }
                if !dir_exists(&entries, &parent(&to)) {
                    return Err("ENOENT");
                }
                let moved: Vec<(String, Entry)> = entries
                    .iter()
                    .filter(|(k, _)| **k == from || k.starts_with(&format!("{from}/")))
                    .map(|(k, e)| (k.clone(), e.clone()))
                    .collect();
                if let Some(Entry::Dir { .. }) = entries.get(&to)
                    && entries.keys().any(|k| k.starts_with(&format!("{to}/")))
                {
                    return Err("ENOTEMPTY");
                }
                for (k, _) in &moved {
                    entries.remove(k);
                }
                for (k, e) in moved {
                    entries.insert(format!("{to}{}", &k[from.len()..]), e);
                }
                Ok(ok())
            }
            VfsOp::Mkdir { path, mode } => {
                let p = norm(&path);
                if entries.contains_key(&p) {
                    return Err("EEXIST");
                }
                if !dir_exists(&entries, &parent(&p)) {
                    return Err("ENOENT");
                }
                entries.insert(p, Entry::Dir { mode: mode.unwrap_or(0o755), mtime_ms: now_ms() });
                Ok(ok())
            }
            VfsOp::Rmdir { path } => {
                let p = norm(&path);
                if p == "/" {
                    return Err("EBUSY");
                }
                match entries.get(&p) {
                    Some(Entry::Dir { .. }) => {}
                    Some(_) => return Err("ENOTDIR"),
                    None => return Err("ENOENT"),
                }
                if entries.keys().any(|k| k.starts_with(&format!("{p}/"))) {
                    return Err("ENOTEMPTY");
                }
                entries.remove(&p);
                Ok(ok())
            }
            VfsOp::Chmod { path, mode: new_mode } => {
                match entries.get_mut(&norm(&path)).ok_or("ENOENT")? {
                    Entry::File { mode, .. } | Entry::Dir { mode, .. } => *mode = new_mode & 0o7777,
                }
                Ok(ok())
            }
            VfsOp::Symlink { .. } | VfsOp::Link { .. } => Err("EPERM"),
            VfsOp::Readlink { path } => {
                if entries.contains_key(&norm(&path)) {
                    Err("EINVAL")
                } else {
                    Err("ENOENT")
                }
            }
        }
    }
}

impl Default for EtcStore {
    fn default() -> Self {
        Self::new()
    }
}

fn touched_paths(op: &VfsOp) -> Vec<String> {
    match op {
        VfsOp::WriteFile { path, last: true, .. }
        | VfsOp::Write { path, .. }
        | VfsOp::Truncate { path, .. }
        | VfsOp::Unlink { path } => vec![norm(path)],
        VfsOp::Rename { from, to } => vec![norm(from), norm(to)],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(store: &EtcStore, op: VfsOp) -> VfsCallResult {
        let v = store.handle(&gondolin_wire::to_value(&VfsCall { mount_id: 1, op }).unwrap());
        gondolin_wire::from_value(v).unwrap()
    }

    #[test]
    fn files_and_notifications() {
        let store = EtcStore::new();
        let rx = store.listeners_changed();
        assert_eq!(store.read("/listeners").unwrap(), b"\n");
        let r = call(
            &store,
            VfsOp::WriteFile {
                path: "/listeners".into(),
                data: b"/ :80\n".to_vec(),
                offset: 0,
                last: true,
                mode: None,
            },
        );
        assert!(r.ok);
        assert!(rx.has_changed().unwrap());
        assert_eq!(store.read("/listeners").unwrap(), b"/ :80\n");
        let r = call(&store, VfsOp::Readdir { path: "/".into() });
        assert_eq!(r.entries.unwrap()[0].name, "listeners");
        assert!(call(&store, VfsOp::Mkdir { path: "/d".into(), mode: None }).ok);
        let r = call(&store, VfsOp::Rmdir { path: "/missing".into() });
        assert_eq!(r.code.as_deref(), Some("ENOENT"));
        assert!(
            call(
                &store,
                VfsOp::Write { path: "/listeners".into(), offset: 7, data: b"x".to_vec() }
            )
            .ok
        );
        assert_eq!(store.read("/listeners").unwrap(), b"/ :80\n\0x");
    }
}
