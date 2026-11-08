/**
 * Tier-2 hooks (`createDjsHooks`) end to end: the policy runs inside
 * gondolind on djs. Plus the static CLI's `--hooks-script`.
 *
 * The guest reaches the host's loopback upstream by connecting to a public
 * address with `Host: localhost:PORT` (as network-egress.test.ts).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { createDjsHooks } from "../src/http/djs-hooks.ts";
import { createHttpHooks } from "../src/http/hooks.ts";
import type { VM } from "../src/vm/core.ts";
import { checkoutGuestDir, resolveNativeCli } from "./helpers/native-cli.ts";
import {
  closeVm,
  scheduleForceExit,
  shouldSkipVmTests,
  withVm,
} from "./helpers/vm-fixture.ts";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);
const PUBLIC_IP = "203.0.113.5";

const POLICY = `
// tier-2 policy shared by the SDK and the static CLI tests
const SECRET_HOSTS = ["localhost"];

async function onRequest(req) {
  const url = new URL(req.url);
  if (url.pathname === "/short") {
    return new Response("short-circuit\\n", { status: 201 });
  }
  if (url.pathname === "/boom") throw new Error("policy bug");
  if (url.pathname === "/blocked") {
    throw new HttpRequestBlockedError("blocked by tier 2", 451, "Unavailable For Legal Reasons");
  }
  if (req.method === "POST") {
    const text = await req.clone().text();
    if (text.includes("forbidden")) {
      return new Response("blocked by hook\\n", { status: 403 });
    }
  }
  // the hook sees the placeholder, not the secret
  const auth = req.headers.get("authorization") ?? "";
  req.headers.set("x-saw-secret", String(auth.includes("s3cr3t")));
}

async function onResponse(response, request) {
  const url = new URL(request.url);
  if (url.pathname === "/upper" || url.pathname === "/gz") {
    const text = await response.text();
    return new Response(text.toUpperCase(), {
      status: response.status,
      headers: { "x-hooked": "1" },
    });
  }
}
`;

const secret = "s3cr3t-value";
const policy = createHttpHooks({
  allowedHosts: ["localhost"],
  allowedInternalHosts: ["localhost"],
  secrets: { API_TOKEN: { hosts: ["localhost"], value: secret } },
  ...createDjsHooks(POLICY),
});

let server: http.Server | null = null;
let port = 0;
const sockets = new Set<net.Socket>();

async function upstream(): Promise<number> {
  if (server) return port;
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/gz") {
        const gz = zlib.gzipSync(Buffer.from("hello gzip"));
        res.writeHead(200, {
          "content-encoding": "gzip",
          "content-length": String(gz.length),
        });
        res.end(gz);
        return;
      }
      const body = Buffer.concat(chunks);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(
        `${req.method} ${url.pathname} auth=${req.headers.authorization ?? "-"} saw=${req.headers["x-saw-secret"] ?? "-"} len=${body.length}\n`,
      );
    });
  });
  server.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
  return port;
}

async function sh(vm: VM, script: string) {
  const result = await vm.exec(["/bin/sh", "-c", script]);
  return {
    exitCode: result.exitCode as number,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

function curl(p: number, args: string): string {
  return `curl -sS --connect-to localhost:${p}:${PUBLIC_IP}:${p} -w ' %{http_code}' ${args}`;
}

test.after(async () => {
  scheduleForceExit();
  await closeVm("djs-hooks");
  for (const s of sockets) s.destroy();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
});

const vmTest = { skip: skipVmTests, timeout: timeoutMs };

test(
  "tier-2 hooks: rewrite, short-circuit, block, fail closed",
  vmTest,
  async () => {
    const p = await upstream();
    await withVm(
      "djs-hooks",
      { httpHooks: policy.httpHooks, env: policy.env },
      async (vm) => {
        const base = `http://localhost:${p}`;
        const ok = await sh(
          vm,
          curl(p, `-H "Authorization: Bearer $API_TOKEN" ${base}/hello`),
        );
        assert.equal(ok.exitCode, 0, ok.stderr);
        // secrets are substituted after the hook, which saw the placeholder
        assert.equal(
          ok.stdout,
          `GET /hello auth=Bearer ${secret} saw=false len=0\n 200`,
        );

        const short = await sh(vm, curl(p, `${base}/short`));
        assert.equal(short.stdout, "short-circuit\n 201");

        const blocked = await sh(vm, curl(p, `${base}/blocked`));
        assert.match(blocked.stdout, / 451$/);

        // any hook failure denies the request
        const boom = await sh(vm, curl(p, `${base}/boom`));
        assert.match(boom.stdout, / 502$/);

        const forbidden = await sh(
          vm,
          curl(p, `-d 'this is forbidden' ${base}/up`),
        );
        assert.equal(forbidden.stdout, "blocked by hook\n 403");
        const upload = await sh(
          vm,
          `head -c 200000 /dev/zero > /tmp/up.bin && ${curl(p, `-H 'Expect:' --data-binary @/tmp/up.bin ${base}/up`)}`,
        );
        assert.equal(
          upload.stdout,
          "POST /up auth=- saw=false len=200000\n 200",
        );

        const upper = await sh(vm, curl(p, `-i ${base}/upper`));
        assert.match(upper.stdout, /x-hooked: 1/i);
        assert.match(upper.stdout, /GET \/UPPER AUTH=- SAW=FALSE LEN=0\n 200$/);
        const gz = await sh(vm, curl(p, `${base}/gz`));
        assert.equal(gz.stdout, "HELLO GZIP 200");

        // the declarative allowlist still applies around tier 2
        const denied = await sh(
          vm,
          `curl -sS -w ' %{http_code}' --connect-to 127.0.0.2:${p}:${PUBLIC_IP}:${p} http://127.0.0.2:${p}/`,
        );
        assert.match(denied.stdout, / 403$/);
      },
    );
  },
);

const cli = resolveNativeCli();
const guestDir = process.env.GONDOLIN_GUEST_DIR ?? checkoutGuestDir();

test("tier-2 hooks: static CLI --hooks-script", {
  skip:
    skipVmTests ||
    (!cli && "static gondolin CLI not built") ||
    (!guestDir && "no local guest assets"),
  timeout: timeoutMs,
}, async () => {
  const p = await upstream();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-djs-cli-"));
  try {
    // a TypeScript module policy importing a module next to it (read by
    // the CLI); isIpAllowed replaces the built-in internal-range policy (no
    // --allow-host), so the loopback upstream is reachable
    const script = path.join(dir, "policy.ts");
    fs.mkdirSync(path.join(dir, "lib"));
    fs.writeFileSync(
      path.join(dir, "lib", "names.ts"),
      `export const LOCAL: string = "localhost";\n`,
    );
    fs.writeFileSync(
      script,
      `import { LOCAL } from "./lib/names.ts";
interface Info { hostname: string }
export function isIpAllowed(info: Info): boolean { return info.hostname === LOCAL; }
export function onRequest(req: Request): void { req.headers.set("x-saw-secret", "cli"); }
`,
    );
    const r = await new Promise<{
      code: number;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        cli!,
        [
          "exec",
          "--hooks-script",
          script,
          "--",
          "/bin/sh",
          "-c",
          curl(p, `http://localhost:${p}/cli`),
        ],
        {
          env: { ...process.env, GONDOLIN_GUEST_DIR: guestDir! },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "GET /cli auth=- saw=cli len=0\n 200");

    // a policy that does not compile fails the session before boot
    fs.writeFileSync(script, "export function onRequest(req: ) {");
    const bad = await new Promise<{ code: number; stderr: string }>(
      (resolve) => {
        const child = spawn(
          cli!,
          ["exec", "--hooks-script", script, "--", "true"],
          {
            env: { ...process.env, GONDOLIN_GUEST_DIR: guestDir! },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
      },
    );
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /djs_hooks.*policy\.ts/s);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
