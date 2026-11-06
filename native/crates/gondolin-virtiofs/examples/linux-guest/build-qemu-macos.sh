#!/usr/bin/env bash
# Builds qemu-system-aarch64 with vhost-user on macOS (Homebrew's QEMU has it
# disabled). Needs Homebrew glib/pixman and python3; ~5 minutes.
# usage: build-qemu-macos.sh [workdir] [version]
set -euo pipefail
WORK=${1:-/tmp/qemu-vu}
VERSION=${2:-10.2.1}
mkdir -p "$WORK" && cd "$WORK"
[ -f "qemu-$VERSION.tar.xz" ] || curl -sSLO "https://download.qemu.org/qemu-$VERSION.tar.xz"
[ -d "qemu-$VERSION" ] || tar xf "qemu-$VERSION.tar.xz"
[ -x venv/bin/ninja ] || { python3 -m venv venv && ./venv/bin/pip -q install ninja; }
export PATH="$WORK/venv/bin:$PATH"
mkdir -p "qemu-$VERSION/build" && cd "qemu-$VERSION/build"
# vhost-net includes Linux headers when vhost-user is on: disable it (and
# ParavirtualizedGraphics, which Homebrew also disables on recent macOS).
../configure --target-list=aarch64-softmmu --enable-vhost-user --disable-vhost-net \
  --disable-vhost-crypto --disable-pvg --disable-docs --disable-sdl --disable-gtk --disable-cocoa
ninja qemu-system-aarch64
echo "$PWD/qemu-system-aarch64"
