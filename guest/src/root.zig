const std = @import("std");

pub const cbor = @import("shared/cbor.zig");
pub const protocol = @import("shared/protocol.zig");
pub const request_path = @import("shared/request_path.zig");
pub const fs_rpc = @import("shared/fs_rpc.zig");
pub const tcp_forwarder = @import("shared/tcp_forwarder.zig");

var runtime_logs_enabled: bool = true;

pub fn setRuntimeLogsEnabled(enabled: bool) void {
    runtime_logs_enabled = enabled;
}

fn runtimeLogFn(
    comptime level: std.log.Level,
    comptime scope: @TypeOf(.enum_literal),
    comptime format: []const u8,
    args: anytype,
) void {
    if (!runtime_logs_enabled) {
        return;
    }
    std.log.defaultLog(level, scope, format, args);
}

pub const std_options = .{
    .log_level = .info,
    .logFn = runtimeLogFn,
};
