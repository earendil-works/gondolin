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

1. The host generates placeholders (by default: `<random-marker>.<normalized_secret_name>`)
2. You pass `env` + `httpHooks` into `VM.create(...)`
3. The guest only sees placeholders in env vars
4. On outbound HTTP, the host replaces placeholders with real values (only for allowed hosts)

By default, Gondolin uses `secretPlaceholderMode: "shared"`: generated secrets share one random marker and get placeholders like `<random-marker>.<normalized_secret_name>`.

`secretPlaceholderMode: "unique"` instead gives each generated secret its own fully random placeholder like `GONDOLIN_SECRET_<random>`.

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

## Custom Placeholders

The default shared-marker mode is a good fit for most secrets. If you need the guest-visible value to follow a specific token shape, you can still provide a custom placeholder explicitly.

A secret can provide a fixed placeholder string or a function that returns one.
The function is called once when `createHttpHooks()` is called.

Custom placeholders must be high-entropy, unique values. Gondolin matches the
exact placeholder bytes in outbound headers (and query strings when enabled), so
low-entropy placeholders can collide with normal request data or other secret
values and cause unintended substitution, request blocking, or skipped
substitution. Prefer `makePlaceholderFunc()` with enough random characters;
fixed placeholders should only be used for compatibility with token-shaped,
high-entropy values.

```ts
import {
  BASE62_ALPHABET,
  createHttpHooks,
  makePlaceholderFunc,
} from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
      placeholder: makePlaceholderFunc({
        prefix: "ghp_",
        length: 36,
        suffix: "",
        alphabet: BASE62_ALPHABET,
      }),
    },
  },
});
```

Only the exact generated placeholder value is substituted; Gondolin does not
replace arbitrary strings that merely look like matching tokens.

If you want a fully random placeholder per unnamed secret instead of the shared-marker format, set `secretPlaceholderMode: "unique"`.

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

Each secret has its own host pattern allowlist (`secrets.NAME.hosts`). Patterns
are case-insensitive and support `*` wildcards.

`createHttpHooks` keeps the global network host allowlist separate from per-secret
substitution scopes:

- `allowedHosts` controls global egress policy (`undefined` = allow all, explicit `[]` = deny all)
- `secrets.*.hosts` only controls where that specific secret may be substituted

So configuring a secret does not narrow or expand the global host allowlist on
its own.

## Hook Ordering

`createHttpHooks` applies secret replacement as part of its hook implementation.

Important:

- In `createHttpHooks`, user-provided `onRequest` handlers may run after placeholder substitution
- There is **no guarantee** that custom hooks (`onRequest` / `onResponse`) only see placeholders

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
