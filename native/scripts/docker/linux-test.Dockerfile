# Linux test environment for native/scripts/test-linux-docker.sh: Rust, Node,
# pnpm and Debian's QEMU (which has vhost-user-fs and memfd guest RAM). No
# sources are baked in; the repository is bind-mounted read-only at run time.
# BASE=ubuntu:24.04 gives the QEMU of GitHub's ubuntu-latest runners.
ARG BASE=debian:trixie
FROM ${BASE}

ARG NODE_MAJOR=24
ARG PNPM_VERSION=12.8.1

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential pkg-config python3 \
      qemu-system-arm qemu-system-x86 qemu-utils ipxe-qemu lz4 xz-utils \
      procps iproute2 iputils-ping openssh-client e2fsprogs file sudo \
  && rm -rf /var/lib/apt/lists/*

# Node (official build, latest of NODE_MAJOR) and pnpm
RUN set -eux; \
    arch=$(dpkg --print-architecture); \
    case "$arch" in arm64) narch=arm64 ;; amd64) narch=x64 ;; *) echo "unsupported $arch"; exit 1 ;; esac; \
    ver=$(curl -fsSL https://nodejs.org/dist/index.json \
      | python3 -c "import json,sys; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v${NODE_MAJOR}.')))"); \
    curl -fsSL "https://nodejs.org/dist/$ver/node-$ver-linux-$narch.tar.xz" | tar -xJ -C /usr/local --strip-components=1; \
    node --version; \
    npm install -g "pnpm@${PNPM_VERSION}"; \
    pnpm --version

# Rust (stable, minimal)
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
  && chmod -R a+rwX /usr/local/rustup /usr/local/cargo && cargo --version

# Unprivileged test user: several tests check permission errors, which root
# bypasses. Volumes are chowned to it by the entry script.
# (ubuntu images ship a uid 1000 user)
RUN (userdel -r ubuntu 2>/dev/null || true) \
  && useradd -m -u 1000 -s /bin/bash tester \
  && echo 'tester ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/tester
