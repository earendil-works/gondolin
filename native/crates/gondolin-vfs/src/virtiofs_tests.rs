//! The mount table over FUSE (virtio-fs) without a VM: requests go through
//! `gondolin-virtiofs`'s `FuseServer` into [`VirtioFs`].

use std::sync::Arc;

use gondolin_proto::vfs::{
    CommitMode, Enumeration, MountConfig, MountSource, ObjectCacheConfig, ObjectMountConfig,
    VfsConfig, VfsHookConfig,
};
use gondolin_virtiofs::fuse::{CachePolicy, FuseServer};
use gondolin_virtiofs::vhost_user::QueueHandler;
use gondolin_virtiofs::virtq::Writer;

use crate::object::tests::FakeBackend;
use crate::virtiofs::VirtioFs;
use crate::{EventSink, VfsService};

const LOOKUP: u32 = 1;
const FORGET: u32 = 2;
const GETATTR: u32 = 3;
const SETATTR: u32 = 4;
const MKDIR: u32 = 9;
const UNLINK: u32 = 10;
const RMDIR: u32 = 11;
const OPEN: u32 = 14;
const READ: u32 = 15;
const WRITE: u32 = 16;
const RELEASE: u32 = 18;
const FSYNC: u32 = 20;
const FLUSH: u32 = 25;
const INIT: u32 = 26;
const OPENDIR: u32 = 27;
const READDIR: u32 = 28;
const RELEASEDIR: u32 = 29;
const CREATE: u32 = 35;
const READDIRPLUS: u32 = 44;

struct Client {
    server: FuseServer<VirtioFs>,
    unique: u64,
    _rt: tokio::runtime::Runtime,
    _svc: Arc<VfsService>,
}

fn u64_at(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(b[off..off + 8].try_into().unwrap())
}

fn u32_at(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(b[off..off + 4].try_into().unwrap())
}

fn name(n: &str) -> Vec<u8> {
    let mut v = n.as_bytes().to_vec();
    v.push(0);
    v
}

fn le(values: &[u64], widths: &[usize]) -> Vec<u8> {
    let mut out = Vec::new();
    for (v, w) in values.iter().zip(widths) {
        out.extend_from_slice(&v.to_le_bytes()[..*w]);
    }
    out
}

impl Client {
    fn new(cfg: VfsConfig, backend: Arc<FakeBackend>) -> Client {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let svc = Arc::new({
            let _guard = rt.enter();
            VfsService::new(&cfg, backend, EventSink::none()).unwrap()
        });
        let fs = VirtioFs::new(svc.core().clone(), rt.handle().clone());
        let mut server = FuseServer::new(fs, CachePolicy { entry_secs: 1, attr_secs: 1 });
        server.flush = true;
        let mut c = Client { server, unique: 0, _rt: rt, _svc: svc };
        let mut init = Vec::new();
        for v in [7u32, 41, 65536, 0xffff_ffff] {
            init.extend_from_slice(&v.to_le_bytes());
        }
        init.extend_from_slice(&[0u8; 48]);
        assert_eq!(c.call(INIT, 0, &init).0, 0);
        c
    }

    /// One request with the reply split across small buffers; (errno, payload).
    fn call(&mut self, opcode: u32, nodeid: u64, body: &[u8]) -> (i32, Vec<u8>) {
        self.unique += 1;
        let mut req = Vec::new();
        req.extend_from_slice(&((40 + body.len()) as u32).to_le_bytes());
        req.extend_from_slice(&opcode.to_le_bytes());
        req.extend_from_slice(&self.unique.to_le_bytes());
        req.extend_from_slice(&nodeid.to_le_bytes());
        req.extend_from_slice(&[0u8; 16]);
        req.extend_from_slice(body);
        let mut bufs: Vec<Vec<u8>> = vec![vec![0u8; 20], vec![0u8; 4096], vec![0u8; 2 << 20]];
        let n = {
            let mut w = Writer::new(bufs.iter_mut().map(|b| b.as_mut_slice()).collect());
            self.server.handle(1, &req, &mut w)
        };
        if matches!(opcode, FORGET) {
            return (0, Vec::new());
        }
        let mut out: Vec<u8> = bufs.concat();
        out.truncate(n);
        assert_eq!(u32_at(&out, 0) as usize, n);
        assert_eq!(u64_at(&out, 8), self.unique);
        (i32::from_le_bytes(out[4..8].try_into().unwrap()), out[16..].to_vec())
    }

    fn lookup(&mut self, parent: u64, n: &str) -> (i32, u64) {
        let (err, out) = self.call(LOOKUP, parent, &name(n));
        (err, if err == 0 { u64_at(&out, 0) } else { 0 })
    }

