const std = @import("std");
const protocol = @import("sandboxd").protocol;
const file_requests = @import("file_requests.zig");
const c = @cImport({
    @cInclude("pty.h");
    @cInclude("unistd.h");
    @cInclude("errno.h");
    @cInclude("spawn.h");
    @cInclude("fcntl.h");
    @cInclude("sys/ioctl.h");
});

const log = std.log.scoped(.sandboxd);

pub const std_options: std.Options = .{
    .log_level = .err,
};

/// max buffered stdin per exec session in `bytes`
const max_queued_stdin_bytes: usize = 4 * 1024 * 1024;
/// fallback heap pool used when libc allocator is unavailable in constrained runtimes
const fallback_allocator_pool_size: usize = 32 * 1024 * 1024;

var fallback_allocator_pool: [fallback_allocator_pool_size]u8 = undefined;

const TransportMode = enum {
    virtio,
    stdio,
};

const RuntimeConfig = struct {
    transport: TransportMode = .virtio,
};

const TransportHandles = struct {
    rx_fd: std.posix.fd_t,
    tx_fd: std.posix.fd_t,
    file: ?std.fs.File = null,

    fn deinit(self: *TransportHandles) void {
        if (self.file) |owned| {
            owned.close();
            self.file = null;
        }
    }
};

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
    stdio_transport: bool = false,
    mutex: std.Thread.Mutex = .{},

    pub fn sendPayload(self: *VirtioTx, payload: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.stdio_transport) {
            try protocol.writeStdioEnvelopePayload(self.fd, payload);
        } else {
            try protocol.writeFrame(self.fd, payload);
        }
    }

    fn sendError(self: *VirtioTx, allocator: std.mem.Allocator, id: u32, code: []const u8, message: []const u8) !void {
        const payload = try protocol.encodeError(allocator, id, code, message);
        defer allocator.free(payload);
        try self.sendPayload(payload);
    }

    fn sendStdinWindow(self: *VirtioTx, allocator: std.mem.Allocator, id: u32, stdin: u32) !void {
        const payload = try protocol.encodeStdinWindow(allocator, id, stdin);
        defer allocator.free(payload);
        try self.sendPayload(payload);
    }

    fn sendVfsReady(self: *VirtioTx, allocator: std.mem.Allocator) !void {
        const payload = try protocol.encodeVfsReady(allocator);
        defer allocator.free(payload);
        try self.sendPayload(payload);
    }

    fn sendVfsError(self: *VirtioTx, allocator: std.mem.Allocator, message: []const u8) !void {
        const payload = try protocol.encodeVfsError(allocator, message);
        defer allocator.free(payload);
        try self.sendPayload(payload);
    }
};

const FsRpcProxy = struct {
    allocator: std.mem.Allocator,
    tx: *VirtioTx,
    socket_path: []u8,
    listener_fd: ?std.posix.fd_t = null,
    client_fd: ?std.posix.fd_t = null,
    mutex: std.Thread.Mutex = .{},
    stop_requested: bool = false,
    thread: ?std.Thread = null,

    fn init(allocator: std.mem.Allocator, tx: *VirtioTx, socket_path: []const u8) !FsRpcProxy {
        const owned_socket_path = try allocator.dupe(u8, socket_path);
        errdefer allocator.free(owned_socket_path);

        std.fs.deleteFileAbsolute(owned_socket_path) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        };

        const listener_fd = try std.posix.socket(
            std.posix.AF.UNIX,
            std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC,
            0,
        );
        errdefer std.posix.close(listener_fd);

        const address = try std.net.Address.initUnix(owned_socket_path);
        try std.posix.bind(listener_fd, &address.any, address.getOsSockLen());
        errdefer std.fs.deleteFileAbsolute(owned_socket_path) catch {};

        try std.posix.listen(listener_fd, 1);

        return FsRpcProxy{
            .allocator = allocator,
            .tx = tx,
            .socket_path = owned_socket_path,
            .listener_fd = listener_fd,
        };
    }

    fn start(self: *FsRpcProxy) !void {
        self.thread = try std.Thread.spawn(.{}, fsRpcProxyMain, .{self});
    }

    fn deinit(self: *FsRpcProxy) void {
        self.mutex.lock();
        self.stop_requested = true;

        const listener_fd = self.listener_fd;
        self.listener_fd = null;

        const client_fd = self.client_fd;
        self.client_fd = null;
        self.mutex.unlock();

        if (client_fd) |fd| std.posix.close(fd);
        if (listener_fd) |fd| std.posix.close(fd);

        if (self.thread) |thread| {
            thread.join();
            self.thread = null;
        }

        std.fs.deleteFileAbsolute(self.socket_path) catch {};
        self.allocator.free(self.socket_path);
    }

    fn sendResponse(self: *FsRpcProxy, frame: []const u8) bool {
        self.mutex.lock();
        const client_fd = self.client_fd;
        self.mutex.unlock();

        if (client_fd == null) return false;

        protocol.writeFrame(client_fd.?, frame) catch {
            self.closeClient(client_fd.?);
            return false;
        };

        return true;
    }

    fn isStopping(self: *FsRpcProxy) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.stop_requested;
    }

    fn setClient(self: *FsRpcProxy, fd: std.posix.fd_t) void {
        self.mutex.lock();
        defer self.mutex.unlock();

        if (self.client_fd) |current| std.posix.close(current);
        self.client_fd = fd;
    }

    fn closeClient(self: *FsRpcProxy, fd: std.posix.fd_t) void {
        self.mutex.lock();
        defer self.mutex.unlock();

        if (self.client_fd) |current| {
            if (current == fd) {
                std.posix.close(current);
                self.client_fd = null;
            }
        }
    }
};

