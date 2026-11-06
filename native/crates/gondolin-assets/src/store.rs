//! The local image store (`~/.cache/gondolin/images`), shared with the node
//! engine: `objects/<build-id>/` holds an image (manifest + assets),
//! `refs/<name>/<tag>/<arch>` is a relative symlink to an object directory.
//! Writes are atomic (temp dir/link + rename) so concurrent writers of either
//! engine never expose partial objects.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::AssetsError;
use crate::image_ref::{Arch, ImageRef, is_build_id, normalize_build_id};
use crate::manifest::{AssetFiles, MANIFEST_FILENAME, load_manifest};
use crate::registry::indexed;

/// `$XDG_CACHE_HOME` or `~/.cache` (`cacheBaseDir`).
pub fn cache_base_dir() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CACHE_HOME") {
        return PathBuf::from(xdg);
    }
    home_dir().join(".cache")
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// `<cache>/gondolin/<parts...>` (`gondolinCacheDir`).
pub fn gondolin_cache_dir() -> PathBuf {
    cache_base_dir().join("gondolin")
}

pub(crate) fn random_suffix() -> String {
    let mut bytes = [0u8; 4];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    crate::manifest::hex(&bytes)
}

/// Resolves `rel` against `base` lexically (like `path.resolve`), without
/// touching the filesystem.
pub(crate) fn resolve_lexical(base: &Path, rel: &Path) -> PathBuf {
    let mut out = if rel.is_absolute() { PathBuf::new() } else { base.to_path_buf() };
    for component in rel.components() {
        match component {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(c) => out.push(c),
        }
    }
    out
}

/// `candidate` is `root` or below it (lexically).
pub(crate) fn is_path_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

pub(crate) fn absolute(path: &Path) -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    resolve_lexical(&cwd, path)
}

/// Kernel, initramfs and rootfs of an image directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestAssets {
    pub kernel: PathBuf,
    pub initrd: PathBuf,
    pub rootfs: PathBuf,
}

/// Whether all assets named by the manifest (or the default names) exist.
pub fn assets_exist(dir: &Path) -> bool {
    let files = load_manifest(dir).map(|m| m.asset_files()).unwrap_or_default();
    let exists = |name: &str| dir.join(name).exists();
    exists(&files.kernel)
        && exists(&files.initramfs)
        && exists(&files.rootfs)
        && files.krun_kernel.as_deref().is_none_or(exists)
        && files.krun_initrd.as_deref().is_none_or(exists)
}

/// Loads the asset paths of a directory (`loadGuestAssets`).
pub fn load_guest_assets(dir: &Path) -> Result<GuestAssets, AssetsError> {
    let dir = absolute(dir);
    let files = load_manifest(&dir).map(|m| m.asset_files()).unwrap_or_default();
    let mut missing = Vec::new();
    for name in [Some(&files.kernel), Some(&files.initramfs), Some(&files.rootfs)]
        .into_iter()
        .chain([files.krun_kernel.as_ref(), files.krun_initrd.as_ref()])
        .flatten()
    {
        if !dir.join(name).exists() {
            missing.push(name.as_str());
        }
    }
    if !missing.is_empty() {
        return Err(AssetsError::invalid(format!(
            "Missing guest assets in {}: {}\nRun 'gondolin build' to create custom assets, or ensure the directory contains all required files.",
            dir.display(),
            missing.join(", ")
        )));
    }
    Ok(GuestAssets {
        kernel: dir.join(&files.kernel),
        initrd: dir.join(&files.initramfs),
        rootfs: dir.join(&files.rootfs),
    })
}

/// Result of importing an image directory into the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Imported {
    pub build_id: String,
    pub arch: Arch,
    pub asset_dir: PathBuf,
    /// whether this call created the object
    pub created: bool,
}

/// How [`Store::import_dir`] transfers files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportMode {
    /// copy (the source stays intact)
    Copy,
    /// rename when possible (source is a scratch directory)
    Move,
}

