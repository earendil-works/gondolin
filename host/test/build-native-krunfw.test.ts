import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DownloadFileError } from "../src/alpine/utils.ts";
import { __test as nativeBuildTest } from "../src/build/native.ts";

const ELF_HEADER_SIZE = 64;
const SECTION_HEADER_SIZE = 64;
const DYNSYM_ENTRY_SIZE = 24;

function align(value: number, alignment: number): number {
  const remainder = value % alignment;
  return remainder === 0 ? value : value + (alignment - remainder);
}

function writeU16LE(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt16LE(value, offset);
}

function writeU32LE(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt32LE(value, offset);
}

function writeU64LE(buf: Buffer, offset: number, value: number): void {
  buf.writeBigUInt64LE(BigInt(value), offset);
}

function writeSectionHeader(
  buf: Buffer,
  tableOffset: number,
  index: number,
  options: {
    nameOffset: number;
    type: number;
    address: number;
    fileOffset: number;
    size: number;
    link?: number;
    align?: number;
    entrySize?: number;
  },
): void {
  const offset = tableOffset + index * SECTION_HEADER_SIZE;

  writeU32LE(buf, offset + 0, options.nameOffset);
  writeU32LE(buf, offset + 4, options.type);
  writeU64LE(buf, offset + 8, 0);
  writeU64LE(buf, offset + 16, options.address);
  writeU64LE(buf, offset + 24, options.fileOffset);
  writeU64LE(buf, offset + 32, options.size);
  writeU32LE(buf, offset + 40, options.link ?? 0);
  writeU32LE(buf, offset + 44, 0);
  writeU64LE(buf, offset + 48, options.align ?? 1);
  writeU64LE(buf, offset + 56, options.entrySize ?? 0);
}

function buildFakeSharedLib(
  machine: 62 | 183,
  payload: Buffer,
  payloadOffsetInSection = 3,
): Buffer {
  const dynstr = Buffer.from("\0KERNEL_BUNDLE\0", "utf8");
  const shstr = Buffer.from("\0.dynsym\0.dynstr\0.bundle\0.shstrtab\0", "utf8");

  const dynstrOffset = 0x100;
  const dynsymOffset = 0x140;
  const bundleOffset = 0x180;
  const bundleAddress = 0x5000;

  const shstrOffset = align(
    bundleOffset + payloadOffsetInSection + payload.length + 8,
    0x10,
  );
  const sectionHeaderOffset = align(shstrOffset + shstr.length, 0x40);
  const sectionCount = 5;
  const totalSize = sectionHeaderOffset + sectionCount * SECTION_HEADER_SIZE;

  const buf = Buffer.alloc(totalSize);

  // ELF ident
  buf.set([0x7f, 0x45, 0x4c, 0x46], 0);
  buf.writeUInt8(2, 4); // ELFCLASS64
  buf.writeUInt8(1, 5); // little-endian
  buf.writeUInt8(1, 6); // ELF version

  // ELF header
  writeU16LE(buf, 16, 3); // ET_DYN
  writeU16LE(buf, 18, machine);
  writeU32LE(buf, 20, 1);
  writeU16LE(buf, 52, ELF_HEADER_SIZE);
  writeU64LE(buf, 40, sectionHeaderOffset);
  writeU16LE(buf, 58, SECTION_HEADER_SIZE);
  writeU16LE(buf, 60, sectionCount);
  writeU16LE(buf, 62, 4); // .shstrtab index

  dynstr.copy(buf, dynstrOffset);

  // dynsym: null entry + KERNEL_BUNDLE entry
  const symbolOffset = dynsymOffset + DYNSYM_ENTRY_SIZE;
  writeU32LE(buf, symbolOffset + 0, 1); // "KERNEL_BUNDLE" in dynstr
  buf.writeUInt8(0x11, symbolOffset + 4); // STB_GLOBAL | STT_OBJECT
  buf.writeUInt8(0, symbolOffset + 5);
  writeU16LE(buf, symbolOffset + 6, 3); // section index (.bundle)
  writeU64LE(buf, symbolOffset + 8, bundleAddress + payloadOffsetInSection);
  writeU64LE(buf, symbolOffset + 16, payload.length);

  payload.copy(buf, bundleOffset + payloadOffsetInSection);
  shstr.copy(buf, shstrOffset);

  writeSectionHeader(buf, sectionHeaderOffset, 1, {
    nameOffset: shstr.indexOf(".dynsym"),
    type: 11,
    address: dynsymOffset,
    fileOffset: dynsymOffset,
    size: DYNSYM_ENTRY_SIZE * 2,
    link: 2,
    align: 8,
    entrySize: DYNSYM_ENTRY_SIZE,
  });

  writeSectionHeader(buf, sectionHeaderOffset, 2, {
    nameOffset: shstr.indexOf(".dynstr"),
    type: 3,
    address: dynstrOffset,
    fileOffset: dynstrOffset,
    size: dynstr.length,
    align: 1,
  });

  writeSectionHeader(buf, sectionHeaderOffset, 3, {
    nameOffset: shstr.indexOf(".bundle"),
    type: 1,
    address: bundleAddress,
    fileOffset: bundleOffset,
    size: payloadOffsetInSection + payload.length + 8,
    align: 16,
  });

  writeSectionHeader(buf, sectionHeaderOffset, 4, {
    nameOffset: shstr.indexOf(".shstrtab"),
    type: 3,
    address: shstrOffset,
    fileOffset: shstrOffset,
    size: shstr.length,
    align: 1,
  });

  return buf;
}

