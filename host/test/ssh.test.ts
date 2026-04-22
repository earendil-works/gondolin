import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import test from "node:test";

import {
  closeVm,
  withVm,
  shouldSkipVmTests,
  scheduleForceExit,
} from "./helpers/vm-fixture.ts";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);
const sshVmKey = "ssh-default";
const sshConnectTimeoutSeconds = process.platform === "win32" ? 10 : 5;
const sshExecTimeoutMs = process.platform === "win32" ? 15000 : 10000;
const sshRetryWindowMs = process.platform === "win32" ? 45000 : 15000;

function hasSshClient(): boolean {
  try {
    execFileSync("ssh", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skipIfNoSsh = !hasSshClient();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSshCommand(args: string[]): Promise<string> {
  const deadline = Date.now() + sshRetryWindowMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await new Promise<string>((resolve, reject) => {
        execFile(
          "ssh",
          args,
          { timeout: sshExecTimeoutMs },
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          },
        );
      });
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

test.after(async () => {
  await closeVm(sshVmKey);
  scheduleForceExit();
});

test(
  "enableSsh exposes a localhost port that can run ssh commands",
  { skip: skipVmTests || skipIfNoSsh, timeout: timeoutMs },
  async (t) => {
    await withVm(
      sshVmKey,
      {
        sandbox: { console: "none" },
      },
      async (vm) => {
        await vm.start();

        const probe = await vm.exec([
          "sh",
          "-c",
          "command -v sshd >/dev/null 2>&1 && command -v sandboxssh >/dev/null 2>&1 && ps | grep -q '[s]andboxssh'",
        ]);
        if (probe.exitCode !== 0) {
          t.skip(
            "guest image does not include sshd/sandboxssh or sandboxssh is not running",
          );
          return;
        }

        const access = await vm.enableSsh();

        const stdout = await runSshCommand([
          "-p",
          String(access.port),
          "-i",
          access.identityFile,
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "BatchMode=yes",
          "-o",
          `ConnectTimeout=${sshConnectTimeoutSeconds}`,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "ForwardAgent=no",
          "-o",
          "ClearAllForwardings=yes",
          "-o",
          "LogLevel=ERROR",
          `${access.user}@${access.host}`,
          "echo",
          "ssh-ok",
        ]);

        assert.equal(stdout.trim(), "ssh-ok");

        await access.close();
      },
    );
  },
);
