import assert from "node:assert/strict";
import test from "node:test";

import {
  closeVm,
  scheduleForceExit,
  shouldSkipVmTests,
  withVm,
} from "./helpers/vm-fixture.ts";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);
const vmKey = "ingress-issue-86";

test.after(async () => {
  await closeVm(vmKey);
  scheduleForceExit();
});

test(
  "ingress does not truncate responses at 772251-byte boundary (issue #86)",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(
      vmKey,
      {
        sandbox: { console: "none" },
      },
      async (vm) => {
        await vm.start();

        const ceilingSize = 772_251;
        const largeSize = 795_946;

        const setup = await vm.exec([
          "sh",
          "-lc",
          [
            "set -e",
            "mkdir -p /tmp/ingress-www/assets",
            `head -c ${ceilingSize} /dev/zero > /tmp/ingress-www/assets/exact.css`,
            `head -c ${largeSize} /dev/zero > /tmp/ingress-www/assets/large.js`,
            "python3 -m http.server 18789 --bind 127.0.0.1 --directory /tmp/ingress-www >/tmp/ingress-httpd.log 2>&1 &",
            "echo $! > /tmp/ingress-httpd.pid",
          ].join("\n"),
        ]);
        assert.equal(
          setup.exitCode,
          0,
          setup.stderr || "failed to launch ingress test http server",
        );

        const waitForDirectSize = async (path: string, expected: number) => {
          let size: number | null = null;
          let lastErr = "";
          for (let i = 0; i < 40; i += 1) {
            const direct = await vm.exec([
              "sh",
              "-lc",
              `curl -sS -o /dev/null -w '%{size_download}' http://127.0.0.1:18789${path}`,
            ]);
            if (direct.exitCode === 0) {
              size = Number(direct.stdout.trim());
              break;
            }
            lastErr = direct.stderr;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.equal(size, expected, lastErr || `direct curl failed for ${path}`);
        };

        await waitForDirectSize("/assets/exact.css", ceilingSize);
        await waitForDirectSize("/assets/large.js", largeSize);

        await vm.setIngressRoutes([
          {
            prefix: "/",
            port: 18789,
            stripPrefix: true,
          },
        ]);

        const ingress = await vm.enableIngress({
          bufferResponseBody: true,
          maxBufferedResponseBodyBytes: 100 * 1024 * 1024,
        });

        try {
          const exactResponse = await fetch(`${ingress.url}/assets/exact.css`, {
            signal: AbortSignal.timeout(20000),
          });
          const exactBody = Buffer.from(await exactResponse.arrayBuffer());
          assert.equal(exactResponse.status, 200);
          assert.equal(
            Number(exactResponse.headers.get("content-length")),
            ceilingSize,
          );
          assert.equal(exactBody.length, ceilingSize);

          const largeResponse = await fetch(`${ingress.url}/assets/large.js`, {
            signal: AbortSignal.timeout(20000),
          });
          const largeBody = Buffer.from(await largeResponse.arrayBuffer());
          assert.equal(largeResponse.status, 200);
          assert.equal(
            Number(largeResponse.headers.get("content-length")),
            largeSize,
          );
          assert.equal(largeBody.length, largeSize);
          assert.notEqual(
            largeBody.length,
            ceilingSize,
            "large response must not be capped at 772251 bytes",
          );
        } finally {
          await ingress.close();
          await vm.exec([
            "sh",
            "-lc",
            "kill $(cat /tmp/ingress-httpd.pid) >/dev/null 2>&1 || true",
          ]);
        }
      },
    );
  },
);
