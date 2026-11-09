//! The qcow2 header (cluster 0): fixed fields, header extensions and the
//! backing file name (qcow2 spec, `docs/interop/qcow2.txt` in QEMU).
//!
//! Layout we write (what `qcow2_update_header` writes): the fixed header,
//! the extensions (8-byte aligned), the end marker, then the backing file
//! name. Everything has to fit into the first cluster.

use crate::{Error, Result};

pub const MAGIC: [u8; 4] = *b"QFI\xfb";

/// Size of the version 2 header in `bytes`
pub const V2_HEADER_LEN: usize = 72;
/// Size of the fixed version 3 header without optional fields in `bytes`
pub const V3_HEADER_LEN: usize = 104;
/// Header length we write for new images (`compression_type` + padding, like QEMU 5.1+)
pub const V3_HEADER_LEN_WRITE: u32 = 112;

pub const EXT_END: u32 = 0;
pub const EXT_BACKING_FORMAT: u32 = 0xe279_2aca;
/// External data file name (only meaningful with `INCOMPAT_DATA_FILE`)
pub const EXT_DATA_FILE: u32 = 0x4441_5441;
pub const EXT_FEATURE_TABLE: u32 = 0x6803_f857;
pub const EXT_BITMAPS: u32 = 0x2385_2875;
pub const EXT_CRYPTO: u32 = 0x0537_be77;
/// Extensions the spec defines (at most one of each; QEMU takes the last
/// of a repeated one, imago refuses, so readers could disagree)
pub const KNOWN_EXTENSIONS: [u32; 5] =
    [EXT_BACKING_FORMAT, EXT_DATA_FILE, EXT_FEATURE_TABLE, EXT_BITMAPS, EXT_CRYPTO];

/// Bits of `incompatible_features`
pub const INCOMPAT_DIRTY: u64 = 1 << 0;
pub const INCOMPAT_CORRUPT: u64 = 1 << 1;
pub const INCOMPAT_DATA_FILE: u64 = 1 << 2;
pub const INCOMPAT_COMPRESSION: u64 = 1 << 3;
pub const INCOMPAT_EXTL2: u64 = 1 << 4;
pub const INCOMPAT_KNOWN: u64 = 0x1f;

/// Longest backing file name QEMU accepts in `bytes`
pub const MAX_BACKING_NAME: usize = 1023;
/// QEMU's limit for the L1 table in `bytes` (`QCOW_MAX_L1_SIZE`)
pub const MAX_L1_BYTES: u64 = 32 << 20;
/// QEMU's limit for the refcount table in `bytes` (`QCOW_MAX_REFTABLE_SIZE`)
pub const MAX_REFTABLE_BYTES: u64 = 8 << 20;

/// One header extension other than the end marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extension {
    pub kind: u32,
    /// payload without padding
    pub data: Vec<u8>,
}

/// A parsed qcow2 header. Unknown extensions and unknown trailing header
/// fields are kept and written back unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    /// 2 or 3
    pub version: u32,
    pub cluster_bits: u32,
    /// virtual disk size in `bytes`
    pub size: u64,
    /// 0 none, 1 AES, 2 LUKS
    pub crypt_method: u32,
    /// L1 entries
    pub l1_size: u32,
    pub l1_table_offset: u64,
    pub refcount_table_offset: u64,
    pub refcount_table_clusters: u32,
    pub nb_snapshots: u32,
    pub snapshots_offset: u64,
    pub incompatible_features: u64,
    pub compatible_features: u64,
    pub autoclear_features: u64,
    /// log2 of the refcount width in bits (4 = 16-bit refcounts)
    pub refcount_order: u32,
    /// `header_length` (72 for version 2)
    pub header_length: u32,
    /// header bytes from offset 104 to `header_length` (`compression_type`, padding, future fields)
    pub tail: Vec<u8>,
    /// extensions in file order, without the end marker
    pub extensions: Vec<Extension>,
    /// backing file name as stored (may be relative to the image's directory)
    pub backing_file: Option<String>,
    /// end of the header data in cluster 0 (extensions, end marker, backing name) in `bytes`
    pub encoded_len: usize,
}

fn be32(b: &[u8], off: usize) -> u32 {
    u32::from_be_bytes(b[off..off + 4].try_into().unwrap())
}

fn be64(b: &[u8], off: usize) -> u64 {
    u64::from_be_bytes(b[off..off + 8].try_into().unwrap())
}

fn pad8(n: usize) -> usize {
    n.div_ceil(8) * 8
}

impl Header {
    pub fn cluster_size(&self) -> u64 {
        1 << self.cluster_bits
    }

