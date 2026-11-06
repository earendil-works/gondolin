//! Resolution against a fake registry served over local HTTP.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use gondolin_assets::manifest::{Checksums, compute_build_id};
use gondolin_assets::{Arch, Assets, AssetsOptions, ErrorKind, ImageSourceKind, RootfsMode, Store};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn sha256(data: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, data)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A fake image: build id, manifest and `.tar.gz`.
struct FakeImage {
    build_id: String,
    archive: Vec<u8>,
}

fn make_image(
    arch: &str,
    seed: &str,
    tweak: impl FnOnce(&mut serde_json::Value, &mut Vec<(String, Vec<u8>)>),
) -> FakeImage {
    let mut files: Vec<(String, Vec<u8>)> = vec![
        ("vmlinuz-virt".into(), format!("kernel-{seed}").into_bytes()),
        ("initramfs.cpio.lz4".into(), format!("initrd-{seed}").into_bytes()),
        ("rootfs.ext4".into(), vec![seed.as_bytes()[0]; 300_000]),
        ("krun-kernel".into(), format!("krun-{seed}").into_bytes()),
    ];
    let checksums = Checksums {
        kernel: sha256(&files[0].1),
        initramfs: sha256(&files[1].1),
        rootfs: sha256(&files[2].1),
        krun_kernel: Some(sha256(&files[3].1)),
        krun_initrd: None,
    };
    let build_id = compute_build_id(&checksums, Some(arch));
    let mut manifest = serde_json::json!({
        "version": 1,
        "buildId": build_id,
        "config": { "arch": arch, "distro": "alpine" },
        "runtimeDefaults": { "rootfsMode": "memory" },
        "buildTime": "2026-01-01T00:00:00.000Z",
        "assets": { "kernel": "vmlinuz-virt", "initramfs": "initramfs.cpio.lz4", "rootfs": "rootfs.ext4", "krunKernel": "krun-kernel" },
        "checksums": serde_json::to_value(&checksums).unwrap(),
    });
    tweak(&mut manifest, &mut files);
    let build_id = manifest["buildId"].as_str().unwrap().to_string();
    let mut tar =
        tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
    let mut add = |name: &str, data: &[u8]| {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, name, data).unwrap();
    };
    add("manifest.json", serde_json::to_string_pretty(&manifest).unwrap().as_bytes());
    for (name, data) in &files {
        add(name, data);
    }
    let archive = tar.into_inner().unwrap().finish().unwrap();
    FakeImage { build_id, archive }
}

/// Response body and optional ETag.
type Route = (Vec<u8>, Option<String>);

/// Minimal HTTP/1.1 server: path → route.
#[derive(Clone, Default)]
struct Server {
    routes: Arc<Mutex<HashMap<String, Route>>>,
    hits: Arc<Mutex<HashMap<String, usize>>>,
    not_modified: Arc<AtomicUsize>,
}

impl Server {
    fn set(&self, path: &str, body: Vec<u8>, etag: Option<&str>) {
        self.routes.lock().unwrap().insert(path.to_string(), (body, etag.map(str::to_string)));
    }

    fn hits(&self, path: &str) -> usize {
        self.hits.lock().unwrap().get(path).copied().unwrap_or(0)
    }

    async fn start(&self) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = self.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let server = server.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let if_none_match = head
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("if-none-match:"))
                        .map(|l| l.split_once(':').unwrap().1.trim().to_string());
                    *server.hits.lock().unwrap().entry(path.clone()).or_default() += 1;
                    let route = server.routes.lock().unwrap().get(&path).cloned();
                    let response = match route {
                        Some((_, Some(etag))) if if_none_match.as_deref() == Some(etag.as_str()) => {
                            server.not_modified.fetch_add(1, Ordering::SeqCst);
                            b"HTTP/1.1 304 Not Modified\r\nconnection: close\r\n\r\n".to_vec()
                        }
                        Some((body, etag)) => {
                            let mut r = format!(
                                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n",
                                body.len()
                            );
                            if let Some(e) = etag {
                                r.push_str(&format!("etag: {e}\r\n"));
                            }
                            r.push_str("\r\n");
                            let mut r = r.into_bytes();
                            r.extend_from_slice(&body);
                            r
                        }
                        None => b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_vec(),
                    };
                    let _ = sock.write_all(&response).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (port, task)
    }
}

