const std = @import("std");
const builtin = @import("builtin");
const sandboxd = @import("sandboxd");

const protocol = sandboxd.protocol;

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

// Seed corpus entries (CBOR payload frames)
const seed_exec_request = [_]u8{
    0xA4, 0x61, 0x76, 0x01, 0x61, 0x74, 0x6C, 0x65, 0x78, 0x65, 0x63, 0x5F, 0x72, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74, 0x62, 0x69, 0x64, 0x01, 0x61, 0x70, 0xA5, 0x63, 0x63, 0x6D, 0x64, 0x69, 0x2F, 0x62, 0x69, 0x6E, 0x2F, 0x65, 0x63, 0x68, 0x6F, 0x64, 0x61, 0x72, 0x67, 0x76, 0x81, 0x65, 0x68, 0x65, 0x6C, 0x6C, 0x6F, 0x63, 0x65, 0x6E, 0x76, 0x81, 0x63, 0x41, 0x3D, 0x42, 0x65, 0x73, 0x74, 0x64, 0x69, 0x6E, 0xF4, 0x63, 0x70, 0x74, 0x79, 0xF4,
};

const seed_file_read_request = [_]u8{
    0xA4, 0x61, 0x76, 0x01, 0x61, 0x74, 0x71, 0x66, 0x69, 0x6C, 0x65, 0x5F, 0x72, 0x65, 0x61, 0x64, 0x5F, 0x72, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74, 0x62, 0x69, 0x64, 0x02, 0x61, 0x70, 0xA2, 0x64, 0x70, 0x61, 0x74, 0x68, 0x6D, 0x2F, 0x65, 0x74, 0x63, 0x2F, 0x68, 0x6F, 0x73, 0x74, 0x6E, 0x61, 0x6D, 0x65, 0x6A, 0x63, 0x68, 0x75, 0x6E, 0x6B, 0x5F, 0x73, 0x69, 0x7A, 0x65, 0x19, 0x10, 0x00,
};

const seed_tcp_open = [_]u8{
    0xA4, 0x61, 0x76, 0x01, 0x61, 0x74, 0x68, 0x74, 0x63, 0x70, 0x5F, 0x6F, 0x70, 0x65, 0x6E, 0x62, 0x69, 0x64, 0x03, 0x61, 0x70, 0xA2, 0x64, 0x68, 0x6F, 0x73, 0x74, 0x69, 0x31, 0x32, 0x37, 0x2E, 0x30, 0x2E, 0x30, 0x2E, 0x31, 0x64, 0x70, 0x6F, 0x72, 0x74, 0x18, 0x50,
};

// Fuzz protocol decoding (guest/src/shared/protocol.zig)
//
// Build:  make fuzz
// Run:    make fuzz-protocol
test "protocol decode" {
    if (builtin.fuzz) {
        if (@extern(*const fn ([*]const u8, usize) callconv(.c) void, .{
            .name = "fuzzer_set_name",
            .linkage = .weak,
        })) |set_name| {
            set_name("protocol_decode".ptr, "protocol_decode".len);
        }
        ensureFuzzTmpDir();
    }

    const seeds: []const []const u8 = &.{
        &seed_exec_request,
        &seed_file_read_request,
        &seed_tcp_open,
    };

    try std.testing.fuzz({}, testOne, .{ .corpus = seeds });
}

fn beU32Prefix(input: []const u8) u32 {
    if (input.len < 4) return 0;
    return (@as(u32, input[0]) << 24) |
        (@as(u32, input[1]) << 16) |
        (@as(u32, input[2]) << 8) |
        @as(u32, input[3]);
}

fn testOne(_: void, input: []const u8) anyerror!void {
    const slice = if (input.len > 16 * 1024) input[0 .. 16 * 1024] else input;

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const allocator = arena.allocator();
    const expected_id = beU32Prefix(slice);

    _ = protocol.decodeExecRequest(allocator, slice) catch {};
    _ = protocol.decodeFileReadRequest(allocator, slice) catch {};
    _ = protocol.decodeFileWriteRequest(allocator, slice) catch {};
    _ = protocol.decodeFileDeleteRequest(allocator, slice) catch {};
    _ = protocol.decodeRoutedInputMessage(allocator, slice) catch {};
    _ = protocol.decodeTcpMessage(allocator, slice) catch {};

    // Decoders that validate against an expected id
    _ = protocol.decodeStdinData(allocator, slice, expected_id) catch {};
    _ = protocol.decodeInputMessage(allocator, slice, expected_id) catch {};
    _ = protocol.decodeFileWriteData(allocator, slice, expected_id) catch {};
}
