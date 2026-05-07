#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/install-zig.sh [version]

Download and install a pinned Zig toolchain for the current runner OS/arch.
Archives are fetched from Zig community mirrors, verified with the ZSF minisign
public key, checked against a pinned SHA256, and added to GITHUB_PATH when
running under GitHub Actions.

Environment:
  ZIG_VERSION        Zig version when no positional version is supplied (default: 0.16.0)
  ZIG_INSTALL_ROOT   Toolchain install root (default: ~/.cache/gondolin/zig)
  ZIG_MIRRORS        Newline-separated mirror list override
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

VERSION="${1:-${ZIG_VERSION:-0.16.0}}"
SOURCE_QUERY="source=github-earendil-works-gondolin"
ZSF_MINISIGN_PUBKEY="RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U"

DEFAULT_ZIG_MIRRORS=$(cat <<'MIRRORS'
https://pkg.hexops.org/zig
https://zigmirror.hryx.net/zig
https://zig.linus.dev/zig
https://zig.squirl.dev
https://zig.mirror.mschae23.de/zig
https://ziglang.freetls.fastly.net
https://zig.tilok.dev
https://zig-mirror.tsimnet.eu/zig
https://zig.karearl.com/zig
https://pkg.earth/zig
https://fs.liujiacai.net/zigbuilds
https://zigmirror.com
https://zig.chainsafe.dev
https://zig.savalione.com
MIRRORS
)

case "$(uname -s)" in
  Linux) ZIG_OS="linux" ;;
  Darwin) ZIG_OS="macos" ;;
  *)
    echo "unsupported OS: $(uname -s)" >&2
    exit 2
    ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ZIG_ARCH="x86_64" ;;
  arm64|aarch64) ZIG_ARCH="aarch64" ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 2
    ;;
esac

PLATFORM="${ZIG_ARCH}-${ZIG_OS}"

case "${VERSION}/${PLATFORM}" in
  0.16.0/x86_64-linux)
    FILENAME="zig-x86_64-linux-0.16.0.tar.xz"
    SHA256="70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00"
    ;;
  0.16.0/aarch64-linux)
    FILENAME="zig-aarch64-linux-0.16.0.tar.xz"
    SHA256="ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17"
    ;;
  0.16.0/x86_64-macos)
    FILENAME="zig-x86_64-macos-0.16.0.tar.xz"
    SHA256="0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7"
    ;;
  0.16.0/aarch64-macos)
    FILENAME="zig-aarch64-macos-0.16.0.tar.xz"
    SHA256="b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489"
    ;;
  *)
    echo "unsupported Zig toolchain: version=${VERSION} platform=${PLATFORM}" >&2
    echo "add its filename and official sha256 to scripts/install-zig.sh" >&2
    exit 2
    ;;
esac

verify_sha256() {
  local archive="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    echo "${SHA256}  ${archive}" | sha256sum -c -
  elif command -v shasum >/dev/null 2>&1; then
    echo "${SHA256}  ${archive}" | shasum -a 256 -c -
  else
    echo "sha256sum or shasum is required to verify Zig download" >&2
    return 1
  fi
}

verify_minisign() {
  local archive="$1"
  local signature="$2"

  if ! command -v node >/dev/null 2>&1; then
    echo "node is required to verify Zig minisign signatures" >&2
    return 1
  fi

  node - "$archive" "$signature" "$FILENAME" "$ZSF_MINISIGN_PUBKEY" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const [archivePath, signaturePath, expectedFileName, publicKeyText] = process.argv.slice(2);

function fail(message) {
  throw new Error(message);
}

function decodeBase64(value, label) {
  try {
    return Buffer.from(value, 'base64');
  } catch (error) {
    fail(`invalid base64 in ${label}: ${error.message}`);
  }
}

async function hashFile(path, algorithm) {
  const hash = crypto.createHash(algorithm);
  await new Promise((resolve, reject) => {
    fs.createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest();
}

(async () => {
  const lines = fs.readFileSync(signaturePath, 'utf8').trimEnd().split(/\r?\n/);
  if (lines.length !== 4) fail('minisign signature must contain exactly 4 lines');
  if (!lines[0].startsWith('untrusted comment: ')) fail('missing minisign untrusted comment');

  const sigStruct = decodeBase64(lines[1], 'signature');
  if (sigStruct.length !== 74) fail(`unexpected minisign signature length: ${sigStruct.length}`);

  const trustedPrefix = 'trusted comment: ';
  if (!lines[2].startsWith(trustedPrefix)) fail('missing minisign trusted comment');
  const trustedComment = lines[2].slice(trustedPrefix.length);
  const trustedFields = new Set(trustedComment.split('\t'));
  if (!trustedFields.has(`file:${expectedFileName}`)) {
    fail(`minisign trusted comment does not match requested file ${expectedFileName}`);
  }

  const globalSignature = decodeBase64(lines[3], 'trusted comment signature');
  if (globalSignature.length !== 64) {
    fail(`unexpected minisign trusted comment signature length: ${globalSignature.length}`);
  }

  const publicKeyStruct = decodeBase64(publicKeyText, 'ZSF public key');
  if (publicKeyStruct.length !== 42) fail(`unexpected minisign public key length: ${publicKeyStruct.length}`);
  if (publicKeyStruct.subarray(0, 2).toString('ascii') !== 'Ed') fail('unsupported public key algorithm');

  const algorithm = sigStruct.subarray(0, 2).toString('ascii');
  const isHashed = algorithm === 'ED';
  if (algorithm !== 'Ed' && algorithm !== 'ED') fail(`unsupported signature algorithm: ${algorithm}`);
  if (!sigStruct.subarray(2, 10).equals(publicKeyStruct.subarray(2, 10))) {
    fail('signature key id does not match ZSF public key');
  }

  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, publicKeyStruct.subarray(10)]),
    format: 'der',
    type: 'spki',
  });

  const payload = isHashed
    ? await hashFile(archivePath, 'blake2b512')
    : fs.readFileSync(archivePath);
  const signature = sigStruct.subarray(10);

  if (!crypto.verify(null, payload, publicKey, signature)) {
    fail('Zig archive minisign verification failed');
  }

  const trustedPayload = Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]);
  if (!crypto.verify(null, trustedPayload, publicKey, globalSignature)) {
    fail('Zig archive minisign trusted comment verification failed');
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
}

