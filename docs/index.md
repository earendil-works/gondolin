# Gondolin Documentation

AI agents are generating code that runs immediately and increasingly without
human review. That code often calls external APIs, which means it needs
credentials and network access. Sandboxing the compute isn't enough as you need
to control network egress and protect secrets from exfiltration. You also
want to be able to tightly control the file system, for convenience of the agent
and to control persistence.

Gondolin gives you that. Lightweight micro-VMs (libkrun where available,
QEMU otherwise) boot in under a second on your Mac or Linux machine. The
network stack and virtual filesystem run on the host, in a small daemon, and
are programmable from JavaScript, giving you complete control
over what the sandbox can access and what secrets it can use.

This documentation helps you get started with it. We also welcome your feedback
as this is an early project and we are eager to learn more about how you want
to use it.

A little appetizer:

```bash
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
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

const vm = await VM.create({ httpHooks, env });

// NOTE:
// - `vm.exec("...")` runs via `/bin/sh -lc "..."` (shell features work)
// - `vm.exec([cmd, ...argv])` executes `cmd` directly (no shell); a bare name
//   is looked up in the guest's `$PATH`
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

## Where to Start

- [Installation](./install.md): requirements and installing the npm package or the static CLI
- [Quick Start](./quickstart.md): a first shell, a first SDK program
- [Workloads and Lifecycle](./workloads.md): how to use VMs for agent workloads
- [Upgrading](./upgrading.md): what changed between releases and what to do about it

## Guides

- [Running Commands](./exec.md): creating VMs, `vm.exec()`, streaming, shells and sessions
- [Network Access](./network-access.md): what the guest can reach, host allowlists, DNS, mapped TCP, TLS
- [HTTP Hooks and Policies](./hooks.md): declarative policy, policies that run in the daemon, and JavaScript hooks
- [Secrets](./secrets.md): placeholder-based secret injection
- [Files and Mounts](./vfs.md): mounting host directories, in-memory and programmable filesystems, `vm.fs`
- [Persistence and Snapshots](./snapshots.md): rootfs modes, disk size and checkpoints
- [Ingress](./ingress.md): expose guest HTTP servers on the host
- [SSH](./ssh.md): SSH into the guest, and SSH from the guest to allowed upstreams
- [Images](./images.md): selecting, downloading and managing guest images
- [Building Custom Images](./custom-images.md): build images with your own packages and init scripts
- [Remote Machines](./remote.md): run the VM on another machine while policy stays local
- [Debugging and Troubleshooting](./debug.md): debug logging and common errors

## Reference

- [CLI](./cli.md): every command and option
- [SDK](./sdk.md): `VMOptions`, the `VM` API and the other exports
- [Environment Variables](./environment.md): every variable Gondolin reads
- [VM Backends](./backends.md): krun and QEMU, how the default is chosen, feature parity

## Design & Internals

- [Architecture](./architecture.md): components, processes and data flow
- [Security Design](./security.md): threat model, guarantees and safe operating envelope
- [Network Stack](./network.md): how traffic is classified, mediated and enforced
- [QEMU Backend](./qemu.md): QEMU integration and macOS/Linux parity
- [Limitations](./limitations.md): current limitations and missing features
