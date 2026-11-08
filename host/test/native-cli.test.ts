/**
 * VM tests of the static native CLI (`native/crates/gondolin-cli`): exec,
 * bash (pipes and a real pty), sessions shared with the Node CLI (list,
 * attach, exec --sock, snapshot/resume in both directions) and image commands.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkoutGuestDir, resolveNativeCli } from "./helpers/native-cli.ts";
import { shouldSkipVmTests } from "./helpers/vm-fixture.ts";

const cli = resolveNativeCli();
const guestDir = process.env.GONDOLIN_GUEST_DIR ?? checkoutGuestDir();
const skip = shouldSkipVmTests()
  ? "hardware acceleration unavailable"
  : !cli
    ? "static gondolin CLI not built (cargo build -p gondolin-cli)"
    : !guestDir
      ? "no local guest assets (GONDOLIN_GUEST_DIR)"
      : false;

const nodeCli = path.resolve(import.meta.dirname, "..", "bin", "gondolin.ts");
// short: session sockets live below it (macOS limits unix socket paths)
const scratch = fs.mkdtempSync(
  path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "gcli-"),
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GONDOLIN_GUEST_DIR: guestDir ?? "",
  GONDOLIN_SESSIONS_DIR: path.join(scratch, "sessions"),
  GONDOLIN_CHECKPOINT_DIR: path.join(scratch, "checkpoints"),
};
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

type Run = { code: number; stdout: string; stderr: string };

function run(
  command: "native" | "node",
  args: string[],
  input?: string,
  timeoutMs = 90_000,
): Promise<Run> {
  const [file, argv] =
    command === "native"
      ? [cli!, args]
      : [process.execPath, [nodeCli, ...args]];
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    // commands that do not read stdin may exit before the write (EPIPE)
    child.stdin!.on("error", () => {});
    child.stdin!.end(input ?? "");
  });
}

/** Starts a long-running session owned by `owner`; resolves with its id */
async function startSession(
  owner: "native" | "node",
  setup: string,
): Promise<{ id: string; proc: ChildProcess; done: Promise<number> }> {
  const before = new Set(await sessionIds());
  const [file, argv] =
    owner === "native" ? [cli!, []] : [process.execPath, [nodeCli]];
  const proc = spawn(
    file,
    [
      ...argv,
      "exec",
      "--cmd",
      "/bin/sh",
      "--arg",
      "-c",
      "--arg",
      setup,
      "--cmd",
      "/bin/sleep",
      "--arg",
      "120",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  proc.stderr!.on("data", (d) => (stderr += d));
  const done = new Promise<number>((resolve) =>
    proc.on("close", (code) => resolve(code ?? -1)),
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const fresh = (await sessionIds()).filter((id) => !before.has(id));
    if (fresh.length > 0) {
      // the first command (setup) runs right after registration
      await new Promise((r) => setTimeout(r, 500));
      return { id: fresh[0]!, proc, done };
    }
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill("SIGKILL");
  throw new Error(`session of ${owner} did not register: ${stderr}`);
}

async function sessionIds(): Promise<string[]> {
  const r = await run("native", ["list"]);
  return r.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.split(/\s+/)[0]!)
    .filter((id) => /^[0-9a-f-]{36}$/.test(id));
}

test("native cli: exec output, exit codes and multi-command form", {
  skip,
  timeout: 180_000,
}, async () => {
  const r = await run("native", [
    "exec",
    "--",
    "/bin/sh",
    "-c",
    "echo out; echo err >&2; exit 3",
  ]);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.stdout, "out\n");
  assert.match(r.stderr, /err/);

  const multi = await run("native", [
    "exec",
    "--cmd",
    "/bin/sh",
    "--arg",
    "-c",
    "--arg",
    "echo $A; exit 4",
    "--env",
    "A=first",
    "--cmd",
    "/bin/sh",
    "--arg",
    "-c",
    "--arg",
    "pwd; exit 5",
    "--cwd",
    "/etc",
  ]);
  assert.equal(multi.code, 4, multi.stderr);
  assert.equal(multi.stdout, "first\n/etc\n");
});

test("native cli: exec with host and memory mounts", {
  skip,
  timeout: 180_000,
}, async () => {
  const host = fs.mkdtempSync(path.join(scratch, "host-"));
  fs.writeFileSync(path.join(host, "in.txt"), "from host\n");
  const r = await run("native", [
    "exec",
    "--mount-hostfs",
    `${host}:/work`,
    "--mount-hostfs",
    `${host}:/ro:ro`,
    "--mount-memfs",
    "/scratch",
    "--",
    "/bin/sh",
    "-c",
    "cat /work/in.txt; echo guest > /work/out.txt; echo m > /scratch/m; cat /scratch/m; touch /ro/x 2>/dev/null || echo ro-denied",
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "from host\nm\nro-denied\n");
  assert.equal(fs.readFileSync(path.join(host, "out.txt"), "utf8"), "guest\n");
});

test("native cli: bash with piped stdin and a command", {
  skip,
  timeout: 180_000,
}, async () => {
  const shell = await run(
    "native",
    ["bash"],
    "echo in-shell $((1+2)); tty; exit 4\n",
  );
  assert.equal(shell.code, 4, shell.stderr);
  assert.match(shell.stdout, /in-shell 3/);
  assert.match(shell.stdout, /\/dev\/pts\//);

  const cmd = await run("native", [
    "bash",
    "--env",
    "X=y",
    "--",
    "/bin/sh",
    "-c",
    "echo $X $TERM; exit 7",
  ]);
  assert.equal(cmd.code, 7, cmd.stderr);
  assert.match(cmd.stdout, /^y \S+/m);
});

const python = spawnSync("python3", ["--version"]).status === 0;

test("native cli: bash in a pty (raw mode, resize)", {
  skip: skip || (!python && "python3 unavailable"),
  timeout: 180_000,
}, async () => {
  const script = `
import os, pty, sys, time, select, fcntl, termios, struct, signal
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    os.execv(sys.argv[1], [sys.argv[1], "bash", "--", "/bin/sh"])
def read_until(token, timeout=60):
    buf = b""
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                d = os.read(fd, 4096)
            except OSError:
                break
            if not d: break
            buf += d
            if token in buf: return buf
    return buf
out = read_until(b"# ")
os.write(fd, b"stty size\\r")
out += read_until(b"30 100")
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
os.kill(pid, signal.SIGWINCH)
time.sleep(0.5)
os.write(fd, b"stty size; exit 9\\r")
out += read_until(b"40 120")
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`;
  const r = spawnSync("python3", ["-c", script, cli!], {
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(r.status, 9, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /30 100/);
  assert.match(r.stdout, /40 120/);
});

for (const [owner, client] of [
  ["native", "node"],
  ["node", "native"],
] as const) {
  test(`native cli: ${owner} session, ${client} list/exec --sock/attach/snapshot, resume on both`, {
    skip,
    timeout: 300_000,
  }, async () => {
    const session = await startSession(owner, `echo ${owner} > /opt/marker`);
    try {
      const short = session.id.slice(0, 8);
      for (const who of ["native", "node"] as const) {
        const list = await run(who, ["list"]);
        assert.match(list.stdout, new RegExp(session.id), `${who} list`);
      }
      const sock = await run(client, [
        "exec",
        "--sock",
        short,
        "--",
        "/bin/sh",
        "-c",
        "cat /opt/marker; exit 2",
      ]);
      assert.equal(sock.code, 2, sock.stderr);
      assert.equal(sock.stdout, `${owner}\n`);

      const attach = await run(
        client,
        ["attach", short, "--", "/bin/sh"],
        "cat /opt/marker; exit 5\n",
      );
      assert.equal(attach.code, 5, attach.stderr);
      assert.match(attach.stdout, new RegExp(`^${owner}\\r?$`, "m"));

      const name = `snap-${owner}-${client}`;
      const snap = await run(client, ["snapshot", short, "--name", name]);
      assert.equal(snap.code, 0, snap.stderr);
      assert.match(snap.stdout, /Snapshot created:/);
      assert.match(snap.stdout, new RegExp(`gondolin bash --resume ${name}`));
      // the snapshotted session stops
      const owned = await Promise.race([
        session.done,
        new Promise<number>((r) => setTimeout(() => r(-2), 30_000)),
      ]);
      assert.notEqual(
        owned,
        -2,
        "session owner did not exit after the snapshot",
      );

      for (const who of ["native", "node"] as const) {
        const resumed = await run(
          who,
          ["bash", "--resume", name, "--", "/bin/sh"],
          "cat /opt/marker; echo x >> /opt/marker; exit 3\n",
        );
        assert.equal(resumed.code, 3, `${who} resume: ${resumed.stderr}`);
        assert.match(resumed.stdout, new RegExp(`^${owner}\\r?$`, "m"));
        // resumes do not write to the checkpoint
        assert.doesNotMatch(resumed.stdout, /^x\r?$/m);
      }
    } finally {
      // SIGTERM so the owner stops its VM
      session.proc.kill("SIGTERM");
      const stopped = await Promise.race([
        session.done.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
      ]);
      if (!stopped) session.proc.kill("SIGKILL");
    }
  });
}

test("native cli: image commands", { skip, timeout: 60_000 }, async () => {
  const inspect = await run("native", ["image", "inspect", guestDir!]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /^source: path$/m);
  assert.match(inspect.stdout, /^assetDir: /m);
  const ls = await run("native", ["image", "ls"]);
  assert.equal(ls.code, 0, ls.stderr);
  const build = await run("native", ["build"]);
  assert.equal(build.code, 2);
  assert.match(build.stderr, /Node CLI/);
});

const sshClient = spawnSync("ssh", ["-V"]).status === 0;

test("native cli: bash --listen (http, websocket) and --ssh", {
  skip,
  timeout: 180_000,
}, async () => {
  const server = `
const http = require("http");
const s = http.createServer((req, res) => res.end("path=" + req.url + " prefix=" + req.headers["x-forwarded-prefix"]));
s.on("upgrade", (req, sock) => {
  sock.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
  sock.on("data", (d) => sock.write("echo:" + d));
});
s.listen(9000);
`;
  const b64 = Buffer.from(server).toString("base64");
  const proc = spawn(
    cli!,
    [
      "bash",
      "--listen",
      "127.0.0.1:0",
      ...(sshClient ? ["--ssh"] : []),
      "--",
      "/bin/sh",
      "-c",
      `echo ${b64} | base64 -d > /tmp/srv.js; (node /tmp/srv.js &); sleep 1; printf '/app :9000\\n' > /etc/gondolin/listeners; echo ready; sleep 60`,
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (d) => (stdout += d));
  proc.stderr!.on("data", (d) => (stderr += d));
  try {
    const deadline = Date.now() + 60_000;
    while (!/ready/.test(stdout) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(stdout, /ready/, stderr);
    const url = /Ingress enabled: (http:\/\/\S+)/.exec(stderr)?.[1];
    assert.ok(url, stderr);
    // the listeners file is reloaded asynchronously and the guest's node
    // server may still be starting (slow under nested virtualization)
    let body = "";
    const fetchDeadline = Date.now() + 60_000;
    while (Date.now() < fetchDeadline) {
      const res = await fetch(`${url}/app/x?y=1`);
      body = await res.text();
      if (res.status === 200) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(body, "path=/x?y=1 prefix=/app");
    assert.equal((await fetch(`${url}/nope`)).status, 404);

    const net = await import("node:net");
    const port = Number(new URL(url).port);
    const echoed = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(
          "GET /app/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
      });
      let buf = "";
      sock.on("data", (d) => {
        buf += d;
        if (buf.includes("\r\n\r\n") && !buf.includes("echo:"))
          sock.write("ping");
        if (buf.includes("echo:ping")) {
          sock.destroy();
          resolve(buf);
        }
      });
      sock.on("error", reject);
      setTimeout(() => reject(new Error(`websocket timeout: ${buf}`)), 10_000);
    });
    assert.match(echoed, /^HTTP\/1.1 101/);

    if (sshClient) {
      const command = /SSH enabled: (.+)/.exec(stderr)?.[1];
      assert.ok(command, stderr);
      const [file, ...args] = command.split(" ");
      const ssh = spawnSync(
        file!,
        [...args, "-o", "LogLevel=ERROR", "cat /etc/gondolin/listeners"],
        {
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      assert.equal(ssh.status, 0, ssh.stderr);
      assert.equal(ssh.stdout, "/app\t:9000\n");
    }
  } finally {
    proc.kill("SIGTERM");
  }
});
