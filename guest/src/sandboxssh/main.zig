//! sandboxssh: forwards host SSH streams on `virtio-ssh` to the guest's
//! loopback sshd (see `shared/tcp_forwarder.zig`).

const shared = @import("shared");

pub const std_options = shared.runtime.std_options;
pub const panic = shared.runtime.panic;

pub fn main() !void {
    try shared.tcp_forwarder.main("virtio-ssh");
}
