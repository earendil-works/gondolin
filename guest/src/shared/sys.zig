//! Minimal Linux system call layer for the guest helpers.
//!
//! The helpers are static, libc-free Linux binaries.  This module wraps the
//! raw `std.os.linux` system calls they need with small Zig error sets so the
//! callers can use `try`/`catch` instead of inspecting errno values.
//!
//! Conventions:
//! - `EINTR` is retried for every call that is restartable.
//! - `EAGAIN` maps to `error.WouldBlock`; callers using non-blocking fds treat
//!   it as "not ready".
//! - Error names follow the standard library (`FileNotFound`, `AccessDenied`,
//!   ...) because some of them are reported verbatim to the host.
//! - Every fd created here is `O_CLOEXEC` so that spawned children only
//!   inherit the descriptors that are explicitly `dup2`ed onto 0/1/2.

const std = @import("std");
const linux = std.os.linux;

pub const fd_t = linux.fd_t;
pub const pid_t = linux.pid_t;
pub const E = linux.E;
pub const O = linux.O;
pub const SIG = linux.SIG;
pub const W = linux.W;
pub const POLL = linux.POLL;
pub const pollfd = linux.pollfd;
pub const sigset_t = linux.sigset_t;
pub const iovec_const = std.posix.iovec_const;

pub const stdin_fd: fd_t = 0;
pub const stdout_fd: fd_t = 1;
pub const stderr_fd: fd_t = 2;

/// Maximum path length accepted by the kernel including the terminator in `bytes`
pub const path_max = linux.PATH_MAX;

pub const Unexpected = error{Unexpected};

fn unexpected(err: E) error{Unexpected} {
    std.log.scoped(.sys).debug("unexpected errno {t}", .{err});
    return error.Unexpected;
}

/// Copy `path` into `buf` and NUL-terminate it.
pub fn toPathZ(buf: *[path_max]u8, path: []const u8) error{ NameTooLong, BadPathName }![:0]const u8 {
    if (path.len >= buf.len) return error.NameTooLong;
    if (std.mem.findScalar(u8, path, 0) != null) return error.BadPathName;
    @memcpy(buf[0..path.len], path);
    buf[path.len] = 0;
    return buf[0..path.len :0];
}

// ---------------------------------------------------------------------------
// File descriptors

/// Close `fd`, ignoring errors.  `EINTR` is not retried: on Linux the fd is
/// released even when close reports it.
pub fn close(fd: fd_t) void {
    _ = linux.close(fd);
}

pub const ReadError = error{
    WouldBlock,
    InputOutput,
    IsDir,
    SystemResources,
    SocketUnconnected,
    ConnectionResetByPeer,
    ConnectionTimedOut,
    NotOpenForReading,
} || Unexpected;

/// errno → error for `read(2)` (`EINTR` is retried by the caller).
pub fn readErrno(err: E) ReadError {
    return switch (err) {
        .AGAIN => error.WouldBlock,
        .IO => error.InputOutput,
        .ISDIR => error.IsDir,
        .NOBUFS, .NOMEM => error.SystemResources,
        .NOTCONN => error.SocketUnconnected,
        .CONNRESET => error.ConnectionResetByPeer,
        .TIMEDOUT => error.ConnectionTimedOut,
        .BADF => error.NotOpenForReading,
        else => unexpected(err),
    };
}

/// Read up to `buf.len` bytes; returns 0 at end of stream.
pub fn read(fd: fd_t, buf: []u8) ReadError!usize {
    while (true) {
        const rc = linux.read(fd, buf.ptr, buf.len);
        switch (linux.errno(rc)) {
            .SUCCESS => return rc,
            .INTR => continue,
            else => |err| return readErrno(err),
        }
    }
}

pub const WriteError = error{
    WouldBlock,
    BrokenPipe,
    InputOutput,
    ConnectionResetByPeer,
    NoSpaceLeft,
    DiskQuota,
    FileTooBig,
    DeviceBusy,
    AccessDenied,
    PermissionDenied,
    NotOpenForWriting,
} || Unexpected;

/// errno → error for `write(2)`/`writev(2)`.
pub fn writeErrno(err: E) WriteError {
    return switch (err) {
        .AGAIN => error.WouldBlock,
        .PIPE => error.BrokenPipe,
        .IO => error.InputOutput,
        .CONNRESET => error.ConnectionResetByPeer,
        .NOSPC => error.NoSpaceLeft,
        .DQUOT => error.DiskQuota,
        .FBIG => error.FileTooBig,
        .BUSY => error.DeviceBusy,
        .ACCES => error.AccessDenied,
        .PERM => error.PermissionDenied,
        .BADF => error.NotOpenForWriting,
        else => unexpected(err),
    };
}

/// Write up to `bytes.len` bytes; returns the number of bytes written.
pub fn write(fd: fd_t, bytes: []const u8) WriteError!usize {
    while (true) {
        const rc = linux.write(fd, bytes.ptr, bytes.len);
        switch (linux.errno(rc)) {
            .SUCCESS => return rc,
            .INTR => continue,
            else => |err| return writeErrno(err),
        }
    }
}

