import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import {
  CLAUDE_BROWSER_EXTENSION_ORIGIN,
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_EXTENSION_WEBSOCKET_PATH,
  BROWSER_MAX_TOOL_RESULT_BYTES,
  BROWSER_MAX_PROJECT_FILE_BYTES,
  BROWSER_TOOL_RESULT_CHUNK_BYTES,
  BROWSER_TOOL_NAMES,
  isBrowserExtensionClientFrame,
  type BrowserExtensionBindingSummary,
  type BrowserExtensionClientFrame,
  type BrowserExtensionProjectSummary,
  type BrowserExtensionServerFrame,
  type BrowserExtensionThreadSummary,
  type BrowserThreadStatus,
  type BrowserName,
  type BrowserNetworkCaptureAbortFrame,
  type BrowserNetworkCaptureChunkFrame,
  type BrowserNetworkCaptureCommitFrame,
  type BrowserNetworkCaptureStartFrame,
  type BrowserToolName,
  type ServerEvent,
  type ThreadSummary,
} from "@codexnest/protocol";

import { BrowserCaptureStore, MAX_NETWORK_BODY_READ_BYTES } from "./browser-capture-store";
import type { Config } from "./config";
import { BROWSER_MCP_SERVER_NAME } from "./types";
import type { UiService } from "./ui-service";
import type { BrowserBindingState } from "./ui-store";

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_DISCONNECT_WAIT_MS = 30_000;
const DEFAULT_TOOL_RESPONSE_MS = 120_000;
const INTERNAL_SECRET_HEADER = "x-claudenest-browser-secret";
const MCP_PROTOCOL_VERSION = "2025-11-25";
type ServerBrowserToolName = BrowserToolName;
const SERVER_BROWSER_TOOL_NAMES = BROWSER_TOOL_NAMES;

export interface BrowserExtensionOptions {
  app: FastifyInstance;
  ui: UiService;
  config: Pick<Config, "token" | "port" | "allowedOrigins">;
  authTimeoutMs?: number;
  heartbeatMs?: number;
  disconnectWaitMs?: number;
  toolResponseMs?: number;
  captureStore?: BrowserCaptureStore;
}

interface ExtensionConnection {
  socket: WebSocket;
  instanceId: string;
  activeThreadId: string | null;
  bindingThreadIds: Set<string>;
  bindingTabIds: Map<string, Set<string>>;
  browser: BrowserName;
  lastPongAt: number;
}

interface PendingToolCall {
  socket: WebSocket;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  transferId?: string;
  resultChunks?: Array<string | undefined>;
  resultChunkCount?: number;
  resultChunksReceived?: number;
  resultBytes?: number;
}

interface PendingFileTransfer {
  socket: WebSocket;
  path: string;
  size: number;
  device: number;
  inode: number;
}

export class BrowserExtensionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserExtensionError";
  }
}

export class BrowserExtensionServer {
  private readonly app: FastifyInstance;
  private readonly ui: UiService;
  private readonly config: BrowserExtensionOptions["config"];
  private readonly allowedOrigins: Set<string>;
  private readonly authTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly disconnectWaitMs: number;
  private readonly toolResponseMs: number;
  private readonly secret: string;
  private readonly captures: BrowserCaptureStore;
  private readonly connections = new Map<string, ExtensionConnection>();
  private readonly pendingTools = new Map<string, PendingToolCall>();
  private readonly pendingFileTransfers = new Map<string, PendingFileTransfer>();
  private readonly connectionEvents = new EventEmitter();
  private readonly locks = new Map<string, Promise<unknown>>();
  private heartbeat?: NodeJS.Timeout;
  private catalogUpdate?: NodeJS.Immediate;
  private readonly catalogChanged = (frame: { type?: string; event?: ServerEvent }) => {
    if (
      frame.type !== "event" ||
      !frame.event ||
      !isBrowserCatalogEvent(frame.event) ||
      this.catalogUpdate
    ) {
      return;
    }
    this.catalogUpdate = setImmediate(() => {
      this.catalogUpdate = undefined;
      for (const connection of this.connections.values()) {
        this.send(connection.socket, {
          type: "catalog.updated",
          ...this.catalog(connection.instanceId),
        });
      }
    });
  };

  constructor(options: BrowserExtensionOptions) {
    this.app = options.app;
    this.ui = options.ui;
    this.config = options.config;
    this.allowedOrigins = new Set([
      ...options.config.allowedOrigins,
      CLAUDE_BROWSER_EXTENSION_ORIGIN,
    ]);
    this.authTimeoutMs = options.authTimeoutMs ?? 5_000;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.disconnectWaitMs = options.disconnectWaitMs ?? DEFAULT_DISCONNECT_WAIT_MS;
    this.toolResponseMs = options.toolResponseMs ?? DEFAULT_TOOL_RESPONSE_MS;
    // Session runners outlive this process, so the secret must survive restarts.
    this.secret = createHmac("sha256", options.config.token)
      .update("claudenest-browser-mcp")
      .digest("base64url");
    this.captures = options.captureStore ?? new BrowserCaptureStore(options.ui.store.path);
  }

  get captureRoot(): string {
    return this.captures.root;
  }

