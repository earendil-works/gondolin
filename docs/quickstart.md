# Quick Start

This page walks through a first CLI session and a first SDK program. It
assumes Gondolin is installed (see [Installation](./install.md)); every
command also works with `npx @earendil-works/gondolin` in place of `gondolin`.

## A First CLI Session

Start an interactive shell in a fresh VM:

```bash
gondolin bash
```

The first start downloads the default image (`alpine-base:latest`, about
200 MB); later starts boot in under a second. Exit the shell and the VM is
gone: changes to the root filesystem are thrown away when the session ends.

### Mount a Project Directory

Make the current directory available in the guest at `/workspace`:

```bash
gondolin bash --mount-hostfs "$PWD:/workspace" --cwd /workspace
```

Writes inside `/workspace` go straight to your host directory. Add `:ro` for a
read-only mount (`--mount-hostfs "$PWD:/workspace:ro"`). The guest sees
nothing else of your host filesystem.

### Allow a Host and Inject a Secret

By default the guest can reach any public HTTP(S) host (internal and private
addresses are blocked). Restrict it to an allowlist and hand it a
credential it never actually sees:

```bash
export GITHUB_TOKEN=ghp_...

gondolin bash \
  --allow-host api.github.com \
  --host-secret GITHUB_TOKEN@api.github.com
```

Inside the VM:

```sh
echo "$GITHUB_TOKEN"     # a random placeholder, not your token
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user
curl -sS https://example.com/   # blocked by the allowlist (HTTP 403)
```

The host replaces the placeholder with the real value in outgoing request
headers, and only for requests to `api.github.com`. See
[Secrets](./secrets.md) and [Network Access](./network-access.md).

### Run a Command Non-Interactively

`gondolin exec` boots a VM, runs one command, prints its output and exits with
its exit code:

```bash
gondolin exec --mount-hostfs "$PWD:/workspace" -- \
  sh -c 'cd /workspace && ls -la'
```

The command after `--` is executed directly, without a shell; use `sh -c` for
pipes, `cd` or `$VARIABLES` that should expand inside the guest.

### Reattach and Inspect

While a `gondolin bash` session runs, other terminals can see and join it:

```bash
gondolin list                    # running sessions
gondolin attach <session-id>     # another shell in the same VM
```

See the [CLI Reference](./cli.md) for every command and option.

## A First SDK Program

Install the package in a project (`npm install @earendil-works/gondolin`) and
save this as `main.ts` (Node.js runs TypeScript files directly since 22.18):

```ts
import { VM, RealFSProvider, createHttpHooks } from "@earendil-works/gondolin";

// allow one host and give the guest a placeholder for the token
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

const vm = await VM.create({
  httpHooks,
  env,
  vfs: {
    // the current directory, read-write, at /workspace
    mounts: { "/workspace": new RealFSProvider(process.cwd()) },
  },
});

try {
  // an argv array runs the program directly
  const files = await vm.exec(["ls", "-la", "/workspace"]);
  console.log(files.stdout);

  // a string runs through `/bin/sh -lc`
  const user = await vm.exec(`
    curl -sS -f \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      https://api.github.com/user
  `);
  console.log("exit code:", user.exitCode);
  console.log(user.stdout);
} finally {
  await vm.close();
}
```

```bash
GITHUB_TOKEN=ghp_... node main.ts
```

`VM.create()` resolves the image (downloading it on first use) and returns;
the VM boots on the first `exec()` (or an explicit `vm.start()`). `exec()` resolves with `exitCode`,
`stdout` and `stderr` (and `ok` for exit code `0`) and does not throw on a
non-zero exit. Always `close()` the VM: it stops the guest and releases its
resources.

## Where Next

- [Workloads and Lifecycle](./workloads.md): how to structure agent workloads
  around disposable VMs
- [Running Commands](./exec.md): streaming output, stdin, interactive shells,
  cancellation
- [Network Access](./network-access.md) and
  [HTTP Hooks and Policies](./hooks.md): allowlists, DNS, mapped TCP, request
  and response hooks
- [Secrets](./secrets.md): how placeholder injection works and its limits
- [Files and Mounts](./vfs.md): host directories, in-memory and custom
  filesystems
- [Persistence and Snapshots](./snapshots.md): root disk modes and checkpoints
- [Images](./images.md) and [Building Custom Images](./custom-images.md)
- [Ingress](./ingress.md) and [SSH](./ssh.md): reach services in the guest
- [Remote Machines](./remote.md): run the VM on another host
- [Debugging and Troubleshooting](./debug.md)
