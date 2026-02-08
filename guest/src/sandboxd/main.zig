const std = @import("std");
const protocol = @import("sandboxd").protocol;
const c = @cImport({
    @cInclude("pty.h");
    @cInclude("unistd.h");
    @cInclude("sys/ioctl.h");
});

const log = std.log.scoped(.sandboxd);

const Termination = struct {
    exit_code: i32,
    signal: ?i32,
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    log.info("starting", .{});

    var virtio = try openVirtioPort();
    defer virtio.close();
    const virtio_fd: std.posix.fd_t = virtio.handle;

    log.info("opened virtio port", .{});

    sendVfsStatus(allocator, virtio_fd) catch |err| {
        log.err("failed to send vfs status: {s}", .{@errorName(err)});
    };

    var waiting_for_reconnect = false;

    while (true) {
        const frame = protocol.readFrame(allocator, virtio_fd) catch |err| {
            if (err == error.EndOfStream) {
                if (!waiting_for_reconnect) {
                    log.info("virtio port closed, waiting for reconnect", .{});
                    waiting_for_reconnect = true;
                }
                waitForVirtioData(virtio_fd);
                continue;
            }
            log.err("failed to read frame: {s}", .{@errorName(err)});
            continue;
        };
        defer allocator.free(frame);

        waiting_for_reconnect = false;
        log.info("received frame ({} bytes)", .{frame.len});
        const req = protocol.decodeExecRequest(allocator, frame) catch |err| {
            log.err("invalid exec_request: {s}", .{@errorName(err)});
            _ = protocol.sendError(allocator, virtio_fd, 0, "invalid_request", "invalid exec_request") catch {};
            continue;
        };
        log.info("exec request id={} cmd={s}", .{ req.id, req.cmd });
        defer {
            allocator.free(req.argv);
            allocator.free(req.env);
        }

        handleExec(allocator, virtio_fd, req) catch |err| {
            log.err("exec handling failed: {s}", .{@errorName(err)});
            _ = protocol.sendError(allocator, virtio_fd, req.id, "exec_failed", "failed to execute") catch {};
        };
    }
}

fn sendVfsStatus(allocator: std.mem.Allocator, virtio_fd: std.posix.fd_t) !void {
    if (try readVfsErrorMessage(allocator)) |message| {
        defer allocator.free(message);
        const trimmed = std.mem.trim(u8, message, " \r\n\t");
        const detail = if (trimmed.len > 0) trimmed else "vfs mount not ready";
        try protocol.sendVfsError(allocator, virtio_fd, detail);
        return;
    }

    try protocol.sendVfsReady(allocator, virtio_fd);
}

fn readVfsErrorMessage(allocator: std.mem.Allocator) !?[]u8 {
    const file = std.fs.openFileAbsolute("/run/sandboxfs.failed", .{}) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
    defer file.close();
    return try file.readToEndAlloc(allocator, 4096);
}

fn tryOpenVirtioPath(path: []const u8) !?std.fs.File {
    const fd = std.posix.open(path, .{ .ACCMODE = .RDWR, .NONBLOCK = true, .CLOEXEC = true }, 0) catch |err| switch (err) {
        error.FileNotFound, error.NoDevice => return null,
        else => return err,
    };

    const original_flags = try std.posix.fcntl(fd, std.posix.F.GETFL, 0);
    const nonblock_flag_u32: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
    const nonblock_flag: usize = @intCast(nonblock_flag_u32);
    _ = try std.posix.fcntl(fd, std.posix.F.SETFL, original_flags & ~nonblock_flag);

    return std.fs.File{ .handle = fd };
}