  registerRoutes(): void {
    void this.captures.initialize().catch((error) => {
      this.app.log.error({ err: error }, "Failed to initialize browser capture storage");
    });
    this.ui.setBrowserStatusProvider((threadId) => this.browserStatus(threadId));

    this.app.get(BROWSER_EXTENSION_WEBSOCKET_PATH, { websocket: true }, (socket, request) =>
      this.acceptSocket(socket, request),
    );
    this.app.post<{ Params: { bindingId: string } }>(
      "/api/v1/internal/browser-mcp/:bindingId",
      async (request, reply) => {
        if (!isLoopbackAddress(request.ip) || !this.validInternalSecret(request)) {
          return reply
            .code(403)
            .send({ error: { code: "forbidden", message: "Browser MCP access denied" } });
        }
        const response = await this.handleMcp(request.params.bindingId, request.body);
        if (response === null) return reply.code(202).send();
        return reply.header("Cache-Control", "no-store").type("application/json").send(response);
      },
    );

    this.heartbeat = setInterval(() => this.runHeartbeat(), this.heartbeatMs);
    this.heartbeat.unref();
    this.app.addHook("onClose", async () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.catalogUpdate) clearImmediate(this.catalogUpdate);
      this.ui.off("frame", this.catalogChanged);
      for (const pending of this.pendingTools.values()) {
        clearTimeout(pending.timer);
        pending.reject(new BrowserExtensionError("disconnected", "Browser tool outcome unknown"));
      }
      this.pendingTools.clear();
      this.pendingFileTransfers.clear();
      this.connectionEvents.removeAllListeners();
    });
  }

  browserStatus(threadId: string): BrowserThreadStatus {
    const meta = this.thread(threadId);
    if (meta?.browserEnabled !== true) return "disabled";
    const binding = meta.browserBinding;
    if (!binding) return "disconnected";
    return this.isBindingConnected(threadId, binding) ? "connected" : "disconnected";
  }

  /** The MCP server a session owner must be launched with, if its thread has a browser binding. */
  launchConfig(
    threadId: string,
  ): { bindingId: string; mcpConfig: Record<string, unknown> } | undefined {
    const meta = this.thread(threadId);
    const binding = meta?.browserEnabled === true ? meta.browserBinding : undefined;
    if (!binding) return undefined;
    return {
      bindingId: binding.bindingId,
      mcpConfig: {
        mcpServers: {
          [BROWSER_MCP_SERVER_NAME]: {
            type: "http",
            url: `http://127.0.0.1:${this.config.port}/api/v1/internal/browser-mcp/${encodeURIComponent(binding.bindingId)}`,
            headers: { [INTERNAL_SECRET_HEADER]: this.secret },
          },
        },
      },
    };
  }

  async detach(instanceId: string, threadId: string): Promise<ThreadSummary> {
    const binding = this.assertOwnedBinding(instanceId, threadId);
    return this.markDetached(instanceId, threadId, binding.bindingId, false);
  }

  async detachThread(threadId: string): Promise<ThreadSummary> {
    await this.disableThread(threadId);
    return this.requireSummary(threadId);
  }

  private async markDetached(
    instanceId: string,
    threadId: string,
    bindingId: string,
    notifyExtension: boolean,
  ): Promise<ThreadSummary> {
    await this.ui.store.update((data) => {
      const current = data.threads[threadId]?.browserBinding;
      if (!current || current.bindingId !== bindingId) return;
      current.detachedAt = Date.now();
    });
    const connection = this.connections.get(instanceId);
    connection?.bindingThreadIds.delete(threadId);
    connection?.bindingTabIds.delete(bindingId);
    if (connection?.activeThreadId === threadId) connection.activeThreadId = null;
    this.publishThreadState(threadId);
    this.connectionEvents.emit("changed");
    const summary = this.requireSummary(threadId);
    if (notifyExtension) this.send(connection?.socket, { type: "binding.detach", threadId });
    return summary;
  }

  activate(instanceId: string, threadId: string): ThreadSummary {
    const binding = this.assertOwnedBinding(instanceId, threadId);
    if (binding.detachedAt !== undefined) {
      throw new BrowserExtensionError(
        "detached",
        "Attach the browser binding before activating it",
      );
    }
    const connection = this.connections.get(instanceId);
    if (!connection) throw new BrowserExtensionError("disconnected", "Extension is disconnected");
    const previous = connection.activeThreadId;
    connection.activeThreadId = threadId;
    connection.bindingThreadIds.add(threadId);
    if (previous && previous !== threadId) this.publishThreadState(previous);
    this.publishThreadState(threadId);
    return this.requireSummary(threadId);
  }

  async enableThread(threadId: string): Promise<void> {
    await this.withLock(threadId, async () => {
      this.assertBrowserWritable(threadId);
      const meta = this.thread(threadId);
      if (meta?.browserEnabled === true) return;
      this.assertIdle(threadId, "enabled");
      const staleBinding = meta?.browserBinding;
      await this.ui.store.update((data) => {
        const current = data.threads[threadId];
        if (!current) throw new BrowserExtensionError("not_found", "Thread not found");
        if (staleBinding && current.browserBinding?.bindingId !== staleBinding.bindingId) {
          throw new BrowserExtensionError("conflict", "Browser binding changed");
        }
        current.browserEnabled = true;
        delete current.browserBinding;
      });
      if (staleBinding) this.detachConnection(threadId, staleBinding);
      this.publishThreadState(threadId);
      this.connectionEvents.emit("changed");
    });
  }

  async disableThread(threadId: string): Promise<void> {
    await this.withLock(threadId, async () => {
      this.assertBrowserWritable(threadId);
      const meta = this.thread(threadId);
      const binding = meta?.browserBinding;
      if (meta?.browserEnabled !== true && !binding) return;
      this.assertIdle(threadId, "disabled");
      await this.ui.store.update((data) => {
        const current = data.threads[threadId];
        if (!current) return;
        delete current.browserEnabled;
        delete current.browserBinding;
      });
      if (binding) this.detachConnection(threadId, binding);
      this.publishThreadState(threadId);
      this.connectionEvents.emit("changed");
    });
  }

  private attachThread(
    instanceId: string,
    threadId: string,
    bindingId: string,
  ): Promise<ThreadSummary> {
    return this.withLock(threadId, async () => {
      this.assertBrowserWritable(threadId);
      const meta = this.thread(threadId);
      if (meta?.browserEnabled !== true) {
        throw new BrowserExtensionError("not_enabled", "Browser access is not enabled");
      }
      this.assertIdle(threadId, "attached");
      const existing = meta.browserBinding;
      if (existing && existing.instanceId !== instanceId && existing.detachedAt === undefined) {
        throw new BrowserExtensionError(
          "owned_by_another_instance",
          "Browser binding belongs to another extension instance",
        );
      }
      const transferring = existing !== undefined && existing.instanceId !== instanceId;
      const effectiveBindingId = transferring ? bindingId : (existing?.bindingId ?? bindingId);
      await this.ui.store.update((data) => {
        const current = data.threads[threadId]?.browserBinding;
        if (
          (existing &&
            (current?.bindingId !== existing.bindingId ||
              current.instanceId !== existing.instanceId)) ||
          (!existing && current)
        ) {
          throw new BrowserExtensionError("conflict", "Browser binding changed");
        }
        data.threads[threadId]!.browserBinding = {
          bindingId: effectiveBindingId,
          instanceId,
          attachedAt: Date.now(),
        };
      });
      this.publishThreadState(threadId);
      return this.requireSummary(threadId);
    });
  }

  private detachConnection(threadId: string, binding: BrowserBindingState): void {
    const connection = this.connections.get(binding.instanceId);
    if (connection?.activeThreadId === threadId) connection.activeThreadId = null;
    connection?.bindingThreadIds.delete(threadId);
    connection?.bindingTabIds.delete(binding.bindingId);
    this.send(connection?.socket, { type: "binding.detach", threadId });
  }

  private withLock<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(threadId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.locks.set(threadId, result);
    void result
      .finally(() => {
        if (this.locks.get(threadId) === result) this.locks.delete(threadId);
      })
      .catch(() => undefined);
    return result;
  }

  private thread(threadId: string) {
    return this.ui.store.data.threads[threadId];
  }

  private summary(threadId: string): ThreadSummary | undefined {
    return this.thread(threadId) ? this.ui.summary(threadId) : undefined;
  }

  private requireSummary(threadId: string): ThreadSummary {
    const summary = this.summary(threadId);
    if (!summary) throw new BrowserExtensionError("not_found", "Thread not found");
    return summary;
  }

  private publishThreadState(threadId: string): void {
    const summary = this.summary(threadId);
    if (summary) this.ui.publish({ type: "thread.upserted", thread: summary });
  }

  private assertBrowserWritable(threadId: string): void {
    const summary = this.requireSummary(threadId);
    if (summary.relation.kind === "subagent") {
      throw new BrowserExtensionError("not_writable", "Subagent threads cannot use Browser MCP");
    }
    if (summary.archived) {
      throw new BrowserExtensionError("not_writable", "Archived threads cannot use Browser MCP");
    }
    if (!summary.projectId) {
      throw new BrowserExtensionError(
        "not_writable",
        "Thread is not in a writable ClaudeNest project",
      );
    }
  }

  private assertIdle(threadId: string, action: string): void {
    const summary = this.requireSummary(threadId);
    if (
      summary.currentTurnId !== null ||
      summary.state === "running" ||
      summary.state === "queued" ||
      summary.state === "needsAttention"
    ) {
      throw new BrowserExtensionError(
        "thread_busy",
        `Browser access cannot be ${action} while the thread is busy`,
      );
    }
  }

  private acceptSocket(socket: WebSocket, request: FastifyRequest): void {
    if (!isAllowedRequestOrigin(request, this.allowedOrigins)) {
      socket.close(1008, "Origin not allowed");
      return;
    }
    const url = new URL(request.url, "http://localhost");
    if (url.searchParams.has("token") || url.searchParams.has("access_token")) {
      socket.close(1008, "Token must not be passed in URL");
      return;
    }

    let connection: ExtensionConnection | undefined;
    const timeout = setTimeout(
      () => socket.close(1008, "Authentication timeout"),
      this.authTimeoutMs,
    );
    timeout.unref();
    socket.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        socket.close(1003, "Malformed frame");
        return;
      }
      if (!isBrowserExtensionClientFrame(frame)) {
        if (
          !connection &&
          isRecord(frame) &&
          frame.type === "client.hello" &&
          frame.protocol === BROWSER_EXTENSION_PROTOCOL &&
          typeof frame.token === "string" &&
          equalToken(frame.token, this.config.token) &&
          typeof frame.version === "number" &&
          frame.version !== BROWSER_EXTENSION_PROTOCOL_VERSION
        ) {
          socket.close(1002, "Unsupported browser protocol version");
          return;
        }
        socket.close(1008, "Invalid frame");
        return;
      }
      if (!connection) {
        if (frame.type !== "client.hello" || !equalToken(frame.token, this.config.token)) {
          socket.close(1008, "Unauthorized");
          return;
        }
        if (
          frame.protocol !== BROWSER_EXTENSION_PROTOCOL ||
          frame.version !== BROWSER_EXTENSION_PROTOCOL_VERSION
        ) {
          socket.close(1002, "Unsupported browser protocol version");
          return;
        }
        if (
          BROWSER_TOOL_NAMES.some((tool) => !frame.capabilities.tools.includes(tool)) ||
          frame.capabilities.maxProjectFileBytes < BROWSER_MAX_PROJECT_FILE_BYTES
        ) {
          socket.close(1002, "Unsupported browser capabilities");
          return;
        }
        clearTimeout(timeout);
        const previous = this.connections.get(frame.instanceId);
        const bindingThreadIds = new Set(
          frame.bindings.flatMap((binding) => {
            const meta = this.thread(binding.threadId);
            const stored = meta?.browserBinding;
            return meta?.browserEnabled === true &&
              stored?.instanceId === frame.instanceId &&
              stored.detachedAt === undefined
              ? [binding.threadId]
              : [];
          }),
        );
        const bindingTabIds = new Map<string, Set<string>>();
        for (const binding of frame.bindings) {
          if (!bindingThreadIds.has(binding.threadId)) continue;
          const bindingId = this.thread(binding.threadId)?.browserBinding?.bindingId;
          if (!bindingId) continue;
          bindingTabIds.set(bindingId, new Set(binding.tabIds.map(String)));
        }
        connection = {
          socket,
          instanceId: frame.instanceId,
          activeThreadId: null,
          bindingThreadIds,
          bindingTabIds,
          browser: frame.browser.name,
          lastPongAt: Date.now(),
        };
        this.connections.set(frame.instanceId, connection);
        this.ui.off("frame", this.catalogChanged);
        this.ui.on("frame", this.catalogChanged);
        if (previous && previous.socket !== socket) previous.socket.close(4000, "Reconnected");
        const catalog = this.catalog(frame.instanceId);
        this.send(socket, {
          type: "server.hello",
          protocol: BROWSER_EXTENSION_PROTOCOL,
          version: frame.version,
          locale: this.ui.store.data.uiLanguage,
          ...catalog,
        });
        for (const binding of frame.bindings) {
          if (!bindingThreadIds.has(binding.threadId)) {
            this.send(socket, { type: "binding.detach", threadId: binding.threadId });
          }
        }
        this.publishInstanceBindings(frame.instanceId);
        this.connectionEvents.emit("changed");
        return;
      }
      connection.lastPongAt = Date.now();
      if (frame.type === "client.pong") {
        connection.lastPongAt = Date.now();
      } else if (frame.type === "client.ping") {
        this.send(socket, { type: "server.pong", at: frame.at });
      } else if (frame.type === "tool.result") {
        this.finishToolCall(socket, frame.requestId, true, frame.result);
      } else if (frame.type === "tool.result.chunk") {
        this.acceptToolResultChunk(socket, frame);
      } else if (frame.type === "tool.error") {
        this.finishToolCall(socket, frame.requestId, false, undefined, frame.error.message);
      } else if (frame.type === "session.request") {
        void this.handleSessionRequest(connection, frame).catch(() => undefined);
      } else if (frame.type === "binding.updated") {
        this.acceptBindingUpdated(connection, frame.binding);
      } else if (frame.type === "binding.detached") {
        void this.acceptBindingDetached(connection, frame.binding);
      } else if (frame.type === "file.request") {
        void this.sendProjectFile(socket, frame.transferId);
      } else if (frame.type === "network.capture.start") {
        void this.acceptNetworkCaptureStart(connection, frame);
      } else if (frame.type === "network.capture.chunk") {
        void this.acceptNetworkCaptureChunk(connection, frame);
      } else if (frame.type === "network.capture.commit") {
        void this.acceptNetworkCaptureCommit(connection, frame);
      } else if (frame.type === "network.capture.abort") {
        void this.acceptNetworkCaptureAbort(connection, frame);
      } else {
        socket.close(1008, "Unexpected frame");
      }
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (!connection) return;
      const current = this.connections.get(connection.instanceId);
      if (current?.socket === socket) this.connections.delete(connection.instanceId);
      if (!this.connections.size) this.ui.off("frame", this.catalogChanged);
      for (const [callId, pending] of this.pendingTools) {
        if (pending.socket !== socket) continue;
        this.pendingTools.delete(callId);
        clearTimeout(pending.timer);
        pending.reject(
          new BrowserExtensionError(
            "outcome_unknown",
            "Browser tool connection was lost after dispatch; outcome unknown",
          ),
        );
        if (pending.transferId) this.pendingFileTransfers.delete(pending.transferId);
      }
      for (const [transferId, transfer] of this.pendingFileTransfers) {
        if (transfer.socket === socket) this.pendingFileTransfers.delete(transferId);
      }
      void this.captures.abortOwner(socket).catch(() => undefined);
      this.publishInstanceBindings(connection.instanceId);
      this.connectionEvents.emit("changed");
    });
  }

  private async acceptNetworkCaptureStart(
    connection: ExtensionConnection,
    frame: BrowserNetworkCaptureStartFrame,
  ): Promise<void> {
    try {
      const binding = this.assertConnectionOwnsThreadTab(connection, frame.threadId, frame.tabId);
      if (frame.provider !== connection.browser) {
        throw new BrowserExtensionError(
          "forbidden",
          "Network capture provider does not match the connected browser",
        );
      }
      await this.captures.startStream(
        {
          captureId: frame.captureId,
          bindingId: binding.bindingId,
          threadId: frame.threadId,
          tabId: frame.tabId,
          exchangeId: frame.exchangeId,
          provider: frame.provider,
          parts: frame.parts,
        },
        connection.socket,
      );
    } catch (error) {
      this.sendProtocolError(connection.socket, "network_capture_rejected", error);
    }
  }

  private async acceptNetworkCaptureChunk(
    connection: ExtensionConnection,
    frame: BrowserNetworkCaptureChunkFrame,
  ): Promise<void> {
    try {
      await this.captures.appendStream(
        frame.captureId,
        connection.socket,
        frame.part,
        frame.offset,
        decodeBase64(frame.data),
      );
    } catch (error) {
      await this.captures.abortStream(frame.captureId, connection.socket).catch(() => undefined);
      this.sendProtocolError(connection.socket, "network_capture_rejected", error);
    }
  }

  private async acceptNetworkCaptureCommit(
    connection: ExtensionConnection,
    frame: BrowserNetworkCaptureCommitFrame,
  ): Promise<void> {
    try {
      await this.captures.commitStream(frame.captureId, connection.socket);
    } catch (error) {
      this.sendProtocolError(connection.socket, "network_capture_rejected", error);
    }
  }

  private async acceptNetworkCaptureAbort(
    connection: ExtensionConnection,
    frame: BrowserNetworkCaptureAbortFrame,
  ): Promise<void> {
    try {
      await this.captures.abortStream(frame.captureId, connection.socket);
    } catch (error) {
      this.sendProtocolError(connection.socket, "network_capture_rejected", error);
    }
  }

  private sendProtocolError(socket: WebSocket, code: string, error: unknown): void {
    this.send(socket, { type: "protocol.error", code, message: safePublicMessage(error) });
  }

  private async handleSessionRequest(
    connection: ExtensionConnection,
    frame: Extract<BrowserExtensionClientFrame, { type: "session.request" }>,
  ): Promise<void> {
    try {
      if (frame.target.kind === "new") {
        throw new BrowserExtensionError(
          "unsupported",
          "Creating browser sessions from the extension is no longer supported",
        );
      }
      const meta = this.thread(frame.target.threadId);
      const existing =
        meta?.browserEnabled === true && meta.browserBinding
          ? structuredClone(meta.browserBinding)
          : undefined;
      const bindingId =
        existing?.instanceId === connection.instanceId ? existing.bindingId : randomUUID();
      const thread = await this.attachThread(
        connection.instanceId,
        frame.target.threadId,
        bindingId,
      );
      if (existing && existing.instanceId !== connection.instanceId) {
        this.detachConnection(frame.target.threadId, existing);
      }
      this.send(connection.socket, {
        type: "session.result",
        requestId: frame.requestId,
        action: "attached",
        thread: browserThreadSummary(thread),
      });
    } catch (error) {
      const browserError =
        error instanceof BrowserExtensionError
          ? error
          : new BrowserExtensionError("failed", safePublicMessage(error));
      this.send(connection.socket, {
        type: "session.error",
        requestId: frame.requestId,
        error: { code: browserError.code, message: browserError.message },
      });
    }
  }

  private acceptBindingUpdated(
    connection: ExtensionConnection,
    binding: BrowserExtensionBindingSummary,
  ): void {
    const meta = this.thread(binding.threadId);
    const stored = meta?.browserBinding;
    if (meta?.browserEnabled !== true || !stored || stored.instanceId !== connection.instanceId) {
      this.send(connection.socket, { type: "binding.detach", threadId: binding.threadId });
      return;
    }
    if (stored.detachedAt !== undefined) {
      this.send(connection.socket, { type: "binding.detach", threadId: binding.threadId });
      return;
    }
    const previous = connection.activeThreadId;
    connection.bindingThreadIds.add(binding.threadId);
    connection.bindingTabIds.set(stored.bindingId, new Set(binding.tabIds.map(String)));
    connection.activeThreadId = binding.threadId;
    if (previous && previous !== binding.threadId) this.publishThreadState(previous);
    this.publishThreadState(binding.threadId);
    this.connectionEvents.emit("changed");
  }

  private async acceptBindingDetached(
    connection: ExtensionConnection,
    binding: BrowserExtensionBindingSummary,
  ): Promise<void> {
    connection.bindingThreadIds.delete(binding.threadId);
    if (connection.activeThreadId === binding.threadId) connection.activeThreadId = null;
    const meta = this.thread(binding.threadId);
    const stored = meta?.browserBinding;
    if (stored) connection.bindingTabIds.delete(stored.bindingId);
    if (meta?.browserEnabled !== true || stored?.instanceId !== connection.instanceId) return;
    await this.detach(connection.instanceId, binding.threadId).catch(() => undefined);
  }

  private catalog(instanceId: string): {
    projects: BrowserExtensionProjectSummary[];
    threads: BrowserExtensionThreadSummary[];
  } {
    const { threads: stored, projects } = this.ui.store.data;
    const threads = Object.entries(stored).flatMap(([id, meta]) => {
      const binding = meta.browserBinding;
      if (
        meta.browserEnabled !== true ||
        meta.subagent ||
        meta.archived ||
        !meta.projectId ||
        (binding && binding.instanceId !== instanceId && binding.detachedAt === undefined)
      ) {
        return [];
      }
      return [browserThreadSummary(this.ui.summary(id))];
    });
    const projectIds = new Set(threads.map((thread) => thread.projectId));
    return {
      projects: projects.flatMap(({ id, displayName, path }) =>
        projectIds.has(id) ? [{ id, displayName, path }] : [],
      ),
      threads,
    };
  }

  private async handleMcp(
    bindingId: string,
    message: unknown,
  ): Promise<Record<string, unknown> | null> {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return jsonRpcError(null, -32600, "Invalid Request");
    }
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    if (typeof message.method !== "string") return jsonRpcError(id, -32600, "Invalid Request");
    if (id === null) return null;
    if (!this.threadForBinding(bindingId)) {
      return jsonRpcError(id, -32_001, "Browser binding not found");
    }
    if (message.method === "initialize") {
      const requestedVersion = isRecord(message.params)
        ? message.params.protocolVersion
        : undefined;
      return jsonRpcResult(id, {
        protocolVersion:
          typeof requestedVersion === "string" ? requestedVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "claudenest-browser", version: "1.0.0" },
      });
    }
    if (message.method === "ping") return jsonRpcResult(id, {});
    if (message.method === "tools/list") return jsonRpcResult(id, { tools: MCP_TOOLS });
    if (message.method !== "tools/call") return jsonRpcError(id, -32601, "Method not found");
    const params = message.params;
    if (!isRecord(params) || !isBrowserTool(params.name) || !isRecord(params.arguments ?? {})) {
      return jsonRpcError(id, -32602, "Invalid tool call");
    }
    try {
      const result = await this.callTool(
        bindingId,
        params.name,
        (params.arguments ?? {}) as Record<string, unknown>,
      );
      return jsonRpcResult(id, normalizeToolResult(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Browser tool failed";
      return jsonRpcResult(id, {
        content: [{ type: "text", text: message }],
        isError: true,
      });
    }
  }

  private async callTool(
    bindingId: string,
    tool: ServerBrowserToolName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const owned = this.threadForBinding(bindingId);
    if (!owned) throw new BrowserExtensionError("not_found", "Browser binding not found");
    const deadline = Date.now() + this.disconnectWaitMs;
    const connection = await this.waitForConnection(owned.threadId, owned.binding, deadline);
    if (tool === "read_network_request" || tool === "read_network_body") {
      if (tool === "read_network_request") {
        if (typeof args.exchangeId !== "string" || !args.exchangeId) {
          throw new BrowserExtensionError(
            "invalid_arguments",
            "read_network_request requires exchangeId",
          );
        }
        return this.captures.get(bindingId, args.exchangeId);
      }
      if (typeof args.bodyId !== "string" || !args.bodyId) {
        throw new BrowserExtensionError("invalid_arguments", "read_network_body requires bodyId");
      }
      return this.captures.readBody(
        bindingId,
        args.bodyId,
        args.offset === undefined
          ? 0
          : requireBoundedInteger(args.offset, 0, Number.MAX_SAFE_INTEGER, "offset"),
        args.length === undefined
          ? MAX_NETWORK_BODY_READ_BYTES
          : requireBoundedInteger(args.length, 1, MAX_NETWORK_BODY_READ_BYTES, "length"),
      );
    }
    if (tool === "read_network_requests") {
      if (args.tabId !== undefined)
        this.assertConnectionOwnsTab(connection, bindingId, requireTabId(args.tabId));
      return this.captures.list(bindingId, {
        ...(args.tabId !== undefined ? { tabId: requireTabId(args.tabId) } : {}),
        ...(args.since !== undefined ? { since: requireFiniteNumber(args.since, "since") } : {}),
        ...(typeof args.search === "string" ? { search: args.search } : {}),
        ...(args.limit !== undefined
          ? { limit: requireBoundedInteger(args.limit, 1, 1_000, "limit") }
          : {}),
      });
    }
    const callId = randomUUID();
    const prepared = await this.prepareToolArguments(
      connection.socket,
      owned.threadId,
      tool as BrowserToolName,
      args,
    );
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTools.delete(callId);
        if (prepared.transferId) this.pendingFileTransfers.delete(prepared.transferId);
        reject(
          new BrowserExtensionError(
            "outcome_unknown",
            "Browser tool did not respond after dispatch; outcome unknown",
          ),
        );
      }, this.toolResponseMs);
      timer.unref();
      this.pendingTools.set(callId, {
        socket: connection.socket,
        resolve,
        reject,
        timer,
        transferId: prepared.transferId,
      });
      this.send(connection.socket, {
        type: "tool.call",
        requestId: callId,
        threadId: owned.threadId,
        tool: tool as BrowserToolName,
        arguments: prepared.arguments,
      });
    });
  }

  private async prepareToolArguments(
    socket: WebSocket,
    threadId: string,
    tool: BrowserToolName,
    args: Record<string, unknown>,
  ): Promise<{ arguments: Record<string, unknown>; transferId?: string }> {
    if (tool !== "upload_file") return { arguments: args };
    if (typeof args.imageId === "string" && args.imageId) {
      return {
        arguments: {
          ...args,
          file: {
            kind: "captured_image",
            imageId: args.imageId,
            ...(typeof args.name === "string" && args.name ? { name: args.name } : {}),
          },
        },
      };
    }
    if (typeof args.path !== "string" || !args.path) {
      throw new BrowserExtensionError(
        "invalid_arguments",
        "upload_file requires either path or imageId",
      );
    }
    const summary = this.requireSummary(threadId);
    const file = await resolveProjectFile(args.path, summary.cwd);
    const transferId = randomUUID();
    this.pendingFileTransfers.set(transferId, {
      socket,
      path: file.path,
      size: file.size,
      device: file.device,
      inode: file.inode,
    });
    const safeArguments = Object.fromEntries(
      Object.entries(args).filter(([key]) => key !== "path"),
    );
    return {
      transferId,
      arguments: {
        ...safeArguments,
        file: {
          kind: "project_file",
          transferId,
          name: file.name,
          mediaType: file.mediaType,
          size: file.size,
        },
      },
    };
  }

  private async waitForConnection(
    threadId: string,
    binding: BrowserBindingState,
    deadline: number,
  ): Promise<ExtensionConnection> {
    for (;;) {
      const meta = this.thread(threadId);
      const currentBinding = meta?.browserBinding;
      if (
        meta?.browserEnabled !== true ||
        !currentBinding ||
        currentBinding.bindingId !== binding.bindingId
      ) {
        throw new BrowserExtensionError("not_found", "Browser binding was removed");
      }
      const connection = this.connections.get(binding.instanceId);
      if (
        connection &&
        currentBinding.detachedAt === undefined &&
        connection.bindingThreadIds.has(threadId) &&
        connection.socket.readyState === 1
      ) {
        return connection;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new BrowserExtensionError("disconnected", "Browser extension is disconnected");
      }
      await new Promise<void>((resolve) => {
        const changed = () => {
          clearTimeout(timer);
          this.connectionEvents.off("changed", changed);
          resolve();
        };
        const timer = setTimeout(changed, remaining);
        timer.unref();
        this.connectionEvents.once("changed", changed);
      });
    }
  }

  private finishToolCall(
    socket: WebSocket,
    callId: string,
    success: boolean,
    result: unknown,
    error?: string,
  ): void {
    const pending = this.pendingTools.get(callId);
    if (!pending || pending.socket !== socket) return;
    this.pendingTools.delete(callId);
    clearTimeout(pending.timer);
    if (pending.transferId) this.pendingFileTransfers.delete(pending.transferId);
    if (success) pending.resolve(result);
    else pending.reject(new BrowserExtensionError("tool_failed", error || "Browser tool failed"));
  }

  private acceptToolResultChunk(
    socket: WebSocket,
    frame: Extract<BrowserExtensionClientFrame, { type: "tool.result.chunk" }>,
  ): void {
    const pending = this.pendingTools.get(frame.requestId);
    if (!pending || pending.socket !== socket) return;
    const chunkBytes = Buffer.byteLength(frame.data);
    if (chunkBytes > BROWSER_TOOL_RESULT_CHUNK_BYTES) {
      this.finishToolCall(socket, frame.requestId, false, undefined, "Invalid tool result chunk");
      return;
    }
    if (pending.resultChunkCount === undefined) {
      pending.resultChunkCount = frame.chunkCount;
      pending.resultChunks = new Array<string | undefined>(frame.chunkCount);
      pending.resultChunksReceived = 0;
      pending.resultBytes = 0;
    }
    if (pending.resultChunkCount !== frame.chunkCount || !pending.resultChunks) {
      this.finishToolCall(
        socket,
        frame.requestId,
        false,
        undefined,
        "Invalid tool result chunk sequence",
      );
      return;
    }
    if (pending.resultChunks[frame.chunkIndex] !== undefined) return;
    pending.resultChunks[frame.chunkIndex] = frame.data;
    pending.resultChunksReceived = (pending.resultChunksReceived ?? 0) + 1;
    pending.resultBytes = (pending.resultBytes ?? 0) + chunkBytes;
    if (pending.resultBytes > BROWSER_MAX_TOOL_RESULT_BYTES) {
      this.finishToolCall(socket, frame.requestId, false, undefined, "Tool result is too large");
      return;
    }
    if (pending.resultChunksReceived !== pending.resultChunkCount) return;
    try {
      this.finishToolCall(
        socket,
        frame.requestId,
        true,
        JSON.parse((pending.resultChunks as string[]).join("")),
      );
    } catch {
      this.finishToolCall(socket, frame.requestId, false, undefined, "Invalid tool result JSON");
    }
  }

  private async sendProjectFile(socket: WebSocket, transferId: string): Promise<void> {
    const transfer = this.pendingFileTransfers.get(transferId);
    if (!transfer || transfer.socket !== socket) return;
    this.pendingFileTransfers.delete(transferId);
    try {
      const chunkBytes = 384 * 1024;
      const chunkCount = Math.max(1, Math.ceil(transfer.size / chunkBytes));
      const handle = await open(transfer.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.size !== transfer.size ||
          info.dev !== transfer.device ||
          info.ino !== transfer.inode
        ) {
          throw new Error("Project file changed before transfer");
        }
        if (transfer.size === 0) {
          this.send(socket, {
            type: "file.transfer",
            transferId,
            chunkIndex: 0,
            chunkCount,
            data: "",
          });
          return;
        }
        let position = 0;
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          const length = Math.min(chunkBytes, transfer.size - position);
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          if (bytesRead !== length) throw new Error("Project file ended during transfer");
          this.send(socket, {
            type: "file.transfer",
            transferId,
            chunkIndex,
            chunkCount,
            data: buffer.toString("base64"),
          });
          position += bytesRead;
          await waitForSocketCapacity(socket);
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.send(socket, {
        type: "file.error",
        transferId,
        error: error instanceof Error ? error.message : "Project file transfer failed",
      });
    }
  }

  private runHeartbeat(): void {
    const now = Date.now();
    for (const connection of this.connections.values()) {
      if (now - connection.lastPongAt > this.heartbeatMs * 2) {
        connection.socket.terminate();
      } else {
        this.send(connection.socket, { type: "server.ping", at: now });
      }
    }
  }

  private assertOwnedBinding(instanceId: string, threadId: string): BrowserBindingState {
    const meta = this.thread(threadId);
    if (meta?.browserEnabled !== true) {
      throw new BrowserExtensionError("not_enabled", "Browser access is not enabled");
    }
    const binding = meta.browserBinding;
    if (!binding) throw new BrowserExtensionError("not_found", "Browser binding not found");
    if (binding.instanceId !== instanceId) {
      throw new BrowserExtensionError(
        "owned_by_another_instance",
        "Browser binding belongs to another extension instance",
      );
    }
    return structuredClone(binding);
  }

  private assertConnectionOwnsTab(
    connection: ExtensionConnection,
    bindingId: string,
    tabId: string | number,
  ): void {
    const owned = this.threadForBinding(bindingId);
    if (
      !owned ||
      owned.binding.instanceId !== connection.instanceId ||
      owned.binding.detachedAt !== undefined ||
      !connection.bindingThreadIds.has(owned.threadId)
    ) {
      throw new BrowserExtensionError(
        "forbidden",
        "Browser binding is not owned by this connection",
      );
    }
    const tabs = connection.bindingTabIds.get(bindingId);
    if (!tabs?.has(String(tabId))) {
      throw new BrowserExtensionError("forbidden", "Browser tab is not owned by this binding");
    }
  }

  private assertConnectionOwnsThreadTab(
    connection: ExtensionConnection,
    threadId: string,
    tabId: number,
  ): BrowserBindingState {
    const binding = this.assertOwnedBinding(connection.instanceId, threadId);
    if (
      binding.detachedAt !== undefined ||
      !connection.bindingThreadIds.has(threadId) ||
      !connection.bindingTabIds.get(binding.bindingId)?.has(String(tabId))
    ) {
      throw new BrowserExtensionError(
        "forbidden",
        "Browser tab is not owned by this connection and binding",
      );
    }
    return binding;
  }

  private threadForBinding(
    bindingId: string,
  ): { threadId: string; binding: BrowserBindingState } | undefined {
    for (const [threadId, meta] of Object.entries(this.ui.store.data.threads)) {
      if (meta.browserEnabled === true && meta.browserBinding?.bindingId === bindingId) {
        return { threadId, binding: structuredClone(meta.browserBinding) };
      }
    }
    return undefined;
  }

  private isBindingConnected(threadId: string, binding: BrowserBindingState): boolean {
    const connection = this.connections.get(binding.instanceId);
    return (
      binding.detachedAt === undefined &&
      connection?.socket.readyState === 1 &&
      connection.bindingThreadIds.has(threadId) &&
      this.thread(threadId)?.browserEnabled === true &&
      this.thread(threadId)?.browserBinding?.bindingId === binding.bindingId
    );
  }

  private publishInstanceBindings(instanceId: string): void {
    for (const [threadId, meta] of Object.entries(this.ui.store.data.threads)) {
      if (meta.browserEnabled === true && meta.browserBinding?.instanceId === instanceId)
        this.publishThreadState(threadId);
    }
  }

  private validInternalSecret(request: FastifyRequest): boolean {
    const candidate = request.headers[INTERNAL_SECRET_HEADER];
    if (typeof candidate !== "string") return false;
    const actual = Buffer.from(candidate);
    const expected = Buffer.from(this.secret);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private send(
    socket: WebSocket | undefined,
    frame: BrowserExtensionServerFrame | Record<string, unknown>,
  ): void {
    if (socket?.readyState === 1) socket.send(JSON.stringify(frame));
  }
}

