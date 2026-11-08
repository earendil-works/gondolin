//! CLI network flags → `configure.net` via `gondolin_egress::cli_policy` (the
//! egress-owned port of `buildVmOptions` + `createHttpHooks` +
//! `NativeNetwork.configure()`).

use gondolin_egress::cli_policy::{
    CompileCtx, DnsFlags, NetFlags, SecretFlag, SshCredentialFlag, SshFlags, compile_cli_net,
};
use gondolin_wire::Value as Json;

use crate::args::CommonOptions;

/// Session facts for the compiler.
pub struct Context<'a> {
    pub mitm_cert_pem: String,
    pub mitm_key_pem: String,
    pub mac: String,
    pub checksum_offload: bool,
    /// host environment lookup
    pub env: &'a dyn Fn(&str) -> Option<String>,
}

/// `configure.net` and the guest environment it implies.
pub struct Net {
    pub net: Json,
    /// `KEY=VALUE` (secret placeholders)
    pub guest_env: Vec<String>,
}

/// The `NetFlags` of the CLI options (reads `--ssh-credential` key files).
pub fn flags(common: &CommonOptions) -> Result<NetFlags, String> {
    for secret in &common.secrets {
        if secret.hosts.is_empty() {
            return Err(format!(
                "--host-secret {} needs explicit hosts in the native CLI: use --host-secret {}@HOST[,HOST...] (host suggestions need the Node CLI: npx @earendil-works/gondolin)",
                secret.name, secret.name
            ));
        }
    }
    let mut credentials = Vec::new();
    for c in &common.ssh_credentials {
        let path = std::path::absolute(&c.key_path).map_err(|e| e.to_string())?;
        if !path.exists() {
            return Err(format!("SSH key file does not exist: {}", c.key_path));
        }
        let private_key_pem = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read SSH key {}: {e}", c.key_path))?;
        credentials.push(SshCredentialFlag {
            host: c.host.clone(),
            username: c.username.clone(),
            private_key_pem,
            passphrase: c.passphrase.clone(),
        });
    }
    let dns = (common.dns_mode.is_some()
        || !common.dns_trusted_servers.is_empty()
        || common.dns_synthetic_host_mapping.is_some())
    .then(|| DnsFlags {
        mode: common.dns_mode.clone(),
        trusted_servers: common.dns_trusted_servers.clone(),
        synthetic_host_mapping: common.dns_synthetic_host_mapping.clone(),
    });
    let ssh = (!common.ssh_allowed_hosts.is_empty()
        || common.ssh_agent.is_some()
        || !common.ssh_known_hosts_files.is_empty()
        || !credentials.is_empty())
    .then(|| SshFlags {
        allow_hosts: common.ssh_allowed_hosts.clone(),
        agent: common.ssh_agent.clone(),
        known_hosts_files: common.ssh_known_hosts_files.iter().map(Into::into).collect(),
        credentials,
    });
    Ok(NetFlags {
        allow_hosts: common.allowed_hosts.clone(),
        secrets: common
            .secrets
            .iter()
            .map(|s| SecretFlag {
                name: s.name.clone(),
                hosts: s.hosts.clone(),
                value: s.value.clone(),
            })
            .collect(),
        disable_websockets: common.disable_websockets,
        dns,
        tcp_maps: common.tcp_host_mappings.clone(),
        ssh,
    })
}

/// Compiles `configure.net`.
pub fn compile(common: &CommonOptions, ctx: &Context<'_>) -> Result<Net, String> {
    let _ = ctx.env;
    let flags = flags(common)?;
    let compiled = compile_cli_net(
        &flags,
        &CompileCtx {
            mitm_ca: Some((ctx.mitm_cert_pem.clone(), ctx.mitm_key_pem.clone())),
            mac: Some(ctx.mac.clone()),
            checksum_offload: ctx.checksum_offload,
        },
    )?;
    // the node CLI's env follows the secret order
    let mut guest_env = Vec::new();
    for s in &common.secrets {
        if let Some(p) = compiled.guest_env.get(&s.name)
            && !guest_env.iter().any(|e: &String| e.starts_with(&format!("{}=", s.name)))
        {
            guest_env.push(format!("{}={p}", s.name));
        }
    }
    Ok(Net { net: compiled.net, guest_env })
}
