import fs from "fs";
import os from "os";
import path from "path";

import assert from "node:assert/strict";
import test from "node:test";

import { runPostBuildCommands } from "../src/alpine/packages";
import type { Architecture } from "../src/build/config";

function runtimeArch(): Architecture {
  if (process.arch === "arm64") return "aarch64";
  return "x86_64";
}

function writeStubCommand(binDir: string, name: string, body: string): void {
  const commandPath = path.join(binDir, name);
  fs.writeFileSync(commandPath, `#!/bin/sh\nset -eu\n${body}\n`, {
    mode: 0o755,
  });
}

test("postBuild: mounts procfs before running chroot commands", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-postbuild-"));
  const rootfsDir = path.join(tmp, "rootfs");
  const binDir = path.join(tmp, "bin");
  const callLog = path.join(tmp, "calls.log");

  fs.mkdirSync(path.join(rootfsDir, "bin"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(rootfsDir, "bin", "sh"), "#!/bin/sh\n", {
    mode: 0o755,
  });

  writeStubCommand(binDir, "mount", 'printf "mount %s\\n" "$*" >> "$CALL_LOG"');
  writeStubCommand(
    binDir,
    "chroot",
    'printf "chroot %s\\n" "$*" >> "$CALL_LOG"',
  );
  writeStubCommand(
    binDir,
    "umount",
    'printf "umount %s\\n" "$*" >> "$CALL_LOG"',
  );

  const oldPath = process.env.PATH;
  const oldCallLog = process.env.CALL_LOG;
  const oldGetuid = process.getuid;
  const oldPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.CALL_LOG = callLog;
    process.getuid = () => 0;
    Object.defineProperty(process, "platform", { value: "linux" });

    runPostBuildCommands(rootfsDir, ["echo hello"], runtimeArch(), () => {});

    const lines = fs
      .readFileSync(callLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);

    assert.equal(lines.length, 3);
    assert.equal(
      lines[0],
      `mount -t proc proc ${path.join(rootfsDir, "proc")}`,
    );
    assert.equal(
      lines[1],
      `chroot ${path.resolve(rootfsDir)} /bin/sh -lc echo hello`,
    );
    assert.equal(lines[2], `umount ${path.join(rootfsDir, "proc")}`);
  } finally {
    process.env.PATH = oldPath;
    process.env.CALL_LOG = oldCallLog;
    process.getuid = oldGetuid;
    if (oldPlatform) {
      Object.defineProperty(process, "platform", oldPlatform);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("postBuild: unmounts procfs even when a command fails", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-postbuild-"));
  const rootfsDir = path.join(tmp, "rootfs");
  const binDir = path.join(tmp, "bin");
  const callLog = path.join(tmp, "calls.log");

  fs.mkdirSync(path.join(rootfsDir, "bin"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(rootfsDir, "bin", "sh"), "#!/bin/sh\n", {
    mode: 0o755,
  });

  writeStubCommand(binDir, "mount", 'printf "mount %s\\n" "$*" >> "$CALL_LOG"');
  writeStubCommand(
    binDir,
    "chroot",
    'printf "chroot %s\\n" "$*" >> "$CALL_LOG"; printf "boom\\n" >&2; exit 42',
  );
  writeStubCommand(
    binDir,
    "umount",
    'printf "umount %s\\n" "$*" >> "$CALL_LOG"',
  );

  const oldPath = process.env.PATH;
  const oldCallLog = process.env.CALL_LOG;
  const oldGetuid = process.getuid;
  const oldPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.CALL_LOG = callLog;
    process.getuid = () => 0;
    Object.defineProperty(process, "platform", { value: "linux" });

    assert.throws(
      () =>
        runPostBuildCommands(
          rootfsDir,
          ["echo broken"],
          runtimeArch(),
          () => {},
        ),
      /postBuild command failed \(1\/1\): echo broken[\s\S]*exit: 42/,
    );

    const lines = fs
      .readFileSync(callLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);

    assert.equal(
      lines[0],
      `mount -t proc proc ${path.join(rootfsDir, "proc")}`,
    );
    assert.equal(lines[2], `umount ${path.join(rootfsDir, "proc")}`);
  } finally {
    process.env.PATH = oldPath;
    process.env.CALL_LOG = oldCallLog;
    process.getuid = oldGetuid;
    if (oldPlatform) {
      Object.defineProperty(process, "platform", oldPlatform);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
