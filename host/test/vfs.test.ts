import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { MemoryProvider, ReadonlyProvider } from "../src/vfs";
import { createErrnoError } from "../src/vfs/errors";
import { closeAllVms, withVm } from "./helpers/vm-fixture";

const timeoutMs = Number(process.env.WS_TIMEOUT ?? 15000);
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

test.after(() => closeAllVms());

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

test("vfs roundtrip between host and guest", { timeout: timeoutMs }, async () => {
  await withVm(sharedVmKey, sharedVmOptions, async (vm) => {
    const handle = await rootProvider.open("/host.txt", "w+");
    await handle.writeFile("host-data");
    await handle.close();

    await vm.waitForReady();

    const read = await withTimeout(vm.exec(["sh", "-c", "cat /data/host.txt"]), timeoutMs);
    if (read.exitCode !== 0) {
      throw new Error(
        `cat failed (exit ${read.exitCode}): ${read.stderr.trim()}`
      );
    }
    assert.equal(read.stdout.trim(), "host-data");

    const write = await withTimeout(
      vm.exec(["sh", "-c", "echo -n guest-data > /data/guest.txt"]),
      timeoutMs
    );
    if (write.exitCode !== 0) {
      throw new Error(
        `write failed (exit ${write.exitCode}): ${write.stderr.trim()}`
      );
    }

    const append = await withTimeout(
      vm.exec(["sh", "-c", "printf foo > /data/append.txt; printf bar >> /data/append.txt; cat /data/append.txt"]),
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

test("vfs hooks can block writes", { timeout: timeoutMs }, async () => {
  blockedEntries.length = 0;

  await withVm(sharedVmKey, sharedVmOptions, async (vm) => {
    await vm.waitForReady();

    const result = await withTimeout(
      vm.exec(["sh", "-c", "echo nope > /data/blocked.txt"]),
      timeoutMs
    );
    assert.notEqual(result.exitCode, 0);
  });

  assert.ok(blockedEntries.length > 0);
  assert.ok(blockedEntries.some((entry) => entry.startsWith("/blocked.txt:")));
});

test("vfs supports read-only email mounts with dynamic content", { timeout: timeoutMs }, async () => {
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

    await vm.waitForReady();

    const rootRead = await withTimeout(vm.exec(["sh", "-c", "cat /data/root.txt"]), timeoutMs);
    if (rootRead.exitCode !== 0) {
      throw new Error(`cat root failed (exit ${rootRead.exitCode}): ${rootRead.stderr.trim()}`);
    }
    assert.equal(rootRead.stdout.trim(), "root-data");

    const emailRead = await withTimeout(
      vm.exec(["sh", "-c", `cat /app/email/${emailId}.eml`]),
      timeoutMs
    );
    if (emailRead.exitCode !== 0) {
      throw new Error(`cat email failed (exit ${emailRead.exitCode}): ${emailRead.stderr.trim()}`);
    }
    assert.equal(emailRead.stdout.trim(), emailBody);

    const writeAttempt = await withTimeout(
      vm.exec(["sh", "-c", `echo nope > /app/email/${emailId}-new.eml`]),
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

test("ReadonlyProvider works in VM guest", { timeout: timeoutMs }, async () => {
  await withVm(sharedVmKey, sharedVmOptions, async (vm) => {
    const handle = await roInnerProvider.open("/host-file.txt", "w+");
    await handle.writeFile("read-only data from host");
    await handle.close();

    await vm.waitForReady();

    // Reading from read-only mount should work
    const readResult = await withTimeout(
      vm.exec(["sh", "-c", "cat /ro/host-file.txt"]),
      timeoutMs
    );
    if (readResult.exitCode !== 0) {
      throw new Error(`cat failed (exit ${readResult.exitCode}): ${readResult.stderr.trim()}`);
    }
    assert.equal(readResult.stdout.trim(), "read-only data from host");

    // Writing to read-only mount should fail
    const writeRoResult = await withTimeout(
      vm.exec(["sh", "-c", "echo 'nope' > /ro/new-file.txt 2>&1; echo exit=$?"]),
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
      vm.exec(["sh", "-c", "echo 'writable' > /rw/new-file.txt"]),
      timeoutMs
    );
    if (writeRwResult.exitCode !== 0) {
      throw new Error(`write failed (exit ${writeRwResult.exitCode}): ${writeRwResult.stderr.trim()}`);
    }

    // Verify written content
    const verifyResult = await withTimeout(
      vm.exec(["sh", "-c", "cat /rw/new-file.txt"]),
      timeoutMs
    );
    assert.equal(verifyResult.stdout.trim(), "writable");
  });
});
