//! sandboxfs: FUSE filesystem that forwards every operation to the host.
//!
//! Single-threaded and synchronous: read one request from `/dev/fuse`,
//! translate it into at most a few `fs_request` RPCs on the `virtio-fs` port
//! (see `shared/fs_rpc.zig`), write the reply, repeat.  The kernel queues
//! concurrent requests from guest processes.
//!
//! Inodes and file handles are owned by the host: `nodeid` and `fh` values
//! are passed through unchanged.  Without an RPC port (it did not show up
//! within 5 s) sandboxfs runs in stub mode: it mounts an empty root so that
//! init can proceed, and most operations fail with `ENOSYS`.
//!
//! Failures: host errnos are returned to the kernel as-is; malformed host
//! responses and RPC transport errors become `EIO` for that request.

const std = @import("std");
const shared = @import("shared");
const fuse = @import("fuse.zig");

const sys = shared.sys;
const cbor = shared.cbor;
const fs_rpc = shared.fs_rpc;
const E = sys.E;
const Allocator = std.mem.Allocator;
const linux = std.os.linux;

pub const std_options = shared.runtime.std_options;
pub const panic = shared.runtime.panic;

const log = std.log.scoped(.sandboxfs);

/// Largest data payload of one read/write RPC (also the FUSE `max_write`) in `bytes`
const max_rpc_data: u32 = 60 * 1024;
/// Request buffer size; must exceed `max_write` plus headers, in `bytes`
const request_buf_size = 128 * 1024;

const default_attr_ttl_ms: u64 = 1000;
const default_entry_ttl_ms: u64 = 1000;

test {
    _ = fuse;
}

pub fn main(init: std.process.Init.Minimal) !void {
    shared.runtime.init();
    const gpa = shared.runtime.gpa();
    defer shared.runtime.deinitGpa();

    var mount_point: []const u8 = "/data";
    var rpc_path: []const u8 = "/dev/virtio-ports/virtio-fs";
    var binds_file: ?[]const u8 = null;
    const args = init.args.vector;
    var i: usize = 1;
    while (i + 1 < args.len) : (i += 1) {
        const arg = std.mem.span(args[i]);
        const value = std.mem.span(args[i + 1]);
        if (std.mem.eql(u8, arg, "--mount")) {
            mount_point = value;
        } else if (std.mem.eql(u8, arg, "--rpc-path")) {
            rpc_path = value;
        } else if (std.mem.eql(u8, arg, "--binds-file")) {
            binds_file = value;
        } else continue;
        i += 1;
    }

    const fuse_fd = try sys.openZ("/dev/fuse", .{ .ACCMODE = .RDWR }, 0);
    defer sys.close(fuse_fd);

    var fs: Fs = .{ .gpa = gpa, .fuse_fd = fuse_fd, .arena = .init(gpa) };
    defer fs.deinit();

    if (openRpcPort(rpc_path)) |fd| {
        fs.rpc = .init(gpa, fd);
        log.info("connected rpc at {s}", .{rpc_path});
    } else {
        log.warn("rpc port {s} unavailable; running in stub mode", .{rpc_path});
    }

    // The bind list is written before mounting so that init can rely on the
    // file being complete once the fuse mount shows up in /proc/mounts.
    if (binds_file) |path| {
        if (fs.rpc != null) fs.writeBindsFile(path) catch |err| {
            log.warn("unable to fetch bind mounts: {t}", .{err});
        };
    }

    try mountFuse(fuse_fd, mount_point);
    log.info("mounted sandboxfs at {s}", .{mount_point});
    try fs.run();
}

fn openRpcPort(path: []const u8) ?sys.fd_t {
    const name = std.fs.path.basename(path);
    for (0..50) |_| {
        if (shared.virtio_port.tryOpenPath(path, .blocking) catch null) |fd| return fd;
        if (shared.virtio_port.scan(name, .blocking) catch null) |fd| return fd;
        sys.sleepMs(100);
    }
    return null;
}

