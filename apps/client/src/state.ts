import { appendUserInputRecordings, type PastedText } from "@codexnest/protocol";
import type {
  ActivityItem,
  AppSnapshot,
  Project,
  ProjectionVersion,
  QueuedMessage,
  ServerEvent,
  ThreadDetail,
  ThreadDraft,
  ThreadGoal,
  ThreadHistoryPage,
  ThreadSummary,
  UpdateUserInputDraftRequest,
  UserInputDraft,
  ThreadFileAttachment,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";
import {
  forkOperationsFromSnapshot,
  type ForkOperationSummary,
  upsertForkOperation,
  withForkOperations,
} from "./forks";

export interface ClientState {
  snapshot: AppSnapshot | null;
  details: Record<string, ThreadDetail>;
  projectDrafts?: Record<string, ThreadDraft>;
  expandedHistory: Record<string, boolean>;
  optimisticMessages: Record<string, OptimisticMessage[]>;
  userInputDrafts: Record<string, ClientUserInputDraft>;
  goals: Record<string, ThreadGoal | null>;
  voiceRemovals: Record<string, { jobId: string; outcome: "draft" | "send" | "cancelled" }>;
  network: "connecting" | "connected" | "offline";
  error: string | null;
  snapshotEpoch: number;
  skillsEpoch: number;
}

export type ClientUserInputDraft = UpdateUserInputDraftRequest & {
  serverRevision: number;
  localVersion: number;
  savedVersion: number;
  saving: boolean;
  error: string | null;
};

export type OptimisticMessage = PastedText & {
  id: string;
  threadId: string;
  text: string;
  images: string[];
  files?: ThreadFileAttachment[];
  createdAt: number;
  destination: "turn" | "queue";
  turnId: string | null;
  deliveryError?: QueuedMessage["deliveryError"];
  serverAccepted?: boolean;
  dismissUserInput?: QueuedMessage["dismissUserInput"];
};

export type ClientAction =
  | { type: "network"; network: ClientState["network"]; error?: string | null }
  | {
      type: "hydrate";
      snapshot: AppSnapshot | null;
      goals: Record<string, ThreadGoal | null>;
    }
  | { type: "hydrate.detail"; detail: ThreadDetail }
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "event"; version: ProjectionVersion; event: ServerEvent }
  | {
      type: "detail";
      detail: ThreadDetail;
      page?: "latest" | "older" | "reset";
      preserveLive?: boolean;
    }
  | { type: "history"; threadId: string; page: ThreadHistoryPage }
  | { type: "history.rebase"; detail: ThreadDetail; page: ThreadHistoryPage }
  | { type: "turn.items"; threadId: string; turnId: string; items: ActivityItem[] }
  | { type: "draft"; threadId: string; draft: ThreadDraft | null }
  | { type: "projectDraft"; projectId: string; draft: ThreadDraft }
  | { type: "thread"; thread: ThreadSummary }
  | { type: "thread.remove"; threadId: string }
  | { type: "forkOperation"; operation: ForkOperationSummary }
  | { type: "forkOperation.remove"; operationId: string }
  | { type: "project.remove"; projectId: string; threadIds: string[] }
  | { type: "goal"; threadId: string; goal: ThreadGoal | null }
  | { type: "voice.accepted"; job: VoiceTranscriptionJob }
  | { type: "optimistic.add"; message: OptimisticMessage }
  | { type: "optimistic.accept"; threadId: string; messageId: string; turnId: string }
  | {
      type: "optimistic.error";
      threadId: string;
      messageId: string;
      error: QueuedMessage["deliveryError"];
    }
  | { type: "optimistic.remove"; threadId: string; messageId: string }
  | {
      type: "userInputDraft.edit";
      attentionId: string;
      draft: UpdateUserInputDraftRequest;
      version: number;
    }
  | { type: "userInputDraft.saving"; attentionId: string; version: number }
  | {
      type: "userInputDraft.saved";
      attentionId: string;
      version: number;
      draft: UserInputDraft;
    }
  | { type: "userInputDraft.failed"; attentionId: string; error: string }
  | { type: "userInputDraft.clear"; attentionId: string }
  | { type: "clear" };

export const initialState: ClientState = {
  snapshot: null,
  details: {},
  expandedHistory: {},
  optimisticMessages: {},
  userInputDrafts: {},
  goals: {},
  voiceRemovals: {},
  network: "connecting",
  error: null,
  snapshotEpoch: 0,
  skillsEpoch: 0,
};

