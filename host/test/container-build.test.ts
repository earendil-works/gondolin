import fs from "fs";
import os from "os";
import path from "path";

import test from "node:test";
import assert from "node:assert/strict";

import { buildAssets } from "../src/build/index.ts";
import type { BuildConfig } from "../src/build/config.ts";

const skipWindowsContainerBuildTests =
  process.platform === "win32"
    ? "container build stub tests require POSIX shell/docker semantics"
    : false;

test(
  "builder: container build path does not use guest/image/build.sh",
  { skip: skipWindowsContainerBuildTests },
  async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-docker-stub-"));
  const stubDir = path.join(tmp, "bin");
  fs.mkdirSync(stubDir, { recursive: true });

  const dockerStubPath = path.join(stubDir, "docker");

  // A tiny docker stub that:
  // - responds to `docker --version`
  // - intercepts `docker run ...` and validates the generated build script
  // - writes fake assets + manifest to the mounted output dir
  const dockerStub = `#!${process.execPath}
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

function parseMount(mount) {
  // <host>:<container>[:ro]
  const first = mount.indexOf(":");
  if (first === -1) return null;
  const host = mount.slice(0, first);
  const rest = mount.slice(first + 1);
  const second = rest.indexOf(":");
  const container = second === -1 ? rest : rest.slice(0, second);
  return { host, container };
}

if (args[0] === "--version") {
  process.stdout.write("Docker version 0.0.0-stub\\n");
  process.exit(0);
}

if (args[0] === "run") {
  let outDir = null;
  let workDir = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-v") {
      const mount = args[++i];
      const parsed = parseMount(mount);
      if (!parsed) continue;
      if (parsed.container === "/output") outDir = parsed.host;
      if (parsed.container === "/work") workDir = parsed.host;
    }
  }

  if (!outDir || !workDir) {
    process.stderr.write("docker stub: missing /output or /work mount\\n");
    process.exit(1);
  }

  const buildScriptPath = path.join(workDir, "build-in-container.sh");
  const runnerPath = path.join(workDir, "run-build.mjs");
  const cfgPath = path.join(workDir, "build-config.json");

  const buildScript = fs.readFileSync(buildScriptPath, "utf8");

  if (buildScript.includes("./build.sh") || buildScript.includes("/guest/image")) {
    process.stderr.write("docker stub: build script still references guest/image/build.sh\\n");
    process.exit(2);
  }
  if (!buildScript.includes("node /work/run-build.mjs")) {
    process.stderr.write("docker stub: build script does not run the node builder\\n");
    process.exit(3);
  }
  if (!buildScript.includes("export ZIG_LOCAL_CACHE_DIR=/work/zig-cache/local")) {
    process.stderr.write("docker stub: build script does not configure ZIG_LOCAL_CACHE_DIR\\n");
    process.exit(6);
  }
  if (!buildScript.includes("export ZIG_GLOBAL_CACHE_DIR=/work/zig-cache/global")) {
    process.stderr.write("docker stub: build script does not configure ZIG_GLOBAL_CACHE_DIR\\n");
    process.exit(7);
  }
  if (!fs.existsSync(runnerPath)) {
    process.stderr.write("docker stub: missing /work/run-build.mjs\\n");
    process.exit(4);
  }
  if (!fs.existsSync(cfgPath)) {
    process.stderr.write("docker stub: missing /work/build-config.json\\n");
    process.exit(5);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "vmlinuz-virt"), "");
  fs.writeFileSync(path.join(outDir, "initramfs.cpio.lz4"), "");
  fs.writeFileSync(path.join(outDir, "rootfs.ext4"), "");

  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

  const manifest = {
    version: 1,
    config: cfg,
    buildTime: new Date().toISOString(),
    assets: {
      kernel: "vmlinuz-virt",
      initramfs: "initramfs.cpio.lz4",
      rootfs: "rootfs.ext4",
    },
    checksums: {
      kernel: "00",
      initramfs: "00",
      rootfs: "00",
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  process.exit(0);
}

// For anything else, pretend success.
process.exit(0);
`;

  fs.writeFileSync(dockerStubPath, dockerStub, { mode: 0o755 });

  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-assets-out-"),
  );

  const config: BuildConfig = {
    arch: "x86_64",
    distro: "alpine",
    alpine: {
      version: "3.23.0",
    },
    container: {
      force: true,
      runtime: "docker",
      image: "alpine:3.23",
    },
  };

  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${stubDir}:${oldPath ?? ""}`;

    // Sanity check: the docker stub is discoverable and executable
    const { execFileSync } = await import("node:child_process");
    const versionOut = execFileSync("docker", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(versionOut, /0\.0\.0-stub/);

    const result = await buildAssets(config, {
      outputDir,
      verbose: false,
    });

    assert.equal(result.outputDir, outputDir);
    assert.ok(fs.existsSync(path.join(outputDir, "manifest.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "vmlinuz-virt")));

    // Make sure buildAssets returned the manifest generated by the container build
    assert.equal(result.manifest.config.arch, "x86_64");
    assert.equal(result.manifest.version, 1);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
},
);

test(
  "builder: container build uses --privileged when postBuild commands are configured",
  { skip: skipWindowsContainerBuildTests },
  async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-docker-stub-"));
  const stubDir = path.join(tmp, "bin");
  fs.mkdirSync(stubDir, { recursive: true });

  const dockerStubPath = path.join(stubDir, "docker");

  const dockerStub = `#!${process.execPath}
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

