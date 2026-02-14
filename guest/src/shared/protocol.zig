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
//! Exec: exec_request, exec_response, exec_output, stdin_data, pty_resize, exec_window, stdin_window
//! Guest file I/O: file_read_request, file_read_data, file_read_done, file_write_request, file_write_data, file_write_done, file_delete_request, file_delete_done
//! Filesystem: fs_request, fs_response
//! TCP: tcp_open, tcp_opened, tcp_data, tcp_eof, tcp_close
//! Status: vfs_ready, vfs_error
//! Errors: error

const std = @import("std");
const cbor = @import("cbor.zig");

/// maximum frame size in `bytes`
pub const max_frame_len: u32 = 4 * 1024 * 1024;

pub const ProtocolError = error{
    InvalidType,
    MissingField,
    UnexpectedType,
    InvalidValue,
};

pub const ExecRequest = struct {
    /// correlation id
    id: u32,
    /// executable
    cmd: []const u8,
    /// argv entries (excluding cmd)
    argv: []const []const u8,
    /// environment variables as `KEY=VALUE`
    env: []const []const u8,
    /// working directory
    cwd: ?[]const u8,
    /// whether stdin frames will be sent
    stdin: bool,
    /// whether to allocate a pty
    pty: bool,
    /// initial stdout credit window in `bytes`
    stdout_window: u32,
    /// initial stderr credit window in `bytes`
    stderr_window: u32,
};

pub const StdinData = struct {
    /// stdin chunk
    data: []const u8,
    /// whether this chunk closes stdin
    eof: bool,
};

pub const PtyResize = struct {
    /// pty row count
    rows: u32,
    /// pty column count
    cols: u32,
};

pub const ExecWindow = struct {
    /// additional stdout credits in `bytes`
    stdout: u32,
    /// additional stderr credits in `bytes`
    stderr: u32,
};

pub const FileReadRequest = struct {
    /// correlation id
    id: u32,
    /// target path
    path: []const u8,
    /// working directory for relative paths
    cwd: ?[]const u8,
    /// preferred read chunk size in `bytes`
    chunk_size: u32,
};

pub const FileWriteRequest = struct {
    /// correlation id
    id: u32,
    /// target path
    path: []const u8,
    /// working directory for relative paths
    cwd: ?[]const u8,
    /// whether to truncate existing file
    truncate: bool,
};

pub const FileWriteData = struct {
    /// file chunk
    data: []const u8,
    /// whether this chunk closes the write stream
    eof: bool,
};

pub const FileDeleteRequest = struct {
    /// correlation id
    id: u32,
    /// target path
    path: []const u8,
    /// working directory for relative paths
    cwd: ?[]const u8,
    /// ignore missing paths
    force: bool,
    /// recursive delete for directories
    recursive: bool,
};

pub const InputMessage = union(enum) {
    stdin: StdinData,
    resize: PtyResize,
    window: ExecWindow,
};

pub const RoutedInputMessage = struct {
    /// correlation id
    id: u32,
    /// routed input payload
    message: InputMessage,
};

pub const TcpOpen = struct {
    /// stream id
    id: u32,
    /// target host (must be loopback)
    host: []const u8,
    /// target port
    port: u16,
};

pub const TcpData = struct {
    /// stream id
    id: u32,
    /// data chunk
    data: []const u8,
};

pub const TcpMessage = union(enum) {
    open: TcpOpen,
    data: TcpData,
    /// host half-close
    eof: u32,
    /// either direction close
    close: u32,
};

pub const FrameReader = struct {
    /// allocator used for frame buffering
    allocator: std.mem.Allocator,
    /// pending length prefix buffer
    len_buf: [4]u8 = undefined,
    /// bytes read into len_buf
    len_read: usize = 0,
    /// expected frame length in `bytes`
    frame_len: ?usize = null,
    /// buffered frame payload
    frame: ?[]u8 = null,
    /// bytes read into frame
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

                if (len > max_frame_len) return error.FrameTooLarge;

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
    /// allocator used for frame buffering
    allocator: std.mem.Allocator,
    /// pending output buffer (len-prefixed frames)
    buffer: std.ArrayList(u8) = .empty,
    /// current write offset into buffer in `bytes`
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
        if (payload.len > @as(usize, max_frame_len)) return error.FrameTooLarge;

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
    errdefer cbor.freeValue(allocator, root);

    const req = try parseExecRequest(allocator, root);
    cbor.freeValue(allocator, root);
    return req;
}

