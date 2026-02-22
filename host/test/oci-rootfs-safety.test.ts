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
