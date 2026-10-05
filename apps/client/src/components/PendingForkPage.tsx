import { onBeforeAppReload } from "../app-reload";
import {
  pastedText,
  trimPastedMessage,
  rebasePastedText,
  type PastedText,
} from "@codexnest/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";

import type { ThreadDraft, UpdateThreadDraftRequest } from "@codexnest/protocol";

import { useConnection } from "../connection";
import {
  forkOperationsFromSnapshot,
  type ForkOperationDetail,
  type ForkOperationSummary,
} from "../forks";
import { localizeKnownServerText, useI18n } from "../i18n";
import { Composer, type ComposerImage } from "./Composer";
import { GitBranchIcon } from "./Icons";
import { Activity, QueuedMessages, type QueueAction, type QueuedMessageView } from "./ThreadPage";
import { WorkspaceHeader } from "./WorkspaceHeader";

const EMPTY_DRAFT: UpdateThreadDraftRequest = {
  input: "",
  images: [],
  files: [],
  goalMode: false,
  annotations: [],
};

export function PendingForkPage({
  operationId,
  onOpenNavigation,
}: {
  operationId: string;
  onOpenNavigation(): void;
}) {
  const { api, state, dispatch, refreshDetail } = useConnection();
  const { language, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const stateOperation = (location.state as { forkOperation?: ForkOperationSummary } | null)
    ?.forkOperation;
  const snapshotOperation = forkOperationsFromSnapshot(state.snapshot).find(
    (candidate) => candidate.id === operationId,
  );
  const [loaded, setLoaded] = useState<ForkOperationDetail | null>(null);
  const operation = snapshotOperation ?? loaded?.operation ?? stateOperation ?? null;
  const sourceId = operation?.sourceThreadId ?? stateOperation?.sourceThreadId ?? "";
  const sourceDetail = state.details[sourceId];
  const sourceSummary =
    sourceDetail?.summary ?? state.snapshot?.threads.find((thread) => thread.id === sourceId);
  const [draft, setDraft] = useState<UpdateThreadDraftRequest>(EMPTY_DRAFT);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftHydratedRef = useRef(false);
  const draftTimerRef = useRef<number | null>(null);
  const draftChainRef = useRef<Promise<void>>(Promise.resolve());
  const [queue, setQueue] = useState<QueuedMessageView[]>([]);
  const [queueAction, setQueueAction] = useState<QueueAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const submittingRef = useRef(false);
  const redirectingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .readForkOperation(operationId)
      .then((detail) => {
        if (!active) return;
        setLoaded(detail);
        dispatch({ type: "forkOperation", operation: detail.operation });
        setQueue(detail.queuedMessages.map((message) => ({ ...message, confirmed: true })));
        if (!draftHydratedRef.current) {
          draftHydratedRef.current = true;
          setDraft(draftValue(detail.draft));
        }
      })
      .catch((caught) => {
        if (!active) return;
        setError(
          caught instanceof Error
            ? (localizeKnownServerText(language, caught.message) ?? caught.message)
            : t("Не удалось загрузить создаваемое ответвление"),
        );
      });
    return () => {
      active = false;
    };
  }, [api, dispatch, language, operationId, t]);

  useEffect(() => {
    if (!sourceId || sourceDetail) return;
    void refreshDetail(sourceId).catch((caught) => {
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось загрузить исходную историю"),
      );
    });
  }, [language, refreshDetail, sourceDetail, sourceId, t]);

  useEffect(() => {
    if (operation?.status !== "ready" || !operation.targetThreadId || redirectingRef.current)
      return;
    redirectingRef.current = true;
    const textarea = document.querySelector<HTMLTextAreaElement>(
      ".pending-fork-workspace .composer textarea",
    );
    const selection = textarea
      ? { start: textarea.selectionStart, end: textarea.selectionEnd }
      : null;
    void flushDraft(true).finally(() => {
      navigate(`/threads/${encodeURIComponent(operation.targetThreadId!)}`, {
        replace: true,
        state: { focusComposer: true, restoreComposerSelection: selection },
      });
    });
  }, [navigate, operation?.status, operation?.targetThreadId]);

  useEffect(
    () => () => {
      if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
      if (draftHydratedRef.current) void persistDraft(draftRef.current, true);
    },
    [],
  );

  const turns = useMemo(() => {
    if (!sourceDetail || !operation) return [];
    const index = sourceDetail.turns.findIndex((turn) => turn.id === operation.lastTurnId);
    return index < 0 ? sourceDetail.turns : sourceDetail.turns.slice(0, index + 1);
  }, [operation, sourceDetail]);

  if (!operation && state.snapshot && !stateOperation && !error) {
    return <Navigate to="/" replace />;
  }

  function scheduleDraft(next: UpdateThreadDraftRequest, immediate = false) {
    setDraft(next);
    if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
    if (immediate) {
      void persistDraft(next);
      return;
    }
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      void persistDraft(draftRef.current);
    }, 500);
  }

  function persistDraft(value: UpdateThreadDraftRequest, keepalive = false): Promise<void> {
    const request = draftChainRef.current
      .catch(() => undefined)
      .then(async () => {
        await api.updateForkOperationDraft(operationId, value, { keepalive });
      })
      .catch(() => undefined);
    draftChainRef.current = request;
    return request;
  }

  function flushDraft(keepalive = false): Promise<void> {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    return persistDraft(draftRef.current, keepalive);
  }

  useEffect(() => onBeforeAppReload(() => flushDraft()));

  async function submit() {
    const current = structuredClone(draftRef.current);
    if (
      (!current.input.trim() && !current.images.length && !current.pasteBlocks?.length) ||
      submittingRef.current
    )
      return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    const id = createMessageId();
    const optimistic: QueuedMessageView = {
      id,
      threadId: operationId,
      text: current.input.trim(),
      ...pastedText(trimPastedMessage(current.input, current)),
      ...(current.images.length ? { images: current.images.map((image) => image.url) } : {}),
      createdAt: Date.now(),
      status: "queued",
      confirmed: false,
    };
    setQueue((messages) => [...messages, optimistic]);
    scheduleDraft(EMPTY_DRAFT, true);
    try {
      const accepted = await api.enqueueForkOperation(operationId, {
        input: current.input,
        ...pastedText(current),
        ...(current.images.length ? { images: current.images.map((image) => image.url) } : {}),
        clientMessageId: id,
      });
      setQueue((messages) =>
        messages.map((message) => (message.id === id ? { ...accepted, confirmed: true } : message)),
      );
    } catch (caught) {
      setQueue((messages) => messages.filter((message) => message.id !== id));
      scheduleDraft(current, true);
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось добавить сообщение в очередь"),
      );
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  async function updateQueued(
    messageId: string,
    input: string,
    pastes?: PastedText,
  ): Promise<boolean> {
    setQueueAction({ messageId, kind: "update" });
    try {
      const updated = await api.updateForkOperationQueued(operationId, messageId, {
        input,
        ...pastes,
      });
      setQueue((messages) =>
        messages.map((message) =>
          message.id === messageId ? { ...updated, confirmed: true } : message,
        ),
      );
      return true;
    } catch {
      setError(t("Не удалось изменить сообщение в очереди"));
      return false;
    } finally {
      setQueueAction(null);
    }
  }

  async function deleteQueued(messageId: string): Promise<boolean> {
    setQueueAction({ messageId, kind: "delete" });
    try {
      await api.deleteForkOperationQueued(operationId, messageId);
      setQueue((messages) => messages.filter((message) => message.id !== messageId));
      return true;
    } catch {
      setError(t("Не удалось удалить сообщение из очереди"));
      return false;
    } finally {
      setQueueAction(null);
    }
  }

  async function retryFork() {
    if (!operation || operation.status !== "failed" || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const result = await api.createForkOperation(operation.sourceThreadId, {
        operationId: operation.id,
        lastTurnId: operation.lastTurnId,
        agentMessageId: operation.agentMessageId,
        mode: operation.mode,
      });
      setLoaded((current) => ({
        operation: result.operation,
        queuedMessages: current?.queuedMessages ?? [],
        draft: current?.draft ?? null,
      }));
      dispatch({ type: "forkOperation", operation: result.operation });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось создать ответвление"),
      );
    } finally {
      setRetrying(false);
    }
  }

  const sourceTitle = sourceSummary
    ? (localizeKnownServerText(language, sourceSummary.title) ?? sourceSummary.title)
    : t("Исходная ветка");
  const title = operation?.title.trim() || t("Ответвление от {{title}}", { title: sourceTitle });

  return (
    <div className="thread-workspace pending-fork-workspace">
      <div className="conversation-pane">
        <WorkspaceHeader
          title={title}
          subtitle={
            <span className="workspace-context">
              {t("Ответвление от {{title}}", { title: sourceTitle })}
            </span>
          }
          onOpenNavigation={onOpenNavigation}
        />
        {operation && (
          <ForkStatusBanner
            operation={operation}
            retrying={retrying}
            onRetry={() => void retryFork()}
          />
        )}
        <div className="conversation-scroll">
          <section className="timeline" aria-live="polite">
            {!sourceDetail && !error && (
              <div className="center-state compact">
                <div className="spinner" />
              </div>
            )}
            {turns.map((turn) => (
              <div className="turn" key={turn.id}>
                {turn.items.map((item) => (
                  <Activity item={item} cwd={sourceSummary?.cwd} key={item.id} />
                ))}
              </div>
            ))}
          </section>
        </div>
        {sourceSummary && (
          <Composer
            autoFocus={
              (location.state as { focusComposer?: unknown } | null)?.focusComposer === true
            }
            sessionIdentity={`fork-operation:${operationId}`}
            input={draft.input}
            pastes={draft}
            onInput={(input, pastes) => {
              const next =
                pastes ?? rebasePastedText(draftRef.current.input, input, draftRef.current);
              scheduleDraft({
                ...draftRef.current,
                input,
                inlinePastes: next.inlinePastes,
                pasteBlocks: next.pasteBlocks,
              });
            }}
            onDraftFlush={() => void flushDraft()}
            images={draft.images as ComposerImage[]}
            onImagesChange={(images) => scheduleDraft({ ...draftRef.current, images }, true)}
            onSubmit={() => void submit()}
            busy={busy || operation?.status === "failed"}
            running
            settings={sourceSummary.settings}
            onSettingsChange={() => undefined}
            settingsDisabled
            models={state.snapshot?.models ?? []}
            transcriptionConfig={null}
            transcriptionProvider={null}
            error={error}
          >
            <QueuedMessages
              cwd={sourceSummary.cwd}
              messages={queue}
              action={queueAction}
              canSendNow={false}
              onSendNow={async () => false}
              onUpdate={updateQueued}
              onDelete={deleteQueued}
            />
          </Composer>
        )}
      </div>
    </div>
  );
}

