import { describe, expect, it } from "vitest";
import { routeOpenRouterMessage } from "./openrouter-gateway";

const model = "deepseek/deepseek-v4.1-flash-1017";
const endpoint = { model, slug: "particle-ai/us/flex" };

describe("OpenRouter routing", () => {
  it("pins the chosen endpoint and overrides caller-supplied routing", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = routeOpenRouterMessage(
      {
        model,
        messages,
        stream: true,
        preset: "untrusted",
        models: ["openrouter/auto"],
        provider: { data_collection: "allow" },
      },
      endpoint,
    );
    expect(result).toEqual({
      model,
      messages,
      stream: true,
      provider: { only: [endpoint.slug], allow_fallbacks: false, data_collection: "deny" },
    });
  });

  it("uses the privacy restriction in automatic mode", () => {
    expect(routeOpenRouterMessage({ model })).toEqual({
      model,
      provider: { data_collection: "deny" },
    });
  });

  it("rejects model aliases that can change routing and endpoints from another model", () => {
    for (const selected of ["openrouter/auto", "sonnet", `${model}@preset/fallback`])
      expect(() => routeOpenRouterMessage({ model: selected })).toThrow(
        "explicit OpenRouter model",
      );
    expect(() => routeOpenRouterMessage({ model: "z-ai/glm-5.3-flash" }, endpoint)).toThrow(
      "belongs to a different model",
    );
  });
});