fn fsRpcProxyMain(proxy: *FsRpcProxy) void {
    while (!proxy.isStopping()) {
        const listener_fd = blk: {
            proxy.mutex.lock();
            defer proxy.mutex.unlock();
            break :blk proxy.listener_fd orelse return;
        };

        const client_fd = std.posix.accept(listener_fd, null, null, std.posix.SOCK.CLOEXEC) catch {
            if (proxy.isStopping()) return;
            continue;
        };

        proxy.setClient(client_fd);

        while (!proxy.isStopping()) {
            const frame = protocol.readFrame(std.heap.page_allocator, client_fd) catch {
                break;
            };
            defer std.heap.page_allocator.free(frame);

            proxy.tx.sendPayload(frame) catch {
                break;
            };
        }

        proxy.closeClient(client_fd);
    }
}

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

fn parseTransportMode(value: []const u8) ?TransportMode {
    if (std.mem.eql(u8, value, "virtio")) return .virtio;
    if (std.mem.eql(u8, value, "stdio")) return .stdio;
    return null;
}

fn writeUsage() void {
    std.debug.print(
        "usage: sandboxd [--transport=virtio|stdio]\n" ++
            "\n" ++
            "  --transport=virtio   use /dev/virtio-ports/virtio-port (default)\n" ++
            "  --transport=stdio    use framed protocol over stdin/stdout\n",
        .{},
    );
}

const CliError = error{
    ShowUsage,
    InvalidArgument,
    Overflow,
};

fn parseRuntimeConfig() CliError!RuntimeConfig {
    var config = RuntimeConfig{};
    var args = std.process.args();
    _ = args.next(); // argv[0]

    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "-h") or std.mem.eql(u8, arg, "--help")) {
            writeUsage();
            return error.ShowUsage;
        }

        if (std.mem.startsWith(u8, arg, "--transport=")) {
            const mode_text = arg["--transport=".len..];
            config.transport = parseTransportMode(mode_text) orelse {
                log.err("invalid transport mode: {s}", .{mode_text});
                return error.InvalidArgument;
            };
            continue;
        }

        log.err("unknown argument: {s}", .{arg});
        return error.InvalidArgument;
    }

    return config;
}

fn parseEnvBool(value: []const u8) bool {
    if (value.len == 0) return false;
    if (std.mem.eql(u8, value, "1")) return true;
    if (std.mem.eql(u8, value, "true")) return true;
    if (std.mem.eql(u8, value, "TRUE")) return true;
    if (std.mem.eql(u8, value, "yes")) return true;
    if (std.mem.eql(u8, value, "YES")) return true;
    if (std.mem.eql(u8, value, "on")) return true;
    if (std.mem.eql(u8, value, "ON")) return true;
    return false;
}

fn openTransport(mode: TransportMode) !TransportHandles {
    return switch (mode) {
        .virtio => blk: {
            const virtio = try openVirtioPort();
            break :blk .{
                .rx_fd = virtio.handle,
                .tx_fd = virtio.handle,
                .file = virtio,
            };
        },
        .stdio => .{
            .rx_fd = std.posix.STDIN_FILENO,
            .tx_fd = std.posix.STDOUT_FILENO,
            .file = null,
        },
    };
}

