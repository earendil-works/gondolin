import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSandboxfsAppend,
  isSameSandboxFsConfig,
  normalizeSandboxFsConfig,
} from "../src/sandbox/server-boot-config.ts";

test("sandboxfs created-ownership mapping is opt-in in the boot config", () => {
  const disabled = normalizeSandboxFsConfig({ type: "boot" });
  const enabled = normalizeSandboxFsConfig({
    type: "boot",
    mapCreatedOwnership: true,
  });

  assert.equal(disabled.mapCreatedOwnership, false);
  assert.equal(enabled.mapCreatedOwnership, true);
  assert.equal(isSameSandboxFsConfig(disabled, enabled), false);
  assert.equal(
    buildSandboxfsAppend("quiet", enabled),
    "quiet sandboxfs.mount=/data sandboxfs.map-created-ownership=1",
  );
});

test("sandboxfs created-ownership mapping rejects non-boolean values", () => {
  assert.throws(
    () =>
      normalizeSandboxFsConfig({
        type: "boot",
        mapCreatedOwnership: "yes",
      } as never),
    /mapCreatedOwnership must be a boolean/,
  );
});
