const std = @import("std");
const builtin = @import("builtin");
const shared = @import("shared");
const harness = @import("harness.zig");

const CacheDirArg = "--cache-dir=";

fn ensureFuzzTmpDir() void {
    @disableInstrumentation();

    _ = CacheDirArg;
    std.Io.Dir.cwd().createDirPath(std.testing.io, "/workspace/guest/fuzz/cache/tmp") catch {};
    std.Io.Dir.cwd().createDirPath(std.testing.io, "cache/tmp") catch {};
}

fn smithSliceSeed(allocator: std.mem.Allocator, data: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, 4 + data.len);
    std.mem.writeInt(u32, out[0..4], @intCast(data.len), .little);
    @memcpy(out[4..], data);
    return out;
}

fn buildSeedStream(allocator: std.mem.Allocator, root_path: []const u8) ![]u8 {
    var outbox: shared.framing.Outbox = .init(allocator);
    defer outbox.deinit();
    try outbox.send(.file_write_request, 1, .{ .path = "hello.txt", .cwd = root_path, .truncate = true });
    try outbox.send(.file_write_data, 1, .{ .data = .{ .data = "hi" }, .eof = true });
    try outbox.send(.file_read_request, 2, .{ .path = "hello.txt", .cwd = root_path, .chunk_size = 1024 });
    try outbox.send(.file_delete_request, 3, .{ .path = "hello.txt", .cwd = root_path, .force = true });
    return allocator.dupe(u8, outbox.aw.writer.buffered());
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
        try std.Io.Dir.cwd().createDirPath(std.testing.io, root_dir);
    }

    const seed_stream = try buildSeedStream(std.testing.allocator, root_dir);
    defer std.testing.allocator.free(seed_stream);
    const seed_input = try smithSliceSeed(std.testing.allocator, seed_stream);
    defer std.testing.allocator.free(seed_input);

    const seeds: []const []const u8 = &.{seed_input};
    try std.testing.fuzz({}, testOne, .{ .corpus = seeds });
}

fn testOne(_: void, smith: *std.testing.Smith) anyerror!void {
    var input: [64 * 1024]u8 = undefined;
    const len = smith.slice(&input);

    // Recreate root if a prior iteration deleted it.
    {
        @disableInstrumentation();
        std.Io.Dir.cwd().createDirPath(std.testing.io, root_dir) catch {};
    }

    // Note: in fuzz mode the test runner resets/leak-checks
    // `std.testing.allocator` per input; the harness frees everything it uses.
    harness.sandboxOne(std.testing.allocator, std.testing.io, root_dir, input[0..len]);
}
