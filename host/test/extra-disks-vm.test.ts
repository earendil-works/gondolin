import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findE2fsprogsTool, findMke2fs } from "../src/alpine/utils.ts";
import { createDiskImage } from "../src/disk-image.ts";
import {
  closeVm,
  scheduleForceExit,
  shouldSkipVmTests,
  withVm,
} from "./helpers/vm-fixture.ts";

const timeoutMs = Number(process.env.WS_TIMEOUT ?? 60000);

function hasE2fsprogs() {
  try {
    const mke2fs = findMke2fs();
    return (
      findE2fsprogsTool(mke2fs, "debugfs") !== null &&
      findE2fsprogsTool(mke2fs, "e2fsck") !== null
    );
  } catch {
    return false;
  }
}

const skip = shouldSkipVmTests()
  ? "hardware virtualization unavailable"
  : hasE2fsprogs()
    ? false
    : "e2fsprogs unavailable";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-extra-disks-vm-"));

async function buildDisk(
  name: string,
  files: Record<string, string>,
  allowWrite = false,
) {
  const source = path.join(tmp, `${name}-src`);
  fs.mkdirSync(source);
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(source, file), content);
  }
  const image = await createDiskImage({
    sourceDir: source,
    outputPath: path.join(tmp, `${name}.ext4`),
    allowWrite,
  });
  return image.path;
}

test.after(async () => {
  await closeVm("extra-disks-mount");
  fs.rmSync(tmp, { recursive: true, force: true });
  scheduleForceExit();
});

test("extra disks with a mountPath are mounted before the first exec", {
  skip,
  timeout: timeoutMs,
}, async () => {
  const tools = await buildDisk("tools", {
    "hello.txt": "from the tools disk\n",
  });
  const scratch = await buildDisk("scratch", {}, true);

  await withVm(
    "extra-disks-mount",
    {
      sandbox: {
        console: "none",
        extraDisks: [
          { path: tools, mountPath: "/opt/tools" },
          { path: scratch, mountPath: "/tmp/scratch", readOnly: false },
        ],
      },
    },
    async (vm) => {
      const read = await vm.exec(["cat", "/opt/tools/hello.txt"]);
      assert.equal(read.exitCode, 0, read.stderr);
      assert.equal(read.stdout, "from the tools disk\n");

      const owner = await vm.exec([
        "stat",
        "-c",
        "%u:%g",
        "/opt/tools/hello.txt",
      ]);
      assert.equal(owner.stdout, "0:0\n", owner.stderr);

      const readOnly = await vm.exec(["touch", "/opt/tools/new"]);
      assert.notEqual(readOnly.exitCode, 0);
      assert.match(readOnly.stderr, /Read-only file system/);

      const mounts = await vm.exec(["cat", "/proc/mounts"]);
      assert.match(mounts.stdout, /^\/dev\/vd\S+ \/opt\/tools ext4 ro[,\s]/m);
      assert.match(mounts.stdout, /^\/dev\/vd\S+ \/tmp\/scratch ext4 rw[,\s]/m);

      const write = await vm.exec([
        "sh",
        "-c",
        "echo ok > /tmp/scratch/written && cat /tmp/scratch/written",
      ]);
      assert.equal(write.exitCode, 0, write.stderr);
      assert.equal(write.stdout, "ok\n");

      // the mount check belongs to boot, not to every exec
      const unmount = await vm.exec(["umount", "/opt/tools"]);
      assert.equal(unmount.exitCode, 0, unmount.stderr);
      const after = await vm.exec(["true"]);
      assert.equal(after.exitCode, 0, after.stderr);
    },
  );
});

test("an extra disk that cannot be mounted fails VM start with the reason", {
  skip,
  timeout: timeoutMs,
}, async () => {
  const notExt4 = path.join(tmp, "zeros.img");
  fs.writeFileSync(notExt4, Buffer.alloc(1024 * 1024));

  const { VM } = await import("../src/vm/core.ts");
  const vm = await VM.create({
    sandbox: {
      console: "none",
      extraDisks: [{ path: notExt4, mountPath: "/opt/broken" }],
    },
  });
  try {
    await assert.rejects(
      vm.start(),
      /failed to mount extra disks: extra disk gondolin-disk0: mount \/dev\/vd\S+ at \/opt\/broken failed/,
    );
  } finally {
    await vm.close();
  }
});
