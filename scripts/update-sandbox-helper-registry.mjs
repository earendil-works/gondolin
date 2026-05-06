#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const RELEASE_ARTIFACT_KIND = "gondolin-sandbox-helpers-release-artifact";
const ARCHS = ["aarch64", "x86_64"];
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function usage() {
  return `Usage: node scripts/update-sandbox-helper-registry.mjs --version <version> --release-tag <tag> --owner <owner> --repo <repo> [options]\n\nOptions:\n  --registry <path>       Registry JSON path (default: builtin-sandbox-helper-registry.json)\n  --metadata-dir <path>   Directory containing *.meta.json files (default: cwd)\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }

    const eq = token.indexOf("=");
    if (eq >= 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }

    const key = token.slice(2);
    const value = argv[++i];
    if (value === undefined) {
      throw new Error(`missing value for --${key}`);
    }
    args[key] = value;
  }
  return args;
}

function requireArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing required --${name}`);
  }
  return value.trim();
}

function normalizeVersion(value) {
  const version = value.trim().replace(/^v/, "");
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`invalid version: ${value}`);
  }
  return version;
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function validateMetadata(raw, filePath, version) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`invalid helper metadata ${filePath}: expected object`);
  }
  if (raw.schema !== 1) {
    throw new Error(`invalid helper metadata ${filePath}: schema must be 1`);
  }
  if (raw.kind !== RELEASE_ARTIFACT_KIND) {
    throw new Error(`invalid helper metadata ${filePath}: kind mismatch`);
  }
  if (raw.gondolinVersion !== version) {
    throw new Error(
      `invalid helper metadata ${filePath}: gondolinVersion ${raw.gondolinVersion} does not match ${version}`,
    );
  }
  if (!ARCHS.includes(raw.arch)) {
    throw new Error(`invalid helper metadata ${filePath}: arch ${raw.arch}`);
  }
  if (typeof raw.buildId !== "string" || !BUILD_ID_PATTERN.test(raw.buildId)) {
    throw new Error(`invalid helper metadata ${filePath}: buildId ${raw.buildId}`);
  }
  if (typeof raw.target !== "string" || raw.target.length === 0) {
    throw new Error(`invalid helper metadata ${filePath}: target is required`);
  }
  if (typeof raw.zigVersion !== "string" || raw.zigVersion.length === 0) {
    throw new Error(`invalid helper metadata ${filePath}: zigVersion is required`);
  }
  if (typeof raw.archive !== "string" || raw.archive.length === 0) {
    throw new Error(`invalid helper metadata ${filePath}: archive is required`);
  }
  if (typeof raw.sha256 !== "string" || !SHA256_PATTERN.test(raw.sha256)) {
    throw new Error(`invalid helper metadata ${filePath}: sha256 ${raw.sha256}`);
  }

  return {
    arch: raw.arch,
    buildId: raw.buildId.toLowerCase(),
    gondolinVersion: raw.gondolinVersion,
    target: raw.target,
    zigVersion: raw.zigVersion,
    archive: raw.archive,
    sha256: raw.sha256.toLowerCase(),
  };
}

function loadMetadata(metadataDir, version) {
  const byArch = new Map();
  for (const filePath of walkFiles(metadataDir)) {
    if (!filePath.endsWith(".tar.gz.meta.json")) {
      continue;
    }

    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (raw?.kind !== RELEASE_ARTIFACT_KIND) {
      continue;
    }

    const metadata = validateMetadata(raw, filePath, version);
    if (byArch.has(metadata.arch)) {
      throw new Error(`duplicate helper metadata for ${metadata.arch}`);
    }
    byArch.set(metadata.arch, metadata);
  }

  for (const arch of ARCHS) {
    if (!byArch.has(arch)) {
      throw new Error(`missing helper metadata for ${arch}`);
    }
  }

  return Object.fromEntries(byArch.entries());
}

function loadRegistry(registryPath) {
  const registry = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, "utf8"))
    : { schema: 1, refs: {}, builds: {} };

  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error(`invalid registry: ${registryPath}`);
  }
  if (registry.schema !== 1) {
    throw new Error(`unsupported sandbox helper registry schema: ${registry.schema}`);
  }
  if (!registry.refs || typeof registry.refs !== "object" || Array.isArray(registry.refs)) {
    throw new Error("invalid sandbox helper registry refs");
  }
  if (
    !registry.builds ||
    typeof registry.builds !== "object" ||
    Array.isArray(registry.builds)
  ) {
    throw new Error("invalid sandbox helper registry builds");
  }

  return registry;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const version = normalizeVersion(requireArg(args, "version"));
  const releaseTag = requireArg(args, "release-tag");
  const owner = requireArg(args, "owner");
  const repo = requireArg(args, "repo");
  const registryPath = path.resolve(args.registry || "builtin-sandbox-helper-registry.json");
  const metadataDir = path.resolve(args["metadata-dir"] || process.cwd());
  const metadata = loadMetadata(metadataDir, version);
  const registry = loadRegistry(registryPath);

  const ref = `gondolin:${version}`;
  registry.refs[ref] = {
    aarch64: metadata.aarch64.buildId,
    x86_64: metadata.x86_64.buildId,
  };

  for (const arch of ARCHS) {
    const item = metadata[arch];
    registry.builds[item.buildId] = {
      arch,
      gondolinVersion: version,
      zigVersion: item.zigVersion,
      target: item.target,
      url: `https://github.com/${owner}/${repo}/releases/download/${releaseTag}/${item.archive}`,
      sha256: item.sha256,
    };
  }

  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  process.stdout.write(`Updated ${registryPath} for ${ref}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
