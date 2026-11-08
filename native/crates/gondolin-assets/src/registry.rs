//! Builtin image registry (`builtin-image-registry.json`) parsing and its
//! on-disk cache `builtin-image-registry-cache.json` (port of
//! `host/src/registry.ts` and the registry parts of `host/src/images.ts`).

use std::path::Path;

use gondolin_wire::{ToValue, Value, wire_struct};

use crate::AssetsError;
use crate::image_ref::{Arch, ImageRef, normalize_build_id};

pub const DEFAULT_IMAGE_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/earendil-works/gondolin/main/builtin-image-registry.json";
pub const REGISTRY_CACHE_FILE: &str = "builtin-image-registry-cache.json";
const SCHEMA: u64 = 1;
const LABEL: &str = "builtin image registry";

wire_struct! {
    /// Downloadable image archive.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ImageSource {
        /// absolute archive URL
        pub url: String,
        /// expected archive `sha256` (lowercase hex)
        pub sha256: Option<String>,
        /// architecture of the archived image
        pub arch: Option<Arch>,
    }
}

/// Parsed registry. Maps keep the document's order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registry {
    pub schema: u64,
    /// canonical refs → arch → build id
    pub refs: indexed::Map<String, indexed::Map<Arch, String>>,
    /// build id → source
    pub builds: indexed::Map<String, ImageSource>,
}

impl ToValue for Registry {
    fn to_value(&self) -> Value {
        let mut out = Value::map();
        out.insert("schema", self.schema.to_value());
        out.insert("refs", self.refs.to_value());
        out.insert("builds", self.builds.to_value());
        out
    }
}

/// Small insertion-ordered map (a JSON object) so the cache file keeps the
/// registry's order like the node engine's `JSON.stringify`.
pub mod indexed {
    use gondolin_wire::{ToValue, Value};

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Map<K, V>(pub Vec<(K, V)>);

    impl<K, V> Default for Map<K, V> {
        fn default() -> Self {
            Map(Vec::new())
        }
    }

    impl<K: PartialEq, V> Map<K, V> {
        pub fn get(&self, key: &K) -> Option<&V> {
            self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
        }

        pub fn insert(&mut self, key: K, value: V) {
            if let Some(slot) = self.0.iter_mut().find(|(k, _)| *k == key) {
                slot.1 = value;
            } else {
                self.0.push((key, value));
            }
        }

        pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
            self.0.iter().map(|(k, v)| (k, v))
        }

        pub fn len(&self) -> usize {
            self.0.len()
        }

        pub fn is_empty(&self) -> bool {
            self.0.is_empty()
        }
    }

    /// Keys encode to text (`String`, `Arch`).
    impl<K: ToValue, V: ToValue> ToValue for Map<K, V> {
        fn to_value(&self) -> Value {
            Value::Map(self.0.iter().map(|(k, v)| (k.to_value(), v.to_value())).collect())
        }
    }
}

/// The entries of an object with text keys (non-text keys can't occur in JSON).
fn entries(value: &Value) -> impl Iterator<Item = (&String, &Value)> {
    value.as_map().into_iter().flatten().filter_map(|(k, v)| match k {
        Value::Text(k) => Some((k, v)),
        _ => None,
    })
}

/// `value` when it is an object.
fn expect_object<'a>(value: &'a Value, message: &str) -> Result<&'a Value, AssetsError> {
    value.as_map().map(|_| value).ok_or_else(|| AssetsError::invalid(message))
}

fn normalize_sha256(value: &Value, label: &str) -> Result<String, AssetsError> {
    match value.as_str() {
        Some(s) if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Ok(s.to_ascii_lowercase())
        }
        _ => Err(AssetsError::invalid(format!("invalid {label}: expected sha256 hex string"))),
    }
}

fn parse_source(
    value: &Value,
    where_: &str,
    base: &gondolin_http::url::Url,
) -> Result<ImageSource, AssetsError> {
    let rec = expect_object(value, &format!("invalid {where_}: expected object"))?;
    let url = match rec.get("url").and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => base
            .join(s)
            .map_err(|_| AssetsError::invalid(format!("invalid {where_}.url: {s}")))?
            .to_string(),
        _ => return Err(AssetsError::invalid(format!("invalid {where_}.url: expected string"))),
    };
    let sha256 = match rec.get("sha256") {
        None => None,
        Some(v) => Some(normalize_sha256(v, &format!("{where_}.sha256"))?),
    };
    let arch = match rec.get("arch") {
        None => None,
        Some(Value::Text(s)) => Some(
            Arch::normalize(s)
                .ok_or_else(|| AssetsError::invalid(format!("invalid {where_}.arch: {s}")))?,
        ),
        Some(_) => {
            return Err(AssetsError::invalid(format!("invalid {where_}.arch: expected string")));
        }
    };
    Ok(ImageSource { url, sha256, arch })
}

