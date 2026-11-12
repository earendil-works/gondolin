/**
 * SSH egress end to end (both engines): the guest runs `ssh` against an
 * allowlisted synthetic hostname, the host proxies the exec over a real SSH
 * connection (private-key auth, known_hosts verification) to a local `ssh2`
 * server, and `execPolicy` can deny commands.
 *
 * The upstream hostname must resolve to loopback on the host but not be a
 * `localhost` name (those resolve to the guest's own loopback), so a public
 * loopback name (`127.0.0.1.nip.io`, ...) is used; the test is skipped when
 * none resolves.
 */

import assert from "node:assert/strict";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ssh2 from "ssh2";

import type { VM, VMOptions } from "../src/vm/core.ts";
import {
  closeVm,
  scheduleForceExit,
  shouldSkipVmTests,
  withVm,
} from "./helpers/vm-fixture.ts";

const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);
const CANDIDATE_HOSTS = [
  "127.0.0.1.nip.io",
  "127.0.0.1.sslip.io",
  "localtest.me",
];

async function loopbackHostname(): Promise<string | null> {
  for (const host of CANDIDATE_HOSTS) {
    try {
      const entries = await dns.lookup(host, { all: true });
      if (
        entries.length > 0 &&
        entries.every((e) => e.address === "127.0.0.1")
      ) {
        return host;
      }
    } catch {
      // try the next one
    }
  }
  return null;
}

type Upstream = {
  host: string;
  port: number;
  clientKey: string;
  knownHostsFile: string;
  execs: string[];
  close(): Promise<void>;
};

/**
 * An ed25519 key pair from ssh2. ssh2 drops a leading zero byte of the
 * public key (1 in 256 keys), which leaves an OpenSSH key it cannot parse
 * itself ("Malformed OpenSSH private key"), so draw again in that case.
 */
function ed25519KeyPair(): { private: string; public: string } {
  for (;;) {
    const keys = ssh2.utils.generateKeyPairSync("ed25519");
    if (
      !(ssh2.utils.parseKey(keys.private) instanceof Error) &&
      !(ssh2.utils.parseKey(keys.public) instanceof Error)
    ) {
      return keys;
    }
  }
}

let upstreamPromise: Promise<Upstream | null> | null = null;

function upstream(): Promise<Upstream | null> {
  upstreamPromise ??= (async () => {
    const host = await loopbackHostname();
    if (!host) return null;
    const hostKey = ed25519KeyPair();
    const clientKey = ed25519KeyPair();
    const allowedClient = ssh2.utils.parseKey(clientKey.public);
    if (allowedClient instanceof Error) throw allowedClient;
    const execs: string[] = [];
    const connections = new Set<ssh2.Connection>();

    const server = new ssh2.Server(
      { hostKeys: [hostKey.private] },
      (client) => {
        connections.add(client);
        client.on("close", () => connections.delete(client));
        client.on("authentication", (ctx) => {
          if (
            ctx.method === "publickey" &&
            ctx.username === "git" &&
            ctx.key.algo === allowedClient.type &&
            ctx.key.data.equals(allowedClient.getPublicSSH())
          ) {
            ctx.accept();
            return;
          }
          ctx.reject(["publickey"]);
        });
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _reject, info) => {
            const stream = acceptExec();
            execs.push(info.command);
            // answer immediately: output, exit status and close arrive in
            // the same tick as the exec reply (regression: listeners
            // attached after an await lost them)
            stream.write(`upstream:${info.command}\n`);
            stream.exit(0);
            stream.end();
          });
        });
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-ssh-egress-"));
    const knownHostsFile = path.join(dir, "known_hosts");
    const parsedHostKey = ssh2.utils.parseKey(hostKey.public);
    if (parsedHostKey instanceof Error) throw parsedHostKey;
    fs.writeFileSync(
      knownHostsFile,
      `[${host}]:${port} ${parsedHostKey.type} ${parsedHostKey.getPublicSSH().toString("base64")}\n`,
    );

    return {
      host,
      port,
      clientKey: clientKey.private,
      knownHostsFile,
      execs,
      async close() {
        for (const c of connections) c.end();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  })();
  return upstreamPromise;
}

function vmOptions(up: Upstream): VMOptions {
  const target = `${up.host}:${up.port}`;
  return {
    ssh: {
      allowedHosts: [target],
      credentials: { [target]: { username: "git", privateKey: up.clientKey } },
      knownHostsFile: up.knownHostsFile,
      execPolicy: (req) =>
        req.command.includes("forbidden")
          ? { allow: false, exitCode: 7, message: "denied by policy" }
          : { allow: true },
    },
  };
}

async function sh(vm: VM, script: string) {
  const r = await vm.exec(["/bin/sh", "-c", script]);
  return {
    exitCode: r.exitCode,
    stdout: String(r.stdout),
    stderr: String(r.stderr),
  };
}

const sshOpts = `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 ${process.env.SSH_EGRESS_VERBOSE ? "-vv" : "-o LogLevel=ERROR"}`;

test.after(async () => {
  scheduleForceExit();
  await closeVm("ssh-egress");
  const up = await upstreamPromise;
  await up?.close();
});

test("ssh egress: exec is proxied to the allowlisted upstream", {
  skip: shouldSkipVmTests(),
  timeout: timeoutMs,
}, async (t) => {
  const up = await upstream();
  if (!up) {
    t.skip("no public loopback hostname resolves on this host");
    return;
  }
  await withVm("ssh-egress", vmOptions(up), async (vm) => {
    const ok = await sh(
      vm,
      `ssh ${sshOpts} -p ${up.port} git@${up.host} 'git-upload-pack repo.git'`,
    );
    assert.equal(ok.exitCode, 0, `stderr: ${ok.stderr}`);
    assert.equal(ok.stdout, "upstream:git-upload-pack repo.git\n");
    assert.deepEqual(up.execs, ["git-upload-pack repo.git"]);

    const denied = await sh(
      vm,
      `ssh ${sshOpts} -p ${up.port} git@${up.host} 'forbidden thing'`,
    );
    assert.equal(denied.exitCode, 7);
    assert.match(denied.stderr, /denied by policy/);
    assert.deepEqual(up.execs, ["git-upload-pack repo.git"]);

    // shells are refused
    const shell = await sh(
      vm,
      `ssh ${sshOpts} -tt -p ${up.port} git@${up.host} </dev/null`,
    );
    assert.notEqual(shell.exitCode, 0);
  });
});
