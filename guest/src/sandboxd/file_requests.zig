//! sandboxd handlers for guest-side file operations

const std = @import("std");
const sandboxd = @import("sandboxd");

const protocol = sandboxd.protocol;
const request_path = sandboxd.request_path;
const posix = sandboxd.posix;

pub fn handleFileRead(
    allocator: std.mem.Allocator,
    tx: anytype,
    root_dir: []const u8,
    req: protocol.FileReadRequest,
) !void {
    const resolved_path = try request_path.resolveRequestPathInRoot(allocator, root_dir, req.path, req.cwd);
    defer allocator.free(resolved_path);

    const fd = try posix.open(resolved_path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0);
    defer posix.close(fd);

    const chunk_size: usize = @intCast(req.chunk_size);
    const buffer = try allocator.alloc(u8, chunk_size);
    defer allocator.free(buffer);

    while (true) {
        const n = try posix.read(fd, buffer);
        if (n == 0) break;

        const payload = try protocol.encodeFileReadData(allocator, req.id, buffer[0..n]);
        defer allocator.free(payload);
        try tx.sendPayload(payload);
    }

    const done_payload = try protocol.encodeFileReadDone(allocator, req.id);
    defer allocator.free(done_payload);
    try tx.sendPayload(done_payload);
}

pub fn handleFileWrite(
    allocator: std.mem.Allocator,
    virtio_fd: posix.fd_t,
    tx: anytype,
    root_dir: []const u8,
    req: protocol.FileWriteRequest,
) !void {
    const resolved_path = try request_path.resolveRequestPathInRoot(allocator, root_dir, req.path, req.cwd);
    defer allocator.free(resolved_path);

    const fd = try posix.open(resolved_path, .{
        .ACCMODE = .WRONLY,
        .CREAT = true,
        .TRUNC = req.truncate,
        .CLOEXEC = true,
    }, 0o666);
    defer posix.close(fd);

    while (true) {
        const frame = try protocol.readFrame(allocator, virtio_fd);
        defer allocator.free(frame);

        const input = try protocol.decodeFileWriteData(allocator, frame, req.id);
        if (input.data.len > 0) {
            try protocol.writeAll(fd, input.data);
        }
        if (input.eof) break;
    }

    const done_payload = try protocol.encodeFileWriteDone(allocator, req.id);
    defer allocator.free(done_payload);
    try tx.sendPayload(done_payload);
}

fn ensureRecursiveDeleteTargetAllowed(resolved_path: []const u8) !void {
    if (std.mem.eql(u8, resolved_path, "/")) return error.CannotDeleteRootDirectory;
}

pub fn handleFileDelete(
    allocator: std.mem.Allocator,
    tx: anytype,
    root_dir: []const u8,
    req: protocol.FileDeleteRequest,
) !void {
    const resolved_path = try request_path.resolveRequestPathInRoot(allocator, root_dir, req.path, req.cwd);
    defer allocator.free(resolved_path);

    if (req.recursive) {
        try ensureRecursiveDeleteTargetAllowed(resolved_path);
        var threaded: std.Io.Threaded = .init_single_threaded;
        const io = threaded.io();
        const cwd = std.Io.Dir.cwd();
        // deleteTree treats a missing root as success; preserve force=false semantics
        if (!req.force) {
            _ = try cwd.statFile(io, resolved_path, .{ .follow_symlinks = false });
        }
        try cwd.deleteTree(io, resolved_path);
    } else {
        posix.unlink(resolved_path) catch |err| switch (err) {
            error.FileNotFound => {
                if (!req.force) return err;
            },
            else => return err,
        };
    }

    const done_payload = try protocol.encodeFileDeleteDone(allocator, req.id);
    defer allocator.free(done_payload);
    try tx.sendPayload(done_payload);
}

test "recursive delete rejects filesystem root" {
    try std.testing.expectError(error.CannotDeleteRootDirectory, ensureRecursiveDeleteTargetAllowed("/"));
    try ensureRecursiveDeleteTargetAllowed("/tmp/gondolin-delete-root-test");
}

test "recursive delete reports missing path unless forced" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root_dir = root_buf[0..try tmp.dir.realPath(std.testing.io, &root_buf)];

    const TestTx = struct {
        payloads: usize = 0,

        pub fn sendPayload(self: *@This(), payload: []const u8) !void {
            _ = payload;
            self.payloads += 1;
        }
    };

    var tx: TestTx = .{};
    try std.testing.expectError(error.FileNotFound, handleFileDelete(std.testing.allocator, &tx, root_dir, .{
        .id = 1,
        .path = "/missing",
        .cwd = null,
        .force = false,
        .recursive = true,
    }));
    try std.testing.expectEqual(@as(usize, 0), tx.payloads);

    try handleFileDelete(std.testing.allocator, &tx, root_dir, .{
        .id = 2,
        .path = "/missing",
        .cwd = null,
        .force = true,
        .recursive = true,
    });
    try std.testing.expectEqual(@as(usize, 1), tx.payloads);
}
