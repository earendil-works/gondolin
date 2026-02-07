/**
 * Alpine Linux image builder — pure TypeScript replacement for build.sh.
 *
 * This module handles downloading Alpine packages, resolving APK dependencies,
 * assembling rootfs/initramfs trees, and creating the final images.
 * It eliminates the external dependency on build.sh, python3, and curl.
 *
 * External tool dependencies that remain:
 *   - mke2fs (e2fsprogs) — for creating ext4 rootfs images
 *   - cpio — for creating initramfs archives
 *   - lz4 — for compressing initramfs
 */

import fs from "fs";
import path from "path";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { execFileSync } from "child_process";
import { Readable } from "stream";

import type { Architecture } from "./build-config";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AlpineBuildOptions {
  /** target architecture */
  arch: Architecture;
  /** alpine version (e.g. "3.23.0") */
  alpineVersion: string;
  /** alpine branch (e.g. "v3.23") */
  alpineBranch: string;
  /** full url to the alpine minirootfs tarball (overrides mirror) */
  alpineUrl?: string;
  /** packages to install in the rootfs */
  rootfsPackages: string[];
  /** packages to install in the initramfs */
  initramfsPackages: string[];
  /** path to the sandboxd binary */
  sandboxdBin: string;
  /** path to the sandboxfs binary */
  sandboxfsBin: string;
  /** path to the sandboxssh binary */
  sandboxsshBin: string;
  /** volume label for the rootfs ext4 image */
  rootfsLabel: string;
  /** fixed rootfs image size in `mb` (auto when undefined) */
  rootfsSizeMb?: number;
  /** rootfs init script content (built-in when undefined) */
  rootfsInit?: string;
  /** initramfs init script content (built-in when undefined) */
  initramfsInit?: string;
  /** working directory for intermediate files */
  workDir: string;
  /** directory for caching downloaded files */
  cacheDir: string;
  /** log sink */
  log: (msg: string) => void;
}

export interface AlpineBuildResult {
  /** rootfs ext4 image path */
  rootfsImage: string;
  /** compressed initramfs path */
  initramfs: string;
}

/**
 * Build Alpine rootfs and initramfs images entirely from TypeScript.
 */
