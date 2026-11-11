//! RPC-level tests: a fake guest sends sandboxfs frames over a duplex stream
//! (ports of `host/test/fs-rpc.test.ts` and the VFS tests).

use crate::BoxFuture;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use gondolin_proto::vfs::{
    CommitMode, Enumeration, FsCall, HookContext, MountConfig, MountSource, ObjectCacheConfig,
    ObjectMountConfig, VfsCall, VfsCallResult, VfsConfig, VfsHookConfig,
};
use gondolin_wire::cbor::{self, Profile};
use gondolin_wire::value::Value;
use gondolin_wire::{FrameReader, FrameWriter};
use tokio::io::{AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf};

use crate::error::{VfsError, VfsResult, errno};
use crate::hooks::{EventSink, Hooks};
use crate::memory::MemoryProvider;
use crate::object::tests::FakeBackend;
use crate::provider::{DynProvider, Handle, Provider};
use crate::router::Mount;
use crate::rpc::{MAX_RPC_DATA, MountsInfo};
use crate::types::{Attr, DT_DIR, DT_LNK, DT_REG, DirEntry, OpenFlags, linux_open::*};
use crate::{ObjectBackend, VfsService};

/// Fails a test instead of hanging when a peer never answers.
async fn timed<F: std::future::Future<Output = ()>>(f: F) {
    tokio::time::timeout(std::time::Duration::from_secs(20), f).await.expect("test timed out");
}

struct Guest {
    reader: FrameReader<ReadHalf<DuplexStream>>,
    writer: FrameWriter<WriteHalf<DuplexStream>>,
    next_id: u32,
}

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

fn int(v: u64) -> Value {
    Value::Integer(v as i128)
}

fn map(pairs: Vec<(&str, Value)>) -> Value {
    Value::Map(pairs.into_iter().map(|(k, v)| (text(k), v)).collect())
}

fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_map()?.iter().find(|(k, _)| k.as_text() == Some(key)).map(|(_, v)| v)
}

fn uint(v: &Value, key: &str) -> u64 {
    match get(v, key) {
        Some(Value::Integer(i)) => u64::try_from(*i).unwrap(),
        other => panic!("{key}: {other:?} in {v:?}"),
    }
}

fn data(v: &Value) -> Vec<u8> {
    match get(v, "data") {
        Some(Value::Bytes(b)) => b.clone(),
        other => panic!("data: {other:?}"),
    }
}

#[derive(Debug)]
struct Reply {
    err: u64,
    res: Value,
}

impl Reply {
    fn ok(self) -> Value {
        assert_eq!(self.err, 0, "unexpected error: {:?}", self.res);
        self.res
    }
    fn entry_ino(&self) -> u64 {
        uint(get(&self.res, "entry").unwrap(), "ino")
    }
}

impl Guest {
    fn new(service: Arc<VfsService>) -> Guest {
        let (client, server) = tokio::io::duplex(1 << 20);
        tokio::spawn(async move {
            service.serve(server).await.unwrap();
        });
        let (r, w) = tokio::io::split(client);
        Guest { reader: FrameReader::new(r), writer: FrameWriter::new(w), next_id: 1 }
    }

    fn request(&mut self, op: &str, req: Value) -> (u32, Value) {
        let id = self.next_id;
        self.next_id += 1;
        let msg = map(vec![
            ("v", int(1)),
            ("t", text("fs_request")),
            ("id", int(id as u64)),
            ("p", map(vec![("op", text(op)), ("req", req)])),
        ]);
        (id, msg)
    }

    async fn send(&mut self, op: &str, req: Value) -> u32 {
        let (id, msg) = self.request(op, req);
        self.writer.write_frame(&cbor::encode(&msg)).await.unwrap();
        self.writer.flush().await.unwrap();
        id
    }

    async fn recv(&mut self, id: u32, op: &str) -> Reply {
        let frame = self.reader.read_frame().await.unwrap().unwrap();
        let v: Value = cbor::decode_with(&frame, Profile::Guest).unwrap();
        assert_eq!(get(&v, "t").unwrap().as_text(), Some("fs_response"));
        assert_eq!(uint(&v, "id"), id as u64);
        let p = get(&v, "p").unwrap();
        assert_eq!(get(p, "op").unwrap().as_text(), Some(op));
        Reply { err: uint(p, "err"), res: get(p, "res").cloned().unwrap_or(Value::Null) }
    }

    async fn call(&mut self, op: &str, req: Vec<(&str, Value)>) -> Reply {
        let id = self.send(op, map(req)).await;
        self.recv(id, op).await
    }

    async fn create(&mut self, parent: u64, name: &str) -> (u64, u64) {
        let r = self
            .call(
                "create",
                vec![
                    ("parent_ino", int(parent)),
                    ("name", text(name)),
                    ("mode", int(0o644)),
                    ("flags", int(0)),
                ],
            )
            .await;
        let ino = r.entry_ino();
        let res = r.ok();
        (ino, uint(&res, "fh"))
    }

    async fn create_file(&mut self, name: &str, content: &[u8]) -> u64 {
        let (ino, fh) = self.create(1, name).await;
        if !content.is_empty() {
            self.write(fh, 0, content).await;
        }
        self.release(fh).await;
        ino
    }

    async fn write(&mut self, fh: u64, offset: u64, content: &[u8]) -> u64 {
        let r = self
            .call(
                "write",
                vec![
                    ("fh", int(fh)),
                    ("offset", int(offset)),
                    ("data", Value::Bytes(content.to_vec())),
                ],
            )
            .await
            .ok();
        uint(&r, "size")
    }

    async fn read(&mut self, fh: u64, offset: u64, size: u64) -> Vec<u8> {
        data(
            &self
                .call("read", vec![("fh", int(fh)), ("offset", int(offset)), ("size", int(size))])
                .await
                .ok(),
        )
    }

    async fn release(&mut self, fh: u64) {
        self.call("release", vec![("fh", int(fh))]).await.ok();
    }

    async fn lookup(&mut self, parent: u64, name: &str) -> Reply {
        self.call("lookup", vec![("parent_ino", int(parent)), ("name", text(name))]).await
    }

