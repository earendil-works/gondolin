import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { VM } from "../src/vm/core.ts";
import {
  scheduleForceExit,
  shouldSkipVmTests,
} from "./helpers/vm-fixture.ts";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);
const ingressFetchTimeoutMs = 5000;
const payloadSizeBytes = 900_000;
const repoGuestAssetsDir = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "guest",
  "image",
  "out",
);
const missingRepoGuestAssetsReason =
  !fs.existsSync(path.join(repoGuestAssetsDir, "manifest.json"))
    ? "repo guest assets missing (run make build or make -C guest assets)"
    : false;

type CapturedHttpResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  complete: boolean;
  aborted: boolean;
  responseErrorMessage: string | null;
};

function buildDeterministicPayload(length: number): Buffer {
  const payload = Buffer.allocUnsafe(length);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 31) % 251;
  }
  return payload;
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fetchCapturedHttpResponse(
  targetUrl: URL,
): Promise<CapturedHttpResponse> {
  return await new Promise<CapturedHttpResponse>((resolve, reject) => {
    const request = http.get(targetUrl, (response) => {
      const chunks: Buffer[] = [];
      let aborted = false;
      let responseErrorMessage: string | null = null;

      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once("aborted", () => {
        aborted = true;
      });
      response.once("error", (error) => {
        responseErrorMessage = error.message;
      });
      response.once("close", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
          complete: response.complete,
          aborted,
          responseErrorMessage,
        });
      });
    });

    request.setTimeout(ingressFetchTimeoutMs, () => {
      request.destroy(new Error("timed out waiting for ingress response"));
    });
    request.once("error", (error) => {
      reject(error);
    });
  });
}

async function waitForGuestHttpServer(
  vm: VM,
  expectedBodyLength: number,
): Promise<void> {
  let lastStdout = "";
  let lastStderr = "";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = await vm.exec([
      "/bin/sh",
      "-lc",
      [
        "rm -f /tmp/ingress-large-probe.bin",
        "busybox wget -qO /tmp/ingress-large-probe.bin http://127.0.0.1:18080/asset.bin",
        "wc -c < /tmp/ingress-large-probe.bin",
      ].join("; "),
    ]);

    lastStdout = probe.stdout.trim();
    lastStderr = probe.stderr.trim();
    if (probe.exitCode === 0 && lastStdout === String(expectedBodyLength)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `guest http server never served the expected payload (stdout=${JSON.stringify(lastStdout)}, stderr=${JSON.stringify(lastStderr)})`,
  );
}

async function resolveGuestHttpServerLaunchCommand(vm: VM): Promise<string | null> {
  const probe = await vm.exec([
    "/bin/sh",
    "-lc",
    [
      "if command -v python3 >/dev/null 2>&1; then",
      "  echo 'python3 -m http.server 18080 --bind 127.0.0.1 --directory /tmp/ingress-large-www';",
      "elif command -v python >/dev/null 2>&1; then",
      "  echo 'python -m http.server 18080 --bind 127.0.0.1 --directory /tmp/ingress-large-www';",
      "elif busybox --list 2>/dev/null | grep -qx httpd; then",
      "  echo 'busybox httpd -f -p 127.0.0.1:18080 -h /tmp/ingress-large-www';",
      "else",
      "  exit 1;",
      "fi",
    ].join(" "),
  ]);

  if (probe.exitCode !== 0) {
    return null;
  }

  return probe.stdout.trim() || null;
}

test.after(() => {
  scheduleForceExit();
});

test(
  "ingress forwards full large fixed-length responses (issue #86)",
  {
    skip: skipVmTests || missingRepoGuestAssetsReason,
    timeout: timeoutMs,
  },
  async (t) => {
    const vm = await VM.create({
      sandbox: {
        console: "none",
        imagePath: repoGuestAssetsDir,
      },
    });

    let access: Awaited<ReturnType<VM["enableIngress"]>> | null = null;
    t.after(async () => {
      if (access) {
        await access.close();
      }

      try {
        await vm.exec([
          "/bin/sh",
          "-lc",
          "kill $(cat /tmp/ingress-large-httpd.pid) >/dev/null 2>&1 || true",
        ]);
      } catch {
        // best-effort cleanup
      }

      await vm.close();
    });

    await vm.start();

    const guestHttpServerLaunchCommand =
      await resolveGuestHttpServerLaunchCommand(vm);
    if (!guestHttpServerLaunchCommand) {
      t.skip("guest image does not include a supported local HTTP server");
      return;
    }

    const payload = buildDeterministicPayload(payloadSizeBytes);
    const expectedDigest = sha256Hex(payload);

    await vm.fs.mkdir("/tmp/ingress-large-www", { recursive: true });
    await vm.fs.writeFile("/tmp/ingress-large-www/asset.bin", payload);

    const launch = await vm.exec([
      "/bin/sh",
      "-lc",
      [
        `${guestHttpServerLaunchCommand} >/tmp/ingress-large-httpd.log 2>&1 & pid=$!`,
        "echo $pid > /tmp/ingress-large-httpd.pid",
      ].join("; "),
    ]);
    assert.equal(
      launch.exitCode,
      0,
      launch.stderr || "failed to launch ingress httpd",
    );

    await waitForGuestHttpServer(vm, payload.length);

    vm.setIngressRoutes([{ prefix: "/", port: 18080, stripPrefix: true }]);
    access = await vm.enableIngress();

    let response: CapturedHttpResponse | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        response = await fetchCapturedHttpResponse(
          new URL("/asset.bin", access.url),
        );
        if (response.statusCode === 200) {
          break;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!response && lastError) {
      throw lastError;
    }

    assert.ok(response, "expected ingress response");
    assert.equal(
      response.statusCode,
      200,
      `unexpected ingress status with ${response.body.length} bytes received`,
    );
    assert.equal(response.headers["content-length"], String(payload.length));
    assert.equal(response.aborted, false, "response should not abort");
    assert.equal(response.complete, true, "response should complete cleanly");
    assert.equal(
      response.responseErrorMessage,
      null,
      "response should not emit an error",
    );
    assert.equal(
      response.body.length,
      payload.length,
      "ingress should deliver every response byte",
    );
    assert.equal(
      sha256Hex(response.body),
      expectedDigest,
      "ingress response body should match the guest payload",
    );
  },
);
