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

use serde::{Deserialize, Serialize};

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

/// First frame sent by the daemon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    /// controller protocol version ([`crate::PROTOCOL_VERSION`])
    pub protocol: u32,
    /// daemon version (crate version)
    pub version: String,
    /// optional features the daemon supports (e.g. `vfs.controller`, `net.external`)
    pub features: Vec<String>,
    /// daemon process id
    pub pid: u32,
}

/// Full session configuration, sent once before `start`.
///
/// `vfs` and `net` are owned by their subsystems and passed through as CBOR
/// values; `null`/absent disables the subsystem (no VFS service: every guest
/// filesystem request fails with `ENOSYS`; no network: no netdev at all).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Configure {
    pub vm: VmConfig,
    #[serde(default)]
    pub limits: Limits,
    /// enabled debug components (`exec`, `protocol`, `vfs`, `net`)
    #[serde(default)]
    pub debug: Vec<String>,
    /// VFS configuration (`{ mode: "controller" }` or a native mount table)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vfs: Option<Value>,
    /// network configuration (`{ mode: "external", socket_path }` or native config)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub net: Option<Value>,
}

/// QEMU/VM settings. Paths are paths on the daemon's machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VmConfig {
    /// VM backend: `qemu` (default) or `krun`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vmm: Option<String>,
    /// `gondolin-krun-runner` binary (vmm `krun`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub krun_runner_path: Option<String>,
    /// qemu binary (path or name looked up in `PATH`; empty: by guest arch)
    #[serde(default)]
    pub qemu_path: String,
    /// guest image selector (`name:tag`, build id or directory; empty: the
    /// default image) resolved by the daemon with `gondolin-assets`
    /// (downloading when needed); fills empty kernel/initrd/root disk paths.
    /// `configure_result.image` describes the resolved image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// guest architecture for `image` (`aarch64`/`x86_64`; default: from
    /// `qemu_path`, else the daemon's host)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    /// kernel image (empty when `image` provides it)
    #[serde(default)]
    pub kernel_path: String,
    /// initrd (empty when `image` provides it)
    #[serde(default)]
    pub initrd_path: String,
    /// root disk attached as `/dev/vda` (none: no root disk)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_disk: Option<RootDisk>,
    /// memory size in qemu syntax (e.g. `1G`)
    pub memory: String,
    /// vcpu count
    pub cpus: u32,
    /// qemu machine type override
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_type: Option<String>,
    /// qemu accelerator override (e.g. `kvm`, `hvf`, `tcg`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accel: Option<String>,
    /// qemu cpu model override
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<String>,
    /// guest console: `stdio` (default) or `none`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub console: Option<String>,
    /// kernel cmdline replacing the default (`console=... initramfs_async=1`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append: Option<String>,
    /// extra cmdline pieces appended to the base cmdline (e.g. `gondolin.tmpfs=...`)
    #[serde(default)]
    pub append_extra: Vec<String>,
    /// guest MAC address (`02:00:00:00:00:01` when absent)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
    /// restart the VM when it exits unexpectedly
    #[serde(default)]
    pub auto_restart: bool,
    /// pause the VM via QMP after this much idle time in `ms` (absent: never)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_pause_ms: Option<u64>,
}

/// Root disk attachment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootDisk {
    /// disk image (empty: the rootfs of `vm.image`)
    #[serde(default)]
    pub path: String,
    /// `raw` or `qcow2` (empty: the format of the image's rootfs)
    #[serde(default)]
    pub format: String,
    /// attach read-only
    #[serde(default)]
    pub read_only: bool,
    /// qemu `snapshot=on` (writes are discarded)
    #[serde(default)]
    pub snapshot: bool,
    /// prepare the disk in the daemon: `cow` (qcow2 overlay in the session
    /// directory), `memory` (writes discarded), `readonly`, or `auto` (the
    /// image manifest's `rootfsMode`, else `cow`); absent: use `path` as is
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// minimum virtual size in `bytes` (grows the overlay; needs a writable mode)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// Exec queueing limits (`SandboxServerOptions`); absent fields take the
/// node engine's defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Limits {
    /// max stdin chunk per message in `bytes`
    pub max_stdin_bytes: u64,
    /// max stdin buffered for one exec that has not started yet in `bytes`
    pub max_queued_stdin_bytes: u64,
    /// max stdin buffered across all not-yet-started execs in `bytes`
    pub max_total_queued_stdin_bytes: u64,
    /// max exec pressure (running + queued-to-start)
    pub max_queued_execs: u32,
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

/// Successful `start_result` fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartResult {
    /// always `true`
    pub ok: bool,
    /// private socket directory of this session
    pub socket_dir: String,
}

/// Guest activity reported by the controller (e.g. open network flows served
/// by the controller), used for the idle pause.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    /// activity source name (one counter per source)
    pub source: String,
    /// whether the source is active
    pub active: bool,
}

/// Sandbox state (`SandboxState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Starting,
    Running,
    Stopped,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Starting => "starting",
            State::Running => "running",
            State::Stopped => "stopped",
        }
    }
}

/// Global state change (emitted as `state` by the SDK and broadcast to clients).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    pub state: State,
    /// pid of the VMM process while one runs
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vmm_pid: Option<u32>,
}

/// Debug event (`SandboxServer` `debug` event).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Log {
    /// debug component (`exec`, `protocol`, `vfs`, `net`, `qemu`, `error`)
    pub component: String,
    pub message: String,
}

/// The VMM process exited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Exit {
    /// exit code (absent when killed by a signal or when it never started)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    /// terminating signal name (`SIGKILL`, ...)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    /// spawn failure message
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
