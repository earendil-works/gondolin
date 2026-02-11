import assert from "node:assert/strict";
import test from "node:test";

import { NetworkStack } from "../src/network-stack";

function checksum16(buf: Buffer): number {
  let sum = 0;
  for (let i = 0; i < buf.length - 1; i += 2) {
    sum += buf.readUInt16BE(i);
  }
  if (buf.length % 2 === 1) {
    sum += buf[buf.length - 1] << 8;
  }
  while (sum >> 16) {
    sum = (sum & 0xffff) + (sum >> 16);
  }
  return (~sum) & 0xffff;
}

function mac(bytes: number[]) {
  return Buffer.from(bytes);
}

function ip(bytes: number[]) {
  return Buffer.from(bytes);
}

function buildEthernetFrame(opts: {
  dstMac: Buffer;
  srcMac: Buffer;
  etherType: number;
  payload: Buffer;
}): Buffer {
  const frame = Buffer.alloc(14 + opts.payload.length);
  opts.dstMac.copy(frame, 0);
  opts.srcMac.copy(frame, 6);
  frame.writeUInt16BE(opts.etherType, 12);
  opts.payload.copy(frame, 14);
  return frame;
}

function buildIPv4Packet(opts: {
  srcIP: Buffer;
  dstIP: Buffer;
  protocol: number;
  payload: Buffer;
}): Buffer {
  const header = Buffer.alloc(20);
  header[0] = 0x45;
  header[1] = 0;
  header.writeUInt16BE(20 + opts.payload.length, 2);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(0, 6);
  header[8] = 64;
  header[9] = opts.protocol;
  opts.srcIP.copy(header, 12);
  opts.dstIP.copy(header, 16);
  header.writeUInt16BE(0, 10);
  header.writeUInt16BE(checksum16(header), 10);
  return Buffer.concat([header, opts.payload]);
}

function buildUdpDatagram(opts: {
  srcPort: number;
  dstPort: number;
  payload: Buffer;
  checksum?: number;
}): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(opts.srcPort, 0);
  header.writeUInt16BE(opts.dstPort, 2);
  header.writeUInt16BE(8 + opts.payload.length, 4);
  header.writeUInt16BE(opts.checksum ?? 0, 6);
  return Buffer.concat([header, opts.payload]);
}

function buildTcpSegment(opts: {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: number;
  payload?: Buffer;
}): Buffer {
  const payload = opts.payload ?? Buffer.alloc(0);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(opts.srcPort, 0);
  header.writeUInt16BE(opts.dstPort, 2);
  header.writeUInt32BE(opts.seq >>> 0, 4);
  header.writeUInt32BE(opts.ack >>> 0, 8);
  header[12] = 0x50;
  header[13] = opts.flags;
  header.writeUInt16BE(65535, 14);
  header.writeUInt16BE(0, 16);
  header.writeUInt16BE(0, 18);
  return Buffer.concat([header, payload]);
}

function buildIcmpEchoRequest(opts: {
  id: number;
  seq: number;
  payload?: Buffer;
}): Buffer {
  const payload = opts.payload ?? Buffer.from("hello");
  const msg = Buffer.alloc(8 + payload.length);
  msg[0] = 8; // echo request
  msg[1] = 0;
  msg.writeUInt16BE(0, 2);
  msg.writeUInt16BE(opts.id, 4);
  msg.writeUInt16BE(opts.seq, 6);
  payload.copy(msg, 8);
  msg.writeUInt16BE(checksum16(msg), 2);
  return msg;
}

function qemuPacketFromFrame(frame: Buffer): Buffer {
  const packet = Buffer.alloc(4 + frame.length);
  packet.writeUInt32BE(frame.length, 0);
  frame.copy(packet, 4);
  return packet;
}

