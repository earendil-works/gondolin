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

gondolin_wire::wire_struct! {
    /// `configure.vfs`: the sandboxfs tree served on the guest's `virtio-fs` port.
    ///
    /// The guest mounts the tree at `fuse_mount` and bind-mounts
    /// `<fuse_mount><bind>` onto `<bind>` for every entry of `binds` (answer of
    /// the guest's `mounts` request).
    #[derive(Debug, Clone, PartialEq)]
    pub struct VfsConfig {
        /// guest mount point of the sandboxfs filesystem (normally `/data`)
        pub fuse_mount: String,
        /// guest paths bind-mounted out of the sandboxfs tree
        pub binds: Vec<String> = Default::default(),
        /// mount table, routed by longest prefix
        pub mounts: Vec<MountConfig>,
        /// controller callbacks requested by the controller
        pub hooks: VfsHookConfig = Default::default(),
        /// how the guest reaches the tree
        pub transport: VfsTransport = Default::default(),
    }
}

gondolin_wire::wire_enum! {
    /// Guest transport of the sandboxfs tree.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub enum VfsTransport {
        /// virtio-fs when the VMM supports it, else the sandboxfs RPC
        #[default]
        Auto = "auto",
        /// always the sandboxfs RPC (FUSE in the guest over virtio-serial)
        Sandboxfs = "sandboxfs",
        /// virtio-fs (vhost-user-fs); falls back to sandboxfs with a warning
        Virtiofs = "virtiofs",
    }
}

gondolin_wire::wire_struct! {
    /// Which controller callbacks the daemon issues.
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub struct VfsHookConfig {
        /// send a blocking `vfs_hook` before every hooked operation
        pub before: bool = Default::default() => skip_if std::ops::Not::not,
        /// send `vfs_event` after every hooked operation
        pub events: bool = Default::default() => skip_if std::ops::Not::not,
    }
}

gondolin_wire::wire_struct! {
    /// One mount of the table.
    ///
    /// Wrappers apply in this order: the source, then `layers` (innermost first),
    /// then `readonly` (outermost).
    #[derive(Debug, Clone, PartialEq)]
    pub struct MountConfig {
        /// mount point inside the sandboxfs tree (`/` for the root)
        pub path: String,
        /// what backs the mount
        pub source: MountSource => flatten,
        /// reject every mutation with `EROFS`
        pub readonly: bool = Default::default() => skip_if std::ops::Not::not,
        /// wrappers around the source, innermost first
        pub layers: Vec<MountLayer> = Default::default() => skip_if Vec::is_empty,
    }
}

gondolin_wire::wire_tagged! {
    /// The backing of a mount, tagged by `kind`.
    #[derive(Debug, Clone, PartialEq)]
    pub enum MountSource : "kind" {
        /// hardened passthrough to a directory on the daemon's machine
        Host = "host" {
            /// host directory (absolute path on the daemon's machine)
            root: String,
        },
        /// in-daemon memory filesystem
        Memory = "memory" {},
        /// read-only synthetic files
        Static = "static" {
            /// file contents keyed by mount-relative path (parents are implied)
            files: BTreeMap<String, Vec<u8>>,
        },
        /// whole-file provider in the controller with a native cache
        Object = "object" (ObjectMountConfig),
    }
}

gondolin_wire::wire_struct! {
    /// Object-tier mount options.
    #[derive(Debug, Clone, PartialEq)]
    pub struct ObjectMountConfig {
        /// id used in `vfs_call` / `vfs_invalidate`
        pub mount_id: u32,
        /// whether mutations are forwarded (otherwise `EROFS`)
        pub writable: bool = Default::default(),
        /// how directory listings are produced
        pub enumeration: Enumeration = Default::default(),
        /// when guest writes reach the controller
        pub commit: CommitMode = Default::default(),
        /// cache options
        pub cache: ObjectCacheConfig = Default::default(),
        /// largest file the guest may create or grow, in `bytes`
        pub max_file_bytes: Option<u64>,
    }
}

gondolin_wire::wire_enum! {
    /// Directory listing behaviour of an object mount.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub enum Enumeration {
        /// `readdir` is forwarded
        #[default]
        List = "list",
        /// listings only show entries the daemon has seen (looked up or created)
        Materialized = "materialized",
        /// listings are always empty
        None = "none",
    }
}

gondolin_wire::wire_enum! {
    /// When dirty file contents are sent to the controller.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub enum CommitMode {
        /// whole file (`write_file`) when a dirty handle is released
        #[default]
        Close = "close",
        /// every write/truncate is forwarded before the guest gets its reply
        Write = "write",
    }
}

