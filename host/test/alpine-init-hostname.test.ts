import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ROOTFS_INIT_SCRIPT } from "../src/alpine/init-scripts.ts";

function hostnameSnippet(root: string): string {
  const start = ROOTFS_INIT_SCRIPT.indexOf("setup_hostname() {");
  assert.ok(start >= 0, "rootfs init must define setup_hostname");
  const end = ROOTFS_INIT_SCRIPT.indexOf("\n}\n", start) + "\n}\n".length;
  assert.ok(end > start);

  // POSIX paths: the snippet runs under sh, which treats a Windows path in a
  // double-quoted redirect as escape sequences.
  const posix = (name: string) => path.join(root, name).replaceAll("\\", "/");

  return ROOTFS_INIT_SCRIPT.slice(start, end)
    .replaceAll("/proc/sys/kernel/hostname", posix("kernel-hostname"))
    .replaceAll("/etc/hostname", posix("hostname"))
    .replaceAll("/etc/hosts", posix("hosts"));
}

test("rootfs init gives the guest a hostname that resolves locally", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-hostname-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "kernel-hostname"), "");
  fs.writeFileSync(path.join(root, "hosts"), "127.0.0.1\tlocalhost\n");

  const script = `${hostnameSnippet(root)}\nsetup_hostname\n`;
  execFileSync("sh", ["-euc", script]);

  assert.equal(
    fs.readFileSync(path.join(root, "hostname"), "utf8").trim(),
    "gondolin",
  );
  assert.equal(
    fs.readFileSync(path.join(root, "kernel-hostname"), "utf8").trim(),
    "gondolin",
  );

  const hosts = fs.readFileSync(path.join(root, "hosts"), "utf8");
  assert.match(hosts, /^127\.0\.0\.1\tgondolin$/m);
  assert.match(hosts, /^::1\tgondolin$/m);

  // Running init again must not accumulate entries.
  execFileSync("sh", ["-euc", script]);
  const again = fs.readFileSync(path.join(root, "hosts"), "utf8");
  assert.equal(again.match(/gondolin/g)?.length, 2);
});
