import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AppCapabilities,
  AppSnapshot,
  AttentionRequest,
  AttentionResponse,
  GlobalPermissionSettings,
  ModelOption,
  OpenConnectionStatus,
  Project,
  QueuedMessage,
  QueueMessageRequest,
  ServerEvent,
  ServerFrame,
  SessionSettings,
  TaskDefaults,
  ThreadDetail,
  ThreadDraft,
  ThreadSummary,
  ThreadGoal,
  BrowserThreadStatus,
  UserInputDraft,
  SessionArtifact,
  UiLanguage,
} from "@codexnest/protocol";
import { pastedText, serializePastedMessage, validPastedText } from "@codexnest/protocol";
import { readJson, writeJsonAtomic } from "../../claude-server/src/io";
import { SUPPORTED_OPENCODE_VERSION, type Config } from "./config";
import { OpenCodeClient, type OpenCodeEvent } from "./opencode";
import { projectTurns, type NativeMessage, type NativePart, type NativeTokens } from "./projection";
import { AttachmentStore, appendAttachmentContext } from "../../claude-server/src/attachments";
import type { StoredVoice, VoiceSettings, VoiceTimingSample } from "./voice";
import { publishArtifact } from "./artifacts";
import { expandSkill } from "./skills";
import type { StoredFork } from "./forks";
import { EventRelayError, relayEvents, type RelayFrame, type RelayPart } from "./event-relay";

export interface WorkflowHooks {
  validateSend?(id: string, input: QueueMessageRequest): Promise<void> | void;
  beforeDispatch?(
    id: string,
    input: QueueMessageRequest,
  ): Promise<{
    agent?: string;
    system?: string;
    tools?: Record<string, boolean>;
    cancelled?: boolean;
  }>;
  onIdle?(id: string): Promise<void>;
  onInterrupted?(id: string): Promise<void>;
  collaborationAgent?(mode: SessionSettings["collaborationMode"]): string;
  decorateDetail?(id: string, detail: ThreadDetail): ThreadDetail;
  decorateSummary?(id: string, summary: ThreadSummary): ThreadSummary;
  onUsage?(id: string): Promise<void>;
}
export interface BrowserBindingState {
  bindingId: string;
  instanceId: string;
  attachedAt: number;
  detachedAt?: number;
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}
export const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("validation_failed", "Invalid object");
  return value as Record<string, any>;
};
export const text = (value: unknown, name = "input", maximum = 200_000) => {
  if (typeof value !== "string" || value.length > maximum)
    throw new AppError("validation_failed", `Invalid ${name}`);
  return value;
};
export const blankDraft = (): ThreadDraft => ({
  input: "",
  images: [],
  annotations: [],
  goalMode: false,
  updatedAt: Date.now(),
});

// This backend stage is not release-qualified. These are implemented capabilities, not a parity claim.
export const capabilities: AppCapabilities = {
  codexManagement: false,
  rateLimits: false,
  plan: false,
  team: false,
  goal: false,
  forks: false,
  browserIntegration: false,
  fullTextSearch: false,
  sessionApprovalGrants: false,
  skills: false,
  gitChanges: true,
  artifacts: false,
  appUpdates: false,
  reasoningEffort: true,
};
type NativeSession = {
  id: string;
  title?: string;
  directory?: string;
  parentID?: string;
  /** Billed session total reported by OpenCode (USD). Older SDK types omit it. */
  cost?: number;
  time?: { created?: number; updated?: number; archived?: number };
};
type Receipt = {
  fingerprint: string;
  nativeMessageId: string;
  status: "prepared" | "sending" | "accepted" | "uncertain";
  message: QueuedMessage;
};
export type StoredThread = {
  summary: ThreadSummary;
  draft: ThreadDraft | null;
  queue: QueuedMessage[];
  receipts: Record<string, Receipt>;
  /** Native parent session for subagents created outside OpenNest's managed tasks. */
  parentThreadId?: string;
  /** Highest cost ever observed, so history compaction can never make the total shrink. */
  costHighWaterUsd?: number;
  /** Cost copied into a fork that must not count towards the new session's spend. */
  costBaselineUsd?: number;
  /** Last billed session total reported by the native runtime. */
  nativeCostUsd?: number;
  /** Whether usage was ever observed, so a zero-cost free model still shows a total. */
  costUsageSeen?: boolean;
  outcome?: "completed" | "failed" | "interrupted";
  goal?: ThreadGoal;
  teamOrchestration?: Record<string, unknown>;
  workflow?: Record<string, unknown>;
  browserEnabled?: boolean;
  browserBinding?: BrowserBindingState;
  artifacts?: SessionArtifact[];
  sessionGrants?: Array<{ permission: string; pattern: string }>;
  permissionVersion?: number;
};
type State = {
  version: 1;
  projects: Project[];
  threads: Record<string, StoredThread>;
  creations: Record<string, { projectId: string; threadId: string | null }>;
  projectDrafts: Record<string, ThreadDraft>;
  taskDefaults: TaskDefaults;
  language: UiLanguage;
  permission: "ask" | "auto" | "full-access";
  permissionVersion: number;
  savedOpenRouterKey?: boolean;
  voice?: Record<string, StoredVoice>;
  voiceUploads?: Record<string, string>;
  voiceSettings?: Partial<VoiceSettings>;
  voiceTimings?: Record<string, VoiceTimingSample[]>;
  userInputDrafts?: Record<string, UserInputDraft>;
  skillOverrides?: Record<string, boolean>;
  skillNames?: Record<string, string>;
  forkOperations?: Record<string, StoredFork>;
};
const initial = (): State => ({
  version: 1,
  projects: [],
  threads: {},
  creations: {},
  projectDrafts: {},
  taskDefaults: {},
  language: "ru",
  permission: "ask",
  permissionVersion: 1,
});
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nativeMessageId = () => `msg_${Date.now().toString(16)}${randomBytes(12).toString("hex")}`;

export class Engine extends EventEmitter {
  data = initial();
  readonly instanceId = randomUUID();
  sequence = 0;
  accepting = true;
  ready = false;
  runtimeVersion: string | null = null;
  private connectionMessage: string | null = null;
  models: ModelOption[] = [];
  apiKeyConfigured = false;
  readonly native: OpenCodeClient;
  readonly attachments: AttachmentStore;
  private workflowHooks: WorkflowHooks = {};
  private browserStatus?: (id: string) => BrowserThreadStatus;
  private browserMcp?: (id: string) => Array<Record<string, unknown>>;
  private browserTool?: (
    id: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  private nativeModelCapabilities = new Map<string, { images: boolean }>();
  /** USD per one million tokens, keyed by both native and protocol model IDs. */
  private modelPrices = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number }
  >();
  /** Direct (own messages) cost per thread, already adjusted for fork baselines. */
  private directCosts = new Map<string, { usd: number; estimated: boolean; hasUsage: boolean }>();
  private costSaveAt = 0;
  private helpers = new Set<string>();
  private enabledCapabilities = { ...capabilities };
  private controller = new AbortController();
  private saveTail: Promise<void> = Promise.resolve();
  private operationTail: Promise<unknown> = Promise.resolve();
  private live = new Map<string, NativeMessage[]>();
  private busy = new Set<string>();
  private requests = new Map<string, AttentionRequest>();
  private nativePermissions = new Map<string, { permission: string; patterns: string[] }>();
  private syncing = false;
  private closed = false;
  private nativeDispatch = new Set<string>();
  private flushPending = new Set<string>();
  private streamTask?: Promise<void>;
  private reconciliation?: Promise<void>;
  private snapshotParts = new Map<string, Set<string>>();
  private terminalRefreshes = new Map<string, Promise<void>>();
  private idleAfterDispatch = new Set<string>();
  private relayTask?: Promise<void>;
  private relayConnected = false;
  private relayInstance: string | null = null;
  private relayRevision = -1;
  private relayParts = new Map<string, RelayPart>();
  private relayCompleted = new Map<string, string>();

