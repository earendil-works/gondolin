import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import test from "node:test";

import { closeVm, withVm, shouldSkipVmTests, scheduleForceExit } from "./helpers/vm-fixture";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 60000);
const sshVmKey = "ssh-default";

function hasSshClient(): boolean {
  try {
    execFileSync("ssh", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skipIfNoSsh = !hasSshClient();

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
          t.skip("guest image does not include sshd/sandboxssh or sandboxssh is not running");
          return;
        }

        const access = await vm.enableSsh();

        const stdout = await new Promise<string>((resolve, reject) => {
          execFile(
            "ssh",
            [
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
              "LogLevel=ERROR",
              `${access.user}@${access.host}`,
              "echo",
              "ssh-ok",
            ],
            { timeout: 20000 },
            (err, stdout) => {
              if (err) reject(err);
              else resolve(stdout);
            }
          );
        });

        assert.equal(stdout.trim(), "ssh-ok");

        await access.close();
      }
    );
  }
);