    async fn mkdir(&mut self, parent: u64, name: &str) -> u64 {
        self.call(
            "mkdir",
            vec![("parent_ino", int(parent)), ("name", text(name)), ("mode", int(0o755))],
        )
        .await
        .entry_ino()
    }

    async fn open(&mut self, ino: u64, flags: u64) -> Reply {
        self.call("open", vec![("ino", int(ino)), ("flags", int(flags))]).await
    }

    async fn readdir(&mut self, ino: u64, offset: u64, max: u64) -> Vec<(String, u64, u64)> {
        let r = self
            .call(
                "readdir",
                vec![("ino", int(ino)), ("offset", int(offset)), ("max_entries", int(max))],
            )
            .await
            .ok();
        get(&r, "entries")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    get(e, "name").unwrap().as_text().unwrap().to_string(),
                    uint(e, "type"),
                    uint(e, "offset"),
                )
            })
            .collect()
    }
}

fn memory_service() -> (Arc<VfsService>, MemoryProvider) {
    let m = MemoryProvider::new();
    let svc = VfsService::from_mounts(
        vec![Mount { path: "/".into(), provider: Arc::new(m.clone()) }],
        Some(MountsInfo { mount: "/data".into(), binds: vec!["/app".into()] }),
        Hooks::new(None, EventSink::none()),
    )
    .unwrap();
    (Arc::new(svc), m)
}

fn service_with(provider: DynProvider) -> Arc<VfsService> {
    Arc::new(
        VfsService::from_mounts(
            vec![Mount { path: "/".into(), provider }],
            None,
            Hooks::new(None, EventSink::none()),
        )
        .unwrap(),
    )
}

/// Counts `readdir` calls per path; `access`/`link`/`chmod` can be disabled.
struct Probe {
    inner: MemoryProvider,
    readdirs: std::sync::Mutex<std::collections::HashMap<String, usize>>,
    no_access: bool,
}

impl Provider for Probe {
    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move { self.inner.lstat(path).await })
    }
    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move { self.inner.stat(path).await })
    }
    fn readdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Vec<DirEntry>>> {
        Box::pin(async move {
            *self.readdirs.lock().unwrap().entry(path.to_string()).or_default() += 1;
            self.inner.readdir(path).await
        })
    }
    fn open<'a>(
        &'a self,
        path: &'a str,
        flags: OpenFlags,
        mode: u32,
    ) -> BoxFuture<'a, VfsResult<Handle>> {
        Box::pin(async move { self.inner.open(path, flags, mode).await })
    }
    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        mode: u32,
        recursive: bool,
    ) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.inner.mkdir(path, mode, recursive).await })
    }
    fn rmdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.inner.rmdir(path).await })
    }
    fn unlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.inner.unlink(path).await })
    }
    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.inner.rename(from, to).await })
    }
    fn access<'a>(&'a self, path: &'a str, mask: u32) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            if self.no_access {
                return Err(VfsError::op(errno::ENOSYS, "access", path));
            }
            self.inner.access(path, mask).await
        })
    }
}

fn probe(no_access: bool) -> Arc<Probe> {
    Arc::new(Probe { inner: MemoryProvider::new(), readdirs: Default::default(), no_access })
}

#[tokio::test]
async fn create_write_read() {
    timed(create_write_read_body()).await
}

async fn create_write_read_body() {
    let (svc, m) = memory_service();
    let mut g = Guest::new(svc);
    let (_, fh) = g.create(1, "hello.txt").await;
    assert_eq!(g.write(fh, 0, b"hello").await, 5);
    assert_eq!(g.read(fh, 0, 5).await, b"hello");
    let l = g.lookup(1, "hello.txt").await;
    let ino = l.entry_ino();
    let attr = g.call("getattr", vec![("ino", int(ino))]).await.ok();
    assert_eq!(uint(get(&attr, "attr").unwrap(), "size"), 5);
    assert_eq!(uint(get(&attr, "attr").unwrap(), "mode"), 0o100644);
    g.release(fh).await;
    assert_eq!(m.read_file_sync("/hello.txt").unwrap(), b"hello");
    // root inode is 1, new inodes count from 2
    assert_eq!(ino, 2);
}

#[tokio::test]
async fn readdir_offsets_types_and_cache() {
    timed(readdir_offsets_types_and_cache_body()).await
}

async fn readdir_offsets_types_and_cache_body() {
    let p = probe(false);
    let svc = service_with(p.clone());
    let mut g = Guest::new(svc);
    g.create_file("a.txt", b"").await;
    g.create_file("b.txt", b"").await;
    g.mkdir(1, "pkg").await;
    let first = g.readdir(1, 0, 1).await;
    assert_eq!(first.len(), 1);
    let second = g.readdir(1, first[0].2, 1).await;
    assert_eq!(second.len(), 1);
    assert_ne!(first[0].0, second[0].0);
    assert_eq!(p.readdirs.lock().unwrap()["/"], 1);
    let all = g.readdir(1, 0, 128).await;
    let types: std::collections::HashMap<_, _> =
        all.iter().map(|(n, t, _)| (n.clone(), *t)).collect();
    assert_eq!(types["pkg"], DT_DIR as u64);
    assert_eq!(types["a.txt"], DT_REG as u64);
    assert_eq!(p.readdirs.lock().unwrap()["/"], 1);
    // mutation invalidates only the affected directory
    let left = g.mkdir(1, "left").await;
    let right = g.mkdir(1, "right").await;
    g.readdir(left, 0, 128).await;
    g.readdir(right, 0, 128).await;
    g.create(left, "c.txt").await;
    g.readdir(right, 0, 128).await;
    g.readdir(left, 0, 128).await;
    let counts = p.readdirs.lock().unwrap().clone();
    assert_eq!(counts["/right"], 1);
    assert_eq!(counts["/left"], 2);
    g.readdir(1, 0, 128).await;
    assert_eq!(p.readdirs.lock().unwrap()["/"], 2);
}

#[tokio::test]
async fn readdirplus_looks_up_what_fits() {
    timed(readdirplus_looks_up_what_fits_body()).await
}

