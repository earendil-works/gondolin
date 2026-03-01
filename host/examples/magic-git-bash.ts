/**
 * Magic git bash (example)
 *
 * Starts an interactive bash session with a virtual `/git` mount that lets you
 * browse and lazily clone GitHub repos via the `gh` CLI.
 *
 * Run with:
 *   cd host
 *   node examples/magic-git-bash.ts
 *
 * Requirements:
 * - `gh` installed on the host
 * - `gh auth login` completed (or otherwise authenticated)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHttpHooks } from "../src/http/hooks.ts";
import {
  RealFSProvider,
  type VirtualFileHandle,
  type VirtualProvider,
} from "../src/vfs/node/index.ts";
import { ReadonlyProvider } from "../src/vfs/readonly.ts";
import { ReadonlyVirtualProvider } from "../src/vfs/readonly-virtual.ts";
import {
  createVirtualDirStats,
  formatVirtualEntries,
  normalizeVfsPath,
} from "../src/vfs/utils.ts";
import { createErrnoError } from "../src/vfs/errors.ts";
import { VM } from "../src/vm/core.ts";

const ALLOWED_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
];

const { errno: ERRNO } = os.constants;

type ResolvedPath =
  | { kind: "root" }
  | { kind: "owner"; owner: string }
  | { kind: "repo"; owner: string; repo: string; relativePath: string };

class MagicGitProvider extends ReadonlyVirtualProvider {
  private readonly cloneRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "magic-git-"),
  );
  private readonly owners = new Map<string, string[]>();
  private readonly repos = new Map<string, VirtualProvider>();

  get supportsSymlinks() {
    return true;
  }

  protected openReadonlySync(
    entryPath: string,
    flags: string,
    mode?: number,
  ): VirtualFileHandle {
    const resolved = this.resolve(entryPath);
    if (resolved.kind !== "repo" || isRepoRoot(resolved)) {
      throw createErrnoError(ERRNO.EISDIR, "open", entryPath);
    }
    return this.getRepoProvider(resolved).openSync(
      resolved.relativePath,
      flags,
      mode,
    );
  }

  statSync(entryPath: string, options?: object) {
    const resolved = this.resolve(entryPath);
    if (resolved.kind === "repo") {
      if (isRepoRoot(resolved)) {
        return createVirtualDirStats();
      }
      return this.getRepoProvider(resolved).statSync(
        resolved.relativePath,
        options,
      );
    }
    if (resolved.kind === "owner") {
      this.listRepos(resolved.owner, "stat", entryPath);
    }
    return createVirtualDirStats();
  }

  lstatSync(entryPath: string, options?: object) {
    const resolved = this.resolve(entryPath);
    if (resolved.kind === "repo") {
      if (isRepoRoot(resolved)) {
        return createVirtualDirStats();
      }
      return this.getRepoProvider(resolved).lstatSync(
        resolved.relativePath,
        options,
      );
    }
    if (resolved.kind === "owner") {
      this.listRepos(resolved.owner, "lstat", entryPath);
    }
    return createVirtualDirStats();
  }

  readdirSync(entryPath: string, options?: object) {
    const resolved = this.resolve(entryPath);
    const withTypes = Boolean(
      (options as { withFileTypes?: boolean } | undefined)?.withFileTypes,
    );
    if (resolved.kind === "repo") {
      return this.getRepoProvider(resolved).readdirSync(
        resolved.relativePath,
        options,
      );
    }
    if (resolved.kind === "owner") {
      const repos = this.listRepos(resolved.owner, "readdir", entryPath);
      return formatVirtualEntries(repos, withTypes);
    }
    const owners = Array.from(this.owners.keys()).sort();
    return formatVirtualEntries(owners, withTypes);
  }

  readlinkSync(entryPath: string, options?: object) {
    const resolved = this.resolve(entryPath);
    if (resolved.kind === "repo") {
      if (isRepoRoot(resolved)) {
        throw createErrnoError(ERRNO.EINVAL, "readlink", entryPath);
      }
      const provider = this.getRepoProvider(resolved);
      if (provider.readlinkSync) {
        return provider.readlinkSync(resolved.relativePath, options);
      }
      throw createErrnoError(ERRNO.EINVAL, "readlink", entryPath);
    }
    throw createErrnoError(ERRNO.EINVAL, "readlink", entryPath);
  }

  realpathSync(entryPath: string, options?: object) {
    const resolved = this.resolve(entryPath);
    if (resolved.kind === "repo") {
      if (isRepoRoot(resolved)) {
        return normalizeVfsPath(entryPath);
      }
      const provider = this.getRepoProvider(resolved);
      if (provider.realpathSync) {
        return provider.realpathSync(resolved.relativePath, options);
      }
      return normalizeVfsPath(entryPath);
    }
    return normalizeVfsPath(entryPath);
  }

  accessSync(entryPath: string, mode?: number) {
    const resolved = this.resolve(entryPath);
    if (resolved.kind === "repo") {
      if (isRepoRoot(resolved)) {
        return;
      }
      const provider = this.getRepoProvider(resolved);
      if (provider.accessSync) {
        return provider.accessSync(resolved.relativePath, mode);
      }
      return;
    }
    if (resolved.kind === "owner") {
      this.listRepos(resolved.owner, "access", entryPath);
    }
  }

  async close() {
    fs.rmSync(this.cloneRoot, { recursive: true, force: true });
  }

  private resolve(entryPath: string): ResolvedPath {
    const normalized = normalizeVfsPath(entryPath);
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) return { kind: "root" };
    if (parts.length === 1) return { kind: "owner", owner: parts[0] };
    const [owner, repo, ...rest] = parts;
    const relativePath = rest.length === 0 ? "/" : `/${rest.join("/")}`;
    return { kind: "repo", owner, repo, relativePath };
  }

  private listRepos(owner: string, op: string, entryPath: string) {
    const cached = this.owners.get(owner);
    if (cached) return cached;

    try {
      const output = execFileSync(
        "gh",
        ["repo", "list", owner, "--limit", "1000", "--json", "name"],
        { encoding: "utf8" },
      );
      const repos = (JSON.parse(output) as Array<{ name: string }>).map(
        (repo) => repo.name,
      );
      this.owners.set(owner, repos);
      return repos;
    } catch {
      throw createErrnoError(ERRNO.ENOENT, op, entryPath);
    }
  }

  private getRepoProvider(resolved: Extract<ResolvedPath, { kind: "repo" }>) {
    const key = `${resolved.owner}/${resolved.repo}`;
    const cached = this.repos.get(key);
    if (cached) return cached;

    const repos = this.listRepos(resolved.owner, "stat", `/${resolved.owner}`);
    if (!repos.includes(resolved.repo)) {
      throw createErrnoError(ERRNO.ENOENT, "stat", `/${key}`);
    }

    const repoPath = path.join(this.cloneRoot, resolved.owner, resolved.repo);
    if (!fs.existsSync(repoPath)) {
      fs.mkdirSync(path.dirname(repoPath), { recursive: true });
      execFileSync("gh", ["repo", "clone", key, repoPath], {
        stdio: "inherit",
      });
    }

    const provider = new ReadonlyProvider(new RealFSProvider(repoPath));
    this.repos.set(key, provider);
    return provider;
  }
}

function isRepoRoot(resolved: Extract<ResolvedPath, { kind: "repo" }>) {
  return resolved.relativePath === "/";
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node examples/magic-git-bash.ts");
    console.log();
    console.log(
      "Starts a bash shell with /git mounted and npm/pypi network access.",
    );
    console.log();
    console.log("Inside the VM, try:");
    console.log("  ls -la /git/<owner>/<repo>");
    console.log();
    console.log("Example:");
    console.log("  ls -la /git/earendil-works/gondolin");
    return 0;
  }

  const provider = new MagicGitProvider();
  const { httpHooks } = createHttpHooks({ allowedHosts: ALLOWED_HOSTS });

  let vm: VM | null = null;

  try {
    vm = await VM.create({
      httpHooks,
      vfs: { mounts: { "/git": provider } },
    });

    const result = await vm.shell();
    if (result.signal !== undefined) {
      process.stderr.write(`process exited due to signal ${result.signal}\n`);
    }
    return result.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    try {
      await vm?.close();
    } finally {
      await provider.close();
    }
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
