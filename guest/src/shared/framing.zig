//! Length-prefixed framing used on every virtio-serial port.
//!
//! A frame is a big-endian `u32` payload length followed by that many payload
//! bytes.  Payloads larger than `protocol.max_frame_len` are rejected: an
//! oversized incoming frame is skipped (the stream stays in sync) and reported
//! once as `error.FrameTooLarge`.
//!
//! - `FrameReader` incrementally reassembles frames from a non-blocking fd.
//! - `Outbox` queues encoded outgoing frames and drains them to a non-blocking
//!   fd as it becomes writable.  Callers use `pending()` to apply
//!   backpressure (stop producing while the queue is above a high-water mark).
//! - `readFrame`/`writeFrame` are the blocking variants used by the
//!   synchronous `sandboxfs` RPC client.

const std = @import("std");
const sys = @import("sys.zig");
const protocol = @import("protocol.zig");

const Allocator = std.mem.Allocator;
const max_frame_len = protocol.max_frame_len;

/// Bytes requested from the kernel per `read(2)` in `bytes`
const read_chunk: usize = 64 * 1024;

pub const FrameReader = struct {
    /// buffered input; `buf.items[start..]` is unconsumed
    buf: std.ArrayList(u8) = .empty,
    /// offset of the first unconsumed byte in `buf`
    start: usize = 0,
    /// payload bytes of an oversized frame still to be discarded
    skip: usize = 0,

    pub const FillResult = enum { data, would_block, eof };

    pub fn deinit(self: *FrameReader, gpa: Allocator) void {
        self.buf.deinit(gpa);
        self.* = .{};
    }

    /// Drop buffered partial input (e.g. after the peer disconnected).
    pub fn reset(self: *FrameReader) void {
        self.buf.clearRetainingCapacity();
        self.start = 0;
        self.skip = 0;
    }

    /// Perform one `read(2)` from `fd` into the buffer.  Invalidates slices
    /// previously returned by `next`.
    pub fn fill(self: *FrameReader, gpa: Allocator, fd: sys.fd_t) (Allocator.Error || sys.ReadError)!FillResult {
        if (self.start > 0) {
            const rest = self.buf.items[self.start..];
            std.mem.copyForwards(u8, self.buf.items[0..rest.len], rest);
            self.buf.items.len = rest.len;
            self.start = 0;
        }
        try self.buf.ensureUnusedCapacity(gpa, read_chunk);
        const n = sys.read(fd, self.buf.unusedCapacitySlice()) catch |err| switch (err) {
            error.WouldBlock => return .would_block,
            else => return err,
        };
        if (n == 0) return .eof;
        self.buf.items.len += n;
        return .data;
    }

    /// Feed bytes directly (used by tests and fuzzers).
    pub fn feed(self: *FrameReader, gpa: Allocator, bytes: []const u8) Allocator.Error!void {
        try self.buf.appendSlice(gpa, bytes);
    }

    /// Return the next complete frame payload, or null if more input is
    /// needed.  The slice stays valid until the next `fill`/`feed`.
    pub fn next(self: *FrameReader) error{FrameTooLarge}!?[]const u8 {
        if (self.skip > 0) {
            const n = @min(self.skip, self.buf.items.len - self.start);
            self.start += n;
            self.skip -= n;
            if (self.skip > 0) return null;
        }
        const avail = self.buf.items[self.start..];
        if (avail.len < 4) return null;
        const len = std.mem.readInt(u32, avail[0..4], .big);
        if (len > max_frame_len) {
            self.start += 4;
            self.skip = len;
            return error.FrameTooLarge;
        }
        if (avail.len - 4 < len) return null;
        self.start += 4 + len;
        return avail[4..][0..len];
    }
};

pub const Outbox = struct {
    /// encoded frames; `aw.writer.buffered()[head..]` is unsent
    aw: std.Io.Writer.Allocating,
    /// bytes of the buffer already written to the fd
    head: usize = 0,

    pub const Error = Allocator.Error || error{FrameTooLarge};

    pub fn init(gpa: Allocator) Outbox {
        return .{ .aw = .init(gpa) };
    }

    pub fn deinit(self: *Outbox) void {
        self.aw.deinit();
    }

    /// Unsent bytes in `bytes`.
    pub fn pending(self: *const Outbox) usize {
        return self.aw.writer.end - self.head;
    }

    pub fn clear(self: *Outbox) void {
        self.aw.writer.end = 0;
        self.head = 0;
    }

    /// Queue one message with a typed payload.
    pub fn send(self: *Outbox, comptime tag: protocol.Tag, id: u32, payload: protocol.Payload(tag)) Error!void {
        return self.sendRaw(@tagName(tag), id, payload);
    }

    /// Queue one message with an arbitrary payload value.
    pub fn sendRaw(self: *Outbox, t: []const u8, id: u32, payload: anytype) Error!void {
        self.compact();
        const w = &self.aw.writer;
        const start = w.end;
        errdefer w.end = start;
        w.writeAll(&.{ 0, 0, 0, 0 }) catch return error.OutOfMemory;
        protocol.encodeRaw(w, t, id, payload) catch return error.OutOfMemory;
        const len = w.end - start - 4;
        if (len > max_frame_len) return error.FrameTooLarge;
        std.mem.writeInt(u32, w.buffer[start..][0..4], @intCast(len), .big);
    }

    /// Write as much as possible to a non-blocking `fd`.
    pub fn flush(self: *Outbox, fd: sys.fd_t) sys.WriteError!void {
        while (self.pending() > 0) {
            const n = sys.write(fd, self.aw.writer.buffered()[self.head..]) catch |err| switch (err) {
                error.WouldBlock => return,
                else => return err,
            };
            if (n == 0) return;
            self.head += n;
        }
        self.clear();
    }

    /// Reclaim the sent prefix once it dominates the buffer so memory stays
    /// proportional to the unsent data.
    fn compact(self: *Outbox) void {
        if (self.head == 0) return;
        const w = &self.aw.writer;
        if (self.head == w.end) return self.clear();
        if (self.head < 64 * 1024 or self.head < w.end / 2) return;
        const rest = w.buffer[self.head..w.end];
        std.mem.copyForwards(u8, w.buffer[0..rest.len], rest);
        w.end = rest.len;
        self.head = 0;
    }
};

