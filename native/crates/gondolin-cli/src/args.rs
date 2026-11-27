//! Command line parsing, mirroring `host/bin/gondolin.ts` (flags, defaults and
//! error messages).

use std::net::Ipv4Addr;

/// `--mount-hostfs HOST:GUEST[:ro]`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountSpec {
    pub host_path: String,
    pub guest_path: String,
    pub readonly: bool,
}

/// `--host-secret NAME@HOST[,HOST...][=VALUE]`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretSpec {
    pub name: String,
    pub value: String,
    /// allowed hosts (empty: the Node CLI would suggest hosts)
    pub hosts: Vec<String>,
}

/// `--ssh-credential [USER@]HOST[:PORT]=KEY_PATH[,...]`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshCredentialSpec {
    pub host: String,
    pub username: Option<String>,
    pub key_path: String,
    pub passphrase: Option<String>,
}

/// Options shared by `bash` and `exec` (VM mode).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommonOptions {
    pub mounts: Vec<MountSpec>,
    pub memory_mounts: Vec<String>,
    pub allowed_hosts: Vec<String>,
    pub secrets: Vec<SecretSpec>,
    /// tier-2 hook policy file (`--hooks-script`)
    pub hooks_script: Option<String>,
    /// image selector (asset dir, build id, or name:tag)
    pub image: Option<String>,
    /// `qemu`, `krun` or `firecracker`
    pub vmm: Option<String>,
    /// minimum rootfs size (`2G`, ...)
    pub rootfs_size: Option<String>,
    pub disable_websockets: bool,
    /// `synthetic`, `trusted` or `open`
    pub dns_mode: Option<String>,
    pub dns_trusted_servers: Vec<String>,
    /// `single` or `per-host`
    pub dns_synthetic_host_mapping: Option<String>,
    /// `GUEST_HOST[:PORT]` -> `UPSTREAM_HOST:PORT`, in first-seen key order
    pub tcp_host_mappings: Vec<(String, String)>,
    pub ssh_allowed_hosts: Vec<String>,
    pub ssh_agent: Option<String>,
    pub ssh_known_hosts_files: Vec<String>,
    pub ssh_credentials: Vec<SshCredentialSpec>,
    /// print the configure payload instead of starting a VM
    pub print_configure: bool,
}

/// `gondolin bash` arguments.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BashArgs {
    pub common: CommonOptions,
    /// `--listen [HOST:PORT]`
    pub listen: Option<(String, u16)>,
    /// command after `--`
    pub command: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub env: Vec<String>,
    pub resume: Option<String>,
    pub ssh: bool,
    pub ssh_user: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_listen: Option<String>,
}

/// One command of `gondolin exec`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecCommand {
    pub cmd: String,
    pub argv: Vec<String>,
    pub env: Vec<String>,
    pub cwd: Option<String>,
    pub id: u32,
}

/// `gondolin exec` arguments.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecArgs {
    pub common: CommonOptions,
    pub commands: Vec<ExecCommand>,
    /// session id or socket path (socket mode)
    pub sock: Option<String>,
}

/// Why parsing stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// `--help`: print usage, exit 0
    Help,
    /// print the message and the usage, exit 1
    Usage(String),
    /// print the message only, exit 1
    Message(String),
}

type Result<T> = std::result::Result<T, ParseError>;

fn usage(msg: impl Into<String>) -> ParseError {
    ParseError::Usage(msg.into())
}

fn message(msg: impl Into<String>) -> ParseError {
    ParseError::Message(msg.into())
}

/// `parseMount`
pub fn parse_mount(spec: &str) -> std::result::Result<MountSpec, String> {
    let parts: Vec<&str> = spec.split(':').collect();
    if parts.len() < 2 {
        return Err(format!("Invalid mount format: {spec} (expected HOST:GUEST[:ro])"));
    }
    let is_drive = |s: &str| s.len() == 1 && s.chars().all(|c| c.is_ascii_alphabetic());
    let (host_path, rest): (String, Vec<&str>) = if is_drive(parts[0]) && parts.len() >= 3 {
        (format!("{}:{}", parts[0], parts[1]), parts[2..].to_vec())
    } else {
        (parts[0].to_string(), parts[1..].to_vec())
    };
    if rest.is_empty() {
        return Err(format!("Invalid mount format: {spec} (missing guest path)"));
    }
    let (guest_path, options): (String, Vec<&str>) = if is_drive(rest[0]) && rest.len() >= 2 {
        (format!("{}:{}", rest[0], rest[1]), rest[2..].to_vec())
    } else {
        (rest[0].to_string(), rest[1..].to_vec())
    };
    Ok(MountSpec { host_path, guest_path, readonly: options.contains(&"ro") })
}

