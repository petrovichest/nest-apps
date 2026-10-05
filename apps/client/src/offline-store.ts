import { application } from "./application";
import { pastedText, type PastedText } from "@codexnest/protocol";
import type {
  AppSnapshot,
  AsyncQuestionReference,
  UserInputReply,
  SessionSettings,
  PlanImplementationMode,
  ThreadDetail,
  ThreadDraft,
  ThreadGoal,
  ThreadFileAttachment,
  ThreadSummary,
  UpdateThreadDraftRequest,
  VoiceTranscriptionMode,
  UserInputVoiceTarget,
  UpdateUserInputDraftRequest,
} from "@codexnest/protocol";

import type { ConnectionSettings } from "./storage";

const DATABASE_NAME = `${application.storagePrefix}-offline`;
const DATABASE_VERSION = 1;
const THREAD_CACHE_LIMIT_BYTES = 250 * 1024 * 1024;
const THREAD_CACHE_CLEANUP_INTERVAL_MS = 30_000;

const META_STORE = "meta";
const THREAD_STORE = "threads";
const DRAFT_STORE = "drafts";
const OUTBOX_STORE = "outbox";
const RECORDING_STORE = "recordings";

export type CachedMeta = {
  snapshot: AppSnapshot | null;
  goals: Record<string, ThreadGoal | null>;
  updatedAt: number;
};

type CachedThread = {
  key: string;
  connectionKey: string;
  threadId: string;
  detail: ThreadDetail;
  accessedAt: number;
  bytes: number;
  formatVersion?: number;
};

export type LocalDraft = {
  key: string;
  connectionKey: string;
  threadId: string;
  value: UpdateThreadDraftRequest;
  updatedAt: number;
};

export type LocalNewSessionDraft = {
  key: string;
  connectionKey: string;
  projectId: string;
  clientCreationId?: string;
  value: UpdateThreadDraftRequest;
  phase?: "creating" | "transferring";
  threadId?: string | null;
  thread?: ThreadSummary | null;
  revision?: number;
  settings?: SessionSettings;
  submission?: NewSessionSubmission;
  voiceSubmission?: NewSessionVoiceSubmission;
  sharedDraftUpdatedAt?: number;
  attachments?: NewSessionAttachment[];
  updatedAt: number;
};

export type NewSessionAttachment = {
  attachment: ThreadFileAttachment;
  file: Blob;
};

export type NewSessionVoiceSubmission = {
  recording: {
    id: string;
    audio: Blob;
    durationMs: number;
    selection: { start: number; end: number };
  };
  draft: UpdateThreadDraftRequest;
  draftUpdatedAt?: number | null;
  deliveryError?: { message: string; retryable: boolean };
};

export type NewSessionSubmission = {
  id: string;
  intent: "queue" | "immediate";
  input: string;
  draft: UpdateThreadDraftRequest;
  /** The submitted draft has been separated from the next composer draft. */
  staged?: boolean;
  deliveryError?: { message: string; retryable: boolean };
};

export type OutboxMessage = PastedText & {
  draftUpdatedAt?: number | null;
  projectDraft?: { projectId: string; updatedAt: number };
  id: string;
  connectionKey: string;
  threadId: string;
  input: string;
  images: string[];
  files?: ThreadFileAttachment[];
  goal: boolean;
  planImplementationMode?: PlanImplementationMode;
  createdAt: number;
  attempts: number;
  lastError: string | null;
  retryable?: boolean;
  accepted?: boolean;
  replyToAsyncQuestion?: AsyncQuestionReference;
  replyToUserInput?: UserInputReply;
  dismissUserInput?: AsyncQuestionReference;
  userInputSubmission?: {
    draftKey: string;
    draft: UpdateUserInputDraftRequest;
    recordingIds: string[];
  };
};

export type MessageDraftSource = { draft: UpdateThreadDraftRequest; projectId?: string };

export type PendingVoiceRecording = {
  id: string;
  connectionKey: string;
  threadId: string;
  /** The persisted new-session preparation owns recovery until server acceptance. */
  newSessionProjectId?: string;
  audio: Blob;
  durationMs: number;
  mode: VoiceTranscriptionMode;
  userInput?: UserInputVoiceTarget;
  dismissUserInput?: AsyncQuestionReference;
  selectionStart: number;
  selectionEnd: number;
  draftUpdatedAt: number | null;
  draft: UpdateThreadDraftRequest;
  localDraftUpdatedAt: number;
  serverDraftUpdatedAt?: number | null;
  createdAt: number;
  attempts: number;
  lastError: string | null;
};

let cleanupStartedAt = 0;

export function connectionCacheKey(settings: ConnectionSettings): string {
  return `${settings.baseUrl.replace(/\/+$/u, "")}\0${tokenFingerprint(settings.token)}`;
}

