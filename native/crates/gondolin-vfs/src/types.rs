//! Shared value types: attributes, directory entries, open flags, paths.

use std::time::{SystemTime, UNIX_EPOCH};

pub use gondolin_proto::vfs::EntryKind;

pub const S_IFMT: u32 = 0o170000;
pub const S_IFREG: u32 = 0o100000;
pub const S_IFDIR: u32 = 0o040000;
pub const S_IFLNK: u32 = 0o120000;

pub const DT_DIR: u32 = 4;
pub const DT_REG: u32 = 8;
pub const DT_LNK: u32 = 10;

/// Metadata of an entry (the fields the sandboxfs `attr` map carries).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attr {
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

impl Attr {
    pub fn kind(&self) -> Option<EntryKind> {
        match self.mode & S_IFMT {
            S_IFDIR => Some(EntryKind::Dir),
            S_IFLNK => Some(EntryKind::Symlink),
            S_IFREG => Some(EntryKind::File),
            _ => None,
        }
    }

    pub fn is_dir(&self) -> bool {
        self.mode & S_IFMT == S_IFDIR
    }

    pub fn is_symlink(&self) -> bool {
        self.mode & S_IFMT == S_IFLNK
    }

    pub fn perm(&self) -> u32 {
        self.mode & 0o7777
    }

    /// The synthetic directory of the node engine's `createVirtualDirStats`.
    pub fn virtual_dir() -> Attr {
        let now = now_ms();
        Attr {
            mode: S_IFDIR | 0o755,
            size: 4096,
            nlink: 1,
            uid: 0,
            gid: 0,
            atime_ms: now,
            mtime_ms: now,
            ctime_ms: now,
        }
    }

    pub fn to_fs_stat(&self) -> gondolin_proto::vfs::FsStat {
        gondolin_proto::vfs::FsStat {
            mode: self.mode,
            size: self.size,
            nlink: self.nlink,
            uid: self.uid,
            gid: self.gid,
            atime_ms: self.atime_ms,
            mtime_ms: self.mtime_ms,
            ctime_ms: self.ctime_ms,
        }
    }
}

pub fn kind_mode(kind: EntryKind) -> u32 {
    match kind {
        EntryKind::File => S_IFREG,
        EntryKind::Dir => S_IFDIR,
        EntryKind::Symlink => S_IFLNK,
    }
}

pub fn dirent_type(kind: Option<EntryKind>) -> u32 {
    match kind {
        Some(EntryKind::Dir) => DT_DIR,
        Some(EntryKind::Symlink) => DT_LNK,
        _ => DT_REG,
    }
}

/// One entry of a directory listing (no `.`/`..`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    /// entry type when the provider knows it without a stat
    pub kind: Option<EntryKind>,
}

impl DirEntry {
    pub fn new(name: impl Into<String>, kind: EntryKind) -> Self {
        DirEntry { name: name.into(), kind: Some(kind) }
    }
}

/// `statfs` result (fields of the sandboxfs `statfs` map).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatFs {
    pub blocks: u64,
    pub bfree: u64,
    pub bavail: u64,
    pub files: u64,
    pub ffree: u64,
    pub bsize: u64,
    pub frsize: u64,
    pub namelen: u64,
}

impl StatFs {
    /// Defaults when a provider has no statfs (64 GiB of 4 KiB blocks).
    pub const SYNTHETIC: StatFs = StatFs {
        blocks: 16_777_216,
        bfree: 16_777_216,
        bavail: 16_777_216,
        files: 16_777_216,
        ffree: 16_777_216,
        bsize: 4096,
        frsize: 4096,
        namelen: 255,
    };

    /// Clamps values like the node engine's `normalizeStatfs`.
    pub fn normalized(self) -> StatFs {
        const U32_MAX: u64 = 0xffff_ffff;
        const SAFE: u64 = (1 << 53) - 1;
        let u = |v: u64| v.min(SAFE);
        let u32c = |v: u64, min: u64| v.min(U32_MAX).max(min);
        let blocks = u(self.blocks);
        let files = u(self.files);
        let bfree = u(self.bfree).min(blocks);
        StatFs {
            bsize: u32c(self.bsize, 1),
            frsize: u32c(self.frsize, 1),
            namelen: u32c(self.namelen, 0),
            blocks,
            files,
            bfree,
            bavail: u(self.bavail).min(bfree),
            ffree: u(self.ffree).min(files),
        }
    }
}

/// How a file is opened. Mirrors the node flag strings the node engine's RPC
/// layer derives from Linux open flags (`r`, `r+`, `w`, `w+`, `a`, `a+`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OpenFlags {
    pub read: bool,
    pub write: bool,
    pub append: bool,
    pub create: bool,
    pub truncate: bool,
}

impl OpenFlags {
    pub const READ: OpenFlags =
        OpenFlags { read: true, write: false, append: false, create: false, truncate: false };
    pub const READ_WRITE: OpenFlags =
        OpenFlags { read: true, write: true, append: false, create: false, truncate: false };

