//! One qcow2 image: cluster mapping (L1/L2), refcounts and allocation.
//!
//! Writes are ordered so a process crash leaks clusters at worst: refcounts
//! are raised before a cluster is used (a new refcount block is written,
//! describing itself, before the table entry naming it), data is written
//! before the L2 entry pointing to it, a new L2 table before the L1 entry, a
//! relocated table (and its clusters' refcounts) before the header, and old
//! tables are freed last. The header switches to a relocated or grown table
//! only after an fsync, so even a machine crash during `grow` (which can run
//! on a caller's own disk) leaves the old or the new image; other
//! allocations (`write_cluster`, done on throwaway overlays) are only
//! ordered, and callers sync at the end. New clusters are appended after the
//! last cluster in use (refcount or file end); `open_rw` refuses images that
//! reference metadata or data beyond that frontier.

use std::collections::HashMap;

use crate::header::{self, Header};
use crate::{Error, Result, Storage};

/// Host offset bits of L1 and standard L2 entries
const OFFSET_MASK: u64 = 0x00ff_ffff_ffff_fe00;
/// Refcount of the cluster is exactly 1 (L1 and L2 entries)
const OFLAG_COPIED: u64 = 1 << 63;
const OFLAG_COMPRESSED: u64 = 1 << 62;
/// Reads as zeros (version 3 L2 entries)
const OFLAG_ZERO: u64 = 1;
/// Cached L2 tables before the cache is dropped
const L2_CACHE_TABLES: usize = 1024;

/// How a guest cluster is stored in one image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mapping {
    /// not allocated here: read from the backing file
    Unallocated,
    /// reads as zeros
    Zero,
    /// data at this host offset
    Data(u64),
    /// compressed (not supported for reading)
    Compressed,
}

impl Mapping {
    /// Whether this image determines the cluster's content.
    pub fn is_allocated(self) -> bool {
        self != Mapping::Unallocated
    }
}

/// Refcount state of a writable image.
struct Refcounts {
    table: Vec<u64>,
    /// where table entries are written (the header's table, or a new one
    /// being set up by `grow_refcount_table`)
    table_offset: u64,
    /// refcount blocks by host offset
    blocks: HashMap<u64, Vec<u8>>,
    /// first cluster index after everything in use
    next_free: u64,
    /// a table relocation is in progress (it must not recurse)
    growing: bool,
}

pub struct Image<S> {
    pub storage: S,
    pub header: Header,
    l1: Vec<u64>,
    l2_cache: HashMap<u64, Vec<u64>>,
    rc: Option<Refcounts>,
}

/// Reads and parses the header of a qcow2 file.
pub fn read_header<S: Storage>(s: &mut S) -> Result<Header> {
    let mut first = [0u8; header::V3_HEADER_LEN];
    s.read_zero_fill(&mut first, 0)?;
    if first[..4] != header::MAGIC {
        return Err(Error::invalid("not a qcow2 image (bad magic)"));
    }
    let bits = u32::from_be_bytes(first[20..24].try_into().unwrap());
    if !(9..=21).contains(&bits) {
        return Err(Error::invalid(format!("invalid cluster_bits {bits}")));
    }
    let len = (1u64 << bits).min(s.len()?) as usize;
    let mut buf = vec![0u8; len.max(header::V3_HEADER_LEN)];
    s.read_zero_fill(&mut buf, 0)?;
    buf.truncate(len);
    Header::parse(&buf)
}

fn check_features(h: &Header, write: bool) -> Result<()> {
    let f = h.incompatible_features;
    if f & !header::INCOMPAT_KNOWN != 0 {
        return Err(Error::unsupported(format!(
            "unsupported qcow2 incompatible features {:#x}",
            f & !header::INCOMPAT_KNOWN
        )));
    }
    if f & header::INCOMPAT_DATA_FILE != 0 {
        return Err(Error::unsupported("qcow2 external data files are not supported"));
    }
    if f & header::INCOMPAT_EXTL2 != 0 {
        return Err(Error::unsupported("qcow2 extended L2 entries are not supported"));
    }
    if h.crypt_method != 0 {
        return Err(Error::unsupported("encrypted qcow2 images are not supported"));
    }
    if write {
        if f & header::INCOMPAT_CORRUPT != 0 {
            return Err(Error::invalid("image is marked corrupt (run qemu-img check -r)"));
        }
        if f & header::INCOMPAT_DIRTY != 0 {
            return Err(Error::unsupported("image is dirty (run qemu-img check -r)"));
        }
        if h.nb_snapshots != 0 {
            return Err(Error::unsupported("images with internal snapshots cannot be modified"));
        }
    }
    Ok(())
}

impl<S: Storage> Image<S> {
    /// Opens an image for reading its data.
    pub fn open(mut storage: S) -> Result<Image<S>> {
        let header = read_header(&mut storage)?;
        check_features(&header, false)?;
        let mut raw = vec![0u8; header.l1_size as usize * 8];
        storage.read_zero_fill(&mut raw, header.l1_table_offset)?;
        let l1 = be64_table(&raw);
        Ok(Image { storage, header, l1, l2_cache: HashMap::new(), rc: None })
    }

