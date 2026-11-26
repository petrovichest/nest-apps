import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  KanbanAudioInput,
  CreateKanbanCardRequest,
  CreateKanbanStageRequest,
  KanbanActionRequest,
  KanbanBoard,
  KanbanCard,
  KanbanImageInput,
  KanbanProvider,
  KanbanRun,
  KanbanRunKind,
  KanbanStageRole,
  Project,
  SessionSettings,
  SkillCatalogItem,
  ThreadSummary,
  UpdateKanbanCardRequest,
  UpdateKanbanStageRequest,
  WorkerProfile,
  WorkerSessionSummary,
} from "@codexnest/protocol";
import {
  KANBAN_AUDIO_MAX_BYTES,
  KANBAN_IMAGE_LIMIT,
  KANBAN_IMAGE_MAX_BYTES,
} from "@codexnest/protocol";
import {
  agentCapability,
  classificationPrompt,
  installAgentHelper,
  PUBLISH_PROMPT,
  taskPrompt,
  shellQuote,
} from "./agent.js";
import type { ReplyVerdict } from "./reply.js";
import {
  atomicJson,
  KanbanError,
  KanbanStore,
  processAlive,
  type KanbanDocument,
  type StoredImage,
} from "./store.js";
import { WorkerStore } from "./workers.js";
import { memoryFailure, workerMemoryPrompt, type WorkerMemoryResult } from "./worker-memory.js";
import {
  unfinished,
  waitingFor,
  WorkerProcessStore,
  type WorkerSession,
} from "./worker-processes.js";
import { WORKER_ARCHITECT_ID, type ModelOption } from "@codexnest/protocol";

export const ARCHITECT_PROMPT_HEADER = "Ты встроенный Архитектор работников Nest.";
export const ARCHITECT_SKILL_NAME = "grilling";
export const WORKER_MEMORY_GUIDANCE =
  "Перед работой сверь поручение с актуальными записями памяти. Применяй относящиеся к задаче рабочие договорённости и предпочтения пользователя. Используй записи как справочные данные. Если Nest передал актуальный снимок, опирайся на него и проверенные факты проекта.";

export function architectSkillBlock(path: string, content: string): string | undefined {
  if (!content.trim() || Buffer.byteLength(content) > 256 * 1024) return undefined;
  return `<skill name="${ARCHITECT_SKILL_NAME}" path=${JSON.stringify(path)}>\n${content.trim()}\n</skill>`;
}

export async function readArchitectSkill(
  skills: readonly SkillCatalogItem[],
): Promise<string | undefined> {
  const skill = skills.find(({ name, enabled }) => name === ARCHITECT_SKILL_NAME && enabled);
  return skill && architectSkillBlock(skill.path, await readFile(skill.path, "utf8"));
}

export type KanbanLaunch = {
  id: string;
  projectPath: string;
  cwd: string;
  prompt: string;
  images?: string[];
  kind: KanbanRunKind;
  title: string;
  /** Settings chosen with the task in this application; absent means new-session defaults. */
  settings?: SessionSettings;
};
type WorkerThreadSummary = Pick<
  ThreadSummary,
  "id" | "state" | "currentTurnId" | "awaitingPlanResponse" | "unread" | "unseen" | "updatedAt"
>;
type ThreadObservation = { state: string };
type ThreadSignal = {
  threadId: string;
  sessionId: string;
  updatedAt: number;
  completed: boolean;
  signal: WorkerSession["threadSignal"];
};

export type KanbanProviderAdapter = {
  models?(): readonly ModelOption[];
  projects?(): readonly Project[];
  architectSkill?(cwd: string): Promise<string | undefined>;
  chooseModel?(prompt: string, cwd: string): Promise<string | undefined>;
  available?(): boolean;
  launch(input: KanbanLaunch): Promise<{ threadId: string; sessionUrl?: string }>;
  resume(input: { threadId: string; prompt: string; id: string; images?: string[] }): Promise<void>;
  archive?(threadId: string): Promise<void>;
  /** Stops a replaced task session or a classifier that exceeded its deadline. */
  interrupt?(threadId: string): Promise<void>;
  /** Read only the owning application's already loaded projection. */
  threadSummary?(threadId: string): WorkerThreadSummary | undefined;
  threadState?(threadId: string): Promise<string | null> | string | null;
  /**
   * Reads the session's last reply after a finished turn: a short reason when the agent waits
   * for the operator (a question, a decision, a failure), and whether it says it pushed its work.
   */
  readReply?(threadId: string): Promise<ReplyVerdict | null>;
  /** The last assistant reply, used when a worker ends without a structured report. */
  readAnswer?(threadId: string): Promise<string | null>;
  /** The operator's first message in the session; null until it has one. */
  readRequest?(threadId: string): Promise<string | null>;
};
export type KanbanServiceOptions = {
  provider: KanbanProvider;
  adapter: KanbanProviderAdapter;
  /** The application's speech recognition; recordings fail clearly without it. */
  transcribe?(audio: Buffer, contentType: string, durationMs: number): Promise<string>;
  /** False when new tasks keep their text as the title instead of being classified. */
  classifies?(): boolean;
  dataDir?: string;
  onChange?: (board: KanbanBoard) => void;
  onWorkerSessionChanged?: (threadId: string) => void;
  onError?: (error: unknown) => void;
};
const active = (run: KanbanRun) =>
  ["queued", "preparing", "running", "waiting"].includes(run.status);
const nextFollowUp = (session: WorkerSession, sender: WorkerSession) =>
  !unfinished(session) && (!session.wait || session.delivered || sender.status === "failed")
    ? session.followUps?.[0]
    : undefined;
const text = (value: unknown, label: string, maximum = 100_000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new KanbanError(
      "invalid_request",
      `${label} must be nonempty text (maximum ${maximum} characters)`,
      400,
    );
  return value.trim();
};
const role = (board: KanbanBoard, value: KanbanStageRole) =>
  board.stages.find((stage) => stage.role === value)!.id;
const AUTO_ARCHIVE_MS = 7 * 24 * 60 * 60 * 1000;
const CLASSIFICATION_TIMEOUT_MS = 2 * 60_000;
const stageRole = (board: KanbanBoard, stageId: string) =>
  board.stages.find((stage) => stage.id === stageId)?.role ?? null;
function requireWorkerProject(projectPath: string | null): string {
  if (!projectPath)
    throw new KanbanError("worker_project_required", "Choose a project to start the worker", 400);
  return projectPath;
}

/** A card that changes stage moves to the top of its new column. */
function setStage(data: KanbanDocument, card: KanbanCard, stageId: string): void {
  if (card.stageId === stageId) return;
  card.stageId = stageId;
  if (stageRole(data.board, stageId) === "done") card.doneAt = Date.now();
  else delete card.doneAt;
  const cards = data.board.cards;
  cards.splice(cards.indexOf(card), 1);
  cards.unshift(card);
}
const expiredDone = (board: KanbanBoard, card: KanbanCard, cutoff: number) =>
  card.archivedAt === undefined &&
  stageRole(board, card.stageId) === "done" &&
  (card.doneAt ?? card.updatedAt) < cutoff;
/** Queued, starting or running: the session is busy and the card stays where it is. */
const busy = (run: KanbanRun) => ["queued", "preparing", "running"].includes(run.status);
/** The task's ordinary session: its newest turn requested by the board, in any application. */
function taskSession(data: KanbanDocument, cardId: string) {
  for (let index = data.board.runs.length - 1; index >= 0; index--) {
    const run = data.board.runs[index]!;
    if (run.kind !== "classify" && run.cardIds.includes(cardId))
      return { run, threadId: run.threadId ?? data.runs[run.id]?.resumeThreadId ?? null };
  }
  return undefined;
}
/**
 * Tasks started together share one session, so its later turns carry all of them that are
 * still on the board; the card asked about stays even when archived, to fail clearly.
 */
function sessionCards(
  data: KanbanDocument,
  card: KanbanCard,
  session = taskSession(data, card.id),
): KanbanCard[] {
  if (!session) return [card];
  return session.run.cardIds.flatMap((id) => {
    const item = data.board.cards.find((value) => value.id === id);
    return item && (item === card || item.archivedAt === undefined) ? [item] : [];
  });
}
/** This application's sessions whose tasks all left the board and that were not archived yet. */
function retiredSessions(data: KanbanDocument, provider: KanbanProvider): Set<string> {
  const live = new Set(
    data.board.cards.filter((card) => card.archivedAt === undefined).map((card) => card.id),
  );
  const retired = new Set<string>();
  const kept = new Set<string>();
  for (const run of data.board.runs) {
    if (run.kind === "classify" || run.provider !== provider || !run.threadId) continue;
    if (busy(run) || run.cardIds.some((id) => live.has(id))) kept.add(run.threadId);
    else if (!data.runs[run.id]?.sessionArchived) retired.add(run.threadId);
  }
  for (const threadId of kept) retired.delete(threadId);
  return retired;
}
/** The task's agent is busy; classification does not count. */
const working = (data: KanbanDocument, cardId: string) =>
  data.board.runs.some(
    (run) => run.kind !== "classify" && busy(run) && run.cardIds.includes(cardId),
  );
/** Publications push the project's shared branch, so they run one at a time. */
const publishing = (board: KanbanBoard) =>
  board.runs.some(
    (run) => run.kind === "publish" && (run.status === "preparing" || run.status === "running"),
  );
const findCard = (data: KanbanDocument, id: string) => {
  const card = data.board.cards.find((card) => card.id === id);
  if (!card) throw new KanbanError("not_found", "Card not found", 404);
  return card;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function decodeImage(input: KanbanImageInput) {
  if (!input || typeof input !== "object")
    throw new KanbanError("invalid_request", "Invalid task image", 400);
  const name = text(input.name, "Image name", 255);
  const match =
    typeof input.url === "string" &&
    /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.url);
  if (!match || match[2]!.length > Math.ceil(KANBAN_IMAGE_MAX_BYTES / 3) * 4)
    throw new KanbanError("invalid_request", "Use a PNG, JPEG, GIF or WebP image up to 10 MB", 400);
  const bytes = Buffer.from(match[2]!, "base64");
  if (
    !bytes.length ||
    bytes.length > KANBAN_IMAGE_MAX_BYTES ||
    bytes.toString("base64") !== match[2]
  )
    throw new KanbanError("invalid_request", "Invalid task image data or size", 400);
  const mediaType = match[1]!;
  const valid =
    mediaType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mediaType === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mediaType === "image/gif"
          ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
          : bytes.subarray(0, 4).toString() === "RIFF" &&
            bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid)
    throw new KanbanError("invalid_request", "Image content does not match its type", 400);
  return { name, mediaType, bytes };
}

function decodeImages(inputs: unknown): ReturnType<typeof decodeImage>[] {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs) || inputs.length > KANBAN_IMAGE_LIMIT)
    throw new KanbanError(
      "invalid_request",
      `Attach up to ${KANBAN_IMAGE_LIMIT} images to one task`,
      400,
    );
  return inputs.map((input) => decodeImage(input as KanbanImageInput));
}
function decodeAudio(input: KanbanAudioInput) {
  if (!input || typeof input !== "object")
    throw new KanbanError("invalid_request", "Invalid recording", 400);
  const mediaType = typeof input.mediaType === "string" ? input.mediaType.trim() : "";
  if (!/^audio\/[\w.+-]+(?:\s*;.*)?$/i.test(mediaType) || mediaType.length > 200)
    throw new KanbanError("invalid_request", "Invalid recording format", 400);
  if (
    typeof input.data !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data) ||
    input.data.length > Math.ceil(KANBAN_AUDIO_MAX_BYTES / 3) * 4
  )
    throw new KanbanError("invalid_request", "The recording is too large or damaged", 400);
  const bytes = Buffer.from(input.data, "base64");
  const durationMs = Number(input.durationMs);
  if (!bytes.length || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3_600_000)
    throw new KanbanError("invalid_request", "Invalid recording", 400);
  return { mediaType, bytes, durationMs: Math.round(durationMs) };
}
/** The application checks the model and effort when it starts the session. */
function decodeSettings(input: unknown): SessionSettings | undefined {
  if (input === undefined) return undefined;
  const value = input as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["default", "plan", "team"].includes(value.collaborationMode as string)
  )
    throw new KanbanError("invalid_request", "Invalid session settings", 400);
  const settings: SessionSettings = {
    collaborationMode: value.collaborationMode as SessionSettings["collaborationMode"],
  };
  for (const key of ["model", "reasoningEffort", "serviceTier", "personality"] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || !field || field.length > 200)
      throw new KanbanError("invalid_request", "Invalid session settings", 400);
    settings[key] = field;
  }
  return settings;
}
/** New cards keep several images; older cards have one legacy image named after the card. */
const cardImages = (card: KanbanCard): StoredImage[] =>
  card.images
    ? card.images.map((image, index) => ({ ...image, file: `${card.id}.${index}` }))
    : card.image
      ? [{ ...card.image, file: card.id }]
      : [];
type ClassifiedTask = { title: string; category: string; text?: string; images: number[] };
/**
 * A classifier reports one task, or several when the text holds independent tasks; each part
 * gets zero-based picture indexes, and a picture no part claims goes to every part.
 */
function classifiedTasks(payload: Record<string, unknown>, pictures: number): ClassifiedTask[] {
  const all = Array.from({ length: pictures }, (_, index) => index);
  if (!Array.isArray(payload.tasks) || payload.tasks.length === 1) {
    const one = (Array.isArray(payload.tasks) ? payload.tasks[0] : payload) as Record<
      string,
      unknown
    >;
    return [
      {
        title: text(one?.title, "Task title", 300),
        category: text(one?.category, "Category", 100),
        images: all,
      },
    ];
  }
  if (!payload.tasks.length || payload.tasks.length > 10)
    throw new KanbanError("invalid_request", "Report from one to ten tasks", 400);
  const tasks = payload.tasks.map((value: unknown) => {
    const task = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const images = task.images ?? [];
    if (
      !Array.isArray(images) ||
      images.some((number) => !Number.isInteger(number) || number < 1 || number > pictures)
    )
      throw new KanbanError("invalid_request", `Pictures are numbered from 1 to ${pictures}`, 400);
    return {
      title: text(task.title, "Task title", 300),
      category: text(task.category, "Category", 100),
      text: text(task.text, "Task text"),
      images: (images as number[]).map((number) => number - 1),
    };
  });
  const claimed = new Set(tasks.flatMap((task) => task.images));
  for (const task of tasks)
    task.images = all.filter((index) => task.images.includes(index) || !claimed.has(index));
  return tasks;
}

