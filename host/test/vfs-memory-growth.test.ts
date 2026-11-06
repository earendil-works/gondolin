import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider } from "../src/vfs/node/index.ts";

test("MemoryProvider grows files amortised (no full copy per extending write)", async () => {
  const provider = new MemoryProvider();
  const handle = await provider.open("/big", "w+");
  const chunk = Buffer.alloc(64 * 1024, 7);
  const total = 64 * 1024 * 1024;
  const rssBefore = process.memoryUsage().arrayBuffers;
  const started = performance.now();
  for (let offset = 0; offset < total; offset += chunk.length) {
    await handle.write(chunk, 0, chunk.length, offset);
  }
  const elapsed = performance.now() - started;
  const grown = process.memoryUsage().arrayBuffers - rssBefore;
  // quadratic copying took tens of seconds and gigabytes of garbage
  assert.ok(elapsed < 5000, `64 MiB of 64 KiB writes took ${elapsed}ms`);
  assert.ok(grown < 512 * 1024 * 1024, `array buffers grew by ${grown} bytes`);
  const stat = await provider.stat("/big");
  assert.equal(stat.size, total);
  await handle.close();
});

test("MemoryProvider growth keeps contents exact across truncate and sparse writes", async () => {
  const provider = new MemoryProvider();
  const handle = await provider.open("/f", "w+");
  await handle.write(Buffer.from("hello world"), 0, 11, 0);
  await handle.truncate(5);
  // the bytes beyond a truncate must come back as zeros, not stale data
  await handle.write(Buffer.from("!"), 0, 1, 8);
  const content = (await provider.readFile!("/f")) as Buffer;
  assert.deepEqual([...content], [...Buffer.from("hello\0\0\0!")]);
  await handle.truncate(12);
  const again = (await provider.readFile!("/f")) as Buffer;
  assert.equal(again.length, 12);
  assert.deepEqual([...again.subarray(9)], [0, 0, 0]);
  const appender = await provider.open("/f", "a");
  await appender.writeFile("XY");
  await appender.close();
  const appended = (await provider.readFile!("/f")) as Buffer;
  assert.equal(appended.toString("latin1").slice(-2), "XY");
  assert.equal(appended.length, 14);
  await handle.close();
});
