import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ClaudeControlRejectedError, ClaudeProcess, MAX_NATIVE_LINE_BYTES } from "./claude.js";
import { writeJsonAtomic } from "./io.js";
import { BROWSER_MCP_SERVER_NAME, nativeResultInterrupted } from "./types.js";
import {
  isMainNativeEvent,
  nativeQuotaFailure,
  type NativeQuotaFailure,
} from "./quota-recovery.js";
import type {
  ClaudeModel,
  ClaudePermissionMode,
  CommandReceipt,
  RunnerDescriptor,
  RunnerEvent,
  RunnerSnapshot,
} from "./types.js";

export interface RunnerTransport extends EventEmitter {
  readonly pid: number | undefined;
  start(): Promise<void>;
  sendUser(requestId: string, text: string, content?: Record<string, unknown>[]): void;
  respond(requestId: string, response: Record<string, unknown>): void;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  readonly supportedModels?: ClaudeModel[];
  readonly model?: string;
  readonly permissionMode?: ClaudePermissionMode;
  readonly livePermissionMode?: boolean;
  setModel?(model: string): Promise<void>;
  setPermissionMode?(mode: ClaudePermissionMode): Promise<void>;
}

export interface RunnerOptions {
  transportFactory?: (descriptor: RunnerDescriptor) => RunnerTransport;
  claudeVersion?: string;
  replayByteLimit?: number;
  snapshotByteLimit?: number;
  maxClients?: number;
  maxLineBytes?: number;
  maxClientBufferedBytes?: number;
}

class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Client {
  socket: Socket;
  buffer: string;
  subscribed: boolean;
  queuedCommands: number;
}