pub fn decodeFileReadRequest(allocator: std.mem.Allocator, frame: []const u8) !FileReadRequest {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    errdefer cbor.freeValue(allocator, root);

    const req = try parseFileReadRequest(root);
    cbor.freeValue(allocator, root);
    return req;
}

pub fn decodeFileWriteRequest(allocator: std.mem.Allocator, frame: []const u8) !FileWriteRequest {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    errdefer cbor.freeValue(allocator, root);

    const req = try parseFileWriteRequest(root);
    cbor.freeValue(allocator, root);
    return req;
}

pub fn decodeFileWriteData(allocator: std.mem.Allocator, frame: []const u8, expected_id: u32) !FileWriteData {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    errdefer cbor.freeValue(allocator, root);

    const msg = try parseFileWriteData(root, expected_id);
    cbor.freeValue(allocator, root);
    return msg;
}

pub fn decodeFileDeleteRequest(allocator: std.mem.Allocator, frame: []const u8) !FileDeleteRequest {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    errdefer cbor.freeValue(allocator, root);

    const req = try parseFileDeleteRequest(root);
    cbor.freeValue(allocator, root);
    return req;
}

pub fn decodeStdinData(allocator: std.mem.Allocator, frame: []const u8, expected_id: u32) !StdinData {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    errdefer cbor.freeValue(allocator, root);

    const msg = try parseStdinData(root, expected_id);
    cbor.freeValue(allocator, root);
    return msg;
}

pub fn decodeInputMessage(allocator: std.mem.Allocator, frame: []const u8, expected_id: u32) !InputMessage {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    errdefer cbor.freeValue(allocator, root);

    const msg = try parseInputMessage(root, expected_id);
    cbor.freeValue(allocator, root);
    return msg;
}

pub fn decodeRoutedInputMessage(allocator: std.mem.Allocator, frame: []const u8) !RoutedInputMessage {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    errdefer cbor.freeValue(allocator, root);

    const msg = try parseRoutedInputMessage(root);
    cbor.freeValue(allocator, root);
    return msg;
}

pub fn decodeTcpMessage(allocator: std.mem.Allocator, frame: []const u8) !TcpMessage {
    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    defer cbor.freeValue(allocator, root);
    return parseTcpMessage(allocator, root);
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

pub fn encodeStdinWindow(
    allocator: std.mem.Allocator,
    id: u32,
    stdin: u32,
) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "stdin_window");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 1);
    try cbor.writeText(w, "stdin");
    try cbor.writeUInt(w, stdin);

    return try buf.toOwnedSlice(allocator);
}

pub fn sendStdinWindow(
    allocator: std.mem.Allocator,
    fd: std.posix.fd_t,
    id: u32,
    stdin: u32,
) !void {
    const payload = try encodeStdinWindow(allocator, id, stdin);
    defer allocator.free(payload);
    try writeFrame(fd, payload);
}

pub fn encodeFileReadData(
    allocator: std.mem.Allocator,
    id: u32,
    data: []const u8,
) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "file_read_data");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 1);
    try cbor.writeText(w, "data");
    try cbor.writeBytes(w, data);

    return try buf.toOwnedSlice(allocator);
}

pub fn encodeFileReadDone(allocator: std.mem.Allocator, id: u32) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "file_read_done");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 0);

    return try buf.toOwnedSlice(allocator);
}

pub fn encodeFileWriteDone(allocator: std.mem.Allocator, id: u32) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "file_write_done");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 0);

    return try buf.toOwnedSlice(allocator);
}

pub fn encodeFileDeleteDone(allocator: std.mem.Allocator, id: u32) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "file_delete_done");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 0);

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