fn registry_doc(refs: serde_json::Value, builds: &[(&FakeImage, &str, bool)]) -> Vec<u8> {
    let mut b = serde_json::Map::new();
    for (img, arch, with_sha) in builds {
        let mut entry =
            serde_json::json!({ "url": format!("images/{}.tar.gz", img.build_id), "arch": arch });
        if *with_sha {
            entry["sha256"] = sha256(&img.archive).into();
        }
        b.insert(img.build_id.clone(), entry);
    }
    serde_json::to_vec(&serde_json::json!({ "schema": 1, "refs": refs, "builds": b })).unwrap()
}

fn serve_image(server: &Server, img: &FakeImage) {
    server.set(&format!("/images/{}.tar.gz", img.build_id), img.archive.clone(), None);
}

fn options(store: &Path, port: u16) -> AssetsOptions {
    AssetsOptions {
        store: Store::new(store),
        registry_url: format!("http://127.0.0.1:{port}/registry.json"),
        default_image: "alpine-base:latest".into(),
        guest_dir: None,
        checkout_search: vec![],
        host_arch: Arch::Aarch64,
    }
}

fn leftovers(store: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for dir in [store.to_path_buf(), store.join("objects")] {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with(".tmp") {
                    out.push(n);
                }
            }
        }
    }
    out
}

#[tokio::test]
async fn pulls_ref_installs_object_and_ref_then_resolves_locally() {
    let a = make_image("aarch64", "a", |_, _| {});
    let x = make_image("x86_64", "x", |_, _| {});
    let server = Server::default();
    server.set(
        "/registry.json",
        registry_doc(serde_json::json!({ "alpine-base:latest": { "aarch64": a.build_id, "x86_64": x.build_id } }), &[(&a, "aarch64", true), (&x, "x86_64", true)]),
        Some("\"v1\""),
    );
    serve_image(&server, &a);
    serve_image(&server, &x);
    let (port, _task) = server.start().await;
    let store = tempfile::tempdir().unwrap();
    let assets = Assets::new(options(store.path(), port));

    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = events.clone();
    let progress = move |e| ev.lock().unwrap().push(e);
    let image = assets.resolve("alpine-base", None, Some(&progress)).await.unwrap();
    assert_eq!(image.source, ImageSourceKind::Ref);
    assert_eq!(image.selector, "alpine-base:latest");
    assert_eq!(image.build_id.as_deref(), Some(a.build_id.as_str()));
    assert_eq!(image.arch, Some(Arch::Aarch64));
    let object = store.path().join("objects").join(&a.build_id);
    assert_eq!(image.asset_dir, object);
    assert_eq!(image.kernel, object.join("vmlinuz-virt"));
    assert_eq!(image.rootfs, object.join("rootfs.ext4"));
    assert_eq!(image.krun_kernel, Some(object.join("krun-kernel")));
    assert_eq!(image.rootfs_mode, Some(RootfsMode::Memory));
    // ref symlink, relative like the node engine writes it
    let link = store.path().join("refs/alpine-base/latest/aarch64");
    assert_eq!(
        std::fs::read_link(&link).unwrap(),
        PathBuf::from(format!("../../../objects/{}", a.build_id))
    );
    // registry cache in the node engine's format
    let cache: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(store.path().join("builtin-image-registry-cache.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(cache["etag"], "\"v1\"");
    assert_eq!(cache["url"], format!("http://127.0.0.1:{port}/registry.json"));
    assert_eq!(
        cache["registry"]["builds"][&a.build_id]["url"],
        format!("http://127.0.0.1:{port}/images/{}.tar.gz", a.build_id)
    );
    {
        let events = events.lock().unwrap();
        assert!(
            events.iter().any(|e| matches!(e, gondolin_assets::ProgressEvent::DownloadDone { .. }))
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                gondolin_assets::ProgressEvent::Installed { created: true, .. }
            ))
        );
    }
    assert!(leftovers(store.path()).is_empty(), "{:?}", leftovers(store.path()));

    // Now local: no further requests.
    let before = server.hits("/registry.json");
    let again = assets.resolve("alpine-base:latest", None, None).await.unwrap();
    assert_eq!(again.asset_dir, object);
    assert_eq!(server.hits("/registry.json"), before);

    // A local ref with a single target satisfies any arch (node's fallback);
    // pulling fetches the other arch, and the ref then has both targets.
    let fallback = assets.resolve("alpine-base:latest", Some(Arch::X86_64), None).await.unwrap();
    assert_eq!(fallback.arch, Some(Arch::Aarch64));
    let xi = assets.pull("alpine-base:latest", Some(Arch::X86_64), None).await.unwrap();
    assert_eq!(xi.build_id.as_deref(), Some(x.build_id.as_str()));
    assert_eq!(server.not_modified.load(Ordering::SeqCst), 1, "registry revalidated with etag");
    let refs = assets.store().list_refs();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].targets.len(), 2);

    // Build ids resolve locally now.
    let by_id = assets.resolve_local(&x.build_id, None).unwrap();
    assert_eq!(by_id.source, ImageSourceKind::BuildId);
    assert_eq!(by_id.arch, Some(Arch::X86_64));
}