function decodeFramesFromQemuData(data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;

  while (offset + 4 <= data.length) {
    const len = data.readUInt32BE(offset);
    assert.ok(offset + 4 + len <= data.length, "incomplete qemu frame in tx stream");
    frames.push(data.subarray(offset + 4, offset + 4 + len));
    offset += 4 + len;
  }

  assert.equal(offset, data.length, "trailing bytes after qemu frames");
  return frames;
}

function drainAllQemuTx(stack: NetworkStack): Buffer {
  const chunks: Buffer[] = [];

  // Guard against regressions where `hasPendingData()` never flips to false.
  // In normal operation this should complete in a handful of iterations.
  let iterations = 0;
  const maxIterations = 10_000;

  while (stack.hasPendingData()) {
    iterations++;
    assert.ok(iterations < maxIterations, "drainAllQemuTx: exceeded max iterations (no progress?)");

    const chunk = stack.readFromNetwork(1 << 20);
    assert.ok(chunk, "drainAllQemuTx: readFromNetwork returned null while hasPendingData() is true");
    assert.ok(chunk.length > 0, "drainAllQemuTx: readFromNetwork returned empty buffer");

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function parseEthernet(frame: Buffer) {
  assert.ok(frame.length >= 14);
  return {
    dstMac: frame.subarray(0, 6),
    srcMac: frame.subarray(6, 12),
    etherType: frame.readUInt16BE(12),
    payload: frame.subarray(14),
  };
}

function parseIPv4(packet: Buffer) {
  assert.ok(packet.length >= 20);
  const version = packet[0] >> 4;
  const ihl = (packet[0] & 0x0f) * 4;
  const totalLen = packet.readUInt16BE(2);
  return {
    version,
    ihl,
    totalLen,
    protocol: packet[9],
    srcIP: packet.subarray(12, 16),
    dstIP: packet.subarray(16, 20),
    header: packet.subarray(0, ihl),
    payload: packet.subarray(ihl, totalLen),
  };
}

test("network-stack: calculateChecksum matches independent implementation", () => {
  const stack = new NetworkStack({
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
    dnsServers: ["8.8.8.8"],
  });

  const even = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  const odd = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01]);

  assert.equal(stack.calculateChecksum(even), checksum16(even));
  assert.equal(stack.calculateChecksum(odd), checksum16(odd));
});

test("network-stack: ARP request for gateway gets reply", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const stack = new NetworkStack({
    gatewayIP: "192.168.127.1",
    vmIP: "192.168.127.3",
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });

  // Ethernet ARP payload is 28 bytes. We only set the fields the implementation reads.
  const arp = Buffer.alloc(28);
  // htype/ptype/hlen/plen
  arp.writeUInt16BE(1, 0);
  arp.writeUInt16BE(0x0800, 2);
  arp[4] = 6;
  arp[5] = 4;
  // op = request
  arp.writeUInt16BE(1, 6);

  // sender MAC / sender IP
  vmMac.copy(arp, 8);
  ip([192, 168, 127, 3]).copy(arp, 14);

  // target MAC (unknown) / target IP (gateway)
  mac([0, 0, 0, 0, 0, 0]).copy(arp, 18);
  ip([192, 168, 127, 1]).copy(arp, 24);

  const frame = buildEthernetFrame({
    dstMac: mac([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    srcMac: vmMac,
    etherType: 0x0806,
    payload: arp,
  });

  stack.receive(frame);

  const tx = drainAllQemuTx(stack);
  const frames = decodeFramesFromQemuData(tx);
  assert.equal(frames.length, 1);

  const out = parseEthernet(frames[0]);
  assert.equal(out.etherType, 0x0806);
  assert.deepEqual([...out.dstMac], [...vmMac]);
  assert.deepEqual([...out.srcMac], [...gatewayMac]);

  const reply = out.payload;
  assert.equal(reply.readUInt16BE(6), 2, "expected ARP reply");
  assert.deepEqual([...reply.subarray(8, 14)], [...gatewayMac]);
  assert.deepEqual([...reply.subarray(14, 18)], [192, 168, 127, 1]);
});

test("network-stack: ICMP echo request produces echo reply", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const stack = new NetworkStack({
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });

  let icmpEventCount = 0;
  stack.on("icmp", () => {
    icmpEventCount++;
  });

  const icmpReq = buildIcmpEchoRequest({ id: 0x1234, seq: 9, payload: Buffer.from("abc") });
  const ipPacket = buildIPv4Packet({
    srcIP: ip([192, 168, 127, 3]),
    dstIP: ip([8, 8, 8, 8]),
    protocol: 1,
    payload: icmpReq,
  });
  const frame = buildEthernetFrame({
    dstMac: gatewayMac,
    srcMac: vmMac,
    etherType: 0x0800,
    payload: ipPacket,
  });

  stack.receive(frame);

  assert.equal(icmpEventCount, 1);

  const tx = drainAllQemuTx(stack);
  const frames = decodeFramesFromQemuData(tx);
  assert.equal(frames.length, 1);

  const eth = parseEthernet(frames[0]);
  assert.equal(eth.etherType, 0x0800);

  const ipOut = parseIPv4(eth.payload);
  assert.equal(ipOut.protocol, 1);
  assert.deepEqual([...ipOut.srcIP], [8, 8, 8, 8]);
  assert.deepEqual([...ipOut.dstIP], [192, 168, 127, 3]);

  const icmpReply = ipOut.payload;
  assert.equal(icmpReply[0], 0, "expected echo reply");
  assert.equal(icmpReply.readUInt16BE(4), 0x1234);
  assert.equal(icmpReply.readUInt16BE(6), 9);

  // verify ICMP checksum
  const tmp = Buffer.from(icmpReply);
  tmp.writeUInt16BE(0, 2);
  assert.equal(icmpReply.readUInt16BE(2), checksum16(tmp));
});

