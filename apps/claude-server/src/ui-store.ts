import { join } from "node:path";
import type {
  Project,
  QueuedMessage,
  QueueMessageRequest,
  SessionSettings,
  TaskDefaults,
  ThreadDraft,
  ThreadFileAttachment,
  UiLanguage,
  UserInputDraft,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";
import { readJson, writeJsonAtomic } from "./io";
import { AppError, type ClaudePermissionMode, type ClaudeModel } from "./types";

export interface UiThread {
  id: string;
  cwd: string;
  projectId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  readAt: number;
  viewedAt: number;
  pinned: boolean;
  archived: boolean;
  settings: SessionSettings;
  draft: ThreadDraft | null;
  queue: QueuedMessage[];
  nativeHistory?: boolean;
  deliveries: Record<
    string,
    {
      fingerprint: string;
      messageId: string;
      accepted: boolean;
      imageFiles?: ThreadFileAttachment[];
    }
  >;
}
export interface StoredVoice {
  job: VoiceTranscriptionJob;
  audioPath: string;
  contentType: string;
  selectionStart: number;
  selectionEnd: number;
  draftUpdatedAt: number | null;
  cancelled?: boolean;
  applied?: boolean;
  sendInput?: QueueMessageRequest;
}
export interface UiData {
  version: 1;
  projects: Project[];
  threads: Record<string, UiThread>;
  creations: Record<string, { projectId: string; threadId: string; fingerprint?: string }>;
  projectDrafts: Record<string, ThreadDraft>;
  questionDrafts: Record<string, UserInputDraft>;
  voice: Record<string, StoredVoice>;
  voiceUploads: Record<string, string>;
  models: ClaudeModel[];
  taskDefaults: TaskDefaults;
  uiLanguage: UiLanguage;
  permissionMode: ClaudePermissionMode;
  permissionVersion: number;
  voiceSettings?: Record<string, unknown>;
}
const initial = (): UiData => ({
  version: 1,
  projects: [],
  threads: {},
  creations: {},
  projectDrafts: {},
  questionDrafts: {},
  voice: {},
  voiceUploads: {},
  models: [],
  taskDefaults: {},
  uiLanguage: "ru",
  permissionMode: "manual",
  permissionVersion: 1,
});

/** Only Nest metadata is stored here. Conversation content remains in native Claude JSONL. */
export class UiStore {
  private current = initial();
  private writing: Promise<unknown> = Promise.resolve();
  readonly path: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, "ui.json");
  }
  get data(): UiData {
    return this.current;
  }
  async initialize(): Promise<void> {
    const saved = await readJson<UiData>(this.path);
    if (saved && saved.version !== 1)
      throw new AppError("conflict", "Unsupported ClaudeNest metadata version", 409);
    if (saved) this.current = { ...initial(), ...saved };
  }
  update<T>(operation: (data: UiData) => T | Promise<T>): Promise<T> {
    const task = this.writing
      .catch(() => undefined)
      .then(async () => {
        const next = structuredClone(this.current);
        const result = await operation(next);
        await writeJsonAtomic(this.path, next);
        this.current = next;
        return result;
      });
    this.writing = task;
    return task;
  }
  async flush(): Promise<void> {
    await this.writing.catch(() => undefined);
  }
}
