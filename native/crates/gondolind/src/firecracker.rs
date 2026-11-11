//! Firecracker backend: KVM microVMs, or AWS Nitro Sandboxes.
//!
//! The VM is described by one JSON file (`firecracker --no-api --config-file`):
//! kernel + initrd + command line, vCPUs and memory, the raw root disk, a
//! virtio-net device on a tap (see [`crate::tap`]) and a vsock device whose
//! guest-initiated connections Firecracker forwards to `<uds>_<port>`, where
//! the daemon's guest channels listen (the guest helpers connect there when
//! the command line has `gondolin.vsock`, see `guest/ARCHITECTURE.md` §3.1).
//!
//! With `vm.nitro` the `enclave` block makes Firecracker launch the VM through
//! `/dev/nitro_enclaves` instead of KVM.  Direct mode (the default) runs an
//! unpatched guest kernel; confidential mode needs the DMB virtio patches and
//! rejects the entropy device.  Without `vm.nitro` the daemon picks KVM when
//! `/dev/kvm` is usable, else a Nitro Sandbox ([`prepare`]).
//!
//! On KVM Firecracker boots only an uncompressed kernel (an ELF `vmlinux` on
//! x86_64, an arm64 `Image` on aarch64); [`prepare`] decompresses the image's
//! `vmlinuz` once into the cache ([`uncompressed_kernel`]).

use std::io::Read;
use std::path::{Path, PathBuf};

use gondolin_proto::session::VmConfig;
use gondolin_wire::Value;

use crate::qemu::ChardevPaths;

/// Kernel command line flag that selects the guest's vsock transport.
pub const VSOCK_APPEND: &str = "gondolin.vsock";

/// Kernel command line flag for a `snapshot` root disk: the initramfs mounts
/// the (read-only) disk under a tmpfs overlay that takes the guest's writes.
pub const OVERLAY_APPEND: &str = "gondolin.overlay";

/// Default kernel command line. The serial port is `ttyS0` on both
/// architectures; `panic=1` (and `reboot=k` on x86_64, which resets through the
/// i8042) turn a guest panic into a VMM exit, and the i8042 flags skip probing
/// for devices Firecracker doesn't have.
#[cfg(target_arch = "x86_64")]
pub const DEFAULT_APPEND: &str =
    "console=ttyS0 initramfs_async=1 reboot=k panic=1 i8042.noaux i8042.nomux i8042.dumbkbd";
#[cfg(not(target_arch = "x86_64"))]
pub const DEFAULT_APPEND: &str = "console=ttyS0 initramfs_async=1 panic=1";

/// Guest CID of the VM's vsock device (any value above 2 works: each VM has
/// its own device).
pub const GUEST_CID: u32 = 3;

/// Host vsock port of each guest channel (`guest/ARCHITECTURE.md` §3.1).
pub const VSOCK_PORT_CONTROL: u32 = 1024;
pub const VSOCK_PORT_FS: u32 = 1025;
pub const VSOCK_PORT_SSH: u32 = 1026;
pub const VSOCK_PORT_INGRESS: u32 = 1027;

/// Whether the configuration selects the Firecracker backend.
pub fn is_firecracker(vm: &VmConfig) -> bool {
    vm.vmm.as_deref() == Some("firecracker")
}

/// The binary: `vm.firecracker_path`, else `firecracker` from `PATH`.
pub fn binary_path(vm: &VmConfig) -> String {
    vm.firecracker_path.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| "firecracker".into())
}

/// The vsock device's socket in `dir`; Firecracker binds it itself.
pub fn vsock_uds(dir: &Path) -> PathBuf {
    dir.join("vsock.sock")
}

/// Where the daemon listens for each guest channel: Firecracker connects to
/// `<uds>_<port>` when the guest connects to `port` on the host.
pub fn chardev_paths(dir: &Path) -> ChardevPaths {
    let uds = vsock_uds(dir);
    let at = |port: u32| PathBuf::from(format!("{}_{port}", uds.display()));
    ChardevPaths {
        control: at(VSOCK_PORT_CONTROL),
        fs: at(VSOCK_PORT_FS),
        ssh: at(VSOCK_PORT_SSH),
        ingress: at(VSOCK_PORT_INGRESS),
    }
}

