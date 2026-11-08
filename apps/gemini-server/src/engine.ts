import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  ActivityItem,
  AppCapabilities,
  AppSnapshot,
  AttentionRequest,
  AttentionResponse,
  BrowserThreadStatus,
  ModelOption,
  Project,
  QueuedMessage,
  QueueMessageRequest,
  ServerEvent,
  SessionSettings,
  TaskDefaults,
  ThreadDetail,
  ThreadDraft,
  ThreadSummary,
  UiLanguage,
  UserInputDraft,
} from "@codexnest/protocol";
import { pastedText, serializePastedMessage, validPastedText } from "@codexnest/protocol";
import { readJson, writeJsonAtomic } from "../../claude-server/src/io";
import { AttachmentStore } from "../../claude-server/src/attachments";
import { Account } from "./account";
import { AcpClient, RpcError } from "./acp";
import type { StoredArtifactRecord } from "./artifacts";
import type { Config } from "./config";
import {
  geminiReplyCheck,
  geminiTitleGenerator,
  type ReplyCheck,
  type TitleGenerator,
} from "./title";
import type { StoredVoice, VoiceSettings, VoiceTimingSample } from "./voice";

export const capabilities: AppCapabilities = {
  codexManagement: false,
  rateLimits: false,
  plan: false,
  team: false,
  goal: false,
  forks: false,
  browserIntegration: true,
  fullTextSearch: true,
  sessionApprovalGrants: true,
  skills: true,
  gitChanges: true,
  artifacts: true,
  appUpdates: true,
  reasoningEffort: true,
};

export interface BrowserBindingState {
  bindingId: string;
  instanceId: string;
  attachedAt: number;
  detachedAt?: number;
}

export type StoredThread = {
  detail: ThreadDetail;
  nativeId?: string;
  receipts: Record<string, { fingerprint: string; message: QueuedMessage }>;
  options?: any[];
  defaults?: Pick<SessionSettings, "model" | "reasoningEffort">;
  browserEnabled?: boolean;
  browserBinding?: BrowserBindingState;
  artifacts?: StoredArtifactRecord[];
  customTitle?: boolean;
};
type State = {
  version: 1;
  projects: Project[];
  threads: Record<string, StoredThread>;
  creations: Record<string, string>;
  projectDrafts: Record<string, ThreadDraft>;
  models: ModelOption[];
  taskDefaults: TaskDefaults;
  language: UiLanguage;
  uiLanguage: UiLanguage;
  permission: "ask" | "full-access";
  permissionVersion: number;
  voice?: Record<string, StoredVoice>;
  voiceUploads?: Record<string, string>;
  voiceSettings?: Partial<VoiceSettings>;
  voiceTimings?: Record<string, VoiceTimingSample[]>;
  skillOverrides?: Record<string, boolean>;
  userInputDrafts?: Record<string, UserInputDraft>;
};
const initial = (): State => ({
  version: 1,
  projects: [],
  threads: {},
  creations: {},
  projectDrafts: {},
  models: [],
  taskDefaults: {},
  language: "ru",
  uiLanguage: "ru",
  permission: "ask",
  permissionVersion: 1,
  voice: {},
  voiceUploads: {},
  voiceTimings: {},
  skillOverrides: {},
  userInputDrafts: {},
});
const blankProgress = () => ({
  startedAt: null,
  explanation: null,
  steps: [],
  filesChanged: 0,
  additions: 0,
  deletions: 0,
});
export const blankDraft = (): ThreadDraft => ({
  input: "",
  images: [],
  annotations: [],
  goalMode: false,
  updatedAt: Date.now(),
});
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const KNOWN_ERROR_CODES = new Set([
  "invalid_request",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "draft_conflict",
  "unavailable",
  "timeout",
  "failed",
  "internal_error",
]);
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(
    first: string,
    second: number | string = 400,
    third: string | number = "validation_failed",
  ) {
    if (typeof second === "string" && KNOWN_ERROR_CODES.has(first)) {
      super(second);
      this.code = first;
      this.statusCode =
        typeof third === "number"
          ? third
          : first === "not_found"
            ? 404
            : first === "conflict" || first === "draft_conflict"
              ? 409
              : first === "forbidden"
                ? 403
                : first === "unauthorized"
                  ? 401
                  : first === "unavailable"
                    ? 503
                    : 400;
    } else {
      super(first);
      this.statusCode = typeof second === "number" ? second : 400;
      this.code = typeof third === "string" ? third : "validation_failed";
    }
  }
}
export const object = (value: any): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("Invalid object");
  return value;
};
export function text(value: any, name = "input", limit = 200_000): string {
  if (typeof value !== "string" || value.length > limit) throw new AppError(`Invalid ${name}`);
  return value;
}

export interface EngineOptions {
  generateTitle?: TitleGenerator;
  checkReply?: ReplyCheck;
}

