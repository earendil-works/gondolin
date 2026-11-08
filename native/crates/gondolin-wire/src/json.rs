//! JSON (RFC 8259) parser and printers for [`Value`].
//!
//! - Parsing: objects become maps with text keys in input order (a repeated
//!   key keeps its first position and takes the last value, like
//!   `JSON.parse`); integers without fraction or exponent stay exact
//!   ([`Value::Integer`], also beyond 2^53), other numbers are `f64`; `\u`
//!   escapes combine surrogate pairs (a lone surrogate becomes U+FFFD).
//! - Printing: [`to_string`] / [`to_string_pretty`] produce exactly what
//!   `JSON.stringify(v)` / `JSON.stringify(v, null, 2)` produce for the same
//!   data (number formatting, escapes, layout); non-finite floats print as
//!   `null`, byte strings as `{"$base64": "..."}`, non-text map keys as their
//!   JSON text. Integers beyond 2^53 print exactly (JavaScript would round).

use std::fmt::{self, Write as _};

use crate::value::Value;

/// Maximum nesting depth when parsing.
pub const MAX_DEPTH: usize = 128;

/// A JSON syntax error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonError {
    /// byte offset in the input
    pub offset: usize,
    pub message: &'static str,
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at position {}", self.message, self.offset)
    }
}

impl std::error::Error for JsonError {}

/// Parses one JSON text (surrounding whitespace allowed, nothing else).
pub fn parse(text: &str) -> Result<Value, JsonError> {
    let mut p = Parser { s: text.as_bytes(), pos: 0 };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.pos != p.s.len() {
        return p.err("unexpected trailing characters");
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    pos: usize,
}

impl Parser<'_> {
    fn err<T>(&self, message: &'static str) -> Result<T, JsonError> {
        Err(JsonError { offset: self.pos, message })
    }

    fn ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.s.get(self.pos) {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.pos).copied()
    }

    fn lit(&mut self, word: &str, v: Value) -> Result<Value, JsonError> {
        if self.s[self.pos..].starts_with(word.as_bytes()) {
            self.pos += word.len();
            Ok(v)
        } else {
            self.err("invalid literal")
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, JsonError> {
        if depth > MAX_DEPTH {
            return self.err("nesting too deep");
        }
        match self.peek() {
            None => self.err("unexpected end of input"),
            Some(b'n') => self.lit("null", Value::Null),
            Some(b't') => self.lit("true", Value::Bool(true)),
            Some(b'f') => self.lit("false", Value::Bool(false)),
            Some(b'"') => self.string().map(Value::Text),
            Some(b'[') => {
                self.pos += 1;
                let mut out = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.pos += 1;
                    return Ok(Value::Array(out));
                }
                loop {
                    self.ws();
                    out.push(self.value(depth + 1)?);
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.pos += 1,
                        Some(b']') => {
                            self.pos += 1;
                            return Ok(Value::Array(out));
                        }
                        _ => return self.err("expected ',' or ']'"),
                    }
                }
            }
            Some(b'{') => {
                self.pos += 1;
                let mut out: Vec<(Value, Value)> = Vec::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.pos += 1;
                    return Ok(Value::Map(out));
                }
                loop {
                    self.ws();
                    if self.peek() != Some(b'"') {
                        return self.err("expected a string key");
                    }
                    let key = self.string()?;
                    self.ws();
                    if self.peek() != Some(b':') {
                        return self.err("expected ':'");
                    }
                    self.pos += 1;
                    self.ws();
                    let v = self.value(depth + 1)?;
                    match out.iter_mut().find(|(k, _)| k.as_text() == Some(key.as_str())) {
                        Some(entry) => entry.1 = v,
                        None => out.push((Value::Text(key), v)),
                    }
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.pos += 1,
                        Some(b'}') => {
                            self.pos += 1;
                            return Ok(Value::Map(out));
                        }
                        _ => return self.err("expected ',' or '}'"),
                    }
                }
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => self.err("unexpected character"),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while let Some(b'0'..=b'9') = self.peek() {
            self.pos += 1;
        }
        self.pos - start
    }

    fn number(&mut self) -> Result<Value, JsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return self.err("invalid number"),
        }
        let mut integral = true;
        if self.peek() == Some(b'.') {
            integral = false;
            self.pos += 1;
            if self.digits() == 0 {
                return self.err("invalid number");
            }
        }
        if let Some(b'e' | b'E') = self.peek() {
            integral = false;
            self.pos += 1;
            if let Some(b'+' | b'-') = self.peek() {
                self.pos += 1;
            }
            if self.digits() == 0 {
                return self.err("invalid number");
            }
        }
        let text = std::str::from_utf8(&self.s[start..self.pos]).unwrap();
        if integral && let Ok(i) = text.parse::<i128>() {
            return Ok(Value::Integer(i));
        }
        Ok(Value::Float(text.parse::<f64>().unwrap_or(f64::NAN)))
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let Some(h) = self.s.get(self.pos..self.pos + 4) else {
            return self.err("invalid \\u escape");
        };
        let h = std::str::from_utf8(h).ok().filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()));
        let Some(n) = h.and_then(|h| u32::from_str_radix(h, 16).ok()) else {
            return self.err("invalid \\u escape");
        };
        self.pos += 4;
        Ok(n)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.pos += 1; // opening quote
        let mut out = String::new();
        loop {
            let run = self.pos;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.pos += 1;
            }
            // the input is a &str and runs end at ASCII bytes: valid UTF-8
            out.push_str(std::str::from_utf8(&self.s[run..self.pos]).unwrap());
            match self.peek() {
                None => return self.err("unterminated string"),
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    let Some(e) = self.peek() else { return self.err("unterminated string") };
                    self.pos += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let c = if (0xd800..0xdc00).contains(&hi) {
                                // a high surrogate: combine with a following low one
                                let save = self.pos;
                                if self.s[self.pos..].starts_with(b"\\u") {
                                    self.pos += 2;
                                    let lo = self.hex4()?;
                                    if (0xdc00..0xe000).contains(&lo) {
                                        char::from_u32(
                                            0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00),
                                        )
                                    } else {
                                        self.pos = save;
                                        None
                                    }
                                } else {
                                    None
                                }
                            } else {
                                char::from_u32(hi)
                            };
                            out.push(c.unwrap_or('\u{fffd}'));
                        }
                        _ => {
                            self.pos -= 1;
                            return self.err("invalid escape");
                        }
                    }
                }
                Some(_) => return self.err("control character in string"),
            }
        }
    }
}

