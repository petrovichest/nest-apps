import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  KanbanBoard,
  KanbanProvider,
  KanbanStageRole,
  SessionSettings,
} from "@codexnest/protocol";

/** An image saved next to the board; file is relative to the board's image directory. */
export type StoredImage = { name: string; mediaType: string; size: number; file: string };
/** A recording waiting for transcription: typed text and pictures sent with it. */
export type VoiceRuntime = {
  mediaType: string;
  durationMs: number;
  text: string;
  actionId?: string;
  images?: StoredImage[];
};
export type CardRuntime = {
  voice?: VoiceRuntime;
  /** Settings chosen with the task; only the application that received them applies them. */
  settings?: { provider: KanbanProvider; value: SessionSettings };
  /** A session's card whose text is still the session's first message to be read. */
  awaitsText?: true;
};
export type RunRuntime = {
  token: string;
  ownerPid?: number;
  resumeThreadId?: string;
  comment?: string;
  images?: StoredImage[];
  /** A restart stops the session it replaces before launching. */
  interruptThreadId?: string;
  /** The session has run this turn; until then its earlier finished state is not this run's. */
  started?: boolean;
  report?: unknown;
};
export type KanbanDocument = {
  version: 1;
  board: KanbanBoard;
  creations: Record<string, { fingerprint: string; cardId: string }>;
  actions: Record<string, { fingerprint: string; runIds: string[] }>;
  cards: Record<string, CardRuntime>;
  runs: Record<string, RunRuntime>;
};

export class KanbanError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function initial(projectPath: string, id: string): KanbanDocument {
  const now = Date.now();
  const stages: { name: string; role: KanbanStageRole }[] = [
    { name: "To do", role: "todo" },
    { name: "In progress", role: "working" },
    { name: "Waiting for answer", role: "waiting" },
    { name: "Ready", role: "ready" },
    { name: "Published", role: "done" },
  ];
  return {
    version: 1,
    board: {
      id,
      projectPath,
      revision: 0,
      stages: stages.map((stage) => ({ ...stage, id: stage.role, description: "" })),
      categories: [],
      cards: [],
      runs: [],
      createdAt: now,
      updatedAt: now,
    },
    creations: {},
    actions: {},
    cards: {},
    runs: {},
  };
}

const ROLES: readonly KanbanStageRole[] = ["todo", "working", "waiting", "ready", "done"];
/**
 * Boards from before plain-session tasks had Review between In progress and Ready: it becomes
 * Waiting for answer and its cards become ready. Repairs are saved with the next write.
 */
function upgrade(data: KanbanDocument): void {
  // Classification once reported a category's id as a new category's name: fold it back.
  const categories = data.board?.categories;
  for (const stray of Array.isArray(categories) ? [...categories] : []) {
    const target = categories.find((item) => item !== stray && item.id === stray.name);
    if (!target) continue;
    for (const card of data.board.cards ?? [])
      if (card.categoryId === stray.id) card.categoryId = target.id;
    categories.splice(categories.indexOf(stray), 1);
  }
  const stages = data.board?.stages;
  if (!Array.isArray(stages) || stages.some((stage) => stage.role === "waiting")) return;
  const review = stages.find((stage) => (stage.role as string) === "review");
  const ready = stages.find((stage) => stage.role === "ready");
  if (!review || !ready) return;
  for (const card of data.board.cards ?? [])
    if (card.stageId === review.id) card.stageId = ready.id;
  Object.assign(review, { role: "waiting", name: "Waiting for answer", description: "" });
  delete review.renamed;
}

