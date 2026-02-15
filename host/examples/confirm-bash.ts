/**
 * Interactive bash with "ask on first target" HTTP + SSH policy.
 *
 * This example is intentionally close to `gondolin bash`, but uses:
 *
 * - HTTP hooks to pause the *first* request to each hostname and ask whether it
 *   should be allowed (with an optional wildcard decision for subdomains)
 * - SSH exec policy hooks to confirm git-over-SSH operations per host/repo
 *   (separately for clone/fetch vs push), and to confirm non-git SSH exec
 *   traffic per host
 *
 * Run with (from repo root):
 *   cd host
 *   pnpm exec tsx examples/confirm-bash.ts
 *
 * Notes:
 * - Decisions are memorized for the lifetime of the VM (this process)
 * - While a prompt is open, the triggering request is blocked awaiting the
 *   async allow/deny decision
 * - SSH egress requires `SSH_AUTH_SOCK` (ssh-agent) so the host can authenticate
 *   upstream
 */

import { execFile } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";

import {
  VM,
  createHttpHooks,
  getInfoFromSshExecRequest,
  type ExecProcess,
  type SshExecDecision,
  type SshExecRequest,
} from "../src";

const execFileAsync = promisify(execFile);

class ShellTerminalAttach {
  private readonly proc: ExecProcess;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;

  private readonly onStdinData = (chunk: Buffer) => {
    this.proc.write(chunk);
  };

  private readonly onStdinEnd = () => {
    this.proc.end();
  };

  private readonly onResize = () => {
    if (!this.stdout.isTTY) return;
    const cols = this.stdout.columns;
    const rows = this.stdout.rows;
    if (typeof cols === "number" && typeof rows === "number") {
      this.proc.resize(rows, cols);
    }
  };

  private started = false;
  private paused = false;

