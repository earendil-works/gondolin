/**
 * Guest network egress end to end:
 * HTTP/HTTPS mediation to local upstreams, policy, secrets, hooks,
 * WebSockets, DNS and mapped TCP.
 *
 * The guest reaches the host's loopback upstreams by connecting to a public
 * address (`203.0.113.5`) with `Host: localhost:PORT`, the hostname policy
 * resolves on the host (like the benchmark harness).
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import zlib from "node:zlib";

import { createHttpHooks } from "../src/http/hooks.ts";
import { generateMitmLeaf, loadOrCreateMitmCaSync } from "../src/mitm.ts";
import type { VM, VMOptions } from "../src/vm/core.ts";
import {
  closeVm,
  scheduleForceExit,
  shouldSkipVmTests,
  withVm,
} from "./helpers/vm-fixture.ts";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);
const PUBLIC_IP = "203.0.113.5";
const BIG_BYTES = 8 * 1024 * 1024;

type Upstreams = {
  http: number;
  https: number;
  tcp: number;
  bigSha256: string;
  close(): Promise<void>;
};

function pattern(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = i % 251;
  return out;
}

const openSockets = new Set<net.Socket>();

async function listen(server: net.Server): Promise<number> {
  server.on("connection", (socket: net.Socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (url.pathname === "/big") {
      res.writeHead(200, { "content-length": String(BIG_BYTES) });
      res.end(pattern(BIG_BYTES));
      return;
    }
    if (url.pathname === "/gz") {
      const gz = zlib.gzipSync(Buffer.from("hello gzip"));
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(gz.length),
      });
      res.end(gz);
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      `${req.method} ${url.pathname} auth=${req.headers.authorization ?? "-"} len=${body.length} sha=${sha.slice(0, 16)} body=${body.length <= 64 ? body.toString() : ""}\n`,
    );
  });
}

function onUpgrade(req: http.IncomingMessage, socket: net.Socket) {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: test\r\n\r\n",
  );
  socket.on("data", (d: Buffer) =>
    socket.write(Buffer.concat([Buffer.from("echo:"), d])),
  );
  void req;
}

let upstreamsPromise: Promise<Upstreams> | null = null;
let previousCa: string[] | null = null;

function upstreams(): Promise<Upstreams> {
  upstreamsPromise ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-net-test-"));
    const ca = loadOrCreateMitmCaSync(dir);
    const leaf = await generateMitmLeaf(ca, "localhost");
    // trust the upstream like the benchmark harness: this process' default CA store
    previousCa = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...previousCa, ca.certPem]);

    const httpServer = http.createServer(handler);
    httpServer.on("upgrade", onUpgrade);
    const httpsServer = https.createServer(
      { key: leaf.keyPem, cert: `${leaf.certPem}\n${ca.certPem}` },
      handler,
    );
    const tcpServer = net.createServer((s) => {
      s.on("data", (d) => s.write(Buffer.concat([Buffer.from("tcp:"), d])));
    });
    const ports = {
      http: await listen(httpServer),
      https: await listen(httpsServer),
      tcp: await listen(tcpServer),
    };
    return {
      ...ports,
      bigSha256: crypto
        .createHash("sha256")
        .update(pattern(BIG_BYTES))
        .digest("hex"),
      async close() {
        for (const socket of openSockets) socket.destroy();
        for (const s of [httpServer, httpsServer, tcpServer]) {
          await new Promise<void>((resolve) => s.close(() => resolve()));
        }
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  })();
  return upstreamsPromise;
}

const secret = "s3cr3t-value";
const policy = createHttpHooks({
  allowedHosts: ["localhost", "127.0.0.1"],
  allowedInternalHosts: ["localhost", "127.0.0.1"],
  secrets: { API_TOKEN: { hosts: ["localhost"], value: secret } },
});

const hooked = createHttpHooks({
  allowedHosts: ["localhost"],
  allowedInternalHosts: ["localhost"],
  onRequest: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/short") {
      return new Response("short-circuit\n", { status: 201 });
    }
    if (request.method === "POST") {
      const text = await request.clone().text();
      if (text.includes("forbidden")) {
        return new Response("blocked by hook\n", { status: 403 });
      }
    }
    return undefined;
  },
  onResponse: async (response, request) => {
    const url = new URL(request.url);
    if (url.pathname === "/upper" || url.pathname === "/gz") {
      const text = await response.text();
      return new Response(text.toUpperCase(), {
        status: response.status,
        headers: { "x-hooked": "1" },
      });
    }
    return undefined;
  },
});

async function policyVmOptions(): Promise<VMOptions> {
  const ups = await upstreams();
  return {
    httpHooks: policy.httpHooks,
    env: policy.env,
    tcp: { hosts: { "db.test:5432": `127.0.0.1:${ups.tcp}` } },
  };
}

function connectTo(port: number): string {
  return `--connect-to localhost:${port}:${PUBLIC_IP}:${port}`;
}

async function sh(vm: VM, script: string) {
  const result = await vm.exec(["/bin/sh", "-c", script]);
  return {
    exitCode: result.exitCode as number,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

test.after(async () => {
  scheduleForceExit();
  await closeVm("net-policy");
  await closeVm("net-hooks");
  await closeVm("net-default");
  if (upstreamsPromise) await (await upstreamsPromise).close();
  if (previousCa) tls.setDefaultCACertificates(previousCa);
});

const vmTest = { skip: skipVmTests, timeout: timeoutMs };

test("network: http request with secret substitution", vmTest, async () => {
  const ups = await upstreams();
  await withVm("net-policy", await policyVmOptions(), async (vm) => {
    const r = await sh(
      vm,
      `curl -sS ${connectTo(ups.http)} -H "Authorization: Bearer $API_TOKEN" http://localhost:${ups.http}/hello`,
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(
      r.stdout,
      new RegExp(`^GET /hello auth=Bearer ${secret} len=0`),
    );
  });
});

test("network: https through the MITM", vmTest, async () => {
  const ups = await upstreams();
  await withVm("net-policy", await policyVmOptions(), async (vm) => {
    const r = await sh(
      vm,
      `curl -sS ${connectTo(ups.https)} https://localhost:${ups.https}/tls`,
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /^GET \/tls auth=- len=0/);
  });
});

test(
  "network: large download and upload keep their bytes",
  vmTest,
  async () => {
    const ups = await upstreams();
    await withVm("net-policy", await policyVmOptions(), async (vm) => {
      const down = await sh(
        vm,
        `curl -sS ${connectTo(ups.https)} https://localhost:${ups.https}/big | sha256sum`,
      );
      assert.equal(down.exitCode, 0, down.stderr);
      assert.equal(down.stdout.split(" ")[0], ups.bigSha256);

      const size = 3 * 1024 * 1024;
      const expected = crypto
        .createHash("sha256")
        .update(Buffer.alloc(size))
        .digest("hex");
      const up = await sh(
        vm,
        `head -c ${size} /dev/zero > /tmp/up.bin && curl -sS ${connectTo(ups.http)} -H 'Expect:' --data-binary @/tmp/up.bin http://localhost:${ups.http}/upload`,
      );
      assert.equal(up.exitCode, 0, up.stderr);
      assert.match(
        up.stdout,
        new RegExp(
          `^POST /upload auth=- len=${size} sha=${expected.slice(0, 16)}`,
        ),
      );
    });
  },
);

test("network: redirects are followed on the host", vmTest, async () => {
  const ups = await upstreams();
  await withVm("net-policy", await policyVmOptions(), async (vm) => {
    const r = await sh(
      vm,
      `curl -sS ${connectTo(ups.http)} http://localhost:${ups.http}/redirect`,
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /^GET \/final /);
  });
});

test("network: policy denials", vmTest, async () => {
  const ups = await upstreams();
  await withVm("net-policy", await policyVmOptions(), async (vm) => {
    // (an IP literal: hostnames are resolved before the allowlist check)
    const denied = await sh(
      vm,
      `curl -sS -w '%{http_code}' ${connectTo(ups.http).replace("localhost", "127.0.0.2")} http://127.0.0.2:${ups.http}/`,
    );
    assert.equal(
      denied.stdout,
      "403 Forbidden: blocked by policy: 127.0.0.2\n403",
    );

    const secretLeak = await sh(
      vm,
      `curl -sS -w '%{http_code}' -H "Authorization: Bearer $API_TOKEN" ${connectTo(ups.http).replace("localhost", "127.0.0.1")} http://127.0.0.1:${ups.http}/`,
    );
    assert.equal(
      secretLeak.stdout,
      "403 Forbidden: secret API_TOKEN not allowed for host: 127.0.0.1\n403",
    );

    // non-HTTP/TLS traffic is reset
    const raw = await sh(
      vm,
      `python3 -c "import socket; s=socket.create_connection(('${PUBLIC_IP}', ${ups.tcp}), 5); s.sendall(b'\\x00\\x01\\x02\\x03hello'); print(repr(s.recv(16)))"`,
    );
    assert.notEqual(raw.stdout.trim(), "b'tcp:\\x00\\x01\\x02\\x03hello'");
  });
});

test("network: dns per-host mapping and mapped tcp", vmTest, async () => {
  await withVm("net-policy", await policyVmOptions(), async (vm) => {
    const dns = await sh(vm, "getent ahostsv4 db.test");
    assert.equal(dns.exitCode, 0, dns.stderr);
    assert.match(dns.stdout, /^198\.19\.\d+\.\d+\s+STREAM\s+db\.test/m);

    const tcp = await sh(
      vm,
      `python3 -c "import socket; s=socket.create_connection(('db.test', 5432), 5); s.sendall(b'ping'); print(s.recv(16).decode())"`,
    );
    assert.equal(tcp.exitCode, 0, tcp.stderr);
    assert.equal(tcp.stdout.trim(), "tcp:ping");
  });
});

test("network: websocket upgrades are tunneled", vmTest, async () => {
  const ups = await upstreams();
  await withVm("net-policy", await policyVmOptions(), async (vm) => {
    const script = [
      "import socket",
      `s = socket.create_connection(('${PUBLIC_IP}', ${ups.http}), 5)`,
      "s.settimeout(10)",
      `s.sendall(b'GET /ws HTTP/1.1\\r\\nHost: 127.0.0.1:${ups.http}\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n')`,
      "head = b''",
      "while b'\\r\\n\\r\\n' not in head:",
      "    c = s.recv(1)",
      "    if not c: raise SystemExit('eof in head: %r' % head)",
      "    head += c",
      "print(head.split(b'\\r\\n')[0].decode())",
      "s.sendall(b'ping')",
      "data = b''",
      "while len(data) < 9:",
      "    c = s.recv(9 - len(data))",
      "    if not c: raise SystemExit('eof in data: %r' % data)",
      "    data += c",
      "print(data.decode())",
    ].join("\n");
    const r = await sh(
      vm,
      `cat > /tmp/ws.py <<'EOF'\n${script}\nEOF\ntimeout 20 python3 /tmp/ws.py`,
    );
    assert.equal(
      r.stdout,
      "HTTP/1.1 101 Switching Protocols\necho:ping\n",
      r.stderr,
    );
  });
});

test("network: request and response hooks", vmTest, async () => {
  const ups = await upstreams();
  await withVm(
    "net-hooks",
    { httpHooks: hooked.httpHooks, env: hooked.env },
    async (vm) => {
      const short = await sh(
        vm,
        `curl -sS -w '%{http_code}' http://localhost-unused.test/short`,
      );
      assert.equal(short.stdout, "short-circuit\n201");

      const blocked = await sh(
        vm,
        `curl -sS -w '%{http_code}' ${connectTo(ups.http)} --data 'this is forbidden' http://localhost:${ups.http}/post`,
      );
      assert.equal(blocked.stdout, "blocked by hook\n403");

      const fine = await sh(
        vm,
        `curl -sS ${connectTo(ups.http)} --data 'all fine' http://localhost:${ups.http}/post`,
      );
      assert.match(fine.stdout, /^POST \/post auth=- len=8 .* body=all fine$/m);

      const upper = await sh(
        vm,
        `curl -sS -i ${connectTo(ups.http)} http://localhost:${ups.http}/upper`,
      );
      assert.match(upper.stdout, /x-hooked: 1/i);
      assert.match(upper.stdout, /GET \/UPPER AUTH=- LEN=0/);

      // hooks see decoded bodies
      const gz = await sh(
        vm,
        `curl -sS ${connectTo(ups.http)} http://localhost:${ups.http}/gz`,
      );
      assert.equal(gz.stdout, "HELLO GZIP");
    },
  );
});

test("network: internal ranges are blocked without hooks", vmTest, async () => {
  const ups = await upstreams();
  await withVm("net-default", {}, async (vm) => {
    const r = await sh(
      vm,
      `curl -sS -w '%{http_code}' ${connectTo(ups.http)} http://localhost:${ups.http}/`,
    );
    assert.equal(
      r.stdout,
      "403 Forbidden: blocked by policy: localhost (internal address; provide httpHooks.isIpAllowed to allow)\n403",
    );
  });
});
