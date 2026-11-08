//! Guest ↔ host message protocol carried over the virtio-serial ports.
//!
//! Every message is one frame (see `framing.zig`) whose payload is a CBOR map
//! with a fixed envelope:
//!
//!   - `v` (uint): protocol version, always 1 (ignored on receive)
//!   - `t` (text): message type, one of `Tag`
//!   - `id` (uint32): request/stream correlation id
//!   - `p` (map): type specific payload, see `Payload`
//!
//! The payload of each message type is declared below as a plain struct;
//! `cbor.parse` / `cbor.encode` map them to and from CBOR by field name.
//! Fields with defaults or optional types may be omitted by the sender, and
//! unknown keys are ignored.  `[]const u8` fields are CBOR text strings and
//! `cbor.Bytes` fields are CBOR byte strings.

const std = @import("std");
const cbor = @import("cbor.zig");
const Writer = std.Io.Writer;

pub const version = 1;

/// Maximum frame payload in `bytes` (both directions)
pub const max_frame_len: u32 = 4 * 1024 * 1024;

/// Every message type of the protocol.  The ports carry disjoint subsets:
/// `virtio-port` (sandboxd), `virtio-fs` (sandboxfs) and `virtio-ssh` /
/// `virtio-ingress` (TCP forwarders).
pub const Tag = enum {
    // virtio-port: host → guest
    exec_request,
    stdin_data,
    pty_resize,
    exec_window,
    exec_signal,
    file_read_request,
    file_write_request,
    file_write_data,
    file_delete_request,
    time_sync,
    // virtio-port: guest → host
    exec_output,
    exec_response,
    stdin_window,
    file_read_data,
    file_read_done,
    file_write_done,
    file_delete_done,
    time_sync_done,
    vfs_ready,
    vfs_error,
    @"error",
    // virtio-fs
    fs_request,
    fs_response,
    // virtio-ssh / virtio-ingress (both directions unless noted)
    tcp_open,
    tcp_opened,
    tcp_data,
    tcp_eof,
    tcp_close,
};

/// Payload struct for each message type.
pub fn Payload(comptime tag: Tag) type {
    return switch (tag) {
        .exec_request => ExecRequest,
        .stdin_data => StdinData,
        .pty_resize => PtyResize,
        .exec_window => ExecWindow,
        .exec_signal => ExecSignal,
        .file_read_request => FileReadRequest,
        .file_write_request => FileWriteRequest,
        .file_write_data => FileWriteData,
        .file_delete_request => FileDeleteRequest,
        .time_sync => TimeSync,
        .exec_output => ExecOutput,
        .exec_response => ExecResponse,
        .stdin_window => StdinWindow,
        .file_read_data, .tcp_data => Data,
        .file_read_done, .file_write_done, .file_delete_done, .time_sync_done, .tcp_eof, .tcp_close => Empty,
        .vfs_ready => VfsReady,
        .vfs_error => VfsError,
        .@"error" => Error,
        .fs_request => @compileError("fs_request payloads are built with encodeRaw"),
        .fs_response => FsResponse,
        .tcp_open => TcpOpen,
        .tcp_opened => TcpOpened,
    };
}

pub const Empty = struct {};

/// Generic data chunk (`file_read_data`, `tcp_data`)
pub const Data = struct {
    data: cbor.Bytes,
};

/// Default exec output window when the request omits it or sends 0, in `bytes`
pub const default_output_window: u32 = 256 * 1024;

pub const ExecRequest = struct {
    /// executable, resolved via `PATH` when it contains no slash
    cmd: []const u8,
    /// arguments after `argv[0]`; `argv[0]` is `cmd`
    argv: []const []const u8 = &.{},
    /// `KEY=VALUE` entries overriding the inherited environment
    env: []const []const u8 = &.{},
    /// working directory
    cwd: ?[]const u8 = null,
    /// whether the host will send `stdin_data`
    stdin: bool = false,
    /// whether to run the command on a pseudo terminal
    pty: bool = false,
    /// initial stdout credit in `bytes` (0 = default)
    stdout_window: u32 = 0,
    /// initial stderr credit in `bytes` (0 = default)
    stderr_window: u32 = 0,

    pub fn stdoutWindow(self: ExecRequest) u32 {
        return if (self.stdout_window == 0) default_output_window else self.stdout_window;
    }

    pub fn stderrWindow(self: ExecRequest) u32 {
        return if (self.stderr_window == 0) default_output_window else self.stderr_window;
    }
};

pub const StdinData = struct {
    /// stdin bytes, may be empty
    data: cbor.Bytes,
    /// close stdin (pipes) or send `^D` (pty) after `data`
    eof: bool = false,
};

pub const PtyResize = struct {
    rows: u32,
    cols: u32,
};

pub const ExecWindow = struct {
    /// additional stdout credit in `bytes`
    stdout: u32 = 0,
    /// additional stderr credit in `bytes`
    stderr: u32 = 0,
};

