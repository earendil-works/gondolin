import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MemoryProvider,
  ReadonlyProvider,
  RealFSProvider,
  ShadowProvider,
  type VM,
  VirtualProviderClass,
  type VirtualProvider,
  createObjectMount,
  createShadowPathPredicate,
  nativeMounts,
} from "../../src/index.ts";
import { MapObjectProvider } from "../lib/map-object-provider.ts";
import {
  createVm,
  enginePids,
  getEngine,
  guestRmTree,
  guestVfsTransport,
  isVirtiofsEngine,
  guestTime,
  installGuestTools,
  sh,
} from "../lib/engine.ts";
import { type Bench, MiB, mbps, nsToMs } from "../lib/harness.ts";

/** Async methods forwarded by the object-tier stand-in */
const DELEGATED = [
  "open",
  "stat",
  "lstat",
  "readdir",
  "mkdir",
  "rmdir",
  "unlink",
  "rename",
  "readFile",
  "writeFile",
  "exists",
  "copyFile",
  "realpath",
  "access",
  "readlink",
  "symlink",
  "link",
  "chmod",
  "chown",
  "utimes",
  "truncate",
  "statfs",
];

/**
 * Stand-in for an object-tier provider: a plain JS provider that forwards to
 * a `MemoryProvider` with an extra async hop per call. It is not a subclass of
 * a built-in provider so engines cannot translate it to a native mount.
 */
class ObjectStandInProvider extends VirtualProviderClass {
  readonly inner: VirtualProvider;
  constructor(inner: VirtualProvider) {
    super();
    this.inner = inner;
  }
  get readonly() {
    return false;
  }
  get supportsSymlinks() {
    return this.inner.supportsSymlinks;
  }
  get supportsWatch() {
    return false;
  }
}
for (const method of DELEGATED) {
  ObjectStandInProvider.prototype[method] = async function (
    this: ObjectStandInProvider,
    ...args: unknown[]
  ) {
    await Promise.resolve();
    const fn = (
      this.inner as unknown as Record<string, (...a: unknown[]) => unknown>
    )[method];
    return fn.apply(this.inner, args);
  };
}

