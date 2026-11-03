//! Fuzz targets shared by the `*_fuzz_test.zig` fuzzers and the `*_repro.zig`
//! reproducers so both exercise exactly the same code.

const std = @import("std");
const shared = @import("shared");
const file_requests = @import("file_requests");

const cbor = shared.cbor;
const protocol = shared.protocol;
const Allocator = std.mem.Allocator;

/// Decode arbitrary bytes as one CBOR item.
pub fn cborOne(gpa: Allocator, input: []const u8) void {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const value = cbor.decode(arena.allocator(), input) catch return;
    std.mem.doNotOptimizeAway(value);
}

/// Message types the guest parses.
const inbound_tags = [_]protocol.Tag{
    .exec_request,      .stdin_data,         .pty_resize,      .exec_window,
    .file_read_request, .file_write_request, .file_write_data, .file_delete_request,
    .time_sync,         .fs_response,        .tcp_open,        .tcp_data,
    .tcp_eof,           .tcp_close,
};

fn decodeAll(arena: Allocator, frame: []const u8) void {
    const env = protocol.Envelope.decode(arena, frame) catch return;
    std.mem.doNotOptimizeAway(env.tag());
    _ = env.id() catch {};
    inline for (inbound_tags) |tag| {
        if (env.payload(arena, tag)) |payload| {
            std.mem.doNotOptimizeAway(&payload);
        } else |_| {}
    }
}

/// Parse the input as one message payload, and as a stream of frames.
pub fn protocolOne(gpa: Allocator, input: []const u8) void {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    decodeAll(arena.allocator(), input);

    var reader: shared.framing.FrameReader = .{};
    defer reader.deinit(gpa);
    reader.feed(gpa, input) catch return;
    while (true) {
        const frame = reader.next() catch continue orelse break;
        decodeAll(arena.allocator(), frame);
    }
}

/// Clamp every length prefix so frames stay within the input and below
/// `max_frame` (avoids spending iterations on truncated giant frames).
pub fn sanitizeFramedInput(buf: []u8, max_frame: usize) void {
    var off: usize = 0;
    while (buf.len - off > 4) {
        const len = std.mem.readInt(u32, buf[off..][0..4], .big);
        const new_len: u32 = @intCast(@min(len, max_frame, buf.len - off - 4));
        std.mem.writeInt(u32, buf[off..][0..4], new_len, .big);
        off += 4 + new_len;
    }
}

/// Run a framed stream of file requests against `root_dir`.
pub fn sandboxOne(gpa: Allocator, root_dir: []const u8, input: []u8) void {
    sanitizeFramedInput(input, 16 * 1024);

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    var transfers: file_requests.Transfers = .init(gpa, root_dir);
    defer transfers.deinit();
    var outbox: shared.framing.Outbox = .init(gpa);
    defer outbox.deinit();
    var reader: shared.framing.FrameReader = .{};
    defer reader.deinit(gpa);
    reader.feed(gpa, input) catch return;

    while (true) {
        const frame = reader.next() catch continue orelse break;
        defer _ = arena.reset(.retain_capacity);
        const a = arena.allocator();
        const env = protocol.Envelope.decode(a, frame) catch continue;
        const id = env.id() catch continue;
        switch (env.tag() orelse continue) {
            .file_read_request => {
                const req = env.payload(a, .file_read_request) catch continue;
                transfers.startRead(id, req) catch continue;
            },
            .file_write_request => {
                const req = env.payload(a, .file_write_request) catch continue;
                transfers.startWrite(id, req) catch continue;
            },
            .file_write_data => {
                if (!transfers.isWriting(id)) continue;
                const chunk = env.payload(a, .file_write_data) catch {
                    transfers.abortWrite(id);
                    continue;
                };
                _ = transfers.writeData(id, chunk) catch continue;
            },
            .file_delete_request => {
                const req = env.payload(a, .file_delete_request) catch continue;
                transfers.delete(req) catch continue;
            },
            else => {},
        }
        while (transfers.hasPendingReads()) {
            transfers.pumpReads(&outbox) catch break;
            outbox.clear();
        }
    }
}
