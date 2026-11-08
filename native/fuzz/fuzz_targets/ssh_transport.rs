//! SSH protocol core (sans-io): (a) raw bytes into a fresh client or server
//! transport (identification line, unencrypted KEXINIT / ECDH packets), and
//! (b) arbitrary payloads, properly encrypted after a real handshake, into
//! the peer's connection layer (userauth, channels, windows, requests).
#![no_main]

use arbitrary::Arbitrary;
use gondolin_sshproxy::ssh::PrivateKey;
use gondolin_sshproxy::ssh::connection::{ConnEvent, Connection, ConnectionConfig};
use gondolin_sshproxy::ssh::transport::{Transport, TransportConfig};
use libfuzzer_sys::fuzz_target;

#[derive(Arbitrary, Debug)]
struct Input {
    server: bool,
    raw: Vec<u8>,
    messages: Vec<Vec<u8>>,
}

fn endpoint(server: bool) -> Connection {
    let cfg = if server {
        TransportConfig::server(
            "SSH-2.0-fuzz-server",
            vec![PrivateKey::from_ed25519_seed(&[9; 32])],
        )
    } else {
        TransportConfig::client("SSH-2.0-fuzz-client")
    };
    let cfg_conn = ConnectionConfig { window: 64 * 1024, max_packet: 32 * 1024, max_channels: 8 };
    Connection::new(Transport::new(cfg).unwrap(), cfg_conn)
}

/// Delivers what `from` wrote to `to` and handles `to`'s events like an
/// application would; `false` once `to` failed.
fn deliver(from: &mut Connection, to: &mut Connection) -> bool {
    let out = from.take_output();
    to.input(&out);
    loop {
        match to.poll() {
            Ok(Some(ConnEvent::AuthRequest(_))) => {
                let _ = to.auth_reply(true);
            }
            Ok(Some(ConnEvent::Channel(id, m))) => {
                use gondolin_sshproxy::ssh::connection::ChannelMsg;
                match m {
                    ChannelMsg::Data(d) | ChannelMsg::ExtendedData { data: d, .. } => {
                        let _ = to.consumed(id, d.len());
                        let _ = to.send_data(id, None, &d);
                    }
                    ChannelMsg::Request { want_reply: true, .. } => {
                        let _ = to.reply(id, true);
                    }
                    ChannelMsg::Eof => {
                        let _ = to.eof(id);
                    }
                    _ => {}
                }
            }
            Ok(Some(_)) => {}
            Ok(None) => return true,
            Err(_) => return false,
        }
    }
}

fuzz_target!(|input: Input| {
    // (a) raw bytes into a fresh endpoint
    let mut fresh = endpoint(input.server);
    let ident: &[u8] = if input.server { b"SSH-2.0-peer\r\n" } else { b"SSH-2.0-peer\r\n" };
    fresh.input(ident);
    fresh.input(&input.raw);
    while let Ok(Some(_)) = fresh.poll() {}
    let _ = fresh.take_output();

    // (b) a real handshake, then fuzzed payloads to one side
    let mut client = endpoint(false);
    let mut server = endpoint(true);
    for _ in 0..8 {
        deliver(&mut client, &mut server);
        deliver(&mut server, &mut client);
    }
    if !(client.transport.is_ready() && server.transport.is_ready()) {
        panic!("handshake failed");
    }
    let _ = client.request_service("ssh-userauth");
    let _ = client.auth_none("fuzz");
    let _ = client.open_channel("session", &[]);
    for _ in 0..4 {
        deliver(&mut client, &mut server);
        deliver(&mut server, &mut client);
    }
    let (sender, receiver) =
        if input.server { (&mut client, &mut server) } else { (&mut server, &mut client) };
    for m in input.messages.iter().take(64) {
        if m.is_empty() || sender.transport.send(m.clone()).is_err() {
            continue;
        }
        if !deliver(sender, receiver) {
            break;
        }
        // replies go back (window adjusts, request replies)
        if !deliver(receiver, sender) {
            break;
        }
    }
});
