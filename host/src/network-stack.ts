import { EventEmitter } from "events";
import { performance } from "perf_hooks";
import dns from "dns";
import net from "net";

// Protocol Constants
const ETH_P_IP = 0x0800;
const ETH_P_ARP = 0x0806;
const IP_PROTO_TCP = 6;
const IP_PROTO_UDP = 17;
const IP_PROTO_ICMP = 1;

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
];

// DHCP Constants
const DHCP_SERVER_PORT = 67;
const DHCP_CLIENT_PORT = 68;
const DHCP_MAGIC_COOKIE = 0x63825363;

// DHCP Message Types
const DHCP_DISCOVER = 1;
const DHCP_OFFER = 2;
const DHCP_REQUEST = 3;
const DHCP_ACK = 5;

// DHCP Options
const DHCP_OPT_SUBNET_MASK = 1;
const DHCP_OPT_ROUTER = 3;
const DHCP_OPT_DNS = 6;
const DHCP_OPT_REQUESTED_IP = 50;
const DHCP_OPT_LEASE_TIME = 51;
const DHCP_OPT_MSG_TYPE = 53;
const DHCP_OPT_SERVER_ID = 54;
const DHCP_OPT_END = 255;

function normalizeDnsServers(servers?: string[]): string[] {
  const candidates = (servers && servers.length > 0 ? servers : dns.getServers())
    .map((server) => server.split("%")[0])
    .filter((server) => net.isIP(server) === 4)
    // Guest resolvers must be reachable over the virtual NIC; loopback resolvers are not.
    .filter((server) => !server.startsWith("127."))
    .filter((server) => server !== "0.0.0.0" && server !== "255.255.255.255");

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const server of candidates) {
    if (seen.has(server)) continue;
    seen.add(server);
    unique.push(server);
  }

  return unique.length > 0 ? unique : ["8.8.8.8"];
}

export type UdpSendMessage = {
  /** nat/session key */
  key: string;
  /** destination ipv4 address */
  dstIP: string;
  /** destination udp port */
  dstPort: number;
  /** source ipv4 address */
  srcIP: string;
  /** source udp port */
  srcPort: number;
  /** udp payload */
  payload: Buffer;
};

export type TcpConnectMessage = {
  /** nat/session key */
  key: string;
  /** destination ipv4 address */
  dstIP: string;
  /** destination tcp port */
  dstPort: number;
  /** source ipv4 address */
  srcIP: string;
  /** source tcp port */
  srcPort: number;
};

export type TcpSendMessage = {
  /** nat/session key */
  key: string;
  /** tcp payload */
  data: Buffer;
};

export type TcpCloseMessage = {
  /** nat/session key */
  key: string;
  /** whether to force-close the socket */
  destroy: boolean;
};

export type TcpPauseMessage = {
  /** nat/session key */
  key: string;
};

export type TcpResumeMessage = {
  /** nat/session key */
  key: string;
};

export type TcpFlowProtocol = "http" | "tls";

export type TcpFlowInfo = {
  /** nat/session key */
  key: string;
  /** source ipv4 address */
  srcIP: string;
  /** source tcp port */
  srcPort: number;
  /** destination ipv4 address */
  dstIP: string;
  /** destination tcp port */
  dstPort: number;
  /** detected flow protocol */
  protocol: TcpFlowProtocol;
  /** http method when protocol is "http" */
  httpMethod?: string;
};

export type NetworkCallbacks = {
  onUdpSend: (message: UdpSendMessage) => void;
  onTcpConnect: (message: TcpConnectMessage) => void;
  onTcpSend: (message: TcpSendMessage) => void;
  onTcpClose: (message: TcpCloseMessage) => void;
  onTcpPause: (message: TcpPauseMessage) => void;
  onTcpResume: (message: TcpResumeMessage) => void;
};

type TcpSession = {
  state: string;
  srcIP: Buffer;
  srcPort: number;
  dstIP: Buffer;
  dstPort: number;
  vmSeq: number;
  vmAck: number;
  mySeq: number;
  myAck: number;
  flowProtocol: TcpFlowProtocol | null;
  pendingData: Buffer;
  httpMethod?: string;
};

export type NetworkStackOptions = {
  /** gateway ipv4 address */
  gatewayIP?: string;
  /** guest ipv4 address */
  vmIP?: string;
  /** gateway mac address */
  gatewayMac?: Buffer;
  /** guest mac address */
  vmMac?: Buffer;
  /** dns server ipv4 addresses */
  dnsServers?: string[];
  /** network event callbacks */
  callbacks: NetworkCallbacks;
  /** policy callback for allowing a sniffed tcp flow */
  allowTcpFlow?: (info: TcpFlowInfo) => boolean;
  /** qemu tx buffer hard cap in `bytes` (includes the 4-byte length prefix) */
  txQueueMaxBytes?: number;
};

