/**
 * `NativeSandboxServer`: the sandbox `VM` drives, backed by the native
 * `gondolind` daemon.
 *
 * Sandbox clients (`connect()`) are multiplexed over the daemon connection as
 * numbered clients; the daemon implements the exec, queueing and credit rules
 * and this class translates between the in-process client API (JSON messages
 * + binary output frames) and the daemon protocol.
 *
 * Subsystems (see `native/DESIGN.md`):
 * - VFS: served by the daemon's mount table (`NativeVfs`, `vfs.ts`); JS providers
 *   are reached through the object tier (`vfs_call`);
 * - network: served by the daemon (`NativeNetwork`: netstack, egress, SSH
 *   proxy; JS hooks are called back over the pipe).
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { type Duplex, PassThrough, type Readable } from "node:stream";

import { stripTrailingNewline, type DebugComponent } from "../debug.ts";
import {
  type ClientMessage,
  type ServerMessage,
  encodeOutputFrame,
} from "../sandbox/control-protocol.ts";
import {
  LocalSandboxClient,
  type SandboxClient,
  type SandboxConnection,
} from "../sandbox/client.ts";
import type { SandboxState } from "../sandbox/control-protocol.ts";
import type {
  GuestFileDeleteOptions,
  GuestFileReadOptions,
  GuestFileWriteOptions,
  ResolvedSandboxServerOptions,
  SandboxServerOptions,
  SandboxVmm,
} from "../sandbox/server-options.ts";
import { toBufferIterable } from "../utils/buffer-iter.ts";
import { AsyncSingleflight } from "../utils/async.ts";
import { errorMessage } from "../utils/error.ts";
import { SandboxVfsProvider } from "../vfs/provider.ts";
import {
  type NativeEngineOptions,
  type NativeRemoteConfig,
  type NativeRootDisk,
  assertNativeSupported,
  assertRemoteConfigure,
  buildNativeConfigure,
} from "./config.ts";
import { NativeNetwork } from "./net.ts";
import { NativeVfs, type NativeVfsSpec } from "./vfs.ts";
import { NativeTcpChannelState } from "./tcp.ts";
import {
  NativeTransport,
  resolveNativeBinary,
  spawnNativeConnection,
} from "./transport.ts";

/** Client message types the daemon understands */
const CLIENT_MESSAGE_TYPES = new Set([
  "boot",
  "exec",
  "stdin",
  "pty_resize",
  "exec_window",
  "exec_signal",
  "lifecycle",
]);

/** Upload chunk size for `writeGuestFile` in `bytes` */
const WRITE_CHUNK = 64 * 1024;

/** Time to wait for the daemon to answer `shutdown` in `ms` */
const SHUTDOWN_TIMEOUT_MS = 15_000;

type NativeSandboxServerInternalOptions = {
  /** root disk for the daemon to prepare (`configure.vm.root_disk`) */
  rootDisk?: NativeRootDisk;
  /** checkpoint file to boot from (`root_disk.mode = "checkpoint"`): uploaded to a remote daemon, used in place by a local one */
  checkpoint?: string;
  /** explicit daemon binary path */
  binaryPath?: string;
  /** how to reach the daemon */
  native?: NativeEngineOptions;
  /** remote session settings (daemon on another machine) */
  remote?: NativeRemoteConfig;
  /** mounts for the native VFS (absent: serve `vfsProvider` from the controller) */
  nativeVfs?: NativeVfsSpec;
  /** replaces the guest's MITM CA certificate (`/etc/gondolin/mitm/ca.crt`) */
  setMitmCaCert?: (certPem: string) => void;
};

export class NativeSandboxServer extends EventEmitter {
  private readonly options: ResolvedSandboxServerOptions;
  private readonly internalOptions: NativeSandboxServerInternalOptions;
  private readonly vfsProvider: SandboxVfsProvider | null;
  /** native VFS (daemon-side mount table) */
  private readonly nativeVfs: NativeVfs | null;
  private readonly nativeNetwork: NativeNetwork | null;
  private transport: NativeTransport | null = null;
  private readonly startSingleflight = new AsyncSingleflight<void>();
  private readonly closeSingleflight = new AsyncSingleflight<void>();
  private started = false;
  private status: SandboxState = "stopped";
  private vmmPid: number | null = null;
  private clients = new Map<number, SandboxClient>();
  private nextClientId = 1;
  private readonly tcp = {
    ssh: new NativeTcpChannelState("ssh"),
    ingress: new NativeTcpChannelState("ingress"),
  };

