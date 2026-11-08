//! Exec sessions: one child process plus its stdio plumbing and flow control.
//!
//! A session is driven entirely by the sandboxd event loop: it contributes
//! poll entries (`addPollFds`), reacts to readiness (`onReady`), to host
//! input (`pushStdin`, `addOutputCredit`, `resize`) and to the child's exit
//! (`onExit`), and reports completion through `isDone`.
//!
//! Output flow control: each of stdout/stderr has a credit counter (initial
//! value from the request, replenished by `exec_window`, capped at
//! `max_output_credit`).  A stream is only read while it has credit, so a slow
//! host consumer backs up into the child's pipe.
//!
//! Stdin flow control: the guest grants credit with `stdin_window`.  The
//! invariant `stdin_queued + stdin_inflight <= max_stdin_queued` bounds the
//! memory used for queued stdin; credit is returned as bytes are written to
//! (or dropped before) the child.

const std = @import("std");
const shared = @import("shared");
const sys = shared.sys;
const protocol = shared.protocol;
const Outbox = shared.framing.Outbox;

const Allocator = std.mem.Allocator;
const log = std.log.scoped(.exec);

/// Maximum stdin bytes buffered per session (and initial stdin credit) in `bytes`
pub const max_stdin_queued: usize = 4 * 1024 * 1024;
/// Upper bound for per-stream output credit in `bytes`
pub const max_output_credit: usize = 16 * 1024 * 1024;
/// Maximum payload of one `exec_output` frame in `bytes`
pub const output_chunk: usize = 8 * 1024;
/// PTY: how long output is still drained after the child exited, in `ms`
pub const pty_exit_grace_ms: u64 = 250;
/// PTY: how many bytes are still drained after the child exited, in `bytes`
pub const pty_exit_drain_bytes: usize = 64 * 1024;

pub const StdinError = error{ StdinChunkTooLarge, StdinBackpressure } || Allocator.Error;

const StdinChunk = struct {
    data: []u8,
    /// bytes of `data` already written
    written: usize = 0,
    /// close stdin (pipe) or send `^D` (pty) once `data` is written
    eof: bool,
};

const OutputStream = struct {
    /// `"stdout"` or `"stderr"`
    name: []const u8,
    /// read end of the pipe or the pty master; null once closed
    fd: ?sys.fd_t = null,
    /// remaining output credit in `bytes`
    credit: usize = 0,
    /// credit cap (initial window, at most `max_output_credit`) in `bytes`
    max_credit: usize = 0,
    /// poll reported POLLHUP at least once
    hup_seen: bool = false,

    fn canRead(self: *const OutputStream, read_allowed: bool) bool {
        return self.fd != null and self.credit > 0 and read_allowed;
    }
};

