import { isFastServiceTier, validPastedText, type MessagePresentation } from "@codexnest/protocol";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ActivityItem,
  ForkMode,
  ForkModeEstimate,
  ForkOperationStatus,
  Project,
  QueuedMessage,
  SessionSettings,
  TaskDefaults,
  ThreadDraft,
  ThreadOutcome,
  UserInputDraft,
  UiLanguage,
  VoiceTranscriptionMode,
  VoiceTranscriptionStatus,
  UserInputVoiceTarget,
} from "@codexnest/protocol";

export type TimelineArtifact = Extract<
  ActivityItem,
  { type: "userInputResponse" | "planChecklist" | "orchestrationNotice" }
>;

export interface InterruptedTextActivityState {
  /** Missing for reasoning captured before other assistant text was retained. */
  type?: "agentMessage" | "plan" | "reasoning";
  id: string;
  text: string;
  timestamp: number | null;
  beforeItemId: string | null;
  phase?: "commentary" | "final_answer" | null;
}

export type ManagedTeamTaskStatus = "queued" | "starting" | "running" | ThreadOutcome;

export type ManagedTeamTaskAccessMode = "readOnly" | "isolatedWrite" | "sharedWrite";

export interface ManagedTeamTaskAccessState {
  mode: ManagedTeamTaskAccessMode;
  writePaths?: string[];
  network?: boolean;
}

export type ManagedTeamTaskResultOutcome = "success" | "partial" | "blocked" | "failed";

export interface ManagedTeamTaskResultCheck {
  name: string;
  outcome: "passed" | "failed" | "notRun";
  details?: string;
}

export interface ManagedTeamTaskResultArtifact {
  label: string;
  path?: string;
  url?: string;
}

export type ManagedTeamTaskBudgetReason = "timeout" | "tokenBudget";

export type ManagedTeamTaskWorkspaceLifecycle =
  | "creating"
  | "ready"
  | "integrating"
  | "integrated"
  | "discarding"
  | "discarded"
  | "conflicted"
  | "recoveryRequired";

export type ManagedTeamTaskWorkspaceFileState =
  | {
      type: "file";
      mode: number;
      digest: string;
    }
  | {
      type: "symlink";
      target: string;
    };

export interface ManagedTeamTaskWorkspaceState {
  lifecycle: ManagedTeamTaskWorkspaceLifecycle;
  repositoryRoot: string;
  gitCommonDir: string;
  worktreePath: string;
  head: string;
  baseline: Record<string, ManagedTeamTaskWorkspaceFileState>;
  createdAt: number;
  updatedAt: number;
  changedPaths?: string[];
  conflictPaths?: string[];
  error?: string;
}

export interface ManagedTeamTaskResultFields {
  outcome?: ManagedTeamTaskResultOutcome;
  checks?: ManagedTeamTaskResultCheck[];
  risks?: string[];
  artifacts?: ManagedTeamTaskResultArtifact[];
}

export interface ManagedTeamTaskResult extends ManagedTeamTaskResultFields {
  summary: string;
  details?: string;
  source: "submitted" | "final_answer" | "agent_message" | "status";
}

export interface ManagedTeamTaskResultCandidate extends ManagedTeamTaskResultFields {
  summary: string;
  details?: string;
  submittedAt: number;
  callId: string;
}

export interface ManagedTeamTaskState {
  id: string;
  childThreadId: string;
  childThreadSource?: string;
  childTurnId?: string;
  startMessageId?: string;
  deliveryVersion?: 1;
  title: string;
  prompt: string;
  status: ManagedTeamTaskStatus;
  dependsOn?: string[];
  predecessorTaskId?: string;
  access?: ManagedTeamTaskAccessState;
  resolvedModel?: string;
  resolvedReasoningEffort?: string | null;
  resolvedServiceTier?: string | null;
  // Retained only so completed tasks from releases with hard budgets remain readable.
  timeoutMinutes?: number;
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  failureReason?: string;
  budgetReason?: ManagedTeamTaskBudgetReason;
  workspace?: ManagedTeamTaskWorkspaceState;
  createdAt: number;
  startedAt?: number;
  lastActivityAt: number;
  recoveryMisses?: number;
  expectedWakeAt?: number;
  lastWatchdogAt?: number;
  watchdog?: {
    status: "pending" | "claimed";
    triggeredAt: number;
    claimId?: string;
    markerId?: string;
    dispatchStartedAt?: number;
    deliveryVersion?: 1;
    contextHash?: string;
  };
  terminalTurnId?: string;
  resultCandidate?: ManagedTeamTaskResultCandidate;
  result?: ManagedTeamTaskResult;
  delivery?: {
    status: "claimed" | "delivered";
    claimId: string;
    parentTurnId?: string;
    markerId?: string;
    dispatchStartedAt?: number;
    deliveryVersion?: 1;
    contextHash?: string;
  };
}

export interface TeamOrchestrationState {
  tasks: Record<string, ManagedTeamTaskState>;
}

export interface SessionArtifactState {
  id: string;
  label: string;
  path: string;
  turnId: string;
  createdAt: number;
}

export interface TeamToolOperationState {
  threadId: string;
  turnId: string;
  callId: string;
  tool:
    | "spawn_task"
    | "followup_task"
    | "steer_task"
    | "cancel_task"
    | "submit_result"
    | "integrate_task"
    | "discard_task_changes";
  argumentsHash: string;
  status: "prepared" | "applied";
  createdAt: number;
  updatedAt: number;
  taskId?: string;
  childThreadSource?: string;
  response?: {
    contentItems: Array<
      | { type: "inputText"; text: string }
      | { type: "inputImage"; imageUrl: string }
      | { type: "inputAudio"; audioUrl: string }
    >;
    success: boolean;
  };
}

export interface SessionSnapshotState {
  sessionId: string;
  forkedFromId?: string;
  name: string | null;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  currentTurnId: string | null;
}

export interface UserInputDraftState extends UserInputDraft {
  turnId: string;
  itemId: string;
  fingerprint: string;
}

export interface CapacityRetryState {
  failedTurnId: string;
  nextAttemptAt: number;
  dispatching?: true;
  goal?: { createdAt: number; updatedAt: number; objective: string };
}

export interface ThreadMetaState {
  pinned: boolean;
  lastReadUpdatedAt: number;
  lastViewedUpdatedAt?: number;
  lastOutcome?: ThreadOutcome;
  outcomeUpdatedAt?: number;
  /** Stable result timestamp in milliseconds; null means no completed turn was found. */
  lastResult?: { turnId: string; completedAt: number } | null;
  capacityRetry?: CapacityRetryState;
  /** Do not revive a retry canceled by the user when terminal events are replayed. */
  capacityRetryHandledTurnId?: string;
  settings?: SessionSettings;
  inheritCodexSettings?: boolean;
  awaitingPlanResponse?: boolean;
  dismissedPlanTurnId?: string;
  timelineArtifacts?: Record<string, TimelineArtifact[]>;
  /** Historical state key retained for backwards compatibility. */
  interruptedReasoning?: Record<string, InterruptedTextActivityState[]>;
  teamOrchestration?: TeamOrchestrationState;
  managedTeamToolsAvailable?: true;
  sessionArtifactsVersion?: 1;
  sessionArtifacts?: SessionArtifactState[];
  managedParent?: {
    parentThreadId: string;
    taskId: string;
  };
  browserEnabled?: true;
  browserBinding?: BrowserBindingState;
  unmaterialized?: boolean;
  draft?: ThreadDraft;
  userInputDrafts?: Record<string, UserInputDraftState>;
  sessionSnapshot?: SessionSnapshotState;
  logicalFork?: { sourceThreadId: string; operationId: string; mode: ForkMode };
}

export interface ForkOperationState {
  id: string;
  sourceThreadId: string;
  lastTurnId: string;
  agentMessageId: string;
  mode: ForkMode;
  status: ForkOperationStatus;
  title: string;
  createdAt: number;
  updatedAt: number;
  targetThreadId: string | null;
  estimate: ForkModeEstimate | null;
  error: string | null;
  sourceCwd: string;
  sourceSettings: SessionSettings;
  rolloutPath: string | null;
  agentText: string;
  nativeAttempt?: { startedAt: number; sequence: number };
  compressedPreparation?: {
    temporaryThreadId: string;
    rolloutPath: string;
    compactFromBytes: number;
    phase: "ready" | "compacting" | "compacted";
    startedAt: number;
    sequence: number;
    compactTurnId?: string;
  };
  compressedMaterialization?: {
    phase: "injecting" | "injected";
    startedAt: number;
  };
  draft?: ThreadDraft;
  queuedMessages: QueuedMessage[];
}

export interface BrowserBindingState {
  bindingId: string;
  instanceId: string;
  attachedAt: number;
  detachedAt?: number;
}

export interface TranscriptionTimingSampleState {
  audioDurationMs: number;
  processingMs: number;
}

export interface VoiceTranscriptionState {
  id: string;
  threadId: string;
  mode: VoiceTranscriptionMode;
  dismissUserInput?: QueuedMessage["dismissUserInput"];
  userInput?: UserInputVoiceTarget;
  status: VoiceTranscriptionStatus;
  createdAt: number;
  startedAt: number | null;
  audioDurationMs: number;
  estimatedTotalSeconds: number | null;
  error: string | null;
  contentType: "audio/webm" | "audio/mp4";
  audioFile?: string;
  audioBytes: number;
  selectionStart: number;
  selectionEnd: number;
  timingProfile?: string;
  transcript?: string;
  attempts?: number;
  nextAttemptAt?: number;
}

export interface VoiceReceiptState {
  threadId: string;
  createdAt: number;
}

