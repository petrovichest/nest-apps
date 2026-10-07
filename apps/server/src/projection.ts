import {
  appendUserInputRecordings,
  asyncQuestionReplyMessageId,
  fastServiceTier,
  isFastServiceTier,
  pastedText,
} from "@codexnest/protocol";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ActivityItem,
  AttentionRequest,
  AttentionResponse,
  AppSnapshot,
  BrowserThreadStatus,
  CodexRateLimitsState,
  DismissPlanRequest,
  ForkOperationSummary,
  ModelOption,
  Project,
  ProjectionVersion,
  QueuedMessage,
  SessionSettings,
  ServerEvent,
  TaskDefaults,
  ThreadDetail,
  ThreadDraft,
  ThreadHistoryPage,
  UpdateThreadDraftRequest,
  ThreadGoal,
  ThreadOutcome,
  ThreadState,
  ThreadSummary,
  ThreadSearchPage,
  ThreadSearchScope,
  ThreadOccurrencesPage,
  ThreadSearchTurn,
  TurnItemsResponse,
  TurnProgress,
  TurnView,
  UiLanguage,
  UpdateUserInputDraftRequest,
  UserInputDraft,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";

import type { AttentionManager } from "./attention";
import { stripAttachmentContext } from "./attachments";
import {
  CAPACITY_RETRY_INTERVAL_MS,
  CAPACITY_RETRY_MESSAGE_PREFIX,
  isCapacityFailure,
} from "./capacity-retry";
import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification } from "./codex/generated/index";
import type { Model, Thread, Turn } from "./codex/generated/v2/index";
import {
  parseModelList,
  parseThreadList,
  parseThreadLoadedList,
  parseThreadRead,
  parseThreadResume,
  parseThreadSearch,
  parseThreadOccurrences,
  parseTurnsList,
} from "./codex/guards";
import { RpcError } from "./codex/transport";
import { HistoryCache, type CachedTurnsPage } from "./history-cache";
import { pathContains, projectForCwd, ProjectValidationError } from "./projects";
import { isMissingThreadError, isThreadNotLoadedError, removeThreadState } from "./thread-state";
import { recoverTimelineOrder } from "./timeline-rollout";
import type {
  CodexNestState,
  CodexNestStateView,
  DeepReadonly,
  ForkOperationState,
  InterruptedTextActivityState,
  ManagedTeamTaskState,
  SessionSnapshotState,
  StateStore,
  ThreadMetaState,
  TimelineArtifact,
  VoiceTranscriptionState,
} from "./state/store";

interface CachedThread {
  thread: Thread;
  archived: boolean;
  currentTurnId: string | null;
  liveOutcome?: ThreadOutcome;
  goalStatus?: ThreadGoal["status"] | null;
  stoppedGoalForTurn?: { turnId: string; goal: ThreadGoal };
}

interface PendingActivityDelta {
  itemId: string;
  activityType: "agentMessage" | "plan" | "reasoning" | "command";
  delta: string;
}

interface PendingTurnActivityDeltas {
  threadId: string;
  turnId: string;
  items: Map<string, PendingActivityDelta>;
}

export class ThreadDraftConflictError extends Error {}
export class ThreadViewUnavailableError extends Error {}
export class ThreadHistoryConflictError extends Error {}
export class ThreadSearchUnavailableError extends Error {}
export class ThreadSearchNotFoundError extends Error {}

const THREAD_TURN_PAGE_SIZE = 20;
const THREAD_SEARCH_PAGE_SIZE = 20;
const LIVE_ACTIVITY_DELTA_FLUSH_MS = 50;
const SESSION_RETENTION_BATCH_SIZE = 25;
const AUTO_FINISH_SESSION_LIMIT = 15;
const AUTO_FINISH_INACTIVITY_MS = 72 * 60 * 60 * 1_000;
const AUTO_FINISH_INTERVAL_MS = 60_000;
const MANAGED_RECOVERY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const LOADED_RECOVERY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

export class AppProjection extends EventEmitter {
  private readonly threads = new Map<string, CachedThread>();
  private readonly unmaterializedThreads = new Set<string>();
  private readonly activity = new Map<string, ActivityItem>();
  private readonly progress = new Map<string, TurnProgress>();
  private readonly turnStates = new Map<string, TurnView>();
  private readonly pendingActivityDeltas = new Map<string, PendingTurnActivityDeltas>();
  private readonly activityDeltaTimers = new Map<string, NodeJS.Timeout>();
  private readonly latestDetails = new Map<string, ThreadDetail>();
  private readonly historyRevisions = new Map<string, number>();
  private readonly subscribedThreads = new Set<string>();
  private readonly hiddenThreads = new Set<string>();
  private readonly pendingSubagentTitles = new Map<string, string>();
  private readonly subagentTitleUpdates = new Set<string>();
  private readonly deliveredNativeWaits = new Set<string>();
  private readonly removedThreads = new Set<string>();
  private missingThreadCleanup?: (threadId: string) => Promise<void> | void;
  private models: ModelOption[] = [];
  private rateLimits: CodexRateLimitsState = {
    limits: null,
    updatedAt: null,
    refreshing: false,
    refreshError: false,
  };
  private sequence = 0;
  private readonly instanceId = randomUUID();
  private syncedAt: string | null = null;
  private syncPromise?: Promise<void>;
  private recoverLoadedThreads = true;
  private loadedRecoveryAttempt = 0;
  private loadedRecoveryTimer?: NodeJS.Timeout;
  private managedRecoveryAttempt = 0;
  private managedRecoveryTimer?: NodeJS.Timeout;
  private sessionRetentionTimer?: NodeJS.Timeout;
  private sessionRetentionRunning = false;
  private autoFinishTimer?: NodeJS.Timeout;
  private autoFinishRunning = false;
  private readonly historyCache: HistoryCache;
  private browserStatusProvider: (threadId: string) => BrowserThreadStatus = () => "disabled";
  private threadResumeConfigProvider: (threadId: string) => Record<string, unknown> = () => ({});

