# Workloads and Lifecycle

Gondolin is designed for AI agent workloads: short-lived compute with
controlled I/O.  This guide covers typical usage patterns and how to think
about VM lifecycle.

## Target Workload: Run, Persist, Discard

The primary workload Gondolin targets is an agent that:

1. Boots a VM
2. Runs one or more commands (shell scripts, language runtimes, tools)
3. Persists any important results to disk or an external service
4. Discards the VM

Most agent turns produce artifacts on disk (code, config files, logs) and
little in-memory state worth keeping.  Gondolin leans into this: disk
snapshots are supported, but full VM save/restore (RAM + process state) is
not.  See [Snapshots](./snapshots.md) for details.

## Treat VMs as Disposable

Design your workloads so that throwing away a VM is always safe.  This means:

- **Write durable state to VFS mounts.**  The root filesystem is ephemeral by
  default.  Use a [VFS provider](./vfs.md) (e.g. `MemoryProvider`,
  `RealFSProvider`) mounted at a known path like `/workspace` to store files
  you care about.
- **Don't rely on long-running background processes.**  There is no mechanism
  to reconnect to a process inside a discarded VM.
- **Expect re-creation, not resumption.**  While disk checkpoints let you
  capture and restore root-disk state, resuming requires the same kernel and
  rootfs assets.  Over time, as you update guest images, old checkpoints may
  become stale.  Prefer rebuilding state from external sources (repos, APIs,
  object storage) over long-lived snapshots.

## What Persists and What Doesn't

| Location | Backing | Survives VM close? | In disk checkpoints? |
|---|---|---|---|
| Most of `/` (rootfs) | qcow2 overlay | No | Yes |
| `/root`, `/tmp`, `/var/log` | tmpfs | No | No |
| VFS-mounted paths (e.g. `/workspace`) | Host provider | Yes (provider-dependent) | No |

The key takeaway: if you need data to survive, write it to a VFS mount or
extract it via `vm.exec(...)` before closing the VM *and store that state*.

Generally managing persistance is hard, particularly with agents that might
touch completely random places.  Ideally you avoid this problem as much as
you can!

## Lifecycle Guidance for LLM Agents

When integrating Gondolin into an LLM agent loop, a natural lifecycle
boundary is the **conversation turn** or **task**.  There is little benefit
in keeping a VM alive across long idle periods:

- **Cold starts are fast.**  Gondolin VMs boot in under a second, so
  recreating a VM is cheap.
- **Idle VMs waste resources.**  A parked QEMU process still holds memory.
- **LLM context resets anyway.**  If your model's context window or cache
  has gone cold (e.g. after minutes of inactivity), you are effectively
  starting fresh regardless.  Aligning VM lifecycle with context lifecycle
  keeps things simple.

A reasonable default: spin up a VM at the start of a task, run all the
commands the agent needs, persist results, and tear it down.
