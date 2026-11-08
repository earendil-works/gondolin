# Native network path: security review

Scope: everything in `gondolind` that faces the untrusted guest on the network
side (`gondolin-netstack`, `gondolin-egress`, `gondolin-sshproxy`, the guest
channel framing of `gondolind`) and the controller's handling of daemon
messages (a remote daemon is not trusted blindly). Reference: the threat model
in `docs/security.md` and `docs/network.md`, and the node engine as the
behavioural baseline. Reviewed at the state of `native/egress` after the
phase 2 merge (November 2026).

> Status (historical): later changes are not reviewed here beyond the notes
> already added (own HTTP/1.1, SSH and x509 code, panic containment). Release
> builds now unwind (`panic = "unwind"`), so finding 1's `panic = "abort"`
> impact no longer applies. Tier-2 djs hooks (`gondolin-hooks-djs`) came
> after this review; they and the newer fuzz targets `wire_cbor`,
> `wire_json`, `assets_tar`, `assets_gzip` and `hooks_djs` are not in the
> tables below (`native/fuzz/fuzz_targets/` has the full list).
>
> The node engine, the behavioural baseline of this review, has since been
> removed; the "node" comparisons describe it as it was at review time. With
> it went `vfs_rpc` (finding 8) and the TypeScript network stack in the table
> "Guarantees checked"; the daemon→controller requests are now `hook_call`,
> `body_pull`, `ssh_hook_call`, `vfs_call` and `vfs_hook`.

## Summary

| # | finding | severity | status |
|---|---|---|---|
| 1 | Guest-triggered panic in Basic auth parsing (multi-byte char slicing); with `panic = "abort"` it kills the daemon and the VM | high (availability) | fixed, regression test, found by `egress_flow` fuzzing |
| 2 | Decompressed hook bodies were unbounded on the controller (gzip bomb against a body-reading `onResponse`) | medium (controller memory) | fixed: decoded bytes limited to `maxHttpResponseBodyBytes` (`502` like node) |
| 3 | `normalize()` (CBOR → JS, used for guest and daemon messages) assigned a `__proto__` key as the object's prototype | low | fixed: defined as an own property |
| 4 | Worst-case daemon memory from guest TCP buffers: 1024 flows × 256 KiB rx + 256 KiB tx | low (DoS is a non-goal) | documented; tune `max_tcp_flows`/buffers if needed |
| 5 | Body retention for body-reading hooks: up to `max_*_body_bytes` per request × 128 concurrent requests | low (same as node, which buffers whole bodies) | documented |
| 6 | MITM leaf generation per new SNI costs CPU (ECDSA keygen + CA signature) | low (DoS) | documented; node is slower (RSA keygen) |
| 7 | Internal-range check did not treat NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 (`2002::/16`), Teredo (`2001::/32`) or IPv4-compatible IPv6 as their embedded IPv4 | low (inherited from node) | fixed in both engines: the embedded IPv4 (Teredo: server and client; local-use NAT64: every RFC 6052 position, failing closed) is checked |
| 8 | A remote daemon can issue unbounded concurrent requests to the controller (`hook_call`, `vfs_rpc` (since removed), `body_pull`) | low (remote daemon is semi-trusted; frames are capped at 4 MiB) | documented |
| 9 | `net` debug logs include request URLs after secret substitution when `replaceSecretsInQuery` is on | info (same as node; debug only, local) | documented |

No finding allows a guest to read secrets, reach non-allowlisted or internal
destinations, or escape the classification (raw TCP); see "Guarantees" below.

## Fuzzing

`native/fuzz/` (cargo-fuzz, nightly; `make native-fuzz`), every target run for
≥ 5 minutes (millions of executions for the parsers, ~20 k stack sessions for
`netstack_stack`):

| target | covers | result |
|---|---|---|
| `netstack_parse` | Ethernet/IPv4/UDP/TCP headers, DNS queries/answers/per-host map, DHCP, resolv.conf | clean |
| `netstack_stack` | real `NetStack` with structured guest frames incl. completed TCP handshakes | clean |
| `egress_flow` | `Egress::handle_tcp`: classification, HTTP/1 (`gondolin-http`), pipeline with secrets + body-pulling hook, TLS accept | finding 1 |
| `http_codec` | `gondolin-http` head parsing/framing rules, re-encoding round trips, Content-Length/chunked/close-delimited decoding under arbitrary input splits | clean |
| `url_parse` | `gondolin-http` URL parser vs the `url` crate (differential: parse, components, `join`, query pairs) | clean (only known url-crate deviations from WHATWG excluded) |
| `x509_parse` | DER reading of CA certificates/public keys (subject, SPKI, key identifier), SAN and time encoding | clean |
| `http_conn` | `gondolin-http` server (bodies, 100-continue, upgrades, keep-alive) and client (untrusted response heads/bodies) on arbitrary peer bytes | clean |
| `egress_policy` | secret substitution, host patterns, internal IPs, classification | clean |
| `tls_client_hello` | ClientHello / SNI / ALPN sniffing | clean |
| `wire_guest` | guest frame reader, CBOR decode, sandboxfs and TCP-forwarder port handlers | clean |
| `sshproxy_flow` | guest-facing SSH server after the banner | clean |
| `sshproxy_parse` | git exec parsing, known_hosts, allowlist patterns | clean |
| `ssh_transport` | own SSH core: raw transport input, encrypted connection-layer payloads after a handshake | clean (2 min × 6 workers) |
| `ssh_keys` | key files, public key blobs, signatures, agent replies | clean (2 min × 6 workers) |

