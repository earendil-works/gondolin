import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VmCheckpoint, __test as checkpointTest } from "../src/checkpoint.ts";

test("checkpoint: resolveAssetDirByBuildId rejects traversal payloads", () => {
  assert.throws(
    () => checkpointTest.resolveAssetDirByBuildId("../escaped"),
    /invalid image build id: \.\.\/escaped/,
  );
});

test("checkpoint: resolveAssetDirByBuildId rejects uppercase build ids", () => {
  assert.throws(
    () =>
      checkpointTest.resolveAssetDirByBuildId(
        "E44F6AA3-4739-5E76-A31D-5A221A55CC7F",
      ),
    /invalid image build id/,
  );
});

test("checkpoint: load rejects legacy directory checkpoint paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-checkpoint-"));

  try {
    assert.throws(
      () => VmCheckpoint.load(dir),
      /must be a \.qcow2 file, got directory/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint: load rejects legacy checkpoint.json format", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-checkpoint-"));
  const jsonPath = path.join(dir, "checkpoint.json");
  fs.writeFileSync(jsonPath, "{}\n");

  try {
    assert.throws(
      () => VmCheckpoint.load(jsonPath),
      /legacy checkpoint\.json format is no longer supported/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
