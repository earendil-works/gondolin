//! The CLI flag compiler against payloads of the TypeScript CLI
//! (`tests/fixtures/cli-net/gen.ts` → `cases.json`).

use std::collections::BTreeMap;

use gondolin_egress::cli_policy::{CompileCtx, NetFlags, compile_cli_net};
use gondolin_wire::Value;

fn normalize(value: &mut Value, marker: Option<&str>, home: &str) {
    match value {
        Value::Text(s) => {
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
        Value::Map(map) => {
            map.iter_mut().for_each(|(_, v)| normalize(v, marker, home));
            // key order is not significant
            map.sort_by(|a, b| a.0.as_str().cmp(&b.0.as_str()));
        }
        _ => {}
    }
}

#[test]
fn matches_the_typescript_cli() {
    let cases: Vec<Value> = gondolin_wire::json::parse(include_str!("fixtures/cli-net/cases.json"))
        .unwrap()
        .into_array()
        .unwrap();
    let home = std::env::var("HOME").unwrap_or_default();
    assert!(cases.len() >= 30);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let flags: NetFlags = gondolin_wire::from_value(&case["flags"])
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
        // by design: system/webpki roots instead of node's CA store
        assert_eq!(net.remove("use_system_roots"), Some(Value::Bool(true)), "{name}");
        assert_eq!(net.remove("use_webpki_roots"), Some(Value::Bool(true)), "{name}");
        normalize(&mut net, marker.as_deref(), &home);
        let mut expected = case["net"].clone();
        normalize(&mut expected, None, "");
        assert_eq!(net, expected, "{name}");

        let mut env: BTreeMap<String, String> = compiled.guest_env;
        for value in env.values_mut() {
            if let Some(marker) = &marker {
                *value = value.replace(marker.as_str(), "<MARKER>");
            }
        }
        let expected: BTreeMap<String, String> =
            gondolin_wire::from_value(&case["guest_env"]).unwrap();
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
    let config: gondolin_proto::net::NetConfig = gondolin_wire::from_value(&compiled.net).unwrap();
    assert_eq!(config.tcp_hosts.len(), 1);
    assert!(config.use_system_roots && config.use_webpki_roots);
    assert_eq!(config.policy.rules.unwrap().allowed_hosts, vec!["api.example.com".to_string()]);
    let stack: gondolin_netstack::NetConfig =
        gondolin_wire::from_value(&compiled.net["stack"]).unwrap();
    assert_eq!(stack.dns.synthetic_host_mapping, gondolin_netstack::SyntheticHostMapping::PerHost);
}
