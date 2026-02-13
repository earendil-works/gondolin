const std = @import("std");
const sandboxd = @import("sandboxd");
const file_requests = @import("file_requests");

const protocol = sandboxd.protocol;

const root_dir = "/tmp/gondolin-sandbox-fuzz";

const TxSink = struct {
    bytes_sent: usize = 0,

    pub fn sendPayload(self: *TxSink, payload: []const u8) !void {
        // Keep payload referenced so the optimizer cannot drop encoding paths.
        self.bytes_sent +%= payload.len;
        std.mem.doNotOptimizeAway(payload.ptr);
    }
};

fn writeU32be(buf: []u8, value: u32) void {
    buf[0] = @intCast((value >> 24) & 0xff);
    buf[1] = @intCast((value >> 16) & 0xff);
    buf[2] = @intCast((value >> 8) & 0xff);
    buf[3] = @intCast(value & 0xff);
}

fn sanitizeFramedInput(buf: []u8, max_frame: usize) void {
    var off: usize = 0;
    while (off + 4 <= buf.len) {
        const remaining = buf.len - off;
        if (remaining <= 4) break;

        const len: u32 = (@as(u32, buf[off]) << 24) |
            (@as(u32, buf[off + 1]) << 16) |
            (@as(u32, buf[off + 2]) << 8) |
            @as(u32, buf[off + 3]);

        const max_allowed = @min(max_frame, remaining - 4);
        const new_len: u32 = @intCast(@min(@as(usize, len), max_allowed));
        writeU32be(buf[off .. off + 4], new_len);

        off += 4 + @as(usize, new_len);
    }
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    if (args.len != 2) {
        std.debug.print("usage: {s} <input-file>\n", .{args[0]});
        return error.InvalidArgs;
    }

    const input_path = args[1];
    const data = try std.fs.cwd().readFileAlloc(allocator, input_path, 1 << 20);
    defer allocator.free(data);

    // Keep behavior consistent with the fuzz harness.
    const slice = if (data.len > 64 * 1024) data[0 .. 64 * 1024] else data;

    // Ensure root exists once during setup. The input may delete it.
    std.fs.cwd().makePath(root_dir) catch {};

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const owned = try a.alloc(u8, slice.len);
    @memcpy(owned, slice);
    sanitizeFramedInput(owned, 16 * 1024);

    const pipe_fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(pipe_fds[0]);

    protocol.writeAll(pipe_fds[1], owned) catch {};
    std.posix.close(pipe_fds[1]);

    var tx = TxSink{};

    while (true) {
        const frame = protocol.readFrame(a, pipe_fds[0]) catch |err| switch (err) {
            error.EndOfStream => break,
            else => break,
        };
        defer a.free(frame);

        const file_read_req = protocol.decodeFileReadRequest(a, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => null,
        };
        if (file_read_req) |req| {
            file_requests.handleFileRead(a, &tx, root_dir, req) catch {};
            continue;
        }

        const file_write_req = protocol.decodeFileWriteRequest(a, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => null,
        };
        if (file_write_req) |req| {
            file_requests.handleFileWrite(a, pipe_fds[0], &tx, root_dir, req) catch {};
            continue;
        }

        const file_delete_req = protocol.decodeFileDeleteRequest(a, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => null,
        };
        if (file_delete_req) |req| {
            file_requests.handleFileDelete(a, &tx, root_dir, req) catch {};
            continue;
        }

        // Ignore any other message types.
    }

    std.mem.doNotOptimizeAway(tx.bytes_sent);
}
