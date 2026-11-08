//! The DER reader egress uses on CA certificates and keys (subject, public
//! key, key identifier extraction) on arbitrary bytes, and issuing under a
//! parsed name must never panic.
#![no_main]

use gondolin_egress::x509;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Ok(info) = x509::parse_certificate(data) {
        let _ = x509::key_identifier(&info.spki);
        assert!(data.windows(info.subject.len()).any(|w| w == info.subject.as_slice()));
    }
    let _ = x509::key_identifier(data);
    if let Some(children) = x509::read(data).and_then(|(el, _)| x509::children(el.content)) {
        for c in children {
            assert!(c.raw.len() >= c.content.len());
        }
    }
    let _ = x509::encode_time(
        i64::from_le_bytes(data.get(..8).and_then(|b| b.try_into().ok()).unwrap_or_default())
            % (400 * 366 * 86_400 * 25),
    );
    let _ = x509::subject_alt_name(&String::from_utf8_lossy(data));
});
