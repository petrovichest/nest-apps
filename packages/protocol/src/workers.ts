import type { SessionSettings } from "./index.js";
import type { KanbanProvider } from "./kanban.js";

export const WORKER_ARCHITECT_ID = "architect";

export type WorkerProfile = {
  id: string;
  /** Canonical project identity. Null denotes a worker available in every project. */
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