export type TxPriority = "high" | "low";

/**
 * Payload for the `"tx-drop"` event emitted by {@link NetworkStack}.
 *
 * Emitted when an outgoing (host->guest) ethernet frame is dropped (or evicted)
 * because the QEMU TX queue hit its hard cap.
 */
export type TxDropInfo = {
  /** queue priority */
  priority: TxPriority;
  /** bytes dropped/evicted in `bytes` */
  bytes: number;
  /** drop/eviction reason */
  reason: "queue-full" | "packet-too-large" | "evicted";
  /** bytes evicted from the low-priority queue in `bytes` (high priority only) */
  evictedBytes?: number;
};

export class NetworkStack extends EventEmitter {
  gatewayIP: string;
  vmIP: string;
  gatewayMac: Buffer;
  vmMac: Buffer | null;
  dnsServers: string[];

  private readonly callbacks: NetworkCallbacks;
  private readonly allowTcpFlow: (info: TcpFlowInfo) => boolean;
  private readonly natTable = new Map<string, TcpSession>();

  private readonly MAX_FLOW_SNIFF = 8 * 1024;

  private rxBuffer = Buffer.alloc(0);

  private txQueueHigh: Buffer[] = [];
  private txQueueLow: Buffer[] = [];
  private txQueueSize = 0;
  private txQueueHighSize = 0;

  private readonly TX_QUEUE_MAX_BYTES: number;

  private readonly TX_BUFFER_HIGH_WATER = 512 * 1024;
  private readonly TX_BUFFER_LOW_WATER = 128 * 1024;
  private readonly txPaused = new Set<string>();

