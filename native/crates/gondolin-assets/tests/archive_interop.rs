//! The archive reader against archives written by the system `tar`/`gzip`
//! (GNU tar on Linux, bsdtar on macOS) and by the `tar`/`flate2` crates.

use std::path::Path;
use std::process::Command;

use gondolin_assets::archive::{gzip::GzipReader, tar};

fn have(tool: &str) -> bool {
    Command::new(tool).arg("--version").output().is_ok_and(|o| o.status.success())
}

fn populate(src: &Path) -> Vec<(String, Vec<u8>)> {
    let long_dir = "d".repeat(90);
    let long_name = format!("{long_dir}/{}", "f".repeat(140));
    let mut files = vec![
        ("manifest.json".to_string(), b"{\"version\":1}".to_vec()),
        ("bin/tool".to_string(), (0..300_000u32).map(|i| (i * 31 % 253) as u8).collect()),
        ("empty".to_string(), Vec::new()),
        (long_name, b"long".to_vec()),
    ];
    files.push(("unicode-\u{e9}.txt".to_string(), b"utf8".to_vec()));
    for (name, data) in &files {
        let path = src.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, data).unwrap();
    }
    std::os::unix::fs::symlink("tool", src.join("bin/alias")).unwrap();
    std::fs::create_dir(src.join("emptydir")).unwrap();
    files
}

fn check(dest: &Path, files: &[(String, Vec<u8>)]) {
    for (name, data) in files {
        let got = std::fs::read(dest.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(&got, data, "{name}");
    }
    assert_eq!(std::fs::read_link(dest.join("bin/alias")).unwrap(), Path::new("tool"));
    assert!(dest.join("emptydir").is_dir());
}

#[test]
fn system_tar_formats() {
    if !have("tar") {
        eprintln!("skipping: no system tar");
        return;
    }
    let src = tempfile::tempdir().unwrap();
    let files = populate(src.path());
    let version =
        String::from_utf8_lossy(&Command::new("tar").arg("--version").output().unwrap().stdout)
            .into_owned();
    let gnu = version.contains("GNU");
    if !gnu && !version.contains("bsdtar") {
        // busybox tar has no --format
        eprintln!("skipping: tar is neither GNU tar nor bsdtar ({})", version.trim());
        return;
    }
    let formats: &[&str] =
        if gnu { &["gnu", "posix", "ustar"] } else { &["gnutar", "pax", "ustar"] };
    for format in formats {
        let out = tempfile::tempdir().unwrap();
        let archive = out.path().join("a.tar.gz");
        let status = Command::new("tar")
            .env("COPYFILE_DISABLE", "1")
            .arg(format!("--format={format}"))
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(src.path())
            .arg(".")
            .output()
            .unwrap();
        if !status.status.success() {
            // ustar cannot store the long name: the writer refuses
            let stderr = String::from_utf8_lossy(&status.stderr);
            assert_eq!(*format, "ustar", "{format}: {stderr}");
            continue;
        }
        let dest = out.path().join("x");
        std::fs::create_dir(&dest).unwrap();
        let reader = GzipReader::new(std::fs::File::open(&archive).unwrap());
        tar::extract(reader, &dest, tar::Limits::default())
            .unwrap_or_else(|e| panic!("{format}: {e}"));
        // ustar cannot store a 140-byte file name (writers skip or fail)
        let expected: Vec<_> =
            files.iter().filter(|(n, _)| *format != "ustar" || n.len() < 200).cloned().collect();
        check(&dest, &expected);
    }
}

#[test]
fn system_gzip_multi_member() {
    if !have("gzip") {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut joined = Vec::new();
    let mut expected = Vec::new();
    for (i, level) in ["-1", "-9"].iter().enumerate() {
        let path = dir.path().join(format!("p{i}"));
        let data: Vec<u8> = format!("part {i} ").repeat(20_000).into_bytes();
        std::fs::write(&path, &data).unwrap();
        assert!(Command::new("gzip").arg(level).arg(&path).status().unwrap().success());
        joined.extend(std::fs::read(dir.path().join(format!("p{i}.gz"))).unwrap());
        expected.extend(data);
    }
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut GzipReader::new(&joined[..]), &mut out).unwrap();
    assert_eq!(out, expected);
}

#[test]
fn tar_crate_writer() {
    // what the image tooling in tests (and older releases) wrote
    let mut builder =
        ::tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best()));
    let long = format!("x/{}", "y".repeat(200));
    let mut header = ::tar::Header::new_gnu();
    header.set_size(4);
    header.set_mode(0o755);
    builder.append_data(&mut header, &long, &b"data"[..]).unwrap();
    let mut header = ::tar::Header::new_ustar();
    header.set_size(2);
    header.set_mode(0o644);
    builder.append_data(&mut header, "plain", &b"ok"[..]).unwrap();
    let bytes = builder.into_inner().unwrap().finish().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let stats =
        tar::extract(GzipReader::new(&bytes[..]), dest.path(), tar::Limits::default()).unwrap();
    assert_eq!(stats.files, 2);
    assert_eq!(std::fs::read(dest.path().join(&long)).unwrap(), b"data");
    assert_eq!(std::fs::read(dest.path().join("plain")).unwrap(), b"ok");
}