const StdioTerminalState = struct {
    original: ?std.posix.termios = null,

    fn enableRawMode() !StdioTerminalState {
        if (!std.posix.isatty(std.posix.STDIN_FILENO)) {
            return .{};
        }

        const original = std.posix.tcgetattr(std.posix.STDIN_FILENO) catch |err| switch (err) {
            error.NotATerminal => return .{},
            else => return error.Unexpected,
        };

        var raw = original;

        // cfmakeraw-style terminal settings for binary frame transport.
        raw.iflag.BRKINT = false;
        raw.iflag.PARMRK = false;
        raw.iflag.ISTRIP = false;
        raw.iflag.INLCR = false;
        raw.iflag.IGNCR = false;
        raw.iflag.ICRNL = false;
        raw.iflag.IXON = false;
        raw.iflag.IXOFF = false;
        raw.iflag.IXANY = false;

        raw.oflag.OPOST = false;

        raw.lflag.ECHO = false;
        raw.lflag.ECHONL = false;
        raw.lflag.ICANON = false;
        raw.lflag.ISIG = false;
        raw.lflag.IEXTEN = false;

        raw.cflag.CSIZE = .CS8;
        raw.cflag.PARENB = false;

        raw.cc[@intFromEnum(std.posix.V.MIN)] = 1;
        raw.cc[@intFromEnum(std.posix.V.TIME)] = 0;

        try std.posix.tcsetattr(std.posix.STDIN_FILENO, .NOW, raw);

        return .{ .original = original };
    }

    fn restore(self: *StdioTerminalState) void {
        if (self.original) |original| {
            std.posix.tcsetattr(std.posix.STDIN_FILENO, .NOW, original) catch {};
            self.original = null;
        }
    }
};

pub fn main() !void {
    var fixed_buffer_allocator = std.heap.FixedBufferAllocator.init(&fallback_allocator_pool);
    var fixed_threadsafe_allocator = std.heap.ThreadSafeAllocator{
        .child_allocator = fixed_buffer_allocator.allocator(),
    };

    var allocator: std.mem.Allocator = std.heap.c_allocator;
    const probe = allocator.alloc(u8, 64) catch |err| switch (err) {
        error.OutOfMemory => blk: {
            allocator = fixed_threadsafe_allocator.allocator();
            const fallback_probe = try allocator.alloc(u8, 64);
            allocator.free(fallback_probe);
            log.warn("libc allocator unavailable; using fixed fallback allocator", .{});
            break :blk null;
        },
    };
    if (probe) |memory| {
        allocator.free(memory);
    }

    const config = parseRuntimeConfig() catch |err| switch (err) {
        error.ShowUsage => return,
        else => return err,
    };

    // Keep an escape hatch for debugging stdio transport failures.
    const stdio_debug_logs = std.posix.getenv("GONDOLIN_SANDBOXD_STDIO_DEBUG") != null;
    @import("sandboxd").setRuntimeLogsEnabled(config.transport != .stdio or stdio_debug_logs);

    log.info("starting", .{});

    var transport = try openTransport(config.transport);
    defer transport.deinit();

    var stdio_terminal_state = StdioTerminalState{};
    if (config.transport == .stdio) {
        stdio_terminal_state = StdioTerminalState.enableRawMode() catch |err| {
            log.err("failed to configure stdio terminal mode: {s}", .{@errorName(err)});
            return err;
        };
    }
    defer stdio_terminal_state.restore();

    var tx = VirtioTx{
        .fd = transport.tx_fd,
        .stdio_transport = config.transport == .stdio,
    };

    var env_map = try std.process.getEnvMap(allocator);
    defer env_map.deinit();

    const wait_vfs_status = if (env_map.get("GONDOLIN_SANDBOXFS_STATUS_WAIT")) |value|
        parseEnvBool(value)
    else
        false;

    var fs_rpc_proxy: ?FsRpcProxy = null;
    defer if (fs_rpc_proxy) |*proxy| {
        proxy.deinit();
    };

    if (env_map.get("GONDOLIN_SANDBOXFS_RPC_SOCKET")) |socket_path| {
        if (socket_path.len > 0) {
            fs_rpc_proxy = try FsRpcProxy.init(allocator, &tx, socket_path);
            if (fs_rpc_proxy) |*proxy| {
                try proxy.start();
            }
        }
    }

    log.info("transport mode={s}", .{@tagName(config.transport)});
    if (config.transport == .virtio) {
        log.info("opened virtio port", .{});
    }

    sendVfsStatus(allocator, &tx, wait_vfs_status) catch |err| {
        log.err("failed to send vfs status: {s}", .{@errorName(err)});
    };

    const fs_rpc_proxy_ptr: ?*FsRpcProxy = if (fs_rpc_proxy) |*proxy| proxy else null;
    try runMessageLoop(allocator, transport.rx_fd, &tx, config.transport, fs_rpc_proxy_ptr);
}

