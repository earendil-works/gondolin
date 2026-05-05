import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import assert from "node:assert/strict";
import test from "node:test";

import { findGuestSourceRoot, runPostbuild } from "../scripts/postbuild.mjs";

function makeHostPackage(root: string): string {
  const pkgRoot = path.join(root, "host");
  fs.mkdirSync(path.join(pkgRoot, "src", "vfs", "node", "vendored-node-vfs"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(pkgRoot, "src", "vfs", "node", "vendored-node-vfs", "stub.txt"),
    "vendored",
  );
  fs.mkdirSync(path.join(pkgRoot, "dist", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(pkgRoot, "dist", "src", "index.d.ts"),
    'export { foo } from "./foo.ts";\nexport type Bar = import("./bar.ts").Bar;\n',
  );
  return pkgRoot;
}

function makeGuestSource(root: string): string {
  const guestRoot = path.join(root, "guest");
  fs.mkdirSync(path.join(guestRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(guestRoot, "build.zig"), "// build\n");
  fs.writeFileSync(path.join(guestRoot, "build.zig.zon"), "{}\n");
  fs.writeFileSync(path.join(guestRoot, "src", "main.zig"), "// src\n");
  fs.writeFileSync(path.join(guestRoot, "LICENSE"), "license\n");
  return guestRoot;
}

test("postbuild: finds guest sources via GONDOLIN_GUEST_SRC", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-postbuild-script-"),
  );
  const pkgRoot = makeHostPackage(path.join(tmp, "standalone"));
  const guestRoot = makeGuestSource(path.join(tmp, "external"));
  let stderr = "";

  try {
    const result = runPostbuild({
      pkgRoot,
      cwd: path.join(tmp, "elsewhere"),
      env: { ...process.env, GONDOLIN_GUEST_SRC: guestRoot },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr += String(chunk);
          return true;
        },
      } as NodeJS.WritableStream,
    });

    assert.equal(result.guestSourceRoot, guestRoot);
    assert.equal(stderr, "");
    assert.ok(fs.existsSync(path.join(pkgRoot, "dist", "guest", "build.zig")));
    assert.ok(
      fs.existsSync(
        path.join(
          pkgRoot,
          "dist",
          "src",
          "vfs",
          "node",
          "vendored-node-vfs",
          "stub.txt",
        ),
      ),
    );
    assert.equal(
      fs.readFileSync(path.join(pkgRoot, "dist", "src", "index.d.ts"), "utf8"),
      'export { foo } from "./foo.js";\nexport type Bar = import("./bar.js").Bar;\n',
    );
    assert.equal(
      fs.readFileSync(path.join(pkgRoot, "dist", "src", "index.cjs"), "utf8"),
      '"use strict";\nmodule.exports = require("./index.js");\n',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("postbuild: skips guest bundling when guest sources are unavailable", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-postbuild-script-"),
  );
  const pkgRoot = makeHostPackage(path.join(tmp, "standalone"));
  const staleGuestDir = path.join(pkgRoot, "dist", "guest");
  fs.mkdirSync(staleGuestDir, { recursive: true });
  fs.writeFileSync(path.join(staleGuestDir, "stale.txt"), "stale\n");
  let stderr = "";

  try {
    const result = runPostbuild({
      pkgRoot,
      cwd: path.join(tmp, "elsewhere"),
      env: { ...process.env, GONDOLIN_GUEST_SRC: undefined },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr += String(chunk);
          return true;
        },
      } as NodeJS.WritableStream,
    });

    assert.equal(result.guestSourceRoot, null);
    assert.match(stderr, /missing guest source directory/);
    assert.equal(fs.existsSync(staleGuestDir), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("postbuild: guest source lookup matches sibling guest checkout layout", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-postbuild-script-"),
  );
  const repoRoot = path.join(tmp, "repo");
  const pkgRoot = makeHostPackage(repoRoot);
  const guestRoot = makeGuestSource(repoRoot);

  try {
    assert.equal(
      findGuestSourceRoot(pkgRoot, path.join(tmp, "elsewhere"), process.env),
      guestRoot,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
