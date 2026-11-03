//! Recursive delete that never follows symlinks and uses a constant number
//! of file descriptors regardless of the tree depth.
//!
//! The walk keeps the names of the directories between the root and the
//! current directory (not their fds).  Entries are removed with
//! `unlinkat(dirfd, name)`; directories are opened with
//! `openat(dirfd, name, O_DIRECTORY | O_NOFOLLOW)`, so a symlink is always
//! removed itself and never traversed.  Once a directory is empty its parent
//! is re-opened by walking the saved names down from the root, the directory
//! is removed and the scan of the parent continues (entries that were already
//! deleted no longer show up).  At most three fds are open at any time; the
//! cost is O(depth) `openat` calls per directory.
//!
//! Error names match `std.Io.Dir.deleteTree` (they are reported to the host).

const std = @import("std");
const shared = @import("shared");
const sys = shared.sys;
const linux = std.os.linux;

const Allocator = std.mem.Allocator;

pub const Error = sys.OpenDirError || sys.UnlinkError || sys.DirIterator.Error || Allocator.Error;

/// Delete `path` and, if it is a directory, everything below it.  A missing
/// path is not an error; a final symlink is removed, not followed.
pub fn deleteTree(gpa: Allocator, path: [:0]const u8) Error!void {
    // Treat the root as a file first: this removes files and symlinks.
    if (sys.unlinkatZ(linux.AT.FDCWD, path, false)) |_| {
        return;
    } else |err| switch (err) {
        error.FileNotFound => return,
        error.IsDir => {},
        else => return err,
    }

    var walker: Walker = .{ .gpa = gpa, .root = path };
    defer walker.deinit();
    return walker.run();
}

const Walker = struct {
    gpa: Allocator,
    root: [:0]const u8,
    /// directory names from below `root` down to the current directory
    names: std.ArrayList([:0]u8) = .empty,

    fn deinit(self: *Walker) void {
        for (self.names.items) |name| self.gpa.free(name);
        self.names.deinit(self.gpa);
    }

    /// Open `root/names[0]/.../names[depth-1]`.
    fn openAtDepth(self: *Walker, depth: usize) Error!sys.fd_t {
        var fd = try sys.openDirNoFollowZ(linux.AT.FDCWD, self.root);
        for (self.names.items[0..depth]) |name| {
            const next = sys.openDirNoFollowZ(fd, name) catch |err| {
                sys.close(fd);
                return err;
            };
            sys.close(fd);
            fd = next;
        }
        return fd;
    }

    /// Open entry `name` of `dir` as a directory; returns null when it is
    /// gone or turned out not to be a directory (it is then unlinked).
    fn openChild(dir: sys.fd_t, name: [:0]const u8) Error!?sys.fd_t {
        return sys.openDirNoFollowZ(dir, name) catch |err| switch (err) {
            error.FileNotFound => null,
            // a symlink (ELOOP) or a file replaced the directory: unlink it
            error.NotDir, error.SymLinkLoop => {
                sys.unlinkatZ(dir, name, false) catch |unlink_err| switch (unlink_err) {
                    error.FileNotFound => {},
                    else => return unlink_err,
                };
                return null;
            },
            else => return err,
        };
    }

    fn descend(self: *Walker, name: [:0]const u8, child: sys.fd_t) Allocator.Error!void {
        errdefer sys.close(child);
        const owned = try self.gpa.dupeSentinel(u8, name, 0);
        errdefer self.gpa.free(owned);
        try self.names.append(self.gpa, owned);
    }

    fn run(self: *Walker) Error!void {
        var dir: sys.fd_t = try self.openAtDepth(0);
        defer if (dir >= 0) sys.close(dir);

        scan: while (true) {
            var it: sys.DirIterator = .{ .fd = dir };
            while (try it.nextChecked()) |entry| {
                const is_dir = entry.type == linux.DT.DIR or blk: {
                    // Everything else (including DT_UNKNOWN) is unlinked
                    // first; EISDIR reveals a directory.
                    sys.unlinkatZ(dir, entry.name, false) catch |err| switch (err) {
                        error.FileNotFound => {},
                        error.IsDir => break :blk true,
                        else => return err,
                    };
                    break :blk false;
                };
                if (!is_dir) continue;
                const child = try openChild(dir, entry.name) orelse continue;
                try self.descend(entry.name, child);
                sys.close(dir);
                dir = child;
                continue :scan;
            }

            // `dir` is empty now: remove it from its parent.
            sys.close(dir);
            dir = -1;
            if (self.names.items.len == 0) {
                sys.unlinkatZ(linux.AT.FDCWD, self.root, true) catch |err| switch (err) {
                    error.FileNotFound => {},
                    error.DirNotEmpty => {
                        // something was created meanwhile: scan again
                        dir = try self.openAtDepth(0);
                        continue :scan;
                    },
                    else => return err,
                };
                return;
            }

            const name = self.names.pop().?;
            defer self.gpa.free(name);
            dir = try self.openAtDepth(self.names.items.len);
            sys.unlinkatZ(dir, name, true) catch |err| switch (err) {
                error.FileNotFound => {},
                error.DirNotEmpty => {
                    const child = try openChild(dir, name) orelse continue :scan;
                    try self.descend(name, child);
                    sys.close(dir);
                    dir = child;
                },
                else => return err,
            };
        }
    }
};

