import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const CONTROL_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;
type PendingControl = {
  resolve: (response: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export interface ClaudeProcessOptions {
  claudeBin: string;
  cwd: string;
  sessionId: string;
  resume: boolean;
  model?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Owns only the CLI's transport. The independent runner owns session lifetime. */
export class ClaudeProcess extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private initialized = false;
  private exited = false;
  private failed = false;
  private line = "";
  private lineBytes = 0;
  private controls = new Map<string, PendingControl>();
  private requests = new Set<string>();

  constructor(private readonly options: ClaudeProcessOptions) {
    super();
    if (!isAbsolute(options.claudeBin))
      throw new Error("Claude executable must be an absolute path");
    if (!UUID.test(options.sessionId)) throw new Error("Invalid Claude session UUID");
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  private async startOnce(): Promise<void> {
    const env = { ...process.env, ...this.options.env };
    // CLI session authentication and normal project/user settings stay inherited.
    delete env.CLAUDECODE;
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      "--permission-mode",
      "manual",
      "--permission-prompt-tool",
      "stdio",
      this.options.resume ? "--resume" : "--session-id",
      this.options.sessionId,
    ];
    if (this.options.model) args.push("--model", this.options.model);
    try {
      this.child = (this.options.spawnProcess ?? spawn)(this.options.claudeBin, args, {
        cwd: this.options.cwd,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      throw new Error("Could not start installed Claude CLI");
    }
    const child = this.child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.readChunk(chunk));
    child.stdout.on("end", () => {
      if (this.line.trim() && !this.failed) this.readLine(this.line);
      this.line = "";
      this.lineBytes = 0;
    });
    child.stderr.resume(); // Drain stderr without disclosing auth or tool diagnostics.
    child.stderr.on("error", () => this.fail(new Error("Claude diagnostic stream failed")));
    child.stdout.on("error", () => this.fail(new Error("Claude output stream failed")));
    child.stdin.on("error", () => this.fail(new Error("Claude input stream failed")));
    child.on("error", () => this.fail(new Error("Could not run installed Claude CLI")));
    child.once("exit", (code, signal) => {
      this.exited = true;
      this.initialized = false;
      this.rejectControls(new Error("Claude CLI exited before its control response"));
      this.requests.clear();
      this.emit("exit", { code, signal });
    });
    // spawn errors have no exit event, but always have close.
    child.once("close", () => {
      this.exited = true;
      this.initialized = false;
      this.rejectControls(new Error("Claude CLI closed before its control response"));
    });
    try {
      await this.control({ subtype: "initialize", hooks: null }, INITIALIZE_TIMEOUT_MS);
      if (this.exited || this.failed) throw new Error("Claude CLI exited during initialization");
      this.initialized = true;
    } catch (error) {
      child.stdin.end();
      if (!this.exited) child.kill("SIGTERM");
      throw error;
    }
  }

  sendUser(requestId: string, text: string): void {
    this.assertReady();
    if (!UUID.test(requestId)) throw new Error("Invalid user message UUID");
    this.write({
      type: "user",
      uuid: requestId,
      session_id: this.options.sessionId,
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    });
  }

  respond(requestId: string, response: JsonObject): void {
    this.assertReady();
    if (!this.requests.has(requestId))
      throw new Error("Claude permission request is no longer pending");
    this.write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
    this.requests.delete(requestId);
  }

  async interrupt(): Promise<void> {
    this.assertReady();
    await this.control({ subtype: "interrupt" });
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    // End stdin only after interrupt has cancelled any outstanding host prompts.
    if (this.initialized && !this.failed) {
      try {
        await this.interrupt();
      } catch {
        /* EOF and signal escalation still release the process. */
      }
    }
    child.stdin.end();
    if (await this.waitForExit(STOP_GRACE_MS)) return;
    child.kill("SIGTERM");
    if (await this.waitForExit(STOP_GRACE_MS)) return;
    child.kill("SIGKILL");
    await this.waitForExit(STOP_GRACE_MS);
    if (!this.exited) throw new Error("Claude CLI did not exit after stop");
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.child?.off("close", done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.child?.off("close", done);
        resolve(this.exited);
      }, timeoutMs);
      this.child?.once("close", done);
    });
  }

  private assertReady(): void {
    if (!this.initialized || this.exited || this.failed || this.stopPromise) {
      throw new Error("Claude CLI is not ready");
    }
  }

  private write(message: JsonObject): void {
    const child = this.child;
    if (
      !child ||
      this.exited ||
      this.failed ||
      child.stdin.destroyed ||
      child.stdin.writableEnded
    ) {
      throw new Error("Claude CLI input is closed");
    }
    const line = JSON.stringify(message) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_LINE_BYTES || child.stdin.writableLength + bytes > MAX_LINE_BYTES) {
      throw new Error("Claude input buffer limit exceeded");
    }
    child.stdin.write(line);
  }

  private control(request: JsonObject, timeoutMs = CONTROL_TIMEOUT_MS): Promise<JsonObject> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(requestId);
        reject(new Error(`Claude control request timed out: ${request.subtype}`));
      }, timeoutMs);
      this.controls.set(requestId, { resolve, reject, timer });
      try {
        this.write({ type: "control_request", request_id: requestId, request });
      } catch (error) {
        clearTimeout(timer);
        this.controls.delete(requestId);
        reject(
          error instanceof Error ? error : new Error("Claude control request could not be sent"),
        );
      }
    });
  }

  private readChunk(chunk: string): void {
    if (this.failed) return;
    let start = 0;
    for (;;) {
      const end = chunk.indexOf("\n", start);
      const part = end < 0 ? chunk.slice(start) : chunk.slice(start, end);
      this.lineBytes += Buffer.byteLength(part);
      if (this.lineBytes > MAX_LINE_BYTES) {
        this.line = "";
        this.fail(new Error("Claude output line limit exceeded"));
        return;
      }
      this.line += part;
      if (end < 0) return;
      const line = this.line;
      this.line = "";
      this.lineBytes = 0;
      this.readLine(line);
      if (this.failed) return;
      start = end + 1;
    }
  }

  private readLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new Error("Claude CLI returned invalid stream JSON"));
      return;
    }
    if (!object(message)) {
      this.fail(new Error("Claude CLI returned a non-object stream message"));
      return;
    }
    if (message.type === "control_response" && object(message.response)) {
      const response = message.response;
      const requestId = response.request_id;
      const pending = typeof requestId === "string" ? this.controls.get(requestId) : undefined;
      if (pending && typeof requestId === "string") {
        this.controls.delete(requestId);
        clearTimeout(pending.timer);
        if (response.subtype === "success")
          pending.resolve(object(response.response) ? response.response : {});
        else pending.reject(new Error("Claude CLI rejected the control request"));
        return;
      }
    }
    if (
      message.type === "control_request" &&
      typeof message.request_id === "string" &&
      object(message.request)
    ) {
      this.requests.add(message.request_id);
      this.emit("request", { request_id: message.request_id, request: message.request });
      return;
    }
    if (message.type === "control_cancel_request" && typeof message.request_id === "string") {
      this.requests.delete(message.request_id);
      this.emit("requestCancelled", message.request_id);
      return;
    }
    this.emit("event", message);
  }

  private rejectControls(error: Error): void {
    for (const pending of this.controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.controls.clear();
  }

  private fail(error: Error): void {
    if (this.failed || this.exited) return;
    this.failed = true;
    this.rejectControls(error);
    this.child?.kill("SIGTERM");
    this.emit("error", error);
  }
}
