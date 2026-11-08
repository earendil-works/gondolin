//! Key files written by OpenSSH's `ssh-keygen` (fixtures in `tests/keys/`,
//! passphrase `secret pass`): every format decodes to the key in the
//! matching `.pub` file and signs verifiably.

use gondolin_sshproxy::ssh::{PublicKey, decode_secret_key};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/keys");

fn check(name: &str, passphrase: Option<&str>) {
    let text = std::fs::read_to_string(format!("{DIR}/{name}")).unwrap();
    let public = std::fs::read_to_string(format!("{DIR}/{name}.pub")).unwrap();
    let key = decode_secret_key(&text, passphrase).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert_eq!(key.public_key(), &PublicKey::parse_openssh(&public).unwrap(), "{name}");
    for alg in key.signature_algorithms() {
        let sig = key.sign(alg, b"exchange hash").unwrap();
        key.public_key()
            .verify(alg, b"exchange hash", &sig)
            .unwrap_or_else(|e| panic!("{name} {alg}: {e}"));
        assert!(key.public_key().verify(alg, b"other data", &sig).is_err());
    }
    // re-encoded (unencrypted OpenSSH format) it stays the same key
    let again = decode_secret_key(&key.to_openssh(), None).unwrap();
    assert_eq!(again.public_key(), key.public_key());
}

#[test]
fn openssh_format() {
    check("ed25519", None);
    check("ecdsa256", None);
    check("rsa2048", None);
}

#[test]
fn openssh_format_encrypted() {
    for name in [
        "ed25519-aes256-ctr",
        "ed25519-aes192-ctr",
        "ed25519-aes128-gcm",
        "ecdsa384-aes128-cbc",
        "rsa3072-aes256-gcm",
    ] {
        check(name, Some("secret pass"));
        let text = std::fs::read_to_string(format!("{DIR}/{name}")).unwrap();
        let wrong = decode_secret_key(&text, Some("wrong")).unwrap_err().to_string();
        assert_eq!(wrong, "wrong passphrase", "{name}");
        let missing = decode_secret_key(&text, None).unwrap_err().to_string();
        assert!(missing.contains("passphrase"), "{name}: {missing}");
    }
}

#[test]
fn pem_formats() {
    check("rsa-pem", None);
    check("ecdsa-pem", None);
    check("rsa-pem-enc", Some("secret pass"));
    check("ecdsa-pem-enc", Some("secret pass"));
    check("rsa-pkcs8", None);
    check("ecdsa-pkcs8", None);
    let text = std::fs::read_to_string(format!("{DIR}/rsa-pem-enc")).unwrap();
    assert!(decode_secret_key(&text, Some("wrong")).is_err());
}

#[test]
fn ed25519_pkcs8() {
    // RFC 8410 example key
    let seed = hex("d4ee72dbf913584ad5b6d8f1f769f8ad3afe7c28cbf1d4fbe097a88f44755842");
    let mut der = hex("302e020100300506032b657004220420");
    der.extend_from_slice(&seed);
    let pem = format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        gondolin_wire::base64::encode(&der)
    );
    let key = decode_secret_key(&pem, None).unwrap();
    let PublicKey::Ed25519(pk) = key.public_key() else { panic!() };
    assert_eq!(
        pk.to_vec(),
        hex("19bf44096984cdfe8541bac167dc3b96c85086aa30b6b6cb0c5c38ad703166e1")
    );
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
