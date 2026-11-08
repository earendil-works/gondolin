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
    let mut net = compiled.net;
    if let Some(file) = &common.hooks_script {
        let djs = hooks_script(file)?;
        if let Json::Map(entries) = &mut net {
            entries.push((Json::Text("djs_hooks".into()), djs));
        }
    }
    Ok(Net { net, guest_env })
}

/// `--hooks-script FILE`: `configure.net.djs_hooks`, named by the file's
/// basename like the Node CLI's `createDjsHooks()`. The extension picks the
/// kind: `.mjs` an ES module, `.ts`/`.mts` a TypeScript module, else a script.
/// A module's relative imports are read from disk here (next to the script,
/// recursively) into `modules`, so the daemon does no I/O.
fn hooks_script(file: &str) -> Result<Json, String> {
    let source = std::fs::read_to_string(file)
        .map_err(|e| format!("cannot read --hooks-script {file}: {e}"))?;
    let path = std::path::Path::new(file);
    let filename = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| file.to_string());
    let kind = hooks_script_kind(&filename);
    let mut entries = vec![
        (Json::Text("source".into()), Json::Text(source.clone())),
        (Json::Text("filename".into()), Json::Text(filename.clone())),
        (Json::Text("kind".into()), Json::Text(kind.into())),
    ];
    if kind != "script" {
        let dir = path.parent().unwrap_or(std::path::Path::new("."));
        let modules = hooks_script_modules(dir, &filename, &source)?;
        if !modules.is_empty() {
            let map = modules.into_iter().map(|(k, v)| (Json::Text(k), Json::Text(v))).collect();
            entries.push((Json::Text("modules".into()), Json::Map(map)));
        }
    }
    entries.push((Json::Text("limits".into()), Json::Map(Vec::new())));
    Ok(Json::Map(entries))
}

fn hooks_script_kind(filename: &str) -> &'static str {
    if filename.ends_with(".mjs") {
        "module"
    } else if filename.ends_with(".ts") || filename.ends_with(".mts") {
        "typescript"
    } else {
        "script"
    }
}

/// Most modules a `--hooks-script` may pull in
const MAX_HOOK_MODULES: usize = 256;

/// The modules `source` (key `key`) imports through relative specifiers,
/// transitively, keyed relative to `dir`. Specifiers whose file does not
/// exist (or that leave `dir`) are skipped: the daemon reports them if the
/// policy really imports them.
fn hooks_script_modules(
    dir: &std::path::Path,
    key: &str,
    source: &str,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut modules = std::collections::BTreeMap::new();
    let mut queue = vec![(key.to_string(), source.to_string())];
    while let Some((importer, text)) = queue.pop() {
        if importer.ends_with(".json") {
            continue;
        }
        for spec in import_specifiers(&text) {
            let Some(target) = join_module_key(&importer, &spec) else { continue };
            if target == key || modules.contains_key(&target) {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(dir.join(&target)) else { continue };
            if modules.len() >= MAX_HOOK_MODULES {
                return Err(format!("--hooks-script imports more than {MAX_HOOK_MODULES} modules"));
            }
            modules.insert(target.clone(), contents.clone());
            queue.push((target, contents));
        }
    }
    Ok(modules)
}

/// `relative` (`./x`, `../x`) against the directory of key `base`; `None`
/// for bare specifiers and paths above the root (djs-embed's `ModuleMap`).
fn join_module_key(base: &str, relative: &str) -> Option<String> {
    if !relative.starts_with("./") && !relative.starts_with("../") {
        return None;
    }
    let mut parts: Vec<&str> = base.split('/').collect();
    parts.pop();
    for seg in relative.split('/') {
        match seg {
            "." | "" => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// String literals after `from`, `import` or `import(` (static and dynamic
/// imports, re-exports): a scan, not a parse; the Node CLI's
/// `importSpecifiers` is the same.
fn import_specifiers(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let word = if b[i..].starts_with(b"from") {
            4
        } else if b[i..].starts_with(b"import") {
            6
        } else {
            i += 1;
            continue;
        };
        let start = i;
        i += word;
        if (start > 0 && ident(b[start - 1])) || (i < b.len() && ident(b[i])) {
            continue;
        }
        let mut j = i;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if word == 6 && j < b.len() && b[j] == b'(' {
            j += 1;
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
        }
        if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
            let quote = b[j];
            let end = b[j + 1..].iter().position(|&c| c == quote || c == b'\n');
            if let Some(n) = end
                && b[j + 1 + n] == quote
            {
                out.push(text[j + 1..j + 1 + n].to_string());
                i = j + 2 + n;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specifiers() {
        let src = "import a from './a.js';\nimport { b } from \"../b.ts\"\nexport * from './c.mjs';\n\
                   import './side.js'; const m = import ( './dyn.js' );\nconst x = reimport('./no.js');\n\
                   import deny from './d.json' with { type: 'json' };\nfromage('./no2.js')";
        assert_eq!(
            import_specifiers(src),
            ["./a.js", "../b.ts", "./c.mjs", "./side.js", "./dyn.js", "./d.json"]
        );
    }

    #[test]
    fn keys() {
        assert_eq!(join_module_key("policy.mjs", "./lib/a.js").as_deref(), Some("lib/a.js"));
        assert_eq!(join_module_key("lib/a.js", "../b.js").as_deref(), Some("b.js"));
        assert_eq!(join_module_key("policy.mjs", "../up.js"), None);
        assert_eq!(join_module_key("policy.mjs", "pkg"), None);
    }
}