gondolin_wire::wire_struct! {
    /// Object cache options.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ObjectCacheConfig {
        /// how long stats, listings and clean contents stay valid, in `ms` (0 = revalidate on every lookup/open)
        pub ttl_ms: u64 = default_ttl_ms(),
        /// budget for clean cached contents, in `bytes`
        pub max_bytes: u64 = default_max_bytes(),
        /// re-stat on every open of a closed file and drop cached contents whose size or mtime changed
        pub revalidate_open: bool = Default::default() => skip_if std::ops::Not::not,
        /// files up to this size in `bytes` are fetched with their stat (one round trip; 0 = off)
        pub inline_max_bytes: u64 = Default::default() => skip_if is_zero,
    }
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

gondolin_wire::wire_tagged! {
    /// A wrapper around a mount source.
    #[derive(Debug, Clone, PartialEq)]
    pub enum MountLayer : "kind" {
        /// `ReadonlyProvider`
        Readonly = "readonly" {},
        /// `ShadowProvider` with a `createShadowPathPredicate` predicate
        Hide = "hide" (HideConfig),
    }
}

gondolin_wire::wire_struct! {
    /// Hidden paths (`ShadowProvider` semantics): reads behave as `ENOENT`,
    /// listings omit the entries, writes are denied or go to a memory upper layer.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct HideConfig {
        /// mount-relative paths; a path hides itself and everything below it
        pub paths: Vec<String>,
        /// behaviour of writes to hidden paths
        pub write_mode: HideWriteMode = Default::default(),
        /// errno name for denied writes (default `EACCES`)
        pub deny_write_errno: Option<String>,
        /// also hide paths whose resolved (symlink-free) path is hidden
        pub deny_symlink_bypass: bool = default_true(),
    }
}

gondolin_wire::wire_enum! {
    /// `ShadowProvider` `writeMode`.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub enum HideWriteMode {
        #[default]
        Deny = "deny",
        Tmpfs = "tmpfs",
    }
}

gondolin_wire::wire_enum! {
    /// Kind of a filesystem entry.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum EntryKind {
        File = "file",
        Dir = "dir",
        Symlink = "symlink",
    }
}

gondolin_wire::wire_struct! {
    /// Metadata reported by an object-tier provider.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ObjectStat {
        /// entry kind
        pub kind: EntryKind,
        /// file size in `bytes`
        pub size: u64 = Default::default(),
        /// permission bits (`0o7777` mask; type bits are ignored)
        pub mode: Option<u32>,
        /// modification time in `ms` since the unix epoch
        pub mtime_ms: Option<i64>,
        /// status change time in `ms` since the unix epoch
        pub ctime_ms: Option<i64>,
        /// access time in `ms` since the unix epoch
        pub atime_ms: Option<i64>,
        /// hard link count
        pub nlink: Option<u32>,
        pub uid: Option<u32>,
        pub gid: Option<u32>,
    }
}

gondolin_wire::wire_struct! {
    /// One directory entry from an object-tier provider.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ObjectDirEntry {
        pub name: String,
        pub kind: EntryKind,
    }
}

gondolin_wire::wire_struct! {
    /// d→c `vfs_call` payload.
    #[derive(Debug, Clone, PartialEq)]
    pub struct VfsCall {
        /// object mount the call is for
        pub mount_id: u32,
        pub op: VfsOp => flatten,
    }
}

gondolin_wire::wire_tagged! {
    /// Object-tier operations. Paths are relative to the mount.
    #[derive(Debug, Clone, PartialEq)]
    pub enum VfsOp : "op" {
        /// metadata without following a final symlink; with `inline_max`, files
        /// of at most that many `bytes` come back with their contents in `data`
        Stat = "stat" {
            path: String,
            inline_max: Option<u64>,
        },
        Readdir = "readdir" {
            path: String,
        },
        /// `length` bytes at `offset` (absent: to the end); short only at EOF
        ReadFile = "read_file" {
            path: String,
            offset: u64 = Default::default(),
            length: Option<u64>,
        },
        /// whole-file write, sent as consecutive chunks; `offset` 0 starts a new
        /// file content, the chunk with `last` commits it
        WriteFile = "write_file" {
            path: String,
            data: Vec<u8>,
            offset: u64 = Default::default(),
            last: bool = default_true(),
            /// permission bits for a newly created file
            mode: Option<u32>,
        },
        /// positional write into an existing file (`commit: "write"` mounts)
        Write = "write" {
            path: String,
            offset: u64,
            data: Vec<u8>,
        },
        Truncate = "truncate" {
            path: String,
            size: u64,
        },
        Unlink = "unlink" {
            path: String,
        },
        Rename = "rename" {
            from: String,
            to: String,
        },
        Mkdir = "mkdir" {
            path: String,
            mode: Option<u32>,
        },
        Rmdir = "rmdir" {
            path: String,
        },
        Chmod = "chmod" {
            path: String,
            mode: u32,
        },
        Symlink = "symlink" {
            target: String,
            path: String,
        },
        Readlink = "readlink" {
            path: String,
        },
        /// hard link `to` → `from`
        Link = "link" {
            from: String,
            to: String,
        },
    }
}

