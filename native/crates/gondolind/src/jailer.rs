//! Firecracker under its jailer: a chroot, an unprivileged uid/gid of its
//! own and cgroup v2 limits.
//!
//! Firecracker's `jailer` (shipped with every release) creates the chroot
//! `<base>/<firecracker binary name>/<id>/root`, copies the binary and the
//! device nodes the VMM needs into it (`/dev/kvm`, `/dev/net/tun`,
//! `/dev/nitro_enclaves`, ...), moves itself into a cgroup with the given
//! limits, pivots into the chroot, drops to the uid/gid and execs Firecracker
//! (same pid, so the daemon's child is the VMM). A VMM compromised by its
//! guest then holds no root privileges and sees nothing but its chroot.
//!
//! Everything the VMM opens has to be inside the chroot. The daemon spawns
//! the jailer in a private mount namespace and bind-mounts the kernel, initrd
//! and root disk files and the session's vsock directory (where the guest
//! channel listeners live and Firecracker binds its vsock socket) onto empty
//! files/directories in the chroot ([`Jail::bind`]); nothing is copied, and
//! the mounts disappear with the process. The config file and log are
//! written into the chroot directly.
//!
//! The jailer clears the parent-death signal when it changes credentials, so
//! a watchdog process (`--vmm-watchdog`) kills the VMM if the daemon dies.
//! Each jail (directory and cgroup) is removed when its VMM has exited; ones
//! left behind by a daemon that died are swept when the next jail is created.
//!
//! Used when the daemon runs as root and finds `jailer` (beside the
//! Firecracker binary or on `PATH`); `GONDOLIN_JAILER` names the binary, or
//! `0` turns it off. `GONDOLIN_JAILER_DIR` is the chroot base (default
//! `/srv/jailer`) and `GONDOLIN_JAILER_UID` the first uid/gid used (the VMM
//! of daemon process `pid` runs as `uid + pid`, default 1600000000).

use std::path::{Path, PathBuf};

use gondolin_proto::session::VmConfig;

/// Chroot base when `GONDOLIN_JAILER_DIR` is unset (the jailer's own default).
const DEFAULT_BASE: &str = "/srv/jailer";
/// First uid/gid when `GONDOLIN_JAILER_UID` is unset: far above regular
/// accounts and the usual subordinate id ranges.
const DEFAULT_UID_BASE: u32 = 1_600_000_000;
/// cgroup (under the v2 root) the jails' cgroups are created in.
pub const CGROUP_PARENT: &str = "gondolin";
/// Prefix of the jail ids of this daemon: `gondolin-<pid>-<generation>`.
const ID_PREFIX: &str = "gondolin-";

/// How VMMs are jailed on this host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JailerSettings {
    /// the jailer binary
    pub jailer: PathBuf,
    /// the Firecracker binary (absolute)
    pub firecracker: PathBuf,
    /// chroot base directory
    pub base: PathBuf,
    /// uid and gid of the VMM
    pub uid: u32,
    pub gid: u32,
    /// cgroup v2 controllers the limits can use (`cpu`, `memory`, `pids`)
    pub controllers: Vec<String>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn is_off(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "off" | "false" | "no")
}

fn find_program(name: &str) -> Option<PathBuf> {
    crate::qemu::which(name).filter(|p| p.is_file())
}

/// Which jailer to use. `requested`: `GONDOLIN_JAILER` (not `0`); `found`:
/// the one beside the Firecracker binary or on `PATH`. A daemon that is not
/// root runs VMMs unjailed as its own user. A root daemon must find one: the
/// VMM would otherwise run as root with the host's whole filesystem and no
/// resource limits, so running unjailed takes an explicit
/// `GONDOLIN_JAILER=0`.
fn choose_jailer(
    requested: Option<&str>,
    root: bool,
    found: impl FnOnce() -> Option<PathBuf>,
    resolve: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    match requested {
        Some(path) if !root => Err(format!(
            "GONDOLIN_JAILER={path}: the jailer needs a daemon running as root (or set \
             GONDOLIN_JAILER=0)"
        )),
        Some(path) => {
            Ok(Some(resolve(path).ok_or_else(|| format!("GONDOLIN_JAILER: {path} not found"))?))
        }
        None if !root => Ok(None),
        None => found().map(Some).ok_or_else(|| {
            "the daemon runs as root but Firecracker's jailer was not found (beside the \
             firecracker binary or on PATH): the VMM would run as root without a chroot or \
             resource limits. Install it (scripts/install-firecracker.sh installs both) or set \
             GONDOLIN_JAILER=0 to run Firecracker unjailed"
                .to_string()
        }),
    }
}