fn mountFuse(fuse_fd: sys.fd_t, mount_point: []const u8) !void {
    var opts_buf: [128]u8 = undefined;
    const opts = try std.mem.printSentinel(&opts_buf, "fd={d},rootmode=40000,user_id=0,group_id=0,default_permissions", .{fuse_fd}, 0);
    var path_buf: [sys.path_max]u8 = undefined;
    const target = try sys.toPathZ(&path_buf, mount_point);
    const err = sys.mount("sandboxfs", target, "fuse.sandboxfs", linux.MS.NOSUID | linux.MS.NODEV, opts);
    if (err != .SUCCESS) {
        log.err("mount failed: {t}", .{err});
        return error.MountFailed;
    }
}

/// Result of handling one request.
const Reply = union(enum) {
    /// no reply (FORGET, BATCH_FORGET, INTERRUPT)
    none,
    err: E,
    /// reply payload; lives in the request arena
    data: []const u8,
};

const HandlerError = error{
    /// the host answered with an errno, see `Fs.host_errno`
    HostErrno,
    InvalidRequest,
    InvalidResponse,
} || fs_rpc.CallError;

const Fs = struct {
    gpa: Allocator,
    fuse_fd: sys.fd_t,
    rpc: ?fs_rpc.Client = null,
    /// per-request scratch memory (replies, decoded responses)
    arena: std.heap.ArenaAllocator,
    /// errno of the last failed RPC (valid after `error.HostErrno`)
    host_errno: E = .SUCCESS,
    /// opcodes already reported as unsupported
    unsupported_logged: std.StaticBitSet(64) = .empty,

    fn deinit(self: *Fs) void {
        if (self.rpc) |*rpc| {
            sys.close(rpc.fd);
            rpc.deinit();
        }
        self.arena.deinit();
    }

    fn run(self: *Fs) !void {
        const buf = try self.gpa.alignedAlloc(u8, .of(fuse.InHeader), request_buf_size);
        defer self.gpa.free(buf);

        while (true) {
            const n = while (true) {
                const rc = linux.read(self.fuse_fd, buf.ptr, buf.len);
                switch (linux.errno(rc)) {
                    .SUCCESS => break rc,
                    // ENOENT: the request was interrupted before we read it
                    .INTR, .AGAIN, .NOENT => continue,
                    .NODEV => {
                        log.info("filesystem unmounted", .{});
                        return;
                    },
                    else => |err| {
                        log.err("read fuse request failed: {t}", .{err});
                        return error.FuseReadFailed;
                    },
                }
            };
            if (n < @sizeOf(fuse.InHeader)) {
                log.warn("short fuse request ({d} bytes)", .{n});
                continue;
            }
            const header = std.mem.bytesToValue(fuse.InHeader, buf[0..@sizeOf(fuse.InHeader)]);
            const payload = buf[@sizeOf(fuse.InHeader)..@min(n, @max(header.len, @sizeOf(fuse.InHeader)))];

            defer _ = self.arena.reset(.retain_capacity);
            const reply = self.handle(header, payload) catch |err| switch (err) {
                error.HostErrno => Reply{ .err = self.host_errno },
                else => blk: {
                    log.warn("opcode {d} failed: {t}", .{ header.opcode, err });
                    break :blk Reply{ .err = .IO };
                },
            };
            if (try self.sendReply(header.unique, reply) == .unmounted) return;
        }
    }

    fn sendReply(self: *Fs, unique: u64, reply: Reply) !enum { ok, unmounted } {
        const payload: []const u8, const err: i32 = switch (reply) {
            .none => return .ok,
            .err => |e| .{ &.{}, -@as(i32, @backingInt(e)) },
            .data => |d| .{ d, 0 },
        };
        const out: fuse.OutHeader = .{
            .len = @intCast(@sizeOf(fuse.OutHeader) + payload.len),
            .@"error" = err,
            .unique = unique,
        };
        const iov = [_]sys.iovec_const{
            .{ .base = std.mem.asBytes(&out), .len = @sizeOf(fuse.OutHeader) },
            .{ .base = payload.ptr, .len = payload.len },
        };
        // Writes to /dev/fuse are all-or-nothing.
        while (true) {
            const rc = linux.writev(self.fuse_fd, &iov, if (payload.len == 0) 1 else 2);
            switch (linux.errno(rc)) {
                .SUCCESS => return .ok,
                .INTR => continue,
                // ENOENT: the request was interrupted/aborted meanwhile
                .NOENT => return .ok,
                .NODEV => return .unmounted,
                else => |e| {
                    log.err("write fuse reply failed: {t}", .{e});
                    return error.FuseWriteFailed;
                },
            }
        }
    }

    /// Perform an RPC; host errnos surface as `error.HostErrno`.  Without an
    /// RPC port every call fails with `ENOSYS`.
    fn call(self: *Fs, op: []const u8, req: anytype) HandlerError!fs_rpc.Response {
        const rpc = if (self.rpc) |*rpc| rpc else return self.hostErrno(.NOSYS);
        const response = try rpc.call(self.arena.allocator(), op, req);
        if (response.err != .SUCCESS) return self.hostErrno(response.err);
        return response;
    }

    fn hostErrno(self: *Fs, err: E) error{HostErrno} {
        self.host_errno = err;
        return error.HostErrno;
    }

    /// Reply with the bytes of `value` (copied into the request arena).
    fn ok(self: *Fs, value: anytype) Allocator.Error!Reply {
        return .{ .data = try self.arena.allocator().dupe(u8, std.mem.asBytes(&value)) };
    }

    const empty: Reply = .{ .data = &.{} };

    fn handle(self: *Fs, h: fuse.InHeader, payload: []const u8) HandlerError!Reply {
        const op: fuse.Opcode = @fromBackingInt(h.opcode);
        return switch (op) {
            .init => self.init(payload),
            .lookup => self.lookup(h, payload),
            .getattr => self.getattr(h),
            .setattr => self.setattr(h, payload),
            .readlink => .{ .data = try expectText((try self.call("readlink", .{ .ino = h.nodeid })).get("target")) },
            .symlink => self.symlink(h, payload),
            .mkdir => self.mkdir(h, payload),
            .unlink, .rmdir => blk: {
                _ = try self.call(@tagName(op), .{ .parent_ino = h.nodeid, .name = fuse.name(payload)[0] });
                break :blk empty;
            },
            .rename => blk: {
                const req, const names = try fuse.parse(fuse.RenameIn, payload);
                break :blk self.rename(h, req.newdir, 0, names);
            },
            .rename2 => blk: {
                const req, const names = try fuse.parse(fuse.Rename2In, payload);
                if (req.flags != 0) break :blk .{ .err = .OPNOTSUPP };
                break :blk self.rename(h, req.newdir, req.flags, names);
            },
            .link => self.link(h, payload),
            .open => blk: {
                const open, _ = try fuse.parse(fuse.OpenIn, payload);
                const res = try self.call("open", .{ .ino = h.nodeid, .flags = open.flags });
                break :blk self.ok(try openOut(res));
            },
            .opendir => self.ok(fuse.OpenOut{ .fh = h.nodeid, .open_flags = 0 }),
            .readdir => self.readdir(h, payload),
            .read => self.read(payload),
            .write => self.write(payload),
            .create => self.create(h, payload),
            .release => blk: {
                const release, _ = try fuse.parse(fuse.ReleaseIn, payload);
                _ = try self.call("release", .{ .fh = release.fh });
                break :blk empty;
            },
            .releasedir, .fsync, .fsyncdir, .flush, .destroy => empty,
            .access => blk: {
                const access, _ = try fuse.parse(fuse.AccessIn, payload);
                _ = try self.call("access", .{ .ino = h.nodeid, .mask = access.mask, .uid = h.uid, .gid = h.gid });
                break :blk empty;
            },
            .fallocate => blk: {
                const req, _ = try fuse.parse(fuse.FallocateIn, payload);
                _ = try self.call("fallocate", .{ .fh = req.fh, .offset = req.offset, .length = req.length, .mode = req.mode });
                break :blk empty;
            },
            .copy_file_range => blk: {
                const req, _ = try fuse.parse(fuse.CopyFileRangeIn, payload);
                const res = try self.call("copy_file_range", .{
                    .fh_in = req.fh_in,
                    .off_in = req.off_in,
                    .fh_out = req.fh_out,
                    .off_out = req.off_out,
                    .len = req.len,
                    .flags = req.flags,
                });
                break :blk self.ok(fuse.WriteOut{ .size = getU32(res.res, "size") orelse return error.InvalidResponse });
            },
            .statfs => self.statfs(h),
            .forget, .batch_forget, .interrupt => .none,
            .mknod, .setxattr, .getxattr, .listxattr, .removexattr => self.unsupported(h.opcode, .OPNOTSUPP),
            .ioctl => self.unsupported(h.opcode, .NOTTY),
            _ => self.unsupported(h.opcode, .NOSYS),
        };
    }

    fn unsupported(self: *Fs, opcode: u32, err: E) Reply {
        if (opcode < 64 and !self.unsupported_logged.isSet(opcode)) {
            self.unsupported_logged.set(opcode);
            log.warn("unsupported fuse opcode {d} -> {t}", .{ opcode, err });
        } else if (opcode >= 64) {
            log.warn("unsupported fuse opcode {d} -> {t}", .{ opcode, err });
        }
        return .{ .err = err };
    }

    fn init(self: *Fs, payload: []const u8) HandlerError!Reply {
        const in, _ = try fuse.parse(fuse.InitIn, payload);
        // FUSE_ATOMIC_O_TRUNC: the kernel forwards O_TRUNC in OPEN and the host
        // truncates through the opened handle instead of a separate SETATTR.
        return self.ok(fuse.InitOut{
            .major = in.major,
            .minor = in.minor,
            .max_readahead = in.max_readahead,
            .flags = in.flags & (fuse.init_flags.big_writes | fuse.init_flags.atomic_o_trunc),
            .max_write = max_rpc_data,
            .time_gran = 1,
        });
    }

    fn lookup(self: *Fs, h: fuse.InHeader, payload: []const u8) HandlerError!Reply {
        const name = fuse.name(payload)[0];
        if (self.rpc == null) {
            // stub mode: an empty `/data` directory below the root
            if (h.nodeid == fuse.root_id and std.mem.eql(u8, name, "data")) {
                return self.ok(entryOutFromAttr(defaultDirAttr(fuse.root_id + 1), default_attr_ttl_ms, default_entry_ttl_ms));
            }
            return .{ .err = .NOENT };
        }
        const res = try self.call("lookup", .{ .parent_ino = h.nodeid, .name = name });
        return self.ok(try entryOut(res.get("entry")));
    }

    fn getattr(self: *Fs, h: fuse.InHeader) HandlerError!Reply {
        if (self.rpc == null) return self.ok(attrOut(defaultDirAttr(h.nodeid), default_attr_ttl_ms));
        return self.fetchAttr(h.nodeid);
    }

    fn fetchAttr(self: *Fs, ino: u64) HandlerError!Reply {
        const res = try self.call("getattr", .{ .ino = ino });
        const attr = try parseAttr(res.get("attr"), ino);
        return self.ok(attrOut(attr, getU64(res.res, "attr_ttl_ms") orelse default_attr_ttl_ms));
    }

    fn setattr(self: *Fs, h: fuse.InHeader, payload: []const u8) HandlerError!Reply {
        if (self.rpc == null) return .{ .err = .NOSYS };
        const req, _ = try fuse.parse(fuse.SetattrIn, payload);
        if (req.valid & fuse.fattr.mode != 0) {
            _ = self.call("chmod", .{ .ino = h.nodeid, .mode = req.mode & 0o7777 }) catch |err| switch (err) {
                // Hosts without chmod support: mode changes are ignored.
                error.HostErrno => if (self.host_errno != .NOSYS) return err,
                else => return err,
            };
        }
        if (req.valid & fuse.fattr.size != 0) {
            _ = try self.call("truncate", .{ .ino = h.nodeid, .size = req.size });
        }
        // Other attributes (owner, times) are accepted and ignored.
        return self.fetchAttr(h.nodeid);
    }

    fn symlink(self: *Fs, h: fuse.InHeader, payload: []const u8) HandlerError!Reply {
        const name, const rest = fuse.name(payload);
        const res = try self.call("symlink", .{ .parent_ino = h.nodeid, .name = name, .target = fuse.name(rest)[0] });
        return self.ok(try entryOut(res.get("entry")));
    }

    fn mkdir(self: *Fs, h: fuse.InHeader, payload: []const u8) HandlerError!Reply {
        const req, const rest = try fuse.parse(fuse.MkdirIn, payload);
        const res = try self.call("mkdir", .{ .parent_ino = h.nodeid, .name = fuse.name(rest)[0], .mode = req.mode });
        return self.ok(try entryOut(res.get("entry")));
    }

    fn rename(self: *Fs, h: fuse.InHeader, new_parent: u64, flags: u32, names: []const u8) HandlerError!Reply {
        const old_name, const rest = fuse.name(names);
        _ = try self.call("rename", .{
            .old_parent_ino = h.nodeid,
            .old_name = old_name,
            .new_parent_ino = new_parent,
            .new_name = fuse.name(rest)[0],
            .flags = flags,
        });
        return empty;
    }

    fn link(self: *Fs, h: fuse.InHeader, payload: []const u8) HandlerError!Reply {
        const req, const rest = try fuse.parse(fuse.LinkIn, payload);
        const res = try self.call("link", .{ .old_ino = req.oldnodeid, .new_parent_ino = h.nodeid, .new_name = fuse.name(rest)[0] });
        return self.ok(try entryOut(res.get("entry")));
    }

    fn create(self: *Fs, h: fuse.InHeader, payload: []const u8) HandlerError!Reply {
        const req, const rest = try fuse.parse(fuse.CreateIn, payload);
        const name = fuse.name(rest)[0];
        const res = self.call("create", .{ .parent_ino = h.nodeid, .name = name, .mode = req.mode, .flags = req.flags }) catch |err| {
            if (err == error.HostErrno) log.debug("create '{s}' flags=0x{x} failed: {t}", .{ name, req.flags, self.host_errno });
            return err;
        };
        const Out = extern struct { entry: fuse.EntryOut, open: fuse.OpenOut };
        return self.ok(Out{ .entry = try entryOut(res.get("entry")), .open = try openOut(res) });
    }

    fn readdir(self: *Fs, h: fuse.InHeader, payload: []const u8) HandlerError!Reply {
        const req, _ = try fuse.parse(fuse.ReadIn, payload);
        const res = try self.call("readdir", .{ .ino = h.nodeid, .offset = req.offset, .max_entries = @max(1, req.size / 256) });
        const entries = switch (res.get("entries") orelse return error.InvalidResponse) {
            .array => |a| a,
            else => return error.InvalidResponse,
        };

        var out: std.ArrayList(u8) = try .initCapacity(self.arena.allocator(), req.size);
        for (entries) |entry| {
            const name = try expectText(entry.get("name"));
            const record = fuse.direntSize(name.len);
            // The reply must not exceed the requested size; the kernel resumes
            // at the `off` of the last entry returned.
            if (out.items.len + record > req.size) break;
            const dirent: fuse.Dirent = .{
                .ino = getU64(entry, "ino") orelse return error.InvalidResponse,
                .off = getU64(entry, "offset") orelse 0,
                .namelen = @intCast(name.len),
                .type = getU32(entry, "type") orelse 0,
            };
            out.appendSliceAssumeCapacity(std.mem.asBytes(&dirent));
            out.appendSliceAssumeCapacity(name);
            out.appendNTimesAssumeCapacity(0, record - @sizeOf(fuse.Dirent) - name.len);
        }
        return .{ .data = out.items };
    }

    fn read(self: *Fs, payload: []const u8) HandlerError!Reply {
        const req, _ = try fuse.parse(fuse.ReadIn, payload);
        // Fill the whole request: a short reply for a non-EOF region makes the
        // kernel assume EOF and truncates reads, so large reads are split into
        // several RPCs.
        var out: std.ArrayList(u8) = try .initCapacity(self.arena.allocator(), req.size);
        while (out.items.len < req.size) {
            const chunk: u32 = @min(req.size - @as(u32, @intCast(out.items.len)), max_rpc_data);
            const res = try self.call("read", .{ .fh = req.fh, .offset = req.offset + out.items.len, .size = chunk });
            const data = switch (res.get("data") orelse return error.InvalidResponse) {
                .bytes => |b| b,
                else => return error.InvalidResponse,
            };
            const take = @min(data.len, chunk);
            out.appendSliceAssumeCapacity(data[0..take]);
            if (take < chunk) break; // short read: EOF
        }
        return .{ .data = out.items };
    }

    fn write(self: *Fs, payload: []const u8) HandlerError!Reply {
        const req, const data = try fuse.parse(fuse.WriteIn, payload);
        const size: u32 = @intCast(@min(req.size, data.len, max_rpc_data));
        const res = try self.call("write", .{ .fh = req.fh, .offset = req.offset, .data = cbor.Bytes{ .data = data[0..size] } });
        return self.ok(fuse.WriteOut{ .size = getU32(res.res, "size") orelse size });
    }

    fn statfs(self: *Fs, h: fuse.InHeader) HandlerError!Reply {
        const res = self.call("statfs", .{ .ino = h.nodeid }) catch |err| switch (err) {
            error.HostErrno => if (self.host_errno == .NOSYS) return self.ok(default_statfs) else return err,
            else => return err,
        };
        const st = res.get("statfs") orelse return error.InvalidResponse;
        if (st != .map) return error.InvalidResponse;
        var out = default_statfs;
        inline for (.{ "blocks", "bfree", "bavail", "files", "ffree" }) |field| {
            if (getU64(st, field)) |v| @field(out, field) = v;
        }
        inline for (.{ "bsize", "namelen", "frsize" }) |field| {
            if (getU32(st, field)) |v| @field(out, field) = v;
        }
        return self.ok(out);
    }

    /// Fetch the bind mount list from the host and write it newline separated
    /// to `path`.  The file is only created when the host supports `mounts`
    /// so that init can fall back to the kernel command line list.
    fn writeBindsFile(self: *Fs, path: []const u8) !void {
        defer _ = self.arena.reset(.retain_capacity);
        const res = self.call("mounts", .{}) catch |err| switch (err) {
            error.HostErrno => return error.MountsUnavailable,
            else => return err,
        };
        const binds = switch (res.get("binds") orelse return error.InvalidResponse) {
            .array => |a| a,
            else => return error.InvalidResponse,
        };

        var out: std.ArrayList(u8) = .empty;
        for (binds) |entry| {
            const bind = try expectText(entry);
            if (bind.len == 0 or bind[0] != '/' or std.mem.findAny(u8, bind, "\n\x00") != null) return error.InvalidResponse;
            try out.appendSlice(self.arena.allocator(), bind);
            try out.append(self.arena.allocator(), '\n');
        }

        const fd = try sys.open(path, .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true }, 0o644);
        defer sys.close(fd);
        try sys.writeAll(fd, out.items);
        log.info("wrote {d} bind mounts to {s}", .{ binds.len, path });
    }
};