  constructor(
    options: ResolvedSandboxServerOptions,
    internalOptions: NativeSandboxServerInternalOptions = {},
    rawOptions?: SandboxServerOptions,
  ) {
    super();
    assertNativeSupported(options, rawOptions);
    this.options = options;
    this.internalOptions = internalOptions;

    this.on("error", (err) => {
      this.emitDebug("error", errorMessage(err));
    });

    this.vfsProvider = options.vfsProvider
      ? options.vfsProvider instanceof SandboxVfsProvider
        ? options.vfsProvider
        : new SandboxVfsProvider(options.vfsProvider)
      : null;
    this.nativeVfs =
      this.vfsProvider && internalOptions.nativeVfs
        ? new NativeVfs(internalOptions.nativeVfs, {
            remote: Boolean(internalOptions.remote),
          })
        : null;

    this.nativeNetwork = options.netEnabled
      ? new NativeNetwork({
          httpHooks: options.httpHooks,
          allowWebSockets: options.allowWebSockets,
          maxHttpBodyBytes: options.maxHttpBodyBytes,
          maxHttpResponseBodyBytes: options.maxHttpResponseBodyBytes,
          dns: options.dns,
          ssh: options.ssh,
          tcp: options.tcp,
          netMac: options.netMac,
          checksumOffload: options.vmm === "krun",
          mitmCertDir: options.mitmCertDir,
          daemonIsLocal: !internalOptions.remote,
        })
      : null;
  }

  private emitDebug(component: DebugComponent, message: string) {
    const normalized = stripTrailingNewline(message);
    this.emit("debug", component, normalized);
    this.emit(
      "log",
      `[${component}] ${normalized}${message.endsWith("\n") ? "\n" : ""}`,
    );
  }

  /** @internal resolved VM backend name */
  getVmmBackend(): SandboxVmm {
    return this.options.vmm;
  }

  /** @internal resolved VM backend binary path */
  getVmmPath(): string {
    switch (this.options.vmm) {
      case "krun":
        return this.options.krunRunnerPath;
      case "firecracker":
        return this.options.firecrackerPath;
      default:
        return this.options.qemuPath;
    }
  }

  getState(): SandboxState {
    return this.status;
  }

  /** Host pid of the VMM process while one runs */
  getHostPid(): number | null {
    // a remote VMM's pid means nothing on this machine
    return this.internalOptions.remote ? null : this.vmmPid;
  }

  /** pid of the VMM on the daemon's machine */
  getVmmPid(): number | null {
    return this.vmmPid;
  }

  /** whether the daemon session was started (it owns the root disk then) */
  isStarted(): boolean {
    return this.started;
  }

  /** whether the daemon runs on another machine */
  isRemote(): boolean {
    return Boolean(this.internalOptions.remote);
  }

  /** the image the daemon resolved (remote sessions; `configure_result.image`) */
  getResolvedImage(): Record<string, unknown> | null {
    return this.resolvedImage;
  }

  private resolvedImage: Record<string, unknown> | null = null;

  /** pid of the gondolind daemon */
  getDaemonPid(): number | null {
    return this.transport?.pid ?? null;
  }

  getVfsProvider() {
    return this.vfsProvider;
  }

  async start(): Promise<void> {
    return this.startSingleflight.run(() => this.startInternal());
  }

  async close(): Promise<void> {
    return this.closeSingleflight.run(() => this.closeInternal());
  }

  private async connectTransport(): Promise<NativeTransport> {
    const native = this.internalOptions.native ?? {};
    if (native.connect) {
      return new NativeTransport(await native.connect());
    }
    if (native.command && native.command.length > 0) {
      return new NativeTransport(spawnNativeConnection(native.command));
    }
    return new NativeTransport(
      this.internalOptions.binaryPath ?? resolveNativeBinary(),
    );
  }

