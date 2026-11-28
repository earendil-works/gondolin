//! Windows uses controller-backed filesystem providers rather than the Unix
//! descriptor-relative native host provider. Never substitute an unhardened
//! path-based provider for that security boundary.

/// Object and memory providers have no native blocking filesystem work.
pub fn with_inline_blocking<T>(f: impl FnOnce() -> T) -> T {
    f()
}
