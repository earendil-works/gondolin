//! End-to-end TCP tests: a smoltcp guest talks Ethernet over the netdev pipe to
//! the stack, flows go to test handlers.

mod common;

use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use gondolin_netstack::{DnsConfig, NetConfig, NetLimits, SyntheticHostMapping, TcpFlow};
use smoltcp::socket::tcp;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

/// Generous: emulated (amd64 on arm64) and loaded CI machines are slow.
const T: Duration = Duration::from_secs(60);
const REMOTE: Ipv4Addr = Ipv4Addr::new(93, 184, 216, 34);

async fn next_flow(rx: &mut mpsc::UnboundedReceiver<TcpFlow>, guest: &mut Guest) -> TcpFlow {
    let mut slot = None;
    // Keep the guest running while waiting for the handler to get the flow.
    guest
        .run_until(T, |_| {
            if slot.is_none() {
                slot = rx.try_recv().ok();
            }
            slot.is_some().then_some(())
        })
        .await;
    slot.unwrap()
}

/// Guest-side transfer state: sends `send_total` bytes of the pattern, reads
/// until EOF or `recv_total` bytes, verifying the pattern.
struct Transfer {
    sent: usize,
    send_total: usize,
    received: Vec<u8>,
    recv_total: usize,
    close_after_send: bool,
    closed: bool,
}

impl Transfer {
    fn new(send_total: usize, recv_total: usize) -> Self {
        Transfer {
            sent: 0,
            send_total,
            received: Vec::new(),
            recv_total,
            close_after_send: false,
            closed: false,
        }
    }

