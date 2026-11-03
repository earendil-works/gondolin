//! Minimal CBOR (RFC 8949) codec for the guest protocol.
//!
//! Supported subset: unsigned/negative integers that fit in `i64`, byte and
//! text strings, arrays, maps, `true`, `false` and `null`, all with definite
//! lengths.  Floats, tags, `undefined` and indefinite-length items are
//! rejected with `error.Unsupported`.
//!
//! Decoding is zero-copy for strings: `bytes`/`text` slices alias the input
//! buffer and arrays/maps are allocated from the supplied allocator, which is
//! expected to be an arena that is reset once the message is handled.
//!
//! On top of the dynamic `Value` tree, `parse` maps a value onto a Zig type
//! and `encode` serializes Zig values; both are driven by comptime reflection
//! so protocol messages are declared as plain structs.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Writer = std.Io.Writer;

pub const DecodeError = error{
    EndOfBuffer,
    Malformed,
    Unsupported,
    Overflow,
    /// nesting exceeds `Limits.max_depth`
    RecursionLimit,
    /// one array/map backing store exceeds `Limits.max_alloc_bytes`
    AllocationTooLarge,
} || Allocator.Error;

pub const Limits = struct {
    /// maximum nesting depth of arrays/maps
    max_depth: u32 = 64,
    /// maximum allocation for a single array/map backing store in `bytes`
    max_alloc_bytes: usize = 8 * 1024 * 1024,
};

/// Byte string marker type: `[]const u8` encodes as a text string, `Bytes`
/// as a byte string.
pub const Bytes = struct {
    data: []const u8,
};

pub const Value = union(enum) {
    int: i64,
    bytes: []const u8,
    text: []const u8,
    array: []const Value,
    map: []const Entry,
    bool: bool,
    null,

    /// Look up a text key in a map value; returns null for non-maps.  With
    /// duplicate keys the first occurrence wins.
    pub fn get(self: Value, key: []const u8) ?Value {
        const entries = switch (self) {
            .map => |m| m,
            else => return null,
        };
        for (entries) |entry| {
            if (entry.key == .text and std.mem.eql(u8, entry.key.text, key)) return entry.value;
        }
        return null;
    }
};

pub const Entry = struct {
    key: Value,
    value: Value,
};

/// Decode the first data item in `bytes`.  Trailing bytes are ignored.
pub fn decode(arena: Allocator, bytes: []const u8) DecodeError!Value {
    return decodeWithLimits(arena, bytes, .{});
}

pub fn decodeWithLimits(arena: Allocator, bytes: []const u8, limits: Limits) DecodeError!Value {
    var d: Decoder = .{ .arena = arena, .buf = bytes, .limits = limits };
    return d.value(limits.max_depth);
}

const Decoder = struct {
    arena: Allocator,
    buf: []const u8,
    pos: usize = 0,
    limits: Limits,

    fn remaining(d: *const Decoder) usize {
        return d.buf.len - d.pos;
    }

    fn take(d: *Decoder, n: usize) DecodeError![]const u8 {
        if (n > d.remaining()) return error.EndOfBuffer;
        defer d.pos += n;
        return d.buf[d.pos..][0..n];
    }

    fn argument(d: *Decoder, info: u5) DecodeError!u64 {
        return switch (info) {
            0...23 => info,
            24 => (try d.take(1))[0],
            25 => std.mem.readInt(u16, (try d.take(2))[0..2], .big),
            26 => std.mem.readInt(u32, (try d.take(4))[0..4], .big),
            27 => std.mem.readInt(u64, (try d.take(8))[0..8], .big),
            31 => error.Unsupported, // indefinite length
            else => error.Malformed,
        };
    }

    /// Element count for a container; rejects counts that cannot possibly be
    /// satisfied by the remaining input (every item takes at least one byte)
    /// before allocating.
    fn count(d: *Decoder, info: u5, comptime T: type, items_per_element: usize) DecodeError!usize {
        const n = try d.argument(info);
        if (n > d.remaining() / items_per_element) return error.EndOfBuffer;
        if (n > d.limits.max_alloc_bytes / @sizeOf(T)) return error.AllocationTooLarge;
        return @intCast(n);
    }

    fn value(d: *Decoder, depth: u32) DecodeError!Value {
        if (depth == 0) return error.RecursionLimit;
        const head = (try d.take(1))[0];
        const info: u5 = @truncate(head);
        switch (head >> 5) {
            0 => {
                const n = try d.argument(info);
                return .{ .int = std.math.cast(i64, n) orelse return error.Overflow };
            },
            1 => {
                const n = try d.argument(info);
                const magnitude = std.math.cast(i64, n) orelse return error.Overflow;
                return .{ .int = -1 - magnitude };
            },
            2, 3 => {
                const n = try d.argument(info);
                const data = try d.take(std.math.cast(usize, n) orelse return error.EndOfBuffer);
                return if (head >> 5 == 2) .{ .bytes = data } else .{ .text = data };
            },
            4 => {
                const items = try d.arena.alloc(Value, try d.count(info, Value, 1));
                for (items) |*item| item.* = try d.value(depth - 1);
                return .{ .array = items };
            },
            5 => {
                const entries = try d.arena.alloc(Entry, try d.count(info, Entry, 2));
                for (entries) |*entry| {
                    entry.key = try d.value(depth - 1);
                    entry.value = try d.value(depth - 1);
                }
                return .{ .map = entries };
            },
            7 => return switch (info) {
                20 => .{ .bool = false },
                21 => .{ .bool = true },
                22 => .null,
                else => error.Unsupported,
            },
            else => return error.Unsupported, // tags
        }
    }
};