/// The jailer settings for `vm`, or `None` when VMMs run unjailed: the
/// daemon is not root, or `GONDOLIN_JAILER=0`. A root daemon without a
/// jailer, and an explicitly named jailer that cannot be used, are errors
/// ([`choose_jailer`]).
pub fn settings(vm: &VmConfig) -> Result<Option<JailerSettings>, String> {
    let requested = env("GONDOLIN_JAILER");
    if requested.as_deref().is_some_and(is_off) {
        return Ok(None);
    }
    // SAFETY: geteuid has no preconditions.
    let root = unsafe { libc::geteuid() } == 0;
    let firecracker = find_program(&crate::firecracker::binary_path(vm))
        .and_then(|p| std::fs::canonicalize(p).ok());
    let jailer = choose_jailer(
        requested.as_deref(),
        root,
        // beside the Firecracker binary first: the two come from one release
        || {
            firecracker
                .as_ref()
                .and_then(|fc| fc.parent().map(|d| d.join("jailer")))
                .filter(|p| p.is_file())
                .or_else(|| find_program("jailer"))
        },
        find_program,
    )?;
    let Some(jailer) = jailer else { return Ok(None) };
    let firecracker = firecracker.ok_or_else(|| {
        format!("cannot resolve the Firecracker binary {}", crate::firecracker::binary_path(vm))
    })?;
    let base = env("GONDOLIN_JAILER_DIR").map(PathBuf::from).unwrap_or(DEFAULT_BASE.into());
    let uid_base = match env("GONDOLIN_JAILER_UID") {
        Some(v) => {
            v.trim().parse::<u32>().map_err(|_| format!("invalid GONDOLIN_JAILER_UID: {v}"))?
        }
        None => DEFAULT_UID_BASE,
    };
    let uid = uid_base
        .checked_add(std::process::id())
        .filter(|&u| u < u32::MAX - 1)
        .ok_or_else(|| format!("GONDOLIN_JAILER_UID {uid_base} leaves no room for this pid"))?;
    Ok(Some(JailerSettings {
        jailer,
        firecracker,
        base,
        uid,
        gid: uid,
        controllers: cgroup_controllers(Path::new("/sys/fs/cgroup")),
    }))
}

/// The cgroup v2 controllers of `root` (the unified hierarchy's mount) the
/// limits use; none without cgroup v2.
fn cgroup_controllers(root: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(root.join("cgroup.controllers")) else {
        return Vec::new();
    };
    text.split_whitespace()
        .filter(|c| matches!(*c, "cpu" | "memory" | "pids"))
        .map(str::to_string)
        .collect()
}

/// The cgroup limits of a VM with `cpus` vCPUs and `memory_mib` of memory:
/// on KVM the guest's memory is the VMM's, on a Nitro Sandbox it comes from
/// the enclave pool and the VMM itself is small.
pub fn cgroup_limits(
    cpus: u32,
    memory_mib: u64,
    nitro: bool,
    controllers: &[String],
) -> Vec<String> {
    let has = |c: &str| controllers.iter().any(|x| x == c);
    let mut out = Vec::new();
    if has("memory") {
        let mib = if nitro { 512 } else { memory_mib + 256 };
        out.push(format!("memory.max={}", mib << 20));
    }
    if has("cpu") {
        // the vCPU threads plus one core for the VMM's own threads
        out.push(format!("cpu.max={} 100000", (u64::from(cpus) + 1) * 100_000));
    }
    if has("pids") {
        out.push(format!("pids.max={}", 64 + cpus));
    }
    out
}

/// A file or directory bind-mounted into the chroot when the jailer starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bind {
    pub source: PathBuf,
    /// host path of the mount point inside the chroot
    pub target: PathBuf,
    pub read_only: bool,
}

/// One VMM's chroot and cgroup (removed on drop, after the VMM exited).
#[derive(Debug)]
pub struct Jail {
    id: String,
    /// `<base>/<firecracker name>/<id>`
    dir: PathBuf,
    /// `<dir>/root`
    root: PathBuf,
    settings: JailerSettings,
    binds: Vec<Bind>,
    cgroup: Option<PathBuf>,
}

