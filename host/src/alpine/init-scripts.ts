// Embedded init scripts used by the Alpine image builder

export const ROOTFS_INIT_SCRIPT = `#!/bin/sh
set -eu

CONSOLE="/dev/console"
if [ ! -c "\${CONSOLE}" ]; then
  if [ -c /dev/ttyAMA0 ]; then
    CONSOLE="/dev/ttyAMA0"
  elif [ -c /dev/ttyS0 ]; then
    CONSOLE="/dev/ttyS0"
  else
    CONSOLE=""
  fi
fi

log() {
  if [ -n "\${CONSOLE}" ]; then
    printf "%s\\n" "$*" > "\${CONSOLE}" 2>/dev/null || printf "%s\\n" "$*"
  else
    printf "%s\\n" "$*"
  fi
}

log_cmd() {
  if [ -n "\${CONSOLE}" ]; then
    "$@" > "\${CONSOLE}" 2>&1 || "$@" || true
  else
    "$@" || true
  fi
}

setup_virtio_ports() {
  if [ ! -d /sys/class/virtio-ports ]; then
    return
  fi

  mkdir -p /dev/virtio-ports

  for port_path in /sys/class/virtio-ports/vport*; do
    if [ ! -e "\${port_path}" ]; then
      continue
    fi

    port_device="$(basename "\${port_path}")"
    dev_node="/dev/\${port_device}"

    if [ ! -c "\${dev_node}" ] && [ -r "\${port_path}/dev" ]; then
      dev_nums="$(cat "\${port_path}/dev" 2>/dev/null || true)"
      major="\${dev_nums%%:*}"
      minor="\${dev_nums##*:}"
      if [ -n "\${major}" ] && [ -n "\${minor}" ]; then
        mknod "\${dev_node}" c "\${major}" "\${minor}" 2>/dev/null || true
        chmod 600 "\${dev_node}" 2>/dev/null || true
      fi
    fi

    if [ -r "\${port_path}/name" ]; then
      port_name="$(cat "\${port_path}/name" 2>/dev/null || true)"
      port_name="$(printf "%s" "\${port_name}" | tr -d '\\r\\n')"
      if [ -n "\${port_name}" ]; then
        ln -sf "../\${port_device}" "/dev/virtio-ports/\${port_name}" 2>/dev/null || true
      fi
    fi
  done
}

resolve_virtio_port_path() {
  expected="$1"

  if [ -c "/dev/virtio-ports/\${expected}" ]; then
    printf "%s\n" "/dev/virtio-ports/\${expected}"
    return
  fi

  for port_path in /sys/class/virtio-ports/vport*; do
    if [ ! -e "\${port_path}" ] || [ ! -r "\${port_path}/name" ]; then
      continue
    fi

    port_name="$(cat "\${port_path}/name" 2>/dev/null || true)"
    port_name="$(printf "%s" "\${port_name}" | tr -d '\\r\\n')"
    if [ "\${port_name}" = "\${expected}" ]; then
      port_device="$(basename "\${port_path}")"
      printf "%s\n" "/dev/\${port_device}"
      return
    fi
  done

  printf "%s\n" "/dev/virtio-ports/\${expected}"
}

setup_mitm_ca() {
  system_ca_bundle=""
  for candidate in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt; do
    if [ -r "\${candidate}" ]; then
      system_ca_bundle="\${candidate}"
      break
    fi
  done

  mitm_ca_cert="/etc/gondolin/mitm/ca.crt"
  if [ ! -r "\${mitm_ca_cert}" ]; then
    if [ -n "\${system_ca_bundle}" ]; then
      export SSL_CERT_FILE="\${system_ca_bundle}"
    fi
    return
  fi

  mitm_ca_install="/usr/local/share/ca-certificates/gondolin-mitm-ca.crt"
  if mkdir -p /usr/local/share/ca-certificates 2>/dev/null; then
    if cp "\${mitm_ca_cert}" "\${mitm_ca_install}" 2>/dev/null; then
      if command -v update-ca-certificates > /dev/null 2>&1; then
        if update-ca-certificates > /dev/null 2>&1; then
          if [ -r /etc/ssl/certs/ca-certificates.crt ]; then
            system_ca_bundle="/etc/ssl/certs/ca-certificates.crt"
          fi
        else
          log "[init] update-ca-certificates failed"
        fi
      fi
    fi
  fi

  runtime_ca_bundle="/run/gondolin/ca-certificates.crt"
  mkdir -p /run/gondolin
  : > "\${runtime_ca_bundle}"

  if [ -n "\${system_ca_bundle}" ] && [ -r "\${system_ca_bundle}" ]; then
    cat "\${system_ca_bundle}" >> "\${runtime_ca_bundle}" 2>/dev/null || true
  fi

  printf "\\n" >> "\${runtime_ca_bundle}"
  cat "\${mitm_ca_cert}" >> "\${runtime_ca_bundle}" 2>/dev/null || true

  export SSL_CERT_FILE="\${runtime_ca_bundle}"
  export CURL_CA_BUNDLE="\${runtime_ca_bundle}"
  export REQUESTS_CA_BUNDLE="\${runtime_ca_bundle}"
  export NODE_EXTRA_CA_CERTS="\${mitm_ca_cert}"
}

mount -t proc proc /proc || log "[init] mount proc failed"
mount -t sysfs sysfs /sys || log "[init] mount sysfs failed"
mount -t devtmpfs devtmpfs /dev || log "[init] mount devtmpfs failed"

mkdir -p /dev/pts /dev/shm /run
mount -t devpts devpts /dev/pts || log "[init] mount devpts failed"
mount -t tmpfs tmpfs /run || log "[init] mount tmpfs failed"

export PATH=/usr/sbin:/usr/bin:/sbin:/bin

mkdir -p /tmp /var/tmp /var/cache /var/log /root /home
mount -t tmpfs tmpfs /tmp || log "[init] mount tmpfs /tmp failed"
mount -t tmpfs tmpfs /root || log "[init] mount tmpfs /root failed"
chmod 700 /root || true
mount -t tmpfs tmpfs /var/tmp || log "[init] mount tmpfs /var/tmp failed"
mount -t tmpfs tmpfs /var/cache || log "[init] mount tmpfs /var/cache failed"
mount -t tmpfs tmpfs /var/log || log "[init] mount tmpfs /var/log failed"

mkdir -p /tmp/.cache /tmp/.config /tmp/.local/share

export HOME=/root
export TMPDIR=/tmp
export XDG_CACHE_HOME=/tmp/.cache
export XDG_CONFIG_HOME=/tmp/.config
export XDG_DATA_HOME=/tmp/.local/share
export UV_CACHE_DIR=/tmp/.cache/uv
export UV_NATIVE_TLS=true

log "[init] /dev entries:"
log_cmd ls -l /dev
if [ -d /dev/virtio-ports ]; then
  log "[init] /dev/virtio-ports:"
  log_cmd ls -l /dev/virtio-ports
else
  log "[init] /dev/virtio-ports missing"
fi
if [ -d /sys/class/virtio-ports ]; then
  log "[init] /sys/class/virtio-ports:"
  log_cmd ls -l /sys/class/virtio-ports
else
  log "[init] /sys/class/virtio-ports missing"
fi

if modprobe virtio_console > /dev/null 2>&1; then
  log "[init] loaded virtio_console"
fi
setup_virtio_ports
if modprobe virtio_rng > /dev/null 2>&1; then
  log "[init] loaded virtio_rng"
fi
if [ -e /dev/hwrng ]; then
  log "[init] starting rngd"
  rngd -r /dev/hwrng -o /dev/random > /dev/null 2>&1 &
else
  log "[init] /dev/hwrng missing"
fi

if modprobe virtio_net > /dev/null 2>&1; then
  log "[init] loaded virtio_net"
fi

if command -v ip > /dev/null 2>&1; then
  ip link set lo up || true
  ip link set eth0 up || true
elif command -v ifconfig > /dev/null 2>&1; then
  ifconfig lo up || true
  ifconfig eth0 up || true
else
  log "[init] no network link tool (ip/ifconfig)"
fi

if command -v udhcpc > /dev/null 2>&1; then
  UDHCPC_SCRIPT="/usr/share/udhcpc/default.script"
  if [ ! -x "\${UDHCPC_SCRIPT}" ]; then
    UDHCPC_SCRIPT="/sbin/udhcpc.script"
  fi
  if [ -x "\${UDHCPC_SCRIPT}" ]; then
    udhcpc -i eth0 -q -n -s "\${UDHCPC_SCRIPT}" || log "[init] udhcpc failed"
  else
    udhcpc -i eth0 -q -n || log "[init] udhcpc failed"
  fi
fi

if modprobe fuse > /dev/null 2>&1; then
  log "[init] loaded fuse"
fi

sandboxfs_mount="/data"
sandboxfs_binds=""

if [ -r /proc/cmdline ]; then
  for arg in \$(cat /proc/cmdline); do
    case "\${arg}" in
      sandboxfs.mount=*)
        sandboxfs_mount="\${arg#sandboxfs.mount=}"
        ;;
      sandboxfs.bind=*)
        sandboxfs_binds="\${arg#sandboxfs.bind=}"
        ;;
    esac
  done
fi

wait_for_sandboxfs() {
  for i in \$(seq 1 300); do
    if grep -q " \${sandboxfs_mount} fuse.sandboxfs " /proc/mounts; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

mkdir -p "\${sandboxfs_mount}"

sandboxfs_ready=0
sandboxfs_error="sandboxfs mount not ready"

setup_virtio_ports

if [ -x /usr/bin/sandboxfs ]; then
  log "[init] starting sandboxfs at \${sandboxfs_mount}"
  SANDBOXFS_LOG="\${CONSOLE:-/dev/null}"
  if [ -z "\${SANDBOXFS_LOG}" ]; then
    SANDBOXFS_LOG="/dev/null"
  fi
  sandboxfs_rpc_path="$(resolve_virtio_port_path virtio-fs)"
  log "[init] sandboxfs rpc path \${sandboxfs_rpc_path}"
  /usr/bin/sandboxfs --mount "\${sandboxfs_mount}" --rpc-path "\${sandboxfs_rpc_path}" > "\${SANDBOXFS_LOG}" 2>&1 &

  if wait_for_sandboxfs; then
    sandboxfs_ready=1
    if [ -n "\${sandboxfs_binds}" ]; then
      OLD_IFS="\${IFS}"
      IFS=","
      for bind in \${sandboxfs_binds}; do
        if [ -z "\${bind}" ]; then
          continue
        fi
        mkdir -p "\${bind}"
        if [ "\${sandboxfs_mount}" = "/" ]; then
          bind_source="\${bind}"
        else
          bind_source="\${sandboxfs_mount}\${bind}"
        fi
        log "[init] binding sandboxfs \${bind_source} -> \${bind}"
        log_cmd mount --bind "\${bind_source}" "\${bind}"
      done
      IFS="\${OLD_IFS}"
    fi
  else
    log "[init] sandboxfs mount not ready"
  fi
else
  log "[init] /usr/bin/sandboxfs missing"
  sandboxfs_error="sandboxfs binary missing"
fi

if [ "\${sandboxfs_ready}" -eq 1 ]; then
  printf "ok\\n" > /run/sandboxfs.ready
else
  printf "%s\\n" "\${sandboxfs_error}" > /run/sandboxfs.failed
fi

setup_mitm_ca

if [ -x /usr/bin/sandboxssh ]; then
  log "[init] starting sandboxssh"
  /usr/bin/sandboxssh > "\${CONSOLE:-/dev/null}" 2>&1 &
else
  log "[init] /usr/bin/sandboxssh missing"
fi

if [ -x /usr/bin/sandboxingress ]; then
  log "[init] starting sandboxingress"
  /usr/bin/sandboxingress > "\${CONSOLE:-/dev/null}" 2>&1 &
else
  log "[init] /usr/bin/sandboxingress missing"
fi

log "[init] starting sandboxd"

exec /usr/bin/sandboxd
`;

