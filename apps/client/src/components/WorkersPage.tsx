import {
  WORKER_ARCHITECT_ID,
  type ModelOption,
  type Project,
  type SessionSettings,
  type WorkerCatalogue,
  type WorkerDetails,
  type WorkerMemoryEntry,
  type WorkerProfile,
  type WorkerProposal,
} from "@codexnest/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { application } from "../application";
import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";
import { ActionLabel } from "./ActionLabel";
import { Dialog } from "./Dialog";
import { CheckIcon, ChevronRightIcon, FolderIcon, SearchIcon, SlidersIcon, XIcon } from "./Icons";
import { WorkerAvatar } from "./WorkerAvatar";
import { useWorkerGridDrag } from "./useWorkerGridDrag";
import { WorkersHeader } from "./WorkersHeader";
import "./workers.css";

type Selection = { worker: WorkerProfile; projectId?: string };
type WorkerLaunch = { workerId: string; projectId: string };

function WorkerDelegation({ id, coordinates }: { id: string; coordinates: boolean | undefined }) {
  const { t } = useI18n();
  const canDelegate = id !== WORKER_ARCHITECT_ID && coordinates === true;
  return (
    <span className="worker-delegation">
      {canDelegate ? <CheckIcon /> : <XIcon />}
      <span>{canDelegate ? t("Может поручать задачи") : t("Не может поручать задачи")}</span>
    </span>
  );
}

