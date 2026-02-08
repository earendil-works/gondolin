# Gondolin Documentation

AI agents are generating code that runs immediately and increasingly without
human review.  That code often calls external APIs, which means it needs
credentials and network access.  Sandboxing the compute isn't enough as you need
to control network egress and protect secrets from exfiltration.  You also
want to be able to tighly control the file system, for convenience of the agent
and to control persistence.

Gondolin gives you that.  Lightweight QEMU micro-VMs boot in under a second on
your Mac or Linux machine.  The network stack and virtual filesystem are
implemented entirely in JavaScript, giving you complete programmatic control
over what the sandbox can access and what secrets it can use.

This documentation helps you get started with it.  We also welcome your feedback
as this is an early project and we are eager to learn more about how you want
to use it.

A little appetizer:

```ts
npx @earendil-works/gondolin bash
```

Or programmatically:

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN,
    },
  },
});

const vm = await VM.create({ httpHooks, env });

// NOTE:
// - `vm.exec("...")` runs via `/bin/sh -lc "..."` (shell features work)
// - `vm.exec([cmd, ...argv])` executes `cmd` directly and does not search `$PATH`
//   so `cmd` must be an absolute path
const cmd = `
  curl -sS -f \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    https://api.github.com/user
`;

// You can pass a string to `vm.exec(...)` as shorthand for `/bin/sh -lc "..."`.
const result = await vm.exec(cmd);

console.log("exitCode:", result.exitCode);
console.log("stdout:\n", result.stdout);
console.log("stderr:\n", result.stderr);

await vm.close();
```

## Using Gondolin

- [Workloads](./workloads.md): typical workloads and lifecycles
- [CLI](./cli.md): run interactive shells and commands inside a micro-VM
- [TypeScript SDK](./sdk.md): programmatic control via the TypeScript/JavaScript API
- [Snapshots](./snapshots.md): disk-only snapshots (qcow2 checkpoints)
- [SSH](./ssh.md): enable SSH access to the guest with safe defaults
- [Debug Logging](./debug.md): how to enable and interpret debug logging

## Images & Filesystem

- [Custom Images](./custom-images.md): build custom guest images (kernel/initramfs/rootfs) and configure packages/init scripts

## Design & Internals

- [Architecture Overview](./architecture.md): high-level component overview and data flow
- [Security Design](./security.md): threat model, guarantees, and safe operating envelope
- [Network Stack](./network.md): HTTP/TLS mediation, policy enforcement, DNS, and DNS rebinding protection
- [QEMU Backend](./qemu.md): QEMU integration and macOS/Linux parity
- [Limitations](./limitations.md): current limitations and missing features
