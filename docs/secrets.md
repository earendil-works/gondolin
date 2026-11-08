# Secrets

This page documents how Gondolin handles API keys and tokens so the guest can
use secrets without being able to read them.

See also:

- [Network Access](./network-access.md)
- [HTTP Hooks and Policies](./hooks.md)
- [Security Design](./security.md#secret-non-exposure)

## Quick Model

Gondolin allows you to **not** put real secret values into the VM environment.

Instead, with `createHttpHooks({ secrets: ... })` (or `--host-secret` in the
CLI):

1. The host generates placeholders (by default:
   `<random-marker>.<normalized_secret_name>`)
2. You pass `env` + `httpHooks` into `VM.create(...)`
3. The guest only sees placeholders in env vars
4. On outbound HTTP(S), the host replaces placeholders with the real values,
   but only for hosts the secret is allowed for

By default, Gondolin uses `secretPlaceholderMode: "shared"`: generated secrets
share one random marker and get placeholders like
`<random-marker>.<normalized_secret_name>`.

`secretPlaceholderMode: "unique"` instead gives each generated secret its own
fully random placeholder like `GONDOLIN_SECRET_<random>`.

If a placeholder is used for a disallowed host, the request is blocked.

> **Secrets do not restrict egress.** A secret's `hosts` only say where its
> placeholder may be substituted. Without `allowedHosts` (SDK) or
> `--allow-host` (CLI), the guest can still reach every public host; it just
> cannot get the real secret value sent there. To limit where the guest can
> send data at all, always configure an allowlist next to the secrets, as the
> examples on this page do.

Substitution happens in the Gondolin daemon, as part of the declarative
policy: it costs no round trip to your process and works the same with the
static CLI and [remote daemons](./remote.md).

## CLI Usage

```bash
# reads the real value from $GITHUB_TOKEN on the host
gondolin exec \
  --allow-host api.github.com \
  --host-secret GITHUB_TOKEN@api.github.com \
  -- curl -sS -H 'Authorization: Bearer $GITHUB_TOKEN' https://api.github.com/user
```

`--host-secret NAME@HOST[,HOST...][=VALUE]`:

- If `=VALUE` is omitted, the value is read from the host env var `NAME`
- The Node.js CLI also accepts `NAME[=VALUE]` without hosts: it scans for
  hosts the secret is used with (using a managed `trufflehog` helper) and asks
  you to confirm them. The static `gondolin` CLI requires explicit hosts
- Inside the guest, `$NAME` is a placeholder, not the real value
- `--host-secret` does not restrict egress: without `--allow-host`, every
  public host stays reachable (see
  [Allowing Hosts](./network-access.md#allowing-hosts))

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

The default shared-marker mode is a good fit for most secrets. If you need the
guest-visible value to follow a specific token shape, you can still provide a
custom placeholder explicitly.

A secret can provide a fixed placeholder string or a function that returns one.
The function is called once when `createHttpHooks()` is called.

Custom placeholders must be high-entropy, unique values. Gondolin matches the
exact placeholder bytes in outbound headers (and query strings when enabled), so
low-entropy placeholders can collide with normal request data or other secret
values and cause unintended substitution, request blocking, or skipped
substitution. Prefer `makePlaceholderFunc()` with enough random characters;
fixed placeholders should only be used for compatibility with token-shaped,
high-entropy values. `createHttpHooks()` rejects placeholders that equal the
secret value or overlap with another secret's placeholder.

```ts
import {
  BASE62_ALPHABET,
  createHttpHooks,
  makePlaceholderFunc,
} from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
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

`makePlaceholderFunc({ prefix, suffix, length, alphabet })` defaults to
`HEX_ALPHABET`; `LOWERCASE_ALPHABET`, `UPPERCASE_ALPHABET`, `BASE32_ALPHABET`,
`BASE32_HEX_ALPHABET`, `BASE62_ALPHABET` and `BASE64URL_ALPHABET` are exported
too.

Only the exact generated placeholder value is substituted; Gondolin does not
replace arbitrary strings that merely look like matching tokens.

If you want a fully random placeholder per unnamed secret instead of the
shared-marker format, set `secretPlaceholderMode: "unique"`.

## What Is Substituted

By default, placeholder substitution happens in **request headers** of
mediated HTTP and HTTPS requests.

Supported by default:

- Plain header values (for example `Authorization: Bearer $TOKEN`)
- `Authorization: Basic ...` and `Proxy-Authorization: Basic ...`
    - Gondolin decodes base64 `username:password`, replaces placeholders, and
      re-encodes

```bash
gondolin exec \
  --allow-host example.com \
  --host-secret BASIC_USER@example.com \
  --host-secret BASIC_PASS@example.com \
  -- curl -sS -u "$BASIC_USER:$BASIC_PASS" https://example.com/private
```

Optional:

- URL query string (`replaceSecretsInQuery: true`)

Not substituted:

- Request body
- URL path
- Response content
- [SSH egress](./ssh.md) and [host-mapped TCP](./network-access.md#host-mapped-tcp)
  traffic (these are not HTTP-mediated)

As a defense in depth, a request that carries a secret's **real value** (for
example after a redirect, or because a hook inserted it) to a host the secret
is not allowed for is blocked as well.

## Host Matching and Allowlists

Each secret has its own host pattern allowlist (`secrets.NAME.hosts`). Patterns
are case-insensitive and support `*` wildcards, with the same syntax as
[`allowedHosts`](./network-access.md#allowing-hosts).

`createHttpHooks` keeps the global network host allowlist separate from
per-secret substitution scopes:

- `allowedHosts` controls global egress policy (`undefined` = allow all,
  explicit `[]` = deny all)
- `secrets.*.hosts` only controls where that specific secret may be substituted

So configuring a secret does not narrow or expand the global host allowlist on
its own: `createHttpHooks({ secrets })` without `allowedHosts` (and
`--host-secret` without `--allow-host`) leaves every public host reachable.
Conversely, a secret host that is not in `allowedHosts` is never reached, so
the secret is never used there.

## Rotating and Revoking Secrets

`createHttpHooks()` also returns a `secretManager` for changing secrets while
the VM runs. Changes take effect for the next request, without restarting the
VM, and the placeholder in the guest stays the same:

```ts
const { httpHooks, env, secretManager } = createHttpHooks({
  allowedHosts: ["api.example.com", "*.example.net"],
  secrets: {
    API_KEY: { hosts: ["api.example.com"], value: oldKey },
  },
});
const vm = await VM.create({ httpHooks, env });

// rotate the value and/or change the allowed hosts
secretManager.updateSecret("API_KEY", { value: newKey });
secretManager.updateSecret("API_KEY", { hosts: ["api.example.com", "*.example.net"] });

// from now on the placeholder is replaced by an empty string
secretManager.deleteSecret("API_KEY");

console.log(secretManager.listSecrets()); // [{ name, placeholder, hosts, deleted }]
```

- After `updateSecret()` with a new value, the old value is revoked: requests
  that contain it (in headers, or in the query string with
  `replaceSecretsInQuery`) are blocked for every host.
- After `deleteSecret()`, the placeholder is substituted with an empty string
  and requests containing the deleted value are blocked. A deleted secret
  cannot be updated again.
- Unknown secret names throw.

## Hook Ordering

Secret substitution runs after all `onRequest` hooks, both
[tier-2 policies](./hooks.md#tier-2-policies) and
[hooks in your process](./hooks.md#hooks-in-your-process): a rewritten request
is checked against the per-secret host allowlists, and placeholders a hook
adds are substituted too. See
[Order of Evaluation](./hooks.md#order-of-evaluation).

Important:

- On redirect hops, `onRequest` sees the request derived from the previous
  hop, which may contain substituted secret values (cross-origin redirects
  drop `Authorization` and `Cookie`)
- `isRequestAllowed` and `onResponse` receive the request after substitution
- There is **no guarantee** that hooks only see placeholders

Do not log request headers/URLs from hooks unless you are comfortable
potentially logging real secret values.

## Operational Guidance

- Prefer header-based auth over query parameters
- Keep `replaceSecretsInQuery` disabled unless a target API requires it
- Do not pass real secrets via `VM.env` or image build config `env`
- Do not mount host secret files (`~/.aws`, `.env`, etc.) into the guest
- Treat allowed hosts as trusted egress: guest-readable data can be uploaded
  there, and a guest can send the placeholder to any endpoint of an allowed
  host (including ones that echo the header back)
