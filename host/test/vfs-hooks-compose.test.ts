import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../src/vm";

test("composeVfsHooks preserves sync behavior when both hooks are sync", () => {
  const a: any = { before: () => {}, after: () => {} };
  const b: any = { before: () => {}, after: () => {} };

  const composed = __test.composeVfsHooks(a, b);

  const r1 = composed.before?.({ op: "stat", path: "/" } as any);
  assert.equal(r1, undefined);

  const r2 = composed.after?.({ op: "stat", path: "/" } as any);
  assert.equal(r2, undefined);
});

test("composeVfsHooks returns a Promise when an underlying hook is async", async () => {
  const a: any = { before: async () => {}, after: () => {} };
  const b: any = { before: () => {}, after: async () => {} };

  const composed = __test.composeVfsHooks(a, b);

  const r1 = composed.before?.({ op: "stat", path: "/" } as any);
  assert.ok(r1 && typeof (r1 as any).then === "function");
  await r1;

  const r2 = composed.after?.({ op: "stat", path: "/" } as any);
  assert.ok(r2 && typeof (r2 as any).then === "function");
  await r2;
});
