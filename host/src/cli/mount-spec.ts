import { execFileSync } from "node:child_process";

export type MountSpec = {
  hostPath: string;
  guestPath: string;
  readonly: boolean;
};

export type CliHostPathDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runCygpath?: (args: string[]) => string;
};

type ParseMountSpecDeps = CliHostPathDeps;

function defaultRunCygpath(args: string[]): string {
  return execFileSync("cygpath", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).trim();
}

function isGitBashEnvironment(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): boolean {
  return platform === "win32" && typeof env.MSYSTEM === "string";
}

function splitMountSpec(spec: string): MountSpec {
  const parts = spec.split(":");
  if (parts.length < 2) {
    throw new Error(`Invalid mount format: ${spec} (expected HOST:GUEST[:ro])`);
  }

  let hostPath: string;
  let rest: string[];

  if (
    parts[0].length === 1 &&
    /^[a-zA-Z]$/.test(parts[0]) &&
    parts.length >= 3
  ) {
    hostPath = `${parts[0]}:${parts[1]}`;
    rest = parts.slice(2);
  } else {
    hostPath = parts[0];
    rest = parts.slice(1);
  }

  if (rest.length === 0) {
    throw new Error(`Invalid mount format: ${spec} (missing guest path)`);
  }

  let guestPath: string;
  let options: string[];

  if (rest[0].length === 1 && /^[a-zA-Z]$/.test(rest[0]) && rest.length >= 2) {
    guestPath = `${rest[0]}:${rest[1]}`;
    options = rest.slice(2);
  } else {
    guestPath = rest[0];
    options = rest.slice(1);
  }

  return {
    hostPath,
    guestPath,
    readonly: options.includes("ro"),
  };
}

function recoverGitBashPathListSpec(
  spec: string,
  deps: ParseMountSpecDeps,
): string {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (!isGitBashEnvironment(platform, env) || !spec.includes(";")) {
    return spec;
  }

  const runCygpath = deps.runCygpath ?? defaultRunCygpath;
  try {
    return runCygpath(["-u", "-p", spec]);
  } catch {
    return spec;
  }
}

function convertMsysDrivePathToWindows(value: string): string | null {
  const match = /^\/([a-zA-Z])(?:(\/.*)|$)/.exec(value);
  if (!match) return null;
  const drive = match[1]!.toUpperCase();
  const suffix = match[2];
  return `${drive}:${suffix && suffix.length > 0 ? suffix : "/"}`;
}

export function normalizeCliHostPath(
  hostPath: string,
  deps: CliHostPathDeps = {},
): string {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== "win32") return hostPath;

  const drivePath = convertMsysDrivePathToWindows(hostPath);
  if (drivePath) {
    return drivePath;
  }

  if (!isGitBashEnvironment(platform, env) || !hostPath.startsWith("/")) {
    return hostPath;
  }

  const runCygpath = deps.runCygpath ?? defaultRunCygpath;
  try {
    return runCygpath(["-m", hostPath]);
  } catch {
    return hostPath;
  }
}

export function parseMountSpec(
  spec: string,
  deps: ParseMountSpecDeps = {},
): MountSpec {
  const normalizedSpec = recoverGitBashPathListSpec(spec, deps);
  const parsed = splitMountSpec(normalizedSpec);
  parsed.hostPath = normalizeCliHostPath(parsed.hostPath, deps);
  return parsed;
}
