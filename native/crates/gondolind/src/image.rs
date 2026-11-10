//! Image selectors in `configure.vm`: resolved with `gondolin-assets`
//! (sharing the node engine's image cache, downloading from the builtin
//! registry when needed); download progress is reported as `log` events with
//! component `assets` (JSON `ProgressEvent`s).

use std::sync::Arc;

use gondolin_assets::{Arch, Assets, DiskFormat, ProgressEvent};
use gondolin_proto::session::{Configure, LOG, Log, VmConfig};
use gondolin_wire::Value;
use tokio::sync::mpsc;

use crate::controller::Controller;
use crate::qemu::{self, HostInfo};
use crate::session::Event;

/// Whether `vm` names an image whose paths still have to be filled in.
pub fn needs_resolution(vm: &VmConfig) -> bool {
    vm.image.is_some()
}

/// Guest architecture for resolution: `vm.arch`, else from `qemu_path`, else
/// the daemon's host.
fn guest_arch(vm: &VmConfig, host: &HostInfo) -> Result<Option<Arch>, String> {
    if let Some(a) = vm.arch.as_deref().filter(|a| !a.is_empty()) {
        return Arch::normalize(a).map(Some).ok_or_else(|| format!("unsupported vm.arch: {a}"));
    }
    if vm.qemu_path.is_empty() {
        return Ok(None);
    }
    Ok(Arch::normalize(&qemu::detect_target_arch(&vm.qemu_path, host)))
}

/// Fills the empty paths of `vm` from a resolved image.
pub fn apply_image(
    vm: &mut VmConfig,
    image: &gondolin_assets::ResolvedImage,
) -> Result<(), String> {
    if qemu::is_krun(vm) && vm.kernel_path.is_empty() {
        let kernel = image.krun_kernel.as_ref().ok_or(
            "selected image does not provide krun boot assets (manifest assets.krunKernel)",
        )?;
        vm.kernel_path = kernel.display().to_string();
        // without a krun initrd the runner gets a generated empty one
        if vm.initrd_path.is_empty()
            && let Some(initrd) = &image.krun_initrd
        {
            vm.initrd_path = initrd.display().to_string();
        }
    }
    if vm.kernel_path.is_empty() {
        vm.kernel_path = image.kernel.display().to_string();
    }
    if vm.initrd_path.is_empty() && !qemu::is_krun(vm) {
        vm.initrd_path = image.initrd.display().to_string();
    }
    if let Some(disk) = vm.root_disk.as_mut()
        && disk.mode.as_deref() == Some("auto")
    {
        disk.mode = Some(match image.rootfs_mode {
            Some(gondolin_assets::RootfsMode::Readonly) => "readonly".into(),
            Some(gondolin_assets::RootfsMode::Memory) => "memory".into(),
            _ => "cow".into(),
        });
    }
    if let Some(disk) = vm.root_disk.as_mut()
        && disk.path.is_empty()
    {
        disk.path = image.rootfs.display().to_string();
        if disk.format.is_empty() {
            disk.format = match image.rootfs_format {
                DiskFormat::Raw => "raw",
                DiskFormat::Qcow2 => "qcow2",
            }
            .into();
        }
    }
    if vm.qemu_path.is_empty() && !qemu::is_krun(vm) && !crate::firecracker::is_firecracker(vm) {
        let arch = image.arch.unwrap_or_else(Arch::host);
        vm.qemu_path = match arch {
            Arch::Aarch64 => "qemu-system-aarch64",
            Arch::X86_64 => "qemu-system-x86_64",
        }
        .into();
    }
    Ok(())
}

/// Resolves `cfg.vm.image` in the background and posts
/// [`Event::ImageResolved`].
pub fn resolve_async(
    mut cfg: Configure,
    id: u64,
    host: HostInfo,
    ctl: Arc<Controller>,
    events: mpsc::UnboundedSender<Event>,
) {
    tokio::spawn(async move {
        let result = crate::panics::CatchUnwind::new(async {
            let arch = guest_arch(&cfg.vm, &host)?;
            let selector = cfg.vm.image.clone().unwrap_or_default();
            let assets = Assets::from_env();
            let progress_ctl = ctl.clone();
            let progress = move |ev: ProgressEvent| {
                let message =
                    gondolin_wire::json::to_string(&gondolin_wire::ToValue::to_value(&ev));
                progress_ctl.send(LOG, 0, &Log { component: "assets".into(), message });
            };
            let image = if selector.trim().is_empty() {
                assets.resolve_default(Some(&progress)).await
            } else if gondolin_assets::is_build_id(selector.trim()) {
                // also the local default image (`GONDOLIN_GUEST_DIR`, a
                // checkout) when it is that build, as checkpoints need
                assets.resolve_build_id(selector.trim(), Some(&progress)).await
            } else {
                assets.resolve(&selector, arch, Some(&progress)).await
            }
            .map_err(|e| e.to_string())?;
            apply_image(&mut cfg.vm, &image)?;
            let described = gondolin_wire::ToValue::to_value(&image);
            Ok::<(Configure, Value), String>((cfg, described))
        })
        .await
        .unwrap_or_else(|panic| Err(format!("internal error: {panic}")));
        let _ = events.send(Event::ImageResolved { id, result: Box::new(result) });
    });
}
