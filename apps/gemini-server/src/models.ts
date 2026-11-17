import { spawn } from "node:child_process";
import type { ModelOption } from "@codexnest/protocol";
import type { Config } from "./config";

const MAX_MODELS_STDOUT_BYTES = 256 * 1024;
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_SUFFIX_PATTERN = /^(.+)-(minimal|low|medium|high|xhigh|max)$/i;
const EFFORT_LABEL_SUFFIX_PATTERN = /\s*\((minimal|low|medium|high|xhigh|max)\)\s*$/i;
const EFFORT_FALLBACK_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

type RawModelRow = {
  id: string;
  label: string;
  familyBaseId: string | null;
  effort: string | null;
};

export function modelsArgs(config: Pick<Config, "nativeDir">): string[] {
  return ["--gemini_dir", config.nativeDir, "--app_data_dir", "gemininest", "models"];
}

/**
 * Parses `antigravity models` tabular output into GeminiNest's `ModelOption[]` catalog,
 * grouping multi-effort families (`gemini-4-carbon-{low,medium,high}`) into base model IDs
 * while keeping singletons (`gpt-oss-120b-medium`, `gemini-pro-orchestrator*`, `claude-*`)
 * with `reasoningEfforts: []`.
 */
export function parseGeminiModelsOutput(
  output: string,
  preferredDefaultModelId?: string | null,
): ModelOption[] {
  const clean = output.replace(ANSI_ESCAPE_PATTERN, "");
  const rows: RawModelRow[] = [];
  const seenIds = new Set<string>();

  for (const rawLine of clean.split("\n")) {
    const withoutTrailingCr = rawLine.replace(/\r+$/, "");
    const segment = withoutTrailingCr.split("\r").at(-1)?.trim() ?? "";
    if (!segment) continue;
    const match = /^([a-z0-9][a-z0-9._-]*)(?:\t+|\s{2,})(.+\S)$/i.exec(segment);
    if (!match) continue;
    const id = match[1]!;
    const label = match[2]!.trim();
    if (/^(id|model|name)$/i.test(id)) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const effortMatch = EFFORT_SUFFIX_PATTERN.exec(id);
    rows.push({
      id,
      label,
      familyBaseId: effortMatch ? effortMatch[1]! : null,
      effort: effortMatch ? effortMatch[2]!.toLowerCase() : null,
    });
  }

  if (!rows.length) return [];

  const familyVariants = new Map<string, RawModelRow[]>();
  for (const row of rows) {
    if (!row.familyBaseId || !row.effort) continue;
    let list = familyVariants.get(row.familyBaseId);
    if (!list) {
      list = [];
      familyVariants.set(row.familyBaseId, list);
    }
    if (!list.some((item) => item.effort === row.effort)) {
      list.push(row);
    }
  }

  const emittedFamilies = new Set<string>();
  const models: ModelOption[] = [];

  for (const row of rows) {
    const variants = row.familyBaseId ? familyVariants.get(row.familyBaseId) : undefined;
    if (row.familyBaseId && variants && variants.length >= 2) {
      if (emittedFamilies.has(row.familyBaseId)) continue;
      emittedFamilies.add(row.familyBaseId);

      const first = variants[0]!;
      const defaultEffort = first.effort!;
      const baseDisplayName = first.label.replace(EFFORT_LABEL_SUFFIX_PATTERN, "").trim();
      const sortedVariants = [...variants].sort(
        (a, b) =>
          EFFORT_ORDER.indexOf(a.effort as (typeof EFFORT_ORDER)[number]) -
          EFFORT_ORDER.indexOf(b.effort as (typeof EFFORT_ORDER)[number]),
      );

      models.push({
        id: row.familyBaseId,
        displayName: baseDisplayName || row.familyBaseId,
        description: "",
        isDefault: false,
        reasoningEfforts: sortedVariants.map((variant) => {
          const labelMatch = EFFORT_LABEL_SUFFIX_PATTERN.exec(variant.label);
          const effortValue = variant.effort!;
          return {
            value: effortValue,
            description: labelMatch?.[1] ?? EFFORT_FALLBACK_LABELS[effortValue] ?? effortValue,
            isDefault: effortValue === defaultEffort,
          };
        }),
        serviceTiers: [],
        supportsPersonality: false,
      });
    } else {
      models.push({
        id: row.id,
        displayName: row.label,
        description: "",
        isDefault: false,
        reasoningEfforts: [],
        serviceTiers: [],
        supportsPersonality: false,
      });
    }
  }

  const defaultIndex = preferredDefaultModelId
    ? models.findIndex((item) => item.id === preferredDefaultModelId)
    : -1;
  const chosenIndex = defaultIndex >= 0 ? defaultIndex : 0;
  if (models[chosenIndex]) {
    models[chosenIndex]!.isDefault = true;
  }

  return models;
}

export async function readGeminiModels(
  config: Pick<Config, "agyBin" | "nativeDir">,
  env: NodeJS.ProcessEnv,
  preferredDefaultModelId?: string | null,
  timeoutMs = 20_000,
): Promise<ModelOption[]> {
  return new Promise<ModelOption[]>((resolve, reject) => {
    const child = spawn(config.agyBin, modelsArgs(config), {
      env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("Timed out reading Gemini models")));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_MODELS_STDOUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`Antigravity models exited with code ${code ?? "unknown"}`));
          return;
        }
        const models = parseGeminiModelsOutput(stdout, preferredDefaultModelId);
        if (!models.length) {
          reject(new Error("Antigravity CLI returned an empty model list"));
          return;
        }
        resolve(models);
      });
    });
  });
}
