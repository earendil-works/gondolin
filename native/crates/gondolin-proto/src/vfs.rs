//! VFS messages of the controller protocol (`native/DESIGN.md`, "VFS").
//!
//! - `configure.vfs`: [`VfsConfig`], the mount table and fuse layout
//! - d→c `vfs_call` / c→d `vfs_call_result`: object-tier operations
//!   ([`VfsCall`] / [`VfsCallResult`])
//! - d→c `vfs_hook` / c→d `vfs_hook_result`: blocking `before` hook
//!   ([`HookContext`] / [`OkResult`]), only when `hooks.before` is set
//! - d→c `vfs_event`: asynchronous `after` notification ([`VfsEvent`])
//! - c→d `vfs_invalidate` / d→c `vfs_invalidate_result` ([`VfsInvalidate`])
//! - c→d `fs_call` / d→c `fs_call_result`: controller fs API on the daemon's
//!   mount table ([`FsCall`] / [`FsCallResult`])
//!
//! Paths are absolute POSIX paths. Object-tier paths are relative to the
//! mount; `fs_call` and hook paths are relative to the root of the sandboxfs
//! tree (the guest sees them below `fuse_mount`). Errors are Linux errno names
//! (`ENOENT`, `EACCES`, ...).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;

/// Message type names.
pub mod types {
    pub const VFS_CALL: &str = "vfs_call";
    pub const VFS_CALL_RESULT: &str = "vfs_call_result";
    pub const VFS_HOOK: &str = "vfs_hook";
    pub const VFS_HOOK_RESULT: &str = "vfs_hook_result";
    pub const VFS_EVENT: &str = "vfs_event";
    pub const VFS_INVALIDATE: &str = "vfs_invalidate";
    pub const VFS_INVALIDATE_RESULT: &str = "vfs_invalidate_result";
    pub const FS_CALL: &str = "fs_call";
    pub const FS_CALL_RESULT: &str = "fs_call_result";
}

fn default_true() -> bool {
    true
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// `configure.vfs`: the sandboxfs tree served on the guest's `virtio-fs` port.
///
/// The guest mounts the tree at `fuse_mount` and bind-mounts
/// `<fuse_mount><bind>` onto `<bind>` for every entry of `binds` (answer of
/// the guest's `mounts` request).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VfsConfig {
    /// guest mount point of the sandboxfs filesystem (normally `/data`)
    pub fuse_mount: String,
    /// guest paths bind-mounted out of the sandboxfs tree
    #[serde(default)]
    pub binds: Vec<String>,
    /// mount table, routed by longest prefix
    pub mounts: Vec<MountConfig>,
    /// controller callbacks requested by the controller
    #[serde(default)]
    pub hooks: VfsHookConfig,
    /// how the guest reaches the tree
    #[serde(default)]
    pub transport: VfsTransport,
}

/// Guest transport of the sandboxfs tree.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VfsTransport {
    /// virtio-fs when the VMM supports it, else the sandboxfs RPC
    #[default]
    Auto,
    /// always the sandboxfs RPC (FUSE in the guest over virtio-serial)
    Sandboxfs,
    /// virtio-fs (vhost-user-fs); falls back to sandboxfs with a warning
    Virtiofs,
}

/// Which controller callbacks the daemon issues.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VfsHookConfig {
    /// send a blocking `vfs_hook` before every hooked operation
    #[serde(default, skip_serializing_if = "is_false")]
    pub before: bool,
    /// send `vfs_event` after every hooked operation
    #[serde(default, skip_serializing_if = "is_false")]
    pub events: bool,
}

/// One mount of the table.
///
/// Wrappers apply in this order: the source, then `layers` (innermost first),
/// then `readonly` (outermost).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MountConfig {
    /// mount point inside the sandboxfs tree (`/` for the root)
    pub path: String,
    /// what backs the mount
    #[serde(flatten)]
    pub source: MountSource,
    /// reject every mutation with `EROFS`
    #[serde(default, skip_serializing_if = "is_false")]
    pub readonly: bool,
    /// wrappers around the source, innermost first
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<MountLayer>,
}

