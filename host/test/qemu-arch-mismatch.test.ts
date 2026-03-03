import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";

function makeTempAssetsDir(
  arch: "aarch64" | "x86_64",
  options: { includeKrunAssets?: boolean } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-arch-"));
  const includeKrunAssets = options.includeKrunAssets ?? true;

  // Required asset files (can be empty for this test).
  fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "");
  fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "");
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), "");
  if (includeKrunAssets) {
    fs.writeFileSync(path.join(dir, "krun-kernel"), "");
    fs.writeFileSync(path.join(dir, "krun-initrd"), "");
  }

  // Manifest is what we use to detect the guest architecture.
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        config: {
          arch,
          distro: "alpine",
          alpine: { version: "3.23.0" },
        },
        buildTime: new Date().toISOString(),
        assets: {
          kernel: "vmlinuz-virt",
          initramfs: "initramfs.cpio.lz4",
          rootfs: "rootfs.ext4",
          ...(includeKrunAssets
            ? {
                krunKernel: "krun-kernel",
                krunInitrd: "krun-initrd",
              }
            : {}),
        },
        checksums: {
          kernel: "",
          initramfs: "",
          rootfs: "",
          ...(includeKrunAssets
            ? {
                krunKernel: "",
                krunInitrd: "",
              }
            : {}),
        },
      },
      null,
      2,
    ),
  );

  return dir;
}

test("resolveSandboxServerOptions fails fast on guest/qemu arch mismatch", () => {
  const dir = makeTempAssetsDir("aarch64");
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          qemuPath: "qemu-system-x86_64",
        }),
      /Guest image architecture mismatch/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions allows matching guest/qemu arch", () => {
  const dir = makeTempAssetsDir("aarch64");
  try {
    const resolved = resolveSandboxServerOptions({
      imagePath: dir,
      qemuPath: "qemu-system-aarch64",
    });
    assert.equal(path.basename(resolved.kernelPath), "vmlinuz-virt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions fails fast on guest/krun host arch mismatch", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const otherArch = hostArch === "aarch64" ? "x86_64" : "aarch64";
  const dir = makeTempAssetsDir(otherArch);
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "krun",
        }),
      /Guest image architecture mismatch for libkrun backend/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects invalid vmm backend", () => {
  const dir = makeTempAssetsDir("aarch64");
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "wat" as any,
        }),
      /invalid sandbox vmm backend/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions requires manifest krunKernel for vmm=krun", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = makeTempAssetsDir(hostArch, { includeKrunAssets: false });

  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "krun",
        }),
      /Selected image does not provide krun boot assets/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects qemu-only options for krun", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = makeTempAssetsDir(hostArch);
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "krun",
          qemuPath: "qemu-system-aarch64",
          machineType: "virt",
          accel: "tcg",
          cpu: "max",
        }),
      /Unsupported sandbox options for vmm=krun: sandbox\.qemuPath, sandbox\.machineType, sandbox\.accel, sandbox\.cpu/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects single qemu-only option for krun", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = makeTempAssetsDir(hostArch);
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "krun",
          machineType: "virt",
        }),
      /Unsupported sandbox option for vmm=krun: sandbox\.machineType/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions uses manifest krunKernel/krunInitrd when vmm=krun", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = makeTempAssetsDir(hostArch);

  const krunKernel = path.join(dir, "krun-kernel");
  const krunInitrd = path.join(dir, "krun-initrd");
  fs.writeFileSync(krunKernel, "kernel");
  fs.writeFileSync(krunInitrd, "");

  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.assets.krunKernel = "krun-kernel";
  manifest.assets.krunInitrd = "krun-initrd";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  try {
    const resolved = resolveSandboxServerOptions({
      imagePath: dir,
      vmm: "krun",
    });

    assert.equal(resolved.kernelPath, krunKernel);
    assert.equal(resolved.initrdPath, krunInitrd);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions keeps explicit asset object for krun", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = makeTempAssetsDir(hostArch);

  try {
    const explicitAssets = {
      kernelPath: path.join(dir, "vmlinuz-virt"),
      initrdPath: path.join(dir, "initramfs.cpio.lz4"),
      rootfsPath: path.join(dir, "rootfs.ext4"),
    };

    const resolved = resolveSandboxServerOptions({
      imagePath: explicitAssets,
      vmm: "krun",
    });

    assert.equal(resolved.kernelPath, explicitAssets.kernelPath);
    assert.equal(resolved.initrdPath, explicitAssets.initrdPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions auto-detects local krun runner path", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = makeTempAssetsDir(hostArch);
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-krun-runner-"),
  );
  const localRunner = path.join(
    tempRoot,
    "host",
    "krun-runner",
    "zig-out",
    "bin",
    "gondolin-krun-runner",
  );
  fs.mkdirSync(path.dirname(localRunner), { recursive: true });
  fs.writeFileSync(localRunner, "");
  fs.chmodSync(localRunner, 0o755);

  const prevCwd = process.cwd();
  const prevRunner = process.env.GONDOLIN_KRUN_RUNNER;
  if (prevRunner !== undefined) delete process.env.GONDOLIN_KRUN_RUNNER;
  process.chdir(tempRoot);

  try {
    const resolved = resolveSandboxServerOptions({
      imagePath: dir,
      vmm: "krun",
    });

    assert.equal(
      fs.realpathSync(resolved.krunRunnerPath),
      fs.realpathSync(localRunner),
    );
  } finally {
    process.chdir(prevCwd);
    if (prevRunner === undefined) delete process.env.GONDOLIN_KRUN_RUNNER;
    else process.env.GONDOLIN_KRUN_RUNNER = prevRunner;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