pub const Session = struct {
    gpa: Allocator,
    id: u32,
    pid: sys.pid_t,
    pty: bool,
    stdout: OutputStream = .{ .name = "stdout" },
    /// unused in pty mode (the pty merges stderr into stdout)
    stderr: OutputStream = .{ .name = "stderr" },
    /// pipe write end, or the pty master (shared with `stdout.fd`); null when closed
    stdin_fd: ?sys.fd_t = null,
    stdin_queue: std.Deque(StdinChunk) = .empty,
    /// host bytes queued but not yet written in `bytes`
    stdin_queued: usize = 0,
    /// credit granted to the host but not yet used in `bytes`
    stdin_inflight: usize = 0,
    /// credit to announce with the next `stdin_window` in `bytes`
    stdin_grant: usize = 0,
    /// raw wait status once the child has been reaped
    status: ?u32 = null,
    /// pty: monotonic deadline after which the master is closed, in `ms`
    exit_deadline_ms: ?u64 = null,
    /// pty: output bytes still accepted after the child exited
    exit_drain_left: usize = 0,

    pub fn deinit(self: *Session) void {
        self.closeOutput(&self.stdout);
        self.closeOutput(&self.stderr);
        self.closeStdin();
        self.stdin_queue.deinit(self.gpa);
    }

    /// Whether the session is finished: the child was reaped and all output
    /// streams reached EOF (or were force-closed).
    pub fn isDone(self: *const Session) bool {
        return self.status != null and self.stdout.fd == null and self.stderr.fd == null;
    }

    pub fn termination(self: *const Session) protocol.ExecResponse {
        const status = self.status.?;
        if (sys.W.IFEXITED(status)) return .{ .exit_code = sys.W.EXITSTATUS(status) };
        if (sys.W.IFSIGNALED(status)) {
            const sig: i32 = @intCast(@backingInt(sys.W.TERMSIG(status)));
            return .{ .exit_code = 128 + sig, .signal = sig };
        }
        return .{ .exit_code = 1 };
    }

    /// Next deadline relevant for the poll timeout (monotonic `ms`).
    pub fn deadline(self: *const Session) ?u64 {
        if (self.stdout.fd == null) return null;
        return self.exit_deadline_ms;
    }

    // -- event loop integration ------------------------------------------

    pub const PollKind = enum { stdout, stderr, stdin };

    /// Append this session's poll entries.  `read_allowed` is false while the
    /// virtio outbox is above its high-water mark.
    pub fn addPollFds(self: *Session, gpa: Allocator, fds: *std.ArrayList(sys.pollfd), kinds: *std.ArrayList(PollKind), read_allowed: bool) Allocator.Error!usize {
        var added: usize = 0;
        inline for (.{ PollKind.stdout, PollKind.stderr }) |kind| {
            const stream = &@field(self, @tagName(kind));
            if (stream.fd) |fd| {
                // Without credit only watch for hang-up, and only until it has
                // been seen once: POLLHUP is level-triggered and would spin.
                const can_read = stream.canRead(read_allowed);
                if (can_read or !stream.hup_seen) {
                    try fds.append(gpa, .{ .fd = fd, .events = if (can_read) sys.POLL.IN else 0, .revents = 0 });
                    try kinds.append(gpa, kind);
                    added += 1;
                }
            }
        }
        if (self.stdin_fd) |fd| {
            if (self.stdin_queue.len > 0) {
                try fds.append(gpa, .{ .fd = fd, .events = sys.POLL.OUT, .revents = 0 });
                try kinds.append(gpa, .stdin);
                added += 1;
            }
        }
        return added;
    }

    pub fn onReady(self: *Session, kind: PollKind, revents: i16, outbox: *Outbox, read_allowed: bool, buf: []u8) Outbox.Error!void {
        switch (kind) {
            .stdout => try self.onOutputReady(&self.stdout, revents, outbox, read_allowed, buf),
            .stderr => try self.onOutputReady(&self.stderr, revents, outbox, read_allowed, buf),
            .stdin => if (revents != 0) self.flushStdin(),
        }
    }

    fn onOutputReady(self: *Session, stream: *OutputStream, revents: i16, outbox: *Outbox, read_allowed: bool, buf: []u8) Outbox.Error!void {
        if (revents & sys.POLL.HUP != 0) stream.hup_seen = true;
        const fd = stream.fd orelse return;

        if (stream.canRead(read_allowed) and revents & (sys.POLL.IN | sys.POLL.HUP | sys.POLL.ERR) != 0) {
            const max = @min(buf.len, stream.credit);
            const n = sys.read(fd, buf[0..max]) catch |err| switch (err) {
                error.WouldBlock => return,
                // pty master: EIO once every slave fd is closed
                error.InputOutput => 0,
                else => blk: {
                    log.warn("exec {d}: {s} read failed: {t}", .{ self.id, stream.name, err });
                    break :blk 0;
                },
            };
            if (n == 0) return self.closeOutput(stream);

            stream.credit -= n;
            if (self.exit_deadline_ms != null) self.exit_drain_left -|= n;
            try outbox.send(.exec_output, self.id, .{ .stream = stream.name, .data = .{ .data = buf[0..n] } });
        } else if (revents & (sys.POLL.HUP | sys.POLL.ERR) != 0) {
            // Hung up while we may not read: finish only if nothing is left.
            if (sys.bytesAvailable(fd) == 0) self.closeOutput(stream);
        }
    }

    /// The child was reaped with wait status `status`.
    pub fn onExit(self: *Session, status: u32, now_ms: u64) void {
        self.status = status;
        // Other processes (e.g. background jobs) may keep the pty slave open
        // forever, so after the main process exits only drain what is
        // already buffered for a short while.
        if (self.pty and self.stdout.fd != null) {
            self.exit_deadline_ms = now_ms + pty_exit_grace_ms;
            self.exit_drain_left = pty_exit_drain_bytes;
        }
    }

    /// Enforce the pty post-exit drain limits.
    pub fn checkDeadline(self: *Session, now_ms: u64) void {
        const deadline_ms = self.exit_deadline_ms orelse return;
        if (self.stdout.fd != null and (now_ms >= deadline_ms or self.exit_drain_left == 0)) {
            self.closeOutput(&self.stdout);
        }
    }

    fn closeOutput(self: *Session, stream: *OutputStream) void {
        const fd = stream.fd orelse return;
        stream.fd = null;
        if (self.pty and stream == &self.stdout) {
            // The master doubles as stdin; drop it from there too.
            self.stdin_fd = null;
            self.dropStdinQueue();
        }
        sys.close(fd);
    }

    // -- host input -------------------------------------------------------

    /// Grant the initial stdin credit (only for sessions that accept stdin).
    pub fn grantInitialStdin(self: *Session) void {
        self.stdin_inflight = max_stdin_queued;
        self.stdin_grant = max_stdin_queued;
    }

    /// Queue a `stdin_data` chunk from the host.
    pub fn pushStdin(self: *Session, data: []const u8, eof: bool) StdinError!void {
        if (data.len > max_stdin_queued) return error.StdinChunkTooLarge;
        if (self.stdin_queued + data.len > max_stdin_queued) return error.StdinBackpressure;
        // The host must not send more than it was granted.
        if (data.len > self.stdin_inflight) return error.StdinBackpressure;

        if (self.stdin_fd == null) {
            // stdin already closed: discard, handing the credit straight back
            self.stdin_grant += data.len;
            return;
        }

        // Credit is only consumed once the chunk is queued, so an allocation
        // failure leaves the accounting untouched.
        const copy = try self.gpa.dupe(u8, data);
        errdefer self.gpa.free(copy);
        try self.stdin_queue.pushBack(self.gpa, .{ .data = copy, .eof = eof });
        self.stdin_inflight -= data.len;
        self.stdin_queued += data.len;
        self.flushStdin();
    }

    pub fn addOutputCredit(self: *Session, window: protocol.ExecWindow) void {
        self.stdout.credit = @min(self.stdout.max_credit, self.stdout.credit + window.stdout);
        self.stderr.credit = @min(self.stderr.max_credit, self.stderr.credit + window.stderr);
    }

    /// Send `signo` to the command's process group (it is a session leader, so
    /// this also reaches the processes it started). Signals for a group that
    /// is already gone are ignored.
    pub fn signal(self: *Session, signo: u32) error{InvalidSignal}!void {
        if (signo == 0 or signo > 64) return error.InvalidSignal;
        if (self.pid <= 0) return;
        sys.killGroup(self.pid, @fromBackingInt(@intCast(signo)));
    }

    pub fn resize(self: *Session, size: protocol.PtyResize) void {
        if (self.pty) {
            if (self.stdout.fd) |fd| sys.setWinsize(fd, size.rows, size.cols);
        }
    }

    /// Announce returned stdin credit, if any.
    pub fn flushStdinGrant(self: *Session, outbox: *Outbox) Outbox.Error!void {
        if (self.stdin_grant == 0) return;
        try outbox.send(.stdin_window, self.id, .{ .stdin = @intCast(self.stdin_grant) });
        self.stdin_grant = 0;
    }

    /// Write queued stdin until the fd would block.
    fn flushStdin(self: *Session) void {
        while (self.stdin_queue.frontPtr()) |chunk| {
            const fd = self.stdin_fd orelse return self.dropStdinQueue();
            if (chunk.written < chunk.data.len) {
                const n = sys.write(fd, chunk.data[chunk.written..]) catch |err| switch (err) {
                    error.WouldBlock => return,
                    else => {
                        // Child closed its stdin (EPIPE) or the pty is gone.
                        self.closeStdin();
                        return;
                    },
                };
                chunk.written += n;
                self.creditStdin(n);
                if (chunk.written < chunk.data.len) continue;
            }
            if (chunk.eof) {
                if (self.pty) {
                    // Like a terminal user pressing ^D; stdin stays usable.
                    _ = sys.write(fd, "\x04") catch |err| switch (err) {
                        error.WouldBlock => return,
                        else => {},
                    };
                } else {
                    self.popStdin();
                    self.closeStdin();
                    return;
                }
            }
            self.popStdin();
        }
    }

    fn popStdin(self: *Session) void {
        const chunk = self.stdin_queue.popFront().?;
        self.creditStdin(chunk.data.len - chunk.written);
        self.gpa.free(chunk.data);
    }

    fn dropStdinQueue(self: *Session) void {
        while (self.stdin_queue.len > 0) self.popStdin();
    }

    fn creditStdin(self: *Session, n: usize) void {
        self.stdin_queued -= n;
        self.stdin_inflight += n;
        self.stdin_grant += n;
    }

    fn closeStdin(self: *Session) void {
        const fd = self.stdin_fd orelse return;
        self.stdin_fd = null;
        // In pty mode the fd belongs to stdout and is closed there.
        if (!self.pty) sys.close(fd);
        self.dropStdinQueue();
    }
};

