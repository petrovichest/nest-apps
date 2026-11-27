import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
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
  WorkerProfile,
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
import { initialSessionSettings } from "./ThreadPage";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { threadMarkerClasses } from "../thread-status";
import { Dialog, keepTabFocus } from "./Dialog";
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
  SearchIcon,
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

export function stageLabel(stage: KanbanStage, t: Translate): string {
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
const OVERLAY_PANEL_QUERY = "(max-width: 1279px)";

function subscribePanelLayout(onChange: () => void) {
  const media = window.matchMedia?.(OVERLAY_PANEL_QUERY);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

function overlayPanelLayout() {
  return window.matchMedia?.(OVERLAY_PANEL_QUERY).matches ?? false;
}

function restorePanelFocus(...candidates: (HTMLElement | null)[]) {
  requestAnimationFrame(() => {
    candidates.find((element) => element?.getClientRects().length)?.focus();
  });
}
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
export function runStatusClass(run: KanbanRun, session?: ThreadSummary): string | null {
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
  provider === "open"
    ? "OpenNest"
    : provider === "gemini"
      ? "GeminiNest"
      : provider === "claude"
        ? "ClaudeNest"
        : "CodexNest";

/** A drop runs the same action as the button for that step; the app alone moves into Waiting. */
function dropRule(board: Board, card: KanbanCard, target: KanbanStage): DropRule | null {
  if (card.stageId === target.id) return "reorder";
  if (card.voice || cardBusy(board, card.id)) return null;
  const from = board.stages.find((stage) => stage.id === card.stageId)?.role ?? null;
  const started = board.runs.some(
    (run) => run.kind !== "classify" && run.cardIds.includes(card.id),
  );
  if (target.role === "working")
    return started && from !== "todo"
      ? "rework"
      : card.classification === "ready"
        ? "execute"
        : null;
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

/** New tasks and tasks returned to To do start a fresh session in this application. */
const launchable = (board: Board, card: KanbanCard) => {
  const role = board.stages.find((stage) => stage.id === card.stageId)?.role;
  return (
    card.archivedAt === undefined &&
    !cardBusy(board, card.id) &&
    role !== "done" &&
    role !== "ready" &&
    role !== "waiting" &&
    (role === "todo" ||
      !board.runs.some((run) => run.kind !== "classify" && run.cardIds.includes(card.id)))
  );
};
/** A task in To do can also start together with others in one session. */
const selectable = (board: Board, card: KanbanCard) =>
  launchable(board, card) &&
  board.stages.find((stage) => stage.id === card.stageId)?.role === "todo";
/** Until a task is classified its start controls stay in place, disabled, so nothing shifts. */
const classified = (card: KanbanCard) => card.classification === "ready" && !card.voice;
const startable = (board: Board, card: KanbanCard) => classified(card) && selectable(board, card);

export function latestRun(board: Board, cardId: string): KanbanRun | undefined {
  for (let index = board.runs.length - 1; index >= 0; index--) {
    const run = board.runs[index]!;
    if (run.kind !== "classify" && run.cardIds.includes(cardId)) return run;
  }
  return undefined;
}

/** A card's marker colour: a recording being transcribed, else its newest session's state. */
export function cardStatusClass(
  card: KanbanCard,
  latest: KanbanRun | undefined,
  session?: ThreadSummary,
): string | null {
  if (card.voice) return card.voice.status === "failed" ? "status-failed" : "status-queued";
  return latest ? runStatusClass(latest, session) : null;
}

type KanbanBoardProps = {
  projects: Project[];
  /** Sessions of this application; they colour the markers of the tasks they run. */
  threads?: ThreadSummary[];
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onOpenNavigation(): void;
};

export function KanbanBoard(props: KanbanBoardProps) {
  const { projectId = "" } = useParams();
  // Route changes dispose the previous board's requests, draft and recorder together.
  return <ProjectKanbanBoard key={projectId} projectId={projectId} {...props} />;
}

function ProjectKanbanBoard({
  projectId,
  projects,
  threads = [],
  transcriptionConfig = null,
  transcriptionProvider = null,
  onOpenNavigation,
}: KanbanBoardProps & { projectId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const project = projects.find((item) => item.id === projectId);
  // A refreshed project list (after a reconnect) must not reset the open board.
  const hasProject = Boolean(project);
  const { api, state } = useConnection();
  const { t, language } = useI18n();
  const [board, setBoard] = useState<Board | null>(null);
  const [actionError, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const refreshBoard = useRef<(() => Promise<void>) | null>(null);
  const boardScroll = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<"create" | "stage" | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [layout, setLayout] = useState<LaneLayout>(() => readLayout(projectId));
  const [mobileStageId, setMobileStageId] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reworkId, setReworkId] = useState<string | null>(null);
  const [appendId, setAppendId] = useState<string | null>(null);
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
  const [pendingRecordings, setPendingRecordings] = useState(0);
  const changePendingRecordings: PendingRecordingChange = useCallback((delta) => {
    setPendingRecordings((count) => count + delta);
  }, []);
  const [stageDropId, setStageDropId] = useState<string | null>(null);
  const [projectWorkers, setProjectWorkers] = useState<WorkerProfile[]>();
  const workerRequest = useRef<Promise<boolean> | null>(null);
  const [taskDraft, setTaskDraft] = useState<BoardTaskDraft>(EMPTY_TASK_DRAFT);
  const loadWorkers = useCallback(() => {
    if (workerRequest.current) return workerRequest.current;
    const request = api
      .workerCatalogue([projectId])
      .then(
        (catalogue) => {
          setProjectWorkers(
            catalogue.projects.find((project) => project.projectId === projectId)?.workers ?? [],
          );
          return true;
        },
        () => false,
      )
      .finally(() => {
        workerRequest.current = null;
      });
    workerRequest.current = request;
    return request;
  }, [api, projectId]);

  const assignedWorkerId =
    dialog === "create"
      ? taskDraft.workerId
      : board?.cards.find((item) => item.id === cardId)?.workerId;
  useEffect(() => {
    if (assignedWorkerId && !projectWorkers) void loadWorkers();
  }, [assignedWorkerId, projectWorkers, loadWorkers]);

  const taskDraftRef = useRef(taskDraft);
  const taskDraftSave = useRef<{ projectId: string; timer: number } | null>(null);
  const taskCreationId = useRef(uuid());
  const alive = useRef(true);
  const requestGeneration = useRef(0);
  const resize = useRef<{ id: string; x: number; width: number } | null>(null);
  const cardOpener = useRef<HTMLElement | null>(null);
  const archiveOpener = useRef<HTMLElement | null>(null);
  const archiveButton = useRef<HTMLButtonElement>(null);
  const compactActions = useRef<HTMLElement>(null);
  const addTaskButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelTitle = useRef<HTMLHeadingElement>(null);
  const archiveTitle = useRef<HTMLElement>(null);
  const overlayPanel = useSyncExternalStore(subscribePanelLayout, overlayPanelLayout);
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
  const cardParam = searchParams.get("card");

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
    setLoadError(null);
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
          setLoadError(null);
        }
      } catch (caught) {
        if (alive.current && requestGeneration.current === generation)
          setLoadError(displayError(caught));
      } finally {
        inFlight = false;
        if (alive.current && requestGeneration.current === generation) setLoading(false);
      }
    }
    refreshBoard.current = hasProject ? refresh : null;
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
      refreshBoard.current = null;
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

  // A session's board link names the session, the navigation names the card; it opens once
  // the board arrives.
  useEffect(() => {
    if (!board || (!threadParam && !cardParam)) return;
    const runs = threadParam
      ? board.runs.filter((run) => run.threadId === threadParam).reverse()
      : [];
    const run = runs.find((item) => item.provider === application.provider) ?? runs[0];
    const activeCard = run?.cardIds.find((id) => {
      const item = board.cards.find((candidate) => candidate.id === id);
      const current = latestRun(board, id);
      return (
        item &&
        item.archivedAt === undefined &&
        current?.provider === run.provider &&
        current.threadId === run.threadId
      );
    });
    const id = board.cards.some((item) => item.id === cardParam)
      ? cardParam
      : (activeCard ?? run?.cardIds[0]);
    if (id) {
      cardOpener.current = null;
      setArchiveOpen(false);
      setCardId(id);
    }
    setSearchParams(
      (params) => {
        params.delete("thread");
        params.delete("card");
        return params;
      },
      { replace: true },
    );
  }, [board, threadParam, cardParam, setSearchParams]);

  async function mutate(operation: () => Promise<Board>): Promise<boolean> {
    if (!alive.current || busy) return false;
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
  // Selected tasks in column order; running or moved ones drop out of the selection.
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
        ...(value.workerId ? { workerId: value.workerId } : {}),
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
    const workerId = draft.workerId;
    const ok = await createTask({
      id: recording ? `${taskCreationId.current}:${recording.id}` : taskCreationId.current,
      text: copyPastedMessage(draft.input.trim(), draft).trim(),
      images: draft.images.map(({ name, url }) => ({ name, url })),
      ...(recording ? { recording } : {}),
      ...(workerId ? { workerId } : {}),
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
    changePendingRecordings(1);
    try {
      const ok = await createTask({ id: `voice:${recording.id}`, text: "", images: [], recording });
      setHeaderRetry(ok ? null : recording);
    } finally {
      changePendingRecordings(-1);
    }
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
    cardOpener.current = from;
    setArchiveOpen(false);
    setCardId(id);
  };
  const closeCard = useCallback(() => {
    setCardId(null);
    const targetCard =
      cardId &&
      Array.from(boardScroll.current?.querySelectorAll<HTMLElement>("[data-card-id]") ?? []).find(
        (element) => element.dataset.cardId === cardId,
      );
    const cardTarget =
      targetCard &&
      targetCard.querySelector<HTMLElement>(".kanban-card-edit, button.kanban-card-open");
    restorePanelFocus(cardOpener.current, cardTarget || null, addTaskButton.current);
  }, [cardId]);
  const openArchive = (from: HTMLElement | null) => {
    archiveOpener.current = from;
    setCardId(null);
    setArchiveOpen(true);
  };
  const closeArchive = useCallback(() => {
    setArchiveOpen(false);
    restorePanelFocus(archiveOpener.current, archiveButton.current, compactActions.current);
  }, []);

  const card = board?.cards.find((item) => item.id === cardId) ?? null;
  const archiveVisible = !card && archiveOpen && board !== null;
  const panelOpen = card !== null || archiveVisible;
  const modalPanel = panelOpen && overlayPanel;
  const openCardId = card?.id;

  useLayoutEffect(() => {
    if (openCardId) panelTitle.current?.focus();
    else if (archiveVisible) archiveTitle.current?.focus();
  }, [openCardId, archiveVisible]);

  useLayoutEffect(() => {
    const surface = panel.current;
    if (!modalPanel || !surface) return;
    if (!surface.contains(document.activeElement))
      (panelTitle.current ?? archiveTitle.current)?.focus();
    const content = surface.closest(".content");
    if (!content?.parentElement) return;
    // The app navigation and notices are outside the workspace. Portalled dialogs stay available.
    const workspace = surface.closest(".kanban-workspace");
    const background = [...content.parentElement.children, ...content.children].filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement &&
        element !== content &&
        element !== workspace &&
        !element.inert,
    );
    background.forEach((element) => (element.inert = true));
    return () => background.forEach((element) => (element.inert = false));
  }, [modalPanel]);

  const cardRuns = card
    ? board!.runs
        .filter((run) => run.cardIds.includes(card.id) && run.kind !== "classify")
        .reverse()
    : [];
  const cardWorking = cardRuns.some((run) => busyStatuses.has(run.status));
  const role = board?.stages.find((stage) => stage.id === card?.stageId)?.role;
  // Continuations and publications are turns of the same session: list each session once.
  const cardSessions = cardRuns.filter(
    (run, index) =>
      !run.threadId ||
      cardRuns.findIndex(
        (other) => other.provider === run.provider && other.threadId === run.threadId,
      ) === index,
  );
  const session = cardSessions[0];
  // Tasks started together share their session and move with it.
  const sessionPartners = session
    ? session.cardIds.flatMap((id) => {
        const item = board!.cards.find((value) => value.id === id);
        if (!item || id === card!.id || item.archivedAt !== undefined) return [];
        const current = latestRun(board!, id);
        return current &&
          (current.id === session.id ||
            (session.threadId &&
              current.provider === session.provider &&
              current.threadId === session.threadId))
          ? [item]
          : [];
      })
    : [];
  const editStage = board?.stages.find((stage) => stage.id === editStageId) ?? null;
  const archived = (board?.cards ?? [])
    .filter((item) => item.archivedAt !== undefined)
    .sort((a, b) => b.archivedAt! - a.archivedAt!);
  const busyArchiveIds = new Set(
    archiveVisible
      ? board!.runs.flatMap((run) => (busyStatuses.has(run.status) ? run.cardIds : []))
      : [],
  );
  const deletionBlockedReason = t("Дождитесь завершения работы с задачей, чтобы удалить её.");
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
        blocked: false,
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
      blocked: busyArchiveIds.has(item.id),
      label: t("Удалить навсегда"),
      run: () => api.deleteKanbanCard(projectId, item.id),
    };
  })();

  useEffect(() => {
    if (!panelOpen || dialog || confirm || editStage) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as Element | null;
      if (target?.closest?.('[role="dialog"]') && !panel.current?.contains(target)) return;
      if (event.key === "Tab" && modalPanel && panel.current) keepTabFocus(event, panel.current);
      if (event.key !== "Escape" || busy) return;
      if (target?.closest?.("details[open], input, textarea, select")) return;
      if (openCardId) closeCard();
      else closeArchive();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    panelOpen,
    modalPanel,
    openCardId,
    dialog,
    confirm,
    editStage,
    busy,
    closeCard,
    closeArchive,
  ]);

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
    const onCancel = () => {
      if (cancel()?.lifted) endDrag();
    };
    const onTouchMove = (event: TouchEvent) => {
      if (lift.current?.lifted) event.preventDefault();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      cancel();
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
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
    const statusClass = cardStatusClass(item, latest, session);
    // To do has no agent at work yet: its cards carry no coloured marker, recognition is text.
    const marker = stage.role === "todo" ? null : statusClass;
    const imageCount = item.images?.length ?? (item.image ? 1 : 0);
    // The card's own start button is for To do; other stages start from the panel.
    const launch = selectable(board!, item);
    const title = item.title || t("Голосовая задача");
    const sessionHref = !latest?.threadId
      ? null
      : latest.provider === application.provider
        ? `/threads/${encodeURIComponent(latest.threadId)}`
        : latest.sessionUrl;
    const reorder = (event: React.KeyboardEvent<HTMLElement>) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const index = lane.indexOf(item);
      if (event.key === "ArrowUp" && index > 0) void dropCard(item, stage, lane[index - 1]!.id);
      else if (event.key === "ArrowDown" && index < lane.length - 1)
        void dropCard(item, stage, lane[index + 2]?.id ?? null);
    };
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
              : voice.purpose === "append"
                ? t("Распознаём дополнение…")
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
        className={`kanban-card${marker ? " has-status" : ""}${drag?.cardId === item.id ? " dragging" : ""}`}
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
          {sessionHref ? (
            // A task with a session opens it; the pencil beside the marker opens the task.
            <Link
              className="kanban-card-open"
              draggable={false}
              to={sessionHref}
              onClick={(event) => {
                if (!suppressClick.current) return;
                suppressClick.current = false;
                event.preventDefault();
              }}
              onKeyDown={reorder}
            >
              {title}
            </Link>
          ) : (
            <button
              className="kanban-card-open"
              aria-expanded={cardId === item.id}
              onClick={(event) => openCard(item.id, event.currentTarget)}
              onKeyDown={reorder}
            >
              {title}
            </button>
          )}
          {sessionHref && (
            <button
              className="icon-button kanban-card-edit"
              aria-expanded={cardId === item.id}
              aria-label={t("Изменить задачу «{{title}}»", { title })}
              onClick={(event) => openCard(item.id, event.currentTarget)}
            >
              <PencilIcon />
            </button>
          )}
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
        {marker && <span className={`kanban-card-status ${marker}`} aria-hidden="true" />}
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
            <details
              className="thread-action-menu kanban-lane-menu"
              data-dismiss-on-outside-click
              onKeyDown={handleMenuKey}
            >
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
        {stage.role === "todo" && cards.filter((item) => selectable(board_, item)).length > 1 && (
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
        {stage.role === "ready" && cards.length > 0 && (
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
  function selectMobileStage(id: string) {
    if (id === activeStageId) return;
    if (boardScroll.current) boardScroll.current.scrollTop = 0;
    setMobileStageId(id);
  }

  const categoryCount = board?.categories.length ?? 0;
  const projectName = project?.displayName ?? t("Проект не найден");
  const canSwitchProject = projects.length > (project ? 1 : 0);

  return (
    <div className={`thread-workspace kanban-workspace${panelOpen ? " has-panel" : ""}`}>
      <section className="conversation-pane kanban-pane" inert={modalPanel}>
        <WorkspaceHeader
          title={t("Доска задач")}
          subtitle={canSwitchProject ? undefined : projectName}
          titleAccessory={
            canSwitchProject ? (
              <BoardProjectPicker
                projects={projects}
                projectId={projectId}
                name={projectName}
                switchBlocked={pendingRecordings > 0 || headerRetry !== null}
              />
            ) : undefined
          }
          leadingIcon={<KanbanIcon />}
          onOpenNavigation={onOpenNavigation}
          actions={
            project ? (
              <>
                {categoryCount > 0 && (
                  <details
                    className="thread-action-menu kanban-category-filter"
                    data-dismiss-on-outside-click
                    onKeyDown={handleMenuKey}
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
                  ref={archiveButton}
                  className="icon-button kanban-archive-button"
                  aria-label={t("Архив")}
                  aria-pressed={archiveOpen}
                  onClick={(event) => {
                    if (archiveOpen) closeArchive();
                    else openArchive(event.currentTarget);
                  }}
                >
                  <ArchiveIcon />
                </button>
                <details
                  className="thread-action-menu kanban-filter-menu"
                  data-dismiss-on-outside-click
                  onKeyDown={handleMenuKey}
                >
                  <summary ref={compactActions} className="icon-button" aria-label={t("Ещё")}>
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
                              const menu = event.currentTarget.closest("details")!;
                              menu.open = false;
                              menu.querySelector("summary")?.focus();
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
                        openArchive(compactActions.current);
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
                  onPendingRecordingChange={changePendingRecordings}
                />
                <button
                  ref={addTaskButton}
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
            ref={boardScroll}
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
                  <div>
                    {headerRetry ? (actionError ?? t("Запись не отправлена.")) : error}
                    {!headerRetry && actionError && loadError && <div>{loadError}</div>}
                  </div>
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
                  ) : loadError ? (
                    <button disabled={busy} onClick={() => void refreshBoard.current?.()}>
                      <RefreshIcon />
                      {t("Повторить")}
                    </button>
                  ) : null}
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
                        document.getElementById(`kanban-tab-${next.id}`)?.focus();
                        selectMobileStage(next.id);
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
                          onClick={() => selectMobileStage(stage.id)}
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
          <div
            ref={panel}
            className="session-inspector open kanban-panel"
            role={modalPanel ? "dialog" : "complementary"}
            aria-modal={modalPanel || undefined}
            aria-labelledby="kanban-card-title"
            tabIndex={-1}
          >
            <div className="inspector-heading">
              <strong>{t("Задача")}</strong>
              <span className="kanban-panel-heading-actions">
                <details
                  className="thread-action-menu kanban-panel-menu"
                  data-dismiss-on-outside-click
                  onKeyDown={handleMenuKey}
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
              {/* A short task that no agent has taken is added to with the Add more button. */}
              {(card.description !== card.title || session || !launchable(board, card)) && (
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
              )}
              {Boolean(card.images?.length || card.image) && (
                <CardImages key={`${projectId}:${card.id}`} projectId={projectId} card={card} />
              )}
              {card.voice?.status === "transcribing" && (
                <p className="working-text" role="status">
                  {card.voice.purpose === "rework"
                    ? t("Распознаём комментарий для доработки…")
                    : card.voice.purpose === "append"
                      ? t("Распознаём дополнение…")
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
                    disabled={busy || cardWorking}
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
                <KanbanWorkerPicker
                  key={card.id}
                  value={card.workerId}
                  workers={projectWorkers}
                  loadWorkers={loadWorkers}
                  busy={busy || cardWorking}
                  onChange={(id) =>
                    void mutate(() =>
                      api.updateKanbanCard(projectId, card.id, { workerId: id || null }),
                    )
                  }
                />
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
                {launchable(board, card) && !session && (
                  <button
                    disabled={busy || Boolean(card.voice)}
                    aria-expanded={appendId === card.id}
                    onClick={() => setAppendId(appendId === card.id ? null : card.id)}
                  >
                    {t("Дописать")}
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
              {appendId === card.id && !card.voice && !session && launchable(board, card) && (
                <section className="kanban-panel-section">
                  <h3>{t("Дописать задачу")}</h3>
                  <TaskComposer
                    key={card.id}
                    label={t("Дополнение к задаче")}
                    placeholder={t("Что добавить? Можно надиктовать и приложить картинки")}
                    submitLabel={t("Добавить к задаче")}
                    busy={busy}
                    error={error}
                    config={transcriptionConfig}
                    onPendingRecordingChange={changePendingRecordings}
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
                          action: "append",
                          cardIds: [card.id],
                          clientActionId: value.id,
                          ...(value.text ? { comment: value.text } : {}),
                          ...(value.images.length ? { images: value.images } : {}),
                          ...(audio ? { audio } : {}),
                        }),
                      );
                      if (ok) setAppendId(null);
                      return ok;
                    }}
                  />
                </section>
              )}
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
                    onPendingRecordingChange={changePendingRecordings}
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
          </div>
          <button
            className="inspector-backdrop"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeCard}
            disabled={busy}
          />
        </>
      )}
      {archiveVisible && board && (
        <>
          <div
            ref={panel}
            className="session-inspector open kanban-panel"
            role={modalPanel ? "dialog" : "complementary"}
            aria-modal={modalPanel || undefined}
            aria-labelledby="kanban-archive-title"
            tabIndex={-1}
          >
            <div className="inspector-heading">
              <strong id="kanban-archive-title" ref={archiveTitle} tabIndex={-1}>
                {t("Архив")}
              </strong>
              <button className="icon-button" aria-label={t("Закрыть")} onClick={closeArchive}>
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
                    const blocked = busyArchiveIds.has(item.id);
                    const reasonId = `kanban-archive-busy-${item.id}`;
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
                            onClick={() => {
                              archiveTitle.current?.focus({ preventScroll: true });
                              void mutate(() =>
                                api.updateKanbanCard(projectId, item.id, { archived: false }),
                              );
                            }}
                          >
                            <RefreshIcon /> {t("Вернуть")}
                          </button>
                          <button
                            className="danger"
                            disabled={busy || blocked}
                            aria-describedby={blocked ? reasonId : undefined}
                            onClick={() => setConfirm({ kind: "card", id: item.id })}
                          >
                            <TrashIcon /> {t("Удалить навсегда")}
                          </button>
                        </span>
                        {blocked && <small id={reasonId}>{deletionBlockedReason}</small>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
          <button
            className="inspector-backdrop"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeArchive}
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
          {confirmation.blocked && <p className="kanban-muted">{deletionBlockedReason}</p>}
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
              disabled={busy || confirmation.blocked}
              onClick={() =>
                void mutate(confirmation.run).then((ok) => {
                  if (!ok) return;
                  setConfirm(null);
                  if (archiveVisible) restorePanelFocus(archiveTitle.current);
                })
              }
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
          backdropClassName="kanban-task-backdrop"
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
          <div className="kanban-panel-fields kanban-worker-picker">
            <KanbanWorkerPicker
              value={taskDraft.workerId}
              workers={projectWorkers}
              loadWorkers={loadWorkers}
              busy={busy}
              onChange={(id) =>
                editTaskDraft({ ...taskDraftRef.current, workerId: id || undefined })
              }
            />
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
            settings={defaultTaskSettings}
            hideSettings
            onSettingsChange={() => undefined}
            models={models ?? []}
            cwd={project?.path ?? null}
            transcriptionConfig={transcriptionConfig}
            transcriptionProvider={transcriptionProvider}
            onRecordingReady={async (recording) => {
              changePendingRecordings(1);
              try {
                if (!(await submitTask(recording)))
                  throw new Error(t("Не удалось отправить запись на сервер"));
              } finally {
                changePendingRecordings(-1);
              }
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

function handleMenuKey(event: ReactKeyboardEvent<HTMLDetailsElement>) {
  const menu = event.currentTarget;
  if (event.key === "Escape" && menu.open) {
    event.preventDefault();
    event.stopPropagation();
    menu.open = false;
    menu.querySelector("summary")?.focus({ preventScroll: true });
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  menu.open = true;
  const options = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const current = options.findIndex((option) => option === document.activeElement);
  let next = event.key === "ArrowUp" || event.key === "End" ? options.length - 1 : 0;
  if (current >= 0 && event.key.startsWith("Arrow")) {
    const direction = event.key === "ArrowDown" ? 1 : -1;
    next = (current + direction + options.length) % options.length;
  }
  options[next]?.focus();
}

function fitAssigneePopover(picker: HTMLDetailsElement, popover: HTMLDivElement) {
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportHeight = viewport?.height ?? window.innerHeight;
  const viewportBottom = viewportTop + viewportHeight;
  const gutter = 8;
  const scrollArea = picker.closest(".kanban-panel-body");
  if (!scrollArea) {
    const dialog = picker.closest(".kanban-task-dialog");
    const origin = popover.offsetParent?.getBoundingClientRect();
    const header = dialog?.querySelector(".dialog-header")?.getBoundingClientRect();
    const toolbar = dialog?.querySelector(".composer-toolbar")?.getBoundingClientRect();
    if (!dialog || !origin || !header) return;

    const anchor = picker.getBoundingClientRect();
    const form = dialog.getBoundingClientRect();
    const top = viewportTop + gutter;
    const bottom = Math.min(toolbar?.top ?? viewportBottom, viewportBottom) - gutter;
    const aboveEnd = form.top - gutter;
    const belowStart = Math.max(anchor.bottom + gutter, top);
    const above = aboveEnd - top;
    const below = bottom - belowStart;
    // Search and one touch row need room before placement next to the trigger is useful.
    const minimumRoom = 120;
    const sideStart = form.right + gutter;
    const visualRight = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth);
    const sideWidth = visualRight - sideStart - gutter;
    const sideTop = Math.max(anchor.top, top);
    const sideRoom = viewportBottom - sideTop - gutter;
    const opensBeside = sideWidth >= 320 && sideRoom >= minimumRoom;
    const opensAbove = !opensBeside && above >= minimumRoom && above > below;
    const start = below >= minimumRoom ? belowStart : Math.max(top, header.bottom + gutter);
    const room = opensBeside ? sideRoom : opensAbove ? above : bottom - start;
    popover.style.left = `${(opensBeside ? sideStart : anchor.left) - origin.left}px`;
    popover.style.width = `${opensBeside ? Math.min(anchor.width, sideWidth) : anchor.width}px`;
    popover.style.top = opensAbove
      ? `calc(${aboveEnd - origin.top}px - var(--kanban-assignee-limit))`
      : `${(opensBeside ? sideTop : start) - origin.top}px`;
    popover.style.setProperty("--kanban-assignee-room", `${Math.max(0, room)}px`);
    return;
  }

  const area = scrollArea.getBoundingClientRect();
  const anchor = picker.getBoundingClientRect();
  if (anchor.bottom <= area.top || anchor.top >= area.bottom) {
    picker.open = false;
    return;
  }

  const top = Math.max(area.top, viewportTop) + gutter;
  const bottom = Math.min(area.bottom, viewportBottom) - gutter;
  const belowStart = Math.max(anchor.bottom, top) + gutter;
  const fieldTop = picker.parentElement?.getBoundingClientRect().top ?? anchor.top;
  const aboveEnd = Math.min(fieldTop, bottom) - gutter;
  const below = bottom - belowStart;
  const above = aboveEnd - top;
  const opensBelow = below >= 328 || below >= above;
  // When the keyboard leaves very little room, use the visible area for search and its results.
  const alignToViewport = Math.max(below, above) < 112;
  popover.style.top = alignToViewport
    ? `${top - anchor.top}px`
    : opensBelow
      ? `${belowStart - anchor.top}px`
      : "auto";
  popover.style.bottom = !alignToViewport && !opensBelow ? `${anchor.bottom - aboveEnd}px` : "auto";
  const room = alignToViewport ? bottom - top : opensBelow ? below : above;
  popover.style.setProperty("--kanban-assignee-room", `${Math.max(0, room)}px`);
}

function KanbanWorkerPicker({
  workers = [],
  value,
  busy,
  loadWorkers,
  onChange,
}: {
  workers?: WorkerProfile[];
  value?: string;
  busy: boolean;
  loadWorkers(): Promise<boolean>;
  onChange(id: string): void;
}) {
  const { t } = useI18n();
  const menu = useRef<HTMLDetailsElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [catalogueStatus, setCatalogueStatus] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const tabbing = useRef(false);
  const [query, setQuery] = useState("");
  const valueId = useId();
  const resultsId = `${valueId}-options`;
  const label = t("Исполнитель");
  const searchLabel = t("Найти работника");
  const options = [{ id: "", name: t("Стандартная сессия") }, ...workers];
  const selectedId = value ?? "";
  const selectedName =
    options.find(({ id }) => id === selectedId)?.name ?? t("Назначенный работник");
  const term = query.trim().toLowerCase();
  const matches = term ? options.filter(({ name }) => name.toLowerCase().includes(term)) : options;

  useLayoutEffect(() => {
    const picker = menu.current;
    const popup = popover.current;
    if (!picker || !popup) return;
    const backdrop = picker.closest<HTMLElement>(".kanban-task-backdrop");
    if (!open && !backdrop) return;
    const dialog = picker.closest(".kanban-task-dialog");
    const area = dialog ?? picker.closest(".kanban-panel-body");
    const viewport = window.visualViewport;
    const fit = () => {
      if (backdrop) {
        const top = viewport?.offsetTop ?? 0;
        const bottom = top + (viewport?.height ?? window.innerHeight);
        backdrop.style.setProperty("--kanban-task-view-top", `${top}px`);
        backdrop.style.setProperty("--kanban-task-view-bottom", `${window.innerHeight - bottom}px`);
      }
      if (picker.open) fitAssigneePopover(picker, popup);
    };
    fit();
    area?.addEventListener("scroll", fit, { passive: true });
    dialog?.addEventListener("animationend", fit);
    window.addEventListener("resize", fit);
    viewport?.addEventListener("resize", fit);
    viewport?.addEventListener("scroll", fit);
    return () => {
      area?.removeEventListener("scroll", fit);
      dialog?.removeEventListener("animationend", fit);
      window.removeEventListener("resize", fit);
      viewport?.removeEventListener("resize", fit);
      viewport?.removeEventListener("scroll", fit);
    };
  }, [open]);

  async function refresh() {
    setCatalogueStatus("loading");
    setCatalogueStatus((await loadWorkers()) ? "ready" : "unavailable");
  }

  function openPicker(picker: HTMLDetailsElement) {
    setQuery("");
    if (results.current) results.current.scrollTop = 0;
    picker.open = true;
    if (popover.current) fitAssigneePopover(picker, popover.current);
    // iOS only opens the keyboard when the search receives focus in the opening gesture.
    search.current?.focus({ preventScroll: true });
    void refresh();
  }

  function choose(id: string) {
    const picker = menu.current;
    if (busy || catalogueStatus !== "ready" || !picker?.open) return;
    picker.open = false;
    picker.querySelector("summary")?.focus({ preventScroll: true });
    if (id !== selectedId) onChange(id);
  }

  function handleKey(event: ReactKeyboardEvent<HTMLDetailsElement>) {
    if (event.key === "Tab") {
      tabbing.current = true;
      requestAnimationFrame(() => {
        tabbing.current = false;
      });
    }
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      if (event.key === "Escape") event.stopPropagation();
      return;
    }
    const picker = event.currentTarget;
    if (!picker.open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      if (!busy) {
        event.preventDefault();
        openPicker(picker);
      }
      return;
    }
    if (event.target === search.current) {
      if (event.key === "Enter") {
        event.preventDefault();
        if (matches.length === 1) choose(matches[0]!.id);
        return;
      }
      if (event.key === "Home" || event.key === "End") return;
    }
    handleMenuKey(event);
  }

  return (
    <div className="kanban-assignee-field">
      <span>{label}</span>
      <details
        ref={menu}
        className="thread-action-menu kanban-assignee"
        data-dismiss-on-outside-click
        onBlur={(event) => {
          // Outside pointer clicks are handled after their target runs.
          if (
            tabbing.current &&
            event.relatedTarget &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            event.currentTarget.open = false;
        }}
        onKeyDown={handleKey}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary
          className="kanban-assignee-trigger"
          aria-label={label}
          aria-describedby={valueId}
          aria-disabled={busy || undefined}
          onClick={(event) => {
            event.preventDefault();
            const picker = menu.current;
            if (busy || !picker) return;
            if (picker.open) {
              picker.open = false;
              event.currentTarget.focus({ preventScroll: true });
            } else openPicker(picker);
          }}
        >
          <span id={valueId}>{selectedName}</span>
          <ChevronDownIcon />
        </summary>
        <div
          ref={popover}
          className="action-menu-popover kanban-assignee-popover"
          data-long-list={options.length >= 6 || undefined}
          role="group"
          aria-label={label}
        >
          <div className="kanban-picker-search">
            <SearchIcon aria-hidden="true" />
            <input
              ref={search}
              type="search"
              aria-label={searchLabel}
              aria-controls={resultsId}
              placeholder={searchLabel}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                if (results.current) results.current.scrollTop = 0;
              }}
            />
          </div>
          <div id={resultsId} ref={results} className="kanban-assignee-options">
            {catalogueStatus === "loading" && (
              <div className="kanban-picker-note kanban-muted" role="status">
                {t("Загружаем работников…")}
              </div>
            )}
            {catalogueStatus === "unavailable" && (
              <>
                <div className="kanban-picker-note kanban-muted" role="status">
                  {t("Каталог работников недоступен.")}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    search.current?.focus({ preventScroll: true });
                    void refresh();
                  }}
                >
                  {t("Повторить")}
                </button>
              </>
            )}
            {catalogueStatus === "ready" &&
              matches.map(({ id, name }) => (
                <button
                  key={id}
                  type="button"
                  disabled={busy}
                  aria-pressed={id === selectedId}
                  onClick={() => choose(id)}
                >
                  <CheckIcon aria-hidden="true" />
                  <span>{name}</span>
                </button>
              ))}
            {catalogueStatus === "ready" && matches.length === 0 && (
              <div className="kanban-picker-note kanban-muted" role="status">
                {t("Совпадений нет")}
              </div>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

function BoardProjectPicker({
  projects,
  projectId,
  name,
  switchBlocked,
}: {
  projects: Project[];
  projectId: string;
  name: string;
  switchBlocked: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const pickerRef = useRef<HTMLDetailsElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const valueId = useId();
  const noteId = `${valueId}-note`;
  const resultsId = `${valueId}-projects`;
  const label = t("Выбрать проект");
  const searchLabel = t("Найти проект");
  const term = query.trim().toLowerCase();
  const matches = term
    ? projects.filter(({ displayName }) => displayName.toLowerCase().includes(term))
    : projects;

  useLayoutEffect(() => {
    const picker = pickerRef.current;
    const popover = popoverRef.current;
    if (!open || !picker || !popover) return;
    const viewport = window.visualViewport;
    const fit = () => {
      const anchorBottom = picker.getBoundingClientRect().bottom;
      const viewportTop = viewport?.offsetTop ?? 0;
      const top = Math.max(anchorBottom, viewportTop);
      const bottom = viewportTop + (viewport?.height ?? window.innerHeight);
      popover.style.setProperty("--kanban-project-menu-offset", `${top - anchorBottom}px`);
      popover.style.setProperty("--kanban-project-menu-room", `${Math.max(0, bottom - top)}px`);
    };
    fit();
    window.addEventListener("resize", fit);
    viewport?.addEventListener("resize", fit);
    viewport?.addEventListener("scroll", fit);
    return () => {
      window.removeEventListener("resize", fit);
      viewport?.removeEventListener("resize", fit);
      viewport?.removeEventListener("scroll", fit);
    };
  }, [open]);

  function openPicker(picker: HTMLDetailsElement) {
    if (!picker.open) {
      setQuery("");
      picker.open = true;
      if (resultsRef.current) resultsRef.current.scrollTop = 0;
    }
    // Focus in the opening gesture so touch browsers can show the keyboard.
    searchRef.current?.focus({ preventScroll: true });
  }

  function choose(id: string) {
    if (switchBlocked && id !== projectId) return;
    const picker = pickerRef.current;
    if (!picker?.open) return;
    picker.open = false;
    if (id === projectId) triggerRef.current?.focus({ preventScroll: true });
    else void navigate(`/projects/${encodeURIComponent(id)}/kanban`);
  }

  function handleKey(event: ReactKeyboardEvent<HTMLDetailsElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.target === searchRef.current && event.key !== "Escape") {
      if (event.key === "Enter") {
        event.preventDefault();
        const available = switchBlocked ? matches.filter(({ id }) => id === projectId) : matches;
        if (available.length === 1) choose(available[0]!.id);
      }
      return;
    }
    if (
      event.target === triggerRef.current &&
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      openPicker(event.currentTarget);
      return;
    }
    handleMenuKey(event);
  }
  return (
    <details
      ref={pickerRef}
      className="thread-action-menu kanban-project-picker"
      data-dismiss-on-outside-click
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          event.currentTarget.open = false;
      }}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={handleKey}
    >
      <summary
        ref={triggerRef}
        aria-label={label}
        aria-describedby={valueId}
        title={name}
        onClick={(event) => {
          event.preventDefault();
          const picker = pickerRef.current;
          if (!picker) return;
          if (picker.open) {
            picker.open = false;
            triggerRef.current?.focus({ preventScroll: true });
          } else openPicker(picker);
        }}
      >
        <span id={valueId}>{name}</span>
        <ChevronDownIcon aria-hidden="true" />
      </summary>
      <div
        ref={popoverRef}
        className="action-menu-popover kanban-project-options"
        role="group"
        aria-label={label}
        aria-describedby={switchBlocked ? noteId : undefined}
      >
        <div className="kanban-picker-search">
          <SearchIcon aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            aria-label={searchLabel}
            aria-controls={resultsId}
            placeholder={searchLabel}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              if (resultsRef.current) resultsRef.current.scrollTop = 0;
            }}
          />
        </div>
        {switchBlocked && (
          <div id={noteId} className="kanban-picker-note kanban-muted">
            {t("Сначала отправьте или отмените запись.")}
          </div>
        )}
        <div ref={resultsRef} id={resultsId} className="kanban-project-results">
          {matches.map(({ id, displayName }) => (
            <button
              key={id}
              type="button"
              aria-pressed={id === projectId}
              disabled={switchBlocked && id !== projectId}
              onClick={() => choose(id)}
            >
              <CheckIcon aria-hidden="true" />
              <span>{displayName}</span>
            </button>
          ))}
          {matches.length === 0 && (
            <div className="kanban-picker-note kanban-muted" role="status">
              {t("Совпадений нет")}
            </div>
          )}
        </div>
      </div>
    </details>
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
type PendingRecordingChange = (delta: 1 | -1) => void;
type ComposerValue = {
  id: string;
  text: string;
  images: KanbanImageInput[];
  recording?: Recording;
  workerId?: string;
};
const EMPTY_TASK_DRAFT: BoardTaskDraft = { input: "", images: [] };

function useReportPendingRecording(pending: boolean, onChange: PendingRecordingChange) {
  useLayoutEffect(() => {
    if (!pending) return;
    onChange(1);
    return () => onChange(-1);
  }, [pending, onChange]);
}

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
  onPendingRecordingChange,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  config: TranscriptionConfigResponse | null;
  onPendingRecordingChange: PendingRecordingChange;
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
    if (busy || reading || (!recording && !text.trim() && !images.length)) return;
    if (recording) onPendingRecordingChange(1);
    try {
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
    } finally {
      if (recording) onPendingRecordingChange(-1);
    }
  }
  const recorder = useRecorder(config, (recording) => void submit(recording));
  useReportPendingRecording(
    recorder.state !== "idle" || failedRecording !== null,
    onPendingRecordingChange,
  );
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
          disabled={busy || reading > 0 || recording || (!text.trim() && !images.length)}
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
  onPendingRecordingChange,
}: {
  config: TranscriptionConfigResponse | null;
  busy: boolean;
  onRecorded(recording: Recording): void;
  onPendingRecordingChange: PendingRecordingChange;
}) {
  const { t } = useI18n();
  const recorder = useRecorder(config, onRecorded);
  useReportPendingRecording(recorder.state !== "idle", onPendingRecordingChange);
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
