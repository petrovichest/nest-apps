import { appendUserInputRecordings, pastedText } from "@codexnest/protocol";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import {
  createContext,
  type Dispatch,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  isServerFrame,
  type AppSnapshot,
  type ProjectionVersion,
  type QueueMessageRequest,
  type ServerEvent,
  type ThreadDetail,
  type UpdateUserInputDraftRequest,
} from "@codexnest/protocol";

import { ApiClient, ApiClientError, isRetryableApiError } from "./api";
import { BrowserNotificationTracker } from "./browser-notifications";
import { translate, useI18n } from "./i18n";
import {
  observeNativeNotificationEvent,
  observeNativeNotificationSnapshot,
  setNativeNotificationAppActive,
} from "./push";
import {
  loadCachedMeta,
  loadCachedThread,
  connectionCacheKey,
  deleteCachedThread,
  acknowledgeOutboxMessage,
  deleteOutboxMessage,
  deletePendingVoiceRecording,
  confirmLocalDraft,
  listOutboxMessages,
  listPendingVoiceRecordings,
  loadPendingVoiceRecording,
  putOutboxMessage,
  outboxMessageIntent,
  putPendingVoiceRecording,
  saveCachedMeta,
  saveCachedThread,
  saveLocalDraft,
  type OutboxMessage,
  type MessageDraftSource,
  type PendingVoiceRecording,
} from "./offline-store";
import { clientReducer, initialState, type ClientAction, type ClientState } from "./state";
import type { ConnectionSettings } from "./storage";

const HEARTBEAT_IDLE_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const LEGACY_CACHE_INSTANCE_ID = "legacy-cache";

type DetailReadOptions = {
  authoritative?: boolean;
  force?: boolean;
};

type VoiceRecordingUpload = Omit<
  PendingVoiceRecording,
  "connectionKey" | "createdAt" | "attempts" | "lastError"
>;

type PendingQuestionRecording = Pick<
  PendingVoiceRecording,
  | "id"
  | "threadId"
  | "userInput"
  | "durationMs"
  | "createdAt"
  | "lastError"
  | "mode"
  | "dismissUserInput"
>;
type ReliableMessageRequest = QueueMessageRequest & {
  clientMessageId: string;
  userInputSubmission?: OutboxMessage["userInputSubmission"];
};

type VoiceRecordingRecovery = Pick<
  PendingVoiceRecording,
  "threadId" | "mode" | "draft" | "draftUpdatedAt"
>;

type UserInputDraftPersistence = {
  draft: UpdateUserInputDraftRequest;
  version: number;
  savedVersion: number;
  inFlight: boolean;
  pending: boolean;
  timer: number | undefined;
};

interface ConnectionContextValue {
  api: ApiClient;
  state: ClientState;
  appActive: boolean;
  foregroundEpoch: number;
  streamRecoveryEpoch: number;
  dispatch: Dispatch<ClientAction>;
  hydrateCachedDetail(threadId: string): Promise<void>;
  refreshDetail(threadId: string, options?: DetailReadOptions): Promise<ThreadDetail>;
  forceRefreshDetail(threadId: string): Promise<ThreadDetail>;
  loadOlderDetail(threadId: string, cursor: string): Promise<void>;
  loadTurnItems(threadId: string, turnId: string): Promise<void>;
  sendReliable(
    threadId: string,
    body: ReliableMessageRequest,
    onCommitted?: () => void,
    source?: MessageDraftSource,
  ): Promise<"delivered" | "pending">;
  retryReliableMessage(threadId: string, messageId: string): Promise<void>;
  forgetReliableMessage(threadId: string, messageId: string): Promise<void>;
  queueVoiceRecording(recording: Omit<VoiceRecordingUpload, "localDraftUpdatedAt">): Promise<void>;
  pendingQuestionRecordings: readonly PendingQuestionRecording[];
  pendingUserInputSubmissions: readonly OutboxMessage[];
  retryQuestionUpload(id: string): Promise<void>;
  pendingVoiceRecordingThreadIds: readonly string[];
  pendingVoiceRecordingErrors: Readonly<Record<string, string>>;
  pendingVoiceInputDismissals: Readonly<
    Record<string, NonNullable<QueueMessageRequest["dismissUserInput"]>>
  >;
  retryPendingVoiceRecording(recording: VoiceRecordingRecovery): Promise<void>;
  updateUserInputDraft(
    attentionId: string,
    draft: UpdateUserInputDraftRequest,
    timing: "immediate" | "debounced",
  ): void;
  flushUserInputDraft(attentionId: string): void;
  clearUserInputDraft(attentionId: string): void;
  reconnect(): number;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({
  settings,
  children,
}: PropsWithChildren<{ settings: ConnectionSettings }>) {
  const { language } = useI18n();
  const api = useMemo(() => new ApiClient(settings), [settings]);
  const [state, dispatch] = useReducer(clientReducer, initialState);
  const stateRef = useRef(state);
  const languageRef = useRef(language);
  const [generation, setGeneration] = useState(0);
  const [foregroundEpoch, setForegroundEpoch] = useState(0);
  const [streamRecoveryEpoch, setStreamRecoveryEpoch] = useState(0);
  const [pendingQuestionRecordings, setPendingQuestionRecordings] = useState<
    PendingQuestionRecording[]
  >([]);
  const [pendingUserInputSubmissions, setPendingUserInputSubmissions] = useState<OutboxMessage[]>(
    [],
  );
  const questionUploadRef = useRef<(recording: PendingVoiceRecording) => Promise<void>>(
    async () => undefined,
  );
  const voiceUploadLocks = useRef(new Map<string, Promise<void>>());
  const unsavedVoiceRecordings = useRef(new Map<string, PendingVoiceRecording>());
  const voiceStaging = useRef(new Map<string, Promise<boolean>>());
  const [pendingVoiceRecordingThreadIds, setPendingVoiceRecordingThreadIds] = useState<string[]>(
    [],
  );
  const [pendingVoiceRecordingErrors, setPendingVoiceRecordingErrors] = useState<
    Record<string, string>
  >({});
  const [pendingVoiceInputDismissals, setPendingVoiceInputDismissals] = useState<
    Record<string, NonNullable<QueueMessageRequest["dismissUserInput"]>>
  >({});
  const [appActive, setAppActive] = useState(() => document.visibilityState === "visible");
  const generationRef = useRef(0);
  const connectionEpoch = useRef(0);
  const streamVersion = useRef<{ instanceId: string; sequence: number } | null>(null);
  const receivedStreamSnapshot = useRef(false);
  const threadEventVersions = useRef(new Map<string, ProjectionVersion>());
  const detailRequests = useRef(new Map<string, Promise<ThreadDetail>>());
  const historyRequests = useRef(new Map<string, Promise<void>>());
  const turnItemRequests = useRef(new Map<string, Promise<void>>());
  const persistedDetails = useRef<Record<string, ThreadDetail>>({});
  const detailPersistTimers = useRef(new Map<string, number>());
  const persistenceConnectionKey = useRef(connectionCacheKey(settings));
  const foregroundRefresh = useRef<Promise<void> | null>(null);
  const reliableMessages = useRef(
    new Map<
      string,
      {
        message: OutboxMessage;
        staged: Promise<boolean>;
        commit?: () => void;
        failure?: unknown;
      }
    >(),
  );
  const outboxLocks = useRef(new Map<string, Promise<void>>());
  const outboxRetryTimers = useRef(new Map<string, number>());
  const lastMessageTime = useRef(0);
  const recoveredVoiceRecordingIds = useRef(new Set<string>());
  const pendingVoiceRecordings = useRef(new Map<string, PendingQuestionRecording>());
  const voiceRecoveryDrain = useRef<Promise<void> | null>(null);
  const voiceRecoveryRetryTimer = useRef<number | undefined>(undefined);
  const userInputDraftPersistence = useRef(new Map<string, UserInputDraftPersistence>());
  const browserNotifications = useMemo(
    () => (Capacitor.isNativePlatform() ? null : new BrowserNotificationTracker()),
    [],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const active = new Map(
      (state.snapshot?.attention ?? [])
        .filter((request) => request.kind === "userInput")
        .map((request) => [request.id, request] as const),
    );
    for (const [attentionId, draft] of Object.entries(state.userInputDrafts)) {
      const entry = userInputDraftPersistence.current.get(attentionId);
      if (entry && (entry.inFlight || entry.version > entry.savedVersion)) continue;
      userInputDraftPersistence.current.set(attentionId, {
        draft: {
          ...(draft.appliedRecordingIds
            ? { appliedRecordingIds: [...draft.appliedRecordingIds] }
            : {}),
          answers: cloneUserInputAnswers(draft.answers),
          currentQuestionId: draft.currentQuestionId,
        },
        version: draft.localVersion,
        savedVersion: draft.savedVersion,
        inFlight: false,
        pending: false,
        timer: entry?.timer,
      });
    }
    for (const [attentionId, entry] of userInputDraftPersistence.current) {
      if (state.userInputDrafts[attentionId]) continue;
      if (!state.snapshot) continue;
      const request = active.get(attentionId);
      if (request && request.draft === undefined) continue;
      if (entry.timer !== undefined) window.clearTimeout(entry.timer);
      userInputDraftPersistence.current.delete(attentionId);
    }
  }, [state.snapshot?.attention, state.userInputDrafts]);

