use super::*;
use crate::BoxFuture;
use crate::call_result;
use gondolin_proto::vfs::{ObjectCacheConfig, VfsCallResult};
use std::collections::BTreeMap as Map;

#[derive(Clone)]
enum FakeEntry {
    File(Vec<u8>, u32),
    Dir,
}

/// In-memory controller provider recording every call.
#[derive(Default)]
pub struct FakeBackend {
    entries: Mutex<Map<String, FakeEntry>>,
    pub calls: Mutex<Vec<VfsOp>>,
    /// pending `write_file` chunks per path
    pending: Mutex<HashMap<String, Vec<u8>>>,
    /// paths whose `write_file` fails with `EIO`
    pub fail_writes: Mutex<BTreeSet<String>>,
}

impl FakeBackend {
    pub fn new() -> Arc<FakeBackend> {
        let b = FakeBackend::default();
        b.entries.lock().unwrap().insert("/".into(), FakeEntry::Dir);
        Arc::new(b)
    }

    pub fn put(&self, path: &str, data: &[u8]) {
        self.entries.lock().unwrap().insert(path.into(), FakeEntry::File(data.to_vec(), 0o644));
    }

    pub fn mkdir(&self, path: &str) {
        self.entries.lock().unwrap().insert(path.into(), FakeEntry::Dir);
    }

    pub fn get(&self, path: &str) -> Option<Vec<u8>> {
        match self.entries.lock().unwrap().get(path) {
            Some(FakeEntry::File(d, _)) => Some(d.clone()),
            _ => None,
        }
    }

    pub fn count(&self, f: impl Fn(&VfsOp) -> bool) -> usize {
        self.calls.lock().unwrap().iter().filter(|c| f(c)).count()
    }

    fn err(code: &str) -> VfsCallResult {
        VfsCallResult {
            ok: false,
            code: Some(code.into()),
            message: Some(code.into()),
            ..Default::default()
        }
    }

    fn ok() -> VfsCallResult {
        VfsCallResult { ok: true, ..Default::default() }
    }