  /**
   * The `configure` payload for this server's options (also used by
   * `gondolin --print-configure` without a daemon).
   */
  async buildConfigure(): Promise<ReturnType<typeof buildNativeConfigure>> {
    const remote = this.internalOptions.remote;
    const configure = buildNativeConfigure(
      this.options,
      this.internalOptions,
      {
        vfs: this.nativeVfs?.config,
        netNative: this.nativeNetwork
          ? await this.nativeNetwork.configure()
          : null,
      },
      remote,
    );
    if (remote) {
      assertRemoteConfigure(
        configure,
        [
          remote.qemuPath,
          remote.krunRunnerPath,
          remote.firecrackerPath,
          ...(this.nativeVfs?.daemonPaths ?? []),
        ].filter((p): p is string => typeof p === "string"),
      );
    }
    return configure;
  }

  private async startInternal(): Promise<void> {
    if (this.started) return;
    const remote = this.internalOptions.remote;
    const transport = await this.connectTransport();
    this.transport = transport;
    this.installHandlers(transport);
    try {
      const hello = await transport.hello;
      if (hello.protocol !== 1) {
        throw new Error(
          `unsupported gondolind protocol version ${hello.protocol}`,
        );
      }
      if (remote && this.nativeNetwork) {
        // the remote daemon terminates TLS with its own CA: the guest trusts that one
        const ca = await transport.request("mitm_ca", {});
        if (typeof ca?.cert_pem === "string") {
          this.internalOptions.setMitmCaCert?.(ca.cert_pem);
        }
      }
      const configure = await this.buildConfigure();
      if (
        (configure as { net?: { djs_hooks?: unknown } }).net?.djs_hooks &&
        !hello.features.includes("djs_hooks")
      ) {
        // an older daemon would ignore the policy (fail open)
        throw new Error(
          "createDjsHooks() needs a gondolind with tier-2 hooks (feature djs_hooks)",
        );
      }
      const configured = await transport.request("configure", configure);
      this.resolvedImage =
        configured && typeof configured.image === "object"
          ? (configured.image as Record<string, unknown>)
          : null;
      const checkpoint = this.internalOptions.checkpoint;
      if (checkpoint) {
        if (remote) {
          await this.uploadCheckpoint(transport, checkpoint);
        } else {
          await transport.request("checkpoint_import", {
            path: path.resolve(checkpoint),
          });
        }
      }
      await transport.request("start");
      this.started = true;
    } catch (err) {
      this.transport = null;
      await transport.close(1000);
      throw err;
    }
  }

  private installHandlers(transport: NativeTransport) {
    transport.onMessage("status", (p) => {
      this.status = p.state as SandboxState;
      this.vmmPid = typeof p.vmm_pid === "number" ? p.vmm_pid : null;
      for (const client of this.clients.values()) {
        client.sendJson({ type: "status", state: this.status });
      }
      this.emit("state", this.status);
    });
    transport.onMessage("client_status", (p) => {
      this.clients.get(p.client)?.sendJson({ type: "status", state: p.state });
    });
    transport.onMessage("client_error", (p) => {
      const message: ServerMessage = {
        type: "error",
        code: String(p.code),
        message: String(p.message),
      };
      if (typeof p.id === "number") message.id = p.id;
      this.clients.get(p.client)?.sendJson(message);
    });
    transport.onMessage("client_closed", (p) => {
      const client = this.clients.get(p.client);
      if (!client) return;
      this.clients.delete(p.client);
      client.close();
    });
    transport.onMessage("exec_output", (p) => {
      const client = this.clients.get(p.client);
      if (!client) return;
      const stream = p.stream === "stdout" ? "stdout" : "stderr";
      client.sendBinary(encodeOutputFrame(p.id, stream, p.data));
    });
    transport.onMessage("exec_response", (p) => {
      const message: ServerMessage = {
        type: "exec_response",
        id: p.id,
        exit_code: p.exit_code,
      };
      if (typeof p.signal === "number") message.signal = p.signal;
      this.clients.get(p.client)?.sendJson(message);
    });
    transport.onMessage("client_stdin_ack", (p) => {
      this.clients.get(p.client)?.sendJson({
        type: "stdin_ack",
        id: p.id,
        bytes: p.bytes,
      });
    });
    transport.onMessage("log", (p) => {
      this.emitDebug(p.component as DebugComponent, String(p.message ?? ""));
    });
    transport.onMessage("exit", (p) => {
      this.emit("exit", {
        code: typeof p.code === "number" ? p.code : null,
        signal: typeof p.signal === "string" ? p.signal : null,
        ...(p.error ? { error: new Error(String(p.error)) } : {}),
      });
    });
    transport.onMessage("error", (p) => {
      this.emit("error", new Error(String(p.message ?? "gondolind error")));
    });
    this.nativeVfs?.install(transport, (err) => this.emit("error", err));
    this.nativeNetwork?.install(transport);
    const channel = (p: any) =>
      p.channel === "ssh" || p.channel === "ingress"
        ? this.tcp[p.channel as "ssh" | "ingress"]
        : null;
    transport.onMessage("fwd_opened", (p) => channel(p)?.handleOpened(p));
    transport.onMessage("fwd_data", (p) => channel(p)?.handleData(p));
    transport.onMessage("fwd_close", (p) => channel(p)?.handleClose(p));
    transport.on("stderr", (line: string) => {
      this.emitDebug("error", `gondolind: ${line}`);
    });
    transport.on("closed", (err: Error) => {
      if (this.transport !== transport) return;
      this.handleDaemonGone(err);
    });
  }

