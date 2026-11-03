//! Discovery and opening of named virtio-serial ports.
//!
//! Ports are normally exposed as `/dev/virtio-ports/<name>` (created by the
//! init script); when that symlink is missing we scan `/dev/vport*` and match
//! `/sys/class/virtio-ports/<dev>/name`.

const std = @import("std");
const sys = @import("sys.zig");

const log = std.log.scoped(.virtio_port);

pub const Mode = enum { blocking, nonblocking };

/// Open a port device; null if it does not exist (yet).
pub fn tryOpenPath(path: []const u8, mode: Mode) sys.OpenError!?sys.fd_t {
    // O_NONBLOCK on open so a missing host connection never blocks open(2).
    const fd = sys.open(path, .{ .ACCMODE = .RDWR, .NONBLOCK = true }, 0) catch |err| switch (err) {
        error.FileNotFound, error.NoDevice => return null,
        else => return err,
    };
    if (mode == .blocking) sys.setNonblocking(fd, false) catch |err| {
        sys.close(fd);
        return err;
    };
    return fd;
}

/// Whether `/dev/<device>` is the virtio port named `expected`.
fn portMatches(device: []const u8, expected: []const u8) bool {
    var path_buf: [128]u8 = undefined;
    const sys_path = std.mem.printSentinel(&path_buf, "/sys/class/virtio-ports/{s}/name", .{device}, 0) catch return false;
    const fd = sys.openZ(sys_path, .{ .ACCMODE = .RDONLY }, 0) catch return false;
    defer sys.close(fd);

    var name_buf: [64]u8 = undefined;
    const n = sys.read(fd, &name_buf) catch return false;
    return std.mem.eql(u8, std.mem.trim(u8, name_buf[0..n], " \r\n\t"), expected);
}

/// Scan `/dev/vport*` for the port named `name` and open it.
pub fn scan(name: []const u8, mode: Mode) sys.OpenError!?sys.fd_t {
    var dir = sys.DirIterator.open("/dev") catch return null;
    defer dir.deinit();

    var path_buf: [64]u8 = undefined;
    while (dir.next()) |entry| {
        if (!std.mem.startsWith(u8, entry, "vport")) continue;
        if (!portMatches(entry, name)) continue;
        const path = std.mem.print(&path_buf, "/dev/{s}", .{entry}) catch continue;
        if (try tryOpenPath(path, mode)) |fd| return fd;
    }
    return null;
}

/// Try to open the port named `name` once, via the symlink or by scanning.
pub fn tryOpen(name: []const u8, mode: Mode) sys.OpenError!?sys.fd_t {
    var path_buf: [128]u8 = undefined;
    const direct = std.mem.print(&path_buf, "/dev/virtio-ports/{s}", .{name}) catch return error.NameTooLong;
    if (try tryOpenPath(direct, mode)) |fd| return fd;
    return scan(name, mode);
}

/// Open the port named `name`, polling every 100 ms until it shows up.
pub fn open(name: []const u8, mode: Mode) sys.OpenError!sys.fd_t {
    var warned = false;
    while (true) {
        if (try tryOpen(name, mode)) |fd| return fd;
        if (!warned) {
            log.info("waiting for {s} port", .{name});
            warned = true;
        }
        sys.sleepMs(100);
    }
}
