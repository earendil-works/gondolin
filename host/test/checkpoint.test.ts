import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureGuestAssets, loadAssetManifest } from "../src/assets.ts";
import { VmCheckpoint } from "../src/checkpoint.ts";
import { getQcow2BackingFilename } from "../src/qemu/img.ts";
import { VM } from "../src/vm/core.ts";
import {
  shouldSkipVmTests,
  scheduleForceExit,
  getKrunRuntimeSkipReason,
  resolveKrunRunnerPath,
} from "./helpers/vm-fixture.ts";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);

async function skipIfKrunUnavailable(t: test.TestContext): Promise<boolean> {
  const reason = await getKrunRuntimeSkipReason();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

test.after(() => {
  scheduleForceExit();
});

test(
  "disk checkpoints can be resumed (qcow2 backing)",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    let base: VM | null = null;
    let checkpoint: any = null;
    let checkpointPath: string | null = null;
    let clone1: VM | null = null;
    let clone2: VM | null = null;
    let fresh: VM | null = null;

    try {
      base = await VM.create({
        vfs: null,
        sandbox: {
          console: "none",
          netEnabled: false,
        },
      });

      // Materialize a recognizable file on the root disk.
      const write = await base!.exec([
        "/bin/sh",
        "-c",
        "echo base > /etc/checkpoint.txt",
      ]);
      assert.equal(write.exitCode, 0);

      checkpointPath = path.join(
        os.tmpdir(),
        `gondolin-checkpoint-${Date.now()}.qcow2`,
      );
      checkpoint = await base!.checkpoint(checkpointPath);
      base = null;

      const metadata = checkpoint.toJSON();
      assert.equal(metadata.snapshotKind, "disk");
      assert.equal(metadata.createdWithVmm, "qemu");
      assert.ok(metadata.compatibleVmm?.includes("qemu"));

      // Ensure checkpoints can be reloaded from disk.
      checkpoint = VmCheckpoint.load(checkpointPath);

      // Resume 1 sees the base file
      clone1 = await checkpoint.resume({
        vfs: null,
        sandbox: {
          console: "none",
          netEnabled: false,
        },
      });
      const r1 = await clone1.exec(["/bin/cat", "/etc/checkpoint.txt"]);
      assert.equal(r1.stdout.trim(), "base");

      // Modify clone 1
      const m1 = await clone1.exec([
        "/bin/sh",
        "-c",
        "echo clone1 > /etc/checkpoint.txt",
      ]);
      assert.equal(m1.exitCode, 0);
      await clone1.close();
      clone1 = null;

      // Resume 2 should not see clone1's change
      clone2 = await checkpoint.resume({
        vfs: null,
        sandbox: {
          console: "none",
          netEnabled: false,
        },
      });
      const r2 = await clone2.exec(["/bin/cat", "/etc/checkpoint.txt"]);
      assert.equal(r2.stdout.trim(), "base");
      await clone2.close();
      clone2 = null;

      // A fresh VM must not see checkpoint writes (base image stays clean)
      fresh = await VM.create({
        vfs: null,
        sandbox: { console: "none", netEnabled: false },
      });
      const r3 = await fresh.exec([
        "/bin/sh",
        "-c",
        "test ! -f /etc/checkpoint.txt",
      ]);
      assert.equal(r3.exitCode, 0);
      await fresh.close();
      fresh = null;

      checkpoint.delete();
      checkpoint = null;
    } finally {
      if (base) await base.close().catch(() => undefined);
      if (clone1) await clone1.close().catch(() => undefined);
      if (clone2) await clone2.close().catch(() => undefined);
      if (fresh) await fresh.close().catch(() => undefined);
      if (checkpoint) {
        try {
          checkpoint.delete();
        } catch {
          // ignore
        }
      }
    }
  },
);

