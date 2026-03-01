import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

import type { Architecture } from "../build/config.ts";
import { downloadFile } from "./utils.ts";
import { decompressTarGz, extractEntries, parseTar } from "./tar.ts";
import type { ApkMeta } from "./types.ts";

/** Parse an APKINDEX file into package metadata records */
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

/** Install Alpine packages with dependency resolution */
export async function installPackages(
  targetDir: string,
  packages: string[],
  arch: Architecture,
  cacheDir: string,
  log: (msg: string) => void,
): Promise<void> {
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

  const pkgMeta = new Map<string, ApkMeta>();
  const pkgRepo = new Map<string, string>();
  const provides = new Map<string, string>();

  for (const repo of repos) {
    const safeName = repo.replace(/[^A-Za-z0-9]+/g, "_");
    const indexPath = path.join(cacheDir, `APKINDEX-${safeName}-${arch}`);

    if (!fs.existsSync(indexPath)) {
      const tarPath = `${indexPath}.tar.gz`;
      const url = `${repo}/${arch}/APKINDEX.tar.gz`;
      await downloadFile(url, tarPath);

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