    fn handle(&self, op: &VfsOp) -> VfsCallResult {
        let mut entries = self.entries.lock().unwrap();
        match op {
            VfsOp::Stat { path, inline_max } => match entries.get(path) {
                Some(FakeEntry::File(d, mode)) => VfsCallResult {
                    data: inline_max.filter(|max| d.len() as u64 <= *max).map(|_| d.clone()),
                    stat: Some(ObjectStat {
                        kind: EntryKind::File,
                        size: d.len() as u64,
                        mode: Some(*mode),
                        mtime_ms: Some(1000),
                        ctime_ms: None,
                        atime_ms: None,
                        nlink: None,
                        uid: None,
                        gid: None,
                    }),
                    ..Self::ok()
                },
                Some(FakeEntry::Dir) => VfsCallResult {
                    stat: Some(ObjectStat {
                        kind: EntryKind::Dir,
                        size: 0,
                        mode: None,
                        mtime_ms: None,
                        ctime_ms: None,
                        atime_ms: None,
                        nlink: None,
                        uid: None,
                        gid: None,
                    }),
                    ..Self::ok()
                },
                None => Self::err("ENOENT"),
            },
            VfsOp::Readdir { path } => {
                let prefix = if path == "/" { "/".to_string() } else { format!("{path}/") };
                let list = entries
                    .iter()
                    .filter(|(k, _)| {
                        k.starts_with(&prefix)
                            && k.len() > prefix.len()
                            && !k[prefix.len()..].contains('/')
                    })
                    .map(|(k, v)| ObjectDirEntry {
                        name: k[prefix.len()..].to_string(),
                        kind: if matches!(v, FakeEntry::Dir) {
                            EntryKind::Dir
                        } else {
                            EntryKind::File
                        },
                    })
                    .collect();
                VfsCallResult { entries: Some(list), ..Self::ok() }
            }
            VfsOp::ReadFile { path, offset, length } => match entries.get(path) {
                Some(FakeEntry::File(d, _)) => {
                    let start = (*offset as usize).min(d.len());
                    let end = length.map(|l| (start + l as usize).min(d.len())).unwrap_or(d.len());
                    VfsCallResult { data: Some(d[start..end].to_vec()), ..Self::ok() }
                }
                Some(FakeEntry::Dir) => Self::err("EISDIR"),
                None => Self::err("ENOENT"),
            },
            VfsOp::WriteFile { path, data, offset, last, mode } => {
                if self.fail_writes.lock().unwrap().contains(path) {
                    return Self::err("EIO");
                }
                let mut pending = self.pending.lock().unwrap();
                let buf = pending.entry(path.clone()).or_default();
                if *offset == 0 {
                    buf.clear();
                }
                assert_eq!(buf.len() as u64, *offset, "write_file chunks must be consecutive");
                buf.extend_from_slice(data);
                if *last {
                    let data = pending.remove(path).unwrap();
                    let mode = match entries.get(path) {
                        Some(FakeEntry::File(_, m)) => *m,
                        _ => mode.unwrap_or(0o644),
                    };
                    entries.insert(path.clone(), FakeEntry::File(data, mode));
                }
                Self::ok()
            }
            VfsOp::Write { path, offset, data } => match entries.get_mut(path) {
                Some(FakeEntry::File(d, _)) => {
                    let end = *offset as usize + data.len();
                    if d.len() < end {
                        d.resize(end, 0);
                    }
                    d[*offset as usize..end].copy_from_slice(data);
                    Self::ok()
                }
                _ => Self::err("ENOENT"),
            },
            VfsOp::Truncate { path, size } => match entries.get_mut(path) {
                Some(FakeEntry::File(d, _)) => {
                    d.resize(*size as usize, 0);
                    Self::ok()
                }
                _ => Self::err("ENOENT"),
            },
            VfsOp::Unlink { path } => match entries.get(path) {
                Some(FakeEntry::File(..)) => {
                    entries.remove(path);
                    Self::ok()
                }
                Some(FakeEntry::Dir) => Self::err("EISDIR"),
                None => Self::err("ENOENT"),
            },
            VfsOp::Rename { from, to } => match entries.remove(from) {
                Some(e) => {
                    let moved: Vec<(String, FakeEntry)> = entries
                        .iter()
                        .filter(|(k, _)| k.starts_with(&format!("{from}/")))
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    for (k, v) in moved {
                        entries.remove(&k);
                        entries.insert(format!("{to}{}", &k[from.len()..]), v);
                    }
                    entries.insert(to.clone(), e);
                    Self::ok()
                }
                None => Self::err("ENOENT"),
            },
            VfsOp::Mkdir { path, .. } => {
                if entries.contains_key(path) {
                    return Self::err("EEXIST");
                }
                entries.insert(path.clone(), FakeEntry::Dir);
                Self::ok()
            }
            VfsOp::Rmdir { path } => {
                if entries.keys().any(|k| k.starts_with(&format!("{path}/"))) {
                    return Self::err("ENOTEMPTY");
                }
                entries.remove(path);
                Self::ok()
            }
            VfsOp::Chmod { path, mode } => match entries.get_mut(path) {
                Some(FakeEntry::File(_, m)) => {
                    *m = *mode;
                    Self::ok()
                }
                Some(_) => Self::ok(),
                None => Self::err("ENOENT"),
            },
            _ => Self::err("ENOSYS"),
        }
    }
}

impl ObjectBackend for FakeBackend {
    fn call<'a>(&'a self, call: VfsCall) -> BoxFuture<'a, VfsResult<VfsCallResult>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(call.op.clone());
            call_result(self.handle(&call.op))
        })
    }
}

