import { pastedText, type PastedText } from "./pasted-text.js";
import type { ClaudeAccountsStatus } from "./claude-accounts.js";
export * from "./pasted-text.js";

export type AppProvider = "codex" | "claude";

/** Optional provider capabilities; existing Codex clients retain their defaults. */
export type AppCapabilities = {
  codexManagement: boolean;
  rateLimits: boolean;
  plan: boolean;
  team: boolean;
  goal: boolean;
  forks: boolean;
  browserIntegration: boolean;
  fullTextSearch: boolean;
  sessionApprovalGrants: boolean;
  skills: boolean;
  gitChanges: boolean;
  artifacts: boolean;
  appUpdates: boolean;
  reasoningEffort: boolean;
};

export type AppServerState = "starting" | "ready" | "unavailable" | "stopped";
export type RecoveryState =
  "starting" | "syncing" | "recovering" | "ready" | "draining" | "unavailable" | "failed";

export type HealthResponse = {
  provider?: AppProvider;
  app?: "codexnest" | "claudenest";
  status: "ok" | "degraded";
  serverVersion: string;
  recoveryState: RecoveryState;
  restartProtocolVersion: number;
  transport: "stdio" | "daemon";
  appServer: {
    state: AppServerState;
    installedVersion: string | null;
    message: string | null;
  };
};

export type SummaryResponse = {
  threadCount: number;
  projectCount: number;
  pendingAttentionCount: number;
  syncedAt: string | null;
};

export type TranscriptionProvider = "local" | "openai";

export type UiLanguage = "en" | "ru";

export type TranscriptionTimingEstimate = {
  sampleCount: number;
  estimatedFixedProcessingMs: number | null;
  estimatedProcessingMsPerAudioSecond: number | null;
};

export type UiLanguageSettings = {
  language: UiLanguage;
};

export type UpdateUiLanguageRequest = UiLanguageSettings;

export type TranscriptionConfigResponse = {
  providers: TranscriptionProvider[];
  provider: TranscriptionProvider | null;
  localUrl: string | null;
  openAiApiKeyConfigured: boolean;
  openAiModel: string;
  language: string | null;
  refineLocal: boolean;
  refinementModel: string;
  maxRecordingSeconds: number;
  maxUploadBytes: number;
  timingEstimate: TranscriptionTimingEstimate;
};

export type UpdateTranscriptionSettingsRequest = {
  provider: TranscriptionProvider | null;
  localUrl: string | null;
  openAiApiKey?: string | null;
  openAiModel: string;
  language: string | null;
  refineLocal: boolean;
  refinementModel: string;
};

export type TranscriptionResponse = {
  text: string;
  timingEstimate: TranscriptionTimingEstimate;
};

export type VoiceInputMode = "draft" | "send";

export type VoiceTranscriptionMode = VoiceInputMode | "queue" | "steer";

export type VoiceTranscriptionStatus =
  "queued" | "transcribing" | "applying" | "failed" | "completed";

export type UserInputVoiceTarget = {
  draftKey: string;
  questionId: string;
  order: number;
};

export type VoiceTranscriptionJob = {
  id: string;
  threadId: string;
  mode: VoiceTranscriptionMode;
  status: VoiceTranscriptionStatus;
  createdAt: number;
  startedAt: number | null;
  audioDurationMs: number;
  estimatedTotalSeconds: number | null;
  error: string | null;
  dismissUserInput?: AsyncQuestionReference;
  userInput?: UserInputVoiceTarget;
  transcript?: string;
};

export type GitChangesSummary = {
  state: "clean" | "dirty" | "notRepository";
  filesChanged: number;
  additions: number;
  deletions: number;
};

export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CodexRateLimitsResponse = {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  ordinaryUsageAllowed?: boolean | null;
  spendControlReached?: boolean | null;
  rateLimitReachedType?: string | null;
};

export type CodexRateLimitsState = {
  limits: CodexRateLimitsResponse | null;
  updatedAt: number | null;
  refreshing: boolean;
  refreshError: boolean;
};

export type SkillScope = "user" | "repo" | "system" | "admin";

export type SkillCatalogItem = {
  name: string;
  displayName: string;
  description: string;
  shortDescription: string | null;
  path: string;
  scope: SkillScope;
  enabled: boolean;
};

export type SkillCatalogError = {
  path: string;
  message: string;
};

export type SkillsCatalogResponse = {
  cwd: string;
  skills: SkillCatalogItem[];
  errors: SkillCatalogError[];
};

export type UpdateSkillConfigRequest = {
  cwd: string;
  path: string;
  enabled: boolean;
};

export type UpdateSkillConfigResponse = {
  path: string;
  enabled: boolean;
};

export type CodexManagementOperation =
  "idle" | "checking" | "applying_proxy" | "updating" | "restarting";

export type CodexProxyStatus = {
  configured: boolean;
  protocol: "http" | "https" | null;
  host: string | null;
  port: number | null;
  username: string | null;
  hasPassword: boolean;
  error: string | null;
};

export type CodexManagementStatus = {
  supported: boolean;
  unavailableReason: string | null;
  operation: CodexManagementOperation;
  activeTurnCount: number;
  daemonStatus: string;
  cliVersion: string | null;
  appServerVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  networkStatus: "unknown" | "ok" | "error";
  networkMessage: string | null;
  proxy: CodexProxyStatus;
};

export type AppUpdateOperation =
  "idle" | "checking" | "preparing" | "building" | "switching" | "restarting";

export type AppUpdateResult = "none" | "updated" | "rolled_back" | "failed";

export type AppUpdateStatus = {
  supported: boolean;
  canUpdateWithActiveTurns: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  operation: AppUpdateOperation;
  result: AppUpdateResult;
  message: string | null;
  checkedAt: string | null;
  updatedAt: string | null;
};

export type ForceRestartAccepted = {
  accepted: true;
};

export type UpdateCodexProxyRequest = {
  proxy: string;
};

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "validation_failed"
  | "payload_too_large"
  | "transcription_unavailable"
  | "transcription_failed"
  | "not_found"
  | "draft_conflict"
  | "conflict"
  | "history_changed"
  | "app_server_unavailable"
  | "internal_error";

export type ApiError = {
  error: {
    code: ApiErrorCode;
    message: string;
  };
};

