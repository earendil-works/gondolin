#!/usr/bin/env bash
# Release builds of the native binaries for every supported target, from one
# machine. Linux targets are fully static (musl) and use `zig cc` (zig 0.17)
# as C compiler and linker; darwin targets use the Xcode toolchain.
#
# usage: native/scripts/build-release.sh [--examples] [TARGET...]
#   TARGET defaults to: aarch64-unknown-linux-musl x86_64-unknown-linux-musl
#                       aarch64-apple-darwin x86_64-apple-darwin
# Binaries are copied to native/target/dist/<target>/.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NATIVE=$(cd "$HERE/.." && pwd)
# shellcheck source=cross-env.sh
source "$HERE/cross-env.sh"

EXAMPLES=0
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --examples) EXAMPLES=1 ;;
    -*) echo "unknown option $arg" >&2; exit 2 ;;
    *) TARGETS+=("$arg") ;;
  esac
done
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(aarch64-unknown-linux-musl x86_64-unknown-linux-musl aarch64-apple-darwin x86_64-apple-darwin)
fi

cd "$NATIVE"
for target in "${TARGETS[@]}"; do
  cross_env "$target"
  echo "==> $target" >&2
  args=(--release --target "$target" --workspace --bins)
  [ "$EXAMPLES" = 1 ] && args+=(--examples)
  cargo build "${args[@]}"
  dist="$NATIVE/target/dist/$target"
  rm -rf "$dist" && mkdir -p "$dist"
  out="$NATIVE/target/$target/release"
  # binaries: executable regular files without an extension
  for f in "$out"/*; do
    [ -f "$f" ] && [ -x "$f" ] && [[ "$(basename "$f")" != *.* ]] && cp "$f" "$dist/"
  done
  if [ "$EXAMPLES" = 1 ]; then
    for f in "$out"/examples/*; do
      [ -f "$f" ] && [ -x "$f" ] && [[ "$(basename "$f")" != *-* ]] && [[ "$(basename "$f")" != *.* ]] && cp "$f" "$dist/"
    done
  fi
  for f in "$dist"/*; do
    desc=$(file -b "$f")
    case "$target" in
      *-linux-*)
        if [[ "$desc" != *"statically linked"* && "$desc" != *"static-pie linked"* ]] || [[ "$desc" == *interpreter* ]]; then
          echo "error: $f is not fully static: $desc" >&2
          exit 1
        fi ;;
    esac
    printf '%-8s %s  %s\n' "$(du -h "$f" | cut -f1)" "$f" "$desc"
  done
done
