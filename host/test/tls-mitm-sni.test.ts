import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";
import tls from "node:tls";

import { QemuNetworkBackend } from "../src/qemu/net.ts";
import {
  MAX_CLIENT_HELLO_PREPARSE_BYTES,
  parseClientHelloSni,
} from "../src/qemu/tls-sni.ts";

/** In-memory duplex that exposes everything the TLS client writes. */
class CaptureDuplex extends Duplex {
  readonly written: Buffer[] = [];
  onWrite: ((chunk: Buffer) => void) | null = null;
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    const copy = Buffer.from(chunk);
    this.written.push(copy);
    this.onWrite?.(copy);
    callback();
  }
}

/** Capture a real ClientHello produced by this runtime's TLS client. */
async function captureClientHello(
  options: tls.ConnectionOptions,
): Promise<Buffer> {
  const wire = new CaptureDuplex();
  const first = new Promise<Buffer>((resolve) => {
    wire.onWrite = resolve;
  });
  const client = tls.connect({ ...options, socket: wire });
  client.on("error", () => {});
  const hello = await first;
  client.destroy();
  return hello;
}

test("tls-sni: extracts the host name from real ClientHellos", async () => {
  for (const servername of ["example.com", "a.b-c.example.org", "x"]) {
    const hello = await captureClientHello({ servername });
    assert.equal(parseClientHelloSni(hello), servername);
  }
  // TLS 1.2-only clients use a different extension layout.
  const legacy = await captureClientHello({
    servername: "legacy.example",
    maxVersion: "TLSv1.2",
  });
  assert.equal(parseClientHelloSni(legacy), "legacy.example");
});

test("tls-sni: needs more bytes for every strict prefix of the record", async () => {
  const hello = await captureClientHello({ servername: "example.com" });
  for (let length = 0; length < hello.length; length++) {
    assert.equal(
      parseClientHelloSni(hello.subarray(0, length)),
      length >= 1 && hello[0] !== 0x16 ? null : undefined,
      `prefix length ${length}`,
    );
  }
  // Extra bytes after the first record (e.g. early data) are ignored.
  const extended = Buffer.concat([hello, Buffer.alloc(64, 0x17)]);
  assert.equal(parseClientHelloSni(extended), "example.com");
});

test("tls-sni: non-TLS data, missing SNI and invalid names return null", async () => {
  assert.equal(
    parseClientHelloSni(Buffer.from("GET / HTTP/1.1\r\n\r\n")),
    null,
  );
  // Node omits SNI when connecting without a servername.
  const noSni = await captureClientHello({ servername: "" });
  assert.equal(parseClientHelloSni(noSni), null);

  const hello = await captureClientHello({ servername: "abcdefghij.test" });
  const index = hello.indexOf(Buffer.from("abcdefghij.test"));
  assert.ok(index > 0);
  const bad = Buffer.from(hello);
  bad[index] = 0x0a; // newline is not a valid host name character
  assert.equal(parseClientHelloSni(bad), null);
});

test("tls-sni: malformed lengths never throw or read out of bounds", async () => {
  const hello = await captureClientHello({ servername: "fuzz.example" });
  const random = crypto.createHash("sha256").update("seed");
  let seed = random.digest();
  for (let i = 0; i < 5000; i++) {
    seed = crypto.createHash("sha256").update(seed).digest();
    const mutated = Buffer.from(hello);
    for (let j = 0; j < 4; j++) {
      mutated[seed.readUInt16BE(j * 2) % mutated.length] = seed[8 + j]!;
    }
    const cut = mutated.subarray(
      0,
      seed.readUInt16BE(12) % (mutated.length + 1),
    );
    const result = parseClientHelloSni(cut);
    assert.ok(
      result === undefined || result === null || typeof result === "string",
    );
  }
  assert.ok(MAX_CLIENT_HELLO_PREPARSE_BYTES >= 16 * 1024);
});

/**
 * Drive the real MITM path in-process: a TLS client plays the guest, the
 * backend's stack stub carries ciphertext back to it, and `fetch` is stubbed.
 */
