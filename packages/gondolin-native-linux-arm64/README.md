# @earendil-works/gondolin-native-linux-arm64

Prebuilt `gondolind`, Gondolin's native host engine, for Linux arm64 (static, musl).

This package is consumed by `@earendil-works/gondolin` as an optional
platform-specific dependency (`engine: "native"`). Remote setups that need
the binary of another platform use `ensureNativeBinary({ platform, arch })`
from `@earendil-works/gondolin`, which fetches this package on demand.
