//! Generic virtio-serial TCP forwarder used by sandboxssh and sandboxingress.
//!
//! The host opens a virtio-serial connection and speaks the `tcp_*` messages from
//! `protocol.zig`. For each logical stream id, we open a non-blocking TCP
//! connection to a loopback service inside the guest and proxy data in both
//! directions with basic backpressure.

const std = @import("std");
const posix = @import("posix_compat.zig");
const protocol = @import("protocol.zig");

const MAX_BUFFERED_VIRTIO: usize = 256 * 1024;
const MAX_BUFFERED_TCP: usize = 256 * 1024;

const BackendReadResult = enum {
    would_block,
    forwarded,
    closed,
};

const Conn = struct {
    fd: posix.fd_t,
    /// pending bytes to write to tcp socket
    pending: std.ArrayList(u8),
    /// whether the host half-closed the write side
    host_eof: bool,
    /// whether we've half-closed the backend TCP socket write side
    backend_shutdown: bool,
};

pub fn run(virtio_port_name: []const u8, log: anytype) !void {
    var gpa = std.heap.DebugAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    log.info("starting", .{});

    const virtio_fd = try openVirtioPort(virtio_port_name, log);
    defer posix.close(virtio_fd);

    // Non-blocking virtio makes the event loop easier.
    const original_flags = try posix.fcntl(virtio_fd, posix.F.GETFL, 0);
    const nonblock_flag: c_int = @bitCast(posix.O{ .NONBLOCK = true });
    _ = try posix.fcntl(virtio_fd, posix.F.SETFL, original_flags | nonblock_flag);
    defer _ = posix.fcntl(virtio_fd, posix.F.SETFL, original_flags) catch {};

    var reader = protocol.FrameReader.init(allocator);
    defer reader.deinit();

    var writer = protocol.FrameWriter.init(allocator);
    defer writer.deinit();

    var conns = std.AutoHashMap(u32, Conn).init(allocator);
    defer {
        var it = conns.iterator();
        while (it.next()) |entry| {
            posix.close(entry.value_ptr.fd);
            entry.value_ptr.pending.deinit(allocator);
        }
        conns.deinit();
    }

    var buffer: [8192]u8 = undefined;

    while (true) {
        // Build pollfds: virtio + each tcp fd
        var pollfds = std.ArrayList(posix.pollfd).empty;
        defer pollfds.deinit(allocator);

        var virtio_events: i16 = posix.POLL.IN;
        if (writer.hasPending()) virtio_events |= posix.POLL.OUT;
        try pollfds.append(allocator, .{ .fd = virtio_fd, .events = virtio_events, .revents = 0 });

        // Backpressure: if virtio writer is too backed up, stop reading from tcp sockets.
        const backpressure_virtio = writer.pendingBytes() >= MAX_BUFFERED_VIRTIO;

        var conn_ids = std.ArrayList(u32).empty;
        defer conn_ids.deinit(allocator);

        var it = conns.iterator();
        while (it.next()) |entry| {
            const id = entry.key_ptr.*;
            const conn = entry.value_ptr.*;
            try conn_ids.append(allocator, id);

            var events: i16 = 0;
            if (!backpressure_virtio) {
                events |= posix.POLL.IN;
            }
            if (conn.pending.items.len > 0) {
                events |= posix.POLL.OUT;
            }
            // Always watch HUP/ERR
            events |= posix.POLL.HUP;
            try pollfds.append(allocator, .{ .fd = conn.fd, .events = events, .revents = 0 });
        }

        _ = posix.poll(pollfds.items, 100) catch |err| {
            log.err("poll failed: {s}", .{@errorName(err)});
            continue;
        };

        // virtio ready
        const v_revents = pollfds.items[0].revents;
        if ((v_revents & posix.POLL.OUT) != 0) {
            writer.flush(virtio_fd) catch |err| {
                log.err("virtio flush failed: {s}", .{@errorName(err)});
            };
        }

        if ((v_revents & (posix.POLL.IN | posix.POLL.HUP)) != 0) {
            while (true) {
                const frame = reader.readFrame(virtio_fd) catch |err| {
                    if (err == error.EndOfStream) return;
                    log.err("read frame failed: {s}", .{@errorName(err)});
                    break;
                };
                if (frame == null) break;
                const frame_buf = frame.?;
                defer allocator.free(frame_buf);

                const msg = protocol.decodeTcpMessage(allocator, frame_buf) catch |err| {
                    log.err("decode tcp message failed: {s}", .{@errorName(err)});
                    continue;
                };

                switch (msg) {
                    .open => |open| {
                        handleOpen(allocator, &conns, &writer, virtio_fd, open) catch |err| {
                            log.err("tcp_open failed: {s}", .{@errorName(err)});
                        };
                    },
                    .data => |data| {
                        if (conns.getPtr(data.id)) |conn| {
                            if (conn.pending.items.len + data.data.len > MAX_BUFFERED_TCP) {
                                // Too much queued, close.
                                try closeConn(allocator, &conns, &writer, data.id);
                                continue;
                            }
                            try conn.pending.appendSlice(allocator, data.data);
                        }
                    },
                    .eof => |id| {
                        if (conns.getPtr(id)) |conn| {
                            conn.host_eof = true;
                            // Only half-close the backend after we've flushed all pending bytes.
                            if (!conn.backend_shutdown and conn.pending.items.len == 0) {
                                conn.backend_shutdown = true;
                                _ = posix.shutdown(conn.fd, posix.SHUT.WR) catch {};
                            }
                        }
                    },
                    .close => |id| {
                        try closeConn(allocator, &conns, &writer, id);
                    },
                }
            }
        }

        // tcp fds
        var idx: usize = 1;
        for (conn_ids.items) |id| {
            if (idx >= pollfds.items.len) break;
            const revents = pollfds.items[idx].revents;
            idx += 1;

            const conn_ptr = conns.getPtr(id) orelse continue;

            if ((revents & posix.POLL.OUT) != 0 and conn_ptr.pending.items.len > 0) {
                const n = posix.write(conn_ptr.fd, conn_ptr.pending.items) catch |err| blk: {
                    if (err == error.WouldBlock) break :blk @as(usize, 0);
                    // Remote closed
                    try closeConn(allocator, &conns, &writer, id);
                    break :blk @as(usize, 0);
                };

                const active_conn = conns.getPtr(id) orelse continue;

                if (n > 0) {
                    const remaining = active_conn.pending.items.len - n;
                    std.mem.copyForwards(u8, active_conn.pending.items[0..remaining], active_conn.pending.items[n..]);
                    active_conn.pending.items = active_conn.pending.items[0..remaining];
                }

                if (active_conn.pending.items.len == 0 and active_conn.host_eof and !active_conn.backend_shutdown) {
                    active_conn.backend_shutdown = true;
                    _ = posix.shutdown(active_conn.fd, posix.SHUT.WR) catch {};
                }
            }

            if ((revents & (posix.POLL.IN | posix.POLL.HUP)) != 0) {
                const should_drain_backend = (revents & posix.POLL.HUP) != 0;

                while (writer.pendingBytes() < MAX_BUFFERED_VIRTIO) {
                    switch (try forwardBackendReadChunk(
                        allocator,
                        &conns,
                        &writer,
                        virtio_fd,
                        log,
                        id,
                        conn_ptr.fd,
                        buffer[0..],
                    )) {
                        .forwarded => {
                            if (!should_drain_backend) break;
                        },
                        .would_block, .closed => break,
                    }
                }
            }
        }
    }
}

