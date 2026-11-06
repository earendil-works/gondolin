/**
 * Large uploads through the HTTP bridge (both engines): curl's default
 * `Expect: 100-continue`, and a body-reading hook (`request.clone()`) must
 * not pin the guest's receive buffers.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import test from "node:test";

import { createHttpHooks } from "../src/http/hooks.ts";
import { VM } from "../src/vm/core.ts";
import { scheduleForceExit, shouldSkipVmTests } from "./helpers/vm-fixture.ts";

const skip = shouldSkipVmTests()
  ? "hardware virtualization unavailable"
  : false;
const PUBLIC_IP = "203.0.113.5";
const UPLOAD_BYTES = 32 * 1024 * 1024;

test.after(() => {
  scheduleForceExit();
});

/** Count request bytes; listen on 127.0.0.1 and ::1 so `localhost` works either way */
async function upstream(): Promise<{ port: number; close(): void }> {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
    });
    req.on("end", () => res.end(`got ${n}\n`));
  };
  const v4 = http.createServer(handler);
  await new Promise<void>((resolve) => v4.listen(0, "127.0.0.1", resolve));
  const port = (v4.address() as net.AddressInfo).port;
  const v6 = http.createServer(handler);
  await new Promise<void>((resolve) => {
    v6.once("error", () => resolve());
    v6.listen(port, "::1", () => resolve());
  });
  return {
    port,
    close() {
      v4.close();
      v6.close();
      v4.closeAllConnections();
      v6.closeAllConnections();
    },
  };
}

test("large uploads with Expect: 100-continue and a body-cloning hook stay bounded", {
  skip,
  timeout: 180_000,
}, async () => {
  const up = await upstream();
  let hookBytes = 0;
  const vm = await VM.create({
    sandbox: { console: "none" },
    maxHttpBodyBytes: 64 * 1024 * 1024,
    httpHooks: createHttpHooks({
      allowedHosts: ["localhost"],
      allowedInternalHosts: ["localhost"],
      onRequest: async (request) => {
        if (request.body) {
          hookBytes = (await request.clone().arrayBuffer()).byteLength;
        }
      },
    }).httpHooks,
  });
  try {
    const prep = await vm.exec([
      "/bin/sh",
      "-c",
      `dd if=/dev/zero of=/tmp/upload bs=1M count=${UPLOAD_BYTES >> 20} 2>/dev/null`,
    ]);
    assert.equal(prep.exitCode, 0, prep.stderr);

    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 10);
    let result: Awaited<ReturnType<VM["exec"]>>;
    try {
      // curl sends `Expect: 100-continue` for bodies this large
      result = await vm.exec([
        "/bin/sh",
        "-c",
        `curl -sS -H "Host: localhost:${up.port}" --data-binary @/tmp/upload http://${PUBLIC_IP}:${up.port}/`,
      ]);
    } finally {
      clearInterval(sampler);
    }
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), `got ${UPLOAD_BYTES}`);
    assert.equal(hookBytes, UPLOAD_BYTES);
    // the clone keeps one copy of the body; it used to pin gigabytes
    assert.ok(
      peak < 512 * 1024 * 1024,
      `array buffers peaked at ${peak} bytes`,
    );
  } finally {
    await vm.close();
    up.close();
  }
});
