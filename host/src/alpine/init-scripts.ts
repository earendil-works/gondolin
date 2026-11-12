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

# set from /proc/cmdline: \`quiet\` drops the log, which otherwise goes to the
# serial console (each byte traps to the VMM; the device listings alone cost
# ~50 ms per boot on a slow emulated serial console)
gondolin_quiet=0

log() {
  if [ "\${gondolin_quiet}" = 1 ]; then
    return 0
  fi
  if [ -n "\${CONSOLE}" ]; then
    printf "%s\\n" "$*" > "\${CONSOLE}" 2>/dev/null || printf "%s\\n" "$*"
  else
    printf "%s\\n" "$*"
  fi
}

# runs a command, its output going where log() writes
log_cmd() {
  if [ "\${gondolin_quiet}" = 1 ]; then
    "$@" > /dev/null 2>&1 || true
    return 0
  fi
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
case " $(cat /proc/cmdline 2>/dev/null || true) " in
  *" quiet "*) gondolin_quiet=1 ;;
esac
mount -t sysfs sysfs /sys || log "[init] mount sysfs failed"
mount -t devtmpfs devtmpfs /dev || log "[init] mount devtmpfs failed"

mkdir -p /dev/pts /dev/shm /run
mount -t devpts devpts /dev/pts || log "[init] mount devpts failed"
mount -t tmpfs tmpfs /run || log "[init] mount tmpfs failed"

# Standard /dev symlinks (needed for bash process substitution, /dev/stdin, ...)
for dev_link in fd:/proc/self/fd stdin:/proc/self/fd/0 stdout:/proc/self/fd/1 stderr:/proc/self/fd/2; do
  dev_name="/dev/\${dev_link%%:*}"
  if [ ! -e "\${dev_name}" ] && [ ! -L "\${dev_name}" ]; then
    ln -s "\${dev_link#*:}" "\${dev_name}" 2>/dev/null || log "[init] symlink \${dev_name} failed"
  fi
done

export PATH=/usr/sbin:/usr/bin:/sbin:/bin

sandboxfs_mount="/data"
sandboxfs_binds=""
# virtio-fs tag offered by the host (empty: sandboxfs over virtio-serial)
sandboxfs_virtiofs=""
# scratch tmpfs mounts: "/path[:opt=value...][,/path...]" or "none"
gondolin_tmpfs="/root:mode=0700,/tmp,/var/cache,/var/log,/var/tmp"
# static network configuration from the host, instead of DHCP:
# "ADDRESS/PREFIX,GATEWAY,DNS[+DNS...]" (gondolin.net)
gondolin_net=""
# host channels over vsock instead of virtio-serial (gondolin.vsock)
gondolin_vsock=0

if [ -r /proc/cmdline ]; then
  for arg in $(cat /proc/cmdline); do
    case "\${arg}" in
      sandboxfs.mount=*)
        sandboxfs_mount="\${arg#sandboxfs.mount=}"
        ;;
      sandboxfs.bind=*)
        sandboxfs_binds="\${arg#sandboxfs.bind=}"
        ;;
      sandboxfs.virtiofs=*)
        sandboxfs_virtiofs="\${arg#sandboxfs.virtiofs=}"
        ;;
      gondolin.tmpfs=*)
        gondolin_tmpfs="\${arg#gondolin.tmpfs=}"
        ;;
      gondolin.net=*)
        gondolin_net="\${arg#gondolin.net=}"
        ;;
      gondolin.vsock)
        gondolin_vsock=1
        ;;
      gondolin.vsock=*)
        case "$(printf "%s" "\${arg#gondolin.vsock=}" | tr "A-Z" "a-z")" in
          0|off|false|no) gondolin_vsock=0 ;;
          *) gondolin_vsock=1 ;;
        esac
        ;;
    esac
  done
fi