  constructor(options: NetworkStackOptions) {
    super();
    this.gatewayIP = options.gatewayIP ?? "192.168.127.1";
    this.vmIP = options.vmIP ?? "192.168.127.3";
    this.gatewayMac =
      options.gatewayMac ?? Buffer.from([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
    this.vmMac =
      options.vmMac ?? Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
    this.dnsServers = normalizeDnsServers(options.dnsServers);
    this.callbacks = options.callbacks;
    this.allowTcpFlow = options.allowTcpFlow ?? (() => true);
    this.TX_QUEUE_MAX_BYTES = options.txQueueMaxBytes ?? 8 * 1024 * 1024;
  }

  reset() {
    this.natTable.clear();
    this.rxBuffer = Buffer.alloc(0);
    this.txQueueHigh = [];
    this.txQueueLow = [];
    this.txQueueSize = 0;
    this.txQueueHighSize = 0;
    this.txPaused.clear();
  }

  hasPendingData() {
    return this.txQueueSize > 0;
  }

  // Called when QEMU writes data to the network interface
  writeToNetwork(data: Buffer) {
    this.rxBuffer = Buffer.concat([this.rxBuffer, data]);

    while (this.rxBuffer.length >= 4) {
      const frameLen = this.rxBuffer.readUInt32BE(0);
      if (this.rxBuffer.length < 4 + frameLen) break;

      const frame = this.rxBuffer.subarray(4, 4 + frameLen);
      this.receive(frame);

      this.rxBuffer = this.rxBuffer.subarray(4 + frameLen);
    }
  }

  // Called when QEMU wants to read data from the network interface
  readFromNetwork(maxLen: number): Buffer | null {
    if (this.txQueueSize === 0) return null;

    let remaining = maxLen;
    let total = 0;
    const chunks: Buffer[] = [];

    while (remaining > 0 && this.txQueueSize > 0) {
      const useHigh = this.txQueueHigh.length > 0;
      const queue = useHigh ? this.txQueueHigh : this.txQueueLow;

      const head = queue[0];
      const consumed = Math.min(head.length, remaining);
      chunks.push(consumed === head.length ? head : head.subarray(0, consumed));

      if (consumed === head.length) {
        queue.shift();
      } else {
        queue[0] = head.subarray(consumed);
      }

      remaining -= consumed;
      total += consumed;
      this.txQueueSize -= consumed;
      if (useHigh) {
        this.txQueueHighSize -= consumed;
      }
    }

    if (this.txQueueHighSize < this.TX_BUFFER_LOW_WATER && this.txPaused.size > 0) {
      for (const key of this.txPaused) {
        this.callbacks.onTcpResume({ key });
      }
      this.txPaused.clear();
    }

    if (chunks.length === 1 && chunks[0].length === total) {
      return chunks[0];
    }
    return Buffer.concat(chunks, total);
  }

  send(payload: Buffer, proto: number) {
    if (!this.vmMac) return;

    const frame = Buffer.alloc(14 + payload.length);
    this.vmMac.copy(frame, 0);
    this.gatewayMac.copy(frame, 6);
    frame.writeUInt16BE(proto, 12);
    payload.copy(frame, 14);

    const packet = Buffer.alloc(4 + frame.length);
    packet.writeUInt32BE(frame.length, 0);
    frame.copy(packet, 4);

    this.enqueueTx(packet, this.classifyTxPriority(proto, payload));
  }

  sendBroadcast(payload: Buffer, proto: number) {
    const broadcastMac = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

    const frame = Buffer.alloc(14 + payload.length);
    broadcastMac.copy(frame, 0);
    this.gatewayMac.copy(frame, 6);
    frame.writeUInt16BE(proto, 12);
    payload.copy(frame, 14);

    const packet = Buffer.alloc(4 + frame.length);
    packet.writeUInt32BE(frame.length, 0);
    frame.copy(packet, 4);

    this.enqueueTx(packet, this.classifyTxPriority(proto, payload));
  }

  private classifyTxPriority(etherType: number, payload: Buffer): TxPriority {
    // ARP and DHCP are required for basic networking to work; keep them high priority.
    if (etherType === ETH_P_ARP) return "high";
    if (etherType !== ETH_P_IP) return "low";

    // IPv4 header is at least 20 bytes.
    if (payload.length < 20) return "low";
    const version = payload[0] >> 4;
    if (version !== 4) return "low";

    const ipProto = payload[9];
    if (ipProto === IP_PROTO_TCP) return "high";
    return "low";
  }

  /**
   * Enqueues a QEMU-framed ethernet packet for host->guest delivery.
   *
   * Emits:
   * - `"network-activity"` when something is queued
   * - `"tx-drop"` with {@link TxDropInfo} when a packet is dropped/evicted due to queue limits
   */
  private enqueueTx(packet: Buffer, priority: TxPriority) {
    if (packet.length === 0) return;

    if (packet.length > this.TX_QUEUE_MAX_BYTES) {
      const info: TxDropInfo = {
        priority,
        bytes: packet.length,
        reason: "packet-too-large",
      };
      this.emit("tx-drop", info);
      return;
    }

    // Enforce a hard cap to avoid unbounded memory growth if QEMU stops draining.
    if (this.txQueueSize + packet.length > this.TX_QUEUE_MAX_BYTES) {
      if (priority === "low") {
        const info: TxDropInfo = {
          priority,
          bytes: packet.length,
          reason: "queue-full",
        };
        this.emit("tx-drop", info);
        return;
      }

      // For high-priority packets (TCP/ARP), evict low-priority packets first.
      let evictedBytes = 0;
      while (this.txQueueLow.length > 0 && this.txQueueSize + packet.length > this.TX_QUEUE_MAX_BYTES) {
        const evicted = this.txQueueLow.shift()!;
        evictedBytes += evicted.length;
        this.txQueueSize -= evicted.length;
      }

      if (evictedBytes > 0) {
        const info: TxDropInfo = {
          priority: "low",
          bytes: evictedBytes,
          reason: "evicted",
        };
        this.emit("tx-drop", info);
      }

      if (this.txQueueSize + packet.length > this.TX_QUEUE_MAX_BYTES) {
        const info: TxDropInfo = {
          priority,
          bytes: packet.length,
          reason: "queue-full",
          evictedBytes,
        };
        this.emit("tx-drop", info);
        return;
      }
    }

    if (priority === "high") {
      this.txQueueHigh.push(packet);
      this.txQueueHighSize += packet.length;
    } else {
      this.txQueueLow.push(packet);
    }

    this.txQueueSize += packet.length;
    this.emit("network-activity");
  }

  receive(frame: Buffer) {
    try {
      if (frame.length < 14) return;
      const etherType = frame.readUInt16BE(12);
      const payload = frame.subarray(14);

      const srcMac = frame.subarray(6, 12);
      if (!this.vmMac) {
        this.vmMac = Buffer.from(srcMac);
      }

      if (etherType === ETH_P_ARP) {
        this.handleARP(payload);
      } else if (etherType === ETH_P_IP) {
        this.handleIP(payload);
      }
    } catch (err) {
      this.emit("error", err);
    }
  }

  handleARP(packet: Buffer) {
    const op = packet.readUInt16BE(6);
    if (op === 1) {
      const targetIP = packet.subarray(24, 28);
      const targetIPStr = targetIP.join(".");

      if (targetIPStr === this.gatewayIP) {
        const reply = Buffer.alloc(28);
        packet.copy(reply, 0, 0, 8);
        reply.writeUInt16BE(2, 6);

        this.gatewayMac.copy(reply, 8);
        targetIP.copy(reply, 14);

        packet.subarray(8, 14).copy(reply, 18);
        packet.subarray(14, 18).copy(reply, 24);

        this.send(reply, ETH_P_ARP);
      }
    }
  }

  handleIP(packet: Buffer) {
    const version = packet[0] >> 4;
    if (version !== 4) return;

    const headerLen = (packet[0] & 0x0f) * 4;
    const totalLen = packet.readUInt16BE(2);
    const protocol = packet[9];
    const srcIP = packet.subarray(12, 16);
    const dstIP = packet.subarray(16, 20);

    const data = packet.subarray(headerLen, totalLen);

    if (protocol === IP_PROTO_ICMP) {
      this.handleICMP(data, srcIP, dstIP);
    } else if (protocol === IP_PROTO_TCP) {
      this.handleTCP(data, srcIP, dstIP);
    } else if (protocol === IP_PROTO_UDP) {
      this.handleUDP(data, srcIP, dstIP);
    }
  }

  calculateChecksum(buf: Buffer) {
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
    return ~sum & 0xffff;
  }

  calculateUdpChecksum(payload: Buffer, srcIP: Buffer, dstIP: Buffer) {
    const pseudo = Buffer.alloc(12);
    srcIP.copy(pseudo, 0);
    dstIP.copy(pseudo, 4);
    pseudo[8] = 0;
    pseudo[9] = IP_PROTO_UDP;
    pseudo.writeUInt16BE(payload.length, 10);

    const checksumData = Buffer.concat([pseudo, payload]);
    const checksum = this.calculateChecksum(checksumData);
    return checksum === 0 ? 0xffff : checksum;
  }

  handleICMP(data: Buffer, srcIP: Buffer, dstIP: Buffer) {
    const type = data[0];
    if (type !== 8) return;

    const wantsDebug = this.listenerCount("icmp") > 0;
    const canParse = data.length >= 8;
    const rxTime = wantsDebug ? performance.now() : 0;
    const id = wantsDebug && canParse ? data.readUInt16BE(4) : 0;
    const seq = wantsDebug && canParse ? data.readUInt16BE(6) : 0;

    const reply = Buffer.alloc(data.length);
    data.copy(reply);
    reply[0] = 0;
    reply[2] = 0;
    reply[3] = 0;

    const ck = this.calculateChecksum(reply);
    reply.writeUInt16BE(ck, 2);

    if (wantsDebug && canParse) {
      const replyTime = performance.now();
      this.emit("icmp", {
        srcIP: srcIP.join("."),
        dstIP: dstIP.join("."),
        id,
        seq,
        rxTime,
        replyTime,
        size: data.length,
      });
    }

    this.sendIP(reply, IP_PROTO_ICMP, dstIP, srcIP);
  }

  sendIP(payload: Buffer, protocol: number, srcIP: Buffer, dstIP: Buffer) {
    const header = Buffer.alloc(20);
    header[0] = 0x45;
    header[1] = 0;
    header.writeUInt16BE(20 + payload.length, 2);
    header.writeUInt16BE(0, 4);
    header.writeUInt16BE(0, 6);
    header[8] = 64;
    header[9] = protocol;
    srcIP.copy(header, 12);
    dstIP.copy(header, 16);

    header.writeUInt16BE(this.calculateChecksum(header), 10);

    const packet = Buffer.concat([header, payload]);

    if (dstIP[0] === 255 && dstIP[1] === 255 && dstIP[2] === 255 && dstIP[3] === 255) {
      this.sendBroadcast(packet, ETH_P_IP);
    } else {
      this.send(packet, ETH_P_IP);
    }
  }

  private looksLikeTlsClientHello(data: Buffer) {
    if (data.length < 5) return false;
    if (data[0] !== 0x16) return false; // handshake
    if (data[1] !== 0x03) return false; // TLS major version
    return data[2] >= 0x00 && data[2] <= 0x03;
  }

  private matchHttpMethodPrefix(data: Buffer) {
    const snippet = data.toString("ascii", 0, Math.min(data.length, 16));
    for (const method of HTTP_METHODS) {
      if (snippet.startsWith(`${method} `)) {
        return { status: "match", method } as const;
      }
      if (method.startsWith(snippet)) {
        return { status: "partial" } as const;
      }
    }
    return { status: "none" } as const;
  }

  private parseHttpRequestLine(data: Buffer) {
    const lineEnd = data.indexOf("\r\n");
    if (lineEnd === -1) return null;
    const line = data.subarray(0, lineEnd).toString("ascii");
    const [method, target, version] = line.split(" ");
    if (!method || !target || !version) return null;
    if (!version.startsWith("HTTP/")) return null;
    if (!HTTP_METHODS.includes(method)) return null;
    return { method, target, version };
  }

  private classifyTcpFlow(data: Buffer) {
    if (data.length === 0) {
      return { status: "need-more" } as const;
    }

    if (this.looksLikeTlsClientHello(data)) {
      return { status: "tls" } as const;
    }

    const prefix = this.matchHttpMethodPrefix(data);
    if (prefix.status === "match") {
      const requestLine = this.parseHttpRequestLine(data);
      if (!requestLine) {
        return { status: "need-more" } as const;
      }
      return {
        status: "http",
        method: requestLine.method,
        isConnect: requestLine.method === "CONNECT",
      } as const;
    }

    if (prefix.status === "partial") {
      return { status: "need-more" } as const;
    }

    if (data.length < 4) {
      return { status: "need-more" } as const;
    }

    return { status: "deny", reason: "unknown-protocol" } as const;
  }

  private rejectTcpFlow(session: TcpSession, key: string, ack: number, reason: string) {
    this.sendTCP(session.srcIP, session.srcPort, session.dstIP, session.dstPort, session.mySeq, ack, 0x14);
    this.callbacks.onTcpClose({ key, destroy: true });
    this.natTable.delete(key);
    this.emit("tcp-deny", { key, reason });
  }

  handleTCP(segment: Buffer, srcIP: Buffer, dstIP: Buffer) {
    const srcPort = segment.readUInt16BE(0);
    const dstPort = segment.readUInt16BE(2);
    const seq = segment.readUInt32BE(4);
    const ack = segment.readUInt32BE(8);
    const offset = (segment[12] >> 4) * 4;
    const flags = segment[13];
    const payload = segment.subarray(offset);

    const SYN = (flags & 0x02) !== 0;
    const FIN = (flags & 0x01) !== 0;
    const RST = (flags & 0x04) !== 0;

    const key = `TCP:${srcIP.join(".")}:${srcPort}:${dstIP.join(".")}:${dstPort}`;
    let session = this.natTable.get(key);

    if (RST) {
      if (session) {
        this.callbacks.onTcpClose({ key, destroy: true });
        this.natTable.delete(key);
      }
      return;
    }

    if (SYN && !session) {
      session = {
        state: "SYN_SENT",
        srcIP: Buffer.from(srcIP),
        srcPort,
        dstIP: Buffer.from(dstIP),
        dstPort,
        vmSeq: seq,
        vmAck: ack,
        mySeq: Math.floor(Math.random() * 0x0fffffff),
        myAck: seq + 1,
        flowProtocol: null,
        pendingData: Buffer.alloc(0),
      };
      this.natTable.set(key, session);

      this.callbacks.onTcpConnect({
        key,
        dstIP: dstIP.join("."),
        dstPort,
        srcIP: srcIP.join("."),
        srcPort,
      });
      return;
    }

    if (!session) {
      if (!SYN) {
        this.sendTCP(srcIP, srcPort, dstIP, dstPort, 0, seq + (payload.length || 1), 0x04);
      }
      return;
    }

    if (payload.length > 0) {
      let sendBuffer: Buffer | null = null;
      const nextAck = session.myAck + payload.length;

      if (!session.flowProtocol) {
        session.pendingData = Buffer.concat([session.pendingData, payload]);
        const classification = this.classifyTcpFlow(session.pendingData);

        if (classification.status === "need-more") {
          if (session.pendingData.length >= this.MAX_FLOW_SNIFF) {
            this.rejectTcpFlow(session, key, nextAck, "sniff-limit-exceeded");
            return;
          }
        } else if (classification.status === "deny") {
          this.rejectTcpFlow(session, key, nextAck, classification.reason);
          return;
        } else if (classification.status === "http") {
          if (classification.isConnect) {
            this.rejectTcpFlow(session, key, nextAck, "connect-not-allowed");
            return;
          }
          session.flowProtocol = "http";
          session.httpMethod = classification.method;
        } else if (classification.status === "tls") {
          session.flowProtocol = "tls";
        }

        if (session.flowProtocol) {
          const allowed = this.allowTcpFlow({
            key,
            srcIP: session.srcIP.join("."),
            srcPort: session.srcPort,
            dstIP: session.dstIP.join("."),
            dstPort: session.dstPort,
            protocol: session.flowProtocol,
            httpMethod: session.httpMethod,
          });
          if (!allowed) {
            this.rejectTcpFlow(session, key, nextAck, "policy-deny");
            return;
          }
          sendBuffer = session.pendingData;
          session.pendingData = Buffer.alloc(0);
        }
      } else {
        sendBuffer = payload;
      }

      session.vmSeq += payload.length;
      session.myAck = nextAck;

      if (sendBuffer && sendBuffer.length > 0) {
        this.callbacks.onTcpSend({ key, data: Buffer.from(sendBuffer) });
      }

      this.sendTCP(session.srcIP, session.srcPort, session.dstIP, session.dstPort, session.mySeq, session.myAck, 0x10);
    }

    if (FIN) {
      this.callbacks.onTcpClose({ key, destroy: false });
      session.myAck++;
      this.sendTCP(session.srcIP, session.srcPort, session.dstIP, session.dstPort, session.mySeq, session.myAck, 0x10);
      if (session.state === "CLOSED_BY_REMOTE" || session.state === "FIN_WAIT") {
        this.natTable.delete(key);
      } else {
        session.state = "FIN_SENT";
      }
    }
  }

  sendTCP(
    dstIP: Buffer,
    dstPort: number,
    srcIP: Buffer,
    srcPort: number,
    seq: number,
    ack: number,
    flags: number,
    payload: Buffer = Buffer.alloc(0)
  ) {
    const header = Buffer.alloc(20);
    header.writeUInt16BE(srcPort, 0);
    header.writeUInt16BE(dstPort, 2);
    header.writeUInt32BE(seq, 4);
    header.writeUInt32BE(ack, 8);
    header[12] = 0x50;
    header[13] = flags;
    header.writeUInt16BE(65535, 14);
    header.writeUInt16BE(0, 16);
    header.writeUInt16BE(0, 18);

    const pseudo = Buffer.alloc(12);
    srcIP.copy(pseudo, 0);
    dstIP.copy(pseudo, 4);
    pseudo[8] = 0;
    pseudo[9] = IP_PROTO_TCP;
    pseudo.writeUInt16BE(20 + payload.length, 10);

    const ckData = Buffer.concat([pseudo, header, payload]);
    const ck = this.calculateChecksum(ckData);
    header.writeUInt16BE(ck, 16);

    this.sendIP(Buffer.concat([header, payload]), IP_PROTO_TCP, srcIP, dstIP);
  }

  handleUDP(segment: Buffer, srcIP: Buffer, dstIP: Buffer) {
    const srcPort = segment.readUInt16BE(0);
    const dstPort = segment.readUInt16BE(2);
    const payload = segment.subarray(8);

    if (srcPort === DHCP_CLIENT_PORT && dstPort === DHCP_SERVER_PORT) {
      this.handleDHCP(payload);
      return;
    }

    const key = `UDP:${srcIP.join(".")}:${srcPort}:${dstIP.join(".")}:${dstPort}`;
    this.callbacks.onUdpSend({
      key,
      dstIP: dstIP.join("."),
      dstPort,
      srcIP: srcIP.join("."),
      srcPort,
      payload: Buffer.from(payload),
    });
  }

  handleDHCP(data: Buffer) {
    if (data.length < 240) return;

    const op = data[0];
    if (op !== 1) return;

    const xid = data.readUInt32BE(4);
    const flags = data.readUInt16BE(10);
    const chaddr = data.subarray(28, 28 + 16);

    const magic = data.readUInt32BE(236);
    if (magic !== DHCP_MAGIC_COOKIE) return;

    let msgType = 0;
    let i = 240;
    while (i < data.length) {
      const opt = data[i];
      if (opt === DHCP_OPT_END) break;
      if (opt === 0) {
        i += 1;
        continue;
      }

      const len = data[i + 1];
      const optData = data.subarray(i + 2, i + 2 + len);

      if (opt === DHCP_OPT_MSG_TYPE && len >= 1) {
        msgType = optData[0];
      } else if (opt === DHCP_OPT_REQUESTED_IP) {
        // ignored
      }

      i += 2 + len;
    }

    if (msgType === DHCP_DISCOVER) {
      this.sendDHCPReply(DHCP_OFFER, xid, chaddr, flags);
    } else if (msgType === DHCP_REQUEST) {
      this.sendDHCPReply(DHCP_ACK, xid, chaddr, flags);
    }
  }

  sendDHCPReply(msgType: number, xid: number, chaddr: Buffer, flags: number) {
    const reply = Buffer.alloc(300);

    reply[0] = 2;
    reply[1] = 1;
    reply[2] = 6;
    reply[3] = 0;
    reply.writeUInt32BE(xid, 4);
    reply.writeUInt16BE(0, 8);
    reply.writeUInt16BE(flags, 10);

    const vmIPParts = this.vmIP.split(".").map(Number);
    reply[16] = vmIPParts[0];
    reply[17] = vmIPParts[1];
    reply[18] = vmIPParts[2];
    reply[19] = vmIPParts[3];

    const gwIPParts = this.gatewayIP.split(".").map(Number);
    reply[20] = gwIPParts[0];
    reply[21] = gwIPParts[1];
    reply[22] = gwIPParts[2];
    reply[23] = gwIPParts[3];

    chaddr.copy(reply, 28);

    reply.writeUInt32BE(DHCP_MAGIC_COOKIE, 236);

    let optOffset = 240;

    reply[optOffset++] = DHCP_OPT_MSG_TYPE;
    reply[optOffset++] = 1;
    reply[optOffset++] = msgType;

    reply[optOffset++] = DHCP_OPT_SERVER_ID;
    reply[optOffset++] = 4;
    reply[optOffset++] = gwIPParts[0];
    reply[optOffset++] = gwIPParts[1];
    reply[optOffset++] = gwIPParts[2];
    reply[optOffset++] = gwIPParts[3];

    reply[optOffset++] = DHCP_OPT_LEASE_TIME;
    reply[optOffset++] = 4;
    reply.writeUInt32BE(86400, optOffset);
    optOffset += 4;

    reply[optOffset++] = DHCP_OPT_SUBNET_MASK;
    reply[optOffset++] = 4;
    reply[optOffset++] = 255;
    reply[optOffset++] = 255;
    reply[optOffset++] = 255;
    reply[optOffset++] = 0;

    reply[optOffset++] = DHCP_OPT_ROUTER;
    reply[optOffset++] = 4;
    reply[optOffset++] = gwIPParts[0];
    reply[optOffset++] = gwIPParts[1];
    reply[optOffset++] = gwIPParts[2];
    reply[optOffset++] = gwIPParts[3];

    const dnsServers = this.dnsServers.length > 0 ? this.dnsServers : ["8.8.8.8"];
    const dnsEntries = dnsServers
      .map((server) => server.split(".").map(Number))
      .filter(
        (parts) =>
          parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
      );

    if (dnsEntries.length === 0) {
      dnsEntries.push([8, 8, 8, 8]);
    }

    reply[optOffset++] = DHCP_OPT_DNS;
    reply[optOffset++] = dnsEntries.length * 4;
    for (const parts of dnsEntries) {
      reply[optOffset++] = parts[0];
      reply[optOffset++] = parts[1];
      reply[optOffset++] = parts[2];
      reply[optOffset++] = parts[3];
    }

    reply[optOffset++] = 28; // DHCP_OPT_BROADCAST
    reply[optOffset++] = 4;
    reply[optOffset++] = vmIPParts[0];
    reply[optOffset++] = vmIPParts[1];
    reply[optOffset++] = vmIPParts[2];
    reply[optOffset++] = 255;

    reply[optOffset++] = DHCP_OPT_END;

    const dhcpLen = 300;

    const udpLen = 8 + dhcpLen;
    const udpHeader = Buffer.alloc(8);
    udpHeader.writeUInt16BE(DHCP_SERVER_PORT, 0);
    udpHeader.writeUInt16BE(DHCP_CLIENT_PORT, 2);
    udpHeader.writeUInt16BE(udpLen, 4);
    udpHeader.writeUInt16BE(0, 6);

    const udpPayload = Buffer.concat([udpHeader, reply]);

    const srcIP = Buffer.from(gwIPParts);
    const dstIP = Buffer.from([255, 255, 255, 255]);

    const ipHeader = Buffer.alloc(20);
    ipHeader[0] = 0x45;
    ipHeader[1] = 0;
    ipHeader.writeUInt16BE(20 + udpPayload.length, 2);
    ipHeader.writeUInt16BE(0, 4);
    ipHeader.writeUInt16BE(0, 6);
    ipHeader[8] = 64;
    ipHeader[9] = IP_PROTO_UDP;
    srcIP.copy(ipHeader, 12);
    dstIP.copy(ipHeader, 16);
    ipHeader.writeUInt16BE(this.calculateChecksum(ipHeader), 10);

    const ipPacket = Buffer.concat([ipHeader, udpPayload]);

    const dstMac = flags & 0x8000 ? Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : chaddr.subarray(0, 6);

    const frame = Buffer.alloc(14 + ipPacket.length);
    dstMac.copy(frame, 0);
    this.gatewayMac.copy(frame, 6);
    frame.writeUInt16BE(ETH_P_IP, 12);
    ipPacket.copy(frame, 14);

    const packet = Buffer.alloc(4 + frame.length);
    packet.writeUInt32BE(frame.length, 0);
    frame.copy(packet, 4);

    // DHCP is required for connectivity; treat it as high priority even though it's UDP.
    this.enqueueTx(packet, "high");
    this.emit("dhcp", msgType === DHCP_OFFER ? "OFFER" : "ACK", this.vmIP);
  }

  handleUdpResponse(message: {
    data: Buffer;
    srcIP: string;
    srcPort: number;
    dstIP: string;
    dstPort: number;
  }) {
    const { data, srcIP, srcPort, dstIP, dstPort } = message;
    const udpHeader = Buffer.alloc(8);
    udpHeader.writeUInt16BE(dstPort, 0);
    udpHeader.writeUInt16BE(srcPort, 2);
    udpHeader.writeUInt16BE(8 + data.length, 4);
    udpHeader.writeUInt16BE(0, 6);

    const dstIPBuf = Buffer.from(dstIP.split(".").map(Number));
    const srcIPBuf = Buffer.from(srcIP.split(".").map(Number));

    const payload = Buffer.concat([udpHeader, Buffer.from(data)]);
    const checksum = this.calculateUdpChecksum(payload, dstIPBuf, srcIPBuf);
    udpHeader.writeUInt16BE(checksum, 6);

    const withChecksum = Buffer.concat([udpHeader, Buffer.from(data)]);

    this.sendIP(withChecksum, IP_PROTO_UDP, dstIPBuf, srcIPBuf);
  }

  handleTcpConnected(message: { key: string }) {
    const session = this.natTable.get(message.key);
    if (!session) return;

    session.state = "ESTABLISHED";
    this.sendTCP(
      session.srcIP,
      session.srcPort,
      session.dstIP,
      session.dstPort,
      session.mySeq,
      session.myAck,
      0x12
    );
    session.mySeq++;
  }

  handleTcpData(message: { key: string; data: Buffer }) {
    const session = this.natTable.get(message.key);
    if (!session) return;

    const payload = Buffer.from(message.data);
    const MSS = 1460;

    let offset = 0;
    while (offset < payload.length) {
      const chunkSize = Math.min(MSS, payload.length - offset);
      const chunk = payload.subarray(offset, offset + chunkSize);
      const isLast = offset + chunkSize >= payload.length;

      const flags = isLast ? 0x18 : 0x10;
      this.sendTCP(
        session.srcIP,
        session.srcPort,
        session.dstIP,
        session.dstPort,
        session.mySeq,
        session.myAck,
        flags,
        chunk
      );
      session.mySeq += chunk.length;
      offset += chunkSize;
    }

    if (this.txQueueHighSize > this.TX_BUFFER_HIGH_WATER && !this.txPaused.has(message.key)) {
      this.txPaused.add(message.key);
      this.callbacks.onTcpPause({ key: message.key });
    }
  }

  handleTcpEnd(message: { key: string }) {
    const session = this.natTable.get(message.key);
    if (!session) return;

    this.sendTCP(
      session.srcIP,
      session.srcPort,
      session.dstIP,
      session.dstPort,
      session.mySeq,
      session.myAck,
      0x11
    );
    session.mySeq++;
    session.state = "FIN_WAIT";
  }

  handleTcpError(message: { key: string }) {
    const session = this.natTable.get(message.key);
    if (!session) return;

    this.sendTCP(
      session.srcIP,
      session.srcPort,
      session.dstIP,
      session.dstPort,
      session.mySeq,
      session.myAck,
      0x04
    );
    this.natTable.delete(message.key);
  }

  handleTcpClosed(message: { key: string }) {
    const session = this.natTable.get(message.key);
    if (session) {
      session.state = "CLOSED_BY_REMOTE";
    }
  }
}
