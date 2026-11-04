import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  SessionSettings,
  UpdateKanbanCardRequest,
  UpdateKanbanStageRequest,
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
} from "./agent.js";
import {
  atomicJson,
  KanbanError,
  KanbanStore,
  processAlive,
  type KanbanDocument,
  type StoredImage,
} from "./store.js";

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
export type KanbanProviderAdapter = {
  available?(): boolean;
  launch(input: KanbanLaunch): Promise<{ threadId: string; sessionUrl?: string }>;
  resume(input: { threadId: string; prompt: string; id: string; images?: string[] }): Promise<void>;
  archive?(threadId: string): Promise<void>;
  /** Stops a session that a restart replaces. */
  interrupt?(threadId: string): Promise<void>;
  threadState?(threadId: string): Promise<string | null> | string | null;
  /**
   * Reads the session's last reply after a finished turn: a short reason when the agent waits
   * for the operator (a question, a decision, a failure), or null when its work is done.
   */
  awaitsAnswer?(threadId: string): Promise<string | null>;
};
export type KanbanServiceOptions = {
  provider: KanbanProvider;
  adapter: KanbanProviderAdapter;
  /** The application's speech recognition; recordings fail clearly without it. */
  transcribe?(audio: Buffer, contentType: string, durationMs: number): Promise<string>;
  dataDir?: string;
  onChange?: (board: KanbanBoard) => void;
  onError?: (error: unknown) => void;
};
const active = (run: KanbanRun) =>
  ["queued", "preparing", "running", "waiting"].includes(run.status);
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
const stageRole = (board: KanbanBoard, stageId: string) =>
  board.stages.find((stage) => stage.id === stageId)?.role ?? null;
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

