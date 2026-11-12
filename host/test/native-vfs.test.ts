import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NativeVfs, nativeMounts } from "../src/native/vfs.ts";
import { createMitmCaProvider } from "../src/vm/mitm-vfs.ts";
import { MemoryProvider, RealFSProvider } from "../src/vfs/node/index.ts";
import {
  createObjectMount,
  type ObjectDirEntry,
  type ObjectProvider,
  type ObjectStat,
} from "../src/vfs/object.ts";
import { ReadonlyProvider } from "../src/vfs/readonly.ts";
import {
  ShadowProvider,
  createShadowPathPredicate,
} from "../src/vfs/shadow.ts";
import {
  closeVm,
  scheduleForceExit,
  shouldSkipVmTests,
  withVm,
} from "./helpers/vm-fixture.ts";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 60000);

function tempDir(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-native-vfs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mountsOf(vfs: NativeVfs) {
  const config = vfs.config as { mounts: Array<Record<string, any>> };
  return new Map(config.mounts.map((m) => [m.path as string, m]));
}

test("native vfs translates providers into native mounts", (t) => {
  const dir = tempDir(t);
  const shared = new MemoryProvider();
  const ro = new MemoryProvider();
  ro.setReadOnly();
  const vfs = new NativeVfs({
    mounts: {
      "/host": new RealFSProvider(dir),
      "/ro-host": new ReadonlyProvider(new RealFSProvider(dir)),
      "/hidden": new ShadowProvider(new RealFSProvider(dir), {
        shouldShadow: createShadowPathPredicate(["/.env", "node_modules"]),
        writeMode: "tmpfs",
      }),
      "/custom": new ShadowProvider(new RealFSProvider(dir), {
        shouldShadow: ({ path: p }) => p.endsWith(".secret"),
      }),
      "/shared": shared,
      "/ro-mem": ro,
      "/scratch": nativeMounts.memory(),
      "/etc/gondolin/mitm": createMitmCaProvider(dir),
      "/objects": createObjectMount(
        {
          stat: async () => ({ kind: "dir", size: 0 }),
          readDir: async () => [],
        },
        { cacheTtlMs: 5000, enumeration: "none" },
      ),
    },
    hooks: { after: () => {} },
    fuseMount: "/data",
    fuseBinds: ["/host"],
  });
  const m = mountsOf(vfs);
  const real = fs.realpathSync(dir);
  assert.deepEqual(m.get("/host"), {
    path: "/host",
    kind: "host",
    root: real,
    layers: [],
  });
  assert.deepEqual(m.get("/ro-host")!.layers, [{ kind: "readonly" }]);
  assert.equal(m.get("/hidden")!.kind, "host");
  assert.deepEqual(m.get("/hidden")!.layers, [
    {
      kind: "hide",
      paths: ["/node_modules", "/.env"],
      write_mode: "tmpfs",
      deny_write_errno: "EACCES",
      deny_symlink_bypass: true,
    },
  ]);
  // an arbitrary predicate cannot be evaluated natively
  assert.equal(m.get("/custom")!.kind, "object");
  // user-visible memory providers stay the source of truth
  assert.equal(m.get("/shared")!.kind, "object");
  assert.equal(m.get("/shared")!.writable, true);
  assert.equal(m.get("/shared")!.commit, "write");
  assert.equal(m.get("/ro-mem")!.writable, false);
  assert.equal(m.get("/scratch")!.kind, "memory");
  assert.equal(m.get("/etc/gondolin/mitm")!.kind, "static");
  assert.ok(Buffer.isBuffer(m.get("/etc/gondolin/mitm")!.files["/ca.crt"]));
  const obj = m.get("/objects")!;
  assert.equal(obj.kind, "object");
  assert.equal(obj.writable, false);
  assert.equal(obj.enumeration, "none");
  assert.equal(obj.cache.ttl_ms, 5000);
  assert.deepEqual((vfs.config as any).hooks, { before: false, events: true });
  assert.equal((vfs.config as any).mode, "native");
  assert.ok(vfs.servedByDaemon("/scratch/x"));
  assert.ok(vfs.servedByDaemon("/objects"));
  assert.ok(!vfs.servedByDaemon("/shared/x"));
  assert.ok(!vfs.servedByDaemon("/host/x"));
});

test("native vfs keeps controller-local paths out of remote sessions", (t) => {
  const dir = tempDir(t);
  const vfs = new NativeVfs(
    {
      mounts: {
        "/local": new RealFSProvider(dir),
        "/remote": nativeMounts.host("/srv/project", {
          readonly: true,
          hide: [".env"],
        }),
      },
      fuseMount: "/data",
      fuseBinds: [],
    },
    { remote: true },
  );
  const m = mountsOf(vfs);
  assert.equal(m.get("/local")!.kind, "object");
  assert.equal(m.get("/remote")!.kind, "host");
  assert.equal(m.get("/remote")!.root, "/srv/project");
  assert.deepEqual(
    m.get("/remote")!.layers.map((l: { kind: string }) => l.kind),
    ["hide", "readonly"],
  );
  assert.deepEqual(vfs.daemonPaths, ["/srv/project"]);
  assert.ok(vfs.servedByDaemon("/remote/a"));
  assert.ok(!JSON.stringify(vfs.config).includes(dir));
});

type Handler = (p: any) => Promise<Record<string, unknown>>;

function fakeTransport() {
  const requests = new Map<string, Handler>();
  const messages = new Map<string, (p: any) => void>();
  return {
    requests,
    messages,
    handleRequest(t: string, h: Handler) {
      requests.set(t, h);
    },
    onMessage(t: string, h: (p: any) => void) {
      messages.set(t, h);
    },
    request: async () => {
      throw new Error("unsupported");
    },
  };
}

test("native vfs serves object calls from a VirtualProvider", async () => {
  const provider = new MemoryProvider();
  provider.writeFileSync!("/a.txt", "hello world");
  const vfs = new NativeVfs({
    mounts: { "/": provider },
    fuseMount: "/data",
    fuseBinds: [],
  });
  const transport = fakeTransport();
  vfs.install(transport as any);
  const call = transport.requests.get("vfs_call")!;
  const id = vfs.objectMountIds[0];

  const st = await call({ mount_id: id, op: "stat", path: "/a.txt" });
  assert.equal((st.stat as any).kind, "file");
  assert.equal((st.stat as any).size, 11);
  assert.ok(Number.isInteger((st.stat as any).mtime_ms));

  const part = await call({
    mount_id: id,
    op: "read_file",
    path: "/a.txt",
    offset: 6,
    length: 5,
  });
  assert.equal(Buffer.from(part.data as Buffer).toString(), "world");

  await call({
    mount_id: id,
    op: "write_file",
    path: "/b.txt",
    data: Buffer.from("ab"),
    offset: 0,
    last: false,
  });
  assert.throws(() => provider.statSync("/b.txt"));
  await call({
    mount_id: id,
    op: "write_file",
    path: "/b.txt",
    data: Buffer.from("cd"),
    offset: 2,
    last: true,
    mode: 0o600,
  });
  assert.equal(provider.readFileSync!("/b.txt", "utf8"), "abcd");
  await call({
    mount_id: id,
    op: "write",
    path: "/b.txt",
    offset: 1,
    data: Buffer.from("X"),
  });
  assert.equal(provider.readFileSync!("/b.txt", "utf8"), "aXcd");
  await call({ mount_id: id, op: "mkdir", path: "/d", mode: 0o700 });
  const list = await call({ mount_id: id, op: "readdir", path: "/" });
  const names = (list.entries as ObjectDirEntry[]).map(
    (e) => `${e.name}:${e.kind}`,
  );
  assert.deepEqual(names.sort(), ["a.txt:file", "b.txt:file", "d:dir"]);

  await assert.rejects(
    () => call({ mount_id: id, op: "stat", path: "/missing" }),
    (err: any) => err.code === "ENOENT",
  );
  await assert.rejects(
    () => call({ mount_id: id, op: "rmdir", path: "/" }),
    (err: any) => typeof err.code === "string" && err.code.startsWith("E"),
  );
});

test("native vfs maps before hooks onto vfs_hook", async () => {
  const seen: string[] = [];
  const vfs = new NativeVfs({
    mounts: { "/": nativeMounts.memory() },
    hooks: {
      before: (ctx) => {
        seen.push(`${ctx.op}:${ctx.path}:${ctx.flags ?? ""}`);
        if (ctx.path === "/blocked") {
          const err = new Error("blocked") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
      },
    },
    fuseMount: "/data",
    fuseBinds: [],
  });
  const transport = fakeTransport();
  vfs.install(transport as any);
  const hook = transport.requests.get("vfs_hook")!;
  assert.deepEqual(await hook({ op: "open", path: "/ok", flags: "w" }), {});
  await assert.rejects(
    () => hook({ op: "open", path: "/blocked", flags: "w" }),
    (err: any) => err.code === "EACCES",
  );
  assert.deepEqual(seen, ["open:/ok:w", "open:/blocked:w"]);
  assert.equal(transport.messages.has("vfs_event"), false);
});

/** In-memory whole-file provider */
class MapObjects implements ObjectProvider {
  files = new Map<string, Buffer>();
  dirs = new Set<string>(["/"]);

  async stat(p: string): Promise<ObjectStat> {
    if (this.dirs.has(p)) return { kind: "dir", size: 0 };
    const f = this.files.get(p);
    if (!f) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    return { kind: "file", size: f.length, mode: 0o644 };
  }
  async readDir(p: string): Promise<ObjectDirEntry[]> {
    const prefix = p === "/" ? "/" : `${p}/`;
    const out: ObjectDirEntry[] = [];
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) {
        out.push({ name: k.slice(prefix.length), kind: "file" });
      }
    }
    return out;
  }
  async readFile(p: string) {
    const f = this.files.get(p);
    if (!f) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    return f;
  }
  async writeFile(p: string, data: Uint8Array) {
    if (p.endsWith(".fail")) {
      throw Object.assign(new Error("storage unavailable"), { code: "EIO" });
    }
    this.files.set(p, Buffer.from(data));
  }
  async unlink(p: string) {
    this.files.delete(p);
  }
  async rename(a: string, b: string) {
    const f = this.files.get(a);
    if (!f) throw Object.assign(new Error(`ENOENT ${a}`), { code: "ENOENT" });
    this.files.delete(a);
    this.files.set(b, f);
  }
}

const hostDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "gondolin-native-vfs-vm-"),
);
fs.writeFileSync(path.join(hostDir, "visible.txt"), "visible");
fs.writeFileSync(path.join(hostDir, ".env"), "SECRET=1");
const objects = new MapObjects();
objects.files.set("/hello.txt", Buffer.from("from object provider"));
const events: string[] = [];
const vmKey = "native-vfs";
const vmOptions = {
  sandbox: { console: "none" as const },
  vfs: {
    mounts: {
      "/workspace": nativeMounts.host(hostDir, { hide: ["/.env"] }),
      "/scratch": nativeMounts.memory(),
      "/objects": createObjectMount(objects, { cacheTtlMs: 0 }),
      "/many": new MemoryProvider(),
    },
    hooks: {
      after: (ctx: { op: string; path?: string }) => {
        events.push(`${ctx.op}:${ctx.path ?? ""}`);
      },
    },
  },
};

test.after(async () => {
  await closeVm(vmKey);
  fs.rmSync(hostDir, { recursive: true, force: true });
  scheduleForceExit();
});

async function sh(vm: any, script: string) {
  const r = await vm.exec(["/bin/sh", "-c", script]);
  if (r.exitCode !== 0) {
    throw new Error(`${script}: exit ${r.exitCode}: ${r.stderr.trim()}`);
  }
  return r.stdout as string;
}

