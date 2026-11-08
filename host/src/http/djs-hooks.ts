/**
 * Tier-2 hooks: network hook policies written as self-contained JavaScript
 * that the native engine runs inside gondolind on djs (no controller round
 * trip, also for remote daemons and the static CLI). See docs/native.md,
 * "Tier-2 hooks".
 *
 * `createDjsHooks()` returns ordinary {@link HttpHooks}; called directly, a
 * script policy runs in a `node:vm` context with node's own fetch classes.
 * Each returned function carries a hidden tag; the native engine sends tagged
 * functions as
 * `configure.net.djs_hooks` instead of calling them, also when they are
 * spread into `createHttpHooks({ ..., ...createDjsHooks(source) })`.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import type { HttpHooks } from "../net/types.ts";
import { HttpRequestBlockedError } from "./utils.ts";

/**
 * Hidden property on `createDjsHooks()` functions (and the hooks object)
 * holding the policy's {@link DjsHooksDescriptor}.
 */
export const NATIVE_DJS_HOOKS = Symbol.for("gondolin.http.djsHooks");

/** Per-call budgets of a tier-2 policy (absent: daemon defaults) */
export type DjsHookLimits = {
  /** interpreter fuel per call (about 4 ns per unit; default 50M) */
  fuel?: number;
  /** heap cap per call in `bytes` (default 64 MiB) */
  memoryBytes?: number;
  /** wall-clock time per call in `ms`, body reads included (default 30000) */
  timeoutMs?: number;
};

export type DjsHooksOptions = {
  /** policy source; defines (script) or exports (module) the hook functions */
  source: string;
  /**
   * `script` (default): global functions; `module`: ES module exports;
   * `typescript`: an ES module in TypeScript (types are erased). Modules
   * need the native engine.
   */
  kind?: "script" | "module" | "typescript";
  /** name in stack traces and the module key (default `policy.js` / `policy.mjs` / `policy.ts`) */
  filename?: string;
  /**
   * sources a module policy may import, by key (`./lib.js` resolves against
   * `filename`); the extension picks the language: `.ts`/`.mts`/`.cts`
   * TypeScript, `.json` a JSON module (`with { type: "json" }`), else JavaScript
   */
  modules?: Record<string, string>;
  /** per-call budgets on the native engine */
  limits?: DjsHookLimits;
};

/** `configure.net.djs_hooks` (gondolin-proto `DjsHooksConfig`) */
export type DjsHooksWire = {
  source: string;
  filename?: string;
  kind: "script" | "module" | "typescript";
  modules?: Record<string, string>;
  limits: { fuel?: number; memory_bytes?: number; timeout_ms?: number };
};

/** Value stored under {@link NATIVE_DJS_HOOKS} */
export type DjsHooksDescriptor = {
  /** the daemon's configuration */
  config: DjsHooksWire;
};

const PHASES = [
  "isRequestAllowed",
  "isIpAllowed",
  "onRequest",
  "onResponse",
] as const;

type Phase = (typeof PHASES)[number];

/** A hook function of any phase */
type HookFn = (...args: unknown[]) => unknown;

function positive(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(
      `createDjsHooks: limits.${name} must be a positive integer`,
    );
  }
  return value;
}

