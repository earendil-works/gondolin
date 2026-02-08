import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { closeVm, withVm, shouldSkipVmTests, scheduleForceExit } from "./helpers/vm-fixture";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 60000);
const execVmKey = "exec-default";
const execVmOptions = {
  server: { console: "none" },
  env: { BASE_ENV: "base" },
};

test.after(async () => {
  await closeVm(execVmKey);
  scheduleForceExit();
});

test("exec merges env inputs", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  await withVm(execVmKey, execVmOptions, async (vm) => {
    await vm.start();
    const result = await vm.exec(["/bin/sh", "-c", "echo $BASE_ENV $EXTRA_ENV"], {
      env: { EXTRA_ENV: "extra" },
    });
    assert.equal(result.stdout.trim(), "base extra");
  });
});

test("exec string form runs in /bin/sh -lc", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  await withVm(execVmKey, execVmOptions, async (vm) => {
    await vm.start();
    const result = await vm.exec("echo $BASE_ENV", { env: { BASE_ENV: "from-options" } });
    assert.equal(result.stdout.trim(), "from-options");
  });
});

test("exec supports async iterable stdin", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  async function* input() {
    yield Buffer.from("hello");
    yield Buffer.from(" world");
  }

  await withVm(execVmKey, execVmOptions, async (vm) => {
    await vm.start();
    const result = await vm.exec(["/bin/cat"], { stdin: input() });
    assert.equal(result.stdout, "hello world");
  });
});

test("exec supports readable stdin", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  const stream = Readable.from(["foo", "bar"]);

  await withVm(execVmKey, execVmOptions, async (vm) => {
    await vm.start();
    const result = await vm.exec(["/bin/cat"], { stdin: stream });
    assert.equal(result.stdout, "foobar");
  });
});

test("exec output iterator yields stdout and stderr", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  await withVm(execVmKey, execVmOptions, async (vm) => {
    await vm.start();
    const proc = vm.exec(["/bin/sh", "-c", "echo out; echo err 1>&2"]);
    const chunks: string[] = [];

    for await (const chunk of proc.output()) {
      chunks.push(`${chunk.stream}:${chunk.text.trim()}`);
    }

    const result = await proc;
    assert.equal(result.exitCode, 0);
    assert.ok(chunks.some((item) => item === "stdout:out"));
    assert.ok(chunks.some((item) => item === "stderr:err"));
  });
});

test("exec lines iterator yields stdout lines", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  await withVm(execVmKey, execVmOptions, async (vm) => {
    await vm.start();
    const proc = vm.exec(["/bin/sh", "-c", "printf 'one\ntwo\nthree'"]);
    const lines: string[] = [];

    for await (const line of proc.lines()) {
      lines.push(line);
    }

    await proc;
    assert.deepEqual(lines, ["one", "two", "three"]);
  });
});

test("shell runs commands without attaching", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  await withVm(execVmKey, execVmOptions, async (vm) => {
    await vm.start();
    const result = await vm.shell({ command: ["sh", "-c", "echo shell-ok"], attach: false });
    assert.equal(result.stdout.trim(), "shell-ok");
  });
});

test("attach mode does not buffer output", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  await withVm(execVmKey, execVmOptions, async (vm) => {
    await vm.start();
    // Generate ~2 MB of output to make double-buffering obvious
    const proc = vm.exec("dd if=/dev/zero bs=1024 count=2048 2>/dev/null | base64", {
      stdin: true,
    });

    // Create mock stdio streams that attach() accepts
    const fakeStdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;

    let totalBytes = 0;
    fakeStdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
    });

    proc.attach(fakeStdin, fakeStdout);

    const result = await proc;
    assert.equal(result.exitCode, 0);
    assert.ok(totalBytes > 0, "should have received output via attach stream");
    assert.equal(result.stdout, "", "attach should not double-buffer stdout");
    assert.equal(result.stderr, "", "attach should not double-buffer stderr");
  });
});

test("exec aborts with signal", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  await withVm(execVmKey, execVmOptions, async (vm) => {
    await vm.start();
    const controller = new AbortController();
    const proc = vm.exec(["/bin/sh", "-c", "sleep 5"], { signal: controller.signal });

    setTimeout(() => controller.abort(), 100);

    await assert.rejects(proc, /exec aborted/);
  });
});
