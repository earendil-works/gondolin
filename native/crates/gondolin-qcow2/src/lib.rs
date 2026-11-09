//! Dependency-free qcow2 handling for Gondolin's root disk overlays: the
//! subset of `qemu-img` the SDK, the daemon and the static CLI need.
//!
//! - [`info`]: format, virtual size, backing file name and format;
//! - [`create_overlay`]: an empty qcow2 v3 overlay (64 KiB clusters, 16-bit
//!   refcounts) on a raw or qcow2 backing file (`qemu-img create -b -F`);
//! - [`set_backing`]: change the backing file in place, metadata only
//!   (`qemu-img rebase -u`);
//! - [`resize`] / [`ensure_min_size`]: grow raw (`set_len`) and qcow2 images
//!   (size field, L1 table grown in place or relocated); shrinking is refused;
//! - [`rebase`]: safe rebase onto a file further down the backing chain
//!   (`qemu-img rebase -b`): every guest cluster whose content changes when
//!   the layers in between are dropped is copied into the top image.
//!
//! Images with features we do not implement are refused with
//! [`ErrorKind::Unsupported`]: extended L2 entries, external data files,
//! encryption, unknown incompatible features; writes additionally refuse
//! internal snapshots and dirty or corrupt images, and compressed clusters
//! cannot be read (they are never copied or rewritten).
//!
//! Gondolin's checkpoint files append a JSON trailer after the qcow2 data
//! (`[json][b"GONDCPT1"][u64be length]`, `host/src/checkpoint.ts`). The
//! end of the qcow2 data is not recorded anywhere (the trailer can even sit
//! in the unused tail of the last metadata cluster), so files ending in that
//! trailer are never allocated into: [`set_backing`] works on them (it only
//! rewrites cluster 0) and they can be backing files of any operation, but
//! [`resize`] and [`rebase`] refuse to modify them.
//!
//! All IO goes through [`Storage`] (positioned reads and writes, implemented
//! for `std::fs::File` and in-memory `Vec<u8>` for tests and fuzzing).

use std::fmt;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

mod chain;
pub mod header;
mod image;

pub use chain::{Layer, read_at, rebase_layers};
pub use header::Header;
pub use image::{Image, Mapping};

/// Default cluster size of images we create in `bytes`
pub const DEFAULT_CLUSTER_BITS: u32 = 16;
/// Magic at the end of a Gondolin checkpoint trailer
pub const CHECKPOINT_TRAILER_MAGIC: &[u8; 8] = b"GONDCPT1";
/// Maximum length of a backing chain (QEMU's limit is similar)
pub const MAX_CHAIN_DEPTH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Io,
    /// not a valid image
    Invalid,
    /// a valid image using a feature this crate does not implement
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl Error {
    pub fn invalid(message: impl Into<String>) -> Error {
        Error { kind: ErrorKind::Invalid, message: message.into() }
    }

    pub fn unsupported(message: impl Into<String>) -> Error {
        Error { kind: ErrorKind::Unsupported, message: message.into() }
    }

    /// Prefixes the message with a path.
    pub fn at(mut self, path: &Path) -> Error {
        self.message = format!("{}: {}", path.display(), self.message);
        self
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(err: io::Error) -> Error {
        Error { kind: ErrorKind::Io, message: err.to_string() }
    }
}

impl From<Error> for String {
    fn from(err: Error) -> String {
        err.message
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Disk image formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Raw,
    Qcow2,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Raw => "raw",
            Format::Qcow2 => "qcow2",
        }
    }

    /// `raw` or `qcow2`.
    pub fn parse(name: &str) -> Result<Format> {
        match name {
            "raw" => Ok(Format::Raw),
            "qcow2" => Ok(Format::Qcow2),
            other => Err(Error::unsupported(format!("unsupported disk format: {other}"))),
        }
    }

    /// The SDK's `inferDiskFormatFromPath`: `.qcow2`/`.qcow` is qcow2, else raw.
    pub fn from_path(path: &str) -> Format {
        let lower = path.to_lowercase();
        if lower.ends_with(".qcow2") || lower.ends_with(".qcow") {
            Format::Qcow2
        } else {
            Format::Raw
        }
    }
}