const MCP_TOOLS = SERVER_BROWSER_TOOL_NAMES.map((name) => ({
  name,
  description: browserToolDescription(name),
  inputSchema: browserToolInputSchema(name),
}));

function browserToolDescription(name: ServerBrowserToolName): string {
  const descriptions: Record<ServerBrowserToolName, string> = {
    tabs_context: "List browser tabs and identify the active tab.",
    tabs_create: "Create a browser tab.",
    tabs_close: "Close one or more browser tabs.",
    navigate: "Navigate a browser tab to a URL or through history.",
    computer: "Interact with the page using mouse and keyboard actions.",
    read_page: "Read the current page accessibility structure.",
    get_page_text: "Get visible text from the current page.",
    find: "Find text in the current page.",
    form_input: "Set a value on a page form control.",
    javascript_tool: "Execute JavaScript in the current page.",
    read_console_messages: "Read browser console messages.",
    read_network_requests:
      "List complete browser network exchanges. Protocol v2 reads the server capture store; v1 Chrome uses the extension fallback.",
    read_network_request:
      "Read one complete server-stored network exchange and its request/response body references.",
    read_network_body:
      "Read a byte range from a server-stored request or response body (at most 512 KiB).",
    resize_window: "Resize the browser window.",
    upload_file: "Upload a workspace file through a page file input.",
  };
  return descriptions[name];
}