export async function buildAlpineImages(
  opts: AlpineBuildOptions
): Promise<AlpineBuildResult> {
  const {
    arch,
    alpineVersion,
    alpineBranch,
    rootfsPackages,
    initramfsPackages,
    sandboxdBin,
    sandboxfsBin,
    sandboxsshBin,
    rootfsLabel,
    rootfsSizeMb,
    workDir,
    cacheDir,
    log,
  } = opts;

  const rootfsDir = path.join(workDir, "rootfs");
  const initramfsDir = path.join(workDir, "initramfs-root");
  const rootfsImage = path.join(workDir, "rootfs.ext4");
  const initramfsOut = path.join(workDir, "initramfs.cpio.lz4");

  const mkfsCmd = findMke2fs();

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  // Step 1 — download Alpine minirootfs
  const tarball = `alpine-minirootfs-${alpineVersion}-${arch}.tar.gz`;
  const tarballPath = path.join(cacheDir, tarball);
  const alpineUrl =
    opts.alpineUrl ??
    `https://dl-cdn.alpinelinux.org/alpine/${alpineBranch}/releases/${arch}/${tarball}`;

  if (!fs.existsSync(tarballPath)) {
    log(`Downloading ${alpineUrl}`);
    await downloadFile(alpineUrl, tarballPath);
  }

  // Step 2 — extract into rootfs and initramfs trees
  fs.rmSync(rootfsDir, { recursive: true, force: true });
  fs.rmSync(initramfsDir, { recursive: true, force: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  fs.mkdirSync(initramfsDir, { recursive: true });

  log("Extracting Alpine minirootfs...");
  await extractTarGz(tarballPath, rootfsDir);
  await extractTarGz(tarballPath, initramfsDir);

  // Step 3 — install APK packages
  if (rootfsPackages.length > 0) {
    log(`Installing rootfs packages: ${rootfsPackages.join(" ")}`);
    await installPackages(rootfsDir, rootfsPackages, arch, cacheDir, log);
  }
  if (initramfsPackages.length > 0) {
    log(`Installing initramfs packages: ${initramfsPackages.join(" ")}`);
    await installPackages(initramfsDir, initramfsPackages, arch, cacheDir, log);
  }

  // Step 4 — install sandboxd, sandboxfs, sandboxssh, init scripts
  copyExecutable(sandboxdBin, path.join(rootfsDir, "usr/bin/sandboxd"));
  copyExecutable(sandboxfsBin, path.join(rootfsDir, "usr/bin/sandboxfs"));
  copyExecutable(sandboxsshBin, path.join(rootfsDir, "usr/bin/sandboxssh"));

  const rootfsInitContent = opts.rootfsInit ?? ROOTFS_INIT_SCRIPT;
  const initramfsInitContent = opts.initramfsInit ?? INITRAMFS_INIT_SCRIPT;
  writeExecutable(path.join(rootfsDir, "init"), rootfsInitContent);
  writeExecutable(path.join(initramfsDir, "init"), initramfsInitContent);

  // Symlink python3 -> python if needed
  const python3 = path.join(rootfsDir, "usr/bin/python3");
  const python = path.join(rootfsDir, "usr/bin/python");
  if (fs.existsSync(python3) && !fs.existsSync(python)) {
    fs.symlinkSync("python3", python);
  }

  // Ensure standard directories exist
  for (const dir of [rootfsDir, initramfsDir]) {
    for (const sub of ["proc", "sys", "dev", "run"]) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
  }

  // Step 5 — copy kernel modules for initramfs
  const modulesBase = path.join(rootfsDir, "lib/modules");
  if (fs.existsSync(modulesBase)) {
    const versions = fs.readdirSync(modulesBase);
    if (versions.length > 0) {
      const kernelVersion = versions[0];
      const srcModules = path.join(modulesBase, kernelVersion);
      const dstModules = path.join(initramfsDir, "lib/modules", kernelVersion);
      log(`Copying kernel modules for ${kernelVersion}`);
      copyInitramfsModules(srcModules, dstModules);
    }
  }

  // Remove /boot from rootfs (kernel lives separately)
  fs.rmSync(path.join(rootfsDir, "boot"), { recursive: true, force: true });

  // Step 6 — create ext4 rootfs image
  log("Creating rootfs ext4 image...");
  createRootfsImage(mkfsCmd, rootfsImage, rootfsDir, rootfsLabel, rootfsSizeMb);

  // Step 7 — create initramfs cpio+lz4
  log("Creating initramfs...");
  createInitramfs(initramfsDir, initramfsOut);

  log(`Rootfs image written to ${rootfsImage}`);
  log(`Initramfs written to ${initramfsOut}`);

  return { rootfsImage, initramfs: initramfsOut };
}

// ---------------------------------------------------------------------------
// Tar extraction (replaces external tar + Python tarfile)
// ---------------------------------------------------------------------------

/** a single entry parsed from a tar archive */
interface TarEntry {
  /** entry name */
  name: string;
  /** tar type flag (0=file, 5=dir, 2=symlink, 1=hardlink) */
  type: number;
  /** file mode bits */
  mode: number;
  /** file size in `bytes` */
  size: number;
  /** link target name */
  linkName: string;
  /** file contents (null for non-files) */
  content: Buffer | null;
}

/**
 * Parse a raw tar archive buffer into entries.
 */
export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);

    // Check for end-of-archive (two zero blocks)
    if (header.every((b) => b === 0)) {
      break;
    }

    const name = readTarString(header, 0, 100);
    const mode = parseInt(readTarString(header, 100, 8), 8) || 0;
    const size = parseInt(readTarString(header, 124, 12), 8) || 0;
    const typeFlag = header[156];
    const linkName = readTarString(header, 157, 100);

    // Handle UStar prefix
    const magic = readTarString(header, 257, 6);
    let fullName = name;
    if (magic === "ustar" || magic === "ustar\0") {
      const prefix = readTarString(header, 345, 155);
      if (prefix) {
        fullName = `${prefix}/${name}`;
      }
    }

    // PAX extended headers (type 'x' or 'g') — read content and skip
    if (typeFlag === 0x78 || typeFlag === 0x67) {
      const blocks = Math.ceil(size / 512);
      offset += 512 + blocks * 512;
      continue;
    }

    const type = typeFlag === 0 || typeFlag === 0x30
      ? 0  // regular file
      : typeFlag === 0x35
        ? 5  // directory
        : typeFlag === 0x32
          ? 2  // symlink
          : typeFlag === 0x31
            ? 1  // hardlink
            : typeFlag;

    offset += 512;

    let content: Buffer | null = null;
    if (size > 0) {
      content = Buffer.from(buf.subarray(offset, offset + size));
      offset += Math.ceil(size / 512) * 512;
    }

    entries.push({ name: fullName, type, mode, size, linkName, content });
  }

  return entries;
}

