import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type {
  KanbanAction,
  KanbanAudioInput,
  KanbanBoard as Board,
  KanbanCard,
  KanbanImageInput,
  KanbanProvider,
  KanbanRun,
  KanbanStage,
  Project,
  SessionSettings,
  ThreadSummary,
  TranscriptionConfigResponse,
  TranscriptionProvider,
} from "@codexnest/protocol";
import {
  copyPastedMessage,
  KANBAN_IMAGE_LIMIT,
  KANBAN_IMAGE_MAX_BYTES,
  rebasePastedText,
} from "@codexnest/protocol";
import { MessageImageGallery, MessageImageProvider } from "./MessageImageGallery";
import { onBeforeAppReload } from "../app-reload";
import { application } from "../application";
import { useConnection } from "../connection";
import { loadBoardTaskDraft, saveBoardTaskDraft, type BoardTaskDraft } from "../offline-store";
import { Composer, type ComposerImage, type ComposerRecording } from "./Composer";
import {
  applySessionSettingsPatch,
  clientSessionSettingsPatch,
  initialSessionSettings,
} from "./ThreadPage";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { threadMarkerClasses } from "../thread-status";
import { Dialog } from "./Dialog";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ImageIcon,
  KanbanIcon,
  MicrophoneIcon,
  MoreIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  RestartIcon,
  SendIcon,
  StopIcon,
  TrashIcon,
  XIcon,
} from "./Icons";
import { WorkspaceHeader } from "./WorkspaceHeader";
import {
  formatRecordingTime,
  microphoneUnavailableReason,
  recordingErrorMessage,
  recordingMimeType,
} from "./speech-input";
import "../kanban.css";

/** The task's agent is busy: its card stays where it is. */
const busyStatuses = new Set<KanbanRun["status"]>(["queued", "preparing", "running"]);
const uuid = () => globalThis.crypto.randomUUID();
const boardImage = ({ url }: ComposerImage) =>
  /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(url) &&
  ((url.length - url.indexOf(",") - 1) * 3) / 4 <= KANBAN_IMAGE_MAX_BYTES;

function runLabel(run: KanbanRun, t: Translate, session?: ThreadSummary): string {
  if (run.status === "waiting" && session?.state === "interrupted") return t("Прервана");
  if (run.status === "waiting") return t("Ждёт ответа");
  if (run.status === "failed") return t("Ошибка");
  if (run.status === "queued")
    return run.kind === "publish" ? t("В очереди на публикацию") : t("В очереди");
  if (run.status === "preparing") return t("Подготовка");
  if (run.status === "completed") return t("Завершено");
  return run.kind === "publish" ? t("Публикуется…") : t("В работе");
}

function stageLabel(stage: KanbanStage, t: Translate): string {
  // User-created names are content, not translation keys.
  const defaults: Record<string, string> = {
    todo: "К выполнению",
    working: "В работе",
    waiting: "Ждёт ответа",
    ready: "Готовые",
    done: "Опубликовано",
  };
  return stage.role && !stage.renamed ? t(defaults[stage.role]) : stage.name;
}

type LaneLayout = { widths: Record<string, number>; collapsed: Record<string, boolean> };

const LAYOUT_KEY = `${application.storagePrefix}.kanbanLayout`;
const LANE_MIN_WIDTH = 200;
const LANE_MAX_WIDTH = 640;
const clampLane = (value: number) =>
  Math.round(Math.min(LANE_MAX_WIDTH, Math.max(LANE_MIN_WIDTH, value)));

/** Column widths and collapsed columns belong to this device, not to the shared board. */
function readLayout(projectId: string): LaneLayout {
  try {
    const all = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Record<
      string,
      Partial<LaneLayout>
    >;
    return { widths: { ...all[projectId]?.widths }, collapsed: { ...all[projectId]?.collapsed } };
  } catch {
    return { widths: {}, collapsed: {} };
  }
}

function writeLayout(projectId: string, layout: LaneLayout) {
  try {
    const all = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Record<string, LaneLayout>;
    all[projectId] = layout;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(all));
  } catch {
    // Without storage the layout lasts until the page is reloaded.
  }
}

/**
 * The same markers as sessions in the navigation. A session of this application adds what the
 * board does not record: its live state, an interruption and whether its result was read.
 */
function runStatusClass(run: KanbanRun, session?: ThreadSummary): string | null {
  if (session) {
    if (
      session.queuedMessageCount > 0 ||
      ["running", "queued", "needsAttention", "interrupted", "failed"].includes(session.state)
    )
      return threadMarkerClasses(session);
    // A finished turn: the board outcome decides, the session tells whether it was read.
    if (run.status === "completed") return session.unread ? threadMarkerClasses(session) : null;
    if (run.status === "failed") return session.unread ? "status-failed" : "status-failed-read";
  }
  if (run.status === "running" || run.status === "preparing") return "status-running";
  if (run.status === "queued") return "status-queued";
  if (run.status === "waiting") return "status-needsAttention";
  if (run.status === "failed") return "status-failed";
  return null;
}

type DropRule = "reorder" | "move" | "execute" | "rework" | "publish";

const cardBusy = (board: Board, cardId: string) =>
  board.runs.some(
    (run) =>
      run.kind !== "classify" && busyStatuses.has(run.status) && run.cardIds.includes(cardId),
  );

const providerName = (provider: KanbanProvider) =>
  provider === "claude" ? "ClaudeNest" : "CodexNest";

/** A drop runs the same action as the button for that step; the app alone moves into Waiting. */
function dropRule(board: Board, card: KanbanCard, target: KanbanStage): DropRule | null {
  if (card.stageId === target.id) return "reorder";
  if (card.voice || cardBusy(board, card.id)) return null;
  const from = board.stages.find((stage) => stage.id === card.stageId)?.role ?? null;
  const started = board.runs.some(
    (run) => run.kind !== "classify" && run.cardIds.includes(card.id),
  );
  if (target.role === "working")
    return started ? "rework" : card.classification === "ready" ? "execute" : null;
  if (target.role === "waiting") return null;
  if (target.role === "ready") return from === "waiting" ? "move" : null;
  if (target.role === "done") return from === "ready" ? "publish" : null;
  return "move";
}

/** The card a dragged card would land before, from the pointer height inside a lane. */
function insertionPoint(lane: Element, clientY: number, draggedId: string): string | null {
  for (const element of lane.querySelectorAll<HTMLElement>(".kanban-card[data-card-id]")) {
    if (element.dataset.cardId === draggedId) continue;
    const rect = element.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return element.dataset.cardId!;
  }
  return null;
}

/** No agent has taken the task yet: it starts from its card or its panel. */
const launchable = (board: Board, card: KanbanCard) => {
  const role = board.stages.find((stage) => stage.id === card.stageId)?.role;
  return (
    card.archivedAt === undefined &&
    role !== "done" &&
    role !== "ready" &&
    role !== "waiting" &&
    !board.runs.some((run) => run.kind !== "classify" && run.cardIds.includes(card.id))
  );
};
/** A task in To do can also start together with others in one session. */
const selectable = (board: Board, card: KanbanCard) =>
  launchable(board, card) &&
  board.stages.find((stage) => stage.id === card.stageId)?.role === "todo";
/** Until a task is classified its start controls stay in place, disabled, so nothing shifts. */
const classified = (card: KanbanCard) => card.classification === "ready" && !card.voice;
const startable = (board: Board, card: KanbanCard) => classified(card) && selectable(board, card);

