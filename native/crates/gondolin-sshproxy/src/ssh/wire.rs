//! SSH data type encoding (RFC 4251 section 5).

use super::Error;

/// Reads SSH data types from a byte slice; every read is bounds checked.
#[derive(Debug, Clone)]
pub struct Reader<'a> {
    buf: &'a [u8],
}

fn short() -> Error {
    Error::Protocol("truncated message".into())
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Reader<'a> {
        Reader { buf }
    }

    pub fn remaining(&self) -> &'a [u8] {
        self.buf
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8], Error> {
        if self.buf.len() < n {
            return Err(short());
        }
        let (head, tail) = self.buf.split_at(n);
        self.buf = tail;
        Ok(head)
    }

    pub fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.bytes(1)?[0])
    }

    pub fn bool(&mut self) -> Result<bool, Error> {
        Ok(self.u8()? != 0)
    }

    pub fn u32(&mut self) -> Result<u32, Error> {
        let b = self.bytes(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn u64(&mut self) -> Result<u64, Error> {
        let b = self.bytes(8)?;
        Ok(u64::from_be_bytes(b.try_into().map_err(|_| short())?))
    }

    /// A `string` (length-prefixed bytes).
    pub fn string(&mut self) -> Result<&'a [u8], Error> {
        let n = self.u32()? as usize;
        self.bytes(n)
    }

    /// A `string` that must be UTF-8.
    pub fn utf8(&mut self) -> Result<&'a str, Error> {
        std::str::from_utf8(self.string()?).map_err(|_| Error::Protocol("invalid utf-8".into()))
    }

    /// A `string` decoded lossily (names, messages from peers).
    pub fn text(&mut self) -> Result<String, Error> {
        Ok(String::from_utf8_lossy(self.string()?).into_owned())
    }

    /// An `mpint`, returned as unsigned big-endian magnitude without leading zeros.
    pub fn mpint(&mut self) -> Result<&'a [u8], Error> {
        let mut b = self.string()?;
        if b.first().is_some_and(|x| x & 0x80 != 0) {
            return Err(Error::Protocol("negative mpint".into()));
        }
        while let [0, rest @ ..] = b {
            b = rest;
        }
        Ok(b)
    }

    /// A `name-list`.
    pub fn name_list(&mut self) -> Result<Vec<String>, Error> {
        let s = self.utf8()?;
        if s.is_empty() {
            return Ok(Vec::new());
        }
        Ok(s.split(',').map(str::to_string).collect())
    }
}

/// Appends SSH data types to a byte vector.
#[derive(Debug, Default, Clone)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Writer {
        Writer { buf: Vec::new() }
    }

    /// Starts a message with its type byte.
    pub fn msg(kind: u8) -> Writer {
        Writer { buf: vec![kind] }
    }

    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }

    pub fn bool(&mut self, v: bool) -> &mut Self {
        self.u8(v as u8)
    }

    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn raw(&mut self, v: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(v);
        self
    }

    pub fn string(&mut self, v: impl AsRef<[u8]>) -> &mut Self {
        let v = v.as_ref();
        self.u32(v.len() as u32);
        self.buf.extend_from_slice(v);
        self
    }

    /// An `mpint` from an unsigned big-endian magnitude.
    pub fn mpint(&mut self, v: &[u8]) -> &mut Self {
        let mut v = v;
        while let [0, rest @ ..] = v {
            v = rest;
        }
        if v.first().is_some_and(|x| x & 0x80 != 0) {
            self.u32(v.len() as u32 + 1);
            self.buf.push(0);
        } else {
            self.u32(v.len() as u32);
        }
        self.buf.extend_from_slice(v);
        self
    }

    pub fn name_list<S: AsRef<str>>(&mut self, names: &[S]) -> &mut Self {
        let joined: Vec<&str> = names.iter().map(|s| s.as_ref()).collect();
        self.string(joined.join(","))
    }

    pub fn finish(self) -> Vec<u8> {
        self.buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mpint_rfc4251_examples() {
        let mut w = Writer::new();
        w.mpint(&[]).mpint(&[0x09, 0xa3, 0x78, 0xf9, 0xb2, 0xe3, 0x32, 0xa7]).mpint(&[0x80]);
        assert_eq!(
            w.buf,
            [
                0, 0, 0, 0, 0, 0, 0, 8, 0x09, 0xa3, 0x78, 0xf9, 0xb2, 0xe3, 0x32, 0xa7, 0, 0, 0, 2,
                0, 0x80
            ]
        );
        let mut r = Reader::new(&w.buf);
        assert_eq!(r.mpint().unwrap(), &[] as &[u8]);
        assert_eq!(r.mpint().unwrap().len(), 8);
        assert_eq!(r.mpint().unwrap(), &[0x80]);
        assert!(r.u8().is_err());
    }

    #[test]
    fn name_lists() {
        let mut w = Writer::new();
        w.name_list(&["a", "b"]).name_list::<&str>(&[]);
        let mut r = Reader::new(&w.buf);
        assert_eq!(r.name_list().unwrap(), vec!["a", "b"]);
        assert!(r.name_list().unwrap().is_empty());
    }
}