/// Write all of `bytes` to a blocking fd.
pub fn writeAll(fd: fd_t, bytes: []const u8) WriteError!void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const n = try write(fd, bytes[offset..]);
        if (n == 0) return error.BrokenPipe;
        offset += n;
    }
}

/// Write all `iov` buffers to a blocking fd, handling partial writes.
pub fn writevAll(fd: fd_t, iov_in: []const iovec_const) WriteError!void {
    var storage: [4]iovec_const = undefined;
    std.debug.assert(iov_in.len <= storage.len);
    @memcpy(storage[0..iov_in.len], iov_in);
    var iov: []iovec_const = storage[0..iov_in.len];

    while (iov.len > 0) {
        const rc = linux.writev(fd, iov.ptr, iov.len);
        var n: usize = switch (linux.errno(rc)) {
            .SUCCESS => rc,
            .INTR => continue,
            else => |err| return writeErrno(err),
        };
        if (n == 0) return error.BrokenPipe;
        while (iov.len > 0 and n >= iov[0].len) {
            n -= iov[0].len;
            iov = iov[1..];
        }
        if (n > 0) {
            iov[0].base += n;
            iov[0].len -= n;
        }
    }
}

pub const OpenError = error{
    FileNotFound,
    AccessDenied,
    PermissionDenied,
    IsDir,
    NotDir,
    NameTooLong,
    BadPathName,
    SymLinkLoop,
    NoDevice,
    DeviceBusy,
    FileBusy,
    FileTooBig,
    NoSpaceLeft,
    PathAlreadyExists,
    ReadOnlyFileSystem,
    FileLocksUnsupported,
    WouldBlock,
    ProcessFdQuotaExceeded,
    SystemFdQuotaExceeded,
    SystemResources,
} || Unexpected;

/// errno → error for `open(2)`/`openat(2)` (also with `O_CREAT`).
pub fn openErrno(err: E) OpenError {
    return switch (err) {
        .NOENT, .SRCH => error.FileNotFound,
        .ACCES => error.AccessDenied,
        .PERM => error.PermissionDenied,
        .ISDIR => error.IsDir,
        .NOTDIR => error.NotDir,
        .NAMETOOLONG => error.NameTooLong,
        .INVAL, .ILSEQ => error.BadPathName,
        .LOOP => error.SymLinkLoop,
        .NODEV, .NXIO => error.NoDevice,
        .BUSY => error.DeviceBusy,
        .TXTBSY => error.FileBusy,
        .FBIG, .OVERFLOW => error.FileTooBig,
        .NOSPC => error.NoSpaceLeft,
        .EXIST => error.PathAlreadyExists,
        .ROFS => error.ReadOnlyFileSystem,
        .OPNOTSUPP => error.FileLocksUnsupported,
        .AGAIN => error.WouldBlock,
        .MFILE => error.ProcessFdQuotaExceeded,
        .NFILE => error.SystemFdQuotaExceeded,
        .NOMEM => error.SystemResources,
        else => unexpected(err),
    };
}

/// `openat(2)` relative to `dir` (`linux.AT.FDCWD` for the cwd); always CLOEXEC.
pub fn openatZ(dir: fd_t, path: [*:0]const u8, flags: O, mode: linux.mode_t) OpenError!fd_t {
    var f = flags;
    f.CLOEXEC = true;
    while (true) {
        const rc = linux.openat(dir, path, f, mode);
        switch (linux.errno(rc)) {
            .SUCCESS => return @intCast(rc),
            .INTR => continue,
            else => |err| return openErrno(err),
        }
    }
}

pub const OpenDirError = error{
    FileNotFound,
    AccessDenied,
    PermissionDenied,
    NotDir,
    NameTooLong,
    BadPathName,
    SymLinkLoop,
    NoDevice,
    ProcessFdQuotaExceeded,
    SystemFdQuotaExceeded,
    SystemResources,
} || Unexpected;

/// errno → error for opening a directory for iteration.
pub fn openDirErrno(err: E) OpenDirError {
    return switch (err) {
        .NOENT => error.FileNotFound,
        .ACCES => error.AccessDenied,
        .PERM => error.PermissionDenied,
        .NOTDIR => error.NotDir,
        .NAMETOOLONG => error.NameTooLong,
        .INVAL, .ILSEQ => error.BadPathName,
        .LOOP => error.SymLinkLoop,
        .NODEV, .NXIO => error.NoDevice,
        .MFILE => error.ProcessFdQuotaExceeded,
        .NFILE => error.SystemFdQuotaExceeded,
        .NOMEM => error.SystemResources,
        else => unexpected(err),
    };
}

/// Open directory `path` (relative to `dir`) for iteration without following
/// a final symlink: a symlink fails with `SymLinkLoop`, a non-directory with
/// `NotDir`.
pub fn openDirNoFollowZ(dir: fd_t, path: [*:0]const u8) OpenDirError!fd_t {
    while (true) {
        const rc = linux.openat(dir, path, .{ .ACCMODE = .RDONLY, .DIRECTORY = true, .NOFOLLOW = true, .CLOEXEC = true }, 0);
        switch (linux.errno(rc)) {
            .SUCCESS => return @intCast(rc),
            .INTR => continue,
            else => |err| return openDirErrno(err),
        }
    }
}

