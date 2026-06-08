/**
 * Pi + Gondolin Sandbox Extension
 *
 * Overrides pi's built-in `read`/`write`/`edit`/`bash` tools so they execute
 * inside a Gondolin micro-VM instead of on the host. The directory you start
 * `pi` in is mounted read-write at `/workspace` inside the VM.
 *
 * Installation (recommended):
 *   pi install npm:@earendil-works/gondolin
 *
 * Or load directly from a local checkout:
 *   pi -e /path/to/gondolin/host/extensions/gondolin.ts
 *
 * Configuration (optional, update-safe):
 *   ~/.pi/agent/extensions/gondolin.json   — global defaults
 *   <cwd>/.pi/gondolin.json                — project overrides (merged with global)
 *
 *   Both files share the same schema; array fields (allowedHosts, ssh.allowedHosts)
 *   are merged, scalar fields use project-overrides-global. Example:
 *
 *   {
 *     "allowedHosts": ["api.anthropic.com"],
 *     "allowedInternalHosts": ["litellm.local"],
 *     "secrets": {
 *       "ANTHROPIC_API_KEY": { "hosts": ["api.anthropic.com"] }
 *     },
 *     "blockInternalRanges": true,
 *     "replaceSecretsInQuery": false,
 *     "allowWebSockets": true,
 *     "memory": "2G",
 *     "cpus": 4,
 *     "dns": { "mode": "synthetic", "trustedServers": ["1.1.1.1"] },
 *     "ssh": {
 *       "allowedHosts": ["github.com"],
 *       "agent": true,
 *       "knownHostsFile": "~/.ssh/known_hosts"
 *     },
 *     "tcp": { "hosts": { "db.local": "127.0.0.1:5432" } }
 *   }
 *
 *   Secret values are always read from the matching environment variable at
 *   startup — never store secret values in the config file. ssh.agent: true
 *   reads $SSH_AUTH_SOCK; a string value is used as a literal socket path.
 *
 *   SSH and TCP egress automatically enable synthetic DNS with per-host mapping.
 *
 *   With no config file the VM uses Gondolin's default: all outbound HTTP/TLS
 *   is allowed (no allowlist, no secret injection, no internal-range blocking).
 *
 * Notes:
 *   - The VM is started on `session_start` (and lazily if a tool is used before that)
 *   - User `!` commands are also executed inside the VM
 *   - Requires QEMU (see gondolin README "Quick Start")
 */

import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  getAgentDir,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

import { RealFSProvider, VM, createHttpHooks } from "@earendil-works/gondolin";

import { loadConfig } from "./config.ts";

const GUEST_WORKSPACE = "/workspace";

