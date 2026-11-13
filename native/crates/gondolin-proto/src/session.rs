//! Session messages: handshake, configuration and VM lifecycle.
//!
//! | dir | type | payload |
//! |---|---|---|
//! | d→c | `hello` | [`Hello`], always the first frame |
//! | c→d | `configure` (request) | [`Configure`] |
//! | c→d | `start` (request) | `{}`: create the private socket directory, listen on the guest channels, start subsystems (QEMU is booted by the first client `boot`) |
//! | c→d | `shutdown` (request) | `{}`: stop the VM, answer, exit |
//! | c→d | `activity` | [`Activity`]: guest activity observed by the controller (idle pause) |
//! | d→c | `status` | [`Status`] |
//! | d→c | `log` | [`Log`] (debug events) |
//! | d→c | `exit` | [`Exit`]: the VMM process exited |
//! | d→c | `error` | [`crate::ErrorEvent`]: asynchronous errors (`SandboxServer` `error` events) |

use crate::Value;

pub const HELLO: &str = "hello";
pub const CONFIGURE: &str = "configure";
pub const START: &str = "start";
pub const SHUTDOWN: &str = "shutdown";
pub const ACTIVITY: &str = "activity";
pub const STATUS: &str = "status";
pub const LOG: &str = "log";
pub const EXIT: &str = "exit";
pub const ERROR: &str = "error";

gondolin_wire::wire_struct! {
    /// First frame sent by the daemon.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Hello {
        /// controller protocol version ([`crate::PROTOCOL_VERSION`])
        pub protocol: u32,
        /// daemon version (crate version)
        pub version: String,
        /// optional features the daemon supports (e.g. `net.native`, `djs_hooks`)
        pub features: Vec<String>,
        /// daemon process id
        pub pid: u32,
    }
}

gondolin_wire::wire_struct! {
    /// Full session configuration, sent once before `start`.
    ///
    /// `vfs` and `net` are owned by their subsystems and passed through as CBOR
    /// values; `null`/absent disables the subsystem (no VFS service: every guest
    /// filesystem request fails with `ENOSYS`; no network: no netdev at all).
    #[derive(Debug, Clone, PartialEq)]
    pub struct Configure {
        pub vm: VmConfig,
        pub limits: Limits = Default::default(),
        /// enabled debug components (`exec`, `protocol`, `vfs`, `net`)
        pub debug: Vec<String> = Default::default(),
        /// VFS configuration (a native mount table, `{ mode: "native", ... }`)
        pub vfs: Option<Value>,
        /// network configuration (`{ mode: "native", ... }`; or the deprecated `external`/`relay` fallbacks)
        pub net: Option<Value>,
    }
}

gondolin_wire::wire_struct! {
    /// QEMU/VM settings. Paths are paths on the daemon's machine.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct VmConfig {
        /// VM backend: `qemu` (default), `krun` or `firecracker`
        pub vmm: Option<String>,
        /// `gondolin-krun-runner` binary (vmm `krun`)
        pub krun_runner_path: Option<String>,
        /// `firecracker` binary (vmm `firecracker`; absent: `firecracker` in `PATH`)
        pub firecracker_path: Option<String>,
        /// AWS Nitro Sandbox settings (vmm `firecracker`; absent: the daemon
        /// picks a Nitro Sandbox when the host supports them, else KVM; mode
        /// `off` asks for KVM)
        pub nitro: Option<NitroConfig>,
        /// qemu binary (path or name looked up in `PATH`; empty: by guest arch)
        pub qemu_path: String = Default::default(),
        /// guest image selector (`name:tag`, build id or directory; empty: the
        /// default image) resolved by the daemon with `gondolin-assets`
        /// (downloading when needed); fills empty kernel/initrd/root disk paths.
        /// `configure_result.image` describes the resolved image.
        pub image: Option<String>,
        /// guest architecture for `image` (`aarch64`/`x86_64`; default: from
        /// `qemu_path`, else the daemon's host)
        pub arch: Option<String>,
        /// kernel image (empty when `image` provides it)
        pub kernel_path: String = Default::default(),
        /// initrd (empty when `image` provides it)
        pub initrd_path: String = Default::default(),
        /// root disk attached as `/dev/vda` (none: no root disk)
        pub root_disk: Option<RootDisk>,
        /// memory size in qemu syntax (e.g. `1G`)
        pub memory: String,
        /// vcpu count
        pub cpus: u32,
        /// qemu machine type override
        pub machine_type: Option<String>,
        /// qemu accelerator override (e.g. `kvm`, `hvf`, `tcg`)
        pub accel: Option<String>,
        /// qemu cpu model override
        pub cpu: Option<String>,
        /// guest console: `stdio` (default) or `none` (vmm `firecracker`: off
        /// unless `stdio` or protocol debugging, see `firecracker::wants_console`)
        pub console: Option<String>,
        /// kernel cmdline replacing the default (`console=... initramfs_async=1`)
        pub append: Option<String>,
        /// extra cmdline pieces appended to the base cmdline (e.g. `gondolin.tmpfs=...`)
        pub append_extra: Vec<String> = Default::default(),
        /// guest MAC address (`02:00:00:00:00:01` when absent)
        pub mac: Option<String>,
        /// restart the VM when it exits unexpectedly
        pub auto_restart: bool = Default::default(),
        /// pause the VM via QMP after this much idle time in `ms` (absent: never)
        pub idle_pause_ms: Option<u64>,
    }
}