/// `parseHostSecret` (`env` looks up host environment variables)
pub fn parse_host_secret(
    spec: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> std::result::Result<SecretSpec, String> {
    let Some(at) = spec.find('@') else {
        let (name, value) = match spec.find('=') {
            Some(eq) => (spec[..eq].trim(), Some(spec[eq + 1..].to_string())),
            None => (spec.trim(), None),
        };
        if name.is_empty() {
            return Err(format!("Invalid host-secret format: {spec} (empty name)"));
        }
        let value = value
            .or_else(|| env(name))
            .ok_or_else(|| format!("Environment variable {name} not set for host-secret"))?;
        return Ok(SecretSpec { name: name.to_string(), value, hosts: Vec::new() });
    };
    let name = &spec[..at];
    if name.is_empty() {
        return Err(format!("Invalid host-secret format: {spec} (empty name)"));
    }
    let after = &spec[at + 1..];
    let (hosts, value) = match after.find('=') {
        Some(eq) => (&after[..eq], after[eq + 1..].to_string()),
        None => (
            after,
            env(name)
                .ok_or_else(|| format!("Environment variable {name} not set for host-secret"))?,
        ),
    };
    let hosts: Vec<String> =
        hosts.split(',').filter(|h| !h.is_empty()).map(str::to_string).collect();
    if hosts.is_empty() {
        return Err(format!("Invalid host-secret format: {spec} (no hosts specified)"));
    }
    Ok(SecretSpec { name: name.to_string(), value, hosts })
}

/// `parseSshCredential`
pub fn parse_ssh_credential(
    spec: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> std::result::Result<SshCredentialSpec, String> {
    let expected = || format!("Invalid --ssh-credential format: {spec} (expected HOST=KEY_PATH)");
    let eq = spec.find('=').ok_or_else(expected)?;
    let left = spec[..eq].trim();
    let right = spec[eq + 1..].trim();
    if left.is_empty() || right.is_empty() {
        return Err(expected());
    }
    let mut parts = right.split(',');
    let key_path = parts.next().unwrap_or("").trim().to_string();
    if key_path.is_empty() {
        return Err(format!("Invalid --ssh-credential format: {spec} (missing KEY_PATH)"));
    }
    let mut passphrase = None;
    let mut passphrase_env = None;
    for opt in parts {
        let opt = opt.trim();
        if opt.is_empty() {
            continue;
        }
        if let Some(name) = opt.strip_prefix("passphrase-env=") {
            if name.is_empty() {
                return Err(format!(
                    "Invalid --ssh-credential option: {opt} (missing env var name)"
                ));
            }
            passphrase_env = Some(name.to_string());
            continue;
        }
        if opt == "passphrase-ask" {
            return Err(format!(
                "Invalid --ssh-credential option: {opt} (interactive prompting is not supported; use passphrase-env=ENV)"
            ));
        }
        if let Some(value) = opt.strip_prefix("passphrase=") {
            passphrase = Some(value.to_string());
            continue;
        }
        return Err(format!("Invalid --ssh-credential option: {opt}"));
    }
    if passphrase_env.is_some() && passphrase.is_some() {
        return Err(format!(
            "Invalid --ssh-credential format: {spec} (cannot combine passphrase and passphrase-env)"
        ));
    }
    if let Some(name) = passphrase_env {
        passphrase = Some(env(&name).ok_or_else(|| {
            format!("--ssh-credential passphrase env var '{name}' is not set (for {left})")
        })?);
    }
    let Some(at) = left.find('@') else {
        return Ok(SshCredentialSpec {
            host: left.to_string(),
            username: None,
            key_path,
            passphrase,
        });
    };
    let username = left[..at].trim();
    let host = left[at + 1..].trim();
    if username.is_empty() || host.is_empty() {
        return Err(format!(
            "Invalid --ssh-credential format: {spec} (expected USER@HOST=KEY_PATH)"
        ));
    }
    Ok(SshCredentialSpec {
        host: host.to_string(),
        username: Some(username.to_string()),
        key_path,
        passphrase,
    })
}

/// `parseTcpMapSpec`
pub fn parse_tcp_map(spec: &str) -> std::result::Result<(String, String), String> {
    let err = || {
        format!("Invalid --tcp-map format: {spec} (expected GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT)")
    };
    let trimmed = spec.trim();
    let eq = trimmed.find('=').ok_or_else(err)?;
    if eq == 0 || eq == trimmed.len() - 1 {
        return Err(err());
    }
    let key = trimmed[..eq].trim();
    let value = trimmed[eq + 1..].trim();
    if key.is_empty() || value.is_empty() {
        return Err(err());
    }
    Ok((key.to_string(), value.to_string()))
}

/// `parseVmmOption`
pub fn parse_vmm(value: &str) -> std::result::Result<String, String> {
    let v = value.trim().to_lowercase();
    if v == "qemu" || v == "krun" || v == "firecracker" {
        Ok(v)
    } else {
        Err("--vmm must be one of: qemu, krun, firecracker".into())
    }
}

/// `parseDiskSizeToBytes`
pub fn parse_disk_size(value: &str) -> std::result::Result<u64, String> {
    let quoted = gondolin_wire::json::quote(value);
    let trimmed = value.trim();
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    let (num, rest) = trimmed.split_at(digits);
    let suffix_raw = rest.trim_start();
    if num.is_empty() || !suffix_raw.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(format!(
            "invalid disk size: {quoted} (expected a positive integer with optional K/M/G/T/P/E suffix)"
        ));
    }
    let amount: u128 = num.parse().map_err(|_| format!("disk size is too large: {quoted}"))?;
    if amount == 0 {
        return Err(format!("invalid disk size: {quoted} (expected a positive integer)"));
    }
    let mut suffix = suffix_raw.to_lowercase();
    if suffix.ends_with("ib") {
        suffix.truncate(suffix.len() - 2);
    } else if suffix.ends_with('b') {
        suffix.truncate(suffix.len() - 1);
    }
    let exponent = match suffix.as_str() {
        "" | "byte" | "bytes" => 0,
        "k" => 1,
        "m" => 2,
        "g" => 3,
        "t" => 4,
        "p" => 5,
        "e" => 6,
        _ => {
            return Err(format!(
                "invalid disk size suffix: {} (expected K/M/G/T/P/E)",
                gondolin_wire::json::quote(suffix_raw)
            ));
        }
    };
    let bytes = amount.saturating_mul(1024u128.pow(exponent));
    if bytes > (1u128 << 53) - 1 {
        return Err(format!("disk size is too large: {quoted}"));
    }
    Ok(bytes as u64)
}

/// `parseListenSpec`
pub fn parse_listen(spec: &str) -> std::result::Result<(String, u16), String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("--listen requires a non-empty value".into());
    }
    let mut host = "127.0.0.1".to_string();
    let mut port_str = trimmed.to_string();
    if let Some(rest) = trimmed.strip_prefix('[') {
        let end = rest
            .find(']')
            .ok_or_else(|| format!("Invalid --listen value: {spec} (missing ']')"))?;
        host = rest[..end].to_string();
        if host.is_empty() {
            return Err(format!("Invalid --listen value: {spec} (empty host in brackets)"));
        }
        let after = &rest[end + 1..];
        port_str = after
            .strip_prefix(':')
            .ok_or_else(|| format!("Invalid --listen value: {spec} (expected :PORT after ])"))?
            .to_string();
    } else if let Some(idx) = trimmed.rfind(':') {
        let raw_host = &trimmed[..idx];
        if !raw_host.is_empty() {
            host = raw_host.to_string();
        }
        port_str = trimmed[idx + 1..].to_string();
    }
    let port: u16 = port_str
        .parse()
        .ok()
        .filter(|_| !port_str.is_empty())
        .ok_or_else(|| format!("Invalid --listen value: {spec} (port must be 0-65535)"))?;
    Ok((host, port))
}

