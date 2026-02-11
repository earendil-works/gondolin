import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import forge from "node-forge";

export type MitmCa = {
  /** ca private key */
  key: forge.pki.rsa.PrivateKey;
  /** ca certificate */
  cert: forge.pki.Certificate;
  /** ca private key pem */
  keyPem: string;
  /** ca certificate pem */
  certPem: string;
};

export function getDefaultMitmCertDir() {
  const cacheBase = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(cacheBase, "gondolin", "ssl");
}

export function resolveMitmCertDir(mitmCertDir?: string) {
  return mitmCertDir ?? getDefaultMitmCertDir();
}

export async function loadOrCreateMitmCa(mitmDir: string): Promise<MitmCa> {
  await fsp.mkdir(mitmDir, { recursive: true });

  const caKeyPath = path.join(mitmDir, "ca.key");
  const caCertPath = path.join(mitmDir, "ca.crt");

  try {
    const [keyPem, certPem] = await Promise.all([
      fsp.readFile(caKeyPath, "utf8"),
      fsp.readFile(caCertPath, "utf8"),
    ]);
    const key = forge.pki.privateKeyFromPem(keyPem);
    const cert = forge.pki.certificateFromPem(certPem);
    if (!isNonNegativeSerialNumberHex(cert.serialNumber)) {
      throw new Error("persisted mitm ca cert has an unsafe serial number");
    }
    return {
      key,
      cert,
      keyPem,
      certPem,
    };
  } catch {
    const generated = generateMitmCa();
    await Promise.all([
      fsp.writeFile(caKeyPath, generated.keyPem),
      fsp.writeFile(caCertPath, generated.certPem),
    ]);
    return generated;
  }
}

export function loadOrCreateMitmCaSync(mitmDir: string): MitmCa {
  fs.mkdirSync(mitmDir, { recursive: true });

  const caKeyPath = path.join(mitmDir, "ca.key");
  const caCertPath = path.join(mitmDir, "ca.crt");

  try {
    const keyPem = fs.readFileSync(caKeyPath, "utf8");
    const certPem = fs.readFileSync(caCertPath, "utf8");
    const key = forge.pki.privateKeyFromPem(keyPem);
    const cert = forge.pki.certificateFromPem(certPem);
    if (!isNonNegativeSerialNumberHex(cert.serialNumber)) {
      throw new Error("persisted mitm ca cert has an unsafe serial number");
    }
    return {
      key,
      cert,
      keyPem,
      certPem,
    };
  } catch {
    const generated = generateMitmCa();
    fs.writeFileSync(caKeyPath, generated.keyPem);
    fs.writeFileSync(caCertPath, generated.certPem);
    return generated;
  }
}

export function generatePositiveSerialNumber(byteLength = 16): string {
  const bytes = crypto.randomBytes(byteLength);
  bytes[0] &= 0x7f;
  if (bytes.every((value) => value === 0)) {
    bytes[bytes.length - 1] = 1;
  }
  return bytes.toString("hex");
}

export function isNonNegativeSerialNumberHex(serialNumber: string): boolean {
  const normalized = serialNumber.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized)) {
    return false;
  }
  const firstByteHex = normalized.length > 1 ? normalized.slice(0, 2) : `0${normalized}`;
  return parseInt(firstByteHex, 16) < 0x80;
}

function generateMitmCa(): MitmCa {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = generatePositiveSerialNumber();
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

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);

  return {
    key: keys.privateKey,
    cert,
    keyPem,
    certPem,
  };
}
