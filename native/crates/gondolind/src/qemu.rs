//! QEMU command line, kernel command line pieces, and the QEMU log tail used
//! for exit diagnostics.

use std::collections::VecDeque;
use std::path::PathBuf;

use gondolin_proto::session::VmConfig;

/// Default guest MAC address.
pub const DEFAULT_MAC: &str = "02:00:00:00:00:01";

/// Facts about the daemon's host that influence the QEMU command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostInfo {
    /// `linux`, `macos`, ... (Rust `std::env::consts::OS`)
    pub os: String,
    /// node-style architecture name (`arm64`, `x64`, ...)
    pub arch: String,
    /// whether `/dev/kvm` is readable and writable
    pub kvm_available: bool,
}

impl HostInfo {
    pub fn detect() -> Self {
        HostInfo {
            os: std::env::consts::OS.to_string(),
            arch: node_arch(std::env::consts::ARCH).to_string(),
            kvm_available: kvm_available(),
        }
    }

    fn is_linux(&self) -> bool {
        self.os == "linux"
    }

    fn is_darwin(&self) -> bool {
        self.os == "macos"
    }

    /// `getHostArch()`: `arm64` or `x64`.
    fn host_arch(&self) -> &'static str {
        if self.arch == "arm64" { "arm64" } else { "x64" }
    }
}

/// Maps a Rust architecture name to Node's `process.arch` spelling.
pub fn node_arch(arch: &str) -> &str {
    match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        other => other,
    }
}

fn kvm_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        let path = c"/dev/kvm";
        // SAFETY: `path` is a valid NUL-terminated string.
        unsafe { libc::access(path.as_ptr(), libc::R_OK | libc::W_OK) == 0 }
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Socket paths QEMU connects to (QEMU is the client, `server=off`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChardevPaths {
    pub control: PathBuf,
    pub fs: PathBuf,
    pub ssh: PathBuf,
    pub ingress: PathBuf,
}

/// Everything `build_qemu_args` needs.
#[derive(Debug, Clone)]
pub struct QemuArgs<'a> {
    pub vm: &'a VmConfig,
    /// final kernel command line
    pub append: &'a str,
    pub chardevs: &'a ChardevPaths,
    /// stream netdev socket (none: no network device)
    pub net_socket: Option<&'a str>,
    /// QMP monitor socket (idle pause)
    pub qmp_socket: Option<&'a str>,
    pub host: &'a HostInfo,
    /// vhost-user-fs device (guest RAM moves to a shared memory backend)
    pub virtiofs: Option<VirtioFsArgs<'a>>,
}

/// The virtio-fs device of a VM.
#[derive(Debug, Clone, Copy)]
pub struct VirtioFsArgs<'a> {
    /// vhost-user socket served by gondolind
    pub socket: &'a str,
    /// request queues (the device adds one high-priority queue)
    pub queues: usize,
    /// shared RAM backend (`memory-backend-memfd` or `memory-backend-shm`)
    pub memory_backend: &'static str,
}

/// virtio-fs mount tag the guest uses (`mount -t virtiofs gondolin ...`).
pub const VIRTIOFS_TAG: &str = "gondolin";

/// What a QEMU binary offers for virtio-fs (`-device help`, `-object help`)
/// and whether it lacks the microvm machine (`-machine help`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct VirtioFsSupport {
    /// the binary was probed and has no `microvm` machine (distribution
    /// builds such as Amazon Linux 2023's leave it out)
    pub microvm_missing: bool,
    /// `vhost-user-fs-pci` (PCI machines) is available
    pub pci: bool,
    /// `vhost-user-fs-device` (MMIO, microvm) is available
    pub mmio: bool,
    /// a shareable RAM backend usable on this host
    pub memory_backend: Option<&'static str>,
}

impl VirtioFsSupport {
    /// Whether a machine of type `machine` can get the device.
    pub fn usable(&self, machine: &str) -> bool {
        self.memory_backend.is_some() && if machine == "microvm" { self.mmio } else { self.pci }
    }
}

fn run_help(qemu: &str, args: &[&str]) -> String {
    use std::process::{Command, Stdio};
    let child = Command::new(qemu)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = child else { return String::new() };
    // bounded: a broken binary must not hang the daemon
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return String::new();
            }
        }
    }
    let out = child.wait_with_output().map(|o| {
        let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
        s.push_str(&String::from_utf8_lossy(&o.stderr));
        s
    });
    out.unwrap_or_default()
}

