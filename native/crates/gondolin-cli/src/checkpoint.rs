//! Disk checkpoints in the node engine's format (`host/src/checkpoint.ts`):
//! a qcow2 overlay with a JSON trailer
//! `[utf8 json][b"GONDCPT1"][u64be json length]`.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use gondolin_wire::{FromValue, ToValue};

const MAGIC: &[u8; 8] = b"GONDCPT1";
const TRAILER_SIZE: u64 = 16;

gondolin_wire::wire_struct! {
    /// `VmCheckpointData`
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct CheckpointData {
        pub version: u32,
        pub name: String,
        pub created_at: String as "createdAt",
        pub disk_file: String as "diskFile",
        pub guest_asset_build_id: String as "guestAssetBuildId",
        pub snapshot_kind: Option<String> as "snapshotKind",
        pub created_with_vmm: Option<String> as "createdWithVmm",
        pub compatible_vmm: Option<Vec<String>> as "compatibleVmm",
    }
}

impl CheckpointData {
    /// `resolveCheckpointCompatibleVmm`
    pub fn compatible_vmm(&self) -> Vec<String> {
        let norm = |v: &str| v.trim().to_lowercase();
        let mut qemu = false;
        let mut krun = false;
        for v in self.compatible_vmm.iter().flatten() {
            match norm(v).as_str() {
                "qemu" => qemu = true,
                "krun" => krun = true,
                _ => {}
            }
        }
        if !qemu && !krun {
            match self.created_with_vmm.as_deref().map(norm).as_deref() {
                Some("qemu") => qemu = true,
                Some("krun") => krun = true,
                _ => {}
            }
        }
        if !qemu && !krun {
            qemu = true;
        }
        let mut out = Vec::new();
        if qemu {
            out.push("qemu".into());
        }
        if krun {
            out.push("krun".into());
        }
        out
    }
}

/// `new Date().toISOString()`
pub fn iso_now() -> String {
    let now =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    iso_from_millis(now.as_millis() as i64)
}

/// ISO 8601 UTC with milliseconds for a unix time in `ms`.
pub fn iso_from_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

/// Parses `toISOString` output to unix `ms`.
pub fn parse_iso_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let millis = if b.get(19) == Some(&b'.') { num(20..23).unwrap_or(0) } else { 0 };
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400) + hh * 3600 + mm * 60 + ss) * 1000 + millis)
}

/// Appends the trailer (`writeCheckpointTrailer`).
pub fn write_trailer(path: &Path, data: &CheckpointData) -> Result<(), String> {
    let mut json = gondolin_wire::json::to_string_pretty(&data.to_value());
    json.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|e| format!("cannot write checkpoint {}: {e}", path.display()))?;
    let mut buf = json.into_bytes();
    let len = buf.len() as u64;
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&len.to_be_bytes());
    f.write_all(&buf).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| format!("cannot sync checkpoint {}: {e}", path.display()))
}

/// Best-effort fsync of a directory (a rename in it is durable then).
pub fn sync_dir(dir: &Path) {
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

/// Reads the trailer (`readCheckpointTrailer`).
pub fn read_trailer(path: &Path) -> Result<CheckpointData, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let none = || format!("checkpoint file has no trailer: {}", path.display());
    if size < TRAILER_SIZE {
        return Err(none());
    }
    let mut footer = [0u8; 16];
    f.seek(SeekFrom::Start(size - TRAILER_SIZE)).map_err(|e| e.to_string())?;
    f.read_exact(&mut footer).map_err(|e| e.to_string())?;
    if &footer[..8] != MAGIC {
        return Err(none());
    }
    let len = u64::from_be_bytes(footer[8..].try_into().unwrap());
    if len > size - TRAILER_SIZE {
        return Err(format!("invalid checkpoint trailer length: {len}"));
    }
    let mut json = vec![0u8; len as usize];
    f.seek(SeekFrom::Start(size - TRAILER_SIZE - len)).map_err(|e| e.to_string())?;
    f.read_exact(&mut json).map_err(|e| e.to_string())?;
    let data = gondolin_wire::json::parse(&String::from_utf8_lossy(&json))
        .map_err(|e| e.to_string())
        .and_then(|v| CheckpointData::from_value(&v).map_err(|e| e.to_string()))
        .map_err(|e| format!("invalid checkpoint metadata in {}: {e}", path.display()))?;
    if data.version != 1 {
        return Err(format!("unsupported checkpoint version: {}", data.version));
    }
    Ok(data)
}

