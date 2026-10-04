#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeSandboxHelperBuildId,
  SANDBOX_HELPER_BINARY_NAMES,
} from "../host/src/build/sandbox-helpers.ts";
import { computeFileHash } from "../host/src/build/helpers.ts";
import { normalizeVersion, parseArgs, requireArg } from "./lib/cli.mjs";

const HELPER_KIND = "gondolin-sandbox-helpers";
const RELEASE_ARTIFACT_KIND = "gondolin-sandbox-helpers-release-artifact";
const ZIG_TARGETS = {
  aarch64: "aarch64-linux-musl",
  x86_64: "x86_64-linux-musl",
};
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

function usage() {
  return `Usage: node scripts/package-sandbox-helpers.mjs --version <version> --arch <aarch64|x86_64> [options]\n\nOptions:\n  --guest-dir <path>     Guest source directory (default: ./guest)\n  --output-dir <path>    Directory for archive + metadata (default: cwd)\n  --source-ref <ref>     Git ref recorded in manifest metadata\n  --target <triple>      Zig target triple (default: inferred from arch)\n  --zig-version <ver>    Zig version (default: \`zig version\`)\n`;
}

function normalizeArch(value) {
  const arch = value.trim();
  if (!Object.hasOwn(ZIG_TARGETS, arch)) {
    throw new Error(`invalid arch: ${value}`);
  }
  return arch;
}

function commandFailure(command, args, result) {
  const status = result.status ?? "?";
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString("utf8")
    : String(result.stderr ?? "");
  const error = result.error ? `\n${result.error.message}` : "";
  return new Error(
    `command failed (${status}): ${command} ${args.join(" ")}${error}${
      stderr ? `\n${stderr}` : ""
    }`,
  );
}

function detectZigVersion() {
  const result = spawnSync("zig", ["version"], { encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  return null;
}

function hasGnuTar() {
  const result = spawnSync("tar", ["--version"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes("GNU tar");
}

function createPortableTarGz(stageDir, archivePath) {
  const tarArgs = ["-czf", archivePath, "-C", stageDir, "manifest.json", "bin"];
  const tar = spawnSync("tar", tarArgs, {
    maxBuffer: MAX_ARCHIVE_BYTES,
  });
  if (tar.error || tar.status !== 0) {
    throw commandFailure("tar", tarArgs, tar);
  }
}

function createDeterministicTarGz(stageDir, archivePath) {
  if (!hasGnuTar()) {
    createPortableTarGz(stageDir, archivePath);
    return;
  }

  const tarArgs = [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-cf",
    "-",
    "-C",
    stageDir,
    "manifest.json",
    "bin",
  ];
  const tar = spawnSync("tar", tarArgs, {
    maxBuffer: MAX_ARCHIVE_BYTES,
  });
  if (tar.error || tar.status !== 0) {
    throw commandFailure("tar", tarArgs, tar);
  }

  const gzipArgs = ["-n", "-c"];
  const gzip = spawnSync("gzip", gzipArgs, {
    input: tar.stdout,
    maxBuffer: MAX_ARCHIVE_BYTES,
  });
  if (gzip.error || gzip.status !== 0) {
    throw commandFailure("gzip", gzipArgs, gzip);
  }

  fs.writeFileSync(archivePath, gzip.stdout);
}

function copyHelperBinaries(binSourceDir, binDestDir) {
  fs.mkdirSync(binDestDir, { recursive: true });
  const checksums = {};

  for (const name of SANDBOX_HELPER_BINARY_NAMES) {
    const source = path.join(binSourceDir, name);
    const stat = fs.statSync(source, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      throw new Error(`missing built helper binary: ${source}`);
    }

    const dest = path.join(binDestDir, name);
    fs.copyFileSync(source, dest);
    fs.chmodSync(dest, 0o755);
    checksums[name] = computeFileHash(dest);
  }

  return checksums;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const version = normalizeVersion(requireArg(args, "version"));
  const arch = normalizeArch(requireArg(args, "arch"));
  const target = (args.target || ZIG_TARGETS[arch]).trim();
  if (!target) {
    throw new Error("target must not be empty");
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const guestDir = path.resolve(
    args["guest-dir"] || path.join(repoRoot, "guest"),
  );
  const outputDir = path.resolve(args["output-dir"] || process.cwd());
  const sourceRef =
    typeof args["source-ref"] === "string" ? args["source-ref"].trim() : "";
  const zigVersion =
    typeof args["zig-version"] === "string" && args["zig-version"].trim()
      ? args["zig-version"].trim()
      : detectZigVersion();

  if (!zigVersion) {
    throw new Error("could not determine Zig version; pass --zig-version");
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `gondolin-sandbox-helpers-${version}-${arch}-`),
  );

  try {
    const stageDir = path.join(tmpRoot, "stage");
    const binDir = path.join(stageDir, "bin");
    const checksums = copyHelperBinaries(
      path.join(guestDir, "zig-out", "bin"),
      binDir,
    );
    const buildId = computeSandboxHelperBuildId({ arch, checksums });
    const manifest = {
      schema: 1,
      kind: HELPER_KIND,
      gondolinVersion: version,
      ...(sourceRef ? { sourceRef } : {}),
      arch,
      target,
      zigVersion,
      checksums,
    };

    fs.writeFileSync(
      path.join(stageDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const archive = `gondolin-sandbox-helpers-${version}-${arch}.tar.gz`;
    const archivePath = path.join(outputDir, archive);
    createDeterministicTarGz(stageDir, archivePath);

    const archiveSha256 = computeFileHash(archivePath);
    fs.writeFileSync(
      path.join(outputDir, `${archive}.sha256`),
      `${archiveSha256}  ${archive}\n`,
    );

    const metadata = {
      schema: 1,
      kind: RELEASE_ARTIFACT_KIND,
      arch,
      buildId,
      gondolinVersion: version,
      ...(sourceRef ? { sourceRef } : {}),
      target,
      zigVersion,
      archive,
      sha256: archiveSha256,
      checksums,
    };
    const metadataPath = path.join(outputDir, `${archive}.meta.json`);
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    process.stdout.write(
      `${JSON.stringify(
        {
          archivePath,
          metadataPath,
          buildId,
          sha256: archiveSha256,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
