import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test as suggestionTest } from "../src/secret-host-suggestions.ts";

const {
  collectSuggestionsFromDetectorSource,
  extractUrlHosts,
  mergeSuggestions,
  parseTrufflehogJsonLines,
} = suggestionTest;

test("extractUrlHosts only finds url hosts", () => {
  assert.deepEqual(
    extractUrlHosts('import "github.com/x/y" and https://api.openai.com/v1/me'),
    ["api.openai.com"],
  );
});

test("parseTrufflehogJsonLines parses newline-delimited json", () => {
  const findings = parseTrufflehogJsonLines(
    '{"DetectorName":"OpenAI"}\n{"DetectorName":"Github"}\n',
  );
  assert.deepEqual(
    findings.map((finding: any) => finding.DetectorName),
    ["OpenAI", "Github"],
  );
});

test("collectSuggestionsFromDetectorSource finds hosts in detector source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-detector-src-"));
  const detectorDir = path.join(root, "pkg", "detectors", "openai");
  fs.mkdirSync(detectorDir, { recursive: true });
  fs.writeFileSync(
    path.join(detectorDir, "openai.go"),
    [
      "package openai",
      'import "github.com/wasilibs/go-re2"',
      "func x() { _ = detectorspb.DetectorType_OpenAI }",
      'const endpoint = "https://api.openai.com/v1/me"',
    ].join("\n"),
  );

  try {
    const suggestions = collectSuggestionsFromDetectorSource(root, "OpenAI");
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].host, "api.openai.com");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mergeSuggestions deduplicates hosts and counts evidence", () => {
  const merged = mergeSuggestions([
    {
      host: "api.github.com",
      file: "a.ts",
      line: 1,
      snippet: "one",
      count: 1,
    },
    {
      host: "api.github.com",
      file: "b.ts",
      line: 2,
      snippet: "two",
      count: 1,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].host, "api.github.com");
  assert.equal(merged[0].count, 2);
});
