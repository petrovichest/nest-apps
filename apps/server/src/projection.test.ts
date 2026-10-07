import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { asyncQuestionReplyMessageId } from "@codexnest/protocol";
import type {
  ActivityItem,
  AttentionRequest,
  ServerEvent,
  ThreadGoal,
  TurnView,
} from "@codexnest/protocol";

import { AttentionManager } from "./attention";
import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification, ServerRequest } from "./codex/generated/index";
import { RpcError, type JsonlTransport } from "./codex/transport";
import type { Thread, ThreadItem } from "./codex/generated/v2/index";
import { AppProjection, diffStats } from "./projection";
import { StateStore } from "./state/store";

class FakeBridge extends EventEmitter {
  state = "ready" as const;
  constructor(
    private readonly active = false,
    private readonly activeGoal = false,
    private readonly resumedUpdatedAt = 5,
    private readonly serviceTiers: string[] = [],
  ) {
    super();
  }
  request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/list") {
      if (params.archived) return { data: [], nextCursor: null, backwardsCursor: null };
      if (!params.cursor)
        return {
          data: [
            thread(
              "one",
              "/work",
              5,
              this.active ? { type: "active", activeFlags: [] } : { type: "idle" },
            ),
          ],
          nextCursor: "next",
          backwardsCursor: null,
        };
      return { data: [thread("two", "/work/nested", 4)], nextCursor: null, backwardsCursor: null };
    }
    if (method === "thread/resume") return { thread: liveThread(this.resumedUpdatedAt) };
    if (method === "thread/read") return { thread: liveThread() };
    if (method === "thread/delete") return {};
    if (method === "thread/name/set") return {};
    if (method === "thread/goal/get") {
      return { goal: this.activeGoal ? goalNotification("active").params.goal : null };
    }
    if (method === "model/list") {
      return {
        data: [
          {
            id: "gpt",
            model: "gpt",
            displayName: "GPT",
            description: "",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
            defaultReasoningEffort: "high",
            inputModalities: ["text"],
            supportsPersonality: true,
            additionalSpeedTiers: [],
            serviceTiers: this.serviceTiers.map((id) => ({ id, name: id, description: "" })),
            defaultServiceTier: null,
            isDefault: true,
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/turns/list" && this.active) {
      return {
        data: liveThread().turns,
        nextCursor: null,
        backwardsCursor: null,
      };
    }
    if (method === "thread/turns/list")
      return {
        data: [
          {
            id: "last",
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      };
    throw new Error(`Unexpected ${method}`);
  });
}

const directories: string[] = [];
const TURN_REPLACEMENT_SETTLE_MS = 75;
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("Fast settings", () => {
  it.each([
    { tiers: ["priority"], expected: "fast" },
    { tiers: ["fast"], expected: "fast" },
    { tiers: [], expected: undefined },
  ])("copies defaults only for supported models: $tiers", async ({ tiers, expected }) => {
    const { bridge, projection, store } = await fastSettingsHarness(tiers);
    await projection.sync();
    bridge.request.mockClear();
    await projection.setSettings("one", { collaborationMode: "default" });
    await projection.setSettings("two", { collaborationMode: "plan", serviceTier: "fast" });

    await projection.setTaskDefaults({ serviceTier: "priority" });
    expect(projection.snapshot().taskDefaults).toEqual({ serviceTier: "fast" });
    expect(projection.newSessionSettings.serviceTier).toBe(expected);
    expect(projection.summary("one")?.settings.serviceTier).toBeUndefined();
    expect(projection.summary("two")?.settings.serviceTier).toBe("fast");

    await projection.setTaskDefaults({});
    expect(projection.newSessionSettings.serviceTier).toBeUndefined();
    expect(projection.summary("two")?.settings.serviceTier).toBe("fast");
    expect(store.view().taskDefaults).toBeUndefined();
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it("normalizes session choices, publishes changes and restores them after reload", async () => {
    const { bridge, projection, store } = await fastSettingsHarness(["priority"]);
    projection.upsertThread(thread("one", "/work", 5));
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => events.push(event));

    const enabled = await projection.setSettings("one", {
      collaborationMode: "plan",
      serviceTier: "priority",
    });
    expect(enabled.settings).toEqual({ collaborationMode: "plan", serviceTier: "fast" });
    expect(events).toContainEqual({ type: "thread.upserted", thread: enabled });
    await store.flushed();
    const reloaded = new StateStore(store.path);
    await reloaded.load();
    const restored = new AppProjection(
      bridge as unknown as CodexBridge,
      reloaded,
      new AttentionManager(),
    );
    restored.upsertThread(thread("one", "/work", 5));
    expect(restored.summary("one")?.settings.serviceTier).toBe("fast");
    await restored.setSettings("one", {
      collaborationMode: "plan",
      serviceTier: "legacy-unknown",
    });
    expect(restored.summary("one")?.settings.serviceTier).toBeUndefined();
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it.each([
    { tiers: ["fast", "priority"], savedTier: "fast" },
    { tiers: ["fast"], savedTier: "priority" },
    { tiers: [], savedTier: "fast" },
    { tiers: ["priority"], savedTier: undefined },
  ])(
    "rejoins active turns without overwriting saved $savedTier or runtime config",
    async ({ tiers, savedTier }) => {
      const { bridge, projection, store } = await fastSettingsHarness(tiers, true);
      await store.update((state) => {
        state.taskDefaults = { serviceTier: "fast" };
        state.threadMeta.one = {
          pinned: false,
          lastReadUpdatedAt: 0,
          settings: {
            collaborationMode: "default",
            ...(savedTier ? { serviceTier: savedTier } : {}),
          },
        };
      });
      const resumeConfig = vi.fn(() => ({ config: { example: true } }));
      projection.setThreadResumeConfigProvider(resumeConfig);

      await projection.sync();

      expect(bridge.request).toHaveBeenCalledWith("thread/resume", { threadId: "one" }, 30_000);
      expect(bridge.request.mock.calls.filter(([method]) => method === "model/list")).toHaveLength(
        1,
      );
      expect(resumeConfig).not.toHaveBeenCalled();
      expect(projection.summary("one")?.settings.serviceTier).toBe(savedTier ? "fast" : undefined);
    },
  );

  it.each(
    [
      { resolvedServiceTier: "fast", resolvedModel: "gpt", expected: "priority" },
      { resolvedServiceTier: null, resolvedModel: "gpt", expected: null },
      { resolvedServiceTier: "fast", resolvedModel: "unavailable", expected: null },
    ].flatMap((testCase) => [false, true].map((active) => ({ ...testCase, active }))),
  )(
    "rejoins managed tasks with saved $resolvedServiceTier on $resolvedModel (active=$active)",
    async ({ resolvedServiceTier, resolvedModel, expected, active }) => {
      const { bridge, projection, store } = await fastSettingsHarness(["priority"], active);
      await store.update((state) => {
        state.threadMeta.two = {
          pinned: false,
          lastReadUpdatedAt: 0,
          settings: { collaborationMode: "team", serviceTier: "fast" },
          managedTeamToolsAvailable: true,
          teamOrchestration: {
            tasks: {
              task: {
                id: "task",
                childThreadId: "one",
                title: "Task",
                prompt: "Finish task",
                status: "running",
                resolvedModel,
                resolvedServiceTier,
                createdAt: 1,
                lastActivityAt: 1,
              },
            },
          },
        };
        state.threadMeta.one = {
          pinned: false,
          lastReadUpdatedAt: 0,
          managedParent: { parentThreadId: "two", taskId: "task" },
        };
      });
      if (!active) {
        const original = bridge.request.getMockImplementation()!;
        bridge.request.mockImplementation(async (method, params) => {
          if (method === "thread/list")
            return {
              data: params.archived ? [] : [thread("one", "/work", 5, { type: "notLoaded" })],
              nextCursor: null,
              backwardsCursor: null,
            };
          if (method === "thread/loaded/list") return { data: ["one"], nextCursor: null };
          return original(method, params);
        });
      }
      const resumeConfig = vi.fn(() => ({ config: { agents: { enabled: false } } }));
      projection.setThreadResumeConfigProvider(resumeConfig);

      await projection.sync();

      expect(bridge.request).toHaveBeenCalledWith(
        "thread/resume",
        active
          ? { threadId: "one" }
          : { threadId: "one", config: { agents: { enabled: false } }, serviceTier: expected },
        30_000,
      );
      expect(resumeConfig).toHaveBeenCalledTimes(active ? 0 : 1);
    },
  );

  it.each([
    { tiers: ["fast", "priority"], savedTier: "fast", expected: "priority" },
    { tiers: ["fast"], savedTier: "priority", expected: "fast" },
    { tiers: [], savedTier: "fast", expected: null },
    { tiers: ["priority"], savedTier: undefined, expected: null },
  ])(
    "restores idle loaded sessions using saved $savedTier and advertised $tiers as $expected",
    async ({ tiers, savedTier, expected }) => {
      const { bridge, projection, store } = await fastSettingsHarness(tiers);
      await store.update((state) => {
        state.threadMeta.one = {
          pinned: false,
          lastReadUpdatedAt: 0,
          settings: {
            collaborationMode: "default",
            ...(savedTier ? { serviceTier: savedTier } : {}),
          },
        };
      });
      const original = bridge.request.getMockImplementation()!;
      bridge.request.mockImplementation(async (method, params) => {
        if (method === "thread/list")
          return {
            data: params.archived ? [] : [thread("one", "/work", 5, { type: "notLoaded" })],
            nextCursor: null,
            backwardsCursor: null,
          };
        if (method === "thread/loaded/list") return { data: ["one"], nextCursor: null };
        return original(method, params);
      });
      projection.setThreadResumeConfigProvider(() => ({ config: { example: true } }));

      await projection.sync();

      expect(bridge.request).toHaveBeenCalledWith(
        "thread/resume",
        { threadId: "one", config: { example: true }, serviceTier: expected },
        30_000,
      );
    },
  );

  it("rejoins an acknowledged turn without changing runtime when its start notification was missed", async () => {
    const { bridge, projection, store } = await fastSettingsHarness(["priority"]);
    await projection.sync();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        settings: { collaborationMode: "default", serviceTier: "fast" },
      };
    });
    projection.setThreadResumeConfigProvider(() => ({ config: { example: true } }));
    bridge.emit("state", "unavailable");
    bridge.emit("state", "ready");
    bridge.request.mockClear();

    await projection.restoreDeliveredTurn("one", liveThread().turns[0]!);

    expect(bridge.request).toHaveBeenCalledExactlyOnceWith(
      "thread/resume",
      { threadId: "one" },
      30_000,
    );
    expect(projection.summary("one")).toMatchObject({
      currentTurnId: "live",
      state: "running",
      settings: { serviceTier: "fast" },
    });
    await projection.readThread("one");
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      1,
    );
  });
});

describe("session result viewing", () => {
  const result: Thread["turns"][number] = {
    id: "result",
    items: [],
    itemsView: "notLoaded",
    status: "completed",
    error: null,
    startedAt: 9,
    completedAt: 10,
    durationMs: 1_000,
  };

  it.each([
    { viewedAt: 5_000, status: "idle" },
    { viewedAt: 10_000, status: "idle" },
    { viewedAt: 5_000, status: "notLoaded" },
    { viewedAt: 10_000, status: "notLoaded" },
  ] as const)(
    "backfills legacy $status results without changing a saved viewing mark of $viewedAt",
    async ({ viewedAt, status }) => {
      const { store, bridge, projection } = await searchHarness();
      await store.update((state) => {
        state.threadMeta.one = {
          pinned: false,
          lastReadUpdatedAt: 0,
          lastViewedUpdatedAt: viewedAt,
          lastOutcome: "completed",
          outcomeUpdatedAt: 20_000,
          awaitingPlanResponse: false,
        };
      });
      const request = bridge.request.getMockImplementation()!;
      bridge.request.mockImplementation(async (method, params) => {
        if (method === "thread/list") {
          return {
            data: params.archived ? [] : [thread("one", "/work", 20, { type: status })],
            nextCursor: null,
            backwardsCursor: null,
          };
        }
        if (method === "thread/loaded/list") return { data: [], nextCursor: null };
        if (method === "thread/turns/list") {
          return { data: [result], nextCursor: null, backwardsCursor: null };
        }
        return request(method, params);
      });

      await projection.sync();
      expect(projection.summary("one")).toMatchObject({
        state: "completed",
        unread: true,
        unseen: viewedAt < 10_000,
        updatedAt: 20_000,
      });
      expect(store.view().threadMeta.one).toMatchObject({
        lastReadUpdatedAt: 0,
        lastViewedUpdatedAt: viewedAt,
        lastResult: { turnId: "result", completedAt: 10_000 },
      });
      await projection.sync();
      expect(
        bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
      ).toHaveLength(1);
      bridge.emit("state", "unavailable");
    },
  );

  it("persists legacy result recovery for a large session list in one batch", async () => {
    const { store, bridge, projection } = await searchHarness();
    let activeReads = 0;
    let peakReads = 0;
    let resultReads = 0;
    const threads = Array.from({ length: 1_110 }, (_, index) =>
      thread(`legacy-${index}`, "/work", 20, { type: "notLoaded" }),
    );
    await store.update((state) => {
      for (const item of threads) {
        state.threadMeta[item.id] = {
          pinned: false,
          lastReadUpdatedAt: 0,
          lastViewedUpdatedAt: 10_000,
          lastOutcome: "completed",
          outcomeUpdatedAt: 20_000,
          awaitingPlanResponse: false,
        };
      }
    });
    const request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, params) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : threads,
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        resultReads += 1;
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeReads -= 1;
        return { data: [result], nextCursor: null, backwardsCursor: null };
      }
      return request(method, params);
    });
    const update = vi.spyOn(store, "update");

    await projection.sync();

    // One snapshot write and one result write, independent of session count.
    expect(update).toHaveBeenCalledTimes(2);
    expect(resultReads).toBe(threads.length);
    expect(peakReads).toBe(4);
    expect(projection.snapshot().threads).toHaveLength(threads.length);
    expect(projection.snapshot().threads.every((item) => item.unread && !item.unseen)).toBe(true);
    bridge.emit("state", "unavailable");
    const reloaded = new StateStore(store.path);
    await reloaded.load();
    for (const item of threads) {
      expect(reloaded.view().threadMeta[item.id]).toMatchObject({
        lastReadUpdatedAt: 0,
        lastViewedUpdatedAt: 10_000,
        lastResult: { turnId: result.id, completedAt: 10_000 },
      });
    }
  });

  it("does not overwrite a live result that arrives while legacy results are collected", async () => {
    const { store, bridge, projection } = await searchHarness();
    await store.update((state) => {
      for (const id of ["one", "two"]) {
        state.threadMeta[id] = {
          pinned: false,
          lastReadUpdatedAt: 0,
          lastViewedUpdatedAt: 10_000,
          lastOutcome: "completed",
          outcomeUpdatedAt: 20_000,
          awaitingPlanResponse: false,
        };
      }
    });
    const next = { ...result, id: "next", completedAt: 30 };
    const request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, params) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : [thread("one", "/work", 20), thread("two", "/work", 20)],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        if (params.threadId === "two") {
          await new Promise<void>((resolve) => setImmediate(resolve));
          await projection.setCurrentTurn("one", next.id);
          bridge.emit("notification", {
            method: "turn/completed",
            params: { threadId: "one", turn: next },
          } satisfies ServerNotification);
          await vi.waitFor(() =>
            expect(store.view().threadMeta.one?.lastResult?.turnId).toBe(next.id),
          );
        }
        return { data: [result], nextCursor: null, backwardsCursor: null };
      }
      return request(method, params);
    });

    const clock = vi.spyOn(Date, "now").mockReturnValue(20_000);
    try {
      await projection.sync();
    } finally {
      clock.mockRestore();
    }

    expect(store.view().threadMeta.one?.lastResult).toEqual({
      turnId: next.id,
      completedAt: 30_000,
    });
    expect(projection.summary("one")).toMatchObject({ unread: true, unseen: true });
    expect(projection.summary("two")).toMatchObject({ unread: true, unseen: false });
    bridge.emit("state", "unavailable");
  });

  it("keeps viewed results green across metadata updates, reconnects and reloads until Finish", async () => {
    const { store, bridge, projection } = await searchHarness();
    let updatedAt = 10;
    const request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, params) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : [thread("one", "/work", updatedAt)],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        return { data: [result], nextCursor: null, backwardsCursor: null };
      }
      return request(method, params);
    });
    await store.update((state) => {
      state.threadMeta.one = { pinned: false, lastReadUpdatedAt: 0 };
    });
    await projection.sync();
    expect(projection.summary("one")).toMatchObject({ unread: true, unseen: true });
    await projection.markViewed("one", 10_000);
    expect(projection.summary("one")).toMatchObject({ unread: true, unseen: false });

    updatedAt = 20;
    projection.upsertThread(thread("one", "/work", updatedAt));
    expect(projection.summary("one")).toMatchObject({ unread: true, unseen: false });
    bridge.emit("state", "unavailable");
    bridge.emit("state", "ready");
    await projection.sync();
    expect(projection.summary("one")).toMatchObject({ unread: true, unseen: false });
    await store.flushed();

    const reloaded = new StateStore(store.path);
    await reloaded.load();
    const restored = new AppProjection(
      bridge as unknown as CodexBridge,
      reloaded,
      new AttentionManager(),
    );
    expect(restored.summary("one")).toMatchObject({
      state: "completed",
      unread: true,
      unseen: false,
      updatedAt: 20_000,
    });
    await restored.markRead("one", 20_000);
    expect(restored.summary("one")).toMatchObject({ unread: false, unseen: false });
    bridge.emit("state", "unavailable");
  });

  it("announces a new result despite a late viewed mark and ignores an older completion replay", async () => {
    const { store, bridge, projection } = await searchHarness();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastViewedUpdatedAt: 10_000,
        lastOutcome: "completed",
        outcomeUpdatedAt: 20_000,
        lastResult: { turnId: result.id, completedAt: 10_000 },
      };
    });
    projection.upsertThread(thread("one", "/work", 20, { type: "idle" }, [result]));
    const next = { ...result, id: "next", startedAt: 25, completedAt: 30 };
    const clock = vi.spyOn(Date, "now").mockReturnValue(30_000);
    try {
      await projection.setCurrentTurn("one", next.id);
      bridge.emit("notification", {
        method: "turn/completed",
        params: { threadId: "one", turn: next },
      } satisfies ServerNotification);
      await vi.waitFor(() => expect(store.view().threadMeta.one?.lastResult?.turnId).toBe("next"));
      await projection.markViewed("one", 20_000);
      expect(projection.summary("one")).toMatchObject({ unread: true, unseen: true });

      bridge.emit("notification", {
        method: "turn/completed",
        params: { threadId: "one", turn: result },
      } satisfies ServerNotification);
      bridge.emit("notification", {
        method: "turn/completed",
        params: { threadId: "one", turn: { ...result, completedAt: null } },
      } satisfies ServerNotification);
      await store.flushed();
      expect(store.view().threadMeta.one?.lastResult).toEqual({
        turnId: "next",
        completedAt: 30_000,
      });
      expect(projection.summary("one")).toMatchObject({ unread: true, unseen: true });
      await projection.markViewed("one", 30_000);
      expect(projection.summary("one")).toMatchObject({ unread: true, unseen: false });
      expect(bridge.request).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps a viewed completion without a source timestamp stable when replayed", async () => {
    const { store, bridge, projection } = await searchHarness();
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event: ServerEvent) => events.push(event));
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      projection.upsertThread(thread("one", "/work", 9));
      const notification = {
        method: "turn/completed",
        params: { threadId: "one", turn: { ...result, completedAt: null } },
      } satisfies ServerNotification;
      bridge.emit("notification", notification);
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === "turn.replaced")).toHaveLength(1),
      );
      await projection.markViewed("one", 10_000);
      expect(projection.summary("one")).toMatchObject({ unread: true, unseen: false });

      clock.mockReturnValue(20_000);
      bridge.emit("notification", notification);
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === "turn.replaced")).toHaveLength(2),
      );
      expect(store.view().threadMeta.one?.lastResult).toEqual({
        turnId: result.id,
        completedAt: 10_000,
      });
      expect(projection.summary("one")).toMatchObject({
        unread: true,
        unseen: false,
        updatedAt: 10_000,
      });
      await projection.markRead("one", 10_000);
      clock.mockReturnValue(30_000);
      bridge.emit("notification", notification);
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === "turn.replaced")).toHaveLength(3),
      );
      expect(projection.summary("one")).toMatchObject({ unread: false, unseen: false });
    } finally {
      clock.mockRestore();
    }
  });
});

