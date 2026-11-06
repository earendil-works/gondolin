//! Kernel image format detection for libkrun boot assets.
//!
//! libkrun's `PE_GZ` format is aarch64/riscv64 only; x86_64 bzImages have the
//! same `MZ` prefix but must be reported as a compressed `Image-*` payload.

const std = @import("std");

const krun = @import("libkrun.zig");

/// Upper bound for kernel images read while locating a compressed payload
pub const MAX_KERNEL_IMAGE_BYTES = 128 * 1024 * 1024;

const CompressedPayload = struct {
    format: u32,
    magic: []const u8,
};

/// Compressed payloads libkrun decompresses for `KRUN_KERNEL_FORMAT_IMAGE_*`
const x86_payloads = [_]CompressedPayload{
    .{ .format = krun.KERNEL_FORMAT_IMAGE_GZ, .magic = &[_]u8{ 0x1f, 0x8b, 0x08 } },
    .{ .format = krun.KERNEL_FORMAT_IMAGE_BZ2, .magic = "BZh" },
    .{ .format = krun.KERNEL_FORMAT_IMAGE_ZSTD, .magic = &[_]u8{ 0x28, 0xb5, 0x2f, 0xfd } },
};

/// Format of the compressed payload inside an x86_64 bzImage, or null when the
/// image holds none of the streams libkrun can decompress. libkrun uses the
/// first matching magic number, so report the earliest payload.
pub fn detectX86Payload(data: []const u8) ?u32 {
    var payload_offset: ?usize = null;
    var payload_format: u32 = krun.KERNEL_FORMAT_RAW;

    for (x86_payloads) |payload| {
        const offset = std.mem.indexOf(u8, data, payload.magic) orelse continue;
        if (payload_offset == null or offset < payload_offset.?) {
            payload_offset = offset;
            payload_format = payload.format;
        }
    }

    if (payload_offset == null) return null;
    return payload_format;
}

test "detectX86Payload finds the gzip payload behind a PE header" {
    var image: [32]u8 = @splat(0);
    image[0] = 'M';
    image[1] = 'Z';
    @memcpy(image[8..11], &[_]u8{ 0x1f, 0x8b, 0x08 });

    try std.testing.expectEqual(
        @as(?u32, krun.KERNEL_FORMAT_IMAGE_GZ),
        detectX86Payload(&image),
    );
}

test "detectX86Payload reports the earliest payload" {
    var image: [32]u8 = @splat(0);
    @memcpy(image[4..8], &[_]u8{ 0x28, 0xb5, 0x2f, 0xfd });
    @memcpy(image[16..19], &[_]u8{ 0x1f, 0x8b, 0x08 });

    try std.testing.expectEqual(
        @as(?u32, krun.KERNEL_FORMAT_IMAGE_ZSTD),
        detectX86Payload(&image),
    );
}

test "detectX86Payload finds bzip2 payloads" {
    const image = "MZ\x00\x00payload BZh9";
    try std.testing.expectEqual(
        @as(?u32, krun.KERNEL_FORMAT_IMAGE_BZ2),
        detectX86Payload(image),
    );
}

test "detectX86Payload returns null without a known payload" {
    var image: [16]u8 = @splat(0);
    image[0] = 'M';
    image[1] = 'Z';

    try std.testing.expectEqual(@as(?u32, null), detectX86Payload(&image));
}
