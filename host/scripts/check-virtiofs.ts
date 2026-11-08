/**
 * CI check: a native-engine VM mounts the VFS over virtio-fs (needs a QEMU
 * with vhost-user-fs, e.g. Linux distribution builds). Exits non-zero when
 * the guest fell back to sandboxfs.
 *
 * Usage: node scripts/check-virtiofs.ts
 */

import { VM } from "../src/index.ts";
import { MemoryProvider } from "../src/vfs/node/index.ts";

const vm = await VM.create({
  sandbox: { console: "none" },
  vfs: { mounts: { "/": new MemoryProvider() } },
});
try {
  const r = await vm.exec(["/bin/sh", "-c", "grep ' /data ' /proc/mounts"]);
  console.log(r.stdout.trim());
  if (!/ \/data virtiofs /.test(r.stdout)) {
    console.error("expected /data to be mounted over virtio-fs");
    process.exitCode = 1;
  }
} finally {
  await vm.close();
}