async fn readdirplus_looks_up_what_fits_body() {
    let (service, _) = memory_service();
    let mut g = Guest::new(service);
    let mut inos = Vec::new();
    for name in ["a", "bb", "ccc"] {
        inos.push(g.create(1, name).await.0);
    }
    let plus = |r: Value| -> Vec<(String, u64, Option<u64>)> {
        get(&r, "entries")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    get(e, "name").unwrap().as_text().unwrap().to_string(),
                    uint(e, "offset"),
                    get(e, "entry").map(|entry| {
                        assert!(get(entry, "attr").is_some());
                        uint(entry, "ino")
                    }),
                )
            })
            .collect()
    };
    let call = |offset: u64, max_bytes: u64| {
        vec![("ino", int(1)), ("offset", int(offset)), ("max_bytes", int(max_bytes))]
    };

    // every entry with its lookup, the same inodes as readdir/create
    let all = plus(g.call("readdirplus", call(0, 65536)).await.ok());
    let names: Vec<_> = all.iter().map(|(n, _, _)| n.as_str()).collect();
    assert_eq!(names, ["a", "bb", "ccc"]);
    for ((_, _, ino), created) in all.iter().zip(&inos) {
        assert_eq!(*ino, Some(*created));
    }

    // only what fits the reply: the rest comes with the next call
    let budget = crate::rpc::direntplus_size(1) + crate::rpc::direntplus_size(2);
    let first = plus(g.call("readdirplus", call(0, budget as u64)).await.ok());
    assert_eq!(first.len(), 2);
    let rest = plus(g.call("readdirplus", call(first[1].1, 65536)).await.ok());
    assert_eq!(rest.iter().map(|(n, _, _)| n.as_str()).collect::<Vec<_>>(), ["ccc"]);
    assert_eq!(crate::rpc::direntplus_size(1), 160);
    assert_eq!(crate::rpc::direntplus_size(8), 160);
    assert_eq!(crate::rpc::direntplus_size(9), 168);
}

#[tokio::test]
async fn validates_names_and_sizes() {
    timed(validates_names_and_sizes_body()).await
}

async fn validates_names_and_sizes_body() {
    let (svc, _) = memory_service();
    let mut g = Guest::new(svc);
    let r = g
        .call(
            "mkdir",
            vec![("parent_ino", int(1)), ("name", text("bad/name")), ("mode", int(0o755))],
        )
        .await;
    assert_eq!(r.err, errno::EINVAL as u64);
    let (_, fh) = g.create(1, "big.txt").await;
    let r = g
        .call(
            "write",
            vec![
                ("fh", int(fh)),
                ("offset", int(0)),
                ("data", Value::Bytes(vec![0; MAX_RPC_DATA + 1])),
            ],
        )
        .await;
    assert_eq!(r.err, errno::EINVAL as u64);
    let r = g
        .call(
            "read",
            vec![("fh", int(fh)), ("offset", int(0)), ("size", int(MAX_RPC_DATA as u64 + 1))],
        )
        .await;
    assert_eq!(r.err, errno::EINVAL as u64);
    let r = g.call("lookup", vec![("parent_ino", text("x")), ("name", text("y"))]).await;
    assert_eq!(r.err, errno::EINVAL as u64);
    let r = g.call("read", vec![("fh", int(999)), ("offset", int(0)), ("size", int(1))]).await;
    assert_eq!(r.err, errno::EBADF as u64);
    let r = g.call("frobnicate", vec![]).await;
    assert_eq!(r.err, errno::ENOSYS as u64);
}

#[tokio::test]
async fn unlink_rmdir_remove_mappings() {
    timed(unlink_rmdir_remove_mappings_body()).await
}

async fn unlink_rmdir_remove_mappings_body() {
    let (svc, _) = memory_service();
    let mut g = Guest::new(svc);
    let ino = g.create_file("hello.txt", b"x").await;
    g.call("unlink", vec![("parent_ino", int(1)), ("name", text("hello.txt"))]).await.ok();
    let l = g.lookup(1, "hello.txt").await;
    assert_eq!(l.err, errno::ENOENT as u64);
    assert_eq!(uint(&l.res, "entry_ttl_ms"), 250);
    assert_eq!(g.call("getattr", vec![("ino", int(ino))]).await.err, errno::ENOENT as u64);

    let dir = g.mkdir(1, "dir").await;
    let child = g.mkdir(dir, "child").await;
    let r = g.call("rmdir", vec![("parent_ino", int(1)), ("name", text("dir"))]).await;
    assert_eq!(r.err, errno::ENOTEMPTY as u64);
    g.call("rmdir", vec![("parent_ino", int(dir)), ("name", text("child"))]).await.ok();
    assert_eq!(g.call("getattr", vec![("ino", int(child))]).await.err, errno::ENOENT as u64);
    g.call("rmdir", vec![("parent_ino", int(1)), ("name", text("dir"))]).await.ok();
    assert_eq!(g.call("getattr", vec![("ino", int(dir))]).await.err, errno::ENOENT as u64);
}

#[tokio::test]
async fn rename_preserves_and_replaces_inodes() {
    timed(rename_preserves_and_replaces_inodes_body()).await
}

