import { nativeResultInterrupted, type ClaudeModel } from "./types";

/** Quota names are retained for compatibility with persisted runner/recovery state. */
export interface NativeQuotaFailure {
  /** Missing means quota, for compatibility with existing runner snapshots. */
  reason?: "authentication";
  /** Sequence of the failed main result, scoped to its runner instance. */
  terminalSequence: number;
  confirmed: boolean;
  resetAt?: number;
}

export const QUOTA_CONTINUATION_MESSAGE =
  "Продолжи последнюю незавершённую задачу из сохранённой истории. " +
  "Выполнение остановилось из-за лимита аккаунта. Учитывай уже выполненные действия " +
  "и результаты инструментов; не повторяй завершённые действия.";

export const AUTH_CONTINUATION_MESSAGE = QUOTA_CONTINUATION_MESSAGE.replace(
  "из-за лимита аккаунта",
  "из-за истёкшей авторизации аккаунта",
);

export function quotaModel(model?: string, models: ClaudeModel[] = []): string | undefined {
  const resolved = models.find((item) => item.value === (model ?? "default"))?.resolvedModel;
  const selected = resolved ?? model;
  return selected && !/^(?:default|auto|<.*>)$/i.test(selected) ? selected : undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isMainNativeEvent(event: Record<string, unknown>): boolean {
  return !event.parent_tool_use_id;
}

function hasOverage(event: Record<string, unknown>): boolean {
  return ["isUsingOverage", "overageInUse", "is_using_overage", "overage_in_use"].some(
    (key) => event[key] === true,
  );
}

function resetTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 10_000_000_000 ? value * 1_000 : value;
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/** A 429 or an isolated process-wide quota event is never enough to rotate. */
export function nativeQuotaFailure(
  events: Record<string, unknown>[],
  now?: number,
): Omit<NativeQuotaFailure, "terminalSequence"> | undefined {
  const terminal = events.at(-1);
  if (
    !terminal ||
    terminal.type !== "result" ||
    !isMainNativeEvent(terminal) ||
    terminal.is_error !== true ||
    terminal.terminal_reason === "blocking_limit" ||
    nativeResultInterrupted(terminal)
  )
    return;
  // Inputs can be steered during a task; the initial input defines the turn.
  let lastResult = -1;
  for (let index = events.length - 2; index >= 0; index--)
    if (events[index]!.type === "result" && isMainNativeEvent(events[index]!)) {
      lastResult = index;
      break;
    }
  const turn = events.slice(lastResult + 1).filter(isMainNativeEvent);
  // Only native error envelopes count, never successful assistant/tool text quoting an error.
  const authError = (value: unknown) =>
    typeof value === "string" &&
    /^(?:Failed to authenticate:\s*)?OAuth (?:session|token) (?:has )?expired\b|^Not logged in[^\n]*(?:\/login|claude auth login)/i.test(
      value.trim(),
    );
  if (
    turn.some((event) => {
      if (event.type !== "assistant") return false;
      if (event.error === "authentication_failed") return true;
      if (typeof event.error !== "string" || !object(event.message)) return false;
      const content = event.message.content;
      return (
        authError(content) ||
        (Array.isArray(content) &&
          content.some((block) => object(block) && block.type === "text" && authError(block.text)))
      );
    }) ||
    authError(terminal.result) ||
    (Array.isArray(terminal.errors) && terminal.errors.some(authError))
  )
    return { confirmed: true, reason: "authentication" };
  const failure = [...turn]
    .reverse()
    .find((event) => event.type === "assistant" && event.error === "rate_limit");
  if (!failure) return;
  const details = JSON.stringify([failure.message, terminal.result, terminal.errors]);
  if (
    /overload(?:ed)?|capacity|temporarily unavailable|model (?:is )?not (?:available|supported)|not (?:available|included) (?:on|in) (?:your|this) plan|context (?:window|limit)|credits? (?:required|exhausted)/i.test(
      details,
    )
  )
    return;
  if (hasOverage(terminal) || hasOverage(failure)) return;
  const time = now ?? Date.now();
  let confirmed = false;
  let resetAt: number | undefined;
  for (const event of turn) {
    if (event.type !== "rate_limit_event") continue;
    const info = event.rate_limit_info;
    if (!object(info)) continue;
    if (hasOverage(info) || hasOverage(event)) return;
    const type = info.rateLimitType ?? info.rate_limit_type;
    const reset = resetTime(info.resetsAt ?? info.resets_at);
    if (
      info.status === "rejected" &&
      typeof type === "string" &&
      /^(?:five_hour|seven_day)(?:_(?:sonnet|opus))?$/.test(type) &&
      reset > time
    ) {
      confirmed = true;
      resetAt = Math.max(resetAt ?? 0, reset);
    }
  }
  // A missing structured signal needs a fresh get_usage check of the failed account.
  return { confirmed, ...(resetAt ? { resetAt } : {}) };
}
