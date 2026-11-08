/**
 * Fast CBOR codec for the controller protocol's subset (maps with text keys,
 * safe integers, text, byte strings, arrays, booleans, null, floats).
 *
 * Exec output, stdin and window updates are thousands of small messages per
 * second; cbor2 spends most of the transport's CPU time on them. Anything
 * outside the subset (tags, bigints, indefinite lengths, other object types) returns `undefined`, and the caller falls back to cbor2.
 */

/** Marks a value outside the fast subset */
const UNSUPPORTED = Symbol("unsupported");

/**
 * Encodes `value` with `reserve` zero bytes in front (for the frame header),
 * skipping `undefined` object fields; `undefined` if outside the subset.
 */
export function fastEncode(value: unknown, reserve = 0): Buffer | undefined {
  const w = new Writer(reserve);
  if (!w.value(value)) return undefined;
  return w.finish();
}

/** Decodes one CBOR item (trailing bytes are ignored); `undefined` if outside the subset */
export function fastDecode(buf: Buffer): unknown {
  const r = new Reader(buf);
  const value = r.value(0);
  return value === UNSUPPORTED ? undefined : value;
}

class Writer {
  private buf: Buffer;
  private pos: number;

  constructor(reserve: number) {
    this.buf = Buffer.allocUnsafe(Math.max(256, reserve + 64));
    this.buf.fill(0, 0, reserve);
    this.pos = reserve;
  }

  finish(): Buffer {
    return this.buf.subarray(0, this.pos);
  }

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    const next = Buffer.allocUnsafe(
      Math.max(this.buf.length * 2, this.pos + n),
    );
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }

  private head(major: number, n: number) {
    this.ensure(9);
    const m = major << 5;
    if (n < 24) {
      this.buf[this.pos++] = m | n;
    } else if (n < 0x100) {
      this.buf[this.pos++] = m | 24;
      this.buf[this.pos++] = n;
    } else if (n < 0x10000) {
      this.buf[this.pos++] = m | 25;
      this.buf.writeUInt16BE(n, this.pos);
      this.pos += 2;
    } else if (n < 0x100000000) {
      this.buf[this.pos++] = m | 26;
      this.buf.writeUInt32BE(n, this.pos);
      this.pos += 4;
    } else {
      this.buf[this.pos++] = m | 27;
      this.buf.writeUInt32BE(Math.floor(n / 0x100000000), this.pos);
      this.buf.writeUInt32BE(n >>> 0, this.pos + 4);
      this.pos += 8;
    }
  }

  private text(s: string) {
    // ASCII fast path (keys, type names)
    if (s.length < 64) {
      let ascii = true;
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) > 0x7f) {
          ascii = false;
          break;
        }
      }
      if (ascii) {
        this.head(3, s.length);
        this.ensure(s.length);
        this.buf.write(s, this.pos, s.length, "latin1");
        this.pos += s.length;
        return;
      }
    }
    const len = Buffer.byteLength(s, "utf8");
    this.head(3, len);
    this.ensure(len);
    this.buf.write(s, this.pos, len, "utf8");
    this.pos += len;
  }

  value(v: unknown): boolean {
    switch (typeof v) {
      case "number":
        if (Number.isSafeInteger(v)) {
          if (v >= 0) this.head(0, v);
          else this.head(1, -1 - v);
        } else {
          this.ensure(9);
          this.buf[this.pos++] = 0xfb;
          this.buf.writeDoubleBE(v, this.pos);
          this.pos += 8;
        }
        return true;
      case "string":
        this.text(v);
        return true;
      case "boolean":
        this.ensure(1);
        this.buf[this.pos++] = v ? 0xf5 : 0xf4;
        return true;
      case "object": {
        if (v === null) {
          this.ensure(1);
          this.buf[this.pos++] = 0xf6;
          return true;
        }
        if (v instanceof Uint8Array) {
          this.head(2, v.byteLength);
          this.ensure(v.byteLength);
          this.buf.set(v, this.pos);
          this.pos += v.byteLength;
          return true;
        }
        if (Array.isArray(v)) {
          this.head(4, v.length);
          for (const entry of v) {
            if (!this.value(entry === undefined ? null : entry)) return false;
          }
          return true;
        }
        if (Object.getPrototypeOf(v) !== Object.prototype) return false;
        const obj = v as Record<string, unknown>;
        let count = 0;
        for (const key in obj) {
          if (Object.hasOwn(obj, key) && obj[key] !== undefined) count++;
        }
        this.head(5, count);
        for (const key in obj) {
          if (!Object.hasOwn(obj, key)) continue;
          const entry = obj[key];
          if (entry === undefined) continue;
          this.text(key);
          if (!this.value(entry)) return false;
        }
        return true;
      }
      default:
        return false;
    }
  }
}

