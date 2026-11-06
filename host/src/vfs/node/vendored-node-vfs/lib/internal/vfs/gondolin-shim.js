'use strict';

const { fileURLToPath, pathToFileURL, URL } = require('node:url');
const Module = require('module');
const path = require('node:path');

// GONDOLIN_VENDORED_NODE_VFS_PATCH: userland shims for Node.js internal runtime globals/modules

const uvErrorNames = {
  [-2]: ['ENOENT', 'no such file or directory'],
  [-20]: ['ENOTDIR', 'not a directory'],
  [-21]: ['EISDIR', 'is a directory'],
  [-39]: ['ENOTEMPTY', 'directory not empty'],
  [-9]: ['EBADF', 'bad file descriptor'],
  [-17]: ['EEXIST', 'file already exists'],
  [-30]: ['EROFS', 'read-only file system'],
  [-22]: ['EINVAL', 'invalid argument'],
  [-40]: ['ELOOP', 'too many symbolic links'],
};

class UVException extends Error {
  constructor({ errno, syscall, path, dest, message }) {
    const [code, desc] = uvErrorNames[errno] || ['UNKNOWN', 'unknown error'];
    let msg = message || `${code}: ${desc}, ${syscall}`;
    if (path) msg += ` '${path}'`;
    if (dest) msg += ` -> '${dest}'`;
    super(msg);
    this.errno = errno;
    this.code = code;
    this.syscall = syscall;
    if (path) this.path = path;
    if (dest) this.dest = dest;
  }
}

class ERR_METHOD_NOT_IMPLEMENTED extends Error {
  constructor(method) {
    super(`Method '${method}' is not implemented`);
    this.code = 'ERR_METHOD_NOT_IMPLEMENTED';
  }
}

class ERR_INVALID_STATE extends Error {
  constructor(msg) {
    super(`Invalid state: ${msg}`);
    this.code = 'ERR_INVALID_STATE';
  }
}