/// Blocking: write one frame with a single `writev(2)` sequence.
pub fn writeFrame(fd: sys.fd_t, payload: []const u8) (sys.WriteError || error{FrameTooLarge})!void {
    if (payload.len > max_frame_len) return error.FrameTooLarge;
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(payload.len), .big);
    var iov = [_]sys.iovec_const{
        .{ .base = &header, .len = header.len },
        .{ .base = payload.ptr, .len = payload.len },
    };
    try sys.writevAll(fd, &iov);
}

/// Blocking: read one frame into `buf` (replacing its contents).
pub fn readFrame(gpa: Allocator, fd: sys.fd_t, buf: *std.ArrayList(u8)) (Allocator.Error || sys.ReadError || error{ EndOfStream, FrameTooLarge })![]u8 {
    var header: [4]u8 = undefined;
    try readExact(fd, &header);
    const len = std.mem.readInt(u32, &header, .big);
    if (len > max_frame_len) return error.FrameTooLarge;
    buf.clearRetainingCapacity();
    try buf.resize(gpa, len);
    try readExact(fd, buf.items);
    return buf.items;
}

pub fn readExact(fd: sys.fd_t, out: []u8) (sys.ReadError || error{EndOfStream})!void {
    var offset: usize = 0;
    while (offset < out.len) {
        const n = try sys.read(fd, out[offset..]);
        if (n == 0) return error.EndOfStream;
        offset += n;
    }
}

const testing = std.testing;

test "frame reader reassembles split frames and skips oversized ones" {
    var r: FrameReader = .{};
    defer r.deinit(testing.allocator);

    try r.feed(testing.allocator, &.{ 0, 0, 0, 3, 'a' });
    try testing.expect(try r.next() == null);
    try r.feed(testing.allocator, &.{ 'b', 'c', 0, 0, 0, 0 });
    try testing.expectEqualStrings("abc", (try r.next()).?);
    try testing.expectEqualStrings("", (try r.next()).?);
    try testing.expect(try r.next() == null);

    // oversized frame: header announces max+1 bytes; the payload is dropped
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, max_frame_len + 1, .big);
    try r.feed(testing.allocator, &header);
    try testing.expectError(error.FrameTooLarge, r.next());
    const junk = try testing.allocator.alloc(u8, max_frame_len + 1);
    defer testing.allocator.free(junk);
    @memset(junk, 0xff);
    try r.feed(testing.allocator, junk[0 .. junk.len / 2]);
    try testing.expect(try r.next() == null);
    try r.feed(testing.allocator, junk[junk.len / 2 ..]);
    try r.feed(testing.allocator, &.{ 0, 0, 0, 1, 'z' });
    try testing.expectEqualStrings("z", (try r.next()).?);
}

test "outbox frames messages and drains to a pipe" {
    var outbox: Outbox = .init(testing.allocator);
    defer outbox.deinit();
    try outbox.send(.tcp_close, 5, .{});
    try outbox.send(.tcp_data, 6, .{ .data = .{ .data = "hello" } });

    const fds = try sys.pipe(true);
    defer sys.close(fds[0]);
    defer sys.close(fds[1]);
    try outbox.flush(fds[1]);
    try testing.expectEqual(@as(usize, 0), outbox.pending());

    var reader: FrameReader = .{};
    defer reader.deinit(testing.allocator);
    try testing.expectEqual(FrameReader.FillResult.data, try reader.fill(testing.allocator, fds[0]));

    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const first = try protocol.Envelope.decode(arena_state.allocator(), (try reader.next()).?);
    try testing.expectEqual(protocol.Tag.tcp_close, first.tag().?);
    const second = try protocol.Envelope.decode(arena_state.allocator(), (try reader.next()).?);
    try testing.expectEqualStrings("hello", (try second.payload(arena_state.allocator(), .tcp_data)).data.data);
    try testing.expect(try reader.next() == null);
    try testing.expectEqual(FrameReader.FillResult.would_block, try reader.fill(testing.allocator, fds[0]));
}