  constructor(
    public readonly config: Config,
    options: { native?: OpenCodeClient } = {},
  ) {
    super();
    this.attachments = new AttachmentStore(join(config.stateDir, "attachments"));
    this.native =
      options.native ??
      new OpenCodeClient({
        baseUrl: config.nativeUrl,
        username: config.nativeUsername,
        password: config.nativePassword,
      });
  }
  async initialize(options: { watch?: boolean } = {}) {
    this.data = (await readJson<State>(join(this.config.stateDir, "ui.json"))) ?? initial();
    if (
      this.data.version !== 1 ||
      !Array.isArray(this.data.projects) ||
      !this.data.threads ||
      !this.data.creations
    )
      throw new Error("Unsupported OpenNest state");
    // A crash between durable preparation and acknowledgement must not repeat a command.
    for (const thread of Object.values(this.data.threads)) {
      for (const receipt of Object.values(thread.receipts)) {
        if (receipt.status === "sending") {
          receipt.status = "uncertain";
          receipt.message.deliveryError = {
            message: "Delivery was interrupted. Refresh native history before sending again.",
            retryable: false,
          };
        }
      }
      thread.queue = thread.queue.map((message) => thread.receipts[message.id]?.message ?? message);
    }
    this.apiKeyConfigured = this.data.savedOpenRouterKey === true;
    await this.save();
    if (options.watch !== false) {
      if (this.config.nativeEventSocket) this.relayTask = this.watchRelay();
      this.streamTask = this.watch();
    }
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(run);
    this.operationTail = next.catch(() => undefined);
    return next;
  }
  setWorkflowHooks(hooks: WorkflowHooks) {
    this.workflowHooks = hooks;
  }
  enableCapabilities(values: Partial<AppCapabilities>) {
    Object.assign(this.enabledCapabilities, values);
  }
  isBusy(id: string) {
    return (
      this.busy.has(id) ||
      this.nativeDispatch.has(id) ||
      [...this.requests.values()].some((request) => request.threadId === id)
    );
  }
  canAcceptWork() {
    return this.ready && this.accepting && !this.syncing && !this.closed;
  }
  setBrowserStatusProvider(provider: (id: string) => BrowserThreadStatus) {
    this.browserStatus = provider;
  }
  setBrowserMcpProvider(provider: (id: string) => Array<Record<string, unknown>>) {
    this.browserMcp = provider;
  }
  browserToolContext(id: string) {
    this.thread(id);
    return this.browserMcp?.(id) ?? [];
  }
  setBrowserToolProvider(
    provider: (id: string, name: string, args: Record<string, unknown>) => Promise<unknown>,
  ) {
    this.browserTool = provider;
  }
  invokeBrowserTool(id: string, name: string, args: Record<string, unknown>) {
    this.thread(id);
    if (!this.browserTool)
      throw new AppError("app_server_unavailable", "Browser tools are unavailable", 503);
    return this.browserTool(id, name, args);
  }
  nativeMessages(id: string): readonly NativeMessage[] {
    this.thread(id);
    return this.live.get(id) ?? [];
  }
  usage(id: string) {
    return this.nativeMessages(id).reduce(
      (sum, message) => {
        const tokens = message.info.tokens;
        const valid = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
        const used =
          typeof tokens?.total === "number" && Number.isFinite(tokens.total) && tokens.total >= 0
            ? tokens.total
            : valid(tokens?.input) +
              valid(tokens?.output) +
              valid(tokens?.reasoning) +
              valid(tokens?.cache?.read) +
              valid(tokens?.cache?.write);
        return {
          tokensUsed: sum.tokensUsed + used,
          timeUsedSeconds:
            sum.timeUsedSeconds +
            (message.info.time?.completed && message.info.time.created
              ? Math.max(0, message.info.time.completed - message.info.time.created) / 1000
              : 0),
        };
      },
      { tokensUsed: 0, timeUsedSeconds: 0 },
    );
  }
  publishArtifact(id: string, input: { path: string; label?: string }) {
    return publishArtifact(this, id, input);
  }
  async mutateBrowser(id: string, mutation: (thread: StoredThread) => void) {
    return this.serial(async () => {
      mutation(this.thread(id));
      await this.save();
      this.changed(id);
    });
  }
  resetOwner(id: string) {
    this.thread(id); /* Native sessions are persistent; tool lookup is per call. */
  }
  async mutateVoice(
    mutation: (voice: Record<string, StoredVoice>, uploads: Record<string, string>) => void,
  ) {
    return this.serial(async () => {
      mutation((this.data.voice ??= {}), (this.data.voiceUploads ??= {}));
      await this.save();
    });
  }
  save(): Promise<void> {
    const snapshot = structuredClone(this.data);
    const next = this.saveTail.then(() =>
      writeJsonAtomic(join(this.config.stateDir, "ui.json"), snapshot),
    );
    this.saveTail = next.catch(() => undefined);
    return next;
  }
  publish(event: ServerEvent) {
    const frame: ServerFrame = {
      type: "event",
      sequence: ++this.sequence,
      version: { instanceId: this.instanceId, sequence: this.sequence },
      event,
    };
    this.emit("frame", frame);
  }
  connection() {
    return {
      state: this.ready ? ("ready" as const) : ("unavailable" as const),
      message: this.ready
        ? null
        : (this.connectionMessage ??
          "OpenCode is unavailable. Check the configured native service."),
      syncedAt: this.ready ? new Date().toISOString() : null,
    };
  }
  connectionStatus(): OpenConnectionStatus {
    return {
      runtime: this.ready ? "ready" : "unavailable",
      runtimeVersion: this.runtimeVersion,
      provider: "openrouter",
      apiKeyConfigured: this.apiKeyConfigured,
      message: this.ready ? null : this.connection().message,
    };
  }
  permissions(): GlobalPermissionSettings {
    return {
      preset: this.data.permission,
      version: String(this.data.permissionVersion),
      overridden: false,
      message: null,
    };
  }
  snapshot(): AppSnapshot {
    return {
      provider: "open",
      capabilities: this.enabledCapabilities,
      instanceId: this.instanceId,
      sequence: this.sequence,
      uiLanguage: this.data.language,
      connection: this.connection(),
      permissionSettings: this.permissions(),
      projects: this.data.projects,
      threads: Object.keys(this.data.threads).map((id) => this.summary(id)),
      attention: [...this.requests.values()],
      models: this.models,
      taskDefaults: this.data.taskDefaults,
      forkOperations: Object.values(this.data.forkOperations ?? {}).map((stored) => stored.summary),
      voiceTranscriptions: Object.values(this.data.voice ?? {})
        .filter((record) => !record.cancelled && !record.applied)
        .map((record) => record.job),
    };
  }
  project(id: string): Project {
    const project = this.data.projects.find((p) => p.id === id);
    if (!project) throw new AppError("not_found", "Project not found", 404);
    return project;
  }
  thread(id: string) {
    const thread = this.data.threads[id];
    if (!thread) throw new AppError("not_found", "Thread not found", 404);
    return thread;
  }
  summary(id: string): ThreadSummary {
    const thread = this.thread(id);
    const attention = [...this.requests.values()].some((request) => request.threadId === id);
    const summary: ThreadSummary = {
      ...thread.summary,
      browserStatus: this.browserStatus?.(id) ?? "disabled",
      state: attention
        ? "needsAttention"
        : this.busy.has(id)
          ? "running"
          : !this.ready
            ? "unavailable"
            : thread.queue.some((m) => !m.deliveryError)
              ? "queued"
              : (thread.outcome ?? "idle"),
      currentTurnId: this.busy.has(id) ? thread.summary.currentTurnId : null,
      queuedMessageCount: thread.queue.length,
    };
    // Compute on demand so summaries stay correct after restarts and lazy history loads.
    const costUsage = this.costUsage(id);
    if (costUsage) summary.costUsage = costUsage;
    return this.workflowHooks.decorateSummary?.(id, summary) ?? summary;
  }
  detail(id: string): ThreadDetail {
    const thread = this.thread(id);
    const turns = projectTurns(this.live.get(id) ?? [], this.busy.has(id), {
      managedCommands: thread.summary.relation.kind === "subagent",
    });
    for (const receipt of Object.values(thread.receipts)) {
      const turn = turns.find((candidate) => candidate.id === receipt.nativeMessageId);
      if (!turn) continue;
      const source = receipt.message;
      const itemId =
        turn.items.find((item) => item.type === "userMessage")?.id ?? receipt.nativeMessageId;
      turn.items = [
        {
          id: itemId,
          type: "userMessage",
          status: "completed",
          text: source.text,
          images: source.images ?? [],
          ...(source.files?.length ? { files: source.files.map((file) => ({ ...file })) } : {}),
          ...pastedText(source),
          phase: null,
          timestamp: source.createdAt,
        },
        ...turn.items.filter((item) => item.type !== "userMessage"),
      ];
    }
    if (thread.outcome === "interrupted" && turns.at(-1)) turns.at(-1)!.status = "interrupted";
    if (thread.outcome === "failed" && turns.at(-1)) {
      const turn = turns.at(-1)!;
      turn.status = "failed";
      if (!turn.items.some((item) => item.type === "error"))
        turn.items.push({
          type: "error",
          id: `native-error:${turn.id}`,
          status: "failed",
          message:
            "OpenCode could not complete this turn. Check the selected model and connection settings.",
        });
    }
    const detail: ThreadDetail = {
      version: { instanceId: this.instanceId, sequence: this.sequence },
      summary: this.summary(id),
      turns,
      queuedMessages: thread.queue,
      olderTurnsCursor: null,
      draft: thread.draft,
    };
    return this.workflowHooks.decorateDetail?.(id, detail) ?? detail;
  }
  changed(id: string) {
    this.publish({ type: "thread.upserted", thread: this.summary(id) });
  }
  private requireReady() {
    if (!this.ready || !this.accepting || this.syncing)
      throw new AppError(
        "app_server_unavailable",
        "OpenCode is unavailable, synchronizing or OpenNest is preparing a restart.",
        503,
      );
  }
  private importSession(session: NativeSession, cwd: string) {
    const existing = this.data.threads[session.id];
    if (existing) {
      // Native subagents created by OpenCode are flat sessions; keep their ancestry so the
      // parent's cost can include them.
      if (!existing.parentThreadId && session.parentID) existing.parentThreadId = session.parentID;
      const nativeCost = finiteAmount(session.cost);
      if (nativeCost !== null) existing.nativeCostUsd = nativeCost;
      this.refreshDirectCost(session.id);
      return;
    }
    const now = Date.now();
    const nativeCost = finiteAmount(session.cost);
    this.data.threads[session.id] = {
      summary: {
        id: session.id,
        projectId: this.data.projects.find((p) => p.path === cwd)?.id ?? null,
        title: session.title || "New session",
        preview: "",
        cwd: session.directory || cwd,
        state: "idle",
        unread: false,
        unseen: false,
        pinned: false,
        archived: Boolean(session.time?.archived),
        createdAt: session.time?.created ?? now,
        updatedAt: session.time?.updated ?? now,
        currentTurnId: null,
        queuedMessageCount: 0,
        browserStatus: "disabled",
        settings: {
          collaborationMode: "default",
          ...(this.data.taskDefaults.model ? { model: this.data.taskDefaults.model } : {}),
        },
        relation: { kind: "session", sessionId: session.id },
        canAcceptDirectInput: true,
      },
      draft: null,
      queue: [],
      receipts: {},
      ...(session.parentID ? { parentThreadId: session.parentID } : {}),
      ...(nativeCost !== null ? { nativeCostUsd: nativeCost } : {}),
    };
  }
  async addProject(path: string, displayName?: string) {
    const cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory())
      throw new AppError("validation_failed", "Project path must be a directory");
    return this.serial(async () => {
      const existing = this.data.projects.find((project) => project.path === cwd);
      if (existing) return existing;
      const now = new Date().toISOString();
      const project = {
        id: randomUUID(),
        path: cwd,
        displayName: displayName || basename(cwd),
        createdAt: now,
        updatedAt: now,
      };
      this.data.projects.push(project);
      await this.save();
      this.publish({ type: "project.upserted", project });
      if (this.ready) await this.syncDirectory(cwd);
      return project;
    });
  }
  async createThread(
    projectId: string,
    creationId: string,
    draft?: ThreadDraft,
    options: {
      cwd?: string;
      title?: string;
      settings?: Partial<SessionSettings>;
      parentThreadId?: string;
    } = {},
  ) {
    return this.serial(async () => {
      this.requireReady();
      const project = projectId ? this.project(projectId) : null;
      if (!project && (!options.cwd || draft?.files?.length))
        throw new AppError("not_found", "Project not found", 404);
      const cwd = options.cwd ? await realpath(options.cwd) : project!.path;
      if (!(await stat(cwd)).isDirectory())
        throw new AppError("validation_failed", "Session cwd must be a directory");
      const prior = this.data.creations[creationId];
      if (prior) {
        if (prior.projectId !== projectId)
          throw new AppError("conflict", "Creation identifier belongs to another project", 409);
        if (!prior.threadId)
          throw new AppError(
            "conflict",
            "Native session creation was interrupted; inspect history before retrying.",
            409,
          );
        return { thread: this.summary(prior.threadId), draft: this.thread(prior.threadId).draft };
      }
      this.data.creations[creationId] = { projectId, threadId: null };
      await this.save();
      const session = await this.native.request<NativeSession>("POST", "/session", {
        directory: cwd,
        body: {
          title: options.title || "New session",
          permission: this.permissionRules(),
        },
      });
      this.importSession(session, cwd);
      const stored = this.thread(session.id);
      stored.permissionVersion = this.data.permissionVersion;
      stored.summary.projectId = project?.id ?? null;
      stored.summary.settings = { ...stored.summary.settings, ...options.settings };
      if (options.parentThreadId) {
        stored.parentThreadId = options.parentThreadId;
        stored.summary.relation = {
          kind: "subagent",
          sessionId: session.id,
          parentThreadId: options.parentThreadId,
          nickname: null,
          role: null,
        };
      }
      if (draft?.files?.length) {
        const validated = await this.attachments.validate(projectId, draft.files);
        const copied = [];
        for (const file of validated)
          copied.push(
            await this.attachments.save(
              session.id,
              file.name,
              file.mediaType,
              createReadStream(file.path),
              file.size,
            ),
          );
        draft = { ...draft, files: copied };
      }
      if (draft) this.thread(session.id).draft = draft;
      this.data.creations[creationId]!.threadId = session.id;
      await this.save();
      this.changed(session.id);
      return { thread: this.summary(session.id), draft: this.thread(session.id).draft };
    });
  }
  private nativeDirectories(): Array<string | undefined> {
    return [
      undefined,
      ...new Set([
        ...this.data.projects.map((project) => project.path),
        ...Object.values(this.data.threads).map((thread) => thread.summary.cwd),
      ]),
    ];
  }
  async withIdleNative<T>(action: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      // Connection repair must remain possible when provider/model discovery
      // failed. Native health and scoped idle inventories are independent proof;
      // an unavailable status endpoint is never treated as an idle instance.
      if (!this.accepting || this.closed)
        throw new AppError("app_server_unavailable", "OpenNest is preparing a restart", 503);
      const health = await this.native.health();
      if (!health.healthy || health.version.replace(/^v/, "") !== SUPPORTED_OPENCODE_VERSION)
        throw new AppError(
          "app_server_unavailable",
          "The supported native OpenCode service is not available",
          503,
        );
      if (this.busy.size || this.nativeDispatch.size || this.requests.size || this.helpers.size)
        throw new AppError(
          "conflict",
          "Finish active work before changing the native connection",
          409,
        );
      // Proxy changes restart the entire managed daemon. Inventory its native
      // metadata, including archived sessions, so an external cwd cannot hide
      // active work beyond the native API's default first hundred sessions.
      const inventory = await this.native.request<NativeSession[]>(
        "GET",
        "/experimental/session?archived=true&limit=2147483647",
      );
      if (
        !Array.isArray(inventory) ||
        inventory.some((session) => typeof session.directory !== "string")
      )
        throw new AppError(
          "app_server_unavailable",
          "Native session inventory is unavailable",
          503,
        );
      const directories = new Set([
        ...this.nativeDirectories(),
        ...inventory.map((session) => session.directory),
      ]);
      for (const directory of directories) {
        const [statuses, permissions, questions] = await Promise.all([
          this.native.request<Record<string, { type: string }>>("GET", "/session/status", {
            directory,
          }),
          this.native.request<unknown[]>("GET", "/permission", { directory }),
          this.native.request<unknown[]>("GET", "/question", { directory }),
        ]);
        if (
          Object.values(statuses).some(
            (status) => status.type === "busy" || status.type === "retry",
          ) ||
          permissions.length ||
          questions.length
        )
          throw new AppError(
            "conflict",
            "The native instance has active work or pending decisions. Finish it first.",
            409,
          );
      }
      return action();
    });
  }
  async setApiKey(apiKey: string) {
    if (!apiKey.trim() || /[\s\0]/.test(apiKey) || apiKey.length > 16_000)
      throw new AppError("validation_failed", "Invalid API key");
    return this.withIdleNative(async () => {
      const directories = this.nativeDirectories();
      await this.native.request("PUT", "/auth/openrouter", { body: { type: "api", key: apiKey } });
      // A saved-key flag records only our successful write, never authorization.
      this.data.savedOpenRouterKey = true;
      this.apiKeyConfigured = true;
      await this.save();
      for (const directory of directories)
        await this.native.request("POST", "/instance/dispose", { directory });
      await this.refreshModels();
      return {
        ...this.connectionStatus(),
        message: "Key saved. OpenRouter authorization has not been verified by a model request.",
      };
    });
  }
  async oneShot(prompt: string, model?: string, signal?: AbortSignal): Promise<string> {
    const selected =
      (model && model !== "default" ? model : undefined) ||
      this.data.taskDefaults.model ||
      this.models.find((candidate) => candidate.isDefault)?.id ||
      this.models[0]?.id;
    if (!selected?.startsWith("openrouter/"))
      throw new AppError("validation_failed", "Choose an OpenRouter model");
    let sessionId: string | undefined;
    const marker = randomUUID();
    await this.serial(async () => {
      this.requireReady();
      this.helpers.add(marker);
    });
    try {
      const session = await this.native.request<NativeSession>("POST", "/session", {
        body: {
          title: "OpenNest helper",
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        },
        signal,
      });
      sessionId = session.id;
      const response = await this.native.request<NativeMessage>(
        "POST",
        `/session/${encodeURIComponent(session.id)}/message`,
        {
          body: {
            model: { providerID: "openrouter", modelID: selected.slice("openrouter/".length) },
            agent: "build",
            tools: { "*": false },
            parts: [{ type: "text", text: prompt }],
          },
          signal,
          timeoutMs: 120_000,
        },
      );
      if (response.info.error)
        throw new AppError("app_server_unavailable", "The helper model request failed", 503);
      return response.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
    } finally {
      this.helpers.delete(marker);
      if (sessionId)
        await this.native
          .request("DELETE", `/session/${encodeURIComponent(sessionId)}`)
          .catch(() => undefined);
    }
  }
  async refreshModels() {
    const catalog = await this.native.request<{
      all?: Array<{
        id: string;
        models?: Record<
          string,
          {
            id: string;
            name?: string;
            variants?: Record<string, unknown>;
            capabilities?: { input?: { image?: boolean } };
            cost?: unknown;
          }
        >;
      }>;
      connected?: string[];
      default?: Record<string, string>;
    }>("GET", "/provider");
    const provider = catalog.all?.find((p) => p.id === "openrouter");
    this.nativeModelCapabilities = new Map(
      Object.entries(provider?.models ?? {}).map(([id, model]) => [
        `openrouter/${id}`,
        { images: model.capabilities?.input?.image === true },
      ]),
    );
    const prices = new Map<
      string,
      { input: number; output: number; cacheRead: number; cacheWrite: number }
    >();
    for (const [id, model] of Object.entries(provider?.models ?? {})) {
      const price = parseModelPrice(model.cost);
      if (!price) continue;
      prices.set(id, price);
      prices.set(`openrouter/${id}`, price);
    }
    this.modelPrices = prices;
    this.models = Object.entries(provider?.models ?? {}).map(([id, model]) => ({
      id: `openrouter/${id}`,
      displayName: model.name || id,
      description: "OpenRouter",
      isDefault: catalog.default?.openrouter === id,
      reasoningEfforts: Object.keys(model.variants ?? {}).map((variant, index) => ({
        value: variant,
        description: null,
        isDefault: index === 0,
      })),
      serviceTiers: [],
      supportsPersonality: false,
    }));
    this.publish({ type: "models.changed", models: this.models });
  }
  private permissionRules(thread?: StoredThread, tools?: Record<string, boolean>) {
    const rules: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }> =
      [
        {
          permission: "*",
          pattern: "*",
          action: this.data.permission === "full-access" ? "allow" : "ask",
        },
      ];
    if (this.data.permission !== "full-access")
      for (const permission of ["read", "glob", "grep", "list", "todoread", "todowrite", "skill"])
        rules.push({ permission, pattern: "*", action: "allow" });
    if (this.data.permission === "auto")
      for (const permission of ["edit", "write", "apply_patch"])
        rules.push({ permission, pattern: "*", action: "allow" });
    for (const grant of thread?.sessionGrants ?? []) rules.push({ ...grant, action: "allow" });
    for (const [path, enabled] of Object.entries(this.data.skillOverrides ?? {}))
      if (!enabled)
        rules.push({
          permission: "skill",
          pattern: this.data.skillNames?.[path] ?? basename(path.slice(0, path.lastIndexOf("/"))),
          action: "deny",
        });
    // Native prompt.tools replaces session permissions rather than merging them.
    // Express workflow exclusions as the last rules, preserving presets/grants.
    for (const [permission, enabled] of Object.entries(tools ?? {}))
      if (!enabled) rules.push({ permission, pattern: "*", action: "deny" });
    return rules;
  }
  async applySessionPermissions(id: string, tools?: Record<string, boolean>) {
    const thread = this.thread(id);
    const exclusions =
      tools ?? (await this.workflowHooks.beforeDispatch?.(id, { input: "" }))?.tools;
    await this.native.request("PATCH", `/session/${encodeURIComponent(id)}`, {
      directory: thread.summary.cwd,
      body: { permission: this.permissionRules(thread, exclusions) },
    });
    thread.permissionVersion = this.data.permissionVersion;
  }
  async setPermissions(preset: "ask" | "auto" | "full-access", expectedVersion?: string | null) {
    return this.serial(async () => {
      if (expectedVersion && expectedVersion !== String(this.data.permissionVersion))
        throw new AppError("conflict", "Settings changed on another device", 409);
      this.data.permission = preset;
      this.data.permissionVersion++;
      await this.save();
      for (const id of Object.keys(this.data.threads))
        if (!this.isBusy(id)) await this.applySessionPermissions(id);
      await this.save();
      const settings = this.permissions();
      this.publish({ type: "permissions.changed", permissionSettings: settings });
      return settings;
    });
  }
  async refreshThread(id: string) {
    if (this.config.nativeEventSocket && !this.relayConnected) throw new EventRelayError();
    const thread = this.thread(id);
    const messages = await this.native.request<NativeMessage[]>(
      "GET",
      `/session/${encodeURIComponent(id)}/message`,
      { directory: thread.summary.cwd },
    );
    if (this.config.nativeEventSocket) {
      for (const message of messages)
        for (const part of message.parts) {
          const canonical = this.relayParts.get(part.id);
          if (canonical && !message.info.time?.completed && !this.nativeTextComplete(part))
            part.text = canonical.text;
        }
    }
    this.live.set(id, messages);
    this.refreshCost(id);
    // Native SSE has no replay boundary tied to a history snapshot. Buffered
    // deltas for these parts may already be represented in the fetched text.
    // Keep absolute part updates, suppress ambiguous deltas, fetch once at idle.
    if (!this.config.nativeEventSocket)
      this.snapshotParts.set(
        id,
        new Set(messages.flatMap((message) => message.parts.map((part) => part.id))),
      );
    let changed = false;
    for (const receipt of Object.values(thread.receipts)) {
      if (
        receipt.status !== "accepted" &&
        messages.some((message) => message.info.id === receipt.nativeMessageId)
      ) {
        receipt.status = "accepted";
        delete receipt.message.deliveryError;
        thread.queue = thread.queue.filter((m) => m.id !== receipt.message.id);
        changed = true;
      }
    }
    if (changed) await this.save();
    return this.detail(id);
  }
  private async syncDirectory(directory: string) {
    const [sessions, statuses] = await Promise.all([
      this.native.request<NativeSession[]>("GET", "/session?limit=2147483647", { directory }),
      this.native.request<Record<string, { type: string }>>("GET", "/session/status", {
        directory,
      }),
    ]);
    for (const session of sessions) this.importSession(session, directory);
    for (const thread of Object.values(this.data.threads).filter(
      (t) => t.summary.cwd === directory,
    )) {
      if (
        statuses[thread.summary.id]?.type === "busy" ||
        statuses[thread.summary.id]?.type === "retry"
      )
        this.busy.add(thread.summary.id);
      else this.busy.delete(thread.summary.id);
      const needsHistory =
        thread.summary.currentTurnId ||
        thread.queue.some((m) => m.status === "dispatching") ||
        Object.values(thread.receipts).some((r) => r.status === "uncertain");
      if (needsHistory) await this.refreshThread(thread.summary.id);
      if (this.busy.has(thread.summary.id))
        thread.summary.currentTurnId =
          this.detail(thread.summary.id).turns.at(-1)?.id ?? thread.summary.currentTurnId;
    }
    for (const kind of ["permission", "question"] as const) {
      const requests = await this.native.request<Array<Record<string, any>>>("GET", `/${kind}`, {
        directory,
      });
      for (const request of requests) this.addAttention(kind, request);
    }
  }
  reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    this.syncing = true;
    this.reconciliation = this.serial(() => this.reconcileNow()).finally(() => {
      this.reconciliation = undefined;
    });
    return this.reconciliation;
  }
  private async reconcileNow() {
    this.syncing = true;
    try {
      const health = await this.native.health();
      if (!health.healthy)
        throw new AppError("app_server_unavailable", "OpenCode is not ready", 503);
      this.runtimeVersion = health.version;
      if (health.version.replace(/^v/, "") !== SUPPORTED_OPENCODE_VERSION) {
        this.connectionMessage = `This OpenNest backend requires OpenCode ${SUPPORTED_OPENCODE_VERSION}.`;
        throw new AppError("app_server_unavailable", this.connectionMessage, 503);
      }
      await this.refreshModels();
      // /provider initializes the native plugin. Waiting for its relay before
      // that bootstrap would deadlock first-time managed installation startup.
      if (this.config.nativeEventSocket) {
        const until = Date.now() + 5000;
        while (!this.relayConnected && this.relayTask && !this.closed && Date.now() < until)
          await delay(25, undefined, { signal: this.controller.signal });
        if (!this.relayConnected) throw new EventRelayError();
      }
      this.requests.clear();
      this.busy.clear();
      for (const directory of new Set([
        ...this.data.projects.map((p) => p.path),
        ...Object.values(this.data.threads).map((t) => t.summary.cwd),
      ]))
        await this.syncDirectory(directory);
      if (this.config.nativeEventSocket && !this.relayConnected) throw new EventRelayError();
      this.ready = true;
      this.connectionMessage = null;
      await this.save();
      this.publish({ type: "connection.changed", connection: this.connection() });
      this.publish({ type: "resync.required" });
    } catch (error) {
      this.ready = false;
      this.publish({ type: "connection.changed", connection: this.connection() });
      throw error;
    } finally {
      this.syncing = false;
    }
    for (const id of Object.keys(this.data.threads)) this.queuePump(id);
  }
  private async watch() {
    while (!this.closed) {
      try {
        for await (const event of this.native.events(undefined, this.controller.signal)) {
          if (event.type === "server.connected") await this.reconcile();
          else await this.onNativeEvent(event);
        }
      } catch {
        /* Reconnect restores state before dispatching any queued work. */
      }
      if (this.closed) break;
      this.ready = false;
      this.publish({ type: "connection.changed", connection: this.connection() });
      await delay(1_000, undefined, { signal: this.controller.signal }).catch(() => undefined);
    }
  }
  private nativeTextComplete(part: NativePart) {
    return typeof (part as NativePart & { time?: { end?: number } }).time?.end === "number";
  }
  private applyRelayPart(part: RelayPart, complete: boolean) {
    if (complete) this.relayParts.delete(part.id);
    else this.relayParts.set(part.id, part);
    if (!this.data.threads[part.sessionID]) return;
    const messages = this.live.get(part.sessionID) ?? [];
    this.live.set(part.sessionID, messages);
    let message = messages.find((item) => item.info.id === part.messageID);
    if (!message) {
      message = {
        info: {
          id: part.messageID,
          sessionID: part.sessionID,
          role: "assistant",
          ...(part.parentID ? { parentID: part.parentID } : {}),
        },
        parts: [],
      };
      messages.push(message);
    }
    const index = message.parts.findIndex((item) => item.id === part.id);
    const existing = message.parts[index];
    // A committed native value wins over a delayed relay fragment/completion.
    if (message.info.time?.completed || (existing && this.nativeTextComplete(existing))) {
      this.relayParts.delete(part.id);
      return;
    }
    if (index < 0) message.parts.push({ ...part });
    else message.parts[index] = { ...existing, ...part };
    if (complete) this.relayCompleted.set(part.id, part.sessionID);
    if (this.relayCompleted.size > 1024)
      this.relayCompleted.delete(this.relayCompleted.keys().next().value!);
    const thread = this.thread(part.sessionID);
    thread.summary.preview = part.text.slice(0, 250);
    this.flush(part.sessionID);
  }
  /** Versioned native-owner stream. Unversioned text deltas are never a fallback. */
  onRelayFrame(frame: RelayFrame) {
    if (frame.type === "heartbeat") return;
    if (frame.type === "error") throw new EventRelayError();
    if (frame.type === "snapshot") {
      if (
        frame.protocolVersion !== 1 ||
        !frame.healthy ||
        typeof frame.instanceId !== "string" ||
        !Number.isSafeInteger(frame.revision) ||
        !Array.isArray(frame.parts) ||
        frame.parts.length > 256
      )
        throw new EventRelayError();
      this.relayInstance = frame.instanceId;
      this.relayRevision = frame.revision;
      this.relayParts.clear();
      this.relayCompleted.clear();
      for (const part of frame.parts) this.applyRelayPart(part, false);
      this.relayConnected = true;
      return;
    }
    if (
      !this.relayConnected ||
      frame.instanceId !== this.relayInstance ||
      frame.revision !== this.relayRevision + 1
    )
      throw new EventRelayError();
    this.relayRevision = frame.revision;
    if (frame.type === "part") {
      this.applyRelayPart(frame.part, frame.complete);
      return;
    }
    const part = this.relayParts.get(frame.partID);
    if (!part) {
      // The durable native stream can finish a part before a queued relay delta
      // arrives. Completed native values stay authoritative.
      const message = this.live
        .get(frame.sessionID)
        ?.find((item) => item.info.id === frame.messageID);
      const finished = message?.parts.find((item) => item.id === frame.partID);
      if (
        message?.info.time?.completed ||
        (finished && this.nativeTextComplete(finished)) ||
        this.relayCompleted.has(frame.partID)
      )
        return;
      throw new EventRelayError();
    }
    if (
      part.text.length !== frame.offset ||
      part.sessionID !== frame.sessionID ||
      part.messageID !== frame.messageID ||
      typeof frame.delta !== "string"
    )
      throw new EventRelayError();
    this.applyRelayPart({ ...part, text: part.text + frame.delta }, false);
  }
  private async watchRelay() {
    while (!this.closed) {
      try {
        for await (const frame of relayEvents(
          this.config.nativeEventSocket!,
          this.config.token,
          this.controller.signal,
        )) {
          this.onRelayFrame(frame);
          if (frame.type === "snapshot" && !this.syncing && !this.ready && this.runtimeVersion)
            void this.reconcile().catch(() => undefined);
        }
      } catch {
        /* Snapshot on the next connection restores an atomic text boundary. */
      }
      if (this.closed) break;
      this.relayConnected = false;
      this.ready = false;
      this.connectionMessage =
        "Native streaming state is unavailable. Reconnect to restore a consistent snapshot.";
      this.publish({ type: "connection.changed", connection: this.connection() });
      await delay(1000, undefined, { signal: this.controller.signal }).catch(() => undefined);
    }
  }
  private addAttention(
    kind: "permission" | "question",
    request: Record<string, any>,
    allowGrant = true,
  ) {
    if (
      typeof request.id !== "string" ||
      typeof request.sessionID !== "string" ||
      !this.data.threads[request.sessionID]
    )
      return;
    if (
      kind === "permission" &&
      allowGrant &&
      Array.isArray(request.patterns) &&
      request.patterns.length &&
      request.patterns.every((pattern: unknown) =>
        this.thread(request.sessionID).sessionGrants?.some(
          (grant) => grant.permission === request.permission && grant.pattern === pattern,
        ),
      )
    ) {
      void this.native
        .request("POST", `/permission/${encodeURIComponent(request.id)}/reply`, {
          directory: this.thread(request.sessionID).summary.cwd,
          body: { reply: "once" },
        })
        .catch(() => this.addAttention(kind, request, false));
      return;
    }
    const base = {
      id: `${kind}:${request.id}`,
      threadId: request.sessionID,
      turnId: this.thread(request.sessionID).summary.currentTurnId,
      itemId: typeof request.tool?.callID === "string" ? request.tool.callID : null,
      createdAt: Date.now(),
    };
    if (kind === "permission")
      this.nativePermissions.set(base.id, {
        permission: String(request.permission ?? "*"),
        patterns: Array.isArray(request.patterns)
          ? request.patterns.filter((value: unknown): value is string => typeof value === "string")
          : [],
      });
    const attention: AttentionRequest =
      kind === "question"
        ? {
            ...base,
            kind: "userInput",
            isBlocking: true,
            autoResolutionMs: null,
            draftKey: base.id,
            draft: this.data.userInputDrafts?.[base.id] ?? null,
            questions: (Array.isArray(request.questions) ? request.questions : []).map(
              (q: Record<string, any>, index: number) => ({
                id: String(index),
                header: typeof q.header === "string" ? q.header : "",
                question: typeof q.question === "string" ? q.question : "",
                multiSelect: q.multiple === true,
                isOther: q.custom !== false,
                isSecret: false,
                options: Array.isArray(q.options)
                  ? q.options.map((option: Record<string, any>) => ({
                      label: String(option.label ?? ""),
                      description: String(option.description ?? ""),
                    }))
                  : null,
              }),
            ),
          }
        : {
            ...base,
            kind: "commandApproval",
            cwd: this.thread(request.sessionID).summary.cwd,
            command: Array.isArray(request.patterns) ? request.patterns.join("\n") : null,
            reason: typeof request.permission === "string" ? request.permission : null,
            networkHost: null,
            canAcceptForSession: true,
            proposedPolicyChanges: [],
          };
    this.requests.set(base.id, attention);
    this.publish({ type: "attention.upserted", attention });
    this.changed(request.sessionID);
  }
  async respond(id: string, response: AttentionResponse) {
    const attention = this.requests.get(id);
    if (!attention?.threadId) throw new AppError("not_found", "Request is no longer pending", 404);
    const directory = this.thread(attention.threadId).summary.cwd;
    const separator = id.indexOf(":");
    const nativeId = id.slice(separator + 1);
    if (attention.kind === "userInput" && response.kind === "userInput") {
      const answers = attention.questions.map((q) => response.answers[q.id] ?? []);
      if (
        !answers.every(
          (answer) => Array.isArray(answer) && answer.every((item) => typeof item === "string"),
        )
      )
        throw new AppError("validation_failed", "Invalid answers");
      await this.native.request("POST", `/question/${encodeURIComponent(nativeId)}/reply`, {
        directory,
        body: { answers },
      });
    } else if (attention.kind === "commandApproval" && response.kind === "approval") {
      if (response.decision === "acceptForSession") {
        const permission = this.nativePermissions.get(id);
        if (!permission?.patterns.length)
          throw new AppError("conflict", "Native permission details need to be refreshed", 409);
        const thread = this.thread(attention.threadId);
        for (const pattern of permission.patterns)
          if (
            !thread.sessionGrants?.some(
              (grant) => grant.permission === permission.permission && grant.pattern === pattern,
            )
          )
            (thread.sessionGrants ??= []).push({ permission: permission.permission, pattern });
        await this.applySessionPermissions(attention.threadId);
        await this.save();
      }
      await this.native.request("POST", `/permission/${encodeURIComponent(nativeId)}/reply`, {
        directory,
        body: {
          reply:
            response.decision === "accept" || response.decision === "acceptForSession"
              ? "once"
              : "reject",
        },
      });
    } else throw new AppError("validation_failed", "Response does not match request");
    this.requests.delete(id);
    this.nativePermissions.delete(id);
    if (this.data.userInputDrafts?.[id]) {
      delete this.data.userInputDrafts[id];
      await this.save();
    }
    this.publish({ type: "attention.removed", attentionId: id });
    this.changed(attention.threadId);
  }
  private flush(id: string) {
    if (this.flushPending.has(id)) return;
    this.flushPending.add(id);
    queueMicrotask(() => {
      this.flushPending.delete(id);
      if (!this.data.threads[id]) return;
      const turns = this.detail(id).turns;
      const turn = turns.at(-1);
      if (turn) this.publish({ type: "turn.replaced", threadId: id, turn });
      this.changed(id);
    });
  }
  async onNativeEvent(event: OpenCodeEvent) {
    if (event.type === "server.heartbeat" && !this.ready) {
      await this.reconcile();
      return;
    }
    const properties = event.properties as Record<string, any>;
    if (
      (event.type === "session.created" || event.type === "session.updated") &&
      typeof properties.info?.id === "string"
    ) {
      const session = properties.info as NativeSession;
      const directory = session.directory ?? event.directory;
      if (directory && this.data.projects.some((project) => project.path === directory)) {
        this.importSession(session, directory);
        const thread = this.data.threads[session.id];
        if (thread) {
          if (session.title) thread.summary.title = session.title;
          if (session.time?.updated) thread.summary.updatedAt = session.time.updated;
          this.refreshCost(session.id);
          await this.save();
          this.changed(session.id);
        }
      }
      return;
    }
    const id: unknown =
      properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID;
    if (event.type === "permission.asked") {
      this.addAttention("permission", properties);
      return;
    }
    if (event.type === "question.asked") {
      this.addAttention("question", properties);
      return;
    }
    if (
      event.type === "permission.replied" ||
      event.type === "question.replied" ||
      event.type === "question.rejected"
    ) {
      const requestId = `${event.type.startsWith("permission") ? "permission" : "question"}:${properties.requestID}`;
      this.requests.delete(requestId);
      this.publish({ type: "attention.removed", attentionId: requestId });
    }
    if (typeof id !== "string" || !this.data.threads[id]) return;
    const thread = this.thread(id);
    const messages = this.live.get(id) ?? [];
    this.live.set(id, messages);
    if (event.type === "message.updated" && properties.info?.id) {
      const message = messages.find((m) => m.info.id === properties.info.id);
      if (message) {
        // A history snapshot can already include the terminal message while
        // pre-snapshot metadata is still buffered on native SSE.
        if (!message.info.time?.completed || properties.info.time?.completed)
          message.info = properties.info;
      } else messages.push({ info: properties.info, parts: [] });
      if (properties.info.role === "user" && this.busy.has(id))
        thread.summary.currentTurnId = properties.info.id;
      if (properties.info.role === "assistant" && properties.info.error) thread.outcome = "failed";
      if (properties.info.role === "assistant" && properties.info.tokens)
        await this.workflowHooks.onUsage?.(id);
      if (properties.info.role === "assistant") this.refreshCost(id);
    } else if (event.type === "message.part.updated" && properties.part?.id) {
      let part = properties.part as NativePart;
      const message = messages.find((m) => m.info.id === part.messageID);
      if (message) {
        const index = message.parts.findIndex((p) => p.id === part.id);
        let apply = true;
        if (this.config.nativeEventSocket && ["text", "reasoning"].includes(part.type)) {
          if (this.nativeTextComplete(part)) {
            this.relayParts.delete(part.id);
            this.relayCompleted.set(part.id, id);
          } else if (
            message.info.time?.completed ||
            this.relayCompleted.has(part.id) ||
            this.nativeTextComplete(message.parts[index] ?? part)
          ) {
            apply = false;
          } else {
            const canonical = this.relayParts.get(part.id);
            if (canonical) part = { ...part, text: canonical.text };
          }
        }
        if (apply) {
          if (index === -1) message.parts.push(part);
          else message.parts[index] = part;
        }
        if (part.type === "step-finish") this.refreshCost(id);
      }
    } else if (event.type === "message.part.delta") {
      const part = messages
        .find((m) => m.info.id === properties.messageID)
        ?.parts.find((p) => p.id === properties.partID);
      if (
        !this.config.nativeEventSocket &&
        part &&
        !this.snapshotParts.get(id)?.has(part.id) &&
        properties.field === "text" &&
        typeof properties.delta === "string"
      )
        part.text = (part.text ?? "") + properties.delta;
    } else if (event.type === "session.status") {
      if (properties.status?.type === "busy" || properties.status?.type === "retry") {
        this.busy.add(id);
        thread.summary.currentTurnId =
          projectTurns(messages, true).at(-1)?.id ?? thread.summary.currentTurnId;
      } else {
        this.busy.delete(id);
        thread.summary.currentTurnId = null;
        thread.outcome ??= "completed";
        thread.summary.updatedAt = Date.now();
        thread.summary.unread = true;
        thread.summary.unseen = true;
        await this.save();
        this.refreshAtIdle(id);
        this.queuePump(id);
      }
    } else if (event.type === "session.idle") {
      this.busy.delete(id);
      thread.summary.currentTurnId = null;
      thread.outcome ??= "completed";
      thread.summary.updatedAt = Date.now();
      thread.summary.unread = true;
      thread.summary.unseen = true;
      await this.save();
      this.refreshAtIdle(id);
      this.queuePump(id);
    } else if (event.type === "session.error") {
      thread.outcome = "failed";
      this.busy.delete(id);
      thread.summary.currentTurnId = null;
      thread.summary.updatedAt = Date.now();
      thread.summary.unread = true;
      thread.summary.unseen = true;
      await this.save();
      this.refreshAtIdle(id);
    }
    const preview = messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .at(-1)?.text;
    if (preview) thread.summary.preview = preview.slice(0, 250);
    this.flush(id);
  }
  async send(id: string, input: QueueMessageRequest, queued = false): Promise<QueuedMessage> {
    return this.serial(async () => {
      this.requireReady();
      const thread = this.thread(id);
      const value = text(input.input);
      if (
        !validPastedText(input, value) ||
        (!value.trim() && !input.images?.length && !input.files?.length)
      )
        throw new AppError("validation_failed", "Enter a message");
      if ((input.goal || input.planImplementationMode) && !this.workflowHooks.validateSend)
        throw new AppError("validation_failed", "Workflow controller is unavailable");
      const clientId = text(input.clientMessageId, "clientMessageId", 200);
      if (!clientId)
        throw new AppError("validation_failed", "A stable message identifier is required");
      const hash = fingerprint({
        input: value,
        ...pastedText(input),
        images: input.images ?? [],
        files: input.files ?? [],
        goal: input.goal === true,
        planImplementationMode: input.planImplementationMode ?? null,
      });
      const prior = thread.receipts[clientId];
      if (prior) {
        if (prior.fingerprint !== hash)
          throw new AppError(
            "conflict",
            "Message identifier was reused with different content",
            409,
          );
        return prior.message;
      }
      await this.workflowHooks.validateSend?.(id, input);
      const files = await this.attachments.validate(id, input.files ?? []);
      const images = input.images ?? [];
      if (
        !Array.isArray(images) ||
        images.length > 12 ||
        images.some(
          (image) =>
            typeof image !== "string" ||
            !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image) ||
            image.length > 8 * 1024 * 1024,
        )
      )
        throw new AppError("validation_failed", "Invalid image attachment");
      if (
        files.some((file) => file.mediaType.startsWith("image/") && file.size > 5 * 1024 * 1024) ||
        images.some((image) => {
          const encoded = image.slice(image.indexOf(",") + 1);
          return (
            Math.floor((encoded.length * 3) / 4) -
              (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0) >
            5 * 1024 * 1024
          );
        })
      )
        throw new AppError("payload_too_large", "Images must be at most 5 MiB each", 413);
      const selectedModel =
        thread.summary.settings.model ||
        this.models.find((model) => model.isDefault)?.id ||
        this.models[0]?.id;
      if (
        (images.length || files.some((file) => file.mediaType.startsWith("image/"))) &&
        !this.nativeModelCapabilities.get(selectedModel ?? "")?.images
      )
        throw new AppError(
          "validation_failed",
          "The selected model does not support image input. Choose an image-capable model or remove the images.",
        );
      if (!queued && this.nativeDispatch.has(id))
        throw new AppError("conflict", "Another message is being dispatched", 409);
      const message: QueuedMessage = {
        id: clientId,
        threadId: id,
        text: value,
        ...(images.length ? { images } : {}),
        ...(files.length ? { files } : {}),
        ...(input.goal ? { goal: true } : {}),
        ...(input.planImplementationMode
          ? { planImplementationMode: input.planImplementationMode }
          : {}),
        ...pastedText(input),
        createdAt: Date.now(),
        status: "queued",
      };
      thread.receipts[clientId] = {
        fingerprint: hash,
        nativeMessageId: nativeMessageId(),
        status: "prepared",
        message,
      };
      thread.queue.push(message);
      if (input.draftUpdatedAt !== undefined && input.draftUpdatedAt === thread.draft?.updatedAt)
        thread.draft = blankDraft();
      if (
        input.projectDraft &&
        input.projectDraft.projectId === thread.summary.projectId &&
        this.data.projectDrafts[input.projectDraft.projectId]?.updatedAt ===
          input.projectDraft.updatedAt
      )
        this.data.projectDrafts[input.projectDraft.projectId] = blankDraft();
      await this.save();
      this.publish({ type: "queue.changed", threadId: id, messages: thread.queue });
      this.changed(id);
      if (!queued) await this.dispatch(id, message.id);
      else this.queuePump(id);
      return message;
    });
  }
  private async dispatch(id: string, messageId: string) {
    const thread = this.thread(id);
    const receipt = thread.receipts[messageId]!;
    if (
      !receipt ||
      receipt.status !== "prepared" ||
      this.nativeDispatch.has(id) ||
      !this.ready ||
      !this.accepting ||
      this.syncing ||
      !thread.queue.some((message) => message.id === messageId) ||
      [...this.requests.values()].some((request) => request.threadId === id)
    )
      return;
    this.nativeDispatch.add(id);
    let nativePromptStarted = false;
    receipt.status = "sending";
    receipt.message.status = "dispatching";
    try {
      await this.save();
      const selected =
        thread.summary.settings.model ||
        this.models.find((m) => m.isDefault)?.id ||
        this.models[0]?.id;
      if (!selected || !selected.startsWith("openrouter/")) {
        receipt.status = "prepared";
        receipt.message.status = "queued";
        receipt.message.deliveryError = {
          message: "Choose an OpenRouter model before sending.",
          retryable: true,
        };
        await this.save();
        return;
      }
      const workflow = await this.workflowHooks.beforeDispatch?.(id, {
        input: receipt.message.text,
        ...receipt.message,
      });
      if (workflow?.cancelled) {
        receipt.status = "prepared";
        receipt.message.status = "queued";
        receipt.message.deliveryError = {
          message: "The automatic continuation was cancelled before native admission.",
          retryable: false,
        };
        thread.queue = thread.queue.filter((message) => message.id !== messageId);
        await this.save();
        return;
      }
      // Replace the complete current policy at admission, including removals of
      // old workflow exclusions (for example after attaching a browser).
      await this.applySessionPermissions(id, workflow?.tools ?? {});
      await this.attachments.validate(id, receipt.message.files ?? []);
      if (
        (receipt.message.images?.length ||
          receipt.message.files?.some((file) => file.mediaType.startsWith("image/"))) &&
        !this.nativeModelCapabilities.get(selected)?.images
      )
        throw new AppError("validation_failed", "The selected model does not support image input");
      const fileImages = [];
      for (const file of receipt.message.files ?? [])
        if (file.mediaType.startsWith("image/"))
          fileImages.push(await this.attachments.imageDataUrl(id, file));
      const parts: unknown[] = [];
      const expanded = await expandSkill(this, id, receipt.message.text);
      const skillPrefix =
        expanded === receipt.message.text
          ? ""
          : expanded.slice(0, expanded.length - receipt.message.text.length);
      const content = appendAttachmentContext(
        skillPrefix + serializePastedMessage(receipt.message.text, receipt.message),
        (receipt.message.files ?? []).filter((file) => !file.mediaType.startsWith("image/")),
      );
      if (content) parts.push({ type: "text", text: content });
      for (const image of [...(receipt.message.images ?? []), ...fileImages])
        parts.push({ type: "file", mime: /^data:([^;]+);/.exec(image)![1], url: image });
      // Establish local admission before the HTTP call. Native idle/error events
      // may arrive before its 204 acknowledgement and remain authoritative.
      this.busy.add(id);
      thread.summary.currentTurnId = receipt.nativeMessageId;
      thread.summary.updatedAt = Date.now();
      delete thread.outcome;
      nativePromptStarted = true;
      await this.native.request("POST", `/session/${encodeURIComponent(id)}/prompt_async`, {
        directory: thread.summary.cwd,
        body: {
          messageID: receipt.nativeMessageId,
          model: { providerID: "openrouter", modelID: selected.slice("openrouter/".length) },
          agent:
            workflow?.agent ??
            this.workflowHooks.collaborationAgent?.(thread.summary.settings.collaborationMode) ??
            "build",
          ...(workflow?.system ? { system: workflow.system } : {}),
          ...(thread.summary.settings.reasoningEffort
            ? { variant: thread.summary.settings.reasoningEffort }
            : {}),
          parts,
        },
      });
      receipt.status = "accepted";
      thread.queue = thread.queue.filter((m) => m.id !== messageId);
      await this.save();
    } catch (error) {
      receipt.status = nativePromptStarted ? "uncertain" : "prepared";
      if (!nativePromptStarted) receipt.message.status = "queued";
      receipt.message.deliveryError = {
        message:
          !nativePromptStarted && error instanceof AppError
            ? error.message
            : nativePromptStarted
              ? "Native delivery could not be confirmed. Refresh history; this message will not be sent again automatically."
              : "The message could not be prepared. Correct the settings and send it again.",
        retryable: !nativePromptStarted,
      };
      if (nativePromptStarted || !(error instanceof AppError)) this.ready = false;
      await this.save();
    } finally {
      this.nativeDispatch.delete(id);
      if (this.idleAfterDispatch.delete(id)) {
        const canonical = this.terminalRefreshes.get(id) ?? Promise.resolve();
        void canonical
          .then(() =>
            !this.closed && !this.isBusy(id) ? this.workflowHooks.onIdle?.(id) : undefined,
          )
          .catch(() => this.emit("storageError"));
      }
      this.publish({ type: "queue.changed", threadId: id, messages: thread.queue });
      this.changed(id);
      this.queuePump(id);
    }
  }
  async sendQueued(id: string, messageId: string) {
    return this.serial(async () => {
      this.requireReady();
      const thread = this.thread(id),
        receipt = thread.receipts[messageId];
      if (!receipt || !thread.queue.some((message) => message.id === messageId))
        throw new AppError("not_found", "Queued message not found", 404);
      if (receipt.status === "uncertain" || receipt.status === "sending") {
        await this.refreshThread(id);
        if (thread.receipts[messageId]?.status === "accepted")
          return { turnId: receipt.nativeMessageId, thread: this.summary(id) };
        throw new AppError(
          "conflict",
          "Native acceptance is uncertain. This message cannot be automatically resent.",
          409,
        );
      }
      delete receipt.message.deliveryError;
      receipt.message.deliveryMode = "steer";
      await this.save();
      await this.dispatch(id, messageId);
      return { turnId: thread.summary.currentTurnId, thread: this.summary(id) };
    });
  }
  async updateQueued(id: string, messageId: string, body: Record<string, any>) {
    const thread = this.thread(id),
      receipt = thread.receipts[messageId];
    if (
      !receipt ||
      receipt.status !== "prepared" ||
      !thread.queue.some((message) => message.id === messageId)
    )
      throw new AppError("conflict", "This message has already been dispatched", 409);
    const input = text(body.input);
    if (
      !validPastedText(body, input) ||
      (!input.trim() && !receipt.message.images?.length && !receipt.message.files?.length)
    )
      throw new AppError("validation_failed", "Enter a message");
    receipt.message.text = input;
    delete receipt.message.inlinePastes;
    delete receipt.message.pasteBlocks;
    Object.assign(receipt.message, pastedText(body));
    delete receipt.message.deliveryError;
    receipt.fingerprint = fingerprint({
      input,
      ...pastedText(receipt.message),
      images: receipt.message.images ?? [],
      files: receipt.message.files ?? [],
      goal: receipt.message.goal === true,
      planImplementationMode: receipt.message.planImplementationMode ?? null,
    });
    await this.save();
    this.publish({ type: "queue.changed", threadId: id, messages: thread.queue });
    return receipt.message;
  }
  private async pump(id: string) {
    if (
      !this.ready ||
      !this.accepting ||
      this.syncing ||
      this.busy.has(id) ||
      this.nativeDispatch.has(id) ||
      [...this.requests.values()].some((r) => r.threadId === id)
    )
      return;
    const next = this.thread(id).queue[0];
    if (!next || next.deliveryError || next.status !== "queued") return;
    await this.serial(async () => {
      if (!this.busy.has(id) && this.ready && this.accepting && !this.syncing)
        await this.dispatch(id, next.id);
    });
  }
  private queuePump(id: string) {
    void this.pump(id).catch(() => {
      this.ready = false;
      this.emit("storageError");
      this.publish({ type: "connection.changed", connection: this.connection() });
    });
  }
  private refreshAtIdle(id: string) {
    if (this.terminalRefreshes.has(id) || this.closed) return;
    const pending = Promise.resolve()
      .then(async () => {
        await this.refreshThread(id);
        this.snapshotParts.delete(id);
        this.flush(id);
        if (this.nativeDispatch.has(id)) this.idleAfterDispatch.add(id);
        else await this.workflowHooks.onIdle?.(id);
      })
      .catch(() => {
        this.ready = false;
        this.publish({ type: "connection.changed", connection: this.connection() });
      })
      .finally(() => {
        this.terminalRefreshes.delete(id);
      });
    this.terminalRefreshes.set(id, pending);
  }
  async interrupt(id: string) {
    this.requireReady();
    const thread = this.thread(id);
    await this.workflowHooks.onInterrupted?.(id);
    await this.native.request("POST", `/session/${encodeURIComponent(id)}/abort`, {
      directory: thread.summary.cwd,
    });
    thread.outcome = "interrupted";
    this.busy.delete(id);
    thread.summary.currentTurnId = null;
    await this.save();
    this.changed(id);
  }
  async compact(id: string) {
    const selected = await this.serial(async () => {
      this.requireReady();
      if (this.isBusy(id))
        throw new AppError("conflict", "Finish active work before compressing context", 409);
      const thread = this.thread(id),
        model =
          thread.summary.settings.model ||
          this.models.find((candidate) => candidate.isDefault)?.id ||
          this.models[0]?.id;
      if (!model?.startsWith("openrouter/"))
        throw new AppError("validation_failed", "Choose an OpenRouter model");
      this.busy.add(id);
      thread.summary.currentTurnId = `compact:${randomUUID()}`;
      delete thread.outcome;
      await this.save();
      this.changed(id);
      return { model, directory: thread.summary.cwd };
    });
    try {
      await this.native.request("POST", `/session/${encodeURIComponent(id)}/summarize`, {
        directory: selected.directory,
        body: {
          providerID: "openrouter",
          modelID: selected.model.slice("openrouter/".length),
          auto: false,
        },
        timeoutMs: 120_000,
      });
    } catch (error) {
      this.ready = false;
      this.publish({ type: "connection.changed", connection: this.connection() });
      throw error;
    }
    await this.refreshThread(id);
    return { compacted: true };
  }
  async settings(id: string, body: Record<string, any>) {
    return this.serial(async () => {
      const thread = this.thread(id);
      if (this.busy.has(id) || this.nativeDispatch.has(id))
        throw new AppError("conflict", "Finish active work before changing the model", 409);
      if (
        body.collaborationMode !== undefined &&
        (!["default", "plan", "team"].includes(body.collaborationMode) ||
          (body.collaborationMode !== "default" && !this.workflowHooks.collaborationAgent))
      )
        throw new AppError(
          "validation_failed",
          "Plan and Team adaptation is not implemented in this backend stage",
        );
      if (
        body.model !== undefined &&
        body.model !== null &&
        !this.models.some((model) => model.id === body.model)
      )
        throw new AppError("validation_failed", "Unknown model");
      const next: SessionSettings = { ...thread.summary.settings };
      if (body.collaborationMode !== undefined) next.collaborationMode = body.collaborationMode;
      for (const key of ["model", "reasoningEffort"] as const) {
        if (body[key] === null) delete next[key];
        else if (body[key] !== undefined) next[key] = text(body[key], key, 500);
      }
      const model = this.models.find((m) => m.id === next.model);
      if (
        next.reasoningEffort &&
        !model?.reasoningEfforts.some((variant) => variant.value === next.reasoningEffort)
      )
        throw new AppError("validation_failed", "Unknown model variant");
      if (body.serviceTier || body.personality)
        throw new AppError("validation_failed", "This provider does not advertise that setting");
      thread.summary.settings = next;
      await this.save();
      this.changed(id);
      return this.summary(id);
    });
  }
  async patchThread(id: string, patch: Record<string, any>) {
    return this.serial(async () => {
      const thread = this.thread(id);
      if (patch.name !== undefined || patch.title !== undefined) {
        const title = text(patch.title ?? patch.name, "title", 500);
        await this.native.request("PATCH", `/session/${encodeURIComponent(id)}`, {
          directory: thread.summary.cwd,
          body: { title },
        });
        thread.summary.title = title;
      }
      for (const key of ["pinned", "archived"] as const)
        if (typeof patch[key] === "boolean") thread.summary[key] = patch[key];
      if (patch.projectId !== undefined) {
        if (patch.projectId !== null) this.project(patch.projectId);
        thread.summary.projectId = patch.projectId;
      }
      await this.save();
      this.changed(id);
      return this.summary(id);
    });
  }
  async fork(id: string, messageId?: string, expectedLastMessageId?: string) {
    return this.serial(async () => {
      this.requireReady();
      if (this.busy.has(id))
        throw new AppError("conflict", "Finish active work before forking", 409);
      const source = this.thread(id);
      const original = await this.native.request<NativeMessage[]>(
        "GET",
        `/session/${encodeURIComponent(id)}/message`,
        { directory: source.summary.cwd },
      );
      if (expectedLastMessageId && original.at(-1)?.info.id !== expectedLastMessageId)
        throw new AppError(
          "conflict",
          "Source history changed before branching. Select the final answer again.",
          409,
        );
      const session = await this.native.request<NativeSession>(
        "POST",
        `/session/${encodeURIComponent(id)}/fork`,
        { directory: source.summary.cwd, body: messageId ? { messageID: messageId } : {} },
      );
      this.importSession(session, source.summary.cwd);
      this.thread(session.id).summary.settings = { ...source.summary.settings };
      this.thread(session.id).summary.relation = {
        kind: "session",
        sessionId: session.id,
        forkedFromId: id,
      };
      // Native fork renumbers messages and parts. Preserve the original ingress
      // presentation (pastes/attachments) by matching the copied prefix order.
      const copied = await this.native.request<NativeMessage[]>(
        "GET",
        `/session/${encodeURIComponent(session.id)}/message`,
        { directory: source.summary.cwd },
      );
      this.live.set(session.id, copied);
      // Native fork copies assistant messages with their billed cost intact. Treat that copied
      // prefix as a baseline so the new session starts at zero.
      const forkThread = this.thread(session.id);
      const copiedCost = copied.reduce((sum, message) => {
        if (message.info.role !== "assistant") return sum;
        return sum + (finiteAmount(message.info.cost) ?? 0);
      }, 0);
      forkThread.costBaselineUsd = Math.max(copiedCost, finiteAmount(session.cost) ?? 0);
      forkThread.costHighWaterUsd = 0;
      forkThread.nativeCostUsd = forkThread.costBaselineUsd;
      forkThread.parentThreadId = undefined;
      this.directCosts.delete(session.id);
      this.refreshCost(session.id);
      for (let index = 0; index < copied.length; index++) {
        const before = original[index],
          after = copied[index];
        if (!before || !after || before.info.role !== "user" || after.info.role !== "user")
          continue;
        const receipt = Object.values(source.receipts).find(
          (candidate) => candidate.nativeMessageId === before.info.id,
        );
        if (receipt)
          this.thread(session.id).receipts[`fork-history:${before.info.id}`] = {
            ...structuredClone(receipt),
            status: "accepted",
            nativeMessageId: after.info.id,
            message: { ...structuredClone(receipt.message), threadId: session.id },
          };
      }
      await this.save();
      this.changed(session.id);
      return this.summary(session.id);
    });
  }
  async prepareRestart(targetRuntime?: "claude") {
    const checkpoint = async () => {
      this.accepting = false;
      await this.save();
      const pendingWorkCount = Object.values(this.data.threads).reduce(
        (count, thread) => count + thread.queue.length,
        this.requests.size,
      );
      return {
        ready: true,
        supportedRunnerProtocols: [1],
        activeTurnCount: this.busy.size,
        pendingWorkCount,
      };
    };
    if (targetRuntime === "claude") return this.withIdleNative(checkpoint);
    this.accepting = false;
    await this.operationTail;
    return checkpoint();
  }
  resumeAccepting() {
    this.accepting = true;
    for (const id of Object.keys(this.data.threads)) this.queuePump(id);
  }
  async close() {
    this.closed = true;
    this.accepting = false;
    this.controller.abort();
    await this.streamTask;
    await this.relayTask;
    await this.operationTail;
    await Promise.allSettled([...this.terminalRefreshes.values()]);
    await this.saveTail;
    // OpenCode belongs to a separate native service and deliberately survives this API.
  }

  private displayedDirectCost(id: string): {
    usd: number;
    estimated: boolean;
    hasUsage: boolean;
  } {
    const raw = this.messageCost(id);
    const baseline = this.data.threads[id]?.costBaselineUsd ?? 0;
    return { ...raw, usd: Math.max(0, raw.usd - baseline) };
  }

  /** Cost of the thread's own assistant messages, or the native session total as a fallback. */
  private messageCost(id: string): { usd: number; estimated: boolean; hasUsage: boolean } {
    const messages = this.live.get(id);
    if (messages) {
      let usd = 0;
      let estimated = false;
      let hasUsage = false;
      for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const billed = finiteAmount(message.info.cost);
        if (billed !== null) {
          usd += billed;
          hasUsage = true;
          continue;
        }
        const stepCosts = message.parts
          .map((part) => (part.type === "step-finish" ? finiteAmount(part.cost) : null))
          .filter((cost): cost is number => cost !== null);
        if (stepCosts.length) {
          usd += stepCosts.reduce((sum, cost) => sum + cost, 0);
          hasUsage = true;
          continue;
        }
        if (!message.info.tokens) continue;
        hasUsage = true;
        const price = this.modelPrice(message.info.modelID);
        if (!price) {
          estimated = true;
          continue;
        }
        usd += estimateTokensCost(message.info.tokens, price);
        estimated = true;
      }
      if (hasUsage) return { usd, estimated, hasUsage };
    }
    const native = finiteAmount(this.data.threads[id]?.nativeCostUsd);
    if (native !== null) return { usd: native, estimated: false, hasUsage: true };
    return { usd: 0, estimated: false, hasUsage: false };
  }

  private modelPrice(modelID: string | undefined) {
    if (!modelID) return null;
    return (
      this.modelPrices.get(modelID) ??
      this.modelPrices.get(`openrouter/${modelID}`) ??
      (modelID.startsWith("openrouter/")
        ? (this.modelPrices.get(modelID.slice("openrouter/".length)) ?? null)
        : null)
    );
  }

  /** Refreshes one thread's monotonic direct cost and reports whether it changed. */
  private refreshDirectCost(id: string): boolean {
    const thread = this.data.threads[id];
    if (!thread) return false;
    const direct = this.displayedDirectCost(id);
    const previous = this.directCosts.get(id);
    let raised = false;
    if (direct.hasUsage && direct.usd > (thread.costHighWaterUsd ?? 0)) {
      thread.costHighWaterUsd = direct.usd;
      raised = true;
    }
    if (direct.hasUsage && !thread.costUsageSeen) {
      thread.costUsageSeen = true;
      raised = true;
    }
    const hasUsage = direct.hasUsage || thread.costUsageSeen === true;
    const usd = Math.max(thread.costHighWaterUsd ?? 0, direct.usd);
    const next = { usd, estimated: direct.estimated, hasUsage };
    const changed =
      !previous ||
      previous.usd !== next.usd ||
      previous.estimated !== next.estimated ||
      previous.hasUsage !== next.hasUsage;
    this.directCosts.set(id, next);
    if (raised) this.persistCostsSoon();
    return changed;
  }

  private persistCostsSoon() {
    const now = Date.now();
    if (now - this.costSaveAt < 5_000) return;
    this.costSaveAt = now;
    void this.save().catch(() => undefined);
  }

  private costAncestors(id: string): string[] {
    const ancestors: string[] = [];
    const seen = new Set([id]);
    let parent = this.data.threads[id]?.parentThreadId;
    while (parent && !seen.has(parent) && this.data.threads[parent]) {
      ancestors.push(parent);
      seen.add(parent);
      parent = this.data.threads[parent]!.parentThreadId;
    }
    return ancestors;
  }

  /** Recomputes a thread's cost and republishes every ancestor whose subtree total may move. */
  private refreshCost(id: string) {
    if (!this.data.threads[id]) return;
    this.refreshDirectCost(id);
    for (const ancestor of this.costAncestors(id)) {
      this.refreshDirectCost(ancestor);
      this.changed(ancestor);
    }
  }

  private subtreeCost(
    id: string,
    seen = new Set<string>(),
  ): { usd: number; estimated: boolean; hasUsage: boolean } {
    if (seen.has(id)) return { usd: 0, estimated: false, hasUsage: false };
    seen.add(id);
    if (!this.directCosts.has(id)) this.refreshDirectCost(id);
    const own = this.directCosts.get(id) ?? {
      usd: 0,
      estimated: false,
      hasUsage: false,
    };
    let usd = own.hasUsage ? own.usd : 0;
    let estimated = own.estimated;
    let hasUsage = own.hasUsage;
    for (const child of Object.values(this.data.threads)) {
      if (child.parentThreadId !== id) continue;
      const cost = this.subtreeCost(child.summary.id, seen);
      usd += cost.usd;
      estimated ||= cost.estimated;
      hasUsage ||= cost.hasUsage;
    }
    return { usd, estimated, hasUsage };
  }

  private costUsage(id: string): ThreadSummary["costUsage"] {
    const cost = this.subtreeCost(id);
    return cost.hasUsage ? { usd: cost.usd, estimated: cost.estimated } : undefined;
  }
}

function finiteAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Native `/provider` reports USD per one million tokens in snake_case. */
function parseModelPrice(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cost = value as Record<string, unknown>;
  const cache =
    cost.cache && typeof cost.cache === "object" ? (cost.cache as Record<string, unknown>) : {};
  const price = {
    input: finiteAmount(cost.input) ?? 0,
    output: finiteAmount(cost.output) ?? 0,
    cacheRead: finiteAmount(cache.read ?? cost.cache_read) ?? 0,
    cacheWrite: finiteAmount(cache.write ?? cost.cache_write) ?? 0,
  };
  return Object.values(price).some((rate) => rate > 0) ? price : null;
}

function estimateTokensCost(
  tokens: NativeTokens,
  price: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const amount = (value: unknown) => finiteAmount(value) ?? 0;
  const cacheRead = amount(tokens.cache?.read);
  const cacheWrite = amount(tokens.cache?.write);
  const reasoning = amount(tokens.reasoning);
  const input = Math.max(0, amount(tokens.input) - cacheRead - cacheWrite);
  const output = Math.max(0, amount(tokens.output) - reasoning);
  return (
    (input * price.input +
      output * price.output +
      cacheRead * price.cacheRead +
      cacheWrite * price.cacheWrite +
      reasoning * price.output) /
    1_000_000
  );
}