impl Registry {
    /// Parses and validates a registry document fetched from `source_url`
    /// (relative build URLs resolve against it).
    pub fn parse(raw: &Value, source_url: &str) -> Result<Registry, AssetsError> {
        let rec = expect_object(raw, &format!("invalid {LABEL}: expected object"))?;
        if rec.get("schema").and_then(Value::as_float) != Some(SCHEMA as f64) {
            return Err(AssetsError::invalid(format!("invalid {LABEL} schema: expected {SCHEMA}")));
        }
        let base = gondolin_http::url::Url::parse(source_url)
            .map_err(|_| AssetsError::invalid(format!("invalid registry url: {source_url}")))?;

        let raw_builds = expect_object(
            rec.get("builds").unwrap_or(&Value::Null),
            &format!("invalid {LABEL}: builds must be an object"),
        )?;
        let mut builds = indexed::Map::default();
        for (build_id, value) in entries(raw_builds) {
            let id = normalize_build_id(build_id)?;
            builds.insert(id, parse_source(value, &format!("builds['{build_id}']"), &base)?);
        }

        let raw_refs = expect_object(
            rec.get("refs").unwrap_or(&Value::Null),
            &format!("invalid {LABEL}: refs must be an object"),
        )?;
        let mut refs = indexed::Map::default();
        for (reference, arch_map) in entries(raw_refs) {
            let canonical = ImageRef::parse(reference)?.canonical();
            if &canonical != reference {
                return Err(AssetsError::invalid(format!("invalid {LABEL} ref key: {reference}")));
            }
            let entries = expect_object(
                arch_map,
                &format!("invalid registry ref '{reference}': expected object"),
            )?;
            let mut mapped = indexed::Map::default();
            for (raw_key, value) in crate::registry::entries(entries) {
                let where_ = format!("refs['{reference}']['{raw_key}']");
                let arch = Arch::normalize(raw_key).ok_or_else(|| {
                    AssetsError::invalid(format!(
                        "invalid registry ref '{reference}' arch key: {raw_key}"
                    ))
                })?;
                let Some(value) = value.as_str() else {
                    return Err(AssetsError::invalid(format!(
                        "invalid {where_}: expected build id string"
                    )));
                };
                let build_id = normalize_build_id(value)?;
                let Some(build) = builds.get(&build_id) else {
                    return Err(AssetsError::invalid(format!(
                        "invalid {where_}: unknown build id {build_id}"
                    )));
                };
                if let Some(build_arch) = build.arch
                    && build_arch != arch
                {
                    return Err(AssetsError::invalid(format!(
                        "invalid {where_}: arch {arch} does not match build arch {build_arch}"
                    )));
                }
                mapped.insert(arch, build_id);
            }
            refs.insert(canonical, mapped);
        }
        Ok(Registry { schema: SCHEMA, refs, builds })
    }

    /// Resolves a canonical ref for `arch`, falling back to the only entry
    /// when there is exactly one (`resolveKeyedRegistryRef`).
    pub fn resolve_ref(
        &self,
        canonical: &str,
        arch: Arch,
    ) -> Result<(String, Arch, &ImageSource), AssetsError> {
        let Some(entries) = self.refs.get(&canonical.to_string()) else {
            return Err(AssetsError::invalid(format!(
                "image ref not found in builtin registry: {canonical}"
            )));
        };
        let Some((key, build_id)) = select_entry(entries, arch) else {
            return Err(AssetsError::invalid(format!(
                "image ref '{canonical}' has no registry source for {arch} (available: {})",
                describe_available(entries)
            )));
        };
        let Some(build) = self.builds.get(&build_id) else {
            return Err(AssetsError::invalid(format!(
                "image ref '{canonical}' points to unknown registry build id: {build_id}"
            )));
        };
        Ok((build_id, key, build))
    }
}

/// Exact arch match, else the single available entry.
pub(crate) fn select_entry(
    entries: &indexed::Map<Arch, String>,
    arch: Arch,
) -> Option<(Arch, String)> {
    if let Some(id) = entries.get(&arch) {
        return Some((arch, id.clone()));
    }
    if entries.len() == 1 {
        let (k, v) = entries.iter().next()?;
        return Some((*k, v.clone()));
    }
    None
}

pub(crate) fn describe_available(entries: &indexed::Map<Arch, String>) -> String {
    let names: Vec<&str> = entries.iter().map(|(k, _)| k.as_str()).collect();
    if names.is_empty() { "none".into() } else { names.join(", ") }
}

/// On-disk cache entry (`{ url, etag?, registry }`).
#[derive(Debug, Clone)]
pub struct RegistryCache {
    pub url: String,
    pub etag: Option<String>,
    pub registry: Registry,
}

impl ToValue for RegistryCache {
    fn to_value(&self) -> Value {
        let mut out = Value::map();
        out.insert("url", self.url.to_value());
        if let Some(etag) = &self.etag {
            out.insert("etag", etag.to_value());
        }
        out.insert("registry", self.registry.to_value());
        out
    }
}

/// Loads the cache for `url` (ignored when for another URL or invalid).
pub fn load_cache(store: &Path, url: &str) -> Option<RegistryCache> {
    let content = std::fs::read_to_string(store.join(REGISTRY_CACHE_FILE)).ok()?;
    let raw = gondolin_wire::json::parse(&content).ok()?;
    let obj = expect_object(&raw, "").ok()?;
    if obj.get("url").and_then(Value::as_str) != Some(url) {
        return None;
    }
    let etag = obj.get("etag").and_then(Value::as_str).map(str::to_string);
    let registry = Registry::parse(obj.get("registry")?, url).ok()?;
    Some(RegistryCache { url: url.to_string(), etag, registry })
}

