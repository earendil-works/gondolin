import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import tls from "node:tls";

import { type HttpHooks, type VM, createHttpHooks } from "../../src/index.ts";
import {
  computeKeyIdentifier,
  createCertificate,
  encodeCommonNameName,
  subjectAltNameExtension,
  subjectKeyIdentifierExtension,
  basicConstraintsExtension,
} from "../../src/x509.ts";
import { createVm, enginePids, installGuestTools, sh } from "../lib/engine.ts";
import { type Bench, MiB, mbps } from "../lib/harness.ts";

/** Hostname the guest uses; resolved on the host to loopback */
const UPSTREAM_HOST = "localhost";
/** Address the guest connects to; any address routed to the host works */
const GUEST_TARGET_IP = "203.0.113.5";

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "/";
  if (req.method === "POST" && url === "/upload") {
    let n = 0;
    req.on("data", (chunk: Buffer) => (n += chunk.length));
    req.on("end", () => res.end(String(n)));
    return;
  }
  const m = /^\/bytes\/(\d+)$/.exec(url);
  if (m) {
    const total = Number(m[1]);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": total,
    });
    const block = Buffer.alloc(Math.min(MiB, total));
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        const chunk = block.subarray(0, Math.min(block.length, total - sent));
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once("drain", pump);
      }
      res.end();
    };
    pump();
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok\n".repeat(20));
}