function ForkStatusBanner({
  operation,
  retrying,
  onRetry,
}: {
  operation: ForkOperationSummary;
  retrying: boolean;
  onRetry(): void;
}) {
  const { t } = useI18n();
  const copy =
    operation.status === "failed"
      ? operation.error || t("Не удалось создать ответвление.")
      : operation.status === "ready"
        ? t("Ответвление готово. Открываем…")
        : forkStageCopy(operation, t);
  return (
    <div
      className={`fork-status-banner ${operation.status}`}
      role={operation.status === "failed" ? "alert" : "status"}
    >
      {operation.status === "ready" ? (
        <GitBranchIcon />
      ) : operation.status === "failed" ? (
        <span aria-hidden="true">!</span>
      ) : (
        <span className="spinner small" />
      )}
      <span className="fork-status-copy">
        <strong>{forkStatusTitle(operation, t)}</strong>
        <small>{copy}</small>
      </span>
      {operation.status === "failed" && (
        <button type="button" disabled={retrying} onClick={onRetry}>
          {t("Повторить")}
        </button>
      )}
    </div>
  );
}

function forkStatusTitle(
  operation: ForkOperationSummary,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (operation.status === "ready") return t("Ветка готова");
  if (operation.status === "failed") return t("Создание остановлено");
  if (operation.stage === "copying") return t("Копируем историю");
  if (operation.stage === "compacting") return t("Сжимаем контекст");
  if (operation.stage === "materializing") return t("Собираем ветку");
  return t("Готовим ветку");
}

function forkStageCopy(
  operation: ForkOperationSummary,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (operation.stage === "copying") {
    return t("Переносим полную историю до выбранного ответа.");
  }
  if (operation.stage === "compacting") {
    return t("Создаём свежее сжатие во временной копии. Исходная сессия не меняется.");
  }
  if (operation.stage === "materializing") {
    return t("Переносим только новый компактный контекст в чистую ветку.");
  }
  return t("Проверяем точку ответвления. Можно писать дальше — сообщения встанут в очередь.");
}

function draftValue(draft: ThreadDraft | null): UpdateThreadDraftRequest {
  return draft
    ? {
        input: draft.input,
        ...pastedText(draft),
        images: draft.images,
        files: draft.files ?? [],
        goalMode: draft.goalMode,
        annotations: draft.annotations,
      }
    : EMPTY_DRAFT;
}

function createMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