  constructor(
    private readonly bridge: CodexBridge,
    private readonly store: StateStore,
    private readonly attention: AttentionManager,
    private readonly sessionLimit?: number,
  ) {
    super();
    this.historyCache = new HistoryCache(store.path);
    for (const [threadId, meta] of Object.entries(store.view().threadMeta)) {
      if (!meta.sessionSnapshot) continue;
      this.threads.set(threadId, cachedThreadFromSessionSnapshot(threadId, meta.sessionSnapshot));
    }
    bridge.on("state", (state) => {
      if (state !== "ready") {
        for (const cached of this.threads.values()) cached.thread.canAcceptDirectInput = null;
        if (this.loadedRecoveryTimer) clearTimeout(this.loadedRecoveryTimer);
        this.loadedRecoveryTimer = undefined;
        this.loadedRecoveryAttempt = 0;
        if (this.managedRecoveryTimer) clearTimeout(this.managedRecoveryTimer);
        this.managedRecoveryTimer = undefined;
        this.managedRecoveryAttempt = 0;
        if (this.sessionRetentionTimer) clearTimeout(this.sessionRetentionTimer);
        this.sessionRetentionTimer = undefined;
        if (this.autoFinishTimer) clearTimeout(this.autoFinishTimer);
        this.autoFinishTimer = undefined;
        this.subscribedThreads.clear();
        const persistedState = this.store.view();
        for (const threadId of this.hiddenThreads) {
          const cached = this.threads.get(threadId);
          if (!cached || !this.isInternalPendingForkThread(cached.thread, persistedState)) {
            this.hiddenThreads.delete(threadId);
          }
        }
        this.pendingSubagentTitles.clear();
        this.subagentTitleUpdates.clear();
        for (const cached of this.threads.values()) cached.goalStatus = undefined;
      } else {
        this.recoverLoadedThreads = true;
        this.loadedRecoveryAttempt = 0;
        this.managedRecoveryAttempt = 0;
      }
      this.publish({ type: "connection.changed", connection: this.connection });
    });
    bridge.on("notification", (notification: ServerNotification) => {
      void this.onNotification(notification).catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      });
    });
    attention.on("upserted", (request) => {
      const cached = request.threadId ? this.threads.get(request.threadId) : undefined;
      if (request.kind === "userInput" && request.threadId && request.turnId) {
        const knownTurns = [
          cached?.thread.turns.find((turn) => turn.id === request.turnId),
          this.turnStates.get(turnKey(request.threadId, request.turnId)),
        ];
        if (knownTurns.some((turn) => turn && turn.status !== "inProgress")) {
          this.attention.expire(request.id);
          return;
        }
        void this.clearReplacedUserInputDrafts(request).catch((error: unknown) => {
          this.emit("warning", error, "Could not retire replaced question drafts");
        });
      }
      if (cached && request.turnId) {
        cached.currentTurnId = request.turnId;
        cached.liveOutcome = undefined;
        cached.thread.status = { type: "active", activeFlags: [] };
      }
      if (!request.threadId) {
        this.publish({ type: "attention.upserted", attention: this.enrichAttention(request) });
        return;
      }
      const state = this.store.view();
      if (this.isThreadVisible(request.threadId, state)) {
        this.publish({
          type: "attention.upserted",
          attention: this.enrichAttention(request, state),
        });
      }
      if (!this.touchThreadActivity(request.threadId, request.createdAt, state)) {
        this.publishThread(request.threadId, state);
      }
    });
    attention.on("removed", (attentionId: string, request: AttentionRequest) => {
      this.publish({ type: "attention.removed", attentionId });
      if (request.threadId) this.publishThread(request.threadId);
    });
  }

  setMissingThreadCleanup(cleanup: ((threadId: string) => Promise<void> | void) | undefined): void {
    this.missingThreadCleanup = cleanup;
  }

  get connection(): AppSnapshot["connection"] {
    return {
      state: this.bridge.state,
      message: this.bridge.state === "ready" ? null : "Codex app-server недоступен",
      syncedAt: this.syncedAt,
    };
  }

  get codexRateLimits(): CodexRateLimitsState {
    return this.rateLimits;
  }

  setCodexRateLimits(state: CodexRateLimitsState): void {
    if (isDeepStrictEqual(this.rateLimits, state)) return;
    this.rateLimits = state;
    this.publish({ type: "codexRateLimits.changed", codexRateLimits: state });
  }

  snapshot(): AppSnapshot {
    const state = this.store.view();
    const threads = this.sortedThreads(state).filter(
      (thread) => !this.hiddenThreads.has(thread.id) && this.isCwdVisible(thread.cwd, state),
    );
    const visibleThreadIds = new Set(threads.map((thread) => thread.id));
    return {
      instanceId: this.instanceId,
      sequence: this.sequence,
      uiLanguage: state.uiLanguage,
      connection: this.connection,
      codexRateLimits: this.rateLimits,
      projects: cloneView<Project[]>(state.projects),
      threads,
      attention: this.attention
        .list()
        .filter((request) => !request.threadId || visibleThreadIds.has(request.threadId))
        .map((request) => this.enrichAttention(request, state)),
      models: this.models,
      defaultReasoningEffort: state.defaultReasoningEffort,
      taskDefaults: state.taskDefaults ?? {},
      voiceTranscriptions: Object.values(state.voiceTranscriptions ?? {})
        .filter((job) => visibleThreadIds.has(job.threadId))
        .map(publicVoiceTranscription)
        .sort((left, right) => left.createdAt - right.createdAt),
      forkOperations: Object.values(state.forkOperations ?? {})
        .map(publicForkOperation)
        .sort((left, right) => left.createdAt - right.createdAt),
    };
  }

  get version(): ProjectionVersion {
    return { instanceId: this.instanceId, sequence: this.sequence };
  }

  get threadCount(): number {
    return this.threads.size;
  }

  get lastSyncedAt(): string | null {
    return this.syncedAt;
  }

  get availableModels(): ModelOption[] {
    return structuredClone(this.models);
  }

  get newSessionSettings(): SessionSettings {
    const state = this.store.view();
    const defaults = state.taskDefaults ?? {};
    const reasoningEffort = state.defaultReasoningEffort;
    const explicitModel = defaults.model
      ? this.models.find((candidate) => candidate.id === defaults.model)
      : undefined;
    const model = explicitModel ?? defaultModel(this.models);
    const settings: SessionSettings = {
      ...DEFAULT_SESSION_SETTINGS,
      ...(explicitModel ? { model: explicitModel.id } : {}),
      ...(isFastServiceTier(defaults.serviceTier) && fastServiceTier(model)
        ? { serviceTier: "fast" }
        : {}),
      ...(defaults.personality && (!model || model.supportsPersonality)
        ? { personality: defaults.personality }
        : {}),
    };
    if (
      reasoningEffort &&
      (!model || model.reasoningEfforts.some((option) => option.value === reasoningEffort))
    ) {
      settings.reasoningEffort = reasoningEffort;
    }
    return settings;
  }

  summary(id: string): ThreadSummary | undefined {
    if (this.removedThreads.has(id) || this.hiddenThreads.has(id)) return undefined;
    const cached = this.threads.get(id);
    return cached ? this.toSummary(cached) : undefined;
  }

  rolloutPath(id: string): string | null {
    return this.threads.get(id)?.thread.path ?? null;
  }

  /** Only tool-produced paths already loaded for this session may escape its workspace. */
  hasToolImagePath(threadId: string, path: string): boolean {
    const matches = (item: ActivityItem) =>
      item.type === "tool" && Boolean(item.images?.includes(path));
    for (const [key, item] of this.activity) {
      if (key.startsWith(`${threadId}:`) && matches(item)) return true;
    }
    for (const [key, turn] of this.turnStates) {
      if (key.startsWith(`${threadId}:`) && turn.items.some(matches)) return true;
    }
    if (this.latestDetails.get(threadId)?.turns.some((turn) => turn.items.some(matches)))
      return true;
    return Boolean(
      this.threads
        .get(threadId)
        ?.thread.turns.some((turn) =>
          turn.items.some(
            (item) =>
              (item.type === "imageView" && item.path === path) ||
              (item.type === "imageGeneration" && item.savedPath === path),
          ),
        ),
    );
  }

  async searchThreads(
    searchTerm: string,
    archived: boolean,
    cursor: string | null,
    scope: ThreadSearchScope = "messages",
  ): Promise<ThreadSearchPage> {
    if (scope === "titles") return this.searchThreadTitles(searchTerm, archived, cursor);
    const params = {
      searchTerm,
      archived,
      cursor,
      limit: THREAD_SEARCH_PAGE_SIZE,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
    };
    const page = parseThreadSearch(await this.searchRequest("thread/search", params));
    return {
      data: page.data
        .filter(({ thread }) => this.isSearchVisible(thread))
        .map(({ thread, snippet }) => ({
          thread: this.toSummary({ thread, archived, currentTurnId: activeTurnId(thread) }),
          snippet,
        })),
      nextCursor: page.nextCursor,
    };
  }

  private async searchThreadTitles(
    searchTerm: string,
    archived: boolean,
    cursor: string | null,
  ): Promise<ThreadSearchPage> {
    const query = normalizeTitleSearch(searchTerm);
    const boundary = cursor ? parseTitleSearchCursor(cursor, query, archived) : null;
    if (!query) return { data: [], nextCursor: null };
    if (this.syncPromise) await this.syncPromise;
    const words = query.split(" ");
    const matches = [...this.threads.values()]
      .filter(({ thread, archived: threadArchived }) => {
        if (
          threadArchived !== archived ||
          (typeof thread.source === "object" && "subAgent" in thread.source) ||
          !this.isSearchVisible(thread) ||
          (boundary &&
            (thread.updatedAt > boundary.updatedAt ||
              (thread.updatedAt === boundary.updatedAt && thread.id <= boundary.id)))
        )
          return false;
        const title = normalizeTitleSearch(displayThreadTitle(thread));
        return words.every((word) => title.includes(word));
      })
      .sort(
        (a, b) =>
          b.thread.updatedAt - a.thread.updatedAt ||
          (a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0),
      );
    const page = matches.slice(0, THREAD_SEARCH_PAGE_SIZE);
    const last = page.at(-1)?.thread;
    return {
      data: page.map((cached) => ({ thread: this.toSummary(cached), snippet: "" })),
      nextCursor:
        matches.length > THREAD_SEARCH_PAGE_SIZE && last
          ? Buffer.from(
              JSON.stringify(["titles-v1", query, archived, last.updatedAt, last.id]),
            ).toString("base64url")
          : null,
    };
  }

  async searchOccurrences(
    threadId: string,
    searchTerm: string,
    cursor: string | null,
  ): Promise<ThreadOccurrencesPage> {
    await this.requireSearchThread(threadId);
    return parseThreadOccurrences(
      await this.searchRequest("thread/searchOccurrences", {
        threadId,
        searchTerm,
        cursor,
        limit: 20,
      }),
    );
  }

  async readSearchTurn(
    threadId: string,
    turnId: string,
    cursor: string,
  ): Promise<ThreadSearchTurn> {
    await this.requireSearchThread(threadId);
    let page;
    try {
      page = parseTurnsList(
        await this.searchRequest("thread/turns/list", {
          threadId,
          cursor,
          limit: 1,
          sortDirection: "asc",
          itemsView: "full",
        }),
      );
    } catch (error) {
      if (error instanceof RpcError)
        throw new ThreadHistoryConflictError("Search result changed; search again");
      throw error;
    }
    const turn = page.data[0];
    if (!turn || turn.id !== turnId)
      throw new ThreadHistoryConflictError("Search result changed; search again");
    return {
      instanceId: this.instanceId,
      turn: conversationTurn(
        normalizeTurn(
          turn,
          this.progress.get(turnKey(threadId, turnId)),
          [],
          this.timelineArtifacts(threadId, turnId),
        ),
      ),
    };
  }

  private async searchRequest(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.bridge.request<unknown>(method, params, 30_000);
    } catch (error) {
      if (
        error instanceof RpcError &&
        (error.code === -32601 ||
          /unknown variant|not supported|unsupported|not implemented|requires.*paginated/i.test(
            error.message,
          ))
      )
        throw new ThreadSearchUnavailableError(
          "Поиск недоступен в этой версии Codex или для этой истории.",
        );
      throw error;
    }
  }

  private isSearchVisible(thread: Thread): boolean {
    const state = this.store.view();
    return (
      !this.removedThreads.has(thread.id) &&
      !this.hiddenThreads.has(thread.id) &&
      !thread.ephemeral &&
      thread.parentThreadId == null &&
      !state.threadMeta[thread.id]?.managedParent &&
      !this.isInternalPendingForkThread(thread, state) &&
      this.isCwdVisible(thread.cwd, state)
    );
  }

  private async requireSearchThread(threadId: string): Promise<void> {
    try {
      const thread =
        this.threads.get(threadId)?.thread ??
        parseThreadRead(await this.bridge.request("thread/read", { threadId, includeTurns: false }))
          .thread;
      if (!this.isSearchVisible(thread)) throw new ThreadSearchNotFoundError("Thread not found");
    } catch (error) {
      if (isMissingThreadError(error)) throw new ThreadSearchNotFoundError("Thread not found");
      throw error;
    }
  }

  publishForkOperation(operationId: string): void {
    const operation = this.store.view().forkOperations?.[operationId];
    if (operation) {
      this.publish({ type: "forkOperation.upserted", operation: publicForkOperation(operation) });
    }
  }

  removeForkOperation(operationId: string): void {
    this.publish({ type: "forkOperation.removed", operationId });
  }

  setBrowserStatusProvider(provider: (threadId: string) => BrowserThreadStatus): void {
    this.browserStatusProvider = provider;
  }

  setThreadResumeConfigProvider(provider: (threadId: string) => Record<string, unknown>): void {
    this.threadResumeConfigProvider = provider;
  }

  hasExplicitName(id: string): boolean {
    return !!this.threads.get(id)?.thread.name?.trim();
  }

  async sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync()
      .catch((error: unknown) => {
        if (this.recoverLoadedThreads) this.scheduleLoadedRecovery();
        throw error;
      })
      .finally(() => {
        this.syncPromise = undefined;
      });
    return this.syncPromise;
  }

  async readThread(
    id: string,
    optionsOrCursor: { refresh?: boolean } | string = {},
  ): Promise<ThreadDetail> {
    if (typeof optionsOrCursor === "string") {
      return this.readLegacyThreadPage(id, optionsOrCursor);
    }
    const options = optionsOrCursor;
    const local = this.threads.get(id);
    const meta = this.store.view().threadMeta[id];
    const subagent = local ? hasSubagentTranscript(local.thread, meta) : false;
    if (local && this.isUnmaterialized(id)) {
      const state = this.store.view();
      return {
        version: this.version,
        summary: this.toSummary(local),
        turns: [],
        queuedMessages: cloneView<QueuedMessage[]>(state.messageQueues?.[id] ?? []),
        olderTurnsCursor: null,
        draft: cloneView<ThreadDraft | null>(state.threadMeta[id]?.draft ?? null),
      };
    }
    const cached = this.threads.get(id);
    if (!cached) throw new Error("Thread not found");
    const previous = this.latestDetails.get(id);
    const boundaryIds = new Set(cached.thread.turns.slice(-2).map((turn) => turn.id));
    if (cached.currentTurnId) boundaryIds.add(cached.currentTurnId);
    const previousIds = new Set(previous?.turns.map((turn) => turn.id) ?? []);
    const needsCanonicalPage =
      !previous ||
      previous.historyError !== undefined ||
      options.refresh ||
      previous.turns.some(
        (turn) => turn.id === cached.currentTurnId && turn.status !== "inProgress",
      ) ||
      [...boundaryIds].some((turnId) => !previousIds.has(turnId));
    let page: CachedTurnsPage | undefined;
    let historyError: ThreadDetail["historyError"];
    if (needsCanonicalPage) {
      try {
        page = await this.readTurnsPage(id, null, "desc", !subagent && !options.refresh);
        if (page.historyRevision === this.historyRevision(id)) {
          await this.restoreActiveTurnFromPage(cached, page.turns);
          if (cached.currentTurnId && !this.subscribedThreads.has(id)) {
            const resumed = await this.rejoinActiveThread(cached.thread, true);
            await this.reconcileCompletedTurn(id, resumed.thread.turns);
            // Rejoining may replay live events and invalidate the page just read.
            if (page.historyRevision !== this.historyRevision(id)) {
              page = await this.readTurnsPage(id, null, "desc", false);
            }
          }
        }
      } catch (error) {
        const pending = this.store.view();
        if (pending.messageQueues?.[id]?.length || pending.threadMeta[id]?.draft) {
          historyError = {
            message: "Не удалось загрузить историю сессии. Сохранённые сообщения доступны ниже.",
            retryable: !isMissingThreadError(error),
          };
        } else if (!(error instanceof RpcError) || isMissingThreadError(error)) {
          throw error;
        } else if (options.refresh || !previous) {
          throw new ThreadViewUnavailableError("Thread view is temporarily unavailable");
        }
      }
    } else if (cached.currentTurnId && !this.subscribedThreads.has(id)) {
      const resumed = await this.rejoinActiveThread(cached.thread, true);
      await this.reconcileCompletedTurn(id, resumed.thread.turns);
    }
    const state = this.store.view();
    if (page && page.historyRevision !== this.historyRevision(id)) {
      if (options.refresh || !(this.latestDetails.get(id) ?? previous)) {
        throw new ThreadViewUnavailableError("Thread view changed while it was being refreshed");
      }
      page = undefined;
    }
    const consistentPrevious = this.latestDetails.get(id) ?? previous;
    const baseTurns = page?.turns ?? consistentPrevious?.turns ?? [];
    const visibleTurns = this.materializeLatestTurns(
      cached,
      baseTurns,
      consistentPrevious?.turns ?? [],
      page !== undefined,
    );
    const turns = subagent
      ? subagentTranscriptTurnViews(cached.thread, visibleTurns, meta)
      : visibleTurns;
    const detail: ThreadDetail = {
      version: this.version,
      summary: this.toSummary(cached),
      turns: turns.map((turn) => this.withDeliveryReceipts(id, conversationTurn(turn))),
      queuedMessages: cloneView<QueuedMessage[]>(state.messageQueues?.[id] ?? []),
      olderTurnsCursor: subagent
        ? null
        : (page?.nextCursor ?? consistentPrevious?.olderTurnsCursor ?? null),
      draft: cloneView<ThreadDraft | null>(state.threadMeta[id]?.draft ?? null),
      ...(historyError ? { historyError } : {}),
    };
    this.latestDetails.set(id, cloneView(detail));
    return detail;
  }

  private async readLegacyThreadPage(id: string, cursor: string): Promise<ThreadDetail> {
    const cached = this.threads.get(id);
    if (!cached) throw new Error("Thread not found");
    const meta = this.store.view().threadMeta[id];
    if (hasSubagentTranscript(cached.thread, meta)) return this.readThread(id);
    const page = await this.readTurnsPage(id, cursor, "desc", false);
    const state = this.store.view();
    return {
      version: this.version,
      summary: this.toSummary(cached),
      turns: page.turns.map((turn) => this.withDeliveryReceipts(id, conversationTurn(turn))),
      queuedMessages: cloneView<QueuedMessage[]>(state.messageQueues?.[id] ?? []),
      olderTurnsCursor: page.nextCursor,
      draft: cloneView<ThreadDraft | null>(state.threadMeta[id]?.draft ?? null),
    };
  }

  async readThreadHistory(
    id: string,
    cursor: string,
    anchorTurnId: string,
  ): Promise<ThreadHistoryPage> {
    const cached = this.threads.get(id);
    if (!cached) throw new Error("Thread not found");
    if (hasSubagentTranscript(cached.thread, this.store.view().threadMeta[id])) {
      return { instanceId: this.instanceId, anchorTurnId, turns: [], olderTurnsCursor: null };
    }
    const revision = this.historyRevision(id);
    let page: CachedTurnsPage;
    try {
      page = await this.readTurnsPage(id, cursor, "desc", false);
    } catch (error) {
      if (error instanceof RpcError) {
        throw new ThreadHistoryConflictError("Thread history changed");
      }
      throw error;
    }
    if (revision !== this.historyRevision(id)) {
      throw new ThreadHistoryConflictError("Thread history changed while it was being read");
    }
    return {
      instanceId: this.instanceId,
      anchorTurnId,
      turns: page.turns.map(conversationTurn),
      olderTurnsCursor: page.nextCursor,
    };
  }

  private materializeLatestTurns(
    cached: CachedThread,
    pageTurns: TurnView[],
    previousTurns: TurnView[],
    hasFreshPage: boolean,
  ): TurnView[] {
    const boundaryTurns = cached.thread.turns
      .slice(-2)
      .map((turn) =>
        normalizeTurn(
          turn,
          this.progress.get(turnKey(cached.thread.id, turn.id)),
          turn.status === "inProgress"
            ? this.liveActivities(cached.thread.id, turn.id)
            : this.terminalActivityOverlay(
                cached.thread.id,
                turn.id,
                projectedTurnItemIds(turn),
                normalizeOutcome(turn.status),
              ),
          this.timelineArtifacts(cached.thread.id, turn.id),
          false,
          this.interruptedTextActivities(cached.thread.id, turn.id),
        ),
      );
    if (
      cached.currentTurnId &&
      ![...pageTurns, ...previousTurns, ...boundaryTurns].some(
        (turn) => turn.id === cached.currentTurnId,
      )
    ) {
      boundaryTurns.push({
        id: cached.currentTurnId,
        status: "inProgress",
        startedAt:
          this.progress.get(turnKey(cached.thread.id, cached.currentTurnId))?.startedAt ?? null,
        completedAt: null,
        durationMs: null,
        progress:
          this.progress.get(turnKey(cached.thread.id, cached.currentTurnId)) ?? emptyProgress(null),
        items: [],
        itemsLoaded: false,
      });
    }
    const retainedIds = hasFreshPage
      ? new Set([...pageTurns, ...boundaryTurns].map((turn) => turn.id))
      : null;
    const retainedPrevious = retainedIds
      ? previousTurns.filter((turn) => retainedIds.has(turn.id))
      : previousTurns;
    const orderedIds: string[] = [];
    const turns = new Map<string, TurnView>();
    for (const source of [retainedPrevious, pageTurns, boundaryTurns]) {
      for (const turn of source) {
        const projected =
          this.turnStates.get(turnKey(cached.thread.id, turn.id)) ??
          this.overlayLiveTurn(cached.thread.id, turn);
        if (!turns.has(turn.id)) orderedIds.push(turn.id);
        const current = turns.get(turn.id);
        turns.set(turn.id, current ? mergeMaterializedTurn(current, projected) : projected);
      }
    }
    const materializedOrder = hasFreshPage
      ? [
          ...pageTurns.map((turn) => turn.id),
          ...boundaryTurns
            .map((turn) => turn.id)
            .filter((turnId) => !pageTurns.some((turn) => turn.id === turnId)),
        ]
      : orderedIds;
    return materializedOrder
      .map((turnId) => turns.get(turnId)!)
      .slice(-(THREAD_TURN_PAGE_SIZE + 2));
  }

  private overlayLiveTurn(threadId: string, turn: TurnView): TurnView {
    const liveMerge = mergeLiveActivities(
      turn.items,
      turn.status === "inProgress"
        ? this.liveActivities(threadId, turn.id)
        : this.terminalActivityOverlay(
            threadId,
            turn.id,
            new Set(turn.items.map((item) => item.id)),
            turn.status,
          ),
      turn.status,
    );
    return {
      ...turn,
      progress: this.progress.get(turnKey(threadId, turn.id)) ?? turn.progress,
      items: mergeTimelineArtifacts(
        mergeInterruptedTextActivities(
          liveMerge.items,
          this.interruptedTextActivities(threadId, turn.id),
        ),
        this.timelineArtifacts(threadId, turn.id),
        liveMerge.aliases,
      ),
    };
  }

  invalidateHistory(threadId: string): Promise<void> {
    this.bumpHistoryRevision(threadId);
    this.latestDetails.delete(threadId);
    return this.historyCache.invalidateThread(threadId);
  }

  private async restoreActiveTurnFromPage(cached: CachedThread, turns: TurnView[]): Promise<void> {
    const activeTurn = [...turns].reverse().find((turn) => turn.status === "inProgress");
    if (!activeTurn || activeTurn.id === cached.currentTurnId) return;
    if (cached.currentTurnId) {
      const currentIndex = turns.findIndex((turn) => turn.id === cached.currentTurnId);
      const activeIndex = turns.findIndex((turn) => turn.id === activeTurn.id);
      // A history page can advance a stale turn, but cannot displace a live turn
      // it does not contain or replace it with an older one.
      if (currentIndex < 0 || activeIndex < currentIndex) return;
    }
    const knownTurn = cached.thread.turns.find((turn) => turn.id === activeTurn.id);
    if (knownTurn && knownTurn.status !== "inProgress") return;
    const outcomeUpdatedAt = this.store.view().threadMeta[cached.thread.id]?.outcomeUpdatedAt;
    const startedAt = activeTurn.startedAt ?? activeTurn.progress.startedAt;
    if (outcomeUpdatedAt !== undefined && (startedAt === null || startedAt < outcomeUpdatedAt)) {
      return;
    }
    await this.setCurrentTurn(cached.thread.id, activeTurn.id);
  }

  private async reconcileCompletedTurn(
    threadId: string,
    turns: Turn[],
  ): Promise<{ historyChanged: boolean } | null> {
    const currentTurnId = this.threads.get(threadId)?.currentTurnId;
    if (!currentTurnId) return null;
    // A terminal record for this exact turn is authoritative even if an idle
    // notification arrived during recovery. Neither missing turns nor final text
    // alone prove completion, and a newer active turn must remain active.
    if (turns.some((turn) => turn.status === "inProgress" && turn.id !== currentTurnId)) {
      return null;
    }
    const completed = turns.find(
      (turn) => turn.id === currentTurnId && turn.status !== "inProgress",
    );
    return completed ? this.completeTurn(threadId, completed, true) : null;
  }

  private async readTurnsPage(
    id: string,
    cursor: string | null,
    direction: "asc" | "desc",
    allowCache: boolean,
    limit = THREAD_TURN_PAGE_SIZE,
  ): Promise<CachedTurnsPage> {
    const local = this.threads.get(id);
    if (!local) throw new Error("Thread not found");
    const threadUpdatedAt = local.thread.updatedAt * 1_000;
    const historyRevision = this.historyRevision(id);
    const canReadCache =
      allowCache &&
      direction === "desc" &&
      limit === THREAD_TURN_PAGE_SIZE &&
      (cursor !== null || local.currentTurnId === null);
    if (canReadCache) {
      const cached = await this.historyCache.get(id, cursor, direction);
      if (
        cached &&
        (cursor !== null ||
          (cached.threadUpdatedAt === threadUpdatedAt &&
            cached.historyRevision === this.historyRevision(id)))
      ) {
        for (const turn of cached.turns) {
          if (turn.status !== "inProgress") this.turnStates.set(turnKey(id, turn.id), turn);
        }
        await this.clearCompletedUserInputs(id, cached.turns);
        return cached;
      }
    }

    const startedAt = Date.now();
    const response = parseTurnsList(
      await this.bridge.request<unknown>(
        "thread/turns/list",
        {
          threadId: id,
          cursor,
          limit,
          sortDirection: direction,
          itemsView: "full",
        },
        30_000,
      ),
    );
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 500) {
      process.stderr.write(
        `CodexNest thread history read slow (${durationMs}ms, ${response.data.length} turns)\n`,
      );
    }
    const completion =
      cursor === null && direction === "desc"
        ? await this.reconcileCompletedTurn(id, response.data)
        : null;
    const artifacts = Object.fromEntries(
      response.data.map((turn) => [turn.id, this.timelineArtifacts(id, turn.id)]),
    );
    await recoverTimelineOrder(this.rolloutPath(id), response.data, artifacts);
    const ordered = direction === "desc" ? response.data.slice().reverse() : response.data;
    const page: CachedTurnsPage = {
      threadId: id,
      cursor,
      direction,
      threadUpdatedAt,
      // Account only for our own retained-text update, so concurrent notifications
      // still invalidate this read instead of being mistaken for recovery writes.
      historyRevision: historyRevision + (completion?.historyChanged ? 1 : 0),
      turns: ordered.map((turn) => {
        const normalized = conversationTurn(
          normalizeTurn(
            turn,
            this.progress.get(turnKey(id, turn.id)),
            turn.status === "inProgress"
              ? this.liveActivities(id, turn.id)
              : this.terminalActivityOverlay(
                  id,
                  turn.id,
                  projectedTurnItemIds(turn),
                  normalizeOutcome(turn.status),
                ),
            cloneView<TimelineArtifact[]>(artifacts[turn.id] ?? []),
            false,
            this.interruptedTextActivities(id, turn.id),
          ),
        );
        if (turn.status !== "inProgress") {
          this.clearTurnActivities(id, turn.id);
        }
        this.turnStates.set(turnKey(id, turn.id), normalized);
        return normalized;
      }),
      nextCursor: response.nextCursor,
      backwardsCursor: response.backwardsCursor ?? null,
    };
    await this.clearCompletedUserInputs(id, page.turns);
    if (
      canReadCache &&
      local.thread.updatedAt * 1_000 === threadUpdatedAt &&
      this.historyRevision(id) === historyRevision
    ) {
      await this.historyCache.set(page).catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      });
      if (
        local.thread.updatedAt * 1_000 !== threadUpdatedAt ||
        this.historyRevision(id) !== historyRevision
      ) {
        await this.historyCache.invalidateThread(id).catch(() => undefined);
      }
    }
    return page;
  }

  async setDraft(
    threadId: string,
    value: UpdateThreadDraftRequest,
    options?: { expectedUpdatedAt: number | null },
  ): Promise<ThreadDraft | null> {
    if (!this.threads.has(threadId)) throw new Error("Thread not found");
    const empty =
      value.input === "" &&
      value.images.length === 0 &&
      (value.pasteBlocks?.length ?? 0) === 0 &&
      (value.files?.length ?? 0) === 0 &&
      !value.goalMode &&
      value.annotations.length === 0;
    let draft: ThreadDraft | null = null;
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      const current = meta.draft;
      if (options && (current?.updatedAt ?? null) !== options.expectedUpdatedAt) {
        if (threadDraftMatches(current, value)) {
          draft = current ? { ...structuredClone(value), updatedAt: current.updatedAt } : null;
          return;
        }
        throw new ThreadDraftConflictError("The draft changed before voice upload");
      }
      if (empty) {
        delete meta.draft;
      } else {
        draft = {
          ...structuredClone(value),
          updatedAt: Math.max(Date.now(), (current?.updatedAt ?? -1) + 1),
        };
        meta.draft = draft;
      }
      state.threadMeta[threadId] = meta;
    });
    return draft;
  }

  canRecoverMissingFirstSession(threadId: string, retryUnconfirmedMessageId?: string): boolean {
    const cached = this.threads.get(threadId);
    const state = this.store.view();
    const meta = state.threadMeta[threadId];
    const summary = cached ? this.toSummary(cached, state) : undefined;
    return Boolean(
      cached &&
      summary?.projectId &&
      summary.relation.kind === "session" &&
      !cached.archived &&
      !cached.currentTurnId &&
      !cached.thread.turns.length &&
      !cached.thread.name?.trim() &&
      !cached.thread.preview.trim() &&
      !cached.thread.forkedFromId &&
      !meta?.logicalFork &&
      !meta?.lastOutcome &&
      meta?.managedTeamToolsAvailable &&
      meta.sessionArtifactsVersion === 1 &&
      !meta.browserEnabled &&
      !meta.teamOrchestration &&
      Object.values(state.threadCreations ?? {}).some(
        (creation) => creation.threadId === threadId,
      ) &&
      !Object.entries(state.messageReceipts ?? {}).some(
        ([id, receipt]) =>
          receipt.threadId === threadId &&
          receipt.status !== "rejected" &&
          receipt.status !== "canceled" &&
          !(
            id === retryUnconfirmedMessageId &&
            receipt.deliveryVersion !== 1 &&
            receipt.status === "prepared" &&
            !receipt.turnId &&
            receipt.request?.method === "turn/start"
          ),
      ) &&
      !Object.values(state.voiceTranscriptions ?? {}).some((job) => job.threadId === threadId) &&
      state.messageQueues?.[threadId]?.length &&
      state.messageQueues[threadId].every(
        (message) =>
          (message.status === "queued" ||
            (message.id === retryUnconfirmedMessageId &&
              message.status === "dispatching" &&
              Boolean(message.deliveryError))) &&
          !message.replyToAsyncQuestion &&
          !message.replyToUserInput &&
          !message.dismissUserInput,
      ),
    );
  }

  async markRead(threadId: string, observedUpdatedAt: number): Promise<void> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    const safeObserved = Math.min(observedUpdatedAt, cached.thread.updatedAt * 1_000);
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.lastReadUpdatedAt = Math.max(meta.lastReadUpdatedAt, safeObserved);
      state.threadMeta[threadId] = meta;
    });
    this.publishThread(threadId);
  }

  async finishInactiveSessions(now = Date.now()): Promise<number> {
    if (
      this.bridge.state !== "ready" ||
      this.syncPromise ||
      this.threads.size <= AUTO_FINISH_SESSION_LIMIT
    )
      return 0;

    const finished: string[] = [];
    await this.store.update((state) => {
      // Recompute after waiting for earlier writes, so new activity and manual
      // finishes cannot leave a stale selection outside the newest fifteen.
      if (this.bridge.state !== "ready" || this.syncPromise) return;
      const candidates = [...this.threads.values()]
        .filter(
          (cached) =>
            !cached.thread.ephemeral &&
            !this.removedThreads.has(cached.thread.id) &&
            this.isThreadVisible(cached.thread.id, state),
        )
        .map((cached) => ({ cached, summary: this.toSummary(cached, state) }))
        .filter(
          ({ summary }) =>
            summary.relation.kind === "session" &&
            !summary.archived &&
            summary.state === "completed" &&
            summary.unread,
        )
        .sort(
          (a, b) =>
            b.summary.updatedAt - a.summary.updatedAt || a.summary.id.localeCompare(b.summary.id),
        )
        .slice(AUTO_FINISH_SESSION_LIMIT);

      for (const { cached, summary } of candidates) {
        if (
          summary.currentTurnId !== null ||
          cached.thread.status.type === "active" ||
          summary.queuedMessageCount > 0 ||
          now - summary.updatedAt <= AUTO_FINISH_INACTIVITY_MS
        )
          continue;
        const meta = state.threadMeta[summary.id] ?? { pinned: false, lastReadUpdatedAt: 0 };
        // Use the same acknowledgement as Finish, limited to the observed activity.
        meta.lastReadUpdatedAt = Math.max(meta.lastReadUpdatedAt, summary.updatedAt);
        state.threadMeta[summary.id] = meta;
        finished.push(summary.id);
      }
    });
    for (const threadId of finished) this.publishThread(threadId);
    return finished.length;
  }

  async dismissPlan(threadId: string, request: DismissPlanRequest): Promise<ThreadSummary> {
    const conflict = () =>
      new ThreadHistoryConflictError(
        "Состояние сессии изменилось. Обновите сессию и повторите отказ от плана.",
      );
    const assertIdle = (state: CodexNestStateView) => {
      const cached = this.threads.get(threadId);
      if (!cached) throw conflict();
      const summary = this.toSummary(cached, state);
      if (
        summary.currentTurnId ||
        !["needsAttention", "completed"].includes(summary.state) ||
        summary.queuedMessageCount > 0 ||
        this.attention.list().some((item) => item.threadId === threadId)
      )
        throw conflict();
      return summary;
    };
    assertIdle(this.store.view());
    const revision = this.historyRevision(threadId);
    const detail = await this.readThread(threadId);
    const turn = detail.turns.at(-1);
    let planIndex = -1;
    turn?.items.forEach((item, index) => {
      if (item.type === "plan" && item.text.trim()) planIndex = index;
    });
    if (
      turn?.id !== request.turnId ||
      turn.status !== "completed" ||
      planIndex < 0 ||
      turn.items[planIndex]?.status !== "completed" ||
      turn.items
        .slice(planIndex + 1)
        .some((item) => item.type === "userMessage" || item.type === "userInputResponse")
    )
      throw conflict();
    await this.store.update((state) => {
      const summary = assertIdle(state);
      const meta = state.threadMeta[threadId];
      if (
        !meta ||
        this.historyRevision(threadId) !== revision ||
        summary.updatedAt !== detail.summary.updatedAt ||
        (meta.dismissedPlanTurnId === request.turnId && meta.awaitingPlanResponse) ||
        (meta.dismissedPlanTurnId !== request.turnId &&
          (!meta.awaitingPlanResponse || summary.updatedAt !== request.observedUpdatedAt))
      )
        throw conflict();
      // Imported sessions may already have this timestamp marked read. Keep the
      // newly dismissed plan in Active until Finish, without reopening it on retry.
      if (meta.dismissedPlanTurnId !== request.turnId) {
        meta.lastReadUpdatedAt = Math.min(meta.lastReadUpdatedAt, summary.updatedAt - 1);
      }
      meta.dismissedPlanTurnId = request.turnId;
      meta.awaitingPlanResponse = false;
    });
    return this.publishThread(threadId)!;
  }

  async markViewed(threadId: string, observedUpdatedAt: number): Promise<void> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    const safeObserved = Math.min(observedUpdatedAt, cached.thread.updatedAt * 1_000);
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.lastViewedUpdatedAt = Math.max(meta.lastViewedUpdatedAt ?? 0, safeObserved);
      state.threadMeta[threadId] = meta;
    });
    this.publishThread(threadId);
  }

  async setPinned(threadId: string, pinned: boolean): Promise<void> {
    if (!this.threads.has(threadId)) throw new Error("Thread not found");
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.pinned = pinned;
      state.threadMeta[threadId] = meta;
    });
    this.publishThread(threadId);
  }

  async setSettings(threadId: string, settings: SessionSettings): Promise<ThreadSummary> {
    if (!this.threads.has(threadId)) throw new Error("Thread not found");
    const normalized = sessionSettings(settings);
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.settings = normalized;
      state.threadMeta[threadId] = meta;
    });
    this.publishThread(threadId);
    return this.summary(threadId)!;
  }

  async setDefaultReasoningEffort(reasoningEffort?: string): Promise<void> {
    await this.store.update((state) => {
      if (reasoningEffort) state.defaultReasoningEffort = reasoningEffort;
      else delete state.defaultReasoningEffort;
    });
    this.publish({
      type: "defaultReasoningEffort.changed",
      reasoningEffort: reasoningEffort ?? null,
    });
  }

  async setTaskDefaults(taskDefaults: TaskDefaults): Promise<void> {
    const normalized = { ...taskDefaults };
    if (isFastServiceTier(normalized.serviceTier)) normalized.serviceTier = "fast";
    else delete normalized.serviceTier;
    await this.store.update((state) => {
      if (Object.keys(normalized).length) state.taskDefaults = normalized;
      else delete state.taskDefaults;
    });
    this.publish({ type: "taskDefaults.changed", taskDefaults: normalized });
  }

  async setUiLanguage(language: UiLanguage): Promise<void> {
    await this.store.update((state) => {
      state.uiLanguage = language;
    });
    this.publish({ type: "uiLanguage.changed", language });
  }

  publishProject(projectId: string): void {
    const project = this.store.view().projects.find((candidate) => candidate.id === projectId);
    if (project) this.publish({ type: "project.upserted", project: cloneView<Project>(project) });
    this.publish({ type: "resync.required" });
  }

  publishProjectDraft(projectId: string, draft: ThreadDraft): void {
    this.publish({ type: "projectDraft.changed", projectId, draft });
  }

  publishProjectsReordered(projects: Project[]): void {
    this.publish({ type: "projects.reordered", projects });
  }

  removeProject(projectId: string): void {
    this.publish({ type: "project.removed", projectId });
    this.publish({ type: "resync.required" });
  }

  publishQueue(threadId: string, messages: QueuedMessage[]): void {
    const state = this.store.view();
    if (this.isThreadVisible(threadId, state)) {
      this.publish({ type: "queue.changed", threadId, messages });
    }
    if (!this.touchThreadActivity(threadId, Date.now(), state)) {
      this.publishThread(threadId, state);
    }
  }

  publishVoiceTranscription(job: VoiceTranscriptionState): void {
    if (!this.isThreadVisible(job.threadId)) return;
    this.publish({ type: "voiceTranscription.upserted", job: publicVoiceTranscription(job) });
    if (job.userInput) this.publishUserInputDraft(job.threadId, job.userInput.draftKey);
  }

  userInputVoiceRequest(
    threadId: string,
    draftKey: string,
  ): Extract<AttentionRequest, { kind: "userInput" }> | undefined {
    return this.attention
      .list()
      .find(
        (request): request is Extract<AttentionRequest, { kind: "userInput" }> =>
          request.kind === "userInput" &&
          request.threadId === threadId &&
          userInputDraftIdentity(request)?.key === draftKey,
      );
  }

  publishUserInputDraft(threadId: string, draftKey: string): void {
    const request = this.userInputVoiceRequest(threadId, draftKey);
    if (request && this.isThreadVisible(threadId)) {
      this.publish({ type: "attention.upserted", attention: this.enrichAttention(request) });
    }
  }

  async ensureUserInputVoiceDraft(
    request: Extract<AttentionRequest, { kind: "userInput" }>,
  ): Promise<void> {
    const identity = userInputDraftIdentity(request);
    if (!identity) throw new Error("User input request has no stable identity");
    await this.store.update((state) => {
      const meta = (state.threadMeta[identity.threadId] ??= {
        pinned: false,
        lastReadUpdatedAt: 0,
      });
      meta.userInputDrafts ??= {};
      meta.userInputDrafts[identity.key] ??= {
        turnId: identity.turnId,
        itemId: identity.itemId,
        fingerprint: identity.fingerprint,
        answers: {},
        currentQuestionId: request.questions[0]?.id ?? null,
        revision: 1,
        updatedAt: Date.now(),
      };
    });
  }

  removeVoiceTranscription(
    threadId: string,
    jobId: string,
    outcome: "draft" | "send" | "cancelled",
  ): void {
    if (!this.isThreadVisible(threadId)) return;
    this.publish({ type: "voiceTranscription.removed", threadId, jobId, outcome });
  }

  upsertThread(thread: Thread, archived = false): ThreadSummary {
    return this.cacheThread(thread, archived, false);
  }

  revealThread(thread: Thread, archived = false): ThreadSummary {
    return this.cacheThread(thread, archived, true);
  }

  private cacheThread(thread: Thread, archived: boolean, reveal: boolean): ThreadSummary {
    const state = this.store.view();
    const current = this.threads.get(thread.id);
    let latestThread =
      current && current.thread.updatedAt > thread.updatedAt
        ? { ...thread, updatedAt: current.thread.updatedAt }
        : thread;
    if (current?.thread.turns.length && latestThread.turns.length === 0) {
      latestThread = { ...latestThread, turns: current.thread.turns };
    }
    const cached = {
      thread: latestThread,
      archived,
      currentTurnId: activeTurnId(latestThread),
      liveOutcome: current?.liveOutcome,
      goalStatus: current?.goalStatus,
      stoppedGoalForTurn: current?.stoppedGoalForTurn,
    };
    this.threads.set(thread.id, cached);
    if (reveal) this.hiddenThreads.delete(thread.id);
    else if (this.isInternalPendingForkThread(latestThread, state))
      this.hiddenThreads.add(thread.id);
    else this.hiddenThreads.delete(thread.id);
    this.queueSessionSnapshot(thread.id);
    if (this.syncedAt !== null) this.scheduleSessionRetention();
    return this.publishThread(thread.id, state)!;
  }

  async refreshThread(
    threadId: string,
    options: { requireFresh?: boolean } = {},
  ): Promise<ThreadSummary | undefined> {
    const baselineRevision = this.historyRevision(threadId);
    let response;
    try {
      response = parseThreadRead(
        await this.bridge.request<unknown>(
          "thread/read",
          { threadId, includeTurns: false },
          30_000,
        ),
      );
    } catch (error) {
      if (isMissingThreadError(error)) {
        return this.summary(threadId);
      }
      if (error instanceof RpcError && this.threads.has(threadId)) {
        if (options.requireFresh) {
          throw new ThreadViewUnavailableError("Thread summary is temporarily unavailable");
        }
        return this.summary(threadId);
      }
      throw error;
    }
    if (this.historyRevision(threadId) !== baselineRevision) return this.summary(threadId);
    const current = this.threads.get(threadId);
    if (wouldRollbackLiveTurn(current, response.thread)) return this.summary(threadId);
    const archived = current?.archived ?? false;
    return this.upsertThread(response.thread, archived);
  }

  async readTurnItems(threadId: string, turnId: string): Promise<TurnItemsResponse> {
    const startedAt = Date.now();
    let cursor: string | null = null;
    let items: ActivityItem[] = [];
    let pages = 0;
    do {
      const page = parseTurnsList(
        await this.bridge.request<unknown>(
          "thread/turns/list",
          { threadId, cursor, limit: 100, sortDirection: "desc", itemsView: "full" },
          30_000,
        ),
      );
      pages += 1;
      const turn = page.data.find((candidate) => candidate.id === turnId);
      if (turn) {
        const artifacts = { [turnId]: this.timelineArtifacts(threadId, turnId) };
        await recoverTimelineOrder(this.rolloutPath(threadId), [turn], artifacts);
        items = normalizeTurn(
          turn,
          this.progress.get(turnKey(threadId, turnId)),
          turn.status === "inProgress"
            ? this.liveActivities(threadId, turnId)
            : this.terminalActivityOverlay(
                threadId,
                turnId,
                projectedTurnItemIds(turn),
                normalizeOutcome(turn.status),
              ),
          artifacts[turnId],
          true,
          this.interruptedTextActivities(threadId, turnId),
        ).items;
        break;
      }
      cursor = page.nextCursor;
    } while (cursor);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 500) {
      process.stderr.write(
        `CodexNest turn items read slow (${durationMs}ms, ${pages} pages, ${items.length} items)\n`,
      );
    }
    return {
      threadId,
      turnId,
      items: items.map((item) => this.withDeliveryReceipt(threadId, turnId, item)),
    };
  }

  async markUnmaterialized(threadId: string): Promise<void> {
    if (!this.threads.has(threadId)) throw new Error("Thread not found");
    this.unmaterializedThreads.add(threadId);
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.unmaterialized = true;
      state.threadMeta[threadId] = meta;
    });
  }

  isUnmaterialized(threadId: string): boolean {
    return (
      this.unmaterializedThreads.has(threadId) ||
      this.store.view().threadMeta[threadId]?.unmaterialized === true
    );
  }

  canMaterializeEmptySession(threadId: string): boolean {
    const cached = this.threads.get(threadId);
    const state = this.store.view();
    const meta = state.threadMeta[threadId];
    const summary = cached ? this.toSummary(cached, state) : undefined;
    return Boolean(
      cached &&
      summary?.projectId &&
      summary.relation.kind === "session" &&
      !cached.archived &&
      !cached.currentTurnId &&
      !cached.thread.turns.length &&
      !cached.thread.preview.trim() &&
      !cached.thread.forkedFromId &&
      !meta?.logicalFork &&
      !meta?.lastOutcome &&
      !meta?.lastResult &&
      !meta?.teamOrchestration &&
      meta?.managedTeamToolsAvailable &&
      meta.sessionArtifactsVersion === 1 &&
      Object.values(state.threadCreations ?? {}).some(
        (creation) => creation.threadId === threadId,
      ) &&
      !Object.values(state.messageReceipts ?? {}).some(
        (receipt) =>
          receipt.threadId === threadId &&
          receipt.status !== "rejected" &&
          receipt.status !== "canceled",
      ),
    );
  }

  async materializeEmptySession(threadId: string): Promise<void> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    // Initialize stored metadata before reading history. Paginated metadata
    // updates do not persist the rollout, but an empty history read does.
    await this.bridge.request(
      "thread/metadata/update",
      { threadId, gitInfo: { sha: cached.thread.gitInfo?.sha ?? null } },
      30_000,
    );
    await this.bridge.request("thread/read", { threadId, includeTurns: true }, 30_000);
    await this.markMaterialized(threadId, { preserveDraft: true });
  }

  async markMaterialized(
    threadId: string,
    options: { preserveDraft?: boolean } = {},
  ): Promise<void> {
    this.unmaterializedThreads.delete(threadId);
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.unmaterialized = false;
      if (!options.preserveDraft) delete meta.draft;
      state.threadMeta[threadId] = meta;
    });
  }

  async restoreDeliveredTurn(threadId: string, turn: Turn): Promise<void> {
    const cached = this.threads.get(threadId);
    if (!cached) return;
    if (this.isUnmaterialized(threadId)) await this.markMaterialized(threadId);
    const index = cached.thread.turns.findIndex((candidate) => candidate.id === turn.id);
    const existing = cached.thread.turns[index];
    const knownState = this.turnStates.get(turnKey(threadId, turn.id));
    if (knownState && knownState.status !== "inProgress" && turn.status === "inProgress") {
      return;
    }
    // A completion notification may have arrived while history was being read.
    const source = existing && existing.status !== "inProgress" ? existing : turn;
    if (index < 0) cached.thread.turns.push(source);
    else cached.thread.turns[index] = source;
    if (source.status !== "inProgress") {
      if (source === turn) await this.completeTurn(threadId, source);
      return;
    }
    if (!cached.currentTurnId) {
      await this.setCurrentTurn(threadId, source.id);
    }
    this.replaceTurnState(threadId, source.id, { source, publish: true });
    await this.clearCompletedUserInputs(threadId, [source]);
    await this.saveSessionSnapshot(threadId, true);
    if (cached.currentTurnId === source.id) {
      // An acknowledged turn absent from live state means its start event was
      // missed. A subscription remembered from an earlier turn is not proof
      // that this connection still receives the thread's events.
      if (!existing) this.subscribedThreads.delete(threadId);
      const resumed = await this.rejoinActiveThread(cached.thread);
      await this.reconcileCompletedTurn(threadId, resumed.thread.turns);
    }
  }

  async setCurrentTurn(threadId: string, turnId: string): Promise<void> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    const knownTurn = cached.thread.turns.find((turn) => turn.id === turnId);
    if (knownTurn && knownTurn.status !== "inProgress") return;
    cached.currentTurnId = turnId;
    cached.liveOutcome = undefined;
    cached.thread.status = { type: "active", activeFlags: [] };
    cached.thread.updatedAt = Math.max(cached.thread.updatedAt, Math.floor(Date.now() / 1_000));
    if (this.store.view().threadMeta[threadId]?.awaitingPlanResponse) {
      await this.store.update((state) => {
        const meta = state.threadMeta[threadId];
        if (meta) meta.awaitingPlanResponse = false;
      });
    }
    this.queueSessionSnapshot(threadId);
    this.publishThread(threadId);
  }

  async cancelCapacityRetry(
    threadId: string,
    failedTurnId?: string,
    publish = true,
  ): Promise<void> {
    if (!this.store.view().threadMeta[threadId]?.capacityRetry) return;
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId];
      if (
        !meta?.capacityRetry ||
        (failedTurnId && meta.capacityRetry.failedTurnId !== failedTurnId)
      )
        return;
      meta.capacityRetryHandledTurnId = meta.capacityRetry.failedTurnId;
      delete meta.capacityRetry;
    });
    if (publish) this.publishThread(threadId);
  }

  async prepareCapacityRetry(threadId: string, turn: Turn, goal?: ThreadGoal): Promise<void> {
    const cached = this.threads.get(threadId);
    if (
      !cached ||
      !isCapacityFailure(turn) ||
      (cached.currentTurnId && cached.currentTurnId !== turn.id)
    )
      return;
    if (goal) cached.stoppedGoalForTurn = { turnId: turn.id, goal };
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId];
      if (meta?.capacityRetry?.failedTurnId === turn.id && goal?.status === "blocked") {
        meta.capacityRetry.goal = {
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt,
          objective: goal.objective,
        };
      }
      if (meta) this.updateCapacityRetry(meta, cached, turn, false);
    });
    this.publishThread(threadId);
  }

  async markInterrupted(threadId: string, expectedTurnIds: readonly string[]): Promise<void> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    for (const turnId of expectedTurnIds) {
      const source = cached.thread.turns.find((turn) => turn.id === turnId);
      if (source?.status === "inProgress") source.status = "interrupted";
      this.replaceTurnState(threadId, turnId);
      const turn = this.turnStates.get(turnKey(threadId, turnId))!;
      if (turn.status === "inProgress") turn.status = "interrupted";
    }
    await Promise.all(
      expectedTurnIds.map((turnId) => this.clearUserInputsForTurn(threadId, turnId)),
    );
    if (cached.currentTurnId && !expectedTurnIds.includes(cached.currentTurnId)) return;
    const interruptedTextActivities = new Map(
      expectedTurnIds.map((turnId) => [
        turnId,
        this.collectInterruptedTextActivities(threadId, turnId),
      ]),
    );
    cached.currentTurnId = null;
    cached.liveOutcome = "interrupted";
    cached.thread.status = { type: "idle" };
    cached.thread.updatedAt = Math.max(cached.thread.updatedAt, Math.floor(Date.now() / 1_000));
    const updatedAt = cached.thread.updatedAt * 1_000;
    let retainedTextChanged = false;
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.lastOutcome = "interrupted";
      if (expectedTurnIds.length) {
        meta.capacityRetryHandledTurnId = expectedTurnIds.at(-1);
      }
      meta.outcomeUpdatedAt = updatedAt;
      const turnId = expectedTurnIds.at(-1);
      if (turnId && meta.lastResult?.turnId !== turnId) {
        meta.lastResult = { turnId, completedAt: updatedAt };
      }
      for (const [turnId, items] of interruptedTextActivities) {
        retainedTextChanged =
          updateInterruptedTextActivities(meta, turnId, items, "merge") || retainedTextChanged;
      }
      state.threadMeta[threadId] = meta;
    });
    if (retainedTextChanged) {
      this.bumpHistoryRevision(threadId);
      await this.historyCache.invalidateThread(threadId);
    }
    await this.saveSessionSnapshot(threadId, true);
    this.publishThread(threadId);
  }

  async setArchived(threadId: string, archived: boolean): Promise<ThreadSummary> {
    const cached = this.threads.get(threadId);
    if (!cached) throw new Error("Thread not found");
    cached.archived = archived;
    await this.saveSessionSnapshot(threadId, true);
    return this.publishThread(threadId)!;
  }

  async recordAttentionResponse(
    request: AttentionRequest,
    response: AttentionResponse,
    recordAnswers = true,
  ): Promise<void> {
    if (
      request.kind !== "userInput" ||
      response.kind !== "userInput" ||
      !request.threadId ||
      !request.turnId
    ) {
      return;
    }
    if (!recordAnswers) {
      await this.clearUserInputDraft(request);
      return;
    }
    this.flushActivityDeltas(request.threadId, request.turnId);
    const item: TimelineArtifact = {
      type: "userInputResponse",
      id: `${request.itemId ?? request.id}-response`,
      status: "completed",
      entries: request.questions.map((question) => ({
        header: question.header,
        question: question.question,
        answers: response.answers[question.id] ?? [],
      })),
      timestamp: Date.now(),
      afterItemId: this.latestConversationActivityId(request.threadId, request.turnId),
    };
    await this.clearUserInputDraft(request);
    await this.upsertTimelineArtifact(request.threadId, request.turnId, item);
  }

  async updateUserInputDraft(
    request: Extract<AttentionRequest, { kind: "userInput" }>,
    body: UpdateUserInputDraftRequest,
  ): Promise<UserInputDraft> {
    const identity = userInputDraftIdentity(request);
    if (!identity) throw new Error("User input request has no stable identity");
    let saved!: UserInputDraft;
    await this.store.update((state) => {
      const meta = state.threadMeta[identity.threadId] ?? {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      const previous = meta.userInputDrafts?.[identity.key];
      if (previous?.submission)
        throw new ThreadDraftConflictError("Answers are already being submitted");
      const merged = appendUserInputRecordings(
        body,
        Object.values(state.voiceTranscriptions ?? {}).filter(
          (job) => job.threadId === identity.threadId && job.userInput?.draftKey === identity.key,
        ),
      );
      saved = {
        answers: structuredClone(merged.answers),
        currentQuestionId: body.currentQuestionId,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: Date.now(),
        ...(merged.appliedRecordingIds ? { appliedRecordingIds: merged.appliedRecordingIds } : {}),
      };
      meta.userInputDrafts ??= {};
      meta.userInputDrafts[identity.key] = {
        ...saved,
        turnId: identity.turnId,
        itemId: identity.itemId,
        fingerprint: identity.fingerprint,
      };
      state.threadMeta[identity.threadId] = meta;
    });
    const active = this.attention.get(request.id);
    if (active?.kind === "userInput" && userInputDraftIdentity(active)?.key === identity.key) {
      const state = this.store.view();
      if (this.isThreadVisible(identity.threadId, state)) {
        this.publish({
          type: "attention.upserted",
          attention: this.enrichAttention(active, state),
        });
      }
    }
    return saved;
  }

  async recordOrchestrationNotice(
    threadId: string,
    turnId: string,
    agents: Extract<ActivityItem, { type: "orchestrationNotice" }>["agents"],
    afterItemId: string | null,
  ): Promise<void> {
    if (!agents.length) return;
    const timestamp = Date.now();
    await this.upsertTimelineArtifact(
      threadId,
      turnId,
      {
        type: "orchestrationNotice",
        id: `orchestration-${turnId}-${agents
          .map((agent) => agent.threadId)
          .sort()
          .join("-")}`,
        status: "completed",
        agents,
        timestamp,
        afterItemId,
      },
      agents.filter((agent) => agent.outcome === "completed").map((agent) => agent.threadId),
      timestamp,
    );
  }

  publishThreadState(threadId: string): void {
    this.publishThread(threadId);
  }

  recordUserMessage(
    threadId: string,
    turnId: string,
    messageId: string,
    text: string,
    images: string[],
    files: Array<{ name: string; path: string }> = [],
  ): void {
    const key = activityKey(threadId, turnId, messageId);
    const existing = this.activity.get(key);
    if (existing?.type === "userMessage") {
      const confirmed = this.withDeliveryReceipt(threadId, turnId, existing);
      if (confirmed !== existing) {
        this.activity.set(key, confirmed);
        this.publishActivityUpsert(threadId, turnId, confirmed);
      }
      return;
    }
    const item: ActivityItem = {
      type: "userMessage",
      id: messageId,
      status: "completed",
      text: text.trim(),
      images,
      ...(files.length ? { files } : {}),
      timestamp: Date.now(),
      phase: null,
    };
    this.flushActivityDeltas(threadId, turnId);
    this.activity.set(key, item);
    this.bumpHistoryRevision(threadId);
    this.publishActivityUpsert(threadId, turnId, item);
    this.touchThreadActivity(threadId, item.timestamp ?? Date.now());
  }

  private async upsertTimelineArtifact(
    threadId: string,
    turnId: string,
    item: TimelineArtifact,
    deliveredThreadIds: readonly string[] = [],
    deliveredAt = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const readMarkers = this.readMarkers(deliveredThreadIds, deliveredAt);
    const markedRead: string[] = [];
    await this.store.update((state) => {
      const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
      meta.timelineArtifacts ??= {};
      const items = meta.timelineArtifacts[turnId] ?? [];
      const index = items.findIndex((candidate) => candidate.id === item.id);
      meta.timelineArtifacts[turnId] =
        index < 0
          ? [...items, item]
          : items.map((candidate, itemIndex) => (itemIndex === index ? item : candidate));
      state.threadMeta[threadId] = meta;
      if (index < 0) markedRead.push(...applyReadMarkers(state, readMarkers));
    });
    this.flushActivityDeltas(threadId, turnId);
    this.activity.set(activityKey(threadId, turnId, item.id), item);
    this.bumpHistoryRevision(threadId);
    this.publishActivityUpsert(threadId, turnId, item);
    this.touchThreadActivity(threadId, item.timestamp);
    if (markedRead.length) {
      const state = this.store.view();
      for (const deliveredThreadId of markedRead) this.publishThread(deliveredThreadId, state);
    }
  }

  private historyRevision(threadId: string): number {
    return this.historyRevisions.get(threadId) ?? 0;
  }

  private bumpHistoryRevision(threadId: string): void {
    this.historyRevisions.set(threadId, this.historyRevision(threadId) + 1);
  }

  private latestActivityId(threadId: string, turnId: string): string | null {
    const prefix = `${threadId}:${turnId}:`;
    let latest: string | null = null;
    for (const [key, item] of this.activity.entries()) {
      if (key.startsWith(prefix) && item.type !== "planChecklist") latest = item.id;
    }
    return latest;
  }

  private latestConversationActivityId(threadId: string, turnId: string): string | null {
    const items = this.turnStates.get(turnKey(threadId, turnId))?.items ?? [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (isConversationMessage(items[index]!)) return items[index]!.id;
    }
    return null;
  }

  private timelineArtifacts(threadId: string, turnId: string): TimelineArtifact[] {
    const saved = this.store.view().threadMeta[threadId]?.timelineArtifacts?.[turnId] ?? [];
    if (!saved.length) return [];
    const artifacts = cloneView<TimelineArtifact[]>(saved);
    if (!artifacts.some((item) => item.type === "userInputResponse")) return artifacts;
    const previous =
      this.turnStates.get(turnKey(threadId, turnId))?.items ??
      this.latestDetails.get(threadId)?.turns.find((turn) => turn.id === turnId)?.items ??
      [];
    const ids = new Set(previous.map((item) => item.id));
    return artifacts.map((artifact) => {
      if (
        artifact.type !== "userInputResponse" ||
        !artifact.afterItemId ||
        ids.has(artifact.afterItemId)
      ) {
        return artifact;
      }
      const restored = previous.find((item) => item.id === artifact.id);
      return restored?.type === "userInputResponse" &&
        restored.afterItemId &&
        ids.has(restored.afterItemId)
        ? { ...artifact, afterItemId: restored.afterItemId, timestamp: restored.timestamp }
        : artifact;
    });
  }

  private liveActivities(threadId: string, turnId: string): ActivityItem[] {
    const prefix = `${threadId}:${turnId}:`;
    const items: ActivityItem[] = [];
    for (const [key, item] of this.activity.entries()) {
      if (key.startsWith(prefix) && !isTimelineArtifact(item)) items.push(item);
    }
    return items;
  }

  private interruptedTextActivities(
    threadId: string,
    turnId: string,
  ): DeepReadonly<InterruptedTextActivityState[]> {
    return this.store.view().threadMeta[threadId]?.interruptedReasoning?.[turnId] ?? [];
  }

  private collectInterruptedTextActivities(
    threadId: string,
    turnId: string,
    source?: Turn,
  ): InterruptedTextActivityState[] {
    const previous =
      this.turnStates.get(turnKey(threadId, turnId))?.items ??
      this.latestDetails.get(threadId)?.turns.find((candidate) => candidate.id === turnId)?.items ??
      [];
    const startedAt = source && source.startedAt !== null ? source.startedAt * 1_000 : null;
    const completedAt = source && source.completedAt !== null ? source.completedAt * 1_000 : null;
    const canonical = (source?.items ?? [])
      .filter((item) => !isInternalTeamContinuationItem(item))
      .map((item) =>
        normalizeActivity(
          item,
          item.type === "userMessage" ? startedAt : (completedAt ?? startedAt),
        ),
      );
    let items = source
      ? mergeLiveActivities(canonical, previous, "inProgress").items
      : [...previous];
    items = mergeLiveActivities(items, this.liveActivities(threadId, turnId), "inProgress").items;
    const timeline = items.filter((item) => !isTimelineArtifact(item));
    return timeline.flatMap((item, index): InterruptedTextActivityState[] => {
      if (!isAssistantTextActivity(item) || !item.text.trim()) return [];
      return [
        {
          type: item.type,
          id: item.id,
          text: item.text,
          timestamp: item.timestamp,
          beforeItemId: timeline[index + 1]?.id ?? null,
          phase: item.phase,
        },
      ];
    });
  }

  private terminalActivityOverlay(
    threadId: string,
    turnId: string,
    existingIds: ReadonlySet<string>,
    outcome: ThreadOutcome,
  ): ActivityItem[] {
    // Terminal notifications and summary history pages may omit inputs that were already accepted.
    // Retain missing user messages together with canonical timeline anchors so steering inputs keep
    // their live position instead of being appended after the terminal response. Keep dialogue
    // omitted from terminal summaries, and all assistant text when a turn was interrupted.
    const retained: ActivityItem[] = [];
    const seen = new Set<string>();
    const append = (items: readonly ActivityItem[] | undefined) => {
      for (const item of items ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (
          existingIds.has(item.id) ||
          isConversationMessage(item) ||
          (outcome === "interrupted" && isAssistantTextActivity(item))
        ) {
          retained.push(item);
        }
      }
    };
    append(this.turnStates.get(turnKey(threadId, turnId))?.items);
    append(
      this.latestDetails.get(threadId)?.turns.find((candidate) => candidate.id === turnId)?.items,
    );
    append(this.liveActivities(threadId, turnId));
    return retained;
  }

  private replaceTurnState(
    threadId: string,
    turnId: string,
    options: { publish?: boolean; source?: Turn } = {},
  ): void {
    const key = turnKey(threadId, turnId);
    const cached = this.threads.get(threadId);
    const source = options.source ?? cached?.thread.turns.find((turn) => turn.id === turnId);
    let turn: TurnView;
    if (source) {
      turn = normalizeTurn(
        source,
        this.progress.get(key),
        source.status === "inProgress"
          ? this.liveActivities(threadId, turnId)
          : this.terminalActivityOverlay(
              threadId,
              turnId,
              projectedTurnItemIds(source),
              normalizeOutcome(source.status),
            ),
        this.timelineArtifacts(threadId, turnId),
        source.itemsView === "full",
        this.interruptedTextActivities(threadId, turnId),
      );
    } else {
      const previous =
        this.turnStates.get(key) ??
        this.latestDetails.get(threadId)?.turns.find((candidate) => candidate.id === turnId);
      turn = this.overlayLiveTurn(
        threadId,
        previous ?? {
          id: turnId,
          status: "inProgress",
          startedAt: this.progress.get(key)?.startedAt ?? null,
          completedAt: null,
          durationMs: null,
          progress: this.progress.get(key) ?? emptyProgress(null),
          items: [],
          itemsLoaded: false,
        },
      );
    }
    this.turnStates.set(key, turn);
    this.replaceLatestTurn(threadId, turn);
    if (options.publish) this.publishTurnReplacement(threadId, turnId);
  }

  private publishTurnReplacement(threadId: string, turnId: string): void {
    const key = turnKey(threadId, turnId);
    const turn = this.turnStates.get(key);
    if (!turn) return;
    this.publish({ type: "turn.replaced", threadId, turn: cloneView<TurnView>(turn) });
    this.markLatestDetailCurrent(threadId);
  }

  private publishActivityUpsert(threadId: string, turnId: string, item: ActivityItem): void {
    this.replaceTurnState(threadId, turnId);
    this.publish({
      type: "activity.upserted",
      threadId,
      turnId,
      item: cloneView<ActivityItem>(item),
    });
    this.markLatestDetailCurrent(threadId);
  }

  private publishTurnProgress(threadId: string, turnId: string, progress: TurnProgress): void {
    this.flushActivityDeltas(threadId, turnId);
    this.replaceTurnState(threadId, turnId);
    this.publish({
      type: "turn.progressed",
      threadId,
      turnId,
      progress: cloneView<TurnProgress>(progress),
    });
    this.markLatestDetailCurrent(threadId);
  }

  private queueActivityDelta(
    threadId: string,
    turnId: string,
    itemId: string,
    activityType: PendingActivityDelta["activityType"],
    delta: string,
  ): void {
    if (!delta) return;
    const key = turnKey(threadId, turnId);
    let batch = this.pendingActivityDeltas.get(key);
    if (!batch) {
      batch = { threadId, turnId, items: new Map() };
      this.pendingActivityDeltas.set(key, batch);
    }
    const previous = batch.items.get(itemId);
    if (previous && previous.activityType !== activityType) {
      this.flushActivityDeltas(threadId, turnId);
      this.queueActivityDelta(threadId, turnId, itemId, activityType, delta);
      return;
    }
    batch.items.set(itemId, {
      itemId,
      activityType,
      delta: (previous?.delta ?? "") + delta,
    });
    if (this.activityDeltaTimers.has(key)) return;
    const timer = setTimeout(() => {
      if (this.activityDeltaTimers.get(key) !== timer) return;
      this.flushActivityDeltas(threadId, turnId);
    }, LIVE_ACTIVITY_DELTA_FLUSH_MS);
    timer.unref();
    this.activityDeltaTimers.set(key, timer);
  }

  private flushActivityDeltas(threadId: string, turnId: string): void {
    const key = turnKey(threadId, turnId);
    const timer = this.activityDeltaTimers.get(key);
    if (timer) clearTimeout(timer);
    this.activityDeltaTimers.delete(key);
    const batch = this.pendingActivityDeltas.get(key);
    if (!batch) return;
    this.pendingActivityDeltas.delete(key);
    this.replaceTurnState(threadId, turnId);
    for (const item of batch.items.values()) {
      this.publish({
        type: "activity.delta",
        threadId,
        turnId,
        itemId: item.itemId,
        activityType: item.activityType,
        delta: item.delta,
      });
    }
    this.markLatestDetailCurrent(threadId);
  }

  private discardActivityDeltas(threadId: string, turnId: string): void {
    const key = turnKey(threadId, turnId);
    const timer = this.activityDeltaTimers.get(key);
    if (timer) clearTimeout(timer);
    this.activityDeltaTimers.delete(key);
    this.pendingActivityDeltas.delete(key);
  }

  private markLatestDetailCurrent(threadId: string): void {
    const detail = this.latestDetails.get(threadId);
    if (detail) this.latestDetails.set(threadId, { ...detail, version: this.version });
  }

  private replaceLatestTurn(threadId: string, turn: TurnView): void {
    const detail = this.latestDetails.get(threadId);
    if (!detail) return;
    const turns = [...detail.turns];
    const index = turns.findIndex((candidate) => candidate.id === turn.id);
    if (index >= 0) turns[index] = turn;
    else turns.push(turn);
    this.latestDetails.set(threadId, {
      ...detail,
      version: this.version,
      turns: turns.slice(-(THREAD_TURN_PAGE_SIZE + 2)),
    });
  }

  private clearTurnActivities(threadId: string, turnId: string): void {
    this.discardActivityDeltas(threadId, turnId);
    const prefix = `${threadId}:${turnId}:`;
    for (const key of [...this.activity.keys()]) {
      if (key.startsWith(prefix)) this.activity.delete(key);
    }
  }

  private hasLivePlan(threadId: string, turnId: string): boolean {
    const prefix = `${threadId}:${turnId}:`;
    for (const [key, item] of this.activity.entries()) {
      if (key.startsWith(prefix) && item.type === "plan" && item.text.trim()) return true;
    }
    return false;
  }

  private async performSync(): Promise<void> {
    const startedAt = Date.now();
    const revisionBaseline = new Map(this.historyRevisions);
    const changedDuringSync = (threadId: string) =>
      this.historyRevision(threadId) !== (revisionBaseline.get(threadId) ?? 0);
    const shouldRecoverLoaded = this.recoverLoadedThreads;
    const recoveryTurns = new Map(
      shouldRecoverLoaded
        ? [...this.threads.values()].flatMap((cached) =>
            cached.currentTurnId ? [[cached.thread.id, cached.currentTurnId] as const] : [],
          )
        : [],
    );
    let loadedRecoveryFailed = false;
    const [listedActive, archived, models, loadedThreadIds] = await Promise.all([
      this.listAllThreads(false),
      this.listAllThreads(true),
      this.listAllModels(),
      shouldRecoverLoaded
        ? this.listAllLoadedThreadIds().catch((error: unknown) => {
            this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
            loadedRecoveryFailed = true;
            return [];
          })
        : Promise.resolve([]),
    ]);
    this.models = models;
    const listedIds = new Set([...listedActive, ...archived].map((thread) => thread.id));
    const loadedIds = new Set(loadedThreadIds);
    const recovered = await this.readThreadsOmittedFromList(loadedThreadIds, listedIds);
    const activeCandidates = [...listedActive, ...recovered.threads];
    const active = await Promise.all(
      activeCandidates.map(async (thread) => {
        if (this.removedThreads.has(thread.id)) {
          return {
            thread,
            restoredGoalStatus: undefined,
            recoveryFailed: false,
          };
        }
        const cachedGoalStatus = this.threads.get(thread.id)?.goalStatus;
        const recoverLoadedThread =
          shouldRecoverLoaded && loadedIds.has(thread.id) && thread.status.type === "notLoaded";
        const [resumed, restoredGoalStatus] = await Promise.all([
          this.rejoinActiveThread(thread, recoverLoadedThread),
          (thread.status.type === "active" || recoverLoadedThread) &&
          !isSpawnedSubagent(thread) &&
          cachedGoalStatus === undefined
            ? this.readThreadGoalStatus(thread.id)
            : Promise.resolve(cachedGoalStatus),
        ]);
        return { thread: resumed.thread, restoredGoalStatus, recoveryFailed: resumed.failed };
      }),
    );
    const incoming = new Set<string>();
    for (const { thread, restoredGoalStatus } of active) {
      if (this.removedThreads.has(thread.id)) continue;
      incoming.add(thread.id);
      if (thread.turns.some((turn) => turn.id === recoveryTurns.get(thread.id))) {
        recoveryTurns.delete(thread.id);
      }
      const recovering = this.threads.get(thread.id);
      if (recovering && recovering.goalStatus === undefined) {
        recovering.goalStatus = restoredGoalStatus;
      }
      await this.reconcileCompletedTurn(thread.id, thread.turns);
      if (changedDuringSync(thread.id)) continue;
      const liveCached = this.threads.get(thread.id);
      if (wouldRollbackLiveTurn(liveCached, thread)) continue;
      const liveGoalStatus = liveCached?.goalStatus;
      const latestThread =
        liveCached && liveCached.thread.updatedAt > thread.updatedAt
          ? { ...thread, updatedAt: liveCached.thread.updatedAt }
          : thread;
      const resumedTurnId = activeTurnId(latestThread);
      this.threads.set(thread.id, {
        thread: latestThread,
        archived: false,
        currentTurnId:
          resumedTurnId ??
          (latestThread.status.type === "active" ? (liveCached?.currentTurnId ?? null) : null),
        goalStatus: liveGoalStatus === undefined ? restoredGoalStatus : liveGoalStatus,
        stoppedGoalForTurn: liveCached?.stoppedGoalForTurn,
      });
      this.hydrateLiveTurn(latestThread);
      await this.clearCompletedUserInputs(thread.id, latestThread.turns);
    }
    for (const thread of archived) {
      if (this.removedThreads.has(thread.id)) continue;
      incoming.add(thread.id);
      if (changedDuringSync(thread.id)) continue;
      const liveCached = this.threads.get(thread.id);
      const latestThread =
        liveCached && liveCached.thread.updatedAt > thread.updatedAt
          ? { ...thread, updatedAt: liveCached.thread.updatedAt }
          : thread;
      this.threads.set(thread.id, {
        thread: latestThread,
        archived: true,
        currentTurnId: activeTurnId(latestThread),
        goalStatus: liveCached?.goalStatus,
        stoppedGoalForTurn: liveCached?.stoppedGoalForTurn,
      });
    }
    const state = this.store.view();
    for (const id of this.threads.keys()) {
      const cached = this.threads.get(id);
      const parentThreadId = cached
        ? (cached.thread.parentThreadId ??
          state.threadMeta[id]?.managedParent?.parentThreadId ??
          null)
        : null;
      if (
        !incoming.has(id) &&
        !changedDuringSync(id) &&
        !this.unmaterializedThreads.has(id) &&
        !this.subscribedThreads.has(id) &&
        !state.threadMeta[id]?.sessionSnapshot &&
        (!cached || !isRecoverableUserSession(cached.thread)) &&
        (!cached || !parentThreadId || !incoming.has(parentThreadId))
      ) {
        this.threads.delete(id);
      }
    }

    await this.store.update((state) => {
      for (const cached of this.threads.values()) {
        const meta = state.threadMeta[cached.thread.id] ?? {
          pinned: false,
          lastReadUpdatedAt: cached.thread.updatedAt * 1_000,
        };
        const snapshot = sessionSnapshot(cached);
        if (snapshot && !sessionSnapshotsEqual(meta.sessionSnapshot, snapshot)) {
          meta.sessionSnapshot = snapshot;
        }
        state.threadMeta[cached.thread.id] = meta;
      }
    });
    await this.reconcileOutcomes(recoveryTurns);
    this.syncedAt = new Date().toISOString();
    if (shouldRecoverLoaded) {
      const recoveryFailed =
        loadedRecoveryFailed || recovered.failed || active.some((item) => item.recoveryFailed);
      if (recoveryFailed) this.scheduleLoadedRecovery();
      else this.finishLoadedRecovery();
    }
    this.publish({ type: "models.changed", models });
    this.publish({ type: "resync.required" });
    this.backfillSubagentTitles();
    this.scheduleMissingManagedThreadRecovery();
    this.scheduleSessionRetention();
    this.scheduleAutoFinish();
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 1_000) {
      process.stderr.write(
        `CodexNest projection sync slow (${durationMs}ms, ${listedActive.length} active, ${archived.length} archived)\n`,
      );
    }
  }

  private finishLoadedRecovery(): void {
    this.recoverLoadedThreads = false;
    this.loadedRecoveryAttempt = 0;
    if (this.loadedRecoveryTimer) clearTimeout(this.loadedRecoveryTimer);
    this.loadedRecoveryTimer = undefined;
  }

  private scheduleLoadedRecovery(): void {
    if (this.loadedRecoveryTimer || this.bridge.state !== "ready") return;
    const delay =
      LOADED_RECOVERY_DELAYS_MS[
        Math.min(this.loadedRecoveryAttempt, LOADED_RECOVERY_DELAYS_MS.length - 1)
      ]!;
    this.loadedRecoveryAttempt += 1;
    this.loadedRecoveryTimer = setTimeout(() => {
      this.loadedRecoveryTimer = undefined;
      void this.sync().catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      });
    }, delay);
    this.loadedRecoveryTimer.unref();
  }

  private scheduleMissingManagedThreadRecovery(): void {
    if (this.managedRecoveryTimer || this.bridge.state !== "ready") return;
    const missing = this.missingManagedThreadIds();
    if (!missing.length) {
      this.managedRecoveryAttempt = 0;
      return;
    }
    const delay = MANAGED_RECOVERY_DELAYS_MS[this.managedRecoveryAttempt];
    if (delay === undefined) return;
    this.managedRecoveryAttempt += 1;
    this.managedRecoveryTimer = setTimeout(() => {
      this.managedRecoveryTimer = undefined;
      void this.recoverMissingManagedThreads(missing).catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
        this.scheduleMissingManagedThreadRecovery();
      });
    }, delay);
    this.managedRecoveryTimer.unref();
  }

  private scheduleAutoFinish(delayMs = 0): void {
    if (
      this.syncedAt === null ||
      this.recoverLoadedThreads ||
      this.bridge.state !== "ready" ||
      this.autoFinishTimer ||
      this.autoFinishRunning
    )
      return;
    this.autoFinishTimer = setTimeout(() => {
      this.autoFinishTimer = undefined;
      this.autoFinishRunning = true;
      void this.finishInactiveSessions()
        .catch((error: unknown) => {
          this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          this.autoFinishRunning = false;
          this.scheduleAutoFinish(AUTO_FINISH_INTERVAL_MS);
        });
    }, delayMs);
    this.autoFinishTimer.unref();
  }

  private scheduleSessionRetention(delayMs = 0): void {
    if (
      !this.sessionLimit ||
      this.threads.size <= this.sessionLimit ||
      this.bridge.state !== "ready" ||
      this.sessionRetentionTimer ||
      this.sessionRetentionRunning
    ) {
      return;
    }
    this.sessionRetentionTimer = setTimeout(() => {
      this.sessionRetentionTimer = undefined;
      this.sessionRetentionRunning = true;
      void this.pruneOldestSessions(this.sessionLimit!, SESSION_RETENTION_BATCH_SIZE)
        .then((deleted) => {
          if (deleted > 0 && this.threads.size > this.sessionLimit!) {
            this.sessionRetentionRunning = false;
            this.scheduleSessionRetention(1_000);
          }
        })
        .catch((error: unknown) => {
          this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          this.sessionRetentionRunning = false;
        });
    }, delayMs);
    this.sessionRetentionTimer.unref();
  }

  async pruneOldestSessions(
    limit: number,
    batchSize = SESSION_RETENTION_BATCH_SIZE,
  ): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Session limit must be positive");
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error("Session retention batch size must be positive");
    }
    const excess = this.threads.size - limit;
    if (excess <= 0 || this.bridge.state !== "ready") return 0;

    const protectedThreadIds = retentionProtectedThreadIds(
      this.store.view(),
      this.threads.values(),
    );

    const candidates = [...this.threads.values()]
      .filter(
        (cached) =>
          cached.currentTurnId === null &&
          cached.thread.status.type !== "active" &&
          !protectedThreadIds.has(cached.thread.id),
      )
      .sort(
        (left, right) =>
          threadLastActivityAt(left.thread) - threadLastActivityAt(right.thread) ||
          left.thread.createdAt - right.thread.createdAt ||
          left.thread.id.localeCompare(right.thread.id),
      )
      .slice(0, Math.min(excess, batchSize));

    let deleted = 0;
    for (const cached of candidates) {
      if (this.bridge.state !== "ready") break;
      const current = this.threads.get(cached.thread.id);
      if (
        !current ||
        current.currentTurnId !== null ||
        current.thread.status.type === "active" ||
        retentionProtectedThreadIds(this.store.view(), this.threads.values()).has(cached.thread.id)
      ) {
        continue;
      }
      try {
        await this.bridge.request("thread/delete", { threadId: cached.thread.id }, 30_000);
      } catch (error) {
        if (!isMissingThreadError(error)) throw error;
      }
      await this.removeOrphanedThread(cached.thread.id);
      deleted += 1;
    }
    if (deleted > 0) {
      process.stderr.write(
        `CodexNest session retention pruned ${deleted} old session${deleted === 1 ? "" : "s"} (${this.threads.size} remain, limit ${limit})\n`,
      );
    } else if (this.threads.size > limit) {
      process.stderr.write(
        `CodexNest session retention could not reach limit ${limit}; ${this.threads.size} protected or active sessions remain\n`,
      );
    }
    return deleted;
  }

  private missingManagedThreadIds(): string[] {
    const referenced = managedThreadIds(this.store.view());
    return [...referenced].filter((threadId) => !this.threads.has(threadId));
  }

  private async recoverMissingManagedThreads(threadIds: readonly string[]): Promise<void> {
    if (this.bridge.state !== "ready") return;
    const stillReferenced = managedThreadIds(this.store.view());
    const recovered = await Promise.all(
      threadIds.map(async (threadId): Promise<Thread | null> => {
        if (this.threads.has(threadId) || !stillReferenced.has(threadId)) return null;
        try {
          const response = parseThreadRead(
            await this.bridge.request<unknown>(
              "thread/read",
              { threadId, includeTurns: false },
              30_000,
            ),
          );
          return response.thread;
        } catch {
          return null;
        }
      }),
    );
    let changed = false;
    for (const rawThread of recovered) {
      if (!rawThread || this.threads.has(rawThread.id)) continue;
      const { thread } = await this.rejoinActiveThread(rawThread);
      if (this.threads.has(thread.id)) continue;
      this.threads.set(thread.id, {
        thread,
        archived: false,
        currentTurnId: activeTurnId(thread),
      });
      this.hydrateLiveTurn(thread);
      changed = true;
    }
    if (changed) this.publish({ type: "resync.required" });
    this.scheduleMissingManagedThreadRecovery();
  }

  private backfillSubagentTitles(): void {
    const candidates = [...this.threads.values()]
      .filter(
        (cached) =>
          isSpawnedSubagent(cached.thread) &&
          !cached.thread.name?.trim() &&
          !this.subagentTitleUpdates.has(cached.thread.id),
      )
      .map((cached) => cached.thread.id);
    if (!candidates.length) return;

    void (async () => {
      for (const threadId of candidates) {
        const cached = this.threads.get(threadId);
        if (
          !cached ||
          !isSpawnedSubagent(cached.thread) ||
          cached.thread.name?.trim() ||
          this.subagentTitleUpdates.has(threadId)
        ) {
          continue;
        }
        this.subagentTitleUpdates.add(threadId);
        try {
          const page = parseTurnsList(
            await this.bridge.request<unknown>(
              "thread/turns/list",
              {
                threadId,
                limit: THREAD_TURN_PAGE_SIZE,
                sortDirection: "desc",
                itemsView: "full",
              },
              30_000,
            ),
          );
          const title = subagentTitleFromTurns(page.data);
          const current = this.threads.get(threadId);
          if (!title || !current || current.thread.name?.trim()) continue;
          current.thread.name = title;
          this.publishThread(threadId);
          await this.bridge.request("thread/name/set", { threadId, name: title });
        } catch (error) {
          this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.subagentTitleUpdates.delete(threadId);
        }
      }
    })();
  }

  private async rejoinActiveThread(
    thread: Thread,
    recoverLoaded = false,
  ): Promise<{ thread: Thread; failed: boolean }> {
    if (
      isSpawnedSubagent(thread) ||
      (thread.status.type !== "active" && !recoverLoaded) ||
      this.subscribedThreads.has(thread.id)
    ) {
      return { thread, failed: false };
    }
    try {
      const state = this.store.view();
      const meta = state.threadMeta[thread.id];
      const settings = meta?.settings;
      const managedParent = meta?.managedParent;
      const task = managedParent
        ? state.threadMeta[managedParent.parentThreadId]?.teamOrchestration?.tasks[
            managedParent.taskId
          ]
        : undefined;
      const serviceTier = task ? task.resolvedServiceTier : settings?.serviceTier;
      const modelId = task?.resolvedModel ?? settings?.model ?? thread.model;
      const model = modelId
        ? this.models.find((candidate) => candidate.id === modelId)
        : defaultModel(this.models);
      const resumed = parseThreadResume(
        await this.bridge.request<unknown>(
          "thread/resume",
          {
            threadId: thread.id,
            ...this.threadResumeConfigProvider(thread.id),
            serviceTier: isFastServiceTier(serviceTier) ? fastServiceTier(model) : null,
          },
          30_000,
        ),
      );
      this.subscribedThreads.add(thread.id);
      return {
        thread: {
          ...resumed.thread,
          updatedAt: Math.max(thread.updatedAt, resumed.thread.updatedAt),
        },
        failed: false,
      };
    } catch (error) {
      this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      return { thread, failed: !isMissingThreadError(error) };
    }
  }

  private queueSessionSnapshot(threadId: string): void {
    void this.saveSessionSnapshot(threadId, false).catch((error: unknown) => {
      this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async saveSessionSnapshot(threadId: string, durable: boolean): Promise<void> {
    const cached = this.threads.get(threadId);
    const snapshot = cached ? sessionSnapshot(cached) : null;
    if (!snapshot) return;
    const updatedAt = cached!.thread.updatedAt;
    const update = (state: CodexNestState) => {
      const meta = state.threadMeta[threadId] ?? {
        pinned: false,
        lastReadUpdatedAt: updatedAt * 1_000,
      };
      if (!sessionSnapshotsEqual(meta.sessionSnapshot, snapshot)) meta.sessionSnapshot = snapshot;
      state.threadMeta[threadId] = meta;
    };
    if (durable) await this.store.update(update);
    else await this.store.updateDeferred(update);
  }

  private async readThreadGoalStatus(
    threadId: string,
  ): Promise<ThreadGoal["status"] | null | undefined> {
    try {
      const response = await this.bridge.request<unknown>("thread/goal/get", { threadId }, 30_000);
      return parseThreadGoalStatus(response);
    } catch (error) {
      this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  }

  private hydrateLiveTurn(thread: Thread): void {
    for (const turn of thread.turns) {
      if (turn.status !== "inProgress") continue;
      const key = turnKey(thread.id, turn.id);
      if (!this.progress.has(key)) this.progress.set(key, emptyProgress(turn.startedAt));
      for (const rawItem of turn.items) {
        if (isInternalTeamContinuationItem(rawItem)) continue;
        const startedAt = turn.startedAt === null ? null : turn.startedAt * 1_000;
        const completedAt = turn.completedAt === null ? null : turn.completedAt * 1_000;
        const item = normalizeActivity(
          rawItem,
          rawItem.type === "userMessage" ? startedAt : (completedAt ?? startedAt),
        );
        const key = activityKey(thread.id, turn.id, item.id);
        if (!this.activity.has(key)) this.activity.set(key, item);
      }
      this.turnStates.set(
        key,
        normalizeTurn(
          turn,
          this.progress.get(key),
          this.liveActivities(thread.id, turn.id),
          this.timelineArtifacts(thread.id, turn.id),
          turn.itemsView === "full",
        ),
      );
    }
  }

  private async listAllThreads(archived: boolean): Promise<Thread[]> {
    const threads: Thread[] = [];
    let cursor: string | null = null;
    do {
      const page = parseThreadList(
        await this.bridge.request<unknown>(
          "thread/list",
          {
            cursor,
            limit: 100,
            sortKey: "updated_at",
            sortDirection: "desc",
            archived,
            sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown", "subAgentThreadSpawn"],
          },
          30_000,
        ),
      );
      threads.push(
        ...page.data.filter(
          (thread) =>
            !this.isInternalPendingForkThread(thread) &&
            (!thread.ephemeral || isSpawnedSubagent(thread)),
        ),
      );
      cursor = page.nextCursor;
    } while (cursor);
    return threads;
  }

  private async listAllLoadedThreadIds(): Promise<string[]> {
    const threadIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = parseThreadLoadedList(
        await this.bridge.request<unknown>("thread/loaded/list", { cursor, limit: 100 }, 30_000),
      );
      threadIds.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return threadIds;
  }

  private async readThreadsOmittedFromList(
    loadedThreadIds: string[],
    listedIds: Set<string>,
  ): Promise<{ threads: Thread[]; failed: boolean }> {
    const state = this.store.view();
    const loadedIds = new Set(loadedThreadIds);
    const managedParentIds = new Set<string>();
    const managedChildIds = new Set<string>();
    for (const [threadId, meta] of Object.entries(state.threadMeta)) {
      if (meta.teamOrchestration !== undefined) {
        managedParentIds.add(threadId);
        for (const task of Object.values(meta.teamOrchestration.tasks)) {
          managedChildIds.add(task.childThreadId);
        }
      }
      const parentThreadId = meta.managedParent?.parentThreadId;
      if (parentThreadId && state.threadMeta[parentThreadId] !== undefined) {
        managedParentIds.add(parentThreadId);
        managedChildIds.add(threadId);
      }
    }
    const candidates = new Set<string>();
    for (const threadId of loadedThreadIds) {
      if (listedIds.has(threadId)) continue;
      candidates.add(threadId);
    }
    for (const threadId of managedParentIds) {
      if (!listedIds.has(threadId)) candidates.add(threadId);
    }
    const recovered = await Promise.all(
      [...candidates].map(async (threadId): Promise<{ thread: Thread | null; failed: boolean }> => {
        try {
          const response = parseThreadRead(
            await this.bridge.request<unknown>(
              "thread/read",
              { threadId, includeTurns: false },
              30_000,
            ),
          );
          return {
            thread:
              !this.isInternalPendingForkThread(response.thread) &&
              (isSpawnedSubagent(response.thread) ||
                isRecoverableUserSession(response.thread) ||
                managedParentIds.has(threadId) ||
                managedChildIds.has(threadId))
                ? response.thread
                : null,
            failed: false,
          };
        } catch (error) {
          this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
          return {
            thread: null,
            failed: loadedIds.has(threadId) && !isMissingThreadError(error),
          };
        }
      }),
    );
    return {
      threads: recovered.flatMap((item) => (item.thread ? [item.thread] : [])),
      failed: recovered.some((item) => item.failed),
    };
  }

  private async listAllModels(): Promise<ModelOption[]> {
    const models: Model[] = [];
    let cursor: string | null = null;
    do {
      const page = parseModelList(
        await this.bridge.request<unknown>(
          "model/list",
          { cursor, limit: 100, includeHidden: false },
          30_000,
        ),
      );
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return models.map(normalizeModel);
  }

  private async reconcileOutcomes(recoveryTurns: ReadonlyMap<string, string>): Promise<void> {
    const state = this.store.view();
    const updates: Array<(draft: CodexNestState) => void> = [];
    const reconcile = async (cached: CachedThread): Promise<void> => {
      const meta = state.threadMeta[cached.thread.id];
      const currentTurnId = cached.currentTurnId;
      const needsRecovery =
        currentTurnId !== null && recoveryTurns.get(cached.thread.id) === currentTurnId;
      if (
        cached.thread.status.type !== "idle" &&
        !(cached.thread.status.type === "notLoaded" && meta?.lastOutcome !== undefined) &&
        !needsRecovery
      )
        return;
      if (isSpawnedSubagent(cached.thread)) return;
      if (this.isUnmaterialized(cached.thread.id)) return;
      const updatedAt = cached.thread.updatedAt * 1_000;
      const revision = this.historyRevision(cached.thread.id);
      const isCurrent = () =>
        this.threads.get(cached.thread.id) === cached &&
        cached.currentTurnId === currentTurnId &&
        cached.thread.updatedAt * 1_000 === updatedAt &&
        this.historyRevision(cached.thread.id) === revision;
      if (
        !currentTurnId &&
        meta?.outcomeUpdatedAt === updatedAt &&
        meta.lastResult !== undefined &&
        meta.awaitingPlanResponse !== undefined
      ) {
        return;
      }
      const planMode = meta?.settings?.collaborationMode === "plan";
      if (
        !currentTurnId &&
        meta?.outcomeUpdatedAt === updatedAt &&
        meta.lastResult !== undefined &&
        !planMode
      ) {
        updates.push((draft) => {
          if (!isCurrent()) return;
          const item = draft.threadMeta[cached.thread.id];
          if (item) item.awaitingPlanResponse = false;
        });
        return;
      }
      let page;
      try {
        page = parseTurnsList(
          await this.bridge.request<unknown>(
            "thread/turns/list",
            {
              threadId: cached.thread.id,
              limit: 1,
              sortDirection: "desc",
              itemsView: planMode || currentTurnId ? "full" : "notLoaded",
            },
            30_000,
          ),
        );
      } catch (error) {
        if (isMissingThreadError(error)) {
          await this.removeOrphanedThread(cached.thread.id);
          return;
        }
        if (isThreadNotLoadedError(error)) return;
        throw error;
      }
      if (!isCurrent()) return;
      if (await this.reconcileCompletedTurn(cached.thread.id, page.data)) return;
      if (currentTurnId) return;
      const latestTurn = page.data[0];
      const outcome = normalizeOutcome(latestTurn?.status);
      const awaitingPlanResponse =
        planMode && outcome === "completed" && Boolean(latestTurn && turnContainsPlan(latestTurn));
      const lastResult =
        latestTurn && latestTurn.status !== "inProgress"
          ? {
              turnId: latestTurn.id,
              completedAt:
                latestTurn.completedAt === null ? updatedAt : latestTurn.completedAt * 1_000,
            }
          : null;
      updates.push((draft) => {
        if (!isCurrent()) return;
        const item = draft.threadMeta[cached.thread.id] ?? {
          pinned: false,
          lastReadUpdatedAt: updatedAt,
        };
        item.lastOutcome = outcome;
        item.outcomeUpdatedAt = updatedAt;
        if (!lastResult) {
          item.lastResult = null;
        } else if (item.lastResult?.turnId !== lastResult.turnId) {
          item.lastResult = lastResult;
        }
        item.awaitingPlanResponse =
          awaitingPlanResponse && item.dismissedPlanTurnId !== lastResult?.turnId;
        draft.threadMeta[cached.thread.id] = item;
      });
    };
    const candidates = [...this.threads.values()];
    // Bound simultaneous rollout reads because old sessions can have large histories.
    for (let index = 0; index < candidates.length; index += 4) {
      const results = await Promise.allSettled(candidates.slice(index, index + 4).map(reconcile));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    // Backfilling hundreds of old sessions must not validate and persist the
    // entire state once per session while startup waits for its health check.
    if (updates.length) {
      await this.store.update((draft) => {
        for (const update of updates) update(draft);
      });
    }
  }

  private updateCapacityRetry(
    meta: ThreadMetaState,
    cached: CachedThread,
    turn: Turn,
    recovered: boolean,
  ): void {
    if (!isCapacityFailure(turn)) {
      if (meta.capacityRetry && turn.id !== meta.capacityRetry.failedTurnId) {
        delete meta.capacityRetry;
      }
      return;
    }
    if (
      cached.archived ||
      this.hiddenThreads.has(cached.thread.id) ||
      (isSpawnedSubagent(cached.thread) && !meta.managedParent) ||
      cached.thread.turns.at(-1)?.id !== turn.id ||
      meta.capacityRetryHandledTurnId === turn.id ||
      (recovered && !meta.capacityRetry)
    )
      return;
    const goal =
      cached.stoppedGoalForTurn?.turnId === turn.id ? cached.stoppedGoalForTurn.goal : undefined;
    if (goal && goal.status !== "blocked") {
      delete meta.capacityRetry;
      meta.capacityRetryHandledTurnId = turn.id;
      return;
    }
    meta.capacityRetry = {
      failedTurnId: turn.id,
      nextAttemptAt:
        (turn.completedAt === null ? Date.now() : turn.completedAt * 1_000) +
        CAPACITY_RETRY_INTERVAL_MS,
      ...(goal
        ? {
            goal: {
              createdAt: goal.createdAt,
              updatedAt: goal.updatedAt,
              objective: goal.objective,
            },
          }
        : {}),
    };
    meta.capacityRetryHandledTurnId = turn.id;
  }

  private async completeTurn(
    threadId: string,
    turn: Turn,
    recovered = false,
  ): Promise<{ historyChanged: boolean } | null> {
    if (turn.status === "inProgress") return null;
    this.flushActivityDeltas(threadId, turn.id);
    const cached = this.threads.get(threadId);
    const outcome = normalizeOutcome(turn.status);
    const wasCurrentTurn = cached?.currentTurnId === turn.id;
    const lastResult = this.store.view().threadMeta[threadId]?.lastResult;
    // A replay of an older result cannot replace the newest completed turn.
    if (
      !wasCurrentTurn &&
      lastResult &&
      lastResult.turnId !== turn.id &&
      ((turn.completedAt !== null && turn.completedAt * 1_000 < lastResult.completedAt) ||
        (turn.completedAt === null &&
          cached?.thread.turns.some(
            (candidate) => candidate.id === turn.id && candidate.status !== "inProgress",
          )))
    ) {
      return null;
    }
    const interruptedTextActivities =
      outcome === "interrupted"
        ? this.collectInterruptedTextActivities(threadId, turn.id, turn)
        : [];
    if (cached) {
      const turnIndex = cached.thread.turns.findIndex((candidate) => candidate.id === turn.id);
      if (turnIndex >= 0) {
        cached.thread.turns[turnIndex] = turn;
      } else {
        cached.thread.turns.push(turn);
      }
    }
    // Park automatic input before clearing the current turn or publishing idle state.
    if (
      isCapacityFailure(turn) &&
      (!recovered || wasCurrentTurn || this.store.view().threadMeta[threadId]?.capacityRetry)
    ) {
      await this.prepareCapacityRetry(threadId, turn);
    }
    await this.clearUserInputsForTurn(threadId, turn.id);
    const rolloutPath = this.rolloutPath(threadId);
    if (rolloutPath && turn.items.some((item) => item.type === "plan")) {
      await recoverTimelineOrder(rolloutPath, [turn], {});
    }
    if (recovered && cached?.currentTurnId !== turn.id) return null;
    if (cached?.currentTurnId && cached.currentTurnId !== turn.id) return null;
    if (cached) {
      cached.currentTurnId = null;
      cached.liveOutcome = outcome;
      cached.thread.status = { type: "idle" };
      cached.thread.updatedAt = Math.max(
        cached.thread.updatedAt,
        lastResult?.turnId === turn.id
          ? cached.thread.updatedAt
          : recovered
            ? (turn.completedAt ?? cached.thread.updatedAt)
            : Math.floor(Date.now() / 1_000),
      );
      const updatedAt = cached.thread.updatedAt * 1_000;
      const hasPlan = turnContainsPlan(turn) || this.hasLivePlan(threadId, turn.id);
      const startedAt = turn.startedAt === null ? null : turn.startedAt * 1_000;
      const completedAt = turn.completedAt === null ? null : turn.completedAt * 1_000;
      const artifactAliases = mergeLiveActivities(
        turn.items
          .filter((item) => !isInternalTeamContinuationItem(item))
          .map((item) =>
            normalizeActivity(
              item,
              item.type === "userMessage" ? startedAt : (completedAt ?? startedAt),
            ),
          ),
        this.liveActivities(threadId, turn.id),
        outcome,
      ).aliases;
      let retainedTextChanged = false;
      await this.store.update((state) => {
        const meta = state.threadMeta[cached.thread.id] ?? {
          pinned: false,
          lastReadUpdatedAt: 0,
        };
        meta.lastOutcome = outcome;
        meta.outcomeUpdatedAt = updatedAt;
        if (meta.lastResult?.turnId !== turn.id) {
          meta.lastResult = { turnId: turn.id, completedAt: completedAt ?? updatedAt };
        }
        this.updateCapacityRetry(meta, cached, turn, recovered);
        retainedTextChanged = updateInterruptedTextActivities(
          meta,
          turn.id,
          interruptedTextActivities,
          outcome === "interrupted" ? "merge" : "clear",
        );
        const artifacts = meta.timelineArtifacts?.[turn.id];
        meta.awaitingPlanResponse =
          outcome === "completed" &&
          meta.dismissedPlanTurnId !== turn.id &&
          ((meta.settings?.collaborationMode === "plan" && hasPlan) ||
            latestPlanChecklistIsIncomplete(artifacts));
        if (artifacts) {
          meta.timelineArtifacts![turn.id] = artifacts.map((item): TimelineArtifact => {
            const afterItemId = item.afterItemId
              ? (artifactAliases.get(item.afterItemId) ?? item.afterItemId)
              : null;
            return item.type === "planChecklist"
              ? {
                  ...item,
                  afterItemId,
                  status: outcome === "failed" ? "failed" : "completed",
                }
              : { ...item, afterItemId };
          });
        }
        const snapshot = sessionSnapshot(cached);
        if (snapshot) meta.sessionSnapshot = snapshot;
        state.threadMeta[cached.thread.id] = meta;
      });
      if (retainedTextChanged) {
        this.bumpHistoryRevision(threadId);
        await this.historyCache.invalidateThread(threadId);
      }
      this.clearTurnActivities(threadId, turn.id);
      this.replaceTurnState(threadId, turn.id, {
        publish: true,
        source: turn,
      });
      this.publishThread(threadId);
      return { historyChanged: retainedTextChanged };
    }
    return null;
  }

  private async onNotification(notification: ServerNotification): Promise<void> {
    if (
      notification.method === "thread/started" &&
      (this.isInternalPendingForkThread(notification.params.thread) ||
        (notification.params.thread.ephemeral && !isSpawnedSubagent(notification.params.thread)))
    ) {
      this.hiddenThreads.add(notification.params.thread.id);
      return;
    }
    const threadId = notificationThreadId(notification);
    if (threadId && this.hiddenThreads.has(threadId)) {
      if (notification.method === "thread/deleted" || notification.method === "thread/closed") {
        this.hiddenThreads.delete(threadId);
      }
      return;
    }
    if (threadId) this.bumpHistoryRevision(threadId);
    switch (notification.method) {
      case "skills/changed":
        this.publish({ type: "skills.changed" });
        break;
      case "error": {
        this.flushActivityDeltas(notification.params.threadId, notification.params.turnId);
        const item: ActivityItem = {
          type: "error",
          id: `${notification.params.turnId}-error-${Date.now()}`,
          status: "failed",
          message: notification.params.error.message,
          ...(notification.params.error.codexErrorInfo === "serverOverloaded"
            ? { failureKind: "modelCapacity" as const }
            : {}),
        };
        this.activity.set(
          activityKey(notification.params.threadId, notification.params.turnId, item.id),
          item,
        );
        this.publishActivityUpsert(notification.params.threadId, notification.params.turnId, item);
        this.touchThreadActivity(notification.params.threadId);
        break;
      }
      case "thread/started": {
        this.upsertThread(notification.params.thread);
        const pendingTitle = this.pendingSubagentTitles.get(notification.params.thread.id);
        if (pendingTitle) {
          this.pendingSubagentTitles.delete(notification.params.thread.id);
          this.setSubagentTitle(notification.params.thread.id, pendingTitle);
        }
        break;
      }
      case "thread/settings/updated": {
        const { threadId, threadSettings } = notification.params;
        const cached = this.threads.get(threadId);
        if (cached) {
          cached.thread.model = threadSettings.model;
          cached.thread.reasoningEffort = threadSettings.effort;
          this.publishThread(threadId);
        }
        break;
      }
      case "thread/status/changed": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.thread.status = notification.params.status;
          if (notification.params.status.type === "notLoaded")
            cached.thread.canAcceptDirectInput = null;
          if (
            notification.params.status.type === "systemError" &&
            !this.hasLiveCapacityError(cached)
          ) {
            cached.currentTurnId = null;
            cached.liveOutcome = "failed";
          }
          this.queueSessionSnapshot(notification.params.threadId);
          this.publishThread(notification.params.threadId);
        }
        break;
      }
      case "thread/name/updated": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.thread.name = notification.params.threadName ?? null;
          this.queueSessionSnapshot(notification.params.threadId);
          this.publishThread(notification.params.threadId);
        }
        break;
      }
      case "thread/goal/updated": {
        const cached = this.threads.get(notification.params.threadId);
        const statusChanged = cached?.goalStatus !== notification.params.goal.status;
        if (cached) {
          if (
            cached.goalStatus === "active" &&
            notification.params.goal.status !== "active" &&
            cached.currentTurnId
          ) {
            cached.stoppedGoalForTurn = {
              turnId: cached.currentTurnId,
              goal: notification.params.goal,
            };
          } else if (notification.params.goal.status === "active") {
            delete cached.stoppedGoalForTurn;
          }
          cached.goalStatus = notification.params.goal.status;
        }
        const retry = this.store.view().threadMeta[notification.params.threadId]?.capacityRetry;
        if (
          retry?.goal &&
          (!["active", "blocked"].includes(notification.params.goal.status) ||
            notification.params.goal.createdAt !== retry.goal.createdAt ||
            notification.params.goal.objective !== retry.goal.objective ||
            (!retry.dispatching && notification.params.goal.updatedAt !== retry.goal.updatedAt))
        ) {
          await this.cancelCapacityRetry(notification.params.threadId);
        }
        this.publish({
          type: "goal.changed",
          threadId: notification.params.threadId,
          goal: notification.params.goal satisfies ThreadGoal,
        });
        if (statusChanged) this.publishThread(notification.params.threadId);
        break;
      }
      case "thread/goal/cleared": {
        const cached = this.threads.get(notification.params.threadId);
        const statusChanged = cached?.goalStatus !== null;
        if (cached) {
          cached.goalStatus = null;
          delete cached.stoppedGoalForTurn;
        }
        if (this.store.view().threadMeta[notification.params.threadId]?.capacityRetry?.goal) {
          await this.cancelCapacityRetry(notification.params.threadId);
        }
        this.publish({
          type: "goal.changed",
          threadId: notification.params.threadId,
          goal: null,
        });
        if (statusChanged) this.publishThread(notification.params.threadId);
        break;
      }
      case "thread/archived": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.archived = true;
          await this.cancelCapacityRetry(notification.params.threadId);
          await this.saveSessionSnapshot(notification.params.threadId, true);
        }
        this.publishThread(notification.params.threadId);
        break;
      }
      case "thread/unarchived": {
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.archived = false;
          await this.saveSessionSnapshot(notification.params.threadId, true);
        }
        this.publishThread(notification.params.threadId);
        break;
      }
      case "thread/deleted": {
        await this.removeOrphanedThread(notification.params.threadId);
        break;
      }
      case "thread/closed": {
        this.subscribedThreads.delete(notification.params.threadId);
        const cached = this.threads.get(notification.params.threadId);
        if (cached) {
          cached.currentTurnId = null;
          cached.thread.status = { type: "notLoaded" };
          cached.thread.canAcceptDirectInput = null;
          await this.saveSessionSnapshot(notification.params.threadId, true);
          this.publishThread(notification.params.threadId);
        }
        break;
      }
      case "turn/started": {
        this.flushActivityDeltas(notification.params.threadId, notification.params.turn.id);
        this.subscribedThreads.add(notification.params.threadId);
        this.unmaterializedThreads.delete(notification.params.threadId);
        const cached = this.threads.get(notification.params.threadId);
        const key = turnKey(notification.params.threadId, notification.params.turn.id);
        const knownState = this.turnStates.get(key);
        if (knownState && knownState.status !== "inProgress") break;
        if (cached) {
          const turnIndex = cached.thread.turns.findIndex(
            (turn) => turn.id === notification.params.turn.id,
          );
          // A delayed start must not revive a turn already stopped or completed.
          if (turnIndex >= 0 && cached.thread.turns[turnIndex]!.status !== "inProgress") break;
          if (turnIndex >= 0) cached.thread.turns[turnIndex] = notification.params.turn;
          else cached.thread.turns.push(notification.params.turn);
        }
        if (!this.progress.has(key)) {
          this.progress.set(key, emptyProgress(notification.params.turn.startedAt));
        }
        if (this.threads.has(notification.params.threadId)) {
          await this.setCurrentTurn(notification.params.threadId, notification.params.turn.id);
        }
        this.replaceTurnState(notification.params.threadId, notification.params.turn.id, {
          publish: true,
          source: notification.params.turn,
        });
        break;
      }
      case "turn/completed": {
        await this.completeTurn(notification.params.threadId, notification.params.turn);
        break;
      }
      case "turn/plan/updated": {
        const key = turnKey(notification.params.threadId, notification.params.turnId);
        const progress = {
          ...(this.progress.get(key) ?? emptyProgress(null)),
          explanation: notification.params.explanation,
          steps: notification.params.plan,
        } satisfies TurnProgress;
        this.progress.set(key, progress);
        this.publishTurnProgress(
          notification.params.threadId,
          notification.params.turnId,
          progress,
        );
        await this.upsertTimelineArtifact(
          notification.params.threadId,
          notification.params.turnId,
          {
            type: "planChecklist",
            id: `${notification.params.turnId}-plan-checklist-${randomUUID()}`,
            status: "inProgress",
            explanation: notification.params.explanation,
            steps: notification.params.plan,
            timestamp: Date.now(),
            afterItemId: this.latestActivityId(
              notification.params.threadId,
              notification.params.turnId,
            ),
          },
        );
        break;
      }
      case "turn/diff/updated": {
        const key = turnKey(notification.params.threadId, notification.params.turnId);
        const progress = {
          ...(this.progress.get(key) ?? emptyProgress(null)),
          ...diffStats(notification.params.diff),
        } satisfies TurnProgress;
        this.progress.set(key, progress);
        this.publishTurnProgress(
          notification.params.threadId,
          notification.params.turnId,
          progress,
        );
        this.touchThreadActivity(notification.params.threadId);
        break;
      }
      case "item/started":
      case "item/completed": {
        const sourceItem = notification.params.item;
        if (isInternalTeamContinuationItem(sourceItem)) break;
        this.flushActivityDeltas(notification.params.threadId, notification.params.turnId);
        this.captureSubagentTitles(sourceItem);
        if (
          notification.method === "item/completed" &&
          sourceItem.type === "collabAgentToolCall" &&
          sourceItem.tool === "wait" &&
          sourceItem.status === "completed"
        ) {
          const deliveryKey = activityKey(
            notification.params.threadId,
            notification.params.turnId,
            sourceItem.id,
          );
          if (!this.deliveredNativeWaits.has(deliveryKey)) {
            this.deliveredNativeWaits.add(deliveryKey);
            try {
              await this.markDeliveredThreadsRead(
                sourceItem.receiverThreadIds.filter((threadId) => {
                  const agent = sourceItem.agentsStates[threadId];
                  return agent?.status === "completed" && Boolean(agent.message?.trim());
                }),
                notification.params.completedAtMs,
              );
            } catch (error) {
              this.deliveredNativeWaits.delete(deliveryKey);
              throw error;
            }
          }
        }
        let key = activityKey(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.item.type === "userMessage"
            ? (notification.params.item.clientId ?? notification.params.item.id)
            : notification.params.item.id,
        );
        let previous = this.activity.get(key);
        const eventTimestamp =
          notification.method === "item/started"
            ? notification.params.startedAtMs
            : notification.params.completedAtMs;
        const timestamp = previous?.type === "userMessage" ? previous.timestamp : eventTimestamp;
        let item = normalizeActivity(
          notification.params.item,
          timestamp,
          notification.method === "item/started",
        );
        if (notification.method === "item/completed" && !previous) {
          const alias = this.streamingActivityAlias(
            notification.params.threadId,
            notification.params.turnId,
            item,
          );
          if (alias) {
            key = alias.key;
            previous = alias.item;
            item = { ...item, id: previous.id } as ActivityItem;
          }
        }
        if (
          item.type === "plan" &&
          previous?.type === "plan" &&
          previous.status === "completed" &&
          item.timestamp !== null &&
          previous.timestamp !== null &&
          item.timestamp > previous.timestamp
        ) {
          this.activity.delete(key);
        }
        if (
          item.type === "subagentLaunch" &&
          item.source === "codex" &&
          previous?.type === "subagentLaunch" &&
          previous.timestamp != null
        ) {
          item.timestamp = previous.timestamp;
        }
        const affectsAsyncQuestion =
          (item.type === "agentMessage" && !!item.questions?.length) ||
          (item.type === "userMessage" && item.id.startsWith("async-answer:"));
        const previousState = affectsAsyncQuestion
          ? this.summary(notification.params.threadId)?.state
          : undefined;
        this.activity.set(key, item);
        this.publishActivityUpsert(notification.params.threadId, notification.params.turnId, item);
        if (
          !this.touchThreadActivity(notification.params.threadId, eventTimestamp) &&
          previousState !== undefined &&
          previousState !== this.summary(notification.params.threadId)?.state
        ) {
          this.publishThread(notification.params.threadId);
        }
        break;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta": {
        this.appendTextDelta(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.itemId,
          notification.params.delta,
          notification.method === "item/plan/delta"
            ? "plan"
            : notification.method.startsWith("item/reasoning")
              ? "reasoning"
              : "agentMessage",
        );
        this.touchThreadActivity(notification.params.threadId);
        break;
      }
      case "item/commandExecution/outputDelta": {
        const key = activityKey(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.itemId,
        );
        const previous = this.activity.get(key);
        const item: ActivityItem =
          previous?.type === "command"
            ? { ...previous, output: previous.output + notification.params.delta }
            : {
                type: "command",
                id: notification.params.itemId,
                status: "inProgress",
                kind: "command",
                command: "",
                cwd: null,
                output: notification.params.delta,
                exitCode: null,
              };
        this.activity.set(key, item);
        this.queueActivityDelta(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.itemId,
          "command",
          notification.params.delta,
        );
        this.touchThreadActivity(notification.params.threadId);
        break;
      }
      case "serverRequest/resolved":
        {
          const resolved = this.attention.expireByRpcId(notification.params.requestId);
          if (resolved?.kind === "userInput") await this.clearUserInputDraft(resolved);
        }
        break;
      default:
        break;
    }
  }

  async removeOrphanedThread(threadId: string): Promise<void> {
    if (this.removedThreads.has(threadId) && !this.threads.has(threadId)) return;
    // Automatic cleanup must never discard a draft or an accepted delivery, nor its files.
    if (!(await removeThreadState(this.store, threadId, true))) return;
    this.removedThreads.add(threadId);
    await Promise.resolve(this.missingThreadCleanup?.(threadId)).catch((error: unknown) => {
      this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
    });
    this.bumpHistoryRevision(threadId);
    this.forgetThread(threadId);
    await this.historyCache.invalidateThread(threadId).catch(() => undefined);
    this.publish({ type: "thread.removed", threadId });
  }

  private forgetThread(threadId: string): void {
    this.threads.delete(threadId);
    this.latestDetails.delete(threadId);
    this.subscribedThreads.delete(threadId);
    this.unmaterializedThreads.delete(threadId);
    this.hiddenThreads.delete(threadId);
    this.pendingSubagentTitles.delete(threadId);
    this.subagentTitleUpdates.delete(threadId);
    for (const key of [...this.progress.keys()]) {
      if (key.startsWith(`${threadId}:`)) this.progress.delete(key);
    }
    for (const key of [...this.turnStates.keys()]) {
      if (key.startsWith(`${threadId}:`)) this.turnStates.delete(key);
    }
    for (const [key, batch] of [...this.pendingActivityDeltas.entries()]) {
      if (batch.threadId !== threadId) continue;
      const timer = this.activityDeltaTimers.get(key);
      if (timer) clearTimeout(timer);
      this.activityDeltaTimers.delete(key);
      this.pendingActivityDeltas.delete(key);
    }
    for (const key of [...this.activity.keys()]) {
      if (key.startsWith(`${threadId}:`)) this.activity.delete(key);
    }
    for (const key of [...this.deliveredNativeWaits]) {
      if (key.startsWith(`${threadId}:`)) this.deliveredNativeWaits.delete(key);
    }
  }

  private captureSubagentTitles(item: Turn["items"][number]): void {
    if (item.type !== "collabAgentToolCall" || item.tool !== "spawnAgent" || !item.prompt) return;
    const title = subagentTaskTitle(item.prompt);
    if (!title) return;
    for (const threadId of item.receiverThreadIds) {
      if (this.threads.has(threadId)) {
        this.setSubagentTitle(threadId, title);
      } else {
        this.pendingSubagentTitles.set(threadId, title);
      }
    }
  }

  private async markDeliveredThreadsRead(
    threadIds: readonly string[],
    deliveredAt: number,
  ): Promise<void> {
    const readMarkers = this.readMarkers(threadIds, deliveredAt);
    const snapshot = this.store.view();
    if (
      !readMarkers.some(
        ([threadId, updatedAt]) =>
          updatedAt > (snapshot.threadMeta[threadId]?.lastReadUpdatedAt ?? 0),
      )
    ) {
      return;
    }
    const markedRead: string[] = [];
    await this.store.update((state) => {
      markedRead.push(...applyReadMarkers(state, readMarkers));
    });
    if (markedRead.length) {
      const state = this.store.view();
      for (const threadId of markedRead) this.publishThread(threadId, state);
    }
  }

  private readMarkers(
    threadIds: readonly string[],
    deliveredAt: number,
  ): Array<readonly [string, number]> {
    const markers: Array<readonly [string, number]> = [];
    for (const threadId of new Set(threadIds)) {
      const cached = this.threads.get(threadId);
      if (cached) {
        markers.push([threadId, Math.min(cached.thread.updatedAt * 1_000, deliveredAt)]);
      }
    }
    return markers;
  }

  private setSubagentTitle(threadId: string, title: string): void {
    const cached = this.threads.get(threadId);
    if (
      !cached ||
      !isSpawnedSubagent(cached.thread) ||
      cached.thread.name?.trim() ||
      this.subagentTitleUpdates.has(threadId)
    ) {
      return;
    }
    this.subagentTitleUpdates.add(threadId);
    cached.thread.name = title;
    this.publishThread(threadId);
    void this.bridge
      .request("thread/name/set", { threadId, name: title })
      .catch((error: unknown) => {
        this.emit("projectionError", error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => this.subagentTitleUpdates.delete(threadId));
  }

  private appendTextDelta(
    threadId: string,
    turnId: string,
    itemId: string,
    delta: string,
    type: "agentMessage" | "plan" | "reasoning",
  ): void {
    const key = activityKey(threadId, turnId, itemId);
    const previous = this.activity.get(key);
    const item: ActivityItem = {
      type,
      id: itemId,
      status: "inProgress",
      text: previous && "text" in previous ? previous.text + delta : delta,
      images: previous && "images" in previous ? (previous.images ?? []) : [],
      timestamp:
        previous && "timestamp" in previous && previous.timestamp !== undefined
          ? previous.timestamp
          : (this.progress.get(turnKey(threadId, turnId))?.startedAt ?? Date.now()),
      phase: previous && "phase" in previous ? previous.phase : null,
      ...(previous && "questions" in previous
        ? {
            questions: previous.questions,
            delivery: previous.delivery,
            questionKey: previous.questionKey,
          }
        : {}),
    };
    this.activity.set(key, item);
    this.queueActivityDelta(threadId, turnId, itemId, type, delta);
  }

  private touchThreadActivity(
    threadId: string,
    observedAt = Date.now(),
    state: CodexNestStateView = this.store.view(),
  ): boolean {
    const cached = this.threads.get(threadId);
    const updatedAt = Math.floor(observedAt / 1_000);
    if (!cached || !Number.isFinite(updatedAt) || updatedAt <= cached.thread.updatedAt) {
      return false;
    }
    cached.thread.updatedAt = updatedAt;
    this.queueSessionSnapshot(threadId);
    this.publishThread(threadId, state);
    return true;
  }

  private streamingActivityAlias(
    threadId: string,
    turnId: string,
    completed: ActivityItem,
  ): { key: string; item: ActivityItem } | undefined {
    const prefix = `${threadId}:${turnId}:`;
    const entries = [...this.activity.entries()];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      const [key, item] = entry;
      if (
        key.startsWith(prefix) &&
        item.status === "inProgress" &&
        sameRenderedActivity(item, completed, true)
      ) {
        return { key, item };
      }
    }
    return undefined;
  }

  private toSummary(
    cached: CachedThread,
    state: CodexNestStateView = this.store.view(),
  ): ThreadSummary {
    const meta = state.threadMeta[cached.thread.id] ?? { pinned: false, lastReadUpdatedAt: 0 };
    const updatedAt = cached.thread.updatedAt * 1_000;
    const threadState = this.threadState(cached, meta.lastOutcome, state);
    const unread = updatedAt > meta.lastReadUpdatedAt && isTerminal(threadState);
    const resultAt =
      meta.lastResult === undefined ? updatedAt : (meta.lastResult?.completedAt ?? 0);
    return {
      id: cached.thread.id,
      projectId: projectForCwd(state.projects, cached.thread.cwd)?.id ?? null,
      title: displayThreadTitle(cached.thread),
      preview: cached.thread.preview,
      cwd: cached.thread.cwd,
      state: threadState,
      unread,
      unseen: unread && resultAt > (meta.lastViewedUpdatedAt ?? 0),
      pinned: meta.pinned,
      archived: cached.archived,
      createdAt: cached.thread.createdAt * 1_000,
      updatedAt,
      currentTurnId: cached.currentTurnId,
      ...(meta.capacityRetry
        ? {
            capacityRetry: {
              failedTurnId: meta.capacityRetry.failedTurnId,
              nextAttemptAt: meta.capacityRetry.nextAttemptAt,
            },
          }
        : {}),
      awaitingPlanResponse: meta.awaitingPlanResponse ?? false,
      ...(meta.dismissedPlanTurnId ? { dismissedPlanTurnId: meta.dismissedPlanTurnId } : {}),
      queuedMessageCount: state.messageQueues?.[cached.thread.id]?.length ?? 0,
      browserStatus: this.browserStatusProvider(cached.thread.id),
      settings: sessionSettings(meta.settings),
      relation: threadRelation(cached.thread, meta),
      canAcceptDirectInput: cached.thread.canAcceptDirectInput ?? null,
      codexSettings: {
        model: cached.thread.model ?? null,
        reasoningEffort: cached.thread.reasoningEffort ?? null,
      },
    };
  }

  private threadState(
    cached: CachedThread,
    stored: ThreadOutcome | undefined,
    state: CodexNestStateView,
  ): ThreadState {
    if (
      this.attention
        .list()
        .some((item) => item.threadId === cached.thread.id && item.kind !== "unsupported") ||
      this.hasPendingAsyncQuestion(cached, state)
    ) {
      return "needsAttention";
    }
    const meta = state.threadMeta[cached.thread.id];
    if (meta?.capacityRetry) return "running";
    if (meta?.managedParent) {
      const managedTask =
        state.threadMeta[meta.managedParent.parentThreadId]?.teamOrchestration?.tasks[
          meta.managedParent.taskId
        ];
      if (managedTask?.status === "queued") return "queued";
      if (managedTask?.status === "starting" || managedTask?.status === "running") return "running";
      if (managedTask && ["completed", "failed", "interrupted"].includes(managedTask.status)) {
        return managedTask.status as ThreadOutcome;
      }
    }
    if (this.hasLiveCapacityError(cached)) return "running";
    if (cached.thread.status.type === "systemError") return "failed";
    if (cached.currentTurnId) return "running";
    if (isSpawnedSubagent(cached.thread) && cached.thread.status.type === "active")
      return "running";
    if (cached.goalStatus === "active") return "running";
    if (teamOrchestrationIsActive(meta?.teamOrchestration)) return "running";
    if (meta?.awaitingPlanResponse) {
      return "needsAttention";
    }
    return cached.liveOutcome ?? stored ?? "idle";
  }

  private hasPendingAsyncQuestion(cached: CachedThread, state: CodexNestStateView): boolean {
    const turnId = cached.currentTurnId;
    if (!turnId) return false;
    const turn =
      this.turnStates.get(turnKey(cached.thread.id, turnId)) ??
      cached.thread.turns.find((candidate) => candidate.id === turnId);
    if (!turn || turn.status !== "inProgress") return false;
    const occurrences = new Map<string, number>();
    for (const item of turn.items) {
      if (item.type !== "agentMessage" || !item.questions?.length) continue;
      const key =
        "questionKey" in item && typeof item.questionKey === "string"
          ? item.questionKey
          : createHash("sha256").update(JSON.stringify(item.questions)).digest("hex");
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const messageId = asyncQuestionReplyMessageId(
        cached.thread.id,
        turnId,
        occurrence ? `${key}:${occurrence}` : key,
      );
      if (state.messageQueues?.[cached.thread.id]?.some((message) => message.id === messageId))
        continue;
      const receipt = state.messageReceipts?.[messageId];
      if (
        receipt?.threadId === cached.thread.id &&
        (receipt.status === "delivered" || (!receipt.status && receipt.turnId !== null))
      )
        continue;
      if (
        turn.items.some(
          (candidate) =>
            candidate.type === "userMessage" &&
            ("clientId" in candidate ? (candidate.clientId ?? candidate.id) : candidate.id) ===
              messageId,
        )
      )
        continue;
      return true;
    }
    return false;
  }

  private sortedThreads(state: CodexNestStateView): ThreadSummary[] {
    return [...this.threads.values()]
      .map((cached) => this.toSummary(cached, state))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private hasLiveCapacityError(cached: CachedThread): boolean {
    return (
      cached.currentTurnId !== null &&
      (cached.thread.turns.some(
        (turn) => turn.id === cached.currentTurnId && isCapacityFailure(turn),
      ) ||
        (this.turnStates
          .get(turnKey(cached.thread.id, cached.currentTurnId))
          ?.items.some((item) => item.type === "error" && item.failureKind === "modelCapacity") ??
          false))
    );
  }

  private enrichAttention(
    request: AttentionRequest,
    state: CodexNestStateView = this.store.view(),
  ): AttentionRequest {
    if (request.kind !== "userInput") return request;
    const identity = userInputDraftIdentity(request);
    const persisted = identity
      ? state.threadMeta[identity.threadId]?.userInputDrafts?.[identity.key]
      : undefined;
    const draft =
      persisted &&
      persisted.turnId === identity?.turnId &&
      persisted.itemId === identity.itemId &&
      persisted.fingerprint === identity.fingerprint
        ? {
            answers: Object.fromEntries(
              Object.entries(persisted.answers).map(([id, answers]) => [id, [...answers]]),
            ),
            currentQuestionId: persisted.currentQuestionId,
            revision: persisted.revision,
            updatedAt: persisted.updatedAt,
            ...(persisted.appliedRecordingIds
              ? { appliedRecordingIds: [...persisted.appliedRecordingIds] }
              : {}),
            ...(persisted.submission
              ? {
                  submission: {
                    ...persisted.submission,
                    recordingIds: [...persisted.submission.recordingIds],
                  },
                }
              : {}),
            recordings: Object.values(state.voiceTranscriptions ?? {})
              .filter(
                (job) =>
                  job.threadId === identity.threadId && job.userInput?.draftKey === identity.key,
              )
              .map(publicVoiceTranscription),
          }
        : null;
    return {
      ...request,
      draft,
      ...(identity
        ? {
            draftKey: identity.key,
            clientMessageId: userInputReplyMessageId(
              identity.threadId,
              identity.turnId,
              identity.itemId,
            ),
          }
        : {}),
    };
  }

  private async clearReplacedUserInputDrafts(
    request: Extract<AttentionRequest, { kind: "userInput" }>,
  ): Promise<void> {
    const identity = userInputDraftIdentity(request);
    if (!identity) return;
    const replaced = Object.entries(
      this.store.view().threadMeta[identity.threadId]?.userInputDrafts ?? {},
    ).filter(
      ([key, draft]) =>
        key !== identity.key &&
        draft.turnId === identity.turnId &&
        draft.itemId === identity.itemId,
    );
    if (!replaced.length) return;
    await this.store.update((state) => {
      const drafts = state.threadMeta[identity.threadId]?.userInputDrafts;
      if (!drafts) return;
      for (const [key] of replaced) delete drafts[key];
      if (!Object.keys(drafts).length) delete state.threadMeta[identity.threadId]!.userInputDrafts;
    });
    this.emit("userInputVoiceChanged");
  }

  private async clearUserInputDraft(
    request: Extract<AttentionRequest, { kind: "userInput" }>,
  ): Promise<void> {
    const identity = userInputDraftIdentity(request);
    if (!identity) return;
    if (!this.store.view().threadMeta[identity.threadId]?.userInputDrafts?.[identity.key]) return;
    await this.store.update((state) => {
      const drafts = state.threadMeta[identity.threadId]?.userInputDrafts;
      if (!drafts) return;
      delete drafts[identity.key];
      if (!Object.keys(drafts).length) delete state.threadMeta[identity.threadId]!.userInputDrafts;
    });
    this.emit("userInputVoiceChanged");
  }

  private async clearCompletedUserInputs(
    threadId: string,
    turns: readonly { id: string; status: Turn["status"] }[],
  ): Promise<void> {
    for (const turn of turns) {
      if (turn.status !== "inProgress") await this.clearUserInputsForTurn(threadId, turn.id);
    }
  }

  private async clearUserInputsForTurn(threadId: string, turnId: string): Promise<void> {
    for (const request of this.attention.list()) {
      if (
        request.kind === "userInput" &&
        request.threadId === threadId &&
        request.turnId === turnId
      ) {
        this.attention.expire(request.id);
      }
    }
    const existing = this.store.view().threadMeta[threadId]?.userInputDrafts;
    if (!existing || !Object.values(existing).some((draft) => draft.turnId === turnId)) return;
    await this.store.update((state) => {
      const drafts = state.threadMeta[threadId]?.userInputDrafts;
      if (!drafts) return;
      for (const [key, draft] of Object.entries(drafts)) {
        if (draft.turnId === turnId) delete drafts[key];
      }
      if (!Object.keys(drafts).length) delete state.threadMeta[threadId]!.userInputDrafts;
    });
    this.emit("userInputVoiceChanged");
  }

  private publishThread(
    threadId: string,
    state: CodexNestStateView = this.store.view(),
  ): ThreadSummary | undefined {
    const cached = this.threads.get(threadId);
    if (!cached) return undefined;
    const summary = this.toSummary(cached, state);
    if (!this.hiddenThreads.has(threadId) && this.isCwdVisible(cached.thread.cwd, state)) {
      this.publish({ type: "thread.upserted", thread: summary });
    }
    return summary;
  }

  private isThreadVisible(
    threadId: string,
    state: CodexNestStateView = this.store.view(),
  ): boolean {
    const cached = this.threads.get(threadId);
    return (
      !this.hiddenThreads.has(threadId) && (!cached || this.isCwdVisible(cached.thread.cwd, state))
    );
  }

  private isInternalPendingForkThread(
    thread: Thread,
    state: CodexNestStateView = this.store.view(),
  ): boolean {
    if (isInternalForkPreparationThread(thread)) return true;
    const prefix = "codexnest-fork:";
    if (!thread.threadSource?.startsWith(prefix)) return false;
    const operation = state.forkOperations?.[thread.threadSource.slice(prefix.length)];
    return operation !== undefined && operation.status !== "ready";
  }

  private isCwdVisible(cwd: string, state: CodexNestStateView): boolean {
    const project = projectForCwd(state.projects, cwd);
    let dismissedPath: string | undefined;
    for (const path of state.dismissedProjectPaths ?? []) {
      if (pathContains(path, cwd) && (!dismissedPath || path.length > dismissedPath.length)) {
        dismissedPath = path;
      }
    }
    return !dismissedPath || (!!project && project.path.length >= dismissedPath.length);
  }

  private withDeliveryReceipt(threadId: string, turnId: string, item: ActivityItem): ActivityItem {
    if (item.type !== "userMessage") return item;
    const receipt = this.store.view().messageReceipts?.[item.id];
    if (receipt?.presentation) {
      item = { ...item, text: receipt.presentation.input, ...pastedText(receipt.presentation) };
    }
    if (
      receipt?.status !== "delivered" ||
      receipt.threadId !== threadId ||
      receipt.turnId !== turnId
    )
      return item;
    return {
      ...item,
      deliveryReceipt: {
        version: receipt.deliveryVersion === 1 ? 1 : 0,
        threadId,
        turnId,
        clientId: item.id,
      },
    };
  }

  private withDeliveryReceipts(threadId: string, turn: TurnView): TurnView {
    return {
      ...turn,
      items: turn.items.map((item) => this.withDeliveryReceipt(threadId, turn.id, item)),
    };
  }

  private publish(event: ServerEvent): void {
    if (event.type === "activity.upserted") {
      event = {
        ...event,
        item: this.withDeliveryReceipt(event.threadId, event.turnId, event.item),
      };
    } else if (event.type === "turn.replaced") {
      event = { ...event, turn: this.withDeliveryReceipts(event.threadId, event.turn) };
    }
    this.sequence += 1;
    this.emit("event", this.sequence, event);
  }
}

export function userInputReplyMessageId(threadId: string, turnId: string, itemId: string): string {
  return `user-input:${createHash("sha256")
    .update(JSON.stringify([threadId, turnId, itemId]))
    .digest("hex")}`;
}

export function userInputDraftIdentity(request: Extract<AttentionRequest, { kind: "userInput" }>): {
  threadId: string;
  turnId: string;
  itemId: string;
  fingerprint: string;
  key: string;
} | null {
  if (!request.threadId || !request.turnId || !request.itemId) return null;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        request.questions.map((question) => [
          question.id,
          question.header,
          question.question,
          question.isOther,
          question.isSecret,
          question.options?.map((option) => [option.label, option.description]) ?? null,
        ]),
      ),
    )
    .digest("hex");
  const key = createHash("sha256")
    .update(JSON.stringify([request.turnId, request.itemId, fingerprint]))
    .digest("hex");
  return {
    threadId: request.threadId,
    turnId: request.turnId,
    itemId: request.itemId,
    fingerprint,
    key,
  };
}