/// Memory in MiB, rounded up to the 2 MiB granularity Firecracker requires.
pub fn memory_mib(vm: &VmConfig) -> Result<u64, String> {
    let mib = crate::krun::parse_memory_mib(&vm.memory).map_err(|_| {
        format!("invalid vm memory value for the firecracker backend: {:?}", vm.memory)
    })?;
    Ok(mib.div_ceil(2) * 2)
}

/// Oldest Firecracker release with what the backend uses (Nitro Sandboxes,
/// the vsock and config file behaviour it relies on).
pub const MIN_VERSION: (u32, u32) = (1, 18);

/// How to get a usable binary, appended to errors about it.
const INSTALL_HINT: &str = "install Firecracker 1.18 or newer (scripts/install-firecracker.sh \
     in the Gondolin repository, or a release from \
     https://github.com/firecracker-microvm/firecracker/releases) or point \
     sandbox.firecrackerPath / GONDOLIN_FIRECRACKER at it";

/// `(major, minor)` of `firecracker --version` output (`Firecracker v1.18.0`).
pub fn parse_version(output: &str) -> Option<(u32, u32)> {
    let line = output.lines().next()?;
    let version = line.split_whitespace().find_map(|w| w.strip_prefix('v'))?;
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Runs `<binary> --version` and checks it is at least [`MIN_VERSION`].
/// Blocking.
pub fn check_binary(vm: &VmConfig) -> Result<(), String> {
    let program = binary_path(vm);
    let out = std::process::Command::new(&program)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|err| format!("cannot run {program}: {err}; {INSTALL_HINT}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    match parse_version(&text) {
        Some(version) if out.status.success() && version >= MIN_VERSION => Ok(()),
        Some((major, minor)) if out.status.success() => Err(format!(
            "{program} is Firecracker {major}.{minor}; the firecracker backend needs {}.{} or \
             newer: {INSTALL_HINT}",
            MIN_VERSION.0, MIN_VERSION.1
        )),
        _ => Err(format!(
            "{program} --version did not report a Firecracker version ({}): {INSTALL_HINT}",
            out.status
        )),
    }
}

/// Whether this daemon's host can run the backend at all.
pub fn check_host() -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("vmm=firecracker requires a Linux host".into());
    }
    Ok(())
}

/// The KVM device; usable when this process can open it read-write.
const KVM_DEVICE: &str = "/dev/kvm";
/// The Nitro Enclaves device of an AWS Nitro Sandboxes parent instance.
const NITRO_DEVICE: &str = "/dev/nitro_enclaves";

fn kvm_usable() -> bool {
    std::fs::OpenOptions::new().read(true).write(true).open(KVM_DEVICE).is_ok()
}

/// Fills in where the VM runs when `vm.nitro` is unset: KVM when usable, else
/// a Nitro Sandbox with the default settings when the host has the device.
fn select_target(vm: &mut VmConfig, kvm: bool, nitro_device: bool) -> Result<(), String> {
    if vm.nitro.is_some() || kvm {
        return Ok(());
    }
    if nitro_device {
        vm.nitro = Some(gondolin_proto::session::NitroConfig {
            mode: "direct".into(),
            cpu_overcommit: true,
        });
        return Ok(());
    }
    Err(format!(
        "vmm=firecracker needs {KVM_DEVICE} (read-write access for KVM microVMs) or \
         {NITRO_DEVICE} (AWS Nitro Sandboxes)"
    ))
}

/// Validates `vm` and settles the parts this host decides: KVM or Nitro
/// ([`select_target`]) and, on KVM, the uncompressed kernel that replaces
/// `vm.kernel_path`.
pub fn prepare(vm: &mut VmConfig) -> Result<(), String> {
    check_host()?;
    select_target(vm, kvm_usable(), Path::new(NITRO_DEVICE).exists())?;
    validate(vm)?;
    check_image(Path::new(&vm.kernel_path))?;
    if vm.nitro.is_none() {
        let cache = gondolin_assets::store::gondolin_cache_dir().join("firecracker-kernels");
        vm.kernel_path =
            uncompressed_kernel(Path::new(&vm.kernel_path), &cache)?.display().to_string();
    }
    Ok(())
}

