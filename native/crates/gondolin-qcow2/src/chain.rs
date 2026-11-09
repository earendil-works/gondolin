//! Backing chains: reading through them and the safe rebase.

use std::collections::BTreeSet;
use std::fs::File;
use std::path::{Path, PathBuf};

use crate::header::Header;
use crate::image::{Image, Mapping};
use crate::{Error, Format, MAX_CHAIN_DEPTH, Result, Storage};

/// One image of a backing chain (opened read-only).
#[allow(clippy::large_enum_variant)]
pub enum Layer<S> {
    Qcow2(Image<S>),
    Raw(S),
}

impl<S: Storage> Layer<S> {
    pub fn format(&self) -> Format {
        match self {
            Layer::Qcow2(_) => Format::Qcow2,
            Layer::Raw(_) => Format::Raw,
        }
    }

    /// Virtual size in `bytes`.
    pub fn size(&mut self) -> Result<u64> {
        match self {
            Layer::Qcow2(img) => Ok(img.header.size),
            Layer::Raw(s) => Ok(s.len()?),
        }
    }
}

/// Reads guest bytes at `offset` as the first layer of `layers` exposes
/// them (unallocated clusters come from the following layers, everything
/// past a layer's virtual size reads as zeros).
pub fn read_at<S: Storage>(layers: &mut [Layer<S>], offset: u64, buf: &mut [u8]) -> Result<()> {
    let Some((first, rest)) = layers.split_first_mut() else {
        buf.fill(0);
        return Ok(());
    };
    let img = match first {
        Layer::Raw(s) => return Ok(s.read_zero_fill(buf, offset)?),
        Layer::Qcow2(img) => img,
    };
    let cs = img.cluster_size();
    let size = img.header.size;
    let mut done = 0usize;
    while done < buf.len() {
        let pos = offset + done as u64;
        let end = buf.len().min(done + (cs - pos % cs) as usize);
        let part = &mut buf[done..end];
        done = end;
        if pos >= size {
            part.fill(0);
            continue;
        }
        let inside = part.len().min((size - pos) as usize);
        let (part, beyond) = part.split_at_mut(inside);
        beyond.fill(0);
        match img.map(pos / cs)? {
            Mapping::Unallocated => read_at(rest, pos, part)?,
            Mapping::Zero => part.fill(0),
            Mapping::Data(host) => img.storage.read_zero_fill(part, host + pos % cs)?,
            Mapping::Compressed => {
                return Err(Error::unsupported("compressed clusters are not supported"));
            }
        }
    }
    Ok(())
}

/// Copies into `top` every guest cluster whose content changes when its
/// backing chain `layers` (`layers[0]` is top's backing file) is replaced
/// by `layers[index..]`. Candidates are the clusters the dropped layers
/// allocate and the range one of them cuts off by being smaller than the
/// new backing file; a candidate is copied when the old and new chains
/// differ there (as a zero cluster when it reads as zeros). The caller
/// then points top's backing file at `layers[index]`; `index ==
/// layers.len()` flattens the whole chain into top (no backing file).
pub fn rebase_layers<S: Storage, T: Storage>(
    top: &mut Image<S>,
    layers: &mut [Layer<T>],
    index: usize,
) -> Result<()> {
    if index > layers.len() {
        return Err(Error::invalid("new backing file is not in the chain"));
    }
    let cs = top.cluster_size();
    let top_size = top.header.size;
    let mut candidates = BTreeSet::new();
    let mut bound = top_size;
    for layer in layers[..index].iter_mut() {
        let Layer::Qcow2(img) = layer else {
            return Err(Error::invalid("raw image in the middle of a backing chain"));
        };
        bound = bound.min(img.header.size);
        let mcs = img.cluster_size();
        let limit = bound;
        img.for_each_allocated(|i, _| {
            let start = i * mcs;
            if start < limit {
                let end = (start + mcs).min(limit);
                candidates.extend(start / cs..end.div_ceil(cs));
            }
        })?;
    }
    let new_size = match layers.get_mut(index) {
        Some(layer) => layer.size()?.min(top_size),
        None => 0,
    };
    let cut = if bound < new_size { bound / cs..new_size.div_ceil(cs) } else { 0..0 };

    let mut old = vec![0u8; cs as usize];
    let mut new = vec![0u8; cs as usize];
    for c in candidates.into_iter().chain(cut) {
        if top.map(c)?.is_allocated() {
            continue;
        }
        let start = c * cs;
        let len = cs.min(top_size - start) as usize;
        old.fill(0);
        new.fill(0);
        read_at(layers, start, &mut old[..len])?;
        read_at(&mut layers[index..], start, &mut new[..len])?;
        if old == new {
            continue;
        }
        if old.iter().all(|&b| b == 0) {
            top.write_cluster(c, None)?;
        } else {
            top.write_cluster(c, Some(&old))?;
        }
    }
    Ok(())
}

