'use strict';

import fs from 'node:fs';
import path from 'node:path';
import primordials from './primordials';
import internalBinding from './internal-binding';
import internalModules from './internal-modules';

const cache = new Map<string, { exports: Record<string, unknown> }>();

// node-vfs is located at host/vendor/node-vfs
// Handle both source (src/vfs/node) and compiled (dist/src/vfs/node) paths
function findVendorPath(): string {
  // Try from compiled location first (dist/src/vfs/node -> host/vendor)
  const fromDist = path.resolve(__dirname, '..', '..', '..', '..', 'vendor', 'node-vfs', 'lib', 'internal', 'vfs');
  if (fs.existsSync(fromDist)) {
    return fromDist;
  }
  // Fall back to source location (src/vfs/node -> host/vendor)
  const fromSrc = path.resolve(__dirname, '..', '..', '..', 'vendor', 'node-vfs', 'lib', 'internal', 'vfs');
  return fromSrc;
}

const VENDOR_VFS_PATH = findVendorPath();

function createRequire(parentPath: string) {
  return function vfsRequire(id: string) {
    if (id.startsWith('internal/vfs/')) {
      const modulePath = path.join(VENDOR_VFS_PATH, id.slice('internal/vfs/'.length) + '.js');
      return loadModule(modulePath);
    }

    if (id.startsWith('internal/')) {
      const mod = (internalModules as Record<string, unknown>)[id];
      if (mod) return mod;
      throw new Error(`Unknown internal module: ${id}`);
    }

    return require(id);
  };
}

function loadModule(modulePath: string) {
  if (cache.has(modulePath)) {
    return cache.get(modulePath)!.exports;
  }

  const code = fs.readFileSync(modulePath, 'utf8');
  const mod = { exports: {} as Record<string, unknown> };
  cache.set(modulePath, mod);

  const wrapped = `(function(exports, require, module, __filename, __dirname, primordials, internalBinding) {\n${code}\n})`;
  const fn = eval(wrapped) as (
    exports: Record<string, unknown>,
    require: (id: string) => unknown,
    module: { exports: Record<string, unknown> },
    filename: string,
    dirname: string,
    primordials: unknown,
    internalBinding: unknown
  ) => void;

  const moduleDir = path.dirname(modulePath);
  fn(mod.exports, createRequire(modulePath), mod, modulePath, moduleDir, primordials, internalBinding);

  return mod.exports;
}

function load(name: string) {
  return loadModule(path.join(VENDOR_VFS_PATH, name + '.js'));
}

function loadProvider(name: string) {
  return loadModule(path.join(VENDOR_VFS_PATH, 'providers', name + '.js'));
}

export default { load, loadProvider };
