import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider } from "../src/vfs/node/index.ts";
import { FsRpcService } from "../src/vfs/rpc-service.ts";

async function send(
  service: FsRpcService,
  op: string,
  req: Record<string, unknown>,
  id = 1,
) {
  return service.handleRequest({
    v: 1,
    t: "fs_request",
    id,
    p: { op, req },
  });
}

test("readdir pagination keeps its snapshot when the directory changes mid-stream", async () => {
  const service = new FsRpcService(new MemoryProvider());
  const names = ["a.txt", "b.txt", "c.txt", "d.txt"];

  for (const name of names) {
    const created = await send(service, "create", {
      parent_ino: 1,
      name,
      mode: 0o644,
      flags: 0,
    });
    assert.equal(created.p.err, 0);
  }

  const first = await send(service, "readdir", {
    ino: 1,
    offset: 0,
    max_entries: 2,
  });
  assert.equal(first.p.err, 0);
  const firstEntries =
    (first.p.res?.entries as Array<{ name: string }>) ?? [];
  assert.equal(firstEntries.length, 2);
  const nextOffset = first.p.res?.next_offset as number;
  assert.ok(nextOffset > 0, "pagination should continue");

  // A mutation between two batches invalidates the directory cache. The
  // in-flight pagination stream must still resume from the snapshot it started
  // with, otherwise entries are skipped or repeated.
  const unlink = await send(service, "unlink", {
    parent_ino: 1,
    name: "a.txt",
  });
  assert.equal(unlink.p.err, 0);

  const second = await send(service, "readdir", {
    ino: 1,
    offset: nextOffset,
    max_entries: 2,
  });
  assert.equal(second.p.err, 0);
  const secondEntries =
    (second.p.res?.entries as Array<{ name: string }>) ?? [];

  const seen = [...firstEntries, ...secondEntries].map((entry) => entry.name);
  assert.equal(
    new Set(seen).size,
    seen.length,
    "pagination must not repeat entries",
  );
  assert.equal(
    seen.length,
    names.length,
    "pagination must not skip entries after a mid-stream mutation",
  );

  await service.close();
});
