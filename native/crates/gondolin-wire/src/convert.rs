//! Typed conversion between Rust values and [`Value`] (the CBOR/JSON data
//! model): [`ToValue`], [`FromValue`] and the declarative macros
//! [`wire_struct!`](crate::wire_struct), [`wire_enum!`](crate::wire_enum)
//! and [`wire_tagged!`](crate::wire_tagged) (no proc macros).
//!
//! Conventions (the guest protocols' rules, `guest/ARCHITECTURE.md` §3.3):
//! - records are maps with text keys; unknown keys are ignored; with
//!   duplicate keys the first wins;
//! - `Option` fields are omitted when `None` and `None` when absent or null;
//! - `Vec<u8>`/`[u8]` are byte strings (other `Vec`s are arrays);
//! - integers are range-checked when decoding.

use std::collections::BTreeMap;
use std::fmt;

use crate::value::Value;

/// A typed decoding error with the path of the offending field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError {
    /// field names from the outermost (`vm.root_disk.path`)
    path: Vec<String>,
    message: String,
}

impl DecodeError {
    pub fn new(message: impl Into<String>) -> Self {
        DecodeError { path: Vec::new(), message: message.into() }
    }

    /// `expected <what>, got <kind of value>`
    pub fn expected(what: &str, got: &Value) -> Self {
        Self::new(format!("invalid type: {}, expected {what}", got.kind()))
    }

    pub fn missing(field: &str) -> Self {
        Self::new(format!("missing field `{field}`"))
    }

    /// Prefixes the path with `field`.
    pub fn at(mut self, field: &str) -> Self {
        self.path.insert(0, field.to_string());
        self
    }

    /// The message without the path.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() {
            f.write_str(&self.message)
        } else {
            write!(f, "{}: {}", self.path.join("."), self.message)
        }
    }
}

impl std::error::Error for DecodeError {}

/// Conversion into a [`Value`].
pub trait ToValue {
    fn to_value(&self) -> Value;

    /// Whether a record field holding this value is omitted (`None`).
    fn skip_field(&self) -> bool {
        false
    }

    /// Encoding of a slice of `Self` (arrays; byte strings for `u8`).
    #[doc(hidden)]
    fn slice_to_value(items: &[Self]) -> Value
    where
        Self: Sized,
    {
        Value::Array(items.iter().map(ToValue::to_value).collect())
    }
}

/// Conversion from a [`Value`].
pub trait FromValue: Sized {
    fn from_value(value: &Value) -> Result<Self, DecodeError>;

    /// The value of an absent record field, if absence is allowed (`None` for
    /// `Option`).
    fn from_missing() -> Option<Self> {
        None
    }

    /// Decoding of a `Vec<Self>` (arrays; byte strings for `u8`).
    #[doc(hidden)]
    fn vec_from_value(value: &Value) -> Result<Vec<Self>, DecodeError> {
        let items = value.as_array().ok_or_else(|| DecodeError::expected("an array", value))?;
        items
            .iter()
            .enumerate()
            .map(|(i, v)| Self::from_value(v).map_err(|e| e.at(&i.to_string())))
            .collect()
    }
}

/// Encodes a typed value.
pub fn to_value<T: ToValue + ?Sized>(value: &T) -> Value {
    value.to_value()
}

/// Decodes a typed value.
pub fn from_value<T: FromValue>(value: &Value) -> Result<T, DecodeError> {
    T::from_value(value)
}

