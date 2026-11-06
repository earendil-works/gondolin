// The hook environment: a restricted subset of the WHATWG fetch types for
// policy scripts, over the host functions the embedder defines first:
//   __url_parse(input, base)   sync: URL components, or throws TypeError
//   __body_read(stream, kind)  async: the request body ("text" | "bytes")
//   __log(...args)             sync: console output
//   __settle(ok, text)         sync: the call's decision (JSON) or failure
// Heads cross as plain data ({ method, url, headers: [[name, value], ...] });
// bodies stay on the host until a script reads them.
(() => {
  "use strict";
  const urlParse = globalThis.__url_parse;
  const bodyRead = globalThis.__body_read;
  const log = globalThis.__log;
  const settle = globalThis.__settle;
  for (const k of ["__url_parse", "__body_read", "__log", "__settle"]) delete globalThis[k];

  const norm = (name) => {
    const n = String(name).toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(n)) throw new TypeError(`Invalid header name: ${name}`);
    return n;
  };

  const TRUSTED = Symbol("trusted");

  class Headers {
    #list = [];
    /** mutation count (the host-head fast path skips re-serializing unchanged heads) */
    #version = 0;
    constructor(init, trusted) {
      if (init == null) return;
      if (trusted === TRUSTED) {
        // From the host: already lowercase, validated and coalesced.
        this.#list = init;
        return;
      }
      if (init instanceof Headers) {
        this.#list = init.toWire();
      } else if (Array.isArray(init)) {
        for (const pair of init) this.append(pair[0], pair[1]);
      } else {
        for (const k of Object.keys(init)) this.append(k, init[k]);
      }
    }
    append(name, value) {
      const n = norm(name);
      this.#version++;
      const v = String(value).trim();
      const i = this.#list.findIndex((e) => e[0] === n);
      if (i >= 0 && n !== "set-cookie") this.#list[i][1] += `, ${v}`;
      else this.#list.push([n, v]);
    }
    set(name, value) {
      const n = norm(name);
      this.#version++;
      this.#list = this.#list.filter((e) => e[0] !== n);
      this.#list.push([n, String(value).trim()]);
    }
    get(name) {
      const n = norm(name);
      const found = this.#list.filter((e) => e[0] === n);
      return found.length === 0 ? null : found.map((e) => e[1]).join(", ");
    }
    getSetCookie() {
      return this.#list.filter((e) => e[0] === "set-cookie").map((e) => e[1]);
    }
    has(name) {
      const n = norm(name);
      return this.#list.some((e) => e[0] === n);
    }
    delete(name) {
      const n = norm(name);
      this.#version++;
      this.#list = this.#list.filter((e) => e[0] !== n);
    }
    forEach(fn, thisArg) {
      for (const [k, v] of this) fn.call(thisArg, v, k, this);
    }
    *entries() {
      const sorted = this.#list.map((e) => [e[0], e[1]]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      yield* sorted;
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
    toWire() {
      return this.#list.map((e) => [e[0], e[1]]);
    }
  }

  class URLSearchParams {
    #pairs = [];
    constructor(init) {
      if (typeof init === "string") {
        const q = init.startsWith("?") ? init.slice(1) : init;
        for (const part of q.split("&")) {
          if (!part) continue;
          const i = part.indexOf("=");
          const dec = (s) => decodeURIComponent(s.replace(/\+/g, " "));
          this.#pairs.push(i < 0 ? [dec(part), ""] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]);
        }
      } else if (init) {
        for (const k of Object.keys(init)) this.#pairs.push([k, String(init[k])]);
      }
    }
    get(n) {
      const p = this.#pairs.find((e) => e[0] === n);
      return p ? p[1] : null;
    }
    getAll(n) {
      return this.#pairs.filter((e) => e[0] === n).map((e) => e[1]);
    }
    has(n) {
      return this.#pairs.some((e) => e[0] === n);
    }
    *entries() {
      yield* this.#pairs.map((e) => [e[0], e[1]]);
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      const enc = (s) => encodeURIComponent(s).replace(/%20/g, "+");
      return this.#pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
    }
  }

  // Read-only WHATWG URL backed by the host's parser (the `url` crate).
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
    get href() { return this.#c.href; }
    get origin() { return this.#c.origin; }
    get protocol() { return this.#c.protocol; }
    get username() { return this.#c.username; }
    get password() { return this.#c.password; }
    get host() { return this.#c.host; }
    get hostname() { return this.#c.hostname; }
    get port() { return this.#c.port; }
    get pathname() { return this.#c.pathname; }
    get search() { return this.#c.search; }
    get hash() { return this.#c.hash; }
    get searchParams() { return new URLSearchParams(this.#c.search); }
    toString() { return this.#c.href; }
    toJSON() { return this.#c.href; }
  }

  // A body: either still on the host (a stream id) or replaced by the script.
  const BODY = Symbol("body");
  const readBody = async (holder, kind) => {
    const b = holder[BODY];
    if (b === null) return kind === "text" ? "" : new Uint8Array(0);
    if (b.used) throw new TypeError("Body is unusable: Body has already been read");
    b.used = true;
    if (b.stream !== undefined) {
      // The host reads the stream once and keeps the bytes for clones.
      return bodyRead(b.stream, kind);
    }
    if (kind === "text") {
      return typeof b.data === "string" ? b.data : String.fromCharCode(...b.data);
    }
    if (typeof b.data === "string") {
      const out = new Uint8Array(b.data.length);
      for (let i = 0; i < b.data.length; i++) out[i] = b.data.charCodeAt(i) & 0xff;
      return out;
    }
    return b.data;
  };
  const bodyFrom = (init) =>
    init == null ? null : { data: init instanceof Uint8Array ? init : String(init), used: false };

  class Body {
    get bodyUsed() {
      return this[BODY] !== null && this[BODY].used;
    }
    text() { return readBody(this, "text"); }
    async json() { return JSON.parse(await readBody(this, "text")); }
    async bytes() { return readBody(this, "bytes"); }
    async arrayBuffer() { return (await readBody(this, "bytes")).buffer; }
  }

  const INTERNAL = Symbol("internal");

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
      if (input instanceof Request) {
        this.#method = input.method;
        this.#url = input.url;
        this.#headers = new Headers(input.headers);
        this[BODY] = input[BODY] && { ...input[BODY], used: false };
      } else {
        this.#method = "GET";
        this.#url = new URL(input).href;
        this.#headers = new Headers();
        this[BODY] = null;
      }
      if (init.method !== undefined) this.#method = String(init.method).toUpperCase();
      if (init.headers !== undefined) this.#headers = new Headers(init.headers);
      if (init.body !== undefined) this[BODY] = bodyFrom(init.body);
    }
    get method() { return this.#method; }
    get url() { return this.#url; }
    get headers() { return this.#headers; }
    clone() { return new Request(this); }
  }

  class Response extends Body {
    constructor(body = null, init = {}) {
      super();
      this.status = init.status ?? 200;
      this.statusText = init.statusText ?? "";
      this.headers = new Headers(init.headers);
      this[BODY] = bodyFrom(body);
      if (typeof body === "string" && !this.headers.has("content-type")) {
        this.headers.set("content-type", "text/plain;charset=UTF-8");
      }
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    static json(data, init = {}) {
      const r = new Response(JSON.stringify(data), init);
      r.headers.set("content-type", "application/json");
      return r;
    }
  }

  // Rejects the request with an error response (as the node SDK's class).
  class HttpRequestBlockedError extends Error {
    constructor(message = "request blocked", status = 403, statusText = "Forbidden") {
      super(message);
      this.name = "HttpRequestBlockedError";
      this.status = status;
      this.statusText = statusText;
    }
  }

  const fmt = (a) => (typeof a === "string" ? a : JSON.stringify(a));
  globalThis.console = {
    log: (...a) => log(a.map(fmt).join(" ")),
    info: (...a) => log(a.map(fmt).join(" ")),
    warn: (...a) => log(a.map(fmt).join(" ")),
    error: (...a) => log(a.map(fmt).join(" ")),
  };
  Object.assign(globalThis, {
    Headers,
    URL,
    URLSearchParams,
    Request,
    Response,
    HttpRequestBlockedError,
  });

  const wireBody = (b) => {
    if (b === null) return { kind: "none" };
    if (b.stream !== undefined) return { kind: "original" };
    if (typeof b.data === "string") return { kind: "text", text: b.data };
    return { kind: "bytes", bytes: Array.from(b.data) };
  };
  const wireRequest = (r) => ({ method: r.method, url: r.url, headers: r.headers.toWire() });

  // Entry point the host calls: (head, stream id or -1); the decision (plain
  // data) comes back through `__settle`.
  const onRequest = async (head, stream) => {
    const req = new Request(INTERNAL, {
      method: head.method,
      url: head.url,
      headers: head.headers,
      body: stream < 0 ? null : { stream, used: false },
    });
    const hook = globalThis.onRequest;
    if (typeof hook !== "function") return { action: "continue" };
    const out = await hook(req);
    if (out === undefined || out === null || out === req) {
      // In-place header edits on the original request count as a replacement.
      if (req.headers.__version === 0) return { action: "continue" };
      return { action: "request", head: wireRequest(req), body: wireBody(req[BODY]) };
    }
    if (out instanceof Response) {
      const body = out[BODY] === null ? { kind: "none" } : wireBody(out[BODY]);
      return {
        action: "respond",
        head: { status: out.status, statusText: out.statusText, headers: out.headers.toWire() },
        body,
      };
    }
    if (out instanceof Request) {
      return { action: "request", head: wireRequest(out), body: wireBody(out[BODY]) };
    }
    throw new TypeError("onRequest must return a Request, a Response or undefined");
  };
  globalThis.__gondolin_on_request = (head, stream) => {
    onRequest(head, stream).then(
      (d) => settle(true, JSON.stringify(d)),
      (e) => {
        if (e instanceof HttpRequestBlockedError) {
          const d = { action: "block", status: e.status, statusText: e.statusText, message: e.message };
          settle(true, JSON.stringify(d));
        } else {
          settle(false, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        }
      },
    );
  };
})();