fn scanVirtioPorts() !?std.fs.File {
    var dev_dir = std.fs.openDirAbsolute("/dev", .{ .iterate = true }) catch return null;
    defer dev_dir.close();

    var it = dev_dir.iterate();
    var path_buf: [64]u8 = undefined;
    while (try it.next()) |entry| {
        if (!std.mem.startsWith(u8, entry.name, "vport")) continue;
        if (!virtioPortMatches(entry.name, "virtio-port")) continue;
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

fn openVirtioPort() !std.fs.File {
    const paths = [_][]const u8{
        "/dev/virtio-ports/virtio-port",
    };

    var warned = false;

    while (true) {
        for (paths) |path| {
            if (try tryOpenVirtioPath(path)) |file| return file;
        }

        if (try scanVirtioPorts()) |file| return file;

        if (!warned) {
            log.info("waiting for virtio port", .{});
            warned = true;
        }

        std.posix.nanosleep(0, 100 * std.time.ns_per_ms);
    }
}

fn waitForVirtioData(virtio_fd: std.posix.fd_t) void {
    while (true) {
        var pollfds: [1]std.posix.pollfd = .{.{
            .fd = virtio_fd,
            .events = std.posix.POLL.IN,
            .revents = 0,
        }};

        const res = std.posix.poll(pollfds[0..], -1) catch return;
        if (res <= 0) continue;

        const revents = pollfds[0].revents;
        if ((revents & std.posix.POLL.HUP) != 0) {
            std.posix.nanosleep(0, 100 * std.time.ns_per_ms);
            continue;
        }

        if ((revents & std.posix.POLL.IN) != 0) return;
    }
}

fn handleExec(allocator: std.mem.Allocator, virtio_fd: std.posix.fd_t, req: protocol.ExecRequest) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    const argv = try buildArgv(arena_alloc, req.cmd, req.argv);
    const envp = try buildEnvp(arena_alloc, allocator, req.env);

    const use_pty = req.pty;
    const wants_stdin = req.stdin or use_pty;

    var stdout_fd: ?std.posix.fd_t = null;
    var stderr_fd: ?std.posix.fd_t = null;
    var stdin_fd: ?std.posix.fd_t = null;
    var pty_master: ?std.posix.fd_t = null;

    var stdout_pipe: ?[2]std.posix.fd_t = null;
    var stderr_pipe: ?[2]std.posix.fd_t = null;
    var stdin_pipe: ?[2]std.posix.fd_t = null;

    var pid: std.posix.pid_t = 0;

    if (use_pty) {
        var master: c_int = 0;
        const forked = c.forkpty(&master, null, null, null);
        if (forked < 0) {
            return error.OpenPtyFailed;
        }
        pid = @intCast(forked);
        if (pid == 0) {
            if (req.cwd) |cwd| {
                _ = std.posix.chdir(cwd) catch std.posix.exit(127);
            }

            std.posix.execvpeZ(argv[0].?, argv, envp) catch {
                const msg = "exec failed\n";
                _ = std.posix.write(std.posix.STDERR_FILENO, msg) catch {};
                std.posix.exit(127);
            };
        }

        pty_master = @intCast(master);
        stdout_fd = pty_master;
        stdin_fd = pty_master;
        errdefer {
            if (pty_master) |fd| std.posix.close(fd);
        }
    } else {
        stdout_pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
        errdefer {
            std.posix.close(stdout_pipe.?[0]);
            std.posix.close(stdout_pipe.?[1]);
        }

        stderr_pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
        errdefer {
            std.posix.close(stderr_pipe.?[0]);
            std.posix.close(stderr_pipe.?[1]);
        }

        if (wants_stdin) {
            stdin_pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
            errdefer {
                std.posix.close(stdin_pipe.?[0]);
                std.posix.close(stdin_pipe.?[1]);
            }
        }

        stdout_fd = stdout_pipe.?[0];
        stderr_fd = stderr_pipe.?[0];
        if (wants_stdin) stdin_fd = stdin_pipe.?[1];

        pid = try std.posix.fork();
        if (pid == 0) {
            if (wants_stdin) {
                try std.posix.dup2(stdin_pipe.?[0], std.posix.STDIN_FILENO);
            } else {
                const devnull = std.posix.openZ("/dev/null", .{ .ACCMODE = .RDONLY }, 0) catch std.posix.exit(127);
                try std.posix.dup2(devnull, std.posix.STDIN_FILENO);
                std.posix.close(devnull);
            }

            try std.posix.dup2(stdout_pipe.?[1], std.posix.STDOUT_FILENO);
            try std.posix.dup2(stderr_pipe.?[1], std.posix.STDERR_FILENO);

            std.posix.close(stdout_pipe.?[0]);
            std.posix.close(stdout_pipe.?[1]);
            std.posix.close(stderr_pipe.?[0]);
            std.posix.close(stderr_pipe.?[1]);

            if (wants_stdin) {
                std.posix.close(stdin_pipe.?[0]);
                std.posix.close(stdin_pipe.?[1]);
            }

            if (req.cwd) |cwd| {
                _ = std.posix.chdir(cwd) catch std.posix.exit(127);
            }

            std.posix.execvpeZ(argv[0].?, argv, envp) catch {
                const msg = "exec failed\n";
                _ = std.posix.write(std.posix.STDERR_FILENO, msg) catch {};
                std.posix.exit(127);
            };
        }
    }

    if (!use_pty) {
        std.posix.close(stdout_pipe.?[1]);
        std.posix.close(stderr_pipe.?[1]);
        if (wants_stdin) std.posix.close(stdin_pipe.?[0]);
    }

    const original_flags = try std.posix.fcntl(virtio_fd, std.posix.F.GETFL, 0);
    const nonblock_flag_u32: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
    const nonblock_flag: usize = @intCast(nonblock_flag_u32);
    _ = try std.posix.fcntl(virtio_fd, std.posix.F.SETFL, original_flags | nonblock_flag);
    defer _ = std.posix.fcntl(virtio_fd, std.posix.F.SETFL, original_flags) catch {};

    var writer = protocol.FrameWriter.init(allocator);
    defer writer.deinit();

    var stdin_reader = protocol.FrameReader.init(allocator);
    defer stdin_reader.deinit();

    var stdout_open = stdout_fd != null;
    var stderr_open = stderr_fd != null;
    var stdin_open = wants_stdin and stdin_fd != null;
    const close_stdin_on_eof = !use_pty;

    var status: ?u32 = null;
    var buffer: [8192]u8 = undefined;

    const max_buffered: usize = 256 * 1024;
    const max_total_credit: usize = 16 * 1024 * 1024;

    const max_stdout_credit: usize = @min(max_total_credit, @as(usize, @intCast(req.stdout_window)));
    const max_stderr_credit: usize = @min(max_total_credit, @as(usize, @intCast(req.stderr_window)));

    var stdout_credit: usize = max_stdout_credit;
    var stderr_credit: usize = max_stderr_credit;

    while (true) {
        if (status != null and !stdout_open and !stderr_open and !writer.hasPending()) break;

        var pollfds: [3]std.posix.pollfd = undefined;
        var nfds: usize = 0;
        var stdout_index: ?usize = null;
        var stderr_index: ?usize = null;
        var virtio_index: ?usize = null;

        const backpressure = writer.pendingBytes() >= max_buffered;

        if (stdout_open) {
            stdout_index = nfds;
            const events: i16 = if (!backpressure and stdout_credit > 0) std.posix.POLL.IN else 0;
            pollfds[nfds] = .{ .fd = stdout_fd.?, .events = events, .revents = 0 };
            nfds += 1;
        }
        if (stderr_open) {
            stderr_index = nfds;
            const events: i16 = if (!backpressure and stderr_credit > 0) std.posix.POLL.IN else 0;
            pollfds[nfds] = .{ .fd = stderr_fd.?, .events = events, .revents = 0 };
            nfds += 1;
        }

        // Always poll for input so we can receive exec_window updates.
        var virtio_events: i16 = std.posix.POLL.IN;
        if (writer.hasPending()) virtio_events |= std.posix.POLL.OUT;
        if (virtio_events != 0) {
            virtio_index = nfds;
            pollfds[nfds] = .{ .fd = virtio_fd, .events = virtio_events, .revents = 0 };
            nfds += 1;
        }

        if (nfds == 0) {
            if (status == null) {
                status = std.posix.waitpid(pid, 0).status;
            }
            continue;
        }

        _ = try std.posix.poll(pollfds[0..nfds], 100);

        if (stdout_index) |sindex| {
            const revents = pollfds[sindex].revents;

            if (!backpressure and stdout_credit > 0 and (revents & (std.posix.POLL.IN | std.posix.POLL.HUP)) != 0) {
                const max_read: usize = @min(buffer.len, stdout_credit);
                const n = std.posix.read(stdout_fd.?, buffer[0..max_read]) catch |err| blk: {
                    if (use_pty and err == error.InputOutput) {
                        break :blk 0;
                    }
                    return err;
                };
                if (n == 0) {
                    stdout_open = false;
                    if (stdout_fd) |fd| std.posix.close(fd);
                    stdout_fd = null;
                    if (use_pty and stdin_fd != null) {
                        stdin_fd = null;
                        stdin_open = false;
                    }
                } else {
                    stdout_credit -= n;
                    const payload = try protocol.encodeExecOutput(allocator, req.id, "stdout", buffer[0..n]);
                    defer allocator.free(payload);
                    try writer.enqueue(payload);
                    try writer.flush(virtio_fd);
                }
            } else if ((revents & std.posix.POLL.HUP) != 0) {
                // If we are not allowed to read (no credits / backpressure) we still want to
                // observe EOF promptly when the pipe is drained.
                if (stdout_fd) |fd| {
                    if (bytesAvailable(fd) == 0) {
                        stdout_open = false;
                        std.posix.close(fd);
                        stdout_fd = null;
                        if (use_pty and stdin_fd != null) {
                            stdin_fd = null;
                            stdin_open = false;
                        }
                    }
                }
            }
        }

        if (stderr_index) |sindex| {
            const revents = pollfds[sindex].revents;

            if (!backpressure and stderr_credit > 0 and (revents & (std.posix.POLL.IN | std.posix.POLL.HUP)) != 0) {
                const max_read: usize = @min(buffer.len, stderr_credit);
                const n = try std.posix.read(stderr_fd.?, buffer[0..max_read]);
                if (n == 0) {
                    stderr_open = false;
                    if (stderr_fd) |fd| std.posix.close(fd);
                    stderr_fd = null;
                } else {
                    stderr_credit -= n;
                    const payload = try protocol.encodeExecOutput(allocator, req.id, "stderr", buffer[0..n]);
                    defer allocator.free(payload);
                    try writer.enqueue(payload);
                    try writer.flush(virtio_fd);
                }
            } else if ((revents & std.posix.POLL.HUP) != 0) {
                if (stderr_fd) |fd| {
                    if (bytesAvailable(fd) == 0) {
                        stderr_open = false;
                        std.posix.close(fd);
                        stderr_fd = null;
                    }
                }
            }
        }

        if (virtio_index) |vindex| {
            const revents = pollfds[vindex].revents;
            if ((revents & std.posix.POLL.OUT) != 0) {
                try writer.flush(virtio_fd);
            }
            if ((revents & (std.posix.POLL.IN | std.posix.POLL.HUP)) != 0) {
                handleVirtioInput(
                    allocator,
                    &stdin_reader,
                    virtio_fd,
                    &stdin_fd,
                    &stdin_open,
                    req.id,
                    close_stdin_on_eof,
                    pty_master,
                    &stdout_credit,
                    &stderr_credit,
                    max_stdout_credit,
                    max_stderr_credit,
                ) catch |err| {
                    log.err("virtio input handling failed: {s}", .{@errorName(err)});
                    if (close_stdin_on_eof and stdin_fd != null) {
                        std.posix.close(stdin_fd.?);
                        stdin_fd = null;
                        stdin_open = false;
                    }
                };

                // If we were using a PTY, stdout/stdin share the master fd.
                if (use_pty and stdin_fd != null and !stdin_open) {
                    stdin_fd = null;
                }
                if (!use_pty and close_stdin_on_eof and stdin_fd != null and !stdin_open) {
                    stdin_fd = null;
                }
            }
        }

        if (status == null) {
            const res = std.posix.waitpid(pid, std.posix.W.NOHANG);
            if (res.pid != 0) {
                status = res.status;
            }
        }
    }

    if (!use_pty) {
        if (stdin_fd) |fd| std.posix.close(fd);
    }

    if (status == null) {
        status = std.posix.waitpid(pid, 0).status;
    }

    const term = parseStatus(status.?);
    const response = try protocol.encodeExecResponse(allocator, req.id, term.exit_code, term.signal);
    defer allocator.free(response);
    try writer.enqueue(response);
    try flushWriter(virtio_fd, &writer);
}

fn handleVirtioInput(
    allocator: std.mem.Allocator,
    reader: *protocol.FrameReader,
    virtio_fd: std.posix.fd_t,
    stdin_fd: *?std.posix.fd_t,
    stdin_open: *bool,
    expected_id: u32,
    close_on_eof: bool,
    pty_master: ?std.posix.fd_t,
    stdout_credit: *usize,
    stderr_credit: *usize,
    max_stdout_credit: usize,
    max_stderr_credit: usize,
) !void {
    while (true) {
        const frame = reader.readFrame(virtio_fd) catch |err| {
            if (err == error.EndOfStream) {
                if (stdin_fd.*) |fd| {
                    std.posix.close(fd);
                    stdin_fd.* = null;
                }
                stdin_open.* = false;
                return;
            }
            return err;
        };
        if (frame == null) break;

        const frame_buf = frame.?;
        defer allocator.free(frame_buf);

        const message = try protocol.decodeInputMessage(allocator, frame_buf, expected_id);
        switch (message) {
            .stdin => |data| {
                if (stdin_fd.*) |fd| {
                    if (data.data.len > 0) {
                        try protocol.writeAll(fd, data.data);
                    }
                    if (data.eof) {
                        if (close_on_eof) {
                            std.posix.close(fd);
                            stdin_fd.* = null;
                        } else {
                            const eot: [1]u8 = .{4};
                            _ = protocol.writeAll(fd, &eot) catch {};
                        }
                        stdin_open.* = false;
                    }
                }
            },
            .resize => |size| {
                if (pty_master) |fd| {
                    applyPtyResize(fd, size.rows, size.cols);
                }
            },
            .window => |win| {
                if (win.stdout > 0) {
                    const add: usize = @intCast(win.stdout);
                    stdout_credit.* = @min(max_stdout_credit, stdout_credit.* + add);
                }
                if (win.stderr > 0) {
                    const add: usize = @intCast(win.stderr);
                    stderr_credit.* = @min(max_stderr_credit, stderr_credit.* + add);
                }
            },
        }
    }
}

fn bytesAvailable(fd: std.posix.fd_t) usize {
    var n: c_int = 0;
    if (c.ioctl(fd, c.FIONREAD, &n) != 0) return 1;
    if (n <= 0) return 0;
    return @intCast(n);
}

fn applyPtyResize(fd: std.posix.fd_t, rows: u32, cols: u32) void {
    const Field = @TypeOf(@as(c.struct_winsize, undefined).ws_row);
    const max = std.math.maxInt(Field);
    const safe_rows: Field = @intCast(if (rows > max) max else rows);
    const safe_cols: Field = @intCast(if (cols > max) max else cols);

    var winsize = c.struct_winsize{
        .ws_row = safe_rows,
        .ws_col = safe_cols,
        .ws_xpixel = 0,
        .ws_ypixel = 0,
    };
    _ = c.ioctl(fd, c.TIOCSWINSZ, &winsize);
}

fn flushWriter(virtio_fd: std.posix.fd_t, writer: *protocol.FrameWriter) !void {
    while (writer.hasPending()) {
        var pollfds: [1]std.posix.pollfd = .{.{
            .fd = virtio_fd,
            .events = std.posix.POLL.OUT,
            .revents = 0,
        }};

        _ = try std.posix.poll(pollfds[0..], 100);
        const revents = pollfds[0].revents;
        if ((revents & std.posix.POLL.OUT) != 0) {
            try writer.flush(virtio_fd);
        }
        if ((revents & std.posix.POLL.HUP) != 0) return error.EndOfStream;
    }
}

fn parseStatus(status: u32) Termination {
    if (std.posix.W.IFEXITED(status)) {
        return .{ .exit_code = @as(i32, @intCast(std.posix.W.EXITSTATUS(status))), .signal = null };
    }
    if (std.posix.W.IFSIGNALED(status)) {
        const sig = @as(i32, @intCast(std.posix.W.TERMSIG(status)));
        return .{ .exit_code = 128 + sig, .signal = sig };
    }
    return .{ .exit_code = 1, .signal = null };
}

fn buildArgv(
    allocator: std.mem.Allocator,
    cmd: []const u8,
    argv: []const []const u8,
) ![*:null]const ?[*:0]const u8 {
    const total = argv.len + 1;
    const argv_buf = try allocator.allocSentinel(?[*:0]const u8, total, null);
    argv_buf[0] = (try allocator.dupeZ(u8, cmd)).ptr;
    for (argv, 0..) |arg, idx| {
        argv_buf[idx + 1] = (try allocator.dupeZ(u8, arg)).ptr;
    }
    return argv_buf.ptr;
}

fn buildEnvp(
    arena: std.mem.Allocator,
    allocator: std.mem.Allocator,
    env: []const []const u8,
) ![*:null]const ?[*:0]const u8 {
    if (env.len == 0) {
        return std.c.environ;
    }

    var env_map = try std.process.getEnvMap(allocator);
    defer env_map.deinit();

    for (env) |entry| {
        const sep = std.mem.indexOfScalar(u8, entry, '=') orelse return protocol.ProtocolError.InvalidValue;
        const key = entry[0..sep];
        const value = entry[sep + 1 ..];
        try env_map.put(key, value);
    }

    const total: usize = @intCast(env_map.count());
    const envp_buf = try arena.allocSentinel(?[*:0]const u8, total, null);

    var it = env_map.iterator();
    var idx: usize = 0;
    while (it.next()) |entry| : (idx += 1) {
        const key = entry.key_ptr.*;
        const value = entry.value_ptr.*;
        const full_len = key.len + 1 + value.len;
        var pair = try arena.alloc(u8, full_len + 1);
        std.mem.copyForwards(u8, pair[0..key.len], key);
        pair[key.len] = '=';
        std.mem.copyForwards(u8, pair[key.len + 1 .. key.len + 1 + value.len], value);
        pair[full_len] = 0;
        envp_buf[idx] = pair[0..full_len :0].ptr;
    }

    return envp_buf.ptr;
}