  useEffect(() => {
    languageRef.current = language;
    browserNotifications?.setLanguage(language);
  }, [browserNotifications, language]);

  useEffect(() => {
    let active = true;
    const targetGeneration = generationRef.current;
    void Promise.all([loadCachedMeta(settings), listOutboxMessages(settings)]).then(
      ([cached, outbox]) => {
        if (!active) return;
        if (
          cached?.snapshot &&
          generationRef.current === targetGeneration &&
          !streamVersion.current
        ) {
          dispatch({
            type: "hydrate",
            snapshot: normalizeCachedSnapshot(cached.snapshot),
            goals: cached.goals,
          });
        }
        for (const message of outbox) {
          if (message.userInputSubmission) continue;
          dispatch({
            type: "optimistic.add",
            message: {
              id: message.id,
              threadId: message.threadId,
              text: message.input,
              ...pastedText(message),
              images: message.images,
              files: message.files ?? [],
              createdAt: message.createdAt,
              destination: message.deliveryMode === "steer" ? "turn" : "queue",
              turnId: message.steerTurnId ?? null,
              serverAccepted: message.accepted === true,
              ...(message.dismissUserInput ? { dismissUserInput: message.dismissUserInput } : {}),
              ...(message.lastError
                ? {
                    deliveryError: {
                      message: message.lastError,
                      retryable: message.retryable !== false,
                    },
                  }
                : {}),
            },
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [settings]);

  useEffect(() => {
    if (!state.snapshot) return;
    const timer = window.setTimeout(() => {
      void saveCachedMeta(settings, state.snapshot, state.goals);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [settings, state.goals, state.snapshot]);

  useEffect(() => {
    const connectionKey = connectionCacheKey(settings);
    if (persistenceConnectionKey.current !== connectionKey) {
      for (const timer of detailPersistTimers.current.values()) window.clearTimeout(timer);
      detailPersistTimers.current.clear();
      persistedDetails.current = {};
      persistenceConnectionKey.current = connectionKey;
    }
    const previous = persistedDetails.current;
    persistedDetails.current = state.details;
    for (const [threadId, detail] of Object.entries(state.details)) {
      if (previous[threadId] === detail) continue;
      const existing = detailPersistTimers.current.get(threadId);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        if (detailPersistTimers.current.get(threadId) !== timer) return;
        detailPersistTimers.current.delete(threadId);
        void saveCachedThread(settings, detail).then((saved) => {
          if (!saved) return;
          for (const turn of detail.turns) {
            for (const item of turn.items) {
              const record = reliableMessages.current.get(item.id);
              if (
                item.type === "userMessage" &&
                (item.deliveryReceipt?.version === 1 || item.deliveryReceipt?.version === 0) &&
                item.deliveryReceipt.clientId === item.id &&
                item.deliveryReceipt.threadId === threadId &&
                item.deliveryReceipt.turnId === turn.id &&
                record?.message.accepted &&
                record.message.connectionKey === connectionKey
              )
                reliableMessages.current.delete(item.id);
            }
          }
        });
      }, 750);
      detailPersistTimers.current.set(threadId, timer);
    }
    for (const threadId of Object.keys(previous)) {
      if (threadId in state.details) continue;
      const existing = detailPersistTimers.current.get(threadId);
      if (existing !== undefined) window.clearTimeout(existing);
      detailPersistTimers.current.delete(threadId);
      void deleteCachedThread(settings, threadId);
    }
  }, [settings, state.details]);

  useEffect(
    () => () => {
      for (const timer of detailPersistTimers.current.values()) window.clearTimeout(timer);
      detailPersistTimers.current.clear();
    },
    [],
  );

  const invalidateRequests = useCallback(() => {
    connectionEpoch.current += 1;
    detailRequests.current.clear();
    historyRequests.current.clear();
    turnItemRequests.current.clear();
  }, []);

  const reconnect = useCallback(() => {
    const next = generationRef.current + 1;
    generationRef.current = next;
    invalidateRequests();
    threadEventVersions.current.clear();
    setGeneration(next);
    return next;
  }, [invalidateRequests]);

  const hydrateCachedDetail = useCallback(
    async (threadId: string): Promise<void> => {
      const snapshot = stateRef.current.snapshot;
      if (!snapshot?.instanceId || stateRef.current.details[threadId]) return;
      const cached = await loadCachedThread(settings, threadId);
      if (stateRef.current.details[threadId]) return;
      const normalized = cached ? normalizeCachedDetail(cached, snapshot) : null;
      if (normalized) dispatch({ type: "hydrate.detail", detail: normalized });
    },
    [settings],
  );

  const readDetail = useCallback(
    (threadId: string, options: DetailReadOptions = {}): Promise<ThreadDetail> => {
      const key = `${threadId}:${options.authoritative ? "refresh" : "read"}`;
      const current = detailRequests.current.get(key);
      if (current) return current;
      const targetGeneration = generationRef.current;
      const targetConnectionEpoch = connectionEpoch.current;
      const targetSnapshot = stateRef.current.snapshot;
      const request = (async () => {
        if (!stateRef.current.details[threadId] && targetSnapshot?.instanceId) {
          const cached = await loadCachedThread(settings, threadId);
          if (
            cached &&
            generationRef.current === targetGeneration &&
            connectionEpoch.current === targetConnectionEpoch
          ) {
            const normalized = normalizeCachedDetail(cached, targetSnapshot);
            if (normalized) dispatch({ type: "hydrate.detail", detail: normalized });
          }
        }
        let rawDetail: ThreadDetail;
        let refreshSnapshot: AppSnapshot | null = null;
        if (options.authoritative) {
          const refreshed = await api.refreshThread(threadId);
          rawDetail = refreshed.detail;
          refreshSnapshot = refreshed.snapshot;
        } else {
          rawDetail = await api.readThread(threadId, { fresh: options.force });
        }
        const fallbackVersion =
          streamVersion.current ??
          (targetSnapshot?.instanceId
            ? { instanceId: targetSnapshot.instanceId, sequence: targetSnapshot.sequence }
            : null);
        if (!rawDetail.version && !fallbackVersion) return rawDetail;
        const detail = normalizeThreadDetail(rawDetail, fallbackVersion);
        if (
          generationRef.current !== targetGeneration ||
          connectionEpoch.current !== targetConnectionEpoch
        ) {
          return detail;
        }
        const activeSnapshot = stateRef.current.snapshot;
        if (
          !activeSnapshot?.instanceId ||
          detail.version?.instanceId !== activeSnapshot.instanceId
        ) {
          throw new ApiClientError(
            "projection_advanced",
            "The backend projection changed while the session was loading",
            425,
          );
        }
        const threadVersion = threadEventVersions.current.get(threadId);
        if (
          threadVersion?.instanceId === detail.version.instanceId &&
          threadVersion.sequence > detail.version.sequence
        ) {
          throw new ApiClientError(
            "projection_advanced",
            "The session changed while its detail was loading",
            425,
          );
        }
        if (refreshSnapshot) {
          const refreshedSnapshot = normalizeServerSnapshot(
            refreshSnapshot,
            detail.version.instanceId,
          );
          if (
            refreshedSnapshot.instanceId === activeSnapshot.instanceId &&
            refreshedSnapshot.sequence >= activeSnapshot.sequence
          ) {
            acceptSnapshotVersion(refreshedSnapshot, threadEventVersions.current);
            dispatch({ type: "snapshot", snapshot: refreshedSnapshot });
          }
        }
        dispatch({ type: "detail", detail });
        return detail;
      })().finally(() => {
        if (detailRequests.current.get(key) === request) detailRequests.current.delete(key);
      });
      detailRequests.current.set(key, request);
      return request;
    },
    [api, settings],
  );

  const refreshDetail = useCallback(
    (threadId: string, options?: DetailReadOptions) => readDetail(threadId, options),
    [readDetail],
  );
  const forceRefreshDetail = useCallback(
    (threadId: string): Promise<ThreadDetail> =>
      readDetail(threadId, { authoritative: true, force: true }),
    [readDetail],
  );
  const loadOlderDetail = useCallback(
    (threadId: string, cursor: string): Promise<void> => {
      const startingDetail = stateRef.current.details[threadId];
      const anchorTurnId = startingDetail?.turns[0]?.id;
      if (!anchorTurnId) return Promise.resolve();
      const key = `${threadId}:${cursor}:${anchorTurnId}`;
      const current = historyRequests.current.get(key);
      if (current) return current;
      const targetGeneration = generationRef.current;
      const targetConnectionEpoch = connectionEpoch.current;
      const request = (async () => {
        const instanceId = stateRef.current.snapshot?.instanceId;
        if (!instanceId) return;
        const readPage = async (pageCursor: string, pageAnchor: string) => {
          if (isLegacyInstanceId(instanceId)) {
            const legacy = await api.readLegacyThreadPage(threadId, pageCursor);
            return {
              instanceId,
              anchorTurnId: pageAnchor,
              turns: legacy.turns,
              olderTurnsCursor: legacy.olderTurnsCursor,
            };
          }
          return api.readThreadHistory(threadId, pageCursor, pageAnchor);
        };
        const readRebasedPage = async () => {
          const refreshed = await api.refreshThread(threadId);
          const refreshedSnapshot = normalizeServerSnapshot(refreshed.snapshot, instanceId);
          const detail = normalizeThreadDetail(refreshed.detail, {
            instanceId: refreshedSnapshot.instanceId,
            sequence: refreshedSnapshot.sequence,
          });
          if (detail.version.instanceId !== refreshedSnapshot.instanceId) {
            throw new ApiClientError(
              "projection_advanced",
              "The backend projection changed while history was rebasing",
              425,
            );
          }
          const pageCursor = detail.olderTurnsCursor;
          const pageAnchor = detail.turns[0]?.id;
          if (!pageCursor || !pageAnchor) return null;
          const page = await readPage(pageCursor, pageAnchor);
          if (page.instanceId !== detail.version.instanceId || page.anchorTurnId !== pageAnchor) {
            throw new ApiClientError(
              "history_changed",
              "The session history changed again while it was rebasing",
              409,
            );
          }
          return { detail, page, snapshot: refreshedSnapshot };
        };
        let page;
        let rebasedDetail: VersionedThreadDetail | null = null;
        let rebasedSnapshot: VersionedSnapshot | null = null;
        try {
          page = await readPage(cursor, anchorTurnId);
        } catch (error) {
          if (!(error instanceof ApiClientError) || error.code !== "history_changed") throw error;
          const rebased = await readRebasedPage();
          if (!rebased) return;
          ({ detail: rebasedDetail, page, snapshot: rebasedSnapshot } = rebased);
        }
        const activeDetail = stateRef.current.details[threadId];
        if (
          !rebasedDetail &&
          (stateRef.current.snapshot?.instanceId !== page.instanceId ||
            activeDetail?.turns[0]?.id !== page.anchorTurnId)
        ) {
          const rebased = await readRebasedPage();
          if (!rebased) return;
          ({ detail: rebasedDetail, page, snapshot: rebasedSnapshot } = rebased);
        }
        if (
          generationRef.current === targetGeneration &&
          connectionEpoch.current === targetConnectionEpoch
        ) {
          if (rebasedDetail && rebasedSnapshot) {
            const activeSnapshot = stateRef.current.snapshot;
            const threadVersion = threadEventVersions.current.get(threadId);
            if (
              !activeSnapshot?.instanceId ||
              activeSnapshot.instanceId !== rebasedDetail.version.instanceId ||
              (threadVersion?.instanceId === rebasedDetail.version.instanceId &&
                threadVersion.sequence > rebasedDetail.version.sequence)
            ) {
              throw new ApiClientError(
                "projection_advanced",
                "The session changed while history was rebasing",
                425,
              );
            }
            if (
              rebasedSnapshot.instanceId === activeSnapshot.instanceId &&
              rebasedSnapshot.sequence >= activeSnapshot.sequence
            ) {
              acceptSnapshotVersion(rebasedSnapshot, threadEventVersions.current);
              dispatch({ type: "snapshot", snapshot: rebasedSnapshot });
            }
          }
          dispatch(
            rebasedDetail
              ? { type: "history.rebase", detail: rebasedDetail, page }
              : { type: "history", threadId, page },
          );
        }
      })().finally(() => {
        if (historyRequests.current.get(key) === request) historyRequests.current.delete(key);
      });
      historyRequests.current.set(key, request);
      return request;
    },
    [api],
  );
  const loadTurnItems = useCallback(
    (threadId: string, turnId: string): Promise<void> => {
      const key = `${threadId}:${turnId}`;
      const current = turnItemRequests.current.get(key);
      if (current) return current;
      const targetGeneration = generationRef.current;
      const targetConnectionEpoch = connectionEpoch.current;
      const request = api
        .readTurnItems(threadId, turnId)
        .then((response) => {
          if (
            generationRef.current !== targetGeneration ||
            connectionEpoch.current !== targetConnectionEpoch
          ) {
            return;
          }
          dispatch({ type: "turn.items", threadId, turnId, items: response.items });
        })
        .finally(() => {
          if (turnItemRequests.current.get(key) === request) turnItemRequests.current.delete(key);
        });
      turnItemRequests.current.set(key, request);
      return request;
    },
    [api],
  );

  const scheduleOutboxRetry = useCallback(
    (threadId: string, attempt: number, drain: () => void) => {
      if (outboxRetryTimers.current.has(threadId)) return;
      const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
      const base = delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)] ?? 30_000;
      const wait = Math.min(30_000, Math.round(base * (0.8 + Math.random() * 0.4)));
      const timer = window.setTimeout(() => {
        outboxRetryTimers.current.delete(threadId);
        drain();
      }, wait);
      outboxRetryTimers.current.set(threadId, timer);
    },
    [],
  );

  const drainReliableOutbox = useCallback(
    async (onlyThreadId?: string): Promise<void> => {
      const diskMessages = await listOutboxMessages(settings);
      for (const message of diskMessages) {
        if (!reliableMessages.current.has(message.id)) {
          reliableMessages.current.set(message.id, { message, staged: Promise.resolve(true) });
        }
        lastMessageTime.current = Math.max(lastMessageTime.current, message.createdAt);
      }
      setPendingUserInputSubmissions(
        [...reliableMessages.current.values()]
          .map((record) => record.message)
          .filter((message) => message.userInputSubmission),
      );
      const threadIds = new Set(
        [...reliableMessages.current.values()]
          .filter(
            ({ message }) =>
              message.connectionKey === connectionCacheKey(settings) &&
              (!onlyThreadId || message.threadId === onlyThreadId),
          )
          .map(({ message }) => message.threadId),
      );
      await Promise.all(
        [...threadIds].map((threadId) => {
          const previous = outboxLocks.current.get(threadId) ?? Promise.resolve();
          const operation = previous
            .catch(() => undefined)
            .then(async () => {
              if (outboxRetryTimers.current.has(threadId)) return;
              const records = [...reliableMessages.current.values()]
                .filter(
                  ({ message }) =>
                    message.threadId === threadId &&
                    message.connectionKey === connectionCacheKey(settings),
                )
                .sort((a, b) => a.message.createdAt - b.message.createdAt);
              for (const record of records) {
                const message = record.message;
                if (
                  reliableMessages.current.get(message.id) !== record ||
                  message.accepted ||
                  message.retryable === false
                )
                  continue;
                if (!(await record.staged)) continue;
                try {
                  if (message.userInputSubmission) {
                    if ((await Promise.all(voiceStaging.current.values())).some((saved) => !saved))
                      throw new Error("Не удалось надежно сохранить запись на устройстве");
                    if (
                      [...unsavedVoiceRecordings.current.values()].some(
                        (recording) =>
                          recording.userInput?.draftKey === message.userInputSubmission!.draftKey &&
                          recording.threadId === threadId,
                      )
                    ) {
                      throw new Error(
                        translate(
                          languageRef.current,
                          "Не удалось надежно сохранить запись на устройстве",
                        ),
                      );
                    }
                    const uploads = (await listPendingVoiceRecordings(settings)).filter(
                      (recording) =>
                        recording.threadId === threadId &&
                        recording.userInput?.draftKey === message.userInputSubmission!.draftKey,
                    );
                    for (const recording of uploads) await questionUploadRef.current(recording);
                    await api.submitUserInputVoices(
                      threadId,
                      message.userInputSubmission.draftKey,
                      { ...message.userInputSubmission, clientMessageId: message.id },
                    );
                  } else
                    await api.enqueue(threadId, {
                      input: message.input,
                      ...(message.deliveryMode ? { deliveryMode: message.deliveryMode } : {}),
                      ...pastedText(message),
                      ...(message.images.length ? { images: message.images } : {}),
                      ...(message.files?.length ? { files: message.files } : {}),
                      ...(message.goal ? { goal: true } : {}),
                      ...(message.planImplementationMode
                        ? { planImplementationMode: message.planImplementationMode }
                        : {}),
                      clientMessageId: message.id,
                      ...(message.projectDraft ? { projectDraft: message.projectDraft } : {}),
                      ...(message.draftUpdatedAt !== undefined
                        ? { draftUpdatedAt: message.draftUpdatedAt }
                        : {}),
                      ...(message.replyToAsyncQuestion
                        ? { replyToAsyncQuestion: message.replyToAsyncQuestion }
                        : {}),
                      ...(message.replyToUserInput
                        ? { replyToUserInput: message.replyToUserInput }
                        : {}),
                      ...(message.dismissUserInput
                        ? { dismissUserInput: message.dismissUserInput }
                        : {}),
                    });
                  record.message = {
                    ...message,
                    accepted: true,
                    lastError: null,
                    retryable: undefined,
                  };
                  record.failure = undefined;
                  record.commit?.();
                  if (!message.userInputSubmission)
                    dispatch({
                      type: "optimistic.add",
                      message: {
                        id: message.id,
                        threadId,
                        text: message.input,
                        ...pastedText(message),
                        images: message.images,
                        files: message.files ?? [],
                        createdAt: message.createdAt,
                        destination: message.deliveryMode === "steer" ? "turn" : "queue",
                        turnId: message.steerTurnId ?? null,
                        serverAccepted: true,
                        ...(message.dismissUserInput
                          ? { dismissUserInput: message.dismissUserInput }
                          : {}),
                      },
                    });
                  await acknowledgeOutboxMessage(record.message);
                  if (message.userInputSubmission)
                    setPendingUserInputSubmissions(
                      [...reliableMessages.current.values()]
                        .map((record) => record.message)
                        .filter((message) => message.userInputSubmission),
                    );
                } catch (error) {
                  record.failure = error;
                  const retryable = isRetryableApiError(error);
                  record.message = {
                    ...message,
                    attempts: message.attempts + 1,
                    retryable,
                    lastError:
                      error instanceof ApiClientError && error.code === "connection_failed"
                        ? "Нет связи — повторим отправку"
                        : retryable
                          ? "Сервер временно недоступен — повторим отправку"
                          : error instanceof Error
                            ? error.message
                            : "Не удалось отправить сообщение",
                  };
                  const saved = await putOutboxMessage(record.message);
                  if (saved) {
                    record.staged = Promise.resolve(true);
                    record.commit?.();
                  }
                  if (message.userInputSubmission)
                    setPendingUserInputSubmissions(
                      [...reliableMessages.current.values()]
                        .map((record) => record.message)
                        .filter((message) => message.userInputSubmission),
                    );
                  else
                    dispatch({
                      type: "optimistic.error",
                      threadId,
                      messageId: message.id,
                      error: { message: record.message.lastError!, retryable },
                    });
                  if (retryable) {
                    scheduleOutboxRetry(
                      threadId,
                      record.message.attempts,
                      () => void drainReliableOutbox(threadId),
                    );
                    break;
                  }
                }
              }
            })
            .finally(() => {
              if (outboxLocks.current.get(threadId) === operation)
                outboxLocks.current.delete(threadId);
            });
          outboxLocks.current.set(threadId, operation);
          return operation;
        }),
      );
    },
    [api, scheduleOutboxRetry, settings],
  );

  const sendReliable = useCallback(
    async (
      threadId: string,
      body: ReliableMessageRequest,
      onCommitted?: () => void,
      source?: MessageDraftSource,
    ): Promise<"delivered" | "pending"> => {
      const message: OutboxMessage = {
        id: body.clientMessageId,
        connectionKey: connectionCacheKey(settings),
        threadId,
        input: body.input,
        ...(body.deliveryMode
          ? {
              deliveryMode: body.deliveryMode,
              ...(body.deliveryMode === "steer"
                ? {
                    steerTurnId:
                      stateRef.current.snapshot?.threads.find((thread) => thread.id === threadId)
                        ?.currentTurnId ?? undefined,
                  }
                : {}),
            }
          : {}),
        ...pastedText(body),
        images: body.images ?? [],
        files: body.files ?? [],
        goal: body.goal ?? false,
        ...(body.projectDraft ? { projectDraft: body.projectDraft } : {}),
        ...(body.draftUpdatedAt !== undefined ? { draftUpdatedAt: body.draftUpdatedAt } : {}),
        ...(body.planImplementationMode
          ? { planImplementationMode: body.planImplementationMode }
          : {}),
        ...(body.replyToAsyncQuestion ? { replyToAsyncQuestion: body.replyToAsyncQuestion } : {}),
        ...(body.replyToUserInput ? { replyToUserInput: body.replyToUserInput } : {}),
        ...(body.dismissUserInput ? { dismissUserInput: body.dismissUserInput } : {}),
        ...(body.userInputSubmission ? { userInputSubmission: body.userInputSubmission } : {}),
        createdAt: (lastMessageTime.current = Math.max(Date.now(), lastMessageTime.current + 1)),
        attempts: 0,
        lastError: null,
      };
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        onCommitted?.();
      };
      const previous = reliableMessages.current.get(message.id);
      if (previous && outboxMessageIntent(previous.message) !== outboxMessageIntent(message)) {
        throw new Error("Идентификатор сообщения уже использован для другого ответа");
      }
      const record = previous ?? {
        message,
        staged: putOutboxMessage(message, source),
        commit,
        failure: undefined as unknown,
      };
      reliableMessages.current.set(message.id, record);
      if (message.userInputSubmission)
        setPendingUserInputSubmissions(
          [...reliableMessages.current.values()]
            .map((record) => record.message)
            .filter((message) => message.userInputSubmission),
        );
      const persisted = await record.staged;
      if (!persisted) {
        if (!previous) reliableMessages.current.delete(message.id);
        setPendingUserInputSubmissions(
          [...reliableMessages.current.values()]
            .map((record) => record.message)
            .filter((message) => message.userInputSubmission),
        );
        throw new Error("Не удалось сохранить сообщение на устройстве. Повторите отправку.");
      }
      commit();
      await drainReliableOutbox(threadId);
      if (record.message.accepted) return "delivered";
      if (!(await record.staged)) {
        reliableMessages.current.delete(message.id);
        throw record.failure ?? new Error("Не удалось сохранить сообщение");
      }
      return "pending";
    },
    [drainReliableOutbox, settings],
  );

  const retryReliableMessage = useCallback(
    async (threadId: string, messageId: string) => {
      const record = reliableMessages.current.get(messageId);
      if (!record || record.message.threadId !== threadId || record.message.accepted) return;
      window.clearTimeout(outboxRetryTimers.current.get(threadId));
      outboxRetryTimers.current.delete(threadId);
      record.message = { ...record.message, retryable: undefined, lastError: null };
      await putOutboxMessage(record.message);
      dispatch({ type: "optimistic.error", threadId, messageId, error: undefined });
      await drainReliableOutbox(threadId);
    },
    [drainReliableOutbox],
  );

  const forgetReliableMessage = useCallback(
    async (threadId: string, messageId: string) => {
      const pending = reliableMessages.current.get(messageId)?.message.userInputSubmission;
      if (pending) {
        await outboxLocks.current.get(threadId);
        await api.cancelUserInputSubmission(threadId, pending.draftKey);
      }
      reliableMessages.current.delete(messageId);
      setPendingUserInputSubmissions(
        [...reliableMessages.current.values()]
          .map((record) => record.message)
          .filter((message) => message.userInputSubmission),
      );
      await deleteOutboxMessage(messageId);
      dispatch({ type: "optimistic.remove", threadId, messageId });
    },
    [api],
  );

  const publishPendingVoiceRecordingThreads = useCallback(() => {
    const threadIds = new Set<string>();
    const errors: Record<string, string> = {};
    const dismissals: Record<string, NonNullable<QueueMessageRequest["dismissUserInput"]>> = {};
    setPendingQuestionRecordings(
      [...pendingVoiceRecordings.current.values()].filter((recording) => recording.userInput),
    );
    for (const recording of pendingVoiceRecordings.current.values()) {
      if (recording.userInput) continue;
      threadIds.add(recording.threadId);
      if (recording.lastError && errors[recording.threadId] === undefined) {
        errors[recording.threadId] = recording.lastError;
      }
      if (!recording.lastError && recording.mode !== "draft" && recording.dismissUserInput) {
        dismissals[recording.threadId] = recording.dismissUserInput;
      }
    }
    setPendingVoiceRecordingThreadIds([...threadIds]);
    setPendingVoiceRecordingErrors(errors);
    setPendingVoiceInputDismissals(dismissals);
  }, []);

  const trackPendingVoiceRecording = useCallback(
    (
      recording: Pick<
        PendingVoiceRecording,
        | "id"
        | "threadId"
        | "lastError"
        | "dismissUserInput"
        | "mode"
        | "userInput"
        | "createdAt"
        | "durationMs"
      >,
    ) => {
      pendingVoiceRecordings.current.set(recording.id, {
        id: recording.id,
        userInput: recording.userInput,
        durationMs: recording.durationMs,
        createdAt: recording.createdAt,
        threadId: recording.threadId,
        lastError: recording.lastError,
        dismissUserInput: recording.dismissUserInput,
        mode: recording.mode,
      });
      publishPendingVoiceRecordingThreads();
    },
    [publishPendingVoiceRecordingThreads],
  );

  const untrackPendingVoiceRecording = useCallback(
    (id: string) => {
      if (!pendingVoiceRecordings.current.delete(id)) return;
      publishPendingVoiceRecordingThreads();
    },
    [publishPendingVoiceRecordingThreads],
  );

  const uploadVoiceRecording = useCallback(
    (recording: PendingVoiceRecording): Promise<void> => {
      const existing = voiceUploadLocks.current.get(recording.id);
      if (existing) return existing;
      const operation = (async () => {
        let prepared = recording;
        trackPendingVoiceRecording({ ...recording, lastError: null });
        try {
          if (
            !prepared.userInput &&
            !Object.prototype.hasOwnProperty.call(prepared, "serverDraftUpdatedAt")
          ) {
            const savedDraft = await api.updateThreadDraft(prepared.threadId, prepared.draft, {
              retry: false,
              expectedUpdatedAt: prepared.draftUpdatedAt,
            });
            prepared = { ...prepared, serverDraftUpdatedAt: savedDraft?.updatedAt ?? null };
            if (!(await putPendingVoiceRecording(prepared))) {
              throw new Error(
                translate(languageRef.current, "Не удалось надежно сохранить запись на устройстве"),
              );
            }
            await confirmLocalDraft(
              settings,
              prepared.threadId,
              savedDraft,
              prepared.localDraftUpdatedAt,
            );
          }
          const accepted = await api.createVoiceTranscription(prepared.threadId, prepared.audio, {
            recordingDurationMs: prepared.durationMs,
            mode: prepared.mode,
            selectionStart: prepared.selectionStart,
            selectionEnd: prepared.selectionEnd,
            draftUpdatedAt: prepared.serverDraftUpdatedAt ?? null,
            clientUploadId: prepared.id,
            ...(prepared.userInput ? { userInput: prepared.userInput } : {}),
            ...(prepared.mode !== "draft" && prepared.dismissUserInput
              ? { dismissUserInput: prepared.dismissUserInput }
              : {}),
          });
          if (accepted) dispatch({ type: "voice.accepted", job: accepted });
          await deletePendingVoiceRecording(prepared.id);
          recoveredVoiceRecordingIds.current.delete(prepared.id);
          untrackPendingVoiceRecording(prepared.id);
        } catch (error) {
          const current = (await loadPendingVoiceRecording(prepared.id)) ?? prepared;
          const failed = {
            ...current,
            attempts: current.attempts + 1,
            lastError: error instanceof Error ? error.message : "Delivery failed",
          };
          await putPendingVoiceRecording(failed);
          trackPendingVoiceRecording(failed);
          throw error;
        }
      })().finally(() => {
        if (voiceUploadLocks.current.get(recording.id) === operation)
          voiceUploadLocks.current.delete(recording.id);
      });
      voiceUploadLocks.current.set(recording.id, operation);
      return operation;
    },
    [api, settings, trackPendingVoiceRecording, untrackPendingVoiceRecording],
  );

  questionUploadRef.current = uploadVoiceRecording;
  const retryQuestionUpload = useCallback(
    async (id: string) => {
      const recording =
        unsavedVoiceRecordings.current.get(id) ?? (await loadPendingVoiceRecording(id));
      if (recording?.userInput) {
        if (!(await putPendingVoiceRecording(recording)))
          throw new Error(
            translate(languageRef.current, "Не удалось надежно сохранить запись на устройстве"),
          );
        unsavedVoiceRecordings.current.delete(id);
        await uploadVoiceRecording(recording);
      }
    },
    [uploadVoiceRecording],
  );

  const queueVoiceRecording = useCallback(
    async (input: Omit<VoiceRecordingUpload, "localDraftUpdatedAt">): Promise<void> => {
      if (!input.userInput) {
        const existing = await loadPendingVoiceRecording(input.id);
        const localDraftUpdatedAt = existing?.localDraftUpdatedAt ?? Date.now();
        const recording: PendingVoiceRecording = existing ?? {
          ...input,
          connectionKey: connectionCacheKey(settings),
          localDraftUpdatedAt,
          createdAt: Date.now(),
          attempts: 0,
          lastError: null,
        };
        if (!existing && !(await putPendingVoiceRecording(recording)))
          throw new Error(
            translate(languageRef.current, "Не удалось надежно сохранить запись на устройстве"),
          );
        trackPendingVoiceRecording(recording);
        await saveLocalDraft(settings, recording.threadId, recording.draft, localDraftUpdatedAt);
        await uploadVoiceRecording(recording);
        return;
      }
      const recording: PendingVoiceRecording = {
        ...input,
        connectionKey: connectionCacheKey(settings),
        localDraftUpdatedAt: Date.now(),
        createdAt: Date.now(),
        attempts: 0,
        lastError: null,
      };
      trackPendingVoiceRecording(recording);
      unsavedVoiceRecordings.current.set(recording.id, recording);
      const staged = putPendingVoiceRecording(recording);
      voiceStaging.current.set(recording.id, staged);
      try {
        if (!(await staged))
          throw new Error(
            translate(languageRef.current, "Не удалось надежно сохранить запись на устройстве"),
          );
        unsavedVoiceRecordings.current.delete(recording.id);
        await uploadVoiceRecording(recording);
      } catch (error) {
        trackPendingVoiceRecording({
          ...recording,
          lastError: error instanceof Error ? error.message : "Voice upload failed",
        });
        throw error;
      } finally {
        voiceStaging.current.delete(recording.id);
      }
    },
    [settings, trackPendingVoiceRecording, uploadVoiceRecording],
  );

  const retryPendingVoiceRecording = useCallback(
    async (input: VoiceRecordingRecovery): Promise<void> => {
      const recordings = await listPendingVoiceRecordings(settings);
      const recording = recordings
        .filter((candidate) => candidate.threadId === input.threadId && !candidate.userInput)
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!recording) return;
      try {
        await uploadVoiceRecording(recording);
        return;
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== "draft_conflict") throw error;
      }
      const current = (await loadPendingVoiceRecording(recording.id)) ?? recording;
      const unprepared = { ...current };
      delete unprepared.serverDraftUpdatedAt;
      const maxSelection = input.draft.input.length;
      const selectionStart = Math.min(current.selectionStart, maxSelection);
      const rebased: PendingVoiceRecording = {
        ...unprepared,
        mode: input.mode,
        draft: structuredClone(input.draft),
        draftUpdatedAt: input.draftUpdatedAt,
        selectionStart,
        selectionEnd: Math.max(selectionStart, Math.min(current.selectionEnd, maxSelection)),
        lastError: null,
      };
      if (!(await putPendingVoiceRecording(rebased))) {
        throw new Error(
          translate(languageRef.current, "Не удалось надежно сохранить запись на устройстве"),
        );
      }
      trackPendingVoiceRecording(rebased);
      await uploadVoiceRecording(rebased);
    },
    [settings, trackPendingVoiceRecording, uploadVoiceRecording],
  );

  const scheduleVoiceRecoveryRetry = useCallback((attempt: number, drain: () => void) => {
    if (voiceRecoveryRetryTimer.current !== undefined) return;
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
    const base = delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)] ?? 30_000;
    voiceRecoveryRetryTimer.current = window.setTimeout(
      () => {
        voiceRecoveryRetryTimer.current = undefined;
        drain();
      },
      Math.round(base * (0.8 + Math.random() * 0.4)),
    );
  }, []);

