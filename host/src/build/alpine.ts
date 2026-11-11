/**
 * Alpine Linux image builder orchestration.
 */

import fs from "node:fs";
import path from "node:path";

import {
  copyExecutable,
  createInitramfs,
  createRootfsImage,
  downloadFile,
  findMke2fs,
  generateImageEnvScript,
  injectBeforeSandboxdExec,
  writeExecutable,
} from "../alpine/utils.ts";
import { extractTarGz } from "../alpine/tar.ts";
import {
  assertSafeWritePath,
  ensureRootfsShell,
  hardenExtractedRootfs,
  pathEntryExists,
} from "../alpine/rootfs.ts";
import { exportOciRootfs } from "../alpine/oci.ts";
import { installPackages, runPostBuildCommands } from "../alpine/packages.ts";
import { applyPostBuildCopies } from "../alpine/post-build-copy.ts";
import { syncKernelModules } from "../alpine/kernel-modules.ts";
import {
  INITRAMFS_INIT_SCRIPT,
  ROOTFS_INIT_SCRIPT,
} from "../alpine/init-scripts.ts";
import type {
  AlpineBuildOptions,
  AlpineBuildResult,
  OciResolvedSource,
  RootfsOwnershipEntry,
} from "../alpine/types.ts";

export type {
  AlpineBuildOptions,
  AlpineBuildResult,
  OciResolvedSource,
  RootfsOwnershipEntry,
} from "../alpine/types.ts";

/** Build Alpine rootfs and initramfs images */
export async function buildAlpineImages(
  opts: AlpineBuildOptions,
): Promise<AlpineBuildResult> {
  const {
    arch,
    alpineVersion,
    alpineBranch,
    rootfsPackages,
    initramfsPackages,
    kernelImage,
    postBuildCopy = [],
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
  const kernelOut = path.join(workDir, "vmlinuz-virt");
  const rootfsImage = path.join(workDir, "rootfs.ext4");
  const initramfsOut = path.join(workDir, "initramfs.cpio.lz4");

  const mkfsCmd = findMke2fs();

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const tarball = `alpine-minirootfs-${alpineVersion}-${arch}.tar.gz`;
  const tarballPath = path.join(cacheDir, tarball);
  const alpineUrl =
    opts.alpineUrl ??
    `https://dl-cdn.alpinelinux.org/alpine/${alpineBranch}/releases/${arch}/${tarball}`;

  if (!fs.existsSync(tarballPath)) {
    log(`Downloading ${alpineUrl}`);
    await downloadFile(alpineUrl, tarballPath);
  }

  fs.rmSync(rootfsDir, { recursive: true, force: true });
  fs.rmSync(initramfsDir, { recursive: true, force: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  fs.mkdirSync(initramfsDir, { recursive: true });

  let ociSource: OciResolvedSource | undefined;
  let ociOwnershipEntries: RootfsOwnershipEntry[] = [];

  if (opts.ociRootfs) {
    const runtimeLabel = opts.ociRootfs.runtime ?? "auto-detect";
    log(
      `Extracting OCI rootfs from ${opts.ociRootfs.image} (${runtimeLabel})...`,
    );
    ociSource = exportOciRootfs({
      arch,
      workDir,
      targetDir: rootfsDir,
      log,
      ownershipSink: (entries) => {
        ociOwnershipEntries = entries;
      },
      ...opts.ociRootfs,
    });
    hardenExtractedRootfs(rootfsDir);
  } else {
    log("Extracting Alpine minirootfs for rootfs...");
    await extractTarGz(tarballPath, rootfsDir);
  }

  log("Extracting Alpine minirootfs for initramfs...");
  await extractTarGz(tarballPath, initramfsDir);

  if (rootfsPackages.length > 0) {
    log(`Installing rootfs packages: ${rootfsPackages.join(" ")}`);
    await installPackages(rootfsDir, rootfsPackages, arch, cacheDir, log);
  }
  if (initramfsPackages.length > 0) {
    log(`Installing initramfs packages: ${initramfsPackages.join(" ")}`);
    await installPackages(initramfsDir, initramfsPackages, arch, cacheDir, log);
  }

  if (opts.ociRootfs) {
    ensureRootfsShell(rootfsDir, opts.ociRootfs.image, initramfsDir, log);
  }

  if (postBuildCopy.length > 0) {
    applyPostBuildCopies(rootfsDir, postBuildCopy, log);
  }

  if (postBuildCommands.length > 0) {
    runPostBuildCommands(rootfsDir, postBuildCommands, arch, log);
  }

  copyExecutable(
    sandboxdBin,
    path.join(rootfsDir, "usr/bin/sandboxd"),
    rootfsDir,
  );
  copyExecutable(
    sandboxfsBin,
    path.join(rootfsDir, "usr/bin/sandboxfs"),
    rootfsDir,
  );
  copyExecutable(
    sandboxsshBin,
    path.join(rootfsDir, "usr/bin/sandboxssh"),
    rootfsDir,
  );
  copyExecutable(
    sandboxingressBin,
    path.join(rootfsDir, "usr/bin/sandboxingress"),
    rootfsDir,
  );

  let rootfsInitContent = opts.rootfsInit ?? ROOTFS_INIT_SCRIPT;

  const imageEnvScript = opts.defaultEnv
    ? generateImageEnvScript(opts.defaultEnv)
    : null;
  if (imageEnvScript) {
    const envPath = path.join(rootfsDir, "etc/profile.d/gondolin-image-env.sh");
    assertSafeWritePath(envPath, rootfsDir);
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, imageEnvScript, { mode: 0o644 });

    rootfsInitContent = injectBeforeSandboxdExec(
      rootfsInitContent,
      "# Load image default environment (generated by gondolin build)\n" +
        "if [ -r /etc/profile.d/gondolin-image-env.sh ]; then\n" +
        "  . /etc/profile.d/gondolin-image-env.sh\n" +
        "fi\n",
    );
  }

  if (opts.rootfsInitExtra) {
    rootfsInitContent = injectBeforeSandboxdExec(
      rootfsInitContent,
      opts.rootfsInitExtra,
    );
  }

  const initramfsInitContent = opts.initramfsInit ?? INITRAMFS_INIT_SCRIPT;
  writeExecutable(path.join(rootfsDir, "init"), rootfsInitContent, rootfsDir);
  writeExecutable(path.join(initramfsDir, "init"), initramfsInitContent);

  const python3 = path.join(rootfsDir, "usr/bin/python3");
  const python = path.join(rootfsDir, "usr/bin/python");
  if (fs.existsSync(python3) && !fs.existsSync(python)) {
    assertSafeWritePath(python, rootfsDir);
    fs.symlinkSync("python3", python);
  }

  ensureRuntimeDirs(rootfsDir);
  ensureRuntimeDirs(initramfsDir);
  ensureGuestMountPoints(rootfsDir);

  syncKernelModules(rootfsDir, initramfsDir, log, {
    copyRootfsToInitramfs: !opts.ociRootfs,
  });

  stageInstalledKernel(
    rootfsDir,
    initramfsDir,
    Boolean(opts.ociRootfs),
    kernelImage,
    kernelOut,
  );

  // The kernel is shipped as a separate asset; drop /boot from both images.
  fs.rmSync(path.join(rootfsDir, "boot"), { recursive: true, force: true });
  fs.rmSync(path.join(initramfsDir, "boot"), { recursive: true, force: true });

  log("Creating rootfs ext4 image...");
  createRootfsImage(
    mkfsCmd,
    rootfsImage,
    rootfsDir,
    rootfsLabel,
    rootfsSizeMb,
    ociOwnershipEntries,
  );

  log("Creating initramfs...");
  createInitramfs(initramfsDir, initramfsOut);

  log(`Rootfs image written to ${rootfsImage}`);
  log(`Initramfs written to ${initramfsOut}`);

  return {
    kernel: kernelOut,
    rootfsImage,
    initramfs: initramfsOut,
    ociSource,
  };
}

function stageInstalledKernel(
  rootfsDir: string,
  initramfsDir: string,
  hasOciRootfs: boolean,
  kernelImage: string,
  outputPath: string,
): void {
  const packageRoot = hasOciRootfs ? initramfsDir : rootfsDir;
  const sourcePath = path.join(packageRoot, "boot", kernelImage);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `Kernel image '${kernelImage}' was not installed in the filesystem containing its modules: ${sourcePath}`,
    );
  }
  fs.copyFileSync(sourcePath, outputPath);
}

