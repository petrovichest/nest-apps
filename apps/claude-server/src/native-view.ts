import { createHash } from "node:crypto";
import {
  pastedText,
  type ActivityItem,
  type QueuedMessage,
  type ServerEvent,
  type TurnPlanStep,
  type TurnView,
} from "@codexnest/protocol";
import { nativeResultInterrupted, subagentThreadId } from "./types.js";

type Json = Record<string, unknown>;
type StreamMessage = {
  id: string;
  turnId: string;
  blocks: Map<number, Json>;
  json: Map<number, string>;
  activeBlock?: { index: number; type: string };
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
function sourceKey(event: Json): string {
  const id = string(event.uuid);
  return id && event.type === "assistant" && object(event.message)
    ? `${id}:${string(event.message.id)}`
    : id;
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
const PLAN_FILE = /[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/;
/** Tools whose native results are rendered as dedicated timeline items instead of tool rows. */
const STRUCTURED_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite", "AskUserQuestion"]);
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

export type SubagentStatus = "running" | "completed" | "failed" | "interrupted";
export interface SubagentLaunch {
  toolUseId: string;
  threadId: string;
  title: string;
  agentType: string | null;
  status: SubagentStatus;
  startedAt: number | null;
}

function stepStatus(value: unknown): TurnPlanStep["status"] {
  return value === "completed" ? "completed" : value === "in_progress" ? "inProgress" : "pending";
}

export class NativeView {
  private readonly values: TurnView[] = [];
  private readonly byId = new Map<string, TurnView>();
  private readonly userTurns = new Map<string, TurnView>();
  private readonly messageTurns = new Map<string, TurnView>();
  private readonly sourceMetadata = new Map<string, Json>();
  private readonly continuingTurns = new Set<string>();
  private readonly quotaContinuations = new Set<string>();
  private readonly tools = new Map<
    string,
    {
      turn: TurnView;
      item: ActivityItem;
      imagePath?: string;
      /** Structured tools render through their native result instead of a tool row. */
      structured?: { name: string; input: Json };
      agentType?: string;
    }
  >();
  /** Native task list (TaskCreate/TaskUpdate or legacy TodoWrite), shared by all turns. */
  private readonly tasks = new Map<string, TurnPlanStep>();
  /** Native background task status by Agent tool use ID, from system task events. */
  private readonly agentStatus = new Map<string, SubagentStatus>();
  private readonly agentTasks = new Map<string, string>();
  private readonly streams = new Map<string, StreamMessage>();
  /** Claude omits the plan from ExitPlanMode's transcript input; ClaudeNest keeps it here. */
  private readonly planTexts = new Map<string, string>();
  private latestPlanFile = "";
  private active?: TurnView;
  private latestStream?: StreamMessage;
  private effectiveModel?: string;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    /** Renders one native subagent: its sidechain transcript and live events for this tool use. */
    readonly subagentToolUseId?: string,
  ) {}

  /** Keeps the native recovery input in Claude's history while hiding it in the chat. */
  rememberQuotaContinuation(id: string): void {
    this.quotaContinuations.add(id);
  }

  /** Events that belong to another conversation than the one this view renders. */
  private foreign(event: Json): boolean {
    if (this.subagentToolUseId === undefined)
      return event.isSidechain === true || Boolean(event.parent_tool_use_id);
    return Boolean(event.parent_tool_use_id) && event.parent_tool_use_id !== this.subagentToolUseId;
  }

  /** Native subagents launched by this conversation, in launch order. */
  subagents(): SubagentLaunch[] {
    const launches: SubagentLaunch[] = [];
    for (const [toolUseId, { turn, item, agentType }] of this.tools) {
      if (item.type !== "subagentLaunch") continue;
      const native = this.agentStatus.get(toolUseId);
      launches.push({
        toolUseId,
        threadId: item.threadId!,
        title: item.title,
        agentType: agentType ?? null,
        status:
          native ??
          (item.status === "failed"
            ? "failed"
            : item.status === "completed"
              ? "completed"
              : turn.status === "inProgress"
                ? "running"
                : turn.status === "interrupted"
                  ? "interrupted"
                  : "completed"),
        startedAt: item.timestamp ?? turn.startedAt,
      });
    }
    return launches;
  }

  /** Finishes an in-progress subagent turn once its parent tool call has ended. */
  settle(status: "completed" | "failed" | "interrupted"): ServerEvent[] {
    const turn = this.active;
    if (turn?.status !== "inProgress") return [];
    this.complete(turn, status, null);
    return [{ type: "turn.replaced", threadId: this.sessionId, turn: structuredClone(turn) }];
  }

  get model(): string | undefined {
    return this.effectiveModel;
  }
  get currentTurnId(): string | null {
    return this.active?.status === "inProgress" ? this.active.id : null;
  }
  turns(): TurnView[] {
    return structuredClone(this.values);
  }

  hasToolImagePath(path: string): boolean {
    return this.values.some((turn) =>
      turn.items.some(
        (item) =>
          item.type === "tool" && item.status === "completed" && item.images?.includes(path),
      ),
    );
  }

  rememberPlanText(toolUseId: string, text: string): void {
    this.planTexts.set(toolUseId, text);
  }

  /** Fills an ExitPlanMode plan from its permission request; older owners omit the tool ID. */
  presentPlan(
    toolUseId: string | undefined,
    text: string,
  ): { toolUseId: string; events: ServerEvent[] } | undefined {
    for (const turn of [...this.values].reverse()) {
      const item = [...turn.items]
        .reverse()
        .find((value) =>
          toolUseId ? value.id === toolUseId : value.type === "plan" && !value.text.trim(),
        );
      if (item?.type !== "plan") continue;
      this.planTexts.set(item.id, text);
      item.text = text;
      return { toolUseId: item.id, events: [this.upsert(turn, item)] };
    }
    if (!toolUseId) return undefined;
    this.planTexts.set(toolUseId, text);
    return { toolUseId, events: [] };
  }

  recordUserMessage(message: QueuedMessage): ServerEvent[] {
    this.apply({
      type: "user",
      uuid: message.id,
      timestamp: message.createdAt,
      claudenest_delivery: message.deliveryMode,
      message: { content: message.text },
    });
    const turn = this.userTurns.get(message.id)!;
    this.put(turn, {
      type: "userMessage",
      id: message.id,
      status: "completed",
      text: message.text,
      ...pastedText(message),
      images: message.images ?? [],
      ...(message.files?.length ? { files: message.files } : {}),
      timestamp: message.createdAt,
      phase: null,
    });
    return [{ type: "turn.replaced", threadId: this.sessionId, turn: structuredClone(turn) }];
  }

  reset(events: readonly Json[], options: { live?: boolean; preserveInputs?: boolean } = {}): void {
    if (!options.preserveInputs) this.sourceMetadata.clear();
    // SDK events omit transcript metadata, but retain the transcript entry UUID.
    // Index it before replay so canonical block indices and internal input flags win.
    for (const event of events) this.rememberSourceMetadata(event);
    events = events.map((event) => this.withSourceMetadata(event));
    const previous = options.preserveInputs
      ? this.values.flatMap((turn) => turn.items.map((item) => ({ turn, item })))
      : [];
    const retained = previous.filter(
      (entry): entry is { turn: TurnView; item: ActivityItem & { type: "userMessage" } } =>
        entry.item.type === "userMessage" &&
        this.sourceMetadata.get(entry.item.id)?.isMeta !== true &&
        this.sourceMetadata.get(entry.item.id)?.turnCompanion !== true,
    );
    // Owner snapshots can precede a native input echo. Replay the existing
    // inputs at their stable neighboring activities, then retain their UI data.
    const positions = new Map<string, { first: number; last: number }>();
    const results = new Map<string, { first: number; last: number }>();
    const note = (map: Map<string, { first: number; last: number }>, id: string, index: number) => {
      const position = map.get(id);
      if (position) position.last = index;
      else map.set(id, { first: index, last: index });
    };
    let streamId = "";
    const streamBlocks = new Map<number, string>();
    let sourceTurn: TurnView | undefined;
    if (retained.length)
      events.forEach((event, index) => {
        if (this.foreign(event)) return;
        let ids: string[] = [];
        if (event.type === "attachment" && object(event.attachment)) {
          const id = string(event.attachment.source_uuid) || string(event.uuid);
          if (event.attachment.type === "queued_command") {
            if (event.isMeta === true || event.turnCompanion === true) return;
            ids = [id];
            sourceTurn = this.userTurns.get(id);
          }
        } else if (event.type === "user" && object(event.message)) {
          if (event.isMeta === true || event.turnCompanion === true) return;
          const id = string(event.uuid);
          const content = event.message.content;
          const tools = Array.isArray(content)
            ? content.filter(object).filter((part) => part.type === "tool_result")
            : [];
          if (tools.length) ids = tools.map((part) => string(part.tool_use_id));
          else {
            ids = [id];
            sourceTurn = this.userTurns.get(id);
          }
        } else if (event.type === "assistant" && object(event.message)) {
          const id = string(event.message.id);
          sourceTurn = this.messageTurns.get(id);
          const offset = typeof event.apiBlockIndex === "number" ? event.apiBlockIndex : 0;
          const content = Array.isArray(event.message.content) ? event.message.content : [];
          ids = content
            .filter(object)
            .map((part, block) =>
              part.type === "tool_use" ? string(part.id) : `${id}:${offset + block}`,
            );
        } else if (event.type === "stream_event" && object(event.event)) {
          const native = event.event;
          if (native.type === "message_start" && object(native.message)) {
            streamId = string(native.message.id);
            streamBlocks.clear();
            sourceTurn = this.messageTurns.get(streamId);
            const first = this.streams.get(streamId)?.blocks.get(0);
            ids = [first?.type === "tool_use" ? string(first.id) : `${streamId}:0`];
          } else if (typeof native.index === "number") {
            const part = object(native.content_block) ? native.content_block : undefined;
            const id =
              part?.type === "tool_use"
                ? string(part.id)
                : streamBlocks.get(native.index) || `${streamId}:${native.index}`;
            streamBlocks.set(native.index, id);
            ids = [id];
          }
        } else if (event.type === "result" && sourceTurn) note(results, sourceTurn.id, index);
        for (const id of ids) if (id) note(positions, id, index);
      });
    const inputs = new Map<number, typeof retained>();
    for (const entry of retained) {
      const index = previous.indexOf(entry);
      const next = previous.slice(index + 1).find((value) => positions.has(value.item.id));
      const before = previous
        .slice(0, index)
        .reverse()
        .find((value) => positions.has(value.item.id));
      const own = positions.get(entry.item.id)?.first;
      let position = next ? positions.get(next.item.id)!.first : 0;
      if (!next && before) {
        const last = positions.get(before.item.id)!.last;
        position =
          before.turn.id === entry.turn.id
            ? last + 1
            : Math.max(last, results.get(before.turn.id)?.last ?? last) + 1;
      }
      if (!next && results.has(entry.turn.id))
        position = Math.min(position, results.get(entry.turn.id)!.first);
      if (own !== undefined) position = Math.min(position, own);
      const entries = inputs.get(position) ?? [];
      entries.push(entry);
      inputs.set(position, entries);
    }
    this.values.length = 0;
    this.byId.clear();
    this.userTurns.clear();
    this.messageTurns.clear();
    this.continuingTurns.clear();
    this.tools.clear();
    this.tasks.clear();
    this.agentStatus.clear();
    this.agentTasks.clear();
    this.streams.clear();
    this.latestPlanFile = "";
    this.active = undefined;
    this.latestStream = undefined;
    this.effectiveModel = undefined;
    for (let index = 0; index <= events.length; index++) {
      for (const { turn, item } of inputs.get(index) ?? [])
        this.apply({
          type: "user",
          uuid: item.id,
          timestamp: item.timestamp,
          claudenest_delivery:
            turn.items.find((value) => value.type === "userMessage")?.id === item.id
              ? "queue"
              : "steer",
          message: { content: item.text },
        });
      if (index < events.length) this.apply(events[index]!);
    }
    for (const { item } of retained) {
      const turn = this.userTurns.get(item.id);
      if (turn) this.put(turn, item);
    }
    if (!options.live)
      for (const turn of this.values)
        if (turn.status === "inProgress") this.complete(turn, "completed", null);
  }

  apply(event: Json): ServerEvent[] {
    event = this.withSourceMetadata(event);
    if (this.foreign(event)) return [];
    if (
      event.type === "user" &&
      (event.claudenest_quota_continuation === true ||
        this.quotaContinuations.has(string(event.uuid)))
    ) {
      const id = string(event.uuid);
      this.quotaContinuations.add(id);
      const turn =
        this.userTurns.get(id) ??
        this.active ??
        this.makeTurn(`continuation:${id}`, timestamp(event.timestamp));
      this.userTurns.set(id, turn);
      this.active = turn;
      turn.status = "inProgress";
      turn.completedAt = null;
      turn.durationMs = null;
      return [{ type: "turn.replaced", threadId: this.sessionId, turn: structuredClone(turn) }];
    }
    if (
      event.type === "attachment" &&
      object(event.attachment) &&
      event.attachment.type === "queued_command"
    ) {
      if (event.isMeta === true || event.turnCompanion === true) return [];
      const command = event.attachment;
      return this.apply({
        type: "user",
        uuid: string(command.source_uuid) || string(event.uuid),
        timestamp: command.timestamp ?? event.timestamp,
        claudenest_delivery: "steer",
        message: { content: command.prompt },
      });
    }
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") this.effectiveModel = event.model;
      return [];
    }
    if (event.type === "system" && typeof event.subtype === "string") {
      this.taskEvent(event);
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
        if (match.structured) {
          changes.push(...this.structuredResult(match.turn, match.structured, result, event));
          continue;
        }
        if (match.item.type === "plan") {
          match.item.status = "completed";
          changes.push(this.upsert(match.turn, match.item));
          continue;
        }
        const images = userContent(result.content).images;
        const output =
          textContent(result.content) ||
          (images.length
            ? ""
            : typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content ?? ""));
        const interrupted =
          /request interrupted by user/i.test(output) ||
          nativeResultInterrupted({ errors: [output] });
        match.item.status = result.is_error === true && !interrupted ? "failed" : "completed";
        if (images.length && match.item.status === "completed" && !interrupted) {
          if (match.imagePath) {
            match.item = {
              type: "tool",
              id: match.item.id,
              status: "completed",
              title: "Read",
              detail: output || match.imagePath,
              images: [match.imagePath],
            };
          } else if (match.item.type === "tool") match.item.images = images;
        }
        if (match.item.type === "command") match.item.output = interrupted ? "" : output;
        else if (match.item.type === "tool")
          match.item.detail = interrupted
            ? ""
            : output || (images.length ? (match.imagePath ?? "") : "");
        changes.push(this.upsert(match.turn, match.item));
      }
      if (event.isMeta === true || event.turnCompanion === true) return changes;
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
      // Claude emits this one-block coordinate annotation after reading an image.
      // Actual UI input is a string, an attachment, or already has delivery identity.
      if (
        !this.userTurns.has(id) &&
        event.claudenest_delivery === undefined &&
        Array.isArray(content) &&
        content.length === 1 &&
        object(content[0]) &&
        content[0].type === "text" &&
        /^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]$/.test(
          user.text,
        ) &&
        this.active?.items.some(
          (item) =>
            item.type === "tool" &&
            item.title === "Read" &&
            item.status === "completed" &&
            Boolean(item.images?.length),
        )
      )
        return changes;
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
      if (typeof message.model === "string" && message.model !== "<synthetic>")
        this.effectiveModel = message.model;
      const messageId = string(message.id) || string(event.uuid) || `assistant:${stable(event)}`;
      const turn = this.ensureTurn(messageId, timestamp(event.timestamp));
      const parts = Array.isArray(message.content)
        ? message.content.filter(object)
        : typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : [];
      if (message.stop_reason === "tool_use" || parts.some((part) => part.type === "tool_use"))
        this.continuingTurns.add(turn.id);
      else this.continuingTurns.delete(turn.id);
      const changes: ServerEvent[] = [];
      const activeBlock = this.streams.get(messageId)?.activeBlock;
      const compactBlock =
        parts.length === 1 && message.stop_reason === null && activeBlock?.type === parts[0]?.type;
      const blockOffset =
        typeof event.apiBlockIndex === "number" &&
        Number.isInteger(event.apiBlockIndex) &&
        event.apiBlockIndex >= 0
          ? event.apiBlockIndex
          : compactBlock
            ? activeBlock!.index
            : 0;
      if (compactBlock && string(event.uuid))
        this.sourceMetadata.set(sourceKey(event), {
          ...this.sourceMetadata.get(sourceKey(event)),
          apiBlockIndex: blockOffset,
        });
      parts.forEach((part, index) => {
        const item = this.block(
          turn,
          messageId,
          blockOffset + index,
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

  /** Tracks native background agent lifecycles reported by system task events. */
  private taskEvent(event: Json): void {
    const taskId = string(event.task_id);
    const toolUseId = string(event.tool_use_id) || this.agentTasks.get(taskId) || "";
    if (taskId && toolUseId) this.agentTasks.set(taskId, toolUseId);
    if (!toolUseId) return;
    const status =
      event.subtype === "task_started"
        ? "running"
        : event.subtype === "task_notification"
          ? event.status
          : event.subtype === "task_updated" && object(event.patch)
            ? event.patch.status
            : undefined;
    if (status === "running" || status === "completed" || status === "failed")
      this.agentStatus.set(toolUseId, status);
    else if (status === "killed" || status === "stopped" || status === "cancelled")
      this.agentStatus.set(toolUseId, "interrupted");
  }

  /** Renders task-list updates and answered questions from their native tool results. */
  private structuredResult(
    turn: TurnView,
    tool: { name: string; input: Json },
    result: Json,
    event: Json,
  ): ServerEvent[] {
    if (result.is_error === true) return [];
    const native = object(event.tool_use_result)
      ? event.tool_use_result
      : object(event.toolUseResult)
        ? event.toolUseResult
        : {};
    const at = timestamp(event.timestamp);
    if (tool.name === "AskUserQuestion") {
      const answers = object(native.answers) ? native.answers : {};
      const questions = Array.isArray(native.questions) ? native.questions : tool.input.questions;
      if (!Array.isArray(questions) || !Object.keys(answers).length) return [];
      const item: ActivityItem = {
        type: "userInputResponse",
        id: `${string(result.tool_use_id)}:response`,
        status: "completed",
        entries: questions.filter(object).map((question) => {
          const answer = answers[string(question.question)];
          return {
            header: string(question.header),
            question: string(question.question),
            answers: typeof answer === "string" && answer ? [answer] : [],
          };
        }),
        timestamp: at ?? turn.startedAt ?? 0,
        afterItemId: turn.items.at(-1)?.id ?? null,
      };
      return [this.upsert(turn, item)];
    }
    if (tool.name === "TodoWrite") {
      if (!Array.isArray(tool.input.todos)) return [];
      this.tasks.clear();
      tool.input.todos.filter(object).forEach((todo, index) => {
        this.tasks.set(String(index), {
          step: string(todo.content),
          status: stepStatus(todo.status),
        });
      });
    } else if (tool.name === "TaskCreate") {
      const created = object(native.task) ? string(native.task.id) : "";
      const id = created || /#(\S+)/.exec(textContent(result.content))?.[1] || "";
      if (!id) return [];
      this.tasks.set(id, {
        step:
          string(tool.input.subject) || (object(native.task) ? string(native.task.subject) : ""),
        status: "pending",
      });
    } else {
      const id = string(tool.input.taskId) || string(native.taskId);
      const task = this.tasks.get(id);
      if (!task) return [];
      if (tool.input.status === "deleted") this.tasks.delete(id);
      else
        this.tasks.set(id, {
          step: string(tool.input.subject) || task.step,
          status: tool.input.status === undefined ? task.status : stepStatus(tool.input.status),
        });
    }
    return this.publishTasks(turn, at);
  }

  /** Keeps one checklist per turn at the latest task-list update, like a plan update. */
  private publishTasks(turn: TurnView, at: number | null): ServerEvent[] {
    const id = `${turn.id}:tasks`;
    const index = turn.items.findIndex((item) => item.id === id);
    if (index >= 0) turn.items.splice(index, 1);
    const steps = [...this.tasks.values()].map((step) => ({ ...step }));
    turn.progress = { ...turn.progress, steps };
    if (steps.length)
      turn.items.push({
        type: "planChecklist",
        id,
        status: turn.status === "inProgress" ? "inProgress" : "completed",
        explanation: null,
        steps,
        timestamp: at ?? turn.startedAt ?? 0,
        afterItemId: turn.items.at(-1)?.id ?? null,
      });
    return [{ type: "turn.replaced", threadId: this.sessionId, turn: structuredClone(turn) }];
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
  private rememberSourceMetadata(event: Json): void {
    const id = sourceKey(event);
    if (!id || this.foreign(event)) return;
    const metadata: Json = {};
    if (
      typeof event.apiBlockIndex === "number" &&
      Number.isInteger(event.apiBlockIndex) &&
      event.apiBlockIndex >= 0
    )
      metadata.apiBlockIndex = event.apiBlockIndex;
    const command =
      event.type === "attachment" &&
      object(event.attachment) &&
      event.attachment.type === "queued_command"
        ? event.attachment
        : undefined;
    const input = event.type === "user" ? event : command;
    const notification =
      command?.commandMode === "task-notification" ||
      (input && object(input.origin) && input.origin.kind === "task-notification");
    if (event.isMeta === true || notification) metadata.isMeta = true;
    if (event.turnCompanion === true) metadata.turnCompanion = true;
    if (Object.keys(metadata).length) {
      this.sourceMetadata.set(id, { ...this.sourceMetadata.get(id), ...metadata });
      // Queued attachments and their SDK input echoes use different entry UUIDs.
      const sourceId = notification && command ? string(command.source_uuid) : "";
      if (sourceId)
        this.sourceMetadata.set(sourceId, {
          ...this.sourceMetadata.get(sourceId),
          isMeta: true,
        });
    }
  }
  private withSourceMetadata(event: Json): Json {
    this.rememberSourceMetadata(event);
    const source = this.sourceMetadata.get(sourceKey(event));
    return source
      ? {
          ...event,
          ...(source.isMeta === true ? { isMeta: true } : {}),
          ...(source.turnCompanion === true ? { turnCompanion: true } : {}),
          ...(event.apiBlockIndex === undefined &&
          object(event.message) &&
          Array.isArray(event.message.content) &&
          event.message.content.length === 1 &&
          source.apiBlockIndex !== undefined
            ? { apiBlockIndex: source.apiBlockIndex }
            : {}),
        }
      : event;
  }
  private ensureTurn(id: string, at: number | null): TurnView {
    const saved = this.messageTurns.get(id);
    if (saved) return saved;
    const turn = this.active ?? this.makeTurn(`native:${id}`, at);
    this.messageTurns.set(id, turn);
    return turn;
  }
  private complete(
    turn: TurnView,
    status: "completed" | "failed" | "interrupted",
    at: number | null,
  ): void {
    turn.status = status;
    turn.completedAt = at ?? turn.completedAt;
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
  private put(turn: TurnView, item: ActivityItem): ActivityItem {
    const index = turn.items.findIndex((value) => value.id === item.id);
    if (index < 0) {
      // A delayed input admission can arrive after its reply. Assistant/tool
      // blocks retain native sequence order, including blocks without a clock.
      const at = item.type === "userMessage" ? item.timestamp : null;
      const before =
        at != null
          ? turn.items.findIndex(
              (value) => "timestamp" in value && value.timestamp != null && value.timestamp > at,
            )
          : -1;
      turn.items.splice(before < 0 ? turn.items.length : before, 0, item);
    } else {
      const previous = turn.items[index]!;
      if (previous.status === "completed" && item.status === "inProgress") return previous;
      if ("timestamp" in previous && "timestamp" in item && item.timestamp == null)
        item = { ...item, timestamp: previous.timestamp } as ActivityItem;
      if (
        previous.type === "userMessage" &&
        item.type === "userMessage" &&
        previous.timestamp !== null &&
        item.timestamp !== null
      ) {
        item = {
          ...item,
          ...pastedText(previous),
          images: item.images.length ? item.images : previous.images,
          ...(!item.files?.length && previous.files?.length ? { files: previous.files } : {}),
          timestamp: Math.min(previous.timestamp, item.timestamp),
        };
        if (item.timestamp! < previous.timestamp) {
          turn.items.splice(index, 1);
          return this.put(turn, item);
        }
      }
      if (
        previous.type === "agentMessage" &&
        item.type === "agentMessage" &&
        previous.phase === "final_answer"
      )
        item = { ...item, phase: previous.phase };
      turn.items[index] = item;
    }
    return item;
  }
  private upsert(turn: TurnView, item: ActivityItem): ServerEvent {
    item = this.put(turn, item);
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
    if (name === "Read" && existing?.item.type === "tool" && existing.item.images?.length)
      return existing.item;
    if (STRUCTURED_TOOLS.has(name)) {
      this.tools.set(toolId, {
        turn,
        item: existing?.item ?? { type: "tool", id: toolId, status, title: name, detail: "" },
        structured: { name, input },
      });
      return undefined;
    }
    let item: ActivityItem;
    if (name === "Write" && PLAN_FILE.test(string(input.file_path)))
      this.latestPlanFile = string(input.content);
    if (name === "ExitPlanMode") {
      // Its result only records ClaudeNest's review handoff, not a plan failure.
      item = {
        type: "plan",
        id: toolId,
        status: existing?.item.status ?? status,
        text: string(input.plan) || this.planTexts.get(toolId) || this.latestPlanFile,
        images: [],
        timestamp: at,
        phase: null,
      };
    } else if (SUBAGENT_TOOLS.has(name) && (input.subagent_type || input.prompt)) {
      item = {
        type: "subagentLaunch",
        id: toolId,
        status: existing?.item.status ?? "inProgress",
        title: string(input.description) || string(input.subagent_type) || name,
        threadId: subagentThreadId(this.sessionId, toolId),
        source: "claude",
        timestamp: existing?.item.type === "subagentLaunch" ? existing.item.timestamp : at,
      };
    } else if (name === "Bash" || name === "Read" || name === "Grep" || name === "Glob") {
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
    this.tools.set(toolId, {
      turn,
      item,
      ...(item.type === "subagentLaunch" && input.subagent_type
        ? { agentType: string(input.subagent_type) }
        : {}),
      ...(name === "Read" && typeof input.file_path === "string"
        ? { imagePath: input.file_path }
        : {}),
    });
    return item;
  }

  private stream(event: Json, outer: Json): ServerEvent[] {
    if (event.type === "message_start" && object(event.message)) {
      const id = string(event.message.id) || string(outer.uuid) || `stream:${stable(event)}`;
      const turn = this.ensureTurn(id, timestamp(outer.timestamp));
      if (typeof event.message.model === "string" && event.message.model !== "<synthetic>")
        this.effectiveModel = event.message.model;
      this.latestStream = this.streams.get(id) ?? {
        id,
        turnId: turn.id,
        blocks: new Map(),
        json: new Map(),
      };
      this.streams.set(id, this.latestStream);
      this.latestStream.activeBlock = undefined;
      return [];
    }
    const message = this.latestStream;
    if (!message) return [];
    const turn = this.byId.get(message.turnId)!;
    const index = typeof event.index === "number" ? event.index : 0;
    if (event.type === "content_block_start" && object(event.content_block))
      message.activeBlock = { index, type: string(event.content_block.type) };
    else if (event.type === "content_block_stop" && message.activeBlock?.index === index)
      message.activeBlock = undefined;
    const existing = turn.items.find((item) => item.id === `${message.id}:${index}`);
    if (existing?.status === "completed") return [];
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
