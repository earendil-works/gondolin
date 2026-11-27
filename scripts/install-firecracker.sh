#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/install-firecracker.sh [version]

Download a pinned Firecracker release for this machine's architecture, check
it against a pinned SHA256 and install `firecracker` and `jailer` (the
binaries Gondolin's firecracker backend runs) into the install directory.

Environment:
  FIRECRACKER_VERSION      version when no positional version is supplied (default: v1.18.0)
  FIRECRACKER_INSTALL_DIR  where the binaries go (default: /usr/local/bin)
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

VERSION="${1:-${FIRECRACKER_VERSION:-v1.18.0}}"
INSTALL_DIR="${FIRECRACKER_INSTALL_DIR:-/usr/local/bin}"

if [[ "$(uname -s)" != Linux ]]; then
  echo "Firecracker runs on Linux only" >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64 ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

# release archive checksums (the `.sha256.txt` files published with each release)
case "$VERSION-$ARCH" in
  v1.18.0-x86_64) SHA256=1ac8eec866dd5eea14efecf6323e22b23eea24054545338a5b34bc5bca6623cd ;;
  v1.18.0-aarch64) SHA256=2a6130ff0338901ff9d7fbd73ce046c6b1c6123889dc84a34d678aa53bd0c0c2 ;;
  *)
    echo "no pinned checksum for Firecracker $VERSION on $ARCH; add it to $0" >&2
    exit 1
    ;;
esac

ARCHIVE="firecracker-$VERSION-$ARCH.tgz"
URL="https://github.com/firecracker-microvm/firecracker/releases/download/$VERSION/$ARCHIVE"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $URL"
curl -fsSL --retry 3 -o "$tmp/$ARCHIVE" "$URL"
echo "$SHA256  $tmp/$ARCHIVE" | sha256sum -c --quiet -
tar -xzf "$tmp/$ARCHIVE" -C "$tmp"

release="$tmp/release-$VERSION-$ARCH"
SUDO=""
if [[ ! -w "$INSTALL_DIR" && "$(id -u)" != 0 ]]; then
  SUDO=sudo
fi
$SUDO mkdir -p "$INSTALL_DIR"
for bin in firecracker jailer; do
  $SUDO install -m 0755 "$release/$bin-$VERSION-$ARCH" "$INSTALL_DIR/$bin"
done
"$INSTALL_DIR/firecracker" --version | head -1
echo "Installed firecracker and jailer into $INSTALL_DIR"
