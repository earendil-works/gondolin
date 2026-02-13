const std = @import("std");

pub const Error = error{
    EndOfBuffer,
    Malformed,
    Unsupported,
    Overflow,
    /// nesting exceeds `Decoder.max_depth`
    RecursionLimit,
    /// requested container allocation exceeds `Decoder.max_alloc_bytes`
    AllocationTooLarge,
};

pub const Value = union(enum) {
    Int: i64,
    Bytes: []const u8,
    Text: []const u8,
    Array: []Value,
    Map: []Entry,
    Bool: bool,
    Null: void,
};

pub const Entry = struct {
    /// map key
    key: Value,
    /// map value
    value: Value,
};

pub const Decoder = struct {
    /// allocator used for arrays/maps
    allocator: std.mem.Allocator,
    /// input buffer
    buf: []const u8,
    /// current read offset in `bytes`
    pos: usize = 0,

    /// maximum nesting depth
    max_depth: usize = 64,
    /// maximum allocation size for a single array/map backing store in `bytes`
    max_alloc_bytes: usize = 8 * 1024 * 1024,

    pub fn init(allocator: std.mem.Allocator, buf: []const u8) Decoder {
        return .{ .allocator = allocator, .buf = buf, .pos = 0 };
    }

    fn readByte(self: *Decoder) !u8 {
        if (self.pos >= self.buf.len) return Error.EndOfBuffer;
        const b = self.buf[self.pos];
        self.pos += 1;
        return b;
    }

    fn readN(self: *Decoder, n: usize) ![]const u8 {
        // Avoid integer overflow when computing `pos + n`.
        if (n > self.buf.len - self.pos) return Error.EndOfBuffer;
        const slice = self.buf[self.pos..][0..n];
        self.pos += n;
        return slice;
    }

    fn readUIntN(self: *Decoder, n: usize) !u64 {
        const bytes = try self.readN(n);
        var value: u64 = 0;
        for (bytes) |b| {
            value = (value << 8) | b;
        }
        return value;
    }

    fn readUInt(self: *Decoder, add: u8) !u64 {
        if (add < 24) return add;
        return switch (add) {
            24 => try self.readUIntN(1),
            25 => try self.readUIntN(2),
            26 => try self.readUIntN(4),
            27 => try self.readUIntN(8),
            31 => Error.Unsupported, // indefinite length
            else => Error.Malformed,
        };
    }

    pub fn decodeValue(self: *Decoder) !Value {
        return self.decodeValueDepth(self.max_depth);
    }

    fn decodeValueDepth(self: *Decoder, depth: usize) !Value {
        if (depth == 0) return Error.RecursionLimit;

        const head = try self.readByte();
        const major: u8 = head >> 5;
        const add: u8 = head & 0x1f;

        return switch (major) {
            0 => blk: {
                const value = try self.readUInt(add);
                if (value > std.math.maxInt(i64)) return Error.Overflow;
                break :blk Value{ .Int = @as(i64, @intCast(value)) };
            },
            1 => blk: {
                const value = try self.readUInt(add);
                if (value > std.math.maxInt(i64)) return Error.Overflow;
                const neg = -1 - @as(i64, @intCast(value));
                break :blk Value{ .Int = neg };
            },
            2 => blk: {
                const len = try self.readUInt(add);
                if (len > std.math.maxInt(usize)) return Error.Overflow;
                const data = try self.readN(@as(usize, @intCast(len)));
                break :blk Value{ .Bytes = data };
            },
            3 => blk: {
                const len = try self.readUInt(add);
                if (len > std.math.maxInt(usize)) return Error.Overflow;
                const data = try self.readN(@as(usize, @intCast(len)));
                break :blk Value{ .Text = data };
            },
            4 => blk: {
                const len = try self.readUInt(add);
                if (len > std.math.maxInt(usize)) return Error.Overflow;
                const count = @as(usize, @intCast(len));

                // Even in the best case each item consumes at least one byte.
                if (count > self.buf.len - self.pos) return Error.EndOfBuffer;

                const max_count = self.max_alloc_bytes / @sizeOf(Value);
                if (count > max_count) return Error.AllocationTooLarge;

                // Guard against allocator/internal sizing overflow.
                _ = std.math.mul(usize, count, @sizeOf(Value)) catch return Error.Overflow;

                const items = try self.allocator.alloc(Value, count);
                var filled: usize = 0;
                errdefer {
                    for (items[0..filled]) |item| freeValue(self.allocator, item);
                    self.allocator.free(items);
                }

                for (items, 0..) |*item, idx| {
                    item.* = try self.decodeValueDepth(depth - 1);
                    filled = idx + 1;
                }
                break :blk Value{ .Array = items };
            },
            5 => blk: {
                const len = try self.readUInt(add);
                if (len > std.math.maxInt(usize)) return Error.Overflow;
                const count = @as(usize, @intCast(len));

                const remaining = self.buf.len - self.pos;
                // Each entry contains a key and value (>= 1 byte each).
                if (count > remaining / 2) return Error.EndOfBuffer;

                const max_count = self.max_alloc_bytes / @sizeOf(Entry);
                if (count > max_count) return Error.AllocationTooLarge;

                _ = std.math.mul(usize, count, @sizeOf(Entry)) catch return Error.Overflow;

                const entries = try self.allocator.alloc(Entry, count);
                var filled: usize = 0;
                errdefer {
                    for (entries[0..filled]) |entry| {
                        freeValue(self.allocator, entry.key);
                        freeValue(self.allocator, entry.value);
                    }
                    self.allocator.free(entries);
                }

                for (entries, 0..) |*entry, idx| {
                    entry.* = .{
                        .key = try self.decodeValueDepth(depth - 1),
                        .value = try self.decodeValueDepth(depth - 1),
                    };
                    filled = idx + 1;
                }
                break :blk Value{ .Map = entries };
            },
            7 => blk: {
                switch (add) {
                    20 => break :blk Value{ .Bool = false },
                    21 => break :blk Value{ .Bool = true },
                    22 => break :blk Value{ .Null = {} },
                    else => return Error.Unsupported,
                }
            },
            else => Error.Unsupported,
        };
    }
};

