import fs from "fs";
import os from "os";
import path from "path";

import assert from "node:assert/strict";
import test from "node:test";

import { __test as buildAlpineTest } from "../src/build-alpine";

function writeFakeDockerRuntime(binDir: string): void {
  const runtimePath = path.join(binDir, "docker");
  fs.writeFileSync(
    runtimePath,
    `#!/bin/sh
set -eu

if [ -n "\${FAKE_DOCKER_LOG:-}" ]; then
  printf "%s\\n" "$*" >> "\${FAKE_DOCKER_LOG}"
fi

cmd="\${1:-}"
if [ "$cmd" = "--version" ]; then
  printf "Docker fake 1.0\\n"
  exit 0
fi

if [ "$cmd" = "create" ]; then
  shift
  platform=""
  pull_mode=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --platform)
        shift
        platform="\${1:-}"
        ;;
      --platform=*)
        platform="\${1#--platform=}"
        ;;
      --pull)
        shift
        pull_mode="\${1:-}"
        ;;
      --pull=*)
        pull_mode="\${1#--pull=}"
        ;;
    esac
    shift || true
  done

  if [ "$pull_mode" = "never" ] && [ "\${LOCAL_PLATFORM:-}" != "$platform" ]; then
    printf "Error response from daemon: image with reference debian:bookworm-slim was found but its platform (\${LOCAL_PLATFORM:-unknown}) does not match the specified platform ($platform)\\n" >&2
    exit 125
  fi

  printf "cid-\${platform}-\${pull_mode:-default}\\n"
  exit 0
fi

if [ "$cmd" = "export" ]; then
  shift
  out=""

  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
      shift
      out="\${1:-}"
      break
    fi
    shift || true
  done

  if [ -z "$out" ]; then
    printf "missing export output\\n" >&2
    exit 2
  fi

  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/bin"
  printf "#!/bin/sh\\n" > "$tmpdir/bin/sh"
  chmod +x "$tmpdir/bin/sh"
  tar -cf "$out" -C "$tmpdir" .
  rm -rf "$tmpdir"
  exit 0
fi

if [ "$cmd" = "rm" ] || [ "$cmd" = "pull" ] || [ "$cmd" = "image" ]; then
  exit 0
fi

exit 0
`,
    { mode: 0o755 },
  );
}

function readFakeLog(logPath: string): string[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("oci pullPolicy never: fails when requested platform is not local", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-pull-never-"));
  const binDir = path.join(tmp, "bin");
  const rootfsDir = path.join(tmp, "rootfs");
  const logPath = path.join(tmp, "docker.log");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  writeFakeDockerRuntime(binDir);

  const oldPath = process.env.PATH;
  const oldLog = process.env.FAKE_DOCKER_LOG;
  const oldLocalPlatform = process.env.LOCAL_PLATFORM;

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.FAKE_DOCKER_LOG = logPath;
    process.env.LOCAL_PLATFORM = "linux/arm64";

    assert.throws(
      () =>
        (buildAlpineTest as any).exportOciRootfs({
          arch: "x86_64",
          image: "docker.io/library/debian:bookworm-slim",
          runtime: "docker",
          platform: "linux/amd64",
          pullPolicy: "never",
          workDir: tmp,
          targetDir: rootfsDir,
          log: () => {},
        }),
      /not available locally for platform 'linux\/amd64'.*pullPolicy is 'never'/,
    );

    const lines = readFakeLog(logPath);
    assert.ok(
      lines.some(
        (line) =>
          line ===
          "create --platform linux/amd64 --pull=never docker.io/library/debian:bookworm-slim true",
      ),
    );
    assert.equal(lines.some((line) => line.startsWith("pull ")), false);
  } finally {
    process.env.PATH = oldPath;
    process.env.FAKE_DOCKER_LOG = oldLog;
    process.env.LOCAL_PLATFORM = oldLocalPlatform;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci pullPolicy if-not-present: pulls when requested platform is not local", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-pull-auto-"));
  const binDir = path.join(tmp, "bin");
  const rootfsDir = path.join(tmp, "rootfs");
  const logPath = path.join(tmp, "docker.log");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  writeFakeDockerRuntime(binDir);

  const oldPath = process.env.PATH;
  const oldLog = process.env.FAKE_DOCKER_LOG;
  const oldLocalPlatform = process.env.LOCAL_PLATFORM;

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.FAKE_DOCKER_LOG = logPath;
    process.env.LOCAL_PLATFORM = "linux/arm64";

    (buildAlpineTest as any).exportOciRootfs({
      arch: "x86_64",
      image: "docker.io/library/debian:bookworm-slim",
      runtime: "docker",
      platform: "linux/amd64",
      pullPolicy: "if-not-present",
      workDir: tmp,
      targetDir: rootfsDir,
      log: () => {},
    });

    assert.equal(fs.existsSync(path.join(rootfsDir, "bin", "sh")), true);

    const lines = readFakeLog(logPath);
    assert.ok(
      lines.some(
        (line) =>
          line ===
          "create --platform linux/amd64 --pull=never docker.io/library/debian:bookworm-slim true",
      ),
    );
    assert.ok(
      lines.some(
        (line) =>
          line ===
          "pull --platform linux/amd64 docker.io/library/debian:bookworm-slim",
      ),
    );
  } finally {
    process.env.PATH = oldPath;
    process.env.FAKE_DOCKER_LOG = oldLog;
    process.env.LOCAL_PLATFORM = oldLocalPlatform;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci pullPolicy never: export create uses --pull=never", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-pull-never-"));
  const binDir = path.join(tmp, "bin");
  const rootfsDir = path.join(tmp, "rootfs");
  const logPath = path.join(tmp, "docker.log");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  writeFakeDockerRuntime(binDir);

  const oldPath = process.env.PATH;
  const oldLog = process.env.FAKE_DOCKER_LOG;
  const oldLocalPlatform = process.env.LOCAL_PLATFORM;

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.FAKE_DOCKER_LOG = logPath;
    process.env.LOCAL_PLATFORM = "linux/amd64";

    (buildAlpineTest as any).exportOciRootfs({
      arch: "x86_64",
      image: "docker.io/library/debian:bookworm-slim",
      runtime: "docker",
      platform: "linux/amd64",
      pullPolicy: "never",
      workDir: tmp,
      targetDir: rootfsDir,
      log: () => {},
    });

    assert.equal(fs.existsSync(path.join(rootfsDir, "bin", "sh")), true);

    const lines = readFakeLog(logPath);
    const createLines = lines.filter((line) => line.startsWith("create "));
    assert.equal(createLines.length >= 2, true);
    for (const line of createLines) {
      assert.ok(line.includes("--platform linux/amd64"));
      assert.ok(line.includes("--pull=never"));
      assert.ok(line.endsWith(" docker.io/library/debian:bookworm-slim true"));
    }
    assert.equal(lines.some((line) => line.startsWith("pull ")), false);
  } finally {
    process.env.PATH = oldPath;
    process.env.FAKE_DOCKER_LOG = oldLog;
    process.env.LOCAL_PLATFORM = oldLocalPlatform;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
