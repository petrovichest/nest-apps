import type { CodexRateLimitWindow, CodexRateLimitsResponse } from "@codexnest/protocol";

const FIVE_HOURS_MINS = 5 * 60;
const SEVEN_DAYS_MINS = 7 * 24 * 60;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function window(value: unknown, windowDurationMins: number): CodexRateLimitWindow | null {
  if (!object(value)) return null;
  const { utilization, resets_at: resetsAt } = value;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const reset = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
  return {
    usedPercent: utilization,
    windowDurationMins,
    resetsAt: Number.isFinite(reset) ? reset : null,
  };
}

/** Maps the CLI's experimental get_usage answer onto the shared sidebar contract. */
export function parseClaudeUsage(value: unknown): CodexRateLimitsResponse {
  if (!object(value) || typeof value.rate_limits_available !== "boolean")
    throw new Error("Claude CLI returned an unexpected usage response");
  if (!value.rate_limits_available) return { primary: null, secondary: null };
  const limits = value.rate_limits;
  if (!object(limits)) throw new Error("Claude CLI usage is currently unavailable");
  return {
    primary: window(limits.five_hour, FIVE_HOURS_MINS),
    secondary: window(limits.seven_day, SEVEN_DAYS_MINS),
  };
}
