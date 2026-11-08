//! Throwaway measurements for `native/docs/runtime-without-tokio.md`.
//!
//! - `idle-threads N STACK_KIB TOUCH_KIB`: RSS and spawn cost of N threads
//!   blocked in `read()` (an idle flow), each having touched TOUCH_KIB of stack
//! - `idle-tasks N WORKERS`: RSS of N tokio tasks awaiting a socket read
//! - `relay MODE FLOWS MIB [CHUNK_KIB]`: CPU and wall time of relaying MIB per
//!   flow between two socketpairs (the shape of a proxied flow), MODE one of
//!   `threads`, `tokio-mt`, `tokio-ct`, `poll`. Sources and sinks run in a
//!   forked child, so the parent's rusage is the relay alone.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::Instant;

fn rss_kib() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

fn cpu_s() -> (f64, f64) {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    let t = |tv: libc::timeval| tv.tv_sec as f64 + tv.tv_usec as f64 / 1e6;
    (t(ru.ru_utime), t(ru.ru_stime))
}

#[inline(never)]
fn touch_stack(kib: usize) {
    if kib == 0 {
        return;
    }
    let mut buf = [0u8; 1024];
    std::hint::black_box(&mut buf);
    touch_stack(kib - 1);
    std::hint::black_box(&buf);
}

fn idle_threads(n: usize, stack_kib: usize, touch_kib: usize) {
    let base = rss_kib();
    let mut keep = Vec::new();
    let mut handles = Vec::new();
    let t0 = Instant::now();
    for _ in 0..n {
        let (a, mut b) = UnixStream::pair().unwrap();
        keep.push(a);
        let h = std::thread::Builder::new()
            .stack_size(stack_kib * 1024)
            .spawn(move || {
                touch_stack(touch_kib);
                let mut byte = [0u8; 1];
                let _ = b.read(&mut byte);
            })
            .unwrap();
        handles.push(h);
    }
    let spawn = t0.elapsed();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let rss = rss_kib();
    let t1 = Instant::now();
    drop(keep);
    for h in handles {
        h.join().unwrap();
    }
    println!(
        "idle-threads n={n} stack={stack_kib}KiB touch={touch_kib}KiB: rss +{} KiB ({:.1} KiB/thread), spawn {:.1} us/thread, teardown {:.1} us/thread",
        rss - base,
        (rss - base) as f64 / n as f64,
        spawn.as_secs_f64() * 1e6 / n as f64,
        t1.elapsed().as_secs_f64() * 1e6 / n as f64
    );
}

fn idle_tasks(n: usize, workers: usize) {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .enable_all()
        .build()
        .unwrap();
    // warm the runtime up before the baseline
    rt.block_on(async { tokio::task::yield_now().await });
    std::thread::sleep(std::time::Duration::from_millis(100));
    let base = rss_kib();
    let mut keep = Vec::new();
    let t0 = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..n {
        let (a, b) = UnixStream::pair().unwrap();
        b.set_nonblocking(true).unwrap();
        keep.push(a);
        let _g = rt.enter();
        let mut b = tokio::net::UnixStream::from_std(b).unwrap();
        handles.push(rt.spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut byte = [0u8; 1];
            let _ = b.read(&mut byte).await;
        }));
    }
    let spawn = t0.elapsed();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let rss = rss_kib();
    drop(keep);
    rt.block_on(async {
        for h in handles {
            h.await.unwrap();
        }
    });
    println!(
        "idle-tasks n={n} workers={workers}: rss +{} KiB ({:.2} KiB/task), spawn {:.2} us/task",
        rss - base,
        (rss - base) as f64 / n as f64,
        spawn.as_secs_f64() * 1e6 / n as f64
    );
}

struct Flow {
    /// relay reads guest-side data here
    input: UnixStream,
    /// relay writes it on here
    output: UnixStream,
}

fn relay(mode: &str, flows: usize, mib: usize, chunk_kib: usize) {
    let chunk = chunk_kib * 1024;
    let mut relay_side = Vec::new();
    let mut child_side = Vec::new();
    for _ in 0..flows {
        let (src, input) = UnixStream::pair().unwrap();
        let (output, sink) = UnixStream::pair().unwrap();
        relay_side.push(Flow { input, output });
        child_side.push((src, sink));
    }
    // fork before any thread exists (the tokio runtime is built afterwards)
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        drop(relay_side);
        let total = mib * 1024 * 1024;
        let mut hs = Vec::new();
        for (mut src, mut sink) in child_side {
            hs.push(std::thread::spawn(move || {
                let buf = vec![0x5au8; chunk];
                let mut left = total;
                while left > 0 {
                    let n = left.min(chunk);
                    src.write_all(&buf[..n]).unwrap();
                    left -= n;
                }
                src.shutdown(std::net::Shutdown::Write).unwrap();
            }));
            hs.push(std::thread::spawn(move || {
                let mut buf = vec![0u8; chunk];
                let mut got = 0usize;
                loop {
                    let n = sink.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    got += n;
                }
                assert_eq!(got, total);
            }));
        }
        for h in hs {
            h.join().unwrap();
        }
        unsafe { libc::_exit(0) };
    }
    drop(child_side);
    let (u0, s0) = cpu_s();
    let t0 = Instant::now();
    match mode {
        "threads" => relay_threads(relay_side, chunk),
        "tokio-mt" => relay_tokio(relay_side, chunk, true),
        "tokio-ct" => relay_tokio(relay_side, chunk, false),
        "poll" => relay_poll(relay_side, chunk),
        other => panic!("unknown mode {other}"),
    }
    let wall = t0.elapsed().as_secs_f64();
    let (u1, s1) = cpu_s();
    let mut status = 0;
    unsafe { libc::waitpid(pid, &mut status, 0) };
    assert_eq!(status, 0, "child failed");
    let gib = (flows * mib) as f64 / 1024.0;
    println!(
        "relay {mode:9} flows={flows:4} chunk={chunk_kib}KiB: {:6.2} GiB/s wall, relay cpu {:.3} s/GiB (user {:.3} sys {:.3})",
        gib / wall,
        (u1 - u0 + s1 - s0) / gib,
        (u1 - u0) / gib,
        (s1 - s0) / gib
    );
}

