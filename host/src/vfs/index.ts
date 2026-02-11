export {
  create,
  VirtualFileSystem,
  VirtualProvider,
  MemoryProvider,
  RealFSProvider,
} from "./node";
export type { VirtualFileHandle, VfsStatfs } from "./node";

export { SandboxVfsProvider } from "./provider";
export type { VfsHooks, VfsHookContext } from "./provider";
export { ReadonlyProvider } from "./readonly";
export { ReadonlyVirtualProvider } from "./readonly-virtual";
export { ShadowProvider, createShadowPathPredicate } from "./shadow";
export type { ShadowProviderOptions, ShadowWriteMode, ShadowPredicate, ShadowContext } from "./shadow";
export {
  VirtualProviderClass,
  ERRNO,
  isWriteFlag,
  normalizeVfsPath,
  VirtualDirent,
  createVirtualDirStats,
  formatVirtualEntries,
} from "./utils";
export { FsRpcService, type FsRpcMetrics, MAX_RPC_DATA } from "./rpc-service";