export async function loadCachedMeta(settings: ConnectionSettings): Promise<CachedMeta | null> {
  return readValue<CachedMeta>(META_STORE, connectionCacheKey(settings));
}

export async function saveCachedMeta(
  settings: ConnectionSettings,
  snapshot: AppSnapshot | null,
  goals: Record<string, ThreadGoal | null>,
): Promise<void> {
  await writeValue(META_STORE, {
    key: connectionCacheKey(settings),
    snapshot,
    goals,
    updatedAt: Date.now(),
  });
}

export async function loadCachedThread(
  settings: ConnectionSettings,
  threadId: string,
): Promise<ThreadDetail | null> {
  const key = scopedKey(connectionCacheKey(settings), threadId);
  const cached = await readValue<CachedThread>(THREAD_STORE, key);
  if (!cached) return null;
  void writeValue(THREAD_STORE, { ...cached, accessedAt: Date.now() });
  if (cached.formatVersion === 2) return cached.detail;
  const detail = lightweightCachedDetail(cached.detail);
  void saveCachedThread(settings, detail);
  return detail;
}

export async function saveCachedThread(
  settings: ConnectionSettings,
  detail: ThreadDetail,
): Promise<boolean> {
  const connectionKey = connectionCacheKey(settings);
  const serialized = JSON.stringify(detail);
  const cached = {
    key: scopedKey(connectionKey, detail.summary.id),
    connectionKey,
    threadId: detail.summary.id,
    detail,
    accessedAt: Date.now(),
    bytes: new Blob([serialized]).size,
    formatVersion: 2,
  } satisfies CachedThread;
  const confirmed = cachedUserMessageIds(detail);
  const saved = await writeTransaction([THREAD_STORE, OUTBOX_STORE], (transaction) => {
    transaction.objectStore(THREAD_STORE).put(cached);
    const outbox = transaction.objectStore(OUTBOX_STORE);
    const cursor = outbox.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const message = entry.value as OutboxMessage;
      if (
        message.connectionKey === connectionKey &&
        message.threadId === detail.summary.id &&
        message.accepted &&
        confirmed.has(message.id)
      )
        entry.delete();
      entry.continue();
    };
  });
  void cleanupThreadCache();
  return saved;
}

function lightweightCachedDetail(detail: ThreadDetail): ThreadDetail {
  return {
    ...detail,
    turns: detail.turns.map((turn) => ({
      ...turn,
      itemsLoaded: false,
      items: turn.items.filter(
        (item) =>
          item.type !== "reasoning" &&
          item.type !== "command" &&
          item.type !== "fileChange" &&
          item.type !== "tool",
      ),
    })),
  };
}

export async function deleteCachedThread(
  settings: ConnectionSettings,
  threadId: string,
): Promise<void> {
  await deleteValue(THREAD_STORE, scopedKey(connectionCacheKey(settings), threadId));
}

export async function loadLocalDraft(
  settings: ConnectionSettings,
  threadId: string,
): Promise<LocalDraft | null> {
  return readValue<LocalDraft>(DRAFT_STORE, scopedKey(connectionCacheKey(settings), threadId));
}

export async function saveLocalDraft(
  settings: ConnectionSettings,
  threadId: string,
  value: UpdateThreadDraftRequest,
  updatedAt = Date.now(),
): Promise<LocalDraft | null> {
  const draft: LocalDraft = {
    key: scopedKey(connectionCacheKey(settings), threadId),
    connectionKey: connectionCacheKey(settings),
    threadId,
    value,
    updatedAt,
  };
  return (await writeValue(DRAFT_STORE, draft)) ? draft : null;
}

export async function deleteLocalDraft(
  settings: ConnectionSettings,
  threadId: string,
): Promise<void> {
  await deleteValue(DRAFT_STORE, scopedKey(connectionCacheKey(settings), threadId));
}

export async function loadNewSessionDraft(
  settings: ConnectionSettings,
  projectId: string,
): Promise<LocalNewSessionDraft | null> {
  return readValue<LocalNewSessionDraft>(
    DRAFT_STORE,
    newSessionDraftKey(connectionCacheKey(settings), projectId),
  );
}

export async function saveNewSessionDraft(
  connectionSettings: ConnectionSettings,
  projectId: string,
  value: UpdateThreadDraftRequest,
  preparation: {
    clientCreationId?: string;
    phase: "creating" | "transferring";
    threadId: string | null;
    thread: ThreadSummary | null;
    revision: number;
    settings?: SessionSettings;
    submission?: NewSessionSubmission;
    voiceSubmission?: NewSessionVoiceSubmission;
    sharedDraftUpdatedAt?: number;
    attachments?: NewSessionAttachment[];
  },
  updatedAt = Date.now(),
): Promise<boolean> {
  const connectionKey = connectionCacheKey(connectionSettings);
  const draft: LocalNewSessionDraft = {
    key: newSessionDraftKey(connectionKey, projectId),
    connectionKey,
    projectId,
    value,
    ...preparation,
    updatedAt,
  };
  return writeValue(DRAFT_STORE, draft);
}