test("network-stack: writeToNetwork parses qemu framing (partial writes)", () => {
  const events: any[] = [];
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const stack = new NetworkStack({
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    callbacks: {
      onUdpSend: (m) => events.push(m),
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });

  const udp = buildUdpDatagram({ srcPort: 1234, dstPort: 53, payload: Buffer.from([1, 2, 3]) });
  const ipPacket = buildIPv4Packet({
    srcIP: ip([192, 168, 127, 3]),
    dstIP: ip([8, 8, 8, 8]),
    protocol: 17,
    payload: udp,
  });
  const frame = buildEthernetFrame({
    dstMac: gatewayMac,
    srcMac: vmMac,
    etherType: 0x0800,
    payload: ipPacket,
  });
  const qemuPacket = qemuPacketFromFrame(frame);

  stack.writeToNetwork(qemuPacket.subarray(0, 7));
  assert.equal(events.length, 0);
  stack.writeToNetwork(qemuPacket.subarray(7));

  assert.equal(events.length, 1);
  assert.equal(events[0].dstPort, 53);
  assert.deepEqual([...events[0].payload], [1, 2, 3]);
});

test("network-stack: DHCP does not advertise loopback dns servers", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const stack = new NetworkStack({
    gatewayIP: "192.168.127.1",
    vmIP: "192.168.127.3",
    gatewayMac,
    vmMac,
    dnsServers: ["127.0.0.53"],
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });

  const xid = 0x0a0b0c0d;

  const bootp = Buffer.alloc(240);
  bootp[0] = 1; // BOOTREQUEST
  bootp[1] = 1; // ethernet
  bootp[2] = 6;
  bootp[3] = 0;
  bootp.writeUInt32BE(xid, 4);
  bootp.writeUInt16BE(0, 8);
  bootp.writeUInt16BE(0x8000, 10);
  vmMac.copy(bootp, 28);
  bootp.writeUInt32BE(0x63825363, 236);

  const discoverOpts = Buffer.from([53, 1, 1 /* discover */, 255]);
  const dhcp = Buffer.concat([bootp, discoverOpts]);

  const udp = buildUdpDatagram({ srcPort: 68, dstPort: 67, payload: dhcp });
  const ipPacket = buildIPv4Packet({
    srcIP: ip([0, 0, 0, 0]),
    dstIP: ip([255, 255, 255, 255]),
    protocol: 17,
    payload: udp,
  });
  const frame = buildEthernetFrame({
    dstMac: mac([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    srcMac: vmMac,
    etherType: 0x0800,
    payload: ipPacket,
  });

  stack.receive(frame);

  const tx = drainAllQemuTx(stack);
  const frames = decodeFramesFromQemuData(tx);
  assert.equal(frames.length, 1);

  const eth = parseEthernet(frames[0]);
  const ipOut = parseIPv4(eth.payload);
  const udpOut = ipOut.payload;
  const dhcpOut = udpOut.subarray(8);

  // Find DHCP option 6 (DNS)
  const opts = dhcpOut.subarray(240);
  let off = 0;
  let dns: Buffer | null = null;
  while (off < opts.length) {
    const code = opts[off++]!;
    if (code === 255) break;
    if (code === 0) continue;
    const len = opts[off++]!;
    const val = opts.subarray(off, off + len);
    off += len;
    if (code === 6) {
      dns = val;
      break;
    }
  }

  assert.ok(dns, "expected DHCP DNS option");
  assert.equal(dns!.length, 4);
  assert.deepEqual([...dns!], [8, 8, 8, 8], "expected loopback DNS to be filtered out");
});

test("network-stack: DHCP discover -> OFFER and request -> ACK", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const stack = new NetworkStack({
    gatewayIP: "192.168.127.1",
    vmIP: "192.168.127.3",
    gatewayMac,
    vmMac,
    dnsServers: ["1.1.1.1"],
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });

  const dhcpEvents: any[] = [];
  stack.on("dhcp", (...args) => dhcpEvents.push(args));

  function buildDhcpMessage(msgType: number, xid: number, flags = 0x8000) {
    const bootp = Buffer.alloc(240);
    bootp[0] = 1; // BOOTREQUEST
    bootp[1] = 1; // ethernet
    bootp[2] = 6;
    bootp[3] = 0;
    bootp.writeUInt32BE(xid, 4);
    bootp.writeUInt16BE(0, 8);
    bootp.writeUInt16BE(flags, 10);
    // chaddr (16 bytes)
    vmMac.copy(bootp, 28);
    bootp.writeUInt32BE(0x63825363, 236);

    const opts = Buffer.from([53, 1, msgType, 255]);
    return Buffer.concat([bootp, opts]);
  }

  const xid = 0x0a0b0c0d;

  for (const msgType of [1 /* discover */, 3 /* request */]) {
    const dhcp = buildDhcpMessage(msgType, xid, 0x8000);
    const udp = buildUdpDatagram({ srcPort: 68, dstPort: 67, payload: dhcp });
    const ipPacket = buildIPv4Packet({
      srcIP: ip([0, 0, 0, 0]),
      dstIP: ip([255, 255, 255, 255]),
      protocol: 17,
      payload: udp,
    });
    const frame = buildEthernetFrame({
      dstMac: mac([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      srcMac: vmMac,
      etherType: 0x0800,
      payload: ipPacket,
    });

    stack.receive(frame);
  }

  assert.deepEqual(
    dhcpEvents.map((x) => x[0]),
    ["OFFER", "ACK"],
    "expected OFFER then ACK events"
  );

  const tx = drainAllQemuTx(stack);
  const frames = decodeFramesFromQemuData(tx);
  assert.equal(frames.length, 2);

  for (const [idx, expectedType] of ["OFFER", "ACK"].entries()) {
    const eth = parseEthernet(frames[idx]);
    assert.equal(eth.etherType, 0x0800);

    const ipOut = parseIPv4(eth.payload);
    assert.equal(ipOut.protocol, 17);
    assert.deepEqual([...ipOut.dstIP], [255, 255, 255, 255]);

    const udpOut = ipOut.payload;
    assert.equal(udpOut.readUInt16BE(0), 67);
    assert.equal(udpOut.readUInt16BE(2), 68);

    const dhcpOut = udpOut.subarray(8);
    assert.equal(dhcpOut[0], 2, "expected BOOTREPLY");
    assert.equal(dhcpOut.readUInt32BE(4), xid);
    // msg-type option should be present.
    const optsStart = 240;
    assert.equal(dhcpOut.readUInt32BE(236), 0x63825363);
    assert.equal(dhcpOut[optsStart], 53);
    assert.equal(dhcpOut[optsStart + 1], 1);
    const mt = dhcpOut[optsStart + 2];
    assert.equal(mt, expectedType === "OFFER" ? 2 : 5);
  }
});

test("network-stack: TCP SYN creates session and handleTcpConnected emits SYN/ACK", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const connects: any[] = [];
  const stack = new NetworkStack({
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: (m) => connects.push(m),
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });

  const srcIP = ip([192, 168, 127, 3]);
  const dstIP = ip([93, 184, 216, 34]);

  // SYN from VM
  stack.handleTCP(
    buildTcpSegment({
      srcPort: 40000,
      dstPort: 80,
      seq: 1000,
      ack: 0,
      flags: 0x02,
    }),
    srcIP,
    dstIP
  );

  assert.equal(connects.length, 1);
  const key = connects[0].key as string;

  stack.handleTcpConnected({ key });

  const tx = drainAllQemuTx(stack);
  const frames = decodeFramesFromQemuData(tx);
  assert.equal(frames.length, 1);

  const eth = parseEthernet(frames[0]);
  const ipOut = parseIPv4(eth.payload);
  assert.equal(ipOut.protocol, 6);

  const tcp = ipOut.payload;
  const flags = tcp[13];
  assert.equal(flags & 0x12, 0x12, "expected SYN+ACK");
  assert.equal(tcp.readUInt16BE(0), 80);
  assert.equal(tcp.readUInt16BE(2), 40000);

  // validate TCP checksum
  const tcpLen = ipOut.totalLen - ipOut.ihl;
  const pseudo = Buffer.alloc(12);
  ipOut.srcIP.copy(pseudo, 0);
  ipOut.dstIP.copy(pseudo, 4);
  pseudo[8] = 0;
  pseudo[9] = 6;
  pseudo.writeUInt16BE(tcpLen, 10);

  const tcpCopy = Buffer.from(tcp.subarray(0, tcpLen));
  const got = tcpCopy.readUInt16BE(16);
  tcpCopy.writeUInt16BE(0, 16);
  assert.equal(got, checksum16(Buffer.concat([pseudo, tcpCopy])));
});

test("network-stack: TCP flow classification (HTTP) emits onTcpSend and passes allowTcpFlow info", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const sends: any[] = [];
  const allowCalls: any[] = [];
  let lastKey = "";

  const stack = new NetworkStack({
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    allowTcpFlow: (info) => {
      allowCalls.push(info);
      return true;
    },
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: (m) => {
        lastKey = m.key;
      },
      onTcpSend: (m) => sends.push(m),
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });

  const srcIP = ip([192, 168, 127, 3]);
  const dstIP = ip([93, 184, 216, 34]);

  stack.handleTCP(buildTcpSegment({ srcPort: 40001, dstPort: 80, seq: 1, ack: 0, flags: 0x02 }), srcIP, dstIP);
  assert.ok(lastKey);
  stack.handleTcpConnected({ key: lastKey });
  drainAllQemuTx(stack); // drop SYN/ACK

  const http = Buffer.from("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n", "ascii");
  stack.handleTCP(
    buildTcpSegment({
      srcPort: 40001,
      dstPort: 80,
      seq: 2,
      ack: 0,
      flags: 0x18,
      payload: http,
    }),
    srcIP,
    dstIP
  );

  assert.equal(allowCalls.length, 1);
  assert.equal(allowCalls[0].protocol, "http");
  assert.equal(allowCalls[0].httpMethod, "GET");

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].data, http);

  // should ACK back
  const tx = drainAllQemuTx(stack);
  const frames = decodeFramesFromQemuData(tx);
  assert.equal(frames.length, 1);
  const ipOut = parseIPv4(parseEthernet(frames[0]).payload);
  const tcpOut = ipOut.payload;
  assert.equal(tcpOut[13] & 0x10, 0x10);
});

