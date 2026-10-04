//! Hand-written bindings for the subset of `libkrun.h` used by the runner.
//!
//! Zig 0.17 removed `@cImport`, so these declarations mirror the libkrun C
//! API directly. Keep them in sync with the pinned libkrun version
//! (`LIBKRUN_VERSION` in the top-level Makefile).

pub const LOG_TARGET_DEFAULT: c_int = -1;
pub const LOG_LEVEL_WARN: u32 = 2;
pub const LOG_STYLE_NEVER: u32 = 2;

pub const DISK_FORMAT_RAW: u32 = 0;
pub const DISK_FORMAT_QCOW2: u32 = 1;

pub const KERNEL_FORMAT_RAW: u32 = 0;
pub const KERNEL_FORMAT_ELF: u32 = 1;
pub const KERNEL_FORMAT_PE_GZ: u32 = 2;
pub const KERNEL_FORMAT_IMAGE_BZ2: u32 = 3;
pub const KERNEL_FORMAT_IMAGE_GZ: u32 = 4;
pub const KERNEL_FORMAT_IMAGE_ZSTD: u32 = 5;

pub const NET_FEATURE_CSUM: u32 = 1 << 0;
pub const NET_FEATURE_GUEST_CSUM: u32 = 1 << 1;
pub const NET_FEATURE_GUEST_TSO4: u32 = 1 << 7;
pub const NET_FEATURE_GUEST_TSO6: u32 = 1 << 8;
pub const NET_FEATURE_GUEST_UFO: u32 = 1 << 10;
pub const NET_FEATURE_HOST_TSO4: u32 = 1 << 11;
pub const NET_FEATURE_HOST_TSO6: u32 = 1 << 12;
pub const NET_FEATURE_HOST_UFO: u32 = 1 << 14;

pub const COMPAT_NET_FEATURES: u32 = NET_FEATURE_CSUM | NET_FEATURE_GUEST_CSUM |
    NET_FEATURE_GUEST_TSO4 | NET_FEATURE_GUEST_UFO |
    NET_FEATURE_HOST_TSO4 | NET_FEATURE_HOST_UFO;

pub extern fn krun_init_log(target_fd: c_int, level: u32, style: u32, options: u32) i32;
pub extern fn krun_create_ctx() i32;
pub extern fn krun_free_ctx(ctx_id: u32) i32;
pub extern fn krun_set_vm_config(ctx_id: u32, num_vcpus: u8, ram_mib: u32) i32;
pub extern fn krun_set_kernel(
    ctx_id: u32,
    kernel_path: [*:0]const u8,
    kernel_format: u32,
    initramfs: ?[*:0]const u8,
    cmdline: ?[*:0]const u8,
) i32;
pub extern fn krun_set_console_output(ctx_id: u32, c_filepath: [*:0]const u8) i32;
pub extern fn krun_add_disk2(
    ctx_id: u32,
    block_id: [*:0]const u8,
    disk_path: [*:0]const u8,
    disk_format: u32,
    read_only: bool,
) i32;
pub extern fn krun_add_net_unixstream(
    ctx_id: u32,
    c_path: ?[*:0]const u8,
    fd: c_int,
    c_mac: *const [6]u8,
    features: u32,
    flags: u32,
) i32;
pub extern fn krun_add_virtio_console_multiport(ctx_id: u32) i32;
pub extern fn krun_add_console_port_inout(
    ctx_id: u32,
    console_id: u32,
    name: [*:0]const u8,
    input_fd: c_int,
    output_fd: c_int,
) i32;
pub extern fn krun_start_enter(ctx_id: u32) i32;
