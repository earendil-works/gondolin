/**
 * @earendil-works/gondolin
 *
 * Alpine Linux sandbox for running untrusted code with controlled
 * filesystem and network access.
 */

// Main VM interface
export { VM, type VMOptions, type VMState, type EnableSshOptions, type SshAccess } from "./vm";
export { VmCheckpoint, type VmCheckpointData } from "./checkpoint";
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
  ReadonlyVirtualProvider,
  ShadowProvider,
  createShadowPathPredicate,
  type ShadowProviderOptions,
  type ShadowWriteMode,
  type ShadowPredicate,
  type ShadowContext,
  VirtualProviderClass,
  ERRNO,
  isWriteFlag,
  normalizeVfsPath,
  VirtualDirent,
  createVirtualDirStats,
  formatVirtualEntries,
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
export type { DnsMode, DnsOptions, HttpIpAllowInfo, HttpHooks, HttpHookRequest, HttpFetch } from "./qemu-net";
export { HttpRequestBlockedError } from "./qemu-net";

// Debug helpers
export {
  type DebugFlag,
  type DebugConfig,
  type DebugComponent,
  type DebugLogFn,
} from "./debug";

// Ingress gateway
export {
  IngressGateway,
  GondolinListeners,
  IngressRequestBlockedError,
  parseListenersFile,
  serializeListenersFile,
  type IngressRoute,
  type EnableIngressOptions,
  type IngressAccess,
  type IngressGatewayHooks,
  type IngressAllowInfo,
  type IngressHeaders,
  type IngressHeaderValue,
  type IngressHeaderPatch,
  type IngressHookRequest,
  type IngressHookRequestPatch,
  type IngressHookResponse,
  type IngressHookResponsePatch,
} from "./ingress";

// Asset management
export {
  ensureGuestAssets,
  getAssetVersion,
  getAssetDirectory,
  hasGuestAssets,
  loadGuestAssets,
  loadAssetManifest,
  type GuestAssets,
  type AssetManifest,
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
  getDefaultBuildConfig,
  getDefaultArch,
  validateBuildConfig,
  parseBuildConfig,
  serializeBuildConfig,
} from "./build-config";

export {
  buildAssets,
  verifyAssets,
  type BuildOptions,
  type BuildResult,
} from "./builder";
