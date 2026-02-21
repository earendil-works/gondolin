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
 *   - tar (optional) — for fast OCI rootfs extraction
 *   - docker/podman (optional) — for OCI rootfs export
 */

import fs from "fs";
import path from "path";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { execFileSync } from "child_process";

import type {
  Architecture,
  ContainerRuntime,
  OciPullPolicy,
} from "./build-config";
import { parseEnvEntry } from "./env-utils";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface OciRootfsOptions {
  /** OCI image reference (`repo/name[:tag]` or `repo/name@sha256:...`) */
  image: string;
  /** runtime used to pull/create/export OCI images (auto-detect when undefined) */
  runtime?: ContainerRuntime;
  /** image platform override (default: derived from `arch`) */
  platform?: string;
  /** pull behavior before export (default: "if-not-present") */
  pullPolicy?: OciPullPolicy;
}

export interface AlpineBuildOptions {
  /** target architecture */
  arch: Architecture;
  /** alpine version (e.g. "3.23.0") */
  alpineVersion: string;
  /** alpine branch (e.g. "v3.23") */
  alpineBranch: string;
  /** full url to the alpine minirootfs tarball (overrides mirror) */
  alpineUrl?: string;
  /** OCI source used for rootfs extraction (Alpine minirootfs when undefined) */
  ociRootfs?: OciRootfsOptions;
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

