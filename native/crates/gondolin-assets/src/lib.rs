//! Guest image resolution and the shared image cache, so gondolind can boot
//! VMs on machines without Node (port of `host/src/assets.ts`, `images.ts`,
//! `image-ref.ts`, `registry.ts`, `cache.ts`).
//!
//! The on-disk layout is the node engine's, so both engines share one cache:
//!
//! ```text
//! $GONDOLIN_IMAGE_STORE (default $XDG_CACHE_HOME/gondolin/images, ~/.cache/gondolin/images)
//! ├── builtin-image-registry-cache.json   { url, etag?, registry }
//! ├── objects/<build-id>/                  manifest.json + assets
//! ├── refs/<name>/<tag>/<arch>             relative symlink to ../../../objects/<build-id>
//! └── .locks/<build-id>.lock               (native only) download lock
//! ```
//!
//! Selectors are resolved like `ensureImageSelector`: an existing directory,
//! a build id, or a `name[:tag]` ref; local objects/refs first, then the
//! builtin registry (`$GONDOLIN_IMAGE_REGISTRY_URL`). The default image
//! (`ensureGuestAssets`) honors `$GONDOLIN_GUEST_DIR`, a dev checkout's
//! `guest/image/out`, and `$GONDOLIN_DEFAULT_IMAGE` (`alpine-base:latest`).
//!
//! Sandbox helper binaries (`builtin-sandbox-helper-registry.json`) are only
//! needed to *build* images; published images already contain them, so VM
//! boot does not need that registry.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gondolin_wire::{ToValue, Value, wire_enum, wire_struct};

pub mod archive;
pub mod cli;
mod fetch;
pub mod image_ref;
pub mod manifest;
pub mod registry;
pub mod store;

pub use image_ref::{Arch, ImageRef, is_build_id};
pub use manifest::{
    AssetFiles, AssetManifest, Checksums, RootfsMode, compute_build_id, load_manifest,
};
pub use registry::{ImageSource, Registry};
pub use store::{GuestAssets, ImportMode, Imported, LocalRef, Store};

use crate::store::{assets_exist, load_guest_assets, random_suffix};

/// Default image when `$GONDOLIN_DEFAULT_IMAGE` is unset.
pub const DEFAULT_IMAGE: &str = "alpine-base:latest";

wire_enum! {
    /// Error categories (stable for callers and the controller protocol).
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ErrorKind {
        /// no object for a build id (local)
        ObjectNotFound = "object_not_found",
        /// no local ref
        RefNotFound = "ref_not_found",
        /// local ref without a target for the requested arch
        RefArchNotFound = "ref_arch_not_found",
        /// invalid input, manifest or registry
        Invalid = "invalid",
        /// filesystem error
        Io = "io",
        /// HTTP error
        Network = "network",
        /// checksum mismatch
        Checksum = "checksum",
    }
}

/// Resolution/download error; the message matches the node engine's where it
/// has an equivalent.
#[derive(Debug, Clone)]
pub struct AssetsError {
    pub kind: ErrorKind,
    pub message: String,
}

impl std::fmt::Display for AssetsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AssetsError {}

impl AssetsError {
    pub(crate) fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        AssetsError { kind, message: message.into() }
    }
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }
    pub(crate) fn object_not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::ObjectNotFound, message)
    }
    pub(crate) fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Network, message)
    }
    pub(crate) fn checksum(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Checksum, message)
    }
    pub(crate) fn io(path: &Path, err: std::io::Error) -> Self {
        Self::new(ErrorKind::Io, format!("{}: {err}", path.display()))
    }

    /// A local miss that the registry may resolve (`isExpectedLocalImageMiss`).
    pub fn is_local_miss(&self) -> bool {
        matches!(
            self.kind,
            ErrorKind::ObjectNotFound | ErrorKind::RefNotFound | ErrorKind::RefArchNotFound
        )
    }
}

