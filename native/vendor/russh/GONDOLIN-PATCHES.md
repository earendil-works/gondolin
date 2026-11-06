# Vendored russh

- Upstream: [russh](https://github.com/warp-tech/russh) **0.65.1**, as published on
  crates.io (git `b33092aad1e51c66258a12e8b83fc473a68d9d34`, path `russh/`).
- License: Apache-2.0. The published crate ships no license file, so `LICENSE`
  holds the standard Apache License 2.0 text.
- Wired in with `[patch.crates-io] russh = { path = "vendor/russh" }` in
  `native/Cargo.toml` and `native/fuzz/Cargo.toml`. The crate is excluded from
  the native workspace, so `make check` (fmt and clippy) skips it, and
  `vendor/rustfmt.toml` keeps rustfmt off the vendored sources.
- Used by `gondolin-sshproxy` only.

Every change to upstream code is marked `// XXX(gondolin-patch): ...`
(`grep -rn 'XXX(gondolin-patch)' native/vendor/russh`).

## Changes when vendoring

- Removed `tests/`, `examples/`, `benches/`, `Cargo.lock`, `Cargo.toml.orig`,
  `.cargo_vcs_info.json` and `.cargo-ok`.
- In `Cargo.toml`, removed the `[[example]]`, `[[test]]` and `[[bench]]`
  targets and all dev-dependencies along with them. A comment marks this.

## Patch 1: consumption-based channel windows (`window_on_consume`)

This is opt-in: `client::Config::window_on_consume` and
`server::Config::window_on_consume` (default `false`). With the option off,
behaviour is unchanged. The fields stay in place, and the per-channel
accounting only starts once a session in this mode installs its doorbell.

Files:
- `src/channels/mod.rs`:
  - `ChannelMsg::WindowConsumed`, a hidden internal message.
  - `Consumed`, the per-channel consumption counter plus the session loop's
    doorbell. It is shared through `WindowSizeRef`, so every `ChannelRef` and
    its `ChannelReadHalf` see the same one.
  - `ChannelReadHalf::wait` records what it hands out.
- `src/channels/io/rx.rs`: `ChannelRx` (`make_reader`) records what it takes.
- `src/client/mod.rs` and `src/server/session.rs`:
  - `wait_channel_confirmation` passes the counter to the read half.
  - `WindowConsumed` handling in `handle_msg` / `dispatch_msg`.
  - The config field (also in `src/server/mod.rs`).
- `src/client/encrypted.rs` (data and extended data) and
  `src/server/encrypted.rs`: in this mode, received data only uses up window.
  The doorbell is installed here; it sends `WindowConsumed` on the
  unbounded priority channel.
- `src/session.rs`: `Encrypted::receive_window` and
  `Encrypted::advertise_consumed`.

### Upstreamable description

**Problem.** russh sends `SSH_MSG_CHANNEL_WINDOW_ADJUST` as soon as channel
data arrives (`adjust_window_size` in the session loop), before the application
has read it. The data then goes into the channel's bounded mpsc
(`channel_buffer_size`). When that buffer is full, the session loop awaits the
`send`, so it stops reading the whole connection. That is the only
backpressure, and it is per connection, not per channel.

Consider an application that relays data between two SSH connections, like
a proxy or jump host, or one that both reads and writes a channel at full
speed. Here the window/control traffic of the opposite direction gets stuck
behind the stalled read:
- Direction A's consumer waits for window from connection 2.
- That window can't be read because connection 2's loop is blocked
  delivering direction B.
- Direction B's consumer waits for window from connection 1, whose loop is
  blocked delivering direction A.

The result is a deadlock as soon as both directions are saturated. We hit
it with `ssh host cat < big | slow-reader` through an exec proxy. Raising
`channel_buffer_size` only moves the threshold, and it lets the peer queue
unbounded data in the meantime.

**API.** A new config flag on `client::Config` and `server::Config`:

```rust
/// Advertise a channel's receive window as the application consumes data
/// (reads it from the channel) instead of as soon as it arrives.
pub window_on_consume: bool, // default: false
```

**Behaviour with the flag on:**
- Incoming `CHANNEL_DATA` / `CHANNEL_EXTENDED_DATA` only decrements the
  window we granted; no adjust is sent on receipt.
- When the application takes a data message out of the channel
  (`ChannelReadHalf::wait`, `Channel::wait`, or the `AsyncRead` from
  `make_reader`), the byte count is credited to the channel. The session
  loop is woken via the existing unbounded priority channel, coalesced so
  there is at most one pending wake-up per channel.
- The loop advertises consumed bytes with the same hysteresis as today. Once
  the peer's remaining window is below half of the target (`window_size`, or
  the server's `Handler::adjust_window` target), it grants what was consumed,
  never beyond the target. Credit that is not yet advertised is kept for the
  next receipt or consumption.

As a result, the peer can have at most one window of data in flight beyond
what the application consumed. The channel's buffer holds at most one window
(plus small-packet overhead), so the session loop no longer blocks on
delivery, and a slow consumer slows only its own channel's sender. Window
adjusts and data for other channels and directions keep flowing.

**Caveat.** A peer that sends many tiny packets can still fill
`channel_buffer_size` messages before using up its window in bytes. In that
case the old loop-blocking backpressure applies again. Sizing the buffer to
at least `window_size / typical packet size` makes this unlikely.

**Tests we run.** `native/crates/gondolin-sshproxy/tests/proxy.rs`:
- `both_directions_saturated_with_slow_consumers` stalls deterministically
  without the flag and passes with it.
- `slow_guest_reader_backpressures_upstream` checks the in-flight bound
  (about 7 MiB with the flag vs about 15 MiB without).

## Re-vendoring (new russh version)

1. Copy the published crate:
   `cp -R ~/.cargo/registry/src/*/russh-X.Y.Z native/vendor/russh.new`. You
   may need a `cargo fetch` of a scratch project that depends on
   `russh = "=X.Y.Z"` first.
2. Repeat "Changes when vendoring" (remove the files, then strip the
   example/test/bench targets and dev-dependencies from `Cargo.toml`). Copy
   `LICENSE`, this file and `vendor/rustfmt.toml` along.
3. Re-apply every `XXX(gondolin-patch)` hunk. `git diff b84c49b
   -- native/vendor/russh` against the unmodified import shows them. Keep the
   markers, and update the upstream version and sha above.
4. Swap the directories, then run `cargo update -p russh`, `make -C native
   check test`, `make native-test-linux` and `make native-release`.
5. If upstream gains an equivalent of patch 1, drop it and switch
   `gondolin-sshproxy` (`window_on_consume` in `src/server.rs` and
   `src/upstream.rs`) to the upstream API. Drop the vendored copy once no
   patches are left.
