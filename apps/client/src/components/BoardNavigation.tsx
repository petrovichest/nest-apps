import { useEffect, useMemo, useState } from "react";
import { Link, matchPath, useLocation } from "react-router";
import type { KanbanBoard, KanbanStage, Project, ThreadSummary } from "@codexnest/protocol";
import { application } from "../application";
import { useConnection } from "../connection";
import { useI18n } from "../i18n";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, KanbanIcon } from "./Icons";
import { cardStatusClass, latestRun, stageLabel } from "./KanbanBoard";

/** A board shown by the board page, passed on so the navigation needs no requests of its own. */
export type ShownBoard = { projectId: string; board: KanbanBoard };

const REFRESH_MS = 4_000;
/** Answers and running agents come first, the other stages keep the board's order. */
const stageRank = (stage: KanbanStage) =>
  stage.role === "waiting" ? 0 : stage.role === "working" ? 1 : 2;
const boardPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/kanban`;

/**
 * Board mode of the navigation: the projects, each opening on its own to its board and its tasks
 * by stage, each task opening its session.
 */
export function BoardNavigation({
  projects,
  openProjectIds,
  threads,
  shownBoard,
  onToggleProject,
  onNavigate,
}: {
  /** In the order of the session list's projects. */
  projects: Project[];
  /** The open projects; only their boards are loaded. */
  openProjectIds: ReadonlySet<string>;
  /** Sessions of this application; they colour the markers like on the board. */
  threads: ThreadSummary[];
  shownBoard: ShownBoard | null;
  onToggleProject(projectId: string): void;
  onNavigate(): void;
}) {
  const sessions = useMemo(
    () =>
      new Map(threads.filter((thread) => !thread.archived).map((thread) => [thread.id, thread])),
    [threads],
  );
  return (
    <div className="project-list board-navigation">
      {projects.map((project) => {
        const open = openProjectIds.has(project.id);
        return (
          <section className="project-group" key={project.id}>
            <div className="project-title">
              <button
                aria-controls={open ? tasksId(project.id) : undefined}
                aria-expanded={open}
                className="project-toggle"
                type="button"
                onClick={() => onToggleProject(project.id)}
              >
                {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                <FolderIcon />
                <span>{project.displayName}</span>
              </button>
            </div>
            {open && (
              <ProjectTasks
                projectId={project.id}
                sessions={sessions}
                shownBoard={shownBoard}
                onNavigate={onNavigate}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

const tasksId = (projectId: string) => `board-navigation-${projectId}`;

/** An open project's board row and its tasks by stage. */
function ProjectTasks({
  projectId,
  sessions,
  shownBoard,
  onNavigate,
}: {
  projectId: string;
  sessions: ReadonlyMap<string, ThreadSummary>;
  shownBoard: ShownBoard | null;
  onNavigate(): void;
}) {
  const { api } = useConnection();
  const { t } = useI18n();
  const location = useLocation();
  const [fetched, setFetched] = useState<KanbanBoard | null>(null);
  const [failed, setFailed] = useState(false);
  // Stages whose group the operator opened or closed against its default.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const onBoardPage =
    matchPath("/projects/:projectId/kanban", location.pathname)?.params.projectId === projectId;
  const openThreadId = matchPath("/threads/:threadId", location.pathname)?.params.threadId;
  const pageBoard = shownBoard?.projectId === projectId ? shownBoard.board : null;
  const board = onBoardPage ? (pageBoard ?? fetched) : (fetched ?? pageBoard);

  // The board page refreshes its own board; elsewhere the navigation keeps the list current.
  useEffect(() => {
    if (onBoardPage) return;
    let alive = true;
    let inFlight = false;
    async function refresh() {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const next = await api.readKanban(projectId);
        if (!alive) return;
        setFailed(false);
        setFetched((previous) =>
          previous?.id === next.id && previous.revision >= next.revision ? previous : next,
        );
      } catch {
        if (alive) setFailed(true);
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [api, projectId, onBoardPage]);

  const stages = board
    ? board.stages
        .map((stage, index) => ({ stage, index }))
        .sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || a.index - b.index)
        .map(({ stage }) => ({
          stage,
          cards: board.cards.filter(
            (card) => card.stageId === stage.id && card.archivedAt === undefined,
          ),
        }))
        .filter((group) => group.cards.length > 0)
    : [];

  return (
    <div className="project-sessions" id={tasksId(projectId)}>
      <div className="thread-branch">
        <div className="thread-branch-row">
          <span className="thread-branch-spacer" />
          <Link
            aria-current={onBoardPage ? "page" : undefined}
            className={`thread-link board-navigation-board${onBoardPage ? " active" : ""}`}
            onClick={onNavigate}
            to={boardPath(projectId)}
          >
            <span className="thread-link-title">
              <KanbanIcon />
              <span className="thread-link-title-text">{t("Доска")}</span>
            </span>
          </Link>
        </div>
      </div>
      {stages.map(({ stage, cards }) => {
        // Published tasks stay closed until opened, like their column on the board.
        const expanded = (stage.role !== "done") !== toggled.has(stage.id);
        const listId = `board-navigation-${projectId}-${stage.id}`;
        return (
          <div className="board-navigation-stage" key={stage.id}>
            <div className="project-title">
              <button
                aria-controls={listId}
                aria-expanded={expanded}
                className="project-toggle"
                type="button"
                onClick={() =>
                  setToggled((current) => {
                    const next = new Set(current);
                    if (!next.delete(stage.id)) next.add(stage.id);
                    return next;
                  })
                }
              >
                {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                <span>{stageLabel(stage, t)}</span>
                <span className="board-navigation-count">{cards.length}</span>
              </button>
            </div>
            <div className="board-navigation-tasks" id={listId} hidden={!expanded}>
              {cards.map((card) => {
                const latest = latestRun(board!, card.id);
                const session =
                  latest?.threadId && latest.provider === application.provider
                    ? sessions.get(latest.threadId)
                    : undefined;
                // To do has no agent at work yet, so no marker, as on the board.
                const marker =
                  stage.role === "todo" ? null : cardStatusClass(card, latest, session);
                const active = Boolean(
                  openThreadId &&
                  board!.runs.some(
                    (run) => run.threadId === openThreadId && run.cardIds.includes(card.id),
                  ),
                );
                const content = (
                  <>
                    <span className="thread-link-title">
                      <span className="thread-link-title-text">
                        {card.title || t("Голосовая задача")}
                      </span>
                    </span>
                    {marker && <span className={`status ${marker}`} />}
                  </>
                );
                const ownThread =
                  latest?.provider === application.provider ? latest.threadId : null;
                return (
                  <div className="thread-branch" key={card.id}>
                    <div className="thread-branch-row">
                      <span className="thread-branch-spacer" />
                      {!ownThread && latest?.sessionUrl ? (
                        // The other application's session opens there, as on the board.
                        <a className="thread-link" href={latest.sessionUrl}>
                          {content}
                        </a>
                      ) : (
                        // A task without a session yet opens as a card on the board.
                        <Link
                          aria-current={active ? "page" : undefined}
                          className={`thread-link${active ? " active" : ""}`}
                          onClick={onNavigate}
                          to={
                            ownThread
                              ? `/threads/${encodeURIComponent(ownThread)}`
                              : `${boardPath(projectId)}?card=${encodeURIComponent(card.id)}`
                          }
                        >
                          {content}
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {board && !stages.length && <div className="project-empty">{t("Задач пока нет")}</div>}
      {!board && failed && <div className="project-empty">{t("Не удалось загрузить задачи")}</div>}
    </div>
  );
}
