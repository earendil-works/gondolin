import fs from "fs";
import os from "os";
import path from "path";

import assert from "node:assert/strict";
import test from "node:test";

import { __test as buildAlpineTest } from "../src/build-alpine";

function writeCreateFailRuntime(binDir: string): void {
  const runtimePath = path.join(binDir, "docker");
  fs.writeFileSync(
    runtimePath,
    `#!/bin/sh
set -eu

cmd="\${1:-}"
if [ "$cmd" = "--version" ]; then
  printf "Docker fake 1.0\\n"
  exit 0
fi

if [ "$cmd" = "create" ]; then
  printf "daemon unavailable\\n" >&2
  exit 125
fi

exit 0
`,
    { mode: 0o755 },
  );
}

function writeLargePullRuntime(binDir: string): void {
  const runtimePath = path.join(binDir, "docker");
  fs.writeFileSync(
    runtimePath,
    `#!/bin/sh
set -eu

cmd="\${1:-}"
if [ "$cmd" = "--version" ]; then
  printf "Docker fake 1.0\\n"
  exit 0
fi

if [ "$cmd" = "pull" ]; then
  # Emit >1MB to stderr to verify maxBuffer handling
  i=0
  while [ "$i" -lt 20000 ]; do
    printf "layer output line %05d: abcdefghijklmnopqrstuvwxyz0123456789\\n" "$i" >&2
    i=$((i + 1))
  done
  exit 0
fi

if [ "$cmd" = "create" ]; then
  printf "cid-large-pull\\n"
  exit 0
fi

if [ "$cmd" = "export" ]; then
  shift
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
      shift
      out="\${1:-}"
      break
    fi
    shift || true
  done

  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/bin"
  printf "#!/bin/sh\\n" > "$tmpdir/bin/sh"
  chmod +x "$tmpdir/bin/sh"
  tar -cf "$out" -C "$tmpdir" .
  rm -rf "$tmpdir"
  exit 0
fi

if [ "$cmd" = "rm" ]; then
  exit 0
fi

exit 0
`,
    { mode: 0o755 },
  );
}

test("oci rootfs: buildOciCreateArgs includes dummy command", () => {
  const args = (buildAlpineTest as any).buildOciCreateArgs(
    "docker.io/library/debian:bookworm-slim",
    "linux/amd64",
    "never",
  ) as string[];

  assert.deepEqual(args, [
    "create",
    "--platform",
    "linux/amd64",
    "--pull=never",
    "docker.io/library/debian:bookworm-slim",
    "true",
  ]);
});