    /// Backing format from the backing format extension, if present.
    pub fn backing_format(&self) -> Option<String> {
        let ext = self.extensions.iter().find(|e| e.kind == EXT_BACKING_FORMAT)?;
        let end = ext.data.iter().position(|&b| b == 0).unwrap_or(ext.data.len());
        Some(String::from_utf8_lossy(&ext.data[..end]).into_owned())
    }

    /// Sets (or removes) the backing file name and format.
    pub fn set_backing(&mut self, backing: Option<(&str, &str)>) {
        self.extensions.retain(|e| e.kind != EXT_BACKING_FORMAT);
        match backing {
            Some((name, format)) => {
                // QEMU puts the backing format extension first
                self.extensions.insert(
                    0,
                    Extension { kind: EXT_BACKING_FORMAT, data: format.as_bytes().to_vec() },
                );
                self.backing_file = Some(name.to_string());
            }
            None => self.backing_file = None,
        }
    }

    /// Parses the header from the start of the file. `buf` holds the first
    /// cluster (or the whole file when it is shorter).
    pub fn parse(buf: &[u8]) -> Result<Header> {
        if buf.len() < V2_HEADER_LEN || buf[..4] != MAGIC {
            return Err(Error::invalid("not a qcow2 image (bad magic)"));
        }
        let version = be32(buf, 4);
        if version != 2 && version != 3 {
            return Err(Error::unsupported(format!("unsupported qcow2 version {version}")));
        }
        let backing_file_offset = be64(buf, 8);
        let backing_file_size = be32(buf, 16);
        let cluster_bits = be32(buf, 20);
        if !(9..=21).contains(&cluster_bits) {
            return Err(Error::invalid(format!("invalid cluster_bits {cluster_bits}")));
        }
        let cluster_size = 1u64 << cluster_bits;
        let mut h = Header {
            version,
            cluster_bits,
            size: be64(buf, 24),
            crypt_method: be32(buf, 32),
            l1_size: be32(buf, 36),
            l1_table_offset: be64(buf, 40),
            refcount_table_offset: be64(buf, 48),
            refcount_table_clusters: be32(buf, 56),
            nb_snapshots: be32(buf, 60),
            snapshots_offset: be64(buf, 64),
            incompatible_features: 0,
            compatible_features: 0,
            autoclear_features: 0,
            refcount_order: 4,
            header_length: V2_HEADER_LEN as u32,
            tail: Vec::new(),
            extensions: Vec::new(),
            backing_file: None,
            encoded_len: 0,
        };
        if version == 3 {
            if buf.len() < V3_HEADER_LEN {
                return Err(Error::invalid("truncated qcow2 header"));
            }
            h.incompatible_features = be64(buf, 72);
            h.compatible_features = be64(buf, 80);
            h.autoclear_features = be64(buf, 88);
            h.refcount_order = be32(buf, 96);
            h.header_length = be32(buf, 100);
            let len = h.header_length as usize;
            if len < V3_HEADER_LEN
                || !len.is_multiple_of(8)
                || len as u64 > cluster_size
                || len > buf.len()
            {
                return Err(Error::invalid(format!("invalid header_length {len}")));
            }
            h.tail = buf[V3_HEADER_LEN..len].to_vec();
            if h.refcount_order > 6 {
                return Err(Error::invalid(format!("invalid refcount_order {}", h.refcount_order)));
            }
        }
        let aligned = |off: u64| off & (cluster_size - 1) == 0;
        if !aligned(h.l1_table_offset) || !aligned(h.refcount_table_offset) {
            return Err(Error::invalid("metadata table offset is not cluster aligned"));
        }
        if h.refcount_table_offset < cluster_size {
            return Err(Error::invalid("refcount table overlaps the header"));
        }
        if h.l1_size > 0 && h.l1_table_offset < cluster_size {
            return Err(Error::invalid("L1 table overlaps the header"));
        }
        if h.nb_snapshots > 0 && !aligned(h.snapshots_offset) {
            return Err(Error::invalid("snapshot table offset is not cluster aligned"));
        }
        // like QEMU's qcow2_validate_table: offset + size must not overflow
        let fits = |off: u64, len: u64| off.checked_add(len).is_some_and(|e| e <= i64::MAX as u64);
        if !fits(h.l1_table_offset, u64::from(h.l1_size) * 8) {
            return Err(Error::invalid("L1 table offset and size overflow"));
        }
        if !fits(h.refcount_table_offset, u64::from(h.refcount_table_clusters) * cluster_size) {
            return Err(Error::invalid("refcount table offset and size overflow"));
        }
        // QCOW_MAX_SNAPSHOTS; a snapshot table entry is at least 40 bytes
        if h.nb_snapshots > 65536 || !fits(h.snapshots_offset, u64::from(h.nb_snapshots) * 40) {
            return Err(Error::invalid("invalid snapshot table"));
        }
        if u64::from(h.l1_size) * 8 > MAX_L1_BYTES {
            return Err(Error::unsupported(format!("L1 table too large ({} entries)", h.l1_size)));
        }
        if u64::from(h.refcount_table_clusters) * cluster_size > MAX_REFTABLE_BYTES
            || h.refcount_table_clusters == 0
        {
            return Err(Error::invalid(format!(
                "invalid refcount table size ({} clusters)",
                h.refcount_table_clusters
            )));
        }
        // the L1 table must cover the virtual size
        let per_l1 = cluster_size * (cluster_size / 8);
        if h.size > i64::MAX as u64 || h.size.div_ceil(per_l1) > u64::from(h.l1_size) {
            return Err(Error::invalid("L1 table is too small for the virtual size"));
        }

        // extensions: up to the backing file name, else to the end of the cluster
        let limit = (cluster_size as usize).min(buf.len());
        let ext_end = if backing_file_offset != 0 {
            usize::try_from(backing_file_offset).unwrap_or(usize::MAX).min(limit)
        } else {
            limit
        };
        let mut off = h.header_length as usize;
        let mut end = off;
        while off < ext_end {
            if ext_end - off < 8 {
                return Err(Error::invalid("truncated header extension"));
            }
            let kind = be32(buf, off);
            let len = be32(buf, off + 4) as usize;
            off += 8;
            if kind == EXT_END {
                end = off;
                break;
            }
            if len > ext_end - off {
                return Err(Error::invalid("header extension too large"));
            }
            if KNOWN_EXTENSIONS.contains(&kind) && h.extensions.iter().any(|e| e.kind == kind) {
                return Err(Error::invalid(format!("repeated header extension {kind:#010x}")));
            }
            h.extensions.push(Extension { kind, data: buf[off..off + len].to_vec() });
            off = (off + pad8(len)).min(ext_end);
            end = off;
        }

        if backing_file_offset != 0 {
            let size = backing_file_size as usize;
            let start = usize::try_from(backing_file_offset)
                .ok()
                .filter(|&s| s as u64 <= cluster_size)
                .ok_or_else(|| Error::invalid("backing file name outside the header cluster"))?;
            if size > MAX_BACKING_NAME || start + size > limit {
                return Err(Error::invalid("backing file name too long"));
            }
            let name = std::str::from_utf8(&buf[start..start + size])
                .map_err(|_| Error::unsupported("backing file name is not UTF-8"))?;
            if !name.is_empty() {
                h.backing_file = Some(name.to_string());
            }
            end = end.max(start + size);
        }
        h.encoded_len = end;
        Ok(h)
    }

