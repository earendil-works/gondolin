import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { createHttpHooks } from "../src/http/hooks.ts";
import {
  NativeHookService,
  compileNetConfig,
  compileNetworkOptions,
  type BodyTransport,
} from "../src/native/net.ts";

function fakeTransport(streams: Record<number, Uint8Array[]>) {
  const pulls: number[] = [];
  const released: number[] = [];
  const transport: BodyTransport = {
    async pull(stream, max, offset) {
      pulls.push(stream);
      const all = concat(streams[stream] ?? []);
      const data = all.subarray(
        offset,
        Math.min(all.length, offset + Math.min(max, 3)),
      );
      return { data, eof: offset + data.length >= all.length };
    },
    release(stream) {
      released.push(stream);
    },
  };
  return { transport, pulls, released };
}

const enc = (s: string) => new TextEncoder().encode(s);

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function service(
  hooks: ConstructorParameters<typeof NativeHookService>[0],
  streams: Record<number, Uint8Array[]> = {},
) {
  const fake = fakeTransport(streams);
  return {
    ...fake,
    svc: new NativeHookService(hooks, {
      transport: fake.transport,
      maxRequestBodyBytes: 1024,
      maxResponseBodyBytes: 1024,
    }),
  };
}

const postHead = {
  method: "POST",
  url: "https://example.com/upload",
  headers: [
    ["content-length", "5"],
    ["host", "example.com"],
  ] as Array<[string, string]>,
  body: 1,
};

test("native net: createHttpHooks compiles to declarative rules", () => {
  const onRequest = () => undefined;
  const { httpHooks, secretManager, env } = createHttpHooks({
    allowedHosts: ["example.com"],
    allowedInternalHosts: ["corp.test"],
    secrets: { API_KEY: { hosts: ["example.com"], value: "v1" } },
    onRequest,
  });
  const compiled = compileNetConfig({ httpHooks, maxHttpBodyBytes: 10 });
  const rules = compiled.config.policy.rules!;
  assert.deepEqual(rules.allowed_hosts, ["example.com", "corp.test"]);
  assert.deepEqual(rules.allowed_internal_hosts, ["corp.test"]);
  assert.equal(rules.secrets[0]!.placeholder, env.API_KEY);
  assert.equal(rules.placeholder_mode, "shared");
  assert.ok(rules.marker && env.API_KEY.startsWith(rules.marker));
  assert.deepEqual(compiled.config.hooks, {
    is_request_allowed: false,
    is_ip_allowed: false,
    on_request: { body: true },
  });
  assert.equal(compiled.config.limits.max_request_body_bytes, 10);
  assert.equal(compiled.hooks?.onRequest, onRequest);

  const updates: unknown[] = [];
  compiled.onPolicyUpdate((policy) => updates.push(policy));
  secretManager.updateSecret("API_KEY", { value: "v2" });
  assert.equal(updates.length, 1);
  const updated = updates[0] as {
    rules: { secrets: Array<{ value: string; revoked_values: string[] }> };
  };
  assert.equal(updated.rules.secrets[0]!.value, "v2");
  assert.deepEqual(updated.rules.secrets[0]!.revoked_values, ["v1"]);
});

test("native net: createHttpHooks without user hooks needs no callbacks", () => {
  const { httpHooks } = createHttpHooks({ allowedHosts: ["example.com"] });
  const compiled = compileNetConfig({ httpHooks });
  assert.equal(compiled.hooks, null);
  assert.ok(compiled.config.policy.rules);
});

test("native net: spread or modified hooks fall back to tier-3 callbacks", () => {
  const { httpHooks } = createHttpHooks({ allowedHosts: ["example.com"] });
  const spread = compileNetConfig({ httpHooks: { ...httpHooks } });
  assert.equal(spread.config.policy.rules, undefined);
  assert.equal(spread.config.hooks.is_ip_allowed, true);
  assert.equal(spread.config.hooks.is_request_allowed, true);
  assert.ok(spread.config.hooks.on_request);

  const original = httpHooks.onRequest!;
  httpHooks.onRequest = (req) => original(req);
  const modified = compileNetConfig({ httpHooks });
  assert.equal(modified.config.policy.rules, undefined);
});

test("native net: plain hook objects keep this", async () => {
  class Hooks {
    allowed = "203.0.113.1";
    isIpAllowed(info: { ip: string }) {
      return info.ip === this.allowed;
    }
  }
  const compiled = compileNetConfig({ httpHooks: new Hooks() as any });
  assert.deepEqual(compiled.config.hooks, {
    is_request_allowed: false,
    is_ip_allowed: true,
  });
  const { svc } = service(compiled.hooks!);
  const decision = await svc.handle({
    phase: "is_ip_allowed",
    ip: {
      hostname: "a",
      ip: "203.0.113.1",
      family: 4,
      port: 443,
      protocol: "https",
    },
  });
  assert.deepEqual(decision, { action: "allowed", allowed: true });
});

