import fs from "fs";
import os from "os";
import path from "path";

import assert from "node:assert/strict";
import test from "node:test";

import { createRootfsImage } from "../src/alpine/utils.ts";
import type { RootfsOwnershipEntry } from "../src/alpine/types.ts";

function writeStubCommand(binDir: string, name: string, body: string): string {
  const commandPath = path.join(binDir, name);
  fs.writeFileSync(commandPath, `#!/bin/sh\nset -eu\n${body}\n`, {
    mode: 0o755,
  });
  return commandPath;
}

const skipWindowsRootfsOwnershipTest =
  process.platform === "win32"
    ? "rootfs ownership tests require POSIX shell/ext4 tool semantics"
    : false;

test(
  "rootfs image: applies OCI ownership metadata with debugfs for non-root builds",
  { skip: skipWindowsRootfsOwnershipTest },
  () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-rootfs-owners-"));
  const binDir = path.join(tmp, "bin");
  const rootfsDir = path.join(tmp, "rootfs");
  const imagePath = path.join(tmp, "rootfs.ext4");
  const debugfsLog = path.join(tmp, "debugfs-commands.txt");
  const mkfsLog = path.join(tmp, "mkfs.log");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(rootfsDir, "etc"), { recursive: true });
  fs.writeFileSync(path.join(rootfsDir, "etc", "test"), "test\n");
  fs.writeFileSync(path.join(rootfsDir, "etc", "test space"), "test\n");
  fs.writeFileSync(path.join(rootfsDir, "etc", "same-owner"), "test\n");

  const mke2fsPath = writeStubCommand(
    binDir,
    "mke2fs",
    [
      'printf "%s\\n" "$*" > "$MKFS_LOG"',
      'img=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-F" ]; then',
      '    shift',
      '    img="${1:-}"',
      '    break',
      '  fi',
      '  shift || true',
      'done',
      '[ -n "$img" ]',
      ': > "$img"',
    ].join("\n"),
  );

  writeStubCommand(
    binDir,
    "debugfs",
    [
      'if [ "${1:-}" = "-V" ]; then',
      '  printf "debugfs fake 1.0\\n"',
      '  exit 0',
      'fi',
      'cmd_file=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-f" ]; then',
      '    shift',
      '    cmd_file="${1:-}"',
      '  fi',
      '  shift || true',
      'done',
      '[ -n "$cmd_file" ]',
      'cp "$cmd_file" "$DEBUGFS_LOG"',
    ].join("\n"),
  );

  const st = fs.lstatSync(path.join(rootfsDir, "etc", "same-owner"));

  const ownershipEntries: RootfsOwnershipEntry[] = [
    { path: "etc/test", uid: 0, gid: 0 },
    { path: "etc/test space", uid: 0, gid: 0 },
    { path: "etc/same-owner", uid: st.uid, gid: st.gid },
    { path: "etc/does-not-exist", uid: 0, gid: 0 },
  ];

  const oldGetuid = process.getuid;
  const oldDebugfsLog = process.env.DEBUGFS_LOG;
  const oldMkfsLog = process.env.MKFS_LOG;

  try {
    process.getuid = () => 12345;
    process.env.DEBUGFS_LOG = debugfsLog;
    process.env.MKFS_LOG = mkfsLog;

    createRootfsImage(
      mke2fsPath,
      imagePath,
      rootfsDir,
      "gondolin-root",
      16,
      ownershipEntries,
    );

    assert.equal(fs.existsSync(imagePath), true);
    assert.equal(fs.existsSync(mkfsLog), true);
    assert.equal(fs.existsSync(debugfsLog), true);

    const debugfsCommands = fs.readFileSync(debugfsLog, "utf8");
    assert.match(debugfsCommands, /sif "\/etc\/test" uid 0/);
    assert.match(debugfsCommands, /sif "\/etc\/test" gid 0/);
    assert.match(debugfsCommands, /sif "\/etc\/test space" uid 0/);
    assert.match(debugfsCommands, /sif "\/etc\/test space" gid 0/);
    assert.equal(debugfsCommands.includes("same-owner"), false);
    assert.equal(debugfsCommands.includes("does-not-exist"), false);
  } finally {
    process.getuid = oldGetuid;
    if (oldDebugfsLog === undefined) {
      delete process.env.DEBUGFS_LOG;
    } else {
      process.env.DEBUGFS_LOG = oldDebugfsLog;
    }
    if (oldMkfsLog === undefined) {
      delete process.env.MKFS_LOG;
    } else {
      process.env.MKFS_LOG = oldMkfsLog;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
},
);
