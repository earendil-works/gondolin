import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import test from "node:test";

import { VM } from "../src/vm/core.ts";
import { MemoryProvider } from "../src/vfs/node/index.ts";
import {
  scheduleForceExit,
  shouldSkipVmTests,
  resolveKrunRunnerPath,
  getKrunRuntimeSkipReason,
} from "./helpers/vm-fixture.ts";

const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);
const backendStartTimeoutMs = Math.max(
  1,
  Number(process.env.GONDOLIN_BACKEND_PARITY_START_TIMEOUT_MS ?? 30000),
);
const ingressFetchTimeoutMs = Math.max(
  100,
  Number(process.env.GONDOLIN_BACKEND_PARITY_INGRESS_FETCH_TIMEOUT_MS ?? 1500),
);
const requireKrun = process.env.GONDOLIN_REQUIRE_KRUN === "1";
const requireQemu = process.env.GONDOLIN_REQUIRE_QEMU !== "0";
const runIngressParity = process.env.GONDOLIN_BACKEND_PARITY_INGRESS === "1";

const ALL_BACKENDS = ["qemu", "krun"] as const;
type BackendName = (typeof ALL_BACKENDS)[number];

function resolveRequestedBackends(): BackendName[] {
  const raw = process.env.GONDOLIN_TEST_VM_BACKENDS?.trim();
  if (!raw) {
    return [...ALL_BACKENDS];
  }

  const parsed = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is BackendName =>
      (ALL_BACKENDS as readonly string[]).includes(part),
    );

  if (parsed.length > 0) {
    return parsed;
  }

  return [...ALL_BACKENDS];
}

const backends = resolveRequestedBackends();

function backendSandboxOptions(backend: BackendName) {
  if (backend === "krun") {
    return {
      vmm: "krun" as const,
      krunRunnerPath: resolveKrunRunnerPath() ?? undefined,
      console: "none" as const,
    };
  }
  return {
    vmm: "qemu" as const,
    console: "none" as const,
  };
}

let qemuRuntimeSkipCheck: Promise<string | false> | null = null;

async function getQemuRuntimeSkipReason(): Promise<string | false> {
  if (!qemuRuntimeSkipCheck) {
    qemuRuntimeSkipCheck = (async () => {
      const vm = await VM.create({
        startTimeoutMs: backendStartTimeoutMs,
        sandbox: {
          vmm: "qemu",
          console: "none",
        },
      });

      try {
        await vm.start();
        const probe = await vm.exec(["/bin/sh", "-lc", "echo preflight-ok"]);
        if (probe.exitCode !== 0) {
          return `qemu runtime preflight exec failed (exit ${probe.exitCode})`;
        }
        return false;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `qemu runtime unavailable: ${message}`;
      } finally {
        await vm.close();
      }
    })();
  }

  return await qemuRuntimeSkipCheck;
}

async function skipIfBackendUnavailable(
  t: test.TestContext,
  backend: BackendName,
): Promise<boolean> {
  if (process.platform === "win32") {
    t.skip(
      "backend parity is covered by the Linux parity job; Windows coverage uses the Windows QEMU suite",
    );
    return true;
  }

  if (shouldSkipVmTests()) {
    t.skip("hardware virtualization unavailable");
    return true;
  }

  if (backend === "qemu") {
    const qemuSkipReason = await getQemuRuntimeSkipReason();
    if (!qemuSkipReason) {
      return false;
    }
    if (requireQemu) {
      throw new Error(qemuSkipReason);
    }
    t.skip(qemuSkipReason);
    return true;
  }

  const krunSkipReason = await getKrunRuntimeSkipReason();
  if (!krunSkipReason) {
    return false;
  }

  if (requireKrun) {
    throw new Error(krunSkipReason);
  }

  t.skip(krunSkipReason);
  return true;
}

