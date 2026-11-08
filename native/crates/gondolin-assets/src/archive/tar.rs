//! Minimal tar reader for image archives: POSIX ustar and GNU headers, pax
//! extended headers (`path`, `linkpath`, `size`; global headers ignored) and
//! GNU long names (`L`/`K`). Entry types: regular files, directories and
//! symlinks. Hard links, devices, FIFOs, sparse files and anything else are
//! rejected.
//!
//! [`extract`] writes entries below a directory without ever leaving it:
//! absolute paths and `..` components are rejected, no entry is written
//! through a symlink (every parent component must be a real directory, files
//! are created with `create_new`), symlink targets must be relative and stay
//! inside, and [`Limits`] bound entries, sizes and metadata.

use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

const BLOCK: usize = 512;

/// Bounds for untrusted archives.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// most entries (all kinds, including metadata headers)
    pub max_entries: u64,
    /// largest single file in `bytes`
    pub max_file_bytes: u64,
    /// most file content in total in `bytes`
    pub max_total_bytes: u64,
    /// largest pax header or GNU long name in `bytes`
    pub max_meta_bytes: u64,
}

impl Default for Limits {
    /// Generous for guest images (a few files of up to some GiB).
    fn default() -> Self {
        Limits {
            max_entries: 100_000,
            max_file_bytes: 64 << 30,
            max_total_bytes: 128 << 30,
            max_meta_bytes: 1 << 20,
        }
    }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("tar: {}", message.into()))
}

/// Kind of an archive entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
    /// symlink with its target
    Symlink(String),
}

/// One entry: its (unsanitized) path, kind, content size and mode bits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub kind: EntryKind,
    /// content size in `bytes` (0 for directories and symlinks)
    pub size: u64,
    pub mode: u32,
}

/// Parses an octal or GNU base-256 numeric header field.
fn number(field: &[u8], name: &str) -> io::Result<u64> {
    if field.first().is_some_and(|b| b & 0x80 != 0) {
        // base-256: big-endian, the high bit of the first byte is the marker
        if field[0] & 0x40 != 0 {
            return Err(invalid(format!("negative {name}")));
        }
        let mut v: u64 = (field[0] & 0x3f) as u64;
        for &b in &field[1..] {
            v = v
                .checked_mul(256)
                .and_then(|v| v.checked_add(b as u64))
                .ok_or_else(|| invalid(format!("{name} out of range")))?;
        }
        return Ok(v);
    }
    let text: &[u8] = {
        let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
        &field[..end]
    };
    let text = std::str::from_utf8(text).map_err(|_| invalid(format!("invalid {name}")))?;
    let text = text.trim_matches(' ');
    if text.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(text, 8).map_err(|_| invalid(format!("invalid {name}")))
}

fn text_field(field: &[u8]) -> &[u8] {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    &field[..end]
}

fn utf8(bytes: &[u8], what: &str) -> io::Result<String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| invalid(format!("{what} is not UTF-8")))
}

/// Applies the records of a pax extended header.
fn pax_records(data: &[u8], pax: &mut Pending) -> io::Result<()> {
    let mut rest = data;
    while !rest.is_empty() {
        let space =
            rest.iter().position(|b| *b == b' ').ok_or_else(|| invalid("malformed pax record"))?;
        let len: usize = std::str::from_utf8(&rest[..space])
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| invalid("malformed pax record length"))?;
        if len <= space + 1 || len > rest.len() || rest[len - 1] != b'\n' {
            return Err(invalid("malformed pax record"));
        }
        let record = &rest[space + 1..len - 1];
        let eq = record
            .iter()
            .position(|b| *b == b'=')
            .ok_or_else(|| invalid("malformed pax record"))?;
        let (key, value) = (&record[..eq], &record[eq + 1..]);
        match key {
            b"path" => pax.path = Some(utf8(value, "pax path")?),
            b"linkpath" => pax.link = Some(utf8(value, "pax linkpath")?),
            b"size" => {
                let v = std::str::from_utf8(value)
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok())
                    .ok_or_else(|| invalid("invalid pax size"))?;
                pax.size = Some(v);
            }
            _ => {}
        }
        rest = &rest[len..];
    }
    Ok(())
}

/// Metadata from pax/GNU headers for the next entry.
#[derive(Default)]
struct Pending {
    path: Option<String>,
    link: Option<String>,
    size: Option<u64>,
}

