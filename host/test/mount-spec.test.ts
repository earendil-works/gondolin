import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCliHostPath,
  parseMountSpec,
} from "../src/cli/mount-spec.ts";

test("parseMountSpec converts raw Git Bash /c host paths on Windows", () => {
  const parsed = parseMountSpec("/c/CodeBlocks/gondolin/demo:/workspace", {
    platform: "win32",
    env: { MSYSTEM: "MINGW64" } as NodeJS.ProcessEnv,
  });

  assert.deepEqual(parsed, {
    hostPath: "C:/CodeBlocks/gondolin/demo",
    guestPath: "/workspace",
    readonly: false,
  });
});

test("parseMountSpec recovers Git Bash path-list rewritten mount specs", () => {
  const calls: string[][] = [];
  const parsed = parseMountSpec(
    "C:\\CodeBlocks\\gondolin\\demo;C:\\Program Files\\Git\\workspace;ro",
    {
      platform: "win32",
      env: { MSYSTEM: "MINGW64" } as NodeJS.ProcessEnv,
      runCygpath(args) {
        calls.push(args);
        assert.deepEqual(args, [
          "-u",
          "-p",
          "C:\\CodeBlocks\\gondolin\\demo;C:\\Program Files\\Git\\workspace;ro",
        ]);
        return "/c/CodeBlocks/gondolin/demo:/workspace:ro";
      },
    },
  );

  assert.deepEqual(parsed, {
    hostPath: "C:/CodeBlocks/gondolin/demo",
    guestPath: "/workspace",
    readonly: true,
  });
  assert.equal(calls.length, 1);
});

test("parseMountSpec preserves standard Windows mount specs", () => {
  const parsed = parseMountSpec("C:/CodeBlocks/gondolin/demo:/workspace:ro", {
    platform: "win32",
    env: {} as NodeJS.ProcessEnv,
  });

  assert.deepEqual(parsed, {
    hostPath: "C:/CodeBlocks/gondolin/demo",
    guestPath: "/workspace",
    readonly: true,
  });
});

test("normalizeCliHostPath converts Git Bash /c paths on Windows", () => {
  assert.equal(
    normalizeCliHostPath("/c/CodeBlocks/gondolin/host/showcase.qcow2", {
      platform: "win32",
      env: { MSYSTEM: "MINGW64" } as NodeJS.ProcessEnv,
    }),
    "C:/CodeBlocks/gondolin/host/showcase.qcow2",
  );
});

test("normalizeCliHostPath preserves Windows drive-root semantics for /c", () => {
  assert.equal(
    normalizeCliHostPath("/c", {
      platform: "win32",
      env: { MSYSTEM: "MINGW64" } as NodeJS.ProcessEnv,
    }),
    "C:/",
  );
});

test("normalizeCliHostPath preserves non-Windows paths", () => {
  assert.equal(
    normalizeCliHostPath("/tmp/showcase.qcow2", {
      platform: "linux",
      env: {} as NodeJS.ProcessEnv,
    }),
    "/tmp/showcase.qcow2",
  );
});