fn forwardBackendReadChunk(
    allocator: std.mem.Allocator,
    conns: *std.AutoHashMap(u32, Conn),
    writer: *protocol.FrameWriter,
    virtio_fd: posix.fd_t,
    log: anytype,
    id: u32,
    backend_fd: posix.fd_t,
    buffer: []u8,
) !BackendReadResult {
    const n = posix.read(backend_fd, buffer) catch |err| {
        if (err == error.WouldBlock) return .would_block;
        try closeConn(allocator, conns, writer, id);
        return .closed;
    };
    if (n == 0) {
        try closeConn(allocator, conns, writer, id);
        return .closed;
    }

    return try forwardBackendPayload(allocator, conns, writer, virtio_fd, log, id, buffer[0..n]);
}

fn forwardBackendPayload(
    allocator: std.mem.Allocator,
    conns: *std.AutoHashMap(u32, Conn),
    writer: *protocol.FrameWriter,
    virtio_fd: posix.fd_t,
    log: anytype,
    id: u32,
    payload_bytes: []const u8,
) !BackendReadResult {
    const payload = protocol.encodeTcpData(allocator, id, payload_bytes) catch |err| {
        log.err("encode tcp_data failed: {s}", .{@errorName(err)});
        try closeConn(allocator, conns, writer, id);
        return .closed;
    };
    defer allocator.free(payload);

    writer.enqueue(payload) catch |err| {
        log.err("virtio enqueue failed: {s}", .{@errorName(err)});
        try closeConn(allocator, conns, writer, id);
        return .closed;
    };
    writer.flush(virtio_fd) catch |err| {
        log.err("virtio flush failed for conn {d}: {s}", .{ id, @errorName(err) });
    };
    return .forwarded;
}