function readTarString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nullIdx = slice.indexOf(0);
  const end = nullIdx === -1 ? length : nullIdx;
  return slice.subarray(0, end).toString("utf8");
}

/**
 * Decompress a .tar.gz file and return the raw tar buffer.
 */
export async function decompressTarGz(filePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const input = fs.createReadStream(filePath);
  const gunzip = createGunzip();
  const collector = new (require("stream").Writable)({
    write(chunk: Buffer, _encoding: string, cb: () => void) {
      chunks.push(chunk);
      cb();
    },
  });
  await pipeline(input, gunzip, collector);
  return Buffer.concat(chunks);
}

/**
 * Extract a .tar.gz file into a directory (safe against symlink traversal).
 */
async function extractTarGz(tarGzPath: string, destDir: string): Promise<void> {
  const raw = await decompressTarGz(tarGzPath);
  const entries = parseTar(raw);
  extractEntries(entries, destDir);
}

/**
 * Extract tar entries into a directory with symlink-safety checks.
 */
function extractEntries(entries: TarEntry[], destDir: string): void {
  const absRoot = path.resolve(destDir);

  for (const entry of entries) {
    // Skip APK metadata files
    if (entry.name.startsWith(".") && !entry.name.startsWith("./")) {
      continue;
    }

    const target = path.resolve(destDir, entry.name);

    // Guard: target must be inside destDir
    if (!target.startsWith(absRoot + path.sep) && target !== absRoot) {
      continue;
    }

    // Guard: no symlink in any intermediate path component
    if (hasSymlinkComponent(target, absRoot)) {
      process.stderr.write(`skipping symlinked path ${entry.name}\n`);
      continue;
    }

    // Prepare for extraction — remove existing entry if needed
    prepareTarget(target, entry.type === 5);

    if (entry.type === 5) {
      // Directory
      fs.mkdirSync(target, { recursive: true });
    } else if (entry.type === 2) {
      // Symlink
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.symlinkSync(entry.linkName, target);
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
      }
    } else if (entry.type === 1) {
      // Hardlink
      const linkTarget = path.resolve(destDir, entry.linkName);
      if (linkTarget.startsWith(absRoot + path.sep) && fs.existsSync(linkTarget)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          fs.linkSync(linkTarget, target);
        } catch {
          // Fall back to copy
          if (fs.existsSync(linkTarget)) {
            fs.copyFileSync(linkTarget, target);
          }
        }
      }
    } else if (entry.type === 0 && entry.content) {
      // Regular file
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.content);
      try {
        fs.chmodSync(target, entry.mode & 0o7777);
      } catch {
        // chmod may fail on some platforms; ignore
      }
    }
  }
}

/**
 * Check if any intermediate component of `target` (below `root`) is a symlink.
 */
function hasSymlinkComponent(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "." || rel === "") return false;

  let current = root;
  const parts = rel.split(path.sep);
  // Check all components except the final one (the file itself)
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return true;
    } catch {
      // Path doesn't exist yet — safe
      return false;
    }
  }
  return false;
}

/**
 * Prepare a target path for extraction: remove existing entries that conflict.
 */
function prepareTarget(target: string, isDir: boolean): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return; // Doesn't exist, nothing to do
  }

  if (isDir && stat.isDirectory()) return; // Already a directory, fine

  try {
    if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.unlinkSync(target);
    }
  } catch {
    // Try harder: fix permissions then remove
    try {
      fs.chmodSync(target, 0o700);
    } catch {
      // ignore
    }
    try {
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
      }
    } catch {
      // Last resort: ignore
    }
  }
}

// ---------------------------------------------------------------------------
// APK package resolution and installation
// ---------------------------------------------------------------------------

interface ApkMeta {
  /** package name */
  P: string;
  /** package version */
  V: string;
  /** dependencies (space-separated) */
  D?: string;
  /** provides (space-separated) */
  p?: string;
  [key: string]: string | undefined;
}

/**
 * Parse an APKINDEX file into package metadata records.
 */
export function parseApkIndex(content: string): ApkMeta[] {
  const packages: ApkMeta[] = [];
  let current: Record<string, string> = {};

  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (!line) {
      if (current.P) {
        packages.push(current as unknown as ApkMeta);
      }
      current = {};
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    current[line.slice(0, colonIdx)] = line.slice(colonIdx + 1);
  }
  if (current.P) {
    packages.push(current as unknown as ApkMeta);
  }

  return packages;
}

