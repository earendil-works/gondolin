import assert from "node:assert/strict";
import test from "node:test";

import { computeAssetBuildId } from "../src/index.ts";

test("public entry exports computeAssetBuildId", () => {
  // Consumers that rewrite guest assets (e.g. restoring file modes in
  // rootfs.ext4) recompute the build id to keep manifest.buildId in step with
  // the checksums. Reaching into dist/src/assets.js for it is not acceptable.
  const id = computeAssetBuildId({
    checksums: { kernel: "k", initramfs: "i", rootfs: "r" },
    arch: "aarch64",
  });

  assert.match(id, /^[0-9a-f-]{36}$/);
});
