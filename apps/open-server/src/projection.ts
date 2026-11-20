import type { ActivityItem, TurnView } from "@codexnest/protocol";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";

export type NativeTokens = {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

export type NativePart = {
  id: string;
  messageID?: string;
  sessionID?: string;
  type: string;
  cost?: number;
  tokens?: NativeTokens;
  text?: string;
  url?: string;
  mime?: string;
  filename?: string;
  tool?: string;
  state?: {
    status?: string;
    title?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
    attachments?: Array<{ url: string; mime?: string; filename?: string }>;
    time?: { start?: number; end?: number };
  };
};
export function nativeFilePath(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (!url.startsWith("file:")) return null;
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}
export type NativeMessage = {
  info: {
    id: string;
    sessionID?: string;
    role: string;
    parentID?: string;
    finish?: string;
    modelID?: string;
    providerID?: string;
    summary?: boolean;
    cost?: number;
    tokens?: NativeTokens;
    time?: { created?: number; completed?: number };
    error?: unknown;
  };
  parts: NativePart[];
};

export function partActivity(
  part: NativePart,
  message: NativeMessage,
  finalResponse = false,
  managedCommands = false,
): ActivityItem | null {
  const complete = message.info.role === "user" || Boolean(message.info.time?.completed);
  if (message.info.summary && part.type === "text")
    return {
      type: "tool",
      id: part.id,
      status: complete ? "completed" : "inProgress",
      title: "Context compression",
      detail: part.text ?? "",
    };
  if (part.type === "compaction")
    return {
      type: "tool",
      id: part.id,
      status: "completed",
      title: "Context compression requested",
      detail: "",
    };
  if (part.type === "file" && part.url) {
    const path = nativeFilePath(part.url),
      image = part.mime?.startsWith("image/") === true;
    return {
      id: part.id,
      type: message.info.role === "user" ? "userMessage" : "agentMessage",
      status: complete ? "completed" : "inProgress",
      text: "",
      images: image ? [path ?? part.url] : [],
      ...(!image && path ? { files: [{ name: part.filename ?? basename(path), path }] } : {}),
      timestamp: message.info.time?.created ?? null,
      phase: null,
    };
  }
  if (part.type === "text" || part.type === "reasoning") {
    return {
      id: part.id,
      type:
        part.type === "reasoning"
          ? "reasoning"
          : message.info.role === "user"
            ? "userMessage"
            : "agentMessage",
      status: message.info.error ? "failed" : complete ? "completed" : "inProgress",
      text: part.text ?? "",
      images: [],
      timestamp: message.info.time?.created ?? null,
      phase:
        message.info.role === "user" || part.type === "reasoning"
          ? null
          : finalResponse && complete
            ? "final_answer"
            : "commentary",
    };
  }
  if (part.type !== "tool") return null;
  const state = part.state ?? {};
  const status =
    state.status === "error" ? "failed" : state.status === "completed" ? "completed" : "inProgress";
  const input = state.input ?? {};
  if (
    part.tool === "question" &&
    status === "completed" &&
    Array.isArray(input.questions) &&
    Array.isArray(state.metadata?.answers)
  ) {
    const answers = state.metadata.answers;
    return {
      type: "userInputResponse",
      id: part.id,
      status: "completed",
      entries: input.questions.map((question, index) => {
        const value =
          question && typeof question === "object" ? (question as Record<string, unknown>) : {};
        const answer = answers[index];
        return {
          header: typeof value.header === "string" ? value.header : "",
          question: typeof value.question === "string" ? value.question : "",
          answers: Array.isArray(answer)
            ? answer.filter((item): item is string => typeof item === "string")
            : [],
        };
      }),
      timestamp: state.time?.end ?? message.info.time?.completed ?? message.info.time?.created ?? 0,
      afterItemId: null,
    };
  }
  if (part.tool === "todowrite" && Array.isArray(input.todos)) {
    return {
      type: "planChecklist",
      id: part.id,
      status,
      explanation: null,
      steps: input.todos.map((todo) => {
        const value = todo && typeof todo === "object" ? (todo as Record<string, unknown>) : {};
        return {
          step: typeof value.content === "string" ? value.content : "",
          status:
            value.status === "completed" || value.status === "cancelled"
              ? "completed"
              : value.status === "in_progress"
                ? "inProgress"
                : "pending",
        };
      }),
      timestamp: state.time?.end ?? state.time?.start ?? message.info.time?.created ?? 0,
      afterItemId: null,
    };
  }
  if (part.tool === "bash" || part.tool === "shell") {
    return {
      type: "command",
      id: part.id,
      status,
      kind: "command",
      command:
        managedCommands && typeof input.opennestOriginalCommand === "string"
          ? input.opennestOriginalCommand
          : String(input.command ?? ""),
      cwd: typeof input.workdir === "string" ? input.workdir : null,
      output: state.output ?? state.error ?? "",
      exitCode: typeof state.metadata?.exit === "number" ? state.metadata.exit : null,
    };
  }
  if (["edit", "write", "patch", "apply_patch"].includes(part.tool ?? "")) {
    return {
      type: "fileChange",
      id: part.id,
      status,
      path: typeof input.filePath === "string" ? input.filePath : null,
      patch:
        typeof state.metadata?.diff === "string"
          ? state.metadata.diff
          : typeof input.patchText === "string"
            ? input.patchText
            : typeof input.content === "string"
              ? input.content
              : (state.output ?? state.error ?? ""),
    };
  }
  return {
    type: "tool",
    id: part.id,
    status,
    title: state.title ?? part.tool ?? "OpenCode tool",
    detail: state.output ?? state.error ?? "",
    ...(state.attachments?.length
      ? {
          images: state.attachments
            .filter((attachment) => attachment.mime?.startsWith("image/"))
            .map((attachment) => nativeFilePath(attachment.url) ?? attachment.url),
        }
      : {}),
  };
}

/** Reconstruct turns from native user/assistant parentage; Nest does not persist a second transcript. */
export function projectTurns(
  messages: NativeMessage[],
  busy: boolean,
  options: { managedCommands?: boolean } = {},
): TurnView[] {
  const turns = new Map<string, TurnView>();
  let lastUser: string | undefined;
  const finalAssistant = new Map<string, NativeMessage>();
  let activeTurnId: string | undefined;
  for (const message of messages) {
    if (message.info.role === "user") activeTurnId = message.info.id;
    else if (message.info.role === "assistant" && !message.info.summary)
      finalAssistant.set(message.info.parentID ?? activeTurnId ?? message.info.id, message);
  }
  for (const message of messages) {
    const id =
      message.info.role === "user"
        ? message.info.id
        : (message.info.parentID ?? lastUser ?? message.info.id);
    if (message.info.role === "user") lastUser = id;
    let turn = turns.get(id);
    if (!turn) {
      turn = {
        id,
        status: "completed",
        startedAt: message.info.time?.created ?? null,
        completedAt: null,
        durationMs: null,
        progress: {
          startedAt: message.info.time?.created ?? null,
          explanation: null,
          steps: [],
          filesChanged: 0,
          additions: 0,
          deletions: 0,
        },
        items: [],
      };
      turns.set(id, turn);
    }
    const finalResponse =
      !(busy && id === activeTurnId) &&
      message === finalAssistant.get(id) &&
      !message.info.error &&
      message.info.finish !== "tool-calls" &&
      !message.parts.some((part) => part.type === "tool");
    const items = message.parts
      .map((part) => partActivity(part, message, finalResponse, options.managedCommands))
      .filter((item): item is ActivityItem => item !== null);
    turn.items.push(...items);
    const checklist = items.find((item) => item.type === "planChecklist");
    if (checklist?.type === "planChecklist") turn.progress.steps = checklist.steps;
    if (message.info.error) turn.status = "failed";
    else if (message.info.role === "assistant" && !message.info.time?.completed)
      turn.status = busy ? "inProgress" : "interrupted";
    if (message.info.time?.completed) turn.completedAt = message.info.time.completed;
    if (turn.startedAt !== null && turn.completedAt !== null)
      turn.durationMs = Math.max(0, turn.completedAt - turn.startedAt);
  }
  const result = [...turns.values()];
  const latest = result.at(-1);
  if (busy && latest && latest.status !== "failed") {
    latest.status = "inProgress";
    latest.completedAt = null;
    latest.durationMs = null;
  }
  return result;
}
