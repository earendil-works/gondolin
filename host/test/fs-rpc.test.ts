import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { FsRpcService, MemoryProvider, MAX_RPC_DATA } from "../src/vfs";

const { errno: ERRNO } = os.constants;

const LINUX_OPEN_FLAGS = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0x40,
  O_TRUNC: 0x200,
  O_APPEND: 0x400,
} as const;

function createService() {
  return new FsRpcService(new MemoryProvider());
}

function createTrackedService() {
  const base = new MemoryProvider();
  let closeCount = 0;

  const provider = new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "open") {
        return async (p: string, flags: string, mode?: number) => {
          const handle = await (target as any).open(p, flags, mode);
          return new Proxy(handle as any, {
            get(handleTarget, handleProp) {
              if (handleProp === "close") {
                return async () => {
                  closeCount++;
                  return handleTarget.close();
                };
              }
              const value = (handleTarget as any)[handleProp as any];
              if (typeof value === "function") return value.bind(handleTarget);
              return value;
            },
          });
        };
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });

  return {
    service: new FsRpcService(provider),
    getCloseCount: () => closeCount,
  };
}

async function send(service: FsRpcService, op: string, req: Record<string, unknown>, id = 1) {
  return service.handleRequest({
    v: 1,
    t: "fs_request",
    id,
    p: { op, req },
  });
}

test("fs rpc create/write/read", async () => {
  const service = createService();

  const create = await send(service, "create", {
    parent_ino: 1,
    name: "hello.txt",
    mode: 0o644,
    flags: 0,
  });
  assert.equal(create.p.err, 0);
  const fh = create.p.res?.fh as number;

  const write = await send(service, "write", {
    fh,
    offset: 0,
    data: Buffer.from("hello"),
  });
  assert.equal(write.p.err, 0);
  assert.equal(write.p.res?.size, 5);

  const read = await send(service, "read", {
    fh,
    offset: 0,
    size: 5,
  });
  assert.equal(read.p.err, 0);
  const data = Buffer.from(read.p.res?.data as Buffer);
  assert.equal(data.toString(), "hello");

  const lookup = await send(service, "lookup", {
    parent_ino: 1,
    name: "hello.txt",
  });
  assert.equal(lookup.p.err, 0);
  const ino = (lookup.p.res?.entry as { ino: number }).ino;

  const getattr = await send(service, "getattr", { ino });
  assert.equal(getattr.p.err, 0);

  await send(service, "release", { fh });
  await service.close();
});

test("fs rpc readdir offsets", async () => {
  const service = createService();

  await send(service, "create", {
    parent_ino: 1,
    name: "a.txt",
    mode: 0o644,
    flags: 0,
  });
  await send(service, "create", {
    parent_ino: 1,
    name: "b.txt",
    mode: 0o644,
    flags: 0,
  });

  const first = await send(service, "readdir", {
    ino: 1,
    offset: 0,
    max_entries: 1,
  });
  assert.equal(first.p.err, 0);
  const firstEntries = (first.p.res?.entries as Array<{ name: string; offset: number }>) ?? [];
  assert.equal(firstEntries.length, 1);
  const nextOffset = firstEntries[0].offset;

  const second = await send(service, "readdir", {
    ino: 1,
    offset: nextOffset,
    max_entries: 1,
  });
  assert.equal(second.p.err, 0);
  const secondEntries = (second.p.res?.entries as Array<{ name: string }>) ?? [];
  assert.equal(secondEntries.length, 1);
  assert.notEqual(secondEntries[0].name, firstEntries[0].name);

  await service.close();
});

test("fs rpc validates names and payload size", async () => {
  const service = createService();

  const invalidName = await send(service, "mkdir", {
    parent_ino: 1,
    name: "bad/name",
    mode: 0o755,
  });
  assert.equal(invalidName.p.err, ERRNO.EINVAL);

  const create = await send(service, "create", {
    parent_ino: 1,
    name: "big.txt",
    mode: 0o644,
    flags: 0,
  });
  const fh = create.p.res?.fh as number;

  const oversized = await send(service, "write", {
    fh,
    offset: 0,
    data: Buffer.alloc(MAX_RPC_DATA + 1),
  });
  assert.equal(oversized.p.err, ERRNO.EINVAL);

  const oversizedRead = await send(service, "read", {
    fh,
    offset: 0,
    size: MAX_RPC_DATA + 1,
  });
  assert.equal(oversizedRead.p.err, ERRNO.EINVAL);

  await send(service, "release", { fh });
  await service.close();
});

