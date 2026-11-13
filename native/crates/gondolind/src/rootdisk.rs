//! Root disk preparation for every session (local and remote, the SDK and
//! the static CLI): the rootfs modes of `VM` (`host/src/vm/core.ts`) on
//! `gondolin-qcow2`, so no controller needs `qemu-img`.

use std::path::{Path, PathBuf};

use gondolin_proto::session::{RootDisk, VmConfig};
use gondolin_qcow2::{self as qcow2, Format};

/// `inferDiskFormatFromPath`.
pub fn infer_format(path: &str) -> &'static str {
    Format::from_path(path).name()
}

/// The writable qcow2 root disk a checkpoint export reads: the overlay
/// [`prepare`] created, or the controller's own qcow2 disk (no mode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overlay {
    pub path: PathBuf,
    /// what a checkpoint export collapses the disk's backing chain onto
    /// ([`collapse_onto`]): `root_disk.path` and format (in `checkpoint`
    /// mode the rootfs below the imported checkpoint); `None` for the
    /// controller's own disk: the bottom of its chain
    pub base: Option<(PathBuf, Format)>,
}

/// Whether two paths name the same file (canonical paths when both exist).
pub fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Collapses the backing chain of `overlay` onto `base` when its backing
/// file is something else (a resumed checkpoint), like the SDK's checkpoint
/// (`qemu-img rebase` in safe mode): clusters only the dropped layers have
/// are copied into the overlay. Returns whether it rebased.
pub fn collapse_onto(overlay: &Path, base: &Path, format: Format) -> Result<bool, String> {
    match qcow2::backing_path(overlay)? {
        Some(backing) if !same_file(&backing, base) => {
            qcow2::rebase(overlay, base, format)?;
            Ok(true)
        }
        // the same file under another name (e.g. a symlinked image directory)
        Some(backing) if !same_name(&backing, base) => {
            set_backing_name(overlay, base, format)?;
            Ok(false)
        }
        _ => Ok(false),
    }
}

