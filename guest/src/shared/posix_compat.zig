const std = @import("std");

pub const fd_t = std.posix.fd_t;
pub const pid_t = std.posix.pid_t;
pub const mode_t = std.posix.mode_t;
pub const pollfd = std.posix.pollfd;
pub const iovec_const = std.posix.iovec_const;

pub const O = std.posix.O;
pub const F = std.posix.F;
pub const W = std.posix.W;
pub const POLL = std.posix.POLL;
pub const SIG = std.posix.SIG;
pub const SHUT = std.posix.SHUT;
pub const AT = std.posix.AT;

pub const STDIN_FILENO = std.posix.STDIN_FILENO;
pub const STDOUT_FILENO = std.posix.STDOUT_FILENO;
pub const STDERR_FILENO = std.posix.STDERR_FILENO;

pub const errno = std.posix.errno;
pub const unexpectedErrno = std.posix.unexpectedErrno;

pub const read = std.posix.read;
pub const poll = std.posix.poll;
pub const kill = std.posix.kill;

pub fn open(path: []const u8, flags: O, mode: mode_t) !fd_t {
    return std.posix.openat(AT.FDCWD, path, flags, mode);
}

pub fn openZ(path: [*:0]const u8, flags: O, mode: mode_t) !fd_t {
    return std.posix.openatZ(AT.FDCWD, path, flags, mode);
}

pub fn close(fd: fd_t) void {
    _ = std.c.close(fd);
}

pub fn write(fd: fd_t, data: []const u8) !usize {
    if (data.len == 0) return 0;
    while (true) {
        const rc = std.c.write(fd, data.ptr, data.len);
        switch (errno(rc)) {
            .SUCCESS => return @intCast(rc),
            .INTR => continue,
            .AGAIN => return error.WouldBlock,
            .PIPE => return error.BrokenPipe,
            .IO => return error.InputOutput,
            .BADF => return error.Unexpected,
            else => |err| return unexpectedErrno(err),
        }
    }
}

pub fn writev(fd: fd_t, iovecs: []const iovec_const) !usize {
    if (iovecs.len == 0) return 0;
    while (true) {
        const rc = std.c.writev(fd, iovecs.ptr, @intCast(iovecs.len));
        switch (errno(rc)) {
            .SUCCESS => return @intCast(rc),
            .INTR => continue,
            .AGAIN => return error.WouldBlock,
            .PIPE => return error.BrokenPipe,
            .IO => return error.InputOutput,
            .BADF => return error.Unexpected,
            else => |err| return unexpectedErrno(err),
        }
    }
}

pub fn pipe2(flags: O) ![2]fd_t {
    var fds: [2]fd_t = undefined;
    while (true) {
        const rc = std.c.pipe2(&fds, flags);
        switch (errno(rc)) {
            .SUCCESS => return fds,
            .INTR => continue,
            .INVAL => unreachable,
            .MFILE => return error.ProcessFdQuotaExceeded,
            .NFILE => return error.SystemFdQuotaExceeded,
            .NOMEM => return error.SystemResources,
            else => |err| return unexpectedErrno(err),
        }
    }
}

pub fn fcntl(fd: fd_t, cmd: c_int, arg: c_int) !c_int {
    while (true) {
        const rc = std.c.fcntl(fd, cmd, arg);
        switch (errno(rc)) {
            .SUCCESS => return rc,
            .INTR => continue,
            .AGAIN => return error.WouldBlock,
            .BADF => return error.FileDescriptorNotRegistered,
            .INVAL => return error.InvalidArgument,
            .PERM => return error.PermissionDenied,
            else => |err| return unexpectedErrno(err),
        }
    }
}

pub fn fork() !pid_t {
    while (true) {
        const rc = std.c.fork();
        switch (errno(rc)) {
            .SUCCESS => return rc,
            .INTR => continue,
            .AGAIN => return error.SystemResources,
            .NOMEM => return error.SystemResources,
            else => |err| return unexpectedErrno(err),
        }
    }
}

pub fn dup2(old_fd: fd_t, new_fd: fd_t) !void {
    while (true) {
        const rc = std.c.dup2(old_fd, new_fd);
        switch (errno(rc)) {
            .SUCCESS => return,
            .INTR => continue,
            .BADF => return error.FileDescriptorNotRegistered,
            .MFILE => return error.ProcessFdQuotaExceeded,
            else => |err| return unexpectedErrno(err),
        }
    }
}

pub const WaitPidResult = struct {
    pid: pid_t,
    status: u32,
};

pub fn waitpid(pid: pid_t, flags: u32) WaitPidResult {
    var status: c_int = undefined;
    while (true) {
        const rc = std.c.waitpid(pid, &status, @intCast(flags));
        switch (errno(rc)) {
            .SUCCESS => return .{ .pid = rc, .status = @bitCast(status) },
            .INTR => continue,
            .CHILD => unreachable,
            .INVAL => unreachable,
            else => unreachable,
        }
    }
}

pub fn shutdown(fd: fd_t, how: c_int) !void {
    while (true) {
        const rc = std.c.shutdown(fd, how);
        switch (errno(rc)) {
            .SUCCESS => return,
            .INTR => continue,
            .AGAIN => return error.WouldBlock,
            .BADF => return error.FileDescriptorNotRegistered,
            .NOTCONN => return error.SocketNotConnected,
            else => |err| return unexpectedErrno(err),
        }
    }
}

