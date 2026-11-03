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

/// Helper binaries: name and root source file.
const helpers = [_]struct { []const u8, []const u8 }{
    .{ "sandboxd", "src/sandboxd/main.zig" },
    .{ "sandboxfs", "src/sandboxfs/main.zig" },
    .{ "sandboxssh", "src/sandboxssh/main.zig" },
    .{ "sandboxingress", "src/sandboxingress/main.zig" },
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{
        .default_target = .{ .cpu_arch = builtin.target.cpu.arch, .os_tag = .linux, .abi = .musl },
    });
    const optimize = b.standardOptimizeOption(.{});

    // The helpers are static, single-threaded Linux binaries that talk to the
    // kernel directly (no libc).
    const shared = b.addModule("shared", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .single_threaded = true,
    });

    for (helpers) |helper| {
        const exe = b.addExecutable(.{
            .name = helper[0],
            .root_module = b.createModule(.{
                .root_source_file = b.path(helper[1]),
                .target = target,
                .optimize = optimize,
                .single_threaded = true,
                .imports = &.{.{ .name = "shared", .module = shared }},
            }),
        });
        b.installArtifact(exe);
    }

    // Test binaries; `guest-tests` copies these into a VM and runs them.
    const mod_tests = b.addTest(.{ .name = "sandboxd-mod-tests", .root_module = shared });
    const exe_tests = b.addTest(.{
        .name = "sandboxd-exe-tests",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/exe_tests.zig"),
            .target = target,
            .optimize = optimize,
            .single_threaded = true,
            .imports = &.{.{ .name = "shared", .module = shared }},
        }),
    });

    const test_bins = b.step("test-bins", "Build test binaries for guest execution");
    test_bins.dependOn(&b.addInstallArtifact(mod_tests, .{ .dest_sub_path = "sandboxd-mod-tests" }).step);
    test_bins.dependOn(&b.addInstallArtifact(exe_tests, .{ .dest_sub_path = "sandboxd-exe-tests" }).step);

    const test_step = b.step("test", "Run tests (requires a Linux host)");
    test_step.dependOn(&b.addRunArtifact(mod_tests).step);
    test_step.dependOn(&b.addRunArtifact(exe_tests).step);
}
