import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame } from "@codexnest/protocol";
import { describe, expect, it, vi } from "vitest";
import { paths } from "./config";
import { Engine } from "./engine";
import { parseGeminiUsage, usageArgs } from "./rate-limits";

describe("Gemini usage limits", () => {
  it("maps the Gemini Models five-hour and weekly buckets onto the sidebar limits", () => {
    expect(
      parseGeminiUsage({
        conversation_id: "",
        status: "SUCCESS",
        response:
          "Gemini Models\tWeekly Limit Remaining\t82%\t2026-11-14T23:24:41Z\n" +
          "Gemini Models\tFive Hour Limit Remaining\t80%\t2026-11-08T14:24:41Z\n",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini-weekly",
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: 0.8208354115486145,
                    reset_time: "2026-11-14T23:24:41Z",
                  },
                  {
                    id: "gemini-5h",
                    name: "Five Hour Limit Remaining",
                    window: "5h",
                    remaining_fraction: 0.7990390062332153,
                    reset_time: "2026-11-08T14:24:41Z",
                  },
                ],
              },
              {
                name: "Claude and GPT models",
                buckets: [
                  {
                    id: "3p-weekly",
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: 1,
                    reset_time: "2026-11-15T12:30:39Z",
                  },
                  {
                    id: "3p-5h",
                    name: "Five Hour Limit Remaining",
                    window: "5h",
                    remaining_fraction: 1,
                    reset_time: "2026-11-08T17:30:39Z",
                  },
                ],
              },
            ],
          },
        },
      }),
    ).toEqual({
      primary: {
        usedPercent: 20.1,
        windowDurationMins: 300,
        resetsAt: Date.parse("2026-11-08T14:24:41Z"),
      },
      secondary: {
        usedPercent: 17.92,
        windowDurationMins: 10_080,
        resetsAt: Date.parse("2026-11-14T23:24:41Z"),
      },
    });
  });

  it("reports no windows when quota summary is absent or buckets are disabled", () => {
    expect(
      parseGeminiUsage({
        status: "SUCCESS",
        response: "no quota summary is available for this account\n",
        command: { name: "usage" },
      }),
    ).toEqual({ primary: null, secondary: null });
    expect(
      parseGeminiUsage({
        status: "SUCCESS",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  { id: "gemini-5h", window: "5h", remaining_fraction: 0.5, disabled: true },
                  { id: "gemini-weekly", window: "weekly", remaining_amount: 100 },
                ],
              },
            ],
          },
        },
      }),
    ).toEqual({ primary: null, secondary: null });
  });

  it("rejects unexpected or unavailable CLI usage responses", () => {
    expect(() => parseGeminiUsage({})).toThrow("unexpected usage response");
    expect(() => parseGeminiUsage(null)).toThrow("unexpected usage response");
    expect(() =>
      parseGeminiUsage({
        status: "ERROR",
        command: { name: "usage", data: { groups: [] } },
      }),
    ).toThrow("unexpected usage response");
    expect(() =>
      parseGeminiUsage({
        status: "SUCCESS",
        command: { name: "usage", data: null },
      }),
    ).toThrow("usage is currently unavailable");
  });

  it("builds print-mode usage CLI arguments with the GeminiNest state directory", () => {
    expect(usageArgs({ nativeDir: "/var/lib/gemininest/native" })).toEqual([
      "--gemini_dir",
      "/var/lib/gemininest/native",
      "--app_data_dir",
      "gemininest",
      "-p",
      "/usage",
      "--output-format",
      "json",
    ]);
  });

  it("shares rate limits across snapshots and events, deduplicates refreshes, and retains prior limits on error", async () => {
    const root = await mkdtemp(join(tmpdir(), "gemininest-limits-"));
    try {
      const limits = {
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
      };
      let finish!: (value: typeof limits) => void;
      const readRateLimits = vi
        .fn<() => Promise<typeof limits>>()
        .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
        .mockImplementationOnce(async () => {
          throw new Error("Gemini CLI usage is currently unavailable");
        });
      const config = {
        ...paths({
          GEMININEST_CONFIG_DIR: root,
          GEMININEST_STATE_DIR: join(root, "state"),
          GEMININEST_RUNTIME_DIR: root,
          GEMININEST_AGY_BIN: "/bin/true",
        }),
        token: "t".repeat(48),
      };
      const engine = new Engine(config, undefined, { readRateLimits });
      await engine.initialize();
      const frames: ServerFrame[] = [];
      engine.on("frame", (frame: ServerFrame) => frames.push(frame));

      const first = engine.refreshRateLimits();
      expect(engine.refreshRateLimits()).toBe(first);
      expect(engine.snapshot().codexRateLimits).toMatchObject({ limits: null, refreshing: true });
      finish(limits);
      await expect(first).resolves.toEqual(limits);
      expect(readRateLimits).toHaveBeenCalledTimes(1);
      expect(engine.snapshot().codexRateLimits).toMatchObject({
        limits,
        refreshing: false,
        refreshError: false,
      });

      await expect(engine.refreshRateLimits()).rejects.toThrow("usage is currently unavailable");
      expect(engine.snapshot().codexRateLimits).toMatchObject({
        limits,
        refreshing: false,
        refreshError: true,
      });
      expect(
        frames.map((frame) =>
          frame.type === "event" && frame.event.type === "codexRateLimits.changed"
            ? [frame.event.codexRateLimits.refreshing, frame.event.codexRateLimits.refreshError]
            : null,
        ),
      ).toEqual([
        [true, false],
        [false, false],
        [true, false],
        [false, true],
      ]);
      await engine.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
