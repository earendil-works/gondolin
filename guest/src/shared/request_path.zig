//! Request path resolution helpers shared by sandboxd and fuzz harnesses

const std = @import("std");
const protocol = @import("protocol.zig");

fn validateNoNul(path: []const u8) !void {
    if (std.mem.indexOfScalar(u8, path, 0) != null) return protocol.ProtocolError.InvalidValue;
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
) ![]u8 {
    if (request_path.len == 0) return protocol.ProtocolError.InvalidValue;
    try validateNoNul(request_path);
    if (std.fs.path.isAbsolute(request_path)) {
        return allocator.dupe(u8, request_path);
    }

    const base = cwd orelse return protocol.ProtocolError.InvalidValue;
    try validateNoNul(base);
    if (!std.fs.path.isAbsolute(base)) return protocol.ProtocolError.InvalidValue;

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
) ![]u8 {
    try validateNoNul(root_dir);

    if (std.mem.eql(u8, root_dir, "/")) {
        return resolveRequestPath(allocator, request_path, cwd);
    }

    // If the request uses an absolute path, interpret it as absolute within the root.
    // This keeps fuzz harnesses from touching the real guest filesystem.
    if (request_path.len == 0) return protocol.ProtocolError.InvalidValue;
    try validateNoNul(request_path);
    if (std.fs.path.isAbsolute(request_path)) {
        const rel = std.mem.trimLeft(u8, request_path, "/");
        const resolved = try std.fs.path.resolve(allocator, &[_][]const u8{ root_dir, rel });
        if (!isPathWithinRoot(resolved, root_dir)) {
            allocator.free(resolved);
            return protocol.ProtocolError.InvalidValue;
        }
        return resolved;
    }

    // Relative: resolve against cwd and then validate that we're still within root_dir.
    const resolved = try resolveRequestPath(allocator, request_path, cwd);
    errdefer allocator.free(resolved);

    if (!isPathWithinRoot(resolved, root_dir)) return protocol.ProtocolError.InvalidValue;
    return resolved;
}
