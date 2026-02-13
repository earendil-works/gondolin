//! sandboxd handlers for guest-side file operations

const std = @import("std");
const sandboxd = @import("sandboxd");

const protocol = sandboxd.protocol;
const request_path = sandboxd.request_path;

pub fn handleFileRead(
    allocator: std.mem.Allocator,
    tx: anytype,
    root_dir: []const u8,
    req: protocol.FileReadRequest,
) !void {
    const resolved_path = try request_path.resolveRequestPathInRoot(allocator, root_dir, req.path, req.cwd);
    defer allocator.free(resolved_path);

    var file = try std.fs.openFileAbsolute(resolved_path, .{});
    defer file.close();

    const chunk_size: usize = @intCast(req.chunk_size);
    const buffer = try allocator.alloc(u8, chunk_size);
    defer allocator.free(buffer);

    while (true) {
        const n = try file.read(buffer);
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
    virtio_fd: std.posix.fd_t,
    tx: anytype,
    root_dir: []const u8,
    req: protocol.FileWriteRequest,
) !void {
    const resolved_path = try request_path.resolveRequestPathInRoot(allocator, root_dir, req.path, req.cwd);
    defer allocator.free(resolved_path);

    var file = try std.fs.createFileAbsolute(resolved_path, .{ .truncate = req.truncate });
    defer file.close();

    while (true) {
        const frame = try protocol.readFrame(allocator, virtio_fd);
        defer allocator.free(frame);

        const input = try protocol.decodeFileWriteData(allocator, frame, req.id);
        if (input.data.len > 0) {
            try file.writeAll(input.data);
        }
        if (input.eof) break;
    }

    const done_payload = try protocol.encodeFileWriteDone(allocator, req.id);
    defer allocator.free(done_payload);
    try tx.sendPayload(done_payload);
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
        std.fs.deleteTreeAbsolute(resolved_path) catch |err| switch (err) {
            error.FileNotFound => {
                if (!req.force) return err;
            },
            else => return err,
        };
    } else {
        std.fs.deleteFileAbsolute(resolved_path) catch |err| switch (err) {
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