  const drainRecoveredVoiceRecordings = useCallback((): Promise<void> => {
    if (voiceRecoveryDrain.current) return voiceRecoveryDrain.current;
    const request = (async () => {
      const recordings = await listPendingVoiceRecordings(settings);
      let retryAttempt: number | null = null;
      for (const recording of recordings) {
        if (!recoveredVoiceRecordingIds.current.has(recording.id)) continue;
        try {
          await uploadVoiceRecording(recording);
        } catch (error) {
          if (
            isRetryableApiError(error) ||
            (error instanceof ApiClientError &&
              error.status === 409 &&
              error.code !== "draft_conflict")
          ) {
            retryAttempt = Math.max(retryAttempt ?? 0, recording.attempts + 1);
          }
        }
      }
      if (retryAttempt !== null) {
        scheduleVoiceRecoveryRetry(retryAttempt, () => void drainRecoveredVoiceRecordings());
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        if (voiceRecoveryDrain.current === request) voiceRecoveryDrain.current = null;
      });
    voiceRecoveryDrain.current = request;
    return request;
  }, [scheduleVoiceRecoveryRetry, settings, uploadVoiceRecording]);

  const persistUserInputDraft = useCallback(
    function persist(attentionId: string): void {
      const entry = userInputDraftPersistence.current.get(attentionId);
      if (!entry) return;
      if (entry.timer !== undefined) {
        window.clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      if (entry.inFlight) {
        entry.pending = true;
        return;
      }
      if (entry.version <= entry.savedVersion) return;
      const version = entry.version;
      const request = stateRef.current.snapshot?.attention.find(
        (candidate) => candidate.id === attentionId,
      );
      const draft = normalizeUserInputDraft(
        appendUserInputRecordings(
          entry.draft,
          request?.kind === "userInput" ? (request.draft?.recordings ?? []) : [],
        ),
      );
      entry.draft = draft;
      entry.inFlight = true;
      entry.pending = false;
      dispatch({ type: "userInputDraft.saving", attentionId, version });
      void api
        .updateUserInputDraft(attentionId, draft)
        .then((saved) => {
          if (userInputDraftPersistence.current.get(attentionId) !== entry) return;
          entry.savedVersion = Math.max(entry.savedVersion, version);
          dispatch({ type: "userInputDraft.saved", attentionId, version, draft: saved });
        })
        .catch((caught: unknown) => {
          if (userInputDraftPersistence.current.get(attentionId) !== entry) return;
          dispatch({
            type: "userInputDraft.failed",
            attentionId,
            error: caught instanceof Error ? caught.message : "Draft save failed",
          });
        })
        .finally(() => {
          if (userInputDraftPersistence.current.get(attentionId) !== entry) return;
          entry.inFlight = false;
          if (!entry.pending) return;
          entry.pending = false;
          persist(attentionId);
        });
    },
    [api],
  );

  const updateUserInputDraft = useCallback(
    (
      attentionId: string,
      input: UpdateUserInputDraftRequest,
      timing: "immediate" | "debounced",
    ): void => {
      const draft = {
        ...(input.appliedRecordingIds
          ? { appliedRecordingIds: [...input.appliedRecordingIds] }
          : {}),
        answers: cloneUserInputAnswers(input.answers),
        currentQuestionId: input.currentQuestionId,
      };
      let entry = userInputDraftPersistence.current.get(attentionId);
      if (!entry) {
        const current = stateRef.current.userInputDrafts[attentionId];
        entry = {
          draft: current
            ? {
                ...(current.appliedRecordingIds
                  ? { appliedRecordingIds: [...current.appliedRecordingIds] }
                  : {}),
                answers: cloneUserInputAnswers(current.answers),
                currentQuestionId: current.currentQuestionId,
              }
            : { answers: {}, currentQuestionId: null },
          version: current?.localVersion ?? 0,
          savedVersion: current?.savedVersion ?? 0,
          inFlight: current?.saving ?? false,
          pending: false,
          timer: undefined,
        };
        userInputDraftPersistence.current.set(attentionId, entry);
      }
      if (sameUserInputDraft(entry.draft, draft)) {
        if (timing === "immediate") persistUserInputDraft(attentionId);
        return;
      }
      entry.draft = draft;
      entry.version += 1;
      dispatch({
        type: "userInputDraft.edit",
        attentionId,
        draft,
        version: entry.version,
      });
      if (entry.timer !== undefined) window.clearTimeout(entry.timer);
      entry.timer = undefined;
      if (timing === "immediate") {
        persistUserInputDraft(attentionId);
      } else {
        entry.timer = window.setTimeout(() => persistUserInputDraft(attentionId), 500);
      }
    },
    [persistUserInputDraft],
  );

  const flushUserInputDraft = useCallback(
    (attentionId: string): void => persistUserInputDraft(attentionId),
    [persistUserInputDraft],
  );

  const clearUserInputDraft = useCallback((attentionId: string): void => {
    const entry = userInputDraftPersistence.current.get(attentionId);
    if (entry?.timer !== undefined) window.clearTimeout(entry.timer);
    userInputDraftPersistence.current.delete(attentionId);
    dispatch({ type: "userInputDraft.clear", attentionId });
  }, []);

  useEffect(() => {
    const flushAll = () => {
      for (const attentionId of userInputDraftPersistence.current.keys()) {
        persistUserInputDraft(attentionId);
      }
    };
    window.addEventListener("pagehide", flushAll);
    return () => {
      window.removeEventListener("pagehide", flushAll);
      flushAll();
    };
  }, [persistUserInputDraft]);

  useEffect(() => {
    const wake = () => {
      for (const timer of outboxRetryTimers.current.values()) window.clearTimeout(timer);
      outboxRetryTimers.current.clear();
      void drainReliableOutbox();
      void drainRecoveredVoiceRecordings();
    };
    window.addEventListener("online", wake);
    void drainReliableOutbox();
    return () => {
      window.removeEventListener("online", wake);
      for (const timer of outboxRetryTimers.current.values()) window.clearTimeout(timer);
      outboxRetryTimers.current.clear();
      if (voiceRecoveryRetryTimer.current !== undefined) {
        window.clearTimeout(voiceRecoveryRetryTimer.current);
        voiceRecoveryRetryTimer.current = undefined;
      }
    };
  }, [drainRecoveredVoiceRecordings, drainReliableOutbox]);

  useEffect(() => {
    let active = true;
    void listPendingVoiceRecordings(settings)
      .then((recordings) => {
        if (!active) return;
        pendingVoiceRecordings.current.clear();
        for (const recording of recordings) {
          // First-message audio resumes through its persisted preparation, which
          // also owns creation/settings and keeps a stable session identity.
          if (!recording.newSessionProjectId) recoveredVoiceRecordingIds.current.add(recording.id);
          pendingVoiceRecordings.current.set(recording.id, {
            id: recording.id,
            userInput: recording.userInput,
            durationMs: recording.durationMs,
            createdAt: recording.createdAt,
            threadId: recording.threadId,
            lastError: recording.lastError,
            dismissUserInput: recording.dismissUserInput,
            mode: recording.mode,
          });
        }
        publishPendingVoiceRecordingThreads();
        void drainRecoveredVoiceRecordings();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      recoveredVoiceRecordingIds.current.clear();
      pendingVoiceRecordings.current.clear();
      publishPendingVoiceRecordingThreads();
    };
  }, [drainRecoveredVoiceRecordings, publishPendingVoiceRecordingThreads, settings]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let heartbeatTimeout: number | undefined;
    let retry = 0;
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

    const clearHeartbeat = () => {
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer);
      if (heartbeatTimeout !== undefined) window.clearTimeout(heartbeatTimeout);
      heartbeatTimer = undefined;
      heartbeatTimeout = undefined;
    };

    const scheduleHeartbeat = (candidate: WebSocket) => {
      clearHeartbeat();
      if (stopped || socket !== candidate) return;
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = undefined;
        if (stopped || socket !== candidate || candidate.readyState !== WebSocket.OPEN) return;
        candidate.send(JSON.stringify({ type: "ping" }));
        heartbeatTimeout = window.setTimeout(() => {
          heartbeatTimeout = undefined;
          if (!stopped && socket === candidate) candidate.close();
        }, HEARTBEAT_TIMEOUT_MS);
      }, HEARTBEAT_IDLE_MS);
    };

    const connect = () => {
      if (stopped) return;
      dispatch({ type: "network", network: "connecting" });
      const candidate = new WebSocket(api.webSocketUrl());
      const legacyInstanceId = `legacy:${generationRef.current}:${connectionEpoch.current}`;
      socket = candidate;
      candidate.addEventListener("open", () => {
        if (stopped || socket !== candidate) return;
        candidate.send(JSON.stringify({ type: "authenticate", token: settings.token }));
      });
      candidate.addEventListener("message", (message) => {
        if (stopped || socket !== candidate) return;
        let frame: unknown;
        try {
          frame = JSON.parse(String(message.data));
        } catch {
          candidate.close();
          return;
        }
        if (!isServerFrame(frame)) {
          candidate.close();
          return;
        }
        scheduleHeartbeat(candidate);
        if (frame.type === "snapshot") {
          const snapshot = normalizeServerSnapshot(frame.snapshot, legacyInstanceId);
          if (streamVersion.current) invalidateRequests();
          retry = 0;
          streamVersion.current = {
            instanceId: snapshot.instanceId,
            sequence: snapshot.sequence,
          };
          acceptSnapshotVersion(snapshot, threadEventVersions.current);
          browserNotifications?.acceptSnapshot(snapshot);
          observeNativeNotificationSnapshot(snapshot);
          dispatch({ type: "snapshot", snapshot });
          if (receivedStreamSnapshot.current) {
            setStreamRecoveryEpoch((current) => current + 1);
          } else {
            receivedStreamSnapshot.current = true;
          }
          void drainReliableOutbox();
        } else if (frame.type === "event") {
          const current = streamVersion.current;
          const version =
            frame.version ??
            (current ? { instanceId: current.instanceId, sequence: frame.sequence } : null);
          if (
            !current ||
            !version ||
            version.instanceId !== current.instanceId ||
            version.sequence !== current.sequence + 1
          ) {
            candidate.close();
            return;
          }
          streamVersion.current = version;
          const threadId = serverEventThreadId(frame.event);
          if (threadId) threadEventVersions.current.set(threadId, version);
          browserNotifications?.acceptEvent(frame.event);
          observeNativeNotificationEvent(version.sequence, frame.event);
          dispatch({ type: "event", version, event: frame.event });
        } else if (frame.type === "error") {
          dispatch({ type: "network", network: "offline", error: frame.error.message });
        }
      });
      candidate.addEventListener("close", () => {
        if (stopped || socket !== candidate) return;
        socket = undefined;
        clearHeartbeat();
        invalidateRequests();
        threadEventVersions.current.clear();
        streamVersion.current = null;
        dispatch({
          type: "network",
          network: "offline",
          error: translate(languageRef.current, "Связь с сервером потеряна"),
        });
        const baseDelay = delays[Math.min(retry, delays.length - 1)] ?? 30_000;
        const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
        retry += 1;
        retryTimer = window.setTimeout(connect, delay);
      });
      candidate.addEventListener("error", () => candidate.close());
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      clearHeartbeat();
      invalidateRequests();
      threadEventVersions.current.clear();
      streamVersion.current = null;
      socket?.close();
    };
  }, [
    api,
    browserNotifications,
    drainReliableOutbox,
    generation,
    invalidateRequests,
    settings.token,
  ]);

  useEffect(() => {
    const refresh = () => {
      if (foregroundRefresh.current) return;
      reconnect();
      const request = drainReliableOutbox()
        .catch(() => undefined)
        .finally(() => {
          if (foregroundRefresh.current === request) foregroundRefresh.current = null;
        });
      foregroundRefresh.current = request;
    };
    const foreground = () => {
      const active = document.visibilityState === "visible";
      setAppActive(active);
      if (active) refresh();
    };
    let removeNativeListener: (() => Promise<void>) | undefined;
    if (Capacitor.isNativePlatform()) {
      setNativeNotificationAppActive(true);
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        setNativeNotificationAppActive(isActive);
        setAppActive(isActive);
        if (isActive) {
          setForegroundEpoch((current) => current + 1);
          refresh();
        }
      }).then((handle) => {
        removeNativeListener = () => handle.remove();
      });
    } else {
      document.addEventListener("visibilitychange", foreground);
    }
    return () => {
      document.removeEventListener("visibilitychange", foreground);
      setNativeNotificationAppActive(true);
      void removeNativeListener?.();
    };
  }, [drainReliableOutbox, reconnect]);

  const value = useMemo(
    () => ({
      api,
      state,
      appActive,
      foregroundEpoch,
      streamRecoveryEpoch,
      dispatch,
      hydrateCachedDetail,
      refreshDetail,
      forceRefreshDetail,
      loadOlderDetail,
      loadTurnItems,
      sendReliable,
      retryReliableMessage,
      forgetReliableMessage,
      queueVoiceRecording,
      pendingQuestionRecordings,
      pendingUserInputSubmissions,
      retryQuestionUpload,
      pendingVoiceRecordingThreadIds,
      pendingVoiceRecordingErrors,
      pendingVoiceInputDismissals,
      retryPendingVoiceRecording,
      updateUserInputDraft,
      flushUserInputDraft,
      clearUserInputDraft,
      reconnect,
    }),
    [
      api,
      state,
      appActive,
      foregroundEpoch,
      streamRecoveryEpoch,
      hydrateCachedDetail,
      refreshDetail,
      forceRefreshDetail,
      loadOlderDetail,
      loadTurnItems,
      sendReliable,
      retryReliableMessage,
      forgetReliableMessage,
      queueVoiceRecording,
      pendingQuestionRecordings,
      pendingUserInputSubmissions,
      retryQuestionUpload,
      pendingVoiceRecordingThreadIds,
      pendingVoiceRecordingErrors,
      pendingVoiceInputDismissals,
      retryPendingVoiceRecording,
      updateUserInputDraft,
      flushUserInputDraft,
      clearUserInputDraft,
      reconnect,
    ],
  );
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("useConnection must be used inside ConnectionProvider");
  return value;
}

