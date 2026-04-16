import fs from "fs";
import os from "os";
import path from "path";

import assert from "node:assert/strict";
import test from "node:test";

import {
  __test as ociTest,
  buildOciCreateArgs,
  exportOciRootfs,
} from "../src/alpine/oci.ts";
import {
  assertSafeWritePath,
  ensureRootfsShell,
  hardenExtractedRootfs,
} from "../src/alpine/rootfs.ts";
import { syncKernelModules } from "../src/alpine/kernel-modules.ts";

const skipWindowsOciRuntimeTests =
  process.platform === "win32"
    ? "OCI docker runtime tests require POSIX shell/tar semantics"
    : false;

const skipWindowsAbsoluteSymlinkRewriteTest =
  process.platform === "win32"
    ? "Windows host symlink APIs rewrite absolute targets differently"
    : false;

interface TarFixtureEntry {
  /** tar entry path */
  name: string;
  /** tar entry type flag */
  type: "0" | "5";
  /** tar entry owner uid */
  uid: number;
  /** tar entry owner gid */
  gid: number;
  /** file payload */
  content?: string;
}

function createTarArchive(entries: TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const payload = Buffer.from(entry.content ?? "", "utf8");
    const size = entry.type === "0" ? payload.length : 0;
    const header = Buffer.alloc(512, 0);

    writeTarString(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, entry.type === "5" ? 0o755 : 0o644);
    writeTarOctal(header, 108, 8, entry.uid);
    writeTarOctal(header, 116, 8, entry.gid);
    writeTarOctal(header, 124, 12, size);
    writeTarOctal(header, 136, 12, 0);
    header[156] = entry.type.charCodeAt(0);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");

    for (let idx = 148; idx < 156; idx += 1) {
      header[idx] = 0x20;
    }
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    const checksumField = `${checksum.toString(8).padStart(6, "0")}\0 `;
    writeTarString(header, 148, 8, checksumField);

    blocks.push(header);
    if (size > 0) {
      blocks.push(payload);
      const pad = (512 - (size % 512)) % 512;
      if (pad > 0) {
        blocks.push(Buffer.alloc(pad, 0));
      }
    }
  }

  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

function writeTarString(
  header: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const encoded = Buffer.from(value, "utf8");
  encoded.copy(header, offset, 0, Math.min(encoded.length, length));
}

function writeTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeTarString(header, offset, length, encoded);
}

function writeCreateFailRuntime(binDir: string): void {
  const runtimePath = path.join(binDir, "docker");
  fs.writeFileSync(
    runtimePath,
    `#!/bin/sh
set -eu

cmd="\${1:-}"
if [ "$cmd" = "--version" ]; then
  printf "Docker fake 1.0\\n"
  exit 0
fi

if [ "$cmd" = "create" ]; then
  printf "daemon unavailable\\n" >&2
  exit 125
fi

exit 0
`,
    { mode: 0o755 },
  );
}

function writeLargePullRuntime(binDir: string): void {
  const runtimePath = path.join(binDir, "docker");
  fs.writeFileSync(
    runtimePath,
    `#!/bin/sh
set -eu

cmd="\${1:-}"
if [ "$cmd" = "--version" ]; then
  printf "Docker fake 1.0\\n"
  exit 0
fi

if [ "$cmd" = "pull" ]; then
  # Emit >1MB to stderr to verify maxBuffer handling
  i=0
  while [ "$i" -lt 20000 ]; do
    printf "layer output line %05d: abcdefghijklmnopqrstuvwxyz0123456789\\n" "$i" >&2
    i=$((i + 1))
  done
  exit 0
fi

if [ "$cmd" = "create" ]; then
  printf "cid-large-pull\\n"
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
fi

if [ "$cmd" = "rm" ]; then
  exit 0
fi

exit 0
`,
    { mode: 0o755 },
  );
}

test("oci rootfs: buildOciCreateArgs includes dummy command", () => {
  const args = buildOciCreateArgs(
    "docker.io/library/debian:bookworm-slim",
    "linux/amd64",
    "never",
  ) as string[];

  assert.deepEqual(args, [
    "create",
    "--platform",
    "linux/amd64",
    "--pull=never",
    "docker.io/library/debian:bookworm-slim",
    "true",
  ]);
});