function applyReadMarkers(
  state: CodexNestState,
  markers: Array<readonly [threadId: string, updatedAt: number]>,
): string[] {
  const markedRead: string[] = [];
  for (const [threadId, updatedAt] of markers) {
    const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
    if (updatedAt <= meta.lastReadUpdatedAt) continue;
    meta.lastReadUpdatedAt = updatedAt;
    state.threadMeta[threadId] = meta;
    markedRead.push(threadId);
  }
  return markedRead;
}

function notificationThreadId(notification: ServerNotification): string | undefined {
  const params: unknown = notification.params;
  if (!params || typeof params !== "object" || !("threadId" in params)) return undefined;
  const threadId = (params as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

function displayThreadTitle(thread: Thread): string {
  return thread.name?.trim() || thread.preview.trim() || "Без названия";
}

function normalizeTitleSearch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/ё/g, "е")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).join(" ");
}

function parseTitleSearchCursor(
  cursor: string,
  query: string,
  archived: boolean,
): { updatedAt: number; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 5 &&
      value[0] === "titles-v1" &&
      value[1] === query &&
      value[2] === archived &&
      typeof value[3] === "number" &&
      Number.isFinite(value[3]) &&
      typeof value[4] === "string" &&
      value[4].length > 0
    )
      return { updatedAt: value[3], id: value[4] };
  } catch {
    // Native message-search cursors and malformed title cursors are not interchangeable.
  }
  throw new ProjectValidationError("Invalid search cursor");
}