  /** path to the sandboxingress binary */
  sandboxingressBin: string;
  /** volume label for the rootfs ext4 image */
  rootfsLabel: string;
  /** fixed rootfs image size in `mb` (auto when undefined) */
  rootfsSizeMb?: number;
  /** rootfs init script content (built-in when undefined) */
  rootfsInit?: string;
  /** initramfs init script content (built-in when undefined) */
  initramfsInit?: string;
  /** extra shell script content appended to rootfs init before sandboxd starts */
  rootfsInitExtra?: string;
  /** shell commands executed in rootfs after package installation */
  postBuildCommands?: string[];
  /** default environment variables baked into the guest image */
  defaultEnv?: Record<string, string> | string[];
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
  opts: AlpineBuildOptions,
): Promise<AlpineBuildResult> {
  const {
    arch,
    alpineVersion,
    alpineBranch,
    rootfsPackages,
    initramfsPackages,
    postBuildCommands = [],
    sandboxdBin,
    sandboxfsBin,
    sandboxsshBin,
    sandboxingressBin,
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

  if (opts.ociRootfs) {
    const runtimeLabel = opts.ociRootfs.runtime ?? "auto-detect";
    log(
      `Extracting OCI rootfs from ${opts.ociRootfs.image} (${runtimeLabel})...`,
    );
    exportOciRootfs({
      arch,
      workDir,
      targetDir: rootfsDir,
      log,
      ...opts.ociRootfs,
    });
  } else {
    log("Extracting Alpine minirootfs for rootfs...");
    await extractTarGz(tarballPath, rootfsDir);
  }

  log("Extracting Alpine minirootfs for initramfs...");
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

  if (opts.ociRootfs && (postBuildCommands.length > 0 || !opts.rootfsInit)) {
    ensureRootfsShell(rootfsDir, opts.ociRootfs.image);
  }

  if (postBuildCommands.length > 0) {
    runPostBuildCommands(rootfsDir, postBuildCommands, arch, log);
  }

  // Step 4 — install sandboxd, sandboxfs, sandboxssh, init scripts
  copyExecutable(sandboxdBin, path.join(rootfsDir, "usr/bin/sandboxd"));
  copyExecutable(sandboxfsBin, path.join(rootfsDir, "usr/bin/sandboxfs"));
  copyExecutable(sandboxsshBin, path.join(rootfsDir, "usr/bin/sandboxssh"));
  copyExecutable(
    sandboxingressBin,
    path.join(rootfsDir, "usr/bin/sandboxingress"),
  );

  let rootfsInitContent = opts.rootfsInit ?? ROOTFS_INIT_SCRIPT;

  const imageEnvScript = opts.defaultEnv
    ? generateImageEnvScript(opts.defaultEnv)
    : null;
  if (imageEnvScript) {
    const envPath = path.join(rootfsDir, "etc/profile.d/gondolin-image-env.sh");
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, imageEnvScript, { mode: 0o644 });

    rootfsInitContent = injectBeforeSandboxdExec(
      rootfsInitContent,
      `# Load image default environment (generated by gondolin build)\n` +
        `if [ -r /etc/profile.d/gondolin-image-env.sh ]; then\n` +
        `  . /etc/profile.d/gondolin-image-env.sh\n` +
        `fi\n`,
    );
  }

  if (opts.rootfsInitExtra) {
    rootfsInitContent = injectBeforeSandboxdExec(
      rootfsInitContent,
      opts.rootfsInitExtra,
    );
  }

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

  // Step 5 — copy kernel modules for initramfs/rootfs
  syncKernelModules(rootfsDir, initramfsDir, log);

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

    const type =
      typeFlag === 0 || typeFlag === 0x30
        ? 0 // regular file
        : typeFlag === 0x35
          ? 5 // directory
          : typeFlag === 0x32
            ? 2 // symlink
            : typeFlag === 0x31
              ? 1 // hardlink
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
      if (
        linkTarget.startsWith(absRoot + path.sep) &&
        fs.existsSync(linkTarget)
      ) {
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

function ensureRootfsShell(rootfsDir: string, ociImage?: string): void {
  const shellPath = path.join(rootfsDir, "bin/sh");
  if (fs.existsSync(shellPath)) {
    return;
  }

  if (ociImage) {
    throw new Error(
      `OCI rootfs image '${ociImage}' does not contain /bin/sh. ` +
        "Provide an image with a POSIX shell or set init.rootfsInit to a custom init script.",
    );
  }

  throw new Error(`Rootfs is missing required shell at ${shellPath}`);
}

interface OciExportOptions extends OciRootfsOptions {
  /** target architecture */
  arch: Architecture;
  /** working directory for temporary export files */
  workDir: string;
  /** rootfs extraction target directory */
  targetDir: string;
  /** log sink */
  log: (msg: string) => void;
}

function exportOciRootfs(opts: OciExportOptions): void {
  const runtime = detectOciRuntime(opts.runtime);
  const platform = opts.platform ?? getOciPlatform(opts.arch);
  const pullPolicy = opts.pullPolicy ?? "if-not-present";

  if (pullPolicy === "always") {
    pullOciImage(runtime, opts.image, platform, opts.log);
  } else {
    const hasImage = hasLocalOciImage(runtime, opts.image);
    if (!hasImage && pullPolicy === "never") {
      throw new Error(
        `OCI image '${opts.image}' is not available locally and pullPolicy is 'never'`,
      );
    }
    if (!hasImage) {
      pullOciImage(runtime, opts.image, platform, opts.log);
    }
  }

  const containerId = createOciExportContainer(
    runtime,
    opts.image,
    platform,
    opts.log,
  );
  const exportTar = path.join(opts.workDir, "oci-rootfs.tar");

  try {
    runContainerCommand(runtime, ["export", containerId, "-o", exportTar]);
    extractTarFile(exportTar, opts.targetDir);
  } finally {
    try {
      runContainerCommand(runtime, ["rm", "-f", containerId]);
    } catch {
      // Best effort cleanup.
    }
    fs.rmSync(exportTar, { force: true });
  }
}

function getOciPlatform(arch: Architecture): string {
  return arch === "x86_64" ? "linux/amd64" : "linux/arm64";
}

function detectOciRuntime(preferred?: ContainerRuntime): ContainerRuntime {
  if (preferred) {
    if (!hasContainerRuntime(preferred)) {
      throw new Error(
        `Container runtime '${preferred}' is required for OCI rootfs builds but was not found on PATH`,
      );
    }
    return preferred;
  }

  for (const runtime of ["docker", "podman"] as const) {
    if (hasContainerRuntime(runtime)) {
      return runtime;
    }
  }

  throw new Error(
    "OCI rootfs builds require Docker or Podman to pull and export the image",
  );
}

function hasContainerRuntime(runtime: ContainerRuntime): boolean {
  try {
    execFileSync(runtime, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasLocalOciImage(runtime: ContainerRuntime, image: string): boolean {
  try {
    runContainerCommand(runtime, ["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}

function pullOciImage(
  runtime: ContainerRuntime,
  image: string,
  platform: string,
  log: (msg: string) => void,
): void {
  log(`Pulling OCI image ${image} (${platform}) with ${runtime}`);
  runContainerCommand(runtime, ["pull", "--platform", platform, image]);
}

function createOciExportContainer(
  runtime: ContainerRuntime,
  image: string,
  platform: string,
  log: (msg: string) => void,
): string {
  log(`Creating OCI export container from ${image}`);
  const output = runContainerCommand(runtime, [
    "create",
    "--platform",
    platform,
    image,
  ]);
  const id = output.trim().split(/\s+/)[0];
  if (!id) {
    throw new Error(`Failed to create OCI export container for '${image}'`);
  }
  return id;
}

function runContainerCommand(
  runtime: ContainerRuntime,
  args: string[],
): string {
  try {
    return execFileSync(runtime, args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (err) {
    const e = err as {
      status?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";

    throw new Error(
      `Container command failed: ${runtime} ${args.join(" ")}\n` +
        `exit: ${String(e.status ?? "?")}\n` +
        (stdout || stderr ? `${stdout}${stderr}` : ""),
    );
  }
}

function extractTarFile(tarPath: string, destDir: string): void {
  try {
    execFileSync("tar", ["-xf", tarPath, "-C", destDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return;
  } catch (err) {
    const e = err as {
      code?: unknown;
      status?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };

    if (e.code !== "ENOENT") {
      const stdout = typeof e.stdout === "string" ? e.stdout : "";
      const stderr = typeof e.stderr === "string" ? e.stderr : "";
      throw new Error(
        `Failed to extract OCI rootfs tar with tar (exit ${String(e.status ?? "?")}): ` +
          `${tarPath}\n` +
          (stdout || stderr ? `${stdout}${stderr}` : ""),
      );
    }
  }

  // Fallback to in-process extraction when tar is unavailable.
  const raw = fs.readFileSync(tarPath);
  const entries = parseTar(raw);
  extractEntries(entries, destDir);
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
  log: (msg: string) => void,
): Promise<void> {
  // Read repository URLs from the extracted rootfs
  const reposFile = path.join(targetDir, "etc/apk/repositories");
  if (!fs.existsSync(reposFile)) {
    throw new Error(
      `Cannot install APK packages into ${targetDir}: missing ${reposFile}`,
    );
  }

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
      const indexEntry = entries.find(
        (e) => e.name === "APKINDEX" && e.content,
      );
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

export function runPostBuildCommands(
  rootfsDir: string,
  commands: string[],
  targetArch: Architecture,
  log: (msg: string) => void,
): void {
  if (process.platform !== "linux") {
    throw new Error(
      "postBuild.commands requires a Linux build environment. Set container.force=true when building on macOS.",
    );
  }

  const runtimeArch = detectRuntimeArch();
  if (runtimeArch !== targetArch) {
    throw new Error(
      `postBuild.commands cannot run for arch '${targetArch}' on runtime arch '${runtimeArch}'. ` +
        "Build with matching --arch or disable postBuild.commands.",
    );
  }

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error(
      "postBuild.commands requires root privileges to chroot into the image. " +
        "Run inside a container (container.force=true) or as root.",
    );
  }

  const root = path.resolve(rootfsDir);
  const shellPath = path.join(root, "bin/sh");
  if (!fs.existsSync(shellPath)) {
    throw new Error(`postBuild.commands requires ${shellPath}`);
  }

  const cleanupResolvConf = ensureResolvConf(root);
  let cleanupProc = () => {};

  try {
    cleanupProc = ensureProcMounted(root);

    for (let i = 0; i < commands.length; i += 1) {
      const command = commands[i];
      if (!command.trim()) {
        continue;
      }

      log(`[postBuild] (${i + 1}/${commands.length}) ${command}`);

      try {
        const stdout = execFileSync(
          "chroot",
          [root, "/bin/sh", "-lc", command],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        if (stdout) {
          process.stderr.write(stdout);
        }
      } catch (err) {
        const e = err as {
          stdout?: unknown;
          stderr?: unknown;
          status?: unknown;
        };
        const stdout = typeof e.stdout === "string" ? e.stdout : "";
        const stderr = typeof e.stderr === "string" ? e.stderr : "";

        throw new Error(
          `postBuild command failed (${i + 1}/${commands.length}): ${command}\n` +
            `exit: ${String(e.status ?? "?")}\n` +
            (stdout || stderr ? `${stdout}${stderr}` : ""),
        );
      }
    }
  } finally {
    cleanupProc();
    cleanupResolvConf();
  }
}

function detectRuntimeArch(): Architecture {
  if (process.arch === "arm64") {
    return "aarch64";
  }
  if (process.arch === "x64") {
    return "x86_64";
  }
  throw new Error(
    `Unsupported runtime architecture for postBuild.commands: ${process.arch}`,
  );
}

function ensureResolvConf(rootfsDir: string): () => void {
  const rootfsResolv = path.join(rootfsDir, "etc/resolv.conf");
  if (fs.existsSync(rootfsResolv)) {
    return () => {};
  }

  const hostResolv = "/etc/resolv.conf";
  if (!fs.existsSync(hostResolv)) {
    return () => {};
  }

  fs.mkdirSync(path.dirname(rootfsResolv), { recursive: true });
  fs.copyFileSync(hostResolv, rootfsResolv);

  return () => {
    fs.rmSync(rootfsResolv, { force: true });
  };
}

function ensureProcMounted(rootfsDir: string): () => void {
  const rootfsProc = path.join(rootfsDir, "proc");
  fs.mkdirSync(rootfsProc, { recursive: true });

  try {
    execFileSync("mount", ["-t", "proc", "proc", rootfsProc], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as {
      stderr?: unknown;
      stdout?: unknown;
      status?: unknown;
    };
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    const stdout = typeof e.stdout === "string" ? e.stdout.trim() : "";
    const detail = stderr || stdout;

    throw new Error(
      `postBuild.commands requires mounting procfs in the chroot, but mounting '${rootfsProc}' failed` +
        ` (exit ${String(e.status ?? "?")})` +
        (detail ? `: ${detail}` : "") +
        ". Ensure the build runs as root with mount permissions (native Linux root or privileged container).",
    );
  }

  return () => {
    try {
      execFileSync("umount", [rootfsProc], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Best effort cleanup.
    }
  };
}

// ---------------------------------------------------------------------------
// Download helper (replaces curl)
// ---------------------------------------------------------------------------

export async function downloadFile(url: string, dest: string): Promise<void> {
  // Use Node's built-in `fetch` (available in Node >= 18)
  // so the builder can run in minimal environments (e.g. containers)
  // without any extra npm dependencies.
  const res = await fetch(url, { redirect: "follow" });

  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

// ---------------------------------------------------------------------------
// Kernel module copying for initramfs
// ---------------------------------------------------------------------------

const MODULE_FILE_SUFFIXES = [".ko", ".ko.gz", ".ko.xz", ".ko.zst"] as const;
const REQUIRED_INITRAMFS_MODULES = ["virtio_blk", "ext4"] as const;

function syncKernelModules(
  rootfsDir: string,
  initramfsDir: string,
  log: (msg: string) => void,
): void {
  const rootfsModulesBase = path.join(rootfsDir, "lib/modules");
  const initramfsModulesBase = path.join(initramfsDir, "lib/modules");

  const rootfsVersions = listKernelModuleVersions(rootfsModulesBase);
  const initramfsVersions = listKernelModuleVersions(initramfsModulesBase);

  for (const kernelVersion of rootfsVersions) {
    const srcModules = path.join(rootfsModulesBase, kernelVersion);
    const dstModules = path.join(initramfsModulesBase, kernelVersion);
    log(`Copying kernel modules for ${kernelVersion} into initramfs`);
    copyInitramfsModules(srcModules, dstModules);
  }

  const knownRootfsVersions = new Set(rootfsVersions);
  for (const kernelVersion of initramfsVersions) {
    if (knownRootfsVersions.has(kernelVersion)) {
      continue;
    }

    const srcModules = path.join(initramfsModulesBase, kernelVersion);
    const dstModules = path.join(rootfsModulesBase, kernelVersion);
    log(`Copying all kernel modules for ${kernelVersion} into rootfs`);
    copyAllKernelModules(srcModules, dstModules);
  }
}

function listKernelModuleVersions(modulesBase: string): string[] {
  if (!fs.existsSync(modulesBase)) {
    return [];
  }

  return fs
    .readdirSync(modulesBase)
    .filter((entry) =>
      fs.statSync(path.join(modulesBase, entry), {
        throwIfNoEntry: false,
      })?.isDirectory(),
    )
    .sort();
}

function copyAllKernelModules(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;

  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  fs.cpSync(srcDir, dstDir, { recursive: true, dereference: false });
}

function copyInitramfsModules(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;

  const deps = readModuleDependencies(srcDir);
  const modulePathByName = indexModulePathsByName(srcDir, deps);
  const builtinModuleNames = readBuiltinModuleNames(srcDir);

  // Resolve required modules by module name (not file suffix)
  const stack: string[] = [];
  for (const moduleName of REQUIRED_INITRAMFS_MODULES) {
    const normalizedName = normalizeModuleName(moduleName);
    const resolvedPath = modulePathByName.get(normalizedName);
    if (resolvedPath) {
      stack.push(resolvedPath);
      continue;
    }
    if (!builtinModuleNames.has(normalizedName)) {
      throw new Error(
        `Required kernel module "${moduleName}" was not found in ${srcDir}`,
      );
    }
  }

  // Resolve transitive dependencies from modules.dep
  const needed = new Set<string>();
  while (stack.length > 0) {
    const modulePath = stack.pop()!;
    if (needed.has(modulePath)) continue;
    needed.add(modulePath);

    for (const depPath of deps.get(modulePath) ?? []) {
      const resolvedDepPath = resolveModulePath(
        srcDir,
        depPath,
        modulePathByName,
      );
      if (resolvedDepPath) {
        stack.push(resolvedDepPath);
        continue;
      }

      const depName = normalizeModuleName(moduleNameFromPath(depPath));
      if (!builtinModuleNames.has(depName)) {
        throw new Error(
          `Kernel module dependency "${depPath}" referenced by "${modulePath}" was not found in ${srcDir}`,
        );
      }
    }
  }

  // Copy needed module files
  for (const entry of Array.from(needed).sort()) {
    const src = path.join(srcDir, entry);
    if (!fs.existsSync(src)) {
      const moduleName = normalizeModuleName(moduleNameFromPath(entry));
      if (!builtinModuleNames.has(moduleName)) {
        throw new Error(`Kernel module "${entry}" is missing from ${srcDir}`);
      }
      continue;
    }

    const dst = path.join(dstDir, entry);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
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

function readModuleDependencies(srcDir: string): Map<string, string[]> {
  const depFile = path.join(srcDir, "modules.dep");
  const deps = new Map<string, string[]>();

  if (!fs.existsSync(depFile)) {
    return deps;
  }

  for (const line of fs.readFileSync(depFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const modulePath = normalizeModulePath(trimmed.slice(0, colonIdx));
    const moduleDeps = trimmed
      .slice(colonIdx + 1)
      .split(/\s+/)
      .filter(Boolean)
      .map((entry) => normalizeModulePath(entry));

    deps.set(modulePath, moduleDeps);
  }

  return deps;
}

function readBuiltinModuleNames(srcDir: string): Set<string> {
  const builtinFile = path.join(srcDir, "modules.builtin");
  const names = new Set<string>();

  if (!fs.existsSync(builtinFile)) {
    return names;
  }

  for (const line of fs.readFileSync(builtinFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    names.add(normalizeModuleName(moduleNameFromPath(trimmed)));
  }

  return names;
}

function indexModulePathsByName(
  srcDir: string,
  deps: Map<string, string[]>,
): Map<string, string> {
  const byName = new Map<string, Set<string>>();

  const add = (modulePath: string) => {
    const normalizedPath = normalizeModulePath(modulePath);
    const moduleName = normalizeModuleName(moduleNameFromPath(normalizedPath));
    if (!moduleName) return;

    let paths = byName.get(moduleName);
    if (!paths) {
      paths = new Set<string>();
      byName.set(moduleName, paths);
    }
    paths.add(normalizedPath);
  };

  for (const [modulePath, moduleDeps] of deps) {
    add(modulePath);
    for (const depPath of moduleDeps) {
      add(depPath);
    }
  }

  for (const modulePath of listModuleFiles(srcDir)) {
    add(modulePath);
  }

  const resolved = new Map<string, string>();
  for (const [name, candidates] of byName) {
    const preferred = pickPreferredModulePath(Array.from(candidates), deps);
    if (preferred) {
      resolved.set(name, preferred);
    }
  }

  return resolved;
}

function pickPreferredModulePath(
  candidates: string[],
  deps: Map<string, string[]>,
): string | undefined {
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    const depKeyDiff = Number(!deps.has(a)) - Number(!deps.has(b));
    if (depKeyDiff !== 0) return depKeyDiff;

    const suffixDiff = moduleSuffixPriority(a) - moduleSuffixPriority(b);
    if (suffixDiff !== 0) return suffixDiff;

    return a.localeCompare(b);
  });

  return candidates[0];
}

function resolveModulePath(
  srcDir: string,
  modulePath: string,
  modulePathByName: Map<string, string>,
): string | undefined {
  const normalizedPath = normalizeModulePath(modulePath);
  if (fs.existsSync(path.join(srcDir, normalizedPath))) {
    return normalizedPath;
  }

  const moduleName = normalizeModuleName(moduleNameFromPath(normalizedPath));
  return modulePathByName.get(moduleName);
}

function listModuleFiles(srcDir: string, relativeDir = ""): string[] {
  const absDir = path.join(srcDir, relativeDir);
  if (!fs.existsSync(absDir)) {
    return [];
  }

  const out: string[] = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listModuleFiles(srcDir, relPath));
      continue;
    }
    if (entry.isFile() && isModuleFile(relPath)) {
      out.push(relPath);
    }
  }

  return out;
}

function isModuleFile(modulePath: string): boolean {
  return MODULE_FILE_SUFFIXES.some((suffix) => modulePath.endsWith(suffix));
}

function moduleSuffixPriority(modulePath: string): number {
  for (let i = 0; i < MODULE_FILE_SUFFIXES.length; i += 1) {
    if (modulePath.endsWith(MODULE_FILE_SUFFIXES[i])) {
      return i;
    }
  }
  return MODULE_FILE_SUFFIXES.length;
}

function moduleNameFromPath(modulePath: string): string {
  const base = path.posix.basename(normalizeModulePath(modulePath));
  for (const suffix of MODULE_FILE_SUFFIXES) {
    if (base.endsWith(suffix)) {
      return base.slice(0, -suffix.length);
    }
  }
  return base;
}

function normalizeModulePath(modulePath: string): string {
  return modulePath.replace(/\\/g, "/").trim();
}

function normalizeModuleName(moduleName: string): string {
  return moduleName.replace(/-/g, "_");
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
      "Then ensure mke2fs is on your PATH (Homebrew: brew --prefix e2fsprogs)",
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
  fixedSizeMb?: number,
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
      "-t",
      "ext4",
      "-d",
      sourceDir,
      "-L",
      label,
      "-m",
      "0",
      "-O",
      "^has_journal",
      "-E",
      "lazy_itable_init=0,lazy_journal_init=0",
      "-b",
      "4096",
      "-F",
      imagePath,
      `${sizeMb}M`,
    ],
    { stdio: "pipe" },
  );
}

/**
 * Create a compressed initramfs from a directory tree.
 */
function createInitramfs(sourceDir: string, outputPath: string): void {
  // find . -print0 | cpio --null -ov --format=newc | lz4 -l -c > output
  execFileSync(
    "sh",
    [
      "-c",
      `cd "${sourceDir}" && find . -print0 | cpio --null -ov --format=newc | lz4 -l -c > "${outputPath}"`,
    ],
    { stdio: "pipe" },
  );
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

function injectBeforeSandboxdExec(script: string, snippet: string): string {
  // Keep this compatible with the built-in init script and with most custom
  // scripts that end in `exec /usr/bin/sandboxd`.
  const marker = "\nexec /usr/bin/sandboxd\n";
  const idx = script.lastIndexOf(marker);
  if (idx !== -1) {
    return (
      script.slice(0, idx) + "\n" + snippet.trimEnd() + "\n" + script.slice(idx)
    );
  }

  // No marker found — append at end (best effort)
  return script.trimEnd() + "\n" + snippet.trimEnd() + "\n";
}

function generateImageEnvScript(
  env: Record<string, string> | string[],
): string | null {
  const entries = normalizeEnvEntries(env);
  if (entries.length === 0) return null;

  const lines = entries.map(
    ([key, value]) => `export ${key}=${shSingleQuote(value)}`,
  );

  return (
    "# Generated by gondolin build\n" +
    "# shellcheck shell=sh\n" +
    lines.join("\n") +
    "\n"
  );
}

function normalizeEnvEntries(
  env: Record<string, string> | string[],
): Array<[string, string]> {
  const map = new Map<string, string>();

  if (Array.isArray(env)) {
    for (const entry of env) {
      const [key, value] = parseEnvEntry(entry);
      validateEnvKey(key);
      map.set(key, value);
    }
  } else {
    for (const [key, value] of Object.entries(env)) {
      validateEnvKey(key);
      map.set(key, value);
    }
  }

  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
}

function validateEnvKey(key: string): void {
  // Shell identifier rules (POSIX-ish), so `export KEY=...` works reliably.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(
      `Invalid env var name for image env: ${JSON.stringify(key)}`,
    );
  }
}

function shSingleQuote(value: string): string {
  // POSIX shell-safe single-quoted string
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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

setup_virtio_ports() {
  if [ ! -d /sys/class/virtio-ports ]; then
    return
  fi

  mkdir -p /dev/virtio-ports

  for port_path in /sys/class/virtio-ports/vport*; do
    if [ ! -e "\${port_path}" ]; then
      continue
    fi

    port_device="$(basename "\${port_path}")"
    dev_node="/dev/\${port_device}"

    if [ ! -c "\${dev_node}" ] && [ -r "\${port_path}/dev" ]; then
      dev_nums="$(cat "\${port_path}/dev" 2>/dev/null || true)"
      major="\${dev_nums%%:*}"
      minor="\${dev_nums##*:}"
      if [ -n "\${major}" ] && [ -n "\${minor}" ]; then
        mknod "\${dev_node}" c "\${major}" "\${minor}" 2>/dev/null || true
        chmod 600 "\${dev_node}" 2>/dev/null || true
      fi
    fi

    if [ -r "\${port_path}/name" ]; then
      port_name="$(cat "\${port_path}/name" 2>/dev/null || true)"
      port_name="$(printf "%s" "\${port_name}" | tr -d '\\r\\n')"
      if [ -n "\${port_name}" ]; then
        ln -sf "../\${port_device}" "/dev/virtio-ports/\${port_name}" 2>/dev/null || true
      fi
    fi
  done
}

resolve_virtio_port_path() {
  expected="$1"

  if [ -c "/dev/virtio-ports/\${expected}" ]; then
    printf "%s\n" "/dev/virtio-ports/\${expected}"
    return
  fi

  for port_path in /sys/class/virtio-ports/vport*; do
    if [ ! -e "\${port_path}" ] || [ ! -r "\${port_path}/name" ]; then
      continue
    fi

    port_name="$(cat "\${port_path}/name" 2>/dev/null || true)"
    port_name="$(printf "%s" "\${port_name}" | tr -d '\\r\\n')"
    if [ "\${port_name}" = "\${expected}" ]; then
      port_device="$(basename "\${port_path}")"
      printf "%s\n" "/dev/\${port_device}"
      return
    fi
  done

  printf "%s\n" "/dev/virtio-ports/\${expected}"
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
setup_virtio_ports
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

setup_virtio_ports

if [ -x /usr/bin/sandboxfs ]; then
  log "[init] starting sandboxfs at \${sandboxfs_mount}"
  SANDBOXFS_LOG="\${CONSOLE:-/dev/null}"
  if [ -z "\${SANDBOXFS_LOG}" ]; then
    SANDBOXFS_LOG="/dev/null"
  fi
  sandboxfs_rpc_path="$(resolve_virtio_port_path virtio-fs)"
  log "[init] sandboxfs rpc path \${sandboxfs_rpc_path}"
  /usr/bin/sandboxfs --mount "\${sandboxfs_mount}" --rpc-path "\${sandboxfs_rpc_path}" > "\${SANDBOXFS_LOG}" 2>&1 &

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

if [ -x /usr/bin/sandboxingress ]; then
  log "[init] starting sandboxingress"
  /usr/bin/sandboxingress > "\${CONSOLE:-/dev/null}" 2>&1 &
else
  log "[init] /usr/bin/sandboxingress missing"
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

if [ -r /proc/cmdline ]; then
  for arg in \$(cat /proc/cmdline); do
    case "\${arg}" in
      root=*)
        root_device="\${arg#root=}"
        ;;
      rootfstype=*)
        root_fstype="\${arg#rootfstype=}"
        ;;
    esac
  done
fi

modprobe virtio_blk > /dev/null 2>&1 || true
modprobe ext4 > /dev/null 2>&1 || true
modprobe virtio_console > /dev/null 2>&1 || true
modprobe virtio_rng > /dev/null 2>&1 || true
modprobe virtio_net > /dev/null 2>&1 || true
modprobe fuse > /dev/null 2>&1 || true

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

mkdir -p /newroot
if ! mount -t "\${root_fstype}" "\${root_device}" /newroot; then
  log "[initramfs] failed to mount \${root_device}"
  exec sh
fi

mkdir -p /newroot/proc /newroot/sys /newroot/dev /newroot/run

exec switch_root /newroot /init
`;
