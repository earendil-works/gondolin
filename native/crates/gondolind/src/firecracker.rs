//! Firecracker backend (AWS Nitro Sandboxes).
//!
//! The VM is described by one JSON file (`firecracker --no-api --config-file`):
//! kernel + initrd + command line, vCPUs and memory, the raw root disk, a
//! virtio-net device on a tap (see [`crate::tap`]) and a vsock device whose
//! guest-initiated connections Firecracker forwards to `<uds>_<port>`, where
//! the daemon's guest channels listen (the guest helpers connect there when
//! the command line has `gondolin.vsock`, see `guest/ARCHITECTURE.md` §3.1).
//!
//! The `enclave` block makes Firecracker launch the VM through
//! `/dev/nitro_enclaves` instead of KVM.  Direct mode (the default) runs an
//! unpatched guest kernel; confidential mode needs the DMB virtio patches and
//! rejects the entropy device.

use std::path::{Path, PathBuf};

use gondolin_proto::session::VmConfig;
use gondolin_wire::Value;

use crate::qemu::ChardevPaths;

/// Kernel command line flag that selects the guest's vsock transport.
pub const VSOCK_APPEND: &str = "gondolin.vsock";

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

/// Whether this daemon's host can run the backend at all.
pub fn check_host() -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("vmm=firecracker requires a Linux host".into());
    }
    Ok(())
}

/// Checks the parts of the configuration this backend supports.
pub fn validate(vm: &VmConfig) -> Result<(), String> {
    let Some(nitro) = &vm.nitro else {
        return Err(
            "vmm=firecracker currently requires vm.nitro (AWS Nitro Sandboxes); KVM microVMs are not supported yet"
                .into(),
        );
    };
    if nitro.mode != "direct" && nitro.mode != "confidential" {
        return Err(format!("vm.nitro.mode must be direct or confidential (got {:?})", nitro.mode));
    }
    if vm.cpus < 1 || vm.cpus > 1024 {
        return Err(format!("invalid vm cpu count for the firecracker backend: {}", vm.cpus));
    }
    if !nitro.cpu_overcommit && !vm.cpus.is_multiple_of(2) {
        return Err(format!(
            "vm.cpus must be even with dedicated cores (vm.nitro.cpu_overcommit false): {}",
            vm.cpus
        ));
    }
    let mib = memory_mib(vm)?;
    if mib < 64 {
        return Err(format!("a Nitro Sandbox needs at least 64 MiB of memory (got {mib} MiB)"));
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
    let nitro = vm.nitro.as_ref().expect("validated");
    let direct = nitro.mode == "direct";
    let debug = args.console;

    let mut boot_args = format!("{} {VSOCK_APPEND}", args.append.trim());
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
            "is_read_only": disk.read_only,
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
        "enclave": {
            "debug_mode": debug,
            "direct_mode": direct,
            "cpu_overcommit": nitro.cpu_overcommit,
        },
    });
    if direct {
        // the Nitro System rejects virtio-rng in confidential mode
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
        assert!(validate(&v).unwrap_err().contains("vm.nitro"));
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
        v.accel = Some("kvm".into());
        assert!(validate(&v).unwrap_err().contains("vm.accel"));
        let mut v = vm();
        v.idle_pause_ms = Some(1000);
        assert!(validate(&v).unwrap_err().contains("idle_pause_ms"));
    }
}
