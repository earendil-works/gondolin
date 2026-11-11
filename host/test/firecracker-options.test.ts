import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildNativeConfigure } from "../src/native/config.ts";
import { resolveRemoteSandboxOptions } from "../src/native/remote.ts";
import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";

/** A guest asset directory (empty files) for the host architecture. */
function makeAssetsDir(t: test.TestContext): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-fc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of [
    "vmlinuz-virt",
    "initramfs.cpio.lz4",
    "rootfs.ext4",
    "krun-kernel",
  ]) {
    fs.writeFileSync(path.join(dir, file), "");
  }
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      config: { arch, distro: "alpine", alpine: { version: "3.23.0" } },
      buildTime: new Date().toISOString(),
      assets: {
        kernel: "vmlinuz-virt",
        initramfs: "initramfs.cpio.lz4",
        rootfs: "rootfs.ext4",
        krunKernel: "krun-kernel",
      },
      checksums: { kernel: "", initramfs: "", rootfs: "", krunKernel: "" },
    }),
  );
  return dir;
}

/** Runs `fn` with `GONDOLIN_*` variables set (restored afterwards). */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAN_ENV = {
  GONDOLIN_VMM: undefined,
  GONDOLIN_FIRECRACKER: undefined,
  GONDOLIN_NITRO_MODE: undefined,
  GONDOLIN_NITRO_CPU_OVERCOMMIT: undefined,
};

test("firecracker leaves KVM or a Nitro Sandbox to the daemon by default", (t) => {
  const dir = makeAssetsDir(t);
  const resolved = withEnv(CLEAN_ENV, () =>
    resolveSandboxServerOptions({ imagePath: dir, vmm: "firecracker" }),
  );
  assert.equal(resolved.vmm, "firecracker");
  assert.equal(resolved.firecrackerPath, "firecracker");
  assert.equal(resolved.nitro, undefined);
  const payload = buildNativeConfigure(resolved, {}, {});
  assert.equal((payload.vm as Record<string, unknown>).nitro, undefined);

  // any Nitro setting selects a Nitro Sandbox, with defaults for the rest
  const nitro = withEnv(CLEAN_ENV, () =>
    resolveSandboxServerOptions({
      imagePath: dir,
      vmm: "firecracker",
      nitro: {},
    }),
  );
  assert.deepEqual(nitro.nitro, { mode: "direct", cpuOvercommit: true });
  const fromEnv = withEnv(
    { ...CLEAN_ENV, GONDOLIN_NITRO_CPU_OVERCOMMIT: "1" },
    () => resolveSandboxServerOptions({ imagePath: dir, vmm: "firecracker" }),
  );
  assert.deepEqual(fromEnv.nitro, { mode: "direct", cpuOvercommit: true });
  // `nitro: false` / GONDOLIN_NITRO_MODE=off ask for a KVM microVM
  for (const off of [
    withEnv(CLEAN_ENV, () =>
      resolveSandboxServerOptions({
        imagePath: dir,
        vmm: "firecracker",
        nitro: false,
      }),
    ),
    withEnv({ ...CLEAN_ENV, GONDOLIN_NITRO_MODE: "off" }, () =>
      resolveSandboxServerOptions({ imagePath: dir, vmm: "firecracker" }),
    ),
  ]) {
    assert.deepEqual(off.nitro, { mode: "off", cpuOvercommit: true });
    const vm = buildNativeConfigure(off, {}, {}).vm as Record<string, unknown>;
    assert.deepEqual(vm.nitro, { mode: "off", cpu_overcommit: true });
  }
  // the regular image assets, not krun's
  assert.equal(path.basename(resolved.kernelPath), "vmlinuz-virt");
  assert.equal(path.basename(resolved.initrdPath), "initramfs.cpio.lz4");
  assert.equal(resolved.qemuIdlePauseMs, undefined);
});

