const std = @import("std");
const sandboxd = @import("sandboxd");

const cbor = sandboxd.cbor;

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

    // Keep behavior consistent with the fuzz harness.
    const slice = if (data.len > 4096) data[0..4096] else data;

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();

    var dec = cbor.Decoder.init(arena.allocator(), slice);
    const value = dec.decodeValue() catch return;
    cbor.freeValue(arena.allocator(), value);
}
