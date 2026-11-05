import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, matchPath, useLocation } from "react-router";
import type { KanbanBoard, KanbanStage, ThreadSummary } from "@codexnest/protocol";
import { application } from "../application";
import { useConnection } from "../connection";
import { useI18n } from "../i18n";
import { ChevronDownIcon, ChevronRightIcon, KanbanIcon } from "./Icons";
import { cardStatusClass, latestRun, stageLabel } from "./KanbanBoard";
import { SidebarList } from "./SidebarList";

/** A board shown by the board page, passed on so the navigation needs no requests of its own. */
export type ShownBoard = { projectId: string; board: KanbanBoard };
export type BoardStageExpansion = Record<string, Record<string, boolean>>;

const REFRESH_MS = 4_000;
/** Answers and running agents come first, the other stages keep the board's order. */
const stageRank = (stage: KanbanStage) =>
  stage.role === "waiting" ? 0 : stage.role === "working" ? 1 : 2;
const boardPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/kanban`;
/** The toggle key of the group of sessions that are not tasks, beside the stages' ids. */
const SESSIONS = "sessions";

/** The project's sessions that are not board tasks, as the navigation lists them. */
export type ProjectSessions = { count: number; list: ReactNode };

/**
 * An open project in the navigation: its board, its tasks by stage, each opening its session,
 * then its other sessions.
 */
export function ProjectBoard({
  projectId,
  threads,
  shownBoard,
  renderSessions,
  stageExpansion,
  listResetKey,
  onToggleStage,
  onNavigate,
}: {
  projectId: string;
  /** Sessions of this application; they colour the markers like on the board. */
  threads: ThreadSummary[];
  shownBoard: ShownBoard | null;
  stageExpansion: Record<string, boolean> | undefined;
  listResetKey: number;
  onToggleStage(projectId: string, stageId: string, expanded: boolean): void;
  /** The project's sessions without the given task sessions. */
  renderSessions(taskThreadIds: ReadonlySet<string>): ProjectSessions;
  onNavigate(): void;
}) {
  const sessions = useMemo(
    () =>
      new Map(threads.filter((thread) => !thread.archived).map((thread) => [thread.id, thread])),
    [threads],
  );
  const { api } = useConnection();
  const { t } = useI18n();
  const location = useLocation();
  const [fetched, setFetched] = useState<KanbanBoard | null>(null);
  const [failed, setFailed] = useState(false);
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

  // Every session of a task still on the board is listed under its stage.
  const taskThreadIds = useMemo(() => {
    if (!board) return null;
    const cards = new Set(
      board.cards.filter((card) => card.archivedAt === undefined).map((card) => card.id),
    );
    return new Set(
      board.runs.flatMap((run) =>
        run.threadId &&
        run.provider === application.provider &&
        run.cardIds.some((id) => cards.has(id))
          ? [run.threadId]
          : [],
      ),
    );
  }, [board]);
  // Until the board is read its tasks are not told from the other sessions; without it all are.
  const other = taskThreadIds
    ? renderSessions(taskThreadIds)
    : failed
      ? renderSessions(new Set())
      : null;
  const sessionsExpanded = stageExpansion?.[SESSIONS] ?? true;
  const sessionsId = `board-navigation-${projectId}-sessions`;

  return (
    <>
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
        // Explicit choices survive project folds, mode switches and reloads, even if a
        // stage becomes empty or changes role. Published tasks start closed.
        const expanded = stageExpansion?.[stage.id] ?? stage.role !== "done";
        const listId = `board-navigation-${projectId}-${stage.id}`;
        return (
          <div className="board-navigation-stage" key={stage.id}>
            <div className="project-title">
              <button
                aria-controls={listId}
                aria-expanded={expanded}
                className="project-toggle"
                type="button"
                onClick={() => onToggleStage(projectId, stage.id, !expanded)}
              >
                {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                <span>{stageLabel(stage, t)}</span>
                <span className="board-navigation-count">{cards.length}</span>
              </button>
            </div>
            <div className="board-navigation-tasks" id={listId} hidden={!expanded}>
              <SidebarList resetKey={listResetKey}>
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
              </SidebarList>
            </div>
          </div>
        );
      })}
      {other && other.count > 0 && (
        <div className="board-navigation-stage">
          <div className="project-title">
            <button
              aria-controls={sessionsId}
              aria-expanded={sessionsExpanded}
              className="project-toggle"
              type="button"
              onClick={() => onToggleStage(projectId, SESSIONS, !sessionsExpanded)}
            >
              {sessionsExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
              <span>{t("Сессии")}</span>
              <span className="board-navigation-count">{other.count}</span>
            </button>
          </div>
          <div className="board-navigation-tasks" id={sessionsId} hidden={!sessionsExpanded}>
            {other.list}
          </div>
        </div>
      )}
      {board && !stages.length && other?.count === 0 && (
        <div className="project-empty">{t("Пока нет задач")}</div>
      )}
      {!board && failed && <div className="project-empty">{t("Не удалось загрузить задачи")}</div>}
    </>
  );
}
