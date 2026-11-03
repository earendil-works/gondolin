//! Test root for the executable-specific code (built as `sandboxd-exe-tests`).

test {
    _ = @import("sandboxd/main.zig");
    _ = @import("sandboxfs/main.zig");
}