describe("automatic session finishing", () => {
  const now = Date.UTC(2026, 8, 29);
  const threeDays = 72 * 60 * 60 * 1_000;

  it("finishes only old sessions beyond the newest fifteen, including pinned sessions and forks across projects", async () => {
    const { store, bridge, projection, threads } = await autoFinishHarness(now);
    await store.update((state) => {
      state.threadMeta[threads[0]!.id]!.pinned = true;
      state.threadMeta[threads[15]!.id]!.pinned = true;
    });
    projection.upsertThread({ ...threads[15]!, forkedFromId: threads[0]!.id });
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event: ServerEvent) => events.push(event));

    await expect(projection.finishInactiveSessions(now)).resolves.toBe(1);

    expect(threads.slice(0, 15).every((item) => projection.summary(item.id)?.unread)).toBe(true);
    expect(projection.summary(threads[15]!.id)).toMatchObject({
      state: "completed",
      unread: false,
      pinned: true,
      archived: false,
      updatedAt: threads[15]!.updatedAt * 1_000,
      relation: { kind: "session", forkedFromId: threads[0]!.id },
    });
    expect(projection.threadCount).toBe(16);
    expect(events).toEqual([
      { type: "thread.upserted", thread: projection.summary(threads[15]!.id) },
    ]);
    expect(bridge.request).not.toHaveBeenCalled();
    await expect(projection.finishInactiveSessions(now)).resolves.toBe(0);

    const restoredStore = new StateStore(store.path);
    await restoredStore.load();
    const restored = new AppProjection(
      bridge as unknown as CodexBridge,
      restoredStore,
      new AttentionManager(),
    );
    expect(restored.summary(threads[15]!.id)).toMatchObject({ unread: false, pinned: true });
    expect(restored.summary(threads[8]!.id)?.unread).toBe(true);

    projection.upsertThread({ ...threads[15]!, updatedAt: now / 1_000 });
    expect(projection.summary(threads[15]!.id)).toMatchObject({ unread: true, pinned: true });
    await store.flushed();
  });

  it.each([9, 15, 20])(
    "keeps %i old or recent sessions when either condition is unmet",
    async (count) => {
      const updatedAt = now - (count === 20 ? 60_000 : threeDays + 60_000);
      const { projection, bridge } = await autoFinishHarness(now, Array(count).fill(updatedAt));

      await expect(projection.finishInactiveSessions(now)).resolves.toBe(0);
      expect(projection.snapshot().threads.every((item) => item.unread)).toBe(true);
      expect(bridge.request).not.toHaveBeenCalled();
    },
  );

  it("uses a strict 72-hour boundary and stable ordering for equal activity times", async () => {
    const { projection, threads } = await autoFinishHarness(now, Array(17).fill(now - threeDays));
    await expect(projection.finishInactiveSessions(now)).resolves.toBe(0);
    await expect(projection.finishInactiveSessions(now + 1)).resolves.toBe(2);
    expect(threads.slice(0, 15).every((item) => projection.summary(item.id)?.unread)).toBe(true);
    expect(threads.slice(15).every((item) => !projection.summary(item.id)?.unread)).toBe(true);
  });

  it("ignores viewing but respects new messages and agent activity", async () => {
    const { projection, bridge, threads } = await autoFinishHarness(
      now,
      Array.from({ length: 18 }, (_, index) => now - threeDays - (index + 1) * 1_000),
    );
    await projection.markViewed(threads[15]!.id, threads[15]!.updatedAt * 1_000);
    projection.publishQueue(threads[16]!.id, []);
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: threads[17]!.id,
        turnId: "turn",
        item: { type: "agentMessage", id: "answer", text: "Fresh answer", phase: null },
        completedAtMs: now,
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary(threads[17]!.id)?.updatedAt).toBe(now));

    await expect(projection.finishInactiveSessions(now)).resolves.toBe(3);
    expect(projection.summary(threads[15]!.id)).toMatchObject({ unread: false, unseen: false });
    expect(projection.summary(threads[16]!.id)?.unread).toBe(true);
    expect(projection.summary(threads[17]!.id)?.unread).toBe(true);
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it.each([
    "read",
    "archived",
    "running",
    "active status",
    "queued",
    "plan",
    "failed",
    "interrupted",
    "idle",
    "subagent",
    "managed child",
    "hidden",
    "dismissed",
    "ephemeral",
  ])("leaves %s sessions alone", async (kind) => {
    const { projection, store, threads } = await autoFinishHarness(now);
    const candidate = threads[15]!;
    await store.update((state) => {
      const meta = state.threadMeta[candidate.id]!;
      if (kind === "read") meta.lastReadUpdatedAt = candidate.updatedAt * 1_000;
      if (kind === "plan") meta.awaitingPlanResponse = true;
      if (kind === "failed" || kind === "interrupted") meta.lastOutcome = kind;
      if (kind === "idle") delete meta.lastOutcome;
      if (kind === "managed child")
        meta.managedParent = { parentThreadId: "parent", taskId: "task" };
      if (kind === "dismissed") state.dismissedProjectPaths = ["/dismissed"];
      if (kind === "queued")
        state.messageQueues = {
          [candidate.id]: [
            { id: "queued", threadId: candidate.id, text: "Next", createdAt: 1, status: "queued" },
          ],
        };
    });
    projection.upsertThread(
      {
        ...candidate,
        ...(kind === "subagent" ? { parentThreadId: "parent" } : {}),
        ...(kind === "hidden" ? { threadSource: "codexnest-fork-temp:operation" } : {}),
        ...(kind === "dismissed" ? { cwd: "/dismissed" } : {}),
        ...(kind === "ephemeral" ? { ephemeral: true } : {}),
        ...(kind === "active status"
          ? { status: { type: "active", activeFlags: [] } as const }
          : {}),
      },
      kind === "archived",
    );
    if (kind === "running") await projection.setCurrentTurn(candidate.id, "live");
    const before = store.view().threadMeta[candidate.id]!.lastReadUpdatedAt;

    await expect(projection.finishInactiveSessions(now)).resolves.toBe(0);
    expect(store.view().threadMeta[candidate.id]!.lastReadUpdatedAt).toBe(before);
    expect(projection.threadCount).toBe(16);
  });

  it("does not let archived, read or child sessions consume the fifteen protected places", async () => {
    const { projection, store, threads } = await autoFinishHarness(
      now,
      Array(18).fill(now - threeDays - 1_000),
    );
    await projection.markRead(threads[0]!.id, threads[0]!.updatedAt * 1_000);
    await projection.setArchived(threads[1]!.id, true);
    projection.upsertThread({ ...threads[2]!, parentThreadId: "parent" });
    await store.flushed();
    await expect(projection.finishInactiveSessions(now)).resolves.toBe(0);
    expect(projection.summary(threads[17]!.id)?.unread).toBe(true);
  });

  it("rechecks activity and the count after queued writes", async () => {
    const { projection, store, threads } = await autoFinishHarness(now);
    const newest = threads[0]!;
    const oldest = threads[15]!;
    let release!: () => void;
    const pending = store.update(async (state) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      state.threadMeta[newest.id]!.lastReadUpdatedAt = newest.updatedAt * 1_000;
    });
    await Promise.resolve();
    const finishing = projection.finishInactiveSessions(now);
    projection.upsertThread({ ...oldest, updatedAt: now / 1_000 });
    release();
    await pending;
    await expect(finishing).resolves.toBe(0);
    expect(projection.summary(oldest.id)?.unread).toBe(true);
    expect(projection.summary(threads[14]!.id)?.unread).toBe(true);

    await store.flushed();
  });

  it("checks after sync and every minute without clients or RPC, then pauses until reconnect sync", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { projection, store, bridge, threads, setConnection } = await autoFinishHarness(
      now,
      Array.from({ length: 16 }, (_, index) => now - threeDays + (16 - index) * 1_000),
    );
    try {
      const finish = vi.spyOn(projection, "finishInactiveSessions");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(finish).not.toHaveBeenCalled();
      vi.setSystemTime(now);
      await projection.sync();
      bridge.request.mockClear();
      await vi.advanceTimersByTimeAsync(0);
      await finish.mock.results.at(-1)!.value;
      expect(finish).toHaveBeenCalledTimes(1);
      expect(projection.summary(threads[15]!.id)?.unread).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      await finish.mock.results.at(-1)!.value;
      expect(finish).toHaveBeenCalledTimes(2);
      expect(projection.summary(threads[15]!.id)?.unread).toBe(false);
      expect(bridge.request).not.toHaveBeenCalled();

      setConnection("unavailable");
      await vi.advanceTimersByTimeAsync(120_000);
      setConnection("ready");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(finish).toHaveBeenCalledTimes(2);
      await projection.sync();
      await vi.advanceTimersByTimeAsync(0);
      await finish.mock.results.at(-1)!.value;
      expect(finish).toHaveBeenCalledTimes(3);
    } finally {
      setConnection("unavailable");
      await store.flushed();
      vi.useRealTimers();
    }
  });

  it("retries failed checks and does not overlap slow checks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { projection, store, setConnection } = await autoFinishHarness(now);
    try {
      const error = new Error("Temporary storage failure");
      const onError = vi.fn();
      projection.on("projectionError", onError);
      const finish = vi.spyOn(projection, "finishInactiveSessions").mockRejectedValueOnce(error);
      await projection.sync();
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledWith(error);
      let release!: (value: number) => void;
      finish.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            release = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(finish).toHaveBeenCalledTimes(2);
      release(0);
      await vi.advanceTimersByTimeAsync(60_000);
      await finish.mock.results.at(-1)!.value;
      expect(finish).toHaveBeenCalledTimes(3);
    } finally {
      setConnection("unavailable");
      await store.flushed();
      vi.useRealTimers();
    }
  });
});

