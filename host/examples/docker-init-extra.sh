# Ensure cgroup v2 is available for Docker
mkdir -p /sys/fs/cgroup
if ! grep -q " /sys/fs/cgroup " /proc/mounts; then
  mount -t cgroup2 cgroup2 /sys/fs/cgroup 2>/dev/null || true
fi

# Docker expects these runtime paths
mkdir -p /var/run /var/lib/docker /run/docker

# Prefer /usr/local/bin so we can install lightweight wrappers for convenience
export PATH=/usr/local/bin:$PATH

# Enable IPv4 forwarding for Docker bridge networking
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

# Ensure containers trust the gondolin MITM CA bundle by default.
# We wrap `docker run` to mount the guest CA bundle and set SSL_CERT_FILE.
if [ -x /usr/bin/docker ]; then
  cat > /usr/local/bin/docker <<'EOF'
#!/bin/sh
set -eu

DOCKER_BIN="/usr/bin/docker"
CA_BUNDLE="/etc/ssl/certs/ca-certificates.crt"

if [ "$#" -gt 0 ] && [ "$1" = "run" ] && [ -r "$CA_BUNDLE" ]; then
  shift
  exec "$DOCKER_BIN" run \
    -e "SSL_CERT_FILE=$CA_BUNDLE" \
    -v "$CA_BUNDLE:$CA_BUNDLE:ro" \
    "$@"
fi

exec "$DOCKER_BIN" "$@"
EOF
  chmod +x /usr/local/bin/docker
  log "[init] installed docker wrapper for CA trust"
fi

# Start dockerd with sandbox-friendly defaults:
# - vfs storage driver (overlayfs is often unavailable in tiny VMs)
# - keep bridge/NAT enabled so containers can reach the network
if command -v dockerd > /dev/null 2>&1; then
  dockerd \
    --host=unix:///var/run/docker.sock \
    --exec-root=/run/docker \
    --data-root=/var/lib/docker \
    --storage-driver=vfs \
    --iptables=true \
    --ip-forward=true \
    --ip-masq=true \
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
