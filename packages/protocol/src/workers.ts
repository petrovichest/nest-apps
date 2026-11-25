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
  target?: { id: string; revision: number; previousInstructions: string };
};
