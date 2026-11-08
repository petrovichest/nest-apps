import { spawn } from "node:child_process";
import type { CodexRateLimitWindow, CodexRateLimitsResponse } from "@codexnest/protocol";
import type { Config } from "./config";

const FIVE_HOURS_MINS = 5 * 60;
const SEVEN_DAYS_MINS = 7 * 24 * 60;
const MAX_USAGE_STDOUT_BYTES = 256 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bucketWindow(value: unknown, windowDurationMins: number): CodexRateLimitWindow | null {
  if (!object(value) || value.disabled === true) return null;
  const remaining = value.remaining_fraction;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  const clamped = Math.max(0, Math.min(1, remaining));
  const usedPercent = Math.round((1 - clamped) * 10_000) / 100;
  const reset = typeof value.reset_time === "string" ? Date.parse(value.reset_time) : Number.NaN;
  return {
    usedPercent,
    windowDurationMins,
    resetsAt: Number.isFinite(reset) ? reset : null,
  };
}

/** Maps Antigravity CLI's `-p /usage --output-format json` answer onto the shared sidebar contract. */
export function parseGeminiUsage(value: unknown): CodexRateLimitsResponse {
  if (
    !object(value) ||
    (value.status !== undefined && value.status !== "SUCCESS") ||
    !object(value.command) ||
    value.command.name !== "usage"
  ) {
    throw new Error("Antigravity CLI returned an unexpected usage response");
  }
  const data = value.command.data;
  if (data === undefined || data === null) {
    if (typeof value.response === "string" && /no quota summary/i.test(value.response)) {
      return { primary: null, secondary: null };
    }
    throw new Error("Gemini CLI usage is currently unavailable");
  }
  if (!object(data) || !Array.isArray(data.groups)) {
    throw new Error("Gemini CLI usage is currently unavailable");
  }
  const groups = data.groups.filter(object);
  if (!groups.length) return { primary: null, secondary: null };
  const geminiGroup =
    groups.find((group) => typeof group.name === "string" && /gemini/i.test(group.name)) ??
    groups[0]!;
  const buckets = Array.isArray(geminiGroup.buckets) ? geminiGroup.buckets.filter(object) : [];
  const fiveHour = buckets.find(
    (bucket) =>
      bucket.id === "gemini-5h" ||
      bucket.window === "5h" ||
      (typeof bucket.name === "string" && /five hour|5[- ]hour/i.test(bucket.name)),
  );
  const weekly = buckets.find(
    (bucket) =>
      bucket.id === "gemini-weekly" ||
      bucket.window === "weekly" ||
      (typeof bucket.name === "string" && /weekly/i.test(bucket.name)),
  );
  return {
    primary: bucketWindow(fiveHour, FIVE_HOURS_MINS),
    secondary: bucketWindow(weekly, SEVEN_DAYS_MINS),
  };
}

export function usageArgs(config: Pick<Config, "nativeDir">): string[] {
  return [
    "--gemini_dir",
    config.nativeDir,
    "--app_data_dir",
    "gemininest",
    "-p",
    "/usage",
    "--output-format",
    "json",
  ];
}

export async function readGeminiUsage(
  config: Pick<Config, "agyBin" | "nativeDir">,
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): Promise<CodexRateLimitsResponse> {
  return new Promise<CodexRateLimitsResponse>((resolve, reject) => {
    const child = spawn(config.agyBin, usageArgs(config), {
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
      finish(() => reject(new Error("Timed out reading Gemini usage")));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_USAGE_STDOUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`Antigravity usage exited with code ${code ?? "unknown"}`));
          return;
        }
        const line = stdout
          .trim()
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter((item) => item.startsWith("{"))
          .at(-1);
        if (!line) {
          reject(new Error("Antigravity CLI returned an empty usage response"));
          return;
        }
        try {
          resolve(parseGeminiUsage(JSON.parse(line)));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}