/// A field name without the raw identifier prefix (`r#type` → `type`).
#[doc(hidden)]
pub const fn unraw(name: &'static str) -> &'static str {
    match name.as_bytes() {
        [b'r', b'#', rest @ ..] => match std::str::from_utf8(rest) {
            Ok(s) => s,
            Err(_) => name,
        },
        _ => name,
    }
}

/// Decodes record field `name` of `map` (`FromValue::from_missing` when absent).
#[doc(hidden)]
pub fn field<T: FromValue>(map: &Value, name: &str) -> Result<T, DecodeError> {
    match map.get(name) {
        Some(v) => T::from_value(v).map_err(|e| e.at(name)),
        None => T::from_missing().ok_or_else(|| DecodeError::missing(name)),
    }
}

/// Decodes record field `name`, using `default` when absent or null.
#[doc(hidden)]
pub fn field_or<T: FromValue>(
    map: &Value,
    name: &str,
    default: impl FnOnce() -> T,
) -> Result<T, DecodeError> {
    match map.get(name) {
        Some(Value::Null) | None => Ok(default()),
        Some(v) => T::from_value(v).map_err(|e| e.at(name)),
    }
}

/// Checks that `value` is a map (record decoding).
#[doc(hidden)]
pub fn expect_map<'a>(value: &'a Value, what: &str) -> Result<&'a Value, DecodeError> {
    match value {
        Value::Map(_) => Ok(value),
        other => Err(DecodeError::expected(what, other)),
    }
}

/// Appends the entries of a map `value` to `out` (flattened fields).
#[doc(hidden)]
pub fn merge_into(out: &mut Vec<(Value, Value)>, value: Value) {
    if let Value::Map(entries) = value {
        out.extend(entries);
    }
}

impl ToValue for Value {
    fn to_value(&self) -> Value {
        self.clone()
    }
}

impl FromValue for Value {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        Ok(value.clone())
    }

    fn from_missing() -> Option<Self> {
        None
    }
}

impl ToValue for bool {
    fn to_value(&self) -> Value {
        Value::Bool(*self)
    }
}

impl FromValue for bool {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        value.as_bool().ok_or_else(|| DecodeError::expected("a boolean", value))
    }
}

macro_rules! int_impls {
    ($($t:ty),*) => {$(
        impl ToValue for $t {
            fn to_value(&self) -> Value {
                Value::Integer(*self as i128)
            }
        }

        impl FromValue for $t {
            fn from_value(value: &Value) -> Result<Self, DecodeError> {
                let n = match value {
                    Value::Integer(n) => *n,
                    // integral floats (JavaScript numbers)
                    Value::Float(f) if f.fract() == 0.0 && f.is_finite() => *f as i128,
                    other => return Err(DecodeError::expected(concat!("an integer (", stringify!($t), ")"), other)),
                };
                <$t>::try_from(n).map_err(|_| {
                    DecodeError::new(format!("integer {n} out of range for {}", stringify!($t)))
                })
            }
        }
    )*};
}
int_impls!(u16, u32, u64, usize, i8, i16, i32, i64, i128, isize);

impl ToValue for u8 {
    fn to_value(&self) -> Value {
        Value::Integer(*self as i128)
    }

    fn slice_to_value(items: &[Self]) -> Value {
        Value::Bytes(items.to_vec())
    }
}

impl FromValue for u8 {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        let n =
            value.as_integer().ok_or_else(|| DecodeError::expected("an integer (u8)", value))?;
        u8::try_from(n).map_err(|_| DecodeError::new(format!("integer {n} out of range for u8")))
    }

    fn vec_from_value(value: &Value) -> Result<Vec<Self>, DecodeError> {
        match value {
            Value::Bytes(b) => Ok(b.clone()),
            Value::Array(items) => items.iter().map(u8::from_value).collect(),
            other => Err(DecodeError::expected("a byte string", other)),
        }
    }
}

impl ToValue for f64 {
    fn to_value(&self) -> Value {
        Value::Float(*self)
    }
}

impl FromValue for f64 {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        value.as_float().ok_or_else(|| DecodeError::expected("a number", value))
    }
}

impl ToValue for str {
    fn to_value(&self) -> Value {
        Value::Text(self.to_string())
    }
}

impl ToValue for String {
    fn to_value(&self) -> Value {
        Value::Text(self.clone())
    }
}

impl FromValue for String {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        value.as_text().map(str::to_string).ok_or_else(|| DecodeError::expected("a string", value))
    }
}

impl ToValue for std::path::PathBuf {
    fn to_value(&self) -> Value {
        Value::Text(self.display().to_string())
    }
}

impl FromValue for std::path::PathBuf {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        String::from_value(value).map(Into::into)
    }
}

