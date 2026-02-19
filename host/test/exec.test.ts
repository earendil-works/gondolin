import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";

import {
  closeVm,
  withVm,
  shouldSkipVmTests,
  scheduleForceExit,
} from "./helpers/vm-fixture";

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

test(
  "exec merges env inputs",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const result = await vm.exec(
        ["/bin/sh", "-c", "echo $BASE_ENV $EXTRA_ENV"],
        {
          env: { EXTRA_ENV: "extra" },
        },
      );
      assert.equal(result.stdout.trim(), "base extra");
    });
  },
);

test(
  "exec string form runs in /bin/sh -lc",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const result = await vm.exec("echo $BASE_ENV", {
        env: { BASE_ENV: "from-options" },
      });
      assert.equal(result.stdout.trim(), "from-options");
    });
  },
);

test(
  "readFile reads text files from guest rootfs",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const osRelease = await vm.fs.readFile("/etc/os-release", {
        encoding: "utf-8",
      });
      assert.match(osRelease, /^NAME=/m);
    });
  },
);

test(
  "readFile returns a Buffer by default",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const data = await vm.fs.readFile("/bin/sh");
      assert.ok(Buffer.isBuffer(data));
      assert.ok(data.length > 0);
    });
  },
);

test(
  "readFile throws when the path is missing",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      await assert.rejects(
        () => vm.fs.readFile("/definitely-not-a-real-file"),
        /failed to read guest file/,
      );
    });
  },
);

test(
  "fs.access checks mode bits",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      await vm.exec([
        "/bin/sh",
        "-c",
        "echo ok > /tmp/gondolin-access.txt && chmod 600 /tmp/gondolin-access.txt",
      ]);

      await vm.fs.access("/tmp/gondolin-access.txt");
      await vm.fs.access("/tmp/gondolin-access.txt", {
        mode: fsConstants.R_OK,
      });

      await assert.rejects(
        () =>
          vm.fs.access("/tmp/gondolin-access.txt", {
            mode: fsConstants.X_OK,
          }),
        /failed to access guest file/,
      );
    });
  },
);

test(
  "fs.mkdir creates nested directories",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      await vm.fs.mkdir("/tmp/gondolin-mkdir/sub/child", { recursive: true });

      const check = await vm.exec([
        "/bin/sh",
        "-c",
        "test -d /tmp/gondolin-mkdir/sub/child && echo ok",
      ]);
      assert.equal(check.stdout.trim(), "ok");
    });
  },
);

test(
  "fs.listDir lists directory children",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      await vm.exec([
        "/bin/sh",
        "-c",
        "mkdir -p /tmp/gondolin-listdir && touch /tmp/gondolin-listdir/a /tmp/gondolin-listdir/b /tmp/gondolin-listdir/.hidden",
      ]);

      const entries = await vm.fs.listDir("/tmp/gondolin-listdir");
      assert.deepEqual(entries.sort(), [".hidden", "a", "b"].sort());
    });
  },
);

test(
  "fs.stat returns Node-style Stats",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      await vm.fs.writeFile("/tmp/gondolin-stat.txt", "hello");

      const stats = await vm.fs.stat("/tmp/gondolin-stat.txt");
      assert.equal(stats.isFile(), true);
      assert.equal(stats.isDirectory(), false);
      assert.equal(stats.size, 5);
    });
  },
);

test(
  "fs.rename moves files",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      await vm.fs.writeFile("/tmp/gondolin-rename-src.txt", "renamed");
      await vm.fs.rename(
        "/tmp/gondolin-rename-src.txt",
        "/tmp/gondolin-rename-dst.txt",
      );

      const content = await vm.fs.readFile("/tmp/gondolin-rename-dst.txt", {
        encoding: "utf-8",
      });
      assert.equal(content, "renamed");
      await assert.rejects(
        () => vm.fs.readFile("/tmp/gondolin-rename-src.txt"),
        /failed to read guest file/,
      );
    });
  },
);

test(
  "writeFile writes text content",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      await vm.fs.writeFile("/tmp/gondolin-write-text.txt", "hello-write\n");
      const text = await vm.fs.readFile("/tmp/gondolin-write-text.txt", {
        encoding: "utf-8",
      });
      assert.equal(text, "hello-write\n");
    });
  },
);

test(
  "writeFile writes binary content",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const payload = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await vm.fs.writeFile("/tmp/gondolin-write-bin.bin", payload);
      const stored = await vm.fs.readFile("/tmp/gondolin-write-bin.bin");
      assert.deepEqual(stored, payload);
    });
  },
);

test(
  "deleteFile removes files",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      await vm.fs.writeFile("/tmp/gondolin-delete.txt", "gone");
      await vm.fs.deleteFile("/tmp/gondolin-delete.txt");
      await assert.rejects(
        () => vm.fs.readFile("/tmp/gondolin-delete.txt"),
        /failed to read guest file/,
      );
    });
  },
);

test(
  "deleteFile supports force for missing paths",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      await vm.fs.deleteFile("/tmp/gondolin-does-not-exist", { force: true });
    });
  },
);

test(
  "deleteFile supports recursive directories",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      await vm.exec([
        "/bin/sh",
        "-c",
        "mkdir -p /tmp/gondolin-dir/sub && echo ok > /tmp/gondolin-dir/sub/file.txt",
      ]);
      await vm.fs.deleteFile("/tmp/gondolin-dir", { recursive: true });
      const check = await vm.exec(
        ["/bin/sh", "-c", "test ! -e /tmp/gondolin-dir; echo $?"],
        { stdout: "buffer" },
      );
      assert.equal(check.stdout.trim(), "0");
    });
  },
);

