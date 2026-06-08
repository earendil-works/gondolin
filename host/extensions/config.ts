import { existsSync, readFileSync } from "node:fs";

export interface DnsConfig {
  mode?: "synthetic" | "trusted" | "open";
  trustedServers?: string[];
}

export interface SshConfig {
  allowedHosts?: string[];
  agent?: boolean | string;
  knownHostsFile?: string | string[];
}

export interface TcpConfig {
  hosts?: Record<string, string>;
}

export interface GondolinConfig {
  allowedHosts?: string[];
  allowedInternalHosts?: string[];
  secrets?: Record<string, { hosts: string[] }>;
  blockInternalRanges?: boolean;
  replaceSecretsInQuery?: boolean;
  allowWebSockets?: boolean;
  memory?: string;
  cpus?: number;
  dns?: DnsConfig;
  ssh?: SshConfig;
  tcp?: TcpConfig;
}

export interface LoadedConfig {
  allowedHosts: string[];
  allowedInternalHosts: string[];
  secrets: Record<string, { hosts: string[] }>;
  blockInternalRanges?: boolean;
  replaceSecretsInQuery?: boolean;
  allowWebSockets?: boolean;
  memory?: string;
  cpus?: number;
  dns?: DnsConfig;
  ssh?: {
    allowedHosts: string[];
    agent?: string;
    knownHostsFile?: string | string[];
  };
  tcp?: TcpConfig;
}

export function tryLoadConfig(configPath: string): GondolinConfig {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[gondolin] ignoring config ${configPath}: expected a JSON object`);
      return {};
    }
    return parsed as GondolinConfig;
  } catch (err) {
    console.warn(`[gondolin] ignoring malformed config ${configPath}: ${err}`);
    return {};
  }
}

function filterStrings(arr: unknown[] | undefined): string[] {
  return (arr ?? []).filter((h): h is string => typeof h === "string");
}

function mergeStringArrays(a: unknown[] | undefined, b: unknown[] | undefined): string[] {
  return filterStrings([...(a ?? []), ...(b ?? [])]);
}

function lastDefined<T>(...values: (T | undefined)[]): T | undefined {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== undefined) return values[i];
  }
  return undefined;
}

function validateSecrets(
  raw: Record<string, unknown>,
): Record<string, { hosts: string[] }> {
  const secrets: Record<string, { hosts: string[] }> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "hosts" in entry &&
      Array.isArray((entry as { hosts: unknown }).hosts) &&
      (entry as { hosts: unknown[] }).hosts.every(
        (h) => typeof h === "string",
      )
    ) {
      secrets[name] = entry as { hosts: string[] };
    } else {
      console.warn(
        `[gondolin] ignoring malformed secret "${name}" in config (expected { hosts: string[] })`,
      );
    }
  }
  return secrets;
}

function resolveSshAgent(value: boolean | string | undefined): string | undefined {
  if (value === true) return process.env.SSH_AUTH_SOCK;
  if (typeof value === "string") return value;
  return undefined;
}

export function mergeConfigs(
  global: GondolinConfig,
  project: GondolinConfig,
): LoadedConfig {
  const allowedHosts = mergeStringArrays(global.allowedHosts, project.allowedHosts);
  const allowedInternalHosts = mergeStringArrays(
    global.allowedInternalHosts,
    project.allowedInternalHosts,
  );

  const mergedSecrets = { ...(global.secrets ?? {}), ...(project.secrets ?? {}) };
  if (global.secrets && project.secrets) {
    for (const name of Object.keys(project.secrets)) {
      if (name in global.secrets) {
        console.warn(
          `[gondolin] project config overrides global secret "${name}"`,
        );
      }
    }
  }
  const secrets = validateSecrets(mergedSecrets as Record<string, unknown>);

  const result: LoadedConfig = { allowedHosts, allowedInternalHosts, secrets };

  const blockInternalRanges = lastDefined(global.blockInternalRanges, project.blockInternalRanges);
  if (blockInternalRanges !== undefined) result.blockInternalRanges = blockInternalRanges;

  const replaceSecretsInQuery = lastDefined(
    global.replaceSecretsInQuery,
    project.replaceSecretsInQuery,
  );
  if (replaceSecretsInQuery !== undefined) result.replaceSecretsInQuery = replaceSecretsInQuery;

  const allowWebSockets = lastDefined(global.allowWebSockets, project.allowWebSockets);
  if (allowWebSockets !== undefined) result.allowWebSockets = allowWebSockets;

  const memory = lastDefined(global.memory, project.memory);
  if (memory !== undefined) result.memory = memory;

  const cpus = lastDefined(global.cpus, project.cpus);
  if (cpus !== undefined) result.cpus = cpus;

  // DNS: project fields override global fields
  if (global.dns || project.dns) {
    result.dns = {
      mode: lastDefined(global.dns?.mode, project.dns?.mode),
      trustedServers: lastDefined(global.dns?.trustedServers, project.dns?.trustedServers),
    };
  }

  // SSH: allowedHosts merge, scalars project-overrides-global
  const sshHosts = mergeStringArrays(global.ssh?.allowedHosts, project.ssh?.allowedHosts);
  if (sshHosts.length > 0 || global.ssh || project.ssh) {
    const agent = resolveSshAgent(lastDefined(global.ssh?.agent, project.ssh?.agent));
    const knownHostsFile = lastDefined(global.ssh?.knownHostsFile, project.ssh?.knownHostsFile);
    result.ssh = {
      allowedHosts: sshHosts,
      ...(agent !== undefined ? { agent } : {}),
      ...(knownHostsFile !== undefined ? { knownHostsFile } : {}),
    };
  }

  // TCP hosts: project overrides global per-key
  const globalTcpHosts = global.tcp?.hosts ?? {};
  const projectTcpHosts = project.tcp?.hosts ?? {};
  if (Object.keys(globalTcpHosts).length > 0 || Object.keys(projectTcpHosts).length > 0) {
    result.tcp = { hosts: { ...globalTcpHosts, ...projectTcpHosts } };
  }

  return result;
}

export function loadConfig(
  globalConfigPath: string,
  projectConfigPath: string,
): LoadedConfig {
  const global = tryLoadConfig(globalConfigPath);
  const project = tryLoadConfig(projectConfigPath);
  return mergeConfigs(global, project);
}
