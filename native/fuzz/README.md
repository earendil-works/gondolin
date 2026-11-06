# gondolind fuzz targets

cargo-fuzz targets for everything that parses guest-controlled bytes. Needs a
nightly toolchain and `cargo install cargo-fuzz`; not a member of the `native/`
workspace.

```bash
make native-fuzz                                   # every target, 120 s each
make native-fuzz FUZZ_TARGETS=egress_flow FUZZ_TIME=600
cd native/fuzz && cargo +nightly fuzz run netstack_stack
```

| target | input |
|---|---|
| `netstack_parse` | Ethernet/IPv4/UDP/TCP headers, DNS queries + synthetic answers + per-host mapping, DHCP, resolv.conf |
| `netstack_stack` | a real `NetStack` fed structured guest frames (ARP/ICMP/UDP/DNS/DHCP/raw, TCP incl. completed handshakes), flows echoed |
| `egress_flow` | a guest TCP flow into `Egress` (classification, hyper HTTP/1 parsing, request pipeline with secrets and a body-pulling hook, TLS accept); 4 control bytes + raw stream, seeds in `seeds/egress_flow` |
| `egress_policy` | secret substitution on arbitrary heads, host patterns, internal-ip checks, classification |
| `tls_client_hello` | ClientHello sniffing (rustls `Acceptor`, SNI/ALPN) |
| `wire_guest` | guest channel framing, CBOR decode, gondolind's sandboxfs and TCP-forwarder port handlers |
| `sshproxy_flow` | arbitrary bytes after the `SSH-` banner into the guest-facing SSH server |
| `sshproxy_parse` | git exec command parsing, known_hosts, allowlist patterns |

Crashes land in `artifacts/<target>/`; reproduce with
`cargo +nightly fuzz run <target> artifacts/<target>/<file>` and add a unit test
next to the fix.
