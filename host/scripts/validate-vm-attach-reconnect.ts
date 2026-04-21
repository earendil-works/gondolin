import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import { VM } from "../src/vm/core.ts";
import { __test as serverOptionsTest } from "../src/sandbox/server-options.ts";
import { shouldSkipVmTests } from "../test/helpers/vm-fixture.ts";

function resolveHelperPath(): string {
  return path.resolve(import.meta.dirname, "..", "test", "helpers", "vm-attach-helper.ts");
}

function waitForLine(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const onStdout = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;

      cleanup();
      resolve(stdout.slice(0, newline));
    };

    const onStderr = (chunk: Buffer | string) => {
      stderr += chunk.toString();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `helper exited before announcing vm id (code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()})`,
        ),
      );
    };

    const cleanup = () => {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("exit", onExit);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

function disposeChildStreams(child: ReturnType<typeof spawn>): void {
  try {
    child.stdout?.destroy();
  } catch {
    // ignore
  }
  try {
    child.stderr?.destroy();
  } catch {
    // ignore
  }
}

function listenLocalServer(): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/plain\r\n" +
          "Content-Length: 9\r\n" +
          "Connection: close\r\n\r\n" +
          "attach-ok",
      );
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind local test server"));
        return;
      }
      resolve({
        port: address.port,
        close: async () =>
          await new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function main(): Promise<void> {
  if (shouldSkipVmTests()) {
    throw new Error("hardware virtualization unavailable");
  }

  const qemuBinary = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  if (!(serverOptionsTest as any).qemuSupportsReconnect(qemuBinary)) {
    throw new Error(`${qemuBinary} does not support reconnect-ms`);
  }

  const httpServer = await listenLocalServer();
  let attachedVm: VM | null = null;
  const helper = spawn(process.execPath, [resolveHelperPath(), String(httpServer.port)], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const line = await waitForLine(helper);
    const announced = JSON.parse(line) as { id: string };
    assert.ok(typeof announced.id === "string" && announced.id.length > 0);
    console.log(`helper vm id: ${announced.id}`);

    helper.kill("SIGKILL");
    await waitForExit(helper);
    disposeChildStreams(helper);

    attachedVm = await VM.attach({
      id: announced.id,
      sandbox: {
        console: "none",
        dns: {
          mode: "synthetic",
          syntheticHostMapping: "per-host",
        },
        tcp: {
          hosts: {
            "local.test:8080": `127.0.0.1:${httpServer.port}`,
          },
        },
      },
      vfs: null,
    });

    await attachedVm.start();

    const marker = await attachedVm.exec(["/bin/cat", "/tmp/reconnect-marker"]);
    assert.equal(marker.exitCode, 0);
    assert.equal(marker.stdout.trim(), "reconnect-ok");

    const pidRead = await attachedVm.exec(["/bin/cat", "/tmp/reconnect-worker.pid"]);
    assert.equal(pidRead.exitCode, 0);
    const workerPid = pidRead.stdout.trim();
    assert.match(workerPid, /^[0-9]+$/u);

    const workerAlive = await attachedVm.exec([
      "/bin/sh",
      "-lc",
      `kill -0 ${workerPid}`,
    ]);
    assert.equal(workerAlive.exitCode, 0);

    const networkProbe = await attachedVm.exec([
      "/bin/sh",
      "-lc",
      "curl -fsS http://local.test:8080/ || wget -qO- http://local.test:8080/",
    ]);
    assert.equal(networkProbe.exitCode, 0);
    assert.equal(networkProbe.stdout.trim(), "attach-ok");

    console.log("reconnect validation passed");
  } finally {
    if (attachedVm) {
      await attachedVm.close().catch(() => undefined);
    }
    helper.kill("SIGKILL");
    await waitForExit(helper);
    disposeChildStreams(helper);
    await httpServer.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