/** IEEE 754 half precision to number */
function halfToNumber(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** Nesting limit of decoded values (untrusted peers) */
const MAX_DEPTH = 64;

class Reader {
  private pos = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** Argument of a head with additional info `info`, or -1 if unsupported */
  private arg(info: number): number {
    const b = this.buf;
    if (info < 24) return info;
    if (info === 24) {
      if (this.pos + 1 > b.length) return -1;
      return b[this.pos++]!;
    }
    if (info === 25) {
      if (this.pos + 2 > b.length) return -1;
      const n = b.readUInt16BE(this.pos);
      this.pos += 2;
      return n;
    }
    if (info === 26) {
      if (this.pos + 4 > b.length) return -1;
      const n = b.readUInt32BE(this.pos);
      this.pos += 4;
      return n;
    }
    if (info === 27) {
      if (this.pos + 8 > b.length) return -1;
      const hi = b.readUInt32BE(this.pos);
      const lo = b.readUInt32BE(this.pos + 4);
      // above 2^53 cbor2 returns a bigint
      if (hi >= 0x200000) return -1;
      this.pos += 8;
      return hi * 0x100000000 + lo;
    }
    return -1;
  }

  value(depth: number): unknown {
    const b = this.buf;
    if (depth > MAX_DEPTH || this.pos >= b.length) return UNSUPPORTED;
    const initial = b[this.pos++]!;
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (major === 7) {
      switch (info) {
        case 20:
          return false;
        case 21:
          return true;
        case 22:
          return null;
        case 23:
          return undefined;
        case 25: {
          if (this.pos + 2 > b.length) return UNSUPPORTED;
          const h = b.readUInt16BE(this.pos);
          this.pos += 2;
          return halfToNumber(h);
        }
        case 26: {
          if (this.pos + 4 > b.length) return UNSUPPORTED;
          const f = b.readFloatBE(this.pos);
          this.pos += 4;
          return f;
        }
        case 27: {
          if (this.pos + 8 > b.length) return UNSUPPORTED;
          const f = b.readDoubleBE(this.pos);
          this.pos += 8;
          return f;
        }
        default:
          return UNSUPPORTED;
      }
    }
    const n = this.arg(info);
    if (n < 0) return UNSUPPORTED;
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2: {
        if (this.pos + n > b.length) return UNSUPPORTED;
        const start = this.pos;
        this.pos += n;
        // a view when the bytes are most of the underlying memory (large
        // output frames); otherwise a copy, so a small slice does not keep a
        // whole read chunk alive
        if (n >= 4096 && n * 2 >= b.buffer.byteLength) {
          return b.subarray(start, start + n);
        }
        const out = Buffer.allocUnsafe(n);
        b.copy(out, 0, start, start + n);
        return out;
      }
      case 3: {
        if (this.pos + n > b.length) return UNSUPPORTED;
        const end = this.pos + n;
        if (n <= 16) {
          // short ASCII (keys, type names) without a native call
          let s = "";
          let i = this.pos;
          for (; i < end; i++) {
            const c = b[i]!;
            if (c > 0x7f) break;
            s += String.fromCharCode(c);
          }
          if (i === end) {
            this.pos = end;
            return s;
          }
        }
        const s = b.toString("utf8", this.pos, end);
        this.pos = end;
        return s;
      }
      case 4: {
        if (n > b.length - this.pos) return UNSUPPORTED;
        const out: unknown[] = new Array(n);
        for (let i = 0; i < n; i++) {
          const entry = this.value(depth + 1);
          if (entry === UNSUPPORTED) return UNSUPPORTED;
          out[i] = entry;
        }
        return out;
      }
      case 5: {
        if (n > b.length - this.pos) return UNSUPPORTED;
        const out: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const key = this.value(depth + 1);
          // non-text keys keep cbor2's semantics (normalize stringifies)
          if (typeof key !== "string") return UNSUPPORTED;
          const entry = this.value(depth + 1);
          if (entry === UNSUPPORTED) return UNSUPPORTED;
          if (key === "__proto__") {
            // an own property, never the object's prototype (untrusted peers)
            Object.defineProperty(out, key, {
              value: entry,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          } else {
            out[key] = entry;
          }
        }
        return out;
      }
      default:
        return UNSUPPORTED;
    }
  }
}

/** Generic CBOR values as plain JSON-like objects: maps become objects (own `__proto__` keys stay data), byte strings `Buffer`s */
export function normalize(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      const name = String(key);
      if (name === "__proto__") {
        // an own property, never the object's prototype (untrusted peers)
        Object.defineProperty(obj, name, {
          value: normalize(entry),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        obj[name] = normalize(entry);
      }
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry));
  }
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  return value;
}