/** Deterministic source-like tree: nested dirs of text files, mostly small */
function generateTree(root: string, files: number) {
  let seed = 0x2545f491;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const line =
    "export function handler(request, response) { return request.body; }\n";
  for (let i = 0; i < files; i++) {
    const dir = path.join(
      root,
      `pkg${i % 20}`,
      `mod${Math.floor(i / 20) % 10}`,
      `sub${i % 3}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    const size =
      rand() < 0.9
        ? 256 + Math.floor(rand() * 8192)
        : 16384 + Math.floor(rand() * 49152);
    fs.writeFileSync(
      path.join(dir, `file${i}.ts`),
      line.repeat(Math.ceil(size / line.length)).slice(0, size),
    );
  }
}

type MountKind = {
  kind: string;
  guestPath: string;
  readonly: boolean;
  description: string;
  /** large file size in `bytes` (smaller for memory-backed mounts) */
  largeBytes?: number;
};

const VFS_WORKLOADS = [
  "small-create",
  "small-stat",
  "small-read",
  "readdir-large",
  "tree-find",
  "tree-ls-lR",
  "untar",
  "large-write",
  "large-read",
];

/** Mount kinds of the suite (see `kinds` below) */
const KIND_NAMES = [
  "guest-tmpfs",
  "memory",
  "realfs",
  "shadow",
  "readonly",
  "js-wrapper",
  "native-memory",
  "object-mount",
];

export async function vfsSuite(bench: Bench) {
  const wanted = KIND_NAMES.some((kind) =>
    VFS_WORKLOADS.some((w) => bench.matches(`vfs.${w}.${kind}`)),
  );
  if (!wanted) return;
  const smallCount = bench.q(1000, 200);
  const smallSize = 4096;
  const bigDirCount = bench.q(5000, 500);
  const treeFiles = bench.q(2000, 200);
  const defaultLargeBytes = bench.q(256, 32) * MiB;
  // Memory-backed mounts hold the file in host memory; keep it moderate.
  const memoryLargeBytes = bench.q(64, 32) * MiB;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-bench-vfs-"));
  let vm: VM | null = null;
  try {
    const dirs = Object.fromEntries(
      ["realfs", "shadow", "ro"].map((name) => [name, path.join(tmp, name)]),
    );
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir);

    // Read-only fixture is populated on the host.
    const ro = dirs.ro;
    fs.mkdirSync(path.join(ro, "small"));
    const small = Buffer.alloc(smallSize, 0x78);
    for (let i = 0; i < smallCount; i++)
      fs.writeFileSync(
        path.join(ro, "small", `f${String(i).padStart(5, "0")}`),
        small,
      );
    fs.mkdirSync(path.join(ro, "bigdir"));
    for (let i = 0; i < bigDirCount; i++)
      fs.writeFileSync(
        path.join(ro, "bigdir", `f${String(i).padStart(5, "0")}`),
        "",
      );
    const fd = fs.openSync(path.join(ro, "large.bin"), "w");
    const block = Buffer.alloc(MiB, 0x5a);
    for (let i = 0; i < defaultLargeBytes / MiB; i++) fs.writeSync(fd, block);
    fs.closeSync(fd);
    generateTree(path.join(ro, "tree"), treeFiles);

    const shadowPaths = ["/.env", "/secrets", "/node_modules/.cache"];
    vm = await createVm({
      vfs: {
        mounts: {
          "/mnt/memory": new MemoryProvider(),
          "/mnt/realfs": new RealFSProvider(dirs.realfs),
          "/mnt/shadow": new ShadowProvider(new RealFSProvider(dirs.shadow), {
            shouldShadow: createShadowPathPredicate(shadowPaths),
            writeMode: "tmpfs",
          }),
          "/mnt/readonly": new ReadonlyProvider(new RealFSProvider(ro)),
          "/mnt/js-wrapper": new ObjectStandInProvider(
            new MemoryProvider(),
          ) as unknown as VirtualProvider,
          "/mnt/native-memory": nativeMounts.memory(),
          "/mnt/object-mount": createObjectMount(new MapObjectProvider()),
        },
      },
    });
    const guest = vm;
    await installGuestTools(guest);
    const transport = await guestVfsTransport(guest);
    if (isVirtiofsEngine(getEngine()) && transport !== "virtiofs") {
      throw new Error(`expected a virtio-fs guest mount, got ${transport}`);
    }
    bench.options.log(`  guest vfs transport: ${transport}`);
    await sh(
      guest,
      "tar -cf /tmp/src.tar -C /mnt/readonly tree && mkdir -p /tmp/tmpfs-ref",
    );
    const tarBytes = Number(await sh(guest, "stat -c %s /tmp/src.tar"));

    const kinds: MountKind[] = [
      {
        kind: "guest-tmpfs",
        guestPath: "/tmp/tmpfs-ref",
        readonly: false,
        description: "guest tmpfs (reference, no host vfs)",
      },
      {
        kind: "memory",
        guestPath: "/mnt/memory",
        readonly: false,
        description: "MemoryProvider",
        largeBytes: memoryLargeBytes,
      },
      {
        kind: "realfs",
        guestPath: "/mnt/realfs",
        readonly: false,
        description: "RealFSProvider (host tmp dir)",
      },
      {
        kind: "shadow",
        guestPath: "/mnt/shadow",
        readonly: false,
        description: `ShadowProvider(RealFSProvider) shadowing ${shadowPaths.join(",")}, tmpfs write mode`,
      },
      {
        kind: "readonly",
        guestPath: "/mnt/readonly",
        readonly: true,
        description: "ReadonlyProvider(RealFSProvider), host-populated",
      },
      {
        kind: "js-wrapper",
        guestPath: "/mnt/js-wrapper",
        readonly: false,
        description:
          "custom JS VirtualProvider delegating to MemoryProvider (object tier adapter on native)",
        largeBytes: memoryLargeBytes,
      },
      {
        kind: "native-memory",
        guestPath: "/mnt/native-memory",
        readonly: false,
        description: "nativeMounts.memory() (daemon memory fs)",
        largeBytes: memoryLargeBytes,
      },
      {
        kind: "object-mount",
        guestPath: "/mnt/object-mount",
        readonly: false,
        description:
          "createObjectMount(in-memory ObjectProvider), default options (commit on close, 1 s cache)",
        largeBytes: memoryLargeBytes,
      },
    ];
    const pids = () => enginePids(guest);
    const fsbench = async (args: string, signal: AbortSignal) =>
      nsToMs(await sh(guest, `python3 /tmp/bench/fsbench.py ${args}`, signal));

    for (const mount of kinds) {
      if (!VFS_WORKLOADS.some((w) => bench.matches(`vfs.${w}.${mount.kind}`))) {
        continue;
      }
      const base = mount.readonly
        ? mount.guestPath
        : `${mount.guestPath}/bench`;
      const params = { mount: mount.description, guestPath: base, transport };
      const largeBytes = mount.largeBytes ?? defaultLargeBytes;
      try {
        if (!mount.readonly) {
          await sh(
            guest,
            `mkdir -p ${base} && tar -xf /tmp/src.tar -C ${base}`,
          );
          await fsbench(
            `create ${base}/small ${smallCount} ${smallSize}`,
            new AbortController().signal,
          );
          await fsbench(
            `create ${base}/bigdir ${bigDirCount} 0`,
            new AbortController().signal,
          );
        }
      } catch (err) {
        bench.fail(`vfs.setup.${mount.kind}`, err);
        continue;
      }

      if (!mount.readonly) {
        await bench.run({
          name: `vfs.small-create.${mount.kind}`,
          params: {
            ...params,
            files: smallCount,
            fileBytes: smallSize,
            timing: "python3 in guest",
          },
          iterations: 5,
          run: async (i, signal) => ({
            guestMs: await fsbench(
              `create ${base}/create-${i} ${smallCount} ${smallSize}`,
              signal,
            ),
          }),
          after: async (i) => guestRmTree(guest, `${base}/create-${i}`),
        });
      }
      await bench.run({
        name: `vfs.small-stat.${mount.kind}`,
        params: {
          ...params,
          files: smallCount,
          timing: "python3 in guest, caches dropped",
        },
        iterations: 5,
        run: async (_i, signal) => ({
          guestMs: await fsbench(`stat ${base}/small ${smallCount}`, signal),
        }),
      });
      await bench.run({
        name: `vfs.small-read.${mount.kind}`,
        params: {
          ...params,
          files: smallCount,
          fileBytes: smallSize,
          timing: "python3 in guest, caches dropped",
        },
        iterations: 5,
        run: async (_i, signal) => ({
          guestMs: await fsbench(`read ${base}/small ${smallCount}`, signal),
        }),
      });
      await bench.run({
        name: `vfs.readdir-large.${mount.kind}`,
        params: {
          ...params,
          entries: bigDirCount,
          timing: "python3 os.scandir in guest, caches dropped",
        },
        iterations: 5,
        run: async (_i, signal) => ({
          guestMs: await fsbench(
            `readdir ${base}/bigdir ${bigDirCount}`,
            signal,
          ),
        }),
      });
      for (const [label, cmd] of [
        ["tree-find", "find"],
        ["tree-ls-lR", "ls -lR"],
      ]) {
        await bench.run({
          name: `vfs.${label}.${mount.kind}`,
          params: { ...params, command: `${cmd} tree`, files: treeFiles },
          iterations: 5,
          before: async () =>
            void (await sh(guest, "sync; echo 3 > /proc/sys/vm/drop_caches")),
          run: async (_i, signal) => ({
            guestMs: await guestTime(
              guest,
              `${cmd} ${base}/tree > /dev/null`,
              signal,
            ),
          }),
        });
      }
      if (!mount.readonly) {
        await bench.run({
          name: `vfs.untar.${mount.kind}`,
          params: {
            ...params,
            files: treeFiles,
            tarBytes,
            command: "tar -xf /tmp/src.tar",
          },
          iterations: 5,
          before: async (i) =>
            void (await sh(guest, `mkdir -p ${base}/untar-${i}`)),
          run: async (i, signal) => ({
            guestMs: await guestTime(
              guest,
              `tar -xf /tmp/src.tar -C ${base}/untar-${i}`,
              signal,
            ),
          }),
          after: async (i) => guestRmTree(guest, `${base}/untar-${i}`),
        });
        await bench.run({
          name: `vfs.large-write.${mount.kind}`,
          params: {
            ...params,
            bytes: largeBytes,
            command: "dd bs=1M conv=fsync",
          },
          iterations: 3,
          cost: true,
          enginePids: pids,
          units: { MBps: "MB/s" },
          run: async (_i, signal) => {
            const guestMs = await guestTime(
              guest,
              `dd if=/dev/zero of=${base}/large-w bs=1M count=${largeBytes / MiB} conv=fsync 2>/dev/null`,
              signal,
            );
            return { guestMs, MBps: mbps(largeBytes, guestMs) };
          },
          after: async () => void (await sh(guest, `rm -f ${base}/large-w`)),
        });
        await sh(
          guest,
          `dd if=/dev/zero of=${base}/large.bin bs=1M count=${largeBytes / MiB} 2>/dev/null`,
        ).catch(() => {});
      }
      await bench.run({
        name: `vfs.large-read.${mount.kind}`,
        params: {
          ...params,
          bytes: largeBytes,
          command: "dd bs=1M, caches dropped",
        },
        iterations: 3,
        cost: true,
        enginePids: pids,
        units: { MBps: "MB/s" },
        before: async () =>
          void (await sh(guest, "sync; echo 3 > /proc/sys/vm/drop_caches")),
        run: async (_i, signal) => {
          const guestMs = await guestTime(
            guest,
            `dd if=${base}/large.bin of=/dev/null bs=1M 2>/dev/null`,
            signal,
          );
          return { guestMs, MBps: mbps(largeBytes, guestMs) };
        },
      });
      if (!mount.readonly) await guestRmTree(guest, base).catch(() => {});
    }
  } catch (err) {
    bench.fail("vfs.setup", err);
  } finally {
    if (vm) await vm.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