fn closeConn(
    allocator: std.mem.Allocator,
    conns: *std.AutoHashMap(u32, Conn),
    writer: *protocol.FrameWriter,
    id: u32,
) !void {
    if (conns.fetchRemove(id)) |entry| {
        posix.close(entry.value.fd);
        var pending = entry.value.pending;
        pending.deinit(allocator);

        const payload = try protocol.encodeTcpClose(allocator, id);
        defer allocator.free(payload);
        try writer.enqueue(payload);
    }
}

test "forwardBackendPayload closes connection when encoding fails after read" {
    const silent_log = struct {
        fn err(_: @This(), comptime _: []const u8, _: anytype) void {}
    }{};

    var allocator_bytes: [4096]u8 = undefined;
    var fixed_buffer_allocator = std.heap.FixedBufferAllocator.init(&allocator_bytes);
    const allocator = fixed_buffer_allocator.allocator();

    var writer = protocol.FrameWriter.init(allocator);
    defer writer.deinit();

    var conns = std.AutoHashMap(u32, Conn).init(allocator);
    defer {
        var it = conns.iterator();
        while (it.next()) |entry| {
            posix.close(entry.value_ptr.fd);
            entry.value_ptr.pending.deinit(allocator);
        }
        conns.deinit();
    }

    const pipe_fds = try posix.pipe2(.{ .CLOEXEC = true, .NONBLOCK = true });
    defer posix.close(pipe_fds[1]);

    try conns.put(7, .{
        .fd = pipe_fds[0],
        .pending = .empty,
        .host_eof = false,
        .backend_shutdown = false,
    });

    const payload = [_]u8{0xaa} ** 8192;
    const result = try forwardBackendPayload(
        allocator,
        &conns,
        &writer,
        pipe_fds[1],
        silent_log,
        7,
        payload[0..],
    );

    try std.testing.expectEqual(BackendReadResult.closed, result);
    try std.testing.expect(conns.getPtr(7) == null);
}

test "forwardBackendPayload propagates close failure when tcp_close cannot be encoded" {
    const silent_log = struct {
        fn err(_: @This(), comptime _: []const u8, _: anytype) void {}
    }{};

    var failing_allocator_state = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const allocator = failing_allocator_state.allocator();

    var writer = protocol.FrameWriter.init(allocator);
    defer writer.deinit();

    var conns = std.AutoHashMap(u32, Conn).init(allocator);
    defer {
        var it = conns.iterator();
        while (it.next()) |entry| {
            posix.close(entry.value_ptr.fd);
            entry.value_ptr.pending.deinit(allocator);
        }
        conns.deinit();
    }

    const pipe_fds = try posix.pipe2(.{ .CLOEXEC = true, .NONBLOCK = true });
    defer posix.close(pipe_fds[1]);

    try conns.put(9, .{
        .fd = pipe_fds[0],
        .pending = .empty,
        .host_eof = false,
        .backend_shutdown = false,
    });

    failing_allocator_state.fail_index = failing_allocator_state.alloc_index;

    const payload = [_]u8{0xbb} ** 8192;
    try std.testing.expectError(error.OutOfMemory, forwardBackendPayload(
        allocator,
        &conns,
        &writer,
        pipe_fds[1],
        silent_log,
        9,
        payload[0..],
    ));
    try std.testing.expect(conns.getPtr(9) == null);
}

