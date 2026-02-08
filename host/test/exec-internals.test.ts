import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  applyOutputChunk,
  createExecSession,
  ExecProcess,
  finishExecSession,
  resolveOutputMode,
} from "../src/exec";

test("resolveOutputMode only treats objects with write() as writable", () => {
  const buf = Buffer.from("x");
  assert.throws(() => resolveOutputMode(buf as any, undefined, "stdout"));

  const writableLike = {
    write(_chunk: any) {},
  };
  const resolvedWritable = resolveOutputMode(writableLike as any, undefined, "stdout");
  assert.equal(resolvedWritable.mode, "writable");
});

test("pipe mode byte accounting is stable with setEncoding()", async () => {
  const session = createExecSession(1, {
    stdinEnabled: false,
    stdout: { mode: "pipe" },
    stderr: { mode: "ignore" },
    windowBytes: 4096,
  });

  session.sendWindowUpdate = () => {
    // unused
  };

  const stdout = session.stdoutPipe!;
  stdout.setEncoding("utf8");

  const data = Buffer.from("€"); // 3 bytes
  applyOutputChunk(session, "stdout", data);

  assert.equal(stdout.getBufferedBytes(), 3);

  const received = await new Promise<string>((resolve) => {
    stdout.once("data", (chunk: string) => resolve(chunk));
  });

  assert.equal(Buffer.byteLength(received), 3);
  assert.equal(stdout.getBufferedBytes(), 0);
});

test("pipe mode byte accounting respects non-utf8 setEncoding()", async () => {
  // hex
  {
    const session = createExecSession(1, {
      stdinEnabled: false,
      stdout: { mode: "pipe" },
      stderr: { mode: "ignore" },
      windowBytes: 4096,
    });
    session.sendWindowUpdate = () => {};

    const stdout = session.stdoutPipe!;
    stdout.setEncoding("hex");

    const data = Buffer.from([0, 1, 2, 3, 255]);
    applyOutputChunk(session, "stdout", data);

    assert.equal(stdout.getBufferedBytes(), data.length);

    const received = await new Promise<string>((resolve) => {
      stdout.once("data", (chunk: string) => resolve(chunk));
    });

    assert.equal(Buffer.byteLength(received, "hex"), data.length);
    assert.equal(stdout.getBufferedBytes(), 0);
  }

  // base64
  {
    const session = createExecSession(1, {
      stdinEnabled: false,
      stdout: { mode: "pipe" },
      stderr: { mode: "ignore" },
      windowBytes: 4096,
    });
    session.sendWindowUpdate = () => {};

    const stdout = session.stdoutPipe!;
    stdout.setEncoding("base64");

    const data = Buffer.from([1, 2, 3, 4, 5, 6, 7]);
    applyOutputChunk(session, "stdout", data);

    assert.equal(stdout.getBufferedBytes(), data.length);

    // base64 decoding can buffer trailing bytes internally until EOF, so consume
    // the full stream to ensure the final partial group is flushed.
    const collected = (async () => {
      let out = "";
      for await (const chunk of stdout) {
        out += chunk as string;
      }
      return out;
    })();

    finishExecSession(session, 0);

    const received = await collected;

    assert.equal(Buffer.from(received, "base64").length, data.length);
    assert.equal(stdout.getBufferedBytes(), 0);
  }
});

test("ExecProcess.output() yields Buffer data even if setEncoding() is used on pipes", async () => {
  const session = createExecSession(1, {
    stdinEnabled: false,
    stdout: { mode: "pipe" },
    stderr: { mode: "pipe" },
    windowBytes: 4096,
  });
  session.sendWindowUpdate = () => {};

  const proc = new ExecProcess(session, {
    sendStdin: () => {
      // unused
    },
    sendStdinEof: () => {
      // unused
    },
    cleanup: () => {
      // unused
    },
  });

  // Force async iteration to produce strings for stdout.
  session.stdoutPipe!.setEncoding("hex");

  const collected = (async () => {
    const out: Array<{ stream: "stdout" | "stderr"; data: Buffer; text: string }> = [];
    for await (const chunk of proc.output()) {
      out.push(chunk);
    }
    return out;
  })();

  applyOutputChunk(session, "stdout", Buffer.from("hi", "utf8"));
  applyOutputChunk(session, "stderr", Buffer.from("err", "utf8"));
  finishExecSession(session, 0);

  const chunks = await collected;

  const byStream = new Map(chunks.map((c) => [c.stream, c] as const));

  const outChunk = byStream.get("stdout");
  assert.ok(outChunk);
  assert.ok(Buffer.isBuffer(outChunk.data));
  assert.equal(outChunk.data.toString("utf8"), "hi");
  assert.equal(outChunk.text, "hi");

  const errChunk = byStream.get("stderr");
  assert.ok(errChunk);
  assert.ok(Buffer.isBuffer(errChunk.data));
  assert.equal(errChunk.data.toString("utf8"), "err");
  assert.equal(errChunk.text, "err");
});

