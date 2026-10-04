//! Discovery and opening of named virtio-serial ports.
//!
//! Ports are normally exposed as `/dev/virtio-ports/<name>`, but when udev/mdev
//! symlinks are not available we fall back to scanning `/dev/vport*` devices
//! and matching their `/sys/class/virtio-ports/<dev>/name` attribute.

const std = @import("std");
const posix = @import("posix_compat.zig");

/// Open a virtio port device path and return a blocking fd, or null if it does not exist (yet).
pub fn tryOpenPath(path: []const u8) !?posix.fd_t {
    const fd = posix.open(path, .{ .ACCMODE = .RDWR, .NONBLOCK = true, .CLOEXEC = true }, 0) catch |err| switch (err) {
        error.FileNotFound, error.NoDevice => return null,
        else => return err,
    };
    errdefer posix.close(fd);

    // switch to blocking
    const original_flags = try posix.fcntl(fd, posix.F.GETFL, 0);
    const nonblock_flag: c_int = @bitCast(posix.O{ .NONBLOCK = true });
    _ = try posix.fcntl(fd, posix.F.SETFL, original_flags & ~nonblock_flag);

    return fd;
}

/// Check whether the `/dev/<port_name>` device is the virtio port named `expected`.
pub fn portMatches(port_name: []const u8, expected: []const u8) bool {
    var path_buf: [128]u8 = undefined;
    const sys_path = std.mem.print(&path_buf, "/sys/class/virtio-ports/{s}/name", .{port_name}) catch return false;
    const fd = posix.open(sys_path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0) catch return false;
    defer posix.close(fd);

    var name_buf: [64]u8 = undefined;
    const size = posix.read(fd, &name_buf) catch return false;
    const trimmed = std.mem.trim(u8, name_buf[0..size], " \r\n\t");
    return std.mem.eql(u8, trimmed, expected);
}

/// Scan `/dev/vport*` for a port named `name` and open it.
pub fn scan(name: []const u8) !?posix.fd_t {
    var threaded: std.Io.Threaded = .init_single_threaded;
    const io = threaded.io();
    var dev_dir = std.Io.Dir.openDirAbsolute(io, "/dev", .{ .iterate = true }) catch return null;
    defer dev_dir.close(io);

    var it = dev_dir.iterate();
    var path_buf: [64]u8 = undefined;
    while (try it.next(io)) |entry| {
        if (!std.mem.startsWith(u8, entry.name, "vport")) continue;
        if (!portMatches(entry.name, name)) continue;
        const path = try std.mem.print(&path_buf, "/dev/{s}", .{entry.name});
        if (try tryOpenPath(path)) |fd| return fd;
    }

    return null;
}

/// Try to open the port named `name` once, via its well-known path or by scanning.
pub fn tryOpen(name: []const u8) !?posix.fd_t {
    var path_buf: [128]u8 = undefined;
    const direct_path = try std.mem.print(&path_buf, "/dev/virtio-ports/{s}", .{name});
    if (try tryOpenPath(direct_path)) |fd| return fd;
    return scan(name);
}

/// Open the port named `name`, waiting until it shows up.
pub fn open(name: []const u8, log: anytype) !posix.fd_t {
    var warned = false;

    while (true) {
        if (try tryOpen(name)) |fd| return fd;

        if (!warned) {
            log.info("waiting for {s} port", .{name});
            warned = true;
        }

        posix.nanosleep(0, 100 * std.time.ns_per_ms);
    }
}
