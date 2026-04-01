import fs from "fs";
import net from "net";
import path from "path";
import { WASI } from "node:wasi";
import { Worker } from "node:worker_threads";

type RunnerPreopen = {
  /** host directory path */
  hostPath: string;
  /** guest-visible mount path */
  guestPath: string;
  /** whether writes must be denied */
  readOnly: boolean;
};

type RunnerArgs = {
  /** wasm module path */
  wasmPath: string;
  /** optional unix socket path for qemu-network backend framing */
  netSocketPath?: string;
  /** wasi preopened host directories */
  preopens: RunnerPreopen[];
  /** argv forwarded to the wasm module */
  wasmArgs: string[];
};

type WasiEnv = Record<string, string>;

const NET_LISTEN_FD = 1024;
const NET_CONN_FD = 1025;

const WASI_RIGHT_FD_WRITE = 1n << 6n;
const WASI_OFLAGS_CREAT = 1;
const WASI_OFLAGS_TRUNC = 8;

const DEBUG_NET = process.env.GONDOLIN_WASM_NET_DEBUG === "1";
function debugNet(message: string): void {
  if (!DEBUG_NET) return;
  process.stderr.write(`[wasm-net] ${message}\n`);
}

const WASI_ERRNO_SUCCESS = 0;
const WASI_ERRNO_AGAIN = 6;
const WASI_ERRNO_BADF = 8;
const WASI_ERRNO_ROFS = 69;

type NetBridge = {
  socket: net.Socket;
  /** underlying unix socket file descriptor */
  fd: number | null;
  /** framed bytes queued from host network backend */
  rxBuffer: Buffer;
  /** whether the synthetic accepted connection was handed out */
  accepted: boolean;
  /** whether upstream socket reached EOF */
  ended: boolean;
};

type StdinBridge = {
  worker: Worker;
  state: Int32Array;
  data: Uint8Array;
};

const STDIN_WRITE_POS = 0;
const STDIN_READ_POS = 1;
const STDIN_CLOSED = 2;
const STDIN_WAKE_SEQ = 3;

function readIOVs(
  view: DataView,
  iovsPtr: number,
  iovsLen: number,
): Uint8Array[] {
  const buffers: Uint8Array[] = [];
  for (let i = 0; i < iovsLen; i += 1) {
    const ptr = view.getUint32(iovsPtr + i * 8, true);
    const len = view.getUint32(iovsPtr + i * 8 + 4, true);
    buffers.push(new Uint8Array(view.buffer, ptr, len));
  }
  return buffers;
}

function writeIOVs(
  view: DataView,
  iovsPtr: number,
  iovsLen: number,
  data: Buffer,
): number {
  let bytesWritten = 0;
  let dataOffset = 0;

  for (let i = 0; i < iovsLen && dataOffset < data.length; i += 1) {
    const ptr = view.getUint32(iovsPtr + i * 8, true);
    const len = view.getUint32(iovsPtr + i * 8 + 4, true);
    const chunkLen = Math.min(len, data.length - dataOffset);
    const dest = new Uint8Array(view.buffer, ptr, chunkLen);
    dest.set(data.subarray(dataOffset, dataOffset + chunkLen));
    bytesWritten += chunkLen;
    dataOffset += chunkLen;
  }

  return bytesWritten;
}

function writePollEvent(
  view: DataView,
  outPtr: number,
  index: number,
  userdata: bigint,
  eventType: number,
  nbytes: number,
): void {
  const base = outPtr + index * 32;
  view.setBigUint64(base, userdata, true);
  view.setUint16(base + 8, 0, true);
  view.setUint8(base + 10, eventType);
  view.setBigUint64(base + 16, BigInt(Math.max(0, nbytes)), true);
}