pub fn openZ(path: [*:0]const u8, flags: O, mode: linux.mode_t) OpenError!fd_t {
    return openatZ(linux.AT.FDCWD, path, flags, mode);
}

pub fn open(path: []const u8, flags: O, mode: linux.mode_t) OpenError!fd_t {
    var buf: [path_max]u8 = undefined;
    return openZ(try toPathZ(&buf, path), flags, mode);
}

/// Switch `fd` between blocking and non-blocking mode.
pub fn setNonblocking(fd: fd_t, nonblocking: bool) Unexpected!void {
    const flags = linux.fcntl(fd, linux.F.GETFL, 0);
    if (linux.errno(flags) != .SUCCESS) return unexpected(linux.errno(flags));
    const bit: usize = @as(u32, @bitCast(O{ .NONBLOCK = true }));
    const new_flags = if (nonblocking) flags | bit else flags & ~bit;
    const rc = linux.fcntl(fd, linux.F.SETFL, new_flags);
    if (linux.errno(rc) != .SUCCESS) return unexpected(linux.errno(rc));
}

/// Set or clear `FD_CLOEXEC` on `fd`.
pub fn setCloexec(fd: fd_t, cloexec: bool) void {
    _ = linux.fcntl(fd, linux.F.SETFD, if (cloexec) linux.FD_CLOEXEC else 0);
}

pub const PipeError = error{ ProcessFdQuotaExceeded, SystemFdQuotaExceeded, SystemResources } || Unexpected;

/// Create a pipe; returns `{ read_end, write_end }`.  Both ends are CLOEXEC.
pub fn pipe(nonblocking: bool) PipeError![2]fd_t {
    var fds: [2]fd_t = undefined;
    const rc = linux.pipe2(&fds, .{ .CLOEXEC = true, .NONBLOCK = nonblocking });
    return switch (linux.errno(rc)) {
        .SUCCESS => fds,
        .MFILE => error.ProcessFdQuotaExceeded,
        .NFILE => error.SystemFdQuotaExceeded,
        .NOMEM => error.SystemResources,
        else => |err| unexpected(err),
    };
}

/// Return the number of bytes readable without blocking, or null if unknown.
pub fn bytesAvailable(fd: fd_t) ?usize {
    var n: c_int = 0;
    while (true) {
        const rc = linux.ioctl(fd, linux.T.FIONREAD, @intFromPtr(&n));
        switch (linux.errno(rc)) {
            .SUCCESS => return if (n <= 0) 0 else @intCast(n),
            .INTR => continue,
            else => return null,
        }
    }
}

// ---------------------------------------------------------------------------
// Polling

/// `poll(2)` with `timeout_ms` (-1 = infinite).  `EINTR` is reported as zero
/// ready descriptors so callers simply run another loop iteration.
pub fn poll(fds: []pollfd, timeout_ms: i32) Unexpected!usize {
    const rc = linux.poll(fds.ptr, fds.len, timeout_ms);
    return switch (linux.errno(rc)) {
        .SUCCESS => rc,
        .INTR => 0,
        else => |err| unexpected(err),
    };
}

/// Poll a single fd; returns its `revents` (0 on timeout).
pub fn pollOne(fd: fd_t, events: i16, timeout_ms: i32) Unexpected!i16 {
    var fds = [1]pollfd{.{ .fd = fd, .events = events, .revents = 0 }};
    if (try poll(&fds, timeout_ms) == 0) return 0;
    return fds[0].revents;
}

// ---------------------------------------------------------------------------
// Time

/// Monotonic clock in `ms`; immune to wall clock changes such as time_sync.
pub fn monotonicMs() u64 {
    var ts: linux.timespec = undefined;
    _ = linux.clock_gettime(.MONOTONIC, &ts);
    return @as(u64, @intCast(ts.sec)) * std.time.ms_per_s + @as(u64, @intCast(ts.nsec)) / std.time.ns_per_ms;
}

/// Set the wall clock to `unix_ms` milliseconds since the Unix epoch.
pub fn setRealtimeMs(unix_ms: u64) (error{PermissionDenied} || Unexpected)!void {
    const ts: linux.timespec = .{
        .sec = @intCast(unix_ms / std.time.ms_per_s),
        .nsec = @intCast((unix_ms % std.time.ms_per_s) * std.time.ns_per_ms),
    };
    const rc = linux.clock_settime(.REALTIME, &ts);
    return switch (linux.errno(rc)) {
        .SUCCESS => {},
        .PERM => error.PermissionDenied,
        else => |err| unexpected(err),
    };
}

pub fn sleepMs(ms: u64) void {
    var req: linux.timespec = .{
        .sec = @intCast(ms / std.time.ms_per_s),
        .nsec = @intCast((ms % std.time.ms_per_s) * std.time.ns_per_ms),
    };
    while (linux.errno(linux.nanosleep(&req, &req)) == .INTR) {}
}

// ---------------------------------------------------------------------------
// Signals

