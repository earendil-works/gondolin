//! sandboxd: the guest supervisor (PID 1).
//!
//! Serves the `virtio-port` control channel: runs commands (`exec_*`), moves
//! files in and out of the guest (`file_*`), sets the clock (`time_sync`) and
//! reports the VFS mount status once at startup (`vfs_ready`/`vfs_error`).
//!
//! Architecture: one thread, one `poll(2)` loop.  Each iteration polls
//!   - the virtio port (input always, output while the outbox is non-empty),
//!   - a signalfd for SIGCHLD (child exits; as PID 1 we also reap orphans),
//!   - every exec session's stdout/stderr/stdin fds (subject to flow control),
//! with a timeout derived from pty drain deadlines, pending file reads and
//! the virtio reconnect probe.  All output goes through one `Outbox`; while it
//! holds more than `outbox_high_water` bytes no child output or file data is
//! read, so a slow host backs up into pipes instead of guest memory.

const std = @import("std");
const shared = @import("shared");
const exec = @import("exec.zig");
const file_requests = @import("file_requests.zig");

const sys = shared.sys;
const protocol = shared.protocol;
const Channel = shared.channel.Channel;
const Outbox = shared.framing.Outbox;
const Allocator = std.mem.Allocator;

pub const std_options = shared.runtime.std_options;
pub const panic = shared.runtime.panic;

const log = std.log.scoped(.sandboxd);

/// Outbox size above which no new child output or file data is produced, in `bytes`
const outbox_high_water: usize = 1024 * 1024;
/// File written by init when the sandboxfs mount failed
const vfs_failed_path = "/run/sandboxfs.failed";

test {
    _ = exec;
    _ = file_requests;
}

pub fn main(init: std.process.Init.Minimal) !void {
    shared.runtime.init();
    ensureStdio();
    const gpa = shared.runtime.gpa();
    defer shared.runtime.deinitGpa();

    log.info("starting", .{});
    const fd = try shared.virtio_port.open("virtio-port", .nonblocking);
    log.info("opened virtio port", .{});

    // SIGCHLD is consumed through a signalfd; the original mask is restored
    // in children before exec.
    const sigmask = sys.blockSignal(.CHLD);
    const sigchld_fd = try sys.signalfd(.CHLD);
    defer sys.close(sigchld_fd);

    var daemon: Daemon = .{
        .gpa = gpa,
        .channel = .initPort(gpa, fd, "virtio-port"),
        .sigchld_fd = sigchld_fd,
        .spawn_ctx = .{ .environ = init.environ.block.slice.ptr, .sigmask = sigmask },
        .transfers = .init(gpa, "/"),
        .arena = .init(gpa),
    };
    defer daemon.deinit();
    // the channel may replace its fd when it reconnects (vsock)
    defer sys.close(daemon.channel.fd);

    daemon.sendVfsStatus();
    try daemon.run();
}

/// Make sure fds 0-2 are open so that pipes created later never land on
/// them (dup2 onto the same fd would keep CLOEXEC and lose the stream).
fn ensureStdio() void {
    while (true) {
        const fd = sys.openZ("/dev/null", .{ .ACCMODE = .RDWR }, 0) catch return;
        if (fd > sys.stderr_fd) return sys.close(fd);
        // Deliberately leaked: it now serves as stdin/stdout/stderr.
        sys.setCloexec(fd, false);
    }
}