    /// Opens an image to rewrite its header only ([`Image::set_backing`]).
    pub fn open_header_only(mut storage: S) -> Result<Image<S>> {
        let header = read_header(&mut storage)?;
        let f = header.incompatible_features;
        if f & !header::INCOMPAT_KNOWN != 0 {
            return Err(Error::unsupported(format!(
                "unsupported qcow2 incompatible features {f:#x}"
            )));
        }
        if f & header::INCOMPAT_CORRUPT != 0 {
            return Err(Error::invalid("image is marked corrupt (run qemu-img check -r)"));
        }
        Ok(Image { storage, header, l1: Vec::new(), l2_cache: HashMap::new(), rc: None })
    }

    /// Opens an image for allocating writes. Clears the autoclear feature
    /// bits (none of them is implemented, as the spec requires).
    pub fn open_rw(storage: S) -> Result<Image<S>> {
        let mut img = Image::open(storage)?;
        check_features(&img.header, true)?;
        if crate::has_checkpoint_trailer(&mut img.storage)? {
            return Err(Error::unsupported(
                "cannot allocate into a checkpoint file (it ends in a checkpoint trailer)",
            ));
        }
        let cs = img.cluster_size();
        let mut raw = vec![0u8; img.header.refcount_table_clusters as usize * cs as usize];
        img.storage.read_zero_fill(&mut raw, img.header.refcount_table_offset)?;
        let table: Vec<u64> = be64_table(&raw);
        let mut rc = Refcounts {
            table,
            table_offset: img.header.refcount_table_offset,
            blocks: HashMap::new(),
            next_free: 0,
            growing: false,
        };
        let per_block = img.refcounts_per_block();
        let file_len = img.storage.len()?;
        let mut seen = std::collections::HashSet::new();
        let mut last_used = None;
        for (i, &entry) in rc.table.iter().enumerate() {
            if entry == 0 {
                continue;
            }
            img.check_offset(entry, "refcount block")?;
            if entry >= file_len || !seen.insert(entry) {
                return Err(Error::invalid(format!("invalid refcount block offset {entry:#x}")));
            }
            let block = load_block(&mut img.storage, &mut rc.blocks, entry, cs)?;
            for j in (0..per_block).rev() {
                if get_entry(block, j, img.header.refcount_order) != 0 {
                    last_used = Some(i as u64 * per_block + j);
                    break;
                }
            }
        }
        let used = last_used.map_or(0, |c| c + 1);
        rc.next_free = used.max(img.storage.len()?.div_ceil(cs)).max(1);
        let frontier = rc.next_free * cs;
        img.rc = Some(rc);
        img.check_below(frontier)?;
        if img.header.autoclear_features != 0 {
            img.header.autoclear_features = 0;
            img.write_header()?;
        }
        Ok(img)
    }

    pub fn cluster_size(&self) -> u64 {
        self.header.cluster_size()
    }

    /// Refuses images whose tables, L2 tables or data clusters lie at or
    /// beyond `frontier` (where new clusters are allocated): they would be
    /// overwritten by the first allocation.
    fn check_below(&mut self, frontier: u64) -> Result<()> {
        let cs = self.cluster_size();
        let beyond = |what: &str, off: u64, len: u64| {
            if off.checked_add(len).is_none_or(|end| end > frontier) {
                Err(Error::invalid(format!(
                    "{what} at {off:#x} lies beyond the clusters in use (corrupt image)"
                )))
            } else {
                Ok(())
            }
        };
        if self.header.l1_size > 0 {
            beyond("L1 table", self.header.l1_table_offset, u64::from(self.header.l1_size) * 8)?;
        }
        let rc_len = u64::from(self.header.refcount_table_clusters) * cs;
        beyond("refcount table", self.header.refcount_table_offset, rc_len)?;
        let n = self.l2_entries();
        for i in 0..self.l1.len() as u64 {
            let l2 = self.l2_offset(i)?;
            if l2 == 0 {
                continue;
            }
            beyond("L2 table", l2, cs)?;
            let table = self.l2_table(l2)?.clone();
            for (j, &entry) in table.iter().enumerate() {
                if i * n + j as u64 >= self.guest_clusters() {
                    break;
                }
                // compressed clusters are never rewritten; their offsets are not cluster aligned
                if entry & OFLAG_COMPRESSED != 0 {
                    continue;
                }
                let off = entry & OFFSET_MASK;
                if off != 0 {
                    beyond("data cluster", off, cs)?;
                }
            }
        }
        Ok(())
    }

    fn l2_entries(&self) -> u64 {
        self.cluster_size() / 8
    }

    fn refcounts_per_block(&self) -> u64 {
        (self.cluster_size() * 8) >> self.header.refcount_order
    }

    /// Guest clusters of the virtual size.
    pub fn guest_clusters(&self) -> u64 {
        self.header.size.div_ceil(self.cluster_size())
    }

    pub fn sync(&mut self) -> Result<()> {
        Ok(self.storage.sync()?)
    }

