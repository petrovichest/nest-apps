import { useEffect, useMemo, useState } from "react";
import { Link, matchPath, useLocation, useNavigate } from "react-router";
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

/** Board mode of the navigation: one project's tasks by stage, each opening its session. */
export function BoardNavigation({
  projects,
  projectId,
  threads,
  shownBoard,
  onNavigate,
}: {
  projects: Project[];
  projectId: string;
  /** Sessions of this application; they colour the markers like on the board. */
  threads: ThreadSummary[];
  shownBoard: ShownBoard | null;
  onNavigate(): void;
}) {
  const { api } = useConnection();
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
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

  const sessions = useMemo(
    () =>
      new Map(threads.filter((thread) => !thread.archived).map((thread) => [thread.id, thread])),
    [threads],
  );
  const project = projects.find((item) => item.id === projectId);
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
    <div className="project-list board-navigation">
      <section className="project-group">
        <div className="project-title">
          <details
            className="board-navigation-project"
            data-dismiss-on-outside-click
            onKeyDown={(event) => {
              // Escape closes the menu only; it must not reach the open session and stop it.
              if (event.key !== "Escape" || !event.currentTarget.open) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }}
          >
            <summary
              className="project-toggle"
              aria-label={t("Проект доски: {{project}}", {
                project: project?.displayName ?? t("Проект не найден"),
              })}
            >
              <FolderIcon />
              <span>{project?.displayName ?? t("Проект не найден")}</span>
              <ChevronDownIcon />
            </summary>
            <div className="project-action-popover">
              {projects.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={item.id === projectId}
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    onNavigate();
                    navigate(boardPath(item.id));
                  }}
                >
                  <FolderIcon />
                  {item.displayName}
                </button>
              ))}
            </div>
          </details>
        </div>
        <div className="project-sessions">
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
        </div>
      </section>
      {stages.map(({ stage, cards }) => {
        // Published tasks stay closed until opened, like their column on the board.
        const expanded = (stage.role !== "done") !== toggled.has(stage.id);
        const listId = `board-navigation-${stage.id}`;
        return (
          <section className="project-group" key={stage.id}>
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
            <div className="project-sessions" id={listId} hidden={!expanded}>
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
                // A session of the other application, or none yet, opens the card on the board.
                const target =
                  latest?.threadId && latest.provider === application.provider
                    ? `/threads/${encodeURIComponent(latest.threadId)}`
                    : `${boardPath(projectId)}?card=${encodeURIComponent(card.id)}`;
                return (
                  <div className="thread-branch" key={card.id}>
                    <div className="thread-branch-row">
                      <span className="thread-branch-spacer" />
                      <Link
                        aria-current={active ? "page" : undefined}
                        className={`thread-link${active ? " active" : ""}`}
                        onClick={onNavigate}
                        to={target}
                      >
                        <span className="thread-link-title">
                          <span className="thread-link-title-text">
                            {card.title || t("Голосовая задача")}
                          </span>
                        </span>
                        {marker && <span className={`status ${marker}`} />}
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {board && !stages.length && <div className="active-session-empty">{t("Задач пока нет")}</div>}
      {!board && failed && (
        <div className="active-session-empty">{t("Не удалось загрузить задачи")}</div>
      )}
    </div>
  );
}