fn relay_threads(flows: Vec<Flow>, chunk: usize) {
    let hs: Vec<_> = flows
        .into_iter()
        .map(|mut f| {
            std::thread::Builder::new()
                .stack_size(64 * 1024)
                .spawn(move || {
                    let mut buf = vec![0u8; chunk];
                    loop {
                        let n = f.input.read(&mut buf).unwrap();
                        if n == 0 {
                            break;
                        }
                        f.output.write_all(&buf[..n]).unwrap();
                    }
                    f.output.shutdown(std::net::Shutdown::Write).unwrap();
                })
                .unwrap()
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
}

fn relay_tokio(flows: Vec<Flow>, chunk: usize, multi: bool) {
    let rt = if multi {
        tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()
    } else {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    };
    rt.block_on(async move {
        let mut hs = Vec::new();
        for f in flows {
            f.input.set_nonblocking(true).unwrap();
            f.output.set_nonblocking(true).unwrap();
            let mut input = tokio::net::UnixStream::from_std(f.input).unwrap();
            let mut output = tokio::net::UnixStream::from_std(f.output).unwrap();
            hs.push(tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; chunk];
                loop {
                    let n = input.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    output.write_all(&buf[..n]).await.unwrap();
                }
                output.shutdown().await.unwrap();
            }));
        }
        for h in hs {
            h.await.unwrap();
        }
    });
}

/// One thread, nonblocking fds, `poll(2)` readiness: the shape of a sans-io
/// event loop (a real one would use kqueue/epoll instead of rebuilding the
/// pollfd array).
fn relay_poll(flows: Vec<Flow>, chunk: usize) {
    struct St {
        input: UnixStream,
        output: Option<UnixStream>,
        buf: Vec<u8>,
        start: usize,
        end: usize,
        eof: bool,
    }
    let mut st: Vec<St> = flows
        .into_iter()
        .map(|f| {
            f.input.set_nonblocking(true).unwrap();
            f.output.set_nonblocking(true).unwrap();
            St {
                input: f.input,
                output: Some(f.output),
                buf: vec![0u8; chunk],
                start: 0,
                end: 0,
                eof: false,
            }
        })
        .collect();
    let mut pfds: Vec<libc::pollfd> = Vec::new();
    let mut idx: Vec<(usize, bool)> = Vec::new();
    loop {
        pfds.clear();
        idx.clear();
        for (i, s) in st.iter().enumerate() {
            let Some(out) = &s.output else { continue };
            if s.start < s.end {
                pfds.push(libc::pollfd { fd: out.as_raw_fd(), events: libc::POLLOUT, revents: 0 });
                idx.push((i, true));
            } else if !s.eof {
                pfds.push(libc::pollfd {
                    fd: s.input.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                });
                idx.push((i, false));
            }
        }
        if pfds.is_empty() {
            break;
        }
        let r = unsafe { libc::poll(pfds.as_mut_ptr(), pfds.len() as _, -1) };
        assert!(r >= 0);
        for (p, &(i, is_out)) in pfds.iter().zip(idx.iter()) {
            if p.revents == 0 {
                continue;
            }
            let s = &mut st[i];
            if !is_out {
                match s.input.read(&mut s.buf) {
                    Ok(0) => s.eof = true,
                    Ok(n) => {
                        s.start = 0;
                        s.end = n;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(e) => panic!("{e}"),
                }
            }
            // write what we have right away (usually succeeds without a second poll)
            while s.start < s.end {
                match s.output.as_mut().unwrap().write(&s.buf[s.start..s.end]) {
                    Ok(n) => s.start += n,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) => panic!("{e}"),
                }
            }
            if s.eof && s.start == s.end {
                let out = s.output.take().unwrap();
                out.shutdown(std::net::Shutdown::Write).unwrap();
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let num = |i: usize, d: usize| args.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
    match args.first().map(String::as_str) {
        Some("idle-threads") => idle_threads(num(1, 1024), num(2, 256), num(3, 32)),
        Some("idle-tasks") => idle_tasks(num(1, 1024), num(2, 4)),
        Some("relay") => relay(&args[1], num(2, 1), num(3, 1024), num(4, 64)),
        _ => {
            eprintln!(
                "usage: idle-threads N STACK_KIB TOUCH_KIB | idle-tasks N WORKERS | relay MODE FLOWS MIB [CHUNK_KIB]"
            );
            std::process::exit(2);
        }
    }
}
