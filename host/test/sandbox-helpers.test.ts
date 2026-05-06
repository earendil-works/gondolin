import assert from "node:assert/strict";
import child_process from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Architecture } from "../src/build/config.ts";
import {
  SANDBOX_HELPER_BINARY_NAMES,
  __test,
  computeSandboxHelperBuildId,
  ensureSandboxHelperBinaries,
  type SandboxHelperChecksums,
  type SandboxHelperManifest,
} from "../src/build/sandbox-helpers.ts";

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function makeChecksums(value: string): SandboxHelperChecksums {
  const checksums = {} as SandboxHelperChecksums;
  for (const name of SANDBOX_HELPER_BINARY_NAMES) {
    checksums[name] = value;
  }
  return checksums;
}

function createHelperBundle(
  dir: string,
  arch: Architecture,
  gondolinVersion: string,
): {
  manifest: SandboxHelperManifest;
  buildId: string;
} {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const checksums = {} as SandboxHelperChecksums;
  for (const name of SANDBOX_HELPER_BINARY_NAMES) {
    const content = `#!/bin/sh\necho ${name}-${arch}\n`;
    const filePath = path.join(binDir, name);
    fs.writeFileSync(filePath, content, { mode: 0o755 });
    checksums[name] = sha256(content);
  }

  const manifest: SandboxHelperManifest = {
    schema: 1,
    kind: "gondolin-sandbox-helpers",
    gondolinVersion,
    sourceRef: "test-ref",
    arch,
    target: arch === "aarch64" ? "aarch64-linux-musl" : "x86_64-linux-musl",
    zigVersion: "0.16.0",
    checksums,
  };
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return {
    manifest,
    buildId: computeSandboxHelperBuildId({ arch, checksums }),
  };
}

function createHelperArchive(bundleDir: string, tmpDir: string): {
  archivePath: string;
  data: Buffer;
  sha256: string;
} {
  const archivePath = path.join(tmpDir, "helpers.tar.gz");
  child_process.execFileSync(
    "tar",
    ["-czf", archivePath, "manifest.json", "bin"],
    { cwd: bundleDir, stdio: "pipe" },
  );
  const data = fs.readFileSync(archivePath);
  return { archivePath, data, sha256: sha256(data) };
}

function restoreFetch(prevFetch: typeof globalThis.fetch): void {
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = prevFetch;
}

test("sandbox helpers: registry parser normalizes refs and sources", () => {
  const checksums = makeChecksums("a".repeat(64));
  const buildId = computeSandboxHelperBuildId({ arch: "aarch64", checksums });

  const parsed = __test.parseBuiltinSandboxHelperRegistry(
    {
      schema: 1,
      refs: {
        "gondolin:1.2.3": {
          arm64: buildId,
        },
      },
      builds: {
        [buildId]: {
          arch: "arm64",
          url: "helpers-aarch64.tar.gz",
          sha256: "b".repeat(64),
          gondolinVersion: "1.2.3",
          target: "aarch64-linux-musl",
          zigVersion: "0.16.0",
        },
      },
    },
    "https://example.invalid/builtin-sandbox-helper-registry.json",
  );

  assert.equal(parsed.refs["gondolin:1.2.3"]?.aarch64, buildId);
  assert.equal(parsed.builds[buildId]?.arch, "aarch64");
  assert.equal(
    parsed.builds[buildId]?.url,
    "https://example.invalid/helpers-aarch64.tar.gz",
  );
});