/// Parses `-device help` / `-object help` / `-machine help` output.
pub fn parse_virtiofs_support(
    devices: &str,
    objects: &str,
    machines: &str,
    host: &HostInfo,
) -> VirtioFsSupport {
    let has = |text: &str, name: &str| text.contains(&format!("\"{name}\""));
    let object = |name: &str| objects.lines().any(|l| l.trim() == name);
    let memory_backend = if host.is_linux() && object("memory-backend-memfd") {
        Some("memory-backend-memfd")
    } else if object("memory-backend-shm") {
        Some("memory-backend-shm")
    } else {
        None
    };
    // `microvm              microvm (i386)`; no output: not probed
    let microvm_missing = !machines.trim().is_empty()
        && !machines.lines().any(|l| l.split_whitespace().next() == Some("microvm"));
    VirtioFsSupport {
        microvm_missing,
        pci: has(devices, "vhost-user-fs-pci"),
        mmio: has(devices, "vhost-user-fs-device"),
        memory_backend,
    }
}

/// One binary's probe on disk: `((pci, mmio, memory backend), microvm missing)`.
type ProbeRecord = ((bool, bool, Option<String>), bool);

/// `q35` when the default machine for `vm` would be `microvm` but its QEMU
/// binary has none (probed once per binary, see [`probe_virtiofs`]);
/// `None` keeps the default. Blocking.
pub fn machine_fallback(vm: &VmConfig, host: &HostInfo) -> Option<&'static str> {
    if vm.machine_type.is_some() {
        return None;
    }
    let target_arch = detect_target_arch(&vm.qemu_path, host);
    let accel = vm.accel.clone().unwrap_or_else(|| select_accel(&target_arch, host).to_string());
    if select_machine_type(&target_arch, Some(&accel), host) != "microvm" {
        return None;
    }
    probe_virtiofs(&vm.qemu_path, host).microvm_missing.then_some("q35")
}

/// Probes (once per binary, keyed by path, size and mtime, cached in memory
/// and in `<cache>/gondolin/qemu-probe.json`) what `qemu` offers for
/// virtio-fs. Blocking.
pub fn probe_virtiofs(qemu: &str, host: &HostInfo) -> VirtioFsSupport {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, VirtioFsSupport>>> = OnceLock::new();
    let resolved = which(qemu).unwrap_or_else(|| std::path::PathBuf::from(qemu));
    let key = match std::fs::metadata(&resolved) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("{}|{}|{}", resolved.display(), m.len(), mtime)
        }
        Err(_) => return VirtioFsSupport::default(),
    };
    let cache = CACHE.get_or_init(Default::default);
    if let Some(s) = cache.lock().unwrap().get(&key) {
        return *s;
    }
    let disk = gondolin_assets::store::gondolin_cache_dir().join("qemu-probe.json");
    let mut on_disk: HashMap<String, ProbeRecord> = std::fs::read_to_string(&disk)
        .ok()
        .and_then(|t| gondolin_wire::json::parse(&t).ok())
        .and_then(|v| gondolin_wire::FromValue::from_value(&v).ok())
        .unwrap_or_default();
    let support = if let Some(((pci, mmio, backend), microvm_missing)) = on_disk.get(&key) {
        VirtioFsSupport {
            microvm_missing: *microvm_missing,
            pci: *pci,
            mmio: *mmio,
            memory_backend: match backend.as_deref() {
                Some("memory-backend-memfd") => Some("memory-backend-memfd"),
                Some("memory-backend-shm") => Some("memory-backend-shm"),
                _ => None,
            },
        }
    } else {
        let qemu_path = resolved.display().to_string();
        let devices = run_help(&qemu_path, &["-machine", "none", "-device", "help"]);
        let objects = run_help(&qemu_path, &["-machine", "none", "-object", "help"]);
        let machines = run_help(&qemu_path, &["-machine", "help"]);
        let support = parse_virtiofs_support(&devices, &objects, &machines, host);
        on_disk.insert(
            key.clone(),
            (
                (support.pci, support.mmio, support.memory_backend.map(str::to_string)),
                support.microvm_missing,
            ),
        );
        if let Some(parent) = disk.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = gondolin_wire::json::to_string(&gondolin_wire::ToValue::to_value(&on_disk));
        {
            let tmp = disk.with_extension(format!("json.{}", std::process::id()));
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &disk);
            }
        }
        support
    };
    cache.lock().unwrap().insert(key, support);
    support
}

pub(crate) fn which(program: &str) -> Option<std::path::PathBuf> {
    if program.contains('/') {
        return Some(std::path::PathBuf::from(program));
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(program)).find(|p| p.is_file())
}

