/** Arguments for a paused QEMU instance with no accelerator fallback. */
export function buildAccelProbeArgs(accel: string): string[] {
  // WHPX initializes an x86 machine, not QEMU's architecture-neutral `none`
  // machine. Use the same q35 board as Windows x64 guests; otherwise a
  // working WHPX installation can fail the probe and silently select TCG.
  const machine = accel.split(",", 1)[0]!.trim().toLowerCase() === "whpx"
    ? "q35"
    : "none";
  return [
    "-accel", accel,
    "-machine", machine,
    "-nodefaults",
    "-display", "none",
    "-S",
  ];
}
