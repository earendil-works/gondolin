//! HTTPS: registry fetch with ETag caching, archive download with checksum,
//! safe extraction and verification.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use gondolin_http::client::{Client, ClientConfig, Connect, ConnectFuture, Target};
use gondolin_http::{Body as _, BoxBody, HeadLimits, Header};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

use crate::manifest::{compute_build_id, hex, load_manifest, sha256_file};
use crate::registry::{ImageSource, Registry, RegistryCache, load_cache, save_cache};
use crate::{AssetsError, Progress, ProgressEvent};

const REGISTRY_USER_AGENT: &str = "gondolin-image-registry";
const FETCH_USER_AGENT: &str = "gondolin-image-fetch";

/// Connect timeout per address
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Max wait for a response head or the next body chunk
const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// Redirects followed per request (like reqwest/fetch)
const MAX_REDIRECTS: usize = 10;

/// Plain TCP connections (system resolver, addresses in order).
struct TcpConnector;

impl Connect for TcpConnector {
    fn connect<'a>(&'a self, target: &'a Target) -> ConnectFuture<'a> {
        Box::pin(async move {
            let host = target.host.trim_start_matches('[').trim_end_matches(']');
            let addrs = tokio::net::lookup_host((host, target.port)).await?;
            let mut last: Option<std::io::Error> = None;
            for addr in addrs {
                match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
                    Ok(Ok(stream)) => {
                        let _ = stream.set_nodelay(true);
                        return Ok(Box::new(stream) as gondolin_http::BoxIo);
                    }
                    Ok(Err(e)) => last = Some(e),
                    Err(_) => {
                        last = Some(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "connect timeout",
                        ))
                    }
                }
            }
            Err(last.unwrap_or_else(|| std::io::Error::other("no addresses")).into())
        })
    }
}

/// HTTP(S) client with rustls (ring) and webpki + system roots.
pub(crate) struct HttpClient {
    client: Client,
}

/// A response whose body is read chunk by chunk.
pub(crate) struct Response {
    pub status: u16,
    head: gondolin_http::ResponseHead,
    body: BoxBody,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<String> {
        gondolin_http::header(&self.head.headers, name)
            .and_then(|v| std::str::from_utf8(v).ok())
            .map(str::to_string)
    }

    /// `Content-Length` of the body, when sent.
    pub fn content_length(&self) -> Option<u64> {
        self.body.size_hint().exact_len()
    }

    pub async fn chunk(&mut self) -> Result<Option<Bytes>, String> {
        match tokio::time::timeout(READ_TIMEOUT, self.body.data()).await {
            Err(_) => Err("read timeout".to_string()),
            Ok(None) => Ok(None),
            Ok(Some(Ok(b))) => Ok(Some(b)),
            Ok(Some(Err(e))) => Err(e.to_string()),
        }
    }

    pub async fn text(mut self) -> Result<String, String> {
        let mut out = Vec::new();
        while let Some(chunk) = self.chunk().await? {
            out.extend_from_slice(&chunk);
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

fn reason(status: u16) -> &'static str {
    gondolin_http::head::canonical_reason(status).unwrap_or("")
}

/// Adds the PEM certificates of `$NODE_EXTRA_CA_CERTS`.
///
/// Trust matches the node engine's `fetch`: Node's bundled Mozilla CA list
/// (which `webpki-roots` also is) plus `NODE_EXTRA_CA_CERTS`; the OS trust
/// store is not consulted (Node only does that with `--use-system-ca`).
/// Unreadable files and bad certificates are skipped, as Node warns and
/// continues.
fn add_node_extra_ca_certs(roots: &mut rustls::RootCertStore) {
    use rustls::pki_types::CertificateDer;
    use rustls::pki_types::pem::PemObject;
    let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS").filter(|p| !p.is_empty()) else {
        return;
    };
    let Ok(pem) = std::fs::read(&path) else {
        gondolin_log::warn!("NODE_EXTRA_CA_CERTS: cannot read {}", path.to_string_lossy());
        return;
    };
    for cert in CertificateDer::pem_slice_iter(&pem).flatten() {
        let _ = roots.add(cert);
    }
}

impl HttpClient {
    pub fn new() -> Result<Self, AssetsError> {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        add_node_extra_ca_certs(&mut roots);
        let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|e| AssetsError::network(format!("tls setup failed: {e}")))?
        .with_root_certificates(roots)
        .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let config = ClientConfig {
            limits: HeadLimits { max_bytes: 400 * 1024, max_headers: 1024 },
            idle_timeout: Duration::from_secs(30),
            max_idle_per_target: 4,
        };
        Ok(Self { client: Client::new(Arc::new(TcpConnector), Some(Arc::new(tls)), config) })
    }