// ---------------------------------------------------------------------------
// Host response → FUSE structs

fn expectText(value: ?cbor.Value) error{InvalidResponse}![]const u8 {
    return switch (value orelse return error.InvalidResponse) {
        .text => |t| t,
        else => error.InvalidResponse,
    };
}

/// Non-negative integer map entry; absent or mistyped values yield null.
fn getU64(map: cbor.Value, key: []const u8) ?u64 {
    return switch (map.get(key) orelse return null) {
        .int => |v| std.math.cast(u64, v),
        else => null,
    };
}

fn getU32(map: cbor.Value, key: []const u8) ?u32 {
    return std.math.cast(u32, getU64(map, key) orelse return null);
}

fn openOut(res: fs_rpc.Response) error{InvalidResponse}!fuse.OpenOut {
    return .{
        .fh = getU64(res.res, "fh") orelse return error.InvalidResponse,
        .open_flags = getU32(res.res, "open_flags") orelse 0,
    };
}

fn entryOut(value: ?cbor.Value) error{InvalidResponse}!fuse.EntryOut {
    const entry = value orelse return error.InvalidResponse;
    if (entry != .map) return error.InvalidResponse;
    const ino = getU64(entry, "ino") orelse return error.InvalidResponse;
    return entryOutFromAttr(
        try parseAttr(entry.get("attr"), ino),
        getU64(entry, "attr_ttl_ms") orelse default_attr_ttl_ms,
        getU64(entry, "entry_ttl_ms") orelse default_entry_ttl_ms,
    );
}

