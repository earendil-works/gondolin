//! The CLI flag compiler against payloads of the TypeScript CLI
//! (`tests/fixtures/cli-net/gen.ts` → `cases.json`).

use std::collections::BTreeMap;

use gondolin_egress::cli_policy::{CompileCtx, NetFlags, compile_cli_net};
use serde_json::Value;

fn normalize(value: &mut Value, marker: Option<&str>, home: &str) {
    match value {
        Value::String(s) => {
            if let Some(marker) = marker {
                *s = s.replace(marker, "<MARKER>");
            }
            if !home.is_empty()
                && let Some(rest) = s.strip_prefix(&format!("{home}/"))
            {
                *s = format!("<HOME>/{rest}");
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| normalize(v, marker, home)),
        Value::Object(map) => map.values_mut().for_each(|v| normalize(v, marker, home)),
        _ => {}
    }
}

#[test]
fn matches_the_typescript_cli() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/cli-net/cases.json")).unwrap();
    let home = std::env::var("HOME").unwrap_or_default();
    assert!(cases.len() >= 30);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let flags: NetFlags = serde_json::from_value(case["flags"].clone())
            .unwrap_or_else(|e| panic!("{name}: flags: {e}"));
        let ctx = CompileCtx {
            mitm_ca: Some(("<CERT>".into(), "<KEY>".into())),
            mac: Some(case["ctx"]["mac"].as_str().unwrap_or("02:00:00:00:00:01").into()),
            checksum_offload: case["ctx"]["checksum_offload"].as_bool().unwrap_or(false),
        };
        let result = compile_cli_net(&flags, &ctx);
        if let Some(expected) = case.get("error") {
            assert_eq!(result.err().as_deref(), expected.as_str(), "{name}");
            continue;
        }
        let compiled = result.unwrap_or_else(|e| panic!("{name}: {e}"));
        let mut net = compiled.net;
        let marker = net["policy"]["rules"]["marker"].as_str().map(str::to_string);
        if let Some(marker) = &marker {
            assert_eq!(marker.len(), 48, "{name}");
        }
        let obj = net.as_object_mut().unwrap();
        // by design: system/webpki roots instead of node's CA store
        assert_eq!(obj.remove("use_system_roots"), Some(Value::Bool(true)), "{name}");
        assert_eq!(obj.remove("use_webpki_roots"), Some(Value::Bool(true)), "{name}");
        normalize(&mut net, marker.as_deref(), &home);
        assert_eq!(net, case["net"], "{name}");

        let mut env: BTreeMap<String, String> = compiled.guest_env;
        for value in env.values_mut() {
            if let Some(marker) = &marker {
                *value = value.replace(marker.as_str(), "<MARKER>");
            }
        }
        let expected: BTreeMap<String, String> =
            serde_json::from_value(case["guest_env"].clone()).unwrap();
        assert_eq!(env, expected, "{name}");
    }
}

#[test]
fn compiled_payload_decodes_as_the_daemon_config() {
    let flags = NetFlags {
        allow_hosts: vec!["api.example.com".into()],
        tcp_maps: vec![("db".into(), "127.0.0.1:5432".into())],
        ..NetFlags::default()
    };
    let compiled = compile_cli_net(&flags, &CompileCtx::default()).unwrap();
    // the egress part is what `gondolind` decodes from `configure.net`
    let config: gondolin_proto::net::NetConfig =
        serde_json::from_value(compiled.net.clone()).unwrap();
    assert_eq!(config.tcp_hosts.len(), 1);
    assert!(config.use_system_roots && config.use_webpki_roots);
    assert_eq!(config.policy.rules.unwrap().allowed_hosts, vec!["api.example.com".to_string()]);
    let stack: gondolin_netstack::NetConfig =
        serde_json::from_value(compiled.net["stack"].clone()).unwrap();
    assert_eq!(stack.dns.synthetic_host_mapping, gondolin_netstack::SyntheticHostMapping::PerHost);
}
