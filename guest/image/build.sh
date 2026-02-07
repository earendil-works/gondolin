#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd)
GUEST_DIR="${REPO_ROOT}/guest"
IMAGE_DIR="${GUEST_DIR}/image"

ALPINE_VERSION=${ALPINE_VERSION:-3.23.0}
ALPINE_BRANCH=${ALPINE_BRANCH:-"v${ALPINE_VERSION%.*}"}
ARCH=${ARCH:-$(uname -m)}
if [[ "${ARCH}" == "x86_64" && "$(uname -s)" == "Darwin" ]]; then
    if sysctl -n hw.optional.arm64 >/dev/null 2>&1; then
        if [[ "$(sysctl -n hw.optional.arm64)" == "1" ]]; then
            ARCH="aarch64"
        fi
    fi
fi
if [[ "${ARCH}" == "arm64" ]]; then
    ARCH="aarch64"
fi

OUT_DIR=${OUT_DIR:-"${IMAGE_DIR}/out"}
ROOTFS_DIR="${OUT_DIR}/rootfs"
INITRAMFS_DIR="${OUT_DIR}/initramfs-root"
ROOTFS_IMAGE="${OUT_DIR}/rootfs.ext4"
INITRAMFS="${OUT_DIR}/initramfs.cpio.lz4"
CACHE_DIR="${IMAGE_DIR}/.cache"

ROOTFS_INIT=${ROOTFS_INIT:-"${IMAGE_DIR}/init"}
INITRAMFS_INIT=${INITRAMFS_INIT:-"${IMAGE_DIR}/initramfs-init"}
ROOTFS_LABEL=${ROOTFS_LABEL:-"gondolin-root"}

SANDBOXD_BIN=${SANDBOXD_BIN:-"${GUEST_DIR}/zig-out/bin/sandboxd"}
SANDBOXFS_BIN=${SANDBOXFS_BIN:-"${GUEST_DIR}/zig-out/bin/sandboxfs"}
SANDBOXSSH_BIN=${SANDBOXSSH_BIN:-"${GUEST_DIR}/zig-out/bin/sandboxssh"}

ALPINE_TARBALL="alpine-minirootfs-${ALPINE_VERSION}-${ARCH}.tar.gz"
ALPINE_URL=${ALPINE_URL:-"https://dl-cdn.alpinelinux.org/alpine/${ALPINE_BRANCH}/releases/${ARCH}/${ALPINE_TARBALL}"}
ROOTFS_PACKAGES=${ROOTFS_PACKAGES:-${EXTRA_PACKAGES:-linux-virt rng-tools bash ca-certificates curl nodejs npm uv python3 openssh}}
INITRAMFS_PACKAGES=${INITRAMFS_PACKAGES:-}

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "missing required command: $1" >&2
        exit 1
    fi
}

require_cmd tar
require_cmd cpio
require_cmd gzip
require_cmd lz4
require_cmd curl
require_cmd python3

if command -v mke2fs >/dev/null 2>&1; then
    MKFS_EXT4="mke2fs"
elif command -v mkfs.ext4 >/dev/null 2>&1; then
    MKFS_EXT4="mkfs.ext4"
elif [[ "$(uname -s)" == "Darwin" ]]; then
    for candidate in \
        /opt/homebrew/opt/e2fsprogs/sbin/mke2fs \
        /opt/homebrew/opt/e2fsprogs/bin/mke2fs \
        /opt/homebrew/opt/e2fsprogs/sbin/mkfs.ext4 \
        /opt/homebrew/opt/e2fsprogs/bin/mkfs.ext4 \
        /usr/local/opt/e2fsprogs/sbin/mke2fs \
        /usr/local/opt/e2fsprogs/bin/mke2fs \
        /usr/local/opt/e2fsprogs/sbin/mkfs.ext4 \
        /usr/local/opt/e2fsprogs/bin/mkfs.ext4; do
        if [[ -x "${candidate}" ]]; then
            MKFS_EXT4="${candidate}"
            break
        fi
    done
fi

if [[ -z "${MKFS_EXT4:-}" ]]; then
    echo "missing required command: mke2fs (install e2fsprogs)" >&2
    echo "On macOS: brew install e2fsprogs" >&2
    echo "Then ensure mke2fs is on your PATH (Homebrew: brew --prefix e2fsprogs)" >&2
    exit 1
fi

mkdir -p "${CACHE_DIR}" "${OUT_DIR}"

if [[ ! -f "${SANDBOXD_BIN}" || ! -f "${SANDBOXFS_BIN}" || ! -f "${SANDBOXSSH_BIN}" ]]; then
    echo "guest binaries not found, building..." >&2
    (cd "${GUEST_DIR}" && ${ZIG:-zig} build -Doptimize=ReleaseSmall)
fi

if [[ ! -f "${CACHE_DIR}/${ALPINE_TARBALL}" ]]; then
    echo "downloading ${ALPINE_URL}" >&2
    curl -L "${ALPINE_URL}" -o "${CACHE_DIR}/${ALPINE_TARBALL}"
fi