test("firecracker options and their environment defaults", (t) => {
  const dir = makeAssetsDir(t);
  const fromEnv = withEnv(
    {
      ...CLEAN_ENV,
      GONDOLIN_VMM: "firecracker",
      GONDOLIN_FIRECRACKER: "/opt/fc/firecracker",
      GONDOLIN_NITRO_MODE: "confidential",
      GONDOLIN_NITRO_CPU_OVERCOMMIT: "0",
    },
    () => resolveSandboxServerOptions({ imagePath: dir }),
  );
  assert.equal(fromEnv.vmm, "firecracker");
  assert.equal(fromEnv.firecrackerPath, "/opt/fc/firecracker");
  assert.deepEqual(fromEnv.nitro, {
    mode: "confidential",
    cpuOvercommit: false,
  });

  const explicit = withEnv(
    { ...CLEAN_ENV, GONDOLIN_NITRO_MODE: "confidential" },
    () =>
      resolveSandboxServerOptions({
        imagePath: dir,
        vmm: "firecracker",
        firecrackerPath: "/usr/local/bin/firecracker",
        nitro: { mode: "direct", cpuOvercommit: true },
      }),
  );
  assert.equal(explicit.firecrackerPath, "/usr/local/bin/firecracker");
  assert.deepEqual(explicit.nitro, { mode: "direct", cpuOvercommit: true });

  assert.throws(
    () =>
      withEnv({ ...CLEAN_ENV, GONDOLIN_NITRO_MODE: "fast" }, () =>
        resolveSandboxServerOptions({ imagePath: dir, vmm: "firecracker" }),
      ),
    /invalid Nitro Sandbox mode: fast/,
  );
});

test("firecracker is never selected by default", (t) => {
  const dir = makeAssetsDir(t);
  const resolved = withEnv(CLEAN_ENV, () =>
    resolveSandboxServerOptions({ imagePath: dir }),
  );
  assert.notEqual(resolved.vmm, "firecracker");
  assert.equal(resolved.nitro, undefined);
});

test("backend-specific options are rejected for other backends", (t) => {
  const dir = makeAssetsDir(t);
  withEnv(CLEAN_ENV, () => {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "firecracker",
          qemuPath: "qemu-system-x86_64",
          qemuIdlePauseMs: 1000,
        }),
      /Unsupported sandbox options for vmm=firecracker: sandbox\.qemuPath, sandbox\.qemuIdlePauseMs\. These options are only supported with vmm=qemu/,
    );
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "qemu",
          nitro: { mode: "direct" },
        }),
      /Unsupported sandbox option for vmm=qemu: sandbox\.nitro\. These options are only supported with vmm=firecracker/,
    );
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "krun",
          firecrackerPath: "/bin/firecracker",
        }),
      /for vmm=krun: sandbox\.firecrackerPath/,
    );
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "kvmtool" as never,
        }),
      /expected "qemu", "krun" or "firecracker"/,
    );
  });
});

test("the configure payload carries the firecracker settings", (t) => {
  const dir = makeAssetsDir(t);
  const resolved = withEnv(CLEAN_ENV, () =>
    resolveSandboxServerOptions({
      imagePath: dir,
      vmm: "firecracker",
      firecrackerPath: "/usr/local/bin/firecracker",
      nitro: { cpuOvercommit: false },
      cpus: 2,
    }),
  );
  const payload = buildNativeConfigure(
    resolved,
    { rootDisk: { path: resolved.rootfsPath, format: "raw", mode: "auto" } },
    {},
  );
  const vm = payload.vm as Record<string, unknown>;
  assert.equal(vm.vmm, "firecracker");
  assert.equal(vm.firecracker_path, "/usr/local/bin/firecracker");
  assert.deepEqual(vm.nitro, { mode: "direct", cpu_overcommit: false });
  assert.equal(vm.qemu_path, "");
  assert.equal(vm.krun_runner_path, undefined);
  assert.equal(vm.idle_pause_ms, undefined);

  // other backends send neither
  const qemu = withEnv(CLEAN_ENV, () =>
    resolveSandboxServerOptions({ imagePath: dir, vmm: "qemu" }),
  );
  const qemuVm = buildNativeConfigure(qemu, {}, {}).vm as Record<
    string,
    unknown
  >;
  assert.equal(qemuVm.firecracker_path, undefined);
  assert.equal(qemuVm.nitro, undefined);
});

test("remote sessions send only an explicit firecracker path", () => {
  withEnv(
    { ...CLEAN_ENV, GONDOLIN_FIRECRACKER: "/controller/firecracker" },
    () => {
      const implicit = resolveRemoteSandboxOptions(
        { vmm: "firecracker" },
        { remote: true, image: "alpine-base:latest" },
      );
      assert.equal(implicit.resolved.firecrackerPath, "");
      const payload = buildNativeConfigure(
        implicit.resolved,
        { rootDisk: { path: "", format: "", mode: "auto" } },
        {},
        { image: implicit.image },
      );
      const vm = payload.vm as Record<string, unknown>;
      assert.equal(vm.vmm, "firecracker");
      assert.equal(vm.firecracker_path, undefined);
      assert.equal(vm.nitro, undefined);

      const explicit = resolveRemoteSandboxOptions(
        { vmm: "firecracker", firecrackerPath: "/daemon/firecracker" },
        { remote: true, image: "" },
      );
      assert.equal(explicit.resolved.firecrackerPath, "/daemon/firecracker");
    },
  );
});
