# Virtual File System Providers

Gondolin exposes a programmable Virtual File System (VFS) to the guest. The VFS
is backed by host-side providers (JavaScript objects) and is mounted into the
guest via FUSE.

This page documents the built-in providers shipped with the JavaScript SDK and
common patterns for safely sharing a workspace with a sandboxed VM.

## Overview

A VFS setup has three layers:

- The guest runs a FUSE filesystem ("sandboxfs")
- The host translates VFS operations into RPC calls
- A host-side provider (or a stack of providers) implements the filesystem

In the SDK you configure this via `VM.create({ vfs: { ... } })`:

```ts
import { VM, MemoryProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/": new MemoryProvider(),
    },
  },
});
```

## Mounts And Paths

### Mount Map

`vfs.mounts` is a map from an absolute POSIX path to a provider.

- Keys must be absolute POSIX paths (for example: `/workspace`, `/cache`)
- Mounts other than `/` are exposed at their path in the guest (via bind mounts)
- The special mount `/` controls the root of the underlying FUSE mount (at `fuseMount`)
- Providers receive absolute POSIX paths rooted at `/` within their mount

If you provide more than one mount, Gondolin routes operations to the provider
with the longest matching mount prefix.

### FUSE Mount Point

Under the hood Gondolin mounts the VFS once (default mount point: `/data`) and
then bind-mounts individual entries into their configured locations.

You can change the underlying FUSE mount point:

```ts
const vm = await VM.create({
  vfs: {
    fuseMount: "/vfs",
    mounts: {
      "/workspace": new MemoryProvider(),
    },
  },
});
```

Practical consequences:

- Every VFS path is always reachable under the `fuseMount` path as well
- Mounts like `/workspace` are typically visible at both `/workspace` and
  `/data/workspace` (or `/vfs/workspace` if you changed `fuseMount`)

## Built-In Providers

The SDK exports several providers from `@earendil-works/gondolin`.

### Memory Provider

`MemoryProvider` is an in-memory filesystem.

- Fast, disposable, and isolated from the host
- Useful for scratch space, build artifacts, temporary caches
- Not included in disk checkpoints and lost when the VM closes

Common pattern:

- Mount a writable in-memory workspace at `/workspace` for code generation
- Mount a durable host directory at `/out` for artifacts

### Real FS Provider

`RealFSProvider(hostPath)` exposes a directory from the host filesystem.

- Reads and writes affect the host directory
- Symlinks that escape the exposed directory are blocked for operations that follow symlinks (open, stat, readdir, etc.)
- Dangling symlinks are also blocked for follow-style operations (strict fail-closed behavior)
- Operations that act on the symlink entry itself (lstat, readlink, unlink) are allowed
- Use this for persistence (outputs, caches) or for sharing a source tree

Example:

```ts
import path from "node:path";
import { VM, RealFSProvider } from "@earendil-works/gondolin";

const repoDir = path.resolve(".");

const vm = await VM.create({
  vfs: {
    mounts: {
      "/workspace": new RealFSProvider(repoDir),
    },
  },
});
```

### Readonly Provider

`ReadonlyProvider(backend)` wraps another provider and rejects mutations.

Use cases:

- Expose configuration, templates, or fixtures that the guest must not modify
- Mount a host directory for reads while keeping the guest from changing it

Example:

```ts
import path from "node:path";
import { VM, RealFSProvider, ReadonlyProvider } from "@earendil-works/gondolin";

const configDir = path.resolve("./config");

const vm = await VM.create({
  vfs: {
    mounts: {
      "/config": new ReadonlyProvider(new RealFSProvider(configDir)),
    },
  },
});
```

### Shadow Provider

`ShadowProvider(backend, options)` wraps another provider and selectively hides
paths.

- Read-ish operations behave as if the entry does not exist (ENOENT)
- Shadowed entries are omitted from `readdir` results
- Write operations can either be denied or redirected to an in-memory upper
  layer

The shadow policy is a callback:

```ts
import { ShadowProvider } from "@earendil-works/gondolin";

const provider = new ShadowProvider(backend, {
  shouldShadow: ({ path }) => path === "/.env" || path.startsWith("/secrets/"),
});
```

#### Shadow Provider Options

- `shouldShadow`: policy callback that returns `true` for shadowed paths
- `writeMode`: `"deny"` (default) or `"tmpfs"`
- `tmpfs`: provider used as the upper layer when `writeMode` is `"tmpfs"` (default: a new `MemoryProvider`)
- `denySymlinkBypass`: if `true`, also consult `realpath()` to block trivial symlink bypasses (default: `true`)
- `denyWriteErrno`: errno used for denied write operations (default: `EACCES`)