impl Jail {
    /// An empty jail for VMM `generation` of this daemon. Sweeps the jails of
    /// daemons that are gone first.
    pub fn create(settings: &JailerSettings, generation: u64) -> Result<Jail, String> {
        let name = settings
            .firecracker
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("the Firecracker binary has no file name")?;
        let parent = settings.base.join(name);
        sweep(&parent, Path::new("/sys/fs/cgroup").join(CGROUP_PARENT).as_path());
        let id = format!("{ID_PREFIX}{}-{generation}", std::process::id());
        let dir = parent.join(&id);
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.join("root");
        std::fs::create_dir_all(&root)
            .map_err(|e| format!("cannot create the jail {}: {e}", root.display()))?;
        let cgroup = (!settings.controllers.is_empty())
            .then(|| Path::new("/sys/fs/cgroup").join(CGROUP_PARENT).join(&id));
        Ok(Jail { id, dir, root, settings: settings.clone(), binds: Vec::new(), cgroup })
    }

    /// The chroot's directory on the host.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Makes `source` (a file or directory) appear as `/<name>` in the chroot;
    /// returns that path. The VMM must be able to read it (and write it,
    /// unless `read_only`) as the jail's uid.
    pub fn bind(&mut self, source: &Path, name: &str, read_only: bool) -> Result<String, String> {
        let target = self.root.join(name);
        let made = if source.is_dir() {
            std::fs::create_dir_all(&target)
        } else {
            std::fs::write(&target, b"")
        };
        made.map_err(|e| format!("cannot prepare {}: {e}", target.display()))?;
        self.binds.push(Bind { source: source.to_path_buf(), target, read_only });
        Ok(format!("/{name}"))
    }

    pub fn binds(&self) -> &[Bind] {
        &self.binds
    }

    /// Writes `data` to `/<name>` in the chroot, owned by the jail's uid.
    pub fn write(&self, name: &str, data: &[u8]) -> Result<String, String> {
        let path = self.root.join(name);
        std::fs::write(&path, data)
            .and_then(|()| chown(&path, self.settings.uid, self.settings.gid))
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        Ok(format!("/{name}"))
    }

    pub fn uid(&self) -> u32 {
        self.settings.uid
    }

    pub fn gid(&self) -> u32 {
        self.settings.gid
    }

    /// The jailer command line running Firecracker with `firecracker_args`
    /// (paths inside the chroot) and the cgroup `limits` ([`cgroup_limits`]).
    pub fn command(&self, firecracker_args: &[String], limits: &[String]) -> (String, Vec<String>) {
        let s = &self.settings;
        let mut args: Vec<String> = vec![
            "--id".into(),
            self.id.clone(),
            "--exec-file".into(),
            s.firecracker.display().to_string(),
            "--uid".into(),
            s.uid.to_string(),
            "--gid".into(),
            s.gid.to_string(),
            "--chroot-base-dir".into(),
            s.base.display().to_string(),
        ];
        if self.cgroup.is_some() && !limits.is_empty() {
            args.extend(["--cgroup-version".into(), "2".into()]);
            args.extend(["--parent-cgroup".into(), CGROUP_PARENT.into()]);
            for limit in limits {
                args.extend(["--cgroup".into(), limit.clone()]);
            }
        }
        args.push("--".into());
        args.extend(firecracker_args.iter().cloned());
        (s.jailer.display().to_string(), args)
    }
}

impl Drop for Jail {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
        if let Some(cgroup) = &self.cgroup {
            let _ = std::fs::remove_dir(cgroup);
        }
    }
}

/// Removes jails (under `parent`) and their cgroups (under `cgroups`) whose
/// daemon process is gone.
fn sweep(parent: &Path, cgroups: &Path) {
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|n| n.strip_prefix(ID_PREFIX))
            .and_then(|rest| rest.split('-').next())
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == std::process::id() || process_alive(pid) {
            continue;
        }
        let cgroup = cgroups.join(&name);
        // a VMM that outlived its daemon (no watchdog): kill it first
        if cgroup.join("cgroup.kill").exists() {
            let _ = std::fs::write(cgroup.join("cgroup.kill"), "1");
        }
        let _ = std::fs::remove_dir_all(entry.path());
        let _ = std::fs::remove_dir(&cgroup);
    }
}

fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    // SAFETY: signal 0 only checks that the process exists.
    let exists = unsafe { libc::kill(pid, 0) } == 0;
    exists || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub fn chown(path: &Path, uid: u32, gid: u32) -> std::io::Result<()> {
    std::os::unix::fs::chown(path, Some(uid), Some(gid))
}