/// `detectTargetArch`: guest architecture from the qemu binary name.
pub fn detect_target_arch(qemu_path: &str, host: &HostInfo) -> String {
    let lower = qemu_path.to_lowercase();
    if lower.contains("aarch64") || lower.contains("arm64") {
        return "arm64".into();
    }
    if lower.contains("x86_64") || lower.contains("x64") {
        return "x64".into();
    }
    host.arch.clone()
}

fn accel_name(accel: Option<&str>) -> String {
    accel.unwrap_or("").split(',').next().unwrap_or("").trim().to_lowercase()
}

/// `selectAccel`.
pub fn select_accel(target_arch: &str, host: &HostInfo) -> &'static str {
    if target_arch != host.host_arch() {
        return "tcg";
    }
    if host.is_linux() {
        return if host.kvm_available { "kvm" } else { "tcg" };
    }
    if host.is_darwin() {
        return "hvf";
    }
    "tcg"
}

/// `selectMachineType`.
pub fn select_machine_type(
    target_arch: &str,
    accel: Option<&str>,
    host: &HostInfo,
) -> &'static str {
    if host.is_linux() && target_arch == "x64" {
        // microvm is optimized for Linux/KVM but can hang under pure TCG
        return if accel_name(accel) == "kvm" { "microvm" } else { "q35" };
    }
    if target_arch == "arm64" {
        return "virt";
    }
    "q35"
}

/// `selectCpu`.
pub fn select_cpu(target_arch: &str, accel: Option<&str>, host: &HostInfo) -> &'static str {
    if target_arch != host.host_arch() {
        return "max";
    }
    let name = accel_name(accel);
    if host.is_linux() {
        return if name == "kvm" { "host" } else { "max" };
    }
    if host.is_darwin() {
        return if name == "hvf" { "host" } else { "max" };
    }
    "max"
}

/// Builds the QEMU argument vector (without the binary).
pub fn build_qemu_args(cfg: &QemuArgs<'_>) -> Vec<String> {
    let vm = cfg.vm;
    let mut args: Vec<String> = vec![
        "-nodefaults".into(),
        "-no-reboot".into(),
        "-m".into(),
        vm.memory.clone(),
        "-smp".into(),
        vm.cpus.to_string(),
        "-kernel".into(),
        vm.kernel_path.clone(),
        "-initrd".into(),
        vm.initrd_path.clone(),
        "-append".into(),
        cfg.append.to_string(),
        "-nographic".into(),
    ];

    let target_arch = detect_target_arch(&vm.qemu_path, cfg.host);
    let accel: Option<String> = match &vm.accel {
        Some(a) => Some(a.clone()),
        None => Some(select_accel(&target_arch, cfg.host).to_string()),
    };
    let machine_type = match &vm.machine_type {
        Some(m) => m.clone(),
        None => select_machine_type(&target_arch, accel.as_deref(), cfg.host).to_string(),
    };
    let microvm = machine_type == "microvm";

    if let Some(disk) = &vm.root_disk {
        let mut drive = format!("file={},format={},if=none,id=drive0", disk.path, disk.format);
        if disk.snapshot {
            drive.push_str(",snapshot=on");
        }
        if disk.read_only {
            drive.push_str(",readonly=on");
        }
        args.push("-drive".into());
        args.push(drive);
        // microvm has no PCI bus; use virtio-blk-device (MMIO) instead
        let blk = if microvm { "virtio-blk-device" } else { "virtio-blk-pci" };
        args.push("-device".into());
        args.push(format!("{blk},drive=drive0"));
    }
    args.push("-machine".into());
    let memory_backend = cfg.virtiofs.map(|_| ",memory-backend=mem").unwrap_or("");
    if microvm {
        args.push(format!("microvm,isa-serial=on,auto-kernel-cmdline=on{memory_backend}"));
    } else {
        args.push(format!("{machine_type}{memory_backend}"));
    }
    if let Some(fs) = cfg.virtiofs {
        // vhost-user devices need guest RAM in shared memory
        args.push("-object".into());
        args.push(format!("{},id=mem,size={},share=on", fs.memory_backend, vm.memory));
        args.push("-chardev".into());
        args.push(format!("socket,id=vhostfs0,path={}", fs.socket));
        let dev = if microvm { "vhost-user-fs-device" } else { "vhost-user-fs-pci" };
        args.push("-device".into());
        args.push(format!(
            "{dev},chardev=vhostfs0,tag={VIRTIOFS_TAG},queue-size=1024,num-request-queues={}",
            fs.queues.max(1)
        ));
    }

    if let Some(a) = accel.as_deref().filter(|a| !a.is_empty()) {
        args.push("-accel".into());
        args.push(a.to_string());
    }

    let cpu = match &vm.cpu {
        Some(c) => c.clone(),
        None => select_cpu(&target_arch, accel.as_deref(), cfg.host).to_string(),
    };
    if !cpu.is_empty() {
        args.push("-cpu".into());
        args.push(cpu);
    }

    args.push("-serial".into());
    if vm.console.as_deref() == Some("none") {
        // keep the serial device (needed for e.g. the microvm ttyS0 console) but discard output
        args.push("null".into());
    } else {
        args.push("stdio".into());
    }

    let (rng_dev, serial_dev, net_dev) = if microvm {
        ("virtio-rng-device", "virtio-serial-device", "virtio-net-device")
    } else {
        ("virtio-rng-pci", "virtio-serial-pci", "virtio-net-pci")
    };

    args.push("-object".into());
    args.push("rng-random,filename=/dev/urandom,id=rng0".into());
    args.push("-device".into());
    args.push(format!("{rng_dev},rng=rng0"));
    let chardevs = [
        ("virtiocon0", &cfg.chardevs.control),
        ("virtiofs0", &cfg.chardevs.fs),
        ("virtiossh0", &cfg.chardevs.ssh),
        ("virtioingress0", &cfg.chardevs.ingress),
    ];
    for (id, path) in chardevs {
        args.push("-chardev".into());
        args.push(format!("socket,id={id},path={},server=off", path.display()));
    }
    args.push("-device".into());
    args.push(format!("{serial_dev},id=virtio-serial0"));
    for (chardev, name) in [
        ("virtiocon0", "virtio-port"),
        ("virtiofs0", "virtio-fs"),
        ("virtiossh0", "virtio-ssh"),
        ("virtioingress0", "virtio-ingress"),
    ] {
        args.push("-device".into());
        args.push(format!("virtserialport,chardev={chardev},name={name},bus=virtio-serial0.0"));
    }

    if let Some(net) = cfg.net_socket {
        args.push("-netdev".into());
        args.push(format!("stream,id=net0,server=off,addr.type=unix,addr.path={net}"));
        let mac = vm.mac.as_deref().unwrap_or(DEFAULT_MAC);
        args.push("-device".into());
        args.push(format!("{net_dev},netdev=net0,mac={mac}"));
    }

    if let Some(qmp) = cfg.qmp_socket {
        args.push("-qmp".into());
        args.push(format!("unix:{qmp},server=on,wait=off"));
    }

    args
}