// ---------------------------------------------------------------------------
// Typed parsing

pub const ParseError = error{
    /// value has the wrong CBOR type
    InvalidType,
    /// required map key is absent
    MissingField,
    /// value has the right type but is out of range
    InvalidValue,
} || Allocator.Error;

/// Map `value` onto `T`.
///
/// Supported targets: `bool`, integers (range checked), `[]const u8` (text),
/// `Bytes`, slices (arrays), optionals (`null` or absent maps keys), `Value`
/// (passthrough) and structs (maps keyed by field name).  Struct fields with
/// a default value or optional type may be absent; unknown keys are ignored.
pub fn parse(comptime T: type, arena: Allocator, value: Value) ParseError!T {
    if (T == Value) return value;
    if (T == Bytes) return switch (value) {
        .bytes => |b| .{ .data = b },
        else => error.InvalidType,
    };
    if (T == []const u8) return switch (value) {
        .text => |t| t,
        else => error.InvalidType,
    };

    switch (@typeInfo(T)) {
        .bool => return switch (value) {
            .bool => |b| b,
            else => error.InvalidType,
        },
        .int => return switch (value) {
            .int => |n| std.math.cast(T, n) orelse error.InvalidValue,
            else => error.InvalidType,
        },
        .optional => |opt| return switch (value) {
            .null => null,
            else => try parse(opt.child, arena, value),
        },
        .pointer => |ptr| {
            if (ptr.size != .slice) @compileError("unsupported cbor target " ++ @typeName(T));
            const items = switch (value) {
                .array => |a| a,
                else => return error.InvalidType,
            };
            const out = try arena.alloc(ptr.child, items.len);
            for (items, out) |item, *slot| slot.* = try parse(ptr.child, arena, item);
            return out;
        },
        .@"struct" => |info| {
            if (value != .map) return error.InvalidType;
            var result: T = undefined;
            inline for (info.field_names, info.field_types, info.field_attrs) |name, FieldType, attrs| {
                if (value.get(name)) |field_value| {
                    @field(result, name) = try parse(FieldType, arena, field_value);
                } else if (comptime attrs.defaultValue(FieldType)) |default| {
                    @field(result, name) = default;
                } else if (@typeInfo(FieldType) == .optional) {
                    @field(result, name) = null;
                } else {
                    return error.MissingField;
                }
            }
            return result;
        },
        else => @compileError("unsupported cbor target " ++ @typeName(T)),
    }
}

// ---------------------------------------------------------------------------
// Encoding

pub const Major = enum(u3) { uint = 0, nint = 1, bytes = 2, text = 3, array = 4, map = 5, simple = 7 };

