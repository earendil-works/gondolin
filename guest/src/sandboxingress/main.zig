const std = @import("std");
const tcp_forwarder = @import("sandboxd").tcp_forwarder;

const log = std.log.scoped(.sandboxingress);

pub fn main() !void {
    try tcp_forwarder.run("virtio-ingress", log);
}