export type Project = {
  id: string;
  displayName: string;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type DirectoryEntry = {
  name: string;
  path: string;
};

export type DirectoryListing = {
  rootPath: string;
  path: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
};

export type ThreadOutcome = "completed" | "failed" | "interrupted";

export type ThreadState =
  "needsAttention" | "queued" | "running" | ThreadOutcome | "idle" | "unavailable";

export type BrowserThreadStatus = "disabled" | "disconnected" | "connected";

export type ThreadRelation =
  | {
      kind: "session";
      sessionId: string;
      forkedFromId?: string;
    }
  | {
      kind: "subagent";
      sessionId: string;
      parentThreadId: string;
      nickname: string | null;
      role: string | null;
    };

export type ThreadSummary = {
  /** Effective permissions reported by a Claude session owner. */
  permissionPreset?: PermissionPreset;
  id: string;
  projectId: string | null;
  title: string;
  preview: string;
  cwd: string;
  state: ThreadState;
  unread: boolean;
  unseen: boolean;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  currentTurnId: string | null;
  /** The server will continue this thread after temporary model overload. */
  capacityRetry?: { failedTurnId: string; nextAttemptAt: number };
  /** Claude account recovery after an exhausted subscription quota. */
  quotaRecovery?: { state: "waiting" | "resuming" | "failed"; message: string };
  /** A completed plan still needs a user response, even if its mode was changed. */
  awaitingPlanResponse?: boolean;
  /** The completed plan whose response requirement the user dismissed. */
  dismissedPlanTurnId?: string;
  queuedMessageCount: number;
  browserStatus: BrowserThreadStatus;
  settings: SessionSettings;
  relation: ThreadRelation;
  canAcceptDirectInput?: boolean | null;
  /** Current configured settings reported by Codex, not per-turn execution telemetry. */
  codexSettings?: { model: string | null; reasoningEffort: string | null };
};

export type ThreadSearchScope = "titles" | "messages";

export type ThreadSearchPage = {
  data: Array<{ thread: ThreadSummary; snippet: string }>;
  nextCursor: string | null;
};

export type ThreadSearchOccurrence = {
  turnId: string;
  itemId: string;
  snippet: string;
  snippetMatchRange: { start: number; end: number };
  turnCursor: string;
};

export type ThreadOccurrencesPage = {
  data: ThreadSearchOccurrence[];
  nextCursor: string | null;
};

export type ThreadSearchTurn = { instanceId: string; turn: TurnView };

export function isActiveFeedEligible(thread: ThreadSummary): boolean {
  return (
    !thread.archived &&
    (thread.queuedMessageCount > 0 ||
      thread.state === "running" ||
      thread.state === "queued" ||
      thread.state === "needsAttention" ||
      ((thread.state === "completed" ||
        thread.state === "failed" ||
        thread.state === "interrupted") &&
        thread.unread))
  );
}

export type AsyncQuestionReference = { turnId: string; itemId: string };

export type AsyncUserInputQuestion = { title: string; options: string[] | null };

/** Independent of Codex's live/history item ID aliases. */
export function asyncQuestionReplyMessageId(
  threadId: string,
  turnId: string,
  questionKey: string,
): string {
  return `async-answer:${threadId}:${turnId}:${questionKey}`;
}

export type UserInputReply = {
  turnId: string;
  itemId: string;
  answers: Record<string, string[]>;
};

export type PlanImplementationMode = "default" | "goal" | "team";

export type QueuedMessage = PastedText & {
  /** A durable Claude steer admission belongs to the current turn, outside the FIFO. */
  deliveryMode?: "steer" | "queue";
  id: string;
  threadId: string;
  text: string;
  images?: string[];
  files?: ThreadFileAttachment[];
  goal?: boolean;
  planImplementationMode?: PlanImplementationMode;
  createdAt: number;
  status: "queued" | "dispatching";
  deliveryVersion?: 1;
  deliveryError?: { message: string; retryable: boolean };
  replyToAsyncQuestion?: AsyncQuestionReference;
  replyToUserInput?: UserInputReply;
  dismissUserInput?: AsyncQuestionReference;
};

export type TurnPlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export type TurnProgress = {
  startedAt: number | null;
  explanation: string | null;
  steps: TurnPlanStep[];
  filesChanged: number;
  additions: number;
  deletions: number;
};

export type OrchestrationResultCheck = {
  name: string;
  outcome: "passed" | "failed" | "notRun";
  details?: string;
};

export type OrchestrationResult = {
  outcome: "success" | "partial" | "blocked" | "failed";
  summary: string;
  checks?: OrchestrationResultCheck[];
};

export type OrchestrationWorkspaceIntegrationStatus =
  | "creating"
  | "ready"
  | "integrating"
  | "integrated"
  | "discarding"
  | "discarded"
  | "conflicted"
  | "recoveryRequired";

export type OrchestrationNoticeAgent = {
  threadId: string;
  title: string;
  nickname: string | null;
  outcome: ThreadOutcome;
  taskId?: string;
  result?: OrchestrationResult;
  budgetReason?: "timeout" | "tokenBudget";
  failureReason?: string;
  changedPaths?: string[];
  changedPathCount?: number;
  workspaceIntegrationStatus?: OrchestrationWorkspaceIntegrationStatus;
};

export interface DeliveryReceipt {
  /** 0: Nest persisted a standard RPC acknowledgement; 1: native durable acceptance. */
  version: 0 | 1;
  clientId: string;
  threadId: string;
  turnId: string | null;
}

export type ActivityItem =
  | (PastedText & {
      type: "userMessage" | "agentMessage" | "reasoning" | "plan";
      id: string;
      status: "inProgress" | "completed" | "failed";
      text: string;
      images: string[];
      files?: ActivityFileAttachment[];
      timestamp: number | null;
      phase: "commentary" | "final_answer" | null;
      delivery?: "async" | null;
      deliveryReceipt?: DeliveryReceipt;
      questions?: AsyncUserInputQuestion[] | null;
      /** Stable across live/history item renumbering, scoped to the source turn. */
      questionKey?: string;
    })
  | {
      type: "command";
      id: string;
      status: "inProgress" | "completed" | "failed";
      kind: "read" | "search" | "command";
      command: string;
      cwd: string | null;
      output: string;
      exitCode: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      status: "inProgress" | "completed" | "failed";
      path: string | null;
      patch: string;
    }
  | {
      type: "tool";
      id: string;
      status: "inProgress" | "completed" | "failed";
      title: string;
      detail: string;
      images?: string[];
    }
  | {
      type: "userInputResponse";
      id: string;
      status: "completed";
      entries: Array<{
        header: string;
        question: string;
        answers: string[];
      }>;
      timestamp: number;
      afterItemId: string | null;
    }
  | {
      type: "planChecklist";
      id: string;
      status: "inProgress" | "completed" | "failed";
      explanation: string | null;
      steps: TurnPlanStep[];
      timestamp: number;
      afterItemId: string | null;
    }
  | {
      type: "orchestrationNotice";
      id: string;
      status: "completed";
      agents: OrchestrationNoticeAgent[];
      timestamp: number;
      afterItemId: string | null;
    }
  | {
      type: "subagentLaunch";
      id: string;
      status: "inProgress" | "completed" | "failed";
      title: string;
      threadId: string | null;
      /** Native agent launches are distinct from managed Team tasks. */
      source?: "codex" | "claude";
      agentPath?: string;
      timestamp?: number | null;
    }
  | {
      type: "error" | "unsupported";
      id: string;
      status: "failed";
      message: string;
      failureKind?: "modelCapacity";
    };

export type TurnView = {
  id: string;
  status: "inProgress" | ThreadOutcome;
  failureKind?: "modelCapacity";
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  progress: TurnProgress;
  items: ActivityItem[];
  /** False when only summary and live items are present. Missing means legacy full data. */
  itemsLoaded?: boolean;
};

export type TurnItemsResponse = {
  threadId: string;
  turnId: string;
  items: ActivityItem[];
};

export type ThreadDraftImage = {
  id: string;
  name: string;
  url: string;
};

export type ThreadFileAttachment = {
  id: string;
  name: string;
  path: string;
  size: number;
  mediaType: string;
};

export type ActivityFileAttachment = {
  name: string;
  path: string;
};

export type ThreadDraftAnnotation = {
  id: string;
  messageId: string;
  source: "agentMessage" | "plan";
  quote: string;
  startOffset: number;
  endOffset: number;
  comment: string;
  createdAt: number;
};

export type UpdateThreadDraftRequest = PastedText & {
  input: string;
  images: ThreadDraftImage[];
  files?: ThreadFileAttachment[];
  goalMode: boolean;
  annotations: ThreadDraftAnnotation[];
};

export type ThreadDraft = UpdateThreadDraftRequest & {
  updatedAt: number;
};

export type ForkMode = "compressed" | "exact";

export type ForkTimeEstimate = { minSeconds: number; maxSeconds: number };

export type ForkModeEstimate = {
  available: boolean;
  estimatedBytes: number | null;
  estimatedSeconds: ForkTimeEstimate | null;
  unavailableReason: string | null;
};

export type ForkEstimateResponse = {
  sourceBytes: number | null;
  compressed: ForkModeEstimate;
  exact: ForkModeEstimate;
};

export type ForkOperationStatus = "preparing" | "reconciling" | "ready" | "failed";

export type ForkOperationStage = "preparing" | "copying" | "compacting" | "materializing";

export type ForkOperationSummary = {
  id: string;
  sourceThreadId: string;
  lastTurnId: string;
  agentMessageId: string;
  mode: ForkMode;
  status: ForkOperationStatus;
  stage?: ForkOperationStage | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  targetThreadId: string | null;
  queuedMessageCount: number;
  estimate: ForkModeEstimate | null;
  error: string | null;
};

export type ProjectionVersion = {
  instanceId: string;
  sequence: number;
};

/** @deprecated Transitional cursor contract for clients from the previous release. */
export type ThreadSyncPoint = {
  cursor: string;
  anchorTurnId: string;
  anchorRevision: string;
};

export type ThreadDetail = {
  version?: ProjectionVersion;
  summary: ThreadSummary;
  turns: TurnView[];
  queuedMessages: QueuedMessage[];
  olderTurnsCursor: string | null;
  draft?: ThreadDraft | null;
  historyError?: { message: string; retryable: boolean };
  /** @deprecated Present only when serving the previous release's incremental client. */
  syncPoint?: ThreadSyncPoint | null;
};

export type ThreadHistoryPage = {
  instanceId: string;
  anchorTurnId: string;
  turns: TurnView[];
  olderTurnsCursor: string | null;
};

/** @deprecated Transitional response for clients from the previous release. */
export type ThreadChanges = {
  summary: ThreadSummary;
  turns: TurnView[];
  queuedMessages: QueuedMessage[];
  draft?: ThreadDraft | null;
  continuationCursor: string | null;
  syncPoint: ThreadSyncPoint | null;
  resetLatest: boolean;
  olderTurnsCursor: string | null;
};

export type SessionArtifact = {
  id: string;
  label: string;
  path: string;
  relativePath: string;
  fileName: string;
  turnId: string;
  createdAt: number;
};

export type ThreadArtifactsResponse = {
  capability: "explicit" | "unavailable";
  artifacts: SessionArtifact[];
};

export type ModelOption = {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  reasoningEfforts: Array<{
    value: string;
    description: string | null;
    isDefault: boolean;
  }>;
  serviceTiers: Array<{
    id: string;
    displayName: string;
  }>;
  supportsPersonality: boolean;
};

export function isFastServiceTier(value: unknown): boolean {
  return value === "fast" || value === "priority";
}

export function fastServiceTier(
  model: Pick<ModelOption, "serviceTiers"> | undefined,
): "priority" | "fast" | null {
  if (model?.serviceTiers.some((tier) => tier.id === "priority")) return "priority";
  if (model?.serviceTiers.some((tier) => tier.id === "fast")) return "fast";
  return null;
}

export type CollaborationMode = "default" | "plan" | "team";

export type PermissionPreset = "ask" | "auto" | "full-access";

export type GlobalPermissionSettings = {
  preset: PermissionPreset | null;
  version: string | null;
  overridden: boolean;
  message: string | null;
};

export type UpdateGlobalPermissionSettingsRequest = {
  preset: PermissionPreset;
  expectedVersion?: string | null;
};

export type SessionSettings = {
  collaborationMode: CollaborationMode;
  model?: string;
  reasoningEffort?: string;
  /** Fast mode is stored as "fast"; an absent value uses the standard service tier. */
  serviceTier?: string;
  personality?: string;
};

export type TaskDefaults = {
  model?: string;
  titleModel?: string;
  /** Fast mode default for new sessions, stored as "fast" when enabled. */
  serviceTier?: string;
  personality?: string;
};

export type UpdateTaskDefaultsRequest = {
  model?: string | null;
  titleModel?: string | null;
  /** "fast" enables Fast mode; null clears the saved default. */
  serviceTier?: string | null;
  personality?: string | null;
};

export type ThreadGoalStatus =
  "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export type ThreadGoal = {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type UpdateThreadGoalRequest = {
  objective?: string;
  status?: ThreadGoalStatus;
};

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  collaborationMode: "plan",
};