fn sigactionHandler(sig: SIG, handler: ?linux.Sigaction.handler_fn) void {
    const act: linux.Sigaction = .{
        .handler = .{ .handler = handler },
        .mask = linux.sigemptyset(),
        .flags = 0,
    };
    _ = linux.sigaction(sig, &act, null);
}

/// Ignore `sig` (used for SIGPIPE so broken pipes surface as `EPIPE`).
pub fn ignoreSignal(sig: SIG) void {
    sigactionHandler(sig, SIG.IGN);
}

/// Restore the default disposition of `sig`.
pub fn defaultSignal(sig: SIG) void {
    sigactionHandler(sig, SIG.DFL);
}

/// Block `sig` for the calling thread and return the previous mask.
pub fn blockSignal(sig: SIG) sigset_t {
    var set = linux.sigemptyset();
    linux.sigaddset(&set, sig);
    var old: sigset_t = undefined;
    _ = linux.sigprocmask(SIG.BLOCK, &set, &old);
    return old;
}

pub fn setSignalMask(set: *const sigset_t) void {
    _ = linux.sigprocmask(SIG.SETMASK, set, null);
}

/// Create a non-blocking signalfd for `sig`.  The signal must be blocked.
pub fn signalfd(sig: SIG) (error{SystemResources} || Unexpected)!fd_t {
    var set = linux.sigemptyset();
    linux.sigaddset(&set, sig);
    const rc = linux.signalfd(-1, &set, linux.SFD.CLOEXEC | linux.SFD.NONBLOCK);
    return switch (linux.errno(rc)) {
        .SUCCESS => @intCast(rc),
        .MFILE, .NFILE, .NOMEM, .NODEV => error.SystemResources,
        else => |err| unexpected(err),
    };
}

/// Read and discard all pending signalfd records.
pub fn drainSignalfd(fd: fd_t) void {
    var buf: [8]linux.signalfd_siginfo = undefined;
    while (true) {
        const n = read(fd, std.mem.sliceAsBytes(&buf)) catch return;
        if (n < @sizeOf(@TypeOf(buf))) return;
    }
}

// ---------------------------------------------------------------------------
// Processes

pub fn fork() (error{SystemResources} || Unexpected)!pid_t {
    const rc = linux.fork();
    return switch (linux.errno(rc)) {
        .SUCCESS => @intCast(rc),
        .AGAIN, .NOMEM => error.SystemResources,
        else => |err| unexpected(err),
    };
}

pub fn exit(status: u8) noreturn {
    linux.exit_group(status);
}

pub fn kill(pid: pid_t, sig: SIG) void {
    _ = linux.kill(pid, sig);
}

/// Signal every process in process group `pgid`.
pub fn killGroup(pgid: pid_t, sig: SIG) void {
    _ = linux.kill(-pgid, sig);
}

pub fn dup2(old: fd_t, new: fd_t) Unexpected!void {
    while (true) {
        const rc = linux.dup2(old, new);
        switch (linux.errno(rc)) {
            .SUCCESS => return,
            .INTR, .BUSY => continue,
            else => |err| return unexpected(err),
        }
    }
}

pub fn chdir(path: [*:0]const u8) Unexpected!void {
    const rc = linux.chdir(path);
    if (linux.errno(rc) != .SUCCESS) return unexpected(linux.errno(rc));
}

pub fn setsid() void {
    _ = linux.setsid();
}

pub const ExecError = error{ FileNotFound, NotDir, AccessDenied } || Unexpected;

/// `execve(2)`; only returns on failure.
pub fn execve(path: [*:0]const u8, argv: [*:null]const ?[*:0]const u8, envp: [*:null]const ?[*:0]const u8) ExecError!noreturn {
    const rc = linux.execve(path, argv, envp);
    return switch (linux.errno(rc)) {
        .NOENT => error.FileNotFound,
        .NOTDIR => error.NotDir,
        .ACCES, .PERM => error.AccessDenied,
        else => |err| unexpected(err),
    };
}

/// `execvpe` semantics: search `PATH` from `envp` (default `/bin:/usr/bin`)
/// when `file` has no slash.  Only returns on failure.
pub fn execvpe(file: [*:0]const u8, argv: [*:null]const ?[*:0]const u8, envp: [*:null]const ?[*:0]const u8) ExecError!noreturn {
    const name = std.mem.span(file);
    if (std.mem.findScalar(u8, name, '/') != null) return execve(file, argv, envp);

    const search_path = getenv(envp, "PATH") orelse "/bin:/usr/bin";
    var saw_access_denied = false;
    var buf: [path_max]u8 = undefined;
    var it = std.mem.splitScalar(u8, search_path, ':');
    while (it.next()) |dir| {
        const candidate = if (dir.len == 0)
            std.mem.printSentinel(&buf, "{s}", .{name}, 0) catch continue
        else
            std.mem.printSentinel(&buf, "{s}/{s}", .{ dir, name }, 0) catch continue;
        execve(candidate.ptr, argv, envp) catch |err| switch (err) {
            error.FileNotFound, error.NotDir => {},
            error.AccessDenied => saw_access_denied = true,
            else => return err,
        };
    }
    return if (saw_access_denied) error.AccessDenied else error.FileNotFound;
}

