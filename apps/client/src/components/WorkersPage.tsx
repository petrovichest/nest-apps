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
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { application } from "../application";
import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";
import { Dialog } from "./Dialog";
import { ChevronRightIcon, FolderIcon, SearchIcon, SlidersIcon, XIcon } from "./Icons";
import { WorkersHeader } from "./WorkersHeader";
import "./workers.css";

type Selection = { worker: WorkerProfile; projectId?: string };
type WorkerLaunch = { workerId: string; projectId: string };

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
    return (
      <section key={projectId ?? "common"}>
        {name && <h2>{name}</h2>}
        <ul className="workers-grid">
          {workers.map((worker) => {
            const starting = opening?.workerId === worker.id && opening.projectId === projectId;
            const failed =
              launchError?.workerId === worker.id && launchError.projectId === projectId
                ? launchError.message
                : undefined;
            return (
              <li key={worker.id}>
                <button
                  type="button"
                  className="worker-tile"
                  aria-busy={starting || undefined}
                  aria-disabled={starting || undefined}
                  aria-describedby={failed ? launchErrorId : undefined}
                  disabled={Boolean(opening) && !starting}
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
                  <strong>
                    {worker.id === WORKER_ARCHITECT_ID ? t("Архитектор") : worker.name}
                  </strong>
                  {starting ? (
                    <span className="working-text" role="status">
                      {t("Открываем диалог…")}
                    </span>
                  ) : (
                    <span>
                      {worker.id === WORKER_ARCHITECT_ID
                        ? t("Помогает создать работника")
                        : worker.role}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="icon-button worker-tile-settings"
                  aria-label={t("Настройки работника «{{name}}»", {
                    name: worker.id === WORKER_ARCHITECT_ID ? t("Архитектор") : worker.name,
                  })}
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
      </section>
    );
  }

  return (
    <div className="thread-workspace kanban-workspace workers-workspace">
      <section className="conversation-pane kanban-pane">
        <WorkersHeader onOpenNavigation={onOpenNavigation} />
        <div className="workers-content">
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
  return (
    <Dialog
      titleId={titleId}
      className="chat-dialog worker-settings-dialog"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      onClose={onClose}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{proposal?.name ?? t("Профиль работника")}</h2>
        <button className="icon-button" aria-label={t("Закрыть")} disabled={busy} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="worker-settings-fields">
        {error && <p role="alert">{localizeKnownServerText(language, error)}</p>}
        {!proposal && !error && <p role="status">{t("Загружаем настройки…")}</p>}
        {proposal && (
          <>
            <p>
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
            <footer>
              <button className="primary" disabled={busy} onClick={() => void approve()}>
                {proposal.target ? t("Применить изменения") : t("Создать работника")}
              </button>
            </footer>
          </>
        )}
      </div>
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