shuffle_mirrors() {
  awk 'BEGIN { srand() } NF { print rand() "\t" $0 }' | sort -n | cut -f2-
}

download_from_mirrors() {
  local archive="$1"
  local signature="$2"
  local mirrors mirror base archive_url signature_url

  mirrors="${ZIG_MIRRORS:-$DEFAULT_ZIG_MIRRORS}"
  while IFS= read -r mirror; do
    [[ -n "$mirror" ]] || continue
    base="${mirror%/}"
    archive_url="${base}/${FILENAME}?${SOURCE_QUERY}"
    signature_url="${base}/${FILENAME}.minisig?${SOURCE_QUERY}"

    echo "Downloading Zig ${VERSION} (${PLATFORM}) from ${base}" >&2
    if ! curl -fsSL --retry 3 -o "$archive" "$archive_url"; then
      echo "archive download failed from ${base}" >&2
      continue
    fi
    if ! curl -fsSL --retry 3 -o "$signature" "$signature_url"; then
      echo "signature download failed from ${base}" >&2
      continue
    fi
    if ! verify_minisign "$archive" "$signature"; then
      echo "minisign verification failed for ${base}" >&2
      continue
    fi
    if ! verify_sha256 "$archive"; then
      echo "sha256 verification failed for ${base}" >&2
      continue
    fi

    return 0
  done < <(printf '%s\n' "$mirrors" | shuffle_mirrors)

  return 1
}

INSTALL_ROOT="${ZIG_INSTALL_ROOT:-$HOME/.cache/gondolin/zig}"
INSTALL_DIR="${INSTALL_ROOT}/${VERSION}/${PLATFORM}"

if [[ ! -x "${INSTALL_DIR}/zig" ]]; then
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gondolin-zig.XXXXXX")"
  cleanup() {
    rm -rf "$TMP_DIR"
  }
  trap cleanup EXIT

  ARCHIVE="${TMP_DIR}/${FILENAME}"
  SIGNATURE="${ARCHIVE}.minisig"

  if ! download_from_mirrors "$ARCHIVE" "$SIGNATURE"; then
    echo "failed to download and verify ${FILENAME} from Zig community mirrors" >&2
    exit 1
  fi

  tar -xf "$ARCHIVE" -C "$TMP_DIR"
  EXTRACTED_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'zig-*' | head -n 1)"
  if [[ -z "$EXTRACTED_DIR" || ! -x "$EXTRACTED_DIR/zig" ]]; then
    echo "downloaded Zig archive did not contain a zig executable" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  rm -rf "${INSTALL_DIR}.tmp" "$INSTALL_DIR"
  mv "$EXTRACTED_DIR" "${INSTALL_DIR}.tmp"
  mv "${INSTALL_DIR}.tmp" "$INSTALL_DIR"
  trap - EXIT
  cleanup
fi

INSTALLED_VERSION="$(${INSTALL_DIR}/zig version)"
if [[ "$INSTALLED_VERSION" != "$VERSION" ]]; then
  echo "installed Zig version mismatch: expected ${VERSION}, got ${INSTALLED_VERSION}" >&2
  exit 1
fi

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$INSTALL_DIR" >> "$GITHUB_PATH"
else
  echo "Add this directory to PATH: $INSTALL_DIR" >&2
fi

echo "Installed Zig ${INSTALLED_VERSION} at ${INSTALL_DIR}" >&2
