#!/usr/bin/env bash
# Counts the third-party runtime crates of the `gondolin` binary (the
# multi-call CLI + daemon): `cargo tree -e normal` of gondolin-cli, unique
# name+version, without our workspace crates, for every release target.
# Fails when a target exceeds the budget in native/deps-budget (lowered as the
# dependency diet progresses, PLAN.md M8). Earendil's own crates from the djs
# repository (djs-embed, djs-core, djs-prelude, djs-libm; matched by their git
# source) are first-party: reported separately, not counted against the budget.
#
# usage: native/scripts/count-deps.sh [--list] [--budget N]
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NATIVE=$(cd "$HERE/.." && pwd)
TARGETS=(aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-musl x86_64-unknown-linux-musl)

list=0
budget=$(grep -v '^#' "$NATIVE/deps-budget" | tr -d '[:space:]')
while [ $# -gt 0 ]; do
  case "$1" in
    --list) list=1; shift ;;
    --budget) budget=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# first-party crates outside the workspace: djs, by its git source
FIRST_PARTY='^djs-[a-z0-9-]+ v[^ ]+ \(https://github\.com/earendil-works/djs(\.git)?[?#]'

tree() { # target
  # --color never: with CARGO_TERM_COLOR=always (set by CI's Rust toolchain
  # action) the " (*)" marks of repeated crates are colored, the filters below
  # miss them and those crates count twice
  (cd "$NATIVE" && cargo tree -q --locked --color never -p gondolin-cli -e normal --prefix none --target "$1")
}

crates() { # target
  tree "$1" | grep -v -E "$FIRST_PARTY" |
    sed 's/ (.*//' | sort -u | grep -v -E '^(gondolin(-[a-z0-9]+)+|gondolind) '
}

first_party() { # target
  tree "$1" | grep -E "$FIRST_PARTY" | sed 's/ (.*//' | sort -u
}

max=0
for t in "${TARGETS[@]}"; do
  n=$(crates "$t" | wc -l | tr -d ' ')
  f=$(first_party "$t" | wc -l | tr -d ' ')
  printf '%-28s %4d  (+%d first-party: djs)\n' "$t" "$n" "$f"
  [ "$n" -gt "$max" ] && max=$n
  if [ "$list" = 1 ]; then
    crates "$t" | sed 's/^/    /'
    first_party "$t" | sed 's/^/    first-party: /'
  fi
done
if [ "$max" -gt "$budget" ]; then
  echo "error: $max runtime crates, budget is $budget (native/deps-budget)" >&2
  exit 1
fi
echo "ok: at most $max runtime crates (budget $budget)"
if [ "$max" -lt "$budget" ]; then
  echo "note: lower native/deps-budget to $max"
fi