test(
  "checkpoint overwrite after resume keeps direct rootfs backing and data",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    let base: VM | null = null;
    let checkpoint: VmCheckpoint | null = null;
    let resumed: VM | null = null;
    let resumedAgain: VM | null = null;

    const checkpointPath = path.join(
      os.tmpdir(),
      `gondolin-checkpoint-overwrite-${Date.now()}.qcow2`,
    );

    try {
      base = await VM.create({
        vfs: null,
        sandbox: {
          console: "none",
          netEnabled: false,
        },
      });

      const writeBase = await base.exec([
        "/bin/sh",
        "-c",
        "printf 'base\\n' > /etc/checkpoint-overwrite.txt",
      ]);
      assert.equal(writeBase.exitCode, 0, writeBase.stderr);

      checkpoint = await base.checkpoint(checkpointPath);
      base = null;

      resumed = await checkpoint.resume({
        vfs: null,
        sandbox: {
          console: "none",
          netEnabled: false,
        },
      });

      const append = await resumed.exec([
        "/bin/sh",
        "-c",
        "printf 'resumed\\n' >> /etc/checkpoint-overwrite.txt",
      ]);
      assert.equal(append.exitCode, 0, append.stderr);

      checkpoint = await resumed.checkpoint(checkpointPath);
      resumed = null;

      const backing = getQcow2BackingFilename(checkpointPath);
      assert.notEqual(backing, checkpointPath);
      assert.equal(path.basename(backing ?? ""), "rootfs.ext4");

      resumedAgain = await checkpoint.resume({
        vfs: null,
        sandbox: {
          console: "none",
          netEnabled: false,
        },
      });

      const read = await resumedAgain.exec([
        "/bin/cat",
        "/etc/checkpoint-overwrite.txt",
      ]);
      assert.equal(read.exitCode, 0, read.stderr);
      assert.equal(read.stdout, "base\nresumed\n");
    } finally {
      if (base) await base.close().catch(() => undefined);
      if (resumed) await resumed.close().catch(() => undefined);
      if (resumedAgain) await resumedAgain.close().catch(() => undefined);
      if (checkpoint) {
        try {
          checkpoint.delete();
        } catch {
          // ignore
        }
      }
    }
  },
);

test(
  "checkpoint resume rebases qcow2 backing to resolved rootfs",
  { skip: skipVmTests, timeout: timeoutMs },
  async (t) => {
    let base: VM | null = null;
    let checkpointPath: string | null = null;
    let checkpoint: VmCheckpoint | null = null;
    let resumed: VM | null = null;

    const assets = await ensureGuestAssets();

    const sourceDir = path.dirname(assets.kernelPath);
    const sourceManifest = loadAssetManifest(sourceDir);
    if (!sourceManifest?.buildId) {
      (t as any).skip?.(
        "guest assets have no manifest buildId; checkpointing is unsupported",
      );
      return;
    }

    const kernelName = sourceManifest.assets?.kernel ?? "vmlinuz-virt";
    const initrdName = sourceManifest.assets?.initramfs ?? "initramfs.cpio.lz4";
    const rootfsName = sourceManifest.assets?.rootfs ?? "rootfs.ext4";

    const mkAssetDir = (label: string) => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), `gondolin-assets-${label}-`),
      );
      fs.symlinkSync(assets.kernelPath, path.join(dir, kernelName));
      fs.symlinkSync(assets.initrdPath, path.join(dir, initrdName));
      fs.symlinkSync(assets.rootfsPath, path.join(dir, rootfsName));

      if (sourceManifest.assets?.krunKernel) {
        const sourceKrunKernel = path.join(
          sourceDir,
          sourceManifest.assets.krunKernel,
        );
        fs.symlinkSync(
          sourceKrunKernel,
          path.join(dir, sourceManifest.assets.krunKernel),
        );
      }

      if (sourceManifest.assets?.krunInitrd) {
        const sourceKrunInitrd = path.join(
          sourceDir,
          sourceManifest.assets.krunInitrd,
        );
        fs.symlinkSync(
          sourceKrunInitrd,
          path.join(dir, sourceManifest.assets.krunInitrd),
        );
      }

      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify(sourceManifest, null, 2),
      );
      return dir;
    };

    const dirA = mkAssetDir("a");
    const dirB = mkAssetDir("b");

    const expectedA = path.join(dirA, rootfsName);
    const expectedB = path.join(dirB, rootfsName);

    try {
      base = await VM.create({
        vfs: null,
        sandbox: {
          imagePath: dirA,
          console: "none",
          netEnabled: false,
        },
      });

      checkpointPath = path.join(
        os.tmpdir(),
        `gondolin-checkpoint-rebase-${Date.now()}.qcow2`,
      );
      checkpoint = await base.checkpoint(checkpointPath);
      base = null;

      // Validate the checkpoint initially points at dirA.
      const backing1 = getQcow2BackingFilename(checkpointPath);
      assert.equal(backing1, expectedA);

      // Resume while pointing to dirB and ensure resume updates the backing path.
      resumed = await checkpoint.resume({
        autoStart: false,
        vfs: null,
        sandbox: {
          imagePath: dirB,
          console: "none",
          netEnabled: false,
        },
      });

      const backing2 = getQcow2BackingFilename(checkpointPath);
      assert.equal(backing2, expectedB);

      await resumed.close();
      resumed = null;

      checkpoint.delete();
      checkpoint = null;
    } finally {
      if (base) await base.close().catch(() => undefined);
      if (resumed) await resumed.close().catch(() => undefined);
      if (checkpoint) {
        try {
          checkpoint.delete();
        } catch {
          // ignore
        }
      }
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  },
);

