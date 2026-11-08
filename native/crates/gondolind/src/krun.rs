//! libkrun backend: the
//! `gondolin-krun-runner` helper boots the VM from a JSON config file and,
//! like QEMU, connects to the guest channel sockets.

use std::path::{Path, PathBuf};

use gondolin_proto::session::VmConfig;

use crate::qemu::ChardevPaths;

/// Default kernel cmdline of the krun backend.
pub const DEFAULT_APPEND: &str = "console=hvc0 root=/dev/vda rootfstype=ext4 rw init=/init";

gondolin_wire::wire_encode! {
    /// Runner configuration (`KrunRunnerConfig`), camelCase JSON.
    #[derive(Debug, PartialEq)]
    pub struct RunnerConfig {
        pub kernel_path: String as "kernelPath",
        pub initrd_path: String as "initrdPath",
        pub root_disk_path: Option<String> as "rootDiskPath",
        pub root_disk_format: Option<String> as "rootDiskFormat",
        pub root_disk_read_only: bool as "rootDiskReadOnly",
        pub memory_mib: u64 as "memoryMiB",
        pub cpus: u32,
        pub virtio_socket_path: String as "virtioSocketPath",
        pub virtio_fs_socket_path: String as "virtioFsSocketPath",
        pub virtio_ssh_socket_path: String as "virtioSshSocketPath",
        pub virtio_ingress_socket_path: String as "virtioIngressSocketPath",
        pub append: String,
        pub console: String,
        pub net_socket_path: Option<String> as "netSocketPath",
        pub net_mac: Option<String> as "netMac",
        /// FUSE server socket of a virtio-fs device (runner capability `virtiofs-socket`)
        pub virtio_fs_device_socket_path: Option<String> as "virtioFsDeviceSocketPath",
        pub virtio_fs_device_tag: Option<String> as "virtioFsDeviceTag",
    }
}

/// Runner capability: a virtio-fs device served over a socket
/// (`krun_add_virtiofs_socket`, `host/krun-runner/patches`).
pub const CAP_VIRTIOFS_SOCKET: &str = "virtiofs-socket";

/// Optional features of the runner binary, one per line of
/// `--capabilities` (none for runners without that option). Cached in memory
/// per binary (path, size, mtime). Blocking.
pub fn runner_capabilities(runner: &str) -> Vec<String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
    let resolved = crate::qemu::which(runner).unwrap_or_else(|| PathBuf::from(runner));
    let Ok(meta) = std::fs::metadata(&resolved) else { return Vec::new() };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = format!("{}|{}|{}", resolved.display(), meta.len(), mtime);
    let cache = CACHE.get_or_init(Default::default);
    if let Some(caps) = cache.lock().unwrap().get(&key) {
        return caps.clone();
    }
    let caps = std::process::Command::new(&resolved)
        .arg("--capabilities")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_capabilities(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    cache.lock().unwrap().insert(key, caps.clone());
    caps
}

fn parse_capabilities(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// A virtio-fs device served by the daemon over a socket.
pub struct VirtioFsDevice<'a> {
    pub socket: &'a str,
    pub tag: &'a str,
}

/// `parseMemoryToMiB`: qemu-style sizes (`512`, `512M`, `1G`, ...) in MiB.
pub fn parse_memory_mib(value: &str) -> Result<u64, String> {
    let trimmed = value.trim();
    let invalid = || format!("invalid vm memory value for krun backend: {value:?}");
    let (digits, unit) = match trimmed.char_indices().find(|(_, c)| !c.is_ascii_digit()) {
        Some((i, _)) => trimmed.split_at(i),
        None => (trimmed, ""),
    };
    if digits.is_empty() || unit.len() > 1 {
        return Err(invalid());
    }
    let amount: u128 = digits.parse().map_err(|_| invalid())?;
    let mult: u128 = match unit.to_ascii_uppercase().as_str() {
        "K" => 1024,
        "" | "M" => 1024 * 1024,
        "G" => 1024 * 1024 * 1024,
        "T" => 1024 * 1024 * 1024 * 1024,
        _ => return Err(invalid()),
    };
    let mib = (amount * mult).div_ceil(1024 * 1024).max(1);
    if mib > u128::from(u32::MAX) {
        return Err(format!("vm memory is too large for krun backend: {value}"));
    }
    Ok(mib as u64)
}

/// The runner binary: `vm.krun_runner_path`, else `gondolin-krun-runner` from `PATH`.
pub fn runner_path(vm: &VmConfig) -> String {
    vm.krun_runner_path
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "gondolin-krun-runner".into())
}

