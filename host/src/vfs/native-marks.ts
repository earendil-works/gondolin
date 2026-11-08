/**
 * Hidden markers that let the native engine translate JS providers into
 * daemon-side mounts (`native/DESIGN.md`, "Filesystem tiers").
 */

/** Marker of providers with a native counterpart */
export const kNativeMount = Symbol.for("gondolin.vfs.nativeMount");

/** Paths of a predicate built by `createShadowPathPredicate` */
export const kShadowPaths = Symbol.for("gondolin.vfs.shadowPaths");

/** Accessor for wrapper internals (`ReadonlyProvider`, `ShadowProvider`, ...) */
export const kProviderInternals = Symbol.for("gondolin.vfs.internals");

/** Native counterpart of a provider */
export type NativeMountMark =
  /** in-daemon memory filesystem (the provider is only a stand-in) */
  | { kind: "memory" }
  /** read-only synthetic files */
  | { kind: "static"; files: Record<string, Buffer> }
  /** daemon-side host directory (valid for remote daemons too) */
  | { kind: "host"; root: string }
  /** whole-file provider served through the object tier */
  | {
      kind: "object";
      /** the `ObjectProvider` */
      provider: unknown;
      /** its `ObjectMountOptions` */
      options: Record<string, unknown>;
    };

/** Attach a native counterpart to a provider */
export function markNativeMount<T extends object>(
  provider: T,
  mark: NativeMountMark,
): T {
  Object.defineProperty(provider, kNativeMount, {
    value: mark,
    enumerable: false,
    configurable: true,
  });
  return provider;
}

/** The native counterpart of a provider, if any */
export function getNativeMountMark(
  provider: unknown,
): NativeMountMark | undefined {
  if (!provider || typeof provider !== "object") return undefined;
  return (provider as Record<symbol, NativeMountMark | undefined>)[
    kNativeMount
  ];
}

/** Internals exposed by wrapper providers */
export type ProviderInternals =
  | { kind: "readonly"; backend: unknown }
  | {
      kind: "shadow";
      backend: unknown;
      shouldShadow: unknown;
      writeMode: "deny" | "tmpfs";
      /** whether the caller supplied its own tmpfs provider */
      customTmpfs: boolean;
      denySymlinkBypass: boolean;
      denyWriteErrno: number;
    }
  | { kind: "hooked"; backend: unknown; hooks: unknown }
  | { kind: "router"; mounts: Map<string, unknown> };

export function getProviderInternals(
  provider: unknown,
): ProviderInternals | undefined {
  if (!provider || typeof provider !== "object") return undefined;
  const fn = (provider as Record<symbol, unknown>)[kProviderInternals];
  return typeof fn === "function"
    ? (fn.call(provider) as ProviderInternals)
    : undefined;
}
