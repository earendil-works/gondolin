import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  VmCheckpoint,
  type VmCheckpointData,
  __test as checkpointTest,
} from "../src/checkpoint.ts";

function makeCheckpointData(
  overrides: Partial<VmCheckpointData> = {},
): VmCheckpointData {
  return {
    version: 1,
    name: "test-checkpoint",
    createdAt: "2026-03-01T00:00:00.000Z",
    diskFile: "test-checkpoint.qcow2",
    guestAssetBuildId: "15e98966-a559-55ee-8d57-9f4c3f0346c7",
    ...overrides,
  };
}

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

test("checkpoint: legacy trailers default to qemu compatibility", () => {
  const compatible =
    checkpointTest.resolveCheckpointCompatibleVmm(makeCheckpointData());
  assert.deepEqual(compatible, ["qemu"]);
});

test("checkpoint: compatibility list accepts qemu/krun and ignores unknowns", () => {
  const compatible = checkpointTest.resolveCheckpointCompatibleVmm(
    makeCheckpointData({
      compatibleVmm: ["krun", "qemu", "krun", "unknown" as any],
    }),
  );
  assert.deepEqual(compatible, ["qemu", "krun"]);
});

test("checkpoint: createdWithVmm fallback is used when list is missing", () => {
  const compatible = checkpointTest.resolveCheckpointCompatibleVmm(
    makeCheckpointData({ createdWithVmm: "krun" }),
  );
  assert.deepEqual(compatible, ["krun"]);
});

test("checkpoint: resume vmm selection defaults to qemu and honors overrides", () => {
  const prev = process.env.GONDOLIN_VMM;
  try {
    delete process.env.GONDOLIN_VMM;
    assert.equal(checkpointTest.resolveRequestedResumeVmm({}), "qemu");

    process.env.GONDOLIN_VMM = "krun";
    assert.equal(checkpointTest.resolveRequestedResumeVmm({}), "krun");

    process.env.GONDOLIN_VMM = "krun";
    assert.equal(
      checkpointTest.resolveRequestedResumeVmm({
        sandbox: { vmm: "qemu" },
      }),
      "qemu",
    );

    assert.throws(
      () =>
        checkpointTest.resolveRequestedResumeVmm({
          sandbox: { vmm: "wat" } as any,
        }),
      /invalid sandbox vmm backend/,
    );
  } finally {
    if (prev === undefined) {
      delete process.env.GONDOLIN_VMM;
    } else {
      process.env.GONDOLIN_VMM = prev;
    }
  }
});
