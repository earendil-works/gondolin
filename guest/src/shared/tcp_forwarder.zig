//! Virtio-serial ⇄ loopback TCP forwarder used by `sandboxssh` and
//! `sandboxingress`.
//!
//! The host multiplexes logical streams over one virtio-serial port using the
//! `tcp_*` messages.  For each stream id the forwarder connects to a loopback
//! TCP service inside the guest and proxies bytes in both directions.
//!
//! Single-threaded `poll(2)` loop over the virtio fd and every TCP socket:
//! - host → guest: `tcp_data` is appended to the stream's pending buffer and
//!   written when the socket is writable.  More than `max_pending_tcp` unsent
//!   bytes closes the stream (the host is expected to respect TCP
//!   backpressure on its side).
//! - guest → host: sockets are only polled for input while the virtio outbox
//!   holds less than `max_pending_virtio` bytes, which propagates virtio
//!   backpressure to the guest services through TCP flow control.
//! - When the host end of the port disconnects all streams are dropped and
//!   the forwarder waits for the host to reconnect.

const std = @import("std");
const sys = @import("sys.zig");
const protocol = @import("protocol.zig");
const virtio_port = @import("virtio_port.zig");
const Channel = @import("channel.zig").Channel;
const reconnect_poll_ms = @import("channel.zig").reconnect_poll_ms;

const Allocator = std.mem.Allocator;
const log = std.log.scoped(.tcp_forwarder);

/// Outbox high-water mark above which sockets are not read, in `bytes`
pub const max_pending_virtio: usize = 256 * 1024;
/// Maximum unsent host data per stream before it is closed, in `bytes`
pub const max_pending_tcp: usize = 256 * 1024;
/// Maximum payload of one `tcp_data` frame sent to the host, in `bytes`
pub const read_chunk: usize = 8 * 1024;

const Conn = struct {
    fd: sys.fd_t,
    /// host data not yet written to the socket: `pending.items[pending_head..]`
    pending: std.ArrayList(u8) = .empty,
    pending_head: usize = 0,
    /// host sent `tcp_eof`; shut down our write side once `pending` drains
    host_eof: bool = false,
    /// `shutdown(SHUT_WR)` already issued
    backend_shutdown: bool = false,

    fn pendingBytes(self: *const Conn) []const u8 {
        return self.pending.items[self.pending_head..];
    }

    fn consume(self: *Conn, n: usize) void {
        self.pending_head += n;
        if (self.pending_head == self.pending.items.len) {
            self.pending.clearRetainingCapacity();
            self.pending_head = 0;
        }
    }

    fn append(self: *Conn, gpa: Allocator, data: []const u8) Allocator.Error!void {
        if (self.pending_head > 0) {
            const rest = self.pending.items[self.pending_head..];
            std.mem.copyForwards(u8, self.pending.items[0..rest.len], rest);
            self.pending.items.len = rest.len;
            self.pending_head = 0;
        }
        try self.pending.appendSlice(gpa, data);
    }

    fn maybeShutdown(self: *Conn) void {
        if (self.host_eof and !self.backend_shutdown and self.pendingBytes().len == 0) {
            self.backend_shutdown = true;
            sys.shutdownWrite(self.fd);
        }
    }
};

