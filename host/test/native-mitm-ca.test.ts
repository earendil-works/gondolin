import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  generateMitmLeaf,
  loadOrCreateMitmCaSync,
  validateMitmLeaf,
} from "../src/mitm.ts";
import { nativeDaemonArgs } from "../src/native/binary.ts";
import { resolveNativeBinary } from "../src/native/transport.ts";

function findBinary(): string | null {
  try {
    return resolveNativeBinary();
  } catch {
    return null;
  }
}

const binary = findBinary();
const skip = binary ? false : "gondolind binary not built";

test("node accepts a mitm ca created by gondolind", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-ca-native-"));
  try {
    const printed = execFileSync(
      binary!,
      [...nativeDaemonArgs(binary!), "--mitm-ca", dir],
      {
        encoding: "utf8",
      },
    );
    const certPem = fs.readFileSync(path.join(dir, "ca.crt"), "utf8");
    assert.equal(printed, certPem);
    // node reuses it (no regeneration) and can sign leaves with it
    const ca = loadOrCreateMitmCaSync(dir);
    assert.equal(ca.certPem, certPem);
    assert.ok(ca.cert.ca);
    assert.match(ca.cert.subject, /CN=gondolin-mitm-ca/);
    const leaf = await generateMitmLeaf(ca, "example.com");
    validateMitmLeaf(ca, leaf);
    assert.ok(
      new crypto.X509Certificate(leaf.certPem).verify(ca.cert.publicKey),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gondolind accepts a mitm ca created by node", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-ca-node-"));
  try {
    const ca = loadOrCreateMitmCaSync(dir);
    const printed = execFileSync(
      binary!,
      [...nativeDaemonArgs(binary!), "--mitm-ca", dir],
      {
        encoding: "utf8",
      },
    );
    assert.equal(printed, ca.certPem);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
