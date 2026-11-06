# Russh

[![Crate](https://img.shields.io/crates/v/russh.svg)](https://crates.io/crates/russh) 
[![Docs](https://docs.rs/russh/badge.svg)](https://docs.rs/russh)

A low-level, `async` SSH 2.0 client and server library for Rust / Tokio.

Russh gives you direct access to the SSH protocol: channels, authentication, key exchange, port and socket forwarding.  It is written in safe Rust, uses async traits, and supports a broad range of algorithms for wide scale interoperability with real-world servers and clients.

- **Async-native** - integrates directly with Tokio,  `AsyncRead`/`AsyncWrite` channels
- **Broad interoperability** - safe algorithms by default, with opt-in support for legacy ones
- **Safety-focused** - panics, `unwrap`/`expect` and unchecked indexing are denied by default

## Getting started

Add russh to your `Cargo.toml`, choosing a crypto backend feature (see below):

```toml
[dependencies]
russh = { version = "0.63", features = ["aws-lc-rs"] }
tokio = { version = "1", features = ["full"] }
```

Then have a look at the examples:

- [simple client](russh/examples/client_exec_simple.rs)
- [interactive PTY client](russh/examples/client_exec_interactive.rs)
- [server](russh/examples/echoserver.rs)
- [SFTP client](russh/examples/sftp_client.rs)
- [SFTP server](russh/examples/sftp_server.rs)

API documentation is on [docs.rs](https://docs.rs/russh)

## Crypto backends

Russh requires exactly one crypto backend. Enable the `aws-lc-rs` or `ring` crate feature.

```toml
# aws-lc-rs (default in most setups)
russh = { version = "0.63", features = ["aws-lc-rs"] }

# or ring (keep `flate2` and `rsa` when disabling default features)
russh = { version = "0.63", default-features = false, features = ["ring", "flate2", "rsa"] }
```

## Supported algorithms

Russh aims for broad interoperability, so it supports both algorithms currently considered safe and a set of older ones that allow connections to older switches etc. Legacy algorithms are opt in.

### Key exchange

**Recommended**

- `mlkem768x25519-sha256` (post-quantum hybrid)
- `curve25519-sha256`, `curve25519-sha256@libssh.org`
- `diffie-hellman-group-exchange-sha256` (GEX)
- `diffie-hellman-group18-sha512`, `diffie-hellman-group17-sha512`, `diffie-hellman-group16-sha512`, `diffie-hellman-group15-sha512`
- `diffie-hellman-group14-sha256`
- OpenSSH strict key exchange (Terrapin mitigation)
- Programmatic group choice support for DH-GEX

**Legacy**

- `ecdh-sha2-nistp256`, `ecdh-sha2-nistp384`, `ecdh-sha2-nistp521`
- `diffie-hellman-group14-sha1`
- `diffie-hellman-group1-sha1`
- `diffie-hellman-group-exchange-sha1` (GEX)

### Ciphers

**Recommended**

- `chacha20-poly1305@openssh.com`
- `aes256-gcm@openssh.com`, `aes128-gcm@openssh.com`
- `aes256-ctr`, `aes192-ctr`, `aes128-ctr`

**Legacy**

- `aes256-cbc`, `aes192-cbc`, `aes128-cbc`
- `3des-cbc` (requires the `des` crate feature)

### MACs

**Recommended**

- `hmac-sha2-256-etm@openssh.com`, `hmac-sha2-512-etm@openssh.com`
- `hmac-sha2-256`, `hmac-sha2-512`

**Legacy**

- `hmac-sha1-etm@openssh.com`
- `hmac-sha1`

### Compression

- `none`
- `zlib`, `zlib@openssh.com` (requires the `flate2` crate feature, on by default)

### Host keys & public-key authentication

**Recommended**

- `ssh-ed25519`
- `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`
- `rsa-sha2-256`, `rsa-sha2-512`
- `ssh-rsa` (SHA-1)
- OpenSSH certificates

### Authentication methods

- `publickey`
- `password`
- `keyboard-interactive`
- `none`
- OpenSSH certificate authentication

## Features

- Local port forwarding (`direct-tcpip`)
- Remote port forwarding (`forward-tcpip`)
- Local UNIX socket forwarding (`direct-streamlocal`, client only)
- Remote UNIX socket forwarding (`forward-streamlocal`)
- `AsyncRead` / `AsyncWrite`-able channels
- OpenSSH agent forwarding channels
- OpenSSH keepalive request handling
- OpenSSH `server-sig-algs` extension
- PuTTY PPK key format
- Pageant support (Windows)

## Safety

Russh is built to withstand malicious/misbehaving peers. 

- `deny(clippy::unwrap_used)`
- `deny(clippy::expect_used)`
- `deny(clippy::indexing_slicing)`
- `deny(clippy::panic)`

Exceptions are reviewed and justified manually.

### Unsafe code

- `cryptovec` uses `unsafe` for faster copying, initialization, and binding to native APIs.

## Ecosystem

- [russh-sftp](https://crates.io/crates/russh-sftp) - server-side and client-side SFTP subsystem support for `russh`; see `russh/examples/sftp_server.rs` or `russh/examples/sftp_client.rs`.
- [async-ssh2-tokio](https://crates.io/crates/async-ssh2-tokio) - simple high-level API for running commands over SSH.

## Adopters

- [HexPatch](https://github.com/Etto48/HexPatch) - A binary patcher and editor written in Rust with a terminal user interface (TUI).
  - Uses `russh::client` and `russh_sftp::client` to allow remote editing of files.
- [kartoffels](https://github.com/Patryk27/kartoffels) - A game where you're given a potato and your job is to implement a firmware for it.
  - Uses `russh::server` to deliver the game, using `ratatui` as the rendering engine.
- [kty](https://github.com/grampelberg/kty) - The terminal for Kubernetes.
  - Uses `russh::server` to deliver the `ratatui` based TUI and `russh_sftp::server` to provide `scp` based file management.
- [lapdev](https://github.com/lapce/lapdev) - Self-hosted remote dev environment.
  - Uses `russh::server` to construct a proxy into your development environment.
- [medusa](https://github.com/evilsocket/medusa) - A fast and secure multi-protocol honeypot.
  - Uses `russh::server` to be the basis of the honeypot.
- [rebels-in-the-sky](https://github.com/ricott1/rebels-in-the-sky) - P2P terminal game about space pirates playing basketball across the galaxy.
  - Uses `russh::server` to deliver the game, using `ratatui` as the rendering engine.
- [warpgate](https://github.com/warp-tech/warpgate) - Smart SSH, HTTPS and MySQL bastion that requires no additional client-side software.
  - Uses `russh::server` in addition to `russh::client` as part of the smart SSH functionality.
- [Devolutions Gateway](https://github.com/Devolutions/devolutions-gateway/) - Establish a secure entry point for internal or external segmented networks that require authorized just-in-time (JIT) access.
  - Uses `russh::client` for the web-based SSH client of the standalone web application.
- [Sandhole](https://github.com/EpicEric/sandhole) - Expose HTTP/SSH/TCP services through SSH port forwarding. A reverse proxy that just works with an OpenSSH client.
  - Uses `russh::server` for reverse forwarding connections, local forwarding tunnels, and the `ratatui` based admin interface.
- [Motor OS](https://github.com/moturus/motor-os) - A new Rust-based operating system for VMs.
  - Uses `russh::server` as the base for its own [SSH Server](https://github.com/moturus/motor-os/tree/main/src/bin/russhd).
- [Cubic VM](https://github.com/cubic-vm/cubic) - A lightweight command-line manager for virtual machines.
  - Uses `russh::client` and `russh_sftp::client` to access the virtual machine instances.
- [ferrissh](https://crates.io/crates/ferrissh) - An async SSH CLI scraper library for network device automation in Rust.
  - Uses `russh::client` for SSH transport, authentication, and interactive PTY sessions.
- [Yazi](https://github.com/sxyazi/yazi) - Blazing fast terminal file manager written in Rust, based on async I/O.
  - Uses `russh::client` to implement an async SFTP provider for remote file management.
- [GitArena](https://github.com/mellowagain/gitarena) - Software development platform with built-in VCS, issue tracking and code review.
  - Uses `russh::server` to allow Git operations over SSH.
- [Calagopus](https://github.com/calagopus/wings) - Fast, efficient and scalable game hosting - built for everyone.
  - Uses `russh::server` for efficiently implementing SSH shells and SFTP file management.
- [Oryxis](https://github.com/wilsonglasser/oryxis) - Rust-native SSH client with an encrypted vault, P2P sync and an embedded terminal.
  - Uses `russh::client` for connections, jump hosts, SOCKS/HTTP/command proxies and SFTP.
- [react-native-ssh](https://github.com/osuki-dev/react-native-ssh) - Native SSH client for React Native and Expo.
  - Uses `russh::client` as the SSH transport implementation behind Nitro Modules bindings.

## History

Russh began as a fork of [Thrussh](https://nest.pijul.com/pijul/thrussh) by Pierre-Étienne Meunier, originally extended to provide the SSH backend for [Warpgate](https://github.com/warp-tech/warpgate). 

It has since been substantially reworked, and is maintained independently. Russh prioritises safety-by-default and broad algorithm interoperability.
Thanks to Pierre-Étienne and the Thrussh contributors for the original foundation.

## Contributors ✨

Thanks goes to these wonderful people ([emoji key](https://allcontributors.org/docs/en/emoji-key)):

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mihirsamdarshi"><img src="https://avatars.githubusercontent.com/u/5462077?v=4?s=100" width="100px;" alt="Mihir Samdarshi"/><br /><sub><b>Mihir Samdarshi</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=mihirsamdarshi" title="Documentation">📖</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://peet.io/"><img src="https://avatars.githubusercontent.com/u/2230985?v=4?s=100" width="100px;" alt="Connor Peet"/><br /><sub><b>Connor Peet</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=connor4312" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/kvzn"><img src="https://avatars.githubusercontent.com/u/313271?v=4?s=100" width="100px;" alt="KVZN"/><br /><sub><b>KVZN</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=kvzn" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://www.telekom.de"><img src="https://avatars.githubusercontent.com/u/21334898?v=4?s=100" width="100px;" alt="Adrian Müller (DTT)"/><br /><sub><b>Adrian Müller (DTT)</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=amtelekom" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://www.evilsocket.net"><img src="https://avatars.githubusercontent.com/u/86922?v=4?s=100" width="100px;" alt="Simone Margaritelli"/><br /><sub><b>Simone Margaritelli</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=evilsocket" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://joegrund.com"><img src="https://avatars.githubusercontent.com/u/458717?v=4?s=100" width="100px;" alt="Joe Grund"/><br /><sub><b>Joe Grund</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=jgrund" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/AspectUnk"><img src="https://avatars.githubusercontent.com/u/59799956?v=4?s=100" width="100px;" alt="AspectUnk"/><br /><sub><b>AspectUnk</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=AspectUnk" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://0io.eu"><img src="https://avatars.githubusercontent.com/u/203575?v=4?s=100" width="100px;" alt="Simão Mata"/><br /><sub><b>Simão Mata</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=simao" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://mariotaku.org"><img src="https://avatars.githubusercontent.com/u/830358?v=4?s=100" width="100px;" alt="Mariotaku"/><br /><sub><b>Mariotaku</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=mariotaku" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/yorkz1994"><img src="https://avatars.githubusercontent.com/u/16678950?v=4?s=100" width="100px;" alt="yorkz1994"/><br /><sub><b>yorkz1994</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=yorkz1994" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://volution.ro/"><img src="https://avatars.githubusercontent.com/u/29785?v=4?s=100" width="100px;" alt="Ciprian Dorin Craciun"/><br /><sub><b>Ciprian Dorin Craciun</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=cipriancraciun" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mllken"><img src="https://avatars.githubusercontent.com/u/11590808?v=4?s=100" width="100px;" alt="Eric Milliken"/><br /><sub><b>Eric Milliken</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=mllken" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Swelio"><img src="https://avatars.githubusercontent.com/u/24651896?v=4?s=100" width="100px;" alt="Swelio"/><br /><sub><b>Swelio</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=Swelio" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/joshbenz"><img src="https://avatars.githubusercontent.com/u/94999261?v=4?s=100" width="100px;" alt="Joshua Benz"/><br /><sub><b>Joshua Benz</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=joshbenz" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="http://homepage.ruhr-uni-bochum.de/Jan.Holthuis/"><img src="https://avatars.githubusercontent.com/u/1834516?v=4?s=100" width="100px;" alt="Jan Holthuis"/><br /><sub><b>Jan Holthuis</b></sub></a><br /><a href="#security-Holzhaus" title="Security">🛡️</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mateuszkj"><img src="https://avatars.githubusercontent.com/u/2494082?v=4?s=100" width="100px;" alt="mateuszkj"/><br /><sub><b>mateuszkj</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=mateuszkj" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://gotlou.srht.site"><img src="https://avatars.githubusercontent.com/u/23006870?v=4?s=100" width="100px;" alt="Saksham Mittal"/><br /><sub><b>Saksham Mittal</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=gotlougit" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://canoncollision.com"><img src="https://avatars.githubusercontent.com/u/5120858?v=4?s=100" width="100px;" alt="Lucas Kent"/><br /><sub><b>Lucas Kent</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=rukai" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/RDruon"><img src="https://avatars.githubusercontent.com/u/64585623?v=4?s=100" width="100px;" alt="Raphael Druon"/><br /><sub><b>Raphael Druon</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=RDruon" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Nurrl"><img src="https://avatars.githubusercontent.com/u/15341887?v=4?s=100" width="100px;" alt="Maya the bee"/><br /><sub><b>Maya the bee</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=Nurrl" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mmirate"><img src="https://avatars.githubusercontent.com/u/992859?v=4?s=100" width="100px;" alt="Milo Mirate"/><br /><sub><b>Milo Mirate</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=mmirate" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/george-hopkins"><img src="https://avatars.githubusercontent.com/u/552590?v=4?s=100" width="100px;" alt="George Hopkins"/><br /><sub><b>George Hopkins</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=george-hopkins" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://amcoff.net/"><img src="https://avatars.githubusercontent.com/u/17624114?v=4?s=100" width="100px;" alt="Åke Amcoff"/><br /><sub><b>Åke Amcoff</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=akeamc" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://brendonho.com"><img src="https://avatars.githubusercontent.com/u/12106620?v=4?s=100" width="100px;" alt="Brendon Ho"/><br /><sub><b>Brendon Ho</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=bho01" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://samlikes.pizza/"><img src="https://avatars.githubusercontent.com/u/226872?v=4?s=100" width="100px;" alt="Samuel Ainsworth"/><br /><sub><b>Samuel Ainsworth</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=samuela" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Sherlock-Holo"><img src="https://avatars.githubusercontent.com/u/10096425?v=4?s=100" width="100px;" alt="Sherlock Holo"/><br /><sub><b>Sherlock Holo</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=sherlock-holo" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ricott1"><img src="https://avatars.githubusercontent.com/u/16502243?v=4?s=100" width="100px;" alt="Alessandro Ricottone"/><br /><sub><b>Alessandro Ricottone</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=ricott1" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/T0b1-iOS"><img src="https://avatars.githubusercontent.com/u/15174814?v=4?s=100" width="100px;" alt="T0b1-iOS"/><br /><sub><b>T0b1-iOS</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=T0b1-iOS" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://mecha.so"><img src="https://avatars.githubusercontent.com/u/4598631?v=4?s=100" width="100px;" alt="Shoaib Merchant"/><br /><sub><b>Shoaib Merchant</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=shoaibmerchant" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/gleason-m"><img src="https://avatars.githubusercontent.com/u/86493344?v=4?s=100" width="100px;" alt="Michael Gleason"/><br /><sub><b>Michael Gleason</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=gleason-m" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://ana.gelez.xyz"><img src="https://avatars.githubusercontent.com/u/16254623?v=4?s=100" width="100px;" alt="Ana Gelez"/><br /><sub><b>Ana Gelez</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=elegaanz" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tomknig"><img src="https://avatars.githubusercontent.com/u/3586316?v=4?s=100" width="100px;" alt="Tom König"/><br /><sub><b>Tom König</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=tomknig" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://www.legaltile.com/"><img src="https://avatars.githubusercontent.com/u/45085843?v=4?s=100" width="100px;" alt="Pierre Barre"/><br /><sub><b>Pierre Barre</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=Barre" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://skutnik.page"><img src="https://avatars.githubusercontent.com/u/22240065?v=4?s=100" width="100px;" alt="Jean-Baptiste Skutnik"/><br /><sub><b>Jean-Baptiste Skutnik</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=spoutn1k" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://blog.packetsource.net/"><img src="https://avatars.githubusercontent.com/u/6276475?v=4?s=100" width="100px;" alt="Adam Chappell"/><br /><sub><b>Adam Chappell</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=packetsource" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/CertainLach"><img src="https://avatars.githubusercontent.com/u/6235312?v=4?s=100" width="100px;" alt="Yaroslav Bolyukin"/><br /><sub><b>Yaroslav Bolyukin</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=CertainLach" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://www.systemscape.de"><img src="https://avatars.githubusercontent.com/u/20155974?v=4?s=100" width="100px;" alt="Julian"/><br /><sub><b>Julian</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=JuliDi" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://saunter.org"><img src="https://avatars.githubusercontent.com/u/47992?v=4?s=100" width="100px;" alt="Thomas Rampelberg"/><br /><sub><b>Thomas Rampelberg</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=grampelberg" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://belak.io"><img src="https://avatars.githubusercontent.com/u/107097?v=4?s=100" width="100px;" alt="Kaleb Elwert"/><br /><sub><b>Kaleb Elwert</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=belak" title="Documentation">📖</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://garyguo.net"><img src="https://avatars.githubusercontent.com/u/4065244?v=4?s=100" width="100px;" alt="Gary Guo"/><br /><sub><b>Gary Guo</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=nbdd0121" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/irvingoujAtDevolution"><img src="https://avatars.githubusercontent.com/u/139169536?v=4?s=100" width="100px;" alt="irvingouj @ Devolutions"/><br /><sub><b>irvingouj @ Devolutions</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=irvingoujAtDevolution" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://tonipeter.de"><img src="https://avatars.githubusercontent.com/u/4614215?v=4?s=100" width="100px;" alt="Toni Peter"/><br /><sub><b>Toni Peter</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=Tehforsch" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Nathy-bajo"><img src="https://avatars.githubusercontent.com/u/73991674?v=4?s=100" width="100px;" alt="Nathaniel Bajo"/><br /><sub><b>Nathaniel Bajo</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=Nathy-bajo" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://eric.dev.br"><img src="https://avatars.githubusercontent.com/u/3129194?v=4?s=100" width="100px;" alt="Eric Rodrigues Pires"/><br /><sub><b>Eric Rodrigues Pires</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=EpicEric" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://www.fly.io"><img src="https://avatars.githubusercontent.com/u/43325?v=4?s=100" width="100px;" alt="Jerome Gravel-Niquet"/><br /><sub><b>Jerome Gravel-Niquet</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=jeromegn" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://qsantos.fr/"><img src="https://avatars.githubusercontent.com/u/8493765?v=4?s=100" width="100px;" alt="Quentin Santos"/><br /><sub><b>Quentin Santos</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=qsantos" title="Documentation">📖</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ogedei-khan"><img src="https://avatars.githubusercontent.com/u/181673956?v=4?s=100" width="100px;" alt="André Almeida"/><br /><sub><b>André Almeida</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=ogedei-khan" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/snaggen"><img src="https://avatars.githubusercontent.com/u/6420639?v=4?s=100" width="100px;" alt="Mattias Eriksson"/><br /><sub><b>Mattias Eriksson</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=snaggen" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://joshka.net"><img src="https://avatars.githubusercontent.com/u/381361?v=4?s=100" width="100px;" alt="Josh McKinney"/><br /><sub><b>Josh McKinney</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=joshka" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://citorva.fr/"><img src="https://avatars.githubusercontent.com/u/16229435?v=4?s=100" width="100px;" alt="citorva"/><br /><sub><b>citorva</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=citorva" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/eric-seppanen"><img src="https://avatars.githubusercontent.com/u/109770420?v=4?s=100" width="100px;" alt="Eric Seppanen"/><br /><sub><b>Eric Seppanen</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=eric-seppanen" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://codeandbitters.com/"><img src="https://avatars.githubusercontent.com/u/36317762?v=4?s=100" width="100px;" alt="Eric Seppanen"/><br /><sub><b>Eric Seppanen</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=ericseppanen" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://pwy.io"><img src="https://avatars.githubusercontent.com/u/3395477?v=4?s=100" width="100px;" alt="Patryk Wychowaniec"/><br /><sub><b>Patryk Wychowaniec</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=Patryk27" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://www.randymcmillan.net"><img src="https://avatars.githubusercontent.com/u/152159?v=4?s=100" width="100px;" alt="@RandyMcMillan"/><br /><sub><b>@RandyMcMillan</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=RandyMcMillan" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/handewo"><img src="https://avatars.githubusercontent.com/u/20971373?v=4?s=100" width="100px;" alt="handewo"/><br /><sub><b>handewo</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=handewo" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ccbrown"><img src="https://avatars.githubusercontent.com/u/1731074?v=4?s=100" width="100px;" alt="Chris"/><br /><sub><b>Chris</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=ccbrown" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/procr1337"><img src="https://avatars.githubusercontent.com/u/193802945?v=4?s=100" width="100px;" alt="procr1337"/><br /><sub><b>procr1337</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=procr1337" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Itsusinn"><img src="https://avatars.githubusercontent.com/u/30529002?v=4?s=100" width="100px;" alt="iHsin"/><br /><sub><b>iHsin</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=Itsusinn" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/psychon"><img src="https://avatars.githubusercontent.com/u/89482?v=4?s=100" width="100px;" alt="Uli Schlachter"/><br /><sub><b>Uli Schlachter</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=psychon" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jvanbrunt"><img src="https://avatars.githubusercontent.com/u/3064793?v=4?s=100" width="100px;" alt="Jacob Van Brunt"/><br /><sub><b>Jacob Van Brunt</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=jvanbrunt" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/lgmugnier"><img src="https://avatars.githubusercontent.com/u/10800317?v=4?s=100" width="100px;" alt="lgmugnier"/><br /><sub><b>lgmugnier</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=lgmugnier" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/MingweiSamuel"><img src="https://avatars.githubusercontent.com/u/6778341?v=4?s=100" width="100px;" alt="Mingwei Samuel"/><br /><sub><b>Mingwei Samuel</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=MingweiSamuel" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://twitter.com/pascalgrange"><img src="https://avatars.githubusercontent.com/u/378506?v=4?s=100" width="100px;" alt="Pascal Grange"/><br /><sub><b>Pascal Grange</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=pgrange" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/wyhaya"><img src="https://avatars.githubusercontent.com/u/23690145?v=4?s=100" width="100px;" alt="wyhaya"/><br /><sub><b>wyhaya</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=wyhaya" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/plaflamme"><img src="https://avatars.githubusercontent.com/u/484152?v=4?s=100" width="100px;" alt="Philippe Laflamme"/><br /><sub><b>Philippe Laflamme</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=plaflamme" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tom-90"><img src="https://avatars.githubusercontent.com/u/12208221?v=4?s=100" width="100px;" alt="Tom"/><br /><sub><b>Tom</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=tom-90" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://dog-tunnel.tk"><img src="https://avatars.githubusercontent.com/u/4971777?v=4?s=100" width="100px;" alt="vzex"/><br /><sub><b>vzex</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=vzex" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://the-b.org/"><img src="https://avatars.githubusercontent.com/u/50407?v=4?s=100" width="100px;" alt="Kenny Root"/><br /><sub><b>Kenny Root</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=kruton" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/moshevds"><img src="https://avatars.githubusercontent.com/u/1497288?v=4?s=100" width="100px;" alt="Môshe van der Sterre"/><br /><sub><b>Môshe van der Sterre</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=moshevds" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Lucy-dot-dot"><img src="https://avatars.githubusercontent.com/u/178554709?v=4?s=100" width="100px;" alt="Lucy"/><br /><sub><b>Lucy</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=Lucy-dot-dot" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="http://mbund.dev"><img src="https://avatars.githubusercontent.com/u/25110595?v=4?s=100" width="100px;" alt="Mark Bundschuh"/><br /><sub><b>Mark Bundschuh</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=mbund" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tayu0110"><img src="https://avatars.githubusercontent.com/u/69729315?v=4?s=100" width="100px;" alt="tayu0110"/><br /><sub><b>tayu0110</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=tayu0110" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://cubic-vm.org"><img src="https://avatars.githubusercontent.com/u/155455820?v=4?s=100" width="100px;" alt="Roger Knecht"/><br /><sub><b>Roger Knecht</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=rogkne" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://gui.wf"><img src="https://avatars.githubusercontent.com/u/48162143?v=4?s=100" width="100px;" alt="Guilherme Fontes"/><br /><sub><b>Guilherme Fontes</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=gui-wf" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/zeroleo12345"><img src="https://avatars.githubusercontent.com/u/13072815?v=4?s=100" width="100px;" alt="Lyn"/><br /><sub><b>Lyn</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=zeroleo12345" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Mota-Link"><img src="https://avatars.githubusercontent.com/u/83714159?v=4?s=100" width="100px;" alt="Mota-Link"/><br /><sub><b>Mota-Link</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=Mota-Link" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mjc"><img src="https://avatars.githubusercontent.com/u/1977?v=4?s=100" width="100px;" alt="Mika Cohen"/><br /><sub><b>Mika Cohen</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=mjc" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://fbernier.me"><img src="https://avatars.githubusercontent.com/u/147585?v=4?s=100" width="100px;" alt="François Bernier"/><br /><sub><b>François Bernier</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=fbernier" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://vulns.xyz"><img src="https://avatars.githubusercontent.com/u/7763184?v=4?s=100" width="100px;" alt="kpcyrd"/><br /><sub><b>kpcyrd</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=kpcyrd" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/coreyleavitt"><img src="https://avatars.githubusercontent.com/u/18317330?v=4?s=100" width="100px;" alt="Corey Leavitt"/><br /><sub><b>Corey Leavitt</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=coreyleavitt" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/wi-adam"><img src="https://avatars.githubusercontent.com/u/127046659?v=4?s=100" width="100px;" alt="wi-adam"/><br /><sub><b>wi-adam</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=wi-adam" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://ddtkey.com"><img src="https://avatars.githubusercontent.com/u/26835520?v=4?s=100" width="100px;" alt="Artem Medvedev"/><br /><sub><b>Artem Medvedev</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=DDtKey" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ztbh"><img src="https://avatars.githubusercontent.com/u/67856492?v=4?s=100" width="100px;" alt="ztbh"/><br /><sub><b>ztbh</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=ztbh" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://blog.sakurapuare.com"><img src="https://avatars.githubusercontent.com/u/52142762?v=4?s=100" width="100px;" alt="Moder Steven"/><br /><sub><b>Moder Steven</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=SakuraPuare" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://jkshin.nubimaru.com"><img src="https://avatars.githubusercontent.com/u/949915?v=4?s=100" width="100px;" alt="Jeongkyu Shin"/><br /><sub><b>Jeongkyu Shin</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=inureyes" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/PokAhonTAS911"><img src="https://avatars.githubusercontent.com/u/208599324?v=4?s=100" width="100px;" alt="PokAhonTAS911"/><br /><sub><b>PokAhonTAS911</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=PokAhonTAS911" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://ayamir.github.io"><img src="https://avatars.githubusercontent.com/u/61657399?v=4?s=100" width="100px;" alt="ayamir"/><br /><sub><b>ayamir</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=ayamir" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://l9o.dev"><img src="https://avatars.githubusercontent.com/u/112069?v=4?s=100" width="100px;" alt="Luiz Ribeiro"/><br /><sub><b>Luiz Ribeiro</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=luizribeiro" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://ctx.st"><img src="https://avatars.githubusercontent.com/u/259330610?v=4?s=100" width="100px;" alt="biao29"/><br /><sub><b>biao29</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=biao29" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/gvz"><img src="https://avatars.githubusercontent.com/u/3962183?v=4?s=100" width="100px;" alt="Georg von Zengen"/><br /><sub><b>Georg von Zengen</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=gvz" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tluyben"><img src="https://avatars.githubusercontent.com/u/623448?v=4?s=100" width="100px;" alt="tluyben"/><br /><sub><b>tluyben</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=tluyben" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://harmont.dev"><img src="https://avatars.githubusercontent.com/u/15203893?v=4?s=100" width="100px;" alt="Marko Vejnovic"/><br /><sub><b>Marko Vejnovic</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=markovejnovic" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/t8y2"><img src="https://avatars.githubusercontent.com/u/77960507?v=4?s=100" width="100px;" alt="t8y2"/><br /><sub><b>t8y2</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=t8y2" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mdevolde"><img src="https://avatars.githubusercontent.com/u/73021358?v=4?s=100" width="100px;" alt="mdevolde"/><br /><sub><b>mdevolde</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=mdevolde" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Eric-D"><img src="https://avatars.githubusercontent.com/u/3263894?v=4?s=100" width="100px;" alt="Eric-D"/><br /><sub><b>Eric-D</b></sub></a><br /><a href="https://github.com/Eugeny/russh/commits?author=Eric-D" title="Code">💻</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!
