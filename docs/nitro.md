# AWS Nitro Sandboxes

On an EC2 instance, Gondolin can run each VM as an
[AWS Nitro Sandbox](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nitro-sandboxes.html):
a lightweight VM that the Nitro System runs next to the instance and isolates
from it, launched through [Firecracker](https://github.com/firecracker-microvm/firecracker/tree/main/docs/nitro-sandboxes).
This works on ordinary (non-metal) x86_64 and Graviton instance types that
support Nitro Enclaves, with no nested virtualization. Select it with the
`firecracker` backend: on a host set up as below it runs Nitro Sandboxes by
default, even where KVM is available too. `sandbox.nitro` (or
`GONDOLIN_NITRO_MODE`) chooses the settings, and `sandbox.nitro: false` (or
`GONDOLIN_NITRO_MODE=off`) asks for a KVM microVM instead (see
[VM Backends](./backends.md#firecracker)):

```bash
sudo gondolin exec --vmm firecracker -- uname -a
```

```ts
const vm = await VM.create({
  sandbox: { vmm: "firecracker", nitro: { mode: "direct" } },
});
```

Everything above the VM works as on the other backends: exec, the network
policy and HTTP hooks, mounts, SSH and ingress. The differences are listed in
[Limitations](#limitations).

## Parent Instance Setup

On an instance launched as in step 1, `scripts/setup-nitro-host.sh` from a
Gondolin checkout does steps 2 to 4 (pool, a slot budget that survives
reboots, Firecracker and its jailer); after the reboot it asks for,
`scripts/setup-nitro-host.sh --check` reports whether the host is ready. The
steps by hand:

1. Launch an instance type that supports Nitro Enclaves, with Nitro Enclaves
   enabled, from the Amazon Linux 2023 kernel 6.18 AMI (which has the
   parent-side driver from `6.18.51-120.162.amzn2023` on; on Graviton use
   `al2023-ami-kernel-6.18-arm64`):

    ```bash
    aws ec2 run-instances \
      --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.18-x86_64 \
      --instance-type m7i.xlarge \
      --enclave-options Enabled=true \
      ...
    ```

2. Reserve memory for sandboxes on the kernel command line and reboot.
   Sandbox memory, and the per-sandbox slots, come from this pool; without it
   every launch fails with "No space left on device":

    ```bash
    sudo grubby --update-kernel=ALL --args="nitro_enclaves.mempool=8G"
    sudo reboot
    ```

    Size the pool for the VMs you run at once (each needs its full memory,
    1 GiB by default, plus 2 MiB).

3. Raise the slot budget (each running sandbox takes one slot; a fresh parent
   may start with none):

    ```bash
    echo 8 | sudo tee /sys/class/misc/nitro_enclaves/pcie_slots
    ```

    This does not survive a reboot (the setup script installs a systemd unit,
    `gondolin-nitro-slots.service`, that sets it at boot).

    Before starting a sandbox the daemon checks that the pool has room for it
    and otherwise fails with the free and total pool size and what to change;
    a launch that still runs out (for example to a concurrent one) reports the
    same.

4. Install Firecracker 1.18 or newer. From a Gondolin checkout,
   `scripts/install-firecracker.sh` downloads the pinned release, checks its
   SHA256 and installs `firecracker` and `jailer` into `/usr/local/bin`. By
   hand:

    ```bash
    V=v1.18.0 ARCH=$(uname -m)
    curl -fsSL https://github.com/firecracker-microvm/firecracker/releases/download/$V/firecracker-$V-$ARCH.tgz | tar -xz
    sudo install -m 0755 release-$V-$ARCH/firecracker-$V-$ARCH /usr/local/bin/firecracker
    sudo install -m 0755 release-$V-$ARCH/jailer-$V-$ARCH /usr/local/bin/jailer
    ```

    Or point `GONDOLIN_FIRECRACKER` / `sandbox.firecrackerPath` at the binary.
    The daemon checks the version when a VM is configured and refuses older
    releases with an error saying so.

5. Run Gondolin as root. The daemon creates a network namespace and a tap
   device for each VM and runs Firecracker under its jailer (see
   [Isolation](#isolation)), which needs root. Without root, give the daemon
   binary (the static `gondolin` CLI, or `gondolind` for the SDK)
   `CAP_SYS_ADMIN`, `CAP_NET_ADMIN` and `CAP_NET_RAW` and the user access to
   the device; Firecracker then runs unjailed as that user:

    ```bash
    sudo setcap cap_sys_admin,cap_net_admin,cap_net_raw+ep "$(command -v gondolin)"
    sudo chgrp "$(id -gn)" /dev/nitro_enclaves && sudo chmod g+rw /dev/nitro_enclaves
    ```

## Isolation

When the daemon runs as root and finds Firecracker's `jailer` (beside the
`firecracker` binary or on `PATH`; `scripts/install-firecracker.sh` installs
both), each VMM runs jailed, on KVM and on Nitro Sandboxes alike:

- in a chroot under `/srv/jailer/firecracker/gondolin-<daemon pid>-<n>/root`
  holding only the kernel, initrd and root disk (bind-mounted read-only, in a
  mount namespace of the VMM's own), the VM's vsock sockets, its config file
  and the device nodes it needs;
- as an unprivileged uid and gid of its own (`1600000000 + daemon pid`), with
  no capabilities, inside Firecracker's seccomp filter;
- in a cgroup (`/sys/fs/cgroup/gondolin/<id>`) limiting it to the VM's vCPUs
  plus one core, the VM's memory plus 256 MiB (on a Nitro Sandbox, whose
  memory comes from the enclave pool, 512 MiB) and `64 + vCPUs` processes;
- in the network namespace that holds only its tap device.

A guest that escapes into the VMM is then confined to that chroot and user.
A daemon running as root refuses to start a VM when it finds no jailer, since
the VMM would otherwise run as root with the host's whole filesystem and no
limits; `GONDOLIN_JAILER=0` runs it unjailed on purpose.
The image files must be readable by all users (`chmod o+r`; images Gondolin
downloads or builds are). The jail and its cgroup are removed when the VM
exits, and a watchdog process kills the VMM if the daemon dies; jails left by
a daemon that was killed are removed when the next VM starts.

| Variable | Effect |
|---|---|
| `GONDOLIN_JAILER` | jailer binary to use, or `0` to run Firecracker unjailed |
| `GONDOLIN_JAILER_DIR` | chroot base directory (default `/srv/jailer`) |
| `GONDOLIN_JAILER_UID` | first uid/gid; the VMM of daemon process `pid` runs as `uid + pid` (default `1600000000`) |

## Guest Image

The VM boots the image's regular kernel and initramfs through UEFI, so the
kernel must be EFI-bootable (on x86_64 an EFI-stub `bzImage`, on arm64 an EFI
`Image` or compressed EFI zboot image) with ACPI, virtio-pci and the vsock
transport. Alpine's `linux-virt` kernel, which the default images use,
qualifies on both architectures.

Nitro Sandboxes have no virtio-serial device, so the guest helpers connect to
the host over vsock instead (the daemon adds `gondolin.vsock` to the kernel
command line). That needs a guest image built with vsock support (this
release or newer). Such images list `"vsock"` in their manifest's
`features`; the daemon refuses an image whose manifest lacks it before
starting the VM. With explicit asset paths and no manifest beside the kernel
it cannot tell, and a guest that has not connected after 30 s is stopped with
an error.

## Modes

`sandbox.nitro.mode` (`GONDOLIN_NITRO_MODE`):

- `direct` (default): the parent instance can read the VM's memory, as with a
  nested VM. Works with an unpatched guest kernel.
- `confidential`: the Nitro System keeps the VM's memory out of the parent's
  reach. Needs a guest kernel with the DMB virtio patches, and has no entropy
  device. Gondolin's images use Alpine's `linux-virt` kernel, which lacks the
  patches: the guest stalls at its first disk access and the VM is stopped
  after 30 s with an error saying so. With an Amazon Linux 2023 6.18 kernel
  (and its modules) in an otherwise standard image, the backend's test suite
  passes in confidential mode, and a boot takes ~0.15 s longer than in
  `direct` mode. Attesting what the VM runs (`/dev/nsm`, present only in this
  mode) needs the kernel's NSM driver (`nsm`, a module on Amazon Linux) and an
  image whose measurements you know; Gondolin does not load the driver or
  attest anything itself.

`sandbox.nitro.cpuOvercommit` (`GONDOLIN_NITRO_CPU_OVERCOMMIT`, default `true`)
time-shares the VM's vCPUs over the parent's CPUs. With `false`, each vCPU
takes a dedicated core from the Nitro Enclaves CPU pool (and `sandbox.cpus`
must be even on instances with SMT).

The total vCPUs of all sandboxes on an instance can be at most five times the
instance's vCPU count.

## Networking

Firecracker attaches the guest NIC to a tap device. The daemon creates the tap
in a network namespace of its own (no addresses, no routes, nothing else in
it), starts Firecracker inside that namespace and serves the guest's frames to
Gondolin's network stack with a packet socket. Guest traffic can therefore
only leave through the stack and its policy, as on the other backends: the
host kernel has nothing to deliver it to and nowhere to route it. The
namespace and the tap disappear with the VM.

## Boot Time

`exec -- true` takes about 1.05 s on an `m7i.xlarge` with a 1 GiB sandbox.
Most of it is the Nitro System launching the enclave before the guest kernel
starts (~0.6 s plus ~0.14 s per GiB of sandbox memory, which it populates and
zeroes); the guest then reaches its first command in ~0.27 s. Stopping a
sandbox takes ~0.15 s (+~0.07 s per GiB) in the kernel, whichever signal ends
Firecracker. Smaller sandboxes (`sandbox.memory`) start and stop faster:

| `sandbox.memory` | Firecracker start to first guest connection | stop |
| --- | --- | --- |
| 256 MiB | ~0.74 s | ~0.15 s |
| 1 GiB | ~0.89 s | ~0.20 s |
| 4 GiB | ~1.28 s | ~0.41 s |

`GONDOLIN_DEBUG=timing` shows where a boot spends its time.

## Limitations

- No checkpoints (`vm.checkpoint()`), no idle pause.
- Mounts use sandboxfs over vsock: Nitro Sandboxes have no virtio-fs device.
- Boot goes through UEFI firmware, which adds about 0.4 s compared with QEMU
  or krun.
- The Nitro debug console (the guest's serial output, shown with
  `GONDOLIN_DEBUG=protocol`) is off unless `sandbox.console` is `"stdio"` or
  protocol debugging is on (in confidential mode it disables attestation).
  The guest boots `quiet` in that case, as on QEMU (see
  [Boot log](./debug.md#boot-log)).
