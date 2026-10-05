import { describe, expect, it } from "vitest";
import { parseClaudeUsage } from "./rate-limits";

describe("Claude plan usage", () => {
  it("maps the five-hour and weekly windows onto the sidebar limits", () => {
    expect(
      parseClaudeUsage({
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: "2026-10-05T23:00:00.036259+00:00" },
          seven_day: { utilization: 1.5, resets_at: null },
          seven_day_opus: null,
          limits: [{ kind: "session", percent: 10 }],
        },
        behaviors: null,
      }),
    ).toEqual({
      primary: {
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: Date.parse("2026-10-05T23:00:00.036Z"),
      },
      secondary: { usedPercent: 1.5, windowDurationMins: 10_080, resetsAt: null },
    });
  });

  it("reports no windows when plan limits do not apply or are malformed", () => {
    expect(parseClaudeUsage({ rate_limits_available: false, rate_limits: null })).toEqual({
      primary: null,
      secondary: null,
    });
    expect(
      parseClaudeUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: "10" }, seven_day: null },
      }),
    ).toEqual({ primary: null, secondary: null });
  });

  it("rejects an unrecognised response instead of showing empty limits", () => {
    expect(() => parseClaudeUsage({})).toThrow("unexpected usage response");
    expect(() => parseClaudeUsage(null)).toThrow("unexpected usage response");
  });

  it("rejects an unavailable usage read for a supported plan", () => {
    expect(() => parseClaudeUsage({ rate_limits_available: true, rate_limits: null })).toThrow(
      "usage is currently unavailable",
    );
  });
});