/// The backing of a mount, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MountSource {
    /// hardened passthrough to a directory on the daemon's machine
    Host {
        /// host directory (absolute path on the daemon's machine)
        root: String,
    },
    /// in-daemon memory filesystem
    Memory {},
    /// read-only synthetic files
    Static {
        /// file contents keyed by mount-relative path (parents are implied)
        files: BTreeMap<String, ByteBuf>,
    },
    /// whole-file provider in the controller with a native cache
    Object(ObjectMountConfig),
}

/// Object-tier mount options.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ObjectMountConfig {
    /// id used in `vfs_call` / `vfs_invalidate`
    pub mount_id: u32,
    /// whether mutations are forwarded (otherwise `EROFS`)
    #[serde(default)]
    pub writable: bool,
    /// how directory listings are produced
    #[serde(default)]
    pub enumeration: Enumeration,
    /// when guest writes reach the controller
    #[serde(default)]
    pub commit: CommitMode,
    /// cache options
    #[serde(default)]
    pub cache: ObjectCacheConfig,
    /// largest file the guest may create or grow, in `bytes`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_file_bytes: Option<u64>,
}

/// Directory listing behaviour of an object mount.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Enumeration {
    /// `readdir` is forwarded
    #[default]
    List,
    /// listings only show entries the daemon has seen (looked up or created)
    Materialized,
    /// listings are always empty
    None,
}

/// When dirty file contents are sent to the controller.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitMode {
    /// whole file (`write_file`) when a dirty handle is released
    #[default]
    Close,
    /// every write/truncate is forwarded before the guest gets its reply
    Write,
}

/// Object cache options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectCacheConfig {
    /// how long stats, listings and clean contents stay valid, in `ms` (0 = revalidate on every lookup/open)
    #[serde(default = "default_ttl_ms")]
    pub ttl_ms: u64,
    /// budget for clean cached contents, in `bytes`
    #[serde(default = "default_max_bytes")]
    pub max_bytes: u64,
    /// re-stat on every open of a closed file and drop cached contents whose size or mtime changed
    #[serde(default, skip_serializing_if = "is_false")]
    pub revalidate_open: bool,
    /// files up to this size in `bytes` are fetched with their stat (one round trip; 0 = off)
    #[serde(default, skip_serializing_if = "is_zero")]
    pub inline_max_bytes: u64,
}

fn is_zero(v: &u64) -> bool {
    *v == 0
}

fn default_ttl_ms() -> u64 {
    1000
}

fn default_max_bytes() -> u64 {
    256 * 1024 * 1024
}

impl Default for ObjectCacheConfig {
    fn default() -> Self {
        ObjectCacheConfig {
            ttl_ms: default_ttl_ms(),
            max_bytes: default_max_bytes(),
            revalidate_open: false,
            inline_max_bytes: 0,
        }
    }
}

/// A wrapper around a mount source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MountLayer {
    /// `ReadonlyProvider`
    Readonly {},
    /// `ShadowProvider` with a `createShadowPathPredicate` predicate
    Hide(HideConfig),
}

/// Hidden paths (`ShadowProvider` semantics): reads behave as `ENOENT`,
/// listings omit the entries, writes are denied or go to a memory upper layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HideConfig {
    /// mount-relative paths; a path hides itself and everything below it
    pub paths: Vec<String>,
    /// behaviour of writes to hidden paths
    #[serde(default)]
    pub write_mode: HideWriteMode,
    /// errno name for denied writes (default `EACCES`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deny_write_errno: Option<String>,
    /// also hide paths whose resolved (symlink-free) path is hidden
    #[serde(default = "default_true")]
    pub deny_symlink_bypass: bool,
}

/// `ShadowProvider` `writeMode`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HideWriteMode {
    #[default]
    Deny,
    Tmpfs,
}

/// Kind of a filesystem entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

