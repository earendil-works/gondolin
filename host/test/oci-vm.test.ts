import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildAssets } from "../src/build";
import {
  getDefaultArch,
  type BuildConfig,
  type ContainerRuntime,
} from "../src/build/config";
import { VM } from "../src/vm/core";
import { scheduleForceExit, shouldSkipVmTests } from "./helpers/vm-fixture";

function detectOciRuntime(): ContainerRuntime | null {
  for (const runtime of ["docker", "podman"] as const) {
    try {
      execFileSync(runtime, ["info"], { stdio: "ignore" });
      return runtime;
    } catch {
      // Try next runtime.
    }
  }
  return null;
}

function hasGuestBinaries(): boolean {
  const candidates = [
    path.resolve(process.cwd(), "..", "guest", "zig-out", "bin"),
    path.resolve(__dirname, "..", "..", "guest", "zig-out", "bin"),
  ];

  for (const binDir of candidates) {
    const required = ["sandboxd", "sandboxfs", "sandboxssh", "sandboxingress"];
    if (required.every((name) => fs.existsSync(path.join(binDir, name)))) {
      return true;
    }
  }

  return false;
}

const runtime = detectOciRuntime();
const vmSkipReason = shouldSkipVmTests()
  ? "hardware virtualization unavailable"
  : !runtime
    ? "docker or podman runtime unavailable"
    : !hasGuestBinaries()
      ? "guest zig-out binaries missing (run make build first)"
      : false;

const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);

function makeOciConfig(image: string): BuildConfig {
  return {
    arch: getDefaultArch(),
    distro: "alpine",
    alpine: {
      version: "3.23.0",
    },
    oci: {
      image,
      runtime: runtime ?? undefined,
      pullPolicy: "if-not-present",
    },
    rootfs: {
      label: "gondolin-root",
    },
  };
}

test.after(() => {
  scheduleForceExit();
});

test(
  "oci vm: debian rootfs boots and records resolved digest",
  { skip: vmSkipReason, timeout: timeoutMs },
  async (t) => {
    const outputDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gondolin-oci-debian-vm-"),
    );
    t.after(() => {
      fs.rmSync(outputDir, { recursive: true, force: true });
    });

    const result = await buildAssets(
      makeOciConfig("docker.io/library/debian:bookworm-slim"),
      {
        outputDir,
        verbose: false,
        skipBinaries: true,
      },
    );

    assert.ok(
      result.manifest.ociSource,
      "expected oci source metadata in manifest",
    );
    assert.match(
      result.manifest.ociSource?.digest ?? "",
      /^sha256:[a-f0-9]{64}$/,
    );

    const vm = await VM.create({
      sandbox: {
        imagePath: outputDir,
        console: "none",
      },
    });

    t.after(async () => {
      await vm.close();
    });

    const smoke = await vm.exec("cat /etc/os-release | head -n 1");
    assert.equal(smoke.exitCode, 0);
    assert.match(smoke.stdout, /Debian GNU\/Linux/i);
  },
);

test(
  "oci vm: distroless rootfs boots via busybox shell bootstrap",
  { skip: vmSkipReason, timeout: timeoutMs },
  async (t) => {
    const outputDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gondolin-oci-distroless-vm-"),
    );
    t.after(() => {
      fs.rmSync(outputDir, { recursive: true, force: true });
    });

    const result = await buildAssets(
      makeOciConfig("gcr.io/distroless/nodejs24-debian12"),
      {
        outputDir,
        verbose: false,
        skipBinaries: true,
      },
    );

    assert.ok(
      result.manifest.ociSource,
      "expected oci source metadata in manifest",
    );
    assert.match(
      result.manifest.ociSource?.digest ?? "",
      /^sha256:[a-f0-9]{64}$/,
    );

    const vm = await VM.create({
      sandbox: {
        imagePath: outputDir,
        console: "none",
      },
    });

    t.after(async () => {
      await vm.close();
    });

    const shellSmoke = await vm.exec(
      "test -x /bin/sh && /bin/sh -lc 'echo shell-bootstrap-ok'",
    );
    assert.equal(shellSmoke.exitCode, 0);
    assert.match(shellSmoke.stdout, /shell-bootstrap-ok/);

    const nodeSmoke = await vm.exec("test -x /nodejs/bin/node && echo node-ok");
    assert.equal(nodeSmoke.exitCode, 0);
    assert.match(nodeSmoke.stdout, /node-ok/);
  },
);
