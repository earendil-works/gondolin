/**
 * CI check: a VM on the firecracker backend boots the way production runs it.
 * Exits non-zero unless
 *
 * - the guest reached the host over vsock with its root on the overlay and
 *   the VFS mounted over sandboxfs, and
 * - the Firecracker process runs jailed: not as root, chrooted, in a cgroup
 *   under `gondolin/` (set GONDOLIN_CHECK_JAILER=0 to skip, e.g. without root).
 *
 * Usage: GONDOLIN_VMM=firecracker node scripts/check-firecracker.ts
 */

import fs from "node:fs";

import { VM } from "../src/index.ts";
import { MemoryProvider } from "../src/vfs/node/index.ts";

const failures: string[] = [];
const vm = await VM.create({
  sandbox: { vmm: "firecracker", console: "none" },
  vfs: { mounts: { "/": new MemoryProvider() } },
});
try {
  const r = await vm.exec([
    "/bin/sh",
    "-c",
    "grep -E ' / | /data ' /proc/mounts; grep -o gondolin.vsock /proc/cmdline",
  ]);
  console.log(r.stdout.trim());
  if (!/^overlay \/ overlay /m.test(r.stdout)) {
    failures.push("expected the root filesystem on the guest overlay");
  }
  if (!/ \/data fuse\.sandboxfs /.test(r.stdout)) {
    failures.push("expected /data to be mounted over sandboxfs");
  }
  if (!/gondolin\.vsock/.test(r.stdout)) {
    failures.push("expected the guest channels on vsock");
  }

  if (process.env.GONDOLIN_CHECK_JAILER !== "0") {
    const pid = vm.getHostPid();
    if (!pid) {
      failures.push("no Firecracker process");
    } else {
      // owned by the jail's user: readable without privileges
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
      const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      console.log(`firecracker pid ${pid}: uid ${uid}, cgroup ${cgroup}`);
      if (uid === 0) failures.push("Firecracker runs as root (not jailed)");
      if (!/^0::\/gondolin\/gondolin-\d+-\d+$/.test(cgroup)) {
        failures.push(`Firecracker is not in a gondolin cgroup: ${cgroup}`);
      }
      // the jailer execs Firecracker as /firecracker inside the chroot
      if (!cmdline.startsWith("/firecracker\0")) {
        failures.push("Firecracker was not started by the jailer");
      }
    }
  }
} finally {
  await vm.close();
}

for (const failure of failures) console.error(failure);
if (failures.length > 0) process.exitCode = 1;
