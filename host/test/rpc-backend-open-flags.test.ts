import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { RpcFsBackend, FsRpcService, MemoryProvider } from "../src/vfs";

async function send(service: FsRpcService, op: string, req: Record<string, unknown>, id: number) {
  return service.handleRequest({
    v: 1,
    t: "fs_request",
    id,
    p: { op, req },
  });
}

test("rpc backend does not leak O_CREAT into open RPC for existing files", async () => {
  const service = new FsRpcService(new MemoryProvider());
  let id = 1;
  const openFlags: number[] = [];

  const create = await send(
    service,
    "create",
    {
      parent_ino: 1,
      name: "existing.txt",
      mode: 0o644,
      flags: 0,
    },
    id++
  );
  assert.equal(create.p.err, 0);

  const client = {
    request(op: string, req: Record<string, unknown>) {
      if (op === "open") {
        openFlags.push(req.flags as number);
      }
      return send(service, op, req, id++);
    },
    close() {},
  };

  const backend = new RpcFsBackend(client as any);

  const writeHandle = await backend.open("/existing.txt", "w");
  await writeHandle.close();

  const appendHandle = await backend.open("/existing.txt", "a");
  await appendHandle.close();

  assert.equal(openFlags.length, 2);
  assert.equal(openFlags[0] & fs.constants.O_CREAT, 0);
  assert.equal(openFlags[1] & fs.constants.O_CREAT, 0);

  await service.close();
});