export type AttentionBase = {
  id: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  createdAt: number;
};

export type AttentionRequest =
  | (AttentionBase & {
      kind: "commandApproval";
      command: string | null;
      cwd: string | null;
      reason: string | null;
      networkHost: string | null;
      canAcceptForSession: boolean;
      proposedPolicyChanges: Array<{
        id: string;
        type: "exec" | "network";
        label: string;
      }>;
    })
  | (AttentionBase & {
      kind: "fileChangeApproval";
      reason: string | null;
      grantRoot: string | null;
      canAcceptForSession: boolean;
    })
  | (AttentionBase & {
      kind: "permissionApproval";
      cwd: string;
      reason: string | null;
      permissions: PermissionGrant;
    })
  | (AttentionBase & {
      kind: "userInput";
      questions: UserInputQuestion[];
      isBlocking?: boolean;
      autoResolutionMs: number | null;
      /** Present on server snapshots/events; optional for backward-compatible fixtures/clients. */
      draft?: UserInputDraft | null;
      draftKey?: string;
      /** Stable reply identity supplied by the server, including on HTTP clients. */
      clientMessageId?: string;
    })
  | (AttentionBase & {
      kind: "elicitation";
      mode: "form" | "url";
      message: string;
      url: string | null;
      schema: ElicitationSchema | null;
    })
  | (AttentionBase & {
      kind: "unsupported";
      method: string;
      message: string;
    });