function isSpawnedSubagent(thread: Thread): boolean {
  return thread.parentThreadId !== null;
}

function isInternalForkPreparationThread(thread: Thread): boolean {
  return thread.threadSource?.startsWith("codexnest-fork-temp:") === true;
}

function threadLastActivityAt(thread: Thread): number {
  return Math.max(thread.updatedAt, thread.recencyAt ?? 0);
}

function managedTaskNeedsSession(task: DeepReadonly<ManagedTeamTaskState>): boolean {
  if (task.status === "queued" || task.status === "starting" || task.status === "running") {
    return true;
  }
  if (task.delivery?.status === "claimed" || task.watchdog !== undefined) return true;
  const workspace = task.workspace;
  return Boolean(
    workspace && workspace.lifecycle !== "integrated" && workspace.lifecycle !== "discarded",
  );
}

function retentionProtectedThreadIds(
  state: CodexNestStateView,
  threads: Iterable<CachedThread>,
): Set<string> {
  const protectedThreadIds = new Set<string>();
  for (const [threadId, meta] of Object.entries(state.threadMeta)) {
    if (meta.pinned) protectedThreadIds.add(threadId);
    if (!meta.teamOrchestration) continue;
    for (const task of Object.values(meta.teamOrchestration.tasks)) {
      if (!managedTaskNeedsSession(task)) continue;
      protectedThreadIds.add(threadId);
      protectedThreadIds.add(task.childThreadId);
    }
  }
  for (const cached of threads) {
    const parentThreadId = cached.thread.parentThreadId;
    if (!parentThreadId) continue;
    protectedThreadIds.add(cached.thread.id);
    protectedThreadIds.add(parentThreadId);
  }
  return protectedThreadIds;
}

