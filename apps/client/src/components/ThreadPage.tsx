import { onBeforeAppReload } from "../app-reload";
import { application } from "../application";
import { useTypography } from "../typography";
import { PasteBlocks } from "./PasteBlocks";
import { isNativeSubagentLaunch, NativeSubagentLaunchCard } from "./NativeSubagentLaunchCard";
import { SubagentActivityBar } from "./SubagentActivityBar";
import { PasteMessageEditor } from "./PasteEditor";
import { PastedMarkdown } from "./PastedMarkdown";
import {
  pastedText,
  mergeProjectDraft,
  rebasePastedText,
  trimPastedMessage,
  copyPastedMessage,
  type PastedText,
} from "@codexnest/protocol";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { type Components as MarkdownComponents } from "react-markdown";
import { Link, matchPath, Navigate, useLocation, useNavigate, useParams } from "react-router";

import { DEFAULT_SESSION_SETTINGS, fastServiceTier, isFastServiceTier } from "@codexnest/protocol";
import type {
  ActivityItem,
  GitChangesSummary,
  ModelOption,
  Project,
  QueuedMessage,
  SessionSettings,
  TaskDefaults,
  ThreadDetail,
  ThreadDraft,
  ThreadFileAttachment,
  ThreadSummary,
  ThreadState,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  TranscriptionTimingEstimate,
  TurnProgress,
  TurnView,
  UiLanguage,
  UpdateThreadDraftRequest,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
  VoiceTranscriptionMode,
  VoiceTranscriptionStatus,
} from "@codexnest/protocol";

import {
  artifactDescriptor,
  type ArtifactDescriptor,
  type SessionArtifact,
  localDownloadPath,
  sessionArtifacts,
  type ThreadArtifactsResponse,
} from "../artifacts";
import {
  type AnnotationDraft,
  formatAnnotatedMessage,
  loadPendingAnnotations,
  type PendingAnnotation,
  rangeOffsets,
  resolveAnnotationRange,
  savePendingAnnotations,
} from "../annotations";
import { copyMarkdown, copyText } from "../clipboard";
import { useConnection } from "../connection";
import { type ApiClient, ApiClientError, isRetryableApiError } from "../api";
import { openDownloadUrl } from "../downloads";
import { forkOperationsFromSnapshot } from "../forks";
import { localizeKnownServerText, type Translate, useI18n } from "../i18n";
import {
  confirmLocalDraft,
  deleteLocalDraft,
  deleteNewSessionDraft,
  loadLocalDraft,
  loadNewSessionDraft,
  saveLocalDraft,
  saveNewSessionDraft,
  type NewSessionSubmission,
  type NewSessionAttachment,
  type NewSessionVoiceSubmission,
} from "../offline-store";
import { acknowledgePendingThread, releaseActiveThread } from "../push";
import type { OptimisticMessage } from "../state";
import { threadStatusClasses } from "../thread-status";
import { AttentionPanel } from "./AttentionPanel";
import { AsyncQuestionCard } from "./AsyncQuestionCard";
import { searchTargetFromState, type SearchTarget } from "./ThreadSearchDialog";
import { ArtifactViewer, type ArtifactLoadResult } from "./ArtifactViewer";
import {
  Composer,
  type ComposerImage,
  type ComposerRecording,
  type ComposerSubmitIntent,
} from "./Composer";
import { Dialog } from "./Dialog";
import { ForkDialog } from "./ForkDialog";
import {
  ArchiveIcon,
  ArrowDownIcon,
  BrowserIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  CopyIcon,
  FileIcon,
  GitBranchIcon,
  MoreIcon,
  MicrophoneIcon,
  NewTaskIcon,
  PencilIcon,
  PinIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
  TargetIcon,
  TeamIcon,
  TerminalIcon,
  ToolIcon,
  TrashIcon,
  XIcon,
} from "./Icons";
import { ImageViewer } from "./ImageViewer";
import {
  GalleryImageLink,
  MessageImageGallery,
  MessageImageProvider,
  useMessageImageGallery,
} from "./MessageImageGallery";
import {
  type ArtifactLoadState,
  type GitChangesView,
  type InspectorTab,
  NewSessionInspector,
  SessionInspector,
} from "./SessionInspector";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { ActionLabel } from "./ActionLabel";

type ComposerDraftState = {
  threadId: string;
  value: UpdateThreadDraftRequest;
};

type VoiceRecordingContext = {
  draft: UpdateThreadDraftRequest;
  draftUpdatedAt: number | null;
  mode: VoiceTranscriptionMode;
};

type LocalImageLoader = (path: string) => Promise<Blob>;
type LocalArtifactOpener = (artifact: ArtifactDescriptor, opener: HTMLButtonElement | null) => void;

const ORCHESTRATION_CHANGED_PATH_LIMIT = 20;
// A reopened project must await the previous workspace's final draft write.
const pendingNewSessionDraftSaves = new Map<string, Promise<void>>();
function newSessionDraftSaveKey(settings: ApiClient["settings"], projectId: string): string {
  return `${settings.baseUrl}\0${settings.token}\0${projectId}`;
}
const QUESTION_REPLY_MESSAGE_ID_PREFIXES = ["user-input:", "async-answer:"] as const;

type NewSessionPreparation = {
  active: boolean;
  projectId: string;
  clientCreationId: string;
  value: UpdateThreadDraftRequest;
  settings: SessionSettings;
  phase: "creating" | "transferring";
  threadId: string | null;
  thread: ThreadSummary | null;
  revision: number;
  sharedBase?: ThreadDraft | null;
  sharedDraftUpdatedAt?: number;
  submission?: NewSessionSubmission;
  voiceSubmission?: NewSessionVoiceSubmission;
  attachments?: NewSessionAttachment[];
};

type EarlySubmission = {
  id: string;
  intent: ComposerSubmitIntent;
  input: string;
  attachmentScope: number;
  claimedRevision: number;
  draft: UpdateThreadDraftRequest;
  editRevision: number;
  staged?: boolean;
};

type PendingSettingsField = keyof UpdateThreadSettingsRequest;
type ClientSessionSettings = SessionSettings;

export type QueueAction = {
  messageId: string;
  kind: "send" | "update" | "delete";
};

export type QueuedMessageView = QueuedMessage & {
  confirmed: boolean;
  serverAccepted?: boolean;
};

type SubmittedMessageIdentity = PastedText & {
  text: string;
  images: readonly string[];
  files: ReadonlyArray<{ name: string; path: string }>;
  goal: boolean;
};

type GoalAwareOptimisticMessage = OptimisticMessage & {
  goal?: boolean;
};

type VoiceUploadState = {
  mode: VoiceTranscriptionMode;
  startedAt: number;
  dismissUserInput?: QueuedMessage["dismissUserInput"];
};

type VoiceProgress = {
  status: "uploading" | Exclude<VoiceTranscriptionStatus, "failed">;
  elapsedSeconds: number;
  estimatedTotalSeconds: number | null;
};

function emptyComposerDraft(): UpdateThreadDraftRequest {
  return { input: "", images: [], goalMode: false, annotations: [] };
}

function composerDraftHasContent(value: UpdateThreadDraftRequest): boolean {
  return (
    Boolean(value.input) ||
    !!value.pasteBlocks?.length ||
    value.images.length > 0 ||
    (value.files?.length ?? 0) > 0 ||
    value.goalMode ||
    value.annotations.length > 0
  );
}

function submittedMessageFingerprint(identity: SubmittedMessageIdentity): string {
  return JSON.stringify([
    identity.text.trim(),
    identity.images,
    identity.files.map(({ name, path }) => ({ name, path })),
    identity.goal,
    pastedText(identity),
  ]);
}

function latestRootUserMessage(detail: ThreadDetail | undefined): ActivityItem | null {
  for (let turnIndex = (detail?.turns.length ?? 0) - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = detail!.turns[turnIndex]!.items;
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex]!;
      if (item.type === "userMessage") return item;
    }
  }
  return null;
}

function normalizeNewSessionDraft(value: UpdateThreadDraftRequest): UpdateThreadDraftRequest {
  return structuredClone({
    input: value.input,
    ...pastedText(value),
    images: value.images,
    ...(value.files?.length ? { files: value.files } : {}),
    goalMode: value.goalMode,
    annotations: value.annotations,
  });
}

export function initialSessionSettings(
  defaultReasoningEffort: string | undefined,
  models: ModelOption[],
  taskDefaults?: TaskDefaults,
): ClientSessionSettings {
  const explicitModel = taskDefaults?.model
    ? models.find((candidate) => candidate.id === taskDefaults.model)
    : undefined;
  const model = explicitModel ?? effectiveDefaultModel(models);
  const settings = {
    ...DEFAULT_SESSION_SETTINGS,
    ...(explicitModel ? { model: explicitModel.id } : {}),
    ...(!application.isClaude &&
    isFastServiceTier(taskDefaults?.serviceTier) &&
    fastServiceTier(model)
      ? { serviceTier: "fast" }
      : {}),
    ...(taskDefaults?.personality && (!model || model.supportsPersonality)
      ? { personality: taskDefaults.personality }
      : {}),
  };
  if (
    defaultReasoningEffort &&
    (!model || model.reasoningEfforts.some((option) => option.value === defaultReasoningEffort))
  ) {
    settings.reasoningEffort = defaultReasoningEffort;
  }
  return settings;
}

function clientSessionSettings(value: SessionSettings): ClientSessionSettings {
  const next = { ...value };
  if (!application.isClaude && isFastServiceTier(next.serviceTier)) next.serviceTier = "fast";
  else delete next.serviceTier;
  return next;
}

function clientSessionSettingsPatch(
  value: UpdateThreadSettingsRequest,
): UpdateThreadSettingsRequest {
  const next = { ...value };
  if (application.isClaude) delete next.serviceTier;
  else if (isFastServiceTier(next.serviceTier)) next.serviceTier = "fast";
  else if (next.serviceTier !== null) delete next.serviceTier;
  return next;
}

