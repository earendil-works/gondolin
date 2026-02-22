import type {
  ClientMessage,
  ErrorMessage,
  ServerMessage,
} from "./control-protocol";

export type SandboxClient = {
  sendJson: (message: ServerMessage) => boolean;
  sendBinary: (data: Buffer) => boolean;
  close: () => void;
};

export type SandboxConnection = {
  /** send a control message to the guest */
  send: (message: ClientMessage) => void;
  /** close the underlying connection */
  close: () => void;
};

export class LocalSandboxClient implements SandboxClient {
  private closed = false;

  constructor(
    private readonly onMessage: (
      data: Buffer | string,
      isBinary: boolean,
    ) => void,
    private readonly onClose?: () => void,
  ) {}

  sendJson(message: ServerMessage): boolean {
    if (this.closed) return false;
    this.onMessage(JSON.stringify(message), false);
    return true;
  }

  sendBinary(data: Buffer): boolean {
    if (this.closed) return false;
    this.onMessage(data, true);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

export function sendJson(
  client: SandboxClient,
  message: ServerMessage,
): boolean {
  return client.sendJson(message);
}

export function sendBinary(client: SandboxClient, data: Buffer): boolean {
  return client.sendBinary(data);
}

export function sendError(client: SandboxClient, error: ErrorMessage): boolean {
  return sendJson(client, error);
}
