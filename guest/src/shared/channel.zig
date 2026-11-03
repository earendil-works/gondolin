//! Non-blocking virtio-serial endpoint for poll-driven event loops.
//!
//! Combines the port fd with a `FrameReader` and an `Outbox` and tracks
//! whether the host end is connected.  virtio-serial reports a missing host
//! connection as EOF on `read(2)` and as a permanent `POLLHUP`, so while
//! disconnected the fd must be left out of the poll set (otherwise poll spins)
//! and is re-probed periodically instead.

const std = @import("std");
const sys = @import("sys.zig");
const framing = @import("framing.zig");

const Allocator = std.mem.Allocator;

/// Poll interval while the host end is disconnected in `ms`
pub const reconnect_poll_ms: i32 = 100;

pub const Channel = struct {
    fd: sys.fd_t,
    reader: framing.FrameReader = .{},
    outbox: framing.Outbox,
    /// host end connected (cleared on EOF/POLLHUP, set again once HUP clears)
    connected: bool = true,

    pub const Readiness = enum {
        /// keep going (new frames may be available in `reader`)
        ok,
        /// host end just went away
        disconnected,
    };

    pub fn init(gpa: Allocator, fd: sys.fd_t) Channel {
        return .{ .fd = fd, .outbox = .init(gpa) };
    }

    pub fn deinit(self: *Channel, gpa: Allocator) void {
        self.reader.deinit(gpa);
        self.outbox.deinit();
    }

    /// Events to poll for, or null when the fd must not be polled.
    pub fn pollEvents(self: *const Channel) ?i16 {
        if (!self.connected) return null;
        var events: i16 = sys.POLL.IN;
        if (self.outbox.pending() > 0) events |= sys.POLL.OUT;
        return events;
    }

    /// Process poll results: flush when writable, perform one read when
    /// readable.  Complete frames are then available via `reader.next()`.
    pub fn onReady(self: *Channel, gpa: Allocator, revents: i16) Allocator.Error!Readiness {
        if (revents & sys.POLL.OUT != 0) {
            if (self.flush() == .disconnected) return .disconnected;
        }
        if (revents & sys.POLL.IN != 0) {
            const result = self.reader.fill(gpa, self.fd) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => {
                    std.log.scoped(.channel).err("virtio read failed: {t}", .{err});
                    return self.markDisconnected();
                },
            };
            switch (result) {
                .data, .would_block => {},
                .eof => return self.markDisconnected(),
            }
        } else if (revents & (sys.POLL.HUP | sys.POLL.ERR) != 0) {
            return self.markDisconnected();
        }
        return .ok;
    }

    /// Opportunistically drain the outbox.
    pub fn flush(self: *Channel) Readiness {
        if (!self.connected) return .ok;
        self.outbox.flush(self.fd) catch |err| {
            std.log.scoped(.channel).err("virtio write failed: {t}", .{err});
            return self.markDisconnected();
        };
        return .ok;
    }

    /// While disconnected: check (without blocking) whether the host is back.
    pub fn probeReconnect(self: *Channel) bool {
        if (self.connected) return true;
        const revents = sys.pollOne(self.fd, sys.POLL.IN | sys.POLL.OUT, 0) catch return false;
        if (revents != 0 and revents & sys.POLL.HUP == 0) {
            self.connected = true;
            std.log.scoped(.channel).info("virtio port reconnected", .{});
        }
        return self.connected;
    }

    fn markDisconnected(self: *Channel) Readiness {
        if (!self.connected) return .ok;
        self.connected = false;
        // A partially received frame cannot be completed by a new connection.
        self.reader.reset();
        std.log.scoped(.channel).info("virtio port closed, waiting for reconnect", .{});
        return .disconnected;
    }
};