function sessionSnapshot(cached: CachedThread): SessionSnapshotState | null {
  if (!isRecoverableUserSession(cached.thread)) return null;
  return {
    sessionId: cached.thread.sessionId,
    ...(cached.thread.forkedFromId ? { forkedFromId: cached.thread.forkedFromId } : {}),
    name: cached.thread.name,
    preview: cached.thread.preview,
    cwd: cached.thread.cwd,
    createdAt: cached.thread.createdAt,
    updatedAt: cached.thread.updatedAt,
    archived: cached.archived,
    currentTurnId: cached.currentTurnId,
  };
}

function sessionSnapshotsEqual(
  left: DeepReadonly<SessionSnapshotState> | undefined,
  right: SessionSnapshotState,
): boolean {
  return (
    left?.sessionId === right.sessionId &&
    left.forkedFromId === right.forkedFromId &&
    left.name === right.name &&
    left.preview === right.preview &&
    left.cwd === right.cwd &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.archived === right.archived &&
    left.currentTurnId === right.currentTurnId
  );
}

function cachedThreadFromSessionSnapshot(
  id: string,
  snapshot: DeepReadonly<SessionSnapshotState>,
): CachedThread {
  return {
    archived: snapshot.archived,
    currentTurnId: snapshot.currentTurnId,
    thread: {
      id,
      extra: null,
      environments: null,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      model: null,
      reasoningEffort: null,
      originator: null,
      canAcceptDirectInput: null,
      daybreakEnabled: null,
      sessionId: snapshot.sessionId,
      forkedFromId: snapshot.forkedFromId ?? null,
      parentThreadId: null,
      preview: snapshot.preview,
      ephemeral: false,
      historyMode: "legacy",
      modelProvider: "openai",
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      recencyAt: snapshot.updatedAt,
      status: { type: "notLoaded" },
      path: null,
      cwd: snapshot.cwd,
      cliVersion: "",
      source: "appServer",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: snapshot.name,
      turns: [],
    },
  };
}