/// Default kernel command line (`SandboxServer` constructor, qemu backend).
pub fn default_append(host: &HostInfo) -> String {
    let console = if host.arch == "arm64" { "ttyAMA0" } else { "ttyS0" };
    format!("console={console} initramfs_async=1")
}

/// Whether the configuration selects the libkrun backend.
pub fn is_krun(vm: &VmConfig) -> bool {
    vm.vmm.as_deref() == Some("krun")
}

/// Base kernel command line: `append` (or the default) plus extra pieces.
pub fn base_append(vm: &VmConfig, host: &HostInfo) -> String {
    let first = vm.append.clone().unwrap_or_else(|| {
        if is_krun(vm) { crate::krun::DEFAULT_APPEND.to_string() } else { default_append(host) }
    });
    std::iter::once(first.trim().to_string())
        .chain(vm.append_extra.iter().map(|s| s.to_string()))
        .filter(|piece| !piece.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether someone reads the guest's boot log: the console is explicitly
/// `stdio`, or protocol debugging (which forwards it) is on.
pub fn boot_log_wanted(vm: &VmConfig, protocol_debug: bool) -> bool {
    vm.console.as_deref() == Some("stdio") || protocol_debug
}

/// `append` plus `quiet` unless the boot log is wanted ([`boot_log_wanted`])
/// or `append` already sets the log level (`quiet`, `debug`, `loglevel=`).
/// The kernel writes its boot log to the console inline whether or not anyone
/// reads it, which costs ~0.9 s per boot on an emulated UART (QEMU's `ttyS0`
/// and `ttyAMA0`); errors and panics still get through
/// under `quiet`, and the guest's init stays quiet too. krun is left alone:
/// its virtio console is cheap (~14 ms per boot).
pub fn quiet_boot(append: String, vm: &VmConfig, protocol_debug: bool) -> String {
    let sets_level = append
        .split_whitespace()
        .any(|a| a == "quiet" || a == "debug" || a.starts_with("loglevel="));
    if is_krun(vm) || boot_log_wanted(vm, protocol_debug) || sets_level {
        append
    } else {
        format!("{append} quiet")
    }
}

/// Bounded tail of QEMU's stderr lines used to enrich exit errors. stdout is
/// never used for hints because it may carry untrusted guest console output.
#[derive(Debug, Default)]
pub struct LogTail {
    lines: VecDeque<String>,
    stdout_buf: Vec<u8>,
    stderr_buf: Vec<u8>,
}

/// Maximum number of remembered stderr lines.
const TAIL_LINES: usize = 50;
/// Maximum bytes of one unterminated line kept in the line buffers.
const MAX_LINE_BYTES: usize = 64 * 1024;

impl LogTail {
    pub fn clear(&mut self) {
        self.lines.clear();
        self.stdout_buf.clear();
        self.stderr_buf.clear();
    }

    /// Feeds a chunk of QEMU output and returns the complete lines it finished
    /// (normalized, for debug logging).
    pub fn push(&mut self, stderr: bool, chunk: &[u8]) -> Vec<String> {
        let mut done = Vec::new();
        let buf = if stderr { &mut self.stderr_buf } else { &mut self.stdout_buf };
        buf.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            lines.push(line);
        }
        if buf.len() > MAX_LINE_BYTES {
            // an endless line: cut it into a line of its own
            lines.push(std::mem::take(buf));
        }
        for line in lines {
            let text = String::from_utf8_lossy(&line);
            if let Some(normalized) = normalize_hint_line(&text) {
                if stderr {
                    self.record(normalized.clone());
                }
                done.push(normalized);
            }
        }
        done
    }

    /// Flushes unterminated lines (on exit); returns them like [`LogTail::push`]
    /// as `(stderr, line)` pairs.
    pub fn flush(&mut self) -> Vec<(bool, String)> {
        let mut out = Vec::new();
        for stderr in [true, false] {
            let buf = if stderr { &mut self.stderr_buf } else { &mut self.stdout_buf };
            if buf.is_empty() {
                continue;
            }
            let text = String::from_utf8_lossy(&std::mem::take(buf)).into_owned();
            if let Some(normalized) = normalize_hint_line(&text) {
                if stderr {
                    self.record(normalized.clone());
                }
                out.push((stderr, normalized));
            }
        }
        out
    }

    fn record(&mut self, line: String) {
        self.lines.push_back(line);
        while self.lines.len() > TAIL_LINES {
            self.lines.pop_front();
        }
    }

    /// `selectQemuHintLine`: the last line that is not low-value noise, or the
    /// last line.
    pub fn select_hint(&self) -> Option<&str> {
        self.lines
            .iter()
            .rev()
            .find(|l| !is_low_value_hint_line(l))
            .or_else(|| self.lines.back())
            .map(String::as_str)
    }

    /// `formatQemuLogHint`: ` (qemu: <line>)` or an empty string.
    pub fn format_hint(&self) -> String {
        self.format_hint_for("qemu")
    }

    /// [`LogTail::format_hint`] with the backend label (`qemu`, `krun`).
    pub fn format_hint_for(&self, label: &str) -> String {
        let Some(hint) = self.select_hint() else {
            return String::new();
        };
        let truncated = if hint.chars().count() > 300 {
            format!("{}…", hint.chars().take(300).collect::<String>())
        } else {
            hint.to_string()
        };
        format!(" ({label}: {truncated})")
    }
}

/// `normalizeQemuHintLine`: strips the trailing newline, ANSI sequences and
/// control characters; `None` for empty lines.
pub fn normalize_hint_line(line: &str) -> Option<String> {
    let line = line.strip_suffix("\r\n").or_else(|| line.strip_suffix('\n')).unwrap_or(line);
    let trimmed = line.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    let cleaned = strip_controls(trimmed);
    let cleaned = cleaned.trim_end();
    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned.to_string())
}