pub const Forwarder = struct {
    gpa: Allocator,
    channel: Channel,
    conns: std.array_hash_map.Auto(u32, Conn) = .empty,
    /// per-message decode arena, reset after every frame
    arena: std.heap.ArenaAllocator,
    read_buf: [read_chunk]u8 = undefined,

    pub fn init(gpa: Allocator, virtio_fd: sys.fd_t) Forwarder {
        return .{
            .gpa = gpa,
            .channel = .init(gpa, virtio_fd),
            .arena = .init(gpa),
        };
    }

    pub fn deinit(self: *Forwarder) void {
        self.dropAll();
        self.conns.deinit(self.gpa);
        self.channel.deinit(self.gpa);
        self.arena.deinit();
    }

    pub fn run(self: *Forwarder) !void {
        var pollfds: std.ArrayList(sys.pollfd) = .empty;
        defer pollfds.deinit(self.gpa);
        var poll_ids: std.ArrayList(u32) = .empty;
        defer poll_ids.deinit(self.gpa);

        while (true) {
            pollfds.clearRetainingCapacity();
            poll_ids.clearRetainingCapacity();

            var timeout: i32 = -1;
            const virtio_events = self.channel.pollEvents();
            if (virtio_events) |events| {
                try pollfds.append(self.gpa, .{ .fd = self.channel.fd, .events = events, .revents = 0 });
            } else {
                timeout = reconnect_poll_ms;
            }

            const read_allowed = self.channel.outbox.pending() < max_pending_virtio;
            for (self.conns.keys(), self.conns.values()) |id, *conn| {
                var events: i16 = 0;
                if (read_allowed) events |= sys.POLL.IN;
                if (conn.pendingBytes().len > 0) events |= sys.POLL.OUT;
                // A hung-up socket reports POLLHUP even with no events
                // requested; leave idle sockets out to avoid spinning.
                if (events == 0) continue;
                try pollfds.append(self.gpa, .{ .fd = conn.fd, .events = events, .revents = 0 });
                try poll_ids.append(self.gpa, id);
            }

            _ = try sys.poll(pollfds.items, timeout);

            var conn_fds = pollfds.items;
            if (virtio_events != null) {
                try self.onVirtioReady(pollfds.items[0].revents);
                conn_fds = conn_fds[1..];
            } else if (self.channel.probeReconnect()) {
                continue;
            }

            for (conn_fds, poll_ids.items) |pfd, id| {
                if (pfd.revents != 0) try self.onConnReady(id, pfd.revents);
            }
            _ = self.channel.flush();
        }
    }

    fn onVirtioReady(self: *Forwarder, revents: i16) !void {
        switch (try self.channel.onReady(self.gpa, revents)) {
            .ok => {},
            .disconnected => {
                self.dropAll();
                self.channel.outbox.clear();
                return;
            },
        }
        while (true) {
            const frame = self.channel.reader.next() catch |err| {
                log.err("dropping frame: {t}", .{err});
                continue;
            } orelse break;
            defer _ = self.arena.reset(.retain_capacity);
            self.handleFrame(frame) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => log.err("invalid tcp message: {t}", .{err}),
            };
        }
    }

    fn handleFrame(self: *Forwarder, frame: []const u8) !void {
        const arena = self.arena.allocator();
        const env = try protocol.Envelope.decode(arena, frame);
        const tag = env.tag() orelse return error.UnexpectedType;
        const id = try env.id();
        switch (tag) {
            .tcp_open => try self.open(id, try env.payload(arena, .tcp_open)),
            .tcp_data => {
                const data = (try env.payload(arena, .tcp_data)).data.data;
                const conn = self.conns.getPtr(id) orelse return;
                if (conn.pendingBytes().len + data.len > max_pending_tcp) {
                    log.warn("stream {d}: host overran the pending buffer; closing", .{id});
                    return self.close(id);
                }
                try conn.append(self.gpa, data);
            },
            .tcp_eof => {
                _ = try env.payload(arena, .tcp_eof);
                const conn = self.conns.getPtr(id) orelse return;
                conn.host_eof = true;
                conn.maybeShutdown();
            },
            .tcp_close => {
                _ = try env.payload(arena, .tcp_close);
                self.close(id);
            },
            else => return error.UnexpectedType,
        }
    }

    fn open(self: *Forwarder, id: u32, req: protocol.TcpOpen) !void {
        if (!std.mem.eql(u8, req.host, "127.0.0.1") and !std.mem.eql(u8, req.host, "localhost")) {
            return self.channel.outbox.send(.tcp_opened, id, .{ .ok = false, .message = "only loopback allowed" });
        }
        self.close(id);

        // Every tcp_open gets a tcp_opened; on failure the socket is closed.
        const fd = self.connect(req.port) catch |err| {
            return self.channel.outbox.send(.tcp_opened, id, .{ .ok = false, .message = @errorName(err) });
        };
        self.conns.putAssumeCapacity(id, .{ .fd = fd });
        try self.channel.outbox.send(.tcp_opened, id, .{ .ok = true });
    }

    /// Connect to the loopback port and prepare the socket for the loop.
    fn connect(self: *Forwarder, port: u16) !sys.fd_t {
        try self.conns.ensureUnusedCapacity(self.gpa, 1);
        const fd = try sys.tcpConnectLoopback(port);
        errdefer sys.close(fd);
        try sys.setNonblocking(fd, true);
        return fd;
    }

    fn onConnReady(self: *Forwarder, id: u32, revents: i16) !void {
        const conn = self.conns.getPtr(id) orelse return;

        if (revents & (sys.POLL.OUT | sys.POLL.ERR | sys.POLL.HUP) != 0 and conn.pendingBytes().len > 0) {
            const n = sys.write(conn.fd, conn.pendingBytes()) catch |err| switch (err) {
                error.WouldBlock => 0,
                else => return self.close(id),
            };
            conn.consume(n);
            conn.maybeShutdown();
        }

        if (revents & (sys.POLL.IN | sys.POLL.HUP | sys.POLL.ERR) == 0) return;
        // After a hang-up drain everything that is still buffered; otherwise
        // read one chunk per wakeup to stay fair across streams.
        const drain = revents & (sys.POLL.HUP | sys.POLL.ERR) != 0;
        while (self.channel.outbox.pending() < max_pending_virtio) {
            const fd = (self.conns.getPtr(id) orelse return).fd;
            const n = sys.read(fd, &self.read_buf) catch |err| switch (err) {
                error.WouldBlock => return,
                else => return self.close(id),
            };
            if (n == 0) return self.close(id);
            self.forward(id, self.read_buf[0..n]);
            if (!drain) return;
        }
    }

    /// Queue socket data for the host; a stream whose data cannot be queued
    /// is closed instead of silently losing bytes.
    fn forward(self: *Forwarder, id: u32, data: []const u8) void {
        self.channel.outbox.send(.tcp_data, id, .{ .data = .{ .data = data } }) catch |err| {
            log.warn("stream {d}: cannot queue tcp_data: {t}", .{ id, err });
            return self.close(id);
        };
        _ = self.channel.flush();
    }

    /// Close a stream and tell the host (no-op for unknown ids).
    fn close(self: *Forwarder, id: u32) void {
        var entry = self.conns.fetchSwapRemove(id) orelse return;
        sys.close(entry.value.fd);
        entry.value.pending.deinit(self.gpa);
        self.channel.outbox.send(.tcp_close, id, .{}) catch |err| {
            log.warn("stream {d}: cannot queue tcp_close: {t}", .{ id, err });
        };
    }

    /// Close every stream without notifying the host (it is gone).
    fn dropAll(self: *Forwarder) void {
        for (self.conns.values()) |*conn| {
            sys.close(conn.fd);
            conn.pending.deinit(self.gpa);
        }
        self.conns.clearRetainingCapacity();
    }
};