/// IP addresses travel as their text form (`"192.168.127.1"`).
macro_rules! text_impls {
    ($($t:ty: $what:literal),*) => {$(
        impl ToValue for $t {
            fn to_value(&self) -> Value {
                Value::Text(self.to_string())
            }
        }

        impl FromValue for $t {
            fn from_value(value: &Value) -> Result<Self, DecodeError> {
                let text = value.as_text().ok_or_else(|| DecodeError::expected($what, value))?;
                text.parse().map_err(|_| DecodeError::new(format!("invalid {}: {text:?}", $what)))
            }
        }
    )*};
}
text_impls!(
    std::net::Ipv4Addr: "an IPv4 address",
    std::net::Ipv6Addr: "an IPv6 address",
    std::net::IpAddr: "an IP address"
);

impl<T: ToValue + ?Sized> ToValue for &T {
    fn to_value(&self) -> Value {
        (**self).to_value()
    }

    fn skip_field(&self) -> bool {
        (**self).skip_field()
    }
}

impl<T: ToValue + ?Sized> ToValue for Box<T> {
    fn to_value(&self) -> Value {
        (**self).to_value()
    }
}

impl<T: FromValue> FromValue for Box<T> {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        T::from_value(value).map(Box::new)
    }
}

impl<T: ToValue> ToValue for Option<T> {
    fn to_value(&self) -> Value {
        self.as_ref().map_or(Value::Null, ToValue::to_value)
    }

    fn skip_field(&self) -> bool {
        self.is_none()
    }
}

impl<T: FromValue> FromValue for Option<T> {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        match value {
            Value::Null => Ok(None),
            v => T::from_value(v).map(Some),
        }
    }

    fn from_missing() -> Option<Self> {
        Some(None)
    }
}

impl<T: ToValue> ToValue for [T] {
    fn to_value(&self) -> Value {
        T::slice_to_value(self)
    }
}

impl<T: ToValue> ToValue for Vec<T> {
    fn to_value(&self) -> Value {
        T::slice_to_value(self)
    }
}

impl<T: FromValue> FromValue for Vec<T> {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        T::vec_from_value(value)
    }
}

impl<T: ToValue> ToValue for BTreeMap<String, T> {
    fn to_value(&self) -> Value {
        Value::Map(self.iter().map(|(k, v)| (Value::Text(k.clone()), v.to_value())).collect())
    }
}

impl<T: FromValue> FromValue for BTreeMap<String, T> {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        let entries = value.as_map().ok_or_else(|| DecodeError::expected("a map", value))?;
        let mut out = BTreeMap::new();
        for (k, v) in entries {
            let Some(k) = k.as_text() else { continue };
            if out.contains_key(k) {
                continue; // first wins
            }
            out.insert(k.to_string(), T::from_value(v).map_err(|e| e.at(k))?);
        }
        Ok(out)
    }
}

impl<A: ToValue, B: ToValue> ToValue for (A, B) {
    fn to_value(&self) -> Value {
        Value::Array(vec![self.0.to_value(), self.1.to_value()])
    }
}

impl<A: FromValue, B: FromValue> FromValue for (A, B) {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        match value.as_array().map(Vec::as_slice) {
            Some([a, b]) => Ok((A::from_value(a)?, B::from_value(b)?)),
            _ => Err(DecodeError::expected("a pair", value)),
        }
    }
}

impl<A: ToValue, B: ToValue, C: ToValue> ToValue for (A, B, C) {
    fn to_value(&self) -> Value {
        Value::Array(vec![self.0.to_value(), self.1.to_value(), self.2.to_value()])
    }
}

impl<A: FromValue, B: FromValue, C: FromValue> FromValue for (A, B, C) {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        match value.as_array().map(Vec::as_slice) {
            Some([a, b, c]) => Ok((A::from_value(a)?, B::from_value(b)?, C::from_value(c)?)),
            _ => Err(DecodeError::expected("a triple", value)),
        }
    }
}

