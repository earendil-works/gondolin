import assert from "node:assert/strict";
import child_process from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Architecture, BuildConfig } from "../src/build/config.ts";
import {
  SANDBOX_HELPER_BINARY_NAMES,
  __test,
  computeSandboxHelperBuildId,
  ensureSandboxHelperBinaries,
  type SandboxHelperChecksums,
  type SandboxHelperManifest,
} from "../src/build/sandbox-helpers.ts";
import { resolveSandboxBinaryPaths } from "../src/build/shared.ts";

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

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function hostPackageVersion(): string {
  const pkgPath = path.join(import.meta.dirname, "..", "package.json");
  const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    version?: unknown;
  };
  assert.equal(typeof parsed.version, "string");
  return parsed.version;
}

function buildConfig(arch: Architecture): BuildConfig {
  return {
    arch,
    distro: "alpine",
    alpine: {
      version: "3.23.0",
    },
  };
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

test("resolveSandboxBinaryPaths: uses registry helpers by default without zig", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-helpers-"));
  const storeDir = path.join(tmpDir, "store");
  const emptyPathDir = path.join(tmpDir, "empty-path");
  const bundleDir = path.join(tmpDir, "bundle");
  fs.mkdirSync(emptyPathDir, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  const version = hostPackageVersion();
  const { buildId } = createHelperBundle(bundleDir, "x86_64", version);
  const archive = createHelperArchive(bundleDir, tmpDir);
  const registryUrl =
    "https://example.invalid/builtin-sandbox-helper-registry.json";
  const archiveUrl = "https://example.invalid/helpers-x86_64.tar.gz";
  const registry = {
    schema: 1,
    refs: {
      [`gondolin:${version}`]: {
        x86_64: buildId,
      },
    },
    builds: {
      [buildId]: {
        arch: "x86_64",
        url: archiveUrl,
        sha256: archive.sha256,
        gondolinVersion: version,
      },
    },
  };

  const prevFetch = globalThis.fetch;
  const prevPath = process.env.PATH;
  const prevRegistryUrl = process.env.GONDOLIN_SANDBOX_HELPER_REGISTRY_URL;
  const prevStore = process.env.GONDOLIN_SANDBOX_HELPER_STORE;
  const prevHelpersDir = process.env.GONDOLIN_SANDBOX_HELPERS_DIR;
  const prevSourceBuild = process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE;
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
    process.env.PATH = emptyPathDir;
    process.env.GONDOLIN_SANDBOX_HELPER_REGISTRY_URL = registryUrl;
    process.env.GONDOLIN_SANDBOX_HELPER_STORE = storeDir;
    delete process.env.GONDOLIN_SANDBOX_HELPERS_DIR;
    delete process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE;

    const paths = await resolveSandboxBinaryPaths(
      buildConfig("x86_64"),
      { outputDir: path.join(tmpDir, "out"), verbose: false },
      () => {},
    );

    assert.equal(archiveFetches, 1);
    assert.equal(
      fs.readFileSync(paths.sandboxdPath, "utf8"),
      "#!/bin/sh\necho sandboxd-x86_64\n",
    );
  } finally {
    restoreFetch(prevFetch);
    setEnv("PATH", prevPath);
    setEnv("GONDOLIN_SANDBOX_HELPER_REGISTRY_URL", prevRegistryUrl);
    setEnv("GONDOLIN_SANDBOX_HELPER_STORE", prevStore);
    setEnv("GONDOLIN_SANDBOX_HELPERS_DIR", prevHelpersDir);
    setEnv("GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE", prevSourceBuild);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveSandboxBinaryPaths: custom helper paths must be complete", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-helpers-"));
  const sandboxdPath = path.join(tmpDir, "sandboxd");
  fs.writeFileSync(sandboxdPath, "#!/bin/sh\n", { mode: 0o755 });

  try {
    await assert.rejects(
      () =>
        resolveSandboxBinaryPaths(
          {
            ...buildConfig("x86_64"),
            sandboxdPath,
          },
          { outputDir: path.join(tmpDir, "out"), verbose: false },
          () => {},
        ),
      /Partial sandbox helper path overrides are not supported/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveSandboxBinaryPaths: all custom helper paths bypass registry", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-helpers-"));
  const binPaths = Object.fromEntries(
    SANDBOX_HELPER_BINARY_NAMES.map((name) => {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, `#!/bin/sh\necho custom-${name}\n`, {
        mode: 0o755,
      });
      return [`${name}Path`, filePath];
    }),
  ) as Pick<
    BuildConfig,
    "sandboxdPath" | "sandboxfsPath" | "sandboxsshPath" | "sandboxingressPath"
  >;

  const prevFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = async () => {
    fetchCalls += 1;
    return new Response("not found", { status: 404 });
  };

  try {
    const paths = await resolveSandboxBinaryPaths(
      {
        ...buildConfig("x86_64"),
        ...binPaths,
      },
      { outputDir: path.join(tmpDir, "out"), verbose: false },
      () => {},
    );

    assert.equal(paths.sandboxfsPath, binPaths.sandboxfsPath);
    assert.equal(fetchCalls, 0);
  } finally {
    restoreFetch(prevFetch);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveSandboxBinaryPaths: registry failures do not source-build by default", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-helpers-"));
  const guestDir = path.join(tmpDir, "guest");
  const stubDir = path.join(tmpDir, "bin");
  const storeDir = path.join(tmpDir, "store");
  const markerPath = path.join(tmpDir, "zig-called");
  fs.mkdirSync(guestDir, { recursive: true });
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(guestDir, "build.zig"), "// test\n");
  fs.writeFileSync(
    path.join(stubDir, "zig"),
    `#!${process.execPath}\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "called");\n`,
    { mode: 0o755 },
  );

  const registryUrl =
    "https://example.invalid/builtin-sandbox-helper-registry.json";
  const prevFetch = globalThis.fetch;
  const prevPath = process.env.PATH;
  const prevRegistryUrl = process.env.GONDOLIN_SANDBOX_HELPER_REGISTRY_URL;
  const prevStore = process.env.GONDOLIN_SANDBOX_HELPER_STORE;
  const prevHelpersDir = process.env.GONDOLIN_SANDBOX_HELPERS_DIR;
  const prevGuestSrc = process.env.GONDOLIN_GUEST_SRC;
  const prevSourceBuild = process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE;

  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = async () =>
    new Response("not found", { status: 404, statusText: "Not Found" });

  try {
    process.env.PATH = `${stubDir}:${prevPath ?? ""}`;
    process.env.GONDOLIN_SANDBOX_HELPER_REGISTRY_URL = registryUrl;
    process.env.GONDOLIN_SANDBOX_HELPER_STORE = storeDir;
    process.env.GONDOLIN_GUEST_SRC = guestDir;
    delete process.env.GONDOLIN_SANDBOX_HELPERS_DIR;
    delete process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE;

    await assert.rejects(
      () =>
        resolveSandboxBinaryPaths(
          buildConfig("x86_64"),
          { outputDir: path.join(tmpDir, "out"), verbose: false },
          () => {},
        ),
      /GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE=1/,
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    restoreFetch(prevFetch);
    setEnv("PATH", prevPath);
    setEnv("GONDOLIN_SANDBOX_HELPER_REGISTRY_URL", prevRegistryUrl);
    setEnv("GONDOLIN_SANDBOX_HELPER_STORE", prevStore);
    setEnv("GONDOLIN_SANDBOX_HELPERS_DIR", prevHelpersDir);
    setEnv("GONDOLIN_GUEST_SRC", prevGuestSrc);
    setEnv("GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE", prevSourceBuild);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveSandboxBinaryPaths: source builds require explicit env opt-in", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-helpers-"));
  const guestDir = path.join(tmpDir, "guest");
  const stubDir = path.join(tmpDir, "bin");
  const storeDir = path.join(tmpDir, "store");
  fs.mkdirSync(guestDir, { recursive: true });
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(guestDir, "build.zig"), "// test\n");

  const zigStubPath = path.join(stubDir, "zig");
  fs.writeFileSync(
    zigStubPath,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const path = require("node:path");\n` +
      `fs.writeFileSync(path.join(process.cwd(), "zig-args.json"), JSON.stringify(process.argv.slice(2)));\n` +
      `const binDir = path.join(process.cwd(), "zig-out", "bin");\n` +
      `fs.mkdirSync(binDir, { recursive: true });\n` +
      `for (const name of ${JSON.stringify(SANDBOX_HELPER_BINARY_NAMES)}) {\n` +
      `  const filePath = path.join(binDir, name);\n` +
      `  fs.writeFileSync(filePath, "#!/bin/sh\\necho source-" + name + "\\n", { mode: 0o755 });\n` +
      `}\n`,
    { mode: 0o755 },
  );

  const registryUrl =
    "https://example.invalid/builtin-sandbox-helper-registry.json";
  const prevFetch = globalThis.fetch;
  const prevPath = process.env.PATH;
  const prevRegistryUrl = process.env.GONDOLIN_SANDBOX_HELPER_REGISTRY_URL;
  const prevStore = process.env.GONDOLIN_SANDBOX_HELPER_STORE;
  const prevHelpersDir = process.env.GONDOLIN_SANDBOX_HELPERS_DIR;
  const prevGuestSrc = process.env.GONDOLIN_GUEST_SRC;
  const prevSourceBuild = process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE;
  let fetchCalls = 0;

  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = async () => {
    fetchCalls += 1;
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };

  try {
    process.env.PATH = `${stubDir}:${prevPath ?? ""}`;
    process.env.GONDOLIN_SANDBOX_HELPER_REGISTRY_URL = registryUrl;
    process.env.GONDOLIN_SANDBOX_HELPER_STORE = storeDir;
    process.env.GONDOLIN_GUEST_SRC = guestDir;
    process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE = "1";
    delete process.env.GONDOLIN_SANDBOX_HELPERS_DIR;

    const paths = await resolveSandboxBinaryPaths(
      buildConfig("x86_64"),
      { outputDir: path.join(tmpDir, "out"), verbose: false },
      () => {},
    );

    assert.equal(fetchCalls, 1);
    assert.equal(
      fs.readFileSync(paths.sandboxsshPath, "utf8"),
      "#!/bin/sh\necho source-sandboxssh\n",
    );
    const zigArgs = JSON.parse(
      fs.readFileSync(path.join(guestDir, "zig-args.json"), "utf8"),
    ) as string[];
    assert.deepEqual(zigArgs, [
      "build",
      "-Doptimize=ReleaseSmall",
      "-Dtarget=x86_64-linux-musl",
    ]);
  } finally {
    restoreFetch(prevFetch);
    setEnv("PATH", prevPath);
    setEnv("GONDOLIN_SANDBOX_HELPER_REGISTRY_URL", prevRegistryUrl);
    setEnv("GONDOLIN_SANDBOX_HELPER_STORE", prevStore);
    setEnv("GONDOLIN_SANDBOX_HELPERS_DIR", prevHelpersDir);
    setEnv("GONDOLIN_GUEST_SRC", prevGuestSrc);
    setEnv("GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE", prevSourceBuild);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