export async function deleteNewSessionDraft(
  settings: ConnectionSettings,
  projectId: string,
): Promise<void> {
  await deleteValue(DRAFT_STORE, newSessionDraftKey(connectionCacheKey(settings), projectId));
}

export async function confirmLocalDraft(
  settings: ConnectionSettings,
  threadId: string,
  confirmed: ThreadDraft | null,
  localUpdatedAt: number,
): Promise<void> {
  const current = await loadLocalDraft(settings, threadId);
  if (!current || current.updatedAt !== localUpdatedAt) return;
  if (
    confirmed &&
    (confirmed.input ||
      confirmed.pasteBlocks?.length ||
      confirmed.images.length ||
      (confirmed.files?.length ?? 0) > 0 ||
      confirmed.goalMode ||
      confirmed.annotations.length)
  ) {
    await saveLocalDraft(
      settings,
      threadId,
      {
        input: confirmed.input,
        ...pastedText(confirmed),
        images: confirmed.images,
        ...(confirmed.files?.length ? { files: confirmed.files } : {}),
        goalMode: confirmed.goalMode,
        annotations: confirmed.annotations,
      },
      confirmed.updatedAt,
    );
    return;
  }
  await deleteValue(DRAFT_STORE, current.key);
}

export function outboxMessageIntent(value: OutboxMessage): string {
  return JSON.stringify([
    value.connectionKey,
    value.threadId,
    value.input,
    value.images,
    value.files ?? [],
    value.goal,
    value.replyToAsyncQuestion,
    value.replyToUserInput,
    value.dismissUserInput,
    pastedText(value),
    value.planImplementationMode,
    value.userInputSubmission,
    value.projectDraft,
    ...(value.draftUpdatedAt !== undefined ? [value.draftUpdatedAt] : []),
  ]);
}

export async function putOutboxMessage(
  message: OutboxMessage,
  source?: MessageDraftSource,
): Promise<boolean> {
  return writeTransaction([OUTBOX_STORE, DRAFT_STORE], (transaction) => {
    const outbox = transaction.objectStore(OUTBOX_STORE);
    const existing = outbox.get(message.id);
    existing.onsuccess = () => {
      const previous = existing.result as OutboxMessage | undefined;
      if (previous && outboxMessageIntent(previous) !== outboxMessageIntent(message))
        transaction.abort();
      else outbox.put(message);
    };
    if (!source) return;
    const drafts = transaction.objectStore(DRAFT_STORE);
    const key = source.projectId
      ? newSessionDraftKey(message.connectionKey, source.projectId)
      : scopedKey(message.connectionKey, message.threadId);
    const request = drafts.get(key);
    request.onsuccess = () => {
      const current = request.result as LocalDraft | LocalNewSessionDraft | undefined;
      if (!current) return;
      if (source.projectId) {
        const preparation = current as LocalNewSessionDraft;
        if (preparation.submission?.id !== message.id) return;
        // The URL can switch to this thread immediately after this transaction. Keep
        // the next composer draft at that URL, even if the HTTP acknowledgement is lost.
        if (preparation.submission.staged) {
          const targetKey = scopedKey(message.connectionKey, message.threadId);
          const target = drafts.get(targetKey);
          target.onsuccess = () => {
            const existing = target.result as LocalDraft | undefined;
            if (existing && existing.updatedAt > preparation.updatedAt) return;
            drafts.put({
              key: targetKey,
              connectionKey: message.connectionKey,
              threadId: message.threadId,
              value: preparation.value,
              updatedAt: Math.max(Date.now(), preparation.updatedAt),
            } satisfies LocalDraft);
          };
        }
        delete preparation.submission;
        drafts.put(preparation);
      } else if (
        JSON.stringify(normalizeDraft(current.value)) ===
        JSON.stringify(normalizeDraft(source.draft))
      ) {
        drafts.delete(key);
      }
    };
  });
}

function normalizeDraft(draft: UpdateThreadDraftRequest) {
  return {
    input: draft.input,
    ...pastedText(draft),
    images: draft.images,
    files: draft.files ?? [],
    annotations: draft.annotations,
    goalMode: draft.goalMode,
  };
}

function cachedUserMessageIds(detail: ThreadDetail): Set<string> {
  return new Set(
    detail.turns.flatMap((turn) =>
      turn.items
        .filter(
          (item) =>
            item.type === "userMessage" &&
            (item.deliveryReceipt?.version === 1 || item.deliveryReceipt?.version === 0) &&
            item.deliveryReceipt.clientId === item.id &&
            item.deliveryReceipt.threadId === detail.summary.id &&
            item.deliveryReceipt.turnId === turn.id,
        )
        .map((item) => item.id),
    ),
  );
}

