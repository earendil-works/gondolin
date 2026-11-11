# AWS Nitro Sandboxes

On an EC2 instance, Gondolin can run each VM as an
[AWS Nitro Sandbox](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nitro-sandboxes.html):
a lightweight VM that the Nitro System runs next to the instance and isolates
from it, launched through [Firecracker](https://github.com/firecracker-microvm/firecracker/tree/main/docs/nitro-sandboxes).
This works on ordinary (non-metal) x86_64 and Graviton instance types that
support Nitro Enclaves, with no nested virtualization. Select it with the
`firecracker` backend; on a host without a usable `/dev/kvm` it runs Nitro
Sandboxes by default, and `sandbox.nitro` (or `GONDOLIN_NITRO_MODE`) asks for
one explicitly (on hosts that also have KVM, it otherwise runs a KVM microVM,
see [VM Backends](./backends.md#firecracker)):

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

    This does not survive a reboot.

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
   device for each VM and opens `/dev/nitro_enclaves`, which needs
   `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, `CAP_NET_RAW` and access to the device.
   Without root, give the daemon binary (the static `gondolin` CLI, or
   `gondolind` for the SDK) these capabilities and the user access to the
   device; Firecracker itself needs no capabilities:

    ```bash
    sudo setcap cap_sys_admin,cap_net_admin,cap_net_raw+ep "$(command -v gondolin)"
    sudo chgrp "$(id -gn)" /dev/nitro_enclaves && sudo chmod g+rw /dev/nitro_enclaves
    ```

## Guest Image

The VM boots the image's regular kernel and initramfs through UEFI, so the
kernel must be EFI-bootable (on x86_64 an EFI-stub `bzImage`, on arm64 an EFI
`Image` or compressed EFI zboot image) with ACPI, virtio-pci and the vsock
transport. Alpine's `linux-virt` kernel, which the default images use,
qualifies on both architectures.

Nitro Sandboxes have no virtio-serial device, so the guest helpers connect to
the host over vsock instead (the daemon adds `gondolin.vsock` to the kernel
command line). That needs a guest image built with vsock support (this
release or newer); older images wait for virtio-serial ports that never
appear.

## Modes

`sandbox.nitro.mode` (`GONDOLIN_NITRO_MODE`):

- `direct` (default): the parent instance can read the VM's memory, as with a
  nested VM. Works with an unpatched guest kernel.
- `confidential`: the Nitro System keeps the VM's memory out of the parent's
  reach. Needs a guest kernel with the DMB virtio patches (the Amazon Linux
  2023 6.18 kernels and Firecracker's CI kernels have them; Alpine's does not),
  and has no entropy device. Attesting what the VM runs (`/dev/nsm`) also needs
  the kernel's NSM driver (`CONFIG_NSM=y`) and an image whose measurements you
  know.

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
  Without it the kernel command line also gets `quiet` (unless it already sets
  a log level): the boot log to the emulated UART costs about 0.45 s per boot.