export type PermissionGrant = {
  network?: {
    enabled?: boolean;
    domains?: string[];
  };
  fileSystem?: {
    read?: string[];
    write?: string[];
  };
};

export type UserInputQuestion = {
  /** Absent preserves the existing single-choice behavior. */
  multiSelect?: boolean;
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

export type UserInputDraft = {
  answers: Record<string, string[]>;
  currentQuestionId: string | null;
  revision: number;
  updatedAt: number;
  appliedRecordingIds?: string[];
  recordings?: VoiceTranscriptionJob[];
  submission?: UserInputSubmission | null;
};

export type UserInputSubmission = {
  recordingIds: string[];
  clientMessageId: string;
  status: "waiting" | "sending" | "failed";
  error?: string;
};

export type UpdateUserInputDraftRequest = Pick<
  UserInputDraft,
  "answers" | "currentQuestionId" | "appliedRecordingIds"
>;

/** Merge server-completed recordings into an editable draft without replaying text. */
export function appendUserInputRecordings(
  draft: UpdateUserInputDraftRequest,
  recordings: readonly VoiceTranscriptionJob[],
): UpdateUserInputDraftRequest {
  const applied = new Set(draft.appliedRecordingIds ?? []);
  const answers = { ...draft.answers };
  for (const recording of [...recordings].sort(
    (a, b) => (a.userInput?.order ?? 0) - (b.userInput?.order ?? 0),
  )) {
    if (
      !recording.userInput ||
      recording.status !== "completed" ||
      !recording.transcript ||
      applied.has(recording.id)
    )
      continue;
    const id = recording.userInput.questionId;
    const previous = answers[id]?.[0] ?? "";
    answers[id] = [
      previous + (previous && !/\s$/.test(previous) ? " " : "") + recording.transcript,
    ];
    applied.add(recording.id);
  }
  return {
    ...draft,
    answers,
    ...(applied.size || draft.appliedRecordingIds ? { appliedRecordingIds: [...applied] } : {}),
  };
}

export type ElicitationPrimitive =
  | {
      type: "string";
      title?: string;
      description?: string;
      minLength?: number;
      maxLength?: number;
      format?: string;
      default?: string;
      enum?: string[];
    }
  | {
      type: "number" | "integer";
      title?: string;
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | {
      type: "boolean";
      title?: string;
      description?: string;
      default?: boolean;
    }
  | {
      type: "array";
      title?: string;
      description?: string;
      items: { type: "string"; enum?: string[] };
      minItems?: number;
      maxItems?: number;
    };

export type ElicitationSchema = {
  properties: Record<string, ElicitationPrimitive>;
  required: string[];
};

export type AttentionResponse =
  | {
      kind: "approval";
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      kind: "approvalAmendment";
      amendmentId: string;
    }
  | {
      kind: "permission";
      permissions: PermissionGrant;
      scope: "turn" | "session";
    }
  | {
      kind: "userInput";
      answers: Record<string, string[]>;
    }
  | {
      kind: "elicitation";
      action: "accept" | "decline" | "cancel";
      content: Record<string, unknown> | null;
    };

export type ConnectionView = {
  state: AppServerState;
  message: string | null;
  syncedAt: string | null;
};

export type AppSnapshot = {
  provider?: AppProvider;
  capabilities?: AppCapabilities;
  permissionSettings?: GlobalPermissionSettings;
  instanceId?: string;
  sequence: number;
  uiLanguage: UiLanguage;
  connection: ConnectionView;
  codexRateLimits?: CodexRateLimitsState;
  claudeAccounts?: ClaudeAccountsStatus;
  projects: Project[];
  threads: ThreadSummary[];
  attention: AttentionRequest[];
  models: ModelOption[];
  defaultReasoningEffort?: string;
  taskDefaults?: TaskDefaults;
  voiceTranscriptions?: VoiceTranscriptionJob[];
  forkOperations: ForkOperationSummary[];
};

export type ServerEvent =
  | { type: "connection.changed"; connection: ConnectionView }
  | { type: "codexRateLimits.changed"; codexRateLimits: CodexRateLimitsState }
  | { type: "claudeAccounts.changed"; claudeAccounts: ClaudeAccountsStatus }
  | { type: "project.upserted"; project: Project }
  | { type: "projects.reordered"; projects: Project[] }
  | { type: "project.removed"; projectId: string }
  | { type: "projectDraft.changed"; projectId: string; draft: ThreadDraft }
  | { type: "thread.upserted"; thread: ThreadSummary }
  | { type: "thread.removed"; threadId: string }
  | { type: "forkOperation.upserted"; operation: ForkOperationSummary }
  | { type: "forkOperation.removed"; operationId: string }
  | { type: "activity.upserted"; threadId: string; turnId: string; item: ActivityItem }
  | {
      type: "activity.delta";
      threadId: string;
      turnId: string;
      itemId: string;
      activityType: "agentMessage" | "plan" | "reasoning" | "command";
      delta: string;
    }
  | { type: "turn.progressed"; threadId: string; turnId: string; progress: TurnProgress }
  | { type: "turn.replaced"; threadId: string; turn: TurnView }
  | { type: "queue.changed"; threadId: string; messages: QueuedMessage[] }
  | { type: "attention.upserted"; attention: AttentionRequest }
  | { type: "attention.removed"; attentionId: string }
  | { type: "models.changed"; models: ModelOption[] }
  | { type: "skills.changed" }
  | { type: "defaultReasoningEffort.changed"; reasoningEffort: string | null }
  | { type: "taskDefaults.changed"; taskDefaults: TaskDefaults }
  | { type: "permissions.changed"; permissionSettings: GlobalPermissionSettings }
  | { type: "uiLanguage.changed"; language: UiLanguage }
  | { type: "goal.changed"; threadId: string; goal: ThreadGoal | null }
  | { type: "voiceTranscription.upserted"; job: VoiceTranscriptionJob }
  | {
      type: "voiceTranscription.removed";
      threadId: string;
      jobId: string;
      outcome: "draft" | "send" | "cancelled";
    }
  | { type: "resync.required" };

export type ClientFrame = { type: "authenticate"; token: string } | { type: "ping" };

export type ServerFrame =
  | { type: "snapshot"; snapshot: AppSnapshot }
  | {
      type: "event";
      sequence: number;
      version?: ProjectionVersion;
      event: ServerEvent;
    }
  | { type: "pong" }
  | { type: "error"; error: ApiError["error"] };

export const BROWSER_EXTENSION_PROTOCOL = "codexnest.browser" as const;
export const BROWSER_EXTENSION_PROTOCOL_VERSION_V1 = 1 as const;
export const BROWSER_EXTENSION_PROTOCOL_VERSION_V2 = 2 as const;
export const BROWSER_EXTENSION_PROTOCOL_VERSION = BROWSER_EXTENSION_PROTOCOL_VERSION_V2;
export const BROWSER_EXTENSION_PROTOCOL_VERSIONS = [
  BROWSER_EXTENSION_PROTOCOL_VERSION_V1,
  BROWSER_EXTENSION_PROTOCOL_VERSION_V2,
] as const;
export const BROWSER_EXTENSION_WEBSOCKET_PATH = "/api/v1/browser-extension/events" as const;
export const BROWSER_EXTENSION_ID = "icdkmpldakkmodggmjaohfiflnakmpoj" as const;
export const BROWSER_EXTENSION_ORIGIN = `chrome-extension://${BROWSER_EXTENSION_ID}` as const;
/** The separately packaged ClaudeNest extension speaks the same protocol under its own ID. */
export const CLAUDE_BROWSER_EXTENSION_ID = "chncmaejombdlkgeleeenghomodjfnfj" as const;
export const CLAUDE_BROWSER_EXTENSION_ORIGIN =
  `chrome-extension://${CLAUDE_BROWSER_EXTENSION_ID}` as const;
export const BROWSER_MAX_PROJECT_FILE_BYTES = 100 * 1024 * 1024;
export const BROWSER_MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024;
export const BROWSER_TOOL_RESULT_CHUNK_BYTES = 48 * 1024;
export const BROWSER_MAX_TOOL_RESULT_BYTES = 8 * 1024 * 1024;
export const BROWSER_MAX_TOOL_RESULT_CHUNKS = 512;
export const BROWSER_MAX_NETWORK_BODY_BYTES = 100 * 1024 * 1024;
export const BROWSER_MAX_NETWORK_BODY_READ_BYTES = 512 * 1024;
/** Base64 characters, leaving room for the JSON envelope under the 64 KiB socket limit. */
export const BROWSER_NETWORK_CAPTURE_CHUNK_BYTES = 48 * 1024;

export type BrowserExtensionProtocolVersion = (typeof BROWSER_EXTENSION_PROTOCOL_VERSIONS)[number];

export type BrowserName = "chrome";

export const BROWSER_TOOL_NAMES = [
  "tabs_context",
  "tabs_create",
  "tabs_close",
  "navigate",
  "computer",
  "read_page",
  "get_page_text",
  "find",
  "form_input",
  "javascript_tool",
  "read_console_messages",
  "read_network_requests",
  "read_network_request",
  "read_network_body",
  "resize_window",
  "upload_file",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export type BrowserExtensionProjectSummary = {
  id: string;
  displayName: string;
  path: string;
};

export type BrowserExtensionThreadSummary = {
  id: string;
  projectId: string;
  title: string;
  state: ThreadState;
};

export type BrowserTabSummary = {
  id: number;
  windowId: number;
  groupId: number;
  active: boolean;
  title: string;
  url: string;
};

export type BrowserExtensionBindingSummary = {
  threadId: string;
  projectId: string;
  title: string;
  groupId: number;
  tabIds: number[];
  createdAt: number;
  updatedAt: number;
};

export type BrowserSessionTarget =
  { kind: "new"; projectId: string } | { kind: "existing"; threadId: string };

export type BrowserProjectFileTransferDescriptor = {
  kind: "project_file";
  transferId: string;
  name: string;
  mediaType: string;
  size: number;
};

/** An opaque reference to captured bytes. Consumers must not infer storage paths from it. */
export type BrowserNetworkBodyDescriptor = {
  bodyId: string;
  byteLength: number;
  sha256: string;
  mediaType: string | null;
  encoding: string | null;
};

export type BrowserNetworkHeader = {
  name: string;
  value: string;
};

export type BrowserNetworkRequest = {
  url: string;
  method: string;
  headers: BrowserNetworkHeader[];
  timestamp: number;
  wallTime: number | null;
  httpVersion: string | null;
  resourceType: string | null;
  initiator: unknown;
  body: BrowserNetworkBodyDescriptor | null;
};

export type BrowserNetworkResponse = {
  url: string;
  status: number;
  statusText: string;
  headers: BrowserNetworkHeader[];
  timestamp: number;
  httpVersion: string | null;
  mediaType: string | null;
  remoteAddress: { ip: string; port: number | null } | null;
  fromCache: boolean;
  fromServiceWorker: boolean;
  body: BrowserNetworkBodyDescriptor | null;
};

export type BrowserNetworkFailure = {
  timestamp: number;
  errorText: string;
  canceled: boolean;
  blockedReason: string | null;
};

/**
 * Redirects are represented as separate exchanges. The chain and adjacent exchange ids make
 * every hop explicit instead of overwriting the response which caused a redirect.
 */
export type BrowserNetworkRedirectHop = {
  chainId: string;
  index: number;
  redirectedFromExchangeId: string | null;
  redirectedToExchangeId: string | null;
};

export type BrowserNetworkExchange = {
  exchangeId: string;
  threadId: string;
  tabId: number;
  redirect: BrowserNetworkRedirectHop;
  request: BrowserNetworkRequest;
  response: BrowserNetworkResponse | null;
  failure: BrowserNetworkFailure | null;
  startedAt: number;
  completedAt: number | null;
};

/** A complete provider event, deliberately open so CDP/WebExtension additions survive capture. */
export type BrowserNetworkRawEvent = {
  event: string;
  payload: Record<string, unknown>;
  [field: string]: unknown;
};

/**
 * Canonical metadata for one exchange plus the untouched provider events used to derive it.
 * `rawEvents` is not normalized or projected and therefore retains provider-specific fields.
 */
export type CanonicalBrowserNetworkExchange<
  TRawEvent extends Record<string, unknown> = BrowserNetworkRawEvent,
> = {
  schemaVersion: 1;
  provider: BrowserName;
  exchange: BrowserNetworkExchange;
  rawEvents: TRawEvent[];
};

export type BrowserNetworkCapturePart = "metadata" | "requestBody" | "responseBody";

export type BrowserNetworkCapturePartDescriptor = {
  byteLength: number;
  sha256: string;
};

export type BrowserNetworkCaptureParts = {
  metadata: BrowserNetworkCapturePartDescriptor;
  requestBody?: BrowserNetworkCapturePartDescriptor;
  responseBody?: BrowserNetworkCapturePartDescriptor;
};

export type BrowserNetworkCaptureStartFrame = {
  type: "network.capture.start";
  captureId: string;
  threadId: string;
  tabId: number;
  exchangeId: string;
  provider: BrowserName;
  parts: BrowserNetworkCaptureParts;
};

export type BrowserNetworkCaptureChunkFrame = {
  type: "network.capture.chunk";
  captureId: string;
  part: BrowserNetworkCapturePart;
  offset: number;
  data: string;
};

export type BrowserNetworkCaptureCommitFrame = {
  type: "network.capture.commit";
  captureId: string;
};

export type BrowserNetworkCaptureAbortFrame = {
  type: "network.capture.abort";
  captureId: string;
  reason?: string;
};

export type BrowserNetworkCaptureFrame =
  | BrowserNetworkCaptureStartFrame
  | BrowserNetworkCaptureChunkFrame
  | BrowserNetworkCaptureCommitFrame
  | BrowserNetworkCaptureAbortFrame;

type BrowserExtensionHelloBase = {
  type: "client.hello";
  protocol: typeof BROWSER_EXTENSION_PROTOCOL;
  token: string;
  instanceId: string;
  extensionVersion: string;
  capabilities: {
    tools: readonly BrowserToolName[];
    maxProjectFileBytes: number;
    screenshots: readonly string[];
  };
  bindings: BrowserExtensionBindingSummary[];
};

export type BrowserExtensionClientHelloFrame = BrowserExtensionHelloBase & {
  version: BrowserExtensionProtocolVersion;
  browser: { name: BrowserName; version: string };
};

export type BrowserExtensionClientFrame =
  | BrowserExtensionClientHelloFrame
  | {
      type: "session.request";
      requestId: string;
      target: BrowserSessionTarget;
      tab: BrowserTabSummary;
    }
  | {
      type: "binding.updated" | "binding.detached";
      binding: BrowserExtensionBindingSummary;
    }
  | {
      type: "tool.result";
      requestId: string;
      result: unknown;
    }
  | {
      type: "tool.result.chunk";
      requestId: string;
      chunkIndex: number;
      chunkCount: number;
      data: string;
    }
  | {
      type: "tool.error";
      requestId: string;
      error: { code: string; message: string; data?: unknown };
    }
  | BrowserNetworkCaptureFrame
  | { type: "file.request"; transferId: string }
  | { type: "client.ping" | "client.pong"; at: number };

export type BrowserExtensionServerFrame =
  | {
      type: "server.hello";
      protocol: typeof BROWSER_EXTENSION_PROTOCOL;
      version: BrowserExtensionProtocolVersion;
      locale: UiLanguage;
      projects: BrowserExtensionProjectSummary[];
      threads: BrowserExtensionThreadSummary[];
    }
  | {
      type: "session.result";
      requestId: string;
      action: "created" | "attached";
      thread: BrowserExtensionThreadSummary;
    }
  | {
      type: "session.error";
      requestId: string;
      error: { code: string; message: string };
    }
  | { type: "binding.detach"; threadId: string }
  | {
      type: "tool.call";
      requestId: string;
      threadId: string;
      tool: BrowserToolName;
      arguments: unknown;
    }
  | {
      type: "file.transfer";
      transferId: string;
      chunkIndex: number;
      chunkCount: number;
      data: string;
    }
  | { type: "file.error"; transferId: string; error: string }
  | {
      type: "catalog.updated";
      projects: BrowserExtensionProjectSummary[];
      threads: BrowserExtensionThreadSummary[];
    }
  | { type: "server.ping" | "server.pong"; at: number }
  | { type: "protocol.error"; code: string; message: string };

export type CreateProjectRequest = {
  path: string;
};

export type MoveProjectRequest =
  { direction: "up" | "down"; targetIndex?: never } | { direction?: never; targetIndex: number };

export type CreateDirectoryRequest = {
  parentPath: string;
  name: string;
};

export type ForkThreadRequest = {
  lastTurnId: string;
  agentMessageId: string;
};

export type ForkThreadResponse = {
  thread: ThreadSummary;
};

export type CreateForkOperationRequest = ForkThreadRequest & {
  operationId: string;
  mode: ForkMode;
};

export type ForkOperationResponse = {
  operation: ForkOperationSummary;
};

export type ForkOperationDetailResponse = ForkOperationResponse & {
  queuedMessages: QueuedMessage[];
  draft: ThreadDraft | null;
};

export type CreateProjectThreadResponse = {
  thread: ThreadSummary;
  draft?: ThreadDraft | null;
};

export type RefreshThreadResponse = {
  snapshot: AppSnapshot;
  detail: ThreadDetail;
};

export type TurnStartResult = {
  turnId: string;
  goalWarning?: string;
};

export type StartTurnRequest = PastedText & {
  input: string;
  images?: string[];
  files?: ThreadFileAttachment[];
  goal?: boolean;
  clientMessageId?: string;
};

export type QueueMessageRequest = PastedText & {
  /** Claude can deliver an addition to the current turn without placing it in the queue. */
  deliveryMode?: "steer" | "queue";
  /** Consume the submitted draft only if its server revision still matches. */
  draftUpdatedAt?: number | null;
  projectDraft?: { projectId: string; updatedAt: number };
  input: string;
  images?: string[];
  files?: ThreadFileAttachment[];
  goal?: boolean;
  planImplementationMode?: PlanImplementationMode;
  clientMessageId?: string;
  replyToAsyncQuestion?: AsyncQuestionReference;
  replyToUserInput?: UserInputReply;
  dismissUserInput?: AsyncQuestionReference;
};

export type UpdateQueuedMessageRequest = PastedText & {
  input: string;
};

export type UpdateThreadSettingsRequest = {
  collaborationMode?: CollaborationMode;
  model?: string | null;
  reasoningEffort?: string | null;
  /** "fast" enables Fast mode; null clears the session setting. */
  serviceTier?: string | null;
  personality?: string | null;
};

export type InterruptTurnRequest = {
  turnId?: string;
};

export type UpdateThreadRequest = {
  name?: string;
  pinned?: boolean;
  browserEnabled?: boolean;
};

export type MarkReadRequest = {
  observedUpdatedAt: number;
};

export type DismissPlanRequest = {
  turnId: string;
  observedUpdatedAt: number;
};

export type MarkViewedRequest = {
  observedUpdatedAt: number;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isClientFrame(value: unknown): value is ClientFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "authenticate")
    return typeof value.token === "string" && value.token.length > 0;
  return value.type === "ping";
}

export function isServerFrame(value: unknown): value is ServerFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "snapshot") return isRecord(value.snapshot);
  if (value.type === "event") {
    if (!isProjectionSequence(value.sequence) || !isRecord(value.event)) return false;
    if (value.version === undefined) return true;
    return (
      isRecord(value.version) &&
      typeof value.version.instanceId === "string" &&
      value.version.instanceId.length > 0 &&
      isProjectionSequence(value.version.sequence) &&
      value.version.sequence === value.sequence
    );
  }
  if (value.type === "error") return isRecord(value.error);
  return value.type === "pong";
}

function isProjectionSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isBrowserToolName(value: unknown): value is BrowserToolName {
  return typeof value === "string" && (BROWSER_TOOL_NAMES as readonly string[]).includes(value);
}

export function isBrowserExtensionClientFrame(
  value: unknown,
): value is BrowserExtensionClientFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "client.hello") {
    return (
      value.protocol === BROWSER_EXTENSION_PROTOCOL &&
      isBrowserExtensionProtocolVersion(value.version) &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      isBrowserInstanceId(value.instanceId) &&
      nonEmptyString(value.extensionVersion) &&
      isRecord(value.browser) &&
      isBrowserName(value.browser.name) &&
      typeof value.browser.version === "string" &&
      isRecord(value.capabilities) &&
      Array.isArray(value.capabilities.tools) &&
      value.capabilities.tools.every(isBrowserToolName) &&
      typeof value.capabilities.maxProjectFileBytes === "number" &&
      Number.isFinite(value.capabilities.maxProjectFileBytes) &&
      Array.isArray(value.capabilities.screenshots) &&
      value.capabilities.screenshots.every((item) => typeof item === "string") &&
      Array.isArray(value.bindings) &&
      value.bindings.every(isBrowserExtensionBinding)
    );
  }
  if (value.type === "session.request") {
    return (
      nonEmptyString(value.requestId) &&
      isBrowserSessionTarget(value.target) &&
      isBrowserTabSummary(value.tab)
    );
  }
  if (value.type === "binding.updated" || value.type === "binding.detached") {
    return isBrowserExtensionBinding(value.binding);
  }
  if (value.type === "tool.result") {
    return nonEmptyString(value.requestId);
  }
  if (value.type === "tool.result.chunk") {
    return (
      nonEmptyString(value.requestId) &&
      Number.isInteger(value.chunkIndex) &&
      Number(value.chunkIndex) >= 0 &&
      Number.isInteger(value.chunkCount) &&
      Number(value.chunkCount) >= 1 &&
      Number(value.chunkIndex) < Number(value.chunkCount) &&
      Number(value.chunkCount) <= BROWSER_MAX_TOOL_RESULT_CHUNKS &&
      typeof value.data === "string" &&
      value.data.length <= BROWSER_TOOL_RESULT_CHUNK_BYTES
    );
  }
  if (value.type === "tool.error") {
    return (
      nonEmptyString(value.requestId) &&
      isRecord(value.error) &&
      nonEmptyString(value.error.code) &&
      nonEmptyString(value.error.message)
    );
  }
  if (value.type === "network.capture.start") {
    return (
      isProtocolIdentifier(value.captureId) &&
      nonEmptyString(value.threadId) &&
      isNonNegativeSafeInteger(value.tabId) &&
      isProtocolIdentifier(value.exchangeId) &&
      isBrowserName(value.provider) &&
      isBrowserNetworkCaptureParts(value.parts)
    );
  }
  if (value.type === "network.capture.chunk") {
    if (
      !isProtocolIdentifier(value.captureId) ||
      !isBrowserNetworkCapturePart(value.part) ||
      !isNonNegativeSafeInteger(value.offset) ||
      !isBase64Chunk(value.data)
    ) {
      return false;
    }
    return value.offset + base64DecodedByteLength(value.data) <= BROWSER_MAX_NETWORK_BODY_BYTES;
  }
  if (value.type === "network.capture.commit") {
    return isProtocolIdentifier(value.captureId);
  }
  if (value.type === "network.capture.abort") {
    return (
      isProtocolIdentifier(value.captureId) &&
      (value.reason === undefined || typeof value.reason === "string")
    );
  }
  if (value.type === "file.request") {
    return nonEmptyString(value.transferId);
  }
  if (value.type === "client.ping" || value.type === "client.pong") {
    return typeof value.at === "number" && Number.isFinite(value.at);
  }
  return false;
}

