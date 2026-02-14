const std = @import("std");
const protocol = @import("sandboxd").protocol;
const file_requests = @import("file_requests.zig");
const c = @cImport({
    @cInclude("pty.h");
    @cInclude("unistd.h");
    @cInclude("sys/ioctl.h");
});

const log = std.log.scoped(.sandboxd);

/// max buffered stdin per exec session in `bytes`
const max_queued_stdin_bytes: usize = 4 * 1024 * 1024;

const Termination = struct {
    exit_code: i32,
    signal: ?i32,
};

const StdinChunk = struct {
    data: []u8,
    eof: bool,
};

const ExecControlMessage = union(enum) {
    stdin: StdinChunk,
    resize: protocol.PtyResize,
    window: protocol.ExecWindow,
};

const OwnedExecRequest = struct {
    id: u32,
    cmd: []u8,
    argv: []const []const u8,
    env: []const []const u8,
    cwd: ?[]u8,
    stdin: bool,
    pty: bool,
    stdout_window: u32,
    stderr_window: u32,

    fn deinit(self: *OwnedExecRequest, allocator: std.mem.Allocator) void {
        allocator.free(self.cmd);
        for (self.argv) |arg| allocator.free(arg);
        allocator.free(self.argv);
        for (self.env) |entry| allocator.free(entry);
        allocator.free(self.env);
        if (self.cwd) |cwd| allocator.free(cwd);
    }
};

const VirtioTx = struct {
    fd: std.posix.fd_t,
    mutex: std.Thread.Mutex = .{},

    pub fn sendPayload(self: *VirtioTx, payload: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try protocol.writeFrame(self.fd, payload);
    }

    fn sendError(self: *VirtioTx, allocator: std.mem.Allocator, id: u32, code: []const u8, message: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try protocol.sendError(allocator, self.fd, id, code, message);
    }

    fn sendStdinWindow(self: *VirtioTx, allocator: std.mem.Allocator, id: u32, stdin: u32) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try protocol.sendStdinWindow(allocator, self.fd, id, stdin);
    }

    fn sendVfsReady(self: *VirtioTx, allocator: std.mem.Allocator) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try protocol.sendVfsReady(allocator, self.fd);
    }

    fn sendVfsError(self: *VirtioTx, allocator: std.mem.Allocator, message: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try protocol.sendVfsError(allocator, self.fd, message);
    }
};

const ExecSession = struct {
    allocator: std.mem.Allocator,
    tx: *VirtioTx,
    req: OwnedExecRequest,
    mutex: std.Thread.Mutex = .{},
    control_cv: std.Thread.Condition = .{},
    controls: std.ArrayList(ExecControlMessage) = .empty,
    /// stdin bytes buffered in the control queue in `bytes`
    stdin_queued_bytes: usize = 0,
    /// stdin credits granted to the host but not yet received in `bytes`
    stdin_credit_inflight: usize = 0,
    done: bool = false,
    thread: ?std.Thread = null,
    wake_read_fd: ?std.posix.fd_t = null,
    wake_write_fd: ?std.posix.fd_t = null,

    fn init(allocator: std.mem.Allocator, tx: *VirtioTx, req: OwnedExecRequest) !ExecSession {
        const wake_pipe = try std.posix.pipe2(.{ .CLOEXEC = true, .NONBLOCK = true });

        return .{
            .allocator = allocator,
            .tx = tx,
            .req = req,
            .controls = .empty,
            .wake_read_fd = wake_pipe[0],
            .wake_write_fd = wake_pipe[1],
        };
    }

    fn deinit(self: *ExecSession) void {
        if (self.wake_read_fd) |fd| {
            std.posix.close(fd);
            self.wake_read_fd = null;
        }
        if (self.wake_write_fd) |fd| {
            std.posix.close(fd);
            self.wake_write_fd = null;
        }

        for (self.controls.items) |msg| {
            switch (msg) {
                .stdin => |chunk| self.allocator.free(chunk.data),
                else => {},
            }
        }
        self.controls.deinit(self.allocator);
        self.req.deinit(self.allocator);
    }
};

