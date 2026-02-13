const std = @import("std");
const builtin = @import("builtin");
const sandboxd = @import("sandboxd");
const file_requests = @import("file_requests");

const protocol = sandboxd.protocol;
const cbor = sandboxd.cbor;

const CacheDirArg = "--cache-dir=";

fn ensureFuzzTmpDir() void {
    @disableInstrumentation();

    var it = std.process.args();
    _ = it.next();
    while (it.next()) |arg| {
        if (std.mem.startsWith(u8, arg, CacheDirArg)) {
            const cache_dir = arg[CacheDirArg.len..];
            var dir = std.fs.cwd().makeOpenPath(cache_dir, .{ .iterate = true }) catch return;
            defer dir.close();
            dir.makePath("tmp") catch {};
            return;
        }
    }
}

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
    @disableInstrumentation();

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

fn buildSeedStream(allocator: std.mem.Allocator, root_path: []const u8) ![]u8 {
    var out = std.ArrayList(u8).empty;

    const appendFrame = struct {
        fn f(list: *std.ArrayList(u8), alloc: std.mem.Allocator, payload: []const u8) !void {
            var len_buf: [4]u8 = undefined;
            writeU32be(len_buf[0..], @intCast(payload.len));
            try list.appendSlice(alloc, &len_buf);
            try list.appendSlice(alloc, payload);
        }
    }.f;

    // file_write_request(id=1, path="hello.txt", cwd=root_dir)
    {
        var payload = std.ArrayList(u8).empty;
        const w = payload.writer(allocator);
        try cbor.writeMapStart(w, 4);
        try cbor.writeText(w, "v");
        try cbor.writeUInt(w, 1);
        try cbor.writeText(w, "t");
        try cbor.writeText(w, "file_write_request");
        try cbor.writeText(w, "id");
        try cbor.writeUInt(w, 1);
        try cbor.writeText(w, "p");
        try cbor.writeMapStart(w, 3);
        try cbor.writeText(w, "path");
        try cbor.writeText(w, "hello.txt");
        try cbor.writeText(w, "cwd");
        try cbor.writeText(w, root_path);
        try cbor.writeText(w, "truncate");
        try cbor.writeBool(w, true);

        const bytes = try payload.toOwnedSlice(allocator);
        try appendFrame(&out, allocator, bytes);
        allocator.free(bytes);
    }

    // file_write_data(id=1, data="hi", eof=true)
    {
        var payload = std.ArrayList(u8).empty;
        const w = payload.writer(allocator);
        try cbor.writeMapStart(w, 4);
        try cbor.writeText(w, "v");
        try cbor.writeUInt(w, 1);
        try cbor.writeText(w, "t");
        try cbor.writeText(w, "file_write_data");
        try cbor.writeText(w, "id");
        try cbor.writeUInt(w, 1);
        try cbor.writeText(w, "p");
        try cbor.writeMapStart(w, 2);
        try cbor.writeText(w, "data");
        try cbor.writeBytes(w, "hi");
        try cbor.writeText(w, "eof");
        try cbor.writeBool(w, true);

        const bytes = try payload.toOwnedSlice(allocator);
        try appendFrame(&out, allocator, bytes);
        allocator.free(bytes);
    }

    // file_read_request(id=2, path="hello.txt", cwd=root_dir, chunk_size=1024)
    {
        var payload = std.ArrayList(u8).empty;
        const w = payload.writer(allocator);
        try cbor.writeMapStart(w, 4);
        try cbor.writeText(w, "v");
        try cbor.writeUInt(w, 1);
        try cbor.writeText(w, "t");
        try cbor.writeText(w, "file_read_request");
        try cbor.writeText(w, "id");
        try cbor.writeUInt(w, 2);
        try cbor.writeText(w, "p");
        try cbor.writeMapStart(w, 3);
        try cbor.writeText(w, "path");
        try cbor.writeText(w, "hello.txt");
        try cbor.writeText(w, "cwd");
        try cbor.writeText(w, root_path);
        try cbor.writeText(w, "chunk_size");
        try cbor.writeUInt(w, 1024);

        const bytes = try payload.toOwnedSlice(allocator);
        try appendFrame(&out, allocator, bytes);
        allocator.free(bytes);
    }

    // file_delete_request(id=3, path="hello.txt", cwd=root_dir, force=true)
    {
        var payload = std.ArrayList(u8).empty;
        const w = payload.writer(allocator);
        try cbor.writeMapStart(w, 4);
        try cbor.writeText(w, "v");
        try cbor.writeUInt(w, 1);
        try cbor.writeText(w, "t");
        try cbor.writeText(w, "file_delete_request");
        try cbor.writeText(w, "id");
        try cbor.writeUInt(w, 3);
        try cbor.writeText(w, "p");
        try cbor.writeMapStart(w, 4);
        try cbor.writeText(w, "path");
        try cbor.writeText(w, "hello.txt");
        try cbor.writeText(w, "cwd");
        try cbor.writeText(w, root_path);
        try cbor.writeText(w, "force");
        try cbor.writeBool(w, true);
        try cbor.writeText(w, "recursive");
        try cbor.writeBool(w, false);

        const bytes = try payload.toOwnedSlice(allocator);
        try appendFrame(&out, allocator, bytes);
        allocator.free(bytes);
    }

    return try out.toOwnedSlice(allocator);
}