    fn check_offset(&self, off: u64, what: &str) -> Result<()> {
        if off & (self.cluster_size() - 1) != 0 || off < self.cluster_size() {
            return Err(Error::invalid(format!("invalid {what} offset {off:#x}")));
        }
        Ok(())
    }

    fn l2_table(&mut self, offset: u64) -> Result<&mut Vec<u64>> {
        if !self.l2_cache.contains_key(&offset) {
            if self.l2_cache.len() >= L2_CACHE_TABLES {
                self.l2_cache.clear();
            }
            let mut raw = vec![0u8; self.cluster_size() as usize];
            self.storage.read_zero_fill(&mut raw, offset)?;
            let table = be64_table(&raw);
            self.l2_cache.insert(offset, table);
        }
        Ok(self.l2_cache.get_mut(&offset).unwrap())
    }

    /// The L2 table offset of an L1 index (0: none).
    fn l2_offset(&self, l1_index: u64) -> Result<u64> {
        let Some(&entry) = self.l1.get(l1_index as usize) else { return Ok(0) };
        let off = entry & OFFSET_MASK;
        if off != 0 {
            self.check_offset(off, "L2 table")?;
        }
        Ok(off)
    }

    /// How guest cluster `index` is stored.
    pub fn map(&mut self, index: u64) -> Result<Mapping> {
        let n = self.l2_entries();
        let l2 = self.l2_offset(index / n)?;
        if l2 == 0 {
            return Ok(Mapping::Unallocated);
        }
        let entry = self.l2_table(l2)?[(index % n) as usize];
        self.decode_l2(entry)
    }

    fn decode_l2(&self, entry: u64) -> Result<Mapping> {
        if entry & OFLAG_COMPRESSED != 0 {
            return Ok(Mapping::Compressed);
        }
        if self.header.version >= 3 && entry & OFLAG_ZERO != 0 {
            return Ok(Mapping::Zero);
        }
        let off = entry & OFFSET_MASK;
        if off == 0 {
            return Ok(Mapping::Unallocated);
        }
        self.check_offset(off, "data cluster")?;
        Ok(Mapping::Data(off))
    }

    /// Calls `f(guest_cluster, mapping)` for every allocated guest cluster
    /// (ascending).
    pub fn for_each_allocated(&mut self, mut f: impl FnMut(u64, Mapping)) -> Result<()> {
        let n = self.l2_entries();
        let max = self.guest_clusters();
        for i in 0..self.l1.len() as u64 {
            if i * n >= max {
                break;
            }
            let l2 = self.l2_offset(i)?;
            if l2 == 0 {
                continue;
            }
            let table = self.l2_table(l2)?.clone();
            for (j, &entry) in table.iter().enumerate() {
                let index = i * n + j as u64;
                if index >= max {
                    break;
                }
                let m = self.decode_l2(entry)?;
                if m.is_allocated() {
                    f(index, m);
                }
            }
        }
        Ok(())
    }

    // ---- header -----------------------------------------------------------

    /// Writes the header, zeroing what is left of a longer previous one
    /// (only cluster 0 is touched).
    pub fn write_header(&mut self) -> Result<()> {
        let mut bytes = self.header.encode()?;
        let new_len = bytes.len();
        bytes.resize(new_len.max(self.header.encoded_len), 0);
        self.storage.write_all_at(&bytes, 0)?;
        self.header.encoded_len = new_len;
        Ok(())
    }

    /// Sets the backing file name and format (`None`: no backing file).
    pub fn set_backing(&mut self, backing: Option<(&str, &str)>) -> Result<()> {
        let old = self.header.clone();
        self.header.set_backing(backing);
        self.header.autoclear_features = 0;
        if let Err(e) = self.header.encode() {
            self.header = old;
            return Err(e);
        }
        self.write_header()
    }

    // ---- refcounts and allocation -----------------------------------------

    pub fn refcount(&mut self, cluster: u64) -> Result<u64> {
        let per_block = self.refcounts_per_block();
        let order = self.header.refcount_order;
        let cs = self.cluster_size();
        let rc = self.rc.as_mut().ok_or_else(|| Error::invalid("image not opened for writing"))?;
        let Some(&block) = rc.table.get((cluster / per_block) as usize) else { return Ok(0) };
        if block == 0 {
            return Ok(0);
        }
        let data = load_block(&mut self.storage, &mut rc.blocks, block, cs)?;
        Ok(get_entry(data, cluster % per_block, order))
    }

