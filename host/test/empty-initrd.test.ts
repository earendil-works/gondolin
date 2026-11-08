import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { createEmptyInitrd } from "../src/utils/empty-initrd.ts";

test("createEmptyInitrd is a non-empty newc archive with only a trailer", (t) => {
  const initrd = createEmptyInitrd();
  assert.equal(initrd.length, 512);
  assert.equal(initrd.subarray(0, 6).toString("latin1"), "070701");
  assert.equal(initrd.subarray(110, 120).toString("latin1"), "TRAILER!!!");

  let listing: string;
  try {
    listing = execFileSync("cpio", ["-it"], {
      input: initrd,
      encoding: "utf8",
    });
  } catch {
    t.skip("cpio not available");
    return;
  }
  assert.equal(listing.trim(), "");
});
