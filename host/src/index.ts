/**
 * @earendil-works/gondolin
 *
 * Alpine Linux sandbox for running untrusted code with controlled
 * filesystem and network access.
 */

// Main VM interface
export {
  VM,
  type VMOptions,
  type VMState,
  type EnableSshOptions,
  type SshAccess,
  type VmReadFileOptions,
  type VmReadFileBufferOptions,
  type VmReadFileTextOptions,
  type VmReadFileStreamOptions,
  type VmWriteFileInput,
  type VmWriteFileOptions,
  type VmDeleteFileOptions,
} from "./vm";
export { VmCheckpoint, type VmCheckpointData } from "./checkpoint";
export { type ExecOptions, type ExecResult, type ExecProcess } from "./exec";

// Server for running the sandbox
export {
  SandboxServer,
  resolveSandboxServerOptions,
  resolveSandboxServerOptionsAsync,
  type ImagePath,
  type SandboxServerOptions,
  type ResolvedSandboxServerOptions,
  type SandboxConnection,
  type GuestFileReadOptions,
  type GuestFileWriteOptions,
  type GuestFileDeleteOptions,
} from "./sandbox-server";

// VFS (Virtual File System) providers
export {
  create as createVfs,
  VirtualFileSystem,
  VirtualProvider,
  MemoryProvider,
  RealFSProvider,
  type VirtualFileHandle,
  type VfsStatfs,
  type VirtualFileSystemOptions,
} from "./vfs/node";

export {
  SandboxVfsProvider,
  type VfsHooks,
  type VfsHookContext,
} from "./vfs/provider";
export { ReadonlyProvider } from "./vfs/readonly";
export { ReadonlyVirtualProvider } from "./vfs/readonly-virtual";
export {
  ShadowProvider,
  createShadowPathPredicate,
  type ShadowProviderOptions,
  type ShadowWriteMode,
  type ShadowPredicate,
  type ShadowContext,
} from "./vfs/shadow";
export {
  VirtualProviderClass,
  ERRNO,
  isWriteFlag,
  normalizeVfsPath,
  VirtualDirent,
  createVirtualDirStats,
  formatVirtualEntries,
} from "./vfs/utils";
export {
  FsRpcService,
  type FsRpcMetrics,
  MAX_RPC_DATA,
} from "./vfs/rpc-service";

// HTTP hooks for network policy
export {
  createHttpHooks,
  type CreateHttpHooksOptions,
  type CreateHttpHooksResult,
  type SecretDefinition,
} from "./http-hooks";

// Network types
export type {
  DnsMode,
  DnsOptions,
  SyntheticDnsHostMappingMode,
  HttpIpAllowInfo,
  HttpHooks,
  HttpHookRequest,
  HttpHookRequestHeadResult,
  HttpFetch,
} from "./qemu-net";
export type {
  SshOptions,
  SshCredential,
  SshExecRequest,
  SshExecDecision,
  SshExecPolicy,
} from "./qemu-ssh";
export { HttpRequestBlockedError } from "./http-utils";

// SSH helpers
export { getInfoFromSshExecRequest, type GitSshExecInfo } from "./ssh-exec";

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

// Session registry
export {
  registerSession,
  unregisterSession,
  listSessions,
  findSession,
  gcSessions,
  SessionIpcServer,
  connectToSession,
  type SessionInfo,
  type SessionEntry,
  type IpcClientCallbacks,
} from "./session-registry";

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
