import path from "node:path";

import type { BootCommandMessage } from "./control-protocol.ts";

export type SandboxFsConfig = {
  fuseMount: string;
  fuseBinds: string[];
  mapCreatedOwnership: boolean;
};

export function normalizeSandboxFsConfig(
  message: BootCommandMessage,
): SandboxFsConfig {
  const fuseMount = normalizeMountPath(
    message.fuseMount ?? "/data",
    "fuseMount",
  );
  const fuseBinds = normalizeBindList(message.fuseBinds ?? []);
  const mapCreatedOwnership = message.mapCreatedOwnership ?? false;
  if (typeof mapCreatedOwnership !== "boolean") {
    throw new Error("mapCreatedOwnership must be a boolean");
  }
  return {
    fuseMount,
    fuseBinds,
    mapCreatedOwnership,
  };
}

function normalizeMountPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  let normalized = path.posix.normalize(value);
  if (!normalized.startsWith("/")) {
    throw new Error(`${field} must be an absolute path`);
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.includes("\0")) {
    throw new Error(`${field} contains null bytes`);
  }
  if (/[\r\n]/.test(normalized)) {
    throw new Error(`${field} contains newlines`);
  }
  return normalized;
}

function normalizeBindList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("fuseBinds must be an array of absolute paths");
  }
  const seen = new Set<string>();
  const binds: string[] = [];
  for (const entry of value) {
    const normalized = normalizeMountPath(entry, "fuseBinds");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    binds.push(normalized);
  }
  binds.sort();
  return binds;
}

export function isSameSandboxFsConfig(
  left: SandboxFsConfig,
  right: SandboxFsConfig,
) {
  if (left.fuseMount !== right.fuseMount) return false;
  if (left.fuseBinds.length !== right.fuseBinds.length) return false;
  for (let i = 0; i < left.fuseBinds.length; i += 1) {
    if (left.fuseBinds[i] !== right.fuseBinds[i]) return false;
  }
  return left.mapCreatedOwnership === right.mapCreatedOwnership;
}

/**
 * Maximum kernel cmdline length in `bytes` up to which the legacy
 * `sandboxfs.bind=` argument is still emitted.
 *
 * Linux truncates the cmdline at 2048 bytes on arm64/x86_64, and QEMU's x86
 * microvm machine appends `virtio_mmio.device=` entries on its own, so this
 * keeps some headroom.
 */
export const LEGACY_CMDLINE_BINDS_MAX_BYTES = 1536;

/**
 * Build the kernel cmdline for the guest.
 *
 * Current guests fetch the bind mount list from the host over the sandboxfs
 * RPC channel (`mounts` op), which has no size limit. For older guest images
 * the binds are also put on the cmdline (`sandboxfs.bind=`) as far as they fit
 * without being truncated, with gondolin's own mounts (e.g. the MITM CA, which
 * init needs early) first. Binds that are left out are still mounted later by
 * the host-side fallback in the VM.
 */
export function buildSandboxfsAppend(
  baseAppend: string,
  config: SandboxFsConfig,
) {
  const base = joinCmdline([baseAppend, `sandboxfs.mount=${config.fuseMount}`]);

  const candidates = config.fuseBinds.filter(isCmdlineSafeBind).sort((a, b) => {
    const aInternal = isInternalBind(a);
    const bInternal = isInternalBind(b);
    if (aInternal !== bInternal) return aInternal ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const prefix = " sandboxfs.bind=";
  let length = Buffer.byteLength(base) + Buffer.byteLength(prefix);
  const binds: string[] = [];
  for (const bind of candidates) {
    const extra = Buffer.byteLength(bind) + (binds.length > 0 ? 1 : 0);
    if (length + extra > LEGACY_CMDLINE_BINDS_MAX_BYTES) continue;
    binds.push(bind);
    length += extra;
  }
  const pieces = [base];
  if (binds.length > 0) {
    // parents have to be bound before their children
    binds.sort();
    pieces.push(`${prefix}${binds.join(",")}`);
  }
  if (config.mapCreatedOwnership) {
    pieces.push("sandboxfs.map-created-ownership=1");
  }
  return joinCmdline(pieces);
}

/** Build the result of the sandboxfs `mounts` rpc op */
export function buildSandboxfsMountsResult(config: SandboxFsConfig) {
  return {
    mount: config.fuseMount,
    binds: [...config.fuseBinds],
  };
}

function isInternalBind(bind: string) {
  return bind === "/etc/gondolin" || bind.startsWith("/etc/gondolin/");
}

function isCmdlineSafeBind(bind: string) {
  // whitespace splits cmdline arguments and commas split the bind list
  return !/[\s,"']/.test(bind);
}

function joinCmdline(pieces: string[]) {
  return pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .join(" ");
}