function browserToolInputSchema(name: ServerBrowserToolName): Record<string, unknown> {
  const tabId = {
    type: "integer",
    minimum: 0,
    description: "Browser tab ID; defaults to the active tab.",
  };
  const schemas: Record<ServerBrowserToolName, Record<string, unknown>> = {
    tabs_context: objectSchema({}),
    tabs_create: objectSchema({
      url: { type: "string", description: "URL to open; defaults to about:blank." },
      active: { type: "boolean", description: "Whether to activate the new tab." },
      tabId,
    }),
    tabs_close: objectSchema({
      tabId,
      tabIds: { type: "array", items: { type: "integer", minimum: 0 } },
    }),
    navigate: objectSchema({
      tabId,
      action: { type: "string", enum: ["url", "back", "forward", "reload"] },
      url: { type: "string", description: "Required when action is url." },
      bypassCache: { type: "boolean" },
    }),
    computer: objectSchema(
      {
        tabId,
        action: {
          type: "string",
          enum: [
            "screenshot",
            "wait",
            "zoom",
            "scroll_to",
            "type",
            "key",
            "scroll",
            "hover",
            "click",
            "drag",
          ],
        },
        ref: { type: "string", description: "Element ref returned by read_page or find." },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string" },
        key: { type: "string", description: "Key or shortcut such as Enter or Control+L." },
        button: { type: "string", enum: ["left", "middle", "right"] },
        count: { type: "integer", minimum: 1, maximum: 3 },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        amount: { type: "number" },
        milliseconds: { type: "number", minimum: 0, maximum: 30_000 },
        duration: { type: "number", minimum: 0, maximum: 30_000 },
        factor: { type: "number", minimum: 0.25, maximum: 5 },
        fromX: { type: "number" },
        fromY: { type: "number" },
        toX: { type: "number" },
        toY: { type: "number" },
      },
      ["action"],
    ),
    read_page: objectSchema({ tabId, maxChars: boundedIntegerSchema(1_000, 100_000) }),
    get_page_text: objectSchema({ tabId, maxChars: boundedIntegerSchema(1_000, 500_000) }),
    find: objectSchema(
      {
        tabId,
        query: { type: "string" },
        selector: { type: "string", description: "Optional CSS selector." },
        maxResults: boundedIntegerSchema(1, 200),
      },
      ["query"],
    ),
    form_input: objectSchema(
      {
        tabId,
        ref: { type: "string" },
        value: {},
      },
      ["ref", "value"],
    ),
    javascript_tool: objectSchema(
      {
        tabId,
        code: { type: "string", description: "JavaScript expression evaluated in the page." },
      },
      ["code"],
    ),
    read_console_messages: objectSchema({
      tabId,
      since: { type: "number", description: "Unix timestamp in milliseconds." },
      level: { type: "string" },
      search: { type: "string" },
      limit: boundedIntegerSchema(1, 1_000),
    }),
    read_network_requests: objectSchema({
      tabId,
      since: { type: "number", description: "Unix timestamp in milliseconds." },
      search: { type: "string" },
      limit: boundedIntegerSchema(1, 1_000),
    }),
    read_network_request: objectSchema(
      {
        exchangeId: {
          type: "string",
          description: "Exchange ID returned by read_network_requests.",
        },
      },
      ["exchangeId"],
    ),
    read_network_body: objectSchema(
      {
        bodyId: { type: "string", description: "Body ID returned by read_network_request." },
        offset: { type: "integer", minimum: 0, description: "Zero-based byte offset." },
        length: {
          type: "integer",
          minimum: 1,
          maximum: MAX_NETWORK_BODY_READ_BYTES,
          description: "Number of bytes to read; defaults to 512 KiB.",
        },
      },
      ["bodyId"],
    ),
    resize_window: objectSchema({
      tabId,
      width: boundedIntegerSchema(320, 10_000),
      height: boundedIntegerSchema(240, 10_000),
    }),
    upload_file: {
      ...objectSchema(
        {
          tabId,
          ref: { type: "string", description: "File input or drop-target element ref." },
          path: {
            type: "string",
            description: "Absolute or thread-relative project file path, at most 100 MB.",
          },
          imageId: { type: "string", description: "Captured screenshot imageId." },
          name: { type: "string", description: "Optional filename for a captured image." },
          drop: { type: "boolean", description: "Use drag-and-drop instead of a file input." },
        },
        ["ref"],
      ),
      anyOf: [{ required: ["path"] }, { required: ["imageId"] }],
    },
  };
  return schemas[name];
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function boundedIntegerSchema(minimum: number, maximum: number): Record<string, unknown> {
  return { type: "integer", minimum, maximum };
}

function normalizeToolResult(value: unknown): Record<string, unknown> {
  if (isRecord(value) && Array.isArray(value.content)) return value;
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value ?? null) },
    ],
  };
}