    fn create(&mut self, parent: u64, n: &str) -> (u64, u64) {
        let mut body = le(&[2 /* O_RDWR */, 0o100644, 0o022, 0], &[4, 4, 4, 4]);
        body.extend_from_slice(&name(n));
        let (err, out) = self.call(CREATE, parent, &body);
        assert_eq!(err, 0, "create {n}");
        (u64_at(&out, 0), u64_at(&out, 128))
    }

    fn write(&mut self, node: u64, fh: u64, off: u64, data: &[u8]) -> i32 {
        let mut body = le(&[fh, off, data.len() as u64], &[8, 8, 4]);
        body.extend_from_slice(&[0u8; 20]);
        body.extend_from_slice(data);
        self.call(WRITE, node, &body).0
    }

    fn read(&mut self, node: u64, fh: u64, off: u64, size: u32) -> Vec<u8> {
        let mut body = le(&[fh, off, size as u64], &[8, 8, 4]);
        body.extend_from_slice(&[0u8; 20]);
        let (err, out) = self.call(READ, node, &body);
        assert_eq!(err, 0);
        out
    }

    fn fh_op(&mut self, op: u32, node: u64, fh: u64) -> i32 {
        self.call(op, node, &le(&[fh, 0, 0], &[8, 4, 4])).0
    }

    fn readdir(&mut self, op: u32, node: u64, dfh: u64, off: u64, size: u32) -> Vec<(String, u64)> {
        let mut body = le(&[dfh, off, size as u64], &[8, 8, 4]);
        body.extend_from_slice(&[0u8; 20]);
        let (err, out) = self.call(op, node, &body);
        assert_eq!(err, 0);
        let skip = if op == READDIRPLUS { 128 } else { 0 };
        let mut entries = Vec::new();
        let mut pos = 0;
        while pos < out.len() {
            let rec = &out[pos + skip..];
            let len = u32_at(rec, 16) as usize;
            entries.push((String::from_utf8(rec[24..24 + len].to_vec()).unwrap(), u64_at(rec, 8)));
            pos += skip + (24 + len).div_ceil(8) * 8;
        }
        entries
    }
}

fn cfg(mounts: Vec<MountConfig>) -> VfsConfig {
    VfsConfig {
        fuse_mount: "/data".into(),
        binds: vec![],
        mounts,
        hooks: VfsHookConfig::default(),
        transport: Default::default(),
    }
}

fn mount(path: &str, source: MountSource) -> MountConfig {
    MountConfig { path: path.into(), source, readonly: false, layers: vec![] }
}

#[test]
fn host_files_zero_copy_reads_and_setattr() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("existing"), b"hello").unwrap();
    let root = tmp.path().to_str().unwrap().to_string();
    let mut c = Client::new(cfg(vec![mount("/", MountSource::Host { root })]), FakeBackend::new());
    let (err, node) = c.lookup(1, "existing");
    assert_eq!(err, 0);
    assert_eq!(c.lookup(1, "missing").0, -2);
    assert_eq!(c.lookup(1, "a/b").0, -22);

    let (new, fh) = c.create(1, "new");
    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    assert_eq!(c.write(new, fh, 0, &data), 0);
    // a read scattered over the small reply buffers (zero-copy preadv)
    assert_eq!(c.read(new, fh, 1000, 8192), data[1000..9192]);
    assert_eq!(c.read(new, fh, 299_990, 100), data[299_990..]);
    assert_eq!(c.fh_op(FLUSH, new, fh), 0);
    assert_eq!(c.fh_op(FSYNC, new, fh), 0);
    assert_eq!(c.fh_op(RELEASE, new, fh), 0);
    assert_eq!(std::fs::read(tmp.path().join("new")).unwrap(), data);

    // SETATTR mode + size + mtime
    let mut body = vec![0u8; 88];
    body[0..4].copy_from_slice(&(1u32 | 8 | (1 << 5)).to_le_bytes());
    body[16..24].copy_from_slice(&2u64.to_le_bytes());
    body[40..48].copy_from_slice(&1_000_000u64.to_le_bytes());
    body[68..72].copy_from_slice(&0o600u32.to_le_bytes());
    let (err, out) = c.call(SETATTR, node, &body);
    assert_eq!(err, 0);
    assert_eq!(u64_at(&out, 16 + 8), 2, "size");
    let meta = std::fs::metadata(tmp.path().join("existing")).unwrap();
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    assert_eq!(meta.permissions().mode() & 0o7777, 0o600);
    assert_eq!(meta.mtime(), 1_000_000);
    assert_eq!(meta.len(), 2);
    let (err, out) = c.call(GETATTR, node, &[0u8; 16]);
    assert_eq!(err, 0);
    assert_eq!(u32_at(&out, 16 + 60), 0o100600, "mode");
}