const Daemon = struct {
    gpa: Allocator,
    channel: Channel,
    sigchld_fd: sys.fd_t,
    spawn_ctx: exec.SpawnContext,
    transfers: file_requests.Transfers,
    sessions: std.array_hash_map.Auto(u32, *exec.Session) = .empty,
    /// per-frame decode arena
    arena: std.heap.ArenaAllocator,
    /// shared read buffer for child output
    read_buf: [exec.output_chunk]u8 = undefined,

    fn deinit(self: *Daemon) void {
        for (self.sessions.values()) |session| self.destroySession(session);
        self.sessions.deinit(self.gpa);
        self.transfers.deinit();
        self.channel.deinit(self.gpa);
        self.arena.deinit();
    }

    fn outbox(self: *Daemon) *Outbox {
        return &self.channel.outbox;
    }

    fn readAllowed(self: *Daemon) bool {
        return self.outbox().pending() < outbox_high_water;
    }

    const Source = union(enum) {
        virtio,
        sigchld,
        session: struct { id: u32, kind: exec.Session.PollKind },
    };

    fn run(self: *Daemon) !void {
        var fds: std.ArrayList(sys.pollfd) = .empty;
        defer fds.deinit(self.gpa);
        var sources: std.ArrayList(Source) = .empty;
        defer sources.deinit(self.gpa);
        var kinds: std.ArrayList(exec.Session.PollKind) = .empty;
        defer kinds.deinit(self.gpa);

        while (true) {
            fds.clearRetainingCapacity();
            sources.clearRetainingCapacity();
            const read_allowed = self.readAllowed();

            if (self.channel.pollEvents()) |events| {
                try fds.append(self.gpa, .{ .fd = self.channel.fd, .events = events, .revents = 0 });
                try sources.append(self.gpa, .virtio);
            }
            try fds.append(self.gpa, .{ .fd = self.sigchld_fd, .events = sys.POLL.IN, .revents = 0 });
            try sources.append(self.gpa, .sigchld);
            for (self.sessions.keys(), self.sessions.values()) |id, session| {
                kinds.clearRetainingCapacity();
                _ = try session.addPollFds(self.gpa, &fds, &kinds, read_allowed);
                for (kinds.items) |kind| try sources.append(self.gpa, .{ .session = .{ .id = id, .kind = kind } });
            }

            _ = try sys.poll(fds.items, self.pollTimeout());

            for (fds.items, sources.items) |pfd, source| {
                if (pfd.revents == 0) continue;
                switch (source) {
                    .virtio => try self.onVirtioReady(pfd.revents),
                    .sigchld => self.reapChildren(),
                    .session => |s| {
                        // The session may have been removed by an earlier entry.
                        const session = self.sessions.get(s.id) orelse continue;
                        try session.onReady(s.kind, pfd.revents, self.outbox(), self.readAllowed(), &self.read_buf);
                    },
                }
            }

            _ = self.channel.probeReconnect();
            if (self.readAllowed()) try self.transfers.pumpReads(self.outbox());
            try self.finishSessions();
            _ = self.channel.flush();
        }
    }

    fn pollTimeout(self: *Daemon) i32 {
        if (self.transfers.hasPendingReads() and self.readAllowed()) return 0;
        var timeout: i32 = -1;
        if (!self.channel.connected) timeout = shared.channel.reconnect_poll_ms;
        const now = sys.monotonicMs();
        for (self.sessions.values()) |session| {
            const deadline = session.deadline() orelse continue;
            const wait: i32 = @intCast(@min(deadline -| now, std.math.maxInt(i32)));
            if (timeout < 0 or wait < timeout) timeout = wait;
        }
        return timeout;
    }

    /// Reap every exited child.  Unknown pids are orphans re-parented to us.
    fn reapChildren(self: *Daemon) void {
        sys.drainSignalfd(self.sigchld_fd);
        const now = sys.monotonicMs();
        while (sys.reapAny()) |child| {
            for (self.sessions.values()) |session| {
                if (session.pid == child.pid and session.status == null) {
                    session.onExit(child.status, now);
                    break;
                }
            }
        }
    }

    /// Enforce pty deadlines, announce stdin credit and complete sessions.
    fn finishSessions(self: *Daemon) Outbox.Error!void {
        const now = sys.monotonicMs();
        var i: usize = self.sessions.count();
        while (i > 0) {
            i -= 1;
            const session = self.sessions.values()[i];
            session.checkDeadline(now);
            try session.flushStdinGrant(self.outbox());
            if (!session.isDone()) continue;
            try self.outbox().send(.exec_response, session.id, session.termination());
            log.debug("exec {d} finished", .{session.id});
            self.sessions.swapRemoveAt(i);
            self.destroySession(session);
        }
    }

    fn destroySession(self: *Daemon, session: *exec.Session) void {
        session.deinit();
        self.gpa.destroy(session);
    }

    // -- virtio input -------------------------------------------------------

    fn onVirtioReady(self: *Daemon, revents: i16) !void {
        switch (try self.channel.onReady(self.gpa, revents)) {
            .ok, .disconnected => {},
        }
        while (true) {
            const frame = self.channel.reader.next() catch |err| {
                log.err("dropping frame: {t}", .{err});
                continue;
            } orelse break;
            defer _ = self.arena.reset(.retain_capacity);
            try self.handleFrame(frame);
        }
    }

    fn sendError(self: *Daemon, id: u32, code: []const u8, message: []const u8) Outbox.Error!void {
        try self.outbox().send(.@"error", id, .{ .code = code, .message = message });
    }

    fn handleFrame(self: *Daemon, frame: []const u8) Outbox.Error!void {
        const arena = self.arena.allocator();
        const env = protocol.Envelope.decode(arena, frame) catch |err| {
            log.warn("invalid message: {t}", .{err});
            return self.sendError(0, "invalid_request", "invalid message");
        };
        const tag = env.tag() orelse return self.sendError(0, "invalid_request", "unsupported request type");
        switch (tag) {
            .time_sync => {
                const id, const req = parse(env, arena, .time_sync) catch
                    return self.sendError(0, "invalid_request", "invalid time_sync");
                if (req.unix_ms > std.math.maxInt(i64)) return self.sendError(id, "invalid_request", "invalid unix_ms");
                sys.setRealtimeMs(req.unix_ms) catch |err| {
                    log.err("clock_settime failed: {t}", .{err});
                    return self.sendError(id, "time_sync_failed", "clock_settime failed");
                };
                try self.outbox().send(.time_sync_done, id, .{});
            },
            .exec_request => {
                const id, const req = parse(env, arena, .exec_request) catch
                    return self.sendError(0, "invalid_request", "invalid exec_request");
                self.startExec(id, req) catch |err| {
                    log.err("exec {d} failed to start: {t}", .{ id, err });
                    return self.sendError(id, "exec_failed", "failed to execute");
                };
            },
            inline .stdin_data, .pty_resize, .exec_window, .exec_signal => |input_tag| {
                const id, const input = parse(env, arena, input_tag) catch
                    return self.sendError(0, "invalid_request", "invalid exec input");
                const session = self.sessions.get(id) orelse
                    return self.sendError(id, "unknown_id", "request id not found");
                switch (input_tag) {
                    .stdin_data => session.pushStdin(input.data.data, input.eof) catch |err| switch (err) {
                        error.StdinBackpressure => return self.sendError(id, "stdin_backpressure", "stdin queue full"),
                        error.StdinChunkTooLarge => return self.sendError(id, "stdin_chunk_too_large", "stdin chunk exceeds queue limit"),
                        error.OutOfMemory => return self.sendError(id, "exec_failed", "failed to queue exec input"),
                    },
                    .pty_resize => session.resize(input),
                    .exec_window => session.addOutputCredit(input),
                    .exec_signal => session.signal(input.signal) catch
                        return self.sendError(id, "invalid_request", "invalid signal"),
                    else => comptime unreachable,
                }
            },
            .file_read_request => {
                const id, const req = parse(env, arena, .file_read_request) catch
                    return self.sendError(0, "invalid_request", "invalid file_read_request");
                self.transfers.startRead(id, req) catch |err|
                    return self.sendError(id, "file_read_failed", @errorName(err));
            },
            .file_write_request => {
                const id, const req = parse(env, arena, .file_write_request) catch
                    return self.sendError(0, "invalid_request", "invalid file_write_request");
                self.transfers.startWrite(id, req) catch |err|
                    return self.sendError(id, "file_write_failed", @errorName(err));
            },
            .file_write_data => {
                const id = env.id() catch return self.sendError(0, "invalid_request", "unsupported request type");
                if (!self.transfers.isWriting(id)) return self.sendError(0, "invalid_request", "unsupported request type");
                const chunk = env.payload(arena, .file_write_data) catch |err| {
                    self.transfers.abortWrite(id);
                    return self.sendError(id, "file_write_failed", @errorName(err));
                };
                const result = self.transfers.writeData(id, chunk) catch |err|
                    return self.sendError(id, "file_write_failed", @errorName(err));
                if (result == .done) try self.outbox().send(.file_write_done, id, .{});
            },
            .file_delete_request => {
                const id, const req = parse(env, arena, .file_delete_request) catch
                    return self.sendError(0, "invalid_request", "invalid file_delete_request");
                self.transfers.delete(req) catch |err|
                    return self.sendError(id, "file_delete_failed", @errorName(err));
                try self.outbox().send(.file_delete_done, id, .{});
            },
            else => return self.sendError(0, "invalid_request", "unsupported request type"),
        }
    }

    fn startExec(self: *Daemon, id: u32, req: protocol.ExecRequest) !void {
        log.debug("exec {d}: {s}", .{ id, req.cmd });
        if (self.sessions.contains(id)) return error.DuplicateRequestId;
        try self.sessions.ensureUnusedCapacity(self.gpa, 1);
        const session = try exec.spawn(self.gpa, &self.spawn_ctx, id, req);
        self.sessions.putAssumeCapacity(id, session);
    }

    fn sendVfsStatus(self: *Daemon) void {
        self.trySendVfsStatus() catch |err| log.err("failed to send vfs status: {t}", .{err});
    }

    fn trySendVfsStatus(self: *Daemon) !void {
        const message = try readVfsError(self.gpa) orelse
            return self.outbox().send(.vfs_ready, 0, .{ .features = protocol.features });
        defer self.gpa.free(message);
        const detail = std.mem.trim(u8, message, " \r\n\t");
        try self.outbox().send(.vfs_error, 0, .{
            .message = if (detail.len > 0) detail else "vfs mount not ready",
            .features = protocol.features,
        });
    }
};

/// Parse `id` and the payload of an incoming message.
fn parse(env: protocol.Envelope, arena: Allocator, comptime tag: protocol.Tag) !struct { u32, protocol.Payload(tag) } {
    return .{ try env.id(), try env.payload(arena, tag) };
}

/// Contents of the sandboxfs failure marker (at most 4 KiB), or null when
/// the mount succeeded.
fn readVfsError(gpa: Allocator) !?[]u8 {
    const fd = sys.openZ(vfs_failed_path, .{ .ACCMODE = .RDONLY }, 0) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
    defer sys.close(fd);
    const buf = try gpa.alloc(u8, 4096);
    errdefer gpa.free(buf);
    var len: usize = 0;
    while (len < buf.len) {
        const n = try sys.read(fd, buf[len..]);
        if (n == 0) break;
        len += n;
    }
    return try gpa.realloc(buf, len);
}