/// Refuses an image whose `manifest.json` (beside its kernel) shows it was
/// built without the vsock transport: its guest would never connect. Images
/// without a manifest next to the kernel (explicit asset paths) are not
/// checked; the guest deadline catches those.
fn check_image(kernel: &Path) -> Result<(), String> {
    let Some(dir) = kernel.parent() else { return Ok(()) };
    let Ok(text) = std::fs::read_to_string(dir.join("manifest.json")) else { return Ok(()) };
    let Ok(manifest) = gondolin_wire::json::parse(&text) else { return Ok(()) };
    image_supports_vsock(&manifest).then_some(()).ok_or_else(|| {
        format!(
            "the guest image in {} was built without vsock support (its manifest.json lists no \
             \"vsock\" feature), which vmm=firecracker needs: use an image built with this \
             version of Gondolin",
            dir.display()
        )
    })
}

/// `"vsock"` in a manifest's `features`.
fn image_supports_vsock(manifest: &Value) -> bool {
    let features = crate::fields::Fields::of(manifest).get("features");
    matches!(features, Some(Value::Array(items)) if items.iter().any(|f| f.as_text() == Some("vsock")))
}

/// Whether `data` is a kernel Firecracker boots on KVM on this architecture.
fn bootable_on_kvm(data: &[u8]) -> bool {
    if cfg!(target_arch = "x86_64") {
        data.starts_with(b"\x7fELF")
    } else {
        // arm64 `Image` header magic
        data.get(0x38..0x3c) == Some(b"ARM\x64".as_slice())
    }
}

/// Largest kernel [`uncompressed_kernel`] decompresses.
const MAX_KERNEL_BYTES: u64 = 512 << 20;

/// The kernel at `path` in a form Firecracker boots on KVM: itself when it
/// already is one, else the gzip payload of a bzImage (x86_64) or EFI zboot
/// image (aarch64), decompressed once to `cache/<sha256 of path's contents>`.
pub fn uncompressed_kernel(path: &Path, cache: &Path) -> Result<PathBuf, String> {
    let data =
        std::fs::read(path).map_err(|e| format!("cannot read kernel {}: {e}", path.display()))?;
    if bootable_on_kvm(&data) {
        return Ok(path.to_path_buf());
    }
    let digest = ring::digest::digest(&ring::digest::SHA256, &data);
    let name: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    let out = cache.join(&name);
    if out.exists() {
        return Ok(out);
    }
    // like the kernel's scripts/extract-vmlinux: try each gzip header
    let kernel = data
        .windows(3)
        .enumerate()
        .filter(|(_, w)| *w == [0x1f, 0x8b, 0x08])
        .find_map(|(at, _)| {
            let mut out = Vec::new();
            gondolin_assets::archive::gzip::GzipReader::first_member(&data[at..])
                .take(MAX_KERNEL_BYTES + 1)
                .read_to_end(&mut out)
                .ok()?;
            (out.len() as u64 <= MAX_KERNEL_BYTES && bootable_on_kvm(&out)).then_some(out)
        })
        .ok_or_else(|| {
            format!(
                "{} is not a kernel Firecracker can boot on KVM (expected an uncompressed \
                 kernel or a gzip-compressed bzImage/zboot image)",
                path.display()
            )
        })?;
    std::fs::create_dir_all(cache)
        .map_err(|e| format!("cannot create {}: {e}", cache.display()))?;
    // concurrent sessions may race: each writes its own file, the rename is atomic
    let tmp = cache.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, &kernel).and_then(|()| std::fs::rename(&tmp, &out)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot write {}: {e}", out.display())
    })?;
    Ok(out)
}

/// Checks the parts of the configuration this backend supports.
pub fn validate(vm: &VmConfig) -> Result<(), String> {
    if let Some(nitro) = &vm.nitro {
        if nitro.mode != "direct" && nitro.mode != "confidential" {
            return Err(format!(
                "vm.nitro.mode must be direct or confidential (got {:?})",
                nitro.mode
            ));
        }
        if !nitro.cpu_overcommit && !vm.cpus.is_multiple_of(2) {
            return Err(format!(
                "vm.cpus must be even with dedicated cores (vm.nitro.cpu_overcommit false): {}",
                vm.cpus
            ));
        }
    }
    if vm.cpus < 1 || vm.cpus > 1024 {
        return Err(format!("invalid vm cpu count for the firecracker backend: {}", vm.cpus));
    }
    let mib = memory_mib(vm)?;
    if mib < 64 {
        return Err(format!("a Firecracker VM needs at least 64 MiB of memory (got {mib} MiB)"));
    }
    if vm.idle_pause_ms.is_some_and(|ms| ms > 0) {
        return Err("vm.idle_pause_ms is only supported with vmm=qemu".into());
    }
    for (field, set) in [
        ("vm.machine_type", vm.machine_type.is_some()),
        ("vm.accel", vm.accel.is_some()),
        ("vm.cpu", vm.cpu.is_some()),
    ] {
        if set {
            return Err(format!("{field} is only supported with vmm=qemu"));
        }
    }
    Ok(())
}

