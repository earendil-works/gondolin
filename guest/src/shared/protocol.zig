//! Virtio-serial RPC protocol for guest ↔ host communication.
//!
//! ## Framing
//! Messages are length-prefixed: a big-endian u32 length followed by the payload.
//! Maximum frame size is 4 MiB.
//!
//! ## Encoding
//! All payloads are CBOR-encoded maps with a standard envelope:
//!   - `v` (u32): protocol version (currently 1)
//!   - `t` (string): message type (e.g. "exec_request", "fs_response")
//!   - `id` (u32): correlation ID for request/response matching
//!   - `p` (map): type-specific payload
//!
//! ## Message Types
//! Exec: exec_request, exec_response, exec_output, stdin_data, pty_resize
//! Filesystem: fs_request, fs_response
//! Status: vfs_ready, vfs_error
//! Errors: error

const std = @import("std");
const cbor = @import("cbor.zig");

pub const ProtocolError = error{
    InvalidType,
    MissingField,
    UnexpectedType,
    InvalidValue,
};

pub const ExecRequest = struct {
    id: u32,
    cmd: []const u8,
    argv: []const []const u8,
    env: []const []const u8,
    cwd: ?[]const u8,
    stdin: bool,
    pty: bool,
};

pub const StdinData = struct {
    data: []const u8,
    eof: bool,
};

pub const PtyResize = struct {
    rows: u32,
    cols: u32,
};

pub const InputMessage = union(enum) {
    stdin: StdinData,
    resize: PtyResize,
};

pub const FrameReader = struct {
    allocator: std.mem.Allocator,
    len_buf: [4]u8 = undefined,
    len_read: usize = 0,
    frame_len: ?usize = null,
    frame: ?[]u8 = null,
    frame_read: usize = 0,

    pub fn init(allocator: std.mem.Allocator) FrameReader {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *FrameReader) void {
        if (self.frame) |frame| {
            self.allocator.free(frame);
            self.frame = null;
        }
    }

    pub fn readFrame(self: *FrameReader, fd: std.posix.fd_t) !?[]u8 {
        while (true) {
            if (self.frame == null) {
                const n = try self.readNonBlocking(fd, self.len_buf[self.len_read..]);
                if (n == null) return null;
                self.len_read += n.?;
                if (self.len_read < self.len_buf.len) return null;

                const len = (@as(u32, self.len_buf[0]) << 24) |
                    (@as(u32, self.len_buf[1]) << 16) |
                    (@as(u32, self.len_buf[2]) << 8) |
                    @as(u32, self.len_buf[3]);

                const max_frame: u32 = 4 * 1024 * 1024;
                if (len > max_frame) return error.FrameTooLarge;

                const frame = try self.allocator.alloc(u8, len);
                self.frame = frame;
                self.frame_len = len;
                self.frame_read = 0;

                if (len == 0) {
                    const result = frame;
                    self.frame = null;
                    self.frame_len = null;
                    self.len_read = 0;
                    return result;
                }
            }

            const frame = self.frame.?;
            const n = try self.readNonBlocking(fd, frame[self.frame_read..]);
            if (n == null) return null;
            self.frame_read += n.?;
            if (self.frame_read < self.frame_len.?) return null;

            const result = frame;
            self.frame = null;
            self.frame_len = null;
            self.frame_read = 0;
            self.len_read = 0;
            return result;
        }
    }

    fn readNonBlocking(self: *FrameReader, fd: std.posix.fd_t, buf: []u8) !?usize {
        _ = self;
        const n = std.posix.read(fd, buf) catch |err| {
            if (err == error.WouldBlock) return null;
            return err;
        };
        if (n == 0) return error.EndOfStream;
        return n;
    }
};

pub const FrameWriter = struct {
    allocator: std.mem.Allocator,
    buffer: std.ArrayList(u8) = .empty,
    offset: usize = 0,

    pub fn init(allocator: std.mem.Allocator) FrameWriter {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *FrameWriter) void {
        self.buffer.deinit(self.allocator);
    }

    pub fn hasPending(self: *FrameWriter) bool {
        return self.offset < self.buffer.items.len;
    }

    pub fn pendingBytes(self: *FrameWriter) usize {
        return self.buffer.items.len - self.offset;
    }

    pub fn enqueue(self: *FrameWriter, payload: []const u8) !void {
        const len: u32 = @intCast(payload.len);
        var len_buf: [4]u8 = .{
            @intCast((len >> 24) & 0xff),
            @intCast((len >> 16) & 0xff),
            @intCast((len >> 8) & 0xff),
            @intCast(len & 0xff),
        };

        try self.buffer.appendSlice(self.allocator, &len_buf);
        try self.buffer.appendSlice(self.allocator, payload);
    }

    pub fn flush(self: *FrameWriter, fd: std.posix.fd_t) !void {
        while (self.offset < self.buffer.items.len) {
            const n = std.posix.write(fd, self.buffer.items[self.offset..]) catch |err| {
                if (err == error.WouldBlock) return;
                return err;
            };
            if (n == 0) return error.EndOfStream;
            self.offset += n;
        }

        if (self.offset >= self.buffer.items.len) {
            self.buffer.clearRetainingCapacity();
            self.offset = 0;
        }
    }
};