/// Metadata reported by an object-tier provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectStat {
    /// entry kind
    pub kind: EntryKind,
    /// file size in `bytes`
    #[serde(default)]
    pub size: u64,
    /// permission bits (`0o7777` mask; type bits are ignored)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    /// modification time in `ms` since the unix epoch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<i64>,
    /// status change time in `ms` since the unix epoch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctime_ms: Option<i64>,
    /// access time in `ms` since the unix epoch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atime_ms: Option<i64>,
    /// hard link count
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nlink: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gid: Option<u32>,
}

/// One directory entry from an object-tier provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectDirEntry {
    pub name: String,
    pub kind: EntryKind,
}

/// d→c `vfs_call` payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VfsCall {
    /// object mount the call is for
    pub mount_id: u32,
    #[serde(flatten)]
    pub op: VfsOp,
}

/// Object-tier operations. Paths are relative to the mount.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum VfsOp {
    /// metadata without following a final symlink; with `inline_max`, files
    /// of at most that many `bytes` come back with their contents in `data`
    Stat {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        inline_max: Option<u64>,
    },
    Readdir {
        path: String,
    },
    /// `length` bytes at `offset` (absent: to the end); short only at EOF
    ReadFile {
        path: String,
        #[serde(default)]
        offset: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        length: Option<u64>,
    },
    /// whole-file write, sent as consecutive chunks; `offset` 0 starts a new
    /// file content, the chunk with `last` commits it
    WriteFile {
        path: String,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
        #[serde(default)]
        offset: u64,
        #[serde(default = "default_true")]
        last: bool,
        /// permission bits for a newly created file
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<u32>,
    },
    /// positional write into an existing file (`commit: "write"` mounts)
    Write {
        path: String,
        offset: u64,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
    Truncate {
        path: String,
        size: u64,
    },
    Unlink {
        path: String,
    },
    Rename {
        from: String,
        to: String,
    },
    Mkdir {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<u32>,
    },
    Rmdir {
        path: String,
    },
    Chmod {
        path: String,
        mode: u32,
    },
    Symlink {
        target: String,
        path: String,
    },
    Readlink {
        path: String,
    },
    /// hard link `to` → `from`
    Link {
        from: String,
        to: String,
    },
}

/// c→d `vfs_call_result` payload (`ok: false` carries `code` and `message`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VfsCallResult {
    pub ok: bool,
    /// errno name when `ok` is false
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// `stat`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stat: Option<ObjectStat>,
    /// `readdir`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<ObjectDirEntry>>,
    /// `read_file`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<ByteBuf>,
    /// `readlink`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// d→c `vfs_hook` payload and the body of `vfs_event`; mirrors the node
/// engine's `VfsHookContext` (`host/src/vfs/provider.ts`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookContext {
    /// operation name (`open`, `read`, `write`, `release`, `lstat`, `mkdir`, ...)
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// source of `rename`/`link`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// destination of `rename`/`link`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    /// node-style open flags (`r`, `r+`, `w`, `w+`, `a`, `a+`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<String>,
    /// mode bits
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    /// file offset in `bytes` (absent for appends)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    /// length in `bytes`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
    /// size in `bytes` (`truncate`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// d→c `vfs_event` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VfsEvent {
    #[serde(flatten)]
    pub ctx: HookContext,
    /// errno name when the operation failed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// bytes transferred (`read`/`write`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

/// Generic `{ ok, code?, message? }` result (`vfs_hook_result`,
/// `vfs_invalidate_result`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OkResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// c→d `vfs_invalidate` payload: drop cached state of an object mount.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VfsInvalidate {
    pub mount_id: u32,
    /// mount-relative path; the path and everything below it (absent: whole mount)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// c→d `fs_call` payload: an operation on the daemon's mount table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FsCall {
    /// `follow` false behaves like `lstat`
    Stat {
        path: String,
        #[serde(default = "default_true")]
        follow: bool,
    },
    Readdir {
        path: String,
    },
    Access {
        path: String,
        #[serde(default)]
        mask: u32,
    },
    Mkdir {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<u32>,
        #[serde(default)]
        recursive: bool,
    },
    Rmdir {
        path: String,
    },
    Unlink {
        path: String,
    },
    Rename {
        from: String,
        to: String,
    },
    Chmod {
        path: String,
        mode: u32,
    },
    Truncate {
        path: String,
        size: u64,
    },
    Readlink {
        path: String,
    },
    Symlink {
        target: String,
        path: String,
    },
    Realpath {
        path: String,
    },
    /// open a handle; `flags` are node-style (`r`, `r+`, `w`, `w+`, `a`, `a+`)
    Open {
        path: String,
        flags: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<u32>,
    },
    /// read up to `length` bytes at `offset`
    Read {
        fh: u64,
        offset: u64,
        length: u64,
    },
    /// write at `offset` (ignored for append handles)
    Write {
        fh: u64,
        offset: u64,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
    /// close a handle; commit errors of object mounts are reported here
    Close {
        fh: u64,
    },
}

