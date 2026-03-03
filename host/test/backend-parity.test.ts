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
const requireKrun = process.env.GONDOLIN_REQUIRE_KRUN === "1";

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

async function skipIfBackendUnavailable(
  t: test.TestContext,
  backend: BackendName,
): Promise<boolean> {
  if (shouldSkipVmTests()) {
    t.skip("hardware virtualization unavailable");
    return true;
  }

  if (backend !== "krun") {
    return false;
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
        sandbox: backendSandboxOptions(backend),
        rootfs: {
          mode: "readonly",
        },
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
        sandbox: backendSandboxOptions(backend),
        rootfs: {
          mode: "readonly",
        },
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
        sandbox: backendSandboxOptions(backend),
        rootfs: {
          mode: "readonly",
        },
        httpHooks: {
          onRequest: (request: Request) => {
            const url = new URL(request.url);
            if (url.hostname === "backend-parity.local") {
              return new Response("network-ok\n", { status: 200 });
            }
          },
        },
      });

      t.after(async () => {
        await vm.close();
      });

      const result = await vm.exec([
        "/bin/sh",
        "-lc",
        [
          "if command -v curl >/dev/null 2>&1; then",
          "  curl -fsS http://backend-parity.local/",
          "elif command -v wget >/dev/null 2>&1; then",
          "  wget -qO- http://backend-parity.local/",
          "else",
          "  echo 'curl or wget is required' >&2",
          "  exit 127",
          "fi",
        ].join(" "),
      ]);

      assert.equal(result.exitCode, 0);
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
        sandbox: backendSandboxOptions(backend),
        rootfs: {
          mode: "readonly",
        },
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
    { timeout: timeoutMs },
    async (t) => {
      if (await skipIfBackendUnavailable(t, backend)) return;

      const vm = await VM.create({
        sandbox: backendSandboxOptions(backend),
        rootfs: {
          mode: "readonly",
        },
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
          "busybox httpd -f -p 127.0.0.1:18080 -h /tmp/ingress-www >/tmp/ingress-httpd.log 2>&1 &",
          "echo $! > /tmp/ingress-httpd.pid",
        ].join(" && "),
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
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const response = await fetch(new URL("/", access.url), {
            signal: AbortSignal.timeout(5000),
          });
          status = response.status;
          body = await response.text();
          if (status === 200 && body.includes("ingress-ok")) {
            break;
          }
        } catch {
          // ingress gateway or guest server may still be starting
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.equal(status, 200);
      assert.match(body, /ingress-ok/);
    },
  );
}