class ERR_INVALID_ARG_VALUE extends TypeError {
  constructor(name, value, reason) {
    super(`The argument '${name}' ${reason}. Received ${String(value)}`);
    this.code = 'ERR_INVALID_ARG_VALUE';
  }
}

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual) {
    super(
      `The "${name}" argument must be of type ${expected}. Received ${typeof actual}`,
    );
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

class Stats {
  constructor(
    dev,
    mode,
    nlink,
    uid,
    gid,
    rdev,
    blksize,
    ino,
    size,
    blocks,
    atimeMs,
    mtimeMs,
    ctimeMs,
    birthtimeMs,
  ) {
    Object.assign(this, {
      dev,
      mode,
      nlink,
      uid,
      gid,
      rdev,
      blksize,
      ino,
      size,
      blocks,
      atimeMs,
      mtimeMs,
      ctimeMs,
      birthtimeMs,
    });
    this.atime = new Date(atimeMs);
    this.mtime = new Date(mtimeMs);
    this.ctime = new Date(ctimeMs);
    this.birthtime = new Date(birthtimeMs);
  }

  isFile() {
    return (this.mode & S_IFMT) === S_IFREG;
  }

  isDirectory() {
    return (this.mode & S_IFMT) === S_IFDIR;
  }

  isSymbolicLink() {
    return (this.mode & S_IFMT) === S_IFLNK;
  }

  isBlockDevice() {
    return false;
  }

  isCharacterDevice() {
    return false;
  }

  isFIFO() {
    return false;
  }

  isSocket() {
    return false;
  }
}

function getStatsFromBinding(bindingStats) {
  return new Stats(
    bindingStats[0],
    bindingStats[1],
    bindingStats[2],
    bindingStats[3],
    bindingStats[4],
    bindingStats[5],
    bindingStats[6],
    bindingStats[7],
    bindingStats[8],
    bindingStats[9],
    bindingStats[10] * 1000 + bindingStats[11] / 1e6,
    bindingStats[12] * 1000 + bindingStats[13] / 1e6,
    bindingStats[14] * 1000 + bindingStats[15] / 1e6,
    bindingStats[16] * 1000 + bindingStats[17] / 1e6,
  );
}

class Dirent {
  constructor(name, type, parentPath) {
    this.name = name;
    this.parentPath = parentPath;
    this.path = parentPath;
    this._type = type;
  }

  isFile() {
    return this._type === 1;
  }

  isDirectory() {
    return this._type === 2;
  }

  isSymbolicLink() {
    return this._type === 3;
  }

  isBlockDevice() {
    return false;
  }

  isCharacterDevice() {
    return false;
  }

  isFIFO() {
    return false;
  }

  isSocket() {
    return false;
  }
}

if (!Module.registerHooks) {
  Module.registerHooks = () => ({
    resolve: () => undefined,
    load: () => undefined,
  });
}

const internalUrl = {
  URL,
  pathToFileURL,
  fileURLToPath,
  isURL(value) {
    return value instanceof URL;
  },
  toPathIfFileURL(value) {
    return value instanceof URL ? fileURLToPath(value) : value;
  },
};

const internalModules = {
  'internal/errors': {
    UVException,
    codes: {
      ERR_METHOD_NOT_IMPLEMENTED,
      ERR_INVALID_STATE,
      ERR_INVALID_ARG_VALUE,
      ERR_INVALID_ARG_TYPE,
    },
  },

  'internal/validators': {
    validateBoolean(value, name) {
      if (typeof value !== 'boolean') {
        throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
      }
    },
    validateObject(value, name) {
      if (value === null || typeof value !== 'object') {
        throw new ERR_INVALID_ARG_TYPE(name, 'object', value);
      }
    },
  },

  'internal/util': {
    kEmptyObject: Object.freeze({ __proto__: null }),
    emitExperimentalWarning() {},
    getLazy(fn) {
      let v;
      let done = false;
      return () => (done ? v : ((done = true), (v = fn())));
    },
  },

  'internal/url': internalUrl,

  'internal/fs/utils': {
    Stats,
    getStatsFromBinding,
    Dirent,
  },

  'internal/modules/cjs/loader': {
    Module,
  },

  'internal/modules/esm/formats': {
    extensionFormatMap: {
      '.cjs': 'commonjs',
      '.mjs': 'module',
      '.js': 'module',
      '.json': 'json',
    },
  },
};

const SymbolDispose = Symbol.dispose ?? Symbol.for('nodejs.dispose');

const primordials = {
  ArrayPrototypeIndexOf: (arr, value) => arr.indexOf(value),
  ArrayPrototypePush: (arr, ...value) => {
    for (const item of value) {
      arr.push(item);
    }
    return arr.length;
  },
  ArrayPrototypeSplice: (arr, ...value) =>
    Array.prototype.splice.apply(arr, value),
  Boolean,
  DateNow: Date.now,
  ErrorCaptureStackTrace: Error.captureStackTrace?.bind(Error) ?? (() => {}),
  Float64Array,
  FunctionPrototypeCall: (fn, thisArg, ...args) => fn.call(thisArg, ...args),
  MathCeil: Math.ceil,
  MathFloor: Math.floor,
  MathMax: Math.max,
  MathMin: Math.min,
  ObjectDefineProperties: Object.defineProperties,
  ObjectDefineProperty: Object.defineProperty,
  ObjectFreeze: Object.freeze,
  Promise,
  PromiseResolve: Promise.resolve.bind(Promise),
  SafeMap: Map,
  SafeSet: Set,
  StringPrototypeEndsWith: (value, suffix) => value.endsWith(suffix),
  StringPrototypeLastIndexOf: (value, search) => value.lastIndexOf(search),
  StringPrototypeReplaceAll: (value, search, replacement) =>
    value.split(search).join(replacement),
  StringPrototypeSlice: (value, start, end) => value.slice(start, end),
  StringPrototypeSplit: (value, delimiter) => value.split(delimiter),
  StringPrototypeStartsWith: (value, prefix) => value.startsWith(prefix),
  Symbol,
  SymbolAsyncIterator: Symbol.asyncIterator,
  SymbolDispose,
};

function internalBinding(name) {
  const bindings = {
    uv: {
      UV_ENOENT: -2,
      UV_ENOTDIR: -20,
      UV_EISDIR: -21,
      UV_ENOTEMPTY: -39,
      UV_EBADF: -9,
      UV_EEXIST: -17,
      UV_EROFS: -30,
      UV_EINVAL: -22,
      UV_ELOOP: -40,
    },
    constants: {
      fs: {
        S_IFMT: 0o170000,
        S_IFREG: 0o100000,
        S_IFDIR: 0o040000,
        S_IFLNK: 0o120000,
        UV_DIRENT_UNKNOWN: 0,
        UV_DIRENT_FILE: 1,
        UV_DIRENT_DIR: 2,
        UV_DIRENT_LINK: 3,
      },
    },
    sea: {
      isSea: () => false,
      getAsset: () => {
        throw new Error('Not a SEA');
      },
      getAssetKeys: () => [],
    },
  };
  if (!bindings[name]) {
    throw new Error(`No such binding: ${name}`);
  }
  return bindings[name];
}

function patchRequire(originalRequire) {
  function patchedRequire(id) {
    if (typeof id === 'string') {
      if (id.startsWith('internal/vfs/')) {
        const modulePath = path.join(
          __dirname,
          id.slice('internal/vfs/'.length) + '.js',
        );
        return originalRequire(modulePath);
      }

      if (Object.prototype.hasOwnProperty.call(internalModules, id)) {
        return internalModules[id];
      }
    }

    return originalRequire(id);
  }

  patchedRequire.resolve = originalRequire.resolve?.bind(originalRequire);
  patchedRequire.main = originalRequire.main;
  patchedRequire.cache = originalRequire.cache;
  patchedRequire.extensions = originalRequire.extensions;

  return patchedRequire;
}

module.exports = {
  primordials,
  internalBinding,
  patchRequire,
};
