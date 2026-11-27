import type { ActivityItem, SessionSettings } from "./index.js";
import type { KanbanProvider } from "./kanban.js";

export const WORKER_ARCHITECT_ID = "architect";
export const WORKER_MEMORY_SAVED_MARKER = "[nest:worker-memory-saved]";

export function isWorkerMemorySave(item: ActivityItem): boolean {
  if (item.status !== "completed") return false;
  let output: string;
  if (item.type === "command") {
    if (
      (item.exitCode !== null && item.exitCode !== 0) ||
      !item.command.includes("/agent.mjs") ||
      !/\/capabilities\/worker-[\w-]+\.json['"]?\s+['"]?memory(?:_add)?(?=\s|['"]|$)/u.test(
        item.command,
      )
    )
      return false;
    output = item.output;
  } else if (item.type === "tool") {
    output = item.detail;
  } else {
    return false;
  }
  return (
    output.includes(WORKER_MEMORY_SAVED_MARKER) &&
    output.split("\n").some((line) => line.trim() === WORKER_MEMORY_SAVED_MARKER)
  );
}

export type WorkerProfile = {
  id: string;
  /** Canonical project identity. Null is reserved for the Architect and legacy profiles. */
  projectKey: string | null;
  name: string;
  role: string;
  instructions: string;
  /** Set by the operator when authorizing the worker to delegate Kanban tasks. */
  coordinates?: boolean;
  settings: Partial<Record<KanbanProvider, SessionSettings>>;
  revision: number;
};

export type WorkerMemoryEntry = {
  id: string;
  kind: "notes" | "user";
  projectKey: string | null;
  text: string;
};

export type WorkerCatalogue = {
  common: WorkerProfile[];
  projects: { projectId: string; workers: WorkerProfile[] }[];
};

export type WorkerDetails = { profile: WorkerProfile; memory: WorkerMemoryEntry[] };

export type UpdateWorkerRequest = Pick<
  WorkerProfile,
  "revision" | "name" | "role" | "instructions"
> & {
  settings?: SessionSettings | null;
};

export type WorkerProposal = {
  id: string;
  provider: KanbanProvider;
  projectId?: string;
  projectName?: string;
  projectKey: string | null;
  name: string;
  role: string;
  instructions: string;
  settings: SessionSettings;
  coordinates?: boolean;
  target?: { id: string; revision: number; previousInstructions: string };
};

/** Identity and ancestry of a session launched through the worker registry. */
export type WorkerSessionSummary = {
  name: string;
  parentThreadId?: string;
  workerId?: string;
  projectKey?: string | null;
};

export type WorkerProcessSession = {
  id: string;
  parentId: string | null;
  workerId: string;
  workerName: string;
  provider: KanbanProvider;
  threadId: string | null;
  sessionUrl?: string;
  title: string;
  kind: "session" | "question" | "assignment";
  description?: string;
  expectedResult?: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  waitingFor: string[];
  signal?: "actionRequired" | "unseenCompletion";
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkerProcess = {
  id: string;
  projectKey: string | null;
  projectName: string | null;
  sessions: WorkerProcessSession[];
};