/** The daemon owns ACP and durable admissions. The HTTP gateway can restart independently. */
export class Engine extends EventEmitter {
  data = initial();
  readonly instanceId = randomUUID();
  sequence = 0;
  accepting: boolean;
  readonly account: Account;
  readonly attachments: AttachmentStore;
  generateTitle?: TitleGenerator;
  checkReply?: ReplyCheck;
  private browserStatusProvider?: (threadId: string) => BrowserThreadStatus;
  private browserMcpProvider?: (threadId: string) => Array<Record<string, unknown>>;
  private client?: AcpClient;
  private starting?: Promise<AcpClient>;
  private connection?: Awaited<ReturnType<Account["connection"]>>;
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private admissions = new Map<string, Promise<QueuedMessage>>();
  private creations = new Map<
    string,
    Promise<{ thread: ThreadSummary; draft: ThreadDraft | null }>
  >();
  private settingThreads = new Set<string>();
  private changingConnection = false;
  private closing = false;
  private outcomes = new Map<string, { status: "failed" | "interrupted"; error?: string }>();
  private replaying = new Set<string>();
  private writing: Promise<unknown> = Promise.resolve();
  private timers = new Map<string, NodeJS.Timeout>();
  private active = new Map<string, number>();
  private requests = new Map<
    string,
    { attention: AttentionRequest; params: any; resolve: (response: any) => void }
  >();
  private tools = new Map<string, any>();

  constructor(
    readonly config: Config,
    private readonly clientFactory = (env: NodeJS.ProcessEnv) => new AcpClient(config, env),
    options: EngineOptions = {},
  ) {
    super();
    this.accepting = !config.startPaused;
    this.account = new Account(config, () => this.emit("account"));
    this.attachments = new AttachmentStore(join(config.stateDir, "attachments"));
    const resolveEnv = async () => {
      if (!this.account.status().authenticated) return null;
      return this.connection?.env ?? process.env;
    };
    const isTestFake = config.agyBin === "/bin/true";
    this.generateTitle =
      options.generateTitle ??
      (isTestFake ? undefined : geminiTitleGenerator({ config, resolveEnv }));
    this.checkReply =
      options.checkReply ?? (isTestFake ? undefined : geminiReplyCheck({ config, resolveEnv }));
  }

  async initialize() {
    const saved = await readJson<State>(join(this.config.stateDir, "state.json"));
    if (saved && saved.version !== 1) throw new Error("Unsupported GeminiNest state version");
    if (saved) {
      const lang = saved.language ?? saved.uiLanguage ?? "ru";
      this.data = {
        ...initial(),
        ...saved,
        language: lang,
        uiLanguage: lang,
      };
    }
    for (const thread of Object.values(this.data.threads)) {
      const summary = thread.detail.summary;
      if (summary.currentTurnId) {
        const turn = thread.detail.turns.find((turn) => turn.id === summary.currentTurnId);
        if (turn) {
          turn.status = "interrupted";
          turn.completedAt = Date.now();
        }
        summary.state = "interrupted";
        summary.currentTurnId = null;
      }
      for (const message of thread.detail.queuedMessages)
        if (message.status === "dispatching")
          message.deliveryError = {
            message: "Доставка прервана. Сообщение автоматически повторно не отправлялось.",
            retryable: false,
          };
    }
    await this.account.initialize();
  }