// ---------------------------------------------------------------------------
// Spawning

pub const SpawnError = error{ InvalidValue, PtyFailed } || Allocator.Error || sys.OpenError || sys.PipeError || sys.Unexpected || error{SystemResources};

pub const SpawnContext = struct {
    /// environment inherited by children
    environ: [*:null]const ?[*:0]const u8,
    /// signal mask to restore in the child (sandboxd blocks SIGCHLD)
    sigmask: sys.sigset_t,
};

/// Fork and exec the requested command.  The returned session is owned by
/// the caller (destroy with `deinit` + `gpa.destroy`).
pub fn spawn(gpa: Allocator, ctx: *const SpawnContext, id: u32, req: protocol.ExecRequest) SpawnError!*Session {
    // Everything the child needs is prepared before fork(); the child only
    // performs system calls.
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const argv = try buildArgv(arena, req.cmd, req.argv);
    const envp = try buildEnvp(arena, ctx.environ, req.env);
    const cwd: ?[*:0]const u8 = if (req.cwd) |cwd| (try arena.dupeSentinel(u8, cwd, 0)).ptr else null;

    const session = try gpa.create(Session);
    errdefer gpa.destroy(session);
    session.* = .{ .gpa = gpa, .id = id, .pid = 0, .pty = req.pty };
    session.stdout.max_credit = @min(max_output_credit, req.stdoutWindow());
    session.stdout.credit = session.stdout.max_credit;
    session.stderr.max_credit = @min(max_output_credit, req.stderrWindow());
    session.stderr.credit = session.stderr.max_credit;

    if (req.pty) {
        const pty = try sys.openPty();
        defer sys.close(pty.slave);
        errdefer sys.close(pty.master);

        const pid = try sys.fork();
        if (pid == 0) childExec(.{ .pty = pty.slave }, ctx, argv, envp, cwd);

        session.pid = pid;
        session.stdout.fd = pty.master;
        session.stdin_fd = pty.master;
        sys.setNonblocking(pty.master, true) catch {};
        session.grantInitialStdin();
    } else {
        // Pipes are created blocking (the child's ends must be); only the
        // parent's ends are switched to non-blocking after the fork.
        const stdout_pipe = try sys.pipe(false);
        defer sys.close(stdout_pipe[1]);
        errdefer sys.close(stdout_pipe[0]);
        const stderr_pipe = try sys.pipe(false);
        defer sys.close(stderr_pipe[1]);
        errdefer sys.close(stderr_pipe[0]);
        const stdin_pipe: ?[2]sys.fd_t = if (req.stdin) try sys.pipe(false) else null;
        defer if (stdin_pipe) |p| sys.close(p[0]);
        errdefer if (stdin_pipe) |p| sys.close(p[1]);

        const pid = try sys.fork();
        if (pid == 0) childExec(.{ .pipes = .{
            .stdin = if (stdin_pipe) |p| p[0] else null,
            .stdout = stdout_pipe[1],
            .stderr = stderr_pipe[1],
        } }, ctx, argv, envp, cwd);

        session.pid = pid;
        session.stdout.fd = stdout_pipe[0];
        session.stderr.fd = stderr_pipe[0];
        sys.setNonblocking(stdout_pipe[0], true) catch {};
        sys.setNonblocking(stderr_pipe[0], true) catch {};
        if (stdin_pipe) |p| {
            session.stdin_fd = p[1];
            sys.setNonblocking(p[1], true) catch {};
            session.grantInitialStdin();
        }
    }
    return session;
}