/// Progress of registry fetches and downloads; encodes as
/// `{ "event": "<snake_case variant>", ...fields }` (absent totals as null).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgressEvent {
    FetchRegistry {
        url: String,
    },
    DownloadStart {
        label: String,
        url: String,
        total: Option<u64>,
    },
    DownloadProgress {
        label: String,
        downloaded: u64,
        total: Option<u64>,
    },
    DownloadDone {
        label: String,
        bytes: u64,
        elapsed_ms: u64,
    },
    Verifying {
        label: String,
    },
    Installed {
        build_id: String,
        created: bool,
    },
    /// another process is installing the same build; waiting for its lock
    WaitingForLock {
        build_id: String,
    },
}

impl ToValue for ProgressEvent {
    fn to_value(&self) -> Value {
        let total = |t: &Option<u64>| t.map_or(Value::Null, |t| t.to_value());
        match self {
            ProgressEvent::FetchRegistry { url } => {
                gondolin_wire::value!({ "event": "fetch_registry", "url": url })
            }
            ProgressEvent::DownloadStart { label, url, total: t } => gondolin_wire::value!({
                "event": "download_start", "label": label, "url": url, "total": (total(t))
            }),
            ProgressEvent::DownloadProgress { label, downloaded, total: t } => {
                gondolin_wire::value!({
                    "event": "download_progress",
                    "label": label,
                    "downloaded": downloaded,
                    "total": (total(t))
                })
            }
            ProgressEvent::DownloadDone { label, bytes, elapsed_ms } => gondolin_wire::value!({
                "event": "download_done", "label": label, "bytes": bytes, "elapsed_ms": elapsed_ms
            }),
            ProgressEvent::Verifying { label } => {
                gondolin_wire::value!({ "event": "verifying", "label": label })
            }
            ProgressEvent::Installed { build_id, created } => gondolin_wire::value!({
                "event": "installed", "build_id": build_id, "created": created
            }),
            ProgressEvent::WaitingForLock { build_id } => {
                gondolin_wire::value!({ "event": "waiting_for_lock", "build_id": build_id })
            }
        }
    }
}

/// Progress callback.
pub type Progress = dyn Fn(ProgressEvent) + Send + Sync;

wire_enum! {
    /// Where a resolved image came from.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ImageSourceKind {
        /// a directory given as selector
        Path = "path",
        /// a build id
        BuildId = "build-id",
        /// a `name:tag` ref
        Ref = "ref",
        /// `$GONDOLIN_GUEST_DIR`
        GuestDir = "guest-dir",
        /// `guest/image/out` of a source checkout
        Checkout = "checkout",
    }
}

wire_enum! {
    /// Disk image format of the rootfs.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum DiskFormat {
        Raw = "raw",
        Qcow2 = "qcow2",
    }
}

wire_struct! {
    /// A resolved guest image: everything needed to boot it (snake_case keys).
    #[derive(Debug, Clone)]
    pub struct ResolvedImage {
        pub source: ImageSourceKind,
        /// selector after resolution (absolute path, build id or canonical ref)
        pub selector: String,
        pub asset_dir: PathBuf,
        pub build_id: Option<String>,
        pub arch: Option<Arch>,
        pub kernel: PathBuf,
        pub initrd: PathBuf,
        pub rootfs: PathBuf,
        pub rootfs_format: DiskFormat,
        /// libkrun kernel (`manifest.assets.krunKernel`)
        pub krun_kernel: Option<PathBuf>,
        /// libkrun initrd (`manifest.assets.krunInitrd`)
        pub krun_initrd: Option<PathBuf>,
        /// `manifest.runtimeDefaults.rootfsMode`
        pub rootfs_mode: Option<RootfsMode>,
        pub manifest: Option<AssetManifest>,
    }
}