pub fn encodeTcpOpened(
    allocator: std.mem.Allocator,
    id: u32,
    ok: bool,
    message: ?[]const u8,
) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "tcp_opened");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    const map_len: usize = if (message == null) 1 else 2;
    try cbor.writeMapStart(w, map_len);
    try cbor.writeText(w, "ok");
    try cbor.writeBool(w, ok);
    if (message) |m| {
        try cbor.writeText(w, "message");
        try cbor.writeText(w, m);
    }

    return try buf.toOwnedSlice(allocator);
}

pub fn encodeTcpData(
    allocator: std.mem.Allocator,
    id: u32,
    data: []const u8,
) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "tcp_data");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 1);
    try cbor.writeText(w, "data");
    try cbor.writeBytes(w, data);

    return try buf.toOwnedSlice(allocator);
}

pub fn encodeTcpClose(allocator: std.mem.Allocator, id: u32) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "tcp_close");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 0);

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

    if (len > max_frame_len) return error.FrameTooLarge;

    const frame = try allocator.alloc(u8, len);
    errdefer allocator.free(frame);
    try readExact(fd, frame);
    return frame;
}

pub fn writeFrame(fd: std.posix.fd_t, payload: []const u8) !void {
    if (payload.len > @as(usize, max_frame_len)) return error.FrameTooLarge;

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

    // Default windows for backward compatibility
    var stdout_window: u32 = 256 * 1024;
    var stderr_window: u32 = 256 * 1024;
    if (cbor.getMapValue(payload, "stdout_window")) |val| {
        stdout_window = try expectU32(val);
        if (stdout_window == 0) stdout_window = 256 * 1024;
    }
    if (cbor.getMapValue(payload, "stderr_window")) |val| {
        stderr_window = try expectU32(val);
        if (stderr_window == 0) stderr_window = 256 * 1024;
    }

    return ExecRequest{
        .id = id,
        .cmd = cmd,
        .argv = argv,
        .env = env,
        .cwd = cwd,
        .stdin = stdin_flag,
        .pty = pty_flag,
        .stdout_window = stdout_window,
        .stderr_window = stderr_window,
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

fn parseExecWindow(root: cbor.Value, expected_id: u32) !ExecWindow {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);
    if (!std.mem.eql(u8, msg_type, "exec_window")) {
        return ProtocolError.UnexpectedType;
    }

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);
    if (id != expected_id) return ProtocolError.InvalidValue;

    const payload_val = cbor.getMapValue(map, "p") orelse return ProtocolError.MissingField;
    const payload = try expectMap(payload_val);

    var stdout: u32 = 0;
    var stderr: u32 = 0;

    if (cbor.getMapValue(payload, "stdout")) |val| {
        stdout = try expectU32(val);
    }
    if (cbor.getMapValue(payload, "stderr")) |val| {
        stderr = try expectU32(val);
    }

    return .{ .stdout = stdout, .stderr = stderr };
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
    if (std.mem.eql(u8, msg_type, "exec_window")) {
        return .{ .window = try parseExecWindow(root, expected_id) };
    }

    return ProtocolError.UnexpectedType;
}

fn parseRoutedInputMessage(root: cbor.Value) !RoutedInputMessage {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);

    if (std.mem.eql(u8, msg_type, "stdin_data")) {
        return .{ .id = id, .message = .{ .stdin = try parseStdinData(root, id) } };
    }
    if (std.mem.eql(u8, msg_type, "pty_resize")) {
        return .{ .id = id, .message = .{ .resize = try parsePtyResize(root, id) } };
    }
    if (std.mem.eql(u8, msg_type, "exec_window")) {
        return .{ .id = id, .message = .{ .window = try parseExecWindow(root, id) } };
    }

    return ProtocolError.UnexpectedType;
}

