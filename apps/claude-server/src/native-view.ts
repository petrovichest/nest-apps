import { createHash } from "node:crypto";
import type { ActivityItem, ServerEvent, TurnView } from "@codexnest/protocol";
import { nativeResultInterrupted } from "./types.js";

type Json = Record<string, unknown>;
type StreamMessage = {
  id: string;
  turnId: string;
  blocks: Map<number, Json>;
  json: Map<number, string>;
};

function object(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function stable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(object)
    .filter((part) => part.type === "text")
    .map((part) => string(part.text))
    .join("\n");
}

/** Removes transport-only attachment context while preserving user text and cards. */
function userContent(content: unknown): {
  text: string;
  images: string[];
  files: Array<{ name: string; path: string }>;
} {
  let text = textContent(content);
  const files: Array<{ name: string; path: string }> = [];
  for (const marker of ["claudenest_attachments", "codexnest_attachments"]) {
    const start = text.lastIndexOf(`<${marker}>`);
    const end = text.indexOf(`</${marker}>`, start);
    if (start < 0 || end < 0) continue;
    const hidden = text.slice(start + marker.length + 2, end);
    const arrayStart = hidden.indexOf("[");
    try {
      const refs: unknown = JSON.parse(hidden.slice(arrayStart));
      if (Array.isArray(refs))
        for (const ref of refs)
          if (object(ref) && typeof ref.name === "string" && typeof ref.path === "string")
            files.push({ name: ref.name, path: ref.path });
    } catch {
      /* Older/native text remains readable even if its metadata was malformed. */
    }
    text = (text.slice(0, start).trimEnd() + text.slice(end + marker.length + 3)).trim();
  }
  const images: string[] = [];
  if (Array.isArray(content))
    for (const block of content) {
      if (!object(block) || block.type !== "image" || !object(block.source)) continue;
      if (
        block.source.type === "base64" &&
        typeof block.source.media_type === "string" &&
        typeof block.source.data === "string"
      )
        images.push(`data:${block.source.media_type};base64,${block.source.data}`);
      else if (block.source.type === "url" && typeof block.source.url === "string")
        images.push(block.source.url);
    }
  return { text, images, files };
}

