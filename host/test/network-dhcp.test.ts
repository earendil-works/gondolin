/**
 * The guest's DHCP fallback: current daemons configure the guest network
 * with `gondolin.net` on the kernel command line, so the DHCP path in the
 * init script (used by older daemons and images that cannot apply it) would
 * otherwise never run. GONDOLIN_GUEST_DHCP=1 makes the daemon leave the
 * argument out; the guest must still get its address and resolver and reach
 * the network through the host.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import test from "node:test";

import { createHttpHooks } from "../src/http/hooks.ts";
import { VM } from "../src/vm/core.ts";
import { scheduleForceExit, shouldSkipVmTests } from "./helpers/vm-fixture.ts";

const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);
const PUBLIC_IP = "203.0.113.5";

test("guest network over DHCP when gondolin.net is left out", {
  skip: shouldSkipVmTests() ? "hardware virtualization unavailable" : false,
  timeout: timeoutMs,
}, async () => {
  const server = http.createServer((_req, res) => res.end("dhcp-ok\n"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const hooks = createHttpHooks({
    allowedHosts: ["localhost"],
    allowedInternalHosts: ["localhost"],
  });

  const previous = process.env.GONDOLIN_GUEST_DHCP;
  // read by the daemon this VM spawns
  process.env.GONDOLIN_GUEST_DHCP = "1";
  let vm: VM | null = null;
  try {
    vm = await VM.create({ httpHooks: hooks.httpHooks, env: hooks.env });
    const r = await vm.exec([
      "/bin/sh",
      "-c",
      [
        "grep -c gondolin.net= /proc/cmdline || true",
        "ip -4 addr show eth0 | grep -o 'inet [0-9./]*'",
        "grep -c '^nameserver' /etc/resolv.conf",
        "getent ahostsv4 example.com > /dev/null && echo dns-ok",
        `curl -sS -m 20 --connect-to localhost:${port}:${PUBLIC_IP}:${port} http://localhost:${port}/`,
      ].join("; "),
    ]);
    const lines = String(r.stdout).trim().split("\n");
    assert.equal(lines[0], "0", "gondolin.net must not be on the command line");
    assert.match(
      lines[1] ?? "",
      /^inet 192\.168\.127\.\d+\/24$/,
      String(r.stdout),
    );
    assert.ok(Number(lines[2]) >= 1, `no resolver from DHCP: ${r.stdout}`);
    assert.equal(lines[3], "dns-ok", String(r.stdout) + String(r.stderr));
    assert.equal(lines[4], "dhcp-ok", String(r.stdout) + String(r.stderr));
  } finally {
    if (previous === undefined) delete process.env.GONDOLIN_GUEST_DHCP;
    else process.env.GONDOLIN_GUEST_DHCP = previous;
    await vm?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    scheduleForceExit();
  }
});
