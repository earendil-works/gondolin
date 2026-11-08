import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { gondolinCacheDir } from "./cache.ts";
import {
  OID_AUTHORITY_KEY_IDENTIFIER,
  OID_SERVER_AUTH,
  OID_SUBJECT_KEY_IDENTIFIER,
  authorityKeyIdentifierExtension,
  basicConstraintsExtension,
  computeKeyIdentifier,
  createCertificate,
  encodeCommonNameName,
  extKeyUsageExtension,
  getExtension,
  keyUsageExtension,
  parseCertificate,
  readDer,
  readDerChildren,
  subjectAltNameExtension,
  subjectKeyIdentifierExtension,
  type ParsedCertificate,
} from "./x509.ts";

export type MitmCa = {
  /** ca private key */
  key: crypto.KeyObject;
  /** ca certificate */
  cert: crypto.X509Certificate;
  /** ca private key pem */
  keyPem: string;
  /** ca certificate pem */
  certPem: string;
};

/** PEM encoded leaf key and certificate */
export type MitmLeafPem = {
  keyPem: string;
  certPem: string;
};

type RsaKeyPair = {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
};

const RSA_KEY_BITS = 2048;
const CA_VALIDITY_DAYS = 3650;
const LEAF_VALIDITY_DAYS = 825;
/** backdating applied to notBefore to tolerate clock skew in `ms` */
const NOT_BEFORE_SKEW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const generateKeyPairAsync = promisify(crypto.generateKeyPair);

function generateRsaKeyPairSync(): RsaKeyPair {
  return crypto.generateKeyPairSync("rsa", { modulusLength: RSA_KEY_BITS });
}

function generateRsaKeyPair(): Promise<RsaKeyPair> {
  return generateKeyPairAsync("rsa", { modulusLength: RSA_KEY_BITS });
}

function privateKeyToPem(key: crypto.KeyObject): string {
  return key.export({ type: "pkcs1", format: "pem" }) as string;
}

function certificateToPem(der: Buffer): string {
  return new crypto.X509Certificate(der).toString();
}

const parsedCertificates = new WeakMap<
  crypto.X509Certificate,
  ParsedCertificate
>();

function parse(cert: crypto.X509Certificate): ParsedCertificate {
  let parsed = parsedCertificates.get(cert);
  if (!parsed) {
    parsed = parseCertificate(cert.raw);
    parsedCertificates.set(cert, parsed);
  }
  return parsed;
}

export function getDefaultMitmCertDir() {
  return gondolinCacheDir("ssl");
}

/**
 * MITM CA directory: the explicit option, else `GONDOLIN_MITM_CERT_DIR`, else
 * the shared cache (`~/.cache/gondolin/ssl`); the static CLI does the same.
 */
export function resolveMitmCertDir(mitmCertDir?: string) {
  return (
    mitmCertDir ??
    (process.env.GONDOLIN_MITM_CERT_DIR?.trim() || undefined) ??
    getDefaultMitmCertDir()
  );
}

function parsePersistedMitmCa(keyPem: string, certPem: string): MitmCa {
  const key = crypto.createPrivateKey(keyPem);
  const cert = new crypto.X509Certificate(certPem);
  if (!certificateHasNonNegativeSerialNumber(cert)) {
    throw new Error("persisted mitm ca cert has an unsafe serial number");
  }
  if (!mitmCaHasRequiredKeyIdentifiers(cert)) {
    throw new Error(
      "persisted mitm ca cert is missing required key identifiers",
    );
  }
  if (!cert.checkPrivateKey(key)) {
    throw new Error("persisted mitm ca key does not match cert");
  }
  return { key, cert, keyPem, certPem };
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
    return parsePersistedMitmCa(keyPem, certPem);
  } catch {
    const generated = buildMitmCa(await generateRsaKeyPair());
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
    return parsePersistedMitmCa(keyPem, certPem);
  } catch {
    const generated = buildMitmCa(generateRsaKeyPairSync());
    fs.writeFileSync(caKeyPath, generated.keyPem);
    fs.writeFileSync(caCertPath, generated.certPem);
    return generated;
  }
}

/** Random positive serial number as DER integer content octets */
export function generatePositiveSerialNumber(byteLength = 16): Buffer {
  const bytes = crypto.randomBytes(byteLength);
  // Clear the sign bit and keep the leading octet non-zero so the integer is
  // both positive and minimally encoded
  bytes[0] = bytes[0] & 0x7f || 1;
  return bytes;
}

/** Whether the certificate serial number is non-negative (required by e.g. Go) */
export function certificateHasNonNegativeSerialNumber(
  cert: crypto.X509Certificate,
): boolean {
  try {
    const serial = parse(cert).serialNumber;
    return serial.length > 0 && (serial[0] & 0x80) === 0;
  } catch {
    return false;
  }
}

/** Subject key identifier if present and derived from the certificate key */
export function getCertificateSubjectKeyIdentifier(
  cert: crypto.X509Certificate,
): Buffer | undefined {
  try {
    const ext = getExtension(parse(cert), OID_SUBJECT_KEY_IDENTIFIER);
    if (!ext) return undefined;
    const value = readDer(ext.value);
    if (value.tag !== 0x04) return undefined;
    const expected = computeKeyIdentifier(cert.publicKey);
    return value.content.equals(expected) ? expected : undefined;
  } catch {
    return undefined;
  }
}

