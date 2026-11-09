import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VmCheckpoint } from "../src/checkpoint.ts";

import { VM } from "../src/vm/core.ts";
import {
  assertRemoteConfigure,
  buildNativeConfigure,
} from "../src/native/config.ts";
import { resolveRemoteSandboxOptions } from "../src/native/remote.ts";
import { shouldSkipVmTests } from "./helpers/vm-fixture.ts";

const remoteConfigured =
  process.env.GONDOLIN_NATIVE_REMOTE === "1" &&
  Boolean(process.env.GONDOLIN_NATIVE_COMMAND);

test("remote configure carries no controller-local paths", () => {
  const { resolved, image } = resolveRemoteSandboxOptions(
    {},
    { remote: true, image: "alpine-base:latest" },
  );
  const payload = buildNativeConfigure(
    resolved,
    { rootDisk: { path: "", format: "", mode: "auto" } },
    {},
    { image },
  );
  assertRemoteConfigure(payload);
  assert.equal(payload.vm.image, "alpine-base:latest");
  assert.equal(payload.vm.kernel_path, "");
  assert.equal(payload.net, undefined);

  const local = buildNativeConfigure(
    { ...resolved, kernelPath: "/tmp/vmlinuz" },
    {},
    {},
  );
  assert.throws(
    () => assertRemoteConfigure(local),
    /must not send a local path: vm.kernel_path/,
  );
  assert.throws(
    () =>
      resolveRemoteSandboxOptions(
        { rootDiskPath: "/tmp/disk.qcow2" },
        { remote: true },
      ),
    /not supported with a remote daemon: sandbox.rootDiskPath/,
  );
  assert.throws(
    () =>
      resolveRemoteSandboxOptions(
        { imagePath: { kernelPath: "/k", initrdPath: "/i", rootfsPath: "/r" } },
        { remote: true },
      ),
    /explicit asset paths/,
  );
});

test("remote session: daemon-side image, rootfs overlay and size, relayed network", {
  skip: !remoteConfigured
    ? "set GONDOLIN_NATIVE_REMOTE=1 and GONDOLIN_NATIVE_COMMAND (scripts/test-native-remote.sh)"
    : shouldSkipVmTests()
      ? "hardware virtualization unavailable"
      : false,
  timeout: 120_000,
}, async () => {
  const vm = await VM.create({
    rootfs: { mode: "cow", size: "1G" },
    sandbox: { console: "none" },
    httpHooks: {
      onRequest: () => new Response("relayed\n", { status: 200 }),
    },
  });
  try {
    await vm.start();
    assert.equal(vm.remote, true);
    assert.equal(vm.getHostPid(), null);
    const disk = await vm.exec([
      "/bin/sh",
      "-c",
      "df -k / | tail -1 | awk '{print $2}'",
    ]);
    assert.equal(disk.exitCode, 0, disk.stderr);
    assert.ok(
      Number(disk.stdout.trim()) > 900_000,
      `rootfs not grown: ${disk.stdout}`,
    );
    const net = await vm.exec([
      "/bin/sh",
      "-lc",
      "curl -fsS http://example.com/ || wget -qO- http://example.com/",
    ]);
    assert.equal(net.exitCode, 0, net.stderr);
    assert.equal(net.stdout.trim(), "relayed");
  } finally {
    await vm.close();
  }
});

test("remote session: checkpoint to a local file and resume it remotely", {
  skip: !remoteConfigured
    ? "set GONDOLIN_NATIVE_REMOTE=1 and GONDOLIN_NATIVE_COMMAND (scripts/test-native-remote.sh)"
    : shouldSkipVmTests()
      ? "hardware virtualization unavailable"
      : false,
  timeout: 180_000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-remote-ckpt-"));
  const vm = await VM.create({
    rootfs: { mode: "cow" },
    sandbox: { console: "none" },
  });
  let resumed: VM | null = null;
  try {
    const write = await vm.exec([
      "/bin/sh",
      "-c",
      "echo remote-checkpoint > /opt/marker",
    ]);
    assert.equal(write.exitCode, 0, write.stderr);
    const checkpoint = await vm.checkpoint(path.join(dir, "remote.qcow2"));
    assert.ok(fs.statSync(checkpoint.path).size > 0);
    assert.match(checkpoint.guestAssetBuildId, /^[0-9a-f-]{36}$/);
    const loaded = VmCheckpoint.load(checkpoint.path);
    resumed = (await loaded.resume({ sandbox: { console: "none" } })) as VM;
    const read = await resumed.exec(["/bin/cat", "/opt/marker"]);
    assert.equal(read.exitCode, 0, read.stderr);
    assert.equal(read.stdout, "remote-checkpoint\n");

    // checkpointing the resumed session collapses its chain onto the
    // daemon's rootfs: the new checkpoint still has what only the first one
    // held (a file the resumed session does not touch)
    const big = await resumed.exec([
      "/bin/sh",
      "-c",
      "dd if=/dev/urandom of=/srv/big bs=1M count=4 2>/dev/null && sync && md5sum /srv/big",
    ]);
    assert.equal(big.exitCode, 0, big.stderr);
    const second = await resumed.checkpoint(path.join(dir, "second.qcow2"));
    resumed = (await VmCheckpoint.load(second.path).resume({
      sandbox: { console: "none" },
    })) as VM;
    const third = await resumed.exec([
      "/bin/sh",
      "-c",
      "echo third > /opt/marker3 && sync",
    ]);
    assert.equal(third.exitCode, 0, third.stderr);
    const last = await resumed.checkpoint(path.join(dir, "third.qcow2"));
    resumed = (await VmCheckpoint.load(last.path).resume({
      sandbox: { console: "none" },
    })) as VM;
    const all = await resumed.exec([
      "/bin/sh",
      "-c",
      "cat /opt/marker /opt/marker3 && md5sum /srv/big",
    ]);
    assert.equal(all.exitCode, 0, all.stderr);
    assert.equal(all.stdout, `remote-checkpoint\nthird\n${big.stdout}`);
  } finally {
    await resumed?.close();
    await vm.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