  /** The native VFS, when the daemon serves the guest filesystem */
  getNativeVfs(): NativeVfs | null {
    return this.nativeVfs;
  }

  /** Controller fs API on the daemon's mount table (`fs_call`) */
  async fsCall(p: Record<string, unknown>): Promise<any> {
    const transport = this.transport;
    if (!transport) throw new Error("gondolind is not running");
    return transport.request("fs_call", p);
  }

  /** Drop cached state of the daemon's object mounts (`vfs_invalidate`) */
  async invalidateVfs(mountId: number, entryPath?: string): Promise<void> {
    await this.transport?.request("vfs_invalidate", {
      mount_id: mountId,
      path: entryPath,
    });
  }

  /** The daemon went away without `shutdown` */
  private handleDaemonGone(err: Error) {
    this.transport = null;
    this.tcp.ssh.destroyAll(err);
    this.tcp.ingress.destroyAll(err);
    this.started = false;
    const wasRunning = this.status !== "stopped";
    this.vmmPid = null;
    if (wasRunning) {
      this.status = "stopped";
      this.emit("state", this.status);
    }
    for (const [id, client] of Array.from(this.clients)) {
      client.sendJson({
        type: "error",
        code: "sandbox_stopped",
        message: err.message,
      });
      this.clients.delete(id);
      client.close();
    }
    if (!this.closing) {
      this.emit("error", err);
      if (wasRunning) {
        this.emit("exit", { code: null, signal: null, error: err });
      }
    }
  }

  private closing = false;