/// Look up `key` in a NULL-terminated `KEY=VALUE` array.
pub fn getenv(envp: [*:null]const ?[*:0]const u8, key: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (envp[i]) |entry_z| : (i += 1) {
        const entry = std.mem.span(entry_z);
        if (entry.len > key.len and entry[key.len] == '=' and std.mem.eql(u8, entry[0..key.len], key)) {
            return entry[key.len + 1 ..];
        }
    }
    return null;
}

pub const WaitResult = struct {
    pid: pid_t,
    /// raw wait status as returned by `wait4(2)`
    status: u32,
};

/// Reap one exited child without blocking; null when none is ready.
pub fn reapAny() ?WaitResult {
    var status: i32 = 0;
    while (true) {
        const rc = linux.wait4(-1, &status, W.NOHANG, null);
        switch (linux.errno(rc)) {
            .SUCCESS => {
                if (rc == 0) return null;
                return .{ .pid = @intCast(rc), .status = @bitCast(status) };
            },
            .INTR => continue,
            else => return null, // ECHILD: no children at all
        }
    }
}

/// Block until `pid` exits and reap it.
pub fn waitPid(pid: pid_t) u32 {
    var status: i32 = 0;
    while (linux.errno(linux.wait4(pid, &status, 0, null)) == .INTR) {}
    return @bitCast(status);
}

// ---------------------------------------------------------------------------
// Terminals

pub const Pty = struct { master: fd_t, slave: fd_t };

/// Allocate a pseudo terminal pair (`openpty(3)` without termios/winsize).
pub fn openPty() (OpenError || error{PtyFailed})!Pty {
    const master = try openZ("/dev/ptmx", .{ .ACCMODE = .RDWR, .NOCTTY = true }, 0);
    errdefer close(master);

    var unlock: c_int = 0;
    if (linux.errno(linux.ioctl(master, linux.T.IOCSPTLCK, @intFromPtr(&unlock))) != .SUCCESS) return error.PtyFailed;
    var index: c_uint = 0;
    if (linux.errno(linux.ioctl(master, linux.T.IOCGPTN, @intFromPtr(&index))) != .SUCCESS) return error.PtyFailed;

    var path_buf: [32]u8 = undefined;
    const slave_path = std.mem.printSentinel(&path_buf, "/dev/pts/{d}", .{index}, 0) catch unreachable;
    const slave = try openZ(slave_path.ptr, .{ .ACCMODE = .RDWR, .NOCTTY = true }, 0);
    return .{ .master = master, .slave = slave };
}

/// Make `fd` the controlling terminal of the calling session leader.
pub fn setControllingTty(fd: fd_t) void {
    _ = linux.ioctl(fd, linux.T.IOCSCTTY, 0);
}

/// Set the terminal size of `fd`, clamping to the kernel's `u16` fields.
pub fn setWinsize(fd: fd_t, rows: u32, cols: u32) void {
    const ws: std.posix.winsize = .{
        .row = @intCast(@min(rows, std.math.maxInt(u16))),
        .col = @intCast(@min(cols, std.math.maxInt(u16))),
        .xpixel = 0,
        .ypixel = 0,
    };
    _ = linux.ioctl(fd, linux.T.IOCSWINSZ, @intFromPtr(&ws));
}

// ---------------------------------------------------------------------------
// Sockets

pub const ConnectError = error{
    AccessDenied,
    ConnectionRefused,
    NetworkUnreachable,
    ConnectionTimedOut,
    AddressInUse,
    WouldBlock,
    ProcessFdQuotaExceeded,
    SystemFdQuotaExceeded,
    SystemResources,
} || Unexpected;

/// Connect a blocking TCP socket to `127.0.0.1:port`.
pub fn tcpConnectLoopback(port: u16) ConnectError!fd_t {
    const sock_rc = linux.socket(linux.AF.INET, linux.SOCK.STREAM | linux.SOCK.CLOEXEC, 0);
    const fd: fd_t = switch (linux.errno(sock_rc)) {
        .SUCCESS => @intCast(sock_rc),
        .ACCES, .PERM => return error.AccessDenied,
        .MFILE => return error.ProcessFdQuotaExceeded,
        .NFILE => return error.SystemFdQuotaExceeded,
        .NOMEM, .NOBUFS => return error.SystemResources,
        else => |err| return unexpected(err),
    };
    errdefer close(fd);

    const addr: linux.sockaddr.in = .{
        .port = std.mem.nativeToBig(u16, port),
        .addr = std.mem.nativeToBig(u32, 0x7f000001),
    };
    while (true) {
        const rc = linux.connect(fd, &addr, @sizeOf(@TypeOf(addr)));
        switch (linux.errno(rc)) {
            .SUCCESS => return fd,
            .INTR => continue,
            .ACCES, .PERM => return error.AccessDenied,
            .CONNREFUSED => return error.ConnectionRefused,
            .HOSTUNREACH, .NETUNREACH => return error.NetworkUnreachable,
            .TIMEDOUT => return error.ConnectionTimedOut,
            .ADDRINUSE, .ADDRNOTAVAIL => return error.AddressInUse,
            .AGAIN, .INPROGRESS => return error.WouldBlock,
            else => |err| return unexpected(err),
        }
    }
}

