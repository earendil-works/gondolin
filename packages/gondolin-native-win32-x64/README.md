# Gondolin native engine for Windows x64

This optional platform package supplies `bin/gondolind.exe` for
`@earendil-works/gondolin`. The SDK discovers it automatically. Use the Node.js
`gondolin` CLI; the standalone Rust CLI is currently Unix-only.

The executable is staged by `scripts/prepare-native-package.mjs` during release
and is not checked into the source tree. Source checkouts can build it with
`cargo build --release -p gondolind` in `native/`.

See [Windows host setup](https://github.com/earendil-works/gondolin/blob/main/docs/windows-showcase.md)
for QEMU and WHPX requirements.