impl ResolvedImage {
    fn from_dir(
        source: ImageSourceKind,
        selector: String,
        dir: &Path,
        build_id: Option<String>,
        arch: Option<Arch>,
    ) -> Result<ResolvedImage, AssetsError> {
        let assets = load_guest_assets(dir)?;
        let asset_dir = store::absolute(dir);
        let manifest = load_manifest(&asset_dir);
        let files = manifest.as_ref().map(|m| m.asset_files()).unwrap_or_default();
        Ok(ResolvedImage {
            source,
            selector,
            build_id: build_id.or_else(|| manifest.as_ref().and_then(|m| m.build_id.clone())),
            arch: arch.or_else(|| manifest.as_ref().and_then(|m| m.arch())),
            kernel: assets.kernel,
            initrd: assets.initrd,
            rootfs: assets.rootfs,
            rootfs_format: DiskFormat::Raw,
            krun_kernel: files.krun_kernel.map(|k| asset_dir.join(k)),
            krun_initrd: files.krun_initrd.map(|k| asset_dir.join(k)),
            rootfs_mode: manifest.as_ref().and_then(|m| m.rootfs_mode()),
            manifest,
            asset_dir,
        })
    }
}

/// Resolution options.
#[derive(Debug, Clone)]
pub struct AssetsOptions {
    /// the image store
    pub store: Store,
    /// builtin registry URL
    pub registry_url: String,
    /// default image selector
    pub default_image: String,
    /// `$GONDOLIN_GUEST_DIR` override for the default image
    pub guest_dir: Option<PathBuf>,
    /// directories to search upwards for a checkout's `guest/image/out`
    pub checkout_search: Vec<PathBuf>,
    /// architecture when the caller does not ask for one
    pub host_arch: Arch,
}

impl AssetsOptions {
    /// Options from the environment, as the node engine reads them.
    pub fn from_env() -> AssetsOptions {
        let non_empty = |name: &str| {
            std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
        };
        let mut checkout_search = Vec::new();
        if let Ok(cwd) = std::env::current_dir() {
            checkout_search.push(cwd);
        }
        if let Some(dir) =
            std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf))
        {
            checkout_search.push(dir);
        }
        AssetsOptions {
            store: Store::from_env(),
            registry_url: non_empty("GONDOLIN_IMAGE_REGISTRY_URL")
                .unwrap_or_else(|| registry::DEFAULT_IMAGE_REGISTRY_URL.to_string()),
            default_image: std::env::var("GONDOLIN_DEFAULT_IMAGE")
                .unwrap_or_else(|_| DEFAULT_IMAGE.to_string()),
            guest_dir: std::env::var_os("GONDOLIN_GUEST_DIR")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            checkout_search,
            host_arch: Arch::host(),
        }
    }
}

/// Image resolver over a [`Store`] and the builtin registry.
pub struct Assets {
    options: AssetsOptions,
    client: std::sync::OnceLock<fetch::HttpClient>,
}

fn no_progress(_: ProgressEvent) {}

impl Assets {
    pub fn new(options: AssetsOptions) -> Assets {
        Assets { options, client: std::sync::OnceLock::new() }
    }

    pub fn from_env() -> Assets {
        Assets::new(AssetsOptions::from_env())
    }

    pub fn store(&self) -> &Store {
        &self.options.store
    }

    pub fn options(&self) -> &AssetsOptions {
        &self.options
    }

    fn client(&self) -> Result<&fetch::HttpClient, AssetsError> {
        if let Some(c) = self.client.get() {
            return Ok(c);
        }
        let client = fetch::HttpClient::new()?;
        Ok(self.client.get_or_init(|| client))
    }