#[tokio::test]
async fn pull_moves_ref_to_new_build_and_resolve_keeps_local() {
    let old = make_image("aarch64", "o", |_, _| {});
    let new = make_image("aarch64", "n", |_, _| {});
    let server = Server::default();
    let doc = |img: &FakeImage| {
        registry_doc(
            serde_json::json!({ "img:1": { "aarch64": img.build_id } }),
            &[(img, "aarch64", true)],
        )
    };
    server.set("/registry.json", doc(&old), None);
    serve_image(&server, &old);
    serve_image(&server, &new);
    let (port, _task) = server.start().await;
    let store = tempfile::tempdir().unwrap();
    let assets = Assets::new(options(store.path(), port));
    assert_eq!(
        assets.resolve("img:1", None, None).await.unwrap().build_id.as_deref(),
        Some(old.build_id.as_str())
    );

    server.set("/registry.json", doc(&new), None);
    // resolve keeps the local ref (node behavior) ...
    assert_eq!(
        assets.resolve("img:1", None, None).await.unwrap().build_id.as_deref(),
        Some(old.build_id.as_str())
    );
    // ... pull follows the registry
    assert_eq!(
        assets.pull("img:1", None, None).await.unwrap().build_id.as_deref(),
        Some(new.build_id.as_str())
    );
    assert_eq!(
        assets.resolve_local("img:1", None).unwrap().build_id.as_deref(),
        Some(new.build_id.as_str())
    );
    // the old object stays (untagged)
    assert!(store.path().join("objects").join(&old.build_id).exists());
}

#[tokio::test]
async fn bad_archives_are_rejected_without_leftovers() {
    let good = make_image("aarch64", "g", |_, _| {});
    let tampered = make_image("aarch64", "t", |_, files| files[2].1[0] ^= 1);
    let escaping =
        make_image("aarch64", "e", |m, _| m["assets"]["rootfs"] = "../rootfs.ext4".into());
    let wrong_arch = make_image("x86_64", "w", |_, _| {});
    let server = Server::default();
    let mut corrupted = good.archive.clone();
    let mid = corrupted.len() / 2;
    corrupted[mid] ^= 0xff;
    server.set(&format!("/images/{}.tar.gz", good.build_id), corrupted, None);
    serve_image(&server, &tampered);
    serve_image(&server, &escaping);
    serve_image(&server, &wrong_arch);
    server.set(
        "/registry.json",
        registry_doc(
            serde_json::json!({
                "good:1": { "aarch64": good.build_id },
                "tampered:1": { "aarch64": tampered.build_id },
                "escaping:1": { "aarch64": escaping.build_id },
            }),
            &[
                (&good, "aarch64", true),
                (&tampered, "aarch64", false),
                (&escaping, "aarch64", false),
                (&wrong_arch, "x86_64", false),
            ],
        ),
        None,
    );
    let (port, _task) = server.start().await;
    let store = tempfile::tempdir().unwrap();
    let assets = Assets::new(options(store.path(), port));

    let err = assets.resolve("good:1", None, None).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Checksum);
    assert!(
        err.message.starts_with("downloaded image checksum mismatch for http://127.0.0.1:"),
        "{err}"
    );

    let err = assets.resolve("tampered:1", None, None).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Checksum);
    assert!(err.message.contains("image asset checksum mismatch for rootfs"), "{err}");

    let err = assets.resolve("escaping:1", None, None).await.unwrap_err();
    assert!(
        err.message.contains("path escapes image") || err.message.contains("must stay within"),
        "{err}"
    );

    let err = assets.resolve("nope:1", None, None).await.unwrap_err();
    assert_eq!(err.message, "image ref not found in builtin registry: nope:1");

    let err = assets.resolve(&"0".repeat(8), None, None).await.unwrap_err();
    assert!(
        err.message.starts_with("invalid image name")
            || err.message.starts_with("image ref not found"),
        "{err}"
    );

    let missing_id = "11111111-1111-5111-8111-111111111111";
    let err = assets.resolve(missing_id, None, None).await.unwrap_err();
    assert_eq!(
        err.message,
        format!("image build id not found in builtin registry builds metadata: {missing_id}")
    );

    assert!(leftovers(store.path()).is_empty(), "{:?}", leftovers(store.path()));
    assert!(assets.store().object_ids().is_empty());
}