/// Atomically writes the cache (pretty JSON, like the node engine).
pub fn save_cache(store: &Path, cache: &RegistryCache) -> std::io::Result<()> {
    std::fs::create_dir_all(store)?;
    let path = store.join(REGISTRY_CACHE_FILE);
    let tmp = store.join(format!("{REGISTRY_CACHE_FILE}.tmp-{}", crate::store::random_suffix()));
    let json = gondolin_wire::json::to_string_pretty(&cache.to_value());
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID_A: &str = "9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359";
    const ID_X: &str = "f59d9a69-1f62-57e0-a392-6800d3dd021d";

    fn doc() -> Value {
        gondolin_wire::value!({
            "schema": 1,
            "refs": { "alpine-base:latest": { "arm64": ID_A, "x86_64": ID_X }, "solo:1": { "x86_64": ID_X } },
            "builds": {
                (ID_A): { "url": "images/a.tar.gz", "sha256": "AB".repeat(32), "arch": "aarch64" },
                (ID_X): { "url": "https://example.com/x.tar.gz", "arch": "x86_64", "extra": true }
            }
        })
    }

    #[test]
    fn parses_and_resolves() {
        let r = Registry::parse(&doc(), "https://host/reg/registry.json").unwrap();
        let a = r.builds.get(&ID_A.to_string()).unwrap();
        assert_eq!(a.url, "https://host/reg/images/a.tar.gz");
        assert_eq!(a.sha256.as_deref(), Some("ab".repeat(32).as_str()));
        let (id, arch, _) = r.resolve_ref("alpine-base:latest", Arch::Aarch64).unwrap();
        assert_eq!((id.as_str(), arch), (ID_A, Arch::Aarch64));
        // single entry fallback
        let (id, arch, _) = r.resolve_ref("solo:1", Arch::Aarch64).unwrap();
        assert_eq!((id.as_str(), arch), (ID_X, Arch::X86_64));
        assert_eq!(
            r.resolve_ref("nope:1", Arch::Aarch64).unwrap_err().to_string(),
            "image ref not found in builtin registry: nope:1"
        );
        // serializes with normalized keys in document order
        let out = gondolin_wire::json::to_string(&r.to_value());
        assert!(
            out.starts_with(r#"{"schema":1,"refs":{"alpine-base:latest":{"aarch64":"#),
            "{out}"
        );
    }

    #[test]
    fn rejects_bad_documents() {
        let mut d = doc();
        d["schema"] = Value::from(2u64);
        assert_eq!(
            Registry::parse(&d, "https://h/r.json").unwrap_err().to_string(),
            "invalid builtin image registry schema: expected 1"
        );
        let mut d = doc();
        d["refs"]["alpine-base"] = gondolin_wire::value!({});
        assert_eq!(
            Registry::parse(&d, "https://h/r.json").unwrap_err().to_string(),
            "invalid builtin image registry ref key: alpine-base"
        );
        let mut d = doc();
        d["refs"]["x:1"] = gondolin_wire::value!({ "x86_64": ID_A });
        assert_eq!(
            Registry::parse(&d, "https://h/r.json").unwrap_err().to_string(),
            "invalid refs['x:1']['x86_64']: arch x86_64 does not match build arch aarch64"
        );
        let mut d = doc();
        d["refs"]["x:1"] = gondolin_wire::value!({ "riscv": ID_A });
        assert!(Registry::parse(&d, "https://h/r.json").is_err());
        let mut d = doc();
        d["builds"][ID_A]["sha256"] = "zz".into();
        assert!(Registry::parse(&d, "https://h/r.json").is_err());
    }

    #[test]
    fn cache_roundtrip_matches_node_format() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://host/reg/registry.json";
        let registry = Registry::parse(&doc(), url).unwrap();
        save_cache(
            dir.path(),
            &RegistryCache {
                url: url.into(),
                etag: Some("W/\"x\"".into()),
                registry: registry.clone(),
            },
        )
        .unwrap();
        let text = std::fs::read_to_string(dir.path().join(REGISTRY_CACHE_FILE)).unwrap();
        assert!(
            text.starts_with("{\n  \"url\": \"https://host/reg/registry.json\",\n  \"etag\""),
            "{text}"
        );
        let loaded = load_cache(dir.path(), url).unwrap();
        assert_eq!(loaded.registry, registry);
        assert_eq!(loaded.etag.as_deref(), Some("W/\"x\""));
        assert!(load_cache(dir.path(), "https://other/").is_none());
    }

    #[test]
    fn parses_repo_registry_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../builtin-image-registry.json");
        let raw = gondolin_wire::json::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
        let r = Registry::parse(&raw, DEFAULT_IMAGE_REGISTRY_URL).unwrap();
        assert!(r.refs.get(&"alpine-base:latest".to_string()).is_some());
    }
}
