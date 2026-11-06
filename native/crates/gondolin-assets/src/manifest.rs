//! `manifest.json` of a guest image (port of `AssetManifest` and
//! `computeAssetBuildId` in `host/src/assets.ts`).

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::image_ref::Arch;

pub const MANIFEST_FILENAME: &str = "manifest.json";

/// Namespace for content-derived build ids; must never change.
const BUILD_ID_NAMESPACE: &str = "7b6ed0c0-7e7f-4c2a-8b2d-0bf3d5be9d52";

/// Asset file names (relative to the image directory).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFiles {
    pub kernel: String,
    pub initramfs: String,
    pub rootfs: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub krun_kernel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub krun_initrd: Option<String>,
}

impl Default for AssetFiles {
    /// Names used when a directory has no manifest.
    fn default() -> Self {
        AssetFiles {
            kernel: "vmlinuz-virt".into(),
            initramfs: "initramfs.cpio.lz4".into(),
            rootfs: "rootfs.ext4".into(),
            krun_kernel: None,
            krun_initrd: None,
        }
    }
}

/// `sha256` checksums (hex) of the asset files.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checksums {
    pub kernel: String,
    pub initramfs: String,
    pub rootfs: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub krun_kernel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub krun_initrd: Option<String>,
}

/// Root filesystem write mode default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RootfsMode {
    Readonly,
    Memory,
    Cow,
}

/// `runtimeDefaults` of a manifest.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDefaults {
    /// raw value; see [`AssetManifest::rootfs_mode`]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rootfs_mode: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Parsed `manifest.json`. Unknown fields are preserved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetManifest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_id: Option<String>,
    /// build configuration (`BuildConfig`), kept as JSON
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_defaults: Option<RuntimeDefaults>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<AssetFiles>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksums: Option<Checksums>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl AssetManifest {
    /// `config.arch`, normalized.
    pub fn arch(&self) -> Option<Arch> {
        self.config.get("arch").and_then(|v| v.as_str()).and_then(Arch::normalize)
    }

    /// `runtimeDefaults.rootfsMode` when it is a valid mode.
    pub fn rootfs_mode(&self) -> Option<RootfsMode> {
        let raw = self.runtime_defaults.as_ref()?.rootfs_mode.as_ref()?;
        serde_json::from_value(raw.clone()).ok()
    }

    /// Asset file names (defaults when the manifest has none).
    pub fn asset_files(&self) -> AssetFiles {
        self.assets.clone().unwrap_or_default()
    }
}

/// Loads `manifest.json` from `dir`; `None` when missing or not a JSON object
/// of the expected shape (the node engine treats those as "no manifest").
pub fn load_manifest(dir: &Path) -> Option<AssetManifest> {
    let content = std::fs::read_to_string(dir.join(MANIFEST_FILENAME)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    if !value.is_object() {
        return None;
    }
    serde_json::from_value(value).ok()
}

/// RFC 4122 version 5 UUID (SHA-1, name-based).
pub fn uuid_v5(name: &str, namespace: &str) -> String {
    let ns_hex: String = namespace.chars().filter(|c| *c != '-').collect();
    let ns: Vec<u8> = (0..ns_hex.len() / 2)
        .map(|i| u8::from_str_radix(&ns_hex[2 * i..2 * i + 2], 16).unwrap_or(0))
        .collect();
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY);
    ctx.update(&ns);
    ctx.update(name.as_bytes());
    let digest = ctx.finish();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest.as_ref()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// Deterministic build id from asset checksums (`computeAssetBuildId`).
pub fn compute_build_id(checksums: &Checksums, arch: Option<&str>) -> String {
    let mut parts = vec![
        "gondolin-asset-build".to_string(),
        format!("kernel={}", checksums.kernel),
        format!("initramfs={}", checksums.initramfs),
        format!("rootfs={}", checksums.rootfs),
    ];
    if let Some(k) = &checksums.krun_kernel {
        parts.push(format!("krunKernel={k}"));
    }
    if let Some(k) = &checksums.krun_initrd {
        parts.push(format!("krunInitrd={k}"));
    }
    parts.push(format!("arch={}", arch.unwrap_or("unknown")));
    uuid_v5(&parts.join("\n"), BUILD_ID_NAMESPACE)
}

/// `sha256` of a file (hex).
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(hex(ctx.finish().as_ref()))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_v5_matches_rfc_example() {
        // Python: uuid.uuid5(uuid.NAMESPACE_DNS, "python.org")
        assert_eq!(
            uuid_v5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
            "886313e1-3b8a-5372-9b90-0c9aee199e5d"
        );
    }

    #[test]
    fn build_id_of_published_image() {
        // alpine-base 0.4.0 (aarch64) as published in builtin-image-registry.json
        let checksums = Checksums {
            kernel: "d1876369b061ef3bc33314f490240efcd32b031393cb34c6f81134fa862fe472".into(),
            initramfs: "745d46a4c68288049d108d9542bc636b706cbf8c8f3a7ee9abff61e5e4106d1a".into(),
            rootfs: "9b2791d276ad822096bfa20ae61143f10c65c4f3356716b67d04ab846b386f7c".into(),
            krun_kernel: Some(
                "2bfc6989476acc7f772ef05053e56613668daa507a5fe64244b9cc4adcb66ee0".into(),
            ),
            krun_initrd: Some(
                "d994915f6fa1020492aaf3e154e89c3fac9c32eed94c28aaf20f9e1c9a5d5650".into(),
            ),
        };
        assert_eq!(
            compute_build_id(&checksums, Some("aarch64")),
            "9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359"
        );
    }

    #[test]
    fn manifest_parsing() {
        let dir = tempfile::tempdir().unwrap();
        let raw = r#"{
          "version": 1,
          "buildId": "9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359",
          "config": { "arch": "arm64", "distro": "alpine" },
          "runtimeDefaults": { "rootfsMode": "cow" },
          "ociSource": { "image": "x" },
          "buildTime": "2026-10-22T08:14:49.457Z",
          "assets": { "kernel": "k", "initramfs": "i", "rootfs": "r", "krunKernel": "kk" },
          "checksums": { "kernel": "a", "initramfs": "b", "rootfs": "c" }
        }"#;
        std::fs::write(dir.path().join(MANIFEST_FILENAME), raw).unwrap();
        let m = load_manifest(dir.path()).unwrap();
        assert_eq!(m.arch(), Some(Arch::Aarch64));
        assert_eq!(m.rootfs_mode(), Some(RootfsMode::Cow));
        assert_eq!(m.asset_files().krun_kernel.as_deref(), Some("kk"));
        assert!(m.extra.contains_key("ociSource"));
        assert!(m.extra.contains_key("buildTime"));
        // round trip keeps unknown fields
        let back = serde_json::to_value(&m).unwrap();
        assert_eq!(back["ociSource"]["image"], "x");

        std::fs::write(
            dir.path().join(MANIFEST_FILENAME),
            r#"{"runtimeDefaults":{"rootfsMode":"bogus"}}"#,
        )
        .unwrap();
        let m = load_manifest(dir.path()).unwrap();
        assert_eq!(m.rootfs_mode(), None);
        assert_eq!(m.asset_files(), AssetFiles::default());

        std::fs::write(dir.path().join(MANIFEST_FILENAME), "[1]").unwrap();
        assert!(load_manifest(dir.path()).is_none());
        std::fs::write(dir.path().join(MANIFEST_FILENAME), "{nope").unwrap();
        assert!(load_manifest(dir.path()).is_none());
    }
}
