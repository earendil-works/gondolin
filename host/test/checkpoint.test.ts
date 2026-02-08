import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureGuestAssets, loadAssetManifest } from "../src/assets";
import { VmCheckpoint } from "../src/checkpoint";
import { getQcow2BackingFilename } from "../src/qemu-img";
import { VM } from "../src/vm";
import { shouldSkipVmTests, scheduleForceExit } from "./helpers/vm-fixture";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);

test.after(() => {
  scheduleForceExit();
});

test("disk checkpoints can be resumed (qcow2 backing)", { skip: skipVmTests, timeout: timeoutMs }, async () => {
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
    const write = await base!.exec(["/bin/sh", "-c", "echo base > /etc/checkpoint.txt"]);
    assert.equal(write.exitCode, 0);

    checkpointPath = path.join(os.tmpdir(), `gondolin-checkpoint-${Date.now()}.qcow2`);
    checkpoint = await base!.checkpoint(checkpointPath);
    base = null;

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
    const m1 = await clone1.exec(["/bin/sh", "-c", "echo clone1 > /etc/checkpoint.txt"]);
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
    fresh = await VM.create({ vfs: null, sandbox: { console: "none", netEnabled: false } });
    const r3 = await fresh.exec(["/bin/sh", "-c", "test ! -f /etc/checkpoint.txt"]);
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
});

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
      (t as any).skip?.("guest assets have no manifest buildId; checkpointing is unsupported");
      return;
    }

    const kernelName = sourceManifest.assets?.kernel ?? "vmlinuz-virt";
    const initrdName = sourceManifest.assets?.initramfs ?? "initramfs.cpio.lz4";
    const rootfsName = sourceManifest.assets?.rootfs ?? "rootfs.ext4";

    const mkAssetDir = (label: string) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gondolin-assets-${label}-`));
      fs.symlinkSync(assets.kernelPath, path.join(dir, kernelName));
      fs.symlinkSync(assets.initrdPath, path.join(dir, initrdName));
      fs.symlinkSync(assets.rootfsPath, path.join(dir, rootfsName));
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(sourceManifest, null, 2));
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

      checkpointPath = path.join(os.tmpdir(), `gondolin-checkpoint-rebase-${Date.now()}.qcow2`);
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
  }
);
