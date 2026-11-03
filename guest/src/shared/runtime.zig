//! Process-wide runtime configuration shared by all helper binaries.
//!
//! Each executable re-exports `std_options` and `panic` from its root file so
//! that logging and panics go straight to stderr with a single `write(2)`
//! instead of pulling in the `std.Io` based default handlers.  This keeps the
//! static binaries small and avoids any locking or allocation while logging.

const std = @import("std");
const builtin = @import("builtin");
const sys = @import("sys.zig");

pub const std_options: std.Options = .{
    .log_level = if (builtin.mode == .debug) .debug else .info,
    .logFn = logFn,
};

pub const panic = std.debug.FullPanic(panicFn);

/// Format one log line into a stack buffer and emit it with one `write(2)`.
/// Lines longer than the buffer are truncated.
fn logFn(
    comptime level: std.log.Level,
    comptime scope: @EnumLiteral(),
    comptime format: []const u8,
    args: anytype,
) void {
    const prefix = comptime level.asText() ++ (if (scope == .default) "" else "(" ++ @tagName(scope) ++ ")") ++ ": ";
    var buf: [1024]u8 = undefined;
    var w: std.Io.Writer = .fixed(buf[0 .. buf.len - 1]);
    w.print(prefix ++ format, args) catch {};
    const line = w.buffered();
    buf[line.len] = '\n';
    _ = sys.write(sys.stderr_fd, buf[0 .. line.len + 1]) catch {};
}

fn panicFn(msg: []const u8, first_trace_addr: ?usize) noreturn {
    _ = first_trace_addr;
    var iov = [_]sys.iovec_const{
        .{ .base = "panic: ", .len = 7 },
        .{ .base = msg.ptr, .len = msg.len },
        .{ .base = "\n", .len = 1 },
    };
    sys.writevAll(sys.stderr_fd, &iov) catch {};
    sys.exit(134);
}

var debug_allocator: std.heap.DebugAllocator(.{}) = .init;

/// General purpose allocator for the (single-threaded) helpers.
///
/// Debug builds use the leak-checking `DebugAllocator`; release builds use the
/// small size-class `brk` allocator (we own the process' `brk` since there is
/// no libc).
pub fn gpa() std.mem.Allocator {
    return if (builtin.mode == .debug) debug_allocator.allocator() else std.heap.brk_allocator;
}

/// Report leaks in debug builds; no-op otherwise.
pub fn deinitGpa() void {
    if (builtin.mode == .debug) _ = debug_allocator.deinit();
}

/// Common process setup: broken pipes and sockets must surface as `EPIPE`
/// instead of killing the helper.
pub fn init() void {
    sys.ignoreSignal(.PIPE);
}