/// A local ref.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LocalRef {
    pub reference: String,
    pub targets: indexed::Map<Arch, String>,
}

/// Exclusive lock on a store key, released on drop.
pub struct StoreLock {
    _file: fs::File,
}

/// Removed refs as `(reference, arch)` and removed build ids.
pub type Removed = (Vec<(String, Arch)>, Vec<String>);

/// The image store.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Store {
        Store { root: absolute(&root.into()) }
    }

    /// `$GONDOLIN_IMAGE_STORE` or `<cache>/gondolin/images`.
    pub fn from_env() -> Store {
        match std::env::var_os("GONDOLIN_IMAGE_STORE") {
            Some(dir) => Store::new(dir),
            None => Store::new(gondolin_cache_dir().join("images")),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn objects_dir(&self) -> PathBuf {
        self.root.join("objects")
    }

    pub fn refs_dir(&self) -> PathBuf {
        self.root.join("refs")
    }

    pub fn object_dir(&self, build_id: &str) -> Result<PathBuf, AssetsError> {
        Ok(self.objects_dir().join(normalize_build_id(build_id)?))
    }

    /// Object directory of an existing, complete object.
    pub fn ensure_object(&self, build_id: &str) -> Result<PathBuf, AssetsError> {
        let dir = self.object_dir(build_id)?;
        if !dir.exists() {
            return Err(AssetsError::object_not_found(format!(
                "image object not found for buildId {build_id} (expected {})",
                dir.display()
            )));
        }
        load_guest_assets(&dir)?;
        Ok(dir)
    }

    pub(crate) fn ref_link_path(&self, r: &ImageRef, arch: Arch) -> Result<PathBuf, AssetsError> {
        let refs = self.refs_dir();
        let link = resolve_lexical(&refs, &Path::new(&r.name).join(&r.tag).join(arch.as_str()));
        if !is_path_within(&refs, &link) {
            return Err(AssetsError::invalid(format!(
                "invalid image ref '{}': path escapes {}",
                r.canonical(),
                refs.display()
            )));
        }
        Ok(link)
    }

    fn link_target(link: &Path) -> Result<PathBuf, AssetsError> {
        let target = fs::read_link(link).map_err(|e| AssetsError::io(link, e))?;
        Ok(resolve_lexical(link.parent().unwrap_or(Path::new("/")), &target))
    }

    fn build_id_from_link(&self, link: &Path) -> Result<String, AssetsError> {
        let meta = fs::symlink_metadata(link).map_err(|e| AssetsError::io(link, e))?;
        if !meta.file_type().is_symlink() {
            return Err(AssetsError::invalid(format!(
                "invalid image ref link: {} is not a symlink",
                link.display()
            )));
        }
        let object = Self::link_target(link)?;
        let Some(build_id) = load_manifest(&object).and_then(|m| m.build_id) else {
            return Err(AssetsError::invalid(format!(
                "image ref points to object without manifest buildId: {} -> {}",
                link.display(),
                object.display()
            )));
        };
        normalize_build_id(&build_id)?;
        load_guest_assets(&object)?;
        Ok(build_id)
    }

    /// Local targets of a ref (`readLocalRefTargets`); broken links are errors.
    pub fn ref_targets(&self, r: &ImageRef) -> Result<indexed::Map<Arch, String>, AssetsError> {
        let mut targets = indexed::Map::default();
        for arch in Arch::ALL {
            let link = self.ref_link_path(r, arch)?;
            if !link.exists() {
                continue;
            }
            targets.insert(arch, self.build_id_from_link(&link)?);
        }
        Ok(targets)
    }

    /// Points `reference`/`arch` at an existing object (`setImageRef`).
    pub fn set_ref(&self, reference: &str, build_id: &str, arch: Arch) -> Result<(), AssetsError> {
        let object = self.ensure_object(build_id)?;
        let object_arch = load_manifest(&object).and_then(|m| m.arch()).ok_or_else(|| {
            AssetsError::invalid(format!(
                "guest assets at {} are missing a normalized arch in manifest.config.arch",
                object.display()
            ))
        })?;
        if object_arch != arch {
            return Err(AssetsError::invalid(format!(
                "image object arch mismatch for {build_id}: requested {arch}, object is {object_arch}"
            )));
        }
        let r = ImageRef::parse(reference)?;
        let link = self.ref_link_path(&r, arch)?;
        let link_dir = link.parent().expect("ref link has a parent");
        fs::create_dir_all(link_dir).map_err(|e| AssetsError::io(link_dir, e))?;
        let target = relative_path(link_dir, &object);
        let tmp = link.with_file_name(format!("{arch}.tmp-{}", random_suffix()));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &tmp).map_err(|e| AssetsError::io(&tmp, e))?;
        #[cfg(not(unix))]
        return Err(AssetsError::invalid("image refs require symlink support"));
        fs::rename(&tmp, &link).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            AssetsError::io(&link, e)
        })
    }

    /// Lists all valid local refs (broken links are skipped).
    pub fn list_refs(&self) -> Vec<LocalRef> {
        let root = self.refs_dir();
        let mut found: Vec<(String, Arch)> = Vec::new();
        let mut queue = vec![root.clone()];
        while let Some(dir) = queue.pop() {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(ft) = entry.file_type() else { continue };
                if ft.is_dir() {
                    queue.push(path);
                    continue;
                }
                let Some(arch) = entry.file_name().to_str().and_then(Arch::normalize) else {
                    continue;
                };
                if !ft.is_symlink() {
                    continue;
                }
                let Ok(rel) = path.strip_prefix(&root) else { continue };
                let parts: Vec<String> = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                if parts.len() < 3 {
                    continue;
                }
                let tag = &parts[parts.len() - 2];
                let name = parts[..parts.len() - 2].join("/");
                if let Ok(r) = ImageRef::parse(&format!("{name}:{tag}")) {
                    found.push((r.canonical(), arch));
                }
            }
        }
        let mut refs: Vec<LocalRef> = Vec::new();
        for (reference, arch) in found {
            let Ok(r) = ImageRef::parse(&reference) else { continue };
            let Ok(link) = self.ref_link_path(&r, arch) else { continue };
            let Ok(build_id) = self.build_id_from_link(&link) else { continue };
            match refs.iter_mut().find(|x| x.reference == reference) {
                Some(existing) => existing.targets.insert(arch, build_id),
                None => {
                    let mut targets = indexed::Map::default();
                    targets.insert(arch, build_id);
                    refs.push(LocalRef { reference, targets });
                }
            }
        }
        refs.sort_by(|a, b| a.reference.cmp(&b.reference));
        refs
    }

    fn lock_file(&self, key: &str) -> Result<(fs::File, PathBuf), AssetsError> {
        let dir = self.root.join(".locks");
        fs::create_dir_all(&dir).map_err(|e| AssetsError::io(&dir, e))?;
        let path = dir.join(format!("{key}.lock"));
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| AssetsError::io(&path, e))?;
        Ok((file, path))
    }

    /// Takes an exclusive lock for `key` (e.g. a build id) across processes,
    /// blocking until it is free.
    pub fn lock(&self, key: &str) -> Result<StoreLock, AssetsError> {
        let (file, path) = self.lock_file(key)?;
        file.lock().map_err(|e| AssetsError::io(&path, e))?;
        Ok(StoreLock { _file: file })
    }

    /// Like [`Store::lock`] but returns `None` when another holder has it.
    pub fn try_lock(&self, key: &str) -> Result<Option<StoreLock>, AssetsError> {
        let (file, path) = self.lock_file(key)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(StoreLock { _file: file })),
            Err(fs::TryLockError::WouldBlock) => Ok(None),
            Err(fs::TryLockError::Error(e)) => Err(AssetsError::io(&path, e)),
        }
    }

    /// Imports an image directory as `objects/<build-id>` (`importImageFromDirectory`).
    pub fn import_dir(&self, dir: &Path, mode: ImportMode) -> Result<Imported, AssetsError> {
        let src = absolute(dir);
        let manifest = load_manifest(&src);
        let Some(build_id) = manifest.as_ref().and_then(|m| m.build_id.clone()) else {
            return Err(AssetsError::invalid(format!(
                "guest assets at {} are missing manifest buildId (cannot import image)",
                src.display()
            )));
        };
        let manifest = manifest.expect("checked");
        let build_id = normalize_build_id(&build_id)?;
        let arch = manifest.arch().ok_or_else(|| {
            AssetsError::invalid(format!(
                "guest assets at {} are missing a normalized arch in manifest.config.arch",
                src.display()
            ))
        })?;
        let object = self.object_dir(&build_id)?;
        let mut created = false;
        if !object.exists() {
            created = true;
            let objects = self.objects_dir();
            fs::create_dir_all(&objects).map_err(|e| AssetsError::io(&objects, e))?;
            let tmp = objects.join(format!(".tmp-{build_id}-{}", random_suffix()));
            let result = (|| {
                fs::create_dir_all(&tmp).map_err(|e| AssetsError::io(&tmp, e))?;
                transfer(
                    &src.join(MANIFEST_FILENAME),
                    &tmp.join(MANIFEST_FILENAME),
                    ImportMode::Copy,
                )?;
                for (field, name) in
                    asset_fields(&manifest.assets.clone().unwrap_or_else(|| AssetFiles {
                        kernel: String::new(),
                        initramfs: String::new(),
                        rootfs: String::new(),
                        krun_kernel: None,
                        krun_initrd: None,
                    }))
                {
                    let source = contained_path(&src, name, field)?;
                    if !source.exists() {
                        return Err(AssetsError::invalid(format!(
                            "missing {field} file at {}",
                            source.display()
                        )));
                    }
                    let source = safe_source(&src, &source, field)?;
                    let target = contained_path(&tmp, name, field)?;
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent).map_err(|e| AssetsError::io(parent, e))?;
                    }
                    transfer(&source, &target, mode)?;
                }
                Ok(())
            })();
            if let Err(err) = result {
                let _ = fs::remove_dir_all(&tmp);
                return Err(err);
            }
            if let Err(err) = fs::rename(&tmp, &object) {
                let _ = fs::remove_dir_all(&tmp);
                // Another process imported the same build concurrently.
                if object.exists() {
                    created = false;
                } else {
                    return Err(AssetsError::io(&object, err));
                }
            }
        }
        load_guest_assets(&object)?;
        Ok(Imported { build_id, arch, asset_dir: object, created })
    }

    /// Build ids referenced by any ref.
    fn referenced_ids(&self) -> std::collections::BTreeSet<String> {
        self.list_refs()
            .into_iter()
            .flat_map(|r| r.targets.0.into_iter().map(|(_, id)| id))
            .collect()
    }

    /// Complete objects no ref points at (`listUntaggedImages`), as
    /// `(build_id, arch)`.
    pub fn untagged(&self) -> Vec<(String, Option<Arch>)> {
        let referenced = self.referenced_ids();
        self.object_ids()
            .into_iter()
            .filter(|id| !referenced.contains(id))
            .filter_map(|id| {
                let dir = self.ensure_object(&id).ok()?;
                Some((id, load_manifest(&dir).and_then(|m| m.arch())))
            })
            .collect()
    }

    fn remove_unreferenced_object(&self, build_id: &str) -> bool {
        if self.referenced_ids().contains(build_id) {
            return false;
        }
        match self.object_dir(build_id) {
            Ok(dir) if dir.exists() => fs::remove_dir_all(&dir).is_ok(),
            _ => false,
        }
    }

    /// Removes a tag or a build id (`removeImage`): removed refs as
    /// `(reference, arch)` and removed build ids.
    pub fn remove_image(&self, selector: &str, force: bool) -> Result<Removed, AssetsError> {
        let trimmed = selector.trim();
        if trimmed.is_empty() {
            return Err(AssetsError::invalid("image selector must not be empty"));
        }
        let mut removed_refs = Vec::new();
        let mut removed_ids = Vec::new();
        if is_build_id(trimmed) {
            let build_id = normalize_build_id(trimmed)?;
            let dir = self.object_dir(&build_id)?;
            if !dir.exists() {
                return Err(AssetsError::object_not_found(format!(
                    "image object not found for buildId {build_id} (expected {})",
                    dir.display()
                )));
            }
            let refs: Vec<(String, Arch)> = self
                .list_refs()
                .into_iter()
                .flat_map(|r| {
                    let reference = r.reference.clone();
                    r.targets
                        .0
                        .into_iter()
                        .filter(|(_, id)| *id == build_id)
                        .map(move |(arch, _)| (reference.clone(), arch))
                        .collect::<Vec<_>>()
                })
                .collect();
            if !refs.is_empty() && !force {
                let labels: Vec<String> = refs.iter().map(|(r, a)| format!("{r} ({a})")).collect();
                return Err(AssetsError::invalid(format!(
                    "image object {build_id} is referenced by {}; remove those tags first or use --force",
                    labels.join(", ")
                )));
            }
            for (reference, arch) in refs {
                let r = ImageRef::parse(&reference)?;
                let _ = fs::remove_file(self.ref_link_path(&r, arch)?);
                removed_refs.push((reference, arch));
            }
            fs::remove_dir_all(&dir).map_err(|e| AssetsError::io(&dir, e))?;
            removed_ids.push(build_id);
            return Ok((removed_refs, removed_ids));
        }
        let r = ImageRef::parse(trimmed)?;
        let mut targets = std::collections::BTreeSet::new();
        let mut found = false;
        for arch in Arch::ALL {
            let link = self.ref_link_path(&r, arch)?;
            match fs::symlink_metadata(&link) {
                Ok(m) if m.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err(AssetsError::invalid(format!(
                        "invalid image ref link: {} is not a symlink",
                        link.display()
                    )));
                }
                Err(_) => continue,
            }
            found = true;
            if let Ok(id) = self.build_id_from_link(&link) {
                targets.insert(id);
            }
            fs::remove_file(&link).map_err(|e| AssetsError::io(&link, e))?;
            removed_refs.push((r.canonical(), arch));
        }
        if !found {
            return Err(AssetsError::new(
                crate::ErrorKind::RefNotFound,
                format!("image ref not found: {}", r.canonical()),
            ));
        }
        for id in targets {
            if self.remove_unreferenced_object(&id) {
                removed_ids.push(id);
            }
        }
        Ok((removed_refs, removed_ids))
    }

    /// Removes every untagged object (`removeUntaggedImages`).
    pub fn remove_untagged(&self) -> Vec<String> {
        self.untagged()
            .into_iter()
            .filter(|(id, _)| self.remove_unreferenced_object(id))
            .map(|(id, _)| id)
            .collect()
    }

    /// Removes all refs and objects (`removeAllImages`).
    pub fn remove_all(&self) -> Removed {
        let refs: Vec<(String, Arch)> = self
            .list_refs()
            .into_iter()
            .flat_map(|r| {
                let reference = r.reference.clone();
                r.targets
                    .0
                    .into_iter()
                    .map(move |(a, _)| (reference.clone(), a))
                    .collect::<Vec<_>>()
            })
            .collect();
        let ids = self.object_ids();
        let _ = fs::remove_dir_all(self.refs_dir());
        let _ = fs::remove_dir_all(self.objects_dir());
        (refs, ids)
    }

    /// Object directories that are complete images, by build id.
    pub fn object_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = fs::read_dir(self.objects_dir())
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|n| is_build_id(n))
                    .collect()
            })
            .unwrap_or_default();
        ids.sort();
        ids
    }
}