export function isBrowserExtensionServerFrame(
  value: unknown,
): value is BrowserExtensionServerFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "server.hello") {
    return (
      value.protocol === BROWSER_EXTENSION_PROTOCOL &&
      isBrowserExtensionProtocolVersion(value.version) &&
      (value.locale === "en" || value.locale === "ru") &&
      Array.isArray(value.projects) &&
      value.projects.every(isBrowserProjectSummary) &&
      Array.isArray(value.threads) &&
      value.threads.every(isBrowserThreadSummary)
    );
  }
  if (value.type === "session.result") {
    return (
      nonEmptyString(value.requestId) &&
      (value.action === "created" || value.action === "attached") &&
      isBrowserThreadSummary(value.thread)
    );
  }
  if (value.type === "session.error") {
    return (
      nonEmptyString(value.requestId) &&
      isRecord(value.error) &&
      nonEmptyString(value.error.code) &&
      nonEmptyString(value.error.message)
    );
  }
  if (value.type === "binding.detach") return nonEmptyString(value.threadId);
  if (value.type === "tool.call") {
    return (
      nonEmptyString(value.requestId) &&
      nonEmptyString(value.threadId) &&
      isBrowserToolName(value.tool)
    );
  }
  if (value.type === "file.transfer") {
    return (
      nonEmptyString(value.transferId) &&
      Number.isInteger(value.chunkIndex) &&
      Number.isInteger(value.chunkCount) &&
      typeof value.data === "string"
    );
  }
  if (value.type === "file.error") {
    return nonEmptyString(value.transferId) && nonEmptyString(value.error);
  }
  if (value.type === "catalog.updated") {
    return (
      Array.isArray(value.projects) &&
      value.projects.every(isBrowserProjectSummary) &&
      Array.isArray(value.threads) &&
      value.threads.every(isBrowserThreadSummary)
    );
  }
  if (value.type === "server.ping" || value.type === "server.pong") {
    return typeof value.at === "number" && Number.isFinite(value.at);
  }
  if (value.type === "protocol.error") {
    return nonEmptyString(value.code) && nonEmptyString(value.message);
  }
  return false;
}