/// `JSON.stringify(value)`.
pub fn to_string(value: &Value) -> String {
    let mut out = String::new();
    write(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub fn to_string_pretty(value: &Value) -> String {
    let mut out = String::new();
    write(&mut out, value, Some(2), 0);
    out
}

/// A JSON string literal for `s` (JavaScript's escaping).
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    write_str(&mut out, s);
    out
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// JavaScript's `Number.prototype.toString()` for finite numbers (`null`
/// otherwise, as `JSON.stringify` prints them).
pub fn format_number(x: f64) -> String {
    if !x.is_finite() {
        return "null".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x < 0.0 {
        return format!("-{}", format_number(-x));
    }
    // the number of shortest round-trip digits from Rust's `{:e}`, then the
    // k-digit decimal closest to x (ties to even, as ECMAScript requires;
    // the shortest-digits algorithm may pick the other neighbour)
    let shortest = format!("{x:e}");
    let k = shortest.split_once('e').unwrap().0.chars().filter(char::is_ascii_digit).count();
    let sci = format!("{x:.prec$e}", prec = k - 1);
    let (mantissa, exp) = sci.split_once('e').unwrap();
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap() + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n - 1 < 0 { '-' } else { '+' };
        let e = (n - 1).abs();
        if k == 1 {
            format!("{digits}e{sign}{e}")
        } else {
            format!("{}.{}e{sign}{e}", &digits[..1], &digits[1..])
        }
    }
}

fn key_text(k: &Value) -> String {
    match k {
        Value::Text(s) => s.clone(),
        other => to_string(other),
    }
}

fn newline(out: &mut String, indent: Option<usize>, level: usize) {
    if let Some(n) = indent {
        out.push('\n');
        out.extend(std::iter::repeat_n(' ', n * level));
    }
}

fn write(out: &mut String, v: &Value, indent: Option<usize>, level: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Integer(i) => {
            let _ = write!(out, "{i}");
        }
        Value::Float(f) => out.push_str(&format_number(*f)),
        Value::Text(s) => write_str(out, s),
        Value::Bytes(b) => {
            let obj = Value::Map(vec![(
                Value::Text("$base64".into()),
                Value::Text(crate::base64::encode(b)),
            )]);
            write(out, &obj, indent, level);
        }
        Value::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                write(out, item, indent, level + 1);
            }
            newline(out, indent, level);
            out.push(']');
        }
        Value::Map(m) => {
            if m.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, item)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                write_str(out, &key_text(k));
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write(out, item, indent, level + 1);
            }
            newline(out, indent, level);
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basics() {
        let v = parse(
            r#" {"a": [1, -2.5e3, true, null, "x\u00e9\ud83d\ude00\ud800"], "a": 2, "b": {}} "#,
        )
        .unwrap();
        assert_eq!(v["a"], Value::Integer(2));
        assert_eq!(v.as_map().unwrap().len(), 2);
        assert_eq!(v.as_map().unwrap()[0].0, Value::Text("a".into()));
        let v =
            parse(r#"[1, -2.5e3, "x\u00e9\ud83d\ude00\ud800", 12345678901234567890123]"#).unwrap();
        let a = v.as_array().unwrap();
        assert_eq!(a[1], Value::Float(-2500.0));
        assert_eq!(a[2], Value::Text("xé😀\u{fffd}".into()));
        assert_eq!(a[3], Value::Integer(12345678901234567890123));
        for bad in
            ["", "[1,]", "{\"a\" 1}", "01", "1.", "-", "\"\u{1}\"", "[1] x", "\"\\x\"", "tru"]
        {
            assert!(parse(bad).is_err(), "{bad}");
        }
        let deep = "[".repeat(MAX_DEPTH + 2);
        assert!(parse(&deep).is_err());
    }

    #[test]
    fn javascript_number_formatting() {
        for (x, s) in [
            (1.0, "1"),
            (-0.0, "0"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (-1.25e30, "-1.25e+30"),
            (5e-324, "5e-324"),
            (f64::NAN, "null"),
        ] {
            assert_eq!(format_number(x), s, "{x}");
        }
    }

    #[test]
    fn printing() {
        let v = parse(r#"{"a":[1,{"b":"\n\u0001\"é"}],"c":{},"d":[]}"#).unwrap();
        assert_eq!(to_string(&v), r#"{"a":[1,{"b":"\n\u0001\"é"}],"c":{},"d":[]}"#);
        assert_eq!(
            to_string_pretty(&v),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": \"\\n\\u0001\\\"é\"\n    }\n  ],\n  \"c\": {},\n  \"d\": []\n}"
        );
        assert_eq!(to_string(&Value::Bytes(b"hi".to_vec())), r#"{"$base64":"aGk="}"#);
    }
}