function wireConfig(options: DjsHooksOptions): DjsHooksWire {
  if (typeof options.source !== "string") {
    throw new TypeError("createDjsHooks: source must be a string");
  }
  const kind = options.kind ?? "script";
  if (kind !== "script" && kind !== "module" && kind !== "typescript") {
    throw new TypeError(`createDjsHooks: unknown kind ${String(kind)}`);
  }
  const modules = options.modules ?? {};
  if (kind === "script" && Object.keys(modules).length > 0) {
    throw new TypeError(
      'createDjsHooks: modules need kind: "module" or "typescript"',
    );
  }
  for (const [k, v] of Object.entries(modules)) {
    if (typeof v !== "string") {
      throw new TypeError(
        `createDjsHooks: modules[${JSON.stringify(k)}] must be a string`,
      );
    }
  }
  const limits = options.limits ?? {};
  const fuel = positive("fuel", limits.fuel);
  const memory = positive("memoryBytes", limits.memoryBytes);
  const timeout = positive("timeoutMs", limits.timeoutMs);
  return {
    source: options.source,
    ...(options.filename !== undefined ? { filename: options.filename } : {}),
    kind,
    ...(Object.keys(modules).length > 0 ? { modules: { ...modules } } : {}),
    limits: {
      ...(fuel !== undefined ? { fuel } : {}),
      ...(memory !== undefined ? { memory_bytes: memory } : {}),
      ...(timeout !== undefined ? { timeout_ms: timeout } : {}),
    },
  };
}

/** The node-engine fallback: the script's hooks, run in a `node:vm` context. */
function evaluateScript(config: DjsHooksWire): Partial<Record<Phase, HookFn>> {
  const log =
    (level: "log" | "info" | "debug" | "warn" | "error") =>
    (...args: unknown[]) =>
      console[level]("[gondolin hook]", ...args);
  const context = vm.createContext({
    Headers,
    Request,
    Response,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    HttpRequestBlockedError,
    console: Object.freeze({
      log: log("log"),
      info: log("info"),
      debug: log("debug"),
      warn: log("warn"),
      error: log("error"),
    }),
  });
  const filename = config.filename ?? "policy.js";
  vm.runInContext(config.source, context, { filename });
  // global lexical bindings (`const onRequest = ...`) are visible to later scripts
  const bound = vm.runInContext(
    `({ ${PHASES.map((p) => `${p}: typeof ${p} === "function" ? ${p} : undefined`).join(", ")} })`,
    context,
    { filename: "<gondolin-bind>" },
  ) as Partial<Record<Phase, HookFn>>;
  return bound;
}

function moduleOutsideDaemon(): never {
  throw new Error(
    'createDjsHooks: module policies (kind: "module" | "typescript") only run inside gondolind',
  );
}

/**
 * Creates tier-2 hooks from a self-contained policy.
 *
 * The policy defines any of `isRequestAllowed(request)`,
 * `isIpAllowed(info)`, `onRequest(request)` and `onResponse(response,
 * request)` with the {@link HttpHooks} contract; only those phases are
 * registered. It runs inside gondolind (a fresh state per call, budgets
 * from `limits`, any failure denies the request with 502) with a restricted
 * `Request`/`Response`/`Headers`/`URL` environment and no I/O; see
 * docs/native.md for the restrictions. The returned functions can also be
 * called directly: a script policy then runs in a `node:vm` context (globals
 * persist between calls there), a module policy throws.
 */
export function createDjsHooks(
  sourceOrOptions: string | DjsHooksOptions,
): HttpHooks {
  const options =
    typeof sourceOrOptions === "string"
      ? { source: sourceOrOptions }
      : sourceOrOptions;
  const config = wireConfig(options);
  const descriptor: DjsHooksDescriptor = { config };

  const hooks: HttpHooks = {};
  const tag = <F extends HookFn>(fn: F): F => {
    Object.defineProperty(fn, NATIVE_DJS_HOOKS, {
      value: descriptor,
      enumerable: false,
    });
    return fn;
  };
  if (config.kind !== "script") {
    // phases are only known to the daemon; direct calls fail closed
    for (const phase of PHASES) {
      (hooks as Record<string, HookFn>)[phase] = tag(async () =>
        moduleOutsideDaemon(),
      );
    }
  } else {
    const bound = evaluateScript(config);
    for (const phase of PHASES) {
      const fn = bound[phase];
      if (fn) {
        (hooks as Record<string, HookFn>)[phase] = tag((...args: unknown[]) =>
          fn(...args),
        );
      }
    }
  }
  Object.defineProperty(hooks, NATIVE_DJS_HOOKS, {
    value: descriptor,
    enumerable: false,
  });
  return hooks;
}

