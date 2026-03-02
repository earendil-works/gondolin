import fs from "fs";
import path from "path";

import type { PostBuildCopyEntry } from "../build/config.ts";
import { resolveWritePath } from "./rootfs.ts";

/** Copy host paths into the built rootfs before post-build commands */
export function applyPostBuildCopies(
  rootfsDir: string,
  entries: PostBuildCopyEntry[],
  log: (msg: string) => void,
): void {
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const sourcePath = path.resolve(entry.src);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`postBuild.copy source not found: ${sourcePath}`);
    }

    log(
      `[postBuild.copy] (${i + 1}/${entries.length}) ${sourcePath} -> ${entry.dest}`,
    );

    const destPath = resolveCopyDestination(rootfsDir, sourcePath, entry.dest);
    const sourceStat = fs.lstatSync(sourcePath);

    if (sourceStat.isDirectory()) {
      copyDirectoryContents(sourcePath, destPath, rootfsDir);
      continue;
    }

    copyTreeNode(sourcePath, destPath, rootfsDir);
  }
}

function resolveCopyDestination(
  rootfsDir: string,
  sourcePath: string,
  guestDest: string,
): string {
  if (!path.posix.isAbsolute(guestDest)) {
    throw new Error(
      `postBuild.copy destination must be an absolute guest path: ${JSON.stringify(guestDest)}`,
    );
  }

  const sourceStat = fs.lstatSync(sourcePath);
  const normalizedGuestDest = path.posix.normalize(guestDest);
  const rawDest = toRootfsPath(rootfsDir, normalizedGuestDest);
  const resolvedDest = resolveWritePath(rawDest, rootfsDir);

  if (sourceStat.isDirectory()) {
    if (
      fs.existsSync(resolvedDest) &&
      !fs.statSync(resolvedDest).isDirectory()
    ) {
      throw new Error(
        `postBuild.copy destination must be a directory for source directory: ${guestDest}`,
      );
    }

    fs.mkdirSync(resolvedDest, { recursive: true });
    return resolvedDest;
  }

  const treatAsDirectory =
    guestDest.endsWith("/") ||
    (fs.existsSync(resolvedDest) && fs.statSync(resolvedDest).isDirectory());

  if (treatAsDirectory) {
    fs.mkdirSync(resolvedDest, { recursive: true });
    return path.join(resolvedDest, path.basename(sourcePath));
  }

  fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
  return resolvedDest;
}

function toRootfsPath(rootfsDir: string, guestPath: string): string {
  const rel = guestPath.slice(1);
  return path.join(rootfsDir, rel);
}

function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
  rootfsDir: string,
): void {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const childSource = path.join(sourceDir, entry.name);
    const childTarget = path.join(targetDir, entry.name);
    copyTreeNode(childSource, childTarget, rootfsDir);
  }
}

function copyTreeNode(
  sourcePath: string,
  targetPath: string,
  rootfsDir: string,
): void {
  const sourceStat = fs.lstatSync(sourcePath);
  const resolvedTarget = resolveWritePath(targetPath, rootfsDir);

  if (sourceStat.isDirectory()) {
    if (
      fs.existsSync(resolvedTarget) &&
      !fs.lstatSync(resolvedTarget).isDirectory()
    ) {
      throw new Error(
        `postBuild.copy destination exists and is not a directory: ${resolvedTarget}`,
      );
    }

    fs.mkdirSync(resolvedTarget, {
      recursive: true,
      mode: sourceStat.mode & 0o777,
    });

    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      copyTreeNode(
        path.join(sourcePath, entry.name),
        path.join(resolvedTarget, entry.name),
        rootfsDir,
      );
    }
    return;
  }

  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });

  if (fs.existsSync(resolvedTarget)) {
    const targetStat = fs.lstatSync(resolvedTarget);
    if (targetStat.isDirectory()) {
      throw new Error(
        `postBuild.copy destination exists and is a directory: ${resolvedTarget}`,
      );
    }
    fs.rmSync(resolvedTarget, { force: true });
  }

  if (sourceStat.isSymbolicLink()) {
    const target = fs.readlinkSync(sourcePath);
    fs.symlinkSync(target, resolvedTarget);
    return;
  }

  if (sourceStat.isFile()) {
    fs.copyFileSync(sourcePath, resolvedTarget);
    fs.chmodSync(resolvedTarget, sourceStat.mode & 0o777);
    return;
  }

  throw new Error(
    `postBuild.copy does not support source type at ${sourcePath}`,
  );
}
