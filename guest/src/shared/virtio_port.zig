//! Discovery and opening of the host channels (`virtio-port`, `virtio-fs`,
//! `virtio-ssh`, `virtio-ingress`).
//!
//! Two transports carry the same byte streams:
//!
//! - **virtio-serial** (default): named ports, normally exposed as
//!   `/dev/virtio-ports/<name>` (created by the init script); when that symlink
//!   is missing we scan `/dev/vport*` and match
//!   `/sys/class/virtio-ports/<dev>/name`.
//! - **vsock**, selected by `gondolin.vsock` on the kernel command line (for
//!   VMMs without virtio-serial, e.g. Firecracker): each channel is an
//!   `AF_VSOCK` stream connected to the host (CID 2) on a fixed port, see
//!   `vsockPort`.  Unlike a virtio-serial port, a vsock connection does not
//!   come back after the host closes it; `Channel` reconnects instead.

const std = @import("std");
const sys = @import("sys.zig");

const log = std.log.scoped(.virtio_port);

pub const Mode = enum { blocking, nonblocking };

pub const Transport = enum { virtio_serial, vsock };

pub const OpenError = sys.OpenError || sys.ConnectError;

/// Host vsock port of each channel.
pub const vsock_ports = [_]struct { name: []const u8, port: u32 }{
    .{ .name = "virtio-port", .port = 1024 },
    .{ .name = "virtio-fs", .port = 1025 },
    .{ .name = "virtio-ssh", .port = 1026 },
    .{ .name = "virtio-ingress", .port = 1027 },
};

/// How long a vsock connect waits for the host to answer, in `ms`
pub const vsock_connect_timeout_ms: u32 = 100;

/// Host vsock port for channel `name`, or null for an unknown name.
pub fn vsockPort(name: []const u8) ?u32 {
    for (vsock_ports) |entry| {
        if (std.mem.eql(u8, entry.name, name)) return entry.port;
    }
    return null;
}

/// Transport selected by a kernel command line: vsock when it contains
/// `gondolin.vsock` or `gondolin.vsock=<value>` with a value other than `0`,
/// `off`, `false` or `no` (the last occurrence wins).
pub fn parseTransport(cmdline: []const u8) Transport {
    var selected: Transport = .virtio_serial;
    var it = std.mem.tokenizeAny(u8, cmdline, " \t\r\n");
    while (it.next()) |arg| {
        const key = "gondolin.vsock";
        if (!std.mem.startsWith(u8, arg, key)) continue;
        const rest = arg[key.len..];
        if (rest.len == 0) {
            selected = .vsock;
        } else if (rest[0] == '=') {
            const value = rest[1..];
            const off = for ([_][]const u8{ "0", "off", "false", "no" }) |word| {
                if (std.ascii.eqlIgnoreCase(value, word)) break true;
            } else false;
            selected = if (off) .virtio_serial else .vsock;
        }
    }
    return selected;
}

var cached_transport: ?Transport = null;

/// Transport selected by `/proc/cmdline` (read once; virtio-serial if the
/// file cannot be read).
pub fn transport() Transport {
    if (cached_transport) |t| return t;
    const t = readTransport();
    cached_transport = t;
    if (t == .vsock) log.info("using vsock transport", .{});
    return t;
}

fn readTransport() Transport {
    const fd = sys.openZ("/proc/cmdline", .{ .ACCMODE = .RDONLY }, 0) catch return .virtio_serial;
    defer sys.close(fd);
    var buf: [4096]u8 = undefined;
    var len: usize = 0;
    while (len < buf.len) {
        const n = sys.read(fd, buf[len..]) catch break;
        if (n == 0) break;
        len += n;
    }
    return parseTransport(buf[0..len]);
}

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
        if (!std.mem.startsWith(u8, entry.name, "vport")) continue;
        if (!portMatches(entry.name, name)) continue;
        const path = std.mem.print(&path_buf, "/dev/{s}", .{entry.name}) catch continue;
        if (try tryOpenPath(path, mode)) |fd| return fd;
    }
    return null;
}

/// Connect channel `name` over vsock; null if the host is not listening
/// (yet) or the vsock transport is not available (yet).
pub fn tryConnectVsock(name: []const u8, mode: Mode) OpenError!?sys.fd_t {
    const port = vsockPort(name) orelse {
        log.err("no vsock port for channel {s}", .{name});
        return null;
    };
    const fd = sys.vsockConnectHost(port, vsock_connect_timeout_ms) catch |err| switch (err) {
        error.ConnectionRefused, error.ConnectionTimedOut, error.NetworkUnreachable, error.WouldBlock => return null,
        else => return err,
    };
    if (mode == .nonblocking) sys.setNonblocking(fd, true) catch |err| {
        sys.close(fd);
        return err;
    };
    return fd;
}

/// Try to open the channel named `name` once with the selected transport.
pub fn tryOpen(name: []const u8, mode: Mode) OpenError!?sys.fd_t {
    if (transport() == .vsock) return tryConnectVsock(name, mode);
    var path_buf: [128]u8 = undefined;
    const direct = std.mem.print(&path_buf, "/dev/virtio-ports/{s}", .{name}) catch return error.NameTooLong;
    if (try tryOpenPath(direct, mode)) |fd| return fd;
    return scan(name, mode);
}

/// Open the channel named `name`, retrying every 100 ms until it shows up.
pub fn open(name: []const u8, mode: Mode) OpenError!sys.fd_t {
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

const testing = std.testing;

test "transport from the kernel command line" {
    try testing.expectEqual(Transport.virtio_serial, parseTransport(""));
    try testing.expectEqual(Transport.virtio_serial, parseTransport("console=ttyS0 initramfs_async=1\n"));
    try testing.expectEqual(Transport.vsock, parseTransport("console=ttyS0 gondolin.vsock\n"));
    try testing.expectEqual(Transport.vsock, parseTransport("gondolin.vsock=1"));
    try testing.expectEqual(Transport.vsock, parseTransport("gondolin.vsock=on root=/dev/vda"));
    try testing.expectEqual(Transport.virtio_serial, parseTransport("gondolin.vsock=0"));
    try testing.expectEqual(Transport.virtio_serial, parseTransport("gondolin.vsock=OFF"));
    // last occurrence wins
    try testing.expectEqual(Transport.virtio_serial, parseTransport("gondolin.vsock gondolin.vsock=no"));
    try testing.expectEqual(Transport.vsock, parseTransport("gondolin.vsock=0 gondolin.vsock"));
    // other parameters with the same prefix are not the flag
    try testing.expectEqual(Transport.virtio_serial, parseTransport("gondolin.vsockport=5"));
}

test "vsock ports" {
    try testing.expectEqual(@as(?u32, 1024), vsockPort("virtio-port"));
    try testing.expectEqual(@as(?u32, 1025), vsockPort("virtio-fs"));
    try testing.expectEqual(@as(?u32, 1026), vsockPort("virtio-ssh"));
    try testing.expectEqual(@as(?u32, 1027), vsockPort("virtio-ingress"));
    try testing.expectEqual(@as(?u32, null), vsockPort("virtio-other"));
}