/// Reads entries from an uncompressed tar stream.
pub struct Archive<R> {
    inner: R,
    limits: Limits,
    /// content bytes (plus padding) of the current entry still unread
    remaining: u64,
    padding: u64,
    entries: u64,
    total: u64,
    done: bool,
}

impl<R: Read> Archive<R> {
    pub fn new(inner: R, limits: Limits) -> Archive<R> {
        Archive { inner, limits, remaining: 0, padding: 0, entries: 0, total: 0, done: false }
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        self.inner.read_exact(buf).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                io::Error::new(io::ErrorKind::UnexpectedEof, "tar: truncated archive")
            } else {
                e
            }
        })
    }

    /// Discards the rest of the current entry's content and padding.
    fn skip_rest(&mut self) -> io::Result<()> {
        let n = self.remaining + self.padding;
        self.remaining = 0;
        self.padding = 0;
        let copied = io::copy(&mut (&mut self.inner).take(n), &mut io::sink())?;
        if copied != n {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "tar: truncated archive"));
        }
        Ok(())
    }

    fn read_meta(&mut self, size: u64) -> io::Result<Vec<u8>> {
        if size > self.limits.max_meta_bytes {
            return Err(invalid("extended header too large"));
        }
        let mut data = vec![0u8; size as usize];
        self.read_exact(&mut data)?;
        let pad = (BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64;
        let mut padding = vec![0u8; pad as usize];
        self.read_exact(&mut padding)?;
        Ok(data)
    }

    /// The next entry; its content is read with [`Archive::read_content`]
    /// (unread content is skipped). `None` at the end of the archive.
    pub fn next_entry(&mut self) -> io::Result<Option<Entry>> {
        self.skip_rest()?;
        if self.done {
            return Ok(None);
        }
        let mut pending = Pending::default();
        loop {
            let mut header = [0u8; BLOCK];
            match self.inner.read(&mut header[..1]) {
                Ok(0) => {
                    // EOF without end-of-archive blocks: tolerated at a boundary
                    self.done = true;
                    if pending.path.is_some() || pending.link.is_some() || pending.size.is_some() {
                        return Err(invalid("extended header without an entry"));
                    }
                    return Ok(None);
                }
                Ok(_) => {}
                Err(e) => return Err(e),
            }
            self.read_exact(&mut header[1..])?;
            if header.iter().all(|b| *b == 0) {
                // end-of-archive marker (the second zero block is not required)
                self.done = true;
                if pending.path.is_some() || pending.link.is_some() || pending.size.is_some() {
                    return Err(invalid("extended header without an entry"));
                }
                return Ok(None);
            }
            self.entries += 1;
            if self.entries > self.limits.max_entries {
                return Err(invalid("too many entries"));
            }
            let stored = number(&header[148..156], "checksum")?;
            let unsigned: u64 = header
                .iter()
                .enumerate()
                .map(|(i, b)| if (148..156).contains(&i) { b' ' as u64 } else { *b as u64 })
                .sum();
            let signed: i64 = header
                .iter()
                .enumerate()
                .map(|(i, b)| if (148..156).contains(&i) { b' ' as i64 } else { *b as i8 as i64 })
                .sum();
            if stored != unsigned && stored as i64 != signed {
                return Err(invalid("header checksum mismatch"));
            }
            let typeflag = header[156];
            let ustar = &header[257..263] == b"ustar\0";
            let mut size = number(&header[124..136], "size")?;
            match typeflag {
                b'x' | b'g' => {
                    let data = self.read_meta(size)?;
                    if typeflag == b'x' {
                        pax_records(&data, &mut pending)?;
                    }
                    continue;
                }
                b'L' | b'K' => {
                    let data = self.read_meta(size)?;
                    let value = utf8(text_field(&data), "long name")?;
                    if typeflag == b'L' {
                        pending.path = Some(value);
                    } else {
                        pending.link = Some(value);
                    }
                    continue;
                }
                _ => {}
            }
            if let Some(s) = pending.size {
                size = s;
            }
            let path = match pending.path.take() {
                Some(p) => p,
                None => {
                    let name = text_field(&header[0..100]);
                    let prefix = if ustar { text_field(&header[345..500]) } else { &[] };
                    if prefix.is_empty() {
                        utf8(name, "path")?
                    } else {
                        format!("{}/{}", utf8(prefix, "path")?, utf8(name, "path")?)
                    }
                }
            };
            let mode = (number(&header[100..108], "mode")? & 0o7777) as u32;
            let kind = match typeflag {
                b'0' | 0 | b'7' => EntryKind::File,
                b'5' => EntryKind::Dir,
                b'2' => {
                    let link = match pending.link.take() {
                        Some(l) => l,
                        None => utf8(text_field(&header[157..257]), "link target")?,
                    };
                    EntryKind::Symlink(link)
                }
                b'1' => return Err(invalid(format!("hard links are not supported ({path})"))),
                b'3' | b'4' => {
                    return Err(invalid(format!("device files are not allowed ({path})")));
                }
                b'6' => return Err(invalid(format!("FIFOs are not allowed ({path})"))),
                other => {
                    return Err(invalid(format!(
                        "unsupported entry type {:?} ({path})",
                        other as char
                    )));
                }
            };
            let content = if kind == EntryKind::File { size } else { 0 };
            if content > self.limits.max_file_bytes {
                return Err(invalid(format!("{path} is too large")));
            }
            self.total = self.total.saturating_add(content);
            if self.total > self.limits.max_total_bytes {
                return Err(invalid("archive content too large"));
            }
            // directories and symlinks may still carry data blocks: skip them
            self.remaining = size;
            self.padding = (BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64;
            return Ok(Some(Entry { path, kind, size: content, mode }));
        }
    }

    /// Reads content of the current entry (`0` at its end).
    pub fn read_content(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let want = buf.len().min(self.remaining.min(usize::MAX as u64) as usize);
        let n = self.inner.read(&mut buf[..want])?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "tar: truncated archive"));
        }
        self.remaining -= n as u64;
        Ok(n)
    }
}

