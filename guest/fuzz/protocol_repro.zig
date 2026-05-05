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

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;
    const args = try init.minimal.args.toSlice(init.arena.allocator());

    if (args.len != 2) {
        std.debug.print("usage: {s} <input-file>\n", .{args[0]});
        return error.InvalidArgs;
    }

    const input_path = args[1];
    const data = try std.Io.Dir.cwd().readFileAlloc(init.io, input_path, allocator, .limited(1 << 20));
    defer allocator.free(data);

    // Keep behavior consistent with the fuzz harness: corpus files are Smith-encoded.
    var smith: std.testing.Smith = .{ .in = data };
    var input: [16 * 1024]u8 = undefined;
    const len = smith.slice(&input);
    const slice = input[0..len];
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