/**
 * Download and install Alpine packages (with dependency resolution)
 * into a target directory.
 */
async function installPackages(
  targetDir: string,
  packages: string[],
  arch: Architecture,
  cacheDir: string,
  log: (msg: string) => void
): Promise<void> {
  // Read repository URLs from the extracted rootfs
  const reposFile = path.join(targetDir, "etc/apk/repositories");
  const repos = fs
    .readFileSync(reposFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  // Build package index from all repos
  const pkgMeta = new Map<string, ApkMeta>();
  const pkgRepo = new Map<string, string>();
  const provides = new Map<string, string>();

  for (const repo of repos) {
    const safeName = repo.replace(/[^A-Za-z0-9]+/g, "_");
    const indexPath = path.join(cacheDir, `APKINDEX-${safeName}-${arch}`);

    if (!fs.existsSync(indexPath)) {
      const tarPath = indexPath + ".tar.gz";
      const url = `${repo}/${arch}/APKINDEX.tar.gz`;
      await downloadFile(url, tarPath);

      // Extract APKINDEX from the tar.gz
      const raw = await decompressTarGz(tarPath);
      const entries = parseTar(raw);
      const indexEntry = entries.find((e) => e.name === "APKINDEX" && e.content);
      if (!indexEntry?.content) {
        throw new Error(`APKINDEX not found in ${url}`);
      }
      fs.writeFileSync(indexPath, indexEntry.content);
    }

    const content = fs.readFileSync(indexPath, "utf8");
    const pkgs = parseApkIndex(content);

    for (const pkg of pkgs) {
      if (pkgMeta.has(pkg.P)) continue;
      pkgMeta.set(pkg.P, pkg);
      pkgRepo.set(pkg.P, repo);
      if (pkg.p) {
        for (const token of pkg.p.split(" ")) {
          const name = token.split("=")[0];
          if (!provides.has(name)) {
            provides.set(name, pkg.P);
          }
        }
      }
    }
  }

  // Resolve dependencies
  const resolvePkg = (dep: string): string | undefined =>
    pkgMeta.has(dep) ? dep : provides.get(dep);

  const normalizeDep = (dep: string): string =>
    dep.replace(/^!/, "").split(/[<>=~]/)[0];

  const needed: string[] = [];
  const seen = new Set<string>();
  const queue = [...packages];

  while (queue.length > 0) {
    const raw = queue.shift()!;
    const dep = normalizeDep(raw);
    if (!dep) continue;

    const pkgName = resolvePkg(dep);
    if (!pkgName) {
      log(`warning: unable to resolve dependency '${dep}'`);
      continue;
    }
    if (seen.has(pkgName)) continue;
    seen.add(pkgName);
    needed.push(pkgName);

    const meta = pkgMeta.get(pkgName)!;
    if (meta.D) {
      for (const token of meta.D.split(" ")) {
        if (token) queue.push(token);
      }
    }
  }

  // Download and extract each package
  for (const pkgName of needed) {
    const meta = pkgMeta.get(pkgName)!;
    const repo = pkgRepo.get(pkgName)!;
    const apkFilename = `${pkgName}-${meta.V}.apk`;
    const apkPath = path.join(cacheDir, `${arch}-${apkFilename}`);

    if (!fs.existsSync(apkPath)) {
      const url = `${repo}/${arch}/${apkFilename}`;
      await downloadFile(url, apkPath);
    }

    const raw = await decompressTarGz(apkPath);
    const entries = parseTar(raw);
    extractEntries(entries, targetDir);
  }
}

// ---------------------------------------------------------------------------
// Download helper (replaces curl)
// ---------------------------------------------------------------------------

export async function downloadFile(url: string, dest: string): Promise<void> {
  // Use undici which is already a dependency of this package
  const { request } = await import("undici");

  let finalUrl = url;
  const maxRedirects = 5;

  for (let i = 0; i <= maxRedirects; i++) {
    const res = await request(finalUrl, {
      method: "GET",
      maxRedirections: maxRedirects,
    });

    if (res.statusCode >= 200 && res.statusCode < 300) {
      const chunks: Buffer[] = [];
      for await (const chunk of res.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      fs.writeFileSync(dest, Buffer.concat(chunks));
      return;
    }

    // Consume body to free the socket
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of res.body) {
      // drain
    }

    throw new Error(`Failed to download ${url}: HTTP ${res.statusCode}`);
  }

  throw new Error(`Too many redirects for ${url}`);
}

// ---------------------------------------------------------------------------
// Kernel module copying for initramfs
// ---------------------------------------------------------------------------

function copyInitramfsModules(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;

  // Parse modules.dep to find transitive dependencies
  const depFile = path.join(srcDir, "modules.dep");
  const deps = new Map<string, string[]>();

  if (fs.existsSync(depFile)) {
    for (const line of fs.readFileSync(depFile, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const mod = trimmed.slice(0, colonIdx);
      const modDeps = trimmed
        .slice(colonIdx + 1)
        .split(/\s+/)
        .filter(Boolean);
      deps.set(mod, modDeps);
    }
  }

  // Required modules for boot
  const required = [
    "kernel/drivers/block/virtio_blk.ko.gz",
    "kernel/fs/ext4/ext4.ko.gz",
  ];

  // Resolve transitive dependencies
  const needed = new Set<string>();
  const stack = [...required];

  while (stack.length > 0) {
    const mod = stack.pop()!;
    if (needed.has(mod)) continue;
    needed.add(mod);
    for (const dep of deps.get(mod) ?? []) {
      stack.push(dep);
    }
  }

  // Copy needed modules
  for (const entry of Array.from(needed).sort()) {
    const src = path.join(srcDir, entry);
    const dst = path.join(dstDir, entry);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }

  // Copy modules.* metadata files
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    if (!entry.startsWith("modules.")) continue;
    const src = path.join(srcDir, entry);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(dstDir, entry));
    }
  }
}

