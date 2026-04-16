import assert from "node:assert/strict";
import test from "node:test";

import { __test as qemuImgTest } from "../src/qemu/img.ts";

test("resolveQemuImgPath prefers the configured qemu binary directory", () => {
  const qemuImgPath = "D:\\Portable\\qemu\\qemu-img.exe";
  const resolved = qemuImgTest.resolveQemuImgPath({
    platform: "win32",
    qemuPath: "D:\\Portable\\qemu\\qemu-system-x86_64w.exe",
    env: { ProgramFiles: "C:\\Program Files" } as NodeJS.ProcessEnv,
    existsSync: (candidate: string) => candidate === qemuImgPath,
    probeQemuImg: (candidate: string) => candidate === qemuImgPath,
  });

  assert.equal(resolved, qemuImgPath);
});

test("resolveQemuImgPath falls back to Program Files install on Windows", () => {
  const qemuImgPath = "C:\\Program Files\\qemu\\qemu-img.exe";
  const resolved = qemuImgTest.resolveQemuImgPath({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" } as NodeJS.ProcessEnv,
    existsSync: (candidate: string) => candidate === qemuImgPath,
    probeQemuImg: (candidate: string) => candidate === qemuImgPath,
  });

  assert.equal(resolved, qemuImgPath);
});