    /// GET `url` with `headers`, following redirects.
    pub async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, String> {
        let mut url =
            gondolin_http::url::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
        for _ in 0..=MAX_REDIRECTS {
            let https = match url.scheme() {
                "https" => true,
                "http" => false,
                other => return Err(format!("unsupported url scheme: {other}")),
            };
            let host = url.host_str().ok_or("url has no host")?.to_string();
            let port = url.port_or_known_default().ok_or("url has no port")?;
            let target = Target { https, host, port };
            let path = match url.query() {
                Some(q) => format!("{}?{q}", url.path()),
                None => url.path().to_string(),
            };
            let mut wire = vec![Header::new("accept", "*/*")];
            wire.extend(headers.iter().map(|(k, v)| Header::new(k.to_ascii_lowercase(), *v)));
            let request = self.client.request(&target, "GET", &path, wire, BoxBody::empty());
            let response = match tokio::time::timeout(READ_TIMEOUT, request).await {
                Err(_) => return Err("timed out waiting for response".to_string()),
                Ok(Err(e)) => return Err(e.to_string()),
                Ok(Ok(r)) => r,
            };
            let status = response.head.status;
            if matches!(status, 301 | 302 | 303 | 307 | 308)
                && let Some(location) = gondolin_http::header(&response.head.headers, "location")
            {
                let location = String::from_utf8_lossy(location).into_owned();
                url = url.join(&location).map_err(|e| format!("invalid redirect: {e}"))?;
                continue;
            }
            return Ok(Response { status, head: response.head, body: response.body.boxed() });
        }
        Err("too many redirects".to_string())
    }
}

/// Fetches the registry, using and refreshing the on-disk cache
/// (`fetchCachedJsonRegistry`): conditional request with the cached ETag, and
/// the cached copy when the network fails.
pub(crate) async fn fetch_registry(
    client: &HttpClient,
    store: &Path,
    url: &str,
    progress: &Progress,
) -> Result<Registry, AssetsError> {
    let label = "builtin image registry";
    let cached = load_cache(store, url);
    progress(ProgressEvent::FetchRegistry { url: url.to_string() });
    let mut headers = vec![("user-agent", REGISTRY_USER_AGENT)];
    if let Some(etag) = cached.as_ref().and_then(|c| c.etag.as_ref()) {
        headers.push(("if-none-match", etag.as_str()));
    }
    let response = match client.get(url, &headers).await {
        Ok(r) => r,
        Err(err) => {
            if let Some(c) = cached {
                return Ok(c.registry);
            }
            return Err(AssetsError::network(format!("failed to fetch {label} from {url}: {err}")));
        }
    };
    let status = response.status;
    if status == 304
        && let Some(c) = cached
    {
        return Ok(c.registry);
    }
    if !(200..300).contains(&status) {
        if let Some(c) = cached {
            return Ok(c.registry);
        }
        return Err(AssetsError::network(format!(
            "failed to fetch {label}: {status} {} ({url})",
            reason(status)
        )));
    }
    let etag = response.header("etag");
    let text = response
        .text()
        .await
        .map_err(|e| AssetsError::network(format!("failed to fetch {label} from {url}: {e}")))?;
    let raw = gondolin_wire::json::parse(&text).map_err(|e| {
        AssetsError::invalid(format!("failed to parse {label} json from {url}: {e}"))
    })?;
    let registry = Registry::parse(&raw, url)?;
    let cache = RegistryCache { url: url.to_string(), etag, registry };
    if let Err(err) = save_cache(store, &cache) {
        gondolin_log::debug!("failed to write registry cache: {err}");
    }
    Ok(cache.registry)
}

/// Downloads `source` to `archive`, verifying its `sha256` when known.
pub(crate) async fn download(
    client: &HttpClient,
    source: &ImageSource,
    archive: &Path,
    label: &str,
    progress: &Progress,
) -> Result<u64, AssetsError> {
    let mut response =
        client.get(&source.url, &[("user-agent", FETCH_USER_AGENT)]).await.map_err(|e| {
            AssetsError::network(format!("failed to download image archive: {e} ({})", source.url))
        })?;
    let status = response.status;
    if !(200..300).contains(&status) {
        return Err(AssetsError::network(format!(
            "failed to download image archive: {status} {} ({})",
            reason(status),
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

/// Extracts a `.tar.gz` into `dest` with the hardened reader in
/// [`crate::archive`] (no entries outside `dest`, no escaping symlinks, no
/// device files, size limits; permissions/ownership/xattrs are not restored).
pub(crate) fn extract(archive: &Path, dest: &Path) -> Result<(), AssetsError> {
    std::fs::create_dir_all(dest).map_err(|e| AssetsError::io(dest, e))?;
    let file = std::fs::File::open(archive).map_err(|e| AssetsError::io(archive, e))?;
    let gz = crate::archive::gzip::GzipReader::new(file);
    crate::archive::tar::extract(gz, dest, crate::archive::tar::Limits::default())
        .map(|_| ())
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
        gondolin_log::debug!("image manifest has no assets/checksums; skipping verification");
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
        gondolin_log::warn!(
            "image manifest buildId {} does not derive from its checksums ({derived})",
            manifest.build_id.as_deref().unwrap_or("<missing>")
        );
    }
    Ok(())
}
