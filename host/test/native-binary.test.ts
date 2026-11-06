import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  type NativeBinaryTarget,
  describeNativeExecutable,
  ensureNativeBinary,
  getNativeBinaryPath,
  nativeDaemonArgs,
  nativeDaemonCommand,
  nativePackageName,
  nativeRustTarget,
  resolveNativeBinary,
} from "../src/native/binary.ts";

/** Minimal executable header for `target` (enough for the header check). */
function fakeBinary(target: NativeBinaryTarget): Buffer {
  const buf = Buffer.alloc(64);
  if (target.platform === "linux") {
    buf.writeUInt32BE(0x7f454c46, 0);
    buf.writeUInt16LE(target.arch === "arm64" ? 0xb7 : 0x3e, 18);
  } else {
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(target.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  }
  return buf;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-native-bin-"));
}

/** A fake source checkout with the given files below native/target. */
function fakeCheckout(files: Record<string, Buffer>): string {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "native"), { recursive: true });
  fs.writeFileSync(path.join(root, "native", "Cargo.toml"), "");
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(root, "native", "target", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, { mode: 0o755 });
  }
  fs.mkdirSync(path.join(root, "host", "src"), { recursive: true });
  return root;
}

const host: NativeBinaryTarget | null =
  (process.platform === "darwin" || process.platform === "linux") &&
  (process.arch === "arm64" || process.arch === "x64")
    ? { platform: process.platform, arch: process.arch }
    : null;

test("native binary: names and rust targets", () => {
  assert.equal(
    nativePackageName({ platform: "linux", arch: "x64" }),
    "@earendil-works/gondolin-native-linux-x64",
  );
  assert.equal(
    nativeRustTarget({ platform: "linux", arch: "arm64" }),
    "aarch64-unknown-linux-musl",
  );
  assert.equal(
    nativeRustTarget({ platform: "darwin", arch: "x64" }),
    "x86_64-apple-darwin",
  );
  assert.throws(
    () => nativePackageName({ platform: "win32" as never, arch: "x64" }),
    /unsupported gondolind platform win32-x64/,
  );
});

test("native binary: executable headers", () => {
  const dir = tmpdir();
  for (const target of [
    { platform: "linux", arch: "arm64" },
    { platform: "linux", arch: "x64" },
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
  ] as NativeBinaryTarget[]) {
    const file = path.join(dir, `${target.platform}-${target.arch}`);
    fs.writeFileSync(file, fakeBinary(target));
    assert.deepEqual(describeNativeExecutable(file), target);
  }
  // The workspace placeholder is a node script, not a binary.
  const placeholder = path.join(
    import.meta.dirname,
    "..",
    "..",
    "packages",
    "gondolin-native-linux-x64",
    "bin",
    "gondolind",
  );
  assert.equal(describeNativeExecutable(placeholder), null);
  assert.equal(describeNativeExecutable(path.join(dir, "missing")), null);
});

test("native binary: remote targets come from the checkout's dist dir", () => {
  const linuxX64: NativeBinaryTarget = { platform: "linux", arch: "x64" };
  const root = fakeCheckout({
    "dist/x86_64-unknown-linux-musl/gondolin": fakeBinary(linuxX64),
    "dist/x86_64-unknown-linux-musl/gondolind": fakeBinary(linuxX64),
    // wrong architecture under the right name is ignored
    "dist/aarch64-unknown-linux-musl/gondolin": fakeBinary(linuxX64),
  });
  const start = path.join(root, "host", "src");
  // the multi-call binary is preferred and started as `gondolin daemon`
  assert.deepEqual(
    getNativeBinaryPath(linuxX64, { start, version: "0.0.0-test" }),
    {
      path: path.join(
        root,
        "native/target/dist/x86_64-unknown-linux-musl/gondolin",
      ),
      args: ["daemon"],
    },
  );
  assert.equal(
    getNativeBinaryPath(
      { platform: "linux", arch: "arm64" },
      { start, version: "0.0.0-test" },
    ),
    null,
  );
  // a daemon-only dist (older checkouts) still works, without arguments
  const old = fakeCheckout({
    "dist/x86_64-unknown-linux-musl/gondolind": fakeBinary(linuxX64),
  });
  assert.deepEqual(
    getNativeBinaryPath(linuxX64, {
      start: path.join(old, "host", "src"),
      version: "0.0.0-test",
    }),
    {
      path: path.join(
        old,
        "native/target/dist/x86_64-unknown-linux-musl/gondolind",
      ),
      args: [],
    },
  );
});

