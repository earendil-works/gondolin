import type {
  Architecture,
  ContainerRuntime,
  OciPullPolicy,
} from "../build/config.ts";

/** OCI rootfs source configuration */
export interface OciRootfsOptions {
  /** OCI image reference (`repo/name[:tag]` or `repo/name@sha256:...`) */
  image: string;
  /** runtime used to pull/create/export OCI images (auto-detect when undefined) */
  runtime?: ContainerRuntime;
  /** image platform override (default: derived from `arch`) */
  platform?: string;
  /** pull behavior before export (default: "if-not-present") */
  pullPolicy?: OciPullPolicy;
}

/** Options for the Alpine image build pipeline */
export interface AlpineBuildOptions {
  /** target architecture */
  arch: Architecture;
  /** alpine version (e.g. "3.23.0") */
  alpineVersion: string;
  /** alpine branch (e.g. "v3.23") */
  alpineBranch: string;
  /** full url to the alpine minirootfs tarball (overrides mirror) */
  alpineUrl?: string;
  /** OCI source used for rootfs extraction (Alpine minirootfs when undefined) */
  ociRootfs?: OciRootfsOptions;
  /** packages to install in the rootfs */
  rootfsPackages: string[];
  /** packages to install in the initramfs */
  initramfsPackages: string[];
  /** path to the sandboxd binary */
  sandboxdBin: string;
  /** path to the sandboxfs binary */
  sandboxfsBin: string;
  /** path to the sandboxssh binary */
  sandboxsshBin: string;
  /** path to the sandboxingress binary */
  sandboxingressBin: string;
  /** volume label for the rootfs ext4 image */
  rootfsLabel: string;
  /** fixed rootfs image size in `mb` (auto when undefined) */
  rootfsSizeMb?: number;
  /** rootfs init script content (built-in when undefined) */
  rootfsInit?: string;
  /** initramfs init script content (built-in when undefined) */
  initramfsInit?: string;
  /** extra shell script content appended to rootfs init before sandboxd starts */
  rootfsInitExtra?: string;
  /** shell commands executed in rootfs after package installation */
  postBuildCommands?: string[];
  /** default environment variables baked into the guest image */
  defaultEnv?: Record<string, string> | string[];
  /** working directory for intermediate files */
  workDir: string;
  /** directory for caching downloaded files */
  cacheDir: string;
  /** log sink */
  log: (msg: string) => void;
}

/** OCI source metadata captured during rootfs export */
export interface OciResolvedSource {
  /** requested OCI image reference from build config */
  image: string;
  /** OCI runtime used for export */
  runtime: ContainerRuntime;
  /** OCI platform used for export */
  platform: string;
  /** OCI pull policy used for export */
  pullPolicy: OciPullPolicy;
  /** resolved OCI digest (`sha256:...`) */
  digest?: string;
  /** resolved OCI image reference (`repo@sha256:...`) */
  reference?: string;
}

/** Result produced by the Alpine image build pipeline */
export interface AlpineBuildResult {
  /** rootfs ext4 image path */
  rootfsImage: string;
  /** compressed initramfs path */
  initramfs: string;
  /** OCI source metadata captured during rootfs export */
  ociSource?: OciResolvedSource;
}

/** a single entry parsed from a tar archive */
export interface TarEntry {
  /** entry name */
  name: string;
  /** tar type flag (0=file, 5=dir, 2=symlink, 1=hardlink) */
  type: number;
  /** file mode bits */
  mode: number;
  /** file size in `bytes` */
  size: number;
  /** link target name */
  linkName: string;
  /** file contents (null for non-files) */
  content: Buffer | null;
}

/** package metadata entry parsed from APKINDEX */
export interface ApkMeta {
  /** package name */
  P: string;
  /** package version */
  V: string;
  /** dependencies (space-separated) */
  D?: string;
  /** provides (space-separated) */
  p?: string;
  [key: string]: string | undefined;
}

/** module sync flags */
export interface KernelModuleSyncOptions {
  /** copy rootfs module trees into initramfs */
  copyRootfsToInitramfs?: boolean;
}
