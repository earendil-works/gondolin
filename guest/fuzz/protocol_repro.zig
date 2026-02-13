const std = @import("std");
const sandboxd = @import("sandboxd");

const protocol = sandboxd.protocol;

fn beU32Prefix(input: []const u8) u32 {
    if (input.len < 4) return 0;
    return (@as(u32, input[0]) << 24) |
        (@as(u32, input[1]) << 16) |
        (@as(u32, input[2]) << 8) |
        @as(u32, input[3]);
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
    const slice = if (data.len > 16 * 1024) data[0 .. 16 * 1024] else data;
    const expected_id = beU32Prefix(slice);

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();

    const a = arena.allocator();

    _ = protocol.decodeExecRequest(a, slice) catch {};
    _ = protocol.decodeFileReadRequest(a, slice) catch {};
    _ = protocol.decodeFileWriteRequest(a, slice) catch {};
    _ = protocol.decodeFileDeleteRequest(a, slice) catch {};
    _ = protocol.decodeRoutedInputMessage(a, slice) catch {};
    _ = protocol.decodeTcpMessage(a, slice) catch {};

    // Decoders that validate against an expected id
    _ = protocol.decodeStdinData(a, slice, expected_id) catch {};
    _ = protocol.decodeInputMessage(a, slice, expected_id) catch {};
    _ = protocol.decodeFileWriteData(a, slice, expected_id) catch {};
}