test("network-stack: TCP flow rejects CONNECT and unknown protocols", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const closes: any[] = [];
  const denies: any[] = [];
  let key = "";

  const stack = new NetworkStack({
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: (m) => (key = m.key),
      onTcpSend: () => {},
      onTcpClose: (m) => closes.push(m),
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });
  stack.on("tcp-deny", (d) => denies.push(d));

  const srcIP = ip([192, 168, 127, 3]);
  const dstIP = ip([93, 184, 216, 34]);

  // CONNECT should be rejected
  stack.handleTCP(buildTcpSegment({ srcPort: 40002, dstPort: 80, seq: 1, ack: 0, flags: 0x02 }), srcIP, dstIP);
  stack.handleTcpConnected({ key });
  drainAllQemuTx(stack);

  const connectReq = Buffer.from("CONNECT example.com:443 HTTP/1.1\r\n\r\n", "ascii");
  stack.handleTCP(
    buildTcpSegment({ srcPort: 40002, dstPort: 80, seq: 2, ack: 0, flags: 0x18, payload: connectReq }),
    srcIP,
    dstIP
  );

  assert.equal(closes.length, 1);
  assert.equal(closes[0].destroy, true);
  assert.equal(denies.length, 1);
  assert.equal(denies[0].reason, "connect-not-allowed");

  const tx1 = drainAllQemuTx(stack);
  const frames1 = decodeFramesFromQemuData(tx1);
  assert.equal(frames1.length, 1);
  const tcp1 = parseIPv4(parseEthernet(frames1[0]).payload).payload;
  assert.equal(tcp1[13] & 0x04, 0x04, "expected RST");

  // Unknown protocol should also be rejected quickly.
  key = "";
  closes.length = 0;
  denies.length = 0;

  stack.handleTCP(buildTcpSegment({ srcPort: 40003, dstPort: 80, seq: 1, ack: 0, flags: 0x02 }), srcIP, dstIP);
  const key2 = key;
  assert.ok(key2, "expected onTcpConnect to set key for unknown-protocol case");
  stack.handleTcpConnected({ key: key2 });
  drainAllQemuTx(stack);

  const ssh = Buffer.from("SSH-2.0-OpenSSH_9.0\r\n", "ascii");
  stack.handleTCP(
    buildTcpSegment({ srcPort: 40003, dstPort: 80, seq: 2, ack: 0, flags: 0x18, payload: ssh }),
    srcIP,
    dstIP
  );

  assert.equal(closes.length, 1);
  assert.equal(denies.length, 1);
  assert.equal(denies[0].reason, "unknown-protocol");
});

