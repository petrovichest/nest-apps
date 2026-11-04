import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  UpdateKanbanCardRequest,
  UpdateKanbanStageRequest,
} from "@codexnest/protocol";
import {
  KANBAN_AUDIO_MAX_BYTES,
  KANBAN_IMAGE_LIMIT,
  KANBAN_IMAGE_MAX_BYTES,
} from "@codexnest/protocol";
import { agentCapability, agentPrompt, installAgentHelper } from "./agent.js";
import {
  atomicJson,
  KanbanError,
  KanbanStore,
  processAlive,
  type CardRuntime,
  type KanbanDocument,
  type StoredImage,
} from "./store.js";
import {
  createTaskWorkspace,
  prepareRepository,
  validateTaskWorkspace,
  prepareIntegrationWorkspace,
  validateIntegrationWorkspace,
  publishIntegrationRepository,
  removeTaskWorkspace,
  type RepositoryResult,
  type WorkspaceRepository,
  type IntegrationWorkspace,
} from "./workspace.js";

export type KanbanLaunch = {
  id: string;
  projectPath: string;
  cwd: string;
  prompt: string;
  images?: string[];
  kind: KanbanRunKind;
  title: string;
};
export type KanbanProviderAdapter = {
  available?(): boolean;
  launch(input: KanbanLaunch): Promise<{ threadId: string; sessionUrl?: string }>;
  resume(input: { threadId: string; prompt: string; id: string; images?: string[] }): Promise<void>;
  archive?(threadId: string): Promise<void>;
  /** Stops a session that a restart replaces. */
  interrupt?(threadId: string): Promise<void>;
  threadState?(threadId: string): Promise<string | null> | string | null;
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
const activeFor = (data: KanbanDocument, cardId: string) =>
  data.board.runs.some(
    (run) => run.kind !== "classify" && active(run) && run.cardIds.includes(cardId),
  );
const PROVIDERS: readonly KanbanProvider[] = ["codex", "claude"];
/** Each application's newest execution is its agent's current session on the task. */
function agentRuns(data: KanbanDocument, cardId: string): Map<KanbanProvider, KanbanRun> {
  const latest = new Map<KanbanProvider, KanbanRun>();
  for (const run of data.board.runs)
    if (run.kind === "execute" && run.cardIds.includes(cardId)) latest.set(run.provider, run);
  return latest;
}
/** An agent's newest submitted result since it last started from a clean copy. */
function agentResult(data: KanbanDocument, cardId: string, provider: KanbanProvider) {
  const runs = data.board.runs.filter(
    (run) => run.kind === "execute" && run.provider === provider && run.cardIds.includes(cardId),
  );
  for (const run of runs.reverse()) {
    const runtime = data.runs[run.id];
    if (runtime?.results && runtime.workspace)
      return { provider, workspace: runtime.workspace, results: runtime.results };
    if (!runtime?.resumeThreadId) return undefined;
  }
  return undefined;
}
/** The result an operator acts on: the named agent's, or the only one submitted. */
function chosenResult(data: KanbanDocument, cardId: string, provider?: KanbanProvider) {
  if (provider) {
    const result = agentResult(data, cardId, provider);
    if (!result) throw new KanbanError("no_result", "This agent has not submitted a result");
    return result;
  }
  const results = PROVIDERS.flatMap((item) => agentResult(data, cardId, item) ?? []);
  if (results.length > 1)
    throw new KanbanError("choose_result", "Both agents submitted results; choose one of them");
  return results[0];
}
/** Another agent still working or holding a result sends the outcome to review. */
const rivalAgent = (data: KanbanDocument, cardId: string, provider: KanbanProvider) =>
  [...agentRuns(data, cardId).values()].some(
    (run) => run.provider !== provider && (active(run) || agentResult(data, cardId, run.provider)),
  );
const findCard = (data: KanbanDocument, id: string) => {
  const card = data.board.cards.find((card) => card.id === id);
  if (!card) throw new KanbanError("not_found", "Card not found", 404);
  return card;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sameResults = (a: RepositoryResult[], b: RepositoryResult[]) =>
  JSON.stringify(a.map((item) => [item.repository.id, item.sha]).sort()) ===
  JSON.stringify(b.map((item) => [item.repository.id, item.sha]).sort());

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
      workspacePath: null,
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
    if (audio) this.requireTranscription();
    // Keep the original text-only fingerprint compatible with existing retries.
    let fingerprint = description;
    if (images.length || audio) {
      const hash = createHash("sha256").update(JSON.stringify([description, images.length]));
      for (const image of images)
        hash.update(JSON.stringify([image.name, image.mediaType])).update(image.bytes);
      if (audio) hash.update(audio.mediaType).update(audio.bytes);
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
        scope: "task",
        repositories: [],
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
      data.cards[card.id] = {};
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
  /** Deletes an archived task, its worktrees and this application's sessions of it. */
  async deleteCard(projectPath: string, cardId: string): Promise<KanbanBoard> {
    const removal: {
      value?: {
        boardId: string;
        files: string[];
        workspaces: NonNullable<CardRuntime["workspace"]>[];
        threads: string[];
      };
    } = {};
    const { board } = await this.store.update(projectPath, (data) => {
      const card = findCard(data, cardId);
      if (card.archivedAt === undefined)
        throw new KanbanError("not_archived", "Move the task to the archive before deleting it");
      if (data.board.runs.some((run) => active(run) && run.cardIds.includes(card.id)))
        throw new KanbanError("already_running", "The task has an active session");
      const threads: string[] = [];
      // Every agent and restart has its own copy; keep the newest record of each.
      const workspaces = new Map<string, NonNullable<CardRuntime["workspace"]>>();
      for (const workspace of [
        data.cards[card.id]?.workspace,
        ...data.board.runs
          .filter((run) => run.cardIds.includes(card.id))
          .map((run) => data.runs[run.id]?.workspace),
      ])
        if (
          workspace &&
          (workspaces.get(workspace.id)?.repositories.length ?? -1) < workspace.repositories.length
        )
          workspaces.set(workspace.id, workspace);
      const files = [...cardImages(card), ...(data.cards[card.id]?.voice?.images ?? [])].map(
        (image) => this.imagePath(data.board.id, image.file),
      );
      files.push(this.voicePath(data.board.id, card.id));
      data.board.runs = data.board.runs.filter((run) => {
        if (!run.cardIds.includes(card.id)) return true;
        run.cardIds = run.cardIds.filter((id) => id !== card.id);
        if (run.cardIds.length) return true;
        if (run.threadId && run.provider === this.options.provider) threads.push(run.threadId);
        for (const image of data.runs[run.id]?.images ?? [])
          files.push(this.imagePath(data.board.id, image.file));
        delete data.runs[run.id];
        return false;
      });
      removal.value = {
        boardId: data.board.id,
        files,
        workspaces: [...workspaces.values()],
        threads,
      };
      data.board.cards.splice(data.board.cards.indexOf(card), 1);
      delete data.cards[card.id];
      for (const [key, creation] of Object.entries(data.creations))
        if (creation.cardId === card.id) delete data.creations[key];
    });
    const cleanup = removal.value;
    if (cleanup) {
      const report = (error: unknown) => this.options.onError?.(error);
      for (const file of cleanup.files) await rm(file, { force: true }).catch(report);
      for (const workspace of cleanup.workspaces)
        await removeTaskWorkspace(workspace, join(this.store.directory, "workspaces")).catch(
          report,
        );
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
    if (patch.stageId !== undefined) {
      const stage = data.board.stages.find((item) => item.id === patch.stageId);
      if (!stage) throw new KanbanError("not_found", "Stage not found", 404);
      if (stage.role === "done") {
        const runtime = data.cards[card.id]!;
        const acceptedWithoutCode = runtime.acceptedResults?.length === 0;
        if (
          !acceptedWithoutCode &&
          (!card.repositories.length ||
            !card.repositories.every((repo) => repo.status === "published"))
        )
          throw new KanbanError(
            "not_published",
            "Changed repositories must be published before Done",
          );
      }
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
        if (activeFor(data, card.id))
          throw new KanbanError(
            "already_running",
            "Stop the task's active session before moving it to the archive",
          );
        card.archivedAt ??= Date.now();
      } else if (card.archivedAt !== undefined) {
        delete card.archivedAt;
        // A restored Done card stays on the board for another week.
        if (card.doneAt !== undefined) card.doneAt = Date.now();
      }
    }
    card.updatedAt = Date.now();
  }
  async action(
    projectPath: string,
    request: KanbanActionRequest,
    voice?: { images: StoredImage[] },
  ): Promise<KanbanBoard> {
    if (["execute", "rework", "restart"].includes(request.action)) {
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
        "review",
        "accept",
        "rework",
        "integrate",
        "retry-classification",
        "retry-transcription",
      ].includes(request.action)
    )
      throw new KanbanError("invalid_request", "Unknown board action", 400);
    if (request.action !== "integrate" && ids.length !== 1)
      throw new KanbanError("invalid_request", "This action requires exactly one card", 400);
    if (
      request.comment !== undefined &&
      (typeof request.comment !== "string" || request.comment.length > 100_000)
    )
      throw new KanbanError("invalid_request", "Invalid comment", 400);
    if (request.provider !== undefined && !PROVIDERS.includes(request.provider))
      throw new KanbanError("invalid_request", "Unknown agent application", 400);
    if (["accept", "review"].includes(request.action)) {
      const snapshot = await this.store.read(projectPath);
      const candidate =
        chosenResult(snapshot, ids[0]!, request.provider) ?? snapshot.cards[ids[0]!];
      if (candidate?.workspace && candidate.results) {
        const actual = (await validateTaskWorkspace(candidate.workspace)).filter(
          (item) => item.changed !== false,
        );
        if (!sameResults(actual, candidate.results))
          throw new KanbanError(
            "result_changed",
            "The task result changed; submit it again before acceptance",
          );
      }
    }
    const fingerprint = JSON.stringify({
      action: request.action,
      ids,
      comment: request.comment ?? null,
      ...(request.provider ? { provider: request.provider } : {}),
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
      if (
        request.action !== "retry-transcription" &&
        cards.some((card) => card.voice && !(voice && card.voice.purpose === "rework"))
      )
        throw new KanbanError("voice_pending", "Wait until the recording is transcribed");
      const agents = agentRuns(data, ids[0]!);
      const chosen = ["accept", "review"].includes(request.action)
        ? chosenResult(data, ids[0]!, request.provider)
        : undefined;
      // The agent an action concerns; the other application's agent may keep working meanwhile.
      const agent =
        request.action === "execute"
          ? this.options.provider
          : request.action === "rework" || request.action === "restart"
            ? (request.provider ??
              (agents.size === 1 ? [...agents.keys()][0]! : this.options.provider))
            : request.action === "accept"
              ? chosen?.provider
              : undefined;
      if (
        data.board.runs.some(
          (run) =>
            run.kind !== "classify" &&
            active(run) &&
            run.cardIds.some((id) => ids.includes(id)) &&
            !(
              run.kind === "execute" &&
              agent !== undefined &&
              (run.provider !== agent || request.action === "restart")
            ),
        )
      )
        throw new KanbanError("already_running", "A selected card already has an active session");
      const before = data.board.runs.length;
      for (const card of cards) {
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
      } else if (
        request.action === "execute" ||
        request.action === "rework" ||
        request.action === "restart"
      ) {
        const card = cards[0]!;
        if (card.classification !== "ready")
          throw new KanbanError("not_ready", "Wait for task classification");
        const runtime = data.cards[card.id]!;
        const current = agents.get(agent!);
        if (request.action === "execute") {
          if (current)
            throw new KanbanError(
              "already_started",
              "This application's agent already has the task; use rework or restart",
            );
          if (
            runtime.acceptedResults !== undefined ||
            stageRole(data.board, card.stageId) === "done"
          )
            throw new KanbanError("already_accepted", "The task result was already accepted");
        } else if (request.action === "rework" && !current?.threadId)
          throw new KanbanError("not_started", "The original task session is unavailable");
        else if (request.action === "restart") {
          if (!current) throw new KanbanError("not_started", "This agent has not started the task");
          if (stageRole(data.board, card.stageId) === "done")
            throw new KanbanError("already_done", "The task is already done");
        }
        delete runtime.acceptedResults;
        for (const repository of card.repositories) {
          repository.status = "working";
          repository.error = null;
        }
        setStage(data, card, role(data.board, "working"));
        const run = this.addRun(
          data,
          "execute",
          ids,
          agent,
          request.comment,
          request.action === "rework" ? current!.threadId! : undefined,
        );
        runtime.executionRunId ??= run.id;
        // A restart replaces the agent's session: the new one starts from a clean copy.
        if (request.action === "restart" && active(current!)) {
          current!.status = "completed";
          current!.updatedAt = Date.now();
          if (current!.threadId) data.runs[run.id]!.interruptThreadId = current!.threadId;
        }
        const images =
          voice?.images ??
          (await this.storeImages(data.board.id, `comment-${run.id}`, commentImages));
        if (images.length) data.runs[run.id]!.images = images;
        if (voice) {
          delete card.voice;
          delete runtime.voice;
        }
      } else if (request.action === "accept") {
        if (chosen) this.useResult(data, cards[0]!, chosen);
        // The other agent's session ends with the choice; its copy and branch stay as they are.
        for (const run of agents.values())
          if (run.provider !== chosen?.provider && active(run)) {
            run.status = "completed";
            run.updatedAt = Date.now();
          }
        this.accept(data, cards[0]!);
      } else if (request.action === "review") {
        if (chosen) this.useResult(data, cards[0]!, chosen);
        const runtime = data.cards[cards[0]!.id]!;
        if (!runtime.results)
          throw new KanbanError("no_result", "The executor has not submitted a result");
        this.addRun(data, "review", ids, this.options.provider, request.comment);
      } else {
        for (const card of cards)
          if (!data.cards[card.id]?.acceptedResults?.length)
            throw new KanbanError("not_accepted", "Select accepted cards with repository changes");
        const keys = new Set(
          cards.flatMap((card) =>
            data.cards[card.id]!.acceptedResults!.map(
              (result) => `${result.repository.gitCommonDir}\0${result.repository.targetBranch}`,
            ),
          ),
        );
        if (
          data.board.runs.some(
            (run) =>
              run.kind === "integrate" &&
              active(run) &&
              run.cardIds.some((id) =>
                data.cards[id]?.acceptedResults?.some((result) =>
                  keys.has(`${result.repository.gitCommonDir}\0${result.repository.targetBranch}`),
                ),
              ),
          )
        )
          throw new KanbanError("integration_busy", "A target branch is already being integrated");
        this.addRun(data, "integrate", ids, this.options.provider, request.comment);
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
    if (request.provider !== undefined && !PROVIDERS.includes(request.provider))
      throw new KanbanError("invalid_request", "Unknown agent application", 400);
    const audio = decodeAudio(request.audio!);
    const images = decodeImages(request.images);
    this.requireTranscription();
    const hash = createHash("sha256").update(
      JSON.stringify([
        "voice-rework",
        request.cardIds[0],
        request.comment ?? "",
        ...(request.provider ? [request.provider] : []),
      ]),
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
      if (activeFor(data, card.id))
        throw new KanbanError("already_running", "A selected card already has an active session");
      if (card.classification !== "ready")
        throw new KanbanError("not_ready", "Wait for task classification");
      const runtime = data.cards[card.id]!;
      const agents = agentRuns(data, card.id);
      const original = agents.get(
        request.provider ?? (agents.size === 1 ? [...agents.keys()][0]! : this.options.provider),
      );
      if (!original?.threadId)
        throw new KanbanError("not_started", "The original task session is unavailable");
      await this.storeAudio(data.board.id, card.id, audio.bytes);
      runtime.voice = {
        mediaType: audio.mediaType,
        durationMs: audio.durationMs,
        text: request.comment?.trim() ?? "",
        actionId,
        images: await this.storeImages(data.board.id, `comment-${randomUUID()}`, images),
        provider: original.provider,
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
            ...(runtime.provider ? { provider: runtime.provider } : {}),
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
  /** Makes one agent's submitted result the task's result for review, acceptance and merging. */
  private useResult(
    data: KanbanDocument,
    card: KanbanCard,
    chosen: NonNullable<ReturnType<typeof agentResult>>,
  ): void {
    const runtime = data.cards[card.id]!;
    runtime.workspace = chosen.workspace;
    runtime.results = chosen.results;
    card.repositories = chosen.results.map((item) => ({
      ...this.repositorySummary(item.repository),
      commit: item.sha,
    }));
  }
  private accept(data: KanbanDocument, card: KanbanCard): void {
    const runtime = data.cards[card.id]!;
    if (!runtime.results)
      throw new KanbanError("no_result", "The executor has not submitted a result");
    runtime.acceptedResults = structuredClone(runtime.results);
    setStage(data, card, role(data.board, runtime.results.length ? "ready" : "done"));
    for (const repository of card.repositories) repository.status = "accepted";
    card.error = null;
  }
  /** Called from local session notifications; unknown sessions are a constant-time no-op. */
  async notifyThread(threadId: string, state: string): Promise<void> {
    const known = this.threads.get(threadId);
    if (!known || this.closed || this.observedStates.get(threadId) === state) return;
    this.observedStates.set(threadId, state);
    // Remember the initial idle state until a real turn transition arrives.
    if (state === "idle" && this.launching.has(known.runId)) return;
    await this.store
      .updateById(known.boardId, (data) => {
        const run = data.board.runs.find((run) => run.id === known.runId);
        if (!run || !active(run)) return;
        if (state === "running" || state === "queued") {
          run.status = "running";
          run.error = null;
          if (run.kind === "execute")
            for (const id of run.cardIds) {
              const card = findCard(data, id);
              setStage(data, card, role(data.board, "working"));
              card.error = null;
            }
        } else if (state === "needsAttention") run.status = "waiting";
        else if (
          run.kind === "classify" &&
          ["completed", "idle", "interrupted", "failed", "unavailable"].includes(state)
        ) {
          run.status = "failed";
          run.error = "Task classification did not finish; retry classification";
          for (const id of run.cardIds) {
            const card = findCard(data, id);
            card.classification = "failed";
            card.error = run.error;
          }
        } else if (state === "completed" || state === "idle") {
          run.status = "waiting";
          run.error =
            "Session ended without a task report; open the original session and submit the result";
          for (const id of run.cardIds) findCard(data, id).error = run.error;
        } else if (["interrupted", "failed", "unavailable"].includes(state)) {
          run.status = "waiting";
          run.error = `Session ${state}; continue in the original session`;
          for (const id of run.cardIds) findCard(data, id).error = run.error;
        }
        run.updatedAt = Date.now();
      })
      .then(
        ({ board }) => this.changed(board),
        (error) => this.options.onError?.(error),
      );
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
            !(run.status === "preparing" && !processAlive(runtime.ownerPid)))
        )
          return false;
        run.status = "preparing";
        runtime.ownerPid = process.pid;
        run.updatedAt = Date.now();
        return true;
      });
      if (!claim.result) return;
      let document = (await this.store.readById(boardId))!;
      let run = document.board.runs.find((run) => run.id === runId)!;
      let cwd = document.board.projectPath;
      if (run.kind === "execute") {
        const cardId = run.cardIds[0]!;
        const task = document.cards[cardId]!;
        const runtime = document.runs[runId]!;
        const first = task.executionRunId === runId;
        // A continuation keeps its session's copy; another agent or a restart gets a clean one.
        const resumed = runtime.resumeThreadId
          ? document.board.runs
              .filter(
                (item) =>
                  item.threadId === runtime.resumeThreadId && document.runs[item.id]?.workspace,
              )
              .at(-1)
          : undefined;
        const workspace =
          runtime.workspace ??
          (resumed ? document.runs[resumed.id]!.workspace : undefined) ??
          (runtime.resumeThreadId || first ? task.workspace : undefined) ??
          (await createTaskWorkspace({
            projectPath: document.board.projectPath,
            workspaceRoot: join(this.store.directory, "workspaces"),
            taskId: first ? cardId : `${cardId}-${runId.slice(0, 8)}`,
          }));
        await this.store.updateById(boardId, (data) => {
          data.cards[cardId]!.workspace ??= workspace;
          data.runs[runId]!.workspace = workspace;
          data.board.runs.find((item) => item.id === runId)!.workspacePath = workspace.rootPath;
        });
        cwd = workspace.rootPath;
      } else if (run.kind === "review") {
        const workspace = document.cards[run.cardIds[0]!]!.workspace;
        if (workspace) {
          cwd = workspace.rootPath;
          await this.store.updateById(boardId, (data) => {
            data.runs[runId]!.workspace = workspace;
            data.board.runs.find((item) => item.id === runId)!.workspacePath = cwd;
          });
        }
      } else if (run.kind === "integrate") {
        // Creation and merging are explicitly requested by the agent via prepare-integration.
        cwd = join(this.store.directory, "workspaces", `integration-${run.id}`);
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        await this.store.updateById(boardId, (data) => {
          data.board.runs.find((item) => item.id === runId)!.workspacePath = cwd;
        });
      }
      document = (await this.store.readById(boardId))!;
      run = document.board.runs.find((run) => run.id === runId)!;
      const capability = await agentCapability(
        this.store.directory,
        boardId,
        run,
        document.runs[runId]!.token,
      );
      const prompt = await agentPrompt(
        document.board,
        run,
        this.helper,
        capability,
        document.runs[runId]!.comment,
      );
      const stored = [
        ...document.board.cards
          .filter((card) => run.cardIds.includes(card.id))
          .flatMap((card) => cardImages(card)),
        ...(document.runs[runId]!.images ?? []),
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
      const replaced = document.runs[runId]!.interruptThreadId;
      if (replaced)
        await Promise.resolve(this.options.adapter.interrupt?.(replaced)).catch((error) =>
          this.options.onError?.(error),
        );
      const resume = document.runs[runId]!.resumeThreadId;
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
            cwd,
            prompt,
            ...imageInput,
            kind: run.kind,
            title:
              run.kind === "integrate"
                ? "Integrate accepted tasks"
                : `${run.kind}: ${findCard(document, run.cardIds[0]!).title}`,
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
        run.status = "failed";
        run.error = message(error);
        run.updatedAt = Date.now();
        for (const id of run.cardIds) {
          const card = findCard(data, id);
          card.error = run.error;
          if (run.kind === "classify") card.classification = "failed";
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
    const payload =
      request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
        ? (request.payload as Record<string, unknown>)
        : {};
    const card = findCard(document, run.cardIds[0]!);
    const boardScope = run.kind === "execute" && card.scope === "board";
    if (request.command === "read")
      return {
        board:
          boardScope || run.kind === "integrate"
            ? document.board
            : {
                ...document.board,
                cards: document.board.cards.filter((item) => run.cardIds.includes(item.id)),
                runs: document.board.runs.filter((item) => item.id === run.id),
              },
        workspace: runtime.workspace ?? document.cards[card.id]?.workspace ?? null,
        candidates: run.cardIds.map((id) => ({
          cardId: id,
          results: document.cards[id]?.results ?? [],
        })),
        integrations: runtime.integrations ?? (runtime.integration ? [runtime.integration] : []),
        readOnlyContext: document.board.cards
          .filter((item) => !run.cardIds.includes(item.id))
          .map((item) => ({
            id: item.id,
            title: item.title,
            stageId: item.stageId,
            categoryId: item.categoryId,
            repositories: item.repositories.map((repository) => ({
              path: repository.path,
              targetBranch: repository.targetBranch,
              status: repository.status,
            })),
          })),
      };
    if (!active(run))
      throw new KanbanError("completed", "This board operation has already finished");
    if (request.command === "prepare-repository") {
      if (run.kind !== "execute")
        throw new KanbanError("forbidden", "Only the task executor can prepare a repository", 403);
      const workspace = runtime.workspace ?? document.cards[card.id]!.workspace;
      if (!workspace) throw new KanbanError("no_workspace", "Task workspace is unavailable");
      const repositoryPath = text(payload.repositoryPath, "repositoryPath", 8192);
      const canonicalSource = await realpath(repositoryPath).catch(() => resolve(repositoryPath));
      const sourceKey = createHash("sha256").update(canonicalSource).digest("hex");
      const repository = await this.store.withLock(`repository-${sourceKey}`, () =>
        prepareRepository(workspace, {
          repositoryPath,
          ...(typeof payload.targetBranch === "string"
            ? { targetBranch: payload.targetBranch }
            : {}),
          ...(typeof payload.baseBranch === "string" ? { baseBranch: payload.baseBranch } : {}),
          ...(payload.initialize === true ? { initialize: true } : {}),
          ...(Array.isArray(payload.initialFiles) &&
          payload.initialFiles.every((item) => typeof item === "string")
            ? { initialFiles: payload.initialFiles as string[] }
            : {}),
        }),
      );
      const { board } = await this.store.updateById(document.board.id, (data) => {
        const task = data.cards[card.id]!;
        if (!task.workspace || task.workspace.id === workspace.id) task.workspace = workspace;
        data.runs[run.id]!.workspace = workspace;
        const current = findCard(data, card.id);
        if (!current.repositories.some((item) => item.id === repository.id))
          current.repositories.push(this.repositorySummary(repository));
      });
      this.changed(board);
      return repository;
    }
    if (request.command === "move" || request.command === "update-card") {
      if (run.kind === "classify" || run.kind === "review")
        throw new KanbanError("forbidden", "This operation cannot change cards", 403);
      const id = text(payload.cardId, "cardId", 512);
      if (!boardScope && !run.cardIds.includes(id))
        throw new KanbanError("forbidden", "This task can modify only its assigned card", 403);
      const patch =
        request.command === "move"
          ? { stageId: text(payload.stageId, "stageId", 512) }
          : payload.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new KanbanError("invalid_request", "Invalid card patch", 400);
      if (
        boardScope &&
        (patch as UpdateKanbanCardRequest).stageId === role(document.board, "done")
      ) {
        const { board } = await this.store.updateById(document.board.id, (data) => {
          const target = findCard(data, id);
          if (
            data.board.runs.some(
              (item) =>
                item.id !== run.id &&
                active(item) &&
                item.kind !== "classify" &&
                item.cardIds.includes(id),
            )
          )
            throw new KanbanError("already_running", "Cannot close a card with an active session");
          if (target.repositories.some((item) => item.status !== "published"))
            throw new KanbanError(
              "not_published",
              "Cannot close a card with unpublished repository changes",
            );
          data.cards[id]!.acceptedResults = [];
          this.patchCard(data, target, patch as UpdateKanbanCardRequest);
        });
        this.changed(board);
        return board;
      }
      return this.updateCard(document.board.projectPath, id, patch as UpdateKanbanCardRequest);
    }
    if (request.command === "prepare-integration") return this.prepareIntegration(document, run);
    if (request.command === "publish") return this.publish(document, run);
    if (request.command === "report") return this.report(document, run, payload);
    throw new KanbanError("invalid_request", "Unknown board helper command", 400);
  }
  private repositorySummary(repository: WorkspaceRepository): KanbanCard["repositories"][number] {
    return {
      id: repository.id,
      path: repository.sourcePath,
      branch: repository.branch,
      targetBranch: repository.targetBranch,
      baseSha: repository.baseSha,
      commit: null,
      status: "working",
      error: null,
    };
  }
  private async report(
    document: KanbanDocument,
    run: KanbanRun,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const card = findCard(document, run.cardIds[0]!);
    if (run.kind === "classify") {
      const title = text(payload.title, "Task title", 300);
      const category = text(payload.category, "Category", 100);
      if (payload.scope !== undefined && !["task", "board"].includes(String(payload.scope)))
        throw new KanbanError("invalid_request", "Invalid task scope", 400);
      const { board } = await this.store.updateById(document.board.id, (data) => {
        const current = findCard(data, card.id);
        let group = data.board.categories.find(
          (item) => item.name.toLocaleLowerCase() === category.toLocaleLowerCase(),
        );
        if (!group) {
          group = { id: randomUUID(), name: category };
          data.board.categories.push(group);
        }
        current.title = title;
        current.categoryId = group.id;
        current.scope = payload.scope === "board" ? "board" : "task";
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
    const outcome = text(payload.outcome, "Outcome", 30);
    if (outcome === "waiting" || outcome === "failed" || outcome === "rejected") {
      const explanation = text(payload.error ?? payload.summary, "Explanation", 20_000);
      const { board } = await this.store.updateById(document.board.id, (data) => {
        const own = data.board.runs.find((item) => item.id === run.id)!;
        own.status =
          outcome === "waiting" ? "waiting" : outcome === "failed" ? "failed" : "completed";
        own.error = explanation;
        own.updatedAt = Date.now();
        for (const id of run.cardIds) {
          const current = findCard(data, id);
          current.error = explanation;
          if (outcome !== "waiting") setStage(data, current, role(data.board, "review"));
        }
        data.runs[run.id]!.report = payload;
      });
      this.changed(board);
      return { next: outcome === "waiting" ? "operator" : "review" };
    }
    if (run.kind === "integrate")
      throw new KanbanError("not_published", "Use publish after completing integration checks");
    if (
      (run.kind === "execute" && outcome !== "completed") ||
      (run.kind === "review" && outcome !== "accepted")
    )
      throw new KanbanError("invalid_request", "Invalid completion outcome", 400);
    const workspace = document.runs[run.id]!.workspace ?? document.cards[card.id]!.workspace;
    const results = workspace
      ? (await validateTaskWorkspace(workspace)).filter((result) => result.changed !== false)
      : [];
    if (run.kind === "review" && !sameResults(results, document.cards[card.id]!.results ?? []))
      throw new KanbanError(
        "result_changed",
        "The task result changed; submit and review the new result",
      );
    const { board, result } = await this.store.updateById(document.board.id, (data) => {
      const current = findCard(data, card.id);
      const own = data.board.runs.find((item) => item.id === run.id)!;
      own.updatedAt = Date.now();
      own.error = null;
      current.error = null;
      current.updatedAt = Date.now();
      data.runs[run.id]!.report = payload;
      data.cards[card.id]!.results = results;
      if (run.kind === "execute") {
        data.runs[run.id]!.results = results;
        if (workspace) data.cards[card.id]!.workspace = workspace;
      }
      current.repositories = results.map((item) => ({
        ...this.repositorySummary(item.repository),
        commit: item.sha,
      }));
      if (run.kind === "review") {
        this.accept(data, current);
        own.status = "completed";
        return "accepted";
      }
      const rival = rivalAgent(data, card.id, run.provider);
      const solo = !rival && !this.otherUnfinishedCard(data, card.id);
      if (solo && !results.length) {
        this.accept(data, current);
        own.status = "completed";
        return "done";
      }
      if (solo && results.length) {
        this.accept(data, current);
        own.status = "running";
        data.runs[run.id]!.preparingIntegration = true;
        return "publish";
      }
      own.status = "completed";
      // The task stays in progress until the other agent finishes too.
      if (![...agentRuns(data, card.id).values()].some(active))
        setStage(data, current, role(data.board, "review"));
      return "review";
    });
    this.changed(board);
    return { next: result };
  }
  private otherUnfinishedCard(data: KanbanDocument, cardId: string): boolean {
    return data.board.cards.some(
      (card) =>
        card.id !== cardId &&
        card.archivedAt === undefined &&
        data.cards[card.id]?.executionRunId &&
        card.stageId !== role(data.board, "done"),
    );
  }
  private async prepareIntegration(document: KanbanDocument, run: KanbanRun): Promise<unknown> {
    if (
      run.kind !== "integrate" &&
      !(run.kind === "execute" && document.runs[run.id]?.preparingIntegration)
    )
      throw new KanbanError("forbidden", "This operation is not authorized to integrate", 403);
    const results: RepositoryResult[] = [];
    for (const id of run.cardIds) {
      const runtime = document.cards[id]!;
      if (!runtime.acceptedResults?.length)
        throw new KanbanError(
          "not_accepted",
          "The selected card has no accepted repository result",
        );
      const current = runtime.workspace
        ? (await validateTaskWorkspace(runtime.workspace)).filter(
            (result) => result.changed !== false,
          )
        : [];
      if (!sameResults(current, runtime.acceptedResults))
        throw new KanbanError(
          "result_changed",
          "An accepted task changed; submit and review it again",
        );
      results.push(...runtime.acceptedResults);
    }
    const groups: RepositoryResult[][] = [];
    for (const result of results) {
      let group = groups.find(
        (items) =>
          !items.some(
            (item) =>
              item.repository.gitCommonDir === result.repository.gitCommonDir &&
              item.repository.targetBranch !== result.repository.targetBranch,
          ),
      );
      if (!group) {
        group = [];
        groups.push(group);
      }
      group.push(result);
    }
    const integrations: IntegrationWorkspace[] = [];
    for (const [index, group] of groups.entries()) {
      const integration = await prepareIntegrationWorkspace({
        projectPath: document.board.projectPath,
        workspaceRoot: join(this.store.directory, "workspaces"),
        integrationId: `${run.id}-g${index}`,
        results: group,
      });
      const previous =
        document.runs[run.id]?.integrations?.flatMap((group) => group.repositories) ?? [];
      for (const repository of integration.repositories) {
        const receipt = previous.find((item) => item.id === repository.id)?.publishedSha;
        if (receipt) repository.publishedSha = receipt;
      }
      integrations.push(integration);
      // Persist each prepared group, including conflicts, before preparing the next one.
      const { board } = await this.store.updateById(document.board.id, (data) => {
        data.runs[run.id]!.integrations = integrations;
        data.board.runs.find((item) => item.id === run.id)!.workspacePath =
          integrations[0]!.rootPath;
        for (const id of run.cardIds)
          for (const repository of findCard(data, id).repositories)
            if (repository.status !== "published") repository.status = "integrating";
      });
      this.changed(board);
    }
    return { groups: integrations };
  }
  private async publish(document: KanbanDocument, run: KanbanRun): Promise<unknown> {
    return this.store.withLock(`activity-${document.board.id}`, () =>
      this.publishReserved(document, run),
    );
  }
  private async publishReserved(document: KanbanDocument, run: KanbanRun): Promise<unknown> {
    const runtime = document.runs[run.id]!;
    if (run.kind !== "integrate" && !(run.kind === "execute" && runtime.preparingIntegration))
      throw new KanbanError("forbidden", "This operation cannot publish", 403);
    const integrations = runtime.integrations ?? (runtime.integration ? [runtime.integration] : []);
    if (!integrations.length)
      throw new KanbanError(
        "not_prepared",
        "Prepare integration and run combined checks before publication",
      );
    const current = (await this.store.readById(document.board.id))!;
    if (run.kind === "execute" && this.otherUnfinishedCard(current, run.cardIds[0]!)) {
      const { board } = await this.store.updateById(document.board.id, (data) => {
        const card = findCard(data, run.cardIds[0]!);
        setStage(data, card, role(data.board, "review"));
        delete data.cards[card.id]!.acceptedResults;
        const own = data.board.runs.find((item) => item.id === run.id)!;
        own.status = "completed";
        own.error =
          "Another task started; review and integrate this result with the parallel tasks";
      });
      this.changed(board);
      return { next: "review", reason: "parallel_task_started" };
    }
    const keyOf = (repository: WorkspaceRepository) =>
      `${repository.gitCommonDir}\0${repository.targetBranch}`;
    const receipts = new Map(
      integrations
        .flatMap((integration) => integration.repositories)
        .filter((repository) => repository.publishedSha)
        .map((repository) => [repository.id, repository.publishedSha!]),
    );
    const pendingKeys = new Set(
      integrations
        .flatMap((integration) => integration.repositories)
        .filter((repository) => !receipts.has(repository.id))
        .map(keyOf),
    );
    // Already published repositories retain their receipt even if their live target later advances.
    // Only the remaining repositories need fresh source and integration validation on retry.
    for (const id of run.cardIds) {
      const task = current.cards[id]!;
      const accepted = (task.acceptedResults ?? []).filter((item) =>
        pendingKeys.has(keyOf(item.repository)),
      );
      if (!accepted.length) continue;
      const actual = task.workspace
        ? (
            await validateTaskWorkspace(
              task.workspace,
              accepted.map((item) => item.repository.id),
            )
          ).filter((item) => item.changed !== false && pendingKeys.has(keyOf(item.repository)))
        : [];
      if (!sameResults(actual, accepted))
        throw new KanbanError(
          "result_changed",
          "An accepted result changed after integration; submit and review it again",
        );
    }
    const checked = (
      await Promise.all(
        integrations.map((integration) => {
          const ids = integration.repositories
            .filter((repository) => !receipts.has(repository.id))
            .map((repository) => repository.id);
          return ids.length ? validateIntegrationWorkspace(integration, ids) : Promise.resolve([]);
        }),
      )
    ).flat();
    for (const integration of integrations)
      for (const repository of integration.repositories) {
        if (receipts.has(repository.id)) repository.publishedSha = receipts.get(repository.id);
      }
    const results = [];
    for (const repository of integrations
      .flatMap((integration) => integration.repositories)
      .filter((repository) => !receipts.has(repository.id))
      .sort((a, b) => b.relativePath.split("/").length - a.relativePath.split("/").length)) {
      const checkedResult = checked.find((item) => item.repository.id === repository.id);
      if (!checkedResult)
        throw new KanbanError("invalid_result", "Integration validation omitted a repository");
      try {
        const key = createHash("sha256")
          .update(repository.gitCommonDir + "\0" + repository.targetBranch)
          .digest("hex");
        const published = await this.store.withLock(`publish-${key}`, () =>
          publishIntegrationRepository(repository, { expectedSha: checkedResult.sha, push: true }),
        );
        results.push(published);
        repository.publishedSha = published.sha;
        const { board } = await this.store.updateById(document.board.id, (data) => {
          data.runs[run.id]!.integrations = integrations;
          for (const id of run.cardIds) {
            const card = findCard(data, id);
            const inputs = data.cards[id]!.acceptedResults ?? [];
            for (const item of card.repositories) {
              if (
                inputs.some(
                  (input) =>
                    input.repository.id === item.id &&
                    input.repository.gitCommonDir === repository.gitCommonDir &&
                    input.repository.targetBranch === repository.targetBranch,
                )
              ) {
                item.status = "published";
                item.commit = published.sha;
                item.error = null;
              }
            }
          }
        });
        this.changed(board);
      } catch (error) {
        const { board } = await this.store.updateById(document.board.id, (data) => {
          const own = data.board.runs.find((item) => item.id === run.id)!;
          own.status = "waiting";
          own.error = message(error);
          for (const id of run.cardIds) {
            const card = findCard(data, id);
            card.error = own.error;
            for (const item of card.repositories)
              if (item.targetBranch === repository.targetBranch && item.status !== "published") {
                item.status = "failed";
                item.error = own.error;
              }
          }
        });
        this.changed(board);
        throw error;
      }
    }
    const { board } = await this.store.updateById(document.board.id, (data) => {
      const own = data.board.runs.find((item) => item.id === run.id)!;
      own.status = "completed";
      own.error = null;
      own.updatedAt = Date.now();
      for (const id of run.cardIds) {
        const card = findCard(data, id);
        if (
          card.repositories.length &&
          card.repositories.every((item) => item.status === "published")
        ) {
          setStage(data, card, role(data.board, "done"));
          card.error = null;
        }
      }
    });
    this.changed(board);
    return { next: "done", publications: results };
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