Notes: release builds now unwind and contain panics (`native/DESIGN.md`,
"Panics"): a panic in a guest flow resets that flow, a panicking request is
answered with an error, and only panics in the session task or the network
stack driver stop the VM (fail closed); keep fuzzing new guest-facing code. String slicing
of header values must use `get()`: header strings carry latin1 bytes as chars,
so non-ASCII bytes are multi-byte in Rust strings.

## Guarantees checked (native vs node)

The node column is the removed node engine at review time.

| property | node engine (removed) | native engine |
|---|---|---|
| only HTTP/1.x, TLS (MITM), allowlisted SSH, mapped TCP leave the VM | classification in `network-stack.ts` | `classify.rs` (same rules, 8 KiB sniff limit, CONNECT/unknown reset), fuzzed |
| policy on the request host, host-side resolution | `resolveHostname` + undici lookup guard | `PolicyEngine::resolve_allowed` + `GuardedConnector` (every new upstream connection), tested with rebinding |
| internal ranges blocked by default | `isInternalIpAddress` | `ip.rs` (same ranges; both check IPv4 embedded in mapped/compatible, NAT64, 6to4 and Teredo IPv6) |
| redirects re-validated, credentials dropped cross-origin | `fetchHookRequestAndRespond` | same loop (max 10), tests |
| secrets only to allowed hosts; revoked/deleted values rejected; Basic auth decoded | `createHttpHooks` | `secrets.rs` port with the TS test cases, fuzzed |
| absolute-form requests | `Host` from the guest is forwarded | `Host` rewritten to the URL authority (no virtual-host steering) |
| upstream TLS verification | undici / node CA store | rustls/webpki with node's default CA store sent by the controller |
| guest never sees the CA key | key stays in the controller | key in the controller (local) or daemon (remote); never mounted into the guest |
| request head limit | 64 KiB → `431` | 64 KiB → `431` with the node message (heads over 72 KiB are rejected while reading), 1024 headers |
| request body limit | `maxHttpBodyBytes` (`413`) | same (Content-Length upfront, chunked while streaming) |
| response limit with `onResponse` | whole body buffered, `502` above the limit | only what the hook reads is retained; limit enforced on retained and on decoded bytes |
| pipelined/extra request bytes | discarded up to 64 KiB, then abort | drained up to 64 KiB / 2 s after the response, then closed |
| WebSocket pending data | 4 MiB cap | backpressure (no buffering) |
| upstream timeouts | undici defaults (connect 10 s, headers/body 300 s) | same values |
| concurrent bridged requests | 128 | 128 |
| MITM leaf cache | 256 entries, 10 min ttl | same |
| DNS upstream sockets | 128 | 128 (netstack) |
| TCP flows | no explicit cap | 1024 (netstack) |
| SSH egress | exec only, known_hosts, caps | same (`gondolin-sshproxy`), remote sends known_hosts as content |

## Controller vs remote daemon

The daemon trusts the controller. The controller treats a remote daemon as
semi-trusted (it runs the VM and sees all guest traffic anyway), but must not
let it reach outside the session:

- frames above 4 MiB are rejected (`NativeFrameReader`), the connection is killed;
- daemon stderr lines are capped (64 KiB without newline);
- CBOR maps decode to null-prototype objects; `normalize()` no longer turns a
  `__proto__` key into a prototype (finding 3);
- `hook_call` payloads only reach the user's hooks through WHATWG
  `Request`/`Response` constructors (invalid input throws → `502`); decisions
  sent back are bounded by the configured body limits; large replacement
  bodies are streamed, not inlined;
- the remote configure payload contains no controller paths or private keys
  (`assertRemoteConfigure`; SSH known_hosts are sent as content, the MITM CA is
  the daemon's own);
- not bounded: the number of concurrent daemon→controller requests (finding 8).
