//! Request path resolution helpers shared by sandboxd and fuzz harnesses.
//!
//! Invalid paths are reported as `error.InvalidValue` (the name is visible to
//! the host in `file_*_failed` error messages).

const std = @import("std");

pub const Error = error{InvalidValue} || std.mem.Allocator.Error;

fn validateNoNul(path: []const u8) Error!void {
    if (std.mem.findScalar(u8, path, 0) != null) return error.InvalidValue;
}

fn isPathWithinRoot(path: []const u8, root: []const u8) bool {
    if (std.mem.eql(u8, root, "/")) return true;
    if (std.mem.eql(u8, path, root)) return true;
    return std.mem.startsWith(u8, path, root) and path.len > root.len and path[root.len] == '/';
}

/// Resolve a request path against an optional cwd
///
/// - Absolute request paths are returned as-is
/// - Relative request paths require an absolute cwd
pub fn resolveRequestPath(
    allocator: std.mem.Allocator,
    request_path: []const u8,
    cwd: ?[]const u8,
) Error![]u8 {
    if (request_path.len == 0) return error.InvalidValue;
    try validateNoNul(request_path);
    if (std.fs.path.isAbsolute(request_path)) {
        return allocator.dupe(u8, request_path);
    }

    const base = cwd orelse return error.InvalidValue;
    try validateNoNul(base);
    if (!std.fs.path.isAbsolute(base)) return error.InvalidValue;

    return std.fs.path.resolve(allocator, &[_][]const u8{ base, request_path });
}

/// Resolve a request path and ensure the final path stays within `root_dir`
///
/// When `root_dir` is "/", this is equivalent to `resolveRequestPath`.
pub fn resolveRequestPathInRoot(
    allocator: std.mem.Allocator,
    root_dir: []const u8,
    request_path: []const u8,
    cwd: ?[]const u8,
) Error![]u8 {
    try validateNoNul(root_dir);

    if (std.mem.eql(u8, root_dir, "/")) {
        return resolveRequestPath(allocator, request_path, cwd);
    }

    // If the request uses an absolute path, interpret it as absolute within the root.
    // This keeps fuzz harnesses from touching the real guest filesystem.
    if (request_path.len == 0) return error.InvalidValue;
    try validateNoNul(request_path);
    if (std.fs.path.isAbsolute(request_path)) {
        const rel = std.mem.trimStart(u8, request_path, "/");
        const resolved = try std.fs.path.resolve(allocator, &[_][]const u8{ root_dir, rel });
        if (!isPathWithinRoot(resolved, root_dir)) {
            allocator.free(resolved);
            return error.InvalidValue;
        }
        return resolved;
    }

    // Relative: resolve against cwd and then validate that we're still within root_dir.
    const resolved = try resolveRequestPath(allocator, request_path, cwd);
    errdefer allocator.free(resolved);

    if (!isPathWithinRoot(resolved, root_dir)) return error.InvalidValue;
    return resolved;
}

const testing = std.testing;

test "relative paths need an absolute cwd" {
    const gpa = testing.allocator;
    const abs = try resolveRequestPath(gpa, "/etc/hosts", null);
    defer gpa.free(abs);
    try testing.expectEqualStrings("/etc/hosts", abs);

    const rel = try resolveRequestPath(gpa, "../b", "/tmp/a");
    defer gpa.free(rel);
    try testing.expectEqualStrings("/tmp/b", rel);

    try testing.expectError(error.InvalidValue, resolveRequestPath(gpa, "x", null));
    try testing.expectError(error.InvalidValue, resolveRequestPath(gpa, "x", "relative"));
    try testing.expectError(error.InvalidValue, resolveRequestPath(gpa, "", "/"));
    try testing.expectError(error.InvalidValue, resolveRequestPath(gpa, "/a\x00b", null));
}

test "root confinement" {
    const gpa = testing.allocator;
    const inside = try resolveRequestPathInRoot(gpa, "/srv", "/etc/../x", null);
    defer gpa.free(inside);
    try testing.expectEqualStrings("/srv/x", inside);
    try testing.expectError(error.InvalidValue, resolveRequestPathInRoot(gpa, "/srv", "../../etc", "/srv/a"));
}