    /// Parses a node flag string. Unknown strings are `None`.
    pub fn parse(flags: &str) -> Option<OpenFlags> {
        let f = |read, write, append, create, truncate| OpenFlags {
            read,
            write,
            append,
            create,
            truncate,
        };
        Some(match flags {
            "r" | "rs" | "sr" => f(true, false, false, false, false),
            "r+" | "rs+" | "sr+" => f(true, true, false, false, false),
            "w" | "wx" | "xw" => f(false, true, false, true, true),
            "w+" | "wx+" | "xw+" => f(true, true, false, true, true),
            "a" | "ax" | "xa" | "as" | "sa" => f(false, true, true, true, false),
            "a+" | "ax+" | "xa+" | "as+" | "sa+" => f(true, true, true, true, false),
            _ => return None,
        })
    }

    /// The node flag string for these flags.
    pub fn as_node_str(&self) -> &'static str {
        match (self.append, self.create || self.truncate, self.read && self.write, self.write) {
            (true, _, true, _) => "a+",
            (true, _, false, _) => "a",
            (false, true, true, _) => "w+",
            (false, true, false, _) => "w",
            (false, false, _, true) => "r+",
            _ => "r",
        }
    }

    /// Any flag that allows modifying the file (node's `isWriteFlag`).
    pub fn is_write(&self) -> bool {
        self.write || self.append || self.create || self.truncate
    }
}

/// Linux open(2) flag bits the RPC layer inspects.
pub mod linux_open {
    pub const O_ACCMODE: u64 = 3;
    pub const O_RDONLY: u64 = 0;
    pub const O_WRONLY: u64 = 1;
    pub const O_RDWR: u64 = 2;
    pub const O_CREAT: u64 = 0x40;
    pub const O_EXCL: u64 = 0x80;
    pub const O_TRUNC: u64 = 0x200;
    pub const O_APPEND: u64 = 0x400;
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn system_time_ms(t: std::io::Result<SystemTime>) -> i64 {
    match t {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis() as i64,
            Err(e) => -(e.duration().as_millis() as i64),
        },
        Err(_) => 0,
    }
}

/// POSIX path helpers for the VFS (absolute, `/`-separated, normalized).
pub mod vpath {
    /// `path.posix.normalize` plus a leading `/` and no trailing `/`
    /// (node's `normalizeVfsPath`). `..` above the root stays at the root.
    pub fn normalize(input: &str) -> String {
        let mut parts: Vec<&str> = Vec::new();
        for part in input.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                p => parts.push(p),
            }
        }
        if parts.is_empty() {
            return "/".to_string();
        }
        let mut out = String::with_capacity(input.len() + 1);
        for p in parts {
            out.push('/');
            out.push_str(p);
        }
        out
    }

    /// Joins a normalized parent with a single name and normalizes.
    pub fn join(parent: &str, name: &str) -> String {
        if name == "." || name == ".." || name.is_empty() {
            return normalize(&format!("{parent}/{name}"));
        }
        if parent == "/" { format!("/{name}") } else { format!("{parent}/{name}") }
    }

    /// Parent of a normalized path (`/` for `/`).
    pub fn parent(path: &str) -> &str {
        match path.rfind('/') {
            Some(0) | None => "/",
            Some(i) => &path[..i],
        }
    }

    /// Final component of a normalized path (empty for `/`).
    pub fn basename(path: &str) -> &str {
        match path.rfind('/') {
            Some(i) => &path[i + 1..],
            None => path,
        }
    }

    /// `path` equals `prefix` or lies below it.
    pub fn is_under(path: &str, prefix: &str) -> bool {
        if prefix == "/" {
            return path.starts_with('/');
        }
        path == prefix
            || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'))
    }

    /// Path relative to a mount point, as an absolute path (`/` for the mount itself).
    pub fn relative<'a>(path: &'a str, mount: &str) -> &'a str {
        if mount == "/" {
            path
        } else if path.len() == mount.len() {
            "/"
        } else {
            &path[mount.len()..]
        }
    }

    /// Path components of a normalized path.
    pub fn components(path: &str) -> impl Iterator<Item = &str> {
        path.split('/').filter(|p| !p.is_empty())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn normalize_paths() {
            assert_eq!(normalize(""), "/");
            assert_eq!(normalize("a/b/"), "/a/b");
            assert_eq!(normalize("/a/./b/../c"), "/a/c");
            assert_eq!(normalize("/../../x"), "/x");
            assert_eq!(join("/", "a"), "/a");
            assert_eq!(join("/a", ".."), "/");
            assert_eq!(parent("/a/b"), "/a");
            assert_eq!(parent("/a"), "/");
            assert_eq!(basename("/a/b"), "b");
            assert!(is_under("/a/b", "/a"));
            assert!(!is_under("/ab", "/a"));
            assert!(is_under("/x", "/"));
            assert_eq!(relative("/a/b", "/a"), "/b");
            assert_eq!(relative("/a", "/a"), "/");
        }
    }
}