function applySessionSettingsPatch(
  current: ClientSessionSettings,
  patch: UpdateThreadSettingsRequest,
): ClientSessionSettings {
  const next = { ...current };
  if (patch.collaborationMode !== undefined) {
    next.collaborationMode = patch.collaborationMode;
  }
  for (const key of ["model", "reasoningEffort", "serviceTier", "personality"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function settingsPatchBetween(
  current: SessionSettings,
  target: ClientSessionSettings,
  touched: ReadonlySet<PendingSettingsField>,
): UpdateThreadSettingsRequest {
  current = clientSessionSettings(current);
  const patch: UpdateThreadSettingsRequest = {};
  if (touched.has("collaborationMode") && current.collaborationMode !== target.collaborationMode) {
    patch.collaborationMode = target.collaborationMode;
  }
  for (const key of ["model", "reasoningEffort", "serviceTier", "personality"] as const) {
    if (!touched.has(key) || current[key] === target[key]) continue;
    patch[key] = target[key] ?? null;
  }
  return patch;
}

function mergeComposerImages(
  first: readonly ComposerImage[],
  second: readonly ComposerImage[],
): ComposerImage[] {
  const merged = [...first];
  const known = new Set(first.map((image) => image.id || image.url));
  for (const image of second) {
    const key = image.id || image.url;
    if (known.has(key)) continue;
    known.add(key);
    merged.push(image);
  }
  return merged;
}

function mergeComposerFiles(
  first: readonly ThreadFileAttachment[],
  second: readonly ThreadFileAttachment[],
): ThreadFileAttachment[] {
  const merged = [...first];
  const known = new Set(first.map((file) => file.id));
  for (const file of second) {
    if (known.has(file.id)) continue;
    known.add(file.id);
    merged.push(file);
  }
  return merged;
}

function mergeComposerDrafts(
  submitted: UpdateThreadDraftRequest,
  newer: UpdateThreadDraftRequest,
): UpdateThreadDraftRequest {
  const submittedInput = submitted.input.trimEnd();
  const newerInput = newer.input.trimStart();
  const input =
    !submittedInput || !newerInput || submittedInput === newerInput
      ? submittedInput || newerInput
      : `${submittedInput}\n\n${newerInput}`;
  const firstPastes = rebasePastedText(submitted.input, submittedInput, submitted);
  const nextPastes = rebasePastedText(newer.input, newerInput, newer);
  const blockIds = new Set(submitted.pasteBlocks?.map((block) => block.id));
  const inlinePastes = !submittedInput
    ? nextPastes.inlinePastes
    : !newerInput || submittedInput === newerInput
      ? firstPastes.inlinePastes
      : [
          ...(firstPastes.inlinePastes ?? []),
          ...(nextPastes.inlinePastes ?? []).map((range) => ({
            ...range,
            start: range.start + submittedInput.length + 2,
            end: range.end + submittedInput.length + 2,
          })),
        ];
  const annotationIds = new Set(submitted.annotations.map((annotation) => annotation.id));
  const files = mergeComposerFiles(submitted.files ?? [], newer.files ?? []);
  return {
    input,
    ...pastedText({
      inlinePastes,
      pasteBlocks: [
        ...(submitted.pasteBlocks ?? []),
        ...(newer.pasteBlocks ?? []).filter((block) => !blockIds.has(block.id)),
      ],
    }),
    images: mergeComposerImages(submitted.images, newer.images),
    ...(files.length ? { files } : {}),
    goalMode: newer.goalMode || (!newerInput && submitted.goalMode),
    annotations: [
      ...submitted.annotations,
      ...newer.annotations.filter((annotation) => !annotationIds.has(annotation.id)),
    ],
  };
}

const PREPARATION_SUPERSEDED = Symbol("preparation superseded");

function pendingThreadSummary(project: Project, settings: SessionSettings): ThreadSummary {
  return {
    id: "",
    projectId: project.id,
    title: "Новая задача",
    preview: "",
    cwd: project.path,
    state: "idle",
    unread: false,
    unseen: false,
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    currentTurnId: null,
    queuedMessageCount: 0,
    browserStatus: "disabled",
    settings,
    relation: { kind: "session", sessionId: "" },
  };
}

const DETAIL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
const TAIL_FOLLOW_THRESHOLD_PX = 1;
const SCROLL_GESTURE_THRESHOLD_PX = 6;
const DRAFT_SAVE_DELAY_MS = 500;

function forkChildPriority(thread: ThreadSummary): number {
  if (thread.archived) return 4;
  if (thread.state === "needsAttention") return 0;
  if (thread.state === "running") return 1;
  if (thread.state === "queued") return 2;
  return 3;
}

function sortForkChildren(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((left, right) => {
    const priority = forkChildPriority(left) - forkChildPriority(right);
    if (priority !== 0) return priority;
    return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
  });
}

function forkChildStateLabel(state: ThreadState, t: Translate): string {
  switch (state) {
    case "needsAttention":
      return t("Требуется внимание");
    case "running":
      return t("Выполняется");
    case "queued":
      return t("В очереди");
    case "completed":
      return t("Завершена");
    case "failed":
      return t("Ошибка");
    case "interrupted":
      return t("Прервана");
    case "unavailable":
      return t("Недоступна");
    case "idle":
      return t("Готова");
  }
}

function resolveVoiceTranscriptionMode(
  currentTurnId: string | null,
  ownerRunning = false,
): VoiceTranscriptionMode {
  return currentTurnId || (application.isClaude && ownerRunning) ? "steer" : "send";
}

export function ThreadPage({
  projects,
  transcriptionConfig = null,
  transcriptionProvider = null,
  onTranscriptionTimingEstimateChange,
  onOpenNavigation,
}: {
  projects?: Project[];
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onTranscriptionTimingEstimateChange?(estimate: TranscriptionTimingEstimate): void;
  onOpenNavigation(): void;
}) {
  const { threadId: parameterThreadId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const newSessionRoute = location.pathname === "/new";
  const requestedProjectId = newSessionRoute
    ? (new URLSearchParams(location.search).get("projectId") ?? "")
    : "";
  const initialNewSessionRef = useRef({
    active: newSessionRoute,
    projectId: requestedProjectId,
    workspaceId:
      typeof (location.state as { newSessionWorkspaceId?: unknown } | null)
        ?.newSessionWorkspaceId === "string"
        ? (
            location.state as {
              newSessionWorkspaceId: string;
            }
          ).newSessionWorkspaceId
        : `direct:${location.search}`,
    admitted:
      (location.state as { newSessionProjectId?: unknown } | null)?.newSessionProjectId ===
      requestedProjectId,
  });
  const [createdThreadId, setCreatedThreadId] = useState<string | null>(null);
  const matchedThreadId = matchPath("/threads/:threadId", location.pathname)?.params.threadId ?? "";
  const threadId = parameterThreadId || matchedThreadId || createdThreadId || "";
  const { language, t } = useI18n();
  const languageRef = useRef(language);
  languageRef.current = language;
  const {
    api,
    state,
    appActive,
    foregroundEpoch,
    streamRecoveryEpoch,
    dispatch,
    hydrateCachedDetail = async () => undefined,
    refreshDetail,
    forceRefreshDetail,
    loadOlderDetail,
    loadTurnItems,
    sendReliable,
    retryReliableMessage = async () => undefined,
    forgetReliableMessage = async () => undefined,
    queueVoiceRecording,
    pendingVoiceRecordingThreadIds = [],
    pendingVoiceRecordingErrors = {},
    pendingVoiceInputDismissals = {},
    retryPendingVoiceRecording = async () => undefined,
  } = useConnection();
  const activeThreadIdRef = useRef(threadId);
  activeThreadIdRef.current = threadId;
  const viewedThreadVersionRef = useRef<string | null>(null);
  const availableProjects = projects ?? state.snapshot?.projects ?? [];
  const newSessionProject =
    availableProjects.find(
      (candidate) => candidate.id === initialNewSessionRef.current.projectId,
    ) ?? null;
  const [newSessionAdmitted, setNewSessionAdmitted] = useState(
    initialNewSessionRef.current.admitted,
  );
  const [newSessionRejected, setNewSessionRejected] = useState(false);
  const [newSessionHydrated, setNewSessionHydrated] = useState(
    !initialNewSessionRef.current.active,
  );
  const [preparationRetry, setPreparationRetry] = useState(0);
  const [storageWarning, setStorageWarning] = useState(false);
  const [pendingSettings, setPendingSettings] = useState<ClientSessionSettings>(() =>
    initialSessionSettings(
      state.snapshot?.defaultReasoningEffort,
      state.snapshot?.models ?? [],
      state.snapshot?.taskDefaults,
    ),
  );
  const pendingSettingsRef = useRef(pendingSettings);
  const preparationRef = useRef<NewSessionPreparation>({
    active: initialNewSessionRef.current.active,
    projectId: initialNewSessionRef.current.projectId,
    clientCreationId: crypto.randomUUID(),
    value: emptyComposerDraft(),
    settings: pendingSettings,
    phase: "creating",
    threadId: null,
    thread: null,
    revision: 0,
  });
  const pendingSettingsRevisionRef = useRef(0);
  const pendingSettingsTouchedRef = useRef(new Set<PendingSettingsField>());
  const appliedSettingsRevisionRef = useRef(0);
  const settingsApplyPromiseRef = useRef<Promise<ThreadSummary> | null>(null);
  const creationPromiseRef = useRef<Promise<ThreadSummary> | null>(null);
  const preparationOperationRef = useRef<Promise<void> | null>(null);
  const preparationVoiceOperationRef = useRef<Promise<void> | null>(null);
  const preparationGenerationRef = useRef(1);
  const preparationAliveRef = useRef(true);
  const preparationDiscardRef = useRef(false);
  const preparationDraftTouchedRef = useRef(false);
  const preparationDraftTimerRef = useRef<number | null>(null);
  const preparationDraftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const preparationHydrationRef = useRef<Promise<void> | null>(null);
  const preparationSendRetryRef = useRef<number | null>(null);
  const preparationSendAttemptsRef = useRef(0);
  const [attachmentScope, setAttachmentScope] = useState(0);
  const attachmentScopeRef = useRef(attachmentScope);
  const pendingAttachmentScopesRef = useRef(new Set<number>());
  const attachmentWaitersRef = useRef(new Set<{ scope: number | null; resolve: () => void }>());
  const earlySubmitRef = useRef(false);
  const preparationClaimedForSubmitRef = useRef(false);
  const earlySubmissionRef = useRef<EarlySubmission | null>(null);
  const messageClaimsRef = useRef(new Set<string>());
  const activeMessageFingerprintsRef = useRef(new Set<string>());
  const submittedGoalMessageIdsRef = useRef(new Set<string>());
  const planAcceptanceInFlightRef = useRef(false);
  const planDismissalInFlightRef = useRef(false);
  const composerEditRevisionRef = useRef(0);
  const createdInWorkspaceRef = useRef<string | null>(null);
  const skipInitialCreatedDetailRef = useRef<string | null>(null);
  const [detailLoadError, setDetailLoadError] = useState<string | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [pendingOptimisticMessage, setPendingOptimisticMessage] =
    useState<OptimisticMessage | null>(null);
  const detail = state.details?.[threadId];
  const searchTarget = useMemo(
    () =>
      application.capabilities.fullTextSearch
        ? searchTargetFromState(location.state, threadId)
        : null,
    [location.state, threadId],
  );
  const summary = reconcileVisibleThreadSummary(
    state.snapshot?.threads.find((thread) => thread.id === threadId),
    detail,
    state.snapshot?.instanceId,
    state.snapshot?.sequence,
  );
  const parentThreadId =
    summary?.relation.kind === "subagent" ? summary.relation.parentThreadId : null;
  const isSubagent = parentThreadId !== null;
  const childSubagents = useMemo(
    () =>
      (state.snapshot?.threads ?? []).filter(
        (thread) =>
          thread.relation.kind === "subagent" && thread.relation.parentThreadId === threadId,
      ),
    [state.snapshot?.threads, threadId],
  );
  const inputUnavailable = summary?.canAcceptDirectInput === false;
  const parentSummary = parentThreadId
    ? state.snapshot?.threads.find((thread) => thread.id === parentThreadId)
    : undefined;
  const forkedFromId =
    summary?.relation.kind === "session" ? (summary.relation.forkedFromId ?? null) : null;
  const forkParentSummary = forkedFromId
    ? state.snapshot?.threads.find((thread) => thread.id === forkedFromId)
    : undefined;
  const forkChildren = useMemo(
    () =>
      sortForkChildren(
        (state.snapshot?.threads ?? []).filter(
          (thread) =>
            thread.relation.kind === "session" && thread.relation.forkedFromId === threadId,
        ),
      ),
    [state.snapshot?.threads, threadId],
  );
  const pendingForkOperations = useMemo(
    () =>
      forkOperationsFromSnapshot(state.snapshot).filter(
        (operation) => operation.sourceThreadId === threadId && operation.status !== "ready",
      ),
    [state.snapshot, threadId],
  );
  const forkChildrenMenuRef = useRef<HTMLDetailsElement>(null);
  const project =
    newSessionProject ??
    state.snapshot?.projects.find((candidate) => candidate.id === summary?.projectId) ??
    null;
  const [artifactShelf, setArtifactShelf] = useState<{
    threadId: string;
    response: ThreadArtifactsResponse;
  } | null>(null);
  const artifactResponse =
    artifactShelf && artifactShelf.threadId === threadId ? artifactShelf.response : null;
  const threadArtifacts = useMemo(() => sessionArtifacts(artifactResponse), [artifactResponse]);
  const [composerDraftState, setComposerDraftState] = useState<ComposerDraftState>(() => ({
    threadId,
    value: detail?.draft
      ? {
          input: detail.draft.input,
          ...pastedText(detail.draft),
          images: detail.draft.images,
          files: detail.draft.files ?? [],
          goalMode: detail.draft.goalMode,
          annotations: detail.draft.annotations,
        }
      : emptyComposerDraft(),
  }));
  const composerDraftRef = useRef<ComposerDraftState>(composerDraftState);
  const activeComposerDraft =
    composerDraftRef.current.threadId === threadId
      ? composerDraftRef.current.value
      : emptyComposerDraft();
  const { input, images, files = [], goalMode, annotations } = activeComposerDraft;
  const [composerInputSyncRevision, setComposerInputSyncRevision] = useState(0);
  const [goalBusy, setGoalBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [forkDialogTarget, setForkDialogTarget] = useState<{
    lastTurnId: string;
    agentMessageId: string;
  } | null>(null);
  const forkDialogOpenerRef = useRef<HTMLElement | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [browserUpdating, setBrowserUpdating] = useState(false);
  const [pinUpdating, setPinUpdating] = useState(false);
  const [queueAction, setQueueAction] = useState<QueueAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamUpgradeRequired, setTeamUpgradeRequired] = useState(false);
  const [threadMissing, setThreadMissing] = useState(false);
  const currentTurnIdRef = useRef(summary?.currentTurnId ?? null);
  currentTurnIdRef.current = summary?.currentTurnId ?? null;
  const [voiceUploads, setVoiceUploads] = useState<Record<string, VoiceUploadState>>({});
  const localVoiceJobIdsRef = useRef(new Set<string>());
  const [voiceCancellationPending, setVoiceCancellationPending] = useState(false);
  const [voiceRecoveryPending, setVoiceRecoveryPending] = useState(false);
  const [transcriptionElapsedSeconds, setTranscriptionElapsedSeconds] = useState(0);
  const handledVoiceRemovalsRef = useRef(new Set<string>());
  const [renaming, setRenaming] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollThread = useRef<string | null>(null);
  const followsTail = useRef(true);
  const waitingForScrollAway = useRef(false);
  const tailCorrectionFrame = useRef<number | null>(null);
  const smoothTailScroll = useRef(false);
  const scrollTouchOrigin = useRef<{ x: number; y: number } | null>(null);
  const locationNoticeHandled = useRef<string | null>(null);
  const scrollTargetMessageId = useRef<string | null>(null);
  const olderScrollAnchor = useRef<{
    threadId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [artifactLoadState, setArtifactLoadState] = useState<ArtifactLoadState>("idle");
  const artifactRequestRun = useRef(0);
  const [artifactViewer, setArtifactViewer] = useState<{
    artifact: ArtifactDescriptor;
    opener: HTMLButtonElement | null;
    returnToInspector: boolean;
  } | null>(null);
  const artifactViewerRef = useRef(artifactViewer);
  artifactViewerRef.current = artifactViewer;
  useEffect(() => {
    artifactRequestRun.current += 1;
    setArtifactShelf(null);
    setArtifactLoadState("idle");
    setArtifactViewer(null);
    setInspectorTab("overview");
  }, [threadId]);
  const [gitChangesState, setGitChangesState] = useState<{
    threadId: string;
    value: GitChangesView;
  } | null>(null);
  const gitChangesRequest = useRef(0);
  const draftTimerRef = useRef<{ threadId: string; timer: number } | null>(null);
  const pendingDraftsRef = useRef(
    new Map<
      string,
      { revision: number; value: UpdateThreadDraftRequest; localUpdatedAt: number }
    >(),
  );
  const savedDraftUpdatedAtRef = useRef(new Map<string, number | null>());
  const draftRevisionRef = useRef(0);
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const flushComposerDraftRef = useRef<
    (targetThreadId?: string, keepalive?: boolean) => Promise<void>
  >(() => Promise.resolve());
  const flushComposerDraftEvent = useCallback(
    (targetThreadId?: string, keepalive = false) =>
      flushComposerDraftRef.current(targetThreadId, keepalive),
    [],
  );
  const onDraftFlush = useCallback(() => {
    void flushComposerDraftEvent().catch((caught: unknown) => {
      if (preparationAliveRef.current)
        setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [flushComposerDraftEvent]);
  const draftTouchedThreadsRef = useRef(new Set<string>());
  const hydratedDraftSourcesRef = useRef(new Map<string, ThreadDraft | null>());
  const legacyAnnotationThreadsRef = useRef(new Set<string>());
  const annotationActionsRef = useRef<{
    create(draft: AnnotationDraft): boolean;
    update(annotationId: string, comment: string): boolean;
    delete(annotationId: string): boolean;
  } | null>(null);
  const createAnnotationEvent = useCallback(
    (draft: AnnotationDraft) => annotationActionsRef.current?.create(draft) ?? false,
    [],
  );
  const updateAnnotationEvent = useCallback(
    (annotationId: string, comment: string) =>
      annotationActionsRef.current?.update(annotationId, comment) ?? false,
    [],
  );
  const deleteAnnotationEvent = useCallback(
    (annotationId: string) => annotationActionsRef.current?.delete(annotationId) ?? false,
    [],
  );
  const attention = useMemo(
    () => state.snapshot?.attention?.filter((item) => item.threadId === threadId) ?? [],
    [state.snapshot?.attention, threadId],
  );
  // Keep an interacted-with standalone form in place until it is answered.
  // A late history response must not reparent it and discard input or focus.
  const standaloneAttentionIds = useRef(new Set<string>());
  const attentionIds = new Set(attention.map((request) => request.id));
  for (const id of standaloneAttentionIds.current) {
    if (!attentionIds.has(id)) standaloneAttentionIds.current.delete(id);
  }
  function userInputToDismiss(targetThreadId: string): QueuedMessage["dismissUserInput"] {
    if (application.isClaude) return undefined;
    const request = state.snapshot?.attention?.find(
      (item) =>
        item.threadId === targetThreadId && item.kind === "userInput" && item.turnId && item.itemId,
    );
    return request?.turnId && request.itemId
      ? { turnId: request.turnId, itemId: request.itemId }
      : undefined;
  }
  const goal = state.goals?.[threadId];
  const voiceJob =
    state.snapshot?.voiceTranscriptions?.find(
      (job) => job.threadId === threadId && !job.userInput,
    ) ?? null;
  const voiceRemoval = state.voiceRemovals?.[threadId];
  const activeVoiceJob = voiceJob?.status === "failed" ? null : voiceJob;
  const localActiveVoiceJob =
    activeVoiceJob && localVoiceJobIdsRef.current.has(activeVoiceJob.id) ? activeVoiceJob : null;
  const voiceUpload = voiceUploads[threadId] ?? null;
  const preparingVoiceSubmission = preparationRef.current.active
    ? preparationRef.current.voiceSubmission
    : undefined;
  const optimisticMessages = state.optimisticMessages?.[threadId] ?? [];
  const optimisticTurnMessages: OptimisticMessage[] = optimisticMessages.filter(
    (message) => message.destination === "turn",
  );
  let turnMessagesNeedSort = false;
  if (application.isClaude) {
    for (const message of detail?.queuedMessages ?? []) {
      if (message.deliveryMode !== "steer") continue;
      const optimisticIndex = optimisticTurnMessages.findIndex((item) => item.id === message.id);
      if (optimisticIndex !== -1) {
        optimisticTurnMessages[optimisticIndex] = {
          ...optimisticTurnMessages[optimisticIndex]!,
          deliveryError: message.deliveryError,
          serverAccepted: true,
        };
        continue;
      }
      optimisticTurnMessages.push({
        ...message,
        images: message.images ?? [],
        destination: "turn",
        turnId: summary?.currentTurnId ?? null,
        serverAccepted: true,
      });
      turnMessagesNeedSort = true;
    }
  }
  if (turnMessagesNeedSort) optimisticTurnMessages.sort((a, b) => a.createdAt - b.createdAt);
  const optimisticQueuedMessages = optimisticMessages.filter(
    (message) => message.destination === "queue",
  );
  const queuedMessages = preparationRef.current.active
    ? []
    : mergeOptimisticQueue(detail?.queuedMessages ?? [], optimisticQueuedMessages).filter(
        (message) =>
          message.deliveryMode !== "steer" &&
          (!isQuestionReplyDelivery(message) || Boolean(message.deliveryError)),
      );
  const queuedShortcutMessage =
    queueAction === null && queuedMessages[0]?.confirmed && queuedMessages[0].status === "queued"
      ? queuedMessages[0]
      : null;
  const dismissalReferences = [
    ...queuedMessages
      .filter((message) => message.deliveryError?.retryable !== false)
      .map((message) => message.dismissUserInput),
    voiceUpload?.mode !== "draft" ? voiceUpload?.dismissUserInput : undefined,
    activeVoiceJob?.mode !== "draft" && !activeVoiceJob?.error
      ? activeVoiceJob?.dismissUserInput
      : undefined,
    pendingVoiceInputDismissals[threadId],
  ];
  const hiddenAttentionIds = attention
    .filter(
      (request) =>
        request.kind === "userInput" &&
        dismissalReferences.some(
          (reference) =>
            reference && reference.turnId === request.turnId && reference.itemId === request.itemId,
        ),
    )
    .map((request) => request.id);
  const activeMessageFingerprints = new Set<string>();
  const addActiveMessage = (identity: SubmittedMessageIdentity) => {
    activeMessageFingerprints.add(submittedMessageFingerprint(identity));
  };
  for (const message of optimisticMessages) {
    addActiveMessage({
      text: message.text,
      ...pastedText(message),
      images: message.images,
      files: message.files ?? [],
      goal:
        submittedGoalMessageIdsRef.current.has(message.id) ||
        Boolean((message as GoalAwareOptimisticMessage).goal),
    });
  }
  for (const message of detail?.queuedMessages ?? []) {
    addActiveMessage({
      text: message.text,
      ...pastedText(message),
      images: message.images ?? [],
      files: message.files ?? [],
      goal: Boolean(message.goal),
    });
  }
  const activeTurn = summary?.currentTurnId
    ? detail?.turns.find((turn) => turn.id === summary.currentTurnId)
    : null;
  for (const item of activeTurn?.items ?? []) {
    if (item.type !== "userMessage") continue;
    addActiveMessage({
      text: item.text,
      ...pastedText(item),
      images: item.images,
      files: item.files ?? [],
      goal: submittedGoalMessageIdsRef.current.has(item.id),
    });
  }
  if (
    summary?.settings.collaborationMode === "team" &&
    summary.state === "running" &&
    !summary.currentTurnId
  ) {
    const message = latestRootUserMessage(detail);
    if (message?.type === "userMessage") {
      addActiveMessage({
        text: message.text,
        ...pastedText(message),
        images: message.images,
        files: message.files ?? [],
        goal: submittedGoalMessageIdsRef.current.has(message.id),
      });
    }
  }
  activeMessageFingerprintsRef.current = activeMessageFingerprints;
  const latestPlan = useMemo(() => {
    if (isSubagent) return null;
    const plan = findLatestPlan(detail?.turns);
    return summary?.settings.collaborationMode === "plan" ||
      summary?.awaitingPlanResponse ||
      (plan?.ready && summary?.dismissedPlanTurnId === plan.turn.id)
      ? plan
      : null;
  }, [
    detail?.turns,
    isSubagent,
    summary?.settings.collaborationMode,
    summary?.awaitingPlanResponse,
    summary?.dismissedPlanTurnId,
  ]);
  const groupedTurnActivities = useMemo(
    () =>
      new Map(
        (detail?.turns ?? []).map((turn) => {
          const entries = groupActivities(
            activitiesForThreadDisplay(turn.items, isSubagent).filter(
              (item) =>
                !isTechnicalActivity(item) &&
                !(
                  item.type === "error" &&
                  (item.failureKind === "modelCapacity" ||
                    turn.id === summary?.capacityRetry?.failedTurnId)
                ),
            ),
          );
          const completionResponseId =
            turn.status === "completed"
              ? entries
                  .flat()
                  .reverse()
                  .find(
                    (item) =>
                      (item.type === "agentMessage" || item.type === "plan") &&
                      item.status === "completed" &&
                      Boolean(item.text.trim()),
                  )?.id
              : undefined;
          return [turn.id, { entries, completionResponseId }] as const;
        }),
      ),
    [detail?.turns, isSubagent, summary?.capacityRetry?.failedTurnId],
  );
  const loadTurnJournal = useCallback(
    (turnId: string) => loadTurnItems(threadId, turnId),
    [loadTurnItems, threadId],
  );
  const technicalTurnActivities = useMemo(
    () =>
      new Map(
        (detail?.turns ?? []).map(
          (turn) =>
            [
              turn.id,
              isSubagent
                ? []
                : turn.items.filter(
                    (item) =>
                      isTechnicalActivity(item) ||
                      (item.type === "error" &&
                        (item.failureKind === "modelCapacity" ||
                          turn.id === summary?.capacityRetry?.failedTurnId)),
                  ),
            ] as const,
        ),
      ),
    [detail?.turns, isSubagent, summary?.capacityRetry?.failedTurnId],
  );
  const forkFromTurnEvent = useCallback(
    (lastTurnId: string, agentMessageId: string, opener?: HTMLElement) => {
      forkDialogOpenerRef.current = opener ?? null;
      setForkDialogTarget({ lastTurnId, agentMessageId });
    },
    [],
  );
  const completedTurnForkActions = useMemo(() => {
    const actions = new Map<
      string,
      { responseId: string; action: { disabled: boolean; onFork(opener?: HTMLElement): void } }
    >();
    if (isSubagent || !application.capabilities.forks) return actions;
    for (const turn of detail?.turns ?? []) {
      const responseId = findForkResponseId(turn);
      if (!responseId) continue;
      actions.set(turn.id, {
        responseId,
        action: {
          disabled: false,
          onFork: (opener) => forkFromTurnEvent(turn.id, responseId, opener),
        },
      });
    }
    return actions;
  }, [detail?.turns, forkFromTurnEvent, isSubagent]);
  const latestAnnotatableId = useMemo(
    () => findLatestAnnotatable(detail, summary?.currentTurnId ?? null),
    [detail, summary?.currentTurnId],
  );
  const voiceMessageMaterialized = activeVoiceJob
    ? hasMaterializedVoiceMessage(detail, optimisticMessages, activeVoiceJob.id)
    : false;
  const draftVoiceProgress: VoiceProgress | null =
    localActiveVoiceJob?.mode === "draft"
      ? {
          status: localActiveVoiceJob.status as Exclude<VoiceTranscriptionStatus, "failed">,
          elapsedSeconds: transcriptionElapsedSeconds,
          estimatedTotalSeconds: localActiveVoiceJob.estimatedTotalSeconds,
        }
      : voiceUpload?.mode === "draft"
        ? {
            status: "uploading",
            elapsedSeconds: transcriptionElapsedSeconds,
            estimatedTotalSeconds: null,
          }
        : null;
  const autoVoiceProgress: VoiceProgress | null =
    activeVoiceJob && activeVoiceJob.mode !== "draft" && !voiceMessageMaterialized
      ? {
          status: activeVoiceJob.status as Exclude<VoiceTranscriptionStatus, "failed">,
          elapsedSeconds: transcriptionElapsedSeconds,
          estimatedTotalSeconds: activeVoiceJob.estimatedTotalSeconds,
        }
      : voiceUpload && voiceUpload.mode !== "draft"
        ? {
            status: "uploading",
            elapsedSeconds: transcriptionElapsedSeconds,
            estimatedTotalSeconds: null,
          }
        : preparingVoiceSubmission
          ? {
              status: "uploading",
              elapsedSeconds: transcriptionElapsedSeconds,
              estimatedTotalSeconds: null,
            }
          : null;
  const autoVoiceProgressKey = autoVoiceProgress
    ? `${activeVoiceJob?.id ?? `upload:${threadId}`}:${autoVoiceProgress.status}`
    : null;
  const pendingVoiceSendRemoval =
    voiceRemoval?.outcome === "send" && !handledVoiceRemovalsRef.current.has(voiceRemoval.jobId);
  const hideVoiceDraftInComposer =
    (activeVoiceJob !== null && activeVoiceJob.mode !== "draft") ||
    (voiceUpload !== null && voiceUpload.mode !== "draft") ||
    Boolean(preparingVoiceSubmission) ||
    pendingVoiceSendRemoval;
  const activeProgress = summary?.currentTurnId
    ? detail?.turns.find((turn) => turn.id === summary.currentTurnId)?.progress
    : undefined;
  const gitChangesRefreshKey = summary?.currentTurnId
    ? [
        summary.currentTurnId,
        activeProgress?.filesChanged ?? 0,
        activeProgress?.additions ?? 0,
        activeProgress?.deletions ?? 0,
      ].join(":")
    : "idle";

  const downloadFile = useCallback(
    async (path: string) => {
      const ticket = await api.createDownload(threadId, path);
      await openDownloadUrl(api.settings.baseUrl, ticket.downloadUrl);
    },
    [api, threadId],
  );

  const openInspectorArtifact = useCallback(
    (artifact: SessionArtifact, opener: HTMLButtonElement) => {
      if (!artifact.preview) return;
      setInspectorOpen(false);
      setArtifactViewer({ artifact: artifact.preview, opener, returnToInspector: true });
    },
    [],
  );
  const openLinkedArtifact = useCallback<LocalArtifactOpener>((artifact, opener) => {
    setInspectorOpen(false);
    setArtifactViewer({ artifact, opener, returnToInspector: false });
  }, []);
  const closeArtifact = useCallback(() => {
    const returnToInspector = artifactViewerRef.current?.returnToInspector ?? false;
    setArtifactViewer(null);
    if (returnToInspector) {
      setInspectorTab("artifacts");
      setInspectorOpen(true);
    }
  }, []);

  const loadArtifact = useCallback(
    async (artifact: ArtifactDescriptor): Promise<ArtifactLoadResult> => {
      const ticket = await api.createDownload(threadId, artifact.path);
      const fileName = ticket.fileName || artifact.fileName;
      if (typeof ticket.size === "number" && ticket.size > artifact.maxBytes) {
        return { state: "tooLarge", fileName, size: ticket.size };
      }
      const response = await fetch(new URL(ticket.downloadUrl, `${api.settings.baseUrl}/`), {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Artifact download failed with HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      const size = typeof ticket.size === "number" ? ticket.size : data.byteLength;
      if (size > artifact.maxBytes) return { state: "tooLarge", fileName, size };
      return { state: "ready", data, fileName, size };
    },
    [api, threadId],
  );

  const localImageLoadsRef = useRef({ threadId, values: new Map<string, Promise<Blob>>() });
  if (localImageLoadsRef.current.threadId !== threadId) {
    localImageLoadsRef.current = { threadId, values: new Map() };
  }
  const loadLocalImage = useCallback<LocalImageLoader>(
    (path) => {
      const cached = localImageLoadsRef.current.values.get(path);
      if (cached) return cached;
      const request = (async () => {
        const descriptor = artifactDescriptor(path);
        if (descriptor?.kind !== "image") throw new Error("Unsupported local image format");
        const result = await loadArtifact(descriptor);
        if (result.state !== "ready") throw new Error("Local image is too large");
        return new Blob([result.data], { type: localImageMimeType(path) });
      })();
      localImageLoadsRef.current.values.set(path, request);
      void request.catch(() => {
        if (localImageLoadsRef.current.values.get(path) === request) {
          localImageLoadsRef.current.values.delete(path);
        }
      });
      return request;
    },
    [loadArtifact],
  );

  function snapshotPreparation(): NewSessionPreparation {
    const current = preparationRef.current;
    const claimed = earlySubmissionRef.current;
    const claimedDraft = claimed?.draft;
    return {
      ...current,
      value: structuredClone(
        claimed?.staged
          ? composerEditRevisionRef.current === claimed.editRevision
            ? emptyComposerDraft()
            : current.value
          : claimedDraft
            ? composerDraftHasContent(current.value)
              ? mergeComposerDrafts(claimedDraft, current.value)
              : claimedDraft
            : current.value,
      ),
      settings: structuredClone(current.settings),
      submission: earlySubmissionRef.current
        ? structuredClone({
            id: earlySubmissionRef.current.id,
            intent: earlySubmissionRef.current.intent,
            input: earlySubmissionRef.current.input,
            draft: earlySubmissionRef.current.draft,
            staged: earlySubmissionRef.current.staged,
          })
        : current.submission,
    };
  }

  function preparationGenerationActive(generation: number): boolean {
    return (
      preparationAliveRef.current &&
      preparationGenerationRef.current === generation &&
      preparationRef.current.active &&
      !preparationDiscardRef.current
    );
  }

  function assertPreparationGeneration(generation: number): void {
    if (!preparationGenerationActive(generation)) throw PREPARATION_SUPERSEDED;
  }

  function invalidatePreparation(): void {
    preparationAliveRef.current = false;
    preparationGenerationRef.current += 1;
    for (const waiter of attachmentWaitersRef.current) waiter.resolve();
    attachmentWaitersRef.current.clear();
  }

  function enqueuePreparationSave(
    snapshot: NewSessionPreparation,
    keepalive = false,
  ): Promise<boolean> {
    const key = newSessionDraftSaveKey(api.settings, snapshot.projectId);
    const request = (pendingNewSessionDraftSaves.get(key) ?? preparationDraftSaveChainRef.current)
      .catch(() => undefined)
      .then(async () => {
        const persistSubmission = async () => {
          if (!snapshot.submission && !snapshot.voiceSubmission) return true;
          return saveNewSessionDraft(api.settings, snapshot.projectId, snapshot.value, {
            clientCreationId: snapshot.clientCreationId,
            phase: snapshot.phase,
            threadId: snapshot.threadId,
            thread: snapshot.thread,
            revision: snapshot.revision,
            settings: snapshot.settings,
            submission: snapshot.submission,
            voiceSubmission: snapshot.voiceSubmission,
            sharedDraftUpdatedAt: snapshot.sharedDraftUpdatedAt,
            attachments: snapshot.attachments,
          });
        };
        let saved = await persistSubmission();
        if (!saved && preparationAliveRef.current) setStorageWarning(true);
        if (!saved && snapshot.voiceSubmission) return false;
        // Staging clears the local composer, but the shared draft remains until enqueue succeeds.
        if (
          !snapshot.submission?.staged &&
          !snapshot.voiceSubmission &&
          snapshot.sharedBase !== undefined
        ) {
          const value = snapshot.submission?.draft ?? snapshot.value;
          const base = normalizeNewSessionDraft(snapshot.sharedBase ?? emptyComposerDraft());
          if (JSON.stringify(normalizeNewSessionDraft(value)) !== JSON.stringify(base)) {
            const draft = await api.updateProjectDraft(snapshot.projectId, base, value, {
              keepalive,
            });
            snapshot.sharedDraftUpdatedAt = draft.updatedAt;
            snapshot.sharedBase = draft;
            dispatch({ type: "projectDraft", projectId: snapshot.projectId, draft });
            if (
              preparationAliveRef.current &&
              preparationRef.current.projectId === snapshot.projectId
            ) {
              const current = preparationRef.current;
              current.sharedBase = draft;
              current.sharedDraftUpdatedAt = draft.updatedAt;
              if (earlySubmissionRef.current && !earlySubmissionRef.current.staged) {
                earlySubmissionRef.current.draft = mergeProjectDraft(
                  draft,
                  value,
                  earlySubmissionRef.current.draft,
                );
                earlySubmissionRef.current.input = formatAnnotatedMessage(
                  earlySubmissionRef.current.draft.input,
                  earlySubmissionRef.current.draft.annotations,
                  language,
                );
                if (current.submission) {
                  current.submission.draft = earlySubmissionRef.current.draft;
                  current.submission.input = earlySubmissionRef.current.input;
                }
                snapshot.submission = current.submission;
              } else if (!current.submission) {
                current.value = mergeProjectDraft(draft, value, current.value);
                commitComposerDraft({ threadId, value: current.value });
              }
            }
            saved = (await persistSubmission()) && saved;
          }
        }
        return saved;
      });
    const completion = request
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (pendingNewSessionDraftSaves.get(key) === completion)
          pendingNewSessionDraftSaves.delete(key);
      });
    preparationDraftSaveChainRef.current = completion;
    pendingNewSessionDraftSaves.set(key, completion);
    return request;
  }

  function flushPreparation(keepalive = false): Promise<void> {
    if (preparationDraftTimerRef.current !== null) {
      window.clearTimeout(preparationDraftTimerRef.current);
      preparationDraftTimerRef.current = null;
    }
    if (!preparationRef.current.active || !newSessionAdmitted || preparationDiscardRef.current) {
      return preparationDraftSaveChainRef.current;
    }
    return enqueuePreparationSave(snapshotPreparation(), keepalive).then(() => undefined);
  }

  function schedulePreparationDraftSave(): void {
    if (
      !preparationRef.current.active ||
      !newSessionHydrated ||
      !newSessionAdmitted ||
      preparationDiscardRef.current
    ) {
      return;
    }
    if (preparationDraftTimerRef.current !== null) {
      window.clearTimeout(preparationDraftTimerRef.current);
    }
    const timer = window.setTimeout(() => {
      if (preparationDraftTimerRef.current === timer) {
        preparationDraftTimerRef.current = null;
      }
      if (!preparationDiscardRef.current) {
        void enqueuePreparationSave(snapshotPreparation()).catch((caught: unknown) => {
          if (preparationAliveRef.current)
            setError(caught instanceof Error ? caught.message : t("Не удалось сохранить черновик"));
        });
      }
    }, DRAFT_SAVE_DELAY_MS);
    preparationDraftTimerRef.current = timer;
  }

  function setPendingAttachments(pending: boolean, scope = attachmentScopeRef.current): void {
    if (pending) {
      pendingAttachmentScopesRef.current.add(scope);
      return;
    }
    pendingAttachmentScopesRef.current.delete(scope);
    for (const waiter of attachmentWaitersRef.current) {
      if (waiter.scope !== null && pendingAttachmentScopesRef.current.has(waiter.scope)) {
        continue;
      }
      if (waiter.scope === null && pendingAttachmentScopesRef.current.size > 0) continue;
      attachmentWaitersRef.current.delete(waiter);
      waiter.resolve();
    }
  }

  function waitForPendingAttachments(scope: number | null = null): Promise<void> {
    if (
      scope === null
        ? pendingAttachmentScopesRef.current.size === 0
        : !pendingAttachmentScopesRef.current.has(scope)
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => attachmentWaitersRef.current.add({ scope, resolve }));
  }

  function replacePreparationDraft(value: UpdateThreadDraftRequest, updateState = true): void {
    preparationDraftTouchedRef.current = true;
    preparationRef.current = {
      ...preparationRef.current,
      value,
      revision: preparationRef.current.revision + 1,
    };
    const next = { threadId, value };
    if (updateState) commitComposerDraft(next);
    else composerDraftRef.current = next;
  }

  async function ensureCreatedThread(
    activeProject: Project,
    generation: number,
  ): Promise<ThreadSummary> {
    assertPreparationGeneration(generation);
    await preparationHydrationRef.current;
    assertPreparationGeneration(generation);
    const prepared = preparationRef.current.thread;
    if (prepared) return prepared;
    if (!creationPromiseRef.current) {
      const request = (async () => {
        assertPreparationGeneration(generation);
        const existingThreadId = preparationRef.current.threadId;
        let thread = existingThreadId
          ? state.snapshot?.threads.find((candidate) => candidate.id === existingThreadId)
          : undefined;
        if (!thread) {
          if (existingThreadId) {
            const existing = await api.readThread(existingThreadId, { fresh: true });
            thread = existing.summary;
            if (application.isClaude)
              savedDraftUpdatedAtRef.current.set(
                existingThreadId,
                existing.draft?.updatedAt ?? null,
              );
          } else {
            if (!(await enqueuePreparationSave(snapshotPreparation()))) {
              throw new Error(t("Не удалось сохранить черновик на устройстве"));
            }
            assertPreparationGeneration(generation);
            const submittedDraft =
              earlySubmissionRef.current?.draft ?? preparationRef.current.voiceSubmission?.draft;
            const created = await api.createProjectThread(
              activeProject.id,
              preparationRef.current.clientCreationId,
              submittedDraft?.files?.some((file) => file.path)
                ? structuredClone(submittedDraft)
                : undefined,
            );
            assertPreparationGeneration(generation);
            thread = created.thread;
            if (application.isClaude)
              savedDraftUpdatedAtRef.current.set(thread.id, created.draft?.updatedAt ?? null);
            const voice = preparationRef.current.voiceSubmission;
            if (voice) {
              voice.draftUpdatedAt = created.draft?.updatedAt ?? null;
              if (created.draft) {
                voice.draft.files = created.draft.files ?? [];
                preparationRef.current.value.files = created.draft.files ?? [];
              }
            }
            if (created.draft && earlySubmissionRef.current) {
              earlySubmissionRef.current.draft.files = created.draft.files ?? [];
              if (preparationRef.current.submission)
                preparationRef.current.submission.draft.files = created.draft.files ?? [];
            }
          }
          assertPreparationGeneration(generation);
        }
        preparationRef.current = {
          ...preparationRef.current,
          phase: "transferring",
          threadId: thread.id,
          thread,
        };
        await enqueuePreparationSave(snapshotPreparation());
        assertPreparationGeneration(generation);
        return thread;
      })();
      creationPromiseRef.current = request;
      void request.catch(() => {
        if (creationPromiseRef.current === request) creationPromiseRef.current = null;
      });
    }
    const thread = await creationPromiseRef.current;
    assertPreparationGeneration(generation);
    return thread;
  }

  async function applyPendingSettings(
    thread: ThreadSummary,
    generation: number,
  ): Promise<ThreadSummary> {
    assertPreparationGeneration(generation);
    if (settingsApplyPromiseRef.current) {
      await settingsApplyPromiseRef.current;
      assertPreparationGeneration(generation);
      return applyPendingSettings(preparationRef.current.thread ?? thread, generation);
    }
    if (appliedSettingsRevisionRef.current === pendingSettingsRevisionRef.current) {
      return preparationRef.current.thread ?? thread;
    }
    const request = (async () => {
      let configured = preparationRef.current.thread ?? thread;
      while (appliedSettingsRevisionRef.current !== pendingSettingsRevisionRef.current) {
        assertPreparationGeneration(generation);
        const revision = pendingSettingsRevisionRef.current;
        const patch = settingsPatchBetween(
          configured.settings,
          pendingSettingsRef.current,
          pendingSettingsTouchedRef.current,
        );
        if (Object.keys(patch).length > 0) {
          configured = await api.updateThreadSettings(thread.id, patch);
          assertPreparationGeneration(generation);
          preparationRef.current = { ...preparationRef.current, thread: configured };
        }
        appliedSettingsRevisionRef.current = revision;
      }
      return configured;
    })();
    settingsApplyPromiseRef.current = request;
    try {
      return await request;
    } finally {
      if (settingsApplyPromiseRef.current === request) {
        settingsApplyPromiseRef.current = null;
      }
    }
  }

  function activateCreatedThread(
    thread: ThreadSummary,
    draft: ThreadDraft | null,
    generation: number,
  ): boolean {
    if (!preparationGenerationActive(generation)) return false;
    const targetThreadId = thread.id;
    preparationDiscardRef.current = true;
    preparationRef.current = {
      ...preparationRef.current,
      active: false,
      threadId: targetThreadId,
      thread,
    };
    activeThreadIdRef.current = targetThreadId;
    createdInWorkspaceRef.current = targetThreadId;
    skipInitialCreatedDetailRef.current = state.network === "connected" ? targetThreadId : null;
    draftTouchedThreadsRef.current.add(targetThreadId);
    hydratedDraftSourcesRef.current.set(targetThreadId, draft);
    const value = composerDraftRef.current.value;
    const next = { threadId: targetThreadId, value };
    commitComposerDraft(next);
    setCreatedThreadId(targetThreadId);
    if (!preparationAliveRef.current || preparationGenerationRef.current !== generation) {
      return false;
    }
    dispatch({ type: "thread", thread });
    const instanceId = state.snapshot?.instanceId;
    if (instanceId) {
      dispatch({
        type: "detail",
        detail: {
          version: { instanceId, sequence: state.snapshot?.sequence ?? 0 },
          summary: thread,
          turns: [],
          queuedMessages: [],
          olderTurnsCursor: null,
          draft,
        },
      });
    }
    if (!preparationAliveRef.current || preparationGenerationRef.current !== generation) {
      return false;
    }
    navigate(`/threads/${encodeURIComponent(targetThreadId)}`, {
      replace: true,
      state: {
        ...(typeof location.state === "object" && location.state ? location.state : {}),
        focusComposer: true,
        newSessionWorkspaceId: initialNewSessionRef.current.workspaceId,
      },
    });
    return true;
  }

  function currentComposerDraft(
    targetThreadId = activeThreadIdRef.current,
  ): UpdateThreadDraftRequest {
    return composerDraftRef.current.threadId === targetThreadId
      ? composerDraftRef.current.value
      : emptyComposerDraft();
  }

  function commitComposerDraft(next: ComposerDraftState): void {
    composerDraftRef.current = next;
    setComposerDraftState(next);
    setComposerInputSyncRevision((revision) => revision + 1);
  }

  function persistPendingDraft(targetThreadId: string, keepalive = false): Promise<void> {
    if (!pendingDraftsRef.current.has(targetThreadId)) return draftSaveChainRef.current;
    const request = draftSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const pending = pendingDraftsRef.current.get(targetThreadId);
        if (!pending) return;
        try {
          await saveLocalDraft(api.settings, targetThreadId, pending.value, pending.localUpdatedAt);
          if (pendingDraftsRef.current.get(targetThreadId)?.revision !== pending.revision) return;
          const saved = await api.updateThreadDraft(targetThreadId, pending.value, { keepalive });
          if (pendingDraftsRef.current.get(targetThreadId)?.revision !== pending.revision) return;
          pendingDraftsRef.current.delete(targetThreadId);
          await confirmLocalDraft(api.settings, targetThreadId, saved, pending.localUpdatedAt);
          savedDraftUpdatedAtRef.current.set(targetThreadId, saved?.updatedAt ?? null);
          dispatch({ type: "draft", threadId: targetThreadId, draft: saved });
          if (legacyAnnotationThreadsRef.current.delete(targetThreadId)) {
            try {
              savePendingAnnotations(targetThreadId, []);
            } catch {
              // The server copy is authoritative once it has been accepted.
            }
          }
        } catch {
          if (pendingDraftsRef.current.has(targetThreadId) && !draftTimerRef.current) {
            const timer = window.setTimeout(() => {
              if (draftTimerRef.current?.timer === timer) draftTimerRef.current = null;
              void persistPendingDraft(targetThreadId);
            }, 5_000);
            draftTimerRef.current = { threadId: targetThreadId, timer };
          }
        }
      });
    draftSaveChainRef.current = request;
    return request;
  }

  function scheduleDraftSave(
    targetThreadId: string,
    value: UpdateThreadDraftRequest,
    immediate: boolean,
  ): void {
    const revision = ++draftRevisionRef.current;
    const localUpdatedAt = Date.now();
    pendingDraftsRef.current.set(targetThreadId, { revision, value, localUpdatedAt });
    if (draftTimerRef.current) {
      window.clearTimeout(draftTimerRef.current.timer);
      draftTimerRef.current = null;
    }
    if (immediate) {
      void persistPendingDraft(targetThreadId);
      return;
    }
    const timer = window.setTimeout(() => {
      if (draftTimerRef.current?.timer === timer) draftTimerRef.current = null;
      void persistPendingDraft(targetThreadId);
    }, 500);
    draftTimerRef.current = { threadId: targetThreadId, timer };
  }

  function replaceComposerDraft(
    value: UpdateThreadDraftRequest,
    persistence: "debounced" | "immediate" | false,
    updateState = true,
  ): void {
    if (preparationRef.current.active) {
      replacePreparationDraft(value, updateState);
      if (!updateState) schedulePreparationDraftSave();
      return;
    }
    const targetThreadId = activeThreadIdRef.current;
    const next = { threadId: targetThreadId, value };
    if (updateState) commitComposerDraft(next);
    else composerDraftRef.current = next;
    if (!persistence) return;
    draftTouchedThreadsRef.current.add(targetThreadId);
    scheduleDraftSave(targetThreadId, value, persistence === "immediate");
  }

  function setInput(value: string, pastes?: PastedText): void {
    composerEditRevisionRef.current += 1;
    const current = currentComposerDraft();
    const next = pastes ?? rebasePastedText(current.input, value, current);
    replaceComposerDraft(
      { ...current, input: value, inlinePastes: next.inlinePastes, pasteBlocks: next.pasteBlocks },
      "debounced",
      false,
    );
  }

  function setImages(value: ComposerImage[], sourceScope = attachmentScopeRef.current): void {
    if (preparationRef.current.active && earlySubmitRef.current) {
      const submission = earlySubmissionRef.current;
      if (submission && sourceScope === submission.attachmentScope) {
        submission.draft = {
          ...submission.draft,
          images: mergeComposerImages(submission.draft.images, value),
        };
        setPendingOptimisticMessage((message) =>
          message
            ? { ...message, images: submission.draft.images.map((image) => image.url) }
            : message,
        );
        return;
      }
    }
    composerEditRevisionRef.current += 1;
    replaceComposerDraft({ ...currentComposerDraft(), images: value }, "immediate");
  }

  function setFiles(value: ThreadFileAttachment[], sourceScope = attachmentScopeRef.current): void {
    if (preparationRef.current.active && earlySubmitRef.current) {
      const submission = earlySubmissionRef.current;
      if (submission && sourceScope === submission.attachmentScope) {
        submission.draft = {
          ...submission.draft,
          files: mergeComposerFiles(submission.draft.files ?? [], value),
        };
        setPendingOptimisticMessage((message) =>
          message
            ? {
                ...message,
                files: submission.draft.files ?? [],
              }
            : message,
        );
        return;
      }
    }
    composerEditRevisionRef.current += 1;
    replaceComposerDraft({ ...currentComposerDraft(), files: value }, "immediate");
  }

  async function uploadFiles(selected: readonly File[]): Promise<ThreadFileAttachment[]> {
    const targetThreadId = preparationRef.current.threadId || activeThreadIdRef.current;
    if (preparationRef.current.active && !preparationRef.current.threadId) {
      const uploaded: ThreadFileAttachment[] = [];
      for (const file of selected)
        uploaded.push(await api.uploadProjectAttachment(preparationRef.current.projectId, file));
      return uploaded;
    }
    if (!targetThreadId) throw new Error(t("Не удалось создать сессию"));
    const uploaded: ThreadFileAttachment[] = [];
    try {
      for (const file of selected) uploaded.push(await api.uploadAttachment(targetThreadId, file));
      return uploaded;
    } catch (error) {
      await Promise.all(
        uploaded.map((file) =>
          api.deleteAttachment(targetThreadId, file.id).catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  async function deleteFile(file: ThreadFileAttachment): Promise<void> {
    if (preparationRef.current.attachments?.some(({ attachment }) => attachment.id === file.id)) {
      preparationRef.current.attachments = preparationRef.current.attachments.filter(
        ({ attachment }) => attachment.id !== file.id,
      );
      return;
    }
    if (preparationRef.current.active && !preparationRef.current.threadId) return;
    const targetThreadId = preparationRef.current.threadId || activeThreadIdRef.current;
    if (targetThreadId) await api.deleteAttachment(targetThreadId, file.id);
  }

  async function uploadPreparationFiles(targetThreadId: string, generation: number): Promise<void> {
    for (const pending of [...(preparationRef.current.attachments ?? [])]) {
      const used = [
        ...(preparationRef.current.value.files ?? []),
        ...(earlySubmissionRef.current?.draft.files ?? []),
      ].some((file) => file.id === pending.attachment.id);
      if (!used) continue;
      const uploaded = await api.uploadAttachment(
        targetThreadId,
        new File([pending.file], pending.attachment.name, { type: pending.attachment.mediaType }),
      );
      assertPreparationGeneration(generation);
      const replace = (draft: UpdateThreadDraftRequest): UpdateThreadDraftRequest => ({
        ...draft,
        ...(draft.files
          ? {
              files: draft.files.map((file) =>
                file.id === pending.attachment.id ? uploaded : file,
              ),
            }
          : {}),
      });
      preparationRef.current.value = replace(preparationRef.current.value);
      if (earlySubmissionRef.current) {
        earlySubmissionRef.current.draft = replace(earlySubmissionRef.current.draft);
      }
      if (preparationRef.current.submission) {
        preparationRef.current.submission.draft = replace(preparationRef.current.submission.draft);
      }
      commitComposerDraft({
        ...composerDraftRef.current,
        value: replace(composerDraftRef.current.value),
      });
      preparationRef.current.attachments = preparationRef.current.attachments?.filter(
        ({ attachment }) => attachment.id !== pending.attachment.id,
      );
      if (!(await enqueuePreparationSave(snapshotPreparation()))) {
        throw new Error(t("Не удалось сохранить черновик на устройстве"));
      }
      assertPreparationGeneration(generation);
    }
  }

  function setGoalMode(value: boolean): void {
    const current = currentComposerDraft();
    if (current.goalMode === value) return;
    composerEditRevisionRef.current += 1;
    replaceComposerDraft({ ...current, goalMode: value }, "immediate");
  }

  function flushDraft(targetThreadId = threadId, keepalive = false): Promise<void> {
    if (draftTimerRef.current?.threadId === targetThreadId) {
      window.clearTimeout(draftTimerRef.current.timer);
      draftTimerRef.current = null;
    }
    return persistPendingDraft(targetThreadId, keepalive);
  }

  function flushComposerDraft(
    targetThreadId = activeThreadIdRef.current,
    keepalive = false,
  ): Promise<void> {
    return preparationRef.current.active
      ? flushPreparation(keepalive)
      : flushDraft(targetThreadId, keepalive);
  }
  flushComposerDraftRef.current = flushComposerDraft;

  function beginPreparingVoice(recording: ComposerRecording): Promise<void> {
    if (preparationVoiceOperationRef.current) return preparationVoiceOperationRef.current;
    const activeProject = newSessionProject;
    if (!activeProject || !preparationRef.current.active) return Promise.resolve();
    const generation = preparationGenerationRef.current;
    const current = preparationRef.current;
    const submission = (current.voiceSubmission ??= {
      recording,
      draft: structuredClone(currentComposerDraft()),
    });
    delete submission.deliveryError;
    setError(null);
    setVoiceUploads((uploads) => ({ ...uploads, "": { mode: "send", startedAt: Date.now() } }));
    const operation = (async () => {
      try {
        // Own the audio on disk before creating a session or making an upload request.
        if (!(await enqueuePreparationSave(snapshotPreparation()))) {
          throw new Error(t("Не удалось надежно сохранить запись на устройстве"));
        }
        assertPreparationGeneration(generation);
        await waitForPendingAttachments();
        assertPreparationGeneration(generation);
        submission.draft = structuredClone(preparationRef.current.value);
        let thread = await ensureCreatedThread(activeProject, generation);
        thread = await applyPendingSettings(thread, generation);
        await uploadPreparationFiles(thread.id, generation);
        assertPreparationGeneration(generation);
        submission.draft = structuredClone(preparationRef.current.value);
        if (!(await enqueuePreparationSave(snapshotPreparation()))) {
          throw new Error(t("Не удалось надежно сохранить запись на устройстве"));
        }
        assertPreparationGeneration(generation);
        localVoiceJobIdsRef.current.add(submission.recording.id);
        await queueVoiceRecording({
          id: submission.recording.id,
          threadId: thread.id,
          newSessionProjectId: activeProject.id,
          audio: submission.recording.audio,
          durationMs: submission.recording.durationMs,
          mode: "send",
          selectionStart: submission.recording.selection.start,
          selectionEnd: submission.recording.selection.end,
          draftUpdatedAt: submission.draftUpdatedAt ?? null,
          draft: submission.draft,
        });
        // The server owns the recording now; cleanup must never retry an accepted upload.
        const projectDraftBase = preparationRef.current.sharedBase;
        if (preparationGenerationActive(generation)) {
          activateCreatedThread(
            thread,
            { ...submission.draft, updatedAt: submission.draftUpdatedAt ?? Date.now() },
            generation,
          );
        }
        delete current.voiceSubmission;
        delete preparationRef.current.voiceSubmission;
        await deletePreparationPersistence(activeProject.id);
        if (projectDraftBase) {
          void api
            .updateProjectDraft(
              activeProject.id,
              normalizeNewSessionDraft(projectDraftBase),
              emptyComposerDraft(),
              { expectedUpdatedAt: projectDraftBase.updatedAt },
            )
            .then((draft) => dispatch({ type: "projectDraft", projectId: activeProject.id, draft }))
            .catch(() => undefined);
        }
      } catch (caught) {
        if (caught === PREPARATION_SUPERSEDED) return;
        submission.deliveryError = {
          message:
            caught instanceof Error ? caught.message : t("Не удалось отправить запись на сервер"),
          retryable: isRetryableApiError(caught),
        };
        await enqueuePreparationSave(snapshotPreparation()).catch(() => undefined);
        if (preparationGenerationActive(generation)) setError(submission.deliveryError.message);
        throw caught;
      } finally {
        if (preparationAliveRef.current) {
          setVoiceUploads((uploads) => {
            const next = { ...uploads };
            delete next[""];
            return next;
          });
        }
      }
    })();
    preparationVoiceOperationRef.current = operation;
    void operation
      .finally(() => {
        if (preparationVoiceOperationRef.current === operation)
          preparationVoiceOperationRef.current = null;
      })
      .catch(() => undefined);
    return operation;
  }

  async function beginTranscription(
    targetThreadId: string,
    recording: ComposerRecording,
    context?: VoiceRecordingContext,
  ): Promise<void> {
    if (!transcriptionProvider || activeVoiceJob || voiceUploads[targetThreadId]) return;
    const uploadMode =
      context?.mode ??
      resolveVoiceTranscriptionMode(currentTurnIdRef.current, summary?.state === "running");
    if (
      uploadMode !== "draft" &&
      (
        state.snapshot?.threads.find((thread) => thread.id === targetThreadId) ??
        state.details[targetThreadId]?.summary
      )?.canAcceptDirectInput === false
    ) {
      throw new Error(t("Codex временно не принимает сообщения"));
    }
    const dismissUserInput =
      uploadMode !== "draft" ? userInputToDismiss(targetThreadId) : undefined;
    setVoiceUploads((current) => ({
      ...current,
      [targetThreadId]: { mode: uploadMode, startedAt: Date.now(), dismissUserInput },
    }));
    const uploadId = recording.id;
    localVoiceJobIdsRef.current.add(uploadId);
    try {
      const draft = context?.draft ?? structuredClone(currentComposerDraft());
      const expectedDraftUpdatedAt = context
        ? context.draftUpdatedAt
        : savedDraftUpdatedAtRef.current.has(targetThreadId)
          ? savedDraftUpdatedAtRef.current.get(targetThreadId)!
          : (state.details[targetThreadId]?.draft?.updatedAt ?? null);
      await queueVoiceRecording({
        id: uploadId,
        threadId: targetThreadId,
        audio: recording.audio,
        durationMs: recording.durationMs,
        mode: uploadMode,
        ...(dismissUserInput ? { dismissUserInput } : {}),
        selectionStart: recording.selection.start,
        selectionEnd: recording.selection.end,
        draftUpdatedAt: expectedDraftUpdatedAt,
        draft,
      });
    } catch (error) {
      localVoiceJobIdsRef.current.delete(uploadId);
      throw error;
    } finally {
      setVoiceUploads((current) => {
        const next = { ...current };
        delete next[targetThreadId];
        return next;
      });
    }
  }

  async function cancelVoiceTranscription(): Promise<void> {
    if (!voiceJob || voiceCancellationPending) return;
    setVoiceCancellationPending(true);
    setError(null);
    try {
      await api.cancelVoiceTranscription(threadId);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отменить обработку записи"),
      );
    } finally {
      setVoiceCancellationPending(false);
    }
  }

  useLayoutEffect(() => {
    if (!preparationRef.current.active) return;
    const workspaceId =
      typeof (location.state as { newSessionWorkspaceId?: unknown } | null)
        ?.newSessionWorkspaceId === "string"
        ? (
            location.state as {
              newSessionWorkspaceId: string;
            }
          ).newSessionWorkspaceId
        : `direct:${location.search}`;
    if (location.pathname !== "/new" || workspaceId !== initialNewSessionRef.current.workspaceId) {
      invalidatePreparation();
    }
  }, [location.pathname, location.search, location.state]);

  useEffect(() => {
    if (!preparationRef.current.active) return;
    if (!newSessionProject) {
      setNewSessionHydrated(true);
      return;
    }
    let active = true;
    const generation = preparationGenerationRef.current;
    const hydration = (async () => {
      await pendingNewSessionDraftSaves.get(
        newSessionDraftSaveKey(api.settings, newSessionProject.id),
      );
      const remote = await api.readProjectDraft(newSessionProject.id);
      if (!active || !preparationGenerationActive(generation)) return;
      if (preparationRef.current.sharedBase !== undefined) {
        acceptProjectDraft(remote);
        return;
      }
      const local = await loadNewSessionDraft(api.settings, newSessionProject.id);
      const stored = local?.submission || local?.voiceSubmission ? local : null;
      if (!active || !preparationGenerationActive(generation)) return;
      if (!stored && !remote && !initialNewSessionRef.current.admitted) {
        setNewSessionRejected(true);
        setNewSessionHydrated(true);
        return;
      }

      const current = preparationRef.current;
      const value =
        stored && !preparationDraftTouchedRef.current
          ? normalizeNewSessionDraft(stored.value)
          : normalizeNewSessionDraft(remote ?? emptyComposerDraft());
      const settings =
        stored?.settings && pendingSettingsTouchedRef.current.size === 0
          ? clientSessionSettings(stored.settings)
          : current.settings;
      if (stored?.settings && pendingSettingsTouchedRef.current.size === 0) {
        for (const key of [
          "collaborationMode",
          "model",
          "reasoningEffort",
          "serviceTier",
          "personality",
        ] as const) {
          if (pendingSettingsRef.current[key] !== settings[key]) {
            pendingSettingsTouchedRef.current.add(key);
          }
        }
        // A recovered preparation keeps Fast off even if the global default changed.
        if (!application.isClaude) pendingSettingsTouchedRef.current.add("serviceTier");
        pendingSettingsRef.current = settings;
        pendingSettingsRevisionRef.current += 1;
        setPendingSettings(settings);
      }
      const storedThreadId =
        stored?.submission || stored?.voiceSubmission ? (stored.threadId ?? null) : null;
      preparationRef.current = {
        ...current,
        projectId: newSessionProject.id,
        clientCreationId:
          stored?.threadId && !stored.submission && !stored.voiceSubmission
            ? current.clientCreationId
            : (stored?.clientCreationId ?? current.clientCreationId),
        value,
        settings,
        sharedBase: remote,
        sharedDraftUpdatedAt: stored?.sharedDraftUpdatedAt ?? remote?.updatedAt,
        phase: storedThreadId ? "transferring" : "creating",
        threadId: storedThreadId,
        thread: stored?.thread?.id === storedThreadId ? stored.thread : null,
        revision: Math.max(current.revision, stored?.revision ?? 0),
        submission: current.submission ?? stored?.submission,
        voiceSubmission: current.voiceSubmission ?? stored?.voiceSubmission,
        attachments: [...(stored?.attachments ?? []), ...(current.attachments ?? [])],
      };
      if (!preparationDraftTouchedRef.current) {
        const next = { threadId, value };
        commitComposerDraft(next);
        preparationDraftTouchedRef.current =
          (stored?.revision ?? 0) > 0 || composerDraftHasContent(value);
      }
      if (stored?.submission?.staged) {
        setPendingOptimisticMessage({
          id: stored.submission.id,
          threadId: storedThreadId ?? "",
          text: stored.submission.input,
          ...pastedText(trimPastedMessage(stored.submission.draft.input, stored.submission.draft)),
          images: stored.submission.draft.images.map((image) => image.url),
          files: stored.submission.draft.files ?? [],
          createdAt: stored.updatedAt,
          destination: "queue",
          turnId: null,
          deliveryError: stored.submission.deliveryError,
        });
      }
      setNewSessionAdmitted(true);
      await enqueuePreparationSave(snapshotPreparation());
      if (active && preparationGenerationActive(generation)) setNewSessionHydrated(true);
    })();
    preparationHydrationRef.current = hydration;
    void hydration.catch((caught: unknown) => {
      if (active && preparationGenerationActive(generation))
        setError(caught instanceof Error ? caught.message : t("Не удалось загрузить черновик"));
    });
    return () => {
      active = false;
    };
  }, [api.settings, newSessionProject?.id, foregroundEpoch, streamRecoveryEpoch, preparationRetry]);

  useEffect(() => {
    const voice = preparationRef.current.voiceSubmission;
    if (
      preparationRef.current.active &&
      newSessionHydrated &&
      newSessionAdmitted &&
      transcriptionProvider &&
      state.network === "connected" &&
      voice &&
      voice.deliveryError?.retryable !== false &&
      !preparationVoiceOperationRef.current
    ) {
      void beginPreparingVoice(voice.recording).catch(() => undefined);
    }
    // Resume a persisted upload on open/reconnect, or after an explicit retry.
  }, [
    newSessionHydrated,
    newSessionAdmitted,
    transcriptionProvider,
    state.network,
    foregroundEpoch,
    streamRecoveryEpoch,
    preparationRetry,
  ]);

  function acceptProjectDraft(remote: ThreadDraft | null): void {
    const current = preparationRef.current;
    if (
      !current.active ||
      current.submission ||
      current.voiceSubmission ||
      current.sharedBase === undefined
    )
      return;
    if (remote && (current.sharedBase?.updatedAt ?? -1) >= remote.updatedAt) return;
    const value = mergeProjectDraft(
      remote ?? emptyComposerDraft(),
      current.sharedBase ?? emptyComposerDraft(),
      current.value,
    );
    current.sharedBase = remote;
    current.sharedDraftUpdatedAt = remote?.updatedAt;
    current.value = value;
    commitComposerDraft({ threadId, value });
  }

  useEffect(() => {
    const remote = state.projectDrafts?.[newSessionProject?.id ?? ""];
    if (newSessionHydrated && remote) acceptProjectDraft(remote);
  }, [state.projectDrafts, newSessionProject?.id, newSessionHydrated]);

  useEffect(() => {
    schedulePreparationDraftSave();
  }, [composerDraftState, newSessionAdmitted, newSessionHydrated]);

  useEffect(() => {
    if (
      !preparationRef.current.active ||
      !newSessionHydrated ||
      !newSessionAdmitted ||
      !newSessionProject ||
      preparationClaimedForSubmitRef.current ||
      preparationSendRetryRef.current !== null ||
      preparationOperationRef.current ||
      !preparationRef.current.submission
    ) {
      return;
    }
    if (preparationRef.current.submission?.deliveryError?.retryable === false) return;
    setError(null);
    const generation = preparationGenerationRef.current;
    const operation = submitPreparingSession(
      newSessionProject,
      preparationRef.current.submission.intent,
    )
      .catch(async (caught: unknown) => {
        if (caught === PREPARATION_SUPERSEDED) return;
        if (
          caught instanceof ApiClientError &&
          caught.status === 404 &&
          preparationRef.current.threadId &&
          preparationGenerationActive(generation)
        ) {
          preparationRef.current = {
            ...preparationRef.current,
            phase: "creating",
            threadId: null,
            thread: null,
          };
          creationPromiseRef.current = null;
        }
        await flushPreparation();
        if (preparationAliveRef.current && preparationGenerationRef.current === generation) {
          setError(
            caught instanceof Error
              ? (localizeKnownServerText(language, caught.message) ?? caught.message)
              : t("Не удалось создать сессию"),
          );
        }
        throw caught;
      })
      .finally(() => {
        if (preparationOperationRef.current === operation) {
          preparationOperationRef.current = null;
        }
      });
    preparationOperationRef.current = operation;
    void operation.catch(() => undefined);
  }, [newSessionAdmitted, newSessionHydrated, newSessionProject, preparationRetry]);

  useEffect(() => {
    preparationAliveRef.current = true;
    return () => {
      if (!preparationDiscardRef.current && preparationRef.current.active) {
        void flushComposerDraftEvent().catch(() => undefined);
      }
      invalidatePreparation();
      if (preparationSendRetryRef.current !== null)
        window.clearTimeout(preparationSendRetryRef.current);
      if (preparationDiscardRef.current && preparationDraftTimerRef.current !== null) {
        window.clearTimeout(preparationDraftTimerRef.current);
      }
    };
  }, [flushComposerDraftEvent]);

  useEffect(() => {
    const startedAt = activeVoiceJob
      ? activeVoiceJob.status === "queued"
        ? activeVoiceJob.createdAt
        : (activeVoiceJob.startedAt ?? activeVoiceJob.createdAt)
      : voiceUpload?.startedAt;
    if (startedAt === undefined) {
      setTranscriptionElapsedSeconds(0);
      return;
    }
    const updateElapsed = () =>
      setTranscriptionElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [activeVoiceJob, voiceUpload]);

  useEffect(() => {
    if (!voiceRemoval || handledVoiceRemovalsRef.current.has(voiceRemoval.jobId)) {
      return;
    }
    handledVoiceRemovalsRef.current.add(voiceRemoval.jobId);
    localVoiceJobIdsRef.current.delete(voiceRemoval.jobId);
    if (voiceRemoval.outcome === "cancelled") return;
    if (voiceRemoval.outcome === "send") {
      pendingDraftsRef.current.delete(threadId);
      savedDraftUpdatedAtRef.current.set(threadId, null);
      draftTouchedThreadsRef.current.delete(threadId);
      hydratedDraftSourcesRef.current.delete(threadId);
      replaceComposerDraft(emptyComposerDraft(), false);
      dispatch({ type: "draft", threadId, draft: null });
      clearLegacyAnnotations();
      void deleteLocalDraft(api.settings, threadId)
        .catch(() => undefined)
        .then(() => refreshDetail(threadId, { force: true }))
        .catch(() => undefined);
      return;
    }
    draftTouchedThreadsRef.current.delete(threadId);
    hydratedDraftSourcesRef.current.delete(threadId);
    void refreshDetail(threadId, { force: true }).catch(() => undefined);
  }, [api.settings, refreshDetail, threadId, voiceRemoval]);

  useEffect(() => {
    void acknowledgePendingThread(threadId);
    return () => {
      void releaseActiveThread(threadId);
    };
  }, [threadId]);

  useEffect(() => {
    if (goal) setGoalMode(false);
  }, [goal]);

  useEffect(() => {
    if (createdInWorkspaceRef.current !== threadId) {
      draftTouchedThreadsRef.current.delete(threadId);
      hydratedDraftSourcesRef.current.delete(threadId);
    }
    return () => {
      if (threadId) void flushComposerDraftEvent(threadId);
    };
  }, [flushComposerDraftEvent, threadId]);

  useEffect(() => {
    if (isSubagent || !threadId || preparationRef.current.active) return;
    if (draftTouchedThreadsRef.current.has(threadId)) return;
    const detailDraft = detail?.draft ?? null;
    const localAnnotations = loadPendingAnnotations(threadId);
    const serverSource = detailDraft
      ? {
          input: detailDraft.input,
          ...pastedText(detailDraft),
          images: detailDraft.images,
          files: detailDraft.files ?? [],
          goalMode: detailDraft.goalMode,
          annotations: detailDraft.annotations,
        }
      : emptyComposerDraft();
    const mergeLegacyAnnotations = (source: UpdateThreadDraftRequest) => {
      const knownIds = new Set(source.annotations.map((annotation) => annotation.id));
      return {
        ...source,
        annotations: [
          ...source.annotations,
          ...localAnnotations.filter((annotation) => !knownIds.has(annotation.id)),
        ].sort((a, b) => a.createdAt - b.createdAt),
      };
    };
    savedDraftUpdatedAtRef.current.set(threadId, detailDraft?.updatedAt ?? null);
    if (detail && hydratedDraftSourcesRef.current.get(threadId) !== detailDraft) {
      hydratedDraftSourcesRef.current.set(threadId, detailDraft);
      replaceComposerDraft(
        mergeLegacyAnnotations(serverSource),
        localAnnotations.length ? "immediate" : false,
      );
      if (localAnnotations.length) legacyAnnotationThreadsRef.current.add(threadId);
    }
    let active = true;
    void loadLocalDraft(api.settings, threadId).then((localDraft) => {
      if (!active || draftTouchedThreadsRef.current.has(threadId)) return;
      if (!localDraft || localDraft.updatedAt <= (detailDraft?.updatedAt ?? 0)) return;
      replaceComposerDraft(mergeLegacyAnnotations(localDraft.value), "immediate");
    });
    return () => {
      active = false;
    };
  }, [api.settings, detail, isSubagent, threadId]);

  useEffect(() => {
    const flushBeforePageExit = () => {
      void flushComposerDraftEvent(undefined, true).catch(() => undefined);
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushBeforePageExit();
    };
    const stopReloadPreparation = onBeforeAppReload(async () => {
      const revision = composerEditRevisionRef.current;
      await flushComposerDraftEvent();
      await draftSaveChainRef.current;
      await Promise.all(pendingNewSessionDraftSaves.values());
      if (pendingDraftsRef.current.size || composerEditRevisionRef.current !== revision)
        throw new Error("Composer draft is not saved");
    });
    window.addEventListener("pagehide", flushBeforePageExit);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      stopReloadPreparation();
      window.removeEventListener("pagehide", flushBeforePageExit);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [flushComposerDraftEvent]);

  useEffect(() => {
    if (
      !application.capabilities.goal ||
      !threadId ||
      isSubagent ||
      createdInWorkspaceRef.current === threadId
    ) {
      return;
    }
    const request = api.readGoal?.(threadId);
    if (!request) return;
    void request
      .then((value) => dispatch({ type: "goal", threadId, goal: value }))
      .catch(() => undefined);
  }, [api, dispatch, isSubagent, threadId]);

  useEffect(() => {
    const notice = (location.state as { notice?: unknown } | null)?.notice;
    if (typeof notice !== "string" || locationNoticeHandled.current === notice) return;
    locationNoticeHandled.current = notice;
    setError(notice);
  }, [location.state]);

  const loadGitChanges = useCallback(async () => {
    const requestId = ++gitChangesRequest.current;
    setGitChangesState({ threadId, value: null });
    try {
      const value: GitChangesSummary = await api.readGitChanges(threadId);
      if (gitChangesRequest.current === requestId) setGitChangesState({ threadId, value });
    } catch {
      if (gitChangesRequest.current === requestId) {
        setGitChangesState({ threadId, value: "error" });
      }
    }
  }, [api, threadId]);

  useEffect(() => {
    if (!application.capabilities.gitChanges || !inspectorOpen || !threadId) return;
    void loadGitChanges();
    return () => {
      gitChangesRequest.current += 1;
    };
  }, [gitChangesRefreshKey, inspectorOpen, loadGitChanges, threadId]);

  useEffect(() => {
    if (!threadId || createdInWorkspaceRef.current === threadId) return;
    void hydrateCachedDetail(threadId);
  }, [hydrateCachedDetail, threadId]);

  useEffect(() => {
    setThreadMissing(false);
    setDetailLoadError(null);
    if (!threadId || !appActive || state.network !== "connected" || !state.snapshot?.instanceId) {
      return;
    }
    if (skipInitialCreatedDetailRef.current === threadId) {
      skipInitialCreatedDetailRef.current = null;
      return;
    }
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    const retry = () => {
      const delay =
        DETAIL_RETRY_DELAYS_MS[Math.min(attempt, DETAIL_RETRY_DELAYS_MS.length - 1)] ?? 30_000;
      attempt += 1;
      retryTimer = window.setTimeout(load, delay);
    };
    const load = () => {
      void refreshDetail(threadId, { force: true })
        .then((loaded) => {
          if (cancelled) return;
          setDetailLoadError(loaded?.historyError?.message ?? null);
          if (loaded?.historyError?.retryable) retry();
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setDetailLoadError(
            caught instanceof Error ? caught.message : t("Не удалось загрузить историю сессии"),
          );
          if (caught instanceof ApiClientError && caught.status === 404) {
            setThreadMissing(true);
            return;
          }
          if (!isRetryableApiError(caught)) return;
          retry();
        });
    };
    load();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [
    appActive,
    foregroundEpoch,
    refreshDetail,
    state.network,
    state.snapshot?.instanceId,
    streamRecoveryEpoch,
    threadId,
    detailRetry,
  ]);

  useEffect(() => {
    if (!threadId || !summary?.unseen || !appActive || state.network !== "connected") return;
    const key = `${threadId}:${summary.updatedAt}`;
    if (viewedThreadVersionRef.current === key) return;
    viewedThreadVersionRef.current = key;
    void api.markViewed(threadId, { observedUpdatedAt: summary.updatedAt }).catch(() => {
      if (viewedThreadVersionRef.current === key) viewedThreadVersionRef.current = null;
    });
  }, [api, appActive, state.network, summary?.unseen, summary?.updatedAt, threadId]);

  useEffect(() => {
    const latestTurn = detail?.turns.at(-1);
    if (
      !threadId ||
      !summary ||
      summary.currentTurnId ||
      summary.state !== "needsAttention" ||
      summary.settings.collaborationMode !== "plan" ||
      !latestTurn ||
      latestTurn.status === "inProgress" ||
      latestTurn.itemsLoaded !== false
    ) {
      return;
    }
    void loadTurnItems(threadId, latestTurn.id).catch(() => undefined);
  }, [detail?.turns, loadTurnItems, summary, threadId]);

  function pauseTailFollowing() {
    if (searchTarget) return;
    cancelTailCorrection();
    smoothTailScroll.current = false;
    if (!followsTail.current) return;
    const node = scrollRef.current;
    waitingForScrollAway.current = Boolean(
      node && node.scrollHeight - node.scrollTop - node.clientHeight <= TAIL_FOLLOW_THRESHOLD_PX,
    );
    followsTail.current = false;
    setShowScrollToBottom(true);
  }

  function cancelTailCorrection() {
    if (tailCorrectionFrame.current === null) return;
    window.cancelAnimationFrame(tailCorrectionFrame.current);
    tailCorrectionFrame.current = null;
  }

  useLayoutEffect(() => {
    smoothTailScroll.current = false;
    return cancelTailCorrection;
  }, [searchTarget, threadId]);

  const handleComposerLayoutChange = useCallback(() => {
    if (!searchTarget && followsTail.current) scrollToEnd(scrollRef.current);
  }, [searchTarget]);

  useEffect(() => {
    const timeline = scrollRef.current?.querySelector(".timeline");
    if (!timeline || searchTarget || typeof ResizeObserver === "undefined") return;
    // Images can finish loading without a new thread event. Keep following the
    // tail in that case; native scroll anchoring preserves the reader above it.
    const observer = new ResizeObserver(() => {
      if (followsTail.current) scrollToEnd(scrollRef.current);
    });
    observer.observe(timeline);
    return () => observer.disconnect();
  }, [detail?.summary.id, searchTarget, threadId]);

  useLayoutEffect(() => {
    if (searchTarget) return;
    if (initialScrollThread.current === threadId) return;
    initialScrollThread.current = threadId;
    followsTail.current = true;
    setShowScrollToBottom(false);
    if (!detail) return;
    scrollToEnd(scrollRef.current);
  }, [detail, searchTarget, threadId]);

  useLayoutEffect(() => {
    const anchor = olderScrollAnchor.current;
    const node = scrollRef.current;
    if (searchTarget) {
      olderScrollAnchor.current = null;
      return;
    }
    if (!anchor || anchor.threadId !== threadId || !node) return;
    node.scrollTop = anchor.scrollTop + (node.scrollHeight - anchor.scrollHeight);
    olderScrollAnchor.current = null;
  }, [detail, searchTarget, threadId]);

  useLayoutEffect(() => {
    if (searchTarget) return;
    if (!detail || initialScrollThread.current !== threadId || !followsTail.current) return;
    scrollToEnd(scrollRef.current);
  }, [attention, autoVoiceProgressKey, detail, searchTarget, threadId]);

  useLayoutEffect(() => {
    if (searchTarget) return;
    const messageId = scrollTargetMessageId.current;
    const node = scrollRef.current;
    if (!messageId || !node) return;
    const target = [...node.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (candidate) => candidate.dataset.messageId === messageId,
    );
    if (!target) return;
    followsTail.current = true;
    setShowScrollToBottom(false);
    scrollToEnd(node);
    scrollTargetMessageId.current = null;
  }, [detail, optimisticMessages, searchTarget, threadId]);

  const loadOlder = useCallback(async () => {
    const cursor = detail?.olderTurnsCursor;
    const node = scrollRef.current;
    if (searchTarget || isSubagent || !cursor || !node || loadingOlder) return;
    olderScrollAnchor.current = {
      threadId,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    };
    setLoadingOlder(true);
    setOlderError(false);
    try {
      await loadOlderDetail(threadId, cursor);
    } catch {
      olderScrollAnchor.current = null;
      setOlderError(true);
    } finally {
      setLoadingOlder(false);
    }
  }, [detail?.olderTurnsCursor, isSubagent, loadOlderDetail, loadingOlder, searchTarget, threadId]);

  const loadSessionArtifacts = useCallback(async () => {
    if (!application.capabilities.artifacts) return;
    const run = ++artifactRequestRun.current;
    setArtifactLoadState("loading");
    try {
      const response = await api.readThreadArtifacts(threadId);
      if (artifactRequestRun.current === run && activeThreadIdRef.current === threadId) {
        setArtifactShelf({ threadId, response });
        setArtifactLoadState("idle");
      }
    } catch {
      if (artifactRequestRun.current === run && activeThreadIdRef.current === threadId) {
        setArtifactLoadState("error");
      }
    }
  }, [api, threadId]);

  useEffect(() => {
    if (
      !inspectorOpen ||
      inspectorTab !== "artifacts" ||
      artifactResponse ||
      artifactLoadState !== "idle"
    ) {
      return;
    }
    void loadSessionArtifacts();
  }, [artifactLoadState, artifactResponse, inspectorOpen, inspectorTab, loadSessionArtifacts]);

  const previousArtifactTurn = useRef<{
    threadId: string;
    state: ThreadState | undefined;
    turnId: string | null;
  } | null>(null);
  useEffect(() => {
    const previous = previousArtifactTurn.current;
    const current = {
      threadId,
      state: summary?.state,
      turnId: summary?.currentTurnId ?? null,
    };
    previousArtifactTurn.current = current;
    const turnCompleted =
      previous !== null &&
      previous.threadId === threadId &&
      previous.turnId !== null &&
      (previous.state === "queued" ||
        previous.state === "running" ||
        previous.state === "needsAttention") &&
      (current.turnId === null ||
        current.state === "completed" ||
        current.state === "failed" ||
        current.state === "interrupted");
    if (inspectorOpen && inspectorTab === "artifacts" && turnCompleted) {
      void loadSessionArtifacts();
    }
  }, [
    inspectorOpen,
    inspectorTab,
    loadSessionArtifacts,
    summary?.currentTurnId,
    summary?.state,
    threadId,
  ]);

  function persistAnnotations(next: PendingAnnotation[]): boolean {
    composerEditRevisionRef.current += 1;
    replaceComposerDraft(
      { ...currentComposerDraft(), annotations: next, ...(next.length ? { goalMode: false } : {}) },
      "immediate",
    );
    return true;
  }

  function createAnnotation(draft: AnnotationDraft): boolean {
    return persistAnnotations([
      ...annotations,
      {
        ...draft,
        id: createClientMessageId(),
        createdAt: Date.now(),
      },
    ]);
  }

  function updateAnnotation(annotationId: string, comment: string): boolean {
    const next = annotations.map((annotation) =>
      annotation.id === annotationId ? { ...annotation, comment: comment.trim() } : annotation,
    );
    return persistAnnotations(next);
  }

  function deleteAnnotation(annotationId: string): boolean {
    return persistAnnotations(annotations.filter((annotation) => annotation.id !== annotationId));
  }

  function openAnnotation(annotationId: string) {
    if (busy) return;
    const marker = Array.from(
      scrollRef.current?.querySelectorAll<HTMLButtonElement>(
        ".annotation-marker[data-annotation-id]",
      ) ?? [],
    ).find((candidate) => candidate.dataset.annotationId === annotationId);
    if (!marker) {
      setError(t("Исходная цитата не найдена в загруженной истории."));
      return;
    }
    const editors = scrollRef.current?.querySelectorAll<HTMLFormElement>(".annotation-editor");
    if (editors?.length) {
      // Keyboard activation does not trigger the editor's outside-pointer save.
      for (const editor of editors) {
        flushSync(() => editor.requestSubmit());
        if (editor.isConnected) return;
      }
    }
    setError(null);
    pauseTailFollowing();
    marker.scrollIntoView({ block: "center", behavior: "instant" });
    marker.click();
  }

  function clearLegacyAnnotations(targetThreadId = threadId) {
    try {
      savePendingAnnotations(targetThreadId, []);
    } catch {
      // The sent server draft is already authoritative.
    }
    legacyAnnotationThreadsRef.current.delete(targetThreadId);
  }

  function persistDraftAfterAcceptedSend(
    targetThreadId: string,
    value: UpdateThreadDraftRequest,
  ): void {
    draftTouchedThreadsRef.current.add(targetThreadId);
    scheduleDraftSave(targetThreadId, value, true);
  }

  async function cleanupAcceptedDraft(
    targetThreadId: string,
    submittedEditRevision: number,
  ): Promise<void> {
    if (composerEditRevisionRef.current !== submittedEditRevision) {
      persistDraftAfterAcceptedSend(
        targetThreadId,
        structuredClone(composerDraftRef.current.value),
      );
      return;
    }
    try {
      await deleteLocalDraft(api.settings, targetThreadId);
    } catch {
      // Delivery is authoritative; local cleanup is best-effort.
    }
    if (composerEditRevisionRef.current !== submittedEditRevision) {
      persistDraftAfterAcceptedSend(
        targetThreadId,
        structuredClone(composerDraftRef.current.value),
      );
      return;
    }
    pendingDraftsRef.current.delete(targetThreadId);
    savedDraftUpdatedAtRef.current.set(targetThreadId, null);
    dispatch({ type: "draft", threadId: targetThreadId, draft: null });
    clearLegacyAnnotations(targetThreadId);
  }

  async function preserveAcceptedDraft(
    targetThreadId: string,
    value: UpdateThreadDraftRequest,
    expectedEditRevision = composerEditRevisionRef.current,
  ): Promise<boolean> {
    let savedLocally = false;
    try {
      savedLocally =
        (await saveLocalDraft(api.settings, targetThreadId, value, Date.now())) !== null;
    } catch {
      // The debounced server persistence below will keep retrying.
    }
    if (composerEditRevisionRef.current !== expectedEditRevision) {
      persistDraftAfterAcceptedSend(
        targetThreadId,
        structuredClone(composerDraftRef.current.value),
      );
      return savedLocally;
    }
    persistDraftAfterAcceptedSend(targetThreadId, value);
    return savedLocally;
  }

  async function deletePreparationPersistence(projectId: string): Promise<void> {
    try {
      await preparationDraftSaveChainRef.current.catch(() => undefined);
      await deleteNewSessionDraft(api.settings, projectId);
    } catch {
      // The created thread and its local draft are already authoritative.
    }
  }

  function claimSubmittedMessage(
    identity: SubmittedMessageIdentity,
    messageId: string,
  ): string | null {
    const key = submittedMessageFingerprint(identity);
    if (activeMessageFingerprintsRef.current.has(key) || messageClaimsRef.current.has(key)) {
      setError(t("Это сообщение уже отправлено"));
      return null;
    }
    messageClaimsRef.current.add(key);
    if (identity.goal) submittedGoalMessageIdsRef.current.add(messageId);
    return key;
  }

  function moveSubmittedMessageClaim(
    currentKey: string,
    identity: SubmittedMessageIdentity,
  ): string {
    const nextKey = submittedMessageFingerprint(identity);
    if (nextKey === currentKey) return currentKey;
    messageClaimsRef.current.delete(currentKey);
    messageClaimsRef.current.add(nextKey);
    return nextKey;
  }

  function releaseSubmittedMessageClaim(key: string, messageId?: string): void {
    messageClaimsRef.current.delete(key);
    if (messageId) submittedGoalMessageIdsRef.current.delete(messageId);
  }

  async function submit(intent: ComposerSubmitIntent) {
    if (inputUnavailable) return;
    if (preparationRef.current.active && newSessionProject) {
      await submitPreparingSession(newSessionProject, intent);
      return;
    }
    const targetThreadId = activeThreadIdRef.current;
    if (!targetThreadId) {
      setError(t("Не удалось отправить сообщение"));
      return;
    }
    const submittedDraft = structuredClone(currentComposerDraft(targetThreadId));
    const submittedInput = formatAnnotatedMessage(
      submittedDraft.input,
      submittedDraft.annotations,
      language,
    );
    if (
      (!submittedInput.trim() &&
        !submittedDraft.images.length &&
        !submittedDraft.files?.length &&
        !submittedDraft.pasteBlocks?.length) ||
      (submittedDraft.goalMode && !submittedDraft.input.trim())
    ) {
      return;
    }
    const submittedEditRevision = composerEditRevisionRef.current;
    const clientMessageId = createClientMessageId();
    const dismissUserInput = userInputToDismiss(targetThreadId);
    const steering = application.isClaude && intent === "immediate";
    const steerTurnId = steering ? currentTurnIdRef.current : null;
    const submittedIdentity: SubmittedMessageIdentity = {
      text: submittedInput,
      ...pastedText(trimPastedMessage(submittedDraft.input, submittedDraft)),
      images: submittedDraft.images.map((image) => image.url),
      files: submittedDraft.files ?? [],
      goal: submittedDraft.goalMode,
    };
    const messageClaimKey = claimSubmittedMessage(submittedIdentity, clientMessageId);
    if (!messageClaimKey) return;
    const optimisticMessage: GoalAwareOptimisticMessage = {
      id: clientMessageId,
      threadId: targetThreadId,
      text: submittedInput.trim(),
      ...pastedText(trimPastedMessage(submittedDraft.input, submittedDraft)),
      images: [...submittedIdentity.images],
      files: submittedDraft.files ?? [],
      goal: submittedIdentity.goal,
      createdAt: Date.now(),
      destination: steering ? "turn" : "queue",
      turnId: steerTurnId,
      ...(dismissUserInput ? { dismissUserInput } : {}),
    };
    let deliveryCommitted = false;
    const commitDelivery = () => {
      if (deliveryCommitted) return;
      deliveryCommitted = true;
      dispatch({ type: "optimistic.add", message: optimisticMessage });
      if (composerEditRevisionRef.current === submittedEditRevision) {
        replaceComposerDraft(emptyComposerDraft(), false);
      }
      setBusy(false);
    };
    setBusy(true);
    setError(null);
    scrollTargetMessageId.current = clientMessageId;
    try {
      await flushComposerDraftEvent(targetThreadId);
      const delivery = await sendReliable(
        targetThreadId,
        {
          input: submittedInput,
          ...(application.isClaude
            ? {
                deliveryMode: steering ? "steer" : "queue",
                draftUpdatedAt: savedDraftUpdatedAtRef.current.get(targetThreadId) ?? null,
              }
            : {}),
          ...pastedText(trimPastedMessage(submittedDraft.input, submittedDraft)),
          ...(submittedDraft.images.length
            ? { images: submittedDraft.images.map((image) => image.url) }
            : {}),
          ...(submittedDraft.files?.length ? { files: submittedDraft.files } : {}),
          ...(submittedDraft.goalMode ? { goal: true } : {}),
          clientMessageId,
          ...(dismissUserInput ? { dismissUserInput } : {}),
        },
        commitDelivery,
        { draft: submittedDraft },
      );
      commitDelivery();
      releaseSubmittedMessageClaim(messageClaimKey);
      if (intent === "immediate" && !steering && delivery === "delivered") {
        try {
          await api.sendQueuedNow(targetThreadId, clientMessageId);
        } catch {
          setError(t("Не удалось отправить сразу — сообщение осталось в очереди"));
        }
      }
    } catch (caught) {
      releaseSubmittedMessageClaim(messageClaimKey, clientMessageId);
      if (deliveryCommitted) {
        dispatch({
          type: "optimistic.remove",
          threadId: targetThreadId,
          messageId: clientMessageId,
        });
      }
      const restore = !deliveryCommitted
        ? structuredClone(currentComposerDraft(targetThreadId))
        : composerEditRevisionRef.current === submittedEditRevision
          ? submittedDraft
          : mergeComposerDrafts(submittedDraft, currentComposerDraft(targetThreadId));
      replaceComposerDraft(restore, "immediate");
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отправить сообщение"),
      );
      setBusy(false);
      return;
    }
    try {
      await cleanupAcceptedDraft(targetThreadId, submittedEditRevision);
    } finally {
      setBusy(false);
    }
  }

  async function stopTask(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.interrupt(threadId, workspaceSummary.currentTurnId ?? undefined);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось остановить задачу"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitPreparingSession(
    activeProject: Project,
    intent: ComposerSubmitIntent,
  ): Promise<void> {
    const generation = preparationGenerationRef.current;
    assertPreparationGeneration(generation);
    if (preparationClaimedForSubmitRef.current) {
      setError(t("Это сообщение уже отправлено"));
      return;
    }
    const recoveredSubmission = preparationRef.current.submission;
    const submittedDraft = structuredClone(
      recoveredSubmission?.draft ?? preparationRef.current.value,
    );
    const submittedInput =
      recoveredSubmission?.input ??
      formatAnnotatedMessage(submittedDraft.input, submittedDraft.annotations, language);
    if (
      (!submittedInput.trim() &&
        !submittedDraft.images.length &&
        !submittedDraft.files?.length &&
        !submittedDraft.pasteBlocks?.length &&
        !pendingAttachmentScopesRef.current.has(attachmentScopeRef.current)) ||
      (submittedDraft.goalMode && !submittedDraft.input.trim())
    ) {
      return;
    }
    const clientMessageId = recoveredSubmission?.id ?? createClientMessageId();
    let messageClaimKey = claimSubmittedMessage(
      {
        text: submittedInput,
        ...pastedText(trimPastedMessage(submittedDraft.input, submittedDraft)),
        images: submittedDraft.images.map((image) => image.url),
        files: submittedDraft.files ?? [],
        goal: submittedDraft.goalMode,
      },
      clientMessageId,
    );
    if (!messageClaimKey) return;
    if (preparationSendRetryRef.current !== null) {
      window.clearTimeout(preparationSendRetryRef.current);
      preparationSendRetryRef.current = null;
    }
    earlySubmitRef.current = true;
    preparationClaimedForSubmitRef.current = true;
    setBusy(true);
    setError(null);
    const submittedAttachmentScope = attachmentScopeRef.current;
    attachmentScopeRef.current += 1;
    setAttachmentScope(attachmentScopeRef.current);
    earlySubmissionRef.current = {
      id: clientMessageId,
      intent,
      input: submittedInput,
      attachmentScope: submittedAttachmentScope,
      claimedRevision: preparationRef.current.revision,
      draft: submittedDraft,
      editRevision:
        recoveredSubmission &&
        JSON.stringify(submittedDraft) !== JSON.stringify(preparationRef.current.value)
          ? -1
          : composerEditRevisionRef.current,
      staged: recoveredSubmission?.staged,
    };
    preparationRef.current.submission = {
      id: clientMessageId,
      intent,
      input: submittedInput,
      draft: submittedDraft,
    };
    // Persist the submission identity before any asynchronous creation or navigation.
    const preparationFlush = flushComposerDraftEvent();

    let activatedThreadId: string | null = null;
    let accepted = false;
    let deliveryCommitted = false;
    let stagedInPreparation = recoveredSubmission?.staged === true;
    try {
      await preparationFlush;
      await waitForPendingAttachments(submittedAttachmentScope);
      assertPreparationGeneration(generation);
      const submission = earlySubmissionRef.current;
      let completeDraft = structuredClone(submission?.draft ?? submittedDraft);
      const completeInput = submission?.input ?? submittedInput;
      preparationRef.current.submission = {
        id: clientMessageId,
        intent,
        input: completeInput,
        draft: completeDraft,
      };
      if (submission) submission.staged = true;
      const staged = await enqueuePreparationSave(snapshotPreparation());
      assertPreparationGeneration(generation);
      if (staged) {
        stagedInPreparation = true;
        preparationRef.current.submission.staged = true;
        setPendingOptimisticMessage({
          id: clientMessageId,
          threadId: preparationRef.current.threadId ?? "",
          text: completeInput,
          ...pastedText(trimPastedMessage(completeDraft.input, completeDraft)),
          images: completeDraft.images.map((image) => image.url),
          files: completeDraft.files ?? [],
          createdAt: Date.now(),
          destination: "queue",
          turnId: null,
        });
        if (submission && composerEditRevisionRef.current === submission.editRevision) {
          const value = emptyComposerDraft();
          preparationRef.current.value = value;
          commitComposerDraft({ threadId, value });
        }
      } else if (submission) submission.staged = stagedInPreparation;
      let thread = await ensureCreatedThread(activeProject, generation);
      assertPreparationGeneration(generation);
      thread = await applyPendingSettings(thread, generation);
      assertPreparationGeneration(generation);
      preparationRef.current = { ...preparationRef.current, thread };
      await uploadPreparationFiles(thread.id, generation);
      completeDraft = structuredClone(earlySubmissionRef.current?.draft ?? completeDraft);
      const completeIdentity: SubmittedMessageIdentity = {
        text: completeInput,
        ...pastedText(trimPastedMessage(completeDraft.input, completeDraft)),
        images: completeDraft.images.map((image) => image.url),
        files: completeDraft.files ?? [],
        goal: completeDraft.goalMode,
      };
      messageClaimKey = moveSubmittedMessageClaim(messageClaimKey, completeIdentity);
      const optimisticMessage: GoalAwareOptimisticMessage = {
        id: clientMessageId,
        threadId: thread.id,
        text: completeInput.trim(),
        ...pastedText(trimPastedMessage(completeDraft.input, completeDraft)),
        images: [...completeIdentity.images],
        files: completeDraft.files ?? [],
        goal: completeIdentity.goal,
        createdAt: Date.now(),
        destination: "queue",
        turnId: null,
      };
      assertPreparationGeneration(generation);
      const commitDelivery = () => {
        if (deliveryCommitted) return;
        deliveryCommitted = true;
        if (!preparationGenerationActive(generation)) return;
        // The URL handoff is safe only once either the outbox or the server owns the message.
        if (!activateCreatedThread(thread, null, generation)) return;
        activatedThreadId = thread.id;
        dispatch({ type: "optimistic.add", message: optimisticMessage });
        setPendingOptimisticMessage(null);
        setBusy(false);
        const claimed = earlySubmissionRef.current;
        if (
          claimed &&
          composerEditRevisionRef.current === claimed.editRevision &&
          preparationRef.current.revision === claimed.claimedRevision
        ) {
          replaceComposerDraft(emptyComposerDraft(), false);
        }
      };
      // Include edits made while creation/settings were pending in the atomic
      // preparation -> outbox transfer, before the URL changes to the real thread.
      await flushPreparation();
      assertPreparationGeneration(generation);
      const delivery = await sendReliable(
        thread.id,
        {
          input: completeInput,
          ...(application.isClaude
            ? { draftUpdatedAt: savedDraftUpdatedAtRef.current.get(thread.id) ?? null }
            : {}),
          ...pastedText(trimPastedMessage(completeDraft.input, completeDraft)),
          ...(completeDraft.images.length
            ? { images: completeDraft.images.map((image) => image.url) }
            : {}),
          ...(completeDraft.files?.length ? { files: completeDraft.files } : {}),
          ...(completeDraft.goalMode ? { goal: true } : {}),
          clientMessageId,
          ...(preparationRef.current.sharedDraftUpdatedAt !== undefined
            ? {
                projectDraft: {
                  projectId: activeProject.id,
                  updatedAt: preparationRef.current.sharedDraftUpdatedAt,
                },
              }
            : {}),
        },
        commitDelivery,
        { draft: completeDraft, projectId: activeProject.id },
      );
      commitDelivery();
      accepted = true;
      preparationSendAttemptsRef.current = 0;
      delete preparationRef.current.submission;
      releaseSubmittedMessageClaim(messageClaimKey);
      if (!preparationAliveRef.current || preparationGenerationRef.current !== generation) return;
      if (intent === "immediate" && delivery === "delivered") {
        try {
          await api.sendQueuedNow(thread.id, clientMessageId);
        } catch {
          setError(t("Не удалось отправить сразу — сообщение осталось в очереди"));
        }
      }
      await waitForPendingAttachments();
      const settledSubmission = earlySubmissionRef.current;
      const submittedEditRevision =
        settledSubmission?.editRevision ?? composerEditRevisionRef.current;
      const hasNewerDraft =
        composerEditRevisionRef.current !== submittedEditRevision ||
        (settledSubmission !== null &&
          preparationRef.current.revision !== settledSubmission.claimedRevision);
      const remainingDraft = structuredClone(composerDraftRef.current.value);
      const remainingEditRevision = composerEditRevisionRef.current;
      earlySubmissionRef.current = null;
      earlySubmitRef.current = false;
      let newerDraftStored = true;
      if (hasNewerDraft) {
        newerDraftStored = await preserveAcceptedDraft(
          thread.id,
          remainingDraft,
          remainingEditRevision,
        );
      } else {
        await cleanupAcceptedDraft(thread.id, submittedEditRevision);
      }
      if (!hasNewerDraft || newerDraftStored) {
        await deletePreparationPersistence(activeProject.id);
      }
    } catch (caught) {
      if (accepted) return;
      releaseSubmittedMessageClaim(messageClaimKey, clientMessageId);
      if (caught === PREPARATION_SUPERSEDED) return;
      await waitForPendingAttachments();
      const targetThreadId = activatedThreadId ?? preparationRef.current.threadId;
      if (activatedThreadId && deliveryCommitted) {
        dispatch({
          type: "optimistic.remove",
          threadId: activatedThreadId,
          messageId: clientMessageId,
        });
      }
      if (!stagedInPreparation) setPendingOptimisticMessage(null);
      const submission = earlySubmissionRef.current;
      const submitted = submission?.draft ?? submittedDraft;
      const hasNewerDraft =
        composerEditRevisionRef.current !==
          (submission?.editRevision ?? composerEditRevisionRef.current) ||
        (submission !== null && preparationRef.current.revision !== submission.claimedRevision);
      const current = structuredClone(composerDraftRef.current.value);
      const restore = !deliveryCommitted
        ? current
        : hasNewerDraft
          ? mergeComposerDrafts(submitted, current)
          : submitted;
      const retryable = isRetryableApiError(caught);
      if (!retryable && !stagedInPreparation) delete preparationRef.current.submission;
      else if (submission) {
        preparationRef.current.submission = {
          id: clientMessageId,
          intent,
          input: submittedInput,
          draft: structuredClone(submission.draft),
          staged: stagedInPreparation,
          deliveryError: {
            message: retryable
              ? caught instanceof ApiClientError && caught.code === "connection_failed"
                ? t("Нет связи — повторим отправку")
                : t("Сервер временно недоступен — повторим отправку")
              : caught instanceof Error
                ? caught.message
                : t("Не удалось отправить сообщение"),
            retryable,
          },
        };
      }
      if (stagedInPreparation)
        setPendingOptimisticMessage((message) =>
          message
            ? {
                ...message,
                deliveryError: preparationRef.current.submission?.deliveryError,
              }
            : null,
        );
      earlySubmissionRef.current = null;
      earlySubmitRef.current = false;
      if (!activatedThreadId) preparationClaimedForSubmitRef.current = false;
      if (activatedThreadId) {
        const restored = { threadId: activatedThreadId, value: restore };
        commitComposerDraft(restored);
        draftTouchedThreadsRef.current.add(activatedThreadId);
        const savedLocally = await preserveAcceptedDraft(activatedThreadId, restore);
        if (savedLocally) await deletePreparationPersistence(activeProject.id);
      } else {
        replacePreparationDraft(restore);
        await flushPreparation();
        if (retryable && preparationGenerationActive(generation)) {
          const attempt = preparationSendAttemptsRef.current++;
          const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
          preparationSendRetryRef.current = window.setTimeout(() => {
            preparationSendRetryRef.current = null;
            if (preparationGenerationActive(generation)) {
              setPreparationRetry((value) => value + 1);
            }
          }, delay);
        }
      }
      if (!targetThreadId) creationPromiseRef.current = null;
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось отправить сообщение"),
      );
    } finally {
      if (preparationAliveRef.current && preparationGenerationRef.current === generation) {
        setBusy(false);
      }
    }
  }

  async function implementPlan(targetMode: "default" | "goal" | "team") {
    const goalMode = targetMode === "goal";
    const implementationMessage =
      targetMode === "team"
        ? t("Да, реализуй этот план в режиме оркестратора")
        : goalMode
          ? t("Да, реализуй этот план в режиме цели")
          : t("Да, реализуй этот план");
    if (planAcceptanceInFlightRef.current) {
      setError(t("Это сообщение уже отправлено"));
      return;
    }
    if (planAcceptanceDisabled || planDismissalInFlightRef.current) return;
    const clientMessageId = createClientMessageId();
    const messageClaimKey = claimSubmittedMessage(
      { text: implementationMessage, images: [], files: [], goal: goalMode },
      clientMessageId,
    );
    if (!messageClaimKey) return;
    planAcceptanceInFlightRef.current = true;
    setBusy(true);
    setError(null);
    setTeamUpgradeRequired(false);
    try {
      scrollTargetMessageId.current = clientMessageId;
      await sendReliable(
        threadId,
        {
          input: implementationMessage,
          clientMessageId,
          planImplementationMode: targetMode,
          ...(goalMode ? { goal: true } : {}),
        },
        () => {
          dispatch({
            type: "optimistic.add",
            message: {
              id: clientMessageId,
              threadId,
              text: implementationMessage,
              images: [],
              ...(goalMode ? { goal: true } : {}),
              createdAt: Date.now(),
              destination: "queue",
              turnId: null,
            },
          });
        },
      );
      releaseSubmittedMessageClaim(messageClaimKey);
    } catch (caught) {
      releaseSubmittedMessageClaim(messageClaimKey, clientMessageId);
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : targetMode === "team"
            ? t("Не удалось начать реализацию плана в режиме оркестратора")
            : goalMode
              ? t("Не удалось начать реализацию плана в режиме цели")
              : t("Не удалось начать реализацию плана"),
      );
    } finally {
      planAcceptanceInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function dismissPlan() {
    if (
      planDismissalDisabled ||
      !latestPlan ||
      planDismissalInFlightRef.current ||
      planAcceptanceInFlightRef.current
    )
      return;
    planDismissalInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const thread = await api.dismissPlan(threadId, {
        turnId: latestPlan.turn.id,
        observedUpdatedAt: summary!.updatedAt,
      });
      dispatch({ type: "thread", thread });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отказаться от плана"),
      );
    } finally {
      planDismissalInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function sendQueuedNow(messageId: string): Promise<boolean> {
    if (inputUnavailable || settingsBusy) return false;
    setQueueAction({ messageId, kind: "send" });
    setError(null);
    try {
      await flushComposerDraftEvent(threadId);
      const editRevision = composerEditRevisionRef.current;
      const message = queuedMessages.find((item) => item.id === messageId);
      const retryUnconfirmed = message?.status === "dispatching" && Boolean(message.deliveryError);
      const result = await (retryUnconfirmed
        ? api.sendQueuedNow(threadId, messageId, true)
        : api.sendQueuedNow(threadId, messageId));
      if (result?.thread && result.thread.id !== threadId) {
        dispatch({ type: "thread", thread: result.thread });
        if (preparationAliveRef.current && activeThreadIdRef.current === threadId) {
          if (composerEditRevisionRef.current !== editRevision) {
            persistDraftAfterAcceptedSend(
              result.thread.id,
              structuredClone(currentComposerDraft()),
            );
          }
          navigate(`/threads/${encodeURIComponent(result.thread.id)}`, {
            state: { focusComposer: true },
          });
        }
      }
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отправить сообщение"),
      );
      return false;
    } finally {
      setQueueAction(null);
    }
  }

  async function updateQueued(
    messageId: string,
    value: string,
    pastes?: PastedText,
  ): Promise<boolean> {
    setQueueAction({ messageId, kind: "update" });
    setError(null);
    try {
      await api.updateQueued(threadId, messageId, { input: value, ...pastes });
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось изменить сообщение в очереди"),
      );
      return false;
    } finally {
      setQueueAction(null);
    }
  }

  async function deleteQueued(messageId: string): Promise<boolean> {
    setQueueAction({ messageId, kind: "delete" });
    setError(null);
    try {
      await api.deleteQueued(threadId, messageId);
      await forgetReliableMessage(threadId, messageId);
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось удалить сообщение из очереди"),
      );
      return false;
    } finally {
      setQueueAction(null);
    }
  }

  async function finishThread() {
    setFinishing(true);
    setError(null);
    try {
      await api.markRead(threadId, { observedUpdatedAt: summary!.updatedAt });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось закончить сессию"),
      );
    } finally {
      setFinishing(false);
    }
  }

  async function forceRefreshSession() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await forceRefreshDetail(threadId);
      if (application.capabilities.gitChanges && inspectorOpen) await loadGitChanges();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 404) {
        setThreadMissing(true);
      } else {
        setError(
          caught instanceof Error
            ? localizeKnownServerText(language, caught.message)
            : t("Не удалось обновить сессию"),
        );
      }
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleBrowserAccess() {
    if (
      browserUpdating ||
      !summary ||
      summary.currentTurnId ||
      summary.state === "running" ||
      summary.state === "queued" ||
      summary.state === "needsAttention"
    ) {
      return;
    }
    setBrowserUpdating(true);
    setError(null);
    try {
      const thread = await api.updateThread(threadId, {
        browserEnabled: summary.browserStatus === "disabled",
      });
      dispatch({ type: "thread", thread });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось изменить доступ браузера"),
      );
    } finally {
      setBrowserUpdating(false);
    }
  }

  async function togglePin(menu: HTMLDetailsElement | null) {
    if (pinUpdating || !summary) return;
    setPinUpdating(true);
    setError(null);
    try {
      const thread = await api.updateThread(threadId, { pinned: !summary.pinned });
      dispatch({ type: "thread", thread });
      menu?.removeAttribute("open");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось изменить закрепление сессии"),
      );
    } finally {
      setPinUpdating(false);
    }
  }
  const toggleArchive = () => void api.archive(threadId, !summary!.archived);

  async function updateSettings(patch: UpdateThreadSettingsRequest) {
    patch = clientSessionSettingsPatch(patch);
    if (Object.keys(patch).length === 0) return;
    if (preparationRef.current.active) {
      const next = applySessionSettingsPatch(pendingSettingsRef.current, patch);
      for (const key of [
        "collaborationMode",
        "model",
        "reasoningEffort",
        "serviceTier",
        "personality",
      ] as const) {
        if (patch[key] !== undefined) pendingSettingsTouchedRef.current.add(key);
      }
      pendingSettingsRef.current = next;
      pendingSettingsRevisionRef.current += 1;
      preparationRef.current = { ...preparationRef.current, settings: next };
      setPendingSettings(next);
      return;
    }
    setSettingsBusy(true);
    setError(null);
    setTeamUpgradeRequired(false);
    try {
      const thread = await api.updateThreadSettings(threadId, patch);
      dispatch({ type: "thread", thread });
      if (patch.collaborationMode !== undefined && patch.collaborationMode !== "default") {
        setGoalMode(false);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      if (patch.collaborationMode === "team" && message.includes("managed Team tools")) {
        setTeamUpgradeRequired(true);
      }
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось изменить настройки"),
      );
    } finally {
      setSettingsBusy(false);
    }
  }

  async function createManagedTeamSession() {
    if (!project) return;
    setSettingsBusy(true);
    setError(null);
    try {
      const created = await api.createProjectThread(project.id, `team-upgrade:${threadId}`);
      dispatch({ type: "thread", thread: created.thread });
      const configured = await api.updateThreadSettings(created.thread.id, {
        collaborationMode: "team",
      });
      dispatch({ type: "thread", thread: configured });
      setTeamUpgradeRequired(false);
      navigate(`/threads/${encodeURIComponent(configured.id)}`, {
        state: { focusComposer: true },
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось создать Team-сессию"),
      );
    } finally {
      setSettingsBusy(false);
    }
  }

  async function updateGoal(patch: UpdateThreadGoalRequest) {
    setGoalBusy(true);
    setError(null);
    try {
      const updated = await api.updateGoal(threadId, patch);
      dispatch({ type: "goal", threadId, goal: updated });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось изменить цель"),
      );
    } finally {
      setGoalBusy(false);
    }
  }

  async function clearGoal() {
    setGoalBusy(true);
    setError(null);
    try {
      await api.clearGoal(threadId);
      dispatch({ type: "goal", threadId, goal: null });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось очистить цель"),
      );
    } finally {
      setGoalBusy(false);
    }
  }

  useLayoutEffect(() => {
    annotationActionsRef.current = {
      create: createAnnotation,
      update: updateAnnotation,
      delete: deleteAnnotation,
    };
  });

  if (
    initialNewSessionRef.current.active &&
    (newSessionRejected || (newSessionHydrated && !newSessionProject))
  ) {
    return <Navigate to="/" replace />;
  }
  if (preparationRef.current.active && !newSessionHydrated)
    return (
      <div className="center-state" role="status">
        {error ? (
          <>
            <p>{error}</p>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setPreparationRetry((value) => value + 1);
              }}
            >
              {t("Повторить")}
            </button>
          </>
        ) : (
          <p>{t("Загрузка…")}</p>
        )}
      </div>
    );
  if (preparationRef.current.active && !newSessionAdmitted) return null;
  if (!summary && !preparationRef.current.active && !preparationRef.current.thread)
    return (
      <div className="center-state">
        {threadMissing || detailLoadError ? (
          <>
            <h2>
              {threadMissing ? t("Задача не найдена") : t("Не удалось загрузить историю сессии")}
            </h2>
            <button type="button" onClick={() => setDetailRetry((value) => value + 1)}>
              {t("Повторить загрузку истории")}
            </button>
          </>
        ) : (
          <>
            <div className="spinner" />
            <p>{t("Получаем состояние Codex…")}</p>
          </>
        )}
        {optimisticMessages.map((message) => (
          <article className="message userMessage" key={message.id}>
            <PasteBlocks blocks={message.pasteBlocks} />
            <PastedMarkdown text={message.text} inlinePastes={message.inlinePastes} />
            {message.deliveryError && (
              <p role="status">
                {localizeKnownServerText(language, message.deliveryError.message)}
              </p>
            )}
            <MessageImages images={message.images} />
            <MessageFiles files={message.files ?? []} />
            <button
              type="button"
              onClick={() => void copyText(copyPastedMessage(message.text, message))}
            >
              {t("Скопировать сообщение")}
            </button>
          </article>
        ))}
        {input && <textarea aria-label={t("Сообщение для Codex")} value={input} readOnly />}
        <MessageImages images={images.map((image) => image.url)} />
        <MessageFiles files={files} />
      </div>
    );

  const workspaceSummary =
    summary ??
    preparationRef.current.thread ??
    pendingThreadSummary(newSessionProject!, pendingSettings);
  const waitingForUserInput = Boolean(
    workspaceSummary.currentTurnId &&
    attention.some(
      (request) =>
        request.turnId === workspaceSummary.currentTurnId &&
        request.kind === "userInput" &&
        request.isBlocking !== false,
    ),
  );
  const emptyCreatedWorkspace =
    createdInWorkspaceRef.current === threadId &&
    (detail?.turns.length ?? 0) === 0 &&
    (detail?.queuedMessages.length ?? 0) === 0 &&
    optimisticMessages.length === 0;
  const showEmptySessionHero =
    pendingOptimisticMessage === null &&
    !autoVoiceProgress &&
    (preparationRef.current.active || emptyCreatedWorkspace);
  const showNewSessionChrome = preparationRef.current.active || showEmptySessionHero;
  const latestPlanHasAnnotations = Boolean(
    latestPlan && annotations.some((annotation) => annotation.messageId === latestPlan.item.id),
  );
  const planActionsDisabled =
    busy ||
    settingsBusy ||
    !latestPlan?.ready ||
    Boolean(workspaceSummary.currentTurnId) ||
    workspaceSummary.state === "running" ||
    attention.length > 0 ||
    optimisticMessages.length > 0 ||
    workspaceSummary.queuedMessageCount > 0 ||
    (detail?.queuedMessages.some((message) => message.deliveryMode !== "steer") ?? false);
  const planAcceptanceDisabled = planActionsDisabled || latestPlanHasAnnotations;
  const planDismissalDisabled = planActionsDisabled || !workspaceSummary.awaitingPlanResponse;
  const planNotice = attention.length
    ? attention.every((request) => request.kind === "userInput")
      ? t("Сначала ответьте на вопросы агента")
      : t("Сначала обработайте запросы, требующие внимания")
    : latestPlan && !workspaceSummary.currentTurnId && latestPlan.turn.status !== "inProgress"
      ? latestPlan.needsUpdate
        ? t("План ещё не обновлён после уточнений")
        : !latestPlan.ready
          ? t("План не завершён")
          : null
      : null;
  const planAcceptanceTitle = latestPlanHasAnnotations
    ? t("Сначала отправьте или удалите аннотации к плану")
    : (planNotice ?? undefined);
  const browserSwitchLocked =
    Boolean(workspaceSummary.currentTurnId) ||
    workspaceSummary.state === "running" ||
    workspaceSummary.state === "queued" ||
    workspaceSummary.state === "needsAttention";
  const browserEnabled = workspaceSummary.browserStatus !== "disabled";
  const browserSwitchLabel = browserEnabled ? t("Выключить браузер") : t("Включить браузер");
  const browserSwitchTitle = browserSwitchLocked
    ? t("Дождитесь завершения текущего хода, чтобы изменить доступ браузера")
    : browserUpdating
      ? t("Изменяем доступ браузера…")
      : browserSwitchLabel;
  const backgroundVoiceContext: VoiceRecordingContext | null = preparationRef.current.active
    ? null
    : {
        draft: structuredClone(currentComposerDraft()),
        draftUpdatedAt: savedDraftUpdatedAtRef.current.has(threadId)
          ? savedDraftUpdatedAtRef.current.get(threadId)!
          : (state.details[threadId]?.draft?.updatedAt ?? null),
        mode: resolveVoiceTranscriptionMode(
          currentTurnIdRef.current,
          workspaceSummary.state === "running",
        ),
      };
  const hasPendingVoiceRecording = pendingVoiceRecordingThreadIds.includes(threadId);
  const pendingVoiceRecordingError = pendingVoiceRecordingErrors[threadId] ?? null;

  async function retryRecoveredVoiceRecording(): Promise<void> {
    if (!backgroundVoiceContext || voiceRecoveryPending) return;
    setVoiceRecoveryPending(true);
    setError(null);
    try {
      await retryPendingVoiceRecording({ threadId, ...backgroundVoiceContext });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отправить запись на сервер"),
      );
    } finally {
      setVoiceRecoveryPending(false);
    }
  }

  return (
    <div className="thread-workspace">
      <div className="conversation-pane">
        <WorkspaceHeader
          title={
            showNewSessionChrome
              ? t("Новая задача")
              : (localizeKnownServerText(language, workspaceSummary.title) ??
                workspaceSummary.title)
          }
          subtitle={
            <span className="workspace-subtitle-row">
              <span className="workspace-context">
                {project?.displayName ?? workspaceSummary.cwd}
              </span>
              {forkedFromId && (
                <>
                  <span aria-hidden="true" className="workspace-meta-separator">
                    ·
                  </span>
                  {forkParentSummary ? (
                    <Link
                      className="fork-parent-link"
                      to={`/threads/${encodeURIComponent(forkedFromId)}`}
                    >
                      <GitBranchIcon />
                      <span>
                        {t("Ответвление от {{title}}", {
                          title:
                            localizeKnownServerText(language, forkParentSummary.title) ??
                            forkParentSummary.title,
                        })}
                      </span>
                    </Link>
                  ) : (
                    <span className="fork-parent-unavailable">
                      <GitBranchIcon />
                      <span>{t("Ответвление · Родитель недоступен")}</span>
                    </span>
                  )}
                </>
              )}
            </span>
          }
          onOpenNavigation={onOpenNavigation}
          onToggleInspector={() => {
            setArtifactViewer(null);
            setInspectorOpen((value) => !value);
          }}
          actions={
            showNewSessionChrome ? undefined : (
              <>
                {forkChildren.length + pendingForkOperations.length > 0 && (
                  <details
                    className="thread-action-menu fork-children-menu"
                    data-dismiss-on-outside-click
                    ref={forkChildrenMenuRef}
                  >
                    <summary
                      aria-label={t("Показать ответвления: {{count}}", {
                        count: forkChildren.length + pendingForkOperations.length,
                      })}
                      className="icon-button fork-children-trigger"
                    >
                      <GitBranchIcon />
                      <span aria-hidden="true">
                        {forkChildren.length + pendingForkOperations.length}
                      </span>
                    </summary>
                    <div className="fork-children-popover">
                      <strong>{t("Ответвления")}</strong>
                      <div className="fork-children-list">
                        {pendingForkOperations.map((operation) => {
                          const title =
                            operation.title.trim() ||
                            t("Ответвление от {{title}}", {
                              title:
                                localizeKnownServerText(language, workspaceSummary.title) ??
                                workspaceSummary.title,
                            });
                          const status =
                            operation.status === "preparing"
                              ? t("Готовим ветку")
                              : operation.status === "reconciling"
                                ? t("Сверяем контекст")
                                : t("Создание остановлено");
                          return (
                            <Link
                              className={`fork-child-link fork-operation-child ${operation.status}`}
                              key={operation.id}
                              onClick={() => forkChildrenMenuRef.current?.removeAttribute("open")}
                              state={{ forkOperation: operation, focusComposer: true }}
                              to={`/fork-operations/${encodeURIComponent(operation.id)}`}
                            >
                              {operation.status === "failed" ? (
                                <span className="fork-operation-failed" aria-hidden="true">
                                  !
                                </span>
                              ) : (
                                <span className="spinner small" aria-hidden="true" />
                              )}
                              <span className="fork-operation-child-copy">
                                <span className="fork-child-title">{title}</span>
                                <small>{status}</small>
                              </span>
                            </Link>
                          );
                        })}
                        {forkChildren.map((child) => {
                          const childTitle =
                            localizeKnownServerText(language, child.title) ?? child.title;
                          const stateLabel = forkChildStateLabel(child.state, t);
                          return (
                            <Link
                              className={`fork-child-link${child.archived ? " archived" : ""}`}
                              key={child.id}
                              onClick={() => forkChildrenMenuRef.current?.removeAttribute("open")}
                              state={{ focusComposer: true }}
                              to={`/threads/${encodeURIComponent(child.id)}`}
                            >
                              <span
                                aria-label={t("Состояние: {{state}}", { state: stateLabel })}
                                className={threadStatusClasses(child)}
                                role="img"
                                title={stateLabel}
                              />
                              <span className="fork-child-title">{childTitle}</span>
                              {child.archived && (
                                <span className="fork-child-archived">{t("Архив")}</span>
                              )}
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  </details>
                )}
                {application.capabilities.browserIntegration &&
                  !isSubagent &&
                  !workspaceSummary.archived && (
                    <button
                      aria-busy={browserUpdating || undefined}
                      aria-label={browserSwitchLabel}
                      aria-pressed={browserEnabled}
                      className={`icon-button browser-session-status browser-session-status-${workspaceSummary.browserStatus}`}
                      disabled={browserUpdating || browserSwitchLocked}
                      onClick={() => void toggleBrowserAccess()}
                      title={browserSwitchTitle}
                      type="button"
                    >
                      <BrowserIcon />
                    </button>
                  )}
                {!isSubagent && (
                  <details className="thread-action-menu" data-dismiss-on-outside-click>
                    <summary className="icon-button" aria-label={t("Действия с задачей")}>
                      <MoreIcon />
                    </summary>
                    <div className="action-menu-popover">
                      <button
                        onClick={(event) => void togglePin(event.currentTarget.closest("details"))}
                        disabled={pinUpdating}
                        aria-busy={pinUpdating}
                        aria-pressed={workspaceSummary.pinned}
                      >
                        <PinIcon /> {workspaceSummary.pinned ? t("Открепить") : t("Закрепить")}
                      </button>
                      <button onClick={() => setRenaming(true)}>
                        <PencilIcon /> {t("Переименовать")}
                      </button>
                      <button onClick={toggleArchive}>
                        <ArchiveIcon />{" "}
                        {workspaceSummary.archived ? t("Вернуть из архива") : t("Архивировать")}
                      </button>
                    </div>
                  </details>
                )}
                <button
                  className={`icon-button session-refresh${refreshing ? " refreshing" : ""}`}
                  aria-label={
                    refreshing
                      ? t("Обновляем состояние сессии")
                      : t("Принудительно обновить сессию")
                  }
                  disabled={refreshing}
                  onClick={() => void forceRefreshSession()}
                >
                  <RefreshIcon />
                </button>
              </>
            )
          }
        />
        <div
          className="conversation-scroll"
          ref={scrollRef}
          onWheel={(event) => {
            if (event.deltaY < 0) pauseTailFollowing();
          }}
          onPointerDown={(event) => {
            // The scrollbar belongs to the scroll container, not its content.
            if (event.target === event.currentTarget && event.pointerType !== "touch") {
              pauseTailFollowing();
            }
          }}
          onKeyDown={(event) => {
            const target = event.target as HTMLElement;
            if (event.defaultPrevented || event.altKey) return;
            if (event.key === "Tab" && !event.ctrlKey && !event.metaKey) {
              pauseTailFollowing();
              return;
            }
            if (target.closest("input, textarea, select, [contenteditable=true]")) return;
            if (
              ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
              (event.key === " " && event.shiftKey)
            ) {
              pauseTailFollowing();
            }
          }}
          onFocusCapture={(event) => {
            // Keyboard focus can enter the history from outside the scroller
            // (for example Shift+Tab from the composer). Respect its reveal.
            const node = event.currentTarget;
            if (
              event.target !== node &&
              node.scrollHeight - node.scrollTop - node.clientHeight > TAIL_FOLLOW_THRESHOLD_PX
            ) {
              pauseTailFollowing();
            }
          }}
          onTouchStart={(event) => {
            const touch = event.touches[0];
            scrollTouchOrigin.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
          }}
          onTouchMove={(event) => {
            const origin = scrollTouchOrigin.current;
            const touch = event.touches[0];
            if (!origin || !touch) return;
            const deltaX = touch.clientX - origin.x;
            const deltaY = touch.clientY - origin.y;
            if (deltaY > SCROLL_GESTURE_THRESHOLD_PX && deltaY > Math.abs(deltaX)) {
              pauseTailFollowing();
            }
          }}
          onTouchEnd={() => {
            scrollTouchOrigin.current = null;
          }}
          onTouchCancel={() => {
            scrollTouchOrigin.current = null;
          }}
          onScroll={(event) => {
            if (searchTarget) return;
            const node = event.currentTarget;
            const distanceFromTail = node.scrollHeight - node.scrollTop - node.clientHeight;
            if (distanceFromTail > TAIL_FOLLOW_THRESHOLD_PX) waitingForScrollAway.current = false;
            if (distanceFromTail <= TAIL_FOLLOW_THRESHOLD_PX) {
              // A queued scroll event at the old bottom can arrive after the
              // user's gesture but before its actual viewport movement.
              if (!followsTail.current && waitingForScrollAway.current) return;
              waitingForScrollAway.current = false;
              cancelTailCorrection();
              smoothTailScroll.current = false;
              followsTail.current = true;
              setShowScrollToBottom(false);
            } else if (followsTail.current) {
              // History/layout updates can move the viewport after our layout
              // effects. Only a user gesture should turn off tail following.
              if (!smoothTailScroll.current && tailCorrectionFrame.current === null) {
                tailCorrectionFrame.current = window.requestAnimationFrame(() => {
                  tailCorrectionFrame.current = null;
                  if (followsTail.current) scrollToEnd(node);
                });
              }
            } else {
              setShowScrollToBottom(true);
              if (node.scrollTop < 160) void loadOlder();
            }
          }}
        >
          <section className="timeline" aria-live="polite">
            {searchTarget ? (
              <SearchHistoryView
                target={searchTarget}
                cwd={summary?.cwd}
                onReturn={() => {
                  initialScrollThread.current = null;
                  olderScrollAnchor.current = null;
                  scrollTargetMessageId.current = null;
                  navigate(location.pathname, { replace: true, state: null });
                }}
              />
            ) : (
              <>
                {forkOperationsFromSnapshot(state.snapshot).some(
                  (operation) =>
                    operation.status === "ready" &&
                    operation.mode === "compressed" &&
                    operation.targetThreadId === threadId,
                ) && (
                  <div className="compressed-origin-notice" role="note">
                    <GitBranchIcon />
                    <span>{t("Контекст перенесён в сжатом виде из исходной ветки.")}</span>
                  </div>
                )}
                {showEmptySessionHero ? (
                  <div className="new-session-empty">
                    <span className="new-session-glyph">
                      <NewTaskIcon />
                    </span>
                    <h2>{t("Что поручим Codex?")}</h2>
                    <p>{t("Введите сообщение или добавьте контекст.")}</p>
                  </div>
                ) : pendingOptimisticMessage ? (
                  <div className="turn optimistic-turn">
                    <Activity
                      item={optimisticActivity(pendingOptimisticMessage)}
                      cwd={project?.path ?? workspaceSummary.cwd}
                      onDownload={async () => undefined}
                      onOpenArtifact={openLinkedArtifact}
                    />
                    <div className="outgoing-delivery-status" role="status">
                      {pendingOptimisticMessage.deliveryError
                        ? pendingOptimisticMessage.deliveryError.retryable
                          ? localizeKnownServerText(
                              language,
                              pendingOptimisticMessage.deliveryError.message,
                            )
                          : t("Не отправлено")
                        : t("Отправляется…")}
                      {pendingOptimisticMessage.deliveryError?.retryable === false && (
                        <button
                          type="button"
                          onClick={() => {
                            if (preparationRef.current.submission)
                              delete preparationRef.current.submission.deliveryError;
                            setPreparationRetry((value) => value + 1);
                          }}
                        >
                          {t("Повторить отправку")}
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    {(detailLoadError || detail?.historyError) && (
                      <div className="center-state compact" role="status">
                        <p>
                          {localizeKnownServerText(
                            language,
                            detailLoadError ?? detail?.historyError?.message ?? null,
                          )}
                        </p>
                        <button type="button" onClick={() => setDetailRetry((value) => value + 1)}>
                          {t("Повторить загрузку истории")}
                        </button>
                      </div>
                    )}
                    {loadingOlder && (
                      <div className="history-loader" aria-label={t("Загружаем старые сообщения")}>
                        <span className="spinner small" />
                      </div>
                    )}
                    {olderError && (
                      <button
                        className="history-retry"
                        type="button"
                        onClick={() => void loadOlder()}
                      >
                        {t("Повторить загрузку старых сообщений")}
                      </button>
                    )}
                    {!detail &&
                      !detailLoadError &&
                      optimisticTurnMessages.length === 0 &&
                      createdInWorkspaceRef.current !== threadId && (
                        <div className="center-state compact">
                          <div className="spinner" />
                        </div>
                      )}
                    {detail?.turns.map((turn) => {
                      const display = groupedTurnActivities.get(turn.id)!;
                      const { entries } = display;
                      const technicalItems = technicalTurnActivities.get(turn.id)!;
                      const forkTarget = completedTurnForkActions.get(turn.id);
                      const turnOptimisticMessages = optimisticTurnMessages.filter(
                        (message) =>
                          message.turnId === turn.id ||
                          (!message.turnId && workspaceSummary.currentTurnId === turn.id),
                      );
                      const active = workspaceSummary.currentTurnId === turn.id;
                      const completionResponseId = active
                        ? undefined
                        : display.completionResponseId;
                      const pendingRows = turnOptimisticMessages.length ? 1 : 0;
                      // A message sent into a running turn stays below what the agent already
                      // produced, and an optimistic clarification below a plan in the turn.
                      const pendingAtEnd =
                        (active && entries.length > 0) ||
                        entries.some((entry) => !Array.isArray(entry) && entry.type === "plan");
                      const leadingPendingRows = pendingAtEnd ? 0 : pendingRows;
                      const pendingMessages = turnOptimisticMessages.length > 0 && (
                        <div
                          className="turn-pending-messages"
                          style={{ gridRow: pendingAtEnd ? entries.length + 1 : 1 }}
                        >
                          {turnOptimisticMessages.map((message) => (
                            <Activity
                              item={optimisticActivity(message)}
                              footerStatus={
                                message.deliveryError && (
                                  <span className="outgoing-delivery-status" role="status">
                                    {localizeKnownServerText(
                                      language,
                                      message.deliveryError.message,
                                    ) ?? message.deliveryError.message}
                                  </span>
                                )
                              }
                              cwd={workspaceSummary.cwd}
                              onDownload={downloadFile}
                              onOpenArtifact={openLinkedArtifact}
                              key={message.id}
                            />
                          ))}
                        </div>
                      );
                      return (
                        <TurnActivityDisclosure
                          turn={turn}
                          active={active}
                          waitingForUserInput={active && waitingForUserInput}
                          capacityRetryAt={
                            !workspaceSummary.currentTurnId &&
                            workspaceSummary.capacityRetry?.failedTurnId === turn.id
                              ? workspaceSummary.capacityRetry.nextAttemptAt
                              : undefined
                          }
                          items={technicalItems}
                          loaded={turn.itemsLoaded !== false}
                          interactive={!isSubagent}
                          onLoad={loadTurnJournal}
                          cwd={workspaceSummary.cwd}
                          onDownload={downloadFile}
                          onLoadImage={loadLocalImage}
                          onOpenArtifact={openLinkedArtifact}
                          key={turn.id}
                        >
                          {(activityStatus, journal) => (
                            <div className="turn" data-turn-id={turn.id}>
                              {!pendingAtEnd && pendingMessages}
                              {entries.map((entry, index) => {
                                const isLatestPlan =
                                  !Array.isArray(entry) &&
                                  turn.id === latestPlan?.turn.id &&
                                  entry.id === latestPlan.item.id;
                                return Array.isArray(entry) ? (
                                  <div
                                    className={responsePieceClass(entries, index)}
                                    style={{ gridRow: index + leadingPendingRows + 1 }}
                                    key={entry.map((item) => item.id).join(":")}
                                  >
                                    {entry[0] && isNativeSubagentLaunch(entry[0]) ? (
                                      <NativeSubagentLaunchCard
                                        items={entry.filter(isNativeSubagentLaunch)}
                                        threads={state.snapshot?.threads}
                                        models={state.snapshot?.models}
                                      />
                                    ) : (
                                      <MemoizedActivityGroup
                                        items={entry}
                                        cwd={workspaceSummary.cwd}
                                        onDownload={downloadFile}
                                        onLoadImage={loadLocalImage}
                                        onOpenArtifact={openLinkedArtifact}
                                      />
                                    )}
                                  </div>
                                ) : (
                                  <div
                                    className={`${responsePieceClass(entries, index)}${isLatestPlan ? " latest-plan" : ""}`}
                                    style={{ gridRow: index + leadingPendingRows + 1 }}
                                    key={
                                      "questionKey" in entry
                                        ? (entry.questionKey ?? entry.id)
                                        : entry.id
                                    }
                                  >
                                    <MemoizedActivity
                                      item={entry}
                                      threadId={threadId}
                                      turnId={turn.id}
                                      readOnly={isSubagent}
                                      cwd={workspaceSummary.cwd}
                                      onDownload={downloadFile}
                                      onOpenArtifact={openLinkedArtifact}
                                      onLoadImage={loadLocalImage}
                                      forkAction={
                                        entry.id === forkTarget?.responseId
                                          ? forkTarget.action
                                          : undefined
                                      }
                                      footerStatus={
                                        entry.id === completionResponseId
                                          ? activityStatus
                                          : undefined
                                      }
                                      annotations={annotations}
                                      annotationEnabled={
                                        isLatestPlan
                                          ? !busy &&
                                            !workspaceSummary.currentTurnId &&
                                            latestPlan.ready
                                          : !isSubagent && !busy && entry.id === latestAnnotatableId
                                      }
                                      annotationBusy={busy}
                                      onCreateAnnotation={createAnnotationEvent}
                                      onUpdateAnnotation={updateAnnotationEvent}
                                      onDeleteAnnotation={deleteAnnotationEvent}
                                    />
                                    {isLatestPlan && (
                                      <>
                                        {planNotice && <p role="status">{planNotice}</p>}
                                        {planAcceptanceInFlightRef.current && (
                                          <p role="status">{t("Запускаем выполнение плана…")}</p>
                                        )}
                                        <div className="implement-plan-actions">
                                          <button
                                            className="implement-plan"
                                            disabled={planAcceptanceDisabled}
                                            title={planAcceptanceTitle}
                                            type="button"
                                            onClick={() => void implementPlan("default")}
                                          >
                                            {t("Да, реализуй этот план")}
                                          </button>
                                          {application.capabilities.goal && (
                                            <button
                                              className="implement-plan goal"
                                              disabled={planAcceptanceDisabled}
                                              title={planAcceptanceTitle}
                                              type="button"
                                              onClick={() => void implementPlan("goal")}
                                            >
                                              <TargetIcon />
                                              {t("Запустить в режиме цели")}
                                            </button>
                                          )}
                                          {application.capabilities.team && (
                                            <button
                                              className="implement-plan orchestrator"
                                              disabled={planAcceptanceDisabled}
                                              title={planAcceptanceTitle}
                                              type="button"
                                              onClick={() => void implementPlan("team")}
                                            >
                                              <TeamIcon />
                                              {t("Запустить в режиме оркестратора")}
                                            </button>
                                          )}
                                          {workspaceSummary.awaitingPlanResponse && (
                                            <button
                                              className="implement-plan"
                                              disabled={planDismissalDisabled}
                                              type="button"
                                              onClick={() => void dismissPlan()}
                                            >
                                              {planDismissalInFlightRef.current
                                                ? t("Отказываемся от плана…")
                                                : t("Отказаться от плана")}
                                            </button>
                                          )}
                                        </div>
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                              {pendingAtEnd && pendingMessages}
                              <div
                                className={`turn-response-tail response-piece response-end${!entries.length || isUserEntry(entries.at(-1)) ? " response-start" : ""}`}
                                style={{ gridRow: entries.length + pendingRows + 1 }}
                              >
                                <AttentionPanel
                                  requests={attention.filter(
                                    (request) =>
                                      request.turnId === turn.id &&
                                      !standaloneAttentionIds.current.has(request.id),
                                  )}
                                  hiddenRequestIds={hiddenAttentionIds}
                                  transcriptionConfig={transcriptionConfig}
                                  transcriptionProvider={transcriptionProvider}
                                  onTranscriptionTimingEstimateChange={
                                    onTranscriptionTimingEstimateChange
                                  }
                                />
                                <div className="turn-activity-disclosure">
                                  {!completionResponseId && activityStatus}
                                  {journal}
                                </div>
                              </div>
                              {responseSurfaceRows(entries).map(([start, end]) => (
                                <div
                                  className="response-surface"
                                  aria-hidden="true"
                                  style={{
                                    gridRow: `${start + leadingPendingRows + 1} / ${end + leadingPendingRows + 1}`,
                                  }}
                                  key={`surface:${start}`}
                                />
                              ))}
                            </div>
                          )}
                        </TurnActivityDisclosure>
                      );
                    })}
                    {workspaceSummary.currentTurnId &&
                      !detail?.turns.some((turn) => turn.id === workspaceSummary.currentTurnId) && (
                        <div className="turn active-turn-placeholder">
                          <TurnActivityStatus
                            progress={activeProgress}
                            active
                            waitingForUserInput={waitingForUserInput}
                          />
                        </div>
                      )}
                    {detachedOptimisticMessages(
                      optimisticTurnMessages,
                      detail?.turns ?? [],
                      workspaceSummary.currentTurnId,
                    ).map((message) => (
                      <div className="turn optimistic-turn" key={`optimistic:${message.id}`}>
                        <Activity
                          item={optimisticActivity(message)}
                          footerStatus={
                            message.deliveryError && (
                              <span className="outgoing-delivery-status" role="status">
                                {localizeKnownServerText(language, message.deliveryError.message) ??
                                  message.deliveryError.message}
                              </span>
                            )
                          }
                          cwd={workspaceSummary.cwd}
                          onDownload={downloadFile}
                          onOpenArtifact={openLinkedArtifact}
                        />
                      </div>
                    ))}
                    {!isSubagent && autoVoiceProgress && (
                      <VoiceTranscriptionBubble
                        progress={autoVoiceProgress}
                        draft={preparingVoiceSubmission?.draft ?? activeComposerDraft}
                        deliveryError={preparingVoiceSubmission?.deliveryError?.message}
                        onRetry={
                          preparingVoiceSubmission?.deliveryError
                            ? () => {
                                setPreparationRetry((value) => value + 1);
                                void beginPreparingVoice(preparingVoiceSubmission.recording).catch(
                                  () => undefined,
                                );
                              }
                            : undefined
                        }
                        cwd={workspaceSummary.cwd}
                        onDownload={downloadFile}
                        onOpenArtifact={openLinkedArtifact}
                        onLoadImage={loadLocalImage}
                      />
                    )}
                    <AttentionPanel
                      requests={attention.filter(
                        (request) =>
                          standaloneAttentionIds.current.has(request.id) ||
                          !detail?.turns.some((turn) => turn.id === request.turnId),
                      )}
                      onInteract={(id) => standaloneAttentionIds.current.add(id)}
                      hiddenRequestIds={hiddenAttentionIds}
                      transcriptionConfig={transcriptionConfig}
                      transcriptionProvider={transcriptionProvider}
                      onTranscriptionTimingEstimateChange={onTranscriptionTimingEstimateChange}
                    />
                    {!isSubagent &&
                      !activeVoiceJob &&
                      !voiceUpload &&
                      ["completed", "failed", "interrupted"].includes(workspaceSummary.state) &&
                      workspaceSummary.unread && (
                        <button
                          className="finish-thread-action"
                          disabled={finishing}
                          onClick={() => void finishThread()}
                        >
                          {finishing ? t("Заканчиваем…") : t("Закончить")}
                        </button>
                      )}
                  </>
                )}
                <QueuedMessages
                  messages={queuedMessages}
                  onLoadImage={loadLocalImage}
                  cwd={project?.path ?? workspaceSummary.cwd}
                  onDownload={downloadFile}
                  onOpenArtifact={openLinkedArtifact}
                  canSendNow={!inputUnavailable && !settingsBusy}
                  action={queueAction}
                  inTimeline
                  onRetry={(messageId) => retryReliableMessage(threadId, messageId)}
                  onSendNow={sendQueuedNow}
                  onUpdate={updateQueued}
                  onDelete={deleteQueued}
                />
              </>
            )}
          </section>
        </div>
        {isSubagent ? (
          <div className="subagent-readonly">
            <div className="subagent-readonly-copy">
              {t("Субагент управляется родительской сессией. Здесь доступен только просмотр.")}
            </div>
            {workspaceSummary.capacityRetry && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void stopTask()}
              >
                {t("Стоп")}
              </button>
            )}
            {parentThreadId && (
              <Link to={`/threads/${encodeURIComponent(parentThreadId)}`}>
                <span>{t("Открыть родительскую сессию")}</span>
                {parentSummary && <small>{parentSummary.title}</small>}
              </Link>
            )}
          </div>
        ) : (
          <Composer
            effortDisabled={
              application.isClaude &&
              !preparationRef.current.active &&
              (!detail || detail.turns.length > 0)
            }
            onLayoutChange={handleComposerLayoutChange}
            inputUnavailable={inputUnavailable}
            codexSettings={workspaceSummary.codexSettings}
            autoFocus={
              preparationRef.current.active ||
              (location.state as { focusComposer?: unknown } | null)?.focusComposer === true
            }
            initialSelection={
              (
                location.state as {
                  restoreComposerSelection?: { start: number; end: number } | null;
                } | null
              )?.restoreComposerSelection
            }
            sessionIdentity={
              initialNewSessionRef.current.active ? "new-session-workspace" : threadId
            }
            inputSyncRevision={composerInputSyncRevision}
            input={hideVoiceDraftInComposer ? "" : input}
            onInput={setInput}
            pastes={hideVoiceDraftInComposer ? emptyComposerDraft() : activeComposerDraft}
            onDraftFlush={onDraftFlush}
            cwd={workspaceSummary.cwd}
            skillsEpoch={state.skillsEpoch}
            images={hideVoiceDraftInComposer ? [] : images}
            onImagesChange={setImages}
            files={hideVoiceDraftInComposer ? [] : files}
            onFilesChange={setFiles}
            onUploadFiles={uploadFiles}
            onDeleteFile={deleteFile}
            attachmentScope={attachmentScope}
            onPendingAttachmentsChange={setPendingAttachments}
            onSubmit={submit}
            onSendQueuedNow={
              queuedShortcutMessage ? () => void sendQueuedNow(queuedShortcutMessage.id) : undefined
            }
            busy={busy || (preparationRef.current.active && pendingOptimisticMessage !== null)}
            running={
              Boolean(workspaceSummary.currentTurnId) ||
              (application.isClaude && workspaceSummary.state === "running") ||
              Boolean(workspaceSummary.capacityRetry) ||
              (workspaceSummary.settings.collaborationMode === "team" &&
                workspaceSummary.state === "running")
            }
            settings={preparationRef.current.active ? pendingSettings : workspaceSummary.settings}
            onSettingsChange={(patch) => void updateSettings(patch)}
            settingsBusy={settingsBusy}
            goalMode={goalMode}
            goal={goal}
            goalBusy={goalBusy}
            onGoalModeChange={(value) => {
              if (value && annotations.length) {
                setError(t("Сначала отправьте или удалите аннотации"));
                return;
              }
              setGoalMode(value);
            }}
            onGoalUpdate={(patch) => void updateGoal(patch)}
            onGoalClear={() => void clearGoal()}
            models={state.snapshot?.models ?? []}
            onStop={
              !busy &&
              (workspaceSummary.currentTurnId ||
                workspaceSummary.capacityRetry ||
                (workspaceSummary.settings.collaborationMode === "team" &&
                  workspaceSummary.state === "running"))
                ? () => void stopTask()
                : undefined
            }
            transcriptionConfig={transcriptionConfig}
            transcriptionProvider={transcriptionProvider}
            voiceUploadPending={Boolean(voiceUpload)}
            voiceInputLocked={Boolean(
              activeVoiceJob || voiceUpload || pendingVoiceSendRemoval || preparingVoiceSubmission,
            )}
            onCancelVoiceTranscription={
              activeVoiceJob ? () => void cancelVoiceTranscription() : undefined
            }
            voiceCancellationPending={voiceCancellationPending}
            onRecordingReady={
              preparationRef.current.active
                ? beginPreparingVoice
                : backgroundVoiceContext
                  ? (recording) => beginTranscription(threadId, recording, backgroundVoiceContext)
                  : undefined
            }
            preserveRecordingOnSessionChange={backgroundVoiceContext !== null}
            transcriptionStatus={draftVoiceProgress}
            onDismissTranscriptionError={() => void cancelVoiceTranscription()}
            transcriptionError={
              voiceJob?.status === "failed"
                ? (localizeKnownServerText(language, voiceJob.error) ?? voiceJob.error)
                : null
            }
            error={error ?? pendingVoiceRecordingError}
            annotations={annotations}
            onOpenAnnotation={openAnnotation}
            onDeleteAnnotation={deleteAnnotation}
          >
            {workspaceSummary.quotaRecovery && (
              <div className="input-availability-notice" role="status">
                <span>{t(workspaceSummary.quotaRecovery.message)}</span>
                {workspaceSummary.quotaRecovery.state !== "failed" && (
                  <button type="button" disabled={busy} onClick={() => void stopTask()}>
                    {t("Остановить задачу")}
                  </button>
                )}
              </div>
            )}
            {inputUnavailable && (
              <div className="input-availability-notice" role="status">
                <span>
                  {t("Codex временно не принимает сообщения. Черновик и очередь сохранены.")}
                </span>
                <button
                  type="button"
                  disabled={refreshing}
                  onClick={() => void forceRefreshSession()}
                >
                  <ActionLabel
                    idle={t("Проверить снова")}
                    busy={t("Обновляем…")}
                    pending={refreshing}
                  />
                </button>
              </div>
            )}
            {hasPendingVoiceRecording && backgroundVoiceContext && (
              <button
                className="new-session-retry"
                type="button"
                disabled={voiceRecoveryPending || busy || Boolean(activeVoiceJob || voiceUpload)}
                onClick={() => void retryRecoveredVoiceRecording()}
              >
                {voiceRecoveryPending
                  ? t("Восстанавливаем сохранённую запись…")
                  : t("Повторить сохранённую запись")}
              </button>
            )}
            {storageWarning && preparationRef.current.active && (
              <p className="new-session-storage-warning" role="status">
                {t(
                  "Локальное сохранение недоступно. Не закрывайте страницу до отправки сообщения.",
                )}
              </p>
            )}
            {error && preparationRef.current.active && (
              <button
                className="new-session-retry"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!preparationRef.current.threadId) creationPromiseRef.current = null;
                  setPreparationRetry((value) => value + 1);
                }}
              >
                {t("Повторить")}
              </button>
            )}
            {teamUpgradeRequired && project && (
              <button
                className="team-session-upgrade"
                type="button"
                disabled={settingsBusy}
                onClick={() => void createManagedTeamSession()}
              >
                {t("Создать новую Team-сессию")}
              </button>
            )}
            {showScrollToBottom && !searchTarget && (
              <button
                type="button"
                className="scroll-to-bottom"
                aria-label={t("Прокрутить к последнему сообщению")}
                onClick={() => {
                  cancelTailCorrection();
                  followsTail.current = true;
                  const node = scrollRef.current;
                  smoothTailScroll.current = Boolean(
                    node &&
                    node.scrollHeight - node.scrollTop - node.clientHeight >
                      TAIL_FOLLOW_THRESHOLD_PX,
                  );
                  setShowScrollToBottom(smoothTailScroll.current);
                  scrollToEnd(node, "smooth");
                }}
              >
                <ArrowDownIcon />
              </button>
            )}
            <SubagentActivityBar
              key={threadId}
              threads={childSubagents}
              models={state.snapshot?.models ?? []}
              turns={detail?.turns}
            />
          </Composer>
        )}
      </div>
      {artifactViewer && (
        <>
          <button
            type="button"
            className="artifact-viewer-backdrop"
            aria-label={t("Закрыть предпросмотр")}
            onClick={closeArtifact}
          />
          <ArtifactViewer
            artifact={artifactViewer.artifact}
            opener={artifactViewer.opener}
            onClose={closeArtifact}
            onDownload={downloadFile}
            onLoad={loadArtifact}
            returnToArtifacts={artifactViewer.returnToInspector}
          />
        </>
      )}
      {showNewSessionChrome ? (
        <NewSessionInspector
          open={inspectorOpen}
          project={project}
          onClose={() => setInspectorOpen(false)}
        />
      ) : (
        <SessionInspector
          open={inspectorOpen}
          summary={workspaceSummary}
          project={project}
          gitChanges={gitChangesState?.threadId === threadId ? gitChangesState.value : null}
          activeTab={inspectorTab}
          artifacts={threadArtifacts}
          artifactCapability={artifactResponse?.capability ?? null}
          artifactLoadState={artifactLoadState}
          onClose={() => setInspectorOpen(false)}
          onTabChange={setInspectorTab}
          onArtifactOpen={openInspectorArtifact}
          onArtifactDownload={downloadFile}
          onArtifactRetry={() => {
            void loadSessionArtifacts();
          }}
        />
      )}
      {inspectorOpen && (
        <button
          className="inspector-backdrop"
          aria-label={t("Закрыть сведения")}
          onClick={() => setInspectorOpen(false)}
        />
      )}
      {renaming && (
        <RenameDialog
          initialValue={workspaceSummary.title}
          onClose={() => setRenaming(false)}
          onRename={async (name) => {
            await api.updateThread(threadId, { name });
            setRenaming(false);
          }}
        />
      )}
      {forkDialogTarget && summary && (
        <ForkDialog
          sourceThreadId={threadId}
          sourceTitle={localizeKnownServerText(language, summary.title) ?? summary.title}
          lastTurnId={forkDialogTarget.lastTurnId}
          agentMessageId={forkDialogTarget.agentMessageId}
          openerRef={forkDialogOpenerRef}
          onClose={() => setForkDialogTarget(null)}
          onCreated={(operation) => {
            dispatch({ type: "forkOperation", operation });
            navigate(`/fork-operations/${encodeURIComponent(operation.id)}`, {
              state: { forkOperation: operation, focusComposer: true },
            });
          }}
        />
      )}
    </div>
  );
}

function effectiveDefaultModel(models: ModelOption[]): ModelOption | undefined {
  return models.find((candidate) => candidate.isDefault) ?? models[0];
}

export function VoiceTranscriptionBubble({
  progress,
  draft,
  cwd,
  onDownload,
  onOpenArtifact,
  onLoadImage,
  deliveryError,
  onRetry,
}: {
  progress: VoiceProgress;
  draft: UpdateThreadDraftRequest;
  cwd?: string;
  onDownload?(path: string): Promise<void>;
  onOpenArtifact?(artifact: ArtifactDescriptor, opener: HTMLButtonElement | null): void;
  onLoadImage?: LocalImageLoader;
  deliveryError?: string;
  onRetry?(): void;
}) {
  const { t } = useI18n();
  const hasContent = Boolean(
    draft.input.trim() || draft.pasteBlocks?.length || draft.images.length || draft.files?.length,
  );
  const label = deliveryError
    ? t("Не удалось отправить запись на сервер")
    : progress.status === "uploading"
      ? t("Отправляем запись")
      : progress.status === "queued"
        ? t("На сервере · ожидание")
        : progress.status === "applying"
          ? t("Готовим отправку")
          : t("Распознаём");
  const timer =
    progress.status === "transcribing"
      ? formatVoiceTranscriptionTimer(progress.elapsedSeconds, progress.estimatedTotalSeconds)
      : formatVoiceClock(progress.elapsedSeconds);
  const status = (
    <>
      <span className="voice-transcription-icon" aria-hidden="true">
        {progress.status === "uploading" || progress.status === "applying" ? (
          <span className="spinner small" />
        ) : progress.status === "queued" ? (
          <CheckIcon />
        ) : (
          <MicrophoneIcon />
        )}
      </span>
      <span className="voice-transcription-status-label">{label}</span>
      {!deliveryError && (
        <span className="voice-transcription-timer" aria-hidden="true">
          {timer}
        </span>
      )}
      {deliveryError && onRetry && (
        <button type="button" onClick={onRetry}>
          {t("Повторить отправку")}
        </button>
      )}
    </>
  );

  return (
    <article
      aria-label={label}
      aria-live="polite"
      className={`message userMessage voice-transcription-message${hasContent ? " voice-transcription-message-with-content" : ""}`}
      role="status"
    >
      <div className="message-body">
        {hasContent ? <div className="voice-transcription-status">{status}</div> : status}
        {hasContent && (
          <div className="voice-transcription-content">
            <PasteBlocks blocks={draft.pasteBlocks} />
            {draft.input.trim() && (
              <MarkdownContent
                text={draft.input}
                inlinePastes={draft.inlinePastes}
                cwd={cwd}
                onDownload={onDownload}
                onOpenArtifact={onOpenArtifact}
                onLoadImage={onLoadImage}
              />
            )}
            {draft.images.length > 0 && (
              <MessageImages images={draft.images.map((image) => image.url)} />
            )}
            {(draft.files?.length ?? 0) > 0 && (
              <MessageFiles files={draft.files ?? []} onDownload={onDownload} />
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function formatVoiceClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatVoiceTranscriptionTimer(
  elapsedSeconds: number,
  estimatedTotalSeconds: number | null,
): string {
  if (estimatedTotalSeconds === null) return formatVoiceClock(elapsedSeconds);
  if (elapsedSeconds <= estimatedTotalSeconds) {
    return `≈${formatVoiceClock(Math.max(0, estimatedTotalSeconds - elapsedSeconds))}`;
  }
  return `+${formatVoiceClock(elapsedSeconds - estimatedTotalSeconds)}`;
}

function hasMaterializedVoiceMessage(
  detail: ThreadDetail | undefined,
  optimisticMessages: OptimisticMessage[],
  voiceJobId: string,
): boolean {
  return Boolean(
    detail?.queuedMessages.some((message) => message.id === voiceJobId) ||
    optimisticMessages.some((message) => message.id === voiceJobId) ||
    detail?.turns.some((turn) =>
      turn.items.some((item) => item.type === "userMessage" && item.id === voiceJobId),
    ),
  );
}

function optimisticActivity(message: OptimisticMessage): ActivityItem {
  return {
    type: "userMessage",
    id: message.id,
    status: "completed",
    text: message.text,
    ...pastedText(message),
    images: message.images,
    files: (message.files ?? []).map(({ name, path }) => ({ name, path })),
    timestamp: message.createdAt,
    phase: null,
  };
}

function detachedOptimisticMessages(
  messages: OptimisticMessage[],
  turns: TurnView[],
  currentTurnId: string | null,
): OptimisticMessage[] {
  const loadedTurnIds = new Set(turns.map((turn) => turn.id));
  return messages.filter(
    (message) =>
      !(
        (message.turnId && loadedTurnIds.has(message.turnId)) ||
        (!message.turnId && currentTurnId && loadedTurnIds.has(currentTurnId))
      ),
  );
}

function mergeOptimisticQueue(
  messages: QueuedMessage[],
  optimistic: OptimisticMessage[],
): QueuedMessageView[] {
  const confirmedIds = new Set(messages.map((message) => message.id));
  return [
    ...messages.map((message) => ({ ...message, confirmed: true })),
    ...optimistic
      .filter((message) => !confirmedIds.has(message.id))
      .map((message) => ({
        id: message.id,
        threadId: message.threadId,
        text: message.text,
        ...pastedText(message),
        ...(message.images.length ? { images: message.images } : {}),
        ...(message.files?.length ? { files: message.files } : {}),
        ...(message.deliveryError ? { deliveryError: message.deliveryError } : {}),
        ...(message.dismissUserInput ? { dismissUserInput: message.dismissUserInput } : {}),
        createdAt: message.createdAt,
        status: "queued" as const,
        confirmed: false,
        serverAccepted: message.serverAccepted,
      })),
  ].sort((left, right) => left.createdAt - right.createdAt);
}

function createClientMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function MarkdownTable({ children }: { children?: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="markdown-table-scroll" role="region" aria-label={t("Таблица")} tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}

function MarkdownContent({
  text,
  inlinePastes,
  cwd,
  onDownload,
  onOpenArtifact,
  onLoadImage,
}: {
  text: string;
  inlinePastes?: PastedText["inlinePastes"];
  cwd?: string;
  onDownload?(path: string): Promise<void>;
  onOpenArtifact?(artifact: ArtifactDescriptor, opener: HTMLButtonElement | null): void;
  onLoadImage?: LocalImageLoader;
}) {
  const components = useMemo<MarkdownComponents>(
    () => ({
      pre: CopyableCodeBlock,
      table: MarkdownTable,
      a({ href, children, title, node }) {
        return (
          <MarkdownLink
            href={href}
            title={title}
            cwd={cwd}
            onDownload={onDownload}
            onOpenArtifact={onOpenArtifact}
            containsImage={node?.children.some(
              (child) => child.type === "element" && child.tagName === "img",
            )}
          >
            {children}
          </MarkdownLink>
        );
      },
      img({ src, alt, title }) {
        return (
          <MarkdownImageContent
            src={src}
            alt={alt ?? ""}
            title={title}
            cwd={cwd}
            onLoadImage={onLoadImage}
          />
        );
      },
    }),
    [cwd, onDownload, onLoadImage, onOpenArtifact],
  );
  return <PastedMarkdown text={text} inlinePastes={inlinePastes} components={components} />;
}

function MarkdownLink({
  href,
  children,
  title,
  cwd,
  onDownload,
  onOpenArtifact,
  containsImage,
}: {
  href?: string;
  children?: React.ReactNode;
  title?: string;
  cwd?: string;
  containsImage?: boolean;
  onDownload?(path: string): Promise<void>;
  onOpenArtifact?: LocalArtifactOpener;
}) {
  const gallery = useMessageImageGallery();
  if (gallery && containsImage) return <>{children}</>;
  const image = gallery?.find(href);
  if (image)
    return (
      <GalleryImageLink image={image} title={title}>
        {children}
      </GalleryImageLink>
    );
  const path = cwd ? localDownloadPath(href, cwd) : null;
  const artifact = path ? artifactDescriptor(path) : null;
  return path && artifact && onOpenArtifact ? (
    <PreviewLink
      path={path}
      title={title}
      artifact={artifact}
      onDownload={onDownload}
      onOpenArtifact={onOpenArtifact}
    >
      {children}
    </PreviewLink>
  ) : path && onDownload ? (
    <DownloadLink href={href!} path={path} title={title} onDownload={onDownload}>
      {children}
    </DownloadLink>
  ) : (
    <a href={href} title={title}>
      {children}
    </a>
  );
}

function MarkdownImageContent(props: {
  src?: string;
  alt: string;
  title?: string;
  cwd?: string;
  onLoadImage?: LocalImageLoader;
}) {
  const gallery = useMessageImageGallery();
  if (!gallery) return <MarkdownImage {...props} />;
  const image = gallery.find(props.src, true);
  return image ? (
    <GalleryImageLink image={image} title={props.title}>
      {props.alt}
    </GalleryImageLink>
  ) : (
    <span>{props.alt}</span>
  );
}

function MarkdownImage({
  src,
  alt,
  title,
  cwd,
  onLoadImage,
}: {
  src?: string;
  alt: string;
  title?: string;
  cwd?: string;
  onLoadImage?: LocalImageLoader;
}) {
  const { t } = useI18n();
  const path = cwd ? localDownloadPath(src, cwd) : null;
  const descriptor = path ? artifactDescriptor(path) : null;
  const localPath = descriptor?.kind === "image" ? path : null;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<
    { status: "loading" } | { status: "failed" } | { status: "ready"; source: string }
  >({ status: "loading" });
  const [viewer, setViewer] = useState<HTMLButtonElement | null>(null);

  useEffect(() => {
    setLoaded(false);
    if (!localPath || !onLoadImage) {
      setState({ status: "ready", source: src ?? "" });
      return;
    }
    let active = true;
    let source: string | null = null;
    setState({ status: "loading" });
    void onLoadImage(localPath)
      .then((blob) => {
        source = URL.createObjectURL(blob);
        if (active) setState({ status: "ready", source });
        else URL.revokeObjectURL(source);
      })
      .catch(() => {
        if (active) setState({ status: "failed" });
      });
    return () => {
      active = false;
      if (source) URL.revokeObjectURL(source);
    };
  }, [attempt, localPath, onLoadImage, src]);

  if (state.status === "loading") {
    return (
      <span className="markdown-image-state" role="status">
        <span className="spinner small" />
        {t("Загружаем изображение…")}
      </span>
    );
  }
  if (state.status === "failed") {
    return (
      <button
        type="button"
        className="markdown-image-state markdown-image-retry"
        onClick={() => setAttempt((value) => value + 1)}
      >
        {t("Не удалось загрузить изображение. Повторить")}
      </button>
    );
  }

  const label =
    alt ||
    descriptor?.fileName ||
    localPath?.split("/").at(-1) ||
    t("Изображение {{number}}", { number: 1 });
  return (
    <>
      <button
        type="button"
        className={`markdown-image-preview${loaded ? "" : " is-loading"}`}
        aria-label={t("Открыть изображение {{name}}", { name: label })}
        aria-busy={!loaded}
        disabled={!loaded}
        onClick={(event) => setViewer(event.currentTarget)}
      >
        {!loaded && (
          <span role="status" className="markdown-image-loading-label">
            <span className="spinner small" />
            {t("Загружаем изображение…")}
          </span>
        )}
        <img
          src={state.source}
          alt={alt}
          title={title}
          onLoad={() => setLoaded(true)}
          onError={() => setState({ status: "failed" })}
        />
      </button>
      {viewer && (
        <ImageViewer
          images={[{ src: state.source, alt: label }]}
          index={0}
          opener={viewer}
          onIndexChange={() => undefined}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}

function PreviewLink({
  path,
  title,
  artifact,
  onDownload,
  onOpenArtifact,
  children,
}: {
  path: string;
  title?: string;
  artifact: ArtifactDescriptor;
  onDownload?(path: string): Promise<void>;
  onOpenArtifact(artifact: ArtifactDescriptor, opener: HTMLButtonElement | null): void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const busyRef = useRef(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);

  async function download() {
    if (!onDownload || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await onDownload(path);
    } catch {
      setFailed(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <span className="download-link-container preview-link-container">
      <span className="preview-link-row">
        <button
          type="button"
          ref={openButtonRef}
          title={title}
          className="download-link preview-link-open"
          aria-label={t("Открыть {{name}}", { name: artifact.fileName })}
          aria-busy={busy}
          aria-disabled={busy}
          disabled={busy}
          onClick={() => onOpenArtifact(artifact, openButtonRef.current)}
        >
          {children}
          {busy && <span className="download-link-status"> — {t("открываем…")}</span>}
        </button>
        {onDownload && (
          <button
            type="button"
            className="download-link preview-link-download"
            aria-label={t("Скачать {{name}}", { name: artifact.fileName })}
            title={t("Скачать")}
            disabled={busy}
            onClick={() => void download()}
          >
            <ArrowDownIcon />
          </button>
        )}
      </span>
      {failed && (
        <span className="download-link-error" role="alert">
          {t("Не удалось скачать файл. Нажмите ещё раз.")}
        </span>
      )}
    </span>
  );
}

function localImageMimeType(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return `image/${extension || "png"}`;
}

function CopyableCodeBlock({ children }: { children?: React.ReactNode }) {
  const { t } = useI18n();
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy() {
    const text = (preRef.current?.textContent ?? "").replace(/\n$/, "");
    try {
      await copyText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopyState("idle"), 1_800);
  }

  const label =
    copyState === "copied"
      ? t("Блок скопирован")
      : copyState === "failed"
        ? t("Не удалось скопировать блок")
        : t("Копировать блок");

  return (
    <div className="markdown-code-block" data-copy-state={copyState}>
      <pre ref={preRef}>{children}</pre>
      <button
        type="button"
        className="markdown-code-copy"
        aria-label={label}
        aria-live="polite"
        title={label}
        onClick={() => void copy()}
      >
        {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

function DownloadLink({
  href,
  path,
  title,
  onDownload,
  children,
}: {
  href: string;
  path: string;
  title?: string;
  onDownload(path: string): Promise<void>;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const busyRef = useRef(false);

  async function download() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await onDownload(path);
    } catch {
      setFailed(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <span className="download-link-container">
      <a
        href={href}
        title={title}
        className="download-link"
        aria-busy={busy}
        aria-disabled={busy}
        onClick={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        {children}
        {busy && <span className="download-link-status"> — {t("скачиваем…")}</span>}
      </a>
      {failed && (
        <span className="download-link-error" role="alert">
          {t("Не удалось скачать файл. Нажмите ещё раз.")}
        </span>
      )}
    </span>
  );
}

export function SearchHistoryView({
  target,
  cwd,
  onReturn,
}: {
  target: SearchTarget;
  cwd?: string;
  onReturn(): void;
}) {
  const { api, state } = useConnection();
  const { language, t } = useI18n();
  const [turn, setTurn] = useState<TurnView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const highlight = useRef<HTMLDivElement>(null);
  const instanceId = state.snapshot?.instanceId;
  const { threadId, occurrence } = target;
  useEffect(() => {
    let active = true;
    setTurn(null);
    setError(null);
    if (target.instanceId && instanceId && target.instanceId !== instanceId) {
      setError(t("Сервер перезапущен. Повторите поиск, чтобы открыть фрагмент."));
      return;
    }
    void api
      .readSearchTurn(threadId, occurrence.turnId, occurrence.turnCursor)
      .then((response) => {
        if (!active) return;
        if (instanceId && response.instanceId !== instanceId) {
          setError(t("Сервер перезапущен. Повторите поиск, чтобы открыть фрагмент."));
        } else {
          setTurn(response.turn);
        }
      })
      .catch((caught: unknown) => {
        if (active)
          setError(
            caught instanceof Error
              ? localizeKnownServerText(language, caught.message)
              : t("Не удалось загрузить фрагмент"),
          );
      });
    return () => {
      active = false;
    };
  }, [
    api,
    instanceId,
    language,
    occurrence.turnId,
    occurrence.turnCursor,
    retry,
    t,
    target.instanceId,
    threadId,
  ]);
  useLayoutEffect(() => {
    highlight.current?.scrollIntoView?.({ block: "center" });
  }, [turn, occurrence.itemId]);
  const messages =
    turn?.items
      .filter(
        (item) =>
          item.type === "userMessage" || item.type === "agentMessage" || item.type === "plan",
      )
      .filter(hasVisibleActivity) ?? [];
  return (
    <div className="search-history-view">
      <div className="search-history-banner" role="note">
        <div>
          <strong>{t("Фрагмент из истории")}</strong>
          <p className="search-context">{target.query}</p>
        </div>
        <button type="button" onClick={onReturn}>
          {t("К текущему диалогу")}
        </button>
      </div>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            {t("Повторить")}
          </button>
        </div>
      ) : !turn ? (
        <p role="status">{t("Загрузка…")}</p>
      ) : (
        <>
          {!messages.some((item) => item.id === occurrence.itemId) && (
            <p role="status">
              {t("Найденное сообщение больше недоступно. Можно вернуться к текущему диалогу.")}
            </p>
          )}
          {messages.map((item) => (
            <div
              key={item.id}
              ref={item.id === occurrence.itemId ? highlight : undefined}
              className={item.id === occurrence.itemId ? "search-history-match" : undefined}
              data-search-item-id={item.id}
            >
              <Activity item={item} cwd={cwd} readOnly />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function Activity({
  item,
  threadId,
  turnId,
  readOnly = true,
  cwd,
  onDownload,
  onOpenArtifact,
  onLoadImage,
  forkAction,
  footerStatus,
  annotations = [],
  annotationEnabled = false,
  annotationBusy = false,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
}: {
  item: ActivityItem;
  threadId?: string;
  turnId?: string;
  readOnly?: boolean;
  cwd?: string;
  onDownload?(path: string): Promise<void>;
  onOpenArtifact?(artifact: ArtifactDescriptor, opener: HTMLButtonElement | null): void;
  onLoadImage?: LocalImageLoader;
  forkAction?: { disabled: boolean; onFork(opener?: HTMLElement): void };
  footerStatus?: React.ReactNode;
  annotations?: PendingAnnotation[];
  annotationEnabled?: boolean;
  annotationBusy?: boolean;
  onCreateAnnotation?(draft: AnnotationDraft): boolean;
  onUpdateAnnotation?(annotationId: string, comment: string): boolean;
  onDeleteAnnotation?(annotationId: string): boolean;
}) {
  const { language, t } = useI18n();
  if (!hasVisibleActivity(item)) return null;
  if (item.type === "userMessage" || item.type === "agentMessage") {
    const messageAnnotations = numberedAnnotations(annotations, item.id);
    const content = (
      <article
        className={`message ${item.type}${item.pasteBlocks?.length ? " message-with-pastes" : ""}`}
        data-message-id={item.type === "userMessage" ? item.id : undefined}
      >
        {item.type === "userMessage" && <PasteBlocks blocks={item.pasteBlocks} />}
        <div className="message-body">
          {item.text &&
            (item.type === "agentMessage" ? (
              <AnnotatableMarkdownContent
                text={item.text}
                messageId={item.id}
                source="agentMessage"
                cwd={cwd}
                onDownload={onDownload}
                onOpenArtifact={onOpenArtifact}
                onLoadImage={onLoadImage}
                annotations={messageAnnotations}
                enabled={annotationEnabled}
                readOnly={annotationBusy}
                onCreate={onCreateAnnotation}
                onUpdate={onUpdateAnnotation}
                onDelete={onDeleteAnnotation}
              />
            ) : (
              <MarkdownContent
                text={item.text}
                inlinePastes={item.inlinePastes}
                cwd={cwd}
                onDownload={onDownload}
                onOpenArtifact={onOpenArtifact}
                onLoadImage={onLoadImage}
              />
            ))}
          {item.type === "agentMessage" ? (
            <MessageImageGallery />
          ) : (
            item.images.length > 0 && <MessageImages images={item.images} />
          )}
          {(item.files?.length ?? 0) > 0 && (
            <MessageFiles files={item.files ?? []} onDownload={onDownload} />
          )}
          {item.type === "agentMessage" &&
            !!item.questions?.length &&
            (threadId && turnId ? (
              <AsyncQuestionCard
                item={item}
                threadId={threadId}
                turnId={turnId}
                readOnly={readOnly}
                key={`${threadId}:${turnId}:${item.questionKey ?? item.id}`}
              />
            ) : (
              item.questions.map((question, index) => <p key={index}>{question.title}</p>)
            ))}
        </div>
        <MessageFooter
          text={item.type === "userMessage" ? copyPastedMessage(item.text, item) : item.text}
          markdown={item.type === "agentMessage"}
          timestamp={item.timestamp}
          forkAction={item.type === "agentMessage" ? forkAction : undefined}
          status={item.type === "agentMessage" || application.isClaude ? footerStatus : undefined}
        />
      </article>
    );
    return item.type === "agentMessage" ? (
      <MessageImageProvider
        text={item.text}
        images={item.images}
        cwd={cwd}
        onLoadImage={onLoadImage}
        onDownload={onDownload}
      >
        {content}
      </MessageImageProvider>
    ) : (
      content
    );
  }
  if (item.type === "reasoning") {
    return (
      <ActivityDetails icon={<MoreIcon />} title={t("Рассуждение")} status={item.status}>
        <MarkdownContent
          text={item.text}
          cwd={cwd}
          onDownload={onDownload}
          onOpenArtifact={onOpenArtifact}
          onLoadImage={onLoadImage}
        />
      </ActivityDetails>
    );
  }
  if (item.type === "plan") {
    const messageAnnotations = numberedAnnotations(annotations, item.id);
    return (
      <MessageImageProvider
        text={item.text}
        images={item.images}
        cwd={cwd}
        onLoadImage={onLoadImage}
        onDownload={onDownload}
      >
        <article className="message plan">
          <div className="message-body">
            <div className="activity-label">{t("План")}</div>
            <AnnotatableMarkdownContent
              text={item.text}
              messageId={item.id}
              source="plan"
              cwd={cwd}
              onDownload={onDownload}
              onOpenArtifact={onOpenArtifact}
              onLoadImage={onLoadImage}
              annotations={messageAnnotations}
              enabled={annotationEnabled}
              readOnly={annotationBusy}
              onCreate={onCreateAnnotation}
              onUpdate={onUpdateAnnotation}
              onDelete={onDeleteAnnotation}
            />
            <MessageImageGallery />
          </div>
          <MessageFooter
            text={item.text}
            timestamp={item.timestamp}
            forkAction={forkAction}
            status={footerStatus}
            markdown
          />
        </article>
      </MessageImageProvider>
    );
  }
  if (item.type === "userInputResponse") {
    const text = item.entries.flatMap((entry) => [entry.question, ...entry.answers]).join("\n");
    return (
      <article className="message userMessage user-input-response">
        <div className="message-body">
          {item.entries.map((entry, index) => (
            <section key={`${index}:${entry.header}:${entry.question}`}>
              <div className="user-input-topic">{entry.header}</div>
              <p className="user-input-question">{entry.question}</p>
              {entry.answers.map((answer, answerIndex) => (
                <div className="user-input-answer" key={`${answerIndex}:${answer}`}>
                  {answer.replace(/[ \t]+\(Recommended\)$/u, "")}
                </div>
              ))}
            </section>
          ))}
        </div>
        <MessageFooter text={text} timestamp={item.timestamp} />
      </article>
    );
  }
  if (item.type === "planChecklist") {
    return (
      <article className="message plan-checklist">
        <div className="activity-label">{t("Ход работы")}</div>
        {item.explanation && <p>{item.explanation}</p>}
        <ol>
          {item.steps.map((step, index) => {
            const status =
              item.status === "inProgress" || step.status === "completed" ? step.status : "pending";
            return (
              <li className={status} key={`${index}:${step.step}`}>
                <input
                  aria-label={status === "completed" ? t("Выполнено") : t("Не выполнено")}
                  checked={status === "completed"}
                  readOnly
                  tabIndex={-1}
                  type="checkbox"
                />
                <span>{step.step}</span>
                {status === "inProgress" && <span className="spinner small" />}
              </li>
            );
          })}
        </ol>
      </article>
    );
  }
  if (item.type === "subagentLaunch") {
    if (isNativeSubagentLaunch(item)) return <NativeSubagentLaunchCard items={[item]} />;
    const label =
      item.status === "failed"
        ? t("Не удалось запустить субагента")
        : item.status === "inProgress"
          ? t("Запуск субагента")
          : t("Запущен субагент");
    return (
      <article className="message orchestration-notice">
        <div className="activity-label">{label}</div>
        <ul>
          <li>
            {item.threadId ? (
              <Link to={`/threads/${encodeURIComponent(item.threadId)}`}>{item.title}</Link>
            ) : (
              <strong>{item.title}</strong>
            )}
            {item.status !== "completed" && (
              <span>{item.status === "failed" ? t("Ошибка") : t("Выполняется")}</span>
            )}
          </li>
        </ul>
      </article>
    );
  }
  if (item.type === "orchestrationNotice") {
    return (
      <article className="message orchestration-notice">
        <div className="activity-label">
          {item.agents.length === 1
            ? t("Получен результат субагента")
            : t("Получены результаты субагентов")}
        </div>
        <ul>
          {item.agents.map((agent) => {
            const resultStatus = agent.result?.outcome
              ? orchestrationResultOutcomeLabel(agent.result.outcome, t)
              : orchestrationOutcomeLabel(agent.outcome, t);
            const visibleChangedPaths = agent.changedPaths?.slice(
              0,
              ORCHESTRATION_CHANGED_PATH_LIMIT,
            );
            const changedPathCount = Math.max(
              visibleChangedPaths?.length ?? 0,
              agent.changedPathCount ?? agent.changedPaths?.length ?? 0,
            );
            return (
              <li className="orchestration-result" key={agent.taskId ?? agent.threadId}>
                <div className="orchestration-result-heading">
                  <Link to={`/threads/${encodeURIComponent(agent.threadId)}`}>
                    {agent.nickname ? `${agent.nickname} · ${agent.title}` : agent.title}
                  </Link>
                  <span
                    aria-label={t("Статус результата: {{status}}", { status: resultStatus })}
                    className="orchestration-result-status"
                  >
                    {resultStatus}
                  </span>
                </div>
                {(agent.result ||
                  agent.budgetReason ||
                  agent.failureReason ||
                  agent.changedPaths?.length ||
                  agent.workspaceIntegrationStatus) && (
                  <div className="orchestration-result-details">
                    {agent.result?.summary && <p>{agent.result.summary}</p>}
                    {agent.result?.checks?.length ? (
                      <ul
                        aria-label={t("Проверки результата")}
                        className="orchestration-result-checks"
                      >
                        {agent.result.checks.map((check, index) => (
                          <li key={`${index}:${check.name}`}>
                            <span>{check.name}</span>
                            <span className="orchestration-result-check-status">
                              {orchestrationCheckStatusLabel(check.outcome, t)}
                            </span>
                            {check.details && <small>{check.details}</small>}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {agent.budgetReason && (
                      <div className="orchestration-result-meta">
                        <strong>{t("Лимит")}</strong>
                        <span>
                          {agent.budgetReason === "timeout"
                            ? t("Истекло время")
                            : t("Исчерпан бюджет токенов")}
                        </span>
                      </div>
                    )}
                    {agent.failureReason && (
                      <div className="orchestration-result-meta">
                        <strong>{t("Причина")}</strong>
                        <span>{agent.failureReason}</span>
                      </div>
                    )}
                    {visibleChangedPaths?.length ? (
                      <div className="orchestration-result-meta">
                        <strong>{t("Изменения")}</strong>
                        <ul
                          aria-label={t("Изменённые файлы")}
                          className="orchestration-result-paths"
                        >
                          {visibleChangedPaths.map((path) => (
                            <li key={path}>
                              <code>{path}</code>
                            </li>
                          ))}
                        </ul>
                        {changedPathCount > visibleChangedPaths.length && (
                          <small>
                            {t("Показано {{shown}} из {{total}}", {
                              shown: visibleChangedPaths.length,
                              total: changedPathCount,
                            })}
                          </small>
                        )}
                      </div>
                    ) : null}
                    {agent.workspaceIntegrationStatus && (
                      <div className="orchestration-result-meta">
                        <strong>{t("Рабочая папка")}</strong>
                        <span>
                          {orchestrationWorkspaceIntegrationLabel(
                            agent.workspaceIntegrationStatus,
                            t,
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </article>
    );
  }
  if (item.type === "command") {
    return (
      <ActivityDetails
        icon={<TerminalIcon />}
        title={item.command || t("Выполнена команда")}
        status={item.status}
        technicalTitle={Boolean(item.command)}
      >
        {item.cwd && <div className="path">{item.cwd}</div>}
        <pre>{item.output || `$ ${item.command}`}</pre>
        {item.exitCode !== null && <small>exit {item.exitCode}</small>}
      </ActivityDetails>
    );
  }
  if (item.type === "fileChange") {
    return (
      <ActivityDetails
        icon={<FileIcon />}
        title={item.path ? t("Изменён {{path}}", { path: item.path }) : t("Изменены файлы")}
        status={item.status}
      >
        <pre>{item.patch}</pre>
      </ActivityDetails>
    );
  }
  if (item.type === "tool") {
    return (
      <ActivityDetails icon={<ToolIcon />} title={item.title} status={item.status}>
        {item.detail && <p>{localizeKnownServerText(language, item.detail)}</p>}
        {Boolean(item.images?.length) && (
          <MessageImageProvider
            text=""
            images={item.images}
            toolImages
            cwd={cwd}
            onLoadImage={onLoadImage}
            onDownload={onDownload}
          >
            <MessageImageGallery />
          </MessageImageProvider>
        )}
      </ActivityDetails>
    );
  }
  if (item.type === "error" || item.type === "unsupported") {
    return (
      <article
        className={`error-banner activity-error${item.failureKind === "modelCapacity" ? " activity-capacity" : ""}`}
      >
        <strong>{item.type === "unsupported" ? t("Несовместимое событие") : t("Ошибка")}</strong>
        <p>{localizeKnownServerText(language, item.message)}</p>
      </article>
    );
  }
  return null;
}

const MemoizedActivity = memo(Activity);

type NumberedAnnotation = {
  annotation: PendingAnnotation;
  number: number;
};

type AnnotationPosition = {
  left: number;
  top: number;
};

type SelectionDraft = AnnotationPosition & {
  quote: string;
  startOffset: number;
  endOffset: number;
  anchorTop: number;
};

type AnnotationEditor =
  | ({ mode: "new" } & SelectionDraft)
  | ({ mode: "existing"; annotationId: string; anchorTop: number } & AnnotationPosition);

function numberedAnnotations(
  annotations: PendingAnnotation[],
  messageId: string,
): NumberedAnnotation[] {
  return annotations.flatMap((annotation, index) =>
    annotation.messageId === messageId ? [{ annotation, number: index + 1 }] : [],
  );
}

function AnnotatableMarkdownContent({
  text,
  messageId,
  source,
  cwd,
  onDownload,
  onOpenArtifact,
  onLoadImage,
  annotations,
  enabled,
  readOnly,
  onCreate,
  onUpdate,
  onDelete,
}: {
  text: string;
  messageId: string;
  source: "agentMessage" | "plan";
  cwd?: string;
  onDownload?(path: string): Promise<void>;
  onOpenArtifact?(artifact: ArtifactDescriptor, opener: HTMLButtonElement | null): void;
  onLoadImage?: LocalImageLoader;
  annotations: NumberedAnnotation[];
  enabled: boolean;
  readOnly: boolean;
  onCreate?(draft: AnnotationDraft): boolean;
  onUpdate?(annotationId: string, comment: string): boolean;
  onDelete?(annotationId: string): boolean;
}) {
  const { t } = useI18n();
  const { message: annotationFontSize } = useTypography();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLFormElement>(null);
  const [editor, setEditor] = useState<AnnotationEditor | null>(null);
  const [comment, setComment] = useState("");
  const [markerPositions, setMarkerPositions] = useState<Record<string, AnnotationPosition>>({});

  const saveEditor = useCallback(() => {
    if (!editor) return true;
    const value = comment.trim();
    if (!value) {
      setEditor(null);
      return true;
    }
    const saved =
      editor.mode === "new"
        ? onCreate?.({
            messageId,
            source,
            quote: editor.quote,
            startOffset: editor.startOffset,
            endOffset: editor.endOffset,
            comment: value,
          })
        : onUpdate?.(editor.annotationId, value);
    if (saved) setEditor(null);
    return Boolean(saved);
  }, [comment, editor, messageId, onCreate, onUpdate, source]);

  const captureSelection = useCallback(() => {
    if (!enabled || editor) return;
    const content = contentRef.current;
    const surface = surfaceRef.current;
    const selection = window.getSelection();
    if (!content || !surface || !selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      return;
    }
    const range = selection.getRangeAt(0);
    const quote = range.toString();
    const offsets = quote.trim() ? rangeOffsets(content, range) : null;
    if (!offsets) return;
    const rect = safeRangeRect(range, content);
    const surfaceRect = surface.getBoundingClientRect();
    setComment("");
    setEditor({
      mode: "new",
      quote,
      ...offsets,
      left: clampPopoverLeft(rect.left + rect.width / 2 - surfaceRect.left, surface.clientWidth),
      top: rect.bottom - surfaceRect.top + 8,
      anchorTop: rect.top - surfaceRect.top,
    });
  }, [editor, enabled]);

  const positionMarkers = useCallback(() => {
    const content = contentRef.current;
    const surface = surfaceRef.current;
    if (!content || !surface) return;
    const surfaceRect = surface.getBoundingClientRect();
    const next: Record<string, AnnotationPosition> = {};
    const occupied: AnnotationPosition[] = [];
    for (const { annotation } of annotations) {
      const range = resolveAnnotationRange(content, annotation);
      if (!range) continue;
      const rect = safeRangeRect(range, content);
      const position = {
        left: Math.max(0, Math.min(rect.right - surfaceRect.left + 4, surface.clientWidth - 22)),
        top: Math.max(0, rect.bottom - surfaceRect.top - 20),
      };
      while (
        occupied.some(
          (candidate) =>
            Math.abs(candidate.left - position.left) < 22 &&
            Math.abs(candidate.top - position.top) < 22,
        )
      ) {
        position.left += 22;
      }
      occupied.push(position);
      next[annotation.id] = position;
    }
    setMarkerPositions(next);
  }, [annotations]);

  useLayoutEffect(() => {
    positionMarkers();
  }, [positionMarkers, text]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(positionMarkers);
    observer?.observe(content);
    window.addEventListener("resize", positionMarkers);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", positionMarkers);
    };
  }, [positionMarkers]);

  useEffect(() => {
    if (
      readOnly ||
      (editor?.mode === "existing" &&
        !annotations.some(({ annotation }) => annotation.id === editor.annotationId))
    ) {
      setEditor(null);
    }
  }, [annotations, editor, readOnly]);

  const positionEditor = useCallback(() => {
    const form = editorRef.current;
    const surface = surfaceRef.current;
    if (!editor || !form || !surface) return;
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const scrollBounds = surface.closest(".conversation-scroll")?.getBoundingClientRect();
    const left = Math.max(viewportLeft, scrollBounds?.left ?? viewportLeft) + 16;
    const right =
      Math.min(viewportLeft + viewportWidth, scrollBounds?.right ?? viewportLeft + viewportWidth) -
      16;
    const top = Math.max(viewportTop, scrollBounds?.top ?? viewportTop) + 16;
    const bottom =
      Math.min(viewportTop + viewportHeight, scrollBounds?.bottom ?? viewportTop + viewportHeight) -
      16;
    form.style.maxWidth = `${Math.max(0, right - left)}px`;
    const field = form.querySelector("textarea");
    if (field) field.style.maxHeight = `${Math.max(56, Math.min(176, bottom - top - 24))}px`;
    const bounds = surface.getBoundingClientRect();
    const formBounds = form.getBoundingClientRect();
    const center = bounds.left + editor.left;
    form.style.left = `${Math.max(left + formBounds.width / 2, Math.min(center, right - formBounds.width / 2)) - bounds.left}px`;
    const below = bounds.top + editor.top;
    const above = bounds.top + editor.anchorTop - formBounds.height - 8;
    const preferred = below + formBounds.height <= bottom ? below : above;
    form.style.top = `${Math.max(top, Math.min(preferred, bottom - formBounds.height)) - bounds.top}px`;
  }, [editor]);

  const resizeEditor = useCallback(() => {
    const field = editorRef.current?.querySelector("textarea");
    if (!field) return;
    positionEditor();
    const scrollTop = field.scrollTop;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
    field.scrollTop = scrollTop;
    positionEditor();
  }, [positionEditor]);

  useLayoutEffect(() => {
    resizeEditor();
  }, [comment, resizeEditor, annotationFontSize]);

  useEffect(() => {
    if (!editor) return;
    const viewport = window.visualViewport;
    window.addEventListener("resize", resizeEditor);
    document.addEventListener("scroll", positionEditor, true);
    viewport?.addEventListener("resize", resizeEditor);
    viewport?.addEventListener("scroll", positionEditor);
    return () => {
      window.removeEventListener("resize", resizeEditor);
      document.removeEventListener("scroll", positionEditor, true);
      viewport?.removeEventListener("resize", resizeEditor);
      viewport?.removeEventListener("scroll", positionEditor);
    };
  }, [editor, positionEditor, resizeEditor]);

  useEffect(() => {
    const content = contentRef.current;
    const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (editor?.mode !== "new" || !content || !highlights || typeof Highlight === "undefined") {
      return;
    }
    const range = resolveAnnotationRange(content, editor);
    if (!range) return;
    highlights.set("annotation-selection", new Highlight(range));
    return () => {
      highlights.delete("annotation-selection");
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && editorRef.current?.contains(event.target)) return;
      if (!saveEditor()) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [editor, saveEditor]);

  function openExistingEditor(item: NumberedAnnotation) {
    const position = markerPositions[item.annotation.id] ?? { left: 0, top: 0 };
    setComment(item.annotation.comment);
    setEditor({
      mode: "existing",
      annotationId: item.annotation.id,
      left: position.left,
      top: position.top + 28,
      anchorTop: position.top,
    });
  }

  const editedAnnotation =
    editor?.mode === "existing"
      ? annotations.find(({ annotation }) => annotation.id === editor.annotationId)
      : null;

  return (
    <div className="annotation-surface" ref={surfaceRef}>
      <div
        className="message-markdown"
        ref={contentRef}
        onPointerUp={() => window.setTimeout(captureSelection, 0)}
        onKeyUp={captureSelection}
      >
        <MarkdownContent
          text={text}
          cwd={cwd}
          onDownload={onDownload}
          onOpenArtifact={onOpenArtifact}
          onLoadImage={onLoadImage}
        />
      </div>
      {annotations.map((item) => {
        const position = markerPositions[item.annotation.id];
        return position ? (
          <button
            type="button"
            className="annotation-marker"
            data-annotation-id={item.annotation.id}
            style={{ left: position.left, top: position.top }}
            aria-label={t("Аннотация {{number}}", { number: item.number })}
            disabled={readOnly}
            onClick={() => openExistingEditor(item)}
            key={item.annotation.id}
          >
            {item.number}
          </button>
        ) : null;
      })}
      {editor && (
        <form
          ref={editorRef}
          className="annotation-editor"
          style={{ left: editor.left, top: editor.top }}
          onSubmit={(event) => {
            event.preventDefault();
            saveEditor();
          }}
        >
          <textarea
            autoFocus
            aria-label={t("Комментарий к выделенному тексту")}
            placeholder={t("Комментарий")}
            rows={2}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveEditor();
              } else if (event.key === "Escape") {
                setEditor(null);
              }
            }}
            onCopy={(event) => {
              const field = event.currentTarget;
              if (editor.mode !== "new" || field.selectionStart !== field.selectionEnd) return;
              event.clipboardData.setData("text/plain", editor.quote);
              event.preventDefault();
            }}
          />
          <div className="annotation-editor-actions">
            <button
              className="annotation-editor-delete"
              type="button"
              aria-label={t("Удалить аннотацию")}
              title={t("Удалить аннотацию")}
              onClick={() => {
                if (!editedAnnotation || onDelete?.(editedAnnotation.annotation.id)) {
                  setEditor(null);
                }
              }}
            >
              <TrashIcon />
            </button>
            <button
              className="annotation-editor-save"
              type="submit"
              aria-label={t("Сохранить аннотацию")}
              title={t("Сохранить аннотацию")}
              disabled={!comment.trim()}
            >
              <SendIcon />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function safeRangeRect(range: Range, fallback: HTMLElement): DOMRect {
  return typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : fallback.getBoundingClientRect();
}

function clampPopoverLeft(left: number, width: number): number {
  if (width <= 0) return Math.max(0, left);
  return Math.max(76, Math.min(left, width - 76));
}

function ActivityGroup({
  items,
  cwd,
  onDownload,
  onLoadImage,
  onOpenArtifact,
}: {
  items: ActivityItem[];
  cwd: string;
  onDownload(path: string): Promise<void>;
  onLoadImage?: LocalImageLoader;
  onOpenArtifact?(artifact: ArtifactDescriptor, opener: HTMLButtonElement | null): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const inProgress = items.some((item) => item.status === "inProgress");
  const labels: string[] = [];
  if (items.some((item) => item.type === "command" && item.kind === "read")) {
    labels.push(t("Прочитаны файлы"));
  }
  if (items.some((item) => item.type === "command" && item.kind === "search")) {
    labels.push(t("Выполнен поиск"));
  }
  if (items.some((item) => item.type === "command" && item.kind === "command")) {
    labels.push(t("Выполнены команды"));
  }
  if (items.some((item) => item.type === "fileChange")) labels.push(t("Отредактированы файлы"));
  if (items.some((item) => item.type === "tool")) labels.push(t("Использованы инструменты"));
  return (
    <details className="activity-group" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="activity-group-icon">
          <ToolIcon />
        </span>
        <span>{labels.join(" · ") || t("Выполнены действия")}</span>
        {inProgress && <span className="spinner small" />}
      </summary>
      {open && (
        <div className="activity-group-content">
          {items.map((item) => (
            <MemoizedActivity
              item={item}
              cwd={cwd}
              onDownload={onDownload}
              onLoadImage={onLoadImage}
              onOpenArtifact={onOpenArtifact}
              key={item.id}
            />
          ))}
        </div>
      )}
    </details>
  );
}

const MemoizedActivityGroup = memo(ActivityGroup);

function TurnActivityDisclosure({
  turn,
  active,
  waitingForUserInput,
  capacityRetryAt,
  items,
  loaded,
  interactive,
  onLoad,
  cwd,
  onDownload,
  onLoadImage,
  onOpenArtifact,
  children,
}: {
  children(status: React.ReactNode, journal: React.ReactNode): React.ReactNode;
  turn: TurnView;
  active: boolean;
  waitingForUserInput: boolean;
  capacityRetryAt?: number;
  items: ActivityItem[];
  loaded: boolean;
  interactive: boolean;
  onLoad(turnId: string): Promise<void>;
  cwd: string;
  onDownload(path: string): Promise<void>;
  onLoadImage?: LocalImageLoader;
  onOpenArtifact?(artifact: ArtifactDescriptor, opener: HTMLButtonElement | null): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const loadAttempted = useRef(false);
  const journalId = useId();
  const visibleItems = items.filter(hasVisibleActivity);

  const load = useCallback(() => {
    if (loading || loaded || loadAttempted.current) return;
    loadAttempted.current = true;
    setLoading(true);
    setError(false);
    void onLoad(turn.id)
      .catch(() => {
        loadAttempted.current = false;
        setError(true);
      })
      .finally(() => setLoading(false));
  }, [loaded, loading, onLoad, turn.id]);

  const canOpen = interactive && (!loaded || visibleItems.length > 0);
  const status = useMemo(
    () => (
      <TurnActivityStatus
        turn={turn}
        active={active}
        waitingForUserInput={waitingForUserInput}
        capacityRetryAt={capacityRetryAt}
        loading={loading}
        disclosure={
          canOpen
            ? {
                open,
                journalId,
                onToggle: () => {
                  setOpen(!open);
                  if (!open) load();
                },
              }
            : undefined
        }
      />
    ),
    [turn, active, waitingForUserInput, capacityRetryAt, loading, canOpen, open, journalId, load],
  );
  if (!active && turn.status === "inProgress") return children(null, null);
  const journal = canOpen ? (
    <div className="turn-activity-journal" id={journalId} hidden={!open}>
      {open && (
        <>
          {error && (
            <button type="button" className="history-retry" onClick={load}>
              {t("Повторить загрузку технических деталей")}
            </button>
          )}
          {loaded &&
            visibleItems.map((item) => (
              <MemoizedActivity
                item={item}
                cwd={cwd}
                onDownload={onDownload}
                onLoadImage={onLoadImage}
                onOpenArtifact={onOpenArtifact}
                key={item.id}
              />
            ))}
        </>
      )}
    </div>
  ) : null;
  return children(status, journal);
}

export function QueuedMessages({
  messages,
  action,
  canSendNow = true,
  onSendNow,
  onUpdate,
  onDelete,
  inTimeline = false,
  onRetry,
  cwd,
  onDownload,
  onOpenArtifact,
  onLoadImage,
}: {
  onLoadImage?: LocalImageLoader;
  cwd?: string;
  onDownload?(path: string): Promise<void>;
  onOpenArtifact?(artifact: ArtifactDescriptor, opener: HTMLButtonElement | null): void;
  messages: QueuedMessageView[];
  action: QueueAction | null;
  canSendNow?: boolean;
  onSendNow(messageId: string): Promise<boolean>;
  onUpdate(messageId: string, value: string, pastes?: PastedText): Promise<boolean>;
  onDelete(messageId: string): Promise<boolean>;
  inTimeline?: boolean;
  onRetry?(messageId: string): Promise<void>;
}) {
  const { language, t } = useI18n();
  const { message: messageFontSize } = useTypography();
  const [editor, setEditor] = useState<({ messageId: string; value: string } & PastedText) | null>(
    null,
  );
  const editorFieldRef = useRef<HTMLTextAreaElement>(null);
  const nativeFieldSizing = useMemo(
    () => typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"),
    [],
  );
  const resizeEditor = useCallback(() => {
    const field = editorFieldRef.current;
    if (!field || nativeFieldSizing) return;
    const scrollTop = field.scrollTop;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
    field.scrollTop = scrollTop;
  }, [nativeFieldSizing]);

  useLayoutEffect(() => {
    resizeEditor();
  }, [editor, resizeEditor, messageFontSize]);

  const editorMessageId = editor?.messageId;
  useEffect(() => {
    const field = editorFieldRef.current;
    if (!editorMessageId || !field || nativeFieldSizing) return;
    let width = field.getBoundingClientRect().width;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const nextWidth = field.getBoundingClientRect().width;
            if (nextWidth === width) return;
            width = nextWidth;
            resizeEditor();
          });
    observer?.observe(field);
    window.addEventListener("resize", resizeEditor);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resizeEditor);
    };
  }, [editorMessageId, nativeFieldSizing, resizeEditor]);

  useEffect(() => {
    if (
      editor &&
      !messages.some(
        (message) =>
          message.id === editor.messageId && message.confirmed && message.status === "queued",
      )
    ) {
      setEditor(null);
    }
  }, [editor, messages]);

  if (!messages.length) return null;
  return (
    <section
      className={inTimeline ? "outgoing-messages" : "queued-messages"}
      aria-label={t("Очередь сообщений")}
    >
      {!inTimeline && (
        <header className="queued-messages-header">
          <span>{t("Очередь сообщений")}</span>
          <span className="queued-messages-count">
            <span aria-hidden="true">·</span>
            {messages.length}
          </span>
        </header>
      )}
      <div className="queued-messages-list">
        {messages.map((message, index) => {
          const editing = editor?.messageId === message.id;
          const busy = action?.messageId === message.id;
          const actionsDisabled =
            action !== null || !message.confirmed || message.status === "dispatching";
          const retryUnconfirmed =
            message.confirmed && message.status === "dispatching" && Boolean(message.deliveryError);
          const editValue = editing ? editor.value : "";
          const canSave =
            Boolean(
              editValue.trim() ||
              message.images?.length ||
              message.files?.length ||
              editor?.pasteBlocks?.length,
            ) &&
            (editValue.trim() !== message.text ||
              JSON.stringify(pastedText(editor ?? {})) !== JSON.stringify(pastedText(message)));
          const status = message.deliveryError
            ? localizeKnownServerText(language, message.deliveryError.message)
            : !message.confirmed
              ? t("Добавляется…")
              : action?.messageId === message.id && action.kind === "delete"
                ? t("Удаляем…")
                : action?.messageId === message.id && action.kind === "update"
                  ? t("Сохраняем…")
                  : message.status === "dispatching" ||
                      (action?.messageId === message.id && action.kind === "send")
                    ? t("Отправляется…")
                    : t("В очереди");
          return (
            <article
              className={`queued-message message userMessage${message.pasteBlocks?.length ? " message-with-pastes" : ""}${editing ? " queued-message-editing" : ""}`}
              data-message-id={message.id}
              key={message.id}
            >
              {!inTimeline && (
                <span className="queued-message-order" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
              )}
              {!editing && <PasteBlocks blocks={message.pasteBlocks} />}
              <div className="queued-message-content message-body">
                {editing ? (
                  <div className="queued-message-editor">
                    <PasteMessageEditor
                      identity={message.id}
                      ref={editorFieldRef}
                      autoFocus
                      aria-label={t("Текст сообщения в очереди")}
                      rows={1}
                      value={{ input: editValue, ...pastedText(editor ?? {}) }}
                      disabled={busy}
                      onValueChange={(next) =>
                        setEditor({ messageId: message.id, value: next.input, ...pastedText(next) })
                      }
                    />
                    <div className="queued-message-editor-actions">
                      <button type="button" disabled={busy} onClick={() => setEditor(null)}>
                        {t("Отмена")}
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy || !canSave}
                        onClick={() => {
                          void onUpdate(
                            message.id,
                            editValue,
                            message.inlinePastes?.length ||
                              message.pasteBlocks?.length ||
                              editor?.inlinePastes?.length ||
                              editor?.pasteBlocks?.length
                              ? {
                                  inlinePastes: editor?.inlinePastes ?? [],
                                  pasteBlocks: editor?.pasteBlocks ?? [],
                                }
                              : undefined,
                          ).then((saved) => {
                            if (saved) setEditor(null);
                          });
                        }}
                      >
                        <ActionLabel idle={t("Сохранить")} busy={t("Сохраняем…")} pending={busy} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {message.text && (
                      <div className="queued-message-text">
                        <MarkdownContent
                          text={message.text}
                          inlinePastes={message.inlinePastes}
                          onLoadImage={onLoadImage}
                          cwd={cwd}
                          onDownload={onDownload}
                          onOpenArtifact={onOpenArtifact}
                        />
                      </div>
                    )}
                    {(message.images?.length ?? 0) > 0 && (
                      <MessageImages images={message.images ?? []} />
                    )}
                    {(message.files?.length ?? 0) > 0 && (
                      <MessageFiles files={message.files ?? []} onDownload={onDownload} />
                    )}
                  </>
                )}
              </div>
              <footer className="message-footer queued-message-footer">
                <div className="queued-message-heading">
                  {inTimeline && (
                    <span className="outgoing-delivery-status" role="status">
                      {message.confirmed || message.serverAccepted
                        ? t("В очереди")
                        : message.deliveryError
                          ? t("Сохранено на устройстве")
                          : t("Отправляется…")}
                    </span>
                  )}
                  {(!inTimeline ||
                    message.deliveryError ||
                    busy ||
                    message.status === "dispatching") && (
                    <span className="queued-message-status" title={status ?? undefined}>
                      {status}
                    </span>
                  )}
                </div>
                <div className="queued-message-actions">
                  {(message.deliveryError || !message.confirmed) &&
                    (message.text || message.pasteBlocks?.length) && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t("Скопировать сообщение")}
                        title={t("Скопировать сообщение")}
                        onClick={() => void copyText(copyPastedMessage(message.text, message))}
                      >
                        <CopyIcon />
                      </button>
                    )}
                  {onRetry &&
                    !message.confirmed &&
                    !message.serverAccepted &&
                    message.deliveryError && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t("Повторить отправку")}
                        disabled={!canSendNow}
                        onClick={() => void onRetry(message.id)}
                      >
                        <RefreshIcon />
                      </button>
                    )}
                  <span className="queued-action-slot">
                    {!editing && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t("Изменить сообщение в очереди")}
                        title={t("Изменить сообщение в очереди")}
                        disabled={actionsDisabled}
                        onClick={() =>
                          setEditor({
                            messageId: message.id,
                            value: message.text,
                            ...pastedText(message),
                          })
                        }
                      >
                        <PencilIcon />
                      </button>
                    )}
                  </span>
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={t("Удалить сообщение из очереди")}
                    title={t("Удалить сообщение из очереди")}
                    disabled={actionsDisabled}
                    onClick={() => void onDelete(message.id)}
                  >
                    <TrashIcon />
                  </button>
                  <span className="queued-action-slot">
                    {canSendNow && (
                      <button
                        type="button"
                        className="icon-button queued-message-send"
                        aria-label={t(retryUnconfirmed ? "Повторить отправку" : "Отправить сейчас")}
                        title={t(retryUnconfirmed ? "Повторить отправку" : "Отправить сейчас")}
                        disabled={retryUnconfirmed ? action !== null : actionsDisabled}
                        onClick={() => void onSendNow(message.id)}
                      >
                        {retryUnconfirmed ? <RefreshIcon /> : <SendIcon />}
                      </button>
                    )}
                  </span>
                </div>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function MessageImages({ images }: { images: string[] }) {
  const { t } = useI18n();
  const [viewer, setViewer] = useState<{ index: number; opener: HTMLButtonElement } | null>(null);
  const viewerImages = images.map((src, index) => ({
    src,
    alt: t("Изображение {{number}}", { number: index + 1 }),
  }));

  useEffect(() => {
    if (viewer && viewer.index >= images.length) setViewer(null);
  }, [images.length, viewer]);

  return (
    <>
      <div className="message-images">
        {viewerImages.map((image, index) => (
          <button
            type="button"
            className="message-image-preview"
            aria-label={t("Открыть изображение {{number}}", { number: index + 1 })}
            key={`${index}:${image.src.slice(-24)}`}
            onClick={(event) => setViewer({ index, opener: event.currentTarget })}
          >
            <img src={image.src} alt={image.alt} />
          </button>
        ))}
      </div>
      {viewer && (
        <ImageViewer
          images={viewerImages}
          index={viewer.index}
          opener={viewer.opener}
          onIndexChange={(index) => setViewer({ ...viewer, index })}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}

function MessageFiles({
  files,
  onDownload,
}: {
  files: ReadonlyArray<{ name: string; path: string }>;
  onDownload?(path: string): Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <div className="message-files" aria-label={t("Файлы")}>
      {files.map((file, index) => {
        const content = (
          <>
            <FileIcon />
            <span>{file.name}</span>
          </>
        );
        return onDownload ? (
          <button
            type="button"
            className="message-file"
            key={`${index}:${file.path}`}
            title={t("Скачать файл {{name}}", { name: file.name })}
            onClick={() => void onDownload(file.path)}
          >
            {content}
          </button>
        ) : (
          <span className="message-file" key={`${index}:${file.path}`} title={file.name}>
            {content}
          </span>
        );
      })}
    </div>
  );
}

function MessageFooter({
  text,
  timestamp,
  forkAction,
  markdown = false,
  status,
}: {
  text: string;
  timestamp: number | null;
  forkAction?: { disabled: boolean; onFork(opener?: HTMLElement): void };
  markdown?: boolean;
  status?: React.ReactNode;
}) {
  const { language, t } = useI18n();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<number | null>(null);
  const canCopy = Boolean(text.trim());

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy() {
    try {
      await (markdown ? copyMarkdown(text) : copyText(text));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopyState("idle"), 1_800);
  }

  return (
    <footer className={`message-footer${status ? " message-footer-with-status" : ""}`}>
      {copyState === "copied" && (
        <span className="message-footer-feedback" role="status">
          {t("Скопировано")}
        </span>
      )}
      {copyState === "failed" && (
        <span className="message-footer-feedback" role="alert">
          {t("Не удалось скопировать")}
        </span>
      )}
      <span className="message-footer-actions">
        {timestamp !== null && (
          <time dateTime={new Date(timestamp).toISOString()}>
            {formatMessageTime(timestamp, language)}
          </time>
        )}
        {canCopy && (
          <button type="button" aria-label={t("Копировать сообщение")} onClick={() => void copy()}>
            <CopyIcon />
          </button>
        )}
        {forkAction && (
          <button
            type="button"
            aria-busy={forkAction.disabled}
            aria-label={t("Создать ответвление отсюда")}
            disabled={forkAction.disabled}
            title={t("Создать ответвление отсюда")}
            onClick={(event) => forkAction.onFork(event.currentTarget)}
          >
            <GitBranchIcon />
          </button>
        )}
      </span>
      {status}
    </footer>
  );
}

function TurnActivityStatus({
  turn,
  progress = turn?.progress,
  active = turn?.status === "inProgress",
  waitingForUserInput = false,
  capacityRetryAt,
  loading = false,
  disclosure,
}: {
  turn?: TurnView;
  progress?: TurnProgress;
  active?: boolean;
  waitingForUserInput?: boolean;
  capacityRetryAt?: number;
  loading?: boolean;
  disclosure?: { open: boolean; journalId: string; onToggle(): void };
}) {
  const { language, t } = useI18n();
  const isActive = active;
  const capacityFailure =
    turn?.failureKind === "modelCapacity" ||
    turn?.items.some((item) => item.type === "error" && item.failureKind === "modelCapacity");
  const isWaiting = (isActive && waitingForUserInput) || capacityRetryAt !== undefined;
  const retryRemaining = useCountdown(capacityRetryAt);
  const showSpinner = !isWaiting && (isActive || loading);
  const startedAt = turn?.startedAt ?? progress?.startedAt ?? null;
  const elapsed = useElapsed(
    startedAt ?? 0,
    isActive && !isWaiting && startedAt !== null,
    language,
  );
  const duration = turn
    ? (turn.durationMs ??
      (startedAt === null || turn.completedAt === null
        ? null
        : Math.max(0, turn.completedAt - startedAt)))
    : null;
  const label =
    capacityRetryAt !== undefined
      ? retryRemaining > 0
        ? t(
            "Возникла ошибка перегрузки модели. Продолжаем попытки — следующая через {{duration}}",
            {
              duration: formatDuration(retryRemaining, language),
            },
          )
        : t("Возникла ошибка перегрузки модели. Продолжаем попытки…")
      : isWaiting
        ? t("Ждёт вашего ответа")
        : capacityFailure
          ? isActive
            ? t("Возникла ошибка перегрузки модели. Продолжаем попытки…")
            : t("Перегрузка модели")
          : isActive
            ? progress?.explanation?.trim() || t("Codex работает")
            : turn
              ? turnOutcomeLabel(turn.status, duration, language, t)
              : t("Codex работает");
  const content = (
    <>
      {(isWaiting || showSpinner || turn?.status !== "completed") && (
        <span
          className={`turn-activity-state turn-activity-state-${isWaiting || capacityFailure ? "waiting" : showSpinner ? "active" : (turn?.status ?? "active")}`}
          aria-hidden="true"
        >
          {isWaiting || capacityFailure ? (
            <ClockIcon />
          ) : showSpinner ? (
            <span className="spinner small" />
          ) : turn?.status === "failed" ? (
            <XIcon />
          ) : (
            <StopIcon />
          )}
        </span>
      )}
      <span className="turn-activity-phase" role={isActive || isWaiting ? "status" : undefined}>
        {label}
      </span>
    </>
  );
  return (
    <div className={`turn-activity-row${disclosure ? "" : " turn-activity-static"}`}>
      {disclosure ? (
        <button
          type="button"
          className="turn-activity-copy turn-activity-toggle"
          aria-label={t("Технические детали")}
          aria-expanded={disclosure.open}
          aria-controls={disclosure.journalId}
          aria-busy={loading || undefined}
          onClick={disclosure.onToggle}
        >
          {content}
        </button>
      ) : (
        <span className="turn-activity-copy">{content}</span>
      )}
      {isActive && !isWaiting && startedAt !== null && (
        <span className="turn-activity-duration" aria-live="off">
          {elapsed}
        </span>
      )}
    </div>
  );
}

function turnOutcomeLabel(
  status: TurnView["status"],
  duration: number | null,
  language: UiLanguage,
  t: Translate,
): string {
  if (status === "completed") {
    return duration === null
      ? t("Готово")
      : t("Готово за {{duration}}", { duration: formatDuration(duration, language) });
  }
  if (status === "failed") {
    return duration === null
      ? t("Ошибка")
      : t("Ошибка через {{duration}}", { duration: formatDuration(duration, language) });
  }
  return duration === null
    ? t("Прервано")
    : t("Прервано через {{duration}}", { duration: formatDuration(duration, language) });
}

export function formatMessageTime(timestamp: number, language: UiLanguage = "ru"): string {
  const value = new Date(timestamp);
  const today = new Date();
  const locale = language === "ru" ? "ru-RU" : "en-US";
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
  if (value.toDateString() === today.toDateString()) return time;
  return `${new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(value)}, ${time}`;
}

function useCountdown(deadline?: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (deadline === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return deadline === undefined ? 0 : Math.max(0, deadline - now);
}

function useElapsed(startedAt: number, active = true, language: UiLanguage = "ru"): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  return formatDuration(Math.max(0, now - startedAt), language);
}

function formatDuration(durationMs: number, language: UiLanguage = "ru"): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (language === "en") {
    if (hours) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  }
  if (hours) return `${hours}ч ${minutes % 60}м ${seconds % 60}с`;
  return minutes ? `${minutes}м ${seconds % 60}с` : `${seconds}с`;
}

function isUserEntry(entry: ActivityItem | ActivityItem[] | undefined): boolean {
  return Boolean(
    entry &&
    !Array.isArray(entry) &&
    (entry.type === "userMessage" || entry.type === "userInputResponse"),
  );
}

// Style adjacent pieces as one surface without reparenting live messages or forms.
// Their keys and DOM nodes survive streaming, question updates and user steering.
function responsePieceClass(entries: Array<ActivityItem | ActivityItem[]>, index: number): string {
  if (isUserEntry(entries[index])) return "turn-entry user-entry";
  const start = index === 0 || isUserEntry(entries[index - 1]);
  const end = isUserEntry(entries[index + 1]);
  return `turn-entry response-piece${start ? " response-start" : ""}${end ? " response-end" : ""}`;
}

function responseSurfaceRows(
  entries: Array<ActivityItem | ActivityItem[]>,
): Array<[number, number]> {
  const rows: Array<[number, number]> = [];
  let start: number | null = null;
  // The final row contains the stable question forms and activity disclosure.
  for (let index = 0; index <= entries.length; index++) {
    if (isUserEntry(entries[index])) {
      if (start !== null) rows.push([start, index]);
      start = null;
    } else {
      start ??= index;
    }
  }
  if (start !== null) rows.push([start, entries.length + 1]);
  return rows;
}

function groupActivities(items: ActivityItem[]): Array<ActivityItem | ActivityItem[]> {
  const result: Array<ActivityItem | ActivityItem[]> = [];
  const questionOccurrences = new Map<string, number>();
  let group: ActivityItem[] = [];
  const flush = () => {
    if (group.length) result.push(group);
    group = [];
  };
  for (const item of activitiesForDisplay(items)) {
    if (!hasVisibleActivity(item)) continue;
    const nativeLaunch = isNativeSubagentLaunch(item);
    if (
      nativeLaunch ||
      (["command", "fileChange", "tool"].includes(item.type) && isTechnicalActivity(item))
    ) {
      if (group.length && isNativeSubagentLaunch(group[0]!) !== nativeLaunch) flush();
      group.push(item);
    } else {
      flush();
      if (item.type === "agentMessage" && item.questionKey) {
        // Repeated identical question sets are independent, while live/history
        // ID aliases must keep the same form state and reply identity.
        const occurrence = questionOccurrences.get(item.questionKey) ?? 0;
        questionOccurrences.set(item.questionKey, occurrence + 1);
        result.push(
          occurrence ? { ...item, questionKey: `${item.questionKey}:${occurrence}` } : item,
        );
      } else {
        result.push(item);
      }
    }
  }
  flush();
  return result;
}

function isTechnicalActivity(item: ActivityItem): boolean {
  return ["reasoning", "command", "fileChange", "tool"].includes(item.type);
}

function activitiesForThreadDisplay(items: ActivityItem[], isSubagent: boolean): ActivityItem[] {
  if (!isSubagent) return items;
  return items.filter(
    (item) =>
      item.type === "userMessage" || item.type === "agentMessage" || isNativeSubagentLaunch(item),
  );
}

function activitiesForDisplay(items: ActivityItem[]): ActivityItem[] {
  const finalAnswerIndex = items.findIndex(
    (item) => item.type === "agentMessage" && item.phase === "final_answer",
  );
  if (finalAnswerIndex < 0) return items;
  const trailingItems = items.slice(finalAnswerIndex + 1);
  const trailingChecklists = trailingItems.filter((item) => item.type === "planChecklist");
  if (!trailingChecklists.length) return items;
  return [
    ...items.slice(0, finalAnswerIndex),
    ...trailingChecklists,
    items[finalAnswerIndex]!,
    ...trailingItems.filter((item) => item.type !== "planChecklist"),
  ];
}

function reconcileVisibleThreadSummary(
  snapshotSummary: ThreadSummary | undefined,
  detail: ThreadDetail | undefined,
  snapshotInstanceId: string | undefined,
  snapshotSequence: number | undefined,
): ThreadSummary | undefined {
  if (!snapshotSummary) return detail?.summary;
  if (!detail) return snapshotSummary;
  const detailVersion = detail.version;
  if (
    detailVersion &&
    detailVersion.instanceId === snapshotInstanceId &&
    snapshotSequence !== undefined &&
    detailVersion.sequence >= snapshotSequence
  ) {
    return detail.summary;
  }
  if (snapshotSummary.currentTurnId) return snapshotSummary;
  if (detail.summary.currentTurnId && detail.summary.updatedAt >= snapshotSummary.updatedAt) {
    return detail.summary;
  }
  return snapshotSummary.updatedAt >= detail.summary.updatedAt ? snapshotSummary : detail.summary;
}

function hasVisibleActivity(item: ActivityItem): boolean {
  if (item.type === "userMessage" && isQuestionReplyDelivery(item)) return false;
  if ("text" in item)
    return Boolean(
      item.text.trim() ||
      item.pasteBlocks?.length ||
      item.images.length ||
      (item.files?.length ?? 0) ||
      item.questions?.length,
    );
  return true;
}

function isQuestionReplyDelivery(message: {
  id: string;
  replyToAsyncQuestion?: unknown;
  replyToUserInput?: unknown;
}): boolean {
  return Boolean(
    message.replyToAsyncQuestion ||
    message.replyToUserInput ||
    QUESTION_REPLY_MESSAGE_ID_PREFIXES.some((prefix) => message.id.startsWith(prefix)),
  );
}

function findForkResponseId(turn: TurnView): string | null {
  if (turn.status !== "completed") return null;
  return (
    [...turn.items]
      .reverse()
      .find(
        (item) =>
          (item.type === "agentMessage" || item.type === "plan") &&
          item.status === "completed" &&
          Boolean(item.text.trim()),
      )?.id ?? null
  );
}

function orchestrationOutcomeLabel(
  outcome: "completed" | "failed" | "interrupted",
  t: Translate,
): string {
  if (outcome === "failed") return t("Ошибка");
  if (outcome === "interrupted") return t("Прервана");
  return t("Завершена");
}

function orchestrationResultOutcomeLabel(outcome: string, t: Translate): string {
  switch (outcome) {
    case "success":
      return t("Успешно");
    case "partial":
      return t("Частично");
    case "failed":
      return t("Ошибка");
    case "blocked":
      return t("Заблокировано");
    default:
      return outcome;
  }
}

function orchestrationCheckStatusLabel(status: string, t: Translate): string {
  switch (status) {
    case "passed":
      return t("Пройдена");
    case "failed":
      return t("Ошибка");
    case "notRun":
      return t("Не запускалась");
    default:
      return status;
  }
}

function orchestrationWorkspaceIntegrationLabel(status: string, t: Translate): string {
  switch (status) {
    case "integrated":
      return t("Изменения интегрированы");
    case "ready":
      return t("Изолированная рабочая папка готова");
    case "creating":
    case "integrating":
      return t("Интегрируем изменения");
    case "conflicted":
      return t("Конфликт интеграции");
    case "discarding":
    case "discarded":
      return t("Интеграция не требуется");
    case "recoveryRequired":
      return t("Интеграция требует восстановления");
    default:
      return status;
  }
}

function findLatestPlan(turns: TurnView[] = []) {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex]!;
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex]!;
      if (item.type !== "plan" || !item.text.trim()) continue;
      const needsUpdate =
        turnIndex !== turns.length - 1 ||
        turn.items
          .slice(itemIndex + 1)
          .some((later) => later.type === "userMessage" || later.type === "userInputResponse");
      return {
        item,
        turn,
        needsUpdate,
        ready: !needsUpdate && turn.status === "completed" && item.status === "completed",
      };
    }
  }
  return null;
}

function findLatestAnnotatable(
  detail: ThreadDetail | undefined,
  currentTurnId: string | null,
): string | null {
  if (!detail || currentTurnId) return null;
  for (const turn of [...detail.turns].reverse()) {
    if (turn.status === "inProgress") continue;
    for (const item of [...turn.items].reverse()) {
      if (
        (item.type === "agentMessage" || item.type === "plan") &&
        item.status === "completed" &&
        Boolean(item.text.trim())
      ) {
        return item.id;
      }
    }
  }
  return null;
}

function scrollToEnd(node: HTMLDivElement | null, behavior: ScrollBehavior = "auto") {
  if (!node) return;
  if (typeof node.scrollTo === "function") {
    node.scrollTo({ top: node.scrollHeight, behavior });
  } else {
    node.scrollTop = node.scrollHeight;
  }
}

function ActivityDetails({
  icon,
  title,
  status,
  technicalTitle = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  status: string;
  technicalTitle?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <details className="activity-card" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="activity-icon" aria-hidden="true">
          {icon}
        </span>
        <span className={`activity-title${technicalTitle ? " technical" : ""}`}>{title}</span>
        <span className={`activity-status activity-status-${status}`}>
          {status === "completed" ? (
            <>
              <CheckIcon aria-hidden="true" />
              <span className="sr-only">{statusLabel(status, t)}</span>
            </>
          ) : (
            statusLabel(status, t)
          )}
        </span>
        <ChevronDownIcon className="activity-chevron" aria-hidden="true" />
      </summary>
      {open && <div className="activity-content">{children}</div>}
    </details>
  );
}

function RenameDialog({
  initialValue,
  onClose,
  onRename,
}: {
  initialValue: string;
  onClose(): void;
  onRename(value: string): Promise<void>;
}) {
  const { language, t } = useI18n();
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      titleId="rename-dialog-title"
      className="compact chat-dialog"
      closeOnBackdrop
      closeOnEscape
      initialFocusRef={inputRef}
      onClose={onClose}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) return;
          setBusy(true);
          setError(null);
          void onRename(value.trim())
            .catch((caught: Error) => setError(localizeKnownServerText(language, caught.message)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="dialog-header">
          <div className="dialog-heading">
            <span className="dialog-eyebrow">{t("Задача")}</span>
            <h2 id="rename-dialog-title">{t("Переименовать")}</h2>
          </div>
          <button type="button" className="icon-button" aria-label={t("Закрыть")} onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <label>
          {t("Название")}
          <input
            ref={inputRef}
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {error && (
          <div className="dialog-notice danger" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("Отмена")}
          </button>
          <button className="primary" disabled={busy || !value.trim()}>
            <ActionLabel idle={t("Сохранить")} busy={t("Сохраняем…")} pending={busy} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function statusLabel(status: string, t: Translate): string {
  return status === "inProgress"
    ? t("выполняется")
    : status === "failed"
      ? t("ошибка")
      : t("готово");
}
