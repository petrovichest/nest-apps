import { join } from "node:path";
import type {
  ForkOperationSummary,
  Project,
  QueuedMessage,
  QueueMessageRequest,
  SessionArtifact,
  SessionSettings,
  TaskDefaults,
  ThreadDraft,
  ThreadFileAttachment,
  UiLanguage,
  UserInputDraft,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";
import { readJson, writeJsonAtomic } from "./io";
import { AppError, type ClaudePermissionMode, type ClaudeModel } from "./types";

export interface BrowserBindingState {
  bindingId: string;
  instanceId: string;
  attachedAt: number;
  detachedAt?: number;
}

export interface UiThread {
  id: string;
  cwd: string;
  projectId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  readAt: number;
  viewedAt: number;
  pinned: boolean;
  archived: boolean;
  settings: SessionSettings;
  draft: ThreadDraft | null;
  queue: QueuedMessage[];
  nativeHistory?: boolean;
  forkedFromId?: string;
  /** End of the native prefix inherited by a fork. Its usage was billed to the source. */
  inheritedThrough?: string;
  /** Confirmed owner loss or forced stop; native conversation files stay untouched. */
  interruptedTurns?: Record<string, number>;
  /** Browser tools are offered to the session; the extension binding is attached separately. */
  browserEnabled?: true;
  browserBinding?: BrowserBindingState;
  /** A plan from ExitPlanMode is shown to the user and awaits approval or revision. */
  awaitingPlanResponse?: boolean;
  dismissedPlanTurnId?: string;
  /** Native user UUIDs for internal continuation cues, hidden only in the UI. */
  quotaContinuationIds?: string[];
  quotaRecovery?: {
    reason?: "authentication";
    failedRunnerInstanceId: string;
    terminalSequence: number;
    failedAccountId?: string;
    model?: string;
    continuationId: string;
    confirmed: boolean;
    failedResetAt?: number;
    wasWaiting?: boolean;
    cancelledByUser?: boolean;
    state: "pending" | "waiting" | "resuming" | "continued" | "failed" | "cancelled";
    error?: string;
  };
  /** A read-only native subagent launched by a tool call of the parent session. */
  subagent?: {
    parentId: string;
    toolUseId: string;
    agentType: string | null;
    status: "running" | "completed" | "failed" | "interrupted";
  };
  /** ExitPlanMode plans by tool use ID; Claude's transcript does not include their text. */
  planTexts?: Record<string, string>;
  /** Only explicitly published files, recorded relative to the session directory. */
  sessionArtifacts?: Omit<SessionArtifact, "relativePath" | "fileName">[];
  deliveries: Record<
    string,
    {
      fingerprint: string;
      messageId: string;
      accepted: boolean;
      mode?: "steer";
      imageFiles?: ThreadFileAttachment[];
    }
  >;
}
export interface StoredVoice {
  job: VoiceTranscriptionJob;
  audioPath: string;
  contentType: string;
  selectionStart: number;
  selectionEnd: number;
  draftUpdatedAt: number | null;
  cancelled?: boolean;
  applied?: boolean;
  sendInput?: QueueMessageRequest;
}
export interface UiForkOperation {
  summary: ForkOperationSummary;
  targetId: string;
  /** A reserved child, published atomically with the draft and queue when ready. */
  pending?: UiThread;
  transcriptPath: string;
  prefixBytes: number;
  /** Keep the operation ID reserved after the client removes a failure. */
  removed?: true;
}

export interface UiData {
  version: 1;
  projects: Project[];
  threads: Record<string, UiThread>;
  forkOperations?: Record<string, UiForkOperation>;
  creations: Record<string, { projectId: string; threadId: string; fingerprint?: string }>;
  projectDrafts: Record<string, ThreadDraft>;
  questionDrafts: Record<string, UserInputDraft>;
  voice: Record<string, StoredVoice>;
  voiceUploads: Record<string, string>;
  models: ClaudeModel[];
  taskDefaults: TaskDefaults;
  uiLanguage: UiLanguage;
  permissionMode: ClaudePermissionMode;
  permissionVersion: number;
  voiceSettings?: Record<string, unknown>;
  voiceTimings?: Record<string, { audioDurationMs: number; processingMs: number }[]>;
}
export function findForkOperation(data: UiData, id: string): UiForkOperation | undefined {
  return Object.hasOwn(data.forkOperations ?? {}, id) ? data.forkOperations![id] : undefined;
}

export function forkOperation(data: UiData, id: string): UiForkOperation {
  const stored = findForkOperation(data, id);
  if (!stored || stored.removed) throw new AppError("not_found", "Fork operation not found", 404);
  return stored;
}

export function touchFork(operation: UiForkOperation): void {
  operation.summary.updatedAt = Math.max(Date.now(), operation.summary.updatedAt + 1);
  operation.summary.queuedMessageCount = operation.pending?.queue.length ?? 0;
}

export function forkTarget(data: UiData, id: string): UiThread {
  const operation = forkOperation(data, id);
  return operation.pending ?? data.threads[operation.summary.targetThreadId!]!;
}

const initial = (): UiData => ({
  version: 1,
  projects: [],
  threads: {},
  creations: {},
  projectDrafts: {},
  questionDrafts: {},
  voice: {},
  voiceUploads: {},
  models: [],
  taskDefaults: {},
  uiLanguage: "ru",
  permissionMode: "bypassPermissions",
  permissionVersion: 1,
});

/** Only Nest metadata is stored here. Conversation content remains in native Claude JSONL. */
export class UiStore {
  private current = initial();
  private writing: Promise<unknown> = Promise.resolve();
  readonly path: string;
  constructor(stateDir: string, permissionMode?: ClaudePermissionMode) {
    if (permissionMode) this.current.permissionMode = permissionMode;
    this.path = join(stateDir, "ui.json");
  }
  get data(): UiData {
    return this.current;
  }
  async initialize(seed?: () => Promise<Pick<UiData, "projects" | "uiLanguage">>): Promise<void> {
    const saved = await readJson<UiData>(this.path);
    if (saved && saved.version !== 1)
      throw new AppError("conflict", "Unsupported ClaudeNest metadata version", 409);
    if (saved) this.current = { ...initial(), ...saved };
    else if (seed) this.current = { ...this.current, ...(await seed()) };
  }
  update<T>(operation: (data: UiData) => T | Promise<T>): Promise<T> {
    const task = this.writing
      .catch(() => undefined)
      .then(async () => {
        const next = structuredClone(this.current);
        const result = await operation(next);
        await writeJsonAtomic(this.path, next);
        this.current = next;
        return result;
      });
    this.writing = task;
    return task;
  }
  async flush(): Promise<void> {
    await this.writing.catch(() => undefined);
  }
}
