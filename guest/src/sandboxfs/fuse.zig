//! Subset of the Linux FUSE kernel ABI (`include/uapi/linux/fuse.h`) used by
//! sandboxfs.  All structs are native-endian `extern struct`s that mirror the
//! kernel layout byte for byte.

const std = @import("std");

pub const root_id: u64 = 1;

pub const Opcode = enum(u32) {
    lookup = 1,
    forget = 2,
    getattr = 3,
    setattr = 4,
    readlink = 5,
    symlink = 6,
    mknod = 8,
    mkdir = 9,
    unlink = 10,
    rmdir = 11,
    rename = 12,
    link = 13,
    open = 14,
    read = 15,
    write = 16,
    statfs = 17,
    release = 18,
    fsync = 20,
    setxattr = 21,
    getxattr = 22,
    listxattr = 23,
    removexattr = 24,
    flush = 25,
    init = 26,
    opendir = 27,
    readdir = 28,
    releasedir = 29,
    fsyncdir = 30,
    access = 34,
    create = 35,
    interrupt = 36,
    destroy = 38,
    ioctl = 39,
    batch_forget = 42,
    fallocate = 43,
    readdirplus = 44,
    rename2 = 45,
    copy_file_range = 47,
    _,
};

/// `FUSE_INIT` capability flags negotiated by sandboxfs
pub const init_flags = struct {
    pub const atomic_o_trunc: u32 = 1 << 3;
    pub const big_writes: u32 = 1 << 5;
    /// `InitOut.max_pages` is valid (protocol 7.28)
    pub const max_pages: u32 = 1 << 22;
    /// directory listings with attributes (READDIRPLUS instead of READDIR)
    pub const do_readdirplus: u32 = 1 << 13;
};

/// `FATTR_*` bits in `SetattrIn.valid`
pub const fattr = struct {
    pub const mode: u32 = 1 << 0;
    pub const size: u32 = 1 << 3;
};

pub const InHeader = extern struct {
    /// total request length including this header in `bytes`
    len: u32,
    opcode: u32,
    unique: u64,
    nodeid: u64,
    uid: u32,
    gid: u32,
    pid: u32,
    padding: u32,
};

pub const OutHeader = extern struct {
    /// total reply length including this header in `bytes`
    len: u32,
    /// negative errno or 0
    @"error": i32,
    unique: u64,
};

pub const Attr = extern struct {
    ino: u64,
    size: u64,
    blocks: u64,
    atime: u64,
    mtime: u64,
    ctime: u64,
    atimensec: u32,
    mtimensec: u32,
    ctimensec: u32,
    mode: u32,
    nlink: u32,
    uid: u32,
    gid: u32,
    rdev: u32,
    blksize: u32,
    padding: u32 = 0,
};

pub const EntryOut = extern struct {
    nodeid: u64,
    generation: u64,
    entry_valid: u64,
    attr_valid: u64,
    entry_valid_nsec: u32,
    attr_valid_nsec: u32,
    attr: Attr,
};

pub const AttrOut = extern struct {
    attr_valid: u64,
    attr_valid_nsec: u32,
    dummy: u32 = 0,
    attr: Attr,
};

pub const OpenOut = extern struct {
    fh: u64,
    open_flags: u32,
    padding: u32 = 0,
};

pub const WriteOut = extern struct {
    size: u32,
    padding: u32 = 0,
};

pub const Dirent = extern struct {
    ino: u64,
    off: u64,
    namelen: u32,
    type: u32,
};

pub const StatfsOut = extern struct {
    blocks: u64,
    bfree: u64,
    bavail: u64,
    files: u64,
    ffree: u64,
    bsize: u32,
    namelen: u32,
    frsize: u32,
    padding: u32 = 0,
    spare: [6]u32 = @splat(0),
};

pub const InitIn = extern struct {
    major: u32,
    minor: u32,
    max_readahead: u32,
    flags: u32,
};

pub const InitOut = extern struct {
    major: u32,
    minor: u32,
    max_readahead: u32,
    flags: u32,
    max_background: u16 = 0,
    congestion_threshold: u16 = 0,
    max_write: u32,
    time_gran: u32,
    max_pages: u16 = 0,
    map_alignment: u16 = 0,
    flags2: u32 = 0,
    unused: [7]u32 = @splat(0),
};

pub const OpenIn = extern struct {
    flags: u32,
    open_flags: u32,
};

pub const ReadIn = extern struct {
    fh: u64,
    offset: u64,
    size: u32,
    read_flags: u32,
    lock_owner: u64,
    flags: u32,
    padding: u32,
};

pub const WriteIn = extern struct {
    fh: u64,
    offset: u64,
    size: u32,
    write_flags: u32,
    lock_owner: u64,
    flags: u32,
    padding: u32,
};

pub const CreateIn = extern struct {
    flags: u32,
    mode: u32,
    umask: u32,
    open_flags: u32,
};