test("fs rpc unlink removes mappings and lookup returns negative ttl", async () => {
  const service = createService();

  await send(service, "create", {
    parent_ino: 1,
    name: "hello.txt",
    mode: 0o644,
    flags: 0,
  });

  const lookup1 = await send(service, "lookup", { parent_ino: 1, name: "hello.txt" });
  assert.equal(lookup1.p.err, 0);
  const ino = (lookup1.p.res?.entry as { ino: number }).ino;

  const unlink = await send(service, "unlink", { parent_ino: 1, name: "hello.txt" });
  assert.equal(unlink.p.err, 0);

  const lookup2 = await send(service, "lookup", { parent_ino: 1, name: "hello.txt" });
  assert.equal(lookup2.p.err, ERRNO.ENOENT);
  assert.equal((lookup2.p.res as any)?.entry_ttl_ms, 250);

  const getattr = await send(service, "getattr", { ino });
  assert.equal(getattr.p.err, ERRNO.ENOENT);

  await service.close();
});

test("fs rpc rename across dirs preserves ino and updates mapping", async () => {
  const service = createService();

  const dirA = await send(service, "mkdir", { parent_ino: 1, name: "a", mode: 0o755 });
  assert.equal(dirA.p.err, 0);
  const inoA = (dirA.p.res?.entry as any).ino as number;

  const dirB = await send(service, "mkdir", { parent_ino: 1, name: "b", mode: 0o755 });
  assert.equal(dirB.p.err, 0);
  const inoB = (dirB.p.res?.entry as any).ino as number;

  await send(service, "create", { parent_ino: inoA, name: "file.txt", mode: 0o644, flags: 0 });

  const lookupOld = await send(service, "lookup", { parent_ino: inoA, name: "file.txt" });
  assert.equal(lookupOld.p.err, 0);
  const inoFile = (lookupOld.p.res?.entry as any).ino as number;

  const rename = await send(service, "rename", {
    old_parent_ino: inoA,
    old_name: "file.txt",
    new_parent_ino: inoB,
    new_name: "renamed.txt",
    flags: 0,
  });
  assert.equal(rename.p.err, 0);

  const lookupNew = await send(service, "lookup", { parent_ino: inoB, name: "renamed.txt" });
  assert.equal(lookupNew.p.err, 0);
  assert.equal((lookupNew.p.res?.entry as any).ino, inoFile);

  const lookupGone = await send(service, "lookup", { parent_ino: inoA, name: "file.txt" });
  assert.equal(lookupGone.p.err, ERRNO.ENOENT);

  // old inode should still point at the new path after renameMapping.
  const trunc = await send(service, "truncate", { ino: inoFile, size: 0 });
  assert.equal(trunc.p.err, 0);

  await service.close();
});

test("fs rpc open flags: O_CREAT rejected; O_TRUNC truncates; O_APPEND appends", async () => {
  const service = createService();

  const created = await send(service, "create", {
    parent_ino: 1,
    name: "f.txt",
    mode: 0o644,
    flags: 0,
  });
  const fh = created.p.res?.fh as number;
  await send(service, "write", { fh, offset: 0, data: Buffer.from("hello") });
  await send(service, "release", { fh });

  const lookup = await send(service, "lookup", { parent_ino: 1, name: "f.txt" });
  const ino = (lookup.p.res?.entry as any).ino as number;

  const openCreat = await send(service, "open", { ino, flags: LINUX_OPEN_FLAGS.O_CREAT | LINUX_OPEN_FLAGS.O_WRONLY });
  assert.equal(openCreat.p.err, ERRNO.EINVAL);

  const openTrunc = await send(service, "open", { ino, flags: LINUX_OPEN_FLAGS.O_WRONLY | LINUX_OPEN_FLAGS.O_TRUNC });
  assert.equal(openTrunc.p.err, 0);
  const fhTrunc = openTrunc.p.res?.fh as number;

  const readEmpty = await send(service, "read", { fh: fhTrunc, offset: 0, size: 10 });
  assert.equal(readEmpty.p.err, 0);
  assert.equal(Buffer.from(readEmpty.p.res?.data as Buffer).length, 0);

  await send(service, "write", { fh: fhTrunc, offset: 0, data: Buffer.from("a") });
  await send(service, "release", { fh: fhTrunc });

  const openAppend = await send(service, "open", { ino, flags: LINUX_OPEN_FLAGS.O_WRONLY | LINUX_OPEN_FLAGS.O_APPEND });
  assert.equal(openAppend.p.err, 0);
  const fhAppend = openAppend.p.res?.fh as number;
  await send(service, "write", { fh: fhAppend, offset: 0, data: Buffer.from("b") });
  await send(service, "release", { fh: fhAppend });

  const openRead = await send(service, "open", { ino, flags: LINUX_OPEN_FLAGS.O_RDONLY });
  assert.equal(openRead.p.err, 0);
  const fhRead = openRead.p.res?.fh as number;
  const read = await send(service, "read", { fh: fhRead, offset: 0, size: 10 });
  assert.equal(read.p.err, 0);
  assert.equal(Buffer.from(read.p.res?.data as Buffer).toString("utf8"), "ab");
  await send(service, "release", { fh: fhRead });

  await service.close();
});