export function clientReducer(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case "clear":
      return initialState;
    case "network":
      return { ...state, network: action.network, error: action.error ?? null };
    case "hydrate":
      return {
        ...state,
        snapshot: action.snapshot,
        userInputDrafts: action.snapshot
          ? reconcileUserInputDrafts(state.userInputDrafts, action.snapshot.attention, true)
          : state.userInputDrafts,
        goals: action.goals,
      };
    case "hydrate.detail":
      return applyDetail(state, action.detail);
    case "snapshot": {
      const snapshot = {
        ...action.snapshot,
        instanceId: action.snapshot.instanceId ?? state.snapshot?.instanceId ?? "legacy",
      };
      const sameInstance = state.snapshot?.instanceId === snapshot.instanceId;
      if (sameInstance && state.snapshot && action.snapshot.sequence < state.snapshot.sequence) {
        return state;
      }
      const snapshotThreads = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
      const details = sameInstance
        ? Object.fromEntries(
            Object.entries(state.details)
              .filter(
                ([threadId, detail]) =>
                  snapshotThreads.has(threadId) &&
                  detail.version?.instanceId === snapshot.instanceId,
              )
              .map(([threadId, detail]) => [
                threadId,
                {
                  ...detail,
                  summary:
                    detail.version && detail.version.sequence > snapshot.sequence
                      ? detail.summary
                      : (snapshotThreads.get(threadId) ?? detail.summary),
                },
              ]),
          )
        : {};
      return {
        ...state,
        snapshot,
        details,
        expandedHistory: sameInstance
          ? Object.fromEntries(
              Object.entries(state.expandedHistory).filter(([threadId]) => threadId in details),
            )
          : {},
        userInputDrafts: reconcileUserInputDrafts(state.userInputDrafts, action.snapshot.attention),
        network: "connected",
        error: null,
        snapshotEpoch: state.snapshotEpoch + 1,
      };
    }
    case "detail":
      return applyDetail(state, action.detail);
    case "history":
      return applyHistory(state, action.threadId, action.page);
    case "history.rebase":
      return applyHistory(
        applyDetail(state, action.detail, true),
        action.detail.summary.id,
        action.page,
      );
    case "turn.items":
      return applyTurnItems(state, action.threadId, action.turnId, action.items);
    case "draft": {
      const detail = state.details[action.threadId];
      if (!detail) return state;
      return {
        ...state,
        details: {
          ...state.details,
          [action.threadId]: { ...detail, draft: action.draft },
        },
      };
    }
    case "thread":
      return applyThreadSummary(state, action.thread);
    case "thread.remove":
      return removeThreadState(state, action.threadId);
    case "forkOperation":
      if (!state.snapshot) return state;
      return {
        ...state,
        snapshot: withForkOperations(
          state.snapshot,
          upsertForkOperation(forkOperationsFromSnapshot(state.snapshot), action.operation),
        ),
      };
    case "forkOperation.remove":
      if (!state.snapshot) return state;
      return {
        ...state,
        snapshot: withForkOperations(
          state.snapshot,
          forkOperationsFromSnapshot(state.snapshot).filter(
            (operation) => operation.id !== action.operationId,
          ),
        ),
      };
    case "project.remove": {
      const snapshot = state.snapshot
        ? {
            ...state.snapshot,
            projects: state.snapshot.projects.filter((project) => project.id !== action.projectId),
          }
        : null;
      return action.threadIds.reduce((next, threadId) => removeThreadState(next, threadId), {
        ...state,
        snapshot,
      });
    }
    case "goal":
      return { ...state, goals: { ...state.goals, [action.threadId]: action.goal } };
    case "voice.accepted": {
      if (!state.snapshot) return state;
      if (
        state.voiceRemovals[
          action.job.userInput ? `question:${action.job.id}` : action.job.threadId
        ]?.jobId === action.job.id
      )
        return state;
      const voiceTranscriptions = state.snapshot.voiceTranscriptions ?? [];
      const current = voiceTranscriptions.find((job) => job.id === action.job.id);
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          voiceTranscriptions: upsert(voiceTranscriptions, current ?? action.job),
        },
        voiceRemovals: action.job.userInput
          ? state.voiceRemovals
          : withoutKey(state.voiceRemovals, action.job.threadId),
      };
    }
    case "optimistic.add":
      if (isMessageConfirmed(state, action.message)) return state;
      return {
        ...state,
        optimisticMessages: {
          ...state.optimisticMessages,
          [action.message.threadId]: [
            ...(state.optimisticMessages[action.message.threadId] ?? []).filter(
              (message) => message.id !== action.message.id,
            ),
            action.message,
          ],
        },
      };
    case "optimistic.accept":
      return updateOptimisticMessage(state, action.threadId, action.messageId, (message) => ({
        ...message,
        turnId: action.turnId,
      }));
    case "optimistic.error":
      return updateOptimisticMessage(state, action.threadId, action.messageId, (message) => ({
        ...message,
        deliveryError: action.error,
      }));
    case "optimistic.remove":
      return removeOptimisticMessage(state, action.threadId, action.messageId);
    case "userInputDraft.edit": {
      const current = state.userInputDrafts[action.attentionId];
      return {
        ...state,
        userInputDrafts: {
          ...state.userInputDrafts,
          [action.attentionId]: {
            ...action.draft,
            serverRevision: current?.serverRevision ?? 0,
            localVersion: action.version,
            savedVersion: current?.savedVersion ?? 0,
            saving: current?.saving ?? false,
            error: null,
          },
        },
      };
    }
    case "userInputDraft.saving": {
      const current = state.userInputDrafts[action.attentionId];
      if (!current || action.version > current.localVersion) return state;
      return {
        ...state,
        userInputDrafts: {
          ...state.userInputDrafts,
          [action.attentionId]: { ...current, saving: true, error: null },
        },
      };
    }
    case "userInputDraft.saved": {
      const current = state.userInputDrafts[action.attentionId];
      if (!current) return state;
      const request = state.snapshot?.attention.find(
        (candidate) => candidate.id === action.attentionId,
      );
      return {
        ...state,
        userInputDrafts: {
          ...state.userInputDrafts,
          [action.attentionId]: {
            ...(current.localVersion === action.version
              ? {
                  ...appendUserInputRecordings(
                    action.draft,
                    request?.kind === "userInput" ? (request.draft?.recordings ?? []) : [],
                  ),
                  currentQuestionId: action.draft.currentQuestionId,
                }
              : current),
            serverRevision: Math.max(current.serverRevision, action.draft.revision),
            localVersion: current.localVersion,
            savedVersion: Math.max(current.savedVersion, action.version),
            saving: false,
            error: null,
          },
        },
      };
    }
    case "userInputDraft.failed": {
      const current = state.userInputDrafts[action.attentionId];
      if (!current) return state;
      return {
        ...state,
        userInputDrafts: {
          ...state.userInputDrafts,
          [action.attentionId]: { ...current, saving: false, error: action.error },
        },
      };
    }
    case "userInputDraft.clear":
      return {
        ...state,
        userInputDrafts: withoutKey(state.userInputDrafts, action.attentionId),
      };
    case "projectDraft":
      if ((state.projectDrafts?.[action.projectId]?.updatedAt ?? -1) >= action.draft.updatedAt)
        return state;
      return {
        ...state,
        projectDrafts: { ...state.projectDrafts, [action.projectId]: action.draft },
      };
    case "event":
      if (!state.snapshot) return state;
      return applyEvent(state, action.version, action.event);
  }
}