/// Everything [`config`] needs besides the VM configuration.
pub struct ConfigArgs<'a> {
    /// final kernel command line (without [`VSOCK_APPEND`])
    pub append: &'a str,
    /// vsock device socket ([`vsock_uds`])
    pub vsock_uds: &'a Path,
    /// tap device of the network interface (none: no network)
    pub tap: Option<&'a str>,
    /// guest MAC address
    pub mac: &'a str,
    /// turn on the sandbox's debug console (the guest's serial output on
    /// Firecracker's stdout): see [`wants_console`]
    pub console: bool,
}

/// Whether the debug console is worth its cost: in confidential mode it zeroes
/// the attestation PCRs. On only when `vm.console` is explicitly `stdio` or
/// the protocol debug output (which shows it) is on. Without it the kernel
/// also gets `quiet`: it writes its boot log to the emulated UART inline
/// whether or not anyone reads it (~0.45 s per boot).
pub fn wants_console(vm: &VmConfig, protocol_debug: bool) -> bool {
    vm.console.as_deref() == Some("stdio") || protocol_debug
}

/// The Firecracker configuration file for `vm` (after `rootdisk::prepare_raw`).
pub fn config(vm: &VmConfig, args: &ConfigArgs<'_>) -> Result<Value, String> {
    validate(vm)?;
    let debug = args.console;

    let mut boot_args = format!("{} {VSOCK_APPEND}", args.append.trim());
    if vm.root_disk.as_ref().is_some_and(|d| d.snapshot) {
        boot_args.push(' ');
        boot_args.push_str(OVERLAY_APPEND);
    }
    let sets_loglevel = args
        .append
        .split_whitespace()
        .any(|a| a == "quiet" || a == "debug" || a.starts_with("loglevel="));
    if !debug && !sets_loglevel {
        boot_args.push_str(" quiet");
    }
    let mut boot = gondolin_wire::value!({
        "kernel_image_path": vm.kernel_path.clone(),
        "boot_args": boot_args,
    });
    if !vm.initrd_path.is_empty() {
        boot.insert("initrd_path", Value::from(vm.initrd_path.clone()));
    }

    let mut drives = Vec::new();
    if let Some(disk) = &vm.root_disk {
        if disk.format != "raw" {
            return Err(format!(
                "the firecracker backend needs a raw root disk (got {})",
                disk.format
            ));
        }
        drives.push(gondolin_wire::value!({
            "drive_id": "rootfs",
            "path_on_host": disk.path.clone(),
            // the guest's init mounts /dev/vda itself; Firecracker would
            // otherwise append its own root= argument
            "is_root_device": false,
            // a snapshot's writes stay in the guest's overlay
            "is_read_only": disk.read_only || disk.snapshot,
        }));
    }

    let mut interfaces = Vec::new();
    if let Some(tap) = args.tap {
        interfaces.push(gondolin_wire::value!({
            "iface_id": "eth0",
            "host_dev_name": tap.to_string(),
            "guest_mac": args.mac.to_string(),
        }));
    }

    let mut config = gondolin_wire::value!({
        "boot-source": boot,
        "machine-config": {
            "vcpu_count": u64::from(vm.cpus),
            "mem_size_mib": memory_mib(vm)?,
        },
        "drives": Value::Array(drives),
        "network-interfaces": Value::Array(interfaces),
        "vsock": {
            "guest_cid": u64::from(GUEST_CID),
            "uds_path": args.vsock_uds.display().to_string(),
        },
    });
    let mut entropy = true;
    if let Some(nitro) = &vm.nitro {
        let direct = nitro.mode == "direct";
        config.insert(
            "enclave",
            gondolin_wire::value!({
                "debug_mode": debug,
                "direct_mode": direct,
                "cpu_overcommit": nitro.cpu_overcommit,
            }),
        );
        // the Nitro System rejects virtio-rng in confidential mode
        entropy = direct;
    }
    if entropy {
        config.insert("entropy", gondolin_wire::value!({}));
    }
    Ok(config)
}