test("fs rpc metrics track ops, bytes and errors", async () => {
  const service = createService();

  const created = await send(service, "create", { parent_ino: 1, name: "m.txt", mode: 0o644, flags: 0 });
  const fh = created.p.res?.fh as number;

  await send(service, "write", { fh, offset: 0, data: Buffer.from("abc") });
  await send(service, "read", { fh, offset: 0, size: 2 });

  // trigger an error
  await send(service, "read", { fh: 9999, offset: 0, size: 1 });

  assert.equal(service.metrics.bytesWritten, 3);
  assert.equal(service.metrics.bytesRead, 2);
  assert.equal(service.metrics.ops.create, 1);
  assert.equal(service.metrics.ops.write, 1);
  assert.equal(service.metrics.ops.read, 2);
  assert.equal(service.metrics.errors, 1);
  assert.equal(service.metrics.requests, 1 + 1 + 2); // create + write + reads

  await send(service, "release", { fh });
  await service.close();
});

test("fs rpc normalizeError includes message and maps unknown errors to EIO", async () => {
  const base = new MemoryProvider();
  const provider = new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "stat") {
        return async (_p: string) => {
          throw { errno: ERRNO.EPERM, message: "nope" };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const service = new FsRpcService(provider);

  const res = await send(service, "getattr", { ino: 1 });
  assert.equal(res.p.err, ERRNO.EPERM);
  assert.equal(res.p.message, "nope");

  const provider2 = new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "stat") {
        return async (_p: string) => {
          throw "boom";
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const service2 = new FsRpcService(provider2);
  const res2 = await send(service2, "getattr", { ino: 1 });
  assert.equal(res2.p.err, ERRNO.EIO);
  assert.equal(res2.p.message, "unknown error");

  await service.close();
  await service2.close();
});

test("fs rpc statfs returns valid stats for root inode", async () => {
  const service = createService();

  const res = await send(service, "statfs", { ino: 1 });
  assert.equal(res.p.err, 0);

  const statfs = res.p.res?.statfs as Record<string, number>;
  assert.ok(statfs);
  assert.ok(statfs.blocks > 0);
  assert.ok(statfs.bfree <= statfs.blocks);
  assert.ok(statfs.bavail <= statfs.bfree);
  assert.ok(statfs.ffree <= statfs.files);
  assert.equal(statfs.bsize, 4096);
  assert.equal(statfs.frsize, 4096);
  assert.equal(statfs.namelen, 255);

  await service.close();
});

test("fs rpc statfs returns ENOENT for unknown inode", async () => {
  const service = createService();

  const res = await send(service, "statfs", { ino: 9999 });
  assert.equal(res.p.err, ERRNO.ENOENT);

  await service.close();
});

test("fs rpc statfs increments metrics", async () => {
  const service = createService();

  await send(service, "statfs", { ino: 1 });
  assert.equal(service.metrics.ops.statfs, 1);

  await service.close();
});

test("fs rpc service.close closes all open handles", async () => {
  const { service, getCloseCount } = createTrackedService();

  const created = await send(service, "create", { parent_ino: 1, name: "x.txt", mode: 0o644, flags: 0 });
  assert.equal(created.p.err, 0);
  const fh = created.p.res?.fh as number;

  await service.close();
  assert.equal(getCloseCount(), 1);

  const after = await send(service, "release", { fh });
  assert.equal(after.p.err, ERRNO.EBADF);
});