/// Send a signal to the process group of exec `id` (the command and everything
/// it started); finished sessions answer `unknown_id`.
pub const ExecSignal = struct {
    /// Linux signal number (1-64)
    signal: u32,
};

pub const FileReadRequest = struct {
    path: []const u8,
    /// base for relative `path`; must be absolute
    cwd: ?[]const u8 = null,
    /// preferred chunk size in `bytes` (0 = default, clamped to 1 KiB..1 MiB)
    chunk_size: u32 = 0,

    pub fn chunkSize(self: FileReadRequest) u32 {
        if (self.chunk_size == 0) return 64 * 1024;
        return std.math.clamp(self.chunk_size, 1024, 1024 * 1024);
    }
};

pub const FileWriteRequest = struct {
    path: []const u8,
    cwd: ?[]const u8 = null,
    /// truncate an existing file instead of overwriting in place
    truncate: bool = true,
};

pub const FileWriteData = struct {
    data: cbor.Bytes,
    /// last chunk of the upload
    eof: bool = false,
};

pub const FileDeleteRequest = struct {
    path: []const u8,
    cwd: ?[]const u8 = null,
    /// treat a missing path as success
    force: bool = false,
    /// delete directories recursively
    recursive: bool = false,
};

pub const TimeSync = struct {
    /// host wall clock since the Unix epoch in `ms`
    unix_ms: u64,
};

pub const ExecOutput = struct {
    /// `"stdout"` or `"stderr"` (pty output is always `"stdout"`)
    stream: []const u8,
    data: cbor.Bytes,
};

pub const ExecResponse = struct {
    /// exit status, or 128 + signal number when killed by a signal
    exit_code: i32,
    /// terminating signal number; omitted for normal exits
    signal: ?i32 = null,
};

pub const StdinWindow = struct {
    /// additional stdin credit in `bytes`
    stdin: u32,
};

/// Optional sandboxd features, announced in `vfs_ready` / `vfs_error` so the
/// host only sends messages this guest understands.
pub const features: []const []const u8 = &.{"exec_signal"};

pub const VfsReady = struct {
    /// optional protocol features of this sandboxd
    features: []const []const u8 = &.{},
};

pub const VfsError = struct {
    message: []const u8,
    /// optional protocol features of this sandboxd
    features: []const []const u8 = &.{},
};

pub const Error = struct {
    /// stable machine readable error code
    code: []const u8,
    message: []const u8,
};

pub const FsResponse = struct {
    /// echo of the request op
    op: []const u8,
    /// errno (0 = success; sign is ignored)
    err: i64,
    /// op specific result map; null or absent on error
    res: ?cbor.Value = null,
    message: ?[]const u8 = null,
};

pub const TcpOpen = struct {
    /// must be `127.0.0.1` or `localhost`
    host: []const u8,
    port: u16,
};

pub const TcpOpened = struct {
    ok: bool,
    /// failure reason when `ok` is false
    message: ?[]const u8 = null,
};

/// Decoded envelope of an incoming message.  The payload is parsed lazily so
/// that callers can report malformed payloads per message type.
pub const Envelope = struct {
    /// raw `t` value
    t: []const u8,
    /// whole decoded CBOR map
    root: cbor.Value,

    pub const DecodeError = cbor.DecodeError || error{ InvalidType, MissingField };

    /// Decode the CBOR map and its `t` field.  Allocations go to `arena`;
    /// strings alias `frame`.
    pub fn decode(arena: std.mem.Allocator, frame: []const u8) DecodeError!Envelope {
        const root = try cbor.decode(arena, frame);
        if (root != .map) return error.InvalidType;
        const t = root.get("t") orelse return error.MissingField;
        if (t != .text) return error.InvalidType;
        return .{ .t = t.text, .root = root };
    }

    /// Known message type, or null for unknown `t` values.
    pub fn tag(self: Envelope) ?Tag {
        return std.meta.stringToEnum(Tag, self.t);
    }

    /// Required `id` field.
    pub fn id(self: Envelope) cbor.ParseError!u32 {
        return cbor.parse(u32, .failing, self.root.get("id") orelse return error.MissingField);
    }

    /// Required `p` map parsed as the payload type of `tag_value`.
    pub fn payload(self: Envelope, arena: std.mem.Allocator, comptime tag_value: Tag) cbor.ParseError!Payload(tag_value) {
        const p = self.root.get("p") orelse return error.MissingField;
        return cbor.parse(Payload(tag_value), arena, p);
    }
};

/// Encode a message with a typed payload.
pub fn encode(w: *Writer, comptime tag: Tag, id: u32, payload: Payload(tag)) Writer.Error!void {
    return encodeRaw(w, @tagName(tag), id, payload);
}

