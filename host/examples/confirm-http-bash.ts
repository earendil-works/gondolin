/**
 * Interactive bash with "ask on first domain" HTTP policy.
 *
 * This example is intentionally close to `gondolin bash`, but uses HTTP hooks
 * to pause the *first* request to each hostname and ask the user whether it
 * should be allowed.
 *
 * Run with (from repo root):
 *   cd host
 *   pnpm exec tsx examples/confirm-http-bash.ts
 *
 * Notes:
 * - The prompt is shown once per hostname for the lifetime of the VM.
 * - While the prompt is open, the triggering request is blocked (awaiting the
 *   async `httpHooks.isRequestAllowed()` decision).
 * - This only applies to HTTP/HTTPS traffic (the only kind of guest egress
 *   Gondolin supports).
 */

import { execFile } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";

import { VM, createHttpHooks, type ExecProcess } from "../src";

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
    stderr: NodeJS.WriteStream = process.stderr
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
      const rl = readline.createInterface({ input: this.stdin, output: this.stderr });
      const answer = await new Promise<string>((resolve) =>
        rl.question(`${question} ${choices} `, resolve)
      );
      rl.close();
      return answer.trim().toLowerCase();
    } finally {
      this.resume();
    }
  }
}

/** "host" = trust exact host, "wildcard" = trust *.parent, "deny" = block */
type Decision = "host" | "wildcard" | "deny";

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

async function confirmWithNativePopup(
  message: string,
  wildcardLabel: string | null
): Promise<Decision | null> {
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
      const { stdout } = await execFileAsync("osascript", ["-e", script, "--", message], {
        timeout: 60_000,
      });
      if (stdout.includes("button returned:Allow")) return "host";
      if (wildcardLabel && stdout.includes(`button returned:${wildcardLabel}`)) return "wildcard";
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
        { timeout: 60_000 }
      );
      const picked = stdout.trim();
      if (picked.startsWith("Allow this")) return "host";
      if (picked.startsWith("Allow *")) return "wildcard";
      return "deny";
    } catch (err: any) {
      if (typeof err?.code === "number" && err.code === 1) return "deny";
    }

    try {
      await execFileAsync("kdialog", ["--title", "Gondolin", "--yesno", message], {
        timeout: 60_000,
      });
      return "host";
    } catch (err: any) {
      if (typeof err?.code === "number" && err.code === 1) return "deny";
      return null;
    }
  }

  return null;
}

async function main() {
  /** Maps exact `host:port` or `*.domain:port` patterns to allow/deny */
  const decisions = new Map<string, boolean>();
  const pending = new Map<string, Promise<boolean>>();

  function lookupDecision(hostname: string, port: number): boolean | undefined {
    const exact = decisions.get(`${hostname}:${port}`);
    if (exact !== undefined) return exact;

    // Check `*.hostname` (wildcard that covers the hostname itself + subdomains).
    const self = decisions.get(`*.${hostname}:${port}`);
    if (self !== undefined) return self;

    // Walk up the domain hierarchy checking wildcard patterns.
    let h = hostname;
    while (true) {
      const dot = h.indexOf(".");
      if (dot < 0 || dot === h.length - 1) break;
      const parent = h.slice(dot + 1);
      const wc = decisions.get(`*.${parent}:${port}`);
      if (wc !== undefined) return wc;
      h = parent;
    }
    return undefined;
  }

  // Serialize prompts so concurrent requests don't interleave prompts.
  let promptQueue: Promise<void> = Promise.resolve();

  let attach: ShellTerminalAttach | null = null;

  const { httpHooks } = createHttpHooks({
    isRequestAllowed: async (request) => {
      let parsed: URL;
      try {
        parsed = new URL(request.url);
      } catch {
        return false;
      }

      const protocol = parsed.protocol === "https:" ? "https" : parsed.protocol === "http:" ? "http" : null;
      if (!protocol) return false;

      const hostname = parsed.hostname.toLowerCase();
      if (!hostname) return false;

      const port = parsed.port ? Number(parsed.port) : protocol === "https" ? 443 : 80;
      if (!Number.isFinite(port) || port <= 0) return false;

      const existing = lookupDecision(hostname, port);
      if (existing !== undefined) return existing;

      const key = `${hostname}:${port}`;
      const inflight = pending.get(key);
      if (inflight) return inflight;

      const p = (async () => {
        // Ensure prompts are not concurrent (and pause terminal forwarding while asking).
        const run = async (): Promise<Decision> => {
          const target = `${protocol.toUpperCase()} ${hostname}:${port}`;
          const wc = wildcardFor(hostname);
          const wcLabel = wc ? `${wc}:${port}` : null;
          const message = `Allow ${request.method} ${request.url} (${target})?`;

          // Prefer a real OS popup if available; otherwise fallback to a terminal prompt.
          if (attach) attach.pause();
          try {
            const popup = await confirmWithNativePopup(message, wcLabel);
            if (popup !== null) return popup;
          } finally {
            if (attach) attach.resume();
          }

          // Terminal fallback
          if (attach) {
            const choices = wcLabel
              ? `(a=allow ${key}, w=allow ${wcLabel}, d=deny) [d]`
              : `(a=allow, d=deny) [d]`;
            const answer = await attach.promptDecision(message, choices);
            if (answer === "a" || answer === "allow") return "host";
            if (wcLabel && (answer === "w" || answer === "wildcard")) return "wildcard";
            return "deny";
          }
          return "deny";
        };

        // Queue prompts (and therefore decisions) globally.
        const gate = promptQueue;
        let release!: () => void;
        promptQueue = new Promise<void>((resolve) => {
          release = resolve;
        });

        await gate;
        try {
          const decision = await run();
          const allow = decision !== "deny";
          if (decision === "wildcard") {
            const wc = wildcardFor(hostname);
            if (wc) decisions.set(`${wc}:${port}`, true);
          }
          decisions.set(key, allow);
          return allow;
        } finally {
          pending.delete(key);
          release();
        }
      })();

      pending.set(key, p);
      return p;
    },
  });

  const vm = await VM.create({ httpHooks });

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
