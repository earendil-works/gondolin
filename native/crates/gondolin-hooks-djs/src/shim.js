// The tier-2 hook environment: a restricted subset of the WHATWG fetch types
// (Headers, URL, URLSearchParams, Request, Response) plus
// HttpRequestBlockedError and console, over the host functions the daemon
// defines first:
//   __url_parse(input, base)   sync: URL components, or throws TypeError
//   __body_read(stream, kind)  async: a host body ("text" | "bytes")
//   __log(level, text)         sync: console output (daemon log)
// Heads cross as plain data ({ method, url, headers: [[name, value], ...] });
// bodies stay on the host until a script reads them. Each entry point
// (__gondolin_*) settles with a decision, plain data the daemon reads.
// Restrictions (docs/native.md, "Tier-2 hooks"): no streams, no fetch, no
// timers; bodies are whole values.
(() => {
  "use strict";
  const urlParse = globalThis.__url_parse;
  const bodyRead = globalThis.__body_read;
  const log = globalThis.__log;
  for (const k of ["__url_parse", "__body_read", "__log"]) delete globalThis[k];

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const normName = (name) => {
    const n = String(name);
    if (!TOKEN.test(n)) throw new TypeError(`Invalid header name: ${n}`);
    return n.toLowerCase();
  };
  const normValue = (value) => {
    const v = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
    if (/[\0\r\n]/.test(v)) throw new TypeError(`Invalid header value: ${JSON.stringify(v)}`);
    return v;
  };

  const TRUSTED = Symbol("trusted");

  class Headers {
    #list = [];
    /** mutation count (an unchanged host head answers `continue` without re-serializing) */
    #version = 0;
    constructor(init, trusted) {
      if (init == null) return;
      if (trusted === TRUSTED) {
        // From the host: already lowercase, validated and coalesced.
        this.#list = init;
        return;
      }
      if (init instanceof Headers) {
        this.#list = init.__wire();
      } else if (typeof init[Symbol.iterator] === "function") {
        for (const pair of init) {
          const p = Array.from(pair);
          if (p.length !== 2) throw new TypeError("Header pairs must have two elements");
          this.append(p[0], p[1]);
        }
      } else if (typeof init === "object") {
        for (const k of Object.keys(init)) this.append(k, init[k]);
      } else {
        throw new TypeError("Invalid headers init");
      }
    }
    append(name, value) {
      const n = normName(name);
      const v = normValue(value);
      this.#version++;
      if (n !== "set-cookie") {
        for (const e of this.#list) {
          if (e[0] === n) {
            e[1] = e[1] === "" ? v : `${e[1]}, ${v}`;
            return;
          }
        }
      }
      this.#list.push([n, v]);
    }
    set(name, value) {
      const n = normName(name);
      const v = normValue(value);
      this.#version++;
      this.#list = this.#list.filter((e) => e[0] !== n);
      this.#list.push([n, v]);
    }
    get(name) {
      const n = normName(name);
      let out = null;
      for (const e of this.#list) {
        if (e[0] === n) out = out === null ? e[1] : `${out}, ${e[1]}`;
      }
      return out;
    }
    getSetCookie() {
      return this.#list.filter((e) => e[0] === "set-cookie").map((e) => e[1]);
    }
    has(name) {
      const n = normName(name);
      return this.#list.some((e) => e[0] === n);
    }
    delete(name) {
      const n = normName(name);
      if (!this.#list.some((e) => e[0] === n)) return;
      this.#version++;
      this.#list = this.#list.filter((e) => e[0] !== n);
    }
    forEach(fn, thisArg) {
      for (const [k, v] of this) fn.call(thisArg, v, k, this);
    }
    *entries() {
      // sorted, with set-cookie kept apart and other names combined (WHATWG)
      const names = [];
      for (const e of this.#list) if (!names.includes(e[0])) names.push(e[0]);
      names.sort();
      for (const n of names) {
        if (n === "set-cookie") {
          for (const v of this.getSetCookie()) yield [n, v];
        } else {
          yield [n, this.get(n)];
        }
      }
    }
    *keys() {
      for (const [k] of this.entries()) yield k;
    }
    *values() {
      for (const [, v] of this.entries()) yield v;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    get __version() {
      return this.#version;
    }
    /** wire form: [[name, value], ...] in insertion order */
    __wire() {
      return this.#list.map((e) => [e[0], e[1]]);
    }
  }

  const formDecode = (s) => decodeURIComponent(s.replace(/\+/g, " "));
  const formEncode = (s) =>
    encodeURIComponent(s)
      .replace(/%20/g, "+")
      .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  class URLSearchParams {
    #pairs = [];
    #onChange = null;
    constructor(init, onChange) {
      if (typeof init === "string") {
        const q = init.startsWith("?") ? init.slice(1) : init;
        for (const part of q.split("&")) {
          if (!part) continue;
          const i = part.indexOf("=");
          this.#pairs.push(
            i < 0 ? [formDecode(part), ""] : [formDecode(part.slice(0, i)), formDecode(part.slice(i + 1))],
          );
        }
      } else if (init instanceof URLSearchParams) {
        this.#pairs = [...init].map((e) => [e[0], e[1]]);
      } else if (init != null && typeof init[Symbol.iterator] === "function") {
        for (const p of init) this.#pairs.push([String(p[0]), String(p[1])]);
      } else if (init != null) {
        for (const k of Object.keys(init)) this.#pairs.push([k, String(init[k])]);
      }
      if (typeof onChange === "function") this.#onChange = onChange;
    }
    #changed() {
      if (this.#onChange) this.#onChange(this.toString());
    }
    get size() {
      return this.#pairs.length;
    }
    append(n, v) {
      this.#pairs.push([String(n), String(v)]);
      this.#changed();
    }
    set(n, v) {
      n = String(n);
      const i = this.#pairs.findIndex((e) => e[0] === n);
      if (i < 0) {
        this.#pairs.push([n, String(v)]);
      } else {
        this.#pairs[i][1] = String(v);
        this.#pairs = this.#pairs.filter((e, j) => j <= i || e[0] !== n);
      }
      this.#changed();
    }
    delete(n) {
      n = String(n);
      this.#pairs = this.#pairs.filter((e) => e[0] !== n);
      this.#changed();
    }
    get(n) {
      const p = this.#pairs.find((e) => e[0] === String(n));
      return p ? p[1] : null;
    }
    getAll(n) {
      return this.#pairs.filter((e) => e[0] === String(n)).map((e) => e[1]);
    }
    has(n) {
      return this.#pairs.some((e) => e[0] === String(n));
    }
    sort() {
      this.#pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      this.#changed();
    }
    forEach(fn, thisArg) {
      for (const [k, v] of this.#pairs) fn.call(thisArg, v, k, this);
    }
    *entries() {
      yield* this.#pairs.map((e) => [e[0], e[1]]);
    }
    *keys() {
      for (const [k] of this.#pairs) yield k;
    }
    *values() {
      for (const [, v] of this.#pairs) yield v;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return this.#pairs.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join("&");
    }
  }

  // WHATWG URL backed by the daemon's parser (the one egress uses). Setters
  // rebuild the href and parse it again.
  class URL {
    #c;
    constructor(input, base) {
      this.#c = urlParse(String(input), base === undefined ? undefined : String(base));
    }
    static canParse(input, base) {
      try {
        new URL(input, base);
        return true;
      } catch {
        return false;
      }
    }
    static parse(input, base) {
      try {
        return new URL(input, base);
      } catch {
        return null;
      }
    }
    #rebuild(parts) {
      const c = { ...this.#c, ...parts };
      const auth = c.username || c.password ? `${c.username}${c.password ? `:${c.password}` : ""}@` : "";
      const host = c.port ? `${c.hostname}:${c.port}` : c.hostname;
      this.#c = urlParse(`${c.protocol}//${auth}${host}${c.pathname}${c.search}${c.hash}`, undefined);
    }
    get href() { return this.#c.href; }
    set href(v) { this.#c = urlParse(String(v), undefined); }
    get origin() { return this.#c.origin; }
    get protocol() { return this.#c.protocol; }
    set protocol(v) { v = String(v); this.#rebuild({ protocol: v.endsWith(":") ? v : `${v}:` }); }
    get username() { return this.#c.username; }
    set username(v) { this.#rebuild({ username: encodeURIComponent(String(v)) }); }
    get password() { return this.#c.password; }
    set password(v) { this.#rebuild({ password: encodeURIComponent(String(v)) }); }
    get host() { return this.#c.host; }
    set host(v) {
      const s = String(v);
      const i = s.lastIndexOf(":");
      if (i > 0 && !s.endsWith("]")) this.#rebuild({ hostname: s.slice(0, i), port: s.slice(i + 1) });
      else this.#rebuild({ hostname: s, port: "" });
    }
    get hostname() { return this.#c.hostname; }
    set hostname(v) { this.#rebuild({ hostname: String(v) }); }
    get port() { return this.#c.port; }
    set port(v) { this.#rebuild({ port: String(v) }); }
    get pathname() { return this.#c.pathname; }
    set pathname(v) { v = String(v); this.#rebuild({ pathname: v.startsWith("/") ? v : `/${v}` }); }
    get search() { return this.#c.search; }
    set search(v) { v = String(v); this.#rebuild({ search: v === "" || v === "?" ? "" : v.startsWith("?") ? v : `?${v}` }); }
    get hash() { return this.#c.hash; }
    set hash(v) { v = String(v); this.#rebuild({ hash: v === "" || v === "#" ? "" : v.startsWith("#") ? v : `#${v}` }); }
    get searchParams() {
      return new URLSearchParams(this.#c.search, (q) => {
        this.search = q;
      });
    }
    toString() { return this.#c.href; }
    toJSON() { return this.#c.href; }
  }

  // The body of a Request/Response: on the host (a stream id), replaced by the
  // script (string or bytes), or null. `used` is shared by the object owning it.
  const BODY = Symbol("body");

  // What `request.body` / `response.body` return for a host body: an opaque
  // handle (not readable) that keeps the original body when passed to
  // `new Request(..., { body })` / `new Response(body, ...)`.
  class HostBody {
    #holder;
    constructor(holder) {
      this.#holder = holder;
    }
    static __holder(b) {
      return b.#holder;
    }
    get locked() {
      return this.#holder.used;
    }
  }

  const bytesOf = (v) => {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return null;
  };

  /** [holder, implied content-type] for a body init */
  const bodyFrom = (init) => {
    if (init == null) return [null, null];
    if (init instanceof HostBody) {
      const h = HostBody.__holder(init);
      if (h.used) throw new TypeError("Body is unusable: Body has already been read");
      return [h, null];
    }
    const bytes = bytesOf(init);
    if (bytes) return [{ data: bytes.slice(), used: false }, null];
    if (init instanceof URLSearchParams) {
      return [{ data: init.toString(), used: false }, "application/x-www-form-urlencoded;charset=UTF-8"];
    }
    return [{ data: String(init), used: false }, "text/plain;charset=UTF-8"];
  };

  const readBody = async (owner, kind) => {
    const b = owner[BODY];
    if (b === null) return kind === "text" ? "" : new Uint8Array(0);
    if (b.used) throw new TypeError("Body is unusable: Body has already been read");
    b.used = true;
    if (b.stream !== undefined) return bodyRead(b.stream, kind);
    if (kind === "text") return typeof b.data === "string" ? b.data : decoder.decode(b.data);
    return typeof b.data === "string" ? encoder.encode(b.data) : b.data.slice();
  };

  class Body {
    get body() {
      const b = this[BODY];
      if (b === null) return null;
      if (b.stream !== undefined) return new HostBody(b);
      // a replaced body: hand out a host-body-like handle to it as well
      return new HostBody(b);
    }
    get bodyUsed() {
      return this[BODY] !== null && this[BODY].used;
    }
    text() {
      return readBody(this, "text");
    }
    async json() {
      return JSON.parse(await readBody(this, "text"));
    }
    bytes() {
      return readBody(this, "bytes");
    }
    async arrayBuffer() {
      const b = await readBody(this, "bytes");
      return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer;
    }
    async formData() {
      throw new TypeError("formData() is not supported in tier-2 hooks");
    }
    async blob() {
      throw new TypeError("blob() is not supported in tier-2 hooks");
    }
  }

  const INTERNAL = Symbol("internal");
  const cloneHolder = (b) => (b === null ? null : b.stream !== undefined ? { stream: b.stream, used: false } : { data: b.data, used: false });

  class Request extends Body {
    #method;
    #url;
    #headers;
    constructor(input, init = {}) {
      super();
      if (input === INTERNAL) {
        // A request from the host: its head is trusted as is.
        this.#method = init.method;
        this.#url = init.url;
        this.#headers = new Headers(init.headers, TRUSTED);
        this[BODY] = init.body;
        return;
      }
      init = init ?? {};
      let body = null;
      if (input instanceof Request) {
        if (input.bodyUsed) {
          throw new TypeError("Cannot construct a Request with a Request object that has already been used.");
        }
        this.#method = input.method;
        this.#url = input.url;
        this.#headers = new Headers(input.headers);
        // a new Request takes over the input's body (WHATWG marks the input used)
        body = input[BODY];
      } else {
        this.#method = "GET";
        this.#url = new URL(input instanceof URL ? input.href : input).href;
        this.#headers = new Headers();
      }
      if (init.method !== undefined) {
        const m = String(init.method);
        if (!TOKEN.test(m)) throw new TypeError(`'${m}' is not a valid HTTP method.`);
        const upper = m.toUpperCase();
        this.#method = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].includes(upper) ? upper : m;
      }
      if (init.headers !== undefined) this.#headers = new Headers(init.headers);
      if (init.body !== undefined) {
        const [holder, type] = bodyFrom(init.body);
        body = holder;
        if (type && !this.#headers.has("content-type")) this.#headers.set("content-type", type);
      }
      if (body !== null && (this.#method === "GET" || this.#method === "HEAD")) {
        throw new TypeError("Request with GET/HEAD method cannot have body.");
      }
      this[BODY] = body;
    }
    get method() { return this.#method; }
    get url() { return this.#url; }
    get headers() { return this.#headers; }
    clone() {
      if (this.bodyUsed) throw new TypeError("Request.clone: Body has already been consumed.");
      const r = new Request(INTERNAL, { method: this.#method, url: this.#url, headers: this.#headers.__wire(), body: cloneHolder(this[BODY]) });
      return r;
    }
  }

  const NULL_BODY = [101, 103, 204, 205, 304];

  class Response extends Body {
    #status;
    #statusText;
    #headers;
    constructor(body = null, init = {}) {
      super();
      if (body === INTERNAL) {
        this.#status = init.status;
        this.#statusText = init.statusText;
        this.#headers = new Headers(init.headers, TRUSTED);
        this[BODY] = init.body;
        return;
      }
      init = init ?? {};
      const status = init.status === undefined ? 200 : Number(init.status);
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        throw new RangeError(`Failed to construct 'Response': The status provided (${init.status}) is outside the range [200, 599].`);
      }
      this.#status = status;
      this.#statusText = init.statusText === undefined ? "" : String(init.statusText);
      if (/[\r\n]/.test(this.#statusText)) throw new TypeError("Invalid statusText");
      this.#headers = new Headers(init.headers);
      const [holder, type] = bodyFrom(body);
      if (holder !== null && NULL_BODY.includes(status)) {
        throw new TypeError("Response with null body status cannot have body");
      }
      if (type && !this.#headers.has("content-type")) this.#headers.set("content-type", type);
      this[BODY] = holder;
    }
    get status() { return this.#status; }
    get statusText() { return this.#statusText; }
    get headers() { return this.#headers; }
    get ok() { return this.#status >= 200 && this.#status < 300; }
    get redirected() { return false; }
    get type() { return "default"; }
    clone() {
      if (this.bodyUsed) throw new TypeError("Response.clone: Body has already been consumed.");
      return new Response(INTERNAL, { status: this.#status, statusText: this.#statusText, headers: this.#headers.__wire(), body: cloneHolder(this[BODY]) });
    }
    static json(data, init = {}) {
      const text = JSON.stringify(data);
      if (text === undefined) throw new TypeError("Value is not JSON serializable");
      const headers = new Headers(init?.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      return new Response(text, { ...init, headers });
    }
    static redirect(url, status = 302) {
      if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError("Invalid status code");
      return new Response(null, { status, headers: { location: new URL(url).href } });
    }
  }

  // Rejects the request with an error response (the node SDK's class).
  class HttpRequestBlockedError extends Error {
    constructor(message = "request blocked", status = 403, statusText = "Forbidden") {
      super(message);
      this.name = "HttpRequestBlockedError";
      this.status = status;
      this.statusText = statusText;
    }
  }

  const fmt = (a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    try {
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch {
      return String(a);
    }
  };
  const logAt = (level) => (...a) => log(level, a.map(fmt).join(" "));
  globalThis.console = Object.freeze({
    log: logAt("info"),
    info: logAt("info"),
    debug: logAt("debug"),
    warn: logAt("warn"),
    error: logAt("error"),
  });
  for (const [k, v] of Object.entries({ Headers, URL, URLSearchParams, Request, Response, HttpRequestBlockedError })) {
    Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true, enumerable: false });
  }

  // ---- decisions (plain data for the daemon) ----

  const wireBody = (b, original) => {
    if (b === null) return { kind: "none" };
    if (b === original) return { kind: "original" };
    if (b.stream !== undefined) return { kind: "original" };
    if (typeof b.data === "string") return { kind: "text", text: b.data };
    return { kind: "bytes", bytes: b.data };
  };
  const blocked = (message, status, statusText) => ({ action: "block", status, statusText, message });

  let policy = null;
  const hook = (name) => {
    const f = policy === null ? undefined : policy[name];
    return typeof f === "function" ? f : null;
  };

  // Binds the policy's hooks (the global object of a script, a module's
  // namespace); run once at setup, after the policy.
  Object.defineProperty(globalThis, "__gondolin_bind", {
    value: (p) => {
      policy = {};
      for (const k of ["isRequestAllowed", "isIpAllowed", "onRequest", "onResponse"]) {
        if (typeof p[k] === "function") policy[k] = p[k];
      }
      Object.freeze(policy);
      delete globalThis.__gondolin_bind;
    },
    configurable: true,
  });

  const define = (name, f) =>
    Object.defineProperty(globalThis, name, {
      value: async (...args) => {
        try {
          return await f(...args);
        } catch (e) {
          if (e instanceof HttpRequestBlockedError) {
            const status = Number.isInteger(e.status) ? e.status : 403;
            return blocked(String(e.message), status, String(e.statusText ?? ""));
          }
          throw e;
        }
      },
    });

  // which phases the policy defines
  define("__gondolin_phases", () => ({
    isRequestAllowed: hook("isRequestAllowed") !== null,
    isIpAllowed: hook("isIpAllowed") !== null,
    onRequest: hook("onRequest") !== null,
    onResponse: hook("onResponse") !== null,
  }));

  const hostRequest = (head, stream) =>
    new Request(INTERNAL, {
      method: head.method,
      url: head.url,
      headers: head.headers,
      body: stream < 0 ? null : { stream, used: false },
    });

  define("__gondolin_is_request_allowed", async (head) => {
    const f = hook("isRequestAllowed");
    if (f === null) return { action: "allowed", allowed: true };
    return { action: "allowed", allowed: Boolean(await f(hostRequest(head, -1))) };
  });

  define("__gondolin_is_ip_allowed", async (info) => {
    const f = hook("isIpAllowed");
    if (f === null) return { action: "allowed", allowed: true };
    return { action: "allowed", allowed: Boolean(await f({ ...info })) };
  });

  define("__gondolin_on_request", async (head, stream) => {
    const f = hook("onRequest");
    if (f === null) return { action: "continue" };
    const req = hostRequest(head, stream);
    const original = req[BODY];
    const headers = req.headers;
    const out = (await f(req)) ?? req;
    if (out instanceof Response) {
      return {
        action: "respond",
        head: { status: out.status, statusText: out.statusText, headers: out.headers.__wire() },
        body: wireBody(out[BODY], undefined),
      };
    }
    if (!(out instanceof Request)) {
      throw new TypeError("onRequest must return Request, Response, or undefined");
    }
    const outHead = { method: out.method, url: out.url, headers: out.headers.__wire() };
    if (out === req) {
      if (original !== null && original.used) {
        return blocked("onRequest consumed the request body; use request.clone() or return a new Request", 400, "Bad Request");
      }
      // in-place header edits count as a replacement
      if (headers.__version === 0) return { action: "continue" };
      return { action: "request", head: outHead, body: original === null ? { kind: "none" } : { kind: "original" } };
    }
    if (out.bodyUsed) {
      return blocked("onRequest returned a consumed request body", 400, "Bad Request");
    }
    return { action: "request", head: outHead, body: wireBody(out[BODY], original) };
  });

  define("__gondolin_on_response", async (head, stream, reqHead) => {
    const f = hook("onResponse");
    if (f === null) return { action: "continue" };
    const res = new Response(INTERNAL, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
      body: stream < 0 ? null : { stream, used: false },
    });
    const original = res[BODY];
    const out = await f(res, hostRequest(reqHead, -1));
    if (out === undefined || out === null) return { action: "continue" };
    if (!(out instanceof Response)) throw new TypeError("onResponse must return Response or undefined");
    if (out.bodyUsed) {
      return blocked("onResponse returned a consumed response body", 502, "Bad Gateway");
    }
    return {
      action: "response",
      head: { status: out.status, statusText: out.statusText, headers: out.headers.__wire() },
      body: wireBody(out[BODY], original),
    };
  });
})();