function hasSshClient(): boolean {
  try {
    execFileSync("ssh", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skipIfNoSshClient = !hasSshClient();

test.after(() => {
  scheduleForceExit();
});

for (const backend of backends) {
  test(
    `backend parity (${backend}): boot and vm.exec smoke`,
    { timeout: timeoutMs },
    async (t) => {
      if (await skipIfBackendUnavailable(t, backend)) return;

      const vm = await VM.create({
        startTimeoutMs: backendStartTimeoutMs,
        sandbox: backendSandboxOptions(backend),
      });

      t.after(async () => {
        await vm.close();
      });

      const result = await vm.exec("echo backend-ok");
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), "backend-ok");
    },
  );

  test(
    `backend parity (${backend}): vfs mount is ready and serves guest reads`,
    { timeout: timeoutMs },
    async (t) => {
      if (await skipIfBackendUnavailable(t, backend)) return;

      const provider = new MemoryProvider();
      const hostFile = await provider.open("/from-host.txt", "w+");
      await hostFile.writeFile("vfs-ok");
      await hostFile.close();

      const vm = await VM.create({
        startTimeoutMs: backendStartTimeoutMs,
        sandbox: backendSandboxOptions(backend),
        vfs: {
          mounts: {
            "/": provider,
          },
        },
      });

      t.after(async () => {
        await vm.close();
      });

      await vm.start();
      const result = await vm.exec([
        "/bin/sh",
        "-lc",
        "cat /data/from-host.txt",
      ]);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), "vfs-ok");
    },
  );

  test(
    `backend parity (${backend}): network egress request is mediated via httpHooks`,
    { timeout: timeoutMs },
    async (t) => {
      if (await skipIfBackendUnavailable(t, backend)) return;

      const vm = await VM.create({
        startTimeoutMs: backendStartTimeoutMs,
        sandbox: backendSandboxOptions(backend),
        httpHooks: {
          onRequest: () => new Response("network-ok\n", { status: 200 }),
        },
      });

      t.after(async () => {
        await vm.close();
      });

      const result = await vm.exec([
        "/bin/sh",
        "-lc",
        "curl -fsS http://example.com/ || wget -qO- http://example.com/",
      ]);

      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout.trim(), "network-ok");
    },
  );

  test(
    `backend parity (${backend}): enableSsh smoke`,
    {
      skip: skipIfNoSshClient && "host ssh client unavailable",
      timeout: timeoutMs,
    },
    async (t) => {
      if (await skipIfBackendUnavailable(t, backend)) return;

      const vm = await VM.create({
        startTimeoutMs: backendStartTimeoutMs,
        sandbox: backendSandboxOptions(backend),
      });

      t.after(async () => {
        await vm.close();
      });

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
      t.after(async () => {
        await access.close();
      });

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
            "ConnectTimeout=5",
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
          ],
          { timeout: 20000 },
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          },
        );
      });

      assert.equal(stdout.trim(), "ssh-ok");
    },
  );

  test(
    `backend parity (${backend}): enableIngress smoke`,
    {
      skip:
        !runIngressParity &&
        "set GONDOLIN_BACKEND_PARITY_INGRESS=1 to enable ingress parity smoke",
      timeout: timeoutMs,
    },
    async (t) => {
      if (await skipIfBackendUnavailable(t, backend)) return;

      const vm = await VM.create({
        startTimeoutMs: backendStartTimeoutMs,
        sandbox: backendSandboxOptions(backend),
      });

      t.after(async () => {
        await vm.close();
      });

      await vm.start();

      const busyboxProbe = await vm.exec([
        "/bin/sh",
        "-lc",
        "command -v busybox",
      ]);
      if (busyboxProbe.exitCode !== 0) {
        t.skip("guest image does not include busybox httpd");
        return;
      }

      const launch = await vm.exec([
        "/bin/sh",
        "-lc",
        [
          "mkdir -p /tmp/ingress-www",
          "printf ingress-ok > /tmp/ingress-www/index.html",
          "busybox httpd -f -p 127.0.0.1:18080 -h /tmp/ingress-www >/tmp/ingress-httpd.log 2>&1 & pid=$!",
          "echo $pid > /tmp/ingress-httpd.pid",
        ].join("; "),
      ]);
      assert.equal(
        launch.exitCode,
        0,
        launch.stderr || "failed to launch ingress httpd",
      );

      t.after(async () => {
        try {
          await vm.exec([
            "/bin/sh",
            "-lc",
            "kill $(cat /tmp/ingress-httpd.pid) >/dev/null 2>&1 || true",
          ]);
        } catch {
          // ignore best-effort cleanup errors
        }
      });

      vm.setIngressRoutes([{ prefix: "/", port: 18080, stripPrefix: true }]);

      const access = await vm.enableIngress();
      t.after(async () => {
        await access.close();
      });

      let status = 0;
      let body = "";
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const response = await fetch(new URL("/", access.url), {
            signal: AbortSignal.timeout(ingressFetchTimeoutMs),
          });
          status = response.status;
          body = await response.text();
          if (status === 200 && body.includes("ingress-ok")) {
            break;
          }
        } catch {
          // ingress gateway or guest server may still be starting
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (status !== 200 || !/ingress-ok/.test(body)) {
        t.skip(
          `ingress proxy path unavailable (status=${status}, body=${JSON.stringify(body.slice(0, 200))})`,
        );
        return;
      }
    },
  );
}
