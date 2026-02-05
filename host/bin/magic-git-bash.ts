import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { VM } from "../src/vm";
import { createHttpHooks } from "../src/http-hooks";
import { ReadonlyProvider, RealFSProvider, VirtualProvider as VirtualProviderBase } from "../src/vfs";
import type { VirtualProvider, VirtualFileHandle } from "../src/vfs";
import { createErrnoError } from "../src/vfs/errors";

const ALLOWED_HOSTS = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];

const { errno: ERRNO } = os.constants;
const VirtualProviderClass = VirtualProviderBase as unknown as { new (...args: any[]): any };

type ResolvedPath =
  | { kind: "root" }
  | { kind: "owner"; owner: string }
  | { kind: "repo"; owner: string; repo: string; relativePath: string };

class MagicGitProvider extends VirtualProviderClass implements VirtualProvider {
  private readonly cloneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "magic-git-"));
  private readonly owners = new Map<string, string[]>();
  private readonly repos = new Map<string, VirtualProvider>();

  get readonly() {
    return true;
  }

  get supportsSymlinks() {
    return true;
  }

  get supportsWatch() {
    return false;
  }

  async open(entryPath: string, flags: string, mode?: number) {
    return this.openSync(entryPath, flags, mode);
  }

  openSync(entryPath: string, flags: string, mode?: number): VirtualFileHandle {
    if (isWriteFlag(flags)) {
      throw createErrnoError(ERRNO.EROFS, "open", entryPath);
    }
    const resolved = this.resolve(entryPath);
    if (resolved.kind !== "repo" || isRepoRoot(resolved)) {
      throw createErrnoError(ERRNO.EISDIR, "open", entryPath);
    }
    return this.getRepoProvider(resolved).openSync(resolved.relativePath, flags, mode);
  }

  async stat(entryPath: string, options?: object) {
    return this.statSync(entryPath, options);
  }

  statSync(entryPath: string, options?: object) {
    const resolved = this.resolve(entryPath);
    if (resolved.kind === "repo") {
      if (isRepoRoot(resolved)) {
        return createVirtualDirStats();
      }
      return this.getRepoProvider(resolved).statSync(resolved.relativePath, options);
    }
    if (resolved.kind === "owner") {
      this.listRepos(resolved.owner, "stat", entryPath);
    }
    return createVirtualDirStats();
  }

  async lstat(entryPath: string, options?: object) {
    return this.lstatSync(entryPath, options);
  }

  lstatSync(entryPath: string, options?: object) {
    const resolved = this.resolve(entryPath);
    if (resolved.kind === "repo") {
      if (isRepoRoot(resolved)) {
        return createVirtualDirStats();
      }
      return this.getRepoProvider(resolved).lstatSync(resolved.relativePath, options);
    }
    if (resolved.kind === "owner") {
      this.listRepos(resolved.owner, "lstat", entryPath);
    }
    return createVirtualDirStats();
  }

  async readdir(entryPath: string, options?: object) {
    return this.readdirSync(entryPath, options);
  }

  readdirSync(entryPath: string, options?: object) {
    const resolved = this.resolve(entryPath);
    const withTypes = Boolean((options as { withFileTypes?: boolean } | undefined)?.withFileTypes);
    if (resolved.kind === "repo") {
      return this.getRepoProvider(resolved).readdirSync(resolved.relativePath, options);
    }
    if (resolved.kind === "owner") {
      const repos = this.listRepos(resolved.owner, "readdir", entryPath);
      return formatEntries(repos, withTypes);
    }
    const owners = Array.from(this.owners.keys()).sort();
    return formatEntries(owners, withTypes);
  }

  async mkdir(entryPath: string, _options?: object) {
    throw createErrnoError(ERRNO.EROFS, "mkdir", entryPath);
  }

  mkdirSync(entryPath: string, _options?: object) {
    throw createErrnoError(ERRNO.EROFS, "mkdir", entryPath);
  }

  async rmdir(entryPath: string) {
    throw createErrnoError(ERRNO.EROFS, "rmdir", entryPath);
  }

  rmdirSync(entryPath: string) {
    throw createErrnoError(ERRNO.EROFS, "rmdir", entryPath);
  }

  async unlink(entryPath: string) {
    throw createErrnoError(ERRNO.EROFS, "unlink", entryPath);
  }

  unlinkSync(entryPath: string) {
    throw createErrnoError(ERRNO.EROFS, "unlink", entryPath);
  }

  async rename(oldPath: string, _newPath: string) {
    throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
  }

  renameSync(oldPath: string, _newPath: string) {
    throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
  }

  async readlink(entryPath: string, options?: object) {
    return this.readlinkSync(entryPath, options);
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

  async symlink(_target: string, entryPath: string, _type?: string) {
    throw createErrnoError(ERRNO.EROFS, "symlink", entryPath);
  }

  symlinkSync(_target: string, entryPath: string, _type?: string) {
    throw createErrnoError(ERRNO.EROFS, "symlink", entryPath);
  }

  async realpath(entryPath: string, options?: object) {
    return this.realpathSync(entryPath, options);
  }

  realpathSync(entryPath: string, options?: object) {
    const resolved = this.resolve(entryPath);
    if (resolved.kind === "repo") {
      if (isRepoRoot(resolved)) {
        return normalizePath(entryPath);
      }
      const provider = this.getRepoProvider(resolved);
      if (provider.realpathSync) {
        return provider.realpathSync(resolved.relativePath, options);
      }
      return normalizePath(entryPath);
    }
    return normalizePath(entryPath);
  }

  async access(entryPath: string, mode?: number) {
    return this.accessSync(entryPath, mode);
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
    const normalized = normalizePath(entryPath);
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
        { encoding: "utf8" }
      );
      const repos = (JSON.parse(output) as Array<{ name: string }>).map((repo) => repo.name);
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
      execFileSync("gh", ["repo", "clone", key, repoPath], { stdio: "inherit" });
    }

    const provider = new ReadonlyProvider(new RealFSProvider(repoPath));
    this.repos.set(key, provider);
    return provider;
  }
}

