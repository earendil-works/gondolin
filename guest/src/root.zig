pub const cbor = @import("shared/cbor.zig");
pub const protocol = @import("shared/protocol.zig");
pub const fs_rpc = @import("shared/fs_rpc.zig");
pub const tcp_forwarder = @import("shared/tcp_forwarder.zig");

pub const std_options = .{
    .log_level = .info,
};