test("sandbox helpers: ensureSandboxHelperBinaries downloads and caches helpers", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-helpers-"));
  const storeDir = path.join(tmpDir, "store");
  const bundleDir = path.join(tmpDir, "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });

  const { buildId } = createHelperBundle(bundleDir, "x86_64", "9.8.7");
  const archive = createHelperArchive(bundleDir, tmpDir);
  const registryUrl =
    "https://example.invalid/builtin-sandbox-helper-registry.json";
  const archiveUrl = "https://example.invalid/helpers-x86_64.tar.gz";
  const registry = {
    schema: 1,
    refs: {
      "gondolin:9.8.7": {
        x86_64: buildId,
      },
    },
    builds: {
      [buildId]: {
        arch: "x86_64",
        url: archiveUrl,
        sha256: archive.sha256,
        gondolinVersion: "9.8.7",
        target: "x86_64-linux-musl",
        zigVersion: "0.16.0",
      },
    },
  };

  const prevFetch = globalThis.fetch;
  let registryFetches = 0;
  let archiveFetches = 0;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = async (
    url: string | URL | Request,
  ) => {
    const href = String(url);
    if (href === registryUrl) {
      registryFetches += 1;
      if (registryFetches > 1) {
        return new Response(null, { status: 304 });
      }
      return new Response(JSON.stringify(registry), {
        status: 200,
        headers: { etag: '"helpers-test"' },
      });
    }
    if (href === archiveUrl) {
      archiveFetches += 1;
      return new Response(archive.data, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const first = await ensureSandboxHelperBinaries({
      arch: "x86_64",
      gondolinVersion: "9.8.7",
      registryUrl,
      storeDir,
    });
    assert.equal(first.source, "download");
    assert.equal(first.buildId, buildId);
    assert.equal(first.arch, "x86_64");
    assert.equal(
      fs.readFileSync(first.paths.sandboxdPath, "utf8"),
      "#!/bin/sh\necho sandboxd-x86_64\n",
    );

    const second = await ensureSandboxHelperBinaries({
      arch: "x86_64",
      gondolinVersion: "9.8.7",
      registryUrl,
      storeDir,
    });
    assert.equal(second.source, "cache");
    assert.equal(second.buildId, buildId);
    assert.equal(archiveFetches, 1);
    assert.equal(registryFetches, 2);
  } finally {
    restoreFetch(prevFetch);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox helpers: explicit helper directory bypasses registry fetch", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-helpers-"));
  const bundleDir = path.join(tmpDir, "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });
  const { buildId } = createHelperBundle(bundleDir, "aarch64", "1.2.3");

  const prevFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = async () => {
    fetchCalls += 1;
    return new Response("not found", { status: 404 });
  };

  try {
    const resolved = await ensureSandboxHelperBinaries({
      arch: "aarch64",
      gondolinVersion: "1.2.3",
      helpersDir: bundleDir,
    });
    assert.equal(resolved.source, "directory");
    assert.equal(resolved.buildId, buildId);
    assert.equal(resolved.paths.sandboxingressPath, path.join(bundleDir, "bin", "sandboxingress"));
    assert.equal(fetchCalls, 0);
  } finally {
    restoreFetch(prevFetch);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox helpers: archive sha256 mismatch fails before extraction", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-helpers-"));
  const storeDir = path.join(tmpDir, "store");
  const bundleDir = path.join(tmpDir, "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });

  const { buildId } = createHelperBundle(bundleDir, "x86_64", "1.0.0");
  const archive = createHelperArchive(bundleDir, tmpDir);
  const registryUrl =
    "https://example.invalid/builtin-sandbox-helper-registry.json";
  const archiveUrl = "https://example.invalid/helpers-x86_64.tar.gz";
  const registry = {
    schema: 1,
    refs: {
      "gondolin:1.0.0": {
        x86_64: buildId,
      },
    },
    builds: {
      [buildId]: {
        arch: "x86_64",
        url: archiveUrl,
        sha256: "0".repeat(64),
        gondolinVersion: "1.0.0",
      },
    },
  };

  const prevFetch = globalThis.fetch;
  let archiveFetches = 0;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = async (
    url: string | URL | Request,
  ) => {
    const href = String(url);
    if (href === registryUrl) {
      return new Response(JSON.stringify(registry), { status: 200 });
    }
    if (href === archiveUrl) {
      archiveFetches += 1;
      return new Response(archive.data, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    await assert.rejects(
      () =>
        ensureSandboxHelperBinaries({
          arch: "x86_64",
          gondolinVersion: "1.0.0",
          registryUrl,
          storeDir,
        }),
      /downloaded sandbox helper checksum mismatch/,
    );
    assert.equal(archiveFetches, 1);
    assert.equal(fs.existsSync(path.join(storeDir, "objects", buildId)), false);
  } finally {
    restoreFetch(prevFetch);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