// ---------------------------------------------------------------------------
// Image creation helpers
// ---------------------------------------------------------------------------

/**
 * Find mke2fs / mkfs.ext4 binary.
 */
function findMke2fs(): string {
  // Check PATH first
  for (const cmd of ["mke2fs", "mkfs.ext4"]) {
    try {
      execFileSync("which", [cmd], { stdio: "pipe" });
      return cmd;
    } catch {
      // continue
    }
  }

  // macOS homebrew locations
  if (process.platform === "darwin") {
    const candidates = [
      "/opt/homebrew/opt/e2fsprogs/sbin/mke2fs",
      "/opt/homebrew/opt/e2fsprogs/bin/mke2fs",
      "/opt/homebrew/opt/e2fsprogs/sbin/mkfs.ext4",
      "/opt/homebrew/opt/e2fsprogs/bin/mkfs.ext4",
      "/usr/local/opt/e2fsprogs/sbin/mke2fs",
      "/usr/local/opt/e2fsprogs/bin/mke2fs",
      "/usr/local/opt/e2fsprogs/sbin/mkfs.ext4",
      "/usr/local/opt/e2fsprogs/bin/mkfs.ext4",
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    "Missing required command: mke2fs (install e2fsprogs)\n" +
      "On macOS: brew install e2fsprogs\n" +
      "Then ensure mke2fs is on your PATH (Homebrew: brew --prefix e2fsprogs)"
  );
}

/**
 * Create an ext4 rootfs image from a directory tree.
 */
function createRootfsImage(
  mkfsCmd: string,
  imagePath: string,
  sourceDir: string,
  label: string,
  fixedSizeMb?: number
): void {
  let sizeMb: number;

  if (fixedSizeMb !== undefined) {
    sizeMb = fixedSizeMb;
  } else {
    // Auto-calculate: du -sk equivalent + 20% headroom + 64MB
    const sizeKb = getDirSizeKb(sourceDir);
    const paddedKb = sizeKb + Math.floor(sizeKb / 5) + 65536;
    sizeMb = Math.ceil(paddedKb / 1024);
  }

  execFileSync(
    mkfsCmd,
    [
      "-t", "ext4",
      "-d", sourceDir,
      "-L", label,
      "-m", "0",
      "-O", "^has_journal",
      "-E", "lazy_itable_init=0,lazy_journal_init=0",
      "-b", "4096",
      "-F", imagePath,
      `${sizeMb}M`,
    ],
    { stdio: "pipe" }
  );
}

/**
 * Create a compressed initramfs from a directory tree.
 */
function createInitramfs(sourceDir: string, outputPath: string): void {
  // find . -print0 | cpio --null -ov --format=newc | lz4 -l -c > output
  execFileSync("sh", [
    "-c",
    `cd "${sourceDir}" && find . -print0 | cpio --null -ov --format=newc | lz4 -l -c > "${outputPath}"`,
  ], { stdio: "pipe" });
}

/**
 * Get the size of a directory tree in kilobytes.
 */
function getDirSizeKb(dir: string): number {
  try {
    const output = execFileSync("du", ["-sk", dir], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseInt(output.split(/\s/)[0], 10) || 0;
  } catch {
    // Fallback: walk the tree
    return Math.ceil(walkDirSize(dir) / 1024);
  }
}

function walkDirSize(dir: string): number {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    } else if (entry.isDirectory()) {
      size += walkDirSize(full);
    } else if (entry.isFile()) {
      size += fs.statSync(full).size;
    }
  }
  return size;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function copyExecutable(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
}

function writeExecutable(dest: string, content: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Embedded init scripts (previously in guest/image/)
// ---------------------------------------------------------------------------

const ROOTFS_INIT_SCRIPT = `#!/bin/sh
set -eu

CONSOLE="/dev/console"
if [ ! -c "\${CONSOLE}" ]; then
  if [ -c /dev/ttyAMA0 ]; then
    CONSOLE="/dev/ttyAMA0"
  elif [ -c /dev/ttyS0 ]; then
    CONSOLE="/dev/ttyS0"
  else
    CONSOLE=""
  fi
fi

log() {
  if [ -n "\${CONSOLE}" ]; then
    printf "%s\\n" "$*" > "\${CONSOLE}" 2>/dev/null || printf "%s\\n" "$*"
  else
    printf "%s\\n" "$*"
  fi
}

log_cmd() {
  if [ -n "\${CONSOLE}" ]; then
    "$@" > "\${CONSOLE}" 2>&1 || "$@" || true
  else
    "$@" || true
  fi
}

mount -t proc proc /proc || log "[init] mount proc failed"
mount -t sysfs sysfs /sys || log "[init] mount sysfs failed"
mount -t devtmpfs devtmpfs /dev || log "[init] mount devtmpfs failed"

mkdir -p /dev/pts /dev/shm /run
mount -t devpts devpts /dev/pts || log "[init] mount devpts failed"
mount -t tmpfs tmpfs /run || log "[init] mount tmpfs failed"

export PATH=/usr/sbin:/usr/bin:/sbin:/bin

mkdir -p /tmp /var/tmp /var/cache /var/log /root /home
mount -t tmpfs tmpfs /tmp || log "[init] mount tmpfs /tmp failed"
mount -t tmpfs tmpfs /root || log "[init] mount tmpfs /root failed"
chmod 700 /root || true
mount -t tmpfs tmpfs /var/tmp || log "[init] mount tmpfs /var/tmp failed"
mount -t tmpfs tmpfs /var/cache || log "[init] mount tmpfs /var/cache failed"
mount -t tmpfs tmpfs /var/log || log "[init] mount tmpfs /var/log failed"

mkdir -p /tmp/.cache /tmp/.config /tmp/.local/share

export HOME=/root
export TMPDIR=/tmp
export XDG_CACHE_HOME=/tmp/.cache
export XDG_CONFIG_HOME=/tmp/.config
export XDG_DATA_HOME=/tmp/.local/share
export UV_CACHE_DIR=/tmp/.cache/uv
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export UV_NATIVE_TLS=true

log "[init] /dev entries:"
log_cmd ls -l /dev
if [ -d /dev/virtio-ports ]; then
  log "[init] /dev/virtio-ports:"
  log_cmd ls -l /dev/virtio-ports
else
  log "[init] /dev/virtio-ports missing"
fi
if [ -d /sys/class/virtio-ports ]; then
  log "[init] /sys/class/virtio-ports:"
  log_cmd ls -l /sys/class/virtio-ports
else
  log "[init] /sys/class/virtio-ports missing"
fi

if modprobe virtio_console > /dev/null 2>&1; then
  log "[init] loaded virtio_console"
fi
if modprobe virtio_rng > /dev/null 2>&1; then
  log "[init] loaded virtio_rng"
fi
if [ -e /dev/hwrng ]; then
  log "[init] starting rngd"
  rngd -r /dev/hwrng -o /dev/random > /dev/null 2>&1 &
else
  log "[init] /dev/hwrng missing"
fi

if modprobe virtio_net > /dev/null 2>&1; then
  log "[init] loaded virtio_net"
fi

if command -v ip > /dev/null 2>&1; then
  ip link set lo up || true
  ip link set eth0 up || true
else
  ifconfig lo up || true
  ifconfig eth0 up || true
fi

if command -v udhcpc > /dev/null 2>&1; then
  UDHCPC_SCRIPT="/usr/share/udhcpc/default.script"
  if [ ! -x "\${UDHCPC_SCRIPT}" ]; then
    UDHCPC_SCRIPT="/sbin/udhcpc.script"
  fi
  if [ -x "\${UDHCPC_SCRIPT}" ]; then
    udhcpc -i eth0 -q -n -s "\${UDHCPC_SCRIPT}" || log "[init] udhcpc failed"
  else
    udhcpc -i eth0 -q -n || log "[init] udhcpc failed"
  fi
fi

if modprobe fuse > /dev/null 2>&1; then
  log "[init] loaded fuse"
fi

sandboxfs_mount="/data"
sandboxfs_binds=""

if [ -r /proc/cmdline ]; then
  for arg in \$(cat /proc/cmdline); do
    case "\${arg}" in
      sandboxfs.mount=*)
        sandboxfs_mount="\${arg#sandboxfs.mount=}"
        ;;
      sandboxfs.bind=*)
        sandboxfs_binds="\${arg#sandboxfs.bind=}"
        ;;
    esac
  done
fi

wait_for_sandboxfs() {
  for i in \$(seq 1 300); do
    if grep -q " \${sandboxfs_mount} fuse.sandboxfs " /proc/mounts; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

mkdir -p "\${sandboxfs_mount}"

sandboxfs_ready=0
sandboxfs_error="sandboxfs mount not ready"

if [ -x /usr/bin/sandboxfs ]; then
  log "[init] starting sandboxfs at \${sandboxfs_mount}"
  SANDBOXFS_LOG="\${CONSOLE:-/dev/null}"
  if [ -z "\${SANDBOXFS_LOG}" ]; then
    SANDBOXFS_LOG="/dev/null"
  fi
  /usr/bin/sandboxfs --mount "\${sandboxfs_mount}" --rpc-path /dev/virtio-ports/virtio-fs > "\${SANDBOXFS_LOG}" 2>&1 &

  if wait_for_sandboxfs; then
    sandboxfs_ready=1
    if [ -n "\${sandboxfs_binds}" ]; then
      OLD_IFS="\${IFS}"
      IFS=","
      for bind in \${sandboxfs_binds}; do
        if [ -z "\${bind}" ]; then
          continue
        fi
        mkdir -p "\${bind}"
        if [ "\${sandboxfs_mount}" = "/" ]; then
          bind_source="\${bind}"
        else
          bind_source="\${sandboxfs_mount}\${bind}"
        fi
        log "[init] binding sandboxfs \${bind_source} -> \${bind}"
        log_cmd mount --bind "\${bind_source}" "\${bind}"
      done
      IFS="\${OLD_IFS}"
    fi
  else
    log "[init] sandboxfs mount not ready"
  fi
else
  log "[init] /usr/bin/sandboxfs missing"
  sandboxfs_error="sandboxfs binary missing"
fi

if [ "\${sandboxfs_ready}" -eq 1 ]; then
  printf "ok\\n" > /run/sandboxfs.ready
else
  printf "%s\\n" "\${sandboxfs_error}" > /run/sandboxfs.failed
fi

if [ -x /usr/bin/sandboxssh ]; then
  log "[init] starting sandboxssh"
  /usr/bin/sandboxssh > "\${CONSOLE:-/dev/null}" 2>&1 &
else
  log "[init] /usr/bin/sandboxssh missing"
fi

log "[init] starting sandboxd"

exec /usr/bin/sandboxd
`;

const INITRAMFS_INIT_SCRIPT = `#!/bin/sh
set -eu

CONSOLE="/dev/console"
if [ ! -c "\${CONSOLE}" ]; then
  if [ -c /dev/ttyAMA0 ]; then
    CONSOLE="/dev/ttyAMA0"
  elif [ -c /dev/ttyS0 ]; then
    CONSOLE="/dev/ttyS0"
  else
    CONSOLE=""
  fi
fi

log() {
  if [ -n "\${CONSOLE}" ]; then
    printf "%s\\n" "$*" > "\${CONSOLE}" 2>/dev/null || printf "%s\\n" "$*"
  else
    printf "%s\\n" "$*"
  fi
}

mount -t proc proc /proc || log "[initramfs] mount proc failed"
mount -t sysfs sysfs /sys || log "[initramfs] mount sysfs failed"
mount -t devtmpfs devtmpfs /dev || log "[initramfs] mount devtmpfs failed"

mkdir -p /dev/pts /dev/shm /run
mount -t devpts devpts /dev/pts || log "[initramfs] mount devpts failed"
mount -t tmpfs tmpfs /run || log "[initramfs] mount tmpfs failed"

export PATH=/usr/sbin:/usr/bin:/sbin:/bin

root_device="/dev/vda"
root_fstype="ext4"

# Optional overlayfs root mode.
#
# When enabled, the real root device is mounted read-only as the overlay
# lowerdir and a writable upper/work is provided by tmpfs (or a block device).
# This makes it easy to snapshot all guest writes by archiving the upperdir.
root_overlay=""
root_overlay_fstype="ext4"
root_overlay_tmpfs_opts=""

if [ -r /proc/cmdline ]; then
  for arg in \$(cat /proc/cmdline); do
    case "\${arg}" in
      root=*)
        root_device="\${arg#root=}"
        ;;
      rootfstype=*)
        root_fstype="\${arg#rootfstype=}"
        ;;
      root.overlay=*)
        root_overlay="\${arg#root.overlay=}"
        ;;
      root.overlayfstype=*)
        root_overlay_fstype="\${arg#root.overlayfstype=}"
        ;;
      root.overlaysize=*)
        # tmpfs mount option value, e.g. "256M"
        root_overlay_tmpfs_opts="size=\${arg#root.overlaysize=}"
        ;;
    esac
  done
fi

modprobe virtio_blk > /dev/null 2>&1 || true
modprobe ext4 > /dev/null 2>&1 || true

wait_for_block() {
  dev="$1"
  for i in \$(seq 1 50); do
    if [ -b "\${dev}" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

if ! wait_for_block "\${root_device}"; then
  log "[initramfs] root device \${root_device} not found"
  exec sh
fi

# Default: mount the root filesystem directly.
if [ -z "\${root_overlay}" ]; then
  mkdir -p /newroot
  if ! mount -t "\${root_fstype}" "\${root_device}" /newroot; then
    log "[initramfs] failed to mount \${root_device}"
    exec sh
  fi
else
  modprobe overlay > /dev/null 2>&1 || true

  # Prepare overlay mount tree under /overlayfs so we can move it under the new
  # root before switch_root.
  mkdir -p /overlayfs/lower /overlayfs/upperfs /newroot

  if ! mount -o ro -t "\${root_fstype}" "\${root_device}" /overlayfs/lower; then
    log "[initramfs] failed to mount lower root \${root_device}"
    exec sh
  fi

  if [ "\${root_overlay}" = "tmpfs" ]; then
    if [ -n "\${root_overlay_tmpfs_opts}" ]; then
      if ! mount -t tmpfs -o "\${root_overlay_tmpfs_opts}" tmpfs /overlayfs/upperfs; then
        log "[initramfs] failed to mount tmpfs upper"
        exec sh
      fi
    else
      if ! mount -t tmpfs tmpfs /overlayfs/upperfs; then
        log "[initramfs] failed to mount tmpfs upper"
        exec sh
      fi
    fi
  else
    # Treat root.overlay as a block device path (eg. /dev/vdb)
    overlay_dev="\${root_overlay}"
    if ! wait_for_block "\${overlay_dev}"; then
      log "[initramfs] overlay device \${overlay_dev} not found"
      exec sh
    fi
    mkdir -p /overlayfs/upperfs
    if ! mount -t "\${root_overlay_fstype}" "\${overlay_dev}" /overlayfs/upperfs; then
      log "[initramfs] failed to mount overlay device \${overlay_dev}"
      exec sh
    fi
  fi

  mkdir -p /overlayfs/upperfs/upper
  rm -rf /overlayfs/upperfs/work
  mkdir -p /overlayfs/upperfs/work

  if ! mount -t overlay overlay \
    -o "lowerdir=/overlayfs/lower,upperdir=/overlayfs/upperfs/upper,workdir=/overlayfs/upperfs/work" \
    /newroot; then
    log "[initramfs] overlayfs mount failed"
    exec sh
  fi

  # Keep the overlay backing mounts accessible after switch_root and allow the
  # initramfs root to be unmounted.
  mkdir -p /newroot/.overlayfs/lower /newroot/.overlayfs/upperfs
  if ! mount --move /overlayfs/lower /newroot/.overlayfs/lower; then
    log "[initramfs] failed to move overlay lower mount"
    exec sh
  fi
  if ! mount --move /overlayfs/upperfs /newroot/.overlayfs/upperfs; then
    log "[initramfs] failed to move overlay upper mount"
    exec sh
  fi
fi

mkdir -p /newroot/proc /newroot/sys /newroot/dev /newroot/run

exec switch_root /newroot /init
`;