test("oci rootfs: tar ownership parser preserves uid/gid metadata", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-tar-owners-"));
  const tarPath = path.join(tmp, "rootfs.tar");

  try {
    const archive = createTarArchive([
      {
        name: "etc/",
        type: "5",
        uid: 0,
        gid: 0,
      },
      {
        name: "home/myuser/",
        type: "5",
        uid: 1001,
        gid: 1001,
      },
      {
        name: "home/myuser/.profile",
        type: "0",
        uid: 1001,
        gid: 1001,
        content: "export PATH=/usr/bin\n",
      },
      {
        name: "home/bad\npath",
        type: "0",
        uid: 1337,
        gid: 1337,
        content: "ignored\n",
      },
    ]);

    fs.writeFileSync(tarPath, archive);

    const ownership = ociTest.readTarOwnershipEntries(tarPath);
    ownership.sort((a, b) => a.path.localeCompare(b.path));

    assert.deepEqual(ownership, [
      { path: "etc", uid: 0, gid: 0 },
      { path: "home/myuser", uid: 1001, gid: 1001 },
      { path: "home/myuser/.profile", uid: 1001, gid: 1001 },
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test(
  "oci rootfs: pullPolicy always tolerates large pull output",
  { skip: skipWindowsOciRuntimeTests },
  () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-oci-large-pull-"),
  );
  const binDir = path.join(tmp, "bin");
  const rootfsDir = path.join(tmp, "rootfs");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(rootfsDir, { recursive: true });
  writeLargePullRuntime(binDir);

  const oldPath = process.env.PATH;
  const oldRepoDigest = process.env.FAKE_REPO_DIGEST;

  try {
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.FAKE_REPO_DIGEST =
      "docker.io/library/debian@sha256:4444444444444444444444444444444444444444444444444444444444444444";

    exportOciRootfs({
      arch: "x86_64",
      image: "docker.io/library/debian:bookworm-slim",
      runtime: "docker",
      platform: "linux/amd64",
      pullPolicy: "always",
      workDir: tmp,
      targetDir: rootfsDir,
      log: () => {},
    });

    assert.equal(fs.existsSync(path.join(rootfsDir, "bin", "sh")), true);
  } finally {
    process.env.PATH = oldPath;
    if (oldRepoDigest === undefined) {
      delete process.env.FAKE_REPO_DIGEST;
    } else {
      process.env.FAKE_REPO_DIGEST = oldRepoDigest;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
},
);

test(
  "oci rootfs: pullPolicy never propagates non-missing runtime errors",
  { skip: skipWindowsOciRuntimeTests },
  () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "gondolin-oci-runtime-fail-"),
    );
    const binDir = path.join(tmp, "bin");
    const rootfsDir = path.join(tmp, "rootfs");

    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(rootfsDir, { recursive: true });
    writeCreateFailRuntime(binDir);

    const oldPath = process.env.PATH;

    try {
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;

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
        /daemon unavailable/,
      );
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test("oci rootfs: hardenExtractedRootfs rejects escaping relative symlinks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-symlink-"));
  const rootfsDir = path.join(tmp, "rootfs");

  fs.mkdirSync(rootfsDir, { recursive: true });
  fs.symlinkSync("../../../../tmp/escape", path.join(rootfsDir, "usr"));

  try {
    assert.throws(
      () => hardenExtractedRootfs(rootfsDir),
      /escaping the rootfs/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test(
  "oci rootfs: hardenExtractedRootfs rewrites absolute symlinks",
  { skip: skipWindowsAbsoluteSymlinkRewriteTest },
  () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "gondolin-oci-symlink-"),
    );
    const rootfsDir = path.join(tmp, "rootfs");

    fs.mkdirSync(path.join(rootfsDir, "tmp", "hostdir"), { recursive: true });
    fs.symlinkSync("/tmp/hostdir", path.join(rootfsDir, "usr"));

    try {
      hardenExtractedRootfs(rootfsDir);

      assert.equal(fs.readlinkSync(path.join(rootfsDir, "usr")), "tmp/hostdir");
      assert.throws(
        () =>
          assertSafeWritePath(
            path.join(rootfsDir, "usr", "bin", "sandboxd"),
            rootfsDir,
          ),
        /symlinked path/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test("oci rootfs: syncKernelModules handles /lib -> usr/lib symlink", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-modules-"));
  const rootfsDir = path.join(tmp, "rootfs");
  const initramfsDir = path.join(tmp, "initramfs");
  const kernelVersion = "6.18.9-0-virt";

  fs.mkdirSync(path.join(rootfsDir, "usr", "lib"), { recursive: true });
  fs.symlinkSync("usr/lib", path.join(rootfsDir, "lib"));

  const initModuleDir = path.join(
    initramfsDir,
    "lib",
    "modules",
    kernelVersion,
    "kernel",
    "drivers",
    "block",
  );
  fs.mkdirSync(initModuleDir, { recursive: true });
  fs.writeFileSync(path.join(initModuleDir, "virtio_blk.ko"), "module");

  try {
    syncKernelModules(rootfsDir, initramfsDir, () => {}, {
      copyRootfsToInitramfs: false,
    });

    assert.equal(
      fs.existsSync(
        path.join(
          rootfsDir,
          "usr",
          "lib",
          "modules",
          kernelVersion,
          "kernel",
          "drivers",
          "block",
          "virtio_blk.ko",
        ),
      ),
      true,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci rootfs: ensureRootfsShell bootstraps busybox from initramfs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-shell-"));
  const rootfsDir = path.join(tmp, "rootfs");
  const initramfsDir = path.join(tmp, "initramfs");

  fs.mkdirSync(path.join(rootfsDir, "usr", "bin"), { recursive: true });
  fs.symlinkSync("usr/bin", path.join(rootfsDir, "bin"));

  fs.mkdirSync(path.join(initramfsDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(initramfsDir, "sbin"), { recursive: true });
  fs.writeFileSync(path.join(initramfsDir, "bin", "busybox"), "busybox");
  fs.symlinkSync("/bin/busybox", path.join(initramfsDir, "bin", "sh"));
  fs.symlinkSync("/bin/busybox", path.join(initramfsDir, "bin", "grep"));
  fs.symlinkSync("../bin/busybox", path.join(initramfsDir, "sbin", "modprobe"));

  try {
    ensureRootfsShell(
      rootfsDir,
      "gcr.io/distroless/nodejs24-debian12",
      initramfsDir,
      () => {},
    );

    assert.equal(fs.existsSync(path.join(rootfsDir, "bin", "sh")), true);
    assert.equal(fs.existsSync(path.join(rootfsDir, "bin", "busybox")), true);
    assert.equal(fs.existsSync(path.join(rootfsDir, "sbin", "modprobe")), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oci rootfs: ensureRootfsShell accepts absolute /bin/sh symlink", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-oci-shell-"));
  const rootfsDir = path.join(tmp, "rootfs");

  fs.mkdirSync(path.join(rootfsDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(rootfsDir, "bin", "busybox"), "busybox");
  fs.symlinkSync("/bin/busybox", path.join(rootfsDir, "bin", "sh"));

  try {
    assert.doesNotThrow(() => {
      ensureRootfsShell(rootfsDir, "alpine:3.23", undefined, () => {});
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
