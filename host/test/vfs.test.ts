import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { MemoryProvider, ReadonlyProvider } from "../src/vfs";
import { createErrnoError } from "../src/vfs/errors";
import { closeVm, withVm, shouldSkipVmTests, scheduleForceExit } from "./helpers/vm-fixture";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 60000);
const { errno: ERRNO } = os.constants;

const rootProvider = new MemoryProvider();
const emailProvider = new MemoryProvider();
const roInnerProvider = new MemoryProvider();
const roProvider = new ReadonlyProvider(roInnerProvider);
const rwProvider = new MemoryProvider();
const blockedEntries: string[] = [];
const sharedVmKey = "vfs-shared";
const sharedVmOptions = {
  server: { console: "none" },
  vfs: {
    mounts: {
      "/": rootProvider,
      "/app": emailProvider,
      "/ro": roProvider,
      "/rw": rwProvider,
    },
    hooks: {
      before: (ctx: { op: string; path?: string; flags?: string | number }) => {
        if (ctx.op === "open" && ctx.path === "/blocked.txt" && typeof ctx.flags === "string") {
          blockedEntries.push(`${ctx.path}:${ctx.flags}`);
          if (ctx.flags.includes("w") || ctx.flags.includes("a")) {
            throw createErrnoError(ERRNO.EACCES, "open", ctx.path);
          }
        }
      },
    },
  },
};

const fuseProvider = new MemoryProvider();
const fuseHookEvents: Array<{ op: string; path?: string; oldPath?: string; newPath?: string }> = [];
const fuseVmKey = "vfs-fuse-e2e";
const fuseVmOptions = {
  server: { console: "none" },
  vfs: {
    mounts: {
      "/": fuseProvider,
    },
    hooks: {
      before: (ctx: { op: string; path?: string; oldPath?: string; newPath?: string }) => {
        fuseHookEvents.push({
          op: ctx.op,
          path: ctx.path,
          oldPath: ctx.oldPath,
          newPath: ctx.newPath,
        });
      },
    },
  },
};

test.after(async () => {
  await closeVm(sharedVmKey);
  await closeVm(fuseVmKey);
  scheduleForceExit();
});

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("timeout waiting for response"));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("vfs roundtrip between host and guest", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  await withVm(sharedVmKey, sharedVmOptions, async (vm) => {
    const handle = await rootProvider.open("/host.txt", "w+");
    await handle.writeFile("host-data");
    await handle.close();

    await vm.start();

    const read = await withTimeout(vm.exec(["/bin/sh", "-c", "cat /data/host.txt"]), timeoutMs);
    if (read.exitCode !== 0) {
      throw new Error(
        `cat failed (exit ${read.exitCode}): ${read.stderr.trim()}`
      );
    }
    assert.equal(read.stdout.trim(), "host-data");

    const write = await withTimeout(
      vm.exec(["/bin/sh", "-c", "echo -n guest-data > /data/guest.txt"]),
      timeoutMs
    );
    if (write.exitCode !== 0) {
      throw new Error(
        `write failed (exit ${write.exitCode}): ${write.stderr.trim()}`
      );
    }

    const append = await withTimeout(
      vm.exec(["/bin/sh", "-c", "printf foo > /data/append.txt; printf bar >> /data/append.txt; cat /data/append.txt"]),
      timeoutMs
    );
    if (append.exitCode !== 0) {
      throw new Error(
        `append failed (exit ${append.exitCode}): ${append.stderr.trim()}`
      );
    }
    assert.equal(append.stdout, "foobar");

    const guestHandle = await rootProvider.open("/guest.txt", "r");
    const data = await guestHandle.readFile({ encoding: "utf-8" });
    await guestHandle.close();
    assert.equal(data, "guest-data");
  });
});

