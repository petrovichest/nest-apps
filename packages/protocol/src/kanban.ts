/** Project boards are shared by the local CodexNest and ClaudeNest instances. */
export type KanbanProvider = "codex" | "claude";
export type KanbanStageRole = "todo" | "working" | "review" | "ready" | "done";
export type KanbanStage = {
  id: string;
  name: string;
  description: string;
  role: KanbanStageRole | null;
  /** A standard stage keeps its translated name until the operator renames it. */
  renamed?: boolean;
};
export type KanbanCategory = { id: string; name: string };
export const KANBAN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export type KanbanImageInput = { name: string; url: string };
export type KanbanImage = { name: string; mediaType: string; size: number };
export const KANBAN_IMAGE_LIMIT = 10;
export const KANBAN_AUDIO_MAX_BYTES = 24 * 1024 * 1024;
/** A recording sent with a task or a rework comment; the server transcribes it. */
export type KanbanAudioInput = { mediaType: string; data: string; durationMs: number };
export type KanbanVoiceState = {
  purpose: "create" | "rework";
  status: "transcribing" | "failed";
  error: string | null;
  provider: KanbanProvider;
};
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
  /** Legacy single image; new cards use images. */
  image?: KanbanImage;
  images?: KanbanImage[];
  /** Present while a recording for this card is being transcribed or has failed. */
  voice?: KanbanVoiceState;
  stageId: string;
  classification: "pending" | "ready" | "failed";
  scope: "task" | "board";
  repositories: KanbanRepositorySummary[];
  error: string | null;
  /** Set while the card sits in Done; it moves to the archive after seven days. */
  doneAt?: number;
  archivedAt?: number;
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
export type CreateKanbanCardRequest = {
  /** May be empty when a recording carries the task. */
  description: string;
  clientCreationId: string;
  image?: KanbanImageInput;
  images?: KanbanImageInput[];
  audio?: KanbanAudioInput;
};
export type UpdateKanbanCardRequest = {
  title?: string;
  description?: string;
  categoryId?: string | null;
  stageId?: string;
  /** Places the card before another card of its stage; null places it last. */
  beforeCardId?: string | null;
  archived?: boolean;
};
export type UpdateKanbanStageRequest = {
  name?: string;
  description?: string;
  /** Custom stages only: place before another stage, or last with null. */
  beforeStageId?: string | null;
};
export type CreateKanbanStageRequest = { name: string; description?: string };
export type KanbanAction =
  | "execute"
  | "restart"
  | "review"
  | "accept"
  | "rework"
  | "integrate"
  | "retry-classification"
  | "retry-transcription";
export type KanbanActionRequest = {
  action: KanbanAction;
  cardIds: string[];
  comment?: string;
  /** Rework only: pictures for the executor and a recording appended to the comment. */
  images?: KanbanImageInput[];
  audio?: KanbanAudioInput;
  /**
   * Each application runs its own agent on a task. Restart, rework, review and accept act on
   * this application's agent; execute always starts the agent of the application handling it.
   */
  provider?: KanbanProvider;
  clientActionId: string;
};