function connectNetBridge(socketPath: string): Promise<NetBridge> {
  return new Promise<NetBridge>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });

    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      socket.setNoDelay(true);
      debugNet(`connected net socket ${socketPath}`);
      resolve({
        socket,
        fd:
          typeof (socket as any)?._handle?.fd === "number"
            ? ((socket as any)._handle.fd as number)
            : null,
        rxBuffer: Buffer.alloc(0),
        accepted: false,
        ended: false,
      });
    });
  });
}

function pumpNetSocket(netBridge: NetBridge): void {
  if (netBridge.ended || netBridge.fd === null) {
    return;
  }

  const scratch = Buffer.allocUnsafe(64 * 1024);

  while (true) {
    let n = 0;
    try {
      n = fs.readSync(netBridge.fd, scratch, 0, scratch.length, null);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        return;
      }
      if (code === "EINTR") {
        continue;
      }
      netBridge.ended = true;
      return;
    }

    if (n <= 0) {
      netBridge.ended = true;
      return;
    }

    netBridge.rxBuffer = Buffer.concat([netBridge.rxBuffer, scratch.subarray(0, n)]);
    debugNet(`rx ${n} bytes (buffer=${netBridge.rxBuffer.length})`);

    if (n < scratch.length) {
      return;
    }
  }
}

function createStdinBridge(): StdinBridge {
  const stateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
  const dataBuffer = new SharedArrayBuffer(256 * 1024);

  const state = new Int32Array(stateBuffer);
  const data = new Uint8Array(dataBuffer);

  const worker = new Worker(
    new URL("./wasm-runner-stdin-worker.ts", import.meta.url),
    {
      workerData: {
        fd: 0,
        state: stateBuffer,
        data: dataBuffer,
      },
    },
  );

  worker.on("error", (err) => {
    debugNet(`stdin worker error: ${err.message}`);
    Atomics.store(state, STDIN_CLOSED, 1);
    Atomics.add(state, STDIN_WAKE_SEQ, 1);
    Atomics.notify(state, STDIN_WAKE_SEQ);
  });

  return {
    worker,
    state,
    data,
  };
}

function stdinAvailable(bridge: StdinBridge): number {
  const writePos = Atomics.load(bridge.state, STDIN_WRITE_POS);
  const readPos = Atomics.load(bridge.state, STDIN_READ_POS);
  return Math.max(0, writePos - readPos);
}

function stdinClosed(bridge: StdinBridge): boolean {
  return Atomics.load(bridge.state, STDIN_CLOSED) !== 0;
}

function readFromStdinBridge(
  bridge: StdinBridge,
  view: DataView,
  iovsPtr: number,
  iovsLen: number,
): number {
  let available = stdinAvailable(bridge);
  if (available <= 0) {
    return 0;
  }

  let readPos = Atomics.load(bridge.state, STDIN_READ_POS);
  let total = 0;

  for (let i = 0; i < iovsLen && available > 0; i += 1) {
    const ptr = view.getUint32(iovsPtr + i * 8, true);
    const len = view.getUint32(iovsPtr + i * 8 + 4, true);
    if (len === 0) continue;

    let remaining = Math.min(len, available);
    let destOffset = 0;
    const dest = new Uint8Array(view.buffer, ptr, remaining);

    while (remaining > 0) {
      const ringOffset = readPos % bridge.data.length;
      const chunkLen = Math.min(remaining, bridge.data.length - ringOffset);
      dest.set(
        bridge.data.subarray(ringOffset, ringOffset + chunkLen),
        destOffset,
      );
      readPos += chunkLen;
      destOffset += chunkLen;
      remaining -= chunkLen;
      available -= chunkLen;
      total += chunkLen;
    }
  }

  Atomics.store(bridge.state, STDIN_READ_POS, readPos);
  Atomics.add(bridge.state, STDIN_WAKE_SEQ, 1);
  Atomics.notify(bridge.state, STDIN_WAKE_SEQ);

  return total;
}

