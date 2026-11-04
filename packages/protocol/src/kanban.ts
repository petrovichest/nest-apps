import type { SessionSettings } from "./index.js";

/** Project boards are shared by the local CodexNest and ClaudeNest instances. */
export type KanbanProvider = "codex" | "claude";
/** The application moves cards between working, waiting and ready; the agent never does. */
export type KanbanStageRole = "todo" | "working" | "waiting" | "ready" | "done";
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
/** A recording sent with a task, an addition to it or a rework comment; the server transcribes it. */
export type KanbanAudioInput = { mediaType: string; data: string; durationMs: number };
export type KanbanVoiceState = {
  purpose: "create" | "append" | "rework";
  status: "transcribing" | "failed";
  error: string | null;
  provider: KanbanProvider;
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
  /** Shown in Waiting: what the agent asks, in short. Failures use error instead. */
  question?: string | null;
  error: string | null;
  /** Set while the card sits in Published; it moves to the archive after seven days. */
  doneAt?: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
};
/** Execution and publication are turns of the task's ordinary session. */
export type KanbanRunKind = "classify" | "execute" | "publish";
export type KanbanRun = {
  id: string;
  kind: KanbanRunKind;
  cardIds: string[];
  provider: KanbanProvider;
  threadId: string | null;
  sessionUrl: string | null;
  status: "queued" | "preparing" | "running" | "waiting" | "completed" | "failed";
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
  /**
   * Settings chosen in the task field. The application that received the task applies them when
   * it starts the task's session; the other application uses its own new-session settings.
   */
  settings?: SessionSettings;
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
  | "rework"
  | "append"
  | "publish"
  | "retry-classification"
  | "retry-transcription";
export type KanbanActionRequest = {
  action: KanbanAction;
  cardIds: string[];
  comment?: string;
  /**
   * Rework and append only: pictures and a recording whose transcript follows the comment.
   * Append adds them to a task no session has taken yet.
   */
  images?: KanbanImageInput[];
  audio?: KanbanAudioInput;
  clientActionId: string;
};