/// vsock CID of the host.
pub const vsock_host_cid: u32 = 2;

/// `SO_VM_SOCKETS_CONNECT_TIMEOUT` (the `struct timeval` variant, level
/// `AF_VSOCK`).
const so_vm_sockets_connect_timeout: u32 = 6;
/// `SO_VM_SOCKETS_BUFFER_SIZE` / `_MAX_SIZE` (`u64`, level `AF_VSOCK`)
const so_vm_sockets_buffer_size: u32 = 0;
const so_vm_sockets_buffer_max_size: u32 = 2;
/// Receive window of the host channels' vsock sockets, in `bytes`: more than
/// one sandboxfs response (1 MiB of data plus framing)
const vsock_buffer_size: u64 = 2 * 1024 * 1024;

/// Connect a blocking `AF_VSOCK` stream socket to `port` on the host (CID 2).
/// `timeout_ms` bounds how long `connect` waits for the host to answer (the
/// kernel default is 2 s); a host with no listener on `port` usually answers
/// at once with a reset, reported as `ConnectionRefused`.
pub fn vsockConnectHost(port: u32, timeout_ms: u32) ConnectError!fd_t {
    const sock_rc = linux.socket(linux.AF.VSOCK, linux.SOCK.STREAM | linux.SOCK.CLOEXEC, 0);
    const fd: fd_t = switch (linux.errno(sock_rc)) {
        .SUCCESS => @intCast(sock_rc),
        .ACCES, .PERM => return error.AccessDenied,
        // no vsock transport loaded / no device
        .AFNOSUPPORT, .INVAL, .NODEV => return error.NetworkUnreachable,
        .MFILE => return error.ProcessFdQuotaExceeded,
        .NFILE => return error.SystemFdQuotaExceeded,
        .NOMEM, .NOBUFS => return error.SystemResources,
        else => |err| return unexpected(err),
    };
    errdefer close(fd);

    const timeout: linux.timeval = .{
        .sec = @intCast(timeout_ms / 1000),
        .usec = @intCast((timeout_ms % 1000) * 1000),
    };
    // Best effort: an older kernel keeps the default timeout.
    _ = linux.setsockopt(fd, linux.AF.VSOCK, so_vm_sockets_connect_timeout, std.mem.asBytes(&timeout), @sizeOf(linux.timeval));
    // A receive window that fits a whole large message: the host may only
    // send as much as the window before the guest returns credit, and every
    // credit update is a round trip to the VMM (the default 256 KiB cut
    // 1 MiB sandboxfs responses into four). Best effort; the maximum first.
    const buffer_size: u64 = vsock_buffer_size;
    _ = linux.setsockopt(fd, linux.AF.VSOCK, so_vm_sockets_buffer_max_size, std.mem.asBytes(&buffer_size), @sizeOf(u64));
    _ = linux.setsockopt(fd, linux.AF.VSOCK, so_vm_sockets_buffer_size, std.mem.asBytes(&buffer_size), @sizeOf(u64));

    const addr: linux.sockaddr.vm = .{ .port = port, .cid = vsock_host_cid, .flags = 0 };
    while (true) {
        const rc = linux.connect(fd, &addr, @sizeOf(@TypeOf(addr)));
        switch (linux.errno(rc)) {
            .SUCCESS => return fd,
            .INTR => continue,
            .ACCES, .PERM => return error.AccessDenied,
            .CONNREFUSED, .CONNRESET => return error.ConnectionRefused,
            .HOSTUNREACH, .NETUNREACH, .NODEV => return error.NetworkUnreachable,
            .TIMEDOUT => return error.ConnectionTimedOut,
            .ADDRINUSE, .ADDRNOTAVAIL => return error.AddressInUse,
            .AGAIN, .INPROGRESS => return error.WouldBlock,
            else => |err| return unexpected(err),
        }
    }
}

/// Half-close the write side of a socket, ignoring errors.
pub fn shutdownWrite(fd: fd_t) void {
    _ = linux.shutdown(fd, linux.SHUT.WR);
}

// ---------------------------------------------------------------------------
// Filesystem

/// `mount(2)`; returns the errno (`.SUCCESS` on success).
pub fn mount(source: [*:0]const u8, target: [*:0]const u8, fstype: [*:0]const u8, flags: u32, data: ?[*:0]const u8) E {
    return linux.errno(linux.mount(source, target, fstype, flags, @intFromPtr(data)));
}

pub const UnlinkError = error{
    FileNotFound,
    AccessDenied,
    PermissionDenied,
    FileBusy,
    FileSystem,
    IsDir,
    NotDir,
    DirNotEmpty,
    SymLinkLoop,
    NameTooLong,
    BadPathName,
    ReadOnlyFileSystem,
    SystemResources,
} || Unexpected;