function isBrowserExtensionBinding(value: unknown): value is BrowserExtensionBindingSummary {
  return (
    isRecord(value) &&
    nonEmptyString(value.threadId) &&
    nonEmptyString(value.projectId) &&
    typeof value.title === "string" &&
    Number.isInteger(value.groupId) &&
    Array.isArray(value.tabIds) &&
    value.tabIds.every((tabId) => Number.isInteger(tabId) && Number(tabId) >= 0) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
}

function isBrowserExtensionProtocolVersion(
  value: unknown,
): value is BrowserExtensionProtocolVersion {
  return (
    value === BROWSER_EXTENSION_PROTOCOL_VERSION_V1 ||
    value === BROWSER_EXTENSION_PROTOCOL_VERSION_V2
  );
}

function isBrowserName(value: unknown): value is BrowserName {
  return value === "chrome";
}

function isBrowserNetworkCapturePart(value: unknown): value is BrowserNetworkCapturePart {
  return value === "metadata" || value === "requestBody" || value === "responseBody";
}

function isBrowserNetworkCapturePartDescriptor(
  value: unknown,
): value is BrowserNetworkCapturePartDescriptor {
  return (
    isRecord(value) &&
    isNonNegativeSafeInteger(value.byteLength) &&
    value.byteLength <= BROWSER_MAX_NETWORK_BODY_BYTES &&
    typeof value.sha256 === "string" &&
    /^[a-f\d]{64}$/i.test(value.sha256)
  );
}

function isBrowserNetworkCaptureParts(value: unknown): value is BrowserNetworkCaptureParts {
  return (
    isRecord(value) &&
    isBrowserNetworkCapturePartDescriptor(value.metadata) &&
    (value.requestBody === undefined || isBrowserNetworkCapturePartDescriptor(value.requestBody)) &&
    (value.responseBody === undefined || isBrowserNetworkCapturePartDescriptor(value.responseBody))
  );
}

function isBase64Chunk(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= BROWSER_NETWORK_CAPTURE_CHUNK_BYTES &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)
  );
}