/** Self-signed `localhost` certificate, trusted for this process' default TLS store */
function makeCert() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const name = encodeCommonNameName(UPSTREAM_HOST);
  const der = createCertificate({
    publicKey,
    signingKey: privateKey,
    serialNumber: crypto.randomBytes(8).fill(0x7f, 0, 1),
    notBefore: new Date(Date.now() - 3600_000),
    notAfter: new Date(Date.now() + 86400_000),
    subject: name,
    issuer: name,
    extensions: [
      basicConstraintsExtension({ ca: true }),
      subjectAltNameExtension(UPSTREAM_HOST),
      subjectKeyIdentifierExtension(computeKeyIdentifier(publicKey)),
    ],
  });
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`;
  return {
    certPem,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

/** Listen on 127.0.0.1 and ::1 with the same port so `localhost` works either way */
async function listenLoopback(
  make: () => net.Server,
): Promise<{ port: number; servers: net.Server[] }> {
  const v4 = make();
  await new Promise<void>((resolve) => v4.listen(0, "127.0.0.1", resolve));
  const port = (v4.address() as net.AddressInfo).port;
  const servers = [v4];
  const v6 = make();
  await new Promise<void>((resolve) => {
    v6.once("error", () => resolve());
    v6.listen(port, "::1", () => {
      servers.push(v6);
      resolve();
    });
  });
  return { port, servers };
}

type Variant = { name: string; description: string; hooks: HttpHooks };

function variants(): Variant[] {
  const policy = {
    allowedHosts: [UPSTREAM_HOST],
    allowedInternalHosts: [UPSTREAM_HOST],
  };
  return [
    {
      name: "policy",
      description: "createHttpHooks({ allowedHosts, allowedInternalHosts })",
      hooks: createHttpHooks(policy).httpHooks,
    },
    {
      name: "ip-allow",
      description: "minimal hooks: { isIpAllowed: () => true }",
      hooks: { isIpAllowed: () => true },
    },
    {
      name: "policy-noop-hooks",
      description: "policy + no-op onRequest/onResponse",
      hooks: createHttpHooks({
        ...policy,
        onRequest: () => {},
        onResponse: () => {},
      }).httpHooks,
    },
    {
      name: "policy-body-hooks",
      description: "policy + onRequest/onResponse reading cloned bodies",
      hooks: createHttpHooks({
        ...policy,
        onRequest: async (request) => {
          if (request.body) await request.clone().arrayBuffer();
        },
        onResponse: async (response) => {
          await response.clone().arrayBuffer();
        },
      }).httpHooks,
    },
  ];
}

export async function netSuite(bench: Bench) {
  const servers: net.Server[] = [];
  const previousCa = tls.getCACertificates("default");
  try {
    const { certPem, keyPem } = makeCert();
    tls.setDefaultCACertificates([...previousCa, certPem]);
    const httpUp = await listenLoopback(() => http.createServer(handler));
    const httpsUp = await listenLoopback(() =>
      https.createServer({ cert: certPem, key: keyPem }, handler),
    );
    servers.push(...httpUp.servers, ...httpsUp.servers);
    const ports = { http: httpUp.port, https: httpsUp.port };

    const seqCount = bench.q(50, 10);
    const smallBytes = bench.q(32, 8) * MiB;
    const largeBytes = bench.q(256, 32) * MiB;

    for (const variant of variants()) {
      let vm: VM | null = null;
      try {
        vm = await createVm({
          httpHooks: variant.hooks,
          maxHttpBodyBytes: 64 * MiB,
        });
        const guest = vm;
        await installGuestTools(guest);
        const client = async (
          scheme: "http" | "https",
          config: Record<string, unknown>,
          signal: AbortSignal,
        ) => {
          const cfg = JSON.stringify({
            scheme,
            host: UPSTREAM_HOST,
            port: ports[scheme],
            ip: GUEST_TARGET_IP,
            ...config,
          });
          const out = await sh(
            guest,
            `SSL_CERT_FILE=/run/gondolin/ca-certificates.crt python3 /tmp/bench/netclient.py '${cfg}'`,
            signal,
          );
          return JSON.parse(out) as {
            ms?: number[];
            wallMs?: number;
            requests?: number;
          };
        };
        const pids = () => enginePids(guest);
        const params = (extra: Record<string, unknown>) => ({
          hooks: variant.description,
          upstream: `${UPSTREAM_HOST} (host loopback, allowed via allowedInternalHosts)`,
          timing: "python3 http.client in guest",
          ...extra,
        });
        const full = variant.name === "policy";
        const schemes: ("http" | "https")[] = full
          ? ["http", "https"]
          : ["http"];

        for (const scheme of schemes) {
          await bench.run({
            name: `net.${scheme}-seq.${variant.name}`,
            params: params({
              requestsPerIteration: seqCount,
              connection: "new per request",
              path: "/small",
            }),
            warmup: 1,
            iterations: 3,
            run: async (_i, signal) => ({
              requestMs: (
                await client(
                  scheme,
                  { mode: "seq", count: seqCount, path: "/small" },
                  signal,
                )
              ).ms!,
            }),
          });
        }
        if (full) {
          for (const scheme of schemes) {
            await bench.run({
              name: `net.${scheme}-keepalive.${variant.name}`,
              params: params({
                requestsPerIteration: seqCount,
                connection: "keep-alive",
                path: "/small",
              }),
              warmup: 1,
              iterations: 3,
              run: async (_i, signal) => ({
                requestMs: (
                  await client(
                    scheme,
                    { mode: "keepalive", count: seqCount, path: "/small" },
                    signal,
                  )
                ).ms!,
              }),
            });
          }
          const concurrency = 8;
          const total = bench.q(200, 40);
          await bench.run({
            name: `net.http-concurrent.${variant.name}`,
            params: params({
              concurrency,
              requestsPerIteration: total,
              connection: "new per request",
            }),
            warmup: 1,
            iterations: 3,
            units: { requestsPerSec: "ops/s" },
            run: async (_i, signal) => {
              const out = await client(
                "http",
                {
                  mode: "concurrent",
                  count: total,
                  concurrency,
                  path: "/small",
                },
                signal,
              );
              return {
                requestMs: out.ms!,
                requestsPerSec: out.requests! / (out.wallMs! / 1000),
              };
            },
          });
        }
        const transfers: [
          string,
          "http" | "https",
          "download" | "upload",
          number,
        ][] = [
          ["http-download", "http", "download", smallBytes],
          ["http-upload", "http", "upload", smallBytes],
        ];
        if (full) {
          transfers.push(
            ["https-download", "https", "download", smallBytes],
            ["https-upload", "https", "upload", smallBytes],
            ["http-download-large", "http", "download", largeBytes],
            ["https-download-large", "https", "download", largeBytes],
          );
        }
        for (const [label, scheme, mode, bytes] of transfers) {
          await bench.run({
            name: `net.${label}.${variant.name}`,
            params: params({ bytes }),
            warmup: 1,
            iterations: 5,
            cost: true,
            enginePids: pids,
            units: { MBps: "MB/s" },
            run: async (_i, signal) => {
              const out = await client(scheme, { mode, bytes }, signal);
              return { guestMs: out.wallMs!, MBps: mbps(bytes, out.wallMs!) };
            },
          });
        }
      } catch (err) {
        bench.fail(`net.setup.${variant.name}`, err);
      } finally {
        if (vm) await vm.close().catch(() => {});
      }
    }
  } catch (err) {
    bench.fail("net.setup", err);
  } finally {
    for (const server of servers) server.close();
    tls.setDefaultCACertificates(previousCa);
  }
}