async fn rename_preserves_and_replaces_inodes_body() {
    let (svc, _) = memory_service();
    let mut g = Guest::new(svc);
    let a = g.mkdir(1, "a").await;
    let b = g.mkdir(1, "b").await;
    let (file, fh) = g.create(a, "file.txt").await;
    g.release(fh).await;
    let r = g
        .call(
            "rename",
            vec![
                ("old_parent_ino", int(a)),
                ("old_name", text("file.txt")),
                ("new_parent_ino", int(b)),
                ("new_name", text("renamed.txt")),
                ("flags", int(0)),
            ],
        )
        .await;
    r.ok();
    assert_eq!(g.lookup(b, "renamed.txt").await.entry_ino(), file);
    assert_eq!(g.lookup(a, "file.txt").await.err, errno::ENOENT as u64);
    g.call("truncate", vec![("ino", int(file)), ("size", int(0))]).await.ok();

    let x = g.create_file("x.txt", b"").await;
    let y = g.create_file("y.txt", b"").await;
    g.call(
        "rename",
        vec![
            ("old_parent_ino", int(1)),
            ("old_name", text("x.txt")),
            ("new_parent_ino", int(1)),
            ("new_name", text("y.txt")),
        ],
    )
    .await
    .ok();
    assert_eq!(g.lookup(1, "y.txt").await.entry_ino(), x);
    assert_eq!(g.call("getattr", vec![("ino", int(y))]).await.err, errno::ENOENT as u64);
    // directory renames move descendants
    let d = g.mkdir(1, "d").await;
    let (inner, fh) = g.create(d, "inner").await;
    g.release(fh).await;
    g.call(
        "rename",
        vec![
            ("old_parent_ino", int(1)),
            ("old_name", text("d")),
            ("new_parent_ino", int(b)),
            ("new_name", text("d2")),
        ],
    )
    .await
    .ok();
    let d2 = g.lookup(b, "d2").await.entry_ino();
    assert_eq!(d2, d);
    assert_eq!(g.lookup(d2, "inner").await.entry_ino(), inner);
}

#[tokio::test]
async fn hard_links_memory_and_host() {
    timed(hard_links_memory_and_host_body()).await
}

async fn hard_links_memory_and_host_body() {
    let (svc, _) = memory_service();
    let mut g = Guest::new(svc);
    let ino = g.create_file("origin.txt", b"hello").await;
    let r = g
        .call(
            "link",
            vec![
                ("old_ino", int(ino)),
                ("new_parent_ino", int(1)),
                ("new_name", text("linked.txt")),
            ],
        )
        .await;
    assert_eq!(r.entry_ino(), ino);
    assert_eq!(g.lookup(1, "linked.txt").await.entry_ino(), ino);
    let fh = uint(&g.open(ino, O_RDONLY).await.ok(), "fh");
    assert_eq!(g.read(fh, 0, 5).await, b"hello");
    g.release(fh).await;
    g.call("unlink", vec![("parent_ino", int(1)), ("name", text("origin.txt"))]).await.ok();
    g.lookup(1, "linked.txt").await.ok();

    let tmp = tempfile::tempdir().unwrap();
    let svc = service_with(Arc::new(
        crate::host::HostProvider::new(tmp.path().to_str().unwrap()).unwrap(),
    ));
    let mut g = Guest::new(svc);
    let ino = g.create_file("origin.txt", b"hello").await;
    let r = g
        .call(
            "link",
            vec![
                ("old_ino", int(ino)),
                ("new_parent_ino", int(1)),
                ("new_name", text("linked.txt")),
            ],
        )
        .await;
    assert_eq!(r.entry_ino(), ino);
    assert_eq!(std::fs::metadata(tmp.path().join("origin.txt")).unwrap().nlink(), 2);
    g.call("unlink", vec![("parent_ino", int(1)), ("name", text("origin.txt"))]).await.ok();
    g.call("getattr", vec![("ino", int(ino))]).await.ok();
}

#[tokio::test]
async fn chmod_memory_host_readonly() {
    timed(chmod_memory_host_readonly_body()).await
}

async fn chmod_memory_host_readonly_body() {
    let (svc, m) = memory_service();
    let mut g = Guest::new(svc);
    let ino = g.create_file("script.sh", b"").await;
    g.call("chmod", vec![("ino", int(ino)), ("mode", int(0o755))]).await.ok();
    let a = g.call("getattr", vec![("ino", int(ino))]).await.ok();
    assert_eq!(uint(get(&a, "attr").unwrap(), "mode"), 0o100755);
    assert_eq!(m.stat_sync("/script.sh").perm(), 0o755);

    let tmp = tempfile::tempdir().unwrap();
    let svc = service_with(Arc::new(
        crate::host::HostProvider::new(tmp.path().to_str().unwrap()).unwrap(),
    ));
    let mut g = Guest::new(svc);
    let ino = g.create_file("script.sh", b"").await;
    g.call("chmod", vec![("ino", int(ino)), ("mode", int(0o750))]).await.ok();
    assert_eq!(
        std::fs::metadata(tmp.path().join("script.sh")).unwrap().permissions().mode() & 0o7777,
        0o750
    );
    g.call("chmod", vec![("ino", int(ino)), ("mode", int(0o6755))]).await.ok();
    assert_eq!(
        std::fs::metadata(tmp.path().join("script.sh")).unwrap().permissions().mode() & 0o7777,
        0o755
    );

    let base = MemoryProvider::new();
    base.write_file_sync("/file.txt", b"x", 0o644).unwrap();
    let svc = service_with(crate::layers::readonly(Arc::new(base.clone())));
    let mut g = Guest::new(svc);
    let ino = g.lookup(1, "file.txt").await.entry_ino();
    assert_eq!(
        g.call("chmod", vec![("ino", int(ino)), ("mode", int(0o755))]).await.err,
        errno::EROFS as u64
    );
    assert_eq!(base.stat_sync("/file.txt").perm(), 0o644);
    let (_, r) = (
        0,
        g.call("create", vec![("parent_ino", int(1)), ("name", text("n")), ("mode", int(0o644))])
            .await,
    );
    assert_eq!(r.err, errno::EROFS as u64);
    assert_eq!(g.open(ino, O_WRONLY).await.err, errno::EROFS as u64);
    assert_eq!(g.open(ino, O_RDONLY | O_TRUNC).await.err, errno::EROFS as u64);
    let fh = uint(&g.open(ino, O_RDONLY).await.ok(), "fh");
    assert_eq!(g.read(fh, 0, 10).await, b"x");
}

#[tokio::test]
async fn pipelined_requests_answer_in_order() {
    timed(pipelined_requests_answer_in_order_body()).await
}

async fn pipelined_requests_answer_in_order_body() {
    let (svc, m) = memory_service();
    m.write_file_sync("/a.txt", b"a", 0o644).unwrap();
    m.write_file_sync("/b.txt", b"b", 0o644).unwrap();
    let mut g = Guest::new(svc);
    let id1 = g.send("lookup", map(vec![("parent_ino", int(1)), ("name", text("a.txt"))])).await;
    let id2 = g.send("lookup", map(vec![("parent_ino", int(1)), ("name", text("b.txt"))])).await;
    g.recv(id1, "lookup").await.ok();
    g.recv(id2, "lookup").await.ok();
}