    /// Drives the socket; returns true when both directions are done.
    fn step(&mut self, s: &mut tcp::Socket<'static>) -> bool {
        while self.sent < self.send_total && s.can_send() {
            let chunk = (self.send_total - self.sent).min(64 * 1024);
            let n = s.send_slice(&pattern(self.sent, chunk)).unwrap();
            if n == 0 {
                break;
            }
            self.sent += n;
        }
        if self.sent == self.send_total && self.close_after_send && !self.closed {
            s.close();
            self.closed = true;
        }
        let mut buf = [0u8; 65536];
        while s.can_recv() {
            let n = s.recv_slice(&mut buf).unwrap();
            let off = self.received.len();
            assert_eq!(&buf[..n], &pattern(off, n)[..], "data mismatch at {off}");
            self.received.extend_from_slice(&buf[..n]);
        }
        self.sent == self.send_total && self.received.len() >= self.recv_total
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn echo_small_with_meta_and_cleanup() {
    let (mut h, mut flows) = channel_harness(NetConfig::default());
    let mut guest = Guest::new(&mut h);
    let s = guest.connect_established(REMOTE, 80, 64 * 1024).await;
    let flow = next_flow(&mut flows, &mut guest).await;
    assert_eq!(flow.meta.dst, SocketAddr::from((REMOTE, 80)));
    assert_eq!(flow.meta.src, SocketAddr::from((GUEST_IP, 40000)));
    assert_eq!(flow.meta.synthetic_hostname, None);
    assert_eq!(flow.meta.id, 1);

    let host = tokio::spawn(async move {
        let mut stream = flow.stream;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        stream.write_all(&buf).await.unwrap();
        stream.shutdown().await.unwrap();
        buf
    });

    let mut xfer = Transfer::new(5, 5);
    xfer.close_after_send = true;
    guest
        .run_until(T, |g| {
            let s = g.tcp(s);
            let done = xfer.step(s);
            (done && !s.may_recv()).then_some(())
        })
        .await;
    assert_eq!(host.await.unwrap(), pattern(0, 5));
    assert_eq!(xfer.received, pattern(0, 5));

    // Both sides closed: the stack forgets the socket.
    guest
        .run_until(T, |g| {
            let _ = g.tcp(s);
            (h.stack.stats().tcp_sockets == 0).then_some(())
        })
        .await;
    assert_eq!(h.stack.stats().tcp_flows, 0);
}

async fn bulk_echo(total: usize) {
    let mut h = start(NetConfig::default(), Arc::new(EchoHandler));
    let mut guest = Guest::new(&mut h);
    let s = guest.connect_established(REMOTE, 443, 512 * 1024).await;
    let mut xfer = Transfer::new(total, total);
    guest.run_until(T * 3, |g| xfer.step(g.tcp(s)).then_some(())).await;
    assert_eq!(xfer.received.len(), total);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bulk_echo_both_directions() {
    bulk_echo(if cfg!(debug_assertions) { 4 << 20 } else { 64 << 20 }).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guest_to_host_backpressure_is_bounded_by_window() {
    let limits = NetLimits { tcp_rx_buffer_bytes: 64 * 1024, ..NetLimits::default() };
    let (mut h, mut flows) = channel_harness(NetConfig { limits, ..NetConfig::default() });
    let mut guest = Guest::new(&mut h);
    let guest_buf = 128 * 1024;
    let s = guest.connect_established(REMOTE, 80, guest_buf).await;
    let flow = next_flow(&mut flows, &mut guest).await;

    // The handler does not read: the guest can only get its own buffer plus our
    // window out, and then stalls.
    let total = 4 << 20;
    let mut xfer = Transfer::new(total, 0);
    let start = Instant::now();
    guest
        .run_until(T, |g| {
            xfer.step(g.tcp(s));
            (start.elapsed() > Duration::from_millis(500)).then_some(())
        })
        .await;
    let in_flight = xfer.sent - guest.tcp(s).send_queue();
    assert!(xfer.sent <= guest_buf + 64 * 1024 + 4096, "sent {}", xfer.sent);
    assert!(in_flight <= 64 * 1024, "accepted by host {in_flight}");
    assert!(in_flight >= 32 * 1024, "window should have been used ({in_flight})");

    // Now drain: everything arrives intact.
    let reader = tokio::spawn(async move {
        let mut stream = flow.stream;
        let mut got = 0usize;
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            assert_eq!(&buf[..n], &pattern(got, n)[..]);
            got += n;
        }
        got
    });
    xfer.close_after_send = true;
    guest.run_until(T, |g| xfer.step(g.tcp(s)).then_some(())).await;
    let got_task = reader;
    let mut got = None;
    let fut = Box::pin(got_task);
    guest
        .run_until(T, |_| {
            if fut.is_finished() {
                got = Some(());
            }
            got
        })
        .await;
    assert_eq!(fut.await.unwrap(), total);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_to_guest_backpressure_blocks_writer() {
    let limits = NetLimits { tcp_tx_buffer_bytes: 64 * 1024, ..NetLimits::default() };
    let (mut h, mut flows) = channel_harness(NetConfig { limits, ..NetConfig::default() });
    let mut guest = Guest::new(&mut h);
    let guest_buf = 128 * 1024;
    let s = guest.connect_established(REMOTE, 80, guest_buf).await;
    let flow = next_flow(&mut flows, &mut guest).await;

    let total = 8 << 20;
    let written = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let w = written.clone();
    let writer = tokio::spawn(async move {
        let mut stream = flow.stream;
        let mut off = 0;
        while off < total {
            let chunk = pattern(off, 16 * 1024);
            stream.write_all(&chunk).await.unwrap();
            off += chunk.len();
            w.store(off, std::sync::atomic::Ordering::SeqCst);
        }
        stream.shutdown().await.unwrap();
    });

    // Guest doesn't read: the writer stalls at about our buffer + guest window.
    guest.idle(Duration::from_millis(500)).await;
    let stalled = written.load(std::sync::atomic::Ordering::SeqCst);
    assert!(stalled <= 64 * 1024 + guest_buf + 16 * 1024, "writer got {stalled} bytes out");
    assert!(h.stack.stats().tx_queued_bytes < 64 * 1024);
    assert!(!writer.is_finished());

    let mut xfer = Transfer::new(0, total);
    guest
        .run_until(T, |g| {
            let s = g.tcp(s);
            (xfer.step(s) && !s.may_recv()).then_some(())
        })
        .await;
    assert_eq!(xfer.received.len(), total);
    writer.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn half_close_from_host_keeps_guest_sending() {
    let (mut h, mut flows) = channel_harness(NetConfig::default());
    let mut guest = Guest::new(&mut h);
    let s = guest.connect_established(REMOTE, 80, 64 * 1024).await;
    let flow = next_flow(&mut flows, &mut guest).await;
    let host = tokio::spawn(async move {
        let mut stream = flow.stream;
        stream.write_all(&pattern(0, 1000)).await.unwrap();
        stream.shutdown().await.unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        buf
    });
    // Guest sees EOF, then still sends and closes.
    let mut xfer = Transfer::new(0, 1000);
    guest
        .run_until(T, |g| {
            let s = g.tcp(s);
            (xfer.step(s) && s.state() == tcp::State::CloseWait).then_some(())
        })
        .await;
    let mut xfer2 = Transfer::new(3000, 0);
    xfer2.close_after_send = true;
    guest.run_until(T, |g| xfer2.step(g.tcp(s)).then_some(())).await;
    let mut done = None;
    guest
        .run_until(T, |_| {
            if host.is_finished() {
                done = Some(());
            }
            done
        })
        .await;
    assert_eq!(host.await.unwrap(), pattern(0, 3000));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abort_sends_rst_to_guest() {
    let (mut h, mut flows) = channel_harness(NetConfig::default());
    let mut guest = Guest::new(&mut h);
    let s = guest.connect_established(REMOTE, 80, 64 * 1024).await;
    let flow = next_flow(&mut flows, &mut guest).await;
    let control = flow.control.clone();
    let (mut rd, _wr) = tokio::io::split(flow.stream);
    let reader = tokio::spawn(async move {
        let mut buf = [0u8; 16];
        rd.read(&mut buf).await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    control.abort();
    guest.run_until(T, |g| (g.tcp(s).state() == tcp::State::Closed).then_some(())).await;
    let err = reader.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), ErrorKind::ConnectionAborted);
    control.abort(); // idempotent
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guest_rst_fails_host_reads_and_writes() {
    let (mut h, mut flows) = channel_harness(NetConfig::default());
    let mut guest = Guest::new(&mut h);
    let s = guest.connect_established(REMOTE, 80, 64 * 1024).await;
    let flow = next_flow(&mut flows, &mut guest).await;
    let host = tokio::spawn(async move {
        let mut stream = flow.stream;
        let mut buf = [0u8; 16];
        let read = stream.read(&mut buf).await;
        let write = stream.write(b"late").await;
        (read, write)
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    guest.tcp(s).abort();
    let mut done = None;
    guest
        .run_until(T, |_| {
            if host.is_finished() {
                done = Some(());
            }
            done
        })
        .await;
    let (read, write) = host.await.unwrap();
    assert_eq!(read.unwrap_err().kind(), ErrorKind::ConnectionReset);
    assert_eq!(write.unwrap_err().kind(), ErrorKind::ConnectionReset);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_flow_with_unread_data_resets() {
    let (mut h, mut flows) = channel_harness(NetConfig::default());
    let mut guest = Guest::new(&mut h);
    let s = guest.connect_established(REMOTE, 80, 64 * 1024).await;
    let flow = next_flow(&mut flows, &mut guest).await;
    let mut xfer = Transfer::new(100, 0);
    guest
        .run_until(T, |g| {
            xfer.step(g.tcp(s));
            (g.tcp(s).send_queue() == 0 && xfer.sent == 100).then_some(())
        })
        .await;
    drop(flow);
    guest.run_until(T, |g| (g.tcp(s).state() == tcp::State::Closed).then_some(())).await;
    guest.run_until(T, |_| (h.stack.stats().tcp_sockets == 0).then_some(())).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn per_host_mapping_sets_synthetic_hostname() {
    let config = NetConfig {
        dns: DnsConfig {
            synthetic_host_mapping: SyntheticHostMapping::PerHost,
            ..DnsConfig::default()
        },
        ..NetConfig::default()
    };
    let (mut h, mut flows) = channel_harness(config);
    let ip = h.stack.synthetic_hosts().allocate("git.example.com").unwrap();
    let mut guest = Guest::new(&mut h);
    guest.connect_established(ip, 22, 16 * 1024).await;
    let flow = next_flow(&mut flows, &mut guest).await;
    assert_eq!(flow.meta.synthetic_hostname.as_deref(), Some("git.example.com"));
    assert_eq!(flow.meta.dst, SocketAddr::from((ip, 22)));
    // Unmapped destinations carry no hostname.
    guest.connect_established(REMOTE, 22, 16 * 1024).await;
    let flow = next_flow(&mut flows, &mut guest).await;
    assert_eq!(flow.meta.synthetic_hostname, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flow_limit_rejects_extra_connections() {
    let config = NetConfig {
        limits: NetLimits { max_tcp_flows: 2, ..NetLimits::default() },
        ..NetConfig::default()
    };
    let (mut h, mut flows) = channel_harness(config);
    let mut guest = Guest::new(&mut h);
    let first = guest.connect_established(REMOTE, 80, 16 * 1024).await;
    guest.connect_established(REMOTE, 81, 16 * 1024).await;
    let third = guest.connect(REMOTE, 82, 16 * 1024);
    guest.run_until(T, |g| (g.tcp(third).state() == tcp::State::Closed).then_some(())).await;
    let a = next_flow(&mut flows, &mut guest).await;
    let b = next_flow(&mut flows, &mut guest).await;
    // handler tasks may deliver the flows in either order
    let (a, _b) = if a.meta.dst.port() == 80 { (a, b) } else { (b, a) };
    // Closing one (both sides) frees a slot.
    drop(a);
    guest.run_until(T, |g| (g.tcp(first).state() == tcp::State::CloseWait).then_some(())).await;
    guest.tcp(first).close();
    guest.run_until(T, |_| (h.stack.stats().tcp_sockets == 1).then_some(())).await;
    guest.connect_established(REMOTE, 83, 16 * 1024).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_concurrent_echo_flows() {
    concurrent_echo_flows(NetConfig::default()).await;
}

/// Same with a tiny QEMU queue: most polls happen over the soft cap.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_concurrent_echo_flows_tight_queue() {
    let mut config = NetConfig::default();
    config.limits.tx_queue_soft_bytes = 8 * 1024;
    concurrent_echo_flows(config).await;
}

async fn concurrent_echo_flows(config: NetConfig) {
    let mut h = start(config, Arc::new(EchoHandler));
    let mut guest = Guest::new(&mut h);
    let n = 40;
    let size = 256 * 1024;
    let mut conns: Vec<_> = (0..n)
        .map(|i| {
            let mut x = Transfer::new(size, size);
            x.close_after_send = true;
            (guest.connect(REMOTE, 1000 + i as u16, 64 * 1024), x)
        })
        .collect();
    guest
        .run_until(T * 2, |g| {
            let mut all = true;
            for (s, x) in conns.iter_mut() {
                let sock = g.tcp(*s);
                if sock.state() == tcp::State::SynSent {
                    all = false;
                    continue;
                }
                let done = x.step(sock) && !sock.may_recv();
                all &= done;
            }
            all.then_some(())
        })
        .await;
    for (_, x) in &conns {
        assert_eq!(x.received.len(), size);
    }
    guest.run_until(T, |_| (h.stack.stats().tcp_sockets == 0).then_some(())).await;
}

async fn measure(label: &str, total: usize, upload: bool, download: bool) {
    let mut h =
        start(NetConfig::default(), Arc::new(BenchHandler { download: download.then_some(total) }));
    let mut guest = Guest::new(&mut h);
    let s = guest.connect_established(REMOTE, 80, 1 << 20).await;
    let mut xfer = Transfer::new(if upload { total } else { 0 }, if download { total } else { 0 });
    xfer.close_after_send = upload && !download;
    let start = Instant::now();
    guest
        .run_until(Duration::from_secs(120), |g| {
            let s = g.tcp(s);
            let done = xfer.step(s);
            (done && (!upload || s.send_queue() == 0)).then_some(())
        })
        .await;
    let secs = start.elapsed().as_secs_f64();
    let bytes = if upload { total } else { 0 } + if download { total } else { 0 };
    println!(
        "{label}: {} MiB in {:.2}s = {:.1} MB/s",
        bytes >> 20,
        secs,
        bytes as f64 / secs / 1e6
    );
}

/// Sinks uploads and sources `download` bytes.
struct BenchHandler {
    download: Option<usize>,
}

impl gondolin_netstack::FlowHandler for BenchHandler {
    fn handle_tcp(&self, flow: TcpFlow) -> gondolin_netstack::BoxFuture<'_, ()> {
        Box::pin(async move {
            let (mut rd, mut wr) = tokio::io::split(flow.stream);
            let download = self.download;
            let sink = tokio::spawn(async move {
                let mut buf = vec![0u8; 256 * 1024];
                while rd.read(&mut buf).await.map(|n| n > 0).unwrap_or(false) {}
            });
            if let Some(total) = download {
                let mut off = 0;
                while off < total {
                    let chunk = pattern(off, 251 * 256);
                    if wr.write_all(&chunk).await.is_err() {
                        break;
                    }
                    off += chunk.len();
                }
            }
            let _ = sink.await;
        })
    }
}

/// `cargo test --release -p gondolin-netstack --test tcp -- --ignored --nocapture throughput`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn throughput() {
    let total = 512 << 20;
    measure("guest->host", total, true, false).await;
    measure("host->guest", total - total % (251 * 256), false, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_connections_do_not_spin() {
    let (mut h, mut flows) = channel_harness(NetConfig::default());
    let mut guest = Guest::new(&mut h);
    let s = guest.connect_established(REMOTE, 80, 64 * 1024).await;
    let flow = next_flow(&mut flows, &mut guest).await;
    let mut xfer = Transfer::new(1000, 0);
    guest.run_until(T, |g| xfer.step(g.tcp(s)).then_some(())).await;
    guest.idle(Duration::from_millis(100)).await;
    let before = h.stack.stats().polls;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let polls = h.stack.stats().polls - before;
    assert!(polls < 10, "{polls} polls while idle");
    drop(flow);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serve_end_aborts_flows_and_allows_restart() {
    let (mut h, mut flows) = channel_harness(NetConfig::default());
    let mut guest = Guest::new(&mut h);
    guest.connect_established(REMOTE, 80, 16 * 1024).await;
    let flow = next_flow(&mut flows, &mut guest).await;
    let (mut rd, mut wr) = tokio::io::split(flow.stream);
    let pending_read = tokio::spawn(async move {
        let mut buf = [0u8; 8];
        rd.read(&mut buf).await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    // QEMU goes away.
    h.serve.abort();
    let _ = (&mut h.serve).await;
    let err = pending_read.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), ErrorKind::ConnectionAborted);
    assert_eq!(wr.write(b"x").await.unwrap_err().kind(), ErrorKind::ConnectionAborted);
    drop(wr);

    // A new connection gets a fresh session.
    let (guest_end, host_end) = tokio::io::duplex(1 << 20);
    let stack = h.stack.clone();
    let _serve = tokio::spawn(async move { stack.serve(host_end).await });
    h.pipe = Some(guest_end);
    let mut guest = Guest::new(&mut h);
    guest.connect_established(REMOTE, 80, 16 * 1024).await;
    let flow = next_flow(&mut flows, &mut guest).await;
    assert_eq!(h.stack.stats().tcp_flows, 1);
    assert_eq!(flow.meta.id, 2, "flow ids stay unique across sessions");
    drop(flow);
}