  private async closeInternal(): Promise<void> {
    this.closing = true;
    try {
      for (const [id, client] of Array.from(this.clients)) {
        this.clients.delete(id);
        this.transport?.send("client_close", { client: id });
        client.close();
      }
      this.tcp.ssh.destroyAll();
      this.tcp.ingress.destroyAll();
      const transport = this.transport;
      if (transport) {
        let timer: NodeJS.Timeout | null = null;
        try {
          await Promise.race([
            transport.request("shutdown"),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
        } catch {
          // the daemon may already be gone
        } finally {
          if (timer) clearTimeout(timer);
        }
        await transport.close(3000);
        this.transport = null;
      }
      this.nativeNetwork?.close();
      if (this.status !== "stopped") {
        this.status = "stopped";
        this.emit("state", this.status);
      }
      this.vmmPid = null;
      this.started = false;
    } finally {
      this.closing = false;
    }
  }

  // ---- clients ---------------------------------------------------------

  connect(
    onMessage: (data: Buffer | string, isBinary: boolean) => void,
    onClose?: () => void,
  ): SandboxConnection {
    const id = this.nextClientId++;
    const client = new LocalSandboxClient(onMessage, onClose);
    this.clients.set(id, client);
    if (!this.transport?.send("client_open", { client: id })) {
      // no daemon: behave like a stopped server
      client.sendJson({ type: "status", state: this.status });
    }
    return {
      send: (message) => this.sendClientMessage(id, message),
      close: () => {
        if (!this.clients.has(id)) return;
        this.clients.delete(id);
        this.transport?.send("client_close", { client: id });
        client.close();
      },
    };
  }

  private sendClientMessage(client: number, message: ClientMessage) {
    if (!this.clients.has(client)) return;
    const transport = this.transport;
    if (!transport) {
      this.clients.get(client)?.sendJson({
        type: "error",
        code: "sandbox_stopped",
        message: "sandbox is not running",
      });
      return;
    }
    const { type, ...fields } = message as ClientMessage & {
      [key: string]: unknown;
    };
    if (!CLIENT_MESSAGE_TYPES.has(type)) {
      transport.send("client_unknown", { client, type: String(type) });
      return;
    }
    const payload: Record<string, unknown> = { ...fields, client };
    if (type === "stdin" && typeof payload.data === "string") {
      payload.data = Buffer.from(payload.data, "base64");
    }
    transport.send(type, payload);
  }

  // ---- checkpoints -------------------------------------------------------

  /** Upload a local checkpoint file to a remote daemon (before `start`) */
  private async uploadCheckpoint(transport: NativeTransport, file: string) {
    const id = transport.allocateId();
    const done = transport.request("checkpoint_import", {}, { id });
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        if (
          !transport.send(
            "checkpoint_data",
            { data: Buffer.from(buf.subarray(0, n)) },
            id,
          )
        ) {
          await transport.waitDrain();
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    transport.send("checkpoint_data", { data: Buffer.alloc(0), eof: true }, id);
    await done;
  }

  /**
   * Stop the VM and write its root disk (its chain collapsed onto the
   * image's rootfs) to `destination`: a local daemon moves the disk there, a
   * remote one streams it. Resolves with the build id of the image the
   * daemon resolved (remote sessions) for the trailer.
   */
  async exportCheckpoint(
    destination: string,
  ): Promise<{ buildId: string | null }> {
    const transport = this.requireTransport();
    const buildIdOf = (result: Record<string, unknown> | undefined) => ({
      buildId: typeof result?.build_id === "string" ? result.build_id : null,
    });
    if (!this.internalOptions.remote) {
      return buildIdOf(
        await transport.request("checkpoint_export", {
          path: path.resolve(destination),
        }),
      );
    }
    const fd = fs.openSync(destination, "w");
    try {
      const result = await transport.request(
        "checkpoint_export",
        {},
        {
          onEvent: (t, p) => {
            if (t === "checkpoint_data" && Buffer.isBuffer(p.data)) {
              fs.writeSync(fd, p.data);
            }
          },
        },
      );
      fs.fsyncSync(fd);
      return buildIdOf(result);
    } finally {
      fs.closeSync(fd);
    }
  }

  // ---- guest file operations ---------------------------------------------

  private assertGuestPath(value: string, field: string): void {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${field} must be a non-empty string`);
    }
    if (value.includes("\0")) {
      throw new Error(`${field} contains null bytes`);
    }
  }

  private requireTransport(): NativeTransport {
    if (!this.transport) throw new Error("sandbox server is not running");
    return this.transport;
  }

  /**
   * Run a file operation request: resolves `started` once the daemon sent the
   * guest request, `done` with the result.
   */
  private fileRequest(
    t: string,
    payload: Record<string, unknown>,
    onData?: (data: Buffer) => void,
  ) {
    const transport = this.requireTransport();
    const id = transport.allocateId();
    const started = Promise.withResolvers<void>();
    const done = transport
      .request(t, payload, {
        id,
        onEvent: (eventType, p) => {
          if (eventType === "file_started") started.resolve();
          else if (eventType === "file_read_data" && onData) onData(p.data);
        },
      })
      .then(
        () => {
          started.resolve();
        },
        (err: unknown) => {
          const error =
            err instanceof Error
              ? new Error(err.message)
              : new Error(String(err));
          started.reject(error);
          throw error;
        },
      );
    void started.promise.catch(() => {});
    void done.catch(() => {});
    const cancel = (message: string) => {
      transport.send("file_cancel", { message }, id);
    };
    return { id, started: started.promise, done, cancel, transport };
  }

  async readGuestFileStream(
    filePath: string,
    options: GuestFileReadOptions = {},
  ): Promise<Readable> {
    this.assertGuestPath(filePath, "filePath");
    await this.start();
    if (options.signal?.aborted) throw new Error("operation aborted");
    const highWaterMark =
      typeof options.highWaterMark === "number" &&
      Number.isFinite(options.highWaterMark) &&
      options.highWaterMark > 0
        ? Math.trunc(options.highWaterMark)
        : undefined;
    const stream = new PassThrough(
      highWaterMark ? { highWaterMark } : undefined,
    );
    stream.on("error", () => {
      // keep process alive if caller does not attach an error handler
    });

    const op = this.fileRequest(
      "file_read",
      { path: filePath, cwd: options.cwd, chunk_size: options.chunkSize },
      (data) => stream.write(data),
    );
    let started = false;
    const onAbort = () => {
      op.cancel(started ? "file read aborted" : "operation aborted");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    void op.done.then(
      () => {
        options.signal?.removeEventListener("abort", onAbort);
        stream.end();
      },
      (err: Error) => {
        options.signal?.removeEventListener("abort", onAbort);
        queueMicrotask(() => stream.destroy(err));
      },
    );
    await op.started;
    started = true;
    return stream;
  }

  async readGuestFile(
    filePath: string,
    options: GuestFileReadOptions = {},
  ): Promise<Buffer> {
    const stream = await this.readGuestFileStream(filePath, options);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.once("end", resolve);
      stream.once("error", reject);
    });
    return Buffer.concat(chunks);
  }

  async writeGuestFile(
    filePath: string,
    input:
      | Buffer
      | Uint8Array
      | string
      | Readable
      | AsyncIterable<Buffer | Uint8Array | string>,
    options: GuestFileWriteOptions = {},
  ): Promise<void> {
    this.assertGuestPath(filePath, "filePath");
    await this.start();
    if (options.signal?.aborted) throw new Error("operation aborted");
    const op = this.fileRequest("file_write", {
      path: filePath,
      cwd: options.cwd,
    });
    const onAbort = () => op.cancel("operation aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await op.started;
      for await (const chunk of toBufferIterable(input)) {
        for (let offset = 0; offset < chunk.length; offset += WRITE_CHUNK) {
          if (options.signal?.aborted) throw new Error("operation aborted");
          const slice = chunk.subarray(offset, offset + WRITE_CHUNK);
          if (
            !op.transport.send(
              "file_write_data",
              { data: Buffer.from(slice) },
              op.id,
            )
          ) {
            await op.transport.waitDrain();
          }
        }
      }
      if (options.signal?.aborted) throw new Error("operation aborted");
      op.transport.send(
        "file_write_data",
        { data: Buffer.alloc(0), eof: true },
        op.id,
      );
      await op.done;
    } catch (err) {
      op.cancel(errorMessage(err));
      await op.done.catch(() => {});
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async deleteGuestFile(
    filePath: string,
    options: GuestFileDeleteOptions = {},
  ): Promise<void> {
    this.assertGuestPath(filePath, "filePath");
    await this.start();
    if (options.signal?.aborted) throw new Error("operation aborted");
    const op = this.fileRequest("file_delete", {
      path: filePath,
      cwd: options.cwd,
      force: options.force,
      recursive: options.recursive,
    });
    const onAbort = () => op.cancel("operation aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await op.done;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  // ---- guest TCP streams ---------------------------------------------------

  /**
   * Open a TCP stream to a loopback service inside the guest (virtio-ssh
   * forwarder, not the guest network).
   */
  async openTcpStream(target: {
    host: string;
    port: number;
    timeoutMs?: number;
  }): Promise<Duplex> {
    const port = target.port;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`invalid guest port: ${port}`);
    }
    return this.tcp.ssh.open(
      this.requireTransport(),
      target.host,
      port,
      target.timeoutMs ?? 5000,
    );
  }

  /** Open a TCP stream for the ingress gateway (virtio-ingress forwarder) */
  async openIngressStream(target: {
    host: string;
    port: number;
    timeoutMs?: number;
  }): Promise<Duplex> {
    if (target.host !== "127.0.0.1" && target.host !== "localhost") {
      throw new Error(`invalid ingress host: ${target.host}`);
    }
    const port = target.port;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`invalid guest port: ${port}`);
    }
    return this.tcp.ingress.open(
      this.requireTransport(),
      target.host,
      port,
      target.timeoutMs ?? 5000,
    );
  }
}
