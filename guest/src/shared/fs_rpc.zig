//! Synchronous client for the `virtio-fs` filesystem RPC used by sandboxfs.
//!
//! Strictly request/response: one `fs_request` is written and the matching
//! `fs_response` is read before the next request is issued, so responses are
//! never interleaved.  Responses with an older id (left over from a call that
//! failed before reading its response) are skipped.
//!
//!   request:  { v: 1, t: "fs_request",  id, p: { op, req: { ...fields } } }
//!   response: { v: 1, t: "fs_response", id, p: { op, err, res?, message? } }
//!
//! `err` is an errno value (0 = success, the sign is ignored); `res` is an op
//! specific map.

const std = @import("std");
const sys = @import("sys.zig");
const cbor = @import("cbor.zig");
const protocol = @import("protocol.zig");
const framing = @import("framing.zig");

const Allocator = std.mem.Allocator;

pub const Response = struct {
    /// errno reported by the host (`.SUCCESS` when the op succeeded)
    err: sys.E,
    /// result map (`.null` when absent)
    res: cbor.Value,

    /// Look up a key of the result map.
    pub fn get(self: Response, key: []const u8) ?cbor.Value {
        return self.res.get(key);
    }
};

pub const CallError = error{
    /// response type, id or op does not match the request
    UnexpectedResponse,
    EndOfStream,
    FrameTooLarge,
} || cbor.DecodeError || cbor.ParseError || protocol.Envelope.DecodeError || sys.ReadError || sys.WriteError;

pub const Client = struct {
    gpa: Allocator,
    /// blocking virtio-fs port
    fd: sys.fd_t,
    next_id: u32 = 1,
    send_buf: std.Io.Writer.Allocating,
    recv_buf: std.ArrayList(u8) = .empty,

    pub fn init(gpa: Allocator, fd: sys.fd_t) Client {
        return .{ .gpa = gpa, .fd = fd, .send_buf = .init(gpa) };
    }

    pub fn deinit(self: *Client) void {
        self.send_buf.deinit();
        self.recv_buf.deinit(self.gpa);
    }

    /// Perform one RPC.  `req` is any struct accepted by `cbor.encode`.
    /// The response (decoded into `arena`) aliases an internal buffer and is
    /// only valid until the next call.
    pub fn call(self: *Client, arena: Allocator, op: []const u8, req: anytype) CallError!Response {
        const id = self.next_id;
        self.next_id = if (id == std.math.maxInt(u32)) 1 else id + 1;

        self.send_buf.writer.end = 0;
        protocol.encodeRaw(&self.send_buf.writer, "fs_request", id, .{ .op = op, .req = req }) catch return error.OutOfMemory;
        try framing.writeFrame(self.fd, self.send_buf.writer.buffered());

        // Responses to earlier requests whose call failed before reading
        // them (e.g. a transport error) are skipped so the stream recovers.
        const env = while (true) {
            const frame = try framing.readFrame(self.gpa, self.fd, &self.recv_buf);
            const env = try protocol.Envelope.decode(arena, frame);
            if (env.tag() != .fs_response) return error.UnexpectedResponse;
            const response_id = try env.id();
            if (response_id == id) break env;
            std.log.scoped(.fs_rpc).warn("skipping stale response {d} (waiting for {d})", .{ response_id, id });
        };
        const p = try env.payload(arena, .fs_response);
        if (!std.mem.eql(u8, p.op, op)) return error.UnexpectedResponse;

        const res = p.res orelse .null;
        if (res != .null and res != .map) return error.InvalidType;
        return .{ .err = errnoFromWire(p.err), .res = res };
    }
};

/// Map a wire errno (either sign) to `E`; out-of-range values become `EIO`.
pub fn errnoFromWire(err: i64) sys.E {
    if (err == 0) return .SUCCESS;
    const magnitude = @abs(err);
    if (magnitude >= 4096) return .IO;
    return @fromBackingInt(@as(u16, @intCast(magnitude)));
}

test "wire errno mapping" {
    try std.testing.expectEqual(sys.E.SUCCESS, errnoFromWire(0));
    try std.testing.expectEqual(sys.E.NOENT, errnoFromWire(2));
    try std.testing.expectEqual(sys.E.NOENT, errnoFromWire(-2));
    try std.testing.expectEqual(sys.E.IO, errnoFromWire(1 << 40));
    try std.testing.expectEqual(sys.E.IO, errnoFromWire(std.math.minInt(i64)));
}

test "stale responses are skipped" {
    const linux = std.os.linux;
    var pair: [2]i32 = undefined;
    if (linux.errno(linux.socketpair(linux.AF.UNIX, linux.SOCK.STREAM | linux.SOCK.CLOEXEC, 0, &pair)) != .SUCCESS) return error.SocketPairFailed;
    defer sys.close(pair[1]);

    var outbox: framing.Outbox = .init(std.testing.allocator);
    defer outbox.deinit();
    try outbox.sendRaw("fs_response", 7, .{ .op = "getattr", .err = 0 });
    try outbox.sendRaw("fs_response", 1, .{ .op = "getattr", .err = -2 });
    try sys.writeAll(pair[1], outbox.aw.writer.buffered());

    var client: Client = .init(std.testing.allocator, pair[0]);
    defer {
        sys.close(client.fd);
        client.deinit();
    }
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    const response = try client.call(arena_state.allocator(), "getattr", .{ .ino = @as(u64, 1) });
    try std.testing.expectEqual(sys.E.NOENT, response.err);
    try std.testing.expect(response.res == .null);
}