/// Whether the jail's uid (neither the owner nor in the group of `path`) can
/// read, and if `write` write, `path`: its "other" permission bits.
pub fn others_may(path: &Path, write: bool) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else { return false };
    let mode = meta.permissions().mode();
    mode & 0o004 != 0 && (!write || mode & 0o002 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_root_daemon_needs_a_jailer_unless_told_otherwise() {
        let found = || Some(PathBuf::from("/usr/local/bin/jailer"));
        let none = || None;
        let resolve = |p: &str| (p == "/opt/jailer").then(|| PathBuf::from(p));
        // root: the jailer that was found, or an error naming the opt-out
        assert_eq!(
            choose_jailer(None, true, found, resolve),
            Ok(Some(PathBuf::from("/usr/local/bin/jailer")))
        );
        let err = choose_jailer(None, true, none, resolve).unwrap_err();
        assert!(err.contains("jailer was not found") && err.contains("GONDOLIN_JAILER=0"));
        // not root: unjailed, as the daemon's own user
        assert_eq!(choose_jailer(None, false, found, resolve), Ok(None));
        // an explicit jailer must exist and needs root
        assert_eq!(
            choose_jailer(Some("/opt/jailer"), true, none, resolve),
            Ok(Some(PathBuf::from("/opt/jailer")))
        );
        assert!(choose_jailer(Some("/missing"), true, found, resolve).is_err());
        assert!(choose_jailer(Some("/opt/jailer"), false, found, resolve).is_err());
    }

    #[test]
    fn limits_follow_the_vm_and_the_controllers() {
        let all: Vec<String> = ["cpu", "memory", "pids"].map(String::from).to_vec();
        assert_eq!(
            cgroup_limits(2, 1024, false, &all),
            vec!["memory.max=1342177280", "cpu.max=300000 100000", "pids.max=66"]
        );
        // a Nitro Sandbox's memory is not the VMM's
        assert_eq!(cgroup_limits(2, 1024, true, &all)[0], "memory.max=536870912");
        assert_eq!(cgroup_limits(2, 1024, false, &["pids".into()]), vec!["pids.max=66"]);
        assert!(cgroup_limits(2, 1024, false, &[]).is_empty());
    }

    fn settings() -> JailerSettings {
        JailerSettings {
            jailer: "/usr/local/bin/jailer".into(),
            firecracker: "/usr/local/bin/firecracker".into(),
            base: std::env::temp_dir().join(format!("gondolin-jail-test-{}", std::process::id())),
            uid: 1_600_000_123,
            gid: 1_600_000_123,
            controllers: vec![],
        }
    }

    #[test]
    fn jail_layout_command_and_cleanup() {
        let s = settings();
        let src = s.base.join("src");
        std::fs::create_dir_all(src.join("vsock")).unwrap();
        std::fs::write(src.join("kernel"), b"k").unwrap();
        let mut jail = Jail::create(&s, 3).unwrap();
        let id = format!("gondolin-{}-3", std::process::id());
        assert_eq!(jail.root(), s.base.join("firecracker").join(&id).join("root"));
        assert_eq!(jail.bind(&src.join("kernel"), "kernel", true).unwrap(), "/kernel");
        assert_eq!(jail.bind(&src.join("vsock"), "vsock", false).unwrap(), "/vsock");
        assert!(jail.root().join("kernel").is_file() && jail.root().join("vsock").is_dir());
        assert_eq!(jail.binds().len(), 2);
        assert!(jail.binds()[0].read_only && !jail.binds()[1].read_only);

        let (program, args) = jail.command(&["--no-api".into()], &["pids.max=65".into()]);
        assert_eq!(program, "/usr/local/bin/jailer");
        let joined = args.join(" ");
        assert!(joined.starts_with(&format!("--id {id} --exec-file /usr/local/bin/firecracker")));
        assert!(joined.contains("--uid 1600000123 --gid 1600000123"));
        // no cgroup v2 controllers: no cgroup arguments
        assert!(!joined.contains("--cgroup"), "{joined}");
        assert!(joined.ends_with("-- --no-api"));

        let dir = jail.root().parent().unwrap().to_path_buf();
        drop(jail);
        assert!(!dir.exists(), "the jail is removed on drop");
        std::fs::remove_dir_all(&s.base).unwrap();
    }

    #[test]
    fn sweep_removes_jails_of_dead_daemons_only() {
        let base = std::env::temp_dir().join(format!("gondolin-sweep-test-{}", std::process::id()));
        let parent = base.join("firecracker");
        // pid 1 is alive; a pid above pid_max is not
        for name in ["gondolin-1-0", "gondolin-4294967-2", "other-jail"] {
            std::fs::create_dir_all(parent.join(name).join("root")).unwrap();
        }
        sweep(&parent, &base.join("cgroups"));
        assert!(parent.join("gondolin-1-0").exists());
        assert!(!parent.join("gondolin-4294967-2").exists());
        assert!(parent.join("other-jail").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
