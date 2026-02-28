import assert from "node:assert/strict";
import test from "node:test";

import { __test as checkpointTest } from "../src/checkpoint";

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