/** Pure incremental rendering of native history and live events; never does I/O. */
export class NativeView {
  private readonly values: TurnView[] = [];
  private readonly byId = new Map<string, TurnView>();
  private readonly userTurns = new Map<string, TurnView>();
  private readonly continuingTurns = new Set<string>();
  private readonly tools = new Map<string, { turn: TurnView; item: ActivityItem }>();
  private readonly streams = new Map<string, StreamMessage>();
  private active?: TurnView;
  private latestStream?: StreamMessage;
  private effectiveModel?: string;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
  ) {}

  get model(): string | undefined {
    return this.effectiveModel;
  }
  get currentTurnId(): string | null {
    return this.active?.status === "inProgress" ? this.active.id : null;
  }
  turns(): TurnView[] {
    return structuredClone(this.values);
  }

  reset(events: readonly Json[], options: { live?: boolean } = {}): void {
    this.values.length = 0;
    this.byId.clear();
    this.userTurns.clear();
    this.continuingTurns.clear();
    this.tools.clear();
    this.streams.clear();
    this.active = undefined;
    this.latestStream = undefined;
    this.effectiveModel = undefined;
    for (const event of events) this.apply(event);
    if (!options.live)
      for (const turn of this.values)
        if (turn.status === "inProgress") this.complete(turn, "completed", null);
  }

  apply(event: Json): ServerEvent[] {
    if (event.isSidechain === true || event.parent_tool_use_id) return [];
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") this.effectiveModel = event.model;
      return [];
    }
    if (event.type === "stream_event" && object(event.event))
      return this.stream(event.event, event);
    if (event.type === "user" && object(event.message)) {
      const content = event.message.content;
      const results = Array.isArray(content)
        ? content.filter(object).filter((part) => part.type === "tool_result")
        : [];
      const changes: ServerEvent[] = [];
      for (const result of results) {
        const match = this.tools.get(string(result.tool_use_id));
        if (!match) continue;
        const output =
          textContent(result.content) ||
          (typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content ?? ""));
        const interrupted =
          /request interrupted by user/i.test(output) ||
          nativeResultInterrupted({ errors: [output] });
        match.item.status = result.is_error === true && !interrupted ? "failed" : "completed";
        if (match.item.type === "command") match.item.output = interrupted ? "" : output;
        else if (match.item.type === "tool") match.item.detail = interrupted ? "" : output;
        changes.push(this.upsert(match.turn, match.item));
      }
      const user = userContent(content);
      if (!user.text && !user.images.length && !user.files.length && results.length) return changes;
      if (/^\[Request interrupted by user(?: for tool use)?\]$/i.test(user.text.trim())) {
        if (this.active?.status === "inProgress") {
          this.complete(this.active, "interrupted", timestamp(event.timestamp));
          changes.push({
            type: "turn.replaced",
            threadId: this.sessionId,
            turn: structuredClone(this.active),
          });
        }
        return changes;
      }
      const id = string(event.uuid) || `user:${stable(event)}`;
      let turn = this.userTurns.get(id);
      if (!turn) {
        const steering =
          this.active?.status === "inProgress" &&
          (event.claudenest_delivery === "steer" || this.continuingTurns.has(this.active.id));
        if (steering) turn = this.active!;
        else {
          if (this.active?.status === "inProgress")
            this.complete(this.active, "completed", timestamp(event.timestamp));
          turn = this.makeTurn(id, timestamp(event.timestamp));
        }
        this.userTurns.set(id, turn);
      }
      this.active = turn;
      const item: ActivityItem = {
        type: "userMessage",
        id,
        status: "completed",
        text: user.text,
        images: user.images,
        ...(user.files.length ? { files: user.files } : {}),
        timestamp: timestamp(event.timestamp),
        phase: null,
      };
      this.put(turn, item);
      return [
        ...changes,
        { type: "turn.replaced", threadId: this.sessionId, turn: structuredClone(turn) },
      ];
    }
    if (event.type === "assistant" && object(event.message)) {
      const message = event.message;
      if (typeof message.model === "string") this.effectiveModel = message.model;
      const messageId = string(message.id) || string(event.uuid) || `assistant:${stable(event)}`;
      const streamed = this.streams.get(messageId);
      const turn = streamed
        ? this.byId.get(streamed.turnId)!
        : this.ensureTurn(messageId, timestamp(event.timestamp));
      const parts = Array.isArray(message.content)
        ? message.content.filter(object)
        : typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : [];
      if (message.stop_reason === "tool_use" || parts.some((part) => part.type === "tool_use"))
        this.continuingTurns.add(turn.id);
      else this.continuingTurns.delete(turn.id);
      const changes: ServerEvent[] = [];
      parts.forEach((part, index) => {
        const item = this.block(
          turn,
          messageId,
          index,
          part,
          "completed",
          timestamp(event.timestamp),
        );
        if (item) changes.push(this.upsert(turn, item));
      });
      return changes;
    }
    if (event.type === "result") {
      const turn = this.active;
      if (!turn) return [];
      const failed =
        event.is_error === true ||
        (typeof event.subtype === "string" && event.subtype.startsWith("error"));
      const interrupted = nativeResultInterrupted(event);
      const outcome = interrupted ? "interrupted" : failed ? "failed" : "completed";
      this.complete(turn, outcome, timestamp(event.timestamp));
      if (typeof event.duration_ms === "number") turn.durationMs = event.duration_ms;
      if (failed && !interrupted) {
        const rawErrors =
          textContent(event.errors) ||
          (Array.isArray(event.errors)
            ? event.errors.map(String).join("\n")
            : string(event.result));
        const message = rawErrors
          .split("\n")
          .filter((line) => !line.includes("[ede_diagnostic]"))
          .join("\n")
          .trim();
        const error: ActivityItem = {
          type: "error",
          id: `${turn.id}:error`,
          status: "failed",
          message: message || "Claude could not complete this turn",
        };
        this.put(turn, error);
      }
      return [{ type: "turn.replaced", threadId: this.sessionId, turn: structuredClone(turn) }];
    }
    return [];
  }

  private makeTurn(id: string, startedAt: number | null): TurnView {
    const turn: TurnView = {
      id,
      status: "inProgress",
      startedAt,
      completedAt: null,
      durationMs: null,
      progress: {
        startedAt,
        explanation: null,
        steps: [],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
      items: [],
      itemsLoaded: true,
    };
    this.values.push(turn);
    this.byId.set(id, turn);
    this.active = turn;
    return turn;
  }
  private ensureTurn(id: string, at: number | null): TurnView {
    return this.active ?? this.makeTurn(`native:${id}`, at);
  }
  private complete(
    turn: TurnView,
    status: "completed" | "failed" | "interrupted",
    at: number | null,
  ): void {
    turn.status = status;
    turn.completedAt = at;
    if (at !== null && turn.startedAt !== null) turn.durationMs = Math.max(0, at - turn.startedAt);
    for (const item of turn.items)
      if (item.status === "inProgress") item.status = status === "failed" ? "failed" : "completed";
    const messages = turn.items.filter((item) => item.type === "agentMessage");
    if (messages.length && status === "completed")
      (
        messages[messages.length - 1] as Extract<
          ActivityItem,
          { type: "userMessage" | "agentMessage" | "reasoning" | "plan" }
        >
      ).phase = "final_answer";
  }
  private put(turn: TurnView, item: ActivityItem): void {
    const index = turn.items.findIndex((value) => value.id === item.id);
    if (index < 0) turn.items.push(item);
    else turn.items[index] = item;
  }
  private upsert(turn: TurnView, item: ActivityItem): ServerEvent {
    this.put(turn, item);
    return {
      type: "activity.upserted",
      threadId: this.sessionId,
      turnId: turn.id,
      item: structuredClone(item),
    };
  }

  private block(
    turn: TurnView,
    messageId: string,
    index: number,
    part: Json,
    status: "inProgress" | "completed",
    at: number | null,
  ): ActivityItem | undefined {
    const id = `${messageId}:${index}`;
    if (part.type === "text" || part.type === "thinking")
      return {
        type: part.type === "thinking" ? "reasoning" : "agentMessage",
        id,
        status,
        text: string(part.text ?? part.thinking),
        images: [],
        timestamp: at,
        phase: part.type === "text" ? "commentary" : null,
      };
    if (part.type !== "tool_use") return undefined;
    const toolId = string(part.id) || id;
    const input = object(part.input) ? part.input : {};
    const name = string(part.name) || "Claude tool";
    const existing = this.tools.get(toolId);
    let item: ActivityItem;
    if (name === "Bash" || name === "Read" || name === "Grep" || name === "Glob") {
      item = {
        type: "command",
        id: toolId,
        status: existing?.item.status ?? "inProgress",
        kind: name === "Read" ? "read" : name === "Grep" || name === "Glob" ? "search" : "command",
        command:
          string(input.command) ||
          `${name} ${string(input.file_path ?? input.pattern ?? input.path)}`.trim(),
        cwd: this.cwd,
        output: existing?.item.type === "command" ? existing.item.output : "",
        exitCode: null,
      };
    } else if (
      name === "Edit" &&
      typeof input.old_string === "string" &&
      typeof input.new_string === "string"
    ) {
      item = {
        type: "fileChange",
        id: toolId,
        status: existing?.item.status ?? "inProgress",
        path: string(input.file_path) || null,
        patch: `--- ${string(input.file_path)}\n+++ ${string(input.file_path)}\n${input.old_string
          .split("\n")
          .map((line) => `-${line}`)
          .join("\n")}\n${input.new_string
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`,
      };
    } else
      item = {
        type: "tool",
        id: toolId,
        status: existing?.item.status ?? "inProgress",
        title: name,
        detail:
          existing?.item.type === "tool" && existing.item.status !== "inProgress"
            ? existing.item.detail
            : JSON.stringify(input, null, 2),
      };
    this.tools.set(toolId, { turn, item });
    return item;
  }

  private stream(event: Json, outer: Json): ServerEvent[] {
    if (event.type === "message_start" && object(event.message)) {
      const id = string(event.message.id) || string(outer.uuid) || `stream:${stable(event)}`;
      const turn = this.ensureTurn(id, timestamp(outer.timestamp));
      if (typeof event.message.model === "string") this.effectiveModel = event.message.model;
      this.latestStream = this.streams.get(id) ?? {
        id,
        turnId: turn.id,
        blocks: new Map(),
        json: new Map(),
      };
      this.streams.set(id, this.latestStream);
      return [];
    }
    const message = this.latestStream;
    if (!message) return [];
    const turn = this.byId.get(message.turnId)!;
    const index = typeof event.index === "number" ? event.index : 0;
    if (event.type === "content_block_start" && object(event.content_block))
      message.blocks.set(index, { ...event.content_block });
    else if (event.type === "content_block_delta" && object(event.delta)) {
      const block = message.blocks.get(index);
      if (!block) return [];
      if (event.delta.type === "text_delta")
        block.text = string(block.text) + string(event.delta.text);
      else if (event.delta.type === "thinking_delta")
        block.thinking = string(block.thinking) + string(event.delta.thinking);
      else if (event.delta.type === "input_json_delta") {
        const json = (message.json.get(index) ?? "") + string(event.delta.partial_json);
        message.json.set(index, json);
        try {
          block.input = JSON.parse(json);
        } catch {
          return [];
        }
      } else return [];
      if (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") {
        const itemId = `${message.id}:${index}`;
        const item = turn.items.find((value) => value.id === itemId);
        if (item && (item.type === "agentMessage" || item.type === "reasoning")) {
          item.text = string(block.text ?? block.thinking);
          return [
            {
              type: "activity.delta",
              threadId: this.sessionId,
              turnId: turn.id,
              itemId,
              activityType: item.type,
              delta: string(event.delta.text ?? event.delta.thinking),
            },
          ];
        }
      }
    } else if (event.type !== "content_block_stop") return [];
    const block = message.blocks.get(index);
    if (!block) return [];
    const item = this.block(
      turn,
      message.id,
      index,
      block,
      event.type === "content_block_stop" ? "completed" : "inProgress",
      timestamp(outer.timestamp),
    );
    return item ? [this.upsert(turn, item)] : [];
  }
}

export function normalizeNativeEvents(
  events: readonly Json[],
  options: { sessionId: string; cwd: string; live?: boolean },
): { turns: TurnView[]; model?: string } {
  const view = new NativeView(options.sessionId, options.cwd);
  view.reset(events, { live: options.live });
  return { turns: view.turns(), ...(view.model ? { model: view.model } : {}) };
}
