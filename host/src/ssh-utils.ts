import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import type { SshCredential } from "./qemu-ssh";

export type SshAllowedTarget = {
  /** normalized host pattern */
  pattern: string;
  /** destination port */
  port: number;
};

export type ResolvedSshCredential = {
  /** matched host pattern */
  pattern: string;
  /** destination port */
  port: number;
  /** upstream ssh username */
  username?: string;
  /** private key in OpenSSH/PEM format */
  privateKey: string | Buffer;
  /** private key passphrase */
  passphrase?: string | Buffer;
};

export function generateSshHostKey(): string {
  // ssh2 Server hostKeys expects PEM PKCS#1 RSA keys (ed25519 pkcs8 is not supported)
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    privateKeyEncoding: { format: "pem", type: "pkcs1" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return privateKey;
}

export function normalizeHostnamePattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

export function matchHostname(hostname: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === "*") return true;

  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(hostname);
}

export function parseSshTargetPattern(raw: string): SshAllowedTarget | null {
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

export function normalizeSshAllowedTargets(targets?: string[]): SshAllowedTarget[] {
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

export function normalizeSshCredentials(
  credentials?: Record<string, SshCredential>
): ResolvedSshCredential[] {
  const entries: ResolvedSshCredential[] = [];
  for (const [rawPattern, credential] of Object.entries(credentials ?? {})) {
    const target = parseSshTargetPattern(rawPattern);
    if (!target) continue;
    entries.push({
      pattern: target.pattern,
      port: target.port,
      username: credential.username,
      privateKey: credential.privateKey,
      passphrase: credential.passphrase,
    });
  }
  return entries;
}

type OpenSshKnownHostsEntry = {
  /** known_hosts marker like "@revoked" */
  marker: string | null;
  /** raw host patterns from the first column */
  hostPatterns: string[];
  /** key type string (e.g. "ssh-ed25519") */
  keyType: string;
  /** decoded public key blob */
  key: Buffer;
};

export function normalizeSshKnownHostsFiles(knownHostsFile?: string | string[]): string[] {
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

export function parseOpenSshKnownHosts(content: string): OpenSshKnownHostsEntry[] {
  const entries: OpenSshKnownHostsEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let marker: string | null = null;
    let rest = line;
    if (rest.startsWith("@")) {
      const space = rest.indexOf(" ");
      if (space === -1) continue;
      marker = rest.slice(0, space);
      rest = rest.slice(space + 1).trim();
    }

    const parts = rest.split(/\s+/);
    if (parts.length < 3) continue;
    const [hostsField, keyType, keyB64] = parts;

    let key: Buffer;
    try {
      key = Buffer.from(keyB64, "base64");
    } catch {
      continue;
    }

    if (!hostsField || !keyType || key.length === 0) continue;
    entries.push({
      marker,
      hostPatterns: hostsField.split(",").filter(Boolean),
      keyType,
      key,
    });
  }
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchOpenSshHostPattern(hostname: string, pattern: string): boolean {
  const hn = hostname.toLowerCase();
  const pat = pattern.startsWith("|1|") ? pattern : pattern.toLowerCase();

  // Hashed hostnames: "|1|<salt-b64>|<hmac-b64>"
  if (pat.startsWith("|1|")) {
    const parts = pat.split("|");
    // ['', '1', salt, hmac]
    if (parts.length !== 4) return false;
    const saltB64 = parts[2];
    const hmacB64 = parts[3];
    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(saltB64!, "base64");
      expected = Buffer.from(hmacB64!, "base64");
    } catch {
      return false;
    }
    const actual = crypto.createHmac("sha1", salt).update(hn, "utf8").digest();
    return actual.length === expected.length && actual.equals(expected);
  }

  // Wildcards: "*" and "?" like OpenSSH
  if (pat.includes("*") || pat.includes("?")) {
    const re = new RegExp(
      "^" + escapeRegExp(pat).replace(/\\\*/g, ".*").replace(/\\\?/g, ".") + "$",
      "i"
    );
    return re.test(hn);
  }

  return hn === pat;
}

function hostMatchesOpenSshKnownHostsList(hostname: string, patterns: string[], port: number): boolean {
  const candidates = port === 22 ? [hostname, `[${hostname}]:22`] : [`[${hostname}]:${port}`];

  for (const candidate of candidates) {
    let positive = false;
    for (const rawPattern of patterns) {
      if (!rawPattern) continue;
      const negated = rawPattern.startsWith("!");
      const pat = negated ? rawPattern.slice(1) : rawPattern;
      if (!pat) continue;

      if (matchOpenSshHostPattern(candidate, pat)) {
        if (negated) {
          return false;
        }
        positive = true;
      }
    }
    if (positive) return true;
  }

  return false;
}

export function createOpenSshKnownHostsHostVerifier(
  files: string[]
): (hostname: string, key: Buffer, port: number) => boolean {
  const entries: OpenSshKnownHostsEntry[] = [];
  const loadedFiles: string[] = [];

  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      loadedFiles.push(file);
      entries.push(...parseOpenSshKnownHosts(content));
    } catch {
      // Ignore unreadable files here; we'll fail if nothing could be loaded
    }
  }

  if (loadedFiles.length === 0) {
    throw new Error(`no OpenSSH known_hosts files found (tried ${files.join(", ")})`);
  }

  return (hostname: string, key: Buffer, port: number) => {
    const host = hostname.trim().toLowerCase();
    if (!host) return false;
    const sshPort = Number.isInteger(port) && port > 0 ? port : 22;

    for (const entry of entries) {
      if (!hostMatchesOpenSshKnownHostsList(host, entry.hostPatterns, sshPort)) {
        continue;
      }

      // Respect revoked keys
      if (entry.marker === "@revoked") {
        if (entry.key.equals(key)) {
          return false;
        }
        continue;
      }

      if (entry.key.equals(key)) {
        return true;
      }
    }

    // If we saw matching host patterns but no matching key, reject
    // If we saw no matching host patterns, also reject (unknown host)
    return false;
  };
}
