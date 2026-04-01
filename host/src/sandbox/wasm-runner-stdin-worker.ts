import fs from "fs";
import { workerData } from "node:worker_threads";

type StdinWorkerData = {
  /** stdin fd from parent process */
  fd: number;
  /** shared ring-buffer state words */
  state: SharedArrayBuffer;
  /** shared ring-buffer payload bytes */
  data: SharedArrayBuffer;
};

const {
  fd,
  state: stateBuffer,
  data: dataBuffer,
} = workerData as StdinWorkerData;

const state = new Int32Array(stateBuffer);
const ring = new Uint8Array(dataBuffer);

const WRITE_POS = 0;
const READ_POS = 1;
const CLOSED = 2;
const WAKE_SEQ = 3;

function notifyParent() {
  Atomics.add(state, WAKE_SEQ, 1);
  Atomics.notify(state, WAKE_SEQ);
}

function pushChunk(chunk: Buffer): void {
  let offset = 0;
  while (offset < chunk.length) {
    const writePos = Atomics.load(state, WRITE_POS);
    const readPos = Atomics.load(state, READ_POS);
    const used = writePos - readPos;
    const free = ring.length - used;

    if (free <= 0) {
      const seq = Atomics.load(state, WAKE_SEQ);
      Atomics.wait(state, WAKE_SEQ, seq, 50);
      continue;
    }

    const ringOffset = writePos % ring.length;
    const chunkLen = Math.min(free, chunk.length - offset, ring.length - ringOffset);
    ring.set(chunk.subarray(offset, offset + chunkLen), ringOffset);

    Atomics.store(state, WRITE_POS, writePos + chunkLen);
    offset += chunkLen;
    notifyParent();
  }
}

const scratch = Buffer.allocUnsafe(4096);

while (true) {
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, scratch, 0, scratch.length, null);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EINTR") {
      continue;
    }
    Atomics.store(state, CLOSED, 1);
    notifyParent();
    break;
  }

  if (bytesRead <= 0) {
    Atomics.store(state, CLOSED, 1);
    notifyParent();
    break;
  }

  pushChunk(scratch.subarray(0, bytesRead));
}
