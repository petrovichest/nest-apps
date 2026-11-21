import { Agent, get } from "node:https";
import type { ModelOption, OpenRouterEndpoint } from "@codexnest/protocol";

const defaultModel = "deepseek/deepseek-v4.1-flash-1017";
const families = new Set([
  "anthropic",
  "deepseek",
  "google",
  "meta-llama",
  "minimax",
  "mistralai",
  "moonshotai",
  "openai",
  "qwen",
  "x-ai",
  "z-ai",
]);

interface CatalogPricing {
  prompt: string;
  completion: string;
  input_cache_read?: string | null;
  input_cache_write?: string | null;
}

interface CatalogModel {
  id: string;
  name: string;
  created: number;
  pricing: CatalogPricing;
  supported_parameters: string[];
}

/** OpenRouter publishes per-token USD rates as decimal strings, or null when unpublished. */
function perMillion(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate * 1_000_000 : undefined;
}

export function modelCatalogOptions(data: CatalogModel[]): ModelOption[] {
  const ordered = data
    .filter(({ id, supported_parameters, pricing }) => {
      const [developer, name] = id.split("/");
      return (
        families.has(developer!) &&
        Boolean(name) &&
        !name!.includes(":") &&
        supported_parameters.includes("tools") &&
        [pricing.prompt, pricing.completion].every(
          (rate) => rate !== "" && Number.isFinite(Number(rate)) && Number(rate) >= 0,
        )
      );
    })
    .sort((a, b) => b.created - a.created);
  const selected = new Set<string>();
  const options = ordered
    .filter(({ id }) => {
      if (id === defaultModel) return true;
      const developer = id.split("/")[0]!;
      const have = [...selected].filter((value) => value.startsWith(developer + "/"));
      if (have.length >= 4 || selected.has(id)) return false;
      selected.add(id);
      return true;
    })
    .map(({ id, name, pricing }) => {
      const cacheReadPrice = perMillion(pricing.input_cache_read),
        cacheWritePrice = perMillion(pricing.input_cache_write);
      return {
        id,
        displayName: name.replace(/^[^:]+: /, ""),
        description: "",
        isDefault: id === defaultModel,
        reasoningEfforts: [],
        serviceTiers: [],
        supportsPersonality: false,
        openRouter: {
          developer: id.split("/")[0]!,
          inputPrice: Number(pricing.prompt) * 1_000_000,
          outputPrice: Number(pricing.completion) * 1_000_000,
          ...(cacheReadPrice !== undefined ? { cacheReadPrice } : {}),
          ...(cacheWritePrice !== undefined ? { cacheWritePrice } : {}),
        },
      };
    });
  if (!options.some(({ isDefault }) => isDefault))
    throw new Error("The configured OpenNest default model is unavailable in the catalog");
  return options.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

async function publicOpenRouterJson(path: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const agent = new Agent({ proxyEnv: env });
  try {
    const payload = await new Promise<string>((resolve, reject) => {
      get(
        `https://openrouter.ai/api/v1${path}`,
        { agent, signal: AbortSignal.timeout(10_000) },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error("OpenRouter catalog is unavailable"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 12 * 1024 * 1024)
              response.destroy(new Error("OpenRouter catalog is too large"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      ).once("error", reject);
    });
    return JSON.parse(payload);
  } finally {
    agent.destroy();
  }
}

export async function loadModelCatalog(env: NodeJS.ProcessEnv): Promise<ModelOption[]> {
  const { data } = (await publicOpenRouterJson("/models?supported_parameters=tools", env)) as {
    data: CatalogModel[];
  };
  return modelCatalogOptions(data);
}

interface EndpointRecord {
  tag: string;
  model_id: string;
  provider_name: string;
  status: number;
  supported_parameters: string[];
  pricing: CatalogModel["pricing"];
  safety_retention?: boolean;
}

export async function loadModelEndpoints(
  model: string,
  env: NodeJS.ProcessEnv,
): Promise<OpenRouterEndpoint[]> {
  const scope = model.split("/").map(encodeURIComponent).join("/");
  const [result, policies] = await Promise.all([
    publicOpenRouterJson(`/models/${scope}/endpoints`, env) as Promise<{
      data: { endpoints: EndpointRecord[] };
    }>,
    (publicOpenRouterJson("/endpoints/zdr", env) as Promise<{ data: EndpointRecord[] }>).catch(
      () => ({ data: [] }),
    ),
  ]);
  const retention = new Map(
    policies.data
      .filter((entry) => entry.model_id === model)
      .map((entry) => [entry.tag, entry.safety_retention]),
  );
  return result.data.endpoints
    .filter(
      ({ status, supported_parameters, pricing }) =>
        status === 0 &&
        supported_parameters.includes("tools") &&
        [pricing.prompt, pricing.completion].every(
          (rate) => rate !== "" && Number.isFinite(Number(rate)) && Number(rate) >= 0,
        ),
    )
    .map((entry) => ({
      slug: entry.tag,
      provider: entry.provider_name,
      inputPrice: Number(entry.pricing.prompt) * 1_000_000,
      outputPrice: Number(entry.pricing.completion) * 1_000_000,
      retention:
        retention.get(entry.tag) === true
          ? "safety"
          : retention.get(entry.tag) === false
            ? "zero"
            : "unknown",
    }));
}
