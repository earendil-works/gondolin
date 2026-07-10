import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test as sharedTest } from "../src/build/shared.ts";

const { quoteCmdArg, resolveWindowsCommandPath, resolveSpawnCommand } =
  sharedTest;

test("quoteCmdArg wraps values in quotes and caret-escapes cmd.exe metacharacters", () => {
  assert.equal(quoteCmdArg("simple"), '"simple"');
  assert.equal(quoteCmdArg("has space"), '"has space"');
  assert.equal(quoteCmdArg("amp&ersand"), '"amp^&ersand"');
  assert.equal(quoteCmdArg("pipe|char"), '"pipe^|char"');
  assert.equal(quoteCmdArg("less<than"), '"less^<than"');
  assert.equal(quoteCmdArg("greater>than"), '"greater^>than"');
});

test("quoteCmdArg leaves backslashes and percent signs untouched", () => {
  // cmd.exe's batch-argument tokenizer (unlike CommandLineToArgvW) does not
  // treat backslashes specially, and percent-doubling is a batch-file-body
  // concept that does not apply to arguments delivered via the command line.
  assert.equal(quoteCmdArg("trailing\\backslash\\"), '"trailing\\backslash\\"');
  assert.equal(quoteCmdArg("percent%VAR%percent"), '"percent%VAR%percent"');
});

test("quoteCmdArg refuses arguments containing a literal double quote", () => {
  assert.throws(() => quoteCmdArg('has"quote'), /double quote/);
});

test("resolveWindowsCommandPath returns the command unchanged when it already looks like a path", () => {
  const resolved = resolveWindowsCommandPath("C:\\tools\\docker.exe", undefined, {
    platform: "win32",
  });
  assert.equal(resolved, "C:\\tools\\docker.exe");
});

test("resolveWindowsCommandPath falls back to the bare command when nothing on PATH matches", () => {
  const resolved = resolveWindowsCommandPath(
    "docker",
    { PATH: "C:\\a;C:\\tools", PATHEXT: ".EXE;.CMD" } as NodeJS.ProcessEnv,
    { platform: "win32", existsSync: () => false },
  );
  assert.equal(resolved, "docker");
});

test("resolveWindowsCommandPath finds a .cmd shim on PATH", () => {
  const resolved = resolveWindowsCommandPath(
    "docker",
    { PATH: "C:\\a;C:\\tools", PATHEXT: ".EXE;.CMD" } as NodeJS.ProcessEnv,
    {
      platform: "win32",
      existsSync: (candidate) => candidate === "C:\\tools\\docker.cmd",
    },
  );
  assert.equal(resolved, "C:\\tools\\docker.cmd");
});

test("resolveSpawnCommand is a no-op off Windows", () => {
  const resolved = resolveSpawnCommand("docker", ["run"], {}, { platform: "linux" });
  assert.deepEqual(resolved, { command: "docker", args: ["run"] });
});

test("resolveSpawnCommand passes non-.bat/.cmd commands through unmodified on Windows", () => {
  const resolved = resolveSpawnCommand(
    "C:\\tools\\docker.exe",
    ["run", "--rm"],
    {},
    { platform: "win32" },
  );
  assert.deepEqual(resolved, { command: "C:\\tools\\docker.exe", args: ["run", "--rm"] });
});

test("resolveSpawnCommand reroutes .cmd files through cmd.exe without `call`, wrapped for /s", () => {
  const resolved = resolveSpawnCommand(
    "C:\\tools\\docker.cmd",
    ["run", "arg with space", "amp&ersand"],
    {},
    { platform: "win32", existsSync: () => false },
  );
  assert.equal(resolved.command, process.env.ComSpec ?? "cmd.exe");
  assert.equal(resolved.windowsVerbatimArguments, true);
  assert.deepEqual(resolved.args.slice(0, 3), ["/d", "/s", "/c"]);
  const inner = resolved.args[3];
  assert.match(inner, /^".*"$/); // wrapped in exactly one extra outer quote pair
  assert.doesNotMatch(inner, /\bcall\b/);
  assert.match(inner, /"arg with space"/);
  assert.match(inner, /amp\^&ersand/);
});

test.describe("resolveSpawnCommand end-to-end via real cmd.exe", { skip: process.platform !== "win32" }, () => {
  test("delivers arguments with spaces and metacharacters to a real .cmd script intact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cmd-spawn-test-"));
    const scriptPath = path.join(dir, "echoargs.cmd");
    fs.writeFileSync(
      scriptPath,
      [
        "@echo off",
        ":loop",
        'if "%~1"=="" goto :eof',
        "echo ARG=[%~1]",
        "shift",
        "goto loop",
      ].join("\r\n"),
    );

    const cases = ["simple", "has space", "amp&ersand", "pipe|char", "trailing\\backslash\\"];
    const resolved = resolveSpawnCommand(scriptPath, cases, {});

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(resolved.command, resolved.args, {
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });

    const expected = cases.map((c) => `ARG=[${c}]`).join("\r\n") + "\r\n";
    assert.equal(output, expected);
  });
});
