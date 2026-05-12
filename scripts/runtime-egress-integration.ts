#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VM, type HttpHooks } from "../host/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "host/bin/gondolin.ts");

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function runCli(action: "status" | "off" | "on", sessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "network", action, sessionId], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`gondolin network ${action} timed out`));
    }, 15_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          `gondolin network ${action} failed (code=${code} signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
}

async function curl(vm: VM): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await vm.exec(
    "env -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY -u all_proxy -u ALL_PROXY " +
      "curl -fsS --noproxy '*' --connect-timeout 2 --max-time 5 " +
      "--resolve runtime-egress.test:80:192.0.2.1 http://runtime-egress.test/ping",
  );
}

async function expectCurlOk(vm: VM, expectedBody: string) {
  const result = await curl(vm);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, expectedBody);
}

async function expectCurlBlocked(vm: VM) {
  const result = await curl(vm);
  assert.notEqual(result.exitCode, 0, "curl unexpectedly succeeded while egress was denied");
}

async function main() {
  let upstreamHits = 0;
  const server = http.createServer((req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`egress-ok:${req.url}`);
  });
  const port = await listen(server);

  const httpHooks: HttpHooks = {
    onRequest(request) {
      const url = new URL(request.url);
      return new Request(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
        method: request.method,
      });
    },
  };

  const vm = await VM.create({
    httpHooks,
    sessionLabel: "runtime-egress-integration",
    startTimeoutMs: 120_000,
  });

  try {
    console.log(`[1/7] starting VM ${vm.id}`);
    await vm.start();

    console.log("[2/7] default egress is allowed");
    assert.deepEqual(vm.getNetworkPolicy(), { egress: "allow" });
    assert.match(await runCli("status", vm.id), /egress: allow/);
    await expectCurlOk(vm, "egress-ok:/ping");
    assert.equal(upstreamHits, 1);

    console.log("[3/7] CLI can deny egress and closes/blocks outbound flows");
    assert.match(await runCli("off", vm.id), /egress: deny/);
    assert.deepEqual(vm.getNetworkPolicy(), { egress: "deny" });
    await expectCurlBlocked(vm);
    assert.equal(upstreamHits, 1, "blocked request reached upstream server");

    console.log("[4/7] CLI can re-enable egress");
    assert.match(await runCli("on", vm.id), /egress: allow/);
    assert.deepEqual(vm.getNetworkPolicy(), { egress: "allow" });
    await expectCurlOk(vm, "egress-ok:/ping");
    assert.equal(upstreamHits, 2);

    console.log("[5/7] SDK can deny egress");
    assert.deepEqual(vm.setOutboundEgressEnabled(false), { egress: "deny" });
    await expectCurlBlocked(vm);
    assert.equal(upstreamHits, 2, "SDK-blocked request reached upstream server");

    console.log("[6/7] SDK can restore egress");
    assert.deepEqual(vm.setOutboundEgressEnabled(true), { egress: "allow" });
    await expectCurlOk(vm, "egress-ok:/ping");
    assert.equal(upstreamHits, 3);

    console.log("[7/7] runtime egress integration test passed");
  } finally {
    await vm.close().catch(() => {});
    await closeServer(server).catch(() => {});
  }
}

await main();
