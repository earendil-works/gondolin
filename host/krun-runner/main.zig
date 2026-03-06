const std = @import("std");

const c = @cImport({
    @cInclude("errno.h");
    @cInclude("stdint.h");
    @cInclude("stdbool.h");
    @cInclude("string.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/un.h");
    @cInclude("unistd.h");
    @cInclude("libkrun.h");
});

const Config = struct {
    kernelPath: []const u8,
    initrdPath: []const u8,
    rootDiskPath: ?[]const u8 = null,
    rootDiskFormat: ?DiskFormat = null,
    rootDiskReadOnly: bool = false,
    memoryMiB: u32,
    cpus: u8,
    virtioSocketPath: []const u8,
    virtioFsSocketPath: []const u8,
    virtioSshSocketPath: []const u8,
    virtioIngressSocketPath: []const u8,
    append: []const u8,
    console: ConsoleMode = .none,
    netSocketPath: ?[]const u8 = null,
    netMac: ?[]const u8 = null,
};

const DiskFormat = enum {
    raw,
    qcow2,
};

const ConsoleMode = enum {
    stdio,
    none,
};

const CliConfig = struct {
    configPath: []const u8,
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const cli = try parseArgs(allocator);
    defer allocator.free(cli.configPath);

    const config_bytes = try std.fs.cwd().readFileAlloc(allocator, cli.configPath, 1024 * 1024);
    defer allocator.free(config_bytes);

    const parsed = try std.json.parseFromSlice(Config, allocator, config_bytes, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();

    try runVm(allocator, parsed.value);
}

fn parseArgs(allocator: std.mem.Allocator) !CliConfig {
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    if (args.len == 2 and std.mem.eql(u8, args[1], "--version")) {
        try std.fs.File.stdout().writeAll("gondolin-krun-runner 0.1.0\n");
        std.process.exit(0);
    }

    if (args.len == 2 and std.mem.eql(u8, args[1], "--help")) {
        try std.fs.File.stdout().writeAll("usage: gondolin-krun-runner --config <path>\n");
        std.process.exit(0);
    }

    if (args.len != 3 or !std.mem.eql(u8, args[1], "--config")) {
        try std.fs.File.stderr().writeAll("usage: gondolin-krun-runner --config <path>\n");
        return error.InvalidArguments;
    }

    return .{ .configPath = try allocator.dupe(u8, args[2]) };
}

fn runVm(allocator: std.mem.Allocator, cfg: Config) !void {
    _ = c.krun_init_log(c.KRUN_LOG_TARGET_DEFAULT, c.KRUN_LOG_LEVEL_WARN, c.KRUN_LOG_STYLE_NEVER, 0);

    const ctx_raw = c.krun_create_ctx();
    if (ctx_raw < 0) return krunError("krun_create_ctx", ctx_raw);
    const ctx: u32 = @intCast(ctx_raw);
    errdefer _ = c.krun_free_ctx(ctx);

    const vm_cfg = c.krun_set_vm_config(ctx, cfg.cpus, cfg.memoryMiB);
    if (vm_cfg < 0) return krunError("krun_set_vm_config", vm_cfg);

    const kernel_path_z = try allocator.dupeZ(u8, cfg.kernelPath);
    const initrd_path_z = try allocator.dupeZ(u8, cfg.initrdPath);
    const append_z = try allocator.dupeZ(u8, cfg.append);

    const kernel_format: u32 = try detectKernelFormat(cfg.kernelPath);

    const kernel_rc = c.krun_set_kernel(
        ctx,
        kernel_path_z.ptr,
        kernel_format,
        initrd_path_z.ptr,
        append_z.ptr,
    );
    if (kernel_rc < 0) return krunError("krun_set_kernel", kernel_rc);

    const console_output_path = switch (cfg.console) {
        .none => "/dev/null",
        .stdio => "/dev/stdout",
    };
    const console_output_z = try allocator.dupeZ(u8, console_output_path);
    const console_rc = c.krun_set_console_output(ctx, console_output_z.ptr);
    if (console_rc < 0) return krunError("krun_set_console_output", console_rc);

    if (cfg.rootDiskPath) |root_disk_path| {
        const root_disk_path_z = try allocator.dupeZ(u8, root_disk_path);
        const disk_format: u32 = switch (cfg.rootDiskFormat orelse .raw) {
            .raw => c.KRUN_DISK_FORMAT_RAW,
            .qcow2 => c.KRUN_DISK_FORMAT_QCOW2,
        };
        const block_id = try allocator.dupeZ(u8, "root");
        const disk_rc = c.krun_add_disk2(
            ctx,
            block_id.ptr,
            root_disk_path_z.ptr,
            disk_format,
            cfg.rootDiskReadOnly,
        );
        if (disk_rc < 0) return krunError("krun_add_disk2", disk_rc);
    }

    if (cfg.netSocketPath) |net_socket_path| {
        const net_path_z = try allocator.dupeZ(u8, net_socket_path);
        var mac = try parseMac(cfg.netMac orelse "02:00:00:00:00:01");
        const net_rc = c.krun_add_net_unixstream(
            ctx,
            net_path_z.ptr,
            -1,
            @ptrCast(&mac[0]),
            c.COMPAT_NET_FEATURES,
            0,
        );
        if (net_rc < 0) return krunError("krun_add_net_unixstream", net_rc);
    }

    const console_id_raw = c.krun_add_virtio_console_multiport(ctx);
    if (console_id_raw < 0) return krunError("krun_add_virtio_console_multiport", console_id_raw);
    const console_id: u32 = @intCast(console_id_raw);

    try addConsolePort(allocator, ctx, console_id, "virtio-port", cfg.virtioSocketPath);
    try addConsolePort(allocator, ctx, console_id, "virtio-fs", cfg.virtioFsSocketPath);
    try addConsolePort(allocator, ctx, console_id, "virtio-ssh", cfg.virtioSshSocketPath);
    try addConsolePort(allocator, ctx, console_id, "virtio-ingress", cfg.virtioIngressSocketPath);

    const start_rc = c.krun_start_enter(ctx);
    if (start_rc < 0) return krunError("krun_start_enter", start_rc);
    std.process.exit(@intCast(@mod(start_rc, 256)));
}

fn addConsolePort(
    allocator: std.mem.Allocator,
    ctx: u32,
    console_id: u32,
    port_name: []const u8,
    socket_path: []const u8,
) !void {
    const fd = try connectUnixStream(socket_path);
    const output_fd = c.dup(fd);
    if (output_fd < 0) {
        _ = c.close(fd);
        return error.DupFailed;
    }

    const port_name_z = try allocator.dupeZ(u8, port_name);
    const rc = c.krun_add_console_port_inout(
        ctx,
        console_id,
        port_name_z.ptr,
        fd,
        output_fd,
    );
    if (rc < 0) return krunError("krun_add_console_port_inout", rc);
}

fn connectUnixStream(socket_path: []const u8) !c_int {
    const fd = c.socket(c.AF_UNIX, c.SOCK_STREAM, 0);
    if (fd < 0) return error.SocketCreateFailed;
    errdefer _ = c.close(fd);

    var addr = std.mem.zeroes(c.struct_sockaddr_un);
    addr.sun_family = c.AF_UNIX;

    if (socket_path.len + 1 > addr.sun_path.len) {
        return error.SocketPathTooLong;
    }

    std.mem.copyForwards(u8, addr.sun_path[0..socket_path.len], socket_path);
    addr.sun_path[socket_path.len] = 0;

    const sockaddr_ptr: *const c.struct_sockaddr = @ptrCast(&addr);
    const addr_len: c.socklen_t = @intCast(@sizeOf(c.sa_family_t) + socket_path.len + 1);

    if (c.connect(fd, sockaddr_ptr, addr_len) != 0) {
        return error.SocketConnectFailed;
    }

    return fd;
}

fn detectKernelFormat(kernel_path: []const u8) !u32 {
    var file = try std.fs.cwd().openFile(kernel_path, .{});
    defer file.close();

    var header: [4]u8 = .{ 0, 0, 0, 0 };
    const n = try file.readAll(&header);

    if (n >= 2 and header[0] == 'M' and header[1] == 'Z') {
        return c.KRUN_KERNEL_FORMAT_PE_GZ;
    }

    if (n >= 4 and header[0] == 0x7f and header[1] == 'E' and header[2] == 'L' and header[3] == 'F') {
        return c.KRUN_KERNEL_FORMAT_ELF;
    }

    if (n >= 2 and header[0] == 0x1f and header[1] == 0x8b) {
        return c.KRUN_KERNEL_FORMAT_IMAGE_GZ;
    }

    if (n >= 3 and header[0] == 'B' and header[1] == 'Z' and header[2] == 'h') {
        return c.KRUN_KERNEL_FORMAT_IMAGE_BZ2;
    }

    if (n >= 4 and header[0] == 0x28 and header[1] == 0xb5 and header[2] == 0x2f and header[3] == 0xfd) {
        return c.KRUN_KERNEL_FORMAT_IMAGE_ZSTD;
    }

    return c.KRUN_KERNEL_FORMAT_RAW;
}

fn parseMac(value: []const u8) ![6]u8 {
    var parts = std.mem.splitScalar(u8, value, ':');
    var mac: [6]u8 = undefined;
    var idx: usize = 0;

    while (parts.next()) |part| {
        if (idx >= mac.len) return error.InvalidMacAddress;
        if (part.len != 2) return error.InvalidMacAddress;
        mac[idx] = try std.fmt.parseUnsigned(u8, part, 16);
        idx += 1;
    }

    if (idx != mac.len) return error.InvalidMacAddress;
    return mac;
}

fn krunError(name: []const u8, rc: i32) error{KrunError} {
    std.log.err("{s} failed: rc={d}", .{ name, rc });
    return error.KrunError;
}