#[tokio::test]
async fn pipelined_rename_cannot_redirect_host_creates() {
    timed(pipelined_rename_cannot_redirect_host_creates_body()).await
}

async fn pipelined_rename_cannot_redirect_host_creates_body() {
    let tmp = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(tmp.path()).unwrap();
    let root = base.join("root");
    let outside = base.join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret"), "outside").unwrap();
    let svc =
        service_with(Arc::new(crate::host::HostProvider::new(root.to_str().unwrap()).unwrap()));
    let mut g = Guest::new(svc);
    for _ in 0..20 {
        let _ = std::fs::remove_dir_all(root.join("x"));
        let _ = std::fs::remove_dir_all(root.join("y"));
        std::fs::create_dir(root.join("x")).unwrap();
        std::fs::create_dir(root.join("y")).unwrap();
        symlink(outside.join("secret"), root.join("y/secret")).unwrap();
        let x = g.lookup(1, "x").await.entry_ino();
        let id1 = g
            .send(
                "rename",
                map(vec![
                    ("old_parent_ino", int(1)),
                    ("old_name", text("y")),
                    ("new_parent_ino", int(1)),
                    ("new_name", text("x")),
                ]),
            )
            .await;
        let id2 = g
            .send(
                "create",
                map(vec![
                    ("parent_ino", int(x)),
                    ("name", text("secret")),
                    ("mode", int(0o644)),
                    ("flags", int(O_RDWR | O_CREAT | O_APPEND)),
                ]),
            )
            .await;
        g.recv(id1, "rename").await;
        let created = g.recv(id2, "create").await;
        if created.err == 0 {
            let fh = uint(&created.res, "fh");
            let content = g.read(fh, 0, 64).await;
            g.release(fh).await;
            assert_ne!(content, b"outside");
        }
    }
    assert_eq!(std::fs::read_to_string(outside.join("secret")).unwrap(), "outside");
}

#[tokio::test]
async fn symlinks_and_dangling_links() {
    timed(symlinks_and_dangling_links_body()).await
}

async fn symlinks_and_dangling_links_body() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("target.txt"), "ok").unwrap();
    let svc = service_with(Arc::new(
        crate::host::HostProvider::new(tmp.path().to_str().unwrap()).unwrap(),
    ));
    let mut g = Guest::new(svc);
    g.call(
        "symlink",
        vec![("parent_ino", int(1)), ("name", text("python")), ("target", text("target.txt"))],
    )
    .await
    .ok();
    assert_eq!(
        std::fs::read_link(tmp.path().join("python")).unwrap().to_str().unwrap(),
        "target.txt"
    );
    let ino = g.lookup(1, "python").await.entry_ino();
    let r = g.call("readlink", vec![("ino", int(ino))]).await.ok();
    assert_eq!(get(&r, "target").unwrap().as_text(), Some("target.txt"));

    let (svc, _) = memory_service();
    let mut g = Guest::new(svc);
    g.call(
        "symlink",
        vec![("parent_ino", int(1)), ("name", text("dangling")), ("target", text("missing"))],
    )
    .await
    .ok();
    let ino = g.lookup(1, "dangling").await.entry_ino();
    let a = g.call("getattr", vec![("ino", int(ino))]).await.ok();
    assert_eq!(uint(get(&a, "attr").unwrap(), "mode") & 0o170000, 0o120000);
    let entries = g.readdir(1, 0, 128).await;
    assert_eq!(entries.iter().find(|e| e.0 == "dangling").unwrap().1, DT_LNK as u64);
}

#[tokio::test]
async fn access_checks() {
    timed(access_checks_body()).await
}

async fn access_checks_body() {
    let p = probe(true);
    let svc = service_with(p.clone());
    let mut g = Guest::new(svc);
    let ino = g.create_file("perm.txt", b"").await;
    let call = |mask: u64| {
        vec![("ino", int(ino)), ("mask", int(mask)), ("uid", int(1234)), ("gid", int(1234))]
    };
    assert_eq!(g.call("access", call(4)).await.err, 0);
    assert_eq!(g.call("access", call(1)).await.err, errno::EACCES as u64);
    assert_eq!(g.call("access", call(8)).await.err, errno::EINVAL as u64);

    // read-only providers report EROFS for write checks
    let base = MemoryProvider::new();
    base.write_file_sync("/ro.txt", b"x", 0o644).unwrap();
    let svc = service_with(crate::layers::readonly(Arc::new(base)));
    let mut g = Guest::new(svc);
    let ino = g.lookup(1, "ro.txt").await.entry_ino();
    let r = g
        .call(
            "access",
            vec![("ino", int(ino)), ("mask", int(2)), ("uid", int(1234)), ("gid", int(1234))],
        )
        .await;
    assert_eq!(r.err, errno::EROFS as u64);
}

#[tokio::test]
async fn fallocate_copy_file_range_open_flags() {
    timed(fallocate_copy_file_range_open_flags_body()).await
}

