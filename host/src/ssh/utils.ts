import os from "node:os";
import path from "node:path";

import { matchHostname, normalizeHostnamePattern } from "../host/patterns.ts";

export { matchHostname, normalizeHostnamePattern };

export type SshAllowedTarget = {
  /** normalized host pattern */
  pattern: string;
  /** destination port */
  port: number;
};

function parseSshTargetPattern(raw: string): SshAllowedTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let hostPattern = trimmed;
  let port = 22;

  // Support bracket form: [host]:port
  if (hostPattern.startsWith("[")) {
    const end = hostPattern.indexOf("]");
    if (end === -1) return null;
    const host = hostPattern.slice(1, end);
    const rest = hostPattern.slice(end + 1);
    if (!host) return null;
    hostPattern = host;

    if (rest) {
      if (!rest.startsWith(":")) return null;
      const portStr = rest.slice(1);
      if (!/^[0-9]+$/.test(portStr)) return null;
      port = Number.parseInt(portStr, 10);
    }
  } else {
    const idx = hostPattern.lastIndexOf(":");
    if (idx !== -1) {
      const maybePort = hostPattern.slice(idx + 1);
      if (/^[0-9]+$/.test(maybePort)) {
        port = Number.parseInt(maybePort, 10);
        hostPattern = hostPattern.slice(0, idx);
      }
    }
  }

  const normalizedPattern = normalizeHostnamePattern(hostPattern);
  if (!normalizedPattern) return null;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }

  return { pattern: normalizedPattern, port };
}

export function normalizeSshAllowedTargets(
  targets?: string[],
): SshAllowedTarget[] {
  const out: SshAllowedTarget[] = [];
  const seen = new Set<string>();

  for (const raw of targets ?? []) {
    const parsed = parseSshTargetPattern(raw);
    if (!parsed) continue;
    const key = `${parsed.pattern}:${parsed.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }

  return out;
}

export function normalizeSshKnownHostsFiles(
  knownHostsFile?: string | string[],
): string[] {
  const candidates: string[] = [];
  if (typeof knownHostsFile === "string") {
    candidates.push(knownHostsFile);
  } else if (Array.isArray(knownHostsFile)) {
    for (const file of knownHostsFile) {
      if (typeof file === "string" && file.trim()) {
        candidates.push(file);
      }
    }
  }

  if (candidates.length === 0) {
    candidates.push(path.join(os.homedir(), ".ssh", "known_hosts"));
    candidates.push("/etc/ssh/ssh_known_hosts");
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const file of candidates) {
    const normalized = file.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}
