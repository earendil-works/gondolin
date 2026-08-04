import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  encodeOutputFrame,
  type ClientMessage,
  type ServerMessage,
} from "../src/sandbox/control-protocol.ts";

const hostDir = path.join(import.meta.dirname, "..");

function runCli(args: string[]): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/gondolin.ts", ...args], {
      cwd: hostDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function encodeServerFrame(type: 0 | 1, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function sendJson(socket: net.Socket, message: ServerMessage): void {
  socket.write(
    encodeServerFrame(0, Buffer.from(JSON.stringify(message), "utf8")),
  );
}

function sendOutput(
  socket: net.Socket,
  id: number,
  stream: "stdout" | "stderr",
  data: Buffer,
): void {
  socket.write(encodeServerFrame(1, encodeOutputFrame(id, stream, data)));
}

function readClientMessages(
  socket: net.Socket,
  onMessage: (message: ClientMessage) => void,
): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      onMessage(JSON.parse(payload.toString("utf8")) as ClientMessage);
    }
  });
}

test("cli exec help describes a session IPC socket", async () => {
  const result = await runCli(["exec", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /session IPC socket/i);
  assert.doesNotMatch(result.stdout, /via the virtio socket/i);
});

test("cli exec --sock does not report connected when connect fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-exec-"));
  const socketPath = path.join(dir, "missing.sock");
  try {
    const result = await runCli(["exec", "--sock", socketPath, "--", "true"]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /connected to/);
    assert.match(result.stderr, /socket error: connect ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli exec --sock fails when the session closes during an exec", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-exec-"));
  const socketPath = path.join(dir, "session.sock");
  const server = net.createServer((socket) => {
    readClientMessages(socket, (message) => {
      if (message.type === "exec") socket.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await runCli(["exec", "--sock", socketPath, "--", "true"]);
    assert.equal(result.status, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli exec --sock replenishes credits for large stdout and stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-exec-"));
  const socketPath = path.join(dir, "session.sock");
  const stdoutOutput = Buffer.alloc(1280 * 1024, "x");
  const stderrOutput = Buffer.alloc(1280 * 1024, "y");
  const server = net.createServer((socket) => {
    let stdoutOffset = 0;
    let stderrOffset = 0;
    let stdoutCredit = 0;
    let stderrCredit = 0;
    let requestId = 0;
    let responded = false;
    let pumping = false;
    let pumpRequested = false;
    const expectedWindows: Array<{
      id: number;
      stream: "stdout" | "stderr";
      length: number;
    }> = [];

    const sendTrackedOutput = (
      id: number,
      stream: "stdout" | "stderr",
      data: Buffer,
    ) => {
      expectedWindows.push({ id, stream, length: data.length });
      sendOutput(socket, id, stream, data);
    };

    const pump = () => {
      if (pumping) {
        pumpRequested = true;
        return;
      }

      pumping = true;
      do {
        pumpRequested = false;
        while (stdoutCredit > 0 && stdoutOffset < stdoutOutput.length) {
          const length = Math.min(
            8192,
            stdoutCredit,
            stdoutOutput.length - stdoutOffset,
          );
          const output = stdoutOutput.subarray(
            stdoutOffset,
            stdoutOffset + length,
          );
          stdoutOffset += length;
          stdoutCredit -= length;
          sendTrackedOutput(requestId, "stdout", output);
        }
        while (stderrCredit > 0 && stderrOffset < stderrOutput.length) {
          const length = Math.min(
            8192,
            stderrCredit,
            stderrOutput.length - stderrOffset,
          );
          const output = stderrOutput.subarray(
            stderrOffset,
            stderrOffset + length,
          );
          stderrOffset += length;
          stderrCredit -= length;
          sendTrackedOutput(requestId, "stderr", output);
        }
        if (
          !responded &&
          stdoutOffset === stdoutOutput.length &&
          stderrOffset === stderrOutput.length &&
          expectedWindows.length === 0
        ) {
          assert.equal(expectedWindows.length, 0);
          responded = true;
          sendJson(socket, {
            type: "exec_response",
            id: requestId,
            exit_code: 0,
          });
        }
      } while (pumpRequested);
      pumping = false;
    };

    readClientMessages(socket, (message) => {
      if (message.type === "exec") {
        requestId = message.id;
        assert.equal(message.stdout_window, 1024 * 1024);
        assert.equal(message.stderr_window, 1024 * 1024);
        stdoutCredit = message.stdout_window ?? 256 * 1024;
        stderrCredit = message.stderr_window ?? 256 * 1024;
        pump();
      } else if (message.type === "exec_window") {
        const expected = expectedWindows.shift();
        assert.ok(expected, "received unexpected exec_window");
        assert.equal(message.id, requestId);
        if (expected.stream === "stdout") {
          assert.deepEqual(message, {
            type: "exec_window",
            id: expected.id,
            stdout: expected.length,
          });
        } else {
          assert.deepEqual(message, {
            type: "exec_window",
            id: expected.id,
            stderr: expected.length,
          });
        }
        stdoutCredit += message.stdout ?? 0;
        stderrCredit += message.stderr ?? 0;
        pump();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await runCli([
      "exec",
      "--sock",
      socketPath,
      "--",
      "large-output",
    ]);
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      `connected to ${socketPath}\n${stdoutOutput.toString()}`,
    );
    assert.equal(result.stderr, stderrOutput.toString());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli exec --sock ignores buffered output after its response", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-exec-"));
  const socketPath = path.join(dir, "session.sock");
  const server = net.createServer((socket) => {
    readClientMessages(socket, (message) => {
      if (message.type !== "exec") return;
      socket.write(
        Buffer.concat([
          encodeServerFrame(
            0,
            Buffer.from(
              JSON.stringify({
                type: "exec_response",
                id: message.id,
                exit_code: 0,
              } satisfies ServerMessage),
              "utf8",
            ),
          ),
          encodeServerFrame(
            1,
            encodeOutputFrame(message.id, "stdout", Buffer.from("late")),
          ),
        ]),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await runCli(["exec", "--sock", socketPath, "--", "true"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `connected to ${socketPath}\n`);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli exec --sock ignores stale errors from a previous command", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-exec-"));
  const socketPath = path.join(dir, "session.sock");
  const server = net.createServer((socket) => {
    readClientMessages(socket, (message) => {
      if (message.type !== "exec") return;
      if (message.id === 1) {
        sendJson(socket, { type: "exec_response", id: 1, exit_code: 0 });
        return;
      }

      sendJson(socket, {
        type: "error",
        id: 1,
        code: "stale_error",
        message: "from previous command",
      });
      sendJson(socket, {
        type: "exec_response",
        id: message.id,
        exit_code: 0,
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await runCli([
      "exec",
      "--sock",
      socketPath,
      "--cmd",
      "first",
      "--cmd",
      "second",
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli exec --sock ignores stale frames from a previous command", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-exec-"));
  const socketPath = path.join(dir, "session.sock");
  const server = net.createServer((socket) => {
    readClientMessages(socket, (message) => {
      if (message.type !== "exec") return;
      if (message.id === 1) {
        sendJson(socket, { type: "exec_response", id: 1, exit_code: 0 });
        return;
      }

      socket.write(
        Buffer.concat([
          encodeServerFrame(
            1,
            encodeOutputFrame(1, "stdout", Buffer.from("stale")),
          ),
          encodeServerFrame(
            0,
            Buffer.from(
              JSON.stringify({
                type: "exec_response",
                id: 1,
                exit_code: 1,
              } satisfies ServerMessage),
              "utf8",
            ),
          ),
          encodeServerFrame(
            1,
            encodeOutputFrame(message.id, "stdout", Buffer.from("current")),
          ),
          encodeServerFrame(
            0,
            Buffer.from(
              JSON.stringify({
                type: "exec_response",
                id: message.id,
                exit_code: 0,
              } satisfies ServerMessage),
              "utf8",
            ),
          ),
        ]),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await runCli([
      "exec",
      "--sock",
      socketPath,
      "--cmd",
      "first",
      "--cmd",
      "second",
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `connected to ${socketPath}\ncurrent`);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli exec --sock runs commands sequentially and preserves the first failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-exec-"));
  const socketPath = path.join(dir, "session.sock");
  const received: Array<{ id: number; cmd: string }> = [];
  let active = 0;
  const server = net.createServer((socket) => {
    readClientMessages(socket, (message) => {
      if (message.type !== "exec") return;
      active += 1;
      assert.equal(active, 1);
      received.push({ id: message.id, cmd: message.cmd });
      queueMicrotask(() => {
        sendJson(socket, {
          type: "exec_response",
          id: message.id,
          exit_code: message.cmd === "first" ? 7 : 3,
        });
        active -= 1;
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await runCli([
      "exec",
      "--sock",
      socketPath,
      "--cmd",
      "first",
      "--cmd",
      "second",
    ]);
    assert.deepEqual(
      received.map(({ cmd }) => cmd),
      ["first", "second"],
    );
    assert.equal(result.status, 7);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