function reconcileUserInputDrafts(
  current: Record<string, ClientUserInputDraft>,
  attention: AppSnapshot["attention"],
  preserveMissing = false,
): Record<string, ClientUserInputDraft> {
  const next: Record<string, ClientUserInputDraft> = {};
  for (const request of attention) {
    if (request.kind !== "userInput") continue;
    const local = current[request.id];
    const dirty = local && (local.saving || local.localVersion > local.savedVersion);
    if (dirty) {
      next[request.id] = request.draft
        ? {
            ...local,
            ...appendUserInputRecordings(local, request.draft.recordings ?? []),
            serverRevision: Math.max(local.serverRevision, request.draft.revision),
          }
        : local;
      continue;
    }
    if (request.draft === undefined) {
      if (local) next[request.id] = local;
      continue;
    }
    if (request.draft === null) {
      continue;
    }
    if (local && request.draft.revision <= local.serverRevision) {
      next[request.id] = local;
      continue;
    }
    const version = local?.localVersion ?? 0;
    next[request.id] = {
      ...(request.draft.appliedRecordingIds
        ? { appliedRecordingIds: [...request.draft.appliedRecordingIds] }
        : {}),
      answers: cloneAnswers(request.draft.answers),
      currentQuestionId: request.draft.currentQuestionId,
      serverRevision: request.draft.revision,
      localVersion: version,
      savedVersion: version,
      saving: false,
      error: null,
    };
  }
  if (preserveMissing) {
    for (const [attentionId, draft] of Object.entries(current)) {
      next[attentionId] ??= draft;
    }
  }
  return next;
}

function cloneAnswers(answers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, [...values]]));
}

function applyEvent(
  state: ClientState,
  version: ProjectionVersion,
  event: ServerEvent,
): ClientState {
  if (
    !state.snapshot?.instanceId ||
    version.instanceId !== state.snapshot.instanceId ||
    version.sequence <= state.snapshot.sequence
  ) {
    return state;
  }
  const threadId = eventThreadId(event);
  const currentDetail = threadId ? state.details[threadId] : undefined;
  const detailAlreadyIncludesEvent = Boolean(
    currentDetail?.version?.instanceId === version.instanceId &&
    currentDetail.version.sequence >= version.sequence,
  );
  const next = applyVersionedEvent(state, version.sequence, event);
  const detail = threadId ? next.details[threadId] : undefined;
  if (threadId && currentDetail && detailAlreadyIncludesEvent) {
    return {
      ...next,
      details: { ...next.details, [threadId]: currentDetail },
    };
  }
  if (!threadId || !detail) return next;
  return {
    ...next,
    details: {
      ...next.details,
      [threadId]: { ...detail, version },
    },
  };
}

