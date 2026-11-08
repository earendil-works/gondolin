//! `json::to_string`/`to_string_pretty` against node's `JSON.stringify` (and
//! `json::parse` against `JSON.parse`) over a generated corpus. Skipped when
//! `node` is not installed.

use std::io::Write;
use std::process::{Command, Stdio};

use gondolin_wire::Value;
use gondolin_wire::json;

/// xorshift64*
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn string(r: &mut Rng) -> String {
    const POOL: &[&str] = &[
        "a", "Z", " ", "\"", "\\", "/", "\n", "\r", "\t", "\u{0}", "\u{1f}", "\u{7f}", "é", "€",
        "😀", "\u{2028}", "\u{fffd}", "{", "]", ":", ",",
    ];
    (0..r.below(8)).map(|_| POOL[r.below(POOL.len() as u64) as usize]).collect()
}

fn float(r: &mut Rng) -> f64 {
    match r.below(6) {
        0 => f64::from_bits(r.next()),
        1 => (r.next() as i64 as f64) / 1e3,
        2 => 10f64.powi(r.below(60) as i32 - 30) * (r.below(1000) as f64 + 0.5),
        3 => r.below(1000) as f64 / 7.0,
        4 => -(r.below(1 << 20) as f64) * 1e-9,
        _ => 1e21 * r.below(10) as f64,
    }
}

fn value(r: &mut Rng, depth: u32) -> Value {
    let pick = if depth > 3 { r.below(5) } else { r.below(7) };
    match pick {
        0 => Value::Null,
        1 => Value::Bool(r.below(2) == 0),
        2 => {
            // safe integers only (JavaScript numbers)
            let n = (r.next() % (1 << 53)) as i128;
            Value::Integer(if r.below(2) == 0 { n } else { -n })
        }
        3 => {
            let f = float(r);
            if f.is_finite() { Value::Float(f) } else { Value::Float(0.25) }
        }
        4 => Value::Text(string(r)),
        5 => Value::Array((0..r.below(4)).map(|_| value(r, depth + 1)).collect()),
        _ => {
            let mut map: Vec<(Value, Value)> = Vec::new();
            for _ in 0..r.below(4) {
                let k = string(r);
                // JSON objects have unique keys, and node orders integer-like keys first
                if map.iter().any(|(e, _)| e.as_text() == Some(&k))
                    || (!k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()))
                {
                    continue;
                }
                map.push((Value::Text(k), value(r, depth + 1)));
            }
            Value::Map(map)
        }
    }
}

#[test]
fn stringify_and_parse_match_node() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node not installed: skipped");
        return;
    }
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    let corpus: Vec<Value> = (0..3000).map(|_| value(&mut r, 0)).collect();
    // one compact document per line for node
    let input: String = corpus.iter().map(|v| json::to_string(v) + "\n").collect();
    let mut child = Command::new("node")
        .arg("-e")
        .arg(
            "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d).on('end',()=>{\
             const out=s.split('\\n').filter(Boolean).map(l=>{const v=JSON.parse(l);\
             return [JSON.stringify(v),JSON.stringify(v,null,2)]});\
             process.stdout.write(JSON.stringify(out))})",
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let results = json::parse(std::str::from_utf8(&out.stdout).unwrap()).unwrap();
    let results = results.as_array().unwrap();
    assert_eq!(results.len(), corpus.len());
    for (v, res) in corpus.iter().zip(results) {
        let pair = res.as_array().unwrap();
        let compact = pair[0].as_text().unwrap();
        let pretty = pair[1].as_text().unwrap();
        assert_eq!(json::to_string(v), compact, "compact differs for {v:?}");
        assert_eq!(json::to_string_pretty(v), pretty, "pretty differs for {v:?}");
        // node's output parses back to the same document
        assert_eq!(json::to_string(&json::parse(pretty).unwrap()), compact);
    }
}