pub const MkdirIn = extern struct {
    mode: u32,
    umask: u32,
};

pub const RenameIn = extern struct {
    newdir: u64,
};

pub const Rename2In = extern struct {
    newdir: u64,
    flags: u32,
    padding: u32,
};

pub const LinkIn = extern struct {
    oldnodeid: u64,
};

pub const AccessIn = extern struct {
    mask: u32,
    padding: u32,
};

pub const FallocateIn = extern struct {
    fh: u64,
    offset: u64,
    length: u64,
    mode: u32,
    padding: u32,
};

pub const CopyFileRangeIn = extern struct {
    fh_in: u64,
    off_in: u64,
    nodeid_out: u64,
    fh_out: u64,
    off_out: u64,
    len: u64,
    flags: u64,
};

pub const SetattrIn = extern struct {
    valid: u32,
    padding: u32,
    fh: u64,
    size: u64,
    lock_owner: u64,
    atime: u64,
    mtime: u64,
    ctime: u64,
    atimensec: u32,
    mtimensec: u32,
    ctimensec: u32,
    mode: u32,
    unused4: u32,
    uid: u32,
    gid: u32,
    unused5: u32,
};

pub const FlushIn = extern struct {
    fh: u64,
    unused: u32,
    padding: u32,
    lock_owner: u64,
};

pub const FsyncIn = extern struct {
    fh: u64,
    fsync_flags: u32,
    padding: u32,
};

pub const ReleaseIn = extern struct {
    fh: u64,
    flags: u32,
    release_flags: u32,
    lock_owner: u64,
};

comptime {
    // Spot-check layouts against the kernel ABI.
    std.debug.assert(@sizeOf(InHeader) == 40);
    std.debug.assert(@sizeOf(OutHeader) == 16);
    std.debug.assert(@sizeOf(Attr) == 88);
    std.debug.assert(@sizeOf(EntryOut) == 128);
    std.debug.assert(@sizeOf(AttrOut) == 104);
    std.debug.assert(@sizeOf(InitOut) == 64);
    std.debug.assert(@sizeOf(ReadIn) == 40);
    std.debug.assert(@sizeOf(WriteIn) == 40);
    std.debug.assert(@sizeOf(SetattrIn) == 88);
    std.debug.assert(@sizeOf(StatfsOut) == 80);
    std.debug.assert(@sizeOf(CopyFileRangeIn) == 56);
}

/// A fixed-size request struct followed by trailing bytes.
pub fn Parsed(comptime T: type) type {
    return struct { T, []const u8 };
}

/// Decode the fixed-size prefix `T` of a request payload (unaligned safe).
pub fn parse(comptime T: type, payload: []const u8) error{InvalidRequest}!Parsed(T) {
    if (payload.len < @sizeOf(T)) return error.InvalidRequest;
    return .{ std.mem.bytesToValue(T, payload[0..@sizeOf(T)]), payload[@sizeOf(T)..] };
}

/// Split a NUL-terminated name off `bytes`; a missing terminator takes all
/// of `bytes`.
pub fn name(bytes: []const u8) Parsed([]const u8) {
    const end = std.mem.findScalar(u8, bytes, 0) orelse return .{ bytes, &.{} };
    return .{ bytes[0..end], bytes[end + 1 ..] };
}

/// Size of a directory entry record including padding to 8 bytes.
pub fn direntSize(name_len: usize) usize {
    return std.mem.alignForward(usize, @sizeOf(Dirent) + name_len, 8);
}

/// Size of a READDIRPLUS record (`EntryOut`, `Dirent`, name, padding).
pub fn direntplusSize(name_len: usize) usize {
    return std.mem.alignForward(usize, @sizeOf(EntryOut) + @sizeOf(Dirent) + name_len, 8);
}

test "direntplus records" {
    try std.testing.expectEqual(@as(usize, 128), @sizeOf(EntryOut));
    try std.testing.expectEqual(@as(usize, 160), direntplusSize(1));
    try std.testing.expectEqual(@as(usize, 168), direntplusSize(9));
}

test "request parsing" {
    const testing = std.testing;
    var buf: [@sizeOf(RenameIn) + 8]u8 = undefined;
    std.mem.writeInt(u64, buf[0..8], 42, .little);
    @memcpy(buf[8..], "old\x00new\x00");
    const rename, const names = try parse(RenameIn, &buf);
    try testing.expectEqual(@as(u64, 42), rename.newdir);
    const old, const rest = name(names);
    try testing.expectEqualStrings("old", old);
    try testing.expectEqualStrings("new", name(rest)[0]);
    try testing.expectEqualStrings("", name(name(rest)[1])[0]);
    try testing.expectError(error.InvalidRequest, parse(ReadIn, buf[0..8]));
    try testing.expectEqual(@as(usize, 32), direntSize(5));
    try testing.expectEqual(@as(usize, 24), direntSize(0));
}
