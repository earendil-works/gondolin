import fs from "fs";
import path from "path";

/** Check if any intermediate component of `target` (below `root`) is a symlink */
export function hasSymlinkComponent(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "." || rel === "") return false;

  let current = root;
  const parts = rel.split(path.sep);
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isPathInsideRoot(target: string, root: string): boolean {
  const absTarget = path.resolve(target);
  const absRoot = path.resolve(root);
  return absTarget === absRoot || absTarget.startsWith(absRoot + path.sep);
}

export function resolveWritePath(target: string, root: string): string {
  const absTarget = path.resolve(target);
  const absRoot = path.resolve(root);

  if (!isPathInsideRoot(absTarget, absRoot)) {
    throw new Error(`Refusing to write outside rootfs: ${absTarget}`);
  }

  const rel = path.relative(absRoot, absTarget);
  if (!rel || rel === ".") {
    return absRoot;
  }

  const parts = rel.split(path.sep);
  let current = absRoot;

  for (let idx = 0; idx < parts.length; idx++) {
    const next = path.join(current, parts[idx]);
    try {
      const stat = fs.lstatSync(next);
      if (!stat.isSymbolicLink()) {
        current = next;
        continue;
      }

      const linkTarget = fs.readlinkSync(next);
      const resolved = path.resolve(path.dirname(next), linkTarget);
      if (!isPathInsideRoot(resolved, absRoot)) {
        throw new Error(
          `Refusing to write through symlinked path: ${absTarget}`,
        );
      }
      current = resolved;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return path.join(current, ...parts.slice(idx));
      }
      throw err;
    }
  }

  return current;
}

