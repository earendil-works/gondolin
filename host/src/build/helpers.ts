import { createHash } from "node:crypto";
import fs from "node:fs";

export { cacheBaseDir } from "../cache.ts";

export function computeFileHash(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest("hex");
}

export async function downloadToBuffer(
  url: string,
  expectedSha256: string | undefined,
  userAgent: string,
  options: {
    downloadLabel?: string;
    checksumLabel?: string;
  } = {},
): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent },
  });
  if (!response.ok) {
    if (options.downloadLabel) {
      throw new Error(
        `failed to download ${options.downloadLabel}: ${response.status} ${response.statusText} (${url})`,
      );
    }
    throw new Error(
      `failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const data = Buffer.from(await response.arrayBuffer());
  if (expectedSha256) {
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== expectedSha256.toLowerCase()) {
      if (options.checksumLabel) {
        throw new Error(
          `${options.checksumLabel} checksum mismatch for ${url}\n  expected: ${expectedSha256}\n  got:      ${hash}`,
        );
      }
      throw new Error(
        `downloaded checksum mismatch for ${url}\n  expected: ${expectedSha256}\n  got:      ${hash}`,
      );
    }
  }
  return data;
}