fn cloneExecRequest(allocator: std.mem.Allocator, req: protocol.ExecRequest) !OwnedExecRequest {
    var argv = try allocator.alloc([]const u8, req.argv.len);
    var argv_len: usize = 0;
    errdefer {
        for (argv[0..argv_len]) |arg| allocator.free(arg);
        allocator.free(argv);
    }
    for (req.argv) |arg| {
        argv[argv_len] = try allocator.dupe(u8, arg);
        argv_len += 1;
    }

    var env = try allocator.alloc([]const u8, req.env.len);
    var env_len: usize = 0;
    errdefer {
        for (env[0..env_len]) |entry| allocator.free(entry);
        allocator.free(env);
    }
    for (req.env) |entry| {
        env[env_len] = try allocator.dupe(u8, entry);
        env_len += 1;
    }

    const cwd = if (req.cwd) |value| try allocator.dupe(u8, value) else null;
    errdefer if (cwd) |value| allocator.free(value);

    const cmd = try allocator.dupe(u8, req.cmd);
    errdefer allocator.free(cmd);

    return .{
        .id = req.id,
        .cmd = cmd,
        .argv = argv,
        .env = env,
        .cwd = cwd,
        .stdin = req.stdin,
        .pty = req.pty,
        .stdout_window = req.stdout_window,
        .stderr_window = req.stderr_window,
    };
}

fn markSessionDone(session: *ExecSession) void {
    session.mutex.lock();
    session.done = true;
    session.control_cv.broadcast();
    session.mutex.unlock();
}

fn notifyExecWorker(session: *ExecSession) void {
    const fd = session.wake_write_fd orelse return;
    const byte: [1]u8 = .{1};

    while (true) {
        _ = std.posix.write(fd, &byte) catch |err| switch (err) {
            error.WouldBlock, error.BrokenPipe => return,
            else => return,
        };
        return;
    }
}

