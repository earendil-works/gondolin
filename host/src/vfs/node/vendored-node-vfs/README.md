# Node VFS (vendored)

This directory contains the `node:vfs` implementation and documentation vendored
from upstream Node.js pull request #61478 for reference while the API is still
pre-release.

Source:
- Repository: https://github.com/nodejs/node
- Branch: pull/61478 (`pr-61478` local checkout)
- Commit: 164ba613e6130916ba7d21f9ef68486c3efb52ea

Files included:
- `lib/vfs.js`
- `lib/internal/vfs/**`
- `doc/api/vfs.md`

## GONDOLIN_VENDORED_NODE_VFS_PATCH

The following changes are Gondolin-specific and intentionally marked so they can
be discovered/re-applied during upstream syncs.

Detection hints:
- `rg "GONDOLIN_VENDORED_NODE_VFS_PATCH" src/vfs/node/vendored-node-vfs`
- `rg "XXX\(patch\):" src/vfs/node/vendored-node-vfs`

Local Gondolin patches:
- `lib/internal/vfs/providers/real.js` is intentionally kept with Gondolin hardening/extensions (`link`, `statfs`, symlink escape protection, canonical root handling)
- `lib/internal/vfs/providers/memory.js` adds in-memory hard-link support used by host fs-rpc/FUSE paths
- `lib/internal/vfs/file_handle.js` keeps `MemoryFileHandle` content in sync with its entry so truncates through the path or other handles are not undone by later writes
- `lib/internal/vfs/stats.js` preserves provider-reported `nlink` for virtual file stats
- `lib/internal/vfs/gondolin-shim.js` provides userland shims for `primordials`, `internalBinding`, and `internal/*` requires
- Every vendored runtime file has a small top-of-file shim block marked with `GONDOLIN_VENDORED_NODE_VFS_PATCH`
- Custom logic changes remain marked inline with `XXX(patch): ...`