fn resolve_ssh_agent(
    explicit: Option<&str>,
    env: &dyn Fn(&str) -> Option<String>,
) -> std::result::Result<String, String> {
    let sock = explicit.map(str::to_string).or_else(|| env("SSH_AUTH_SOCK"));
    match sock.map(|s| s.trim().to_string()) {
        Some(s) if !s.is_empty() => Ok(s),
        _ => Err("--ssh-agent requires a socket path or $SSH_AUTH_SOCK".into()),
    }
}

/// Parses one common option at `args[i]`; returns the index of its last
/// argument, or `None` when `args[i]` is not a common option.
fn parse_common(
    args: &[String],
    i: usize,
    c: &mut CommonOptions,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<usize>> {
    let arg = args[i].as_str();
    if let Some(v) = arg.strip_prefix("--vmm=") {
        c.vmm = Some(parse_vmm(v).map_err(message)?);
        return Ok(Some(i));
    }
    if let Some(v) = arg.strip_prefix("--rootfs-size=") {
        c.rootfs_size = Some(rootfs_size(Some(v))?);
        return Ok(Some(i));
    }
    let value = |what: &str| -> Result<&String> {
        args.get(i + 1).filter(|v| !v.is_empty()).ok_or_else(|| usage(what.to_string()))
    };
    let next = i + 1;
    match arg {
        "--mount-hostfs" => {
            let spec = value("--mount-hostfs requires an argument")?;
            c.mounts.push(parse_mount(spec).map_err(message)?);
        }
        "--mount-memfs" => {
            c.memory_mounts.push(value("--mount-memfs requires a path argument")?.clone());
        }
        "--image" => c.image = Some(value("--image requires an argument")?.clone()),
        "--vmm" => {
            c.vmm = Some(parse_vmm(value("--vmm requires an argument")?).map_err(message)?);
        }
        "--rootfs-size" => c.rootfs_size = Some(rootfs_size(args.get(next).map(String::as_str))?),
        "--print-configure" => {
            c.print_configure = true;
            return Ok(Some(i));
        }
        "--allow-host" => {
            c.allowed_hosts.push(value("--allow-host requires a host argument")?.clone())
        }
        "--hooks-script" => {
            c.hooks_script = Some(value("--hooks-script requires a file argument")?.clone())
        }
        "--host-secret" => {
            let spec = value("--host-secret requires an argument")?;
            c.secrets.push(parse_host_secret(spec, env).map_err(message)?);
        }
        "--dns" => {
            let mode = args.get(next).map(String::as_str).unwrap_or("");
            if !matches!(mode, "synthetic" | "trusted" | "open") {
                return Err(usage("--dns must be one of: synthetic, trusted, open"));
            }
            c.dns_mode = Some(mode.to_string());
        }
        "--dns-trusted-server" => {
            let ip = value("--dns-trusted-server requires an argument")?;
            if ip.parse::<Ipv4Addr>().is_err() {
                return Err(usage("--dns-trusted-server must be a valid IPv4 address"));
            }
            c.dns_trusted_servers.push(ip.clone());
        }
        "--dns-synthetic-host-mapping" => {
            let mode = args.get(next).map(String::as_str).unwrap_or("");
            if !matches!(mode, "single" | "per-host") {
                return Err(usage("--dns-synthetic-host-mapping must be one of: single, per-host"));
            }
            c.dns_synthetic_host_mapping = Some(mode.to_string());
        }
        "--tcp-map" => {
            let (k, v) = parse_tcp_map(value("--tcp-map requires an argument")?).map_err(usage)?;
            match c.tcp_host_mappings.iter_mut().find(|(key, _)| *key == k) {
                Some(entry) => entry.1 = v,
                None => c.tcp_host_mappings.push((k, v)),
            }
        }
        "--ssh-allow-host" => {
            c.ssh_allowed_hosts.push(value("--ssh-allow-host requires a host argument")?.clone())
        }
        "--ssh-agent" => {
            let next_arg = args.get(next).filter(|n| !n.starts_with("--") && *n != "-h");
            c.ssh_agent =
                Some(resolve_ssh_agent(next_arg.map(String::as_str), env).map_err(message)?);
            return Ok(Some(if next_arg.is_some() { next } else { i }));
        }
        "--ssh-known-hosts" => c
            .ssh_known_hosts_files
            .push(value("--ssh-known-hosts requires a path argument")?.clone()),
        "--ssh-credential" => {
            let spec = value("--ssh-credential requires an argument")?;
            c.ssh_credentials.push(parse_ssh_credential(spec, env).map_err(usage)?);
        }
        "--disable-websockets" => {
            c.disable_websockets = true;
            return Ok(Some(i));
        }
        _ => return Ok(None),
    }
    Ok(Some(next))
}

fn rootfs_size(value: Option<&str>) -> Result<String> {
    let value = value
        .filter(|v| !v.is_empty())
        .ok_or_else(|| usage("--rootfs-size requires an argument"))?;
    parse_disk_size(value).map_err(|e| usage(format!("invalid --rootfs-size: {e}")))?;
    Ok(value.to_string())
}

/// `parseBashArgs`
pub fn parse_bash(args: &[String], env: &dyn Fn(&str) -> Option<String>) -> Result<BashArgs> {
    let mut out = BashArgs::default();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            if i + 1 < args.len() {
                out.command = Some(args[i + 1..].to_vec());
            }
            break;
        }
        if let Some(last) = parse_common(args, i, &mut out.common, env)? {
            i = last + 1;
            continue;
        }
        let value = |what: &str| -> Result<String> {
            args.get(i + 1)
                .filter(|v| !v.is_empty())
                .cloned()
                .ok_or_else(|| message(what.to_string()))
        };
        match arg {
            "--listen" => {
                out.listen = Some(("127.0.0.1".into(), 0));
                if let Some(spec) = args.get(i + 1).filter(|s| !s.starts_with("--") && *s != "-h") {
                    out.listen = Some(parse_listen(spec).map_err(message)?);
                    i += 1;
                }
            }
            "--ssh" => out.ssh = true,
            "--ssh-user" => {
                out.ssh_user = Some(value("--ssh-user requires an argument")?);
                i += 1;
            }
            "--ssh-port" => {
                let raw = value("--ssh-port requires an argument")?;
                out.ssh_port =
                    Some(raw.parse().map_err(|_| {
                        message("--ssh-port must be an integer between 0 and 65535")
                    })?);
                i += 1;
            }
            "--ssh-listen" => {
                out.ssh_listen = Some(value("--ssh-listen requires an argument")?);
                i += 1;
            }
            "--cwd" => {
                out.cwd = Some(value("--cwd requires an argument")?);
                i += 1;
            }
            "--env" => {
                out.env.push(value("--env requires an argument")?);
                i += 1;
            }
            "--resume" => {
                out.resume = Some(value("--resume requires an argument")?);
                i += 1;
            }
            "--help" | "-h" => return Err(ParseError::Help),
            other => return Err(usage(format!("Unknown option: {other}"))),
        }
        i += 1;
    }
    Ok(out)
}