class VirtualDirent {
  constructor(public readonly name: string) {}

  isFile() {
    return false;
  }

  isDirectory() {
    return true;
  }

  isSymbolicLink() {
    return false;
  }

  isBlockDevice() {
    return false;
  }

  isCharacterDevice() {
    return false;
  }

  isFIFO() {
    return false;
  }

  isSocket() {
    return false;
  }
}

function createVirtualDirStats() {
  const now = Date.now();
  const stats = Object.create(fs.Stats.prototype) as fs.Stats;
  Object.assign(stats, {
    dev: 0,
    mode: 0o040755,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 4096,
    ino: 0,
    size: 4096,
    blocks: 8,
    atimeMs: now,
    mtimeMs: now,
    ctimeMs: now,
    birthtimeMs: now,
    atime: new Date(now),
    mtime: new Date(now),
    ctime: new Date(now),
    birthtime: new Date(now),
  });
  return stats;
}

function formatEntries(entries: string[], withTypes: boolean) {
  if (!withTypes) return entries;
  return entries.map((entry) => new VirtualDirent(entry) as unknown as fs.Dirent);
}

function normalizePath(inputPath: string) {
  let normalized = path.posix.normalize(inputPath);
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function isRepoRoot(resolved: Extract<ResolvedPath, { kind: "repo" }>) {
  return resolved.relativePath === "/";
}

function isWriteFlag(flags: string): boolean {
  return /[wa+]/.test(flags);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: magic-git-bash");
    console.log();
    console.log("Starts a bash shell with /git mounted and npm/pypi network access.");
    process.exit(0);
  }

  const { httpHooks } = createHttpHooks({ allowedHosts: ALLOWED_HOSTS });
  const vm = new VM({
    httpHooks,
    vfs: { mounts: { "/git": new MagicGitProvider() } },
  });

  try {
    const result = await vm.shell();
    if (result.signal !== undefined) {
      process.stderr.write(`process exited due to signal ${result.signal}\n`);
    }
    await vm.stop();
    process.exit(result.exitCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    await vm.stop();
    process.exit(1);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