/// Metadata returned by `fs_call` (`node:fs` `Stats` fields).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsStat {
    /// `st_mode` including the file type bits
    pub mode: u32,
    pub size: u64,
    pub nlink: u32,
    pub uid: u32,
    pub gid: u32,
    /// times in `ms` since the unix epoch
    pub atime_ms: i64,
    pub mtime_ms: i64,
    pub ctime_ms: i64,
}

/// d→c `fs_call_result` payload.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FsCallResult {
    pub ok: bool,
    /// errno name when `ok` is false
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stat: Option<FsStat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<ObjectDirEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<ByteBuf>,
    /// `readlink` target / `realpath` result
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// `open`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fh: Option<u64>,
    /// bytes written (`write`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use gondolin_wire::{decode, encode};

    #[test]
    fn mount_config_round_trip() {
        let cfg = VfsConfig {
            fuse_mount: "/data".into(),
            binds: vec!["/etc/gondolin/mitm".into()],
            mounts: vec![
                MountConfig {
                    path: "/".into(),
                    source: MountSource::Host { root: "/tmp/x".into() },
                    readonly: true,
                    layers: vec![MountLayer::Hide(HideConfig {
                        paths: vec!["/.env".into()],
                        write_mode: HideWriteMode::Tmpfs,
                        deny_write_errno: None,
                        deny_symlink_bypass: true,
                    })],
                },
                MountConfig {
                    path: "/etc/gondolin/mitm".into(),
                    source: MountSource::Static {
                        files: [("/ca.crt".to_string(), ByteBuf::from(b"pem".to_vec()))].into(),
                    },
                    readonly: false,
                    layers: vec![],
                },
                MountConfig {
                    path: "/obj".into(),
                    source: MountSource::Object(ObjectMountConfig {
                        mount_id: 3,
                        writable: true,
                        enumeration: Enumeration::Materialized,
                        commit: CommitMode::Write,
                        cache: ObjectCacheConfig {
                            ttl_ms: 0,
                            max_bytes: 1 << 40,
                            revalidate_open: true,
                            inline_max_bytes: 0,
                        },
                        max_file_bytes: Some(1 << 33),
                    }),
                    readonly: false,
                    layers: vec![],
                },
            ],
            hooks: VfsHookConfig { before: false, events: true },
            transport: VfsTransport::Virtiofs,
        };
        let bytes = encode(&cfg).unwrap();
        let back: VfsConfig = decode(&bytes).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn calls_are_flat_maps() {
        let call = VfsCall {
            mount_id: 1,
            op: VfsOp::WriteFile {
                path: "/a".into(),
                data: vec![1, 2],
                offset: 0,
                last: true,
                mode: None,
            },
        };
        let value = gondolin_wire::to_value(&call).unwrap();
        let map = value.as_map().unwrap();
        let keys: Vec<_> = map.iter().map(|(k, _)| k.as_text().unwrap().to_string()).collect();
        assert!(keys.contains(&"op".to_string()));
        assert!(keys.contains(&"mount_id".to_string()));
        let back: VfsCall = decode(&encode(&call).unwrap()).unwrap();
        assert_eq!(back, call);

        let fs: FsCall =
            decode(&encode(&FsCall::Stat { path: "/x".into(), follow: false }).unwrap()).unwrap();
        assert_eq!(fs, FsCall::Stat { path: "/x".into(), follow: false });
    }
}