async fn fallocate_copy_file_range_open_flags_body() {
    let (svc, _) = memory_service();
    let mut g = Guest::new(svc);
    let (ino, fh) = g.create(1, "alloc.txt").await;
    g.write(fh, 0, b"ab").await;
    g.call(
        "fallocate",
        vec![("fh", int(fh)), ("offset", int(10)), ("length", int(5)), ("mode", int(0))],
    )
    .await
    .ok();
    let a = g.call("getattr", vec![("ino", int(ino))]).await.ok();
    assert_eq!(uint(get(&a, "attr").unwrap(), "size"), 15);
    let r = g
        .call(
            "fallocate",
            vec![("fh", int(fh)), ("offset", int(0)), ("length", int(1)), ("mode", int(1))],
        )
        .await;
    assert_eq!(r.err, errno::EOPNOTSUPP as u64);
    g.release(fh).await;

    let (_, src) = g.create(1, "src.txt").await;
    let (_, dst) = g.create(1, "dst.txt").await;
    g.write(src, 0, b"hello world").await;
    let cfr = |fh_in: u64, off_in: u64, fh_out: u64, off_out: u64, len: u64, flags: u64| {
        vec![
            ("fh_in", int(fh_in)),
            ("off_in", int(off_in)),
            ("fh_out", int(fh_out)),
            ("off_out", int(off_out)),
            ("len", int(len)),
            ("flags", int(flags)),
        ]
    };
    let r = g.call("copy_file_range", cfr(src, 0, dst, 0, 5, 0)).await.ok();
    assert_eq!(uint(&r, "size"), 5);
    assert_eq!(g.read(dst, 0, 16).await, b"hello");
    assert_eq!(
        g.call("copy_file_range", cfr(src, 0, dst, 0, 1, 1)).await.err,
        errno::EINVAL as u64
    );
    assert_eq!(
        g.call("copy_file_range", cfr(src, 0, src, 1, 2, 0)).await.err,
        errno::EINVAL as u64
    );

    let ino = g.create_file("f.txt", b"hello").await;
    assert_eq!(g.open(ino, O_CREAT | O_WRONLY).await.err, errno::EINVAL as u64);
    let fh = uint(&g.open(ino, O_WRONLY | O_TRUNC).await.ok(), "fh");
    assert_eq!(g.read(fh, 0, 10).await, b"");
    g.write(fh, 0, b"a").await;
    g.release(fh).await;
    let fh = uint(&g.open(ino, O_WRONLY | O_APPEND).await.ok(), "fh");
    g.write(fh, 0, b"b").await;
    g.release(fh).await;
    let fh = uint(&g.open(ino, O_RDONLY).await.ok(), "fh");
    assert_eq!(g.read(fh, 0, 10).await, b"ab");
}

#[tokio::test]
async fn statfs_mounts_and_metrics() {
    timed(statfs_mounts_and_metrics_body()).await
}

async fn statfs_mounts_and_metrics_body() {
    let (svc, _) = memory_service();
    let mut g = Guest::new(svc.clone());
    let s = g.call("statfs", vec![("ino", int(1))]).await.ok();
    let s = get(&s, "statfs").unwrap();
    assert_eq!(uint(s, "bsize"), 4096);
    assert_eq!(uint(s, "namelen"), 255);
    assert!(uint(s, "blocks") > 0);
    assert_eq!(g.call("statfs", vec![("ino", int(9999))]).await.err, errno::ENOENT as u64);
    let m = g.call("mounts", vec![]).await.ok();
    assert_eq!(get(&m, "mount").unwrap().as_text(), Some("/data"));
    assert_eq!(get(&m, "binds").unwrap().as_array().unwrap().len(), 1);
    let (_, fh) = g.create(1, "m.txt").await;
    g.write(fh, 0, b"abc").await;
    g.read(fh, 0, 2).await;
    let _ = g.call("read", vec![("fh", int(9999)), ("size", int(1))]).await;
    let metrics = svc.metrics().await;
    assert_eq!(metrics.bytes_written, 3);
    assert_eq!(metrics.bytes_read, 2);
    assert_eq!(metrics.ops["read"], 2);
    assert!(metrics.errors >= 2);
}

#[tokio::test]
async fn resync_after_garbage() {
    timed(resync_after_garbage_body()).await
}

async fn resync_after_garbage_body() {
    let (svc, m) = memory_service();
    m.write_file_sync("/x", b"x", 0o644).unwrap();
    let (client, server) = tokio::io::duplex(1 << 16);
    let svc2 = svc.clone();
    tokio::spawn(async move { svc2.serve(server).await.unwrap() });
    let (r, mut w) = tokio::io::split(client);
    // undecodable frame, a non-request, a request without id, an oversized frame header
    w.write_all(&[0, 0, 0, 2, 0xff, 0xff]).await.unwrap();
    let other = cbor::encode(&map(vec![("v", int(1)), ("t", text("fs_response")), ("id", int(1))]));
    w.write_all(&gondolin_wire::frame(&other).unwrap()).await.unwrap();
    let noid =
        cbor::encode(&map(vec![("v", int(1)), ("t", text("fs_request")), ("p", map(vec![]))]));
    w.write_all(&gondolin_wire::frame(&noid).unwrap()).await.unwrap();
    let big = (gondolin_wire::MAX_FRAME + 1) as u32;
    w.write_all(&big.to_be_bytes()).await.unwrap();
    let mut g = Guest { reader: FrameReader::new(r), writer: FrameWriter::new(w), next_id: 5 };
    let writer = g.writer.into_inner();
    let mut writer = writer;
    let chunk = vec![0u8; 64 * 1024];
    let mut left = big as usize;
    while left > 0 {
        let n = left.min(chunk.len());
        writer.write_all(&chunk[..n]).await.unwrap();
        left -= n;
    }
    g.writer = FrameWriter::new(writer);
    let r = g.lookup(1, "x").await;
    assert_eq!(r.err, 0);
}

/// Backend recording hooks; denies `open` of `/blocked.txt` for writing.
#[derive(Default)]
struct HookBackend {
    seen: std::sync::Mutex<Vec<HookContext>>,
    calls: AtomicUsize,
}

impl ObjectBackend for HookBackend {
    fn call<'a>(&'a self, _call: VfsCall) -> BoxFuture<'a, VfsResult<VfsCallResult>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Err(VfsError::new(errno::ENOSYS, "none"))
        })
    }
    fn before_hook<'a>(&'a self, ctx: &'a HookContext) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(ctx.clone());
            if ctx.op == "open"
                && ctx.path.as_deref() == Some("/blocked.txt")
                && ctx.flags.as_deref().is_some_and(|f| f.contains('w') || f.contains('a'))
            {
                return Err(VfsError::new(errno::EACCES, "blocked"));
            }
            Ok(())
        })
    }
}

#[tokio::test]
async fn before_hooks_and_events() {
    timed(before_hooks_and_events_body()).await
}