/// Entry point shared by `sandboxssh` and `sandboxingress`.
pub fn main(port_name: []const u8) !void {
    const runtime = @import("runtime.zig");
    runtime.init();
    const gpa = runtime.gpa();
    defer runtime.deinitGpa();

    log.info("starting on {s}", .{port_name});
    const fd = try virtio_port.open(port_name, .nonblocking);

    var forwarder: Forwarder = .init(gpa, fd);
    forwarder.channel.name = port_name;
    defer forwarder.deinit();
    // the channel may replace its fd when it reconnects (vsock)
    defer sys.close(forwarder.channel.fd);
    try forwarder.run();
}

const testing = std.testing;

test "socket data that cannot be queued closes the stream" {
    var fba_buf: [16 * 1024]u8 = undefined;
    var fba: std.heap.FixedBufferAllocator = .init(&fba_buf);
    const gpa = fba.allocator();

    const pipe = try sys.pipe(true);
    defer sys.close(pipe[1]);

    var forwarder: Forwarder = .init(gpa, pipe[1]);
    defer forwarder.deinit();
    try forwarder.conns.put(gpa, 7, .{ .fd = pipe[0] });

    // larger than the remaining allocator space: tcp_data cannot be queued
    const payload: [12 * 1024]u8 = @splat(0xaa);
    forwarder.forward(7, &payload);
    try testing.expect(!forwarder.conns.contains(7));
}

