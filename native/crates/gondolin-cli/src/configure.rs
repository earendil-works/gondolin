//! The `configure` payload for CLI options: the Rust counterpart of
//! `VM.create()` + `NativeSandboxServer.buildConfigure()` for the options the
//! CLI can express (`buildVmOptions` in `host/bin/gondolin.ts`).
//!
//! The payload is built as JSON with byte strings as `{ "$base64": "..." }`
//! (the `--print-configure` format shared with the Node CLI) and converted to
//! CBOR for the in-process session. `host/test/cli-configure-parity.test.ts`
//! compares both CLIs' payloads.

use std::path::{Path, PathBuf};

use gondolin_assets::{Arch, Assets, ProgressEvent, ResolvedImage, RootfsMode};
use gondolin_proto::session::{NitroConfig, RootDisk, VmConfig};
use gondolin_wire::Value as Json;
use gondolin_wire::Value;

use crate::args::{CommonOptions, parse_disk_size};
use crate::netcfg;

/// Guest mount point of the sandboxfs tree.
pub const FUSE_MOUNT: &str = "/data";
/// Guest path of the MITM CA mount.
pub const MITM_MOUNT: &str = "/etc/gondolin/mitm";
/// Guest path of the ingress configuration mount.
pub const ETC_MOUNT: &str = "/etc/gondolin";
/// Largest `/etc/gondolin/listeners` file in `bytes`
pub const MAX_LISTENERS_FILE_BYTES: u64 = 64 * 1024;
/// Default MAC of the guest NIC.
const DEFAULT_MAC: &str = "02:00:00:00:00:01";
/// `DEFAULT_DARWIN_HVF_IDLE_PAUSE_MS`
const DARWIN_IDLE_PAUSE_MS: u64 = 30_000;

/// A checkpoint to boot from (`bash --resume`).
#[derive(Debug, Clone)]
pub struct ResumeDisk {
    /// the checkpoint qcow2 (with its metadata trailer)
    pub path: PathBuf,
    pub data: crate::checkpoint::CheckpointData,
}

/// Everything needed to start a session for the CLI options.
pub struct Prepared {
    /// the `configure` payload (JSON, bytes as `$base64`)
    pub configure: Json,
    /// default guest environment (`KEY=VALUE`)
    pub env: Vec<String>,
    pub fuse_mount: String,
    pub fuse_binds: Vec<String>,
    /// object mount id of `/etc/gondolin` (served in-process)
    pub etc_mount_id: Option<u32>,
    /// `resize2fs` must run in the guest after boot
    pub rootfs_resize_pending: bool,
    /// the resolved image
    pub image: ResolvedImage,
    /// root disk as configured (`mode`/`size` applied by the session)
    pub root_disk: Option<RootDisk>,
    /// checkpoint to boot from (`checkpoint_import` in place before `start`)
    pub checkpoint: Option<PathBuf>,
}

