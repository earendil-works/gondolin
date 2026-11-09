//! Interop with QEMU's tools: images we create or modify pass
//! `qemu-img check` and read the same through QEMU, and images QEMU writes
//! (`qemu-img create`, `qemu-io`) parse and read correctly. Skipped when
//! `qemu-img` is not on `PATH` (`qemu-io` tests also need `qemu-io`).

use std::path::{Path, PathBuf};
use std::process::Command;

use gondolin_qcow2::{self as qcow2, Format};

fn tool(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(name)).find(|p| p.is_file())
}

/// Skips the test when a tool is missing, or fails it with
/// `GONDOLIN_REQUIRE_QEMU_IMG=1` (CI: the interop tests must not skip silently).
macro_rules! need {
    ($($name:literal),*) => {
        $(if tool($name).is_none() {
            if std::env::var_os("GONDOLIN_REQUIRE_QEMU_IMG").is_some_and(|v| v == "1") {
                panic!("{} not on PATH (GONDOLIN_REQUIRE_QEMU_IMG=1)", $name);
            }
            eprintln!("skipped: {} not on PATH", $name);
            return;
        })*
    };
}

fn run(cmd: &str, args: &[&str]) -> (i32, String) {
    let out = Command::new(cmd).args(args).output().unwrap();
    let text =
        format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    (out.status.code().unwrap_or(-1), text)
}