test("native binary: daemon arguments follow the binary name", () => {
  assert.deepEqual(nativeDaemonArgs("/x/gondolin"), ["daemon"]);
  assert.deepEqual(nativeDaemonArgs("/x/gondolind"), []);
  assert.deepEqual(nativeDaemonCommand("/x/gondolin"), [
    "/x/gondolin",
    "daemon",
  ]);
  assert.deepEqual(nativeDaemonCommand("/x/gondolind"), ["/x/gondolind"]);
});

test("native binary: newest local build wins for this machine", {
  skip: host === null,
}, () => {
  const root = fakeCheckout({
    "release/gondolind": fakeBinary(host!),
    "debug/gondolind": fakeBinary(host!),
    "debug/gondolin": fakeBinary(host!),
  });
  const release = path.join(root, "native/target/release/gondolind");
  const debug = path.join(root, "native/target/debug/gondolind");
  const debugCli = path.join(root, "native/target/debug/gondolin");
  const start = path.join(root, "host", "src");
  const now = Date.now() / 1000;
  fs.utimesSync(release, now - 100, now - 100);
  fs.utimesSync(debugCli, now - 50, now - 50);
  fs.utimesSync(debug, now, now);
  assert.equal(resolveNativeBinary({}, start), debug);
  fs.utimesSync(release, now + 10, now + 10);
  assert.equal(resolveNativeBinary({}, start), release);
  fs.utimesSync(debugCli, now + 20, now + 20);
  assert.equal(resolveNativeBinary({}, start), debugCli);
  assert.equal(
    resolveNativeBinary({ GONDOLIN_NATIVE_BIN: "/explicit/gondolind" }, start),
    "/explicit/gondolind",
  );
});

/** A one-file npm package tarball (`package/bin/gondolin`). */
function packageTarball(content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write("package/bin/gondolin", 0);
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.fill(" ", 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(body);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}

test("native binary: ensureNativeBinary fetches and caches the package", async () => {
  const target: NativeBinaryTarget = { platform: "linux", arch: "arm64" };
  const cache = tmpdir();
  const savedXdg = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try {
    const tgz = packageTarball(fakeBinary(target));
    const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
    const requests: string[] = [];
    const fakeFetch = (async (url: string) => {
      requests.push(url);
      if (url.endsWith("/9.9.9")) {
        return new Response(
          JSON.stringify({
            dist: { tarball: "https://registry.test/pkg.tgz", integrity },
          }),
        );
      }
      if (url === "https://registry.test/pkg.tgz") return new Response(tgz);
      return new Response("", { status: 404, statusText: "Not Found" });
    }) as typeof fetch;

    const start = tmpdir(); // no checkout
    const binary = await ensureNativeBinary(target, {
      start,
      version: "9.9.9",
      registry: "https://registry.test/",
      fetch: fakeFetch,
    });
    const file = binary.path;
    assert.deepEqual(binary, {
      path: path.join(
        cache,
        "gondolin",
        "native",
        "9.9.9",
        "linux-arm64",
        "gondolin",
      ),
      args: ["daemon"],
    });
    assert.deepEqual(describeNativeExecutable(file), target);
    assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    assert.deepEqual(requests, [
      "https://registry.test/@earendil-works%2fgondolin-native-linux-arm64/9.9.9",
      "https://registry.test/pkg.tgz",
    ]);
    // Second call: served from the cache.
    assert.deepEqual(
      await ensureNativeBinary(target, {
        start,
        version: "9.9.9",
        fetch: fakeFetch,
      }),
      binary,
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(
      getNativeBinaryPath(target, { start, version: "9.9.9" }),
      binary,
    );

    // Tampered tarball: integrity check fails, nothing cached.
    const badFetch = (async (url: string) =>
      url.endsWith("/8.8.8")
        ? new Response(
            JSON.stringify({
              dist: { tarball: "https://registry.test/bad.tgz", integrity },
            }),
          )
        : new Response(
            packageTarball(Buffer.from("not a binary")),
          )) as typeof fetch;
    await assert.rejects(
      ensureNativeBinary(target, {
        start,
        version: "8.8.8",
        registry: "https://registry.test",
        fetch: badFetch,
      }),
      /integrity mismatch/,
    );
    await assert.rejects(
      ensureNativeBinary(target, {
        start,
        version: "7.7.7",
        registry: "https://registry.test",
        fetch: fakeFetch,
      }),
      /failed to fetch @earendil-works\/gondolin-native-linux-arm64@7.7.7 metadata: 404/,
    );
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = savedXdg;
  }
});
