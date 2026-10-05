import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { AppError, type RpcMessage } from "./types";

export class RunnerConnection extends EventEmitter {
  private buffer = "";
  private pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 32 * 1024 * 1024) {
          socket.destroy();
          return;
        }
        if (!line.trim()) continue;
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          socket.destroy();
          return;
        }
        if ("id" in message) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if ("error" in message)
            pending.reject(
              new AppError(
                message.error.code,
                message.error.message,
                message.error.code === "conflict" ? 409 : 503,
              ),
            );
          else pending.resolve(message.result);
        } else this.emit("message", message);
      }
      if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) socket.destroy();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new AppError(
            "unavailable",
            "Runner disconnected; command outcome must be reconciled",
            503,
          ),
        );
      }
      this.pending.clear();
      this.emit("close");
    });
  }

  static async open(path: string, timeoutMs = 10_000): Promise<RunnerConnection> {
    const socket = connect(path);
    const client = new RunnerConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => socket.destroy(new Error("Runner connection timed out")),
        timeoutMs,
      );
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return client;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.socket.destroyed)
      return Promise.reject(new AppError("unavailable", "Runner is disconnected", 503));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError(
            "unavailable",
            "Runner response timed out; retry only with the same request ID",
            503,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = `${JSON.stringify({ id, method, params })}\n`;
      if (this.socket.writableLength + Buffer.byteLength(payload) > 32 * 1024 * 1024) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AppError("unavailable", "Runner input is backpressured", 503));
        return;
      }
      this.socket.write(payload);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}