function applyVersionedEvent(
  state: ClientState,
  sequence: number,
  event: ServerEvent,
): ClientState {
  let snapshot = { ...state.snapshot!, sequence };
  const forkEvent = event as unknown as
    | { type: "forkOperation.upserted"; operation: ForkOperationSummary }
    | { type: "forkOperation.removed"; operationId: string };
  if (forkEvent.type === "forkOperation.upserted") {
    snapshot = withForkOperations(
      snapshot,
      upsertForkOperation(forkOperationsFromSnapshot(snapshot), forkEvent.operation),
    );
    return { ...state, snapshot };
  }
  if (forkEvent.type === "forkOperation.removed") {
    snapshot = withForkOperations(
      snapshot,
      forkOperationsFromSnapshot(snapshot).filter(
        (operation) => operation.id !== forkEvent.operationId,
      ),
    );
    return { ...state, snapshot };
  }
  switch (event.type) {
    case "connection.changed":
      snapshot.connection = event.connection;
      break;
    case "codexRateLimits.changed":
      snapshot.codexRateLimits = event.codexRateLimits;
      break;
    case "projectDraft.changed":
      return {
        ...clientReducer(state, {
          type: "projectDraft",
          projectId: event.projectId,
          draft: event.draft,
        }),
        snapshot,
      };
    case "project.upserted":
      snapshot.projects = upsert(snapshot.projects, event.project);
      break;
    case "projects.reordered":
      snapshot.projects = event.projects;
      break;
    case "project.removed":
      snapshot.projects = snapshot.projects.filter((project) => project.id !== event.projectId);
      break;
    case "thread.upserted":
      snapshot.threads = sortThreads(upsert(snapshot.threads, event.thread));
      return applyThreadSummary({ ...state, snapshot }, event.thread);
    case "thread.removed":
      return removeThreadState({ ...state, snapshot }, event.threadId);
    case "attention.upserted":
      snapshot.attention = upsert(snapshot.attention, event.attention);
      return {
        ...state,
        snapshot,
        userInputDrafts: reconcileUserInputDrafts(state.userInputDrafts, snapshot.attention),
      };
    case "attention.removed":
      snapshot.attention = snapshot.attention.filter((item) => item.id !== event.attentionId);
      return {
        ...state,
        snapshot,
        userInputDrafts: withoutKey(state.userInputDrafts, event.attentionId),
      };
    case "models.changed":
      snapshot.models = event.models;
      break;
    case "defaultReasoningEffort.changed":
      snapshot.defaultReasoningEffort = event.reasoningEffort ?? undefined;
      break;
    case "taskDefaults.changed":
      snapshot.taskDefaults = event.taskDefaults;
      break;
    case "permissions.changed":
      snapshot.permissionSettings = event.permissionSettings;
      break;
    case "uiLanguage.changed":
      snapshot.uiLanguage = event.language;
      break;
    case "skills.changed":
      return { ...state, snapshot, skillsEpoch: state.skillsEpoch + 1 };
    case "goal.changed":
      return {
        ...state,
        snapshot,
        goals: { ...state.goals, [event.threadId]: event.goal },
      };
    case "voiceTranscription.upserted":
      snapshot.voiceTranscriptions = upsert(snapshot.voiceTranscriptions ?? [], event.job);
      return {
        ...state,
        snapshot,
        voiceRemovals: event.job.userInput
          ? state.voiceRemovals
          : withoutKey(state.voiceRemovals, event.job.threadId),
      };
    case "voiceTranscription.removed": {
      const wasQuestion = snapshot.voiceTranscriptions?.some(
        (job) => job.id === event.jobId && job.userInput,
      );
      snapshot.voiceTranscriptions = (snapshot.voiceTranscriptions ?? []).filter(
        (job) => job.id !== event.jobId,
      );
      return {
        ...state,
        snapshot,
        voiceRemovals: {
          ...state.voiceRemovals,
          [wasQuestion ? `question:${event.jobId}` : event.threadId]: {
            jobId: event.jobId,
            outcome: event.outcome,
          },
        },
      };
    }
    case "activity.upserted":
      return removeOptimisticMessage(
        applyActivity({ ...state, snapshot }, event.threadId, event.turnId, event.item),
        event.threadId,
        event.item.id,
      );
    case "activity.delta":
      return applyActivityDelta({ ...state, snapshot }, event);
    case "turn.progressed":
      return applyProgress({ ...state, snapshot }, event.threadId, event.turnId, event.progress);
    case "turn.replaced":
      return applyTurnReplacement({ ...state, snapshot }, event.threadId, event.turn);
    case "queue.changed":
      return removeConfirmedQueuedMessages(
        applyQueue({ ...state, snapshot }, event.threadId, event.messages),
        event.threadId,
        event.messages,
      );
    case "resync.required":
      return { ...state, snapshot, snapshotEpoch: state.snapshotEpoch + 1 };
  }
  return { ...state, snapshot };
}

function removeThreadState(state: ClientState, threadId: string): ClientState {
  return {
    ...state,
    snapshot: state.snapshot
      ? {
          ...state.snapshot,
          threads: state.snapshot.threads.filter((thread) => thread.id !== threadId),
          voiceTranscriptions: (state.snapshot.voiceTranscriptions ?? []).filter(
            (job) => job.threadId !== threadId,
          ),
        }
      : null,
    details: withoutKey(state.details, threadId),
    expandedHistory: withoutKey(state.expandedHistory, threadId),
    optimisticMessages: withoutKey(state.optimisticMessages, threadId),
    goals: Object.fromEntries(
      Object.entries(state.goals).filter(([candidateId]) => candidateId !== threadId),
    ),
    voiceRemovals: withoutKey(state.voiceRemovals, threadId),
  };
}

function applyDetail(state: ClientState, detail: ThreadDetail, resetHistory = false): ClientState {
  const version =
    detail.version ??
    (state.snapshot?.instanceId === "legacy"
      ? { instanceId: "legacy", sequence: state.snapshot.sequence }
      : undefined);
  if (!version || !state.snapshot?.instanceId || version.instanceId !== state.snapshot.instanceId) {
    return state;
  }
  detail = { ...detail, version };
  const threadId = detail.summary.id;
  const current = state.details[threadId];
  if (
    current?.version?.instanceId === version.instanceId &&
    current.version.sequence > version.sequence
  ) {
    return state;
  }
  if (detail.historyError && current) {
    const incoming = new Map(detail.turns.map((turn) => [turn.id, turn]));
    detail = {
      ...detail,
      turns: [
        ...current.turns.map((turn) => incoming.get(turn.id) ?? turn),
        ...detail.turns.filter((turn) => !current.turns.some((known) => known.id === turn.id)),
      ],
      olderTurnsCursor: current.olderTurnsCursor,
    };
  }
  const subagent = detail.summary.relation.kind === "subagent";
  const preserveHistory = !resetHistory && !subagent && current && state.expandedHistory[threadId];
  const firstIncomingId = detail.turns[0]?.id;
  const overlap = firstIncomingId
    ? current?.turns.findIndex((turn) => turn.id === firstIncomingId)
    : -1;
  const historicalPrefix =
    preserveHistory && overlap !== undefined && overlap > 0 ? current.turns.slice(0, overlap) : [];
  const latestTurns = detail.turns;
  const snapshotSummary = state.snapshot.threads.find((thread) => thread.id === threadId);
  const merged: ThreadDetail = {
    ...detail,
    summary: reconcileThreadSummary(
      snapshotSummary,
      detail.summary,
      version.sequence >= state.snapshot.sequence,
    ),
    turns: [...historicalPrefix, ...latestTurns],
    olderTurnsCursor: subagent
      ? null
      : historicalPrefix.length
        ? current!.olderTurnsCursor
        : detail.olderTurnsCursor,
  };
  const confirmedUserIds = userMessageIds(merged);
  const reconciled = {
    ...merged,
    queuedMessages: merged.queuedMessages.filter((message) => !confirmedUserIds.has(message.id)),
  };
  const confirmedIds = new Set([
    ...confirmedUserIds,
    ...reconciled.queuedMessages
      .filter((message) => message.deliveryMode !== "steer")
      .map((message) => message.id),
  ]);
  return {
    ...state,
    details: { ...state.details, [threadId]: reconciled },
    expandedHistory: subagent
      ? { ...state.expandedHistory, [threadId]: false }
      : historicalPrefix.length
        ? state.expandedHistory
        : { ...state.expandedHistory, [threadId]: false },
    optimisticMessages: setOptimisticMessages(
      state.optimisticMessages,
      threadId,
      (state.optimisticMessages[threadId] ?? []).filter((message) => !confirmedIds.has(message.id)),
    ),
  };
}

