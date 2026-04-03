import fs from "fs";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { execFileSync } from "child_process";

import { buildAlpineImages } from "./alpine.ts";
import type { BuildConfig, Architecture, WasmBuildConfig } from "./config.ts";
import { parseApkIndex } from "../alpine/packages.ts";
import { decompressTarGz, extractTarGz, parseTar } from "../alpine/tar.ts";
import { downloadFile, DownloadFileError } from "../alpine/utils.ts";
import {
  DEFAULT_ROOTFS_PACKAGES,
  INITRAMFS_FILENAME,
  KERNEL_FILENAME,
  ROOTFS_FILENAME,
  KRUN_KERNEL_FILENAME,
  KRUN_INITRD_FILENAME,
  WASM_FILENAME,
  detectContainerRuntime,
  resolveConfigPath,
  resolveSandboxBinaryPaths,
  writeAssetManifest,
  type BuildOptions,
  type BuildResult,
  type ResolvedAlpineConfig,
} from "./shared.ts";

const LIBKRUNFW_RELEASE_BASE_URL =
  "https://github.com/containers/libkrunfw/releases/download";
const DEFAULT_LIBKRUNFW_VERSION = "v5.2.1";

function hasOciRootfs(config: BuildConfig): boolean {
  return config.oci !== undefined;
}

function resolveAlpineConfig(config: BuildConfig): ResolvedAlpineConfig {
  const alpine = config.alpine ?? { version: "3.23.0" };
  const kernelPackage = alpine.kernelPackage ?? "linux-virt";
  const useOciRootfs = hasOciRootfs(config);
  const defaultRootfsPackages = useOciRootfs
    ? []
    : DEFAULT_ROOTFS_PACKAGES.map((pkg) =>
        pkg === "linux-virt" ? kernelPackage : pkg,
      );
  const defaultInitramfsPackages = useOciRootfs ? [kernelPackage] : [];

  const initramfsPackages = [
    ...(alpine.initramfsPackages ?? defaultInitramfsPackages),
  ];
  if (useOciRootfs && !initramfsPackages.includes(kernelPackage)) {
    initramfsPackages.unshift(kernelPackage);
  }

  return {
    version: alpine.version,
    branch: alpine.branch,
    mirror: alpine.mirror,
    kernelPackage: alpine.kernelPackage,
    kernelImage: alpine.kernelImage,
    krunfwVersion: alpine.krunfwVersion ?? DEFAULT_LIBKRUNFW_VERSION,
    rootfsPackages: useOciRootfs
      ? []
      : (alpine.rootfsPackages ?? defaultRootfsPackages),
    initramfsPackages,
  };
}

function shouldBuildWasmAsset(config: BuildConfig): boolean {
  return config.wasm?.enabled === true;
}

type WasmTargetArch = NonNullable<WasmBuildConfig["targetArch"]>;

function mapContainer2WasmArch(arch: Architecture): "amd64" | "aarch64" {
  return arch === "x86_64" ? "amd64" : "aarch64";
}

function mapContainerPlatform(arch: Architecture): "linux/amd64" | "linux/arm64" {
  return arch === "x86_64" ? "linux/amd64" : "linux/arm64";
}

function formatExecSyncError(err: unknown): string {
  const execErr = err as Error & { stdout?: unknown; stderr?: unknown };
  const stdout =
    typeof execErr.stdout === "string"
      ? execErr.stdout
      : Buffer.isBuffer(execErr.stdout)
        ? execErr.stdout.toString("utf8")
        : "";
  const stderr =
    typeof execErr.stderr === "string"
      ? execErr.stderr
      : Buffer.isBuffer(execErr.stderr)
        ? execErr.stderr.toString("utf8")
        : "";

  const output = `${stdout}${stderr}`.trim();
  if (!output) {
    return execErr.message;
  }
  return `${execErr.message}: ${output}`;
}

function resolveWasmTargetArch(config: BuildConfig): WasmTargetArch {
  const configured = config.wasm?.targetArch;
  if (configured) {
    return configured;
  }

  const platform = config.oci?.platform?.trim();
  if (platform === "linux/riscv64") {
    return "riscv64";
  }
  if (platform === "linux/amd64") {
    return "amd64";
  }
  if (platform === "linux/arm64") {
    return "aarch64";
  }

  return mapContainer2WasmArch(config.arch);
}