fn cfg(commit: CommitMode, ttl_ms: u64) -> ObjectMountConfig {
    ObjectMountConfig {
        mount_id: 7,
        writable: true,
        enumeration: Enumeration::List,
        commit,
        cache: ObjectCacheConfig {
            ttl_ms,
            max_bytes: 64 * 1024 * 1024,
            revalidate_open: false,
            inline_max_bytes: 0,
        },
        max_file_bytes: None,
    }
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

fn is_read(op: &VfsOp) -> bool {
    matches!(op, VfsOp::ReadFile { .. })
}

fn is_write_file(op: &VfsOp) -> bool {
    matches!(op, VfsOp::WriteFile { .. })
}

fn is_stat(op: &VfsOp) -> bool {
    matches!(op, VfsOp::Stat { .. })
}

#[test]
fn lazy_chunked_reads() {
    rt().block_on(crate::test_timeout(async {
        let b = FakeBackend::new();
        let data: Vec<u8> = (0..(3 * CHUNK + CHUNK / 2)).map(|i| (i % 251) as u8).collect();
        b.put("/big.bin", &data);
        let p = ObjectProvider::new(cfg(CommitMode::Close, 1000), b.clone());
        let h = p.open("/big.bin", OpenFlags::READ, 0).await.unwrap();
        assert_eq!(h.stat().await.unwrap().size, data.len() as u64);
        let off = 2 * CHUNK + 10;
        assert_eq!(h.read(off, 100).await.unwrap(), &data[off as usize..off as usize + 100]);
        assert_eq!(b.count(is_read), 1);
        // a read spanning two chunks loads the next one only
        let off = 3 * CHUNK - 50;
        assert_eq!(h.read(off, 100).await.unwrap(), &data[off as usize..off as usize + 100]);
        assert_eq!(b.count(is_read), 2);
        let mut all = Vec::new();
        let mut pos = 0u64;
        loop {
            let chunk = h.read(pos, 61440).await.unwrap();
            if chunk.is_empty() {
                break;
            }
            pos += chunk.len() as u64;
            all.extend(chunk);
        }
        assert_eq!(all, data);
        assert_eq!(b.count(is_read), 4);
        h.close().await.unwrap();
        assert_eq!(b.count(is_write_file), 0);
    }));
}

#[test]
fn close_mode_commits_on_release() {
    rt().block_on(crate::test_timeout(async {
        let b = FakeBackend::new();
        let p = ObjectProvider::new(cfg(CommitMode::Close, 1000), b.clone());
        let h = p.open("/new.txt", OpenFlags::parse("w+").unwrap(), 0o600).await.unwrap();
        h.write(0, b"hello ").await.unwrap();
        h.write(6, b"world").await.unwrap();
        assert_eq!(h.read(0, 100).await.unwrap(), b"hello world");
        assert!(b.get("/new.txt").is_none());
        // visible locally before the commit
        let names: Vec<String> =
            p.readdir("/").await.unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["new.txt"]);
        let a = p.lstat("/new.txt").await.unwrap();
        assert_eq!((a.size, a.perm()), (11, 0o600));
        h.close().await.unwrap();
        assert_eq!(b.get("/new.txt").unwrap(), b"hello world");
        assert_eq!(b.count(is_write_file), 1);
        assert!(matches!(
            &b.calls.lock().unwrap().iter().find(|c| is_write_file(c)),
            Some(VfsOp::WriteFile { mode: Some(0o600), last: true, .. })
        ));

        // rewrite part of it: the untouched rest is fetched for the commit
        let h = p.open("/new.txt", OpenFlags::READ_WRITE, 0).await.unwrap();
        h.write(0, b"HELLO").await.unwrap();
        h.close().await.unwrap();
        assert_eq!(b.get("/new.txt").unwrap(), b"HELLO world");

        // a read-only open never commits
        let n = b.count(is_write_file);
        let h = p.open("/new.txt", OpenFlags::READ, 0).await.unwrap();
        h.close().await.unwrap();
        assert_eq!(b.count(is_write_file), n);
    }));
}