function parseMount(mount) {
  const first = mount.indexOf(":");
  if (first === -1) return null;
  const host = mount.slice(0, first);
  const rest = mount.slice(first + 1);
  const second = rest.indexOf(":");
  const container = second === -1 ? rest : rest.slice(0, second);
  return { host, container };
}

if (args[0] === "--version") {
  process.stdout.write("Docker version 0.0.0-stub\\n");
  process.exit(0);
}

if (args[0] === "run") {
  if (!args.includes("--privileged")) {
    process.stderr.write("docker stub: missing --privileged\\n");
    process.exit(12);
  }

  let outDir = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-v") {
      const parsed = parseMount(args[++i]);
      if (parsed && parsed.container === "/output") {
        outDir = parsed.host;
      }
    }
  }

  if (!outDir) {
    process.stderr.write("docker stub: missing /output mount\\n");
    process.exit(13);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "vmlinuz-virt"), "");
  fs.writeFileSync(path.join(outDir, "initramfs.cpio.lz4"), "");
  fs.writeFileSync(path.join(outDir, "rootfs.ext4"), "");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        config: {
          arch: "x86_64",
          distro: "alpine"
        },
        buildTime: new Date().toISOString(),
        assets: {
          kernel: "vmlinuz-virt",
          initramfs: "initramfs.cpio.lz4",
          rootfs: "rootfs.ext4"
        },
        checksums: {
          kernel: "00",
          initramfs: "00",
          rootfs: "00"
        }
      },
      null,
      2,
    ),
  );

  process.exit(0);
}

process.exit(0);
`;

  fs.writeFileSync(dockerStubPath, dockerStub, { mode: 0o755 });

  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-assets-out-"),
  );

  const config: BuildConfig = {
    arch: "x86_64",
    distro: "alpine",
    alpine: {
      version: "3.23.0",
    },
    postBuild: {
      commands: ["echo hello"],
    },
    container: {
      force: true,
      runtime: "docker",
      image: "alpine:3.23",
    },
  };

  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${stubDir}:${oldPath ?? ""}`;

    await buildAssets(config, {
      outputDir,
      verbose: false,
      skipBinaries: true,
    });
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
},
);

test(
  "builder: container build stages postBuild.copy sources under /work",
  { skip: skipWindowsContainerBuildTests },
  async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-docker-stub-"));
  const stubDir = path.join(tmp, "bin");
  fs.mkdirSync(stubDir, { recursive: true });

  const dockerStubPath = path.join(stubDir, "docker");

  const dockerStub = `#!${process.execPath}
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

function parseMount(mount) {
  const first = mount.indexOf(":");
  if (first === -1) return null;
  const host = mount.slice(0, first);
  const rest = mount.slice(first + 1);
  const second = rest.indexOf(":");
  const container = second === -1 ? rest : rest.slice(0, second);
  return { host, container };
}

if (args[0] === "--version") {
  process.stdout.write("Docker version 0.0.0-stub\\n");
  process.exit(0);
}

if (args[0] === "run") {
  let outDir = null;
  let workDir = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-v") {
      const parsed = parseMount(args[++i]);
      if (!parsed) continue;
      if (parsed.container === "/output") outDir = parsed.host;
      if (parsed.container === "/work") workDir = parsed.host;
    }
  }

  if (!outDir || !workDir) {
    process.stderr.write("docker stub: missing /output or /work mount\\n");
    process.exit(20);
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(workDir, "build-config.json"), "utf8"));
  const copy = cfg.postBuild && Array.isArray(cfg.postBuild.copy) ? cfg.postBuild.copy : [];
  if (copy.length !== 1) {
    process.stderr.write("docker stub: expected one postBuild.copy entry\\n");
    process.exit(21);
  }

  if (copy[0].src !== "/work/postbuild-copy-0/tool.tar.gz") {
    process.stderr.write("docker stub: postBuild.copy src did not preserve source basename\\n");
    process.exit(22);
  }

  if (!fs.existsSync(path.join(workDir, "postbuild-copy-0", "tool.tar.gz"))) {
    process.stderr.write("docker stub: staged postBuild.copy source missing\\n");
    process.exit(23);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "vmlinuz-virt"), "");
  fs.writeFileSync(path.join(outDir, "initramfs.cpio.lz4"), "");
  fs.writeFileSync(path.join(outDir, "rootfs.ext4"), "");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        config: cfg,
        buildTime: new Date().toISOString(),
        assets: {
          kernel: "vmlinuz-virt",
          initramfs: "initramfs.cpio.lz4",
          rootfs: "rootfs.ext4"
        },
        checksums: {
          kernel: "00",
          initramfs: "00",
          rootfs: "00"
        }
      },
      null,
      2,
    ),
  );

  process.exit(0);
}

process.exit(0);
`;

  fs.writeFileSync(dockerStubPath, dockerStub, { mode: 0o755 });

  const sourcePath = path.join(tmp, "tool.tar.gz");
  fs.writeFileSync(sourcePath, "archive");

  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-assets-out-"),
  );

  const config: BuildConfig = {
    arch: "x86_64",
    distro: "alpine",
    alpine: {
      version: "3.23.0",
    },
    postBuild: {
      copy: [
        {
          src: sourcePath,
          dest: "/tmp/tool.tar.gz",
        },
      ],
    },
    container: {
      force: true,
      runtime: "docker",
      image: "alpine:3.23",
    },
  };

  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${stubDir}:${oldPath ?? ""}`;

    await buildAssets(config, {
      outputDir,
      verbose: false,
      skipBinaries: true,
    });
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
},
);

test(
  "builder: container build preserves postBuild.copy symlinks",
  { skip: skipWindowsContainerBuildTests },
  async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-docker-stub-"));
  const stubDir = path.join(tmp, "bin");
  fs.mkdirSync(stubDir, { recursive: true });

  const dockerStubPath = path.join(stubDir, "docker");

  const dockerStub = `#!${process.execPath}
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