/** The tier-2 descriptor a hook function carries, if any. */
export function djsHooksOf(fn: unknown): DjsHooksDescriptor | undefined {
  if (typeof fn !== "function") return undefined;
  return (fn as unknown as Record<symbol, DjsHooksDescriptor | undefined>)[
    NATIVE_DJS_HOOKS
  ];
}

/** Most modules {@link djsHooksOptionsFromFile} pulls in */
const MAX_HOOK_MODULES = 256;

/**
 * `createDjsHooks()` options for a policy file (the CLIs' `--hooks-script`):
 * named by its basename, the kind from the extension (`.mjs` module,
 * `.ts`/`.mts` TypeScript, else script), and for modules the files its
 * relative imports name, read from next to it (transitively) into `modules`,
 * so the daemon does no I/O. Specifiers whose file does not exist (or that
 * leave the directory) are skipped; the daemon reports them if they are
 * really imported. Mirrors the static CLI (`gondolin-cli/src/netcfg.rs`).
 */
export function djsHooksOptionsFromFile(file: string): DjsHooksOptions {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read --hooks-script ${file}: ${(err as Error).message}`,
    );
  }
  const filename = path.basename(file);
  const kind = filename.endsWith(".mjs")
    ? "module"
    : filename.endsWith(".ts") || filename.endsWith(".mts")
      ? "typescript"
      : "script";
  if (kind === "script") return { source, filename, kind };
  const dir = path.dirname(file);
  const modules: Record<string, string> = {};
  const queue: Array<[string, string]> = [[filename, source]];
  while (queue.length > 0) {
    const [importer, text] = queue.pop()!;
    if (importer.endsWith(".json")) continue;
    for (const spec of importSpecifiers(text)) {
      const target = joinModuleKey(importer, spec);
      if (target === null || target === filename || target in modules) {
        continue;
      }
      let contents: string;
      try {
        contents = fs.readFileSync(path.join(dir, target), "utf8");
      } catch {
        continue;
      }
      if (Object.keys(modules).length >= MAX_HOOK_MODULES) {
        throw new Error(
          `--hooks-script imports more than ${MAX_HOOK_MODULES} modules`,
        );
      }
      modules[target] = contents;
      queue.push([target, contents]);
    }
  }
  return {
    source,
    filename,
    kind,
    ...(Object.keys(modules).length > 0 ? { modules } : {}),
  };
}

/** `relative` against the directory of key `base` (djs-embed's `ModuleMap`); null for bare specifiers and paths above the root */
function joinModuleKey(base: string, relative: string): string | null {
  if (!relative.startsWith("./") && !relative.startsWith("../")) return null;
  const parts = base.split("/");
  parts.pop();
  for (const seg of relative.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

const isIdent = (c: string | undefined) =>
  c !== undefined && /[A-Za-z0-9_$]/.test(c);
const isSpace = (c: string | undefined) =>
  c !== undefined && /[\t\n\v\f\r ]/.test(c);

/** String literals after `from`, `import` or `import(`: a scan, not a parse (as the static CLI) */
export function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const word = text.startsWith("from", i)
      ? 4
      : text.startsWith("import", i)
        ? 6
        : 0;
    if (word === 0) {
      i++;
      continue;
    }
    const start = i;
    i += word;
    if (isIdent(text[start - 1]) || isIdent(text[i])) continue;
    let j = i;
    while (isSpace(text[j])) j++;
    if (word === 6 && text[j] === "(") {
      j++;
      while (isSpace(text[j])) j++;
    }
    const quote = text[j];
    if (quote === '"' || quote === "'") {
      let n = j + 1;
      while (n < text.length && text[n] !== quote && text[n] !== "\n") n++;
      if (text[n] === quote) {
        out.push(text.slice(j + 1, n));
        i = n + 1;
      }
    }
  }
  return out;
}
