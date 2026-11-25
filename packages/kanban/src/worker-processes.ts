import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerProcess, WorkerProcessSession } from "@codexnest/protocol";
import { atomicJson, KanbanError, KanbanStore } from "./store.js";

export type WorkerSession = Omit<WorkerProcessSession, "waitingFor"> & {
  processId: string;
  projectKey: string | null;
  projectPath: string | null;
  projectName: string | null;
  boardId?: string;
  cardIds?: string[];
  sourceCardId?: string;
  wait?: boolean;
  started?: boolean;
  awaitingWorkers?: boolean;
  delivering?: boolean;
  delivered?: boolean;
  reported?: { result?: string; error?: string };
};

type Sessions = Record<string, WorkerSession>;

export function unfinished(session: WorkerSession): boolean {
  return session.status !== "completed" && session.status !== "failed";
}

export function waitingFor(sessions: Sessions, id: string): WorkerSession[] {
  return Object.values(sessions).filter(
    (child) => child.parentId === id && child.wait && !child.delivered && !child.delivering,
  );
}

/** Work is shared with the registry of profiles, even for applications with their own boards. */
export class WorkerProcessStore {
  private readonly state: KanbanStore;
  private readonly path: string;

  constructor(readonly directory: string) {
    this.state = new KanbanStore(directory);
    this.path = join(directory, "processes.json");
  }

  initialize(): Promise<void> {
    return this.state.initialize();
  }

  async read(): Promise<Sessions> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Sessions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async update<T>(change: (sessions: Sessions) => T): Promise<T> {
    return this.state.withLock("processes", async () => {
      const sessions = await this.read();
      const before = JSON.stringify(sessions);
      const result = change(sessions);
      if (JSON.stringify(sessions) !== before) await atomicJson(this.path, sessions);
      return result;
    });
  }

  exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.state.withLock(`dispatch-${id}`, work);
  }

  async list(processId?: string): Promise<WorkerProcess[]> {
    const sessions = await this.read();
    const groups = new Map<string, WorkerSession[]>();
    const waiting = new Map<string, string[]>();
    for (const session of Object.values(sessions)) {
      if (processId && session.processId !== processId) continue;
      const group = groups.get(session.processId) ?? [];
      group.push(session);
      groups.set(session.processId, group);
      if (session.parentId && session.wait && !session.delivered && !session.delivering) {
        const pending = waiting.get(session.parentId) ?? [];
        pending.push(session.id);
        waiting.set(session.parentId, pending);
      }
    }
    const processes: WorkerProcess[] = [];
    for (const [id, group] of groups) {
      const root = sessions[id];
      if (!root || (!processId && !group.some(unfinished))) continue;
      processes.push({
        id,
        projectKey: root.projectKey,
        projectName: root.projectName,
        sessions: group.map((session) => ({
          id: session.id,
          parentId: session.parentId,
          workerId: session.workerId,
          workerName: session.workerName,
          provider: session.provider,
          threadId: session.threadId,
          title: session.title,
          kind: session.kind,
          description: session.description,
          expectedResult: session.expectedResult,
          status: session.status,
          waitingFor: waiting.get(session.id) ?? [],
          result: session.result,
          error: session.error,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        })),
      });
    }
    if (processId && processes.length === 0)
      throw new KanbanError("worker_process_not_found", "Worker process not found", 404);
    return processes;
  }
}
