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
  getKernelCode?: Buffer,
): Buffer {
  const dynstr = Buffer.from("\0KERNEL_BUNDLE\0krunfw_get_kernel\0", "utf8");
  const shstr = Buffer.from("\0.dynsym\0.dynstr\0.bundle\0.shstrtab\0", "utf8");

  const dynstrOffset = 0x100;
  const dynsymOffset = 0x140;
  const bundleOffset = 0x200;
  const bundleAddress = 0x5000;
  // krunfw_get_kernel's code follows the bundle (and its sentinel area)
  const codeInSection = payloadOffsetInSection + payload.length + 8;
  const code = getKernelCode ?? Buffer.alloc(0);
  const symbolCount = getKernelCode ? 3 : 2;

  const shstrOffset = align(bundleOffset + codeInSection + code.length, 0x10);
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
  if (getKernelCode) {
    const funcOffset = symbolOffset + DYNSYM_ENTRY_SIZE;
    writeU32LE(buf, funcOffset + 0, dynstr.indexOf("krunfw_get_kernel"));
    buf.writeUInt8(0x12, funcOffset + 4); // STB_GLOBAL | STT_FUNC
    writeU16LE(buf, funcOffset + 6, 3);
    writeU64LE(buf, funcOffset + 8, bundleAddress + codeInSection);
    writeU64LE(buf, funcOffset + 16, code.length);
    code.copy(buf, bundleOffset + codeInSection);
  }
  shstr.copy(buf, shstrOffset);

  writeSectionHeader(buf, sectionHeaderOffset, 1, {
    nameOffset: shstr.indexOf(".dynsym"),
    type: 11,
    address: dynsymOffset,
    fileOffset: dynsymOffset,
    size: DYNSYM_ENTRY_SIZE * symbolCount,
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
    size: codeInSection + code.length,
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

test("extractKernelBundleFromCSource decodes generated kernel source", () => {
  const source = [
    "#include <stddef.h>",
    "char KERNEL_BUNDLE[] =",
    '"\\x41\\0"',
    '"B\\n\\123"',
    '"";',
    "char * krunfw_get_kernel(size_t *load_addr, size_t *entry_addr, size_t *size) {",
    "  *size = sizeof(KERNEL_BUNDLE) - 1;",
    "  return &KERNEL_BUNDLE[0];",
    "}",
  ].join("\n");

  const extracted = nativeBuildTest.extractKernelBundleFromCSource(source);

  assert.deepEqual(extracted, Buffer.from([0x41, 0x00, 0x42, 0x0a, 0o123]));
});

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

/** `krunfw_get_kernel` of libkrunfw v5.2.1 for x86_64 (built without optimization) */
const GET_KERNEL_O0 = Buffer.from(
  "f30f1efa554889e548897df8488975f0488955e8488b45f848c70000000001" +
    "488b45f048c70023010001488b45e848c70000002301488b05a32e00005dc3",
  "hex",
);

test("readKrunfwAddressesFromSharedLibraryBytes reads libkrunfw's x86_64 addresses", () => {
  // the size store (0x1230000) is the bundle's size and is skipped
  const bundleSize = 0x1230000;
  const fake = buildFakeSharedLib(62, Buffer.from("bundle"), 3, GET_KERNEL_O0);
  assert.deepEqual(
    nativeBuildTest.readKrunfwAddressesFromSharedLibraryBytes(
      fake,
      "x86_64",
      bundleSize,
    ),
    { loadAddr: 0x1000000, entryAddr: 0x1000123 },
  );

  // optimized code stores through the argument registers, in any order
  const o2 = Buffer.from(
    "48c70200002301" + "48c70623010001" + "48c70700000001" + "c3",
    "hex",
  );
  const fakeO2 = buildFakeSharedLib(62, Buffer.from("bundle"), 3, o2);
  assert.deepEqual(
    nativeBuildTest.readKrunfwAddressesFromSharedLibraryBytes(
      fakeO2,
      "x86_64",
      bundleSize,
    ),
    { loadAddr: 0x1000000, entryAddr: 0x1000123 },
  );
});

test("readKrunfwAddressesFromSharedLibraryBytes refuses to guess", () => {
  // two plausible entry points
  const code = Buffer.from(
    "48c70700000001" + "48c70623010001" + "48c70245010001" + "c3",
    "hex",
  );
  const fake = buildFakeSharedLib(62, Buffer.from("bundle"), 3, code);
  assert.throws(
    () =>
      nativeBuildTest.readKrunfwAddressesFromSharedLibraryBytes(
        fake,
        "x86_64",
        0x1230000,
      ),
    /cannot tell the load and entry addresses apart/,
  );
  // no krunfw_get_kernel
  assert.throws(
    () =>
      nativeBuildTest.readKrunfwAddressesFromSharedLibraryBytes(
        buildFakeSharedLib(62, Buffer.from("bundle")),
        "x86_64",
        0x1230000,
      ),
    /does not expose krunfw_get_kernel/,
  );
});

test("krunKernelImage wraps x86_64 kernels in an ELF with their addresses", () => {
  const bundle = Buffer.from("kernel-bytes");
  const elf = nativeBuildTest.krunKernelImage(
    { bundle, loadAddr: 0x1000000, entryAddr: 0x1000123 },
    "x86_64",
  );
  assert.deepEqual(elf.subarray(0, 4), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  assert.equal(elf.readUInt16LE(16), 2); // ET_EXEC
  assert.equal(elf.readUInt16LE(18), 62); // EM_X86_64
  assert.equal(elf.readBigUInt64LE(24), 0x1000123n); // e_entry
  assert.equal(elf.readUInt16LE(56), 1); // one program header
  const ph = Number(elf.readBigUInt64LE(32));
  assert.equal(elf.readUInt32LE(ph), 1); // PT_LOAD
  const offset = Number(elf.readBigUInt64LE(ph + 8));
  assert.equal(elf.readBigUInt64LE(ph + 24), 0x1000000n); // p_paddr
  assert.equal(elf.readBigUInt64LE(ph + 32), BigInt(bundle.length));
  assert.deepEqual(elf.subarray(offset), bundle);

  // aarch64 kernels stay raw (libkrun's default address is theirs)
  assert.deepEqual(
    nativeBuildTest.krunKernelImage({ bundle }, "aarch64"),
    bundle,
  );
  assert.throws(
    () => nativeBuildTest.krunKernelImage({ bundle }, "x86_64"),
    /cannot determine the load and entry addresses/,
  );
});
