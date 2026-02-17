# Secrets Handling

This page documents how Gondolin handles API keys/tokens so the guest can use
secrets without directly reading them.

See also:
- [SDK Networking, Ingress, and SSH](./sdk-network.md)
- [Network Stack](./network.md)
- [Security Design](./security.md)

## Quick Model

Gondolin allows you to **not** put real secret values into the VM environment.

Instead, with `createHttpHooks({ secrets: ... })`:

1. The host generates random placeholders (`GONDOLIN_SECRET_<random>`)
2. You pass `env` + `httpHooks` into `VM.create(...)`
3. The guest only sees placeholders in env vars
4. On outbound HTTP, the host replaces placeholders with real values (only for allowed hosts)

If a placeholder is used for a disallowed host, the request is blocked.

## SDK Usage

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

const vm = await VM.create({ httpHooks, env });
```

Important: pass **both** `httpHooks` and `env`. If you only pass `httpHooks`,
the guest will not have placeholder env vars to reference.

## What Is Substituted

By default, placeholder substitution happens in **request headers**.

Supported by default:
- Plain header values (for example `Authorization: Bearer $TOKEN`)
- `Authorization: Basic ...` and `Proxy-Authorization: Basic ...`
  - Gondolin decodes base64 `username:password`, replaces placeholders, and re-encodes

Optional:
- URL query string (`replaceSecretsInQuery: true`)

Not substituted:
- Request body
- URL path
- Response content

## Host Matching and Allowlists

Each secret has its own host pattern allowlist (`secrets.NAME.hosts`).  Patterns
are case-insensitive and support `*` wildcards.

`createHttpHooks` also builds the final network host allowlist as:

- `allowedHosts` from options
- plus all hosts referenced by `secrets.*.hosts`

So if you omit `allowedHosts` but define secrets, those secret host patterns are
still added to the allowed host set.

## Hook Ordering

`createHttpHooks` applies secret replacement as part of its hook implementation.

Important:

- There is **no guarantee** that custom hooks (`onRequestHead` / `onRequest` / `onResponse`) will only see placeholders
- Depending on control flow (for example redirects), hooks may observe requests where some secrets are already substituted

Do not log request headers/URLs from hooks unless you are comfortable potentially logging real secret values.

## CLI Equivalent

CLI `--host-secret NAME@HOST[,HOST...][=VALUE]` uses the same mechanism.

- If `=VALUE` is omitted, the value is read from host env var `NAME`
- Inside the guest, `$NAME` is a placeholder, not the real value

## Operational guidance

- Prefer header-based auth over query parameters
- Keep `replaceSecretsInQuery` disabled unless a target API requires it
- Do not pass real secrets via `VM.env` or image build config `env`
- Do not mount host secret files (`~/.aws`, `.env`, etc.) into the guest
- Treat allowed hosts as trusted egress: guest-readable data can be uploaded there
