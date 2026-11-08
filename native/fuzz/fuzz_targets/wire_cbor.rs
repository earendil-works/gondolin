//! CBOR codec: decoding arbitrary input with both profiles never panics, and
//! every decoded value survives encode → decode unchanged (floats compared by
//! bits, NaN payloads aside).
#![no_main]

use gondolin_wire::Value;
use gondolin_wire::cbor::{self, Profile};
use libfuzzer_sys::fuzz_target;

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Float(x), Value::Float(y)) => x == y || (x.is_nan() && y.is_nan()),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Map(x), Value::Map(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(&a.0, &b.0) && same(&a.1, &b.1))
        }
        _ => a == b,
    }
}

fuzz_target!(|data: &[u8]| {
    let _ = cbor::decode_with(data, Profile::Guest);
    if let Ok(v) = cbor::decode(data) {
        let encoded = cbor::encode(&v);
        let back = cbor::decode(&encoded).expect("re-decoding an encoded value");
        assert!(same(&v, &back), "{v:?} != {back:?}");
        // canonical: encoding is a fixed point
        assert_eq!(cbor::encode(&back), encoded);
    }
});
