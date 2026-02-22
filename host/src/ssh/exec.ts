import type { SshExecRequest } from "../qemu/ssh";

export type GitSshExecInfo = {
  /** git service name (for example "git-upload-pack") */
  service: string;
  /** git repo path (for example "org/name.git") */
  repo: string;
};

function splitSshExecCommand(command: string): string[] | null {
  const out: string[] = [];
  let i = 0;

  while (i < command.length) {
    // skip whitespace
    while (i < command.length && /\s/.test(command[i]!)) i += 1;
    if (i >= command.length) break;

    let cur = "";
    let mode: "none" | "single" | "double" = "none";

    while (i < command.length) {
      const ch = command[i]!;

      if (mode === "none") {
        if (/\s/.test(ch)) break;
        if (ch === "'") {
          mode = "single";
          i += 1;
          continue;
        }
        if (ch === '"') {
          mode = "double";
          i += 1;
          continue;
        }
        if (ch === "\\") {
          i += 1;
          if (i >= command.length) {
            // trailing escape
            return null;
          }
          cur += command[i]!;
          i += 1;
          continue;
        }
        cur += ch;
        i += 1;
        continue;
      }

      if (mode === "single") {
        if (ch === "'") {
          mode = "none";
          i += 1;
          continue;
        }
        cur += ch;
        i += 1;
        continue;
      }

      // mode === "double"
      if (ch === '"') {
        mode = "none";
        i += 1;
        continue;
      }
      if (ch === "\\") {
        i += 1;
        if (i >= command.length) {
          // trailing escape
          return null;
        }
        cur += command[i]!;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
    }

    if (mode !== "none") {
      // unterminated quote
      return null;
    }

    out.push(cur);

    // consume trailing whitespace for this arg
    while (i < command.length && /\s/.test(command[i]!)) i += 1;
  }

  return out;
}

function basenamePosix(value: string): string {
  const idx = value.lastIndexOf("/");
  return idx === -1 ? value : value.slice(idx + 1);
}

/**
 * Best-effort parser for git-over-SSH exec commands.
 *
 * This intentionally only understands common git smart-protocol invocations such as:
 * - git-upload-pack 'org/repo.git'
 * - git-receive-pack 'org/repo.git'
 *
 * Security note: many SSH servers execute the requested command via a shell (for example `sh -c <command>`).
 * This file is NOT a full shell parser; instead we stay safe by (1) requiring exactly two argv tokens and
 * (2) only accepting conservative service/repo strings that contain no shell metacharacters/expansions.
 * If the command deviates from the canonical git form, we fail closed and return null.
 */
export function getInfoFromSshExecRequest(
  req: SshExecRequest,
): GitSshExecInfo | null {
  const argv = splitSshExecCommand(req.command);
  if (!argv || argv.length !== 2) return null;

  const serviceArg = argv[0]!.trim();
  // Reject anything that could trigger shell expansion in the executable path.
  // (Some SSH servers execute the command via a shell.)
  if (!/^(?:\/)?(?:[a-z0-9._+-]+\/)*git-[a-z0-9][a-z0-9-]*$/i.test(serviceArg))
    return null;

  const service = basenamePosix(serviceArg);
  if (!/^git-[a-z0-9][a-z0-9-]*$/i.test(service)) return null;

  let repo = (argv[1] ?? "").trim();
  if (!repo) return null;

  // Common normalizations for server-side git paths
  if (repo.startsWith("~/")) repo = repo.slice(2);
  repo = repo.replace(/^\/+/, "");
  repo = repo.replace(/\/+$/, "");

  // Conservative sanity checks
  if (!repo.includes("/")) return null;
  if (repo.includes("..")) return null;
  if (repo.startsWith("-")) return null;

  // Ensure the repo argument is safe even if the upstream SSH server executes via a shell.
  // We intentionally only accept the common "org/repo(.git)"-style path used by git-over-SSH.
  if (
    !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+(?:\.git)?$/i.test(repo)
  ) {
    return null;
  }

  return { service, repo };
}