function isRecoverableUserSession(thread: Thread): boolean {
  return (
    !thread.ephemeral &&
    !isSpawnedSubagent(thread) &&
    (thread.source === "cli" || thread.source === "vscode" || thread.source === "appServer")
  );
}

function managedThreadIds(state: CodexNestStateView): Set<string> {
  const threadIds = new Set<string>();
  for (const [threadId, meta] of Object.entries(state.threadMeta)) {
    if (meta.teamOrchestration !== undefined) {
      threadIds.add(threadId);
      for (const task of Object.values(meta.teamOrchestration.tasks)) {
        threadIds.add(task.childThreadId);
      }
    }
    if (meta.managedParent && state.threadMeta[meta.managedParent.parentThreadId] !== undefined) {
      threadIds.add(threadId);
      threadIds.add(meta.managedParent.parentThreadId);
    }
  }
  return threadIds;
}

function hasSubagentTranscript(
  thread: Thread,
  meta?: CodexNestStateView["threadMeta"][string],
): boolean {
  return isSpawnedSubagent(thread) || meta?.managedParent !== undefined;
}

function subagentTranscriptTurnViews(
  thread: Thread,
  turns: TurnView[],
  meta?: CodexNestStateView["threadMeta"][string],
): TurnView[] {
  if (!turns.length) return [];
  if (!isSpawnedSubagent(thread) && meta?.managedParent) {
    let keptInput = false;
    return turns.map((turn) => ({
      ...turn,
      items: turn.items.filter((item) => {
        if (item.type !== "userMessage") return true;
        if (keptInput) return false;
        keptInput = true;
        return true;
      }),
    }));
  }

  // Native v2 children have their own transcript, without an initial userMessage.
  // Unloaded threads may omit the input capability, so also recognize input-free history.
  if (
    isSpawnedSubagent(thread) &&
    !meta?.managedParent &&
    (thread.canAcceptDirectInput === false ||
      !turns.some((turn) => turn.items.some((item) => item.type === "userMessage")))
  ) {
    return turns;
  }

  const expectedTitle = thread.name?.trim() || null;
  let boundary: { turnIndex: number; itemIndex: number } | null = null;

  for (let turnIndex = turns.length - 1; turnIndex >= 0 && !boundary; turnIndex -= 1) {
    const turn = turns[turnIndex]!;
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex]!;
      if (item.type !== "userMessage") continue;
      if (expectedTitle && subagentTaskTitle(item.text) !== expectedTitle) continue;
      boundary = { turnIndex, itemIndex };
      break;
    }
  }

  if (!boundary) return [];

  let keptInput = false;
  return turns.slice(boundary.turnIndex).map((turn, index) => ({
    ...turn,
    items: (index === 0 ? turn.items.slice(boundary.itemIndex) : turn.items).filter((item) => {
      if (item.type !== "userMessage") return true;
      if (keptInput) return false;
      keptInput = true;
      return true;
    }),
  }));
}