/// Normalized relative path of an entry: no absolute paths, no `..`; `.`
/// and empty components are dropped. `None` for the archive root itself.
fn safe_relative(path: &str) -> io::Result<Option<PathBuf>> {
    if path.contains('\0') {
        return Err(invalid("path contains NUL"));
    }
    if path.starts_with('/') {
        return Err(invalid(format!("absolute path {path}")));
    }
    let mut out = PathBuf::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(invalid(format!("path {path} leaves the archive"))),
            p => out.push(p),
        }
    }
    Ok(if out.as_os_str().is_empty() { None } else { Some(out) })
}

/// Creates the parents of `rel` below `dest`, refusing symlinks on the way.
fn make_parents(dest: &Path, rel: &Path) -> io::Result<()> {
    let mut current = dest.to_path_buf();
    if let Some(parent) = rel.parent() {
        for comp in parent.components() {
            let Component::Normal(name) = comp else { continue };
            current.push(name);
            match std::fs::symlink_metadata(&current) {
                Ok(m) if m.is_dir() => {}
                Ok(_) => {
                    return Err(invalid(format!(
                        "{} is not a directory (symlinks are not followed)",
                        current.display()
                    )));
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => std::fs::create_dir(&current)?,
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}

/// Removes a previous non-directory entry at `path` (later entries win).
fn replace_non_dir(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => Err(invalid(format!("{} is a directory", path.display()))),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Whether a symlink at `rel` with `target` resolves (lexically) inside the root.
fn link_stays_inside(rel: &Path, target: &str) -> bool {
    if target.is_empty() || target.starts_with('/') || target.contains('\0') {
        return false;
    }
    let mut depth: i64 = rel.parent().map(|p| p.components().count() as i64).unwrap_or(0);
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => depth += 1,
        }
    }
    true
}

/// Summary of an extraction.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub files: u64,
    pub dirs: u64,
    pub symlinks: u64,
    pub bytes: u64,
}

/// Extracts a tar stream below `dest` (which must exist). Permissions are
/// normalized (0644/0755 for files, 0755 for directories), ownership, times
/// and extended attributes are not restored.
pub fn extract<R: Read>(reader: R, dest: &Path, limits: Limits) -> io::Result<Stats> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut archive = Archive::new(reader, limits);
    let mut stats = Stats::default();
    let mut buf = vec![0u8; 256 * 1024];
    while let Some(entry) = archive.next_entry()? {
        let Some(rel) = safe_relative(&entry.path)? else { continue };
        make_parents(dest, &rel)?;
        let path = dest.join(&rel);
        match &entry.kind {
            EntryKind::Dir => {
                match std::fs::symlink_metadata(&path) {
                    Ok(m) if m.is_dir() => {}
                    Ok(_) => {
                        return Err(invalid(format!(
                            "{} exists and is not a directory",
                            rel.display()
                        )));
                    }
                    Err(e) if e.kind() == io::ErrorKind::NotFound => std::fs::create_dir(&path)?,
                    Err(e) => return Err(e),
                }
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
                stats.dirs += 1;
            }
            EntryKind::Symlink(target) => {
                if !link_stays_inside(&rel, target) {
                    return Err(invalid(format!(
                        "symlink {} -> {target} points outside the archive",
                        rel.display()
                    )));
                }
                replace_non_dir(&path)?;
                std::os::unix::fs::symlink(target, &path)?;
                stats.symlinks += 1;
            }
            EntryKind::File => {
                replace_non_dir(&path)?;
                let mode = if entry.mode & 0o111 != 0 { 0o755 } else { 0o644 };
                // create_new: never writes through a symlink planted meanwhile
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(mode)
                    .open(&path)?;
                let mut written = 0u64;
                loop {
                    let n = archive.read_content(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    file.write_all(&buf[..n])?;
                    written += n as u64;
                }
                stats.files += 1;
                stats.bytes += written;
            }
        }
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a header block (ustar or GNU magic).
    fn header(name: &str, typeflag: u8, size: u64, link: &str, gnu: bool) -> [u8; BLOCK] {
        let mut h = [0u8; BLOCK];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..108].copy_from_slice(b"0000644\0");
        h[108..116].copy_from_slice(b"0000000\0");
        h[116..124].copy_from_slice(b"0000000\0");
        h[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
        h[136..148].copy_from_slice(b"00000000000\0");
        h[156] = typeflag;
        h[157..157 + link.len()].copy_from_slice(link.as_bytes());
        if gnu {
            h[257..265].copy_from_slice(b"ustar  \0");
        } else {
            h[257..263].copy_from_slice(b"ustar\0");
            h[263..265].copy_from_slice(b"00");
        }
        h[148..156].copy_from_slice(b"        ");
        let sum: u64 = h.iter().map(|b| *b as u64).sum();
        h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        h
    }

    fn padded(data: &[u8]) -> Vec<u8> {
        let mut v = data.to_vec();
        v.resize(data.len().div_ceil(BLOCK) * BLOCK, 0);
        v
    }

    fn file(name: &str, data: &[u8]) -> Vec<u8> {
        let mut v = header(name, b'0', data.len() as u64, "", false).to_vec();
        v.extend(padded(data));
        v
    }

    fn end() -> Vec<u8> {
        vec![0u8; 2 * BLOCK]
    }

    fn pax(records: &[(&str, &str)]) -> Vec<u8> {
        let mut body = Vec::new();
        for (k, v) in records {
            let base = k.len() + v.len() + 3;
            let mut len = base + base.to_string().len();
            if len.to_string().len() != base.to_string().len() {
                len += 1;
            }
            body.extend(format!("{len} {k}={v}\n").as_bytes());
        }
        let mut v = header("PaxHeaders/x", b'x', body.len() as u64, "", false).to_vec();
        v.extend(padded(&body));
        v
    }

    fn extract_bytes(bytes: &[u8]) -> (tempfile::TempDir, io::Result<Stats>) {
        let dir = tempfile::tempdir().unwrap();
        let r = extract(bytes, dir.path(), Limits::default());
        (dir, r)
    }

    #[test]
    fn files_dirs_symlinks_long_names() {
        let long = format!("dir/{}", "n".repeat(150));
        let mut ar = Vec::new();
        ar.extend(header("dir/", b'5', 0, "", false));
        ar.extend(file("dir/a.txt", b"hello"));
        ar.extend(pax(&[("path", &long), ("mtime", "1.5")]));
        ar.extend(file("ignored-name", b"long via pax"));
        let gnu_long = format!("dir/{}", "g".repeat(120));
        let mut l = header("././@LongLink", b'L', gnu_long.len() as u64 + 1, "", true).to_vec();
        l.extend(padded(format!("{gnu_long}\0").as_bytes()));
        ar.extend(l);
        let mut g = header("x", b'0', 3, "", true).to_vec();
        g.extend(padded(b"gnu"));
        ar.extend(g);
        ar.extend(header("dir/link", b'2', 0, "a.txt", false));
        ar.extend(header("./", b'5', 0, "", false));
        ar.extend(end());
        let (dir, r) = extract_bytes(&ar);
        let stats = r.unwrap();
        assert_eq!(stats.files, 3);
        assert_eq!(std::fs::read(dir.path().join("dir/a.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(dir.path().join(&long)).unwrap(), b"long via pax");
        assert_eq!(std::fs::read(dir.path().join(&gnu_long)).unwrap(), b"gnu");
        assert_eq!(std::fs::read_link(dir.path().join("dir/link")).unwrap(), Path::new("a.txt"));
    }

    #[test]
    fn base256_sizes_and_missing_end_marker() {
        let mut h = header("big", b'0', 0, "", true);
        // base-256 size of 5
        h[124..136].copy_from_slice(&[0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
        h[148..156].copy_from_slice(b"        ");
        let sum: u64 = h.iter().map(|b| *b as u64).sum();
        h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        let mut ar = h.to_vec();
        ar.extend(padded(b"12345"));
        let (dir, r) = extract_bytes(&ar);
        r.unwrap();
        assert_eq!(std::fs::read(dir.path().join("big")).unwrap(), b"12345");
    }

    #[test]
    fn unsafe_archives_are_rejected() {
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("dotdot", [file("../evil", b"x"), end()].concat()),
            ("nested dotdot", [file("a/../../evil", b"x"), end()].concat()),
            ("absolute", [file("/etc/evil", b"x"), end()].concat()),
            ("abs link", [header("l", b'2', 0, "/etc/passwd", false).to_vec(), end()].concat()),
            ("escaping link", [header("a/l", b'2', 0, "../../x", false).to_vec(), end()].concat()),
            (
                "write through link",
                [header("d", b'2', 0, ".", false).to_vec(), file("d/x", b"x"), end()].concat(),
            ),
            ("hard link", [header("h", b'1', 0, "x", false).to_vec(), end()].concat()),
            ("char device", [header("c", b'3', 0, "", false).to_vec(), end()].concat()),
            ("block device", [header("b", b'4', 0, "", false).to_vec(), end()].concat()),
            ("fifo", [header("f", b'6', 0, "", false).to_vec(), end()].concat()),
            ("sparse", [header("s", b'S', 0, "", true).to_vec(), end()].concat()),
            ("truncated", file("t", b"hello")[..BLOCK + 2].to_vec()),
            ("dangling pax", [pax(&[("path", "p")]), end()].concat()),
        ];
        for (name, ar) in cases {
            let (dir, r) = extract_bytes(&ar);
            assert!(r.is_err(), "{name} should fail");
            // nothing was written outside
            assert!(!dir.path().parent().unwrap().join("evil").exists(), "{name}");
        }
        let mut bad = file("x", b"x");
        bad[0] = b'y';
        assert!(extract_bytes(&[bad, end()].concat()).1.is_err(), "checksum");
    }

    #[test]
    fn limits_are_enforced() {
        let ar = [file("a", b"0123456789"), file("b", b"0123456789"), end()].concat();
        let dir = tempfile::tempdir().unwrap();
        let small = Limits { max_file_bytes: 5, ..Limits::default() };
        assert!(extract(&ar[..], dir.path(), small).is_err());
        let dir = tempfile::tempdir().unwrap();
        let total = Limits { max_total_bytes: 15, ..Limits::default() };
        assert!(extract(&ar[..], dir.path(), total).is_err());
        let dir = tempfile::tempdir().unwrap();
        let entries = Limits { max_entries: 1, ..Limits::default() };
        assert!(extract(&ar[..], dir.path(), entries).is_err());
        let dir = tempfile::tempdir().unwrap();
        let meta = Limits { max_meta_bytes: 8, ..Limits::default() };
        let long = [pax(&[("path", "some/long/path")]), file("x", b"x"), end()].concat();
        assert!(extract(&long[..], dir.path(), meta).is_err());
    }

    #[test]
    fn later_entries_replace_files() {
        let ar = [file("x", b"one"), file("x", b"two"), end()].concat();
        let (dir, r) = extract_bytes(&ar);
        r.unwrap();
        assert_eq!(std::fs::read(dir.path().join("x")).unwrap(), b"two");
    }
}
