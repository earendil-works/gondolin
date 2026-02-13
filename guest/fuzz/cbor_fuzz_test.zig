const std = @import("std");
const builtin = @import("builtin");
const sandboxd = @import("sandboxd");

const cbor = sandboxd.cbor;

const CacheDirArg = "--cache-dir=";

fn ensureFuzzTmpDir() void {
    // The bundled fuzzer runtime logs to "<cache-dir>/tmp/libfuzzer.log" but does not
    // create the tmp directory.
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

const seed_null = [_]u8{0xF6};
const seed_empty_map = [_]u8{0xA0};
const seed_empty_array = [_]u8{0x80};
const seed_uint_0 = [_]u8{0x00};
const seed_text_a = [_]u8{ 0x61, 'a' };

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

    const seeds: []const []const u8 = &.{
        &seed_null,
        &seed_empty_map,
        &seed_empty_array,
        &seed_uint_0,
        &seed_text_a,
    };

    try std.testing.fuzz({}, testOne, .{ .corpus = seeds });
}

fn testOne(_: void, input: []const u8) anyerror!void {
    const slice = if (input.len > 4096) input[0..4096] else input;

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    var dec = cbor.Decoder.init(arena.allocator(), slice);
    const value = dec.decodeValue() catch return;
    cbor.freeValue(arena.allocator(), value);
}
