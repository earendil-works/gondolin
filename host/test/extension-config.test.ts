import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  tryLoadConfig,
  mergeConfigs,
  loadConfig,
} from "../extensions/config.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-test-"));
}

function writeJson(dir: string, name: string, data: unknown): string {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

// --- tryLoadConfig ---

test("tryLoadConfig returns empty for missing file", () => {
  const result = tryLoadConfig("/nonexistent/path/gondolin.json");
  assert.deepEqual(result, {});
});

test("tryLoadConfig loads valid config", () => {
  const dir = makeTmpDir();
  const p = writeJson(dir, "gondolin.json", {
    allowedHosts: ["example.net"],
    secrets: { API_KEY: { hosts: ["example.net"] } },
  });
  const result = tryLoadConfig(p);
  assert.deepEqual(result.allowedHosts, ["example.net"]);
  assert.deepEqual(result.secrets, { API_KEY: { hosts: ["example.net"] } });
  fs.rmSync(dir, { recursive: true });
});

test("tryLoadConfig returns empty for malformed JSON", () => {
  const dir = makeTmpDir();
  const p = path.join(dir, "gondolin.json");
  fs.writeFileSync(p, "not valid json {{{");
  const result = tryLoadConfig(p);
  assert.deepEqual(result, {});
  fs.rmSync(dir, { recursive: true });
});

test("tryLoadConfig returns empty for null JSON", () => {
  const dir = makeTmpDir();
  const p = path.join(dir, "gondolin.json");
  fs.writeFileSync(p, "null");
  const result = tryLoadConfig(p);
  assert.deepEqual(result, {});
  fs.rmSync(dir, { recursive: true });
});

// --- mergeConfigs: existing fields ---

test("mergeConfigs with two empty configs", () => {
  const result = mergeConfigs({}, {});
  assert.deepEqual(result.allowedHosts, []);
  assert.deepEqual(result.allowedInternalHosts, []);
  assert.deepEqual(result.secrets, {});
});

test("mergeConfigs combines allowedHosts from both", () => {
  const result = mergeConfigs(
    { allowedHosts: ["a.example"] },
    { allowedHosts: ["b.example"] },
  );
  assert.deepEqual(result.allowedHosts, ["a.example", "b.example"]);
});

test("mergeConfigs project secret overrides global for same key", () => {
  const result = mergeConfigs(
    { secrets: { KEY: { hosts: ["global.example"] } } },
    { secrets: { KEY: { hosts: ["project.example"] } } },
  );
  assert.deepEqual(result.secrets, { KEY: { hosts: ["project.example"] } });
});

test("mergeConfigs keeps distinct secrets from both", () => {
  const result = mergeConfigs(
    { secrets: { A: { hosts: ["a.example"] } } },
    { secrets: { B: { hosts: ["b.example"] } } },
  );
  assert.deepEqual(result.secrets, {
    A: { hosts: ["a.example"] },
    B: { hosts: ["b.example"] },
  });
});

test("mergeConfigs ignores malformed secret entries", () => {
  const result = mergeConfigs(
    {
      secrets: {
        GOOD: { hosts: ["a.example"] },
        BAD_STRING: "not an object" as unknown as { hosts: string[] },
        BAD_HOSTS: { hosts: [42] } as unknown as { hosts: string[] },
      },
    },
    {},
  );
  assert.deepEqual(result.secrets, { GOOD: { hosts: ["a.example"] } });
});

// --- mergeConfigs: new declarative fields ---

test("mergeConfigs combines allowedInternalHosts from both", () => {
  const result = mergeConfigs(
    { allowedInternalHosts: ["a.local"] },
    { allowedInternalHosts: ["b.local"] },
  );
  assert.deepEqual(result.allowedInternalHosts, ["a.local", "b.local"]);
});

test("mergeConfigs project scalar overrides global", () => {
  const result = mergeConfigs(
    { blockInternalRanges: true, memory: "1G", cpus: 2 },
    { blockInternalRanges: false, memory: "4G", cpus: 8 },
  );
  assert.equal(result.blockInternalRanges, false);
  assert.equal(result.memory, "4G");
  assert.equal(result.cpus, 8);
});

test("mergeConfigs omits undefined scalars", () => {
  const result = mergeConfigs({}, {});
  assert.equal(result.blockInternalRanges, undefined);
  assert.equal(result.memory, undefined);
  assert.equal(result.cpus, undefined);
  assert.equal(result.allowWebSockets, undefined);
  assert.equal(result.replaceSecretsInQuery, undefined);
});

test("mergeConfigs global scalar used when project omits", () => {
  const result = mergeConfigs(
    { allowWebSockets: false, replaceSecretsInQuery: true },
    {},
  );
  assert.equal(result.allowWebSockets, false);
  assert.equal(result.replaceSecretsInQuery, true);
});

// --- mergeConfigs: DNS ---

test("mergeConfigs dns project overrides global mode", () => {
  const result = mergeConfigs(
    { dns: { mode: "synthetic" } },
    { dns: { mode: "trusted", trustedServers: ["198.51.100.1"] } },
  );
  assert.equal(result.dns?.mode, "trusted");
  assert.deepEqual(result.dns?.trustedServers, ["198.51.100.1"]);
});

test("mergeConfigs dns omitted when neither sets it", () => {
  const result = mergeConfigs({}, {});
  assert.equal(result.dns, undefined);
});

// --- mergeConfigs: SSH ---

test("mergeConfigs ssh combines allowedHosts", () => {
  const result = mergeConfigs(
    { ssh: { allowedHosts: ["git.example"] } },
    { ssh: { allowedHosts: ["git2.example"] } },
  );
  assert.deepEqual(result.ssh?.allowedHosts, ["git.example", "git2.example"]);
});

test("mergeConfigs ssh agent true resolves to SSH_AUTH_SOCK", () => {
  const original = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = "/tmp/test-agent.sock";
  try {
    const result = mergeConfigs(
      { ssh: { allowedHosts: ["git.example"], agent: true } },
      {},
    );
    assert.equal(result.ssh?.agent, "/tmp/test-agent.sock");
  } finally {
    if (original !== undefined) {
      process.env.SSH_AUTH_SOCK = original;
    } else {
      delete process.env.SSH_AUTH_SOCK;
    }
  }
});

test("mergeConfigs ssh agent string used as literal path", () => {
  const result = mergeConfigs(
    { ssh: { allowedHosts: ["git.example"], agent: "/custom/agent.sock" } },
    {},
  );
  assert.equal(result.ssh?.agent, "/custom/agent.sock");
});

test("mergeConfigs ssh omitted when neither sets it", () => {
  const result = mergeConfigs({}, {});
  assert.equal(result.ssh, undefined);
});

// --- mergeConfigs: TCP ---

test("mergeConfigs tcp hosts merged, project overrides per key", () => {
  const result = mergeConfigs(
    { tcp: { hosts: { "a.local": "127.0.0.1:5432", "b.local": "127.0.0.1:6379" } } },
    { tcp: { hosts: { "a.local": "198.51.100.2:5432" } } },
  );
  assert.deepEqual(result.tcp, {
    hosts: { "a.local": "198.51.100.2:5432", "b.local": "127.0.0.1:6379" },
  });
});

test("mergeConfigs tcp omitted when neither sets it", () => {
  const result = mergeConfigs({}, {});
  assert.equal(result.tcp, undefined);
});

// --- loadConfig (end-to-end with filesystem) ---

test("loadConfig with no config files returns defaults", () => {
  const dir = makeTmpDir();
  const result = loadConfig(
    path.join(dir, "global.json"),
    path.join(dir, "project.json"),
  );
  assert.deepEqual(result.allowedHosts, []);
  assert.deepEqual(result.secrets, {});
  fs.rmSync(dir, { recursive: true });
});

test("loadConfig merges global and project files", () => {
  const dir = makeTmpDir();
  const g = writeJson(dir, "global.json", {
    allowedHosts: ["global.example"],
    memory: "1G",
    ssh: { allowedHosts: ["git.example"] },
  });
  const p = writeJson(dir, "project.json", {
    allowedHosts: ["project.example"],
    memory: "2G",
    ssh: { allowedHosts: ["git2.example"], agent: true },
  });
  const original = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = "/tmp/test.sock";
  try {
    const result = loadConfig(g, p);
    assert.deepEqual(result.allowedHosts, ["global.example", "project.example"]);
    assert.equal(result.memory, "2G");
    assert.deepEqual(result.ssh?.allowedHosts, ["git.example", "git2.example"]);
    assert.equal(result.ssh?.agent, "/tmp/test.sock");
  } finally {
    if (original !== undefined) {
      process.env.SSH_AUTH_SOCK = original;
    } else {
      delete process.env.SSH_AUTH_SOCK;
    }
  }
  fs.rmSync(dir, { recursive: true });
});