function jsonRpcResult(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isBrowserTool(value: unknown): value is ServerBrowserToolName {
  return (
    typeof value === "string" && (SERVER_BROWSER_TOOL_NAMES as readonly string[]).includes(value)
  );
}

function isBrowserCatalogEvent(event: ServerEvent): boolean {
  return (
    event.type === "project.upserted" ||
    event.type === "projects.reordered" ||
    event.type === "project.removed" ||
    event.type === "thread.upserted" ||
    event.type === "thread.removed" ||
    event.type === "resync.required"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Buffer {
  if (!isValidBase64(value)) throw new Error("Invalid base64 capture chunk");
  return Buffer.from(value, "base64");
}

function isValidBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(value)
  );
}

function requireBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new BrowserExtensionError(
      "invalid_arguments",
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return Number(value);
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BrowserExtensionError("invalid_arguments", `${name} must be a finite number`);
  }
  return value;
}

function requireTabId(value: unknown): string | number {
  if (!validTabId(value)) {
    throw new BrowserExtensionError("invalid_arguments", "tabId must be a browser tab ID");
  }
  return value;
}

function validTabId(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 1_024) ||
    (Number.isSafeInteger(value) && Number(value) >= 0)
  );
}

function equalToken(value: unknown, token: string): boolean {
  if (typeof value !== "string") return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isAllowedRequestOrigin(request: FastifyRequest, allowedOrigins: Set<string>): boolean {
  const origin = request.headers.origin;
  if (!origin || allowedOrigins.has(origin)) return true;
  const host = request.headers.host?.trim().toLowerCase();
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.host.toLowerCase() === host
    );
  } catch {
    return false;
  }
}

