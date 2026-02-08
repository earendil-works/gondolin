import assert from "node:assert/strict";
import test from "node:test";

import { buildSyntheticDnsResponse, parseDnsQuery } from "../src/dns";

function buildQuestionA(name: string): Buffer {
  const labels = name.split(".").filter(Boolean);
  const qnameParts: Buffer[] = [];
  for (const label of labels) {
    const b = Buffer.from(label, "ascii");
    qnameParts.push(Buffer.from([b.length]));
    qnameParts.push(b);
  }
  qnameParts.push(Buffer.from([0]));
  const qname = Buffer.concat(qnameParts);

  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0); // A
  tail.writeUInt16BE(1, 2); // IN

  return Buffer.concat([qname, tail]);
}

function buildQueryA(name: string, id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  return Buffer.concat([header, buildQuestionA(name)]);
}

function buildQuestionAAAA(name: string): Buffer {
  const labels = name.split(".").filter(Boolean);
  const qnameParts: Buffer[] = [];
  for (const label of labels) {
    const b = Buffer.from(label, "ascii");
    qnameParts.push(Buffer.from([b.length]));
    qnameParts.push(b);
  }
  qnameParts.push(Buffer.from([0]));
  const qname = Buffer.concat(qnameParts);

  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(28, 0); // AAAA
  tail.writeUInt16BE(1, 2); // IN

  return Buffer.concat([qname, tail]);
}

function buildQueryAAAA(name: string, id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  return Buffer.concat([header, buildQuestionAAAA(name)]);
}

test("dns: parseDnsQuery + buildSyntheticDnsResponse (A)", () => {
  const queryBuf = buildQueryA("example.com", 0xabcd);
  const query = parseDnsQuery(queryBuf);
  assert.ok(query);
  assert.equal(query.id, 0xabcd);
  assert.equal(query.firstQuestion.name, "example.com");

  const response = buildSyntheticDnsResponse(query, {
    ipv4: "192.0.2.1",
    ipv6: "2001:db8::1",
    ttlSeconds: 60,
  });

  assert.equal(response.readUInt16BE(0), 0xabcd);
  const flags = response.readUInt16BE(2);
  assert.ok((flags & 0x8000) !== 0, "QR bit should be set");
  assert.equal(response.readUInt16BE(4), 1); // QDCOUNT
  assert.equal(response.readUInt16BE(6), 1); // ANCOUNT

  // RDATA for A is the final 4 bytes in our synthesized response
  assert.deepEqual([...response.subarray(response.length - 4)], [192, 0, 2, 1]);
});

test("dns: synthetic response returns loopback for localhost (A + AAAA)", () => {
  const queryA = parseDnsQuery(buildQueryA("localhost", 0x1111));
  assert.ok(queryA);
  const responseA = buildSyntheticDnsResponse(queryA, {
    ipv4: "192.0.2.1",
    ipv6: "2001:db8::1",
    ttlSeconds: 60,
  });
  assert.equal(responseA.readUInt16BE(6), 1); // ANCOUNT
  assert.deepEqual([...responseA.subarray(responseA.length - 4)], [127, 0, 0, 1]);

  const queryAAAA = parseDnsQuery(buildQueryAAAA("localhost", 0x2222));
  assert.ok(queryAAAA);
  const responseAAAA = buildSyntheticDnsResponse(queryAAAA, {
    ipv4: "192.0.2.1",
    ipv6: "2001:db8::1",
    ttlSeconds: 60,
  });
  assert.equal(responseAAAA.readUInt16BE(6), 1); // ANCOUNT
  assert.deepEqual(
    [...responseAAAA.subarray(responseAAAA.length - 16)],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
  );
});

test("dns: synthetic response only echoes first question when QDCOUNT > 1", () => {
  const q1 = buildQuestionA("example.com");
  const q2 = buildQuestionA("example.net");

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0xbeef, 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(2, 4); // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const queryBuf = Buffer.concat([header, q1, q2]);
  const query = parseDnsQuery(queryBuf);
  assert.ok(query);

  // parseDnsQuery should preserve only the first question bytes (we always answer QDCOUNT=1)
  assert.deepEqual(query.questionSection, q1);

  const response = buildSyntheticDnsResponse(query, {
    ipv4: "192.0.2.1",
    ipv6: "2001:db8::1",
    ttlSeconds: 60,
  });

  assert.equal(response.readUInt16BE(4), 1); // QDCOUNT
  assert.deepEqual(response.subarray(12, 12 + q1.length), q1);
  assert.ok(!response.includes(Buffer.from("example.net", "ascii")));
});