const ChildStdio = union(enum) {
    pty: sys.fd_t,
    pipes: struct { stdin: ?sys.fd_t, stdout: sys.fd_t, stderr: sys.fd_t },
};

/// Runs in the forked child: wire up stdio, chdir and exec.  Never returns.
fn childExec(
    stdio: ChildStdio,
    ctx: *const SpawnContext,
    argv: [*:null]const ?[*:0]const u8,
    envp: [*:null]const ?[*:0]const u8,
    cwd: ?[*:0]const u8,
) noreturn {
    // sandboxd ignores SIGPIPE and blocks SIGCHLD; both are inherited across
    // exec and must not leak into the command.
    sys.defaultSignal(.PIPE);
    sys.setSignalMask(&ctx.sigmask);

    switch (stdio) {
        .pty => |slave| {
            sys.setsid();
            sys.setControllingTty(slave);
            for ([_]sys.fd_t{ sys.stdin_fd, sys.stdout_fd, sys.stderr_fd }) |target| {
                sys.dup2(slave, target) catch sys.exit(127);
            }
        },
        .pipes => |p| {
            // own session and process group, so `exec_signal` reaches the
            // whole command without touching sandboxd
            sys.setsid();
            const stdin = p.stdin orelse sys.openZ("/dev/null", .{ .ACCMODE = .RDONLY }, 0) catch sys.exit(127);
            sys.dup2(stdin, sys.stdin_fd) catch sys.exit(127);
            sys.dup2(p.stdout, sys.stdout_fd) catch sys.exit(127);
            sys.dup2(p.stderr, sys.stderr_fd) catch sys.exit(127);
        },
    }

    if (cwd) |dir| sys.chdir(dir) catch sys.exit(127);
    sys.execvpe(argv[0].?, argv, envp) catch {};
    sys.writeAll(sys.stderr_fd, "exec failed\n") catch {};
    sys.exit(127);
}

