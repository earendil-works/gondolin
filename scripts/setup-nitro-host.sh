#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/setup-nitro-host.sh [--pool SIZE] [--slots N]
       scripts/setup-nitro-host.sh --check

Prepares an EC2 instance with Nitro Enclaves enabled (Amazon Linux 2023,
kernel 6.18) to run Gondolin's firecracker backend as AWS Nitro Sandboxes:

- reserves the sandbox memory pool on the kernel command line
  (nitro_enclaves.mempool=SIZE, default 8G; takes effect after a reboot),
- sets the slot budget (one per running sandbox, default 8) now and at every
  boot (systemd unit gondolin-nitro-slots.service),
- installs Firecracker and its jailer (scripts/install-firecracker.sh) unless
  a new enough one is on PATH.

Run as root (or with sudo available). --check only reports whether the host
is ready and exits non-zero if it is not. See docs/nitro.md.
USAGE
}

POOL=8G
SLOTS=8
CHECK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pool) POOL=$2; shift 2 ;;
    --slots) SLOTS=$2; shift 2 ;;
    --check) CHECK=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
sysfs=/sys/class/misc/nitro_enclaves
SUDO=""
[[ "$(id -u)" == 0 ]] || SUDO=sudo

problems=0
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; problems=$((problems + 1)); }

check() {
  echo "Nitro Sandbox host check:"
  if [[ -e /dev/nitro_enclaves ]]; then
    ok "/dev/nitro_enclaves present"
  else
    bad "/dev/nitro_enclaves missing: launch the instance with Nitro Enclaves enabled (--enclave-options Enabled=true) from the AL2023 kernel-6.18 AMI"
  fi
  local total free slots slots_total
  total=$(cat "$sysfs/mem_pool/total" 2>/dev/null || echo 0)
  free=$(cat "$sysfs/mem_pool/free" 2>/dev/null || echo 0)
  if [[ "$total" -gt 0 ]]; then
    ok "memory pool: $((free >> 20)) MiB free of $((total >> 20)) MiB"
  else
    bad "no memory pool reserved: run this script without --check, then reboot"
  fi
  slots=$(cat "$sysfs/pcie_slots" 2>/dev/null || echo 0)
  slots_total=$(cat "$sysfs/pcie_slots_total" 2>/dev/null || echo 0)
  if [[ "$slots" -gt 0 ]]; then
    ok "slot budget: $slots of $slots_total"
  else
    bad "slot budget is 0: run this script without --check"
  fi
  local version
  if version=$(firecracker --version 2>/dev/null | head -1) &&
    [[ "$version" =~ v([0-9]+)\.([0-9]+) ]] &&
    { [[ ${BASH_REMATCH[1]} -gt 1 ]] || [[ ${BASH_REMATCH[2]} -ge 18 ]]; }; then
    ok "$version"
  else
    bad "Firecracker 1.18 or newer not found on PATH: scripts/install-firecracker.sh"
  fi
  if command -v jailer >/dev/null 2>&1; then
    ok "jailer present (VMMs run jailed when the daemon is root)"
  else
    bad "jailer not found on PATH: scripts/install-firecracker.sh installs it"
  fi
  if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
    ok "cgroup v2 ($(cat /sys/fs/cgroup/cgroup.controllers))"
  else
    bad "no cgroup v2: jailed VMMs run without resource limits"
  fi
  if [[ $problems -gt 0 ]]; then
    echo "$problems problem(s) found"
    return 1
  fi
  echo "ready"
}

if [[ $CHECK == 1 ]]; then
  check
  exit $?
fi

if [[ ! -e /dev/nitro_enclaves ]]; then
  echo "/dev/nitro_enclaves missing: this instance does not have Nitro Enclaves enabled" >&2
  exit 1
fi

reboot_needed=0
if grep -q "nitro_enclaves.mempool=" /proc/cmdline; then
  echo "memory pool already reserved: $(grep -o 'nitro_enclaves.mempool=[^ ]*' /proc/cmdline)"
else
  echo "reserving a $POOL memory pool (nitro_enclaves.mempool=$POOL)"
  $SUDO grubby --update-kernel=ALL --args="nitro_enclaves.mempool=$POOL"
  reboot_needed=1
fi

echo "slot budget: $SLOTS (now and at boot)"
$SUDO tee /etc/systemd/system/gondolin-nitro-slots.service >/dev/null <<UNIT
[Unit]
Description=Nitro Enclaves slot budget for Gondolin's Nitro Sandboxes
After=systemd-modules-load.service
ConditionPathExists=$sysfs/pcie_slots

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo $SLOTS > $sysfs/pcie_slots'

[Install]
WantedBy=multi-user.target
UNIT
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now gondolin-nitro-slots.service >/dev/null

if firecracker --version 2>/dev/null | grep -qE 'v(1\.(1[89]|[2-9][0-9])|[2-9])' && command -v jailer >/dev/null 2>&1; then
  echo "Firecracker and jailer already installed"
else
  "$here/install-firecracker.sh"
fi

if [[ $reboot_needed == 1 ]]; then
  echo
  echo "Reboot to reserve the memory pool, then check with: $0 --check"
else
  echo
  check
fi
