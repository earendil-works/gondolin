//! Guest file operations requested by the host over `virtio-port`.
//!
//! - Reads are streamed: after `file_read_request` the file is read one chunk
//!   per event loop iteration (only while the outbox is below its high-water
//!   mark) and sent as `file_read_data` frames followed by `file_read_done`.
//! - Writes are driven by the host: `file_write_request` opens the file, each
//!   `file_write_data` frame is written synchronously, and the frame with
//!   `eof` closes it and produces `file_write_done`.  Other messages may be
//!   interleaved with an upload.  After a failure the remaining data frames of
//!   that upload are discarded silently (the error was already reported).
//! - Deletes complete synchronously.
//!
//! Failures are reported by the caller as `error` messages whose message is
//! the Zig error name (e.g. `FileNotFound`, see `sys.zig` for the errno
//! mapping).  Regular file I/O is blocking but bounded per chunk.

const std = @import("std");
const shared = @import("shared");
const sys = shared.sys;
const protocol = shared.protocol;
const request_path = shared.request_path;
const Outbox = shared.framing.Outbox;
const delete_tree = @import("delete_tree.zig");

const Allocator = std.mem.Allocator;
const AT_FDCWD = std.os.linux.AT.FDCWD;

test {
    _ = delete_tree;
}

pub const Transfers = struct {
    gpa: Allocator,
    /// directory all request paths are confined to (`/` in production)
    root_dir: []const u8,
    reads: std.ArrayList(Read) = .empty,
    writes: std.array_hash_map.Auto(u32, Write) = .empty,

    const Read = struct {
        id: u32,
        fd: sys.fd_t,
        buf: []u8,
    };

    const Write = struct {
        /// null after a failure: discard data until `eof`
        fd: ?sys.fd_t,
    };

    pub fn init(gpa: Allocator, root_dir: []const u8) Transfers {
        return .{ .gpa = gpa, .root_dir = root_dir };
    }

    pub fn deinit(self: *Transfers) void {
        for (self.reads.items) |r| self.closeRead(r);
        self.reads.deinit(self.gpa);
        for (self.writes.values()) |w| if (w.fd) |fd| sys.close(fd);
        self.writes.deinit(self.gpa);
    }

    /// Resolve a request path into a NUL-terminated absolute path.
    fn resolve(self: *Transfers, path: []const u8, cwd: ?[]const u8) (request_path.Error || error{ NameTooLong, BadPathName })![:0]u8 {
        const resolved = try request_path.resolveRequestPathInRoot(self.gpa, self.root_dir, path, cwd);
        defer self.gpa.free(resolved);
        if (resolved.len >= sys.path_max) return error.NameTooLong;
        if (std.mem.findScalar(u8, resolved, 0) != null) return error.BadPathName;
        return self.gpa.dupeSentinel(u8, resolved, 0);
    }

    // -- reads ------------------------------------------------------------

    pub fn startRead(self: *Transfers, id: u32, req: protocol.FileReadRequest) !void {
        const path = try self.resolve(req.path, req.cwd);
        defer self.gpa.free(path);

        const fd = try sys.openZ(path, .{ .ACCMODE = .RDONLY, .NOCTTY = true }, 0);
        errdefer sys.close(fd);
        const buf = try self.gpa.alloc(u8, req.chunkSize());
        errdefer self.gpa.free(buf);
        try self.reads.append(self.gpa, .{ .id = id, .fd = fd, .buf = buf });
    }

    pub fn hasPendingReads(self: *const Transfers) bool {
        return self.reads.items.len > 0;
    }

    /// Send one chunk for every active read (round robin).
    pub fn pumpReads(self: *Transfers, outbox: *Outbox) Outbox.Error!void {
        var i: usize = 0;
        while (i < self.reads.items.len) {
            const r = self.reads.items[i];
            const n = sys.read(r.fd, r.buf) catch |err| {
                try outbox.send(.@"error", r.id, .{ .code = "file_read_failed", .message = @errorName(err) });
                self.closeRead(self.reads.orderedRemove(i));
                continue;
            };
            if (n == 0) {
                try outbox.send(.file_read_done, r.id, .{});
                self.closeRead(self.reads.orderedRemove(i));
                continue;
            }
            try outbox.send(.file_read_data, r.id, .{ .data = .{ .data = r.buf[0..n] } });
            i += 1;
        }
    }

    fn closeRead(self: *Transfers, r: Read) void {
        sys.close(r.fd);
        self.gpa.free(r.buf);
    }

    // -- writes -----------------------------------------------------------

    pub fn startWrite(self: *Transfers, id: u32, req: protocol.FileWriteRequest) !void {
        // Uploads that failed earlier and never sent `eof` are forgotten when
        // a new upload starts (the host runs one file operation at a time).
        var i: usize = self.writes.count();
        while (i > 0) {
            i -= 1;
            if (self.writes.values()[i].fd == null) self.writes.swapRemoveAt(i);
        }
        if (self.writes.fetchSwapRemove(id)) |old| if (old.value.fd) |fd| sys.close(fd);

        try self.writes.ensureUnusedCapacity(self.gpa, 1);
        const path = self.resolve(req.path, req.cwd) catch |err| {
            self.writes.putAssumeCapacity(id, .{ .fd = null });
            return err;
        };
        defer self.gpa.free(path);
        const fd = sys.openZ(path, .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = req.truncate }, 0o666) catch |err| {
            self.writes.putAssumeCapacity(id, .{ .fd = null });
            return err;
        };
        self.writes.putAssumeCapacity(id, .{ .fd = fd });
    }

    pub const WriteResult = enum {
        /// more data expected
        pending,
        /// upload finished; send `file_write_done`
        done,
        /// data for a failed upload was discarded
        discarded,
    };

    /// Whether `id` names an upload in progress (or one being discarded).
    pub fn isWriting(self: *const Transfers, id: u32) bool {
        return self.writes.contains(id);
    }

    /// Apply one `file_write_data` frame.  On error the upload is aborted and
    /// its remaining frames are discarded.
    pub fn writeData(self: *Transfers, id: u32, chunk: protocol.FileWriteData) !WriteResult {
        const entry = self.writes.getPtr(id) orelse unreachable;
        const fd = entry.fd orelse {
            if (chunk.eof) _ = self.writes.swapRemove(id);
            return .discarded;
        };
        sys.writeAll(fd, chunk.data.data) catch |err| {
            self.abortWrite(id);
            if (chunk.eof) _ = self.writes.swapRemove(id);
            return err;
        };
        if (!chunk.eof) return .pending;
        sys.close(fd);
        _ = self.writes.swapRemove(id);
        return .done;
    }

    /// Close the file of an upload and discard its remaining frames.
    pub fn abortWrite(self: *Transfers, id: u32) void {
        const entry = self.writes.getPtr(id) orelse return;
        if (entry.fd) |fd| sys.close(fd);
        entry.fd = null;
    }

    // -- deletes ----------------------------------------------------------

    pub fn delete(self: *Transfers, req: protocol.FileDeleteRequest) !void {
        const path = try self.resolve(req.path, req.cwd);
        defer self.gpa.free(path);

        if (req.recursive) {
            try ensureNotRoot(self.gpa, path);
            // deleteTree treats a missing path as success; honour force=false.
            if (!req.force) try sys.lexists(path);
            try delete_tree.deleteTree(self.gpa, path);
        } else {
            sys.unlinkatZ(AT_FDCWD, path, false) catch |err| switch (err) {
                error.FileNotFound => if (!req.force) return err,
                else => return err,
            };
        }
    }
};