test("network-stack: TCP sniff-limit exceeded rejects incomplete HTTP request line", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const closes: any[] = [];
  const denies: any[] = [];
  let key = "";

  const stack = new NetworkStack({
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: (m) => (key = m.key),
      onTcpSend: () => {},
      onTcpClose: (m) => closes.push(m),
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });
  stack.on("tcp-deny", (d) => denies.push(d));

  const srcIP = ip([192, 168, 127, 3]);
  const dstIP = ip([93, 184, 216, 34]);

  stack.handleTCP(buildTcpSegment({ srcPort: 40004, dstPort: 80, seq: 1, ack: 0, flags: 0x02 }), srcIP, dstIP);
  stack.handleTcpConnected({ key });
  drainAllQemuTx(stack);

  // Create a payload that looks like it starts with an HTTP method, but never completes a request line.
  const payload = Buffer.from("GET /" + "a".repeat(8192), "ascii");
  stack.handleTCP(
    buildTcpSegment({ srcPort: 40004, dstPort: 80, seq: 2, ack: 0, flags: 0x18, payload }),
    srcIP,
    dstIP
  );

  assert.equal(closes.length, 1);
  assert.equal(denies.length, 1);
  assert.equal(denies[0].reason, "sniff-limit-exceeded");
});

test("network-stack: allowTcpFlow policy can deny TLS flows", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const closes: any[] = [];
  const denies: any[] = [];
  let key = "";

  const stack = new NetworkStack({
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    allowTcpFlow: (info) => info.protocol !== "tls",
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: (m) => (key = m.key),
      onTcpSend: () => {},
      onTcpClose: (m) => closes.push(m),
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });
  stack.on("tcp-deny", (d) => denies.push(d));

  const srcIP = ip([192, 168, 127, 3]);
  const dstIP = ip([93, 184, 216, 34]);

  stack.handleTCP(buildTcpSegment({ srcPort: 40005, dstPort: 443, seq: 1, ack: 0, flags: 0x02 }), srcIP, dstIP);
  stack.handleTcpConnected({ key });
  drainAllQemuTx(stack);

  // Minimal TLS ClientHello lookalike (record header is enough for classifier).
  const tls = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2f, 0x01, 0x00, 0x00, 0x2b]);
  stack.handleTCP(buildTcpSegment({ srcPort: 40005, dstPort: 443, seq: 2, ack: 0, flags: 0x18, payload: tls }), srcIP, dstIP);

  assert.equal(closes.length, 1);
  assert.equal(denies.length, 1);
  assert.equal(denies[0].reason, "policy-deny");
});

