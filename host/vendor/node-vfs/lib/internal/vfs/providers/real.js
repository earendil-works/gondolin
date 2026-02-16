'use strict';

const {
  Promise,
  StringPrototypeStartsWith,
} = primordials;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { VirtualProvider } = require('internal/vfs/provider');
const { VirtualFileHandle } = require('internal/vfs/file_handle');
const {
  codes: {
    ERR_INVALID_ARG_VALUE,
  },
} = require('internal/errors');

const { errno: ERRNO } = os.constants;

/**
 * A file handle that wraps a real file descriptor.
 */
class RealFileHandle extends VirtualFileHandle {
  #fd;
  #realPath;

  /**
   * @param {string} path The VFS path
   * @param {string} flags The open flags
   * @param {number} mode The file mode
   * @param {number} fd The real file descriptor
   * @param {string} realPath The real filesystem path
   */
  constructor(path, flags, mode, fd, realPath) {
    super(path, flags, mode);
    this.#fd = fd;
    this.#realPath = realPath;
  }

  /**
   * Gets the real file descriptor.
   * @returns {number}
   */
  get fd() {
    return this.#fd;
  }

  readSync(buffer, offset, length, position) {
    this._checkClosed();
    return fs.readSync(this.#fd, buffer, offset, length, position);
  }

  async read(buffer, offset, length, position) {
    this._checkClosed();
    return new Promise((resolve, reject) => {
      fs.read(this.#fd, buffer, offset, length, position, (err, bytesRead) => {
        if (err) reject(err);
        else resolve({ __proto__: null, bytesRead, buffer });
      });
    });
  }

  writeSync(buffer, offset, length, position) {
    this._checkClosed();
    return fs.writeSync(this.#fd, buffer, offset, length, position);
  }

  async write(buffer, offset, length, position) {
    this._checkClosed();
    return new Promise((resolve, reject) => {
      fs.write(this.#fd, buffer, offset, length, position, (err, bytesWritten) => {
        if (err) reject(err);
        else resolve({ __proto__: null, bytesWritten, buffer });
      });
    });
  }