/// Write an item head with the shortest argument encoding.
pub fn writeHead(w: *Writer, major: Major, arg: u64) Writer.Error!void {
    const m: u8 = @as(u8, @backingInt(major)) << 5;
    if (arg < 24) {
        try w.writeByte(m | @as(u8, @intCast(arg)));
    } else if (arg <= std.math.maxInt(u8)) {
        try w.writeAll(&.{ m | 24, @intCast(arg) });
    } else if (arg <= std.math.maxInt(u16)) {
        try w.writeByte(m | 25);
        try w.writeInt(u16, @intCast(arg), .big);
    } else if (arg <= std.math.maxInt(u32)) {
        try w.writeByte(m | 26);
        try w.writeInt(u32, @intCast(arg), .big);
    } else {
        try w.writeByte(m | 27);
        try w.writeInt(u64, arg, .big);
    }
}

pub fn writeInt(w: *Writer, n: i64) Writer.Error!void {
    if (n >= 0) {
        try writeHead(w, .uint, @intCast(n));
    } else {
        try writeHead(w, .nint, @intCast(-(n + 1)));
    }
}

pub fn writeText(w: *Writer, text: []const u8) Writer.Error!void {
    try writeHead(w, .text, text.len);
    try w.writeAll(text);
}

pub fn writeBytes(w: *Writer, bytes: []const u8) Writer.Error!void {
    try writeHead(w, .bytes, bytes.len);
    try w.writeAll(bytes);
}

/// Encode a Zig value: integers, `bool`, `[]const u8`/string literals (text),
/// `Bytes`, slices (arrays), optionals (`null`) and structs (maps keyed by
/// field name, omitting fields whose optional value is null).
pub fn encode(w: *Writer, value: anytype) Writer.Error!void {
    const T = @TypeOf(value);
    if (T == Bytes) return writeBytes(w, value.data);
    if (comptime isText(T)) return writeText(w, value);

    switch (@typeInfo(T)) {
        .bool => try w.writeByte(if (value) 0xf5 else 0xf4),
        .int, .comptime_int => if (value < 0)
            try writeHead(w, .nint, @intCast(-(value + 1)))
        else
            try writeHead(w, .uint, @intCast(value)),
        .null => try w.writeByte(0xf6),
        .optional => if (value) |v| try encode(w, v) else try w.writeByte(0xf6),
        .pointer => |ptr| {
            if (ptr.size != .slice) @compileError("unsupported cbor source " ++ @typeName(T));
            try writeHead(w, .array, value.len);
            for (value) |item| try encode(w, item);
        },
        .@"struct" => |info| {
            var len: usize = 0;
            inline for (info.field_names) |name| {
                if (!isNullOptional(@field(value, name))) len += 1;
            }
            try writeHead(w, .map, len);
            inline for (info.field_names) |name| {
                const field_value = @field(value, name);
                if (!isNullOptional(field_value)) {
                    try writeText(w, name);
                    try encode(w, field_value);
                }
            }
        },
        else => @compileError("unsupported cbor source " ++ @typeName(T)),
    }
}

fn isText(comptime T: type) bool {
    return switch (@typeInfo(T)) {
        .pointer => |ptr| switch (ptr.size) {
            .slice => ptr.child == u8,
            .one => switch (@typeInfo(ptr.child)) {
                .array => |arr| arr.child == u8,
                else => false,
            },
            else => false,
        },
        else => false,
    };
}

fn isNullOptional(value: anytype) bool {
    return switch (@typeInfo(@TypeOf(value))) {
        .optional => value == null,
        .null => true,
        else => false,
    };
}

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;

