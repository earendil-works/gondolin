# Images

Every VM boots from an **image**: a Linux kernel, an initramfs and a root
filesystem. Gondolin downloads its default image (`alpine-base:latest`) on
first use. You can pin a version, switch to an image you
[built yourself](./custom-images.md), and list, tag and remove the images in
your local store.

From the CLI:

```bash
# Use a pinned version of the default image
gondolin bash --image alpine-base:0.4.0

# Download an image ahead of time and list what is installed
gondolin image pull alpine-base:latest
gondolin image ls
```

From the SDK:

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  sandbox: { imagePath: "alpine-base:0.4.0" },
});
```

## What an Image Is

An image is a directory of guest assets:

```
manifest.json        # build metadata, checksums, build id
vmlinuz-virt         # kernel (qemu)
initramfs.cpio.lz4   # initramfs
rootfs.ext4          # root filesystem
krun-kernel          # kernel for the krun backend
krun-empty-initrd    # initrd for the krun backend
```

`manifest.json` records the build configuration (including the target
`arch`), the asset file names, their SHA-256 checksums, optional runtime
defaults (such as the default [root disk mode](./snapshots.md#root-disk-modes))
and the **build id**: a UUID derived from the checksums and the architecture.
The same content always has the same build id, so it identifies an image
independently of where it is stored. The image store,
[checkpoints](./snapshots.md#disk-checkpoints) and remote daemons all refer to
images by build id.

The krun assets are optional: images without them only run on the `qemu`
[backend](./backends.md), and the default backend selection picks QEMU for
them. A directory without `manifest.json` still boots when it uses the
default file names, but has no build id, so it cannot be imported into the
store or checkpointed. Images built with `gondolin build` have both.

## Selecting an Image

`--image` (CLI) and `sandbox.imagePath` (SDK) accept an image selector:

| Selector | Example | Meaning |
|---|---|---|
| directory | `./my-assets` | an image directory (relative to the current directory); tried first |
| build id | `9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359` | an image in the local store, downloaded from the registry if it lists that build |
| `name:tag` | `alpine-base:latest`, `tooling:dev` | a ref in the local store, else in the registry; the tag defaults to `latest` |

The SDK also accepts explicit asset paths:

```ts
const vm = await VM.create({
  sandbox: {
    imagePath: {
      kernelPath: "/images/a/vmlinuz-virt",
      initrdPath: "/images/a/initramfs.cpio.lz4",
      rootfsPath: "/images/a/rootfs.ext4",
    },
  },
});
```

Explicit paths skip the manifest, so the default backend is QEMU (no krun
assets) and checkpoints need the three files in one directory with its
`manifest.json`.

Without a selector, Gondolin uses, in order:

1. `GONDOLIN_GUEST_DIR`, an image directory
2. a development checkout's `guest/image/out` (searched upwards from the
   current directory and from the installed package)
3. `GONDOLIN_DEFAULT_IMAGE` (a selector, default `alpine-base:latest`),
   downloaded if needed

An explicit `--image` or `sandbox.imagePath` wins over all of them.

With a [remote daemon](./remote.md), the daemon resolves and downloads images
from its own store: the selector must be a string (`name:tag`, a build id, or
a directory on the daemon's machine), set with `sandbox.imagePath` or
`native.image`.

## The Builtin Registry

Gondolin's published images are listed in a registry file,
[`builtin-image-registry.json`](https://github.com/earendil-works/gondolin/blob/main/builtin-image-registry.json):

```json
{
  "schema": 1,
  "refs": {
    "alpine-base:latest": {
      "aarch64": "9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359",
      "x86_64": "f59d9a69-1f62-57e0-a392-6800d3dd021d"
    }
  },
  "builds": {
    "9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359": {
      "arch": "aarch64",
      "url": "https://github.com/earendil-works/gondolin/releases/download/...tar.gz",
      "sha256": "..."
    }
  }
}
```

`refs` maps each `name:tag` to one build id per architecture; `builds` maps
build ids to a downloadable `.tar.gz` (with the image files at its root), an
optional `sha256` and an optional `arch`. Relative `url`s resolve against the
registry's URL. Image releases are separate from package releases: new
`alpine-base` versions show up in the registry without a Gondolin update.

When a selector is not in the local store, Gondolin fetches the registry,
downloads the archive, verifies its checksum, architecture and build id,
imports it into the store and, for a `name:tag` selector, creates the local
ref. Build ids are only downloaded when the registry lists them under
`builds`. The registry document is cached in the store
(`builtin-image-registry-cache.json`) and revalidated with its ETag; when the
registry is unreachable, the cached copy is used.

`GONDOLIN_IMAGE_REGISTRY_URL` points Gondolin at another registry with the
same format, for example to serve your own images to a team.

## The Local Image Store

Images live in `~/.cache/gondolin/images` (`$XDG_CACHE_HOME/gondolin/images`
when `XDG_CACHE_HOME` is set, or `GONDOLIN_IMAGE_STORE`):

```
objects/<build-id>/            # one image directory per build id
refs/<name>/<tag>/<arch>       # symlinks to objects
builtin-image-registry-cache.json
```

The Node CLI, the SDK, the static `gondolin` CLI and the daemon share this
layout.

### Managing Images

```bash
gondolin image ls                                # refs, and objects without tags as <untagged>
gondolin image pull alpine-base:0.4.0            # make a selector available locally
gondolin image inspect alpine-base:latest        # show source, directory, build id, arch
gondolin image import ./my-assets --tag tooling:dev
gondolin image tag tooling:dev tooling:stable    # create or move a ref
gondolin image rm tooling:dev                    # remove a ref
gondolin image rm <build-id> --force             # remove an object and its refs
gondolin image rm --untagged                     # remove every untagged object
gondolin image rm --all                          # clear the store
```

- `pull` and `inspect` download from the registry when the selector is not
  local; both take `--arch aarch64|x86_64` (so does `tag`)
- `import` copies an image directory into the store (it needs a
  `manifest.json` with a build id); `gondolin build` imports every build
  automatically and takes `--tag` too
- removing a ref also deletes its object when no other ref points to it;
  removing a build id that refs still point to needs `--force`, which removes
  those refs as well
- every removal asks for confirmation unless `--yes` (`-y`) is passed

The static `gondolin` CLI has the same `image` commands; building images
needs the Node CLI. See the [CLI Reference](./cli.md#gondolin-image) for all
options.

### Updating an Image

A ref that exists locally is used as is: `alpine-base:latest` keeps pointing
at the build that was downloaded first, even after the registry moved the
tag. `gondolin image pull` does not refresh it either. To pick up a new
release, remove the local ref and pull again (or pin versioned tags, which do
not move):

```bash
gondolin image rm alpine-base:latest
gondolin image pull alpine-base:latest
```

Old objects stay in the store while refs or your
[checkpoints](./snapshots.md#portability-and-guest-assets) need them; clean
up with `gondolin image rm --untagged` once they do not.

## Architecture

Images are built for one architecture, `aarch64` or `x86_64`. A ref holds one
build per architecture, and resolving it picks the host's architecture; when
the ref has only one, that one is used. `--arch` (CLI) or the `arch` argument
(SDK) selects another one explicitly.

An image of the host's architecture runs with hardware acceleration. A
foreign-architecture image only runs on QEMU, with the matching
`qemu-system-*` binary and software emulation (much slower); krun requires
the host's architecture, so the default backend selection picks QEMU for
such images. A `sandbox.qemuPath` for another architecture than the image
fails with an architecture mismatch error. See
[VM Backends](./backends.md#architecture-and-kernel-constraints).

## SDK Functions

All exported from `@earendil-works/gondolin`:

| Function | Purpose |
|---|---|
| `ensureImageSelector(selector, arch?)` | resolve a selector, downloading from the registry when needed; returns a `ResolvedImage` |
| `resolveImageSelector(selector, arch?)` | resolve a selector from local sources only (throws when missing) |
| `importImageFromDirectory(dir)` | import an image directory; returns `{ buildId, arch, assetDir, created }` |
| `setImageRef(ref, buildId, arch)` | point `ref` at an imported build for `arch` |
| `tagImage(source, target, arch?)` | point `target` at whatever `source` resolves to |
| `listImageRefs()` | local refs: `{ reference, targets: { aarch64?, x86_64? }, updatedAt }` |
| `removeImage(selector, { force })` | remove a ref or build id (as `gondolin image rm`) |
| `getImageStoreDirectory()`, `getImageObjectDirectory(buildId)` | store paths |
| `ensureGuestAssets()` | resolve the default image (see [Selecting an Image](#selecting-an-image)), downloading if needed; returns `{ kernelPath, initrdPath, rootfsPath }` |
| `hasGuestAssets()` | whether the default image is available without downloading |
| `getAssetDirectory()` | directory of the default image when available locally, else the store root |
| `loadGuestAssets(dir)` | asset paths of an image directory (throws when files are missing) |
| `loadAssetManifest(dir)` | the parsed `manifest.json`, or `null` |

`ResolvedImage` has `source` (`"path"`, `"build-id"` or `"ref"`), `selector`
(the canonical form), `assetDir`, and `buildId` and `arch` when known.

```ts
import {
  ensureImageSelector,
  importImageFromDirectory,
  setImageRef,
  VM,
} from "@earendil-works/gondolin";

// make sure an image is available (e.g. in a setup step)
const image = await ensureImageSelector("alpine-base:0.4.0");
console.log(image.buildId, image.assetDir);

// register a local build under a name
const imported = importImageFromDirectory("./my-assets");
setImageRef("tooling:dev", imported.buildId, imported.arch);

const vm = await VM.create({ sandbox: { imagePath: "tooling:dev" } });
```

## Gotchas

- **First start downloads.** The default image is about 200 MB. `VM.create()`
  and the CLI download it on first use (with a progress line on a terminal);
  run `gondolin image pull` or `ensureImageSelector()` in setup steps or CI
  caches to avoid paying for it later. `new VM()` without `VM.create()` does
  not download.
- **A checkout's images win.** Inside a Gondolin source checkout, a built
  `guest/image/out` is used instead of the default image unless you select one
  explicitly.
- **No proxy support in the daemon.** Downloads by the daemon (remote daemons,
  the static CLI) do not honour `HTTP_PROXY`/`HTTPS_PROXY`.
- **Removing an image breaks its checkpoints** until it is pulled or imported
  again (by the same build id).