  constructor(
    proc: ExecProcess,
    stdin: NodeJS.ReadStream = process.stdin,
    stdout: NodeJS.WriteStream = process.stdout,
    stderr: NodeJS.WriteStream = process.stderr,
  ) {
    this.proc = proc;
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  start() {
    if (this.started) return;
    this.started = true;

    // Output (use pipe() so downstream backpressure is respected)
    const out = this.proc.stdout;
    const err = this.proc.stderr;
    if (!out || !err) {
      throw new Error('proc must be started with stdout/stderr="pipe"');
    }
    out.pipe(this.stdout, { end: false });
    err.pipe(this.stderr, { end: false });

    // Input
    if (this.stdin.isTTY) {
      this.stdin.setRawMode(true);
    }
    this.stdin.resume();

    if (this.stdout.isTTY) {
      this.onResize();
      this.stdout.on("resize", this.onResize);
    }

    this.stdin.on("data", this.onStdinData);
    this.stdin.on("end", this.onStdinEnd);
  }

  pause() {
    if (!this.started || this.paused) return;
    this.paused = true;

    this.stdin.off("data", this.onStdinData);

    // Temporarily disable raw mode so the user can type a normal line.
    if (this.stdin.isTTY) {
      this.stdin.setRawMode(false);
    }
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;

    if (this.stdin.isTTY) {
      this.stdin.setRawMode(true);
    }

    this.stdin.on("data", this.onStdinData);
  }

  stop() {
    if (!this.started) return;

    this.stdin.off("data", this.onStdinData);
    this.stdin.off("end", this.onStdinEnd);

    // Note: Don't unpipe()/pause() here.
    //
    // The exec result promise can resolve before the piped output has fully
    // drained into the destination writables (process.stdout/stderr). Let
    // Readable.pipe() clean itself up on stream end to avoid truncating tail
    // output.

    if (this.stdout.isTTY) {
      this.stdout.off("resize", this.onResize);
    }

    if (this.stdin.isTTY) {
      this.stdin.setRawMode(false);
    }
    this.stdin.pause();
  }

  async promptDecision(question: string, choices: string): Promise<string> {
    if (!this.stdin.isTTY) {
      // In non-interactive environments, default-deny.
      this.stderr.write(`${question} (non-interactive, default: deny)\n`);
      return "d";
    }

    this.pause();
    try {
      const rl = readline.createInterface({
        input: this.stdin,
        output: this.stderr,
      });
      const answer = await new Promise<string>((resolve) =>
        rl.question(`${question} ${choices} `, resolve),
      );
      rl.close();
      return answer.trim().toLowerCase();
    } finally {
      this.resume();
    }
  }
}

/** "host" = trust exact host, "wildcard" = trust *.parent, "deny" = block */
type HttpDecision = "host" | "wildcard" | "deny";

/** "repo" = trust specific repo, "host" = trust all repos on host, "deny" = block */
type GitDecision = "repo" | "host" | "deny";

/**
 * Returns the wildcard pattern for a hostname, e.g. `api.foo.com` → `*.foo.com`,
 * `foo.com` → `*.foo.com`. Returns null for single-label hosts (no dots).
 */
function wildcardFor(hostname: string): string | null {
  if (!hostname.includes(".")) return null;
  // For `api.foo.com` → `*.foo.com` (strip first label).
  // For `foo.com` → `*.foo.com` (keep as-is, wildcard covers subdomains + self).
  const dot = hostname.indexOf(".");
  const parent = hostname.slice(dot + 1);
  // If parent is a bare TLD (no dot), wildcard the whole hostname instead.
  if (!parent.includes(".")) return `*.${hostname}`;
  return `*.${parent}`;
}

async function confirmWithNativePopupHttp(
  message: string,
  wildcardLabel: string | null,
): Promise<HttpDecision | null> {
  const buttons = wildcardLabel
    ? `{"Deny", "${wildcardLabel}", "Allow"}`
    : `{"Deny", "Allow"}`;
  const defaultButton = '"Allow"';

  // macOS: AppleScript dialog
  if (process.platform === "darwin") {
    try {
      const script = [
        "on run argv",
        "  set msg to item 1 of argv",
        `  display dialog msg with title "Gondolin" buttons ${buttons} default button ${defaultButton} cancel button "Deny"`,
        "end run",
      ].join("\n");
      const { stdout } = await execFileAsync(
        "osascript",
        ["-e", script, "--", message],
        {
          timeout: 60_000,
        },
      );
      if (stdout.includes("button returned:Allow")) return "host";
      if (wildcardLabel && stdout.includes(`button returned:${wildcardLabel}`))
        return "wildcard";
      return "deny";
    } catch (err: any) {
      // osascript uses exit code 1 when the user hits the cancel button.
      if (typeof err?.code === "number" && err.code === 1) return "deny";
      return null;
    }
  }

  // Linux: zenity list dialog (if available)
  if (process.platform === "linux") {
    const choices = wildcardLabel
      ? ["Allow this host", `Allow ${wildcardLabel}`, "Deny"]
      : ["Allow", "Deny"];

    // Note: keep legacy behavior of the old example here; if zenity isn't
    // present or errors, fall back to terminal.
    try {
      const { stdout } = await execFileAsync(
        "zenity",
        [
          "--list",
          "--title=Gondolin",
          `--text=${message}`,
          "--column=Action",
          ...choices,
        ],
        { timeout: 60_000 },
      );
      const picked = stdout.trim();
      if (picked === "Allow") return "host";
      if (picked.startsWith("Allow this")) return "host";
      if (wildcardLabel && picked === `Allow ${wildcardLabel}`)
        return "wildcard";
      if (picked.startsWith("Allow *")) return "wildcard";
      return "deny";
    } catch (err: any) {
      if (typeof err?.code === "number" && err.code === 1) return "deny";
    }

    try {
      await execFileAsync(
        "kdialog",
        ["--title", "Gondolin", "--yesno", message],
        {
          timeout: 60_000,
        },
      );
      return "host";
    } catch (err: any) {
      if (typeof err?.code === "number" && err.code === 1) return "deny";
      return null;
    }
  }

  return null;
}

async function confirmWithNativePopupGit(
  message: string,
  hostLabel: string,
  repoLabel: string,
): Promise<GitDecision | null> {
  const buttons = `{"Deny", "${hostLabel}", "${repoLabel}"}`;
  const defaultButton = `"${repoLabel}"`;

  if (process.platform === "darwin") {
    try {
      const script = [
        "on run argv",
        "  set msg to item 1 of argv",
        `  display dialog msg with title "Gondolin" buttons ${buttons} default button ${defaultButton} cancel button "Deny"`,
        "end run",
      ].join("\n");
      const { stdout } = await execFileAsync(
        "osascript",
        ["-e", script, "--", message],
        {
          timeout: 60_000,
        },
      );
      if (stdout.includes(`button returned:${repoLabel}`)) return "repo";
      if (stdout.includes(`button returned:${hostLabel}`)) return "host";
      return "deny";
    } catch (err: any) {
      if (typeof err?.code === "number" && err.code === 1) return "deny";
      return null;
    }
  }

  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync(
        "zenity",
        [
          "--list",
          "--title=Gondolin",
          `--text=${message}`,
          "--column=Action",
          repoLabel,
          hostLabel,
          "Deny",
        ],
        { timeout: 60_000 },
      );
      const picked = stdout.trim();
      if (picked === repoLabel) return "repo";
      if (picked === hostLabel) return "host";
      return "deny";
    } catch (err: any) {
      if (typeof err?.code === "number" && err.code === 1) return "deny";
    }

