# HTTP Hooks and Policies

Every HTTP and HTTPS request from the guest is parsed on the host before it is
sent upstream, so you can decide per request whether it may go out, rewrite
it, answer it yourself, or rewrite the response. There are three ways to
program that policy:

| | What | Runs in | Use it for |
| --- | --- | --- | --- |
| [Declarative policy](#declarative-policy) | `createHttpHooks()` options: host allowlists, internal hosts, secrets | the Gondolin daemon (`gondolind`) | everything it can express; it costs nothing per request |
| [Tier-2 policies](#tier-2-policies) | self-contained JavaScript, `createDjsHooks()` or `--hooks-script` | the daemon, in a sandboxed JavaScript engine | path/method/header rules, small rewrites; also from the CLI and with remote daemons |
| [Hooks in your process](#hooks-in-your-process) | `isRequestAllowed`, `isIpAllowed`, `onRequest`, `onResponse` callbacks | your Node.js process | anything that needs your program's state, Node.js APIs or I/O (`fetch`, databases, logging) |

They combine: declarative policy always runs first, then a tier-2 policy, then
your callbacks (see [Order of Evaluation](#order-of-evaluation)). Prefer the
cheapest tier that can express a rule.

```ts
import { VM, createDjsHooks, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  // declarative: evaluated by the daemon
  allowedHosts: ["api.example.com"],
  secrets: {
    API_KEY: { hosts: ["api.example.com"], value: process.env.API_KEY! },
  },
  // tier 2: runs in the daemon
  ...createDjsHooks(`
    function onRequest(request) {
      if (new URL(request.url).pathname.startsWith("/admin")) {
        throw new HttpRequestBlockedError("not allowed", 403);
      }
    }
  `),
  // tier 3: runs in this process
  onResponse: (response, request) => {
    console.log(request.method, request.url, response.status);
  },
});

const vm = await VM.create({ httpHooks, env });
```

What the guest can reach without any hooks, and options such as DNS, mapped
TCP and body limits, are covered in [Network Access](./network-access.md).
Secret placeholders are covered in [Secrets](./secrets.md).

## Declarative Policy

`createHttpHooks(options)` returns `{ httpHooks, env, allowedHosts,
secretManager }`. Pass `httpHooks` and `env` to `VM.create()`; the daemon
evaluates the declarative options itself, without calling back into your
process.

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com", "*.githubusercontent.com"],
  allowedInternalHosts: ["git.corp.example"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

const vm = await VM.create({ httpHooks, env });
const result = await vm.exec(
  'curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user',
);
console.log(result.stdout);
await vm.close();
```

| Option | Meaning |
| --- | --- |
| `allowedHosts` | host patterns (`*` wildcards) mediated requests may go to; omitted: all hosts, `[]`: none (see [Allowing Hosts](./network-access.md#allowing-hosts)) |
| `allowedInternalHosts` | host patterns that may resolve to internal addresses; implicitly allowed (see [Internal Hosts](./network-access.md#internal-hosts)) |
| `blockInternalRanges` | block internal addresses for all other hosts (default: `true`) |
| `secrets` | secrets by env var name: `{ hosts, value, placeholder? }` (see [Secrets](./secrets.md)) |
| `replaceSecretsInQuery` | also substitute placeholders in the URL query string (default: `false`) |
| `secretPlaceholderMode` | `"shared"` (default) or `"unique"` placeholder format |
| `isRequestAllowed`, `isIpAllowed`, `onRequest`, `onResponse` | callbacks: your own functions ([tier 3](#hooks-in-your-process)) or a spread `createDjsHooks()` policy ([tier 2](#tier-2-policies)) |

The CLI flags `--allow-host` and `--host-secret` build the same declarative
policy.

Pass the returned `httpHooks` object as it is. Spreading it
(`{ ...httpHooks, onResponse }`) or replacing one of its methods still works,
but the daemon can no longer see the declarative options and calls the
generated functions in your process for every request instead. Add callbacks
through the `createHttpHooks()` options instead.

## Hooks in Your Process

Hooks are ordinary JavaScript functions in your Node.js process. The daemon
sends each request phase that has a hook to your process and waits for the
answer. Pass them as `createHttpHooks()` options (combined with the declarative
policy, recommended) or directly as `VM.create({ httpHooks: { ... } })`.

```ts
import {
  HttpRequestBlockedError,
  VM,
  createHttpHooks,
} from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["httpbin.org"],
  isRequestAllowed: (request) => request.method !== "DELETE",
  isIpAllowed: ({ ip }) => !ip.startsWith("203.0.113."),
  onRequest: async (request) => {
    if (request.method === "POST") {
      const body = await request.clone().text();
      if (body.includes("forbidden")) {
        throw new HttpRequestBlockedError("body rejected", 422, "Unprocessable Content");
      }
    }
    request.headers.set("x-sandbox", "gondolin");
  },
  onResponse: (response, request) => {
    console.log(request.url, response.status);
  },
});

const vm = await VM.create({ httpHooks, env });
await vm.exec("curl -sS -X POST -d hello https://httpbin.org/post");
await vm.close();
```

All four hooks may be synchronous or return a promise.

### `isRequestAllowed`

`isRequestAllowed(request)` receives a WHATWG `Request` without body (`body` is
always `null`) and returns `true` to allow it or `false` to deny it with
`403 Forbidden`. It is called for each request and redirect hop after the
`onRequest` hooks ran, and, when no `onRequest` hook is registered, also
before the request body is read.

### `isIpAllowed`

`isIpAllowed(info)` is called for every address the request's host resolves to,
with `{ hostname, ip, family, port, protocol }` (`family` is `4` or `6`,
`protocol` is `"http"` or `"https"`). Addresses for which it returns `false`
are skipped; if none is left, the request is denied. It is checked again when
the upstream connection is opened (DNS rebinding protection).

How it combines with the internal-range block:

- With `createHttpHooks()`, it only runs after the allowlist and the
  internal-range block allowed the address, so it can only narrow them.
- Passed directly (`VM.create({ httpHooks: { isIpAllowed } })`), it replaces
  the built-in internal-range block: return `false` for internal addresses
  yourself if you still want them blocked.

### `onRequest`

`onRequest(request)` receives the WHATWG `Request` that is about to be sent
(absolute URL, headers, lazily read body) and returns:

- `undefined` to continue. Changes made to `request.headers` in place are
  kept.
- a `Request` to continue with a rewritten request (a different URL, method,
  headers or body). The rewritten request is checked against the allowlist and
  internal-range block again.
- a `Response` to answer the guest directly ("short-circuit"). No upstream
  request is made, upstream DNS and IP checks are skipped, and `onResponse` is
  not called.

If `onRequest` makes its own `fetch()` from your process and returns that
`Response`, that request is outside Gondolin's egress policy: it goes out with
your process's network access.

GET and HEAD requests that carry a body are rejected with `400` when an
`onRequest` hook is registered.

### `onResponse`

`onResponse(response, request)` receives the upstream `Response` and the
request that produced it (the final hop, after secret substitution). Return
`undefined` to forward the response unchanged or a `Response` to replace it.

Compressed upstream responses (`Content-Encoding: gzip`, `deflate`, ...) are
decoded for the hook, which sees them without `Content-Encoding`, like a
`fetch()` response. When the hook returns `undefined` the guest receives the
original, still compressed, bytes.

### Request and Response Bodies

Bodies are transferred to your process only when a hook reads them
(`text()`, `json()`, `arrayBuffer()`, streaming `body`); an unread body is
streamed through by the daemon.

- Request bodies are one-shot streams. To inspect a body and still forward the
  request, read from `request.clone()`; a clone reads independently instead of
  buffering a second copy. Returning (or continuing with) a request whose body
  the hook consumed is refused with `400 Bad Request`.
- A response body read in `onResponse` is forwarded as received when the hook
  returns `undefined`.
- Bodies read by hooks are limited by `maxHttpBodyBytes` (requests, `413`) and
  `maxHttpResponseBodyBytes` (responses, `502`); both default to 64 MiB (see
  [Body Size Limits](./network-access.md#body-size-limits)).

### Blocking and Errors

Throw `HttpRequestBlockedError(message, status = 403, statusText =
"Forbidden")` from any hook to answer the guest with that status and message.
Any other exception, a rejected promise or an invalid return value fails
closed: the guest gets `502 Bad Gateway`.

### Round-Trip Cost

Each registered hook phase costs one round trip between the daemon and your
process per request (and per redirect hop); phases without a hook cost
nothing. On an Apple M5 Max a no-op `onRequest`/`onResponse` pair adds about
0.29 ms per request. Hooks run on your process's event loop, so slow hooks
delay the requests waiting behind them. Move rules that do not need your
process into a [tier-2 policy](#tier-2-policies) or the declarative options.

## Tier-2 Policies

A tier-2 policy is self-contained JavaScript that the daemon runs itself, on
djs (Earendil's embeddable JavaScript engine, compiled into `gondolind`). It
uses the same hook names and return values as hooks in your process, but needs
no round trip to your process: it is cheaper per request and also works with
the static `gondolin` CLI and with [remote daemons](./remote.md).

```ts
import { VM, createDjsHooks, createHttpHooks } from "@earendil-works/gondolin";

const policy = `
const DENY = ["/admin", "/internal"];

async function onRequest(request) {
  const url = new URL(request.url);
  if (DENY.some((p) => url.pathname.startsWith(p))) {
    throw new HttpRequestBlockedError("path not allowed", 403);
  }
  if (request.method === "POST") {
    const body = await request.clone().text();
    if (body.includes("DROP TABLE")) return new Response("no", { status: 400 });
  }
  request.headers.set("x-sandbox", "gondolin");
}

function onResponse(response) {
  const r = new Response(response.body, response);
  r.headers.delete("server");
  return r;
}
`;

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.example.com"],
  secrets: { API_KEY: { hosts: ["api.example.com"], value: process.env.API_KEY! } },
  ...createDjsHooks(policy),
});
const vm = await VM.create({ httpHooks, env });
```

Spread the result of `createDjsHooks()` into `createHttpHooks()` to combine it
with allowlists and secrets, or pass it on its own as
`VM.create({ httpHooks: createDjsHooks(policy) })`. A VM can have one tier-2
policy.

### From the CLI

Both CLIs take a policy file with `--hooks-script FILE`:

```bash
gondolin bash --allow-host api.example.com --hooks-script policy.js
```

- `.js` (and any other extension) is a script defining the hooks as global
  functions, `.mjs` an ES module exporting them, `.ts`/`.mts` a TypeScript
  module.
- For modules, the CLI reads the files the policy imports with relative
  specifiers (`./lib/hosts.ts`, `./deny.json`), transitively from next to the
  script, and sends them along; the daemon itself never reads files. Bare
  specifiers (`lodash`) and imports above the script's directory are not
  resolved.
- It combines with `--allow-host` and `--host-secret`: the declarative policy
  runs first, and secrets are substituted after the hook.

For SDK users, `djsHooksOptionsFromFile(file)` does the same as the CLI and
returns options for `createDjsHooks()`:

```ts
import { createDjsHooks, djsHooksOptionsFromFile } from "@earendil-works/gondolin";

const hooks = createDjsHooks(djsHooksOptionsFromFile("./policy/index.ts"));
```

### The Contract

A policy defines (script) or exports (module, `kind: "module"` or
`"typescript"`) any of `isRequestAllowed(request)`, `isIpAllowed(info)`,
`onRequest(request)` and `onResponse(response, request)`, with the same
meaning and return values as [hooks in your process](#hooks-in-your-process).
Only the phases it defines are registered, so a policy with only
`onResponse` keeps the fast path for requests.

```js
// policy.mjs
import deny from "./deny.json" with { type: "json" };

export function isRequestAllowed(request) {
  return !deny.paths.some((p) => new URL(request.url).pathname.startsWith(p));
}
```

### Environment

The policy can use `Request`, `Response`, `Headers`, `URL`,
`URLSearchParams`, `HttpRequestBlockedError`, `TextEncoder`/`TextDecoder`,
`atob`/`btoa`, `console` (written to the daemon log, visible with the `net`
[debug flag](./debug.md)) and the standard JavaScript built-ins.

- Bodies stay in the daemon until the policy reads them (`text()`, `json()`,
  `bytes()`, `arrayBuffer()`); an unread body costs nothing and is streamed
  through.
- As in your process, forwarding a request whose body the hook consumed is
  refused (`400`): read from `request.clone()`.
- Compressed responses (`gzip`, `deflate`) are decoded for `onResponse`, as for
  hooks in your process.

### Options

`createDjsHooks(sourceOrOptions)` takes the source string or an options
object:

| Option | Meaning |
| --- | --- |
| `source` | the policy (or pass the source string directly) |
| `kind` | `"script"` (default), `"module"` or `"typescript"` (an ES module whose types are erased, not checked) |
| `filename` | name in stack traces and the module's key (default `policy.js` / `policy.mjs` / `policy.ts`) |
| `modules` | `{ key: source }` a module policy can import (`./lib.js` resolves against `filename`); the key's extension picks the language: `.ts`/`.mts`/`.cts` TypeScript, `.json` a JSON module (`import deny from "./deny.json" with { type: "json" }`), else JavaScript. There is no file or network access: anything else must be bundled into the policy |
| `limits` | `{ fuel, memoryBytes, timeoutMs }` per call (defaults: 50M fuel ≈ 0.2 s of interpretation, 64 MiB heap, 30 s wall clock including body reads) |

```ts
const hooks = createDjsHooks({
  kind: "typescript",
  filename: "policy.ts",
  source: `
    import { ALLOWED } from "./hosts.ts";
    export function isRequestAllowed(request: Request): boolean {
      return ALLOWED.includes(new URL(request.url).hostname);
    }
  `,
  modules: {
    "hosts.ts": `export const ALLOWED: string[] = ["api.example.com"];`,
  },
  limits: { timeoutMs: 5_000 },
});
```

### Evaluation

The daemon compiles the policy once, when the VM is configured; a syntax
error, a missing import or an exception at the top level fails `VM.create()`
(or the CLI) before the VM boots. Every call then starts from that compiled
state: globals a call changes are gone in the next call, and nothing is shared
between requests or VMs. Builtins are frozen. `Date.now()` is the daemon's
clock at the start of the call.

### Fail Closed

An exception, a rejected or never-settling promise, exhausting fuel, memory or
time, a malformed return value (an invalid header, a non-HTTP URL, a bad
status) or an engine error deny the request with `502 Bad Gateway`, like a
throwing hook in your process. `HttpRequestBlockedError` answers with its own
status. The policy cannot catch the budget limits.

A daemon without tier-2 support (older releases, or built without the
`djs-hooks` feature) refuses a configuration with a tier-2 policy instead of
ignoring it.

### Restrictions

Compared with hooks in your process:

- No closures over your program's state and no Node.js or npm APIs (`fs`,
  `process`, `Buffer`, `require`): state comes from the source (generate it
  from your configuration) or from `modules`.
- No outbound I/O: no `fetch()`, timers (`setTimeout`), `AbortSignal`,
  `crypto.subtle` or `crypto.randomUUID`.
- No streams: bodies are whole values within the body limits and the policy's
  heap. `request.body` / `response.body` is an opaque handle that can only be
  passed on (`new Response(response.body, response)` keeps the original body);
  `formData()`, `blob()` and `ReadableStream` are missing. Fetch-only `Request`
  fields (`signal`, `cache`, `mode`, `credentials`, ...) are absent.
- `instanceof` checks against Node.js's own classes do not apply; `URL`,
  `Headers` and friends are the daemon's implementations (URLs parse exactly as
  the egress pipeline parses them).

### Calling the Functions Directly

The functions `createDjsHooks()` returns are ordinary `HttpHooks`. Called
directly in your process (outside a VM, for example in tests), a script policy
runs in a `node:vm` context with Node.js's own fetch classes; globals persist
between calls there, unlike in the daemon. Module and TypeScript policies only
run in the daemon and throw when called directly.

### Performance

Typical cost on an Apple M5 Max (shared machine; `host/bench`, measured from
the guest per request): a no-op `onRequest`/`onResponse` pair adds about
0.23 ms per request as a tier-2 policy against 0.29 ms in your process, and a
policy reading 32 MiB bodies keeps ~415 MB/s downloads (in your process:
~325 MB/s). In the daemon itself, an empty call is ~8 µs and a header
allowlist policy ~38 µs (`cargo run --release -p gondolin-hooks-djs --example
bench`). Engine details and research notes are in
[`native/docs/djs-hooks.md`](https://github.com/earendil-works/gondolin/blob/main/native/docs/djs-hooks.md).

## Order of Evaluation

For each request (and again for each redirect hop):

1. **Request head.** The daemon validates the request. When no `onRequest`
   hook is registered in any tier, `isRequestAllowed`, the allowlist, the
   internal-range block and `isIpAllowed` are checked now, before the body is
   read, so a denied upload is refused early.
2. **`onRequest`.** The tier-2 policy runs first, then your process's hook,
   which sees the request as tier 2 left it (including a replaced body). A
   `Response` or a block in tier 2 ends the phase.
3. **Secrets.** Placeholders are substituted after all `onRequest` hooks, so
   these hooks see placeholders, not secret values, and placeholders a hook
   adds are substituted too.
4. **Policy checks** on the final request: `isRequestAllowed` (tier 2, then
   tier 3), the allowlist, the internal-range block, then `isIpAllowed`
   (tier 2, then tier 3) for each resolved address. Every check must allow;
   the first denial wins.
5. **Upstream request.** The connection is opened to an allowed address and
   the address is checked again at connect time.
6. **Redirects** are followed by the host; the next hop starts again at
   step 2.
7. **`onResponse`.** Tier 2 first, then your process's hook; a `Response`
   from tier 2 is what tier 3 sees.

Because of steps 3, 4 and 6, hooks are not guaranteed to see only
placeholders: `isRequestAllowed` and `onResponse` receive the request after
substitution, and on redirect hops `onRequest` sees a request derived from the
previous hop, which may contain real secret values (cross-origin hops drop
`Authorization` and `Cookie`). Do not log request headers or URLs from hooks
unless that is acceptable. See [Secrets](./secrets.md#hook-ordering).
