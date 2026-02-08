//! Generic virtio-serial TCP forwarder used by sandboxssh and sandboxingress.
//!
//! The host opens a virtio-serial connection and speaks the `tcp_*` messages from
//! `protocol.zig`. For each logical stream id, we open a non-blocking TCP
//! connection to a loopback service inside the guest and proxy data in both
//! directions with basic backpressure.

const std = @import("std");
const protocol = @import("protocol.zig");

const MAX_BUFFERED_VIRTIO: usize = 256 * 1024;
const MAX_BUFFERED_TCP: usize = 256 * 1024;

const Conn = struct {
    fd: std.posix.fd_t,
    /// pending bytes to write to tcp socket
    pending: std.ArrayList(u8),
    /// whether the host half-closed the write side
    host_eof: bool,
    /// whether we've half-closed the backend TCP socket write side
    backend_shutdown: bool,
};

pub fn run(virtio_port_name: []const u8, log: anytype) !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    log.info("starting", .{});

    var virtio = try openVirtioPort(virtio_port_name, log);
    defer virtio.close();
    const virtio_fd: std.posix.fd_t = virtio.handle;

    // Non-blocking virtio makes the event loop easier.
    const original_flags = try std.posix.fcntl(virtio_fd, std.posix.F.GETFL, 0);
    const nonblock_flag_u32: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
    const nonblock_flag: usize = @intCast(nonblock_flag_u32);
    _ = try std.posix.fcntl(virtio_fd, std.posix.F.SETFL, original_flags | nonblock_flag);
    defer _ = std.posix.fcntl(virtio_fd, std.posix.F.SETFL, original_flags) catch {};

    var reader = protocol.FrameReader.init(allocator);
    defer reader.deinit();

    var writer = protocol.FrameWriter.init(allocator);
    defer writer.deinit();

    var conns = std.AutoHashMap(u32, Conn).init(allocator);
    defer {
        var it = conns.iterator();
        while (it.next()) |entry| {
            std.posix.close(entry.value_ptr.fd);
            entry.value_ptr.pending.deinit(allocator);
        }
        conns.deinit();
    }

    var buffer: [8192]u8 = undefined;

    while (true) {
        // Build pollfds: virtio + each tcp fd
        var pollfds = std.ArrayList(std.posix.pollfd).empty;
        defer pollfds.deinit(allocator);

        var virtio_events: i16 = std.posix.POLL.IN;
        if (writer.hasPending()) virtio_events |= std.posix.POLL.OUT;
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
                events |= std.posix.POLL.IN;
            }
            if (conn.pending.items.len > 0) {
                events |= std.posix.POLL.OUT;
            }
            // Always watch HUP/ERR
            events |= std.posix.POLL.HUP;
            try pollfds.append(allocator, .{ .fd = conn.fd, .events = events, .revents = 0 });
        }

        _ = std.posix.poll(pollfds.items, 100) catch |err| {
            log.err("poll failed: {s}", .{@errorName(err)});
            continue;
        };

        // virtio ready
        const v_revents = pollfds.items[0].revents;
        if ((v_revents & std.posix.POLL.OUT) != 0) {
            writer.flush(virtio_fd) catch |err| {
                log.err("virtio flush failed: {s}", .{@errorName(err)});
            };
        }

        if ((v_revents & (std.posix.POLL.IN | std.posix.POLL.HUP)) != 0) {
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
                                closeConn(allocator, &conns, &writer, data.id);
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
                                _ = std.posix.shutdown(conn.fd, .send) catch {};
                            }
                        }
                    },
                    .close => |id| {
                        closeConn(allocator, &conns, &writer, id);
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

            if ((revents & std.posix.POLL.OUT) != 0 and conn_ptr.pending.items.len > 0) {
                const n = std.posix.write(conn_ptr.fd, conn_ptr.pending.items) catch |err| blk: {
                    if (err == error.WouldBlock) break :blk @as(usize, 0);
                    // Remote closed
                    closeConn(allocator, &conns, &writer, id);
                    break :blk @as(usize, 0);
                };
                if (n > 0) {
                    const remaining = conn_ptr.pending.items.len - n;
                    std.mem.copyForwards(u8, conn_ptr.pending.items[0..remaining], conn_ptr.pending.items[n..]);
                    conn_ptr.pending.items = conn_ptr.pending.items[0..remaining];
                }

                if (conn_ptr.pending.items.len == 0 and conn_ptr.host_eof and !conn_ptr.backend_shutdown) {
                    conn_ptr.backend_shutdown = true;
                    _ = std.posix.shutdown(conn_ptr.fd, .send) catch {};
                }
            }

            if ((revents & std.posix.POLL.IN) != 0) {
                const n = std.posix.read(conn_ptr.fd, buffer[0..]) catch |err| blk: {
                    if (err == error.WouldBlock) break :blk @as(usize, 0);
                    closeConn(allocator, &conns, &writer, id);
                    break :blk @as(usize, 0);
                };
                if (n == 0) {
                    closeConn(allocator, &conns, &writer, id);
                } else if (n > 0) {
                    const payload = protocol.encodeTcpData(allocator, id, buffer[0..n]) catch |err| {
                        log.err("encode tcp_data failed: {s}", .{@errorName(err)});
                        continue;
                    };
                    defer allocator.free(payload);
                    writer.enqueue(payload) catch |err| {
                        log.err("virtio enqueue failed: {s}", .{@errorName(err)});
                        closeConn(allocator, &conns, &writer, id);
                        continue;
                    };
                    writer.flush(virtio_fd) catch {};
                }
            }

            if ((revents & std.posix.POLL.HUP) != 0) {
                closeConn(allocator, &conns, &writer, id);
            }
        }
    }
}

