// Tier-3 baseline: a minimal controller that serves `hook_call`s on stdin/stdout
// (u32 BE length + CBOR `{ v, t, id, p }` frames, as gondolind's controller
// protocol) with the host package's NativeHookService and a policy script run
// as plain node code (WHATWG Request/Response/URL from node).
//
// usage: node controller.mts <policy.js>
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const host = path.resolve(import.meta.dirname, "../../../../host");
const require = createRequire(path.join(host, "package.json"));
const { encode, decode } = await import(require.resolve("cbor2"));
const { NativeHookService } = await import(path.join(host, "src/native/net.ts"));

const policy = fs.readFileSync(process.argv[2], "utf8");
const onRequest = new Function(`${policy}\nreturn onRequest;`)();

let nextId = 1;
const pending = new Map<number, (p: any) => void>();
const send = (msg: unknown) => {
  const body = encode(msg);
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  Buffer.from(body).copy(frame, 4);
  process.stdout.write(frame);
};
const request = (t: string, p: unknown) =>
  new Promise<any>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ v: 1, t, id, p });
  });

const service = new NativeHookService(
  { onRequest },
  {
    transport: {
      async pull(stream: number, max: number) {
        const chunk = await request("body_pull", { stream, max });
        return { data: chunk.data, eof: chunk.eof };
      },
      release(stream: number) {
        send({ v: 1, t: "body_release", id: 0, p: { stream } });
      },
    },
    maxRequestBodyBytes: 64 << 20,
    maxResponseBodyBytes: 64 << 20,
  },
);

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0);
    if (buf.length < 4 + len) break;
    const msg = decode(buf.subarray(4, 4 + len)) as any;
    buf = buf.subarray(4 + len);
    if (msg.t === "hook_call") {
      service.handle(msg.p).then(
        (decision: object) =>
          send({ v: 1, t: "hook_call_result", id: msg.id, p: { ok: true, ...decision } }),
        (err: Error) =>
          send({
            v: 1,
            t: "hook_call_result",
            id: msg.id,
            p: { ok: false, code: "hook_failed", message: String(err) },
          }),
      );
    } else if (msg.t === "body_pull_result") {
      pending.get(msg.id)?.(msg.p);
      pending.delete(msg.id);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
