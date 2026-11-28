//! WHPX runtime detection. A build advertising `whpx` is not evidence that
//! Windows can initialize it. In particular WHPX requires an x86 board: the
//! architecture-neutral `none` machine used by older probes is invalid.
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

pub const PROBE_ARGS: &[&str] = &[
    "-accel",
    "whpx",
    "-machine",
    "q35",
    "-cpu",
    "qemu64",
    "-nodefaults",
    "-display",
    "none",
    "-S",
    "-qmp",
    "stdio",
];

/// Confirms QMP initialization with WHPX as the only accelerator. A timeout
/// is a failure, not evidence that a stalled/crashed process is accelerated.
pub fn available(qemu: &str) -> bool {
    let mut command = Command::new(qemu);
    command.args(PROBE_ARGS).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let Ok(mut child) = command.spawn() else { return false };
    let input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let _ = tx.send(handshake(input, output));
    });
    let available = rx.recv_timeout(Duration::from_secs(5)).unwrap_or(false);
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    available
}

fn handshake(mut input: impl Write, output: impl Read) -> bool {
    let mut reader = BufReader::new(output.take(64 * 1024));
    let mut greeting = false;
    let mut line = String::new();
    for _ in 0..16 {
        line.clear();
        if reader.read_line(&mut line).ok().filter(|n| *n > 0).is_none() {
            break;
        }
        let Ok(message) = gondolin_wire::json::parse(line.trim()) else { break };
        if !greeting && message.get("QMP").is_some() {
            greeting = true;
            if input.write_all(b"{\"execute\":\"qmp_capabilities\",\"id\":\"probe\"}\n").is_err() {
                break;
            }
        } else if greeting && message.get("id").and_then(|v| v.as_text()) == Some("probe") {
            return message.get("return").is_some() && message.get("error").is_none();
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn probe_requires_q35_and_has_no_tcg_fallback() {
        assert_eq!(PROBE_ARGS[0..4], ["-accel", "whpx", "-machine", "q35"]);
        assert!(!PROBE_ARGS.contains(&"tcg"));
        assert!(PROBE_ARGS.windows(2).any(|p| p == ["-qmp", "stdio"]));
    }
    #[test]
    fn a_live_process_or_greeting_without_capabilities_is_not_success() {
        for output in [
            "",
            "not JSON\n",
            "{\"QMP\":{}}\n",
            "{\"return\":{},\"id\":\"probe\"}\n",
            "{\"QMP\":{}}\n{\"error\":{},\"id\":\"probe\"}\n",
        ] {
            assert!(!handshake(Vec::new(), output.as_bytes()), "{output}");
        }
        let mut input = Vec::new();
        assert!(handshake(
            &mut input,
            b"{\"QMP\":{}}\n{\"event\":\"RESUME\"}\n{\"return\":{},\"id\":\"probe\"}\n".as_slice()
        ));
        assert_eq!(input, b"{\"execute\":\"qmp_capabilities\",\"id\":\"probe\"}\n");
    }

    #[test]
    fn missing_qemu_is_unavailable() {
        assert!(!available("gondolin-no-such-qemu-binary"));
    }
}