describe("AppProjection", () => {
  it("keeps a dismissed plan completed through restart, reconciliation and duplicate completion, but asks for a new plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-dismissed-plan-"));
    directories.push(directory);
    const statePath = join(directory, "state.json");
    const store = new StateStore(statePath);
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 10_000,
        awaitingPlanResponse: true,
        settings: { collaborationMode: "plan" },
      };
    });
    let terminal = {
      ...testTurn("plan-turn", "completed"),
      itemsView: "full" as const,
      items: [{ type: "plan" as const, id: "plan", text: "Do the work" }],
    };
    let updatedAt = 10;
    const makeBridge = () => {
      const bridge = new FakeBridge();
      const original = bridge.request.getMockImplementation()!;
      bridge.request.mockImplementation(async (method, params) => {
        if (method === "thread/list")
          return {
            data: params.archived ? [] : [thread("one", "/work", updatedAt)],
            nextCursor: null,
            backwardsCursor: null,
          };
        if (method === "thread/turns/list")
          return { data: [terminal], nextCursor: null, backwardsCursor: null };
        return original(method, params);
      });
      return bridge;
    };
    const bridge = makeBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    const request = { turnId: terminal.id, observedUpdatedAt: 10_000 };
    await projection.dismissPlan("one", request);
    expect(projection.summary("one")).toMatchObject({
      state: "completed",
      unread: true,
      awaitingPlanResponse: false,
    });

    const reloaded = new StateStore(statePath);
    await reloaded.load();
    const nextBridge = makeBridge();
    const restoredAttention = new AttentionManager();
    const restored = new AppProjection(
      nextBridge as unknown as CodexBridge,
      reloaded,
      restoredAttention,
    );
    // A different thread timestamp forces outcome reconstruction from the same plan.
    updatedAt = 11;
    await restored.sync();
    expect(restored.summary("one")).toMatchObject({
      state: "completed",
      dismissedPlanTurnId: terminal.id,
      awaitingPlanResponse: false,
    });
    let completions = 0;
    restored.on("event", (_sequence, event: ServerEvent) => {
      if (event.type === "thread.upserted") completions += 1;
    });
    nextBridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: terminal },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(completions).toBeGreaterThan(0));
    expect(restored.summary("one")).toMatchObject({
      state: "completed",
      awaitingPlanResponse: false,
    });
    await restored.setCurrentTurn("one", "next-plan");
    terminal = { ...terminal, id: "next-plan" };
    nextBridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: terminal },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(restored.summary("one")?.awaitingPlanResponse).toBe(true));
    await expect(restored.dismissPlan("one", request)).rejects.toThrow(
      "Состояние сессии изменилось",
    );
    expect(restored.summary("one")?.state).toBe("needsAttention");
    const pending = restoredAttention.receive(
      {
        id: "approval",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "one", turnId: terminal.id, itemId: "command" },
      },
      { respond: vi.fn(), respondError: vi.fn() } as unknown as JsonlTransport,
    );
    await expect(
      restored.dismissPlan("one", {
        turnId: terminal.id,
        observedUpdatedAt: restored.summary("one")!.updatedAt,
      }),
    ).rejects.toThrow("Состояние сессии изменилось");
    expect(restoredAttention.get(pending.id)).toBeDefined();
  });

  it("keeps a revised plan after clarification in live, completed and restored history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-revised-plan-"));
    directories.push(directory);
    const path = join(directory, "rollout.jsonl");
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const plan = { type: "plan" as const, id: "revision-plan", text: "Original" };
    const reply = {
      type: "userMessage" as const,
      id: "reply",
      clientId: "reply-client",
      content: [{ type: "text" as const, text: "All bots", text_elements: [] }],
    };
    const commentary = {
      type: "agentMessage" as const,
      id: "commentary",
      text: "Updating",
      phase: "commentary" as const,
      memoryCitation: null,
    };
    const revised = { ...plan, text: "Updated" };
    const source = {
      ...testTurn("revision", "inProgress"),
      itemsView: "full" as const,
      items: [plan, reply, commentary],
    };
    bridge.request.mockImplementation(async (method) => {
      if (method === "thread/turns/list")
        return { data: [structuredClone(source)], nextCursor: null, backwardsCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread({
      ...thread("one", "/work", 10, { type: "active", activeFlags: [] }, [source]),
      path,
    });
    await projection.setSettings("one", { collaborationMode: "plan" });
    const emit = (method: string, item: ThreadItem, time: number) =>
      bridge.emit("notification", {
        method,
        params: {
          threadId: "one",
          turnId: source.id,
          item,
          startedAtMs: time,
          completedAtMs: time,
        },
      });
    emit("item/completed", plan, 100);
    emit("item/completed", reply, 200);
    emit("item/completed", commentary, 300);
    emit("item/started", { ...plan, text: "" }, 350);
    emit("item/completed", revised, 400);
    source.items[0] = revised;
    const check = (items: ActivityItem[]) => {
      expect(
        items
          .filter((item) => ["plan", "userMessage", "agentMessage"].includes(item.type))
          .map((item) => item.id),
      ).toEqual(["reply-client", "commentary", "revision-plan"]);
      expect(items.find((item) => item.type === "plan")).toMatchObject({ text: "Updated" });
    };
    check((await projection.readThread("one")).turns[0]!.items);
    await writeFile(
      path,
      [
        { type: "event_msg", payload: { type: "task_started", turn_id: source.id } },
        {
          type: "response_item",
          payload: { type: "message", id: "reply", role: "user", content: [{ text: "All bots" }] },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            id: "commentary",
            role: "assistant",
            content: [{ text: "Updating" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            id: "final",
            role: "assistant",
            content: [{ text: "<proposed_plan>Updated</proposed_plan>" }],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    source.status = "completed";
    source.completedAt = 12;
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => events.push(event));
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: structuredClone(source) },
    });
    await vi.waitFor(() => {
      const event = events.findLast((event) => event.type === "turn.replaced");
      expect(event?.type).toBe("turn.replaced");
      if (event?.type === "turn.replaced") check(event.turn.items);
    });
    check((await projection.readThread("one", { refresh: true })).turns[0]!.items);
    await store.flushed();
    const restored = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    restored.upsertThread({
      ...thread("one", "/work", projection.summary("one")!.updatedAt / 1000),
      path,
    });
    check((await restored.readThread("one")).turns[0]!.items);
    const reads = bridge.request.mock.calls.length;
    check((await restored.readThread("one")).turns[0]!.items);
    expect(bridge.request).toHaveBeenCalledTimes(reads);
  });
  it("keeps three tool screenshots in live, completed and cached history without extra RPCs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-tool-images-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const source = {
      ...testTurn("screenshots", "inProgress"),
      itemsView: "full" as const,
    };
    bridge.request.mockImplementation(async (method) => {
      if (method === "thread/turns/list")
        return { data: [source], nextCursor: null, backwardsCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(
      thread("one", "/work", 10, { type: "active", activeFlags: [] }, [source]),
    );
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => events.push(event));
    const explanation = {
      type: "agentMessage" as const,
      id: "explanation",
      text: "Выведу три изображения",
      phase: "commentary" as const,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    const shots = [1, 2, 3].map((index) => ({
      type: "imageView" as const,
      id: `shot-${index}`,
      path: `/tmp/variant-${index}.png`,
    }));
    source.items = [explanation, ...shots];
    for (const item of source.items) {
      bridge.emit("notification", {
        method: "item/started",
        params: { threadId: "one", turnId: source.id, item, startedAtMs: 10000 },
      });
      bridge.emit("notification", {
        method: "item/completed",
        params: { threadId: "one", turnId: source.id, item, completedAtMs: 11000 },
      });
    }
    bridge.emit("notification", {
      method: "item/completed",
      params: { threadId: "one", turnId: source.id, item: shots[2], completedAtMs: 11000 },
    });
    expect(
      events.filter((event) => event.type === "activity.upserted" && event.item.id === "shot-1"),
    ).toMatchObject([
      { item: { type: "tool", status: "inProgress" } },
      { item: { type: "tool", status: "completed", images: ["/tmp/variant-1.png"] } },
    ]);
    const check = (items: ActivityItem[]) => {
      expect(items.map((item) => item.id)).toEqual(source.items.map((item) => item.id));
      expect(items.filter((item) => item.type === "tool").map((item) => item.images)).toEqual(
        shots.map((item) => [item.path]),
      );
    };
    check((await projection.readThread("one")).turns[0]!.items);
    source.items.push({
      ...explanation,
      id: "answer",
      text: "Вывел три скриншота",
      phase: "final_answer",
    });
    source.status = "completed";
    source.completedAt = 12;
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: { ...source, items: [explanation, source.items.at(-1)!] } },
    });
    await vi.waitFor(() => expect(projection.summary("one")?.currentTurnId).toBeNull());
    await vi.waitFor(() => {
      const completed = events.findLast((event) => event.type === "turn.replaced");
      expect(completed?.type).toBe("turn.replaced");
      if (completed?.type === "turn.replaced") check(completed.turn.items);
    });
    check((await projection.readThread("one", { refresh: true })).turns[0]!.items);
    const calls = bridge.request.mock.calls.length;
    for (const shot of shots) expect(projection.hasToolImagePath("one", shot.path)).toBe(true);
    expect(projection.hasToolImagePath("two", shots[0]!.path)).toBe(false);
    expect(projection.hasToolImagePath("one", "/tmp/secret.png")).toBe(false);
    expect(bridge.request).toHaveBeenCalledTimes(calls);
    const updatedAt = projection.summary("one")!.updatedAt / 1000;
    await store.flushed();
    const restored = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    restored.upsertThread(thread("one", "/work", updatedAt));
    check((await restored.readThread("one")).turns[0]!.items);
    expect(restored.hasToolImagePath("one", shots[0]!.path)).toBe(true);
    const cacheCalls = bridge.request.mock.calls.length;
    const cached = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    cached.upsertThread(thread("one", "/work", updatedAt));
    check((await cached.readThread("one")).turns[0]!.items);
    expect(cached.hasToolImagePath("one", shots[0]!.path)).toBe(true);
    expect(bridge.request).toHaveBeenCalledTimes(cacheCalls);
  });

  it("extracts structured images while keeping tool text and malformed outputs out of dialogue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-tool-content-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const image = "data:image/png;base64,aW1hZ2U=";
    const items: Thread["turns"][number]["items"] = [
      {
        type: "functionCallOutput",
        id: "function",
        name: "exec",
        namespace: "functions",
        output: [
          { type: "input_text", text: "/tmp/not-an-image.png" },
          { type: "input_image", image_url: image },
        ],
      },
      {
        type: "dynamicToolCall",
        id: "dynamic",
        namespace: "test",
        tool: "images",
        arguments: {},
        status: "completed",
        success: true,
        durationMs: 1,
        contentItems: [{ type: "inputImage", imageUrl: image }],
      },
      {
        type: "mcpToolCall",
        id: "mcp",
        server: "test",
        tool: "images",
        arguments: {},
        status: "completed",
        durationMs: 1,
        appContext: null,
        pluginId: null,
        readOnlyHint: true,
        error: null,
        result: {
          content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          structuredContent: null,
          _meta: null,
        },
      },
      {
        type: "imageGeneration",
        id: "generated",
        status: "completed",
        revisedPrompt: null,
        failure: null,
        savedPath: "/tmp/generated.png",
        result: "aW1hZ2U=",
      },
      {
        type: "imageGeneration",
        id: "inline-generated",
        status: "completed",
        revisedPrompt: null,
        failure: null,
        result: "aW1hZ2U=",
      },
      {
        type: "imageGeneration",
        id: "pending-generated",
        status: "inProgress",
        revisedPrompt: null,
        failure: null,
        result: "partial",
      },
      {
        type: "functionCallOutput",
        id: "plain",
        name: "exec",
        namespace: "functions",
        output: "plain log",
      },
      {
        type: "functionCallOutput",
        id: "unsafe",
        name: "exec",
        namespace: "functions",
        output: [
          { type: "input_image", image_url: "javascript:alert(1)" },
          { type: "input_image", image_url: "/tmp/secret.png" },
        ],
      },
    ];
    bridge.request.mockImplementation(async () => ({
      data: [{ ...testTurn("results", "completed"), itemsView: "full", items }],
      nextCursor: null,
      backwardsCursor: null,
    }));
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));
    const visible = (await projection.readThread("one")).turns[0]!.items;
    expect(visible.map((item) => item.id)).toEqual([
      "function",
      "dynamic",
      "mcp",
      "generated",
      "inline-generated",
    ]);
    expect(visible.map((item) => item.type === "tool" && item.images)).toEqual([
      [image],
      [image],
      [image],
      ["/tmp/generated.png"],
      [image],
    ]);
    expect(projection.hasToolImagePath("one", "/tmp/not-an-image.png")).toBe(false);
    expect(projection.hasToolImagePath("one", "/tmp/secret.png")).toBe(false);
  });

  it("persists pin changes across reloads and publishes them without Codex RPCs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-pinning-test-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const store = new StateStore(path);
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 5));
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => events.push(event));
    const original = projection.summary("one")!;

    await projection.setPinned("one", true);
    expect(projection.summary("one")).toEqual({ ...original, pinned: true });
    expect(events).toContainEqual({
      type: "thread.upserted",
      thread: { ...original, pinned: true },
    });
    await store.flushed();
    const reloaded = new StateStore(path);
    await reloaded.load();
    const restored = new AppProjection(
      bridge as unknown as CodexBridge,
      reloaded,
      new AttentionManager(),
    );
    restored.upsertThread(thread("one", "/work", 5));
    expect(restored.summary("one")?.pinned).toBe(true);

    await restored.setPinned("one", false);
    expect(restored.summary("one")?.pinned).toBe(false);
    await reloaded.flushed();
    const unpinned = new StateStore(path);
    await unpinned.load();
    expect(unpinned.view().threadMeta.one?.pinned).toBe(false);
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it("reports configured Codex settings separately and clears stale input denial on unload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-input-metadata-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread({
      ...thread("one", "/work", 5),
      canAcceptDirectInput: false,
      model: "native",
      reasoningEffort: "high",
    });
    await projection.setSettings("one", { model: "chosen", reasoningEffort: "low" });
    expect(projection.summary("one")).toMatchObject({
      canAcceptDirectInput: false,
      codexSettings: { model: "native", reasoningEffort: "high" },
      settings: { model: "chosen", reasoningEffort: "low" },
    });
    bridge.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "one", status: { type: "notLoaded" } },
    });
    expect(projection.summary("one")?.canAcceptDirectInput).toBeNull();
    projection.upsertThread({ ...thread("one", "/work", 5), canAcceptDirectInput: false });
    bridge.emit("state", "disconnected");
    expect(projection.summary("one")?.canAcceptDirectInput).toBeNull();
  });

  it("updates reported first-turn settings without replacing user choices or issuing RPCs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-settings-notification-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread({
      ...thread("one", "/work", 5),
      model: "gpt-5.6-sol",
      reasoningEffort: null,
    });
    await projection.setSettings("one", {
      collaborationMode: "plan",
      model: "gpt-6-astra",
      reasoningEffort: "xhigh",
    });
    const original = projection.summary("one")!;
    expect(original.codexSettings).toEqual({ model: "gpt-5.6-sol", reasoningEffort: null });
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => events.push(event));
    const notification = {
      method: "thread/settings/updated",
      params: {
        threadId: "one",
        threadSettings: {
          cwd: "/work",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          activePermissionProfile: null,
          model: "gpt-6-astra",
          modelProvider: "openai",
          serviceTier: null,
          effort: "xhigh",
          summary: null,
          collaborationMode: {
            mode: "plan",
            settings: {
              model: "gpt-6-astra",
              reasoning_effort: "xhigh",
              developer_instructions: null,
            },
          },
          multiAgentMode: "explicitRequestOnly",
          personality: null,
        },
      },
    } satisfies ServerNotification;
    bridge.emit("notification", notification);
    const updated = {
      ...original,
      codexSettings: { model: "gpt-6-astra", reasoningEffort: "xhigh" },
    };
    expect(projection.summary("one")).toEqual(updated);
    expect(events).toEqual([{ type: "thread.upserted", thread: updated }]);

    bridge.emit("notification", {
      ...notification,
      params: {
        ...notification.params,
        threadSettings: { ...notification.params.threadSettings, effort: null },
      },
    } satisfies ServerNotification);
    expect(projection.summary("one")).toEqual({
      ...original,
      codexSettings: { model: "gpt-6-astra", reasoningEffort: null },
    });
    expect(store.view().threadMeta.one?.settings).toEqual(original.settings);

    events.length = 0;
    bridge.emit("notification", {
      ...notification,
      params: { ...notification.params, threadId: "unknown" },
    } satisfies ServerNotification);
    expect(projection.summary("unknown")).toBeUndefined();
    expect(events).toEqual([]);
    expect(bridge.request).not.toHaveBeenCalled();
    await store.flushed();
  });

  it("searches unloaded roots by messages without expanding the snapshot and isolates targeted turn history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-search-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.dismissedProjectPaths = ["/dismissed"];
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 5));
    const occurrence = {
      turnId: "old",
      itemId: "answer",
      snippet: "😀needle",
      snippetMatchRange: { start: 2, end: 8 },
      turnCursor: "target-cursor",
    };
    const oldTurn = {
      ...testTurn("old", "completed"),
      itemsView: "full" as const,
      items: [
        {
          type: "agentMessage" as const,
          id: "answer",
          text: "needle",
          phase: "final_answer" as const,
          memoryCitation: null,
        },
      ],
    };
    bridge.request.mockImplementation(async (method) => {
      if (method === "thread/search")
        return {
          data: [
            thread("outside", "/work", 6),
            { ...thread("child", "/work", 5), parentThreadId: "one" },
            { ...thread("internal", "/work", 5), threadSource: "codexnest-fork-temp:abc" },
            { ...thread("ephemeral", "/work", 5), ephemeral: true },
            thread("dismissed", "/dismissed", 5),
          ].map((thread) => ({ thread, snippet: "needle" })),
          nextCursor: "next",
        };
      if (method === "thread/read") return { thread: thread("outside", "/work", 6) };
      if (method === "thread/searchOccurrences") return { data: [occurrence], nextCursor: null };
      if (method === "thread/turns/list")
        return { data: [oldTurn], nextCursor: "older", backwardsCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    expect(
      (await projection.searchThreads("needle", true, "page", "messages")).data.map(
        (entry) => entry.thread.id,
      ),
    ).toEqual(["outside"]);
    expect(bridge.request).toHaveBeenCalledExactlyOnceWith(
      "thread/search",
      {
        searchTerm: "needle",
        archived: true,
        cursor: "page",
        limit: 20,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      },
      30_000,
    );
    expect(projection.summary("outside")).toBeUndefined();
    expect(await projection.searchOccurrences("outside", "needle", null)).toMatchObject({
      data: [occurrence],
    });
    const result = await projection.readSearchTurn("outside", "old", "target-cursor");
    expect(result.turn.items).toEqual([expect.objectContaining({ id: "answer", text: "needle" })]);
    expect(bridge.request).toHaveBeenLastCalledWith(
      "thread/turns/list",
      {
        threadId: "outside",
        cursor: "target-cursor",
        limit: 1,
        sortDirection: "asc",
        itemsView: "full",
      },
      30_000,
    );
    expect(projection.snapshot().threads.map((thread) => thread.id)).toEqual(["one"]);
    await expect(projection.readSearchTurn("outside", "gone", "target-cursor")).rejects.toThrow(
      "Search result changed",
    );
    bridge.request.mockRejectedValueOnce(new RpcError(-32601, "method not found"));
    await expect(projection.searchThreads("needle", false, null, "messages")).rejects.toThrow(
      "Поиск недоступен",
    );
  });
  it("finds displayed titles by normalized fragments in any order without RPC", async () => {
    const { projection, bridge, store } = await searchHarness();
    const name = "Расширить OKX-парсер для Base";
    projection.upsertThread({ ...thread("base", "/work", 8), name });
    projection.upsertThread({
      ...thread("preview", "/other", 7),
      name: " ",
      preview: "Учёт ЁЖИКОВ",
    });
    projection.upsertThread({
      ...thread("other", "/work", 6),
      name: "Другая задача",
      preview: name,
    });
    for (const query of [
      "base",
      "Base",
      "BASE",
      "base okx",
      "okx base",
      "bas парс",
      "  OKX---BASE  ",
      "ＢＡＳＥ ＯＫＸ",
    ]) {
      const page = await projection.searchThreads(query, false, null, "titles");
      expect(page).toMatchObject({
        data: [{ thread: { id: "base", title: name }, snippet: "" }],
        nextCursor: null,
      });
      expect(page.data).toHaveLength(1);
    }
    for (const query of ["ЕЖ учет", "ЁЖ УЧЁТ", "е\u0308ж уче\u0308т"]) {
      expect(
        (await projection.searchThreads(query, false, null, "titles")).data.map(
          ({ thread }) => thread.id,
        ),
      ).toEqual(["preview"]);
    }
    for (const query of ["base missing", "base bsae", "ифыу", "---", "  "]) {
      expect(await projection.searchThreads(query, false, null, "titles")).toEqual({
        data: [],
        nextCursor: null,
      });
    }
    bridge.emit("notification", {
      method: "thread/name/updated",
      params: { threadId: "base", threadName: "Парсер Ethereum" },
    } satisfies ServerNotification);
    expect((await projection.searchThreads("base", false, null, "titles")).data).toEqual([]);
    expect(
      (await projection.searchThreads("ETH парс", false, null, "titles")).data[0]?.thread.title,
    ).toBe("Парсер Ethereum");
    expect(bridge.request).not.toHaveBeenCalled();
    await store.flushed();
  });

  it("filters title results by archive and visibility", async () => {
    const { projection, bridge, store } = await searchHarness();
    await store.update((state) => {
      state.dismissedProjectPaths = ["/dismissed"];
      state.threadMeta.managed = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "parent", taskId: "task" },
      };
    });
    for (const candidate of [
      thread("base-visible", "/other", 10),
      thread("base-dismissed", "/dismissed", 10),
      { ...thread("base-child", "/work", 10), parentThreadId: "parent" },
      { ...thread("base-native", "/work", 10), source: { subAgent: "review" } as const },
      { ...thread("base-internal", "/work", 10), threadSource: "codexnest-fork-temp:abc" },
      { ...thread("base-ephemeral", "/work", 10), ephemeral: true },
      { ...thread("managed", "/work", 10), name: "base managed" },
      thread("base-deleted", "/work", 10),
    ])
      projection.upsertThread(candidate);
    projection.upsertThread(thread("base-archived", "/other", 1, { type: "notLoaded" }), true);
    await projection.removeOrphanedThread("base-deleted");
    expect(
      (await projection.searchThreads("BASE", false, null, "titles")).data.map(
        ({ thread }) => thread.id,
      ),
    ).toEqual(["base-visible"]);
    expect(
      (await projection.searchThreads("BASE", true, null, "titles")).data.map(
        ({ thread }) => thread.id,
      ),
    ).toEqual(["base-archived"]);
    await projection.setArchived("base-visible", true);
    expect((await projection.searchThreads("BASE", false, null, "titles")).data).toEqual([]);
    expect(
      (await projection.searchThreads("BASE", true, null, "titles")).data.map(
        ({ thread }) => thread.id,
      ),
    ).toEqual(["base-visible", "base-archived"]);
    expect(bridge.request).not.toHaveBeenCalled();
    await store.flushed();
  });

  it("paginates title matches by time and ID and validates title cursors", async () => {
    const { projection, bridge, store } = await searchHarness();
    const ids = Array.from({ length: 45 }, (_, i) => `base-${String(i).padStart(2, "0")}`);
    for (const id of [...ids].reverse()) projection.upsertThread(thread(id, "/work", 10));
    projection.upsertThread(thread("base-newest", "/work", 11));
    const first = await projection.searchThreads("BASE", false, null, "titles");
    expect(first.data.map(({ thread }) => thread.id)).toEqual(["base-newest", ...ids.slice(0, 19)]);
    expect(first.nextCursor).not.toBeNull();
    projection.upsertThread(thread("base-arrived", "/work", 12));
    await projection.removeOrphanedThread("base-18");
    const second = await projection.searchThreads("base", false, first.nextCursor, "titles");
    const third = await projection.searchThreads("base", false, second.nextCursor, "titles");
    expect(second.data.map(({ thread }) => thread.id)).toEqual(ids.slice(19, 39));
    expect(third.data.map(({ thread }) => thread.id)).toEqual(ids.slice(39));
    expect(third.nextCursor).toBeNull();
    for (const cursor of ["messages-next", Buffer.from("null").toString("base64url")]) {
      await expect(projection.searchThreads("base", false, cursor, "titles")).rejects.toThrow(
        "Invalid search cursor",
      );
    }
    await expect(
      projection.searchThreads("different", false, first.nextCursor, "titles"),
    ).rejects.toThrow("Invalid search cursor");
    await expect(
      projection.searchThreads("base", true, first.nextCursor, "titles"),
    ).rejects.toThrow("Invalid search cursor");
    expect(bridge.request).not.toHaveBeenCalled();
    await store.flushed();
  });

  it("waits for the existing full catalog sync and searches unloaded titles without more RPC", async () => {
    const { projection, bridge, store } = await searchHarness();
    let resolvePage!: (page: unknown) => void;
    bridge.request.mockImplementation(async (method, params) => {
      if (method === "thread/list") {
        if (params.archived)
          return {
            data: [thread("base-archive", "/work", 1, { type: "notLoaded" })],
            nextCursor: null,
          };
        if (!params.cursor)
          return new Promise((resolve) => {
            resolvePage = resolve;
          });
        return {
          data: [{ ...thread("base-old", "/other", 2, { type: "notLoaded" }), source: "unknown" }],
          nextCursor: null,
        };
      }
      if (method === "model/list" || method === "thread/loaded/list")
        return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const sync = projection.sync();
    let completed = false;
    const search = projection.searchThreads("BASE", false, null, "titles").then((page) => {
      completed = true;
      return page;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    resolvePage({
      data: [{ ...thread("base-exec", "/work", 3, { type: "notLoaded" }), source: "exec" }],
      nextCursor: "older",
    });
    await sync;
    expect((await search).data.map(({ thread }) => thread.id)).toEqual(["base-exec", "base-old"]);
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/list")).toHaveLength(
      3,
    );
    for (const [, params] of bridge.request.mock.calls.filter(
      ([method]) => method === "thread/list",
    )) {
      expect(params.sourceKinds).toEqual(expect.arrayContaining(["exec", "unknown"]));
      expect(params).not.toHaveProperty("searchTerm");
    }
    bridge.request.mockClear();
    expect((await projection.searchThreads("BASE", true, null, "titles")).data[0]?.thread.id).toBe(
      "base-archive",
    );
    expect(bridge.request).not.toHaveBeenCalled();
    await store.flushed();
  });

  it("preserves async questions through streaming, item renumbering, and history reload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-async-question-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const question = {
      type: "agentMessage" as const,
      id: "live-question",
      text: "",
      phase: "commentary" as const,
      memoryCitation: null,
      delivery: "async" as const,
      questions: [{ title: "Как проверить?", options: ["Быстро", "Подробно"] }],
    };
    const canonical = { ...testTurn("live", "inProgress"), items: [question] };
    bridge.request.mockImplementation(async (method) => {
      if (method === "thread/turns/list")
        return { data: [canonical], nextCursor: null, backwardsCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(
      thread("one", "/work", 10, { type: "active", activeFlags: [] }, [
        { ...canonical, items: [] },
      ]),
    );
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => events.push(event));
    bridge.emit("notification", {
      method: "item/started",
      params: { threadId: "one", turnId: "live", item: question, startedAtMs: 10000 },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "activity.upserted",
          item: expect.objectContaining({
            delivery: "async",
            questions: question.questions,
            questionKey: expect.any(String),
          }),
        }),
      ),
    );
    expect(projection.summary("one")?.state).toBe("needsAttention");
    expect(events).toContainEqual({
      type: "thread.upserted",
      thread: expect.objectContaining({ state: "needsAttention", updatedAt: 10000 }),
    });
    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "one", turnId: "live", itemId: question.id, delta: "Уточнение" },
    });
    const live = (await projection.readThread("one")).turns[0]!.items.find(
      (item) => item.type === "agentMessage",
    )!;
    expect(live).toMatchObject({ questions: question.questions, delivery: "async" });
    question.text = "Уточнение";
    bridge.emit("notification", {
      method: "item/completed",
      params: { threadId: "one", turnId: "live", item: { ...question }, completedAtMs: 11000 },
    });
    canonical.items = [{ ...question, id: "item-17" }];
    await store.flushed();
    const reloaded = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    reloaded.upsertThread(
      thread("one", "/work", 11, { type: "active", activeFlags: [] }, [canonical]),
    );
    const restored = (await reloaded.readThread("one", { refresh: true })).turns[0]!.items.find(
      (item) => item.type === "agentMessage",
    );
    expect(restored).toMatchObject({
      questions: question.questions,
      delivery: "async",
      questionKey: "questionKey" in live ? live.questionKey : undefined,
    });
    expect(reloaded.summary("one")?.state).toBe("needsAttention");
    await store.update((state) => {
      state.messageReceipts ??= {};
      state.messageReceipts[asyncQuestionReplyMessageId("one", "live", restored!.questionKey!)] = {
        threadId: "one",
        turnId: "live",
        status: "delivered",
        contentHash: "a".repeat(64),
        createdAt: 12000,
      };
    });
    reloaded.upsertThread(
      thread("one", "/work", 12, { type: "active", activeFlags: [] }, [canonical]),
    );
    expect(reloaded.summary("one")?.state).toBe("running");
    await store.flushed();
  });

  it("keeps async questions needing attention through work and viewing until an answer is accepted", async () => {
    const { projection, bridge, store, receive, events } = await createAsyncQuestionHarness();
    const question = receive();
    expect(projection.summary("one")).toMatchObject({
      state: "needsAttention",
      currentTurnId: "questions-turn",
    });
    await projection.markViewed("one", 10000);
    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "questions-turn",
        itemId: "continuation",
        delta: "Продолжаю работу",
      },
    } satisfies ServerNotification);
    expect(projection.summary("one")?.state).toBe("needsAttention");
    expect(bridge.request).not.toHaveBeenCalled();
    const messageId = asyncQuestionReplyMessageId("one", "questions-turn", question.questionKey!);
    const message = {
      id: messageId,
      threadId: "one",
      text: "Быстро",
      createdAt: 10000,
      status: "queued" as const,
      replyToAsyncQuestion: { turnId: "questions-turn", itemId: question.id },
    };
    await store.update((state) => {
      state.messageQueues = { one: [message] };
    });
    projection.publishQueue("one", [message]);
    expect(projection.summary("one")?.state).toBe("running");
    expect(events.at(-1)).toMatchObject({
      type: "thread.upserted",
      thread: { state: "running", currentTurnId: "questions-turn" },
    });
    expect(bridge.request).not.toHaveBeenCalled();
    await store.update((state) => {
      delete state.messageQueues!.one;
    });
    projection.publishQueue("one", []);
    expect(projection.summary("one")?.state).toBe("needsAttention");
    await store.flushed();
  });

  it("treats repeated async questions independently and ignores rejected or unrelated replies", async () => {
    const { projection, bridge, store, receive } = await createAsyncQuestionHarness();
    const first = receive("first");
    const second = receive("second");
    const firstId = asyncQuestionReplyMessageId("one", "questions-turn", first.questionKey!);
    const secondId = asyncQuestionReplyMessageId(
      "one",
      "questions-turn",
      `${second.questionKey}:1`,
    );
    await store.update((state) => {
      state.messageReceipts = {
        [firstId]: {
          threadId: "one",
          turnId: "questions-turn",
          status: "delivered",
          contentHash: "a".repeat(64),
          createdAt: 10000,
        },
        [secondId]: {
          threadId: "one",
          turnId: null,
          status: "rejected",
          contentHash: "b".repeat(64),
          createdAt: 10000,
        },
      };
    });
    expect(projection.summary("one")?.state).toBe("needsAttention");
    await store.update((state) => {
      state.messageReceipts![secondId]!.status = "prepared";
    });
    expect(projection.summary("one")?.state).toBe("needsAttention");
    await store.update((state) => {
      state.messageReceipts![secondId]!.status = "delivered";
      state.messageReceipts![secondId]!.threadId = "other-session";
    });
    expect(projection.summary("one")?.state).toBe("needsAttention");
    await store.update((state) => {
      state.messageReceipts![secondId]!.threadId = "one";
      state.messageReceipts![secondId]!.turnId = "questions-turn";
    });
    expect(projection.summary("one")?.state).toBe("running");
    expect(bridge.request).not.toHaveBeenCalled();
    await store.flushed();
  });

  it.each(["completed", "failed", "interrupted", "stop"] as const)(
    "retires async question attention on %s and ignores it in the next turn",
    async (outcome) => {
      const { projection, bridge, store, receive } = await createAsyncQuestionHarness();
      receive();
      if (outcome === "stop") await projection.markInterrupted("one", ["questions-turn"]);
      else
        bridge.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "one",
            turn: { ...testTurn("questions-turn", "completed"), status: outcome },
          },
        } satisfies ServerNotification);
      await vi.waitFor(() =>
        expect(projection.summary("one")).toMatchObject({
          state: outcome === "stop" ? "interrupted" : outcome,
          currentTurnId: null,
        }),
      );
      bridge.emit("notification", {
        method: "turn/started",
        params: { threadId: "one", turn: testTurn("next-turn", "inProgress") },
      } satisfies ServerNotification);
      await vi.waitFor(() =>
        expect(projection.summary("one")).toMatchObject({
          state: "running",
          currentTurnId: "next-turn",
        }),
      );
      expect(bridge.request).not.toHaveBeenCalled();
      await store.flushed();
    },
  );

  it("keeps quiz replies in dialogue order when the agent outruns draft persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-quiz-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const message = (id: string, text: string) => ({
      type: "agentMessage" as const,
      id,
      text,
      phase: "commentary" as const,
      memoryCitation: null,
    });
    const canonical = {
      ...testTurn("live", "inProgress"),
      itemsView: "full" as const,
      items: [message("before", "Уточню восстановление")],
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      return { data: [canonical], nextCursor: null };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(
      thread("one", "/work", 10, { type: "active", activeFlags: [] }, [structuredClone(canonical)]),
    );
    await projection.readThread("one");
    const request: Extract<AttentionRequest, { kind: "userInput" }> = {
      id: "quiz",
      kind: "userInput",
      threadId: "one",
      turnId: "live",
      itemId: "call_quiz",
      createdAt: 11_000,
      autoResolutionMs: null,
      draft: null,
      questions: [
        {
          id: "choice",
          header: "Восстановление",
          question: "Как исправлять?",
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
    };
    await projection.updateUserInputDraft(request, {
      answers: { choice: ["Что случилось?"] },
      currentQuestionId: "choice",
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalUpdate = store.update.bind(store);
    const update = vi.spyOn(store, "update").mockImplementationOnce(async (fn) => {
      await gate;
      return originalUpdate(fn);
    });
    try {
      const recording = projection.recordAttentionResponse(request, {
        kind: "userInput",
        answers: { choice: ["Что случилось?"] },
      });
      now.mockReturnValue(21_000);
      bridge.emit("notification", {
        method: "item/completed",
        params: {
          threadId: "one",
          turnId: "live",
          item: message("reply", "Не Titan целиком"),
          completedAtMs: 21_000,
        },
      } satisfies ServerNotification);
      canonical.items.push(message("reply", "Не Titan целиком"));
      now.mockReturnValue(30_000);
      release();
      await recording;
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.live?.[0]).toMatchObject({
        timestamp: 20_000,
        afterItemId: "before",
      });
      const expected = ["before", "call_quiz-response", "reply"];
      expect((await projection.readThread("one")).turns[0]?.items.map((item) => item.id)).toEqual(
        expected,
      );
      expect(
        (await projection.readThread("one", { refresh: true })).turns[0]?.items.map(
          (item) => item.id,
        ),
      ).toEqual(expected);
      await store.flushed();
      const reloadedStore = new StateStore(store.path);
      await reloadedStore.load();
      const reloaded = new AppProjection(
        bridge as unknown as CodexBridge,
        reloadedStore,
        new AttentionManager(),
      );
      expect((await reloaded.readThread("one")).turns[0]?.items.map((item) => item.id)).toEqual(
        expected,
      );
      await reloadedStore.flushed();
    } finally {
      release();
      update.mockRestore();
      now.mockRestore();
    }
  });

  it("restores legacy quiz anchors while loading all dialogue and keeping technical output lazy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-quiz-history-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const path = join(directory, "rollout.jsonl");
    const records: object[] = [{ type: "turn_context", payload: { turn_id: "live" } }];
    const canonical = {
      ...testTurn("live", "inProgress"),
      itemsView: "full" as const,
      items: [] as Thread["turns"][number]["items"],
    };
    const artifacts: Extract<ActivityItem, { type: "userInputResponse" }>[] = [];
    const expected: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const id = `message-${index}`;
      const callId = `call_${index}`;
      canonical.items.push({
        type: "agentMessage",
        id,
        text: `Пояснение ${index}`,
        phase: "commentary",
        memoryCitation: null,
      });
      records.push({ type: "response_item", payload: { type: "message", id, role: "assistant" } });
      records.push({
        type: "response_item",
        timestamp: new Date(20_000 + index * 1_000).toISOString(),
        payload: { type: "function_call_output", call_id: callId },
      });
      artifacts.push({
        type: "userInputResponse",
        id: `${callId}-response`,
        status: "completed",
        entries: [{ header: "Уточнение", question: "Как?", answers: [`Вопрос ${index}`] }],
        timestamp: 50_000,
        afterItemId: callId,
      });
      expected.push(id, `${callId}-response`);
    }
    canonical.items.push({
      type: "agentMessage",
      id: "last-reply",
      text: "Не Titan целиком",
      phase: "commentary",
      memoryCitation: null,
    });
    expected.push("last-reply");
    canonical.items.push({
      type: "commandExecution",
      id: "command",
      command: "diagnostic",
      source: "agent",
      cwd: "/work",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "large output".repeat(10_000),
      exitCode: 0,
      durationMs: 1,
      processId: null,
    });
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        timelineArtifacts: { live: artifacts },
      };
    });
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/resume") {
        return {
          thread: thread("one", "/work", 10, { type: "active", activeFlags: [] }, [canonical]),
        };
      }
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      expect(params.itemsView).toBe("full");
      return { data: [canonical], nextCursor: null };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread({
      ...thread("one", "/work", 10, { type: "active", activeFlags: [] }, [
        structuredClone(canonical),
      ]),
      path,
    });
    const detail = await projection.readThread("one");
    expect(detail.turns[0]?.items.map((item) => item.id)).toEqual(expected);
    expect(detail.turns[0]?.itemsLoaded).toBe(false);
    expect(JSON.stringify(detail)).not.toContain("large output");
    expect(bridge.request).toHaveBeenCalledTimes(2);
    const full = await projection.readTurnItems("one", "live");
    expect(full.items.map((item) => item.id)).toEqual([...expected, "command"]);
    expect(full.items.at(-1)).toMatchObject({
      type: "command",
      output: expect.stringContaining("large output"),
    });
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: {
          type: "agentMessage",
          id: "next",
          text: "Продолжаю",
          phase: "commentary",
          memoryCitation: null,
        },
        completedAtMs: 60_000,
      },
    } satisfies ServerNotification);
    expect((await projection.readThread("one")).turns[0]?.items.map((item) => item.id)).toEqual([
      ...expected,
      "next",
    ]);
    // Recovery only adjusts the rendered view; persisted answers and the rollout remain intact.
    expect(store.snapshot().threadMeta.one?.timelineArtifacts?.live).toEqual(artifacts);
    await store.flushed();
  });

  it("keeps commentary before a final answer omitted from the earlier live items", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-terminal-dialogue-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: {
          type: "agentMessage",
          id: "explanation",
          text: "Причина найдена",
          phase: "commentary",
          memoryCitation: null,
        },
        completedAtMs: 11_000,
      },
    } satisfies ServerNotification);
    const replacements: TurnView[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "turn.replaced") replacements.push(event.turn);
    });
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          ...testTurn("live", "completed"),
          items: [
            {
              type: "agentMessage",
              id: "final",
              text: "Готово",
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    expect(replacements[0]?.items.map((item) => item.id)).toEqual(["explanation", "final"]);
    await store.flushed();
  });

  it("prunes by last user or agent activity instead of creation time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.pinned = { pinned: true, lastReadUpdatedAt: 0 };
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread({ ...thread("pinned", "/work", 1), createdAt: 1 });
    projection.upsertThread({
      ...thread("active", "/work", 2, { type: "active", activeFlags: [] }),
      createdAt: 2,
    });
    projection.upsertThread({ ...thread("recent", "/work", 40), createdAt: 1 });
    projection.upsertThread({ ...thread("agent-active", "/work", 5), createdAt: 100 });
    projection.upsertThread({ ...thread("inactive", "/work", 10), createdAt: 200 });

    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "agent-active",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "answer",
          text: "Fresh agent activity",
          phase: null,
        },
        completedAtMs: 50_000,
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("agent-active")?.updatedAt).toBe(50_000));

    await expect(projection.pruneOldestSessions(4, 10)).resolves.toBe(1);

    expect(projection.summary("inactive")).toBeUndefined();
    expect(projection.summary("agent-active")).toBeDefined();
    expect(projection.summary("pinned")).toBeDefined();
    expect(projection.summary("active")).toBeDefined();
    expect(bridge.request).toHaveBeenCalledWith("thread/delete", { threadId: "inactive" }, 30_000);
  });

  it("forwards skill catalog invalidations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const events: Array<{ type: string }> = [];
    projection.on("event", (_sequence, event) => events.push(event));

    bridge.emit("notification", {
      method: "skills/changed",
      params: {},
    } satisfies ServerNotification);

    await vi.waitFor(() => expect(events).toContainEqual({ type: "skills.changed" }));
  });

  it("counts files and changed lines in an aggregated turn diff", () => {
    expect(
      diffStats(
        "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new\ndiff --git a/b.ts b/b.ts\n+++ b/b.ts\n+added",
      ),
    ).toEqual({ filesChanged: 2, additions: 2, deletions: 1 });
  });

  it("reuses one zero-copy state view while materializing thread views", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.projects.push({
        id: "root",
        displayName: "Root",
        path: "/work",
        createdAt: "x",
        updatedAt: "x",
      });
      state.threadMeta.empty = {
        pinned: false,
        lastReadUpdatedAt: 0,
        unmaterialized: true,
      };
    });
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const stateViews = vi.spyOn(store, "view");

    projection.upsertThread(thread("one", "/work", 1));
    expect(stateViews).toHaveBeenCalledTimes(1);

    stateViews.mockClear();
    projection.upsertThread({ ...thread("empty", "/work", 2), preview: "" });
    expect(stateViews).toHaveBeenCalledTimes(1);

    stateViews.mockClear();
    expect(projection.snapshot().threads.map((candidate) => candidate.id)).toEqual([
      "empty",
      "one",
    ]);
    expect(stateViews).toHaveBeenCalledTimes(1);

    stateViews.mockClear();
    expect(projection.canRecoverMissingFirstSession("empty")).toBe(false);
    expect(stateViews).toHaveBeenCalledTimes(1);
  });

  it("skips outcome reconciliation for unmaterialized threads during full sync", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        unmaterialized: true,
      };
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await expect(projection.sync()).resolves.toBeUndefined();

    const outcomeReads = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/turns/list",
    );
    expect(outcomeReads.map(([, params]) => params.threadId)).toEqual(["two"]);
  });

  it("does not reactivate a turn after its completion notification wins the response race", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));
    await projection.setCurrentTurn("one", "turn");

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          id: "turn",
          items: [],
          itemsView: "summary",
          status: "completed",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")?.currentTurnId).toBeNull());

    await projection.setCurrentTurn("one", "turn");
    expect(projection.summary("one")).toMatchObject({
      state: "completed",
      currentTurnId: null,
    });
    await store.flushed();
  });

  it("does not roll a live turn back when a stale full sync finishes later", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new EventEmitter() as EventEmitter & {
      state: "ready";
      request: ReturnType<typeof vi.fn>;
    };
    bridge.state = "ready";
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    bridge.request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        if (params.archived) return { data: [], nextCursor: null, backwardsCursor: null };
        await listGate;
        return {
          data: [thread("one", "/work", 5, { type: "idle" })],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        return {
          data: [
            {
              id: "last",
              items: [],
              itemsView: "notLoaded",
              status: "completed",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 5, { type: "idle" }));

    const syncing = projection.sync();
    bridge.emit("notification", {
      method: "turn/started",
      params: {
        threadId: "one",
        turn: {
          id: "live",
          items: [],
          itemsView: "summary",
          status: "inProgress",
          error: null,
          startedAt: 10,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")?.currentTurnId).toBe("live"));
    releaseList();
    await syncing;

    expect(projection.summary("one")).toMatchObject({ state: "running", currentTurnId: "live" });
  });

  it("does not roll a pre-existing live turn back from an equal-time full sync", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const updatedAt = Math.floor(Date.now() / 1_000);
    const bridge = new EventEmitter() as EventEmitter & {
      state: "ready";
      request: ReturnType<typeof vi.fn>;
    };
    bridge.state = "ready";
    bridge.request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return params.archived
          ? { data: [], nextCursor: null, backwardsCursor: null }
          : {
              data: [thread("one", "/work", updatedAt, { type: "idle" })],
              nextCursor: null,
              backwardsCursor: null,
            };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        return {
          data: [testTurn("last", "completed")],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", updatedAt));
    await projection.setCurrentTurn("one", "live");

    await projection.sync();

    expect(projection.summary("one")).toMatchObject({ state: "running", currentTurnId: "live" });
  });

  it("does not roll a pre-existing live turn back from an equal-time thread refresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const updatedAt = Math.floor(Date.now() / 1_000);
    const bridge = new EventEmitter() as EventEmitter & {
      state: "ready";
      request: ReturnType<typeof vi.fn>;
    };
    bridge.state = "ready";
    bridge.request = vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return { thread: thread("one", "/work", updatedAt, { type: "idle" }) };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", updatedAt));
    await projection.setCurrentTurn("one", "live");

    await projection.refreshThread("one");

    expect(projection.summary("one")).toMatchObject({ state: "running", currentTurnId: "live" });
  });

  it("does not resurrect a thread deleted while a full sync is listing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new EventEmitter() as EventEmitter & {
      state: "ready";
      request: ReturnType<typeof vi.fn>;
    };
    bridge.state = "ready";
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    bridge.request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        if (params.archived) return { data: [], nextCursor: null, backwardsCursor: null };
        await listGate;
        return {
          data: [thread("one", "/work", 5, { type: "idle" })],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        return {
          data: [
            {
              id: "last",
              items: [],
              itemsView: "notLoaded",
              status: "completed",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 5, { type: "idle" }));

    const syncing = projection.sync();
    bridge.emit("notification", {
      method: "thread/deleted",
      params: { threadId: "one" },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")).toBeUndefined());
    releaseList();
    await syncing;

    expect(projection.summary("one")).toBeUndefined();
  });

  it("keeps an orphaned thread removed if sync lists it again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new EventEmitter() as EventEmitter & {
      state: "ready";
      request: ReturnType<typeof vi.fn>;
    };
    bridge.state = "ready";
    bridge.request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        if (params.archived) return { data: [], nextCursor: null, backwardsCursor: null };
        return {
          data: [thread("one", "/work", 5, { type: "idle" })],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        return {
          data: [
            {
              id: "last",
              items: [],
              itemsView: "notLoaded",
              status: "completed",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 5, { type: "idle" }));
    await projection.removeOrphanedThread("one");

    await expect(projection.sync()).resolves.toBeUndefined();

    expect(projection.summary("one")).toBeUndefined();
    expect(store.snapshot().threadMeta.one).toBeUndefined();
  });

  it("projects managed spawn tools as linked subagent launch activities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const activities: ActivityItem[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "activity.upserted" && event.item.id === "spawn-child") {
        activities.push(event.item);
      }
    });

    bridge.emit("notification", {
      method: "item/started",
      params: {
        threadId: "one",
        turnId: "parent-turn",
        item: {
          type: "dynamicToolCall",
          id: "spawn-child",
          namespace: "codexnest",
          tool: "spawn_task",
          arguments: {
            title: "Проверить интерфейс",
            prompt: "Review the interface.",
          },
          status: "inProgress",
          contentItems: null,
          success: null,
        },
        startedAtMs: 1_000,
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "parent-turn",
        item: {
          type: "dynamicToolCall",
          id: "spawn-child",
          namespace: "codexnest",
          tool: "spawn_task",
          arguments: {
            title: "Проверить интерфейс",
            prompt: "Review the interface.",
          },
          status: "completed",
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                taskId: "task",
                threadId: "child",
                status: "queued",
              }),
            },
          ],
          success: true,
        },
        completedAtMs: 2_000,
      },
    } satisfies ServerNotification);

    expect(activities).toEqual([
      {
        type: "subagentLaunch",
        id: "spawn-child",
        status: "inProgress",
        title: "Проверить интерфейс",
        threadId: null,
      },
      {
        type: "subagentLaunch",
        id: "spawn-child",
        status: "completed",
        title: "Проверить интерфейс",
        threadId: "child",
      },
    ]);
  });

  it.each(["v1", "v2"])(
    "projects native %s launches live and from history without extra RPCs",
    async (version) => {
      const directory = await mkdtemp(join(tmpdir(), "codexnest-native-launch-test-"));
      directories.push(directory);
      const store = new StateStore(join(directory, "state.json"));
      await store.load();
      const bridge = new FakeBridge();
      const launch: ThreadItem =
        version === "v2"
          ? {
              type: "subAgentActivity",
              id: "native-launch",
              kind: "started",
              agentThreadId: "child",
              agentPath: "/root/mobile_review",
            }
          : {
              type: "collabAgentToolCall",
              id: "native-launch",
              tool: "spawnAgent",
              status: "completed",
              senderThreadId: "one",
              receiverThreadIds: ["child"],
              prompt: "Task: Проверить интерфейс\nReview the mobile layout.",
              model: null,
              reasoningEffort: null,
              agentsStates: {},
            };
      const canonical = {
        ...testTurn("parent-turn", "completed"),
        itemsView: "full" as const,
        items: [
          { ...launch, id: "history-launch" },
          {
            type: "subAgentActivity" as const,
            id: "interaction",
            kind: "interacted" as const,
            agentThreadId: "child",
            agentPath: "/root/mobile_review",
          },
        ],
      };
      bridge.request.mockImplementation(async (method: string) => {
        if (method === "thread/turns/list")
          return { data: [canonical], nextCursor: null, backwardsCursor: null };
        throw new Error(`Unexpected ${method}`);
      });
      const projection = new AppProjection(
        bridge as unknown as CodexBridge,
        store,
        new AttentionManager(),
      );
      projection.upsertThread(thread("one", "/work", 5, { type: "notLoaded" }));
      const activities: ActivityItem[] = [];
      projection.on("event", (_sequence, event: ServerEvent) => {
        if (event.type === "activity.upserted") activities.push(event.item);
      });
      bridge.emit("notification", {
        method: "item/started",
        params: {
          threadId: "one",
          turnId: "parent-turn",
          startedAtMs: 1_000,
          item:
            launch.type === "collabAgentToolCall" ? { ...launch, status: "inProgress" } : launch,
        },
      } satisfies ServerNotification);
      const completed: ServerNotification = {
        method: "item/completed",
        params: { threadId: "one", turnId: "parent-turn", item: launch, completedAtMs: 2_000 },
      };
      bridge.emit("notification", completed);
      bridge.emit("notification", completed);
      expect(activities).toHaveLength(3);
      expect(activities[0]).toMatchObject({
        type: "subagentLaunch",
        source: "codex",
        status: "inProgress",
      });
      expect(activities[2]).toMatchObject({
        type: "subagentLaunch",
        source: "codex",
        status: "completed",
        timestamp: 1_000,
      });
      expect(bridge.request).not.toHaveBeenCalled();
      const detail = await projection.readThread("one");
      expect(detail.turns[0]?.items).toEqual([
        expect.objectContaining({
          type: "subagentLaunch",
          source: "codex",
          id: "history-launch",
          threadId: "child",
          title: version === "v2" ? "mobile_review" : "Проверить интерфейс",
          ...(version === "v2" ? { agentPath: "/root/mobile_review" } : {}),
        }),
      ]);
      const reloaded = new AppProjection(
        bridge as unknown as CodexBridge,
        store,
        new AttentionManager(),
      );
      reloaded.upsertThread(thread("one", "/work", 5, { type: "notLoaded" }));
      expect((await reloaded.readThread("one")).turns[0]?.items).toHaveLength(1);
      expect(bridge.request.mock.calls.every(([method]) => method === "thread/turns/list")).toBe(
        true,
      );
      if (launch.type === "collabAgentToolCall") {
        bridge.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "one",
            turnId: "parent-turn",
            completedAtMs: 3_000,
            item: { ...launch, id: "failed-launch", status: "failed", receiverThreadIds: [] },
          },
        } satisfies ServerNotification);
        expect(activities.at(-1)).toMatchObject({
          type: "subagentLaunch",
          source: "codex",
          status: "failed",
          threadId: null,
        });
      }
    },
  );

  it("retains a native launch when the terminal turn only contains the final answer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-native-terminal-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const canonical = {
      ...testTurn("live", "completed"),
      itemsView: "summary" as const,
      items: [
        {
          type: "agentMessage" as const,
          id: "final",
          text: "Готово",
          phase: "final_answer" as const,
        },
      ],
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list")
        return { data: [canonical], nextCursor: null, backwardsCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 5));
    const replacements: TurnView[] = [];
    projection.on("event", (_sequence, event: ServerEvent) => {
      if (event.type === "turn.replaced") replacements.push(event.turn);
    });
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        completedAtMs: 1_000,
        item: {
          type: "subAgentActivity",
          id: "launch",
          kind: "started",
          agentThreadId: "child",
          agentPath: "/root/review",
        },
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: canonical },
    } as ServerNotification);
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    expect(replacements[0]?.items.map((item) => item.id)).toEqual(["launch", "final"]);
    expect((await projection.readThread("one")).turns[0]?.items.map((item) => item.id)).toEqual([
      "launch",
      "final",
    ]);
  });

  it.each([false, null])(
    "shows native input-free subagent history with input capability %s",
    async (canAcceptDirectInput) => {
      const directory = await mkdtemp(join(tmpdir(), "codexnest-native-history-test-"));
      directories.push(directory);
      const store = new StateStore(join(directory, "state.json"));
      await store.load();
      const bridge = new FakeBridge();
      const ownTurn = {
        ...testTurn("child-turn", "completed"),
        itemsView: "full" as const,
        items: [
          {
            type: "agentMessage" as const,
            id: "own-answer",
            text: "Результат субагента",
            phase: "final_answer" as const,
          },
        ],
      };
      bridge.request.mockImplementation(async (method: string) => {
        if (method === "thread/turns/list")
          return { data: [ownTurn], nextCursor: null, backwardsCursor: null };
        throw new Error(`Unexpected ${method}`);
      });
      const projection = new AppProjection(
        bridge as unknown as CodexBridge,
        store,
        new AttentionManager(),
      );
      projection.upsertThread({
        ...thread("child", "/work", 5, { type: "notLoaded" }),
        parentThreadId: "parent",
        ephemeral: true,
        canAcceptDirectInput,
      });
      const detail = await projection.readThread("child");
      expect(detail.turns[0]?.items).toEqual([
        expect.objectContaining({ id: "own-answer", text: "Результат субагента" }),
      ]);
    },
  );

  it("keeps ephemeral helper threads out of the client projection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const events: Array<{ type: string }> = [];
    projection.on("event", (_sequence, event) => events.push(event));
    const hidden = { ...thread("title", "/work", 1), ephemeral: true };

    bridge.emit("notification", {
      method: "thread/started",
      params: { thread: hidden },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/started",
      params: {
        threadId: hidden.id,
        turn: {
          id: "title-turn",
          items: [],
          itemsView: "summary",
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);

    expect(projection.threadCount).toBe(0);
    expect(events).toEqual([]);
  });

  it("keeps operation-owned fork threads hidden until the final target is ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.forkOperations = {
        operation: {
          id: "operation",
          sourceThreadId: "source",
          lastTurnId: "turn",
          agentMessageId: "answer",
          mode: "compressed",
          status: "reconciling",
          title: "Fork",
          createdAt: 1,
          updatedAt: 1,
          targetThreadId: "final",
          estimate: null,
          error: null,
          sourceCwd: "/work",
          sourceSettings: { collaborationMode: "default" },
          rolloutPath: null,
          agentText: "",
          queuedMessages: [],
        },
      };
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => events.push(event));
    const temporary = {
      ...thread("temporary", "/work", 2),
      threadSource: "codexnest-fork-temp:operation",
    };
    const final = {
      ...thread("final", "/work", 3),
      threadSource: "codexnest-fork:operation",
    };

    bridge.emit("notification", {
      method: "thread/started",
      params: { thread: temporary },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "thread/started",
      params: { thread: final },
    } satisfies ServerNotification);
    projection.upsertThread(final);

    expect(projection.summary("temporary")).toBeUndefined();
    expect(projection.summary("final")).toBeUndefined();
    expect(projection.snapshot().threads).toEqual([]);
    expect(events).toEqual([]);

    bridge.emit("state", "unavailable");

    expect(projection.summary("final")).toBeUndefined();
    expect(projection.snapshot().threads).toEqual([]);
    expect(events.filter((event) => event.type === "thread.upserted")).toEqual([]);

    await store.update((state) => {
      state.forkOperations!.operation!.status = "ready";
    });
    projection.revealThread(final);

    expect(projection.summary("final")?.id).toBe("final");
    expect(projection.snapshot().threads.map((item) => item.id)).toEqual(["final"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread.upserted",
        thread: expect.objectContaining({ id: "final" }),
      }),
    );
  });

  it("projects native spawned subagents and keeps them after they close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const child = {
      ...thread("child", "/work", 2),
      ephemeral: true,
      forkedFromId: "source",
      parentThreadId: "one",
      agentNickname: "tester",
      agentRole: "worker",
    };

    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "parent-turn",
        item: {
          type: "collabAgentToolCall",
          id: "spawn-child",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "one",
          receiverThreadIds: ["child"],
          prompt: "Task: Проверить мобильную вёрстку субагента\n\nПроверить экран на узкой ширине.",
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
        completedAtMs: 1_000,
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "thread/started",
      params: { thread: child },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(projection.summary("child")).toMatchObject({
        title: "Проверить мобильную вёрстку субагента",
        relation: {
          kind: "subagent",
          sessionId: "child",
          parentThreadId: "one",
          nickname: "tester",
          role: "worker",
        },
      }),
    );
    expect(projection.summary("child")?.relation).not.toHaveProperty("forkedFromId");
    expect(bridge.request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "child",
      name: "Проверить мобильную вёрстку субагента",
    });

    bridge.emit("notification", {
      method: "thread/closed",
      params: { threadId: "child" },
    } satisfies ServerNotification);

    expect(projection.summary("child")).toMatchObject({
      id: "child",
      state: "idle",
      currentTurnId: null,
    });
  });

  it("deduplicates native wait delivery and bounds replay markers to the source event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      for (const threadId of ["child-a", "child-b"]) {
        state.threadMeta[threadId] = {
          pinned: false,
          lastReadUpdatedAt: 0,
          lastOutcome: "completed",
          outcomeUpdatedAt: 10_000,
        };
      }
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    for (const threadId of ["child-a", "child-b"]) {
      projection.upsertThread({
        ...thread(threadId, "/work", 10),
        parentThreadId: "one",
        ephemeral: true,
      });
    }
    expect(projection.summary("child-a")?.unread).toBe(true);
    expect(projection.summary("child-b")?.unread).toBe(true);

    const updates = vi.spyOn(store, "update");
    const published: string[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "thread.upserted") published.push(event.thread.id);
    });
    const firstWait = collabWaitNotification("wait-first", "completed", ["child-a", "child-b"], {
      "child-a": { status: "completed", message: "Result A" },
      "child-b": { status: "completed", message: "Result B" },
    });
    bridge.emit("notification", firstWait);
    bridge.emit("notification", firstWait);

    await vi.waitFor(() => {
      expect(store.snapshot().threadMeta["child-a"]?.lastReadUpdatedAt).toBe(10_000);
      expect(store.snapshot().threadMeta["child-b"]?.lastReadUpdatedAt).toBe(10_000);
    });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(projection.summary("child-a")?.unread).toBe(false);
    expect(projection.summary("child-b")?.unread).toBe(false);
    expect(published).toEqual(expect.arrayContaining(["child-a", "child-b"]));

    bridge.emit("notification", firstWait);
    await nextImmediate();
    expect(updates).toHaveBeenCalledTimes(1);

    projection.upsertThread({
      ...thread("child-a", "/work", 11),
      parentThreadId: "one",
      ephemeral: true,
    });
    expect(projection.summary("child-a")?.unread).toBe(true);
    bridge.emit("notification", firstWait);
    await nextImmediate();
    expect(updates).toHaveBeenCalledTimes(1);
    expect(store.snapshot().threadMeta["child-a"]?.lastReadUpdatedAt).toBe(10_000);
    expect(projection.summary("child-a")?.unread).toBe(true);

    const replayBridge = new FakeBridge();
    const replayProjection = new AppProjection(
      replayBridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    replayProjection.upsertThread({
      ...thread("child-a", "/work", 11),
      parentThreadId: "one",
      ephemeral: true,
    });
    replayBridge.emit("notification", firstWait);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta["child-a"]?.lastReadUpdatedAt).toBe(10_500),
    );
    expect(replayProjection.summary("child-a")?.unread).toBe(true);

    replayBridge.emit(
      "notification",
      collabWaitNotification(
        "wait-second",
        "completed",
        ["child-a"],
        {
          "child-a": { status: "completed", message: "A newer result" },
        },
        11_500,
      ),
    );

    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta["child-a"]?.lastReadUpdatedAt).toBe(11_000),
    );
    expect(replayProjection.summary("child-a")?.unread).toBe(false);
  });

  it("does not clear native subagents for timeout, running, empty, or failed results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.child = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 10_000,
      };
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread({
      ...thread("child", "/work", 10),
      parentThreadId: "one",
      ephemeral: true,
    });
    const updates = vi.spyOn(store, "update");

    bridge.emit(
      "notification",
      collabWaitNotification("wait-timeout", "failed", ["child"], {
        child: { status: "completed", message: "Late result" },
      }),
    );
    bridge.emit(
      "notification",
      collabWaitNotification("wait-running", "completed", ["child"], {
        child: { status: "running", message: "Still running" },
      }),
    );
    bridge.emit(
      "notification",
      collabWaitNotification("wait-empty", "completed", ["child"], {
        child: { status: "completed", message: "   " },
      }),
    );
    bridge.emit(
      "notification",
      collabWaitNotification("wait-errored", "completed", ["child"], {
        child: { status: "errored", message: "Failed" },
      }),
    );
    bridge.emit(
      "notification",
      collabWaitNotification("wait-interrupted", "completed", ["child"], {
        child: { status: "interrupted", message: "Interrupted" },
      }),
    );
    await nextImmediate();

    expect(updates).not.toHaveBeenCalled();
    expect(store.snapshot().threadMeta.child?.lastReadUpdatedAt).toBe(0);
    expect(projection.summary("child")?.unread).toBe(true);
  });

  it("applies managed result markers only with the first atomic artifact insert", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      for (const [threadId, outcome] of [
        ["completed-child", "completed"],
        ["failed-child", "failed"],
        ["interrupted-child", "interrupted"],
      ] as const) {
        state.threadMeta[threadId] = {
          pinned: false,
          lastReadUpdatedAt: 0,
          lastOutcome: outcome,
          outcomeUpdatedAt: 10_000,
        };
      }
    });
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("parent", "/work", 10));
    for (const threadId of ["completed-child", "failed-child", "interrupted-child"]) {
      projection.upsertThread({
        ...thread(threadId, "/work", 10),
        parentThreadId: "parent",
        ephemeral: true,
      });
    }
    const agents = [
      {
        threadId: "completed-child",
        title: "Completed",
        nickname: null,
        outcome: "completed" as const,
      },
      {
        threadId: "failed-child",
        title: "Failed",
        nickname: null,
        outcome: "failed" as const,
      },
      {
        threadId: "interrupted-child",
        title: "Interrupted",
        nickname: null,
        outcome: "interrupted" as const,
      },
    ];

    const first = projection.recordOrchestrationNotice("parent", "parent-turn", agents, null);
    const duplicate = projection.recordOrchestrationNotice("parent", "parent-turn", agents, null);
    projection.upsertThread({
      ...thread("completed-child", "/work", 11),
      parentThreadId: "parent",
      ephemeral: true,
    });
    await Promise.all([first, duplicate]);

    expect(store.snapshot().threadMeta.parent?.timelineArtifacts?.["parent-turn"]).toHaveLength(1);
    expect(store.snapshot().threadMeta["completed-child"]?.lastReadUpdatedAt).toBe(10_000);
    expect(store.snapshot().threadMeta["failed-child"]?.lastReadUpdatedAt).toBe(0);
    expect(store.snapshot().threadMeta["interrupted-child"]?.lastReadUpdatedAt).toBe(0);
    expect(projection.summary("completed-child")?.unread).toBe(true);
    expect(projection.summary("failed-child")?.unread).toBe(true);
    expect(projection.summary("interrupted-child")?.unread).toBe(true);

    await projection.recordOrchestrationNotice("parent", "parent-turn", agents, null);
    expect(store.snapshot().threadMeta["completed-child"]?.lastReadUpdatedAt).toBe(10_000);
    expect(projection.summary("completed-child")?.unread).toBe(true);

    await projection.recordOrchestrationNotice("parent", "next-parent-turn", [agents[0]!], null);
    expect(store.snapshot().threadMeta["completed-child"]?.lastReadUpdatedAt).toBe(11_000);
    expect(projection.summary("completed-child")?.unread).toBe(false);
  });

  it("persists rich managed result notices without dropping v2 metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const agent = {
      threadId: "child",
      taskId: "task-v2",
      title: "Review the client",
      nickname: "reviewer",
      outcome: "completed" as const,
      result: {
        outcome: "partial" as const,
        summary: "The presentation is implemented.",
        checks: [{ name: "client tests", outcome: "passed" as const, details: "12 passed" }],
      },
      budgetReason: "tokenBudget" as const,
      failureReason: "One optional visual check was not run.",
      changedPaths: ["apps/client/src/components/ThreadPage.tsx"],
      changedPathCount: 24,
      workspaceIntegrationStatus: "integrated" as const,
    };

    await projection.recordOrchestrationNotice("parent", "parent-turn", [agent], null);

    expect(store.snapshot().threadMeta.parent?.timelineArtifacts?.["parent-turn"]).toEqual([
      expect.objectContaining({
        type: "orchestrationNotice",
        id: "orchestration-parent-turn-child",
        agents: [agent],
      }),
    ]);
  });

  it("recovers loaded subagents omitted from thread/list once per connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const parent = thread("parent", "/work", 2, { type: "notLoaded" });
    const child = {
      ...thread("child", "/work", 3, { type: "active", activeFlags: [] }),
      parentThreadId: "parent",
      ephemeral: true,
      agentNickname: "reviewer",
      agentRole: "worker",
      name: "Проверить восстановление",
    };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : [parent],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") {
        return { data: ["parent", "child"], nextCursor: null };
      }
      if (method === "thread/read" && params.threadId === "child") {
        return { thread: child };
      }
      if (method === "thread/resume" && params.threadId === "parent") {
        return { thread: parent };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await projection.sync();

    expect(projection.summary("child")).toMatchObject({
      state: "running",
      relation: {
        kind: "subagent",
        parentThreadId: "parent",
        nickname: "reviewer",
      },
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/loaded/list"),
    ).toHaveLength(1);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "child",
      ),
    ).toHaveLength(1);

    await projection.sync();

    expect(projection.summary("child")?.state).toBe("running");
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/loaded/list"),
    ).toHaveLength(1);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "child",
      ),
    ).toHaveLength(1);

    bridge.emit("state", "ready");
    await projection.sync();

    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/loaded/list"),
    ).toHaveLength(2);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "child",
      ),
    ).toHaveLength(2);
  });

  it("recovers and retains a loaded user session omitted from thread/list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const omitted = thread("omitted", "/work", 7, { type: "notLoaded" });
    const resumed = {
      ...thread("omitted", "/work", 7, { type: "active", activeFlags: [] }),
      turns: [testTurn("live", "inProgress")],
    };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      if (method === "thread/loaded/list") {
        return { data: ["omitted"], nextCursor: null };
      }
      if (method === "thread/read" && params.threadId === "omitted") {
        return { thread: omitted };
      }
      if (method === "thread/resume" && params.threadId === "omitted") {
        return { thread: resumed };
      }
      if (method === "thread/goal/get" && params.threadId === "omitted") {
        return { goal: null };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await projection.sync();

    expect(projection.summary("omitted")).toMatchObject({
      state: "running",
      currentTurnId: "live",
      relation: { kind: "session", sessionId: "omitted" },
    });
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "omitted",
      ),
    ).toHaveLength(1);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/resume" && params.threadId === "omitted",
      ),
    ).toHaveLength(1);

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "omitted", turn: testTurn("live", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(projection.summary("omitted")).toMatchObject({
        state: "completed",
        unread: true,
        currentTurnId: null,
      }),
    );

    await projection.sync();

    expect(projection.summary("omitted")).toMatchObject({ state: "completed", unread: true });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/loaded/list"),
    ).toHaveLength(1);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/resume" && params.threadId === "omitted",
      ),
    ).toHaveLength(1);
  });

  it("hydrates user sessions from durable snapshots before app-server sync", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const statePath = join(directory, "state.json");
    const store = new StateStore(statePath);
    await store.load();
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(
      thread("persistent", "/work", 8, { type: "active", activeFlags: [] }, [
        testTurn("live", "inProgress"),
      ]),
    );
    projection.upsertThread({
      ...thread("fork", "/work", 9),
      sessionId: "fork-tree",
      forkedFromId: "persistent",
    });
    projection.upsertThread(thread("archived", "/work", 7));
    await projection.setArchived("archived", true);
    await store.flushed();

    const reloadedStore = new StateStore(statePath);
    await reloadedStore.load();
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "model/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") throw new RpcError(-32_600, "thread not loaded");
      throw new Error(`Unexpected ${method}`);
    });
    const reloaded = new AppProjection(
      bridge as unknown as CodexBridge,
      reloadedStore,
      new AttentionManager(),
    );

    expect(reloaded.summary("persistent")).toMatchObject({
      state: "running",
      currentTurnId: "live",
      title: "persistent",
    });
    expect(reloaded.summary("archived")?.archived).toBe(true);
    expect(reloaded.summary("fork")?.relation).toEqual({
      kind: "session",
      sessionId: "fork-tree",
      forkedFromId: "persistent",
    });

    await reloaded.sync();

    expect(reloaded.summary("persistent")).toMatchObject({
      state: "running",
      currentTurnId: "live",
    });
    expect(reloaded.summary("archived")?.archived).toBe(true);
    expect(reloaded.summary("fork")?.relation).toEqual({
      kind: "session",
      sessionId: "fork-tree",
      forkedFromId: "persistent",
    });
  });

  it("keeps a user session when app-server closes its in-memory thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 10_000,
      };
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));
    const removed: string[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "thread.removed") removed.push(event.threadId);
    });

    bridge.emit("notification", {
      method: "thread/closed",
      params: { threadId: "one" },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.sessionSnapshot?.currentTurnId).toBeNull(),
    );
    expect(projection.summary("one")).toMatchObject({
      state: "completed",
      unread: true,
      currentTurnId: null,
    });
    expect(removed).toEqual([]);
  });

  it("retries loaded-session recovery after a transient app-server failure", async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
      directories.push(directory);
      const store = new StateStore(join(directory, "state.json"));
      await store.load();
      const bridge = new FakeBridge();
      let loadedReads = 0;
      const omitted = thread("retry", "/work", 6, { type: "notLoaded" });
      const resumed = {
        ...thread("retry", "/work", 6, { type: "active", activeFlags: [] }),
        turns: [testTurn("live", "inProgress")],
      };
      bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/list") {
          return { data: [], nextCursor: null, backwardsCursor: null };
        }
        if (method === "thread/loaded/list") {
          loadedReads += 1;
          if (loadedReads === 1) throw new Error("Thread index is warming up");
          return { data: ["retry"], nextCursor: null };
        }
        if (method === "thread/read" && params.threadId === "retry") {
          return { thread: omitted };
        }
        if (method === "thread/resume" && params.threadId === "retry") {
          return { thread: resumed };
        }
        if (method === "thread/goal/get") return { goal: null };
        if (method === "model/list") return { data: [], nextCursor: null };
        throw new Error(`Unexpected ${method}`);
      });
      const projection = new AppProjection(
        bridge as unknown as CodexBridge,
        store,
        new AttentionManager(),
      );

      await projection.sync();
      expect(projection.summary("retry")).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(projection.summary("retry")).toMatchObject({
        state: "running",
        currentTurnId: "live",
      });
      expect(loadedReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["thread not loaded", "no rollout found for thread id one"])(
    "preserves pending messages during sync when history returns %s",
    async (historyError) => {
      const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
      directories.push(directory);
      const store = new StateStore(join(directory, "state.json"));
      await store.load();
      await store.update((state) => {
        state.threadMeta.one = {
          pinned: false,
          lastReadUpdatedAt: 0,
        };
        state.messageQueues = {
          one: [
            {
              id: "queued",
              threadId: "one",
              text: "Очередь",
              createdAt: 1,
              status: "dispatching",
            },
          ],
        };
      });
      const bridge = new FakeBridge();
      const baseRequest = bridge.request.getMockImplementation()!;
      bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/loaded/list") {
          return { data: [], nextCursor: null };
        }
        if (method === "thread/turns/list" && params.threadId === "one") {
          throw new RpcError(-32_600, historyError);
        }
        return baseRequest(method, params);
      });
      const projection = new AppProjection(
        bridge as unknown as CodexBridge,
        store,
        new AttentionManager(),
      );

      await expect(projection.sync()).resolves.toBeUndefined();

      expect(projection.summary("one")).toMatchObject({ queuedMessageCount: 1 });
      expect(store.snapshot().threadMeta.one).toBeDefined();
      expect(store.snapshot().messageQueues?.one).toEqual([
        expect.objectContaining({ id: "queued", text: "Очередь", status: "dispatching" }),
      ]);
    },
  );

  it("resumes only loaded listed sessions whose status is notLoaded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.idle = {
        pinned: false,
        lastReadUpdatedAt: 4_000,
        lastOutcome: "completed",
        outcomeUpdatedAt: 4_000,
        lastResult: { turnId: "last", completedAt: 4_000 },
        awaitingPlanResponse: false,
      };
    });
    const bridge = new FakeBridge();
    const notLoaded = thread("not-loaded", "/work", 5, { type: "notLoaded" });
    const idle = thread("idle", "/work", 4);
    const resumed = {
      ...thread("not-loaded", "/work", 5, { type: "active", activeFlags: [] }),
      turns: [testTurn("live", "inProgress")],
    };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : [notLoaded, idle],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") {
        return { data: ["not-loaded", "idle"], nextCursor: null };
      }
      if (method === "thread/resume" && params.threadId === "not-loaded") {
        return { thread: resumed };
      }
      if (method === "thread/goal/get" && params.threadId === "not-loaded") {
        return { goal: null };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await projection.sync();

    expect(projection.summary("not-loaded")).toMatchObject({
      state: "running",
      currentTurnId: "live",
    });
    expect(projection.summary("idle")).toMatchObject({ state: "completed", unread: false });
    expect(
      bridge.request.mock.calls
        .filter(([method]) => method === "thread/resume")
        .map(([, params]) => params.threadId),
    ).toEqual(["not-loaded"]);
  });

  it("does not recover loaded internal sessions omitted from thread/list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const execThread = { ...thread("exec", "/work", 3), source: "exec" as const };
    const ephemeralThread = { ...thread("ephemeral", "/work", 4), ephemeral: true };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      if (method === "thread/loaded/list") {
        return { data: ["exec", "ephemeral"], nextCursor: null };
      }
      if (method === "thread/read" && params.threadId === "exec") {
        return { thread: execThread };
      }
      if (method === "thread/read" && params.threadId === "ephemeral") {
        return { thread: ephemeralThread };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await projection.sync();

    expect(projection.summary("exec")).toBeUndefined();
    expect(projection.summary("ephemeral")).toBeUndefined();
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      0,
    );
  });

  it("recovers and retains loaded managed children omitted from thread/list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
        teamOrchestration: {
          tasks: {
            task: {
              id: "task",
              childThreadId: "child",
              title: "Проверить восстановление",
              prompt: "Продолжить работу после рестарта.",
              status: "running",
              createdAt: 1,
              lastActivityAt: 1,
            },
          },
        },
      };
      state.threadMeta.child = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "parent", taskId: "task" },
      };
    });
    const bridge = new FakeBridge();
    const parent = thread("parent", "/work", 2, { type: "notLoaded" });
    const child = {
      ...thread("child", "/work", 3, { type: "active", activeFlags: [] }),
      name: "Проверить восстановление",
    };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : [parent],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") {
        return { data: ["parent", "child"], nextCursor: null };
      }
      if (method === "thread/read" && params.threadId === "child") {
        return { thread: child };
      }
      if (method === "thread/resume" && params.threadId === "parent") {
        return { thread: parent };
      }
      if (method === "thread/resume" && params.threadId === "child") {
        return { thread: child };
      }
      if (method === "thread/goal/get" && params.threadId === "child") {
        return { goal: null };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await projection.sync();

    expect(projection.summary("child")).toMatchObject({
      state: "running",
      relation: {
        kind: "subagent",
        parentThreadId: "parent",
      },
    });
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "child",
      ),
    ).toHaveLength(1);

    await projection.sync();

    expect(projection.summary("child")).toMatchObject({
      state: "running",
      relation: {
        kind: "subagent",
        parentThreadId: "parent",
      },
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/loaded/list"),
    ).toHaveLength(1);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "child",
      ),
    ).toHaveLength(1);
  });

  it("retries persisted managed threads that are temporarily unavailable during sync", async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
      directories.push(directory);
      const store = new StateStore(join(directory, "state.json"));
      await store.load();
      await store.update((state) => {
        state.threadMeta.parent = {
          pinned: false,
          lastReadUpdatedAt: 0,
          teamOrchestration: {
            tasks: {
              task: {
                id: "task",
                childThreadId: "child",
                title: "Продолжить после рестарта",
                prompt: "Восстановить временно отсутствующую задачу.",
                status: "running",
                createdAt: 1,
                lastActivityAt: 1,
              },
            },
          },
        };
        state.threadMeta.child = {
          pinned: false,
          lastReadUpdatedAt: 0,
          managedParent: { parentThreadId: "parent", taskId: "task" },
        };
      });
      const bridge = new FakeBridge();
      const reads = new Map<string, number>();
      bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/list") {
          return { data: [], nextCursor: null, backwardsCursor: null };
        }
        if (method === "thread/loaded/list") return { data: [], nextCursor: null };
        if (method === "thread/read") {
          const threadId = String(params.threadId);
          const count = (reads.get(threadId) ?? 0) + 1;
          reads.set(threadId, count);
          if (count === 1) throw new Error("Thread index is still warming up");
          return {
            thread: {
              ...thread(threadId, "/work", threadId === "parent" ? 2 : 3),
              name: threadId === "parent" ? "Основная сессия" : "Дочерняя сессия",
            },
          };
        }
        if (method === "model/list") return { data: [], nextCursor: null };
        throw new Error(`Unexpected ${method}`);
      });
      const projection = new AppProjection(
        bridge as unknown as CodexBridge,
        store,
        new AttentionManager(),
      );

      await projection.sync();

      expect(projection.summary("parent")).toBeUndefined();
      expect(projection.summary("child")).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(projection.summary("parent")).toMatchObject({
        title: "Основная сессия",
        relation: { kind: "session", sessionId: "parent" },
      });
      expect(projection.summary("child")).toBeUndefined();

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(projection.summary("child")).toMatchObject({
        title: "Дочерняя сессия",
        state: "running",
        relation: { kind: "subagent", parentThreadId: "parent" },
      });
      expect(reads).toEqual(
        new Map([
          ["parent", 2],
          ["child", 2],
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a recovered user parent after its managed metadata is removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      state.threadMeta.child = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "parent", taskId: "task" },
      };
    });
    const bridge = new FakeBridge();
    const parent = thread("parent", "/work", 7, { type: "notLoaded" });
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/read" && params.threadId === "parent") return { thread: parent };
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await projection.sync();

    expect(projection.summary("parent")).toMatchObject({
      id: "parent",
      updatedAt: 7_000,
      relation: { kind: "session", sessionId: "parent" },
    });

    await projection.sync();

    expect(projection.summary("parent")?.id).toBe("parent");
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "parent",
      ),
    ).toHaveLength(2);

    await store.update((state) => {
      delete state.threadMeta.parent;
    });
    await projection.sync();

    expect(projection.summary("parent")?.id).toBe("parent");
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) => method === "thread/read" && params.threadId === "parent",
      ),
    ).toHaveLength(2);
  });

  it("backfills an unnamed subagent from its own first input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const parent = thread("parent", "/work", 2, { type: "notLoaded" });
    const child = {
      ...thread("child", "/work", 3, { type: "notLoaded" }),
      parentThreadId: "parent",
      preview: parent.preview,
      ephemeral: true,
      agentNickname: "reviewer",
      agentRole: "worker",
    };
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/list") {
        return {
          data: params.archived ? [] : [child, parent],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        expect(params).toMatchObject({
          threadId: "child",
          limit: 20,
          sortDirection: "desc",
          itemsView: "full",
        });
        return {
          data: [
            {
              id: "child-turn",
              items: [
                {
                  type: "userMessage",
                  id: "child-input",
                  clientId: null,
                  content: [
                    {
                      type: "text",
                      text: "Проверить восстановление названий старых субагентов",
                      text_elements: [],
                    },
                  ],
                },
              ],
              itemsView: "full",
              status: "completed",
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1_000,
            },
            {
              id: "inherited-parent-turn",
              items: [
                {
                  type: "userMessage",
                  id: "parent-input",
                  clientId: null,
                  content: [
                    {
                      type: "text",
                      text: "Родительская задача, которую нельзя использовать",
                      text_elements: [],
                    },
                  ],
                },
              ],
              itemsView: "full",
              status: "completed",
              error: null,
              startedAt: 0,
              completedAt: 1,
              durationMs: 1_000,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/name/set") return {};
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await projection.sync();

    await vi.waitFor(() =>
      expect(projection.summary("child")?.title).toBe(
        "Проверить восстановление названий старых субагентов",
      ),
    );
    expect(bridge.request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "child",
      name: "Проверить восстановление названий старых субагентов",
    });
  });

  it("returns only one coordinator input and the subagent's own history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      expect(params).toMatchObject({
        threadId: "child",
        cursor: null,
        limit: 20,
        sortDirection: "desc",
        itemsView: "full",
      });
      return {
        data: [
          {
            id: "child-followup",
            items: [
              {
                type: "userMessage",
                id: "child-steer",
                clientId: null,
                content: [{ type: "text", text: "Уточнение от координатора", text_elements: [] }],
              },
              {
                type: "agentMessage",
                id: "child-final",
                text: "Финальный результат субагента",
                phase: "final_answer",
                memoryCitation: null,
              },
            ],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 3,
            completedAt: 4,
            durationMs: 1_000,
          },
          {
            id: "child-task",
            items: [
              {
                type: "userMessage",
                id: "child-input",
                clientId: null,
                content: [
                  {
                    type: "text",
                    text: "Проверить мобильную вёрстку субагента",
                    text_elements: [],
                  },
                ],
              },
              {
                type: "agentMessage",
                id: "child-progress",
                text: "Проверяю мобильную вёрстку",
                phase: "commentary",
                memoryCitation: null,
              },
            ],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 2,
            completedAt: 3,
            durationMs: 1_000,
          },
          {
            id: "inherited-parent",
            items: [
              {
                type: "userMessage",
                id: "parent-input",
                clientId: null,
                content: [
                  { type: "text", text: "Вся история родительской сессии", text_elements: [] },
                ],
              },
              {
                type: "agentMessage",
                id: "parent-answer",
                text: "Старый ответ главного агента",
                phase: "final_answer",
                memoryCitation: null,
              },
            ],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1_000,
          },
        ],
        nextCursor: "parent-history",
        backwardsCursor: null,
      };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread({
      ...thread("child", "/work", 4, { type: "notLoaded" }),
      parentThreadId: "parent",
      ephemeral: true,
      name: "Проверить мобильную вёрстку субагента",
      agentNickname: "reviewer",
      agentRole: "worker",
    });

    const detail = await projection.readThread("child", "stale-parent-cursor");

    expect(detail.olderTurnsCursor).toBeNull();
    expect(detail.turns.map((turn) => turn.id)).toEqual(["child-task", "child-followup"]);
    expect(detail.turns.flatMap((turn) => turn.items.map((item) => item.id))).toEqual([
      "child-input",
      "child-progress",
      "child-final",
    ]);
    expect(
      detail.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage"),
    ).toHaveLength(1);

    projection.upsertThread({
      ...thread("child", "/work", 4, { type: "notLoaded" }),
      parentThreadId: "parent",
      ephemeral: true,
      name: "Несовпадающая задача",
      agentNickname: "reviewer",
      agentRole: "worker",
    });
    expect((await projection.readThread("child")).turns).toEqual([]);
  });

  it("filters managed root-child history and resets incremental reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      state.threadMeta.child = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "parent", taskId: "task" },
      };
    });
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      expect(params).toMatchObject({
        threadId: "child",
        cursor: null,
        limit: 20,
        sortDirection: "desc",
        itemsView: "full",
      });
      return {
        data: [
          {
            id: "child-task",
            items: [
              {
                type: "userMessage",
                id: "child-input-one",
                clientId: null,
                content: [
                  {
                    type: "text",
                    text: "Проверить managed transcript с длинным coordinator prompt",
                    text_elements: [],
                  },
                ],
              },
              {
                type: "userMessage",
                id: "child-input-two",
                clientId: null,
                content: [
                  {
                    type: "text",
                    text: "Проверить managed transcript с длинным coordinator prompt",
                    text_elements: [],
                  },
                ],
              },
              {
                type: "agentMessage",
                id: "child-final",
                text: "Managed transcript исправлен",
                phase: "final_answer",
                memoryCitation: null,
              },
            ],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 2,
            completedAt: 3,
            durationMs: 1_000,
          },
        ],
        nextCursor: "parent-history",
        backwardsCursor: "parent-sync",
      };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread({
      ...thread("child", "/work", 4, { type: "notLoaded" }),
      parentThreadId: null,
      name: "Короткий заголовок",
    });

    const detail = await projection.readThread("child");

    expect(detail.turns.map((turn) => turn.id)).toEqual(["child-task"]);
    expect(detail.turns.flatMap((turn) => turn.items.map((item) => item.id))).toEqual([
      "child-input-one",
      "child-final",
    ]);
    expect(
      detail.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage"),
    ).toHaveLength(1);
    expect(detail.olderTurnsCursor).toBeNull();
    expect(detail).not.toHaveProperty("syncPoint");

    bridge.request.mockClear();
    const history = await projection.readThreadHistory("child", "parent-history", "child-task");
    expect(history).toMatchObject({
      anchorTurnId: "child-task",
      turns: [],
      olderTurnsCursor: null,
    });
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it("sorts sessions only by most recent activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("running", "/work", 10, { type: "active", activeFlags: [] }));
    projection.upsertThread({
      ...thread("blank", "/work", 20),
      preview: "",
      name: null,
    });

    expect(projection.snapshot().threads.map((item) => item.id)).toEqual(["blank", "running"]);
  });

  it("tracks live activity monotonically and batches incremental streamed updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("running", "/work", 10, { type: "active", activeFlags: [] }));
    projection.upsertThread(thread("newer", "/work", 20));
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => events.push(event));
    const now = vi.spyOn(Date, "now").mockReturnValue(30_100);

    try {
      bridge.emit("notification", {
        method: "item/agentMessage/delta",
        params: {
          threadId: "running",
          turnId: "live",
          itemId: "answer",
          delta: "Свежая активность",
        },
      } satisfies ServerNotification);

      expect(projection.snapshot().threads.map((item) => item.id)).toEqual(["running", "newer"]);
      expect(projection.summary("running")?.updatedAt).toBe(30_000);
      expect(
        events.filter(
          (event) => event.type === "thread.upserted" && event.thread?.id === "running",
        ),
      ).toHaveLength(1);

      now.mockReturnValue(30_900);
      bridge.emit("notification", {
        method: "item/agentMessage/delta",
        params: {
          threadId: "running",
          turnId: "live",
          itemId: "answer",
          delta: " продолжается",
        },
      } satisfies ServerNotification);
      expect(
        events.filter(
          (event) => event.type === "thread.upserted" && event.thread?.id === "running",
        ),
      ).toHaveLength(1);

      now.mockReturnValue(31_100);
      bridge.emit("notification", {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "running",
          turnId: "live",
          itemId: "command",
          delta: "output",
        },
      } satisfies ServerNotification);
      expect(projection.summary("running")?.updatedAt).toBe(31_000);
      expect(
        events.filter(
          (event) => event.type === "thread.upserted" && event.thread?.id === "running",
        ),
      ).toHaveLength(2);

      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === "activity.delta")).toHaveLength(2),
      );
      expect(events.filter((event) => event.type === "activity.delta")).toMatchObject([
        {
          threadId: "running",
          turnId: "live",
          itemId: "answer",
          activityType: "agentMessage",
          delta: "Свежая активность продолжается",
        },
        {
          threadId: "running",
          turnId: "live",
          itemId: "command",
          activityType: "command",
          delta: "output",
        },
      ]);
      expect(events.filter((event) => event.type === "turn.replaced")).toHaveLength(0);

      bridge.emit("notification", {
        method: "item/completed",
        params: {
          threadId: "running",
          turnId: "live",
          item: { type: "agentMessage", id: "stale", text: "Старое событие", phase: null },
          completedAtMs: 29_000,
        },
      } satisfies ServerNotification);
      projection.upsertThread(
        thread("running", "/work", 25, {
          type: "active",
          activeFlags: [],
        }),
      );
      expect(projection.summary("running")?.updatedAt).toBe(31_000);

      await store.flushed();
      expect(store.snapshot().threadMeta.running?.sessionSnapshot?.updatedAt).toBe(31);
      expect(bridge.request).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("hides sessions from dismissed project paths and restores them when registered again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.projects.push({
        id: "root",
        displayName: "Root",
        path: "/work",
        createdAt: "x",
        updatedAt: "x",
      });
    });
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("root-thread", "/work/src", 3));
    projection.upsertThread(thread("nested-thread", "/work/nested", 2));
    projection.upsertThread(thread("unrelated", "/other", 1));

    await store.update((state) => {
      state.projects = [];
      state.dismissedProjectPaths = ["/work"];
    });
    projection.removeProject("root");
    expect(projection.snapshot().threads.map((item) => item.id)).toEqual(["unrelated"]);

    await store.update((state) => {
      state.projects.push({
        id: "nested",
        displayName: "Nested",
        path: "/work/nested",
        createdAt: "x",
        updatedAt: "x",
      });
    });
    projection.publishProject("nested");
    expect(projection.snapshot().threads.map((item) => item.id)).toEqual([
      "nested-thread",
      "unrelated",
    ]);

    await store.update((state) => {
      state.projects.push({
        id: "restored",
        displayName: "Root",
        path: "/work",
        createdAt: "y",
        updatedAt: "y",
      });
      delete state.dismissedProjectPaths;
    });
    projection.publishProject("restored");
    expect(projection.snapshot().threads.map((item) => item.id)).toEqual([
      "root-thread",
      "nested-thread",
      "unrelated",
    ]);
    expect(projection.snapshot().threads.find((item) => item.id === "root-thread")?.projectId).toBe(
      "restored",
    );

    await store.update((state) => {
      state.projects = state.projects.filter((project) => project.id !== "nested");
      state.dismissedProjectPaths = ["/work/nested"];
    });
    projection.removeProject("nested");
    expect(projection.snapshot().threads.map((item) => item.id)).toEqual([
      "root-thread",
      "unrelated",
    ]);
  });

  it("only clears a completed session through its observed update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 10_000,
      };
    });
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));

    expect(projection.summary("one")).toMatchObject({
      state: "completed",
      unread: true,
      unseen: true,
    });

    await projection.markViewed("one", 5_000);
    expect(projection.summary("one")).toMatchObject({ unread: true, unseen: true });

    await projection.markRead("one", 5_000);
    expect(projection.summary("one")?.unread).toBe(true);

    await projection.markViewed("one", 10_000);
    expect(projection.summary("one")).toMatchObject({ unread: true, unseen: false });

    await projection.markRead("one", 10_000);
    expect(projection.summary("one")).toMatchObject({ unread: false, unseen: false });

    projection.upsertThread(thread("one", "/work", 11));
    expect(projection.summary("one")).toMatchObject({
      state: "completed",
      unread: true,
      unseen: true,
    });
  });

  it("paginates exact thread count, reconciles outcomes once, and updates live terminal state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.projects.push({
        id: "root",
        displayName: "Root",
        path: "/work",
        createdAt: "x",
        updatedAt: "x",
      });
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 5_000,
        settings: {
          collaborationMode: "default",
          sandboxMode: "read-only",
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
        } as never,
      };
      state.projects.push({
        id: "nested",
        displayName: "Nested",
        path: "/work/nested",
        createdAt: "x",
        updatedAt: "x",
      });
    });
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    await projection.sync();
    expect(projection.threadCount).toBe(2);
    expect(
      bridge.request.mock.calls.find(([method]) => method === "thread/list")?.[1],
    ).toMatchObject({
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown", "subAgentThreadSpawn"],
    });
    expect(projection.summary("two")?.projectId).toBe("nested");
    expect(projection.summary("two")?.settings).toEqual({ collaborationMode: "default" });
    expect(projection.summary("one")?.settings).toEqual({
      collaborationMode: "default",
    });
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: false });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
    ).toHaveLength(2);
    await projection.sync();
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
    ).toHaveLength(2);

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    projection.on("event", (_sequence, event) => events.push(event));
    const goal = {
      threadId: "one",
      objective: "Довести задачу до конца",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 42,
      timeUsedSeconds: 7,
      createdAt: 1,
      updatedAt: 2,
    };
    bridge.emit("notification", {
      method: "thread/goal/updated",
      params: { threadId: "one", turnId: null, goal },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "thread/goal/cleared",
      params: { threadId: "one" },
    } satisfies ServerNotification);
    expect(events.filter((event) => event.type === "goal.changed").slice(-2)).toEqual([
      { type: "goal.changed", threadId: "one", goal },
      { type: "goal.changed", threadId: "one", goal: null },
    ]);
    bridge.emit("notification", {
      method: "turn/started",
      params: {
        threadId: "one",
        turn: {
          id: "live",
          items: [],
          itemsView: "summary",
          status: "inProgress",
          error: null,
          startedAt: 123,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    expect(projection.summary("one")?.state).toBe("running");
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "live",
        explanation: "Проверяем",
        plan: [
          { step: "Первый", status: "completed" },
          { step: "Второй", status: "inProgress" },
        ],
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/diff/updated",
      params: {
        threadId: "one",
        turnId: "live",
        diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new",
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "turn.progressed").at(-1)).toMatchObject({
        progress: {
          startedAt: 123_000,
          explanation: "Проверяем",
          steps: [
            { step: "Первый", status: "completed" },
            { step: "Второй", status: "inProgress" },
          ],
          filesChanged: 1,
          additions: 1,
          deletions: 1,
        },
      }),
    );
    await projection.setCurrentTurn("one", "steered");
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          id: "live",
          items: [],
          itemsView: "summary",
          status: "interrupted",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "steered",
    });
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          id: "steered",
          items: [],
          itemsView: "summary",
          status: "failed",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(projection.summary("one")).toMatchObject({ state: "failed", unread: true }),
    );
    await store.flushed();
  });

  it("keeps an active turn running across a transient idle status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    projection.on("event", (_sequence, event) => events.push(event));
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("first", "inProgress") },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "one", status: { type: "idle" } },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "first",
        itemId: "continuation",
        delta: "Продолжаю работу",
      },
    } satisfies ServerNotification);

    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "first",
      unread: false,
    });
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "activity.delta").at(-1)).toMatchObject({
        threadId: "one",
        turnId: "first",
        itemId: "continuation",
        activityType: "agentMessage",
        delta: "Продолжаю работу",
      }),
    );

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("first", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(projection.summary("one")).toMatchObject({
        state: "completed",
        currentTurnId: null,
        unread: true,
      }),
    );
    await store.flushed();
  });

  it.each([true, false, undefined])(
    "restores a turn with isBlocking=%s and keeps it running after the answer",
    async (isBlocking) => {
      const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
      directories.push(directory);
      const store = new StateStore(join(directory, "state.json"));
      await store.load();
      const attention = new AttentionManager();
      const projection = new AppProjection(
        new FakeBridge() as unknown as CodexBridge,
        store,
        attention,
      );
      projection.upsertThread(thread("one", "/work", 10, { type: "active", activeFlags: [] }, []));

      const request = attention.receive(
        {
          method: "item/tool/requestUserInput",
          id: 7,
          params: {
            threadId: "one",
            turnId: "question-turn",
            itemId: "question",
            autoResolutionMs: null,
            ...(isBlocking === undefined ? {} : { isBlocking }),
            questions: [],
          },
        } as ServerRequest,
        {
          respond: vi.fn(),
          respondError: vi.fn(),
        } as unknown as JsonlTransport,
      );
      expect(projection.summary("one")).toMatchObject({
        state: "needsAttention",
        currentTurnId: "question-turn",
        unread: false,
      });

      attention.resolve(request.id, { kind: "userInput", answers: {} });
      expect(projection.summary("one")).toMatchObject({
        state: "running",
        currentTurnId: "question-turn",
        unread: false,
      });
    },
  );

  it.each(["answer", "expire", "rpc"] as const)(
    "updates only the question's session among 1000 others on %s",
    async (removal) => {
      const { attention, projection, bridge, receive, events, store } =
        await createUserInputLifecycleHarness(1000);
      const first = receive();
      const second = receive();
      events.length = 0;

      if (removal === "answer")
        attention.resolve(first.id, { kind: "userInput", answers: { choice: ["First"] } });
      else if (removal === "expire") attention.expire(first.id);
      else attention.expireByRpcId(900);

      expect(events).toEqual([
        { type: "attention.removed", attentionId: first.id },
        {
          type: "thread.upserted",
          thread: expect.objectContaining({ id: "one", state: "needsAttention" }),
        },
      ]);
      expect(projection.summary("one")?.state).toBe("needsAttention");
      events.length = 0;
      attention.expire(second.id);
      expect(events).toEqual([
        { type: "attention.removed", attentionId: second.id },
        {
          type: "thread.upserted",
          thread: expect.objectContaining({ id: "one", state: "running" }),
        },
      ]);
      expect(bridge.request).not.toHaveBeenCalled();
      await store.flushed();
    },
  );

  it("updates only sessions with retired requests when clearing all attention", async () => {
    const { attention, projection, receive, events, store } =
      await createUserInputLifecycleHarness(1000);
    const first = receive();
    const second = receive("other-turn", "unrelated-0");
    const global = attention.receive(
      { id: 1001, method: "future/globalRequest", params: {} } as unknown as ServerRequest,
      { respondError: vi.fn() } as unknown as JsonlTransport,
    );
    expect(global.threadId).toBeNull();
    events.length = 0;

    attention.expireAll();

    expect(events).toEqual([
      { type: "attention.removed", attentionId: first.id },
      {
        type: "thread.upserted",
        thread: expect.objectContaining({ id: "one", state: "running" }),
      },
      { type: "attention.removed", attentionId: second.id },
      {
        type: "thread.upserted",
        thread: expect.objectContaining({ id: "unrelated-0", state: "running" }),
      },
      { type: "attention.removed", attentionId: global.id },
    ]);
    expect(projection.snapshot().attention).toEqual([]);
    await store.flushed();
  });

  it.each(["completed", "failed", "interrupted", "stop"] as const)(
    "retires questions on %s and rejects late requests without answering them",
    async (outcome) => {
      const { store, bridge, attention, projection, transport, receive, events } =
        await createUserInputLifecycleHarness();
      const request = receive();
      await projection.updateUserInputDraft(request, {
        answers: { choice: ["Unsent answer"] },
        currentQuestionId: "choice",
      });
      if (outcome === "stop") {
        await projection.markInterrupted("one", ["question-turn"]);
      } else {
        bridge.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "one",
            turn: { ...testTurn("question-turn", "completed"), status: outcome },
          },
        } satisfies ServerNotification);
      }
      // This can race the asynchronous draft cleanup in turn/completed.
      const racing = receive();
      expect(attention.get(racing.id)).toBeUndefined();
      await vi.waitFor(() => expect(projection.summary("one")?.currentTurnId).toBeNull());
      expect(attention.get(request.id)).toBeUndefined();
      expect(store.view().threadMeta.one?.userInputDrafts).toBeUndefined();
      expect(events).toContainEqual({ type: "attention.removed", attentionId: request.id });

      bridge.emit("notification", {
        method: "turn/started",
        params: { threadId: "one", turn: testTurn("new-turn", "inProgress") },
      } satisfies ServerNotification);
      const newer = receive("new-turn");
      const late = receive();
      bridge.emit("notification", {
        method: "turn/started",
        params: { threadId: "one", turn: testTurn("question-turn", "inProgress") },
      } satisfies ServerNotification);
      expect(attention.list()).toEqual([newer]);
      expect(projection.summary("one")).toMatchObject({
        currentTurnId: "new-turn",
        state: "needsAttention",
      });
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: "attention.upserted",
          attention: expect.objectContaining({ id: late.id }),
        }),
      );
      expect(transport.respond).not.toHaveBeenCalled();
      expect(transport.respondError).not.toHaveBeenCalled();
      expect(bridge.request).not.toHaveBeenCalled();
      expect(store.view().threadMeta.one?.timelineArtifacts).toBeUndefined();
      await store.flushed();
    },
  );

  it.each(["notification", "stop"] as const)(
    "a late %s only retires questions belonging to the old turn",
    async (source) => {
      const { store, bridge, attention, projection, transport, receive } =
        await createUserInputLifecycleHarness();
      const old = receive();
      const other = receive("question-turn", "two");
      const newer = receive("new-turn");
      await projection.updateUserInputDraft(newer, {
        answers: { choice: ["Keep this draft"] },
        currentQuestionId: "choice",
      });
      if (source === "stop") {
        await projection.markInterrupted("one", ["question-turn"]);
      } else {
        bridge.emit("notification", {
          method: "turn/completed",
          params: { threadId: "one", turn: testTurn("question-turn", "completed") },
        } satisfies ServerNotification);
      }
      await vi.waitFor(() => expect(attention.get(old.id)).toBeUndefined());
      expect(attention.list()).toEqual([other, newer]);
      expect(projection.summary("one")?.currentTurnId).toBe("new-turn");
      expect(Object.values(store.view().threadMeta.one?.userInputDrafts ?? {})).toMatchObject([
        { turnId: "new-turn", answers: { choice: ["Keep this draft"] } },
      ]);
      expect(transport.respond).not.toHaveBeenCalled();
      expect(bridge.request).not.toHaveBeenCalled();
      await store.flushed();
    },
  );

  it("cleans up historical questions while preserving active and unloaded turns", async () => {
    const { store, bridge, attention, projection, receive } =
      await createUserInputLifecycleHarness();
    const old = receive();
    await projection.updateUserInputDraft(old, {
      answers: { choice: ["Old draft"] },
      currentQuestionId: "choice",
    });
    const unloaded = receive("unloaded-turn");
    const newer = receive("new-turn");
    bridge.request.mockImplementation(async (method) => {
      if (method === "thread/resume") {
        return {
          thread: thread("one", "/work", 5, { type: "active", activeFlags: [] }, [
            testTurn("new-turn", "inProgress"),
          ]),
        };
      }
      if (method === "thread/turns/list") {
        return {
          data: [testTurn("new-turn", "inProgress"), testTurn("question-turn", "completed")],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected ${method}`);
    });

    const detail = await projection.readThread("one");
    expect(detail.summary.currentTurnId).toBe("new-turn");
    expect(attention.list()).toEqual([unloaded, newer]);
    expect(store.view().threadMeta.one?.userInputDrafts).toBeUndefined();
    const replayed = receive();
    expect(attention.get(replayed.id)).toBeUndefined();
    await projection.readThread("one");
    expect(attention.list()).toEqual([unloaded, newer]);
    expect(bridge.request).toHaveBeenCalledTimes(2);
    await store.flushed();
  });

  it("retires replayed questions during connection recovery", async () => {
    const { store, bridge, attention, projection, receive } =
      await createUserInputLifecycleHarness();
    const request = receive();
    await projection.updateUserInputDraft(request, {
      answers: { choice: ["Old draft"] },
      currentQuestionId: "choice",
    });
    bridge.request.mockImplementation(async (method, params) => {
      if (method === "thread/list")
        return {
          data: params.archived
            ? []
            : [thread("one", "/work", 10, { type: "active", activeFlags: [] })],
          nextCursor: null,
          backwardsCursor: null,
        };
      if (method === "thread/loaded/list" || method === "model/list")
        return { data: [], nextCursor: null };
      if (method === "thread/goal/get") return { goal: null };
      if (method === "thread/resume")
        return {
          thread: thread("one", "/work", 10, { type: "idle" }, [
            testTurn("question-turn", "completed"),
          ]),
        };
      throw new Error(`Unexpected ${method}`);
    });
    await projection.sync();
    expect(attention.list()).toEqual([]);
    expect(store.view().threadMeta.one?.userInputDrafts).toBeUndefined();
    expect(attention.get(receive().id)).toBeUndefined();
    expect(bridge.request.mock.calls.some(([method]) => method === "thread/turns/list")).toBe(
      false,
    );
    await store.flushed();
  });

  it("persists, enriches, reattaches, fingerprints, and cleans up user-input drafts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const store = new StateStore(path);
    await store.load();
    const bridge = new FakeBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    projection.upsertThread(thread("one", "/work", 10, { type: "active", activeFlags: [] }, []));
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => events.push(event));
    const request = attention.receive(userInputServerRequest(701), {
      respond: vi.fn(),
      respondError: vi.fn(),
    } as unknown as JsonlTransport);
    if (request.kind !== "userInput") throw new Error("Expected user input");
    const initial = projection
      .snapshot()
      .attention.find((candidate) => candidate.id === request.id);
    if (initial?.kind !== "userInput") throw new Error("Expected enriched user input");
    const clientMessageId = initial.clientMessageId;
    expect(clientMessageId).toMatch(/^user-input:[a-f0-9]{64}$/);
    expect(events.findLast((event) => event.type === "attention.upserted")).toMatchObject({
      attention: { id: request.id, draft: null, clientMessageId },
    });

    await expect(
      projection.updateUserInputDraft(request, {
        answers: { choice: ["First"] },
        currentQuestionId: "choice",
      }),
    ).resolves.toMatchObject({ revision: 1 });
    const second = await projection.updateUserInputDraft(request, {
      answers: { choice: ["Second"] },
      currentQuestionId: null,
    });
    expect(second).toMatchObject({
      answers: { choice: ["Second"] },
      currentQuestionId: null,
      revision: 2,
    });
    expect(projection.snapshot().attention).toMatchObject([
      { id: request.id, draft: { answers: { choice: ["Second"] }, revision: 2 }, clientMessageId },
    ]);
    expect(events.findLast((event) => event.type === "attention.upserted")).toMatchObject({
      attention: { id: request.id, draft: { revision: 2 } },
    });

    attention.expireAll();
    expect(Object.values(store.snapshot().threadMeta.one?.userInputDrafts ?? {})).toMatchObject([
      { revision: 2 },
    ]);
    await store.flushed();

    const reloadedStore = new StateStore(path);
    await reloadedStore.load();
    const replayBridge = new FakeBridge();
    const replayAttention = new AttentionManager();
    const replayProjection = new AppProjection(
      replayBridge as unknown as CodexBridge,
      reloadedStore,
      replayAttention,
    );
    replayProjection.upsertThread(
      thread("one", "/work", 10, { type: "active", activeFlags: [] }, []),
    );
    const replayed = replayAttention.receive(userInputServerRequest(702), {
      respond: vi.fn(),
      respondError: vi.fn(),
    } as unknown as JsonlTransport);
    if (replayed.kind !== "userInput") throw new Error("Expected user input");
    expect(replayProjection.snapshot().attention).toMatchObject([
      { id: replayed.id, draft: { answers: { choice: ["Second"] }, revision: 2 }, clientMessageId },
    ]);

    const mismatchAttention = new AttentionManager();
    const mismatchProjection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      reloadedStore,
      mismatchAttention,
    );
    mismatchProjection.upsertThread(thread("one", "/work", 10));
    mismatchAttention.receive(userInputServerRequest(703, "Changed descriptor"), {
      respond: vi.fn(),
      respondError: vi.fn(),
    } as unknown as JsonlTransport);
    expect(mismatchProjection.snapshot().attention).toMatchObject([{ draft: null }]);
    await vi.waitFor(() =>
      expect(reloadedStore.snapshot().threadMeta.one?.userInputDrafts).toBeUndefined(),
    );

    const response = { kind: "userInput" as const, answers: { choice: ["Final"] } };
    expect(replayAttention.resolve(replayed.id, response)).toBe(replayed);
    await replayProjection.recordAttentionResponse(replayed, response);
    expect(reloadedStore.snapshot().threadMeta.one?.userInputDrafts).toBeUndefined();

    const externallyResolved = replayAttention.receive(userInputServerRequest(704), {
      respond: vi.fn(),
      respondError: vi.fn(),
    } as unknown as JsonlTransport);
    if (externallyResolved.kind !== "userInput") throw new Error("Expected user input");
    await replayProjection.updateUserInputDraft(externallyResolved, {
      answers: { choice: ["External"] },
      currentQuestionId: "choice",
    });
    replayBridge.emit("notification", {
      method: "serverRequest/resolved",
      params: { requestId: 704 },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(reloadedStore.snapshot().threadMeta.one?.userInputDrafts).toBeUndefined(),
    );

    const completed = replayAttention.receive(userInputServerRequest(705), {
      respond: vi.fn(),
      respondError: vi.fn(),
    } as unknown as JsonlTransport);
    if (completed.kind !== "userInput") throw new Error("Expected user input");
    await replayProjection.updateUserInputDraft(completed, {
      answers: { choice: ["Turn"] },
      currentQuestionId: null,
    });
    replayBridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("question-turn", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(reloadedStore.snapshot().threadMeta.one?.userInputDrafts).toBeUndefined(),
    );

    const deleted = replayAttention.receive(
      userInputServerRequest(706, "Which one?", "next-turn"),
      {
        respond: vi.fn(),
        respondError: vi.fn(),
      } as unknown as JsonlTransport,
    );
    if (deleted.kind !== "userInput") throw new Error("Expected user input");
    await replayProjection.updateUserInputDraft(deleted, {
      answers: { choice: ["Delete"] },
      currentQuestionId: null,
    });
    await replayProjection.removeOrphanedThread("one");
    expect(reloadedStore.snapshot().threadMeta.one).toBeUndefined();
  });

  it("keeps an active goal running between turns and releases terminal state when stopped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", goalNotification("active"));
    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("first", "inProgress") },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("first", "completed") },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(projection.summary("one")).toMatchObject({
        state: "running",
        currentTurnId: null,
        unread: false,
      }),
    );

    bridge.emit("notification", goalNotification("paused", 3));
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: true });

    bridge.emit("notification", goalNotification("active", 4));
    expect(projection.summary("one")).toMatchObject({ state: "running", unread: false });

    bridge.emit("notification", {
      method: "thread/goal/cleared",
      params: { threadId: "one" },
    } satisfies ServerNotification);
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: true });
    await store.flushed();
  });

  it("publishes completion only after both the final turn and goal complete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", goalNotification("active"));
    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("goal-first", "inProgress") },
    } satisfies ServerNotification);
    bridge.emit("notification", goalNotification("complete", 3));
    expect(projection.summary("one")?.state).toBe("running");

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("goal-first", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")?.state).toBe("completed"));

    bridge.emit("notification", goalNotification("active", 4));
    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("turn-first", "inProgress") },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("turn-first", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")?.state).toBe("running"));

    bridge.emit("notification", goalNotification("complete", 5));
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: true });
    await store.flushed();
  });

  it("fails immediately when an active thread reports a system error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));
    bridge.emit("notification", goalNotification("active"));
    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("first", "inProgress") },
    } satisfies ServerNotification);

    bridge.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "one", status: { type: "systemError" } },
    } satisfies ServerNotification);

    expect(projection.summary("one")).toMatchObject({
      state: "failed",
      currentTurnId: null,
    });
  });

  it("persists chronological plan checklists and marks a finished plan for attention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const statePath = join(directory, "state.json");
    const store = new StateStore(statePath);
    await store.load();
    const bridge = new FakeBridge();
    const historicalTurn = {
      id: "plan-turn",
      items: [
        {
          type: "userMessage" as const,
          id: "question-tool",
          clientId: null,
          content: [{ type: "text" as const, text: "Вопрос", text_elements: [] }],
        },
        {
          type: "agentMessage" as const,
          id: "progress-message",
          text: "Перехожу к следующему шагу",
          phase: "commentary" as const,
          memoryCitation: null,
        },
        { type: "plan" as const, id: "final-plan", text: "Готовый план" },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
      error: null,
      startedAt: 10,
      completedAt: 20,
      durationMs: 10_000,
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [historicalTurn], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));
    await projection.setSettings("one", { collaborationMode: "plan" });

    bridge.emit("notification", {
      method: "turn/started",
      params: {
        threadId: "one",
        turn: { ...historicalTurn, items: [], status: "inProgress", completedAt: null },
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "plan-turn",
        item: historicalTurn.items[0],
        completedAtMs: 10_100,
      },
    } as ServerNotification);
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "plan-turn",
        explanation: "Проверяю решение",
        plan: [
          { step: "Исследовать", status: "inProgress" },
          { step: "Составить план", status: "pending" },
        ],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.["plan-turn"]).toHaveLength(1),
    );
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "plan-turn",
        item: historicalTurn.items[1],
        completedAtMs: 10_150,
      },
    } as ServerNotification);
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "plan-turn",
        explanation: "Составляю итоговый план",
        plan: [
          { step: "Исследовать", status: "completed" },
          { step: "Составить план", status: "inProgress" },
        ],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.["plan-turn"]).toHaveLength(2),
    );

    await projection.recordAttentionResponse(
      {
        id: "attention-1",
        kind: "userInput",
        threadId: "one",
        turnId: "plan-turn",
        itemId: "question-tool",
        createdAt: 10_200,
        autoResolutionMs: null,
        questions: [
          {
            id: "token",
            header: "Токен",
            question: "Какое значение?",
            isOther: true,
            isSecret: true,
            options: null,
          },
        ],
      },
      { kind: "userInput", answers: { token: ["secret-value"] } },
    );
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: historicalTurn },
    } satisfies ServerNotification);

    await vi.waitFor(() => expect(projection.summary("one")?.state).toBe("needsAttention"));
    const artifacts = store.snapshot().threadMeta.one?.timelineArtifacts?.["plan-turn"] ?? [];
    expect(artifacts).toMatchObject([
      {
        type: "planChecklist",
        status: "completed",
        afterItemId: "question-tool",
        steps: [
          { step: "Исследовать", status: "inProgress" },
          { step: "Составить план", status: "pending" },
        ],
      },
      {
        type: "planChecklist",
        status: "completed",
        afterItemId: "progress-message",
        steps: [
          { step: "Исследовать", status: "completed" },
          { step: "Составить план", status: "inProgress" },
        ],
      },
      {
        type: "userInputResponse",
        entries: [{ question: "Какое значение?", answers: ["secret-value"] }],
      },
    ]);
    const checklistIds = artifacts
      .filter((item) => item.type === "planChecklist")
      .map((item) => item.id);
    expect(new Set(checklistIds).size).toBe(2);

    const detail = await projection.readThread("one");
    expect(detail.turns[0]?.items.map((item) => item.id)).toEqual([
      "question-tool",
      checklistIds[0],
      "progress-message",
      checklistIds[1],
      "question-tool-response",
      "final-plan",
    ]);
    const reloadedStore = new StateStore(statePath);
    await reloadedStore.load();
    expect(reloadedStore.snapshot().threadMeta.one?.timelineArtifacts?.["plan-turn"]).toMatchObject(
      [
        { type: "planChecklist", id: checklistIds[0] },
        { type: "planChecklist", id: checklistIds[1] },
        { entries: [{ answers: ["secret-value"] }] },
      ],
    );

    await projection.setCurrentTurn("one", "implementation-turn");
    expect(projection.summary("one")?.state).toBe("running");
    expect(store.snapshot().threadMeta.one?.awaitingPlanResponse).toBe(false);
  });

  it("uses only the latest checklist to detect an incomplete successful turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "one", turn: testTurn("finished-plan", "inProgress") },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "finished-plan",
        explanation: "Начинаю",
        plan: [
          { step: "Первый", status: "inProgress" },
          { step: "Второй", status: "pending" },
        ],
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "finished-plan",
        explanation: "Готово",
        plan: [
          { step: "Первый", status: "completed" },
          { step: "Второй", status: "completed" },
        ],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.["finished-plan"]).toHaveLength(2),
    );
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("finished-plan", "completed") },
    } satisfies ServerNotification);

    await vi.waitFor(() => {
      expect(projection.summary("one")?.state).toBe("completed");
      expect(store.snapshot().threadMeta.one?.awaitingPlanResponse).toBe(false);
    });

    await projection.setCurrentTurn("one", "unfinished-plan");
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "unfinished-plan",
        explanation: "Нужно решение",
        plan: [
          { step: "Первый", status: "completed" },
          { step: "Второй", status: "inProgress" },
          { step: "Третий", status: "pending" },
        ],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.["unfinished-plan"]).toHaveLength(
        1,
      ),
    );
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("unfinished-plan", "completed") },
    } satisfies ServerNotification);

    await vi.waitFor(() => expect(projection.summary("one")?.state).toBe("needsAttention"));
    expect(projection.summary("one")?.currentTurnId).toBeNull();
    expect(store.snapshot().threadMeta.one?.awaitingPlanResponse).toBe(true);
  });

  it.each(["failed", "interrupted"] as const)(
    "keeps the %s outcome when its latest checklist is incomplete",
    async (outcome) => {
      const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
      directories.push(directory);
      const store = new StateStore(join(directory, "state.json"));
      await store.load();
      const bridge = new FakeBridge();
      const projection = new AppProjection(
        bridge as unknown as CodexBridge,
        store,
        new AttentionManager(),
      );
      projection.upsertThread(thread("one", "/work", 10));
      await projection.setCurrentTurn("one", `${outcome}-plan`);
      bridge.emit("notification", {
        method: "turn/plan/updated",
        params: {
          threadId: "one",
          turnId: `${outcome}-plan`,
          explanation: "Не закончено",
          plan: [{ step: "Проверить", status: "inProgress" }],
        },
      } satisfies ServerNotification);
      await vi.waitFor(() =>
        expect(
          store.snapshot().threadMeta.one?.timelineArtifacts?.[`${outcome}-plan`],
        ).toHaveLength(1),
      );
      bridge.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: "one",
          turn: { ...testTurn(`${outcome}-plan`, "completed"), status: outcome },
        },
      } satisfies ServerNotification);

      await vi.waitFor(() => {
        expect(projection.summary("one")?.state).toBe(outcome);
        expect(store.snapshot().threadMeta.one?.awaitingPlanResponse).toBe(false);
      });
    },
  );

  it("does not report a phantom active thread without an in-progress turn as running", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const projection = new AppProjection(
      new FakeBridge() as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    const value = projection.upsertThread(
      thread("phantom", "/work", 10, { type: "active", activeFlags: [] }, []),
    );
    expect(value.currentTurnId).toBeNull();
    expect(value.state).not.toBe("running");
  });

  it("restores a newer active turn from an authoritative history page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 3_000,
      };
    });
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") return { thread: liveThread() };
      if (method === "thread/turns/list") {
        return {
          data: [{ ...testTurn("live", "inProgress"), startedAt: 3 }],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 3));

    const detail = await projection.readThread("one");

    expect(detail.summary).toMatchObject({
      state: "running",
      currentTurnId: "live",
      unread: false,
    });
    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "live",
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      1,
    );
  });

  it.each([false, true])(
    "advances a stale active turn from history without interrupting it (refresh=%s)",
    async (refresh) => {
      const { bridge, projection } = await searchHarness();
      const old = testTurn("old-turn", "inProgress");
      projection.upsertThread(
        thread("one", "/work", 3, { type: "active", activeFlags: [] }, [old]),
      );
      bridge.request.mockImplementation(async (method) => {
        if (method === "thread/read") return { thread: thread("one", "/work", 3) };
        if (method === "thread/resume") return { thread: liveThread() };
        if (method === "thread/turns/list") {
          return {
            data: [...liveThread().turns, testTurn("old-turn", "completed")],
            nextCursor: null,
            backwardsCursor: null,
          };
        }
        throw new Error(`Unexpected ${method}`);
      });

      if (refresh) await projection.refreshThread("one", { requireFresh: true });
      const detail = await projection.readThread("one", { refresh });

      expect(detail.summary).toMatchObject({ state: "running", currentTurnId: "live" });
      expect(detail.turns.at(-1)?.items).toContainEqual(
        expect.objectContaining({ type: "agentMessage", text: "В процессе" }),
      );
      await projection.readThread("one");
      expect(
        bridge.request.mock.calls.filter(([method]) => method === "thread/resume"),
      ).toHaveLength(1);
    },
  );

  it("rejoins an open chat after a disconnect and restores its pending question and live text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-rejoin-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge(true);
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    bridge.emit("state", "unavailable");
    bridge.emit("state", "ready");
    const request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, params) => {
      if (method === "thread/resume") {
        bridge.emit("notification", {
          method: "turn/started",
          params: { threadId: "one", turn: liveThread().turns[0]! },
        } satisfies ServerNotification);
        attention.receive(userInputServerRequest(501, "Continue?", "live"), {
          respond: vi.fn(),
          respondError: vi.fn(),
        } as unknown as JsonlTransport);
      }
      return request(method, params);
    });

    const detail = await projection.readThread("one", { refresh: true });

    expect(detail.summary).toMatchObject({ currentTurnId: "live", state: "needsAttention" });
    expect(detail.turns[0]?.items).toContainEqual(
      expect.objectContaining({ type: "agentMessage", text: "В процессе" }),
    );
    expect(projection.snapshot().attention).toEqual([
      expect.objectContaining({ turnId: "live", itemId: "question-item" }),
    ]);
    await projection.readThread("one");
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      2,
    );
  });

  it.each(["completed", "failed", "interrupted"] as const)(
    "recovers a missed %s completion from history and persists it once",
    async (status) => {
      const { store, bridge, projection, events } = await createCompletionRecoveryHarness(status);

      const detail = await projection.readThread("one");

      expect(detail.summary).toMatchObject({
        state: status,
        currentTurnId: null,
        updatedAt: 6_000,
      });
      expect(detail.turns[0]).toMatchObject({
        id: "live",
        status,
        completedAt: 6_000,
        durationMs: 5_000,
        items: [expect.objectContaining({ id: "answer", text: "Finished" })],
      });
      expect(store.view().threadMeta.one).toMatchObject({
        lastOutcome: status,
        outcomeUpdatedAt: 6_000,
        sessionSnapshot: { currentTurnId: null },
      });
      expect(events.filter((event) => event.type === "turn.replaced")).toHaveLength(1);
      await projection.readThread("one");
      expect(
        bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.replaced")).toHaveLength(1);

      const reloadedStore = new StateStore(store.path);
      await reloadedStore.load();
      const reloaded = new AppProjection(
        bridge as unknown as CodexBridge,
        reloadedStore,
        new AttentionManager(),
      );
      expect(reloaded.summary("one")).toMatchObject({ state: status, currentTurnId: null });
    },
  );

  it("recovers completion from resume even when an idle notification changes the sync revision", async () => {
    const { store, bridge, projection, terminal } = await createCompletionRecoveryHarness();
    const original = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, params) => {
      if (method === "thread/resume") {
        bridge.emit("notification", {
          method: "thread/status/changed",
          params: { threadId: "one", status: { type: "idle" } },
        } satisfies ServerNotification);
        return { thread: thread("one", "/work", 6, { type: "idle" }, [terminal]) };
      }
      return original(method, params);
    });

    await projection.sync();

    expect(projection.summary("one")).toMatchObject({ state: "completed", currentTurnId: null });
    expect(store.view().threadMeta.one?.sessionSnapshot?.currentTurnId).toBeNull();
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
    ).toHaveLength(0);
  });

  it("keeps resumed thread metadata when recovering its completed turn", async () => {
    const { bridge, projection } = await createCompletionRecoveryHarness();
    const original = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === "thread/resume" && "thread" in result) {
        result.thread.path = "/work/resumed-history.jsonl";
      }
      return result;
    });

    await projection.sync();

    expect(projection.summary("one")).toMatchObject({ state: "completed", currentTurnId: null });
    expect(projection.rolloutPath("one")).toBe("/work/resumed-history.jsonl");
  });

  it("checks only unresolved saved active turns when recovery has no turn payload", async () => {
    const { bridge, projection } = await createCompletionRecoveryHarness();
    const original = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, params) => {
      if (method === "thread/resume") {
        return { thread: thread("one", "/work", 5, { type: "active", activeFlags: [] }) };
      }
      return original(method, params);
    });

    await projection.sync();

    expect(projection.summary("one")).toMatchObject({ state: "completed", currentTurnId: null });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list")).toEqual([
      [
        "thread/turns/list",
        { threadId: "one", limit: 1, sortDirection: "desc", itemsView: "full" },
        30_000,
      ],
    ]);
  });

  it.each(["history", "resume"] as const)(
    "does not clear a new turn when an old completion arrives from %s",
    async (source) => {
      const { store, bridge, projection } = await createCompletionRecoveryHarness();
      const original = bridge.request.getMockImplementation()!;
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      bridge.request.mockImplementation(async (method, params) => {
        if (method === (source === "history" ? "thread/turns/list" : "thread/resume")) {
          entered();
          await gate;
        }
        return original(method, params);
      });
      const reading = source === "history" ? projection.readThread("one") : projection.sync();
      await started;
      bridge.emit("notification", {
        method: "turn/started",
        params: { threadId: "one", turn: testTurn("next", "inProgress") },
      } satisfies ServerNotification);
      await vi.waitFor(() => expect(projection.summary("one")?.currentTurnId).toBe("next"));
      release();
      // A history read invalidated by a newer notification may ask the client to retry.
      await reading.catch((error: unknown) => {
        expect(error).toMatchObject({
          message: "Thread view changed while it was being refreshed",
        });
      });
      expect(projection.summary("one")).toMatchObject({ state: "running", currentTurnId: "next" });
      await store.flushed();
      expect(store.view().threadMeta.one?.sessionSnapshot?.currentTurnId).toBe("next");
      expect(store.view().threadMeta.one?.lastOutcome).toBeUndefined();
    },
  );

  it("keeps final text active until the turn itself is terminal", async () => {
    const { bridge, projection, terminal } = await createCompletionRecoveryHarness();
    terminal.status = "inProgress";
    terminal.completedAt = null;
    terminal.durationMs = null;

    await projection.sync();
    const detail = await projection.readThread("one");

    expect(detail.summary).toMatchObject({ state: "running", currentTurnId: "live" });
    expect(detail.turns[0]?.items).toContainEqual(
      expect.objectContaining({ phase: "final_answer" }),
    );
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
    ).toHaveLength(1);
  });

  it("preserves active goals and pending plan responses when recovering a completed turn", async () => {
    const { store, projection, terminal } = await createCompletionRecoveryHarness();
    await store.update((state) => {
      state.threadMeta.one!.settings = { collaborationMode: "plan" };
    });
    terminal.items = [{ type: "plan", id: "plan", text: "Implementation plan" }];
    await projection.readThread("one");
    expect(projection.summary("one")).toMatchObject({
      state: "needsAttention",
      currentTurnId: null,
    });

    const withGoal = await createCompletionRecoveryHarness();
    withGoal.bridge.emit("notification", goalNotification("active"));
    await withGoal.projection.readThread("one");
    expect(withGoal.projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: null,
    });
  });

  it("does not restore an active history turn older than the terminal outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.threadMeta.one = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 4_000,
      };
    });
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return {
          data: [{ ...testTurn("stale", "inProgress"), startedAt: 3 }],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 4));

    const detail = await projection.readThread("one");

    expect(detail.summary).toMatchObject({
      state: "completed",
      currentTurnId: null,
    });
  });

  it("does not let a history read finishing after invalidation repopulate stale cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const plan = testTurn("plan", "completed");
    const implementation = testTurn("implementation", "completed");
    let reads = 0;
    let releaseStaleRead!: () => void;
    let markStaleReadStarted!: () => void;
    const staleReadStarted = new Promise<void>((resolve) => {
      markStaleReadStarted = resolve;
    });
    const staleReadGate = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      reads += 1;
      if (reads === 1) {
        markStaleReadStarted();
        await staleReadGate;
        return { data: [plan], nextCursor: null, backwardsCursor: "plan-cursor" };
      }
      return {
        data: [implementation, plan],
        nextCursor: null,
        backwardsCursor: "implementation-cursor",
      };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));

    const stalePending = projection.readThread("one");
    await staleReadStarted;
    await projection.invalidateHistory("one");
    const fresh = await projection.readThread("one");
    expect(fresh.turns.map((turn) => turn.id)).toEqual(["plan", "implementation"]);

    releaseStaleRead();
    await stalePending;
    const cached = await projection.readThread("one");

    expect(cached.turns.map((turn) => turn.id)).toEqual(["plan", "implementation"]);
    expect(reads).toBe(2);
  });

  it("rejects an authoritative refresh when the rollout changes mid-read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const completed = testTurn("completed", "completed");
    let failReads = false;
    bridge.request.mockImplementation(async (method: string) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      if (failReads) throw new RpcError(-32_000, "Rollout changed while reading turns");
      return { data: [completed], nextCursor: null, backwardsCursor: null };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10, { type: "idle" }, [completed]));

    await projection.readThread("one");
    failReads = true;
    await expect(projection.readThread("one", { refresh: true })).rejects.toThrow(
      "Thread view is temporarily unavailable",
    );
    const recovered = await projection.readThread("one");

    expect(recovered.turns.map((turn) => turn.id)).toEqual(["completed"]);
    expect(recovered.summary.currentTurnId).toBeNull();
    expect(recovered.version).toEqual(projection.version);
  });

  it("replaces a shifted latest window in canonical order without retaining stale turns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const initial = Array.from({ length: 20 }, (_, index) =>
      testTurn(`turn-${String(index + 1).padStart(2, "0")}`, "completed"),
    );
    initial[1] = {
      ...initial[1]!,
      items: [{ type: "agentMessage", id: "answer", text: "stale", phase: null }],
    };
    const shifted = Array.from({ length: 20 }, (_, index) =>
      testTurn(`turn-${String(index + 2).padStart(2, "0")}`, "completed"),
    );
    shifted[0] = {
      ...shifted[0]!,
      items: [{ type: "agentMessage", id: "answer", text: "fresh", phase: null }],
    };
    let page = initial;
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      return { data: page.slice().reverse(), nextCursor: "older", backwardsCursor: null };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10, { type: "idle" }, initial));

    const first = await projection.readThread("one");
    expect(first.turns.map((turn) => turn.id)).toEqual(initial.map((turn) => turn.id));

    page = shifted;
    projection.upsertThread(thread("one", "/work", 11, { type: "idle" }, shifted));
    const refreshed = await projection.readThread("one");

    expect(refreshed.turns).toHaveLength(20);
    expect(refreshed.turns.map((turn) => turn.id)).toEqual(shifted.map((turn) => turn.id));
    expect(refreshed.turns[0]?.items[0]).toMatchObject({ text: "fresh" });
    expect(refreshed.turns.some((turn) => turn.id === "turn-01")).toBe(false);
  });

  it("reads a normal history page in order and rejects a page invalidated in flight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    let releaseRace!: () => void;
    let markRaceStarted!: () => void;
    const raceStarted = new Promise<void>((resolve) => {
      markRaceStarted = resolve;
    });
    const raceGate = new Promise<void>((resolve) => {
      releaseRace = resolve;
    });
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      if (params.cursor === "race") {
        markRaceStarted();
        await raceGate;
      }
      return {
        data: [testTurn("older-2", "completed"), testTurn("older-1", "completed")],
        nextCursor: "even-older",
        backwardsCursor: null,
      };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));

    const page = await projection.readThreadHistory("one", "older", "newest");
    expect(page).toMatchObject({
      instanceId: projection.version.instanceId,
      anchorTurnId: "newest",
      olderTurnsCursor: "even-older",
    });
    expect(page.turns.map((turn) => turn.id)).toEqual(["older-1", "older-2"]);
    expect(bridge.request).toHaveBeenLastCalledWith(
      "thread/turns/list",
      expect.objectContaining({
        threadId: "one",
        cursor: "older",
        limit: 20,
        sortDirection: "desc",
        itemsView: "full",
      }),
      30_000,
    );

    const pending = projection.readThreadHistory("one", "race", "newest");
    await raceStarted;
    await projection.invalidateHistory("one");
    releaseRace();
    await expect(pending).rejects.toThrow("Thread history changed while it was being read");
  });

  it("overlays accepted user messages onto a lagging turn read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const laggingTurn = {
      ...testTurn("live", "inProgress"),
      itemsView: "full" as const,
      items: [
        {
          type: "agentMessage" as const,
          id: "agent",
          text: "Уже отвечаю",
          phase: "commentary" as const,
          memoryCitation: null,
        },
      ],
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [laggingTurn], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));

    projection.recordUserMessage("one", "live", "client-user", "Мой запрос", ["image"]);

    expect((await projection.readThread("one")).turns[0]?.items).toMatchObject([
      { type: "userMessage", id: "client-user", text: "Мой запрос", images: ["image"] },
      { type: "agentMessage", id: "agent", text: "Уже отвечаю" },
    ]);

    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: {
          type: "userMessage",
          id: "server-user",
          clientId: "client-user",
          content: [{ type: "text", text: "Канонический запрос", text_elements: [] }],
        },
        completedAtMs: 11_000,
      },
    } as ServerNotification);
    expect((await projection.readThread("one")).turns[0]?.items[0]).toMatchObject({
      id: "client-user",
      text: "Канонический запрос",
    });

    projection.recordUserMessage("one", "live", "client-steer", "Уточнение", []);
    laggingTurn.items = [
      {
        type: "userMessage",
        id: "server-user",
        clientId: "client-user",
        content: [{ type: "text", text: "Канонический запрос", text_elements: [] }],
      },
      laggingTurn.items[0]!,
      {
        type: "agentMessage",
        id: "after-steer",
        text: "Продолжаю после уточнения",
        phase: "commentary",
        memoryCitation: null,
      },
    ];
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: laggingTurn.items[2],
        completedAtMs: 12_000,
      },
    } as ServerNotification);
    expect((await projection.readThread("one")).turns[0]?.items.map((item) => item.id)).toEqual([
      "client-user",
      "agent",
      "client-steer",
      "after-steer",
    ]);
  });

  it("keeps accepted steering messages in timeline order when the terminal turn omits them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));
    await projection.setCurrentTurn("one", "live");

    const user = {
      type: "userMessage" as const,
      id: "server-user",
      clientId: "client-user",
      content: [{ type: "text" as const, text: "Начальный запрос", text_elements: [] }],
    };
    const beforeFirstSteer = {
      type: "agentMessage" as const,
      id: "before-first-steer",
      text: "Первый этап",
      phase: "commentary" as const,
      memoryCitation: null,
    };
    const beforeSecondSteer = {
      type: "agentMessage" as const,
      id: "before-second-steer",
      text: "Второй этап",
      phase: "commentary" as const,
      memoryCitation: null,
    };
    const final = {
      type: "agentMessage" as const,
      id: "final",
      text: "Готово",
      phase: "final_answer" as const,
      memoryCitation: null,
    };
    const completeItem = (item: typeof beforeFirstSteer | typeof final, completedAtMs: number) =>
      bridge.emit("notification", {
        method: "item/completed",
        params: { threadId: "one", turnId: "live", item, completedAtMs },
      } as ServerNotification);

    projection.recordUserMessage("one", "live", "client-user", "Начальный запрос", []);
    completeItem(beforeFirstSteer, 11_000);
    projection.recordUserMessage("one", "live", "client-steer-one", "Первое уточнение", []);
    completeItem(beforeSecondSteer, 12_000);
    projection.recordUserMessage("one", "live", "client-steer-two", "Второе уточнение", []);
    completeItem(final, 13_000);

    expect(
      (await projection.readThread("one")).turns
        .find((turn) => turn.id === "live")
        ?.items.map((item) => item.id),
    ).toEqual([
      "client-user",
      "before-first-steer",
      "client-steer-one",
      "before-second-steer",
      "client-steer-two",
      "final",
    ]);

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          ...testTurn("live", "completed"),
          itemsView: "full",
          items: [user, beforeFirstSteer, beforeSecondSteer, final],
        },
      },
    } as ServerNotification);

    await vi.waitFor(() => expect(projection.summary("one")?.state).toBe("completed"));
    expect(
      (await projection.readThread("one")).turns
        .find((turn) => turn.id === "live")
        ?.items.map((item) => item.id),
    ).toEqual([
      "client-user",
      "before-first-steer",
      "client-steer-one",
      "before-second-steer",
      "client-steer-two",
      "final",
    ]);
  });

  it("loads one turn's canonical items through bounded full-turn pages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== "thread/turns/list") throw new Error(`Unexpected ${method}`);
      if (!params.cursor) {
        return {
          data: [{ ...testTurn("newer", "completed"), itemsView: "full" }],
          nextCursor: "next",
          backwardsCursor: null,
        };
      }
      return {
        data: [
          {
            ...testTurn("turn", "completed"),
            startedAt: 10,
            completedAt: 12,
            itemsView: "full",
            items: [
              {
                type: "userMessage",
                id: "user",
                clientId: null,
                content: [
                  {
                    type: "text",
                    text: 'Запрос\n\n<codexnest_attachments>\nThe user attached local files. Read them from these absolute paths before responding:\n[\n  {"name":"notes.txt","path":"/tmp/notes.txt"}\n]\n</codexnest_attachments>',
                    text_elements: [],
                  },
                  { type: "mention", name: "notes.txt", path: "/tmp/notes.txt" },
                ],
              },
              {
                type: "userMessage",
                id: "internal",
                clientId: "codexnest-team-claim:task",
                content: [{ type: "text", text: "Продолжить задачу", text_elements: [] }],
              },
              {
                type: "userMessage",
                id: "internal-v2",
                clientId: "codexnest-team-continuation:task-v2",
                content: [{ type: "text", text: "Continue Team", text_elements: [] }],
              },
              { type: "plan", id: "plan", text: "План" },
            ],
          },
        ],
        nextCursor: "unused",
        backwardsCursor: null,
      };
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    const response = await projection.readTurnItems("one", "turn");

    expect(response).toEqual({
      threadId: "one",
      turnId: "turn",
      items: [
        {
          type: "userMessage",
          id: "user",
          status: "completed",
          text: "Запрос",
          images: [],
          files: [{ name: "notes.txt", path: "/tmp/notes.txt" }],
          timestamp: 10_000,
          phase: null,
        },
        {
          type: "plan",
          id: "plan",
          status: "completed",
          text: "План",
          images: [],
          timestamp: 12_000,
          phase: null,
        },
      ],
    });
    expect(bridge.request).toHaveBeenNthCalledWith(
      1,
      "thread/turns/list",
      {
        threadId: "one",
        cursor: null,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
      30_000,
    );
    expect(bridge.request).toHaveBeenNthCalledWith(
      2,
      "thread/turns/list",
      {
        threadId: "one",
        cursor: "next",
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
      30_000,
    );
    expect(bridge.request).toHaveBeenCalledTimes(2);
    expect(bridge.request.mock.calls.some(([method]) => method === "thread/items/list")).toBe(
      false,
    );
  });

  it("returns an empty item list when the requested turn is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    bridge.request.mockResolvedValue({
      data: [{ ...testTurn("other", "completed"), itemsView: "full" }],
      nextCursor: null,
      backwardsCursor: null,
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await expect(projection.readTurnItems("one", "missing")).resolves.toEqual({
      threadId: "one",
      turnId: "missing",
      items: [],
    });
    expect(bridge.request).toHaveBeenCalledWith(
      "thread/turns/list",
      {
        threadId: "one",
        cursor: null,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
      30_000,
    );
  });

  it("reconciles an agent item started under a provisional id with its canonical completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const canonicalMessage = {
      type: "agentMessage" as const,
      id: "canonical-agent",
      text: "Готово",
      phase: "final_answer" as const,
      memoryCitation: null,
    };
    const canonicalTurn = {
      ...testTurn("live", "completed"),
      itemsView: "full" as const,
      items: [canonicalMessage],
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [canonicalTurn], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const activities: ActivityItem[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "activity.upserted" && event.item.id === "provisional-agent") {
        activities.push(event.item);
      }
    });
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", {
      method: "item/started",
      params: {
        threadId: "one",
        turnId: "live",
        item: { ...canonicalMessage, id: "provisional-agent", text: "Гот" },
        startedAtMs: 11_000,
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: canonicalMessage,
        completedAtMs: 12_000,
      },
    } satisfies ServerNotification);

    expect(activities).toMatchObject([
      { id: "provisional-agent", status: "inProgress", text: "Гот" },
      { id: "provisional-agent", status: "completed", text: "Готово" },
    ]);
    expect((await projection.readThread("one")).turns[0]?.items).toMatchObject([
      { id: "canonical-agent", status: "completed", text: "Готово" },
    ]);
  });

  it("keeps independent completed agent messages with identical text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const completedItemIds: string[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "activity.upserted") completedItemIds.push(event.item.id);
    });

    for (const [id, completedAtMs] of [
      ["first-agent", 11_000],
      ["second-agent", 12_000],
    ] as const) {
      bridge.emit("notification", {
        method: "item/completed",
        params: {
          threadId: "one",
          turnId: "live",
          item: {
            type: "agentMessage",
            id,
            text: "Повтор",
            phase: "commentary",
            memoryCitation: null,
          },
          completedAtMs,
        },
      } satisfies ServerNotification);
    }

    expect(completedItemIds).toEqual(["first-agent", "second-agent"]);
  });

  it("reconciles a streamed agent message when the canonical item id changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const canonicalTurn = {
      ...testTurn("live", "completed"),
      itemsView: "full" as const,
      items: [
        {
          type: "agentMessage" as const,
          id: "canonical-agent",
          text: "Готово",
          phase: "final_answer" as const,
          memoryCitation: null,
        },
      ],
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [canonicalTurn], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const liveEvents: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "activity.delta" || event.type === "activity.upserted") {
        liveEvents.push(event);
      }
    });
    projection.upsertThread(thread("one", "/work", 10));

    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "live",
        itemId: "stream-agent",
        delta: "Готово",
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "live",
        item: canonicalTurn.items[0],
        completedAtMs: 12_000,
      },
    } as ServerNotification);
    bridge.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "one",
        turnId: "live",
        explanation: "Готово",
        plan: [{ step: "Ответить", status: "completed" }],
      },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.timelineArtifacts?.live).toHaveLength(1),
    );
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: canonicalTurn },
    } as ServerNotification);

    expect(liveEvents.slice(0, 2)).toMatchObject([
      {
        type: "activity.delta",
        itemId: "stream-agent",
        activityType: "agentMessage",
        delta: "Готово",
      },
      {
        type: "activity.upserted",
        item: { id: "stream-agent", status: "completed", text: "Готово" },
      },
    ]);
    const items = (await projection.readThread("one")).turns[0]?.items ?? [];
    expect(items.map((item) => item.id)).toEqual([
      "canonical-agent",
      expect.stringContaining("live-plan-checklist-"),
    ]);
    expect(items[1]).toMatchObject({
      type: "planChecklist",
      afterItemId: "canonical-agent",
    });
  });

  it("replaces transient live activities with the terminal canonical turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const canonicalTurn = {
      ...testTurn("live", "completed"),
      itemsView: "full" as const,
      items: [
        {
          type: "agentMessage" as const,
          id: "canonical-final",
          text: "Работа завершена",
          phase: "final_answer" as const,
          memoryCitation: null,
        },
      ],
    };
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [canonicalTurn], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    const replacements: TurnView[] = [];
    const deliveryEvents: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "turn.replaced") replacements.push(event.turn);
      if (event.type === "activity.delta" || event.type === "turn.replaced") {
        deliveryEvents.push(event);
      }
    });
    projection.upsertThread(thread("one", "/work", 10));
    projection.recordUserMessage("one", "live", "client-user", "Проверь доставку", []);
    replacements.length = 0;
    deliveryEvents.length = 0;

    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "live",
        itemId: "stream-commentary",
        delta: "Работа завершена",
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: canonicalTurn,
      },
    } as ServerNotification);

    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, TURN_REPLACEMENT_SETTLE_MS));
    expect(replacements).toHaveLength(1);
    expect(deliveryEvents.map((event) => event.type)).toEqual(["activity.delta", "turn.replaced"]);
    expect(replacements[0]?.items.map((item) => item.id)).toEqual([
      "client-user",
      "canonical-final",
    ]);
    expect((await projection.readThread("one")).turns[0]?.items.map((item) => item.id)).toEqual([
      "client-user",
      "canonical-final",
    ]);
  });

  it("persists visible assistant text across an interruption and projection restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const statePath = join(directory, "state.json");
    const store = new StateStore(statePath);
    await store.load();
    let includeCanonicalReasoning = true;
    const finalMessage = {
      type: "agentMessage" as const,
      id: "after-reasoning",
      text: "Частичный ответ",
      phase: "commentary" as const,
      memoryCitation: null,
    };
    const canonicalTurn = (): Thread["turns"][number] => ({
      ...testTurn("live", "completed"),
      status: "interrupted",
      itemsView: "full",
      items: [
        ...(includeCanonicalReasoning
          ? [
              {
                type: "reasoning" as const,
                id: "reasoning",
                summary: [],
                content: [],
              },
            ]
          : []),
        finalMessage,
      ],
    });
    const bridge = new FakeBridge();
    bridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [canonicalTurn()], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(
      thread("one", "/work", 10, { type: "active", activeFlags: [] }, [
        testTurn("live", "inProgress"),
      ]),
    );
    await projection.setCurrentTurn("one", "live");

    bridge.emit("notification", {
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "one",
        turnId: "live",
        itemId: "reasoning",
        delta: "Проверяю сохранение рассуждения",
        summaryIndex: 0,
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "live",
        itemId: "commentary",
        delta: "Показываю промежуточный результат",
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "live",
        itemId: "after-reasoning",
        delta: finalMessage.text,
      },
    } satisfies ServerNotification);

    await projection.markInterrupted("one", ["live"]);
    expect(store.snapshot().threadMeta.one?.interruptedReasoning?.live).toMatchObject([
      {
        type: "reasoning",
        id: "reasoning",
        text: "Проверяю сохранение рассуждения",
      },
      {
        type: "agentMessage",
        id: "commentary",
        text: "Показываю промежуточный результат",
      },
      {
        type: "agentMessage",
        id: "after-reasoning",
        text: "Частичный ответ",
      },
    ]);

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: canonicalTurn() },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("one")?.state).toBe("interrupted"));
    const dialogue = (await projection.readThread("one", { refresh: true })).turns[0]?.items ?? [];
    expect(dialogue.map((item) => item.id)).toEqual(["commentary", "after-reasoning"]);
    const liveItems = (await projection.readTurnItems("one", "live")).items;
    expect(liveItems.map((item) => item.id)).toEqual([
      "reasoning",
      "commentary",
      "after-reasoning",
    ]);
    expect(liveItems[0]).toMatchObject({
      type: "reasoning",
      status: "completed",
      text: "Проверяю сохранение рассуждения",
    });
    expect(liveItems[1]).toMatchObject({
      type: "agentMessage",
      status: "completed",
      text: "Показываю промежуточный результат",
    });
    await store.flushed();

    const reloadedStore = new StateStore(statePath);
    await reloadedStore.load();
    const reloadedBridge = new FakeBridge();
    reloadedBridge.request.mockImplementation(async (method: string) => {
      if (method === "thread/turns/list") {
        return { data: [canonicalTurn()], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const reloaded = new AppProjection(
      reloadedBridge as unknown as CodexBridge,
      reloadedStore,
      new AttentionManager(),
    );
    const restoredDialogue =
      (await reloaded.readThread("one", { refresh: true })).turns[0]?.items ?? [];
    expect(restoredDialogue.map((item) => item.id)).toEqual(["commentary", "after-reasoning"]);
    const restoredItems = (await reloaded.readTurnItems("one", "live")).items;
    expect(restoredItems.map((item) => item.id)).toEqual([
      "reasoning",
      "commentary",
      "after-reasoning",
    ]);
    expect(restoredItems[0]).toMatchObject({
      type: "reasoning",
      status: "completed",
      text: "Проверяю сохранение рассуждения",
    });
    expect(restoredItems[1]).toMatchObject({
      type: "agentMessage",
      status: "completed",
      text: "Показываю промежуточный результат",
    });

    includeCanonicalReasoning = false;
    const fullyLoaded = await reloaded.readTurnItems("one", "live");
    expect(fullyLoaded.items.map((item) => item.id)).toEqual([
      "reasoning",
      "commentary",
      "after-reasoning",
    ]);
    expect(fullyLoaded.items[0]).toMatchObject({
      type: "reasoning",
      status: "completed",
      text: "Проверяю сохранение рассуждения",
    });
    expect(fullyLoaded.items[1]).toMatchObject({
      type: "agentMessage",
      status: "completed",
      text: "Показываю промежуточный результат",
    });
  });

  it("drops captured interrupted assistant text when the turn completes normally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );
    projection.upsertThread(thread("one", "/work", 10));
    await projection.setCurrentTurn("one", "live");
    bridge.emit("notification", {
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "one",
        turnId: "live",
        itemId: "reasoning",
        delta: "Почти закончено",
        summaryIndex: 0,
      },
    } satisfies ServerNotification);
    bridge.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "one",
        turnId: "live",
        itemId: "commentary",
        delta: "Промежуточный ответ",
      },
    } satisfies ServerNotification);
    await projection.markInterrupted("one", ["live"]);
    expect(store.snapshot().threadMeta.one?.interruptedReasoning?.live).toHaveLength(2);

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("live", "completed") },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.one?.interruptedReasoning).toBeUndefined(),
    );
  });

  it("rejoins and restores an active turn once per app-server connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge(true);
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await projection.sync();
    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "live",
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      1,
    );
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/goal/get"),
    ).toHaveLength(1);
    expect((await projection.readThread("one")).turns[0]).toMatchObject({
      id: "live",
      status: "inProgress",
      startedAt: 3_000,
      completedAt: null,
      durationMs: null,
      progress: { startedAt: 3_000 },
      items: [
        {
          id: "client-user",
          type: "userMessage",
          text: "Запрос",
          images: ["data:image/png;base64,aW1hZ2U="],
          timestamp: 3_000,
          phase: null,
        },
        {
          id: "answer",
          type: "agentMessage",
          text: "В процессе",
          timestamp: 3_000,
          phase: null,
          images: [],
        },
      ],
    });
    expect(bridge.request).toHaveBeenCalledWith(
      "thread/turns/list",
      {
        threadId: "one",
        cursor: null,
        limit: 20,
        sortDirection: "desc",
        itemsView: "full",
      },
      30_000,
    );

    await projection.sync();
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      1,
    );
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/goal/get"),
    ).toHaveLength(1);
    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "live",
      unread: false,
    });

    bridge.emit("state", "unavailable");
    bridge.emit("state", "ready");
    await projection.sync();
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      2,
    );
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/goal/get"),
    ).toHaveLength(2);
  });

  it("does not replace fresh list timestamps with stale resume metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge(true, false, 1);
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await projection.sync();

    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "live",
      updatedAt: 5_000,
    });
  });

  it("restores an active goal after restart before the resumed turn completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-projection-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    const bridge = new FakeBridge(true, true);
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      store,
      new AttentionManager(),
    );

    await projection.sync();
    expect(projection.summary("one")).toMatchObject({
      state: "running",
      currentTurnId: "live",
      unread: false,
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/goal/get"),
    ).toHaveLength(1);

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "one", turn: testTurn("live", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(projection.summary("one")).toMatchObject({
        state: "running",
        currentTurnId: null,
        unread: false,
      }),
    );

    bridge.emit("notification", goalNotification("complete", 3));
    expect(projection.summary("one")).toMatchObject({ state: "completed", unread: true });
    await store.flushed();
  });
});

async function createUserInputLifecycleHarness(unrelatedThreads = 0) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-input-lifecycle-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  if (unrelatedThreads) {
    await store.update((state) => {
      for (let index = 0; index < unrelatedThreads; index += 1) {
        const id = `unrelated-${index}`;
        state.threadMeta[id] = {
          pinned: false,
          lastReadUpdatedAt: 0,
          sessionSnapshot: {
            sessionId: id,
            name: id,
            preview: id,
            cwd: "/work",
            createdAt: 1,
            updatedAt: 1,
            archived: false,
            currentTurnId: null,
          },
        };
      }
    });
  }
  const bridge = new FakeBridge();
  const attention = new AttentionManager();
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  projection.upsertThread(thread("one", "/work", 10));
  const transport = { respond: vi.fn(), respondError: vi.fn() };
  let nextRpcId = 900;
  const receive = (turnId = "question-turn", threadId = "one") => {
    const request = attention.receive(
      userInputServerRequest(nextRpcId++, "Which one?", turnId, threadId),
      transport as unknown as JsonlTransport,
    );
    if (request.kind !== "userInput") throw new Error("Expected user input");
    return request;
  };
  const events: ServerEvent[] = [];
  projection.on("event", (_sequence, event: ServerEvent) => events.push(event));
  return { store, bridge, attention, projection, transport, receive, events };
}

async function createAsyncQuestionHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-async-question-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  const bridge = new FakeBridge();
  const projection = new AppProjection(
    bridge as unknown as CodexBridge,
    store,
    new AttentionManager(),
  );
  projection.upsertThread(
    thread("one", "/work", 10, { type: "active", activeFlags: [] }, [
      testTurn("questions-turn", "inProgress"),
    ]),
  );
  const events: ServerEvent[] = [];
  projection.on("event", (_sequence, event: ServerEvent) => events.push(event));
  const receive = (id = "question") => {
    bridge.emit("notification", {
      method: "item/started",
      params: {
        threadId: "one",
        turnId: "questions-turn",
        startedAtMs: 10000,
        item: {
          type: "agentMessage",
          id,
          text: "",
          phase: "commentary",
          memoryCitation: null,
          delivery: "async",
          questions: [{ title: "Как проверить?", options: ["Быстро", "Подробно"] }],
        },
      },
    } satisfies ServerNotification);
    const item = events.filter((event) => event.type === "activity.upserted").at(-1)!.item;
    if (item.type !== "agentMessage") throw new Error("Expected async question");
    return item;
  };
  return { projection, bridge, store, receive, events };
}

function userInputServerRequest(
  id: number,
  question = "Which one?",
  turnId = "question-turn",
  threadId = "one",
): ServerRequest {
  return {
    method: "item/tool/requestUserInput",
    id,
    params: {
      threadId,
      turnId,
      itemId: "question-item",
      autoResolutionMs: null,
      questions: [
        {
          id: "choice",
          header: "Choice",
          question,
          isOther: true,
          isSecret: false,
          options: [{ label: "First", description: "Pick first" }],
        },
      ],
    },
  } as ServerRequest;
}

async function createCompletionRecoveryHarness(
  status: "completed" | "failed" | "interrupted" = "completed",
) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-completion-recovery-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.threadMeta.one = {
      pinned: false,
      lastReadUpdatedAt: 0,
      sessionSnapshot: {
        sessionId: "one",
        name: "Test",
        preview: "Test",
        cwd: "/work",
        createdAt: 1,
        updatedAt: 5,
        archived: false,
        currentTurnId: "live",
      },
    };
  });
  const terminal: Thread["turns"][number] = {
    ...testTurn("live", "completed"),
    status,
    completedAt: 6,
    durationMs: 5_000,
    itemsView: "full",
    items: [{ type: "agentMessage", id: "answer", text: "Finished", phase: "final_answer" }],
  };
  const bridge = new FakeBridge();
  bridge.request.mockImplementation(async (method, params) => {
    if (method === "thread/list")
      return {
        data: params.archived
          ? []
          : [thread("one", "/work", 5, { type: "active", activeFlags: [] })],
        nextCursor: null,
        backwardsCursor: null,
      };
    if (method === "thread/loaded/list") return { data: ["one"], nextCursor: null };
    if (method === "model/list") return { data: [], nextCursor: null };
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/resume")
      return {
        thread: thread(
          "one",
          "/work",
          6,
          terminal.status === "inProgress" ? { type: "active", activeFlags: [] } : { type: "idle" },
          [terminal],
        ),
      };
    if (method === "thread/turns/list")
      return { data: [terminal], nextCursor: null, backwardsCursor: null };
    throw new Error(`Unexpected ${method}`);
  });
  const projection = new AppProjection(
    bridge as unknown as CodexBridge,
    store,
    new AttentionManager(),
  );
  const events: ServerEvent[] = [];
  projection.on("event", (_sequence, event: ServerEvent) => events.push(event));
  return { store, bridge, projection, terminal, events };
}

async function autoFinishHarness(now: number, activityTimes?: number[]) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-auto-finish-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  const threads = (
    activityTimes ?? Array.from({ length: 16 }, (_, index) => now - 4 * 86_400_000 - index * 1_000)
  ).map((time, index) =>
    thread(`auto-${String(index).padStart(2, "0")}`, index % 2 ? "/other" : "/work", time / 1_000),
  );
  await store.update((state) => {
    state.projects = ["/work", "/other"].map((path) => ({
      id: path,
      path,
      displayName: path,
      createdAt: "x",
      updatedAt: "x",
    }));
    for (const item of threads)
      state.threadMeta[item.id] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: item.updatedAt * 1_000,
        lastResult: { turnId: `${item.id}-result`, completedAt: item.updatedAt * 1_000 },
        awaitingPlanResponse: false,
      };
  });
  const bridge = new FakeBridge();
  bridge.request.mockImplementation(async (method, params) => {
    if (method === "thread/list")
      return { data: params.archived ? [] : threads, nextCursor: null, backwardsCursor: null };
    if (method === "thread/loaded/list" || method === "model/list")
      return { data: [], nextCursor: null };
    throw new Error(`Unexpected ${method}`);
  });
  const projection = new AppProjection(
    bridge as unknown as CodexBridge,
    store,
    new AttentionManager(),
  );
  for (const item of threads) projection.upsertThread(item);
  await store.flushed();
  const setConnection = (state: CodexBridge["state"]) => {
    Object.assign(bridge, { state });
    bridge.emit("state", state);
  };
  return { store, bridge, projection, threads, setConnection };
}

async function searchHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-title-search-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  const bridge = new FakeBridge();
  const projection = new AppProjection(
    bridge as unknown as CodexBridge,
    store,
    new AttentionManager(),
  );
  return { store, bridge, projection };
}

async function fastSettingsHarness(tiers: string[], active = false) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-fast-settings-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  const bridge = new FakeBridge(active, false, 5, tiers);
  const request = bridge.request.getMockImplementation()!;
  bridge.request.mockImplementation(async (method, params) => {
    if (method === "thread/loaded/list") return { data: [], nextCursor: null };
    return request(method, params);
  });
  const projection = new AppProjection(
    bridge as unknown as CodexBridge,
    store,
    new AttentionManager(),
  );
  return { store, bridge, projection };
}

function thread(
  id: string,
  cwd: string,
  updatedAt: number,
  status: Thread["status"] = { type: "idle" },
  turns: Thread["turns"] = [],
): Thread {
  return {
    id,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: id,
    ephemeral: false,
    historyMode: "full",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt,
    recencyAt: updatedAt,
    status,
    path: null,
    cwd,
    cliVersion: "0.144.6",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns,
  };
}

function liveThread(updatedAt = 5): Thread {
  return thread("one", "/work", updatedAt, { type: "active", activeFlags: [] }, [
    {
      id: "live",
      items: [
        {
          type: "userMessage",
          id: "user",
          clientId: "client-user",
          content: [
            { type: "text", text: "Запрос", text_elements: [] },
            { type: "image", url: "data:image/png;base64,aW1hZ2U=" },
            { type: "image", fileId: "uploaded-image" },
          ],
        },
        {
          type: "agentMessage",
          id: "answer",
          text: "В процессе",
          phase: null,
        },
      ],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 3,
      completedAt: null,
      durationMs: null,
    },
  ]);
}

function testTurn(id: string, status: "inProgress" | "completed"): Thread["turns"][number] {
  return {
    id,
    items: [],
    itemsView: "summary",
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "completed" ? 2 : null,
    durationMs: status === "completed" ? 1_000 : null,
  };
}

type CollabToolCall = Extract<
  Thread["turns"][number]["items"][number],
  { type: "collabAgentToolCall" }
>;

function collabWaitNotification(
  id: string,
  status: CollabToolCall["status"],
  receiverThreadIds: string[],
  agentsStates: CollabToolCall["agentsStates"],
  completedAtMs = 10_500,
): ServerNotification {
  return {
    method: "item/completed",
    params: {
      threadId: "one",
      turnId: "parent-turn",
      item: {
        type: "collabAgentToolCall",
        id,
        tool: "wait",
        status,
        senderThreadId: "one",
        receiverThreadIds,
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates,
      },
      completedAtMs,
    },
  } satisfies ServerNotification;
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function goalNotification(
  status: ThreadGoal["status"],
  updatedAt = 2,
): Extract<ServerNotification, { method: "thread/goal/updated" }> {
  return {
    method: "thread/goal/updated",
    params: {
      threadId: "one",
      turnId: null,
      goal: {
        threadId: "one",
        objective: "Довести задачу до конца",
        status,
        tokenBudget: null,
        tokensUsed: 42,
        timeUsedSeconds: 7,
        createdAt: 1,
        updatedAt,
      },
    },
  };
}
