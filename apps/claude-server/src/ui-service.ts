import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import {
  pastedText,
  serializePastedMessage,
  trimPastedMessage,
  validPastedText,
} from "@codexnest/protocol";
import type {
  AppSnapshot,
  AttentionRequest,
  CodexRateLimitsResponse,
  CodexRateLimitsState,
  AttentionResponse,
  GlobalPermissionSettings,
  ModelOption,
  Project,
  QueuedMessage,
  QueueMessageRequest,
  ServerEvent,
  ServerFrame,
  SessionSettings,
  ThreadDetail,
  ThreadDraft,
  ThreadFileAttachment,
  ThreadSummary,
  UpdateThreadDraftRequest,
  UpdateUserInputDraftRequest,
} from "@codexnest/protocol";
import { AttachmentStore } from "./attachments";
import { ClaudeProcess } from "./claude";
import { readHistory } from "./history";
import type { SessionManager } from "./manager";
import { NativeView } from "./native-view";
import { parseClaudeUsage } from "./rate-limits";
import type { RunnerConnection } from "./rpc";
import { UiStore, type UiThread } from "./ui-store";
import { writeJsonAtomic } from "./io";
import {
  AppError,
  assertUuid,
  record,
  type CommandReceipt,
  type PendingRequest,
  type RpcMessage,
  type RunnerEvent,
  type RunnerSnapshot,
  type ClaudePermissionMode,
} from "./types";

