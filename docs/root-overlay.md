# Overlay root filesystem (overlayfs)

Gondolin can boot the guest with an overlayfs root.

When enabled, the base root filesystem image is mounted read-only and all guest
writes go to a separate writable upper layer (by default a tmpfs).

This is useful for:

- Keeping the base rootfs image pristine
- Making VM runs more reproducible
- Capturing all guest writes as an artifact by archiving the upper layer

## Enabling It

Enable a tmpfs-backed overlay by setting `sandbox.rootOverlay`:

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  sandbox: {
    rootOverlay: true,
  },
});

// ...
await vm.close();
```

You can also enable it via an environment variable (useful for tools that do not
expose sandbox options directly):

```bash
export GONDOLIN_ROOT_OVERLAY=1
```

The CLI inherits the environment variable behavior:

```bash
GONDOLIN_ROOT_OVERLAY=1 gondolin bash
```

## Kernel Command Line Parameters

Overlay root support is implemented in the initramfs init script.

The following kernel cmdline parameters are recognized:

- `root.overlay=tmpfs`: Use tmpfs as the backing filesystem for the overlay upper layer
- `root.overlaysize=256M`: Optional tmpfs size limit (passed as `size=...` to the tmpfs mount)
- `root.overlay=/dev/vdb`: Treat the value as a block device path to mount as the overlay upper layer
- `root.overlayfstype=ext4`: Filesystem type to use when mounting a block device upper layer

**Note:**  The built-in `sandbox.rootOverlay` option only enables
`root.overlay=tmpfs`.  If you want a block device upper layer, you must attach a
writable block device in QEMU and add the corresponding kernel cmdline
parameters.

## Where The Overlay Data is Mounted

When overlay root is enabled, the initramfs mounts:

- The base rootfs at `/.overlayfs/lower` (read-only)
- The upper backing filesystem at `/.overlayfs/upperfs`

  - Upper directory at `/.overlayfs/upperfs/upper`
  - Work directory at `/.overlayfs/upperfs/work`

The live root filesystem (`/`) is then an overlay mount composed from:

- `lowerdir=/.overlayfs/lower`
- `upperdir=/.overlayfs/upperfs/upper`
- `workdir=/.overlayfs/upperfs/work`

## Capturing Guest Writes

If you want to snapshot everything the guest wrote during a run, archive the
upper directory.

Example with a host mount at `/workspace`:

```bash
tar -C /.overlayfs/upperfs/upper -cf /workspace/root-overlay.tar .
```

If the upper layer is tmpfs-backed, it is lost when the VM shuts down, so make
sure you export it before stopping the VM.