function patchC2wDockerfileForFuse(dockerfile: string): string {
  let patched = dockerfile;

  const bundleWorkdirBlock =
    'FROM golang-base AS bundle-dev\n' +
    'ARG TARGETPLATFORM\n' +
    'ARG INIT_DEBUG\n' +
    'ARG OPTIMIZATION_MODE\n' +
    'ARG NO_VMTOUCH\n' +
    'ARG NO_BINFMT\n' +
    'ARG EXTERNAL_BUNDLE\n' +
    'COPY --link --from=assets / /work\n' +
    'WORKDIR /work';
  const bundleWorkdirPatchedBlock = `${bundleWorkdirBlock}\nRUN apt-get update && apt-get install -y jq`;
  if (!patched.includes(bundleWorkdirBlock)) {
    throw new Error("failed to patch container2wasm dockerfile: bundle workdir block not found");
  }
  patched = patched.replace(bundleWorkdirBlock, bundleWorkdirPatchedBlock);

  const specMoveBlock =
    'RUN if test -f image.json; then mv image.json /out/oci/ ; fi && \\\n' +
    '    if test -f spec.json; then mv spec.json /out/oci/ ; fi';
  const specPatchedBlock =
    'RUN if test -f spec.json; then jq \'(.process.capabilities.bounding += ["CAP_SYS_ADMIN"] | .process.capabilities.effective += ["CAP_SYS_ADMIN"] | .process.capabilities.permitted += ["CAP_SYS_ADMIN"] | .process.capabilities.inheritable += ["CAP_SYS_ADMIN"] | .process.capabilities.ambient += ["CAP_SYS_ADMIN"] | .linux.devices += [{"path":"/dev/fuse","type":"c","major":10,"minor":229,"fileMode":438,"uid":0,"gid":0}] | .linux.resources.devices += [{"allow":true,"type":"c","major":10,"minor":229,"access":"rwm"}])\' spec.json > spec.json.new && mv spec.json.new spec.json; fi\n' +
    specMoveBlock;
  if (!patched.includes(specMoveBlock)) {
    throw new Error("failed to patch container2wasm dockerfile: spec move block not found");
  }
  patched = patched.replace(specMoveBlock, specPatchedBlock);

  const riscvKernelBlock =
    'FROM linux-riscv64-dev-common AS linux-riscv64-dev\n' +
    'WORKDIR /work-buildlinux/linux\n' +
    'COPY --link --from=assets /config/tinyemu/linux_rv64_config ./.config\n' +
    'RUN make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- -j$(nproc) all && \\\n' +
    '    mkdir /out && \\\n' +
    '    mv /work-buildlinux/linux/arch/riscv/boot/Image /out/Image && \\\n' +
    '    make clean';
  const riscvKernelPatchedBlock =
    'FROM linux-riscv64-dev-common AS linux-riscv64-dev\n' +
    'WORKDIR /work-buildlinux/linux\n' +
    'COPY --link --from=assets /config/tinyemu/linux_rv64_config ./.config\n' +
    'RUN printf \'\\nCONFIG_FUSE_FS=y\\nCONFIG_CUSE=y\\n\' >> .config && \\\n' +
    '    make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- olddefconfig && \\\n' +
    '    make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- -j$(nproc) all && \\\n' +
    '    mkdir /out && \\\n' +
    '    mv /work-buildlinux/linux/arch/riscv/boot/Image /out/Image && \\\n' +
    '    make clean';
  if (!patched.includes(riscvKernelBlock)) {
    throw new Error("failed to patch container2wasm dockerfile: riscv kernel block not found");
  }
  patched = patched.replace(riscvKernelBlock, riscvKernelPatchedBlock);

  const riscvConfigBlock =
    'FROM linux-riscv64-dev-common AS linux-riscv64-config-dev\n' +
    'WORKDIR /work-buildlinux/linux\n' +
    'COPY --link --from=assets /config/tinyemu/linux_rv64_config ./.config\n' +
    'RUN make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- olddefconfig';
  const riscvConfigPatchedBlock =
    'FROM linux-riscv64-dev-common AS linux-riscv64-config-dev\n' +
    'WORKDIR /work-buildlinux/linux\n' +
    'COPY --link --from=assets /config/tinyemu/linux_rv64_config ./.config\n' +
    'RUN printf \'\\nCONFIG_FUSE_FS=y\\nCONFIG_CUSE=y\\n\' >> .config && \\\n' +
    '    make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- olddefconfig';
  if (!patched.includes(riscvConfigBlock)) {
    throw new Error("failed to patch container2wasm dockerfile: riscv config block not found");
  }
  patched = patched.replace(riscvConfigBlock, riscvConfigPatchedBlock);

  return patched;
}

