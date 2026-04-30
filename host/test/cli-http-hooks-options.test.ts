import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../bin/gondolin.ts";

function makeCommonOptions(overrides: Record<string, unknown> = {}) {
  return {
    mounts: [],
    memoryMounts: [],
    allowedHosts: [],
    secrets: [],
    dnsTrustedServers: [],
    tcpHostMappings: {},
    sshAllowedHosts: [],
    sshCredentials: [],
    sshAgent: undefined,
    sshKnownHostsFiles: [],
    ...overrides,
  };
}

test("buildVmOptions keeps implicit open egress for host secrets without --allow-host", async () => {
  const vmOptions = __test.buildVmOptions(
    makeCommonOptions({
      secrets: [
        {
          name: "API_KEY",
          hosts: ["example.com"],
          value: "secret-value",
        },
      ],
    }) as any,
  );

  assert.ok(vmOptions.httpHooks);
  assert.deepEqual(vmOptions.env, {
    API_KEY: vmOptions.env.API_KEY,
  });
  assert.match(vmOptions.env.API_KEY, /^GONDOLIN_SECRET_/);
  assert.equal(
    await vmOptions.httpHooks.isIpAllowed({
      hostname: "unrelated.example",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );
});

test("buildVmOptions still honors explicit global allowlists", async () => {
  const vmOptions = __test.buildVmOptions(
    makeCommonOptions({
      allowedHosts: ["api.example.com"],
      secrets: [
        {
          name: "API_KEY",
          hosts: ["example.com"],
          value: "secret-value",
        },
      ],
    }) as any,
  );

  assert.ok(vmOptions.httpHooks);
  assert.equal(
    await vmOptions.httpHooks.isIpAllowed({
      hostname: "api.example.com",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );
  assert.equal(
    await vmOptions.httpHooks.isIpAllowed({
      hostname: "example.com",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false,
  );
});