export function certificateHasAuthorityKeyIdentifier(
  cert: crypto.X509Certificate,
  expectedKeyIdentifier: Buffer,
): boolean {
  try {
    const ext = getExtension(parse(cert), OID_AUTHORITY_KEY_IDENTIFIER);
    if (!ext) return false;
    const value = readDer(ext.value);
    if (value.tag !== 0x30) return false;
    return readDerChildren(value).some(
      (entry) =>
        entry.tag === 0x80 && entry.content.equals(expectedKeyIdentifier),
    );
  } catch {
    return false;
  }
}

export function mitmCaHasRequiredKeyIdentifiers(
  cert: crypto.X509Certificate,
): boolean {
  const subjectKeyIdentifier = getCertificateSubjectKeyIdentifier(cert);
  return (
    subjectKeyIdentifier !== undefined &&
    certificateHasAuthorityKeyIdentifier(cert, subjectKeyIdentifier)
  );
}

export function mitmLeafHasRequiredKeyIdentifiers(
  caCert: crypto.X509Certificate,
  leafCert: crypto.X509Certificate,
): boolean {
  const caSubjectKeyIdentifier = getCertificateSubjectKeyIdentifier(caCert);
  if (caSubjectKeyIdentifier === undefined) {
    return false;
  }
  return (
    getCertificateSubjectKeyIdentifier(leafCert) !== undefined &&
    certificateHasAuthorityKeyIdentifier(leafCert, caSubjectKeyIdentifier)
  );
}

/** Whether the leaf names the ca as issuer and carries a valid ca signature */
export function caCertVerifiesLeaf(
  caCert: crypto.X509Certificate,
  leafCert: crypto.X509Certificate,
): boolean {
  try {
    return leafCert.checkIssued(caCert) && leafCert.verify(caCert.publicKey);
  } catch {
    return false;
  }
}

export function privateKeyMatchesLeafCert(
  keyPem: string,
  leafCert: crypto.X509Certificate,
): boolean {
  try {
    return leafCert.checkPrivateKey(crypto.createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

/** Validate a persisted leaf certificate against the current ca */
export function validateMitmLeaf(
  ca: Pick<MitmCa, "cert">,
  leaf: MitmLeafPem,
): void {
  const cert = new crypto.X509Certificate(leaf.certPem);
  if (!certificateHasNonNegativeSerialNumber(cert)) {
    throw new Error("persisted mitm leaf cert has an unsafe serial number");
  }
  if (!caCertVerifiesLeaf(ca.cert, cert)) {
    throw new Error("persisted mitm leaf cert is not signed by current ca");
  }
  if (!mitmLeafHasRequiredKeyIdentifiers(ca.cert, cert)) {
    throw new Error(
      "persisted mitm leaf cert is missing required key identifiers",
    );
  }
  if (!privateKeyMatchesLeafCert(leaf.keyPem, cert)) {
    throw new Error("persisted mitm leaf key does not match cert");
  }
}

/** Generate a leaf certificate for `servername` signed by the ca */
export async function generateMitmLeaf(
  ca: Pick<MitmCa, "key" | "cert">,
  servername: string,
): Promise<MitmLeafPem> {
  const caSubjectKeyIdentifier = getCertificateSubjectKeyIdentifier(ca.cert);
  if (caSubjectKeyIdentifier === undefined) {
    throw new Error("mitm ca cert is missing required key identifiers");
  }

  const keys = await generateRsaKeyPair();
  const notBefore = new Date(Date.now() - NOT_BEFORE_SKEW_MS);
  const der = createCertificate({
    publicKey: keys.publicKey,
    signingKey: ca.key,
    serialNumber: generatePositiveSerialNumber(),
    notBefore,
    notAfter: new Date(notBefore.getTime() + LEAF_VALIDITY_DAYS * DAY_MS),
    subject: encodeCommonNameName(servername.replace(/[\r\n]/g, "")),
    issuer: parse(ca.cert).subject,
    extensions: [
      basicConstraintsExtension({ ca: false }),
      keyUsageExtension({ digitalSignature: true, keyEncipherment: true }),
      extKeyUsageExtension([OID_SERVER_AUTH]),
      subjectAltNameExtension(servername),
      subjectKeyIdentifierExtension(computeKeyIdentifier(keys.publicKey)),
      authorityKeyIdentifierExtension(caSubjectKeyIdentifier),
    ],
  });

  return {
    keyPem: privateKeyToPem(keys.privateKey),
    certPem: certificateToPem(der),
  };
}

function buildMitmCa(keys: RsaKeyPair): MitmCa {
  const name = encodeCommonNameName("gondolin-mitm-ca");
  const keyIdentifier = computeKeyIdentifier(keys.publicKey);
  const notBefore = new Date(Date.now() - NOT_BEFORE_SKEW_MS);

  const der = createCertificate({
    publicKey: keys.publicKey,
    signingKey: keys.privateKey,
    serialNumber: generatePositiveSerialNumber(),
    notBefore,
    notAfter: new Date(notBefore.getTime() + CA_VALIDITY_DAYS * DAY_MS),
    subject: name,
    issuer: name,
    extensions: [
      basicConstraintsExtension({ ca: true, critical: true }),
      keyUsageExtension({ keyCertSign: true, cRLSign: true }, true),
      subjectKeyIdentifierExtension(keyIdentifier),
      authorityKeyIdentifierExtension(keyIdentifier),
    ],
  });

  const certPem = certificateToPem(der);
  return {
    key: keys.privateKey,
    cert: new crypto.X509Certificate(certPem),
    keyPem: privateKeyToPem(keys.privateKey),
    certPem,
  };
}