  readFileSync(options) {
    this._checkClosed();
    return fs.readFileSync(this.#realPath, options);
  }

  async readFile(options) {
    this._checkClosed();
    return fs.promises.readFile(this.#realPath, options);
  }

  writeFileSync(data, options) {
    this._checkClosed();
    fs.writeFileSync(this.#realPath, data, options);
  }

  async writeFile(data, options) {
    this._checkClosed();
    return fs.promises.writeFile(this.#realPath, data, options);
  }

  statSync(options) {
    this._checkClosed();
    return fs.fstatSync(this.#fd, options);
  }

  async stat(options) {
    this._checkClosed();
    return new Promise((resolve, reject) => {
      fs.fstat(this.#fd, options, (err, stats) => {
        if (err) reject(err);
        else resolve(stats);
      });
    });
  }

  truncateSync(len = 0) {
    this._checkClosed();
    fs.ftruncateSync(this.#fd, len);
  }

  async truncate(len = 0) {
    this._checkClosed();
    return new Promise((resolve, reject) => {
      fs.ftruncate(this.#fd, len, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  closeSync() {
    if (!this.closed) {
      fs.closeSync(this.#fd);
      super.closeSync();
    }
  }

  async close() {
    if (!this.closed) {
      return new Promise((resolve, reject) => {
        fs.close(this.#fd, (err) => {
          if (err) reject(err);
          else {
            super.closeSync();
            resolve();
          }
        });
      });
    }
  }
}

/**
 * A provider that wraps a real filesystem directory.
 * Allows mounting a real directory at a different VFS path.
 */
class RealFSProvider extends VirtualProvider {
  #rootPath;

  /**
   * @param {string} rootPath The real filesystem path to use as root
   */
  constructor(rootPath) {
    super();
    if (typeof rootPath !== 'string' || rootPath === '') {
      throw new ERR_INVALID_ARG_VALUE('rootPath', rootPath, 'must be a non-empty string');
    }
    // Resolve to absolute path and normalize.
    //
    // On macOS (and some Linux setups) common temp paths (e.g. /var/...) may be
    // symlinks into /private/..., which can cause realpath() checks/conversions
    // to incorrectly treat in-root paths as escaped.  Prefer a canonical
    // realpath when available.
    const resolvedRoot = path.resolve(rootPath);
    try {
      this.#rootPath = fs.realpathSync(resolvedRoot);
    } catch {
      this.#rootPath = resolvedRoot;
    }
  }

  /**
   * Gets the root path of this provider.
   * @returns {string}
   */
  get rootPath() {
    return this.#rootPath;
  }

  get readonly() {
    return false;
  }

  get supportsSymlinks() {
    return true;
  }

  // _resolvePathLexical: lexical containment only (lstat, readlink, unlink, etc.)
  // _resolvePathFollow:  lexical + realpath verification (open, stat, readdir, etc.)
  _resolvePathLexical(vfsPath) {
    let normalized = vfsPath;
    if (normalized.startsWith('/')) {
      normalized = normalized.slice(1);
    }

    const realPath = path.resolve(this.#rootPath, normalized);

    const rootWithSep = this.#rootPath.endsWith(path.sep) ?
      this.#rootPath :
      this.#rootPath + path.sep;

    if (realPath !== this.#rootPath && !StringPrototypeStartsWith(realPath, rootWithSep)) {
      const { createENOENT } = require('internal/vfs/errors');
      throw createENOENT('open', vfsPath);
    }

    return realPath;
  }

  _isInsideRoot(resolvedPath) {
    if (resolvedPath === this.#rootPath) return true;
    const rootWithSep = this.#rootPath.endsWith(path.sep) ?
      this.#rootPath :
      this.#rootPath + path.sep;
    return StringPrototypeStartsWith(resolvedPath, rootWithSep);
  }

  _assertAncestorWithinRoot(realPath, vfsPath) {
    let current = realPath;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) break; // reached filesystem root

      let resolvedParent = null;
      try {
        resolvedParent = fs.realpathSync(parent);
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          current = parent;
          continue;
        }
        throw e;
      }

      if (!this._isInsideRoot(resolvedParent)) {
        const { createENOENT } = require('internal/vfs/errors');
        throw createENOENT('open', vfsPath);
      }
      return; // found a safe existing ancestor
    }
  }

  _resolvePathFollow(vfsPath) {
    const realPath = this._resolvePathLexical(vfsPath);
    const { createENOENT } = require('internal/vfs/errors');

    let resolved = null;
    let realpathError = null;
    try {
      resolved = fs.realpathSync(realPath);
    } catch (error) {
      realpathError = error;
    }

    if (resolved !== null) {
      if (!this._isInsideRoot(resolved)) {
        throw createENOENT('open', vfsPath);
      }
      return realPath;
    }

    if (!realpathError || realpathError.code !== 'ENOENT') {
      throw realpathError;
    }

    // Check if the path is a dangling symlink.
    let isSymlink = false;
    try {
      const lst = fs.lstatSync(realPath);
      isSymlink = lst.isSymbolicLink();
    } catch (lstatErr) {
      if (lstatErr && lstatErr.code !== 'ENOENT') {
        throw lstatErr;
      }
    }

    if (isSymlink) {
      let current = realPath;
      const seen = new Set();
      while (true) {
        if (seen.has(current)) {
          throw createENOENT('open', vfsPath);
        }
        seen.add(current);
        let lst;
        try {
          lst = fs.lstatSync(current);
        } catch (e) {
          if (e && e.code === 'ENOENT') break;
          throw e;
        }
        if (!lst.isSymbolicLink()) break;
        const target = fs.readlinkSync(current);
        current = path.resolve(path.dirname(current), target);
        if (!this._isInsideRoot(current)) {
          throw createENOENT('open', vfsPath);
        }
      }
      this._assertAncestorWithinRoot(current, vfsPath);
      return realPath;
    }

    this._assertAncestorWithinRoot(realPath, vfsPath);

    return realPath;
  }

  openSync(vfsPath, flags, mode) {
    const realPath = this._resolvePathFollow(vfsPath);
    const fd = fs.openSync(realPath, flags, mode);
    return new RealFileHandle(vfsPath, flags, mode ?? 0o644, fd, realPath);
  }

  async open(vfsPath, flags, mode) {
    const realPath = this._resolvePathFollow(vfsPath);
    return new Promise((resolve, reject) => {
      fs.open(realPath, flags, mode, (err, fd) => {
        if (err) reject(err);
        else resolve(new RealFileHandle(vfsPath, flags, mode ?? 0o644, fd, realPath));
      });
    });
  }

  statSync(vfsPath, options) {
    const realPath = this._resolvePathFollow(vfsPath);
    return fs.statSync(realPath, options);
  }

  async stat(vfsPath, options) {
    const realPath = this._resolvePathFollow(vfsPath);
    return fs.promises.stat(realPath, options);
  }

  lstatSync(vfsPath, options) {
    const realPath = this._resolvePathLexical(vfsPath);
    return fs.lstatSync(realPath, options);
  }

  async lstat(vfsPath, options) {
    const realPath = this._resolvePathLexical(vfsPath);
    return fs.promises.lstat(realPath, options);
  }

  readdirSync(vfsPath, options) {
    const realPath = this._resolvePathFollow(vfsPath);
    return fs.readdirSync(realPath, options);
  }

  async readdir(vfsPath, options) {
    const realPath = this._resolvePathFollow(vfsPath);
    return fs.promises.readdir(realPath, options);
  }

  mkdirSync(vfsPath, options) {
    const realPath = this._resolvePathFollow(vfsPath);
    return fs.mkdirSync(realPath, options);
  }

  async mkdir(vfsPath, options) {
    const realPath = this._resolvePathFollow(vfsPath);
    return fs.promises.mkdir(realPath, options);
  }

  rmdirSync(vfsPath) {
    const realPath = this._resolvePathFollow(vfsPath);
    fs.rmdirSync(realPath);
  }

  async rmdir(vfsPath) {
    const realPath = this._resolvePathFollow(vfsPath);
    return fs.promises.rmdir(realPath);
  }

  unlinkSync(vfsPath) {
    const realPath = this._resolvePathLexical(vfsPath);
    fs.unlinkSync(realPath);
  }

  async unlink(vfsPath) {
    const realPath = this._resolvePathLexical(vfsPath);
    return fs.promises.unlink(realPath);
  }

  renameSync(oldVfsPath, newVfsPath) {
    const oldRealPath = this._resolvePathFollow(oldVfsPath);
    const newRealPath = this._resolvePathFollow(newVfsPath);
    fs.renameSync(oldRealPath, newRealPath);
  }

  async rename(oldVfsPath, newVfsPath) {
    const oldRealPath = this._resolvePathFollow(oldVfsPath);
    const newRealPath = this._resolvePathFollow(newVfsPath);
    return fs.promises.rename(oldRealPath, newRealPath);
  }

  linkSync(existingVfsPath, newVfsPath) {
    const existingRealPath = this._resolvePathFollow(existingVfsPath);
    const newRealPath = this._resolvePathLexical(newVfsPath);
    fs.linkSync(existingRealPath, newRealPath);
  }

  async link(existingVfsPath, newVfsPath) {
    const existingRealPath = this._resolvePathFollow(existingVfsPath);
    const newRealPath = this._resolvePathLexical(newVfsPath);
    return fs.promises.link(existingRealPath, newRealPath);
  }

  readlinkSync(vfsPath, options) {
    const realPath = this._resolvePathLexical(vfsPath);
    return fs.readlinkSync(realPath, options);
  }

  async readlink(vfsPath, options) {
    const realPath = this._resolvePathLexical(vfsPath);
    return fs.promises.readlink(realPath, options);
  }

  symlinkSync(target, vfsPath, type) {
    const realPath = this._resolvePathFollow(vfsPath);
    fs.symlinkSync(target, realPath, type);
  }

  async symlink(target, vfsPath, type) {
    const realPath = this._resolvePathFollow(vfsPath);
    return fs.promises.symlink(target, realPath, type);
  }

  realpathSync(vfsPath, options) {
    const realPath = this._resolvePathFollow(vfsPath);
    const resolved = fs.realpathSync(realPath, options);
    // Convert back to VFS path
    if (resolved === this.#rootPath) {
      return '/';
    }
    const rootWithSep = this.#rootPath + path.sep;
    if (StringPrototypeStartsWith(resolved, rootWithSep)) {
      return '/' + resolved.slice(rootWithSep.length).replace(/\\/g, '/');
    }
    // Path escaped root (shouldn't happen normally)
    return vfsPath;
  }

  async realpath(vfsPath, options) {
    const realPath = this._resolvePathFollow(vfsPath);
    const resolved = await fs.promises.realpath(realPath, options);
    // Convert back to VFS path
    if (resolved === this.#rootPath) {
      return '/';
    }
    const rootWithSep = this.#rootPath + path.sep;
    if (StringPrototypeStartsWith(resolved, rootWithSep)) {
      return '/' + resolved.slice(rootWithSep.length).replace(/\\/g, '/');
    }
    return vfsPath;
  }

  accessSync(vfsPath, mode) {
    const realPath = this._resolvePathFollow(vfsPath);
    fs.accessSync(realPath, mode);
  }

  async access(vfsPath, mode) {
    const realPath = this._resolvePathFollow(vfsPath);
    return fs.promises.access(realPath, mode);
  }

  copyFileSync(srcVfsPath, destVfsPath, mode) {
    const srcRealPath = this._resolvePathFollow(srcVfsPath);
    const destRealPath = this._resolvePathFollow(destVfsPath);
    fs.copyFileSync(srcRealPath, destRealPath, mode);
  }

  async copyFile(srcVfsPath, destVfsPath, mode) {
    const srcRealPath = this._resolvePathFollow(srcVfsPath);
    const destRealPath = this._resolvePathFollow(destVfsPath);
    return fs.promises.copyFile(srcRealPath, destRealPath, mode);
  }

  async statfs(vfsPath) {
    if (typeof fs.promises.statfs !== 'function') {
      const err = new Error('ENOSYS: statfs');
      err.code = 'ENOSYS';
      err.errno = ERRNO.ENOSYS;
      throw err;
    }

    const realPath = this._resolvePathFollow(vfsPath);
    const stats = await fs.promises.statfs(realPath);
    const bsize = Number(stats.bsize ?? 4096);

    return {
      blocks: Number(stats.blocks ?? 0),
      bfree: Number(stats.bfree ?? 0),
      bavail: Number(stats.bavail ?? 0),
      files: Number(stats.files ?? 0),
      ffree: Number(stats.ffree ?? 0),
      bsize,
      frsize: Number(stats.frsize ?? bsize),
      namelen: Number(stats.namelen ?? 255),
    };
  }
}

module.exports = {
  RealFSProvider,
  RealFileHandle,
};