    fn set_refcount(&mut self, cluster: u64, value: u64) -> Result<()> {
        let per_block = self.refcounts_per_block();
        let order = self.header.refcount_order;
        let cs = self.cluster_size();
        let ti = (cluster / per_block) as usize;
        if ti >= self.rc.as_ref().unwrap().table.len() {
            self.grow_refcount_table(ti + 1)?;
        }
        let mut block = self.rc.as_ref().unwrap().table[ti];
        if block == 0 {
            // a new refcount block: its own refcount is in place (in the
            // block itself when it describes itself, else in its block)
            // before the table names it
            block = self.take_clusters(1) * cs;
            let own = block / cs;
            let mut data = vec![0u8; cs as usize];
            if own / per_block == ti as u64 {
                set_entry(&mut data, own % per_block, order, 1)?;
            } else {
                self.set_refcount(own, 1)?;
                if self.rc.as_ref().unwrap().table[ti] != 0 {
                    return Err(Error::invalid("refcount block allocated twice"));
                }
            }
            self.storage.write_all_at(&data, block)?;
            let rc = self.rc.as_mut().unwrap();
            rc.blocks.insert(block, data);
            rc.table[ti] = block;
            let at = rc.table_offset + ti as u64 * 8;
            self.storage.write_all_at(&block.to_be_bytes(), at)?;
        }
        let rc = self.rc.as_mut().unwrap();
        let data = load_block(&mut self.storage, &mut rc.blocks, block, cs)?;
        let (byte, bytes) = set_entry(data, cluster % per_block, order, value)?;
        let chunk = data[byte..byte + bytes].to_vec();
        self.storage.write_all_at(&chunk, block + byte as u64)?;
        Ok(())
    }

    /// Reserves `n` clusters at the end (refcounts not set yet).
    fn take_clusters(&mut self, n: u64) -> u64 {
        let rc = self.rc.as_mut().unwrap();
        let start = rc.next_free;
        rc.next_free += n;
        start
    }

    /// Allocates `n` contiguous clusters with refcount 1; returns the host offset.
    fn alloc(&mut self, n: u64) -> Result<u64> {
        let start = self.take_clusters(n);
        for c in start..start + n {
            self.set_refcount(c, 1)?;
        }
        Ok(start * self.cluster_size())
    }

    /// Moves the refcount table to a larger one at the end of the file.
    /// The new table covers everything up to its own clusters and the
    /// refcount blocks they need, so setting those refcounts never grows the
    /// table again (that would recurse and switch tables twice).
    fn grow_refcount_table(&mut self, min_entries: usize) -> Result<()> {
        let cs = self.cluster_size();
        let per_block = self.refcounts_per_block();
        let rc = self.rc.as_mut().unwrap();
        if rc.growing {
            return Err(Error::invalid("refcount table relocation would recurse"));
        }
        let old_len = rc.table.len() as u64;
        let next_free = rc.next_free;
        let mut entries = (min_entries as u64).max(old_len * 2) + 1;
        let clusters = loop {
            let clusters = (entries * 8).div_ceil(cs);
            if clusters * cs > header::MAX_REFTABLE_BYTES {
                return Err(Error::unsupported("refcount table would become too large"));
            }
            // the table's clusters, then at most one new block per
            // `per_block` of them (plus partial ones at both ends)
            let blocks = clusters.div_ceil(per_block) + 2;
            let needed = (next_free + clusters + blocks).div_ceil(per_block) + 1;
            if needed <= entries {
                break clusters;
            }
            entries = needed;
        };
        rc.growing = true;
        let res = self.relocate_refcount_table(clusters);
        self.rc.as_mut().unwrap().growing = false;
        res
    }

    fn relocate_refcount_table(&mut self, clusters: u64) -> Result<()> {
        let cs = self.cluster_size();
        let start = self.take_clusters(clusters);
        let mut table = self.rc.as_ref().unwrap().table.clone();
        table.resize((clusters * cs / 8) as usize, 0);
        let raw: Vec<u8> = table.iter().flat_map(|e| e.to_be_bytes()).collect();
        self.storage.write_all_at(&raw, start * cs)?;
        // from here on entries go to the new table, which is complete
        // (refcounts of its own clusters included) before the header names it
        let rc = self.rc.as_mut().unwrap();
        rc.table = table;
        rc.table_offset = start * cs;
        for c in start..start + clusters {
            self.set_refcount(c, 1)?;
        }
        self.storage.sync()?;
        let old_offset = self.header.refcount_table_offset;
        let old_clusters = u64::from(self.header.refcount_table_clusters);
        self.header.refcount_table_offset = start * cs;
        self.header.refcount_table_clusters = clusters as u32;
        self.write_header()?;
        for c in 0..old_clusters {
            self.set_refcount(old_offset / cs + c, 0)?;
        }
        Ok(())
    }

    // ---- writes -------------------------------------------------------------