impl<T: ToValue> ToValue for std::collections::HashMap<String, T> {
    fn to_value(&self) -> Value {
        // sorted, so encodings are deterministic
        let mut entries: Vec<_> = self.iter().collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));
        Value::Map(
            entries.into_iter().map(|(k, v)| (Value::Text(k.clone()), v.to_value())).collect(),
        )
    }
}

impl<T: FromValue> FromValue for std::collections::HashMap<String, T> {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        Ok(BTreeMap::<String, T>::from_value(value)?.into_iter().collect())
    }
}

/// The wire name of a record field: the field name, or the `as` override.
#[doc(hidden)]
#[macro_export]
macro_rules! __wire_name {
    ($field:ident) => {
        $crate::convert::unraw(stringify!($field))
    };
    ($field:ident $name:literal) => {
        $name
    };
}

/// Encodes one record field into `$out`.
#[doc(hidden)]
#[macro_export]
macro_rules! __wire_put {
    ($out:ident, $value:expr, $name:expr) => {
        if !$crate::ToValue::skip_field(&$value) {
            $out.push(($crate::Value::Text($name.into()), $crate::ToValue::to_value(&$value)));
        }
    };
    ($out:ident, $value:expr, $name:expr, flatten) => {
        $crate::convert::merge_into(&mut $out, $crate::ToValue::to_value(&$value));
    };
    ($out:ident, $value:expr, $name:expr, skip_if $skip:path) => {
        if !$skip(&$value) {
            $out.push(($crate::Value::Text($name.into()), $crate::ToValue::to_value(&$value)));
        }
    };
}

/// Decodes one record field from map `$map`.
#[doc(hidden)]
#[macro_export]
macro_rules! __wire_get {
    ($map:ident, $ty:ty, $name:expr, ($default:expr) flatten) => {
        <$ty as $crate::FromValue>::from_value($map)?
    };
    ($map:ident, $ty:ty, $name:expr, () flatten) => {
        <$ty as $crate::FromValue>::from_value($map)?
    };
    ($map:ident, $ty:ty, $name:expr, ($default:expr) $($opt:tt)*) => {
        $crate::convert::field_or::<$ty>($map, $name, || $default)?
    };
    ($map:ident, $ty:ty, $name:expr, () $($opt:tt)*) => {
        $crate::convert::field::<$ty>($map, $name)?
    };
}