// ---------------------------------------------------------------------------
// Tests (Linux; run inside the guest by `guest-tests`)

const testing = std.testing;

/// Scratch directory under /tmp (world-traversable, unlike the test
/// runner's cache directory).
const Scratch = struct {
    buf: [64]u8 = undefined,
    path: [:0]const u8 = "",

    fn init(self: *Scratch, comptime tag: []const u8) !void {
        self.path = try std.mem.printSentinel(&self.buf, "/tmp/gondolin-delete-tree-" ++ tag ++ "-{d}", .{linux.getpid()}, 0);
        _ = linux.mkdirat(linux.AT.FDCWD, self.path, 0o755);
    }

    fn sub(self: *const Scratch, buf: []u8, rel: []const u8) ![:0]const u8 {
        return std.mem.printSentinel(buf, "{s}/{s}", .{ self.path, rel }, 0);
    }

    fn deinit(self: *Scratch) void {
        deleteTree(testing.allocator, self.path) catch {};
    }
};

fn mkdir(path: [:0]const u8) !void {
    if (linux.errno(linux.mkdirat(linux.AT.FDCWD, path, 0o755)) != .SUCCESS) return error.MkdirFailed;
}

fn touch(path: [:0]const u8) !void {
    sys.close(try sys.openZ(path, .{ .ACCMODE = .WRONLY, .CREAT = true }, 0o644));
}

fn symlink(target: [:0]const u8, path: [:0]const u8) !void {
    if (linux.errno(linux.symlinkat(target, linux.AT.FDCWD, path)) != .SUCCESS) return error.SymlinkFailed;
}

fn exists(path: [:0]const u8) bool {
    sys.lexists(path) catch return false;
    return true;
}

test "deletes nested trees, files and missing paths" {
    var scratch: Scratch = .{};
    try scratch.init("nested");
    defer scratch.deinit();

    var b: [4][128]u8 = undefined;
    try mkdir(try scratch.sub(&b[0], "t"));
    try mkdir(try scratch.sub(&b[0], "t/a"));
    try mkdir(try scratch.sub(&b[0], "t/a/b"));
    try mkdir(try scratch.sub(&b[0], "t/empty"));
    for (0..300) |i| {
        var name: [32]u8 = undefined;
        try touch(try scratch.sub(&b[0], try std.mem.print(&name, "t/a/b/f{d}", .{i})));
    }
    try touch(try scratch.sub(&b[0], "t/a/file"));

    try deleteTree(testing.allocator, try scratch.sub(&b[1], "t"));
    try testing.expect(!exists(try scratch.sub(&b[1], "t")));

    // plain files and missing paths
    try touch(try scratch.sub(&b[2], "f"));
    try deleteTree(testing.allocator, try scratch.sub(&b[2], "f"));
    try testing.expect(!exists(try scratch.sub(&b[2], "f")));
    try deleteTree(testing.allocator, try scratch.sub(&b[3], "missing"));
}

