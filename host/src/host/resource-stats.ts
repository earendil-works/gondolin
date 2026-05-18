import { execFileSync } from "child_process";
import fs from "fs";

export type VMHostResourceStats = {
  /** Host PID of the primary VM runner process */
  pid: number | null;
  /** RSS of the primary runner process in `bytes` */
  rssBytes: number | null;
  /** RSS of the primary runner process plus known descendants in `bytes` */
  treeRssBytes: number | null;
};

export function getHostResourceStatsForPid(
  pid: number | null,
): VMHostResourceStats {
  if (pid === null) {
    return { pid: null, rssBytes: null, treeRssBytes: null };
  }

  return {
    pid,
    rssBytes: readProcessRssBytes(pid),
    treeRssBytes: readProcessTreeRssBytes(pid),
  };
}

export function readProcessRssBytes(pid: number): number | null {
  if (!isValidPid(pid)) return null;
  if (process.platform === "linux") return readProcStatusRssBytes(pid);
  return readPsRssBytes(pid);
}

export function readProcessTreeRssBytes(pid: number): number | null {
  if (!isValidPid(pid)) return null;
  if (process.platform !== "linux") return null;

  const descendants = getLinuxDescendantPids(pid);
  if (descendants === null) return null;

  let total = 0;
  let found = false;
  for (const descendantPid of descendants) {
    const rssBytes = readProcStatusRssBytes(descendantPid);
    if (rssBytes === null) continue;
    total += rssBytes;
    found = true;
  }

  return found ? total : null;
}

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

function readProcStatusRssBytes(pid: number): number | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (!match) return null;
    const kib = Number(match[1]);
    if (!Number.isSafeInteger(kib) || kib < 0) return null;
    return kib * 1024;
  } catch {
    return null;
  }
}

function readPsRssBytes(pid: number): number | null {
  try {
    const stdout = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = stdout.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const kib = Number(trimmed);
    if (!Number.isSafeInteger(kib) || kib < 0) return null;
    return kib * 1024;
  } catch {
    return null;
  }
}

function getLinuxDescendantPids(rootPid: number): number[] | null {
  const parentByPid = readProcParentMap();
  if (parentByPid === null) return null;

  const childrenByParent = new Map<number, number[]>();
  for (const [pid, parentPid] of parentByPid.entries()) {
    const children = childrenByParent.get(parentPid);
    if (children) {
      children.push(pid);
    } else {
      childrenByParent.set(parentPid, [pid]);
    }
  }

  const result: number[] = [];
  const seen = new Set<number>();
  const stack = [rootPid];

  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);

    for (const childPid of childrenByParent.get(pid) ?? []) {
      stack.push(childPid);
    }
  }

  return result;
}

function readProcParentMap(): Map<number, number> | null {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }

  const parentByPid = new Map<number, number>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!isValidPid(pid)) continue;

    const parentPid = readProcStatParentPid(pid);
    if (parentPid === null) continue;
    parentByPid.set(pid, parentPid);
  }

  return parentByPid;
}

function readProcStatParentPid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return null;

    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    if (fields.length < 2) return null;

    const parentPid = Number(fields[1]);
    if (!Number.isInteger(parentPid) || parentPid < 0) return null;
    return parentPid;
  } catch {
    return null;
  }
}
