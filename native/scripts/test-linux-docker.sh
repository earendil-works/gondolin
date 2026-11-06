#!/usr/bin/env bash
# Linux tests in Docker (Docker Desktop on macOS works; no /dev/kvm needed).
#
#   native/scripts/test-linux-docker.sh [phase...]
#
# phases (default: all, in this order):
#   cargo       `cargo test --workspace` natively in a linux/arm64 container
#   amd64       x86_64 musl test binaries (cross-compiled on the host with
#               cross-env.sh) run in a linux/amd64 container (emulated):
#               AMD64_PACKAGES (default: wire proto vfs netstack egress sshproxy)
#   vm          native engine end to end with QEMU TCG: memfd RAM + virtio-fs,
#               openat2 host mounts, resolv.conf, PR_SET_PDEATHSIG
#               (docker/linux-smoke.mts)
#   host-tests  host tests with GONDOLIN_ENGINE=native under TCG: HOST_TESTS
#               (default: exec vfs native-vfs network-egress cli-vm; `all`:
#               every host test but krun and container-build, ~4 min)
#
# The repository is mounted read-only; Linux build outputs, node_modules and
# the cargo/pnpm caches live in docker volumes named gondolin-lt-*
# (`docker volume rm $(docker volume ls -q -f name=gondolin-lt-)` resets).
# The VM phases need an aarch64 guest image in guest/image/out (built with
# helpers from source: `cd guest && GONDOLIN_SANDBOX_HELPERS_DIR=$PWD/zig-out
# make build`) or GUEST_IMAGE=<dir>.
# shellcheck disable=SC2016 # JavaScript in single quotes
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NATIVE=$(cd "$HERE/.." && pwd)
REPO=$(cd "$NATIVE/.." && pwd)
DOCKERFILE="$HERE/docker/linux-test.Dockerfile"
TAG="gondolin-linux-test:$(shasum -a 256 "$DOCKERFILE" | cut -c1-12)"
PHASES=("$@")
[ ${#PHASES[@]} -gt 0 ] || PHASES=(cargo amd64 vm host-tests)

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

ensure_image() { # <platform>
  local platform=$1 tag="$TAG-${1#linux/}"
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    echo "building $tag" >&2
    docker build --platform "$platform" -t "$tag" -f "$DOCKERFILE" "$HERE/docker" >&2
  fi
  echo "$tag"
}

GUEST_IMAGE=${GUEST_IMAGE:-$REPO/guest/image/out}

in_container() { # <phase...>
  local tag
  tag=$(ensure_image linux/arm64)
  local mounts=(
    -v "$REPO:/src:ro"
    -v gondolin-lt-target:/target
    -v gondolin-lt-cargo:/usr/local/cargo/registry
    -v gondolin-lt-pnpm:/pnpm-store
    -v gondolin-lt-nm:/src/node_modules
    -v gondolin-lt-nm-host:/src/host/node_modules
    -v gondolin-lt-work:/work
  )
  if [ -f "$GUEST_IMAGE/manifest.json" ]; then
    mounts+=(-v "$GUEST_IMAGE:/image:ro")
  elif [[ " $* " == *" vm "* || " $* " == *" host-tests "* ]]; then
    echo "no guest image at $GUEST_IMAGE (set GUEST_IMAGE or build guest/image/out)" >&2
    return 1
  fi
  local tty=()
  [ -t 1 ] && tty=(-t)
  docker run --rm ${tty[@]+"${tty[@]}"} --platform linux/arm64 --init \
    --shm-size=2g \
    -e CARGO_TEST_ARGS -e HOST_TESTS -e WS_TIMEOUT -e TEST_TIMEOUT_MS -e GONDOLIN_DEBUG \
    "${mounts[@]}" "$tag" /src/native/scripts/docker/in-container.sh "$@"
}

run_amd64() {
  # shellcheck disable=SC1091
  source "$HERE/cross-env.sh"
  local target=x86_64-unknown-linux-musl
  cross_env "$target"
  local pkgs=() p
  for p in ${AMD64_PACKAGES:-wire proto vfs netstack egress sshproxy}; do pkgs+=(-p "gondolin-$p"); done
  local json
  json=$(mktemp)
  echo "building $target tests: ${pkgs[*]}" >&2
  (cd "$NATIVE" && cargo test --no-run --target "$target" --message-format=json-render-diagnostics "${pkgs[@]}") > "$json"
  # binary<TAB>package dir, run with the package dir as cwd like cargo test
  local list
  list=$(node -e '
    for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      const m = JSON.parse(line);
      if (m.reason === "compiler-artifact" && m.profile?.test && m.executable)
        console.log(`${m.executable}\t${require("path").dirname(m.manifest_path)}`);
    }' "$json")
  rm -f "$json"
  local tag
  tag=$(ensure_image linux/amd64)
  # Same paths inside the container: compile-time CARGO_MANIFEST_DIR and fixtures resolve.
  docker run --rm --platform linux/amd64 --init -v "$REPO:$REPO:ro" -e LIST="$list" \
    -e SKIPS="$(grep -v '^#' "$HERE/docker/amd64.skip" | sed 's/#.*//')" "$tag" bash -c '
    set -u; failed=0; uname -m
    while IFS=$(printf "\t") read -r exe dir; do
      [ -n "$exe" ] || continue
      name=$(basename "$exe"); name=${name%-*}
      skip=(); while read -r bin filter; do [ "$bin" = "$name" ] && skip+=(--skip "$filter"); done <<< "$SKIPS"
      echo; echo "=== $name ${skip[*]+${skip[*]}}"
      if (cd "$dir" && sudo -u tester HOME=/home/tester TMPDIR=/tmp "$exe" -q ${skip[@]+"${skip[@]}"}); then :; else failed=$((failed + 1)); echo "=== FAILED: $exe"; fi
    done <<< "$LIST"
    echo; echo "amd64: $failed failing binaries"; [ "$failed" = 0 ]'
}

FAILED=()
for phase in "${PHASES[@]}"; do
  case "$phase" in
    cargo|vm|host-tests) in_container "$phase" || FAILED+=("$phase") ;;
    amd64) run_amd64 || FAILED+=("$phase") ;;
    *) echo "unknown phase $phase" >&2; exit 2 ;;
  esac
done
echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "linux docker tests: all phases passed (${PHASES[*]})"
else
  echo "linux docker tests: failed phases: ${FAILED[*]}"
  exit 1
fi