/// A record (struct) with [`ToValue`]/[`FromValue`] as a map.
///
/// ```ignore
/// gondolin_wire::wire_struct! {
///     /// docs
///     #[derive(Debug, Clone, PartialEq)]
///     pub struct Boot {
///         pub client: u32,
///         /// wire name differs from the field name
///         pub fuse_mount: Option<String> as "fuseMount",
///         /// default when absent or null
///         pub binds: Vec<String> = Vec::new(),
///         /// omitted when `Vec::is_empty`
///         pub extra: Vec<String> = Vec::new() => skip_if Vec::is_empty,
///         /// fields of another record merged into this map
///         pub op: Op => flatten,
///     }
/// }
/// ```
///
/// `Option` fields are omitted when `None` and `None` when absent or null.
#[macro_export]
macro_rules! wire_struct {
    (
        $(#[$attr:meta])*
        $vis:vis struct $name:ident {
            $(
                $(#[$fattr:meta])*
                $fvis:vis $field:ident : $fty:ty
                $(as $wire:literal)?
                $(= $default:expr)?
                $(=> $opt:ident $($optarg:path)?)?
            ),* $(,)?
        }
    ) => {
        $(#[$attr])*
        $vis struct $name {
            $(
                $(#[$fattr])*
                $fvis $field: $fty,
            )*
        }

        impl $crate::ToValue for $name {
            fn to_value(&self) -> $crate::Value {
                #[allow(unused_mut)]
                let mut out: Vec<($crate::Value, $crate::Value)> = Vec::new();
                $(
                    $crate::__wire_put!(
                        out,
                        self.$field,
                        $crate::__wire_name!($field $($wire)?)
                        $(, $opt $($optarg)?)?
                    );
                )*
                $crate::Value::Map(out)
            }
        }

        impl $crate::FromValue for $name {
            fn from_value(value: &$crate::Value) -> Result<Self, $crate::DecodeError> {
                #[allow(unused_variables)]
                let map = $crate::convert::expect_map(value, concat!("a map (", stringify!($name), ")"))?;
                Ok($name {
                    $(
                        $field: $crate::__wire_get!(
                            map,
                            $fty,
                            $crate::__wire_name!($field $($wire)?),
                            ($($default)?) $($opt)?
                        ),
                    )*
                })
            }
        }
    };
}

/// An encode-only record ([`ToValue`] only), e.g. borrowing its fields;
/// lifetime parameters are allowed. Field options as in
/// [`wire_struct!`](crate::wire_struct) (defaults do not apply).
///
/// ```ignore
/// gondolin_wire::wire_encode! {
///     struct Data<'a> { conn: u32, data: &'a [u8] }
/// }
/// ```
#[macro_export]
macro_rules! wire_encode {
    (
        $(#[$attr:meta])*
        $vis:vis struct $name:ident $(<$($lt:lifetime),+>)? {
            $(
                $(#[$fattr:meta])*
                $fvis:vis $field:ident : $fty:ty
                $(as $wire:literal)?
                $(=> $opt:ident $($optarg:path)?)?
            ),* $(,)?
        }
    ) => {
        $(#[$attr])*
        $vis struct $name $(<$($lt),+>)? {
            $(
                $(#[$fattr])*
                $fvis $field: $fty,
            )*
        }

        impl $(<$($lt),+>)? $crate::ToValue for $name $(<$($lt),+>)? {
            fn to_value(&self) -> $crate::Value {
                #[allow(unused_mut)]
                let mut out: Vec<($crate::Value, $crate::Value)> = Vec::new();
                $(
                    $crate::__wire_put!(
                        out,
                        self.$field,
                        $crate::__wire_name!($field $($wire)?)
                        $(, $opt $($optarg)?)?
                    );
                )*
                $crate::Value::Map(out)
            }
        }
    };
}

/// A fieldless enum encoded as a string.
///
/// ```ignore
/// gondolin_wire::wire_enum! {
///     #[derive(Debug, Clone, Copy, PartialEq, Eq)]
///     pub enum State { Starting = "starting", Running = "running" }
/// }
/// ```
#[macro_export]
macro_rules! wire_enum {
    (
        $(#[$attr:meta])*
        $vis:vis enum $name:ident {
            $(
                $(#[$vattr:meta])*
                $variant:ident = $wire:literal
            ),* $(,)?
        }
    ) => {
        $(#[$attr])*
        $vis enum $name {
            $(
                $(#[$vattr])*
                $variant,
            )*
        }

        impl $name {
            /// The wire name.
            pub fn as_str(&self) -> &'static str {
                match self {
                    $( $name::$variant => $wire, )*
                }
            }
        }

        impl std::str::FromStr for $name {
            type Err = $crate::DecodeError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $( $wire => Ok($name::$variant), )*
                    other => Err($crate::DecodeError::new(format!(
                        "unknown variant `{other}`, expected one of {}",
                        [$(concat!("`", $wire, "`")),*].join(", ")
                    ))),
                }
            }
        }

        impl $crate::ToValue for $name {
            fn to_value(&self) -> $crate::Value {
                $crate::Value::Text(self.as_str().into())
            }
        }

        impl $crate::FromValue for $name {
            fn from_value(value: &$crate::Value) -> Result<Self, $crate::DecodeError> {
                let s = value
                    .as_text()
                    .ok_or_else(|| $crate::DecodeError::expected("a string", value))?;
                s.parse()
            }
        }
    };
}

/// An internally tagged enum (`{ "<tag>": "<variant>", ...fields }`):
/// variants with named fields (as in [`wire_struct!`](crate::wire_struct))
/// or wrapping one record whose fields are merged (`Name = "name" (Type)`).
///
/// ```ignore
/// gondolin_wire::wire_tagged! {
///     #[derive(Debug, Clone, PartialEq)]
///     pub enum Source : "kind" {
///         Host = "host" { root: String },
///         Memory = "memory" {},
///         Object = "object" (ObjectConfig),
///     }
/// }
/// ```
#[macro_export]
macro_rules! wire_tagged {
    (
        $(#[$attr:meta])*
        $vis:vis enum $name:ident : $tag:literal {
            $(
                $(#[$vattr:meta])*
                $variant:ident = $wire:literal
                $({
                    $(
                        $(#[$fattr:meta])*
                        $field:ident : $fty:ty
                        $(as $fwire:literal)?
                        $(= $default:expr)?
                        $(=> $opt:ident $($optarg:path)?)?
                    ),* $(,)?
                })?
                $(( $inner:ty ))?
            ),* $(,)?
        }
    ) => {
        $(#[$attr])*
        $vis enum $name {
            $(
                $(#[$vattr])*
                $variant
                $({ $( $(#[$fattr])* $field: $fty, )* })?
                $(( $inner ))?,
            )*
        }

        impl $crate::ToValue for $name {
            #[allow(unused_variables, unused_mut)]
            fn to_value(&self) -> $crate::Value {
                let mut out: Vec<($crate::Value, $crate::Value)> =
                    vec![($crate::Value::Text($tag.into()), $crate::Value::Text(String::new()))];
                match self {
                    $(
                        $crate::__wire_tagged_pat!(__inner; $name $variant $({ $($field),* })? $(( $inner ))?) => {
                            out[0].1 = $crate::Value::Text($wire.into());
                            $($(
                                $crate::__wire_put!(
                                    out,
                                    *$field,
                                    $crate::__wire_name!($field $($fwire)?)
                                    $(, $opt $($optarg)?)?
                                );
                            )*)?
                            $(
                                let _: Option<&$inner> = None;
                                $crate::convert::merge_into(&mut out, $crate::ToValue::to_value(__inner));
                            )?
                        }
                    )*
                }
                $crate::Value::Map(out)
            }
        }

        impl $crate::FromValue for $name {
            #[allow(unused_variables)]
            fn from_value(value: &$crate::Value) -> Result<Self, $crate::DecodeError> {
                let map = $crate::convert::expect_map(value, concat!("a map (", stringify!($name), ")"))?;
                let tag = match map.get($tag) {
                    Some(t) => t.as_text().ok_or_else(|| $crate::DecodeError::expected("a string", t).at($tag))?,
                    None => return Err($crate::DecodeError::missing($tag)),
                };
                match tag {
                    $(
                        $wire => Ok($crate::__wire_tagged_build!(
                            map, $name $variant
                            $({ $( $field : $fty, ($crate::__wire_name!($field $($fwire)?)), ($($default)?) $($opt)? ;)* })?
                            $(( $inner ))?
                        )),
                    )*
                    other => Err($crate::DecodeError::new(format!(
                        "unknown variant `{other}`, expected one of {}",
                        [$(concat!("`", $wire, "`")),*].join(", ")
                    )).at($tag)),
                }
            }
        }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __wire_tagged_pat {
    ($bind:ident; $name:ident $variant:ident { $($field:ident),* }) => {
        $name::$variant { $($field),* }
    };
    ($bind:ident; $name:ident $variant:ident ( $inner:ty )) => {
        $name::$variant($bind)
    };
    ($bind:ident; $name:ident $variant:ident) => {
        $name::$variant
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __wire_tagged_build {
    ($map:ident, $name:ident $variant:ident { $( $field:ident : $fty:ty, ($wname:expr), ($($default:expr)?) $($opt:ident)? ;)* }) => {
        $name::$variant {
            $( $field: $crate::__wire_get!($map, $fty, $wname, ($($default)?) $($opt)?), )*
        }
    };
    ($map:ident, $name:ident $variant:ident ( $inner:ty )) => {
        $name::$variant(<$inner as $crate::FromValue>::from_value($map)?)
    };
    ($map:ident, $name:ident $variant:ident) => {
        $name::$variant
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cbor, json};

    crate::wire_struct! {
        /// A test record.
        #[derive(Debug, Clone, PartialEq, Default)]
        pub struct Rec {
            pub id: u32,
            pub name: Option<String> as "Name",
            pub data: Vec<u8> = Vec::new(),
            pub tags: Vec<String> = Vec::new() => skip_if Vec::is_empty,
            pub nested: Option<Box<Rec>>,
        }
    }

    crate::wire_enum! {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum Mode { Fast = "fast", SlowAndSteady = "slow_and_steady" }
    }

    crate::wire_struct! {
        #[derive(Debug, Clone, PartialEq)]
        pub struct ObjectCfg {
            pub mount_id: u32,
            pub writable: bool = false,
        }
    }

    crate::wire_tagged! {
        #[derive(Debug, Clone, PartialEq)]
        pub enum Source : "kind" {
            Host = "host" { root: String, mode: Option<Mode> },
            Memory = "memory" {},
            Object = "object" (ObjectCfg),
        }
    }

    crate::wire_struct! {
        #[derive(Debug, Clone, PartialEq)]
        pub struct Mount {
            pub path: String,
            pub source: Source => flatten,
            pub readonly: bool = false => skip_if std::ops::Not::not,
        }
    }

    fn not(b: &bool) -> bool {
        !*b
    }

    #[test]
    fn records() {
        let r = Rec { id: 7, name: Some("x".into()), data: vec![1, 2], tags: vec![], nested: None };
        let v = r.to_value();
        assert_eq!(json::to_string(&v), r#"{"id":7,"Name":"x","data":{"$base64":"AQI="}}"#);
        assert_eq!(Rec::from_value(&cbor::decode(&cbor::encode(&v)).unwrap()).unwrap(), r);
        // absent optional/defaulted fields, unknown keys, first of duplicate keys
        let v = json::parse(r#"{"id":1,"zzz":true,"Name":null}"#).unwrap();
        assert_eq!(Rec::from_value(&v).unwrap(), Rec { id: 1, ..Default::default() });
        let v = Value::Map(vec![
            (Value::Text("id".into()), Value::Integer(1)),
            (Value::Text("id".into()), Value::Integer(2)),
        ]);
        assert_eq!(Rec::from_value(&v).unwrap().id, 1);
        // errors carry the path
        let v = json::parse(r#"{"id":1,"nested":{"id":-1}}"#).unwrap();
        assert_eq!(
            Rec::from_value(&v).unwrap_err().to_string(),
            "nested.id: integer -1 out of range for u32"
        );
        let v = json::parse(r#"{"Name":"x"}"#).unwrap();
        assert_eq!(Rec::from_value(&v).unwrap_err().to_string(), "missing field `id`");
        assert!(Rec::from_value(&Value::Integer(1)).is_err());
    }

    #[test]
    fn enums_and_tags() {
        assert_eq!(Mode::SlowAndSteady.to_value(), Value::Text("slow_and_steady".into()));
        assert!(
            Mode::from_value(&Value::Text("x".into())).unwrap_err().to_string().contains("`fast`")
        );
        let m = Mount {
            path: "/a".into(),
            source: Source::Host { root: "/r".into(), mode: Some(Mode::Fast) },
            readonly: true,
        };
        let v = m.to_value();
        assert_eq!(
            json::to_string(&v),
            r#"{"path":"/a","kind":"host","root":"/r","mode":"fast","readonly":true}"#
        );
        assert_eq!(Mount::from_value(&v).unwrap(), m);
        let o = Mount {
            path: "/o".into(),
            source: Source::Object(ObjectCfg { mount_id: 3, writable: true }),
            readonly: false,
        };
        let v = o.to_value();
        assert_eq!(
            json::to_string(&v),
            r#"{"path":"/o","kind":"object","mount_id":3,"writable":true}"#
        );
        assert_eq!(Mount::from_value(&v).unwrap(), o);
        let mem = json::parse(r#"{"path":"/m","kind":"memory"}"#).unwrap();
        assert_eq!(Mount::from_value(&mem).unwrap().source, Source::Memory {});
        let bad = json::parse(r#"{"path":"/m","kind":"nope"}"#).unwrap();
        assert!(
            Mount::from_value(&bad)
                .unwrap_err()
                .to_string()
                .starts_with("kind: unknown variant `nope`")
        );
        assert!(not(&false));
    }
}

/// Builds a [`Value`] with JSON-like syntax (like `serde_json::json!`):
/// `value!({ "a": 1, "b": [x, null, { "c": expr }], (key_expr): v })`.
/// Expressions convert with [`ToValue`] (`None` → null, `Vec<u8>` → bytes).
#[macro_export]
macro_rules! value {
    (null) => { $crate::Value::Null };
    ([ $($tt:tt)* ]) => { $crate::Value::Array($crate::__value_array!([] $($tt)*)) };
    ({ $($tt:tt)* }) => { $crate::Value::Map($crate::__value_object!([] $($tt)*)) };
    ($e:expr) => { $crate::ToValue::to_value(&$e) };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __value_array {
    ([$($out:expr,)*]) => { vec![$($out,)*] };
    ([$($out:expr,)*] null $(, $($rest:tt)*)?) => {
        $crate::__value_array!([$($out,)* $crate::Value::Null,] $($($rest)*)?)
    };
    ([$($out:expr,)*] [$($a:tt)*] $(, $($rest:tt)*)?) => {
        $crate::__value_array!([$($out,)* $crate::value!([$($a)*]),] $($($rest)*)?)
    };
    ([$($out:expr,)*] {$($a:tt)*} $(, $($rest:tt)*)?) => {
        $crate::__value_array!([$($out,)* $crate::value!({$($a)*}),] $($($rest)*)?)
    };
    ([$($out:expr,)*] $e:expr $(, $($rest:tt)*)?) => {
        $crate::__value_array!([$($out,)* $crate::value!($e),] $($($rest)*)?)
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __value_object {
    ([$($out:expr,)*]) => { vec![$($out,)*] };
    ([$($out:expr,)*] $k:literal : $($rest:tt)*) => {
        $crate::__value_entry!([$($out,)*] ($crate::Value::Text($k.into())) $($rest)*)
    };
    ([$($out:expr,)*] ($k:expr) : $($rest:tt)*) => {
        $crate::__value_entry!([$($out,)*] ($crate::Value::Text(($k).into())) $($rest)*)
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __value_entry {
    ([$($out:expr,)*] ($k:expr) null $(, $($rest:tt)*)?) => {
        $crate::__value_object!([$($out,)* ($k, $crate::Value::Null),] $($($rest)*)?)
    };
    ([$($out:expr,)*] ($k:expr) [$($a:tt)*] $(, $($rest:tt)*)?) => {
        $crate::__value_object!([$($out,)* ($k, $crate::value!([$($a)*])),] $($($rest)*)?)
    };
    ([$($out:expr,)*] ($k:expr) {$($a:tt)*} $(, $($rest:tt)*)?) => {
        $crate::__value_object!([$($out,)* ($k, $crate::value!({$($a)*})),] $($($rest)*)?)
    };
    ([$($out:expr,)*] ($k:expr) $e:expr $(, $($rest:tt)*)?) => {
        $crate::__value_object!([$($out,)* ($k, $crate::value!($e)),] $($($rest)*)?)
    };
}

#[cfg(test)]
mod value_macro_tests {
    use crate::json;
    use crate::value::Value;

    #[test]
    fn json_like_construction() {
        let name = String::from("n");
        let none: Option<u32> = None;
        let key = "dyn";
        let v = crate::value!({
            "a": 1,
            "b": [true, null, { "c": name.clone() }, [], {}],
            "d": none,
            "e": vec![1u8, 2],
            (key): -2.5,
            "f": format!("{}x", 1),
        });
        assert_eq!(
            json::to_string(&v),
            r#"{"a":1,"b":[true,null,{"c":"n"},[],{}],"d":null,"e":{"$base64":"AQI="},"dyn":-2.5,"f":"1x"}"#
        );
        assert_eq!(crate::value!(null), Value::Null);
        assert_eq!(crate::value!([]), Value::Array(vec![]));
    }
}