/// `[cmd, args..., null]` as NUL-terminated strings.
fn buildArgv(arena: Allocator, cmd: []const u8, args: []const []const u8) Allocator.Error![*:null]const ?[*:0]const u8 {
    const argv = try arena.allocSentinel(?[*:0]const u8, args.len + 1, null);
    argv[0] = (try arena.dupeSentinel(u8, cmd, 0)).ptr;
    for (args, argv[1..]) |arg, *slot| slot.* = (try arena.dupeSentinel(u8, arg, 0)).ptr;
    return argv.ptr;
}

/// Inherited environment with `overrides` (`KEY=VALUE`) replacing or adding
/// entries.  Entries without `=` are rejected.
fn buildEnvp(arena: Allocator, base: [*:null]const ?[*:0]const u8, overrides: []const []const u8) (Allocator.Error || error{InvalidValue})![*:null]const ?[*:0]const u8 {
    if (overrides.len == 0) return base;
    for (overrides) |entry| {
        if (std.mem.findScalar(u8, entry, '=') == null) return error.InvalidValue;
    }

    var list: std.ArrayList(?[*:0]const u8) = .empty;
    var i: usize = 0;
    while (base[i]) |entry_z| : (i += 1) {
        if (!isOverridden(std.mem.span(entry_z), overrides)) try list.append(arena, entry_z);
    }
    for (overrides) |entry| try list.append(arena, (try arena.dupeSentinel(u8, entry, 0)).ptr);
    try list.append(arena, null);
    return @ptrCast(list.items.ptr);
}