test("extractKernelBundleFromSharedLibraryBytes extracts x86_64 bundle", () => {
  const payload = Buffer.from("x86-kernel-bundle", "utf8");
  const fake = buildFakeSharedLib(62, payload);

  const extracted = nativeBuildTest.extractKernelBundleFromSharedLibraryBytes(
    fake,
    "x86_64",
  );

  assert.deepEqual(extracted, payload);
});

test("extractKernelBundleFromSharedLibraryBytes extracts aarch64 bundle", () => {
  const payload = Buffer.from("arm64-kernel-bundle", "utf8");
  const fake = buildFakeSharedLib(183, payload);

  const extracted = nativeBuildTest.extractKernelBundleFromSharedLibraryBytes(
    fake,
    "aarch64",
  );

  assert.deepEqual(extracted, payload);
});

test("extractKernelBundleFromSharedLibraryBytes trims trailing NUL sentinel", () => {
  const payloadWithSentinel = Buffer.concat([
    Buffer.from("bundle", "utf8"),
    Buffer.from([0]),
  ]);
  const fake = buildFakeSharedLib(62, payloadWithSentinel);

  const extracted = nativeBuildTest.extractKernelBundleFromSharedLibraryBytes(
    fake,
    "x86_64",
  );

  assert.deepEqual(extracted, Buffer.from("bundle", "utf8"));
});

test("extractKernelBundleFromSharedLibraryBytes rejects machine mismatch", () => {
  const payload = Buffer.from("bundle", "utf8");
  const fake = buildFakeSharedLib(62, payload);

  assert.throws(
    () =>
      nativeBuildTest.extractKernelBundleFromSharedLibraryBytes(
        fake,
        "aarch64",
      ),
    /does not match expected 183/,
  );
});

