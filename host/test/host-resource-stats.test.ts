import assert from "node:assert/strict";
import test from "node:test";

import {
  getHostResourceStatsForPid,
  readProcessRssBytes,
  readProcessTreeRssBytes,
} from "../src/host/resource-stats.ts";

test("host resource stats: null pid returns null fields", () => {
  assert.deepEqual(getHostResourceStatsForPid(null), {
    pid: null,
    rssBytes: null,
    treeRssBytes: null,
  });
});

test("host resource stats: reports current process RSS", () => {
  const rssBytes = readProcessRssBytes(process.pid);

  assert.ok(rssBytes !== null);
  assert.ok(rssBytes > 0);
});

test("host resource stats: reports Linux process tree RSS", { skip: process.platform !== "linux" }, () => {
  const rssBytes = readProcessRssBytes(process.pid);
  const treeRssBytes = readProcessTreeRssBytes(process.pid);

  assert.ok(rssBytes !== null);
  assert.ok(treeRssBytes !== null);
  assert.ok(treeRssBytes >= rssBytes);
});
