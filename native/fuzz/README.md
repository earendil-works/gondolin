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
| `egress_flow` | a guest TCP flow into `Egress` (classification, `gondolin-http` HTTP/1 parsing, request pipeline with secrets and a body-pulling hook, TLS accept); 4 control bytes + raw stream, seeds in `seeds/egress_flow` |
| `http_codec` | `gondolin-http` sans-io core: request/response heads, framing rules, re-encoding round trips, body decoding under arbitrary input splits |
| `http_conn` | `gondolin-http` server and client connections on arbitrary peer bytes (bodies, 100-continue, upgrades, keep-alive, untrusted responses) |
| `url_parse` | `gondolin-http`'s WHATWG URL parser differentially against the `url` crate (parse, components, `join`, query pairs; special schemes, ASCII hosts) |
| `x509_parse` | `gondolin_egress::x509` DER reader (CA subject, public key, key identifier) and encoders on arbitrary bytes |
| `egress_policy` | secret substitution on arbitrary heads, host patterns, internal-ip checks, classification |
| `tls_client_hello` | ClientHello sniffing (rustls `Acceptor`, SNI/ALPN) |
| `wire_guest` | guest channel framing, CBOR decode, gondolind's sandboxfs and TCP-forwarder port handlers |
| `sshproxy_flow` | arbitrary bytes after the `SSH-` banner into the guest-facing SSH server |
| `assets_tar` | image archive tar reader and extraction into a temp dir (nothing outside the destination, no escaping symlinks); seeds in `seeds/assets_tar` |
| `assets_gzip` | gzip framing/CRC-32 around miniz_oxide: arbitrary bytes, plus framed deflate round trips with one corrupted byte |
| `hooks_djs` | tier-2 hooks (djs): guest heads/bodies into fixed policies that echo them into decisions (Request/Response/Headers/URL validation in the shim and the host), gzip response decoding; no panic, every call a decision or a `HookError` |
| `ssh_transport` | the SSH core: raw bytes into a fresh client/server transport (ident, KEXINIT, ECDH), and encrypted payloads after a real handshake into the connection layer |
| `ssh_keys` | private key files (OpenSSH/PEM/PKCS#8), public key blobs and lines, signatures, ssh-agent replies |
| `sshproxy_parse` | git exec command parsing, known_hosts, allowlist patterns |
| `qcow2_parse` | `gondolin-qcow2` on arbitrary images: header re-encoding, L1/L2 mapping, safe rebase of an empty overlay over the image (guest view unchanged), allocating writes, grow and backing rewrite; seeds in `seeds/qcow2_parse` (small QEMU images) |

Crashes land in `artifacts/<target>/`; reproduce with
`cargo +nightly fuzz run <target> artifacts/<target>/<file>` and add a unit test
next to the fix.
