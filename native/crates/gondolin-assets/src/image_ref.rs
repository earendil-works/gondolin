//! Image references, build ids and architectures (port of
//! `host/src/image-ref.ts` and `host/src/host/arch.ts`).

use std::fmt;

use gondolin_wire::{DecodeError, FromValue, ToValue, Value};

use crate::AssetsError;

/// Guest architecture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Arch {
    Aarch64,
    X86_64,
}

impl ToValue for Arch {
    fn to_value(&self) -> Value {
        Value::Text(self.as_str().into())
    }
}

impl FromValue for Arch {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        match value.as_text() {
            Some("aarch64") => Ok(Arch::Aarch64),
            Some("x86_64") => Ok(Arch::X86_64),
            _ => Err(DecodeError::expected("`aarch64` or `x86_64`", value)),
        }
    }
}

impl Arch {
    pub const ALL: [Arch; 2] = [Arch::Aarch64, Arch::X86_64];

    pub fn as_str(self) -> &'static str {
        match self {
            Arch::Aarch64 => "aarch64",
            Arch::X86_64 => "x86_64",
        }
    }

    /// Normalizes aliases (`arm64`, `amd64`, `x64`, ...), case-insensitive.
    pub fn normalize(value: &str) -> Option<Arch> {
        match value.to_ascii_lowercase().as_str() {
            "aarch64" | "arm64" => Some(Arch::Aarch64),
            "x86_64" | "amd64" | "x64" => Some(Arch::X86_64),
            _ => None,
        }
    }

    pub fn other(self) -> Arch {
        match self {
            Arch::Aarch64 => Arch::X86_64,
            Arch::X86_64 => Arch::Aarch64,
        }
    }

    /// The host's architecture (an x86_64 build running under Rosetta reports
    /// `aarch64`, like the node engine).
    pub fn host() -> Arch {
        if cfg!(target_arch = "aarch64") {
            return Arch::Aarch64;
        }
        #[cfg(target_os = "macos")]
        {
            let translated = std::process::Command::new("sysctl")
                .args(["-n", "hw.optional.arm64"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
                .unwrap_or(false);
            if translated {
                return Arch::Aarch64;
            }
        }
        Arch::X86_64
    }
}

impl fmt::Display for Arch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Parsed `name[:tag]` image reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRef {
    /// image name (`/`-separated segments)
    pub name: String,
    /// tag (`latest` when omitted)
    pub tag: String,
}

impl ImageRef {
    /// Canonical `name:tag`.
    pub fn canonical(&self) -> String {
        format!("{}:{}", self.name, self.tag)
    }

    /// Parses a reference with the node engine's rules and error messages.
    pub fn parse(reference: &str) -> Result<ImageRef, AssetsError> {
        let trimmed = reference.trim();
        if trimmed.is_empty() {
            return Err(AssetsError::invalid("image reference must not be empty"));
        }
        let colon = trimmed.rfind(':');
        let (name, tag) = match colon {
            Some(c) if c > 0 && c < trimmed.len() - 1 => (&trimmed[..c], &trimmed[c + 1..]),
            _ => (trimmed, "latest"),
        };
        if !is_name(name) {
            return Err(AssetsError::invalid(format!(
                "invalid image name '{name}' (allowed: letters, numbers, '.', '_', '-', '/')"
            )));
        }
        for segment in name.split('/') {
            if segment.is_empty() || segment == "." || segment == ".." {
                return Err(AssetsError::invalid(format!(
                    "invalid image name '{name}' (must not contain path traversal segments)"
                )));
            }
            if !is_segment(segment) {
                return Err(AssetsError::invalid(format!(
                    "invalid image name '{name}' (invalid segment '{segment}')"
                )));
            }
        }
        if !is_segment(tag) {
            return Err(AssetsError::invalid(format!(
                "invalid image tag '{tag}' (allowed: letters, numbers, '.', '_', '-')"
            )));
        }
        Ok(ImageRef { name: name.to_string(), tag: tag.to_string() })
    }
}

fn starts_alnum(s: &str) -> bool {
    s.as_bytes().first().is_some_and(|b| b.is_ascii_alphanumeric())
}

/// `^[A-Za-z0-9][A-Za-z0-9._/-]*$`
fn is_name(s: &str) -> bool {
    starts_alnum(s) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]*$`
fn is_segment(s: &str) -> bool {
    starts_alnum(s) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// Content-derived build id: a lowercase RFC 4122 UUID (versions 1-5).
pub fn is_build_id(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, &c) in b.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => c == b'-',
            14 => (b'1'..=b'5').contains(&c),
            19 => b"89ab".contains(&c),
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(&c),
        };
        if !ok {
            return false;
        }
    }
    true
}

pub(crate) fn normalize_build_id(value: &str) -> Result<String, AssetsError> {
    if is_build_id(value) {
        Ok(value.to_string())
    } else {
        Err(AssetsError::invalid(format!("invalid image build id: {value}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Result<(String, String), String> {
        ImageRef::parse(s).map(|r| (r.name, r.tag)).map_err(|e| e.to_string())
    }

    #[test]
    fn parses_refs() {
        assert_eq!(parse("alpine-base"), Ok(("alpine-base".into(), "latest".into())));
        assert_eq!(parse(" alpine-base:0.4.0 "), Ok(("alpine-base".into(), "0.4.0".into())));
        assert_eq!(parse("org/team/img:v1"), Ok(("org/team/img".into(), "v1".into())));
        assert_eq!(ImageRef::parse("a:b").unwrap().canonical(), "a:b");
        // a trailing colon is part of the (invalid) name, a leading colon too
        assert_eq!(
            parse("img:"),
            Err("invalid image name 'img:' (allowed: letters, numbers, '.', '_', '-', '/')".into())
        );
        assert!(parse(":tag").is_err());
        assert_eq!(parse(""), Err("image reference must not be empty".into()));
        assert_eq!(
            parse("a/../b"),
            Err("invalid image name 'a/../b' (must not contain path traversal segments)".into())
        );
        assert_eq!(
            parse("a//b"),
            Err("invalid image name 'a//b' (must not contain path traversal segments)".into())
        );
        assert_eq!(parse("a/.b"), Err("invalid image name 'a/.b' (invalid segment '.b')".into()));
        assert_eq!(
            parse("img:-x"),
            Err("invalid image tag '-x' (allowed: letters, numbers, '.', '_', '-')".into())
        );
        assert_eq!(
            parse("img:a+b").unwrap_err(),
            "invalid image tag 'a+b' (allowed: letters, numbers, '.', '_', '-')"
        );
    }

    #[test]
    fn build_ids() {
        assert!(is_build_id("9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359"));
        assert!(!is_build_id("9EC8F6C5-bd1f-5ac8-9bc2-2efd531c2359"));
        assert!(!is_build_id("9ec8f6c5-bd1f-6ac8-9bc2-2efd531c2359"));
        assert!(!is_build_id("9ec8f6c5-bd1f-5ac8-7bc2-2efd531c2359"));
        assert!(!is_build_id("alpine-base:latest"));
    }

    #[test]
    fn arches() {
        assert_eq!(Arch::normalize("ARM64"), Some(Arch::Aarch64));
        assert_eq!(Arch::normalize("amd64"), Some(Arch::X86_64));
        assert_eq!(Arch::normalize("x64"), Some(Arch::X86_64));
        assert_eq!(Arch::normalize("riscv64"), None);
        assert_eq!(Arch::Aarch64.other(), Arch::X86_64);
    }
}
