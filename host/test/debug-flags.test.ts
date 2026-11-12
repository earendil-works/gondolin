import assert from "node:assert/strict";
import test from "node:test";

import { parseDebugEnv, resolveDebugFlags } from "../src/debug.ts";

test("debug flags from GONDOLIN_DEBUG", () => {
  assert.deepEqual([...parseDebugEnv("exec, fs,timing,bogus")].sort(), [
    "exec",
    "timing",
    "vfs",
  ]);
  assert.deepEqual([...parseDebugEnv("all")].sort(), [
    "exec",
    "net",
    "protocol",
    "timing",
    "vfs",
  ]);
  assert.equal(parseDebugEnv(undefined).size, 0);
});

test("debug flags from the debug option", () => {
  const env = new Set(["net" as const]);
  assert.deepEqual([...resolveDebugFlags(["timing", "exec"], env)].sort(), [
    "exec",
    "timing",
  ]);
  assert.deepEqual(
    [...resolveDebugFlags(["bogus" as never], env)],
    [],
    "unknown flags are dropped",
  );
  assert.equal(resolveDebugFlags(undefined, env), env);
  assert.equal(resolveDebugFlags(true, env).size, 5);
  assert.equal(resolveDebugFlags(false, env).size, 0);
});