function isLoopbackAddress(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value.startsWith("::ffff:127.");
}

function safePublicMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Browser request failed";
}

function browserThreadSummary(thread: ThreadSummary): BrowserExtensionThreadSummary {
  if (!thread.projectId) {
    throw new BrowserExtensionError("not_writable", "Thread is not in a ClaudeNest project");
  }
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    state: thread.state,
  };
}

async function resolveProjectFile(
  input: string,
  cwd: string,
): Promise<{
  path: string;
  name: string;
  mediaType: string;
  size: number;
  device: number;
  inode: number;
}> {
  if (!input || input.includes("\0") || input.length > 4_096) {
    throw new BrowserExtensionError("invalid_arguments", "Invalid project file path");
  }
  let root: string;
  let path: string;
  try {
    root = await realpath(cwd);
    path = await realpath(isAbsolute(input) ? input : resolve(root, input));
  } catch {
    throw new BrowserExtensionError("not_found", "Project file does not exist");
  }
  const relativePath = relative(root, path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${pathSeparator}`)
  ) {
    throw new BrowserExtensionError(
      "forbidden",
      "Project file must stay inside the thread directory",
    );
  }
  let info;
  try {
    [info] = await Promise.all([stat(path), access(path, constants.R_OK)]);
  } catch {
    throw new BrowserExtensionError("forbidden", "Project file is not accessible");
  }
  if (!info.isFile()) {
    throw new BrowserExtensionError("invalid_arguments", "Project path must point to a file");
  }
  if (info.size > BROWSER_MAX_PROJECT_FILE_BYTES) {
    throw new BrowserExtensionError("file_too_large", "Project file must be 100 MB or smaller");
  }
  return {
    path,
    name: basename(path),
    mediaType: mediaTypeForPath(path),
    size: info.size,
    device: info.dev,
    inode: info.ino,
  };
}

const pathSeparator = process.platform === "win32" ? "\\" : "/";

function mediaTypeForPath(path: string): string {
  const types: Record<string, string> = {
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".webp": "image/webp",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function waitForSocketCapacity(socket: WebSocket): Promise<void> {
  while (socket.readyState === 1 && socket.bufferedAmount > 4 * 1024 * 1024) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (socket.readyState !== 1) throw new Error("Browser connection closed during file transfer");
}