function reconcileThreadSummary(
  snapshotSummary: ThreadSummary | undefined,
  detailSummary: ThreadSummary,
  detailCoversSnapshot: boolean,
): ThreadSummary {
  if (!snapshotSummary) return detailSummary;
  if (detailCoversSnapshot) return detailSummary;
  if (snapshotSummary.currentTurnId) return snapshotSummary;
  if (detailSummary.currentTurnId && detailSummary.updatedAt >= snapshotSummary.updatedAt) {
    return detailSummary;
  }
  return snapshotSummary.updatedAt >= detailSummary.updatedAt ? snapshotSummary : detailSummary;
}

function applyHistory(state: ClientState, threadId: string, page: ThreadHistoryPage): ClientState {
  const detail = state.details[threadId];
  if (
    !detail ||
    page.instanceId !== state.snapshot?.instanceId ||
    detail.turns[0]?.id !== page.anchorTurnId
  ) {
    return state;
  }
  const currentIds = new Set(detail.turns.map((turn) => turn.id));
  const olderTurns = page.turns.filter((turn) => !currentIds.has(turn.id));
  return {
    ...state,
    details: {
      ...state.details,
      [threadId]: {
        ...detail,
        turns: [...olderTurns, ...detail.turns],
        olderTurnsCursor: page.olderTurnsCursor,
      },
    },
    expandedHistory: { ...state.expandedHistory, [threadId]: true },
  };
}

function applyThreadSummary(state: ClientState, thread: ThreadSummary): ClientState {
  if (!state.snapshot) return state;
  const detail = state.details[thread.id];
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      threads: sortThreads(upsert(state.snapshot.threads, thread)),
    },
    details: detail
      ? { ...state.details, [thread.id]: { ...detail, summary: thread } }
      : state.details,
  };
}

function applyTurnItems(
  state: ClientState,
  threadId: string,
  turnId: string,
  items: ActivityItem[],
): ClientState {
  const detail = state.details[threadId];
  if (!detail) return state;
  const turnIndex = detail.turns.findIndex((turn) => turn.id === turnId);
  if (turnIndex < 0) return state;
  const turns = [...detail.turns];
  const current = turns[turnIndex]!;
  const timestamped = items.map((item): ActivityItem => {
    switch (item.type) {
      case "userMessage":
      case "agentMessage":
      case "reasoning":
      case "plan":
        if (item.timestamp !== null) return item;
        return {
          ...item,
          timestamp:
            item.type === "userMessage"
              ? current.startedAt
              : (current.completedAt ?? current.startedAt),
        };
      default:
        return item;
    }
  });
  turns[turnIndex] = {
    ...current,
    items: mergeLoadedTurnItems(timestamped, current),
    itemsLoaded: true,
  };
  return { ...state, details: { ...state.details, [threadId]: { ...detail, turns } } };
}

function mergeLoadedTurnItems(
  items: ActivityItem[],
  current: ThreadDetail["turns"][number],
): ActivityItem[] {
  let merged = [...items];
  const unmatched = new Set(items.map((item) => item.id));
  const matches = new Map<string, string>();
  // Match exact IDs first so identical, independently emitted messages stay separate.
  for (const item of current.items) {
    if (!unmatched.delete(item.id)) continue;
    matches.set(item.id, item.id);
  }
  for (const item of current.items) {
    if (matches.has(item.id)) continue;
    const alias = items.find(
      (candidate) => unmatched.has(candidate.id) && sameLoadedText(candidate, item),
    );
    if (!alias) continue;
    matches.set(item.id, alias.id);
    unmatched.delete(alias.id);
  }
  for (const [index, item] of current.items.entries()) {
    const canonicalId = matches.get(item.id);
    if (canonicalId) {
      const target = merged.findIndex((candidate) => candidate.id === canonicalId);
      merged[target] = {
        ...fresherActivity(item, merged[target]!),
        id: canonicalId,
      } as ActivityItem;
      if (canonicalId !== item.id) merged = remapArtifactAnchors(merged, item.id, canonicalId);
    } else if (
      current.status === "inProgress" ||
      [
        "userMessage",
        "agentMessage",
        "plan",
        "userInputResponse",
        "planChecklist",
        "orchestrationNotice",
      ].includes(item.type)
    ) {
      const nextId = current.items
        .slice(index + 1)
        .map((candidate) => matches.get(candidate.id))
        .find(Boolean);
      const next = nextId ? merged.findIndex((candidate) => candidate.id === nextId) : -1;
      if (next >= 0) merged.splice(next, 0, item);
      else merged = upsertActivity(merged, item);
    }
  }
  for (const [previousId, canonicalId] of matches) {
    if (previousId !== canonicalId) merged = remapArtifactAnchors(merged, previousId, canonicalId);
  }
  return merged;
}

