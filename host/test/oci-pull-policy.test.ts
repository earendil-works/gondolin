import fs from "fs";
import os from "os";
import path from "path";

import assert from "node:assert/strict";
import test from "node:test";

import { exportOciRootfs } from "../src/alpine/oci.ts";

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

if [ "$cmd" = "image" ]; then
  sub="\${2:-}"
  if [ "$sub" = "inspect" ]; then
    if [ -n "\${FAKE_REPO_DIGEST:-}" ]; then
      printf "[\\\"%s\\\"]\\n" "$FAKE_REPO_DIGEST"
    else
      printf "[]\\n"
    fi
    exit 0
  fi
  exit 0
fi

if [ "$cmd" = "rm" ] || [ "$cmd" = "pull" ]; then
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test("oci pullPolicy never: fails when requested platform is not local", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-oci-pull-never-"),
  );
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
        exportOciRootfs({
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
    assert.equal(
      lines.some((line) => line.startsWith("pull ")),
      false,
    );
  } finally {
    restoreEnv("PATH", oldPath);
    restoreEnv("FAKE_DOCKER_LOG", oldLog);
    restoreEnv("LOCAL_PLATFORM", oldLocalPlatform);
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
  const oldRepoDigest = process.env.FAKE_REPO_DIGEST;

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.FAKE_DOCKER_LOG = logPath;
    process.env.LOCAL_PLATFORM = "linux/arm64";
    process.env.FAKE_REPO_DIGEST =
      "docker.io/library/debian@sha256:2222222222222222222222222222222222222222222222222222222222222222";

    exportOciRootfs({
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
    restoreEnv("PATH", oldPath);
    restoreEnv("FAKE_DOCKER_LOG", oldLog);
    restoreEnv("LOCAL_PLATFORM", oldLocalPlatform);
    restoreEnv("FAKE_REPO_DIGEST", oldRepoDigest);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci pullPolicy never: export create uses --pull=never", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-oci-pull-never-"),
  );
  const binDir = path.join(tmp, "bin");
  const rootfsDir = path.join(tmp, "rootfs");
  const logPath = path.join(tmp, "docker.log");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  writeFakeDockerRuntime(binDir);

  const oldPath = process.env.PATH;
  const oldLog = process.env.FAKE_DOCKER_LOG;
  const oldLocalPlatform = process.env.LOCAL_PLATFORM;
  const oldRepoDigest = process.env.FAKE_REPO_DIGEST;

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.FAKE_DOCKER_LOG = logPath;
    process.env.LOCAL_PLATFORM = "linux/amd64";
    process.env.FAKE_REPO_DIGEST =
      "docker.io/library/debian@sha256:3333333333333333333333333333333333333333333333333333333333333333";

    exportOciRootfs({
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
    assert.equal(
      lines.some((line) => line.startsWith("pull ")),
      false,
    );
  } finally {
    restoreEnv("PATH", oldPath);
    restoreEnv("FAKE_DOCKER_LOG", oldLog);
    restoreEnv("LOCAL_PLATFORM", oldLocalPlatform);
    restoreEnv("FAKE_REPO_DIGEST", oldRepoDigest);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci export: returns resolved image digest metadata", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-digest-"));
  const binDir = path.join(tmp, "bin");
  const rootfsDir = path.join(tmp, "rootfs");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  writeFakeDockerRuntime(binDir);

  const oldPath = process.env.PATH;
  const oldLocalPlatform = process.env.LOCAL_PLATFORM;
  const oldRepoDigest = process.env.FAKE_REPO_DIGEST;

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.LOCAL_PLATFORM = "linux/amd64";
    process.env.FAKE_REPO_DIGEST =
      "docker.io/library/debian@sha256:1111111111111111111111111111111111111111111111111111111111111111";

    const metadata = exportOciRootfs({
      arch: "x86_64",
      image: "docker.io/library/debian:bookworm-slim",
      runtime: "docker",
      platform: "linux/amd64",
      pullPolicy: "if-not-present",
      workDir: tmp,
      targetDir: rootfsDir,
      log: () => {},
    });

    assert.equal(metadata.reference, process.env.FAKE_REPO_DIGEST);
    assert.equal(
      metadata.digest,
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    );
  } finally {
    restoreEnv("PATH", oldPath);
    restoreEnv("LOCAL_PLATFORM", oldLocalPlatform);
    restoreEnv("FAKE_REPO_DIGEST", oldRepoDigest);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci export: fails when runtime does not report RepoDigests", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-oci-digest-missing-"),
  );
  const binDir = path.join(tmp, "bin");
  const rootfsDir = path.join(tmp, "rootfs");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  writeFakeDockerRuntime(binDir);

  const oldPath = process.env.PATH;
  const oldLocalPlatform = process.env.LOCAL_PLATFORM;
  const oldRepoDigest = process.env.FAKE_REPO_DIGEST;

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.LOCAL_PLATFORM = "linux/amd64";
    delete process.env.FAKE_REPO_DIGEST;

    assert.throws(
      () =>
        exportOciRootfs({
          arch: "x86_64",
          image: "docker.io/library/debian:bookworm-slim",
          runtime: "docker",
          platform: "linux/amd64",
          pullPolicy: "if-not-present",
          workDir: tmp,
          targetDir: rootfsDir,
          log: () => {},
        }),
      /did not report RepoDigests/,
    );
  } finally {
    restoreEnv("PATH", oldPath);
    restoreEnv("LOCAL_PLATFORM", oldLocalPlatform);
    restoreEnv("FAKE_REPO_DIGEST", oldRepoDigest);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
