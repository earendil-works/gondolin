/**
 * Parity of the Node CLI and the static native CLI: both print the native
 * engine's `configure` payload for the same arguments (`--print-configure`)
 * and must agree, apart from what differs by design (normalised below).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkoutGuestDir, resolveNativeCli } from "./helpers/native-cli.ts";

const cli = resolveNativeCli();
const guestDir = process.env.GONDOLIN_GUEST_DIR ?? checkoutGuestDir();
const skip = !cli
  ? "static gondolin CLI not built (cargo build -p gondolin-cli)"
  : !guestDir
    ? "no local guest assets (GONDOLIN_GUEST_DIR)"
    : false;

const nodeCli = path.resolve(import.meta.dirname, "..", "bin", "gondolin.ts");

type Run = { code: number; stdout: string; stderr: string };

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env, GONDOLIN_GUEST_DIR: guestDir! },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Removes what differs by design between the two CLIs */
function normalize(text: string, args: string[]): unknown {
  const out = JSON.parse(text) as any;
  const net = out.configure?.net;
  if (net) {
    // upstream trust: node's CA store vs the system/webpki roots
    delete net.upstream_ca_pems;
    delete net.use_system_roots;
    delete net.use_webpki_roots;
    // resolvers of this machine: node's dns.getServers() vs the daemon's own
    delete net.system_resolvers;
    if (!args.includes("--dns-trusted-server")) {
      delete net.stack?.dns?.trusted_servers;
    }
  }
  // the root disk overlay is a fresh temp file
  const disk = out.configure?.vm?.root_disk;
  if (disk && disk.format === "qcow2") disk.path = "<overlay>";
  let json = JSON.stringify(out);
  // random secret marker
  json = json.replace(/[0-9a-f]{48}/g, "<MARKER>");
  json = json.split(os.homedir()).join("<HOME>");
  return JSON.parse(json);
}

const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-parity-"));
const knownHosts = path.join(hostDir, "known_hosts");
fs.writeFileSync(knownHosts, "");
test.after(() => fs.rmSync(hostDir, { recursive: true, force: true }));

type Case = {
  name: string;
  args: string[];
  env?: Record<string, string>;
  /** both CLIs must fail with this message */
  error?: string;
};

const cases: Case[] = [
  { name: "exec defaults", args: ["exec", "--print-configure"] },
  {
    name: "bash defaults",
    args: ["bash", "--print-configure", "--env", "A=1", "--cwd", "/tmp"],
  },
  {
    name: "host and memory mounts",
    args: [
      "exec",
      "--print-configure",
      "--mount-hostfs",
      `${hostDir}:/work:ro`,
      "--mount-hostfs",
      `${hostDir}:/aaa`,
      "--mount-memfs",
      "/scratch",
      "--mount-memfs",
      "/x//y/",
    ],
  },
  {
    name: "user /etc/gondolin replaces the injected mounts",
    args: [
      "exec",
      "--print-configure",
      "--mount-hostfs",
      `${hostDir}:/etc/gondolin`,
    ],
  },
  {
    name: "allowlist and secrets",
    args: [
      "exec",
      "--print-configure",
      "--allow-host",
      "example.com",
      "--allow-host",
      "*.github.com",
      "--host-secret",
      "TOKEN@api.github.com=x",
      "--host-secret",
      "OTHER@example.com,api.github.com",
    ],
    env: { OTHER: "from-env" },
  },
  {
    name: "websockets off",
    args: ["bash", "--print-configure", "--disable-websockets"],
  },
  {
    name: "trusted dns",
    args: [
      "exec",
      "--print-configure",
      "--dns",
      "trusted",
      "--dns-trusted-server",
      "8.8.8.8",
    ],
  },
  {
    name: "open dns",
    args: ["exec", "--print-configure", "--dns", "open"],
  },
  {
    name: "tcp map",
    args: [
      "exec",
      "--print-configure",
      "--tcp-map",
      "pg.internal=127.0.0.1:5432",
      "--tcp-map",
      "pg.internal:6543=127.0.0.1:6543",
    ],
  },
  {
    name: "ssh egress",
    args: [
      "exec",
      "--print-configure",
      "--ssh-allow-host",
      "github.com",
      "--ssh-allow-host",
      "ssh.example.com:2222",
      "--ssh-known-hosts",
      knownHosts,
    ],
  },
  {
    name: "rootfs size",
    args: ["exec", "--print-configure", "--rootfs-size", "2G"],
  },
  {
    name: "environment",
    args: ["exec", "--print-configure"],
    env: {
      GONDOLIN_DEBUG: "exec,fs",
      GONDOLIN_CPU: "max",
      GONDOLIN_VIRTIOFS: "0",
    },
  },
  {
    name: "missing host dir",
    args: [
      "exec",
      "--print-configure",
      "--mount-hostfs",
      `${hostDir}/missing:/x`,
    ],
    error: `Host path does not exist: ${hostDir}/missing`,
  },
  {
    name: "trusted server without trusted dns",
    args: ["exec", "--print-configure", "--dns-trusted-server", "8.8.8.8"],
    error: "--dns-trusted-server requires --dns trusted",
  },
  {
    name: "duplicate mount paths",
    args: [
      "exec",
      "--print-configure",
      "--mount-memfs",
      "/a",
      "--mount-memfs",
      "/a/",
    ],
    error: "duplicate mount path: /a",
  },
];

for (const c of cases) {
  test(`cli configure parity: ${c.name}`, {
    skip,
    timeout: 120_000,
  }, async () => {
    const [node, native] = await Promise.all([
      run(process.execPath, [nodeCli, ...c.args], c.env ?? {}),
      run(cli!, c.args, c.env ?? {}),
    ]);
    if (c.error) {
      assert.notEqual(node.code, 0, `node CLI should fail: ${node.stdout}`);
      assert.notEqual(
        native.code,
        0,
        `native CLI should fail: ${native.stdout}`,
      );
      assert.match(node.stderr, new RegExp(escapeRegExp(c.error)));
      assert.match(native.stderr, new RegExp(escapeRegExp(c.error)));
      return;
    }
    assert.equal(node.code, 0, `node CLI failed: ${node.stderr}`);
    assert.equal(native.code, 0, `native CLI failed: ${native.stderr}`);
    assert.deepEqual(
      normalize(native.stdout, c.args),
      normalize(node.stdout, c.args),
    );
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