test("network-stack: TCP flow control pauses when tx buffer grows and resumes when drained", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const pauses: any[] = [];
  const resumes: any[] = [];
  let key = "";

  const stack = new NetworkStack({
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: (m) => (key = m.key),
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: (m) => pauses.push(m),
      onTcpResume: (m) => resumes.push(m),
    },
  });

  const srcIP = ip([192, 168, 127, 3]);
  const dstIP = ip([93, 184, 216, 34]);

  stack.handleTCP(buildTcpSegment({ srcPort: 40006, dstPort: 80, seq: 1, ack: 0, flags: 0x02 }), srcIP, dstIP);
  stack.handleTcpConnected({ key });
  drainAllQemuTx(stack);

  stack.handleTcpData({ key, data: Buffer.alloc(700 * 1024, 0x61) });
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].key, key);

  // Drain all queued traffic. Resume should fire once we cross the low watermark.
  drainAllQemuTx(stack);
  // Note: resume happens inside readFromNetwork while draining.
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].key, key);
});

test("network-stack: handleUdpResponse sets UDP checksum correctly", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const stack = new NetworkStack({
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });

  const data = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  stack.handleUdpResponse({
    data,
    srcIP: "8.8.8.8",
    srcPort: 53,
    dstIP: "192.168.127.3",
    dstPort: 33333,
  });

  const tx = drainAllQemuTx(stack);
  const frames = decodeFramesFromQemuData(tx);
  assert.equal(frames.length, 1);

  const eth = parseEthernet(frames[0]);
  const ipOut = parseIPv4(eth.payload);
  assert.equal(ipOut.protocol, 17);

  const udp = ipOut.payload;
  const udpLen = udp.readUInt16BE(4);
  const udpCopy = Buffer.from(udp.subarray(0, udpLen));
  const got = udpCopy.readUInt16BE(6);
  udpCopy.writeUInt16BE(0, 6);

  const pseudo = Buffer.alloc(12);
  ipOut.srcIP.copy(pseudo, 0);
  ipOut.dstIP.copy(pseudo, 4);
  pseudo[8] = 0;
  pseudo[9] = 17;
  pseudo.writeUInt16BE(udpLen, 10);

  const expected = checksum16(Buffer.concat([pseudo, udpCopy]));
  const normalized = expected === 0 ? 0xffff : expected;
  assert.equal(got, normalized);
});