function subagentTitleFromTurns(turns: Turn[]): string | null {
  for (const turn of turns) {
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex]!;
      if (item.type !== "userMessage") continue;
      const title = subagentTaskTitle(userMessageText(item));
      if (title) return title;
    }
  }
  return null;
}

function userMessageText(item: Extract<Turn["items"][number], { type: "userMessage" }>): string {
  return item.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function subagentTaskTitle(prompt: string): string | null {
  const firstLine = prompt
    .split(/\r?\n/u)
    .find((line) => line.trim())
    ?.trim();
  const explicitTitle = firstLine?.match(
    /^(?:#{1,6}\s*)?(?:task|задача(?: субагента)?)\s*:\s*(.+)$/iu,
  )?.[1];
  let normalized = (explicitTitle ?? prompt).replace(/\s+/gu, " ").trim();
  normalized = normalized
    .replace(/^(?:#{1,6}\s*|[-*]\s+|>\s*)/u, "")
    .replace(/^(?:task|задача(?: субагента)?)\s*:\s*/iu, "")
    .trim();
  if (!normalized) return null;

  const characters = [...normalized];
  if (characters.length <= 60) return normalized;
  let title = characters.slice(0, 59).join("");
  const wordBoundary = title.lastIndexOf(" ");
  if (wordBoundary >= 36) title = title.slice(0, wordBoundary);
  title = title.replace(/[\s,.:;!?—-]+$/u, "");
  return title ? `${title}…` : null;
}

function threadRelation(
  thread: Thread,
  meta?: CodexNestStateView["threadMeta"][string],
): ThreadSummary["relation"] {
  if (meta?.managedParent) {
    return {
      kind: "subagent",
      sessionId: thread.sessionId,
      parentThreadId: meta.managedParent.parentThreadId,
      nickname: null,
      role: null,
    };
  }
  const forkedFromId = meta?.logicalFork?.sourceThreadId ?? thread.forkedFromId;
  return thread.parentThreadId === null
    ? {
        kind: "session",
        sessionId: thread.sessionId,
        ...(forkedFromId ? { forkedFromId } : {}),
      }
    : {
        kind: "subagent",
        sessionId: thread.sessionId,
        parentThreadId: thread.parentThreadId,
        nickname: thread.agentNickname,
        role: thread.agentRole,
      };
}

export function publicForkOperation(
  operation: DeepReadonly<ForkOperationState>,
): ForkOperationSummary {
  return {
    id: operation.id,
    sourceThreadId: operation.sourceThreadId,
    lastTurnId: operation.lastTurnId,
    agentMessageId: operation.agentMessageId,
    mode: operation.mode,
    status: operation.status,
    stage:
      operation.status === "ready" || operation.status === "failed"
        ? null
        : operation.mode === "exact"
          ? "copying"
          : operation.compressedMaterialization ||
              operation.compressedPreparation?.phase === "compacted"
            ? "materializing"
            : operation.compressedPreparation
              ? "compacting"
              : "preparing",
    title: operation.title,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    targetThreadId: operation.targetThreadId,
    queuedMessageCount: operation.queuedMessages.length,
    estimate: operation.estimate ? cloneView(operation.estimate) : null,
    error: operation.error,
  };
}

function sessionSettings(settings?: SessionSettings): SessionSettings {
  return {
    collaborationMode: settings?.collaborationMode ?? "default",
    ...(settings?.model === undefined ? {} : { model: settings.model }),
    ...(settings?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: settings.reasoningEffort }),
    ...(isFastServiceTier(settings?.serviceTier) ? { serviceTier: "fast" } : {}),
    ...(settings?.personality === undefined ? {} : { personality: settings.personality }),
  };
}

function normalizeModel(model: Model): ModelOption {
  return {
    id: model.id,
    displayName: model.displayName,
    description: model.description,
    isDefault: model.isDefault,
    reasoningEfforts: model.supportedReasoningEfforts.map((option) => ({
      value: option.reasoningEffort,
      description: option.description,
      isDefault: option.reasoningEffort === model.defaultReasoningEffort,
    })),
    serviceTiers: model.serviceTiers.map((tier) => ({ id: tier.id, displayName: tier.name })),
    supportsPersonality: model.supportsPersonality,
  };
}

function defaultModel(models: ModelOption[]): ModelOption | undefined {
  return models.find((candidate) => candidate.isDefault) ?? models[0];
}

function projectedTurnItemIds(turn: Turn): Set<string> {
  return new Set(
    turn.items
      .filter((item) => !isInternalTeamContinuationItem(item))
      .map((item) => (item.type === "userMessage" ? (item.clientId ?? item.id) : item.id)),
  );
}

function normalizeTurn(
  turn: Turn,
  liveProgress?: TurnProgress,
  liveActivities: ActivityItem[] = [],
  artifacts: TimelineArtifact[] = [],
  itemsLoaded = true,
  interruptedTextActivities: DeepReadonly<InterruptedTextActivityState[]> = [],
): TurnView {
  const startedAt = turn.startedAt === null ? null : turn.startedAt * 1_000;
  const completedAt = turn.completedAt === null ? null : turn.completedAt * 1_000;
  const status = turn.status === "inProgress" ? "inProgress" : normalizeOutcome(turn.status);
  const liveMerge = mergeLiveActivities(
    turn.items
      .filter((item) => !isInternalTeamContinuationItem(item))
      .map((item) =>
        normalizeActivity(
          item,
          item.type === "userMessage" ? startedAt : (completedAt ?? startedAt),
        ),
      ),
    liveActivities,
    status,
  );
  const items = mergeTimelineArtifacts(
    mergeInterruptedTextActivities(liveMerge.items, interruptedTextActivities),
    artifacts,
    liveMerge.aliases,
  );
  if (turn.error) {
    items.push({
      type: "error",
      id: `${turn.id}-error`,
      status: "failed",
      message: turn.error.message,
      ...(isCapacityFailure(turn) ? { failureKind: "modelCapacity" as const } : {}),
    });
  }
  return {
    id: turn.id,
    status,
    ...(isCapacityFailure(turn) ? { failureKind: "modelCapacity" as const } : {}),
    startedAt,
    completedAt,
    durationMs: turn.durationMs,
    progress: liveProgress ?? emptyProgress(turn.startedAt),
    items,
    itemsLoaded,
  };
}

function isConversationMessage(item: ActivityItem): boolean {
  return (
    item.type === "userMessage" ||
    item.type === "agentMessage" ||
    item.type === "plan" ||
    (item.type === "subagentLaunch" && item.source === "codex") ||
    (item.type === "tool" && Boolean(item.images?.length))
  );
}

function conversationTurn(turn: TurnView): TurnView {
  return {
    ...turn,
    items: turn.items.filter(
      (item) =>
        !["reasoning", "command", "fileChange", "tool"].includes(item.type) ||
        (item.type === "tool" && Boolean(item.images?.length)),
    ),
    itemsLoaded: false,
  };
}

function mergeMaterializedTurn(current: TurnView, incoming: TurnView): TurnView {
  const items = [...current.items];
  const itemIndexes = new Map(items.map((item, index) => [item.id, index]));
  for (const item of incoming.items) {
    const index = itemIndexes.get(item.id);
    if (index === undefined) {
      itemIndexes.set(item.id, items.length);
      items.push(item);
    } else {
      items[index] = item;
    }
  }
  for (const [index, item] of incoming.items.entries()) {
    if (item.type !== "plan") continue;
    const preceding = incoming.items[index - 1];
    const position = items.findIndex((candidate) => candidate.id === item.id);
    const anchor = items.findIndex((candidate) => candidate.id === preceding?.id);
    if (anchor > position) {
      const [revised] = items.splice(position, 1);
      items.splice(anchor, 0, revised!);
    }
  }
  const incomingIsTerminal = incoming.status !== "inProgress";
  const currentIsTerminal = current.status !== "inProgress";
  return {
    ...current,
    ...incoming,
    status: currentIsTerminal && !incomingIsTerminal ? current.status : incoming.status,
    startedAt: incoming.startedAt ?? current.startedAt,
    completedAt:
      incoming.completedAt === null
        ? current.completedAt
        : Math.max(current.completedAt ?? 0, incoming.completedAt),
    durationMs: incoming.durationMs ?? current.durationMs,
    progress: { ...current.progress, ...incoming.progress },
    items,
    itemsLoaded: current.itemsLoaded || incoming.itemsLoaded,
  };
}

function mergeLiveActivities(
  items: ActivityItem[],
  liveActivities: ActivityItem[],
  turnStatus: TurnView["status"],
): { items: ActivityItem[]; aliases: Map<string, string> } {
  const result = [...items];
  const unmatchedCanonicalIds = new Set(items.map((item) => item.id));
  const canonicalMatchByLiveId = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const item of liveActivities) {
    const exact = unmatchedCanonicalIds.has(item.id)
      ? item.id
      : items.find(
          (candidate) =>
            unmatchedCanonicalIds.has(candidate.id) &&
            sameRenderedActivity(
              candidate,
              item,
              candidate.status === "inProgress" || item.status === "inProgress",
            ),
        )?.id;
    if (!exact) continue;
    canonicalMatchByLiveId.set(item.id, exact);
    unmatchedCanonicalIds.delete(exact);
  }
  for (const [itemIndex, item] of liveActivities.entries()) {
    const projectedItem =
      turnStatus !== "inProgress" && isAssistantTextActivity(item)
        ? { ...item, status: "completed" as const }
        : item;
    const canonicalId = canonicalMatchByLiveId.get(item.id);
    const existing = canonicalId
      ? result.findIndex((candidate) => candidate.id === canonicalId)
      : -1;
    if (existing >= 0) {
      const canonical = result[existing]!;
      if (item.id !== canonical.id) aliases.set(item.id, canonical.id);
      result[existing] = {
        ...fresherLiveActivity(canonical, projectedItem, turnStatus),
        id: canonical.id,
      } as ActivityItem;
      if (item.type === "plan") {
        const precedingId = liveActivities
          .slice(0, itemIndex)
          .reverse()
          .map((candidate) => canonicalMatchByLiveId.get(candidate.id))
          .find((id) => id !== undefined && result.some((candidate) => candidate.id === id));
        const precedingIndex = result.findIndex((candidate) => candidate.id === precedingId);
        if (precedingIndex > existing) {
          const [revised] = result.splice(existing, 1);
          result.splice(precedingIndex, 0, revised!);
        }
      }
      continue;
    }
    if (
      item.type === "userMessage" &&
      !result.some((candidate) => candidate.type === "userMessage")
    ) {
      result.unshift(projectedItem);
      continue;
    }
    const nextCanonicalId = liveActivities
      .slice(itemIndex + 1)
      .map((candidate) => canonicalMatchByLiveId.get(candidate.id))
      .find(
        (candidateId) =>
          candidateId !== undefined &&
          result.some((existingItem) => existingItem.id === candidateId),
      );
    const finalResponse =
      turnStatus !== "inProgress" &&
      (item.type === "userMessage" ||
        (item.type === "subagentLaunch" && item.source === "codex") ||
        (item.type === "tool" && Boolean(item.images?.length)) ||
        (isAssistantTextActivity(item) && item.phase !== "final_answer"))
        ? result.findIndex(
            (candidate) =>
              candidate.type === "plan" ||
              (candidate.type === "agentMessage" && candidate.phase === "final_answer"),
          )
        : -1;
    const insertion = nextCanonicalId
      ? result.findIndex((candidate) => candidate.id === nextCanonicalId)
      : finalResponse >= 0
        ? finalResponse
        : result.length;
    result.splice(insertion, 0, projectedItem);
  }
  return { items: result, aliases };
}

function fresherLiveActivity(
  current: ActivityItem,
  live: ActivityItem,
  turnStatus: TurnView["status"],
): ActivityItem {
  const turnIsTerminal = turnStatus !== "inProgress";
  if (
    turnStatus === "interrupted" &&
    isAssistantTextActivity(current) &&
    isAssistantTextActivity(live) &&
    current.type === live.type
  ) {
    return richerInterruptedTextActivity(current, { ...live, status: "completed" });
  }
  if (current.status === "inProgress" && live.status !== "inProgress") return live;
  if (current.status !== "inProgress" && live.status === "inProgress") {
    return turnIsTerminal ? current : live;
  }
  if (turnIsTerminal && current.status !== "inProgress") return current;
  if (current.type === live.type && "text" in current && "text" in live) {
    if (current.text.startsWith(live.text) && current.text.length > live.text.length)
      return current;
    if (live.text.startsWith(current.text) && live.text.length > current.text.length) return live;
  }
  if (current.type === "command" && live.type === "command") {
    if (current.output.startsWith(live.output) && current.output.length > live.output.length) {
      return current;
    }
    if (live.output.startsWith(current.output) && live.output.length > current.output.length) {
      return live;
    }
  }
  return live;
}

type AssistantTextActivity = Extract<ActivityItem, { text: string }> & {
  type: "agentMessage" | "plan" | "reasoning";
};

function isAssistantTextActivity(item: ActivityItem): item is AssistantTextActivity {
  return item.type === "agentMessage" || item.type === "plan" || item.type === "reasoning";
}

function mergeInterruptedTextActivities(
  items: ActivityItem[],
  retained: DeepReadonly<InterruptedTextActivityState[]>,
): ActivityItem[] {
  if (!retained.length) return items;
  const result = [...items];
  for (let index = retained.length - 1; index >= 0; index -= 1) {
    const saved = retained[index]!;
    const activity: AssistantTextActivity = {
      type: saved.type ?? "reasoning",
      id: saved.id,
      status: "completed",
      text: saved.text,
      images: [],
      timestamp: saved.timestamp,
      phase: saved.phase ?? null,
    };
    const existing = result.findIndex((item) => item.id === saved.id);
    if (existing >= 0) {
      const current = result[existing]!;
      result[existing] =
        isAssistantTextActivity(current) && current.type === activity.type
          ? richerInterruptedTextActivity(current, activity)
          : current;
      continue;
    }
    const before = saved.beforeItemId
      ? result.findIndex((item) => item.id === saved.beforeItemId)
      : -1;
    result.splice(before >= 0 ? before : result.length, 0, activity);
  }
  return result;
}

function richerInterruptedTextActivity<T extends AssistantTextActivity>(
  canonical: T,
  retained: T,
): T {
  if (!canonical.text || retained.text.startsWith(canonical.text)) {
    return { ...retained, status: "completed" };
  }
  return { ...canonical, status: "completed" };
}

function updateInterruptedTextActivities(
  meta: ThreadMetaState,
  turnId: string,
  incoming: InterruptedTextActivityState[],
  mode: "merge" | "clear",
): boolean {
  const current = meta.interruptedReasoning?.[turnId] ?? [];
  let next: InterruptedTextActivityState[] = [];
  if (mode === "merge") {
    next = current.map((item) => ({ ...item }));
    for (const item of incoming) {
      const index = next.findIndex((candidate) => candidate.id === item.id);
      if (index < 0) {
        next.push({ ...item });
        continue;
      }
      const existing = next[index]!;
      next[index] = existing.text.startsWith(item.text)
        ? {
            ...item,
            text: existing.text,
            timestamp: existing.timestamp ?? item.timestamp,
          }
        : { ...item };
    }
  }
  if (isDeepStrictEqual(current, next)) return false;
  if (next.length) {
    meta.interruptedReasoning ??= {};
    meta.interruptedReasoning[turnId] = next;
  } else if (meta.interruptedReasoning) {
    delete meta.interruptedReasoning[turnId];
    if (!Object.keys(meta.interruptedReasoning).length) delete meta.interruptedReasoning;
  }
  return true;
}

function isInternalTeamContinuationItem(item: Turn["items"][number]): boolean {
  return (
    item.type === "userMessage" &&
    typeof item.clientId === "string" &&
    (item.clientId.startsWith("codexnest-team-claim:") ||
      item.clientId.startsWith("codexnest-team-continuation:") ||
      item.clientId.startsWith(CAPACITY_RETRY_MESSAGE_PREFIX))
  );
}

function normalizeActivity(
  item: Turn["items"][number],
  timestamp: number | null = null,
  lifecycleStarted = false,
): ActivityItem {
  switch (item.type) {
    case "userMessage": {
      const files = item.content
        .filter((part) => part.type === "mention")
        .map((part) => ({ name: part.name, path: part.path }));
      return {
        type: "userMessage",
        id: item.clientId ?? item.id,
        status: "completed",
        text: stripAttachmentContext(
          item.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        ),
        images: item.content
          .filter((part) => part.type === "image" && "url" in part)
          .map((part) => part.url),
        ...(files.length ? { files } : {}),
        timestamp,
        phase: null,
      };
    }
    case "agentMessage":
      return {
        type: "agentMessage",
        id: item.id,
        status: lifecycleStarted ? "inProgress" : "completed",
        text: item.text,
        images: [],
        timestamp,
        phase: item.phase,
        ...(item.delivery ? { delivery: item.delivery } : {}),
        ...(item.questions?.length
          ? {
              questions: item.questions,
              questionKey: createHash("sha256")
                .update(JSON.stringify(item.questions))
                .digest("hex"),
            }
          : {}),
      };
    case "plan":
      return {
        type: "plan",
        id: item.id,
        status: lifecycleStarted ? "inProgress" : "completed",
        text: item.text,
        images: [],
        timestamp,
        phase: null,
      };
    case "reasoning":
      return {
        type: "reasoning",
        id: item.id,
        status: lifecycleStarted ? "inProgress" : "completed",
        text: item.summary.join("\n"),
        images: [],
        timestamp,
        phase: null,
      };
    case "commandExecution":
      return {
        type: "command",
        id: item.id,
        status: normalizeItemStatus(item.status),
        kind: commandKind(item.commandActions),
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput ?? "",
        exitCode: item.exitCode,
      };
    case "fileChange":
      return {
        type: "fileChange",
        id: item.id,
        status: normalizeItemStatus(item.status),
        path: item.changes[0]?.path ?? null,
        patch: item.changes.map((change) => change.diff).join("\n"),
      };
    case "mcpToolCall":
      return {
        type: "tool",
        id: item.id,
        status: normalizeItemStatus(item.status),
        title: `${item.server}: ${item.tool}`,
        detail: item.error ? "Инструмент завершился с ошибкой" : "MCP-инструмент",
        ...toolImageContent(item.result?.content),
      };
    case "dynamicToolCall":
      if (
        item.namespace === "codexnest" &&
        item.tool === "spawn_task" &&
        isRecord(item.arguments) &&
        typeof item.arguments.title === "string" &&
        item.arguments.title.trim()
      ) {
        return {
          type: "subagentLaunch",
          id: item.id,
          status: normalizeItemStatus(item.status),
          title: item.arguments.title.trim(),
          threadId: managedSpawnThreadId(item.contentItems),
        };
      }
      return {
        type: "tool",
        id: item.id,
        status: normalizeItemStatus(item.status),
        title: [item.namespace, item.tool].filter(Boolean).join(":"),
        detail: "Инструмент",
        ...toolImageContent(item.contentItems),
      };
    case "functionCallOutput":
      return {
        type: "tool",
        id: item.id,
        status: "completed",
        title: [item.namespace, item.name].filter(Boolean).join(":"),
        detail: "Инструмент",
        ...toolImageContent(item.output),
      };
    case "subAgentActivity":
    case "collabAgentToolCall": {
      if (item.type === "subAgentActivity" && item.kind === "started") {
        return {
          type: "subagentLaunch",
          id: item.id,
          source: "codex",
          status: lifecycleStarted ? "inProgress" : "completed",
          title: item.agentPath.split("/").filter(Boolean).at(-1) ?? "Субагент",
          threadId: item.agentThreadId || null,
          agentPath: item.agentPath,
          timestamp,
        };
      }
      if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
        return {
          type: "subagentLaunch",
          id: item.id,
          source: "codex",
          status: normalizeItemStatus(item.status),
          title: (item.prompt && subagentTaskTitle(item.prompt)) || "Субагент",
          threadId: item.receiverThreadIds[0] ?? null,
          timestamp,
        };
      }
      return {
        type: "tool",
        id: item.id,
        status: "completed",
        title: item.type,
        detail: "Активность Codex",
      };
    }
    case "imageView":
      return {
        type: "tool",
        id: item.id,
        status: lifecycleStarted ? "inProgress" : "completed",
        title: item.type,
        detail: "",
        // Do not try to read an image before the tool finishes opening it.
        ...(!lifecycleStarted && item.path ? { images: [item.path] } : {}),
      };
    case "imageGeneration":
      return {
        type: "tool",
        id: item.id,
        status: item.failure ? "failed" : normalizeItemStatus(item.status),
        title: item.type,
        detail: item.failure ? "Инструмент завершился с ошибкой" : "",
        ...(!item.failure && item.status === "completed"
          ? item.savedPath
            ? { images: [item.savedPath] }
            : item.result
              ? { images: [`data:image/png;base64,${item.result}`] }
              : {}
          : {}),
      };
    default:
      return {
        type: "tool",
        id: "id" in item ? item.id : `activity-${Date.now()}`,
        status: "completed",
        title: item.type,
        detail: "Активность Codex",
      };
  }
}

function toolImageContent(content: unknown): { images?: string[] } {
  if (!Array.isArray(content)) return {};
  const images = content.flatMap((part): string[] => {
    if (!isRecord(part)) return [];
    const src =
      part.type === "inputImage"
        ? part.imageUrl
        : part.type === "input_image"
          ? part.image_url
          : part.type === "image" &&
              typeof part.mimeType === "string" &&
              /^image\/[a-z0-9.+-]+$/i.test(part.mimeType) &&
              typeof part.data === "string" &&
              part.data
            ? `data:${part.mimeType};base64,${part.data}`
            : null;
    return typeof src === "string" && /^(data:image\/|https?:\/\/)/i.test(src) ? [src] : [];
  });
  return images.length ? { images: [...new Set(images)] } : {};
}

function managedSpawnThreadId(
  contentItems: Extract<Turn["items"][number], { type: "dynamicToolCall" }>["contentItems"],
): string | null {
  for (const content of contentItems ?? []) {
    if (content.type !== "inputText") continue;
    try {
      const value: unknown = JSON.parse(content.text);
      if (isRecord(value) && typeof value.threadId === "string" && value.threadId) {
        return value.threadId;
      }
    } catch {
      // A malformed tool response should not hide the launch activity.
    }
  }
  return null;
}

function mergeTimelineArtifacts(
  items: ActivityItem[],
  artifacts: TimelineArtifact[],
  aliases: Map<string, string> = new Map(),
): ActivityItem[] {
  const result = [...items];
  for (const artifact of artifacts) {
    const resolvedAfterItemId = artifact.afterItemId
      ? (aliases.get(artifact.afterItemId) ?? artifact.afterItemId)
      : null;
    const resolvedArtifact =
      resolvedAfterItemId === artifact.afterItemId
        ? artifact
        : { ...artifact, afterItemId: resolvedAfterItemId };
    const existing = result.findIndex((item) => item.id === artifact.id);
    if (existing >= 0) {
      result[existing] = resolvedArtifact;
      continue;
    }
    const anchor = resolvedAfterItemId
      ? result.findIndex((item) => item.id === resolvedAfterItemId)
      : -1;
    let insertion = anchor >= 0 ? anchor + 1 : fallbackArtifactPosition(result, resolvedArtifact);
    while (insertion < result.length) {
      const candidate = result[insertion];
      if (!candidate || !isTimelineArtifact(candidate)) break;
      if (candidate.afterItemId !== resolvedAfterItemId) break;
      insertion += 1;
    }
    result.splice(insertion, 0, resolvedArtifact);
  }
  return result;
}

function sameRenderedActivity(
  first: ActivityItem,
  second: ActivityItem,
  allowPrefix: boolean,
): boolean {
  if (
    first.type === "subagentLaunch" &&
    second.type === "subagentLaunch" &&
    first.source === "codex" &&
    second.source === "codex"
  ) {
    return Boolean(first.threadId && first.threadId === second.threadId);
  }
  if (
    first.type !== second.type ||
    !["agentMessage", "reasoning", "plan"].includes(first.type) ||
    !("text" in first) ||
    !("text" in second)
  ) {
    return false;
  }
  const compatiblePhase =
    first.phase === second.phase || first.phase === null || second.phase === null;
  if (!compatiblePhase) return false;
  if (first.questionKey && second.questionKey && first.questionKey !== second.questionKey)
    return false;
  if (first.text === second.text) return true;
  return (
    allowPrefix &&
    Boolean(first.text && second.text) &&
    (first.text.startsWith(second.text) || second.text.startsWith(first.text))
  );
}

function fallbackArtifactPosition(items: ActivityItem[], artifact: TimelineArtifact): number {
  if (artifact.type === "userInputResponse") {
    const finalResponse = items.findIndex(
      (item) =>
        item.type === "plan" || (item.type === "agentMessage" && item.phase === "final_answer"),
    );
    if (finalResponse >= 0) return finalResponse;
  }
  let insertion = 0;
  while (items[insertion]?.type === "userMessage") insertion += 1;
  return artifact.type === "planChecklist" || artifact.type === "orchestrationNotice"
    ? insertion
    : items.length;
}

function isTimelineArtifact(item: ActivityItem): item is TimelineArtifact {
  return (
    item.type === "userInputResponse" ||
    item.type === "planChecklist" ||
    item.type === "orchestrationNotice"
  );
}

function turnContainsPlan(turn: Turn): boolean {
  return turn.items.some((item) => item.type === "plan" && item.text.trim());
}

function latestPlanChecklistIsIncomplete(items: TimelineArtifact[] | undefined): boolean {
  if (!items) return false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "planChecklist") {
      return item.steps.some((step) => step.status !== "completed");
    }
  }
  return false;
}