function sameLoadedText(first: ActivityItem, second: ActivityItem): boolean {
  if (!("text" in first) || !("text" in second)) return false;
  const partial = first.status === "inProgress" || second.status === "inProgress";
  const text =
    partial &&
    first.text &&
    second.text &&
    (first.text.startsWith(second.text) || second.text.startsWith(first.text))
      ? first.text
      : second.text;
  return sameCompletedActivity(
    { ...first, status: "completed" },
    { ...second, text, status: "completed" },
    false,
  );
}

function applyTurnReplacement(
  state: ClientState,
  threadId: string,
  turn: ThreadDetail["turns"][number],
): ClientState {
  const detail = detailForEvent(state, threadId);
  if (!detail) return state;
  const turns = [...detail.turns];
  const index = turns.findIndex((candidate) => candidate.id === turn.id);
  if (index >= 0) turns[index] = turn;
  else turns.push(turn);
  const confirmedUserIds = new Set(
    turn.items.filter((item) => item.type === "userMessage").map((item) => item.id),
  );
  return {
    ...state,
    details: {
      ...state.details,
      [threadId]: {
        ...detail,
        turns,
        queuedMessages: detail.queuedMessages.filter(
          (message) => !confirmedUserIds.has(message.id),
        ),
      },
    },
    optimisticMessages: setOptimisticMessages(
      state.optimisticMessages,
      threadId,
      (state.optimisticMessages[threadId] ?? []).filter(
        (message) => !confirmedUserIds.has(message.id),
      ),
    ),
  };
}

function applyActivity(
  state: ClientState,
  threadId: string,
  turnId: string,
  item: ActivityItem,
): ClientState {
  const detail = detailForEvent(state, threadId);
  if (!detail) return state;
  const turns =
    item.type === "userMessage"
      ? detail.turns.map((turn) => {
          if (turn.id === turnId) return turn;
          const items = turn.items.filter(
            (candidate) => candidate.type !== "userMessage" || candidate.id !== item.id,
          );
          return items.length === turn.items.length ? turn : { ...turn, items };
        })
      : [...detail.turns];
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) {
    turns.push({
      id: turnId,
      status: "inProgress",
      startedAt: item.type === "userMessage" ? item.timestamp : null,
      completedAt: null,
      durationMs: null,
      progress: emptyProgress(),
      items: [item],
      itemsLoaded: false,
    });
  } else {
    const turn = turns[index];
    turns[index] = {
      ...turn,
      items: upsertActivity(turn.items, item, turn.itemsLoaded !== false),
    };
  }
  const queuedMessages =
    item.type === "userMessage"
      ? detail.queuedMessages.filter((message) => message.id !== item.id)
      : detail.queuedMessages;
  return {
    ...state,
    details: { ...state.details, [threadId]: { ...detail, turns, queuedMessages } },
  };
}

function applyActivityDelta(
  state: ClientState,
  event: Extract<ServerEvent, { type: "activity.delta" }>,
): ClientState {
  const detail = detailForEvent(state, event.threadId);
  if (!detail) return state;
  const turns = [...detail.turns];
  let turnIndex = turns.findIndex((turn) => turn.id === event.turnId);
  if (turnIndex < 0) {
    turns.push({
      id: event.turnId,
      status: "inProgress",
      startedAt: null,
      completedAt: null,
      durationMs: null,
      progress: emptyProgress(),
      items: [],
      itemsLoaded: false,
    });
    turnIndex = turns.length - 1;
  }
  const turn = turns[turnIndex]!;
  const items = [...turn.items];
  const itemIndex = items.findIndex((item) => item.id === event.itemId);
  if (itemIndex >= 0) {
    const current = items[itemIndex]!;
    if (event.activityType === "command" && current.type === "command") {
      items[itemIndex] = { ...current, output: current.output + event.delta };
    } else if ("text" in current) {
      items[itemIndex] = { ...current, text: current.text + event.delta } as ActivityItem;
    }
  } else if (event.activityType === "command") {
    items.push({
      type: "command",
      id: event.itemId,
      status: "inProgress",
      kind: "command",
      command: "",
      cwd: null,
      output: event.delta,
      exitCode: null,
    });
  } else {
    items.push({
      type: event.activityType,
      id: event.itemId,
      status: "inProgress",
      text: event.delta,
      images: [],
      timestamp: turn.startedAt ?? turn.progress.startedAt,
      phase: null,
    });
  }
  turns[turnIndex] = { ...turn, items };
  return { ...state, details: { ...state.details, [event.threadId]: { ...detail, turns } } };
}