fn asset_fields(files: &AssetFiles) -> Vec<(&'static str, &str)> {
    let mut out = vec![
        ("manifest.assets.kernel", files.kernel.as_str()),
        ("manifest.assets.initramfs", files.initramfs.as_str()),
        ("manifest.assets.rootfs", files.rootfs.as_str()),
    ];
    if let Some(k) = &files.krun_kernel {
        out.push(("manifest.assets.krunKernel", k.as_str()));
    }
    if let Some(k) = &files.krun_initrd {
        out.push(("manifest.assets.krunInitrd", k.as_str()));
    }
    out
}

/// `resolveContainedAssetPath`: a non-empty relative path strictly below `base`.
fn contained_path(base: &Path, name: &str, field: &str) -> Result<PathBuf, AssetsError> {
    if name.trim().is_empty() {
        return Err(AssetsError::invalid(format!("invalid {field}: expected non-empty string")));
    }
    if Path::new(name).is_absolute() {
        return Err(AssetsError::invalid(format!(
            "invalid {field}: absolute paths are not allowed"
        )));
    }
    let resolved = resolve_lexical(base, Path::new(name));
    if resolved == base || !is_path_within(base, &resolved) {
        return Err(AssetsError::invalid(format!(
            "invalid {field}: path must stay within {} (got '{name}')",
            base.display()
        )));
    }
    Ok(resolved)
}

