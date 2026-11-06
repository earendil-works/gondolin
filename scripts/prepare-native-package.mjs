#!/usr/bin/env node
// Stages the multi-call `gondolin` (the static CLI; `gondolin daemon` or a
// `gondolind` symlink is the daemon) into one of the packages/gondolin-native-*
// packages.
//
// usage: node scripts/prepare-native-package.mjs --package <dir> [--binary <path>]
//
// Without --binary the binary comes from `make native-release`
// (native/target/dist/<rust-target>/gondolin). It must match the
// package's `os`/`cpu` (checked from its ELF / Mach-O header); Linux binaries
// must be fully static.
import fs from "node:fs";
import path from "node:path";

const RUST_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
};

function parseArgs(argv) {
  let packageDir;
  let binaryPath;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--package") packageDir = argv[++i];
    else if (arg === "--binary") binaryPath = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!packageDir) throw new Error("--package is required");
  return { packageDir: path.resolve(packageDir), binaryPath };
}

/** `{ platform, arch, staticLinux }` from an executable's header. */
function describeExecutable(buf) {
  if (buf.length >= 20 && buf.readUInt32BE(0) === 0x7f454c46) {
    const machine = buf.readUInt16LE(18);
    const arch =
      machine === 0xb7 ? "arm64" : machine === 0x3e ? "x64" : `elf-${machine}`;
    // An ELF with a PT_INTERP program header needs a dynamic loader.
    const phoff = Number(buf.readBigUInt64LE(32));
    const phentsize = buf.readUInt16LE(54);
    const phnum = buf.readUInt16LE(56);
    let interp = false;
    for (let i = 0; i < phnum; i += 1) {
      const off = phoff + i * phentsize;
      if (off + 4 <= buf.length && buf.readUInt32LE(off) === 3) interp = true;
    }
    return { platform: "linux", arch, staticLinux: !interp };
  }
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = buf.readUInt32LE(4);
    const arch =
      cpu === 0x0100000c
        ? "arm64"
        : cpu === 0x01000007
          ? "x64"
          : `macho-${cpu}`;
    return { platform: "darwin", arch, staticLinux: false };
  }
  return null;
}

function main() {
  const { packageDir, binaryPath } = parseArgs(process.argv.slice(2));
  const pkgJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(pkgJsonPath))
    throw new Error(`package.json not found in ${packageDir}`);
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  const platform = pkg.os?.[0];
  const arch = pkg.cpu?.[0];
  const key = `${platform}-${arch}`;
  const rustTarget = RUST_TARGETS[key];
  if (!rustTarget) throw new Error(`unsupported package platform ${key}`);

  const binDir = path.join(packageDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const entry of fs.readdirSync(binDir)) {
    fs.rmSync(path.join(binDir, entry), { recursive: true, force: true });
  }
  const staged = [];
  for (const [name, explicit] of [["gondolin", binaryPath]]) {
    const source = path.resolve(
      explicit ?? path.join("native", "target", "dist", rustTarget, name),
    );
    if (!fs.existsSync(source)) {
      throw new Error(
        `${name} not found: ${source} (run 'make native-release TARGETS=${rustTarget}')`,
      );
    }
    const header = Buffer.alloc(64 * 1024);
    const fd = fs.openSync(source, "r");
    const n = fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);
    const info = describeExecutable(header.subarray(0, n));
    if (!info || info.platform !== platform || info.arch !== arch) {
      throw new Error(
        `${source} is not a ${key} executable (${JSON.stringify(info)})`,
      );
    }
    if (platform === "linux" && !info.staticLinux) {
      throw new Error(`${source} is not statically linked`);
    }
    const target = path.join(binDir, name);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
    staged.push(target);
  }

  const license = path.resolve("LICENSE");
  if (!fs.existsSync(license))
    throw new Error(`LICENSE not found at ${license}`);
  fs.copyFileSync(license, path.join(packageDir, "LICENSE"));

  console.log(`Prepared ${packageDir}`);
  for (const target of staged) {
    console.log(
      `  ${path.basename(target)}: ${target} (${fs.statSync(target).size} bytes, ${key})`,
    );
  }
}

main();
