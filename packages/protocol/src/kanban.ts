/** Project boards are shared by the local CodexNest and ClaudeNest instances. */
export type KanbanProvider = "codex" | "claude";
export type KanbanStageRole = "todo" | "working" | "review" | "ready" | "done";
export type KanbanStage = {
  id: string;
  name: string;
  description: string;
  role: KanbanStageRole | null;
};
export type KanbanCategory = { id: string; name: string };
export type KanbanRepositorySummary = {
  id: string;
  path: string;
  branch: string;
  targetBranch: string;
  baseSha: string;
  commit: string | null;
  status: "working" | "accepted" | "integrating" | "integrated" | "published" | "failed";
  error: string | null;
};
export type KanbanCard = {
  id: string;
  title: string;
  description: string;
  categoryId: string | null;
  stageId: string;
  classification: "pending" | "ready" | "failed";
  scope: "task" | "board";
  repositories: KanbanRepositorySummary[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
export type KanbanRunKind = "classify" | "execute" | "review" | "integrate";
export type KanbanRun = {
  id: string;
  kind: KanbanRunKind;
  cardIds: string[];
  provider: KanbanProvider;
  threadId: string | null;
  sessionUrl: string | null;
  status: "queued" | "preparing" | "running" | "waiting" | "completed" | "failed";
  workspacePath: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
export type KanbanBoard = {
  id: string;
  projectPath: string;
  revision: number;
  stages: KanbanStage[];
  categories: KanbanCategory[];
  cards: KanbanCard[];
  runs: KanbanRun[];
  createdAt: number;
  updatedAt: number;
};
export type CreateKanbanCardRequest = { description: string; clientCreationId: string };
export type UpdateKanbanCardRequest = {
  title?: string;
  description?: string;
  categoryId?: string | null;
  stageId?: string;
};
export type CreateKanbanStageRequest = { name: string; description?: string };
export type KanbanAction =
  "execute" | "review" | "accept" | "rework" | "integrate" | "retry-classification";
export type KanbanActionRequest = {
  action: KanbanAction;
  cardIds: string[];
  comment?: string;
  clientActionId: string;
};