/// `parseExecArgs`
pub fn parse_exec(args: &[String], env: &dyn Fn(&str) -> Option<String>) -> Result<ExecArgs> {
    let mut out = ExecArgs::default();
    let mut next_id: u32 = 1;
    let parse_id = |value: Option<&String>, next_id: &mut u32| -> Result<u32> {
        let id: f64 = value
            .and_then(|v| v.parse().ok())
            .filter(|v: &f64| v.is_finite())
            .ok_or_else(|| usage("--id must be a number"))?;
        let id = id as u32;
        if id >= *next_id {
            *next_id = id + 1;
        }
        Ok(id)
    };

    if let Some(sep) = args.iter().position(|a| a == "--") {
        let options = &args[..sep];
        let command = &args[sep + 1..];
        if command.is_empty() {
            return Err(usage("missing command after --"));
        }
        let mut current = ExecCommand {
            cmd: command[0].clone(),
            argv: command[1..].to_vec(),
            env: Vec::new(),
            cwd: None,
            id: next_id,
        };
        next_id += 1;
        let mut i = 0;
        while i < options.len() {
            if let Some(last) = parse_common(options, i, &mut out.common, env)? {
                i = last + 1;
                continue;
            }
            let value = options.get(i + 1).cloned();
            match options[i].as_str() {
                "--sock" => out.sock = value,
                "--env" => current.env.extend(value),
                "--cwd" => current.cwd = value,
                "--id" => current.id = parse_id(options.get(i + 1), &mut next_id)?,
                "--help" | "-h" => return Err(ParseError::Help),
                other => return Err(usage(format!("Unknown argument: {other}"))),
            }
            i += 2;
        }
        out.commands.push(current);
        return Ok(out);
    }

    let mut i = 0;
    while i < args.len() {
        if let Some(last) = parse_common(args, i, &mut out.common, env)? {
            i = last + 1;
            continue;
        }
        let arg = args[i].as_str();
        let value = args.get(i + 1).cloned();
        if arg == "--help" || arg == "-h" {
            return Err(ParseError::Help);
        }
        if arg == "--sock" {
            out.sock = value;
            i += 2;
            continue;
        }
        if arg == "--cmd" {
            out.commands.push(ExecCommand {
                cmd: value.unwrap_or_default(),
                argv: Vec::new(),
                env: Vec::new(),
                cwd: None,
                id: next_id,
            });
            next_id += 1;
            i += 2;
            continue;
        }
        if !matches!(arg, "--arg" | "--env" | "--cwd" | "--id") {
            return Err(usage(format!("Unknown argument: {arg}")));
        }
        let Some(current) = out.commands.last_mut() else {
            return Err(usage(format!("{arg} requires --cmd")));
        };
        match arg {
            "--arg" => current.argv.extend(value),
            "--env" => current.env.extend(value),
            "--cwd" => current.cwd = value,
            _ => {
                let mut n = next_id;
                current.id = parse_id(args.get(i + 1), &mut n)?;
                next_id = n;
            }
        }
        i += 2;
    }
    Ok(out)
}