#[test]
fn large_commits_are_chunked() {
    rt().block_on(crate::test_timeout(async {
        let b = FakeBackend::new();
        let p = ObjectProvider::new(cfg(CommitMode::Close, 1000), b.clone());
        let data: Vec<u8> = (0..(2 * CHUNK + 123)).map(|i| (i % 13) as u8).collect();
        let h = p.open("/big", OpenFlags::parse("w").unwrap(), 0o644).await.unwrap();
        for (i, piece) in data.chunks(61440).enumerate() {
            h.write(i as u64 * 61440, piece).await.unwrap();
        }
        h.close().await.unwrap();
        assert_eq!(b.count(is_write_file), 3);
        assert_eq!(b.get("/big").unwrap(), data);
    }));
}

#[test]
fn commit_failure_is_reported_and_kept() {
    rt().block_on(crate::test_timeout(async {
        let b = FakeBackend::new();
        let p = ObjectProvider::new(cfg(CommitMode::Close, 1000), b.clone());
        b.fail_writes.lock().unwrap().insert("/f".into());
        let h = p.open("/f", OpenFlags::parse("w").unwrap(), 0o644).await.unwrap();
        h.write(0, b"data").await.unwrap();
        let err = h.close().await.unwrap_err();
        assert!(err.is(errno::EIO));
        // still dirty locally; a later writer retries
        assert_eq!(p.lstat("/f").await.unwrap().size, 4);
        b.fail_writes.lock().unwrap().clear();
        let h = p.open("/f", OpenFlags::READ_WRITE, 0).await.unwrap();
        h.sync().await.unwrap();
        h.close().await.unwrap();
        assert_eq!(b.get("/f").unwrap(), b"data");
    }));
}

#[test]
fn write_mode_forwards_every_write() {
    rt().block_on(crate::test_timeout(async {
        let b = FakeBackend::new();
        b.put("/log", b"0123456789");
        let p = ObjectProvider::new(cfg(CommitMode::Write, 0), b.clone());
        let h = p.open("/log", OpenFlags::READ_WRITE, 0).await.unwrap();
        assert_eq!(h.read(0, 4).await.unwrap(), b"0123");
        h.write(2, b"ab").await.unwrap();
        assert_eq!(b.get("/log").unwrap(), b"01ab456789");
        assert_eq!(h.read(0, 4).await.unwrap(), b"01ab");
        h.truncate(3).await.unwrap();
        assert_eq!(b.get("/log").unwrap(), b"01a");
        h.close().await.unwrap();
        assert_eq!(b.count(is_write_file), 0);
        let a = p.open("/log", OpenFlags::parse("a").unwrap(), 0).await.unwrap();
        a.write(0, b"!").await.unwrap();
        assert_eq!(b.get("/log").unwrap(), b"01a!");
        let c = p.open("/new", OpenFlags::parse("w").unwrap(), 0o644).await.unwrap();
        assert_eq!(b.get("/new").unwrap(), b"");
        c.write(0, b"x").await.unwrap();
        assert_eq!(b.get("/new").unwrap(), b"x");
    }));
}

