//! Code shared by the guest helper binaries (imported as module `shared`).

pub const sys = @import("shared/sys.zig");
pub const runtime = @import("shared/runtime.zig");
pub const cbor = @import("shared/cbor.zig");
pub const protocol = @import("shared/protocol.zig");
pub const framing = @import("shared/framing.zig");
pub const channel = @import("shared/channel.zig");
pub const virtio_port = @import("shared/virtio_port.zig");
pub const fs_rpc = @import("shared/fs_rpc.zig");
pub const request_path = @import("shared/request_path.zig");
pub const tcp_forwarder = @import("shared/tcp_forwarder.zig");

test {
    @import("std").testing.refAllDecls(@This());
}