export interface MessageReceiptState {
  presentation?: MessagePresentation;
  threadId: string;
  turnId: string | null;
  contentHash: string;
  createdAt: number;
  status?: "prepared" | "delivered" | "rejected" | "canceled";
  deliveryVersion?: 1;
  request?: { method: string; params: Record<string, unknown> };
}

export interface CodexNestState {
  schemaVersion: 1;
  auth: { tokenSha256?: string };
  projects: Project[];
  dismissedProjectPaths?: string[];
  threadMeta: Record<string, ThreadMetaState>;
  projectDrafts?: Record<string, ThreadDraft>;
  transcriptionTimings?: Record<string, TranscriptionTimingSampleState[]>;
  uiLanguage: UiLanguage;
  defaultReasoningEffort?: string;
  taskDefaults?: TaskDefaults;
  messageQueues?: Record<string, QueuedMessage[]>;
  messageReceipts?: Record<string, MessageReceiptState>;
  threadCreations?: Record<
    string,
    {
      projectId: string;
      params: Record<string, unknown>;
      settings?: SessionSettings;
      threadId: string | null;
    }
  >;
  teamToolOperations?: Record<string, TeamToolOperationState>;
  forkOperations?: Record<string, ForkOperationState>;
  voiceTranscriptions?: Record<string, VoiceTranscriptionState>;
  voiceReceipts?: Record<string, VoiceReceiptState>;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type CodexNestStateView = DeepReadonly<CodexNestState>;

export interface StateStoreOptions {
  databasePath?: string;
  deferredFlushMs?: number;
}

export function emptyState(): CodexNestState {
  return {
    schemaVersion: 1,
    auth: {},
    projects: [],
    threadMeta: {},
    uiLanguage: "en",
    messageQueues: {},
    messageReceipts: {},
    threadCreations: {},
    teamToolOperations: {},
    voiceTranscriptions: {},
    voiceReceipts: {},
  };
}

export class StateStore extends EventEmitter {
  private state = emptyState();
  private writeQueue: Promise<void> = Promise.resolve();
  private database?: DatabaseSync;
  private persistedEntries = new Map<string, string>();
  private persistedState = this.state;
  private deferredDirty = false;
  private deferredTimer?: NodeJS.Timeout;
  private loaded = false;

  public readonly databasePath: string;
  private readonly deferredFlushMs: number;

  constructor(
    public readonly path: string,
    options: StateStoreOptions = {},
  ) {
    super();
    this.databasePath = options.databasePath ?? join(dirname(path), "state.sqlite");
    this.deferredFlushMs = options.deferredFlushMs ?? 1_000;
  }

  async load(): Promise<CodexNestState> {
    if (this.loaded) throw new Error("StateStore.load() may only be called once");
    await mkdir(dirname(this.databasePath), { recursive: true, mode: 0o700 });

    if (await pathExists(this.databasePath)) {
      this.database = openStateDatabase(this.databasePath);
      await chmod(this.databasePath, 0o600);
      this.state = loadDatabaseState(this.database);
      this.persistedEntries = serializeStateEntries(this.state);
    } else {
      const legacy = await this.loadLegacyState();
      this.state = legacy.state;
      await this.migrateToDatabase(legacy.exists);
    }
    this.persistedState = this.state;

    const legacyAuth = await readLegacyAuth(this.path);
    if (legacyAuth.exists && legacyAuth.auth.tokenSha256 !== this.state.auth.tokenSha256) {
      const next = validateState({ ...this.state, auth: structuredClone(legacyAuth.auth) });
      await this.persistDatabase(next);
      this.state = next;
    }

    this.loaded = true;
    return this.snapshot();
  }

  view(): CodexNestStateView {
    if (!this.loaded) throw new Error("StateStore.load() must be called first");
    return this.state;
  }

  snapshot(): CodexNestState {
    if (!this.loaded) throw new Error("StateStore.load() must be called first");
    try {
      return structuredClone(this.state);
    } catch (error) {
      throw new Error(
        `CodexNest state contains an uncloneable value at ${uncloneablePath(this.state)}`,
        {
          cause: error,
        },
      );
    }
  }

  update(mutator: (draft: CodexNestState) => void | Promise<void>): Promise<CodexNestStateView> {
    return this.enqueueUpdate(mutator, true);
  }

  updateDeferred(
    mutator: (draft: CodexNestState) => void | Promise<void>,
  ): Promise<CodexNestStateView> {
    return this.enqueueUpdate(mutator, false);
  }

  async flushed(): Promise<void> {
    await this.enqueueFlush(false);
  }

  async checkpoint(): Promise<void> {
    await this.enqueueFlush(true);
  }

  async refreshAuthVerifier(): Promise<boolean> {
    let changed = false;
    const task = this.writeQueue.then(async () => {
      if (!this.loaded) throw new Error("StateStore.load() must be called first");
      const legacy = await readLegacyAuth(this.path);
      if (!legacy.exists || legacy.auth.tokenSha256 === this.state.auth.tokenSha256) return;
      const next = validateState({ ...this.state, auth: structuredClone(legacy.auth) });
      await this.persistDatabase(next);
      this.state = next;
      this.deferredDirty = false;
      this.clearDeferredTimer();
      changed = true;
      this.emit("authRotated");
    });
    this.writeQueue = task.catch(() => undefined);
    await task;
    return changed;
  }

  private enqueueUpdate(
    mutator: (draft: CodexNestState) => void | Promise<void>,
    durable: boolean,
  ): Promise<CodexNestStateView> {
    const task = this.writeQueue.then(async () => {
      if (!this.loaded) throw new Error("StateStore.load() must be called first");
      const draft = createCopyOnWriteDraft(this.state);
      await mutator(draft.value);
      if (!draft.changed()) return;
      const validated = validateState(draft.finish());
      const verifierChanged = validated.auth.tokenSha256 !== this.state.auth.tokenSha256;
      if (durable) {
        await this.persistDatabase(validated);
        this.deferredDirty = false;
        this.clearDeferredTimer();
      } else {
        this.deferredDirty = true;
        this.scheduleDeferredFlush();
      }
      this.state = validated;
      if (verifierChanged) this.emit("authRotated");
    });
    this.writeQueue = task.catch(() => undefined);
    return task.then(() => this.view());
  }

  private async enqueueFlush(exportLegacy: boolean): Promise<void> {
    const task = this.writeQueue.then(async () => {
      if (!this.loaded) throw new Error("StateStore.load() must be called first");
      this.clearDeferredTimer();
      if (this.deferredDirty) {
        await this.persistDatabase(this.state);
        this.deferredDirty = false;
      }
      if (exportLegacy) {
        await this.persistLegacy(this.state);
        this.databaseOrThrow().exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
    });
    this.writeQueue = task.catch(() => undefined);
    await task;
  }

  private scheduleDeferredFlush(): void {
    if (this.deferredTimer) return;
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = undefined;
      void this.enqueueFlush(false).catch((error: unknown) => {
        process.stderr.write(
          `CodexNest deferred state flush failed (${error instanceof Error ? error.name : "Error"})\n`,
        );
      });
    }, this.deferredFlushMs);
    this.deferredTimer.unref();
  }

  private clearDeferredTimer(): void {
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = undefined;
  }