test("native net: onRequest undefined continues without pulling the body", async () => {
  const { svc, pulls } = service(
    { onRequest: () => undefined },
    { 1: [enc("hello")] },
  );
  assert.deepEqual(
    await svc.handle({ phase: "on_request", request: postHead }),
    {
      action: "continue",
    },
  );
  assert.deepEqual(pulls, []);
});

test("native net: onRequest in-place header mutation keeps original body", async () => {
  const { svc } = service({
    onRequest: (req) => {
      req.headers.set("x-added", "1");
    },
  });
  const decision = await svc.handle({ phase: "on_request", request: postHead });
  assert.equal(decision.action, "request");
  assert.ok(decision.action === "request");
  assert.deepEqual(decision.body, { kind: "original" });
  assert.ok(
    decision.request.headers.some(([k, v]) => k === "x-added" && v === "1"),
  );
});

test("native net: onRequest clone read keeps original body", async () => {
  const { svc, pulls } = service(
    {
      onRequest: async (req) => {
        assert.equal(await req.clone().text(), "hello");
        return req;
      },
    },
    { 1: [enc("hel"), enc("lo")] },
  );
  assert.deepEqual(
    await svc.handle({ phase: "on_request", request: postHead }),
    {
      action: "continue",
    },
  );
  assert.ok(pulls.length >= 2);
});

test("native net: onRequest consuming the body and returning it is rejected", async () => {
  const { svc } = service(
    {
      onRequest: async (req) => {
        await req.text();
        return req;
      },
    },
    { 1: [enc("hello")] },
  );
  const decision = await svc.handle({ phase: "on_request", request: postHead });
  assert.deepEqual(decision, {
    action: "block",
    status: 400,
    status_text: "Bad Request",
    message:
      "onRequest consumed the request body; use request.clone() or return a new Request",
  });
});

test("native net: onRequest replacement body and short-circuit", async () => {
  const { svc, released } = service(
    {
      onRequest: (req) =>
        new Request(req.url, {
          method: "PUT",
          headers: req.headers,
          body: "replaced",
        }),
    },
    { 1: [enc("hello")] },
  );
  const decision = await svc.handle({ phase: "on_request", request: postHead });
  assert.ok(decision.action === "request");
  assert.equal(decision.request.method, "PUT");
  assert.ok(decision.body.kind === "bytes");
  assert.equal(new TextDecoder().decode(decision.body.data), "replaced");
  assert.deepEqual(released, [1]);

  const short = service({
    onRequest: () => new Response("synthetic", { status: 201 }),
  });
  const res = await short.svc.handle({
    phase: "on_request",
    request: { ...postHead, body: undefined },
  });
  assert.ok(res.action === "response");
  assert.equal(res.response.status, 201);
  assert.ok(res.body.kind === "bytes");
  assert.equal(new TextDecoder().decode(res.body.data), "synthetic");
});

test("native net: onResponse sees decoded bodies and can rewrite", async () => {
  const gz = new Uint8Array(zlib.gzipSync(Buffer.from("payload")));
  const { svc } = service(
    {
      onResponse: async (res) => {
        assert.equal(res.headers.get("content-encoding"), null);
        const text = await res.text();
        return new Response(text.toUpperCase(), {
          status: res.status,
          headers: res.headers,
        });
      },
    },
    { 2: [gz] },
  );
  const decision = await svc.handle({
    phase: "on_response",
    request: { method: "GET", url: "https://example.com/", headers: [] },
    response: {
      status: 200,
      status_text: "OK",
      headers: [
        ["content-encoding", "gzip"],
        ["content-length", String(gz.length)],
      ],
      body: 2,
    },
  });
  assert.ok(decision.action === "response");
  assert.ok(decision.body.kind === "bytes");
  assert.equal(new TextDecoder().decode(decision.body.data), "PAYLOAD");
  assert.ok(!decision.response.headers.some(([k]) => k === "content-encoding"));
});

