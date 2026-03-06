import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __test as serverOptionsTest,
  resolveSandboxServerOptions,
} from "../src/sandbox/server-options.ts";

test("resolvePackagedKrunRunnerPath rejects non-runnable packaged candidate", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-packaged-runner-"),
  );

  try {
    const packageDir = path.join(tmp, "node_modules", "pkg");
    const packageJsonPath = path.join(packageDir, "package.json");
    const candidatePath = path.join(packageDir, "bin", "gondolin-krun-runner");

    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ bin: "bin/gondolin-krun-runner" }),
    );
    fs.writeFileSync(candidatePath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const resolved = serverOptionsTest.resolvePackagedKrunRunnerPath({
      platform: "linux",
      arch: "x64",
      resolvePackageJson: () => packageJsonPath,
      probeRunner: () => false,
    });

    assert.equal(resolved, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolvePackagedKrunRunnerPath accepts runnable packaged candidate", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-packaged-runner-"),
  );

  try {
    const packageDir = path.join(tmp, "node_modules", "pkg");
    const packageJsonPath = path.join(packageDir, "package.json");
    const candidatePath = path.join(packageDir, "bin", "gondolin-krun-runner");

    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ bin: "bin/gondolin-krun-runner" }),
    );
    fs.writeFileSync(candidatePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const resolved = serverOptionsTest.resolvePackagedKrunRunnerPath({
      platform: "linux",
      arch: "x64",
      resolvePackageJson: () => packageJsonPath,
      probeRunner: (candidate) => candidate === candidatePath,
    });

    assert.equal(resolved, candidatePath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveDefaultKrunRunnerPath falls back to PATH token", () => {
  const resolved = serverOptionsTest.resolveDefaultKrunRunnerPath({
    envPath: undefined,
    resolveLocalPath: () => null,
    resolvePackagedPath: () => null,
  });

  assert.equal(resolved, "gondolin-krun-runner");
});

test("resolveSandboxServerOptions does not resolve krun runner for qemu", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-qemu-runner-"));

  try {
    const kernelPath = path.join(tmp, "vmlinuz-virt");
    const initrdPath = path.join(tmp, "initramfs.cpio.lz4");
    const rootfsPath = path.join(tmp, "rootfs.ext4");
    fs.writeFileSync(kernelPath, "");
    fs.writeFileSync(initrdPath, "");
    fs.writeFileSync(rootfsPath, "");

    let resolveCalls = 0;
    const resolved = resolveSandboxServerOptions(
      {
        vmm: "qemu",
        imagePath: {
          kernelPath,
          initrdPath,
          rootfsPath,
        },
      },
      undefined,
      {
        resolveDefaultKrunRunnerPath: () => {
          resolveCalls += 1;
          throw new Error("krun runner resolver should not be called for qemu");
        },
      },
    );

    assert.equal(resolved.vmm, "qemu");
    assert.equal(resolveCalls, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
