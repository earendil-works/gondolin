import assert from "node:assert/strict";
import test from "node:test";

import { parseListenersFile, serializeListenersFile } from "../src/ingress";

test("listeners file: parses basic routes", () => {
  const parsed = parseListenersFile(`/ :8080\n/api :4000\n/api2 :4001 strip_prefix=false\n`);
  assert.deepEqual(parsed.routes, [
    { prefix: "/", port: 8080, stripPrefix: true },
    { prefix: "/api", port: 4000, stripPrefix: true },
    { prefix: "/api2", port: 4001, stripPrefix: false },
  ]);
});

test("listeners file: serializes canonical form", () => {
  const text = serializeListenersFile({
    routes: [
      { prefix: "/", port: 8080, stripPrefix: true },
      { prefix: "/api", port: 4000, stripPrefix: true },
      { prefix: "/api2", port: 4001, stripPrefix: false },
    ],
  });

  assert.equal(text, "/\t:8080\n/api\t:4000\n/api2\t:4001\tstrip_prefix=false\n");
});

test("listeners file: ignores NUL padding", () => {
  const parsed = parseListenersFile(`/ :8000\n\0\0\n`);
  assert.deepEqual(parsed.routes, [{ prefix: "/", port: 8000, stripPrefix: true }]);
});