  get activeCount() {
    return this.active.size + this.loading.size + this.admissions.size + this.settingThreads.size;
  }
  canAcceptWork(): boolean {
    return this.accepting && !this.closing;
  }
  prepareRestart(supportedRunnerProtocols?: number[]) {
    if (
      Array.isArray(supportedRunnerProtocols) &&
      supportedRunnerProtocols.length > 0 &&
      !supportedRunnerProtocols.includes(1)
    ) {
      return {
        canRestart: false,
        reason: "protocol_incompatible",
        activeRunnerSessionIds: [...this.active.keys()],
        unsupportedSessionIds: [...this.active.keys()],
      };
    }
    this.accepting = false;
    return {
      canRestart: true,
      reason: null,
      activeRunnerSessionIds: [...this.active.keys()],
      unsupportedSessionIds: [],
    };
  }
  resumeAccepting() {
    this.accepting = true;
  }
  setBrowserStatusProvider(provider: (threadId: string) => BrowserThreadStatus) {
    this.browserStatusProvider = provider;
  }
  setBrowserMcpProvider(provider: (threadId: string) => Array<Record<string, unknown>>) {
    this.browserMcpProvider = provider;
  }
  async mutateBrowser(id: string, fn: (thread: StoredThread) => void): Promise<void> {
    const thread = this.thread(id);
    fn(thread);
    thread.detail.summary.browserStatus =
      this.browserStatusProvider?.(id) ?? (thread.browserEnabled ? "disconnected" : "disabled");
    await this.save();
  }
  resetOwner(id: string): void {
    if (!this.active.has(id)) {
      this.loaded.delete(id);
    }
  }
  async mutateVoice(
    fn: (voice: Record<string, StoredVoice>, uploads: Record<string, string>) => void,
  ): Promise<void> {
    this.data.voice ??= {};
    this.data.voiceUploads ??= {};
    fn(this.data.voice, this.data.voiceUploads);
    await this.save();
  }
  async patchThread(
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean; projectId?: string | null },
  ): Promise<ThreadSummary> {
    const thread = this.thread(id);
    const summary = thread.detail.summary;
    if (patch.title !== undefined) {
      summary.title = text(patch.title, "title", 200);
      thread.customTitle = true;
    }
    if (typeof patch.pinned === "boolean") summary.pinned = patch.pinned;
    if (typeof patch.archived === "boolean") summary.archived = patch.archived;
    if (patch.projectId !== undefined) {
      if (patch.projectId !== null) this.project(patch.projectId);
      summary.projectId = patch.projectId;
    }
    summary.updatedAt = Date.now();
    await this.save();
    this.changed(id);
    return this.summary(id);
  }
  assertIdle() {
    if (this.activeCount || this.requests.size)
      throw new AppError("Сначала дождитесь завершения задач.", 409, "conflict");
  }
  thread(id: string) {
    const result = this.data.threads[id];
    if (!result) throw new AppError("Сессия не найдена.", 404, "not_found");
    return result;
  }
  summary(id: string): ThreadSummary {
    const thread = this.thread(id);
    thread.detail.summary.browserStatus =
      this.browserStatusProvider?.(id) ?? (thread.browserEnabled ? "disconnected" : "disabled");
    return thread.detail.summary;
  }
  project(id: string) {
    const result = this.data.projects.find((project) => project.id === id);
    if (!result) throw new AppError("Проект не найден.", 404, "not_found");
    return result;
  }
  detail(id: string): ThreadDetail {
    const thread = this.thread(id);
    thread.detail.summary.browserStatus =
      this.browserStatusProvider?.(id) ?? (thread.browserEnabled ? "disconnected" : "disabled");
    return {
      ...thread.detail,
      version: { instanceId: this.instanceId, sequence: this.sequence },
    };
  }
  snapshot(): AppSnapshot {
    const voiceTranscriptions = Object.values(this.data.voice ?? {})
      .filter((record) => !record.cancelled && !record.applied)
      .map((record) => structuredClone(record.job))
      .sort((a, b) => a.createdAt - b.createdAt);
    return {
      provider: "gemini",
      capabilities,
      instanceId: this.instanceId,
      sequence: this.sequence,
      uiLanguage: this.data.language,
      connection: {
        state: this.accepting ? "ready" : "starting",
        message: this.accepting ? null : "GeminiNest перезапускается",
        syncedAt: new Date().toISOString(),
      },
      permissionSettings: this.permissions(),
      projects: this.data.projects,
      threads: Object.keys(this.data.threads).map((id) => this.summary(id)),
      attention: [...this.requests.values()].map((r) => ({
        ...r.attention,
        ...(r.attention.kind === "userInput" && this.data.userInputDrafts?.[r.attention.id]
          ? { draft: this.data.userInputDrafts[r.attention.id] }
          : {}),
      })),
      models: this.data.models,
      taskDefaults: this.data.taskDefaults,
      forkOperations: [],
      voiceTranscriptions,
    };
  }
  permissions() {
    return {
      preset: this.data.permission,
      version: String(this.data.permissionVersion),
      overridden: false,
      message: null,
    };
  }
  publish(event: ServerEvent) {
    this.emit("frame", {
      type: "event",
      version: { instanceId: this.instanceId, sequence: this.sequence + 1 },
      sequence: ++this.sequence,
      event,
    });
  }
  changed(id: string) {
    const thread = this.thread(id);
    const detail = thread.detail;
    detail.summary.browserStatus =
      this.browserStatusProvider?.(id) ?? (thread.browserEnabled ? "disconnected" : "disabled");
    detail.summary.queuedMessageCount = detail.queuedMessages.filter(
      (m) => m.deliveryMode !== "steer",
    ).length;
    this.publish({ type: "thread.upserted", thread: detail.summary });
    const turn = detail.turns.at(-1);
    if (turn) this.publish({ type: "turn.replaced", threadId: id, turn });
    this.publish({ type: "queue.changed", threadId: id, messages: detail.queuedMessages });
  }
  private schedule(id: string) {
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.changed(id);
        void this.save().catch(() => this.emit("storageError"));
      }, 100),
    );
  }
  save(): Promise<void> {
    this.data.uiLanguage = this.data.language;
    const snapshot = structuredClone(this.data);
    const task = this.writing
      .catch(() => undefined)
      .then(() => writeJsonAtomic(join(this.config.stateDir, "state.json"), snapshot));
    this.writing = task;
    return task;
  }

  async addProject(path: string, displayName?: string) {
    const cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory()) throw new AppError("Выберите каталог проекта.");
    const existing = this.data.projects.find((p) => p.path === cwd);
    if (existing) return existing;
    const time = new Date().toISOString();
    const project = {
      id: randomUUID(),
      path: cwd,
      displayName: displayName?.trim() || basename(cwd),
      createdAt: time,
      updatedAt: time,
    };
    this.data.projects.push(project);
    await this.save();
    this.publish({ type: "project.upserted", project });
    return project;
  }

  createThread(
    projectId: string,
    clientId: string,
    draft?: ThreadDraft,
    options?: { cwd?: string; title?: string; model?: string },
  ) {
    const key = `${projectId}:${clientId}`;
    const pending = this.creations.get(key);
    if (pending) return pending;
    const task = this.createThreadOnce(projectId, clientId, draft, options).finally(() =>
      this.creations.delete(key),
    );
    this.creations.set(key, task);
    return task;
  }

  private async createThreadOnce(
    projectId: string,
    clientId: string,
    draft?: ThreadDraft,
    options?: { cwd?: string; title?: string; model?: string },
  ) {
    const key = `${projectId}:${clientId}`;
    const existing = this.data.creations[key];
    if (existing)
      return {
        thread: this.summary(existing),
        draft: this.thread(existing).detail.draft ?? null,
      };
    const project = this.project(projectId);
    const id = randomUUID();
    if (draft?.files?.length) {
      const files = await this.attachments.validate(projectId, draft.files);
      try {
        const copied = [];
        for (const file of files)
          copied.push(
            await this.attachments.save(
              id,
              file.name,
              file.mediaType,
              createReadStream(file.path),
              file.size,
            ),
          );
        draft = { ...draft, files: copied };
      } catch (error) {
        await this.attachments.removeThread(id);
        throw error;
      }
    }
    const now = Date.now();
    const customTitle = Boolean(options?.title?.trim());
    const summary: ThreadSummary = {
      id,
      projectId,
      title: options?.title?.trim().slice(0, 200) || "Новая сессия",
      preview: "",
      cwd: options?.cwd || project.path,
      state: "idle",
      unread: false,
      unseen: false,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      currentTurnId: null,
      queuedMessageCount: 0,
      browserStatus: "disabled",
      settings: {
        collaborationMode: "default",
        ...this.data.taskDefaults,
        ...(options?.model ? { model: options.model } : {}),
      },
      relation: { kind: "session", sessionId: id },
      canAcceptDirectInput: true,
    };
    this.data.threads[id] = {
      detail: {
        summary,
        turns: [],
        queuedMessages: [],
        olderTurnsCursor: null,
        draft: draft ?? null,
      },
      receipts: {},
      ...(customTitle ? { customTitle: true } : {}),
    };
    this.data.creations[key] = id;
    await this.save();
    this.changed(id);
    return { thread: summary, draft: draft ?? null };
  }

  async resetConnection() {
    this.assertIdle();
    this.client?.close();
    this.client = undefined;
    this.loaded.clear();
    await this.connection?.close();
    this.connection = undefined;
  }

  async reconfigure<T>(action: () => Promise<T>): Promise<T> {
    if (this.changingConnection)
      throw new AppError("Настройки подключения уже изменяются.", 409, "conflict");
    this.assertIdle();
    this.changingConnection = true;
    try {
      await this.resetConnection();
      return await action();
    } finally {
      this.changingConnection = false;
    }
  }

  private async getClient() {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!this.account.status().authenticated)
        throw new AppError("Войдите в Google в настройках Gemini.", 409, "conflict");
      const connection = await this.account.connection();
      this.connection = connection;
      const client = this.clientFactory(connection.env);
      client.onRequest = (method, params) => this.request(method, params);
      client.on("notification", (method: string, params: any) => {
        if (method === "session/update") this.update(params);
      });
      client.once("disconnected", () => {
        if (this.client === client) this.client = undefined;
        if (this.connection === connection) this.connection = undefined;
        void connection.close().catch(() => undefined);
        this.loaded.clear();
        for (const id of this.active.keys())
          this.finish(
            id,
            "interrupted",
            "Соединение с Antigravity прервано. Задача автоматически не перезапускалась.",
          );
        for (const [key, request] of this.requests) {
          request.resolve(
            request.attention.kind === "elicitation"
              ? { action: "cancel" }
              : { outcome: { outcome: "cancelled" } },
          );
          this.requests.delete(key);
          this.publish({ type: "attention.removed", attentionId: key });
        }
      });
      try {
        await client.start();
        this.client = client;
        return client;
      } catch (error) {
        client.close();
        await connection.close();
        if (this.connection === connection) this.connection = undefined;
        throw error;
      }
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async load(id: string) {
    if (this.loaded.has(id)) return;
    if (this.loading.has(id)) return this.loading.get(id)!;
    const task = (async () => {
      const thread = this.thread(id);
      const client = await this.getClient();
      const mcpServers = this.browserMcpProvider?.(id) ?? [];
      let result: any;
      if (thread.nativeId) {
        this.replaying.add(thread.nativeId);
        try {
          result = await client.request(
            "session/load",
            { sessionId: thread.nativeId, cwd: thread.detail.summary.cwd, mcpServers },
            90_000,
          );
        } finally {
          this.replaying.delete(thread.nativeId);
        }
      } else {
        result = await client.request(
          "session/new",
          { cwd: thread.detail.summary.cwd, mcpServers },
          90_000,
        );
        if (typeof result.sessionId !== "string")
          throw new Error("Antigravity did not return a session ID");
        thread.nativeId = result.sessionId;
      }
      this.configure(thread, result);
      this.loaded.add(id);
      await this.save();
    })().finally(() => this.loading.delete(id));
    this.loading.set(id, task);
    return task;
  }

  private configure(thread: StoredThread, result: any) {
    if (Array.isArray(result.configOptions)) thread.options = result.configOptions;
    const options = thread.options ?? [];
    const model = options.find((o) => o.category === "model" || o.id === "model");
    const effort = options.find(
      (o) => o.category === "thought_level" || /^(thought_level|thinking_level|effort)$/.test(o.id),
    );
    thread.defaults ??= {
      model: model?.currentValue ?? result.models?.currentModelId,
      reasoningEffort: effort?.currentValue,
    };
    const values = (option: any): any[] =>
      (option?.options ?? []).flatMap((o: any) => o.options ?? [o]);
    const models = model
      ? values(model).map((o) => ({
          id: o.value,
          displayName: o.name,
          description: o.description ?? "",
          isDefault: o.value === model.currentValue,
          reasoningEfforts: values(effort).map((e) => ({
            value: e.value,
            description: e.name,
            isDefault: e.value === effort.currentValue,
          })),
          serviceTiers: [],
          supportsPersonality: false,
        }))
      : (result.models?.availableModels ?? []).map((m: any) => ({
          id: m.modelId,
          displayName: m.name,
          description: m.description ?? "",
          isDefault: m.modelId === result.models.currentModelId,
          reasoningEfforts: [],
          serviceTiers: [],
          supportsPersonality: false,
        }));
    if (models.length) {
      this.data.models = models;
      this.publish({ type: "models.changed", models });
    }
  }

  async settings(id: string, patch: Record<string, any>) {
    const thread = this.thread(id);
    if (
      this.changingConnection ||
      this.settingThreads.has(id) ||
      this.active.has(id) ||
      this.admissions.has(id)
    )
      throw new AppError("Измените модель после завершения текущего ответа.", 409, "conflict");
    this.settingThreads.add(id);
    try {
      if (patch.collaborationMode && patch.collaborationMode !== "default")
        throw new AppError("Этот режим пока недоступен для Gemini.");
      const next: SessionSettings = { ...thread.detail.summary.settings };
      for (const key of ["model", "reasoningEffort"] as const)
        if (Object.hasOwn(patch, key)) {
          if (patch[key] === null) delete next[key];
          else next[key] = text(patch[key], key, 200);
        }
      if (this.loaded.has(id)) await this.applySettings(thread, next);
      thread.detail.summary.settings = next;
      await this.save();
      this.changed(id);
      return thread.detail.summary;
    } finally {
      this.settingThreads.delete(id);
    }
  }

  private async applySettings(thread: StoredThread, settings: SessionSettings) {
    const client = await this.getClient();
    for (const [key, category] of [
      ["model", "model"],
      ["reasoningEffort", "thought_level"],
    ] as const) {
      const value = settings[key] ?? thread.defaults?.[key];
      if (!value) continue;
      const option = thread.options?.find((o) => o.category === category || o.id === category);
      if (option) {
        if (option.currentValue === value) continue;
        const result = await client.request("session/set_config_option", {
          sessionId: thread.nativeId,
          configId: option.id,
          value,
        });
        this.configure(thread, result);
      } else if (key === "model")
        await client.request("session/set_model", { sessionId: thread.nativeId, modelId: value });
      else throw new AppError("CLI не предоставляет настройку уровня рассуждений для этой сессии.");
    }
  }

  send(id: string, input: QueueMessageRequest, queue = false): Promise<QueuedMessage> {
    return this.admission(id, () => this.admit(id, input, queue));
  }

  private admission(id: string, action: () => Promise<QueuedMessage>): Promise<QueuedMessage> {
    if (this.changingConnection || this.settingThreads.has(id) || this.closing)
      return Promise.reject(
        new AppError("Дождитесь завершения изменения настроек.", 409, "conflict"),
      );
    const previous =
      this.admissions.get(id) ?? Promise.resolve(undefined as unknown as QueuedMessage);
    const task = previous.catch(() => undefined).then(action);
    this.admissions.set(id, task);
    void task
      .finally(() => {
        if (this.admissions.get(id) === task) this.admissions.delete(id);
      })
      .catch(() => undefined);
    return task;
  }

  private async admit(id: string, input: QueueMessageRequest, queue: boolean) {
    const thread = this.thread(id);
    if (!validPastedText(input, input.input)) throw new AppError("Invalid pasted input");
    const rawText = text(input.input);
    const clientId = input.clientMessageId || randomUUID();
    text(clientId, "clientMessageId", 200);
    if (!rawText.trim() && !input.images?.length && !input.files?.length)
      throw new AppError("Введите сообщение.");
    const hash = fingerprint([
      rawText,
      input.pasteBlocks,
      input.inlinePastes,
      input.images ?? [],
      input.files ?? [],
      queue,
    ]);
    const receipt = thread.receipts[clientId];
    if (receipt) {
      if (receipt.fingerprint !== hash)
        throw new AppError("Этот ID уже использован для другого сообщения.", 409, "conflict");
      return receipt.message;
    }
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
      throw new AppError("Invalid image attachment");
    if (!this.accepting)
      throw new AppError(
        "GeminiNest перезапускается. Повторите попытку через несколько секунд.",
        503,
        "unavailable",
      );
    if (this.account.loggingIn) throw new AppError("Завершите вход в Google.", 409, "conflict");
    await this.load(id);
    if (!this.active.has(id)) await this.applySettings(thread, thread.detail.summary.settings);
    const message: QueuedMessage = {
      id: clientId,
      threadId: id,
      text: rawText,
      images,
      files,
      ...pastedText(input),
      createdAt: Date.now(),
      status: "queued",
      deliveryMode: queue ? "queue" : "steer",
    };
    thread.receipts[clientId] = { fingerprint: hash, message };
    thread.detail.queuedMessages.push(message);
    if (thread.detail.draft && input.draftUpdatedAt === thread.detail.draft.updatedAt)
      thread.detail.draft = null;
    const projectDraft = input.projectDraft;
    if (
      projectDraft &&
      projectDraft.projectId === thread.detail.summary.projectId &&
      this.data.projectDrafts[projectDraft.projectId]?.updatedAt === projectDraft.updatedAt
    ) {
      const cleared = blankDraft();
      this.data.projectDrafts[projectDraft.projectId] = cleared;
      this.publish({
        type: "projectDraft.changed",
        projectId: projectDraft.projectId,
        draft: cleared,
      });
    }
    const wasDefaultTitle = thread.detail.summary.title === "Новая сессия" && !thread.customTitle;
    if (wasDefaultTitle) thread.detail.summary.title = rawText.trim().slice(0, 100) || "Вложения";
    await this.save();
    this.changed(id);
    if (wasDefaultTitle && rawText.trim() && this.generateTitle) {
      const fallbackTitle = thread.detail.summary.title;
      const model =
        this.data.taskDefaults.titleModel ??
        thread.detail.summary.settings.model ??
        this.data.taskDefaults.model;
      void this.generateTitle(rawText, model)
        .then(async (generated) => {
          const current = this.data.threads[id];
          if (
            !generated ||
            !current ||
            current.customTitle ||
            current.detail.summary.title !== fallbackTitle
          )
            return;
          current.detail.summary.title = generated;
          await this.save();
          this.changed(id);
        })
        .catch(() => undefined);
    }
    if (!queue || !this.active.has(id))
      await this.dispatch(id, message, serializePastedMessage(rawText, input));
    return message;
  }

  private async dispatch(
    id: string,
    message: QueuedMessage,
    promptText = serializePastedMessage(message.text, message),
  ) {
    const thread = this.thread(id);
    const detail = thread.detail;
    if (message.status !== "queued" || !detail.queuedMessages.includes(message)) return;
    const client = this.client;
    if (!client || !this.loaded.has(id))
      throw new AppError("Соединение прервано. Повторите отправку из очереди.", 409, "conflict");
    message.status = "dispatching";
    delete message.deliveryError;
    let turn = detail.turns.find((t) => t.id === detail.summary.currentTurnId);
    if (!turn) {
      turn = {
        id: randomUUID(),
        status: "inProgress",
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
        progress: blankProgress(),
        items: [],
      };
      detail.turns.push(turn);
      detail.summary.currentTurnId = turn.id;
    }
    turn.items.push({
      type: "userMessage",
      id: message.id,
      status: "completed",
      text: message.text,
      ...pastedText(message),
      images: message.images ?? [],
      files: message.files,
      timestamp: message.createdAt,
      phase: null,
      deliveryReceipt: { version: 0, clientId: message.id, threadId: id, turnId: turn.id },
    });
    detail.summary.state = "running";
    detail.summary.updatedAt = Date.now();
    this.active.set(id, (this.active.get(id) ?? 0) + 1);
    try {
      await this.save();
    } catch (error) {
      message.status = "queued";
      message.deliveryError = {
        message: "Не удалось сохранить сообщение. Оно не отправлено в Gemini.",
        retryable: true,
      };
      turn.items = turn.items.filter((item) => item.id !== message.id);
      this.completePrompt(id, turn.id, "failed", message.deliveryError.message);
      throw error;
    }
    this.changed(id);
    const prompt: any[] = [{ type: "text", text: promptText }];
    for (const image of message.images ?? []) {
      const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(image)!;
      prompt.push({ type: "image", mimeType, data });
    }
    if (message.files?.length)
      prompt.push({
        type: "text",
        text:
          "Attached local files:\n" +
          JSON.stringify(message.files.map((f) => ({ name: f.name, path: f.path }))),
      });
    const request = client.request("session/prompt", { sessionId: thread.nativeId, prompt }, 0);
    detail.queuedMessages = detail.queuedMessages.filter((m) => m.id !== message.id);
    this.changed(id);
    void request.then(
      (result) => {
        this.completePrompt(
          id,
          turn.id,
          result.stopReason === "cancelled" ? "interrupted" : "completed",
        );
      },
      () => {
        this.completePrompt(
          id,
          turn.id,
          "failed",
          "Gemini не завершил запрос. Проверьте вход, прокси и доступ к модели. Запрос автоматически не повторялся.",
        );
      },
    );
  }

  private completePrompt(
    id: string,
    turnId: string,
    status: "completed" | "failed" | "interrupted",
    error?: string,
  ) {
    if (!this.active.has(id) || this.thread(id).detail.summary.currentTurnId !== turnId) return;
    if (status !== "completed") this.outcomes.set(id, { status, error });
    const count = this.active.get(id)! - 1;
    if (count > 0) this.active.set(id, count);
    else {
      const outcome = this.outcomes.get(id);
      this.finish(id, outcome?.status ?? status, outcome?.error ?? error);
    }
  }

  private finish(id: string, status: "completed" | "failed" | "interrupted", error?: string) {
    this.active.delete(id);
    this.outcomes.delete(id);
    for (const key of this.tools.keys()) if (key.startsWith(`${id}:`)) this.tools.delete(key);
    const detail = this.thread(id).detail;
    const turn = detail.turns.find((t) => t.id === detail.summary.currentTurnId);
    if (turn) {
      turn.status = status;
      turn.completedAt = Date.now();
      turn.durationMs = turn.startedAt ? turn.completedAt - turn.startedAt : null;
      for (const item of turn.items)
        if (item.status === "inProgress")
          item.status = status === "completed" ? "completed" : "failed";
      const last = [...turn.items].reverse().find((i) => i.type === "agentMessage");
      if (last && last.type === "agentMessage") {
        last.phase = "final_answer";
        detail.summary.preview = last.text.slice(0, 240);
      }
      if (error)
        turn.items.push({ type: "error", id: randomUUID(), status: "failed", message: error });
    }
    detail.summary.state = status;
    detail.summary.currentTurnId = null;
    detail.summary.updatedAt = Date.now();
    detail.summary.unread = true;
    detail.summary.unseen = true;
    this.clearRequests(id);
    this.changed(id);
    void this.save()
      .then(async () => {
        if (status !== "completed" || this.closing) return;
        const next = detail.queuedMessages.find((m) => m.status === "queued" && !m.deliveryError);
        if (next && !this.active.has(id)) await this.sendQueued(id, next.id, true);
      })
      .catch(() => this.emit("storageError"));
  }

  private update(params: any) {
    const thread = Object.values(this.data.threads).find((t) => t.nativeId === params.sessionId);
    if (!thread || this.replaying.has(params.sessionId)) return;
    const update = params.update;
    const id = thread.detail.summary.id;
    if (update.sessionUpdate === "config_option_update") this.configure(thread, update);
    if (update.sessionUpdate === "session_info_update" && update.title && !thread.customTitle)
      thread.detail.summary.title = String(update.title).slice(0, 200);
    const turn = thread.detail.turns.find((t) => t.id === thread.detail.summary.currentTurnId);
    if (!turn) {
      this.schedule(id);
      return;
    }
    if (["agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate)) {
      const type = update.sessionUpdate === "agent_message_chunk" ? "agentMessage" : "reasoning";
      if (update.content?.type === "text") {
        let item = turn.items.at(-1);
        if (item?.type !== type) {
          item = {
            id: randomUUID(),
            type,
            status: "inProgress",
            text: "",
            images: [],
            timestamp: Date.now(),
            phase: type === "agentMessage" ? "commentary" : null,
          };
          turn.items.push(item);
        }
        if (item.type === "agentMessage" || item.type === "reasoning")
          item.text += update.content.text;
      }
    } else if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
      const key = `${id}:${update.toolCallId}`;
      const tool = { ...this.tools.get(key), ...update };
      this.tools.set(key, tool);
      const content = (tool.content ?? [])
        .map((c: any) =>
          c.type === "content"
            ? (c.content?.text ?? "")
            : c.type === "diff"
              ? `${c.path}\n${c.newText ?? ""}`
              : "",
        )
        .join("\n");
      const item: ActivityItem = {
        type: "tool",
        id: tool.toolCallId,
        status:
          tool.status === "completed"
            ? "completed"
            : tool.status === "failed"
              ? "failed"
              : "inProgress",
        title: tool.title || tool.kind || "Инструмент",
        detail: content || (tool.rawInput ? JSON.stringify(tool.rawInput, null, 2) : ""),
      };
      const index = turn.items.findIndex((i) => i.id === item.id);
      if (index < 0) turn.items.push(item);
      else turn.items[index] = item;
    } else if (update.sessionUpdate === "plan") {
      turn.progress.steps = (update.entries ?? []).map((e: any) => ({
        step: e.content,
        status:
          e.status === "in_progress"
            ? "inProgress"
            : e.status === "completed"
              ? "completed"
              : "pending",
      }));
    }
    this.schedule(id);
  }

  private request(method: string, params: any): Promise<any> {
    const thread = Object.values(this.data.threads).find((t) => t.nativeId === params.sessionId);
    if (!thread) return Promise.reject(new RpcError(-32602, "Unknown session"));
    const id = randomUUID();
    const summary = thread.detail.summary;
    const base = {
      id,
      threadId: summary.id,
      turnId: summary.currentTurnId,
      itemId: params.toolCall?.toolCallId ?? params.toolCallId ?? null,
      createdAt: Date.now(),
    };
    let attention: AttentionRequest;
    if (method === "session/request_permission") {
      if (this.data.permission === "full-access") {
        const choice = params.options?.find((o: any) => o.kind === "allow_once");
        if (choice)
          return Promise.resolve({ outcome: { outcome: "selected", optionId: choice.optionId } });
      }
      attention = {
        ...base,
        kind: "commandApproval",
        command: params.toolCall?.title ?? "Инструмент Gemini",
        cwd: summary.cwd,
        reason: null,
        networkHost: null,
        canAcceptForSession: Boolean(params.options?.some((o: any) => o.kind === "allow_always")),
        proposedPolicyChanges: [],
      };
    } else if (method === "elicitation/create" && params.mode === "form") {
      attention = {
        ...base,
        kind: "elicitation",
        mode: "form",
        message: params.message || "Gemini запрашивает информацию",
        url: null,
        schema: {
          properties: params.requestedSchema?.properties ?? {},
          required: params.requestedSchema?.required ?? [],
        },
      };
    } else return Promise.reject(new RpcError(-32601, "Unsupported client method"));
    summary.state = "needsAttention";
    return new Promise((resolve) => {
      this.requests.set(id, { attention, params, resolve });
      this.publish({ type: "attention.upserted", attention });
      this.changed(summary.id);
    });
  }

  respond(id: string, response: AttentionResponse) {
    const request = this.requests.get(id);
    if (!request) throw new AppError("Запрос уже закрыт.", 409, "conflict");
    if (request.attention.kind === "commandApproval" && response.kind === "approval") {
      const kind =
        response.decision === "accept"
          ? "allow_once"
          : response.decision === "acceptForSession"
            ? "allow_always"
            : "reject_once";
      const choice = request.params.options.find((o: any) => o.kind === kind);
      if (response.decision === "cancel") request.resolve({ outcome: { outcome: "cancelled" } });
      else if (choice)
        request.resolve({ outcome: { outcome: "selected", optionId: choice.optionId } });
      else throw new AppError("CLI не предложил это действие.");
    } else if (request.attention.kind === "elicitation" && response.kind === "elicitation")
      request.resolve({ action: response.action, content: response.content });
    else throw new AppError("Invalid response kind");
    this.requests.delete(id);
    this.publish({ type: "attention.removed", attentionId: id });
    const threadId = request.attention.threadId!;
    const summary = this.thread(threadId).detail.summary;
    summary.state = [...this.requests.values()].some((r) => r.attention.threadId === threadId)
      ? "needsAttention"
      : "running";
    this.changed(threadId);
  }
  private clearRequests(id: string) {
    for (const [key, request] of this.requests)
      if (request.attention.threadId === id) {
        request.resolve(
          request.attention.kind === "elicitation"
            ? { action: "cancel" }
            : { outcome: { outcome: "cancelled" } },
        );
        this.requests.delete(key);
        this.publish({ type: "attention.removed", attentionId: key });
      }
  }
  cancel(id: string) {
    const thread = this.thread(id);
    this.clearRequests(id);
    if (thread.nativeId && this.active.has(id)) {
      this.outcomes.set(id, { status: "interrupted" });
      this.client?.notify("session/cancel", { sessionId: thread.nativeId });
    }
  }
  sendQueued(id: string, messageId: string, onlyWhenIdle = false) {
    return this.admission(id, async () => {
      const message = this.thread(id).detail.queuedMessages.find((m) => m.id === messageId);
      if (onlyWhenIdle && (!message || this.active.has(id))) return message!;
      if (!message || message.status !== "queued")
        throw new AppError(
          "Сообщение уже отправлено или доставка не подтверждена.",
          409,
          "conflict",
        );
      await this.load(id);
      if (!this.active.has(id))
        await this.applySettings(this.thread(id), this.thread(id).detail.summary.settings);
      await this.dispatch(id, message);
      return message;
    });
  }
  async close() {
    this.closing = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.client?.close();
    await this.account.close();
    await this.connection?.close();
    await this.save();
  }
}