async fn before_hooks_and_events_body() {
    let backend = Arc::new(HookBackend::default());
    let (events, mut rx) = EventSink::channel(1024);
    let cfg = VfsConfig {
        fuse_mount: "/data".into(),
        binds: vec![],
        mounts: vec![MountConfig {
            path: "/".into(),
            source: MountSource::Memory {},
            readonly: false,
            layers: vec![],
        }],
        hooks: VfsHookConfig { before: true, events: true },
        transport: Default::default(),
    };
    let svc = Arc::new(VfsService::new(&cfg, backend.clone(), events).unwrap());
    let mut g = Guest::new(svc);
    let r = g
        .call(
            "create",
            vec![
                ("parent_ino", int(1)),
                ("name", text("blocked.txt")),
                ("mode", int(0o644)),
                ("flags", int(0)),
            ],
        )
        .await;
    assert_eq!(r.err, errno::EACCES as u64);
    let dir = g.mkdir(1, "fuse-e2e").await;
    let (_, fh) = g.create(dir, "hello.txt").await;
    g.write(fh, 0, b"fuse-data").await;
    g.read(fh, 0, 100).await;
    g.release(fh).await;
    g.call(
        "rename",
        vec![
            ("old_parent_ino", int(dir)),
            ("old_name", text("hello.txt")),
            ("new_parent_ino", int(dir)),
            ("new_name", text("hello-renamed.txt")),
        ],
    )
    .await
    .ok();
    g.call("unlink", vec![("parent_ino", int(dir)), ("name", text("hello-renamed.txt"))])
        .await
        .ok();
    let seen = backend.seen.lock().unwrap().clone();
    let has =
        |op: &str, path: &str| seen.iter().any(|c| c.op == op && c.path.as_deref() == Some(path));
    assert!(has("mkdir", "/fuse-e2e"));
    assert!(has("write", "/fuse-e2e/hello.txt"));
    assert!(has("read", "/fuse-e2e/hello.txt"));
    assert!(has("release", "/fuse-e2e/hello.txt"));
    assert!(has("unlink", "/fuse-e2e/hello-renamed.txt"));
    assert!(seen.iter().any(|c| c.op == "rename"
        && c.old_path.as_deref() == Some("/fuse-e2e/hello.txt")
        && c.new_path.as_deref() == Some("/fuse-e2e/hello-renamed.txt")));
    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    assert!(
        events.iter().any(|e| e.ctx.op == "open" && e.error.as_deref() == Some("EACCES")).not()
    );
    assert!(events.iter().any(|e| e.ctx.op == "write" && e.bytes == Some(9)));
    assert!(events.iter().any(|e| e.ctx.op == "unlink"));
    assert_eq!(backend.calls.load(Ordering::Relaxed), 0);
}

trait Not {
    fn not(self) -> bool;
}
impl Not for bool {
    fn not(self) -> bool {
        !self
    }
}

#[tokio::test]
async fn routing_readonly_and_object_mounts() {
    timed(routing_readonly_and_object_mounts_body()).await
}

