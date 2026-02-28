import fs from "fs";
import os from "os";
import path from "path";

import assert from "node:assert/strict";
import test from "node:test";

import { buildAssets } from "../src/build/index.ts";
import type { BuildConfig } from "../src/build/config.ts";

test("builder: oci rootfs rejects container.force", async () => {
  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-assets-out-"),
  );

  try {
    const config: BuildConfig = {
      arch: "x86_64",
      distro: "alpine",
      alpine: {
        version: "3.23.0",
      },
      oci: {
        image: "docker.io/library/debian:bookworm-slim",
      },
      container: {
        force: true,
      },
    };

    await assert.rejects(
      () =>
        buildAssets(config, {
          outputDir,
          verbose: false,
          skipBinaries: true,
        }),
      /OCI rootfs builds currently do not support container\.force=true/,
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