type VersionedThreadDetail = ThreadDetail & { version: ProjectionVersion };
type VersionedSnapshot = AppSnapshot & { instanceId: string };

function normalizeServerSnapshot(
  snapshot: AppSnapshot,
  fallbackInstanceId: string,
): VersionedSnapshot {
  return {
    ...snapshot,
    instanceId: snapshot.instanceId?.trim() || fallbackInstanceId,
  };
}

function normalizeCachedSnapshot(snapshot: AppSnapshot): VersionedSnapshot {
  return normalizeServerSnapshot(snapshot, LEGACY_CACHE_INSTANCE_ID);
}

function normalizeCachedDetail(
  detail: ThreadDetail,
  snapshot: AppSnapshot,
): VersionedThreadDetail | null {
  if (!snapshot.instanceId) return null;
  if (detail.version?.instanceId === snapshot.instanceId) return detail as VersionedThreadDetail;
  if (!detail.version && snapshot.instanceId === LEGACY_CACHE_INSTANCE_ID) {
    return {
      ...detail,
      version: { instanceId: snapshot.instanceId, sequence: snapshot.sequence },
    };
  }
  return null;
}

function normalizeThreadDetail(
  detail: ThreadDetail,
  fallbackVersion: ProjectionVersion | null,
): VersionedThreadDetail {
  if (detail.version) return detail as VersionedThreadDetail;
  if (!fallbackVersion) {
    throw new ApiClientError(
      "projection_unavailable",
      "The backend projection version is unavailable",
      425,
    );
  }
  return { ...detail, version: fallbackVersion };
}

