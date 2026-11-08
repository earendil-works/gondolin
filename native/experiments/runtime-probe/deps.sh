#!/bin/bash
# Counts runtime crates (`cargo tree -e normal`, unique name+version, without
# the scratch crate itself) of scratch crates: a dependency base plus one
# runtime candidate each. Numbers in native/docs/runtime-without-tokio.md.
#
#   ./deps.sh [OUT_DIR]   (default: a temp dir; needs network for the first resolve)
set -euo pipefail

out=${1:-$(mktemp -d)}
mkdir -p "$out"

# m0: the smallest plausible post-diet core (no runtime, no HTTP/SSH/serde)
M0='smoltcp = { version = "0.14", default-features = false, features = ["std","alloc","medium-ip","proto-ipv4","socket-tcp"] }
ring = "0.17"
rustls = { version = "0.23", default-features = false, features = ["ring","std","tls12"] }
webpki-roots = "1"
libc = "0.2"
rustix = { version = "1", features = ["fs","process","std"] }'
# b0: m0 plus the other non-runtime crates in use today (assets, native roots)
B0="$M0"'
rustls-native-certs = "0.8"
flate2 = "1"
tar = { version = "0.4", default-features = false }'

TOKIO_MIN='tokio = { version = "1", features = ["rt","rt-multi-thread","net","time","sync"] }'
TOKIO_MIN_IO='tokio = { version = "1", features = ["rt","rt-multi-thread","net","io-util","time","sync"] }'
TOKIO_MIN_PROC='tokio = { version = "1", features = ["rt","rt-multi-thread","net","io-util","time","sync","process","signal","io-std"] }'
TOKIO_FULL='tokio = { version = "1", features = ["full"] }'
ECO='tokio-rustls = { version = "0.26", default-features = false, features = ["ring","tls12"] }
futures-util = { version = "0.3", default-features = false, features = ["std"] }
async-trait = "0.1"'

gen() { # name base extra
    mkdir -p "$out/$1/src"
    echo 'fn main() {}' >"$out/$1/src/main.rs"
    printf '[package]\nname = "scratch-%s"\nversion = "0.1.0"\nedition = "2024"\n[workspace]\n[dependencies]\n%s\n%s\n' \
        "$1" "$2" "$3" >"$out/$1/Cargo.toml"
}

gen m0 "$M0" ''
gen m0-tokio-min "$M0" "$TOKIO_MIN"
gen m0-tokio-min-io "$M0" "$TOKIO_MIN_IO"
gen m0-tokio-min-proc "$M0" "$TOKIO_MIN_PROC"
gen m0-tokio-full "$M0" "$TOKIO_FULL"
gen m0-mio "$M0" 'mio = { version = "1", default-features = false, features = ["os-poll","net","os-ext"] }'
gen m0-polling "$M0" 'polling = "3"'
gen b0 "$B0" ''
gen b0-mio-default "$B0" 'mio = { version = "1", features = ["os-poll","net","os-ext"] }'
gen b0-async-io "$B0" 'async-io = "2"
futures-lite = "2"'
gen b0-smol "$B0" 'smol = "2"'
gen b0-tokio-min-proc "$B0" "$TOKIO_MIN_PROC"
gen b0-tokio-full "$B0" "$TOKIO_FULL"
gen b0-tokio-full-eco "$B0" "$TOKIO_FULL
$ECO
pin-project-lite = \"0.2\"
bytes = \"1\""
gen b0-russh "$B0" "$TOKIO_FULL"'
russh = { version = "0.65", default-features = false, features = ["ring","rsa","flate2"] }'
gen b0-rsa "$B0" 'rsa = "=0.10.0-rc.18"
rand_core = "0.10"'

count() { # dir target
    (cd "$1" && cargo tree -q -e normal --prefix none --target "$2") |
        sed 's/ (.*//' | grep -v '^scratch-' | sort -u
}

printf '%-22s %6s %6s\n' variant macos linux
for d in m0 m0-tokio-min m0-tokio-min-io m0-tokio-min-proc m0-tokio-full m0-mio m0-polling \
    b0 b0-mio-default b0-async-io b0-smol b0-tokio-min-proc b0-tokio-full b0-tokio-full-eco \
    b0-russh b0-rsa; do
    (cd "$out/$d" && cargo fetch -q >/dev/null 2>&1 || true)
    mac=$(count "$out/$d" aarch64-apple-darwin | wc -l)
    lin=$(count "$out/$d" x86_64-unknown-linux-gnu | wc -l)
    printf '%-22s %6d %6d\n' "$d" "$mac" "$lin"
done