install_packages() {
    local target_dir="$1"
    local packages="$2"
    if [[ -z "${packages}" ]]; then
        return 0
    fi

    ROOTFS_DIR="${target_dir}" CACHE_DIR="${CACHE_DIR}" ARCH="${ARCH}" EXTRA_PACKAGES="${packages}" python3 - <<'PY'
import os
import re
import sys
import tarfile
import subprocess
import shutil

rootfs_dir = os.environ["ROOTFS_DIR"]
cache_dir = os.environ["CACHE_DIR"]
arch = os.environ["ARCH"]
packages = [p for p in os.environ.get("EXTRA_PACKAGES", "").split() if p]

if not packages:
    sys.exit(0)

repos_file = os.path.join(rootfs_dir, "etc", "apk", "repositories")
with open(repos_file, "r", encoding="utf-8") as handle:
    repos = [line.strip() for line in handle if line.strip() and not line.startswith("#")]

pkg_meta = {}
pkg_repo = {}
provides = {}

def download(url: str, path: str) -> None:
    subprocess.check_call(["curl", "-L", "-o", path, url])


def safe_name(repo: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", repo)

def parse_index(index_path: str, repo: str) -> None:
    current = {}
    def commit(entry):
        name = entry.get("P")
        if not name or name in pkg_meta:
            return
        pkg_meta[name] = entry
        pkg_repo[name] = repo
        for token in entry.get("p", "").split():
            provide = token.split("=", 1)[0]
            provides.setdefault(provide, name)

    with open(index_path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.rstrip("\n")
            if not line:
                if current:
                    commit(current)
                    current = {}
                continue
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            current[key] = value
        if current:
            commit(current)

for repo in repos:
    safe = safe_name(repo)
    index_path = os.path.join(cache_dir, f"APKINDEX-{safe}-{arch}")
    if not os.path.exists(index_path):
        tar_path = index_path + ".tar.gz"
        url = f"{repo}/{arch}/APKINDEX.tar.gz"
        download(url, tar_path)
        with tarfile.open(tar_path, "r:gz") as tar:
            tar.extract("APKINDEX", cache_dir, filter="fully_trusted")
        os.replace(os.path.join(cache_dir, "APKINDEX"), index_path)
    parse_index(index_path, repo)


def normalize_dep(dep: str) -> str:
    dep = dep.lstrip("!")
    dep = re.split(r"[<>=~]", dep, maxsplit=1)[0]
    return dep


def resolve_pkg(dep: str):
    if dep in pkg_meta:
        return dep
    return provides.get(dep)


def has_symlink_component(path: str, root: str) -> bool:
    root = os.path.abspath(root)
    path = os.path.abspath(path)
    if path == root:
        return False
    if not path.startswith(root + os.sep):
        return True
    rel = os.path.relpath(path, root)
    if rel == ".":
        return False
    current = root
    for part in rel.split(os.sep):
        current = os.path.join(current, part)
        if os.path.islink(current):
            return True
    return False


needed = []
seen = set()
queue = list(packages)

while queue:
    dep = normalize_dep(queue.pop(0))
    if not dep:
        continue
    pkg_name = resolve_pkg(dep)
    if not pkg_name:
        print(f"warning: unable to resolve {dep}", file=sys.stderr)
        continue
    if pkg_name in seen:
        continue
    seen.add(pkg_name)
    needed.append(pkg_name)
    deps = pkg_meta[pkg_name].get("D", "")
    for token in deps.split():
        queue.append(token)

for pkg_name in needed:
    meta = pkg_meta[pkg_name]
    repo = pkg_repo[pkg_name]
    version = meta["V"]
    apk_name = f"{pkg_name}-{version}.apk"
    apk_path = os.path.join(cache_dir, f"{arch}-{apk_name}")
    if not os.path.exists(apk_path):
        url = f"{repo}/{arch}/{apk_name}"
        download(url, apk_path)
    with tarfile.open(apk_path, "r:gz") as tar:
        members = tar.getmembers()
        safe_members = []
        for member in members:
            target = os.path.join(rootfs_dir, member.name)
            if has_symlink_component(target, rootfs_dir):
                print(f"skipping symlinked path {member.name}", file=sys.stderr)
                continue
            if os.path.exists(target) or os.path.islink(target):
                try:
                    if os.path.isdir(target) and not member.isdir():
                        shutil.rmtree(target)
                    elif os.path.isdir(target) and member.isdir():
                        safe_members.append(member)
                        continue
                    else:
                        os.remove(target)
                except PermissionError:
                    try:
                        os.chmod(target, 0o700)
                    except OSError:
                        pass
                    if os.path.isdir(target) and not member.isdir():
                        shutil.rmtree(target, ignore_errors=True)
                    elif os.path.isdir(target):
                        safe_members.append(member)
                        continue
                    else:
                        try:
                            os.remove(target)
                        except IsADirectoryError:
                            shutil.rmtree(target, ignore_errors=True)
            safe_members.append(member)
        tar.extractall(rootfs_dir, members=safe_members, filter="fully_trusted")
PY
}

rm -rf "${ROOTFS_DIR}" "${INITRAMFS_DIR}"
mkdir -p "${ROOTFS_DIR}" "${INITRAMFS_DIR}"

tar -xzf "${CACHE_DIR}/${ALPINE_TARBALL}" -C "${ROOTFS_DIR}"
tar -xzf "${CACHE_DIR}/${ALPINE_TARBALL}" -C "${INITRAMFS_DIR}"

install_packages "${ROOTFS_DIR}" "${ROOTFS_PACKAGES}"
install_packages "${INITRAMFS_DIR}" "${INITRAMFS_PACKAGES}"

install -m 0755 "${SANDBOXD_BIN}" "${ROOTFS_DIR}/usr/bin/sandboxd"
install -m 0755 "${SANDBOXFS_BIN}" "${ROOTFS_DIR}/usr/bin/sandboxfs"
install -m 0755 "${SANDBOXSSH_BIN}" "${ROOTFS_DIR}/usr/bin/sandboxssh"
install -m 0755 "${ROOTFS_INIT}" "${ROOTFS_DIR}/init"
install -m 0755 "${INITRAMFS_INIT}" "${INITRAMFS_DIR}/init"

if [[ -x "${ROOTFS_DIR}/usr/bin/python3" && ! -e "${ROOTFS_DIR}/usr/bin/python" ]]; then
    ln -s python3 "${ROOTFS_DIR}/usr/bin/python"
fi

mkdir -p "${ROOTFS_DIR}/proc" "${ROOTFS_DIR}/sys" "${ROOTFS_DIR}/dev" "${ROOTFS_DIR}/run"
mkdir -p "${INITRAMFS_DIR}/proc" "${INITRAMFS_DIR}/sys" "${INITRAMFS_DIR}/dev" "${INITRAMFS_DIR}/run"

copy_initramfs_modules() {
    local modules_dir="$1"
    local dest_dir="$2"
    if [[ ! -d "${modules_dir}" ]]; then
        echo "missing modules dir ${modules_dir}" >&2
        return 1
    fi

    MODULES_DIR="${modules_dir}" DEST_DIR="${dest_dir}" python3 - <<'PY'
import os
import shutil

modules_dir = os.environ["MODULES_DIR"]
dest_dir = os.environ["DEST_DIR"]
required = [
    "kernel/drivers/block/virtio_blk.ko.gz",
    "kernel/fs/ext4/ext4.ko.gz",
]

deps = {}
modules_dep = os.path.join(modules_dir, "modules.dep")
with open(modules_dep, "r", encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if not line:
            continue
        module, rest = line.split(":", 1)
        deps[module] = [entry for entry in rest.split() if entry]

stack = list(required)
seen = set()
while stack:
    mod = stack.pop()
    if mod in seen:
        continue
    seen.add(mod)
    for dep in deps.get(mod, []):
        stack.append(dep)

for entry in sorted(seen):
    src = os.path.join(modules_dir, entry)
    dest = os.path.join(dest_dir, entry)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(src, dest)

os.makedirs(dest_dir, exist_ok=True)
for entry in os.listdir(modules_dir):
    if not entry.startswith("modules."):
        continue
    src = os.path.join(modules_dir, entry)
    if os.path.isfile(src):
        shutil.copy2(src, os.path.join(dest_dir, entry))
PY
}

if [[ -d "${ROOTFS_DIR}/lib/modules" ]]; then
    KERNEL_VERSION=$(ls -1 "${ROOTFS_DIR}/lib/modules" | head -n 1)
    MODULES_DIR="${ROOTFS_DIR}/lib/modules/${KERNEL_VERSION}"
    INITRAMFS_MODULES_DIR="${INITRAMFS_DIR}/lib/modules/${KERNEL_VERSION}"
    copy_initramfs_modules "${MODULES_DIR}" "${INITRAMFS_MODULES_DIR}"
fi

rm -rf "${ROOTFS_DIR}/boot"

create_rootfs_image() {
    local image="$1"
    local source_dir="$2"

    if [[ -n "${ROOTFS_IMAGE_SIZE_MB:-}" ]]; then
        size_mb="${ROOTFS_IMAGE_SIZE_MB}"
    else
        local size_kb
        size_kb=$(du -sk "${source_dir}" | awk '{print $1}')
        size_kb=$((size_kb + size_kb / 5 + 65536))
        size_mb=$(((size_kb + 1023) / 1024))
    fi

    "${MKFS_EXT4}" \
        -t ext4 \
        -d "${source_dir}" \
        -L "${ROOTFS_LABEL}" \
        -m 0 \
        -O ^has_journal \
        -E lazy_itable_init=0,lazy_journal_init=0 \
        -b 4096 \
        -F "${image}" "${size_mb}M"
}

create_rootfs_image "${ROOTFS_IMAGE}" "${ROOTFS_DIR}"

(
    cd "${INITRAMFS_DIR}"
    find . -print0 | cpio --null -ov --format=newc | lz4 -l -c > "${INITRAMFS}"
)

echo "rootfs image written to ${ROOTFS_IMAGE}"
echo "initramfs written to ${INITRAMFS}"
