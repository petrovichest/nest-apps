import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import type { ParsedClaudeProxy } from "@codexnest/protocol";
import type { ClaudeModel, ClaudePermissionMode } from "./types.js";
import { createClaudeProxyEnvironment, type ClaudeProxyEnvironment } from "./proxy.js";

export const MAX_NATIVE_LINE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = MAX_NATIVE_LINE_BYTES;
const CONTROL_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_DELIVERY_CONTEXT = [
  "In ClaudeNest, images returned by tools (including image viewing and generation) appear only in expandable technical details, not in the main conversation.",
  "To show an image to the user, explicitly include a Markdown image or a labeled image-file link in your commentary, plan, or final message, using an absolute local path or an HTTPS image URL.",
  "Prefer files in the thread's working directory. Before linking a local image outside that directory, open it with Read in this thread, then link its exact path. If a tool returns only image data, save the chosen image in the working directory before linking it.",
  "Viewing, generating, or forwarding an image through a tool output does not attach it to your message. Do not claim to have shown an image unless you have included it in a user-facing message.",
].join(" ");

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
  effort?: string;
  permissionMode?: ClaudePermissionMode;
  noSessionPersistence?: boolean;
  /** Private JSON file with the MCP servers this session may use. */
  mcpConfigPath?: string;
  /** MCP server names whose tools are allowed without a permission prompt. */
  allowedMcpServers?: string[];
  env?: NodeJS.ProcessEnv;
  /** Undefined preserves legacy inherited connection settings; null explicitly selects direct. */
  proxy?: ParsedClaudeProxy | null;
  proxyEnvironment?: typeof createClaudeProxyEnvironment;
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
  private proxyConnection?: ClaudeProxyEnvironment;
  private initialized = false;
  private exited = false;
  private failed = false;
  private line = "";
  private lineBytes = 0;
  private controls = new Map<string, PendingControl>();
  private requests = new Set<string>();
  supportedModels: ClaudeModel[] = [];
  readonly livePermissionMode = true;
  model?: string;
  permissionMode: ClaudePermissionMode;

  constructor(private readonly options: ClaudeProcessOptions) {
    super();
    if (!isAbsolute(options.claudeBin))
      throw new Error("Claude executable must be an absolute path");
    if (!UUID.test(options.sessionId)) throw new Error("Invalid Claude session UUID");
    this.model = options.model;
    this.permissionMode = options.permissionMode ?? "manual";
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  private async startOnce(): Promise<void> {
    let env = { ...process.env, ...this.options.env };
    if (this.options.proxy !== undefined) {
      const configDir = env.CLAUDE_CONFIG_DIR;
      const nativeDefault =
        Object.hasOwn(this.options.env ?? {}, "CLAUDE_CONFIG_DIR") &&
        this.options.env?.CLAUDE_CONFIG_DIR === undefined;
      if (!configDir && !nativeDefault)
        throw new Error("Managed Claude account requires its native config directory");
      this.proxyConnection = await (this.options.proxyEnvironment ?? createClaudeProxyEnvironment)(
        this.options.proxy,
        configDir ?? "",
        { env },
      );
      env = this.proxyConnection.env;
    }
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
      this.permissionMode,
      // Enables an explicit later switch without changing the selected startup mode.
      "--allow-dangerously-skip-permissions",
      "--permission-prompt-tool",
      "stdio",
      "--append-system-prompt",
      IMAGE_DELIVERY_CONTEXT,
      this.options.resume ? "--resume" : "--session-id",
      this.options.sessionId,
    ];
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.effort) args.push("--effort", this.options.effort);
    if (this.options.noSessionPersistence) args.push("--no-session-persistence");
    if (this.options.mcpConfigPath) args.push("--mcp-config", this.options.mcpConfigPath);
    for (const server of this.options.allowedMcpServers ?? [])
      args.push("--allowedTools", `mcp__${server}`);
    try {
      this.child = (this.options.spawnProcess ?? spawn)(this.options.claudeBin, args, {
        cwd: this.options.cwd,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      await this.closeProxy();
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
      void this.closeProxy();
      this.emit("exit", { code, signal });
    });
    // spawn errors have no exit event, but always have close.
    child.once("close", () => {
      this.exited = true;
      this.initialized = false;
      this.rejectControls(new Error("Claude CLI closed before its control response"));
      void this.closeProxy();
    });
    try {
      const metadata = await this.control(
        { subtype: "initialize", hooks: null },
        INITIALIZE_TIMEOUT_MS,
      );
      if (Array.isArray(metadata.models)) {
        this.supportedModels = metadata.models
          .filter(object)
          .filter((item) => typeof item.value === "string")
          .map((item) => ({
            value: item.value as string,
            displayName:
              typeof item.displayName === "string" ? item.displayName : (item.value as string),
            description: typeof item.description === "string" ? item.description : "",
            ...(typeof item.resolvedModel === "string"
              ? { resolvedModel: item.resolvedModel }
              : {}),
            ...(typeof item.supportsEffort === "boolean"
              ? { supportsEffort: item.supportsEffort }
              : {}),
            ...(Array.isArray(item.supportedEffortLevels)
              ? {
                  supportedEffortLevels: item.supportedEffortLevels.filter(
                    (level): level is string => typeof level === "string",
                  ),
                }
              : {}),
          }));
      }
      if (this.exited || this.failed) throw new Error("Claude CLI exited during initialization");
      this.initialized = true;
    } catch (error) {
      child.stdin.end();
      if (!this.exited) child.kill("SIGTERM");
      await this.closeProxy();
      throw error;
    }
  }

  sendUser(requestId: string, text: string, content?: JsonObject[]): void {
    this.assertReady();
    if (!UUID.test(requestId)) throw new Error("Invalid user message UUID");
    this.write({
      type: "user",
      uuid: requestId,
      session_id: this.options.sessionId,
      parent_tool_use_id: null,
      message: { role: "user", content: content ?? text },
    });
  }

  async setModel(model: string): Promise<void> {
    this.assertReady();
    await this.control({ subtype: "set_model", model });
    this.model = model;
  }

  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.assertReady();
    const response = await this.control({ subtype: "set_permission_mode", mode });
    const canonical = (value: string) => (value === "manual" ? "default" : value);
    if (typeof response.mode === "string" && canonical(response.mode) !== canonical(mode))
      throw new ClaudeControlRejectedError(
        "Claude CLI did not select the requested permission mode",
      );
    this.permissionMode = mode;
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

  /** Experimental CLI /usage data; skips the local transcript scan behind its behaviors section. */
  async readUsage(): Promise<JsonObject> {
    this.assertReady();
    return this.control({ subtype: "get_usage", skip_behaviors: true });
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return this.closeProxy();
    // End stdin only after interrupt has cancelled any outstanding host prompts.
    if (this.initialized && !this.failed) {
      try {
        await this.interrupt();
      } catch {
        /* EOF and signal escalation still release the process. */
      }
    }
    child.stdin.end();
    if (await this.waitForExit(STOP_GRACE_MS)) return this.closeProxy();
    child.kill("SIGTERM");
    if (await this.waitForExit(STOP_GRACE_MS)) return this.closeProxy();
    child.kill("SIGKILL");
    await this.waitForExit(STOP_GRACE_MS);
    await this.closeProxy();
    if (!this.exited) throw new Error("Claude CLI did not exit after stop");
  }

  private async closeProxy(): Promise<void> {
    const connection = this.proxyConnection;
    this.proxyConnection = undefined;
    await connection?.close().catch(() => undefined);
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
        else
          pending.reject(new ClaudeControlRejectedError("Claude CLI rejected the control request"));
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
    if (
      message.type === "system" &&
      message.subtype === "init" &&
      typeof message.model === "string"
    )
      this.model = message.model;
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

export class ClaudeControlRejectedError extends Error {}