/// Command line arguments for a config file written to `config_path`.
pub fn args(config_path: &Path, log_path: &Path) -> Vec<String> {
    vec![
        "--no-api".into(),
        "--config-file".into(),
        config_path.display().to_string(),
        "--log-path".into(),
        log_path.display().to_string(),
        "--level".into(),
        "Warning".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use gondolin_proto::session::{NitroConfig, RootDisk};

    #[test]
    fn image_features() {
        let parse = |t: &str| gondolin_wire::json::parse(t).unwrap();
        assert!(image_supports_vsock(&parse(r#"{"version":1,"features":["vsock"]}"#)));
        assert!(!image_supports_vsock(&parse(r#"{"version":1,"features":[]}"#)));
        assert!(!image_supports_vsock(&parse(r#"{"version":1}"#)));

        let dir = std::env::temp_dir().join(format!("gondolin-fc-image-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let kernel = dir.join("vmlinuz-virt");
        assert!(check_image(&kernel).is_ok(), "no manifest: not checked");
        std::fs::write(dir.join("manifest.json"), r#"{"version":1,"assets":{}}"#).unwrap();
        let err = check_image(&kernel).unwrap_err();
        assert!(err.contains("without vsock support"), "{err}");
        std::fs::write(dir.join("manifest.json"), r#"{"version":1,"features":["vsock"]}"#).unwrap();
        assert!(check_image(&kernel).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn version_parsing() {
        assert_eq!(
            parse_version(
                "Firecracker v1.18.0\n\nSupported snapshot data format versions: v8.0.0\n"
            ),
            Some((1, 18))
        );
        assert_eq!(parse_version("Firecracker v1.9.2-dev\n"), Some((1, 9)));
        assert!(parse_version("Firecracker v1.9.2").unwrap() < MIN_VERSION);
        assert_eq!(parse_version("usage: something"), None);
        assert_eq!(parse_version(""), None);
    }

    fn vm() -> VmConfig {
        VmConfig {
            vmm: Some("firecracker".into()),
            kernel_path: "/img/vmlinuz-virt".into(),
            initrd_path: "/img/initramfs.cpio".into(),
            root_disk: Some(RootDisk {
                path: "/run/s/rootfs.raw".into(),
                format: "raw".into(),
                read_only: false,
                snapshot: false,
                mode: None,
                size: None,
            }),
            memory: "1G".into(),
            cpus: 2,
            nitro: Some(NitroConfig { mode: "direct".into(), cpu_overcommit: true }),
            console: None,
            qemu_path: String::new(),
            ..crate::tests::test_vm()
        }
    }

    fn args<'a>(uds: &'a Path) -> ConfigArgs<'a> {
        ConfigArgs {
            append: "console=ttyS0 initramfs_async=1",
            vsock_uds: uds,
            tap: Some("gfc1"),
            mac: "02:00:00:00:00:01",
            console: true,
        }
    }

    #[test]
    fn config_for_a_direct_mode_sandbox() {
        let uds = PathBuf::from("/run/s/vsock.sock");
        let json = gondolin_wire::json::to_string(&config(&vm(), &args(&uds)).unwrap());
        let parsed = gondolin_wire::json::parse(&json).unwrap();
        assert_eq!(
            parsed["boot-source"]["boot_args"].as_str(),
            Some("console=ttyS0 initramfs_async=1 gondolin.vsock")
        );
        assert_eq!(parsed["boot-source"]["initrd_path"].as_str(), Some("/img/initramfs.cpio"));
        assert_eq!(parsed["machine-config"]["vcpu_count"].as_u64(), Some(2));
        assert_eq!(parsed["machine-config"]["mem_size_mib"].as_u64(), Some(1024));
        assert_eq!(
            parsed["drives"].as_array().unwrap()[0]["path_on_host"].as_str(),
            Some("/run/s/rootfs.raw")
        );
        assert_eq!(
            parsed["drives"].as_array().unwrap()[0]["is_root_device"].as_bool(),
            Some(false)
        );
        assert_eq!(
            parsed["network-interfaces"].as_array().unwrap()[0]["host_dev_name"].as_str(),
            Some("gfc1")
        );
        assert_eq!(parsed["vsock"]["uds_path"].as_str(), Some("/run/s/vsock.sock"));
        assert_eq!(parsed["vsock"]["guest_cid"].as_u64(), Some(3));
        assert_eq!(parsed["enclave"]["direct_mode"].as_bool(), Some(true));
        assert_eq!(parsed["enclave"]["cpu_overcommit"].as_bool(), Some(true));
        assert_eq!(parsed["enclave"]["debug_mode"].as_bool(), Some(true));
        assert!(parsed.get("entropy").is_some());
    }

    #[test]
    fn debug_console_only_when_someone_reads_it() {
        let mut vm = vm();
        assert!(!wants_console(&vm, false), "off by default");
        assert!(wants_console(&vm, true), "protocol debug shows it");
        vm.console = Some("stdio".into());
        assert!(wants_console(&vm, false));
        vm.console = Some("none".into());
        assert!(!wants_console(&vm, false));
        let uds = PathBuf::from("/s/v.sock");
        let config = config(&vm, &ConfigArgs { console: false, ..args(&uds) }).unwrap();
        assert_eq!(config["enclave"]["debug_mode"].as_bool(), Some(false));
        assert_eq!(
            config["boot-source"]["boot_args"].as_str(),
            Some("console=ttyS0 initramfs_async=1 gondolin.vsock quiet")
        );
        // a log level chosen by the caller wins
        let chosen = super::config(
            &vm,
            &ConfigArgs { console: false, append: "console=ttyS0 loglevel=7", ..args(&uds) },
        )
        .unwrap();
        assert_eq!(
            chosen["boot-source"]["boot_args"].as_str(),
            Some("console=ttyS0 loglevel=7 gondolin.vsock")
        );
    }

    #[test]
    fn confidential_mode_has_no_entropy_device() {
        let mut vm = vm();
        vm.nitro = Some(NitroConfig { mode: "confidential".into(), cpu_overcommit: true });
        let uds = PathBuf::from("/s/v.sock");
        let config = config(&vm, &args(&uds)).unwrap();
        assert_eq!(config["enclave"]["direct_mode"].as_bool(), Some(false));
        assert!(config.get("entropy").is_none());
    }

    #[test]
    fn no_network_and_no_disk() {
        let mut vm = vm();
        vm.root_disk = None;
        let uds = PathBuf::from("/s/v.sock");
        let config = config(&vm, &ConfigArgs { tap: None, ..args(&uds) }).unwrap();
        assert_eq!(config["drives"].as_array().map(Vec::len), Some(0));
        assert_eq!(config["network-interfaces"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn memory_is_rounded_to_2_mib() {
        let mut vm = vm();
        vm.memory = "513M".into();
        assert_eq!(memory_mib(&vm).unwrap(), 514);
    }

    #[test]
    fn channels_listen_where_firecracker_forwards_guest_connections() {
        let paths = chardev_paths(Path::new("/run/s"));
        assert_eq!(paths.control, PathBuf::from("/run/s/vsock.sock_1024"));
        assert_eq!(paths.fs, PathBuf::from("/run/s/vsock.sock_1025"));
        assert_eq!(paths.ssh, PathBuf::from("/run/s/vsock.sock_1026"));
        assert_eq!(paths.ingress, PathBuf::from("/run/s/vsock.sock_1027"));
    }

    #[test]
    fn validation() {
        assert_eq!(check_host().is_ok(), cfg!(target_os = "linux"));
        assert!(validate(&vm()).is_ok());
        let mut v = vm();
        v.nitro = None;
        assert!(validate(&v).is_ok(), "KVM");
        let mut v = vm();
        v.nitro = Some(NitroConfig { mode: "fast".into(), cpu_overcommit: true });
        assert!(validate(&v).unwrap_err().contains("direct or confidential"));
        let mut v = vm();
        v.cpus = 3;
        v.nitro = Some(NitroConfig { mode: "direct".into(), cpu_overcommit: false });
        assert!(validate(&v).unwrap_err().contains("even"));
        let mut v = vm();
        v.memory = "32M".into();
        assert!(validate(&v).unwrap_err().contains("64 MiB"));
        let mut v = vm();
        v.nitro = None;
        v.cpus = 3;
        assert!(validate(&v).is_ok(), "odd vCPU counts are fine on KVM");
        let mut v = vm();
        v.accel = Some("kvm".into());
        assert!(validate(&v).unwrap_err().contains("vm.accel"));
        let mut v = vm();
        v.idle_pause_ms = Some(1000);
        assert!(validate(&v).unwrap_err().contains("idle_pause_ms"));
    }

    #[test]
    fn snapshot_disks_are_read_only_under_a_guest_overlay() {
        let uds = PathBuf::from("/s/v.sock");
        let plain = config(&vm(), &args(&uds)).unwrap();
        assert_eq!(plain["drives"].as_array().unwrap()[0]["is_read_only"].as_bool(), Some(false));
        assert!(!plain["boot-source"]["boot_args"].as_str().unwrap().contains(OVERLAY_APPEND));

        let mut vm = vm();
        vm.root_disk.as_mut().unwrap().snapshot = true;
        let snapshot = config(&vm, &args(&uds)).unwrap();
        assert_eq!(snapshot["drives"].as_array().unwrap()[0]["is_read_only"].as_bool(), Some(true));
        assert_eq!(
            snapshot["boot-source"]["boot_args"].as_str(),
            Some("console=ttyS0 initramfs_async=1 gondolin.vsock gondolin.overlay")
        );
    }

    #[test]
    fn kvm_config_has_no_enclave_block() {
        let mut vm = vm();
        vm.nitro = None;
        let uds = PathBuf::from("/s/v.sock");
        let config = config(&vm, &args(&uds)).unwrap();
        assert!(config.get("enclave").is_none());
        assert!(config.get("entropy").is_some());
        assert_eq!(config["boot-source"]["kernel_image_path"].as_str(), Some("/img/vmlinuz-virt"));
    }

    #[test]
    fn target_selection() {
        let direct = Some(NitroConfig { mode: "direct".into(), cpu_overcommit: true });
        let pick = |nitro: Option<NitroConfig>, kvm, dev| {
            let mut v = vm();
            v.nitro = nitro;
            select_target(&mut v, kvm, dev).map(|()| v.nitro)
        };
        assert_eq!(pick(None, true, true).unwrap(), None, "KVM wins when usable");
        assert_eq!(pick(None, false, true).unwrap(), direct, "else a Nitro Sandbox");
        let chosen = Some(NitroConfig { mode: "confidential".into(), cpu_overcommit: false });
        assert_eq!(pick(chosen.clone(), true, false).unwrap(), chosen, "explicit Nitro stays");
        assert!(pick(None, false, false).unwrap_err().contains("/dev/kvm"));
    }

    /// The start of a kernel [`bootable_on_kvm`] accepts.
    fn fake_kernel() -> Vec<u8> {
        let mut k = vec![0u8; 4096];
        if cfg!(target_arch = "x86_64") {
            k[..4].copy_from_slice(b"\x7fELF");
        } else {
            k[0x38..0x3c].copy_from_slice(b"ARM\x64");
        }
        k
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    #[test]
    fn kernels_are_decompressed_once_into_the_cache() {
        let dir = std::env::temp_dir().join(format!("gondolin-fc-kernel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cache = dir.join("cache");

        // a boot stub, a gzip stream that isn't the kernel, then the kernel
        let mut image = b"MZ boot stub".to_vec();
        image.extend(gzip(b"not a kernel"));
        image.extend([0x1f, 0x8b, 0x08, 0, 0]);
        image.extend(gzip(&fake_kernel()));
        image.extend(b"trailer");
        let vmlinuz = dir.join("vmlinuz");
        std::fs::write(&vmlinuz, &image).unwrap();

        let out = uncompressed_kernel(&vmlinuz, &cache).unwrap();
        assert!(out.starts_with(&cache));
        assert_eq!(std::fs::read(&out).unwrap(), fake_kernel());
        assert_eq!(uncompressed_kernel(&vmlinuz, &cache).unwrap(), out, "cached");
        let leftovers = std::fs::read_dir(&cache).unwrap().count();
        assert_eq!(leftovers, 1, "no temp files left behind");

        let raw = dir.join("vmlinux");
        std::fs::write(&raw, fake_kernel()).unwrap();
        assert_eq!(uncompressed_kernel(&raw, &cache).unwrap(), raw, "already uncompressed");

        let junk = dir.join("junk");
        std::fs::write(&junk, gzip(b"nope")).unwrap();
        assert!(uncompressed_kernel(&junk, &cache).unwrap_err().contains("not a kernel"));
        assert!(uncompressed_kernel(&dir.join("missing"), &cache).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