export function assertSafeWritePath(target: string, root: string): void {
  const absTarget = path.resolve(target);
  const absRoot = path.resolve(root);

  if (!isPathInsideRoot(absTarget, absRoot)) {
    throw new Error(`Refusing to write outside rootfs: ${absTarget}`);
  }

  if (hasSymlinkComponent(absTarget, absRoot)) {
    throw new Error(`Refusing to write through symlinked path: ${absTarget}`);
  }

  try {
    const stat = fs.lstatSync(absTarget);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink path: ${absTarget}`);
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
}

export function hardenExtractedRootfs(rootfsDir: string): void {
  const absRoot = path.resolve(rootfsDir);
  const stack = [absRoot];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        hardenExtractedRootfsSymlink(entryPath, absRoot);
      }
    }
  }
}

function hardenExtractedRootfsSymlink(
  linkPath: string,
  rootfsDir: string,
): void {
  const rawTarget = fs.readlinkSync(linkPath);
  const resolvedTarget = resolveRootfsSymlinkTarget(
    linkPath,
    rawTarget,
    rootfsDir,
  );

  if (!isPathInsideRoot(resolvedTarget, rootfsDir)) {
    throw new Error(
      `OCI rootfs contains symlink escaping the rootfs: ${linkPath} -> ${rawTarget}`,
    );
  }

  if (path.isAbsolute(rawTarget)) {
    const normalizedTarget = path.relative(
      path.dirname(linkPath),
      resolvedTarget,
    );
    fs.unlinkSync(linkPath);
    fs.symlinkSync(normalizedTarget || ".", linkPath);
  }
}

function resolveRootfsSymlinkTarget(
  linkPath: string,
  rawTarget: string,
  rootfsDir: string,
): string {
  if (path.isAbsolute(rawTarget)) {
    return path.resolve(rootfsDir, `.${rawTarget}`);
  }
  return path.resolve(path.dirname(linkPath), rawTarget);
}

export function ensureRootfsShell(
  rootfsDir: string,
  ociImage?: string,
  initramfsDir?: string,
  log?: (msg: string) => void,
): void {
  const shellPath = path.join(rootfsDir, "bin/sh");
  if (fs.existsSync(shellPath)) {
    return;
  }

  if (initramfsDir && bootstrapBusyboxShell(rootfsDir, initramfsDir, log)) {
    if (fs.existsSync(shellPath)) {
      return;
    }
  }

  if (ociImage) {
    throw new Error(
      `OCI rootfs image '${ociImage}' does not contain /bin/sh and busybox bootstrapping failed. ` +
        "Use an image with a POSIX shell or provide a rootfs that includes /bin/sh.",
    );
  }

  throw new Error(`Rootfs is missing required shell at ${shellPath}`);
}

function bootstrapBusyboxShell(
  rootfsDir: string,
  initramfsDir: string,
  log?: (msg: string) => void,
): boolean {
  const busyboxSourceCandidates = [
    path.join(initramfsDir, "bin/busybox"),
    path.join(initramfsDir, "usr/bin/busybox"),
  ];
  const busyboxSource = busyboxSourceCandidates.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!busyboxSource) {
    return false;
  }

  copyMuslRuntimeFromInitramfs(rootfsDir, initramfsDir);

  const busyboxDest = resolveWritePath(
    path.join(rootfsDir, "bin/busybox"),
    rootfsDir,
  );
  fs.mkdirSync(path.dirname(busyboxDest), { recursive: true });
  fs.copyFileSync(busyboxSource, busyboxDest);
  fs.chmodSync(busyboxDest, 0o755);

  for (const relDir of ["bin", "sbin", "usr/bin", "usr/sbin"]) {
    const sourceDir = path.join(initramfsDir, relDir);
    if (!fs.existsSync(sourceDir)) {
      continue;
    }

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) {
        continue;
      }

      const sourcePath = path.join(sourceDir, entry.name);
      const linkTarget = fs.readlinkSync(sourcePath);
      if (!isBusyboxAppletLink(linkTarget)) {
        continue;
      }

      ensureBusyboxApplet(
        rootfsDir,
        path.join(relDir, entry.name),
        busyboxDest,
      );
    }
  }

  for (const relPath of [
    "bin/sh",
    "bin/grep",
    "bin/seq",
    "bin/sleep",
    "bin/mkdir",
    "bin/mount",
    "bin/cat",
    "bin/ln",
    "bin/tr",
    "bin/chmod",
    "bin/cp",
    "bin/ls",
    "sbin/modprobe",
    "sbin/udhcpc",
    "bin/ip",
  ]) {
    ensureBusyboxApplet(rootfsDir, relPath, busyboxDest);
  }

  if (log) {
    log("Bootstrapped busybox shell and core applets into OCI rootfs");
  }

  return true;
}

function copyMuslRuntimeFromInitramfs(
  rootfsDir: string,
  initramfsDir: string,
): void {
  const initramfsLibDir = path.join(initramfsDir, "lib");
  if (!fs.existsSync(initramfsLibDir)) {
    return;
  }

  for (const name of fs.readdirSync(initramfsLibDir)) {
    if (!name.startsWith("ld-musl-") && !name.startsWith("libc.musl-")) {
      continue;
    }

    const srcPath = path.join(initramfsLibDir, name);
    const destPath = resolveWritePath(
      path.join(rootfsDir, "lib", name),
      rootfsDir,
    );
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const stat = fs.lstatSync(srcPath);
    if (stat.isSymbolicLink()) {
      try {
        fs.lstatSync(destPath);
        continue;
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          throw err;
        }
      }
      fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
      continue;
    }

    fs.copyFileSync(srcPath, destPath);
    fs.chmodSync(destPath, stat.mode & 0o7777);
  }
}

function isBusyboxAppletLink(linkTarget: string): boolean {
  const normalized = linkTarget.replace(/\\/g, "/");
  return normalized === "busybox" || normalized.endsWith("/busybox");
}

function ensureBusyboxApplet(
  rootfsDir: string,
  relativePath: string,
  busyboxDest: string,
): void {
  const logicalPath = path.join(rootfsDir, relativePath);
  try {
    fs.lstatSync(logicalPath);
    return;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }

  const destPath = resolveWritePath(logicalPath, rootfsDir);
  const linkTarget = path.relative(path.dirname(destPath), busyboxDest) || ".";
  ensureBusyboxAppletSymlink(destPath, linkTarget);
}

function ensureBusyboxAppletSymlink(
  destPath: string,
  linkTarget: string,
): void {
  try {
    const stat = fs.lstatSync(destPath);
    if (stat.isSymbolicLink()) {
      return;
    }
    return;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.symlinkSync(linkTarget, destPath);
}
