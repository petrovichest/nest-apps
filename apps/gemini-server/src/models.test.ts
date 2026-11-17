import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelsArgs, parseGeminiModelsOutput, readGeminiModels } from "./models";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const REAL_1_5_9_OUTPUT = [
  "\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-carbon-medium         Gemini 4 Carbon (Medium)\r",
  "gemini-4-carbon-high           Gemini 4 Carbon (High)\r",
  "gemini-4-carbon-low            Gemini 4 Carbon (Low)\r",
  "gemini-4-argon-medium          Gemini 4 Argon (Medium)\r",
  "gemini-4-argon-high            Gemini 4 Argon (High)\r",
  "gemini-4-argon-low             Gemini 4 Argon (Low)\r",
  "gemini-4-hydrogen-high         Gemini 4 Hydrogen (High)\r",
  "gemini-4-hydrogen-xhigh        Gemini 4 Hydrogen (XHigh)\r",
  "gemini-4-hydrogen-medium       Gemini 4 Hydrogen (Medium)\r",
  "gemini-4-hydrogen-low          Gemini 4 Hydrogen (Low)\r",
  "gemini-pro-orchestrator        Orchestrator (Carbon)\r",
  "gemini-pro-orchestrator-argon  Orchestrator (Argon)\r",
  "gemini-3.8-flash-high          Gemini 3.8 Flash (High)\r",
  "gemini-3.8-flash-medium        Gemini 3.8 Flash (Medium)\r",
  "gemini-3.8-flash-low           Gemini 3.8 Flash (Low)\r",
  "claude-sonnet-4-6              Claude Sonnet 4.6 (Thinking)\r",
  "claude-opus-4-6-thinking       Claude Opus 4.6 (Thinking)\r",
  "gpt-oss-120b-medium            GPT-OSS 120B (Medium)\r",
].join("\n");

describe("Gemini models catalog parser", () => {
  it("groups multi-effort families, preserves xhigh, and keeps singletons without reasoningEfforts", () => {
    const models = parseGeminiModelsOutput(REAL_1_5_9_OUTPUT, "gemini-4-argon");
    expect(models.map((item) => item.id)).toEqual([
      "gemini-4-carbon",
      "gemini-4-argon",
      "gemini-4-hydrogen",
      "gemini-pro-orchestrator",
      "gemini-pro-orchestrator-argon",
      "gemini-3.8-flash",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);

    expect(models.find((item) => item.isDefault)?.id).toBe("gemini-4-argon");

    const carbon = models.find((item) => item.id === "gemini-4-carbon")!;
    expect(carbon.displayName).toBe("Gemini 4 Carbon");
    expect(carbon.reasoningEfforts).toEqual([
      { value: "low", description: "Low", isDefault: false },
      { value: "medium", description: "Medium", isDefault: true },
      { value: "high", description: "High", isDefault: false },
    ]);

    const hydrogen = models.find((item) => item.id === "gemini-4-hydrogen")!;
    expect(hydrogen.displayName).toBe("Gemini 4 Hydrogen");
    expect(hydrogen.reasoningEfforts).toEqual([
      { value: "low", description: "Low", isDefault: false },
      { value: "medium", description: "Medium", isDefault: false },
      { value: "high", description: "High", isDefault: true },
      { value: "xhigh", description: "XHigh", isDefault: false },
    ]);

    for (const singletonId of [
      "gemini-pro-orchestrator",
      "gemini-pro-orchestrator-argon",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]) {
      expect(models.find((item) => item.id === singletonId)?.reasoningEfforts).toEqual([]);
    }
  });

  it("builds root CLI models arguments with underscore flags", () => {
    expect(modelsArgs({ nativeDir: "/tmp/gemininest/native" })).toEqual([
      "--gemini_dir",
      "/tmp/gemininest/native",
      "--app_data_dir",
      "gemininest",
      "models",
    ]);
  });

  it("spawns CLI with AGY_CLI_DISABLE_AUTO_UPDATE=true and rejects empty responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "gemininest-models-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "antigravity");
    await writeFile(
      bin,
      `#!${process.execPath}
if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== "true") process.exit(3);
if (!process.argv.includes("--gemini_dir") || !process.argv.includes("models")) process.exit(4);
if (process.env.EMPTY_MODELS === "1") process.exit(0);
process.stdout.write("gemini-4-carbon-high  Gemini 4 Carbon (High)\\ngemini-4-carbon-low   Gemini 4 Carbon (Low)\\n");
`,
      { mode: 0o755 },
    );

    const models = await readGeminiModels({ agyBin: bin, nativeDir: root }, process.env);
    expect(models).toEqual([
      {
        id: "gemini-4-carbon",
        displayName: "Gemini 4 Carbon",
        description: "",
        isDefault: true,
        reasoningEfforts: [
          { value: "low", description: "Low", isDefault: false },
          { value: "high", description: "High", isDefault: true },
        ],
        serviceTiers: [],
        supportsPersonality: false,
      },
    ]);

    await expect(
      readGeminiModels({ agyBin: bin, nativeDir: root }, { ...process.env, EMPTY_MODELS: "1" }),
    ).rejects.toThrow("empty model list");
  });
});