test("vfs can read large files without truncation", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  await withVm(sharedVmKey, sharedVmOptions, async (vm) => {
    const size = 256 * 1024;

    const handle = await rootProvider.open("/large.bin", "w+");
    await handle.writeFile(Buffer.alloc(size, 0x61));
    await handle.close();

    await vm.start();

    // Pipe through cat to ensure we're measuring bytes actually read, not just stat().
    const result = await withTimeout(
      vm.exec(["/bin/sh", "-c", "cat /data/large.bin | wc -c"]),
      timeoutMs
    );
    if (result.exitCode !== 0) {
      throw new Error(`wc failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }

    const count = Number(result.stdout.trim());
    assert.equal(count, size);
  });
});

test("vfs hooks can block writes", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  blockedEntries.length = 0;

  await withVm(sharedVmKey, sharedVmOptions, async (vm) => {
    await vm.start();

    const result = await withTimeout(
      vm.exec(["/bin/sh", "-c", "echo nope > /data/blocked.txt"]),
      timeoutMs
    );
    assert.notEqual(result.exitCode, 0);
  });

  assert.ok(blockedEntries.length > 0);
  assert.ok(blockedEntries.some((entry) => entry.startsWith("/blocked.txt:")));
});

test("fuse-backed /data triggers hooks for guest file operations", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  fuseHookEvents.length = 0;

  await withVm(fuseVmKey, fuseVmOptions, async (vm) => {
    await vm.start();

    const mounts = await withTimeout(
      vm.exec(["/bin/sh", "-c", "grep ' /data ' /proc/mounts"]),
      timeoutMs
    );
    if (mounts.exitCode !== 0) {
      throw new Error(`mount check failed (exit ${mounts.exitCode}): ${mounts.stderr.trim()}`);
    }
    assert.ok(mounts.stdout.includes("fuse.sandboxfs"));

    fuseHookEvents.length = 0;

    const script = [
      "set -e",
      "mkdir -p /data/fuse-e2e",
      "printf 'fuse-data' > /data/fuse-e2e/hello.txt",
      "cat /data/fuse-e2e/hello.txt >/dev/null",
      "mv /data/fuse-e2e/hello.txt /data/fuse-e2e/hello-renamed.txt",
      "rm /data/fuse-e2e/hello-renamed.txt",
    ].join("; ");

    const result = await withTimeout(vm.exec(["/bin/sh", "-c", script]), timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`fuse operations failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
  });

  const baseDir = "/fuse-e2e";
  const filePath = `${baseDir}/hello.txt`;
  const renamedPath = `${baseDir}/hello-renamed.txt`;

  assert.ok(fuseHookEvents.some((event) => event.op === "mkdir" && event.path === baseDir));
  assert.ok(fuseHookEvents.some((event) => event.op === "write" && event.path === filePath));
  assert.ok(fuseHookEvents.some((event) => event.op === "read" && event.path === filePath));
  assert.ok(
    fuseHookEvents.some(
      (event) => event.op === "rename" && event.oldPath === filePath && event.newPath === renamedPath
    )
  );
  assert.ok(fuseHookEvents.some((event) => event.op === "unlink" && event.path === renamedPath));
});

test("vfs supports read-only email mounts with dynamic content", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  const emailId = "12345";
  const emailBody = "Subject: Hello\nFrom: test@example.com\n\nHi there!";
  const apiCalls: string[] = [];
  const mockApi = {
    fetchEmail(id: string) {
      apiCalls.push(id);
      return id === emailId ? emailBody : "";
    },
  };

  await withVm(sharedVmKey, sharedVmOptions, async (vm) => {
    const rootHandle = await rootProvider.open("/root.txt", "w+");
    await rootHandle.writeFile("root-data");
    await rootHandle.close();

    await emailProvider.mkdir("/email", { recursive: true });
    const emailPath = `/email/${emailId}.eml`;
    const emailHandle = await emailProvider.open(emailPath, "w+");
    await emailHandle.writeFile(emailBody);
    await emailHandle.close();

    const emailEntry = (emailProvider as unknown as {
      _getEntry: (path: string, syscall: string) => { content: Buffer; contentProvider?: () => string };
    })._getEntry(emailPath, "vfs-test");
    emailEntry.contentProvider = () => {
      const payload = mockApi.fetchEmail(emailId);
      emailEntry.content = Buffer.from(payload);
      return payload;
    };

    emailProvider.setReadOnly();

    await vm.start();

    const rootRead = await withTimeout(vm.exec(["/bin/sh", "-c", "cat /data/root.txt"]), timeoutMs);
    if (rootRead.exitCode !== 0) {
      throw new Error(`cat root failed (exit ${rootRead.exitCode}): ${rootRead.stderr.trim()}`);
    }
    assert.equal(rootRead.stdout.trim(), "root-data");

    const emailRead = await withTimeout(
      vm.exec(["/bin/sh", "-c", `cat /app/email/${emailId}.eml`]),
      timeoutMs
    );
    if (emailRead.exitCode !== 0) {
      throw new Error(`cat email failed (exit ${emailRead.exitCode}): ${emailRead.stderr.trim()}`);
    }
    assert.equal(emailRead.stdout.trim(), emailBody);

    const writeAttempt = await withTimeout(
      vm.exec(["/bin/sh", "-c", `echo nope > /app/email/${emailId}-new.eml`]),
      timeoutMs
    );
    assert.notEqual(writeAttempt.exitCode, 0);
  });

  assert.ok(apiCalls.includes(emailId));
});