fn drainExecWakeFd(fd: std.posix.fd_t) void {
    var buffer: [64]u8 = undefined;

    while (true) {
        const n = std.posix.read(fd, &buffer) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return,
        };

        if (n == 0) return;
    }
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    log.info("starting", .{});

    var virtio = try openVirtioPort();
    defer virtio.close();
    const virtio_fd: std.posix.fd_t = virtio.handle;

    var tx = VirtioTx{ .fd = virtio_fd };

    log.info("opened virtio port", .{});

    sendVfsStatus(allocator, &tx) catch |err| {
        log.err("failed to send vfs status: {s}", .{@errorName(err)});
    };

    var exec_sessions = std.AutoHashMap(u32, *ExecSession).init(allocator);
    defer cleanupAllExecSessions(allocator, &exec_sessions);

    var waiting_for_reconnect = false;

    while (true) {
        cleanupFinishedExecSessions(allocator, &exec_sessions);

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

        const exec_req = protocol.decodeExecRequest(allocator, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => {
                log.err("invalid exec_request: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, 0, "invalid_request", "invalid exec_request") catch {};
                continue;
            },
        };

        if (exec_req) |req| {
            log.info("exec request id={} cmd={s}", .{ req.id, req.cmd });
            defer {
                allocator.free(req.argv);
                allocator.free(req.env);
            }

            startExecSession(&exec_sessions, &tx, req) catch |err| {
                log.err("exec start failed: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, req.id, "exec_failed", "failed to execute") catch {};
            };
            continue;
        }

        const routed_input = protocol.decodeRoutedInputMessage(allocator, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => {
                log.err("invalid exec input: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, 0, "invalid_request", "invalid exec input") catch {};
                continue;
            },
        };

        if (routed_input) |routed| {
            if (exec_sessions.get(routed.id)) |session| {
                enqueueExecInput(session, routed.message) catch |err| switch (err) {
                    error.StdinBackpressure => {
                        _ = tx.sendError(allocator, routed.id, "stdin_backpressure", "stdin queue full") catch {};
                    },
                    error.StdinChunkTooLarge => {
                        _ = tx.sendError(allocator, routed.id, "stdin_chunk_too_large", "stdin chunk exceeds queue limit") catch {};
                    },
                    else => {
                        log.err("failed to queue exec input id={}: {s}", .{ routed.id, @errorName(err) });
                        _ = tx.sendError(allocator, routed.id, "exec_failed", "failed to queue exec input") catch {};
                    },
                };
            } else {
                _ = tx.sendError(allocator, routed.id, "unknown_id", "request id not found") catch {};
            }
            continue;
        }

        const file_read_req = protocol.decodeFileReadRequest(allocator, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => {
                log.err("invalid file_read_request: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, 0, "invalid_request", "invalid file_read_request") catch {};
                continue;
            },
        };

        if (file_read_req) |req| {
            file_requests.handleFileRead(allocator, &tx, "/", req) catch |err| {
                log.err("file read failed: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, req.id, "file_read_failed", @errorName(err)) catch {};
            };
            continue;
        }

        const file_write_req = protocol.decodeFileWriteRequest(allocator, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => {
                log.err("invalid file_write_request: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, 0, "invalid_request", "invalid file_write_request") catch {};
                continue;
            },
        };

        if (file_write_req) |req| {
            file_requests.handleFileWrite(allocator, virtio_fd, &tx, "/", req) catch |err| {
                log.err("file write failed: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, req.id, "file_write_failed", @errorName(err)) catch {};
            };
            continue;
        }

        const file_delete_req = protocol.decodeFileDeleteRequest(allocator, frame) catch |err| switch (err) {
            protocol.ProtocolError.UnexpectedType => null,
            else => {
                log.err("invalid file_delete_request: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, 0, "invalid_request", "invalid file_delete_request") catch {};
                continue;
            },
        };

        if (file_delete_req) |req| {
            file_requests.handleFileDelete(allocator, &tx, "/", req) catch |err| {
                log.err("file delete failed: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, req.id, "file_delete_failed", @errorName(err)) catch {};
            };
            continue;
        }

        _ = tx.sendError(allocator, 0, "invalid_request", "unsupported request type") catch {};
    }
}

fn startExecSession(
    sessions: *std.AutoHashMap(u32, *ExecSession),
    tx: *VirtioTx,
    req: protocol.ExecRequest,
) !void {
    if (sessions.get(req.id)) |existing| {
        existing.mutex.lock();
        const done = existing.done;
        existing.mutex.unlock();

        if (!done) {
            return error.DuplicateRequestId;
        }

        if (existing.thread) |thread| {
            thread.join();
            existing.thread = null;
        }
        existing.deinit();
        const sess_alloc = existing.allocator;
        _ = sessions.remove(req.id);
        sess_alloc.destroy(existing);
    }

    const allocator = std.heap.page_allocator;
    var owned_opt: ?OwnedExecRequest = try cloneExecRequest(allocator, req);
    errdefer if (owned_opt) |owned| {
        var temp = owned;
        temp.deinit(allocator);
    };

    const session = try allocator.create(ExecSession);
    errdefer allocator.destroy(session);

    session.* = try ExecSession.init(allocator, tx, owned_opt.?);
    owned_opt = null;
    errdefer session.deinit();

    try sessions.put(req.id, session);
    errdefer _ = sessions.remove(req.id);

    const thread = try std.Thread.spawn(.{}, execWorker, .{session});
    session.thread = thread;
}

fn enqueueExecInput(session: *ExecSession, input: protocol.InputMessage) !void {
    session.mutex.lock();
    defer session.mutex.unlock();

    if (session.done) return;

    switch (input) {
        .stdin => |chunk| {
            if (chunk.data.len > max_queued_stdin_bytes) {
                return error.StdinChunkTooLarge;
            }

            if (session.stdin_queued_bytes + chunk.data.len > max_queued_stdin_bytes) {
                return error.StdinBackpressure;
            }

            // Flow control: the host must not send more stdin bytes than the guest
            // has advertised via stdin_window.
            if (chunk.data.len > session.stdin_credit_inflight) {
                return error.StdinBackpressure;
            }
            session.stdin_credit_inflight -= chunk.data.len;

            const copied = try session.allocator.alloc(u8, chunk.data.len);
            errdefer session.allocator.free(copied);
            std.mem.copyForwards(u8, copied, chunk.data);
            try session.controls.append(session.allocator, .{ .stdin = .{ .data = copied, .eof = chunk.eof } });
            session.stdin_queued_bytes += copied.len;
        },
        .resize => |size| {
            try session.controls.append(session.allocator, .{ .resize = size });
        },
        .window => |window| {
            try session.controls.append(session.allocator, .{ .window = window });
        },
    }

    session.control_cv.signal();
    notifyExecWorker(session);
}

fn cleanupFinishedExecSessions(
    allocator: std.mem.Allocator,
    sessions: *std.AutoHashMap(u32, *ExecSession),
) void {
    var done_ids = std.ArrayList(u32).empty;
    defer done_ids.deinit(allocator);

    var it = sessions.iterator();
    while (it.next()) |entry| {
        const id = entry.key_ptr.*;
        const session = entry.value_ptr.*;

        session.mutex.lock();
        const done = session.done;
        session.mutex.unlock();

        if (done) {
            done_ids.append(allocator, id) catch return;
        }
    }

    for (done_ids.items) |id| {
        const session = sessions.get(id) orelse continue;
        if (session.thread) |thread| {
            thread.join();
            session.thread = null;
        }
        session.deinit();
        const sess_alloc = session.allocator;
        _ = sessions.remove(id);
        sess_alloc.destroy(session);
    }
}

fn cleanupAllExecSessions(
    allocator: std.mem.Allocator,
    sessions: *std.AutoHashMap(u32, *ExecSession),
) void {
    cleanupFinishedExecSessions(allocator, sessions);

    var ids = std.ArrayList(u32).empty;
    defer ids.deinit(allocator);

    var it = sessions.iterator();
    while (it.next()) |entry| {
        ids.append(allocator, entry.key_ptr.*) catch break;
    }

    for (ids.items) |id| {
        const session = sessions.get(id) orelse continue;
        if (session.thread) |thread| {
            thread.join();
            session.thread = null;
        }
        session.deinit();
        const sess_alloc = session.allocator;
        _ = sessions.remove(id);
        sess_alloc.destroy(session);
    }

    sessions.deinit();
}

fn sendVfsStatus(allocator: std.mem.Allocator, tx: *VirtioTx) !void {
    if (try readVfsErrorMessage(allocator)) |message| {
        defer allocator.free(message);
        const trimmed = std.mem.trim(u8, message, " \r\n\t");
        const detail = if (trimmed.len > 0) trimmed else "vfs mount not ready";
        try tx.sendVfsError(allocator, detail);
        return;
    }

    try tx.sendVfsReady(allocator);
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

fn execWorker(session: *ExecSession) void {
    runExecSession(session) catch |err| {
        log.err("exec handling failed id={}: {s}", .{ session.req.id, @errorName(err) });
        _ = session.tx.sendError(session.allocator, session.req.id, "exec_failed", "failed to execute") catch {};
    };

    markSessionDone(session);
}

fn runExecSession(session: *ExecSession) !void {
    const req = session.req;

    var arena = std.heap.ArenaAllocator.init(session.allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    const argv = try buildArgv(arena_alloc, req.cmd, req.argv);
    const envp = try buildEnvp(arena_alloc, session.allocator, req.env);

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

    errdefer {
        if (pid > 0) {
            _ = std.posix.kill(pid, std.posix.SIG.KILL) catch {};
            _ = std.posix.waitpid(pid, 0);
        }
    }

    if (!use_pty) {
        std.posix.close(stdout_pipe.?[1]);
        std.posix.close(stderr_pipe.?[1]);
        if (wants_stdin) std.posix.close(stdin_pipe.?[0]);
    }

    var stdout_open = stdout_fd != null;
    var stderr_open = stderr_fd != null;
    var stdin_open = wants_stdin and stdin_fd != null;
    const close_stdin_on_eof = !use_pty;

    var status: ?u32 = null;

    if (wants_stdin) {
        const grant_bytes: usize = @min(max_queued_stdin_bytes, @as(usize, std.math.maxInt(u32)));
        session.mutex.lock();
        session.stdin_credit_inflight = grant_bytes;
        session.mutex.unlock();
        _ = session.tx.sendStdinWindow(session.allocator, req.id, @intCast(grant_bytes)) catch {};
    }

    // PTY mode: after the main PID exits, we stop waiting for EOF (other
    // processes may still hold the slave open) but do a short best-effort drain
    // of already-buffered output before forcing the PTY closed.
    var pty_close_deadline_ms: ?i64 = null;
    var pty_exit_drain_remaining: ?usize = null;

    var buffer: [8192]u8 = undefined;

    const max_total_credit: usize = 16 * 1024 * 1024;

    const max_stdout_credit: usize = @min(max_total_credit, @as(usize, @intCast(req.stdout_window)));
    const max_stderr_credit: usize = @min(max_total_credit, @as(usize, @intCast(req.stderr_window)));

    var stdout_credit: usize = max_stdout_credit;
    var stderr_credit: usize = max_stderr_credit;

    // Once a pipe has hung up, poll() may keep reporting POLLHUP even if
    // .events=0. If we're currently not allowed to read (no credits), keep it
    // out of the poll set to avoid a tight wakeup loop.
    var stdout_hup_seen = false;
    var stderr_hup_seen = false;

    var local_controls = std.ArrayList(ExecControlMessage).empty;
    defer {
        for (local_controls.items) |msg| {
            switch (msg) {
                .stdin => |chunk| session.allocator.free(chunk.data),
                else => {},
            }
        }
        local_controls.deinit(session.allocator);
    }

    while (true) {
        session.mutex.lock();
        std.mem.swap(std.ArrayList(ExecControlMessage), &local_controls, &session.controls);
        session.mutex.unlock();

        for (local_controls.items) |msg| {
            switch (msg) {
                .stdin => |data| {
                    const data_len = data.data.len;

                    if (stdin_fd) |fd| {
                        if (data_len > 0) {
                            protocol.writeAll(fd, data.data) catch {
                                std.posix.close(fd);
                                stdin_fd = null;
                                stdin_open = false;
                            };
                        }
                        if (data.eof) {
                            if (close_stdin_on_eof) {
                                std.posix.close(fd);
                                stdin_fd = null;
                            } else {
                                const eot: [1]u8 = .{4};
                                _ = protocol.writeAll(fd, &eot) catch {};
                            }
                            stdin_open = false;
                        }
                    }

                    session.allocator.free(data.data);

                    var grant: usize = 0;
                    session.mutex.lock();
                    if (session.stdin_queued_bytes >= data_len) {
                        session.stdin_queued_bytes -= data_len;
                    } else {
                        session.stdin_queued_bytes = 0;
                    }

                    // Credit-based stdin flow control.
                    // Maintain: stdin_queued_bytes + stdin_credit_inflight <= max_queued_stdin_bytes
                    const used = session.stdin_queued_bytes + session.stdin_credit_inflight;
                    if (data_len > 0 and used < max_queued_stdin_bytes) {
                        const free = max_queued_stdin_bytes - used;
                        grant = @min(data_len, free);
                        session.stdin_credit_inflight += grant;
                    }

                    session.control_cv.signal();
                    session.mutex.unlock();

                    if (grant > 0) {
                        _ = session.tx.sendStdinWindow(session.allocator, req.id, @intCast(grant)) catch {};
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
                        stdout_credit = @min(max_stdout_credit, stdout_credit + add);
                    }
                    if (win.stderr > 0) {
                        const add: usize = @intCast(win.stderr);
                        stderr_credit = @min(max_stderr_credit, stderr_credit + add);
                    }
                },
            }
        }
        local_controls.clearRetainingCapacity();

        if (status != null and !stdout_open and !stderr_open) break;

        var pollfds: [3]std.posix.pollfd = undefined;
        var nfds: usize = 0;
        var stdout_index: ?usize = null;
        var stderr_index: ?usize = null;
        var wake_index: ?usize = null;

        const stdout_can_read = stdout_credit > 0;
        const stderr_can_read = stderr_credit > 0;

        if (use_pty and pty_master != null and pty_close_deadline_ms != null) {
            const now_ms = std.time.milliTimestamp();
            const deadline_ms = pty_close_deadline_ms.?;

            var should_close = now_ms >= deadline_ms;
            if (!should_close) {
                if (pty_exit_drain_remaining) |rem| {
                    if (rem == 0) should_close = true;
                }
            }

            if (should_close) {
                const fd = pty_master.?;
                std.posix.close(fd);
                pty_master = null;

                stdout_fd = null;
                stdin_fd = null;
                stdout_open = false;
                stdin_open = false;
            }
        }

        if (stdout_open and stdout_hup_seen and !stdout_can_read) {
            if (stdout_fd) |fd| {
                if (bytesAvailable(fd)) |avail| {
                    if (avail == 0) {
                        stdout_open = false;
                        std.posix.close(fd);
                        stdout_fd = null;
                        if (use_pty) {
                            pty_master = null;
                            if (stdin_fd != null) {
                                stdin_fd = null;
                                stdin_open = false;
                            }
                        }
                    }
                }
            }
        }
        if (stderr_open and stderr_hup_seen and !stderr_can_read) {
            if (stderr_fd) |fd| {
                if (bytesAvailable(fd)) |avail| {
                    if (avail == 0) {
                        stderr_open = false;
                        std.posix.close(fd);
                        stderr_fd = null;
                    }
                }
            }
        }

        if (stdout_open) {
            const can_read = stdout_can_read;
            if (can_read or !stdout_hup_seen) {
                stdout_index = nfds;
                const events: i16 = if (can_read) std.posix.POLL.IN else 0;
                pollfds[nfds] = .{ .fd = stdout_fd.?, .events = events, .revents = 0 };
                nfds += 1;
            }
        }
        if (stderr_open) {
            const can_read = stderr_can_read;
            if (can_read or !stderr_hup_seen) {
                stderr_index = nfds;
                const events: i16 = if (can_read) std.posix.POLL.IN else 0;
                pollfds[nfds] = .{ .fd = stderr_fd.?, .events = events, .revents = 0 };
                nfds += 1;
            }
        }

        if (session.wake_read_fd) |wake_fd| {
            wake_index = nfds;
            pollfds[nfds] = .{ .fd = wake_fd, .events = std.posix.POLL.IN, .revents = 0 };
            nfds += 1;
        }

        if (nfds > 0) {
            _ = try std.posix.poll(pollfds[0..nfds], 100);
        } else {
            if (status == null) {
                const res = std.posix.waitpid(pid, std.posix.W.NOHANG);
                if (res.pid != 0) {
                    status = res.status;
                } else {
                    // Avoid a tight busy loop when the child stays alive after
                    // closing stdout/stderr early.
                    std.posix.nanosleep(0, 1 * std.time.ns_per_ms);
                }
            } else {
                // The child is already dead. If output remains but credits are
                // exhausted, wait until new control messages arrive.
                session.mutex.lock();
                _ = session.control_cv.timedWait(&session.mutex, 10 * std.time.ns_per_ms) catch {};
                session.mutex.unlock();
            }
            continue;
        }

        if (wake_index) |windex| {
            const revents = pollfds[windex].revents;
            if ((revents & (std.posix.POLL.IN | std.posix.POLL.HUP | std.posix.POLL.ERR)) != 0) {
                drainExecWakeFd(pollfds[windex].fd);
            }
        }

        if (stdout_index) |sindex| {
            const revents = pollfds[sindex].revents;
            if ((revents & std.posix.POLL.HUP) != 0) stdout_hup_seen = true;

            if (stdout_credit > 0 and (revents & (std.posix.POLL.IN | std.posix.POLL.HUP)) != 0) {
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
                    if (use_pty) {
                        pty_master = null;
                        if (stdin_fd != null) {
                            stdin_fd = null;
                            stdin_open = false;
                        }
                    }
                } else {
                    if (use_pty and pty_exit_drain_remaining != null) {
                        const rem = pty_exit_drain_remaining.?;
                        pty_exit_drain_remaining = if (n >= rem) 0 else rem - n;
                    }

                    stdout_credit -= n;
                    const payload = try protocol.encodeExecOutput(session.allocator, req.id, "stdout", buffer[0..n]);
                    defer session.allocator.free(payload);
                    try session.tx.sendPayload(payload);
                }
            } else if ((revents & std.posix.POLL.HUP) != 0) {
                if (stdout_fd) |fd| {
                    if (bytesAvailable(fd)) |avail| {
                        if (avail == 0) {
                            stdout_open = false;
                            std.posix.close(fd);
                            stdout_fd = null;
                            if (use_pty) {
                                pty_master = null;
                                if (stdin_fd != null) {
                                    stdin_fd = null;
                                    stdin_open = false;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (stderr_index) |sindex| {
            const revents = pollfds[sindex].revents;
            if ((revents & std.posix.POLL.HUP) != 0) stderr_hup_seen = true;

            if (stderr_credit > 0 and (revents & (std.posix.POLL.IN | std.posix.POLL.HUP)) != 0) {
                const max_read: usize = @min(buffer.len, stderr_credit);
                const n = try std.posix.read(stderr_fd.?, buffer[0..max_read]);
                if (n == 0) {
                    stderr_open = false;
                    if (stderr_fd) |fd| std.posix.close(fd);
                    stderr_fd = null;
                } else {
                    stderr_credit -= n;
                    const payload = try protocol.encodeExecOutput(session.allocator, req.id, "stderr", buffer[0..n]);
                    defer session.allocator.free(payload);
                    try session.tx.sendPayload(payload);
                }
            } else if ((revents & std.posix.POLL.HUP) != 0) {
                if (stderr_fd) |fd| {
                    if (bytesAvailable(fd)) |avail| {
                        if (avail == 0) {
                            stderr_open = false;
                            std.posix.close(fd);
                            stderr_fd = null;
                        }
                    }
                }
            }
        }

        if (status == null) {
            const res = std.posix.waitpid(pid, std.posix.W.NOHANG);
            if (res.pid != 0) {
                status = res.status;

                if (use_pty and pty_master != null and pty_close_deadline_ms == null) {
                    pty_close_deadline_ms = std.time.milliTimestamp() + 250;
                    pty_exit_drain_remaining = 64 * 1024;
                }
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
    const response = try protocol.encodeExecResponse(session.allocator, req.id, term.exit_code, term.signal);
    defer session.allocator.free(response);
    try session.tx.sendPayload(response);
}

fn bytesAvailable(fd: std.posix.fd_t) ?usize {
    var n: c_int = 0;

    // ioctl(FIONREAD) can fail transiently (e.g. EINTR).  If it fails we return
    // null (unknown) rather than guessing drained/not-drained, to avoid output
    // truncation.
    var attempts: usize = 0;
    while (true) : (attempts += 1) {
        const rc = c.ioctl(fd, c.FIONREAD, &n);
        if (rc == 0) break;
        const err = std.posix.errno(rc);
        if (err == .INTR and attempts < 3) continue;
        return null;
    }

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
