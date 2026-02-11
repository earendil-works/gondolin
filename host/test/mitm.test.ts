import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import forge from "node-forge";

import {
  generatePositiveSerialNumber,
  getDefaultMitmCertDir,
  isNonNegativeSerialNumberHex,
  loadOrCreateMitmCa,
  loadOrCreateMitmCaSync,
  resolveMitmCertDir,
} from "../src/mitm";

function makeTempDir(t: TestContext, prefix = "gondolin-mitm-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function assertLooksLikeMitmCa(ca: { keyPem: string; certPem: string; key: any; cert: any }) {
  assert.ok(ca.keyPem.includes("BEGIN RSA PRIVATE KEY"));
  assert.ok(ca.certPem.includes("BEGIN CERTIFICATE"));

  const cert = forge.pki.certificateFromPem(ca.certPem);
  const key = forge.pki.privateKeyFromPem(ca.keyPem);

  // CN
  const cn = cert.subject.getField("CN")?.value;
  assert.equal(cn, "gondolin-mitm-ca");

  // Self-signed
  assert.equal(cert.issuer.getField("CN")?.value, "gondolin-mitm-ca");
  assert.equal(cert.verify(cert), true);

  // Certificate is a CA
  const basicConstraints = cert.getExtension("basicConstraints") as any;
  assert.ok(basicConstraints);
  assert.equal(Boolean(basicConstraints.cA), true);
  assert.equal(Boolean(basicConstraints.critical), true);

  // Key usage
  const keyUsage = cert.getExtension("keyUsage") as any;
  assert.ok(keyUsage);
  assert.equal(Boolean(keyUsage.keyCertSign), true);
  assert.equal(Boolean(keyUsage.cRLSign), true);
  assert.equal(Boolean(keyUsage.critical), true);

  // Serial number must remain non-negative for strict TLS clients (e.g. Go)
  assert.equal(isNonNegativeSerialNumberHex(cert.serialNumber), true);

  // Validity window (10 years)
  assert.ok(cert.validity.notBefore instanceof Date);
  assert.ok(cert.validity.notAfter instanceof Date);
  assert.ok(cert.validity.notAfter.getTime() > cert.validity.notBefore.getTime());
  const days = (cert.validity.notAfter.getTime() - cert.validity.notBefore.getTime()) / (24 * 60 * 60 * 1000);
  assert.ok(days > 3600 && days < 3700);

  // Public/private key match (compare modulus n)
  assert.equal(cert.publicKey.n.toString(16), key.n.toString(16));
}

test("mitm getDefaultMitmCertDir respects XDG_CACHE_HOME", (t) => {
  const prev = process.env.XDG_CACHE_HOME;
  t.after(() => {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
  });

  process.env.XDG_CACHE_HOME = "/tmp/gondolin-xdg-cache-test";
  assert.equal(
    getDefaultMitmCertDir(),
    path.join("/tmp/gondolin-xdg-cache-test", "gondolin", "ssl")
  );
});

test("mitm resolveMitmCertDir uses override", () => {
  assert.equal(resolveMitmCertDir("/custom/dir"), "/custom/dir");
});

test("mitm serial helpers create positive serial numbers", () => {
  for (let i = 0; i < 64; i += 1) {
    const serial = generatePositiveSerialNumber();
    assert.equal(isNonNegativeSerialNumberHex(serial), true);
  }
  assert.equal(isNonNegativeSerialNumberHex("ff"), false);
});

test("mitm loadOrCreateMitmCaSync creates and persists CA", (t) => {
  const dir = makeTempDir(t);

  const ca1 = loadOrCreateMitmCaSync(dir);
  assertLooksLikeMitmCa(ca1);

  // Files created
  const keyPath = path.join(dir, "ca.key");
  const certPath = path.join(dir, "ca.crt");
  assert.equal(fs.existsSync(keyPath), true);
  assert.equal(fs.existsSync(certPath), true);
  assert.equal(fs.readFileSync(keyPath, "utf8"), ca1.keyPem);
  assert.equal(fs.readFileSync(certPath, "utf8"), ca1.certPem);

  // Second load reuses persisted materials
  const ca2 = loadOrCreateMitmCaSync(dir);
  assert.equal(ca2.keyPem, ca1.keyPem);
  assert.equal(ca2.certPem, ca1.certPem);
});

test("mitm loadOrCreateMitmCaSync regenerates CA with unsafe serial", (t) => {
  const dir = makeTempDir(t);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "ff";
  const now = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now);
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + 3650);
  const attrs = [{ name: "commonName", value: "gondolin-mitm-ca" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      critical: true,
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.writeFileSync(path.join(dir, "ca.key"), forge.pki.privateKeyToPem(keys.privateKey));
  const badCertPem = forge.pki.certificateToPem(cert);
  fs.writeFileSync(path.join(dir, "ca.crt"), badCertPem);

  const loaded = loadOrCreateMitmCaSync(dir);
  assertLooksLikeMitmCa(loaded);
  assert.notEqual(loaded.certPem, badCertPem);
});

test("mitm loadOrCreateMitmCa async loads existing CA generated by sync", async (t) => {
  const dir = makeTempDir(t);

  const sync = loadOrCreateMitmCaSync(dir);
  const asyncCa = await loadOrCreateMitmCa(dir);

  assert.equal(asyncCa.keyPem, sync.keyPem);
  assert.equal(asyncCa.certPem, sync.certPem);
});

test("mitm loadOrCreateMitmCa regenerates when files are missing/corrupt", async (t) => {
  const dir = makeTempDir(t);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ca.key"), "not a key");
  // no cert

  const ca = await loadOrCreateMitmCa(dir);
  assertLooksLikeMitmCa(ca);

  // Corrupt file should have been overwritten
  assert.notEqual(fs.readFileSync(path.join(dir, "ca.key"), "utf8"), "not a key");
});
