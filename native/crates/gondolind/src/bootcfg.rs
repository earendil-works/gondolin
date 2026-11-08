//! Guest boot configuration: the sandboxfs mount point and bind list, how they reach the guest (kernel
//! cmdline for old guests, the sandboxfs `mounts` RPC for current ones).

/// Normalized sandboxfs configuration from a client `boot` message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxFsConfig {
    pub fuse_mount: String,
    /// sorted, deduplicated
    pub fuse_binds: Vec<String>,
}

/// Maximum cmdline length in `bytes` up to which legacy `sandboxfs.bind=`
/// entries are still emitted (`LEGACY_CMDLINE_BINDS_MAX_BYTES`).
pub const LEGACY_CMDLINE_BINDS_MAX_BYTES: usize = 1536;

/// `path.posix.normalize`.
pub fn posix_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            p => parts.push(p),
        }
    }
    let mut out = parts.join("/");
    if out.is_empty() && !absolute {
        out = ".".into();
    }
    if trailing && !out.is_empty() && out != "." {
        out.push('/');
    } else if trailing && out == "." && !absolute {
        out = "./".into();
    }
    if absolute { format!("/{out}") } else { out }
}

fn normalize_mount_path(value: &str, field: &str) -> Result<String, String> {
    if value.is_empty() {
        return Err(format!("{field} must be a non-empty string"));
    }
    let mut normalized = posix_normalize(value);
    if !normalized.starts_with('/') {
        return Err(format!("{field} must be an absolute path"));
    }
    if normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if normalized.contains('\0') {
        return Err(format!("{field} contains null bytes"));
    }
    if normalized.contains(['\r', '\n']) {
        return Err(format!("{field} contains newlines"));
    }
    Ok(normalized)
}

/// Raw boot message fields; `None` means absent.
pub enum RawBind<'a> {
    Text(&'a str),
    /// a non-string entry
    Invalid,
}

/// `normalizeSandboxFsConfig`.
pub fn normalize(
    fuse_mount: Option<Result<&str, ()>>,
    fuse_binds: Option<Result<Vec<RawBind<'_>>, ()>>,
) -> Result<SandboxFsConfig, String> {
    let fuse_mount = match fuse_mount {
        None => normalize_mount_path("/data", "fuseMount")?,
        Some(Ok(v)) => normalize_mount_path(v, "fuseMount")?,
        Some(Err(())) => return Err("fuseMount must be a non-empty string".into()),
    };
    let binds = match fuse_binds {
        None => Vec::new(),
        Some(Err(())) => return Err("fuseBinds must be an array of absolute paths".into()),
        Some(Ok(list)) => list,
    };
    let mut out: Vec<String> = Vec::new();
    for entry in binds {
        let normalized = match entry {
            RawBind::Text(t) => normalize_mount_path(t, "fuseBinds")?,
            RawBind::Invalid => return Err("fuseBinds must be a non-empty string".into()),
        };
        if !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    out.sort();
    Ok(SandboxFsConfig { fuse_mount, fuse_binds: out })
}

fn is_internal_bind(bind: &str) -> bool {
    bind == "/etc/gondolin" || bind.starts_with("/etc/gondolin/")
}

fn is_cmdline_safe_bind(bind: &str) -> bool {
    // whitespace splits cmdline arguments and commas split the bind list
    !bind.chars().any(|c| c.is_whitespace() || matches!(c, ',' | '"' | '\''))
}

fn join_cmdline(pieces: &[&str]) -> String {
    pieces.iter().map(|p| p.trim()).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ")
}

/// `buildSandboxfsAppend`: the kernel cmdline for a boot configuration.
pub fn sandboxfs_append(base_append: &str, config: &SandboxFsConfig) -> String {
    let mount_arg = format!("sandboxfs.mount={}", config.fuse_mount);
    let base = join_cmdline(&[base_append, &mount_arg]);

    let mut candidates: Vec<&String> =
        config.fuse_binds.iter().filter(|b| is_cmdline_safe_bind(b)).collect();
    candidates.sort_by(|a, b| {
        let (ai, bi) = (is_internal_bind(a), is_internal_bind(b));
        bi.cmp(&ai).then_with(|| a.as_bytes().cmp(b.as_bytes()))
    });

    let prefix = " sandboxfs.bind=";
    let mut length = base.len() + prefix.len();
    let mut binds: Vec<&String> = Vec::new();
    for bind in candidates {
        let extra = bind.len() + usize::from(!binds.is_empty());
        if length + extra > LEGACY_CMDLINE_BINDS_MAX_BYTES {
            continue;
        }
        binds.push(bind);
        length += extra;
    }
    if binds.is_empty() {
        return base;
    }
    // parents have to be bound before their children
    binds.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let list: Vec<&str> = binds.iter().map(|s| s.as_str()).collect();
    format!("{base}{prefix}{}", list.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(posix_normalize("/a//b/../c/"), "/a/c/");
        assert_eq!(posix_normalize("/.."), "/");
        assert_eq!(posix_normalize("a/../.."), "..");
        let cfg = normalize(
            Some(Ok("/data/")),
            Some(Ok(vec![RawBind::Text("/b"), RawBind::Text("/a/"), RawBind::Text("/b/.")])),
        )
        .unwrap();
        assert_eq!(cfg.fuse_mount, "/data");
        assert_eq!(cfg.fuse_binds, vec!["/a", "/b"]);
        assert_eq!(normalize(None, None).unwrap().fuse_mount, "/data");
        assert_eq!(
            normalize(Some(Ok("rel")), None).unwrap_err(),
            "fuseMount must be an absolute path"
        );
        assert!(normalize(None, Some(Ok(vec![RawBind::Text("/x\ny")]))).is_err());
    }

    #[test]
    fn append_with_binds() {
        let cfg = SandboxFsConfig {
            fuse_mount: "/data".into(),
            fuse_binds: vec!["/etc/gondolin".into(), "/a b".into(), "/work".into()],
        };
        assert_eq!(
            sandboxfs_append("console=ttyAMA0", &cfg),
            "console=ttyAMA0 sandboxfs.mount=/data sandboxfs.bind=/etc/gondolin,/work"
        );
        let none = SandboxFsConfig { fuse_mount: "/".into(), fuse_binds: vec![] };
        assert_eq!(sandboxfs_append(" ", &none), "sandboxfs.mount=/");
    }

    #[test]
    fn append_respects_limit_internal_first() {
        let long = format!("/{}", "x".repeat(1400));
        let cfg = SandboxFsConfig {
            fuse_mount: "/data".into(),
            fuse_binds: vec![long.clone(), "/etc/gondolin".into(), "/zz".into()],
        };
        let out = sandboxfs_append("base", &cfg);
        assert!(out.ends_with("sandboxfs.bind=/etc/gondolin,/zz") || out.contains(&long));
        assert!(out.len() <= LEGACY_CMDLINE_BINDS_MAX_BYTES);
        assert!(out.contains("/etc/gondolin"));
    }
}
