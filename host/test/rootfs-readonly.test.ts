/**
 * rootfs.mode "readonly" boots: the guest's init cannot create anything on
 * the root filesystem, so images carry their mount points and the resolver
 * configuration lives on /run. Mounts at paths the image lacks fail with an
 * error saying why instead of stopping the guest.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test as alpineBuild } from "../src/build/alpine.ts";
import { VM } from "../src/vm/core.ts";
import { MemoryProvider } from "../src/vfs/node/index.ts";
import { scheduleForceExit, shouldSkipVmTests } from "./helpers/vm-fixture.ts";

const skip = shouldSkipVmTests()
  ? "hardware virtualization unavailable"
  : false;
const timeout = Number(process.env.WS_TIMEOUT ?? 120000);

test.after(() => scheduleForceExit());

test("readonly root: the guest boots with mounts, scratch space and DNS", {
  skip,
  timeout,
}, async () => {
  const vm = await VM.create({
    rootfs: { mode: "readonly" },
    vfs: { mounts: { "/tmp/ws": new MemoryProvider() } },
  });
  try {
    const r = await vm.exec([
      "/bin/sh",
      "-c",
      [
        "touch /written-to-root 2>/dev/null && echo root-writable || echo root-readonly",
        "touch /tmp/scratch && echo tmp-ok",
        "echo hi > /tmp/ws/f && cat /tmp/ws/f",
        "grep -c '^nameserver' /etc/resolv.conf",
        "getent ahostsv4 example.com > /dev/null && echo dns-ok",
      ].join("; "),
    ]);
    const out = String(r.stdout);
    const [root, tmp, mount, nameservers, dns] = out.trim().split("\n");
    assert.equal(root, "root-readonly", out);
    assert.equal(tmp, "tmp-ok", out);
    assert.equal(mount, "hi", out);
    assert.ok(Number(nameservers) >= 1, `no resolver: ${out}`);
    assert.equal(dns, "dns-ok", out + String(r.stderr));
  } finally {
    await vm.close();
  }
});

test("readonly root: a mount point the image lacks is a clear error", {
  skip,
  timeout,
}, async () => {
  await assert.rejects(async () => {
    const vm = await VM.create({
      rootfs: { mode: "readonly" },
      vfs: { mounts: { "/no-such-dir-in-image": new MemoryProvider() } },
    });
    try {
      await vm.exec(["true"]);
    } finally {
      await vm.close();
    }
  }, /cannot create the mount point \/no-such-dir-in-image: the root filesystem is read-only/);
});

test("image build: guest mount points and resolv.conf on /run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-mountpoints-"));
  try {
    fs.mkdirSync(path.join(root, "usr/share/udhcpc"), { recursive: true });
    fs.writeFileSync(path.join(root, "usr/share/udhcpc/default.script"), "");
    fs.mkdirSync(path.join(root, "etc/udhcpc"), { recursive: true });
    fs.writeFileSync(path.join(root, "etc/udhcpc/udhcpc.conf"), "# defaults");
    alpineBuild.ensureGuestMountPoints(root);
    assert.match(
      fs.readFileSync(path.join(root, "etc/udhcpc/udhcpc.conf"), "utf8"),
      /^# defaults\n# gondolin: .*\nRESOLV_CONF="\/run\/resolv.conf"\n$/,
    );
    for (const dir of ["data", "etc/gondolin/mitm", "tmp", "root", "var/tmp"]) {
      assert.ok(fs.statSync(path.join(root, dir)).isDirectory(), dir);
    }
    assert.equal(
      fs.readlinkSync(path.join(root, "etc/resolv.conf")),
      "/run/resolv.conf",
    );

    // an image's own resolv.conf (OCI rootfs) is left alone
    const oci = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-mountpoints-"));
    fs.mkdirSync(path.join(oci, "etc"));
    fs.writeFileSync(path.join(oci, "etc/resolv.conf"), "nameserver 1.1.1.1\n");
    alpineBuild.ensureGuestMountPoints(oci);
    assert.equal(
      fs.readFileSync(path.join(oci, "etc/resolv.conf"), "utf8"),
      "nameserver 1.1.1.1\n",
    );
    fs.rmSync(oci, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