/// errno → error for `unlinkat(2)`; `remove_dir` selects `AT_REMOVEDIR`
/// semantics (`rmdir`).
pub fn unlinkErrno(err: E, remove_dir: bool) UnlinkError {
    return switch (err) {
        .NOENT => error.FileNotFound,
        .ACCES => error.AccessDenied,
        .PERM => error.PermissionDenied,
        .BUSY => error.FileBusy,
        .IO => error.FileSystem,
        .ISDIR => if (remove_dir) unexpected(err) else error.IsDir,
        .NOTDIR => error.NotDir,
        .NOTEMPTY => if (remove_dir) error.DirNotEmpty else unexpected(err),
        .LOOP => error.SymLinkLoop,
        .NAMETOOLONG => error.NameTooLong,
        .ILSEQ => error.BadPathName,
        .ROFS => error.ReadOnlyFileSystem,
        .NOMEM => error.SystemResources,
        else => unexpected(err),
    };
}

/// `unlinkat(2)`: remove a non-directory, or an empty directory when
/// `remove_dir` is set.  Never follows a final symlink.
pub fn unlinkatZ(dir: fd_t, path: [*:0]const u8, remove_dir: bool) UnlinkError!void {
    while (true) {
        const rc = linux.unlinkat(dir, path, if (remove_dir) linux.AT.REMOVEDIR else 0);
        switch (linux.errno(rc)) {
            .SUCCESS => return,
            .INTR => continue,
            else => |err| return unlinkErrno(err, remove_dir),
        }
    }
}

pub const StatError = error{
    FileNotFound,
    AccessDenied,
    NotDir,
    SymLinkLoop,
    SystemResources,
} || Unexpected;

pub fn statErrno(err: E) StatError {
    return switch (err) {
        .NOENT => error.FileNotFound,
        .ACCES => error.AccessDenied,
        .NOTDIR => error.NotDir,
        .LOOP => error.SymLinkLoop,
        .NOMEM => error.SystemResources,
        else => unexpected(err),
    };
}

/// Check that `path` exists without following a final symlink (`lstat`).
pub fn lexists(path: [*:0]const u8) StatError!void {
    var stx: linux.Statx = undefined;
    while (true) {
        const rc = linux.statx(linux.AT.FDCWD, path, linux.AT.SYMLINK_NOFOLLOW | linux.AT.NO_AUTOMOUNT, .{}, &stx);
        switch (linux.errno(rc)) {
            .SUCCESS => return,
            .INTR => continue,
            else => |err| return statErrno(err),
        }
    }
}

pub const DirEntry = struct {
    name: [:0]const u8,
    /// `DT_*` file type (`linux.DT.UNKNOWN` if the filesystem does not say)
    type: u8,
};

/// Iterates the entries of a directory using `getdents64(2)`, skipping `.`
/// and `..`.
pub const DirIterator = struct {
    fd: fd_t,
    buf: [4096]u8 align(@alignOf(linux.dirent64)) = undefined,
    index: usize = 0,
    end: usize = 0,

    pub const Error = error{AccessDenied} || Unexpected;

    pub fn open(path: [*:0]const u8) OpenError!DirIterator {
        return .{ .fd = try openZ(path, .{ .ACCMODE = .RDONLY, .DIRECTORY = true }, 0) };
    }

    pub fn deinit(self: *DirIterator) void {
        close(self.fd);
    }

    /// Next entry, or null at the end (or on error, see `nextChecked`).
    pub fn next(self: *DirIterator) ?DirEntry {
        return self.nextChecked() catch null;
    }

    pub fn nextChecked(self: *DirIterator) Error!?DirEntry {
        while (true) {
            if (self.index >= self.end) {
                const rc = linux.getdents64(self.fd, &self.buf, self.buf.len);
                switch (linux.errno(rc)) {
                    .SUCCESS => {},
                    .INTR => continue,
                    .NOENT => return null, // directory was removed
                    .ACCES => return error.AccessDenied,
                    else => |err| return unexpected(err),
                }
                if (rc == 0) return null;
                self.index = 0;
                self.end = rc;
            }
            const entry: *align(1) const linux.dirent64 = @ptrCast(&self.buf[self.index]);
            const name_ptr: [*:0]const u8 = @ptrCast(&self.buf[self.index + @offsetOf(linux.dirent64, "name")]);
            self.index += entry.reclen;
            const name = std.mem.span(name_ptr);
            if (std.mem.eql(u8, name, ".") or std.mem.eql(u8, name, "..")) continue;
            return .{ .name = name, .type = entry.type };
        }
    }
};

// ---------------------------------------------------------------------------
// Tests