mount_tmpfs_entry() {
  tmpfs_path="\${1%%:*}"
  tmpfs_opts=""
  if [ "\${tmpfs_path}" != "$1" ]; then
    tmpfs_opts="$(printf "%s" "\${1#*:}" | tr ':' ',')"
  fi
  case "\${tmpfs_path}" in
    /?*) ;;
    *)
      log "[init] ignoring invalid tmpfs entry $1"
      return 0
      ;;
  esac
  mkdir -p "\${tmpfs_path}" 2>/dev/null || true
  if [ -n "\${tmpfs_opts}" ]; then
    mount -t tmpfs -o "\${tmpfs_opts}" tmpfs "\${tmpfs_path}" || log "[init] mount tmpfs \${tmpfs_path} failed"
  else
    mount -t tmpfs tmpfs "\${tmpfs_path}" || log "[init] mount tmpfs \${tmpfs_path} failed"
  fi
}

mkdir -p /tmp /home 2>/dev/null || true
if [ "\${gondolin_tmpfs}" != "none" ]; then
  for tmpfs_entry in $(printf "%s" "\${gondolin_tmpfs}" | tr ',' ' '); do
    mount_tmpfs_entry "\${tmpfs_entry}"
  done
fi

export HOME=/root
export TMPDIR=/tmp
export UV_SYSTEM_CERTS=true

# rootfs.mode "readonly": nothing can be created on the root filesystem, so
# mount points must come with the image and the resolver configuration lives
# on /run (images built by gondolin link /etc/resolv.conf there)
root_ro=0
if ! touch /.gondolin-rw-check 2> /dev/null; then
  root_ro=1
  log "[init] root filesystem is read-only"
else
  rm -f /.gondolin-rw-check
fi
if [ "\${root_ro}" = 1 ] && [ -f /etc/resolv.conf ] && [ ! -L /etc/resolv.conf ]; then
  : > /run/resolv.conf
  mount --bind /run/resolv.conf /etc/resolv.conf || log "[init] cannot redirect /etc/resolv.conf to /run"
fi

# message for a mount point that cannot be created
mount_point_error() {
  if [ "\${root_ro}" = 1 ]; then
    printf "cannot create the mount point %s: the root filesystem is read-only (rootfs mode readonly); add the directory to the image or mount below a writable path such as /tmp" "$1"
  else
    printf "cannot create the mount point %s" "$1"
  fi
}

# device listings for debugging boot problems (nobody reads them when quiet)
if [ "\${gondolin_quiet}" != 1 ]; then
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
fi

if modprobe virtio_console > /dev/null 2>&1; then
  log "[init] loaded virtio_console"
fi
setup_virtio_ports
if [ "\${gondolin_vsock}" = 1 ]; then
  # the helpers connect to the host over vsock (see guest/ARCHITECTURE.md)
  if modprobe vmw_vsock_virtio_transport > /dev/null 2>&1; then
    log "[init] loaded vmw_vsock_virtio_transport"
  fi
fi
if modprobe virtio_rng > /dev/null 2>&1; then
  log "[init] loaded virtio_rng"
fi
# No rngd: the kernel's hwrng thread feeds virtio-rng output into the input
# pool by itself, and the crng is seeded at boot (rngd kept two vCPUs busy for
# ~11 s after every boot).
if [ ! -e /dev/hwrng ]; then
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