test "symlinks are removed, never followed" {
    var scratch: Scratch = .{};
    try scratch.init("symlink");
    defer scratch.deinit();

    var b: [6][128]u8 = undefined;
    const outside = try scratch.sub(&b[0], "outside");
    const keep = try scratch.sub(&b[1], "outside/keep");
    try mkdir(outside);
    try touch(keep);
    try mkdir(try scratch.sub(&b[2], "t"));
    try symlink(outside, try scratch.sub(&b[3], "t/link"));

    try deleteTree(testing.allocator, try scratch.sub(&b[4], "t"));
    try testing.expect(!exists(try scratch.sub(&b[4], "t")));
    try testing.expect(exists(keep));

    // the root itself is a symlink to a directory
    const root_link = try scratch.sub(&b[5], "rootlink");
    try symlink(outside, root_link);
    try deleteTree(testing.allocator, root_link);
    try testing.expect(!exists(root_link));
    try testing.expect(exists(keep));
}

test "deep trees beyond PATH_MAX use constant fds" {
    var scratch: Scratch = .{};
    try scratch.init("deep");
    defer scratch.deinit();

    var b: [128]u8 = undefined;
    const root = try scratch.sub(&b, "t");
    try mkdir(root);

    // 300 levels of 60-byte names: ~18 KiB, far beyond PATH_MAX
    const component_buf: [60:0]u8 = @splat('d');
    const component: [:0]const u8 = &component_buf;
    var fd = try sys.openDirNoFollowZ(linux.AT.FDCWD, root);
    for (0..300) |_| {
        if (linux.errno(linux.mkdirat(fd, component, 0o755)) != .SUCCESS) return error.MkdirFailed;
        const next = try sys.openDirNoFollowZ(fd, component);
        sys.close(fd);
        fd = next;
    }
    sys.close(try sys.openatZ(fd, "leaf", .{ .ACCMODE = .WRONLY, .CREAT = true }, 0o644));
    sys.close(fd);

    // the next free fd before and after: nothing leaked
    const probe_before = try sys.openZ("/dev/null", .{}, 0);
    sys.close(probe_before);
    try deleteTree(testing.allocator, root);
    try testing.expect(!exists(root));
    const probe_after = try sys.openZ("/dev/null", .{}, 0);
    sys.close(probe_after);
    try testing.expectEqual(probe_before, probe_after);
}

test "permission errors are reported by name" {
    var scratch: Scratch = .{};
    try scratch.init("perm");
    defer scratch.deinit();

    // own/locked/sub/file: the walk can enter `sub` but not delete `file`
    var b: [4][128]u8 = undefined;
    const own = try scratch.sub(&b[0], "own");
    const locked = try scratch.sub(&b[1], "own/locked");
    const sub = try scratch.sub(&b[2], "own/locked/sub");
    try mkdir(own);
    try mkdir(locked);
    try mkdir(sub);
    try touch(try scratch.sub(&b[3], "own/locked/sub/file"));
    defer _ = linux.fchmodat(linux.AT.FDCWD, sub, 0o755);

    // Root bypasses permission checks, so as root the delete runs as
    // `nobody` (owning everything but `sub`) in a child process; otherwise
    // `sub` is made read-only.  The error name comes back through a pipe.
    const as_root = linux.geteuid() == 0;
    if (as_root) {
        for ([_][:0]const u8{ own, locked }) |path| {
            if (linux.errno(linux.fchownat(linux.AT.FDCWD, path, 65534, 65534, 0)) != .SUCCESS) return error.ChownFailed;
        }
    } else {
        _ = linux.fchmodat(linux.AT.FDCWD, sub, 0o555);
    }

    const pipe = try sys.pipe(false);
    const pid = try sys.fork();
    if (pid == 0) {
        sys.close(pipe[0]);
        if (as_root) {
            if (linux.errno(linux.setresgid(65534, 65534, 65534)) != .SUCCESS) sys.exit(2);
            if (linux.errno(linux.setresuid(65534, 65534, 65534)) != .SUCCESS) sys.exit(2);
        }
        const name = if (deleteTree(std.heap.page_allocator, locked)) "ok" else |err| @errorName(err);
        sys.writeAll(pipe[1], name) catch {};
        sys.exit(0);
    }
    sys.close(pipe[1]);
    defer sys.close(pipe[0]);
    var out: [64]u8 = undefined;
    const n = try sys.read(pipe[0], &out);
    _ = sys.waitPid(pid);

    try testing.expectEqualStrings("AccessDenied", out[0..n]);
    try testing.expect(exists(sub));
}
