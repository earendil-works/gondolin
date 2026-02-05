/**
 * @earendil-works/gondolin
 *
 * Alpine Linux sandbox for running untrusted code with controlled
 * filesystem and network access.
 */

// Main VM interface
export { VM, type VMOptions, type VMState } from "./vm";
export {
  type ExecOptions,
  type ExecResult,
  type ExecProcess,
} from "./exec";

// Server for running the sandbox
export {
  SandboxServer,
  resolveSandboxServerOptions,
  resolveSandboxServerOptionsAsync,
  type ImagePath,
  type SandboxServerOptions,
  type ResolvedSandboxServerOptions,
  type SandboxConnection,
} from "./sandbox-server";

// VFS (Virtual File System) providers
export {
  create as createVfs,
  VirtualFileSystem,
  VirtualProvider,
  MemoryProvider,
  RealFSProvider,
  SandboxVfsProvider,
  ReadonlyProvider,
  FsRpcClient,
  RpcFsBackend,
  RpcFileHandle,
  FsRpcService,
  type VirtualFileHandle,
  type VfsHooks,
  type VfsHookContext,
  type FsRpcMetrics,
  MAX_RPC_DATA,
} from "./vfs";

// HTTP hooks for network policy
export {
  createHttpHooks,
  type CreateHttpHooksOptions,
  type CreateHttpHooksResult,
  type SecretDefinition,
} from "./http-hooks";

// Network types
export type { HttpHooks, HttpHookRequest, HttpFetch } from "./qemu-net";
export { HttpRequestBlockedError } from "./qemu-net";

// Asset management
export {
  ensureGuestAssets,
  getAssetVersion,
  getAssetDirectory,
  hasGuestAssets,
  loadGuestAssets,
  type GuestAssets,
} from "./assets";

// Build configuration and builder
export {
  type Architecture,
  type Distro,
  type BuildConfig,
  type AlpineConfig,
  type NixOSConfig,
  type ContainerConfig,
  type RootfsConfig,
  type InitConfig,
  type AssetManifest,
  getDefaultBuildConfig,
  getDefaultArch,
  validateBuildConfig,
  parseBuildConfig,
  serializeBuildConfig,
} from "./build-config";

export {
  buildAssets,
  loadAssetManifest,
  verifyAssets,
  type BuildOptions,
  type BuildResult,
} from "./builder";
