import assert from "node:assert/strict";
import test from "node:test";

import { parseBuildConfig, validateBuildConfig } from "../src/build-config";

test("build-config: accepts postBuild.commands", () => {
  const cfg = {
    arch: "aarch64",
    distro: "alpine",
    alpine: { version: "3.23.0" },
    postBuild: {
      commands: ["pip3 install llm llm-anthropic"],
    },
  };

  assert.equal(validateBuildConfig(cfg), true);

  const parsed = parseBuildConfig(JSON.stringify(cfg));
  assert.deepEqual(parsed.postBuild?.commands, [
    "pip3 install llm llm-anthropic",
  ]);
});

test("build-config: rejects invalid postBuild.commands", () => {
  const invalid = {
    arch: "aarch64",
    distro: "alpine",
    alpine: { version: "3.23.0" },
    postBuild: {
      commands: [42],
    },
  };

  assert.equal(validateBuildConfig(invalid), false);
  assert.throws(
    () => parseBuildConfig(JSON.stringify(invalid)),
    /Invalid build configuration/,
  );
});

test("build-config: accepts runtimeDefaults.rootfsMode", () => {
  const cfg = {
    arch: "aarch64",
    distro: "alpine",
    alpine: { version: "3.23.0" },
    runtimeDefaults: {
      rootfsMode: "readonly",
    },
  };

  assert.equal(validateBuildConfig(cfg), true);

  const parsed = parseBuildConfig(JSON.stringify(cfg));
  assert.equal(parsed.runtimeDefaults?.rootfsMode, "readonly");
});

test("build-config: rejects invalid runtimeDefaults.rootfsMode", () => {
  const invalid = {
    arch: "aarch64",
    distro: "alpine",
    alpine: { version: "3.23.0" },
    runtimeDefaults: {
      rootfsMode: "qcow2",
    },
  };

  assert.equal(validateBuildConfig(invalid), false);
  assert.throws(
    () => parseBuildConfig(JSON.stringify(invalid)),
    /Invalid build configuration/,
  );
});

test("build-config: accepts oci rootfs configuration", () => {
  const cfg = {
    arch: "x86_64",
    distro: "alpine",
    alpine: { version: "3.23.0" },
    oci: {
      image: "docker.io/library/debian:bookworm-slim",
      runtime: "docker",
      platform: "linux/amd64",
      pullPolicy: "if-not-present",
    },
  };

  assert.equal(validateBuildConfig(cfg), true);

  const parsed = parseBuildConfig(JSON.stringify(cfg));
  assert.equal(parsed.oci?.image, "docker.io/library/debian:bookworm-slim");
  assert.equal(parsed.oci?.runtime, "docker");
  assert.equal(parsed.oci?.platform, "linux/amd64");
  assert.equal(parsed.oci?.pullPolicy, "if-not-present");
});

test("build-config: rejects invalid oci rootfs configuration", () => {
  const invalid = {
    arch: "x86_64",
    distro: "alpine",
    alpine: { version: "3.23.0" },
    oci: {
      image: "docker.io/library/debian:bookworm-slim",
      runtime: "runc",
      pullPolicy: "sometimes",
    },
  };

  assert.equal(validateBuildConfig(invalid), false);
  assert.throws(
    () => parseBuildConfig(JSON.stringify(invalid)),
    /Invalid build configuration/,
  );
});
