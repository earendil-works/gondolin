#!/bin/sh
# (named gondolind-* so the SDK runs it as the daemon itself)
# Runs the gondolind binary named by GONDOLIN_DAEMON_BIN as root, for test
# runs whose SDK runs as an ordinary user (GONDOLIN_NATIVE_BIN=<this script>):
# the firecracker backend creates network namespaces and taps and starts VMMs
# under Firecracker's jailer, which needs root. Requires passwordless sudo.
set -eu
: "${GONDOLIN_DAEMON_BIN:?set GONDOLIN_DAEMON_BIN to the gondolind binary}"
# setsid: sudo does not relay signals sent from the command's own process
# group, which the SDK (our parent) would share without it
exec setsid sudo -n env \
  PATH="$PATH" \
  HOME=/root \
  XDG_CACHE_HOME=/root/.cache \
  ${GONDOLIN_JAILER:+GONDOLIN_JAILER="$GONDOLIN_JAILER"} \
  ${GONDOLIN_DEBUG:+GONDOLIN_DEBUG="$GONDOLIN_DEBUG"} \
  ${RUST_LOG:+RUST_LOG="$RUST_LOG"} \
  "$GONDOLIN_DAEMON_BIN" "$@"
