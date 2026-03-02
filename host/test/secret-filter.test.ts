import assert from "node:assert/strict";
import test from "node:test";

import {
  classify,
  classifyEnvForGondolin,
} from "@earendil-works/secret-filter";

test("secret-filter: classifyEnvForGondolin maps overrides into secretsMap", () => {
  const env = {
    PROJECT_TOKEN: "secret-value",
    NORMAL_FLAG: "1",
  };

  const result = classifyEnvForGondolin(env, {
    overrides: {
      PROJECT_TOKEN: ["api.example.com"],
    },
  });

  assert.deepEqual(result.secretsMap.PROJECT_TOKEN, {
    hosts: ["api.example.com"],
    value: "secret-value",
  });
  assert.ok(result.safe.includes("NORMAL_FLAG"));
  assert.equal(result.dropped.length, 0);
});

test("secret-filter: classify marks generic secret names without host mapping as dropped", () => {
  const result = classify("MYSTERY_TOKEN", "abc123");

  assert.equal(result.isSecret, true);
  assert.equal(result.dropped, true);
  assert.equal(result.matchedBy, "name-pattern");
});
