import { describe, expect, it } from "vitest";
import { nativeQuotaFailure, quotaModel } from "./quota-recovery";

const now = Date.parse("2026-10-06T12:00:00Z");
const signal = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: (now + 60_000) / 1000,
  },
};
const assistant = {
  type: "assistant",
  error: "rate_limit",
  message: {
    content: [{ type: "text", text: "You've hit your limit" }],
  },
};
const result = { type: "result", is_error: true, subtype: "error_during_execution" };

describe("native quota failure classification", () => {
  it("resolves the default model and excludes synthetic error-model names", () => {
    expect(
      quotaModel("default", [
        {
          value: "default",
          resolvedModel: "claude-sonnet-4-6",
          displayName: "Default",
          description: "",
        },
      ]),
    ).toBe("claude-sonnet-4-6");
    expect(quotaModel("<synthetic>")).toBeUndefined();
    expect(quotaModel("default")).toBeUndefined();
    expect(quotaModel("opus")).toBe("opus");
  });
  it("requires a failed main assistant and failed main terminal result", () => {
    expect(nativeQuotaFailure([signal, assistant, result], now)).toEqual({
      confirmed: true,
      resetAt: now + 60_000,
    });
    expect(nativeQuotaFailure([signal, result], now)).toBeUndefined();
    expect(
      nativeQuotaFailure([signal, assistant, { ...result, is_error: false }], now),
    ).toBeUndefined();
    expect(nativeQuotaFailure([signal, assistant], now)).toBeUndefined();
  });
  it("asks for fresh account usage when structured quota evidence is missing or stale", () => {
    expect(nativeQuotaFailure([assistant, result], now)).toEqual({ confirmed: false });
    expect(
      nativeQuotaFailure(
        [
          { ...signal, rate_limit_info: { ...signal.rate_limit_info, resetsAt: now / 1000 - 1 } },
          assistant,
          result,
        ],
        now,
      ),
    ).toEqual({ confirmed: false });
  });
  it("never treats bare 429, capacity, context, interruption or overage as quota", () => {
    expect(nativeQuotaFailure([{ type: "assistant", error: "429" }, result], now)).toBeUndefined();
    for (const text of [
      "Service capacity temporarily unavailable",
      "Model not available on your plan",
      "Context window limit",
      "Extra usage credits exhausted",
    ])
      expect(
        nativeQuotaFailure([signal, { ...assistant, message: { content: text } }, result], now),
      ).toBeUndefined();
    expect(
      nativeQuotaFailure(
        [signal, assistant, { ...result, terminal_reason: "blocking_limit" }],
        now,
      ),
    ).toBeUndefined();
    expect(
      nativeQuotaFailure([signal, assistant, { ...result, claudenest_interrupted: true }], now),
    ).toBeUndefined();
    expect(
      nativeQuotaFailure(
        [
          { ...signal, rate_limit_info: { ...signal.rate_limit_info, isUsingOverage: true } },
          assistant,
          result,
        ],
        now,
      ),
    ).toBeUndefined();
  });
  it("ignores subagent errors/results and does not reuse an earlier failed turn", () => {
    expect(
      nativeQuotaFailure([signal, { ...assistant, parent_tool_use_id: "tool-1" }, result], now),
    ).toBeUndefined();
    expect(
      nativeQuotaFailure([signal, assistant, { ...result, parent_tool_use_id: "tool-1" }], now),
    ).toBeUndefined();
    expect(
      nativeQuotaFailure([signal, assistant, result, { type: "user" }, result], now),
    ).toBeUndefined();
  });
});