test(
  "writeFile supports Readable stream input",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const stream = Readable.from([
        Buffer.from("hello"),
        Buffer.from("-stream"),
      ]);
      await vm.fs.writeFile("/tmp/gondolin-write-stream.txt", stream);
      const text = await vm.fs.readFile("/tmp/gondolin-write-stream.txt", {
        encoding: "utf-8",
      });
      assert.equal(text, "hello-stream");
    });
  },
);

test(
  "readFileStream streams large files",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const payload = Buffer.alloc(512 * 1024, 0x61);
      await vm.fs.writeFile("/tmp/gondolin-stream.bin", payload);

      const stream = await vm.fs.readFileStream("/tmp/gondolin-stream.bin", {
        chunkSize: 32 * 1024,
      });
      let total = 0;

      for await (const chunk of stream) {
        total += Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(String(chunk));
      }

      assert.equal(total, payload.length);
    });
  },
);

test(
  "exec supports async iterable stdin",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    async function* input() {
      yield Buffer.from("hello");
      yield Buffer.from(" world");
    }

    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const result = await vm.exec(["/bin/cat"], { stdin: input() });
      assert.equal(result.stdout, "hello world");
    });
  },
);

test(
  "exec supports readable stdin",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    const stream = Readable.from(["foo", "bar"]);

    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const result = await vm.exec(["/bin/cat"], { stdin: stream });
      assert.equal(result.stdout, "foobar");
    });
  },
);

test(
  "exec supports concurrent processes with isolated output",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();

      const markerPrefix = `/tmp/gondolin-concurrent-exec-${process.pid}`;
      const markerA = `${markerPrefix}-a.ready`;
      const markerB = `${markerPrefix}-b.ready`;

      await vm.exec(["/bin/sh", "-c", `rm -f ${markerA} ${markerB}`]);

      const cmdA = [
        "set -eu",
        `echo A > ${markerA}`,
        "i=0",
        `while [ ! -f ${markerB} ]; do`,
        "  i=$((i+1))",
        '  if [ "$i" -gt 200 ]; then',
        "    echo 'A:timeout waiting for peer' >&2",
        "    exit 42",
        "  fi",
        "  sleep 0.01",
        "done",
        "echo 'A:out:ok'",
        "echo 'A:err:ok' >&2",
      ].join("\n");

      const cmdB = [
        "set -eu",
        `echo B > ${markerB}`,
        "i=0",
        `while [ ! -f ${markerA} ]; do`,
        "  i=$((i+1))",
        '  if [ "$i" -gt 200 ]; then',
        "    echo 'B:timeout waiting for peer' >&2",
        "    exit 42",
        "  fi",
        "  sleep 0.01",
        "done",
        "echo 'B:out:ok'",
        "echo 'B:err:ok' >&2",
      ].join("\n");

      const [a, b] = await Promise.all([
        vm.exec(["/bin/sh", "-c", cmdA]),
        vm.exec(["/bin/sh", "-c", cmdB]),
      ]);

      assert.equal(a.exitCode, 0);
      assert.equal(b.exitCode, 0);

      assert.match(a.stdout, /A:out:ok/);
      assert.match(a.stderr, /A:err:ok/);
      assert.doesNotMatch(a.stdout, /B:/);
      assert.doesNotMatch(a.stderr, /B:/);

      assert.match(b.stdout, /B:out:ok/);
      assert.match(b.stderr, /B:err:ok/);
      assert.doesNotMatch(b.stdout, /A:/);
      assert.doesNotMatch(b.stderr, /A:/);
    });
  },
);

test(
  "exec output iterator yields stdout and stderr",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const proc = vm.exec(["/bin/sh", "-c", "echo out; echo err 1>&2"], {
        stdout: "pipe",
        stderr: "pipe",
      });

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
  },
);

test(
  "exec lines iterator yields stdout lines",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const proc = vm.exec(["/bin/sh", "-c", "printf 'one\ntwo\nthree'"], {
        stdout: "pipe",
      });
      const lines: string[] = [];

      for await (const line of proc.lines()) {
        lines.push(line);
      }

      await proc;
      assert.deepEqual(lines, ["one", "two", "three"]);
    });
  },
);

test(
  "shell runs commands without attaching",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();

      const proc = vm.shell({
        command: ["sh", "-c", "echo shell-ok"],
        attach: false,
      });

      let seen = "";
      for await (const chunk of proc) {
        seen += chunk;
      }

      const result = await proc;
      assert.equal(result.exitCode, 0);
      assert.equal(seen.trim(), "shell-ok");
    });
  },
);

test(
  "exec aborts with signal",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();
      const controller = new AbortController();
      const proc = vm.exec(["/bin/sh", "-c", "sleep 1"], {
        signal: controller.signal,
      });

      setTimeout(() => controller.abort(), 100);

      await assert.rejects(proc, /exec aborted/);
    });
  },
);

test(
  "pty exec completes even when background jobs keep the PTY open",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(execVmKey, execVmOptions, async (vm) => {
      await vm.start();

      // Run a short-lived main process that starts a long-lived background job
      // inheriting the PTY slave.
      const proc = vm.exec(
        ["/bin/sh", "-c", "sh -c 'trap \"\" HUP; sleep 1000' &"],
        {
          pty: true,
          stdout: "ignore",
          stderr: "ignore",
        },
      );

      // Ensure that if the test fails early (e.g. timeout) we don't leave a
      // late rejection from the exec session as an unhandledRejection.
      void proc.result.catch(() => {});

      const result = await Promise.race([
        proc.result,
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("timeout waiting for pty exec to exit")),
            8000,
          );
          t.unref();
          void proc.result.then(
            () => clearTimeout(t),
            () => clearTimeout(t),
          );
        }),
      ]);

      assert.equal(result.exitCode, 0);
    });
  },
);