pub fn chdir(path: []const u8) !void {
    const path_z = try std.posix.toPosixPath(path);
    while (true) {
        const rc = std.c.chdir(&path_z);
        switch (errno(rc)) {
            .SUCCESS => return,
            .INTR => continue,
            .ACCES => return error.AccessDenied,
            .FAULT => unreachable,
            .IO => return error.InputOutput,
            .LOOP => return error.SymLinkLoop,
            .NAMETOOLONG => return error.NameTooLong,
            .NOENT => return error.FileNotFound,
            .NOMEM => return error.SystemResources,
            .NOTDIR => return error.NotDir,
            else => |err| return unexpectedErrno(err),
        }
    }
}

pub fn nanosleep(seconds: u64, nanoseconds: u64) void {
    var req = std.c.timespec{
        .sec = @intCast(seconds),
        .nsec = @intCast(nanoseconds),
    };
    while (std.c.nanosleep(&req, &req) != 0) {
        if (errno(-1) != .INTR) return;
    }
}

pub fn exit(status: u8) noreturn {
    std.process.exit(status);
}

pub fn unlink(path: []const u8) !void {
    const path_z = try std.posix.toPosixPath(path);
    while (true) {
        const rc = std.c.unlink(&path_z);
        switch (errno(rc)) {
            .SUCCESS => return,
            .INTR => continue,
            .ACCES => return error.AccessDenied,
            .PERM => return error.PermissionDenied,
            .BUSY => return error.FileBusy,
            .FAULT => unreachable,
            .IO => return error.InputOutput,
            .LOOP => return error.SymLinkLoop,
            .NAMETOOLONG => return error.NameTooLong,
            .NOENT => return error.FileNotFound,
            .NOTDIR => return error.NotDir,
            .ISDIR => return error.IsDir,
            else => |err| return unexpectedErrno(err),
        }
    }
}

pub fn execvpeZ(
    file: [*:0]const u8,
    argv: [*:null]const ?[*:0]const u8,
    envp: [*:null]const ?[*:0]const u8,
) !noreturn {
    const file_slice = std.mem.span(file);
    if (std.mem.findScalar(u8, file_slice, '/') != null) {
        return execveZ(file, argv, envp);
    }

    const path = findEnv(envp, "PATH") orelse "/bin:/usr/bin";
    var it = std.mem.splitScalar(u8, path, ':');
    var saw_access_denied = false;
    var candidate_buf: [std.posix.PATH_MAX]u8 = undefined;

    while (it.next()) |component| {
        const candidate = if (component.len == 0)
            std.fmt.bufPrintZ(&candidate_buf, "{s}", .{file_slice}) catch continue
        else
            std.fmt.bufPrintZ(&candidate_buf, "{s}/{s}", .{ component, file_slice }) catch continue;

        execveZ(candidate.ptr, argv, envp) catch |err| switch (err) {
            error.FileNotFound, error.NotDir => continue,
            error.AccessDenied => {
                saw_access_denied = true;
                continue;
            },
            else => return err,
        };
    }

    if (saw_access_denied) return error.AccessDenied;
    return error.FileNotFound;
}

fn execveZ(
    path: [*:0]const u8,
    argv: [*:null]const ?[*:0]const u8,
    envp: [*:null]const ?[*:0]const u8,
) !noreturn {
    _ = std.c.execve(path, argv, envp);
    return switch (errno(-1)) {
        .ACCES, .PERM => error.AccessDenied,
        .NOENT => error.FileNotFound,
        .NOTDIR => error.NotDir,
        .LOOP => error.SymLinkLoop,
        .NAMETOOLONG => error.NameTooLong,
        .NOMEM => error.SystemResources,
        .TXTBSY => error.FileBusy,
        else => |err| unexpectedErrno(err),
    };
}

fn findEnv(envp: [*:null]const ?[*:0]const u8, key: []const u8) ?[]const u8 {
    var idx: usize = 0;
    while (envp[idx]) |entry_z| : (idx += 1) {
        const entry = std.mem.span(entry_z);
        if (entry.len <= key.len or entry[key.len] != '=') continue;
        if (std.mem.eql(u8, entry[0..key.len], key)) return entry[key.len + 1 ..];
    }
    return null;
}

pub fn tcpConnectLoopback(port: u16) !fd_t {
    const fd = while (true) {
        const rc = std.c.socket(std.c.AF.INET, std.c.SOCK.STREAM | std.c.SOCK.CLOEXEC, 0);
        switch (errno(rc)) {
            .SUCCESS => break rc,
            .INTR => continue,
            .ACCES, .PERM => return error.AccessDenied,
            .MFILE => return error.ProcessFdQuotaExceeded,
            .NFILE => return error.SystemFdQuotaExceeded,
            .NOMEM => return error.SystemResources,
            else => |err| return unexpectedErrno(err),
        }
    };
    errdefer close(fd);

    var addr = std.c.sockaddr.in{
        .port = std.mem.nativeToBig(u16, port),
        .addr = std.mem.nativeToBig(u32, 0x7f000001),
    };

    while (true) {
        const rc = std.c.connect(fd, @ptrCast(&addr), @sizeOf(@TypeOf(addr)));
        switch (errno(rc)) {
            .SUCCESS => return fd,
            .INTR => continue,
            .ACCES, .PERM => return error.AccessDenied,
            .CONNREFUSED => return error.ConnectionRefused,
            .HOSTUNREACH, .NETUNREACH => return error.NetworkUnreachable,
            .TIMEDOUT => return error.ConnectionTimedOut,
            .ADDRINUSE => return error.AddressInUse,
            .AGAIN, .INPROGRESS => return error.WouldBlock,
            else => |err| return unexpectedErrno(err),
        }
    }
}
