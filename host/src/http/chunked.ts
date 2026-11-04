import { HttpRequestBlockedError } from "./utils.ts";
import type { HttpReceiveBuffer } from "./utils.ts";

/** Decode progress for one chunked request body, resumed across data events. */
export type ChunkedBodyProgress = {
  /** offset of the next unsent chunk boundary in the receive buffer */
  offset: number;
  /** payloads of the chunks decoded so far */
  chunks: Buffer[];
  /** payload bytes decoded so far */
  totalBytes: number;
};

export type ChunkedBodyResult = {
  complete: boolean;
  body: Buffer;
  bytesConsumed: number;
};

export function createChunkedBodyProgress(
  bodyOffset: number,
): ChunkedBodyProgress {
  return { offset: bodyOffset, chunks: [], totalBytes: 0 };
}

/**
 * Decode a chunked request body, resuming from *progress*.
 *
 * The progress is only advanced past a complete `size CRLF data CRLF` unit, so a
 * body split across many segments costs one pass over the bytes instead of one
 * pass per segment (which was quadratic and made large git pushes slow).
 */
export function decodeChunkedBody(
  receiveBuffer: HttpReceiveBuffer,
  bodyOffset: number,
  maxBodyBytes: number,
  progress: ChunkedBodyProgress,
): ChunkedBodyResult {
  const enforceLimit = Number.isFinite(maxBodyBytes) && maxBodyBytes >= 0;
  const cursor = receiveBuffer.cursor(progress.offset);

  while (true) {
    const sizeLineRaw = cursor.tryReadLineAscii(1024);
    if (sizeLineRaw === null) {
      return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
    }

    const sizeLine = sizeLineRaw.split(";")[0]!.trim();
    const size = parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error("invalid chunk size");
    }

    // last-chunk + trailer-section
    if (size === 0) {
      const emptyTrailers = cursor.tryConsumeSequenceIfPresent([0x0d, 0x0a]);
      if (emptyTrailers === null) {
        return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
      }

      if (!emptyTrailers) {
        const consumedTrailers = cursor.tryConsumeUntilDoubleCrlf();
        if (consumedTrailers === null) {
          return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
        }
      }

      progress.offset = cursor.offset;
      return {
        complete: true,
        body: Buffer.concat(progress.chunks, progress.totalBytes),
        bytesConsumed: cursor.offset - bodyOffset,
      };
    }

    if (enforceLimit && progress.totalBytes + size > maxBodyBytes) {
      throw new HttpRequestBlockedError(
        `request body exceeds ${maxBodyBytes} bytes`,
        413,
        "Payload Too Large",
      );
    }

    const chunkData = cursor.tryReadBytes(size);
    if (chunkData === null) {
      return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
    }

    const terminator = cursor.tryConsumeExactSequence([0x0d, 0x0a]);
    if (terminator === null) {
      return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
    }

    progress.chunks.push(chunkData);
    progress.totalBytes += size;
    progress.offset = cursor.offset;
  }
}
