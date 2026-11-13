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
export type { NitroOptions, SandboxVmm } from "./sandbox/server-options.ts";
export type { ExecOptions, ExecResult, ExecProcess } from "./exec.ts";
export type { ExecSignalName } from "./utils/signals.ts";

// Guest tmpfs mounts
export {
  DEFAULT_GUEST_TMPFS,
  type GuestTmpfsMountOptions,
  type GuestTmpfsMounts,
} from "./sandbox/tmpfs.ts";

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
  createObjectMount,
  ObjectVirtualProvider,
  type ObjectProvider,
  type ObjectMountOptions,
  type ObjectStat,
  type ObjectDirEntry,
  type ObjectEntryKind,
} from "./vfs/object.ts";
export { nativeMounts, type NativeHostMountOptions } from "./native/vfs.ts";
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

// HTTP hooks for network policy
export {
  createHttpHooks,
  makePlaceholderFunc,
  BASE32_ALPHABET,
  BASE32_HEX_ALPHABET,
  BASE62_ALPHABET,
  BASE64URL_ALPHABET,
  HEX_ALPHABET,
  LOWERCASE_ALPHABET,
  UPPERCASE_ALPHABET,
  type CreateHttpHooksOptions,
  type CreateHttpHooksResult,
  type MakePlaceholderFuncOptions,
  type SecretDefinition,
  type SecretManager,
  type SecretManagerEntry,
  type SecretPlaceholderMode,
  type UpdateSecretOptions,
} from "./http/hooks.ts";

// Tier-2 hooks (JavaScript policies run inside gondolind)
export {
  createDjsHooks,
  djsHooksOptionsFromFile,
  type DjsHookLimits,
  type DjsHooksOptions,
} from "./http/djs-hooks.ts";

// Network types
export type {
  DnsMode,
  DnsOptions,
  SyntheticDnsHostMappingMode,
  HttpIpAllowInfo,
  HttpHooks,
  HttpFetch,
} from "./net/types.ts";
export type { TcpOptions } from "./net/tcp.ts";
export type {
  SshOptions,
  SshCredential,
  SshExecRequest,
  SshExecDecision,
  SshExecPolicy,
} from "./net/ssh.ts";
export { HttpRequestBlockedError } from "./http/utils.ts";
export {
  suggestHostsForSecret,
  type SecretHostSuggestion,
  type SuggestSecretHostsOptions,
} from "./secret-host-suggestions.ts";

// SSH helpers
export { getInfoFromSshExecRequest, type GitSshExecInfo } from "./ssh/exec.ts";

// Debug helpers
export type {
  DebugFlag,
  DebugConfig,
  DebugComponent,
  DebugLogFn,
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
  ensureImageSelector,
  listImageRefs,
  setImageRef,
  tagImage,
  removeImage,
  type ImageArch,
  type ImageRefTargets,
  type LocalImageRef,
  type ImportedImage,
  type ResolvedImage,
} from "./images.ts";

// Native engine (gondolind): engine selection, connections to local or remote daemons
export type { NativeEngineOptions, SandboxEngine } from "./native/config.ts";
export {
  type NativeConnection,
  spawnNativeConnection,
} from "./native/transport.ts";

// Native engine binaries (the multi-call `gondolin`) for this and remote platforms
export {
  ensureNativeBinary,
  getNativeBinaryPath,
  nativeDaemonArgs,
  nativeDaemonCommand,
  nativePackageName,
  nativeRustTarget,
  type EnsureNativeBinaryOptions,
  type NativeArch,
  type NativeBinary,
  type NativeBinaryLookupOptions,
  type NativeBinaryTarget,
  type NativePlatform,
} from "./native/binary.ts";

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