export class KanbanService {
  readonly store: KanbanStore;
  private watchers: FSWatcher[] = [];
  private pumping = false;
  private again = false;
  private closed = true;
  private helper = "";
  private launching = new Set<string>();
  private transcribing = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private pumpWaiters: (() => void)[] = [];
  private threads = new Map<string, { boardId: string; runId: string }>();
  private revisions = new Map<string, number>();
  private observedStates = new Map<string, string>();
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly options: KanbanServiceOptions) {
    this.store = new KanbanStore(options.dataDir);
  }
  async initialize(): Promise<void> {
    await this.store.initialize();
    this.helper = await installAgentHelper(this.store.directory);
    this.closed = false;
    this.threads.clear();
    this.observedStates.clear();
    for (const path of [this.store.boardsDirectory, join(this.store.directory, "inbox")]) {
      const watcher = watch(path, (_event, name) => {
        if (name?.toString().endsWith(".json")) this.schedule();
      });
      watcher.on("error", (error) => this.options.onError?.(error));
      this.watchers.push(watcher);
    }
    await this.pump();
  }
  async close(): Promise<void> {
    this.closed = true;
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
  private addRun(
    data: KanbanDocument,
    kind: KanbanRunKind,
    cardIds: string[],
    provider = this.options.provider,
    comment?: string,
    resumeThreadId?: string,
  ): KanbanRun {
    const now = Date.now();
    const run: KanbanRun = {
      id: randomUUID(),
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
  ): Promise<StoredImage[]> {
    if (!images.length) return [];
    await mkdir(join(this.store.directory, "images", boardId), { recursive: true, mode: 0o700 });
    return Promise.all(
      images.map(async (image, index) => {
        const file = `${prefix}.${index}`;
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
    if (audio) this.requireTranscription();
    // Keep the original text-only fingerprint compatible with existing retries.
    let fingerprint = description;
    if (images.length || audio || settings) {
      const hash = createHash("sha256").update(JSON.stringify([description, images.length]));
      for (const image of images)
        hash.update(JSON.stringify([image.name, image.mediaType])).update(image.bytes);
      if (audio) hash.update(audio.mediaType).update(audio.bytes);
      if (settings) hash.update(JSON.stringify(settings));
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
      const now = Date.now();
      const card: KanbanCard = {
        id: randomUUID(),
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
      } else this.addRun(data, "classify", [card.id]);
    });
    this.changed(board);
    if (audio) this.schedule();
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
          !["title", "description", "stageId", "categoryId", "beforeCardId", "archived"].includes(
            key,
          ),
      )
    )
      throw new KanbanError("invalid_request", "Invalid card patch", 400);
    const { board } = await this.store.update(projectPath, (data) =>
      this.patchCard(data, findCard(data, cardId), patch),
    );
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
      request.action !== "rework"
    )
      throw new KanbanError(
        "invalid_request",
        "Only rework comments carry images or a recording",
        400,
      );
    if (request.audio !== undefined && !voice) return this.queueVoiceRework(projectPath, request);
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
          (card) => card.voice && !(voice && card === cards[0] && card.voice.purpose === "rework"),
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
        if (request.action === "execute" && cards.some((item) => taskSession(data, item.id)))
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
        const run = this.addRun(
          data,
          "execute",
          affectedIds,
          provider,
          request.comment,
          resumeThreadId,
        );
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
  /** A spoken rework comment: the card waits while the app transcribes, then rework starts. */
  private async queueVoiceRework(
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
      JSON.stringify(["voice-rework", request.cardIds[0], request.comment ?? ""]),
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
      if (card.classification !== "ready")
        throw new KanbanError("not_ready", "Wait for task classification");
      const runtime = data.cards[card.id]!;
      if (!taskSession(data, card.id)?.threadId)
        throw new KanbanError("not_started", "The task session is unavailable");
      await this.storeAudio(data.board.id, card.id, audio.bytes);
      runtime.voice = {
        mediaType: audio.mediaType,
        durationMs: audio.durationMs,
        text: request.comment?.trim() ?? "",
        actionId,
        images: await this.storeImages(data.board.id, `comment-${randomUUID()}`, images),
      };
      card.voice = {
        purpose: "rework",
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
      if (!transcript && !runtime.text) throw new Error("No speech was detected in the recording");
    } catch (error) {
      await this.failVoice(boardId, cardId, error);
      return;
    }
    const combined = [runtime.text, transcript].filter(Boolean).join("\n\n");
    if (card.voice.purpose === "rework") {
      try {
        await this.action(
          document.board.projectPath,
          {
            action: "rework",
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
        this.addRun(data, "classify", [cardId]);
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
  /** Called from local session notifications; unknown sessions are a constant-time no-op. */
  async notifyThread(threadId: string, state: string): Promise<void> {
    const known = this.threads.get(threadId);
    if (!known || this.closed || this.observedStates.get(threadId) === state) return;
    this.observedStates.set(threadId, state);
    // Remember the initial idle state until a real turn transition arrives.
    if (state === "idle" && this.launching.has(known.runId)) return;
    let classifierFailed = false;
    let target = known;
    const { board, result: finished } = await this.store.updateById(known.boardId, (data) => {
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
        run.updatedAt = Date.now();
        return false;
      }
      // A continued session reports its previous turn's outcome until the new turn starts.
      if (["running", "queued", "needsAttention"].includes(state)) runtime.started = true;
      else if (!runtime.resumeThreadId && state !== "idle") runtime.started = true;
      if (!runtime.started) return false;
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
    if (finished) await this.settle(target, threadId, state);
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
      this.observedStates.get(threadId) !== state
    )
      return undefined;
    const ids = run.cardIds.filter((id) => {
      const card = data.board.cards.find((card) => card.id === id);
      return card && card.archivedAt === undefined && taskSession(data, id)?.run === run;
    });
    if (!ids.length) return undefined;
    const next = this.addRun(data, "execute", ids, run.provider, undefined, threadId);
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
    state: string,
  ): Promise<void> {
    let question: string | null = null;
    let error: string | null = null;
    try {
      question = (await this.options.adapter.awaitsAnswer?.(threadId)) ?? null;
    } catch (failure) {
      this.options.onError?.(failure);
      error = "Could not tell whether the agent finished; open the session";
    }
    // The operator may have answered while the reply was being read.
    if (this.observedStates.get(threadId) !== state) return;
    const { board } = await this.store.updateById(known.boardId, (data) => {
      const run = data.board.runs.find((run) => run.id === known.runId);
      if (!run || !active(run)) return;
      const waiting = Boolean(question || error);
      run.status = waiting ? "waiting" : "completed";
      run.error = error;
      run.updatedAt = Date.now();
      for (const id of run.cardIds) {
        const card = findCard(data, id);
        setStage(
          data,
          card,
          role(data.board, waiting ? "waiting" : run.kind === "publish" ? "done" : "ready"),
        );
        card.question = question;
        card.error = error;
      }
    });
    this.changed(board);
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
            if (run.threadId && active(run)) {
              this.threads.set(run.threadId, { boardId: document.board.id, runId: run.id });
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
      } while (this.again && !this.closed);
    } finally {
      this.pumping = false;
      for (const resolve of this.pumpWaiters.splice(0)) resolve();
    }
  }
  private async dispatch(boardId: string, runId: string): Promise<void> {
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
        run.status = "preparing";
        runtime.ownerPid = process.pid;
        run.updatedAt = Date.now();
        return true;
      });
      if (!claim.result) return;
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
      // Tasks sent together start with the first settings chosen in this application.
      const chosen = cards
        .map((item) => document.cards[item.id]?.settings)
        .find((value) => value?.provider === this.options.provider);
      if (runtime.interruptThreadId)
        await Promise.resolve(this.options.adapter.interrupt?.(runtime.interruptThreadId)).catch(
          (error) => this.options.onError?.(error),
        );
      const resume = runtime.resumeThreadId;
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
            prompt,
            ...imageInput,
            kind: run.kind,
            title:
              run.kind === "classify"
                ? `classify: ${card.title}`
                : cards.map((item) => item.title).join("; "),
            ...(run.kind === "execute" && chosen?.provider === this.options.provider
              ? { settings: chosen.value }
              : {}),
          });
      // Register before publishing running state: an immediate native completion must
      // already resolve to this run, including a continuation of an existing thread.
      if (this.threads.get(launched.threadId)?.runId !== runId)
        this.observedStates.delete(launched.threadId);
      this.threads.set(launched.threadId, { boardId, runId });
      const { board } = await this.store.updateById(boardId, (data) => {
        const current = data.board.runs.find((run) => run.id === runId)!;
        current.threadId = launched.threadId;
        current.sessionUrl = launched.sessionUrl ?? null;
        // A very fast agent may have reported before launch() returned.
        if (current.status === "preparing") current.status = "running";
        current.updatedAt = Date.now();
      });
      this.changed(board);
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
      const document = await this.store.readById(request.boardId).catch(() => null);
      if (!document) continue;
      const run = document.board.runs.find((run) => run.id === request.runId);
      if (!run || run.provider !== this.options.provider) continue;
      await this.store.withLock(`request-${name.slice(0, -5)}`, async () => {
        const resultPath = join(this.store.directory, "results", name);
        if (
          await readFile(resultPath).then(
            () => true,
            () => false,
          )
        ) {
          await rm(path, { force: true });
          return;
        }
        let result: unknown;
        try {
          if (request.id !== name.slice(0, -5))
            throw new KanbanError("invalid_request", "Invalid helper request identifier", 400);
          result = {
            ok: true,
            result: await this.store.withLock(`run-${run.id}`, () => this.agentCommand(request)),
          };
        } catch (error) {
          result = {
            ok: false,
            error: message(error),
            code: error instanceof KanbanError ? error.code : (error as { code?: string }).code,
          };
        }
        await atomicJson(resultPath, result);
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
    const title = text(payload.title, "Task title", 300);
    const category = text(payload.category, "Category", 100);
    const { board } = await this.store.updateById(document.board.id, (data) => {
      const current = findCard(data, card.id);
      let group = data.board.categories.find(
        (item) =>
          item.id === category || item.name.toLocaleLowerCase() === category.toLocaleLowerCase(),
      );
      if (!group) {
        group = { id: randomUUID(), name: category };
        data.board.categories.push(group);
      }
      current.title = title;
      current.categoryId = group.id;
      current.classification = "ready";
      current.error = null;
      current.updatedAt = Date.now();
      const own = data.board.runs.find((item) => item.id === run.id)!;
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
