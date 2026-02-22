import fs from "fs";
import path from "path";

import { assertSafeWritePath, resolveWritePath } from "./rootfs";
import type { KernelModuleSyncOptions } from "./types";

const MODULE_FILE_SUFFIXES = [".ko", ".ko.gz", ".ko.xz", ".ko.zst"] as const;
const REQUIRED_INITRAMFS_MODULES = ["virtio_blk", "ext4"] as const;

export function syncKernelModules(
  rootfsDir: string,
  initramfsDir: string,
  log: (msg: string) => void,
  options: KernelModuleSyncOptions = {},
): void {
  const copyRootfsToInitramfs = options.copyRootfsToInitramfs ?? true;

  const rootfsModulesBase = resolveWritePath(
    path.join(rootfsDir, "lib/modules"),
    rootfsDir,
  );
  const initramfsModulesBase = path.join(initramfsDir, "lib/modules");

  const rootfsVersions = listKernelModuleVersions(rootfsModulesBase);
  const initramfsVersions = listKernelModuleVersions(initramfsModulesBase);

  if (copyRootfsToInitramfs) {
    for (const kernelVersion of rootfsVersions) {
      const srcModules = path.join(rootfsModulesBase, kernelVersion);
      const dstModules = path.join(initramfsModulesBase, kernelVersion);
      log(`Copying kernel modules for ${kernelVersion} into initramfs`);
      copyInitramfsModules(srcModules, dstModules);
    }
  }

  const knownRootfsVersions = new Set(rootfsVersions);
  for (const kernelVersion of initramfsVersions) {
    if (knownRootfsVersions.has(kernelVersion)) {
      continue;
    }

    const srcModules = path.join(initramfsModulesBase, kernelVersion);
    const dstModules = path.join(rootfsModulesBase, kernelVersion);
    assertSafeWritePath(dstModules, rootfsDir);
    log(`Copying all kernel modules for ${kernelVersion} into rootfs`);
    copyAllKernelModules(srcModules, dstModules);
  }
}

function listKernelModuleVersions(modulesBase: string): string[] {
  if (!fs.existsSync(modulesBase)) {
    return [];
  }

  return fs
    .readdirSync(modulesBase)
    .filter((entry) =>
      fs
        .statSync(path.join(modulesBase, entry), {
          throwIfNoEntry: false,
        })
        ?.isDirectory(),
    )
    .sort();
}

function copyAllKernelModules(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;

  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  fs.cpSync(srcDir, dstDir, { recursive: true, dereference: false });
}

function copyInitramfsModules(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;

  const deps = readModuleDependencies(srcDir);
  const modulePathByName = indexModulePathsByName(srcDir, deps);
  const builtinModuleNames = readBuiltinModuleNames(srcDir);

  // Resolve required modules by module name (not file suffix)
  const stack: string[] = [];
  for (const moduleName of REQUIRED_INITRAMFS_MODULES) {
    const normalizedName = normalizeModuleName(moduleName);
    const resolvedPath = modulePathByName.get(normalizedName);
    if (resolvedPath) {
      stack.push(resolvedPath);
      continue;
    }
    if (!builtinModuleNames.has(normalizedName)) {
      throw new Error(
        `Required kernel module "${moduleName}" was not found in ${srcDir}`,
      );
    }
  }

  // Resolve transitive dependencies from modules.dep
  const needed = new Set<string>();
  while (stack.length > 0) {
    const modulePath = stack.pop()!;
    if (needed.has(modulePath)) continue;
    needed.add(modulePath);

    for (const depPath of deps.get(modulePath) ?? []) {
      const resolvedDepPath = resolveModulePath(
        srcDir,
        depPath,
        modulePathByName,
      );
      if (resolvedDepPath) {
        stack.push(resolvedDepPath);
        continue;
      }

      const depName = normalizeModuleName(moduleNameFromPath(depPath));
      if (!builtinModuleNames.has(depName)) {
        throw new Error(
          `Kernel module dependency "${depPath}" referenced by "${modulePath}" was not found in ${srcDir}`,
        );
      }
    }
  }

  // Copy needed module files
  for (const entry of Array.from(needed).sort()) {
    const src = path.join(srcDir, entry);
    if (!fs.existsSync(src)) {
      const moduleName = normalizeModuleName(moduleNameFromPath(entry));
      if (!builtinModuleNames.has(moduleName)) {
        throw new Error(`Kernel module "${entry}" is missing from ${srcDir}`);
      }
      continue;
    }

    const dst = path.join(dstDir, entry);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  // Copy modules.* metadata files
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    if (!entry.startsWith("modules.")) continue;
    const src = path.join(srcDir, entry);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(dstDir, entry));
    }
  }
}

