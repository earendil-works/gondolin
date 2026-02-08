import assert from "node:assert/strict";
import test from "node:test";

import { applyOutputChunk, createExecSession, resolveOutputMode } from "../src/exec";

test("resolveOutputMode only treats objects with write() as writable", () => {
  const buf = Buffer.from("x");
  const resolved = resolveOutputMode(buf as any, undefined, "stdout");
  assert.equal(resolved.mode, "buffer");

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

test("applyOutputChunk rejects exec on writable write() throw and switches to ignore", async () => {
  const events: Array<{ stdout: number; stderr: number }> = [];

  const badWritable = {
    write(_data: any) {
      throw new Error("boom");
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

  await assert.rejects(session.resultPromise, /stdout output write failed: boom/);

  // Credits should be granted back to avoid deadlocks
  assert.ok(events.some((e) => e.stdout === 4096));
});