function latestRun(board: Board, cardId: string): KanbanRun | undefined {
  return board.runs
    .filter((run) => run.cardIds.includes(cardId) && run.kind !== "classify")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function KanbanBoard({
  projects,
  threads = [],
  transcriptionConfig = null,
  transcriptionProvider = null,
  onOpenNavigation,
}: {
  projects: Project[];
  /** Sessions of this application; they colour the markers of the tasks they run. */
  threads?: ThreadSummary[];
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onOpenNavigation(): void;
}) {
  const { projectId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const project = projects.find((item) => item.id === projectId);
  // A refreshed project list (after a reconnect) must not reset the open board.
  const hasProject = Boolean(project);
  const { api, state } = useConnection();
  const { t, language } = useI18n();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<"create" | "stage" | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [layout, setLayout] = useState<LaneLayout>(() => readLayout(projectId));
  const [mobileStageId, setMobileStageId] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reworkId, setReworkId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [editStageId, setEditStageId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "stage" | "card"; id: string } | null>(null);
  const [addingStage, setAddingStage] = useState(false);
  const [drag, setDrag] = useState<{ cardId: string; height: number } | null>(null);
  const [dropTarget, setDropTargetState] = useState<{
    stageId: string;
    beforeCardId: string | null;
  } | null>(null);
  const [stageDrag, setStageDrag] = useState<string | null>(null);
  const [headerRetry, setHeaderRetry] = useState<Recording | null>(null);
  const [stageDropId, setStageDropId] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState<BoardTaskDraft>(EMPTY_TASK_DRAFT);
  const taskDraftRef = useRef(taskDraft);
  const taskDraftSave = useRef<{ projectId: string; timer: number } | null>(null);
  const taskCreationId = useRef(uuid());
  const alive = useRef(true);
  const requestGeneration = useRef(0);
  const resize = useRef<{ id: string; x: number; width: number } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const panelTitle = useRef<HTMLHeadingElement>(null);
  const dropRef = useRef<{ stageId: string; beforeCardId: string | null } | null>(null);
  const lift = useRef<{
    cardId: string;
    timer: number;
    x: number;
    y: number;
    lifted: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const fineDrag = useRef(
    typeof window.matchMedia !== "function" || window.matchMedia("(pointer: fine)").matches,
  );
  const locale = useRef({ language, t });
  locale.current = { language, t };
  const threadParam = searchParams.get("thread");

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
    setCategory("");
    setBusy(false);
    setDialog(null);
    setMobileStageId(null);
    setArchiveOpen(false);
    setReworkId(null);
    setSelected(new Set());
    setEditStageId(null);
    setConfirm(null);
    setAddingStage(false);
    setLayout(readLayout(projectId));
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
    if (hasProject) void refresh();
    else setLoading(false);
    // Only the visible board refreshes. Session views add no board requests.
    const timer = window.setInterval(() => {
      if (hasProject) void refresh();
    }, 4_000);
    const onVisible = () => {
      if (hasProject) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [api, projectId, hasProject, receive, displayError]);

  /** The task field keeps its draft on this device, like a session's, until the task is sent. */
  const flushTaskDraft = useCallback(async () => {
    const pending = taskDraftSave.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    taskDraftSave.current = null;
    await saveBoardTaskDraft(api.settings, pending.projectId, taskDraftRef.current).catch(
      () => undefined,
    );
  }, [api]);
  useEffect(() => {
    let active = true;
    const empty = EMPTY_TASK_DRAFT;
    taskDraftRef.current = empty;
    taskCreationId.current = uuid();
    setTaskDraft(empty);
    void loadBoardTaskDraft(api.settings, projectId)
      .then((saved) => {
        // Text typed before the saved draft arrives wins.
        if (!active || !saved || taskDraftRef.current !== empty) return;
        taskDraftRef.current = saved;
        setTaskDraft(saved);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      void flushTaskDraft();
    };
  }, [api, projectId, flushTaskDraft]);
  useEffect(() => onBeforeAppReload(flushTaskDraft), [flushTaskDraft]);
  const models = state.snapshot?.models;
  const defaultReasoningEffort = state.snapshot?.defaultReasoningEffort;
  const taskDefaults = state.snapshot?.taskDefaults;
  const defaultTaskSettings = useMemo(
    () => initialSessionSettings(defaultReasoningEffort, models ?? [], taskDefaults),
    [defaultReasoningEffort, models, taskDefaults],
  );

  // A session's board link names the session; its card opens once the board arrives.
  useEffect(() => {
    if (!board || !threadParam) return;
    const run = board.runs.find((item) => item.threadId === threadParam);
    if (run?.cardIds[0]) setCardId(run.cardIds[0]);
    setSearchParams(
      (params) => {
        params.delete("thread");
        return params;
      },
      { replace: true },
    );
  }, [board, threadParam, setSearchParams]);

  useEffect(() => {
    if (cardId) panelTitle.current?.focus();
  }, [cardId]);

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
  const action = (value: KanbanAction, ids: string[]) =>
    mutate(() =>
      api.kanbanAction(projectId, { action: value, cardIds: ids, clientActionId: uuid() }),
    );
  // Selected tasks in column order; started or moved ones drop out of the selection.
  const together = board
    ? board.cards.filter((item) => selected.has(item.id) && startable(board, item))
    : [];
  const startTogether = async () => {
    if (
      await action(
        "execute",
        together.map((item) => item.id),
      )
    )
      setSelected(new Set());
  };
  const move = (id: string, stageId: string) =>
    mutate(() => api.updateKanbanCard(projectId, id, { stageId }));
  async function createTask(value: ComposerValue): Promise<boolean> {
    let audio: KanbanAudioInput | undefined;
    try {
      if (value.recording) audio = await audioInput(value.recording);
    } catch {
      setError(t("Не удалось прочитать запись"));
      return false;
    }
    return mutate(() =>
      api.createKanbanCard(projectId, {
        description: value.text,
        clientCreationId: value.id,
        ...(value.images.length ? { images: value.images } : {}),
        ...(audio ? { audio } : {}),
        ...(value.settings ? { settings: value.settings } : {}),
      }),
    );
  }
  function editTaskDraft(next: BoardTaskDraft) {
    taskDraftRef.current = next;
    taskCreationId.current = uuid();
    setTaskDraft(next);
    if (taskDraftSave.current) window.clearTimeout(taskDraftSave.current.timer);
    taskDraftSave.current = {
      projectId,
      timer: window.setTimeout(() => void flushTaskDraft(), 400),
    };
  }
  /** Sends the task field like a session's first message; a recording goes with it at once. */
  async function submitTask(recording?: ComposerRecording): Promise<boolean> {
    const draft = taskDraftRef.current;
    const ok = await createTask({
      id: recording ? `${taskCreationId.current}:${recording.id}` : taskCreationId.current,
      text: copyPastedMessage(draft.input.trim(), draft).trim(),
      images: draft.images.map(({ name, url }) => ({ name, url })),
      ...(recording ? { recording } : {}),
      ...(draft.settings ? { settings: draft.settings } : {}),
    });
    if (!ok) return false;
    // Text typed while the task was being sent stays for the next task.
    if (taskDraftRef.current === draft) {
      editTaskDraft(EMPTY_TASK_DRAFT);
      void flushTaskDraft();
      setDialog(null);
    }
    return true;
  }
  async function sendHeaderRecording(recording: Recording) {
    const ok = await createTask({ id: `voice:${recording.id}`, text: "", images: [], recording });
    setHeaderRetry(ok ? null : recording);
  }
  const setDropTarget = (value: { stageId: string; beforeCardId: string | null } | null) => {
    dropRef.current = value;
    setDropTargetState((current) =>
      current?.stageId === value?.stageId && current?.beforeCardId === value?.beforeCardId
        ? current
        : value,
    );
  };
  const endDrag = () => {
    setDrag(null);
    setDropTarget(null);
  };
  /** Same-stage drops reorder; other stages run the matching action or move. */
  async function dropCard(item: KanbanCard, stage: KanbanStage, beforeCardId: string | null) {
    const rule = dropRule(board!, item, stage);
    if (rule === "reorder") {
      const lane = board!.cards.filter(
        (value) => value.stageId === stage.id && value.archivedAt === undefined,
      );
      const next = lane[lane.indexOf(item) + 1]?.id ?? null;
      if (beforeCardId === item.id || beforeCardId === next) return;
      await mutate(() => api.updateKanbanCard(projectId, item.id, { beforeCardId }));
    } else if (rule === "move")
      await mutate(() =>
        api.updateKanbanCard(projectId, item.id, { stageId: stage.id, beforeCardId }),
      );
    // Dragging one of the selected tasks starts all of them in one session.
    else if (rule === "execute" && together.length > 1 && together.includes(item))
      await startTogether();
    else if (rule === "execute" || rule === "publish") await action(rule, [item.id]);
    else if (rule === "rework") {
      setArchiveOpen(false);
      setCardId(item.id);
      setReworkId(item.id);
    }
  }
  const moveStage = (stage: KanbanStage, direction: -1 | 1) => {
    const stages = board!.stages;
    const index = stages.indexOf(stage);
    const beforeStageId =
      direction < 0 ? (stages[index - 1]?.id ?? null) : (stages[index + 2]?.id ?? null);
    if (direction < 0 && index === 0) return;
    void mutate(() => api.updateKanbanStage(projectId, stage.id, { beforeStageId }));
  };
  const updateLayout = (change: (current: LaneLayout) => LaneLayout) => {
    const next = change(layout);
    setLayout(next);
    writeLayout(projectId, next);
  };
  const setLaneWidth = (id: string, width: number | null) =>
    updateLayout((current) => {
      const widths = { ...current.widths };
      if (width === null) delete widths[id];
      else widths[id] = clampLane(width);
      return { ...current, widths };
    });
  const setLaneCollapsed = (id: string, collapsed: boolean) =>
    updateLayout((current) => ({
      ...current,
      collapsed: { ...current.collapsed, [id]: collapsed },
    }));
  const openCard = (id: string, from: HTMLElement) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    opener.current = from;
    setArchiveOpen(false);
    setCardId(id);
  };
  const closeCard = useCallback(() => {
    setCardId(null);
    const target = opener.current;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  }, []);

  const card = board?.cards.find((item) => item.id === cardId) ?? null;
  const cardRuns = card
    ? board!.runs
        .filter((run) => run.cardIds.includes(card.id) && run.kind !== "classify")
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
  const cardWorking = cardRuns.some((run) => busyStatuses.has(run.status));
  const role = board?.stages.find((stage) => stage.id === card?.stageId)?.role;
  // Continuations and publications are turns of the same session: list each session once.
  const cardSessions = cardRuns.filter(
    (run, index) =>
      !run.threadId || cardRuns.findIndex((other) => other.threadId === run.threadId) === index,
  );
  const session = cardSessions[0];
  // Tasks started together share their session and move with it.
  const sessionPartners = session
    ? session.cardIds.flatMap((id) => {
        const item = board!.cards.find((value) => value.id === id);
        return item && item.id !== card!.id && item.archivedAt === undefined ? [item] : [];
      })
    : [];
  const editStage = board?.stages.find((stage) => stage.id === editStageId) ?? null;
  const archived = (board?.cards ?? [])
    .filter((item) => item.archivedAt !== undefined)
    .sort((a, b) => b.archivedAt! - a.archivedAt!);
  const confirmation = (() => {
    if (!board || !confirm) return null;
    if (confirm.kind === "stage") {
      const stage = board.stages.find((item) => item.id === confirm.id);
      if (!stage) return null;
      const count = board.cards.filter((item) => item.stageId === stage.id).length;
      return {
        title: t("Удалить стадию «{{name}}»?", { name: stageLabel(stage, t) }),
        text: count
          ? t("Задачи из неё ({{count}}) переедут в «К выполнению».", { count })
          : t("В стадии нет задач."),
        warning: null,
        label: t("Удалить стадию"),
        run: () => api.deleteKanbanStage(projectId, stage.id),
      };
    }
    const item = board.cards.find((value) => value.id === confirm.id);
    if (!item) return null;
    return {
      title: t("Удалить задачу навсегда?"),
      text: t("«{{title}}» исчезнет с доски, а её сессии в этом приложении уйдут в архив сессий.", {
        title: item.title,
      }),
      warning: null,
      label: t("Удалить навсегда"),
      run: () => api.deleteKanbanCard(projectId, item.id),
    };
  })();

  useEffect(() => {
    if ((!card && !archiveOpen) || dialog || confirm) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || busy) return;
      if ((event.target as Element | null)?.closest?.("details[open], input, textarea, select"))
        return;
      if (card) closeCard();
      else setArchiveOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [card, archiveOpen, dialog, confirm, busy, closeCard]);

  // Touch: a long press lifts a card; moving the finger reorders it within its stage.
  const touchState = useRef({ board, busy, dropCard });
  touchState.current = { board, busy, dropCard };
  useEffect(() => {
    const cancel = () => {
      const current = lift.current;
      lift.current = null;
      if (current) window.clearTimeout(current.timer);
      return current;
    };
    const onMove = (event: PointerEvent) => {
      const current = lift.current;
      if (!current) return;
      if (!current.lifted) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) cancel();
        return;
      }
      const lane = document
        .querySelector(`.kanban-card[data-card-id="${CSS.escape(current.cardId)}"]`)
        ?.closest<HTMLElement>(".kanban-lane");
      if (lane?.dataset.stageId)
        setDropTarget({
          stageId: lane.dataset.stageId,
          beforeCardId: insertionPoint(lane, event.clientY, current.cardId),
        });
    };
    const onUp = () => {
      const current = cancel();
      if (!current?.lifted) return;
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 400);
      const target = dropRef.current;
      const { board: latest, busy: locked, dropCard: drop } = touchState.current;
      endDrag();
      const item = latest?.cards.find((value) => value.id === current.cardId);
      const stage = latest?.stages.find((value) => value.id === item?.stageId);
      if (item && stage && target?.stageId === stage.id && !locked)
        void drop(item, stage, target.beforeCardId);
    };
    const onTouchMove = (event: TouchEvent) => {
      if (lift.current?.lifted) event.preventDefault();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      cancel();
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.removeEventListener("touchmove", onTouchMove);
    };
    // Listeners read the latest board through touchState; they are installed once.
  }, []);

  // Archived sessions no longer ask for attention, so their tasks keep the board's own state.
  const sessions = useMemo(
    () =>
      new Map(threads.filter((thread) => !thread.archived).map((thread) => [thread.id, thread])),
    [threads],
  );
  const sessionOf = (run: KanbanRun) =>
    run.threadId && run.provider === application.provider ? sessions.get(run.threadId) : undefined;

  const sessionLink = (run: KanbanRun, className: string, children: ReactNode) =>
    run.threadId && run.provider === application.provider ? (
      <Link className={className} to={`/threads/${encodeURIComponent(run.threadId)}`}>
        {children}
      </Link>
    ) : run.sessionUrl ? (
      <a className={className} href={run.sessionUrl}>
        {children}
      </a>
    ) : null;

  function renderCard(item: KanbanCard, stage: KanbanStage, lane: KanbanCard[]) {
    const latest = latestRun(board!, item.id);
    const session = latest && sessionOf(latest);
    const voice = item.voice;
    const statusClass = voice
      ? voice.status === "failed"
        ? "status-failed"
        : "status-queued"
      : latest
        ? runStatusClass(latest, session)
        : null;
    const imageCount = item.images?.length ?? (item.image ? 1 : 0);
    // The card's own start button is for To do; other stages start from the panel.
    const launch = selectable(board!, item);
    const categoryName = board!.categories.find((value) => value.id === item.categoryId)?.name;
    const meta: ReactNode[] = [];
    if (categoryName) meta.push(<span key="category">{categoryName}</span>);
    if (voice)
      meta.push(
        <span
          key="voice"
          className={voice.status === "failed" ? "kanban-card-state failed" : "working-text"}
        >
          {voice.status === "failed"
            ? t("Не удалось распознать запись")
            : voice.purpose === "rework"
              ? t("Распознаём комментарий…")
              : t("Распознаём запись…")}
        </span>,
      );
    else if (item.classification === "pending")
      meta.push(
        <span key="classification" className="working-text">
          {t("Определяем категорию…")}
        </span>,
      );
    if (item.classification === "failed")
      meta.push(
        <span key="classification" className="kanban-card-state failed">
          {t("Категория не определена")}
        </span>,
      );
    if (latest && statusClass && !voice && latest.status !== "completed")
      meta.push(
        <span key="state" className={`kanban-card-state ${latest.status}`}>
          {runLabel(latest, t, session)}
        </span>,
      );
    return (
      <article
        key={item.id}
        data-card-id={item.id}
        className={`kanban-card${statusClass ? " has-status" : ""}${drag?.cardId === item.id ? " dragging" : ""}`}
        draggable={!busy && fineDrag.current}
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-nest-kanban-card", item.id);
          event.dataTransfer.effectAllowed = "move";
          setDrag({ cardId: item.id, height: event.currentTarget.getBoundingClientRect().height });
        }}
        onDragEnd={endDrag}
        onPointerDown={(event) => {
          if (event.pointerType !== "touch" || busy) return;
          const element = event.currentTarget;
          window.clearTimeout(lift.current?.timer);
          lift.current = {
            cardId: item.id,
            x: event.clientX,
            y: event.clientY,
            lifted: false,
            timer: window.setTimeout(() => {
              if (lift.current?.cardId !== item.id) return;
              lift.current.lifted = true;
              setDrag({ cardId: item.id, height: element.getBoundingClientRect().height });
              navigator.vibrate?.(10);
            }, 450),
          };
        }}
        onContextMenu={(event) => {
          if (lift.current) event.preventDefault();
        }}
      >
        <div className="kanban-card-top">
          {selectable(board!, item) && (
            <input
              type="checkbox"
              className="kanban-card-select"
              aria-label={t("Выбрать задачу «{{title}}»", {
                title: item.title || t("Голосовая задача"),
              })}
              checked={selected.has(item.id)}
              disabled={busy || !classified(item)}
              onChange={(event) => {
                const checked = event.target.checked;
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked) next.add(item.id);
                  else next.delete(item.id);
                  return next;
                });
              }}
            />
          )}
          <button
            className="kanban-card-open"
            aria-expanded={cardId === item.id}
            onClick={(event) => openCard(item.id, event.currentTarget)}
            onKeyDown={(event) => {
              if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
              event.preventDefault();
              const index = lane.indexOf(item);
              if (event.key === "ArrowUp" && index > 0)
                void dropCard(item, stage, lane[index - 1]!.id);
              else if (event.key === "ArrowDown" && index < lane.length - 1)
                void dropCard(item, stage, lane[index + 2]?.id ?? null);
            }}
          >
            {item.title || t("Голосовая задача")}
          </button>
          {launch && (
            <button
              className="kanban-card-launch"
              aria-label={t("Запустить задачу «{{title}}»", {
                title: item.title || t("Голосовая задача"),
              })}
              disabled={busy || !classified(item)}
              onClick={() => void action("execute", [item.id])}
            >
              <PlayIcon />
            </button>
          )}
        </div>
        {item.description !== item.title && (
          <p className="kanban-card-excerpt">{item.description}</p>
        )}
        {(meta.length > 0 || imageCount > 0) && (
          <div className="kanban-card-meta">
            {meta.map((node, index) => (
              <Fragment key={index}>
                {index > 0 && (
                  <span className="kanban-card-separator" aria-hidden="true">
                    ·
                  </span>
                )}
                {node}
              </Fragment>
            ))}
            {imageCount > 0 && (
              <span
                className="kanban-card-images"
                role="img"
                aria-label={t("Изображений: {{count}}", { count: imageCount })}
              >
                <ImageIcon />
                {imageCount > 1 && imageCount}
              </span>
            )}
          </div>
        )}
        {item.question && <p className="kanban-card-question">{item.question}</p>}
        {item.error && (
          <p className="kanban-card-error">{localizeKnownServerText(language, item.error)}</p>
        )}
        {statusClass && <span className={`kanban-card-status ${statusClass}`} aria-hidden="true" />}
      </article>
    );
  }

  function renderLane(stage: KanbanStage, active: boolean) {
    const board_ = board!;
    const name = stageLabel(stage, t);
    const cards = board_.cards.filter(
      (item) =>
        item.stageId === stage.id &&
        item.archivedAt === undefined &&
        (!category || item.categoryId === category),
    );
    const collapsed = layout.collapsed[stage.id] ?? stage.role === "done";
    const dragged = drag ? board_.cards.find((item) => item.id === drag.cardId) : undefined;
    const rule = dragged ? dropRule(board_, dragged, stage) : null;
    const slot =
      drag && dropTarget?.stageId === stage.id ? (
        <div className="kanban-drop-slot" style={{ height: drag.height }} aria-hidden="true" />
      ) : null;
    const index = board_.stages.indexOf(stage);
    const width = layout.widths[stage.id];
    // Publishing everything that is ready runs one card after another on the server.
    const readyIds =
      stage.role === "ready"
        ? cards.filter((item) => !cardBusy(board_, item.id)).map((item) => item.id)
        : [];
    return (
      <section
        key={stage.id}
        id={`kanban-lane-${stage.id}`}
        className={`kanban-lane${collapsed ? " collapsed" : ""}${width ? " sized" : ""}${
          drag && !rule ? " drop-disabled" : ""
        }${stageDropId === stage.id ? " stage-drop" : ""}`}
        aria-label={name}
        data-stage-id={stage.id}
        data-active={active || undefined}
        style={width ? ({ "--kanban-lane-width": `${width}px` } as CSSProperties) : undefined}
        onDragOver={(event) => {
          if (busy) return;
          if (stageDrag) {
            if (stageDrag === stage.id) return;
            event.preventDefault();
            setStageDropId(stage.id);
            return;
          }
          if (!dragged || !rule) return;
          event.preventDefault();
          setDropTarget({
            stageId: stage.id,
            beforeCardId:
              rule === "reorder" || rule === "move"
                ? insertionPoint(event.currentTarget, event.clientY, dragged.id)
                : (cards.find((item) => item.id !== dragged.id)?.id ?? null),
          });
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          if (dropRef.current?.stageId === stage.id) setDropTarget(null);
          if (stageDropId === stage.id) setStageDropId(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (stageDrag) {
            const moving = stageDrag;
            setStageDrag(null);
            setStageDropId(null);
            if (moving !== stage.id)
              void mutate(() =>
                api.updateKanbanStage(projectId, moving, { beforeStageId: stage.id }),
              );
            return;
          }
          const target = dropRef.current;
          endDrag();
          if (busy || !dragged) return;
          void dropCard(dragged, stage, target?.stageId === stage.id ? target.beforeCardId : null);
        }}
      >
        {collapsed && (
          <button
            className="kanban-lane-strip"
            aria-expanded="false"
            aria-label={t("Развернуть стадию «{{name}}», задач: {{count}}", {
              name,
              count: cards.length,
            })}
            onClick={() => setLaneCollapsed(stage.id, false)}
          >
            <span className="kanban-lane-strip-name">{name}</span>
            <span className="kanban-lane-count">{cards.length}</span>
          </button>
        )}
        <header
          className="kanban-lane-head"
          draggable={!stage.role && !busy && fineDrag.current}
          onDragStart={(event) => {
            if (stage.role) return;
            event.dataTransfer.setData("application/x-nest-kanban-stage", stage.id);
            event.dataTransfer.effectAllowed = "move";
            setStageDrag(stage.id);
          }}
          onDragEnd={() => {
            setStageDrag(null);
            setStageDropId(null);
          }}
        >
          <h2>{name}</h2>
          <span className="kanban-lane-count">{cards.length}</span>
          <span className="kanban-lane-head-actions">
            <details className="thread-action-menu kanban-lane-menu" data-dismiss-on-outside-click>
              <summary
                className="icon-button"
                aria-label={t("Действия со стадией «{{name}}»", { name })}
              >
                <MoreIcon />
              </summary>
              <div className="action-menu-popover">
                <button
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    setEditStageId(stage.id);
                  }}
                >
                  <PencilIcon /> {t("Изменить")}
                </button>
                {!stage.role && index > 0 && (
                  <button
                    disabled={busy}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      moveStage(stage, -1);
                    }}
                  >
                    <ArrowLeftIcon /> {t("Сдвинуть влево")}
                  </button>
                )}
                {!stage.role && index < board_.stages.length - 1 && (
                  <button
                    disabled={busy}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      moveStage(stage, 1);
                    }}
                  >
                    <ArrowRightIcon /> {t("Сдвинуть вправо")}
                  </button>
                )}
                <button
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    setLaneCollapsed(stage.id, true);
                  }}
                >
                  <ChevronRightIcon /> {t("Свернуть")}
                </button>
                {!stage.role && (
                  <button
                    className="danger"
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      setConfirm({ kind: "stage", id: stage.id });
                    }}
                  >
                    <TrashIcon /> {t("Удалить")}
                  </button>
                )}
              </div>
            </details>
          </span>
        </header>
        {/* Column steps stay while the column has cards for them and only switch off,
            so ticking a task or starting a publication never moves the cards below. */}
        {stage.role === "todo" &&
          cards.filter((item) => selectable(board_, item)).length > 1 &&
          !collapsed && (
            <button
              className="kanban-lane-action"
              disabled={busy || together.length < 2}
              onClick={() => void startTogether()}
            >
              <PlayIcon />
              {together.length > 1
                ? t("Запустить вместе ({{count}})", { count: together.length })
                : t("Запустить вместе")}
            </button>
          )}
        {stage.role === "ready" && cards.length > 0 && !collapsed && (
          <button
            className="kanban-lane-action"
            disabled={busy || readyIds.length === 0}
            onClick={() => void action("publish", readyIds)}
          >
            <SendIcon />
            {t("Опубликовать все")}
          </button>
        )}
        {stage.description && <p className="kanban-lane-description">{stage.description}</p>}
        <div className="kanban-lane-cards">
          {cards.map((item) => (
            <Fragment key={item.id}>
              {slot && dropTarget?.beforeCardId === item.id && slot}
              {renderCard(item, stage, cards)}
            </Fragment>
          ))}
          {slot && dropTarget?.beforeCardId === null && slot}
          {stage.role === "todo" && !board_.cards.some((item) => item.archivedAt === undefined) && (
            <div className="kanban-empty">
              <p>{t("Здесь появятся задачи. Добавьте первую текстом, голосом или картинкой.")}</p>
              <button onClick={() => setDialog("create")}>
                <PlusIcon />
                {t("Добавить задачу")}
              </button>
            </div>
          )}
        </div>
        {!collapsed && (
          <div
            className="kanban-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("Ширина стадии «{{name}}»", { name })}
            aria-valuemin={LANE_MIN_WIDTH}
            aria-valuemax={LANE_MAX_WIDTH}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const lane = event.currentTarget.parentElement!;
              resize.current = {
                id: stage.id,
                x: event.clientX,
                width: lane.getBoundingClientRect().width,
              };
              event.currentTarget.setPointerCapture?.(event.pointerId);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              const drag = resize.current;
              if (drag) setLaneWidth(drag.id, drag.width + event.clientX - drag.x);
            }}
            onPointerUp={() => {
              resize.current = null;
            }}
            onPointerCancel={() => {
              resize.current = null;
            }}
            onDoubleClick={() => setLaneWidth(stage.id, null)}
            onKeyDown={(event) => {
              const current =
                width ?? event.currentTarget.parentElement!.getBoundingClientRect().width;
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setLaneWidth(stage.id, current + (event.key === "ArrowRight" ? 16 : -16));
              } else if (event.key === "Home") {
                event.preventDefault();
                setLaneWidth(stage.id, null);
              }
            }}
          />
        )}
      </section>
    );
  }

  const activeStageId =
    board?.stages.find((stage) => stage.id === mobileStageId)?.id ?? board?.stages[0]?.id;
  const categoryCount = board?.categories.length ?? 0;

  return (
    <div className={`thread-workspace kanban-workspace${card || archiveOpen ? " has-panel" : ""}`}>
      <section className="conversation-pane kanban-pane">
        <WorkspaceHeader
          title={t("Доска задач")}
          subtitle={project?.displayName ?? t("Проект не найден")}
          leadingIcon={<KanbanIcon />}
          onOpenNavigation={onOpenNavigation}
          actions={
            project ? (
              <>
                {categoryCount > 0 && (
                  <details
                    className="thread-action-menu kanban-category-filter"
                    data-dismiss-on-outside-click
                    onKeyDown={(event) => {
                      const menu = event.currentTarget;
                      if (event.key === "Escape" && menu.open) {
                        event.preventDefault();
                        menu.open = false;
                        menu.querySelector("summary")?.focus();
                      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                        event.preventDefault();
                        menu.open = true;
                        const options = [...menu.querySelectorAll("button")];
                        let next = options.indexOf(document.activeElement as HTMLButtonElement);
                        if (event.key === "Home") next = 0;
                        else if (event.key === "End") next = options.length - 1;
                        else if (next < 0)
                          next = event.key === "ArrowDown" ? 0 : options.length - 1;
                        else
                          next =
                            (next + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
                            options.length;
                        options[next]?.focus();
                      }
                    }}
                  >
                    <summary className="kanban-filter" aria-label={t("Категория")}>
                      <span>
                        {board?.categories.find((item) => item.id === category)?.name ??
                          t("Все категории")}
                      </span>
                      <ChevronDownIcon />
                    </summary>
                    <div
                      className="action-menu-popover kanban-category-options"
                      role="group"
                      aria-label={t("Категория")}
                    >
                      {[{ id: "", name: t("Все категории") }, ...(board?.categories ?? [])].map(
                        (item) => (
                          <button
                            key={item.id}
                            aria-pressed={category === item.id}
                            onClick={(event) => {
                              const menu = event.currentTarget.closest("details")!;
                              menu.open = false;
                              menu.querySelector("summary")?.focus();
                              setCategory(item.id);
                            }}
                          >
                            <CheckIcon aria-hidden="true" />
                            <span>{item.name}</span>
                          </button>
                        ),
                      )}
                    </div>
                  </details>
                )}
                <button
                  className="icon-button kanban-archive-button"
                  aria-label={t("Архив")}
                  aria-pressed={archiveOpen}
                  onClick={() => {
                    setCardId(null);
                    setArchiveOpen((open) => !open);
                  }}
                >
                  <ArchiveIcon />
                </button>
                <details
                  className="thread-action-menu kanban-filter-menu"
                  data-dismiss-on-outside-click
                >
                  <summary className="icon-button" aria-label={t("Ещё")}>
                    <MoreIcon />
                  </summary>
                  <div className="action-menu-popover">
                    {categoryCount > 0 &&
                      [{ id: "", name: t("Все категории") }, ...(board?.categories ?? [])].map(
                        (item) => (
                          <button
                            key={item.id}
                            aria-pressed={category === item.id}
                            onClick={(event) => {
                              event.currentTarget.closest("details")?.removeAttribute("open");
                              setCategory(item.id);
                            }}
                          >
                            {category === item.id ? <CheckIcon /> : <span aria-hidden="true" />}
                            {item.name}
                          </button>
                        ),
                      )}
                    <button
                      aria-pressed={archiveOpen}
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        setCardId(null);
                        setArchiveOpen(true);
                      }}
                    >
                      <ArchiveIcon /> {t("Архив")}
                    </button>
                  </div>
                </details>
                <HeaderRecorder
                  config={transcriptionConfig}
                  busy={busy}
                  onRecorded={(recording) => void sendHeaderRecording(recording)}
                />
                <button
                  className="kanban-add-button"
                  aria-label={t("Добавить задачу")}
                  onClick={() => setDialog("create")}
                >
                  <PlusIcon />
                  <span>{t("Добавить задачу")}</span>
                </button>
              </>
            ) : undefined
          }
        />
        {!project ? (
          <div className="center-state">
            <p>{t("Проект не найден")}</p>
          </div>
        ) : loading && !board ? (
          <div className="center-state">
            <span className="spinner" />
            <p className="working-text">{t("Загружаем доску…")}</p>
          </div>
        ) : (
          <div
            className="kanban-scroll"
            onScroll={(event) =>
              event.currentTarget.toggleAttribute(
                "data-scrolled",
                event.currentTarget.scrollTop > 0,
              )
            }
          >
            <div className="kanban-board">
              {(error || headerRetry) && (
                <div className="kanban-error" role="alert">
                  <span>{headerRetry ? (error ?? t("Запись не отправлена.")) : error}</span>
                  {headerRetry ? (
                    <span className="kanban-error-actions">
                      <button disabled={busy} onClick={() => void sendHeaderRecording(headerRetry)}>
                        <RefreshIcon />
                        {t("Отправить запись ещё раз")}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          setHeaderRetry(null);
                          setError(null);
                        }}
                      >
                        {t("Удалить запись")}
                      </button>
                    </span>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => void mutate(() => api.readKanban(projectId))}
                    >
                      <RefreshIcon />
                      {t("Повторить")}
                    </button>
                  )}
                </div>
              )}
              {board && (
                <>
                  <div className="kanban-stage-bar">
                    <div
                      className="kanban-stage-tabs"
                      role="tablist"
                      aria-label={t("Стадии задач")}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                        const index = board.stages.findIndex((stage) => stage.id === activeStageId);
                        const next =
                          board.stages[
                            (index + (event.key === "ArrowRight" ? 1 : -1) + board.stages.length) %
                              board.stages.length
                          ];
                        if (!next) return;
                        event.preventDefault();
                        setMobileStageId(next.id);
                        document.getElementById(`kanban-tab-${next.id}`)?.focus();
                      }}
                    >
                      {board.stages.map((stage) => (
                        <button
                          key={stage.id}
                          id={`kanban-tab-${stage.id}`}
                          role="tab"
                          aria-selected={stage.id === activeStageId}
                          aria-controls={`kanban-lane-${stage.id}`}
                          tabIndex={stage.id === activeStageId ? 0 : -1}
                          onClick={() => setMobileStageId(stage.id)}
                        >
                          {stageLabel(stage, t)}
                          <span className="kanban-lane-count">
                            {
                              board.cards.filter(
                                (item) =>
                                  item.stageId === stage.id &&
                                  item.archivedAt === undefined &&
                                  (!category || item.categoryId === category),
                              ).length
                            }
                          </span>
                        </button>
                      ))}
                    </div>
                    <button
                      className="icon-button"
                      aria-label={t("Добавить стадию")}
                      disabled={busy}
                      onClick={() => setDialog("stage")}
                    >
                      <PlusIcon />
                    </button>
                  </div>
                  <div className="kanban-lanes">
                    {board.stages.map((stage) => renderLane(stage, stage.id === activeStageId))}
                    {addingStage ? (
                      <form
                        className="kanban-new-stage"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const name = new FormData(event.currentTarget).get("name");
                          if (typeof name === "string" && name.trim())
                            void mutate(() =>
                              api.createKanbanStage(projectId, { name: name.trim() }),
                            ).then((ok) => ok && setAddingStage(false));
                        }}
                      >
                        <input
                          name="name"
                          aria-label={t("Название стадии")}
                          placeholder={t("Название стадии")}
                          maxLength={100}
                          autoFocus
                          disabled={busy}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setAddingStage(false);
                            }
                          }}
                          onBlur={(event) => {
                            if (!event.currentTarget.value.trim()) setAddingStage(false);
                          }}
                        />
                      </form>
                    ) : (
                      <button
                        className="kanban-add-stage"
                        aria-label={t("Добавить стадию")}
                        disabled={busy}
                        onClick={() => setAddingStage(true)}
                        onDragOver={(event) => {
                          if (stageDrag) event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const moving = stageDrag;
                          setStageDrag(null);
                          setStageDropId(null);
                          if (moving)
                            void mutate(() =>
                              api.updateKanbanStage(projectId, moving, { beforeStageId: null }),
                            );
                        }}
                      >
                        <PlusIcon />
                        {t("Стадия")}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </section>
      {card && board && (
        <>
          <aside
            className="session-inspector open kanban-panel"
            aria-labelledby="kanban-card-title"
          >
            <div className="inspector-heading">
              <strong>{t("Задача")}</strong>
              <span className="kanban-panel-heading-actions">
                <details
                  className="thread-action-menu kanban-panel-menu"
                  data-dismiss-on-outside-click
                >
                  <summary className="icon-button" aria-label={t("Действия с задачей")}>
                    <MoreIcon />
                  </summary>
                  <div className="action-menu-popover">
                    {session && role !== "done" && card.archivedAt === undefined && (
                      <button
                        disabled={
                          busy ||
                          Boolean(card.voice) ||
                          (cardWorking && session.provider !== application.provider)
                        }
                        onClick={(event) => {
                          event.currentTarget.closest("details")?.removeAttribute("open");
                          void action("restart", [card.id]);
                        }}
                      >
                        <RestartIcon /> {t("Начать заново")}
                      </button>
                    )}
                    <button
                      disabled={busy || cardWorking}
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        void mutate(() =>
                          api.updateKanbanCard(projectId, card.id, { archived: true }),
                        ).then((ok) => ok && closeCard());
                      }}
                    >
                      <ArchiveIcon /> {t("В архив")}
                    </button>
                    {cardWorking && (
                      <p className="kanban-menu-note">
                        {t("Остановите агента в сессии, чтобы убрать задачу в архив")}
                      </p>
                    )}
                  </div>
                </details>
                <button
                  className="icon-button"
                  aria-label={t("Закрыть")}
                  onClick={closeCard}
                  disabled={busy}
                >
                  <XIcon />
                </button>
              </span>
            </div>
            <div className="kanban-panel-body">
              <h2 id="kanban-card-title" ref={panelTitle} tabIndex={-1}>
                <EditableText
                  key={`title-${card.id}`}
                  value={card.title}
                  label={t("Название")}
                  busy={busy}
                  onSave={(title) =>
                    mutate(() => api.updateKanbanCard(projectId, card.id, { title }))
                  }
                />
              </h2>
              <EditableText
                key={`description-${card.id}`}
                className="kanban-panel-description"
                multiline
                value={card.description}
                empty={card.description === card.title}
                placeholder={t("Дописать задачу")}
                label={t("Описание")}
                busy={busy}
                onSave={(description) =>
                  mutate(() => api.updateKanbanCard(projectId, card.id, { description }))
                }
              />
              {Boolean(card.images?.length || card.image) && (
                <CardImages key={`${projectId}:${card.id}`} projectId={projectId} card={card} />
              )}
              {card.voice?.status === "transcribing" && (
                <p className="working-text" role="status">
                  {card.voice.purpose === "rework"
                    ? t("Распознаём комментарий для доработки…")
                    : t("Распознаём запись…")}
                </p>
              )}
              {card.voice?.status === "failed" && (
                <p className="kanban-card-error" role="alert">
                  {t("Не удалось распознать запись")}
                  {card.voice.error ? `: ${card.voice.error}` : ""}
                </p>
              )}
              <div className="kanban-panel-fields">
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
              {card.question && <p className="kanban-card-question">{card.question}</p>}
              {card.error && (
                <p className="kanban-card-error" role="alert">
                  {localizeKnownServerText(language, card.error)}
                </p>
              )}
              {error && (
                <p className="kanban-card-error" role="alert">
                  {error}
                </p>
              )}
              <div className="kanban-panel-actions">
                {card.voice?.status === "failed" && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void action("retry-transcription", [card.id])}
                  >
                    <RefreshIcon />
                    {t("Повторить распознавание")}
                  </button>
                )}
                {card.classification === "failed" && !card.voice && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void action("retry-classification", [card.id])}
                  >
                    <RefreshIcon />
                    {t("Повторить категоризацию")}
                  </button>
                )}
                {classified(card) && launchable(board, card) && (
                  <button
                    className="kanban-launch"
                    disabled={busy}
                    onClick={() => void action("execute", [card.id])}
                  >
                    <PlayIcon />
                    {t("Запустить агента")}
                  </button>
                )}
                {role === "ready" && session && (
                  <button
                    className="primary"
                    disabled={busy || cardWorking}
                    onClick={() => void action("publish", [card.id])}
                  >
                    <SendIcon />
                    {t("Опубликовать")}
                  </button>
                )}
                {session &&
                  role !== "todo" &&
                  sessionLink(
                    session,
                    // In Ready, publishing is the main step and the session sits beside it.
                    role === "ready" ? "kanban-panel-link" : "kanban-panel-link primary",
                    <>
                      <ArrowRightIcon />
                      {role === "waiting" ? t("Ответить") : t("Открыть сессию")}
                    </>,
                  )}
                {session && role !== "working" && card.archivedAt === undefined && (
                  <button
                    disabled={busy || cardWorking || Boolean(card.voice)}
                    aria-expanded={reworkId === card.id}
                    onClick={() => setReworkId(reworkId === card.id ? null : card.id)}
                  >
                    {t("На доработку")}
                  </button>
                )}
              </div>
              {reworkId === card.id && !card.voice && (
                <section className="kanban-panel-section">
                  <h3>{t("Комментарий для доработки")}</h3>
                  <TaskComposer
                    key={card.id}
                    label={t("Комментарий для доработки")}
                    placeholder={t("Что исправить? Можно надиктовать и приложить картинки")}
                    submitLabel={t("Отправить на доработку")}
                    busy={busy}
                    error={error}
                    config={transcriptionConfig}
                    onSubmit={async (value) => {
                      let audio: KanbanAudioInput | undefined;
                      try {
                        if (value.recording) audio = await audioInput(value.recording);
                      } catch {
                        setError(t("Не удалось прочитать запись"));
                        return false;
                      }
                      const ok = await mutate(() =>
                        api.kanbanAction(projectId, {
                          action: "rework",
                          cardIds: [card.id],
                          clientActionId: value.id,
                          ...(value.text ? { comment: value.text } : {}),
                          ...(value.images.length ? { images: value.images } : {}),
                          ...(audio ? { audio } : {}),
                        }),
                      );
                      if (ok) setReworkId(null);
                      return ok;
                    }}
                  />
                </section>
              )}
              {sessionPartners.length > 0 && (
                <section className="kanban-panel-section">
                  <h3>{t("В той же сессии")}</h3>
                  <ul className="kanban-session-list">
                    {sessionPartners.map((item) => (
                      <li key={item.id}>
                        <button className="kanban-session" onClick={() => setCardId(item.id)}>
                          <span className="kanban-session-text">
                            <span>{item.title || t("Голосовая задача")}</span>
                            <small>
                              {stageLabel(
                                board.stages.find((value) => value.id === item.stageId)!,
                                t,
                              )}
                            </small>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {cardSessions.length > 0 && (
                <section className="kanban-panel-section">
                  <h3>{t("Сессии задачи")}</h3>
                  <ul className="kanban-session-list">
                    {cardSessions.map((run) => {
                      const content = (
                        <>
                          <span
                            className={`kanban-session-status ${runStatusClass(run, sessionOf(run)) ?? ""}`}
                            aria-hidden="true"
                          />
                          <span className="kanban-session-text">
                            <span>
                              {run.kind === "publish" ? t("Публикация") : t("Выполнение")}
                            </span>
                            <small>
                              {providerName(run.provider)} · {runLabel(run, t, sessionOf(run))}
                            </small>
                          </span>
                        </>
                      );
                      return (
                        <li key={run.id}>
                          <div className="kanban-session-row">
                            {sessionLink(run, "kanban-session", content) ?? (
                              <div className="kanban-session">
                                {content}
                                <small className="kanban-muted">
                                  {t("Ожидает запуска приложения")}
                                </small>
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </div>
          </aside>
          <button
            className="inspector-backdrop"
            aria-label={t("Закрыть задачу")}
            onClick={closeCard}
            disabled={busy}
          />
        </>
      )}
      {!card && archiveOpen && board && (
        <>
          <aside
            className="session-inspector open kanban-panel"
            aria-labelledby="kanban-archive-title"
          >
            <div className="inspector-heading">
              <strong id="kanban-archive-title">{t("Архив")}</strong>
              <button
                className="icon-button"
                aria-label={t("Закрыть")}
                onClick={() => setArchiveOpen(false)}
              >
                <XIcon />
              </button>
            </div>
            <div className="kanban-panel-body">
              {error && (
                <p className="kanban-card-error" role="alert">
                  {error}
                </p>
              )}
              {archived.length === 0 ? (
                <p className="kanban-muted">
                  {t("В архиве пока пусто. Опубликованные задачи попадают сюда через неделю.")}
                </p>
              ) : (
                <ul className="kanban-archive-list">
                  {archived.map((item) => {
                    const stage = board.stages.find((value) => value.id === item.stageId);
                    return (
                      <li key={item.id}>
                        <span className="kanban-archive-title">{item.title}</span>
                        <small>
                          {stage ? stageLabel(stage, t) : ""} ·{" "}
                          {new Intl.DateTimeFormat(language, {
                            day: "numeric",
                            month: "long",
                          }).format(item.archivedAt)}
                        </small>
                        <span className="kanban-archive-actions">
                          <button
                            disabled={busy}
                            onClick={() =>
                              void mutate(() =>
                                api.updateKanbanCard(projectId, item.id, { archived: false }),
                              )
                            }
                          >
                            <RefreshIcon /> {t("Вернуть")}
                          </button>
                          <button
                            className="danger"
                            disabled={busy}
                            onClick={() => setConfirm({ kind: "card", id: item.id })}
                          >
                            <TrashIcon /> {t("Удалить навсегда")}
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>
          <button
            className="inspector-backdrop"
            aria-label={t("Закрыть архив")}
            onClick={() => setArchiveOpen(false)}
          />
        </>
      )}
      {confirmation && (
        <Dialog
          titleId="kanban-confirm-title"
          className="kanban-confirm-dialog"
          closeOnBackdrop={!busy}
          closeOnEscape={!busy}
          onClose={() => setConfirm(null)}
        >
          <div className="dialog-header">
            <h2 id="kanban-confirm-title">{confirmation.title}</h2>
          </div>
          <p>{confirmation.text}</p>
          {confirmation.warning && <p className="kanban-card-error">{confirmation.warning}</p>}
          {error && (
            <p className="kanban-card-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
              {t("Отмена")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void mutate(confirmation.run).then((ok) => ok && setConfirm(null))}
            >
              {busy ? t("Удаляем…") : confirmation.label}
            </button>
          </div>
        </Dialog>
      )}
      {editStage && (
        <StageDialog
          key={editStage.id}
          error={error}
          busy={busy}
          title={t("Изменить стадию")}
          submitLabel={t("Сохранить")}
          initialName={stageLabel(editStage, t)}
          initialDescription={editStage.description}
          onClose={() => setEditStageId(null)}
          onSubmit={async (name, description) => {
            const patch = {
              ...(name !== stageLabel(editStage, t) ? { name } : {}),
              description,
            };
            if (await mutate(() => api.updateKanbanStage(projectId, editStage.id, patch)))
              setEditStageId(null);
          }}
        />
      )}
      {dialog === "create" && (
        <Dialog
          titleId="kanban-create-title"
          className="chat-dialog kanban-text-dialog kanban-task-dialog"
          closeOnBackdrop={!busy}
          closeOnEscape={!busy}
          onClose={() => setDialog(null)}
        >
          <div className="dialog-header">
            <h2 id="kanban-create-title">{t("Добавить задачу")}</h2>
            <button
              className="icon-button"
              aria-label={t("Закрыть")}
              disabled={busy}
              onClick={() => setDialog(null)}
            >
              <XIcon />
            </button>
          </div>
          <Composer
            autoFocus
            sessionIdentity={`board-task:${projectId}`}
            input={taskDraft.input}
            pastes={taskDraft}
            onInput={(input, pastes) => {
              const current = taskDraftRef.current;
              const next = pastes ?? rebasePastedText(current.input, input, current);
              editTaskDraft({
                ...current,
                input,
                inlinePastes: next.inlinePastes,
                pasteBlocks: next.pasteBlocks,
              });
            }}
            onDraftFlush={() => void flushTaskDraft()}
            images={taskDraft.images as ComposerImage[]}
            onImagesChange={(images) => {
              // The board keeps the formats and sizes its server stores.
              const accepted = images.filter(boardImage);
              if (accepted.length < images.length)
                setError(t("Выберите изображение PNG, JPEG, GIF или WebP до 10 МБ"));
              else if (accepted.length > KANBAN_IMAGE_LIMIT)
                setError(
                  t("Можно прикрепить до {{count}} изображений", { count: KANBAN_IMAGE_LIMIT }),
                );
              editTaskDraft({
                ...taskDraftRef.current,
                images: accepted.slice(0, KANBAN_IMAGE_LIMIT),
              });
            }}
            onSubmit={() => void submitTask()}
            busy={busy}
            settings={taskDraft.settings ?? defaultTaskSettings}
            onSettingsChange={(patch) => {
              const current = taskDraftRef.current;
              editTaskDraft({
                ...current,
                settings: applySessionSettingsPatch(
                  current.settings ?? defaultTaskSettings,
                  clientSessionSettingsPatch(patch),
                ),
              });
            }}
            models={models ?? []}
            cwd={project?.path ?? null}
            transcriptionConfig={transcriptionConfig}
            transcriptionProvider={transcriptionProvider}
            onRecordingReady={async (recording) => {
              if (!(await submitTask(recording)))
                throw new Error(t("Не удалось отправить запись на сервер"));
            }}
            error={error}
          />
        </Dialog>
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
    </div>
  );
}

function EditableText({
  value,
  label,
  busy,
  multiline = false,
  empty = false,
  placeholder,
  className,
  onSave,
}: {
  value: string;
  label: string;
  busy: boolean;
  multiline?: boolean;
  empty?: boolean;
  placeholder?: string;
  className?: string;
  onSave(value: string): Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null)
    return (
      <button
        className={`kanban-editable${empty ? " empty" : ""}${className ? ` ${className}` : ""}`}
        disabled={busy}
        // A short task shows its text as the title: the editor starts from it to add more.
        onClick={() => setDraft(value)}
      >
        {empty ? placeholder : value}
      </button>
    );
  const finish = async (save: boolean) => {
    const next = draft.trim();
    if (!save || !next || next === value) {
      setDraft(null);
      return;
    }
    if (await onSave(next)) setDraft(null);
  };
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(null);
    } else if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void finish(true);
    }
  };
  return multiline ? (
    <textarea
      className={`kanban-edit-field${className ? ` ${className}` : ""}`}
      aria-label={label}
      value={draft}
      rows={6}
      maxLength={100_000}
      autoFocus
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={keys}
    />
  ) : (
    <input
      className="kanban-edit-field"
      aria-label={label}
      value={draft}
      maxLength={300}
      autoFocus
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={keys}
    />
  );
}

function StageDialog({
  busy,
  error,
  title,
  submitLabel,
  initialName = "",
  initialDescription = "",
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  title?: string;
  submitLabel?: string;
  initialName?: string;
  initialDescription?: string;
  onClose(): void;
  onSubmit(name: string, description: string): Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
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
          <h2 id={id}>{title ?? t("Добавить стадию")}</h2>
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
            {busy ? t("Сохраняем…") : (submitLabel ?? t("Добавить"))}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CardImages({ projectId, card }: { projectId: string; card: KanbanCard }) {
  const { api } = useConnection();
  const { t } = useI18n();
  const count = card.images?.length ?? (card.image ? 1 : 0);
  const [images, setImages] = useState<KanbanImageInput[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void Promise.all(
      Array.from({ length: count }, (_, index) => api.readKanbanImage(projectId, card.id, index)),
    ).then(
      (value) => {
        if (active) setImages(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api, projectId, card.id, count, attempt]);
  if (failed)
    return (
      <button onClick={() => setAttempt((value) => value + 1)}>
        {t("Не удалось загрузить изображение. Повторить")}
      </button>
    );
  if (!images) return <p role="status">{t("Загружаем изображение…")}</p>;
  return (
    <MessageImageProvider text="" images={images.map((image) => image.url)}>
      <MessageImageGallery />
      <p className="kanban-muted">{images.map((image) => image.name).join(", ")}</p>
    </MessageImageProvider>
  );
}

type Recording = { id: string; audio: Blob; durationMs: number };
type ComposerValue = {
  id: string;
  text: string;
  images: KanbanImageInput[];
  recording?: Recording;
  settings?: SessionSettings;
};
const EMPTY_TASK_DRAFT: BoardTaskDraft = { input: "", images: [] };

/** The board's recorder: the Composer's MIME choice, limits and microphone errors. */
function useRecorder(
  config: TranscriptionConfigResponse | null,
  onRecorded: (recording: Recording) => void,
) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "requesting" | "recording">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const discarded = useRef(false);
  const alive = useRef(true);
  const timers = useRef<{ tick?: number; limit?: number }>({});
  const latest = useRef({ onRecorded, t });
  latest.current = { onRecorded, t };
  const unavailable = microphoneUnavailableReason(config, config?.provider ?? null, true, t);
  const release = () => {
    window.clearInterval(timers.current.tick);
    window.clearTimeout(timers.current.limit);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      discarded.current = true;
      if (recorder.current?.state === "recording") recorder.current.stop();
      release();
    };
  }, []);
  async function start() {
    if (state !== "idle" || unavailable) return;
    discarded.current = false;
    setError(null);
    setState("requesting");
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
        if (!event.data.size) return;
        chunks.push(event.data);
        bytes += event.data.size;
        if (bytes >= (config?.maxUploadBytes ?? 24 * 1024 * 1024) && media.state === "recording")
          media.stop();
      });
      media.addEventListener("error", () => {
        discarded.current = true;
        release();
        if (!alive.current) return;
        setError(latest.current.t("Не удалось записать аудио"));
        setState("idle");
      });
      media.addEventListener("stop", () => {
        release();
        recorder.current = null;
        if (!alive.current) return;
        setState("idle");
        if (discarded.current) return;
        const audio = new Blob(chunks, { type: mimeType });
        if (!audio.size) {
          setError(latest.current.t("Не удалось записать аудио"));
          return;
        }
        latest.current.onRecorded({
          id: uuid(),
          audio,
          durationMs: Math.max(1, Date.now() - started),
        });
      });
      media.start(1000);
      setSeconds(0);
      setState("recording");
      timers.current.tick = window.setInterval(() => {
        if (alive.current) setSeconds(Math.floor((Date.now() - started) / 1000));
      }, 250);
      timers.current.limit = window.setTimeout(
        () => {
          if (media.state === "recording") media.stop();
        },
        (config?.maxRecordingSeconds ?? 300) * 1000,
      );
    } catch (caught) {
      release();
      if (!alive.current) return;
      setError(recordingErrorMessage(caught, t));
      setState("idle");
    }
  }
  const stop = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  };
  const cancel = () => {
    discarded.current = true;
    stop();
  };
  return { state, seconds, error, unavailable, start, stop, cancel };
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

/**
 * One field for text, pictures and a recording. Stopping the recording sends the task
 * at once with the typed text and pictures; the server transcribes it afterwards.
 */
function TaskComposer({
  label,
  placeholder,
  submitLabel,
  busy,
  error,
  config,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  config: TranscriptionConfigResponse | null;
  onSubmit(value: ComposerValue): Promise<boolean>;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [images, setImages] = useState<KanbanImageInput[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [reading, setReading] = useState(0);
  const [failedRecording, setFailedRecording] = useState<Recording | null>(null);
  const identity = useRef(uuid());
  const fileInput = useRef<HTMLInputElement>(null);
  const changed = () => {
    identity.current = uuid();
  };
  async function submit(recording?: Recording) {
    if (busy || reading || (!recording && !text.trim())) return;
    const ok = await onSubmit({
      id: recording ? `${identity.current}:${recording.id}` : identity.current,
      text: text.trim(),
      images,
      ...(recording ? { recording } : {}),
    });
    if (ok) {
      setText("");
      setImages([]);
      setFailedRecording(null);
      changed();
    } else if (recording) setFailedRecording(recording);
  }
  const recorder = useRecorder(config, (recording) => void submit(recording));
  const recording = recorder.state === "recording";
  function attach(files: File[]) {
    setImageError(null);
    for (const file of files) {
      if (!IMAGE_TYPES.test(file.type) || !file.size || file.size > KANBAN_IMAGE_MAX_BYTES) {
        setImageError(t("Выберите изображение PNG, JPEG, GIF или WebP до 10 МБ"));
        continue;
      }
      setReading((value) => value + 1);
      const reader = new FileReader();
      reader.onload = () => {
        setReading((value) => value - 1);
        if (typeof reader.result !== "string") return;
        const url = reader.result;
        setImages((current) => {
          if (current.length >= KANBAN_IMAGE_LIMIT) {
            setImageError(
              t("Можно прикрепить до {{count}} изображений", { count: KANBAN_IMAGE_LIMIT }),
            );
            return current;
          }
          return [...current, { name: file.name || "image", url }];
        });
        changed();
      };
      reader.onerror = () => {
        setReading((value) => value - 1);
        setImageError(t("Не удалось прочитать изображение"));
      };
      reader.readAsDataURL(file);
    }
  }
  return (
    <div
      className={`kanban-composer${recording ? " recording" : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        attach(Array.from(event.dataTransfer.files));
      }}
    >
      {images.length > 0 && (
        <div className="kanban-composer-images">
          {images.map((image, index) => (
            <span className="kanban-composer-image" key={`${image.name}-${index}`}>
              <img src={image.url} alt={image.name} />
              <button
                type="button"
                className="icon-button"
                disabled={busy}
                aria-label={t("Удалить изображение {{name}}", { name: image.name })}
                onClick={() => {
                  setImages((current) => current.filter((_, position) => position !== index));
                  setImageError(null);
                  changed();
                }}
              >
                <XIcon />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        className="kanban-composer-field"
        aria-label={label}
        placeholder={placeholder}
        value={text}
        rows={3}
        maxLength={100_000}
        autoFocus
        disabled={busy}
        onChange={(event) => {
          setText(event.target.value);
          changed();
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.type.startsWith("image/"))
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          if (!files.length) return;
          event.preventDefault();
          attach(files);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="kanban-composer-actions">
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp"
          aria-label={t("Прикрепить изображение")}
          hidden
          disabled={busy}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            attach(files);
          }}
        />
        <button
          type="button"
          className="icon-button"
          disabled={busy || recording}
          onClick={() => fileInput.current?.click()}
        >
          <ImageIcon />
          <span className="sr-only">{t("Прикрепить изображение")}</span>
        </button>
        <span className="kanban-composer-status kanban-muted" role="status">
          {recording
            ? t("Запись {{time}}", { time: formatRecordingTime(recorder.seconds) })
            : recorder.state === "requesting"
              ? t("Запрашиваем доступ к микрофону")
              : busy
                ? t("Отправляем…")
                : reading
                  ? t("Загружаем изображение…")
                  : ""}
        </span>
        {recording && (
          <button
            type="button"
            className="icon-button"
            aria-label={t("Отменить запись")}
            onClick={recorder.cancel}
          >
            <XIcon />
          </button>
        )}
        <button
          type="button"
          className={`composer-action microphone${recording ? " recording timing" : ""}`}
          aria-label={
            recording
              ? t("Остановить запись и отправить")
              : (recorder.unavailable ?? t("Начать запись"))
          }
          aria-pressed={recording}
          disabled={
            busy ||
            reading > 0 ||
            recorder.state === "requesting" ||
            (!recording && Boolean(recorder.unavailable))
          }
          onClick={() => (recording ? recorder.stop() : void recorder.start())}
        >
          {recording ? (
            <>
              <span className="composer-action-timer">{recorder.seconds}</span>
              <StopIcon />
            </>
          ) : recorder.state === "requesting" ? (
            <span className="spinner small" />
          ) : (
            <MicrophoneIcon />
          )}
        </button>
        <button
          type="button"
          className="icon-button primary"
          aria-label={submitLabel}
          disabled={busy || reading > 0 || recording || !text.trim()}
          onClick={() => void submit()}
        >
          {busy ? <span className="spinner small" /> : <SendIcon />}
        </button>
      </div>
      {failedRecording && !busy && (
        <div className="kanban-composer-retry" role="alert">
          <span>{t("Запись не отправлена.")}</span>
          <button type="button" onClick={() => void submit(failedRecording)}>
            {t("Отправить запись ещё раз")}
          </button>
          <button type="button" onClick={() => setFailedRecording(null)}>
            {t("Удалить запись")}
          </button>
        </div>
      )}
      {(imageError || recorder.error) && (
        <p className="kanban-card-error" role="alert">
          {imageError ?? recorder.error}
        </p>
      )}
      {error && (
        <p className="kanban-card-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The header microphone records a task without opening a dialog. */
function HeaderRecorder({
  config,
  busy,
  onRecorded,
}: {
  config: TranscriptionConfigResponse | null;
  busy: boolean;
  onRecorded(recording: Recording): void;
}) {
  const { t } = useI18n();
  const recorder = useRecorder(config, onRecorded);
  const recording = recorder.state === "recording";
  if (recorder.unavailable && !recording) return null;
  return (
    <>
      {recording && (
        <button
          className="icon-button kanban-header-cancel"
          aria-label={t("Отменить запись")}
          onClick={recorder.cancel}
        >
          <XIcon />
        </button>
      )}
      <button
        className={`composer-action microphone kanban-header-microphone${
          recording ? " recording timing" : ""
        }`}
        aria-label={recording ? t("Остановить запись и создать задачу") : t("Надиктовать задачу")}
        aria-pressed={recording}
        disabled={busy || recorder.state === "requesting"}
        onClick={() => (recording ? recorder.stop() : void recorder.start())}
      >
        {recording ? (
          <>
            <span className="composer-action-timer">{formatRecordingTime(recorder.seconds)}</span>
            <StopIcon />
          </>
        ) : recorder.state === "requesting" || busy ? (
          <span className="spinner small" />
        ) : (
          <MicrophoneIcon />
        )}
      </button>
      {recorder.error && (
        <span className="sr-only" role="alert">
          {recorder.error}
        </span>
      )}
    </>
  );
}

async function blobBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the recording"));
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

async function audioInput(recording: Recording): Promise<KanbanAudioInput> {
  return {
    mediaType: recording.audio.type || "audio/webm",
    data: await blobBase64(recording.audio),
    durationMs: recording.durationMs,
  };
}