  private async loadLegacyState(): Promise<{ exists: boolean; state: CodexNestState }> {
    try {
      return {
        exists: true,
        state: validateState(JSON.parse(await readFile(this.path, "utf8")) as unknown),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { exists: false, state: emptyState() };
    }
  }

  private async migrateToDatabase(legacyExists: boolean): Promise<void> {
    const temporary = `${this.databasePath}.${process.pid}.${randomUUID()}.tmp`;
    let database: DatabaseSync | undefined;
    try {
      if (legacyExists) await backupLegacyState(this.path);
      const temporaryHandle = await open(temporary, "wx", 0o600);
      await temporaryHandle.close();
      database = createStateDatabase(temporary, false);
      const expectedEntries = serializeStateEntries(this.state);
      writeAllStateEntries(database, expectedEntries);
      const migrated = loadDatabaseState(database);
      if (!stateEntriesEqual(expectedEntries, serializeStateEntries(migrated))) {
        throw new Error("CodexNest SQLite migration verification failed");
      }
      database.close();
      database = undefined;
      await chmod(temporary, 0o600);
      await rename(temporary, this.databasePath);
      await syncDirectory(dirname(this.databasePath));
      this.database = openStateDatabase(this.databasePath);
      this.persistedEntries = serializeStateEntries(this.state);
    } catch (error) {
      database?.close();
      await unlink(temporary).catch(() => undefined);
      await unlink(`${temporary}-journal`).catch(() => undefined);
      await unlink(`${temporary}-wal`).catch(() => undefined);
      await unlink(`${temporary}-shm`).catch(() => undefined);
      throw error;
    }
  }

  private async persistDatabase(next: CodexNestState): Promise<boolean> {
    const { entries, changed, removed } = changedStateEntries(
      this.persistedState,
      next,
      this.persistedEntries,
    );
    if (!changed.length && !removed.length) {
      this.persistedState = next;
      return false;
    }

    const database = this.databaseOrThrow();
    const upsert = database.prepare(
      "INSERT INTO state_entries(namespace, entry_key, json) VALUES (?, ?, ?) " +
        "ON CONFLICT(namespace, entry_key) DO UPDATE SET json = excluded.json",
    );
    const remove = database.prepare(
      "DELETE FROM state_entries WHERE namespace = ? AND entry_key = ?",
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const composite of removed) {
        const [namespace, key] = splitEntryKey(composite);
        remove.run(namespace, key);
      }
      for (const [composite, json] of changed) {
        const [namespace, key] = splitEntryKey(composite);
        upsert.run(namespace, key, json);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    this.persistedEntries = entries;
    this.persistedState = next;
    return true;
  }

  private async persistLegacy(next: CodexNestState): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
      const target = await open(this.path, "r+");
      try {
        await target.chmod(0o600);
        await target.sync();
      } finally {
        await target.close();
      }
      const directory = await open(parent, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private databaseOrThrow(): DatabaseSync {
    if (!this.database) throw new Error("CodexNest state database is not open");
    return this.database;
  }
}

interface CopyOnWriteDraft<T> {
  value: T;
  changed(): boolean;
  finish(): T;
}

interface DraftNode {
  base: DraftContainer;
  copy?: DraftContainer;
  parent?: DraftNode;
  parentKey?: PropertyKey;
  children: Map<PropertyKey, DraftNode>;
  proxy: DraftContainer;
}

type DraftContainer = Record<PropertyKey, unknown> | unknown[];

function createCopyOnWriteDraft<T extends object>(base: T): CopyOnWriteDraft<T> {
  const proxyNodes = new WeakMap<object, DraftNode>();
  const assignedContainers = new Set<DraftContainer>();

  const finishNode = (node: DraftNode): DraftContainer => node.copy ?? node.base;

  const materialize = (value: unknown): unknown => {
    if (!isDraftContainer(value)) return value;
    const node = proxyNodes.get(value);
    if (node) return materialize(finishNode(node));
    assignedContainers.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        value[index] = materialize(value[index]);
      }
      return value;
    }
    for (const [key, child] of Object.entries(value)) {
      Reflect.set(value, key, materialize(child));
    }
    return value;
  };

  const ensureCopy = (node: DraftNode): DraftContainer => {
    if (node.copy) return node.copy;
    node.copy = Array.isArray(node.base) ? [...node.base] : { ...node.base };
    if (node.parent && node.parentKey !== undefined) {
      const parentCopy = ensureCopy(node.parent);
      Reflect.set(parentCopy, node.parentKey, node.copy);
    }
    return node.copy;
  };

  const createNode = (
    value: DraftContainer,
    parent?: DraftNode,
    parentKey?: PropertyKey,
  ): DraftNode => {
    const node = {
      base: value,
      parent,
      parentKey,
      children: new Map<PropertyKey, DraftNode>(),
    } as DraftNode;
    node.proxy = new Proxy(value, {
      get(_target, key) {
        const current = Reflect.get(node.copy ?? node.base, key);
        if (!isDraftContainer(current)) return current;
        let child = node.children.get(key);
        if (!child || finishNode(child) !== current) {
          child = createNode(current, node, key);
          node.children.set(key, child);
        }
        return child.proxy;
      },
      set(_target, key, valueToSet) {
        const source = node.copy ?? node.base;
        const current = Reflect.get(source, key);
        const next = materialize(valueToSet);
        if (Object.is(current, next)) return true;
        node.children.delete(key);
        return Reflect.set(ensureCopy(node), key, next);
      },
      deleteProperty(_target, key) {
        if (!Reflect.has(node.copy ?? node.base, key)) return true;
        node.children.delete(key);
        return Reflect.deleteProperty(ensureCopy(node), key);
      },
      has(_target, key) {
        return Reflect.has(node.copy ?? node.base, key);
      },
      ownKeys() {
        return Reflect.ownKeys(node.copy ?? node.base);
      },
      getOwnPropertyDescriptor(_target, key) {
        return Reflect.getOwnPropertyDescriptor(node.copy ?? node.base, key);
      },
    });
    proxyNodes.set(node.proxy, node);
    return node;
  };

  const root = createNode(base as DraftContainer);
  return {
    value: root.proxy as T,
    changed: () => root.copy !== undefined,
    finish: () => {
      for (const assigned of assignedContainers) materialize(assigned);
      return finishNode(root) as T;
    },
  };
}

function isDraftContainer(value: unknown): value is DraftContainer {
  return value !== null && typeof value === "object";
}

function uncloneablePath(value: unknown, path = "state"): string {
  try {
    structuredClone(value);
    return path;
  } catch {
    if (!isDraftContainer(value)) return path;
    for (const [key, child] of Object.entries(value)) {
      try {
        structuredClone(child);
      } catch {
        return uncloneablePath(child, `${path}.${key}`);
      }
    }
    return path;
  }
}

const ROOT_NAMESPACE = "root";
const MAP_NAMESPACES = [
  "projectDrafts",
  "threadMeta",
  "transcriptionTimings",
  "messageQueues",
  "messageReceipts",
  "threadCreations",
  "teamToolOperations",
  "forkOperations",
  "voiceTranscriptions",
  "voiceReceipts",
] as const;
const MAP_NAMESPACE_SET = new Set<string>(MAP_NAMESPACES);
const ROOT_KEYS = [
  "schemaVersion",
  "auth",
  "projects",
  "dismissedProjectPaths",
  "uiLanguage",
  "defaultReasoningEffort",
  "taskDefaults",
] as const;
const REQUIRED_ROOT_KEYS = new Set(["schemaVersion", "auth", "projects", "uiLanguage"]);

interface StateEntryRow {
  namespace: string;
  entry_key: string;
  json: string;
}

function serializeStateEntries(state: CodexNestState): Map<string, string> {
  const entries = new Map<string, string>();
  for (const key of ROOT_KEYS) {
    const value = state[key];
    if (value !== undefined) entries.set(entryKey(ROOT_NAMESPACE, key), JSON.stringify(value));
  }
  for (const namespace of MAP_NAMESPACES) {
    const values = state[namespace] ?? {};
    for (const [key, value] of Object.entries(values)) {
      entries.set(entryKey(namespace, key), JSON.stringify(value));
    }
  }
  return entries;
}

function changedStateEntries(
  previous: CodexNestState,
  next: CodexNestState,
  persisted: Map<string, string>,
): { entries: Map<string, string>; changed: Array<[string, string]>; removed: string[] } {
  const entries = new Map(persisted);
  const changed: Array<[string, string]> = [];
  const removed: string[] = [];
  const updateEntry = (namespace: string, key: string, value: unknown): void => {
    const composite = entryKey(namespace, key);
    if (value === undefined) {
      if (entries.delete(composite)) removed.push(composite);
      return;
    }
    const json = JSON.stringify(value);
    if (entries.get(composite) === json) return;
    entries.set(composite, json);
    changed.push([composite, json]);
  };

  for (const key of ROOT_KEYS) {
    if (!Object.is(previous[key], next[key])) updateEntry(ROOT_NAMESPACE, key, next[key]);
  }
  for (const namespace of MAP_NAMESPACES) {
    const previousValues = previous[namespace] ?? {};
    const nextValues = next[namespace] ?? {};
    if (previousValues === nextValues) continue;
    const keys = new Set([...Object.keys(previousValues), ...Object.keys(nextValues)]);
    for (const key of keys) {
      if (!Object.is(previousValues[key], nextValues[key])) {
        updateEntry(namespace, key, nextValues[key]);
      }
    }
  }
  return { entries, changed, removed };
}

function stateEntriesEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function loadDatabaseState(database: DatabaseSync): CodexNestState {
  const rows = database
    .prepare("SELECT namespace, entry_key, json FROM state_entries ORDER BY namespace, entry_key")
    .all() as unknown as StateEntryRow[];
  const state: Record<string, unknown> = {
    threadMeta: {},
    transcriptionTimings: {},
    messageQueues: {},
    messageReceipts: {},
    threadCreations: {},
    teamToolOperations: {},
    voiceTranscriptions: {},
    voiceReceipts: {},
  };
  const foundRootKeys = new Set<string>();
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.json) as unknown;
    } catch {
      throw new Error(`Corrupt JSON in CodexNest SQLite entry ${row.namespace}/${row.entry_key}`);
    }
    if (row.namespace === ROOT_NAMESPACE) {
      if (!(ROOT_KEYS as readonly string[]).includes(row.entry_key)) {
        throw new Error(`Unknown CodexNest SQLite root key ${row.entry_key}`);
      }
      state[row.entry_key] = value;
      foundRootKeys.add(row.entry_key);
      continue;
    }
    if (!MAP_NAMESPACE_SET.has(row.namespace)) {
      throw new Error(`Unknown CodexNest SQLite namespace ${row.namespace}`);
    }
    const namespace = (state[row.namespace] ??= {}) as Record<string, unknown>;
    namespace[row.entry_key] = value;
  }
  if ([...REQUIRED_ROOT_KEYS].some((key) => !foundRootKeys.has(key))) {
    throw new Error("Corrupt CodexNest SQLite state: required root entry is missing");
  }
  return validateState(state);
}