test("network-stack: caps QEMU tx buffering and drops low-priority frames", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const txQueueMaxBytes = 1024;

  const stack = new NetworkStack({
    gatewayIP: "192.168.127.1",
    vmIP: "192.168.127.3",
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    txQueueMaxBytes,
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });

  let drops = 0;
  stack.on("tx-drop", () => {
    drops++;
  });

  // Generate many ICMP echo replies (low-priority) without draining QEMU.
  for (let i = 0; i < 200; i++) {
    const req = buildIcmpEchoRequest({ id: 42, seq: i, payload: Buffer.alloc(32, 0xaa) });
    const packet = buildIPv4Packet({
      srcIP: ip([192, 168, 127, 3]),
      dstIP: ip([192, 168, 127, 1]),
      protocol: 1,
      payload: req,
    });
    const frame = buildEthernetFrame({
      dstMac: gatewayMac,
      srcMac: vmMac,
      etherType: 0x0800,
      payload: packet,
    });
    stack.writeToNetwork(qemuPacketFromFrame(frame));
  }

  const tx = drainAllQemuTx(stack);
  assert.ok(tx.length <= txQueueMaxBytes, `tx stream length (${tx.length}) exceeds cap (${txQueueMaxBytes})`);

  const frames = decodeFramesFromQemuData(tx);
  assert.ok(frames.length < 200, "expected some frames to be dropped");
  assert.ok(drops > 0, "expected tx-drop events");
});

