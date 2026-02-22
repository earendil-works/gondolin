import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

import type {
  Architecture,
  ContainerRuntime,
  OciPullPolicy,
} from "../build/config";
import type { OciResolvedSource, OciRootfsOptions } from "./types";

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

interface OciResolvedDigest {
  /** canonical image reference containing digest */
  reference: string;
  /** resolved OCI digest (`sha256:...`) */
  digest: string;
}

export function exportOciRootfs(opts: OciExportOptions): OciResolvedSource {
  const runtime = detectOciRuntime(opts.runtime);
  const platform = opts.platform ?? getOciPlatform(opts.arch);
  const pullPolicy = opts.pullPolicy ?? "if-not-present";

  if (pullPolicy === "always") {
    pullOciImage(runtime, opts.image, platform, opts.log);
  } else {
    const hasImage = hasLocalOciImage(runtime, opts.image, platform);
    if (!hasImage && pullPolicy === "never") {
      throw new Error(
        `OCI image '${opts.image}' is not available locally for platform '${platform}' and pullPolicy is 'never'`,
      );
    }
    if (!hasImage) {
      pullOciImage(runtime, opts.image, platform, opts.log);
    }
  }

  const resolvedDigest = resolveLocalOciImageDigest(runtime, opts.image);
  opts.log(`Resolved OCI image ${opts.image} -> ${resolvedDigest.reference}`);

  const containerId = createOciExportContainer(
    runtime,
    opts.image,
    platform,
    pullPolicy,
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

  return {
    image: opts.image,
    runtime,
    platform,
    pullPolicy,
    digest: resolvedDigest.digest,
    reference: resolvedDigest.reference,
  };
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

export function hasLocalOciImage(
  runtime: ContainerRuntime,
  image: string,
  platform: string,
): boolean {
  let output: string;
  try {
    output = runContainerCommand(
      runtime,
      buildOciCreateArgs(image, platform, "never"),
    );
  } catch (err) {
    if (isMissingLocalOciImageError(err)) {
      return false;
    }
    throw err;
  }

  const containerId = parseContainerId(output);
  if (!containerId) {
    throw new Error(
      `Failed to parse container id from ${runtime} create output for '${image}'`,
    );
  }

  try {
    runContainerCommand(runtime, ["rm", "-f", containerId]);
  } catch {
    // Best effort cleanup.
  }

  return true;
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
  pullPolicy: OciPullPolicy,
  log: (msg: string) => void,
): string {
  log(`Creating OCI export container from ${image}`);
  const output = runContainerCommand(
    runtime,
    buildOciCreateArgs(image, platform, pullPolicy),
  );
  const id = parseContainerId(output);
  if (!id) {
    throw new Error(`Failed to create OCI export container for '${image}'`);
  }
  return id;
}

export function buildOciCreateArgs(
  image: string,
  platform: string,
  pullPolicy: OciPullPolicy,
): string[] {
  const args = ["create", "--platform", platform];
  if (pullPolicy === "never") {
    args.push("--pull=never");
  }
  args.push(image, "true");
  return args;
}

function parseContainerId(output: string): string | null {
  const id = output.trim().split(/\s+/)[0];
  return id || null;
}

export function resolveLocalOciImageDigest(
  runtime: ContainerRuntime,
  image: string,
): OciResolvedDigest {
  const digestFromRef = extractDigestFromImageReference(image);
  if (digestFromRef) {
    return {
      reference: image,
      digest: digestFromRef,
    };
  }

  let output: string;
  try {
    output = runContainerCommand(runtime, [
      "image",
      "inspect",
      image,
      "--format",
      "{{json .RepoDigests}}",
    ]);
  } catch (err) {
    throw new Error(
      `Failed to resolve OCI digest metadata for '${image}': ${String(err)}`,
    );
  }

  const digests = parseRepoDigestsOutput(output);
  if (digests.length > 0) {
    const preferredDigest =
      pickRepoDigestReference(image, digests) ?? digests[0];
    const digest = extractDigestFromImageReference(preferredDigest);
    if (!digest) {
      throw new Error(
        `Failed to resolve OCI digest metadata for '${image}': invalid RepoDigest '${preferredDigest}'`,
      );
    }

    return {
      reference: preferredDigest,
      digest,
    };
  }

  // Some runtimes/local image states don't populate RepoDigests for tag references
  // (for instance imported/tagged images). Fall back to the local image id digest.
  const localDigest = resolveLocalOciImageIdDigest(runtime, image);
  if (localDigest) {
    return {
      reference: `${normalizeImageRepository(image)}@${localDigest}`,
      digest: localDigest,
    };
  }

  throw new Error(
    `Failed to resolve OCI digest metadata for '${image}': runtime did not report RepoDigests`,
  );
}

function parseRepoDigestsOutput(output: string): string[] {
  try {
    const parsed = JSON.parse(output.trim()) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.includes("@sha256:"),
    );
  } catch {
    return [];
  }
}

function resolveLocalOciImageIdDigest(
  runtime: ContainerRuntime,
  image: string,
): string | null {
  let output: string;
  try {
    output = runContainerCommand(runtime, [
      "image",
      "inspect",
      image,
      "--format",
      "{{.Id}}",
    ]);
  } catch {
    return null;
  }

  const match = output.match(/sha256:[a-fA-F0-9]{64}/);
  if (!match) {
    return null;
  }
  return match[0].toLowerCase();
}

function pickRepoDigestReference(
  requestedImage: string,
  digests: string[],
): string | null {
  const requestedRepo = normalizeImageRepository(requestedImage);

  for (const digestRef of digests) {
    const digestRepo = normalizeImageRepository(digestRef);
    if (digestRepo === requestedRepo) {
      return digestRef;
    }
    if (digestRepo.endsWith(`/${requestedRepo}`)) {
      return digestRef;
    }
  }

  return null;
}

function normalizeImageRepository(image: string): string {
  let value = image;

  const at = value.indexOf("@");
  if (at !== -1) {
    value = value.slice(0, at);
  }

  const slash = value.lastIndexOf("/");
  const colon = value.lastIndexOf(":");
  if (colon > slash) {
    value = value.slice(0, colon);
  }

  return value;
}

function extractDigestFromImageReference(imageRef: string): string | null {
  const match = imageRef.match(/@?(sha256:[a-fA-F0-9]{64})$/);
  if (!match) {
    return null;
  }
  return match[1].toLowerCase();
}

class ContainerCommandError extends Error {
  readonly status: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly runtime: ContainerRuntime;
  readonly args: string[];

  constructor(
    runtime: ContainerRuntime,
    args: string[],
    status: string,
    stdout: string,
    stderr: string,
  ) {
    super(
      `Container command failed: ${runtime} ${args.join(" ")}\n` +
        `exit: ${status}\n` +
        (stdout || stderr ? `${stdout}${stderr}` : ""),
    );
    this.name = "ContainerCommandError";
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
    this.runtime = runtime;
    this.args = [...args];
  }
}

const CONTAINER_COMMAND_MAX_BUFFER = 64 * 1024 * 1024;

function runContainerCommand(
  runtime: ContainerRuntime,
  args: string[],
): string {
  try {
    return execFileSync(runtime, args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: CONTAINER_COMMAND_MAX_BUFFER,
    });
  } catch (err) {
    const e = err as {
      status?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const status = String(e.status ?? "?");
    const stdout = commandOutputToString(e.stdout);
    const stderr = commandOutputToString(e.stderr);
    throw new ContainerCommandError(runtime, args, status, stdout, stderr);
  }
}

function isMissingLocalOciImageError(err: unknown): boolean {
  if (!(err instanceof ContainerCommandError)) {
    return false;
  }

  // docker/podman commonly return status 125 for create-time failures.
  if (err.status !== "125" && err.status !== "1") {
    return false;
  }

  const detail = `${err.stderr}\n${err.stdout}`.toLowerCase();
  // This is pretty brittle but there does not seem to be a better way
  return (
    detail.includes("image not known") ||
    detail.includes("no such image") ||
    detail.includes("manifest unknown") ||
    detail.includes("pull access denied") ||
    detail.includes("not available locally") ||
    detail.includes("does not match the specified platform") ||
    detail.includes("does not match the expected platform") ||
    detail.includes("requested platform not available locally")
  );
}

function commandOutputToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function extractTarFile(tarPath: string, destDir: string): void {
  try {
    execFileSync("tar", ["-xf", tarPath, "-C", destDir], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return;
  } catch (err) {
    const e = err as {
      code?: unknown;
      status?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };

    if (e.code === "ENOENT") {
      throw new Error(
        "OCI rootfs extraction requires the 'tar' binary, but it was not found on PATH",
      );
    }

    const stdout = commandOutputToString(e.stdout);
    const stderr = commandOutputToString(e.stderr);
    throw new Error(
      `Failed to extract OCI rootfs tar with tar (exit ${String(e.status ?? "?")}): ` +
        `${tarPath}\n` +
        (stdout || stderr ? `${stdout}${stderr}` : ""),
    );
  }
}