gondolin_wire::wire_struct! {
    /// c→d `vfs_call_result` payload (`ok: false` carries `code` and `message`).
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct VfsCallResult {
        pub ok: bool,
        /// errno name when `ok` is false
        pub code: Option<String>,
        pub message: Option<String>,
        /// `stat`
        pub stat: Option<ObjectStat>,
        /// `readdir`
        pub entries: Option<Vec<ObjectDirEntry>>,
        /// `read_file`
        pub data: Option<Vec<u8>>,
        /// `readlink`
        pub target: Option<String>,
    }
}

gondolin_wire::wire_struct! {
    /// d→c `vfs_hook` payload and the body of `vfs_event`; mirrors the node
    /// engine's `VfsHookContext` (`host/src/vfs/provider.ts`).
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub struct HookContext {
        /// operation name (`open`, `read`, `write`, `release`, `lstat`, `mkdir`, ...)
        pub op: String,
        pub path: Option<String>,
        /// source of `rename`/`link`
        pub old_path: Option<String>,
        /// destination of `rename`/`link`
        pub new_path: Option<String>,
        /// node-style open flags (`r`, `r+`, `w`, `w+`, `a`, `a+`)
        pub flags: Option<String>,
        /// mode bits
        pub mode: Option<u32>,
        /// file offset in `bytes` (absent for appends)
        pub offset: Option<u64>,
        /// length in `bytes`
        pub length: Option<u64>,
        /// size in `bytes` (`truncate`)
        pub size: Option<u64>,
    }
}

gondolin_wire::wire_struct! {
    /// d→c `vfs_event` payload.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct VfsEvent {
        pub ctx: HookContext => flatten,
        /// errno name when the operation failed
        pub error: Option<String>,
        /// bytes transferred (`read`/`write`)
        pub bytes: Option<u64>,
    }
}

gondolin_wire::wire_struct! {
    /// Generic `{ ok, code?, message? }` result (`vfs_hook_result`,
    /// `vfs_invalidate_result`).
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub struct OkResult {
        pub ok: bool,
        pub code: Option<String>,
        pub message: Option<String>,
    }
}

gondolin_wire::wire_struct! {
    /// c→d `vfs_invalidate` payload: drop cached state of an object mount.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct VfsInvalidate {
        pub mount_id: u32,
        /// mount-relative path; the path and everything below it (absent: whole mount)
        pub path: Option<String>,
    }
}

gondolin_wire::wire_tagged! {
    /// c→d `fs_call` payload: an operation on the daemon's mount table.
    #[derive(Debug, Clone, PartialEq)]
    pub enum FsCall : "op" {
        /// `follow` false behaves like `lstat`
        Stat = "stat" {
            path: String,
            follow: bool = default_true(),
        },
        Readdir = "readdir" {
            path: String,
        },
        Access = "access" {
            path: String,
            mask: u32 = Default::default(),
        },
        Mkdir = "mkdir" {
            path: String,
            mode: Option<u32>,
            recursive: bool = Default::default(),
        },
        Rmdir = "rmdir" {
            path: String,
        },
        Unlink = "unlink" {
            path: String,
        },
        Rename = "rename" {
            from: String,
            to: String,
        },
        Chmod = "chmod" {
            path: String,
            mode: u32,
        },
        Truncate = "truncate" {
            path: String,
            size: u64,
        },
        Readlink = "readlink" {
            path: String,
        },
        Symlink = "symlink" {
            target: String,
            path: String,
        },
        Realpath = "realpath" {
            path: String,
        },
        /// open a handle; `flags` are node-style (`r`, `r+`, `w`, `w+`, `a`, `a+`)
        Open = "open" {
            path: String,
            flags: String,
            mode: Option<u32>,
        },
        /// read up to `length` bytes at `offset`
        Read = "read" {
            fh: u64,
            offset: u64,
            length: u64,
        },
        /// write at `offset` (ignored for append handles)
        Write = "write" {
            fh: u64,
            offset: u64,
            data: Vec<u8>,
        },
        /// close a handle; commit errors of object mounts are reported here
        Close = "close" {
            fh: u64,
        },
    }
}

gondolin_wire::wire_struct! {
    /// Metadata returned by `fs_call` (`node:fs` `Stats` fields).
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
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
}

gondolin_wire::wire_struct! {
    /// d→c `fs_call_result` payload.
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct FsCallResult {
        pub ok: bool,
        /// errno name when `ok` is false
        pub code: Option<String>,
        pub message: Option<String>,
        pub stat: Option<FsStat>,
        pub entries: Option<Vec<ObjectDirEntry>>,
        pub data: Option<Vec<u8>>,
        /// `readlink` target / `realpath` result
        pub target: Option<String>,
        /// `open`
        pub fh: Option<u64>,
        /// bytes written (`write`)
        pub size: Option<u64>,
    }
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
                        files: [("/ca.crt".to_string(), b"pem".to_vec())].into(),
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
