//! tar reader + extraction of image archives: arbitrary bytes never panic,
//! and extraction never creates anything outside the destination (the
//! destination's parent stays untouched, symlinks stay inside).
#![no_main]

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use gondolin_assets::archive::tar::{self, Archive, Limits};
use libfuzzer_sys::fuzz_target;

const LIMITS: Limits = Limits {
    max_entries: 64,
    max_file_bytes: 1 << 20,
    max_total_bytes: 4 << 20,
    max_meta_bytes: 64 << 10,
};

static N: AtomicU64 = AtomicU64::new(0);

fn check_inside(root: &Path, dir: &Path) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).unwrap();
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&path).unwrap();
            assert!(target.is_relative(), "{path:?} -> {target:?}");
            let mut depth = path.parent().unwrap().strip_prefix(root).unwrap().components().count();
            for c in target.components() {
                match c {
                    std::path::Component::ParentDir => {
                        depth = depth.checked_sub(1).expect("symlink escapes");
                    }
                    std::path::Component::Normal(_) => depth += 1,
                    _ => {}
                }
            }
        } else if meta.is_dir() {
            check_inside(root, &path);
        } else {
            assert!(meta.is_file(), "{path:?} is not a regular file");
        }
    }
}

fuzz_target!(|data: &[u8]| {
    let mut archive = Archive::new(data, LIMITS);
    let mut buf = [0u8; 4096];
    while let Ok(Some(_)) = archive.next_entry() {
        while let Ok(n) = archive.read_content(&mut buf) {
            if n == 0 {
                break;
            }
        }
    }

    let base = std::env::temp_dir().join(format!(
        "gondolin-fuzz-tar-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let dest = base.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let _ = tar::extract(data, &dest, LIMITS);
    let siblings: Vec<_> =
        std::fs::read_dir(&base).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(siblings, vec![std::ffi::OsString::from("dest")], "wrote outside dest");
    check_inside(&dest, &dest);
    std::fs::remove_dir_all(&base).unwrap();
});