#[test]
fn stat_cache_ttl_and_invalidation() {
    rt().block_on(crate::test_timeout(async {
        let b = FakeBackend::new();
        b.put("/a", b"1");
        let p = ObjectProvider::new(cfg(CommitMode::Close, 60_000), b.clone());
        p.lstat("/a").await.unwrap();
        p.lstat("/a").await.unwrap();
        assert!(p.lstat("/missing").await.unwrap_err().is(errno::ENOENT));
        assert!(p.lstat("/missing").await.unwrap_err().is(errno::ENOENT));
        assert_eq!(b.count(is_stat), 2);
        b.put("/missing", b"now");
        assert!(p.lstat("/missing").await.is_err());
        p.invalidate_path(Some("/missing"));
        assert_eq!(p.lstat("/missing").await.unwrap().size, 3);

        let h = p.open("/a", OpenFlags::READ, 0).await.unwrap();
        assert_eq!(h.read(0, 10).await.unwrap(), b"1");
        h.close().await.unwrap();
        b.put("/a", b"22");
        // clean cached content within the TTL
        let h = p.open("/a", OpenFlags::READ, 0).await.unwrap();
        assert_eq!(h.read(0, 10).await.unwrap(), b"1");
        h.close().await.unwrap();
        p.invalidate_path(None);
        let h = p.open("/a", OpenFlags::READ, 0).await.unwrap();
        assert_eq!(h.read(0, 10).await.unwrap(), b"22");

        // ttl 0 revalidates every time
        let p0 = ObjectProvider::new(cfg(CommitMode::Close, 0), b.clone());
        let before = b.count(is_stat);
        p0.lstat("/a").await.unwrap();
        p0.lstat("/a").await.unwrap();
        assert_eq!(b.count(is_stat), before + 2);
    }));
}

#[test]
fn readonly_limits_and_enumeration() {
    rt().block_on(crate::test_timeout(async {
        let b = FakeBackend::new();
        b.mkdir("/d");
        b.put("/d/x", b"x");
        b.put("/d/y", b"y");
        let mut c = cfg(CommitMode::Close, 1000);
        c.writable = false;
        let ro = ObjectProvider::new(c, b.clone());
        assert!(ro.open("/d/x", OpenFlags::READ_WRITE, 0).await.err().unwrap().is(errno::EROFS));
        assert!(ro.mkdir("/e", 0o755, false).await.unwrap_err().is(errno::EROFS));
        assert!(ro.unlink("/d/x").await.unwrap_err().is(errno::EROFS));

        let mut c = cfg(CommitMode::Close, 1000);
        c.enumeration = Enumeration::None;
        let none = ObjectProvider::new(c, b.clone());
        assert!(none.readdir("/d").await.unwrap().is_empty());
        assert_eq!(none.lstat("/d/x").await.unwrap().size, 1);

        let mut c = cfg(CommitMode::Close, 1000);
        c.enumeration = Enumeration::Materialized;
        let mat = ObjectProvider::new(c, b.clone());
        assert!(mat.readdir("/").await.unwrap().is_empty());
        mat.lstat("/d/y").await.unwrap();
        let names = |v: Vec<DirEntry>| v.into_iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names(mat.readdir("/").await.unwrap()), vec!["d"]);
        assert_eq!(names(mat.readdir("/d").await.unwrap()), vec!["y"]);

        let mut c = cfg(CommitMode::Close, 1000);
        c.max_file_bytes = Some(4);
        let lim = ObjectProvider::new(c, b.clone());
        let h = lim.open("/d/z", OpenFlags::parse("w").unwrap(), 0o644).await.unwrap();
        h.write(0, b"1234").await.unwrap();
        assert!(h.write(4, b"5").await.unwrap_err().is(errno::EFBIG));
        assert!(h.truncate(5).await.unwrap_err().is(errno::EFBIG));
        h.close().await.unwrap();
        assert_eq!(b.get("/d/z").unwrap(), b"1234");
    }));
}