    /// Resolves a selector from local files only (`resolveImageSelector`).
    pub fn resolve_local(
        &self,
        selector: &str,
        arch: Option<Arch>,
    ) -> Result<ResolvedImage, AssetsError> {
        let store = &self.options.store;
        let trimmed = selector.trim();
        if trimmed.is_empty() {
            return Err(AssetsError::invalid("image selector must not be empty"));
        }
        if let Some(dir) = path_selector(trimmed)? {
            let display = dir.display().to_string();
            return ResolvedImage::from_dir(ImageSourceKind::Path, display, &dir, None, None);
        }
        if is_build_id(trimmed) {
            let dir = store.ensure_object(trimmed)?;
            let manifest_arch = load_manifest(&dir).and_then(|m| m.arch());
            if manifest_arch.is_none() {
                return Err(AssetsError::invalid(format!(
                    "guest assets at {} are missing a normalized arch in manifest.config.arch",
                    dir.display()
                )));
            }
            return ResolvedImage::from_dir(
                ImageSourceKind::BuildId,
                trimmed.to_string(),
                &dir,
                Some(trimmed.to_string()),
                manifest_arch,
            );
        }
        let r = ImageRef::parse(trimmed)?;
        let canonical = r.canonical();
        let targets = store.ref_targets(&r)?;
        let wanted = arch.unwrap_or(self.options.host_arch);
        let Some((resolved_arch, build_id)) = registry::select_entry(&targets, wanted) else {
            if targets.is_empty() {
                return Err(AssetsError::new(
                    ErrorKind::RefNotFound,
                    format!("image ref not found: {canonical}"),
                ));
            }
            return Err(AssetsError::new(
                ErrorKind::RefArchNotFound,
                format!(
                    "image ref '{canonical}' has no target for {wanted} (available: {})",
                    registry::describe_available(&targets)
                ),
            ));
        };
        let dir = store.ensure_object(&build_id)?;
        ResolvedImage::from_dir(
            ImageSourceKind::Ref,
            canonical,
            &dir,
            Some(build_id),
            Some(resolved_arch),
        )
    }

    /// Resolves a selector, downloading from the builtin registry when it is
    /// not available locally (`ensureImageSelector`).
    pub async fn resolve(
        &self,
        selector: &str,
        arch: Option<Arch>,
        progress: Option<&Progress>,
    ) -> Result<ResolvedImage, AssetsError> {
        let progress: &Progress = progress.unwrap_or(&no_progress);
        let trimmed = selector.trim();
        if trimmed.is_empty() {
            return Err(AssetsError::invalid("image selector must not be empty"));
        }
        path_selector(trimmed)?;
        match self.resolve_local(trimmed, arch) {
            Ok(image) => return Ok(image),
            Err(err) if err.is_local_miss() => {}
            Err(err) => return Err(err),
        }
        self.install(trimmed, arch, progress).await
    }

    /// Fetches a ref from the registry even when it exists locally and points
    /// the local ref at the registry's current build (`resolve` keeps a local
    /// ref as is). Build ids and paths behave like [`Assets::resolve`].
    pub async fn pull(
        &self,
        selector: &str,
        arch: Option<Arch>,
        progress: Option<&Progress>,
    ) -> Result<ResolvedImage, AssetsError> {
        let progress: &Progress = progress.unwrap_or(&no_progress);
        let trimmed = selector.trim();
        if trimmed.is_empty() || path_selector(trimmed)?.is_some() || is_build_id(trimmed) {
            return self.resolve(trimmed, arch, Some(progress)).await;
        }
        self.install(trimmed, arch, progress).await
    }

    async fn install(
        &self,
        selector: &str,
        arch: Option<Arch>,
        progress: &Progress,
    ) -> Result<ResolvedImage, AssetsError> {
        let store = &self.options.store;
        let client = self.client()?;
        let registry =
            fetch::fetch_registry(client, store.root(), &self.options.registry_url, progress)
                .await?;
        if is_build_id(selector) {
            let Some(source) = registry.builds.get(&selector.to_string()) else {
                return Err(AssetsError::invalid(format!(
                    "image build id not found in builtin registry builds metadata: {selector}"
                )));
            };
            self.install_build(selector, source, selector, progress).await?;
            return self.resolve_local(selector, arch);
        }
        let r = ImageRef::parse(selector)?;
        let canonical = r.canonical();
        let (build_id, resolved_arch, source) =
            registry.resolve_ref(&canonical, arch.unwrap_or(self.options.host_arch))?;
        let imported = self.install_build(&build_id, source, &canonical, progress).await?;
        if imported.arch != resolved_arch {
            return Err(AssetsError::invalid(format!(
                "registry ref '{canonical}' ({resolved_arch}) resolved to {}",
                imported.arch
            )));
        }
        store.set_ref(&canonical, &imported.build_id, imported.arch)?;
        self.resolve_local(&canonical, arch)
    }

