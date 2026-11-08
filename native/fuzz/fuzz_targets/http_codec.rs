//! gondolin-http's sans-io core on arbitrary bytes: request/response head
//! parsing and framing rules, head re-encoding round trips, and body decoding
//! (Content-Length, chunked, close-delimited) with arbitrary input splits
//! that must not change the result.
#![no_main]

use bytes::BytesMut;
use gondolin_http::decode::{Decoded, Decoder};
use gondolin_http::head::{
    self, BodyLength, Framing, HeadLimits, encode_request, encode_response, parse_request,
    parse_response, request_info, response_info,
};
use libfuzzer_sys::fuzz_target;

const LIMITS: HeadLimits = HeadLimits { max_bytes: 16 * 1024, max_headers: 64 };

/// Decodes `input` fed in pieces of `step` bytes; `Err` on framing errors.
fn decode(framing: Framing, input: &[u8], step: usize) -> Result<(Vec<u8>, usize), ()> {
    let mut dec = Decoder::new(framing);
    let mut buf = BytesMut::new();
    let mut out = Vec::new();
    let mut pos = 0;
    loop {
        match dec.decode(&mut buf).map_err(|_| ())? {
            Decoded::Data(d) => {
                assert!(!d.is_empty());
                out.extend_from_slice(&d);
            }
            Decoded::Done => return Ok((out, pos - buf.len())),
            Decoded::NeedMore => {
                if pos >= input.len() {
                    dec.eof().map_err(|_| ())?;
                    continue;
                }
                let end = (pos + step).min(input.len());
                buf.extend_from_slice(&input[pos..end]);
                pos = end;
            }
        }
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&ctl, data)) = data.split_first() else {
        return;
    };
    let step = usize::from(ctl >> 2) + 1;

    if let Ok(Some((mut req, used))) = parse_request(data, &LIMITS) {
        assert!(used <= data.len());
        let method = req.method.clone();
        if let Ok(info) = request_info(&mut req) {
            // the request re-encodes to a head that parses to the same request
            let mut out = Vec::new();
            let body = match info.framing {
                Framing::Length(0) => BodyLength::Empty,
                Framing::Length(n) => BodyLength::Known(n),
                _ => BodyLength::Unknown,
            };
            encode_request(&mut out, &method, &req.target, &req.headers, body);
            let (again, n) =
                parse_request(&out, &HeadLimits { max_bytes: 1 << 20, max_headers: 1 << 10 })
                    .expect("re-encoded head parses")
                    .expect("re-encoded head is complete");
            assert_eq!(n, out.len());
            assert_eq!(again.method, method);
            assert_eq!(again.target, req.target);
            // the body after the head decodes the same in any split
            let rest = &data[used..];
            let whole = decode(info.framing, rest, rest.len().max(1));
            assert_eq!(whole, decode(info.framing, rest, step));
        }
        let mut out = Vec::new();
        let enc = encode_response(
            &mut out,
            req.version,
            200,
            None,
            &req.headers,
            method == "HEAD",
            BodyLength::Unknown,
        );
        let (resp, n) =
            parse_response(&out, &HeadLimits { max_bytes: 1 << 20, max_headers: 1 << 10 })
                .expect("encoded response parses")
                .expect("encoded response is complete");
        assert_eq!(n, out.len());
        let info =
            response_info(&resp, &method).expect("encoded response framing is valid").unwrap();
        if method != "HEAD" {
            assert_eq!(info.framing, enc.framing);
        }
    }

    if let Ok(Some((resp, used))) = parse_response(data, &LIMITS) {
        let method = if ctl & 1 == 1 { "HEAD" } else { "GET" };
        if let Ok(Some(info)) = response_info(&resp, method) {
            let rest = &data[used..];
            let whole = decode(info.framing, rest, rest.len().max(1));
            assert_eq!(whole, decode(info.framing, rest, step));
        }
        let _ = head::canonical_reason(resp.status);
    }

    // raw body decoding
    let framing = match ctl & 3 {
        0 => Framing::Chunked,
        1 => Framing::Close,
        _ => Framing::Length(u64::from(ctl)),
    };
    let whole = decode(framing, data, data.len().max(1));
    assert_eq!(whole, decode(framing, data, step));
});
