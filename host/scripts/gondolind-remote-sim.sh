#!/usr/bin/env bash
# Run gondolind as if it were on another machine: its own HOME,
# XDG_CACHE_HOME, TMPDIR and working directory, so nothing the controller
# has on disk is visible through the usual locations. Used as
# GONDOLIN_NATIVE_COMMAND together with GONDOLIN_NATIVE_REMOTE=1.
#
# GONDOLIN_REMOTE_SIM_DIR   state of the simulated machine (default /tmp/gondolin-remote-sim-$UID)
# GONDOLIN_REMOTE_BIN       gondolind binary (default: native/target/debug/gondolind)
# GONDOLIN_REMOTE_GUEST_DIR guest image directory "installed" on the remote (optional)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="${GONDOLIN_REMOTE_SIM_DIR:-/tmp/gondolin-remote-sim-$(id -u)}"
bin="${GONDOLIN_REMOTE_BIN:-$here/../native/target/debug/gondolind}"
mkdir -p "$root/home" "$root/cache" "$root/cwd"
tmp="$(mktemp -d "$root/tmp.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

env_args=(
  HOME="$root/home"
  XDG_CACHE_HOME="$root/cache"
  TMPDIR="$tmp"
  PATH="$PATH"
)
if [[ -n "${GONDOLIN_REMOTE_GUEST_DIR:-}" ]]; then
  env_args+=(GONDOLIN_GUEST_DIR="$GONDOLIN_REMOTE_GUEST_DIR")
fi
cd "$root/cwd"
# a clean environment: nothing of the controller's GONDOLIN_* settings leaks
env -i "${env_args[@]}" "$bin" "$@"