function buildWasiEnv(
  input: NodeJS.ProcessEnv,
  options: { enableNetwork: boolean },
): WasiEnv {
  const env: WasiEnv = {
    // Keep stdio mode explicit for gondolin wasm guest startup scripts.
    GONDOLIN_SANDBOXD_TRANSPORT: "stdio",
  };

  if (options.enableNetwork) {
    env.LISTEN_FDS = "1";
  }

  const passthrough = ["TERM", "LANG", "LC_ALL", "TZ"] as const;
  for (const key of passthrough) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  return env;
}

function parsePreopenSpec(raw: string, readOnly: boolean): RunnerPreopen {
  const separator = raw.indexOf("::");
  if (separator <= 0 || separator + 2 >= raw.length) {
    throw new Error("preopen value must be HOST::GUEST");
  }

  const hostPathInput = raw.slice(0, separator).trim();
  const guestPathInput = raw.slice(separator + 2).trim();

  if (!hostPathInput) {
    throw new Error("preopen host path is empty");
  }
  if (!guestPathInput.startsWith("/")) {
    throw new Error(`preopen guest path must be absolute: ${guestPathInput}`);
  }

  const hostPath = path.resolve(hostPathInput);
  const stat = fs.statSync(hostPath, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`preopen host path does not exist: ${hostPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`preopen host path is not a directory: ${hostPath}`);
  }

  const guestPath =
    guestPathInput.length > 1
      ? guestPathInput.replace(/\/+$/, "") || "/"
      : "/";

  if (guestPath === "/") {
    throw new Error("preopen guest path / is reserved");
  }

  return {
    hostPath,
    guestPath,
    readOnly,
  };
}

function asBigInt(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function hasWriteIntent(oflags: number, fsRightsBase: number | bigint): boolean {
  if ((oflags & WASI_OFLAGS_CREAT) !== 0 || (oflags & WASI_OFLAGS_TRUNC) !== 0) {
    return true;
  }
  return (asBigInt(fsRightsBase) & WASI_RIGHT_FD_WRITE) !== 0n;
}

function parseArgs(argv: string[]): RunnerArgs {
  let wasmPath: string | null = null;
  let netSocketPath: string | undefined;
  const preopens: RunnerPreopen[] = [];
  const passthrough: string[] = [];
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (afterDoubleDash) {
      passthrough.push(arg);
      continue;
    }

    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: node wasm-runner.ts --wasm PATH [--net-socket PATH] [--preopen HOST::GUEST] [--preopen-ro HOST::GUEST] [-- ARG ...]\n" +
          "runs a wasi module and wires stdin/stdout/stderr directly",
      );
    }

    if (arg === "--wasm") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--wasm requires a path");
      }
      wasmPath = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--wasm=")) {
      wasmPath = arg.slice("--wasm=".length);
      continue;
    }

    if (arg === "--net-socket") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--net-socket requires a path");
      }
      netSocketPath = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--net-socket=")) {
      const value = arg.slice("--net-socket=".length).trim();
      if (!value) {
        throw new Error("--net-socket requires a path");
      }
      netSocketPath = value;
      continue;
    }

    if (arg === "--preopen" || arg === "--preopen-ro") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a HOST::GUEST value`);
      }
      preopens.push(parsePreopenSpec(value, arg === "--preopen-ro"));
      i += 1;
      continue;
    }

    if (arg.startsWith("--preopen=")) {
      const value = arg.slice("--preopen=".length).trim();
      if (!value) {
        throw new Error("--preopen requires a HOST::GUEST value");
      }
      preopens.push(parsePreopenSpec(value, false));
      continue;
    }

    if (arg.startsWith("--preopen-ro=")) {
      const value = arg.slice("--preopen-ro=".length).trim();
      if (!value) {
        throw new Error("--preopen-ro requires a HOST::GUEST value");
      }
      preopens.push(parsePreopenSpec(value, true));
      continue;
    }

    throw new Error(`unknown wasm-runner argument: ${arg}`);
  }

  if (!wasmPath) {
    throw new Error("missing --wasm path");
  }

  return {
    wasmPath: wasmPath,
    netSocketPath,
    preopens,
    wasmArgs: passthrough,
  };
}

