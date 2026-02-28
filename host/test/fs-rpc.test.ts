import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryProvider, RealFSProvider } from "../src/vfs/node/index.ts";
import { ReadonlyProvider } from "../src/vfs/readonly.ts";
import { FsRpcService, MAX_RPC_DATA } from "../src/vfs/rpc-service.ts";

const { errno: ERRNO } = os.constants;

const LINUX_OPEN_FLAGS = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0x40,
  O_TRUNC: 0x200,
  O_APPEND: 0x400,
} as const;

const DT_DIR = 4;
const DT_REG = 8;
const DT_LNK = 10;

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
  const firstEntries =
    (first.p.res?.entries as Array<{ name: string; offset: number }>) ?? [];
  assert.equal(firstEntries.length, 1);
  const nextOffset = firstEntries[0].offset;

  const second = await send(service, "readdir", {
    ino: 1,
    offset: nextOffset,
    max_entries: 1,
  });
  assert.equal(second.p.err, 0);
  const secondEntries =
    (second.p.res?.entries as Array<{ name: string }>) ?? [];
  assert.equal(secondEntries.length, 1);
  assert.notEqual(secondEntries[0].name, firstEntries[0].name);

  await service.close();
});

test("fs rpc readdir caches paginated listings and invalidates on mutations", async () => {
  const base = new MemoryProvider();
  let readdirCalls = 0;
  const provider = new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "readdir") {
        return async (entryPath: string, options?: object) => {
          readdirCalls += 1;
          return (target as any).readdir(entryPath, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
  const service = new FsRpcService(provider);

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
  const firstEntries =
    (first.p.res?.entries as Array<{ offset: number }> | undefined) ?? [];
  assert.equal(firstEntries.length, 1);

  const second = await send(service, "readdir", {
    ino: 1,
    offset: firstEntries[0].offset,
    max_entries: 1,
  });
  assert.equal(second.p.err, 0);
  assert.equal(readdirCalls, 1);

  await send(service, "create", {
    parent_ino: 1,
    name: "c.txt",
    mode: 0o644,
    flags: 0,
  });

  const afterMutation = await send(service, "readdir", {
    ino: 1,
    offset: 0,
    max_entries: 128,
  });
  assert.equal(afterMutation.p.err, 0);
  assert.equal(readdirCalls, 2);

  await service.close();
});

test("fs rpc readdir invalidates only affected directories", async () => {
  const base = new MemoryProvider();
  const readdirCalls = new Map<string, number>();
  const provider = new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "readdir") {
        return async (entryPath: string, options?: object) => {
          readdirCalls.set(entryPath, (readdirCalls.get(entryPath) ?? 0) + 1);
          return (target as any).readdir(entryPath, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
  const service = new FsRpcService(provider);

  await send(service, "mkdir", {
    parent_ino: 1,
    name: "left",
    mode: 0o755,
  });
  await send(service, "mkdir", {
    parent_ino: 1,
    name: "right",
    mode: 0o755,
  });

  const leftLookup = await send(service, "lookup", {
    parent_ino: 1,
    name: "left",
  });
  const rightLookup = await send(service, "lookup", {
    parent_ino: 1,
    name: "right",
  });
  assert.equal(leftLookup.p.err, 0);
  assert.equal(rightLookup.p.err, 0);
  const leftIno = (leftLookup.p.res?.entry as { ino: number }).ino;
  const rightIno = (rightLookup.p.res?.entry as { ino: number }).ino;

  await send(service, "create", {
    parent_ino: leftIno,
    name: "a.txt",
    mode: 0o644,
    flags: 0,
  });
  await send(service, "create", {
    parent_ino: rightIno,
    name: "b.txt",
    mode: 0o644,
    flags: 0,
  });

  const leftRead = await send(service, "readdir", {
    ino: leftIno,
    offset: 0,
    max_entries: 128,
  });
  const rightRead = await send(service, "readdir", {
    ino: rightIno,
    offset: 0,
    max_entries: 128,
  });
  assert.equal(leftRead.p.err, 0);
  assert.equal(rightRead.p.err, 0);
  assert.equal(readdirCalls.get("/left") ?? 0, 1);
  assert.equal(readdirCalls.get("/right") ?? 0, 1);

  await send(service, "create", {
    parent_ino: leftIno,
    name: "c.txt",
    mode: 0o644,
    flags: 0,
  });

  const rightAfterLeftMutation = await send(service, "readdir", {
    ino: rightIno,
    offset: 0,
    max_entries: 128,
  });
  const leftAfterLeftMutation = await send(service, "readdir", {
    ino: leftIno,
    offset: 0,
    max_entries: 128,
  });
  assert.equal(rightAfterLeftMutation.p.err, 0);
  assert.equal(leftAfterLeftMutation.p.err, 0);
  assert.equal(readdirCalls.get("/right") ?? 0, 1);
  assert.equal(readdirCalls.get("/left") ?? 0, 2);

  await service.close();
});

test("fs rpc readdir deduplicates concurrent cache misses", async () => {
  const base = new MemoryProvider();
  let readdirCalls = 0;
  const provider = new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "readdir") {
        return async (entryPath: string, options?: object) => {
          readdirCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 25));
          return (target as any).readdir(entryPath, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
  const service = new FsRpcService(provider);

  await send(service, "create", {
    parent_ino: 1,
    name: "a.txt",
    mode: 0o644,
    flags: 0,
  });

  const [first, second] = await Promise.all([
    send(
      service,
      "readdir",
      {
        ino: 1,
        offset: 0,
        max_entries: 128,
      },
      101,
    ),
    send(
      service,
      "readdir",
      {
        ino: 1,
        offset: 0,
        max_entries: 128,
      },
      102,
    ),
  ]);
  assert.equal(first.p.err, 0);
  assert.equal(second.p.err, 0);
  assert.equal(readdirCalls, 1);

  const afterWarm = await send(service, "readdir", {
    ino: 1,
    offset: 0,
    max_entries: 128,
  });
  assert.equal(afterWarm.p.err, 0);
  assert.equal(readdirCalls, 1);

  await service.close();
});

test("fs rpc readdir cache uses sliding ttl on hits", async () => {
  const base = new MemoryProvider();
  let readdirCalls = 0;
  const provider = new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "readdir") {
        return async (entryPath: string, options?: object) => {
          readdirCalls += 1;
          return (target as any).readdir(entryPath, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
  const service = new FsRpcService(provider);

  await send(service, "create", {
    parent_ino: 1,
    name: "a.txt",
    mode: 0o644,
    flags: 0,
  });

  const originalDateNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    const first = await send(service, "readdir", {
      ino: 1,
      offset: 0,
      max_entries: 128,
    });
    assert.equal(first.p.err, 0);
    assert.equal(readdirCalls, 1);

    const firstExpiry = (
      (service as any).readdirCache.get("/") as { expiresAt: number }
    ).expiresAt;

    now = firstExpiry - 1;
    const second = await send(service, "readdir", {
      ino: 1,
      offset: 0,
      max_entries: 128,
    });
    assert.equal(second.p.err, 0);
    assert.equal(readdirCalls, 1);

    const refreshedExpiry = (
      (service as any).readdirCache.get("/") as { expiresAt: number }
    ).expiresAt;
    assert.ok(refreshedExpiry > firstExpiry);

    now = firstExpiry + 1;
    const third = await send(service, "readdir", {
      ino: 1,
      offset: 0,
      max_entries: 128,
    });
    assert.equal(third.p.err, 0);
    assert.equal(readdirCalls, 1);
  } finally {
    Date.now = originalDateNow;
    await service.close();
  }
});

test("fs rpc readdir reports Linux dirent types", async () => {
  const service = createService();

  await send(service, "mkdir", {
    parent_ino: 1,
    name: "pkg",
    mode: 0o755,
  });
  await send(service, "create", {
    parent_ino: 1,
    name: "module.py",
    mode: 0o644,
    flags: 0,
  });

  const readdir = await send(service, "readdir", {
    ino: 1,
    offset: 0,
    max_entries: 128,
  });
  assert.equal(readdir.p.err, 0);

  const entries =
    (readdir.p.res?.entries as Array<{ name: string; type: number }>) ?? [];
  const byName = new Map(entries.map((entry) => [entry.name, entry.type]));

  assert.equal(byName.get("pkg"), DT_DIR);
  assert.equal(byName.get("module.py"), DT_REG);

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

  const lookup1 = await send(service, "lookup", {
    parent_ino: 1,
    name: "hello.txt",
  });
  assert.equal(lookup1.p.err, 0);
  const ino = (lookup1.p.res?.entry as { ino: number }).ino;

  const unlink = await send(service, "unlink", {
    parent_ino: 1,
    name: "hello.txt",
  });
  assert.equal(unlink.p.err, 0);

  const lookup2 = await send(service, "lookup", {
    parent_ino: 1,
    name: "hello.txt",
  });
  assert.equal(lookup2.p.err, ERRNO.ENOENT);
  assert.equal((lookup2.p.res as any)?.entry_ttl_ms, 250);

  const getattr = await send(service, "getattr", { ino });
  assert.equal(getattr.p.err, ERRNO.ENOENT);

  await service.close();
});

test("fs rpc rmdir removes mappings and rejects non-empty dirs", async () => {
  const service = createService();

  const dir = await send(service, "mkdir", {
    parent_ino: 1,
    name: "dir",
    mode: 0o755,
  });
  assert.equal(dir.p.err, 0);
  const dirIno = (dir.p.res?.entry as { ino: number }).ino;

  const child = await send(service, "mkdir", {
    parent_ino: dirIno,
    name: "child",
    mode: 0o755,
  });
  assert.equal(child.p.err, 0);
  const childIno = (child.p.res?.entry as { ino: number }).ino;

  const nonEmpty = await send(service, "rmdir", {
    parent_ino: 1,
    name: "dir",
  });
  assert.notEqual(nonEmpty.p.err, 0);

  const removedChild = await send(service, "rmdir", {
    parent_ino: dirIno,
    name: "child",
  });
  assert.equal(removedChild.p.err, 0);

  const childLookup = await send(service, "lookup", {
    parent_ino: dirIno,
    name: "child",
  });
  assert.equal(childLookup.p.err, ERRNO.ENOENT);
  assert.equal((childLookup.p.res as any)?.entry_ttl_ms, 250);

  const childGetattr = await send(service, "getattr", { ino: childIno });
  assert.equal(childGetattr.p.err, ERRNO.ENOENT);

  const removedDir = await send(service, "rmdir", {
    parent_ino: 1,
    name: "dir",
  });
  assert.equal(removedDir.p.err, 0);

  const dirLookup = await send(service, "lookup", {
    parent_ino: 1,
    name: "dir",
  });
  assert.equal(dirLookup.p.err, ERRNO.ENOENT);

  const dirGetattr = await send(service, "getattr", { ino: dirIno });
  assert.equal(dirGetattr.p.err, ERRNO.ENOENT);

  await service.close();
});

test("fs rpc rename across dirs preserves ino and updates mapping", async () => {
  const service = createService();

  const dirA = await send(service, "mkdir", {
    parent_ino: 1,
    name: "a",
    mode: 0o755,
  });
  assert.equal(dirA.p.err, 0);
  const inoA = (dirA.p.res?.entry as any).ino as number;

  const dirB = await send(service, "mkdir", {
    parent_ino: 1,
    name: "b",
    mode: 0o755,
  });
  assert.equal(dirB.p.err, 0);
  const inoB = (dirB.p.res?.entry as any).ino as number;

  await send(service, "create", {
    parent_ino: inoA,
    name: "file.txt",
    mode: 0o644,
    flags: 0,
  });

  const lookupOld = await send(service, "lookup", {
    parent_ino: inoA,
    name: "file.txt",
  });
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

  const lookupNew = await send(service, "lookup", {
    parent_ino: inoB,
    name: "renamed.txt",
  });
  assert.equal(lookupNew.p.err, 0);
  assert.equal((lookupNew.p.res?.entry as any).ino, inoFile);

  const lookupGone = await send(service, "lookup", {
    parent_ino: inoA,
    name: "file.txt",
  });
  assert.equal(lookupGone.p.err, ERRNO.ENOENT);

  // old inode should still point at the new path after renameMapping.
  const trunc = await send(service, "truncate", { ino: inoFile, size: 0 });
  assert.equal(trunc.p.err, 0);

  await service.close();
});

test("fs rpc rename over existing target clears replaced inode mapping", async () => {
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

  const lookupA = await send(service, "lookup", {
    parent_ino: 1,
    name: "a.txt",
  });
  const inoA = (lookupA.p.res?.entry as any).ino as number;
  const lookupB = await send(service, "lookup", {
    parent_ino: 1,
    name: "b.txt",
  });
  const inoB = (lookupB.p.res?.entry as any).ino as number;

  const renamed = await send(service, "rename", {
    old_parent_ino: 1,
    old_name: "a.txt",
    new_parent_ino: 1,
    new_name: "b.txt",
    flags: 0,
  });
  assert.equal(renamed.p.err, 0);

  const lookupRenamed = await send(service, "lookup", {
    parent_ino: 1,
    name: "b.txt",
  });
  assert.equal(lookupRenamed.p.err, 0);
  assert.equal((lookupRenamed.p.res?.entry as any).ino, inoA);

  const replacedGetattr = await send(service, "getattr", { ino: inoB });
  assert.equal(replacedGetattr.p.err, ERRNO.ENOENT);

  await service.close();
});

test("fs rpc link creates hard links with MemoryProvider", async () => {
  const service = createService();

  const created = await send(service, "create", {
    parent_ino: 1,
    name: "origin.txt",
    mode: 0o644,
    flags: 0,
  });
  assert.equal(created.p.err, 0);
  const fh = created.p.res?.fh as number;

  const write = await send(service, "write", {
    fh,
    offset: 0,
    data: Buffer.from("hello"),
  });
  assert.equal(write.p.err, 0);
  await send(service, "release", { fh });

  const lookup = await send(service, "lookup", {
    parent_ino: 1,
    name: "origin.txt",
  });
  assert.equal(lookup.p.err, 0);
  const oldIno = (lookup.p.res?.entry as any).ino as number;

  const linked = await send(service, "link", {
    old_ino: oldIno,
    new_parent_ino: 1,
    new_name: "linked.txt",
  });
  assert.equal(linked.p.err, 0);

  const linkedLookup = await send(service, "lookup", {
    parent_ino: 1,
    name: "linked.txt",
  });
  assert.equal(linkedLookup.p.err, 0);
  const linkedIno = (linkedLookup.p.res?.entry as any).ino as number;
  assert.equal(linkedIno, oldIno);

  const linkedOpen = await send(service, "open", {
    ino: linkedIno,
    flags: LINUX_OPEN_FLAGS.O_RDONLY,
  });
  assert.equal(linkedOpen.p.err, 0);
  const linkedFh = linkedOpen.p.res?.fh as number;
  const linkedRead = await send(service, "read", {
    fh: linkedFh,
    offset: 0,
    size: 5,
  });
  assert.equal(linkedRead.p.err, 0);
  assert.equal(
    Buffer.from(linkedRead.p.res?.data as Buffer).toString("utf8"),
    "hello",
  );
  await send(service, "release", { fh: linkedFh });

  const unlinkOrigin = await send(service, "unlink", {
    parent_ino: 1,
    name: "origin.txt",
  });
  assert.equal(unlinkOrigin.p.err, 0);

  const stillLinked = await send(service, "lookup", {
    parent_ino: 1,
    name: "linked.txt",
  });
  assert.equal(stillLinked.p.err, 0);

  await service.close();
});

test("fs rpc link returns ENOSYS when provider lacks hard-link support", async () => {
  const base = new MemoryProvider();
  const provider = new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "link") {
        return undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const service = new FsRpcService(provider);

  const created = await send(service, "create", {
    parent_ino: 1,
    name: "origin.txt",
    mode: 0o644,
    flags: 0,
  });
  const fh = created.p.res?.fh as number;
  await send(service, "write", { fh, offset: 0, data: Buffer.from("hello") });
  await send(service, "release", { fh });

  const lookup = await send(service, "lookup", {
    parent_ino: 1,
    name: "origin.txt",
  });
  const oldIno = (lookup.p.res?.entry as any).ino as number;

  const linked = await send(service, "link", {
    old_ino: oldIno,
    new_parent_ino: 1,
    new_name: "linked.txt",
  });
  assert.equal(linked.p.err, ERRNO.ENOSYS);

  await service.close();
});

test("fs rpc link creates hard links with RealFSProvider", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "gondolin-fs-rpc-link-"),
  );
  const service = new FsRpcService(new RealFSProvider(tempDir));

  try {
    const created = await send(service, "create", {
      parent_ino: 1,
      name: "origin.txt",
      mode: 0o644,
      flags: 0,
    });
    assert.equal(created.p.err, 0);
    const fh = created.p.res?.fh as number;

    const write = await send(service, "write", {
      fh,
      offset: 0,
      data: Buffer.from("hello"),
    });
    assert.equal(write.p.err, 0);
    await send(service, "release", { fh });

    const lookup = await send(service, "lookup", {
      parent_ino: 1,
      name: "origin.txt",
    });
    assert.equal(lookup.p.err, 0);
    const oldIno = (lookup.p.res?.entry as any).ino as number;

    const linked = await send(service, "link", {
      old_ino: oldIno,
      new_parent_ino: 1,
      new_name: "linked.txt",
    });
    assert.equal(linked.p.err, 0);

    const hostStats = await fs.lstat(path.join(tempDir, "origin.txt"));
    assert.equal(hostStats.nlink, 2);

    const linkedLookup = await send(service, "lookup", {
      parent_ino: 1,
      name: "linked.txt",
    });
    assert.equal(linkedLookup.p.err, 0);
    const linkedIno = (linkedLookup.p.res?.entry as any).ino as number;
    assert.equal(linkedIno, oldIno);

    const linkedOpen = await send(service, "open", {
      ino: linkedIno,
      flags: LINUX_OPEN_FLAGS.O_RDONLY,
    });
    assert.equal(linkedOpen.p.err, 0);
    const linkedFh = linkedOpen.p.res?.fh as number;
    const linkedRead = await send(service, "read", {
      fh: linkedFh,
      offset: 0,
      size: 5,
    });
    assert.equal(linkedRead.p.err, 0);
    assert.equal(
      Buffer.from(linkedRead.p.res?.data as Buffer).toString("utf8"),
      "hello",
    );
    await send(service, "release", { fh: linkedFh });

    const unlinkOrigin = await send(service, "unlink", {
      parent_ino: 1,
      name: "origin.txt",
    });
    assert.equal(unlinkOrigin.p.err, 0);

    const stillLinked = await send(service, "lookup", {
      parent_ino: 1,
      name: "linked.txt",
    });
    assert.equal(stillLinked.p.err, 0);

    const getattrLinked = await send(service, "getattr", { ino: oldIno });
    assert.equal(getattrLinked.p.err, 0);
  } finally {
    await service.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("fs rpc symlink returns ENOSYS when provider lacks symlink support", async () => {
  const base = new MemoryProvider();
  const provider = new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "symlink") {
        return undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const service = new FsRpcService(provider);

  const linked = await send(service, "symlink", {
    parent_ino: 1,
    name: "python",
    target: "/usr/bin/python",
  });
  assert.equal(linked.p.err, ERRNO.ENOSYS);

  await service.close();
});

test("fs rpc symlink creates symbolic links with RealFSProvider", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "gondolin-fs-rpc-symlink-"),
  );
  const service = new FsRpcService(new RealFSProvider(tempDir));

  try {
    await fs.writeFile(path.join(tempDir, "target.txt"), "ok");

    const linked = await send(service, "symlink", {
      parent_ino: 1,
      name: "python",
      target: "target.txt",
    });
    assert.equal(linked.p.err, 0);

    const hostTarget = await fs.readlink(path.join(tempDir, "python"));
    assert.equal(hostTarget, "target.txt");

    const lookup = await send(service, "lookup", {
      parent_ino: 1,
      name: "python",
    });
    assert.equal(lookup.p.err, 0);
    const ino = (lookup.p.res?.entry as any).ino as number;

    const readlink = await send(service, "readlink", { ino });
    assert.equal(readlink.p.err, 0);
    assert.equal(readlink.p.res?.target, "target.txt");
  } finally {
    await service.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("fs rpc lookup/getattr/readdir use lstat for dangling symlinks", async () => {
  const service = createService();

  const linked = await send(service, "symlink", {
    parent_ino: 1,
    name: "dangling",
    target: "missing-target",
  });
  assert.equal(linked.p.err, 0);

  const lookup = await send(service, "lookup", {
    parent_ino: 1,
    name: "dangling",
  });
  assert.equal(lookup.p.err, 0);
  const ino = (lookup.p.res?.entry as any).ino as number;

  const getattr = await send(service, "getattr", { ino });
  assert.equal(getattr.p.err, 0);
  const mode = ((getattr.p.res?.attr as any)?.mode ?? 0) as number;
  assert.equal(mode & 0o170000, 0o120000);

  const readdir = await send(service, "readdir", {
    ino: 1,
    offset: 0,
    max_entries: 128,
  });
  assert.equal(readdir.p.err, 0);
  const entries =
    (readdir.p.res?.entries as Array<{ name: string; type: number }>) ?? [];
  const dangling = entries.find((entry) => entry.name === "dangling");
  assert.ok(dangling);
  assert.equal(dangling?.type, DT_LNK);

  await service.close();
});

test("fs rpc access falls back to stat-based permission checks", async () => {
  const base = new MemoryProvider();
  const provider = new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "access") {
        return undefined;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
  const service = new FsRpcService(provider);

  const created = await send(service, "create", {
    parent_ino: 1,
    name: "perm.txt",
    mode: 0o644,
    flags: 0,
  });
  assert.equal(created.p.err, 0);
  const ino = (created.p.res?.entry as any).ino as number;
  const fh = created.p.res?.fh as number;
  await send(service, "release", { fh });

  const readOk = await send(service, "access", {
    ino,
    mask: 4,
    uid: 1234,
    gid: 1234,
  });
  assert.equal(readOk.p.err, 0);

  const execDenied = await send(service, "access", {
    ino,
    mask: 1,
    uid: 1234,
    gid: 1234,
  });
  assert.equal(execDenied.p.err, ERRNO.EACCES);

  const invalidMask = await send(service, "access", {
    ino,
    mask: 8,
    uid: 1234,
    gid: 1234,
  });
  assert.equal(invalidMask.p.err, ERRNO.EINVAL);

  await service.close();
});

test("fs rpc access returns EROFS for write checks on readonly providers", async () => {
  const base = new MemoryProvider();
  const setup = await base.open("/ro.txt", "w+");
  await setup.writeFile("readonly");
  await setup.close();

  const readonly = new ReadonlyProvider(base);
  const provider = new Proxy(readonly as any, {
    get(target, prop, receiver) {
      if (prop === "access") {
        return undefined;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
  const service = new FsRpcService(provider);

  const lookup = await send(service, "lookup", {
    parent_ino: 1,
    name: "ro.txt",
  });
  assert.equal(lookup.p.err, 0);
  const ino = (lookup.p.res?.entry as any).ino as number;

  const writeDenied = await send(service, "access", {
    ino,
    mask: 2,
    uid: 1234,
    gid: 1234,
  });
  assert.equal(writeDenied.p.err, ERRNO.EROFS);

  await service.close();
});

test("fs rpc fallocate extends files and rejects unsupported modes", async () => {
  const service = createService();

  const created = await send(service, "create", {
    parent_ino: 1,
    name: "alloc.txt",
    mode: 0o644,
    flags: 0,
  });
  assert.equal(created.p.err, 0);
  const ino = (created.p.res?.entry as any).ino as number;
  const fh = created.p.res?.fh as number;

  const write = await send(service, "write", {
    fh,
    offset: 0,
    data: Buffer.from("ab"),
  });
  assert.equal(write.p.err, 0);

  const fallocate = await send(service, "fallocate", {
    fh,
    offset: 10,
    length: 5,
    mode: 0,
  });
  assert.equal(fallocate.p.err, 0);

  const getattr = await send(service, "getattr", { ino });
  assert.equal(getattr.p.err, 0);
  const size = Number((getattr.p.res?.attr as any)?.size ?? -1);
  assert.equal(size, 15);

  const unsupportedMode = await send(service, "fallocate", {
    fh,
    offset: 0,
    length: 1,
    mode: 1,
  });
  assert.equal(unsupportedMode.p.err, ERRNO.EOPNOTSUPP);

  await send(service, "release", { fh });
  await service.close();
});

test("fs rpc copy_file_range emulates in-kernel copy", async () => {
  const service = createService();

  const src = await send(service, "create", {
    parent_ino: 1,
    name: "src.txt",
    mode: 0o644,
    flags: 0,
  });
  assert.equal(src.p.err, 0);
  const srcFh = src.p.res?.fh as number;

  const dst = await send(service, "create", {
    parent_ino: 1,
    name: "dst.txt",
    mode: 0o644,
    flags: 0,
  });
  assert.equal(dst.p.err, 0);
  const dstFh = dst.p.res?.fh as number;

  const seed = await send(service, "write", {
    fh: srcFh,
    offset: 0,
    data: Buffer.from("hello world"),
  });
  assert.equal(seed.p.err, 0);

  const copied = await send(service, "copy_file_range", {
    fh_in: srcFh,
    off_in: 0,
    fh_out: dstFh,
    off_out: 0,
    len: 5,
    flags: 0,
  });
  assert.equal(copied.p.err, 0);
  assert.equal(copied.p.res?.size, 5);

  const dstRead = await send(service, "read", {
    fh: dstFh,
    offset: 0,
    size: 16,
  });
  assert.equal(dstRead.p.err, 0);
  assert.equal(
    Buffer.from(dstRead.p.res?.data as Buffer).toString("utf8"),
    "hello",
  );

  const invalidFlags = await send(service, "copy_file_range", {
    fh_in: srcFh,
    off_in: 0,
    fh_out: dstFh,
    off_out: 0,
    len: 1,
    flags: 1,
  });
  assert.equal(invalidFlags.p.err, ERRNO.EINVAL);

  const overlap = await send(service, "copy_file_range", {
    fh_in: srcFh,
    off_in: 0,
    fh_out: srcFh,
    off_out: 1,
    len: 2,
    flags: 0,
  });
  assert.equal(overlap.p.err, ERRNO.EINVAL);

  await send(service, "release", { fh: srcFh });
  await send(service, "release", { fh: dstFh });
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

  const lookup = await send(service, "lookup", {
    parent_ino: 1,
    name: "f.txt",
  });
  const ino = (lookup.p.res?.entry as any).ino as number;

  const openCreat = await send(service, "open", {
    ino,
    flags: LINUX_OPEN_FLAGS.O_CREAT | LINUX_OPEN_FLAGS.O_WRONLY,
  });
  assert.equal(openCreat.p.err, ERRNO.EINVAL);

  const openTrunc = await send(service, "open", {
    ino,
    flags: LINUX_OPEN_FLAGS.O_WRONLY | LINUX_OPEN_FLAGS.O_TRUNC,
  });
  assert.equal(openTrunc.p.err, 0);
  const fhTrunc = openTrunc.p.res?.fh as number;

  const readEmpty = await send(service, "read", {
    fh: fhTrunc,
    offset: 0,
    size: 10,
  });
  assert.equal(readEmpty.p.err, 0);
  assert.equal(Buffer.from(readEmpty.p.res?.data as Buffer).length, 0);

  await send(service, "write", {
    fh: fhTrunc,
    offset: 0,
    data: Buffer.from("a"),
  });
  await send(service, "release", { fh: fhTrunc });

  const openAppend = await send(service, "open", {
    ino,
    flags: LINUX_OPEN_FLAGS.O_WRONLY | LINUX_OPEN_FLAGS.O_APPEND,
  });
  assert.equal(openAppend.p.err, 0);
  const fhAppend = openAppend.p.res?.fh as number;
  await send(service, "write", {
    fh: fhAppend,
    offset: 0,
    data: Buffer.from("b"),
  });
  await send(service, "release", { fh: fhAppend });

  const openRead = await send(service, "open", {
    ino,
    flags: LINUX_OPEN_FLAGS.O_RDONLY,
  });
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

  const created = await send(service, "create", {
    parent_ino: 1,
    name: "m.txt",
    mode: 0o644,
    flags: 0,
  });
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
      if (prop === "lstat") {
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
      if (prop === "lstat") {
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

  const created = await send(service, "create", {
    parent_ino: 1,
    name: "x.txt",
    mode: 0o644,
    flags: 0,
  });
  assert.equal(created.p.err, 0);
  const fh = created.p.res?.fh as number;

  await service.close();
  assert.equal(getCloseCount(), 1);

  const after = await send(service, "release", { fh });
  assert.equal(after.p.err, ERRNO.EBADF);
});