const root_dir = "/tmp/gondolin-sandbox-fuzz";

test "sandbox behavior (file requests)" {
    if (builtin.fuzz) {
        if (@extern(*const fn ([*]const u8, usize) callconv(.c) void, .{
            .name = "fuzzer_set_name",
            .linkage = .weak,
        })) |set_name| {
            set_name("sandbox_behavior".ptr, "sandbox_behavior".len);
        }
        ensureFuzzTmpDir();
    }

    // Ensure root exists once during setup. Individual iterations may delete it.
    {
        @disableInstrumentation();
        try std.fs.cwd().makePath(root_dir);
    }

    const seed_stream = try buildSeedStream(std.testing.allocator, root_dir);
    defer std.testing.allocator.free(seed_stream);

    const seeds: []const []const u8 = &.{seed_stream};
    try std.testing.fuzz({}, testOne, .{ .corpus = seeds });
}

fn testOne(_: void, input: []const u8) anyerror!void {
    const slice = if (input.len > 64 * 1024) input[0 .. 64 * 1024] else input;

    // Sanitize the framed input to avoid OOM / blocking reads due to bogus length prefixes.
    //
    // Note: in fuzz mode the Zig test runner already resets/leak-checks `std.testing.allocator`
    // per input. Using an arena on top keeps per-iteration allocations bounded without
    // tripping the runner's "error logs detected" guard on allocator leak reports.
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const owned = try allocator.alloc(u8, slice.len);
    defer allocator.free(owned);
    @memcpy(owned, slice);
    sanitizeFramedInput(owned, 16 * 1024);

    // Recreate root if a prior iteration deleted it.
    {
        @disableInstrumentation();
        std.fs.cwd().makePath(root_dir) catch {};
    }

    const pipe_fds = try std.posix.pipe2(.{ .CLOEXEC = true });
    defer std.posix.close(pipe_fds[0]);

    protocol.writeAll(pipe_fds[1], owned) catch {};
    std.posix.close(pipe_fds[1]);

    var tx = TxSink{};

    while (true) {
        const frame = protocol.readFrame(allocator, pipe_fds[0]) catch |err| switch (err) {
            error.EndOfStream => break,
            else => break,
        };
        defer allocator.free(frame);

        const file_read_req = protocol.decodeFileReadRequest(allocator, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => null,
        };
        if (file_read_req) |req| {
            file_requests.handleFileRead(allocator, &tx, root_dir, req) catch {};
            continue;
        }

        const file_write_req = protocol.decodeFileWriteRequest(allocator, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => null,
        };
        if (file_write_req) |req| {
            file_requests.handleFileWrite(allocator, pipe_fds[0], &tx, root_dir, req) catch {};
            continue;
        }

        const file_delete_req = protocol.decodeFileDeleteRequest(allocator, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => null,
        };
        if (file_delete_req) |req| {
            file_requests.handleFileDelete(allocator, &tx, root_dir, req) catch {};
            continue;
        }

        // Ignore any other message types.
    }

    std.mem.doNotOptimizeAway(tx.bytes_sent);
}
