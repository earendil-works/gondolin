import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../src/alpine/oci.ts";

// Permission-bit behaviour depends on a POSIX host and the caller umask, so it
// is covered by Linux CI. This contract test guards the tar invocation itself:
// without `-p` extraction drops setuid/sticky/0755 bits for non-root builds.
test("OCI rootfs extraction asks tar to preserve archived permission bits", () => {
  const args = __test.rootfsTarArgs("/tmp/rootfs.tar", "/tmp/rootfs");
  assert.ok(args.includes("-x"));
  assert.ok(args.includes("-f"));
  assert.ok(args.includes("-p") || args.includes("--preserve-permissions"));
  assert.ok(args.includes("/tmp/rootfs.tar"));
  assert.ok(args.includes("-C"));
  assert.ok(args.includes("/tmp/rootfs"));
});