    /// Ensures `objects/<build_id>` exists, downloading it under a lock.
    async fn install_build(
        &self,
        build_id: &str,
        source: &ImageSource,
        label: &str,
        progress: &Progress,
    ) -> Result<Imported, AssetsError> {
        let store = self.options.store.clone();
        let existing = |store: &Store| -> Option<Imported> {
            let dir = store.ensure_object(build_id).ok()?;
            let arch = load_manifest(&dir)?.arch()?;
            Some(Imported { build_id: build_id.to_string(), arch, asset_dir: dir, created: false })
        };
        if let Some(found) = existing(&store) {
            return Ok(found);
        }

        // One download per build across processes; whoever waited re-checks.
        let lock = match store.try_lock(build_id)? {
            Some(lock) => lock,
            None => {
                progress(ProgressEvent::WaitingForLock { build_id: build_id.to_string() });
                let lock_store = store.clone();
                let key = build_id.to_string();
                tokio::task::spawn_blocking(move || lock_store.lock(&key))
                    .await
                    .map_err(|e| AssetsError::invalid(format!("lock task failed: {e}")))??
            }
        };
        if let Some(found) = existing(&store) {
            drop(lock);
            return Ok(found);
        }

        // Scratch space inside the store (same filesystem: imports rename).
        let scratch = store.root().join(format!(".tmp-pull-{build_id}-{}", random_suffix()));
        std::fs::create_dir_all(&scratch).map_err(|e| AssetsError::io(&scratch, e))?;
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(scratch.clone());

        let archive = scratch.join("image.tar.gz");
        fetch::download(self.client()?, source, &archive, label, progress).await?;
        progress(ProgressEvent::Verifying { label: label.to_string() });
        let extract_dir = scratch.join("extract");
        let expected_arch = source.arch;
        let expected_id = build_id.to_string();
        let url = source.url.clone();
        let imported = tokio::task::spawn_blocking(move || -> Result<Imported, AssetsError> {
            fetch::extract(&archive, &extract_dir)?;
            let _ = std::fs::remove_file(&archive);
            fetch::verify_extracted(&extract_dir)?;
            let imported = store.import_dir(&extract_dir, ImportMode::Move)?;
            if let Some(arch) = expected_arch
                && imported.arch != arch
            {
                return Err(AssetsError::invalid(format!(
                    "downloaded image arch mismatch\n  expected: {arch}\n  got:      {}\n  source:   {url}",
                    imported.arch
                )));
            }
            if imported.build_id != expected_id {
                return Err(AssetsError::invalid(format!(
                    "downloaded image buildId mismatch\n  expected: {expected_id}\n  got:      {}\n  source:   {url}",
                    imported.build_id
                )));
            }
            Ok(imported)
        })
        .await
        .map_err(|e| AssetsError::invalid(format!("import task failed: {e}")))??;
        drop(lock);
        progress(ProgressEvent::Installed {
            build_id: imported.build_id.clone(),
            created: imported.created,
        });
        Ok(imported)
    }

    /// Default guest image without downloading (`resolveGuestAssetsSync`
    /// order: guest dir, checkout, default selector in the store).
    pub fn resolve_default_local(&self) -> Result<Option<ResolvedImage>, AssetsError> {
        if let Some(dir) = &self.options.guest_dir {
            return ResolvedImage::from_dir(
                ImageSourceKind::GuestDir,
                dir.display().to_string(),
                dir,
                None,
                None,
            )
            .map(Some);
        }
        if let Some(dir) = self.find_checkout() {
            return ResolvedImage::from_dir(
                ImageSourceKind::Checkout,
                dir.display().to_string(),
                &dir,
                None,
                None,
            )
            .map(Some);
        }
        Ok(self.default_from_store())
    }