/// `gondolin attach` arguments.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttachArgs {
    pub session: String,
    pub command: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub env: Vec<String>,
}

/// `parseAttachArgs`
pub fn parse_attach(args: &[String]) -> Result<AttachArgs> {
    if args.is_empty() {
        return Err(usage(""));
    }
    let mut out = AttachArgs::default();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            if i + 1 < args.len() {
                out.command = Some(args[i + 1..].to_vec());
            }
            break;
        }
        if arg == "--help" || arg == "-h" {
            return Err(ParseError::Help);
        }
        if out.session.is_empty() && !arg.starts_with('-') {
            out.session = arg.to_string();
            i += 1;
            continue;
        }
        if arg == "--cwd" || arg == "--env" {
            let v = args
                .get(i + 1)
                .filter(|v| !v.is_empty())
                .cloned()
                .ok_or_else(|| message(format!("{arg} requires an argument")))?;
            if arg == "--cwd" {
                out.cwd = Some(v);
            } else {
                out.env.push(v);
            }
            i += 2;
            continue;
        }
        return Err(usage(format!("Unknown argument: {arg}")));
    }
    if out.session.is_empty() {
        return Err(usage("attach requires a session id"));
    }
    Ok(out)
}

/// `gondolin snapshot` arguments.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotArgs {
    pub session: String,
    pub output: Option<String>,
    pub name: Option<String>,
}

