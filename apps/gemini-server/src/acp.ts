import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Config } from "./config";

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function nativeArgs(config: Pick<Config, "nativeDir">) {
  return [
    "acp",
    "--disable-telemetry",
    "--gemini-dir",
    config.nativeDir,
    "--app-data-dir",
    "gemininest",
  ];
}

/** ACP v1 NDJSON. Protocol messages never appear in application logs. */
export class AcpClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }
  >();
  private sequence = 0;
  private partial = "";
  initializeResult: any;
  onRequest: (method: string, params: any, id: number | string) => Promise<any> = async () => {
    throw new RpcError(-32601, "Unsupported client method");
  };

  constructor(
    private readonly config: Pick<Config, "agyBin" | "nativeDir">,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    super();
  }

  async start() {
    if (this.child) return this.initializeResult;
    const child = spawn(this.config.agyBin, nativeArgs(this.config), {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.partial += chunk;
      if (Buffer.byteLength(this.partial) > 32 * 1024 * 1024) {
        this.close();
        return;
      }
      let end: number;
      while ((end = this.partial.indexOf("\n")) >= 0) {
        const line = this.partial.slice(0, end);
        this.partial = this.partial.slice(end + 1);
        if (line.trim()) {
          try {
            this.receive(JSON.parse(line));
          } catch {
            this.close();
          }
        }
      }
    });
    child.stdin.on("error", () => this.close());
    child.once("error", () => this.fail());
    child.once("exit", () => this.fail());
    this.initializeResult = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "gemininest", version: "0.1.0" },
      clientCapabilities: { elicitation: { form: true } },
    });
    return this.initializeResult;
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.child || this.child.exitCode !== null)
      return Promise.reject(new Error("Antigravity CLI is not running"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error("Antigravity did not respond in time"));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown) {
    const input = this.child?.stdin;
    const line = `${JSON.stringify(message)}\n`;
    if (
      !input ||
      input.destroyed ||
      input.writableLength + Buffer.byteLength(line) > 32 * 1024 * 1024
    ) {
      this.close();
      return;
    }
    input.write(line);
  }

  private receive(message: any) {
    if (message.method) {
      if (message.id !== undefined) {
        void this.onRequest(message.method, message.params, message.id).then(
          (result) => this.write({ jsonrpc: "2.0", id: message.id, result }),
          (error) =>
            this.write({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: error instanceof RpcError ? error.code : -32603,
                message: "Client request failed",
              },
            }),
        );
      } else this.emit("notification", message.method, message.params);
      return;
    }
    const task = this.pending.get(message.id);
    if (!task) return;
    this.pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new RpcError(message.error.code, message.error.message));
    else task.resolve(message.result);
  }

  private fail() {
    if (!this.child) return;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Antigravity CLI disconnected; the request was not replayed"));
    }
    this.pending.clear();
    this.emit("disconnected");
  }

  close() {
    this.child?.kill("SIGTERM");
    this.fail();
  }
}
