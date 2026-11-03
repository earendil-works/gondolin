const std = @import("std");
const harness = @import("harness.zig");

const root_dir = "/tmp/gondolin-sandbox-fuzz";

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
    var input: [64 * 1024]u8 = undefined;
    const len = smith.slice(&input);

    // Ensure root exists once during setup. The input may delete it.
    std.Io.Dir.cwd().createDirPath(init.io, root_dir) catch {};
    harness.sandboxOne(allocator, init.io, root_dir, input[0..len]);
}