function parseMount(mount) {
  const first = mount.indexOf(":");
  if (first === -1) return null;
  const host = mount.slice(0, first);
  const rest = mount.slice(first + 1);
  const second = rest.indexOf(":");
  const container = second === -1 ? rest : rest.slice(0, second);
  return { host, container };
}

if (args[0] === "--version") {
  process.stdout.write("Docker version 0.0.0-stub\\n");
  process.exit(0);
}

if (args[0] === "run") {
  let outDir = null;
  let workDir = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-v") {
      const parsed = parseMount(args[++i]);
      if (!parsed) continue;
      if (parsed.container === "/output") outDir = parsed.host;
      if (parsed.container === "/work") workDir = parsed.host;
    }
  }

  if (!outDir || !workDir) {
    process.stderr.write("docker stub: missing /output or /work mount\\n");
    process.exit(30);
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(workDir, "build-config.json"), "utf8"));
  const stagedPath = path.join(workDir, "postbuild-copy-0", "tool-link");

  if (cfg.postBuild.copy[0].src !== "/work/postbuild-copy-0/tool-link") {
    process.stderr.write("docker stub: symlink source path rewrite mismatch\\n");
    process.exit(31);
  }

  if (!fs.lstatSync(stagedPath).isSymbolicLink()) {
    process.stderr.write("docker stub: staged postBuild.copy source is not a symlink\\n");
    process.exit(32);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "vmlinuz-virt"), "");
  fs.writeFileSync(path.join(outDir, "initramfs.cpio.lz4"), "");
  fs.writeFileSync(path.join(outDir, "rootfs.ext4"), "");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        config: cfg,
        buildTime: new Date().toISOString(),
        assets: {
          kernel: "vmlinuz-virt",
          initramfs: "initramfs.cpio.lz4",
          rootfs: "rootfs.ext4"
        },
        checksums: {
          kernel: "00",
          initramfs: "00",
          rootfs: "00"
        }
      },
      null,
      2,
    ),
  );

  process.exit(0);
}

process.exit(0);
`;

  fs.writeFileSync(dockerStubPath, dockerStub, { mode: 0o755 });

  const sourceTargetPath = path.join(tmp, "tool.tar.gz");
  const sourceLinkPath = path.join(tmp, "tool-link");
  fs.writeFileSync(sourceTargetPath, "archive");
  fs.symlinkSync("tool.tar.gz", sourceLinkPath);

  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-assets-out-"),
  );

  const config: BuildConfig = {
    arch: "x86_64",
    distro: "alpine",
    alpine: {
      version: "3.23.0",
    },
    postBuild: {
      copy: [
        {
          src: sourceLinkPath,
          dest: "/tmp/",
        },
      ],
    },
    container: {
      force: true,
      runtime: "docker",
      image: "alpine:3.23",
    },
  };

  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${stubDir}:${oldPath ?? ""}`;

    await buildAssets(config, {
      outputDir,
      verbose: false,
      skipBinaries: true,
    });
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
},
);