async function eventually(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

test("native mounts: host with hide rules", {
  skip: skipVmTests,
  timeout: timeoutMs,
}, async () => {
  await withVm(vmKey, vmOptions, async (vm) => {
    assert.equal(await sh(vm, "cat /workspace/visible.txt"), "visible");
    assert.equal(await sh(vm, "ls -a /workspace | grep -c env || true"), "0\n");
    const denied = await vm.exec(["/bin/sh", "-c", "echo x > /workspace/.env"]);
    assert.notEqual(denied.exitCode, 0);
    assert.equal(
      fs.readFileSync(path.join(hostDir, ".env"), "utf8"),
      "SECRET=1",
    );
    await sh(vm, "echo guest > /workspace/new.txt");
    assert.equal(
      fs.readFileSync(path.join(hostDir, "new.txt"), "utf8"),
      "guest\n",
    );
  });
});

test("native mounts: memory mount via vm.fs and the guest", {
  skip: skipVmTests,
  timeout: timeoutMs,
}, async () => {
  await withVm(vmKey, vmOptions, async (vm) => {
    await vm.fs.writeFile("/scratch/from-host.txt", "host side");
    assert.equal(await sh(vm, "cat /scratch/from-host.txt"), "host side");
    await sh(vm, "mkdir -p /scratch/d && printf guest > /scratch/d/g.txt");
    assert.equal(
      await vm.fs.readFile("/scratch/d/g.txt", { encoding: "utf8" }),
      "guest",
    );
    assert.deepEqual((await vm.fs.listDir("/scratch")).sort(), [
      "d",
      "from-host.txt",
    ]);
    await vm.fs.deleteFile("/scratch/d", { recursive: true });
    assert.equal(await sh(vm, "ls /scratch"), "from-host.txt\n");
  });
});

test("native mounts: object provider round trip", {
  skip: skipVmTests,
  timeout: timeoutMs,
}, async () => {
  await withVm(vmKey, vmOptions, async (vm) => {
    assert.equal(
      await sh(vm, "cat /objects/hello.txt"),
      "from object provider",
    );
    await sh(vm, "printf 'written by guest' > /objects/out.txt");
    assert.ok(
      await eventually(
        () => objects.files.get("/out.txt")?.toString() === "written by guest",
      ),
    );
    objects.files.set("/late.txt", Buffer.from("late"));
    assert.equal(await sh(vm, "cat /objects/late.txt"), "late");
    await sh(
      vm,
      "mv /objects/out.txt /objects/moved.txt && rm /objects/late.txt",
    );
    assert.ok(objects.files.has("/moved.txt"));
    assert.ok(!objects.files.has("/late.txt"));
  });
});

test("native mounts: rm -rf of a large directory and after hooks", {
  skip: skipVmTests,
  timeout: timeoutMs,
}, async () => {
  await withVm(vmKey, vmOptions, async (vm) => {
    await sh(
      vm,
      "mkdir -p /many/tree && cd /many/tree && for i in $(seq 1 400); do : > f$i; done",
    );
    await sh(vm, "rm -rf /many/tree");
    assert.equal(await sh(vm, "ls /many | wc -l"), "0\n");
    assert.ok(
      await eventually(() =>
        events.some((e) => e.startsWith("mkdir:/many/tree")),
      ),
    );
  });
});

test("native mounts: object commit errors and the guest transport", {
  skip: skipVmTests,
  timeout: timeoutMs,
}, async () => {
  await withVm(vmKey, vmOptions, async (vm) => {
    const mounts = await vm.exec(["/bin/sh", "-c", "cat /proc/mounts"]);
    const virtiofs = / \/data virtiofs /.test(mounts.stdout);
    const sandboxfs = / \/data fuse\.sandboxfs /.test(mounts.stdout);
    assert.ok(virtiofs || sandboxfs, mounts.stdout);
    if (process.env.GONDOLIN_VIRTIOFS === "0") assert.ok(sandboxfs);
    // the commit of a buffered object write fails
    const r = await vm.exec([
      "/bin/sh",
      "-c",
      "printf data | dd of=/objects/x.fail 2>&1; echo rc=$?",
    ]);
    // FLUSH reaches the daemon (virtio-fs directly, sandboxfs forwards it
    // for commit-on-close handles), so close() reports the failed commit
    assert.match(r.stdout, /I\/O error/);
    assert.match(r.stdout, /rc=1/);
    assert.ok(!objects.files.has("/x.fail"));
  });
});
