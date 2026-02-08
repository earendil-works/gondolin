const std = @import("std");
const builtin = @import("builtin");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{
        .default_target = .{ .cpu_arch = builtin.cpu.arch, .os_tag = .linux, .abi = .musl },
    });
    const optimize = b.standardOptimizeOption(.{});

    const mod = b.addModule("sandboxd", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
    });

    const exe = b.addExecutable(.{
        .name = "sandboxd",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/sandboxd/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "sandboxd", .module = mod },
            },
        }),
    });
    exe.linkLibC();

    b.installArtifact(exe);

    const fs_exe = b.addExecutable(.{
        .name = "sandboxfs",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/sandboxfs/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "sandboxd", .module = mod },
            },
        }),
    });
    fs_exe.linkLibC();
    b.installArtifact(fs_exe);

    const ssh_exe = b.addExecutable(.{
        .name = "sandboxssh",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/sandboxssh/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "sandboxd", .module = mod },
            },
        }),
    });
    ssh_exe.linkLibC();
    b.installArtifact(ssh_exe);

    const ingress_exe = b.addExecutable(.{
        .name = "sandboxingress",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/sandboxingress/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "sandboxd", .module = mod },
            },
        }),
    });
    ingress_exe.linkLibC();
    b.installArtifact(ingress_exe);

    const mod_tests = b.addTest(.{
        .name = "sandboxd-mod-tests",
        .root_module = mod,
    });
    const run_mod_tests = b.addRunArtifact(mod_tests);

    const exe_tests = b.addTest(.{
        .name = "sandboxd-exe-tests",
        .root_module = exe.root_module,
    });
    const run_exe_tests = b.addRunArtifact(exe_tests);

    const mod_tests_install = b.addInstallArtifact(mod_tests, .{ .dest_sub_path = "sandboxd-mod-tests" });
    const exe_tests_install = b.addInstallArtifact(exe_tests, .{ .dest_sub_path = "sandboxd-exe-tests" });

    const test_bins = b.step("test-bins", "Build test binaries for guest execution");
    test_bins.dependOn(&mod_tests_install.step);
    test_bins.dependOn(&exe_tests_install.step);

    const test_step = b.step("test", "Run tests");
    test_step.dependOn(&run_mod_tests.step);
    test_step.dependOn(&run_exe_tests.step);
}
