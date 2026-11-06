# @earendil-works/gondolin-native-darwin-x64

Prebuilt `gondolind`, Gondolin's native host engine, for macOS x64.

This package is consumed by `@earendil-works/gondolin` as an optional
platform-specific dependency (`engine: "native"`). Remote setups that need
the binary of another platform use `ensureNativeBinary({ platform, arch })`
from `@earendil-works/gondolin`, which fetches this package on demand.
