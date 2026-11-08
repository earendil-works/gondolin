//! Compatibility with the node engine: resolve everything in this machine's
//! image store with both implementations and compare (skipped without `node`
//! or an image store).

use std::path::PathBuf;
use std::process::Command;

use gondolin_assets::{Assets, ImageSourceKind, Store};

const TS_SCRIPT: &str = r#"
const host = process.argv[2];
const { resolveImageSelector } = await import(host + "/src/images.ts");
const assets = await import(host + "/src/assets.ts");
const out = {};
for (const sel of process.argv.slice(3)) {
  try { out[sel] = resolveImageSelector(sel); } catch (e) { out[sel] = { error: e.message }; }
}
try { out["<default>"] = assets.resolveGuestAssetsSync(); } catch (e) { out["<default>"] = { error: e.message }; }
console.log(JSON.stringify(out));
"#;

#[test]
fn resolves_like_the_node_engine() {
    let host = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../host"));
    if Command::new("node").arg("--version").output().is_err()
        || !host.join("src/images.ts").exists()
    {
        eprintln!("skipping: node or host sources not available");
        return;
    }
    let store = Store::from_env();
    let mut selectors: Vec<String> = store.list_refs().into_iter().map(|r| r.reference).collect();
    selectors.extend(store.object_ids());
    if selectors.is_empty() {
        eprintln!("skipping: no images in {}", store.root().display());
        return;
    }
    selectors.extend([
        "alpine-base:does-not-exist".to_string(),
        "11111111-1111-5111-8111-111111111111".to_string(),
        "bad name".to_string(),
        "/tmp".to_string(),
    ]);

    let script =
        std::env::temp_dir().join(format!("gondolin-assets-compat-{}.mjs", std::process::id()));
    std::fs::write(&script, TS_SCRIPT).unwrap();
    let output = Command::new("node").arg(&script).arg(&host).args(&selectors).output().unwrap();
    let _ = std::fs::remove_file(&script);
    assert!(output.status.success(), "node failed: {}", String::from_utf8_lossy(&output.stderr));
    let ts: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();

    let assets = Assets::from_env();
    let mut compared = 0;
    for selector in &selectors {
        let expected = &ts[selector];
        match assets.resolve_local(selector, None) {
            Ok(image) => {
                assert!(
                    expected.get("error").is_none(),
                    "{selector}: rust resolved, ts failed: {expected}"
                );
                assert_eq!(image.asset_dir.to_str().unwrap(), expected["assetDir"], "{selector}");
                assert_eq!(image.selector, expected["selector"], "{selector}");
                assert_eq!(image.build_id.as_deref(), expected["buildId"].as_str(), "{selector}");
                assert_eq!(image.arch.map(|a| a.as_str()), expected["arch"].as_str(), "{selector}");
                let source = match image.source {
                    ImageSourceKind::Ref => "ref",
                    ImageSourceKind::BuildId => "build-id",
                    _ => "path",
                };
                assert_eq!(source, expected["source"], "{selector}");
            }
            Err(err) => {
                assert_eq!(Some(err.message.as_str()), expected["error"].as_str(), "{selector}");
            }
        }
        compared += 1;
    }

    let default = assets.resolve_default_local().unwrap();
    let expected = &ts["<default>"];
    match default {
        Some(image) => {
            assert_eq!(image.kernel.to_str().unwrap(), expected["kernelPath"]);
            assert_eq!(image.initrd.to_str().unwrap(), expected["initrdPath"]);
            assert_eq!(image.rootfs.to_str().unwrap(), expected["rootfsPath"]);
        }
        None => assert!(expected.is_null(), "ts found a default image: {expected}"),
    }
    eprintln!("compared {compared} selectors and the default image with the node engine");
}

/// Objects and refs written by the native store resolve in the node engine.
#[test]
fn node_engine_reads_native_store() {
    let host = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../host"));
    if Command::new("node").arg("--version").output().is_err()
        || !host.join("src/images.ts").exists()
    {
        eprintln!("skipping: node or host sources not available");
        return;
    }
    let store_dir = tempfile::tempdir().unwrap();
    let src = tempfile::tempdir().unwrap();
    std::fs::write(
        src.path().join("manifest.json"),
        r#"{"version":1,"buildId":"33333333-3333-5333-8333-333333333333","config":{"arch":"aarch64"},"runtimeDefaults":{"rootfsMode":"cow"},"assets":{"kernel":"vmlinuz-virt","initramfs":"initramfs.cpio.lz4","rootfs":"rootfs.ext4"},"checksums":{"kernel":"a","initramfs":"b","rootfs":"c"}}"#,
    )
    .unwrap();
    for f in ["vmlinuz-virt", "initramfs.cpio.lz4", "rootfs.ext4"] {
        std::fs::write(src.path().join(f), f).unwrap();
    }
    let store = Store::new(store_dir.path());
    let imported = store.import_dir(src.path(), gondolin_assets::ImportMode::Copy).unwrap();
    store.set_ref("compat/img:1", &imported.build_id, gondolin_assets::Arch::Aarch64).unwrap();

    let script =
        std::env::temp_dir().join(format!("gondolin-assets-compat2-{}.mjs", std::process::id()));
    std::fs::write(&script, TS_SCRIPT).unwrap();
    let output = Command::new("node")
        .env("GONDOLIN_IMAGE_STORE", store_dir.path())
        .arg(&script)
        .arg(&host)
        .args(["compat/img:1", &imported.build_id])
        .output()
        .unwrap();
    let _ = std::fs::remove_file(&script);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let ts: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let object = store_dir.path().join("objects").join(&imported.build_id);
    assert_eq!(ts["compat/img:1"]["assetDir"], object.to_str().unwrap(), "{ts}");
    assert_eq!(ts["compat/img:1"]["buildId"], imported.build_id.as_str());
    assert_eq!(ts[&imported.build_id]["arch"], "aarch64");
}

/// The registry cache this machine's engines wrote (node's
/// `JSON.stringify(cache, null, 2)` or ours) re-encodes to the same bytes.
#[test]
fn registry_cache_reencodes_byte_identical() {
    use gondolin_assets::registry::{REGISTRY_CACHE_FILE, load_cache, save_cache};
    let store = gondolin_assets::Store::from_env();
    let path = store.root().join(REGISTRY_CACHE_FILE);
    let Ok(original) = std::fs::read_to_string(&path) else {
        eprintln!("skipping: no {}", path.display());
        return;
    };
    let url = gondolin_wire::json::parse(&original)
        .ok()
        .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string))
        .unwrap();
    let cache = load_cache(store.root(), &url).expect("cache loads");
    let out = tempfile::tempdir().unwrap();
    save_cache(out.path(), &cache).unwrap();
    let again = std::fs::read_to_string(out.path().join(REGISTRY_CACHE_FILE)).unwrap();
    assert!(again == original, "re-encoded cache differs:\n{again}\n---\n{original}");
}
