import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findMke2fs } from "../src/alpine/utils.ts";
import {
  closeVm,
  scheduleForceExit,
  shouldSkipVmTests,
  withVm,
} from "./helpers/vm-fixture.ts";

const timeoutMs = Number(process.env.WS_TIMEOUT ?? 60000);

function mke2fsOrNull() {
  try {
    return findMke2fs();
  } catch {
    return null;
  }
}

const mke2fs = mke2fsOrNull();
const skip = shouldSkipVmTests()
  ? "hardware virtualization unavailable"
  : mke2fs === null
    ? "mke2fs unavailable"
    : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-extra-disks-vm-"));

function buildDisk(name: string, files: Record<string, string>) {
  const source = path.join(tmp, `${name}-src`);
  fs.mkdirSync(source);
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(source, file), content);
  }
  const image = path.join(tmp, `${name}.ext4`);
  execFileSync(mke2fs!, ["-q", "-t", "ext4", "-d", source, image, "8M"], {
    stdio: "ignore",
  });
  return image;
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
  const tools = buildDisk("tools", { "hello.txt": "from the tools disk\n" });
  const scratch = buildDisk("scratch", {});

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