fn ok(cmd: &str, args: &[&str]) -> String {
    let (code, text) = run(cmd, args);
    assert_eq!(code, 0, "{cmd} {args:?}: {text}");
    text
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

/// `qemu-img check` exit code 0: no errors, no leaks.
fn check(p: &Path) {
    ok("qemu-img", &["check", "-U", s(p)]);
}

fn qemu_info(p: &Path) -> String {
    ok("qemu-img", &["info", "-U", "--output=json", s(p)])
}

/// A top-level string or integer field of `qemu-img info` JSON.
fn json_field(json: &str, key: &str) -> Option<String> {
    let v = gondolin_wire::json::parse(json).unwrap();
    let f = &v[key];
    f.as_str().map(str::to_string).or_else(|| f.as_integer().map(|n| n.to_string()))
}

fn identical(a: &Path, fa: &str, b: &Path, fb: &str) {
    ok("qemu-img", &["compare", "-U", "-f", fa, "-F", fb, s(a), s(b)]);
}

fn random(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

fn qemu_io(p: &Path, fmt: &str, cmds: &[&str]) {
    let mut args = vec!["-f", fmt];
    for c in cmds {
        args.push("-c");
        args.push(c);
    }
    args.push(s(p));
    let text = ok("qemu-io", &args);
    assert!(!text.contains("error") && !text.contains("failed"), "{text}");
}

fn append_trailer(p: &Path) {
    use std::io::Write;
    let json = b"{\n  \"version\": 1\n}\n";
    let mut f = std::fs::OpenOptions::new().append(true).open(p).unwrap();
    f.write_all(json).unwrap();
    f.write_all(b"GONDCPT1").unwrap();
    f.write_all(&(json.len() as u64).to_be_bytes()).unwrap();
}

#[test]
fn created_overlays_pass_qemu_img_check() {
    need!("qemu-img");
    let dir = tempfile::tempdir().unwrap();
    let raw = dir.path().join("rootfs.ext4");
    std::fs::write(&raw, random(1_000_000, 1)).unwrap();

    let o1 = dir.path().join("o1.qcow2");
    qcow2::create_overlay(&o1, s(&raw), Format::Raw, None).unwrap();
    check(&o1);
    let info = qemu_info(&o1);
    assert_eq!(json_field(&info, "virtual-size").as_deref(), Some("1000448"), "{info}");
    assert_eq!(json_field(&info, "backing-filename").as_deref(), Some(s(&raw)));
    assert_eq!(json_field(&info, "backing-filename-format").as_deref(), Some("raw"));
    identical(&o1, "qcow2", &raw, "raw");

    // relative name, qcow2 backing, explicit size
    let o2 = dir.path().join("o2.qcow2");
    qcow2::create_overlay(&o2, "o1.qcow2", Format::Qcow2, None).unwrap();
    check(&o2);
    assert_eq!(qcow2::virtual_size(&o2, Format::Qcow2).unwrap(), 1_000_448);
    assert_eq!(qcow2::backing_path(&o2).unwrap(), Some(dir.path().join("o1.qcow2")));
    identical(&o2, "qcow2", &raw, "raw");
    let o3 = dir.path().join("o3.qcow2");
    qcow2::create_overlay(&o3, s(&o2), Format::Qcow2, Some(3 << 30)).unwrap();
    check(&o3);
    assert_eq!(json_field(&qemu_info(&o3), "virtual-size").as_deref(), Some("3221225472"));
    // an empty disk has no L1 table (no leaked cluster), and grows
    let empty = dir.path().join("empty.qcow2");
    qcow2::create_overlay(&empty, s(&raw), Format::Raw, Some(0)).unwrap();
    check(&empty);
    qcow2::ensure_min_size(&empty, Format::Qcow2, 1 << 20).unwrap();
    check(&empty);

    // what QEMU writes we read back
    let q = dir.path().join("q.qcow2");
    ok("qemu-img", &["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", s(&o1), s(&q), "2G"]);
    let i = qcow2::info(&q).unwrap();
    assert_eq!(i.format, Format::Qcow2);
    assert_eq!(i.virtual_size, 2 << 30);
    assert_eq!(i.backing_file.as_deref(), Some(s(&o1)));
    assert_eq!(i.backing_format.as_deref(), Some("qcow2"));
    assert_eq!(qcow2::probe(&raw).unwrap(), Format::Raw);
}

#[test]
fn reads_qemu_written_images() {
    need!("qemu-img", "qemu-io");
    let dir = tempfile::tempdir().unwrap();
    let raw = dir.path().join("base.raw");
    std::fs::write(&raw, random(4 << 20, 2)).unwrap();
    for opts in [
        "cluster_size=65536",
        "compat=0.10",
        "cluster_size=512,refcount_bits=1",
        "cluster_size=4096,refcount_bits=64",
        "cluster_size=2M",
    ] {
        let img = dir.path().join("w.qcow2");
        let _ = std::fs::remove_file(&img);
        ok(
            "qemu-img",
            &["create", "-q", "-f", "qcow2", "-o", opts, "-F", "raw", "-b", s(&raw), s(&img)],
        );
        qemu_io(
            &img,
            "qcow2",
            &[
                "write -P 0xab 0 64k",
                "write -z 1M 128k",
                "write -P 0x12 1536k 4k",
                "write -P 0x34 3000k 9k",
                "discard 3M 64k",
            ],
        );
        let expect = dir.path().join("w.raw");
        ok("qemu-img", &["convert", "-O", "raw", s(&img), s(&expect)]);
        // what QEMU writes is safe to attach
        assert_eq!(qcow2::validate_chain(&img, Format::Qcow2).unwrap().len(), 1, "{opts}");
        let mut layers = qcow2::open_layers(&img, Format::Qcow2).unwrap();
        let mut got = vec![0u8; 4 << 20];
        qcow2::read_at(&mut layers, 0, &mut got).unwrap();
        assert!(std::fs::read(&expect).unwrap() == got, "{opts}: content differs");
    }
}

/// Builds base (raw) <- mid1 <- mid2 (checkpoint file with trailer) <- top,
/// returns (top, base, expected raw content of top).
fn chain(dir: &Path, mid_cs: &str, top_cs: &str) -> (PathBuf, PathBuf, PathBuf) {
    let base = dir.join("rootfs.ext4");
    std::fs::write(&base, random(6 << 20, 3)).unwrap();
    let mid1 = dir.join("mid1.qcow2");
    ok(
        "qemu-img",
        &["create", "-q", "-f", "qcow2", "-o", mid_cs, "-F", "raw", "-b", s(&base), s(&mid1)],
    );
    qemu_io(
        &mid1,
        "qcow2",
        &["write -P 0x11 0 1M", "write -z 2M 1M", "write -P 0x13 3M 1M", "write -P 0x22 5000k 3k"],
    );
    let mid2 = dir.join("mid2.qcow2");
    // relative backing name, like a renamed checkpoint
    ok("qemu-img", &["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", "mid1.qcow2", s(&mid2)]);
    qemu_io(
        &mid2,
        "qcow2",
        &["write -P 0x33 512k 1M", "write -z 4M 64k", "write -P 0x44 2100k 4k"],
    );
    append_trailer(&mid2);
    let top = dir.join("top.qcow2");
    ok(
        "qemu-img",
        &["create", "-q", "-f", "qcow2", "-o", top_cs, "-F", "qcow2", "-b", s(&mid2), s(&top)],
    );
    qemu_io(&top, "qcow2", &["write -P 0x55 768k 64k", "write -z 5M 4k"]);
    let expected = dir.join("expected.raw");
    ok("qemu-img", &["convert", "-U", "-O", "raw", s(&top), s(&expected)]);
    (top, base, expected)
}

#[test]
fn rebase_flattens_like_qemu() {
    need!("qemu-img", "qemu-io");
    for (mid_cs, top_cs) in [
        ("cluster_size=65536", "cluster_size=65536"),
        ("cluster_size=4096", "cluster_size=65536"),
        ("cluster_size=65536", "cluster_size=4096"),
        // 64-bit refcounts on 512-byte clusters: the refcount table grows
        ("cluster_size=65536", "cluster_size=512,refcount_bits=64"),
        ("cluster_size=65536", "compat=0.10"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (top, base, expected) = chain(dir.path(), mid_cs, top_cs);
        let mid2 = dir.path().join("mid2.qcow2");
        let before = std::fs::read(&mid2).unwrap();
        let reftable = |p: &Path| std::fs::read(p).unwrap()[48..60].to_vec();
        let reftable_before = reftable(&top);
        qcow2::rebase(&top, &base, Format::Raw).unwrap();
        check(&top);
        if top_cs.contains("refcount_bits=64") {
            assert_ne!(reftable(&top), reftable_before, "refcount table relocated");
        }
        let info = qemu_info(&top);
        assert_eq!(json_field(&info, "backing-filename").as_deref(), Some(s(&base)), "{info}");
        assert_eq!(json_field(&info, "backing-filename-format").as_deref(), Some("raw"));
        identical(&top, "qcow2", &expected, "raw");
        assert!(std::fs::read(&mid2).unwrap() == before, "middle layers are read-only");
    }
}

#[test]
fn rebase_onto_a_middle_layer_and_our_own_overlays() {
    need!("qemu-img", "qemu-io");
    let dir = tempfile::tempdir().unwrap();
    let (top, _, expected) = chain(dir.path(), "cluster_size=65536", "cluster_size=65536");
    let mid1 = dir.path().join("mid1.qcow2");
    qcow2::rebase(&top, &mid1, Format::Qcow2).unwrap();
    check(&top);
    identical(&top, "qcow2", &expected, "raw");
    assert!(qcow2::rebase(&top, Path::new("/nonexistent"), Format::Raw).is_err());
    let other = dir.path().join("other.raw");
    std::fs::write(&other, b"x").unwrap();
    let err = qcow2::rebase(&top, &other, Format::Raw).unwrap_err();
    assert!(err.message.contains("not in the backing chain"), "{err}");

    // the checkpoint flow: overlay (ours) on a checkpoint on the rootfs, grown
    let base = dir.path().join("rootfs.ext4");
    let ckpt = dir.path().join("ckpt.qcow2");
    qcow2::create_overlay(&ckpt, s(&base), Format::Raw, None).unwrap();
    qemu_io(&ckpt, "qcow2", &["write -P 0x66 1M 200k", "write -z 0 64k"]);
    append_trailer(&ckpt);
    let overlay = dir.path().join("overlay.qcow2");
    qcow2::create_overlay(&overlay, s(&ckpt), Format::Qcow2, None).unwrap();
    qcow2::ensure_min_size(&overlay, Format::Qcow2, (8 << 20) + 1).unwrap();
    qemu_io(&overlay, "qcow2", &["write -P 0x77 1100k 4k", "write -P 0x78 7M 64k"]);
    let expected = dir.path().join("expected2.raw");
    ok("qemu-img", &["convert", "-U", "-O", "raw", s(&overlay), s(&expected)]);
    qcow2::rebase(&overlay, &base, Format::Raw).unwrap();
    check(&overlay);
    identical(&overlay, "qcow2", &expected, "raw");
    assert_eq!(qcow2::virtual_size(&overlay, Format::Qcow2).unwrap(), (8 << 20) + 512);

    // a checkpoint file is never allocated into
    let err = qcow2::rebase(&ckpt, &base, Format::Raw).unwrap_err();
    assert!(err.message.contains("checkpoint"), "{err}");
    assert!(qcow2::ensure_min_size(&ckpt, Format::Qcow2, 64 << 20).is_err());
}

/// A file with a long sparse tail: allocation starts past it, so the
/// refcount table must grow to cover far-away clusters, its own included.
#[test]
fn grow_past_a_sparse_tail() {
    need!("qemu-img", "qemu-io");
    let dir = tempfile::tempdir().unwrap();
    let img = dir.path().join("sp.qcow2");
    ok(
        "qemu-img",
        &["create", "-q", "-f", "qcow2", "-o", "cluster_size=512,refcount_bits=64", s(&img), "1M"],
    );
    qemu_io(&img, "qcow2", &["write -P 0x5a 0 64k"]);
    let before = dir.path().join("before.raw");
    ok("qemu-img", &["convert", "-O", "raw", s(&img), s(&before)]);
    std::fs::File::options().write(true).open(&img).unwrap().set_len(8 << 30).unwrap();
    qcow2::resize(&img, Format::Qcow2, 64 << 20).unwrap();
    check(&img);
    ok("qemu-img", &["compare", "-f", "qcow2", "-F", "raw", s(&img), s(&before)]);
    qemu_io(&img, "qcow2", &["write -P 0x6b 60M 64k"]);
    check(&img);
}

#[test]
fn grow_matches_qemu() {
    need!("qemu-img", "qemu-io");
    let dir = tempfile::tempdir().unwrap();
    let ours = dir.path().join("ours.qcow2");
    let base = dir.path().join("base.raw");
    std::fs::write(&base, random(1 << 20, 5)).unwrap();
    qcow2::create_overlay(&ours, s(&base), Format::Raw, Some(1 << 30)).unwrap();
    qcow2::ensure_min_size(&ours, Format::Qcow2, 10 << 30).unwrap();
    check(&ours);
    assert_eq!(json_field(&qemu_info(&ours), "virtual-size").as_deref(), Some("10737418240"));
    // past one L1 cluster (4 TiB): relocated
    qcow2::resize(&ours, Format::Qcow2, (5 << 40) + 4096).unwrap();
    check(&ours);
    assert!(qcow2::resize(&ours, Format::Qcow2, 1 << 30).is_err());
    assert!(qcow2::resize(&ours, Format::Qcow2, (6 << 40) + 1).is_err());

    // QEMU images with small clusters: the L1 table is relocated
    for opts in
        ["cluster_size=512", "cluster_size=512,refcount_bits=1", "compat=0.10,cluster_size=1024"]
    {
        let q = dir.path().join("q.qcow2");
        let _ = std::fs::remove_file(&q);
        ok("qemu-img", &["create", "-q", "-f", "qcow2", "-o", opts, s(&q), "1M"]);
        qemu_io(&q, "qcow2", &["write -P 0x99 0 300k", "write -P 0x98 900k 100k"]);
        let before = dir.path().join("before.raw");
        ok("qemu-img", &["convert", "-O", "raw", s(&q), s(&before)]);
        qcow2::ensure_min_size(&q, Format::Qcow2, 100 << 20).unwrap();
        check(&q);
        assert_eq!(json_field(&qemu_info(&q), "virtual-size").as_deref(), Some("104857600"));
        ok("qemu-img", &["compare", "-f", "qcow2", "-F", "raw", s(&q), s(&before)]);
        qemu_io(&q, "qcow2", &["write -P 0x97 99M 1M"]);
        check(&q);
    }

    let raw = dir.path().join("disk.raw");
    std::fs::write(&raw, b"abc").unwrap();
    qcow2::ensure_min_size(&raw, Format::Raw, 4097).unwrap();
    assert_eq!(std::fs::metadata(&raw).unwrap().len(), 4097);
    assert!(qcow2::resize(&raw, Format::Raw, 10).is_err());
}

#[test]
fn set_backing_like_rebase_unsafe() {
    need!("qemu-img");
    let dir = tempfile::tempdir().unwrap();
    // a long but real backing path (~900 bytes)
    let mut long = dir.path().to_path_buf();
    while long.as_os_str().len() < 850 {
        long = long.join("d".repeat(100));
    }
    std::fs::create_dir_all(&long).unwrap();
    let backing = long.join("rootfs.ext4");
    std::fs::write(&backing, random(1 << 20, 4)).unwrap();

    let img = dir.path().join("ckpt.qcow2");
    ok(
        "qemu-img",
        &[
            "create",
            "-q",
            "-u",
            "-f",
            "qcow2",
            "-F",
            "raw",
            "-b",
            "/old/rootfs.ext4",
            s(&img),
            "1M",
        ],
    );
    append_trailer(&img);
    let len = std::fs::metadata(&img).unwrap().len();
    qcow2::set_backing(&img, Some((s(&backing), Format::Raw))).unwrap();
    check(&img);
    let info = qemu_info(&img);
    assert_eq!(json_field(&info, "backing-filename").as_deref(), Some(s(&backing)), "{info}");
    assert_eq!(json_field(&info, "backing-filename-format").as_deref(), Some("raw"));
    identical(&img, "qcow2", &backing, "raw");
    assert_eq!(std::fs::metadata(&img).unwrap().len(), len, "the trailer stays in place");
    // shorter again: the old name's bytes are cleared
    std::fs::write(dir.path().join("short.raw"), b"").unwrap();
    qcow2::set_backing(&img, Some(("short.raw", Format::Raw))).unwrap();
    check(&img);
    assert_eq!(json_field(&qemu_info(&img), "backing-filename").as_deref(), Some("short.raw"));
    let head = std::fs::read(&img).unwrap();
    assert!(!head[..65536].windows(10).any(|w| w == b"dddddddddd"));
    qcow2::set_backing(&img, None).unwrap();
    check(&img);
    assert_eq!(json_field(&qemu_info(&img), "backing-filename").as_deref(), None);

    // does not fit into a 512-byte header cluster: refused, image unchanged
    let small = dir.path().join("small.qcow2");
    ok(
        "qemu-img",
        &[
            "create",
            "-q",
            "-u",
            "-f",
            "qcow2",
            "-o",
            "cluster_size=512",
            "-F",
            "raw",
            "-b",
            "/x",
            s(&small),
            "1M",
        ],
    );
    let before = std::fs::read(&small).unwrap();
    let err = qcow2::set_backing(&small, Some((s(&backing), Format::Raw))).unwrap_err();
    assert!(err.message.contains("first cluster"), "{err}");
    assert!(std::fs::read(&small).unwrap() == before);
}
