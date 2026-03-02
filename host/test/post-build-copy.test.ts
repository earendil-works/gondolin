import fs from "fs";
import os from "os";
import path from "path";

import assert from "node:assert/strict";
import test from "node:test";

import { applyPostBuildCopies } from "../src/alpine/post-build-copy.ts";

test("postBuild.copy: copies files and directory contents into rootfs", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-postbuild-copy-"),
  );
  const rootfsDir = path.join(tmp, "rootfs");
  const srcDir = path.join(tmp, "src");

  fs.mkdirSync(rootfsDir, { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });

  const sourceFile = path.join(srcDir, "tool.tar.gz");
  fs.writeFileSync(sourceFile, "archive");

  const sourceTree = path.join(srcDir, "tree");
  fs.mkdirSync(path.join(sourceTree, "nested"), { recursive: true });
  fs.writeFileSync(path.join(sourceTree, "nested", "a.txt"), "A");

  try {
    applyPostBuildCopies(
      rootfsDir,
      [
        { src: sourceFile, dest: "/tmp/" },
        { src: sourceTree, dest: "/opt/data" },
      ],
      () => {},
    );

    assert.equal(
      fs.readFileSync(path.join(rootfsDir, "tmp", "tool.tar.gz"), "utf8"),
      "archive",
    );
    assert.equal(
      fs.readFileSync(
        path.join(rootfsDir, "opt", "data", "nested", "a.txt"),
        "utf8",
      ),
      "A",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("postBuild.copy: rejects non-absolute guest destinations", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-postbuild-copy-"),
  );
  const rootfsDir = path.join(tmp, "rootfs");
  const sourceFile = path.join(tmp, "tool.tar.gz");

  fs.mkdirSync(rootfsDir, { recursive: true });
  fs.writeFileSync(sourceFile, "archive");

  try {
    assert.throws(
      () =>
        applyPostBuildCopies(
          rootfsDir,
          [{ src: sourceFile, dest: "tmp/tool.tar.gz" }],
          () => {},
        ),
      /destination must be an absolute guest path/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
