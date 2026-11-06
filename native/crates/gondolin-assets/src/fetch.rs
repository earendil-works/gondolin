//! HTTPS: registry fetch with ETag caching, archive download with checksum,
//! safe extraction and verification.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use tokio::io::AsyncWriteExt;

use crate::manifest::{compute_build_id, hex, load_manifest, sha256_file};
use crate::registry::{ImageSource, Registry, RegistryCache, load_cache, save_cache};
use crate::{AssetsError, Progress, ProgressEvent};

const REGISTRY_USER_AGENT: &str = "gondolin-image-registry";
const FETCH_USER_AGENT: &str = "gondolin-image-fetch";

/// HTTP client with rustls (ring) and webpki + system roots.
pub(crate) fn http_client() -> Result<reqwest::Client, AssetsError> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| AssetsError::network(format!("tls setup failed: {e}")))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AssetsError::network(format!("http client setup failed: {e}")))
}

/// Fetches the registry, using and refreshing the on-disk cache
/// (`fetchCachedJsonRegistry`): conditional request with the cached ETag, and
/// the cached copy when the network fails.
pub(crate) async fn fetch_registry(
    client: &reqwest::Client,
    store: &Path,
    url: &str,
    progress: &Progress,
) -> Result<Registry, AssetsError> {
    let label = "builtin image registry";
    let cached = load_cache(store, url);
    progress(ProgressEvent::FetchRegistry { url: url.to_string() });
    let mut request = client.get(url).header("User-Agent", REGISTRY_USER_AGENT);
    if let Some(etag) = cached.as_ref().and_then(|c| c.etag.as_ref()) {
        request = request.header("If-None-Match", etag);
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(err) => {
            if let Some(c) = cached {
                return Ok(c.registry);
            }
            return Err(AssetsError::network(format!("failed to fetch {label} from {url}: {err}")));
        }
    };
    let status = response.status();
    if status == reqwest::StatusCode::NOT_MODIFIED
        && let Some(c) = cached
    {
        return Ok(c.registry);
    }
    if !status.is_success() {
        if let Some(c) = cached {
            return Ok(c.registry);
        }
        return Err(AssetsError::network(format!(
            "failed to fetch {label}: {} {} ({url})",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        )));
    }
    let etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string);
    let text = response
        .text()
        .await
        .map_err(|e| AssetsError::network(format!("failed to fetch {label} from {url}: {e}")))?;
    let raw: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        AssetsError::invalid(format!("failed to parse {label} json from {url}: {e}"))
    })?;
    let registry = Registry::parse(&raw, url)?;
    let cache = RegistryCache { url: url.to_string(), etag, registry };
    if let Err(err) = save_cache(store, &cache) {
        tracing::debug!("failed to write registry cache: {err}");
    }
    Ok(cache.registry)
}

/// Downloads `source` to `archive`, verifying its `sha256` when known.
pub(crate) async fn download(
    client: &reqwest::Client,
    source: &ImageSource,
    archive: &Path,
    label: &str,
    progress: &Progress,
) -> Result<u64, AssetsError> {
    let mut response = client
        .get(&source.url)
        .header("User-Agent", FETCH_USER_AGENT)
        .send()
        .await
        .map_err(|e| {
            AssetsError::network(format!("failed to download image archive: {e} ({})", source.url))
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AssetsError::network(format!(
            "failed to download image archive: {} {} ({})",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            source.url
        )));
    }
    let total = response.content_length();
    progress(ProgressEvent::DownloadStart {
        label: label.to_string(),
        url: source.url.clone(),
        total,
    });
    let started = Instant::now();
    let mut file =
        tokio::fs::File::create(archive).await.map_err(|e| AssetsError::io(archive, e))?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut downloaded = 0u64;
    let mut last_report = Instant::now();
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => {
                return Err(AssetsError::network(format!(
                    "failed to download image archive: {e} ({})",
                    source.url
                )));
            }
        };
        ctx.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| AssetsError::io(archive, e))?;
        downloaded += chunk.len() as u64;
        if last_report.elapsed().as_millis() >= 250 {
            last_report = Instant::now();
            progress(ProgressEvent::DownloadProgress {
                label: label.to_string(),
                downloaded,
                total,
            });
        }
    }
    file.flush().await.map_err(|e| AssetsError::io(archive, e))?;
    file.sync_all().await.map_err(|e| AssetsError::io(archive, e))?;
    if let Some(expected) = &source.sha256 {
        let got = hex(ctx.finish().as_ref());
        if &got != expected {
            return Err(AssetsError::checksum(format!(
                "downloaded image checksum mismatch for {}\n  expected: {expected}\n  got:      {got}",
                source.url
            )));
        }
    }
    progress(ProgressEvent::DownloadDone {
        label: label.to_string(),
        bytes: downloaded,
        elapsed_ms: started.elapsed().as_millis() as u64,
    });
    Ok(downloaded)
}