/// Encode a message with an arbitrary payload value (see `cbor.encode`).
pub fn encodeRaw(w: *Writer, t: []const u8, id: u32, payload: anytype) Writer.Error!void {
    return cbor.encode(w, .{ .v = @as(u32, version), .t = t, .id = id, .p = payload });
}

const testing = std.testing;

test "envelope round trip and payload defaults" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var buf: [256]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try encodeRaw(&w, "exec_request", 7, .{ .cmd = "/bin/echo", .argv = @as([]const []const u8, &.{"hi"}), .stdout_window = @as(u32, 0) });

    const env = try Envelope.decode(arena, w.buffered());
    try testing.expectEqual(Tag.exec_request, env.tag().?);
    try testing.expectEqual(@as(u32, 7), try env.id());
    const req = try env.payload(arena, .exec_request);
    try testing.expectEqualStrings("/bin/echo", req.cmd);
    try testing.expectEqualStrings("hi", req.argv[0]);
    try testing.expectEqual(@as(usize, 0), req.env.len);
    try testing.expect(req.cwd == null);
    try testing.expect(!req.pty);
    try testing.expectEqual(default_output_window, req.stdoutWindow());
}

test "time sync decodes Unix milliseconds and acknowledges the request" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var buf: [128]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try encode(&w, .time_sync, 42, .{ .unix_ms = 1_790_000_000_123 });
    const env = try Envelope.decode(arena, w.buffered());
    try testing.expectEqual(Tag.time_sync, env.tag().?);
    try testing.expectEqual(@as(u64, 1_790_000_000_123), (try env.payload(arena, .time_sync)).unix_ms);

    w = .fixed(&buf);
    try encode(&w, .time_sync_done, 42, .{});
    const done = try Envelope.decode(arena, w.buffered());
    try testing.expectEqualStrings("time_sync_done", done.t);
    try testing.expectEqual(@as(u32, 42), try done.id());
    try testing.expectEqual(@as(usize, 0), done.root.get("p").?.map.len);
}

test "exec response omits signal for normal exits" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var buf: [128]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try encode(&w, .exec_response, 1, .{ .exit_code = 3 });
    const p = (try Envelope.decode(arena, w.buffered())).root.get("p").?;
    try testing.expectEqual(@as(usize, 1), p.map.len);
    try testing.expectEqual(@as(i64, 3), p.get("exit_code").?.int);
}

test "envelope rejects malformed messages" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try testing.expectError(error.InvalidType, Envelope.decode(arena, &.{0x01}));
    try testing.expectError(error.MissingField, Envelope.decode(arena, &.{0xa0}));
    try testing.expectError(error.EndOfBuffer, Envelope.decode(arena, &.{0xa1}));

    var buf: [128]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try encodeRaw(&w, "tcp_open", 1, .{ .host = "127.0.0.1", .port = @as(u32, 70000) });
    const env = try Envelope.decode(arena, w.buffered());
    try testing.expectError(error.InvalidValue, env.payload(arena, .tcp_open));

    w = .fixed(&buf);
    try cbor.encode(&w, .{ .t = "stdin_data", .p = .{} });
    try testing.expectError(error.MissingField, (try Envelope.decode(arena, w.buffered())).id());
}

test "null is absent only for optional fields" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    // exec_request whose payload has `field: null` (cbor.encode would omit it)
    const withNull = struct {
        fn encode(buf: []u8, field: []const u8) ![]const u8 {
            var w: Writer = .fixed(buf);
            try cbor.writeHead(&w, .map, 3);
            try cbor.writeText(&w, "t");
            try cbor.writeText(&w, "exec_request");
            try cbor.writeText(&w, "id");
            try cbor.writeInt(&w, 1);
            try cbor.writeText(&w, "p");
            try cbor.writeHead(&w, .map, 2);
            try cbor.writeText(&w, "cmd");
            try cbor.writeText(&w, "sh");
            try cbor.writeText(&w, field);
            try w.writeByte(0xf6);
            return w.buffered();
        }
    }.encode;

    var buf: [128]u8 = undefined;
    const ok = try (try Envelope.decode(arena, try withNull(&buf, "cwd"))).payload(arena, .exec_request);
    try testing.expect(ok.cwd == null);
    try testing.expectError(error.InvalidType, (try Envelope.decode(arena, try withNull(&buf, "stdin"))).payload(arena, .exec_request));
    try testing.expectError(error.InvalidType, (try Envelope.decode(arena, try withNull(&buf, "argv"))).payload(arena, .exec_request));
}

test "file read chunk size is clamped" {
    const req: FileReadRequest = .{ .path = "/x" };
    try testing.expectEqual(@as(u32, 64 * 1024), req.chunkSize());
    try testing.expectEqual(@as(u32, 1024), (FileReadRequest{ .path = "/x", .chunk_size = 1 }).chunkSize());
    try testing.expectEqual(@as(u32, 1024 * 1024), (FileReadRequest{ .path = "/x", .chunk_size = 1 << 30 }).chunkSize());
}