fn parseAttr(value: ?cbor.Value, fallback_ino: u64) error{InvalidResponse}!fuse.Attr {
    const attr = value orelse return error.InvalidResponse;
    if (attr != .map) return error.InvalidResponse;
    const size = getU64(attr, "size") orelse 0;
    const atime = splitMs(getU64(attr, "atime_ms") orelse 0);
    const mtime = splitMs(getU64(attr, "mtime_ms") orelse 0);
    const ctime = splitMs(getU64(attr, "ctime_ms") orelse 0);
    return .{
        .ino = getU64(attr, "ino") orelse fallback_ino,
        .size = size,
        .blocks = getU64(attr, "blocks") orelse (size + 511) / 512,
        .atime = atime.sec,
        .mtime = mtime.sec,
        .ctime = ctime.sec,
        .atimensec = atime.nsec,
        .mtimensec = mtime.nsec,
        .ctimensec = ctime.nsec,
        .mode = getU32(attr, "mode") orelse 0,
        .nlink = getU32(attr, "nlink") orelse 1,
        .uid = getU32(attr, "uid") orelse 0,
        .gid = getU32(attr, "gid") orelse 0,
        .rdev = getU32(attr, "rdev") orelse 0,
        .blksize = getU32(attr, "blksize") orelse 4096,
    };
}

