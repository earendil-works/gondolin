// Linux end-to-end smoke test of the native engine (run by in-container.sh).
// Exercises the paths only Linux hosts take: QEMU without KVM (TCG), memfd
// guest RAM + vhost-user-fs (virtio-fs), openat2-confined host mounts,
// /etc/resolv.conf for trusted DNS, and PR_SET_PDEATHSIG (QEMU dies with
// gondolind).
//
// usage: node native/scripts/docker/linux-smoke.mts
// env:   GONDOLIN_NATIVE_BIN, GONDOLIN_GUEST_DIR (set by in-container.sh);
//        SMOKE_MACHINE / SMOKE_ACCEL force `sandbox.machineType` / `sandbox.accel`
//        (e.g. `microvm` + `tcg,thread=multi`: the x86_64 KVM CI configuration
//        under TCG)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const { VM, RealFSProvider, createHttpHooks } = await import(
  path.join(repoRoot, "host/src/index.ts")
);

let failures = 0;
function check(ok: boolean, what: string, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

function cmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    return "";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // a zombie is not alive for our purpose
    return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
}

const share = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-smoke-"));
fs.writeFileSync(path.join(share, "hello.txt"), "hi from host\n");
const secret = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-secret-"));
fs.writeFileSync(path.join(secret, "secret.txt"), "outside\n");
fs.symlinkSync(path.join(secret, "secret.txt"), path.join(share, "escape"));

const machine = process.env.SMOKE_MACHINE || undefined;
const accel = process.env.SMOKE_ACCEL || undefined;
// extra kernel parameters after the default command line
const appendExtra = process.env.SMOKE_APPEND || "";
const append = appendExtra
  ? `console=${process.arch === "arm64" ? "ttyAMA0" : "ttyS0"} initramfs_async=1 ${appendExtra}`
  : undefined;
console.log(`        host ${process.arch}, machine ${machine ?? "(default)"}, accel ${accel ?? "(default)"}`);

const start = Date.now();
const vm = await VM.create({
  engine: "native",
  memory: "1G",
  cpus: 2,
  sandbox: { console: process.env.SMOKE_CONSOLE ? "stdio" : "none", machineType: machine, accel, append },
  dns: { mode: "trusted" },
  httpHooks: createHttpHooks({ allowedHosts: ["example.com"] }).httpHooks,
  vfs: { mounts: { "/work": new RealFSProvider(share) } },
});
try {
  const r0 = await vm.exec(["/bin/true"]);
  check(r0.exitCode === 0, "VM boots under TCG", `${((Date.now() - start) / 1000).toFixed(1)}s to first exec`);

  const server = (vm as unknown as { server: { getDaemonPid(): number | null } }).server;
  const daemonPid = server.getDaemonPid();
  const qemuPid = vm.getHostPid();
  const qemuArgs = qemuPid ? cmdline(qemuPid) : "";
  check(/-accel tcg|accel=tcg/.test(qemuArgs), "QEMU uses TCG (no /dev/kvm)");
  if (machine) {
    check(qemuArgs.includes(`-machine ${machine}`), `machine type ${machine}`);
  }
  check(/memory-backend-memfd/.test(qemuArgs), "guest RAM is memfd-backed (vhost-user)");
  check(
    machine === "microvm" ? / vhost-user-fs-device,/.test(qemuArgs) : /vhost-user-fs/.test(qemuArgs),
    "vhost-user-fs device configured",
  );
  console.log(`        qemu: ${qemuArgs.slice(0, 400)}${qemuArgs.length > 400 ? " …" : ""}`);

  const mounts = await vm.exec(["/bin/sh", "-c", "grep -E ' /data | /work ' /proc/mounts"]);
  check(/ \/data virtiofs /.test(mounts.stdout), "/data is virtio-fs");
  check(/ \/work virtiofs /.test(mounts.stdout), "host mount served over virtio-fs", mounts.stdout.trim().replace(/\n/g, "; "));

  const rw = await vm.exec([
    "/bin/sh",
    "-c",
    "cat /work/hello.txt && echo from-guest > /work/out.txt && mkdir -p /work/d/e && mv /work/out.txt /work/d/e/moved.txt && ls /work/d/e",
  ]);
  check(rw.exitCode === 0 && rw.stdout.includes("hi from host"), "read/write/rename through the mount", rw.stderr.trim());
  check(
    fs.readFileSync(path.join(share, "d/e/moved.txt"), "utf8") === "from-guest\n",
    "host sees the guest's writes",
  );

  const esc = await vm.exec(["/bin/sh", "-c", "cat /work/escape"]);
  check(
    esc.exitCode !== 0 && !esc.stdout.includes("outside"),
    "symlink out of the mount root is not followed (openat2 RESOLVE_BENEATH)",
    `exit ${esc.exitCode} ${esc.stderr.trim()}`,
  );

  const resolv = fs.existsSync("/etc/resolv.conf") ? fs.readFileSync("/etc/resolv.conf", "utf8") : "";
  console.log(`        host resolv.conf nameservers: ${resolv.match(/^nameserver .*/gm)?.join(", ") ?? "none"}`);
  const dns = await vm.exec(["/bin/sh", "-c", "cat /etc/resolv.conf; getent hosts example.com || nslookup example.com"]);
  check(dns.exitCode === 0, "trusted DNS through the host's resolv.conf", dns.stdout.trim().replace(/\n/g, "; "));

  const http = await vm.exec([
    "/bin/sh",
    "-c",
    "curl -sS -o /dev/null -w '%{http_code}' --max-time 60 https://example.com/",
  ]);
  check(http.exitCode === 0 && /^[23]/.test(http.stdout), "HTTPS egress through the native MITM", `${http.stdout} ${http.stderr.trim()}`);

  if (daemonPid && qemuPid) {
    process.kill(daemonPid, "SIGKILL");
    const deadline = Date.now() + 10_000;
    while (alive(qemuPid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    check(!alive(qemuPid), "QEMU exits when gondolind is killed (PR_SET_PDEATHSIG)");
  } else {
    check(false, "found gondolind and QEMU pids", `daemon ${daemonPid} qemu ${qemuPid}`);
  }
} finally {
  await vm.close().catch(() => {});
  try {
    execFileSync("pkill", ["-f", "qemu-system"], { stdio: "ignore" });
  } catch {
    // none left
  }
}

console.log(failures === 0 ? "linux smoke: all checks passed" : `linux smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