    /// Stores guest cluster `index`: `Some(data)` (a full cluster) as a new
    /// data cluster, `None` as a zero cluster (version 3; zeros are written
    /// as data on version 2). The cluster must be unallocated.
    pub fn write_cluster(&mut self, index: u64, data: Option<&[u8]>) -> Result<()> {
        let cs = self.cluster_size();
        let n = self.l2_entries();
        let l1_index = index / n;
        if l1_index >= self.l1.len() as u64 || index >= self.guest_clusters() {
            return Err(Error::invalid(format!("guest cluster {index} out of range")));
        }
        let mut l2 = self.l2_offset(l1_index)?;
        if l2 == 0 {
            l2 = self.alloc(1)?;
            self.storage.write_all_at(&vec![0u8; cs as usize], l2)?;
            self.l2_cache.insert(l2, vec![0; n as usize]);
            let entry = l2 | OFLAG_COPIED;
            self.l1[l1_index as usize] = entry;
            let at = self.header.l1_table_offset + l1_index * 8;
            self.storage.write_all_at(&entry.to_be_bytes(), at)?;
        } else if self.l1[l1_index as usize] & OFLAG_COPIED == 0 && self.refcount(l2 / cs)? != 1 {
            return Err(Error::unsupported("shared L2 tables (snapshots) cannot be modified"));
        }
        let slot = (index % n) as usize;
        if self.l2_table(l2)?[slot] != 0 {
            return Err(Error::invalid(format!("guest cluster {index} is already allocated")));
        }
        let zeros;
        let data = match data {
            None if self.header.version >= 3 => None,
            None => {
                zeros = vec![0u8; cs as usize];
                Some(&zeros[..])
            }
            Some(d) => Some(d),
        };
        let entry = match data {
            None => OFLAG_ZERO,
            Some(d) => {
                if d.len() as u64 != cs {
                    return Err(Error::invalid("partial cluster write"));
                }
                let off = self.alloc(1)?;
                self.storage.write_all_at(d, off)?;
                off | OFLAG_COPIED
            }
        };
        self.l2_table(l2)?[slot] = entry;
        self.storage.write_all_at(&entry.to_be_bytes(), l2 + slot as u64 * 8)?;
        Ok(())
    }

    /// Grows the virtual size to `size` (a multiple of 512); the L1 table
    /// grows in place when its clusters have room, else it is relocated.
    pub fn grow(&mut self, size: u64) -> Result<()> {
        if self.rc.is_none() {
            return Err(Error::invalid("image not opened for writing"));
        }
        if size < self.header.size {
            return Err(Error::unsupported(format!(
                "shrinking images is not supported ({} -> {size} bytes)",
                self.header.size
            )));
        }
        if !size.is_multiple_of(512) {
            return Err(Error::invalid("the new size must be a multiple of 512"));
        }
        if size == self.header.size {
            return Ok(());
        }
        if size > i64::MAX as u64 {
            return Err(Error::invalid(format!("invalid size {size}")));
        }
        let cs = self.cluster_size();
        let needed = size.div_ceil(cs * self.l2_entries());
        if needed * 8 > header::MAX_L1_BYTES {
            return Err(Error::unsupported(format!("virtual size {size} is too large")));
        }
        let old_entries = u64::from(self.header.l1_size);
        if needed > old_entries {
            let old_clusters = (old_entries * 8).div_ceil(cs);
            if needed * 8 <= old_clusters * cs {
                // room in the L1 table's clusters
                let zeros = vec![0u8; ((needed - old_entries) * 8) as usize];
                self.storage.write_all_at(&zeros, self.header.l1_table_offset + old_entries * 8)?;
                self.storage.sync()?;
            } else {
                let clusters = (needed * 8).div_ceil(cs);
                let off = self.alloc(clusters)?;
                let mut raw: Vec<u8> = self.l1.iter().flat_map(|e| e.to_be_bytes()).collect();
                raw.resize((clusters * cs) as usize, 0);
                self.storage.write_all_at(&raw, off)?;
                self.storage.sync()?;
                let old_offset = self.header.l1_table_offset;
                self.header.l1_table_offset = off;
                self.header.l1_size = needed as u32;
                self.header.size = size;
                self.write_header()?;
                for c in 0..old_clusters {
                    self.set_refcount(old_offset / cs + c, 0)?;
                }
            }
            self.l1.resize(needed as usize, 0);
            self.header.l1_size = needed as u32;
        }
        self.header.size = size;
        self.write_header()
    }
}

/// Decodes a table of big-endian `u64` entries.
fn be64_table(raw: &[u8]) -> Vec<u64> {
    raw.as_chunks::<8>().0.iter().map(|c| u64::from_be_bytes(*c)).collect()
}

fn load_block<'a, S: Storage>(
    s: &mut S,
    blocks: &'a mut HashMap<u64, Vec<u8>>,
    offset: u64,
    cs: u64,
) -> Result<&'a mut Vec<u8>> {
    if let std::collections::hash_map::Entry::Vacant(e) = blocks.entry(offset) {
        let mut raw = vec![0u8; cs as usize];
        s.read_zero_fill(&mut raw, offset)?;
        e.insert(raw);
    }
    Ok(blocks.get_mut(&offset).unwrap())
}

/// Refcount entry `i` of a block (`order`: log2 of the width in bits;
/// sub-byte entries are packed starting at the least significant bits).
fn get_entry(block: &[u8], i: u64, order: u32) -> u64 {
    let bits = 1u64 << order;
    if bits < 8 {
        let per_byte = 8 / bits;
        let byte = block[(i / per_byte) as usize];
        let shift = (i % per_byte) * bits;
        u64::from(byte >> shift) & ((1 << bits) - 1)
    } else {
        let w = (bits / 8) as usize;
        let at = i as usize * w;
        block[at..at + w].iter().fold(0u64, |acc, &b| (acc << 8) | u64::from(b))
    }
}