function writeAllStateEntries(database: DatabaseSync, entries: Map<string, string>): void {
  const insert = database.prepare(
    "INSERT INTO state_entries(namespace, entry_key, json) VALUES (?, ?, ?)",
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [composite, json] of entries) {
      const [namespace, key] = splitEntryKey(composite);
      insert.run(namespace, key, json);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function createStateDatabase(path: string, wal = true): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = FULL;
    CREATE TABLE state_entries (
      namespace TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY(namespace, entry_key)
    ) WITHOUT ROWID;
    PRAGMA user_version = 1;
  `);
  if (wal) database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 1000;");
  return database;
}

function openStateDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const version = database.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    if (version?.user_version !== 1) {
      throw new Error(`Unsupported CodexNest SQLite schema version ${version?.user_version ?? 0}`);
    }
    const quickCheck = database.prepare("PRAGMA quick_check").get() as
      { quick_check?: string } | undefined;
    if (quickCheck?.quick_check !== "ok") {
      throw new Error(`Corrupt CodexNest SQLite database: ${quickCheck?.quick_check ?? "unknown"}`);
    }
    database.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; " +
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 1000;",
    );
    database.prepare("SELECT namespace, entry_key, json FROM state_entries LIMIT 1").get();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function entryKey(namespace: string, key: string): string {
  return `${namespace}\0${key}`;
}

function splitEntryKey(composite: string): [string, string] {
  const separator = composite.indexOf("\0");
  if (separator < 0) throw new Error("Invalid CodexNest SQLite entry key");
  return [composite.slice(0, separator), composite.slice(separator + 1)];
}

async function backupLegacyState(path: string): Promise<void> {
  const backup = `${path}.pre-sqlite`;
  try {
    await copyFile(path, backup, fsConstants.COPYFILE_EXCL);
    await chmod(backup, 0o600);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const [source, existing] = await Promise.all([readFile(path), readFile(backup)]);
    if (!source.equals(existing)) {
      throw new Error("CodexNest legacy state backup exists but does not match state.json", {
        cause: error,
      });
    }
  }
}

async function readLegacyAuth(
  path: string,
): Promise<
  { exists: false; auth: Record<string, never> } | { exists: true; auth: CodexNestState["auth"] }
> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value) || !isRecord(value.auth)) {
      throw new Error("Corrupt auth control data in CodexNest legacy state");
    }
    const verifier = value.auth.tokenSha256;
    if (
      verifier !== undefined &&
      (typeof verifier !== "string" || !/^[a-f\d]{64}$/iu.test(verifier))
    ) {
      throw new Error("Corrupt token verifier in CodexNest legacy state");
    }
    return { exists: true, auth: verifier === undefined ? {} : { tokenSha256: verifier } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, auth: {} };
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function validateState(value: unknown): CodexNestState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported or corrupt CodexNest state schema");
  }
  if (value.devices !== undefined) {
    if (!isRecord(value.devices) || Object.keys(value.devices).length) {
      throw new Error("Unsupported legacy device registrations in CodexNest state");
    }
    delete value.devices;
  }
  if (!isRecord(value.auth) || !Array.isArray(value.projects)) {
    throw new Error("Corrupt CodexNest state");
  }
  if (
    value.dismissedProjectPaths !== undefined &&
    (!Array.isArray(value.dismissedProjectPaths) ||
      value.dismissedProjectPaths.some(
        (path) => typeof path !== "string" || !path.trim() || !isAbsolute(path),
      ))
  ) {
    throw new Error("Corrupt dismissed project paths in CodexNest state");
  }
  if (!isRecord(value.threadMeta)) {
    throw new Error("Corrupt CodexNest state");
  }
  if (
    value.projectDrafts !== undefined &&
    (!isRecord(value.projectDrafts) || !Object.values(value.projectDrafts).every(isThreadDraft))
  ) {
    throw new Error("Corrupt project drafts in CodexNest state");
  }
  const transcriptionTimings = normalizeTranscriptionTimings(value.transcriptionTimings);
  if (value.messageQueues !== undefined && !isRecord(value.messageQueues)) {
    throw new Error("Corrupt message queues in CodexNest state");
  }
  if (value.messageReceipts !== undefined && !isRecord(value.messageReceipts)) {
    throw new Error("Corrupt message receipts in CodexNest state");
  }
  if (value.teamToolOperations !== undefined && !isRecord(value.teamToolOperations)) {
    throw new Error("Corrupt Team tool operations in CodexNest state");
  }
  if (value.forkOperations !== undefined && !isRecord(value.forkOperations)) {
    throw new Error("Corrupt fork operations in CodexNest state");
  }
  if (value.voiceTranscriptions !== undefined && !isRecord(value.voiceTranscriptions)) {
    throw new Error("Corrupt voice transcriptions in CodexNest state");
  }
  if (value.voiceReceipts !== undefined && !isRecord(value.voiceReceipts)) {
    throw new Error("Corrupt voice receipts in CodexNest state");
  }
  if (
    value.defaultReasoningEffort !== undefined &&
    (typeof value.defaultReasoningEffort !== "string" || !value.defaultReasoningEffort.trim())
  ) {
    throw new Error("Corrupt default reasoning effort in CodexNest state");
  }
  if (isRecord(value.taskDefaults)) normalizeServiceTier(value.taskDefaults);
  if (value.taskDefaults !== undefined && !isTaskDefaults(value.taskDefaults)) {
    throw new Error("Corrupt task defaults in CodexNest state");
  }
  if (
    value.uiLanguage !== undefined &&
    (typeof value.uiLanguage !== "string" || !["en", "ru"].includes(value.uiLanguage))
  ) {
    throw new Error("Corrupt UI language in CodexNest state");
  }
  for (const project of value.projects) {
    if (!isProject(project)) throw new Error("Corrupt project in CodexNest state");
  }
  for (const meta of Object.values(value.threadMeta)) {
    if (isRecord(meta) && isRecord(meta.settings)) normalizeServiceTier(meta.settings);
    if (isRecord(meta) && isLegacyTeamOrchestrationState(meta.teamOrchestration)) {
      delete meta.teamOrchestration;
    }
    if (isRecord(meta) && meta.teamToolsVersion === 2) {
      meta.managedTeamToolsAvailable = true;
      delete meta.teamToolsVersion;
    }
    if (isRecord(meta) && meta.teamToolsVersion === 1) {
      const orchestration = meta.teamOrchestration;
      if (
        isRecord(orchestration) &&
        isRecord(orchestration.tasks) &&
        Object.keys(orchestration.tasks).length
      ) {
        throw new Error("Unsupported unfinished legacy Team orchestration in CodexNest state");
      }
      delete meta.teamToolsVersion;
      delete meta.teamOrchestration;
      if (isRecord(meta.settings) && meta.settings.collaborationMode === "team") {
        meta.settings.collaborationMode = "default";
      }
    }
    if (isRecord(meta)) retireActiveManagedTaskBudgets(meta.teamOrchestration);
    if (
      !isRecord(meta) ||
      typeof meta.pinned !== "boolean" ||
      typeof meta.lastReadUpdatedAt !== "number" ||
      (meta.lastViewedUpdatedAt !== undefined && typeof meta.lastViewedUpdatedAt !== "number") ||
      (meta.lastOutcome !== undefined &&
        !["completed", "failed", "interrupted"].includes(String(meta.lastOutcome))) ||
      (meta.outcomeUpdatedAt !== undefined && typeof meta.outcomeUpdatedAt !== "number") ||
      (meta.lastResult !== undefined &&
        meta.lastResult !== null &&
        (!isRecord(meta.lastResult) ||
          typeof meta.lastResult.turnId !== "string" ||
          typeof meta.lastResult.completedAt !== "number" ||
          !Number.isFinite(meta.lastResult.completedAt))) ||
      (meta.capacityRetry !== undefined && !isCapacityRetry(meta.capacityRetry)) ||
      (meta.capacityRetryHandledTurnId !== undefined &&
        typeof meta.capacityRetryHandledTurnId !== "string") ||
      (meta.settings !== undefined && !isSessionSettings(meta.settings)) ||
      (meta.inheritCodexSettings !== undefined && typeof meta.inheritCodexSettings !== "boolean") ||
      (meta.awaitingPlanResponse !== undefined && typeof meta.awaitingPlanResponse !== "boolean") ||
      (meta.dismissedPlanTurnId !== undefined && typeof meta.dismissedPlanTurnId !== "string") ||
      (meta.timelineArtifacts !== undefined && !isTimelineArtifacts(meta.timelineArtifacts)) ||
      (meta.interruptedReasoning !== undefined &&
        !isInterruptedReasoning(meta.interruptedReasoning)) ||
      (meta.teamOrchestration !== undefined && !isTeamOrchestrationState(meta.teamOrchestration)) ||
      meta.teamToolsVersion !== undefined ||
      (meta.managedTeamToolsAvailable !== undefined && meta.managedTeamToolsAvailable !== true) ||
      (meta.sessionArtifactsVersion !== undefined && meta.sessionArtifactsVersion !== 1) ||
      (meta.sessionArtifacts !== undefined && meta.sessionArtifactsVersion !== 1) ||
      (meta.sessionArtifacts !== undefined && !isSessionArtifacts(meta.sessionArtifacts)) ||
      (meta.managedParent !== undefined && !isManagedParent(meta.managedParent)) ||
      (meta.browserEnabled !== undefined && meta.browserEnabled !== true) ||
      (meta.browserBinding !== undefined && !isBrowserBinding(meta.browserBinding)) ||
      (meta.unmaterialized !== undefined && typeof meta.unmaterialized !== "boolean") ||
      (meta.draft !== undefined && !isThreadDraft(meta.draft)) ||
      (meta.userInputDrafts !== undefined && !isUserInputDrafts(meta.userInputDrafts)) ||
      (meta.sessionSnapshot !== undefined && !isSessionSnapshot(meta.sessionSnapshot)) ||
      (meta.logicalFork !== undefined && !isLogicalFork(meta.logicalFork))
    ) {
      throw new Error("Corrupt thread metadata in CodexNest state");
    }
    compactTerminalWorkspaceBaselines(meta as unknown as ThreadMetaState);
  }
  for (const [threadId, messages] of Object.entries(value.messageQueues ?? {})) {
    if (
      !Array.isArray(messages) ||
      messages.some((message) => !isQueuedMessage(message, threadId))
    ) {
      throw new Error("Corrupt queued message in CodexNest state");
    }
  }
  for (const receipt of Object.values(value.messageReceipts ?? {})) {
    if (
      !isRecord(receipt) ||
      typeof receipt.threadId !== "string" ||
      (receipt.turnId !== null && typeof receipt.turnId !== "string") ||
      typeof receipt.contentHash !== "string" ||
      !/^[a-f\d]{64}$/iu.test(receipt.contentHash) ||
      typeof receipt.createdAt !== "number" ||
      (receipt.status !== undefined &&
        !["prepared", "delivered", "rejected", "canceled"].includes(receipt.status as string)) ||
      (receipt.deliveryVersion !== undefined && receipt.deliveryVersion !== 1) ||
      (receipt.presentation !== undefined &&
        (!isRecord(receipt.presentation) ||
          typeof receipt.presentation.input !== "string" ||
          !validPastedText(receipt.presentation, receipt.presentation.input))) ||
      (receipt.request !== undefined &&
        (!isRecord(receipt.request) ||
          typeof receipt.request.method !== "string" ||
          !isRecord(receipt.request.params)))
    ) {
      throw new Error("Corrupt message receipt");
    }
  }
  if (value.threadCreations !== undefined && !isRecord(value.threadCreations)) {
    throw new Error("Corrupt thread creations");
  }
  for (const creation of Object.values(value.threadCreations ?? {})) {
    if (
      !isRecord(creation) ||
      typeof creation.projectId !== "string" ||
      !isRecord(creation.params) ||
      (creation.settings !== undefined && !isSessionSettings(creation.settings)) ||
      (creation.threadId !== null && typeof creation.threadId !== "string")
    ) {
      throw new Error("Corrupt thread creation");
    }
  }
  for (const operation of Object.values(value.teamToolOperations ?? {})) {
    if (!isTeamToolOperation(operation)) {
      throw new Error("Corrupt Team tool operation");
    }
  }
  for (const [operationId, operation] of Object.entries(value.forkOperations ?? {})) {
    if (!isForkOperation(operation, operationId)) throw new Error("Corrupt fork operation");
  }
  for (const [threadId, job] of Object.entries(value.voiceTranscriptions ?? {})) {
    if (!isVoiceTranscription(job, threadId)) {
      throw new Error("Corrupt voice transcription in CodexNest state");
    }
  }
  for (const receipt of Object.values(value.voiceReceipts ?? {})) {
    if (
      !isRecord(receipt) ||
      typeof receipt.threadId !== "string" ||
      typeof receipt.createdAt !== "number"
    ) {
      throw new Error("Corrupt voice receipt");
    }
  }
  const verifier = value.auth.tokenSha256;
  if (
    verifier !== undefined &&
    (typeof verifier !== "string" || !/^[a-f\d]{64}$/i.test(verifier))
  ) {
    throw new Error("Corrupt token verifier in CodexNest state");
  }
  const state = value as unknown as CodexNestState;
  return {
    ...state,
    ...(transcriptionTimings === undefined ? {} : { transcriptionTimings }),
    ...(value.uiLanguage === undefined ? { uiLanguage: "ru" as const } : {}),
  };
}

function isCapacityRetry(value: unknown): value is CapacityRetryState {
  return (
    isRecord(value) &&
    isBoundedString(value.failedTurnId, 500) &&
    isNonNegativeFiniteNumber(value.nextAttemptAt) &&
    (value.dispatching === undefined || value.dispatching === true) &&
    (value.goal === undefined ||
      (isRecord(value.goal) &&
        isNonNegativeFiniteNumber(value.goal.createdAt) &&
        isNonNegativeFiniteNumber(value.goal.updatedAt) &&
        typeof value.goal.objective === "string"))
  );
}

function isUserInputDrafts(value: unknown): value is Record<string, UserInputDraftState> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, draft]) =>
      /^[a-f\d]{64}$/iu.test(key) &&
      isRecord(draft) &&
      hasOnlyKeys(draft, [
        "turnId",
        "itemId",
        "fingerprint",
        "answers",
        "currentQuestionId",
        "revision",
        "updatedAt",
        "appliedRecordingIds",
        "submission",
      ]) &&
      isBoundedString(draft.turnId, 500) &&
      isBoundedString(draft.itemId, 500) &&
      typeof draft.fingerprint === "string" &&
      /^[a-f\d]{64}$/iu.test(draft.fingerprint) &&
      isRecord(draft.answers) &&
      (draft.appliedRecordingIds === undefined ||
        (Array.isArray(draft.appliedRecordingIds) &&
          draft.appliedRecordingIds.every((id) => typeof id === "string"))) &&
      (draft.submission === undefined ||
        draft.submission === null ||
        (isRecord(draft.submission) &&
          Array.isArray(draft.submission.recordingIds) &&
          draft.submission.recordingIds.every((id) => typeof id === "string") &&
          typeof draft.submission.clientMessageId === "string" &&
          ["waiting", "sending", "failed"].includes(String(draft.submission.status)) &&
          (draft.submission.error === undefined || typeof draft.submission.error === "string"))) &&
      Object.values(draft.answers).every(
        (answers) =>
          Array.isArray(answers) &&
          answers.length === 1 &&
          typeof answers[0] === "string" &&
          Boolean(answers[0].trim()),
      ) &&
      (draft.currentQuestionId === null || typeof draft.currentQuestionId === "string") &&
      typeof draft.revision === "number" &&
      Number.isSafeInteger(draft.revision) &&
      draft.revision > 0 &&
      isNonNegativeFiniteNumber(draft.updatedAt),
  );
}

function isInterruptedReasoning(
  value: unknown,
): value is Record<string, InterruptedTextActivityState[]> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([turnId, items]) =>
      isBoundedString(turnId, 500) &&
      Array.isArray(items) &&
      items.length > 0 &&
      items.every(
        (item) =>
          isRecord(item) &&
          hasOnlyKeys(item, ["type", "id", "text", "timestamp", "beforeItemId", "phase"]) &&
          (item.type === undefined ||
            ["agentMessage", "plan", "reasoning"].includes(String(item.type))) &&
          isBoundedString(item.id, 500) &&
          typeof item.text === "string" &&
          Boolean(item.text.trim()) &&
          (item.timestamp === null || isNonNegativeFiniteNumber(item.timestamp)) &&
          (item.beforeItemId === null || isBoundedString(item.beforeItemId, 500)) &&
          (item.phase === undefined ||
            item.phase === null ||
            ["commentary", "final_answer"].includes(String(item.phase))),
      ),
  );
}

function isSessionSnapshot(value: unknown): value is SessionSnapshotState {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    (value.forkedFromId === undefined ||
      (typeof value.forkedFromId === "string" && value.forkedFromId.length > 0)) &&
    (value.name === null || typeof value.name === "string") &&
    typeof value.preview === "string" &&
    typeof value.cwd === "string" &&
    isAbsolute(value.cwd) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    typeof value.archived === "boolean" &&
    (value.currentTurnId === null || typeof value.currentTurnId === "string")
  );
}

function isLogicalFork(value: unknown): value is ThreadMetaState["logicalFork"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["sourceThreadId", "operationId", "mode"]) &&
    isBoundedString(value.sourceThreadId, 500) &&
    isBoundedString(value.operationId, 500) &&
    (value.mode === "compressed" || value.mode === "exact")
  );
}

function isForkModeEstimate(value: unknown): value is ForkModeEstimate {
  return (
    isRecord(value) &&
    typeof value.available === "boolean" &&
    (value.estimatedBytes === null || isNonNegativeFiniteNumber(value.estimatedBytes)) &&
    (value.estimatedSeconds === null ||
      (isRecord(value.estimatedSeconds) &&
        isNonNegativeFiniteNumber(value.estimatedSeconds.minSeconds) &&
        isNonNegativeFiniteNumber(value.estimatedSeconds.maxSeconds) &&
        value.estimatedSeconds.minSeconds <= value.estimatedSeconds.maxSeconds)) &&
    (value.unavailableReason === null || typeof value.unavailableReason === "string")
  );
}

function isForkOperation(value: unknown, operationId: string): value is ForkOperationState {
  return (
    isRecord(value) &&
    value.id === operationId &&
    isBoundedString(value.sourceThreadId, 500) &&
    isBoundedString(value.lastTurnId, 500) &&
    isBoundedString(value.agentMessageId, 500) &&
    (value.mode === "compressed" || value.mode === "exact") &&
    ["preparing", "reconciling", "ready", "failed"].includes(String(value.status)) &&
    typeof value.title === "string" &&
    isNonNegativeFiniteNumber(value.createdAt) &&
    isNonNegativeFiniteNumber(value.updatedAt) &&
    (value.targetThreadId === null || isBoundedString(value.targetThreadId, 500)) &&
    (value.estimate === null || isForkModeEstimate(value.estimate)) &&
    (value.error === null || typeof value.error === "string") &&
    typeof value.sourceCwd === "string" &&
    isAbsolute(value.sourceCwd) &&
    isSessionSettings(value.sourceSettings) &&
    (value.rolloutPath === null ||
      (typeof value.rolloutPath === "string" && isAbsolute(value.rolloutPath))) &&
    typeof value.agentText === "string" &&
    (value.nativeAttempt === undefined ||
      (isRecord(value.nativeAttempt) &&
        isNonNegativeFiniteNumber(value.nativeAttempt.startedAt) &&
        typeof value.nativeAttempt.sequence === "number" &&
        Number.isSafeInteger(value.nativeAttempt.sequence) &&
        value.nativeAttempt.sequence > 0)) &&
    (value.compressedPreparation === undefined ||
      (value.mode === "compressed" &&
        isRecord(value.compressedPreparation) &&
        isBoundedString(value.compressedPreparation.temporaryThreadId, 500) &&
        typeof value.compressedPreparation.rolloutPath === "string" &&
        isAbsolute(value.compressedPreparation.rolloutPath) &&
        isNonNegativeFiniteNumber(value.compressedPreparation.compactFromBytes) &&
        ["ready", "compacting", "compacted"].includes(String(value.compressedPreparation.phase)) &&
        isNonNegativeFiniteNumber(value.compressedPreparation.startedAt) &&
        typeof value.compressedPreparation.sequence === "number" &&
        Number.isSafeInteger(value.compressedPreparation.sequence) &&
        value.compressedPreparation.sequence >= 0 &&
        (value.compressedPreparation.compactTurnId === undefined ||
          isBoundedString(value.compressedPreparation.compactTurnId, 500)))) &&
    (value.compressedMaterialization === undefined ||
      (value.mode === "compressed" &&
        isRecord(value.compressedMaterialization) &&
        ["injecting", "injected"].includes(String(value.compressedMaterialization.phase)) &&
        isNonNegativeFiniteNumber(value.compressedMaterialization.startedAt))) &&
    (value.draft === undefined || isThreadDraft(value.draft)) &&
    Array.isArray(value.queuedMessages) &&
    value.queuedMessages.every((message) => isQueuedMessage(message, operationId))
  );
}

function isBrowserBinding(value: unknown): value is BrowserBindingState {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["bindingId", "instanceId", "attachedAt", "detachedAt"]) &&
    isBoundedString(value.bindingId, 200) &&
    isBoundedString(value.instanceId, 200) &&
    isNonNegativeFiniteNumber(value.attachedAt) &&
    (value.detachedAt === undefined || isNonNegativeFiniteNumber(value.detachedAt))
  );
}

function isSessionArtifacts(value: unknown): value is SessionArtifactState[] {
  return (
    Array.isArray(value) &&
    value.every(
      (artifact) =>
        isRecord(artifact) &&
        hasOnlyKeys(artifact, ["id", "label", "path", "turnId", "createdAt"]) &&
        isBoundedString(artifact.id, 128) &&
        isBoundedString(artifact.label, 500) &&
        isSafeRelativePath(artifact.path) &&
        isBoundedString(artifact.turnId, 500) &&
        isNonNegativeFiniteNumber(artifact.createdAt),
    )
  );
}

function compactTerminalWorkspaceBaselines(meta: ThreadMetaState): void {
  for (const task of Object.values(meta.teamOrchestration?.tasks ?? {})) {
    if (
      task.workspace &&
      (task.workspace.lifecycle === "integrated" || task.workspace.lifecycle === "discarded")
    ) {
      task.workspace.baseline = {};
    }
  }
}

function retireActiveManagedTaskBudgets(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.tasks)) return;
  for (const task of Object.values(value.tasks)) {
    if (!isRecord(task) || !["queued", "starting", "running"].includes(String(task.status))) {
      continue;
    }
    delete task.timeoutMinutes;
    delete task.tokenBudget;
    if (["timeout", "tokenBudget"].includes(String(task.budgetReason))) {
      delete task.budgetReason;
    }
  }
}

function normalizeTranscriptionTimings(
  value: unknown,
): Record<string, TranscriptionTimingSampleState[]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Corrupt transcription timings in CodexNest state");

  const normalized: Record<string, TranscriptionTimingSampleState[]> = {};
  for (const [profile, samples] of Object.entries(value)) {
    if (!Array.isArray(samples) || samples.length > 20) {
      throw new Error("Corrupt transcription timings in CodexNest state");
    }
    normalized[profile] = samples.flatMap((sample) => {
      if (typeof sample === "number" && Number.isFinite(sample) && sample > 0) return [];
      if (
        !isRecord(sample) ||
        typeof sample.audioDurationMs !== "number" ||
        !Number.isFinite(sample.audioDurationMs) ||
        sample.audioDurationMs <= 0 ||
        typeof sample.processingMs !== "number" ||
        !Number.isFinite(sample.processingMs) ||
        sample.processingMs <= 0
      ) {
        throw new Error("Corrupt transcription timings in CodexNest state");
      }
      return [
        {
          audioDurationMs: sample.audioDurationMs,
          processingMs: sample.processingMs,
        },
      ];
    });
  }
  return normalized;
}

function isTimelineArtifacts(value: unknown): value is Record<string, TimelineArtifact[]> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (items) => Array.isArray(items) && items.every(isTimelineArtifact),
  );
}

function isTimelineArtifact(value: unknown): value is TimelineArtifact {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.timestamp !== "number" ||
    (value.afterItemId !== null && typeof value.afterItemId !== "string")
  ) {
    return false;
  }
  if (value.type === "userInputResponse") {
    return (
      value.status === "completed" &&
      Array.isArray(value.entries) &&
      value.entries.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.header === "string" &&
          typeof entry.question === "string" &&
          Array.isArray(entry.answers) &&
          entry.answers.every((answer) => typeof answer === "string"),
      )
    );
  }
  if (value.type === "planChecklist") {
    return (
      ["inProgress", "completed", "failed"].includes(String(value.status)) &&
      (value.explanation === null || typeof value.explanation === "string") &&
      Array.isArray(value.steps) &&
      value.steps.every(
        (step) =>
          isRecord(step) &&
          typeof step.step === "string" &&
          ["pending", "inProgress", "completed"].includes(String(step.status)),
      )
    );
  }
  if (value.type === "orchestrationNotice") {
    return (
      value.status === "completed" &&
      Array.isArray(value.agents) &&
      value.agents.length > 0 &&
      value.agents.every(
        (agent) =>
          isRecord(agent) &&
          typeof agent.threadId === "string" &&
          typeof agent.title === "string" &&
          (agent.nickname === null || typeof agent.nickname === "string") &&
          ["completed", "failed", "interrupted"].includes(String(agent.outcome)),
      )
    );
  }
  return false;
}

function isTeamOrchestrationState(value: unknown): value is TeamOrchestrationState {
  if (!isRecord(value) || !isRecord(value.tasks)) return false;
  if (
    !Object.entries(value.tasks).every(
      ([taskId, task]) => isManagedTeamTaskState(task) && task.id === taskId,
    )
  ) {
    return false;
  }

  const tasks = value.tasks as Record<string, ManagedTeamTaskState>;
  for (const task of Object.values(tasks)) {
    const references = [
      ...(task.dependsOn ?? []),
      ...(task.predecessorTaskId ? [task.predecessorTaskId] : []),
    ];
    if (references.some((taskId) => taskId === task.id || tasks[taskId] === undefined))
      return false;
    if (task.predecessorTaskId && tasks[task.predecessorTaskId]!.createdAt > task.createdAt) {
      return false;
    }
  }
  return !hasManagedTaskReferenceCycle(tasks);
}

function isManagedTeamTaskState(value: unknown): value is ManagedTeamTaskState {
  if (
    !isRecord(value) ||
    (value.deliveryVersion !== undefined && value.deliveryVersion !== 1) ||
    typeof value.id !== "string" ||
    typeof value.childThreadId !== "string" ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.prompt !== "string" ||
    !value.prompt.trim() ||
    !["queued", "starting", "running", "completed", "failed", "interrupted"].includes(
      String(value.status),
    ) ||
    typeof value.createdAt !== "number" ||
    typeof value.lastActivityAt !== "number" ||
    (value.startedAt !== undefined && typeof value.startedAt !== "number") ||
    (value.expectedWakeAt !== undefined &&
      (typeof value.expectedWakeAt !== "number" || !Number.isFinite(value.expectedWakeAt))) ||
    (value.recoveryMisses !== undefined &&
      (typeof value.recoveryMisses !== "number" ||
        !Number.isInteger(value.recoveryMisses) ||
        value.recoveryMisses < 0)) ||
    (value.lastWatchdogAt !== undefined && typeof value.lastWatchdogAt !== "number") ||
    (value.watchdog !== undefined && !isManagedWatchdog(value.watchdog)) ||
    (value.childThreadSource !== undefined && typeof value.childThreadSource !== "string") ||
    (value.childTurnId !== undefined && typeof value.childTurnId !== "string") ||
    (value.startMessageId !== undefined && typeof value.startMessageId !== "string") ||
    (value.terminalTurnId !== undefined && typeof value.terminalTurnId !== "string") ||
    (value.dependsOn !== undefined && !isManagedTaskReferences(value.dependsOn)) ||
    (value.predecessorTaskId !== undefined && !isBoundedString(value.predecessorTaskId, 200)) ||
    (value.access !== undefined && !isManagedTaskAccess(value.access)) ||
    (value.resolvedModel !== undefined && !isBoundedString(value.resolvedModel, 200)) ||
    (value.resolvedReasoningEffort !== undefined &&
      value.resolvedReasoningEffort !== null &&
      !isBoundedString(value.resolvedReasoningEffort, 200)) ||
    (value.resolvedServiceTier !== undefined &&
      value.resolvedServiceTier !== null &&
      !isBoundedString(value.resolvedServiceTier, 200)) ||
    (value.timeoutMinutes !== undefined &&
      (typeof value.timeoutMinutes !== "number" ||
        !Number.isSafeInteger(value.timeoutMinutes) ||
        value.timeoutMinutes < 1 ||
        value.timeoutMinutes > 1_440)) ||
    (value.tokenBudget !== undefined &&
      (typeof value.tokenBudget !== "number" ||
        !Number.isSafeInteger(value.tokenBudget) ||
        value.tokenBudget < 1 ||
        value.tokenBudget > 10_000_000)) ||
    (value.tokensUsed !== undefined &&
      (typeof value.tokensUsed !== "number" ||
        !Number.isSafeInteger(value.tokensUsed) ||
        value.tokensUsed < 0)) ||
    (value.timeUsedSeconds !== undefined && !isNonNegativeFiniteNumber(value.timeUsedSeconds)) ||
    (value.failureReason !== undefined && !isBoundedString(value.failureReason, 2_000)) ||
    (value.budgetReason !== undefined &&
      !["timeout", "tokenBudget"].includes(String(value.budgetReason))) ||
    (value.workspace !== undefined && !isManagedTaskWorkspace(value.workspace)) ||
    (value.resultCandidate !== undefined && !isManagedResultCandidate(value.resultCandidate)) ||
    (value.result !== undefined && !isManagedResult(value.result))
  ) {
    return false;
  }
  return value.delivery === undefined || isManagedDelivery(value.delivery);
}

function isManagedDelivery(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.deliveryVersion === undefined || value.deliveryVersion === 1) &&
    ["claimed", "delivered"].includes(String(value.status)) &&
    typeof value.claimId === "string" &&
    (value.parentTurnId === undefined || typeof value.parentTurnId === "string") &&
    (value.markerId === undefined || typeof value.markerId === "string") &&
    (value.dispatchStartedAt === undefined || typeof value.dispatchStartedAt === "number") &&
    (value.contextHash === undefined ||
      (typeof value.contextHash === "string" && /^[a-f\d]{64}$/iu.test(value.contextHash)))
  );
}

function isManagedTaskReferences(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((taskId) => isBoundedString(taskId, 200)) &&
    new Set(value).size === value.length
  );
}

function hasManagedTaskReferenceCycle(tasks: Record<string, ManagedTeamTaskState>): boolean {
  const states = new Map<string, "visiting" | "visited">();
  for (const taskId of Object.keys(tasks)) {
    if (states.has(taskId)) continue;
    const stack: Array<{ taskId: string; references: string[]; index: number }> = [
      { taskId, references: managedTaskReferences(tasks[taskId]!), index: 0 },
    ];
    states.set(taskId, "visiting");
    while (stack.length) {
      const current = stack.at(-1)!;
      const reference = current.references[current.index++];
      if (reference === undefined) {
        states.set(current.taskId, "visited");
        stack.pop();
        continue;
      }
      if (states.get(reference) === "visiting") return true;
      if (states.get(reference) === "visited") continue;
      states.set(reference, "visiting");
      stack.push({
        taskId: reference,
        references: managedTaskReferences(tasks[reference]!),
        index: 0,
      });
    }
  }
  return false;
}

function managedTaskReferences(task: ManagedTeamTaskState): string[] {
  return [...(task.dependsOn ?? []), ...(task.predecessorTaskId ? [task.predecessorTaskId] : [])];
}

function isManagedTaskAccess(value: unknown): value is ManagedTeamTaskAccessState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["mode", "writePaths", "network"]) ||
    !["readOnly", "isolatedWrite", "sharedWrite"].includes(String(value.mode)) ||
    (value.network !== undefined && typeof value.network !== "boolean")
  ) {
    return false;
  }
  const writePaths = value.writePaths;
  if (
    writePaths !== undefined &&
    (!isSafeRelativePathList(writePaths, 100) || !writePaths.every(isSafeManagedWritePath))
  )
    return false;
  if (value.mode === "readOnly") return writePaths === undefined || writePaths.length === 0;
  return Array.isArray(writePaths) && writePaths.length > 0;
}

function isManagedTaskWorkspace(value: unknown): value is ManagedTeamTaskWorkspaceState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "lifecycle",
      "repositoryRoot",
      "gitCommonDir",
      "worktreePath",
      "head",
      "baseline",
      "createdAt",
      "updatedAt",
      "changedPaths",
      "conflictPaths",
      "error",
    ]) ||
    ![
      "creating",
      "ready",
      "integrating",
      "integrated",
      "discarding",
      "discarded",
      "conflicted",
      "recoveryRequired",
    ].includes(String(value.lifecycle)) ||
    !isSafeAbsolutePath(value.repositoryRoot) ||
    !isSafeAbsolutePath(value.gitCommonDir) ||
    !isSafeAbsolutePath(value.worktreePath) ||
    !isPathInside(value.gitCommonDir, value.worktreePath) ||
    typeof value.head !== "string" ||
    !/^[a-f\d]{40}(?:[a-f\d]{24})?$/iu.test(value.head) ||
    !isWorkspaceBaseline(value.baseline) ||
    !isNonNegativeFiniteNumber(value.createdAt) ||
    !isNonNegativeFiniteNumber(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    (value.changedPaths !== undefined && !isSafeRelativePathList(value.changedPaths, 10_000)) ||
    (value.conflictPaths !== undefined && !isSafeRelativePathList(value.conflictPaths, 10_000)) ||
    (value.error !== undefined && !isBoundedString(value.error, 4_000))
  ) {
    return false;
  }
  return true;
}

function isWorkspaceBaseline(
  value: unknown,
): value is Record<string, ManagedTeamTaskWorkspaceFileState> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 50_000 &&
    entries.reduce((length, [path]) => length + path.length, 0) <= 5_000_000 &&
    entries.every(([path, entry]) => isSafeRelativePath(path) && isWorkspaceFileState(entry))
  );
}

function isWorkspaceFileState(value: unknown): value is ManagedTeamTaskWorkspaceFileState {
  if (!isRecord(value)) return false;
  if (value.type === "file") {
    return (
      hasOnlyKeys(value, ["type", "mode", "digest"]) &&
      Number.isInteger(value.mode) &&
      Number(value.mode) >= 0 &&
      Number(value.mode) <= 0o777 &&
      typeof value.digest === "string" &&
      /^[a-f\d]{64}$/iu.test(value.digest)
    );
  }
  return (
    value.type === "symlink" &&
    hasOnlyKeys(value, ["type", "target"]) &&
    isBoundedString(value.target, 4_096) &&
    !value.target.includes("\0")
  );
}

function isSafeRelativePathList(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(isSafeRelativePath) &&
    new Set(value).size === value.length
  );
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4_096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

function isSafeManagedWritePath(value: string): boolean {
  return value.split("/").every((segment) => segment.toLowerCase() !== ".git");
}

function isSafeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    normalize(value) === value &&
    dirname(value) !== value
  );
}

function isPathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return isSafeRelativePath(child);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= maximum;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isTeamToolOperation(value: unknown): value is TeamToolOperationState {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.callId !== "string" ||
    ![
      "spawn_task",
      "followup_task",
      "steer_task",
      "cancel_task",
      "submit_result",
      "integrate_task",
      "discard_task_changes",
    ].includes(String(value.tool)) ||
    typeof value.argumentsHash !== "string" ||
    !/^[a-f\d]{64}$/iu.test(value.argumentsHash) ||
    !["prepared", "applied"].includes(String(value.status)) ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    (value.taskId !== undefined && typeof value.taskId !== "string") ||
    (value.childThreadSource !== undefined && typeof value.childThreadSource !== "string")
  ) {
    return false;
  }
  if (value.response === undefined) return value.status === "prepared";
  return (
    value.status === "applied" &&
    isRecord(value.response) &&
    typeof value.response.success === "boolean" &&
    Array.isArray(value.response.contentItems) &&
    value.response.contentItems.every(
      (item) =>
        isRecord(item) &&
        ((item.type === "inputText" && typeof item.text === "string") ||
          (item.type === "inputImage" && typeof item.imageUrl === "string") ||
          (item.type === "inputAudio" && typeof item.audioUrl === "string")),
    )
  );
}

function isLegacyTeamOrchestrationState(value: unknown): boolean {
  return isRecord(value) && isRecord(value.children) && value.tasks === undefined;
}

function isManagedParent(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.parentThreadId === "string" && typeof value.taskId === "string"
  );
}

function isManagedResultCandidate(value: unknown): value is ManagedTeamTaskResultCandidate {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    Boolean(value.summary.trim()) &&
    (value.details === undefined || typeof value.details === "string") &&
    typeof value.submittedAt === "number" &&
    typeof value.callId === "string" &&
    isManagedResultFields(value)
  );
}

function isManagedWatchdog(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.deliveryVersion === undefined || value.deliveryVersion === 1) &&
    ["pending", "claimed"].includes(String(value.status)) &&
    typeof value.triggeredAt === "number" &&
    (value.claimId === undefined || typeof value.claimId === "string") &&
    (value.status !== "claimed" || typeof value.claimId === "string") &&
    (value.markerId === undefined || typeof value.markerId === "string") &&
    (value.dispatchStartedAt === undefined || typeof value.dispatchStartedAt === "number") &&
    (value.contextHash === undefined ||
      (typeof value.contextHash === "string" && /^[a-f\d]{64}$/iu.test(value.contextHash)))
  );
}

function isManagedResult(value: unknown): value is ManagedTeamTaskResult {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    Boolean(value.summary.trim()) &&
    (value.details === undefined || typeof value.details === "string") &&
    ["submitted", "final_answer", "agent_message", "status"].includes(String(value.source)) &&
    isManagedResultFields(value)
  );
}

function isManagedResultFields(value: Record<string, unknown>): boolean {
  const outcome = value.outcome;
  if (
    outcome !== undefined &&
    !["success", "partial", "blocked", "failed"].includes(String(outcome))
  ) {
    return false;
  }
  if (
    value.checks !== undefined &&
    (!Array.isArray(value.checks) ||
      value.checks.length > 100 ||
      !value.checks.every(isManagedResultCheck))
  ) {
    return false;
  }
  if (
    value.risks !== undefined &&
    (!Array.isArray(value.risks) ||
      value.risks.length > 100 ||
      !value.risks.every((risk) => isBoundedString(risk, 4_000)))
  ) {
    return false;
  }
  if (
    value.artifacts !== undefined &&
    (!Array.isArray(value.artifacts) ||
      value.artifacts.length > 100 ||
      !value.artifacts.every(isManagedResultArtifact))
  ) {
    return false;
  }
  return (
    outcome !== undefined ||
    (value.checks === undefined && value.risks === undefined && value.artifacts === undefined)
  );
}

function isManagedResultCheck(value: unknown): value is ManagedTeamTaskResultCheck {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "outcome", "details"]) &&
    isBoundedString(value.name, 500) &&
    ["passed", "failed", "notRun"].includes(String(value.outcome)) &&
    (value.details === undefined ||
      (typeof value.details === "string" && value.details.length <= 10_000))
  );
}

function isManagedResultArtifact(value: unknown): value is ManagedTeamTaskResultArtifact {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["label", "path", "url"]) &&
    isBoundedString(value.label, 500) &&
    (value.path === undefined || isSafeRelativePath(value.path)) &&
    (value.url === undefined || isSafeArtifactUrl(value.url)) &&
    (value.path !== undefined || value.url !== undefined)
  );
}

function isSafeArtifactUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isQueuedMessage(value: unknown, threadId: string): value is QueuedMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.threadId === threadId &&
    typeof value.text === "string" &&
    validPastedText(value, value.text) &&
    (value.images === undefined ||
      (Array.isArray(value.images) && value.images.every(isInlineImage))) &&
    (value.files === undefined ||
      (Array.isArray(value.files) && value.files.every(isStoredFileAttachment))) &&
    (value.goal === undefined || typeof value.goal === "boolean") &&
    (value.planImplementationMode === undefined ||
      ["default", "goal", "team"].includes(String(value.planImplementationMode))) &&
    (value.dismissUserInput === undefined || isUserInputReference(value.dismissUserInput)) &&
    (value.deliveryVersion === undefined || value.deliveryVersion === 1) &&
    (value.replyToUserInput === undefined ||
      (isRecord(value.replyToUserInput) &&
        isBoundedString(value.replyToUserInput.turnId, 200) &&
        isBoundedString(value.replyToUserInput.itemId, 200) &&
        isRecord(value.replyToUserInput.answers) &&
        Object.values(value.replyToUserInput.answers).every(
          (answers) =>
            Array.isArray(answers) && answers.every((answer) => typeof answer === "string"),
        ))) &&
    (value.replyToAsyncQuestion === undefined ||
      (isRecord(value.replyToAsyncQuestion) &&
        isBoundedString(value.replyToAsyncQuestion.turnId, 200) &&
        isBoundedString(value.replyToAsyncQuestion.itemId, 500))) &&
    (Boolean(value.text.trim()) ||
      (Array.isArray(value.pasteBlocks) && value.pasteBlocks.length > 0) ||
      (Array.isArray(value.images) && value.images.length > 0) ||
      (Array.isArray(value.files) && value.files.length > 0)) &&
    typeof value.createdAt === "number" &&
    (value.deliveryError === undefined ||
      (isRecord(value.deliveryError) &&
        typeof value.deliveryError.message === "string" &&
        typeof value.deliveryError.retryable === "boolean")) &&
    ["queued", "dispatching"].includes(String(value.status))
  );
}

function isUserInputReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["turnId", "itemId"]) &&
    isBoundedString(value.turnId, 200) &&
    isBoundedString(value.itemId, 200)
  );
}

function isVoiceTranscription(value: unknown, key: string): value is VoiceTranscriptionState {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.threadId !== "string" ||
    (value.userInput === undefined
      ? value.threadId !== key
      : !isRecord(value.userInput) ||
        key !== `question:${value.id}` ||
        typeof value.userInput.draftKey !== "string" ||
        !/^[a-f\d]{64}$/iu.test(value.userInput.draftKey) ||
        typeof value.userInput.questionId !== "string" ||
        !value.userInput.questionId ||
        !Number.isSafeInteger(value.userInput.order) ||
        Number(value.userInput.order) < 1 ||
        value.mode !== "draft") ||
    !["draft", "send", "queue", "steer"].includes(String(value.mode)) ||
    (value.dismissUserInput !== undefined &&
      (value.mode === "draft" || !isUserInputReference(value.dismissUserInput))) ||
    !["queued", "transcribing", "applying", "failed", "completed"].includes(String(value.status)) ||
    (value.status === "completed" && (!value.userInput || typeof value.transcript !== "string")) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    (value.startedAt !== null &&
      (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt))) ||
    typeof value.audioDurationMs !== "number" ||
    !Number.isFinite(value.audioDurationMs) ||
    value.audioDurationMs <= 0 ||
    (value.estimatedTotalSeconds !== null &&
      (typeof value.estimatedTotalSeconds !== "number" ||
        !Number.isFinite(value.estimatedTotalSeconds) ||
        value.estimatedTotalSeconds <= 0)) ||
    (value.error !== null && typeof value.error !== "string") ||
    !["audio/webm", "audio/mp4"].includes(String(value.contentType)) ||
    typeof value.audioBytes !== "number" ||
    !Number.isSafeInteger(value.audioBytes) ||
    value.audioBytes < (value.status === "completed" ? 0 : 1) ||
    typeof value.selectionStart !== "number" ||
    !Number.isSafeInteger(value.selectionStart) ||
    value.selectionStart < 0 ||
    typeof value.selectionEnd !== "number" ||
    !Number.isSafeInteger(value.selectionEnd) ||
    value.selectionEnd < value.selectionStart ||
    (value.timingProfile !== undefined &&
      (typeof value.timingProfile !== "string" || !value.timingProfile.trim())) ||
    (value.transcript !== undefined &&
      (typeof value.transcript !== "string" || !value.transcript.trim())) ||
    (value.attempts !== undefined &&
      (typeof value.attempts !== "number" ||
        !Number.isSafeInteger(value.attempts) ||
        value.attempts < 0)) ||
    (value.nextAttemptAt !== undefined &&
      (typeof value.nextAttemptAt !== "number" || !Number.isFinite(value.nextAttemptAt)))
  ) {
    return false;
  }
  if (
    value.audioFile !== undefined &&
    (typeof value.audioFile !== "string" ||
      !/^[a-zA-Z0-9._-]+$/.test(value.audioFile) ||
      value.audioFile.includes(".."))
  ) {
    return false;
  }
  return value.status === "failed" || Boolean(value.audioFile) || Boolean(value.transcript);
}

function isTaskDefaults(value: unknown): value is TaskDefaults {
  if (!isRecord(value)) return false;
  return ["model", "titleModel", "serviceTier", "personality"].every(
    (key) => value[key] === undefined || (typeof value[key] === "string" && value[key].trim()),
  );
}

function isInlineImage(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function isThreadDraft(value: unknown): value is ThreadDraft {
  if (
    !isRecord(value) ||
    typeof value.input !== "string" ||
    !validPastedText(value, value.input) ||
    typeof value.goalMode !== "boolean" ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    !Array.isArray(value.images) ||
    (value.files !== undefined && !Array.isArray(value.files)) ||
    !Array.isArray(value.annotations)
  ) {
    return false;
  }
  return (
    value.images.every(
      (image) =>
        isRecord(image) &&
        typeof image.id === "string" &&
        Boolean(image.id) &&
        typeof image.name === "string" &&
        Boolean(image.name) &&
        isInlineImage(image.url),
    ) &&
    (value.files === undefined || value.files.every(isStoredFileAttachment)) &&
    value.annotations.every(isThreadDraftAnnotation)
  );
}

function isStoredFileAttachment(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Boolean(value.id) &&
    typeof value.name === "string" &&
    Boolean(value.name) &&
    typeof value.path === "string" &&
    isAbsolute(value.path) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.mediaType === "string" &&
    Boolean(value.mediaType)
  );
}

function isThreadDraftAnnotation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    Boolean(value.id) &&
    typeof value.messageId === "string" &&
    Boolean(value.messageId) &&
    ["agentMessage", "plan"].includes(String(value.source)) &&
    typeof value.quote === "string" &&
    Boolean(value.quote.trim()) &&
    typeof value.startOffset === "number" &&
    Number.isInteger(value.startOffset) &&
    value.startOffset >= 0 &&
    typeof value.endOffset === "number" &&
    Number.isInteger(value.endOffset) &&
    value.endOffset > value.startOffset &&
    typeof value.comment === "string" &&
    Boolean(value.comment.trim()) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt)
  );
}

function normalizeServiceTier(value: Record<string, unknown>): void {
  if (isFastServiceTier(value.serviceTier)) value.serviceTier = "fast";
  else delete value.serviceTier;
}

function isSessionSettings(value: unknown): value is SessionSettings {
  if (!isRecord(value) || !["default", "plan", "team"].includes(String(value.collaborationMode))) {
    return false;
  }
  for (const key of ["model", "reasoningEffort", "serviceTier", "personality"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (
    value.sandboxMode !== undefined &&
    !["read-only", "workspace-write", "danger-full-access"].includes(String(value.sandboxMode))
  ) {
    return false;
  }
  if (
    value.approvalsReviewer !== undefined &&
    !["user", "auto_review"].includes(String(value.approvalsReviewer))
  ) {
    return false;
  }
  return (
    value.approvalPolicy === undefined ||
    ["untrusted", "on-request", "granular", "never"].includes(String(value.approvalPolicy))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    typeof value.path === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}