function acceptSnapshotVersion(
  snapshot: VersionedSnapshot,
  versions: Map<string, ProjectionVersion>,
): void {
  versions.clear();
  const version = { instanceId: snapshot.instanceId, sequence: snapshot.sequence };
  for (const thread of snapshot.threads) versions.set(thread.id, version);
}

function isLegacyInstanceId(instanceId: string): boolean {
  return instanceId === LEGACY_CACHE_INSTANCE_ID || instanceId.startsWith("legacy:");
}

function serverEventThreadId(event: ServerEvent): string | null {
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

function normalizeUserInputDraft(input: UpdateUserInputDraftRequest): UpdateUserInputDraftRequest {
  return {
    ...(input.appliedRecordingIds ? { appliedRecordingIds: [...input.appliedRecordingIds] } : {}),
    answers: Object.fromEntries(
      Object.entries(input.answers)
        .filter(([, answers]) => Boolean(answers[0]?.trim()))
        .map(([questionId, answers]) => [questionId, [answers[0]!]]),
    ),
    currentQuestionId: input.currentQuestionId,
  };
}

function cloneUserInputAnswers(answers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, [...values]]));
}

function sameUserInputDraft(
  left: UpdateUserInputDraftRequest,
  right: UpdateUserInputDraftRequest,
): boolean {
  if (
    left.currentQuestionId !== right.currentQuestionId ||
    JSON.stringify(left.appliedRecordingIds) !== JSON.stringify(right.appliedRecordingIds)
  )
    return false;
  const leftEntries = Object.entries(left.answers);
  const rightEntries = Object.entries(right.answers);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([id, answers]) => answers[0] === right.answers[id]?.[0])
  );
}