test("native net: onResponse returning the same response keeps the original body", async () => {
  const { svc, pulls } = service(
    {
      onResponse: (res) => {
        res.headers.set("x-seen", "1");
        return res;
      },
    },
    { 2: [enc("body")] },
  );
  const decision = await svc.handle({
    phase: "on_response",
    request: { method: "GET", url: "https://example.com/", headers: [] },
    response: {
      status: 200,
      status_text: "OK",
      headers: [
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
      body: 2,
    },
  });
  assert.ok(decision.action === "response");
  assert.deepEqual(decision.body, { kind: "original" });
  assert.equal(
    decision.response.headers.filter(([k]) => k === "set-cookie").length,
    2,
  );
  assert.deepEqual(pulls, []);
});

test("native net: network options resolve to the stack configuration", () => {
  const plain = compileNetworkOptions({ daemonIsLocal: false });
  assert.deepEqual(plain.stack.dns, {
    mode: "synthetic",
    synthetic_host_mapping: "single",
  });
  assert.deepEqual(plain.tcpHosts, []);
  assert.equal(plain.systemResolvers, undefined);

  const mapped = compileNetworkOptions({
    daemonIsLocal: false,
    tcp: {
      hosts: {
        "DB.internal": "127.0.0.1:5432",
        "db.internal:42": "10.0.0.1:443",
      },
    },
  });
  assert.equal(mapped.stack.dns.synthetic_host_mapping, "per-host");
  assert.deepEqual(
    mapped.tcpHosts.sort((a, b) => (a.port ?? 0) - (b.port ?? 0)),
    [
      { host: "db.internal", upstream_host: "127.0.0.1", upstream_port: 5432 },
      {
        host: "db.internal",
        port: 42,
        upstream_host: "10.0.0.1",
        upstream_port: 443,
      },
    ],
  );

  assert.throws(
    () =>
      compileNetworkOptions({
        daemonIsLocal: false,
        dns: { mode: "trusted" },
        tcp: { hosts: { a: "127.0.0.1:1" } },
      }),
    /requires dns mode 'synthetic'/,
  );

  const trusted = compileNetworkOptions({
    daemonIsLocal: false,
    dns: { mode: "trusted", trustedServers: ["1.1.1.1", "::1", "1.1.1.1"] },
  });
  assert.deepEqual(trusted.stack.dns.trusted_servers, ["1.1.1.1"]);

  const local = compileNetworkOptions({ daemonIsLocal: true });
  assert.ok(Array.isArray(local.systemResolvers));
});

test("native net: clones read the daemon stream independently", async () => {
  const { svc } = service(
    {
      onRequest: async (req) => {
        const a = req.clone();
        const b = req.clone();
        assert.equal(await a.text(), "hello world");
        assert.equal(await b.text(), "hello world");
        assert.equal(req.bodyUsed, false);
        return undefined;
      },
      onResponse: async (res) => {
        assert.equal(await res.clone().text(), "payload");
        return res;
      },
    },
    { 1: [enc("hello world")], 2: [enc("payload")] },
  );
  assert.deepEqual(
    await svc.handle({ phase: "on_request", request: postHead }),
    {
      action: "continue",
    },
  );
  const decision = await svc.handle({
    phase: "on_response",
    request: { method: "GET", url: "https://example.com/", headers: [] },
    response: { status: 200, status_text: "OK", headers: [], body: 2 },
  });
  assert.ok(decision.action === "response");
  assert.deepEqual(decision.body, { kind: "original" });
});

test("native net: large replacement bodies are streamed to the daemon", async () => {
  const big = new Uint8Array(3 * 1024 * 1024).fill(7);
  const fake = fakeTransport({});
  const svc = new NativeHookService(
    { onRequest: () => new Response(big) },
    {
      transport: fake.transport,
      maxRequestBodyBytes: 1024,
      maxResponseBodyBytes: 8 * 1024 * 1024,
    },
  );
  const decision = await svc.handle({
    phase: "on_request",
    request: { ...postHead, body: undefined },
  });
  assert.ok(decision.action === "response");
  assert.ok(decision.body.kind === "stream");
  const stream = decision.body.stream;
  let total = 0;
  for (;;) {
    const chunk = await svc.serveBodyPull({ stream, max: 256 * 1024 });
    assert.ok(chunk.data.length <= 256 * 1024);
    total += chunk.data.length;
    if (chunk.eof) break;
  }
  assert.equal(total, big.length);

  const limited = new NativeHookService(
    { onRequest: () => new Response(big) },
    {
      transport: fake.transport,
      maxRequestBodyBytes: 1024,
      maxResponseBodyBytes: 2 * 1024 * 1024,
    },
  );
  const d2 = await limited.handle({
    phase: "on_request",
    request: { ...postHead, body: undefined },
  });
  assert.equal(d2.action, "block");
  assert.ok(d2.action === "block" && d2.status === 502);
});

test("native net: ssh options map onto configure.net.ssh", async () => {
  const compiled = compileNetworkOptions({
    daemonIsLocal: true,
    ssh: {
      allowedHosts: ["github.com", "ssh.github.com:443"],
      agent: "/tmp/agent.sock",
      knownHostsFile: "/tmp/known_hosts",
      credentials: {
        "git.example": { username: "git", privateKey: Buffer.from("KEY") },
      },
      execPolicy: (req) =>
        req.command.includes("evil")
          ? { allow: false, exitCode: 3, message: "no" }
          : { allow: true },
      upstreamReadyTimeoutMs: 5000,
    },
  });
  assert.equal(compiled.stack.dns.synthetic_host_mapping, "per-host");
  const ssh = compiled.ssh!;
  assert.deepEqual(ssh.ports.sort(), [22, 443]);
  assert.deepEqual(ssh.known_hosts_files, ["/tmp/known_hosts"]);
  assert.deepEqual(ssh.credentials, [
    { host: "git.example", username: "git", private_key: "KEY" },
  ]);
  assert.equal(ssh.exec_policy_hook, true);
  assert.equal(ssh.host_verifier_hook, false);
  assert.equal(ssh.upstream_ready_timeout_ms, 5000);

  const svc = compiled.sshHooks!;
  const request = {
    hostname: "github.com",
    port: 22,
    guest_username: "git",
    command: "git-upload-pack 'evil'",
    src_ip: "192.168.127.3",
    src_port: 1234,
  };
  assert.deepEqual(await svc.handle({ phase: "exec_policy", request }), {
    allow: false,
    exit_code: 3,
    message: "no",
  });
  assert.deepEqual(
    await svc.handle({
      phase: "exec_policy",
      request: { ...request, command: "ok" },
    }),
    { allow: true },
  );
});

test("native net: remote ssh egress sends known_hosts contents, not paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-net-kh-"));
  const file = path.join(dir, "known_hosts");
  fs.writeFileSync(file, "github.com ssh-ed25519 AAAA\n");
  try {
    const compiled = compileNetworkOptions({
      daemonIsLocal: false,
      ssh: {
        allowedHosts: ["github.com"],
        knownHostsFile: file,
        credentials: { "github.com": { privateKey: "KEY" } },
      },
    });
    assert.deepEqual(compiled.ssh!.known_hosts_files, []);
    assert.deepEqual(compiled.ssh!.known_hosts, [
      "github.com ssh-ed25519 AAAA\n",
    ]);
    assert.equal(JSON.stringify(compiled).includes(dir), false);

    assert.throws(
      () =>
        compileNetworkOptions({
          daemonIsLocal: false,
          ssh: {
            allowedHosts: ["github.com"],
            knownHostsFile: file,
            agent: "/tmp/a.sock",
          },
        }),
      /ssh.agent is not supported with a remote gondolind/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("native net: decoded hook bodies are limited (decompression bombs)", async () => {
  const bomb = new Uint8Array(zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024)));
  const fake = fakeTransport({ 2: [bomb] });
  const svc = new NativeHookService(
    { onResponse: async (res) => new Response(await res.text()) },
    {
      transport: fake.transport,
      maxRequestBodyBytes: 1024,
      maxResponseBodyBytes: 64 * 1024,
    },
  );
  const decision = await svc.handle({
    phase: "on_response",
    request: { method: "GET", url: "https://example.com/", headers: [] },
    response: {
      status: 200,
      status_text: "OK",
      headers: [["content-encoding", "gzip"]],
      body: 2,
    },
  });
  assert.deepEqual(decision, {
    action: "block",
    status: 502,
    status_text: "Bad Gateway",
    message: "response body exceeds 65536 bytes",
  });
});

test("native net: inline body prefixes need no pulls", async () => {
  const { svc, pulls } = service(
    {
      onRequest: async (req) => {
        assert.equal(await req.clone().text(), "hello");
        return undefined;
      },
      onResponse: async (res) => {
        assert.equal(await res.clone().text(), "0123456789");
        return undefined;
      },
    },
    { 1: [enc("hello")], 2: [enc("0123456789")] },
  );
  assert.deepEqual(
    await svc.handle({
      phase: "on_request",
      request: { ...postHead, body_prefix: enc("hello"), body_complete: true },
    }),
    { action: "continue" },
  );
  // partial prefix: the rest is pulled from its end
  assert.deepEqual(
    await svc.handle({
      phase: "on_response",
      request: { method: "GET", url: "https://example.com/", headers: [] },
      response: {
        status: 200,
        status_text: "OK",
        headers: [],
        body: 2,
        body_prefix: enc("0123"),
      },
    }),
    { action: "continue" },
  );
  assert.deepEqual(pulls, [2, 2]);
});