/// Positioned IO on an image file.
pub trait Storage {
    /// Reads at `offset`; returns 0 at the end.
    fn read_at(&mut self, buf: &mut [u8], offset: u64) -> io::Result<usize>;
    fn write_all_at(&mut self, buf: &[u8], offset: u64) -> io::Result<()>;
    /// Length in `bytes`.
    fn len(&mut self) -> io::Result<u64>;
    fn set_len(&mut self, len: u64) -> io::Result<()>;
    fn sync(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn is_empty(&mut self) -> io::Result<bool> {
        Ok(self.len()? == 0)
    }

    /// Fills `buf` from `offset`, with zeros past the end.
    fn read_zero_fill(&mut self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        let mut done = 0;
        while done < buf.len() {
            match self.read_at(&mut buf[done..], offset + done as u64) {
                Ok(0) => break,
                Ok(n) => done += n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        buf[done..].fill(0);
        Ok(())
    }
}

impl Storage for File {
    fn read_at(&mut self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        std::os::unix::fs::FileExt::read_at(self, buf, offset)
    }

    fn write_all_at(&mut self, buf: &[u8], offset: u64) -> io::Result<()> {
        std::os::unix::fs::FileExt::write_all_at(self, buf, offset)
    }

    fn len(&mut self) -> io::Result<u64> {
        Ok(self.metadata()?.len())
    }

    fn set_len(&mut self, len: u64) -> io::Result<()> {
        File::set_len(self, len)
    }

    fn sync(&mut self) -> io::Result<()> {
        self.sync_all()
    }
}

/// Largest in-memory image in `bytes` (keeps fuzzing bounded)
const MEM_LIMIT: u64 = 64 << 20;

impl Storage for Vec<u8> {
    fn read_at(&mut self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        let Ok(start) = usize::try_from(offset) else { return Ok(0) };
        if start >= Vec::len(self) {
            return Ok(0);
        }
        let n = buf.len().min(Vec::len(self) - start);
        buf[..n].copy_from_slice(&self[start..start + n]);
        Ok(n)
    }

    fn write_all_at(&mut self, buf: &[u8], offset: u64) -> io::Result<()> {
        let end = offset.checked_add(buf.len() as u64).filter(|&e| e <= MEM_LIMIT);
        let end = end.ok_or_else(|| io::Error::other("in-memory image too large"))? as usize;
        if end > Vec::len(self) {
            self.resize(end, 0);
        }
        self[offset as usize..end].copy_from_slice(buf);
        Ok(())
    }

    fn len(&mut self) -> io::Result<u64> {
        Ok(Vec::len(self) as u64)
    }

    fn set_len(&mut self, len: u64) -> io::Result<()> {
        if len > MEM_LIMIT {
            return Err(io::Error::other("in-memory image too large"));
        }
        self.resize(len as usize, 0);
        Ok(())
    }
}

/// Whether the storage ends in a Gondolin checkpoint trailer.
pub fn has_checkpoint_trailer<S: Storage>(s: &mut S) -> io::Result<bool> {
    let len = s.len()?;
    if len < 16 {
        return Ok(false);
    }
    let mut footer = [0u8; 16];
    s.read_zero_fill(&mut footer, len - 16)?;
    let json_len = u64::from_be_bytes(footer[8..].try_into().unwrap());
    Ok(&footer[..8] == CHECKPOINT_TRAILER_MAGIC && json_len <= len - 16)
}

/// What [`info`] reports about an image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Info {
    pub format: Format,
    /// virtual size in `bytes` (raw: file length)
    pub virtual_size: u64,
    /// backing file name as stored in the image
    pub backing_file: Option<String>,
    /// backing format from the header extension
    pub backing_format: Option<String>,
    /// qcow2 cluster size in `bytes`
    pub cluster_size: Option<u64>,
}

/// Whether QEMU would read a backing file name as a protocol or JSON
/// specification (`nbd:...`, `json:{...}`) instead of a file path: a `:`
/// before any `/` (`path_has_protocol`).
pub fn has_protocol_prefix(name: &str) -> bool {
    name.find(':').is_some_and(|i| !name[..i].contains('/'))
}

/// Refuses headers a VMM must not be handed, apart from the backing file:
/// external data files (QEMU and libkrun's imago open the file the header
/// names, imago even writable: a guest could read or write any host file),
/// encryption, extended L2 entries, corrupt images and unknown
/// incompatible features.
pub fn check_attachable_features(h: &Header) -> Result<()> {
    let f = h.incompatible_features;
    if f & !header::INCOMPAT_KNOWN != 0 {
        return Err(Error::unsupported(format!(
            "unsupported qcow2 incompatible features {:#x}",
            f & !header::INCOMPAT_KNOWN
        )));
    }
    if f & header::INCOMPAT_DATA_FILE != 0
        || h.extensions.iter().any(|e| e.kind == header::EXT_DATA_FILE)
    {
        return Err(Error::unsupported("qcow2 external data files are not supported"));
    }
    if f & header::INCOMPAT_EXTL2 != 0 {
        return Err(Error::unsupported("qcow2 extended L2 entries are not supported"));
    }
    if f & header::INCOMPAT_CORRUPT != 0 {
        return Err(Error::invalid("image is marked corrupt (run qemu-img check -r)"));
    }
    if h.crypt_method != 0 {
        return Err(Error::unsupported("encrypted qcow2 images are not supported"));
    }
    Ok(())
}

/// Refuses a backing file reference a VMM must not follow: a name QEMU
/// would parse as a protocol or JSON, or a missing (probed) or other format
/// than `raw`/`qcow2`.
pub fn check_backing_reference(h: &Header) -> Result<()> {
    let Some(name) = &h.backing_file else { return Ok(()) };
    if has_protocol_prefix(name) {
        return Err(Error::unsupported(format!("backing file name {name:?} is not a file path")));
    }
    match h.backing_format().as_deref() {
        Some("raw" | "qcow2") => Ok(()),
        Some(other) => Err(Error::unsupported(format!("unsupported backing format {other:?}"))),
        None => Err(Error::unsupported(
            "backing file without a backing format (set it with qemu-img rebase -u -F raw|qcow2)",
        )),
    }
}

/// [`check_attachable_features`] and [`check_backing_reference`].
pub fn check_attachable(h: &Header) -> Result<()> {
    check_attachable_features(h)?;
    check_backing_reference(h)
}

/// The header of a qcow2 file.
pub fn read_header(path: &Path) -> Result<Header> {
    let mut f = File::open(path).map_err(|e| Error::from(e).at(path))?;
    image::read_header(&mut f).map_err(|e| e.at(path))
}

fn regular_file(path: &Path) -> Result<()> {
    let meta = std::fs::metadata(path).map_err(|e| Error::from(e).at(path))?;
    if meta.is_file() { Ok(()) } else { Err(Error::unsupported("not a regular file").at(path)) }
}

/// Validates an image a VMM will attach and its whole backing chain: every
/// file is a regular file, every qcow2 layer passes [`check_attachable`],
/// and the chain ends in a raw file or a qcow2 without backing. Returns the
/// backing chain (canonical paths and formats, the image itself excluded).
pub fn validate_chain(path: &Path, format: Format) -> Result<Vec<(PathBuf, Format)>> {
    regular_file(path)?;
    let mut chain = Vec::new();
    if format == Format::Raw {
        return Ok(chain);
    }
    let mut seen = vec![std::fs::canonicalize(path).map_err(|e| Error::from(e).at(path))?];
    let mut current = path.to_path_buf();
    loop {
        let h = read_header(&current)?;
        check_attachable(&h).map_err(|e| e.at(&current))?;
        let Some(name) = h.backing_file.clone() else { break };
        if chain.len() >= MAX_CHAIN_DEPTH {
            return Err(Error::unsupported("backing chain too long").at(path));
        }
        let p = resolve_backing(&current, &name);
        let canon = std::fs::canonicalize(&p).map_err(|e| Error::from(e).at(&p))?;
        regular_file(&canon)?;
        if seen.contains(&canon) {
            return Err(Error::invalid(format!("backing chain loop at {}", p.display())));
        }
        let fmt = Format::parse(h.backing_format().as_deref().unwrap_or(""))?;
        seen.push(canon.clone());
        chain.push((canon, fmt));
        if fmt == Format::Raw {
            break;
        }
        current = p;
    }
    Ok(chain)
}

/// Probes the format by magic: qcow2 or raw.
pub fn probe(path: &Path) -> Result<Format> {
    let mut f = File::open(path).map_err(|e| Error::from(e).at(path))?;
    let mut magic = [0u8; 4];
    f.read_zero_fill(&mut magic, 0)?;
    Ok(if magic == header::MAGIC { Format::Qcow2 } else { Format::Raw })
}

/// Format (probed), virtual size and backing file of an image.
pub fn info(path: &Path) -> Result<Info> {
    let format = probe(path)?;
    image_info(path, format)
}

/// Like [`info`] with a known format (no probing: a raw file that starts
/// with the qcow2 magic stays raw).
pub fn image_info(path: &Path, format: Format) -> Result<Info> {
    let mut f = File::open(path).map_err(|e| Error::from(e).at(path))?;
    match format {
        Format::Raw => Ok(Info {
            format,
            virtual_size: f.len()?,
            backing_file: None,
            backing_format: None,
            cluster_size: None,
        }),
        Format::Qcow2 => {
            let h = image::read_header(&mut f).map_err(|e| e.at(path))?;
            Ok(Info {
                format,
                virtual_size: h.size,
                backing_format: h.backing_format(),
                cluster_size: Some(h.cluster_size()),
                backing_file: h.backing_file,
            })
        }
    }
}

/// Virtual size in `bytes`.
pub fn virtual_size(path: &Path, format: Format) -> Result<u64> {
    Ok(image_info(path, format)?.virtual_size)
}

/// Resolves a backing file name like QEMU: relative names are relative to
/// the directory of the image naming them.
pub fn resolve_backing(image: &Path, name: &str) -> PathBuf {
    let p = Path::new(name);
    if p.is_absolute() { p.to_path_buf() } else { image.parent().unwrap_or(Path::new(".")).join(p) }
}

/// The backing chain below a qcow2 image (resolved paths and formats, the
/// image itself excluded; the last entry is the bottom layer).
pub fn backing_chain(path: &Path) -> Result<Vec<(PathBuf, Format)>> {
    let file = File::open(path).map_err(|e| Error::from(e).at(path))?;
    let img = Image::open_header_only(file).map_err(|e| e.at(path))?;
    let (layers, paths) = chain::open_chain(path, &img.header)?;
    Ok(paths.into_iter().zip(layers.iter().map(|l| l.format())).collect())
}

/// The backing file of a qcow2 image, resolved against its directory.
pub fn backing_path(path: &Path) -> Result<Option<PathBuf>> {
    let info = image_info(path, Format::Qcow2)?;
    Ok(info.backing_file.map(|b| resolve_backing(path, &b)))
}

/// The bytes of a new, empty qcow2 image (what [`create_overlay`] writes;
/// in-memory images for tests and fuzzing).
pub fn new_image(size: u64, backing: Option<(&str, Format)>) -> Result<Vec<u8>> {
    image::create_bytes(size, backing.map(|(n, f)| (n, f.name())))
}

/// Opens an image and its backing chain read-only: `[image, backing, ...]`
/// (read the guest view with [`read_at`]).
pub fn open_layers(path: &Path, format: Format) -> Result<Vec<Layer<File>>> {
    let file = File::open(path).map_err(|e| Error::from(e).at(path))?;
    match format {
        Format::Raw => Ok(vec![Layer::Raw(file)]),
        Format::Qcow2 => {
            let img = Image::open(file).map_err(|e| e.at(path))?;
            let (rest, _) = chain::open_chain(path, &img.header)?;
            let mut layers = vec![Layer::Qcow2(img)];
            layers.extend(rest);
            Ok(layers)
        }
    }
}

/// Creates (replacing any existing file) an empty qcow2 v3 overlay on
/// `backing` (stored as given, resolved like QEMU for its size). The virtual
/// size defaults to the backing file's, rounded up to 512 bytes.
pub fn create_overlay(
    path: &Path,
    backing: &str,
    backing_format: Format,
    size: Option<u64>,
) -> Result<()> {
    let size = match size {
        Some(s) => s,
        None => {
            let resolved = resolve_backing(path, backing);
            virtual_size(&resolved, backing_format)?
        }
    };
    let bytes = image::create_bytes(size, Some((backing, backing_format.name())))
        .map_err(|e| e.at(path))?;
    let _ = std::fs::remove_file(path);
    let mut f = File::options()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| Error::from(e).at(path))?;
    f.write_all_at(&bytes, 0)?;
    f.sync()?;
    Ok(())
}

fn open_rw(path: &Path) -> Result<File> {
    File::options().read(true).write(true).open(path).map_err(|e| Error::from(e).at(path))
}

/// Sets the backing file (or removes it) in place without touching data
/// (`qemu-img rebase -u`). Only cluster 0 is rewritten.
pub fn set_backing(path: &Path, backing: Option<(&str, Format)>) -> Result<()> {
    let f = open_rw(path)?;
    let mut img = Image::open_header_only(f).map_err(|e| e.at(path))?;
    img.set_backing(backing.map(|(n, f)| (n, f.name()))).map_err(|e| e.at(path))?;
    img.sync()?;
    Ok(())
}

/// Grows an image to `size` bytes (raw: `set_len`; qcow2: a multiple of
/// 512). Shrinking is refused.
pub fn resize(path: &Path, format: Format, size: u64) -> Result<()> {
    let mut f = open_rw(path)?;
    match format {
        Format::Raw => {
            if size < f.len()? {
                return Err(Error::unsupported("shrinking images is not supported").at(path));
            }
            f.set_len(size)?;
            f.sync()?;
            Ok(())
        }
        Format::Qcow2 => {
            let mut img = Image::open_rw(f).map_err(|e| e.at(path))?;
            img.grow(size).map_err(|e| e.at(path))?;
            img.sync()?;
            Ok(())
        }
    }
}

/// Grows an image to at least `size` bytes (qcow2 sizes rounded up to 512).
pub fn ensure_min_size(path: &Path, format: Format, size: u64) -> Result<()> {
    if size == 0 {
        return Err(Error::invalid("invalid disk resize target: 0"));
    }
    if virtual_size(path, format)? >= size {
        return Ok(());
    }
    let size = match format {
        Format::Raw => size,
        Format::Qcow2 => size
            .checked_next_multiple_of(512)
            .ok_or_else(|| Error::invalid(format!("invalid disk resize target: {size}")))?,
    };
    resize(path, format, size)
}

/// Copies everything the backing chain of the qcow2 image `path` provides
/// into it and removes the backing file: a standalone image (`qemu-img
/// rebase -b ""`).
pub fn flatten(path: &Path) -> Result<()> {
    let f = open_rw(path)?;
    let mut top = Image::open_rw(f).map_err(|e| e.at(path))?;
    let (mut layers, _) = chain::open_chain(path, &top.header)?;
    let index = layers.len();
    rebase_layers(&mut top, &mut layers, index).map_err(|e| e.at(path))?;
    top.sync()?;
    top.set_backing(None).map_err(|e| e.at(path))?;
    top.sync()?;
    Ok(())
}

/// Safe rebase of the qcow2 image `path` onto `new_backing`, which must be
/// part of its backing chain: guest clusters whose visible content would
/// change are copied into `path` first (backing files are only read), then
/// the backing file name is set to `new_backing` (stored as given; relative
/// names are relative to the image's directory, like QEMU's).
pub fn rebase(path: &Path, new_backing: &Path, format: Format) -> Result<()> {
    let name =
        new_backing.to_str().ok_or_else(|| Error::unsupported("backing file name is not UTF-8"))?;
    let f = open_rw(path)?;
    let mut top = Image::open_rw(f).map_err(|e| e.at(path))?;
    let (mut layers, paths) = chain::open_chain(path, &top.header)?;
    let resolved = resolve_backing(path, name);
    let wanted = std::fs::canonicalize(&resolved).map_err(|e| Error::from(e).at(&resolved))?;
    let index = paths.iter().position(|p| *p == wanted).ok_or_else(|| {
        Error::unsupported(format!(
            "{} is not in the backing chain of {}",
            new_backing.display(),
            path.display()
        ))
    })?;
    if layers[index].format() != format {
        return Err(Error::invalid(format!(
            "{} is {} in the backing chain, not {}",
            new_backing.display(),
            layers[index].format().name(),
            format.name()
        )));
    }
    rebase_layers(&mut top, &mut layers, index).map_err(|e| e.at(path))?;
    top.sync()?;
    top.set_backing(Some((name, format.name()))).map_err(|e| e.at(path))?;
    top.sync()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(backing: Option<(&str, &str)>) -> Header {
        let bytes = new_image(1 << 20, None).unwrap();
        let mut h = Header::parse(&bytes[..65536]).unwrap();
        h.set_backing(backing);
        h
    }

    #[test]
    fn protocol_prefixes() {
        assert!(has_protocol_prefix("json:{\"driver\":\"file\"}"));
        assert!(has_protocol_prefix("nbd:localhost:10809"));
        assert!(has_protocol_prefix("file:rootfs.ext4"));
        assert!(!has_protocol_prefix("/img/a:b.qcow2"));
        assert!(!has_protocol_prefix("dir/a:b"));
        assert!(!has_protocol_prefix("rootfs.ext4"));
    }

    #[test]
    fn attachable_headers() {
        assert!(check_attachable(&header(None)).is_ok());
        assert!(check_attachable(&header(Some(("/img/rootfs.ext4", "raw")))).is_ok());
        assert!(check_attachable(&header(Some(("base.qcow2", "qcow2")))).is_ok());
        for (backing, want) in [
            (("/img/rootfs.ext4", "vvfat"), "backing format"),
            (("/img/rootfs.ext4", "file"), "backing format"),
            (("json:{}", "raw"), "not a file path"),
        ] {
            let err = check_attachable(&header(Some(backing))).unwrap_err();
            assert!(err.message.contains(want), "{err}");
        }
        let mut h = header(Some(("/img/rootfs.ext4", "raw")));
        h.extensions.clear();
        assert!(check_attachable(&h).unwrap_err().message.contains("without a backing format"));
        let edits: [fn(&mut Header); 6] = [
            |h| h.incompatible_features |= header::INCOMPAT_DATA_FILE,
            |h| {
                h.extensions
                    .push(header::Extension { kind: header::EXT_DATA_FILE, data: b"/etc".to_vec() })
            },
            |h| h.incompatible_features |= 1 << 40,
            |h| h.incompatible_features |= header::INCOMPAT_EXTL2,
            |h| h.incompatible_features |= header::INCOMPAT_CORRUPT,
            |h| h.crypt_method = 1,
        ];
        for edit in edits {
            let mut h = header(None);
            edit(&mut h);
            assert!(check_attachable_features(&h).is_err(), "{h:?}");
        }
        // dirty images and zstd compression are fine for a VMM
        let mut h = header(None);
        h.incompatible_features |= header::INCOMPAT_DIRTY | header::INCOMPAT_COMPRESSION;
        assert!(check_attachable(&h).is_ok());
    }

    #[test]
    fn chains() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("base.raw");
        std::fs::write(&raw, [0u8; 512]).unwrap();
        let a = dir.path().join("a.qcow2");
        create_overlay(&a, "base.raw", Format::Raw, None).unwrap();
        let b = dir.path().join("b.qcow2");
        create_overlay(&b, a.to_str().unwrap(), Format::Qcow2, None).unwrap();
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap();
        assert_eq!(
            validate_chain(&b, Format::Qcow2).unwrap(),
            vec![(canon(&a), Format::Qcow2), (canon(&raw), Format::Raw)]
        );
        assert_eq!(validate_chain(&raw, Format::Raw).unwrap(), vec![]);
        // loops and missing files
        set_backing(&a, Some((b.to_str().unwrap(), Format::Qcow2))).unwrap();
        assert!(validate_chain(&b, Format::Qcow2).unwrap_err().message.contains("loop"));
        set_backing(&a, Some(("missing.raw", Format::Raw))).unwrap();
        assert!(validate_chain(&b, Format::Qcow2).is_err());
        assert!(validate_chain(dir.path(), Format::Raw).unwrap_err().message.contains("regular"));
    }
}
