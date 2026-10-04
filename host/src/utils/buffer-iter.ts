import { Readable } from "node:stream";

export type BufferIterableChunk = Buffer | Uint8Array | string;

export type BufferIterableInput =
  | BufferIterableChunk
  | Readable
  | AsyncIterable<BufferIterableChunk>;

/**
 * Normalize supported input types into an async iterable of Buffer chunks.
 */
export async function* toBufferIterable(
  input: BufferIterableInput,
  options: {
    /** string encoding for top-level strings and string chunks */
    encoding?: BufferEncoding;
  } = {},
): AsyncIterable<Buffer> {
  const encoding = options.encoding ?? "utf-8";

  if (typeof input === "string") {
    yield Buffer.from(input, encoding);
    return;
  }

  if (Buffer.isBuffer(input)) {
    yield input;
    return;
  }

  if (input instanceof Uint8Array) {
    yield Buffer.from(input);
    return;
  }

  if (input instanceof Readable) {
    for await (const chunk of input) {
      if (typeof chunk === "string") {
        yield Buffer.from(chunk, encoding);
      } else if (Buffer.isBuffer(chunk)) {
        yield chunk;
      } else if (chunk instanceof Uint8Array) {
        yield Buffer.from(chunk);
      } else {
        throw new Error("unsupported readable chunk type");
      }
    }
    return;
  }

  if (typeof (input as any)?.[Symbol.asyncIterator] === "function") {
    for await (const chunk of input as AsyncIterable<BufferIterableChunk>) {
      if (typeof chunk === "string") {
        yield Buffer.from(chunk, encoding);
      } else if (Buffer.isBuffer(chunk)) {
        yield chunk;
      } else if (chunk instanceof Uint8Array) {
        yield Buffer.from(chunk);
      } else {
        throw new Error("unsupported async iterable chunk type");
      }
    }
    return;
  }

  throw new Error("unsupported write input type");
}
