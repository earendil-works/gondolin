//! TLS ClientHello sniffing as egress does it (rustls `Acceptor`, server name
//! extraction) on arbitrary guest bytes.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let mut acceptor = rustls::server::Acceptor::default();
    let mut rest = data;
    while !rest.is_empty() {
        match acceptor.read_tls(&mut rest) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        match acceptor.accept() {
            Ok(Some(accepted)) => {
                let hello = accepted.client_hello();
                let _ = hello.server_name().map(str::len);
                let _ = hello.alpn().map(|a| a.count());
                break;
            }
            Ok(None) => continue,
            Err(_) => break,
        }
    }
    let _ = gondolin_egress::classify(data, false);
});