fn handleOpen(
    allocator: std.mem.Allocator,
    conns: *std.AutoHashMap(u32, Conn),
    writer: *protocol.FrameWriter,
    virtio_fd: posix.fd_t,
    open: protocol.TcpOpen,
) !void {
    // Only allow loopback
    if (!std.mem.eql(u8, open.host, "127.0.0.1") and !std.mem.eql(u8, open.host, "localhost")) {
        try sendOpened(allocator, writer, virtio_fd, open.id, false, "only loopback allowed");
        return;
    }

    // Close existing
    try closeConn(allocator, conns, writer, open.id);

    const fd = posix.tcpConnectLoopback(open.port) catch |err| {
        try sendOpened(allocator, writer, virtio_fd, open.id, false, @errorName(err));
        return;
    };

    // Set nonblocking
    const flags = try posix.fcntl(fd, posix.F.GETFL, 0);
    const nonblock_flag: c_int = @bitCast(posix.O{ .NONBLOCK = true });
    _ = try posix.fcntl(fd, posix.F.SETFL, flags | nonblock_flag);

    const pending = std.ArrayList(u8).empty;
    try conns.put(open.id, .{ .fd = fd, .pending = pending, .host_eof = false, .backend_shutdown = false });

    try sendOpened(allocator, writer, virtio_fd, open.id, true, null);
}

fn sendOpened(
    allocator: std.mem.Allocator,
    writer: *protocol.FrameWriter,
    virtio_fd: posix.fd_t,
    id: u32,
    ok: bool,
    message: ?[]const u8,
) !void {
    const payload = try protocol.encodeTcpOpened(allocator, id, ok, message);
    defer allocator.free(payload);
    try writer.enqueue(payload);
    try writer.flush(virtio_fd);
}

fn tryOpenVirtioPath(path: []const u8) !?posix.fd_t {
    const fd = posix.open(path, .{ .ACCMODE = .RDWR, .NONBLOCK = true, .CLOEXEC = true }, 0) catch |err| switch (err) {
        error.FileNotFound, error.NoDevice => return null,
        else => return err,
    };

    // switch to blocking
    const original_flags = try posix.fcntl(fd, posix.F.GETFL, 0);
    const nonblock_flag: c_int = @bitCast(posix.O{ .NONBLOCK = true });
    _ = try posix.fcntl(fd, posix.F.SETFL, original_flags & ~nonblock_flag);

    return fd;
}

fn scanVirtioPorts(virtio_port_name: []const u8) !?posix.fd_t {
    var threaded: std.Io.Threaded = .init_single_threaded;
    const io = threaded.io();
    var dev_dir = std.Io.Dir.openDirAbsolute(io, "/dev", .{ .iterate = true }) catch return null;
    defer dev_dir.close(io);

    var it = dev_dir.iterate();
    var path_buf: [64]u8 = undefined;
    while (try it.next(io)) |entry| {
        if (!std.mem.startsWith(u8, entry.name, "vport")) continue;
        if (!virtioPortMatches(entry.name, virtio_port_name)) continue;
        const path = try std.fmt.bufPrint(&path_buf, "/dev/{s}", .{entry.name});
        if (try tryOpenVirtioPath(path)) |fd| return fd;
    }

    return null;
}

fn virtioPortMatches(port_name: []const u8, expected: []const u8) bool {
    var path_buf: [128]u8 = undefined;
    const sys_path = std.fmt.bufPrint(&path_buf, "/sys/class/virtio-ports/{s}/name", .{port_name}) catch return false;
    const fd = posix.open(sys_path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0) catch return false;
    defer posix.close(fd);

    var name_buf: [64]u8 = undefined;
    const size = posix.read(fd, &name_buf) catch return false;
    const trimmed = std.mem.trim(u8, name_buf[0..size], " \r\n\t");
    return std.mem.eql(u8, trimmed, expected);
}

fn openVirtioPort(virtio_port_name: []const u8, log: anytype) !posix.fd_t {
    var path_buf: [128]u8 = undefined;
    const direct_path = try std.fmt.bufPrint(&path_buf, "/dev/virtio-ports/{s}", .{virtio_port_name});

    var warned = false;

    while (true) {
        if (try tryOpenVirtioPath(direct_path)) |file| return file;
        if (try scanVirtioPorts(virtio_port_name)) |file| return file;

        if (!warned) {
            log.info("waiting for {s} port", .{virtio_port_name});
            warned = true;
        }

        posix.nanosleep(0, 100 * std.time.ns_per_ms);
    }
}