# The host's settings when it sends them (what its DHCP server would hand
# out; DHCP costs ~40 ms of udhcpc per boot), else DHCP.
net_configured=0
case "\${gondolin_net}" in
  */*,*,*)
    if command -v ip > /dev/null 2>&1; then
      net_address="\${gondolin_net%%,*}"
      net_rest="\${gondolin_net#*,}"
      net_gateway="\${net_rest%%,*}"
      net_dns="\${net_rest#*,}"
      if ip addr add "\${net_address}" brd + dev eth0 \
        && ip route add default via "\${net_gateway}" dev eth0; then
        for net_server in $(printf "%s" "\${net_dns}" | tr '+' ' '); do
          printf "nameserver %s\\n" "\${net_server}"
        done > /etc/resolv.conf
        net_configured=1
      else
        log "[init] static network configuration failed, trying DHCP"
        ip addr flush dev eth0 > /dev/null 2>&1 || true
      fi
    fi
    ;;
esac

if [ "\${net_configured}" != 1 ] && command -v udhcpc > /dev/null 2>&1; then
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

wait_for_sandboxfs() {
  # every 10 ms (30 s in total): the mount lands a few ms after sandboxfs
  # connects, and every boot waits for it
  for i in $(seq 1 3000); do
    if grep -q " \${sandboxfs_mount} fuse.sandboxfs " /proc/mounts; then
      return 0
    fi
    if grep -q " \${sandboxfs_mount} virtiofs " /proc/mounts; then
      return 0
    fi
    sleep 0.01
  done
  return 1
}

sandboxfs_ready=0
sandboxfs_error="sandboxfs mount not ready"
sandboxfs_mountpoint=1
if ! mkdir -p "\${sandboxfs_mount}" 2> /dev/null; then
  sandboxfs_mountpoint=0
  sandboxfs_error="$(mount_point_error "\${sandboxfs_mount}")"
  log "[init] \${sandboxfs_error}"
fi

setup_virtio_ports

if [ "\${sandboxfs_mountpoint}" = 0 ]; then
  :
elif [ -x /usr/bin/sandboxfs ]; then
  log "[init] starting sandboxfs at \${sandboxfs_mount}"
  SANDBOXFS_LOG="\${CONSOLE:-/dev/null}"
  if [ -z "\${SANDBOXFS_LOG}" ]; then
    SANDBOXFS_LOG="/dev/null"
  fi
  sandboxfs_rpc_path="$(resolve_virtio_port_path virtio-fs)"
  log "[init] sandboxfs rpc path \${sandboxfs_rpc_path}"
  sandboxfs_binds_file="/run/sandboxfs.binds"
  rm -f "\${sandboxfs_binds_file}"
  sandboxfs_extra=""
  if [ -n "\${sandboxfs_virtiofs}" ]; then
    # sandboxfs fetches the bind list, mounts the virtio-fs tag and exits
    # (falling back to FUSE over virtio-serial if the mount fails)
    if modprobe virtiofs > /dev/null 2>&1; then
      log "[init] loaded virtiofs"
    fi
    sandboxfs_extra="--virtiofs \${sandboxfs_virtiofs}"
  fi
  /usr/bin/sandboxfs --mount "\${sandboxfs_mount}" --rpc-path "\${sandboxfs_rpc_path}" --binds-file "\${sandboxfs_binds_file}" \${sandboxfs_extra} > "\${SANDBOXFS_LOG}" 2>&1 &

  if wait_for_sandboxfs; then
    sandboxfs_ready=1
    # sandboxfs writes the bind list (fetched from the host) before mounting.
    # Older hosts only provide it via the kernel cmdline, which is limited in
    # size, so only fall back to that if the file is missing.
    if [ ! -f "\${sandboxfs_binds_file}" ] && [ -n "\${sandboxfs_binds}" ]; then
      printf "%s\\n" "\${sandboxfs_binds}" | tr ',' '\\n' > "\${sandboxfs_binds_file}"
    fi
    if [ -f "\${sandboxfs_binds_file}" ]; then
      while IFS= read -r bind; do
        if [ -z "\${bind}" ]; then
          continue
        fi
        if ! mkdir -p "\${bind}" 2> /dev/null; then
          # reported to the host instead of stopping init
          sandboxfs_ready=0
          sandboxfs_error="$(mount_point_error "\${bind}")"
          log "[init] \${sandboxfs_error}"
          continue
        fi
        if [ "\${sandboxfs_mount}" = "/" ]; then
          bind_source="\${bind}"
        else
          bind_source="\${sandboxfs_mount}\${bind}"
        fi
        # the host binds it itself when it gets there first
        if awk -v p="\${bind}" '$2 == p { found = 1 } END { exit !found }' /proc/mounts; then
          continue
        fi
        log "[init] binding sandboxfs \${bind_source} -> \${bind}"
        log_cmd mount --bind "\${bind_source}" "\${bind}"
      done < "\${sandboxfs_binds_file}"
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

# set from /proc/cmdline: \`quiet\` drops the log, which otherwise goes to the
# serial console (each byte traps to the VMM; the device listings alone cost
# ~50 ms per boot on a slow emulated serial console)
gondolin_quiet=0

log() {
  if [ "\${gondolin_quiet}" = 1 ]; then
    return 0
  fi
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
  # every 10 ms, 30 s in total
  for i in $(seq 1 3000); do
    setup_virtio_ports
    if [ -c /dev/virtio-ports/virtio-port ] && [ -c /dev/virtio-ports/virtio-fs ]; then
      return 0
    fi
    sleep 0.01
  done
  return 1
}

mount -t proc proc /proc || log "[initramfs] mount proc failed"
case " $(cat /proc/cmdline 2>/dev/null || true) " in
  *" quiet "*) gondolin_quiet=1 ;;
esac
mount -t sysfs sysfs /sys || log "[initramfs] mount sysfs failed"
mount -t devtmpfs devtmpfs /dev || log "[initramfs] mount devtmpfs failed"

mkdir -p /dev/pts /dev/shm /run
mount -t devpts devpts /dev/pts || log "[initramfs] mount devpts failed"
mount -t tmpfs tmpfs /run || log "[initramfs] mount tmpfs failed"

export PATH=/usr/sbin:/usr/bin:/sbin:/bin

root_device="/dev/vda"
root_fstype="ext4"
gondolin_vsock=0
# the root disk is a read-only base whose writes go to a tmpfs overlay
# (gondolin.overlay; the host attaches the disk read-only and nothing is copied)
gondolin_overlay=0

if [ -r /proc/cmdline ]; then
  for arg in $(cat /proc/cmdline); do
    case "\${arg}" in
      root=*)
        root_device="\${arg#root=}"
        ;;
      rootfstype=*)
        root_fstype="\${arg#rootfstype=}"
        ;;
      gondolin.overlay)
        gondolin_overlay=1
        ;;
      gondolin.vsock)
        gondolin_vsock=1
        ;;
      gondolin.vsock=*)
        case "$(printf "%s" "\${arg#gondolin.vsock=}" | tr "A-Z" "a-z")" in
          0|off|false|no) gondolin_vsock=0 ;;
          *) gondolin_vsock=1 ;;
        esac
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

if [ "\${gondolin_vsock}" = 1 ]; then
  # host channels use vsock; there are no virtio-serial ports to wait for
  :
elif ! wait_for_virtio_ports; then
  log "[initramfs] virtio ports not ready"
fi

# no network here: the root filesystem's init brings it up (DHCP twice cost
# ~30 ms per boot)

wait_for_block() {
  dev="$1"
  # every 10 ms, 5 s in total
  for i in $(seq 1 500); do
    if [ -b "\${dev}" ]; then
      return 0
    fi
    sleep 0.01
  done
  return 1
}

if ! wait_for_block "\${root_device}"; then
  log "[initramfs] root device \${root_device} not found"
  exec sh
fi

# overlay root: the read-only disk under a tmpfs that takes the writes (and
# goes with the VM)
mount_overlay_root() {
  modprobe overlay > /dev/null 2>&1 || true
  mkdir -p /lower /overlay
  mount -t "\${root_fstype}" -o ro "\${root_device}" /lower || return 1
  if mount -t tmpfs -o mode=0755 tmpfs /overlay \
    && mkdir -p /overlay/upper /overlay/work \
    && mount -t overlay overlay \
      -o lowerdir=/lower,upperdir=/overlay/upper,workdir=/overlay/work /newroot; then
    return 0
  fi
  umount /overlay > /dev/null 2>&1 || true
  umount /lower > /dev/null 2>&1 || true
  return 1
}

mkdir -p /newroot
if [ "\${gondolin_overlay}" = 1 ] && mount_overlay_root; then
  :
else
  if [ "\${gondolin_overlay}" = 1 ]; then
    log "[initramfs] overlay root failed, mounting \${root_device} directly"
  fi
  if ! mount -t "\${root_fstype}" "\${root_device}" /newroot; then
    log "[initramfs] failed to mount \${root_device}"
    exec sh
  fi
fi

mkdir -p /newroot/proc /newroot/sys /newroot/dev /newroot/run

exec switch_root /newroot /init
`;