/// Sets refcount entry `i`; returns the changed byte range.
fn set_entry(block: &mut [u8], i: u64, order: u32, value: u64) -> Result<(usize, usize)> {
    let bits = 1u64 << order;
    if bits < 64 && value >> bits != 0 {
        return Err(Error::unsupported("refcount overflow"));
    }
    if bits < 8 {
        let per_byte = 8 / bits;
        let at = (i / per_byte) as usize;
        let shift = (i % per_byte) * bits;
        let mask = (((1u64 << bits) - 1) << shift) as u8;
        block[at] = (block[at] & !mask) | ((value << shift) as u8 & mask);
        Ok((at, 1))
    } else {
        let w = (bits / 8) as usize;
        let at = i as usize * w;
        block[at..at + w].copy_from_slice(&value.to_be_bytes()[8 - w..]);
        Ok((at, w))
    }
}

/// The bytes of a new, empty image: header, refcount table, one refcount
/// block, L1 table (64 KiB clusters, version 3, 16-bit refcounts). The
/// size is rounded up to 512 bytes.
pub fn create_bytes(size: u64, backing: Option<(&str, &str)>) -> Result<Vec<u8>> {
    create_layout(size, backing, crate::DEFAULT_CLUSTER_BITS, 4)
}

/// [`create_bytes`] with another cluster size and refcount width (tests).
fn create_layout(
    size: u64,
    backing: Option<(&str, &str)>,
    bits: u32,
    refcount_order: u32,
) -> Result<Vec<u8>> {
    let cs = 1u64 << bits;
    let size = size
        .checked_next_multiple_of(512)
        .filter(|&s| s <= i64::MAX as u64)
        .ok_or_else(|| Error::invalid(format!("invalid size {size}")))?;
    let l1_size = size.div_ceil(cs * (cs / 8));
    if l1_size * 8 > header::MAX_L1_BYTES {
        return Err(Error::unsupported(format!("virtual size {size} is too large")));
    }
    let l1_clusters = (l1_size * 8).div_ceil(cs);
    let total = 3 + l1_clusters;
    let per_block = (cs * 8) >> refcount_order;
    if total > per_block {
        return Err(Error::unsupported(format!("virtual size {size} is too large")));
    }
    let mut h = Header {
        version: 3,
        cluster_bits: bits,
        size,
        crypt_method: 0,
        l1_size: l1_size as u32,
        // like QEMU: no L1 table for an empty disk
        l1_table_offset: if l1_size == 0 { 0 } else { 3 * cs },
        refcount_table_offset: cs,
        refcount_table_clusters: 1,
        nb_snapshots: 0,
        snapshots_offset: 0,
        incompatible_features: 0,
        compatible_features: 0,
        autoclear_features: 0,
        refcount_order,
        header_length: header::V3_HEADER_LEN_WRITE,
        tail: vec![0; (header::V3_HEADER_LEN_WRITE as usize) - header::V3_HEADER_LEN],
        extensions: Vec::new(),
        backing_file: None,
        encoded_len: 0,
    };
    h.set_backing(backing);
    let encoded = h.encode()?;
    let mut out = vec![0u8; (total * cs) as usize];
    out[..encoded.len()].copy_from_slice(&encoded);
    // refcount table -> block at cluster 2
    out[cs as usize..cs as usize + 8].copy_from_slice(&(2 * cs).to_be_bytes());
    let block = &mut out[2 * cs as usize..3 * cs as usize];
    for c in 0..total {
        set_entry(block, c, refcount_order, 1)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Storage that logs every write, to replay prefixes (crashes).
    struct Recording<S> {
        data: S,
        log: Vec<(u64, Vec<u8>)>,
    }

    impl<S: Storage> Storage for Recording<S> {
        fn read_at(&mut self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
            self.data.read_at(buf, offset)
        }
        fn write_all_at(&mut self, buf: &[u8], offset: u64) -> std::io::Result<()> {
            self.log.push((offset, buf.to_vec()));
            self.data.write_all_at(buf, offset)
        }
        fn len(&mut self) -> std::io::Result<u64> {
            self.data.len()
        }
        fn set_len(&mut self, len: u64) -> std::io::Result<()> {
            self.data.set_len(len)
        }
    }

    /// Sparse in-memory storage (4 KiB pages) with an arbitrary length.
    #[derive(Clone, Default)]
    struct Sparse {
        len: u64,
        pages: HashMap<u64, Vec<u8>>,
    }

    impl Storage for Sparse {
        fn read_at(&mut self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
            if offset >= self.len {
                return Ok(0);
            }
            let n = buf.len().min((self.len - offset) as usize);
            let mut done = 0;
            while done < n {
                let at = offset + done as u64;
                let (page, within) = (at / 4096, (at % 4096) as usize);
                let k = (4096 - within).min(n - done);
                match self.pages.get(&page) {
                    Some(p) => buf[done..done + k].copy_from_slice(&p[within..within + k]),
                    None => buf[done..done + k].fill(0),
                }
                done += k;
            }
            Ok(n)
        }
        fn write_all_at(&mut self, buf: &[u8], offset: u64) -> std::io::Result<()> {
            let mut done = 0;
            while done < buf.len() {
                let at = offset + done as u64;
                let (page, within) = (at / 4096, (at % 4096) as usize);
                let k = (4096 - within).min(buf.len() - done);
                let p = self.pages.entry(page).or_insert_with(|| vec![0; 4096]);
                p[within..within + k].copy_from_slice(&buf[done..done + k]);
                done += k;
            }
            self.len = self.len.max(offset + buf.len() as u64);
            Ok(())
        }
        fn len(&mut self) -> std::io::Result<u64> {
            Ok(self.len)
        }
        fn set_len(&mut self, len: u64) -> std::io::Result<()> {
            self.len = len;
            Ok(())
        }
    }

    /// Every cluster the image references (header, tables, refcount
    /// blocks, L2 tables, data) has a refcount: a crash may leak clusters,
    /// never leave one referenced but free.
    fn assert_consistent<S: Storage>(storage: S, at: usize) {
        let mut img = Image::open_rw(storage).unwrap_or_else(|e| panic!("write {at}: {e}"));
        let cs = img.cluster_size();
        let mut used = vec![0u64];
        let rc_off = img.header.refcount_table_offset / cs;
        used.extend(rc_off..rc_off + u64::from(img.header.refcount_table_clusters));
        used.extend(img.rc.as_ref().unwrap().table.iter().filter(|&&b| b != 0).map(|b| b / cs));
        let l1_off = img.header.l1_table_offset / cs;
        used.extend(l1_off..l1_off + (u64::from(img.header.l1_size) * 8).div_ceil(cs));
        for i in 0..img.l1.len() as u64 {
            let l2 = img.l2_offset(i).unwrap();
            if l2 != 0 {
                used.push(l2 / cs);
            }
        }
        let mut data = Vec::new();
        img.for_each_allocated(|_, m| {
            if let Mapping::Data(off) = m {
                data.push(off / cs);
            }
        })
        .unwrap();
        used.extend(data);
        for c in used {
            assert!(img.refcount(c).unwrap() >= 1, "write {at}: cluster {c} referenced but free");
        }
    }

    #[test]
    fn crash_consistent_allocation() {
        // 512-byte clusters, 64-bit refcounts: a refcount block covers 64
        // clusters and the first table 4096, so new blocks (self-describing
        // and not) and a table relocation both happen
        let bytes = create_layout(4 << 20, None, 9, 6).unwrap();
        let start = bytes.clone();
        let mut img = Image::open_rw(Recording { data: bytes, log: Vec::new() }).unwrap();
        for c in 0..img.guest_clusters().min(5200) {
            if c % 7 == 3 {
                img.write_cluster(c, None).unwrap();
            } else {
                img.write_cluster(c, Some(&[c as u8; 512])).unwrap();
            }
        }
        img.grow(64 << 20).unwrap();
        assert_ne!(img.header.refcount_table_offset, 512, "table relocated");
        let log = std::mem::take(&mut img.storage.log);
        // replay every prefix that ends in a metadata write (data payloads
        // land in clusters that are already refcounted)
        let mut state = start;
        let mut checked = 0;
        for (i, (off, buf)) in log.iter().enumerate() {
            let end = *off as usize + buf.len();
            if end > state.len() {
                state.resize(end, 0);
            }
            state[*off as usize..end].copy_from_slice(buf);
            let payload = buf.len() == 512 && buf.iter().any(|&b| b != 0);
            if !payload || i + 1 == log.len() {
                assert_consistent(state.clone(), i);
                checked += 1;
            }
        }
        assert!(checked > 5000);
    }

    #[test]
    fn grow_past_a_sparse_tail() {
        // 512-byte clusters, 64-bit refcounts; the file ends at 8 GiB, so
        // allocation starts at cluster 2^24 and the table must cover it and
        // its own clusters in one relocation
        let bytes = create_layout(1 << 20, None, 9, 6).unwrap();
        let mut sparse = Sparse::default();
        sparse.write_all_at(&bytes, 0).unwrap();
        let mut img = Image::open_rw(sparse).unwrap();
        img.write_cluster(0, Some(&[0x5a; 512])).unwrap();
        img.storage.set_len(8 << 30).unwrap();
        let start = img.storage.clone();
        let mut img = Image::open_rw(Recording { data: img.storage, log: Vec::new() }).unwrap();
        img.grow(64 << 20).unwrap();
        img.write_cluster(100_000, Some(&[0x6b; 512])).unwrap();
        let table = u64::from(img.header.refcount_table_clusters);
        assert!(table > 1, "table relocated");
        // every prefix of the writes (crashes) is consistent
        let mut state = start;
        for (i, (off, buf)) in img.storage.log.iter().enumerate() {
            state.write_all_at(buf, *off).unwrap();
            if buf.len() <= 512 || i + 1 == img.storage.log.len() {
                assert_consistent(state.clone(), i);
            }
        }
        let mut img = Image::open(img.storage.data).unwrap();
        assert!(matches!(img.map(0).unwrap(), Mapping::Data(_)));
        assert!(matches!(img.map(100_000).unwrap(), Mapping::Data(_)));
    }

    #[test]
    fn refuses_references_beyond_the_frontier() {
        let bytes = create_bytes(1 << 20, None).unwrap();
        let mut img = Image::open_rw(bytes).unwrap();
        img.write_cluster(0, Some(&vec![1u8; 65536])).unwrap();
        let mut bytes = img.storage;
        let frontier = bytes.len() as u64;
        // L1 entry 0 -> an L2 table past the end
        let l1 = 3 * 65536;
        bytes[l1..l1 + 8].copy_from_slice(&((frontier + 65536) | OFLAG_COPIED).to_be_bytes());
        assert!(Image::open_rw(bytes.clone()).err().unwrap().to_string().contains("beyond"));
        assert!(Image::open(bytes).is_ok(), "reading is fine");
    }

    #[test]
    fn empty_images_have_no_l1_table() {
        let bytes = create_bytes(0, None).unwrap();
        assert_eq!(bytes.len(), 3 * 65536);
        let mut img = Image::open_rw(bytes).unwrap();
        assert_eq!(img.header.l1_table_offset, 0);
        img.grow(1 << 20).unwrap();
        img.write_cluster(1, Some(&vec![2u8; 65536])).unwrap();
        assert_consistent(img.storage, 0);
    }

    #[test]
    fn refcount_entries() {
        for order in 0..=6 {
            let mut block = vec![0u8; 512];
            let max = if order == 6 { u64::MAX } else { (1u64 << (1 << order)) - 1 };
            for i in 0..16 {
                set_entry(&mut block, i, order, if i % 3 == 0 { max } else { 1 }).unwrap();
            }
            set_entry(&mut block, 5, order, 0).unwrap();
            for i in 0..16 {
                let want = if i == 5 {
                    0
                } else if i % 3 == 0 {
                    max
                } else {
                    1
                };
                assert_eq!(get_entry(&block, i, order), want, "order {order} entry {i}");
            }
            if order < 6 {
                assert!(set_entry(&mut block, 0, order, max + 1).is_err());
            }
        }
    }

    #[test]
    fn create_and_write() {
        let bytes = create_bytes(3 << 20, None).unwrap();
        let mut img = Image::open_rw(bytes).unwrap();
        assert_eq!(img.guest_clusters(), 48);
        assert_eq!(img.map(0).unwrap(), Mapping::Unallocated);
        img.write_cluster(1, Some(&vec![7u8; 65536])).unwrap();
        img.write_cluster(2, None).unwrap();
        assert!(img.write_cluster(2, None).is_err());
        assert!(img.write_cluster(48, None).is_err());
        let Mapping::Data(off) = img.map(1).unwrap() else { panic!() };
        assert_eq!(img.map(2).unwrap(), Mapping::Zero);
        assert_eq!(img.refcount(off / 65536).unwrap(), 1);
        // reopen: same mapping, allocation continues after the last cluster
        let mut img = Image::open_rw(img.storage).unwrap();
        assert_eq!(img.map(1).unwrap(), Mapping::Data(off));
        img.write_cluster(3, Some(&vec![1u8; 65536])).unwrap();
        let Mapping::Data(off3) = img.map(3).unwrap() else { panic!() };
        assert_eq!(off3, off + 65536);
    }

    #[test]
    fn grow_relocates_l1() {
        let bytes = create_bytes(1 << 20, None).unwrap();
        let mut img = Image::open_rw(bytes).unwrap();
        img.write_cluster(0, Some(&vec![9u8; 65536])).unwrap();
        // 8192 entries fit into the one L1 cluster: 4 TiB grows in place
        img.grow(4 << 40).unwrap();
        assert_eq!(img.header.l1_table_offset, 3 * 65536);
        img.grow((4 << 40) + (512 << 20)).unwrap();
        assert_ne!(img.header.l1_table_offset, 3 * 65536);
        assert_eq!(img.refcount(3).unwrap(), 0);
        assert!(img.grow(1 << 20).is_err());
        let mut img = Image::open(img.storage).unwrap();
        assert_eq!(img.header.size, (4 << 40) + (512 << 20));
        assert!(matches!(img.map(0).unwrap(), Mapping::Data(_)));
    }

    #[test]
    fn refuses_trailer_and_snapshots() {
        let mut bytes = create_bytes(1 << 20, None).unwrap();
        bytes.extend_from_slice(b"{}\nGONDCPT1");
        bytes.extend_from_slice(&3u64.to_be_bytes());
        assert!(Image::open_rw(bytes.clone()).err().unwrap().to_string().contains("trailer"));
        let mut img = Image::open_header_only(bytes).unwrap();
        img.set_backing(Some(("/a/b", "raw"))).unwrap();
        assert!(crate::has_checkpoint_trailer(&mut img.storage).unwrap());

        let mut bytes = create_bytes(1 << 20, None).unwrap();
        bytes[60..64].copy_from_slice(&1u32.to_be_bytes());
        assert!(Image::open_rw(bytes).err().unwrap().to_string().contains("snapshots"));
    }
}