test("checkpoint resume rejects incompatible backend metadata", async () => {
  const checkpoint = new VmCheckpoint(
    path.join(os.tmpdir(), "gondolin-missing-checkpoint.qcow2"),
    {
      version: 1,
      name: "incompatible",
      createdAt: "2026-03-01T00:00:00.000Z",
      diskFile: "incompatible.qcow2",
      guestAssetBuildId: "15e98966-a559-55ee-8d57-9f4c3f0346c7",
      snapshotKind: "disk",
      createdWithVmm: "qemu",
      compatibleVmm: ["qemu"],
    },
  );

  await assert.rejects(
    () => checkpoint.resume({ sandbox: { vmm: "krun" } }),
    /checkpoint is not compatible with vmm=krun/,
  );
});

test(
  "checkpoint compatibility: qemu -> krun resume",
  { skip: skipVmTests, timeout: timeoutMs },
  async (t) => {
    if (await skipIfKrunUnavailable(t)) return;

    let base: VM | null = null;
    let resumed: VM | null = null;
    let checkpoint: VmCheckpoint | null = null;

    const checkpointPath = path.join(
      os.tmpdir(),
      `gondolin-checkpoint-qemu-to-krun-${Date.now()}.qcow2`,
    );

    try {
      base = await VM.create({
        vfs: null,
        sandbox: {
          vmm: "qemu",
          console: "none",
          netEnabled: false,
        },
      });

      const write = await base.exec([
        "/bin/sh",
        "-c",
        "echo qemu-to-krun > /etc/checkpoint-cross.txt",
      ]);
      assert.equal(write.exitCode, 0);

      checkpoint = await base.checkpoint(checkpointPath);
      base = null;

      const metadata = checkpoint.toJSON();
      if (!metadata.compatibleVmm?.includes("krun")) {
        t.skip(
          "current guest assets do not advertise krun-compatible checkpoint resume",
        );
        return;
      }

      resumed = await checkpoint.resume({
        vfs: null,
        sandbox: {
          vmm: "krun",
          krunRunnerPath: resolveKrunRunnerPath() ?? undefined,
          console: "none",
          netEnabled: false,
        },
      });

      const read = await resumed.exec([
        "/bin/cat",
        "/etc/checkpoint-cross.txt",
      ]);
      assert.equal(read.exitCode, 0, read.stderr);
      assert.equal(read.stdout.trim(), "qemu-to-krun");
    } finally {
      if (base) await base.close().catch(() => undefined);
      if (resumed) await resumed.close().catch(() => undefined);
      if (checkpoint) {
        try {
          checkpoint.delete();
        } catch {
          // ignore
        }
      }
    }
  },
);

test(
  "checkpoint compatibility: krun -> qemu resume",
  { skip: skipVmTests, timeout: timeoutMs },
  async (t) => {
    if (await skipIfKrunUnavailable(t)) return;

    let base: VM | null = null;
    let resumed: VM | null = null;
    let checkpoint: VmCheckpoint | null = null;

    const checkpointPath = path.join(
      os.tmpdir(),
      `gondolin-checkpoint-krun-to-qemu-${Date.now()}.qcow2`,
    );

    try {
      base = await VM.create({
        vfs: null,
        sandbox: {
          vmm: "krun",
          krunRunnerPath: resolveKrunRunnerPath() ?? undefined,
          console: "none",
          netEnabled: false,
        },
      });

      const write = await base.exec([
        "/bin/sh",
        "-c",
        "echo krun-to-qemu > /etc/checkpoint-cross.txt",
      ]);
      assert.equal(write.exitCode, 0);

      checkpoint = await base.checkpoint(checkpointPath);
      base = null;

      const metadata = checkpoint.toJSON();
      assert.equal(metadata.createdWithVmm, "krun");
      assert.ok(metadata.compatibleVmm?.includes("qemu"));

      resumed = await checkpoint.resume({
        vfs: null,
        sandbox: {
          vmm: "qemu",
          console: "none",
          netEnabled: false,
        },
      });

      const read = await resumed.exec([
        "/bin/cat",
        "/etc/checkpoint-cross.txt",
      ]);
      assert.equal(read.exitCode, 0, read.stderr);
      assert.equal(read.stdout.trim(), "krun-to-qemu");
    } finally {
      if (base) await base.close().catch(() => undefined);
      if (resumed) await resumed.close().catch(() => undefined);
      if (checkpoint) {
        try {
          checkpoint.delete();
        } catch {
          // ignore
        }
      }
    }
  },
);