function commandKind(actions: Array<{ type: string }>): "read" | "search" | "command" {
  if (actions.length && actions.every((action) => action.type === "read")) return "read";
  if (
    actions.length &&
    actions.every((action) => ["read", "listFiles", "search"].includes(action.type))
  ) {
    return "search";
  }
  return "command";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyProgress(startedAt: number | null): TurnProgress {
  return {
    startedAt: startedAt === null ? null : startedAt * 1_000,
    explanation: null,
    steps: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
}

export function diffStats(
  diff: string,
): Pick<TurnProgress, "filesChanged" | "additions" | "deletions"> {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match?.[2]) files.add(match[2]);
    } else if (line.startsWith("+++") && !line.endsWith("/dev/null")) {
      files.add(line.replace(/^\+\+\+\s+(?:b\/)?/, ""));
    }
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { filesChanged: files.size, additions, deletions };
}

function normalizeItemStatus(status: string): "inProgress" | "completed" | "failed" {
  const normalized = status.toLowerCase();
  if (normalized.includes("progress") || normalized.includes("running")) return "inProgress";
  if (normalized.includes("fail") || normalized.includes("declin") || normalized.includes("error"))
    return "failed";
  return "completed";
}

function normalizeOutcome(status: string | undefined): ThreadOutcome {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return "completed";
}

function parseThreadGoalStatus(response: unknown): ThreadGoal["status"] | null {
  if (!response || typeof response !== "object" || !("goal" in response)) {
    throw new Error("Invalid thread goal response");
  }
  const goal = (response as { goal?: unknown }).goal;
  if (goal === null) return null;
  if (!goal || typeof goal !== "object" || !("status" in goal)) {
    throw new Error("Invalid thread goal response");
  }
  const status = (goal as { status?: unknown }).status;
  if (
    status !== "active" &&
    status !== "paused" &&
    status !== "blocked" &&
    status !== "usageLimited" &&
    status !== "budgetLimited" &&
    status !== "complete"
  ) {
    throw new Error("Invalid thread goal response");
  }
  return status;
}

function activeTurnId(thread: Thread): string | null {
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (turn?.status === "inProgress") return turn.id;
  }
  return null;
}

function wouldRollbackLiveTurn(current: CachedThread | undefined, incoming: Thread): boolean {
  if (!current?.currentTurnId || incoming.updatedAt > current.thread.updatedAt) return false;
  return !incoming.turns.some((turn) => turn.id === current.currentTurnId);
}

function activityKey(threadId: string, turnId: string, itemId: string): string {
  return `${threadId}:${turnId}:${itemId}`;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function publicVoiceTranscription(job: VoiceTranscriptionState): VoiceTranscriptionJob {
  return {
    id: job.id,
    threadId: job.threadId,
    mode: job.mode,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    audioDurationMs: job.audioDurationMs,
    estimatedTotalSeconds: job.estimatedTotalSeconds,
    error: job.error,
    ...(job.dismissUserInput ? { dismissUserInput: job.dismissUserInput } : {}),
    ...(job.userInput
      ? { userInput: job.userInput, ...(job.transcript ? { transcript: job.transcript } : {}) }
      : {}),
  };
}

function isTerminal(state: ThreadState): state is ThreadOutcome {
  return state === "completed" || state === "failed" || state === "interrupted";
}

function teamOrchestrationIsActive(
  orchestration: CodexNestStateView["threadMeta"][string]["teamOrchestration"],
): boolean {
  if (!orchestration) return false;
  return Object.values(orchestration.tasks).some(
    (task) =>
      task.status === "queued" ||
      task.status === "starting" ||
      task.status === "running" ||
      task.delivery?.status !== "delivered",
  );
}

function threadDraftMatches(
  current: ThreadDraft | undefined,
  value: UpdateThreadDraftRequest,
): boolean {
  if (!current) {
    return (
      value.input === "" &&
      value.images.length === 0 &&
      (value.pasteBlocks?.length ?? 0) === 0 &&
      (value.files?.length ?? 0) === 0 &&
      !value.goalMode &&
      value.annotations.length === 0
    );
  }
  return isDeepStrictEqual(
    {
      input: current.input,
      ...pastedText(current),
      images: current.images,
      files: current.files ?? [],
      goalMode: current.goalMode,
      annotations: current.annotations,
    },
    { ...value, files: value.files ?? [] },
  );
}

function cloneView<T>(value: DeepReadonly<T>): T {
  return structuredClone(value) as T;
}
