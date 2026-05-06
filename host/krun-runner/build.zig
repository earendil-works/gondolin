const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const libkrun_prefix = b.option([]const u8, "libkrun-prefix", "prefix directory containing libkrun include/lib") orelse "";

    const exe = b.addExecutable(.{
        .name = "gondolin-krun-runner",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    if (libkrun_prefix.len > 0) {
        const include_dir = std.fs.path.join(b.allocator, &.{ libkrun_prefix, "include" }) catch @panic("OOM");
        const lib_dir = std.fs.path.join(b.allocator, &.{ libkrun_prefix, "lib" }) catch @panic("OOM");
        const lib64_dir = std.fs.path.join(b.allocator, &.{ libkrun_prefix, "lib64" }) catch @panic("OOM");

        exe.root_module.addIncludePath(.{ .cwd_relative = include_dir });

        const preferred_lib_dir = switch (target.result.os.tag) {
            .macos => lib_dir,
            else => lib64_dir,
        };
        exe.root_module.addLibraryPath(.{ .cwd_relative = preferred_lib_dir });
    }

    switch (target.result.os.tag) {
        .macos => exe.root_module.addRPathSpecial("@loader_path/../lib"),
        else => exe.root_module.addRPathSpecial("$ORIGIN/../lib"),
    }

    exe.root_module.linkSystemLibrary("krun", .{});

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run the krun runner");
    run_step.dependOn(&run_cmd.step);
}
