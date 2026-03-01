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
  type VmFs,
  type VmRootfsOptions,
  type VmFsAccessOptions,
  type VmFsMkdirOptions,
  type VmFsListDirOptions,
  type VmFsStatOptions,
  type VmFsRenameOptions,
  type VmFsStat,
  type VmFsReadFileOptions,
  type VmFsReadFileBufferOptions,
  type VmFsReadFileTextOptions,
  type VmFsReadFileStreamOptions,
  type VmFsWriteFileInput,
  type VmFsWriteFileOptions,
  type VmFsDeleteOptions,
} from "./vm/core.ts";
export { VmCheckpoint, type VmCheckpointData } from "./checkpoint.ts";
export { type ExecOptions, type ExecResult, type ExecProcess } from "./exec.ts";

// Server for running the sandbox
export { SandboxServer } from "./sandbox/server.ts";

// VFS (Virtual File System) providers
export {
  VirtualFileSystem,
  VirtualProvider,
  MemoryProvider,
  RealFSProvider,
  type VirtualFileHandle,
  type VfsStatfs,
  type VirtualFileSystemOptions,
} from "./vfs/node/index.ts";

export {
  SandboxVfsProvider,
  type VfsHooks,
  type VfsHookContext,
} from "./vfs/provider.ts";
export { ReadonlyProvider } from "./vfs/readonly.ts";
export { ReadonlyVirtualProvider } from "./vfs/readonly-virtual.ts";
export {
  ShadowProvider,
  createShadowPathPredicate,
  type ShadowProviderOptions,
  type ShadowWriteMode,
  type ShadowPredicate,
  type ShadowContext,
} from "./vfs/shadow.ts";
export {
  VirtualProviderClass,
  ERRNO,
  isWriteFlag,
  normalizeVfsPath,
  VirtualDirent,
  createVirtualDirStats,
  formatVirtualEntries,
} from "./vfs/utils.ts";
export {
  FsRpcService,
  type FsRpcMetrics,
  MAX_RPC_DATA,
} from "./vfs/rpc-service.ts";

// HTTP hooks for network policy
export {
  createHttpHooks,
  type CreateHttpHooksOptions,
  type CreateHttpHooksResult,
  type SecretDefinition,
} from "./http/hooks.ts";

// Network types
export type {
  DnsMode,
  DnsOptions,
  SyntheticDnsHostMappingMode,
  HttpIpAllowInfo,
  HttpHooks,
  HttpFetch,
  TcpOptions,
} from "./qemu/net.ts";
export type {
  SshOptions,
  SshCredential,
  SshExecRequest,
  SshExecDecision,
  SshExecPolicy,
} from "./qemu/ssh.ts";
export { HttpRequestBlockedError } from "./http/utils.ts";

// SSH helpers
export { getInfoFromSshExecRequest, type GitSshExecInfo } from "./ssh/exec.ts";

// Debug helpers
export {
  type DebugFlag,
  type DebugConfig,
  type DebugComponent,
  type DebugLogFn,
} from "./debug.ts";

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
} from "./ingress.ts";

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
} from "./session-registry.ts";

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
} from "./assets.ts";

// Local image store
export {
  getImageStoreDirectory,
  getImageObjectDirectory,
  importImageFromDirectory,
  resolveImageSelector,
  listImageRefs,
  setImageRef,
  tagImage,
  type ImageArch,
  type ImageRefTargets,
  type LocalImageRef,
  type ImportedImage,
  type ResolvedImage,
} from "./images.ts";

// Build configuration and builder
export {
  type Architecture,
  type Distro,
  type ContainerRuntime,
  type OciPullPolicy,
  type BuildConfig,
  type AlpineConfig,
  type NixOSConfig,
  type ContainerConfig,
  type OciRootfsConfig,
  type RootfsConfig,
  type InitConfig,
  type RuntimeDefaultsConfig,
  type RootfsMode,
  getDefaultBuildConfig,
  getDefaultArch,
  validateBuildConfig,
  parseBuildConfig,
  serializeBuildConfig,
} from "./build/config.ts";

export {
  buildAssets,
  verifyAssets,
  type BuildOptions,
  type BuildResult,
} from "./build/index.ts";
