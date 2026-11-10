import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INITRAMFS_INIT_SCRIPT,
  ROOTFS_INIT_SCRIPT,
} from "../src/alpine/init-scripts.ts";
import { DEFAULT_GUEST_TMPFS, buildTmpfsAppend } from "../src/sandbox/tmpfs.ts";

test("rootfs init uses current uv system certificates environment variable", () => {
  assert.match(ROOTFS_INIT_SCRIPT, /export UV_SYSTEM_CERTS=true/);
  assert.doesNotMatch(ROOTFS_INIT_SCRIPT, /UV_NATIVE_TLS/);
});

test("rootfs init creates standard /dev symlinks idempotently", (t) => {
  const start = ROOTFS_INIT_SCRIPT.indexOf("for dev_link in");
  const end = ROOTFS_INIT_SCRIPT.indexOf("done\n", start) + "done\n".length;
  assert.ok(start >= 0 && end > start);

  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-dev-"));
  t.after(() => fs.rmSync(devDir, { recursive: true, force: true }));
  // pre-existing entries must be left alone
  fs.writeFileSync(path.join(devDir, "stdout"), "");

  const snippet = ROOTFS_INIT_SCRIPT.slice(start, end).replaceAll(
    '"/dev/',
    `"${devDir}/`,
  );
  execFileSync("sh", ["-euc", `log() { :; }\n${snippet}`]);

  assert.equal(fs.readlinkSync(path.join(devDir, "fd")), "/proc/self/fd");
  assert.equal(fs.readlinkSync(path.join(devDir, "stdin")), "/proc/self/fd/0");
  assert.equal(fs.readlinkSync(path.join(devDir, "stderr")), "/proc/self/fd/2");
  assert.ok(!fs.lstatSync(path.join(devDir, "stdout")).isSymbolicLink());

  // running again is a no-op
  execFileSync("sh", ["-euc", `log() { :; }\n${snippet}`]);
});

function runSandboxfsBindSnippet(
  t: test.TestContext,
  options: { bindsFile?: string; cmdlineBinds?: string },
): string[] {
  const start = ROOTFS_INIT_SCRIPT.indexOf(
    'if [ ! -f "${sandboxfs_binds_file}" ]',
  );
  const endMarker = 'done < "${sandboxfs_binds_file}"\n    fi\n';
  const end = ROOTFS_INIT_SCRIPT.indexOf(endMarker, start) + endMarker.length;
  assert.ok(start >= 0 && end > start);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-binds-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bindsFile = path.join(dir, "binds");
  if (options.bindsFile !== undefined) {
    fs.writeFileSync(bindsFile, options.bindsFile);
  }

  const output = execFileSync(
    "sh",
    [
      "-euc",
      [
        "log() { :; }",
        "mkdir() { :; }",
        'log_cmd() { printf "%s|%s\\n" "$3" "$4"; }',
        'sandboxfs_mount="/data"',
        'sandboxfs_binds="$1"',
        'sandboxfs_binds_file="$2"',
        ROOTFS_INIT_SCRIPT.slice(start, end),
      ].join("\n"),
      "sh",
      options.cmdlineBinds ?? "",
      bindsFile,
    ],
    { encoding: "utf8" },
  );
  return output.split("\n").filter((line) => line.length > 0);
}

test("rootfs init binds sandboxfs mounts from the binds file", (t) => {
  // the cmdline list is ignored when sandboxfs wrote the file
  const binds = runSandboxfsBindSnippet(t, {
    bindsFile: "/etc/gondolin/mitm\n/with space\n/with,comma\n",
    cmdlineBinds: "/stale",
  });
  assert.deepEqual(binds, [
    "/data/etc/gondolin/mitm|/etc/gondolin/mitm",
    "/data/with space|/with space",
    "/data/with,comma|/with,comma",
  ]);
});

test("rootfs init falls back to cmdline sandboxfs binds", (t) => {
  const binds = runSandboxfsBindSnippet(t, {
    cmdlineBinds: "/etc/gondolin/mitm,/workspace",
  });
  assert.deepEqual(binds, [
    "/data/etc/gondolin/mitm|/etc/gondolin/mitm",
    "/data/workspace|/workspace",
  ]);
});

test("rootfs init passes the binds file to sandboxfs", () => {
  assert.match(
    ROOTFS_INIT_SCRIPT,
    /\/usr\/bin\/sandboxfs .*--binds-file "\$\{sandboxfs_binds_file\}"/,
  );
});

function runTmpfsSnippet(cmdlineTmpfs?: string): string[] {
  const defaultMatch = ROOTFS_INIT_SCRIPT.match(/^gondolin_tmpfs="([^"]*)"$/m);
  assert.ok(defaultMatch);
  const start = ROOTFS_INIT_SCRIPT.indexOf("mount_tmpfs_entry() {");
  const end = ROOTFS_INIT_SCRIPT.indexOf("\nexport HOME=/root", start);
  assert.ok(start >= 0 && end > start);

  const output = execFileSync(
    "sh",
    [
      "-euc",
      [
        "log() { :; }",
        "mkdir() { :; }",
        'mount() { printf "%s\\n" "$*"; }',
        `gondolin_tmpfs="${defaultMatch[1]}"`,
        'if [ "$#" -gt 0 ]; then gondolin_tmpfs="$1"; fi',
        ROOTFS_INIT_SCRIPT.slice(start, end),
      ].join("\n"),
      "sh",
      ...(cmdlineTmpfs === undefined ? [] : [cmdlineTmpfs]),
    ],
    { encoding: "utf8" },
  );
  return output.split("\n").filter((line) => line.length > 0);
}