function writePatchedC2wDockerfile(params: {
  c2wPath: string;
  workDir: string;
}): string {
  const dockerfile = execFileSync(params.c2wPath, ["--show-dockerfile"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const patched = patchC2wDockerfileForFuse(dockerfile);
  const dockerfilePath = path.join(
    params.workDir,
    `.gondolin-c2w-fuse-${randomUUID().slice(0, 8)}.Dockerfile`,
  );
  fs.writeFileSync(dockerfilePath, patched);
  return dockerfilePath;
}

function resolveC2wPath(config: BuildConfig, configDir?: string): string {
  const configured = config.wasm?.c2wPath?.trim();
  if (configured) {
    return resolveConfigPath(configured, configDir);
  }

  const env =
    process.env.GONDOLIN_C2W_PATH?.trim() ||
    process.env.GONDOLIN_CONTAINER2WASM_PATH?.trim();
  if (env) {
    return env;
  }

  return "c2w";
}

function generateWasmEntrypointScript(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    "",
    "export PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "",
    "setup_mitm_ca() {",
    '  system_ca_bundle=""',
    "  for candidate in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt; do",
    '    if [ -r "${candidate}" ]; then',
    '      system_ca_bundle="${candidate}"',
    "      break",
    "    fi",
    "  done",
    "",
    '  mitm_ca_cert="/etc/gondolin/mitm/ca.crt"',
    '  runtime_ca_bundle="/run/gondolin/ca-certificates.crt"',
    "  mkdir -p /run/gondolin",
    '  : > "${runtime_ca_bundle}"',
    "",
    '  if [ -n "${system_ca_bundle}" ] && [ -r "${system_ca_bundle}" ]; then',
    '    cat "${system_ca_bundle}" >> "${runtime_ca_bundle}" 2>/dev/null || true',
    "  fi",
    "",
    '  if [ -r "${mitm_ca_cert}" ]; then',
    '    printf "\\n" >> "${runtime_ca_bundle}"',
    '    cat "${mitm_ca_cert}" >> "${runtime_ca_bundle}" 2>/dev/null || true',
    "  fi",
    "",
    '  export SSL_CERT_FILE="${runtime_ca_bundle}"',
    '  export CURL_CA_BUNDLE="${runtime_ca_bundle}"',
    '  export REQUESTS_CA_BUNDLE="${runtime_ca_bundle}"',
    '  if [ -r "${mitm_ca_cert}" ]; then',
    '    export NODE_EXTRA_CA_CERTS="${mitm_ca_cert}"',
    "  fi",
    "}",
    "",
    'sandboxfs_mount="/data"',
    'sandboxfs_binds=""',
    'if [ "${1:-}" = "gondolin-sandboxfs-config" ]; then',
    '  sandboxfs_mount="${2:-/data}"',
    '  sandboxfs_binds="${3:-}"',
    "fi",
    'rpc_socket="/run/gondolin-sandboxfs-rpc.sock"',
    "",
    'mkdir -p /run "${sandboxfs_mount}"',
    "rm -f /run/sandboxfs.ready /run/sandboxfs.failed",
    'rm -f "${rpc_socket}" >/dev/null 2>&1 || true',
    "",
    "(",
    "  if [ ! -e /dev/fuse ]; then",
    "    mknod /dev/fuse c 10 229 >/dev/null 2>&1 || true",
    "  fi",
    "",
    "  if [ -x /usr/bin/sandboxfs ]; then",
    "    for _ in $(seq 1 300); do",
    '      [ -S "${rpc_socket}" ] && break',
    "      sleep 0.1",
    "    done",
    "",
    '    /usr/bin/sandboxfs --mount "${sandboxfs_mount}" --rpc-path "unix:${rpc_socket}" >/dev/null 2>&1 &',
    "",
    "    mounted=0",
    "    for _ in $(seq 1 300); do",
    '      if grep -q " ${sandboxfs_mount} fuse.sandboxfs " /proc/mounts; then',
    "        mounted=1",
    "        break",
    "      fi",
    "      sleep 0.1",
    "    done",
    "",
    '    if [ "${mounted}" -eq 1 ]; then',
    '      if [ -n "${sandboxfs_binds}" ]; then',
    '        OLD_IFS="${IFS}"',
    "        IFS=','",
    "        for bind in ${sandboxfs_binds}; do",
    '          [ -z "${bind}" ] && continue',
    '          if [ "${sandboxfs_mount}" = "/" ]; then',
    '            bind_source="${bind}"',
    "          else",
    '            bind_source="${sandboxfs_mount}${bind}"',
    "          fi",
    '          mkdir -p "$(dirname "${bind}")"',
    '          if ! mount --bind "${bind_source}" "${bind}" >/dev/null 2>&1; then',
    '            rm -rf "${bind}" >/dev/null 2>&1 || true',
    '            ln -s "${bind_source}" "${bind}" >/dev/null 2>&1 || true',
    "          fi",
    "        done",
    '        IFS="${OLD_IFS}"',
    "      fi",
    "      setup_mitm_ca",
    "      printf 'ok\\n' > /run/sandboxfs.ready",
    "    else",
    "      printf '%s\\n' 'sandboxfs mount not ready' > /run/sandboxfs.failed",
    "    fi",
    "  else",
    "    printf '%s\\n' 'sandboxfs binary missing' > /run/sandboxfs.failed",
    "  fi",
    ") &",
    "",
    "setup_mitm_ca",
    "",
    "# Load image default environment (generated by gondolin build)",
    "if [ -r /etc/profile.d/gondolin-image-env.sh ]; then",
    "  . /etc/profile.d/gondolin-image-env.sh",
    "fi",
    "",
    'exec env GONDOLIN_SANDBOXFS_RPC_SOCKET="${rpc_socket}" /usr/bin/sandboxd --transport="${GONDOLIN_SANDBOXD_TRANSPORT:-stdio}"',
    "",
  ].join("\n");
}

function buildWasmSourceImage(params: {
  runtime: "docker" | "podman";
  rootfsDir: string;
  platform: string;
  workDir: string;
  log: (msg: string) => void;
}): { image: string; cleanup: () => void } {
  const image = `gondolin-wasm-source:${randomUUID().slice(0, 12)}`;
  const dockerfilePath = path.join(
    params.workDir,
    `.gondolin-wasm-source-${randomUUID().slice(0, 8)}.Dockerfile`,
  );

  const entrypointPath = path.join(
    params.rootfsDir,
    "usr",
    "bin",
    "gondolin-wasm-entrypoint",
  );
  fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
  fs.writeFileSync(
    entrypointPath,
    generateWasmEntrypointScript(),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    dockerfilePath,
    [
      "FROM scratch",
      "COPY . /",
      "ENV SSL_CERT_FILE=/etc/gondolin/mitm/ca.crt",
      "ENV CURL_CA_BUNDLE=/etc/gondolin/mitm/ca.crt",
      "ENV REQUESTS_CA_BUNDLE=/etc/gondolin/mitm/ca.crt",
      "ENV NODE_EXTRA_CA_CERTS=/etc/gondolin/mitm/ca.crt",
      'ENTRYPOINT ["/usr/bin/gondolin-wasm-entrypoint"]',
      "",
    ].join("\n"),
  );

  try {
    params.log(
      `Building temporary OCI image for wasm conversion (${params.platform})`,
    );
    execFileSync(
      params.runtime,
      [
        "build",
        "--platform",
        params.platform,
        "-f",
        dockerfilePath,
        "-t",
        image,
        params.rootfsDir,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      },
    );
  } catch (err) {
    throw new Error(
      "failed to build temporary OCI image for wasm conversion: " +
        formatExecSyncError(err),
    );
  } finally {
    fs.rmSync(dockerfilePath, { force: true });
  }

  return {
    image,
    cleanup: () => {
      try {
        execFileSync(params.runtime, ["rmi", "-f", image], {
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

function maybeBuildWasmAsset(params: {
  config: BuildConfig;
  outputDir: string;
  workDir: string;
  configDir?: string;
  rootfsDir: string;
  runtime?: "docker" | "podman";
  platform?: string;
  log: (msg: string) => void;
}): void {
  if (!shouldBuildWasmAsset(params.config)) {
    return;
  }

  if (!params.config.oci) {
    throw new Error("WASM builds currently require oci.image in build config.");
  }

  if (!fs.existsSync(params.rootfsDir)) {
    throw new Error(`rootfs staging directory not found: ${params.rootfsDir}`);
  }

  const c2wPath = resolveC2wPath(params.config, params.configDir);
  try {
    execFileSync(c2wPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (err) {
    throw new Error(
      `container2wasm c2w binary not found or unusable: ${c2wPath} (${formatExecSyncError(err)})`,
    );
  }

  const runtime =
    params.runtime ?? detectContainerRuntime(params.config.oci.runtime);
  const platform = params.platform ?? mapContainerPlatform(params.config.arch);
  const wasmDst = path.join(params.outputDir, WASM_FILENAME);
  const targetArch = resolveWasmTargetArch(params.config);
  const dockerfilePath = writePatchedC2wDockerfile({
    c2wPath,
    workDir: params.workDir,
  });

  const sourceImage = buildWasmSourceImage({
    runtime,
    rootfsDir: params.rootfsDir,
    platform,
    workDir: params.workDir,
    log: params.log,
  });

  try {
    params.log(`Building wasm artifact via container2wasm (${targetArch})`);
    execFileSync(
      c2wPath,
      [
        "--dockerfile",
        dockerfilePath,
        "--builder",
        runtime,
        "--target-arch",
        targetArch,
        sourceImage.image,
        wasmDst,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      },
    );
  } catch (err) {
    throw new Error(
      `failed to build wasm artifact with ${c2wPath}: ${formatExecSyncError(err)}`,
    );
  } finally {
    fs.rmSync(dockerfilePath, { force: true });
    sourceImage.cleanup();
  }
}

/** Build assets natively (Linux or macOS with appropriate tools) */
export async function buildNative(
  config: BuildConfig,
  options: BuildOptions,
  workDir: string,
  log: (msg: string) => void,
): Promise<BuildResult> {
  const outputDir = path.resolve(options.outputDir);
  const configDir = options.configDir;

  const binaries = await resolveSandboxBinaryPaths(config, options, log);

  log("Building guest images...");

  const alpineConfig = resolveAlpineConfig(config);
  if (
    hasOciRootfs(config) &&
    (config.alpine?.rootfsPackages?.length ?? 0) > 0
  ) {
    log("Ignoring alpine.rootfsPackages because oci rootfs source is enabled");
  }

  const { kernelPackage } = resolveKernelConfig(alpineConfig);
  if (!hasOciRootfs(config)) {
    warnOnKernelPackageMismatch(alpineConfig.rootfsPackages, kernelPackage);
  }

  const cacheDir = path.join(os.homedir(), ".cache", "gondolin", "build");

  let rootfsInit: string | undefined;
  let initramfsInit: string | undefined;
  let rootfsInitExtra: string | undefined;
  if (config.init?.rootfsInit) {
    rootfsInit = fs.readFileSync(
      resolveConfigPath(config.init.rootfsInit, configDir),
      "utf8",
    );
  }
  if (config.init?.initramfsInit) {
    initramfsInit = fs.readFileSync(
      resolveConfigPath(config.init.initramfsInit, configDir),
      "utf8",
    );
  }
  if (config.init?.rootfsInitExtra) {
    rootfsInitExtra = fs.readFileSync(
      resolveConfigPath(config.init.rootfsInitExtra, configDir),
      "utf8",
    );
  }

  const postBuildCopy = (config.postBuild?.copy ?? []).map((entry) => ({
    src: resolveConfigPath(entry.src, configDir),
    dest: entry.dest,
  }));

  let alpineUrl: string | undefined;
  if (alpineConfig.mirror) {
    const branch =
      alpineConfig.branch ??
      `v${alpineConfig.version.split(".").slice(0, 2).join(".")}`;
    alpineUrl = `${alpineConfig.mirror}/${branch}/releases/${config.arch}/alpine-minirootfs-${alpineConfig.version}-${config.arch}.tar.gz`;
  }

  const alpineBuild = await buildAlpineImages({
    arch: config.arch,
    alpineVersion: alpineConfig.version,
    alpineBranch:
      alpineConfig.branch ??
      `v${alpineConfig.version.split(".").slice(0, 2).join(".")}`,
    alpineUrl,
    ociRootfs: config.oci,
    rootfsPackages: alpineConfig.rootfsPackages,
    initramfsPackages: alpineConfig.initramfsPackages,
    sandboxdBin: binaries.sandboxdPath,
    sandboxfsBin: binaries.sandboxfsPath,
    sandboxsshBin: binaries.sandboxsshPath,
    sandboxingressBin: binaries.sandboxingressPath,
    rootfsLabel: config.rootfs?.label ?? "gondolin-root",
    rootfsSizeMb: config.rootfs?.sizeMb,
    rootfsInit,
    initramfsInit,
    rootfsInitExtra,
    postBuildCopy,
    postBuildCommands: config.postBuild?.commands ?? [],
    defaultEnv: config.env,
    workDir,
    cacheDir,
    log,
  });

  log("Fetching kernel...");
  await fetchKernel(workDir, config.arch, alpineConfig, cacheDir, log);

  log("Fetching libkrunfw-compatible kernel...");
  await fetchKrunBootAssets(
    workDir,
    config.arch,
    alpineConfig.krunfwVersion,
    cacheDir,
    log,
  );

  log("Copying assets to output directory...");

  const kernelSrc = path.join(workDir, KERNEL_FILENAME);
  const initramfsSrc = path.join(workDir, INITRAMFS_FILENAME);
  const rootfsSrc = path.join(workDir, ROOTFS_FILENAME);
  const krunKernelSrc = path.join(workDir, KRUN_KERNEL_FILENAME);
  const krunInitrdSrc = path.join(workDir, KRUN_INITRD_FILENAME);

  const kernelDst = path.join(outputDir, KERNEL_FILENAME);
  const initramfsDst = path.join(outputDir, INITRAMFS_FILENAME);
  const rootfsDst = path.join(outputDir, ROOTFS_FILENAME);
  const krunKernelDst = path.join(outputDir, KRUN_KERNEL_FILENAME);
  const krunInitrdDst = path.join(outputDir, KRUN_INITRD_FILENAME);

  fs.copyFileSync(kernelSrc, kernelDst);
  fs.copyFileSync(initramfsSrc, initramfsDst);
  fs.copyFileSync(rootfsSrc, rootfsDst);
  fs.copyFileSync(krunKernelSrc, krunKernelDst);
  fs.copyFileSync(krunInitrdSrc, krunInitrdDst);

  maybeBuildWasmAsset({
    config,
    outputDir,
    workDir,
    configDir,
    rootfsDir: alpineBuild.rootfsDir,
    runtime: alpineBuild.ociSource?.runtime,
    platform: alpineBuild.ociSource?.platform,
    log,
  });

  log("Generating manifest...");
  const { manifestPath, manifest } = writeAssetManifest(
    outputDir,
    config,
    alpineBuild.ociSource,
  );

  log(`Build complete! Assets written to ${outputDir}`);

  return {
    outputDir,
    manifestPath,
    manifest,
  };
}

type AlpineKernelConfig = {
  kernelPackage: string;
  kernelImage: string;
};

function resolveKernelConfig(alpineConfig: {
  kernelPackage?: string;
  kernelImage?: string;
}): AlpineKernelConfig {
  const kernelPackage = alpineConfig.kernelPackage ?? "linux-virt";
  const kernelImage =
    alpineConfig.kernelImage ?? deriveKernelImage(kernelPackage);
  return { kernelPackage, kernelImage };
}

function deriveKernelImage(kernelPackage: string): string {
  if (
    kernelPackage.startsWith("linux-") &&
    kernelPackage.length > "linux-".length
  ) {
    return `vmlinuz-${kernelPackage.slice("linux-".length)}`;
  }
  return "vmlinuz-virt";
}

function warnOnKernelPackageMismatch(
  rootfsPackages: string[],
  kernelPackage: string,
): void {
  if (!rootfsPackages.includes(kernelPackage)) {
    process.stderr.write(
      `Warning: rootfsPackages does not include kernel package '${kernelPackage}'. ` +
        "This may cause module mismatches at boot.\n",
    );
  }
}

async function fetchKernel(
  outputDir: string,
  arch: Architecture,
  alpineConfig: ResolvedAlpineConfig,
  cacheDir: string,
  log: (msg: string) => void,
): Promise<void> {
  const kernelPath = path.join(outputDir, KERNEL_FILENAME);

  if (fs.existsSync(kernelPath)) {
    log("Kernel already present, skipping download");
    return;
  }

  const version = alpineConfig.version;
  const branch =
    alpineConfig.branch ?? `v${version.split(".").slice(0, 2).join(".")}`;
  const mirror = alpineConfig.mirror ?? "https://dl-cdn.alpinelinux.org/alpine";
  const { kernelPackage, kernelImage } = resolveKernelConfig(alpineConfig);

  log(`Fetching ${kernelPackage} from Alpine ${branch} (${arch})`);

  fs.mkdirSync(cacheDir, { recursive: true });

  const indexTarPath = path.join(
    cacheDir,
    `APKINDEX-main-${branch}-${arch}.tar.gz`,
  );
  const indexUrl = `${mirror}/${branch}/main/${arch}/APKINDEX.tar.gz`;

  if (!fs.existsSync(indexTarPath)) {
    await downloadFile(indexUrl, indexTarPath);
  }

  const raw = await decompressTarGz(indexTarPath);
  const tarEntries = parseTar(raw);
  const indexEntry = tarEntries.find((e) => e.name === "APKINDEX" && e.content);
  if (!indexEntry?.content) {
    throw new Error("APKINDEX not found in index tarball");
  }

  const pkgs = parseApkIndex(indexEntry.content.toString("utf8"));
  const kernelMeta = pkgs.find((p) => p.P === kernelPackage);

  if (!kernelMeta) {
    throw new Error(`Failed to find ${kernelPackage} in APKINDEX`);
  }

  const kernelVersion = kernelMeta.V;
  log(`Found ${kernelPackage} version: ${kernelVersion}`);

  const apkFilename = `${kernelPackage}-${kernelVersion}.apk`;
  const apkPath = path.join(cacheDir, `${arch}-${apkFilename}`);

  if (!fs.existsSync(apkPath)) {
    const apkUrl = `${mirror}/${branch}/main/${arch}/${apkFilename}`;
    await downloadFile(apkUrl, apkPath);
  }

  const apkRaw = await decompressTarGz(apkPath);
  const apkEntries = parseTar(apkRaw);
  const kernelEntry = apkEntries.find(
    (e) => e.name === `boot/${kernelImage}` && e.content,
  );

  if (!kernelEntry?.content) {
    throw new Error(
      `Kernel image 'boot/${kernelImage}' not found in ${apkFilename}`,
    );
  }

  fs.writeFileSync(kernelPath, kernelEntry.content);
}

type KrunArchive = {
  archivePath: string;
  kind: "prebuilt" | "shared";
};

type DownloadFileFn = (url: string, dest: string) => Promise<void>;

async function fetchKrunBootAssets(
  outputDir: string,
  arch: Architecture,
  krunfwVersion: string,
  cacheDir: string,
  log: (msg: string) => void,
): Promise<void> {
  const kernelPath = path.join(outputDir, KRUN_KERNEL_FILENAME);
  const initrdPath = path.join(outputDir, KRUN_INITRD_FILENAME);

  if (fs.existsSync(kernelPath) && fs.existsSync(initrdPath)) {
    log("libkrunfw boot artifacts already present, skipping download");
    return;
  }

  const casKernelPath = await ensureKrunKernelInCache(
    arch,
    krunfwVersion,
    cacheDir,
    log,
  );

  fs.copyFileSync(casKernelPath, kernelPath);
  if (!fs.existsSync(initrdPath)) {
    fs.writeFileSync(initrdPath, "");
  }
}

async function ensureKrunKernelInCache(
  arch: Architecture,
  krunfwVersion: string,
  cacheDir: string,
  log: (msg: string) => void,
): Promise<string> {
  const archName = mapKrunArch(arch);
  const indexDir = path.join(
    cacheDir,
    "libkrunfw",
    "index",
    krunfwVersion,
    archName,
  );
  const digestPath = path.join(indexDir, "kernel.sha256");

  if (fs.existsSync(digestPath)) {
    const digest = fs.readFileSync(digestPath, "utf8").trim();
    if (digest) {
      const cached = path.join(cacheDir, "cas", "sha256", digest);
      if (fs.existsSync(cached)) {
        log(`Using cached libkrunfw kernel ${digest.slice(0, 12)}...`);
        return cached;
      }
    }
  }

  const archive = await downloadKrunArchive(
    krunfwVersion,
    archName,
    cacheDir,
    log,
  );
  const kernel = await extractKrunKernelFromArchive(archive, archName, log);
  const digest = sha256(kernel);

  const casDir = path.join(cacheDir, "cas", "sha256");
  fs.mkdirSync(casDir, { recursive: true });
  const casPath = path.join(casDir, digest);
  if (!fs.existsSync(casPath)) {
    fs.writeFileSync(casPath, kernel);
  }

  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(digestPath, `${digest}\n`);

  log(`Cached libkrunfw kernel ${digest.slice(0, 12)}...`);
  return casPath;
}

async function downloadKrunArchive(
  krunfwVersion: string,
  archName: "aarch64" | "x86_64",
  cacheDir: string,
  log: (msg: string) => void,
  download: DownloadFileFn = downloadFile,
): Promise<KrunArchive> {
  const releaseDir = path.join(
    cacheDir,
    "libkrunfw",
    "downloads",
    krunfwVersion,
    archName,
  );
  fs.mkdirSync(releaseDir, { recursive: true });

  const prebuiltName = `libkrunfw-prebuilt-${archName}.tgz`;
  const prebuiltPath = path.join(releaseDir, prebuiltName);

  if (fs.existsSync(prebuiltPath)) {
    return { archivePath: prebuiltPath, kind: "prebuilt" };
  }

  const prebuiltUrl = `${LIBKRUNFW_RELEASE_BASE_URL}/${krunfwVersion}/${prebuiltName}`;
  try {
    log(`Downloading ${prebuiltUrl}`);
    await download(prebuiltUrl, prebuiltPath);
    return { archivePath: prebuiltPath, kind: "prebuilt" };
  } catch (err) {
    if (!isNotFoundDownloadError(err)) {
      throw err;
    }
    log(
      `No prebuilt libkrunfw archive for ${archName} (${krunfwVersion}); falling back to shared archive`,
    );
  }

  const sharedName = `libkrunfw-${archName}.tgz`;
  const sharedPath = path.join(releaseDir, sharedName);
  if (!fs.existsSync(sharedPath)) {
    const sharedUrl = `${LIBKRUNFW_RELEASE_BASE_URL}/${krunfwVersion}/${sharedName}`;
    log(`Downloading ${sharedUrl}`);
    await download(sharedUrl, sharedPath);
  }

  return { archivePath: sharedPath, kind: "shared" };
}

async function extractKrunKernelFromArchive(
  archive: KrunArchive,
  archName: "aarch64" | "x86_64",
  log: (msg: string) => void,
): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-krunfw-"));

  try {
    const extractDir = path.join(tmpDir, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    await extractTarGz(archive.archivePath, extractDir);

    if (archive.kind === "prebuilt") {
      log("Extracting kernel from libkrunfw prebuilt archive");
      return extractKernelFromPrebuiltArchive(extractDir);
    }

    log("Extracting kernel from libkrunfw shared archive");
    return extractKernelFromSharedArchive(extractDir, archName);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function extractKernelFromPrebuiltArchive(extractDir: string): Buffer {
  const kernelCPath = path.join(extractDir, "libkrunfw", "kernel.c");
  if (!fs.existsSync(kernelCPath)) {
    throw new Error(
      `libkrunfw prebuilt archive missing libkrunfw/kernel.c at ${kernelCPath}`,
    );
  }

  const buildDir = path.join(extractDir, "build-prebuilt");
  fs.mkdirSync(buildDir, { recursive: true });

  const extractorPath = path.join(buildDir, "extract-kernel");
  const sourcePath = path.join(buildDir, "extract-kernel.c");
  fs.writeFileSync(
    sourcePath,
    [
      "#include <stdio.h>",
      "#include <stddef.h>",
      "#ifndef ABI_VERSION",
      "#define ABI_VERSION 0",
      "#endif",
      '#include "libkrunfw/kernel.c"',
      "int main(void) {",
      "  size_t load_addr = 0, entry_addr = 0, size = 0;",
      "  char *kernel = krunfw_get_kernel(&load_addr, &entry_addr, &size);",
      "  (void)load_addr;",
      "  (void)entry_addr;",
      "  if (!kernel || size == 0) {",
      "    return 1;",
      "  }",
      "  return fwrite(kernel, 1, size, stdout) == size ? 0 : 1;",
      "}",
      "",
    ].join("\n"),
  );

  execFileSync(
    "zig",
    ["cc", "-O2", `-I${extractDir}`, sourcePath, "-o", extractorPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const kernel = execFileSync(extractorPath, [], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });

  if (kernel.length === 0) {
    throw new Error("libkrunfw prebuilt extractor produced an empty kernel");
  }

  return kernel;
}

function extractKernelFromSharedArchive(
  extractDir: string,
  archName: "aarch64" | "x86_64",
): Buffer {
  const lib64Path = path.join(extractDir, "lib64", "libkrunfw.so");
  const libPath = path.join(extractDir, "lib", "libkrunfw.so");
  const sharedLibPath = fs.existsSync(lib64Path)
    ? lib64Path
    : fs.existsSync(libPath)
      ? libPath
      : null;

  if (!sharedLibPath) {
    throw new Error(
      `libkrunfw shared archive does not contain libkrunfw.so for ${archName}`,
    );
  }

  const hostArch = hostKrunArch();
  const sharedLib = fs.readFileSync(sharedLibPath);

  if (hostArch === archName) {
    try {
      return extractKernelFromSharedArchiveByExecution(sharedLibPath, archName);
    } catch (execErr) {
      try {
        return extractKernelBundleFromSharedLibraryBytes(sharedLib, archName);
      } catch (parseErr) {
        throw new Error(
          `failed to extract kernel bundle from libkrunfw shared archive for ${archName}; execution path failed (${formatExecError(execErr)}); parser fallback failed (${formatExecError(parseErr)})`,
        );
      }
    }
  }

  try {
    return extractKernelBundleFromSharedLibraryBytes(sharedLib, archName);
  } catch (parseErr) {
    throw new Error(
      `failed to extract kernel bundle from libkrunfw shared archive for ${archName}: ${formatExecError(parseErr)}`,
    );
  }
}

function extractKernelFromSharedArchiveByExecution(
  sharedLibPath: string,
  archName: "aarch64" | "x86_64",
): Buffer {
  const libDir = path.dirname(sharedLibPath);
  const buildDir = path.join(path.dirname(sharedLibPath), "build-shared");
  fs.mkdirSync(buildDir, { recursive: true });

  const extractorPath = path.join(buildDir, "extract-kernel");
  const sourcePath = path.join(buildDir, "extract-kernel.c");
  fs.writeFileSync(
    sourcePath,
    [
      "#include <stdio.h>",
      "#include <stddef.h>",
      "extern char *krunfw_get_kernel(size_t *load_addr, size_t *entry_addr, size_t *size);",
      "int main(void) {",
      "  size_t load_addr = 0, entry_addr = 0, size = 0;",
      "  char *kernel = krunfw_get_kernel(&load_addr, &entry_addr, &size);",
      "  (void)load_addr;",
      "  (void)entry_addr;",
      "  if (!kernel || size == 0) {",
      "    return 1;",
      "  }",
      "  return fwrite(kernel, 1, size, stdout) == size ? 0 : 1;",
      "}",
      "",
    ].join("\n"),
  );

  try {
    execFileSync(
      "zig",
      [
        "cc",
        "-O2",
        sourcePath,
        `-L${libDir}`,
        `-Wl,-rpath,${libDir}`,
        "-lkrunfw",
        "-o",
        extractorPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    throw new Error(
      `failed to compile libkrunfw kernel extractor for ${archName}: ${formatExecError(err)}`,
    );
  }

  try {
    const kernel = execFileSync(extractorPath, [], {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${libDir}:${process.env.LD_LIBRARY_PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 512 * 1024 * 1024,
    });

    if (kernel.length === 0) {
      throw new Error("libkrunfw shared extractor produced an empty kernel");
    }

    return kernel;
  } catch (err) {
    throw new Error(
      `failed to run libkrunfw kernel extractor for ${archName}: ${formatExecError(err)}`,
    );
  }
}

type ElfEndian = "le" | "be";

type ParsedElfSection = {
  /** section type code */
  type: number;
  /** section file offset in `bytes` */
  offset: number;
  /** section size in `bytes` */
  size: number;
  /** section virtual address */
  address: number;
  /** linked section index */
  link: number;
  /** table entry size in `bytes` */
  entrySize: number;
};

function extractKernelBundleFromSharedLibraryBytes(
  bytes: Buffer,
  archName: "aarch64" | "x86_64",
): Buffer {
  if (bytes.length < 64) {
    throw new Error("ELF header is truncated");
  }

  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("file is not an ELF shared library");
  }

  const elfClass = bytes.readUInt8(4);
  if (elfClass !== 2) {
    throw new Error(`unsupported ELF class ${elfClass} (expected ELF64)`);
  }

  const endianTag = bytes.readUInt8(5);
  const endian: ElfEndian =
    endianTag === 1
      ? "le"
      : endianTag === 2
        ? "be"
        : (() => {
            throw new Error(`unsupported ELF data encoding ${endianTag}`);
          })();

  const machine = readU16(bytes, 18, endian);
  const expectedMachine = archName === "aarch64" ? 183 : 62;
  if (machine !== expectedMachine) {
    throw new Error(
      `ELF machine ${machine} does not match expected ${expectedMachine} for ${archName}`,
    );
  }

  const sections = parseElfSections(bytes, endian);
  const dynsym = sections.find((section) => section.type === 11);
  if (!dynsym) {
    throw new Error("ELF does not contain .dynsym section");
  }
  if (dynsym.entrySize <= 0) {
    throw new Error("ELF .dynsym has invalid entry size");
  }
  if (dynsym.entrySize < 24) {
    throw new Error("ELF .dynsym entry size is too small for ELF64");
  }

  const dynstr = sections[dynsym.link];
  if (!dynstr) {
    throw new Error("ELF .dynsym string table link is out of range");
  }

  const dynstrBytes = sliceChecked(bytes, dynstr.offset, dynstr.size);

  const symbolCount = Math.floor(dynsym.size / dynsym.entrySize);
  let symbolValue = -1;
  let symbolSize = -1;
  let symbolSectionIndex = -1;

  for (let i = 0; i < symbolCount; i += 1) {
    const entryOffset = dynsym.offset + i * dynsym.entrySize;
    const entry = sliceChecked(bytes, entryOffset, dynsym.entrySize);

    const nameOffset = readU32(entry, 0, endian);
    if (nameOffset >= dynstrBytes.length) {
      continue;
    }

    const name = readCString(dynstrBytes, nameOffset);
    if (name !== "KERNEL_BUNDLE") {
      continue;
    }

    symbolSectionIndex = readU16(entry, 6, endian);
    symbolValue = readU64(entry, 8, endian);
    symbolSize = readU64(entry, 16, endian);
    break;
  }

  if (symbolValue < 0 || symbolSize <= 0) {
    throw new Error("ELF does not expose KERNEL_BUNDLE symbol");
  }

  const bySection = tryResolveSymbolOffsetFromSection(
    sections,
    symbolSectionIndex,
    symbolValue,
    symbolSize,
  );
  if (bySection !== null) {
    return normalizeKrunKernelBundle(
      sliceChecked(bytes, bySection, symbolSize),
    );
  }

  const byLoadSegment = tryResolveSymbolOffsetFromProgramHeaders(
    bytes,
    endian,
    symbolValue,
    symbolSize,
  );
  if (byLoadSegment !== null) {
    return normalizeKrunKernelBundle(
      sliceChecked(bytes, byLoadSegment, symbolSize),
    );
  }

  throw new Error("failed to map KERNEL_BUNDLE symbol to file bytes");
}

function normalizeKrunKernelBundle(bytes: Buffer): Buffer {
  // Shared libkrunfw archives expose KERNEL_BUNDLE with a trailing `\0`
  // sentinel while `krunfw_get_kernel` reports `size - 1`
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0) {
    return bytes.subarray(0, bytes.length - 1);
  }
  return bytes;
}

function parseElfSections(
  bytes: Buffer,
  endian: ElfEndian,
): ParsedElfSection[] {
  const sectionHeaderOffset = readU64(bytes, 40, endian);
  const sectionHeaderEntrySize = readU16(bytes, 58, endian);
  const sectionHeaderCount = readU16(bytes, 60, endian);

  if (sectionHeaderEntrySize <= 0) {
    throw new Error("ELF section header entry size is invalid");
  }

  const tableSize = sectionHeaderEntrySize * sectionHeaderCount;
  sliceChecked(bytes, sectionHeaderOffset, tableSize);

  const sections: ParsedElfSection[] = [];
  for (let i = 0; i < sectionHeaderCount; i += 1) {
    const off = sectionHeaderOffset + i * sectionHeaderEntrySize;
    const entry = sliceChecked(bytes, off, sectionHeaderEntrySize);

    sections.push({
      type: readU32(entry, 4, endian),
      offset: readU64(entry, 24, endian),
      size: readU64(entry, 32, endian),
      link: readU32(entry, 40, endian),
      address: readU64(entry, 16, endian),
      entrySize: readU64(entry, 56, endian),
    });
  }

  return sections;
}

function tryResolveSymbolOffsetFromSection(
  sections: ParsedElfSection[],
  sectionIndex: number,
  symbolValue: number,
  symbolSize: number,
): number | null {
  if (sectionIndex < 0 || sectionIndex >= sections.length) {
    return null;
  }

  // 0 and values >= 0xff00 are undefined/reserved in ELF
  if (sectionIndex === 0 || sectionIndex >= 0xff00) {
    return null;
  }

  const section = sections[sectionIndex]!;
  const symbolEnd = symbolValue + symbolSize;
  const sectionEnd = section.address + section.size;

  if (symbolValue < section.address || symbolEnd > sectionEnd) {
    return null;
  }

  return section.offset + (symbolValue - section.address);
}

function tryResolveSymbolOffsetFromProgramHeaders(
  bytes: Buffer,
  endian: ElfEndian,
  symbolValue: number,
  symbolSize: number,
): number | null {
  const programHeaderOffset = readU64(bytes, 32, endian);
  const programHeaderEntrySize = readU16(bytes, 54, endian);
  const programHeaderCount = readU16(bytes, 56, endian);

  if (programHeaderEntrySize <= 0 || programHeaderCount <= 0) {
    return null;
  }

  const tableSize = programHeaderEntrySize * programHeaderCount;
  sliceChecked(bytes, programHeaderOffset, tableSize);

  for (let i = 0; i < programHeaderCount; i += 1) {
    const off = programHeaderOffset + i * programHeaderEntrySize;
    const entry = sliceChecked(bytes, off, programHeaderEntrySize);

    const type = readU32(entry, 0, endian);
    if (type !== 1) {
      continue;
    }

    const fileOffset = readU64(entry, 8, endian);
    const virtualAddress = readU64(entry, 16, endian);
    const fileSize = readU64(entry, 32, endian);

    const segmentEnd = virtualAddress + fileSize;
    const symbolEnd = symbolValue + symbolSize;

    if (symbolValue < virtualAddress || symbolEnd > segmentEnd) {
      continue;
    }

    return fileOffset + (symbolValue - virtualAddress);
  }

  return null;
}

function sliceChecked(bytes: Buffer, offset: number, size: number): Buffer {
  if (offset < 0 || size < 0) {
    throw new Error("ELF bounds are negative");
  }
  if (offset + size > bytes.length) {
    throw new Error("ELF bounds exceed file length");
  }
  return bytes.subarray(offset, offset + size);
}

function readCString(bytes: Buffer, offset: number): string {
  const end = bytes.indexOf(0, offset);
  if (end === -1) {
    throw new Error("unterminated string in ELF table");
  }
  return bytes.toString("utf8", offset, end);
}

function readU16(bytes: Buffer, offset: number, endian: ElfEndian): number {
  return endian === "le"
    ? bytes.readUInt16LE(offset)
    : bytes.readUInt16BE(offset);
}

function readU32(bytes: Buffer, offset: number, endian: ElfEndian): number {
  return endian === "le"
    ? bytes.readUInt32LE(offset)
    : bytes.readUInt32BE(offset);
}

function readU64(bytes: Buffer, offset: number, endian: ElfEndian): number {
  const value =
    endian === "le"
      ? bytes.readBigUInt64LE(offset)
      : bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("ELF value exceeds JavaScript safe integer range");
  }
  return Number(value);
}

function formatExecError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const execErr = err as Error & { stdout?: unknown; stderr?: unknown };
  const stdout =
    typeof execErr.stdout === "string"
      ? execErr.stdout
      : Buffer.isBuffer(execErr.stdout)
        ? execErr.stdout.toString("utf8")
        : "";
  const stderr =
    typeof execErr.stderr === "string"
      ? execErr.stderr
      : Buffer.isBuffer(execErr.stderr)
        ? execErr.stderr.toString("utf8")
        : "";

  const output = `${stdout}${stderr}`.trim();
  if (!output) {
    return execErr.message;
  }
  return `${execErr.message}: ${output}`;
}

function mapKrunArch(arch: Architecture): "aarch64" | "x86_64" {
  return arch === "aarch64" ? "aarch64" : "x86_64";
}

function hostKrunArch(): "aarch64" | "x86_64" | null {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "x64") return "x86_64";
  return null;
}

function isNotFoundDownloadError(err: unknown): boolean {
  return err instanceof DownloadFileError && err.status === 404;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export const __test = {
  downloadKrunArchive,
  extractKernelBundleFromSharedLibraryBytes,
  generateWasmEntrypointScript,
  patchC2wDockerfileForFuse,
  resolveWasmTargetArch,
};