#[tokio::test]
async fn registry_cache_is_used_when_offline() {
    let a = make_image("aarch64", "c", |_, _| {});
    let b = make_image("aarch64", "d", |_, _| {});
    let server = Server::default();
    server.set(
        "/registry.json",
        registry_doc(serde_json::json!({ "a:1": { "aarch64": a.build_id }, "b:1": { "aarch64": b.build_id } }), &[(&a, "aarch64", true), (&b, "aarch64", true)]),
        None,
    );
    serve_image(&server, &a);
    let (port, task) = server.start().await;
    let store = tempfile::tempdir().unwrap();
    let assets = Assets::new(options(store.path(), port));
    assets.resolve("a:1", None, None).await.unwrap();
    task.abort();
    let _ = task.await;
    // Registry unreachable: the cache still resolves b:1 to its source, whose
    // download then fails with a clear error.
    let err = assets.resolve("b:1", None, None).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Network);
    assert!(err.message.starts_with("failed to download image archive"), "{err}");

    let fresh = tempfile::tempdir().unwrap();
    let assets = Assets::new(options(fresh.path(), port));
    let err = assets.resolve("a:1", None, None).await.unwrap_err();
    assert!(
        err.message.starts_with(&format!(
            "failed to fetch builtin image registry from http://127.0.0.1:{port}/registry.json"
        )),
        "{err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_resolves_download_once() {
    let a = make_image("aarch64", "z", |_, _| {});
    let server = Server::default();
    server.set(
        "/registry.json",
        registry_doc(
            serde_json::json!({ "img:1": { "aarch64": a.build_id } }),
            &[(&a, "aarch64", true)],
        ),
        None,
    );
    serve_image(&server, &a);
    let (port, _task) = server.start().await;
    let store = tempfile::tempdir().unwrap();
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let opts = options(store.path(), port);
        tasks.push(tokio::spawn(
            async move { Assets::new(opts).resolve("img:1", None, None).await },
        ));
    }
    for t in tasks {
        let image = t.await.unwrap().unwrap();
        assert_eq!(image.build_id.as_deref(), Some(a.build_id.as_str()));
    }
    assert_eq!(server.hits(&format!("/images/{}.tar.gz", a.build_id)), 1);
    assert!(leftovers(store.path()).is_empty());
}

#[tokio::test]
async fn local_resolution_errors_and_default_image() {
    let a = make_image("x86_64", "l", |_, _| {});
    let server = Server::default();
    server.set(
        "/registry.json",
        registry_doc(
            serde_json::json!({ "alpine-base:latest": { "x86_64": a.build_id } }),
            &[(&a, "x86_64", true)],
        ),
        None,
    );
    serve_image(&server, &a);
    let (port, _task) = server.start().await;
    let store = tempfile::tempdir().unwrap();
    let assets = Assets::new(options(store.path(), port));

    let err = assets.resolve_local("alpine-base:latest", None).unwrap_err();
    assert_eq!(
        (err.kind, err.message.as_str()),
        (ErrorKind::RefNotFound, "image ref not found: alpine-base:latest")
    );
    let err = assets.resolve_local(&a.build_id, None).unwrap_err();
    assert_eq!(err.kind, ErrorKind::ObjectNotFound);
    assert!(assets.resolve_default_local().unwrap().is_none());

    // Host is aarch64 but only x86_64 exists: single-entry fallback.
    let image = assets.resolve_default(None).await.unwrap();
    assert_eq!(image.arch, Some(Arch::X86_64));

    // A second ref with two arches where the requested one is missing.
    let store_ref = assets.store().refs_dir().join("two/latest");
    std::fs::create_dir_all(&store_ref).unwrap();
    std::os::unix::fs::symlink(
        format!("../../../objects/{}", a.build_id),
        store_ref.join("x86_64"),
    )
    .unwrap();
    let image = assets.resolve_local("two", Some(Arch::Aarch64)).unwrap();
    assert_eq!(image.arch, Some(Arch::X86_64), "single target fallback");

    // Default from the store falls back to the other arch too.
    let image = assets.resolve_default_local().unwrap().unwrap();
    assert_eq!(image.asset_dir, store.path().join("objects").join(&a.build_id));

    // GONDOLIN_GUEST_DIR and checkouts take precedence.
    let guest = tempfile::tempdir().unwrap();
    for f in ["vmlinuz-virt", "initramfs.cpio.lz4", "rootfs.ext4"] {
        std::fs::write(guest.path().join(f), b"x").unwrap();
    }
    let mut opts = options(store.path(), port);
    opts.guest_dir = Some(guest.path().to_path_buf());
    let image = Assets::new(opts).resolve_default_local().unwrap().unwrap();
    assert_eq!(image.source, ImageSourceKind::GuestDir);
    assert_eq!(image.rootfs_mode, None);

    let checkout = tempfile::tempdir().unwrap();
    let out = checkout.path().join("guest/image/out");
    std::fs::create_dir_all(&out).unwrap();
    for f in ["vmlinuz-virt", "initramfs.cpio.lz4", "rootfs.ext4"] {
        std::fs::write(out.join(f), b"x").unwrap();
    }
    let nested = checkout.path().join("native/target/release");
    std::fs::create_dir_all(&nested).unwrap();
    let mut opts = options(store.path(), port);
    opts.checkout_search = vec![nested];
    let image = Assets::new(opts).resolve_default_local().unwrap().unwrap();
    assert_eq!(image.source, ImageSourceKind::Checkout);
    assert_eq!(image.kernel, out.join("vmlinuz-virt"));

    // Paths: directories resolve, files are errors, missing assets listed.
    let image = assets.resolve_local(out.to_str().unwrap(), None).unwrap();
    assert_eq!(image.source, ImageSourceKind::Path);
    let file = out.join("rootfs.ext4");
    let err = assets.resolve(file.to_str().unwrap(), None, None).await.unwrap_err();
    assert_eq!(err.message, format!("image selector path is not a directory: {}", file.display()));
    std::fs::remove_file(out.join("rootfs.ext4")).unwrap();
    let err = assets.resolve_local(out.to_str().unwrap(), None).unwrap_err();
    assert!(
        err.message.starts_with(&format!("Missing guest assets in {}: rootfs.ext4", out.display())),
        "{err}"
    );
}

