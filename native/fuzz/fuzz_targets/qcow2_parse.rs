//! qcow2 header, L1/L2 and refcount parsing on arbitrary images: nothing
//! panics, headers re-encode to themselves, and a safe rebase of an empty
//! overlay over the image (as a read-only middle layer) keeps the guest view
//! byte for byte. As a writable image it is grown and written to (no panic).
#![no_main]

use gondolin_qcow2::header::Header;
use gondolin_qcow2::{Format, Image, Layer, new_image, read_at, rebase_layers};
use libfuzzer_sys::fuzz_target;

/// Largest virtual size exercised beyond parsing in `bytes`
const MAX_SIZE: u64 = 4 << 20;

fuzz_target!(|data: &[u8]| {
    if let Ok(h) = Header::parse(data) {
        let _ = gondolin_qcow2::check_attachable(&h);
    }
    if let Ok(h) = Header::parse(data)
        && let Ok(bytes) = h.encode()
    {
        let mut again = Header::parse(&bytes).expect("re-encoded header parses");
        again.encoded_len = h.encoded_len;
        assert_eq!(again, h);
    }

    let Ok(mut img) = Image::open(data.to_vec()) else { return };
    let size = img.header.size;
    if size > MAX_SIZE {
        return;
    }
    for c in 0..img.guest_clusters() {
        if img.map(c).is_err() {
            return;
        }
    }

    // middle layer of base <- image <- empty overlay
    let base: Vec<u8> = (0..size as usize / 2).map(|i| (i * 31 % 251) as u8).collect();
    let mut layers = vec![Layer::Qcow2(img), Layer::Raw(base)];
    let mut top = Image::open_rw(new_image(size, Some(("mid", Format::Qcow2))).unwrap()).unwrap();
    let top_size = top.header.size as usize;
    let mut expected = vec![0u8; top_size];
    if read_at(&mut layers, 0, &mut expected).is_err() {
        return;
    }
    if rebase_layers(&mut top, &mut layers, 1).is_ok() {
        let base = layers.pop().unwrap();
        let mut flat = vec![Layer::Qcow2(top), base];
        let mut got = vec![0u8; top_size];
        read_at(&mut flat, 0, &mut got).unwrap();
        assert!(got == expected, "rebase changed the guest view");
    }

    // writable top
    let Ok(mut img) = Image::open_rw(data.to_vec()) else { return };
    let fill = vec![0xa5; img.cluster_size() as usize];
    for c in 0..img.guest_clusters().min(4) {
        if img.map(c).map(|m| m.is_allocated()).unwrap_or(true) {
            continue;
        }
        let _ = img.write_cluster(c, if c % 2 == 0 { None } else { Some(&fill[..]) });
    }
    let _ = img.grow((size * 2).next_multiple_of(512).max(512));
    if img.set_backing(Some(("backing.raw", "raw"))).is_ok() {
        let h = Header::parse(&img.storage).expect("rewritten header parses");
        assert_eq!(h.backing_file.as_deref(), Some("backing.raw"));
        assert_eq!(h.backing_format().as_deref(), Some("raw"));
    }
});