function ensureRuntimeDirs(rootDir: string): void {
  for (const sub of ["proc", "sys", "dev", "run"]) {
    const targetDir = path.join(rootDir, sub);
    assertSafeWritePath(targetDir, rootDir);
    fs.mkdirSync(targetDir, { recursive: true });
  }
}

/**
 * Mount points the guest's init uses (the VFS mount, the default binds and
 * scratch tmpfs paths) and a resolver configuration on /run: with
 * `rootfs.mode: "readonly"` the guest cannot create them itself.
 */
function ensureGuestMountPoints(rootfsDir: string): void {
  for (const sub of [
    "data",
    "etc/gondolin/mitm",
    "home",
    "root",
    "tmp",
    "var/cache",
    "var/log",
    "var/tmp",
  ]) {
    const target = path.join(rootfsDir, sub);
    if (pathEntryExists(target)) continue;
    assertSafeWritePath(target, rootfsDir);
    fs.mkdirSync(target, { recursive: true });
  }
  // DHCP and the init write it; /run is a tmpfs in every rootfs mode
  const resolv = path.join(rootfsDir, "etc/resolv.conf");
  if (pathEntryExists(resolv)) return;
  assertSafeWritePath(resolv, rootfsDir);
  fs.symlinkSync("/run/resolv.conf", resolv);
  // Alpine's udhcpc script writes a temporary file beside RESOLV_CONF and
  // renames it, which a read-only /etc refuses: point it at /run (its
  // config file is sourced after the default is set)
  if (fs.existsSync(path.join(rootfsDir, "usr/share/udhcpc/default.script"))) {
    const conf = path.join(rootfsDir, "etc/udhcpc/udhcpc.conf");
    assertSafeWritePath(conf, rootfsDir);
    const current = fs.existsSync(conf) ? fs.readFileSync(conf, "utf8") : "";
    if (!/^RESOLV_CONF=/m.test(current)) {
      fs.mkdirSync(path.dirname(conf), { recursive: true });
      fs.writeFileSync(
        conf,
        `${current}${current && !current.endsWith("\n") ? "\n" : ""}` +
          "# gondolin: /etc/resolv.conf links here (the root may be read-only)\n" +
          'RESOLV_CONF="/run/resolv.conf"\n',
      );
    }
  }
}

/** @internal */
export const __test = { stageInstalledKernel, ensureGuestMountPoints };