function readModuleDependencies(srcDir: string): Map<string, string[]> {
  const depFile = path.join(srcDir, "modules.dep");
  const deps = new Map<string, string[]>();

  if (!fs.existsSync(depFile)) {
    return deps;
  }

  for (const line of fs.readFileSync(depFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const modulePath = normalizeModulePath(trimmed.slice(0, colonIdx));
    const moduleDeps = trimmed
      .slice(colonIdx + 1)
      .split(/\s+/)
      .filter(Boolean)
      .map((entry) => normalizeModulePath(entry));

    deps.set(modulePath, moduleDeps);
  }

  return deps;
}

function readBuiltinModuleNames(srcDir: string): Set<string> {
  const builtinFile = path.join(srcDir, "modules.builtin");
  const names = new Set<string>();

  if (!fs.existsSync(builtinFile)) {
    return names;
  }

  for (const line of fs.readFileSync(builtinFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    names.add(normalizeModuleName(moduleNameFromPath(trimmed)));
  }

  return names;
}

function indexModulePathsByName(
  srcDir: string,
  deps: Map<string, string[]>,
): Map<string, string> {
  const byName = new Map<string, Set<string>>();

  const add = (modulePath: string) => {
    const normalizedPath = normalizeModulePath(modulePath);
    const moduleName = normalizeModuleName(moduleNameFromPath(normalizedPath));
    if (!moduleName) return;

    let paths = byName.get(moduleName);
    if (!paths) {
      paths = new Set<string>();
      byName.set(moduleName, paths);
    }
    paths.add(normalizedPath);
  };

  for (const [modulePath, moduleDeps] of deps) {
    add(modulePath);
    for (const depPath of moduleDeps) {
      add(depPath);
    }
  }

  for (const modulePath of listModuleFiles(srcDir)) {
    add(modulePath);
  }

  const resolved = new Map<string, string>();
  for (const [name, candidates] of byName) {
    const preferred = pickPreferredModulePath(Array.from(candidates), deps);
    if (preferred) {
      resolved.set(name, preferred);
    }
  }

  return resolved;
}

function pickPreferredModulePath(
  candidates: string[],
  deps: Map<string, string[]>,
): string | undefined {
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    const depKeyDiff = Number(!deps.has(a)) - Number(!deps.has(b));
    if (depKeyDiff !== 0) return depKeyDiff;

    const suffixDiff = moduleSuffixPriority(a) - moduleSuffixPriority(b);
    if (suffixDiff !== 0) return suffixDiff;

    return a.localeCompare(b);
  });

  return candidates[0];
}

function resolveModulePath(
  srcDir: string,
  modulePath: string,
  modulePathByName: Map<string, string>,
): string | undefined {
  const normalizedPath = normalizeModulePath(modulePath);
  if (fs.existsSync(path.join(srcDir, normalizedPath))) {
    return normalizedPath;
  }

  const moduleName = normalizeModuleName(moduleNameFromPath(normalizedPath));
  return modulePathByName.get(moduleName);
}

function listModuleFiles(srcDir: string, relativeDir = ""): string[] {
  const absDir = path.join(srcDir, relativeDir);
  if (!fs.existsSync(absDir)) {
    return [];
  }

  const out: string[] = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listModuleFiles(srcDir, relPath));
      continue;
    }
    if (entry.isFile() && isModuleFile(relPath)) {
      out.push(relPath);
    }
  }

  return out;
}

function isModuleFile(modulePath: string): boolean {
  return MODULE_FILE_SUFFIXES.some((suffix) => modulePath.endsWith(suffix));
}

function moduleSuffixPriority(modulePath: string): number {
  for (let i = 0; i < MODULE_FILE_SUFFIXES.length; i += 1) {
    if (modulePath.endsWith(MODULE_FILE_SUFFIXES[i])) {
      return i;
    }
  }
  return MODULE_FILE_SUFFIXES.length;
}

function moduleNameFromPath(modulePath: string): string {
  const base = path.posix.basename(normalizeModulePath(modulePath));
  for (const suffix of MODULE_FILE_SUFFIXES) {
    if (base.endsWith(suffix)) {
      return base.slice(0, -suffix.length);
    }
  }
  return base;
}

function normalizeModulePath(modulePath: string): string {
  return modulePath.replace(/\\/g, "/").trim();
}

function normalizeModuleName(moduleName: string): string {
  return moduleName.replace(/-/g, "_");
}