/// Whether two paths are the same absolute name (no symlinks resolved).
fn same_name(a: &Path, b: &Path) -> bool {
    match (std::path::absolute(a), std::path::absolute(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn set_backing_name(disk: &Path, backing: &Path, format: Format) -> Result<(), String> {
    let name = backing.to_str().ok_or("backing file path is not UTF-8")?;
    Ok(qcow2::set_backing(disk, Some((name, format)))?)
}

impl Overlay {
    /// Collapses the disk's chain onto its base (see [`Overlay::base`]).
    /// A disk whose chain does not contain the base (an overlay on a
    /// standalone checkpoint, the controller's own disk) is collapsed onto
    /// the bottom of its chain when that is a raw file, else flattened into
    /// a standalone image.
    pub fn collapse(&self) -> Result<bool, String> {
        let chain = qcow2::backing_chain(&self.path)?;
        if let Some((base, format)) = &self.base
            && let Ok(canon) = std::fs::canonicalize(base)
            && chain.iter().any(|(p, _)| *p == canon)
        {
            return collapse_onto(&self.path, base, *format);
        }
        match chain.last() {
            None => Ok(false),
            Some((bottom, Format::Raw)) => collapse_onto(&self.path, bottom, Format::Raw),
            Some((_, Format::Qcow2)) => {
                qcow2::flatten(&self.path)?;
                Ok(true)
            }
        }
    }

    /// Collapses the chain and moves the disk to `dest`, replacing it
    /// atomically (a rename; across filesystems a copy to a temporary file
    /// next to `dest`, synced, then renamed): a local checkpoint export.
    /// `dest` may be the checkpoint the session was resumed from. Returns
    /// the size in `bytes`.
    pub fn export_to(&self, dest: &Path) -> Result<u64, String> {
        self.collapse()?;
        if qcow2::backing_path(&self.path)?.is_some_and(|b| same_file(&b, dest)) {
            return Err(format!(
                "cannot checkpoint: rebased overlay still points to destination checkpoint path ({})",
                dest.display()
            ));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        std::fs::File::open(&self.path)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("cannot sync {}: {e}", self.path.display()))?;
        if std::fs::rename(&self.path, dest).is_err() {
            replace_by_copy(&self.path, dest)?;
            let _ = std::fs::remove_file(&self.path);
        }
        if let Some(parent) = dest.parent() {
            sync_dir(parent);
        }
        std::fs::metadata(dest).map(|m| m.len()).map_err(|e| e.to_string())
    }
}

/// Whether `path` is a block device (the only special file allowed, as the
/// controller's own raw root disk).
fn is_block_device(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::metadata(path).is_ok_and(|m| m.file_type().is_block_device())
}

/// Size of a block device in `bytes`.
fn block_device_size(path: &Path) -> Result<u64, String> {
    let err = |e: std::io::Error| {
        format!("rootfs.size: cannot determine the size of block device {}: {e}", path.display())
    };
    #[cfg(target_os = "macos")]
    {
        let f = std::fs::File::open(path).map_err(err)?;
        use std::os::fd::AsRawFd;
        // <sys/disk.h>: DKIOCGETBLOCKSIZE, DKIOCGETBLOCKCOUNT
        const DKIOCGETBLOCKSIZE: libc::c_ulong = 0x4004_6418;
        const DKIOCGETBLOCKCOUNT: libc::c_ulong = 0x4008_6419;
        let mut block: u32 = 0;
        let mut count: u64 = 0;
        // SAFETY: valid fd, out-pointers sized per the ioctl definitions.
        let ok = unsafe {
            libc::ioctl(f.as_raw_fd(), DKIOCGETBLOCKSIZE, &mut block) == 0
                && libc::ioctl(f.as_raw_fd(), DKIOCGETBLOCKCOUNT, &mut count) == 0
        };
        if ok {
            return Ok(u64::from(block) * count);
        }
        Err(err(std::io::Error::last_os_error()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        use std::io::{Seek, SeekFrom};
        let mut f = std::fs::File::open(path).map_err(err)?;
        f.seek(SeekFrom::End(0)).map_err(err)
    }
}

/// Best-effort fsync of a directory, so a rename in it survives a crash.
fn sync_dir(dir: &Path) {
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

/// Replaces `dest` with a copy of `src` without ever leaving a partial `dest`.
fn replace_by_copy(src: &Path, dest: &Path) -> Result<(), String> {
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dest.with_file_name(format!(".{name}.partial-{}", std::process::id()));
    let res = (|| {
        std::fs::copy(src, &tmp)?;
        std::fs::File::open(&tmp)?.sync_all()?;
        std::fs::rename(&tmp, dest)
    })();
    res.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot write {}: {e}", dest.display())
    })
}

/// Why a prepared root disk cannot be exported for a checkpoint (the SDK's
/// messages), `None` when it can.
pub fn export_blocker(disk: Option<&RootDisk>) -> Option<String> {
    let Some(disk) = disk else { return Some("vm has no root disk".into()) };
    if disk.snapshot {
        Some("cannot checkpoint: root disk is running in ephemeral snapshot mode".into())
    } else if disk.format != "qcow2" {
        Some(format!("cannot checkpoint: root disk must be qcow2 (got {})", disk.format))
    } else if disk.read_only {
        Some("cannot checkpoint: root disk is read-only".into())
    } else {
        None
    }
}

/// Points an imported checkpoint at this machine's rootfs (in place, metadata
/// only; `VmCheckpoint.resume`): its backing file names the machine and image
/// directory it was created with. A checkpoint without a backing file is
/// standalone and stays as it is.
///
/// The checkpoint is untrusted (uploaded, or a file of unknown origin): its
/// header must be safe to hand to the VMM ([`qcow2::check_attachable_features`]:
/// no external data file, encryption, unknown features), and afterwards its
/// backing chain must be exactly the rootfs and the rootfs's own chain, so
/// nothing in the header can make the VMM open another host file.
fn rebase_checkpoint(checkpoint: &Path, rootfs: &Path, format: Format) -> Result<(), String> {
    let header = qcow2::read_header(checkpoint)?;
    qcow2::check_attachable_features(&header)
        .map_err(|e| format!("cannot resume checkpoint {}: {e}", checkpoint.display()))?;
    let rootfs_chain = qcow2::validate_chain(rootfs, format)?;
    match &header.backing_file {
        None => {}
        Some(name) => {
            let backing = qcow2::resolve_backing(checkpoint, name);
            if same_file(&backing, checkpoint) {
                return Err(format!(
                    "checkpoint is corrupt: qcow2 backing file points to itself ({})",
                    checkpoint.display()
                ));
            }
            // by name, like the SDK: a checkpoint should not keep naming
            // another image directory even if it holds the same rootfs
            if !same_name(&backing, rootfs)
                || header.backing_format().as_deref() != Some(format.name())
            {
                set_backing_name(checkpoint, rootfs, format)?;
            }
        }
    }
    let chain = qcow2::validate_chain(checkpoint, Format::Qcow2)
        .map_err(|e| format!("cannot resume checkpoint: {e}"))?;
    let expected = if header.backing_file.is_none() {
        Vec::new()
    } else {
        let canon = std::fs::canonicalize(rootfs).map_err(|e| e.to_string())?;
        std::iter::once((canon, format)).chain(rootfs_chain).collect()
    };
    if chain != expected {
        return Err(format!(
            "cannot resume checkpoint {}: its backing chain is not the image's rootfs",
            checkpoint.display()
        ));
    }
    Ok(())
}

/// Applies `root_disk.mode`/`size`: creates the overlay in `dir` when needed
/// and rewrites the disk to what the VMM should attach. `krun` has no
/// snapshot mode, so `memory` becomes an overlay there (like the node
/// engine). `checkpoint` boots from an imported checkpoint disk
/// (`imported`), rebased onto the image's rootfs, below a fresh overlay.
/// Without a mode `path` is used as is and `size` grows it in place.
/// Returns the disk a checkpoint export reads, if any.
pub fn prepare(
    vm: &mut VmConfig,
    dir: &Path,
    krun: bool,
    imported: Option<&Path>,
) -> Result<Option<Overlay>, String> {
    let Some(disk) = vm.root_disk.as_mut() else { return Ok(None) };
    if !disk.path.is_empty() {
        // it may become a backing file name, which is relative to the overlay
        disk.path = std::path::absolute(&disk.path)
            .map_err(|e| format!("invalid root_disk.path {}: {e}", disk.path))?
            .display()
            .to_string();
    }
    if disk.format.is_empty() && !disk.path.is_empty() {
        disk.format = infer_format(&disk.path).into();
    }
    let Some(mode) = disk.mode.take() else {
        // the controller's own disk
        if disk.path.is_empty() {
            return Err("root_disk.path is required".into());
        }
        let format = Format::parse(&disk.format)?;
        let path = Path::new(&disk.path);
        let size = disk.size.take();
        if size.is_some() && (disk.read_only || disk.snapshot) {
            return Err(
                "rootfs.size requires a writable root disk (rootfs.mode cannot be readonly)".into(),
            );
        }
        if size == Some(0) {
            return Err("invalid disk resize target: 0".into());
        }
        if is_block_device(path) {
            // the caller's own device, attached raw as before (a qcow2 on a
            // device would need its metadata validated: not supported)
            if format != Format::Raw {
                return Err(format!(
                    "{}: a block device can only be attached as a raw disk (sandbox.rootDiskFormat \"raw\"), not {}",
                    path.display(),
                    format.name()
                ));
            }
            if let Some(bytes) = size {
                let have = block_device_size(path)?;
                if have < bytes {
                    return Err(format!(
                        "rootfs.size: block device {} has {have} bytes, less than {bytes} (block devices are not resized)",
                        path.display()
                    ));
                }
            }
            return Ok(None);
        }
        // the VMM opens it and its backing chain
        qcow2::validate_chain(path, format)?;
        if let Some(bytes) = size {
            qcow2::ensure_min_size(path, format, bytes)?;
        }
        let writable = !disk.read_only && !disk.snapshot && format == Format::Qcow2;
        return Ok(writable.then(|| Overlay { path: PathBuf::from(&disk.path), base: None }));
    };
    if disk.path.is_empty() {
        return Err("root_disk.path is required (or vm.image)".into());
    }
    let size = disk.size.take();
    let base_path = PathBuf::from(&disk.path);
    let base_format = Format::parse(&disk.format)?;
    // attached directly or below an overlay: the VMM opens its whole chain
    qcow2::validate_chain(&base_path, base_format)?;
    if mode == "checkpoint" {
        let imported = imported.ok_or("root_disk.mode checkpoint requires checkpoint_import")?;
        rebase_checkpoint(imported, &base_path, base_format)?;
        disk.path = imported.display().to_string();
        disk.format = "qcow2".into();
    }
    let mut created = None;
    let mut overlay = |disk: &mut RootDisk| -> Result<(), String> {
        let path = dir.join("rootfs.qcow2");
        qcow2::create_overlay(&path, &disk.path, Format::parse(&disk.format)?, None)?;
        disk.path = path.display().to_string();
        disk.format = "qcow2".into();
        disk.read_only = false;
        disk.snapshot = false;
        created = Some(Overlay { path, base: Some((base_path.clone(), base_format)) });
        Ok(())
    };
    match mode.as_str() {
        "readonly" => {
            if size.is_some() {
                return Err(
                    "rootfs.size requires a writable root disk (rootfs.mode cannot be readonly)"
                        .into(),
                );
            }
            disk.read_only = true;
            disk.snapshot = false;
        }
        "memory" if !krun && size.is_none() => {
            disk.read_only = false;
            disk.snapshot = true;
        }
        "memory" | "cow" | "auto" | "checkpoint" => overlay(disk)?,
        other => return Err(format!("unsupported rootfs mode: {other}")),
    }
    if let Some(bytes) = size {
        if bytes == 0 {
            return Err("invalid disk resize target: 0".into());
        }
        qcow2::ensure_min_size(Path::new(&disk.path), Format::parse(&disk.format)?, bytes)?;
    }
    Ok(created)
}

/// [`prepare`] for VMMs that only attach raw disks (Firecracker). The
/// writable modes (`auto`, `cow`, `memory`) discard their writes with the
/// session: the base is attached as a `snapshot` (read-only, the guest keeps
/// its writes in a tmpfs overlay, see [`crate::firecracker::config`]), so
/// nothing is copied and every VM shares the base's page cache. With
/// `rootfs.size` the disk must grow, so it gets a raw copy in `dir` instead.
/// `readonly` attaches the base itself. Checkpoints need a qcow2 overlay, so
/// `checkpoint` is refused and a prepared disk is never exportable.
pub fn prepare_raw(vm: &mut VmConfig, dir: &Path) -> Result<(), String> {
    let Some(disk) = vm.root_disk.as_mut() else { return Ok(()) };
    if !disk.path.is_empty() {
        disk.path = std::path::absolute(&disk.path)
            .map_err(|e| format!("invalid root_disk.path {}: {e}", disk.path))?
            .display()
            .to_string();
    }
    if disk.path.is_empty() {
        return Err("root_disk.path is required (or vm.image)".into());
    }
    if disk.format.is_empty() {
        disk.format = infer_format(&disk.path).into();
    }
    let path = PathBuf::from(&disk.path);
    let format = Format::parse(&disk.format)?;
    if format != Format::Raw {
        return Err(format!(
            "the firecracker backend needs a raw root disk ({} is {})",
            path.display(),
            format.name()
        ));
    }
    if !is_block_device(&path) {
        qcow2::validate_chain(&path, format)?;
    }
    let size = disk.size.take();
    if size == Some(0) {
        return Err("invalid disk resize target: 0".into());
    }
    let copy = |disk: &mut RootDisk| -> Result<(), String> {
        let dest = dir.join("rootfs.raw");
        // std::fs::copy uses copy_file_range on Linux: a reflink where the
        // filesystem supports it
        std::fs::copy(&path, &dest).map_err(|e| {
            format!("cannot copy root disk {} to {}: {e}", path.display(), dest.display())
        })?;
        disk.path = dest.display().to_string();
        disk.read_only = false;
        disk.snapshot = false;
        Ok(())
    };
    // writes discarded: an overlay over the read-only base, or a copy to grow
    let discard_writes = |disk: &mut RootDisk| -> Result<(), String> {
        if size.is_some() {
            return copy(disk);
        }
        disk.read_only = false;
        disk.snapshot = true;
        Ok(())
    };
    match disk.mode.take().as_deref() {
        // the controller's own disk: as is, unless its writes are to be discarded
        None if disk.snapshot => discard_writes(disk)?,
        None => {}
        Some("readonly") => {
            if size.is_some() {
                return Err(
                    "rootfs.size requires a writable root disk (rootfs.mode cannot be readonly)"
                        .into(),
                );
            }
            disk.read_only = true;
            disk.snapshot = false;
        }
        Some("auto" | "cow" | "memory") => discard_writes(disk)?,
        Some("checkpoint") => {
            return Err("checkpoints are not supported with vmm=firecracker".into());
        }
        Some(other) => return Err(format!("unsupported rootfs mode: {other}")),
    }
    if let Some(bytes) = size {
        if disk.read_only || disk.snapshot {
            return Err(
                "rootfs.size requires a writable root disk (rootfs.mode cannot be readonly)".into(),
            );
        }
        qcow2::ensure_min_size(Path::new(&disk.path), Format::Raw, bytes)?;
    }
    Ok(())
}

/// Writes a qcow2 (empty, `size` bytes) whose header `edit` may tamper with.
#[cfg(test)]
pub(crate) fn craft_qcow2(
    path: &Path,
    size: u64,
    backing: Option<(&str, &str)>,
    edit: impl FnOnce(&mut qcow2::Header),
) {
    let mut bytes = qcow2::new_image(size, None).unwrap();
    let mut h = qcow2::Header::parse(&bytes[..65536]).unwrap();
    h.set_backing(backing);
    edit(&mut h);
    let encoded = h.encode().unwrap();
    bytes[..65536].fill(0);
    bytes[..encoded.len()].copy_from_slice(&encoded);
    std::fs::write(path, bytes).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use gondolin_qcow2::header::{EXT_DATA_FILE, Extension, INCOMPAT_DATA_FILE};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> TempDir {
            let dir = std::env::temp_dir()
                .join(format!("gondolind-rootdisk-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn raw_vm(mode: Option<&str>, path: &Path) -> VmConfig {
        VmConfig { root_disk: Some(disk(mode, path, "raw")), ..crate::tests::test_vm() }
    }

    #[test]
    fn raw_disks_for_firecracker() {
        let t = TempDir::new("raw");
        let base = t.0.join("rootfs.ext4");
        std::fs::write(&base, vec![7u8; 4096]).unwrap();
        let session = t.0.join("session");
        std::fs::create_dir_all(&session).unwrap();

        // writable modes: the base as a snapshot (the guest overlays its
        // writes), nothing copied
        for mode in ["auto", "cow", "memory"] {
            let mut vm = raw_vm(Some(mode), &base);
            prepare_raw(&mut vm, &session).unwrap();
            let d = vm.root_disk.unwrap();
            assert_eq!(PathBuf::from(&d.path), base, "{mode}");
            assert_eq!(d.format, "raw");
            assert!(d.snapshot && !d.read_only, "{mode}");
            assert!(!session.join("rootfs.raw").exists());
        }
        // the controller's own snapshot disk too
        let mut vm = raw_vm(None, &base);
        vm.root_disk.as_mut().unwrap().snapshot = true;
        prepare_raw(&mut vm, &session).unwrap();
        assert_eq!(PathBuf::from(&vm.root_disk.unwrap().path), base);

        // readonly: the base itself
        let mut vm = raw_vm(Some("readonly"), &base);
        prepare_raw(&mut vm, &session).unwrap();
        let d = vm.root_disk.unwrap();
        assert_eq!(PathBuf::from(&d.path), base);
        assert!(d.read_only);

        // rootfs.size: a private copy that grows, the base untouched
        let mut vm = raw_vm(Some("cow"), &base);
        vm.root_disk.as_mut().unwrap().size = Some(1 << 20);
        prepare_raw(&mut vm, &session).unwrap();
        let d = vm.root_disk.unwrap();
        assert_eq!(PathBuf::from(&d.path), session.join("rootfs.raw"));
        assert!(!d.read_only && !d.snapshot);
        assert_eq!(std::fs::read(&d.path).unwrap()[..4096], vec![7u8; 4096]);
        assert_eq!(std::fs::metadata(session.join("rootfs.raw")).unwrap().len(), 1 << 20);
        assert_eq!(std::fs::metadata(&base).unwrap().len(), 4096);

        // no checkpoints, no qcow2
        let mut vm = raw_vm(Some("checkpoint"), &base);
        assert!(prepare_raw(&mut vm, &session).unwrap_err().contains("checkpoints"));
        let q = t.0.join("disk.qcow2");
        craft_qcow2(&q, 1 << 20, None, |_| {});
        let mut vm =
            VmConfig { root_disk: Some(disk(Some("cow"), &q, "qcow2")), ..crate::tests::test_vm() };
        assert!(prepare_raw(&mut vm, &session).unwrap_err().contains("raw root disk"));
        let mut vm = raw_vm(Some("readonly"), &base);
        vm.root_disk.as_mut().unwrap().size = Some(1 << 20);
        assert!(prepare_raw(&mut vm, &session).unwrap_err().contains("writable"));
    }

    fn disk(mode: Option<&str>, path: &Path, format: &str) -> RootDisk {
        RootDisk {
            path: path.display().to_string(),
            format: format.into(),
            read_only: false,
            snapshot: false,
            mode: mode.map(str::to_string),
            size: None,
        }
    }

    fn prepare_disk(d: RootDisk, dir: &Path, imported: Option<&Path>) -> Result<VmConfig, String> {
        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(d);
        prepare(&mut vm, dir, true, imported)?;
        Ok(vm)
    }

    fn data_file(h: &mut qcow2::Header) {
        h.incompatible_features |= INCOMPAT_DATA_FILE;
        h.extensions.push(Extension { kind: EXT_DATA_FILE, data: b"/etc/passwd".to_vec() });
    }

    /// Writes `fill` into guest cluster `c` of a qcow2 (64 KiB clusters).
    fn write(path: &Path, c: u64, fill: u8) {
        let f = std::fs::File::options().read(true).write(true).open(path).unwrap();
        let mut img = qcow2::Image::open_rw(f).unwrap();
        img.write_cluster(c, Some(&vec![fill; 65536])).unwrap();
        img.sync().unwrap();
    }

    fn content(path: &Path) -> Vec<u8> {
        let mut layers = qcow2::open_layers(path, Format::Qcow2).unwrap();
        let mut buf = vec![0u8; 4 * 65536];
        qcow2::read_at(&mut layers, 0, &mut buf).unwrap();
        buf
    }

    fn append_trailer(path: &Path) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(b"{}GONDCPT1").unwrap();
        f.write_all(&2u64.to_be_bytes()).unwrap();
    }

    #[test]
    fn resume_x_then_checkpoint_to_x() {
        let t = TempDir::new("samex");
        let rootfs = t.0.join("rootfs.ext4");
        std::fs::write(&rootfs, vec![0x11u8; 4 * 65536]).unwrap();
        // checkpoint X: cluster 1 written on the rootfs
        let x = t.0.join("x.qcow2");
        qcow2::create_overlay(&x, rootfs.to_str().unwrap(), Format::Raw, None).unwrap();
        write(&x, 1, 0x22);
        append_trailer(&x);
        // resume X, write cluster 2, checkpoint to X again
        let session = t.0.join("session");
        std::fs::create_dir_all(&session).unwrap();
        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(disk(Some("checkpoint"), &rootfs, "raw"));
        let overlay = prepare(&mut vm, &session, true, Some(&x)).unwrap().unwrap();
        write(&overlay.path, 2, 0x33);
        overlay.export_to(&x).unwrap();
        assert!(!overlay.path.exists());
        assert_eq!(qcow2::backing_path(&x).unwrap(), Some(rootfs.clone()));
        let got = content(&x);
        assert!(got[..65536].iter().all(|&b| b == 0x11));
        assert!(got[65536..2 * 65536].iter().all(|&b| b == 0x22), "X's data survives");
        assert!(got[2 * 65536..3 * 65536].iter().all(|&b| b == 0x33));

        // the copy fallback replaces atomically too
        let other = t.0.join("other.qcow2");
        qcow2::create_overlay(&other, rootfs.to_str().unwrap(), Format::Raw, None).unwrap();
        replace_by_copy(&other, &x).unwrap();
        assert_eq!(std::fs::read(&other).unwrap(), std::fs::read(&x).unwrap());
        assert!(
            std::fs::read_dir(&t.0)
                .unwrap()
                .all(|e| { !e.unwrap().file_name().to_string_lossy().contains(".partial-") })
        );
    }

    #[test]
    fn standalone_checkpoints_can_be_checkpointed_again() {
        let t = TempDir::new("standalone");
        let rootfs = t.0.join("rootfs.ext4");
        std::fs::write(&rootfs, vec![0x11u8; 4 * 65536]).unwrap();
        let x = t.0.join("x.qcow2");
        std::fs::write(&x, qcow2::new_image(4 * 65536, None).unwrap()).unwrap();
        write(&x, 0, 0x44);
        append_trailer(&x);
        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(disk(Some("checkpoint"), &rootfs, "raw"));
        let overlay = prepare(&mut vm, &t.0, true, Some(&x)).unwrap().unwrap();
        write(&overlay.path, 3, 0x55);
        let y = t.0.join("y.qcow2");
        overlay.export_to(&y).unwrap();
        // standalone again: X's data copied, no backing file
        assert_eq!(qcow2::backing_path(&y).unwrap(), None);
        let got = content(&y);
        assert!(got[..65536].iter().all(|&b| b == 0x44));
        assert!(got[65536..3 * 65536].iter().all(|&b| b == 0));
        assert!(got[3 * 65536..].iter().all(|&b| b == 0x55));
    }

    #[test]
    fn relative_rootfs_paths_become_absolute_backing_names() {
        let t = TempDir::new("relative");
        let rootfs = t.0.join("rootfs.ext4");
        std::fs::write(&rootfs, vec![0u8; 65536]).unwrap();
        let cwd = std::env::current_dir().unwrap();
        let rel = pathdiff(&rootfs, &cwd);
        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(disk(Some("cow"), Path::new(&rel), "raw"));
        let overlay = prepare(&mut vm, &t.0, true, None).unwrap().unwrap();
        let name = qcow2::info(&overlay.path).unwrap().backing_file.unwrap();
        assert!(Path::new(&name).is_absolute(), "{name}");
        assert!(same_file(Path::new(&name), &rootfs));
    }

    /// `path` relative to `base` (`../..` up to the common prefix).
    fn pathdiff(path: &Path, base: &Path) -> String {
        let p: Vec<_> = path.components().collect();
        let b: Vec<_> = base.components().collect();
        let common = p.iter().zip(&b).take_while(|(x, y)| x == y).count();
        let mut out: Vec<String> = vec!["..".into(); b.len() - common];
        out.extend(p[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
        out.join("/")
    }

    #[test]
    fn export_blockers() {
        let mut d = disk(None, Path::new("/x.raw"), "raw");
        assert!(export_blocker(Some(&d)).unwrap().contains("must be qcow2 (got raw)"));
        d.format = "qcow2".into();
        assert_eq!(export_blocker(Some(&d)), None);
        d.read_only = true;
        assert!(export_blocker(Some(&d)).unwrap().contains("read-only"));
        d.snapshot = true;
        assert!(export_blocker(Some(&d)).unwrap().contains("ephemeral snapshot"));
        assert_eq!(export_blocker(None).as_deref(), Some("vm has no root disk"));
    }

    #[test]
    fn crafted_checkpoints_are_refused() {
        let t = TempDir::new("crafted");
        let rootfs = t.0.join("rootfs.ext4");
        std::fs::write(&rootfs, vec![0u8; 1 << 20]).unwrap();
        let ckpt = t.0.join("ckpt.qcow2");
        type Edit = Box<dyn Fn(&mut qcow2::Header)>;
        let cases: [(&str, Edit); 6] = [
            (
                "repeated header extension",
                Box::new(|h: &mut qcow2::Header| {
                    h.extensions.push(Extension {
                        kind: gondolin_qcow2::header::EXT_BACKING_FORMAT,
                        data: b"qcow2".to_vec(),
                    })
                }),
            ),
            ("external data file", Box::new(data_file)),
            (
                "external data file",
                Box::new(|h: &mut qcow2::Header| {
                    h.extensions.push(Extension { kind: EXT_DATA_FILE, data: b"/etc".to_vec() })
                }),
            ),
            (
                "incompatible features",
                Box::new(|h: &mut qcow2::Header| h.incompatible_features |= 1 << 20),
            ),
            ("encrypted", Box::new(|h: &mut qcow2::Header| h.crypt_method = 2)),
            ("extended L2", Box::new(|h: &mut qcow2::Header| h.incompatible_features |= 1 << 4)),
        ];
        for (want, edit) in cases {
            craft_qcow2(&ckpt, 1 << 20, Some(("/elsewhere/rootfs.ext4", "raw")), |h| edit(h));
            let before = std::fs::read(&ckpt).unwrap();
            let err = prepare_disk(disk(Some("checkpoint"), &rootfs, "raw"), &t.0, Some(&ckpt))
                .unwrap_err();
            assert!(err.contains(want), "{want}: {err}");
            assert!(std::fs::read(&ckpt).unwrap() == before, "refused before any rewrite");
        }
    }

    #[test]
    fn crafted_checkpoint_backings_are_replaced_by_the_rootfs() {
        let t = TempDir::new("backing");
        let rootfs = t.0.join("rootfs.ext4");
        std::fs::write(&rootfs, vec![0u8; 1 << 20]).unwrap();
        let ckpt = t.0.join("ckpt.qcow2");
        let rootfs_name = rootfs.display().to_string();
        let backings = [
            ("json:{\"driver\":\"vvfat\",\"dir\":\"/\"}", "vvfat"),
            ("nbd:localhost:10809", "raw"),
            ("/dev/sda", "raw"),
            // the rootfs by name, but probed or as another format
            (rootfs_name.as_str(), "qcow2"),
            (rootfs_name.as_str(), ""),
        ];
        for (name, format) in backings {
            craft_qcow2(&ckpt, 1 << 20, Some((name, format)), |h| {
                if format.is_empty() {
                    h.extensions.clear();
                }
            });
            let vm =
                prepare_disk(disk(Some("checkpoint"), &rootfs, "raw"), &t.0, Some(&ckpt)).unwrap();
            let info = qcow2::info(&ckpt).unwrap();
            assert_eq!(info.backing_file.as_deref(), Some(rootfs_name.as_str()), "{name}");
            assert_eq!(info.backing_format.as_deref(), Some("raw"), "{name}");
            let attached = vm.root_disk.unwrap();
            assert_eq!(
                qcow2::validate_chain(Path::new(&attached.path), Format::Qcow2).unwrap(),
                vec![
                    (std::fs::canonicalize(&ckpt).unwrap(), Format::Qcow2),
                    (std::fs::canonicalize(&rootfs).unwrap(), Format::Raw)
                ]
            );
        }
        // a qcow2 rootfs: the checkpoint chain is the rootfs and its chain
        let base = t.0.join("base.raw");
        std::fs::write(&base, vec![1u8; 1 << 20]).unwrap();
        let qrootfs = t.0.join("rootfs.qcow2");
        qcow2::create_overlay(&qrootfs, base.to_str().unwrap(), Format::Raw, None).unwrap();
        craft_qcow2(&ckpt, 1 << 20, Some(("/x/rootfs.qcow2", "qcow2")), |_| {});
        prepare_disk(disk(Some("checkpoint"), &qrootfs, "qcow2"), &t.0, Some(&ckpt)).unwrap();
        // a standalone checkpoint stays standalone
        craft_qcow2(&ckpt, 1 << 20, None, |_| {});
        prepare_disk(disk(Some("checkpoint"), &rootfs, "raw"), &t.0, Some(&ckpt)).unwrap();
        assert_eq!(qcow2::info(&ckpt).unwrap().backing_file, None);
    }

    /// A block device of this machine, if any (metadata only; opening it
    /// usually needs root).
    fn some_block_device() -> Option<PathBuf> {
        std::fs::read_dir("/dev").ok()?.flatten().map(|e| e.path()).find(|p| is_block_device(p))
    }

    #[test]
    fn block_devices_only_as_own_raw_disks() {
        let t = TempDir::new("blockdev");
        // special files that are not block devices are refused, raw or not
        let fifo = t.0.join("fifo");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        for special in [Path::new("/dev/null"), Path::new("/dev/zero"), fifo.as_path()] {
            let err = prepare_disk(disk(None, special, "raw"), &t.0, None).unwrap_err();
            assert!(err.contains("not a regular file"), "{}: {err}", special.display());
        }
        let Some(dev) = some_block_device() else {
            eprintln!("skipped: no block device in /dev");
            return;
        };
        // the caller's own raw device: attached as is, not exportable
        let vm = prepare_disk(disk(None, &dev, "raw"), &t.0, None).unwrap();
        assert_eq!(vm.root_disk.unwrap().path, dev.display().to_string());
        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(disk(None, &dev, "raw"));
        assert_eq!(prepare(&mut vm, &t.0, true, None).unwrap(), None);
        // never as qcow2
        let err = prepare_disk(disk(None, &dev, "qcow2"), &t.0, None).unwrap_err();
        assert!(err.contains("block device can only be attached as a raw disk"), "{err}");
        // never below an overlay or a mode
        let err = prepare_disk(disk(Some("cow"), &dev, "raw"), &t.0, None).unwrap_err();
        assert!(err.contains("not a regular file"), "{err}");
        // never in a backing chain
        let mine = t.0.join("mine.qcow2");
        craft_qcow2(&mine, 1 << 20, Some((dev.to_str().unwrap(), "raw")), |_| {});
        let err = prepare_disk(disk(None, &mine, "qcow2"), &t.0, None).unwrap_err();
        assert!(err.contains("not a regular file"), "{err}");
        // size: never resized; refused unless the device is large enough
        let mut d = disk(None, &dev, "raw");
        d.size = Some(u64::MAX / 2);
        let err = prepare_disk(d, &t.0, None).unwrap_err();
        assert!(err.contains("block device"), "{err}");
        let mut d = disk(None, &dev, "raw");
        d.size = Some(512);
        d.read_only = true;
        assert!(prepare_disk(d, &t.0, None).unwrap_err().contains("writable"));
    }

    /// `GONDOLIN_TEST_BLOCK_DEVICE`: a block device this user can open
    /// (macOS: `hdiutil attach -imagekey diskimage-class=CRawDiskImage
    /// -nomount 10m.img`; Linux: a loop device): `size` is checked against
    /// its real size.
    #[test]
    fn block_device_size_is_checked() {
        let Some(dev) = std::env::var_os("GONDOLIN_TEST_BLOCK_DEVICE").map(PathBuf::from) else {
            eprintln!("skipped: GONDOLIN_TEST_BLOCK_DEVICE not set");
            return;
        };
        let t = TempDir::new("blocksize");
        let have = block_device_size(&dev).unwrap();
        assert!(have > 0);
        let mut d = disk(None, &dev, "raw");
        d.size = Some(have);
        prepare_disk(d, &t.0, None).unwrap();
        let mut d = disk(None, &dev, "raw");
        d.size = Some(have + 512);
        let err = prepare_disk(d, &t.0, None).unwrap_err();
        assert!(err.contains("are not resized"), "{err}");
    }

    #[test]
    fn own_disks_and_qcow2_bases_are_validated() {
        let t = TempDir::new("own");
        let raw = t.0.join("base.raw");
        std::fs::write(&raw, vec![0u8; 1 << 20]).unwrap();
        let mine = t.0.join("mine.qcow2");
        let raw_name = raw.display().to_string();
        let mid = t.0.join("mid.qcow2");
        craft_qcow2(&mid, 1 << 20, Some((&raw_name, "raw")), data_file);
        let mid_name = mid.display().to_string();
        let cases = [
            ((raw_name.as_str(), ""), "without a backing format"),
            ((raw_name.as_str(), "vmdk"), "unsupported backing format"),
            (("nbd:localhost:10809", "raw"), "not a file path"),
            (("/dev/null", "raw"), "not a regular file"),
            ((mid_name.as_str(), "qcow2"), "external data file"),
        ];
        for ((name, format), want) in cases {
            craft_qcow2(&mine, 1 << 20, Some((name, format)), |h| {
                if format.is_empty() {
                    h.extensions.clear();
                }
            });
            for mode in [None, Some("cow"), Some("readonly"), Some("memory")] {
                let err = prepare_disk(disk(mode, &mine, "qcow2"), &t.0, None).unwrap_err();
                assert!(err.contains(want), "{name} {mode:?}: {err}");
            }
        }
        craft_qcow2(&mine, 1 << 20, None, data_file);
        let err = prepare_disk(disk(None, &mine, "qcow2"), &t.0, None).unwrap_err();
        assert!(err.contains("external data file"), "{err}");
        // a raw disk is attached as raw: nothing to follow
        prepare_disk(disk(None, &mine, "raw"), &t.0, None).unwrap();
        craft_qcow2(&mine, 1 << 20, Some((&raw_name, "raw")), |_| {});
        prepare_disk(disk(None, &mine, "qcow2"), &t.0, None).unwrap();
        prepare_disk(disk(Some("cow"), &mine, "qcow2"), &t.0, None).unwrap();
    }

    #[test]
    fn formats() {
        assert_eq!(infer_format("/x/root.QCOW2"), "qcow2");
        assert_eq!(infer_format("/x/rootfs.ext4"), "raw");
    }

    #[test]
    fn modes_without_overlay() {
        let t = TempDir::new("modes");
        let rootfs = t.0.join("rootfs.ext4");
        std::fs::write(&rootfs, b"").unwrap();
        let rootfs = rootfs.display().to_string();
        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(RootDisk {
            path: rootfs.clone(),
            format: String::new(),
            read_only: false,
            snapshot: false,
            mode: Some("memory".into()),
            size: None,
        });
        let dir = std::env::temp_dir();
        prepare(&mut vm, &dir, false, None).unwrap();
        let disk = vm.root_disk.as_ref().unwrap();
        assert!(disk.snapshot && disk.format == "raw" && disk.mode.is_none());

        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(RootDisk {
            path: rootfs,
            format: "raw".into(),
            read_only: false,
            snapshot: false,
            mode: Some("readonly".into()),
            size: Some(1 << 30),
        });
        assert!(prepare(&mut vm, &dir, false, None).unwrap_err().contains("writable"));
    }

    #[test]
    fn overlays_resize_and_checkpoints() {
        let dir = std::env::temp_dir().join(format!("gondolind-rootdisk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rootfs = dir.join("rootfs.ext4");
        std::fs::write(&rootfs, vec![0x5a; 1 << 20]).unwrap();
        let disk = |mode: &str, path: &Path, size: Option<u64>| RootDisk {
            path: path.display().to_string(),
            format: String::new(),
            read_only: false,
            snapshot: false,
            mode: Some(mode.into()),
            size,
        };

        // cow + size: an overlay on the rootfs, grown
        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(disk("cow", &rootfs, Some(64 << 20)));
        let overlay = prepare(&mut vm, &dir, false, None).unwrap().unwrap();
        assert_eq!(overlay.base, Some((rootfs.clone(), Format::Raw)));
        let d = vm.root_disk.as_ref().unwrap();
        assert_eq!(
            (d.format.as_str(), d.path.clone()),
            ("qcow2", overlay.path.display().to_string())
        );
        assert_eq!(qcow2::virtual_size(&overlay.path, Format::Qcow2).unwrap(), 64 << 20);
        assert_eq!(qcow2::backing_path(&overlay.path).unwrap(), Some(rootfs.clone()));
        assert!(!collapse_onto(&overlay.path, &rootfs, Format::Raw).unwrap());

        // an imported checkpoint (trailer, foreign backing name) below a fresh overlay
        let imported = dir.join("imported.qcow2");
        std::fs::rename(&overlay.path, &imported).unwrap();
        qcow2::set_backing(&imported, Some(("/elsewhere/rootfs.ext4", Format::Raw))).unwrap();
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().append(true).open(&imported).unwrap();
            f.write_all(b"{}GONDCPT1").unwrap();
            f.write_all(&2u64.to_be_bytes()).unwrap();
        }
        let sub = dir.join("session");
        std::fs::create_dir_all(&sub).unwrap();
        let mut vm = crate::tests::test_vm();
        vm.root_disk = Some(disk("checkpoint", &rootfs, None));
        let overlay = prepare(&mut vm, &sub, true, Some(&imported)).unwrap().unwrap();
        assert_eq!(overlay.base, Some((rootfs.clone(), Format::Raw)));
        assert_eq!(qcow2::backing_path(&imported).unwrap(), Some(rootfs.clone()));
        assert_eq!(qcow2::backing_path(&overlay.path).unwrap(), Some(imported.clone()));
        assert_eq!(qcow2::virtual_size(&overlay.path, Format::Qcow2).unwrap(), 64 << 20);
        // the export collapses the chain onto the rootfs
        assert!(overlay.collapse().unwrap());
        assert_eq!(qcow2::backing_path(&overlay.path).unwrap(), Some(rootfs.clone()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