/** Both providers use the same directory; locks serialize writes across processes. */
export class KanbanStore {
  readonly directory: string;
  readonly boardsDirectory: string;
  readonly locksDirectory: string;
  constructor(
    directory = process.env.KANBAN_DATA_DIR || join(homedir(), ".local/share/nest-apps/kanban"),
  ) {
    this.directory = directory;
    this.boardsDirectory = join(directory, "boards");
    this.locksDirectory = join(directory, "locks");
  }
  async initialize(): Promise<void> {
    await mkdir(this.boardsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.locksDirectory, { recursive: true, mode: 0o700 });
  }
  async identity(projectPath: string): Promise<{ id: string; path: string }> {
    const path = await realpath(projectPath);
    if (!(await stat(path)).isDirectory())
      throw new KanbanError("invalid_project", "Project must be a directory", 400);
    return { id: createHash("sha256").update(path).digest("hex"), path };
  }
  async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]+$/.test(key))
      throw new KanbanError("invalid_id", "Invalid lock identifier", 400);
    const path = join(this.locksDirectory, key);
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid }), {
          mode: 0o600,
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let abandoned: boolean;
        try {
          const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as {
            pid?: number;
          };
          abandoned = !processAlive(owner.pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            abandoned = await stat(path).then(
              (info) => Date.now() - info.mtimeMs > 30_000,
              () => false,
            );
          } else throw error;
        }
        if (abandoned) {
          const recovery = `${path}.recovery`;
          const acquired = await mkdir(recovery, { mode: 0o700 }).then(
            () => true,
            () => false,
          );
          if (acquired) {
            try {
              const latest = await readFile(join(path, "owner.json"), "utf8").then(
                (value) => JSON.parse(value) as { pid?: number },
                () => null,
              );
              const oldEnough = await stat(path).then(
                (info) => Date.now() - info.mtimeMs > 30_000,
                () => false,
              );
              if ((latest && !processAlive(latest.pid)) || (!latest && oldEnough))
                await rm(path, { recursive: true, force: true });
            } finally {
              await rm(recovery, { recursive: true, force: true });
            }
          } else {
            const staleRecovery = await stat(recovery).then(
              (info) => Date.now() - info.mtimeMs > 30_000,
              () => false,
            );
            if (staleRecovery) await rm(recovery, { recursive: true, force: true });
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          continue;
        }
        if (Date.now() > deadline)
          throw new KanbanError("busy", "The project board is busy; retry the action", 503);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      return await work();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }
  private boardPath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new KanbanError("invalid_id", "Invalid board identifier", 400);
    return join(this.boardsDirectory, `${id}.json`);
  }
  async readById(id: string): Promise<KanbanDocument | null> {
    try {
      const data = JSON.parse(await readFile(this.boardPath(id), "utf8")) as KanbanDocument;
      upgrade(data);
      if (
        !data ||
        data.version !== 1 ||
        data.board?.id !== id ||
        typeof data.board.projectPath !== "string" ||
        !Number.isSafeInteger(data.board.revision) ||
        !Array.isArray(data.board.cards) ||
        !Array.isArray(data.board.runs) ||
        !Array.isArray(data.board.stages) ||
        !Array.isArray(data.board.categories) ||
        ![data.creations, data.actions, data.cards, data.runs].every(
          (value) => value && typeof value === "object" && !Array.isArray(value),
        ) ||
        !ROLES.every((role) => data.board.stages.some((stage) => stage.role === role))
      ) {
        throw new KanbanError("invalid_state", "Unsupported or invalid kanban state", 500);
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async read(projectPath: string): Promise<KanbanDocument> {
    const identity = await this.identity(projectPath);
    const existing = await this.readById(identity.id);
    if (existing) return existing;
    return this.withLock(identity.id, async () => {
      const found = await this.readById(identity.id);
      if (found) return found;
      const document = initial(identity.path, identity.id);
      await atomicJson(this.boardPath(identity.id), document);
      return document;
    });
  }
  async update<T>(
    projectPath: string,
    mutate: (data: KanbanDocument) => T | Promise<T>,
  ): Promise<{ result: T; board: KanbanBoard }> {
    const document = await this.read(projectPath);
    return this.updateById(document.board.id, mutate);
  }
  async updateById<T>(
    id: string,
    mutate: (data: KanbanDocument) => T | Promise<T>,
  ): Promise<{ result: T; board: KanbanBoard }> {
    return this.withLock(id, async () => {
      const document = await this.readById(id);
      if (!document) throw new KanbanError("not_found", "Project board not found", 404);
      const result = await mutate(document);
      document.board.revision++;
      document.board.updatedAt = Date.now();
      await atomicJson(this.boardPath(id), document);
      return { result, board: structuredClone(document.board) };
    });
  }
  async list(): Promise<KanbanDocument[]> {
    const names = await readdir(this.boardsDirectory);
    return (
      await Promise.all(
        names
          .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
          .map((name) => this.readById(name.slice(0, -5))),
      )
    ).filter((item): item is KanbanDocument => item !== null);
  }
}