/// Opens the backing chain below an image (read-only); returns the layers
/// and their canonical paths.
pub fn open_chain(path: &Path, header: &Header) -> Result<(Vec<Layer<File>>, Vec<PathBuf>)> {
    let mut layers = Vec::new();
    let mut paths: Vec<PathBuf> = Vec::new();
    let top = std::fs::canonicalize(path).map_err(|e| Error::from(e).at(path))?;
    let mut name = header.backing_file.clone();
    let mut format = header.backing_format();
    let mut current = path.to_path_buf();
    while let Some(backing) = name.take() {
        if layers.len() >= MAX_CHAIN_DEPTH {
            return Err(Error::unsupported("backing chain too long").at(path));
        }
        let p = crate::resolve_backing(&current, &backing);
        let canon = std::fs::canonicalize(&p).map_err(|e| Error::from(e).at(&p)).map_err(|e| {
            Error { message: format!("cannot open backing file {}", e.message), ..e }
        })?;
        if canon == top || paths.contains(&canon) {
            return Err(Error::invalid(format!("backing chain loop at {}", p.display())));
        }
        let fmt = match format.take() {
            Some(f) => Format::parse(&f).map_err(|e| e.at(&current))?,
            None => crate::probe(&canon)?,
        };
        let file = File::open(&canon).map_err(|e| Error::from(e).at(&canon))?;
        match fmt {
            Format::Raw => layers.push(Layer::Raw(file)),
            Format::Qcow2 => {
                let img = Image::open(file).map_err(|e| e.at(&canon))?;
                name = img.header.backing_file.clone();
                format = img.header.backing_format();
                layers.push(Layer::Qcow2(img));
            }
        }
        paths.push(canon);
        current = p;
    }
    Ok((layers, paths))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::create_bytes;

    const CS: usize = 65536;

    fn qcow(size: u64) -> Image<Vec<u8>> {
        Image::open_rw(create_bytes(size, Some(("x", "qcow2"))).unwrap()).unwrap()
    }

    fn read_all(layers: &mut [Layer<Vec<u8>>], size: usize) -> Vec<u8> {
        let mut out = vec![0u8; size];
        read_at(layers, 0, &mut out).unwrap();
        out
    }

    #[test]
    fn flatten_three_levels() {
        let size = 8 * CS as u64;
        let base: Vec<u8> = (0..size as usize).map(|i| (i / CS) as u8 + 1).collect();
        // mid: cluster 1 data, cluster 2 zero, cluster 3 same as base
        let mut mid = qcow(size);
        mid.write_cluster(1, Some(&vec![0xaa; CS])).unwrap();
        mid.write_cluster(2, None).unwrap();
        mid.write_cluster(3, Some(&vec![4u8; CS])).unwrap();
        // upper: cluster 1 overwritten again, cluster 5 data
        let mut upper = qcow(size);
        upper.write_cluster(5, Some(&vec![0x55; CS])).unwrap();
        upper.write_cluster(6, None).unwrap();
        // top: owns cluster 5
        let mut top = qcow(size);
        top.write_cluster(5, Some(&vec![0x11; CS])).unwrap();

        let mut layers = vec![Layer::Qcow2(upper), Layer::Qcow2(mid), Layer::Raw(base.clone())];
        let mut expected = read_all(&mut layers, size as usize);
        expected[5 * CS..6 * CS].fill(0x11);
        rebase_layers(&mut top, &mut layers, 2).unwrap();
        assert_eq!(top.map(0).unwrap(), Mapping::Unallocated);
        assert!(matches!(top.map(1).unwrap(), Mapping::Data(_)));
        assert_eq!(top.map(2).unwrap(), Mapping::Zero);
        assert_eq!(top.map(3).unwrap(), Mapping::Unallocated, "same as base: not copied");
        assert_eq!(top.map(6).unwrap(), Mapping::Zero);
        let mut flat = vec![Layer::Qcow2(top), Layer::Raw(base)];
        assert_eq!(read_all(&mut flat, size as usize), expected);
    }

    #[test]
    fn smaller_middle_layer_cuts_off_the_base() {
        let size = 4 * CS as u64;
        let base = vec![0x77u8; size as usize];
        let mut top = qcow(size);
        let mut layers = vec![Layer::Qcow2(qcow(2 * CS as u64)), Layer::Raw(base.clone())];
        rebase_layers(&mut top, &mut layers, 1).unwrap();
        assert_eq!(top.map(1).unwrap(), Mapping::Unallocated);
        assert_eq!(top.map(2).unwrap(), Mapping::Zero);
        assert_eq!(top.map(3).unwrap(), Mapping::Zero);
        let mut flat = vec![Layer::Qcow2(top), Layer::Raw(base)];
        let got = read_all(&mut flat, size as usize);
        assert!(got[..2 * CS].iter().all(|&b| b == 0x77));
        assert!(got[2 * CS..].iter().all(|&b| b == 0));
    }
}