#[test]
fn unlink_and_rename_of_open_files() {
    rt().block_on(crate::test_timeout(async {
        let b = FakeBackend::new();
        let p = ObjectProvider::new(cfg(CommitMode::Close, 1000), b.clone());
        // created, unlinked while open: never reaches the controller
        let h = p.open("/tmp1", OpenFlags::parse("w").unwrap(), 0o644).await.unwrap();
        h.write(0, b"x").await.unwrap();
        p.unlink("/tmp1").await.unwrap();
        assert!(p.lstat("/tmp1").await.unwrap_err().is(errno::ENOENT));
        h.close().await.unwrap();
        assert!(b.get("/tmp1").is_none());
        assert_eq!(b.count(|c| matches!(c, VfsOp::Unlink { .. })), 0);

        // renamed before the commit: commits to the new path only
        let h = p.open("/a.tmp", OpenFlags::parse("w").unwrap(), 0o644).await.unwrap();
        h.write(0, b"content").await.unwrap();
        p.rename("/a.tmp", "/a").await.unwrap();
        h.close().await.unwrap();
        assert_eq!(b.get("/a").unwrap(), b"content");
        assert!(b.get("/a.tmp").is_none());

        // committed file renamed while a dirty handle is open
        let h = p.open("/a", OpenFlags::READ_WRITE, 0).await.unwrap();
        h.write(0, b"C").await.unwrap();
        p.rename("/a", "/b").await.unwrap();
        h.close().await.unwrap();
        assert_eq!(b.get("/b").unwrap(), b"Content");
        assert!(b.get("/a").is_none());

        // O_TRUNC on open rewrites the file
        let h = p.open("/b", OpenFlags::parse("w").unwrap(), 0).await.unwrap();
        h.close().await.unwrap();
        assert_eq!(b.get("/b").unwrap(), b"");
    }));
}

#[test]
fn revalidate_open_sees_controller_writes() {
    rt().block_on(crate::test_timeout(async {
        let b = FakeBackend::new();
        b.put("/a", b"one");
        let mut c = cfg(CommitMode::Write, 60_000);
        c.cache.revalidate_open = true;
        let p = ObjectProvider::new(c, b.clone());
        let h = p.open("/a", OpenFlags::READ, 0).await.unwrap();
        assert_eq!(h.read(0, 10).await.unwrap(), b"one");
        h.close().await.unwrap();
        let reads = b.count(is_read);
        // unchanged: cached content is reused
        let h = p.open("/a", OpenFlags::READ, 0).await.unwrap();
        assert_eq!(h.read(0, 10).await.unwrap(), b"one");
        h.close().await.unwrap();
        assert_eq!(b.count(is_read), reads);
        // changed size: refetched although the stat ttl did not expire
        b.put("/a", b"three");
        let h = p.open("/a", OpenFlags::READ, 0).await.unwrap();
        assert_eq!(h.read(0, 10).await.unwrap(), b"three");
        // negative lookups expire quickly
        assert!(p.lstat("/b").await.is_err());
        b.put("/b", b"x");
        tokio::time::sleep(NEGATIVE_TTL + Duration::from_millis(20)).await;
        assert_eq!(p.lstat("/b").await.unwrap().size, 1);
    }));
}

#[test]
fn sequential_reads_fetch_ahead_and_small_files_inline() {
    rt().block_on(crate::test_timeout(async {
        let b = FakeBackend::new();
        let data: Vec<u8> = (0..(8 * CHUNK)).map(|i| (i % 253) as u8).collect();
        b.put("/big", &data);
        b.put("/small", b"tiny");
        let mut c = cfg(CommitMode::Close, 1000);
        c.cache.inline_max_bytes = 1024;
        let p = ObjectProvider::new(c, b.clone());
        let h = p.open("/big", OpenFlags::READ, 0).await.unwrap();
        let mut all = Vec::new();
        let mut pos = 0u64;
        loop {
            let chunk = h.read(pos, 131_072).await.unwrap();
            if chunk.is_empty() {
                break;
            }
            pos += chunk.len() as u64;
            all.extend(chunk);
        }
        assert_eq!(all, data);
        // 8 chunks in fewer round trips (1, then runs of up to 3)
        assert!(b.count(is_read) <= 4, "{} reads", b.count(is_read));
        // a small file arrives with its stat: open + read need no read_file
        let reads = b.count(is_read);
        assert_eq!(p.lstat("/small").await.unwrap().size, 4);
        let h = p.open("/small", OpenFlags::READ, 0).await.unwrap();
        assert_eq!(h.read(0, 100).await.unwrap(), b"tiny");
        assert_eq!(b.count(is_read), reads);
    }));
}