test("oci rootfs: pullPolicy always tolerates large pull output", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-large-pull-"));
  const binDir = path.join(tmp, "bin");
  const rootfsDir = path.join(tmp, "rootfs");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  writeLargePullRuntime(binDir);

  const oldPath = process.env.PATH;

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;

    (buildAlpineTest as any).exportOciRootfs({
      arch: "x86_64",
      image: "docker.io/library/debian:bookworm-slim",
      runtime: "docker",
      platform: "linux/amd64",
      pullPolicy: "always",
      workDir: tmp,
      targetDir: rootfsDir,
      log: () => {},
    });

    assert.equal(fs.existsSync(path.join(rootfsDir, "bin", "sh")), true);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci rootfs: pullPolicy never propagates non-missing runtime errors", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-runtime-fail-"));
  const binDir = path.join(tmp, "bin");
  const rootfsDir = path.join(tmp, "rootfs");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  writeCreateFailRuntime(binDir);

  const oldPath = process.env.PATH;

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;

    assert.throws(
      () =>
        (buildAlpineTest as any).exportOciRootfs({
          arch: "x86_64",
          image: "docker.io/library/debian:bookworm-slim",
          runtime: "docker",
          platform: "linux/amd64",
          pullPolicy: "never",
          workDir: tmp,
          targetDir: rootfsDir,
          log: () => {},
        }),
      /daemon unavailable/,
    );
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci rootfs: hardenExtractedRootfs rejects escaping relative symlinks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-symlink-"));
  const rootfsDir = path.join(tmp, "rootfs");

  fs.mkdirSync(rootfsDir, { recursive: true });
  fs.symlinkSync("../../../../tmp/escape", path.join(rootfsDir, "usr"));

  try {
    assert.throws(
      () => (buildAlpineTest as any).hardenExtractedRootfs(rootfsDir),
      /escaping the rootfs/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci rootfs: hardenExtractedRootfs rewrites absolute symlinks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-symlink-"));
  const rootfsDir = path.join(tmp, "rootfs");

  fs.mkdirSync(path.join(rootfsDir, "tmp", "hostdir"), { recursive: true });
  fs.symlinkSync("/tmp/hostdir", path.join(rootfsDir, "usr"));

  try {
    (buildAlpineTest as any).hardenExtractedRootfs(rootfsDir);

    assert.equal(fs.readlinkSync(path.join(rootfsDir, "usr")), "tmp/hostdir");
    assert.throws(
      () =>
        (buildAlpineTest as any).assertSafeWritePath(
          path.join(rootfsDir, "usr", "bin", "sandboxd"),
          rootfsDir,
        ),
      /symlinked path/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci rootfs: syncKernelModules handles /lib -> usr/lib symlink", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-modules-"));
  const rootfsDir = path.join(tmp, "rootfs");
  const initramfsDir = path.join(tmp, "initramfs");
  const kernelVersion = "6.18.9-0-virt";

  fs.mkdirSync(path.join(rootfsDir, "usr", "lib"), { recursive: true });
  fs.symlinkSync("usr/lib", path.join(rootfsDir, "lib"));

  const initModuleDir = path.join(
    initramfsDir,
    "lib",
    "modules",
    kernelVersion,
    "kernel",
    "drivers",
    "block",
  );
  fs.mkdirSync(initModuleDir, { recursive: true });
  fs.writeFileSync(path.join(initModuleDir, "virtio_blk.ko"), "module");

  try {
    (buildAlpineTest as any).syncKernelModules(rootfsDir, initramfsDir, () => {}, {
      copyRootfsToInitramfs: false,
    });

    assert.equal(
      fs.existsSync(
        path.join(
          rootfsDir,
          "usr",
          "lib",
          "modules",
          kernelVersion,
          "kernel",
          "drivers",
          "block",
          "virtio_blk.ko",
        ),
      ),
      true,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci rootfs: ensureRootfsShell bootstraps busybox from initramfs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-shell-"));
  const rootfsDir = path.join(tmp, "rootfs");
  const initramfsDir = path.join(tmp, "initramfs");

  fs.mkdirSync(path.join(rootfsDir, "usr", "bin"), { recursive: true });
  fs.symlinkSync("usr/bin", path.join(rootfsDir, "bin"));

  fs.mkdirSync(path.join(initramfsDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(initramfsDir, "sbin"), { recursive: true });
  fs.writeFileSync(path.join(initramfsDir, "bin", "busybox"), "busybox");
  fs.symlinkSync("/bin/busybox", path.join(initramfsDir, "bin", "sh"));
  fs.symlinkSync("/bin/busybox", path.join(initramfsDir, "bin", "grep"));
  fs.symlinkSync("../bin/busybox", path.join(initramfsDir, "sbin", "modprobe"));

  try {
    (buildAlpineTest as any).ensureRootfsShell(
      rootfsDir,
      "gcr.io/distroless/nodejs24-debian12",
      initramfsDir,
      () => {},
    );

    assert.equal(fs.existsSync(path.join(rootfsDir, "bin", "sh")), true);
    assert.equal(fs.existsSync(path.join(rootfsDir, "bin", "busybox")), true);
    assert.equal(fs.existsSync(path.join(rootfsDir, "sbin", "modprobe")), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