const RATE_LIMITS_POLL_MS = 300_000;
const MAX_PLAN_TEXTS = 20;
const PLAN_REVIEW_MESSAGE =
  "ClaudeNest is showing this plan to the user for review. End your turn now without further " +
  "tool calls or a summary of the plan. The user will either approve it or reply with changes.";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function commandId(value: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    return value.toLowerCase();
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function emptyDraft(): ThreadDraft {
  return { input: "", images: [], goalMode: false, annotations: [], updatedAt: Date.now() };
}
export function validateDraft(value: UpdateThreadDraftRequest): void {
  if (
    typeof value.input !== "string" ||
    !Array.isArray(value.images) ||
    !Array.isArray(value.annotations) ||
    !validPastedText(value, value.input) ||
    (value.files !== undefined && !Array.isArray(value.files)) ||
    value.images.some(
      (image) =>
        !image ||
        typeof image.id !== "string" ||
        typeof image.name !== "string" ||
        typeof image.url !== "string",
    )
  )
    throw new AppError("invalid_request", "Invalid draft");
}
function blankThread(
  id: string,
  cwd: string,
  projectId: string | null,
  title = "Новая сессия",
  updatedAt = Date.now(),
): UiThread {
  return {
    id,
    cwd,
    projectId,
    title,
    createdAt: updatedAt,
    updatedAt,
    readAt: updatedAt,
    viewedAt: updatedAt,
    pinned: false,
    archived: false,
    settings: { collaborationMode: "default" },
    draft: null,
    queue: [],
    deliveries: {},
  };
}

/** Adapts independent Claude owners to the existing Nest UI contract. */
export class UiService extends EventEmitter {
  readonly store: UiStore;
  readonly attachments: AttachmentStore;
  readonly instanceId = randomUUID();
  sequence = 0;
  private views = new Map<string, NativeView>();
  private owners = new Map<string, RunnerSnapshot>();
  private subscriptions = new Map<string, RunnerConnection>();
  private attaching = new Map<string, Promise<void>>();
  private dispatches = new Map<string, Promise<void>>();
  private permissionUpdates = new Map<string, Promise<void>>();
  private approving = new Set<string>();
  /** Bumped whenever the effective permission mode of any session may change. */
  private permissionEpoch = 0;
  private creations = new Map<
    string,
    { fingerprint: string; promise: Promise<{ thread: ThreadSummary; draft: ThreadDraft | null }> }
  >();
  private closed = false;
  private reconnect?: NodeJS.Timeout;
  private rateLimits: CodexRateLimitsState = {
    limits: null,
    updatedAt: null,
    refreshing: false,
    refreshError: false,
  };
  private rateLimitsRequest?: Promise<CodexRateLimitsResponse>;
  private rateLimitsTimer?: NodeJS.Timeout;
  constructor(readonly manager: SessionManager) {
    super();
    this.store = new UiStore(manager.config.stateDir);
    this.attachments = new AttachmentStore(join(manager.config.stateDir, "attachments"));
  }
  async initialize(
    options: { probeModels?: boolean; pollRateLimits?: boolean } = {},
  ): Promise<void> {
    await this.store.initialize();
    const sessions = (await this.manager.list()) as Array<Record<string, unknown>>;
    await this.store.update((data) => {
      for (const session of sessions) {
        const id = String(session.sessionId),
          cwd = String(session.cwd ?? "");
        if (!cwd || data.threads[id]) continue;
        const project = data.projects.find((item) => item.path === cwd);
        data.threads[id] = blankThread(
          id,
          cwd,
          project?.id ?? null,
          String(session.title ?? `Claude ${id.slice(0, 8)}`),
          Number(session.updatedAt) || Date.now(),
        );
        data.threads[id]!.readAt = 0;
        data.threads[id]!.viewedAt = 0;
        data.threads[id]!.nativeHistory = typeof session.title === "string";
      }
    });
    for (const session of sessions)
      if (session.managed && session.state !== "unavailable")
        await this.attach(String(session.sessionId)).catch(() => undefined);
    if (options.probeModels !== false && !this.store.data.models.length)
      await this.probeModels().catch(() => undefined);
    if (options.pollRateLimits ?? options.probeModels !== false) {
      this.rateLimitsTimer = setInterval(() => this.pollRateLimits(), RATE_LIMITS_POLL_MS);
      this.rateLimitsTimer.unref();
      this.pollRateLimits();
    }
    this.reconnect = setInterval(() => {
      for (const thread of Object.values(this.store.data.threads)) {
        if (!this.subscriptions.has(thread.id))
          void this.manager
            .descriptor(thread.id)
            .then((descriptor) => (descriptor ? this.attach(thread.id) : undefined))
            .catch(() => undefined);
        if (thread.queue.length) this.schedule(thread.id);
      }
    }, 5_000);
    this.reconnect.unref();
    for (const thread of Object.values(this.store.data.threads))
      if (thread.queue.length) this.schedule(thread.id);
  }
  /** Runs a short-lived CLI that never receives a prompt or persists a session. */
  private async withProbe<T>(use: (process: ClaudeProcess) => Promise<T>): Promise<T> {
    const cwd = join(this.manager.config.stateDir, "model-probe");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const process = new ClaudeProcess({
      claudeBin: this.manager.config.claudeBin,
      cwd,
      sessionId: randomUUID(),
      resume: false,
      noSessionPersistence: true,
      env: { CLAUDE_CONFIG_DIR: this.manager.config.configDir },
    });
    process.on("error", () => undefined);
    try {
      await process.start();
      return await use(process);
    } finally {
      await process.stop();
    }
  }
  async probeModels(): Promise<void> {
    await this.withProbe(async (process) => {
      if (process.supportedModels.length)
        await this.store.update((data) => {
          data.models = process.supportedModels;
        });
    });
  }
  async readRateLimits(): Promise<CodexRateLimitsResponse> {
    return parseClaudeUsage(await this.withProbe((process) => process.readUsage()));
  }
  private setRateLimits(state: CodexRateLimitsState): void {
    this.rateLimits = state;
    this.publish({ type: "codexRateLimits.changed", codexRateLimits: state });
  }
  refreshRateLimits(): Promise<CodexRateLimitsResponse> {
    if (this.rateLimitsRequest) return this.rateLimitsRequest;
    if (this.closed) return Promise.reject(new AppError("unavailable", "Service is closing", 503));
    this.setRateLimits({ ...this.rateLimits, refreshing: true, refreshError: false });
    this.rateLimitsRequest = this.readRateLimits()
      .then((limits) => {
        this.setRateLimits({
          limits,
          updatedAt: Date.now(),
          refreshing: false,
          refreshError: false,
        });
        return limits;
      })
      .catch((error: unknown) => {
        this.setRateLimits({ ...this.rateLimits, refreshing: false, refreshError: true });
        throw error;
      })
      .finally(() => {
        this.rateLimitsRequest = undefined;
      });
    return this.rateLimitsRequest;
  }
  private pollRateLimits(): void {
    if (!this.closed) void this.refreshRateLimits().catch(() => undefined);
  }
  publish(event: ServerEvent): void {
    if (this.closed) return;
    const sequence = ++this.sequence;
    this.emit("frame", {
      type: "event",
      sequence,
      version: { instanceId: this.instanceId, sequence },
      event,
    } satisfies ServerFrame);
  }
  get threadIds(): string[] {
    return Object.keys(this.store.data.threads);
  }
  thread(id: string): UiThread {
    assertUuid(id);
    const thread = this.store.data.threads[id.toLowerCase()];
    if (!thread) throw new AppError("not_found", "Session not found", 404);
    return thread;
  }
  project(id: string): Project {
    const project = this.store.data.projects.find((item) => item.id === id);
    if (!project) throw new AppError("not_found", "Project not found", 404);
    return project;
  }
  modelOptions(): ModelOption[] {
    return this.store.data.models.map((model) => ({
      id: model.value,
      displayName: model.displayName,
      description: model.description,
      isDefault: model.value === "default",
      reasoningEfforts: (model.supportedEffortLevels ?? []).map((value) => ({
        value,
        description: null,
        isDefault: value === "high",
      })),
      serviceTiers: [],
      supportsPersonality: false,
    }));
  }
  summary(id: string): ThreadSummary {
    const thread = this.thread(id),
      owner = this.owners.get(id),
      view = this.views.get(id);
    const last = view?.turns().at(-1);
    const state = owner?.pendingRequests.length
      ? "needsAttention"
      : owner?.state === "running" || owner?.state === "starting"
        ? "running"
        : thread.queue.length
          ? "queued"
          : owner?.state === "failed"
            ? "failed"
            : owner?.state === "interrupted"
              ? "interrupted"
              : last?.status === "failed"
                ? "failed"
                : last?.status === "interrupted"
                  ? "interrupted"
                  : last
                    ? "completed"
                    : "idle";
    return {
      id,
      projectId: thread.projectId,
      title: thread.title,
      preview: thread.queue.at(-1)?.text ?? "",
      cwd: thread.cwd,
      state,
      unread: thread.updatedAt > thread.readAt,
      unseen: thread.updatedAt > thread.viewedAt,
      pinned: thread.pinned,
      archived: thread.archived,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      currentTurnId: view?.currentTurnId ?? null,
      queuedMessageCount: thread.queue.filter((message) => message.deliveryMode !== "steer").length,
      browserStatus: "disabled",
      settings: thread.settings,
      ...(thread.awaitingPlanResponse ? { awaitingPlanResponse: true } : {}),
      ...(thread.dismissedPlanTurnId ? { dismissedPlanTurnId: thread.dismissedPlanTurnId } : {}),
      permissionPreset:
        this.store.data.permissionMode === "bypassPermissions" ||
        owner?.permissionMode === "bypassPermissions"
          ? "full-access"
          : (owner?.permissionMode ?? this.store.data.permissionMode) === "acceptEdits"
            ? "auto"
            : "ask",
      relation: { kind: "session", sessionId: id },
      canAcceptDirectInput: true,
      codexSettings: {
        model: owner?.model ?? view?.model ?? thread.settings.model ?? null,
        reasoningEffort: thread.settings.reasoningEffort ?? null,
      },
    };
  }
  snapshot(): AppSnapshot {
    return {
      provider: "claude",
      capabilities: {
        codexManagement: false,
        rateLimits: true,
        plan: true,
        team: false,
        goal: false,
        forks: false,
        browserIntegration: false,
        fullTextSearch: false,
        sessionApprovalGrants: false,
        skills: false,
        gitChanges: false,
        artifacts: false,
        appUpdates: true,
        reasoningEffort: true,
      },
      instanceId: this.instanceId,
      sequence: this.sequence,
      uiLanguage: this.store.data.uiLanguage,
      connection: { state: "ready", message: null, syncedAt: new Date().toISOString() },
      codexRateLimits: this.rateLimits,
      projects: this.store.data.projects,
      threads: this.threadIds.map((id) => this.summary(id)),
      attention: this.attention(),
      models: this.modelOptions(),
      taskDefaults: this.store.data.taskDefaults,
      permissionSettings: this.permissionSettings(),
      forkOperations: [],
      voiceTranscriptions: Object.values(this.store.data.voice)
        .filter((value) => !value.cancelled && !value.applied)
        .map((value) => value.job),
    };
  }
  permissionSettings(): GlobalPermissionSettings {
    return {
      preset:
        this.store.data.permissionMode === "bypassPermissions"
          ? "full-access"
          : this.store.data.permissionMode === "acceptEdits"
            ? "auto"
            : "ask",
      version: String(this.store.data.permissionVersion),
      overridden: false,
      message: null,
    };
  }
  async setPermissions(mode: ClaudePermissionMode, expectedVersion?: unknown): Promise<void> {
    await this.store.update((data) => {
      if (expectedVersion !== undefined && expectedVersion !== String(data.permissionVersion))
        throw new AppError("conflict", "Permission settings changed", 409);
      data.permissionMode = mode;
      data.permissionVersion++;
    });
    this.permissionEpoch++;
    this.publish({ type: "permissions.changed", permissionSettings: this.permissionSettings() });
    await Promise.all([...this.owners.keys()].map((id) => this.applyPermissions(id)));
  }
  private applyPermissions(id: string): Promise<void> {
    const existing = this.permissionUpdates.get(id);
    if (existing) return existing;
    const task = (async () => {
      let epoch: number;
      do {
        epoch = this.permissionEpoch;
        await this.applyPermissionsOnce(id);
      } while (!this.closed && epoch !== this.permissionEpoch);
    })().finally(() => this.permissionUpdates.delete(id));
    this.permissionUpdates.set(id, task);
    return task;
  }
  private async applyPermissionsOnce(id: string): Promise<void> {
    const owner = this.owners.get(id);
    if (!owner) return;
    const mode = this.permissionMode(id);
    if (
      owner.capabilities?.livePermissionMode &&
      owner.permissionMode !== mode &&
      !["starting", "failed", "closed"].includes(owner.state)
    ) {
      try {
        await this.manager.command(id, "setPermissionMode", {
          requestId: randomUUID(),
          permissionMode: mode,
        });
        owner.permissionMode = mode;
      } catch {
        // Legacy CLI owners finish their work without being replaced or interrupted.
      }
    }
    for (const request of [...owner.pendingRequests])
      if (!(await this.presentPlan(id, request))) await this.autoApprove(id, request);
    this.publish({ type: "thread.upserted", thread: this.summary(id) });
  }
  /** Plan mode follows the session; every other session uses the global permission mode. */
  private permissionMode(id: string): ClaudePermissionMode {
    return this.store.data.threads[id]?.settings.collaborationMode === "plan"
      ? "plan"
      : this.store.data.permissionMode;
  }
  /**
   * ExitPlanMode would approve the plan inside Claude's turn. Like Codex, the plan instead
   * ends the turn and waits for the user to implement it or reply with revisions.
   */
  private async presentPlan(id: string, request: PendingRequest): Promise<boolean> {
    if (request.toolName !== "ExitPlanMode") return false;
    const key = `${id}:${request.requestId}`;
    if (this.approving.has(key)) return true;
    this.approving.add(key);
    try {
      await this.manager.command(id, "respond", {
        requestId: commandId(`plan:${key}`),
        targetRequestId: request.requestId,
        response: { behavior: "deny", message: PLAN_REVIEW_MESSAGE },
      });
      const owner = this.owners.get(id);
      if (owner)
        owner.pendingRequests = owner.pendingRequests.filter(
          (item) => item.requestId !== request.requestId,
        );
      const text = typeof request.input.plan === "string" ? request.input.plan : "",
        presented = text ? this.views.get(id)?.presentPlan(request.toolUseId, text) : undefined;
      await this.store.update((data) => {
        const thread = data.threads[id];
        if (!thread) return;
        thread.awaitingPlanResponse = true;
        delete thread.dismissedPlanTurnId;
        if (presented)
          thread.planTexts = Object.fromEntries(
            [
              ...Object.entries(thread.planTexts ?? {}).filter(
                ([toolUseId]) => toolUseId !== presented.toolUseId,
              ),
              [presented.toolUseId, text] as const,
            ].slice(-MAX_PLAN_TEXTS),
          );
      });
      for (const event of presented?.events ?? []) this.publish(event);
      this.publish({ type: "attention.removed", attentionId: key });
      return true;
    } catch {
      // Keep the native request visible so the user can still answer it.
      return !this.owners
        .get(id)
        ?.pendingRequests.some((item) => item.requestId === request.requestId);
    } finally {
      this.approving.delete(key);
    }
  }
  async dismissPlan(id: string, turnId: string): Promise<ThreadSummary> {
    this.thread(id);
    await this.store.update((data) => {
      const thread = data.threads[id]!;
      if (!thread.awaitingPlanResponse)
        throw new AppError("conflict", "The plan no longer awaits a response", 409);
      thread.awaitingPlanResponse = false;
      thread.dismissedPlanTurnId = turnId;
      thread.settings = { ...thread.settings, collaborationMode: "default" };
    });
    this.permissionEpoch++;
    await this.applyPermissions(id);
    this.publish({ type: "thread.upserted", thread: this.summary(id) });
    return this.summary(id);
  }
  private async autoApprove(id: string, request: PendingRequest): Promise<boolean> {
    if (
      this.store.data.permissionMode !== "bypassPermissions" ||
      request.toolName === "AskUserQuestion" ||
      (request.kind !== "toolApproval" &&
        !(request.kind === undefined && /^(?:[A-Z]|mcp__)/.test(request.toolName)))
    )
      return false;
    const key = `${id}:${request.requestId}`;
    if (this.approving.has(key)) return true;
    this.approving.add(key);
    try {
      await this.manager.command(id, "respond", {
        requestId: commandId(`full-access:${key}`),
        targetRequestId: request.requestId,
        response: { behavior: "allow", updatedInput: request.input },
      });
      const owner = this.owners.get(id);
      if (owner)
        owner.pendingRequests = owner.pendingRequests.filter(
          (item) => item.requestId !== request.requestId,
        );
      this.publish({ type: "attention.removed", attentionId: key });
      return true;
    } catch {
      // Cancellation can race a grant; keep unresolved requests visible for recovery.
      return !this.owners
        .get(id)
        ?.pendingRequests.some((item) => item.requestId === request.requestId);
    } finally {
      this.approving.delete(key);
    }
  }
  private async view(id: string): Promise<NativeView> {
    const saved = this.views.get(id);
    if (saved) return saved;
    const thread = this.thread(id),
      view = new NativeView(id, thread.cwd);
    for (const [toolUseId, text] of Object.entries(thread.planTexts ?? {}))
      view.rememberPlanText(toolUseId, text);
    const history = await readHistory(this.manager.config.configDir, id).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    view.reset(history?.messages ?? []);
    this.views.set(id, view);
    return view;
  }
  async detail(id: string): Promise<ThreadDetail> {
    const view = await this.view(id);
    return {
      version: { instanceId: this.instanceId, sequence: this.sequence },
      summary: this.summary(id),
      turns: view.turns(),
      queuedMessages: this.thread(id).queue,
      olderTurnsCursor: null,
      draft: this.thread(id).draft,
    };
  }
  async hasToolImagePath(id: string, path: string): Promise<boolean> {
    return (await this.view(id)).hasToolImagePath(path);
  }
  async refresh(id: string): Promise<ThreadDetail> {
    if (!this.subscriptions.has(id)) {
      this.views.delete(id);
      await this.view(id);
      await this.attach(id).catch(() => undefined);
    }
    return this.detail(id);
  }
  attach(id: string): Promise<void> {
    if (this.closed || this.subscriptions.has(id)) return Promise.resolve();
    const current = this.attaching.get(id);
    if (current) return current;
    const task = this.attachOnce(id).finally(() => this.attaching.delete(id));
    this.attaching.set(id, task);
    return task;
  }
  private async attachOnce(id: string): Promise<void> {
    const view = await this.view(id),
      connection = await this.manager.subscribe(id);
    if (this.closed) {
      connection.close();
      return;
    }
    this.subscriptions.set(id, connection);
    let incoming = Promise.resolve();
    connection.on("message", (message: RpcMessage) => {
      incoming = incoming
        .then(async () => {
          if ("snapshot" in message) {
            const owner = message.snapshot;
            this.owners.set(id, owner);
            await this.applyPermissions(id);
            const history = await readHistory(this.manager.config.configDir, id).catch(() => null);
            view.reset([...(history?.messages ?? []), ...owner.currentEvents], {
              live: ["running", "waiting"].includes(owner.state),
              preserveInputs: true,
            });
            if (owner.supportedModels?.length)
              await this.store.update((data) => {
                data.models = owner.supportedModels!;
              });
            this.publish({ type: "models.changed", models: this.modelOptions() });
            for (const turn of view.turns())
              this.publish({ type: "turn.replaced", threadId: id, turn });
            for (const attention of this.attention().filter((item) => item.threadId === id))
              this.publish({ type: "attention.upserted", attention });
            this.publish({ type: "thread.upserted", thread: this.summary(id) });
            this.schedule(id);
          } else if ("event" in message) await this.ingest(id, view, message.event);
        })
        .catch(() => this.publish({ type: "resync.required" }));
    });
    connection.once("close", () => {
      if (this.subscriptions.get(id) === connection) this.subscriptions.delete(id);
      this.owners.delete(id);
      if (!this.closed) this.publish({ type: "thread.upserted", thread: this.summary(id) });
    });
    await connection.request("subscribe", {});
    await incoming;
  }
  private async ingest(id: string, view: NativeView, event: RunnerEvent): Promise<void> {
    const owner = this.owners.get(id);
    if (!owner) return;
    owner.sequence = event.sequence;
    if (event.kind === "native") {
      let native = record(event.data);
      // Older live owners omit timestamps. Stamp only newly received events,
      // never historical/currentEvents replay during subscription recovery.
      if (
        !(typeof native.timestamp === "number" && Number.isFinite(native.timestamp)) &&
        !(typeof native.timestamp === "string" && Number.isFinite(Date.parse(native.timestamp)))
      )
        native = { ...native, timestamp: Date.now() };
      for (const update of view.apply(native)) this.publish(update);
      if (native.type === "result") {
        if (owner.state === "interrupted") owner.awaitingResult = false;
        await this.touch(id);
        this.publish({ type: "thread.upserted", thread: this.summary(id) });
        this.schedule(id);
      }
    } else if (event.kind === "state") {
      const data = record(event.data);
      owner.state = data.state as RunnerSnapshot["state"];
      if (typeof data.awaitingResult === "boolean") owner.awaitingResult = data.awaitingResult;
      this.publish({ type: "thread.upserted", thread: this.summary(id) });
      this.schedule(id);
    } else if (event.kind === "request") {
      const request = event.data as PendingRequest;
      owner.pendingRequests = [
        ...owner.pendingRequests.filter((item) => item.requestId !== request.requestId),
        request,
      ];
      if (!(await this.presentPlan(id, request)) && !(await this.autoApprove(id, request))) {
        const attention = this.toAttention(id, request);
        this.publish({ type: "attention.upserted", attention });
      }
      this.publish({ type: "thread.upserted", thread: this.summary(id) });
    } else if (event.kind === "request.cancelled") {
      const requestId = String(record(event.data).requestId);
      owner.pendingRequests = owner.pendingRequests.filter((item) => item.requestId !== requestId);
      this.publish({ type: "attention.removed", attentionId: `${id}:${requestId}` });
    } else if (event.kind === "command") {
      const receipt = event.data as CommandReceipt;
      owner.commands = [
        ...owner.commands.filter((item) => item.requestId !== receipt.requestId),
        receipt,
      ];
      const pending = this.thread(id).queue.find((message) => message.id === receipt.requestId);
      if (pending?.deliveryMode === "steer") {
        if (receipt.status === "completed") await this.accepted(id, pending.id);
        else if (receipt.status === "unknown")
          await this.deliveryError(
            id,
            pending.id,
            "Claude receipt has an unknown outcome; automatic resend is disabled",
            false,
          );
      }
      this.schedule(id);
    }
  }
  private async touch(id: string): Promise<void> {
    await this.store.update((data) => {
      const thread = data.threads[id]!;
      thread.updatedAt = Math.max(Date.now(), thread.updatedAt + 1);
    });
  }
  async createProject(path: string): Promise<Project> {
    const cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory())
      throw new AppError("invalid_request", "Project must be a directory");
    const project = await this.store.update((data) => {
      const saved = data.projects.find((item) => item.path === cwd);
      if (saved) return saved;
      const project: Project = {
        id: randomUUID(),
        displayName: basename(cwd) || cwd,
        path: cwd,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data.projects.push(project);
      for (const thread of Object.values(data.threads))
        if (thread.cwd === cwd) thread.projectId = project.id;
      return project;
    });
    this.publish({ type: "project.upserted", project });
    for (const thread of Object.values(this.store.data.threads))
      if (thread.projectId === project.id)
        this.publish({ type: "thread.upserted", thread: this.summary(thread.id) });
    return project;
  }
  async createThread(
    projectId: string,
    clientCreationId: string,
    draft?: UpdateThreadDraftRequest,
  ): Promise<{ thread: ThreadSummary; draft: ThreadDraft | null }> {
    assertUuid(clientCreationId, "clientCreationId");
    const fingerprint = hash({ projectId, draft: draft ?? null });
    const previous = this.creations.get(clientCreationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError("conflict", "Creation ID was reused with different input", 409);
      return previous.promise;
    }
    const promise = this.createThreadOnce(projectId, clientCreationId, fingerprint, draft).finally(
      () => this.creations.delete(clientCreationId),
    );
    this.creations.set(clientCreationId, { fingerprint, promise });
    return promise;
  }
  private async createThreadOnce(
    projectId: string,
    clientCreationId: string,
    fingerprint: string,
    draft?: UpdateThreadDraftRequest,
  ): Promise<{ thread: ThreadSummary; draft: ThreadDraft | null }> {
    const project = this.project(projectId),
      prior = this.store.data.creations[clientCreationId];
    if (prior) {
      if (prior.projectId !== projectId || (prior.fingerprint && prior.fingerprint !== fingerprint))
        throw new AppError("conflict", "Creation ID was reused with different input", 409);
      return { thread: this.summary(prior.threadId), draft: this.thread(prior.threadId).draft };
    }
    if (draft) validateDraft(draft);
    const id = randomUUID(),
      refs: ThreadFileAttachment[] = [];
    try {
      if (draft?.files?.length) {
        await this.attachments.validate(projectId, draft.files);
        const { createReadStream } = await import("node:fs");
        for (const ref of draft.files)
          refs.push(
            await this.attachments.save(
              id,
              ref.name,
              ref.mediaType,
              createReadStream(ref.path),
              ref.size,
            ),
          );
      }
      await this.store.update((data) => {
        if (!data.projects.some((item) => item.id === projectId))
          throw new AppError("conflict", "Project was removed during session creation", 409);
        const thread = blankThread(id, project.path, projectId);
        thread.settings = {
          collaborationMode: "default",
          ...(data.taskDefaults.model ? { model: data.taskDefaults.model } : {}),
        };
        if (draft)
          thread.draft = {
            ...draft,
            ...(refs.length ? { files: refs } : {}),
            updatedAt: Date.now(),
            goalMode: false,
          };
        data.threads[id] = thread;
        data.creations[clientCreationId] = { projectId, threadId: id, fingerprint };
      });
    } catch (error) {
      await this.attachments.removeThread(id).catch(() => undefined);
      throw error;
    }
    this.publish({ type: "thread.upserted", thread: this.summary(id) });
    return { thread: this.summary(id), draft: this.thread(id).draft };
  }
  async setDraft(
    id: string,
    value: UpdateThreadDraftRequest,
    expected?: string,
  ): Promise<ThreadDraft> {
    this.thread(id);
    validateDraft(value);
    if (value.files?.length) await this.attachments.validate(id, value.files);
    return this.store.update((data) => {
      const thread = data.threads[id]!,
        current = thread.draft?.updatedAt ?? null;
      if (expected !== undefined && (expected === "none" ? null : Number(expected)) !== current)
        throw new AppError("conflict", "Draft changed on another device", 409);
      thread.draft = {
        ...value,
        goalMode: false,
        updatedAt: Math.max(Date.now(), (current ?? 0) + 1),
      };
      return thread.draft;
    });
  }
  async enqueue(id: string, body: QueueMessageRequest): Promise<QueuedMessage> {
    const thread = this.thread(id),
      text = typeof body.input === "string" ? body.input : "";
    if (!validPastedText(body, text))
      throw new AppError("invalid_request", "Invalid pasted text metadata");
    if (!text.trim() && !body.pasteBlocks?.length && !body.images?.length && !body.files?.length)
      throw new AppError("invalid_request", "Message is empty");
    if (body.replyToUserInput || body.goal)
      throw new AppError("invalid_request", "Use the Claude attention response for questions");
    if (body.planImplementationMode !== undefined && body.planImplementationMode !== "default")
      throw new AppError("invalid_request", "Claude implements plans in the standard mode");
    const implementingPlan = body.planImplementationMode === "default";
    if (body.deliveryMode !== undefined && !["queue", "steer"].includes(body.deliveryMode))
      throw new AppError("invalid_request", "Invalid message delivery mode");
    const steering = body.deliveryMode === "steer";
    const clientId = body.clientMessageId ?? randomUUID();
    if (typeof clientId !== "string" || !clientId.trim() || clientId.length > 300)
      throw new AppError("invalid_request", "Invalid client message ID");
    const fingerprint = hash({
      input: text,
      ...pastedText(body),
      images: body.images ?? [],
      files: body.files ?? [],
      ...(steering ? { deliveryMode: "steer" } : {}),
    });
    const saved = thread.deliveries[clientId];
    if (saved) {
      if (saved.fingerprint !== fingerprint)
        throw new AppError("conflict", "Message ID was reused with different input", 409);
      return (
        thread.queue.find((item) => item.id === saved.messageId) ?? {
          id: saved.messageId,
          threadId: id,
          text,
          createdAt: thread.createdAt,
          status: "dispatching",
          deliveryVersion: 1,
          ...(saved.mode ? { deliveryMode: saved.mode } : {}),
        }
      );
    }
    if (body.files?.length) await this.attachments.validate(id, body.files);
    const imageFiles: ThreadFileAttachment[] = [];
    let fresh = false,
      durable = false;
    let clearedProject: { projectId: string; draft: ThreadDraft } | undefined;
    try {
      for (const url of body.images ?? []) {
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
          url,
        );
        if (!match)
          throw new AppError("invalid_request", "Images must be supported image data URLs");
        const buffer = Buffer.from(match[2]!, "base64");
        if (buffer.length > 5 * 1024 * 1024)
          throw new AppError("invalid_request", "Image exceeds 5 MiB");
        imageFiles.push(
          await this.attachments.save(
            id,
            `image-${imageFiles.length + 1}`,
            match[1]!,
            Readable.from(buffer),
            buffer.length,
          ),
        );
      }
      const message = await this.store.update((data) => {
        const current = data.threads[id]!,
          prior = current.deliveries[clientId];
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new AppError("conflict", "Message ID conflict", 409);
          return (
            current.queue.find((item) => item.id === prior.messageId) ?? {
              id: prior.messageId,
              threadId: id,
              text,
              createdAt: current.createdAt,
              status: "dispatching" as const,
              deliveryVersion: 1 as const,
              ...(prior.mode ? { deliveryMode: prior.mode } : {}),
            }
          );
        }
        const message: QueuedMessage = {
          id: commandId(clientId),
          threadId: id,
          text,
          ...pastedText(body),
          ...(body.images?.length ? { images: body.images } : {}),
          ...(body.files?.length ? { files: body.files } : {}),
          createdAt: Date.now(),
          status: "queued",
          deliveryVersion: 1,
          ...(steering ? { deliveryMode: "steer" as const } : {}),
        };
        fresh = true;
        current.queue.push(message);
        delete current.awaitingPlanResponse;
        if (implementingPlan)
          current.settings = { ...current.settings, collaborationMode: "default" };
        current.deliveries[clientId] = {
          fingerprint,
          messageId: message.id,
          accepted: false,
          ...(steering ? { mode: "steer" as const } : {}),
          ...(imageFiles.length ? { imageFiles } : {}),
        };
        if (current.title === "Новая сессия")
          current.title = text.replace(/\s+/g, " ").slice(0, 100) || "Вложения";
        current.updatedAt = Date.now();
        const sentDraft = current.draft,
          expectedDraft = (body as QueueMessageRequest & { draftUpdatedAt?: number | null })
            .draftUpdatedAt;
        if (sentDraft) {
          const draftText = trimPastedMessage(sentDraft.input, sentDraft),
            messageText = trimPastedMessage(text, body);
          const matches =
            expectedDraft !== undefined
              ? expectedDraft === sentDraft.updatedAt
              : !sentDraft.annotations.length &&
                serializePastedMessage(draftText.input, draftText) ===
                  serializePastedMessage(messageText.input, messageText) &&
                JSON.stringify(sentDraft.images.map((image) => image.url)) ===
                  JSON.stringify(body.images ?? []) &&
                JSON.stringify(sentDraft.files ?? []) === JSON.stringify(body.files ?? []);
          if (matches) current.draft = null;
        }
        const projectDraft = body.projectDraft;
        if (
          projectDraft &&
          current.projectId === projectDraft.projectId &&
          data.projectDrafts[projectDraft.projectId]?.updatedAt === projectDraft.updatedAt
        ) {
          const draft = emptyDraft();
          data.projectDrafts[projectDraft.projectId] = draft;
          clearedProject = { projectId: projectDraft.projectId, draft };
        }
        return message;
      });
      durable = true;
      if (clearedProject) this.publish({ type: "projectDraft.changed", ...clearedProject });
      if (fresh) {
        if (implementingPlan) {
          this.permissionEpoch++;
          await this.applyPermissions(id);
        }
        this.publish({ type: "thread.upserted", thread: this.summary(id) });
      }
      this.publishQueue(id);
      this.schedule(id);
      return message;
    } finally {
      if (!fresh || !durable)
        await Promise.allSettled(imageFiles.map((file) => this.attachments.remove(id, file.id)));
    }
  }
  steer(id: string, body: QueueMessageRequest): Promise<QueuedMessage> {
    return this.enqueue(id, { ...body, deliveryMode: "steer" });
  }
  private nextMessage(thread: UiThread): QueuedMessage | undefined {
    const owner = this.owners.get(thread.id);
    return (
      thread.queue.find(
        (message) =>
          message.deliveryMode === "steer" &&
          !message.deliveryError &&
          !owner?.commands.some(
            (receipt) => receipt.requestId === message.id && receipt.status === "accepted",
          ),
      ) ??
      thread.queue.find((message) => message.deliveryMode !== "steer") ??
      thread.queue[0]
    );
  }
  publishQueue(id: string): void {
    this.publish({ type: "queue.changed", threadId: id, messages: this.thread(id).queue });
    this.publish({ type: "thread.upserted", thread: this.summary(id) });
  }
  schedule(id: string): void {
    if (this.closed || !this.manager.accepting || this.dispatches.has(id)) return;
    const initial = this.nextMessage(this.thread(id))?.id,
      initialState = this.owners.get(id)?.state;
    const task = this.dispatch(id)
      .catch(() => undefined)
      .finally(() => {
        this.dispatches.delete(id);
        const first = this.nextMessage(this.thread(id)),
          owner = this.owners.get(id);
        if (
          first &&
          !first.deliveryError &&
          (first.id !== initial ||
            (owner?.state !== initialState &&
              owner &&
              ["idle", "interrupted"].includes(owner.state)))
        )
          queueMicrotask(() => this.schedule(id));
      });
    this.dispatches.set(id, task);
  }
  private async dispatch(id: string): Promise<void> {
    if (!this.thread(id).queue.length) return;
    const descriptor = await this.manager.descriptor(id);
    if (descriptor && !this.owners.has(id)) {
      try {
        await this.attach(id);
      } catch {
        if (await this.manager.launcher.active(id)) return;
      }
    }
    let owner = this.owners.get(id);
    const candidate = this.nextMessage(this.thread(id));
    if (!candidate || candidate.deliveryError) return;
    const receipt = owner?.commands.find((item) => item.requestId === candidate.id);
    if (receipt?.status === "unknown") {
      await this.deliveryError(
        id,
        candidate.id,
        "Claude receipt has an unknown outcome; automatic resend is disabled",
        false,
      );
      return;
    }
    if (receipt) {
      if (receipt.status === "completed" || candidate.deliveryMode !== "steer")
        await this.accepted(id, candidate.id);
      return;
    }
    if (owner?.state === "interrupted" && owner.awaitingResult) return;
    const idle = owner && ["idle", "interrupted", "closed"].includes(owner.state);
    if (
      owner &&
      !idle &&
      !(
        candidate.deliveryMode === "steer" &&
        owner.capabilities?.steer &&
        ["running", "waiting"].includes(owner.state)
      )
    )
      return;
    // A backend update never replaces active session owners. Upgrade older owners
    // at their next idle admission, preserving their native session history.
    if (
      owner &&
      idle &&
      owner.state !== "closed" &&
      (owner.releasePath !== this.manager.config.releasePath || !owner.capabilities?.steer)
    ) {
      try {
        await this.manager.command(id, "release", { requestId: randomUUID() });
        const deadline = Date.now() + 10_000;
        while (await this.manager.launcher.active(id)) {
          if (Date.now() >= deadline)
            throw new AppError("unavailable", "Previous Claude owner is still stopping", 503);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        this.subscriptions.get(id)?.close();
        this.subscriptions.delete(id);
        this.owners.delete(id);
        owner = undefined;
      } catch {
        // An interruption can still be awaiting its native result; the final
        // owner event will schedule admission again without cancelling work.
        return;
      }
    }
    const admission = await this.store.update((data) => {
      if (this.closed || !this.manager.accepting) return null;
      const thread = data.threads[id]!,
        message = this.nextMessage(thread);
      if (!message || message.deliveryError) return null;
      const delivery = Object.values(thread.deliveries).find(
        (item) => item.messageId === message.id,
      );
      if (!delivery) throw new AppError("conflict", "Queued message receipt is missing", 409);
      message.status = "dispatching";
      return { thread, message, delivery };
    });
    if (!admission) return;
    const { thread, message, delivery } = admission;
    this.publishQueue(id);
    const known = owner?.commands.find((item) => item.requestId === message.id);
    if (known?.status === "unknown") {
      await this.deliveryError(
        id,
        message.id,
        "Claude receipt has an unknown outcome; reconcile before sending another message",
        false,
      );
      return;
    }
    if (known) {
      if (known.status === "completed" || message.deliveryMode !== "steer")
        await this.accepted(id, message.id);
      if (known.status === "completed") queueMicrotask(() => this.schedule(id));
      return;
    }
    try {
      if (
        descriptor &&
        owner &&
        ((delivery.imageFiles?.length && !owner.capabilities?.uploadedImages) ||
          (message.files?.length && !owner.capabilities?.contentBlocks))
      )
        throw new AppError(
          "conflict",
          "The existing owner cannot accept these attachments; finish and release it before using attachments",
          409,
        );
      const content = {
        ...(message.files?.length ? { files: message.files } : {}),
        ...(delivery.imageFiles?.length ? { images: delivery.imageFiles } : {}),
      };
      const prompt = serializePastedMessage(message.text, pastedText(message));
      const result =
        message.deliveryMode === "steer" && owner?.capabilities?.steer && owner.state !== "closed"
          ? await this.manager.steer(id, message.id, prompt, content)
          : descriptor || thread.nativeHistory || this.views.get(id)?.turns().length
            ? await this.manager.send(id, message.id, prompt, content, {
                model: thread.settings.model,
                effort: thread.settings.reasoningEffort,
                permissionMode: this.permissionMode(id),
              })
            : await this.manager.create({
                sessionId: id,
                requestId: message.id,
                cwd: thread.cwd,
                prompt,
                model: thread.settings.model,
                effort: thread.settings.reasoningEffort,
                permissionMode: this.permissionMode(id),
                ...content,
              });
      const returned = result as CommandReceipt;
      const currentOwner = this.owners.get(id);
      const cached = currentOwner?.commands.find((entry) => entry.requestId === message.id);
      if (currentOwner && !cached) currentOwner.commands.push(returned);
      const receipt = cached && cached.status !== "accepted" ? cached : returned;
      if (receipt.status === "unknown")
        throw new AppError(
          "conflict",
          "Unknown delivery outcome; automatic resend is disabled",
          409,
        );
      if (receipt.status === "completed" || message.deliveryMode !== "steer")
        await this.accepted(id, message.id);
      await this.attach(id);
    } catch (error) {
      const snapshot = await this.manager.snapshot(id).catch(() => undefined);
      if (snapshot) this.owners.set(id, snapshot);
      const receipt = snapshot?.commands.find((item) => item.requestId === message.id);
      if (receipt && receipt.status !== "unknown") {
        if (receipt.status === "completed" || message.deliveryMode !== "steer")
          await this.accepted(id, message.id);
        await this.attach(id).catch(() => undefined);
      } else if (
        snapshot &&
        !receipt &&
        ["running", "waiting", "interrupted"].includes(snapshot.state) &&
        error instanceof AppError &&
        error.code === "conflict"
      ) {
        await this.store.update((data) => {
          const entry = data.threads[id]!.queue.find((item) => item.id === message.id);
          if (entry) entry.status = "queued";
        });
        this.publishQueue(id);
      } else
        await this.deliveryError(
          id,
          message.id,
          receipt?.status === "unknown"
            ? "Claude receipt has an unknown outcome; automatic resend is disabled"
            : error instanceof Error
              ? error.message
              : "Claude delivery failed",
          receipt?.status !== "unknown" && error instanceof AppError && error.code !== "conflict",
        );
    }
  }
  private async accepted(id: string, messageId: string): Promise<void> {
    const message = this.thread(id).queue.find((item) => item.id === messageId);
    if (message) {
      const view = await this.view(id);
      for (const update of view.recordUserMessage(message)) this.publish(update);
    }
    await this.store.update((data) => {
      const thread = data.threads[id]!;
      thread.nativeHistory = true;
      thread.queue = thread.queue.filter((item) => item.id !== messageId);
      for (const delivery of Object.values(thread.deliveries))
        if (delivery.messageId === messageId) {
          delivery.accepted = true;
          delete delivery.imageFiles;
        }
    });
    this.publishQueue(id);
  }
  private async deliveryError(
    id: string,
    messageId: string,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    await this.store.update((data) => {
      const entry = data.threads[id]!.queue.find((item) => item.id === messageId);
      if (entry) {
        entry.status = "queued";
        entry.deliveryError = { message, retryable };
      }
    });
    this.publishQueue(id);
  }
  async settings(id: string, patch: Partial<SessionSettings>): Promise<ThreadSummary> {
    patch = { ...patch };
    if (patch.model === null) patch.model = "default";
    if (patch.reasoningEffort === null) patch.reasoningEffort = undefined;
    const thread = this.thread(id);
    if (patch.collaborationMode && !["default", "plan"].includes(patch.collaborationMode))
      throw new AppError("invalid_request", "Claude supports standard and plan sessions");
    const planChanged =
      patch.collaborationMode !== undefined &&
      patch.collaborationMode !== (thread.settings.collaborationMode ?? "default");
    if (patch.model && !this.modelOptions().some((item) => item.id === patch.model))
      throw new AppError("invalid_request", "Model is not in Claude's available catalog");
    const descriptor = await this.manager.descriptor(id),
      owner = this.owners.get(id);
    if (
      descriptor &&
      patch.reasoningEffort !== undefined &&
      patch.reasoningEffort !== thread.settings.reasoningEffort
    )
      throw new AppError("conflict", "Effort can be selected before the first message", 409);
    if (descriptor && patch.model && patch.model !== thread.settings.model) {
      if (!owner?.capabilities?.setModel)
        throw new AppError("conflict", "This owner cannot change its model", 409);
      await this.manager.command(id, "setModel", { requestId: randomUUID(), model: patch.model });
      owner.model = patch.model;
      await writeJsonAtomic(join(this.manager.config.stateDir, "sessions", id, "descriptor.json"), {
        ...descriptor,
        model: patch.model,
      });
    }
    await this.store.update((data) => {
      const current = data.threads[id]!;
      current.settings = {
        ...current.settings,
        ...patch,
        collaborationMode:
          patch.collaborationMode ?? current.settings.collaborationMode ?? "default",
      };
      if (current.settings.collaborationMode !== "plan") delete current.awaitingPlanResponse;
    });
    if (planChanged) {
      this.permissionEpoch++;
      await this.applyPermissions(id);
    }
    this.publish({ type: "thread.upserted", thread: this.summary(id) });
    return this.summary(id);
  }
  attention(): AttentionRequest[] {
    return [...this.owners].flatMap(([id, owner]) =>
      owner.pendingRequests.map((request) => this.toAttention(id, request)),
    );
  }
  private toAttention(id: string, request: PendingRequest): AttentionRequest {
    const key = `${id}:${request.requestId}`,
      base = {
        id: key,
        threadId: id,
        turnId: this.views.get(id)?.currentTurnId ?? null,
        itemId: null,
        createdAt: this.thread(id).updatedAt,
      };
    if (request.toolName === "AskUserQuestion" && Array.isArray(request.input.questions))
      return {
        ...base,
        kind: "userInput",
        isBlocking: true,
        autoResolutionMs: null,
        draftKey: key,
        draft: this.store.data.questionDrafts[key] ?? null,
        questions: request.input.questions.map((raw, index) => {
          const question = record(raw);
          return {
            id: `question-${index}`,
            header: String(question.header ?? ""),
            question: String(question.question ?? ""),
            isOther: true,
            isSecret: false,
            multiSelect: question.multiSelect === true,
            options: Array.isArray(question.options)
              ? question.options.map((raw) => {
                  const option = record(raw);
                  return {
                    label: String(option.label ?? ""),
                    description: String(option.description ?? ""),
                  };
                })
              : null,
          };
        }),
      };
    if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(request.toolName))
      return {
        ...base,
        kind: "fileChangeApproval",
        reason: `${request.toolName}: ${String(request.input.file_path ?? request.input.notebook_path ?? "")}`,
        grantRoot: null,
        canAcceptForSession: false,
      };
    return {
      ...base,
      kind: "commandApproval",
      command:
        request.toolName === "Bash"
          ? String(request.input.command ?? "")
          : `${request.toolName}: ${JSON.stringify(request.input)}`,
      cwd: this.thread(id).cwd,
      reason: `Claude requests ${request.toolName}`,
      networkHost: null,
      canAcceptForSession: false,
      proposedPolicyChanges: [],
    };
  }
  async respond(attentionId: string, answer: AttentionResponse): Promise<void> {
    const attention = this.attention().find((item) => item.id === attentionId);
    if (!attention?.threadId) throw new AppError("conflict", "Request is no longer pending", 409);
    const id = attention.threadId,
      targetRequestId = attentionId.slice(id.length + 1),
      request = this.owners
        .get(id)!
        .pendingRequests.find((item) => item.requestId === targetRequestId)!;
    let response: Record<string, unknown>;
    if (answer.kind === "userInput" && attention.kind === "userInput") {
      const answers: Record<string, string> = {};
      for (const question of attention.questions) {
        const selected = answer.answers[question.id];
        if (!Array.isArray(selected) || !selected.length)
          throw new AppError("invalid_request", "All questions require an answer");
        answers[question.question] = selected.join(", ");
      }
      response = { behavior: "allow", updatedInput: { ...request.input, answers } };
    } else if (answer.kind === "approval") {
      if (answer.decision === "acceptForSession")
        throw new AppError("invalid_request", "Session-wide grants are unavailable");
      if (answer.decision === "cancel") {
        await this.manager.command(id, "interrupt", { requestId: randomUUID() });
        return;
      }
      response =
        answer.decision === "accept"
          ? { behavior: "allow", updatedInput: request.input }
          : { behavior: "deny", message: "User declined this tool request" };
    } else throw new AppError("invalid_request", "Unsupported attention response");
    await this.manager.command(id, "respond", {
      requestId: randomUUID(),
      targetRequestId,
      response,
    });
  }
  async questionDraft(key: string, value: UpdateUserInputDraftRequest): Promise<void> {
    const attention = this.attention().find((item) => item.id === key);
    if (attention?.kind !== "userInput")
      throw new AppError("conflict", "Question is no longer pending", 409);
    await this.store.update((data) => {
      const prior = data.questionDrafts[key];
      data.questionDrafts[key] = {
        ...value,
        revision: (prior?.revision ?? 0) + 1,
        updatedAt: Date.now(),
      };
    });
    this.publish({
      type: "attention.upserted",
      attention: this.attention().find((item) => item.id === key)!,
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.reconnect);
    clearInterval(this.rateLimitsTimer);
    for (const connection of this.subscriptions.values()) connection.close();
    await Promise.allSettled([...this.dispatches.values(), ...this.permissionUpdates.values()]);
    await this.store.flush();
  }
}