test("downloadKrunArchive falls back on structured 404 status", async () => {
  const cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-krun-test-"),
  );
  const requestedUrls: string[] = [];

  try {
    const archive = await nativeBuildTest.downloadKrunArchive(
      "v-test",
      "x86_64",
      cacheDir,
      () => {},
      async (url, dest) => {
        requestedUrls.push(url);
        if (url.endsWith("/libkrunfw-prebuilt-x86_64.tgz")) {
          throw new DownloadFileError(url, { status: 404 });
        }
        fs.writeFileSync(dest, "shared");
      },
    );

    assert.equal(archive.kind, "shared");
    assert.equal(path.basename(archive.archivePath), "libkrunfw-x86_64.tgz");
    assert.deepEqual(requestedUrls, [
      "https://github.com/containers/libkrunfw/releases/download/v-test/libkrunfw-prebuilt-x86_64.tgz",
      "https://github.com/containers/libkrunfw/releases/download/v-test/libkrunfw-x86_64.tgz",
    ]);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("generateWasmEntrypointScript installs merged MITM CA bundle", () => {
  const script = nativeBuildTest.generateWasmEntrypointScript();

  assert.match(script, /setup_mitm_ca\(\)/);
  assert.match(script, /runtime_ca_bundle="\/run\/gondolin\/ca-certificates\.crt"/);
  assert.match(script, /mkdir -p \/run\/gondolin/);
  assert.match(script, /export SSL_CERT_FILE="\$\{runtime_ca_bundle\}"/);
  assert.match(script, /export CURL_CA_BUNDLE="\$\{runtime_ca_bundle\}"/);
  assert.match(script, /export REQUESTS_CA_BUNDLE="\$\{runtime_ca_bundle\}"/);
  assert.match(script, /export NODE_EXTRA_CA_CERTS="\$\{mitm_ca_cert\}"/);
});

test("generateWasmEntrypointScript loads baked image environment", () => {
  const script = nativeBuildTest.generateWasmEntrypointScript();

  assert.match(script, /\/etc\/profile\.d\/gondolin-image-env\.sh/);
  assert.match(script, /\. \/etc\/profile\.d\/gondolin-image-env\.sh/);
});

test("patchC2wDockerfileForFuse enables CAP_SYS_ADMIN and FUSE", () => {
  const input = [
    "FROM golang-base AS bundle-dev",
    "ARG TARGETPLATFORM",
    "ARG INIT_DEBUG",
    "ARG OPTIMIZATION_MODE",
    "ARG NO_VMTOUCH",
    "ARG NO_BINFMT",
    "ARG EXTERNAL_BUNDLE",
    "COPY --link --from=assets / /work",
    "WORKDIR /work",
    "RUN if test -f image.json; then mv image.json /out/oci/ ; fi && \\",
    "    if test -f spec.json; then mv spec.json /out/oci/ ; fi",
    "FROM linux-riscv64-dev-common AS linux-riscv64-dev",
    "WORKDIR /work-buildlinux/linux",
    "COPY --link --from=assets /config/tinyemu/linux_rv64_config ./.config",
    "RUN make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- -j$(nproc) all && \\",
    "    mkdir /out && \\",
    "    mv /work-buildlinux/linux/arch/riscv/boot/Image /out/Image && \\",
    "    make clean",
    "FROM linux-riscv64-dev-common AS linux-riscv64-config-dev",
    "WORKDIR /work-buildlinux/linux",
    "COPY --link --from=assets /config/tinyemu/linux_rv64_config ./.config",
    "RUN make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- olddefconfig",
  ].join("\n");

  const patched = nativeBuildTest.patchC2wDockerfileForFuse(input);

  assert.match(patched, /CAP_SYS_ADMIN/);
  assert.match(patched, /\/dev\/fuse/);
  assert.match(patched, /apt-get update && apt-get install -y jq/);
  assert.match(patched, /CONFIG_FUSE_FS=y/);
  assert.match(patched, /CONFIG_CUSE=y/);
});

test("resolveWasmTargetArch prefers oci platform override", () => {
  assert.equal(
    nativeBuildTest.resolveWasmTargetArch({
      arch: "aarch64",
      distro: "alpine",
      oci: { image: "alpine:3.23", platform: "linux/riscv64" },
      wasm: { enabled: true },
    }),
    "riscv64",
  );
});

test("downloadKrunArchive does not fallback on message-only 404 text", async () => {
  const cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-krun-test-"),
  );
  const requestedUrls: string[] = [];

  try {
    await assert.rejects(
      nativeBuildTest.downloadKrunArchive(
        "v-test",
        "x86_64",
        cacheDir,
        () => {},
        async (url) => {
          requestedUrls.push(url);
          throw new Error(`Failed to download ${url}: HTTP 404`);
        },
      ),
      /HTTP 404/,
    );

    assert.deepEqual(requestedUrls, [
      "https://github.com/containers/libkrunfw/releases/download/v-test/libkrunfw-prebuilt-x86_64.tgz",
    ]);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