fn parseTcpMessage(allocator: std.mem.Allocator, root: cbor.Value) !TcpMessage {
    _ = allocator;
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);

    const payload_val = cbor.getMapValue(map, "p") orelse return ProtocolError.MissingField;
    const payload = try expectMap(payload_val);

    if (std.mem.eql(u8, msg_type, "tcp_open")) {
        const host_val = cbor.getMapValue(payload, "host") orelse return ProtocolError.MissingField;
        const port_val = cbor.getMapValue(payload, "port") orelse return ProtocolError.MissingField;
        const host = try expectText(host_val);
        const port_u32 = try expectU32(port_val);
        if (port_u32 > std.math.maxInt(u16)) return ProtocolError.InvalidValue;
        return .{ .open = .{ .id = id, .host = host, .port = @as(u16, @intCast(port_u32)) } };
    }

    if (std.mem.eql(u8, msg_type, "tcp_data")) {
        const data_val = cbor.getMapValue(payload, "data") orelse return ProtocolError.MissingField;
        const data = try expectBytes(data_val);
        return .{ .data = .{ .id = id, .data = data } };
    }

    if (std.mem.eql(u8, msg_type, "tcp_eof")) {
        return .{ .eof = id };
    }

    if (std.mem.eql(u8, msg_type, "tcp_close")) {
        return .{ .close = id };
    }

    return ProtocolError.UnexpectedType;
}

fn parseFileReadRequest(root: cbor.Value) !FileReadRequest {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);
    if (!std.mem.eql(u8, msg_type, "file_read_request")) {
        return ProtocolError.UnexpectedType;
    }

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);

    const payload_val = cbor.getMapValue(map, "p") orelse return ProtocolError.MissingField;
    const payload = try expectMap(payload_val);

    const path = try expectText(cbor.getMapValue(payload, "path") orelse return ProtocolError.MissingField);

    var cwd: ?[]const u8 = null;
    if (cbor.getMapValue(payload, "cwd")) |cwd_val| {
        cwd = try expectText(cwd_val);
    }

    var chunk_size: u32 = 64 * 1024;
    if (cbor.getMapValue(payload, "chunk_size")) |chunk_val| {
        chunk_size = try expectU32(chunk_val);
    }

    if (chunk_size == 0) chunk_size = 64 * 1024;
    const min_chunk: u32 = 1024;
    const max_chunk: u32 = 1024 * 1024;
    if (chunk_size < min_chunk) chunk_size = min_chunk;
    if (chunk_size > max_chunk) chunk_size = max_chunk;

    return .{
        .id = id,
        .path = path,
        .cwd = cwd,
        .chunk_size = chunk_size,
    };
}

fn parseFileWriteRequest(root: cbor.Value) !FileWriteRequest {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);
    if (!std.mem.eql(u8, msg_type, "file_write_request")) {
        return ProtocolError.UnexpectedType;
    }

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);

    const payload_val = cbor.getMapValue(map, "p") orelse return ProtocolError.MissingField;
    const payload = try expectMap(payload_val);

    const path = try expectText(cbor.getMapValue(payload, "path") orelse return ProtocolError.MissingField);

    var cwd: ?[]const u8 = null;
    if (cbor.getMapValue(payload, "cwd")) |cwd_val| {
        cwd = try expectText(cwd_val);
    }

    var truncate = true;
    if (cbor.getMapValue(payload, "truncate")) |truncate_val| {
        truncate = try expectBool(truncate_val);
    }

    return .{
        .id = id,
        .path = path,
        .cwd = cwd,
        .truncate = truncate,
    };
}

fn parseFileWriteData(root: cbor.Value, expected_id: u32) !FileWriteData {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);
    if (!std.mem.eql(u8, msg_type, "file_write_data")) {
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

fn parseFileDeleteRequest(root: cbor.Value) !FileDeleteRequest {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);
    if (!std.mem.eql(u8, msg_type, "file_delete_request")) {
        return ProtocolError.UnexpectedType;
    }

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);

    const payload_val = cbor.getMapValue(map, "p") orelse return ProtocolError.MissingField;
    const payload = try expectMap(payload_val);

    const path = try expectText(cbor.getMapValue(payload, "path") orelse return ProtocolError.MissingField);

    var cwd: ?[]const u8 = null;
    if (cbor.getMapValue(payload, "cwd")) |cwd_val| {
        cwd = try expectText(cwd_val);
    }

    var force = false;
    if (cbor.getMapValue(payload, "force")) |force_val| {
        force = try expectBool(force_val);
    }

    var recursive = false;
    if (cbor.getMapValue(payload, "recursive")) |recursive_val| {
        recursive = try expectBool(recursive_val);
    }

    return .{
        .id = id,
        .path = path,
        .cwd = cwd,
        .force = force,
        .recursive = recursive,
    };
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