async fn routing_readonly_and_object_mounts_body() {
    let backend = FakeBackend::new();
    backend.put("/email.eml", b"Subject: hi");
    let cfg = VfsConfig {
        fuse_mount: "/data".into(),
        binds: vec!["/app".into(), "/ro".into()],
        mounts: vec![
            MountConfig {
                path: "/".into(),
                source: MountSource::Memory {},
                readonly: false,
                layers: vec![],
            },
            MountConfig {
                path: "/ro".into(),
                source: MountSource::Static {
                    files: [("/ca.crt".to_string(), b"pem".to_vec())].into(),
                },
                readonly: true,
                layers: vec![],
            },
            MountConfig {
                path: "/app".into(),
                source: MountSource::Object(ObjectMountConfig {
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
                readonly: false,
                layers: vec![],
            },
        ],
        hooks: VfsHookConfig::default(),
        transport: Default::default(),
    };
    let svc = Arc::new(VfsService::new(&cfg, backend.clone(), EventSink::none()).unwrap());
    let mut g = Guest::new(svc.clone());
    let names: Vec<String> = g.readdir(1, 0, 100).await.into_iter().map(|e| e.0).collect();
    assert_eq!(names, vec!["app", "ro"]);
    let ro = g.lookup(1, "ro").await.entry_ino();
    let ca = g.lookup(ro, "ca.crt").await.entry_ino();
    let fh = uint(&g.open(ca, O_RDONLY).await.ok(), "fh");
    assert_eq!(g.read(fh, 0, 100).await, b"pem");
    let r = g
        .call("create", vec![("parent_ino", int(ro)), ("name", text("x")), ("mode", int(0o644))])
        .await;
    assert_eq!(r.err, errno::EROFS as u64);
    let r = g.call(
        "rename",
        vec![
            ("old_parent_ino", int(ro)),
            ("old_name", text("ca.crt")),
            ("new_parent_ino", int(1)),
            ("new_name", text("ca.crt")),
        ],
    );
    assert_eq!(r.await.err, errno::EXDEV as u64);

    let app = g.lookup(1, "app").await.entry_ino();
    let email = g.lookup(app, "email.eml").await.entry_ino();
    let fh = uint(&g.open(email, O_RDONLY).await.ok(), "fh");
    assert_eq!(g.read(fh, 0, 100).await, b"Subject: hi");
    g.release(fh).await;
    let (_, fh) = g.create(app, "guest.txt").await;
    g.write(fh, 0, b"guest-data").await;
    assert!(backend.get("/guest.txt").is_none());
    g.release(fh).await;
    assert_eq!(backend.get("/guest.txt").unwrap(), b"guest-data");

    // `commit: close` writers get FLUSH (no FOPEN_NOFLUSH) and commit on it,
    // so the guest's close() sees the result; everything else skips FLUSH
    const FOPEN_NOFLUSH: u64 = 1 << 5;
    let r = g
        .call(
            "create",
            vec![
                ("parent_ino", int(app)),
                ("name", text("flushed.txt")),
                ("mode", int(0o644)),
                ("flags", int(O_WRONLY)),
            ],
        )
        .await
        .ok();
    assert_eq!(uint(&r, "open_flags") & FOPEN_NOFLUSH, 0);
    let fh = uint(&r, "fh");
    g.write(fh, 0, b"flushed").await;
    g.call("flush", vec![("fh", int(fh))]).await.ok();
    assert_eq!(backend.get("/flushed.txt").unwrap(), b"flushed");
    g.call("fsync", vec![("fh", int(fh))]).await.ok();
    g.release(fh).await;
    let ro_open = g.open(email, O_RDONLY).await.ok();
    assert_ne!(uint(&ro_open, "open_flags") & FOPEN_NOFLUSH, 0, "readers have nothing to flush");
    g.release(uint(&ro_open, "fh")).await;
    let r = g
        .call("create", vec![("parent_ino", int(1)), ("name", text("m")), ("mode", int(0o644))])
        .await
        .ok();
    assert_ne!(uint(&r, "open_flags") & FOPEN_NOFLUSH, 0, "memory files commit nothing");
    assert_eq!(g.call("flush", vec![("fh", int(uint(&r, "fh")))]).await.err, 0);
    g.release(uint(&r, "fh")).await;

    // controller fs API on the same table
    let r = svc.controller_call(FsCall::Readdir { path: "/app".into() }).await;
    assert!(r.ok);
    let mut names: Vec<String> = r.entries.unwrap().into_iter().map(|e| e.name).collect();
    names.sort();
    assert_eq!(names, vec!["email.eml", "flushed.txt", "guest.txt"]);
    let r = svc
        .controller_call(FsCall::Open { path: "/notes.txt".into(), flags: "w".into(), mode: None })
        .await;
    let fh = r.fh.unwrap();
    assert!(
        svc.controller_call(FsCall::Write { fh, offset: 0, data: b"from host".to_vec() }).await.ok
    );
    assert!(svc.controller_call(FsCall::Close { fh }).await.ok);
    let st = svc.controller_call(FsCall::Stat { path: "/notes.txt".into(), follow: true }).await;
    assert_eq!(st.stat.unwrap().size, 9);
    // the guest sees it (readdir cache was invalidated)
    let names: Vec<String> = g.readdir(1, 0, 100).await.into_iter().map(|e| e.0).collect();
    assert!(names.contains(&"notes.txt".to_string()));
    let r = svc.controller_call(FsCall::Stat { path: "/nope".into(), follow: true }).await;
    assert_eq!(r.code.as_deref(), Some("ENOENT"));
    let r = svc
        .controller_call(FsCall::Mkdir { path: "/ro/x".into(), mode: None, recursive: false })
        .await;
    assert_eq!(r.code.as_deref(), Some("EROFS"));
    assert!(svc.invalidate(7, Some("/email.eml")).is_ok());
    assert!(svc.invalidate(8, None).is_err());
}

#[tokio::test]
async fn host_hide_rules_over_rpc() {
    timed(host_hide_rules_over_rpc_body()).await
}

async fn host_hide_rules_over_rpc_body() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(".env"), "SECRET").unwrap();
    std::fs::write(tmp.path().join("ok.txt"), "ok").unwrap();
    std::fs::create_dir(tmp.path().join("node_modules")).unwrap();
    std::fs::write(tmp.path().join("node_modules/x"), "x").unwrap();
    let cfg = VfsConfig {
        fuse_mount: "/data".into(),
        binds: vec![],
        mounts: vec![MountConfig {
            path: "/".into(),
            source: MountSource::Host { root: tmp.path().to_str().unwrap().into() },
            readonly: false,
            layers: vec![gondolin_proto::vfs::MountLayer::Hide(gondolin_proto::vfs::HideConfig {
                paths: vec!["/.env".into(), "/node_modules".into()],
                write_mode: gondolin_proto::vfs::HideWriteMode::Tmpfs,
                deny_write_errno: None,
                deny_symlink_bypass: true,
            })],
        }],
        hooks: VfsHookConfig::default(),
        transport: Default::default(),
    };
    let svc =
        Arc::new(VfsService::new(&cfg, Arc::new(crate::NoBackend), EventSink::none()).unwrap());
    let mut g = Guest::new(svc);
    let names: Vec<String> = g.readdir(1, 0, 100).await.into_iter().map(|e| e.0).collect();
    assert_eq!(names, vec!["ok.txt"]);
    assert_eq!(g.lookup(1, ".env").await.err, errno::ENOENT as u64);
    let (_, fh) = g.create(1, ".env").await;
    g.write(fh, 0, b"GUEST").await;
    g.release(fh).await;
    assert_eq!(std::fs::read_to_string(tmp.path().join(".env")).unwrap(), "SECRET");
    let ino = g.lookup(1, ".env").await.entry_ino();
    let fh = uint(&g.open(ino, O_RDONLY).await.ok(), "fh");
    assert_eq!(g.read(fh, 0, 100).await, b"GUEST");
    // symlink bypass of a hidden path
    // a link resolving to a hidden path is hidden itself (node semantics: the
    // link is created, the entry reply fails)
    let r = g
        .call(
            "symlink",
            vec![("parent_ino", int(1)), ("name", text("nm")), ("target", text("node_modules"))],
        )
        .await;
    assert_eq!(r.err, errno::ENOENT as u64);
    assert_eq!(g.lookup(1, "nm").await.err, errno::ENOENT as u64);
}

#[tokio::test]
async fn rm_rf_while_listing_removes_everything() {
    timed(rm_rf_body()).await
}

/// `rm -rf` reads a batch, unlinks it, continues from the last cookie; the
/// continuation must not skip live entries.
async fn rm_rf_body() {
    let (svc, m) = memory_service();
    for i in 0..300 {
        m.write_file_sync(&format!("/d/f{i:03}"), b"x", 0o644).unwrap();
    }
    let mut g = Guest::new(svc);
    let d = g.lookup(1, "d").await.entry_ino();
    let mut offset = 0;
    loop {
        let batch = g.readdir(d, offset, 64).await;
        if batch.is_empty() {
            break;
        }
        offset = batch.last().unwrap().2;
        for (name, _, _) in batch {
            g.call("unlink", vec![("parent_ino", int(d)), ("name", text(&name))]).await.ok();
        }
    }
    g.call("rmdir", vec![("parent_ino", int(1)), ("name", text("d"))]).await.ok();
}