fn entryOutFromAttr(attr: fuse.Attr, attr_ttl_ms: u64, entry_ttl_ms: u64) fuse.EntryOut {
    const attr_ttl = splitMs(attr_ttl_ms);
    const entry_ttl = splitMs(entry_ttl_ms);
    return .{
        .nodeid = attr.ino,
        .generation = 0,
        .entry_valid = entry_ttl.sec,
        .attr_valid = attr_ttl.sec,
        .entry_valid_nsec = entry_ttl.nsec,
        .attr_valid_nsec = attr_ttl.nsec,
        .attr = attr,
    };
}

fn attrOut(attr: fuse.Attr, ttl_ms: u64) fuse.AttrOut {
    const ttl = splitMs(ttl_ms);
    return .{ .attr_valid = ttl.sec, .attr_valid_nsec = ttl.nsec, .attr = attr };
}

fn splitMs(ms: u64) struct { sec: u64, nsec: u32 } {
    return .{ .sec = ms / 1000, .nsec = @intCast((ms % 1000) * std.time.ns_per_ms) };
}

fn defaultDirAttr(ino: u64) fuse.Attr {
    return .{
        .ino = ino,
        .size = 0,
        .blocks = 0,
        .atime = 0,
        .mtime = 0,
        .ctime = 0,
        .atimensec = 0,
        .mtimensec = 0,
        .ctimensec = 0,
        .mode = 0o40755,
        .nlink = 2,
        .uid = 0,
        .gid = 0,
        .rdev = 0,
        .blksize = 4096,
    };
}

