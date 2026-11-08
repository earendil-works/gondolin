//! The dynamic value shared by the CBOR ([`crate::cbor`]) and JSON
//! ([`crate::json`]) codecs.

use std::fmt;

/// A CBOR (or JSON) data item.
///
/// Maps keep their order and may contain duplicate keys (lookups through
/// [`Value::get`] and the typed conversions take the first, like the guest's
/// decoder; JSON parsing folds duplicates like `JSON.parse`).
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    /// CBOR major types 0 and 1 (`-2^64 ..= 2^64-1`); JSON integers
    Integer(i128),
    Float(f64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Value>),
    Map(Vec<(Value, Value)>),
}

impl Value {
    /// An empty map.
    pub fn map() -> Value {
        Value::Map(Vec::new())
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_integer(&self) -> Option<i128> {
        match self {
            Value::Integer(i) => Some(*i),
            _ => None,
        }
    }

    /// Numbers as `f64` (integers converted).
    pub fn as_float(&self) -> Option<f64> {
        match self {
            Value::Float(f) => Some(*f),
            Value::Integer(i) => Some(*i as f64),
            _ => None,
        }
    }

    pub fn as_bytes(&self) -> Option<&Vec<u8>> {
        match self {
            Value::Bytes(b) => Some(b),
            _ => None,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            Value::Text(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&Vec<(Value, Value)>> {
        match self {
            Value::Map(m) => Some(m),
            _ => None,
        }
    }

    pub fn as_map_mut(&mut self) -> Option<&mut Vec<(Value, Value)>> {
        match self {
            Value::Map(m) => Some(m),
            _ => None,
        }
    }

    pub fn into_bytes(self) -> Result<Vec<u8>, Value> {
        match self {
            Value::Bytes(b) => Ok(b),
            other => Err(other),
        }
    }

    pub fn into_text(self) -> Result<String, Value> {
        match self {
            Value::Text(s) => Ok(s),
            other => Err(other),
        }
    }

    pub fn into_array(self) -> Result<Vec<Value>, Value> {
        match self {
            Value::Array(a) => Ok(a),
            other => Err(other),
        }
    }

    pub fn into_map(self) -> Result<Vec<(Value, Value)>, Value> {
        match self {
            Value::Map(m) => Ok(m),
            other => Err(other),
        }
    }

    /// The value of the first entry with text key `key` (maps only).
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_map()?.iter().find(|(k, _)| k.as_text() == Some(key)).map(|(_, v)| v)
    }

    /// Mutable [`Value::get`].
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.as_map_mut()?.iter_mut().find(|(k, _)| k.as_text() == Some(key)).map(|(_, v)| v)
    }

    /// Sets text key `key` (replacing the first entry with that key, else
    /// appending). No-op for non-maps.
    pub fn insert(&mut self, key: &str, value: impl Into<Value>) {
        let value = value.into();
        if let Some(map) = self.as_map_mut() {
            match map.iter_mut().find(|(k, _)| k.as_text() == Some(key)) {
                Some(entry) => entry.1 = value,
                None => map.push((Value::Text(key.into()), value)),
            }
        }
    }

    /// Removes every entry with text key `key`; returns the first value.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let map = self.as_map_mut()?;
        let mut first = None;
        map.retain_mut(|(k, v)| {
            if k.as_text() == Some(key) {
                if first.is_none() {
                    first = Some(std::mem::take(v));
                }
                false
            } else {
                true
            }
        });
        first
    }

    /// Alias of [`Value::as_text`] (serde_json naming).
    pub fn as_str(&self) -> Option<&str> {
        self.as_text()
    }

    /// Integers within `u64`.
    pub fn as_u64(&self) -> Option<u64> {
        self.as_integer().and_then(|i| u64::try_from(i).ok())
    }

    /// Integers within `i64`.
    pub fn as_i64(&self) -> Option<i64> {
        self.as_integer().and_then(|i| i64::try_from(i).ok())
    }

    /// A short type name for error messages.
    pub fn kind(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::Integer(_) => "integer",
            Value::Float(_) => "float",
            Value::Bytes(_) => "bytes",
            Value::Text(_) => "text",
            Value::Array(_) => "array",
            Value::Map(_) => "map",
        }
    }
}

impl std::ops::Index<&str> for Value {
    type Output = Value;

    /// The first entry with key `key`, or `Null` (like `serde_json`'s index).
    fn index(&self, key: &str) -> &Value {
        static NULL: Value = Value::Null;
        self.get(key).unwrap_or(&NULL)
    }
}

impl std::ops::IndexMut<&str> for Value {
    /// The first entry with key `key`, inserting `Null` when absent (turns a
    /// `Null` into a map first, like `serde_json`).
    fn index_mut(&mut self, key: &str) -> &mut Value {
        if self.is_null() {
            *self = Value::map();
        }
        let Value::Map(map) = self else { panic!("cannot index a {} with a key", self.kind()) };
        let pos = match map.iter().position(|(k, _)| k.as_text() == Some(key)) {
            Some(pos) => pos,
            None => {
                map.push((Value::Text(key.into()), Value::Null));
                map.len() - 1
            }
        };
        &mut map[pos].1
    }
}

impl fmt::Display for Value {
    /// Compact JSON (byte strings as `{"$base64": ...}`).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&crate::json::to_string(self))
    }
}

macro_rules! from_int {
    ($($t:ty),*) => {$(
        impl From<$t> for Value {
            fn from(v: $t) -> Value {
                Value::Integer(v as i128)
            }
        }
    )*};
}
from_int!(u8, u16, u32, u64, usize, i8, i16, i32, i64, isize, i128);

impl From<bool> for Value {
    fn from(v: bool) -> Value {
        Value::Bool(v)
    }
}

impl From<f64> for Value {
    fn from(v: f64) -> Value {
        Value::Float(v)
    }
}

impl From<&str> for Value {
    fn from(v: &str) -> Value {
        Value::Text(v.into())
    }
}

impl From<String> for Value {
    fn from(v: String) -> Value {
        Value::Text(v)
    }
}

impl From<&String> for Value {
    fn from(v: &String) -> Value {
        Value::Text(v.clone())
    }
}

impl From<Vec<u8>> for Value {
    fn from(v: Vec<u8>) -> Value {
        Value::Bytes(v)
    }
}

impl From<Vec<Value>> for Value {
    fn from(v: Vec<Value>) -> Value {
        Value::Array(v)
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(v: Option<T>) -> Value {
        v.map_or(Value::Null, Into::into)
    }
}