fn isOverridden(entry: []const u8, overrides: []const []const u8) bool {
    const sep = std.mem.findScalar(u8, entry, '=') orelse return false;
    const key = entry[0 .. sep + 1];
    for (overrides) |override| {
        if (std.mem.startsWith(u8, override, key)) return true;
    }
    return false;
}

const testing = std.testing;

test "environment overrides replace inherited entries" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const base = [_:null]?[*:0]const u8{ "PATH=/bin", "HOME=/root", "PATHX=1" };
    const envp = try buildEnvp(arena, &base, &.{ "PATH=/usr/bin", "NEW=1" });
    var entries: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (envp[i]) |e| : (i += 1) try entries.append(arena, std.mem.span(e));
    try testing.expectEqual(@as(usize, 4), entries.items.len);
    try testing.expectEqualStrings("HOME=/root", entries.items[0]);
    try testing.expectEqualStrings("PATHX=1", entries.items[1]);
    try testing.expectEqualStrings("PATH=/usr/bin", entries.items[2]);
    try testing.expectEqualStrings("NEW=1", entries.items[3]);

    try testing.expectError(error.InvalidValue, buildEnvp(arena, &base, &.{"NOEQUALS"}));
    try testing.expectEqual(@as([*:null]const ?[*:0]const u8, &base), try buildEnvp(arena, &base, &.{}));
}

test "stdin credit accounting" {
    const fds = try sys.pipe(true);
    defer sys.close(fds[0]);

    var session: Session = .{ .gpa = testing.allocator, .id = 1, .pid = 0, .pty = false, .stdin_fd = fds[1] };
    defer session.deinit();
    session.grantInitialStdin();
    session.stdin_grant = 0;

    try session.pushStdin("hello", false);
    // written immediately: credit comes straight back
    try testing.expectEqual(@as(usize, 5), session.stdin_grant);
    try testing.expectEqual(max_stdin_queued, session.stdin_inflight);

    // exceeding the granted credit is rejected
    session.stdin_inflight = 2;
    try testing.expectError(error.StdinBackpressure, session.pushStdin("abc", false));
    session.stdin_inflight = max_stdin_queued;

    try session.pushStdin("", true);
    try testing.expect(session.stdin_fd == null);
    var buf: [16]u8 = undefined;
    try testing.expectEqualStrings("hello", buf[0..try sys.read(fds[0], &buf)]);
    try testing.expectEqual(@as(usize, 0), try sys.read(fds[0], &buf)); // EOF

    // after EOF data is discarded but credited
    session.stdin_grant = 0;
    try session.pushStdin("late", false);
    try testing.expectEqual(@as(usize, 4), session.stdin_grant);
}

test "stdin allocation failure does not consume credit" {
    // fail the data copy (0) and the queue growth (1)
    for ([_]usize{ 0, 1 }) |fail_index| {
        var failing: std.testing.FailingAllocator = .init(testing.allocator, .{ .fail_index = fail_index });
        const fds = try sys.pipe(true);
        defer sys.close(fds[0]);

        var session: Session = .{ .gpa = failing.allocator(), .id = 1, .pid = 0, .pty = false, .stdin_fd = fds[1] };
        defer session.deinit();
        session.grantInitialStdin();
        session.stdin_grant = 0;

        try testing.expectError(error.OutOfMemory, session.pushStdin("hello", false));
        try testing.expectEqual(max_stdin_queued, session.stdin_inflight);
        try testing.expectEqual(@as(usize, 0), session.stdin_queued);
        try testing.expectEqual(@as(usize, 0), session.stdin_grant);
    }
}

test "exit status mapping" {
    var session: Session = .{ .gpa = testing.allocator, .id = 1, .pid = 0, .pty = false };
    session.status = 3 << 8;
    try testing.expectEqual(protocol.ExecResponse{ .exit_code = 3 }, session.termination());
    session.status = 9;
    try testing.expectEqual(protocol.ExecResponse{ .exit_code = 137, .signal = 9 }, session.termination());
}
