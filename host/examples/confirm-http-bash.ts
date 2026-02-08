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
 *   async `httpHooks.isAllowed()` decision).
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

  async promptYesNo(question: string): Promise<boolean> {
    if (!this.stdin.isTTY) {
      // In non-interactive environments, default-deny.
      this.stderr.write(`${question} (non-interactive, default: deny)\n`);
      return false;
    }

    this.pause();
    try {
      const rl = readline.createInterface({ input: this.stdin, output: this.stderr });
      const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
      rl.close();

      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    } finally {
      this.resume();
    }
  }
}

async function confirmWithNativePopup(message: string): Promise<boolean | null> {
  // macOS: AppleScript dialog
  if (process.platform === "darwin") {
    try {
      const script = [
        "on run argv",
        '  set msg to item 1 of argv',
        '  display dialog msg with title "Gondolin" buttons {"Deny", "Allow"} default button "Allow" cancel button "Deny"',
        "end run",
      ].join("\n");
      const { stdout } = await execFileAsync("osascript", ["-e", script, "--", message], {
        timeout: 60_000,
      });
      return stdout.includes("button returned:Allow");
    } catch (err: any) {
      // osascript uses exit code 1 when the user hits the cancel button.
      if (typeof err?.code === "number" && err.code === 1) return false;
      return null;
    }
  }

  // Linux: zenity / kdialog (if available)
  if (process.platform === "linux") {
    try {
      await execFileAsync(
        "zenity",
        [
          "--question",
          "--title=Gondolin",
          `--text=${message}`,
          "--ok-label=Allow",
          "--cancel-label=Deny",
        ],
        { timeout: 60_000 }
      );
      return true; // exit 0
    } catch (err: any) {
      // zenity returns exit code 1 for "No" / cancel
      if (typeof err?.code === "number" && err.code === 1) return false;
    }

    try {
      await execFileAsync("kdialog", ["--title", "Gondolin", "--yesno", message], {
        timeout: 60_000,
      });
      return true;
    } catch (err: any) {
      if (typeof err?.code === "number" && err.code === 1) return false;
      return null;
    }
  }

  return null;
}

async function main() {
  const decisions = new Map<string, boolean>();
  const pending = new Map<string, Promise<boolean>>();

  // Serialize prompts so concurrent requests don't interleave prompts.
  let promptQueue: Promise<void> = Promise.resolve();

  let attach: ShellTerminalAttach | null = null;

  const { httpHooks } = createHttpHooks({
    isAllowed: async (info) => {
      const hostname = (info.hostname || "").toLowerCase();
      if (!hostname) return false;

      const existing = decisions.get(hostname);
      if (existing !== undefined) return existing;

      const inflight = pending.get(hostname);
      if (inflight) return inflight;

      const p = (async () => {
        // Ensure prompts are not concurrent (and pause terminal forwarding while asking).
        const run = async () => {
          const target = `${info.protocol.toUpperCase()} ${hostname}:${info.port}`;
          const message = `Allow request to ${target}?`;

          // Prefer a real OS popup if available; otherwise fallback to a terminal prompt.
          if (attach) attach.pause();
          try {
            const popup = await confirmWithNativePopup(message);
            if (popup !== null) return popup;
          } finally {
            if (attach) attach.resume();
          }

          // Terminal fallback (y/N)
          const allow = await (attach
            ? attach.promptYesNo(`${message} (y/N) `)
            : Promise.resolve(false));
          return allow;
        };

        // Queue prompts (and therefore decisions) globally.
        const gate = promptQueue;
        let release!: () => void;
        promptQueue = new Promise<void>((resolve) => {
          release = resolve;
        });

        await gate;
        try {
          const allow = await run();
          decisions.set(hostname, allow);
          return allow;
        } finally {
          pending.delete(hostname);
          release();
        }
      })();

      pending.set(hostname, p);
      return p;
    },
  });

  const vm = await VM.create({ httpHooks });

  try {
    const proc = vm.shell({ attach: false });
    attach = new ShellTerminalAttach(proc);
    attach.start();

    const result = await proc;
    process.exitCode = result.exitCode;
  } finally {
    attach?.stop();
    await vm.close();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