test("applyOutputChunk rejects exec on writable write() throw and switches to ignore", async () => {
  const events: Array<{ stdout: number; stderr: number }> = [];

  const badWritable = {
    write(_data: any) {
      const err: any = new Error("boom");
      err.code = "EPIPE";
      throw err;
    },
    once(_event: string, _cb: (...args: any[]) => void) {
      // unused in this test
      return this;
    },
  };

  const session = createExecSession(1, {
    stdinEnabled: false,
    stdout: { mode: "writable", stream: badWritable as any },
    stderr: { mode: "ignore" },
    windowBytes: 4096,
  });

  session.sendWindowUpdate = (stdout, stderr) => {
    events.push({ stdout, stderr });
  };

  applyOutputChunk(session, "stdout", Buffer.alloc(4096));

  assert.equal(session.stdoutMode.mode, "ignore");
  assert.ok(session.outputWriteError);
  assert.equal((session.outputWriteError as any).code, "EPIPE");

  await assert.rejects(session.resultPromise, (err: any) => {
    assert.match(String(err?.message ?? ""), /stdout output write failed: boom/);
    assert.equal(err?.code, "EPIPE");
    assert.ok(err?.cause);
    assert.match(String(err.cause?.message ?? ""), /boom/);
    return true;
  });

  // Credits should be granted back to avoid deadlocks
  assert.ok(events.some((e) => e.stdout === 4096));
});

test("attach forwards stdout when only stdout is piped", async () => {
  const session = createExecSession(1, {
    stdinEnabled: true,
    stdout: { mode: "pipe" },
    stderr: { mode: "ignore" },
    windowBytes: 4096,
  });

  const proc = new ExecProcess(session, {
    sendStdin: () => {
      // unused
    },
    sendStdinEof: () => {
      // unused
    },
    cleanup: () => {
      // unused
    },
  });

  const stdin = new PassThrough() as any;
  stdin.isTTY = false;

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutChunks.push(Buffer.from(chunk));
      cb();
    },
  }) as any;
  stdout.isTTY = false;

  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrChunks.push(Buffer.from(chunk));
      cb();
    },
  }) as any;
  stderr.isTTY = false;

  proc.attach(stdin, stdout, stderr);

  applyOutputChunk(session, "stdout", Buffer.from("hello\n"));
  applyOutputChunk(session, "stderr", Buffer.from("ignored\n"));

  finishExecSession(session, 0);
  await proc;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(Buffer.concat(stdoutChunks).toString("utf8"), "hello\n");

  // stderr is ignore, should not be forwarded
  assert.equal(Buffer.concat(stderrChunks).length, 0);
});

test("attach forwards stderr when only stderr is piped", async () => {
  const session = createExecSession(1, {
    stdinEnabled: true,
    stdout: { mode: "ignore" },
    stderr: { mode: "pipe" },
    windowBytes: 4096,
  });

  const proc = new ExecProcess(session, {
    sendStdin: () => {
      // unused
    },
    sendStdinEof: () => {
      // unused
    },
    cleanup: () => {
      // unused
    },
  });

  const stdin = new PassThrough() as any;
  stdin.isTTY = false;

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutChunks.push(Buffer.from(chunk));
      cb();
    },
  }) as any;
  stdout.isTTY = false;

  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrChunks.push(Buffer.from(chunk));
      cb();
    },
  }) as any;
  stderr.isTTY = false;

  proc.attach(stdin, stdout, stderr);

  applyOutputChunk(session, "stdout", Buffer.from("ignored\n"));
  applyOutputChunk(session, "stderr", Buffer.from("oops\n"));

  finishExecSession(session, 0);
  await proc;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(Buffer.concat(stderrChunks).toString("utf8"), "oops\n");

  // stdout is ignore, should not be forwarded
  assert.equal(Buffer.concat(stdoutChunks).length, 0);
});
