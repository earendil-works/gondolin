const std = @import("std");
const builtin = @import("builtin");
const sandboxd = @import("sandboxd");

const cbor = sandboxd.cbor;

const CacheDirArg = "--cache-dir=";

fn ensureFuzzTmpDir() void {
    // The bundled fuzzer runtime logs to "<cache-dir>/tmp/libfuzzer.log" but does not
    // create the tmp directory.
    @disableInstrumentation();

    _ = CacheDirArg;
    std.Io.Dir.cwd().createDirPath(std.testing.io, "/workspace/guest/fuzz/cache/tmp") catch {};
    std.Io.Dir.cwd().createDirPath(std.testing.io, "cache/tmp") catch {};
}

const seed_null = [_]u8{0xF6};
const seed_empty_map = [_]u8{0xA0};
const seed_empty_array = [_]u8{0x80};
const seed_uint_0 = [_]u8{0x00};
const seed_text_a = [_]u8{ 0x61, 'a' };

fn smithSliceSeed(allocator: std.mem.Allocator, data: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, 4 + data.len);
    std.mem.writeInt(u32, out[0..4], @intCast(data.len), .little);
    @memcpy(out[4..], data);
    return out;
}

// Fuzz the CBOR decoder (guest/src/shared/cbor.zig)
//
// Build:  make fuzz
// Run:    make fuzz-cbor
//
// Corpus / coverage / log live under the cache dir passed via --cache-dir=...
test "cbor decoder" {
    if (builtin.fuzz) {
        // Normally the test runner sets the unit test name only in server mode.
        // For direct execution we set it ourselves.
        if (@extern(*const fn ([*]const u8, usize) callconv(.c) void, .{
            .name = "fuzzer_set_name",
            .linkage = .weak,
        })) |set_name| {
            set_name("cbor_decoder".ptr, "cbor_decoder".len);
        }
        ensureFuzzTmpDir();
    }

    var seed_inputs = [_][]u8{
        try smithSliceSeed(std.testing.allocator, &seed_null),
        try smithSliceSeed(std.testing.allocator, &seed_empty_map),
        try smithSliceSeed(std.testing.allocator, &seed_empty_array),
        try smithSliceSeed(std.testing.allocator, &seed_uint_0),
        try smithSliceSeed(std.testing.allocator, &seed_text_a),
    };
    defer for (seed_inputs) |seed| std.testing.allocator.free(seed);

    const seeds: []const []const u8 = &seed_inputs;
    try std.testing.fuzz({}, testOne, .{ .corpus = seeds });
}

fn testOne(_: void, smith: *std.testing.Smith) anyerror!void {
    var input: [4096]u8 = undefined;
    const len = smith.slice(&input);
    const slice = input[0..len];

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    var dec = cbor.Decoder.init(arena.allocator(), slice);
    const value = dec.decodeValue() catch return;
    cbor.freeValue(arena.allocator(), value);
}