async function runWasi(args: RunnerArgs): Promise<void> {
  if (!fs.existsSync(args.wasmPath)) {
    throw new Error(`wasm module does not exist: ${args.wasmPath}`);
  }

  const moduleBytes = await fs.promises.readFile(args.wasmPath);
  const module = await WebAssembly.compile(moduleBytes);

  const enableNetwork =
    typeof args.netSocketPath === "string" && args.netSocketPath.length > 0;

  const moduleArgs =
    enableNetwork && !args.wasmArgs.includes("-net")
      ? ["-net", `socket=listenfd=${NET_LISTEN_FD}`, ...args.wasmArgs]
      : args.wasmArgs;

  const preopenEntries: Array<[string, string]> = [["/", "/"]];
  const readOnlyGuestPaths = new Set<string>();
  for (const preopen of args.preopens) {
    if (preopen.guestPath === "/") {
      throw new Error("preopen guest path / is reserved");
    }
    if (preopenEntries.some(([guestPath]) => guestPath === preopen.guestPath)) {
      throw new Error(`duplicate preopen guest path: ${preopen.guestPath}`);
    }
    preopenEntries.push([preopen.guestPath, preopen.hostPath]);
    if (preopen.readOnly) {
      readOnlyGuestPaths.add(preopen.guestPath);
    }
  }

  const readOnlyFds = new Set<number>();
  for (let i = 0; i < preopenEntries.length; i += 1) {
    const guestPath = preopenEntries[i]![0];
    if (readOnlyGuestPaths.has(guestPath)) {
      readOnlyFds.add(3 + i);
    }
  }

  const wasi = new WASI({
    version: "preview1",
    args: [args.wasmPath, ...moduleArgs],
    env: buildWasiEnv(process.env, { enableNetwork }),
    preopens: Object.fromEntries(preopenEntries),
  });

  const wasiImport = wasi.wasiImport as Record<string, any>;
  const netBridge = enableNetwork
    ? await connectNetBridge(args.netSocketPath!)
    : null;
  const stdinBridge = netBridge ? createStdinBridge() : null;

  let instanceRef: WebAssembly.Instance | null = null;
  const getView = (): DataView | null => {
    const instance = instanceRef;
    if (!instance) return null;
    const memory = (instance.exports as Record<string, unknown>).memory;
    if (!(memory instanceof WebAssembly.Memory)) return null;
    return new DataView(memory.buffer);
  };

  if (readOnlyFds.size > 0) {
    const originalPathOpen = wasiImport.path_open;
    wasiImport.path_open = (
      fd: number,
      dirflags: number,
      pathPtr: number,
      pathLen: number,
      oflags: number,
      fsRightsBase: number | bigint,
      fsRightsInheriting: number | bigint,
      fdflags: number,
      openedFdPtr: number,
    ) => {
      if (readOnlyFds.has(fd) && hasWriteIntent(oflags, fsRightsBase)) {
        return WASI_ERRNO_ROFS;
      }

      const result = originalPathOpen(
        fd,
        dirflags,
        pathPtr,
        pathLen,
        oflags,
        fsRightsBase,
        fsRightsInheriting,
        fdflags,
        openedFdPtr,
      );

      if (result === WASI_ERRNO_SUCCESS && readOnlyFds.has(fd)) {
        const view = getView();
        if (view) {
          const openedFd = view.getUint32(openedFdPtr, true);
          readOnlyFds.add(openedFd);
        }
      }

      return result;
    };

    const originalPathCreateDirectory = wasiImport.path_create_directory;
    wasiImport.path_create_directory = (
      fd: number,
      pathPtr: number,
      pathLen: number,
    ) => {
      if (readOnlyFds.has(fd)) {
        return WASI_ERRNO_ROFS;
      }
      return originalPathCreateDirectory(fd, pathPtr, pathLen);
    };

    const originalPathUnlinkFile = wasiImport.path_unlink_file;
    wasiImport.path_unlink_file = (
      fd: number,
      pathPtr: number,
      pathLen: number,
    ) => {
      if (readOnlyFds.has(fd)) {
        return WASI_ERRNO_ROFS;
      }
      return originalPathUnlinkFile(fd, pathPtr, pathLen);
    };

    const originalPathRemoveDirectory = wasiImport.path_remove_directory;
    wasiImport.path_remove_directory = (
      fd: number,
      pathPtr: number,
      pathLen: number,
    ) => {
      if (readOnlyFds.has(fd)) {
        return WASI_ERRNO_ROFS;
      }
      return originalPathRemoveDirectory(fd, pathPtr, pathLen);
    };

    const originalPathRename = wasiImport.path_rename;
    wasiImport.path_rename = (
      oldFd: number,
      oldPathPtr: number,
      oldPathLen: number,
      newFd: number,
      newPathPtr: number,
      newPathLen: number,
    ) => {
      if (readOnlyFds.has(oldFd) || readOnlyFds.has(newFd)) {
        return WASI_ERRNO_ROFS;
      }
      return originalPathRename(
        oldFd,
        oldPathPtr,
        oldPathLen,
        newFd,
        newPathPtr,
        newPathLen,
      );
    };

    const originalPathLink = wasiImport.path_link;
    wasiImport.path_link = (
      oldFd: number,
      oldFlags: number,
      oldPathPtr: number,
      oldPathLen: number,
      newFd: number,
      newPathPtr: number,
      newPathLen: number,
    ) => {
      if (readOnlyFds.has(oldFd) || readOnlyFds.has(newFd)) {
        return WASI_ERRNO_ROFS;
      }
      return originalPathLink(
        oldFd,
        oldFlags,
        oldPathPtr,
        oldPathLen,
        newFd,
        newPathPtr,
        newPathLen,
      );
    };

    const originalPathSymlink = wasiImport.path_symlink;
    wasiImport.path_symlink = (
      oldPathPtr: number,
      oldPathLen: number,
      fd: number,
      newPathPtr: number,
      newPathLen: number,
    ) => {
      if (readOnlyFds.has(fd)) {
        return WASI_ERRNO_ROFS;
      }
      return originalPathSymlink(
        oldPathPtr,
        oldPathLen,
        fd,
        newPathPtr,
        newPathLen,
      );
    };

    const originalFdWrite = wasiImport.fd_write;
    wasiImport.fd_write = (
      fd: number,
      iovsPtr: number,
      iovsLen: number,
      nwrittenPtr: number,
    ) => {
      if (readOnlyFds.has(fd)) {
        return WASI_ERRNO_ROFS;
      }
      return originalFdWrite(fd, iovsPtr, iovsLen, nwrittenPtr);
    };

    const originalFdPwrite = wasiImport.fd_pwrite;
    if (typeof originalFdPwrite === "function") {
      wasiImport.fd_pwrite = (
        fd: number,
        iovsPtr: number,
        iovsLen: number,
        offset: bigint,
        nwrittenPtr: number,
      ) => {
        if (readOnlyFds.has(fd)) {
          return WASI_ERRNO_ROFS;
        }
        return originalFdPwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr);
      };
    }

    const originalFdFilestatSetSize = wasiImport.fd_filestat_set_size;
    if (typeof originalFdFilestatSetSize === "function") {
      wasiImport.fd_filestat_set_size = (fd: number, size: bigint) => {
        if (readOnlyFds.has(fd)) {
          return WASI_ERRNO_ROFS;
        }
        return originalFdFilestatSetSize(fd, size);
      };
    }

    const originalFdFilestatSetTimes = wasiImport.fd_filestat_set_times;
    if (typeof originalFdFilestatSetTimes === "function") {
      wasiImport.fd_filestat_set_times = (
        fd: number,
        atim: bigint,
        mtim: bigint,
        fstFlags: number,
      ) => {
        if (readOnlyFds.has(fd)) {
          return WASI_ERRNO_ROFS;
        }
        return originalFdFilestatSetTimes(fd, atim, mtim, fstFlags);
      };
    }

    const originalFdClose = wasiImport.fd_close;
    wasiImport.fd_close = (fd: number) => {
      readOnlyFds.delete(fd);
      return originalFdClose(fd);
    };

    const originalFdRenumber = wasiImport.fd_renumber;
    if (typeof originalFdRenumber === "function") {
      wasiImport.fd_renumber = (from: number, to: number) => {
        const result = originalFdRenumber(from, to);
        if (result === WASI_ERRNO_SUCCESS) {
          if (readOnlyFds.has(from)) {
            readOnlyFds.add(to);
            readOnlyFds.delete(from);
          } else {
            readOnlyFds.delete(to);
          }
        }
        return result;
      };
    }
  }

  if (netBridge) {
    // `wasi.start()` runs synchronously, so the Node event loop does not pump
    // socket "data" callbacks while guest code executes. We therefore pull
    // inbound network bytes synchronously via `fs.readSync` in socket-aware
    // syscall handlers (`pumpNetSocket`).
    netBridge.socket.on("end", () => {
      netBridge.ended = true;
    });
    netBridge.socket.on("close", () => {
      netBridge.ended = true;
    });
    netBridge.socket.on("error", () => {
      netBridge.ended = true;
    });

    const originalFdWrite = wasiImport.fd_write;
    wasiImport.fd_write = (
      fd: number,
      iovsPtr: number,
      iovsLen: number,
      nwrittenPtr: number,
    ) => {
      if (fd === NET_LISTEN_FD || fd === NET_CONN_FD) {
        const view = getView();
        if (!view) return WASI_ERRNO_SUCCESS;

        const buffers = readIOVs(view, iovsPtr, iovsLen);
        let total = 0;
        for (const chunk of buffers) {
          const data = Buffer.from(chunk);
          if (data.length === 0) continue;
          total += data.length;
          netBridge.socket.write(data);
        }
        if (total > 0) {
          debugNet(`fd_write fd=${fd} bytes=${total}`);
        }
        view.setUint32(nwrittenPtr, total, true);
        return WASI_ERRNO_SUCCESS;
      }
      return originalFdWrite(fd, iovsPtr, iovsLen, nwrittenPtr);
    };

    const originalFdRead = wasiImport.fd_read;
    wasiImport.fd_read = (
      fd: number,
      iovsPtr: number,
      iovsLen: number,
      nreadPtr: number,
    ) => {
      if (fd === 0 && stdinBridge) {
        const view = getView();
        if (!view) return WASI_ERRNO_SUCCESS;

        const bytesRead = readFromStdinBridge(
          stdinBridge,
          view,
          iovsPtr,
          iovsLen,
        );
        view.setUint32(nreadPtr, bytesRead, true);
        if (bytesRead > 0) {
          debugNet(`stdin fd_read bytes=${bytesRead}`);
        }
        return WASI_ERRNO_SUCCESS;
      }

      if (fd === NET_LISTEN_FD || fd === NET_CONN_FD) {
        const view = getView();
        if (!view) return WASI_ERRNO_SUCCESS;

        pumpNetSocket(netBridge);

        if (netBridge.rxBuffer.length === 0) {
          view.setUint32(nreadPtr, 0, true);
          return WASI_ERRNO_SUCCESS;
        }

        const bytesWritten = writeIOVs(
          view,
          iovsPtr,
          iovsLen,
          netBridge.rxBuffer,
        );
        netBridge.rxBuffer = netBridge.rxBuffer.subarray(bytesWritten);
        if (bytesWritten > 0) {
          debugNet(`fd_read fd=${fd} bytes=${bytesWritten}`);
        }
        view.setUint32(nreadPtr, bytesWritten, true);
        return WASI_ERRNO_SUCCESS;
      }
      return originalFdRead(fd, iovsPtr, iovsLen, nreadPtr);
    };

    const originalFdClose = wasiImport.fd_close;
    wasiImport.fd_close = (fd: number) => {
      if (fd === NET_CONN_FD || fd === NET_LISTEN_FD) {
        try {
          netBridge.socket.end();
        } catch {
          // ignore
        }
        return WASI_ERRNO_SUCCESS;
      }
      return originalFdClose(fd);
    };

    const originalFdFdstatGet = wasiImport.fd_fdstat_get;
    wasiImport.fd_fdstat_get = (fd: number, bufPtr: number) => {
      if (fd === NET_LISTEN_FD || fd === NET_CONN_FD) {
        const view = getView();
        if (!view) return WASI_ERRNO_SUCCESS;

        view.setUint8(bufPtr, 6); // FILETYPE_SOCKET_STREAM
        view.setUint16(bufPtr + 2, 0, true);
        view.setBigUint64(bufPtr + 8, 0xffffffffffffffffn, true);
        view.setBigUint64(bufPtr + 16, 0xffffffffffffffffn, true);
        return WASI_ERRNO_SUCCESS;
      }
      return originalFdFdstatGet(fd, bufPtr);
    };

    const originalPollOneoff = wasiImport.poll_oneoff;
    wasiImport.poll_oneoff = (
      inPtr: number,
      outPtr: number,
      nsubscriptions: number,
      neventsPtr: number,
    ) => {
      const view = getView();
      if (!view) {
        return originalPollOneoff(inPtr, outPtr, nsubscriptions, neventsPtr);
      }

      const clockSubs: Array<{ userdata: bigint }> = [];

      const emitEvents = () => {
        pumpNetSocket(netBridge);
        const stdinBytes = stdinBridge ? stdinAvailable(stdinBridge) : 0;
        const stdinIsClosed = stdinBridge ? stdinClosed(stdinBridge) : false;
        const netReadable =
          netBridge.rxBuffer.length > 0 ||
          netBridge.ended ||
          !netBridge.accepted;
        const netWritable = netBridge.accepted && !netBridge.ended;

        let written = 0;
        clockSubs.length = 0;

        for (let i = 0; i < nsubscriptions; i += 1) {
          const subBase = inPtr + i * 48;
          const userdata = view.getBigUint64(subBase, true);
          const type = view.getUint8(subBase + 8);

          if (type === 0) {
            clockSubs.push({ userdata });
            continue;
          }

          if (type === 1) {
            // FD_READ
            const fd = view.getUint32(subBase + 16, true);
            if (fd === 0 && (stdinBytes > 0 || stdinIsClosed)) {
              writePollEvent(view, outPtr, written, userdata, 1, stdinBytes);
              written += 1;
              continue;
            }
            if (fd === NET_LISTEN_FD && !netBridge.accepted) {
              writePollEvent(view, outPtr, written, userdata, 1, 1);
              written += 1;
              continue;
            }
            if (fd === NET_CONN_FD && netReadable) {
              writePollEvent(
                view,
                outPtr,
                written,
                userdata,
                1,
                Math.max(1, netBridge.rxBuffer.length),
              );
              written += 1;
              continue;
            }
            continue;
          }

          if (type === 2) {
            // FD_WRITE
            const fd = view.getUint32(subBase + 16, true);
            if (fd === 1 || fd === 2) {
              writePollEvent(view, outPtr, written, userdata, 2, 4096);
              written += 1;
              continue;
            }
            if (fd === NET_CONN_FD && netWritable) {
              writePollEvent(view, outPtr, written, userdata, 2, 4096);
              written += 1;
              continue;
            }
          }
        }

        return written;
      };

      let eventsWritten = emitEvents();

      if (eventsWritten === 0 && stdinBridge) {
        const seq = Atomics.load(stdinBridge.state, STDIN_WAKE_SEQ);
        Atomics.wait(stdinBridge.state, STDIN_WAKE_SEQ, seq, 20);
        eventsWritten = emitEvents();
      }

      if (eventsWritten === 0) {
        for (const clockSub of clockSubs) {
          writePollEvent(view, outPtr, eventsWritten, clockSub.userdata, 0, 0);
          eventsWritten += 1;
        }
      }

      view.setUint32(neventsPtr, eventsWritten, true);
      return WASI_ERRNO_SUCCESS;
    };

    wasiImport.sock_accept = (
      fd: number,
      _flags: number,
      resultFdPtr: number,
    ) => {
      if (fd !== NET_LISTEN_FD) {
        return WASI_ERRNO_BADF;
      }
      const view = getView();
      if (!view) return WASI_ERRNO_SUCCESS;

      if (!netBridge.accepted) {
        netBridge.accepted = true;
        view.setUint32(resultFdPtr, NET_CONN_FD, true);
        debugNet("sock_accept -> fd=4");
        return WASI_ERRNO_SUCCESS;
      }

      return WASI_ERRNO_AGAIN;
    };

    wasiImport.sock_recv = (
      fd: number,
      riDataPtr: number,
      riDataLen: number,
      _riFlags: number,
      roDataLenPtr: number,
      roFlagsPtr: number,
    ) => {
      if (fd !== NET_CONN_FD) {
        return WASI_ERRNO_BADF;
      }

      const view = getView();
      if (!view) return WASI_ERRNO_SUCCESS;

      pumpNetSocket(netBridge);

      if (netBridge.rxBuffer.length === 0) {
        view.setUint32(roDataLenPtr, 0, true);
        view.setUint16(roFlagsPtr, 0, true);
        return netBridge.ended ? WASI_ERRNO_SUCCESS : WASI_ERRNO_AGAIN;
      }

      const bytesWritten = writeIOVs(
        view,
        riDataPtr,
        riDataLen,
        netBridge.rxBuffer,
      );
      netBridge.rxBuffer = netBridge.rxBuffer.subarray(bytesWritten);
      if (bytesWritten > 0) {
        debugNet(`sock_recv bytes=${bytesWritten}`);
      }

      view.setUint32(roDataLenPtr, bytesWritten, true);
      view.setUint16(roFlagsPtr, 0, true);
      return WASI_ERRNO_SUCCESS;
    };

    wasiImport.sock_send = (
      fd: number,
      siDataPtr: number,
      siDataLen: number,
      _siFlags: number,
      soDataLenPtr: number,
    ) => {
      if (fd !== NET_CONN_FD) {
        return WASI_ERRNO_BADF;
      }

      const view = getView();
      if (!view) return WASI_ERRNO_SUCCESS;

      const buffers = readIOVs(view, siDataPtr, siDataLen);
      let total = 0;
      for (const chunk of buffers) {
        const data = Buffer.from(chunk);
        if (data.length === 0) continue;
        total += data.length;
        netBridge.socket.write(data);
      }
      if (total > 0) {
        debugNet(`sock_send bytes=${total}`);
      }

      view.setUint32(soDataLenPtr, total, true);
      return WASI_ERRNO_SUCCESS;
    };

    wasiImport.sock_shutdown = (_fd: number, _how: number) => {
      return WASI_ERRNO_SUCCESS;
    };
  }

  try {
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasiImport,
    });
    instanceRef = instance as WebAssembly.Instance;

    wasi.start(instanceRef);
  } finally {
    try {
      netBridge?.socket.destroy();
    } catch {
      // ignore
    }
    try {
      await stdinBridge?.worker.terminate();
    } catch {
      // ignore
    }
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    await runWasi(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[wasm-runner] ${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  void main();
}

export const __test = {
  parseArgs,
};
