//! gzip decoder of image archives: arbitrary bytes never panic, and every
//! stream we frame around miniz_oxide's deflate (optionally corrupted at one
//! byte) decodes to the input or fails cleanly.
#![no_main]

use std::io::Read;

use gondolin_assets::archive::{crc32::Crc32, gzip::GzipReader};
use libfuzzer_sys::fuzz_target;

fn decode(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    GzipReader::new(bytes).take(16 << 20).read_to_end(&mut out)?;
    Ok(out)
}

fuzz_target!(|data: &[u8]| {
    let Some((&control, rest)) = data.split_first() else { return };
    let _ = decode(rest);
    // round trip: control selects level, a header flag and a corruption offset
    let level = control % 10;
    let mut gz = vec![0x1f, 0x8b, 8, if control & 0x10 != 0 { 8 } else { 0 }, 0, 0, 0, 0, 0, 3];
    if control & 0x10 != 0 {
        gz.extend_from_slice(b"name\0");
    }
    gz.extend(miniz_oxide::deflate::compress_to_vec(rest, level));
    let mut crc = Crc32::new();
    crc.update(rest);
    gz.extend(crc.value().to_le_bytes());
    gz.extend((rest.len() as u32).to_le_bytes());
    assert_eq!(decode(&gz).expect("valid stream"), rest);
    if control & 0x20 != 0 && !gz.is_empty() {
        let at = (control as usize * 7919 + rest.len()) % gz.len();
        gz[at] ^= 0x5a;
        if let Ok(out) = decode(&gz) {
            // corruption in an ignored field (MTIME/OS/name) only
            assert_eq!(out, rest);
        }
    }
});