export function WorkersPage({
  projects,
  onOpenNavigation,
}: {
  projects: Project[];
  onOpenNavigation(): void;
}) {
  const { api, state } = useConnection();
  const { language, t } = useI18n();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const proposalId = search.get("proposal");
  const [catalogue, setCatalogue] = useState<WorkerCatalogue>();
  const [selection, setSelection] = useState<Selection>();
  const [launch, setLaunch] = useState<WorkerProfile>();
  const [opening, setOpening] = useState<WorkerLaunch>();
  const [launchError, setLaunchError] = useState<WorkerLaunch & { message: string }>();
  const launchErrorId = useId();
  const launchPending = useRef(false);
  const lastAttempt = useRef<WorkerLaunch & { creationId: string }>(undefined);
  const mounted = useRef(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [orderStatus, setOrderStatus] = useState<{
    projectId: string;
    status: "saving" | "saved" | "error";
  }>();
  const drag = useWorkerGridDrag();
  const orderPending = useRef(false);
  const moveFocus = useRef<HTMLButtonElement>(null);
  const projectIds = JSON.stringify(projects.map(({ id }) => id));

  useEffect(() => {
    let active = true;
    void api.workerCatalogue(JSON.parse(projectIds) as string[]).then(
      (data) => {
        if (active) {
          setCatalogue(data);
          setError(undefined);
        }
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api, projectIds, refresh]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const button = moveFocus.current;
    moveFocus.current = null;
    if (!button?.isConnected) return;
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: "nearest" });
  }, [catalogue, orderStatus]);

  async function moveWorker(
    projectId: string,
    workerId: string,
    targetIndex: number,
    button: HTMLButtonElement,
  ) {
    if (orderPending.current) return;
    orderPending.current = true;
    setOrderStatus({ projectId, status: "saving" });
    try {
      const workers = await api.moveWorker(projectId, workerId, targetIndex);
      if (!mounted.current) return;
      if (document.activeElement === button) moveFocus.current = button;
      setCatalogue(
        (current) =>
          current && {
            ...current,
            projects: current.projects.map((group) =>
              group.projectId === projectId ? { projectId, workers } : group,
            ),
          },
      );
      setOrderStatus({ projectId, status: "saved" });
    } catch {
      if (mounted.current) {
        if (document.activeElement === button) moveFocus.current = button;
        setOrderStatus({ projectId, status: "error" });
      }
    } finally {
      orderPending.current = false;
    }
  }

  async function start(workerId: string, projectId: string) {
    if (launchPending.current) return;
    launchPending.current = true;
    const target = { workerId, projectId };
    setOpening(target);
    setLaunchError(undefined);
    const previous = lastAttempt.current;
    const creationId =
      previous?.workerId === workerId && previous.projectId === projectId
        ? previous.creationId
        : crypto.randomUUID();
    lastAttempt.current = { ...target, creationId };
    try {
      const { threadId } = await api.startWorker(workerId, projectId, creationId);
      lastAttempt.current = undefined;
      if (mounted.current) await navigate(`/threads/${encodeURIComponent(threadId)}`);
    } catch (cause) {
      if (mounted.current)
        setLaunchError({
          ...target,
          message: cause instanceof Error ? cause.message : String(cause),
        });
    } finally {
      launchPending.current = false;
      if (mounted.current) setOpening(undefined);
    }
  }

  function group(name: string | undefined, workers: WorkerProfile[], projectId?: string) {
    if (!workers.length) return null;
    const canReorder = projectId !== undefined && workers.length > 1;
    const preview = drag.preview?.grid.dataset.projectId === projectId ? drag.preview : undefined;
    const orderError = orderStatus?.projectId === projectId && orderStatus?.status === "error";
    return (
      <section key={projectId ?? "common"}>
        {name && <h2>{name}</h2>}
        <ul className="workers-grid" data-project-id={projectId}>
          {workers.map((worker, index) => {
            const architect = worker.id === WORKER_ARCHITECT_ID;
            const name = architect ? t("Архитектор") : worker.name;
            const role = architect ? t("Помогает создать работника") : worker.role;
            const starting = opening?.workerId === worker.id && opening.projectId === projectId;
            const failed =
              launchError?.workerId === worker.id && launchError.projectId === projectId
                ? launchError.message
                : undefined;
            return (
              <li
                key={worker.id}
                data-worker-dragging={preview?.from === index || undefined}
                data-worker-drop={
                  (preview?.target === index && preview.from !== index) || undefined
                }
              >
                <button
                  type="button"
                  className="worker-tile"
                  aria-busy={starting || undefined}
                  aria-disabled={starting || undefined}
                  aria-describedby={failed ? launchErrorId : undefined}
                  disabled={Boolean(opening) && !starting}
                  aria-keyshortcuts={
                    canReorder
                      ? "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
                      : undefined
                  }
                  onPointerDown={
                    canReorder
                      ? (event) => {
                          if (!orderPending.current && !launchPending.current) {
                            drag.begin(
                              event,
                              index,
                              (target, button) =>
                                void moveWorker(projectId, worker.id, target, button),
                            );
                          }
                        }
                      : undefined
                  }
                  onKeyDown={
                    canReorder
                      ? (event) => {
                          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
                            return;
                          const direction = {
                            ArrowLeft: -1,
                            ArrowRight: 1,
                            ArrowUp: -1,
                            ArrowDown: 1,
                          }[event.key];
                          if (direction === undefined) return;
                          event.preventDefault();
                          if (
                            event.repeat ||
                            drag.preview ||
                            orderPending.current ||
                            launchPending.current
                          )
                            return;
                          const button = event.currentTarget;
                          let target = index + direction;
                          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                            const cards = Array.from(
                              button.closest(".workers-grid")!.children,
                            ) as HTMLElement[];
                            const top = cards[index]!.offsetTop;
                            const adjacent =
                              direction < 0
                                ? cards.slice(0, index).reverse()
                                : cards.slice(index + 1);
                            const nextRow = adjacent.find((card) => card.offsetTop !== top);
                            if (!nextRow) return;
                            const column = cards[index]!.offsetLeft;
                            const destination = adjacent
                              .filter((card) => card.offsetTop === nextRow.offsetTop)
                              .reduce(
                                (nearest, card) =>
                                  Math.abs(card.offsetLeft - column) <
                                  Math.abs(nearest.offsetLeft - column)
                                    ? card
                                    : nearest,
                                nextRow,
                              );
                            target = cards.indexOf(destination);
                          }
                          if (target >= 0 && target < workers.length) {
                            void moveWorker(projectId, worker.id, target, button);
                          }
                        }
                      : undefined
                  }
                  onClick={() => {
                    if (launchPending.current) return;
                    if (projectId) {
                      void start(worker.id, projectId);
                    } else {
                      setLaunchError(undefined);
                      setLaunch(worker);
                    }
                  }}
                >
                  <WorkerAvatar id={worker.id} projectKey={worker.projectKey} />
                  <strong title={name}>{name}</strong>
                  {starting ? (
                    <span className="worker-tile-role working-text" role="status">
                      {t("Открываем диалог…")}
                    </span>
                  ) : (
                    <span className="worker-tile-role" title={role}>
                      {role}
                    </span>
                  )}
                  <WorkerDelegation id={worker.id} coordinates={worker.coordinates} />
                </button>
                <button
                  type="button"
                  className="icon-button worker-tile-settings"
                  aria-label={t("Настройки работника «{{name}}»", { name })}
                  title={t("Настройки")}
                  disabled={Boolean(opening)}
                  onClick={() => setSelection({ worker, projectId })}
                >
                  <SlidersIcon />
                </button>
                {failed && (
                  <p className="worker-launch-error" id={launchErrorId} role="alert">
                    {localizeKnownServerText(language, failed)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {orderError && (
          <p className="worker-launch-error" role="alert">
            {t("Не удалось сохранить порядок. Повторите перемещение.")}
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="thread-workspace kanban-workspace workers-workspace">
      <section className="conversation-pane kanban-pane">
        <WorkersHeader onOpenNavigation={onOpenNavigation} />
        <div
          className="workers-content worker-catalogue"
          onPointerDownCapture={drag.resetClick}
          onClickCapture={drag.captureClick}
        >
          {error && (
            <div role="alert">
              <p>{localizeKnownServerText(language, error)}</p>
              <button onClick={() => setRefresh((value) => value + 1)}>{t("Обновить")}</button>
            </div>
          )}
          {!catalogue && !error && (
            <p role="status" className="working-text">
              {t("Загружаем работников…")}
            </p>
          )}
          {catalogue &&
            group(
              undefined,
              catalogue.common.filter(({ id }) => id === WORKER_ARCHITECT_ID),
            )}
          {catalogue?.projects.map(({ projectId, workers }) => {
            const name = projects.find(({ id }) => id === projectId)?.displayName;
            return name ? group(name, workers, projectId) : null;
          })}
          <span className="sr-only" role="status">
            {orderStatus?.status === "saved" ? t("Порядок сохранён") : ""}
          </span>
        </div>
      </section>
      {launch && (
        <WorkerProjectDialog
          worker={launch}
          projects={projects}
          opening={opening?.projectId}
          error={launchError?.message}
          onStart={(projectId) => void start(launch.id, projectId)}
          onClose={() => {
            setLaunch(undefined);
            setLaunchError(undefined);
          }}
        />
      )}
      {selection && (
        <WorkerSettings
          selection={selection}
          models={state.snapshot?.models ?? []}
          onClose={() => setSelection(undefined)}
          onSaved={() => {
            setSelection(undefined);
            setRefresh((value) => value + 1);
          }}
        />
      )}
      {proposalId && (
        <WorkerProposalDialog
          key={proposalId}
          id={proposalId}
          models={state.snapshot?.models ?? []}
          onClose={() => setSearch({}, { replace: true })}
          onSaved={() => {
            setSearch({}, { replace: true });
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}

function WorkerProjectDialog({
  worker,
  projects,
  opening,
  error,
  onStart,
  onClose,
}: {
  worker: WorkerProfile;
  projects: Project[];
  opening?: string;
  error?: string;
  onStart(projectId: string): void;
  onClose(): void;
}) {
  const { language, t } = useI18n();
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const name = worker.id === WORKER_ARCHITECT_ID ? t("Архитектор") : worker.name;
  const busy = opening !== undefined;
  const searchable = projects.length > 1;
  const term = searchable ? query.trim().toLowerCase() : "";
  const matches = term
    ? projects.filter(({ displayName }) => displayName.toLowerCase().includes(term))
    : projects;
  const resultsId = `${titleId}-projects`;

  return (
    <Dialog
      titleId={titleId}
      className="chat-dialog worker-project-dialog"
      backdropClassName={searchable ? "worker-project-search-backdrop" : undefined}
      initialFocusRef={searchable ? searchRef : undefined}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      onClose={onClose}
    >
      <div className="dialog-header">
        <div className="dialog-heading">
          <h2 id={titleId}>{t("Запустить «{{name}}»", { name })}</h2>
          {projects.length > 0 && <p>{t("Выберите проект")}</p>}
        </div>
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
      {searchable && (
        <div className="worker-project-search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            aria-label={t("Найти проект")}
            aria-controls={resultsId}
            placeholder={t("Найти проект")}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              if (resultsRef.current) resultsRef.current.scrollTop = 0;
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                term &&
                matches.length === 1
              ) {
                event.preventDefault();
                onStart(matches[0]!.id);
              }
            }}
          />
        </div>
      )}
      {projects.length > 0 ? (
        <div ref={resultsRef} id={resultsId} className="project-directory-list">
          {matches.map(({ id, displayName, path }) => (
            <button
              key={id}
              type="button"
              className="project-directory-entry worker-project-option"
              disabled={busy}
              onClick={() => onStart(id)}
            >
              <FolderIcon />
              <span>
                <strong>{displayName}</strong>
                <small>{opening === id ? t("Открываем диалог…") : path}</small>
              </span>
              <ChevronRightIcon />
            </button>
          ))}
          {matches.length === 0 && (
            <p className="worker-project-empty" role="status">
              {t("Совпадений нет")}
            </p>
          )}
        </div>
      ) : (
        <p className="dialog-notice">
          {worker.projectKey
            ? t("Проект работника больше недоступен.")
            : t("Добавьте проект, чтобы запустить работника.")}
        </p>
      )}
      {error && (
        <p className="dialog-notice danger" role="alert">
          {localizeKnownServerText(language, error)}
        </p>
      )}
    </Dialog>
  );
}

function WorkerProposalDialog({
  id,
  models,
  onClose,
  onSaved,
}: {
  id: string;
  models: ModelOption[];
  onClose(): void;
  onSaved(): void;
}) {
  const { api } = useConnection();
  const { language, t } = useI18n();
  const titleId = useId();
  const [proposal, setProposal] = useState<WorkerProposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void api.readWorkerProposal(id).then(
      (value) => {
        if (active) setProposal(value);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api, id]);
  async function approve() {
    setBusy(true);
    setError(undefined);
    try {
      await api.approveWorkerProposal(id);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }
  const workerId = proposal?.target?.id ?? proposal?.id;
  return (
    <Dialog
      titleId={titleId}
      className="chat-dialog worker-settings-dialog worker-proposal-dialog"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      onClose={onClose}
    >
      <div className="dialog-header">
        <div className="worker-proposal-identity">
          {workerId && <WorkerAvatar id={workerId} projectKey={proposal?.projectKey} />}
          <div className="dialog-heading">
            <h2 id={titleId}>{proposal?.name ?? t("Профиль работника")}</h2>
            {workerId && proposal && (!proposal.target || proposal.coordinates !== undefined) && (
              <WorkerDelegation id={workerId} coordinates={proposal.coordinates} />
            )}
          </div>
        </div>
        <button className="icon-button" aria-label={t("Закрыть")} disabled={busy} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="worker-settings-fields">
        {error && <p role="alert">{localizeKnownServerText(language, error)}</p>}
        {!proposal && !error && <p role="status">{t("Загружаем настройки…")}</p>}
        {proposal && (
          <>
            <p className="worker-proposal-role">
              {proposal.role}
              {proposal.projectName && ` · ${proposal.projectName}`}
            </p>
            {proposal.target && (
              <label>
                {t("Текущие инструкции")}
                <textarea rows={3} value={proposal.target.previousInstructions} readOnly />
              </label>
            )}
            <label>
              {t("Постоянные инструкции")}
              <textarea rows={5} value={proposal.instructions} readOnly />
            </label>
            <p>
              {models.find(({ id }) => id === proposal.settings.model)?.displayName ??
                proposal.settings.model}{" "}
              · {proposal.settings.reasoningEffort ?? t("По умолчанию")}
            </p>
          </>
        )}
      </div>
      {proposal && (
        <footer>
          <button
            className="primary"
            aria-busy={busy || undefined}
            disabled={busy}
            onClick={() => void approve()}
          >
            <ActionLabel
              idle={proposal.target ? t("Применить изменения") : t("Создать работника")}
              busy={proposal.target ? t("Сохраняем…") : t("Создаём…")}
              pending={busy}
            />
          </button>
        </footer>
      )}
    </Dialog>
  );
}

function WorkerSettings({
  selection,
  models,
  onClose,
  onSaved,
}: {
  selection: Selection;
  models: ModelOption[];
  onClose(): void;
  onSaved(): void;
}) {
  const { api } = useConnection();
  const { language, t } = useI18n();
  const { worker, projectId } = selection;
  const titleId = useId();
  const [details, setDetails] = useState<WorkerDetails>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [entry, setEntry] = useState<{ value: WorkerMemoryEntry; text: string }>();
  const architect = worker.id === WORKER_ARCHITECT_ID;
  const provider = application.provider;

  useEffect(() => {
    let active = true;
    void api.readWorker(worker.id, projectId).then(
      (data) => {
        if (active) setDetails(data);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api, worker.id, projectId]);

  const profile = details?.profile;
  const settings = profile?.settings[provider];
  const model = models.find((option) => option.id === settings?.model);
  function patch(changes: Partial<WorkerProfile>) {
    setDetails((current) => current && { ...current, profile: { ...current.profile, ...changes } });
  }
  function choose(settings: SessionSettings) {
    if (profile) patch({ settings: { ...profile.settings, [provider]: settings } });
  }
  async function update(operation: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  function save() {
    if (!profile) return;
    void update(async () => {
      const { name, role, instructions, revision } = profile;
      await api.updateWorker(worker.id, projectId, {
        name,
        role,
        instructions,
        revision,
        settings,
      });
      onSaved();
    });
  }
  function changeMemory(value: WorkerMemoryEntry, text: string | null) {
    void update(async () => {
      const memory = await api.updateWorkerMemory(worker.id, projectId, value, text);
      setDetails((current) => current && { ...current, memory });
      setEntry(undefined);
    });
  }

  return (
    <Dialog
      titleId={titleId}
      className="chat-dialog worker-settings-dialog"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      onClose={onClose}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{architect ? t("Архитектор") : worker.name}</h2>
        <button className="icon-button" aria-label={t("Закрыть")} disabled={busy} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="worker-settings-fields">
        {error && <p role="alert">{localizeKnownServerText(language, error)}</p>}
        {!details && !error && <p role="status">{t("Загружаем настройки…")}</p>}
        {profile && (
          <>
            {!architect && (
              <>
                <label>
                  {t("Имя")}
                  <input
                    value={profile.name}
                    maxLength={120}
                    onChange={(event) => patch({ name: event.target.value })}
                  />
                </label>
                <label>
                  {t("Роль")}
                  <input
                    value={profile.role}
                    maxLength={500}
                    onChange={(event) => patch({ role: event.target.value })}
                  />
                </label>
              </>
            )}
            <label>
              {t("Постоянные инструкции")}
              <textarea
                rows={3}
                value={profile.instructions}
                maxLength={16_000}
                onChange={(event) => patch({ instructions: event.target.value })}
              />
            </label>
            {architect ? (
              <p>{t("Архитектор использует настройки приложения по умолчанию.")}</p>
            ) : (
              <div className="worker-model-fields">
                <label>
                  {t("Модель")}
                  <select
                    value={settings?.model ?? ""}
                    onChange={(event) =>
                      choose({
                        ...settings,
                        collaborationMode: settings?.collaborationMode ?? "default",
                        model: event.target.value || undefined,
                        reasoningEffort: undefined,
                        serviceTier: undefined,
                      })
                    }
                  >
                    <option value="">{t("По умолчанию")}</option>
                    {settings?.model && !model && (
                      <option value={settings.model}>
                        {settings.model} · {t("Недоступна")}
                      </option>
                    )}
                    {models.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("Уровень рассуждений")}
                  <select
                    value={settings?.reasoningEffort ?? ""}
                    disabled={!model?.reasoningEfforts.length}
                    onChange={(event) =>
                      choose({
                        ...settings,
                        collaborationMode: settings?.collaborationMode ?? "default",
                        reasoningEffort: event.target.value || undefined,
                      })
                    }
                  >
                    <option value="">{t("По умолчанию")}</option>
                    {model?.reasoningEfforts.map(({ value }) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <section>
              <h3>{t("Память")}</h3>
              {details?.memory.length ? (
                <ul className="worker-memory">
                  {details.memory.map((value) => (
                    <li key={value.id}>
                      {entry?.value.id === value.id ? (
                        <>
                          <textarea
                            aria-label={t("Запись памяти")}
                            rows={2}
                            value={entry.text}
                            maxLength={2200}
                            onChange={(event) => setEntry({ value, text: event.target.value })}
                          />
                          <button
                            disabled={busy || !entry.text.trim()}
                            onClick={() => changeMemory(value, entry.text)}
                          >
                            {t("Сохранить запись")}
                          </button>
                          <button disabled={busy} onClick={() => setEntry(undefined)}>
                            {t("Отмена")}
                          </button>
                        </>
                      ) : (
                        <>
                          <span>{value.text}</span>
                          <button
                            disabled={busy}
                            onClick={() => setEntry({ value, text: value.text })}
                          >
                            {t("Изменить")}
                          </button>
                          <button disabled={busy} onClick={() => changeMemory(value, null)}>
                            {t("Удалить")}
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t("Пока нет записей.")}</p>
              )}
            </section>
            <footer>
              <button
                className="primary"
                disabled={busy || !profile.name.trim() || !profile.role.trim()}
                onClick={save}
              >
                {t("Сохранить")}
              </button>
            </footer>
          </>
        )}
      </div>
    </Dialog>
  );
}
