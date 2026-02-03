import assert from "node:assert/strict";
import test from "node:test";

import { VM } from "../src/vm";
import { HttpRequestBlockedError } from "../src/qemu-net";

const url = process.env.WS_URL;
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 15000);
const httpUrl = process.env.WS_HTTP_URL ?? "http://icanhazip.com";
const httpsUrl = process.env.WS_HTTPS_URL ?? "https://icanhazip.com";
const token = process.env.ELWING_TOKEN ?? process.env.SANDBOX_WS_TOKEN;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("timeout waiting for response"));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertFetchOutput(output: string, stderr: string) {
  const lines = output.trim().split("\n");
  const httpIndex = lines.findIndex((line) => line.trim() === "HTTP");
  const httpsIndex = lines.findIndex((line) => line.trim() === "HTTPS");
  if (httpIndex === -1 || httpsIndex === -1) {
    const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
    assert.fail(`missing http/https output: ${output.trim()}${detail}`);
  }
  const httpValue = lines[httpIndex + 1]?.trim();
  const httpsValue = lines[httpsIndex + 1]?.trim();
  if (!httpValue || !httpsValue) {
    const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
    assert.fail(`empty http/https response: ${output.trim()}${detail}`);
  }
}

test("ws http/https fetch", { timeout: timeoutMs }, async () => {
  const vm = new VM({ url: url ?? undefined, token: token ?? undefined });

  try {
    const result = await withTimeout(
      vm.exec([
        "python3",
        "-c",
        `import sys,urllib.request;\n` +
          `print('HTTP');\n` +
          `print(urllib.request.urlopen('${httpUrl}', timeout=10).read().decode().strip());\n` +
          `print('HTTPS');\n` +
          `print(urllib.request.urlopen('${httpsUrl}', timeout=10).read().decode().strip());\n`,
      ]),
      timeoutMs
    );

    const output = result.stdout.toString();
    const stderr = result.stderr.toString();

    assert.equal(
      result.exitCode,
      0,
      stderr.trim() ? `unexpected exit code: ${result.exitCode}\n${stderr.trim()}` : undefined
    );

    assertFetchOutput(output, stderr);
  } finally {
    await vm.stop();
  }
});

test("ws fetch hook blocks requests", { timeout: timeoutMs, skip: Boolean(url) }, async () => {
  const baseFetch = fetch;
  const vm = new VM({
    token: token ?? undefined,
    fetch: async (input, init) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const hostname = new URL(target).hostname;
      if (hostname !== "example.com") {
        throw new HttpRequestBlockedError("blocked by test", 451, "Blocked");
      }
      return baseFetch(input, init);
    },
  });

  try {
    const script = [
      "import urllib.request, urllib.error",
      "def fetch(url):",
      "    try:",
      "        return urllib.request.urlopen(url, timeout=10).read().decode('utf-8', 'ignore')",
      "    except urllib.error.HTTPError as e:",
      "        return f'HTTP {e.code}'",
      "    except Exception as e:",
      "        return f'ERROR {type(e).__name__}'",
      "print('EXAMPLE_COM')",
      "print('OK' if 'Example Domain' in fetch('http://example.com') else 'BAD')",
      "print('EXAMPLE_ORG')",
      "print(fetch('http://example.org'))",
    ].join("\n");

    const result = await withTimeout(
      vm.exec(["python3", "-c", script]),
      timeoutMs
    );

    const output = result.stdout.toString().trim().split("\n");
    const stderr = result.stderr.toString();

    assert.equal(
      result.exitCode,
      0,
      stderr.trim() ? `unexpected exit code: ${result.exitCode}\n${stderr.trim()}` : undefined
    );

    const exampleComIndex = output.indexOf("EXAMPLE_COM");
    const exampleOrgIndex = output.indexOf("EXAMPLE_ORG");

    assert.notEqual(exampleComIndex, -1, `missing EXAMPLE_COM output: ${output.join("\n")}`);
    assert.notEqual(exampleOrgIndex, -1, `missing EXAMPLE_ORG output: ${output.join("\n")}`);
    assert.equal(output[exampleComIndex + 1], "OK");
    assert.equal(output[exampleOrgIndex + 1], "HTTP 451");
  } finally {
    await vm.stop();
  }
});

test("ws isAllowed blocks private ipv4", { timeout: timeoutMs, skip: Boolean(url) }, async () => {
  const isPrivateIPv4 = (ip: string) => {
    const parts = ip.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return false;
  };

  const seenIps: string[] = [];
  const vm = new VM({
    token: token ?? undefined,
    httpHooks: {
      isAllowed: (info) => {
        seenIps.push(info.ip);
        return !isPrivateIPv4(info.ip);
      },
    },
  });

  try {
    const script = [
      "import urllib.request, urllib.error",
      "def fetch(url):",
      "    try:",
      "        return urllib.request.urlopen(url, timeout=5).read().decode('utf-8', 'ignore')",
      "    except urllib.error.HTTPError as e:",
      "        return f'HTTP {e.code}'",
      "    except Exception as e:",
      "        return f'ERROR {type(e).__name__}'",
      "print('PRIVATE_GW')",
      "print(fetch('http://192.168.127.1'))",
      "print('PRIVATE_10')",
      "print(fetch('http://10.0.0.1'))",
    ].join("\n");

    const result = await withTimeout(vm.exec(["python3", "-c", script]), timeoutMs);

    const output = result.stdout.toString().trim().split("\n");
    const stderr = result.stderr.toString();

    assert.equal(
      result.exitCode,
      0,
      stderr.trim() ? `unexpected exit code: ${result.exitCode}\n${stderr.trim()}` : undefined
    );

    const gwIndex = output.indexOf("PRIVATE_GW");
    const privateIndex = output.indexOf("PRIVATE_10");

    assert.notEqual(gwIndex, -1, `missing PRIVATE_GW output: ${output.join("\n")}`);
    assert.notEqual(privateIndex, -1, `missing PRIVATE_10 output: ${output.join("\n")}`);
    assert.equal(output[gwIndex + 1], "HTTP 403");
    assert.equal(output[privateIndex + 1], "HTTP 403");
    assert.ok(seenIps.includes("192.168.127.1"), `missing 192.168.127.1 in isAllowed: ${seenIps.join(", ")}`);
    assert.ok(seenIps.includes("10.0.0.1"), `missing 10.0.0.1 in isAllowed: ${seenIps.join(", ")}`);
  } finally {
    await vm.stop();
  }
});