function upsertActivity(
  items: ActivityItem[],
  item: ActivityItem,
  canonicalItemsLoaded?: boolean,
): ActivityItem[] {
  const reconcileCompletedAlias = canonicalItemsLoaded !== undefined;
  const allowPhaseMismatch = canonicalItemsLoaded === false;
  const existing = items.findIndex((candidate) => candidate.id === item.id);
  if (existing >= 0) {
    const previous = items[existing]!;
    if (
      item.type === "plan" &&
      previous.type === "plan" &&
      previous.status === "completed" &&
      item.timestamp !== null &&
      previous.timestamp !== null &&
      item.timestamp > previous.timestamp
    ) {
      // A second proposed_plan in one turn reuses its ID. This starts a new
      // revision after the clarification, rather than editing the old position.
      const next = items.filter((candidate) => candidate.id !== item.id);
      next.splice(chronologicalActivityPosition(next, item), 0, item);
      return next;
    }
    const next = [...items];
    const completedLiveItem =
      reconcileCompletedAlias &&
      items[existing]!.status === "inProgress" &&
      item.status === "completed";
    next[existing] = fresherActivity(next[existing]!, item);
    return completedLiveItem
      ? reconcileCompletedActivityAlias(next, existing, allowPhaseMismatch)
      : next;
  }
  if (reconcileCompletedAlias && item.status === "completed") {
    const alias = items.findIndex((candidate) =>
      sameCompletedActivity(candidate, item, allowPhaseMismatch),
    );
    if (alias >= 0) {
      const next = [...items];
      const canonical = next[alias]!;
      next[alias] = { ...fresherActivity(canonical, item), id: canonical.id } as ActivityItem;
      return remapArtifactAnchors(next, item.id, canonical.id);
    }
  }
  if (item.type !== "userInputResponse" && item.type !== "planChecklist") {
    if (
      item.type === "userMessage" &&
      !items.some((candidate) => candidate.type === "userMessage")
    ) {
      return [item, ...items];
    }
    const anchoredArtifact = items.findIndex(
      (candidate) =>
        (candidate.type === "userInputResponse" || candidate.type === "planChecklist") &&
        candidate.afterItemId === item.id,
    );
    const insertion =
      anchoredArtifact >= 0 ? anchoredArtifact : chronologicalActivityPosition(items, item);
    if (insertion === items.length) return [...items, item];
    const next = [...items];
    next.splice(insertion, 0, item);
    return next;
  }
  const anchor = item.afterItemId
    ? items.findIndex((candidate) => candidate.id === item.afterItemId)
    : -1;
  let insertion = anchor >= 0 ? anchor + 1 : fallbackActivityPosition(items, item.type);
  while (insertion < items.length) {
    const candidate = items[insertion];
    if (
      !candidate ||
      (candidate.type !== "userInputResponse" && candidate.type !== "planChecklist") ||
      candidate.afterItemId !== item.afterItemId
    ) {
      break;
    }
    insertion += 1;
  }
  const next = [...items];
  next.splice(insertion, 0, item);
  return next;
}

function chronologicalActivityPosition(items: ActivityItem[], item: ActivityItem): number {
  if (!("timestamp" in item) || item.timestamp == null) return items.length;
  const timestamp = item.timestamp;
  const later = items.findIndex(
    (candidate) =>
      "timestamp" in candidate && candidate.timestamp != null && candidate.timestamp > timestamp,
  );
  return later < 0 ? items.length : later;
}

function fallbackActivityPosition(
  items: ActivityItem[],
  type: "userInputResponse" | "planChecklist",
): number {
  if (type === "userInputResponse") {
    const finalResponse = items.findIndex(
      (item) =>
        item.type === "plan" || (item.type === "agentMessage" && item.phase === "final_answer"),
    );
    if (finalResponse >= 0) return finalResponse;
    return items.length;
  }
  let insertion = 0;
  while (items[insertion]?.type === "userMessage") insertion += 1;
  return insertion;
}

function applyProgress(
  state: ClientState,
  threadId: string,
  turnId: string,
  progress: ThreadDetail["turns"][number]["progress"],
): ClientState {
  const detail = detailForEvent(state, threadId);
  if (!detail) return state;
  const turns = [...detail.turns];
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) {
    turns.push({
      id: turnId,
      status: "inProgress",
      startedAt: progress.startedAt,
      completedAt: null,
      durationMs: null,
      progress,
      items: [],
      itemsLoaded: false,
    });
  } else {
    turns[index] = { ...turns[index], progress };
  }
  return { ...state, details: { ...state.details, [threadId]: { ...detail, turns } } };
}

function applyQueue(
  state: ClientState,
  threadId: string,
  queuedMessages: QueuedMessage[],
): ClientState {
  const detail = detailForEvent(state, threadId);
  if (!detail) return state;
  const confirmedIds = userMessageIds(detail);
  return {
    ...state,
    details: {
      ...state.details,
      [threadId]: {
        ...detail,
        queuedMessages: queuedMessages.filter((message) => !confirmedIds.has(message.id)),
      },
    },
  };
}

function detailForEvent(state: ClientState, threadId: string): ThreadDetail | undefined {
  const existing = state.details[threadId];
  if (existing) return existing;
  const summary = state.snapshot?.threads.find((thread) => thread.id === threadId);
  return summary && state.snapshot?.instanceId
    ? {
        version: { instanceId: state.snapshot.instanceId, sequence: state.snapshot.sequence },
        summary,
        turns: [],
        queuedMessages: [],
        olderTurnsCursor: null,
      }
    : undefined;
}

function eventThreadId(event: ServerEvent): string | null {
  switch (event.type) {
    case "thread.upserted":
      return event.thread.id;
    case "thread.removed":
    case "activity.upserted":
    case "activity.delta":
    case "turn.progressed":
    case "turn.replaced":
    case "queue.changed":
    case "goal.changed":
    case "voiceTranscription.removed":
      return event.threadId;
    case "voiceTranscription.upserted":
      return event.job.threadId;
    default:
      return null;
  }
}

