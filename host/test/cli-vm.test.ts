import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VM } from "../src/vm/core.ts";
import {
  scheduleForceExit,
  shouldSkipVmTests,
  skipOnFirecracker,
} from "./helpers/vm-fixture.ts";

/**
 * The CLI with real VMs.
 */

const hostDir = path.join(import.meta.dirname, "..");
const skip = shouldSkipVmTests()
  ? "hardware virtualization unavailable"
  : false;
const timeout = 120_000;

test.after(() => {
  scheduleForceExit();
});

function runCli(
  args: string[],
  timeoutMs = 90_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/gondolin.ts", ...args], {
      cwd: hostDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("cli: exec runs commands in a fresh VM", { skip, timeout }, async () => {
  const result = await runCli([
    "exec",
    "--",
    "/bin/sh",
    "-c",
    "echo out; echo err >&2; exit 4",
  ]);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout, "out\n");
  assert.match(result.stderr, /err/);
});

test("cli: bash runs a command on a pty and returns its exit code", {
  skip,
  timeout,
}, async () => {
  const result = await runCli([
    "bash",
    "--",
    "/bin/sh",
    "-c",
    "echo BASH-OK; exit 3",
  ]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /BASH-OK/);
});

test("cli: bash --listen enables ingress", { skip, timeout }, async () => {
  const result = await runCli([
    "bash",
    "--listen",
    "127.0.0.1:0",
    "--",
    "/bin/sh",
    "-c",
    "echo LISTEN-OK",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ingress enabled: http:\/\/127\.0\.0\.1:\d+/);
  assert.match(result.stdout, /LISTEN-OK/);
});

test("cli: --native-command selects the daemon", {
  skip,
  timeout,
}, async () => {
  const result = await runCli([
    "--native-command",
    "/nonexistent/gondolind",
    "exec",
    "--",
    "/bin/true",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gondolind failed to start/);
});

test("cli: list, exec --sock, attach and snapshot/resume a running session", {
  skip: skip || skipOnFirecracker("snapshots"),
  timeout: 240_000,
}, async () => {
  const label = `cli-vm-test-${randomUUID()}`;
  const vm = await VM.create({
    sessionLabel: label,
    sandbox: { console: "none" },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-vm-"));
  try {
    await vm.start();
    const marker = await vm.exec([
      "/bin/sh",
      "-c",
      "echo persisted > /opt/cli-marker; sync",
    ]);
    assert.equal(marker.exitCode, 0, marker.stderr);

    const list = await runCli(["list"]);
    assert.equal(list.status, 0, list.stderr);
    assert.ok(list.stdout.includes(label), list.stdout);
    assert.ok(list.stdout.includes(vm.id), list.stdout);

    const sock = await runCli([
      "exec",
      "--sock",
      vm.id,
      "--",
      "/bin/echo",
      "SOCK-OK",
    ]);
    assert.equal(sock.status, 0, sock.stderr);
    assert.equal(sock.stdout, "SOCK-OK\n");

    const attach = await runCli([
      "attach",
      vm.id,
      "--",
      "/bin/sh",
      "-c",
      "echo ATTACH-OK",
    ]);
    assert.equal(attach.status, 0, attach.stderr);
    assert.match(attach.stdout, /ATTACH-OK/);

    const checkpoint = path.join(dir, "cli.qcow2");
    const snapshot = await runCli(["snapshot", vm.id, "--output", checkpoint]);
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.match(snapshot.stdout, /Snapshot created/);
    assert.ok(fs.existsSync(checkpoint));

    const resumed = await runCli([
      "bash",
      "--resume",
      checkpoint,
      "--",
      "/bin/cat",
      "/opt/cli-marker",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /persisted/);
  } finally {
    await vm.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
