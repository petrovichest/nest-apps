import { useCallback, useEffect, useId, useRef, useState, type ClipboardEventHandler } from "react";
import { Link, useParams } from "react-router";
import type {
  KanbanAction,
  KanbanBoard as Board,
  KanbanCard,
  KanbanImageInput,
  KanbanRun,
  KanbanStage,
  Project,
  TranscriptionConfigResponse,
} from "@codexnest/protocol";
import { KANBAN_IMAGE_MAX_BYTES } from "@codexnest/protocol";
import { MessageImageGallery, MessageImageProvider } from "./MessageImageGallery";
import { application } from "../application";
import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { Dialog } from "./Dialog";
import {
  CheckIcon,
  FolderIcon,
  ImageIcon,
  MicrophoneIcon,
  PlusIcon,
  RefreshIcon,
  StopIcon,
  XIcon,
} from "./Icons";
import { WorkspaceHeader } from "./WorkspaceHeader";
import {
  formatRecordingTime,
  insertTranscriptAtSelection,
  microphoneUnavailableReason,
  recordingErrorMessage,
  recordingMimeType,
} from "./speech-input";
import "../kanban.css";

const activeStatuses = new Set<KanbanRun["status"]>(["queued", "preparing", "running", "waiting"]);
const uuid = () => globalThis.crypto.randomUUID();

function runLabel(run: KanbanRun, t: Translate): string {
  if (run.status === "waiting") return t("Ждёт ответа");
  if (run.status === "failed") return t("Ошибка");
  if (run.status === "queued") return t("В очереди");
  if (run.status === "preparing") return t("Подготовка");
  if (run.status === "completed") return t("Завершено");
  return run.kind === "review"
    ? t("Проверяем…")
    : run.kind === "integrate"
      ? t("Объединяем…")
      : t("В работе");
}

function stageLabel(stage: KanbanStage, t: Translate): string {
  // User-created names are content, not translation keys.
  const defaults: Record<string, string> = {
    todo: "К выполнению",
    working: "В работе",
    review: "Проверка",
    ready: "К объединению",
    done: "Готово",
  };
  return stage.role ? t(defaults[stage.role]) : stage.name;
}