/// `ensureSafeImportSourcePath`: the real path stays below the real root and
/// is a regular file (no symlinks out of the image).
fn safe_source(root: &Path, source: &Path, field: &str) -> Result<PathBuf, AssetsError> {
    let real = fs::canonicalize(source).map_err(|e| AssetsError::io(source, e))?;
    let real_root = fs::canonicalize(root).map_err(|e| AssetsError::io(root, e))?;
    if !real.starts_with(&real_root) {
        return Err(AssetsError::invalid(format!(
            "invalid {field}: resolved path escapes {} ({})",
            real_root.display(),
            real.display()
        )));
    }
    if !fs::metadata(&real).map(|m| m.is_file()).unwrap_or(false) {
        return Err(AssetsError::invalid(format!(
            "invalid {field}: expected regular file at {}",
            real.display()
        )));
    }
    Ok(real)
}

fn transfer(source: &Path, target: &Path, mode: ImportMode) -> Result<(), AssetsError> {
    if mode == ImportMode::Move && fs::rename(source, target).is_ok() {
        return Ok(());
    }
    fs::copy(source, target).map(|_| ()).map_err(|e| AssetsError::io(source, e))
}

/// Relative path from directory `from` to `to` (`path.relative`).
fn relative_path(from: &Path, to: &Path) -> PathBuf {
    let from: Vec<Component> = from.components().collect();
    let to_c: Vec<Component> = to.components().collect();
    let common = from.iter().zip(&to_c).take_while(|(a, b)| a == b).count();
    let mut out = PathBuf::new();
    for _ in common..from.len() {
        out.push("..");
    }
    for c in &to_c[common..] {
        out.push(c.as_os_str());
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_helpers() {
        assert_eq!(
            resolve_lexical(Path::new("/a/b"), Path::new("../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(resolve_lexical(Path::new("/a"), Path::new("/x/../y")), PathBuf::from("/y"));
        assert_eq!(
            relative_path(Path::new("/s/refs/alpine-base/latest"), Path::new("/s/objects/id")),
            PathBuf::from("../../../objects/id")
        );
        assert_eq!(
            relative_path(Path::new("/s/refs/org/img/v1"), Path::new("/s/objects/id")),
            PathBuf::from("../../../../objects/id")
        );
        let base = Path::new("/base");
        assert!(contained_path(base, "k", "f").is_ok());
        assert!(contained_path(base, "sub/k", "f").is_ok());
        assert!(contained_path(base, "../k", "f").is_err());
        assert!(contained_path(base, "/etc/passwd", "f").is_err());
        assert!(contained_path(base, ".", "f").is_err());
        assert!(contained_path(base, " ", "f").is_err());
    }
}