export const INITRAMFS_INIT_SCRIPT = `#!/bin/sh
set -eu

CONSOLE="/dev/console"
if [ ! -c "\${CONSOLE}" ]; then
  if [ -c /dev/ttyAMA0 ]; then
    CONSOLE="/dev/ttyAMA0"
  elif [ -c /dev/ttyS0 ]; then
    CONSOLE="/dev/ttyS0"
  else
    CONSOLE=""
  fi
fi

log() {
  if [ -n "\${CONSOLE}" ]; then
    printf "%s\\n" "$*" > "\${CONSOLE}" 2>/dev/null || printf "%s\\n" "$*"
  else
    printf "%s\\n" "$*"
  fi
}

setup_virtio_ports() {
  mkdir -p /dev/virtio-ports

  for port_path in /sys/class/virtio-ports/vport*; do
    if [ ! -e "\${port_path}" ]; then
      continue
    fi

    port_device="$(basename "\${port_path}")"
    dev_node="/dev/\${port_device}"

    if [ ! -c "\${dev_node}" ]; then
      dev_nums="$(cat "\${port_path}/dev" 2>/dev/null || true)"
      major="\${dev_nums%%:*}"
      minor="\${dev_nums##*:}"
      if [ -n "\${major}" ] && [ -n "\${minor}" ]; then
        mknod "\${dev_node}" c "\${major}" "\${minor}" 2>/dev/null || true
        chmod 600 "\${dev_node}" 2>/dev/null || true
      fi
    fi

    if [ -r "\${port_path}/name" ]; then
      port_name="$(cat "\${port_path}/name" 2>/dev/null || true)"
      port_name="$(printf "%s" "\${port_name}" | tr -d '\\r\\n')"
      if [ -n "\${port_name}" ]; then
        ln -sf "../\${port_device}" "/dev/virtio-ports/\${port_name}" 2>/dev/null || true
      fi
    fi
  done
}

wait_for_virtio_ports() {
  for i in $(seq 1 300); do
    setup_virtio_ports
    if [ -c /dev/virtio-ports/virtio-port ] && [ -c /dev/virtio-ports/virtio-fs ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

mount -t proc proc /proc || log "[initramfs] mount proc failed"
mount -t sysfs sysfs /sys || log "[initramfs] mount sysfs failed"
mount -t devtmpfs devtmpfs /dev || log "[initramfs] mount devtmpfs failed"

mkdir -p /dev/pts /dev/shm /run
mount -t devpts devpts /dev/pts || log "[initramfs] mount devpts failed"
mount -t tmpfs tmpfs /run || log "[initramfs] mount tmpfs failed"

export PATH=/usr/sbin:/usr/bin:/sbin:/bin

root_device="/dev/vda"
root_fstype="ext4"

if [ -r /proc/cmdline ]; then
  for arg in \$(cat /proc/cmdline); do
    case "\${arg}" in
      root=*)
        root_device="\${arg#root=}"
        ;;
      rootfstype=*)
        root_fstype="\${arg#rootfstype=}"
        ;;
    esac
  done
fi

modprobe virtio_blk > /dev/null 2>&1 || true
modprobe ext4 > /dev/null 2>&1 || true
modprobe virtio_console > /dev/null 2>&1 || true
modprobe virtio_rng > /dev/null 2>&1 || true
modprobe virtio_net > /dev/null 2>&1 || true
modprobe fuse > /dev/null 2>&1 || true

if ! wait_for_virtio_ports; then
  log "[initramfs] virtio ports not ready"
fi

if command -v ip > /dev/null 2>&1; then
  ip link set lo up || true
  ip link set eth0 up || true
elif command -v ifconfig > /dev/null 2>&1; then
  ifconfig lo up || true
  ifconfig eth0 up || true
fi

if command -v udhcpc > /dev/null 2>&1; then
  UDHCPC_SCRIPT="/usr/share/udhcpc/default.script"
  if [ ! -x "\${UDHCPC_SCRIPT}" ]; then
    UDHCPC_SCRIPT="/sbin/udhcpc.script"
  fi
  if [ -x "\${UDHCPC_SCRIPT}" ]; then
    udhcpc -i eth0 -q -n -s "\${UDHCPC_SCRIPT}" || log "[initramfs] udhcpc failed"
  else
    udhcpc -i eth0 -q -n || log "[initramfs] udhcpc failed"
  fi
fi

wait_for_block() {
  dev="$1"
  for i in \$(seq 1 50); do
    if [ -b "\${dev}" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

if ! wait_for_block "\${root_device}"; then
  log "[initramfs] root device \${root_device} not found"
  exec sh
fi

mkdir -p /newroot
if ! mount -t "\${root_fstype}" "\${root_device}" /newroot; then
  log "[initramfs] failed to mount \${root_device}"
  exec sh
fi

mkdir -p /newroot/proc /newroot/sys /newroot/dev /newroot/run

if [ -s /etc/resolv.conf ]; then
  mkdir -p /newroot/etc
  cp /etc/resolv.conf /newroot/etc/resolv.conf 2>/dev/null || true
fi

exec switch_root /newroot /init
`;
