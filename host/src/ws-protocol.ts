/**
 * Sandbox control protocol.
 *
 * Transport:
 * - JSON control messages typed in this module.
 * - Binary output frames stream stdout/stderr chunks.
 *
 * Client → Server:
 * - exec { type: "exec", id, cmd, argv?, env?, cwd?, stdin?, pty? }
 * - stdin { type: "stdin", id, data?: base64 string, eof? }
 * - pty_resize { type: "pty_resize", id, rows, cols }
 * - lifecycle { type: "lifecycle", action: "restart" | "shutdown" }
 * - boot { type: "boot", fuseMount?, fuseBinds? }
 *
 * Server → Client:
 * - status { type: "status", state: "starting" | "running" | "stopped" }
 * - exec_response { type: "exec_response", id, exit_code, signal? }
 * - error { type: "error", id?, code, message }
 *
 * Binary output frame:
 * +---------+-----------+-------------------+
 * | u8 tag  | u32 id    | data bytes        |
 * +---------+-----------+-------------------+
 * tag = 1 stdout, tag = 2 stderr, id big-endian.
 */
export type ExecCommandMessage = {
  type: "exec";
  id: number;
  cmd: string;
  argv?: string[];
  env?: string[];
  cwd?: string;
  stdin?: boolean;
  pty?: boolean;
};

export type StdinCommandMessage = {
  type: "stdin";
  id: number;
  data?: string;
  eof?: boolean;
};

export type PtyResizeCommandMessage = {
  type: "pty_resize";
  id: number;
  rows: number;
  cols: number;
};

export type LifecycleCommandMessage = {
  type: "lifecycle";
  action: "restart" | "shutdown";
};

export type BootCommandMessage = {
  type: "boot";
  fuseMount?: string;
  fuseBinds?: string[];
};

export type ClientMessage =
  | BootCommandMessage
  | ExecCommandMessage
  | StdinCommandMessage
  | PtyResizeCommandMessage
  | LifecycleCommandMessage;

export type ExecResponseMessage = {
  type: "exec_response";
  id: number;
  exit_code: number;
  signal?: number;
};

export type ErrorMessage = {
  type: "error";
  id?: number;
  code: string;
  message: string;
};

export type StatusMessage = {
  type: "status";
  state: "starting" | "running" | "stopped";
};

export type ServerMessage = ExecResponseMessage | ErrorMessage | StatusMessage;

export type OutputStream = "stdout" | "stderr";

export const OUTPUT_HEADER_BYTES = 5;

export function encodeOutputFrame(id: number, stream: OutputStream, data: Buffer): Buffer {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
    throw new RangeError("id must be a uint32");
  }
  const header = Buffer.alloc(OUTPUT_HEADER_BYTES);
  header.writeUInt8(stream === "stdout" ? 1 : 2, 0);
  header.writeUInt32BE(id, 1);
  return Buffer.concat([header, data]);
}

export function decodeOutputFrame(frame: Buffer): {
  id: number;
  stream: OutputStream;
  data: Buffer;
} {
  if (frame.length < OUTPUT_HEADER_BYTES) {
    throw new Error("output frame too short");
  }
  const streamFlag = frame.readUInt8(0);
  const stream = streamFlag === 1 ? "stdout" : "stderr";
  const id = frame.readUInt32BE(1);
  return {
    id,
    stream,
    data: frame.slice(OUTPUT_HEADER_BYTES),
  };
}