/// A temporary directory removed on drop.
pub struct WorkDir(pub PathBuf);

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl WorkDir {
    /// Creates a private (0700) directory below the temp dir.
    pub fn create(prefix: &str) -> std::io::Result<WorkDir> {
        // macOS: /tmp keeps unix socket paths short (as the node engine does)
        let base =
            if cfg!(target_os = "macos") { PathBuf::from("/tmp") } else { std::env::temp_dir() };
        for _ in 0..16 {
            let dir = base.join(format!("{prefix}-{}", crate::util::random_hex(4)));
            match std::fs::create_dir(&dir) {
                Ok(()) => {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
                    return Ok(WorkDir(dir));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::other("cannot create a temporary directory"))
    }
}

/// `parseDebugEnv`: `GONDOLIN_DEBUG` as a sorted flag list.
pub fn debug_flags(value: Option<&str>) -> Vec<String> {
    const ALL: [&str; 5] = ["net", "exec", "vfs", "protocol", "timing"];
    let mut flags = std::collections::BTreeSet::new();
    for raw in value.unwrap_or("").split(',') {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        if matches!(raw, "*" | "all" | "1" | "true") {
            flags.extend(ALL.iter().map(|s| s.to_string()));
            continue;
        }
        let flag = if raw == "fs" { "vfs" } else { raw };
        if ALL.contains(&flag) {
            flags.insert(flag.to_string());
        }
    }
    flags.into_iter().collect()
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// `normalizeVfsPath`: posix normalisation of an absolute path.
pub fn normalize_guest_path(p: &str) -> Result<String, String> {
    if p.is_empty() {
        return Err("mount path must be a non-empty string".into());
    }
    if !p.starts_with('/') {
        return Err(format!("mount path must be absolute: {p}"));
    }
    if p.contains('\0') {
        return Err("mount path contains null bytes".into());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

/// Resolves the guest image: `--image`, else the default image (downloads
/// like the node engine, progress on stderr).
pub async fn resolve_image(selector: Option<&str>) -> Result<ResolvedImage, String> {
    let assets = Assets::from_env();
    let progress = progress_printer();
    let image = match selector {
        Some(s) => assets.resolve(s, None, Some(&progress)).await,
        None => assets.resolve_default(Some(&progress)).await,
    };
    image.map_err(|e| e.to_string())
}

fn progress_printer() -> impl Fn(ProgressEvent) + Send + Sync {
    move |event| match event {
        ProgressEvent::DownloadStart { label, .. } => eprintln!("Downloading {label}..."),
        ProgressEvent::DownloadDone { label, .. } => eprintln!("Downloaded {label}"),
        _ => {}
    }
}

/// `resolveDefaultKrunRunnerPath`
fn krun_runner_path() -> String {
    if let Some(p) = env_var("GONDOLIN_KRUN_RUNNER") {
        return p;
    }
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for start in &starts {
        for rel in ["host/krun-runner/zig-out/bin", "krun-runner/zig-out/bin"] {
            let candidate = start.join(rel).join("gondolin-krun-runner");
            if candidate.exists() {
                return candidate.display().to_string();
            }
        }
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf))
    {
        let candidate = dir.join("gondolin-krun-runner");
        if candidate.exists() {
            return candidate.display().to_string();
        }
    }
    "gondolin-krun-runner".into()
}

/// Whether `command` names an executable file (bare names are looked up on `PATH`).
fn is_executable_command(command: &str) -> bool {
    fn executable(path: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    if command.contains('/') {
        return executable(Path::new(command));
    }
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| executable(&dir.join(command)))
    })
}

/// `hostSupportsKrun`: libkrun runs on macOS arm64 and Linux arm64/x86_64, on
/// Linux only with an accessible `/dev/kvm` (it has no emulation fallback).
fn host_supports_krun() -> bool {
    if cfg!(target_os = "macos") {
        Arch::host() == Arch::Aarch64
    } else if cfg!(target_os = "linux") {
        std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm").is_ok()
    } else {
        false
    }
}

/// The default backend (`selectDefaultVmm`): krun with the runner it found
/// when this host can run it, a runner is installed and the image has krun boot
/// assets for the host architecture; qemu otherwise.
fn default_vmm(image: &ResolvedImage) -> (String, Option<String>) {
    let image_ok = image.krun_kernel.as_ref().is_some_and(|k| k.exists())
        && image.arch.is_none_or(|a| a == Arch::host());
    if image_ok && host_supports_krun() {
        let runner = krun_runner_path();
        if is_executable_command(&runner) {
            return ("krun".into(), Some(runner));
        }
    }
    ("qemu".into(), None)
}

/// Builds the payload and prepares the root disk.
pub async fn prepare(
    common: &CommonOptions,
    resume: Option<&ResumeDisk>,
) -> Result<Prepared, String> {
    let image = match resume {
        Some(r) => {
            // `resolveGuestAssetsForResume`: the checkpoint's build id
            let required = r.data.guest_asset_build_id.clone();
            match &common.image {
                Some(selector) => {
                    let image = resolve_image(Some(selector)).await?;
                    let provided = image.build_id.clone().ok_or_else(|| {
                        format!(
                            "guest assets at {} are missing manifest buildId (cannot resume checkpoint)",
                            image.asset_dir.display()
                        )
                    })?;
                    if provided != required {
                        return Err(format!(
                            "guest assets do not match checkpoint buildId\n  required: {required}\n  provided: {provided}\nFix: pass the correct assets directory to sandbox.imagePath"
                        ));
                    }
                    image
                }
                None => {
                    // like node's checkpoint resume: the guest dir or checkout
                    // first when it is that build
                    let progress = progress_printer();
                    Assets::from_env()
                        .resolve_build_id(&required, Some(&progress))
                        .await
                        .map_err(|e| e.to_string())?
                }
            }
        }
        None => resolve_image(common.image.as_deref()).await?,
    };
    prepare_with_image(common, resume, image, &|name: &str| std::env::var(name))
}

/// [`prepare`] with an already resolved image and an explicit environment.
pub fn prepare_with_image(
    common: &CommonOptions,
    resume: Option<&ResumeDisk>,
    image: ResolvedImage,
    env: &dyn Fn(&str) -> Result<String, std::env::VarError>,
) -> Result<Prepared, String> {
    let env_opt =
        |name: &str| env(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());

    // --- VMM and paths (resolveSandboxServerOptions)
    let (vmm, detected_runner) =
        match common.vmm.clone().or_else(|| env_opt("GONDOLIN_VMM").map(|v| v.to_lowercase())) {
            Some(v) if v == "qemu" || v == "krun" || v == "firecracker" => (v, None),
            // the default may only pick krun when the checkpoint allows it
            _ if resume.is_some_and(|r| !r.data.compatible_vmm().iter().any(|v| v == "krun")) => {
                ("qemu".into(), None)
            }
            _ => default_vmm(&image),
        };
    let krun = vmm == "krun";
    // AWS Nitro Sandboxes through Firecracker (never the default)
    let firecracker = vmm == "firecracker";
    let arch = image.arch.unwrap_or_else(Arch::host);
    if krun && arch != Arch::host() {
        return Err(format!(
            "Guest image architecture mismatch for libkrun backend.\n  guest assets: {}\n  host arch:    {}\n\nFix: select a guest image that matches the host architecture when using vmm=krun.",
            arch,
            Arch::host()
        ));
    }
    let qemu_path = match arch {
        Arch::Aarch64 => "qemu-system-aarch64",
        Arch::X86_64 => "qemu-system-x86_64",
    }
    .to_string();
    let (kernel, initrd) = if krun {
        let kernel = image.krun_kernel.clone().ok_or(
            "Selected image does not provide krun boot assets.\nExpected manifest assets `krunKernel` (and optional `krunInitrd`).\nFix: use an image built with `gondolin build` or choose a published image that includes krun assets.",
        )?;
        (kernel, image.krun_initrd.clone().unwrap_or_else(|| image.initrd.clone()))
    } else {
        (image.kernel.clone(), image.initrd.clone())
    };

    // --- root disk (VM constructor)
    let rootfs_size = common.rootfs_size.as_deref().map(parse_disk_size).transpose()?;
    let rootfs = image.rootfs.display().to_string();
    let mode = if resume.is_some() {
        "checkpoint".to_string()
    } else {
        match image.rootfs_mode {
            Some(RootfsMode::Readonly) => "readonly",
            Some(RootfsMode::Memory) => "memory",
            _ => "cow",
        }
        .to_string()
    };
    let vm = VmConfig {
        vmm: Some(vmm.clone()),
        krun_runner_path: krun.then(|| detected_runner.unwrap_or_else(krun_runner_path)),
        firecracker_path: if firecracker { env_opt("GONDOLIN_FIRECRACKER") } else { None },
        // a Nitro Sandbox when either setting is given (mode `off`: KVM),
        // else the daemon picks (a Nitro Sandbox when the host supports them)
        nitro: (firecracker
            && (env_opt("GONDOLIN_NITRO_MODE").is_some()
                || env_opt("GONDOLIN_NITRO_CPU_OVERCOMMIT").is_some()))
        .then(|| NitroConfig {
            mode: env_opt("GONDOLIN_NITRO_MODE").unwrap_or_else(|| "direct".into()),
            cpu_overcommit: env_opt("GONDOLIN_NITRO_CPU_OVERCOMMIT").is_none_or(|v| v != "0"),
        }),
        qemu_path: if krun || firecracker { String::new() } else { qemu_path },
        image: None,
        arch: None,
        kernel_path: kernel.display().to_string(),
        initrd_path: initrd.display().to_string(),
        root_disk: Some(RootDisk {
            path: rootfs.clone(),
            format: gondolind::rootdisk::infer_format(&rootfs).into(),
            read_only: false,
            snapshot: false,
            mode: Some(mode.clone()),
            size: rootfs_size,
        }),
        memory: "1G".into(),
        cpus: 2,
        machine_type: None,
        accel: None,
        cpu: if krun || firecracker { None } else { env_opt("GONDOLIN_CPU") },
        console: None,
        append: None,
        append_extra: Vec::new(),
        mac: Some(DEFAULT_MAC.into()),
        auto_restart: false,
        idle_pause_ms: (!krun && !firecracker && cfg!(target_os = "macos"))
            .then_some(DARWIN_IDLE_PAUSE_MS),
    };
    if let Some(r) = resume {
        // `VmCheckpoint.resume`: the session rebases the checkpoint onto this
        // machine's rootfs and boots a fresh overlay on it
        let compatible = r.data.compatible_vmm();
        if !compatible.contains(&vmm) {
            return Err(format!(
                "checkpoint is not compatible with vmm={vmm} (compatible backends: {})",
                compatible.join(", ")
            ));
        }
    }
    let root_disk = vm.root_disk.clone();

    // --- VFS (VM constructor + NativeVfs.config)
    let mut mounts: Vec<(String, Json)> = Vec::new();
    let mut add = |path: String, mount: Json| -> Result<(), String> {
        match mounts.iter_mut().find(|(p, _)| *p == path) {
            Some(entry) => entry.1 = mount,
            None => mounts.push((path, mount)),
        }
        Ok(())
    };
    for m in &common.mounts {
        let host = Path::new(&m.host_path);
        let resolved = std::path::absolute(host).map_err(|e| e.to_string())?;
        if !resolved.exists() {
            return Err(format!("Host path does not exist: {}", m.host_path));
        }
        if !resolved.is_dir() {
            return Err(format!("Host path is not a directory: {}", m.host_path));
        }
        let root = std::fs::canonicalize(&resolved).map_err(|e| e.to_string())?;
        let layers = if m.readonly {
            gondolin_wire::value!([{ "kind": "readonly" }])
        } else {
            gondolin_wire::value!([])
        };
        add(
            m.guest_path.clone(),
            gondolin_wire::value!({ "kind": "host", "root": root.display().to_string(), "layers": layers }),
        )?;
    }
    for p in &common.memory_mounts {
        add(p.clone(), gondolin_wire::value!({ "kind": "memory", "layers": [] }))?;
    }
    // normalise and reject duplicates (`normalizeMountMap`)
    let mut user: Vec<(String, Json)> = Vec::new();
    for (p, m) in mounts {
        let n = normalize_guest_path(&p)?;
        if user.iter().any(|(q, _)| *q == n) {
            return Err(format!("duplicate mount path: {n}"));
        }
        user.push((n, m));
    }
    let user_paths: Vec<&str> = user.iter().map(|(p, _)| p.as_str()).collect();
    let mut table = user.clone();
    let ca = gondolind::mitm_ca::load_or_create(&mitm_dir(&env_opt))?;
    if !user_paths.contains(&MITM_MOUNT) && !user_paths.contains(&ETC_MOUNT) {
        let mut pem = ca.cert_pem.clone();
        if !pem.ends_with('\n') {
            pem.push('\n');
        }
        table.push((
            MITM_MOUNT.into(),
            gondolin_wire::value!({ "kind": "static", "layers": [], "files": { "/ca.crt": b64(pem.as_bytes()) } }),
        ));
    }
    if !user_paths.contains(&ETC_MOUNT) {
        table.push((ETC_MOUNT.into(), gondolin_wire::value!({ "kind": "etc" })));
    }
    let mut next_mount_id = 1u32;
    let mut etc_mount_id = None;
    let mut mount_list = Vec::new();
    for (path, mount) in &table {
        let mut obj = Json::map();
        obj.insert("path", path.as_str());
        if mount["kind"].as_text() == Some("etc") {
            etc_mount_id = Some(next_mount_id);
            obj.insert("kind", "object");
            obj.insert("mount_id", next_mount_id);
            obj.insert("writable", true);
            obj.insert("enumeration", "list");
            obj.insert("commit", "write");
            obj.insert(
                "cache",
                gondolin_wire::value!({ "ttl_ms": 1000, "max_bytes": 268435456u64, "revalidate_open": true, "inline_max_bytes": 0 }),
            );
            obj.insert("max_file_bytes", MAX_LISTENERS_FILE_BYTES);
            obj.insert("layers", gondolin_wire::value!([]));
            next_mount_id += 1;
        } else if let Some(m) = mount.as_map() {
            obj.as_map_mut().unwrap().extend(m.iter().cloned());
        }
        mount_list.push(obj);
    }
    let mut binds: Vec<String> =
        table.iter().map(|(p, _)| p.clone()).filter(|p| p != "/").collect();
    binds.sort();
    let transport = match env_opt("GONDOLIN_VIRTIOFS").map(|v| v.to_lowercase()).as_deref() {
        Some("0" | "false" | "off") => "sandboxfs",
        Some("1" | "true" | "on") => "virtiofs",
        _ => "auto",
    };
    let vfs = gondolin_wire::value!({
        "mode": "native",
        "fuse_mount": FUSE_MOUNT,
        "binds": binds,
        "mounts": mount_list,
        "hooks": { "before": false, "events": false },
        "transport": transport,
    });

    // --- network
    let net = netcfg::compile(
        common,
        &netcfg::Context {
            mitm_cert_pem: ca.cert_pem.clone(),
            mitm_key_pem: ca.key_pem.clone(),
            mac: DEFAULT_MAC.into(),
            checksum_offload: krun,
            env: &|name| env(name).ok(),
        },
    )?;

    // --- payload (buildNativeConfigure)
    let mut vm_json = gondolin_wire::ToValue::to_value(&vm);
    vm_json.remove("image");
    vm_json.remove("arch");
    if krun || firecracker {
        vm_json.remove("idle_pause_ms");
    }
    let configure = gondolin_wire::value!({
        "vm": vm_json,
        "limits": {
            "max_stdin_bytes": 65536,
            "max_queued_stdin_bytes": 8388608,
            "max_total_queued_stdin_bytes": 33554432,
            "max_queued_execs": 64,
        },
        "debug": debug_flags(env("GONDOLIN_DEBUG").ok().as_deref()),
        "vfs": vfs,
        "net": net.net,
    });
    Ok(Prepared {
        configure,
        env: net.guest_env,
        fuse_mount: FUSE_MOUNT.into(),
        fuse_binds: binds_of(&table),
        etc_mount_id,
        rootfs_resize_pending: rootfs_size.is_some(),
        image,
        root_disk,
        checkpoint: resume.map(|r| r.path.clone()),
    })
}

fn binds_of(table: &[(String, Json)]) -> Vec<String> {
    let mut binds: Vec<String> =
        table.iter().map(|(p, _)| p.clone()).filter(|p| p != "/").collect();
    binds.sort();
    binds
}

/// MITM CA directory (`resolveMitmCertDir`): `GONDOLIN_MITM_CERT_DIR`, else
/// the shared cache.
fn mitm_dir(env: &dyn Fn(&str) -> Option<String>) -> PathBuf {
    env("GONDOLIN_MITM_CERT_DIR").map(PathBuf::from).unwrap_or_else(gondolind::mitm_ca::default_dir)
}

/// A byte string value.
pub fn b64(bytes: &[u8]) -> Json {
    Json::Bytes(bytes.to_vec())
}

/// The payload as sent to the session (the JSON model is the CBOR model;
/// byte strings print as `{ "$base64": ... }`).
pub fn json_to_cbor(v: &Json) -> Value {
    v.clone()
}

/// The `--print-configure` output: secrets redacted like the Node CLI.
pub fn printable(prepared: &Prepared) -> Json {
    fn redact(v: &mut Json) {
        match v {
            Json::Map(o) => {
                for (k, v) in o.iter_mut() {
                    if matches!(k.as_text(), Some("key_pem" | "value" | "revoked_values")) {
                        *v = Json::Text("<redacted>".into());
                    } else {
                        redact(v);
                    }
                }
            }
            Json::Array(a) => a.iter_mut().for_each(redact),
            _ => {}
        }
    }
    let mut configure = prepared.configure.clone();
    redact(&mut configure);
    gondolin_wire::value!({ "configure": configure, "env": prepared.env })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_env() {
        assert_eq!(debug_flags(Some("exec, fs")), vec!["exec", "vfs"]);
        assert_eq!(debug_flags(Some("all")).len(), 5);
        assert!(debug_flags(Some("bogus")).is_empty());
    }

    #[test]
    fn guest_paths() {
        assert_eq!(normalize_guest_path("/a//b/./c/").unwrap(), "/a/b/c");
        assert_eq!(normalize_guest_path("/").unwrap(), "/");
        assert!(normalize_guest_path("rel").is_err());
    }

    #[test]
    fn cbor_bytes() {
        let v = json_to_cbor(&gondolin_wire::value!({ "a": b64(b"xy"), "n": -1, "f": 1.5 }));
        let m = v.as_map().unwrap();
        assert_eq!(m[0].1, Value::Bytes(b"xy".to_vec()));
        assert_eq!(m[1].1, Value::Integer((-1).into()));
    }
}
