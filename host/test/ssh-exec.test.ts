import assert from "node:assert/strict";
import test from "node:test";

import { getInfoFromSshExecRequest } from "../src/ssh/exec.ts";

test("getInfoFromSshExecRequest parses git-upload-pack", () => {
  const info = getInfoFromSshExecRequest({
    hostname: "github.com",
    port: 22,
    guestUsername: "git",
    command: "git-upload-pack 'my-org/my-repo.git'",
    src: { ip: "192.168.127.3", port: 50000 },
  });

  assert.deepEqual(info, {
    service: "git-upload-pack",
    repo: "my-org/my-repo.git",
  });
});

test("getInfoFromSshExecRequest normalizes repo paths", () => {
  const info = getInfoFromSshExecRequest({
    hostname: "github.com",
    port: 22,
    guestUsername: "git",
    command: "git-receive-pack '/my-org/my-repo.git/'",
    src: { ip: "192.168.127.3", port: 50000 },
  });

  assert.deepEqual(info, {
    service: "git-receive-pack",
    repo: "my-org/my-repo.git",
  });
});

test("getInfoFromSshExecRequest returns null for non-git commands", () => {
  const info = getInfoFromSshExecRequest({
    hostname: "example.com",
    port: 22,
    guestUsername: "root",
    command: "echo hello",
    src: { ip: "192.168.127.3", port: 50000 },
  });

  assert.equal(info, null);
});

test("getInfoFromSshExecRequest returns null for multiple shell commands", () => {
  const info = getInfoFromSshExecRequest({
    hostname: "github.com",
    port: 22,
    guestUsername: "git",
    command: "git-upload-pack 'my-org/my-repo.git' && echo pwned",
    src: { ip: "192.168.127.3", port: 50000 },
  });

  assert.equal(info, null);
});

test("getInfoFromSshExecRequest returns null for suspicious repo paths", () => {
  const info = getInfoFromSshExecRequest({
    hostname: "github.com",
    port: 22,
    guestUsername: "git",
    command: 'git-upload-pack "$(echo my-org/my-repo.git)"',
    src: { ip: "192.168.127.3", port: 50000 },
  });

  assert.equal(info, null);
});

test("getInfoFromSshExecRequest returns null for suspicious service paths", () => {
  const info = getInfoFromSshExecRequest({
    hostname: "github.com",
    port: 22,
    guestUsername: "git",
    command: "/usr/lib/git-core/$(id)/git-upload-pack 'my-org/my-repo.git'",
    src: { ip: "192.168.127.3", port: 50000 },
  });

  assert.equal(info, null);
});