pub fn freeValue(allocator: std.mem.Allocator, value: Value) void {
    switch (value) {
        .Array => |items| {
            for (items) |item| {
                freeValue(allocator, item);
            }
            allocator.free(items);
        },
        .Map => |entries| {
            for (entries) |entry| {
                freeValue(allocator, entry.key);
                freeValue(allocator, entry.value);
            }
            allocator.free(entries);
        },
        else => {},
    }
}

pub fn getMapValue(map: []Entry, key: []const u8) ?Value {
    for (map) |entry| {
        if (entry.key == .Text and std.mem.eql(u8, entry.key.Text, key)) {
            return entry.value;
        }
    }
    return null;
}

fn writeUIntBE(writer: anytype, value: u64, n: u8) !void {
    var i: u8 = 0;
    while (i < n) : (i += 1) {
        const shift: u6 = @intCast((n - 1 - i) * 8);
        const byte = @as(u8, @intCast((value >> shift) & 0xff));
        try writer.writeByte(byte);
    }
}

fn writeTypeAndLen(writer: anytype, major: u8, len: u64) !void {
    if (len < 24) {
        const add: u8 = @intCast(len);
        const head: u8 = @intCast((major << 5) | add);
        try writer.writeByte(head);
    } else if (len <= 0xff) {
        const head: u8 = @intCast((major << 5) | 24);
        try writer.writeByte(head);
        try writeUIntBE(writer, len, 1);
    } else if (len <= 0xffff) {
        const head: u8 = @intCast((major << 5) | 25);
        try writer.writeByte(head);
        try writeUIntBE(writer, len, 2);
    } else if (len <= 0xffff_ffff) {
        const head: u8 = @intCast((major << 5) | 26);
        try writer.writeByte(head);
        try writeUIntBE(writer, len, 4);
    } else {
        const head: u8 = @intCast((major << 5) | 27);
        try writer.writeByte(head);
        try writeUIntBE(writer, len, 8);
    }
}

pub fn writeUInt(writer: anytype, value: u64) !void {
    try writeTypeAndLen(writer, 0, value);
}

pub fn writeInt(writer: anytype, value: i64) !void {
    if (value >= 0) {
        try writeTypeAndLen(writer, 0, @as(u64, @intCast(value)));
    } else {
        const encoded = @as(u64, @intCast(-(value + 1)));
        try writeTypeAndLen(writer, 1, encoded);
    }
}

pub fn writeBytes(writer: anytype, data: []const u8) !void {
    try writeTypeAndLen(writer, 2, data.len);
    try writer.writeAll(data);
}

pub fn writeText(writer: anytype, text: []const u8) !void {
    try writeTypeAndLen(writer, 3, text.len);
    try writer.writeAll(text);
}

pub fn writeArrayStart(writer: anytype, len: usize) !void {
    try writeTypeAndLen(writer, 4, @as(u64, @intCast(len)));
}

pub fn writeMapStart(writer: anytype, len: usize) !void {
    try writeTypeAndLen(writer, 5, @as(u64, @intCast(len)));
}

pub fn writeBool(writer: anytype, value: bool) !void {
    const add: u8 = if (value) 21 else 20;
    const head: u8 = @intCast((7 << 5) | add);
    try writer.writeByte(head);
}

pub fn writeNull(writer: anytype) !void {
    const head: u8 = @intCast((7 << 5) | 22);
    try writer.writeByte(head);
}

const testing = std.testing;

test "encode/decode simple map" {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(testing.allocator);

    const w = buf.writer(testing.allocator);
    try writeMapStart(w, 2);
    try writeText(w, "t");
    try writeText(w, "exec_request");
    try writeText(w, "id");
    try writeUInt(w, 42);

    var dec = Decoder.init(testing.allocator, buf.items);
    const value = try dec.decodeValue();
    defer freeValue(testing.allocator, value);

    switch (value) {
        .Map => |map| {
            const t_val = getMapValue(map, "t") orelse return error.TestUnexpectedResult;
            const id_val = getMapValue(map, "id") orelse return error.TestUnexpectedResult;

            switch (t_val) {
                .Text => |text| try testing.expect(std.mem.eql(u8, text, "exec_request")),
                else => return error.TestUnexpectedResult,
            }

            switch (id_val) {
                .Int => |int| try testing.expectEqual(@as(i64, 42), int),
                else => return error.TestUnexpectedResult,
            }
        },
        else => return error.TestUnexpectedResult,
    }
}

test "decode rejects absurd array length" {
    // 0x9b = array with 8-byte length
    const buf: []const u8 = &.{
        0x9b,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
    };

    var dec = Decoder.init(testing.allocator, buf);
    try testing.expectError(Error.EndOfBuffer, dec.decodeValue());
}

test "decode rejects array allocation too large" {
    // Array(100) followed by 100 integers(0)
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(testing.allocator);

    try buf.appendSlice(testing.allocator, &.{ 0x98, 0x64 });
    try buf.appendNTimes(testing.allocator, 0x00, 100);

    var dec = Decoder.init(testing.allocator, buf.items);
    dec.max_alloc_bytes = 1024;

    try testing.expectError(Error.AllocationTooLarge, dec.decodeValue());
}