async function mitmRoundTrip(
  tlsSniPreparse: boolean,
  options: { body: Buffer; parallel: number; pauseGuestFlow: boolean },
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-tls-sni-"));
  const clients = new Map<string, CaptureDuplex>();
  const backend = new QemuNetworkBackend({
    socketPath: path.join(
      os.tmpdir(),
      `gondolin-tls-sni-${crypto.randomUUID()}.sock`,
    ),
    mitmCertDir: dir,
    tlsSniPreparse,
    dnsLookup: (_host, _opts, cb) =>
      cb(null, [{ address: "203.0.113.10", family: 4 }]),
    fetch: async () =>
      new Response(options.body, {
        status: 200,
        headers: { "content-length": String(options.body.length) },
      }),
  });
  const internals = backend as any;
  const ca = await internals.ensureCaAsync();
  internals.stack = {
    handleTcpData: ({ key, data }: { key: string; data: Buffer }) => {
      const session = internals.tcpSessions.get(key);
      if (options.pauseGuestFlow && session && !session.flowControlPaused) {
        // Simulate a slow guest: pause the flow, then resume asynchronously.
        session.flowControlPaused = true;
        setTimeout(() => {
          session.flowControlPaused = false;
          internals.settleFlowResume(key);
        }, 1);
      }
      clients.get(key)?.push(Buffer.from(data));
    },
    handleTcpEnd: ({ key }: { key: string }) => clients.get(key)?.push(null),
    handleTcpClosed: ({ key }: { key: string }) => clients.get(key)?.push(null),
    handleTcpError: ({ key }: { key: string }) => clients.get(key)?.destroy(),
  };
  internals.flush = () => {};

  const run = async (index: number) => {
    const key = `TCP:192.168.127.3:${40000 + index}:203.0.113.10:443`;
    const session: any = {
      socket: null,
      srcIP: "192.168.127.3",
      srcPort: 40000 + index,
      dstIP: "203.0.113.10",
      dstPort: 443,
      connectIP: "203.0.113.10",
      syntheticHostname: null,
      flowControlPaused: false,
      protocol: "tls",
      connected: false,
      pendingWrites: [],
      pendingWriteBytes: 0,
    };
    internals.tcpSessions.set(key, session);
    const wire = new CaptureDuplex();
    clients.set(key, wire);
    wire.onWrite = (chunk) => internals.handleTlsData(key, session, chunk);
    const socket = tls.connect({
      socket: wire,
      servername: "example.com",
      ca: ca.certPem,
    });
    const chunks: Buffer[] = [];
    let subjectaltname: string | undefined;
    await new Promise<void>((resolve, reject) => {
      socket.on("secureConnect", () => {
        // Read before end: some runtimes drop peer details once the socket ends.
        subjectaltname = socket.getPeerCertificate().subjectaltname;
        socket.write(
          "GET /object HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
        );
      });
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => resolve());
      socket.on("error", reject);
    });
    socket.destroy();
    const response = Buffer.concat(chunks);
    const split = response.indexOf("\r\n\r\n");
    return {
      head: response.subarray(0, split).toString("latin1"),
      body: response.subarray(split + 4),
      subjectaltname,
    };
  };

  try {
    return await Promise.all(
      Array.from({ length: options.parallel }, (_, i) => run(i)),
    );
  } finally {
    await backend.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

for (const tlsSniPreparse of [false, true]) {
  const mode = tlsSniPreparse ? "SNI pre-parse" : "SNICallback";
  // Bun does not invoke server SNICallback, which is why pre-parsing exists.
  const skip =
    isBun && !tlsSniPreparse ? "Bun does not call SNICallback" : false;

  test(`tls-mitm (${mode}): complete responses under guest backpressure`, {
    skip,
  }, async () => {
    const body = crypto.randomBytes(3 * 1024 * 1024 + 17);
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    const results = await mitmRoundTrip(tlsSniPreparse, {
      body,
      parallel: 6,
      pauseGuestFlow: true,
    });
    for (const result of results) {
      assert.match(result.head, /^HTTP\/1\.1 200 /);
      assert.equal(result.subjectaltname, "DNS:example.com");
      assert.equal(result.body.length, body.length);
      assert.equal(
        crypto.createHash("sha256").update(result.body).digest("hex"),
        digest,
      );
    }
  });

  test(`tls-mitm (${mode}): small responses end cleanly`, {
    skip,
  }, async () => {
    const results = await mitmRoundTrip(tlsSniPreparse, {
      body: Buffer.from("ok"),
      parallel: 12,
      pauseGuestFlow: false,
    });
    for (const result of results) assert.equal(result.body.toString(), "ok");
  });
}