function remapArtifactAnchors(
  items: ActivityItem[],
  previousId: string,
  canonicalId: string,
): ActivityItem[] {
  return items.map((candidate) =>
    (candidate.type === "userInputResponse" || candidate.type === "planChecklist") &&
    candidate.afterItemId === previousId
      ? { ...candidate, afterItemId: canonicalId }
      : candidate,
  );
}

function fresherActivity(current: ActivityItem, incoming: ActivityItem): ActivityItem {
  if (current.status !== "inProgress" && incoming.status === "inProgress") return current;
  if (
    current.type === incoming.type &&
    "text" in current &&
    "text" in incoming &&
    current.text.startsWith(incoming.text) &&
    current.text.length > incoming.text.length
  ) {
    return withPreservedTimestamp(current, { ...incoming, text: current.text } as ActivityItem);
  }
  if (
    current.type === "command" &&
    incoming.type === "command" &&
    current.output.startsWith(incoming.output) &&
    current.output.length > incoming.output.length
  ) {
    return { ...incoming, output: current.output };
  }
  return withPreservedTimestamp(current, incoming);
}

function withPreservedTimestamp(current: ActivityItem, incoming: ActivityItem): ActivityItem {
  if (
    "timestamp" in current &&
    "timestamp" in incoming &&
    current.timestamp != null &&
    incoming.timestamp == null
  ) {
    return { ...incoming, timestamp: current.timestamp } as ActivityItem;
  }
  return incoming;
}

function reconcileCompletedActivityAlias(
  items: ActivityItem[],
  itemIndex: number,
  allowPhaseMismatch: boolean,
): ActivityItem[] {
  const item = items[itemIndex]!;
  if (item.status !== "completed") return items;
  const alias = items.findIndex(
    (candidate, candidateIndex) =>
      candidateIndex !== itemIndex && sameCompletedActivity(candidate, item, allowPhaseMismatch),
  );
  if (alias < 0) return items;
  const canonical = items[alias]!;
  const next = [...items];
  next[alias] = { ...fresherActivity(canonical, item), id: canonical.id } as ActivityItem;
  next.splice(itemIndex, 1);
  return remapArtifactAnchors(next, item.id, canonical.id);
}

function sameCompletedActivity(
  first: ActivityItem,
  second: ActivityItem,
  allowPhaseMismatch: boolean,
): boolean {
  if (
    first.status !== "completed" ||
    second.status !== "completed" ||
    first.type !== second.type ||
    !["agentMessage", "reasoning", "plan"].includes(first.type) ||
    !("text" in first) ||
    !("text" in second) ||
    first.text !== second.text ||
    first.images.length !== second.images.length
  ) {
    return false;
  }
  if (
    !allowPhaseMismatch &&
    first.phase !== second.phase &&
    first.phase !== null &&
    second.phase !== null
  ) {
    return false;
  }
  return first.images.every((image, index) => image === second.images[index]);
}

function updateOptimisticMessage(
  state: ClientState,
  threadId: string,
  messageId: string,
  update: (message: OptimisticMessage) => OptimisticMessage,
): ClientState {
  const messages = state.optimisticMessages[threadId] ?? [];
  if (!messages.some((message) => message.id === messageId)) return state;
  return {
    ...state,
    optimisticMessages: setOptimisticMessages(
      state.optimisticMessages,
      threadId,
      messages.map((message) => (message.id === messageId ? update(message) : message)),
    ),
  };
}

function removeOptimisticMessage(
  state: ClientState,
  threadId: string,
  messageId: string,
): ClientState {
  const messages = state.optimisticMessages[threadId] ?? [];
  if (!messages.some((message) => message.id === messageId)) return state;
  return {
    ...state,
    optimisticMessages: setOptimisticMessages(
      state.optimisticMessages,
      threadId,
      messages.filter((message) => message.id !== messageId),
    ),
  };
}

function removeConfirmedQueuedMessages(
  state: ClientState,
  threadId: string,
  messages: QueuedMessage[],
): ClientState {
  const confirmedIds = new Set(
    messages.filter((message) => message.deliveryMode !== "steer").map((message) => message.id),
  );
  if (!confirmedIds.size) return state;
  const optimistic = state.optimisticMessages[threadId] ?? [];
  return {
    ...state,
    optimisticMessages: setOptimisticMessages(
      state.optimisticMessages,
      threadId,
      optimistic.filter((message) => !confirmedIds.has(message.id)),
    ),
  };
}

function setOptimisticMessages(
  all: ClientState["optimisticMessages"],
  threadId: string,
  messages: OptimisticMessage[],
): ClientState["optimisticMessages"] {
  if (messages.length) return { ...all, [threadId]: messages };
  return withoutKey(all, threadId);
}

function isMessageConfirmed(state: ClientState, message: OptimisticMessage): boolean {
  const detail = state.details[message.threadId];
  if (!detail) return false;
  return (
    detail.queuedMessages.some((candidate) => candidate.id === message.id) ||
    userMessageIds(detail).has(message.id)
  );
}

function userMessageIds(detail: ThreadDetail): Set<string> {
  return new Set(
    detail.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === "userMessage").map((item) => item.id),
    ),
  );
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function emptyProgress(): ThreadDetail["turns"][number]["progress"] {
  return {
    startedAt: null,
    explanation: null,
    steps: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

export function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function groupedThreads(
  projects: Project[],
  threads: ThreadSummary[],
): Array<{ project: Project | null; threads: ThreadSummary[] }> {
  return [
    ...projects.map((project) => ({
      project,
      threads: threads.filter((thread) => thread.projectId === project.id),
    })),
    { project: null, threads: threads.filter((thread) => !thread.projectId) },
  ].filter((group) => group.project || group.threads.length);
}