/** Keep an accepted fallback until the canonical message is safely in the history cache. */
export async function acknowledgeOutboxMessage(message: OutboxMessage): Promise<boolean> {
  return writeTransaction([THREAD_STORE, OUTBOX_STORE], (transaction) => {
    const outbox = transaction.objectStore(OUTBOX_STORE);
    const request = transaction
      .objectStore(THREAD_STORE)
      .get(scopedKey(message.connectionKey, message.threadId));
    request.onsuccess = () => {
      const cached = request.result as CachedThread | undefined;
      if (cached && cachedUserMessageIds(cached.detail).has(message.id)) outbox.delete(message.id);
      else outbox.put({ ...message, accepted: true, lastError: null, retryable: undefined });
    };
  });
}

export async function listOutboxMessages(settings: ConnectionSettings): Promise<OutboxMessage[]> {
  return (await readAll<OutboxMessage>(OUTBOX_STORE))
    .filter((message) => message.connectionKey === connectionCacheKey(settings))
    .sort((left, right) => left.createdAt - right.createdAt);
}

export async function deleteOutboxMessage(id: string): Promise<void> {
  await deleteValue(OUTBOX_STORE, id);
}

export async function listPendingVoiceRecordings(
  settings: ConnectionSettings,
): Promise<PendingVoiceRecording[]> {
  return (await readAll<PendingVoiceRecording>(RECORDING_STORE))
    .filter((recording) => recording.connectionKey === connectionCacheKey(settings))
    .sort((left, right) => left.createdAt - right.createdAt);
}

export async function loadPendingVoiceRecording(id: string): Promise<PendingVoiceRecording | null> {
  return readValue<PendingVoiceRecording>(RECORDING_STORE, id);
}

export async function putPendingVoiceRecording(recording: PendingVoiceRecording): Promise<boolean> {
  return writeValue(RECORDING_STORE, recording);
}

export async function deletePendingVoiceRecording(id: string): Promise<void> {
  await deleteValue(RECORDING_STORE, id);
}

async function cleanupThreadCache(): Promise<void> {
  const now = Date.now();
  if (now - cleanupStartedAt < THREAD_CACHE_CLEANUP_INTERVAL_MS) return;
  cleanupStartedAt = now;
  const cached = await readAll<CachedThread>(THREAD_STORE);
  let total = cached.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= THREAD_CACHE_LIMIT_BYTES) return;
  cached.sort((left, right) => left.accessedAt - right.accessedAt);
  for (const entry of cached) {
    if (total <= THREAD_CACHE_LIMIT_BYTES) break;
    await deleteValue(THREAD_STORE, entry.key);
    total -= entry.bytes;
  }
}

function scopedKey(connectionKey: string, id: string): string {
  return `${connectionKey}\0${id}`;
}

function newSessionDraftKey(connectionKey: string, projectId: string): string {
  return scopedKey(connectionKey, `new-session:${projectId}`);
}

function tokenFingerprint(token: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

async function openDatabase(): Promise<IDBDatabase | null> {
  if (!("indexedDB" in globalThis)) return null;
  return new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      for (const name of [META_STORE, THREAD_STORE, DRAFT_STORE, OUTBOX_STORE, RECORDING_STORE]) {
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name, {
            keyPath: name === OUTBOX_STORE || name === RECORDING_STORE ? "id" : "key",
          });
        }
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => resolve(null));
  }).catch(() => null);
}

async function readValue<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      request.addEventListener("success", () => resolve((request.result as T | undefined) ?? null));
      request.addEventListener("error", () => reject(request.error));
    });
  } catch {
    return null;
  } finally {
    database.close();
  }
}

async function readAll<T>(storeName: string): Promise<T[]> {
  const database = await openDatabase();
  if (!database) return [];
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.addEventListener("success", () => resolve(request.result as T[]));
      request.addEventListener("error", () => reject(request.error));
    });
  } catch {
    return [];
  } finally {
    database.close();
  }
}

async function writeValue(storeName: string, value: object): Promise<boolean> {
  return writeTransaction([storeName], (transaction) => {
    transaction.objectStore(storeName).put(value);
  });
}

async function writeTransaction(
  stores: string[],
  write: (transaction: IDBTransaction) => void,
): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(stores, "readwrite");
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
      try {
        write(transaction);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
    return true;
  } catch {
    // Offline persistence must never make the active UI fail.
    return false;
  } finally {
    database.close();
  }
}

async function deleteValue(storeName: string, key: IDBValidKey): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(key);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } catch {
    // A later write or server sync can repair a failed cache deletion.
  } finally {
    database.close();
  }
}