/// Extracts a `.tar.gz` into `dest` (entries escaping `dest` are rejected by
/// `tar`; permissions/ownership/xattrs are not restored).
pub(crate) fn extract(archive: &Path, dest: &Path) -> Result<(), AssetsError> {
    std::fs::create_dir_all(dest).map_err(|e| AssetsError::io(dest, e))?;
    let file = std::fs::File::open(archive).map_err(|e| AssetsError::io(archive, e))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(std::io::BufReader::new(file)));
    tar.set_preserve_permissions(false);
    tar.set_preserve_ownerships(false);
    tar.set_unpack_xattrs(false);
    tar.set_overwrite(true);
    tar.unpack(dest)
        .map_err(|e| AssetsError::invalid(format!("failed to extract image archive: {e}")))
}

/// Verifies an extracted image: every asset with a manifest checksum must
/// match it. A build id that does not derive from the checksums (older
/// builders) is only logged; the archive checksum already pins the content.
pub(crate) fn verify_extracted(dir: &Path) -> Result<(), AssetsError> {
    let Some(manifest) = load_manifest(dir) else {
        return Err(AssetsError::invalid(format!(
            "image archive has no valid manifest.json ({})",
            dir.display()
        )));
    };
    let (Some(files), Some(checksums)) = (&manifest.assets, &manifest.checksums) else {
        tracing::debug!("image manifest has no assets/checksums; skipping verification");
        return Ok(());
    };
    let pairs: Vec<(&str, Option<&String>, Option<&String>)> = vec![
        ("kernel", Some(&files.kernel), Some(&checksums.kernel)),
        ("initramfs", Some(&files.initramfs), Some(&checksums.initramfs)),
        ("rootfs", Some(&files.rootfs), Some(&checksums.rootfs)),
        ("krunKernel", files.krun_kernel.as_ref(), checksums.krun_kernel.as_ref()),
        ("krunInitrd", files.krun_initrd.as_ref(), checksums.krun_initrd.as_ref()),
    ];
    for (field, name, expected) in pairs {
        let Some(name) = name else { continue };
        let Some(expected) = expected else {
            continue;
        };
        let path: PathBuf = crate::store::resolve_lexical(dir, Path::new(name));
        if !path.starts_with(dir) {
            return Err(AssetsError::invalid(format!(
                "invalid manifest.assets.{field}: path escapes image"
            )));
        }
        let got = sha256_file(&path).map_err(|e| AssetsError::io(&path, e))?;
        if !got.eq_ignore_ascii_case(expected) {
            return Err(AssetsError::checksum(format!(
                "image asset checksum mismatch for {field} ({name})\n  expected: {expected}\n  got:      {got}"
            )));
        }
    }
    let arch = manifest.config.get("arch").and_then(|v| v.as_str());
    let derived = compute_build_id(checksums, arch);
    if manifest.build_id.as_deref() != Some(derived.as_str()) {
        tracing::warn!(
            "image manifest buildId {} does not derive from its checksums ({derived})",
            manifest.build_id.as_deref().unwrap_or("<missing>")
        );
    }
    Ok(())
}