/// `parseSnapshotArgs`
pub fn parse_snapshot(args: &[String]) -> Result<SnapshotArgs> {
    if args.is_empty() {
        return Err(usage(""));
    }
    let mut out = SnapshotArgs::default();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--help" || arg == "-h" {
            return Err(ParseError::Help);
        }
        if out.session.is_empty() && !arg.starts_with('-') {
            out.session = arg.to_string();
            i += 1;
            continue;
        }
        if arg == "--output" || arg == "--name" {
            let v = args
                .get(i + 1)
                .filter(|v| !v.is_empty())
                .cloned()
                .ok_or_else(|| message(format!("{arg} requires an argument")))?;
            if arg == "--output" {
                out.output = Some(v);
            } else {
                out.name = Some(v);
            }
            i += 2;
            continue;
        }
        return Err(usage(format!("Unknown argument: {arg}")));
    }
    if out.session.is_empty() {
        return Err(usage("snapshot requires a session id"));
    }
    if out.output.is_some() && out.name.is_some() {
        return Err(message("--name cannot be combined with --output"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn mounts() {
        assert_eq!(
            parse_mount("/a:/b:ro").unwrap(),
            MountSpec { host_path: "/a".into(), guest_path: "/b".into(), readonly: true }
        );
        assert_eq!(parse_mount("C:\\x:/b").unwrap().host_path, "C:\\x");
        assert!(parse_mount("/a").unwrap_err().contains("expected HOST:GUEST"));
    }

    #[test]
    fn secrets() {
        let env = |n: &str| (n == "TOKEN").then(|| "t".to_string());
        let s = parse_host_secret("TOKEN@a.com,b.com", &env).unwrap();
        assert_eq!(s.hosts, vec!["a.com", "b.com"]);
        assert_eq!(s.value, "t");
        let s = parse_host_secret("X@a.com=v=w", &no_env).unwrap();
        assert_eq!(s.value, "v=w");
        assert!(parse_host_secret("X@a.com", &no_env).unwrap_err().contains("not set"));
        assert!(parse_host_secret("X@=v", &no_env).unwrap_err().contains("no hosts"));
        assert!(parse_host_secret("X=v", &no_env).unwrap().hosts.is_empty());
    }

    #[test]
    fn ssh_credentials() {
        let env = |n: &str| (n == "PW").then(|| "secret".to_string());
        let c = parse_ssh_credential("git@github.com=~/.ssh/id,passphrase-env=PW", &env).unwrap();
        assert_eq!(c.username.as_deref(), Some("git"));
        assert_eq!(c.passphrase.as_deref(), Some("secret"));
        assert!(parse_ssh_credential("h=k,passphrase-ask", &env).is_err());
        assert!(parse_ssh_credential("h=k,passphrase=a,passphrase-env=PW", &env).is_err());
    }

    #[test]
    fn sizes_and_listen() {
        assert_eq!(parse_disk_size("2G").unwrap(), 2 << 30);
        assert_eq!(parse_disk_size("10 MiB").unwrap(), 10 << 20);
        assert_eq!(parse_disk_size("512").unwrap(), 512);
        assert!(parse_disk_size("0").is_err());
        assert!(parse_disk_size("2X").unwrap_err().contains("suffix"));
        assert_eq!(parse_listen(":3000").unwrap(), ("127.0.0.1".into(), 3000));
        assert_eq!(parse_listen("[::1]:80").unwrap(), ("::1".into(), 80));
        assert_eq!(parse_listen("8080").unwrap(), ("127.0.0.1".into(), 8080));
        assert!(parse_listen("x:70000").is_err());
    }

    #[test]
    fn exec_forms() {
        let a = parse_exec(&v(&["--mount-memfs", "/m", "--env", "A=1", "--", "ls", "-l"]), &no_env)
            .unwrap();
        assert_eq!(a.commands[0].cmd, "ls");
        assert_eq!(a.commands[0].argv, vec!["-l"]);
        assert_eq!(a.commands[0].env, vec!["A=1"]);
        assert_eq!(a.common.memory_mounts, vec!["/m"]);

        let a = parse_exec(
            &v(&["--cmd", "sh", "--arg", "-c", "--arg", "echo", "--cmd", "true", "--id", "7"]),
            &no_env,
        )
        .unwrap();
        assert_eq!(a.commands.len(), 2);
        assert_eq!(a.commands[0].argv, vec!["-c", "echo"]);
        assert_eq!((a.commands[0].id, a.commands[1].id), (1, 7));
        assert_eq!(
            parse_exec(&v(&["--arg", "x"]), &no_env).unwrap_err(),
            ParseError::Usage("--arg requires --cmd".into())
        );
        assert_eq!(
            parse_exec(&v(&["--",]), &no_env).unwrap_err(),
            ParseError::Usage("missing command after --".into())
        );
    }

    #[test]
    fn bash_options() {
        let a = parse_bash(
            &v(&[
                "--listen",
                "--ssh",
                "--vmm=krun",
                "--tcp-map",
                "a=b:1",
                "--tcp-map",
                "a=c:2",
                "--",
                "sh",
            ]),
            &no_env,
        )
        .unwrap();
        assert_eq!(a.listen, Some(("127.0.0.1".into(), 0)));
        assert!(a.ssh);
        assert_eq!(a.common.vmm.as_deref(), Some("krun"));
        assert_eq!(a.common.tcp_host_mappings, vec![("a".into(), "c:2".into())]);
        assert_eq!(a.command, Some(vec!["sh".to_string()]));
        assert!(parse_bash(&v(&["--bogus"]), &no_env).is_err());
    }
}