export class KanbanService {
  readonly store: KanbanStore;
  readonly workers: WorkerStore;
  readonly processes: WorkerProcessStore;
  private watchers: FSWatcher[] = [];
  private pumping = false;
  private again = false;
  private closed = true;
  private helper = "";
  private launching = new Set<string>();
  private transcribing = new Set<string>();
  private describing = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private pumpWaiters: (() => void)[] = [];
  private threads = new Map<string, { boardId: string; runId: string }>();
  private workerThreads = new Map<
    string,
    Pick<WorkerSession, "id" | "workerId" | "projectKey" | "projectPath"> & {
      summary: WorkerSessionSummary;
    }
  >();
  private workerMemoryFailures = new Map<string, number>();
  private revisions = new Map<string, number>();
  private observedStates = new Map<string, ThreadObservation>();
  private observedSignals = new Map<string, ThreadSignal>();
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private classificationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly options: KanbanServiceOptions) {
    this.store = new KanbanStore(options.dataDir);
    this.workers = new WorkerStore(
      process.env.NEST_WORKERS_DATA_DIR ||
        (process.env.VITEST ? join(this.store.directory, "workers") : undefined),
    );
    this.processes = new WorkerProcessStore(this.workers.directory);
  }

  private async prepareWorker(id: string, projectPath: string, runId: string, existingRun = false) {
    const projectKey = await this.workers.projectKey(projectPath);
    const { profile, memory } = existingRun
      ? await this.workers.snapshot(id, projectKey)
      : await this.workers.availableSnapshot(id, projectKey);
    const architect = id === WORKER_ARCHITECT_ID;
    const models = this.options.adapter.models?.();
    const settings = architect
      ? undefined
      : (profile.settings[this.options.provider] ??
        (await this.workers.configure(id, projectKey, this.options.provider, (current) =>
          this.chooseWorkerModel(current, models ?? [], projectPath),
        )));
    if (settings?.model && models && !models.some(({ id }) => id === settings.model))
      throw new KanbanError(
        "worker_model_unavailable",
        `Модель «${settings.model}» работника «${profile.name}» недоступна. Повторите запуск после восстановления или измените настройки работника.`,
      );
    const projects = architect ? (this.options.adapter.projects?.() ?? []) : [];
    const currentProject = projects.find(({ path }) => path === projectPath);
    const skill = architect
      ? await this.options.adapter.architectSkill?.(projectPath).catch((error: unknown) => {
          this.options.onError?.(error);
          return undefined;
        })
      : undefined;
    const role = architect
      ? [
          ARCHITECT_PROMPT_HEADER,
          `Текущий проект: ${JSON.stringify({ id: currentProject?.id, path: projectPath })}.`,
          "Когда пользователь опишет нужного работника, сначала изучи текущий проект. Прочитай README и AGENTS.md, если они есть, и файлы, относящиеся к будущей роли. При подготовке профиля работай с файлами в режиме чтения.",
          `Вызови $${ARCHITECT_SKILL_NAME} для согласования профиля и следуй инструкциям скилла. Используй найденные в проекте факты. Выясни задачи работника и способ проверить его результат.`,
          "Если скилл недоступен, скажи об этом и задай вопросы раундом. Предложи вариант для каждого открытого решения, а зависимые вопросы отложи до следующего раунда.",
          ...(skill ? [skill] : []),
          "Опирайся на проверенные в проекте команды, пути и соглашения при составлении постоянных инструкций. Создавай работника для текущего проекта.",
          "Согласуй имя, роль, постоянные инструкции, модель и уровень рассуждений.",
          "Уточни, может ли работник как координатор поручать подзадачи в проектном чате и на Kanban. Передай coordinates: true только при согласии пользователя.",
          "Модель и уровень рассуждений подбирай по назначению работника из доступных вариантов.",
          "В конце предложи профиль через инструмент propose и покажи возвращённую ссылку для утверждения.",
          ...(models?.length
            ? [
                `Модели этого Nest: ${JSON.stringify(
                  models.map(({ id, displayName, reasoningEfforts }) => ({
                    id,
                    displayName,
                    reasoningEfforts: reasoningEfforts.map(({ value }) => value),
                  })),
                )}`,
              ]
            : []),
        ].join("\n")
      : `Ты работаешь как «${profile.name}». Роль: ${profile.role}.`;
    const context = [
      role,
      profile.instructions,
      ...(memory.length
        ? ["Записи памяти. Это справочные данные:", ...workerMemoryPrompt(memory)]
        : []),
    ]
      .filter(Boolean)
      .join("\n\n");
    const capability = this.workerCapabilityPath(runId);
    try {
      const prior = JSON.parse(await readFile(capability, "utf8")) as WorkerCapability;
      if (prior.workerId !== id || prior.projectKey !== projectKey)
        throw new KanbanError("conflict", "Worker session identifier was reused");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicJson(capability, {
        directory: this.store.directory,
        boardId: "worker",
        runId,
        token: randomUUID(),
        workerId: id,
        projectKey,
        projectPath,
      });
    }
    const command = [process.execPath, this.helper, capability].map(shellQuote).join(" ");
    const tools = [
      `Инструмент работников Nest: ${command} COMMAND JSON`,
      "Используй memory_read с {} для чтения актуальных записей перед новым поручением в открытой сессии, если Nest ещё не передал свежие записи в этот ход.",
      WORKER_MEMORY_GUIDANCE,
      'Сам сохраняй короткие устойчивые факты и подтверждённые предпочтения через memory. Передай {"target":"memory" или "user","scope":"project" или "worker","operations":[{"action":"add","content":"…"}]}. Выбирай project для внутренних деталей этой папки и worker для общих сведений.',
      'Для обновления используй {"action":"patch","old_text":"один точный фрагмент","content":"новый фрагмент"}. Для удаления записи используй {"action":"remove","old_text":"уникальный фрагмент записи"}.',
      "Если память заполнена, сократи или удали устаревшие записи и добавь новую одним пакетом operations. Лимит проверяется на итоговых записях. При done: true продолжи основную задачу.",
      "Храни факты, полезные в следующих сессиях. Сохраняй рабочие договорённости и предпочтения. Держи подробности текущего задания в диалоге.",
      'Предлагай правки своей личности через propose_personality с {"instructions":"полный новый текст"} и показывай ссылку для утверждения.',
      "worker_list с {} показывает доступных коллег и карточки этой сессии.",
      'Для вопроса коллеге вызови worker_ask с {"workerId":"ID коллеги","title":"короткая тема","description":"сам вопрос","expectedResult":"что нужно узнать"}.',
      'Для уточнения в уже открытой дочерней сессии вызови worker_follow_up с {"sessionId":"ID сессии из worker_results","message":"что уточнить или доработать"}. У работника сохранится история разговора.',
      ...(profile.coordinates
        ? [
            'Для поручения коллеге вызови worker_delegate с {"workerId":"ID исполнителя","title":"название поручения","description":"что сделать","expectedResult":"что вернуть"}. Если работаешь над задачей на доске, передай cardId из списка карточек worker_list. В чате без доски опусти cardId.',
          ]
        : []),
      "Запрос ставится в очередь. Если ждёшь результата, закончи текущий ход: результат вернётся в эту сессию. Для фонового поручения укажи wait: false и проверь результат через worker_results с {}.",
      'Когда закончил полученный вопрос или поручение, вызови worker_finish с {"result":"ответ, выполненная работа и ссылки на результаты"} либо {"error":"почему не удалось"}. Затем закончи ход.',
      ...(architect
        ? [
            'Для утверждения профиля вызови propose с {"name":"…","role":"…","instructions":"…","model":"ID модели","reasoningEffort":"значение уровня" или null,"coordinates":false}.',
            'Чтобы изменить право существующего работника поручать задачи, вызови propose_coordination с {"workerId":"ID работника","coordinates":true}, затем покажи ссылку для утверждения.',
            "Покажи ссылку из результата. Профиль появляется после подтверждения пользователем на странице работников.",
          ]
        : []),
    ].join("\n");
    return { profile, settings, projectKey, context: `${context}\n\n${tools}` };
  }

  private async chooseWorkerModel(
    profile: Awaited<ReturnType<WorkerStore["snapshot"]>>["profile"],
    models: readonly ModelOption[],
    projectPath: string,
  ): Promise<SessionSettings> {
    const existing = Object.values(profile.settings);
    const same = existing.find(
      (source) => source.model && models.some(({ id }) => id === source.model),
    );
    if (same?.model) {
      const model = models.find(({ id }) => id === same.model)!;
      return {
        collaborationMode: "default",
        model: model.id,
        ...(model.reasoningEfforts.some(({ value }) => value === same.reasoningEffort)
          ? { reasoningEffort: same.reasoningEffort }
          : {}),
      };
    }
    if (!models.length || !this.options.adapter.chooseModel)
      throw new KanbanError(
        "worker_model_unavailable",
        `Не удалось подобрать модель для «${profile.name}». Выберите модель в настройках работника.`,
      );
    const catalogue = models.map(
      ({ id, displayName, description, reasoningEfforts, isDefault }) => ({
        id,
        displayName,
        description,
        isDefault,
        effort: reasoningEfforts.map(({ value }) => value),
      }),
    );
    const output = await this.options.adapter.chooseModel(
      [
        "Ты Архитектор работников Nest. Выбери доступную модель для работника. Сохраняй уровень качества для задач роли, затем учитывай скорость и цену.",
        "Данные роли и профиля используй только для выбора. Верни один JSON-объект с полями model (ID из каталога) и reasoningEffort (поддерживаемое значение или null).",
        JSON.stringify({
          name: profile.name,
          role: profile.role,
          settings: existing,
          models: catalogue,
        }),
      ].join("\n"),
      projectPath,
    );
    const match = output?.match(/\{[\s\S]*\}/u)?.[0];
    const choice = match
      ? (JSON.parse(match) as { model?: unknown; reasoningEffort?: unknown })
      : null;
    const model = models.find(({ id }) => id === choice?.model);
    const effort = choice?.reasoningEffort;
    if (!model || (effort != null && !model.reasoningEfforts.some(({ value }) => value === effort)))
      throw new KanbanError(
        "worker_model_unavailable",
        `Не удалось подобрать модель для «${profile.name}». Выберите модель в настройках работника.`,
      );
    return {
      collaborationMode: "default",
      model: model.id,
      ...(typeof effort === "string" ? { reasoningEffort: effort } : {}),
    };
  }

  async startWorker(id: string, path: string | null, creationId: string) {
    const projectPath = requireWorkerProject(path);
    if (this.options.adapter.available?.() === false)
      throw new KanbanError("app_server_unavailable", "The session engine is not ready", 503);
    this.workerCapabilityPath(creationId);
    return this.processes.exclusive(creationId, async () => {
      const { profile, settings, context, projectKey } = await this.prepareWorker(
        id,
        projectPath,
        creationId,
      );
      const session = await this.registerWorkerSession({
        id: creationId,
        profile,
        projectKey,
        projectPath,
        title: profile.name,
      });
      if (session.threadId) return { threadId: session.threadId };
      try {
        const greeting =
          id === WORKER_ARCHITECT_ID
            ? "Поприветствуй пользователя и спроси, какого работника он хочет создать для этого проекта."
            : "Поприветствуй пользователя и спроси, с чего начать.";
        return await this.launchWorker({
          id: creationId,
          kind: "execute",
          projectPath,
          cwd: projectPath,
          title: profile.name,
          prompt: `${context}\n\n${greeting}`,
          ...(settings ? { settings } : {}),
        });
      } catch (error) {
        await this.failWorker(creationId, message(error));
        throw error;
      }
    });
  }

  private workerCapabilityPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new KanbanError("invalid_request", "Invalid worker session identifier", 400);
    return join(this.store.directory, "capabilities", `worker-${this.options.provider}-${id}.json`);
  }

  private async workerCommand(
    request: AgentRequest,
    scope: WorkerCapability,
    onMemorySaved: () => void,
  ): Promise<unknown> {
    const token = typeof request.token === "string" ? Buffer.from(request.token) : Buffer.alloc(0);
    const expected = Buffer.from(scope.token);
    if (token.length !== expected.length || !timingSafeEqual(token, expected))
      throw new KanbanError("forbidden", "Invalid worker capability", 403);
    const { workerId, projectKey } = scope;
    if (request.command === "memory_read")
      return (await this.workers.snapshot(workerId, projectKey)).memory;
    const input = request.payload as Record<string, unknown> | null;
    if (!input || typeof input !== "object")
      throw new KanbanError("invalid_request", "Expected a tool argument object", 400);
    if (request.command === "memory") {
      const result = await this.workers.curate(workerId, projectKey, input, request.id);
      if (result.success) {
        this.workerMemoryFailures.delete(request.runId);
        if (result.saved) onMemorySaved();
      } else if (
        ["memory_full", "memory_not_found", "memory_ambiguous", "memory_would_empty"].includes(
          result.code,
        )
      ) {
        const failures = (this.workerMemoryFailures.get(request.runId) ?? 0) + 1;
        this.workerMemoryFailures.set(request.runId, failures);
        if (failures > 3)
          return {
            ...memoryFailure(
              "memory_retry_limit",
              "Continue the task. Retry saving this fact in a later turn.",
            ),
            done: true,
          };
      }
      return result;
    }
    if (request.command === "memory_add") {
      if (
        (input.kind !== "notes" && input.kind !== "user") ||
        (input.scope !== "worker" && input.scope !== "project") ||
        typeof input.text !== "string"
      )
        throw new KanbanError("invalid_request", "Invalid memory arguments", 400);
      return this.workers.changeMemory(
        workerId,
        projectKey,
        { action: "add", kind: input.kind, scope: input.scope, text: input.text },
        onMemorySaved,
      );
    }
    if (
      [
        "worker_list",
        "worker_ask",
        "worker_delegate",
        "worker_follow_up",
        "worker_results",
        "worker_finish",
      ].includes(request.command)
    )
      return this.workerInteraction(request, scope, input);
    if (request.command === "propose_personality") {
      const { profile } = await this.workers.snapshot(workerId, projectKey);
      const project = profile.projectKey
        ? this.options.adapter.projects?.().find(({ path }) => path === scope.projectPath)
        : undefined;
      if (profile.projectKey && !project)
        throw new KanbanError("not_found", "Project not found", 404);
      const proposal = await this.workers.propose({
        provider: this.options.provider,
        ...(project ? { projectId: project.id, projectName: project.displayName } : {}),
        projectKey: profile.projectKey,
        name: profile.name,
        role: profile.role,
        instructions: text(input.instructions, "Worker instructions", 16_000),
        settings: profile.settings[this.options.provider] ?? { collaborationMode: "default" },
        target: {
          id: workerId,
          revision: profile.revision,
          previousInstructions: profile.instructions,
        },
      });
      return { url: `/workers?proposal=${proposal.id}` };
    }
    if (workerId === WORKER_ARCHITECT_ID && request.command === "propose_coordination") {
      if (typeof input.coordinates !== "boolean" || input.workerId === WORKER_ARCHITECT_ID)
        throw new KanbanError(
          "invalid_worker",
          "Choose a worker and set its coordination permission",
          400,
        );
      const project = this.options.adapter
        .projects?.()
        .find(({ path }) => path === scope.projectPath);
      if (!project || !projectKey || (input.projectId != null && input.projectId !== project.id))
        throw new KanbanError("not_found", "Project not found", 404);
      const { profile } = await this.workers.availableSnapshot(
        text(input.workerId, "Worker", 120),
        projectKey,
      );
      const proposal = await this.workers.propose({
        provider: this.options.provider,
        projectId: project.id,
        projectName: project.displayName,
        projectKey,
        name: profile.name,
        role: profile.role,
        instructions: profile.instructions,
        coordinates: input.coordinates,
        settings: profile.settings[this.options.provider] ?? { collaborationMode: "default" },
        target: {
          id: profile.id,
          revision: profile.revision,
          previousInstructions: profile.instructions,
        },
      });
      return { url: `/workers?proposal=${proposal.id}` };
    }
    if (workerId === WORKER_ARCHITECT_ID && request.command === "propose") {
      if (input.coordinates !== undefined && typeof input.coordinates !== "boolean")
        throw new KanbanError("invalid_worker", "Invalid coordination permission", 400);
      const model = this.options.adapter.models?.().find((option) => option.id === input.model);
      const effort = input.reasoningEffort;
      if (
        !model ||
        (effort != null && !model.reasoningEfforts.some(({ value }) => value === effort))
      )
        throw new KanbanError(
          "invalid_worker",
          "Select an available model and level of reasoning",
          400,
        );
      const project = this.options.adapter
        .projects?.()
        .find(({ path }) => path === scope.projectPath);
      if (!project || !projectKey || (input.projectId != null && input.projectId !== project.id))
        throw new KanbanError("not_found", "Project not found", 404);
      const proposal = await this.workers.propose({
        provider: this.options.provider,
        projectId: project.id,
        projectName: project.displayName,
        projectKey,
        name: text(input.name, "Worker name", 120),
        role: text(input.role, "Worker role", 500),
        instructions: text(input.instructions, "Worker instructions", 16_000),
        ...(input.coordinates !== undefined ? { coordinates: input.coordinates } : {}),
        settings: {
          collaborationMode: "default",
          model: model.id,
          ...(typeof effort === "string" ? { reasoningEffort: effort } : {}),
        },
      });
      return { url: `/workers?proposal=${proposal.id}` };
    }
    throw new KanbanError("invalid_request", "Unknown worker tool", 400);
  }

  private async requireAssignableWorker(id: string, projectPath: string) {
    if (id === WORKER_ARCHITECT_ID || typeof id !== "string")
      throw new KanbanError("invalid_worker", "Select a worker for this task", 400);
    await this.workers.availableSnapshot(id, await this.workers.projectKey(projectPath));
  }

  private async registerWorkerSession(input: {
    id: string;
    profile: WorkerProfile;
    projectKey: string | null;
    projectPath: string | null;
    title: string;
    boardId?: string;
    cardIds?: string[];
  }): Promise<WorkerSession> {
    const { id, profile, projectKey, projectPath, title, boardId, cardIds } = input;
    const provider = this.options.provider;
    return this.processes.update((sessions) => {
      const existing = sessions[id];
      if (existing) {
        if (
          existing.workerId !== profile.id ||
          existing.projectKey !== projectKey ||
          existing.provider !== provider ||
          existing.boardId !== boardId
        )
          throw new KanbanError("conflict", "Worker session identifier was reused");
        if (!existing.threadId && existing.status === "failed" && existing.kind === "session") {
          existing.status = "queued";
          delete existing.error;
        }
        return existing;
      }
      const now = Date.now();
      const projectName = projectPath
        ? (this.options.adapter.projects?.().find(({ path }) => path === projectPath)
            ?.displayName ?? basename(projectPath))
        : null;
      return (sessions[id] = {
        id,
        processId: id,
        parentId: null,
        workerId: profile.id,
        workerName: profile.name,
        provider,
        projectPath,
        projectKey,
        projectName,
        boardId,
        cardIds,
        threadId: null,
        title,
        kind: "session",
        status: "queued",
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  private async workerInteraction(
    request: AgentRequest,
    scope: WorkerCapability,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const sessions = await this.processes.read();
    const sender = sessions[request.runId];
    if (
      !sender ||
      sender.workerId !== scope.workerId ||
      sender.projectKey !== scope.projectKey ||
      sender.provider !== this.options.provider
    )
      throw new KanbanError("worker_session_not_found", "Open a new worker session", 404);
    if (request.command === "worker_list") {
      const profiles = await this.workers.list(scope.projectKey);
      const board = sender.boardId ? await this.store.readById(sender.boardId) : null;
      const canDelegateDirectly =
        sender.projectPath &&
        !sender.boardId &&
        profiles.some(({ id, coordinates }) => id === sender.workerId && coordinates);
      return {
        workers: profiles
          .filter(({ id }) => id !== sender.workerId)
          .map(({ id, name, role }) => ({ id, name, role })),
        cards:
          board?.board.cards
            .filter(
              ({ id, archivedAt }) => sender.cardIds?.includes(id) && archivedAt === undefined,
            )
            .map(({ id, title }) => ({ id, title })) ?? [],
        delegation: canDelegateDirectly
          ? "Для поручения коллеге вызови worker_delegate с workerId, title, description и expectedResult. В этой сессии опусти cardId."
          : undefined,
      };
    }
    if (request.command === "worker_results")
      return Object.values(sessions)
        .filter(({ parentId }) => parentId === sender.id)
        .map(({ id, threadId, workerName, title, status, result, error }) => ({
          id,
          workerName,
          title,
          status,
          result,
          error,
          ...(threadId ? { followUp: { command: "worker_follow_up", sessionId: id } } : {}),
        }));
    if (request.command === "worker_finish") {
      if (sender.kind === "session" || (input.result === undefined) === (input.error === undefined))
        throw new KanbanError(
          "invalid_request",
          "Supply a result or error for a worker request",
          400,
        );
      const report =
        input.error === undefined
          ? { result: text(input.result, "Worker result", 32_000) }
          : { error: text(input.error, "Worker error", 8_000) };
      return this.processes.update((current) => {
        const own = current[sender.id]!;
        if (
          !unfinished(own) ||
          waitingFor(current, own.id).length ||
          (own.reported && JSON.stringify(own.reported) !== JSON.stringify(report))
        )
          throw new KanbanError(
            "worker_result_conflict",
            "The worker request already ended or is waiting on a colleague",
          );
        own.reported = report;
        return { accepted: true };
      });
    }
    if (input.wait !== undefined && typeof input.wait !== "boolean")
      throw new KanbanError("invalid_request", "Wait must be a boolean", 400);
    const projectPath = requireWorkerProject(sender.projectPath);
    if (request.command === "worker_follow_up") {
      const sessionId = text(input.sessionId, "Worker session", 120);
      const followUp = {
        id: request.id,
        message: text(input.message, "Worker follow-up", 16_000),
        wait: input.wait !== false,
      };
      return this.processes.update((current) => {
        const child = current[sessionId];
        if (
          child?.parentId !== sender.id ||
          child.processId !== sender.processId ||
          child.projectKey !== sender.projectKey ||
          child.provider !== sender.provider
        )
          throw new KanbanError("worker_session_not_found", "Эта дочерняя сессия недоступна", 404);
        if (!child.threadId)
          throw new KanbanError("worker_session_not_ready", "Сессия работника ещё не открыта");
        const own = current[sender.id]!;
        if (
          child.followUp?.id !== request.id &&
          !child.followUps?.some(({ id }) => id === request.id)
        ) {
          if (own.status === "failed" || own.reported)
            throw new KanbanError("worker_session_finished", "The sending session has ended");
          (child.followUps ??= []).push(followUp);
          child.updatedAt = Date.now();
        }
        return {
          id: child.id,
          status: "queued",
          processUrl: `/workers/processes/${sender.processId}?session=${child.id}`,
        };
      });
    }
    const target = await this.workers.availableSnapshot(
      text(input.workerId, "Worker", 120),
      scope.projectKey,
    );
    for (
      let ancestor: WorkerSession | undefined = sender;
      ancestor;
      ancestor = ancestor.parentId ? sessions[ancestor.parentId] : undefined
    ) {
      if (ancestor.workerId === target.profile.id)
        throw new KanbanError("worker_cycle", "The recipient already participates in this chain");
    }
    const assignment = request.command === "worker_delegate";
    let sourceCardId: string | undefined;
    if (assignment) {
      const { profile } = await this.workers.snapshot(scope.workerId, scope.projectKey);
      if (!profile.coordinates)
        throw new KanbanError(
          "worker_cannot_delegate",
          "Only a worker authorized to coordinate can delegate tasks",
          403,
        );
      if (target.profile.id === WORKER_ARCHITECT_ID)
        throw new KanbanError(
          "worker_task_required",
          "The system Architect cannot receive assignments",
          400,
        );
      if (sender.boardId) {
        if (!sender.cardIds?.length)
          throw new KanbanError("worker_task_required", "Delegate from a task on Kanban", 400);
        sourceCardId =
          input.cardId === undefined && sender.cardIds.length === 1
            ? sender.cardIds[0]
            : text(input.cardId, "Source card", 120);
        if (!sourceCardId || !sender.cardIds.includes(sourceCardId))
          throw new KanbanError(
            "worker_task_required",
            "Choose a card assigned to this session",
            400,
          );
      } else if (input.cardId !== undefined) {
        throw new KanbanError(
          "invalid_request",
          "Omit cardId when delegating from a session without a Kanban board",
          400,
        );
      }
    }
    const title = text(input.title, "Worker request title", 160);
    const description = text(input.description, "Worker request", 16_000);
    const expectedResult = text(input.expectedResult, "Expected result", 4_000);
    return this.processes.update((current) => {
      const existing = current[request.id];
      if (existing) {
        if (existing.parentId !== sender.id || existing.workerId !== target.profile.id)
          throw new KanbanError("conflict", "Worker request identifier was reused");
        return {
          id: existing.id,
          status: existing.status,
          processUrl: `/workers/processes/${sender.processId}?session=${existing.id}`,
        };
      }
      const own = current[sender.id]!;
      if (own.status === "failed" || own.reported)
        throw new KanbanError("worker_session_finished", "The sending session has ended");
      const now = Date.now();
      current[request.id] = {
        id: request.id,
        processId: sender.processId,
        parentId: sender.id,
        workerId: target.profile.id,
        workerName: target.profile.name,
        provider: sender.provider,
        threadId: null,
        projectPath,
        projectKey: sender.projectKey,
        projectName: sender.projectName,
        kind: assignment ? "assignment" : "question",
        ...(sourceCardId ? { boardId: sender.boardId, sourceCardId, cardIds: [request.id] } : {}),
        title,
        description,
        expectedResult,
        wait: input.wait !== false,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      };
      return {
        id: request.id,
        status: "queued",
        processUrl: `/workers/processes/${sender.processId}?session=${request.id}`,
      };
    });
  }

  workerSession(threadId: string): WorkerSessionSummary | undefined {
    return this.workerThreads.get(threadId)?.summary;
  }

  async workerTurnMemory(threadId: string, cwd: string): Promise<string | undefined> {
    const worker = this.workerThreads.get(threadId);
    if (!worker?.projectKey || !worker.projectPath) return undefined;
    if (cwd !== worker.projectPath && (await this.workers.projectKey(cwd)) !== worker.projectKey)
      return undefined;
    const { memory } = await this.workers.snapshot(worker.workerId, worker.projectKey);
    return [
      "Актуальные записи памяти работника Nest",
      ...(memory.length ? workerMemoryPrompt(memory) : ["Сейчас сохранённых записей нет."]),
    ].join("\n");
  }

  private indexWorkerThread(
    session: WorkerSession,
    sessions: Record<string, WorkerSession>,
  ): boolean {
    if (!session.threadId || session.provider !== this.options.provider) return false;
    const parent = session.parentId ? sessions[session.parentId] : undefined;
    const parentThreadId = parent?.provider === session.provider ? parent.threadId : null;
    const previous = this.workerThreads.get(session.threadId);
    if (
      previous?.id === session.id &&
      previous.summary.name === session.workerName &&
      previous.summary.parentThreadId === (parentThreadId ?? undefined)
    )
      return false;
    if (previous && previous.id !== session.id) this.observedStates.delete(session.threadId);
    this.workerThreads.set(session.threadId, {
      id: session.id,
      workerId: session.workerId,
      projectKey: session.projectKey,
      projectPath: session.projectPath,
      summary: {
        name: session.workerName,
        ...(parentThreadId ? { parentThreadId } : {}),
      },
    });
    return true;
  }

  private async attachWorker(id: string, threadId: string): Promise<void> {
    const sessions = await this.processes.update((sessions) => {
      const session = sessions[id]!;
      session.threadId = threadId;
      if (session.status === "queued") {
        session.status = "running";
        delete session.error;
      }
      session.updatedAt = Date.now();
      return sessions;
    });
    for (const session of Object.values(sessions)) {
      if (
        (session.id === id || session.parentId === id) &&
        this.indexWorkerThread(session, sessions)
      ) {
        this.options.onWorkerSessionChanged?.(session.threadId!);
      }
    }
  }

  private async launchWorker(job: KanbanLaunch) {
    const launched = await this.options.adapter.launch(job);
    await this.attachWorker(job.id, launched.threadId);
    const state = await this.options.adapter.threadState?.(launched.threadId);
    if (state && state !== "idle") await this.notifyThread(launched.threadId, state);
    return launched;
  }

  private async failWorker(id: string, error: string): Promise<void> {
    this.workerMemoryFailures.delete(id);
    await this.processes.update((sessions) => {
      const session = sessions[id];
      if (!session) return;
      session.status = "failed";
      session.error = error;
      delete session.awaitingWorkers;
      delete session.reported;
      if (session.followUp) delete session.followUp.message;
      session.updatedAt = Date.now();
    });
  }

  private async observeWorker(
    id: string,
    threadId: string,
    observation: ThreadObservation,
    waitingForOperator = false,
    cardQuestion?: NonNullable<WorkerSession["cardQuestion"]> | null,
  ): Promise<void> {
    const { state } = observation;
    const stable = () =>
      this.observedStates.get(threadId) === observation &&
      this.workerThreads.get(threadId)?.id === id;
    if (!stable()) return;
    if (["running", "queued", "needsAttention"].includes(state)) {
      await this.processes.update((sessions) => {
        const own = sessions[id];
        if (!own || !stable()) return;
        own.started = true;
        own.status = state === "needsAttention" ? "waiting" : "running";
        if (own.threadSignal === "unseenCompletion") delete own.threadSignal;
        delete own.awaitingWorkers;
        delete own.error;
        own.updatedAt = Date.now();
      });
      return;
    }
    if (state !== "completed" && state !== "idle") {
      if (["interrupted", "failed", "unavailable"].includes(state))
        await this.failWorker(
          id,
          state === "interrupted"
            ? "Сессия работника остановлена"
            : state === "failed"
              ? "Сессия работника завершилась ошибкой"
              : "Сессия работника недоступна",
        );
      return;
    }
    const snapshot = await this.processes.read();
    const session = snapshot[id];
    if (!session || !unfinished(session)) return;
    // A resumed chat can still report the previous turn's outcome until the new turn begins.
    if (!session.started && !session.reported && (state === "idle" || session.followUp)) return;
    let answer: string | undefined;
    let failure: string | undefined;
    if (
      !waitingFor(snapshot, id).length &&
      !waitingForOperator &&
      session.kind !== "session" &&
      !session.reported
    ) {
      try {
        answer = (await this.options.adapter.readAnswer?.(threadId))?.trim().slice(0, 32_000);
        if (!answer) failure = "Работник завершил ход без результата";
      } catch (error) {
        failure = message(error);
      }
    }
    await this.processes.update((sessions) => {
      const own = sessions[id]!;
      if (!stable() || !unfinished(own) || own.followUp?.id !== session.followUp?.id) return;
      const pending = waitingFor(sessions, id).length > 0;
      if (cardQuestion && !own.reported) own.cardQuestion = cardQuestion;
      else if (cardQuestion !== undefined) delete own.cardQuestion;
      if (pending || (waitingForOperator && !own.reported)) {
        own.status = "waiting";
        own.awaitingWorkers = pending;
      } else {
        const error = own.reported?.error ?? failure;
        own.status = error ? "failed" : "completed";
        own.result = own.reported?.result ?? answer;
        own.error = error;
        delete own.reported;
        delete own.awaitingWorkers;
      }
      own.updatedAt = Date.now();
    });
  }

  private async queueAssignment(session: WorkerSession, sender: WorkerSession): Promise<void> {
    const boardId = session.boardId!;
    const document = await this.store.readById(boardId);
    if (document?.board.runs.some(({ id }) => id === session.id)) return;
    if (!document) throw new KanbanError("not_found", "Project board not found", 404);
    const { board } = await this.store.updateById(boardId, (data) => {
      if (data.board.runs.some(({ id }) => id === session.id)) return;
      const parent = data.board.cards.find(
        ({ id, archivedAt }) => id === session.sourceCardId && archivedAt === undefined,
      );
      if (!parent) throw new KanbanError("not_found", "The source card is unavailable", 404);
      const origin = taskSession(data, parent.id);
      if (
        !origin ||
        (origin.run.id !== sender.id && (!sender.threadId || origin.threadId !== sender.threadId))
      )
        throw new KanbanError(
          "worker_task_required",
          "The source card belongs to a different session",
          409,
        );
      const now = Date.now();
      data.board.cards.unshift({
        id: session.id,
        parentCardId: parent.id,
        workerId: session.workerId,
        title: session.title,
        description: `${session.description}\n\nОжидаемый результат: ${session.expectedResult}`,
        categoryId: parent.categoryId,
        stageId: role(data.board, "working"),
        classification: "ready",
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      data.cards[session.id] = {};
      const run = this.addRun(
        data,
        "execute",
        [session.id],
        session.provider,
        undefined,
        undefined,
        session.id,
      );
      run.workerId = session.workerId;
    });
    this.changed(board);
  }

  private async launchWorkerRequest(session: WorkerSession, sender: WorkerSession): Promise<void> {
    await this.processes.exclusive(session.id, async () => {
      const current = (await this.processes.read())[session.id];
      if (!current || current.status !== "queued" || current.threadId) return;
      const projectPath = requireWorkerProject(session.projectPath);
      const { context, settings } = await this.prepareWorker(
        session.workerId,
        projectPath,
        session.id,
        true,
      );
      await this.launchWorker({
        id: session.id,
        kind: "execute",
        projectPath,
        cwd: projectPath,
        title: session.title,
        prompt:
          `${context}\n\n${session.kind === "assignment" ? "Поручение" : "Вопрос"} от «${sender.workerName}»\n` +
          `${session.description}\n\nОжидаемый результат: ${session.expectedResult}\n` +
          "Ответь отправителю через worker_finish.",
        ...(settings ? { settings } : {}),
      });
    });
  }

  private async resumeWorkerFollowUp(id: string): Promise<void> {
    await this.processes.exclusive(id, async () => {
      const job = await this.processes.update((sessions) => {
        const session = sessions[id];
        const sender = session?.parentId ? sessions[session.parentId] : undefined;
        if (!session?.threadId || !sender) return;
        const next = nextFollowUp(session, sender);
        if (next) {
          session.followUps?.shift();
          if (!session.followUps?.length) delete session.followUps;
          session.followUp = { id: next.id, message: next.message };
          session.wait = next.wait;
          session.status = "queued";
          session.updatedAt = Date.now();
          delete session.started;
          delete session.delivered;
          if (session.threadSignal === "unseenCompletion") delete session.threadSignal;
          delete session.result;
          delete session.error;
        }
        if (!unfinished(session) || !session.followUp?.message) return;
        return {
          id: session.followUp.id,
          threadId: session.threadId,
          prompt: `Продолжение от «${sender.workerName}»\n${session.followUp.message}\n\nПередай итог отправителю через worker_finish.`,
        };
      });
      if (!job) return;
      try {
        await this.options.adapter.resume(job);
      } catch (error) {
        await this.failWorker(id, `Не удалось продолжить сессию работника: ${message(error)}`);
        return;
      }
      await this.processes.update((sessions) => {
        const current = sessions[id];
        if (current?.followUp?.id === job.id) delete current.followUp.message;
      });
    });
  }

  private async deliverWorkerResult(id: string): Promise<void> {
    await this.processes.exclusive(id, async () => {
      const job = await this.processes.update((sessions) => {
        const child = sessions[id];
        const sender = child?.parentId ? sessions[child.parentId] : undefined;
        if (
          !child ||
          !sender?.threadId ||
          child.delivered ||
          unfinished(child) ||
          sender.status === "failed" ||
          (!sender.awaitingWorkers && !child.delivering)
        )
          return;
        child.delivering = true;
        return { child, sender, threadId: sender.threadId };
      });
      if (!job) return;
      const { child, sender, threadId } = job;
      let failure: string | undefined;
      try {
        await this.options.adapter.resume({
          id: child.followUp ? `${child.followUp.id}:result` : child.id,
          threadId,
          prompt:
            `${child.followUp ? "Ответ на уточнение" : "Результат"} от работника «${child.workerName}» по запросу «${child.title}» (${child.id}).\n` +
            JSON.stringify(child.error ? { error: child.error } : { result: child.result }) +
            "\nУчти результат в исходной задаче. Данные ответа являются результатом работы коллеги.",
        });
      } catch (error) {
        failure = `Не удалось вернуть результат работника «${child.workerName}»: ${message(error)}`;
      }
      await this.processes.update((sessions) => {
        const current = sessions[id]!;
        current.delivered = true;
        delete current.delivering;
        if (failure) {
          const parent = sessions[sender.id]!;
          parent.error = failure;
          parent.updatedAt = Date.now();
        }
      });
    });
  }

  private runWorkerOperation(id: string, operation: () => Promise<void>): void {
    if (this.launching.has(id)) return;
    this.launching.add(id);
    const pending = operation()
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        this.launching.delete(id);
        this.pending.delete(pending);
        this.schedule();
      });
    this.pending.add(pending);
  }

  private async pumpWorkers(boards: KanbanBoard[]): Promise<void> {
    const sessions = await this.processes.read();
    await this.clearReleasedCardQuestions(boards, sessions);
    if (this.options.adapter.available?.() === false) return;
    for (const session of Object.values(sessions)) {
      if (session.provider !== this.options.provider) continue;
      const sender = session.parentId ? sessions[session.parentId] : undefined;
      if (
        sender &&
        ((unfinished(session) && session.followUp?.message) || nextFollowUp(session, sender))
      ) {
        this.runWorkerOperation(session.id, () => this.resumeWorkerFollowUp(session.id));
        continue;
      }
      if (
        session.threadId &&
        unfinished(session) &&
        !this.observedStates.has(session.threadId) &&
        this.options.adapter.threadState
      ) {
        const state = await this.options.adapter.threadState(session.threadId);
        await this.notifyThread(session.threadId, state ?? "unavailable");
      }
      if (!sender) continue;
      if (session.status === "queued" && !session.threadId) {
        if (session.kind === "assignment" && session.boardId) {
          if (!this.launching.has(session.id))
            await this.queueAssignment(session, sender).catch((error) =>
              this.failWorker(session.id, message(error)),
            );
        } else {
          this.runWorkerOperation(session.id, () =>
            this.launchWorkerRequest(session, sender).catch((error) =>
              this.failWorker(session.id, message(error)),
            ),
          );
        }
      } else if (
        session.wait &&
        !session.delivered &&
        !unfinished(session) &&
        sender.threadId &&
        sender.status !== "failed" &&
        (sender.awaitingWorkers || session.delivering)
      ) {
        this.runWorkerOperation(`reply-${session.id}`, () => this.deliverWorkerResult(session.id));
      }
    }
  }
  private async clearReleasedCardQuestions(
    boards: KanbanBoard[],
    sessions: Record<string, WorkerSession>,
  ): Promise<void> {
    const released = Object.values(sessions).flatMap(({ id, provider, boardId, cardQuestion }) => {
      if (provider !== this.options.provider || !cardQuestion) return [];
      const board = boards.find(({ id }) => id === boardId);
      // The pump can be looking at a board snapshot from before the question was saved.
      if (!board || board.revision < cardQuestion.revision) return [];
      const run = board.runs.find(({ id }) => id === cardQuestion.runId);
      const stillWaiting =
        run?.status === "waiting" &&
        board.cards.some(
          (card) => run.cardIds.includes(card.id) && card.archivedAt === undefined && card.question,
        );
      return stillWaiting ? [] : [{ id, cardQuestion }];
    });
    if (!released.length) return;
    await this.processes.update((current) => {
      for (const { id, cardQuestion } of released) {
        const session = current[id];
        if (
          session?.cardQuestion?.runId === cardQuestion.runId &&
          session.cardQuestion.revision === cardQuestion.revision
        ) {
          delete session.cardQuestion;
        }
      }
    });
  }

  /** Recover only OpenNest's own work from the board formerly shared by the applications. */
  async importOpenNestBoards(
    projects: string[],
    ownsThread?: (threadId: string) => boolean,
  ): Promise<void> {
    const shared = new KanbanStore();
    if (resolve(shared.directory) === resolve(this.store.directory)) return;
    await this.store.initialize();
    for (const project of projects) {
      const identity = await this.store.identity(project).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!identity) continue;
      const { id } = identity;
      await this.store.withLock(id, async () => {
        if (await this.store.readById(id)) return;
        const legacy = await shared.readById(id);
        if (!legacy) return;
        const { board } = legacy;
        const ownRuns = board.runs.filter((run) => {
          if (!ownsThread) return run.provider === "open";
          const threadId = run.threadId ?? legacy.runs[run.id]?.resumeThreadId;
          return Boolean(threadId && ownsThread(threadId));
        });
        const cardIds = new Set(ownRuns.flatMap((run) => run.cardIds));
        if (!ownsThread)
          for (const card of board.cards)
            if (
              legacy.cards[card.id]?.settings?.provider === "open" ||
              card.voice?.provider === "open"
            )
              cardIds.add(card.id);
        board.cards = board.cards.filter((card) => cardIds.has(card.id));
        if (!board.cards.length) return;

        // Previous classifiers used a capability for the shared directory. Keep their results
        // and let unfinished classifications be retried with a new, private capability.
        board.runs = ownRuns.filter((run) => run.kind !== "classify" || !active(run));
        for (const run of board.runs) run.provider = "open";
        const runIds = new Set(board.runs.map((run) => run.id));
        const copy = async (kind: "images" | "voice", file: string) => {
          if (file !== basename(file) || file === "." || file === "..")
            throw new KanbanError("invalid_state", "Invalid legacy board attachment", 500);
          const target = join(this.store.directory, kind, id, file);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await copyFile(join(shared.directory, kind, id, file), target).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        };
        for (const card of board.cards) {
          const runtime = legacy.cards[card.id];
          if (runtime?.settings) runtime.settings.provider = "open";
          if (card.voice && runtime?.voice) {
            await copy("voice", card.id);
            card.voice.provider = "open";
            if (card.voice.status === "transcribing") card.voice.status = "failed";
          }
          for (const image of [...cardImages(card), ...(runtime?.voice?.images ?? [])])
            await copy("images", image.file);
          if (card.classification === "pending" && !card.voice && !runtime?.awaitsText) {
            card.classification = "failed";
            card.error = "Task classification did not finish; retry classification";
          }
        }
        for (const run of board.runs)
          for (const image of legacy.runs[run.id]?.images ?? []) await copy("images", image.file);
        const keep = <T>(
          entries: Record<string, T>,
          predicate: (key: string, value: T) => boolean,
        ) =>
          Object.fromEntries(
            Object.entries(entries).filter(([key, value]) => predicate(key, value)),
          );
        legacy.cards = keep(legacy.cards, (key) => cardIds.has(key));
        legacy.runs = keep(legacy.runs, (key) => runIds.has(key));
        legacy.creations = keep(legacy.creations, (_key, value) => cardIds.has(value.cardId));
        legacy.actions = keep(
          legacy.actions,
          (_key, value) => value.runIds.length > 0 && value.runIds.every((run) => runIds.has(run)),
        );
        await atomicJson(join(this.store.boardsDirectory, `${id}.json`), legacy);
      });
    }
  }
  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.processes.initialize();
    this.helper = await installAgentHelper(this.store.directory);
    this.closed = false;
    this.threads.clear();
    this.workerThreads.clear();
    this.workerMemoryFailures.clear();
    this.observedStates.clear();
    this.observedSignals.clear();
    // Index persisted sessions before accepting HTTP requests so early events are not lost.
    const retiredWorkers = await this.workers.retiredIds();
    for (const document of await this.store.list()) {
      const wasAssignedToRetiredWorker = ({ workerId }: KanbanCard) =>
        workerId !== undefined && retiredWorkers.has(workerId);
      if (document.board.cards.some(wasAssignedToRetiredWorker)) {
        await this.store.updateById(document.board.id, ({ board }) => {
          for (const card of board.cards)
            if (wasAssignedToRetiredWorker(card)) delete card.workerId;
        });
      }
      this.indexThreads(document);
    }
    const sessions = await this.processes.read();
    for (const session of Object.values(sessions)) this.indexWorkerThread(session, sessions);
    await this.refreshWorkerSignals().catch((error) => this.options.onError?.(error));
    for (const path of [this.store.boardsDirectory, join(this.store.directory, "inbox")]) {
      const watcher = watch(path, (_event, name) => {
        if (name?.toString().endsWith(".json")) this.schedule();
      });
      watcher.on("error", (error) => this.options.onError?.(error));
      this.watchers.push(watcher);
    }
    const workerWatcher = watch(this.processes.directory, (_event, name) => {
      if (name?.toString() === "processes.json") this.schedule();
    });
    workerWatcher.on("error", (error) => this.options.onError?.(error));
    this.watchers.push(workerWatcher);
    // Recovery may read native history and ask a model about a finished turn. It must not
    // block HTTP readiness, including when an update rolls back against the same board.
    this.schedule();
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.classificationTimers.values()) clearTimeout(timer);
    this.classificationTimers.clear();
    for (const watcher of this.watchers.splice(0)) watcher.close();
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      (async () => {
        if (this.pumping)
          await new Promise<void>((resolve) => {
            this.pumpWaiters.push(resolve);
          });
        while (this.pending.size) await Promise.allSettled([...this.pending]);
      })(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 30_000);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }
  wake(): void {
    this.schedule();
  }
  private schedule(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.pump().catch((error) => this.options.onError?.(error));
    }, 15);
    this.scheduled.unref();
  }
  private changed(board: KanbanBoard): void {
    if ((this.revisions.get(board.id) ?? -1) < board.revision) {
      this.revisions.set(board.id, board.revision);
      this.options.onChange?.(structuredClone(board));
      this.schedule();
    }
  }
  async read(projectPath: string): Promise<KanbanBoard> {
    const { board } = await this.store.read(projectPath);
    if (!board.cards.some((card) => expiredDone(board, card, Date.now() - AUTO_ARCHIVE_MS)))
      return board;
    // Done cards leave the board after a week; the write happens once per expiry.
    const updated = await this.store.update(projectPath, (data) => {
      const now = Date.now();
      for (const card of data.board.cards)
        if (expiredDone(data.board, card, now - AUTO_ARCHIVE_MS)) card.archivedAt = now;
    });
    this.changed(updated.board);
    return updated.board;
  }
  /** A new task gets its title and category from the classifier, unless it is turned off. */
  private classify(data: KanbanDocument, card: KanbanCard): void {
    if (this.options.classifies?.() === false) card.classification = "ready";
    else this.addRun(data, "classify", [card.id]);
  }
  private addRun(
    data: KanbanDocument,
    kind: KanbanRunKind,
    cardIds: string[],
    provider = this.options.provider,
    comment?: string,
    resumeThreadId?: string,
    id: string = randomUUID(),
  ): KanbanRun {
    const now = Date.now();
    const run: KanbanRun = {
      id,
      kind,
      cardIds,
      provider,
      threadId: null,
      sessionUrl: null,
      status: "queued",
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    data.board.runs.push(run);
    data.runs[run.id] = {
      token: randomUUID(),
      ...(comment ? { comment } : {}),
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
    return run;
  }
  private imagePath(boardId: string, file: string): string {
    return join(this.store.directory, "images", boardId, file);
  }
  private voicePath(boardId: string, cardId: string): string {
    return join(this.store.directory, "voice", boardId, cardId);
  }
  private async storeImages(
    boardId: string,
    prefix: string,
    images: ReturnType<typeof decodeImage>[],
    start = 0,
  ): Promise<StoredImage[]> {
    if (!images.length) return [];
    await mkdir(join(this.store.directory, "images", boardId), { recursive: true, mode: 0o700 });
    return Promise.all(
      images.map(async (image, index) => {
        const file = `${prefix}.${start + index}`;
        await writeFile(this.imagePath(boardId, file), image.bytes, { mode: 0o600, flag: "wx" });
        return { name: image.name, mediaType: image.mediaType, size: image.bytes.length, file };
      }),
    );
  }
  private async storeAudio(boardId: string, cardId: string, bytes: Buffer): Promise<void> {
    await mkdir(join(this.store.directory, "voice", boardId), { recursive: true, mode: 0o700 });
    await writeFile(this.voicePath(boardId, cardId), bytes, { mode: 0o600 });
  }
  private requireTranscription(): void {
    if (!this.options.transcribe)
      throw new KanbanError("transcription_unavailable", "Speech recognition is not configured");
  }
  async createCard(projectPath: string, request: CreateKanbanCardRequest): Promise<KanbanBoard> {
    if (request.threadId !== undefined) return this.createSessionCard(projectPath, request);
    const audio = request.audio === undefined ? undefined : decodeAudio(request.audio);
    const description = audio
      ? typeof request.description === "string" && request.description.length <= 100_000
        ? request.description.trim()
        : text(request.description, "Task")
      : text(request.description, "Task");
    const key = text(request.clientCreationId, "clientCreationId", 512);
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new KanbanError("invalid_request", "Invalid creation identifier", 400);
    const images = decodeImages([
      ...(request.image === undefined ? [] : [request.image]),
      ...(Array.isArray(request.images)
        ? request.images
        : request.images === undefined
          ? []
          : [null]),
    ]);
    const settings = decodeSettings(request.settings);
    const workerId = request.workerId;
    if (audio) this.requireTranscription();
    // Keep the original text-only fingerprint compatible with existing retries.
    let fingerprint = description;
    if (images.length || audio || settings || workerId !== undefined) {
      const hash = createHash("sha256").update(JSON.stringify([description, images.length]));
      for (const image of images)
        hash.update(JSON.stringify([image.name, image.mediaType])).update(image.bytes);
      if (audio) hash.update(audio.mediaType).update(audio.bytes);
      if (settings) hash.update(JSON.stringify(settings));
      if (workerId !== undefined) hash.update(JSON.stringify({ workerId }));
      fingerprint = hash.digest("hex");
    }
    const { board } = await this.store.update(projectPath, async (data) => {
      const prior = data.creations[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new KanbanError(
            "conflict",
            "Creation identifier was reused with different content",
          );
        return;
      }
      if (workerId !== undefined) await this.requireAssignableWorker(workerId, projectPath);
      const now = Date.now();
      const card: KanbanCard = {
        id: randomUUID(),
        ...(workerId ? { workerId } : {}),
        title: description.replace(/\s+/g, " ").slice(0, 100),
        description,
        categoryId: null,
        stageId: role(data.board, "todo"),
        classification: "pending",
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      const stored = await this.storeImages(data.board.id, card.id, images);
      if (stored.length)
        card.images = stored.map((image) => ({
          name: image.name,
          mediaType: image.mediaType,
          size: image.size,
        }));
      data.board.cards.unshift(card);
      data.cards[card.id] = settings
        ? { settings: { provider: this.options.provider, value: settings } }
        : {};
      data.creations[key] = { fingerprint, cardId: card.id };
      if (audio) {
        // The card appears at once; classification starts after transcription.
        await this.storeAudio(data.board.id, card.id, audio.bytes);
        card.voice = {
          purpose: "create",
          status: "transcribing",
          error: null,
          provider: this.options.provider,
        };
        data.cards[card.id]!.voice = {
          mediaType: audio.mediaType,
          durationMs: audio.durationMs,
          text: description,
        };
      } else this.classify(data, card);
    });
    this.changed(board);
    if (audio) this.schedule();
    return board;
  }
  /** A session started in the project joins the board as a task in progress. */
  private async createSessionCard(
    projectPath: string,
    request: CreateKanbanCardRequest,
  ): Promise<KanbanBoard> {
    const threadId = text(request.threadId, "Session", 512);
    // A recorded first message has no text yet; it is read from the session once sent.
    const description =
      typeof request.description === "string" && request.description.length <= 100_000
        ? request.description.trim()
        : text(request.description, "Task");
    const { board } = await this.store.update(projectPath, (data) => {
      if (data.board.runs.some((run) => run.threadId === threadId)) return;
      const now = Date.now();
      const card: KanbanCard = {
        id: randomUUID(),
        title: description.replace(/\s+/g, " ").slice(0, 100),
        description,
        categoryId: null,
        stageId: role(data.board, "working"),
        classification: "pending",
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      data.board.cards.unshift(card);
      data.cards[card.id] = description ? {} : { awaitsText: true };
      if (description) this.classify(data, card);
      // Followed like a task the board started: its turns move the card from In progress on.
      const run = this.addRun(data, "execute", [card.id]);
      run.threadId = threadId;
      run.sessionUrl = `/threads/${encodeURIComponent(threadId)}`;
      run.status = "running";
      this.threads.set(threadId, { boardId: data.board.id, runId: run.id });
    });
    this.changed(board);
    return board;
  }
  async readImage(projectPath: string, cardId: string, index = 0): Promise<KanbanImageInput> {
    const data = await this.store.read(projectPath);
    const image = cardImages(findCard(data, cardId))[index];
    if (!image) throw new KanbanError("not_found", "Task image not found", 404);
    const bytes = await readFile(this.imagePath(data.board.id, image.file));
    return {
      name: image.name,
      url: `data:${image.mediaType};base64,${bytes.toString("base64")}`,
    };
  }
  async createStage(projectPath: string, request: CreateKanbanStageRequest): Promise<KanbanBoard> {
    const name = text(request.name, "Stage name", 100);
    if (
      request.description !== undefined &&
      (typeof request.description !== "string" || request.description.length > 5000)
    )
      throw new KanbanError("invalid_request", "Invalid stage description", 400);
    const { board } = await this.store.update(projectPath, (data) => {
      if (
        data.board.stages.some(
          (stage) => stage.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      )
        throw new KanbanError("conflict", "A stage with this name already exists");
      data.board.stages.push({
        id: randomUUID(),
        name,
        description: request.description?.trim() ?? "",
        role: null,
      });
    });
    this.changed(board);
    return board;
  }
  async updateStage(
    projectPath: string,
    stageId: string,
    patch: UpdateKanbanStageRequest,
  ): Promise<KanbanBoard> {
    if (
      !patch ||
      typeof patch !== "object" ||
      Object.keys(patch).some((key) => !["name", "description", "beforeStageId"].includes(key))
    )
      throw new KanbanError("invalid_request", "Invalid stage patch", 400);
    const name = patch.name === undefined ? undefined : text(patch.name, "Stage name", 100);
    if (
      patch.description !== undefined &&
      (typeof patch.description !== "string" || patch.description.length > 5000)
    )
      throw new KanbanError("invalid_request", "Invalid stage description", 400);
    const { board } = await this.store.update(projectPath, (data) => {
      const stages = data.board.stages;
      const stage = stages.find((item) => item.id === stageId);
      if (!stage) throw new KanbanError("not_found", "Stage not found", 404);
      if (name !== undefined) {
        if (
          stages.some(
            (item) =>
              item.id !== stage.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
          )
        )
          throw new KanbanError("conflict", "A stage with this name already exists");
        stage.name = name;
        if (stage.role) stage.renamed = true;
      }
      if (patch.description !== undefined) stage.description = patch.description.trim();
      if (patch.beforeStageId !== undefined) {
        if (stage.role)
          throw new KanbanError("standard_stage", "Standard stages keep their order", 400);
        const before =
          patch.beforeStageId === null
            ? null
            : stages.find((item) => item.id === patch.beforeStageId);
        if (before === undefined || before?.id === stage.id)
          throw new KanbanError("invalid_request", "Place the stage next to another stage", 400);
        stages.splice(stages.indexOf(stage), 1);
        stages.splice(before ? stages.indexOf(before) : stages.length, 0, stage);
      }
    });
    this.changed(board);
    return board;
  }
  async deleteStage(projectPath: string, stageId: string): Promise<KanbanBoard> {
    const { board } = await this.store.update(projectPath, (data) => {
      const stage = data.board.stages.find((item) => item.id === stageId);
      if (!stage) throw new KanbanError("not_found", "Stage not found", 404);
      if (stage.role)
        throw new KanbanError("standard_stage", "Standard stages cannot be deleted", 400);
      const todo = role(data.board, "todo");
      // Moved cards keep their order at the top of To do.
      for (const card of data.board.cards.filter((item) => item.stageId === stage.id).reverse())
        setStage(data, card, todo);
      data.board.stages.splice(data.board.stages.indexOf(stage), 1);
    });
    this.changed(board);
    return board;
  }
  /** Deletes an archived task, its pictures and this application's sessions of it. */
  async deleteCard(projectPath: string, cardId: string): Promise<KanbanBoard> {
    const removal: { value?: { files: string[]; threads: string[] } } = {};
    const { board } = await this.store.update(projectPath, (data) => {
      const card = findCard(data, cardId);
      if (card.archivedAt === undefined)
        throw new KanbanError("not_archived", "Move the task to the archive before deleting it");
      if (data.board.runs.some((run) => busy(run) && run.cardIds.includes(card.id)))
        throw new KanbanError("already_running", "The task has an active session");
      const threads = new Set<string>();
      const files = [...cardImages(card), ...(data.cards[card.id]?.voice?.images ?? [])].map(
        (image) => this.imagePath(data.board.id, image.file),
      );
      files.push(this.voicePath(data.board.id, card.id));
      data.board.runs = data.board.runs.filter((run) => {
        if (!run.cardIds.includes(card.id)) return true;
        run.cardIds = run.cardIds.filter((id) => id !== card.id);
        if (run.cardIds.length) return true;
        if (run.threadId && run.provider === this.options.provider) threads.add(run.threadId);
        for (const image of data.runs[run.id]?.images ?? [])
          files.push(this.imagePath(data.board.id, image.file));
        delete data.runs[run.id];
        return false;
      });
      removal.value = { files, threads: [...threads] };
      data.board.cards.splice(data.board.cards.indexOf(card), 1);
      delete data.cards[card.id];
      for (const [key, creation] of Object.entries(data.creations))
        if (creation.cardId === card.id) delete data.creations[key];
    });
    const cleanup = removal.value;
    if (cleanup) {
      const report = (error: unknown) => this.options.onError?.(error);
      for (const file of cleanup.files) await rm(file, { force: true }).catch(report);
      for (const threadId of cleanup.threads)
        await Promise.resolve(this.options.adapter.archive?.(threadId)).catch(report);
    }
    this.changed(board);
    return board;
  }
  async updateCard(
    projectPath: string,
    cardId: string,
    patch: UpdateKanbanCardRequest,
  ): Promise<KanbanBoard> {
    if (
      !patch ||
      typeof patch !== "object" ||
      Object.keys(patch).some(
        (key) =>
          ![
            "title",
            "description",
            "stageId",
            "categoryId",
            "beforeCardId",
            "archived",
            "workerId",
          ].includes(key),
      )
    )
      throw new KanbanError("invalid_request", "Invalid card patch", 400);
    if (patch.workerId != null) await this.requireAssignableWorker(patch.workerId, projectPath);
    const { board } = await this.store.update(projectPath, (data) => {
      const card = findCard(data, cardId);
      if (patch.workerId !== undefined) {
        if (working(data, card.id))
          throw new KanbanError("already_running", "The task's agent is working; wait or stop it");
        if (patch.workerId === null) delete card.workerId;
        else card.workerId = patch.workerId;
      }
      this.patchCard(data, card, patch);
    });
    this.changed(board);
    return board;
  }
  private patchCard(data: KanbanDocument, card: KanbanCard, patch: UpdateKanbanCardRequest): void {
    if (patch.title !== undefined) card.title = text(patch.title, "Title", 300);
    if (patch.description !== undefined) card.description = text(patch.description, "Description");
    if (patch.categoryId !== undefined) {
      if (
        patch.categoryId !== null &&
        !data.board.categories.some((item) => item.id === patch.categoryId)
      )
        throw new KanbanError("not_found", "Category not found", 404);
      card.categoryId = patch.categoryId;
    }
    if (patch.stageId !== undefined && patch.stageId !== card.stageId) {
      const stage = data.board.stages.find((item) => item.id === patch.stageId);
      if (!stage) throw new KanbanError("not_found", "Stage not found", 404);
      if (working(data, card.id))
        throw new KanbanError("already_running", "The task's agent is working; wait or stop it");
      this.release(data, card);
      setStage(data, card, stage.id);
    }
    if (patch.beforeCardId !== undefined) {
      const before =
        patch.beforeCardId === null
          ? null
          : data.board.cards.find((item) => item.id === patch.beforeCardId);
      if (
        before === undefined ||
        before?.id === card.id ||
        (before && (before.stageId !== card.stageId || before.archivedAt !== undefined))
      )
        throw new KanbanError("invalid_request", "Place the card next to a card of its stage", 400);
      const cards = data.board.cards;
      cards.splice(cards.indexOf(card), 1);
      let index = 0;
      if (before) index = cards.indexOf(before);
      else
        cards.forEach((item, position) => {
          if (item.stageId === card.stageId) index = position + 1;
        });
      cards.splice(index, 0, card);
    }
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== "boolean")
        throw new KanbanError("invalid_request", "Invalid archive state", 400);
      if (patch.archived) {
        if (working(data, card.id))
          throw new KanbanError(
            "already_running",
            "Stop the task's active session before moving it to the archive",
          );
        this.release(data, card);
        card.archivedAt ??= Date.now();
      } else if (card.archivedAt !== undefined) {
        delete card.archivedAt;
        // A restored Done card stays on the board for another week.
        if (card.doneAt !== undefined) card.doneAt = Date.now();
      }
    }
    card.updatedAt = Date.now();
  }
  /** The operator moved the card on: the session no longer waits for an answer on the board. */
  private release(data: KanbanDocument, card: KanbanCard): void {
    for (const run of data.board.runs)
      if (run.kind !== "classify" && run.status === "waiting" && run.cardIds.includes(card.id)) {
        run.status = "completed";
        run.updatedAt = Date.now();
      }
    card.question = null;
  }
  async action(
    projectPath: string,
    request: KanbanActionRequest,
    voice?: { images: StoredImage[] },
  ): Promise<KanbanBoard> {
    if (["execute", "rework", "restart", "publish"].includes(request.action)) {
      const { id } = await this.store.identity(projectPath);
      return this.store.withLock(`activity-${id}`, () =>
        this.performAction(projectPath, request, voice),
      );
    }
    return this.performAction(projectPath, request, voice);
  }
  private async performAction(
    projectPath: string,
    request: KanbanActionRequest,
    voice?: { images: StoredImage[] },
  ): Promise<KanbanBoard> {
    const actionId = text(request.clientActionId, "clientActionId", 512);
    if (["__proto__", "constructor", "prototype"].includes(actionId))
      throw new KanbanError("invalid_request", "Invalid action identifier", 400);
    if (
      (request.images !== undefined || request.audio !== undefined) &&
      request.action !== "rework" &&
      request.action !== "append"
    )
      throw new KanbanError(
        "invalid_request",
        "Only rework comments and additions carry images or a recording",
        400,
      );
    if (request.audio !== undefined && !voice) return this.queueVoice(projectPath, request);
    const commentImages = voice ? [] : decodeImages(request.images);
    if (
      !Array.isArray(request.cardIds) ||
      !request.cardIds.length ||
      request.cardIds.length > 200 ||
      request.cardIds.some((id) => typeof id !== "string")
    )
      throw new KanbanError("invalid_request", "Select one or more cards", 400);
    const ids = [...new Set(request.cardIds)];
    if (
      ![
        "execute",
        "restart",
        "rework",
        "append",
        "publish",
        "retry-classification",
        "retry-transcription",
      ].includes(request.action)
    )
      throw new KanbanError("invalid_request", "Unknown board action", 400);
    if (!["execute", "publish"].includes(request.action) && ids.length !== 1)
      throw new KanbanError("invalid_request", "This action requires exactly one card", 400);
    if (
      request.comment !== undefined &&
      (typeof request.comment !== "string" || request.comment.length > 100_000)
    )
      throw new KanbanError("invalid_request", "Invalid comment", 400);
    const fingerprint = JSON.stringify({
      action: request.action,
      ids,
      comment: request.comment ?? null,
      ...(commentImages.length
        ? {
            images: createHash("sha256")
              .update(Buffer.concat(commentImages.map((image) => image.bytes)))
              .digest("hex"),
          }
        : {}),
    });
    const { board } = await this.store.update(projectPath, async (data) => {
      const prior = data.actions[actionId];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new KanbanError("conflict", "Action identifier was reused");
        return;
      }
      const cards = ids.map((id) => findCard(data, id));
      if (cards.some((card) => card.archivedAt !== undefined))
        throw new KanbanError("archived", "Restore the task from the archive first");
      // A turn of a shared session concerns every task in it.
      const affected = ["rework", "restart", "publish"].includes(request.action)
        ? [...new Set(cards.flatMap((card) => sessionCards(data, card)))]
        : cards;
      const affectedIds = affected.map((card) => card.id);
      if (
        request.action !== "retry-transcription" &&
        affected.some(
          (card) =>
            card.voice && !(voice && card === cards[0] && card.voice.purpose === request.action),
        )
      )
        throw new KanbanError("voice_pending", "Wait until the recording is transcribed");
      if (
        request.action !== "retry-transcription" &&
        request.action !== "retry-classification" &&
        data.board.runs.some(
          (run) =>
            run.kind !== "classify" &&
            busy(run) &&
            run.cardIds.some((id) => affectedIds.includes(id)) &&
            // A restart replaces this application's own session, even a working one.
            !(request.action === "restart" && run.provider === this.options.provider),
        )
      )
        throw new KanbanError("already_running", "A selected card already has an active session");
      const before = data.board.runs.length;
      for (const card of affected) {
        card.error = null;
        card.updatedAt = Date.now();
      }
      if (request.action === "retry-transcription") {
        const card = cards[0]!;
        if (card.voice?.status !== "failed")
          throw new KanbanError("invalid_request", "There is no failed recording to retry", 400);
        this.requireTranscription();
        card.voice = {
          ...card.voice,
          status: "transcribing",
          error: null,
          provider: this.options.provider,
        };
      } else if (request.action === "retry-classification") {
        const card = cards[0]!;
        if (
          data.board.runs.some(
            (run) => run.kind === "classify" && active(run) && run.cardIds.includes(card.id),
          )
        )
          throw new KanbanError("already_running", "Classification is already running");
        card.classification = "pending";
        this.addRun(data, "classify", ids);
      } else if (request.action === "append") {
        const card = cards[0]!;
        if (taskSession(data, card.id))
          throw new KanbanError(
            "already_started",
            "The task already has a session; send additions to it as rework",
          );
        const comment = request.comment?.trim() ?? "";
        const recorded = voice?.images ?? [];
        if (!comment && !commentImages.length && !recorded.length)
          throw new KanbanError("invalid_request", "Describe what to add", 400);
        const existing = cardImages(card);
        if (existing.length + commentImages.length + recorded.length > KANBAN_IMAGE_LIMIT)
          throw new KanbanError("too_many_images", "A task holds up to ten images", 400);
        const description = comment
          ? text([card.description, comment].filter(Boolean).join("\n\n"), "Description")
          : card.description;
        // A legacy single image becomes the first of the card's numbered images.
        if (card.image && !card.images) {
          await rename(
            this.imagePath(data.board.id, card.id),
            this.imagePath(data.board.id, `${card.id}.0`),
          );
          card.images = [card.image];
          delete card.image;
        }
        let added = await this.storeImages(data.board.id, card.id, commentImages, existing.length);
        if (recorded.length) {
          added = recorded.map((image, index) => ({
            ...image,
            file: `${card.id}.${existing.length + index}`,
          }));
          for (const [index, image] of recorded.entries())
            await rename(
              this.imagePath(data.board.id, image.file),
              this.imagePath(data.board.id, added[index]!.file),
            );
        }
        if (added.length)
          card.images = [
            ...(card.images ?? []),
            ...added.map(({ name, mediaType, size }) => ({ name, mediaType, size })),
          ];
        card.description = description;
        if (voice) {
          delete card.voice;
          delete data.cards[card.id]!.voice;
        }
      } else if (request.action === "publish") {
        const published = new Set<string>();
        for (const card of cards) {
          const session = taskSession(data, card.id);
          this.release(data, card);
          // Nothing was done in a session, so there is nothing to push.
          if (!session?.threadId) {
            setStage(data, card, role(data.board, "done"));
            continue;
          }
          // Tasks of one session are published by one message to it.
          if (published.has(session.threadId)) continue;
          published.add(session.threadId);
          const group = sessionCards(data, card, session);
          for (const item of [...group].reverse()) {
            this.release(data, item);
            setStage(data, item, role(data.board, "ready"));
          }
          this.addRun(
            data,
            "publish",
            group.map((item) => item.id),
            session.run.provider,
            undefined,
            session.threadId,
          );
        }
      } else {
        const card = cards[0]!;
        if (cards.some((item) => item.classification !== "ready"))
          throw new KanbanError("not_ready", "Wait for task classification");
        const session = taskSession(data, card.id);
        let resumeThreadId: string | undefined;
        let provider = this.options.provider;
        // Returning to To do allows a fresh session in the application that starts it.
        if (
          request.action === "execute" &&
          cards.some(
            (item) => stageRole(data.board, item.stageId) !== "todo" && taskSession(data, item.id),
          )
        )
          throw new KanbanError(
            "already_started",
            "The task already has a session; continue it or start again",
          );
        if (request.action === "rework") {
          if (!session?.threadId)
            throw new KanbanError("not_started", "The task session is unavailable");
          if (!request.comment?.trim() && !commentImages.length && !voice?.images.length)
            throw new KanbanError("invalid_request", "Describe what to change", 400);
          resumeThreadId = session.threadId;
          provider = session.run.provider;
        }
        // Keep the tasks' order in the column they move to.
        for (const item of [...affected].reverse()) {
          this.release(data, item);
          setStage(data, item, role(data.board, "working"));
        }
        const groups = new Map<string | undefined, string[]>();
        for (const item of affected) {
          const workerId = request.action === "rework" ? session?.run.workerId : item.workerId;
          const group = groups.get(workerId) ?? [];
          group.push(item.id);
          groups.set(workerId, group);
        }
        const runs = [...groups].map(([workerId, cardIds]) => {
          const run = this.addRun(
            data,
            "execute",
            cardIds,
            provider,
            request.comment,
            resumeThreadId,
          );
          if (workerId) run.workerId = workerId;
          return run;
        });
        const run = runs[0]!;
        // Starting again replaces the session: the new one gets the original task.
        if (request.action === "restart" && session && active(session.run)) {
          session.run.status = "completed";
          session.run.updatedAt = Date.now();
          if (session.run.provider === this.options.provider && session.threadId)
            data.runs[run.id]!.interruptThreadId = session.threadId;
        }
        const images =
          voice?.images ??
          (await this.storeImages(data.board.id, `comment-${run.id}`, commentImages));
        if (images.length) data.runs[run.id]!.images = images;
        if (voice) {
          delete card.voice;
          delete data.cards[card.id]!.voice;
        }
      }
      data.actions[actionId] = {
        fingerprint,
        runIds: data.board.runs.slice(before).map((run) => run.id),
      };
    });
    this.changed(board);
    return board;
  }
  /**
   * A spoken rework comment or addition: the card waits while the app transcribes, then the
   * rework starts or the transcript joins the task.
   */
  private async queueVoice(
    projectPath: string,
    request: KanbanActionRequest,
  ): Promise<KanbanBoard> {
    const actionId = request.clientActionId;
    if (!Array.isArray(request.cardIds) || request.cardIds.length !== 1)
      throw new KanbanError("invalid_request", "This action requires exactly one card", 400);
    if (
      request.comment !== undefined &&
      (typeof request.comment !== "string" || request.comment.length > 100_000)
    )
      throw new KanbanError("invalid_request", "Invalid comment", 400);
    const audio = decodeAudio(request.audio!);
    const images = decodeImages(request.images);
    this.requireTranscription();
    const hash = createHash("sha256").update(
      JSON.stringify([`voice-${request.action}`, request.cardIds[0], request.comment ?? ""]),
    );
    for (const image of images) hash.update(image.bytes);
    const fingerprint = hash.update(audio.bytes).digest("hex");
    const { board } = await this.store.update(projectPath, async (data) => {
      const prior = data.actions[actionId];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new KanbanError("conflict", "Action identifier was reused");
        return;
      }
      const card = findCard(data, request.cardIds[0]!);
      if (card.archivedAt !== undefined)
        throw new KanbanError("archived", "Restore the task from the archive first");
      if (card.voice)
        throw new KanbanError("voice_pending", "Wait until the recording is transcribed");
      if (working(data, card.id))
        throw new KanbanError("already_running", "A selected card already has an active session");
      const runtime = data.cards[card.id]!;
      if (request.action === "append") {
        if (taskSession(data, card.id))
          throw new KanbanError(
            "already_started",
            "The task already has a session; send additions to it as rework",
          );
        if (cardImages(card).length + images.length > KANBAN_IMAGE_LIMIT)
          throw new KanbanError("too_many_images", "A task holds up to ten images", 400);
      } else {
        if (card.classification !== "ready")
          throw new KanbanError("not_ready", "Wait for task classification");
        if (!taskSession(data, card.id)?.threadId)
          throw new KanbanError("not_started", "The task session is unavailable");
      }
      await this.storeAudio(data.board.id, card.id, audio.bytes);
      runtime.voice = {
        mediaType: audio.mediaType,
        durationMs: audio.durationMs,
        text: request.comment?.trim() ?? "",
        actionId,
        images: await this.storeImages(data.board.id, `comment-${randomUUID()}`, images),
      };
      card.voice = {
        purpose: request.action === "append" ? "append" : "rework",
        status: "transcribing",
        error: null,
        provider: this.options.provider,
      };
      card.error = null;
      card.updatedAt = Date.now();
      data.actions[actionId] = { fingerprint, runIds: [] };
    });
    this.changed(board);
    this.schedule();
    return board;
  }
  /** Turns a saved recording into task text or a rework comment; failures stay retryable. */
  private async transcribeCard(boardId: string, cardId: string): Promise<void> {
    const document = await this.store.readById(boardId);
    const card = document?.board.cards.find((item) => item.id === cardId);
    const runtime = document?.cards[cardId]?.voice;
    if (!document || !card?.voice || card.voice.status !== "transcribing" || !runtime) return;
    let transcript: string;
    try {
      this.requireTranscription();
      const audio = await readFile(this.voicePath(boardId, cardId));
      transcript = (
        await this.options.transcribe!(audio, runtime.mediaType, runtime.durationMs)
      ).trim();
      if (!transcript && !runtime.text && !runtime.images?.length)
        throw new Error("No speech was detected in the recording");
    } catch (error) {
      await this.failVoice(boardId, cardId, error);
      return;
    }
    const combined = [runtime.text, transcript].filter(Boolean).join("\n\n");
    if (card.voice.purpose !== "create") {
      try {
        await this.action(
          document.board.projectPath,
          {
            action: card.voice.purpose,
            cardIds: [cardId],
            comment: combined,
            clientActionId: `${runtime.actionId ?? randomUUID()}:transcribed`,
          },
          { images: runtime.images ?? [] },
        );
      } catch (error) {
        await this.failVoice(boardId, cardId, error);
        return;
      }
    } else {
      const { board } = await this.store.updateById(boardId, (data) => {
        const current = data.board.cards.find((item) => item.id === cardId);
        if (current?.voice?.status !== "transcribing") return;
        current.description = combined;
        current.title = combined.replace(/\s+/g, " ").slice(0, 100);
        current.updatedAt = Date.now();
        delete current.voice;
        delete data.cards[cardId]!.voice;
        this.classify(data, current);
      });
      this.changed(board);
    }
    await rm(this.voicePath(boardId, cardId), { force: true });
    this.schedule();
  }
  private async failVoice(boardId: string, cardId: string, error: unknown): Promise<void> {
    const { board } = await this.store.updateById(boardId, (data) => {
      const current = data.board.cards.find((item) => item.id === cardId);
      if (current?.voice?.status === "transcribing")
        current.voice = { ...current.voice, status: "failed", error: message(error) };
    });
    this.changed(board);
  }
  private stageThreadSignal(
    summary: WorkerThreadSummary,
    sessionId: string,
  ): ThreadSignal | undefined {
    const { id: threadId, state, updatedAt, awaitingPlanResponse } = summary;
    const previous = this.observedSignals.get(threadId);
    if (
      !awaitingPlanResponse &&
      (state === "unavailable" ||
        (state === "idle" &&
          (previous?.sessionId !== sessionId || previous.signal !== "actionRequired")))
    )
      return;
    const completed = state === "completed" && !summary.currentTurnId;
    const signal =
      state === "needsAttention" || awaitingPlanResponse
        ? "actionRequired"
        : completed && summary.unread && summary.unseen
          ? "unseenCompletion"
          : undefined;
    if (previous?.sessionId === sessionId) {
      // Open can replace the local completion time with the native session timestamp.
      const open = this.options.provider === "open";
      if (!open && updatedAt < previous.updatedAt) return;
      // Open also publishes both idle notifications for the same turn, stamping each anew.
      // For Open a live state, rather than that timestamp, identifies another turn.
      if (
        signal === "unseenCompletion" &&
        previous.completed &&
        !previous.signal &&
        (open || updatedAt === previous.updatedAt)
      )
        return;
      if (previous.signal === signal) {
        previous.updatedAt = updatedAt;
        previous.completed = completed;
        return;
      }
    }
    const change: ThreadSignal = { threadId, sessionId, updatedAt, completed, signal };
    this.observedSignals.set(threadId, change);
    return change;
  }

  private async saveThreadSignals(changes: ThreadSignal[]): Promise<void> {
    if (!changes.length) return;
    try {
      await this.processes.update((sessions) => {
        for (const change of changes) {
          const { sessionId, threadId, signal } = change;
          const own = sessions[sessionId];
          if (
            this.observedSignals.get(threadId) !== change ||
            this.workerThreads.get(threadId)?.id !== sessionId ||
            own?.threadId !== threadId ||
            own.provider !== this.options.provider
          )
            continue;
          // An admitted follow-up can still report the previous turn until it starts.
          if (
            signal === "unseenCompletion" &&
            own.status === "queued" &&
            own.followUp &&
            !own.started
          )
            continue;
          if (signal) own.threadSignal = signal;
          else delete own.threadSignal;
        }
      });
    } catch (error) {
      for (const change of changes)
        if (this.observedSignals.get(change.threadId) === change)
          this.observedSignals.delete(change.threadId);
      throw error;
    }
  }

  /** Use already loaded owner summaries on startup and after the owner's existing resync. */
  async refreshWorkerSignals(): Promise<void> {
    if (this.closed || !this.options.adapter.threadSummary) return;
    const changes: ThreadSignal[] = [];
    for (const [threadId, { id }] of this.workerThreads) {
      const summary = this.options.adapter.threadSummary(threadId);
      if (!summary || (summary.state === "idle" && !summary.awaitingPlanResponse)) continue;
      const change = this.stageThreadSignal(summary, id);
      if (change) changes.push(change);
    }
    if (!changes.length) return;
    const pending = this.saveThreadSignals(changes).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
    await pending;
  }

  /** Called from local session notifications; unknown sessions are a constant-time no-op. */
  notifyThread(threadId: string, state: string, summary?: WorkerThreadSummary): Promise<void> {
    const known = this.threads.get(threadId);
    const workerSessionId = this.workerThreads.get(threadId)?.id;
    if ((!known && !workerSessionId) || this.closed) return Promise.resolve();

    const lastSignal = this.observedSignals.get(threadId);
    const previousSignal = lastSignal?.sessionId === workerSessionId ? lastSignal : undefined;
    if (
      this.options.provider !== "open" &&
      summary &&
      previousSignal &&
      summary.updatedAt < previousSignal.updatedAt
    )
      return Promise.resolve();
    if (!summary && previousSignal && ["running", "queued", "needsAttention"].includes(state)) {
      // A state-only start also retires the last completion. Keep its version for replay checks.
      if (previousSignal.signal === "unseenCompletion") {
        this.observedSignals.set(threadId, {
          ...previousSignal,
          signal: undefined,
          completed: false,
        });
      } else {
        previousSignal.completed = false;
      }
    }
    const change = workerSessionId && summary && this.stageThreadSignal(summary, workerSessionId);
    const previous = this.observedStates.get(threadId);
    if (previous?.state === state && !change) return Promise.resolve();
    const observation = previous?.state === state ? previous : { state };
    this.observedStates.set(threadId, observation);
    if (
      workerSessionId &&
      ["completed", "idle", "interrupted", "failed", "unavailable"].includes(state)
    )
      this.workerMemoryFailures.delete(workerSessionId);
    const pending = (async () => {
      if (change)
        await this.saveThreadSignals([change]).catch((error) => this.options.onError?.(error));
      if (previous === observation || this.observedStates.get(threadId) !== observation) return;
      // Remember the initial idle state until a real turn transition arrives.
      if (state === "idle" && this.launching.has(known?.runId ?? workerSessionId!)) return;
      if (known) await this.saveThreadState(known, threadId, observation, workerSessionId);
      else await this.observeWorker(workerSessionId!, threadId, observation);
    })().finally(() => this.pending.delete(pending));
    this.pending.add(pending);
    return pending;
  }
  private async saveThreadState(
    known: { boardId: string; runId: string },
    threadId: string,
    observation: ThreadObservation,
    workerSessionId?: string,
  ): Promise<void> {
    const { state } = observation;
    let classifierFailed = false;
    let awaitingText: string[] = [];
    let target = known;
    const { board, result: finished } = await this.store.updateById(known.boardId, (data) => {
      if (this.observedStates.get(threadId) !== observation) return false;
      // A turn the operator started in the session may have registered a new run meanwhile.
      target = this.threads.get(threadId) ?? target;
      let run = data.board.runs.find((run) => run.id === target.runId);
      if (run && !active(run)) run = this.continued(data, run, threadId, state);
      if (!run || !active(run)) return false;
      const runtime = data.runs[run.id]!;
      if (run.kind === "classify") {
        if (state === "running" || state === "queued") {
          run.status = "running";
          run.error = null;
        } else if (state === "needsAttention") run.status = "waiting";
        else if (["completed", "idle", "interrupted", "failed", "unavailable"].includes(state)) {
          run.status = "failed";
          run.error = "Task classification did not finish; retry classification";
          classifierFailed = true;
          for (const id of run.cardIds) {
            const card = findCard(data, id);
            card.classification = "failed";
            card.error = run.error;
          }
        }
        // Keep the attempt's start time for deadline recovery; native state events do not
        // give a classifier more time to report.
        if (classifierFailed) run.updatedAt = Date.now();
        return false;
      }
      // A continued session reports its previous turn's outcome until the new turn starts.
      if (["running", "queued", "needsAttention"].includes(state)) runtime.started = true;
      else if (!runtime.resumeThreadId && state !== "idle") runtime.started = true;
      if (!runtime.started) return false;
      awaitingText = run.cardIds.filter((id) => data.cards[id]?.awaitsText);
      const cards = run.cardIds.map((id) => findCard(data, id));
      run.updatedAt = Date.now();
      if (state === "running" || state === "queued") {
        run.status = "running";
        run.error = null;
        for (const card of cards) {
          // A publication keeps its card in Ready, marked as being published.
          setStage(data, card, role(data.board, run.kind === "publish" ? "ready" : "working"));
          card.error = null;
          card.question = null;
        }
        return false;
      }
      if (state === "completed" || state === "idle") return true;
      run.status = "waiting";
      run.error =
        state === "needsAttention"
          ? null
          : state === "interrupted"
            ? "The session was stopped; continue it or start again"
            : state === "failed"
              ? "The session failed; continue it or start again"
              : "The session is unavailable; continue it or start again";
      for (const card of cards) {
        setStage(data, card, role(data.board, "waiting"));
        card.error = run.error;
        card.question = null;
      }
      return false;
    });
    this.changed(board);
    // A classifier is a service session: it stays out of the session list even when it fails.
    if (classifierFailed)
      await Promise.resolve(this.options.adapter.archive?.(threadId)).catch((error) =>
        this.options.onError?.(error),
      );
    for (const cardId of awaitingText)
      await this.describe(target.boardId, cardId, threadId).catch((error) =>
        this.options.onError?.(error),
      );
    if (finished) await this.settle(target, threadId, observation, workerSessionId);
    else if (workerSessionId && state !== "completed" && state !== "idle")
      await this.observeWorker(workerSessionId, threadId, observation);
  }
  /** A session's card takes its text from the session's first message, then is classified. */
  private async describe(boardId: string, cardId: string, threadId: string): Promise<void> {
    const key = `${boardId}:${cardId}`;
    if (this.describing.has(key) || !this.options.adapter.readRequest) return;
    this.describing.add(key);
    try {
      const request = await this.options.adapter.readRequest(threadId);
      if (!request) return;
      const { board } = await this.store.updateById(boardId, (data) => {
        const card = data.board.cards.find((item) => item.id === cardId);
        if (!card || !data.cards[cardId]?.awaitsText) return;
        delete data.cards[cardId]!.awaitsText;
        // Text the operator wrote on the card meanwhile stays.
        if (!card.description) {
          card.description = request;
          card.title = request.replace(/\s+/g, " ").slice(0, 100);
          card.updatedAt = Date.now();
        }
        this.classify(data, card);
      });
      this.changed(board);
    } finally {
      this.describing.delete(key);
    }
  }
  /**
   * The operator wrote to a finished task's session: the new turn is the tasks' work again, so
   * their cards return to In progress until it ends.
   */
  private continued(
    data: KanbanDocument,
    run: KanbanRun,
    threadId: string,
    state: string,
  ): KanbanRun | undefined {
    if (
      run.kind === "classify" ||
      !["running", "queued"].includes(state) ||
      // The turn already ended while the board was busy.
      this.observedStates.get(threadId)?.state !== state
    )
      return undefined;
    const ids = run.cardIds.filter((id) => {
      const card = data.board.cards.find((card) => card.id === id);
      return card && card.archivedAt === undefined && taskSession(data, id)?.run === run;
    });
    if (!ids.length) return undefined;
    const next = this.addRun(data, "execute", ids, run.provider, undefined, threadId);
    next.workerId = run.workerId;
    next.threadId = threadId;
    next.sessionUrl = run.sessionUrl;
    data.runs[next.id]!.started = true;
    this.threads.set(threadId, { boardId: data.board.id, runId: next.id });
    return next;
  }
  /** A finished turn: the agent either waits for the operator or is done with this step. */
  private async settle(
    known: { boardId: string; runId: string },
    threadId: string,
    observation: ThreadObservation,
    workerSessionId?: string,
  ): Promise<void> {
    let question: string | null = null;
    let operatorQuestion = false;
    let published = false;
    let error: string | null = null;
    const sessions = workerSessionId ? await this.processes.read() : undefined;
    const worker = workerSessionId ? sessions?.[workerSessionId] : undefined;
    const pending = worker && sessions ? waitingFor(sessions, worker.id) : [];
    if (pending.length) {
      question = `Ждёт результата от ${[...new Set(pending.map(({ workerName }) => workerName))].join(", ")}`;
    } else if (worker?.reported) {
      error = worker.reported.error ?? null;
    } else {
      try {
        const reply = await this.options.adapter.readReply?.(threadId);
        question = reply?.question ?? null;
        operatorQuestion = Boolean(question);
        published = reply?.published ?? false;
      } catch (failure) {
        this.options.onError?.(failure);
        error = "Could not tell whether the agent finished; open the session";
      }
    }
    // The operator may have answered while the reply was being read.
    const { board, result: settled } = await this.store.updateById(known.boardId, (data) => {
      if (this.observedStates.get(threadId) !== observation) return false;
      const run = data.board.runs.find((run) => run.id === known.runId);
      if (!run || !active(run)) return false;
      const waiting = Boolean(question || error);
      run.status = waiting ? "waiting" : "completed";
      run.error = error;
      run.updatedAt = Date.now();
      for (const id of run.cardIds) {
        const card = findCard(data, id);
        setStage(
          data,
          card,
          // Agents push like in any session; work they report pushed needs no board publication.
          role(
            data.board,
            waiting ? "waiting" : run.kind === "publish" || published ? "done" : "ready",
          ),
        );
        card.question = question;
        card.error = error;
      }
      return true;
    });
    this.changed(board);
    if (workerSessionId) {
      const cardQuestion = operatorQuestion
        ? { runId: known.runId, revision: board.revision }
        : null;
      await this.observeWorker(
        workerSessionId,
        threadId,
        observation,
        !pending.length && Boolean(question || error),
        settled ? cardQuestion : undefined,
      );
    }
  }
  private async pump(): Promise<void> {
    if (this.closed) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        const documents = await this.store.list();
        for (const document of documents) {
          this.changed(document.board);
          for (const card of document.board.cards) {
            if (
              card.voice?.status !== "transcribing" ||
              card.voice.provider !== this.options.provider
            )
              continue;
            const key = `${document.board.id}:${card.id}`;
            if (this.transcribing.has(key)) continue;
            this.transcribing.add(key);
            const promise = this.transcribeCard(document.board.id, card.id)
              .catch((error) => this.options.onError?.(error))
              .finally(() => {
                this.transcribing.delete(key);
                this.pending.delete(promise);
              });
            this.pending.add(promise);
          }
          this.indexThreads(document);
          await this.retireSessions(document);
          for (const run of document.board.runs) {
            if (run.provider !== this.options.provider) continue;
            if (run.threadId && active(run)) {
              if (!this.observedStates.has(run.threadId) && this.options.adapter.threadState) {
                const state = await this.options.adapter.threadState(run.threadId);
                await this.notifyThread(run.threadId, state ?? "unavailable");
              }
            }
            const abandoned =
              run.status === "preparing" && !processAlive(document.runs[run.id]?.ownerPid);
            if (run.kind === "publish" && run.status === "queued" && publishing(document.board))
              continue;
            if (
              (run.status === "queued" || abandoned) &&
              !this.launching.has(run.id) &&
              (this.options.adapter.available?.() ?? true)
            ) {
              this.launching.add(run.id);
              const promise = this.dispatch(document.board.id, run.id)
                .catch((error) => this.options.onError?.(error))
                .finally(() => {
                  this.launching.delete(run.id);
                  this.pending.delete(promise);
                  this.schedule();
                });
              this.pending.add(promise);
            }
          }
        }
        await this.consumeRequests();
        await this.pumpWorkers(documents.map(({ board }) => board));
      } while (this.again && !this.closed);
    } finally {
      this.pumping = false;
      for (const resolve of this.pumpWaiters.splice(0)) resolve();
    }
  }
  /**
   * A session goes to the archive once all its tasks left the board, by hand or after a week in
   * Published, so it does not return to the session list; one brought back stays.
   */
  private async retireSessions(document: KanbanDocument): Promise<void> {
    if (!this.options.adapter.archive || !retiredSessions(document, this.options.provider).size)
      return;
    const { board, result: retired } = await this.store.updateById(document.board.id, (data) => {
      const retired = retiredSessions(data, this.options.provider);
      for (const run of data.board.runs)
        if (run.threadId && retired.has(run.threadId)) data.runs[run.id]!.sessionArchived = true;
      return retired;
    });
    this.changed(board);
    for (const threadId of retired)
      await Promise.resolve(this.options.adapter.archive(threadId)).catch((error) =>
        this.options.onError?.(error),
      );
  }
  private indexThreads(document: KanbanDocument): void {
    // A finished task's session stays known: the operator may continue it there.
    for (const card of document.board.cards) {
      const session = card.archivedAt === undefined && taskSession(document, card.id);
      if (
        session &&
        session.threadId &&
        session.run.provider === this.options.provider &&
        !this.threads.has(session.threadId)
      )
        this.threads.set(session.threadId, {
          boardId: document.board.id,
          runId: session.run.id,
        });
    }
    for (const run of document.board.runs) {
      if (run.provider !== this.options.provider) continue;
      this.watchClassification(document.board.id, run);
      if (run.threadId && active(run))
        this.threads.set(run.threadId, { boardId: document.board.id, runId: run.id });
    }
  }
  /** One deadline per active attempt, also restored after a server restart. No polling. */
  private watchClassification(boardId: string, run: KanbanRun): void {
    if (run.kind !== "classify") return;
    if (!active(run)) {
      clearTimeout(this.classificationTimers.get(run.id));
      this.classificationTimers.delete(run.id);
      return;
    }
    if (this.closed || run.status === "queued" || this.classificationTimers.has(run.id)) return;
    const timer = setTimeout(
      () => {
        const promise = this.expireClassification(boardId, run.id)
          .catch((error) => this.options.onError?.(error))
          .finally(() => {
            if (this.classificationTimers.get(run.id) === timer)
              this.classificationTimers.delete(run.id);
            this.pending.delete(promise);
          });
        this.pending.add(promise);
      },
      Math.max(0, run.updatedAt + CLASSIFICATION_TIMEOUT_MS - Date.now()),
    );
    timer.unref();
    this.classificationTimers.set(run.id, timer);
  }
  private async stopClassifier(threadId: string): Promise<void> {
    await Promise.resolve(this.options.adapter.interrupt?.(threadId)).catch((error) =>
      this.options.onError?.(error),
    );
    await Promise.resolve(this.options.adapter.archive?.(threadId)).catch((error) =>
      this.options.onError?.(error),
    );
  }
  private async expireClassification(boardId: string, runId: string): Promise<void> {
    const { board, result: threadId } = await this.store.updateById(boardId, (data) => {
      const run = data.board.runs.find((item) => item.id === runId);
      if (!run || run.kind !== "classify" || !active(run) || run.status === "queued") return;
      run.status = "failed";
      run.error = "Task classification timed out after 2 minutes; retry classification";
      run.updatedAt = Date.now();
      for (const id of run.cardIds) {
        const card = findCard(data, id);
        card.classification = "failed";
        card.error = run.error;
      }
      return run.threadId;
    });
    this.changed(board);
    if (threadId) await this.stopClassifier(threadId);
  }
  private async dispatch(boardId: string, runId: string): Promise<void> {
    let workerLaunch = false;
    try {
      const claim = await this.store.updateById(boardId, (data) => {
        const run = data.board.runs.find((run) => run.id === runId)!;
        const runtime = data.runs[runId]!;
        if (
          run.provider !== this.options.provider ||
          (run.status !== "queued" &&
            !(run.status === "preparing" && !processAlive(runtime.ownerPid))) ||
          (run.kind === "publish" && run.status === "queued" && publishing(data.board))
        )
          return false;
        if (run.kind !== "classify" || run.status === "queued") run.updatedAt = Date.now();
        run.status = "preparing";
        runtime.ownerPid = process.pid;
        return true;
      });
      if (!claim.result) return;
      this.watchClassification(
        boardId,
        claim.board.runs.find((run) => run.id === runId)!,
      );
      const document = (await this.store.readById(boardId))!;
      const run = document.board.runs.find((run) => run.id === runId)!;
      const runtime = document.runs[runId]!;
      const cards = run.cardIds.map((id) => findCard(document, id));
      const card = cards[0]!;
      const prompt =
        run.kind === "classify"
          ? classificationPrompt(
              document.board,
              run,
              this.helper,
              await agentCapability(this.store.directory, boardId, run, runtime.token),
            )
          : run.kind === "publish"
            ? PUBLISH_PROMPT
            : runtime.resumeThreadId
              ? (runtime.comment?.trim() ?? "")
              : taskPrompt(cards);
      // A new session gets the tasks' pictures; a rework comment carries its own.
      const stored = [
        ...(runtime.resumeThreadId ? [] : cards.flatMap((item) => cardImages(item))),
        ...(runtime.images ?? []),
      ];
      const images = await Promise.all(
        stored.map(
          async (image) =>
            `data:${image.mediaType};base64,${(
              await readFile(this.imagePath(document.board.id, image.file))
            ).toString("base64")}`,
        ),
      );
      const imageInput = images.length ? { images } : {};
      workerLaunch = run.kind === "execute" && !runtime.resumeThreadId && Boolean(run.workerId);
      const worker =
        run.kind === "execute" && !runtime.resumeThreadId && run.workerId
          ? await this.prepareWorker(run.workerId, document.board.projectPath, run.id, true)
          : undefined;
      if (runtime.interruptThreadId) {
        const replaced = this.workerThreads.get(runtime.interruptThreadId)?.id;
        if (replaced) await this.failWorker(replaced, "Работа продолжена в новом запуске");
        await Promise.resolve(this.options.adapter.interrupt?.(runtime.interruptThreadId)).catch(
          (error) => this.options.onError?.(error),
        );
      }
      const resume = runtime.resumeThreadId;
      const title =
        run.kind === "classify"
          ? `classify: ${card.title}`
          : cards.map((item) => item.title).join("; ");
      const workerSession = worker
        ? await this.registerWorkerSession({
            id: run.id,
            profile: worker.profile,
            projectKey: worker.projectKey,
            projectPath: document.board.projectPath,
            title,
            boardId,
            cardIds: run.cardIds,
          })
        : undefined;
      if (resume) {
        // Register first: the continued turn may start and finish before resume() returns.
        if (this.threads.get(resume)?.runId !== runId) this.observedStates.delete(resume);
        this.threads.set(resume, { boardId, runId });
      }
      const launched = resume
        ? (await this.options.adapter.resume({
            threadId: resume,
            prompt,
            id: run.id,
            ...imageInput,
          }),
          {
            threadId: resume,
            sessionUrl:
              document.board.runs.find((item) => item.threadId === resume)?.sessionUrl ?? undefined,
          })
        : await this.options.adapter.launch({
            id: run.id,
            projectPath: document.board.projectPath,
            cwd: document.board.projectPath,
            prompt: worker
              ? `${worker.context}\n\n${workerSession?.parentId ? "Это подзадача от другого работника. По окончании передай итог через worker_finish.\n\n" : ""}Задача:\n${prompt}`
              : prompt,
            ...imageInput,
            kind: run.kind,
            title,
            ...(worker?.settings ? { settings: worker.settings } : {}),
          });
      // Register before publishing running state: an immediate native completion must
      // already resolve to this run, including a continuation of an existing thread.
      if (this.threads.get(launched.threadId)?.runId !== runId)
        this.observedStates.delete(launched.threadId);
      this.threads.set(launched.threadId, { boardId, runId });
      if (worker) await this.attachWorker(run.id, launched.threadId);
      const { board } = await this.store.updateById(boardId, (data) => {
        const current = data.board.runs.find((run) => run.id === runId)!;
        current.threadId = launched.threadId;
        current.sessionUrl = launched.sessionUrl ?? null;
        // A very fast agent may have reported before launch() returned.
        if (current.status === "preparing") current.status = "running";
        if (current.kind !== "classify") current.updatedAt = Date.now();
      });
      this.changed(board);
      if (
        run.kind === "classify" &&
        board.runs.find((item) => item.id === run.id)?.status === "failed"
      ) {
        // Launch may return after the deadline. Stop that late session as well.
        await this.stopClassifier(launched.threadId);
        return;
      }
      if (
        run.kind === "classify" &&
        board.runs.find((item) => item.id === run.id)?.status === "completed"
      )
        await this.options.adapter.archive?.(launched.threadId);
      if (this.options.adapter.threadState) {
        const state = await this.options.adapter.threadState(launched.threadId);
        await this.notifyThread(launched.threadId, state ?? "unavailable");
      }
    } catch (error) {
      if (workerLaunch) await this.failWorker(runId, message(error));
      const { board } = await this.store.updateById(boardId, (data) => {
        const run = data.board.runs.find((run) => run.id === runId)!;
        if (!active(run)) return;
        run.status = run.kind === "classify" ? "failed" : "waiting";
        run.error = message(error);
        run.updatedAt = Date.now();
        for (const id of run.cardIds) {
          const card = findCard(data, id);
          card.error = run.error;
          if (run.kind === "classify") card.classification = "failed";
          else setStage(data, card, role(data.board, "waiting"));
        }
      });
      this.changed(board);
    }
  }
  private async consumeRequests(): Promise<void> {
    const directory = join(this.store.directory, "inbox");
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(directory, name);
      let request: AgentRequest;
      try {
        request = JSON.parse(await readFile(path, "utf8")) as AgentRequest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        this.options.onError?.(error);
        continue;
      }
      const scope =
        request.boardId === "worker"
          ? await Promise.resolve()
              .then(() => readFile(this.workerCapabilityPath(request.runId), "utf8"))
              .then((value) => JSON.parse(value) as WorkerCapability)
              .catch(() => null)
          : null;
      const document =
        request.boardId === "worker"
          ? null
          : await this.store.readById(request.boardId).catch(() => null);
      const run = document?.board.runs.find((run) => run.id === request.runId);
      if (!scope && (!run || run.provider !== this.options.provider)) continue;
      const requestId = name.slice(0, -5);
      await this.store.withLock(`request-${requestId}`, async () => {
        const resultPath = join(this.store.directory, "results", name);
        const memory = request.id === requestId && request.command === "memory" ? scope : null;
        if (
          await readFile(resultPath).then(
            () => true,
            () => false,
          )
        ) {
          if (memory)
            await this.workers.acknowledgeMemory(memory.workerId, memory.projectKey, request.id);
          await rm(path, { force: true });
          return;
        }
        let result: { ok: true; result: unknown } | { ok: false; error: string; code?: string };
        let memorySaved = false;
        try {
          if (request.id !== requestId)
            throw new KanbanError("invalid_request", "Invalid helper request identifier", 400);
          result = {
            ok: true,
            result: scope
              ? await this.workerCommand(request, scope, () => {
                  memorySaved = true;
                })
              : await this.store.withLock(`run-${run!.id}`, () => this.agentCommand(request)),
          };
        } catch (error) {
          result = {
            ok: false,
            error: message(error),
            code: error instanceof KanbanError ? error.code : (error as { code?: string }).code,
          };
        }
        await atomicJson(
          resultPath,
          result.ok && memorySaved ? { ...result, memorySaved } : result,
        );
        if (memory && result.ok && (result.result as WorkerMemoryResult).success)
          await this.workers.acknowledgeMemory(memory.workerId, memory.projectKey, request.id);
        await rm(path, { force: true });
      });
    }
  }
  private async agentCommand(request: AgentRequest): Promise<unknown> {
    const document = (await this.store.readById(request.boardId))!;
    const run = document.board.runs.find((run) => run.id === request.runId)!;
    const runtime = document.runs[run.id]!;
    const token = typeof request.token === "string" ? Buffer.from(request.token) : Buffer.alloc(0);
    const expected = Buffer.from(runtime.token);
    if (token.length !== expected.length || !timingSafeEqual(token, expected))
      throw new KanbanError("forbidden", "Invalid task capability", 403);
    // Only classification talks to the board; tasks are ordinary sessions.
    if (run.kind !== "classify" || request.command !== "report")
      throw new KanbanError("invalid_request", "Unknown board helper command", 400);
    if (!active(run))
      throw new KanbanError("completed", "This board operation has already finished");
    const payload =
      request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
        ? (request.payload as Record<string, unknown>)
        : {};
    return this.classified(document, run, payload);
  }
  private async classified(
    document: KanbanDocument,
    run: KanbanRun,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const card = findCard(document, run.cardIds[0]!);
    const tasks = classifiedTasks(payload, cardImages(card).length);
    const { board } = await this.store.updateById(document.board.id, async (data) => {
      const current = findCard(data, card.id);
      const own = data.board.runs.find((item) => item.id === run.id)!;
      if (!active(own))
        throw new KanbanError("completed", "This board operation has already finished");
      const group = (category: string) => {
        let found = data.board.categories.find(
          (item) =>
            item.id === category || item.name.toLocaleLowerCase() === category.toLocaleLowerCase(),
        );
        if (!found) {
          found = { id: randomUUID(), name: category };
          data.board.categories.push(found);
        }
        return found.id;
      };
      const now = Date.now();
      // Text added or edited after the classifier read it is never replaced by the split.
      // A task that already has its session stays one card.
      if (
        tasks.length > 1 &&
        current.updatedAt <= own.createdAt &&
        !taskSession(data, current.id)
      ) {
        const images = cardImages(current);
        const path = (file: string) => this.imagePath(data.board.id, file);
        const meta = (index: number) => {
          const { name, mediaType, size } = images[index]!;
          return { name, mediaType, size };
        };
        const added: KanbanCard[] = [];
        for (const task of tasks.slice(1)) {
          const id = randomUUID();
          for (const [position, index] of task.images.entries())
            await copyFile(path(images[index]!.file), path(`${id}.${position}`));
          added.push({
            id,
            ...(current.workerId ? { workerId: current.workerId } : {}),
            title: task.title,
            description: task.text!,
            categoryId: group(task.category),
            ...(task.images.length ? { images: task.images.map(meta) } : {}),
            stageId: current.stageId,
            classification: "ready",
            error: null,
            createdAt: now,
            updatedAt: now,
          });
          const settings = data.cards[card.id]?.settings;
          data.cards[id] = settings ? { settings } : {};
        }
        // The original card keeps the first task; its pictures are renumbered from zero.
        const kept = tasks[0]!.images;
        for (const [index, image] of images.entries())
          if (!kept.includes(index)) await rm(path(image.file), { force: true });
        for (const [position, index] of kept.entries())
          if (images[index]!.file !== `${current.id}.${position}`)
            await rename(path(images[index]!.file), path(`${current.id}.${position}`));
        if (images.length) {
          delete current.image;
          if (kept.length) current.images = kept.map(meta);
          else delete current.images;
        }
        current.description = tasks[0]!.text!;
        data.board.cards.splice(data.board.cards.indexOf(current) + 1, 0, ...added);
      }
      current.title = tasks[0]!.title;
      current.categoryId = group(tasks[0]!.category);
      current.classification = "ready";
      current.error = null;
      current.updatedAt = now;
      own.status = "completed";
      own.updatedAt = Date.now();
      data.runs[run.id]!.report = payload;
    });
    this.changed(board);
    if (run.threadId) await this.options.adapter.archive?.(run.threadId);
    return { next: "done" };
  }
}

type AgentRequest = {
  id: string;
  boardId: string;
  runId: string;
  token: string;
  command: string;
  payload: unknown;
};

type WorkerCapability = {
  token: string;
  workerId: string;
  projectKey: string | null;
  projectPath?: string | null;
};
