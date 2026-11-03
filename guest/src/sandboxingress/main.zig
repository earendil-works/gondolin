//! sandboxingress: forwards host ingress streams on `virtio-ingress` to
//! loopback HTTP services in the guest (see `shared/tcp_forwarder.zig`).

const shared = @import("shared");

pub const std_options = shared.runtime.std_options;
pub const panic = shared.runtime.panic;

pub fn main() !void {
    try shared.tcp_forwarder.main("virtio-ingress");
}
