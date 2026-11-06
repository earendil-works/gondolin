//! `virtiofs_demo <socket> <dir>`: serves `dir` to QEMU's
//! `vhost-user-fs-pci` (num-request-queues=1) on `socket`.

use std::os::unix::net::UnixListener;
use std::sync::Arc;

use gondolin_virtiofs::fuse::{CachePolicy, FuseServer};
use gondolin_virtiofs::passthrough::Passthrough;
use gondolin_virtiofs::vhost_user::Backend;

fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    let socket = args.next().expect("socket path");
    let dir = args.next().expect("directory");
    let cache_secs: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(1);
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;
    eprintln!("virtiofs: serving {dir} on {socket}");
    loop {
        let (conn, _) = listener.accept()?;
        let writeback = std::env::var_os("WRITEBACK").is_some();
        let mut fs = Passthrough::new(&dir)?;
        fs.writeback = writeback;
        let mut server =
            FuseServer::new(fs, CachePolicy { entry_secs: cache_secs, attr_secs: cache_secs });
        server.writeback = writeback;
        server.negative_cache = std::env::var_os("NEGATIVE").is_some();
        let server = Arc::new(server);
        // queue 0: hiprio, queue 1: requests
        let mut backend = Backend::new(server.clone(), 2);
        if let Err(e) = backend.serve(conn) {
            eprintln!("virtiofs: connection ended: {e}");
        }
        for (op, count, us) in server.stats() {
            eprintln!(
                "virtiofs: opcode {op:2} count {count:6} total {:7.1} ms avg {:5.1} µs",
                us as f64 / 1000.0,
                us as f64 / count as f64
            );
        }
        eprintln!("virtiofs: frontend disconnected");
    }
}
