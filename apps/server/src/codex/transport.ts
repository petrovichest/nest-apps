import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import { PassThrough, type Readable, Writable } from "node:stream";

import WebSocket, { type RawData } from "ws";

import type { ServerNotification, ServerRequest } from "./generated/index";

export interface JsonlProcess {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable | null;
  onMessage?(listener: (message: string) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface WebSocketClient extends EventEmitter {
  readyState: number;
  send(
    data: string | Buffer,
    options: { binary: boolean; fin: boolean },
    callback: (error?: Error) => void,
  ): void;
  terminate(): void;
}

export type WebSocketFactory = (url: string) => WebSocketClient;

// Codex's receiver limits individual frames to 16 MiB. Fragment large image
// inputs into smaller frames while keeping each JSON-RPC envelope one message.
const WEBSOCKET_FRAME_BYTES = 8 * 1024 * 1024;

export function connectUnixWebSocket(
  socketPath: string,
  createSocket: WebSocketFactory = (url) =>
    new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false }),
): JsonlProcess {
  return new WebSocketJsonlProcess(createSocket(`ws+unix://${socketPath}:/`));
}

class WebSocketJsonlProcess extends EventEmitter implements JsonlProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  private bufferedInput = "";
  private queuedFrames: string[] = [];
  private exited = false;

  constructor(private readonly socket: WebSocketClient) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.bufferedInput += chunk.toString();
        const lines = this.bufferedInput.split("\n");
        this.bufferedInput = lines.pop() ?? "";
        for (const line of lines) {
          if (line) this.sendOrQueue(line);
        }
        callback();
      },
    });
    this.socket.on("open", () => {
      const frames = this.queuedFrames;
      this.queuedFrames = [];
      for (const frame of frames) this.send(frame);
    });
    this.socket.on("message", (data: RawData) => {
      this.emit("message", rawDataToString(data));
    });
    this.socket.on("error", (error: Error) => {
      this.stderr.write(`${error.message}\n`);
    });
    this.socket.on("close", (code: number, reason?: RawData) => {
      if (this.exited) return;
      this.exited = true;
      const detail = reason === undefined ? "" : rawDataToString(reason).trim();
      this.stderr.write(
        `Codex app-server WebSocket closed (${code}${detail ? `: ${detail}` : ""})\n`,
      );
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", code === 1000 ? 0 : 1, null);
    });
  }

  kill(): boolean {
    if (this.exited || this.socket.readyState === 3) return false;
    this.socket.terminate();
    return true;
  }

  onMessage(listener: (message: string) => void): void {
    this.on("message", listener);
  }

  private sendOrQueue(frame: string): void {
    if (this.socket.readyState === 1) this.send(frame);
    else if (this.socket.readyState === 0) this.queuedFrames.push(frame);
  }

  private send(frame: string): void {
    let failed = false;
    const onSent = (error?: Error) => {
      if (!error || failed || this.exited) return;
      failed = true;
      this.stderr.write(`${error.message}\n`);
      this.socket.terminate();
    };
    if (Buffer.byteLength(frame) <= WEBSOCKET_FRAME_BYTES) {
      this.socket.send(frame, { binary: false, fin: true }, onSent);
      return;
    }
    const bytes = Buffer.from(frame);
    for (let offset = 0; offset < bytes.length && !failed; offset += WEBSOCKET_FRAME_BYTES) {
      const end = Math.min(offset + WEBSOCKET_FRAME_BYTES, bytes.length);
      this.socket.send(
        bytes.subarray(offset, end),
        { binary: false, fin: end === bytes.length },
        onSent,
      );
    }
  }
}

interface PendingRequest {
  method: string;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
    public readonly method?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`RPC ${method} timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

export class JsonlTransport extends EventEmitter {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly reader?: Interface;
  private nextRequestId = 1;
  private closed = false;

  constructor(private readonly child: JsonlProcess) {
    super();
    if (child.onMessage) {
      child.onMessage((message) => this.onLine(message));
    } else {
      this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.reader.on("line", (line) => this.onLine(line));
    }
    child.once("exit", (code, signal) => {
      this.failAll(new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`));
      this.closed = true;
      this.emit("exit", code, signal);
    });
  }

  request<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("codex app-server transport is closed"));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  shutdown(reason = new Error("codex app-server transport stopped")): void {
    if (this.closed) return;
    this.closed = true;
    this.reader?.close();
    this.failAll(reason);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private write(envelope: object): void {
    if (this.closed) throw new Error("codex app-server transport is closed");
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  private onLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.reportProtocolError(
        `Malformed JSON received from codex app-server (${Buffer.byteLength(line)} bytes)`,
      );
      return;
    }
    if (!isRecord(value)) {
      this.reportProtocolError("Non-object JSON-RPC envelope received from codex app-server");
      return;
    }

    if ((typeof value.id === "number" || typeof value.id === "string") && "method" in value) {
      if (typeof value.method !== "string" || !("params" in value)) {
        this.reportProtocolError("Malformed server request received from codex app-server");
        return;
      }
      this.emit("request", value as unknown as ServerRequest);
      return;
    }

    if (typeof value.method === "string" && !("id" in value)) {
      this.emit("notification", value as unknown as ServerNotification);
      return;
    }

    if (typeof value.id !== "number") {
      this.reportProtocolError("Malformed JSON-RPC response received from codex app-server");
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) {
      this.emit("unknownResponse", value.id);
      return;
    }
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (isRpcError(value.error)) {
      pending.reject(
        new RpcError(value.error.code, value.error.message, value.error.data, pending.method),
      );
    } else if ("result" in value) {
      pending.resolve(value.result);
    } else {
      pending.reject(new Error(`Malformed RPC response for ${pending.method}`));
    }
  }

  private reportProtocolError(message: string): void {
    this.emit("protocolError", new Error(message));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRpcError(value: unknown): value is JsonRpcErrorShape {
  return isRecord(value) && typeof value.code === "number" && typeof value.message === "string";
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}