pub fn decodeExecRequest(allocator: std.mem.Allocator, frame: []const u8) !ExecRequest {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    defer cbor.freeValue(allocator, root);
    return parseExecRequest(allocator, root);
}

pub fn decodeStdinData(allocator: std.mem.Allocator, frame: []const u8, expected_id: u32) !StdinData {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    defer cbor.freeValue(allocator, root);
    return parseStdinData(root, expected_id);
}

pub fn decodeInputMessage(allocator: std.mem.Allocator, frame: []const u8, expected_id: u32) !InputMessage {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    defer cbor.freeValue(allocator, root);
    return parseInputMessage(root, expected_id);
}

pub fn encodeExecOutput(
    allocator: std.mem.Allocator,
    id: u32,
    stream: []const u8,
    data: []const u8,
) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "exec_output");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 2);
    try cbor.writeText(w, "stream");
    try cbor.writeText(w, stream);
    try cbor.writeText(w, "data");
    try cbor.writeBytes(w, data);

    return try buf.toOwnedSlice(allocator);
}

pub fn encodeExecResponse(
    allocator: std.mem.Allocator,
    id: u32,
    exit_code: i32,
    signal: ?i32,
) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    const map_len: usize = if (signal == null) 1 else 2;

    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "exec_response");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, map_len);
    try cbor.writeText(w, "exit_code");
    try cbor.writeInt(w, exit_code);
    if (signal) |sig| {
        try cbor.writeText(w, "signal");
        try cbor.writeInt(w, sig);
    }

    return try buf.toOwnedSlice(allocator);
}

pub fn encodeVfsReady(allocator: std.mem.Allocator) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "vfs_ready");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, 0);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 0);

    return try buf.toOwnedSlice(allocator);
}

pub fn encodeVfsError(allocator: std.mem.Allocator, message: []const u8) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "vfs_error");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, 0);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 1);
    try cbor.writeText(w, "message");
    try cbor.writeText(w, message);

    return try buf.toOwnedSlice(allocator);
}

pub fn sendVfsReady(allocator: std.mem.Allocator, fd: std.posix.fd_t) !void {
    const payload = try encodeVfsReady(allocator);
    defer allocator.free(payload);
    try writeFrame(fd, payload);
}

pub fn sendVfsError(
    allocator: std.mem.Allocator,
    fd: std.posix.fd_t,
    message: []const u8,
) !void {
    const payload = try encodeVfsError(allocator, message);
    defer allocator.free(payload);
    try writeFrame(fd, payload);
}

pub fn encodeError(
    allocator: std.mem.Allocator,
    id: u32,
    code: []const u8,
    message: []const u8,
) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "error");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 2);
    try cbor.writeText(w, "code");
    try cbor.writeText(w, code);
    try cbor.writeText(w, "message");
    try cbor.writeText(w, message);

    return try buf.toOwnedSlice(allocator);
}

pub fn sendError(
    allocator: std.mem.Allocator,
    fd: std.posix.fd_t,
    id: u32,
    code: []const u8,
    message: []const u8,
) !void {
    const payload = try encodeError(allocator, id, code, message);
    defer allocator.free(payload);
    try writeFrame(fd, payload);
}

pub fn readFrame(allocator: std.mem.Allocator, fd: std.posix.fd_t) ![]u8 {
    var len_buf: [4]u8 = undefined;
    try readExact(fd, len_buf[0..]);

    const len = (@as(u32, len_buf[0]) << 24) |
        (@as(u32, len_buf[1]) << 16) |
        (@as(u32, len_buf[2]) << 8) |
        @as(u32, len_buf[3]);

    const max_frame: u32 = 4 * 1024 * 1024;
    if (len > max_frame) return error.FrameTooLarge;

    const frame = try allocator.alloc(u8, len);
    errdefer allocator.free(frame);
    try readExact(fd, frame);
    return frame;
}

pub fn writeFrame(fd: std.posix.fd_t, payload: []const u8) !void {
    const len: u32 = @intCast(payload.len);
    var len_buf: [4]u8 = .{
        @intCast((len >> 24) & 0xff),
        @intCast((len >> 16) & 0xff),
        @intCast((len >> 8) & 0xff),
        @intCast(len & 0xff),
    };

    try writeAll(fd, &len_buf);
    try writeAll(fd, payload);
}

pub fn readExact(fd: std.posix.fd_t, buf: []u8) !void {
    var offset: usize = 0;
    while (offset < buf.len) {
        const n = try std.posix.read(fd, buf[offset..]);
        if (n == 0) return error.EndOfStream;
        offset += n;
    }
}

pub fn writeAll(fd: std.posix.fd_t, data: []const u8) !void {
    var offset: usize = 0;
    while (offset < data.len) {
        const n = try std.posix.write(fd, data[offset..]);
        if (n == 0) return error.EndOfStream;
        offset += n;
    }
}