export function KanbanBoard({
  projects,
  transcriptionConfig = null,
  onOpenNavigation,
}: {
  projects: Project[];
  transcriptionConfig?: TranscriptionConfigResponse | null;
  onOpenNavigation(): void;
}) {
  const { projectId = "" } = useParams();
  const project = projects.find((item) => item.id === projectId);
  const { api } = useConnection();
  const { t, language } = useI18n();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<"create" | "stage" | "rework" | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState("");
  const alive = useRef(true);
  const requestGeneration = useRef(0);
  const locale = useRef({ language, t });
  locale.current = { language, t };

  const displayError = useCallback((caught: unknown) => {
    const { language: currentLanguage, t: translate } = locale.current;
    const message =
      caught instanceof Error ? caught.message : translate("Не удалось обновить доску");
    return localizeKnownServerText(currentLanguage, message) ?? message;
  }, []);
  const receive = useCallback((next: Board) => {
    if (!alive.current) return;
    setBoard((previous) =>
      previous?.id === next.id && previous.revision > next.revision ? previous : next,
    );
  }, []);

  useEffect(() => {
    alive.current = true;
    const generation = ++requestGeneration.current;
    let inFlight = false;
    setBoard(null);
    setError(null);
    setLoading(true);
    setCardId(null);
    setSelected(new Set());
    setCategory("");
    setBusy(false);
    setDialog(null);
    async function refresh() {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const next = await api.readKanban(projectId);
        if (alive.current && requestGeneration.current === generation) {
          receive(next);
          setError(null);
        }
      } catch (caught) {
        if (alive.current && requestGeneration.current === generation)
          setError(displayError(caught));
      } finally {
        inFlight = false;
        if (alive.current && requestGeneration.current === generation) setLoading(false);
      }
    }
    if (project) void refresh();
    else setLoading(false);
    // Only the visible board refreshes. Session views add no board requests.
    const timer = window.setInterval(() => {
      if (project) void refresh();
    }, 4_000);
    const onVisible = () => {
      if (project) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [api, projectId, project, receive, displayError]);

  async function mutate(operation: () => Promise<Board>): Promise<boolean> {
    if (busy) return false;
    const generation = requestGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const next = await operation();
      if (!alive.current || generation !== requestGeneration.current) return false;
      receive(next);
      return true;
    } catch (caught) {
      if (alive.current && generation === requestGeneration.current) setError(displayError(caught));
      return false;
    } finally {
      if (alive.current && generation === requestGeneration.current) setBusy(false);
    }
  }
  const action = (value: KanbanAction, ids: string[], comment?: string) =>
    mutate(() =>
      api.kanbanAction(projectId, {
        action: value,
        cardIds: ids,
        clientActionId: uuid(),
        ...(comment !== undefined ? { comment } : {}),
      }),
    );
  const move = (id: string, stageId: string) =>
    mutate(() => api.updateKanbanCard(projectId, id, { stageId }));
  const card = board?.cards.find((item) => item.id === cardId) ?? null;
  const readyIds =
    board?.cards
      .filter(
        (item) =>
          selected.has(item.id) &&
          board.stages.find((stage) => stage.id === item.stageId)?.role === "ready",
      )
      .map((item) => item.id) ?? [];
  const cardRuns = card
    ? board!.runs
        .filter((run) => run.cardIds.includes(card.id) && run.kind !== "classify")
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
  const cardActive = cardRuns.some((run) => activeStatuses.has(run.status));
  const role = board?.stages.find((stage) => stage.id === card?.stageId)?.role;

  return (
    <section className="kanban-page">
      <WorkspaceHeader
        title={t("Доска задач")}
        subtitle={project?.displayName ?? t("Проект не найден")}
        leadingIcon={<FolderIcon />}
        onOpenNavigation={onOpenNavigation}
        actions={
          project ? (
            <button
              className="icon-button"
              aria-label={t("Добавить задачу")}
              onClick={() => setDialog("create")}
            >
              <PlusIcon />
            </button>
          ) : undefined
        }
      />
      {!project ? (
        <div className="center-state">
          <p>{t("Проект не найден")}</p>
        </div>
      ) : (
        <>
          <div className="kanban-toolbar">
            <label className="kanban-category-filter">
              <span className="sr-only">{t("Категория")}</span>
              <select
                aria-label={t("Категория")}
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">{t("Все категории")}</option>
                {board?.categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => setDialog("stage")} disabled={!board || busy}>
              <PlusIcon />
              {t("Добавить стадию")}
            </button>
            <span className="kanban-toolbar-spacer" />
            {readyIds.length > 0 && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void action("integrate", readyIds).then((ok) => {
                    if (ok) setSelected(new Set());
                  })
                }
              >
                {t("Объединить выбранные ({{count}})", { count: readyIds.length })}
              </button>
            )}
            <button className="primary kanban-add-button" onClick={() => setDialog("create")}>
              <PlusIcon />
              {t("Добавить задачу")}
            </button>
          </div>
          {error && (
            <div className="kanban-error" role="alert">
              <span>{error}</span>
              <button disabled={busy} onClick={() => void mutate(() => api.readKanban(projectId))}>
                <RefreshIcon />
                {t("Повторить")}
              </button>
            </div>
          )}
          {loading && !board ? (
            <div className="center-state">
              <span className="spinner" />
              <p className="working-text">{t("Загружаем доску…")}</p>
            </div>
          ) : (
            board && (
              <>
                {board.cards.length === 0 && (
                  <p className="kanban-empty">
                    {t("Добавьте задачу текстом или голосом. Агент сам назначит категорию.")}
                  </p>
                )}
                <div className="kanban-columns" aria-label={t("Стадии задач")}>
                  {board.stages.map((stage) => {
                    const cards = board.cards.filter(
                      (item) =>
                        item.stageId === stage.id && (!category || item.categoryId === category),
                    );
                    return (
                      <section
                        key={stage.id}
                        className="kanban-column"
                        aria-label={stageLabel(stage, t)}
                        onDragOver={(event) => {
                          if (
                            !busy &&
                            event.dataTransfer.types.includes("application/x-nest-kanban-card")
                          )
                            event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const id = event.dataTransfer.getData("application/x-nest-kanban-card");
                          if (!busy && board.cards.some((item) => item.id === id))
                            void move(id, stage.id);
                        }}
                      >
                        <header className="kanban-column-header">
                          <h2>{stageLabel(stage, t)}</h2>
                          <span>{cards.length}</span>
                        </header>
                        {stage.description && (
                          <p className="kanban-stage-description">{stage.description}</p>
                        )}
                        <div className="kanban-column-cards">
                          {cards.map((item) => {
                            const latest = board.runs
                              .filter(
                                (run) => run.cardIds.includes(item.id) && run.kind !== "classify",
                              )
                              .sort((a, b) => b.createdAt - a.createdAt)[0];
                            const categoryName = board.categories.find(
                              (value) => value.id === item.categoryId,
                            )?.name;
                            return (
                              <article
                                key={item.id}
                                className={`kanban-card${item.error ? " has-error" : ""}`}
                                draggable={!busy}
                                onDragStart={(event) => {
                                  event.dataTransfer.setData(
                                    "application/x-nest-kanban-card",
                                    item.id,
                                  );
                                  event.dataTransfer.effectAllowed = "move";
                                }}
                              >
                                <div className="kanban-card-top">
                                  {stage.role === "ready" && (
                                    <input
                                      type="checkbox"
                                      aria-label={t("Выбрать задачу {{title}}", {
                                        title: item.title,
                                      })}
                                      checked={selected.has(item.id)}
                                      onChange={(event) =>
                                        setSelected((current) => {
                                          const next = new Set(current);
                                          if (event.target.checked) next.add(item.id);
                                          else next.delete(item.id);
                                          return next;
                                        })
                                      }
                                    />
                                  )}
                                  <button
                                    className="kanban-card-title"
                                    onClick={() => setCardId(item.id)}
                                  >
                                    {item.title}
                                  </button>
                                </div>
                                {item.description !== item.title && (
                                  <p className="kanban-card-excerpt">{item.description}</p>
                                )}
                                <div className="kanban-card-meta">
                                  {categoryName && (
                                    <span className="kanban-category">{categoryName}</span>
                                  )}
                                  {item.classification === "pending" && (
                                    <span className="working-text">
                                      {t("Определяем категорию…")}
                                    </span>
                                  )}
                                  {item.classification === "failed" && (
                                    <span className="kanban-status is-error">
                                      {t("Категория не определена")}
                                    </span>
                                  )}
                                  {latest && (
                                    <span className={`kanban-status ${latest.status}`}>
                                      <span aria-hidden="true" />
                                      {runLabel(latest, t)}
                                    </span>
                                  )}
                                </div>
                                <RepositoryStatus card={item} compact />
                                {item.error && <p className="kanban-card-error">{item.error}</p>}
                              </article>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              </>
            )
          )}
        </>
      )}
      {dialog === "create" && (
        <TextDialog
          error={error}
          title={t("Добавить задачу")}
          allowImage
          label={t("Задача")}
          submitLabel={t("Отправить")}
          transcriptionConfig={transcriptionConfig}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={async (description, id, image) => {
            if (
              await mutate(() =>
                api.createKanbanCard(projectId, {
                  description,
                  clientCreationId: id,
                  ...(image ? { image } : {}),
                }),
              )
            )
              setDialog(null);
          }}
        />
      )}
      {dialog === "rework" && card && (
        <TextDialog
          error={error}
          title={t("На доработку")}
          label={t("Комментарий")}
          submitLabel={t("Отправить на доработку")}
          transcriptionConfig={transcriptionConfig}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={async (comment) => {
            if (await action("rework", [card.id], comment)) setDialog(null);
          }}
        />
      )}
      {dialog === "stage" && (
        <StageDialog
          error={error}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={async (name, description) => {
            if (await mutate(() => api.createKanbanStage(projectId, { name, description })))
              setDialog(null);
          }}
        />
      )}
      {card && board && dialog !== "rework" && (
        <Dialog
          titleId="kanban-card-title"
          className="kanban-detail-dialog"
          closeOnBackdrop={!busy}
          closeOnEscape={!busy}
          onClose={() => setCardId(null)}
        >
          <div className="dialog-header">
            <h2 id="kanban-card-title">{card.title}</h2>
            <button
              className="icon-button"
              aria-label={t("Закрыть")}
              onClick={() => setCardId(null)}
              disabled={busy}
            >
              <XIcon />
            </button>
          </div>
          <p className="kanban-detail-description">{card.description}</p>
          {card.image && (
            <CardImage key={`${projectId}:${card.id}`} projectId={projectId} cardId={card.id} />
          )}
          <div className="kanban-detail-fields">
            <label>
              {t("Стадия")}
              <select
                disabled={busy}
                value={card.stageId}
                onChange={(event) => void move(card.id, event.target.value)}
              >
                {board.stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stageLabel(stage, t)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("Категория")}
              <select
                disabled={busy}
                value={card.categoryId ?? ""}
                onChange={(event) =>
                  void mutate(() =>
                    api.updateKanbanCard(projectId, card.id, {
                      categoryId: event.target.value || null,
                    }),
                  )
                }
              >
                <option value="">{t("Без категории")}</option>
                {board.categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <RepositoryStatus card={card} />
          {card.error && (
            <p className="kanban-card-error" role="alert">
              {card.error}
            </p>
          )}
          {error && (
            <p className="kanban-card-error" role="alert">
              {error}
            </p>
          )}
          <div className="kanban-detail-actions">
            {card.classification === "failed" && (
              <button
                disabled={busy}
                onClick={() => void action("retry-classification", [card.id])}
              >
                {t("Повторить категоризацию")}
              </button>
            )}
            {card.classification === "ready" &&
              !cardActive &&
              role !== "done" &&
              role !== "ready" &&
              role !== "review" && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void action("execute", [card.id])}
                >
                  {t("Отправить агенту")}
                </button>
              )}
            {(role === "review" || role === "ready") && (
              <>
                {role === "review" && (
                  <button
                    disabled={busy || cardActive}
                    onClick={() => void action("accept", [card.id])}
                  >
                    <CheckIcon />
                    {t("Принять")}
                  </button>
                )}
                <button
                  disabled={busy || cardActive}
                  onClick={() => void action("review", [card.id])}
                >
                  {t("Проверить агентом")}
                </button>
                <button disabled={busy || cardActive} onClick={() => setDialog("rework")}>
                  {t("На доработку")}
                </button>
              </>
            )}
          </div>
          {cardRuns.length > 0 && (
            <div className="kanban-session-list">
              <h3>{t("Сессии задачи")}</h3>
              {cardRuns.map((run) => (
                <div className="kanban-session" key={run.id}>
                  <div>
                    <span className={`kanban-status ${run.status}`}>{runLabel(run, t)}</span>
                    <span>
                      {run.provider === "claude" ? "ClaudeNest" : "CodexNest"} ·{" "}
                      {run.kind === "review"
                        ? t("Проверка")
                        : run.kind === "integrate"
                          ? t("Объединение")
                          : t("Выполнение")}
                    </span>
                  </div>
                  {run.threadId && run.provider === application.provider ? (
                    <Link to={`/threads/${encodeURIComponent(run.threadId)}`}>
                      {t("Открыть сессию")}
                    </Link>
                  ) : run.sessionUrl ? (
                    <a href={run.sessionUrl}>{t("Открыть сессию")}</a>
                  ) : (
                    <span className="kanban-muted">{t("Ожидает запуска приложения")}</span>
                  )}
                  {run.error && <p className="kanban-card-error">{run.error}</p>}
                </div>
              ))}
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
}

function CardImage({ projectId, cardId }: { projectId: string; cardId: string }) {
  const { api } = useConnection();
  const { t } = useI18n();
  const [image, setImage] = useState<KanbanImageInput | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void api.readKanbanImage(projectId, cardId).then(
      (value) => {
        if (active) setImage(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api, projectId, cardId, attempt]);
  if (failed)
    return (
      <button onClick={() => setAttempt((value) => value + 1)}>
        {t("Не удалось загрузить изображение. Повторить")}
      </button>
    );
  if (!image) return <p role="status">{t("Загружаем изображение…")}</p>;
  return (
    <MessageImageProvider text="" images={[image.url]}>
      <MessageImageGallery />
      <p className="kanban-muted">{image.name}</p>
    </MessageImageProvider>
  );
}

function RepositoryStatus({ card, compact = false }: { card: KanbanCard; compact?: boolean }) {
  const { t } = useI18n();
  if (!card.repositories?.length) return null;
  const published = card.repositories.filter((repo) => repo.status === "published").length;
  const status = (value: string) =>
    value === "published"
      ? t("Отправлено")
      : value === "integrated"
        ? t("Объединено локально")
        : value === "integrating"
          ? t("Объединяется")
          : value === "accepted"
            ? t("К объединению")
            : value === "failed"
              ? t("Ошибка")
              : t("В работе");
  return (
    <div className={`kanban-repositories${compact ? " compact" : ""}`}>
      {card.repositories.length > 1 && published > 0 && published < card.repositories.length && (
        <p className="kanban-muted">
          {t("Отправлено {{done}} из {{total}}", {
            done: published,
            total: card.repositories.length,
          })}
        </p>
      )}
      {card.repositories.map((repo) => (
        <div key={repo.id}>
          <span title={repo.path}>{repo.path.split(/[\\/]/).filter(Boolean).at(-1)}</span>
          <code title={repo.targetBranch}>{repo.targetBranch}</code>
          {!compact && <span>{status(repo.status)}</span>}
          {!compact && repo.error && <p className="kanban-card-error">{repo.error}</p>}
        </div>
      ))}
    </div>
  );
}

function StageDialog({
  busy,
  error,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onClose(): void;
  onSubmit(name: string, description: string): Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const id = useId();
  return (
    <Dialog
      titleId={id}
      className="kanban-text-dialog"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void onSubmit(name.trim(), description.trim());
        }}
      >
        <div className="dialog-header">
          <h2 id={id}>{t("Добавить стадию")}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t("Закрыть")}
            disabled={busy}
            onClick={onClose}
          >
            <XIcon />
          </button>
        </div>
        <label className="kanban-field">
          {t("Название")}
          <input
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            required
          />
        </label>
        <label className="kanban-field">
          {t("Описание (необязательно)")}
          <textarea
            rows={3}
            value={description}
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {error && (
          <p className="kanban-card-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            {t("Отмена")}
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? t("Сохраняем…") : t("Добавить")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TextDialog({
  title,
  label,
  submitLabel,
  busy,
  error,
  transcriptionConfig,
  allowImage = false,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  transcriptionConfig: TranscriptionConfigResponse | null;
  onClose(): void;
  allowImage?: boolean;
  onSubmit(value: string, id: string, image?: KanbanImageInput): Promise<void>;
}) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const id = useId();
  const creationId = useRef(uuid());
  const [image, setImage] = useState<KanbanImageInput>();
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const reader = useRef<FileReader | null>(null);
  const locked = busy || voiceBusy || imageBusy;
  useEffect(
    () => () => {
      reader.current?.abort();
    },
    [],
  );
  function attachImage(file: File) {
    if (locked) return;
    setImageError(null);
    if (
      !/^image\/(png|jpeg|gif|webp)$/.test(file.type) ||
      !file.size ||
      file.size > KANBAN_IMAGE_MAX_BYTES
    ) {
      setImageError(t("Выберите изображение PNG, JPEG, GIF или WebP до 10 МБ"));
      return;
    }
    const next = new FileReader();
    reader.current = next;
    setImageBusy(true);
    next.onload = () => {
      if (typeof next.result === "string") {
        setImage({ name: file.name || "image", url: next.result });
        creationId.current = uuid();
      } else setImageError(t("Не удалось прочитать изображение"));
      setImageBusy(false);
    };
    next.onerror = () => {
      setImageError(t("Не удалось прочитать изображение"));
      setImageBusy(false);
    };
    next.readAsDataURL(file);
  }
  return (
    <Dialog
      titleId={id}
      className="kanban-text-dialog"
      closeOnBackdrop={!locked}
      closeOnEscape={!locked}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked && input.trim()) void onSubmit(input.trim(), creationId.current, image);
        }}
      >
        <div className="dialog-header">
          <h2 id={id}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t("Закрыть")}
            disabled={locked}
            onClick={onClose}
          >
            <XIcon />
          </button>
        </div>
        <VoiceTextField
          label={label}
          value={input}
          onChange={(value) => {
            setInput(value);
            creationId.current = uuid();
          }}
          disabled={busy || imageBusy}
          onPaste={
            allowImage
              ? (event) => {
                  const item = Array.from(event.clipboardData.items).find((item) =>
                    item.type.startsWith("image/"),
                  );
                  const file = item?.getAsFile();
                  if (file) {
                    event.preventDefault();
                    attachImage(file);
                  }
                }
              : undefined
          }
          config={transcriptionConfig}
          onBusyChange={setVoiceBusy}
        />
        {allowImage && (
          <div className="kanban-image-field">
            <input
              ref={imageInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              aria-label={t("Прикрепить изображение")}
              hidden
              disabled={locked}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) attachImage(file);
              }}
            />
            <button type="button" disabled={locked} onClick={() => imageInput.current?.click()}>
              <ImageIcon />
              {imageBusy ? t("Загружаем изображение…") : t("Прикрепить изображение")}
            </button>
            {image && (
              <div className="kanban-image-preview">
                <img src={image.url} alt={image.name} />
                <span>{image.name}</span>
                <button
                  type="button"
                  className="icon-button"
                  disabled={locked}
                  aria-label={t("Удалить изображение {{name}}", { name: image.name })}
                  onClick={() => {
                    setImage(undefined);
                    setImageError(null);
                    creationId.current = uuid();
                  }}
                >
                  <XIcon />
                </button>
              </div>
            )}
            {imageError && (
              <p className="kanban-card-error" role="alert">
                {imageError}
              </p>
            )}
          </div>
        )}
        {error && (
          <p className="kanban-card-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={locked} onClick={onClose}>
            {t("Отмена")}
          </button>
          <button className="primary" disabled={locked || !input.trim()}>
            {busy ? t("Отправляем…") : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Uses the Composer's MIME selection, limits, cursor insertion and transcription API. */
function VoiceTextField({
  label,
  value,
  onChange,
  disabled,
  config,
  onBusyChange,
  onPaste,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  config: TranscriptionConfigResponse | null;
  onBusyChange(value: boolean): void;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
}) {
  const { api } = useConnection();
  const { t, language } = useI18n();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ value, onChange, onBusyChange, t, language });
  latest.current = { value, onChange, onBusyChange, t, language };
  const alive = useRef(true);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const selection = useRef({ start: 0, end: 0 });
  const recordingSelection = useRef({ start: 0, end: 0 });
  const discarded = useRef(false);
  const [speech, setSpeech] = useState<"idle" | "requesting" | "recording" | "transcribing">(
    "idle",
  );
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<{
    audio: Blob;
    duration: number;
    selection: { start: number; end: number };
  } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const limit = useRef<number | undefined>(undefined);
  const unavailable = microphoneUnavailableReason(config, config?.provider ?? null, true, t);

  function clearTimers() {
    window.clearInterval(timer.current);
    window.clearTimeout(limit.current);
  }
  function release() {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      discarded.current = true;
      clearTimers();
      if (recorder.current?.state === "recording") recorder.current.stop();
      release();
      latest.current.onBusyChange(false);
    };
  }, []);
  function state(next: typeof speech) {
    if (alive.current) {
      setSpeech(next);
      latest.current.onBusyChange(next !== "idle");
    }
  }
  async function transcribe(audio: Blob, duration: number, insertion = recordingSelection.current) {
    state("transcribing");
    setError(null);
    setSeconds(0);
    const started = Date.now();
    timer.current = window.setInterval(() => {
      if (alive.current) setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 250);
    try {
      const response = await api.transcribe(audio, duration);
      if (!alive.current || discarded.current) return;
      const inserted = insertTranscriptAtSelection(
        latest.current.value,
        response.text,
        insertion,
        100_000,
      );
      if (!inserted) throw new Error(latest.current.t("Распознавание не вернуло текст"));
      latest.current.onChange(inserted.value);
      setRetry(null);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(inserted.caret, inserted.caret);
      });
    } catch (caught) {
      if (!alive.current) return;
      const message =
        caught instanceof Error ? caught.message : latest.current.t("Не удалось распознать запись");
      setError(localizeKnownServerText(latest.current.language, message) ?? message);
      setRetry({ audio, duration, selection: insertion });
    } finally {
      clearTimers();
      state("idle");
    }
  }
  async function start() {
    if (disabled || speech !== "idle" || unavailable) return;
    discarded.current = false;
    recordingSelection.current = { ...selection.current };
    setError(null);
    state("requesting");
    try {
      const capture = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current || discarded.current) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = capture;
      const mimeType = recordingMimeType()!;
      const media = new MediaRecorder(capture, { mimeType });
      recorder.current = media;
      const chunks: Blob[] = [];
      let bytes = 0;
      const started = Date.now();
      media.addEventListener("dataavailable", (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          bytes += event.data.size;
          if (bytes >= (config?.maxUploadBytes ?? 24 * 1024 * 1024) && media.state === "recording")
            media.stop();
        }
      });
      media.addEventListener("error", () => {
        discarded.current = true;
        release();
        clearTimers();
        if (alive.current) setError(latest.current.t("Не удалось записать аудио"));
        state("idle");
      });
      media.addEventListener("stop", () => {
        clearTimers();
        release();
        recorder.current = null;
        if (!alive.current || discarded.current) {
          state("idle");
          return;
        }
        const audio = new Blob(chunks, { type: mimeType });
        if (!audio.size) {
          setError(latest.current.t("Не удалось записать аудио"));
          state("idle");
          return;
        }
        void transcribe(audio, Math.max(1, Date.now() - started));
      });
      media.start(1000);
      setSeconds(0);
      state("recording");
      timer.current = window.setInterval(() => {
        if (alive.current) setSeconds(Math.floor((Date.now() - started) / 1000));
      }, 250);
      limit.current = window.setTimeout(
        () => {
          if (media.state === "recording") media.stop();
        },
        (config?.maxRecordingSeconds ?? 300) * 1000,
      );
    } catch (caught) {
      release();
      if (alive.current) setError(recordingErrorMessage(caught, t));
      state("idle");
    }
  }
  return (
    <div className="kanban-voice-field">
      <label className="kanban-field" htmlFor={id}>
        {label}
        <textarea
          id={id}
          ref={textarea}
          onPaste={onPaste}
          value={value}
          onChange={(event) => {
            selection.current = {
              start: event.target.selectionStart,
              end: event.target.selectionEnd,
            };
            onChange(event.target.value);
          }}
          onSelect={(event) => {
            selection.current = {
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            };
          }}
          disabled={disabled}
          rows={7}
          maxLength={100_000}
          autoFocus
        />
      </label>
      <div className="kanban-voice-controls">
        <span role="status" className="kanban-muted">
          {speech === "recording"
            ? t("Запись {{time}}", { time: formatRecordingTime(seconds) })
            : speech === "transcribing"
              ? t("Распознаём запись")
              : speech === "requesting"
                ? t("Запрашиваем доступ к микрофону")
                : ""}
        </span>
        {speech === "recording" && (
          <button
            type="button"
            className="icon-button"
            aria-label={t("Отменить запись")}
            onClick={() => {
              discarded.current = true;
              recorder.current?.stop();
            }}
          >
            <XIcon />
          </button>
        )}
        {retry && speech === "idle" && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              discarded.current = false;
              void transcribe(retry.audio, retry.duration, retry.selection);
            }}
          >
            {t("Повторить распознавание")}
          </button>
        )}
        <button
          type="button"
          className={`composer-action microphone${speech === "recording" ? " recording timing" : ""}`}
          title={unavailable ?? undefined}
          aria-label={
            speech === "recording"
              ? t("Остановить запись")
              : speech === "transcribing"
                ? t("Распознаём запись")
                : (unavailable ?? t("Начать запись"))
          }
          aria-pressed={speech === "recording"}
          disabled={
            disabled ||
            speech === "requesting" ||
            speech === "transcribing" ||
            (speech === "idle" && !!unavailable)
          }
          onPointerDown={() => {
            if (speech === "idle")
              selection.current = {
                start: textarea.current?.selectionStart ?? value.length,
                end: textarea.current?.selectionEnd ?? value.length,
              };
          }}
          onClick={() => {
            if (speech === "recording") recorder.current?.stop();
            else {
              if (textarea.current && document.activeElement === textarea.current)
                selection.current = {
                  start: textarea.current.selectionStart,
                  end: textarea.current.selectionEnd,
                };
              else if (selection.current.start > value.length)
                selection.current = { start: value.length, end: value.length };
              void start();
            }
          }}
        >
          {speech === "recording" ? (
            <>
              <span className="composer-action-timer">{seconds}</span>
              <StopIcon />
            </>
          ) : speech === "requesting" || speech === "transcribing" ? (
            <span className="spinner small" />
          ) : (
            <MicrophoneIcon />
          )}
        </button>
      </div>
      {error && (
        <p className="kanban-card-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
