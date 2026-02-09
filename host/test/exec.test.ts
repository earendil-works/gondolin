import assert from "node:assert/strict";
import { Readable } from "node:stream";
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
    const proc = vm.exec(["/bin/sh", "-c", "echo out; echo err 1>&2"], { stdout: "pipe", stderr: "pipe" });

    const stdout = proc.stdout!;
    const stderr = proc.stderr!;

    // output() should not attach 'data' listeners (would force flowing mode and
    // defeat credit-based backpressure by draining into an unbounded queue)
    assert.equal(stdout.listenerCount("data"), 0);
    assert.equal(stderr.listenerCount("data"), 0);

    const chunks: string[] = [];
    const iterable = proc.output();

    assert.equal(stdout.listenerCount("data"), 0);
    assert.equal(stderr.listenerCount("data"), 0);

    for await (const chunk of iterable) {
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
    const proc = vm.exec(["/bin/sh", "-c", "printf 'one\ntwo\nthree'"] , { stdout: "pipe" });
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

    const proc = vm.shell({ command: ["sh", "-c", "echo shell-ok"], attach: false });

    let seen = "";
    for await (const chunk of proc) {
      seen += chunk;
    }

    const result = await proc;
    assert.equal(result.exitCode, 0);
    assert.equal(seen.trim(), "shell-ok");
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

test(
  "pty exec completes even when background jobs keep the PTY open",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();

      // Run a short-lived main process that starts a long-lived background job
      // inheriting the PTY slave.
      const proc = vm.exec(["/bin/sh", "-c", "sh -c 'trap \"\" HUP; sleep 1000' &"], {
        pty: true,
        stdout: "ignore",
        stderr: "ignore",
      });

      // Ensure that if the test fails early (e.g. timeout) we don't leave a
      // late rejection from the exec session as an unhandledRejection.
      void proc.result.catch(() => {});

      const result = await Promise.race([
        proc.result,
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("timeout waiting for pty exec to exit")),
            8000
          );
          t.unref();
          void proc.result.finally(() => clearTimeout(t));
        }),
      ]);

      assert.equal(result.exitCode, 0);
    });
  }
);
