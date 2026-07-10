import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  normalizeCliHostPath,
  parseMountSpec,
} from "../src/cli/mount-spec.ts";

let cygpathAvailable: boolean | null = null;

/** Whether a real `cygpath` binary can actually be invoked in this environment. */
function hasRealCygpath(): boolean {
  if (cygpathAvailable !== null) return cygpathAvailable;
  try {
    execFileSync("cygpath", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    cygpathAvailable = true;
  } catch {
    cygpathAvailable = false;
  }
  return cygpathAvailable;
}

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
  // The mocked return value below is not an arbitrary guess: it's the
  // verified real output of `cygpath -u -p` for this exact input (checked
  // against a real cygpath.exe via execFileSync). An earlier version of this
  // fixture used a path nested under a typical Git-for-Windows install root
  // (C:\Program Files\Git\workspace), which coincidentally collapses to just
  // `/workspace` on machines where that's cygpath's own POSIX root mount -
  // a misleading, environment-dependent "realistic-looking" value. This one
  // (a path under a user's home directory) doesn't have that collision.
  const calls: string[][] = [];
  const parsed = parseMountSpec(
    "C:\\CodeBlocks\\gondolin\\demo;C:\\Users\\Test User\\my workspace;ro",
    {
      platform: "win32",
      env: { MSYSTEM: "MINGW64" } as NodeJS.ProcessEnv,
      runCygpath(args) {
        calls.push(args);
        assert.deepEqual(args, [
          "-u",
          "-p",
          "C:\\CodeBlocks\\gondolin\\demo;C:\\Users\\Test User\\my workspace;ro",
        ]);
        return "/c/CodeBlocks/gondolin/demo:/c/Users/Test User/my workspace:ro";
      },
    },
  );

  assert.deepEqual(parsed, {
    hostPath: "C:/CodeBlocks/gondolin/demo",
    guestPath: "/c/Users/Test User/my workspace",
    readonly: true,
  });
  assert.equal(calls.length, 1);
});

test(
  "parseMountSpec recovers Git Bash path-list specs via a real cygpath binary",
  { skip: !hasRealCygpath() },
  () => {
    // Same scenario as above, but exercising defaultRunCygpath's real
    // `execFileSync("cygpath", ...)` call end-to-end (no runCygpath mock),
    // so a real change in cygpath's output format would actually be caught.
    const parsed = parseMountSpec(
      "C:\\CodeBlocks\\gondolin\\demo;C:\\Users\\Test User\\my workspace;ro",
      {
        platform: "win32",
        env: { MSYSTEM: "MINGW64" } as NodeJS.ProcessEnv,
      },
    );

    assert.equal(parsed.readonly, true);
    // cygpath's own POSIX root mount can vary by installation, so assert on
    // structure rather than the exact string: both paths were recovered
    // (not left semicolon-joined), stayed absolute, and kept the embedded
    // space intact.
    assert.ok(!parsed.hostPath.includes(";"));
    assert.ok(!parsed.guestPath.includes(";"));
    assert.match(parsed.guestPath, /Test User.my workspace$/);
  },
);

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