fn strip_controls(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\x1b' && i + 1 < chars.len() {
            // CSI: ESC [ params(0x30-0x3f)* intermediates(0x20-0x2f)* final(0x40-0x7e)
            if chars[i + 1] == '[' {
                let mut j = i + 2;
                while j < chars.len() && ('\x30'..='\x3f').contains(&chars[j]) {
                    j += 1;
                }
                while j < chars.len() && ('\x20'..='\x2f').contains(&chars[j]) {
                    j += 1;
                }
                if j < chars.len() && ('\x40'..='\x7e').contains(&chars[j]) {
                    i = j + 1;
                    continue;
                }
            } else if chars[i + 1] == ']' {
                // OSC: ESC ] ... (BEL | ESC \)
                let mut j = i + 2;
                let mut end = None;
                while j < chars.len() {
                    if chars[j] == '\x07' {
                        end = Some(j + 1);
                        break;
                    }
                    if chars[j] == '\x1b' && j + 1 < chars.len() && chars[j + 1] == '\\' {
                        end = Some(j + 2);
                        break;
                    }
                    j += 1;
                }
                if let Some(end) = end {
                    i = end;
                    continue;
                }
            }
        }
        let code = c as u32;
        let is_control = (code <= 0x08)
            || code == 0x0b
            || code == 0x0c
            || (0x0e..=0x1f).contains(&code)
            || code == 0x7f;
        if !is_control && c != '\r' {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// `isLowValueQemuHintLine`: lines that make poor error hints (Zig stack
/// traces, source excerpts, leak reports).
pub fn is_low_value_hint_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t == "^" || t == "(additional stack frames may have been skipped...)" {
        return true;
    }
    if t.starts_with("???:??:?:") {
        return true;
    }
    if let Some(rest) = t.strip_prefix("error(DebugAllocator): memory address ")
        && rest.contains(" leaked:")
    {
        return true;
    }
    if let Some(rest) = t.strip_prefix("error: ") {
        let mut chars = rest.chars();
        if let Some(first) = chars.next()
            && first.is_ascii_uppercase()
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return true;
        }
    }
    if has_zig_frame(t) {
        return true;
    }
    if t == "}" || t.starts_with("_ =") {
        return true;
    }
    for kw in ["return", "try", "const", "var", "if", "defer"] {
        if let Some(rest) = t.strip_prefix(kw)
            && !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
        {
            return true;
        }
    }
    t.starts_with("std.")
}