function base64DecodedByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isProtocolIdentifier(value: unknown): value is string {
  return nonEmptyString(value) && value.length <= 200 && /^[A-Za-z\d._:-]+$/.test(value);
}

function isBrowserSessionTarget(value: unknown): value is BrowserSessionTarget {
  return (
    isRecord(value) &&
    ((value.kind === "new" && nonEmptyString(value.projectId)) ||
      (value.kind === "existing" && nonEmptyString(value.threadId)))
  );
}

function isBrowserTabSummary(value: unknown): value is BrowserTabSummary {
  return (
    isRecord(value) &&
    Number.isInteger(value.id) &&
    Number(value.id) >= 0 &&
    Number.isInteger(value.windowId) &&
    Number.isInteger(value.groupId) &&
    typeof value.active === "boolean" &&
    typeof value.title === "string" &&
    typeof value.url === "string"
  );
}

function isBrowserProjectSummary(value: unknown): value is BrowserExtensionProjectSummary {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    typeof value.displayName === "string" &&
    typeof value.path === "string"
  );
}

function isBrowserThreadSummary(value: unknown): value is BrowserExtensionThreadSummary {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.projectId) &&
    typeof value.title === "string" &&
    typeof value.state === "string"
  );
}

function isBrowserInstanceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function bearerHeader(token: string): string {
  return `Bearer ${token}`;
}

/** Apply only fields changed by this editor, preserving changes from other devices. */
export function mergeProjectDraft(
  current: UpdateThreadDraftRequest,
  base: UpdateThreadDraftRequest,
  value: UpdateThreadDraftRequest,
): UpdateThreadDraftRequest {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const mergeItems = <T extends { id: string }>(remote: T[], previous: T[], next: T[]): T[] => {
    const removed = new Set(
      previous.filter((item) => !next.some((entry) => entry.id === item.id)).map((item) => item.id),
    );
    const changed = next.filter(
      (item) =>
        !same(
          item,
          previous.find((entry) => entry.id === item.id),
        ),
    );
    const result = remote.filter((item) => !removed.has(item.id));
    for (const item of changed) {
      const index = result.findIndex((entry) => entry.id === item.id);
      if (index < 0) result.push(item);
      else result[index] = item;
    }
    return result;
  };
  const textChanged = !same([base.input, pastedText(base)], [value.input, pastedText(value)]);
  return {
    input: textChanged ? value.input : current.input,
    ...pastedText(textChanged ? value : current),
    images: mergeItems(current.images, base.images, value.images),
    files: mergeItems(current.files ?? [], base.files ?? [], value.files ?? []),
    goalMode: base.goalMode !== value.goalMode ? value.goalMode : current.goalMode,
    annotations: mergeItems(current.annotations, base.annotations, value.annotations),
  };
}
export * from "./claude-accounts.js";
export * from "./claude-proxy.js";
