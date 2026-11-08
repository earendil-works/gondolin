import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDjsHooks,
  djsHooksOptionsFromFile,
  importSpecifiers,
} from "../src/http/djs-hooks.ts";
import { createHttpHooks } from "../src/http/hooks.ts";
import { compileNetConfig } from "../src/native/net.ts";

const POLICY = `
function isRequestAllowed(req) { return !req.url.includes("/deny"); }
async function onRequest(req) {
  req.headers.set("x-policy", "v1");
  if (new URL(req.url).hostname === "blocked.test") {
    return new Response("nope", { status: 403 });
  }
}
`;

test("createDjsHooks: native engine sends the policy as djs_hooks", () => {
  const hooks = createDjsHooks({
    source: POLICY,
    limits: { fuel: 1000000, timeoutMs: 500 },
  });
  assert.deepEqual(Object.keys(hooks).sort(), [
    "isRequestAllowed",
    "onRequest",
  ]);
  const compiled = compileNetConfig({ httpHooks: hooks, upstreamCaCerts: [] });
  assert.deepEqual(compiled.config.djs_hooks, {
    source: POLICY,
    kind: "script",
    limits: { fuel: 1000000, timeout_ms: 500 },
  });
  // nothing left for tier 3
  assert.equal(compiled.hooks, null);
  assert.deepEqual(compiled.config.hooks, {
    is_request_allowed: false,
    is_ip_allowed: false,
  });
});

test("createDjsHooks composes with createHttpHooks and tier 3", () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["example.com"],
    ...createDjsHooks(POLICY),
    onResponse: () => undefined,
  });
  const compiled = compileNetConfig({ httpHooks, upstreamCaCerts: [] });
  assert.equal(compiled.config.djs_hooks?.source, POLICY);
  assert.deepEqual(compiled.config.policy.rules?.allowed_hosts, [
    "example.com",
  ]);
  // the plain onResponse stays a tier-3 callback
  assert.deepEqual(compiled.config.hooks, {
    is_request_allowed: false,
    is_ip_allowed: false,
    on_response: { body: true },
  });
  assert.ok(compiled.hooks?.onResponse);
  assert.equal(compiled.hooks?.onRequest, undefined);

  const a = createDjsHooks(POLICY);
  const b = createDjsHooks("function isIpAllowed() { return true; }");
  assert.throws(
    () =>
      compileNetConfig({
        httpHooks: { onRequest: a.onRequest, isIpAllowed: b.isIpAllowed },
      }),
    /only one createDjsHooks/,
  );
});

test("createDjsHooks: direct calls run script policies with node's fetch classes", async () => {
  const hooks = createDjsHooks(POLICY);
  assert.equal(
    await hooks.isRequestAllowed!(new Request("http://a.test/ok")),
    true,
  );
  assert.equal(
    await hooks.isRequestAllowed!(new Request("http://a.test/deny")),
    false,
  );
  const req = new Request("http://a.test/");
  assert.equal(await hooks.onRequest!(req), undefined);
  assert.equal(req.headers.get("x-policy"), "v1");
  const res = await hooks.onRequest!(new Request("http://blocked.test/"));
  assert.ok(res instanceof Response);
  assert.equal(res.status, 403);
  // lexical bindings and HttpRequestBlockedError
  const blocking = createDjsHooks(
    "const onRequest = () => { throw new HttpRequestBlockedError('no', 451); };",
  );
  await assert.rejects(
    async () => blocking.onRequest!(new Request("http://a.test/")),
    (e: any) => e.name === "HttpRequestBlockedError" && e.status === 451,
  );
});

test("createDjsHooks: module policies and option validation", async () => {
  const mod = createDjsHooks({
    source: "import { x } from './lib.js'; export function onRequest() {}",
    kind: "module",
    modules: { "lib.js": "export const x = 1;" },
  });
  const compiled = compileNetConfig({ httpHooks: mod, upstreamCaCerts: [] });
  assert.equal(compiled.config.djs_hooks?.kind, "module");
  assert.deepEqual(compiled.config.djs_hooks?.modules, {
    "lib.js": "export const x = 1;",
  });
  // module policies only run inside gondolind: direct calls fail closed
  await assert.rejects(
    async () => mod.onRequest!(new Request("http://a.test/")),
    /only run inside gondolind/,
  );

  assert.throws(
    () => createDjsHooks("function ("),
    (e: any) => e.name === "SyntaxError",
  );
  assert.throws(
    () => createDjsHooks({ source: "", modules: { a: "" } }),
    /kind: "module"/,
  );
  assert.throws(
    () => createDjsHooks({ source: "", limits: { fuel: -1 } }),
    /positive/,
  );
});

test("djsHooksOptionsFromFile: kinds and relative imports from disk", () => {
  assert.deepEqual(
    importSpecifiers(
      "import a from './a.js';\nimport { b } from \"../b.ts\"\nexport * from './c.mjs';\n" +
        "import './side.js'; const m = import ( './dyn.js' );\nconst x = reimport('./no.js');\n" +
        "import deny from './d.json' with { type: 'json' };\nfromage('./no2.js')",
    ),
    ["./a.js", "../b.ts", "./c.mjs", "./side.js", "./dyn.js", "./d.json"],
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-djs-file-"));
  try {
    fs.mkdirSync(path.join(dir, "lib"));
    fs.writeFileSync(
      path.join(dir, "policy.ts"),
      "import { ok } from './lib/hosts.ts';\nimport deny from './deny.json' with { type: 'json' };\nimport './missing.js';\nimport '../outside.js';\nexport function onRequest(req: Request) {}\n",
    );
    fs.writeFileSync(
      path.join(dir, "lib", "hosts.ts"),
      "export { x } from './util.js';\nexport const ok = (h: string) => true;\n",
    );
    fs.writeFileSync(path.join(dir, "lib", "util.js"), "export const x = 1;\n");
    fs.writeFileSync(path.join(dir, "deny.json"), "[]");
    const options = djsHooksOptionsFromFile(path.join(dir, "policy.ts"));
    assert.equal(options.kind, "typescript");
    assert.equal(options.filename, "policy.ts");
    assert.deepEqual(Object.keys(options.modules ?? {}).sort(), [
      "deny.json",
      "lib/hosts.ts",
      "lib/util.js",
    ]);
    fs.writeFileSync(path.join(dir, "p.js"), "import './lib/util.js';");
    assert.deepEqual(djsHooksOptionsFromFile(path.join(dir, "p.js")), {
      source: "import './lib/util.js';",
      filename: "p.js",
      kind: "script",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
