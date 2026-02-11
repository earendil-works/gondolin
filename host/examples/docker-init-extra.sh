# Ensure cgroup v2 is available for Docker
mkdir -p /sys/fs/cgroup
if ! grep -q " /sys/fs/cgroup " /proc/mounts; then
  mount -t cgroup2 cgroup2 /sys/fs/cgroup 2>/dev/null || true
fi

# Docker expects these runtime paths
mkdir -p /var/run /var/lib/docker /run/docker

# Start dockerd with sandbox-friendly defaults:
# - vfs storage driver (overlayfs is often unavailable in tiny VMs)
# - no bridge/iptables setup (avoids requiring extra kernel networking modules)
if command -v dockerd > /dev/null 2>&1; then
  dockerd \
    --host=unix:///var/run/docker.sock \
    --exec-root=/run/docker \
    --data-root=/var/lib/docker \
    --storage-driver=vfs \
    --bridge=none \
    --iptables=false \
    --ip-forward=false \
    --ip-masq=false \
    > /var/log/dockerd.log 2>&1 &
  log "[init] started dockerd"
fi

# Wait briefly for daemon readiness
if command -v docker > /dev/null 2>&1; then
  for i in $(seq 1 60); do
    if docker info > /dev/null 2>&1; then
      log "[init] docker ready"
      break
    fi
    sleep 0.1
  done
fi
