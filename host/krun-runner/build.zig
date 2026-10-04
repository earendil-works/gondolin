const std = @import("std");
const builtin = @import("builtin");

// Zig does not enforce `minimum_zig_version`, and older compilers fail with
// confusing errors, so reject them up front.
comptime {
    const required = std.SemanticVersion{ .major = 0, .minor = 17, .patch = 0 };
    if (builtin.zig_version.order(required) == .lt) {
        @compileError("Zig 0.17.0 or newer is required (found " ++ builtin.zig_version_string ++ "); install it with scripts/install-zig.sh 0.17.0");
    }
}

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

    if (target.result.os.tag == .macos and builtin.target.os.tag == .macos) {
        // The install path is not known at configure time, so sign a copy of
        // the binary as a cached build output and install the signed copy.
        const codesign = b.addSystemCommand(&.{
            "/bin/sh",
            "-c",
            "cp \"$1\" \"$3\" && codesign --force --sign - --entitlements \"$2\" \"$3\"",
            "codesign",
        });
        codesign.addArtifactArg2(exe, .{});
        codesign.addFileArg2(b.path("gondolin-krun-runner.entitlements"), .{});
        const signed_exe = codesign.addOutputFileArg2("gondolin-krun-runner", .{});
        b.getInstallStep().dependOn(&b.addInstallBinFile(signed_exe, "gondolin-krun-runner").step);
    } else {
        b.installArtifact(exe);
    }

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.addPassthruArgs();

    const run_step = b.step("run", "Run the krun runner");
    run_step.dependOn(&run_cmd.step);
}
