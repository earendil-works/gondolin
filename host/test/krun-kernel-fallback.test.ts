import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __test as serverOptionsTest,
  resolveSandboxServerOptions,
} from "../src/sandbox/server-options.ts";
import { isLoadableX86Kernel } from "../src/utils/kernel-image.ts";

function makeKernelFile(dir: string, name: string, bytes: Buffer): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

function makeManifestAssets(
  arch: "aarch64" | "x86_64",
  options: {
    krunKernelBytes?: Buffer;
    includeKrunAssets?: boolean;
  } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-krun-fallback-"));
  const includeKrunAssets = options.includeKrunAssets ?? true;
  const bzImage = Buffer.from("MZ\x00\x00", "latin1");

  fs.writeFileSync(path.join(dir, "vmlinuz-virt"), bzImage);
  fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "initramfs");
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), "rootfs");

  if (includeKrunAssets) {
    fs.writeFileSync(
      path.join(dir, "krun-kernel"),
      options.krunKernelBytes ?? Buffer.from([0xfc, 0x8b, 0x03, 0x8d]),
    );
    fs.writeFileSync(path.join(dir, "krun-empty-initrd"), "krun-empty-initrd");
  }

  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        config: { arch, distro: "alpine", alpine: { version: "3.23.0" } },
        buildTime: new Date().toISOString(),
        assets: {
          kernel: "vmlinuz-virt",
          initramfs: "initramfs.cpio.lz4",
          rootfs: "rootfs.ext4",
          ...(includeKrunAssets
            ? { krunKernel: "krun-kernel", krunInitrd: "krun-empty-initrd" }
            : {}),
        },
        checksums: {
          kernel: "",
          initramfs: "",
          rootfs: "",
          ...(includeKrunAssets ? { krunKernel: "", krunInitrd: "" } : {}),
        },
      },
      null,
      2,
    ),
  );

  return dir;
}

test("isLoadableX86Kernel accepts the formats libkrun can load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-kernel-magic-"));

  try {
    const cases: Array<[string, Buffer, boolean]> = [
      ["elf", Buffer.from("\x7fELF\x02\x01\x01", "latin1"), true],
      ["bzimage", Buffer.from("MZ\x00\x00", "latin1"), true],
      ["gzip", Buffer.from([0x1f, 0x8b, 0x08, 0x00]), true],
      ["bzip2", Buffer.from("BZh9", "latin1"), true],
      ["zstd", Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), true],
      ["libkrunfw-raw", Buffer.from([0xfc, 0x8b, 0x03, 0x8d]), false],
      ["empty", Buffer.alloc(0), false],
    ];

    for (const [name, bytes, expected] of cases) {
      const filePath = makeKernelFile(dir, name, bytes);
      assert.equal(isLoadableX86Kernel(filePath), expected, name);
    }

    assert.equal(isLoadableX86Kernel(path.join(dir, "missing")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldUseKrunManifestOverride ignores raw x86_64 kernels only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-override-"));

  try {
    const rawKernel = makeKernelFile(
      dir,
      "krun-kernel",
      Buffer.from([0xfc, 0x8b, 0x03, 0x8d]),
    );
    const override = { kernelPath: rawKernel, initrdPath: rawKernel };

    assert.equal(
      serverOptionsTest.shouldUseKrunManifestOverride(override, "x64"),
      false,
    );
    assert.equal(
      serverOptionsTest.shouldUseKrunManifestOverride(override, "arm64"),
      true,
    );
    assert.equal(
      serverOptionsTest.shouldUseKrunManifestOverride(override, null),
      true,
    );
    assert.equal(
      serverOptionsTest.shouldUseKrunManifestOverride(null, "x64"),
      false,
    );

    const bzImage = makeKernelFile(
      dir,
      "bzImage",
      Buffer.from("MZ\x00", "latin1"),
    );
    assert.equal(
      serverOptionsTest.shouldUseKrunManifestOverride(
        { kernelPath: bzImage, initrdPath: bzImage },
        "x64",
      ),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x86_64 krun ignores the obsolete raw manifest kernel", (t) => {
  if (process.arch !== "x64") {
    t.skip("x86_64-specific resolver behaviour");
    return;
  }

  const dir = makeManifestAssets("x86_64");

  try {
    const resolved = resolveSandboxServerOptions({
      imagePath: dir,
      vmm: "krun",
      krunRunnerPath: "/bin/true",
    });

    assert.equal(path.basename(resolved.kernelPath), "vmlinuz-virt");
    assert.equal(path.basename(resolved.initrdPath), "initramfs.cpio.lz4");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x86_64 krun keeps a loadable manifest kernel", (t) => {
  if (process.arch !== "x64") {
    t.skip("x86_64-specific resolver behaviour");
    return;
  }

  const dir = makeManifestAssets("x86_64", {
    krunKernelBytes: Buffer.from("MZ\x00\x00", "latin1"),
  });

  try {
    const resolved = resolveSandboxServerOptions({
      imagePath: dir,
      vmm: "krun",
      krunRunnerPath: "/bin/true",
    });

    assert.equal(path.basename(resolved.kernelPath), "krun-kernel");
    assert.equal(path.basename(resolved.initrdPath), "krun-empty-initrd");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit imagePath object is never replaced by a manifest fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-explicit-"));

  try {
    const kernelPath = makeKernelFile(
      dir,
      "custom-kernel",
      Buffer.from([0xfc, 0x8b, 0x03, 0x8d]),
    );
    const initrdPath = path.join(dir, "custom-initrd");
    const rootfsPath = path.join(dir, "custom-rootfs");
    fs.writeFileSync(initrdPath, "initrd");
    fs.writeFileSync(rootfsPath, "rootfs");

    const resolved = resolveSandboxServerOptions({
      imagePath: { kernelPath, initrdPath, rootfsPath },
      vmm: "krun",
      krunRunnerPath: "/bin/true",
    });

    assert.equal(resolved.kernelPath, kernelPath);
    assert.equal(resolved.initrdPath, initrdPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x86_64 krun falls back to base assets when krun assets are absent", (t) => {
  if (process.arch !== "x64") {
    t.skip("x86_64-specific resolver behaviour");
    return;
  }

  const dir = makeManifestAssets("x86_64", { includeKrunAssets: false });

  try {
    const resolved = resolveSandboxServerOptions({
      imagePath: dir,
      vmm: "krun",
      krunRunnerPath: "/bin/true",
    });

    assert.equal(path.basename(resolved.kernelPath), "vmlinuz-virt");
    assert.equal(path.basename(resolved.initrdPath), "initramfs.cpio.lz4");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