fn parseExecRequest(allocator: std.mem.Allocator, root: cbor.Value) !ExecRequest {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);
    if (!std.mem.eql(u8, msg_type, "exec_request")) {
        return ProtocolError.UnexpectedType;
    }

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);

    const payload_val = cbor.getMapValue(map, "p") orelse return ProtocolError.MissingField;
    const payload = try expectMap(payload_val);

    const cmd = try expectText(cbor.getMapValue(payload, "cmd") orelse return ProtocolError.MissingField);

    const argv = try parseTextArray(allocator, cbor.getMapValue(payload, "argv"));
    errdefer allocator.free(argv);

    const env = try parseTextArray(allocator, cbor.getMapValue(payload, "env"));
    errdefer allocator.free(env);

    var cwd: ?[]const u8 = null;
    if (cbor.getMapValue(payload, "cwd")) |cwd_val| {
        cwd = try expectText(cwd_val);
    }

    var stdin_flag = false;
    if (cbor.getMapValue(payload, "stdin")) |stdin_val| {
        stdin_flag = try expectBool(stdin_val);
    }

    var pty_flag = false;
    if (cbor.getMapValue(payload, "pty")) |pty_val| {
        pty_flag = try expectBool(pty_val);
    }

    return ExecRequest{
        .id = id,
        .cmd = cmd,
        .argv = argv,
        .env = env,
        .cwd = cwd,
        .stdin = stdin_flag,
        .pty = pty_flag,
    };
}

fn parseStdinData(root: cbor.Value, expected_id: u32) !StdinData {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);
    if (!std.mem.eql(u8, msg_type, "stdin_data")) {
        return ProtocolError.UnexpectedType;
    }

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);
    if (id != expected_id) return ProtocolError.InvalidValue;

    const payload_val = cbor.getMapValue(map, "p") orelse return ProtocolError.MissingField;
    const payload = try expectMap(payload_val);

    const data_val = cbor.getMapValue(payload, "data") orelse return ProtocolError.MissingField;
    const data = try expectBytes(data_val);

    var eof = false;
    if (cbor.getMapValue(payload, "eof")) |eof_val| {
        eof = try expectBool(eof_val);
    }

    return .{ .data = data, .eof = eof };
}

fn parsePtyResize(root: cbor.Value, expected_id: u32) !PtyResize {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);
    if (!std.mem.eql(u8, msg_type, "pty_resize")) {
        return ProtocolError.UnexpectedType;
    }

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);
    if (id != expected_id) return ProtocolError.InvalidValue;

    const payload_val = cbor.getMapValue(map, "p") orelse return ProtocolError.MissingField;
    const payload = try expectMap(payload_val);

    const rows_val = cbor.getMapValue(payload, "rows") orelse return ProtocolError.MissingField;
    const cols_val = cbor.getMapValue(payload, "cols") orelse return ProtocolError.MissingField;

    return .{
        .rows = try expectU32(rows_val),
        .cols = try expectU32(cols_val),
    };
}

fn parseInputMessage(root: cbor.Value, expected_id: u32) !InputMessage {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);

    if (std.mem.eql(u8, msg_type, "stdin_data")) {
        return .{ .stdin = try parseStdinData(root, expected_id) };
    }
    if (std.mem.eql(u8, msg_type, "pty_resize")) {
        return .{ .resize = try parsePtyResize(root, expected_id) };
    }

    return ProtocolError.UnexpectedType;
}

fn parseTextArray(allocator: std.mem.Allocator, value: ?cbor.Value) ![]const []const u8 {
    if (value == null) return allocator.alloc([]const u8, 0);
    const items = try expectArray(value.?);
    var out = try allocator.alloc([]const u8, items.len);
    for (items, 0..) |item, idx| {
        out[idx] = try expectText(item);
    }
    return out;
}

fn expectMap(value: cbor.Value) ![]cbor.Entry {
    return switch (value) {
        .Map => |map| map,
        else => ProtocolError.InvalidType,
    };
}

fn expectArray(value: cbor.Value) ![]cbor.Value {
    return switch (value) {
        .Array => |items| items,
        else => ProtocolError.InvalidType,
    };
}

fn expectText(value: cbor.Value) ![]const u8 {
    return switch (value) {
        .Text => |text| text,
        else => ProtocolError.InvalidType,
    };
}

fn expectBytes(value: cbor.Value) ![]const u8 {
    return switch (value) {
        .Bytes => |bytes| bytes,
        else => ProtocolError.InvalidType,
    };
}

fn expectBool(value: cbor.Value) !bool {
    return switch (value) {
        .Bool => |b| b,
        else => ProtocolError.InvalidType,
    };
}

fn expectU32(value: cbor.Value) !u32 {
    return switch (value) {
        .Int => |num| {
            if (num < 0 or num > std.math.maxInt(u32)) return ProtocolError.InvalidValue;
            return @as(u32, @intCast(num));
        },
        else => ProtocolError.InvalidType,
    };
}