test("rootfs init mounts the built-in tmpfs set by default", () => {
  assert.deepEqual(runTmpfsSnippet(), [
    "-t tmpfs -o mode=0700 tmpfs /root",
    "-t tmpfs tmpfs /tmp",
    "-t tmpfs tmpfs /var/cache",
    "-t tmpfs tmpfs /var/log",
    "-t tmpfs tmpfs /var/tmp",
  ]);
});

test("rootfs init built-in tmpfs set matches DEFAULT_GUEST_TMPFS", () => {
  assert.match(
    ROOTFS_INIT_SCRIPT,
    new RegExp(
      `^gondolin_tmpfs="${buildTmpfsAppend({ ...DEFAULT_GUEST_TMPFS }).slice("gondolin.tmpfs=".length)}"$`,
      "m",
    ),
  );
});

test("rootfs init mounts tmpfs entries from the cmdline", () => {
  assert.deepEqual(runTmpfsSnippet("/tmp:size=256m:mode=1777,/scratch"), [
    "-t tmpfs -o size=256m,mode=1777 tmpfs /tmp",
    "-t tmpfs tmpfs /scratch",
  ]);
  assert.deepEqual(runTmpfsSnippet("none"), []);
});

test("rootfs init does not hardcode application env vars", () => {
  assert.doesNotMatch(ROOTFS_INIT_SCRIPT, /XDG_(CACHE|CONFIG|DATA)_HOME/);
  assert.doesNotMatch(ROOTFS_INIT_SCRIPT, /UV_CACHE_DIR/);
});

/** Run a script's kernel cmdline loop against `cmdline` and print `gondolin_vsock`. */
function parseVsockFlag(
  t: test.TestContext,
  script: string,
  cmdline: string,
): string {
  const start = script.indexOf("  for arg in $(cat /proc/cmdline); do");
  const endMarker = "\n  done\n";
  const end = script.indexOf(endMarker, start) + endMarker.length;
  assert.ok(start >= 0 && end > start);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cmdline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cmdlineFile = path.join(dir, "cmdline");
  fs.writeFileSync(cmdlineFile, `${cmdline}\n`);

  return execFileSync(
    "sh",
    [
      "-euc",
      [
        "gondolin_vsock=0",
        script.slice(start, end).replace("/proc/cmdline", cmdlineFile),
        'printf "%s" "${gondolin_vsock}"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
}

for (const [name, script] of [
  ["rootfs", ROOTFS_INIT_SCRIPT],
  ["initramfs", INITRAMFS_INIT_SCRIPT],
] as const) {
  test(`${name} init parses gondolin.vsock like the guest helpers`, (t) => {
    const cases: [string, string][] = [
      ["console=ttyS0 initramfs_async=1", "0"],
      ["console=ttyS0 gondolin.vsock", "1"],
      ["gondolin.vsock=1 root=/dev/vda", "1"],
      ["gondolin.vsock=on", "1"],
      ["gondolin.vsock=0", "0"],
      ["gondolin.vsock=OFF", "0"],
      ["gondolin.vsock gondolin.vsock=no", "0"],
      ["gondolin.vsock=false gondolin.vsock", "1"],
      ["gondolin.vsockport=5", "0"],
    ];
    for (const [cmdline, expected] of cases) {
      assert.equal(parseVsockFlag(t, script, cmdline), expected, cmdline);
    }
  });
}

test("initramfs waits for virtio-serial ports only without gondolin.vsock", () => {
  const start = INITRAMFS_INIT_SCRIPT.indexOf(
    'if [ "${gondolin_vsock}" = 1 ]; then',
  );
  const endMarker = '  log "[initramfs] virtio ports not ready"\nfi\n';
  const end =
    INITRAMFS_INIT_SCRIPT.indexOf(endMarker, start) + endMarker.length;
  assert.ok(start >= 0 && end > start);

  const run = (vsock: string) =>
    execFileSync(
      "sh",
      [
        "-euc",
        [
          "log() { :; }",
          "wait_for_virtio_ports() { echo waited; }",
          `gondolin_vsock=${vsock}`,
          INITRAMFS_INIT_SCRIPT.slice(start, end),
        ].join("\n"),
      ],
      { encoding: "utf8" },
    ).trim();
  assert.equal(run("0"), "waited");
  assert.equal(run("1"), "");
});

test("rootfs init loads the vsock transport only with gondolin.vsock", () => {
  assert.match(
    ROOTFS_INIT_SCRIPT,
    /if \[ "\$\{gondolin_vsock\}" = 1 \]; then\n(?: {2}#.*\n)? {2}if modprobe vmw_vsock_virtio_transport /,
  );
  // before the helpers that open the host channels start
  const modprobe = ROOTFS_INIT_SCRIPT.indexOf(
    "modprobe vmw_vsock_virtio_transport",
  );
  for (const helper of [
    "/usr/bin/sandboxfs --mount",
    "/usr/bin/sandboxssh",
    "exec /usr/bin/sandboxd",
  ]) {
    const at = ROOTFS_INIT_SCRIPT.indexOf(helper);
    assert.ok(at > modprobe, helper);
  }
});
