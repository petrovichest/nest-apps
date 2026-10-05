import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeVoiceService,
  MAX_TRANSCRIPTION_BYTES,
  VoiceServiceError,
  type VoiceServiceOptions,
} from "./voice";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function service(options: VoiceServiceOptions = {}): ClaudeVoiceService {
  return new ClaudeVoiceService({
    fetch: async () => Response.json({ text: "исходный текст" }),
    ...options,
  });
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal: string) => {
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  });
}

function fakeSpawn(
  child: FakeChild,
  onSpawn?: (command: string, args: string[], options: Record<string, unknown>) => void,
): typeof spawn {
  return ((command: string, args: string[], options: Record<string, unknown>) => {
    onSpawn?.(command, args, options);
    return child;
  }) as unknown as typeof spawn;
}

describe("Claude local voice", () => {
  it("reports local-only defaults without introducing an OpenAI account or client", async () => {
    const voice = service();
    expect(await voice.readSettings()).toEqual({
      provider: "local",
      localUrl: "http://127.0.0.1:8178/inference",
      language: "ru",
      refineLocal: true,
      refinementModel: "haiku",
    });
    expect(voice.configuration()).toMatchObject({
      providers: ["local"],
      provider: "local",
      openAiApiKeyConfigured: false,
      maxRecordingSeconds: 300,
      maxUploadBytes: 24 * 1024 * 1024,
    });
  });

  it.each(["audio/webm;codecs=opus", "audio/mp4"])(
    "posts %s multipart audio to the existing local endpoint",
    async (contentType) => {
      let body: FormData | undefined;
      let url: string | undefined;
      const voice = service({
        settings: { refineLocal: false },
        fetch: async (input, init) => {
          url = String(input);
          body = init?.body as FormData;
          expect(init?.method).toBe("POST");
          expect(init?.headers).toBeUndefined();
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return Response.json({ text: "  Распознанный текст.  " });
        },
      });
      await expect(
        voice.transcribe(Buffer.from("audio"), contentType, undefined, {
          audioDurationMs: 300_000,
        }),
      ).resolves.toBe("Распознанный текст.");
      expect(url).toBe("http://127.0.0.1:8178/inference");
      expect(body?.get("language")).toBe("ru");
      expect(body?.get("response_format")).toBe("json");
      const file = body?.get("file") as File;
      expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("audio");
      expect(file.name).toBe(
        contentType.startsWith("audio/webm") ? "recording.webm" : "recording.mp4",
      );
      expect(new Request(url!, { method: "POST", body }).headers.get("content-type")).toMatch(
        /^multipart\/form-data; boundary=/,
      );
    },
  );

  it("loads and serializes injectable durable settings, preserving the old value on failed persistence", async () => {
    const saved: unknown[] = [];
    const loadSettings = vi.fn(async () => ({ language: "en", refineLocal: false }));
    const saveSettings = vi.fn(async (settings) => {
      saved.push({ ...settings });
    });
    const voice = service({ loadSettings, saveSettings });
    const updates = [
      voice.updateSettings({ language: "ru" }),
      voice.updateSettings({ refinementModel: "sonnet" }),
    ];
    await Promise.all(updates);
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([
      {
        provider: "local",
        localUrl: "http://127.0.0.1:8178/inference",
        language: "ru",
        refineLocal: false,
        refinementModel: "haiku",
      },
      {
        provider: "local",
        localUrl: "http://127.0.0.1:8178/inference",
        language: "ru",
        refineLocal: false,
        refinementModel: "sonnet",
      },
    ]);
    saveSettings.mockRejectedValueOnce(new Error("disk failed"));
    await expect(voice.updateSettings({ language: "en" })).rejects.toThrow("disk failed");
    expect((await voice.readSettings()).language).toBe("ru");
  });

  it("refines with the requested model and keeps overrides scoped to that recording", async () => {
    const refine = vi.fn(async () => "Исправленный текст.");
    const voice = service({ refine });
    await expect(
      voice.transcribe(Buffer.from("audio"), "audio/webm", undefined, {
        refinementModel: "sonnet",
        language: "en",
      }),
    ).resolves.toBe("Исправленный текст.");
    expect(refine).toHaveBeenCalledWith("исходный текст", { model: "sonnet", signal: undefined });
    expect((await voice.readSettings()).refinementModel).toBe("haiku");
    expect((await voice.readSettings()).language).toBe("ru");
    await voice.transcribe(Buffer.from("audio"), "audio/mp4", undefined, { refineLocal: false });
    expect(refine).toHaveBeenCalledTimes(1);
  });

  it("falls back to the raw transcript on refinement failures, empty output and missing CLI", async () => {
    const onRefinementError = vi.fn();
    const refine = vi.fn(async () => {
      throw new Error("refinement failed");
    });
    const voice = service({ refine, onRefinementError });
    await expect(voice.transcribe(Buffer.from("audio"), "audio/webm")).resolves.toBe(
      "исходный текст",
    );
    expect(onRefinementError).toHaveBeenCalledTimes(1);
    await expect(
      service({ refine: async () => " " }).transcribe(Buffer.from("audio"), "audio/webm"),
    ).resolves.toBe("исходный текст");
    await expect(service().transcribe(Buffer.from("audio"), "audio/webm")).resolves.toBe(
      "исходный текст",
    );
  });

  it("does not truncate long raw transcripts to make refinement fit", async () => {
    const raw = "т".repeat(50_001);
    const refine = vi.fn(async () => "truncated");
    await expect(
      service({ fetch: async () => Response.json({ text: raw }), refine }).transcribe(
        Buffer.from("audio"),
        "audio/webm",
      ),
    ).resolves.toBe(raw);
    expect(refine).not.toHaveBeenCalled();
  });

  it("invokes installed Claude with tool-free, nonpersistent structured output in a neutral cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudenest-refiner-test-"));
    directories.push(directory);
    const child = new FakeChild();
    let input = "";
    child.stdin.on("data", (value) => {
      input += value.toString();
    });
    child.stdin.once("finish", () => {
      child.stdout.end(
        JSON.stringify({
          type: "result",
          is_error: false,
          structured_output: { text: "Исправленный текст." },
        }),
      );
      child.emit("close", 0, null);
    });
    let args: string[] = [];
    const voice = service({
      claudeBin: "/installed/claude",
      configDir: "/normal/claude-config",
      neutralCwd: directory,
      env: { TEST_PROXY: "inherited-test-proxy", CLAUDECODE: "nested" },
      spawnProcess: fakeSpawn(child, (command, arguments_, options) => {
        expect(command).toBe("/installed/claude");
        args = arguments_;
        expect(options.cwd).toBe(directory);
        expect(options.shell).toBe(false);
        const env = options.env as NodeJS.ProcessEnv;
        expect(env.CLAUDE_CONFIG_DIR).toBe("/normal/claude-config");
        expect(env.TEST_PROXY).toBe("inherited-test-proxy");
        expect(env.CLAUDECODE).toBeUndefined();
      }),
    });
    await expect(voice.transcribe(Buffer.from("audio"), "audio/mp4")).resolves.toBe(
      "Исправленный текст.",
    );
    expect(input).toBe("исходный текст");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args).not.toContain(input);
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toMatchObject({
      required: ["text"],
    });
  });

  it("times out and terminates a stalled refiner, returning raw text", async () => {
    const child = new FakeChild();
    const voice = service({
      claudeBin: "/installed/claude",
      spawnProcess: fakeSpawn(child),
      refinementTimeoutMs: 10,
    });
    await expect(voice.transcribe(Buffer.from("audio"), "audio/webm")).resolves.toBe(
      "исходный текст",
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("propagates user cancellation during refinement instead of applying a transcript", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    child.stdin.once("finish", () => controller.abort(new Error("cancelled recording")));
    const voice = service({ claudeBin: "/installed/claude", spawnProcess: fakeSpawn(child) });
    await expect(
      voice.transcribe(Buffer.from("audio"), "audio/mp4", controller.signal),
    ).rejects.toThrow("cancelled recording");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails timed-out or cancelled local requests and does not start refinement", async () => {
    const hanging: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    await expect(
      service({ fetch: hanging, timeoutMs: 10 }).transcribe(Buffer.from("audio"), "audio/webm"),
    ).rejects.toMatchObject({ kind: "timeout" });
    const controller = new AbortController();
    const pending = service({ fetch: hanging }).transcribe(
      Buffer.from("audio"),
      "audio/mp4",
      controller.signal,
    );
    const assertion = expect(pending).rejects.toThrow("stop recording");
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("stop recording"));
    await assertion;
  });

  it.each([
    [422, { error: "no speech" }, "validation"],
    [500, { error: "failure" }, "failed"],
    [200, { text: " " }, "validation"],
    [200, { invalid: "payload" }, "validation"],
  ])("rejects unusable STT responses (%s)", async (status, payload, kind) => {
    await expect(
      service({ fetch: async () => Response.json(payload, { status }) }).transcribe(
        Buffer.from("audio"),
        "audio/webm",
      ),
    ).rejects.toMatchObject({ kind });
  });

  it("rejects invalid recording constraints before inference", async () => {
    const request = vi.fn(async () => Response.json({ text: "must not be called" }));
    const voice = service({ fetch: request });
    await expect(voice.transcribe(Buffer.alloc(0), "audio/webm")).rejects.toBeInstanceOf(
      VoiceServiceError,
    );
    await expect(
      voice.transcribe(Buffer.allocUnsafe(MAX_TRANSCRIPTION_BYTES + 1), "audio/webm"),
    ).rejects.toThrow("24 MiB");
    await expect(voice.transcribe(Buffer.from("audio"), "audio/wav")).rejects.toThrow(
      "WebM or MP4",
    );
    await expect(
      voice.transcribe(Buffer.from("audio"), "audio/mp4", undefined, { audioDurationMs: 300_001 }),
    ).rejects.toThrow("300 seconds");
    expect(request).not.toHaveBeenCalled();
    await expect(
      voice.updateSettings({ localUrl: "http://user:password@localhost" }),
    ).rejects.toThrow("without credentials");
    await expect(voice.updateSettings({ language: "unsupported" })).rejects.toThrow("language");
  });
});