    // kdialog doesn't easily support 3-button choices; fall back to terminal.
  }

  return null;
}

type GitOp = "clone" | "push";

function classifyGitService(service: string): GitOp | null {
  // "upload-pack" is used for clone/fetch; "receive-pack" for push.
  if (service === "git-upload-pack" || service === "git-upload-archive")
    return "clone";
  if (service === "git-receive-pack") return "push";
  return null;
}

function gitKey(
  op: GitOp,
  hostname: string,
  port: number,
  repo: string,
): string {
  return `${op}|${hostname}:${port}|${repo}`;
}

async function main() {
  const sshAgent = process.env.SSH_AUTH_SOCK;
  if (!sshAgent) {
    throw new Error(
      "SSH egress confirmation example requires SSH_AUTH_SOCK (start ssh-agent and add a key)",
    );
  }

  // Serialize prompts so concurrent HTTP/SSH events don't interleave prompts.
  let promptQueue: Promise<void> = Promise.resolve();

  let attach: ShellTerminalAttach | null = null;

  // -----------------
  // HTTP decisions
  // -----------------

  /** Maps exact `host:port` or `*.domain:port` patterns to allow/deny */
  const httpDecisions = new Map<string, boolean>();
  const httpPending = new Map<string, Promise<boolean>>();

  function lookupHttpDecision(
    hostname: string,
    port: number,
  ): boolean | undefined {
    const exact = httpDecisions.get(`${hostname}:${port}`);
    if (exact !== undefined) return exact;

    // Check `*.hostname` (wildcard that covers the hostname itself + subdomains).
    const self = httpDecisions.get(`*.${hostname}:${port}`);
    if (self !== undefined) return self;

    // Walk up the domain hierarchy checking wildcard patterns.
    let h = hostname;
    while (true) {
      const dot = h.indexOf(".");
      if (dot < 0 || dot === h.length - 1) break;
      const parent = h.slice(dot + 1);
      const wc = httpDecisions.get(`*.${parent}:${port}`);
      if (wc !== undefined) return wc;
      h = parent;
    }
    return undefined;
  }

  const { httpHooks } = createHttpHooks({
    isRequestAllowed: async (request) => {
      let parsed: URL;
      try {
        parsed = new URL(request.url);
      } catch {
        return false;
      }

      const protocol =
        parsed.protocol === "https:"
          ? "https"
          : parsed.protocol === "http:"
            ? "http"
            : null;
      if (!protocol) return false;

      const hostname = parsed.hostname.toLowerCase();
      if (!hostname) return false;

      const port = parsed.port
        ? Number(parsed.port)
        : protocol === "https"
          ? 443
          : 80;
      if (!Number.isFinite(port) || port <= 0) return false;

      const existing = lookupHttpDecision(hostname, port);
      if (existing !== undefined) return existing;

      const key = `${hostname}:${port}`;
      const inflight = httpPending.get(key);
      if (inflight) return inflight;

      const p = (async () => {
        const runPrompt = async (): Promise<HttpDecision> => {
          const target = `${protocol.toUpperCase()} ${hostname}:${port}`;
          const wc = wildcardFor(hostname);
          const wcLabel = wc ? `${wc}:${port}` : null;
          const message = `Allow ${request.method} ${request.url} (${target})?`;

          // Prefer a real OS popup if available; otherwise fallback to a terminal prompt.
          if (attach) attach.pause();
          try {
            const popup = await confirmWithNativePopupHttp(message, wcLabel);
            if (popup !== null) return popup;
          } finally {
            if (attach) attach.resume();
          }

          if (attach) {
            const choices = wcLabel
              ? `(a=allow ${key}, w=allow ${wcLabel}, d=deny) [d]`
              : `(a=allow, d=deny) [d]`;
            const answer = await attach.promptDecision(message, choices);
            if (answer === "a" || answer === "allow") return "host";
            if (wcLabel && (answer === "w" || answer === "wildcard"))
              return "wildcard";
            return "deny";
          }

          return "deny";
        };

        const gate = promptQueue;
        let release!: () => void;
        promptQueue = new Promise<void>((resolve) => {
          release = resolve;
        });

        await gate;
        try {
          const decision = await runPrompt();
          const allow = decision !== "deny";

          if (decision === "wildcard") {
            const wc = wildcardFor(hostname);
            if (wc) httpDecisions.set(`${wc}:${port}`, true);
          }
          httpDecisions.set(key, allow);

          return allow;
        } finally {
          httpPending.delete(key);
          release();
        }
      })();

      httpPending.set(key, p);
      return p;
    },
  });

  // -----------------
  // SSH decisions
  // -----------------

  const sshHostDecisions = new Map<string, boolean>();
  const sshHostPending = new Map<string, Promise<boolean>>();

  const gitDecisions = new Map<string, boolean>();
  const gitPending = new Map<string, Promise<boolean>>();

  function lookupGitDecision(
    op: GitOp,
    hostname: string,
    port: number,
    repo: string,
  ): boolean | undefined {
    const exact = gitDecisions.get(gitKey(op, hostname, port, repo));
    if (exact !== undefined) return exact;
    const hostAll = gitDecisions.get(gitKey(op, hostname, port, "*"));
    if (hostAll !== undefined) return hostAll;
    return undefined;
  }

  async function decideSshExec(req: SshExecRequest): Promise<SshExecDecision> {
    const hostname = req.hostname.toLowerCase();
    const port = req.port;

    // git-over-ssh
    const gitInfo = getInfoFromSshExecRequest(req);
    if (gitInfo) {
      const op = classifyGitService(gitInfo.service);
      if (op) {
        const existing = lookupGitDecision(op, hostname, port, gitInfo.repo);
        if (existing !== undefined) return { allow: existing };

        const promptKey = gitKey(op, hostname, port, gitInfo.repo);
        const inflight = gitPending.get(promptKey);
        if (inflight) {
          const allow = await inflight;
          return { allow };
        }

        const p = (async () => {
          const runPrompt = async (): Promise<GitDecision> => {
            const target = `${hostname}:${port}`;
            const opLabel = op === "clone" ? "clone/fetch" : "push";

            const message = `Allow git ${opLabel} via SSH to ${target}?\nRepo: ${gitInfo.repo}`;
            const hostLabel = `Allow all repos on ${target}`;
            const repoLabel = `Allow ${gitInfo.repo}`;

            if (attach) attach.pause();
            try {
              const popup = await confirmWithNativePopupGit(
                message,
                hostLabel,
                repoLabel,
              );
              if (popup !== null) return popup;
            } finally {
              if (attach) attach.resume();
            }

            if (attach) {
              const choices = `(r=allow repo, h=allow host(all repos), d=deny) [d]`;
              const answer = await attach.promptDecision(message, choices);
              if (answer === "r" || answer === "repo") return "repo";
              if (answer === "h" || answer === "host") return "host";
              return "deny";
            }

            return "deny";
          };

          const gate = promptQueue;
          let release!: () => void;
          promptQueue = new Promise<void>((resolve) => {
            release = resolve;
          });

          await gate;
          try {
            const decision = await runPrompt();
            const allow = decision !== "deny";

            if (decision === "host") {
              gitDecisions.set(gitKey(op, hostname, port, "*"), true);
            } else if (decision === "repo") {
              gitDecisions.set(gitKey(op, hostname, port, gitInfo.repo), true);
            } else {
              // Default: deny only this repo+op (keeps future prompts for other repos)
              gitDecisions.set(gitKey(op, hostname, port, gitInfo.repo), false);
            }

            return allow;
          } finally {
            gitPending.delete(promptKey);
            release();
          }
        })();

        gitPending.set(promptKey, p);
        const allow = await p;
        if (allow) return { allow: true };
        return {
          allow: false,
          exitCode: 1,
          message: `git ${op} denied by user: ${hostname}:${port} ${gitInfo.repo}`,
        };
      }

      // Unknown git-ish ssh command (e.g. git-lfs-authenticate).
      // Treat it as a non-git SSH exec and fall back to host-level confirmation.
    }

    // non-git ssh exec: prompt per host
    const hostKey = `${hostname}:${port}`;
    const existing = sshHostDecisions.get(hostKey);
    if (existing !== undefined) return { allow: existing };

    const inflight = sshHostPending.get(hostKey);
    if (inflight) {
      const allow = await inflight;
      return { allow };
    }

    const p = (async () => {
      const runPrompt = async (): Promise<boolean> => {
        const message = `Allow SSH exec to ${hostKey}?\nCommand: ${req.command}`;

        // For non-git SSH, keep it simple: allow/deny.
        if (attach) attach.pause();
        try {
          const popup = await confirmWithNativePopupHttp(message, null);
          if (popup !== null) return popup !== "deny";
        } finally {
          if (attach) attach.resume();
        }

        if (attach) {
          const answer = await attach.promptDecision(
            message,
            `(a=allow, d=deny) [d]`,
          );
          return answer === "a" || answer === "allow";
        }
        return false;
      };

      const gate = promptQueue;
      let release!: () => void;
      promptQueue = new Promise<void>((resolve) => {
        release = resolve;
      });

      await gate;
      try {
        const allow = await runPrompt();
        sshHostDecisions.set(hostKey, allow);
        return allow;
      } finally {
        sshHostPending.delete(hostKey);
        release();
      }
    })();

    sshHostPending.set(hostKey, p);
    const allow = await p;
    if (allow) return { allow: true };
    return {
      allow: false,
      exitCode: 1,
      message: `ssh denied by user: ${hostKey}`,
    };
  }

  const vm = await VM.create({
    httpHooks,
    ssh: {
      // Enable ssh egress interception (port 22)
      allowedHosts: ["*"],
      agent: sshAgent,
      execPolicy: decideSshExec,
    },
  });

  try {
    const proc = vm.shell({ attach: false });
    attach = new ShellTerminalAttach(proc);
    attach.start();

    const result = await proc;
    return result.exitCode;
  } finally {
    attach?.stop();
    await vm.close();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