test("ReadonlyProvider blocks write operations", { timeout: timeoutMs }, async () => {
  // Create a memory provider with some initial content
  const innerProvider = new MemoryProvider();
  const handle = await innerProvider.open("/existing.txt", "w+");
  await handle.writeFile("initial content");
  await handle.close();
  await innerProvider.mkdir("/subdir");

  // Wrap it with ReadonlyProvider
  const provider = new ReadonlyProvider(innerProvider);

  // Verify readonly property
  assert.equal(provider.readonly, true);

  // Read operations should work
  const readHandle = await provider.open("/existing.txt", "r");
  const content = await readHandle.readFile({ encoding: "utf-8" });
  await readHandle.close();
  assert.equal(content, "initial content");

  // stat should work
  const stats = await provider.stat("/existing.txt");
  assert.ok(stats.isFile());

  // readdir should work
  const entries = await provider.readdir("/");
  assert.ok(entries.includes("existing.txt") || entries.some((e: string | { name: string }) => typeof e === "object" && e.name === "existing.txt"));

  // Write operations should be blocked (EROFS = errno 30)
  const isEROFS = (err: unknown) => {
    const e = err as NodeJS.ErrnoException;
    return e.code === "EROFS" || e.code === "ERRNO_30" || e.errno === ERRNO.EROFS;
  };

  await assert.rejects(
    () => provider.open("/new.txt", "w"),
    isEROFS
  );

  await assert.rejects(
    () => provider.open("/existing.txt", "w"),
    isEROFS
  );

  await assert.rejects(
    () => provider.open("/existing.txt", "a"),
    isEROFS
  );

  await assert.rejects(
    () => provider.open("/existing.txt", "r+"),
    isEROFS
  );

  await assert.rejects(
    () => provider.mkdir("/newdir"),
    isEROFS
  );

  await assert.rejects(
    () => provider.unlink("/existing.txt"),
    isEROFS
  );

  await assert.rejects(
    () => provider.rmdir("/subdir"),
    isEROFS
  );

  await assert.rejects(
    () => provider.rename("/existing.txt", "/renamed.txt"),
    isEROFS
  );
});

test("ReadonlyProvider works in VM guest", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  await withVm(sharedVmKey, sharedVmOptions, async (vm) => {
    const handle = await roInnerProvider.open("/host-file.txt", "w+");
    await handle.writeFile("read-only data from host");
    await handle.close();

    await vm.start();

    // Reading from read-only mount should work
    const readResult = await withTimeout(
      vm.exec(["/bin/sh", "-c", "cat /ro/host-file.txt"]),
      timeoutMs
    );
    if (readResult.exitCode !== 0) {
      throw new Error(`cat failed (exit ${readResult.exitCode}): ${readResult.stderr.trim()}`);
    }
    assert.equal(readResult.stdout.trim(), "read-only data from host");

    // Writing to read-only mount should fail
    const writeRoResult = await withTimeout(
      vm.exec(["/bin/sh", "-c", "echo 'nope' > /ro/new-file.txt 2>&1; echo exit=$?"]),
      timeoutMs
    );
    // The exit code should be non-zero or the output should indicate failure
    assert.ok(
      writeRoResult.stdout.includes("Read-only") ||
      writeRoResult.stdout.includes("exit=1") ||
      writeRoResult.exitCode !== 0
    );

    // Writing to writable mount should work
    const writeRwResult = await withTimeout(
      vm.exec(["/bin/sh", "-c", "echo 'writable' > /rw/new-file.txt"]),
      timeoutMs
    );
    if (writeRwResult.exitCode !== 0) {
      throw new Error(`write failed (exit ${writeRwResult.exitCode}): ${writeRwResult.stderr.trim()}`);
    }

    // Verify written content
    const verifyResult = await withTimeout(
      vm.exec(["/bin/sh", "-c", "cat /rw/new-file.txt"]),
      timeoutMs
    );
    assert.equal(verifyResult.stdout.trim(), "writable");
  });
});