fn runMessageLoop(
    allocator: std.mem.Allocator,
    rx_fd: std.posix.fd_t,
    tx: *VirtioTx,
    mode: TransportMode,
    fs_rpc_proxy: ?*FsRpcProxy,
) !void {
    var exec_sessions = std.AutoHashMap(u32, *ExecSession).init(allocator);
    defer cleanupAllExecSessions(allocator, &exec_sessions);

    var waiting_for_reconnect = false;

    while (true) {
        cleanupFinishedExecSessions(allocator, &exec_sessions);

        const frame = (switch (mode) {
            .stdio => protocol.readStdioFramePayload(allocator, rx_fd),
            .virtio => protocol.readFrame(allocator, rx_fd),
        }) catch |err| {
            if (err == error.EndOfStream) {
                switch (mode) {
                    .virtio => {
                        if (!waiting_for_reconnect) {
                            log.info("virtio port closed, waiting for reconnect", .{});
                            waiting_for_reconnect = true;
                        }
                        waitForVirtioData(rx_fd);
                        continue;
                    },
                    .stdio => {
                        log.info("stdio stream closed", .{});
                        return;
                    },
                }
            }
            log.err("failed to read frame: {s}", .{@errorName(err)});
            continue;
        };
        defer allocator.free(frame);

        waiting_for_reconnect = false;
        log.info("received frame ({} bytes)", .{frame.len});

        if (fs_rpc_proxy) |proxy| {
            const meta = protocol.decodeFrameMeta(allocator, frame) catch null;
            if (meta) |decoded| {
                if (std.mem.eql(u8, decoded.msg_type, "fs_response")) {
                    _ = proxy.sendResponse(frame);
                    continue;
                }
            }
        }

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

            startExecSession(allocator, &exec_sessions, tx, req) catch |err| {
                log.err("exec start failed: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, req.id, "exec_failed", @errorName(err)) catch {};
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
            file_requests.handleFileRead(allocator, tx, "/", req) catch |err| {
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
            file_requests.handleFileWrite(allocator, rx_fd, tx, "/", req, mode == .stdio) catch |err| {
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
            file_requests.handleFileDelete(allocator, tx, "/", req) catch |err| {
                log.err("file delete failed: {s}", .{@errorName(err)});
                _ = tx.sendError(allocator, req.id, "file_delete_failed", @errorName(err)) catch {};
            };
            continue;
        }

        _ = tx.sendError(allocator, 0, "invalid_request", "unsupported request type") catch {};
    }
}

fn startExecSession(
    allocator: std.mem.Allocator,
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

    const thread = std.Thread.spawn(.{}, execWorker, .{session}) catch |err| {
        log.warn("thread spawn failed id={}: {s}; falling back to inline exec worker", .{ req.id, @errorName(err) });
        runExecSession(session) catch |run_err| {
            log.err("exec handling failed id={}: {s}", .{ req.id, @errorName(run_err) });
            _ = tx.sendError(allocator, req.id, "exec_failed", @errorName(run_err)) catch {};
        };
        markSessionDone(session);
        return;
    };
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

fn sendVfsStatus(allocator: std.mem.Allocator, tx: *VirtioTx, wait_status: bool) !void {
    if (wait_status) {
        try waitForVfsStatusSentinel();
    }

    if (try readVfsErrorMessage(allocator)) |message| {
        defer allocator.free(message);
        const trimmed = std.mem.trim(u8, message, " \r\n\t");
        const detail = if (trimmed.len > 0) trimmed else "vfs mount not ready";
        try tx.sendVfsError(allocator, detail);
        return;
    }

    if (wait_status and !pathExists("/run/sandboxfs.ready")) {
        try tx.sendVfsError(allocator, "vfs mount not ready");
        return;
    }

    try tx.sendVfsReady(allocator);
}

fn waitForVfsStatusSentinel() !void {
    var attempts: usize = 0;
    while (attempts < 300) : (attempts += 1) {
        if (pathExists("/run/sandboxfs.ready")) return;
        if (pathExists("/run/sandboxfs.failed")) return;
        std.posix.nanosleep(0, 100 * std.time.ns_per_ms);
    }
}

fn pathExists(path: []const u8) bool {
    const file = std.fs.openFileAbsolute(path, .{}) catch return false;
    file.close();
    return true;
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
    var stage: []const u8 = "init";
    errdefer |err| {
        log.err("exec session failed id={} stage={s}: {s}", .{ req.id, stage, @errorName(err) });
    }

    stage = "arena";
    var arena = std.heap.ArenaAllocator.init(session.allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    stage = "argv";
    const argv = try buildArgv(arena_alloc, req.cmd, req.argv);
    stage = "envp";
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
        stage = "forkpty";
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
        stage = "pipe_stdout";
        stdout_pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
        errdefer {
            std.posix.close(stdout_pipe.?[0]);
            std.posix.close(stdout_pipe.?[1]);
        }

        stage = "pipe_stderr";
        stderr_pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
        errdefer {
            std.posix.close(stderr_pipe.?[0]);
            std.posix.close(stderr_pipe.?[1]);
        }

        if (wants_stdin) {
            stage = "pipe_stdin";
            stdin_pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
            errdefer {
                std.posix.close(stdin_pipe.?[0]);
                std.posix.close(stdin_pipe.?[1]);
            }
        }

        stdout_fd = stdout_pipe.?[0];
        stderr_fd = stderr_pipe.?[0];
        if (wants_stdin) stdin_fd = stdin_pipe.?[1];

        stage = "fork";

        var fork_attempts: usize = 0;
        while (true) : (fork_attempts += 1) {
            const raw_fork = c.fork();
            if (raw_fork >= 0) {
                pid = @intCast(raw_fork);
                break;
            }

            const fork_errno: c_int = std.c._errno().*;
            if (fork_errno == c.EAGAIN and fork_attempts < 10) {
                std.posix.nanosleep(0, 10 * std.time.ns_per_ms);
                continue;
            }

            const raw_vfork = c.vfork();
            if (raw_vfork >= 0) {
                pid = @intCast(raw_vfork);
                break;
            }

            var spawn_pid: c.pid_t = 0;
            const spawn_rc = c.posix_spawnp(
                &spawn_pid,
                argv[0].?,
                null,
                null,
                @constCast(@ptrCast(argv)),
                @constCast(@ptrCast(envp)),
            );
            if (spawn_rc == 0) {
                if (spawn_pid <= 0) return error.SpawnInvalidPid;
                pid = @intCast(spawn_pid);
                break;
            }

            if (spawn_rc == c.ENOSYS) return error.SpawnEnosys;
            if (spawn_rc == c.EAGAIN) return error.SpawnEagain;
            if (spawn_rc == c.ENOMEM) return error.SpawnEnomem;
            if (spawn_rc == c.EPERM) return error.SpawnEperm;
            return error.SpawnFailed;
        }

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
            stage = "poll_loop";
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
                const n = std.posix.read(stdout_fd.?, buffer[0..max_read]) catch |err| switch (err) {
                    error.InputOutput => if (use_pty) 0 else return error.StdoutReadFailed,
                    else => return error.StdoutReadFailed,
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
                stage = "read_stderr";
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

const HarnessEnvelope = struct {
    msg_type: []const u8,
    id: u32,
    stdout_data: ?[]const u8 = null,
    exit_code: ?i32 = null,
};

fn encodeExecRequestPayloadForHarness(
    allocator: std.mem.Allocator,
    id: u32,
    cmd: []const u8,
    argv: []const []const u8,
) ![]u8 {
    const cbor = @import("sandboxd").cbor;

    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "exec_request");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 6);
    try cbor.writeText(w, "cmd");
    try cbor.writeText(w, cmd);
    try cbor.writeText(w, "argv");
    try cbor.writeArrayStart(w, argv.len);
    for (argv) |arg| {
        try cbor.writeText(w, arg);
    }
    try cbor.writeText(w, "env");
    try cbor.writeArrayStart(w, 0);
    try cbor.writeText(w, "stdin");
    try cbor.writeBool(w, false);
    try cbor.writeText(w, "pty");
    try cbor.writeBool(w, false);
    try cbor.writeText(w, "stdout_window");
    try cbor.writeUInt(w, 4096);

    return try buf.toOwnedSlice(allocator);
}

fn decodeHarnessEnvelope(allocator: std.mem.Allocator, frame: []const u8) !HarnessEnvelope {
    const cbor = @import("sandboxd").cbor;

    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    defer cbor.freeValue(allocator, root);

    const map = switch (root) {
        .Map => |entries| entries,
        else => return error.InvalidType,
    };

    const msg_type = switch (cbor.getMapValue(map, "t") orelse return error.MissingField) {
        .Text => |text| text,
        else => return error.InvalidType,
    };

    const id = switch (cbor.getMapValue(map, "id") orelse return error.MissingField) {
        .Int => |num| blk: {
            if (num < 0 or num > std.math.maxInt(u32)) return error.InvalidValue;
            break :blk @as(u32, @intCast(num));
        },
        else => return error.InvalidType,
    };

    var envelope = HarnessEnvelope{ .msg_type = msg_type, .id = id };

    if (std.mem.eql(u8, msg_type, "exec_output")) {
        const payload = switch (cbor.getMapValue(map, "p") orelse return error.MissingField) {
            .Map => |entries| entries,
            else => return error.InvalidType,
        };

        const stream = switch (cbor.getMapValue(payload, "stream") orelse return error.MissingField) {
            .Text => |text| text,
            else => return error.InvalidType,
        };
        if (!std.mem.eql(u8, stream, "stdout")) return error.InvalidValue;

        envelope.stdout_data = switch (cbor.getMapValue(payload, "data") orelse return error.MissingField) {
            .Bytes => |bytes| bytes,
            else => return error.InvalidType,
        };
    }

    if (std.mem.eql(u8, msg_type, "exec_response")) {
        const payload = switch (cbor.getMapValue(map, "p") orelse return error.MissingField) {
            .Map => |entries| entries,
            else => return error.InvalidType,
        };

        envelope.exit_code = switch (cbor.getMapValue(payload, "exit_code") orelse return error.MissingField) {
            .Int => |code| @as(i32, @intCast(code)),
            else => return error.InvalidType,
        };
    }

    return envelope;
}

test "stdio transport harness round-trips exec request" {
    const allocator = std.testing.allocator;

    const guest_in = try std.posix.pipe2(.{ .CLOEXEC = true });
    const guest_in_read = guest_in[0];
    var guest_in_write = guest_in[1];
    defer if (guest_in_read >= 0) std.posix.close(guest_in_read);
    defer if (guest_in_write >= 0) std.posix.close(guest_in_write);

    const guest_out = try std.posix.pipe2(.{ .CLOEXEC = true });
    const guest_out_read = guest_out[0];
    var guest_out_write = guest_out[1];
    defer if (guest_out_read >= 0) std.posix.close(guest_out_read);
    defer if (guest_out_write >= 0) std.posix.close(guest_out_write);

    const payload = try encodeExecRequestPayloadForHarness(
        allocator,
        77,
        "/bin/sh",
        &.{ "-lc", "printf hello" },
    );
    defer allocator.free(payload);

    try protocol.writeFrame(guest_in_write, payload);
    std.posix.close(guest_in_write);
    guest_in_write = -1;

    var tx = VirtioTx{ .fd = guest_out_write };
    try runMessageLoop(allocator, guest_in_read, &tx, .stdio, null);

    std.posix.close(guest_out_write);
    guest_out_write = -1;

    var saw_output = false;
    var saw_response = false;

    while (true) {
        const frame = protocol.readFrame(allocator, guest_out_read) catch |err| switch (err) {
            error.EndOfStream => break,
            else => return err,
        };
        defer allocator.free(frame);

        const envelope = try decodeHarnessEnvelope(allocator, frame);
        try std.testing.expectEqual(@as(u32, 77), envelope.id);

        if (std.mem.eql(u8, envelope.msg_type, "exec_output")) {
            saw_output = true;
            try std.testing.expectEqualStrings("hello", envelope.stdout_data.?);
        }

        if (std.mem.eql(u8, envelope.msg_type, "exec_response")) {
            saw_response = true;
            try std.testing.expectEqual(@as(i32, 0), envelope.exit_code.?);
        }
    }

    try std.testing.expect(saw_output);
    try std.testing.expect(saw_response);
}