fn ensureNotRoot(gpa: Allocator, path: []const u8) !void {
    const normalized = try std.fs.path.resolve(gpa, &.{path});
    defer gpa.free(normalized);
    if (std.mem.eql(u8, normalized, "/")) return error.CannotDeleteRootDirectory;
}

const testing = std.testing;

fn tmpRoot(tmp: *testing.TmpDir, buf: []u8) ![]const u8 {
    return buf[0..try tmp.dir.realPath(testing.io, buf)];
}

test "recursive delete rejects filesystem root equivalents" {
    for ([_][]const u8{ "/", "/.", "//", "/tmp/.." }) |path| {
        try testing.expectError(error.CannotDeleteRootDirectory, ensureNotRoot(testing.allocator, path));
    }
    try ensureNotRoot(testing.allocator, "/tmp/gondolin-delete-root-test");
    try ensureNotRoot(testing.allocator, "/tmp/../tmp/gondolin-delete-root-test");
}

test "recursive delete reports missing path unless forced" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    var transfers: Transfers = .init(testing.allocator, try tmpRoot(&tmp, &root_buf));
    defer transfers.deinit();

    try testing.expectError(error.FileNotFound, transfers.delete(.{ .path = "/missing", .recursive = true }));
    try transfers.delete(.{ .path = "/missing", .recursive = true, .force = true });
    try testing.expectError(error.FileNotFound, transfers.delete(.{ .path = "/missing" }));
    try transfers.delete(.{ .path = "/missing", .force = true });
}

test "upload, stream back and delete a file" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = try tmpRoot(&tmp, &root_buf);
    var transfers: Transfers = .init(testing.allocator, root);
    defer transfers.deinit();

    try transfers.startWrite(1, .{ .path = "/hello.txt" });
    try testing.expectEqual(Transfers.WriteResult.pending, try transfers.writeData(1, .{ .data = .{ .data = "hello " } }));
    try testing.expectEqual(Transfers.WriteResult.done, try transfers.writeData(1, .{ .data = .{ .data = "world" }, .eof = true }));
    try testing.expect(!transfers.isWriting(1));

    var outbox: Outbox = .init(testing.allocator);
    defer outbox.deinit();
    try transfers.startRead(2, .{ .path = "hello.txt", .cwd = root, .chunk_size = 1024 });
    while (transfers.hasPendingReads()) try transfers.pumpReads(&outbox);

    var reader: shared.framing.FrameReader = .{};
    defer reader.deinit(testing.allocator);
    try reader.feed(testing.allocator, outbox.aw.writer.buffered());
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const data = try protocol.Envelope.decode(arena, (try reader.next()).?);
    try testing.expectEqualStrings("hello world", (try data.payload(arena, .file_read_data)).data.data);
    try testing.expectEqual(protocol.Tag.file_read_done, (try protocol.Envelope.decode(arena, (try reader.next()).?)).tag().?);

    try transfers.delete(.{ .path = "/hello.txt" });
    try testing.expectError(error.FileNotFound, transfers.startRead(3, .{ .path = "/hello.txt" }));
}

test "failed upload discards its remaining frames" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    var transfers: Transfers = .init(testing.allocator, try tmpRoot(&tmp, &root_buf));
    defer transfers.deinit();

    try testing.expectError(error.FileNotFound, transfers.startWrite(5, .{ .path = "/missing/dir/file" }));
    try testing.expect(transfers.isWriting(5));
    try testing.expectEqual(Transfers.WriteResult.discarded, try transfers.writeData(5, .{ .data = .{ .data = "x" } }));
    try testing.expectEqual(Transfers.WriteResult.discarded, try transfers.writeData(5, .{ .data = .{ .data = "" }, .eof = true }));
    try testing.expect(!transfers.isWriting(5));
}
