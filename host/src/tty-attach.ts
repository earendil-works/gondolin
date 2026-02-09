import type { Readable } from "node:stream";

export type AttachEscape = {
  /** escape byte value */
  byte: number;
  /** called after local cleanup when escape is triggered */
  onEscape: () => void;
};

export type AttachTtyHooks = {
  write: (chunk: Buffer) => void;
  end: () => void;
  resize?: (rows: number, cols: number) => void;
  escape?: AttachEscape;
};

/**
 * Attach a PTY-like exec session to local stdio.
 *
 * This is a shared helper used by both the library (ExecProcess.attach) and
 * the CLI, to reduce drift between implementations.
 */
export function attachTty(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
  stdoutPipe: Readable | null,
  stderrPipe: Readable | null,
  hooks: AttachTtyHooks
): { cleanup: () => void } {
  const stderrOut = stderr ?? stdout;

  let cleanupDone = false;

  const onResize = () => {
    if (!hooks.resize) return;
    if (!stdout.isTTY) return;
    const cols = stdout.columns;
    const rows = stdout.rows;
    if (typeof cols === "number" && typeof rows === "number") {
      hooks.resize(rows, cols);
    }
  };

  const onStdinData = (chunk: Buffer) => {
    const esc = hooks.escape;
    if (esc) {
      const idx = chunk.indexOf(esc.byte);
      if (idx !== -1) {
        // Forward bytes before the escape, but do not forward the escape byte itself.
        if (idx > 0) {
          hooks.write(chunk.subarray(0, idx));
        }
        cleanup();
        esc.onEscape();
        return;
      }
    }

    hooks.write(chunk);
  };

  const onStdinEnd = () => {
    hooks.end();
  };

  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;

    stdin.off("data", onStdinData);
    stdin.off("end", onStdinEnd);

    if (stdout.isTTY) {
      stdout.off("resize", onResize);
    }

    if (stdin.isTTY) {
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }

    stdin.pause();
  };

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  stdin.resume();

  if (stdout.isTTY) {
    onResize();
    stdout.on("resize", onResize);
  }

  stdin.on("data", onStdinData);
  stdin.on("end", onStdinEnd);

  // Use `pipe()` so downstream backpressure (write() => false) pauses the
  // source stream and stays within our credit window instead of buffering
  // unboundedly in the destination writable.
  if (stdoutPipe) {
    stdoutPipe.pipe(stdout, { end: false });
    // Ensure already-buffered chunks are flushed promptly.
    stdoutPipe.resume();
  }

  if (stderrPipe) {
    stderrPipe.pipe(stderrOut, { end: false });
    stderrPipe.resume();
  }

  return { cleanup };
}