`createShadowPathPredicate([...])` is a convenience helper that shadows exact
paths and their children via prefix matching. It does not support globs.

#### Blocking Access To .env

If you mount a host working tree into the guest, you usually want to ensure
that local secret files are not readable.

Example: mount the repo at `/workspace`, but hide `/.env` and `/.npmrc`:

```ts
import path from "node:path";
import {
  VM,
  RealFSProvider,
  ShadowProvider,
  createShadowPathPredicate,
} from "@earendil-works/gondolin";

const repoDir = path.resolve(".");

const hideSecrets = createShadowPathPredicate(["/.env", "/.npmrc"]);

const workspace = new ShadowProvider(new RealFSProvider(repoDir), {
  shouldShadow: hideSecrets,
  // Default writeMode is "deny"
});

const vm = await VM.create({
  vfs: {
    mounts: {
      "/workspace": workspace,
    },
  },
});
```

Notes:

- Shadow paths are interpreted as absolute VFS paths rooted at `/`
- `createShadowPathPredicate([".env"])` also works; it normalizes to `"/.env"`
- By default `denySymlinkBypass` is enabled to block trivial symlink bypasses

#### Hiding Node Modules But Allowing Installs

A common workflow is to mount a repository into `/workspace` but avoid using the
host `node_modules`. This lets you run `npm install` (or `pnpm install`) inside
the VM from scratch.

To do that, shadow `/node_modules` but set `writeMode: "tmpfs"` so the guest can
create its own `node_modules` directory in memory:

```ts
import path from "node:path";
import {
  VM,
  RealFSProvider,
  ShadowProvider,
  createShadowPathPredicate,
} from "@earendil-works/gondolin";

const repoDir = path.resolve(".");

const base = new RealFSProvider(repoDir);

// First: deny reads/writes to host secret files
const secrets = new ShadowProvider(base, {
  shouldShadow: createShadowPathPredicate(["/.env", "/.npmrc"]),
  writeMode: "deny",
});

// Then: hide the host node_modules, but let the guest write its own
const noHostNodeModules = new ShadowProvider(secrets, {
  shouldShadow: createShadowPathPredicate(["/node_modules"]),
  writeMode: "tmpfs",
});

const vm = await VM.create({
  vfs: {
    mounts: {
      "/workspace": noHostNodeModules,
    },
  },
});

await vm.exec("cd /workspace && npm install");
```

With `writeMode: "tmpfs"`:

- Reads from `/workspace/node_modules` behave like it is empty (unless the guest
  has created files there)
- Writes go to an in-memory layer and do not touch the host directory

This is also useful for hiding other large host directories of potentially the
wrong architecture (for example: `.git`, `.venv`, `dist`) while still allowing
the guest to create its own.

### VFS Hooks

Gondolin also supports basic hooks around VFS operations with `before` and `after`
callbacks:

```ts
import { VM, MemoryProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: { "/": new MemoryProvider() },
    hooks: {
      before: (ctx) => console.log("vfs before", ctx.op, ctx.path),
      after: (ctx) => console.log("vfs after", ctx.op, ctx.path),
    },
  },
});
```

Hooks are useful for:

- Auditing what the guest accessed
- Collecting metrics
- Debugging unexpected file reads

## Provider Composition

Providers are designed to be stackable.

Typical stacks:

- `ReadonlyProvider(new RealFSProvider(...))`
- `ShadowProvider(new RealFSProvider(...), ...)`
- Multiple `ShadowProvider` layers to apply different policies (deny secrets,
  tmpfs for build outputs)

Rule of thumb: put the most security-sensitive policy (for example, blocking
secrets) closest to the real host filesystem provider.

## Custom Providers

If you need behavior beyond the built-ins (filtering, synthetic files, virtual
directories, content generation), you can implement a custom provider.

Recommended starting points:

- Extend `VirtualProviderClass` for a full read/write provider
- Extend `ReadonlyVirtualProvider` for a synchronous, read-only provider

## Gotchas

### Do Not Hide CA Certificates By Accident

Gondolin automatically injects a CA bundle into the guest at `/etc/ssl/certs`
unless you explicitly mount your own provider at that path. This injection works
even when you mount a `MemoryProvider` at `/`, because the mount router uses
longest-prefix matching and the injected `/etc/ssl/certs` mount takes
precedence.

If you do mount your own provider at `/etc/ssl/certs`, you must supply valid CA
certificates yourself, otherwise TLS verification will fail.

### Disk Checkpoints Do Not Include VFS Data

Disk checkpoints capture the VM root disk. Data written to VFS mounts is backed
by the provider (memory or host filesystem) and is not part of checkpoints.