gondolin_wire::wire_struct! {
    /// AWS Nitro Sandbox settings (vmm `firecracker`).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct NitroConfig {
        /// `direct` (the parent instance can read guest memory; no attestation)
        /// or `confidential` (needs a guest kernel with the DMB virtio patches)
        pub mode: String = String::from("direct"),
        /// time-share the vCPUs over the parent's CPUs instead of claiming
        /// dedicated cores from the Nitro Enclaves CPU pool
        pub cpu_overcommit: bool = true,
    }
}

gondolin_wire::wire_struct! {
    /// Root disk attachment.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct RootDisk {
        /// disk image (empty: the rootfs of `vm.image`)
        pub path: String = Default::default(),
        /// `raw` or `qcow2` (empty: the format of the image's rootfs)
        pub format: String = Default::default(),
        /// attach read-only
        pub read_only: bool = Default::default(),
        /// qemu `snapshot=on` (writes are discarded)
        pub snapshot: bool = Default::default(),
        /// prepare the disk in the daemon: `cow` (qcow2 overlay in the session
        /// directory), `memory` (writes discarded), `readonly`, `auto` (the
        /// image manifest's `rootfsMode`, else `cow`) or `checkpoint` (an overlay
        /// on the `checkpoint_import`ed file); absent: use `path` as is
        pub mode: Option<String>,
        /// minimum virtual size in `bytes` (grows the overlay, or `path` in place without a mode; needs a writable disk)
        pub size: Option<u64>,
    }
}

gondolin_wire::wire_struct! {
    /// Exec queueing limits (`SandboxServerOptions`); absent fields take the
    /// node engine's defaults.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Limits {
        /// max stdin chunk per message in `bytes`
        pub max_stdin_bytes: u64 = Limits::default().max_stdin_bytes,
        /// max stdin buffered for one exec that has not started yet in `bytes`
        pub max_queued_stdin_bytes: u64 = Limits::default().max_queued_stdin_bytes,
        /// max stdin buffered across all not-yet-started execs in `bytes`
        pub max_total_queued_stdin_bytes: u64 = Limits::default().max_total_queued_stdin_bytes,
        /// max exec pressure (running + queued-to-start)
        pub max_queued_execs: u32 = Limits::default().max_queued_execs,
    }
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_stdin_bytes: 64 * 1024,
            max_queued_stdin_bytes: 8 * 1024 * 1024,
            max_total_queued_stdin_bytes: 32 * 1024 * 1024,
            max_queued_execs: 64,
        }
    }
}

gondolin_wire::wire_struct! {
    /// Successful `start_result` fields.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct StartResult {
        /// always `true`
        pub ok: bool,
        /// private socket directory of this session
        pub socket_dir: String,
    }
}

gondolin_wire::wire_struct! {
    /// Guest activity reported by the controller (e.g. open network flows served
    /// by the controller), used for the idle pause.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Activity {
        /// activity source name (one counter per source)
        pub source: String,
        /// whether the source is active
        pub active: bool,
    }
}

gondolin_wire::wire_enum! {
    /// Sandbox state (`SandboxState`).
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum State {
        Starting = "starting",
        Running = "running",
        Stopped = "stopped",
    }
}

gondolin_wire::wire_struct! {
    /// Global state change (emitted as `state` by the SDK and broadcast to clients).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Status {
        pub state: State,
        /// pid of the VMM process while one runs
        pub vmm_pid: Option<u32>,
    }
}

gondolin_wire::wire_struct! {
    /// Debug event (`SandboxServer` `debug` event).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Log {
        /// debug component (`exec`, `protocol`, `vfs`, `net`, `qemu`, `error`)
        pub component: String,
        pub message: String,
    }
}

gondolin_wire::wire_struct! {
    /// The VMM process exited.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Exit {
        /// exit code (absent when killed by a signal or when it never started)
        pub code: Option<i32>,
        /// terminating signal name (`SIGKILL`, ...)
        pub signal: Option<String>,
        /// spawn failure message
        pub error: Option<String>,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gondolin_wire::{decode, encode};

    #[test]
    fn configure_defaults() {
        // a minimal configure as the TS side sends it
        let v = Value::Map(vec![(
            Value::Text("vm".into()),
            Value::Map(vec![
                (Value::Text("qemu_path".into()), Value::Text("qemu-system-aarch64".into())),
                (Value::Text("kernel_path".into()), Value::Text("/k".into())),
                (Value::Text("initrd_path".into()), Value::Text("/i".into())),
                (Value::Text("memory".into()), Value::Text("1G".into())),
                (Value::Text("cpus".into()), Value::Integer(2.into())),
            ]),
        )]);
        let bytes = encode(&v).unwrap();
        let cfg: Configure = decode(&bytes).unwrap();
        assert_eq!(cfg.limits, Limits::default());
        assert!(cfg.vfs.is_none());
        assert!(cfg.vm.root_disk.is_none());
        assert!(!cfg.vm.auto_restart);
        let again: Configure = decode(&encode(&cfg).unwrap()).unwrap();
        assert_eq!(again, cfg);
    }

    #[test]
    fn status_encoding() {
        let s = Status { state: State::Running, vmm_pid: None };
        let v: Value = decode(&encode(&s).unwrap()).unwrap();
        let map = v.as_map().unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map[0].1, Value::Text("running".into()));
    }
}