/// `checkpointBaseDir`: `GONDOLIN_CHECKPOINT_DIR`, else the cache.
pub fn base_dir() -> PathBuf {
    std::env::var_os("GONDOLIN_CHECKPOINT_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| gondolin_assets::store::gondolin_cache_dir().join("checkpoints"))
}

/// `sanitizeCheckpointName`
pub fn sanitize_name(name: &str) -> String {
    let mut out = String::new();
    let mut in_bad = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            in_bad = false;
        } else if !in_bad {
            out.push('-');
            in_bad = true;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "snapshot".into() } else { out }
}

/// `resolveSnapshotPath`
pub fn snapshot_path(output: Option<&str>, name: Option<&str>) -> Result<PathBuf, String> {
    if let Some(o) = output {
        return std::path::absolute(o).map_err(|e| e.to_string());
    }
    let stem = name.map(sanitize_name).unwrap_or_else(crate::util::uuid_v4);
    std::path::absolute(base_dir().join(format!("{stem}.qcow2"))).map_err(|e| e.to_string())
}

/// `resolveResumeCheckpoint`: a path, or a snapshot id below [`base_dir`].
pub fn resolve_resume(resume: &str) -> Result<PathBuf, String> {
    let value = resume.trim();
    if value.is_empty() {
        return Err("--resume requires a non-empty checkpoint id or path".into());
    }
    let direct = std::path::absolute(value).map_err(|e| e.to_string())?;
    if direct.exists() {
        return Ok(direct);
    }
    if value.contains('/') || value.contains('\\') {
        return Err(format!("checkpoint not found: {value}"));
    }
    let dir = base_dir();
    let normalized = value.strip_suffix(".qcow2").unwrap_or(value);
    let mut matches: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|_| format!("checkpoint not found: {value}"))?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".qcow2"))
        .filter(|n| n[..n.len() - 6].starts_with(normalized))
        .collect();
    matches.sort();
    match matches.len() {
        0 => Err(format!("checkpoint not found: {value}")),
        1 => Ok(dir.join(&matches[0])),
        n => Err(format!(
            "ambiguous checkpoint id '{value}' matches {n} snapshots:\n{}",
            matches
                .iter()
                .map(|f| format!("  {}", &f[..f.len() - 6]))
                .collect::<Vec<_>>()
                .join("\n")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailer_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.qcow2");
        std::fs::write(&p, b"QFI\xfbdisk").unwrap();
        let data = CheckpointData {
            version: 1,
            name: "x".into(),
            created_at: iso_now(),
            disk_file: "x.qcow2".into(),
            guest_asset_build_id: "3cd7a864-f023-5a35-9db1-39a1be5bdcca".into(),
            snapshot_kind: Some("disk".into()),
            created_with_vmm: Some("qemu".into()),
            compatible_vmm: Some(vec!["qemu".into()]),
        };
        write_trailer(&p, &data).unwrap();
        assert_eq!(read_trailer(&p).unwrap(), data);
        let raw = std::fs::read(&p).unwrap();
        assert!(
            std::str::from_utf8(&raw[8..raw.len() - 16]).unwrap().contains("\"guestAssetBuildId\"")
        );
        assert_eq!(data.compatible_vmm(), vec!["qemu"]);
    }

    #[test]
    fn iso_dates() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_709_251_200_123), "2024-03-01T00:00:00.123Z");
        assert_eq!(parse_iso_millis("2024-03-01T00:00:00.123Z"), Some(1_709_251_200_123));
        assert_eq!(sanitize_name(" my snap!! "), "my-snap");
        assert_eq!(sanitize_name("!!"), "snapshot");
    }
}
