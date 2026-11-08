//! JSON codec: parsing arbitrary text never panics, and printed values
//! (compact and pretty) parse back to the same printout.
#![no_main]

use gondolin_wire::json;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else { return };
    if let Ok(v) = json::parse(text) {
        let compact = json::to_string(&v);
        let pretty = json::to_string_pretty(&v);
        let a = json::parse(&compact).expect("parsing printed JSON");
        let b = json::parse(&pretty).expect("parsing pretty JSON");
        assert_eq!(json::to_string(&a), compact);
        assert_eq!(json::to_string(&b), compact);
    }
});
