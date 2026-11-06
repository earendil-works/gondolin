# Sourced by the build/test scripts: `cross_env <rust-target>` exports the C
# compiler, archiver and linker for cross builds. Linux musl targets use the
# `zig cc` wrappers next to this file (zig 0.17 on PATH); darwin targets need
# nothing beyond Xcode.

_CROSS_ENV_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

cross_env() {
  local target=$1 zigtarget upper
  case "$target" in
    aarch64-unknown-linux-musl) zigtarget=aarch64-linux-musl ;;
    x86_64-unknown-linux-musl) zigtarget=x86_64-linux-musl ;;
    *-apple-darwin) return 0 ;;
    *) echo "unsupported target $target" >&2; return 1 ;;
  esac
  command -v zig >/dev/null || { echo "zig (0.17) is required for $target builds" >&2; return 1; }
  rustup target list --installed 2>/dev/null | grep -qx "$target" \
    || { echo "missing rust target: rustup target add $target" >&2; return 1; }
  upper=$(echo "$target" | tr 'a-z-' 'A-Z_')
  local lower=${target//-/_}
  export "CC_$lower=$_CROSS_ENV_DIR/zigcc-$zigtarget"
  export "AR_$lower=$_CROSS_ENV_DIR/zigar"
  export "CARGO_TARGET_${upper}_LINKER=$_CROSS_ENV_DIR/zigcc-$zigtarget"
}
