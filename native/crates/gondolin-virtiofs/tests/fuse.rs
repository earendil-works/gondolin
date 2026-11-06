//! FUSE dispatch over the passthrough filesystem, without a VM.

use gondolin_virtiofs::fuse::{CachePolicy, FuseServer};
use gondolin_virtiofs::passthrough::Passthrough;
use gondolin_virtiofs::vhost_user::QueueHandler;
use gondolin_virtiofs::virtq::Writer;

struct Client {
    server: FuseServer<Passthrough>,
    unique: u64,
}

impl Client {
    /// Sends one request; returns (error, payload).
    fn call(&mut self, opcode: u32, nodeid: u64, body: &[u8]) -> (i32, Vec<u8>) {
        self.unique += 1;
        let mut req = Vec::new();
        req.extend_from_slice(&((40 + body.len()) as u32).to_le_bytes());
        req.extend_from_slice(&opcode.to_le_bytes());
        req.extend_from_slice(&self.unique.to_le_bytes());
        req.extend_from_slice(&nodeid.to_le_bytes());
        req.extend_from_slice(&[0u8; 16]);
        req.extend_from_slice(body);
        // Reply split across two buffers to exercise scatter writes.
        let mut a = vec![0u8; 20];
        let mut b = vec![0u8; 1 << 20];
        let n = {
            let mut w = Writer::new(vec![&mut a, &mut b]);
            self.server.handle(1, &req, &mut w)
        };
        let mut out = a;
        out.extend_from_slice(&b);
        out.truncate(n);
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()) as usize, n);
        assert_eq!(u64::from_le_bytes(out[8..16].try_into().unwrap()), self.unique);
        (i32::from_le_bytes(out[4..8].try_into().unwrap()), out[16..].to_vec())
    }
}

fn u64_at(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(b[off..off + 8].try_into().unwrap())
}

fn name(n: &str) -> Vec<u8> {
    let mut v = n.as_bytes().to_vec();
    v.push(0);
    v
}

#[test]
fn create_write_read_lookup_readdir() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("existing"), b"hello").unwrap();
    let fs = Passthrough::new(dir.path()).unwrap();
    let mut c = Client {
        server: FuseServer::new(fs, CachePolicy { entry_secs: 1, attr_secs: 1 }),
        unique: 0,
    };

    // INIT
    let mut init = Vec::new();
    for v in [7u32, 41, 65536, 0xffff_ffff] {
        init.extend_from_slice(&v.to_le_bytes());
    }
    init.extend_from_slice(&[0u8; 48]);
    let (err, out) = c.call(26, 0, &init);
    assert_eq!(err, 0);
    assert_eq!(out.len(), 64);
    assert_eq!(u32::from_le_bytes(out[4..8].try_into().unwrap()), 31);

    // LOOKUP existing → nodeid, size 5
    let (err, out) = c.call(1, 1, &name("existing"));
    assert_eq!(err, 0);
    let node = u64_at(&out, 0);
    assert!(node > 1);
    assert_eq!(u64_at(&out, 40 + 8), 5);

    // LOOKUP missing → -ENOENT
    assert_eq!(c.call(1, 1, &name("missing")).0, -2);
    // names with '/' are rejected
    assert_eq!(c.call(1, 1, &name("a/b")).0, -22);

    // CREATE + WRITE + READ
    let mut create = Vec::new();
    for v in [0o2u32 /* O_RDWR */, 0o100644, 0o022, 0] {
        create.extend_from_slice(&v.to_le_bytes());
    }
    create.extend_from_slice(&name("new"));
    let (err, out) = c.call(35, 1, &create);
    assert_eq!(err, 0);
    let new_node = u64_at(&out, 0);
    let fh = u64_at(&out, 128);
    let data = vec![7u8; 300_000];
    let mut write = Vec::new();
    write.extend_from_slice(&fh.to_le_bytes());
    write.extend_from_slice(&0u64.to_le_bytes());
    write.extend_from_slice(&(data.len() as u32).to_le_bytes());
    write.extend_from_slice(&[0u8; 20]);
    write.extend_from_slice(&data);
    let (err, out) = c.call(16, new_node, &write);
    assert_eq!(err, 0);
    assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()) as usize, data.len());
    let mut read = Vec::new();
    read.extend_from_slice(&fh.to_le_bytes());
    read.extend_from_slice(&1000u64.to_le_bytes());
    read.extend_from_slice(&4096u32.to_le_bytes());
    read.extend_from_slice(&[0u8; 20]);
    let (err, out) = c.call(15, new_node, &read);
    assert_eq!(err, 0);
    assert_eq!(out, vec![7u8; 4096]);
    assert_eq!(std::fs::metadata(dir.path().join("new")).unwrap().len(), 300_000);

    // OPENDIR + READDIR lists ., .., existing, new
    let (err, out) = c.call(27, 1, &[0u8; 8]);
    assert_eq!(err, 0);
    let dfh = u64_at(&out, 0);
    let mut rd = Vec::new();
    rd.extend_from_slice(&dfh.to_le_bytes());
    rd.extend_from_slice(&0u64.to_le_bytes());
    rd.extend_from_slice(&4096u32.to_le_bytes());
    rd.extend_from_slice(&[0u8; 20]);
    let (err, out) = c.call(28, 1, &rd);
    assert_eq!(err, 0);
    let mut names = Vec::new();
    let mut off = 0;
    while off < out.len() {
        let len = u32::from_le_bytes(out[off + 16..off + 20].try_into().unwrap()) as usize;
        names.push(String::from_utf8(out[off + 24..off + 24 + len].to_vec()).unwrap());
        off += (24 + len).div_ceil(8) * 8;
    }
    names.sort();
    assert_eq!(names, [".", "..", "existing", "new"]);

    // UNLINK, unknown opcode
    assert_eq!(c.call(10, 1, &name("new")).0, 0);
    assert!(!dir.path().join("new").exists());
    assert_eq!(c.call(39, 1, &[]).0, -25, "ioctl: ENOTTY");
    assert_eq!(c.call(22, 1, &[]).0, -95, "xattr: EOPNOTSUPP");
    assert_eq!(c.call(40, 1, &[]).0, -38, "unknown: ENOSYS");
}
