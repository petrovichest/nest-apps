import { describe, expect, it } from "vitest";
import { modelCatalogOptions } from "./model-catalog";

const catalogModel = (pricing: {
  prompt: string;
  completion: string;
  input_cache_read?: string | null;
  input_cache_write?: string | null;
}) => ({
  id: "deepseek/deepseek-v4.1-flash-1017",
  name: "DeepSeek: Flash",
  created: 1,
  pricing,
  supported_parameters: ["tools"],
});

describe("model catalog pricing", () => {
  it("converts OpenRouter per-token rates, including cache rates, to per-million USD", () => {
    const [model] = modelCatalogOptions([
      catalogModel({
        prompt: "0.000001",
        completion: "0.000002",
        input_cache_read: "0.0000001",
        input_cache_write: "0.00000125",
      }),
    ]);
    expect(model?.openRouter).toMatchObject({ developer: "deepseek" });
    expect(model?.openRouter?.inputPrice).toBeCloseTo(1, 10);
    expect(model?.openRouter?.outputPrice).toBeCloseTo(2, 10);
    expect(model?.openRouter?.cacheReadPrice).toBeCloseTo(0.1, 10);
    expect(model?.openRouter?.cacheWritePrice).toBeCloseTo(1.25, 10);
  });
  it("omits cache rates the catalog does not publish", () => {
    const [model] = modelCatalogOptions([
      catalogModel({
        prompt: "0.000001",
        completion: "0.000002",
        input_cache_read: null,
        input_cache_write: null,
      }),
    ]);
    expect(model?.openRouter).toEqual({
      developer: "deepseek",
      inputPrice: 1,
      outputPrice: 2,
    });
  });
});
