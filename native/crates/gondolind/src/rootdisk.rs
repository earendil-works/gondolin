//! Root disk preparation in the daemon (remote sessions): the port of the
//! rootfs modes of `VM` (`host/src/vm/core.ts`) and the qcow2 helpers of
//! `host/src/qemu/img.ts`, so no disk image has to exist on the controller.

use std::path::{Path, PathBuf};
use std::process::Command;

use gondolin_proto::session::{RootDisk, VmConfig};

/// `qemu-img` next to the configured qemu binary, else from `PATH`.
pub fn qemu_img_path(qemu_path: &str) -> PathBuf {
    let qemu = Path::new(qemu_path);
    if qemu.components().count() > 1
        && let Some(dir) = qemu.parent()
    {
        let candidate = dir.join("qemu-img");
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("qemu-img")
}

fn run(qemu_img: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new(qemu_img)
        .args(args)
        .output()
        .map_err(|e| format!("cannot run {}: {e}", qemu_img.display()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{} {} failed: {}", qemu_img.display(), args.join(" "), stderr.trim()));
    }
    Ok(out.stdout)
}

/// `inferDiskFormatFromPath`.
pub fn infer_format(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".qcow2") || lower.ends_with(".qcow") { "qcow2" } else { "raw" }
}

fn virtual_size(qemu_img: &Path, image: &Path) -> Result<u64, String> {
    let out = run(qemu_img, &["info", "--output=json", &image.display().to_string()])?;
    let json = gondolin_wire::json::parse(&String::from_utf8_lossy(&out))
        .map_err(|e| format!("invalid qemu-img info output: {e}"))?;
    json["virtual-size"].as_integer().and_then(|n| u64::try_from(n).ok()).ok_or_else(|| {
        format!("qemu-img info did not report a valid virtual size for {}", image.display())
    })
}

/// Applies `root_disk.mode`/`size`: creates the overlay in `dir` when needed
/// and rewrites the disk to what QEMU should attach. `krun` has no snapshot
/// mode, so `memory` becomes an overlay there (like the node engine).
/// `checkpoint` boots from an imported checkpoint disk (`imported`), rebased
/// onto the image's rootfs, below a fresh overlay. Returns the overlay path
/// when one was created (the disk a checkpoint export reads).
pub fn prepare(
    vm: &mut VmConfig,
    dir: &Path,
    krun: bool,
    imported: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let qemu_img = qemu_img_path(&vm.qemu_path);
    let Some(disk) = vm.root_disk.as_mut() else { return Ok(None) };
    let Some(mode) = disk.mode.take() else {
        if disk.size.is_some() {
            return Err("root_disk.size requires root_disk.mode".into());
        }
        return Ok(None);
    };
    if disk.path.is_empty() {
        return Err("root_disk.path is required (or vm.image)".into());
    }
    if disk.format.is_empty() {
        disk.format = infer_format(&disk.path).into();
    }
    let size = disk.size.take();
    if mode == "checkpoint" {
        let imported = imported.ok_or("root_disk.mode checkpoint requires checkpoint_import")?;
        // the checkpoint's backing file names the exporting machine's rootfs
        run(
            &qemu_img,
            &[
                "rebase",
                "-u",
                "-F",
                &disk.format,
                "-b",
                &disk.path,
                &imported.display().to_string(),
            ],
        )?;
        disk.path = imported.display().to_string();
        disk.format = "qcow2".into();
    }
    let mut created = None;
    let mut overlay = |disk: &mut RootDisk| -> Result<(), String> {
        let path = dir.join("rootfs.qcow2");
        let _ = std::fs::remove_file(&path);
        run(
            &qemu_img,
            &[
                "create",
                "-f",
                "qcow2",
                "-F",
                &disk.format,
                "-b",
                &disk.path,
                &path.display().to_string(),
            ],
        )?;
        disk.path = path.display().to_string();
        disk.format = "qcow2".into();
        disk.read_only = false;
        disk.snapshot = false;
        created = Some(path);
        Ok(())
    };
    match mode.as_str() {
        "readonly" => {
            if size.is_some() {
                return Err(
                    "rootfs.size requires a writable root disk (rootfs.mode cannot be readonly)"
                        .into(),
                );
            }
            disk.read_only = true;
            disk.snapshot = false;
        }
        "memory" if !krun && size.is_none() => {
            disk.read_only = false;
            disk.snapshot = true;
        }
        "memory" | "cow" | "auto" | "checkpoint" => overlay(disk)?,
        other => return Err(format!("unsupported rootfs mode: {other}")),
    }
    if let Some(bytes) = size {
        if bytes == 0 {
            return Err("invalid disk resize target: 0".into());
        }
        let path = PathBuf::from(&disk.path);
        if virtual_size(&qemu_img, &path)? < bytes {
            run(&qemu_img, &["resize", &disk.path, &bytes.to_string()])?;
        }
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_qemu_img() {
        assert_eq!(infer_format("/x/root.QCOW2"), "qcow2");
        assert_eq!(infer_format("/x/rootfs.ext4"), "raw");
        assert_eq!(qemu_img_path("qemu-system-aarch64"), PathBuf::from("qemu-img"));
    }

    #[test]
    fn modes_without_qemu_img() {
        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(RootDisk {
            path: "/img/rootfs.ext4".into(),
            format: String::new(),
            read_only: false,
            snapshot: false,
            mode: Some("memory".into()),
            size: None,
        });
        let dir = std::env::temp_dir();
        prepare(&mut vm, &dir, false, None).unwrap();
        let disk = vm.root_disk.as_ref().unwrap();
        assert!(disk.snapshot && disk.format == "raw" && disk.mode.is_none());

        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(RootDisk {
            path: "/img/rootfs.ext4".into(),
            format: "raw".into(),
            read_only: false,
            snapshot: false,
            mode: Some("readonly".into()),
            size: Some(1 << 30),
        });
        assert!(prepare(&mut vm, &dir, false, None).unwrap_err().contains("writable"));
    }
}
