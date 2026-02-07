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
const result = await vm.exec("\
  curl -H \"Authorization: Bearer $GITHUB_TOKEN\" \
  https://api.github.com/user");
await vm.close();
```

## Guides

- [CLI](./cli.md): Run interactive shells and commands inside a micro-VM
- [SDK (TypeScript) reference](./sdk.md): how to use the JavaScript SDK
- [SSH](./ssh.md): enable SSH access to the guest with safe defaults
- [Debug logging](./debug.md): documents the debug logging facility
- [Custom images](./custom-images.md): how to build custom guest images (kernel/initramfs/rootfs) and configure packages/init scripts

## Architecture

- [Security design](./security.md): Threat model, guarantees, and safe operating envelope
- [Network stack](./network.md): how networking works (HTTP/TLS mediation, policy enforcement, DNS)
- [QEMU](./qemu.md): how Gondolin runs QEMU and how this stays consistent on macOS and Linux