#[test]
fn import_dir_copies_and_validates() {
    let store = tempfile::tempdir().unwrap();
    let src = tempfile::tempdir().unwrap();
    let s = Store::new(store.path());
    let err = s.import_dir(src.path(), gondolin_assets::ImportMode::Copy).unwrap_err();
    assert!(err.message.contains("missing manifest buildId"), "{err}");
    std::fs::write(
        src.path().join("manifest.json"),
        r#"{"buildId":"11111111-1111-5111-8111-111111111111","config":{"arch":"arm64"},"assets":{"kernel":"k","initramfs":"i","rootfs":"sub/r"}}"#,
    )
    .unwrap();
    std::fs::write(src.path().join("k"), b"k").unwrap();
    std::fs::write(src.path().join("i"), b"i").unwrap();
    let err = s.import_dir(src.path(), gondolin_assets::ImportMode::Copy).unwrap_err();
    assert!(err.message.starts_with("missing manifest.assets.rootfs file at"), "{err}");
    std::fs::create_dir(src.path().join("sub")).unwrap();
    std::fs::write(src.path().join("sub/r"), b"r").unwrap();
    let imported = s.import_dir(src.path(), gondolin_assets::ImportMode::Copy).unwrap();
    assert!(imported.created);
    assert_eq!(imported.arch, Arch::Aarch64);
    assert!(imported.asset_dir.join("sub/r").exists());
    assert!(src.path().join("sub/r").exists(), "copy keeps the source");
    let again = s.import_dir(src.path(), gondolin_assets::ImportMode::Copy).unwrap();
    assert!(!again.created);
    s.set_ref("custom/img:dev", &imported.build_id, Arch::Aarch64).unwrap();
    assert_eq!(
        std::fs::read_link(store.path().join("refs/custom/img/dev/aarch64")).unwrap(),
        PathBuf::from("../../../../objects/11111111-1111-5111-8111-111111111111")
    );
    let err = s.set_ref("custom/img:dev", &imported.build_id, Arch::X86_64).unwrap_err();
    assert!(err.message.contains("arch mismatch"), "{err}");

    // A symlinked asset escaping the source directory is refused.
    let evil = tempfile::tempdir().unwrap();
    std::fs::write(
        evil.path().join("manifest.json"),
        r#"{"buildId":"22222222-2222-5222-8222-222222222222","config":{"arch":"x86_64"},"assets":{"kernel":"k","initramfs":"i","rootfs":"r"}}"#,
    )
    .unwrap();
    std::fs::write(evil.path().join("k"), b"k").unwrap();
    std::fs::write(evil.path().join("i"), b"i").unwrap();
    std::os::unix::fs::symlink("/etc/hosts", evil.path().join("r")).unwrap();
    let err = s.import_dir(evil.path(), gondolin_assets::ImportMode::Copy).unwrap_err();
    assert!(err.message.contains("resolved path escapes"), "{err}");
}