interface SavedState extends Omit<RunnerSnapshot, "currentEvents"> {
  currentEvents: Record<string, unknown>[];
  error?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RunnerError("invalid_request", "Expected an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RunnerError("invalid_request", `${field} must be a non-empty string`);
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Owns Claude independently of any backend connection or backend process. */
export class SessionRunner {
  readonly runnerInstanceId = randomUUID();
  private readonly transport: RunnerTransport;
  private readonly clients = new Set<Client>();
  private readonly receipts = new Map<string, CommandReceipt>();
  private readonly pending = new Map<string, RunnerSnapshot["pendingRequests"][number]>();
  private readonly replay: Array<{ event: RunnerEvent; bytes: number }> = [];
  private readonly current: Array<{ event: Record<string, unknown>; bytes: number }> = [];
  private readonly options: Required<Omit<RunnerOptions, "transportFactory">>;
  private server?: Server;
  private sequence = 0;
  private replayBytes = 0;
  private currentBytes = 0;
  private currentTruncated = false;
  private state: RunnerSnapshot["state"] = "starting";
  private activeSendRequestId?: string;
  private readonly unacknowledgedInputs = new Set<string>();
  private readonly steeredInputs = new Set<string>();
  private awaitingResult = false;
  private publishedAwaitingResult?: boolean;
  private nativeTaskRunning = false;
  private interruptRequested = false;
  private terminalError?: string;
  private quotaFailure?: NativeQuotaFailure;
  private commandQueue = Promise.resolve();
  private persistenceQueue = Promise.resolve();
  private closing?: Promise<void>;
  private releaseRequested = false;
  private ownsSocket = false;
  private receiptsReady = false;

  constructor(
    readonly descriptor: RunnerDescriptor,
    options: RunnerOptions = {},
  ) {
    this.options = {
      claudeVersion: options.claudeVersion ?? "unknown",
      replayByteLimit: options.replayByteLimit ?? 8 * 1024 * 1024,
      snapshotByteLimit: options.snapshotByteLimit ?? 8 * 1024 * 1024,
      maxClients: options.maxClients ?? 16,
      maxLineBytes: options.maxLineBytes ?? 2 * 1024 * 1024,
      maxClientBufferedBytes: options.maxClientBufferedBytes ?? 16 * 1024 * 1024,
    };
    this.transport = options.transportFactory
      ? options.transportFactory(descriptor)
      : new ClaudeProcess({
          claudeBin: descriptor.claudeBin,
          cwd: descriptor.cwd,
          sessionId: descriptor.sessionId,
          resume: descriptor.resume,
          env: { CLAUDE_CONFIG_DIR: descriptor.defaultConfig ? undefined : descriptor.configDir },
          proxy: descriptor.proxy,
          ...(descriptor.model ? { model: descriptor.model } : {}),
          ...(descriptor.effort ? { effort: descriptor.effort } : {}),
          ...(descriptor.permissionMode ? { permissionMode: descriptor.permissionMode } : {}),
          ...(descriptor.browser
            ? {
                mcpConfigPath: descriptor.browser.configPath,
                allowedMcpServers: [BROWSER_MCP_SERVER_NAME],
              }
            : {}),
        });
    this.transport.on("event", (event: unknown) => this.onNativeEvent(event));
    this.transport.on("request", (event: unknown) => this.onRequest(event));
    this.transport.on("requestCancelled", (requestId: string) => {
      this.pending.delete(requestId);
      this.emit("request.cancelled", { requestId });
      if (this.state === "waiting") this.refreshState();
      this.persistState();
    });
    this.transport.on("error", (error: Error) => this.fail(error));
    this.transport.on(
      "exit",
      ({ code, signal }: { code: number | null; signal: string | null }) => {
        if (this.state === "closed") return;
        this.fail(new Error(`Claude exited (code ${code ?? "none"}, signal ${signal ?? "none"})`));
      },
    );
  }

  async start(): Promise<void> {
    await mkdir(this.descriptor.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.descriptor.stateDirectory, 0o700);
    await mkdir(dirname(this.descriptor.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.descriptor.socketPath), 0o700);
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.descriptor.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    this.ownsSocket = true;
    this.server.on("error", (error) => this.fail(error));
    await chmod(this.descriptor.socketPath, 0o600);
    try {
      await this.loadReceipts();
      await this.persistState();
      await this.transport.start();
      if (this.state === "starting") this.setState("idle");
      await this.persistenceQueue;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      await this.close();
      throw error;
    }
  }

  snapshot(): RunnerSnapshot {
    return {
      sessionId: this.descriptor.sessionId,
      runnerInstanceId: this.runnerInstanceId,
      protocolVersion: this.descriptor.protocolVersion,
      releasePath: this.descriptor.releasePath,
      claudeVersion: this.options.claudeVersion,
      runnerPid: process.pid,
      ...(this.transport.pid ? { claudePid: this.transport.pid } : {}),
      cwd: this.descriptor.cwd,
      ...(this.descriptor.accountId ? { accountId: this.descriptor.accountId } : {}),
      ...(this.quotaFailure ? { quotaFailure: this.quotaFailure } : {}),
      state: this.state,
      awaitingResult: this.awaitingResult,
      sequence: this.sequence,
      pendingRequests: [...this.pending.values()],
      currentEvents: [
        ...(this.currentTruncated ? [{ type: "claudenest_history_required" }] : []),
        ...this.current.map(({ event }) => event),
      ],
      commands: [...this.receipts.values()].map((receipt) => ({ ...receipt })),
      capabilities: {
        contentBlocks: Boolean(this.descriptor.attachmentRoot),
        uploadedImages: Boolean(this.descriptor.attachmentRoot),
        setModel: typeof this.transport.setModel === "function",
        setPermissionMode: typeof this.transport.setPermissionMode === "function",
        steer: true,
        livePermissionMode: Boolean(this.transport.livePermissionMode),
      },
      supportedModels: this.transport.supportedModels ?? [],
      ...((this.transport.model ?? this.descriptor.model)
        ? { model: this.transport.model ?? this.descriptor.model }
        : {}),
      permissionMode: this.transport.permissionMode ?? this.descriptor.permissionMode ?? "manual",
    };
  }

  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    const failed = this.state === "failed";
    if (!failed) this.setState("closed");
    for (const receipt of this.receipts.values()) {
      if (receipt.status === "accepted") receipt.status = "unknown";
    }
    try {
      await this.persistReceipts();
      await this.persistState();
    } finally {
      try {
        await this.transport.stop();
      } finally {
        for (const client of this.clients) client.socket.destroy();
        if (this.server?.listening) {
          await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        }
        if (this.ownsSocket) await unlink(this.descriptor.socketPath).catch(() => undefined);
        await this.persistenceQueue;
      }
    }
  }

  private accept(socket: Socket): void {
    if (this.clients.size >= this.options.maxClients) {
      socket.destroy();
      return;
    }
    const client: Client = { socket, buffer: "", subscribed: false, queuedCommands: 0 };
    this.clients.add(client);
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.clients.delete(client));
    socket.on("data", (data: string) => {
      client.buffer += data;
      for (;;) {
        const newline = client.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = client.buffer.slice(0, newline);
        client.buffer = client.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > this.options.maxLineBytes) {
          socket.destroy();
          return;
        }
        if (line.trim()) this.handleLine(client, line);
      }
      if (Buffer.byteLength(client.buffer) > this.options.maxLineBytes) socket.destroy();
    });
  }

  private handleLine(client: Client, line: string): void {
    let id: string | undefined;
    try {
      const request = record(JSON.parse(line));
      id = text(request.id, "id");
      const method = text(request.method, "method");
      if (method === "hello" || method === "snapshot") {
        this.write(client, { id, result: this.snapshot() });
      } else if (method === "subscribe") {
        const params = request.params === undefined ? {} : record(request.params);
        const cursor = params.afterSequence;
        if (cursor !== undefined && (!Number.isSafeInteger(cursor) || (cursor as number) < 0)) {
          throw new RunnerError("invalid_request", "afterSequence must be a non-negative integer");
        }
        const oldest = this.replay[0]?.event.sequence ?? this.sequence + 1;
        const resync =
          cursor === undefined ||
          (cursor as number) < oldest - 1 ||
          (cursor as number) > this.sequence ||
          (params.runnerInstanceId !== undefined &&
            params.runnerInstanceId !== this.runnerInstanceId);
        const events = resync
          ? []
          : this.replay
              .filter(({ event }) => event.sequence > (cursor as number))
              .map(({ event }) => event);
        this.write(client, { id, result: { resync, sequence: this.sequence } });
        if (resync) this.write(client, { type: "snapshot", snapshot: this.snapshot() });
        else for (const event of events) this.write(client, { type: "event", event });
        client.subscribed = true;
      } else {
        if (++client.queuedCommands > 64) {
          client.socket.destroy();
          return;
        }
        const requestId = id;
        this.commandQueue = this.commandQueue
          .then(async () => {
            try {
              const result = await this.command(method, request.params);
              this.write(client, { id: requestId, result });
            } catch (error) {
              this.writeError(client, requestId, error);
            } finally {
              client.queuedCommands--;
            }
          })
          .catch((error: unknown) =>
            this.fail(error instanceof Error ? error : new Error(String(error))),
          );
      }
    } catch (error) {
      this.writeError(client, id ?? "", error);
    }
  }

  private async command(method: string, rawParams: unknown): Promise<unknown> {
    if (this.releaseRequested) throw new RunnerError("unavailable", "Session is being released");
    if (method === "release") {
      if (
        (this.state !== "idle" && this.state !== "interrupted" && this.state !== "failed") ||
        (this.awaitingResult && this.state !== "failed")
      ) {
        throw new RunnerError("conflict", "Cannot release an active session");
      }
      if (this.pending.size) throw new RunnerError("conflict", "Session has pending requests");
      this.releaseRequested = true;
      setImmediate(() => void this.close().catch(() => undefined));
      return { released: true };
    }
    if (
      method !== "send" &&
      method !== "steer" &&
      method !== "interrupt" &&
      method !== "respond" &&
      method !== "setModel" &&
      method !== "setPermissionMode"
    ) {
      throw new RunnerError("method_not_found", `Unknown method: ${method}`);
    }
    const params = record(rawParams);
    const requestId = text(params.requestId, "requestId");
    const sendText =
      method === "send" || method === "steer"
        ? typeof params.text === "string"
          ? params.text
          : text(params.text, "text")
        : undefined;
    const response = method === "respond" ? record(params.response) : undefined;
    const fingerprint = createHash("sha256").update(canonical({ method, params })).digest("hex");
    const existing = this.receipts.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new RunnerError("conflict", "Request ID was already used with different data");
      return { ...existing };
    }
    if (this.state === "starting" || this.state === "failed" || this.state === "closed") {
      throw new RunnerError("unavailable", `Session is ${this.state}`);
    }
    if (
      method === "send" &&
      ((this.state !== "idle" && this.state !== "interrupted") || this.awaitingResult)
    ) {
      throw new RunnerError("conflict", "Session is already running");
    }
    if (method === "steer" && this.interruptRequested && this.awaitingResult)
      throw new RunnerError("conflict", "The interrupted task has not finished yet");
    if ((method === "send" || method === "steer") && this.unacknowledgedInputs.size >= 64)
      throw new RunnerError("conflict", "Too many inputs are awaiting native acknowledgement");
    const targetRequestId = response ? text(params.targetRequestId, "targetRequestId") : undefined;
    if (method === "respond" && !this.pending.has(targetRequestId!)) {
      throw new RunnerError("conflict", "Request is no longer pending");
    }
    if (method === "interrupt" && this.state !== "running" && this.state !== "waiting") {
      throw new RunnerError("conflict", "Session is not running");
    }
    const model = method === "setModel" ? text(params.model, "model") : undefined;
    const permissionMode =
      method === "setPermissionMode"
        ? (text(params.permissionMode, "permissionMode") as ClaudePermissionMode)
        : undefined;
    if (
      permissionMode &&
      ![
        "manual",
        "default",
        "acceptEdits",
        "bypassPermissions",
        "plan",
        "auto",
        "dontAsk",
      ].includes(permissionMode)
    )
      throw new RunnerError("invalid_request", "Unsupported permission mode");
    if (method === "setModel" || method === "setPermissionMode") {
      if (
        method === "setModel" &&
        (this.awaitingResult || this.pending.size || this.state !== "idle")
      )
        throw new RunnerError("conflict", "Settings can change only while the session is idle");
      if (
        (method === "setModel" && !this.transport.setModel) ||
        (method === "setPermissionMode" && !this.transport.setPermissionMode)
      )
        throw new RunnerError("method_not_found", "Owner does not support this setting");
    }
    const prepared =
      method === "send" || method === "steer"
        ? await this.prepareInput(params, requestId, sendText!)
        : undefined;
    const receipt: CommandReceipt = { requestId, kind: method, fingerprint, status: "accepted" };
    this.receipts.set(requestId, receipt);
    await this.persistReceipts();
    if (method === "respond" && !this.pending.has(targetRequestId!)) {
      receipt.status = "completed";
      receipt.error = "Request was cancelled before response dispatch";
      await this.persistReceipts();
      this.emit("command", { ...receipt });
      throw new RunnerError("conflict", receipt.error);
    }
    try {
      if (["failed", "closed"].includes(this.state) || receipt.status === "unknown") {
        throw new RunnerError("unavailable", "Claude became unavailable before command dispatch");
      }
      if (method === "send" || method === "steer") {
        const newTask = method === "send" || !this.awaitingResult;
        if (newTask) {
          this.current.length = 0;
          this.currentBytes = 0;
          this.currentTruncated = false;
          this.activeSendRequestId = requestId;
          this.quotaFailure = undefined;
          this.interruptRequested = false;
          this.nativeTaskRunning = true;
        } else this.steeredInputs.add(requestId);
        this.unacknowledgedInputs.add(requestId);
        this.awaitingResult = true;
        this.refreshState();
        this.transport.sendUser(requestId, prepared!.text, prepared!.content);
      } else if (method === "respond") {
        this.transport.respond(targetRequestId!, response!);
        this.pending.delete(targetRequestId!);
        this.emit("request.cancelled", { requestId: targetRequestId });
        this.refreshState();
        receipt.status = "completed";
      } else if (method === "interrupt") {
        this.interruptRequested = true;
        await this.transport.interrupt();
        receipt.status = "completed";
        for (const pendingId of this.pending.keys())
          this.emit("request.cancelled", { requestId: pendingId });
        this.pending.clear();
        this.setState("interrupted");
      } else {
        if (method === "setModel") await this.transport.setModel!(model!);
        else {
          await this.transport.setPermissionMode!(permissionMode!);
          if (permissionMode === "bypassPermissions") {
            for (const pending of [...this.pending.values()])
              if (pending.kind === "toolApproval") this.allowToolApproval(pending.requestId);
          }
        }
        receipt.status = "completed";
      }
      await this.persistReceipts();
      await this.persistState();
      this.emit("command", { ...receipt });
      return { ...receipt };
    } catch (error) {
      if (error instanceof ClaudeControlRejectedError) {
        if (method === "interrupt") this.interruptRequested = false;
        receipt.status = "completed";
        receipt.error = error.message;
        await this.persistReceipts();
        this.emit("command", { ...receipt });
        throw new RunnerError("invalid_request", error.message);
      }
      receipt.status = "unknown";
      receipt.error = error instanceof Error ? error.message : String(error);
      await this.persistReceipts();
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw new RunnerError(
        "delivery_unknown",
        "Command delivery could not be confirmed; it will not be resent",
      );
    }
  }

  private async prepareInput(
    params: Record<string, unknown>,
    requestId: string,
    input: string,
  ): Promise<{ text: string; content?: Record<string, unknown>[] }> {
    const content: Record<string, unknown>[] = [];
    const files: Array<{ name: string; path: string }> = [];
    let encodedImageBytes = 0;
    for (const kind of ["files", "images"] as const) {
      const refs = params[kind];
      if (refs === undefined) continue;
      if (!Array.isArray(refs) || refs.length > 20)
        throw new RunnerError(
          "invalid_request",
          `${kind} must contain at most 20 uploaded references`,
        );
      if (!refs.length) continue;
      if (!this.descriptor.attachmentRoot && refs.length)
        throw new RunnerError("method_not_found", "Owner has no upload directory");
      const root = this.descriptor.attachmentRoot
        ? await realpath(this.descriptor.attachmentRoot)
        : "";
      for (const raw of refs) {
        const ref = record(raw);
        const path = await realpath(text(ref.path, "attachment.path")).catch(() => {
          throw new RunnerError("invalid_request", "Attachment is unavailable");
        });
        const remainder = relative(root, path);
        if (!remainder || remainder.startsWith("..") || isAbsolute(remainder))
          throw new RunnerError(
            "invalid_request",
            "Attachment is outside the private upload directory",
          );
        const info = await stat(path);
        if (!info.isFile() || info.size !== ref.size)
          throw new RunnerError("invalid_request", "Attachment size changed");
        const name = text(ref.name, "attachment.name");
        if (kind === "files") files.push({ name, path });
        else {
          if (
            info.size > 8 * 1024 * 1024 ||
            !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(String(ref.mediaType))
          )
            throw new RunnerError("invalid_request", "Image type or size is unsupported");
          encodedImageBytes += 4 * Math.ceil(info.size / 3);
          if (encodedImageBytes + Buffer.byteLength(input) > MAX_NATIVE_LINE_BYTES - 64 * 1024)
            throw new RunnerError(
              "invalid_request",
              "Images exceed Claude's aggregate input limit",
            );
          const bytes = await readFile(path);
          if (bytes.length !== ref.size)
            throw new RunnerError("invalid_request", "Image size changed");
          content.push({
            type: "image",
            source: { type: "base64", media_type: ref.mediaType, data: bytes.toString("base64") },
          });
        }
      }
    }
    let formatted = input;
    if (files.length)
      formatted += `${formatted ? "\n\n" : ""}<claudenest_attachments>\nThe user attached local files. Read them from these absolute paths before responding:\n${JSON.stringify(files)}\n</claudenest_attachments>`;
    if (formatted) content.unshift({ type: "text", text: formatted });
    if (!content.length)
      throw new RunnerError("invalid_request", "Message has no text or attachments");
    const native = {
      type: "user",
      uuid: requestId,
      session_id: this.descriptor.sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content:
          params.images && content.some((part) => part.type === "image") ? content : formatted,
      },
    };
    if (Buffer.byteLength(JSON.stringify(native)) + 1 > MAX_NATIVE_LINE_BYTES)
      throw new RunnerError("invalid_request", "Message exceeds Claude's 16 MiB input limit");
    return {
      text: formatted,
      ...(content.some((part) => part.type === "image") ? { content } : {}),
    };
  }

  private onNativeEvent(rawEvent: unknown): void {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) return;
    let event = rawEvent as Record<string, unknown>;
    const nativeTimestamp = event.timestamp;
    if (
      !(typeof nativeTimestamp === "number" && Number.isFinite(nativeTimestamp)) &&
      !(typeof nativeTimestamp === "string" && Number.isFinite(Date.parse(nativeTimestamp)))
    )
      event = { ...event, timestamp: Date.now() };
    const inputId = event.type === "user" ? (event.uuid ?? event.request_id) : undefined;
    const inputReceipt = typeof inputId === "string" ? this.receipts.get(inputId) : undefined;
    if (inputId === this.descriptor.quotaRecoveryId)
      event = { ...event, claudenest_quota_continuation: true };
    if (inputReceipt?.kind === "steer" && this.steeredInputs.has(inputReceipt.requestId))
      event = { ...event, claudenest_delivery: "steer" };
    const interrupted =
      event.type === "result" &&
      isMainNativeEvent(event) &&
      (this.interruptRequested || nativeResultInterrupted(event));
    if (interrupted) event = { ...event, claudenest_interrupted: true };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.current.push({ event, bytes });
    this.currentBytes += bytes;
    while (this.currentBytes > this.options.snapshotByteLimit && this.current.length) {
      this.currentBytes -= this.current.shift()!.bytes;
      this.currentTruncated = true;
    }
    if (event.type === "result" && isMainNativeEvent(event)) {
      const failure = nativeQuotaFailure(this.current.map(({ event }) => event));
      this.quotaFailure = failure ? { terminalSequence: this.sequence + 1, ...failure } : undefined;
    }
    this.emit("native", event);
    if (event.type === "user") {
      const uuid = event.uuid ?? event.request_id;
      const receipt = typeof uuid === "string" ? this.receipts.get(uuid) : undefined;
      if (
        (receipt?.kind === "send" || receipt?.kind === "steer") &&
        receipt.status === "accepted"
      ) {
        receipt.status = "completed";
        this.unacknowledgedInputs.delete(receipt.requestId);
        this.steeredInputs.delete(receipt.requestId);
        this.nativeTaskRunning = true;
        this.awaitingResult = true;
        void this.persistReceipts();
        this.emit("command", { ...receipt });
      }
    }
    if (
      ((event.type === "system" && event.subtype === "command_lifecycle") ||
        event.type === "command_lifecycle") &&
      event.state === "cancelled" &&
      typeof event.command_uuid === "string"
    ) {
      const receipt = this.receipts.get(event.command_uuid);
      if (
        (receipt?.kind === "send" || receipt?.kind === "steer") &&
        receipt.status === "accepted"
      ) {
        receipt.status = "unknown";
        receipt.error = "Native command was cancelled before input acknowledgement";
        this.unacknowledgedInputs.delete(receipt.requestId);
        this.steeredInputs.delete(receipt.requestId);
        this.awaitingResult = this.nativeTaskRunning || this.unacknowledgedInputs.size > 0;
        this.emit("command", { ...receipt });
        void this.persistReceipts();
        if (this.state !== "interrupted") this.refreshState();
      }
    }
    if (event.type === "result" && isMainNativeEvent(event)) {
      this.nativeTaskRunning = false;
      if (this.activeSendRequestId) {
        const receipt = this.receipts.get(this.activeSendRequestId);
        if (receipt?.status === "accepted") {
          receipt.status = "completed";
          void this.persistReceipts();
          this.emit("command", { ...receipt });
        }
        this.unacknowledgedInputs.delete(this.activeSendRequestId);
      }
      this.activeSendRequestId = undefined;
      if (interrupted) {
        for (const requestId of this.unacknowledgedInputs) {
          const receipt = this.receipts.get(requestId);
          if (receipt?.status === "accepted") {
            receipt.status = "unknown";
            receipt.error = "Input was not acknowledged before interruption";
            this.emit("command", { ...receipt });
          }
        }
        this.unacknowledgedInputs.clear();
        this.steeredInputs.clear();
        void this.persistReceipts();
      }
      this.awaitingResult = this.unacknowledgedInputs.size > 0;
      for (const requestId of this.pending.keys()) this.emit("request.cancelled", { requestId });
      this.pending.clear();
      if (this.state !== "failed" && this.state !== "closed") {
        if (interrupted) this.setState("interrupted");
        else this.refreshState();
      }
      void this.persistState();
    }
  }

  private onRequest(rawEvent: unknown): void {
    if (this.state === "failed" || this.state === "closed" || this.releaseRequested) return;
    try {
      const event = record(rawEvent);
      const requestId = text(event.request_id, "request_id");
      const request = record(event.request);
      const input =
        request.input && typeof request.input === "object" && !Array.isArray(request.input)
          ? (request.input as Record<string, unknown>)
          : {};
      const pending = {
        requestId,
        toolName:
          typeof request.tool_name === "string"
            ? request.tool_name
            : String(request.subtype ?? "unknown"),
        input,
        kind:
          request.tool_name === "AskUserQuestion"
            ? ("userQuestion" as const)
            : request.subtype === "can_use_tool"
              ? ("toolApproval" as const)
              : ("other" as const),
        ...(typeof request.tool_use_id === "string" ? { toolUseId: request.tool_use_id } : {}),
        ...(Array.isArray(request.permission_suggestions)
          ? {
              suggestions: request.permission_suggestions.filter(
                (value): value is Record<string, unknown> =>
                  Boolean(value) && typeof value === "object" && !Array.isArray(value),
              ),
            }
          : {}),
      };
      this.pending.set(requestId, pending);
      if (
        pending.kind === "toolApproval" &&
        (this.transport.permissionMode ?? this.descriptor.permissionMode) === "bypassPermissions"
      ) {
        this.allowToolApproval(requestId);
        return;
      }
      this.emit("request", pending);
      this.refreshState();
      void this.persistState();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private allowToolApproval(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.kind !== "toolApproval") return;
    this.transport.respond(requestId, { behavior: "allow", updatedInput: pending.input });
    this.pending.delete(requestId);
    this.emit("request.cancelled", { requestId });
    this.refreshState();
    void this.persistState();
  }

  private refreshState(): void {
    if (this.state === "failed" || this.state === "closed") return;
    this.setState(
      this.interruptRequested && this.awaitingResult
        ? "interrupted"
        : this.pending.size
          ? "waiting"
          : this.awaitingResult
            ? "running"
            : "idle",
    );
  }

  private emit(kind: RunnerEvent["kind"], data: unknown): void {
    const event: RunnerEvent = {
      sessionId: this.descriptor.sessionId,
      runnerInstanceId: this.runnerInstanceId,
      sequence: ++this.sequence,
      kind,
      data,
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.replay.push({ event, bytes });
    this.replayBytes += bytes;
    while (this.replayBytes > this.options.replayByteLimit && this.replay.length)
      this.replayBytes -= this.replay.shift()!.bytes;
    for (const client of this.clients)
      if (client.subscribed) this.write(client, { type: "event", event });
  }

  private setState(state: RunnerSnapshot["state"]): void {
    if (this.state === state && this.publishedAwaitingResult === this.awaitingResult) return;
    this.state = state;
    this.publishedAwaitingResult = this.awaitingResult;
    this.emit("state", { state, awaitingResult: this.awaitingResult });
    void this.persistState();
  }

  private fail(error: Error): void {
    if (this.state === "closed") return;
    this.terminalError = error.message;
    for (const receipt of this.receipts.values()) {
      if (receipt.status === "accepted") {
        receipt.status = "unknown";
        receipt.error = error.message;
        this.emit("command", { ...receipt });
      }
    }
    for (const requestId of this.pending.keys()) this.emit("request.cancelled", { requestId });
    this.pending.clear();
    this.unacknowledgedInputs.clear();
    this.steeredInputs.clear();
    this.nativeTaskRunning = false;
    this.awaitingResult = false;
    this.setState("failed");
    void this.persistReceipts();
    void this.persistState();
  }

  private write(client: Client, message: unknown): void {
    if (client.socket.destroyed) return;
    const line = `${JSON.stringify(message)}\n`;
    if (
      client.socket.writableLength + Buffer.byteLength(line) >
      this.options.maxClientBufferedBytes
    ) {
      client.socket.destroy();
      return;
    }
    client.socket.write(line);
  }

  private writeError(client: Client, id: string, error: unknown): void {
    this.write(client, {
      id,
      error: {
        code: error instanceof RunnerError ? error.code : "internal_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  private async loadReceipts(): Promise<void> {
    try {
      const saved = JSON.parse(
        await readFile(join(this.descriptor.stateDirectory, "commands.json"), "utf8"),
      ) as CommandReceipt[];
      if (!Array.isArray(saved)) throw new Error("Invalid command receipt file");
      for (const receipt of saved) {
        if (receipt.status === "accepted") receipt.status = "unknown";
        this.receipts.set(receipt.requestId, receipt);
      }
      this.receiptsReady = true;
      await this.persistReceipts();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.receiptsReady = true;
    }
  }

  private persistReceipts(): Promise<void> {
    if (!this.receiptsReady) return Promise.resolve();
    const receipts = [...this.receipts.values()].map((receipt) => ({ ...receipt }));
    return this.persist(join(this.descriptor.stateDirectory, "commands.json"), receipts);
  }

  private persistState(): Promise<void> {
    const snapshot = this.snapshot();
    const saved: SavedState = {
      ...snapshot,
      currentEvents: [],
      ...(this.terminalError ? { error: this.terminalError } : {}),
    };
    return this.persist(join(this.descriptor.stateDirectory, "runner-state.json"), saved);
  }

  private persist(path: string, value: unknown): Promise<void> {
    const next = this.persistenceQueue.then(() => writeJsonAtomic(path, value));
    // Keep the queue usable while exposing each write's failure to its caller.
    this.persistenceQueue = next.catch((error: unknown) => {
      this.terminalError = error instanceof Error ? error.message : String(error);
      for (const receipt of this.receipts.values()) {
        if (receipt.status === "accepted") {
          receipt.status = "unknown";
          receipt.error = this.terminalError;
          this.emit("command", { ...receipt });
        }
      }
      for (const requestId of this.pending.keys()) this.emit("request.cancelled", { requestId });
      this.pending.clear();
      this.unacknowledgedInputs.clear();
      this.steeredInputs.clear();
      this.nativeTaskRunning = false;
      this.awaitingResult = false;
      if (this.state !== "failed" && this.state !== "closed") {
        this.state = "failed";
        this.publishedAwaitingResult = this.awaitingResult;
        this.emit("state", {
          state: "failed",
          awaitingResult: this.awaitingResult,
          error: this.terminalError,
        });
      }
    });
    return next;
  }
}
