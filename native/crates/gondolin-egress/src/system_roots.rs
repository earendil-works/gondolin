//! The system's trusted root certificates as PEM files (what
//! `use_system_roots` adds to the upstream trust store).
//!
//! - `SSL_CERT_FILE` / `SSL_CERT_DIR` (`:`-separated) replace the defaults
//!   when set (OpenSSL's convention).
//! - Otherwise Linux and the BSDs use the first existing distribution bundle
//!   (the `openssl-probe` list), or the certificate directories when there is
//!   no bundle; macOS uses `/etc/ssl/cert.pem`, the system roots as a PEM
//!   bundle.
//! - `NODE_EXTRA_CA_CERTS` is always added (like node).
//!
//! The macOS keychain is not read: roots installed only there (e.g. a
//! corporate TLS proxy's CA) must be exported to `NODE_EXTRA_CA_CERTS` or
//! `SSL_CERT_FILE`. That matches the node engine, whose default CA store
//! does not read the keychain either, and avoids evaluating keychain trust
//! settings (which `security find-certificate` output does not carry).

use std::path::{Path, PathBuf};

/// Distribution CA bundles, most common first (`openssl-probe`)
const BUNDLE_FILES: &[&str] = &[
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/ssl/ca-bundle.pem",
    "/etc/pki/tls/cacert.pem",
    "/etc/ssl/cert.pem",
    "/usr/local/share/certs/ca-root-nss.crt",
    "/usr/local/etc/openssl/cert.pem",
    "/opt/local/etc/openssl/cert.pem",
    "/etc/certs/ca-certificates.crt",
    "/system/etc/security/cacerts",
];

/// Certificate directories used when no bundle file exists
const CERT_DIRS: &[&str] = &["/etc/ssl/certs", "/etc/pki/tls/certs", "/etc/certs"];

/// Max size of one certificate file in `bytes`
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

fn env_path(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// The files holding the system roots.
pub fn files() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let file = env_path("SSL_CERT_FILE");
    let dirs = env_path("SSL_CERT_DIR");
    if file.is_some() || dirs.is_some() {
        out.extend(file.map(PathBuf::from));
        for dir in dirs.iter().flat_map(|d| d.split(':')) {
            out.extend(dir_files(Path::new(dir)));
        }
    } else if cfg!(target_os = "macos") {
        out.push(PathBuf::from("/etc/ssl/cert.pem"));
    } else if let Some(bundle) = BUNDLE_FILES.iter().map(Path::new).find(|p| p.is_file()) {
        out.push(bundle.to_path_buf());
    } else {
        for dir in CERT_DIRS {
            out.extend(dir_files(Path::new(dir)));
        }
    }
    out.extend(env_path("NODE_EXTRA_CA_CERTS").map(PathBuf::from));
    out
}

fn dir_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> =
        entries.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    files.sort();
    files
}

/// PEM contents of the system root files (unreadable files are skipped).
pub fn load() -> Vec<Vec<u8>> {
    files()
        .into_iter()
        .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.len() <= MAX_FILE_BYTES))
        .filter_map(|p| std::fs::read(p).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_a_bundle_on_this_machine() {
        // macOS ships /etc/ssl/cert.pem; CI Linux has a distribution bundle
        if std::env::var_os("SSL_CERT_FILE").is_none() && std::env::var_os("SSL_CERT_DIR").is_none()
        {
            let pems = super::load();
            let certs: usize = pems
                .iter()
                .map(|p| {
                    use rustls_pki_types::pem::PemObject;
                    rustls_pki_types::CertificateDer::pem_slice_iter(p).flatten().count()
                })
                .sum();
            assert!(certs > 10, "{certs} system roots");
        }
    }
}
