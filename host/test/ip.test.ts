import assert from "node:assert/strict";
import test from "node:test";

import { isInternalIpAddress } from "../src/utils/ip.ts";

test("ip: IPv6 transition formats are checked by their embedded IPv4", () => {
  for (const ip of [
    "64:ff9b::127.0.0.1",
    "64:ff9b::10.1.2.3",
    "64:ff9b::a9fe:a9fe", // 169.254.169.254
    "64:ff9b:1::7f00:1", // local-use, /96
    "64:ff9b:1:a00:1::", // local-use, /48: 10.0.0.1
    "64:ff9b:1:c0:a8:100::", // local-use, /56: 192.168.1.0
    "2002:7f00:1::1", // 6to4 127.0.0.1
    "2002:c0a8:101::", // 6to4 192.168.1.1
    "::127.0.0.1", // IPv4-compatible
    "::10.0.0.1",
    "::ffff:169.254.169.254",
    "2001:0:7f00:1::", // Teredo server 127.0.0.1
    "2001:0:808:808::f5ff:fffe", // Teredo client 10.0.0.1 (obfuscated)
  ]) {
    assert.equal(isInternalIpAddress(ip), true, ip);
  }
  for (const ip of [
    "64:ff9b::808:808",
    "2002:808:808::1",
    "::8.8.8.8",
    "2001:0:808:808::f7f7:f7f7", // Teredo client 8.8.8.8
    "2001:4860:4860::8888",
    "2001:db8::1",
  ]) {
    assert.equal(isInternalIpAddress(ip), false, ip);
  }
});