test("network-stack: high-priority TX evicts low-priority frames when capped", () => {
  const gatewayMac = mac([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
  const vmMac = mac([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

  const txQueueMaxBytes = 512;

  const stack = new NetworkStack({
    gatewayIP: "192.168.127.1",
    vmIP: "192.168.127.3",
    gatewayMac,
    vmMac,
    dnsServers: ["8.8.8.8"],
    txQueueMaxBytes,
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });

  // Fill the buffer with low-priority traffic.
  for (let i = 0; i < 100; i++) {
    const req = buildIcmpEchoRequest({ id: 1, seq: i, payload: Buffer.alloc(16, 0xbb) });
    const packet = buildIPv4Packet({
      srcIP: ip([192, 168, 127, 3]),
      dstIP: ip([192, 168, 127, 1]),
      protocol: 1,
      payload: req,
    });
    const frame = buildEthernetFrame({
      dstMac: gatewayMac,
      srcMac: vmMac,
      etherType: 0x0800,
      payload: packet,
    });
    stack.writeToNetwork(qemuPacketFromFrame(frame));
  }

  // Now trigger an ARP reply (high priority). It should make it into the queue
  // even if that means evicting low-priority frames.
  const arp = Buffer.alloc(28);
  arp.writeUInt16BE(1, 0); // htype
  arp.writeUInt16BE(0x0800, 2); // ptype
  arp[4] = 6; // hlen
  arp[5] = 4; // plen
  arp.writeUInt16BE(1, 6); // op=request
  vmMac.copy(arp, 8);
  ip([192, 168, 127, 3]).copy(arp, 14);
  // target MAC is ignored by implementation
  ip([192, 168, 127, 1]).copy(arp, 24);

  const arpFrame = buildEthernetFrame({
    dstMac: gatewayMac,
    srcMac: vmMac,
    etherType: 0x0806,
    payload: arp,
  });
  stack.writeToNetwork(qemuPacketFromFrame(arpFrame));

  const tx = drainAllQemuTx(stack);
  assert.ok(tx.length <= txQueueMaxBytes, `tx stream length (${tx.length}) exceeds cap (${txQueueMaxBytes})`);

  const frames = decodeFramesFromQemuData(tx);
  const etherTypes = frames.map((frame) => parseEthernet(frame).etherType);
  assert.ok(etherTypes.includes(0x0806), "expected ARP reply to be present despite low-priority queue being full");
});
