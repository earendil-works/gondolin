import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQemuFamilyCandidates,
  resolveFromQemuFamilyCandidates,
} from "../src/qemu/locate-binary.ts";

test("buildQemuFamilyCandidates returns only the primary name off Windows", () => {
  const candidates = buildQemuFamilyCandidates(["qemu-img"], {
    platform: "linux",
  });
  assert.deepEqual(candidates, ["qemu-img"]);
});

test("buildQemuFamilyCandidates expands install roots on Windows for every name", () => {
  const candidates = buildQemuFamilyCandidates(
    ["qemu-system-x86_64", "qemu-system-x86_64w"],
    {
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" } as NodeJS.ProcessEnv,
    },
  );

  assert.deepEqual(candidates, [
    "qemu-system-x86_64",
    "qemu-system-x86_64.exe",
    "qemu-system-x86_64w",
    "qemu-system-x86_64w.exe",
    "C:\\Program Files\\qemu\\qemu-system-x86_64.exe",
    "C:\\Program Files\\qemu\\qemu-system-x86_64w.exe",
  ]);
});

test("resolveFromQemuFamilyCandidates skips explicit paths that don't exist and picks the first probe-passing candidate", () => {
  const resolved = resolveFromQemuFamilyCandidates(
    ["C:\\missing\\qemu-img.exe", "qemu-img", "qemu-img.exe"],
    {
      existsSync: (candidate) => candidate !== "C:\\missing\\qemu-img.exe",
      probeBinary: (candidate) => candidate === "qemu-img.exe",
    },
  );
  assert.equal(resolved, "qemu-img.exe");
});

test("resolveFromQemuFamilyCandidates falls back to the first candidate when nothing probes successfully", () => {
  const resolved = resolveFromQemuFamilyCandidates(["qemu-img", "qemu-img.exe"], {
    probeBinary: () => false,
  });
  assert.equal(resolved, "qemu-img");
});