// The error names of these mappings are reported verbatim to the host
// (`file_*_failed` messages, `tcp_opened.message`); this table pins them and
// must stay in sync with ARCHITECTURE.md §4.5.
test "host-visible errno to error name mapping" {
    const Case = struct { E, []const u8 };
    const expectMapping = struct {
        fn run(comptime f: anytype, cases: []const Case) !void {
            for (cases) |case| {
                try std.testing.expectEqualStrings(case[1], @errorName(f(case[0])));
            }
            // anything not listed is `Unexpected`
            for ([_]E{ .CHILD, .SPIPE, .XDEV, .MLINK }) |err| {
                try std.testing.expectEqualStrings("Unexpected", @errorName(f(err)));
            }
        }
    }.run;

    try expectMapping(openErrno, &.{
        .{ .NOENT, "FileNotFound" },          .{ .SRCH, "FileNotFound" },
        .{ .ACCES, "AccessDenied" },          .{ .PERM, "PermissionDenied" },
        .{ .ISDIR, "IsDir" },                 .{ .NOTDIR, "NotDir" },
        .{ .NAMETOOLONG, "NameTooLong" },     .{ .INVAL, "BadPathName" },
        .{ .ILSEQ, "BadPathName" },           .{ .LOOP, "SymLinkLoop" },
        .{ .NODEV, "NoDevice" },              .{ .NXIO, "NoDevice" },
        .{ .BUSY, "DeviceBusy" },             .{ .TXTBSY, "FileBusy" },
        .{ .FBIG, "FileTooBig" },             .{ .OVERFLOW, "FileTooBig" },
        .{ .NOSPC, "NoSpaceLeft" },           .{ .EXIST, "PathAlreadyExists" },
        .{ .ROFS, "ReadOnlyFileSystem" },     .{ .OPNOTSUPP, "FileLocksUnsupported" },
        .{ .AGAIN, "WouldBlock" },            .{ .MFILE, "ProcessFdQuotaExceeded" },
        .{ .NFILE, "SystemFdQuotaExceeded" }, .{ .NOMEM, "SystemResources" },
    });
    try expectMapping(readErrno, &.{
        .{ .AGAIN, "WouldBlock" },                .{ .IO, "InputOutput" },
        .{ .ISDIR, "IsDir" },                     .{ .NOBUFS, "SystemResources" },
        .{ .NOMEM, "SystemResources" },           .{ .NOTCONN, "SocketUnconnected" },
        .{ .CONNRESET, "ConnectionResetByPeer" }, .{ .TIMEDOUT, "ConnectionTimedOut" },
        .{ .BADF, "NotOpenForReading" },
    });
    try expectMapping(writeErrno, &.{
        .{ .AGAIN, "WouldBlock" },       .{ .PIPE, "BrokenPipe" },
        .{ .IO, "InputOutput" },         .{ .CONNRESET, "ConnectionResetByPeer" },
        .{ .NOSPC, "NoSpaceLeft" },      .{ .DQUOT, "DiskQuota" },
        .{ .FBIG, "FileTooBig" },        .{ .BUSY, "DeviceBusy" },
        .{ .ACCES, "AccessDenied" },     .{ .PERM, "PermissionDenied" },
        .{ .BADF, "NotOpenForWriting" },
    });
    const unlink_common = [_]Case{
        .{ .NOENT, "FileNotFound" },    .{ .ACCES, "AccessDenied" },
        .{ .PERM, "PermissionDenied" }, .{ .BUSY, "FileBusy" },
        .{ .IO, "FileSystem" },         .{ .NOTDIR, "NotDir" },
        .{ .LOOP, "SymLinkLoop" },      .{ .NAMETOOLONG, "NameTooLong" },
        .{ .ILSEQ, "BadPathName" },     .{ .ROFS, "ReadOnlyFileSystem" },
        .{ .NOMEM, "SystemResources" },
    };
    try expectMapping(struct {
        fn f(err: E) UnlinkError {
            return unlinkErrno(err, false);
        }
    }.f, &(unlink_common ++ [_]Case{ .{ .ISDIR, "IsDir" }, .{ .NOTEMPTY, "Unexpected" } }));
    try expectMapping(struct {
        fn f(err: E) UnlinkError {
            return unlinkErrno(err, true);
        }
    }.f, &(unlink_common ++ [_]Case{ .{ .NOTEMPTY, "DirNotEmpty" }, .{ .ISDIR, "Unexpected" } }));
    try expectMapping(openDirErrno, &.{
        .{ .NOENT, "FileNotFound" },           .{ .ACCES, "AccessDenied" },
        .{ .PERM, "PermissionDenied" },        .{ .NOTDIR, "NotDir" },
        .{ .NAMETOOLONG, "NameTooLong" },      .{ .INVAL, "BadPathName" },
        .{ .ILSEQ, "BadPathName" },            .{ .LOOP, "SymLinkLoop" },
        .{ .NODEV, "NoDevice" },               .{ .NXIO, "NoDevice" },
        .{ .MFILE, "ProcessFdQuotaExceeded" }, .{ .NFILE, "SystemFdQuotaExceeded" },
        .{ .NOMEM, "SystemResources" },
    });
    try expectMapping(statErrno, &.{
        .{ .NOENT, "FileNotFound" },    .{ .ACCES, "AccessDenied" },
        .{ .NOTDIR, "NotDir" },         .{ .LOOP, "SymLinkLoop" },
        .{ .NOMEM, "SystemResources" }, .{ .NAMETOOLONG, "Unexpected" },
    });

    var buf: [path_max]u8 = undefined;
    try std.testing.expectError(error.BadPathName, toPathZ(&buf, "/a\x00b"));
    try std.testing.expectError(error.NameTooLong, toPathZ(&buf, &(@as([path_max]u8, @splat('a')))));
}

test "tcp connect errors are reported by name" {
    // nothing listens on port 1 in the test environment
    try std.testing.expectError(error.ConnectionRefused, tcpConnectLoopback(1));
}
