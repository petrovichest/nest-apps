import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification } from "./codex/generated/index";
import type { Thread, Turn } from "./codex/generated/v2/index";
import { ThreadTitleGenerator } from "./thread-title";

describe("ThreadTitleGenerator", () => {
  it("generates a structured title in an ephemeral read-only thread", async () => {
    const bridge = fakeBridge('{"title":"  Нейросетевые   названия  "}');
    const generator = new ThreadTitleGenerator(bridge as unknown as CodexBridge);

    await expect(
      generator.generate(" Сделай названия сессий через нейронку ", {
        cwd: "/work",
        model: "gpt-test",
        effort: "low",
      }),
    ).resolves.toBe("Нейросетевые названия");

    expect(bridge.request.mock.calls[0]).toEqual([
      "thread/start",
      expect.objectContaining({
        cwd: "/work",
        model: "gpt-test",
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        serviceTier: null,
        baseInstructions: expect.stringContaining("same language"),
      }),
    ]);
    expect(bridge.request.mock.calls[0]?.[1].baseInstructions).toContain("source text");
    expect(bridge.request.mock.calls[0]?.[1].baseInstructions).not.toContain("user message");
    expect(bridge.request.mock.calls[1]).toEqual([
      "turn/start",
      expect.objectContaining({
        threadId: "title-thread",
        model: "gpt-test",
        effort: "low",
        serviceTier: null,
        input: [
          {
            type: "text",
            text: "Сделай названия сессий через нейронку",
            text_elements: [],
          },
        ],
        outputSchema: expect.objectContaining({
          required: ["title"],
          additionalProperties: false,
        }),
      }),
    ]);
    expect(bridge.request).toHaveBeenLastCalledWith("thread/unsubscribe", {
      threadId: "title-thread",
    });
  });

  it("sends the first images after the source text and omits an empty text item", async () => {
    const bridge = fakeBridge('{"title":"Скриншот ошибки"}');
    const generator = new ThreadTitleGenerator(bridge as unknown as CodexBridge);
    const images = [1, 2, 3, 4].map((n) => `data:image/png;base64,${n}`);

    await generator.generate("Почему?", { cwd: "/work", images });
    await generator.generate("  ", { cwd: "/work", images: images.slice(0, 1) });

    const inputs = bridge.request.mock.calls
      .filter(([method]) => method === "turn/start")
      .map(([, params]) => params.input);
    expect(inputs).toEqual([
      [
        { type: "text", text: "Почему?", text_elements: [] },
        { type: "image", url: images[0] },
        { type: "image", url: images[1] },
        { type: "image", url: images[2] },
      ],
      [{ type: "image", url: images[0] }],
    ]);
  });

  it("interrupts and unsubscribes a title turn after a timeout", async () => {
    const bridge = fakeBridge();
    const generator = new ThreadTitleGenerator(bridge as unknown as CodexBridge);

    await expect(generator.generate("Сообщение", { cwd: "/work", timeoutMs: 1 })).rejects.toThrow(
      "timed out",
    );
    expect(bridge.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "title-thread",
      turnId: "title-turn",
    });
    expect(bridge.request).toHaveBeenLastCalledWith("thread/unsubscribe", {
      threadId: "title-thread",
    });
  });
});

function fakeBridge(response?: string): EventEmitter & { request: ReturnType<typeof vi.fn> } {
  const bridge = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
  bridge.request = vi.fn(async (method: string) => {
    if (method === "thread/start") return { thread: titleThread() };
    if (method === "turn/start") {
      if (response !== undefined) {
        queueMicrotask(() => {
          bridge.emit("notification", {
            method: "item/completed",
            params: {
              threadId: "title-thread",
              turnId: "title-turn",
              completedAtMs: 2,
              item: {
                type: "agentMessage",
                id: "answer",
                text: response,
                phase: null,
                memoryCitation: null,
              },
            },
          } satisfies ServerNotification);
          bridge.emit("notification", {
            method: "turn/completed",
            params: { threadId: "title-thread", turn: titleTurn("completed") },
          } satisfies ServerNotification);
        });
      }
      return { turn: titleTurn("inProgress") };
    }
    if (method === "turn/interrupt" || method === "thread/unsubscribe") return {};
    throw new Error(`Unexpected ${method}`);
  });
  return bridge;
}

function titleThread(): Thread {
  return {
    id: "title-thread",
    extra: null,
    sessionId: "title-thread",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: true,
    historyMode: "full",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "notLoaded" },
    path: null,
    cwd: "/work",
    cliVersion: "test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function titleTurn(status: Turn["status"]): Turn {
  return {
    id: "title-turn",
    items: [],
    itemsView: "summary",
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "completed" ? 2 : null,
    durationMs: status === "completed" ? 1_000 : null,
  };
}