/// Checks the parts of the configuration the runner needs.
pub fn validate(vm: &VmConfig) -> Result<(), String> {
    if vm.cpus < 1 || vm.cpus > 255 {
        return Err(format!("invalid vm cpu count for krun backend: {}", vm.cpus));
    }
    parse_memory_mib(&vm.memory)?;
    if vm.idle_pause_ms.is_some_and(|ms| ms > 0) {
        return Err("vm.idle_pause_ms is only supported with vmm=qemu".into());
    }
    Ok(())
}

/// A valid empty initrd (`createEmptyInitrd`): libkrun cannot place a 0-byte
/// initrd.
pub fn empty_initrd() -> Vec<u8> {
    let name = "TRAILER!!!\0";
    let fields = [0u32, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, name.len() as u32, 0];
    let mut header = String::from("070701");
    for f in fields {
        header.push_str(&format!("{f:08x}"));
    }
    let mut out = vec![0u8; 512];
    let bytes = format!("{header}{name}");
    out[..bytes.len()].copy_from_slice(bytes.as_bytes());
    out
}

/// `resolveUsableKrunInitrd`: a missing (empty path) or empty initrd file is replaced by a generated
/// one in `dir`.
pub fn usable_initrd(initrd: &str, dir: &Path) -> Result<String, String> {
    if !initrd.is_empty() {
        match std::fs::metadata(initrd) {
            Ok(meta) if meta.len() == 0 => {}
            _ => return Ok(initrd.to_string()),
        }
    }
    let path: PathBuf = dir.join("krun-empty-initrd.cpio");
    std::fs::write(&path, empty_initrd())
        .map_err(|e| format!("failed to create default krun initrd at {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

/// Builds the runner configuration (`buildRunnerConfig`).
pub fn runner_config(
    vm: &VmConfig,
    append: &str,
    chardevs: &ChardevPaths,
    net_socket: Option<&str>,
    virtio_fs: Option<VirtioFsDevice<'_>>,
    scratch_dir: &Path,
) -> Result<RunnerConfig, String> {
    validate(vm)?;
    Ok(RunnerConfig {
        kernel_path: vm.kernel_path.clone(),
        initrd_path: usable_initrd(&vm.initrd_path, scratch_dir)?,
        root_disk_path: vm.root_disk.as_ref().map(|d| d.path.clone()),
        root_disk_format: vm.root_disk.as_ref().map(|d| d.format.clone()),
        root_disk_read_only: vm.root_disk.as_ref().is_some_and(|d| d.read_only),
        memory_mib: parse_memory_mib(&vm.memory)?,
        cpus: vm.cpus,
        virtio_socket_path: chardevs.control.display().to_string(),
        virtio_fs_socket_path: chardevs.fs.display().to_string(),
        virtio_ssh_socket_path: chardevs.ssh.display().to_string(),
        virtio_ingress_socket_path: chardevs.ingress.display().to_string(),
        append: append.to_string(),
        console: vm.console.clone().unwrap_or_else(|| "none".into()),
        net_socket_path: net_socket.map(str::to_string),
        net_mac: vm.mac.clone(),
        virtio_fs_device_socket_path: virtio_fs.as_ref().map(|d| d.socket.to_string()),
        virtio_fs_device_tag: virtio_fs.map(|d| d.tag.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory() {
        assert_eq!(parse_memory_mib("1G").unwrap(), 1024);
        assert_eq!(parse_memory_mib("512").unwrap(), 512);
        assert_eq!(parse_memory_mib("1k").unwrap(), 1);
        assert_eq!(parse_memory_mib(" 2048M ").unwrap(), 2048);
        assert!(parse_memory_mib("1GB").is_err());
        assert!(parse_memory_mib("x").is_err());
        assert!(parse_memory_mib("8192T").is_err());
    }

    #[test]
    fn capabilities() {
        assert_eq!(
            parse_capabilities("virtiofs-socket\n\n other \n"),
            vec!["virtiofs-socket", "other"]
        );
        assert!(runner_capabilities("/nonexistent/gondolin-krun-runner").is_empty());
    }

    #[test]
    fn empty_initrd_layout() {
        let data = empty_initrd();
        assert_eq!(data.len(), 512);
        assert!(data.starts_with(b"070701"));
        assert_eq!(&data[110..121], b"TRAILER!!!\0");
    }
}