test "encode and decode round trip" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var buf: [256]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try encode(&w, .{
        .t = "exec_request",
        .id = @as(u32, 42),
        .neg = @as(i64, -500),
        .big = @as(u64, 1 << 40),
        .flag = true,
        .data = Bytes{ .data = "\x00\x01" },
        .list = @as([]const []const u8, &.{ "a", "b" }),
        .skipped = @as(?u32, null),
    });

    const value = try decode(arena, w.buffered());
    try testing.expectEqual(@as(usize, 7), value.map.len);
    try testing.expectEqualStrings("exec_request", value.get("t").?.text);
    try testing.expectEqual(@as(i64, 42), value.get("id").?.int);
    try testing.expectEqual(@as(i64, -500), value.get("neg").?.int);
    try testing.expectEqual(@as(i64, 1 << 40), value.get("big").?.int);
    try testing.expectEqualStrings("\x00\x01", value.get("data").?.bytes);
    try testing.expect(value.get("skipped") == null);

    const Parsed = struct {
        id: u32,
        neg: i32,
        flag: bool = false,
        data: Bytes,
        list: []const []const u8 = &.{},
        missing: u32 = 7,
        absent: ?[]const u8,
    };
    const parsed = try parse(Parsed, arena, value);
    try testing.expectEqual(@as(u32, 42), parsed.id);
    try testing.expectEqual(@as(i32, -500), parsed.neg);
    try testing.expect(parsed.flag);
    try testing.expectEqualStrings("b", parsed.list[1]);
    try testing.expectEqual(@as(u32, 7), parsed.missing);
    try testing.expect(parsed.absent == null);
}

test "head encoding uses the shortest form" {
    var buf: [16]u8 = undefined;
    const cases = [_]struct { u64, []const u8 }{
        .{ 23, &.{0x17} },
        .{ 24, &.{ 0x18, 24 } },
        .{ 256, &.{ 0x19, 1, 0 } },
        .{ 65536, &.{ 0x1a, 0, 1, 0, 0 } },
        .{ 1 << 32, &.{ 0x1b, 0, 0, 0, 1, 0, 0, 0, 0 } },
    };
    for (cases) |case| {
        var w: Writer = .fixed(&buf);
        try writeHead(&w, .uint, case[0]);
        try testing.expectEqualSlices(u8, case[1], w.buffered());
    }
}

test "parse reports type, range and missing field errors" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const S = struct { port: u16 };
    try testing.expectError(error.InvalidValue, parse(S, arena, try decode(arena, &.{ 0xa1, 0x64, 'p', 'o', 'r', 't', 0x1a, 0, 1, 0, 0 })));
    try testing.expectError(error.InvalidType, parse(S, arena, try decode(arena, &.{ 0xa1, 0x64, 'p', 'o', 'r', 't', 0x61, 'x' })));
    try testing.expectError(error.MissingField, parse(S, arena, try decode(arena, &.{0xa0})));
    try testing.expectError(error.InvalidType, parse(S, arena, try decode(arena, &.{0x01})));
}

test "decode rejects absurd container lengths before allocating" {
    // array with an 8-byte length
    const huge: []const u8 = &.{ 0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff };
    try testing.expectError(error.EndOfBuffer, decode(testing.allocator, huge));
    // map claiming 2 entries with only 3 bytes left
    try testing.expectError(error.EndOfBuffer, decode(testing.allocator, &.{ 0xa2, 0x01, 0x02, 0x03 }));
    // byte string longer than the input
    try testing.expectError(error.EndOfBuffer, decode(testing.allocator, &.{ 0x5a, 0xff, 0xff, 0xff, 0xff }));
}

test "decode enforces limits and the supported subset" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var buf: [102]u8 = undefined;
    buf[0] = 0x98;
    buf[1] = 100;
    @memset(buf[2..], 0);
    try testing.expectError(error.AllocationTooLarge, decodeWithLimits(arena, &buf, .{ .max_alloc_bytes = 1024 }));

    const nested: [3]u8 = .{ 0x81, 0x81, 0x80 };
    try testing.expectError(error.RecursionLimit, decodeWithLimits(arena, &nested, .{ .max_depth = 2 }));
    _ = try decodeWithLimits(arena, &nested, .{ .max_depth = 3 });

    try testing.expectError(error.Unsupported, decode(arena, &.{ 0xfb, 0, 0, 0, 0, 0, 0, 0, 0 })); // float64
    try testing.expectError(error.Unsupported, decode(arena, &.{0x9f})); // indefinite array
    try testing.expectError(error.Unsupported, decode(arena, &.{ 0xc0, 0x00 })); // tag
    try testing.expectError(error.Overflow, decode(arena, &.{ 0x1b, 0x80, 0, 0, 0, 0, 0, 0, 0 }));
    try testing.expectEqual(@as(i64, std.math.minInt(i64)), (try decode(arena, &.{ 0x3b, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff })).int);
}
