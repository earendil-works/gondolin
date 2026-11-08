//! Lenient access to CBOR maps: guest frames and client messages are validated
//! field by field (like the JavaScript engine does) instead of failing a whole
//! message on the first unexpected type.

use gondolin_wire::Value;

/// A view over a CBOR map (an empty view for non-maps).
#[derive(Clone, Copy)]
pub struct Fields<'a>(&'a [(Value, Value)]);

const EMPTY: &[(Value, Value)] = &[];

impl<'a> Fields<'a> {
    pub fn of(v: &'a Value) -> Self {
        Fields(v.as_map().map(Vec::as_slice).unwrap_or(EMPTY))
    }

    pub fn is_map(v: &Value) -> bool {
        v.as_map().is_some()
    }

    /// The value of `key`; `None` when absent. `null` counts as present.
    pub fn get(&self, key: &str) -> Option<&'a Value> {
        self.0.iter().find(|(k, _)| k.as_text() == Some(key)).map(|(_, v)| v)
    }

    /// `get` with `null` treated as absent (`message.x ?? default`).
    pub fn get_some(&self, key: &str) -> Option<&'a Value> {
        self.get(key).filter(|v| !v.is_null())
    }

    pub fn text(&self, key: &str) -> Option<&'a str> {
        self.get(key).and_then(Value::as_text)
    }

    pub fn bytes(&self, key: &str) -> Option<&'a [u8]> {
        self.get(key).and_then(|v| v.as_bytes()).map(Vec::as_slice)
    }

    pub fn bool(&self, key: &str) -> Option<bool> {
        self.get(key).and_then(Value::as_bool)
    }

    /// JavaScript truthiness of the field (`Boolean(message.x)`).
    pub fn truthy(&self, key: &str) -> bool {
        self.get(key).is_some_and(truthy)
    }

    /// An integer field as `i128` (floats with an integral value count too).
    pub fn int(&self, key: &str) -> Option<i128> {
        self.get(key).and_then(as_int)
    }

    /// A finite number (integer or float).
    pub fn number(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(as_number)
    }
}

/// JavaScript truthiness for CBOR values.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Integer(i) => (*i) != 0,
        Value::Float(f) => *f != 0.0 && !f.is_nan(),
        Value::Text(t) => !t.is_empty(),
        _ => true,
    }
}

/// Integer value (floats with an integral value count, like JS numbers).
pub fn as_int(v: &Value) -> Option<i128> {
    match v {
        Value::Integer(i) => Some(*i),
        Value::Float(f)
            if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 =>
        {
            Some(*f as i128)
        }
        _ => None,
    }
}

/// Finite numeric value.
pub fn as_number(v: &Value) -> Option<f64> {
    match v {
        Value::Integer(i) => Some((*i) as f64),
        Value::Float(f) if f.is_finite() => Some(*f),
        _ => None,
    }
}

/// `isValidRequestId`: an integer in `0..=u32::MAX`.
pub fn request_id(v: Option<&Value>) -> Option<u32> {
    v.and_then(as_int).and_then(|i| u32::try_from(i).ok())
}

/// A list of strings (`None` when not an array of text).
pub fn string_list(v: &Value) -> Option<Vec<String>> {
    v.as_array()?.iter().map(|e| e.as_text().map(str::to_string)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lenient_access() {
        let v = Value::Map(vec![
            (Value::Text("id".into()), Value::Float(3.0)),
            (Value::Text("bad".into()), Value::Float(1.5)),
            (Value::Text("neg".into()), Value::Integer((-1).into())),
            (Value::Text("n".into()), Value::Null),
            (Value::Text("s".into()), Value::Text("".into())),
        ]);
        let f = Fields::of(&v);
        assert_eq!(request_id(f.get("id")), Some(3));
        assert_eq!(request_id(f.get("bad")), None);
        assert_eq!(request_id(f.get("neg")), None);
        assert!(f.get("n").is_some());
        assert!(f.get_some("n").is_none());
        assert!(!f.truthy("s"));
        assert!(f.truthy("id"));
        assert_eq!(f.number("bad"), Some(1.5));
        assert!(Fields::of(&Value::Null).get("id").is_none());
    }
}