test "tcp messages drive stream state" {
    const gpa = testing.allocator;
    const virtio = try sys.pipe(true);
    defer sys.close(virtio[0]);
    defer sys.close(virtio[1]);
    const sock = try sys.pipe(true);
    defer sys.close(sock[0]);

    var forwarder: Forwarder = .init(gpa, virtio[1]);
    defer forwarder.deinit();
    try forwarder.conns.put(gpa, 3, .{ .fd = sock[1] });

    var buf: [256]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try protocol.encode(&w, .tcp_data, 3, .{ .data = .{ .data = "ping" } });
    try forwarder.handleFrame(w.buffered());
    try testing.expectEqualStrings("ping", forwarder.conns.getPtr(3).?.pendingBytes());

    try forwarder.onConnReady(3, sys.POLL.OUT);
    var out: [8]u8 = undefined;
    try testing.expectEqualStrings("ping", out[0..try sys.read(sock[0], &out)]);

    w = .fixed(&buf);
    try protocol.encode(&w, .tcp_close, 3, .{});
    try forwarder.handleFrame(w.buffered());
    try testing.expect(!forwarder.conns.contains(3));
    try testing.expect(forwarder.channel.outbox.pending() > 0); // tcp_close echoed

    w = .fixed(&buf);
    try protocol.encode(&w, .tcp_open, 4, .{ .host = "10.0.0.1", .port = 22 });
    try forwarder.handleFrame(w.buffered());
    try testing.expect(!forwarder.conns.contains(4));
}

fn expectOpened(forwarder: *Forwarder, id: u32, ok: bool, message: ?[]const u8) !void {
    var reader: @import("framing.zig").FrameReader = .{};
    defer reader.deinit(testing.allocator);
    try reader.feed(testing.allocator, forwarder.channel.outbox.aw.writer.buffered());
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const env = try protocol.Envelope.decode(arena_state.allocator(), (try reader.next()).?);
    try testing.expectEqual(protocol.Tag.tcp_opened, env.tag().?);
    try testing.expectEqual(id, try env.id());
    const opened = try env.payload(arena_state.allocator(), .tcp_opened);
    try testing.expectEqual(ok, opened.ok);
    if (message) |m| try testing.expectEqualStrings(m, opened.message.?) else try testing.expect(opened.message == null);
}

test "every tcp_open is answered, also when setup fails" {
    var failing: std.testing.FailingAllocator = .init(testing.allocator, .{});
    const gpa = failing.allocator();
    const virtio = try sys.pipe(true);
    defer sys.close(virtio[0]);
    defer sys.close(virtio[1]);

    var forwarder: Forwarder = .init(gpa, virtio[1]);
    defer forwarder.deinit();

    var buf: [128]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try protocol.encode(&w, .tcp_open, 1, .{ .host = "127.0.0.1", .port = 1 });
    const open_frame = w.buffered();

    // nothing listens on port 1
    try forwarder.handleFrame(open_frame);
    try expectOpened(&forwarder, 1, false, "ConnectionRefused");
    try testing.expect(!forwarder.conns.contains(1));

    // stream table cannot grow: the reply still goes out (the outbox buffer
    // is pre-grown) and no socket is leaked
    var fresh: Forwarder = .init(gpa, virtio[1]);
    defer fresh.deinit();
    try fresh.channel.outbox.send(.tcp_data, 9, .{ .data = .{ .data = &(@as([256]u8, @splat(0))) } });
    fresh.channel.outbox.clear();
    failing.fail_index = failing.alloc_index;
    try fresh.open(1, .{ .host = "127.0.0.1", .port = 1 });
    try expectOpened(&fresh, 1, false, "OutOfMemory");
    try testing.expect(!fresh.conns.contains(1));
}