    /// A build id the way checkpoints resolve theirs (node:
    /// `resolveAssetDirByBuildId`): `$GONDOLIN_GUEST_DIR` or a checkout's
    /// `guest/image/out` when their manifest has this build id, else the
    /// store, else (unlike node, which fails there) the registry.
    pub async fn resolve_build_id(
        &self,
        build_id: &str,
        progress: Option<&Progress>,
    ) -> Result<ResolvedImage, AssetsError> {
        let wanted = image_ref::normalize_build_id(build_id)?;
        let local = [
            (ImageSourceKind::GuestDir, self.options.guest_dir.clone()),
            (ImageSourceKind::Checkout, self.find_checkout()),
        ];
        for (kind, dir) in local {
            let Some(dir) = dir else { continue };
            let matches =
                load_manifest(&dir).and_then(|m| m.build_id).as_deref() == Some(wanted.as_str());
            if matches && assets_exist(&dir) {
                return ResolvedImage::from_dir(kind, dir.display().to_string(), &dir, None, None);
            }
        }
        self.resolve(&wanted, None, progress).await
    }

    /// The default guest image, downloading it if needed (`ensureGuestAssets`).
    pub async fn resolve_default(
        &self,
        progress: Option<&Progress>,
    ) -> Result<ResolvedImage, AssetsError> {
        if let Some(image) = self.resolve_default_local()? {
            return Ok(image);
        }
        let selector = self.options.default_image.clone();
        self.resolve(&selector, None, progress).await
    }

    fn find_checkout(&self) -> Option<PathBuf> {
        for start in &self.options.checkout_search {
            let mut dir = Some(start.as_path());
            while let Some(d) = dir {
                let candidate = d.join("guest").join("image").join("out");
                if assets_exist(&candidate) {
                    return Some(candidate);
                }
                dir = d.parent();
            }
        }
        None
    }

    /// `resolveDefaultImageAssetDirFromStore`: the default selector's object
    /// for the host arch, else the other arch, without validation beyond
    /// asset existence.
    fn default_from_store(&self) -> Option<ResolvedImage> {
        let selector = self.options.default_image.trim();
        if selector.is_empty() {
            return None;
        }
        let store = &self.options.store;
        if is_build_id(selector) {
            let dir = store.objects_dir().join(selector);
            if !assets_exist(&dir) {
                return None;
            }
            return ResolvedImage::from_dir(
                ImageSourceKind::BuildId,
                selector.into(),
                &dir,
                None,
                None,
            )
            .ok();
        }
        let r = ImageRef::parse(selector).ok()?;
        let host = self.options.host_arch;
        for arch in [host, host.other()] {
            let Ok(link) = store.ref_link_path(&r, arch) else { continue };
            let Ok(target) = std::fs::read_link(&link) else { continue };
            let dir = store::resolve_lexical(link.parent()?, &target);
            if assets_exist(&dir) {
                return ResolvedImage::from_dir(
                    ImageSourceKind::Ref,
                    r.canonical(),
                    &dir,
                    None,
                    Some(arch),
                )
                .ok();
            }
        }
        None
    }
}

/// An existing path selector must be a directory (`resolvePathSelector`).
fn path_selector(selector: &str) -> Result<Option<PathBuf>, AssetsError> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let resolved = store::resolve_lexical(&cwd, Path::new(selector));
    match std::fs::metadata(&resolved) {
        Ok(meta) if meta.is_dir() => Ok(Some(resolved)),
        Ok(_) => Err(AssetsError::invalid(format!(
            "image selector path is not a directory: {}",
            resolved.display()
        ))),
        Err(_) => Ok(None),
    }
}

/// Convenience: shared resolver for gondolind.
pub fn shared_from_env() -> Arc<Assets> {
    Arc::new(Assets::from_env())
}