#[test]
fn directory_handles_survive_deletes_and_forget_drops_inodes() {
    let mut c = Client::new(cfg(vec![mount("/", MountSource::Memory {})]), FakeBackend::new());
    let mut body = le(&[0o755, 0o022], &[4, 4]);
    body.extend_from_slice(&name("d"));
    let (err, out) = c.call(MKDIR, 1, &body);
    assert_eq!(err, 0);
    let d = u64_at(&out, 0);
    for i in 0..300 {
        let (n, fh) = c.create(d, &format!("f{i:03}"));
        c.fh_op(RELEASE, n, fh);
    }
    // rm -rf: read a page, delete it, continue from the last cookie
    let (err, out) = c.call(OPENDIR, d, &[0u8; 8]);
    assert_eq!(err, 0);
    let dfh = u64_at(&out, 0);
    let mut off = 0;
    let mut seen = 0;
    loop {
        let page = c.readdir(READDIR, d, dfh, off, 2048);
        if page.is_empty() {
            break;
        }
        off = page.last().unwrap().1;
        for (n, _) in page {
            if n == "." || n == ".." {
                continue;
            }
            seen += 1;
            assert_eq!(c.call(UNLINK, d, &name(&n)).0, 0);
        }
    }
    assert_eq!(seen, 300);
    c.fh_op(RELEASEDIR, d, dfh);
    assert_eq!(c.call(RMDIR, 1, &name("d")).0, 0);

    // readdirplus returns entries with their lookups; FORGET drops inodes
    let (n, fh) = c.create(1, "x");
    c.fh_op(RELEASE, n, fh);
    let (_, out) = c.call(OPENDIR, 1, &[0u8; 8]);
    let dfh = u64_at(&out, 0);
    let names: Vec<String> =
        c.readdir(READDIRPLUS, 1, dfh, 0, 4096).into_iter().map(|e| e.0).collect();
    assert_eq!(names, vec![".", "..", "x"]);
    // create + readdirplus lookup = 2 references
    c.call(FORGET, n, &le(&[1], &[8]));
    assert_eq!(c.call(GETATTR, n, &[0u8; 16]).0, 0);
    c.call(FORGET, n, &le(&[1], &[8]));
    assert_eq!(c.call(GETATTR, n, &[0u8; 16]).0, -2, "forgotten inode");
    let (err, again) = c.lookup(1, "x");
    assert_eq!(err, 0);
    assert_ne!(again, n, "a forgotten inode gets a new number");
}

#[test]
fn object_commit_errors_reach_flush_and_fsync() {
    let backend = FakeBackend::new();
    let mut c = Client::new(
        cfg(vec![mount(
            "/",
            MountSource::Object(ObjectMountConfig {
                mount_id: 7,
                writable: true,
                enumeration: Enumeration::List,
                commit: CommitMode::Close,
                cache: ObjectCacheConfig {
                    ttl_ms: 1000,
                    max_bytes: 1 << 20,
                    revalidate_open: false,
                    inline_max_bytes: 0,
                },
                max_file_bytes: None,
            }),
        )]),
        backend.clone(),
    );
    backend.fail_writes.lock().unwrap().insert("/f".into());
    let (n, fh) = c.create(1, "f");
    assert_eq!(c.write(n, fh, 0, b"data"), 0);
    // close() → FLUSH carries the commit error (EIO)
    assert_eq!(c.fh_op(FLUSH, n, fh), -5);
    assert_eq!(c.fh_op(FSYNC, n, fh), -5);
    backend.fail_writes.lock().unwrap().clear();
    assert_eq!(c.fh_op(FSYNC, n, fh), 0);
    assert_eq!(backend.get("/f").unwrap(), b"data");
    assert_eq!(c.fh_op(RELEASE, n, fh), 0);
    // a read-only open never commits
    let (_, out) = c.call(OPEN, n, &le(&[0, 0], &[4, 4]));
    let rfh = u64_at(&out, 0);
    assert_eq!(c.read(n, rfh, 0, 100), b"data");
    assert_eq!(c.fh_op(FLUSH, n, rfh), 0);
}

#[test]
fn flush_does_not_fsync_host_files() {
    // FLUSH is every close(): it must not become an fsync of host files
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_str().unwrap().to_string();
    let mut c = Client::new(cfg(vec![mount("/", MountSource::Host { root })]), FakeBackend::new());
    let (n, fh) = c.create(1, "f");
    assert_eq!(c.write(n, fh, 0, b"x"), 0);
    // relative to a request that never touches the disk, so slow (emulated)
    // machines don't fail it: 200 fsyncs cost far more than 200 getattrs
    let started = std::time::Instant::now();
    for _ in 0..200 {
        assert_eq!(c.call(GETATTR, n, &[0u8; 16]).0, 0);
    }
    let baseline = started.elapsed();
    let started = std::time::Instant::now();
    for _ in 0..200 {
        assert_eq!(c.fh_op(FLUSH, n, fh), 0);
    }
    let flushes = started.elapsed();
    assert!(
        flushes < baseline * 5 + std::time::Duration::from_millis(100),
        "200 flushes {flushes:?}, 200 getattrs {baseline:?}"
    );
}