    /// Encodes cluster 0's header data (fixed header, extensions, end
    /// marker, backing name). Fails when it does not fit into a cluster.
    pub fn encode(&self) -> Result<Vec<u8>> {
        let fixed = if self.version == 3 { V3_HEADER_LEN + self.tail.len() } else { V2_HEADER_LEN };
        let mut out = vec![0u8; fixed];
        let put32 =
            |o: &mut Vec<u8>, at: usize, v: u32| o[at..at + 4].copy_from_slice(&v.to_be_bytes());
        out[..4].copy_from_slice(&MAGIC);
        put32(&mut out, 4, self.version);
        put32(&mut out, 20, self.cluster_bits);
        out[24..32].copy_from_slice(&self.size.to_be_bytes());
        put32(&mut out, 32, self.crypt_method);
        put32(&mut out, 36, self.l1_size);
        out[40..48].copy_from_slice(&self.l1_table_offset.to_be_bytes());
        out[48..56].copy_from_slice(&self.refcount_table_offset.to_be_bytes());
        put32(&mut out, 56, self.refcount_table_clusters);
        put32(&mut out, 60, self.nb_snapshots);
        out[64..72].copy_from_slice(&self.snapshots_offset.to_be_bytes());
        if self.version == 3 {
            out[72..80].copy_from_slice(&self.incompatible_features.to_be_bytes());
            out[80..88].copy_from_slice(&self.compatible_features.to_be_bytes());
            out[88..96].copy_from_slice(&self.autoclear_features.to_be_bytes());
            put32(&mut out, 96, self.refcount_order);
            put32(&mut out, 100, fixed as u32);
            out[V3_HEADER_LEN..].copy_from_slice(&self.tail);
        }
        out.resize(pad8(out.len()), 0);
        for ext in &self.extensions {
            out.extend_from_slice(&ext.kind.to_be_bytes());
            out.extend_from_slice(&(ext.data.len() as u32).to_be_bytes());
            out.extend_from_slice(&ext.data);
            out.resize(pad8(out.len()), 0);
        }
        out.extend_from_slice(&[0u8; 8]);
        if let Some(name) = &self.backing_file {
            if name.len() > MAX_BACKING_NAME {
                return Err(Error::unsupported(format!(
                    "backing file name too long ({} bytes, at most {MAX_BACKING_NAME})",
                    name.len()
                )));
            }
            let offset = out.len() as u64;
            out[8..16].copy_from_slice(&offset.to_be_bytes());
            out[16..20].copy_from_slice(&(name.len() as u32).to_be_bytes());
            out.extend_from_slice(name.as_bytes());
        }
        if out.len() as u64 > self.cluster_size() {
            return Err(Error::unsupported(format!(
                "header, extensions and backing file name ({} bytes) do not fit into the first cluster ({} bytes)",
                out.len(),
                self.cluster_size()
            )));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Header {
        Header {
            version: 3,
            cluster_bits: 16,
            size: 1 << 30,
            crypt_method: 0,
            l1_size: 2,
            l1_table_offset: 3 << 16,
            refcount_table_offset: 1 << 16,
            refcount_table_clusters: 1,
            nb_snapshots: 0,
            snapshots_offset: 0,
            incompatible_features: 0,
            compatible_features: 0,
            autoclear_features: 0,
            refcount_order: 4,
            header_length: V3_HEADER_LEN_WRITE,
            tail: vec![0; 8],
            extensions: vec![Extension { kind: 0x1234_5678, data: b"abc".to_vec() }],
            backing_file: None,
            encoded_len: 0,
        }
    }

    #[test]
    fn roundtrip() {
        let mut h = sample();
        h.set_backing(Some(("/img/rootfs.ext4", "raw")));
        let bytes = h.encode().unwrap();
        let mut parsed = Header::parse(&bytes).unwrap();
        assert_eq!(parsed.encoded_len, bytes.len());
        parsed.encoded_len = 0;
        assert_eq!(parsed, h);
        assert_eq!(parsed.backing_format().as_deref(), Some("raw"));
        assert_eq!(parsed.extensions[1].data, b"abc");
    }

    #[test]
    fn long_names() {
        let mut h = sample();
        h.set_backing(Some((&"x".repeat(1023), "qcow2")));
        assert!(h.encode().is_ok());
        h.set_backing(Some((&"x".repeat(1024), "qcow2")));
        assert!(h.encode().unwrap_err().to_string().contains("too long"));
        let mut small = sample();
        small.cluster_bits = 9;
        small.l1_size = 1 << 12;
        small.set_backing(Some((&"y".repeat(400), "raw")));
        assert!(small.encode().unwrap_err().to_string().contains("first cluster"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(Header::parse(b"QFI\xfb").is_err());
        let mut h = sample().encode().unwrap();
        h[20..24].copy_from_slice(&30u32.to_be_bytes());
        assert!(Header::parse(&h).is_err());
        // version 3 header lengths are multiples of 8 (extensions are aligned)
        let mut h = sample().encode().unwrap();
        h[100..104].copy_from_slice(&146u32.to_be_bytes());
        assert!(Header::parse(&h).is_err());
        // a repeated known extension (e.g. two backing formats) is ambiguous
        let mut h = sample();
        h.set_backing(Some(("/img/rootfs.ext4", "raw")));
        h.extensions.push(Extension { kind: EXT_BACKING_FORMAT, data: b"qcow2".to_vec() });
        let err = Header::parse(&h.encode().unwrap()).unwrap_err().to_string();
        assert!(err.contains("repeated header extension"), "{err}");
        let mut h = sample();
        h.extensions.push(Extension { kind: 0x1234_5678, data: b"again".to_vec() });
        assert!(Header::parse(&h.encode().unwrap()).is_ok(), "unknown ones may repeat");
        // table offset + size overflow (qcow2_validate_table)
        for (at, value) in [(40usize, !0xffff_u64), (48, (i64::MAX as u64) & !0xffff)] {
            let mut h = sample().encode().unwrap();
            h[at..at + 8].copy_from_slice(&value.to_be_bytes());
            assert!(Header::parse(&h).unwrap_err().to_string().contains("overflow"), "{at}");
        }
        let mut h = sample().encode().unwrap();
        h[60..64].copy_from_slice(&100_000u32.to_be_bytes());
        assert!(Header::parse(&h).is_err());
        let mut h = sample();
        h.l1_size = 1;
        assert!(Header::parse(&h.encode().unwrap()).unwrap_err().to_string().contains("L1"));
    }
}
