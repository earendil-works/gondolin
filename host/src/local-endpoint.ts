import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

/** local IPC endpoint description */
export type LocalEndpoint =
  | {
      /** local unix domain socket transport */
      transport: "unix";
      /** absolute unix socket path */
      path: string;
    }
  | {
      /** loopback tcp transport */
      transport: "tcp";
      /** loopback bind/connect host */
      host: string;
      /** tcp port or `0` for ephemeral listen */
      port: number;
    };

/** caller-provided local IPC endpoint */
export type LocalEndpointInput = string | LocalEndpoint;

type DefaultLocalEndpointDeps = {
  platform?: NodeJS.Platform;
  tmpDir?: string;
  randomId?: () => string;
};

type NormalizeLocalEndpointDeps = DefaultLocalEndpointDeps;

function isLoopbackTcpHost(value: string): boolean {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "localhost" || trimmed === "::1") {
    return true;
  }

  if (net.isIP(trimmed) !== 4) {
    return false;
  }

  const firstOctet = Number.parseInt(trimmed.split(".", 1)[0]!, 10);
  return firstOctet === 127;
}

export function createDefaultLocalEndpoint(
  name: string,
  deps: DefaultLocalEndpointDeps = {},
): LocalEndpoint {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    return {
      transport: "tcp",
      host: "127.0.0.1",
      port: 0,
    };
  }

  const tmpDir =
    deps.tmpDir ?? (platform === "darwin" ? "/tmp" : os.tmpdir());
  const randomId = deps.randomId ?? (() => crypto.randomUUID().slice(0, 8));

  return {
    transport: "unix",
    path: path.resolve(tmpDir, `${name}-${randomId()}.sock`),
  };
}

export function normalizeLocalEndpoint(
  value: LocalEndpointInput,
  fieldName: string,
  deps: NormalizeLocalEndpointDeps = {},
): LocalEndpoint {
  const platform = deps.platform ?? process.platform;

  if (typeof value === "string") {
    if (platform === "win32") {
      throw new Error(
        `${fieldName} must use an explicit { transport: \"tcp\", host, port } endpoint on Windows`,
      );
    }

    return {
      transport: "unix",
      path: path.resolve(value),
    };
  }

  if (!value || typeof value !== "object") {
    throw new Error(`${fieldName} must be a local endpoint object`);
  }

  if (value.transport === "unix") {
    if (platform === "win32") {
      throw new Error(`${fieldName} must use transport \"tcp\" on Windows`);
    }
    if (typeof value.path !== "string" || value.path.length === 0) {
      throw new Error(`${fieldName}.path must be a non-empty string`);
    }
    value.path = path.resolve(value.path);
    return value;
  }

  if (value.transport === "tcp") {
    if (typeof value.host !== "string" || value.host.length === 0) {
      throw new Error(`${fieldName}.host must be a non-empty string`);
    }

    const normalizedHost = value.host.trim();
    if (!isLoopbackTcpHost(normalizedHost)) {
      throw new Error(
        `${fieldName}.host must be a loopback host (127.0.0.0/8, ::1, or localhost)`,
      );
    }

    if (
      !Number.isInteger(value.port) ||
      value.port < 0 ||
      value.port > 65535
    ) {
      throw new Error(`${fieldName}.port must be a valid tcp port`);
    }

    value.host = normalizedHost;
    return value;
  }

  throw new Error(`${fieldName}.transport must be \"unix\" or \"tcp\"`);
}

export function describeLocalEndpoint(endpoint: LocalEndpoint): string {
  if (endpoint.transport === "unix") {
    return endpoint.path;
  }

  return endpoint.host.includes(":")
    ? `[${endpoint.host}]:${endpoint.port}`
    : `${endpoint.host}:${endpoint.port}`;
}

export function createNetConnectOptions(
  endpoint: LocalEndpoint,
): net.NetConnectOpts {
  return endpoint.transport === "unix"
    ? { path: endpoint.path }
    : { host: endpoint.host, port: endpoint.port };
}

export async function listenOnLocalEndpoint(
  server: net.Server,
  endpoint: LocalEndpoint,
): Promise<void> {
  if (endpoint.transport === "unix") {
    if (!fs.existsSync(path.dirname(endpoint.path))) {
      fs.mkdirSync(path.dirname(endpoint.path), { recursive: true });
    }
    fs.rmSync(endpoint.path, { force: true });
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onListening = () => {
      cleanup();
      syncEndpointWithServerAddress(endpoint, server);
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);

    if (endpoint.transport === "unix") {
      server.listen(endpoint.path);
    } else {
      server.listen(endpoint.port, endpoint.host);
    }
  });
}

export function syncEndpointWithServerAddress(
  endpoint: LocalEndpoint,
  server: net.Server,
): void {
  if (endpoint.transport !== "tcp") return;
  const address = server.address();
  if (address && typeof address === "object") {
    endpoint.port = address.port;
  }
}