function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function toGuestPath(localCwd: string, localPath: string): string {
  const rel = path.relative(localCwd, localPath);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(GUEST_WORKSPACE, posixRel);
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      const r = await vm.exec(["/bin/cat", guestPath]);
      if (!r.ok) {
        throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
      }
      return r.stdoutBuffer;
    },
    access: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      const r = await vm.exec([
        "/bin/sh",
        "-lc",
        `test -r ${shQuote(guestPath)}`,
      ]);
      if (!r.ok) {
        throw new Error(`not readable: ${p}`);
      }
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      try {
        const r = await vm.exec([
          "/bin/sh",
          "-lc",
          `file --mime-type -b ${shQuote(guestPath)}`,
        ]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          m,
        )
          ? m
          : null;
      } catch {
        return null;
      }
    },
  };
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p);
      const dir = path.posix.dirname(guestPath);

      const b64 = Buffer.from(content, "utf8").toString("base64");
      const script = [
        `set -eu`,
        `mkdir -p ${shQuote(dir)}`,
        `echo ${shQuote(b64)} | base64 -d > ${shQuote(guestPath)}`,
      ].join("\n");

      const r = await vm.exec(["/bin/sh", "-lc", script]);
      if (!r.ok) {
        throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
      }
    },
    mkdir: async (dir) => {
      const guestDir = toGuestPath(localCwd, dir);
      const r = await vm.exec(["/bin/mkdir", "-p", guestDir]);
      if (!r.ok) {
        throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
      }
    },
  };
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const r = createGondolinReadOps(vm, localCwd);
  const w = createGondolinWriteOps(vm, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function sanitizeEnv(
  env?: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function createGondolinBashOps(vm: VM, localCwd: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const guestCwd = toGuestPath(localCwd, cwd);

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      try {
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          env: sanitizeEnv(env),
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;
  let closed = false;

  async function ensureVm(ctx?: ExtensionContext) {
    if (closed) throw new Error("Gondolin VM is shutting down");
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: starting (mount ${GUEST_WORKSPACE})`,
        ),
      );

      const config = loadConfig(
        path.join(getAgentDir(), "extensions", "gondolin.json"),
        path.join(localCwd, ".pi", "gondolin.json"),
      );
      const secretEntries = Object.entries(config.secrets).filter(
        ([name]) => {
          if (process.env[name] !== undefined) return true;
          console.warn(
            `[gondolin] secret "${name}" configured but $${name} is not set — skipping`,
          );
          return false;
        },
      );
      const needHooks =
        config.allowedHosts.length > 0 ||
        config.allowedInternalHosts.length > 0 ||
        secretEntries.length > 0 ||
        config.blockInternalRanges !== undefined ||
        config.replaceSecretsInQuery !== undefined;
      const hooksResult = needHooks
        ? createHttpHooks({
            ...(config.allowedHosts.length > 0
              ? { allowedHosts: config.allowedHosts }
              : {}),
            ...(config.allowedInternalHosts.length > 0
              ? { allowedInternalHosts: config.allowedInternalHosts }
              : {}),
            ...(config.blockInternalRanges !== undefined
              ? { blockInternalRanges: config.blockInternalRanges }
              : {}),
            ...(config.replaceSecretsInQuery !== undefined
              ? { replaceSecretsInQuery: config.replaceSecretsInQuery }
              : {}),
            secrets: Object.fromEntries(
              secretEntries.map(([name, { hosts }]) => [
                name,
                { hosts, value: process.env[name] ?? "" },
              ]),
            ),
          })
        : null;

      const needsSyntheticDns = config.ssh || config.tcp;

      const created = await VM.create({
        ...(hooksResult
          ? { httpHooks: hooksResult.httpHooks, env: hooksResult.env }
          : {}),
        ...(config.allowWebSockets !== undefined
          ? { allowWebSockets: config.allowWebSockets }
          : {}),
        ...(config.memory ? { memory: config.memory } : {}),
        ...(config.cpus ? { cpus: config.cpus } : {}),
        ...(config.dns || needsSyntheticDns
          ? {
              dns: {
                ...config.dns,
                ...(needsSyntheticDns && (!config.dns?.mode || config.dns.mode === "synthetic")
                  ? { mode: "synthetic" as const, syntheticHostMapping: "per-host" as const }
                  : {}),
              },
            }
          : {}),
        ...(config.ssh
          ? {
              ssh: {
                allowedHosts: config.ssh.allowedHosts,
                ...(config.ssh.agent ? { agent: config.ssh.agent } : {}),
                ...(config.ssh.knownHostsFile
                  ? { knownHostsFile: config.ssh.knownHostsFile }
                  : {}),
              },
            }
          : {}),
        ...(config.tcp ? { tcp: config.tcp } : {}),
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
          },
        },
      });

      vm = created;
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running (${localCwd} -> ${GUEST_WORKSPACE})`,
        ),
      );
      ctx?.ui.notify(
        `Gondolin VM ready. Host ${localCwd} mounted at ${GUEST_WORKSPACE}`,
        "info",
      );
      return created;
    })();

    return vmStarting;
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    closed = true;
    if (!vm) return;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: stopping"),
    );
    try {
      await vm.close();
    } finally {
      vm = null;
      vmStarting = null;
    }
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(localCwd, {
        operations: createGondolinReadOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(localCwd, {
        operations: createGondolinWriteOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(localCwd, {
        operations: createGondolinEditOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    if (closed) return;
    const activeVm = await ensureVm(ctx);
    return { operations: createGondolinBashOps(activeVm, localCwd) };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx);
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, mounted from host: ${localCwd})`,
    );
    return { systemPrompt: modified };
  });
}