fn closeConn(
    allocator: std.mem.Allocator,
    conns: *std.AutoHashMap(u32, Conn),
    writer: *protocol.FrameWriter,
    id: u32,
) void {
    if (conns.fetchRemove(id)) |entry| {
        std.posix.close(entry.value.fd);
        var pending = entry.value.pending;
        pending.deinit(allocator);

        const payload = protocol.encodeTcpClose(allocator, id) catch return;
        defer allocator.free(payload);
        writer.enqueue(payload) catch return;
    }
}

fn handleOpen(
    allocator: std.mem.Allocator,
    conns: *std.AutoHashMap(u32, Conn),
    writer: *protocol.FrameWriter,
    virtio_fd: std.posix.fd_t,
    open: protocol.TcpOpen,
) !void {
    // Only allow loopback
    if (!std.mem.eql(u8, open.host, "127.0.0.1") and !std.mem.eql(u8, open.host, "localhost")) {
        try sendOpened(allocator, writer, virtio_fd, open.id, false, "only loopback allowed");
        return;
    }

    // Close existing
    closeConn(allocator, conns, writer, open.id);

    const addr = try std.net.Address.parseIp("127.0.0.1", open.port);
    const stream = std.net.tcpConnectToAddress(addr) catch |err| {
        try sendOpened(allocator, writer, virtio_fd, open.id, false, @errorName(err));
        return;
    };
    const fd = stream.handle;

    // Set nonblocking
    const flags = try std.posix.fcntl(fd, std.posix.F.GETFL, 0);
    const nonblock_flag_u32: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
    const nonblock_flag: usize = @intCast(nonblock_flag_u32);
    _ = try std.posix.fcntl(fd, std.posix.F.SETFL, flags | nonblock_flag);

    const pending = std.ArrayList(u8).empty;
    try conns.put(open.id, .{ .fd = fd, .pending = pending, .host_eof = false, .backend_shutdown = false });

    try sendOpened(allocator, writer, virtio_fd, open.id, true, null);
}

fn sendOpened(
    allocator: std.mem.Allocator,
    writer: *protocol.FrameWriter,
    virtio_fd: std.posix.fd_t,
    id: u32,
    ok: bool,
    message: ?[]const u8,
) !void {
    const payload = try protocol.encodeTcpOpened(allocator, id, ok, message);
    defer allocator.free(payload);
    try writer.enqueue(payload);
    try writer.flush(virtio_fd);
}

fn tryOpenVirtioPath(path: []const u8) !?std.fs.File {
    const fd = std.posix.open(path, .{ .ACCMODE = .RDWR, .NONBLOCK = true, .CLOEXEC = true }, 0) catch |err| switch (err) {
        error.FileNotFound, error.NoDevice => return null,
        else => return err,
    };

    // switch to blocking
    const original_flags = try std.posix.fcntl(fd, std.posix.F.GETFL, 0);
    const nonblock_flag_u32: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
    const nonblock_flag: usize = @intCast(nonblock_flag_u32);
    _ = try std.posix.fcntl(fd, std.posix.F.SETFL, original_flags & ~nonblock_flag);

    return std.fs.File{ .handle = fd };
}

fn scanVirtioPorts(virtio_port_name: []const u8) !?std.fs.File {
    var dev_dir = std.fs.openDirAbsolute("/dev", .{ .iterate = true }) catch return null;
    defer dev_dir.close();

    var it = dev_dir.iterate();
    var path_buf: [64]u8 = undefined;
    while (try it.next()) |entry| {
        if (!std.mem.startsWith(u8, entry.name, "vport")) continue;
        if (!virtioPortMatches(entry.name, virtio_port_name)) continue;
        const path = try std.fmt.bufPrint(&path_buf, "/dev/{s}", .{entry.name});
        if (try tryOpenVirtioPath(path)) |file| return file;
    }

    return null;
}

fn virtioPortMatches(port_name: []const u8, expected: []const u8) bool {
    var path_buf: [128]u8 = undefined;
    const sys_path = std.fmt.bufPrint(&path_buf, "/sys/class/virtio-ports/{s}/name", .{port_name}) catch return false;
    var file = std.fs.openFileAbsolute(sys_path, .{}) catch return false;
    defer file.close();

    var name_buf: [64]u8 = undefined;
    const size = file.readAll(&name_buf) catch return false;
    const trimmed = std.mem.trim(u8, name_buf[0..size], " \r\n\t");
    return std.mem.eql(u8, trimmed, expected);
}

fn openVirtioPort(virtio_port_name: []const u8, log: anytype) !std.fs.File {
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

        std.posix.nanosleep(0, 100 * std.time.ns_per_ms);
    }
}