const default_statfs: fuse.StatfsOut = .{
    .blocks = 16_777_216,
    .bfree = 16_777_216,
    .bavail = 16_777_216,
    .files = 16_777_216,
    .ffree = 16_777_216,
    .bsize = 4096,
    .namelen = 255,
    .frsize = 4096,
};

test "attribute parsing applies defaults" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var buf: [128]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try cbor.encode(&w, .{ .ino = @as(u64, 9), .attr = .{ .size = @as(u64, 1000), .mode = @as(u32, 0o100644), .mtime_ms = @as(u64, 1500) } });
    const value = try cbor.decode(arena, w.buffered());

    const entry = try entryOut(value);
    try std.testing.expectEqual(@as(u64, 9), entry.nodeid);
    try std.testing.expectEqual(@as(u64, 9), entry.attr.ino);
    try std.testing.expectEqual(@as(u64, 2), entry.attr.blocks);
    try std.testing.expectEqual(@as(u64, 1), entry.attr.mtime);
    try std.testing.expectEqual(@as(u32, 500_000_000), entry.attr.mtimensec);
    try std.testing.expectEqual(@as(u32, 1), entry.attr.nlink);
    try std.testing.expectEqual(@as(u64, 1), entry.entry_valid);
    try std.testing.expectError(error.InvalidResponse, entryOut(null));
}
