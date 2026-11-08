//! SSH key material from configuration and peers: private key files (OpenSSH,
//! PEM, PKCS#8), public key blobs and lines, signatures, agent replies.
#![no_main]

use gondolin_sshproxy::ssh::agent;
use gondolin_sshproxy::ssh::{PrivateKey, PublicKey, decode_secret_key};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let _ = decode_secret_key(&text, None);
    for armor in ["OPENSSH PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "PRIVATE KEY"] {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        let pem = format!("-----BEGIN {armor}-----\n{b64}\n-----END {armor}-----\n");
        let _ = decode_secret_key(&pem, None);
    }
    if let Ok(key) = PublicKey::from_blob(data) {
        assert_eq!(PublicKey::from_blob(&key.to_blob()).unwrap(), key);
        let _ = PublicKey::parse_openssh(&key.to_openssh()).unwrap();
        for alg in key.signature_algorithms() {
            let _ = key.verify(alg, b"data", data);
        }
    }
    let _ = PublicKey::parse_openssh(&text);
    let signer = PrivateKey::from_ed25519_seed(&[1; 32]);
    let _ = signer.public_key().verify("ssh-ed25519", b"data", data);
    let _ = agent::parse_identities(data);
    let _ = agent::parse_sign_response(data);
});