/// Matches `/\.zig:\d+:\d+:\s+0x[0-9a-f]+ in /`.
fn has_zig_frame(t: &str) -> bool {
    let bytes = t.as_bytes();
    let mut start = 0;
    while let Some(off) = t[start..].find(".zig:") {
        let mut i = start + off + 5;
        let digits = |i: &mut usize| {
            let s = *i;
            while *i < bytes.len() && bytes[*i].is_ascii_digit() {
                *i += 1;
            }
            *i > s
        };
        let ok = (|| {
            if !digits(&mut i) || bytes.get(i) != Some(&b':') {
                return false;
            }
            i += 1;
            if !digits(&mut i) || bytes.get(i) != Some(&b':') {
                return false;
            }
            i += 1;
            let ws = i;
            while i < bytes.len() && (bytes[i] as char).is_ascii_whitespace() {
                i += 1;
            }
            if i == ws || !t[i..].starts_with("0x") {
                return false;
            }
            i += 2;
            let hex = i;
            while i < bytes.len() && matches!(bytes[i], b'0'..=b'9' | b'a'..=b'f') {
                i += 1;
            }
            i > hex && t[i..].starts_with(" in ")
        })();
        if ok {
            return true;
        }
        start += off + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use gondolin_proto::session::RootDisk;

    fn vm() -> VmConfig {
        VmConfig {
            qemu_path: "qemu-system-aarch64".into(),
            image: None,
            vmm: None,
            krun_runner_path: None,
            arch: None,
            kernel_path: "/img/vmlinuz".into(),
            initrd_path: "/img/initrd".into(),
            root_disk: Some(RootDisk {
                path: "/img/root.qcow2".into(),
                format: "qcow2".into(),
                read_only: false,
                snapshot: false,
                mode: None,
                size: None,
            }),
            memory: "1G".into(),
            cpus: 2,
            machine_type: None,
            accel: None,
            cpu: None,
            console: Some("none".into()),
            append: None,
            append_extra: vec![],
            mac: None,
            auto_restart: false,
            idle_pause_ms: None,
        }
    }

    fn chardevs() -> ChardevPaths {
        ChardevPaths {
            control: "/s/c.sock".into(),
            fs: "/s/f.sock".into(),
            ssh: "/s/s.sock".into(),
            ingress: "/s/i.sock".into(),
        }
    }

    fn mac_arm() -> HostInfo {
        HostInfo { os: "macos".into(), arch: "arm64".into(), kvm_available: false }
    }

    #[test]
    fn darwin_arm64_defaults() {
        let vm = vm();
        let c = chardevs();
        let host = mac_arm();
        let args = build_qemu_args(&QemuArgs {
            vm: &vm,
            append: "console=ttyAMA0",
            chardevs: &c,
            net_socket: Some("/s/net.sock"),
            qmp_socket: None,
            virtiofs: None,
            host: &host,
        });
        let joined = args.join(" ");
        assert!(joined.contains("-machine virt -accel hvf -cpu host -serial null"));
        assert!(joined.contains(
            "-drive file=/img/root.qcow2,format=qcow2,if=none,id=drive0 -device virtio-blk-pci,drive=drive0"
        ));
        assert!(joined.contains("-chardev socket,id=virtiocon0,path=/s/c.sock,server=off"));
        assert!(joined.contains(
            "-netdev stream,id=net0,server=off,addr.type=unix,addr.path=/s/net.sock -device virtio-net-pci,netdev=net0,mac=02:00:00:00:00:01"
        ));
        assert!(!joined.contains("-qmp"));
    }

    #[test]
    fn virtiofs_device_and_shared_memory() {
        let vm = vm();
        let c = chardevs();
        let fs =
            VirtioFsArgs { socket: "/s/vfs.sock", queues: 2, memory_backend: "memory-backend-shm" };
        let args = build_qemu_args(&QemuArgs {
            vm: &vm,
            append: "x",
            chardevs: &c,
            net_socket: None,
            qmp_socket: None,
            virtiofs: Some(fs),
            host: &mac_arm(),
        });
        let joined = args.join(" ");
        assert!(joined.contains("-machine virt,memory-backend=mem"));
        assert!(joined.contains("-object memory-backend-shm,id=mem,size=1G,share=on"));
        assert!(joined.contains("-chardev socket,id=vhostfs0,path=/s/vfs.sock"));
        assert!(joined.contains(
            "-device vhost-user-fs-pci,chardev=vhostfs0,tag=gondolin,queue-size=1024,num-request-queues=2"
        ));
        // microvm: the MMIO device and memfd on Linux
        let mut vm = vm.clone();
        vm.qemu_path = "qemu-system-x86_64".into();
        let host = HostInfo { os: "linux".into(), arch: "x64".into(), kvm_available: true };
        let fs = VirtioFsArgs { memory_backend: "memory-backend-memfd", ..fs };
        let args = build_qemu_args(&QemuArgs {
            vm: &vm,
            append: "x",
            chardevs: &c,
            net_socket: None,
            qmp_socket: None,
            virtiofs: Some(fs),
            host: &host,
        });
        let joined = args.join(" ");
        assert!(joined.contains("microvm,isa-serial=on,auto-kernel-cmdline=on,memory-backend=mem"));
        assert!(joined.contains("-object memory-backend-memfd,id=mem,size=1G,share=on"));
        assert!(joined.contains("-device vhost-user-fs-device,chardev=vhostfs0"));
    }

    #[test]
    fn virtiofs_support_parsing() {
        let devices = "name \"virtio-blk-pci\", bus PCI\nname \"vhost-user-fs-device\", bus virtio-bus\nname \"vhost-user-fs-pci\", bus PCI\n";
        let objects = "List of user creatable objects:\n  memory-backend-file\n  memory-backend-memfd\n  memory-backend-shm\n";
        let linux = HostInfo { os: "linux".into(), arch: "x64".into(), kvm_available: true };
        let s = parse_virtiofs_support(devices, objects, "", &linux);
        assert_eq!(s.memory_backend, Some("memory-backend-memfd"));
        assert!(s.usable("q35") && s.usable("microvm"));
        let s = parse_virtiofs_support(devices, objects, "", &mac_arm());
        assert_eq!(s.memory_backend, Some("memory-backend-shm"));
        // Homebrew QEMU: no vhost-user devices
        let s =
            parse_virtiofs_support("name \"virtio-blk-pci\", bus PCI\n", objects, "", &mac_arm());
        assert!(!s.usable("virt"));
        let s = parse_virtiofs_support(devices, "  memory-backend-file\n", "", &mac_arm());
        assert!(!s.usable("virt"));
        assert!(!s.microvm_missing, "not probed: assume the default works");

        // `-machine help` of a build with and without microvm
        let with = "Supported machines are:\nmicrovm              microvm (i386)\nq35                  Standard PC (Q35 + ICH9, 2009)\n";
        let without = "Supported machines are:\npc                   Standard PC\nq35                  Standard PC (Q35 + ICH9, 2009)\n";
        assert!(!parse_virtiofs_support(devices, objects, with, &linux).microvm_missing);
        assert!(parse_virtiofs_support(devices, objects, without, &linux).microvm_missing);
    }

    #[test]
    fn linux_x64_kvm_uses_microvm() {
        let mut vm = vm();
        vm.qemu_path = "qemu-system-x86_64".into();
        vm.root_disk.as_mut().unwrap().snapshot = true;
        vm.root_disk.as_mut().unwrap().read_only = true;
        vm.console = None;
        let c = chardevs();
        let host = HostInfo { os: "linux".into(), arch: "x64".into(), kvm_available: true };
        let args = build_qemu_args(&QemuArgs {
            vm: &vm,
            append: "x",
            chardevs: &c,
            net_socket: None,
            qmp_socket: Some("/s/qmp.sock"),
            virtiofs: None,
            host: &host,
        });
        let joined = args.join(" ");
        assert!(joined.contains("snapshot=on,readonly=on -device virtio-blk-device,drive=drive0"));
        assert!(joined.contains(
            "-machine microvm,isa-serial=on,auto-kernel-cmdline=on -accel kvm -cpu host"
        ));
        assert!(joined.contains("-serial stdio"));
        assert!(joined.contains("virtio-serial-device,id=virtio-serial0"));
        assert!(joined.ends_with("-qmp unix:/s/qmp.sock,server=on,wait=off"));
        // no kvm: q35 + tcg + max
        let host = HostInfo { kvm_available: false, ..host };
        let args = build_qemu_args(&QemuArgs {
            vm: &vm,
            append: "x",
            chardevs: &c,
            net_socket: None,
            qmp_socket: None,
            virtiofs: None,
            host: &host,
        });
        assert!(args.join(" ").contains("-machine q35 -accel tcg -cpu max"));
    }

    #[test]
    fn cross_arch_is_tcg() {
        let mut vm = vm();
        vm.qemu_path = "/usr/bin/qemu-system-x86_64".into();
        let c = chardevs();
        let args = build_qemu_args(&QemuArgs {
            vm: &vm,
            append: "x",
            chardevs: &c,
            net_socket: None,
            qmp_socket: None,
            virtiofs: None,
            host: &mac_arm(),
        });
        assert!(args.join(" ").contains("-machine q35 -accel tcg -cpu max"));
    }

    #[test]
    fn appends() {
        let mut vm = vm();
        vm.append_extra = vec!["gondolin.tmpfs=none".into(), String::new()];
        assert_eq!(
            base_append(&vm, &mac_arm()),
            "console=ttyAMA0 initramfs_async=1 gondolin.tmpfs=none"
        );
        vm.append = Some("  console=hvc0 ".into());
        assert_eq!(base_append(&vm, &mac_arm()), "console=hvc0 gondolin.tmpfs=none");
    }

    #[test]
    fn boots_quiet_unless_the_boot_log_is_wanted() {
        let a = || "console=ttyS0 initramfs_async=1".to_string();
        for vmm in [None, Some("qemu")] {
            let mut vm = vm();
            vm.vmm = vmm.map(String::from);
            vm.console = None;
            assert_eq!(quiet_boot(a(), &vm, false), format!("{} quiet", a()), "{vmm:?}");
            // protocol debugging and an explicit stdio console show the log
            assert_eq!(quiet_boot(a(), &vm, true), a());
            vm.console = Some("stdio".into());
            assert_eq!(quiet_boot(a(), &vm, false), a());
            // `none` discards it anyway
            vm.console = Some("none".into());
            assert!(quiet_boot(a(), &vm, false).ends_with(" quiet"));
            // a command line that sets the log level itself is left alone
            for level in ["quiet", "debug", "loglevel=7"] {
                let own = format!("console=ttyS0 {level}");
                assert_eq!(quiet_boot(own.clone(), &vm, false), own);
            }
        }
        // krun's virtio console is cheap: its boot log stays
        let mut vm = vm();
        vm.vmm = Some("krun".into());
        vm.console = None;
        assert_eq!(quiet_boot(a(), &vm, false), a());
    }

    #[test]
    fn hint_selection() {
        let mut tail = LogTail::default();
        tail.push(true, b"qemu-system-aarch64: -drive foo: Could not open\n");
        tail.push(true, b"/x/y.zig:12:5: 0xdeadbeef in main (sandboxd)\n    return x;\n");
        tail.push(false, b"guest console line\n");
        assert_eq!(tail.format_hint(), " (qemu: qemu-system-aarch64: -drive foo: Could not open)");
        tail.push(true, b"\x1b[31mred\x1b[0m \x1b]0;title\x07end\x01\r\n");
        assert_eq!(tail.select_hint(), Some("red end"));
        tail.push(true, b"partial");
        assert_eq!(tail.flush(), vec![(true, "partial".to_string())]);
        assert_eq!(tail.select_hint(), Some("partial"));
        tail.clear();
        assert_eq!(tail.format_hint(), "");
    }

    #[test]
    fn low_value_lines() {
        for line in [
            "^",
            "???:??:?: 0x1 in ??? (???)",
            "error(DebugAllocator): memory address 0x1 leaked: ",
            "error: OutOfMemory",
            "const x = 1;",
            "if (a) {",
            "std.debug.print",
            "_ = foo;",
            "}",
        ] {
            assert!(is_low_value_hint_line(line), "{line}");
        }
        for line in ["error: out of memory", "constant failure", "qemu: failed"] {
            assert!(!is_low_value_hint_line(line), "{line}");
        }
    }
}
