# @earendil-works/gondolin-native-linux-x64

Prebuilt `gondolin` for Linux x64: one multi-call binary that is both the static
Gondolin CLI (`bash`, `exec`, `list`, `attach`, `snapshot`, `image`; no Node.js
needed, see [the CLI docs](https://github.com/earendil-works/gondolin/blob/main/docs/cli.md#static-cli-no-nodejs))
and `gondolind`, the native engine daemon (`gondolin daemon`, or the binary
invoked under the name `gondolind`: the package's npm `bin` links it as
`gondolind`).

This package is consumed by `@earendil-works/gondolin` as an optional
platform-specific dependency (the native engine). Remote setups that need
the binary of another platform use `ensureNativeBinary({ platform, arch })`
from `@earendil-works/gondolin`, which fetches this package on demand and
returns the binary with the arguments that start the daemon.
