import type { WorkerProcess, WorkerProcessSession } from "@codexnest/protocol";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon } from "./Icons";
import { WorkersHeader } from "./WorkersHeader";
import "./workers.css";

const processesPath = "/workers/processes";
const apps = { codex: "CodexNest", claude: "ClaudeNest", gemini: "GeminiNest", open: "OpenNest" };
const active = (session: WorkerProcessSession) =>
  session.status !== "completed" && session.status !== "failed";

type Participant = {
  sessions: WorkerProcessSession[];
  children: Participant[];
};

function branch(process: WorkerProcess, sessions: WorkerProcessSession[]): Participant {
  const ids = new Set(sessions.map(({ id }) => id));
  const children = new Map<string, WorkerProcessSession[]>();
  for (const session of process.sessions) {
    if (!session.parentId || !ids.has(session.parentId)) continue;
    const group = children.get(session.workerId) ?? [];
    group.push(session);
    children.set(session.workerId, group);
  }
  return { sessions, children: [...children.values()].map((group) => branch(process, group)) };
}

function current({ sessions }: Participant): WorkerProcessSession {
  return sessions.find(active) ?? sessions[sessions.length - 1]!;
}

function descendants(node: Participant): Participant[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function sessionsText(t: Translate, count: number): string {
  const last = count % 100;
  const word = count % 10;
  return t(
    word === 1 && last !== 11
      ? "{{count}} сессия"
      : word >= 2 && word <= 4 && (last < 12 || last > 14)
        ? "{{count}} сессии"
        : "{{count}} сессий",
    { count },
  );
}

function workersText(t: Translate, count: number): string {
  const last = count % 100;
  const word = count % 10;
  return t(
    word === 1 && last !== 11
      ? "{{count}} дополнительный работник"
      : word >= 2 && word <= 4 && (last < 12 || last > 14)
        ? "{{count}} дополнительных работника"
        : "{{count}} дополнительных работников",
    { count },
  );
}

function processLink(processId: string, session: WorkerProcessSession): string {
  return `${processesPath}/${encodeURIComponent(processId)}${session.id === processId ? "" : `?session=${encodeURIComponent(session.id)}`}`;
}

export function WorkerProcessesPage({ onOpenNavigation }: { onOpenNavigation(): void }) {
  const { api } = useConnection();
  const { language, t } = useI18n();
  const { processId } = useParams();
  const [statusFilter, setStatusFilter] = useState<ProcessStatusFilter>("all");
  const [view, setView] = useState<{
    id: string | undefined;
    processes?: WorkerProcess[];
    error?: string;
  }>();
  const visible = view?.id === processId ? view : undefined;
  const process = processId ? visible?.processes?.[0] : undefined;

  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    async function refresh() {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const processes = await api.workerProcesses(processId);
        if (mounted) setView({ id: processId, processes });
      } catch (error) {
        if (mounted)
          setView((previous) => ({
            id: processId,
            processes: previous?.id === processId ? previous?.processes : undefined,
            error: error instanceof Error ? error.message : "",
          }));
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    // Read the local overview only while this page is visible.
    const timer = window.setInterval(() => void refresh(), 4_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [api, processId]);

  return (
    <div className="thread-workspace kanban-workspace workers-workspace">
      <section className="conversation-pane kanban-pane">
        <WorkersHeader processes onOpenNavigation={onOpenNavigation} />
        <div
          className={`workers-content processes-content${processId ? " process-detail-content" : ""}`}
        >
          {visible?.error !== undefined && (
            <p role="alert">
              {localizeKnownServerText(language, visible.error) ||
                t("Не удалось загрузить процессы")}
            </p>
          )}
          {!visible && (
            <p className="working-text" role="status">
              {t("Загружаем процессы…")}
            </p>
          )}
          {process ? (
            <ProcessDetail key={process.id} process={process} />
          ) : visible?.processes && !processId ? (
            <ProcessOverview
              processes={visible.processes}
              filter={statusFilter}
              onFilterChange={setStatusFilter}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

const overviewStatuses = [
  "Ждёт ответа",
  "В работе",
  "Ждёт результата",
  "В очереди",
  "Ошибка",
  "Готово",
] as const;

type ProcessStatus = (typeof overviewStatuses)[number];
type ProcessStatusFilter = ProcessStatus | "all";

function overviewStatus(session: WorkerProcessSession): ProcessStatus {
  switch (session.status) {
    case "waiting":
      return session.waitingFor.length ? "Ждёт результата" : "Ждёт ответа";
    case "running":
      return "В работе";
    case "queued":
      return "В очереди";
    case "failed":
      return "Ошибка";
    case "completed":
      return "Готово";
  }
}

function WorkStatus({ session }: { session: WorkerProcessSession }) {
  const { t } = useI18n();
  const label =
    session.status === "completed" && session.kind === "question"
      ? "Ответил"
      : overviewStatus(session);
  return (
    <span
      className="process-status"
      data-phase={session.status === "completed" ? "done" : session.status}
    >
      {t(label)}
    </span>
  );
}

function ProcessOverview({
  processes,
  filter,
  onFilterChange,
}: {
  processes: WorkerProcess[];
  filter: ProcessStatusFilter;
  onFilterChange(filter: ProcessStatusFilter): void;
}) {
  const { t } = useI18n();
  const sections = new Map<
    ProcessStatus,
    Map<string | null, { process: WorkerProcess; root: WorkerProcessSession }[]>
  >();
  for (const process of processes) {
    const root = process.sessions.find(({ id }) => id === process.id);
    if (!root) continue;

    const status = overviewStatus(root);
    const projects = sections.get(status) ?? new Map();
    const group = projects.get(process.projectKey) ?? [];
    group.push({ process, root });
    projects.set(process.projectKey, group);
    sections.set(status, projects);
  }
  const options = overviewStatuses.filter((status) => sections.has(status) || status === filter);
  const visibleStatuses = filter === "all" ? options : [filter];

  return (
    <div className="process-overview">
      <label className="process-filter">
        <span>{t("Статус")}</span>
        <select
          value={filter}
          onChange={(event) => onFilterChange(event.currentTarget.value as ProcessStatusFilter)}
        >
          <option value="all">{t("Все")}</option>
          {options.map((status) => (
            <option key={status} value={status}>
              {t(status)}
            </option>
          ))}
        </select>
      </label>
      {filter === "all" && !sections.size && <p>{t("Нет активных процессов")}</p>}
      {filter !== "all" && !sections.has(filter) && (
        <p role="status">{t("Нет процессов с этим статусом")}</p>
      )}
      {visibleStatuses.map((status) => {
        const projects = sections.get(status);
        if (!projects) return null;
        const label = t(status);
        return (
          <section className="process-section" key={status} aria-label={label}>
            <h2>{label}</h2>
            {[...projects].map(([key, group]) => {
              const name = group[0]!.process.projectName ?? t("Без проекта");
              return (
                <section className="process-project" key={key ?? ""} aria-label={name}>
                  <h3>{name}</h3>
                  <ul className="process-worker-list">
                    {group.map(({ process, root }) => (
                      <li className="process-overview-run" key={root.id}>
                        <ProcessRow processId={root.id} node={branch(process, [root])} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function hasActiveWork(node: Participant): boolean {
  return node.sessions.some(active) || node.children.some(hasActiveWork);
}

function ProcessRow({ processId, node }: { processId: string; node: Participant }) {
  const { t } = useI18n();
  const first = current(node);
  const running = node.sessions.filter(active);
  const visible = running.length ? running : [first];
  const children = node.children.filter(hasActiveWork);
  return (
    <>
      <Link className="process-worker-row" to={processLink(processId, first)}>
        <span className="process-worker-label">
          <strong>{first.workerName}</strong>
          {visible.length > 1 && <small>{sessionsText(t, visible.length)}</small>}
        </span>
        <ul className="process-session-list">
          {visible.map((session) => (
            <li key={session.id}>
              {(session.parentId !== null || session.title !== session.workerName) && (
                <span className="process-session-name">{session.title}</span>
              )}
              <span className="process-provider">{apps[session.provider]}</span>
              <WorkStatus session={session} />
            </li>
          ))}
        </ul>
        <ChevronRightIcon className="process-row-chevron" />
      </Link>
      {children.length > 0 && (
        <ul className="process-overview-members" aria-label={t("Подключённые работники")}>
          {children.map((child) => (
            <li key={current(child).workerId}>
              <ProcessRow processId={processId} node={child} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SessionLink({ session }: { session: WorkerProcessSession }) {
  const { t } = useI18n();
  if (!session.sessionUrl) return null;
  const content = (
    <>
      {t("Открыть сессию")}
      <ChevronRightIcon />
    </>
  );
  return session.sessionUrl.startsWith("/") ? (
    <Link className="process-session-link" to={session.sessionUrl}>
      {content}
    </Link>
  ) : (
    <a className="process-session-link" href={session.sessionUrl}>
      {content}
    </a>
  );
}

function ProcessDetail({ process }: { process: WorkerProcess }) {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const inspector = useRef<HTMLElement>(null);
  const root = process.sessions.find(({ id }) => id === process.id)!;
  const graph = branch(process, [root]);
  const others = descendants(graph);
  const selectedId = params.get("session") ?? root.id;
  const selected =
    others.find(({ sessions }) => sessions.some(({ id }) => id === selectedId)) ?? graph;
  const children = process.sessions.filter(({ parentId }) => parentId !== null);
  const workerCount = new Set(children.map(({ workerId }) => workerId)).size;

  function select(participant: Participant, event: MouseEvent<HTMLButtonElement>) {
    setParams({ session: current(participant).id }, { replace: true, preventScrollReset: true });
    const panel = inspector.current;
    const layout = panel?.parentElement;
    if (!panel || !layout || event.detail === 0) return;
    const stacked = panel.getBoundingClientRect().top > layout.getBoundingClientRect().top + 1;
    if (!stacked) return;
    requestAnimationFrame(() => {
      if (panel.getBoundingClientRect().bottom <= window.innerHeight) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.scrollIntoView({ block: "start", behavior: reduceMotion ? "instant" : "smooth" });
    });
  }

  return (
    <div className="process-detail">
      <div className="process-breadcrumb">
        <Link to={processesPath}>
          <ArrowLeftIcon /> {t("Процессы")}
        </Link>
        <ChevronRightIcon />
        <span>{process.projectName ?? t("Без проекта")}</span>
      </div>
      <div className="process-detail-heading">
        <div>
          <h2>{root.workerName}</h2>
          <p className="process-detail-title">{root.title}</p>
        </div>
        <SessionLink session={root} />
      </div>
      <section className="process-graph" aria-labelledby="process-graph-title">
        <div className="process-graph-heading">
          <h3 id="process-graph-title">{t("Схема процесса")}</h3>
          {workerCount > 0 && (
            <span>
              {workersText(t, workerCount)} · {sessionsText(t, children.length)}
            </span>
          )}
        </div>
        <div className="process-graph-layout">
          <div className="process-network">
            <ProcessNode participant={graph} selected={selected} onSelect={select} root />
            {workerCount === 0 && (
              <p className="process-empty">{t("Дополнительных работников пока нет")}</p>
            )}
          </div>
          <aside
            className="process-inspector"
            id="process-worker-detail"
            aria-labelledby="process-worker-name"
            ref={inspector}
          >
            <WorkerDetails
              key={current(selected).id}
              process={process}
              participant={selected}
              initialSession={selectedId}
            />
          </aside>
        </div>
      </section>
    </div>
  );
}

function ProcessNode({
  participant,
  selected,
  onSelect,
  root = false,
  awaited = false,
}: {
  participant: Participant;
  selected: Participant;
  onSelect(participant: Participant, event: MouseEvent<HTMLButtonElement>): void;
  root?: boolean;
  awaited?: boolean;
}) {
  const { t } = useI18n();
  const work = current(participant);
  const waiting = new Set(participant.sessions.flatMap(({ waitingFor }) => waitingFor));
  const { children } = participant;
  const awaitedChildren = children.map(({ sessions }) =>
    sessions.some(({ id }) => waiting.has(id)),
  );
  // End branches draw their own elbows, so the shared segment ends at their track boundary.
  const position = (index: number) =>
    children.length > 1
      ? Math.max(1, Math.min(index + 0.5, children.length - 1)) / children.length
      : 0.5;
  return (
    <>
      <button
        className={root ? "process-graph-node process-graph-root" : "process-graph-node"}
        type="button"
        aria-controls="process-worker-detail"
        aria-pressed={selected === participant}
        onClick={(event) => onSelect(participant, event)}
      >
        <span className="process-node-heading">
          <strong>{work.workerName}</strong>
          {participant.sessions.length > 1 && (
            <small>{sessionsText(t, participant.sessions.length)}</small>
          )}
        </span>
        {!root && (
          <span className="process-node-task">
            {work.kind === "question" && `${t("Вопрос")} · `}
            {work.title}
          </span>
        )}
        <span className="process-node-meta">
          <WorkStatus session={work} />
          {root && <small>{apps[work.provider]}</small>}
          {awaited && <small className="process-node-wait">{t("Ждут результата")}</small>}
        </span>
      </button>
      {children.length > 0 && (
        <ul
          className="process-graph-branches"
          style={
            {
              "--process-waiting-start": position(awaitedChildren.indexOf(true)),
              "--process-waiting-end": position(awaitedChildren.lastIndexOf(true)),
            } as CSSProperties
          }
        >
          {children.map((child, index) => (
            <li key={current(child).workerId} data-awaiting={awaitedChildren[index]}>
              <ChevronDownIcon className="process-edge-arrow" />
              <ProcessNode
                participant={child}
                selected={selected}
                onSelect={onSelect}
                awaited={awaitedChildren[index]}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function WorkerDetails({
  process,
  participant,
  initialSession,
}: {
  process: WorkerProcess;
  participant: Participant;
  initialSession: string;
}) {
  const { t } = useI18n();
  const work = current(participant);
  const opened = participant.sessions.some(({ id }) => id === initialSession)
    ? initialSession
    : work.id;
  const sessions = [work, ...participant.sessions.filter(({ id }) => id !== work.id)];
  const sender = process.sessions.find(({ id }) => id === work.parentId);
  return (
    <>
      <div className="process-inspector-heading">
        <h4 id="process-worker-name">{work.workerName}</h4>
        <span>{sessionsText(t, sessions.length)}</span>
      </div>
      <p className="process-inspector-meta">
        {apps[work.provider]}
        {sender &&
          ` · ${t(work.kind === "question" ? "Спросил {{worker}}" : "Поручил {{worker}}", { worker: sender.workerName })}`}
      </p>
      {sessions.map((session) => (
        <details className="process-work" key={session.id} open={session.id === opened}>
          <summary>
            <span>
              <span className="process-work-meta">
                {session.kind !== "session" && (
                  <small>{t(session.kind === "question" ? "Вопрос" : "Поручение")}</small>
                )}
                <WorkStatus session={session} />
              </span>
              {session.title}
            </span>
            <ChevronDownIcon />
          </summary>
          <div className="process-work-detail">
            {sender?.waitingFor.includes(session.id) && (
              <p className="process-inspector-wait">
                {t("{{worker}} ждёт результата", { worker: sender.workerName })}
              </p>
            )}
            {session.description && <p>{session.description}</p>}
            {session.expectedResult && <p>{session.expectedResult}</p>}
            {(session.result || session.error) && (
              <div className="process-work-result">
                <strong>{t(session.error ? "Ошибка" : "Результат")}</strong>
                <p>{session.error ?? session.result}</p>
              </div>
            )}
            <SessionLink session={session} />
          </div>
        </details>
      ))}
    </>
  );
}
