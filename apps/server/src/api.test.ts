import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import {
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_EXTENSION_WEBSOCKET_PATH,
  BROWSER_TOOL_NAMES,
  type ServerEvent,
} from "@codexnest/protocol";

import { buildApp } from "./app";
import { triggerTeamWatchdogs } from "./api";
import type { AppManager } from "./app-management";
import { AttentionManager } from "./attention";
import { hashToken } from "./auth";
import { CodexBridge } from "./codex/bridge";
import type { ServerNotification, ServerRequest } from "./codex/generated/index";
import type { Thread, ThreadGoal, ThreadItem, Turn } from "./codex/generated/v2/index";
import { CAPACITY_RETRY_INTERVAL_MS, CAPACITY_RETRY_MESSAGE_PREFIX } from "./capacity-retry";
import { RpcError, RpcTimeoutError, type JsonlTransport } from "./codex/transport";
import type { CodexManager } from "./codex-management";
import { loadConfig } from "./config";
import { AppProjection } from "./projection";
import { RuntimeLifecycle } from "./runtime-lifecycle";
import { messageContentHash } from "./message-queue";
import { StateStore } from "./state/store";
import { computeTeamWorkspaceDelta, createTeamWorkspace } from "./team-workspace";
import type { ThreadTitleGenerator } from "./thread-title";
import { TranscriptionError } from "./transcription";
import { VoiceTranscriptionManager } from "./voice-transcriptions";

const directories: string[] = [];
const execFileAsync = promisify(execFile);
const TEAM_MARKER_TEXT =
  "Continue CodexNest Team orchestration using the attached managed-task results.";
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

describe("model capacity recovery", () => {
  afterEach(() => vi.useRealTimers());

  async function harness(mode: "default" | "plan" | "team" = "default") {
    const context = await createTeamHarness();
    await context.projection.setSettings("thread", {
      collaborationMode: mode,
      model: "gpt-a",
      reasoningEffort: "high",
    });
    await context.app.ready();
    await nextImmediate();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    return context;
  }

  async function fail(
    context: Awaited<ReturnType<typeof harness>>,
    id = "capacity-0",
    threadId = "thread",
    notifyError = false,
  ) {
    const previous = context.bridge.threadTurns.get(threadId) ?? [];
    const turn: Turn = {
      ...testTurn(id, "failed"),
      itemsView: "full",
      error: {
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
        additionalDetails: null,
        misalignment: null,
      },
    };
    context.bridge.threadTurns.set(threadId, [
      ...previous.filter((entry) => entry.id !== id),
      turn,
    ]);
    context.bridge.emit("notification", {
      method: "turn/started",
      params: { threadId, turn: { ...turn, status: "inProgress", error: null } },
    });
    if (notifyError) {
      context.bridge.emit("notification", {
        method: "error",
        params: { threadId, turnId: id, error: turn.error!, willRetry: false },
      });
      context.bridge.emit("notification", {
        method: "thread/status/changed",
        params: { threadId, status: { type: "systemError" } },
      });
    }
    context.bridge.emit("notification", { method: "turn/completed", params: { threadId, turn } });
    await vi.waitFor(() =>
      expect(context.projection.summary(threadId)?.capacityRetry?.failedTurnId).toBe(id),
    );
    await vi.waitFor(() => expect(context.projection.summary(threadId)?.currentTurnId).toBeNull());
    return turn;
  }

  async function retry(context: Awaited<ReturnType<typeof harness>>, threadId = "thread") {
    const deadline = context.store.view().threadMeta[threadId]!.capacityRetry!.nextAttemptAt;
    await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now()));
    await vi.waitFor(() =>
      expect(context.projection.summary(threadId)?.currentTurnId).not.toBeNull(),
    );
    await vi.waitFor(() =>
      expect(context.store.view().threadMeta[threadId]?.capacityRetry).toBeUndefined(),
    );
    return context.projection.summary(threadId)!.currentTurnId!;
  }

  it("never publishes a failed state for a live overload and keeps its history classified", async () => {
    const context = await harness();
    const states: string[] = [];
    context.projection.on("event", (_sequence, event: ServerEvent) => {
      if (event.type === "thread.upserted" && event.thread.id === "thread")
        states.push(event.thread.state);
    });
    try {
      await fail(context, "capacity-0", "thread", true);
      expect(states).not.toContain("failed");
      const history = await context.projection.readThread("thread");
      expect(history.turns.find((turn) => turn.id === "capacity-0")).toMatchObject({
        failureKind: "modelCapacity",
        items: expect.arrayContaining([
          expect.objectContaining({ type: "error", failureKind: "modelCapacity" }),
        ]),
      });
      await retry(context);
      const continued = await context.projection.readThread("thread");
      expect(continued.turns.find((turn) => turn.id === "capacity-0")?.failureKind).toBe(
        "modelCapacity",
      );
      expect(states).not.toContain("failed");
    } finally {
      await context.app.close();
    }
  });

  it("keeps a terminal overload running while retry persistence overlaps systemError", async () => {
    const context = await harness();
    const states: string[] = [];
    context.projection.on("event", (_sequence, event: ServerEvent) => {
      if (event.type === "thread.upserted" && event.thread.id === "thread")
        states.push(event.thread.state);
    });
    let release!: () => void;
    try {
      const turn: Turn = {
        ...testTurn("overlap", "failed"),
        error: {
          message: "Selected model is at capacity.",
          codexErrorInfo: "serverOverloaded",
          additionalDetails: null,
          misalignment: null,
        },
      };
      context.bridge.threadTurns.set("thread", [turn]);
      context.bridge.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread", turn: { ...turn, status: "inProgress", error: null } },
      });
      await vi.waitFor(() =>
        expect(context.projection.summary("thread")?.currentTurnId).toBe(turn.id),
      );
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const update = context.store.update.bind(context.store);
      vi.spyOn(context.store, "update").mockImplementationOnce(async (mutate) => {
        await gate;
        return update(mutate);
      });
      context.bridge.emit("notification", {
        method: "turn/completed",
        params: { threadId: "thread", turn },
      });
      context.bridge.emit("notification", {
        method: "thread/status/changed",
        params: { threadId: "thread", status: { type: "systemError" } },
      });
      expect(context.projection.summary("thread")?.state).toBe("running");
      expect(states).not.toContain("failed");
      release();
      await vi.waitFor(() =>
        expect(context.projection.summary("thread")?.capacityRetry?.failedTurnId).toBe(turn.id),
      );
      expect(states).not.toContain("failed");
    } finally {
      release?.();
      await context.app.close();
    }
  });

  it.each(["default", "plan"] as const)(
    "retries %s every five minutes without changing settings or duplicating input",
    async (mode) => {
      const context = await harness(mode);
      try {
        await context.projection.setSettings("thread", {
          collaborationMode: mode,
          model: "gpt-a",
          reasoningEffort: "high",
          serviceTier: "fast",
        });
        await fail(context);
        expect(context.projection.summary("thread")).toMatchObject({
          state: "running",
          currentTurnId: null,
        });
        const firstDeadline = context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt;
        context.bridge.request.mockClear();
        await vi.advanceTimersByTimeAsync(firstDeadline - Date.now() - 1);
        expect(context.bridge.request).not.toHaveBeenCalled();
        for (let attempt = 0; attempt < 3; attempt++) {
          const turnId = await retry(context);
          const starts = context.bridge.request.mock.calls.filter(
            ([method]) => method === "turn/start",
          );
          expect(starts).toHaveLength(attempt + 1);
          expect(starts.at(-1)?.[1]).toMatchObject({
            model: "gpt-a",
            effort: "high",
            serviceTier: "fast",
            collaborationMode: { mode },
            clientUserMessageId: expect.stringContaining(CAPACITY_RETRY_MESSAGE_PREFIX),
          });
          const view = await context.projection.readThread("thread");
          expect(
            view.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage"),
          ).toEqual([]);
          if (attempt < 2) await fail(context, turnId);
        }
        expect(context.bridge.request.mock.calls.some(([method]) => method === "model/list")).toBe(
          false,
        );
        const successful = testTurn(
          context.projection.summary("thread")!.currentTurnId!,
          "completed",
        );
        context.bridge.emit("notification", {
          method: "turn/completed",
          params: { threadId: "thread", turn: successful },
        });
        await vi.waitFor(() =>
          expect(context.projection.summary("thread")?.state).toBe("completed"),
        );
        context.bridge.request.mockClear();
        await vi.advanceTimersByTimeAsync(10 * CAPACITY_RETRY_INTERVAL_MS);
        expect(context.bridge.request).not.toHaveBeenCalled();
      } finally {
        await context.app.close();
      }
    },
  );

  it.each([
    { version: 1, code: -32000, data: { codexErrorInfo: "serverOverloaded" } },
    {
      version: 1,
      code: -32602,
      data: { delivery: "rejected", codexErrorInfo: "serverOverloaded" },
    },
    { version: undefined, code: -32600, data: undefined },
  ])(
    "keeps retrying a capacity RPC rejection with receiver $version and code $code",
    async ({ version, code, data }) => {
      const context = await harness();
      try {
        context.bridge.deliveryVersion = version;
        await fail(context);
        const original = context.bridge.request.getMockImplementation()!;
        let failures = 2;
        context.bridge.request.mockImplementation(async (method, params) => {
          if (method === "turn/start" && failures > 0) {
            failures--;
            throw new RpcError(code, "Selected model is at capacity.", data);
          }
          return original(method, params);
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          const deadline = context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt;
          await vi.advanceTimersByTimeAsync(deadline - Date.now());
          await vi.waitFor(() => expect(failures).toBe(1 - attempt));
          await vi.waitFor(() =>
            expect(context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt).toBe(
              deadline + CAPACITY_RETRY_INTERVAL_MS,
            ),
          );
          expect(context.projection.summary("thread")?.state).toBe("running");
        }
        await retry(context);
        expect(context.bridge.managedTurnSequences.get("thread")).toBe(1);
      } finally {
        await context.app.close();
      }
    },
  );

  it("keeps a temporary history RPC failure pending but stops on a permanent rejection", async () => {
    const context = await harness();
    try {
      await fail(context);
      context.bridge.nextTurnListError = new RpcError(-32000, "Service temporarily unavailable");
      let deadline = context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt;
      await vi.advanceTimersByTimeAsync(deadline - Date.now());
      await vi.waitFor(() =>
        expect(
          context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt,
        ).toBeGreaterThan(Date.now()),
      );
      expect(context.projection.summary("thread")?.state).toBe("running");
      context.bridge.nextTurnListError = new RpcError(-32602, "Invalid request");
      deadline = context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt;
      await vi.advanceTimersByTimeAsync(deadline - Date.now());
      await vi.waitFor(() =>
        expect(context.store.view().threadMeta.thread?.capacityRetry).toBeUndefined(),
      );
      expect(context.projection.summary("thread")?.state).toBe("failed");
    } finally {
      await context.app.close();
    }
  });

  it("stops waiting without an RPC and ignores duplicate failure events", async () => {
    const context = await harness();
    try {
      const turn = await fail(context);
      context.bridge.request.mockClear();
      const stopped = await context.app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/interrupt",
        headers: context.headers,
        payload: {},
      });
      expect(stopped.statusCode).toBe(204);
      context.bridge.emit("notification", {
        method: "turn/completed",
        params: { threadId: "thread", turn },
      });
      await nextImmediate();
      await vi.advanceTimersByTimeAsync(20 * CAPACITY_RETRY_INTERVAL_MS);
      expect(context.store.view().threadMeta.thread?.capacityRetry).toBeUndefined();
      expect(context.bridge.request).not.toHaveBeenCalled();
    } finally {
      await context.app.close();
    }
  });

  it("keeps queued messages parked and lets Send now cancel waiting", async () => {
    const context = await harness();
    try {
      await fail(context);
      context.bridge.request.mockClear();
      const queued = await context.app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/queue",
        headers: context.headers,
        payload: { input: "New direction", clientMessageId: "queued" },
      });
      expect(queued.statusCode).toBe(202);
      await nextImmediate();
      expect(context.bridge.request).not.toHaveBeenCalled();
      expect(context.store.view().messageQueues?.thread).toHaveLength(1);
      const sent = await context.app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/queue/queued/send",
        headers: context.headers,
      });
      expect(sent.statusCode).toBe(200);
      expect(context.store.view().threadMeta.thread?.capacityRetry).toBeUndefined();
      expect(
        context.bridge.request.mock.calls.filter(([method]) => method === "turn/start"),
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2 * CAPACITY_RETRY_INTERVAL_MS);
      expect(
        context.bridge.request.mock.calls.filter(([method]) => method === "turn/start"),
      ).toHaveLength(1);
    } finally {
      await context.app.close();
    }
  });

  it("stops a retry whose start RPC is in flight and suppresses its late failure", async () => {
    const context = await harness();
    try {
      await fail(context);
      let releaseStart!: () => void;
      context.bridge.parentTurnStartGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      let entered = false;
      context.bridge.parentTurnStartEntered = () => {
        entered = true;
      };
      const deadline = context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt;
      await vi.advanceTimersByTimeAsync(deadline - Date.now());
      await vi.waitFor(() => expect(entered).toBe(true));
      const stopped = context.app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/interrupt",
        headers: context.headers,
        payload: {},
      });
      await vi.waitFor(() =>
        expect(context.store.view().threadMeta.thread?.capacityRetry).toBeUndefined(),
      );
      releaseStart();
      expect((await stopped).statusCode).toBe(204);
      const turnId = context.bridge.threadTurns.get("thread")!.at(-1)!.id;
      context.bridge.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: {
            ...testTurn(turnId, "failed"),
            error: {
              message: "Model overload",
              codexErrorInfo: "serverOverloaded",
              additionalDetails: null,
              misalignment: null,
            },
          },
        },
      });
      await nextImmediate();
      await vi.advanceTimersByTimeAsync(2 * CAPACITY_RETRY_INTERVAL_MS);
      expect(context.bridge.managedTurnSequences.get("thread")).toBe(1);
      expect(context.store.view().threadMeta.thread?.capacityRetry).toBeUndefined();
    } finally {
      await context.app.close();
    }
  });

  it.each(["budgetLimited", "usageLimited", "paused", "complete"] as const)(
    "does not continue an overloaded goal that became %s",
    async (status) => {
      const context = await harness();
      try {
        const goal: ThreadGoal = {
          threadId: "thread",
          objective: "Finish work",
          status: "active",
          tokenBudget: 10,
          tokensUsed: 10,
          timeUsedSeconds: 20,
          createdAt: 1,
          updatedAt: 2,
        };
        context.bridge.emit("notification", {
          method: "thread/goal/updated",
          params: { threadId: "thread", goal },
        });
        context.bridge.emit("notification", {
          method: "turn/started",
          params: { threadId: "thread", turn: testTurn("failed", "inProgress") },
        });
        context.bridge.emit("notification", {
          method: "thread/goal/updated",
          params: { threadId: "thread", goal: { ...goal, status } },
        });
        context.bridge.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread",
            turn: {
              ...testTurn("failed", "failed"),
              error: {
                message: "Model overload",
                codexErrorInfo: "serverOverloaded",
                additionalDetails: null,
                misalignment: null,
              },
            },
          },
        });
        await vi.waitFor(() => expect(context.projection.summary("thread")?.state).toBe("failed"));
        context.bridge.request.mockClear();
        await vi.advanceTimersByTimeAsync(2 * CAPACITY_RETRY_INTERVAL_MS);
        expect(context.store.view().threadMeta.thread?.capacityRetry).toBeUndefined();
        expect(context.bridge.request).not.toHaveBeenCalled();
      } finally {
        await context.app.close();
      }
    },
  );

  it.each([1, undefined])(
    "reconciles a lost start reply with receiver version %s without a second model turn",
    async (version) => {
      const context = await harness();
      try {
        context.bridge.deliveryVersion = version;
        await fail(context);
        const original = context.bridge.request.getMockImplementation()!;
        let loseReply = true;
        context.bridge.request.mockImplementation(async (method, params) => {
          const response = await original(method, params);
          if (method === "turn/start" && loseReply) {
            loseReply = false;
            throw new RpcTimeoutError("turn/start", 30_000);
          }
          return response;
        });
        const deadline = context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt;
        await vi.advanceTimersByTimeAsync(deadline - Date.now());
        await vi.waitFor(() => expect(loseReply).toBe(false));
        await vi.waitFor(() =>
          expect(
            context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt,
          ).toBeGreaterThan(Date.now()),
        );
        const turnId = await retry(context);
        expect(turnId).toContain("capacity-turn");
        expect(context.bridge.managedTurnSequences.get("thread")).toBe(1);
        expect(
          context.bridge.request.mock.calls.filter(([method]) => method === "turn/start"),
        ).toHaveLength(1);
      } finally {
        await context.app.close();
      }
    },
  );

  it("restores an overdue persisted retry once after a server restart", async () => {
    const context = await harness();
    await fail(context);
    const deadline = context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt;
    await context.app.close();
    const store = new StateStore(context.store.path);
    await store.load();
    expect(store.view().threadMeta.thread?.capacityRetry?.nextAttemptAt).toBe(deadline);
    vi.setSystemTime(deadline + 20 * CAPACITY_RETRY_INTERVAL_MS);
    const bridge = new SettingsBridge();
    bridge.threadTurns = context.bridge.threadTurns;
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    const app = await buildApp(
      loadConfig({ statePath: store.path, clientDist: join(dirname(store.path), "missing") }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
      },
    );
    try {
      await app.ready();
      await nextImmediate();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(store.view().threadMeta.thread?.capacityRetry).toBeUndefined());
      expect(bridge.managedTurnSequences.get("thread")).toBe(1);
      expect(projection.summary("thread")?.currentTurnId).toContain("capacity-turn");
    } finally {
      await app.close();
    }
  });

  it("recovers the next blocked goal revision after losing its continuation events", async () => {
    const context = await harness();
    try {
      const goal: ThreadGoal = {
        threadId: "thread",
        objective: "Finish work",
        status: "active",
        tokenBudget: null,
        tokensUsed: 10,
        timeUsedSeconds: 20,
        createdAt: 1,
        updatedAt: 2,
      };
      context.bridge.emit("notification", {
        method: "thread/goal/updated",
        params: { threadId: "thread", goal },
      });
      context.bridge.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread", turn: testTurn("capacity-0", "inProgress") },
      });
      const blocked = { ...goal, status: "blocked" as const, updatedAt: 3 };
      context.bridge.emit("notification", {
        method: "thread/goal/updated",
        params: { threadId: "thread", goal: blocked },
      });
      const failed = await fail(context);
      await context.store.update((state) => {
        state.threadMeta.thread!.capacityRetry!.dispatching = true;
      });
      // The native continuation ran while Nest was disconnected and failed again.
      context.bridge.goal = { ...blocked, updatedAt: 4 };
      context.bridge.threadTurns.set("thread", [failed, { ...failed, id: "native-goal-retry" }]);
      const deadline = context.store.view().threadMeta.thread!.capacityRetry!.nextAttemptAt;
      await vi.advanceTimersByTimeAsync(deadline - Date.now());
      await vi.waitFor(() =>
        expect(context.store.view().threadMeta.thread?.capacityRetry).toMatchObject({
          failedTurnId: "native-goal-retry",
          goal: { createdAt: 1, updatedAt: 4 },
        }),
      );
      await vi.advanceTimersByTimeAsync(CAPACITY_RETRY_INTERVAL_MS);
      await vi.waitFor(() => expect(context.bridge.goal?.status).toBe("active"));
      expect(
        context.bridge.request.mock.calls.filter(([method]) => method === "turn/start"),
      ).toHaveLength(0);
    } finally {
      await context.app.close();
    }
  });

  it.each([false, true])(
    "resumes only the goal blocked by overload; manually paused = %s",
    async (pause) => {
      const context = await harness();
      try {
        const goal: ThreadGoal = {
          threadId: "thread",
          objective: "Finish work",
          status: "active",
          tokenBudget: null,
          tokensUsed: 10,
          timeUsedSeconds: 20,
          createdAt: 1,
          updatedAt: 2,
        };
        context.bridge.goal = goal;
        context.bridge.emit("notification", {
          method: "thread/goal/updated",
          params: { threadId: "thread", goal },
        });
        context.bridge.emit("notification", {
          method: "turn/started",
          params: { threadId: "thread", turn: testTurn("capacity-0", "inProgress") },
        });
        goal.status = "blocked";
        goal.updatedAt = 3;
        context.bridge.emit("notification", {
          method: "thread/goal/updated",
          params: { threadId: "thread", goal },
        });
        await fail(context);
        expect(context.store.view().threadMeta.thread!.capacityRetry!.goal).toMatchObject({
          createdAt: 1,
          updatedAt: 3,
        });
        context.bridge.request.mockClear();
        if (pause) {
          const response = await context.app.inject({
            method: "PATCH",
            url: "/api/v1/threads/thread/goal",
            headers: context.headers,
            payload: { status: "paused" },
          });
          expect(response.statusCode).toBe(200);
        }
        await vi.advanceTimersByTimeAsync(CAPACITY_RETRY_INTERVAL_MS);
        await vi.waitFor(() =>
          expect(context.store.view().threadMeta.thread?.capacityRetry).toBeUndefined(),
        );
        expect(context.bridge.goal?.status).toBe(pause ? "paused" : "active");
        expect(
          context.bridge.request.mock.calls.filter(([method]) => method === "turn/start"),
        ).toHaveLength(0);
        expect(
          context.bridge.request.mock.calls.filter(
            ([method, params]) => method === "thread/goal/set" && params?.status === "active",
          ),
        ).toHaveLength(pause ? 0 : 1);
      } finally {
        await context.app.close();
      }
    },
  );

  it("keeps managed tasks running across overload, skips watchdogs, and delivers their eventual result", async () => {
    const context = await harness("team");
    try {
      const spawned = dynamicToolJson(
        await callTeamTool(context.bridge, "thread", "spawn_task", {
          title: "Capacity child",
          prompt: "Finish the assigned work.",
        }),
      );
      const threadId = String(spawned.threadId);
      const taskId = String(spawned.taskId);
      await vi.waitFor(() =>
        expect(
          context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]?.status,
        ).toBe("running"),
      );
      const task = context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]!;
      const dependent = dynamicToolJson(
        await callTeamTool(context.bridge, "thread", "spawn_task", {
          title: "Dependent child",
          prompt: "Use the completed result.",
          dependsOn: [taskId],
        }),
      );
      await fail(context, task.childTurnId!, threadId);
      expect(context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]?.status).toBe(
        "running",
      );
      expect(
        context.store.view().threadMeta.thread!.teamOrchestration!.tasks[String(dependent.taskId)]
          ?.status,
      ).toBe("queued");
      expect(
        await triggerTeamWatchdogs(context.store, new Map(), Date.now() + 60 * 60_000),
      ).toEqual(new Set());
      context.bridge.request.mockClear();
      const turnId = await retry(context, threadId);
      expect(
        context.bridge.request.mock.calls.find(([method]) => method === "turn/start")?.[1],
      ).toMatchObject({ model: "gpt-5.6-sol", effort: "high", cwd: "/work" });
      expect(
        context.bridge.request.mock.calls.filter(([method]) => method === "thread/start"),
      ).toHaveLength(0);
      expect(
        context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]?.childTurnId,
      ).toBe(turnId);
      context.bridge.emit("notification", {
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            ...testTurn(turnId, "completed"),
            itemsView: "full",
            items: [agentMessage("result", "Finished work")],
          },
        },
      });
      await vi.waitFor(() =>
        expect(
          context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]?.status,
        ).toBe("completed"),
      );
      await vi.waitFor(() =>
        expect(
          context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]?.delivery
            ?.status,
        ).toBe("delivered"),
      );
      await vi.waitFor(() =>
        expect(
          context.store.view().threadMeta.thread!.teamOrchestration!.tasks[String(dependent.taskId)]
            ?.status,
        ).toBe("running"),
      );
    } finally {
      await context.app.close();
    }
  });

  it("cancels a waiting managed task through Stop without interrupting its old failed turn", async () => {
    const context = await harness("team");
    try {
      const spawned = dynamicToolJson(
        await callTeamTool(context.bridge, "thread", "spawn_task", {
          title: "Cancel child",
          prompt: "Finish the assigned work.",
        }),
      );
      const threadId = String(spawned.threadId),
        taskId = String(spawned.taskId);
      await vi.waitFor(() =>
        expect(
          context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]?.status,
        ).toBe("running"),
      );
      await fail(
        context,
        context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]!.childTurnId!,
        threadId,
      );
      context.bridge.request.mockClear();
      const response = await context.app.inject({
        method: "POST",
        url: `/api/v1/threads/${threadId}/interrupt`,
        headers: context.headers,
        payload: {},
      });
      expect(response.statusCode).toBe(204);
      expect(context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]?.status).toBe(
        "interrupted",
      );
      expect(
        context.bridge.request.mock.calls.filter(([method]) => method === "turn/interrupt"),
      ).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2 * CAPACITY_RETRY_INTERVAL_MS);
      expect(
        context.bridge.request.mock.calls.filter(
          ([method, params]) => method === "turn/start" && params?.threadId === threadId,
        ),
      ).toHaveLength(0);
    } finally {
      await context.app.close();
    }
  });

  it("delivers a managed result completed before a lost retry acknowledgement", async () => {
    const context = await harness("team");
    try {
      const spawned = dynamicToolJson(
        await callTeamTool(context.bridge, "thread", "spawn_task", {
          title: "Fast result",
          prompt: "Finish the assigned work.",
        }),
      );
      const threadId = String(spawned.threadId),
        taskId = String(spawned.taskId);
      await vi.waitFor(() =>
        expect(
          context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]?.status,
        ).toBe("running"),
      );
      await fail(
        context,
        context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]!.childTurnId!,
        threadId,
      );
      const original = context.bridge.request.getMockImplementation()!;
      context.bridge.request.mockImplementation(async (method, params) => {
        const response = await original(method, params);
        if (method === "turn/start" && params?.threadId === threadId) {
          const started = (response as { turn: Turn }).turn;
          const finished: Turn = {
            ...started,
            status: "completed",
            itemsView: "full",
            items: [agentMessage("fast-result", "Finished work")],
          };
          context.bridge.threadTurns.set(threadId, [
            ...context.bridge.threadTurns.get(threadId)!.slice(0, -1),
            finished,
          ]);
          context.bridge.emit("notification", {
            method: "turn/completed",
            params: { threadId, turn: finished },
          });
          throw new RpcTimeoutError("turn/start", 30_000);
        }
        return response;
      });
      const deadline = context.store.view().threadMeta[threadId]!.capacityRetry!.nextAttemptAt;
      await vi.advanceTimersByTimeAsync(deadline - Date.now());
      await vi.waitFor(() =>
        expect(
          context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]?.status,
        ).toBe("completed"),
      );
      await vi.waitFor(() =>
        expect(
          context.store.view().threadMeta.thread!.teamOrchestration!.tasks[taskId]?.delivery
            ?.status,
        ).toBe("delivered"),
      );
      await vi.advanceTimersByTimeAsync(2 * CAPACITY_RETRY_INTERVAL_MS);
      expect(context.bridge.managedTurnSequences.get(threadId)).toBe(2);
    } finally {
      await context.app.close();
    }
  });

  it.each([
    "usageLimitExceeded",
    "contextWindowExceeded",
    "unauthorized",
    "internalServerError",
  ] as const)("does not retry %s", async (code) => {
    const context = await harness();
    try {
      const turn: Turn = {
        ...testTurn("failed", "failed"),
        error: {
          message: "Other error",
          codexErrorInfo: code,
          additionalDetails: null,
          misalignment: null,
        },
      };
      context.bridge.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread", turn: testTurn("failed", "inProgress") },
      });
      context.bridge.emit("notification", {
        method: "turn/completed",
        params: { threadId: "thread", turn },
      });
      await vi.waitFor(() => expect(context.projection.summary("thread")?.state).toBe("failed"));
      context.bridge.request.mockClear();
      await vi.advanceTimersByTimeAsync(2 * CAPACITY_RETRY_INTERVAL_MS);
      expect(context.bridge.request).not.toHaveBeenCalled();
      expect(context.store.view().threadMeta.thread?.capacityRetry).toBeUndefined();
    } finally {
      await context.app.close();
    }
  });
});

describe("plan dismissal", () => {
  async function harness() {
    const context = await createTeamHarness();
    const turn: Turn = {
      ...testTurn("plan-turn", "completed"),
      itemsView: "full",
      items: [{ type: "plan", id: "plan", text: "Implementation plan" }],
    };
    context.bridge.threadTurns.set("thread", [turn]);
    context.projection.upsertThread({ ...testThread(), updatedAt: 10, turns: [turn] });
    await context.store.update((state) => {
      Object.assign(state.threadMeta.thread!, {
        settings: { collaborationMode: "plan" },
        awaitingPlanResponse: true,
        lastOutcome: "completed",
        outcomeUpdatedAt: 10_000,
        lastReadUpdatedAt: 0,
        lastViewedUpdatedAt: 10_000,
      });
    });
    await context.projection.readThread("thread");
    await context.app.ready();
    await nextImmediate();
    context.bridge.request.mockClear();
    return context;
  }
  const payload = { turnId: "plan-turn", observedUpdatedAt: 10_000 };
  const url = "/api/v1/threads/thread/plan/dismiss";

  it("persists dismissal without RPCs, messages, mode changes or finishing the session", async () => {
    const { app, bridge, headers, store, projection } = await harness();
    const events: ServerEvent[] = [];
    projection.on("event", (_sequence, event: ServerEvent) => events.push(event));
    try {
      const before = store.snapshot().threadMeta.thread!;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.inject({ method: "POST", url, headers, payload });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          state: "completed",
          unread: true,
          unseen: false,
          awaitingPlanResponse: false,
          dismissedPlanTurnId: "plan-turn",
          currentTurnId: null,
          queuedMessageCount: 0,
          settings: before.settings,
        });
      }
      expect(bridge.request).not.toHaveBeenCalled();
      expect(store.view().messageQueues?.thread ?? []).toEqual([]);
      expect(store.view().threadMeta.thread!.lastReadUpdatedAt).toBe(before.lastReadUpdatedAt);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "thread.upserted",
          thread: expect.objectContaining({ state: "completed" }),
        }),
      );
      const reloaded = new StateStore(store.path);
      await reloaded.load();
      expect(reloaded.view().threadMeta.thread).toMatchObject({
        awaitingPlanResponse: false,
        dismissedPlanTurnId: "plan-turn",
      });
      const finish = await app.inject({
        method: "PUT",
        url: "/api/v1/threads/thread/read",
        headers,
        payload: { observedUpdatedAt: 10_000 },
      });
      expect(finish.statusCode).toBe(204);
      expect(projection.summary("thread")).toMatchObject({ state: "completed", unread: false });
    } finally {
      await app.close();
    }
  });

  it("keeps an imported plan green until Finish and does not reopen it on a retry", async () => {
    const { app, headers, store, projection } = await harness();
    await store.update((state) => {
      state.threadMeta.thread!.lastReadUpdatedAt = 10_000;
    });
    try {
      const response = await app.inject({ method: "POST", url, headers, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ state: "completed", unread: true });
      await projection.markRead("thread", 10_000);
      const retry = await app.inject({ method: "POST", url, headers, payload });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ state: "completed", unread: false });
    } finally {
      await app.close();
    }
  });

  it.each(["old-turn", "old-version", "running", "queued", "new-plan"])(
    "rejects %s without clearing attention",
    async (scenario) => {
      const { app, headers, store, projection, bridge } = await harness();
      const request = { ...payload };
      if (scenario === "old-turn") request.turnId = "old-plan";
      if (scenario === "old-version") request.observedUpdatedAt = 9_000;
      if (scenario === "running") await projection.setCurrentTurn("thread", "working");
      if (scenario === "queued")
        await store.update((state) => {
          state.messageQueues = {
            thread: [
              {
                id: "queued",
                threadId: "thread",
                text: "Clarification",
                createdAt: 1,
                status: "queued",
              },
            ],
          };
        });
      if (scenario === "new-plan") {
        const turn: Turn = {
          ...testTurn("new-plan", "completed"),
          itemsView: "full",
          items: [{ type: "plan", id: "new", text: "New plan" }],
        };
        bridge.threadTurns.set("thread", [turn]);
        projection.upsertThread({ ...testThread(), updatedAt: 10, turns: [turn] });
      }
      const before = store.view().threadMeta.thread!.awaitingPlanResponse;
      try {
        const response = await app.inject({ method: "POST", url, headers, payload: request });
        expect(response.statusCode).toBe(409);
        expect(store.view().threadMeta.thread).toMatchObject({ awaitingPlanResponse: before });
        expect(store.view().threadMeta.thread!.dismissedPlanTurnId).toBeUndefined();
        expect(bridge.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
      } finally {
        await app.close();
      }
    },
  );

  it("validates the request and thread before dismissing", async () => {
    const { app, headers, store } = await harness();
    try {
      for (const body of [
        {},
        { ...payload, turnId: "" },
        { ...payload, observedUpdatedAt: "10000" },
      ]) {
        expect((await app.inject({ method: "POST", url, headers, payload: body })).statusCode).toBe(
          400,
        );
      }
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/threads/missing/plan/dismiss",
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(404);
      expect(store.view().threadMeta.thread!.awaitingPlanResponse).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("does not dismiss while a turn start holds the session lock", async () => {
    const { app, headers, bridge, store } = await harness();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    bridge.parentTurnStartEntered = started;
    bridge.parentTurnStartGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const start = app
        .inject({
          method: "POST",
          url: "/api/v1/threads/thread/turns",
          headers,
          payload: { input: "Continue", clientMessageId: "continue-plan" },
        })
        .then((response) => response);
      await entered;
      const dismissal = app
        .inject({ method: "POST", url, headers, payload })
        .then((response) => response);
      release();
      expect((await start).statusCode).toBe(201);
      expect((await dismissal).statusCode).toBe(409);
      expect(store.view().threadMeta.thread!.dismissedPlanTurnId).toBeUndefined();
    } finally {
      release();
      await app.close();
    }
  });
});

describe("durable plan acceptance", () => {
  it.each(["default", "goal", "team"] as const)(
    "persists %s acceptance before switching mode, and replays it once",
    async (mode) => {
      const { app, bridge, headers, store, projection } = await createTeamHarness();
      await projection.setSettings("thread", { collaborationMode: "plan", model: "gpt-a" });
      await store.update((state) => {
        state.threadMeta.thread!.awaitingPlanResponse = true;
      });
      const original = bridge.request.getMockImplementation()!;
      bridge.request.mockImplementation(async (method, params = {}) => {
        if (method === "turn/start") {
          expect(store.view().messageQueues?.thread).toEqual([
            expect.objectContaining({ id: "accept-plan", planImplementationMode: mode }),
          ]);
          expect(store.view().threadMeta.thread?.settings?.collaborationMode).toBe(
            mode === "team" ? "team" : "default",
          );
        }
        return original(method, params);
      });
      const payload = {
        input: "Implement the plan",
        clientMessageId: "accept-plan",
        planImplementationMode: mode,
      };
      try {
        const accepted = await app.inject({
          method: "POST",
          url: "/api/v1/threads/thread/queue",
          headers,
          payload,
        });
        expect(accepted.statusCode).toBe(202);
        expect(accepted.json()).toMatchObject({ planImplementationMode: mode });
        await vi.waitFor(() =>
          expect(store.view().messageReceipts?.["accept-plan"]?.status).toBe("delivered"),
        );
        expect(projection.summary("thread")).toMatchObject({
          currentTurnId: "turn",
          state: "running",
          awaitingPlanResponse: false,
        });
        const start = bridge.request.mock.calls.find(([method]) => method === "turn/start")![1];
        expect(start).toMatchObject({ collaborationMode: { mode: "default" } });
        expect(start.additionalContext).not.toHaveProperty("codexnest.plan");
        if (mode === "goal") expect(bridge.goal?.status).toBe("active");
        const replay = await app.inject({
          method: "POST",
          url: "/api/v1/threads/thread/queue",
          headers,
          payload,
        });
        expect(replay.statusCode).toBe(202);
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "turn/start"),
        ).toHaveLength(1);
        const conflict = await app.inject({
          method: "POST",
          url: "/api/v1/threads/thread/queue",
          headers,
          payload: { ...payload, planImplementationMode: mode === "team" ? "default" : "team" },
        });
        expect(conflict.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    },
  );

  it("keeps an incompatible Team request visible and leaves the session in Plan mode", async () => {
    const { app, bridge, headers, store, projection } = await createTeamHarness();
    await projection.setSettings("thread", { collaborationMode: "plan", model: "gpt-a" });
    await store.update((state) => {
      delete state.threadMeta.thread!.managedTeamToolsAvailable;
    });
    try {
      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/queue",
        headers,
        payload: {
          input: "Implement",
          clientMessageId: "bad-team",
          planImplementationMode: "team",
        },
      });
      expect(accepted.statusCode).toBe(202);
      await vi.waitFor(() =>
        expect(store.view().messageQueues?.thread?.[0]?.deliveryError).toMatchObject({
          retryable: false,
          message: expect.stringContaining("managed Team tools"),
        }),
      );
      expect(projection.summary("thread")?.settings.collaborationMode).toBe("plan");
      expect(bridge.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it.each([
    { planImplementationMode: "plan" },
    { planImplementationMode: "team", goal: true },
    {
      planImplementationMode: "default",
      replyToAsyncQuestion: { turnId: "turn", itemId: "question" },
    },
  ])("rejects an invalid plan command before changing settings: %j", async (extra) => {
    const { app, bridge, headers, projection } = await createTeamHarness();
    await projection.setSettings("thread", { collaborationMode: "plan", model: "gpt-a" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/queue",
        headers,
        payload: { input: "Implement", clientMessageId: "invalid-plan", ...extra },
      });
      expect(response.statusCode).toBe(400);
      expect(projection.summary("thread")?.settings.collaborationMode).toBe("plan");
      expect(bridge.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("pasted text delivery", () => {
  it("keeps full context for the model and original Markdown in history and drafts", async () => {
    const { app, bridge, headers } = await createSkillsHarness();
    const pastes = {
      inlinePastes: [{ id: "short", start: 6, end: 13 }],
      pasteBlocks: [{ id: "long", text: "## Original\n- value 42\n```\n$review\n```" }],
    };
    const input = "Check $review please";
    await app.inject({ url: "/api/v1/skills?cwd=%2Fwork", headers });
    const draft = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread/draft",
      headers,
      payload: { input, ...pastes, images: [], goalMode: false, annotations: [] },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ input, ...pastes });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { input, ...pastes, clientMessageId: "paste-message" },
    });
    expect(response.statusCode).toBe(201);
    const command = bridge.request.mock.calls.find(([method]) => method === "turn/start")![1];
    const nativeInput = command.input as Array<{ type: string; text?: string }>;
    expect(nativeInput.find((item) => item.type === "text")?.text).toContain(
      pastes.pasteBlocks[0]!.text,
    );
    expect(nativeInput.find((item) => item.type === "text")?.text).toContain(
      "Check <pasted_text>$review</pasted_text> please",
    );
    expect(nativeInput.some((item) => item.type === "skill")).toBe(false);
    const detail = await app.inject({ url: "/api/v1/threads/thread", headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().turns.flatMap((turn: { items: unknown[] }) => turn.items)).toContainEqual(
      expect.objectContaining({ id: "paste-message", type: "userMessage", text: input, ...pastes }),
    );
    await app.close();
  });

  it("accepts a block-only message and rejects invalid ranges before delivery", async () => {
    const { app, bridge, headers } = await createSkillsHarness();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: {
        input: "abc",
        inlinePastes: [{ id: "bad", start: 0, end: 4 }],
        clientMessageId: "invalid",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(bridge.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    const draftBody = {
      input: "",
      pasteBlocks: [{ id: "log", text: "a\nb" }],
      images: [],
      goalMode: false,
      annotations: [],
    };
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread/draft",
      headers,
      payload: draftBody,
    });
    expect(saved.json()).toMatchObject(draftBody);
    const replay = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread/draft?expectedUpdatedAt=none",
      headers,
      payload: draftBody,
    });
    expect(replay.statusCode).toBe(200);
    const conflict = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread/draft?expectedUpdatedAt=none",
      headers,
      payload: { ...draftBody, pasteBlocks: [{ id: "log", text: "changed" }] },
    });
    expect(conflict.statusCode).toBe(409);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: {
        input: "",
        pasteBlocks: [{ id: "log", text: "a\nb" }],
        clientMessageId: "only-block",
      },
    });
    expect(response.statusCode).toBe(201);
    const detail = await app.inject({ url: "/api/v1/threads/thread", headers });
    expect(detail.json().turns.flatMap((turn: { items: unknown[] }) => turn.items)).toContainEqual(
      expect.objectContaining({
        id: "only-block",
        text: "",
        pasteBlocks: [{ id: "log", text: "a\nb" }],
      }),
    );
    await app.close();
  });
});

describe("HTTP authentication", () => {
  it("gates mutations until recovery and exposes a token-protected restart drain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-recovery-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    const tokenPath = join(directory, "restart-token");
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => true,
      checkpoint: () => store.checkpoint(),
      drainLeaseMs: 1_000,
    });
    await lifecycle.initialize();
    const appManager = {
      forceRestart: vi.fn(async () => ({ accepted: true as const })),
    } as unknown as AppManager;
    const codexManager = {
      maintenanceActive: false,
      forceRestart: vi.fn(async () => ({
        operation: "idle",
      })),
    } as unknown as CodexManager;
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        lifecycle,
        appManager,
        codexManager,
      },
    );
    const headers = { authorization: "Bearer correct" };
    expect((await app.inject({ url: "/api/v1/health" })).json()).toMatchObject({
      status: "degraded",
      recoveryState: "starting",
      restartProtocolVersion: 2,
      transport: "daemon",
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/settings/ui-language",
          headers,
          payload: { language: "ru" },
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/settings/app/force-restart",
        })
      ).statusCode,
    ).toBe(401);

    lifecycle.ready();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/settings/ui-language",
          headers,
          payload: { language: "ru" },
        })
      ).statusCode,
    ).toBe(200);
    const token = (await readFile(tokenPath, "utf8")).trim();
    await store.update((state) => {
      state.threadMeta["managed-parent"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedTeamToolsAvailable: true,
        teamOrchestration: {
          tasks: {
            managed: {
              id: "managed",
              childThreadId: "managed-child",
              title: "Managed recovery",
              prompt: "Remain recoverable across restart.",
              status: "running",
              createdAt: 1,
              lastActivityAt: 1,
            },
          },
        },
      };
    });
    const prepared = await app.inject({
      method: "POST",
      url: "/api/v1/internal/restart/prepare",
      headers: { "x-codexnest-restart-token": token },
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({
      recoveryState: "draining",
      transport: "daemon",
      hasManagedWork: true,
      quiescent: false,
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/settings/ui-language",
          headers,
          payload: { language: "en" },
        })
      ).statusCode,
    ).toBe(503);
    const appRestart = await app.inject({
      method: "POST",
      url: "/api/v1/settings/app/force-restart",
      headers,
    });
    expect(appRestart.statusCode).toBe(202);
    expect(appRestart.json()).toEqual({ accepted: true });
    const codexRestart = await app.inject({
      method: "POST",
      url: "/api/v1/settings/codex/force-restart",
      headers,
    });
    expect(codexRestart.statusCode).toBe(200);
    expect(appManager.forceRestart).toHaveBeenCalledOnce();
    expect(codexManager.forceRestart).toHaveBeenCalledOnce();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/internal/restart/resume",
          headers: { "x-codexnest-restart-token": token },
        })
      ).statusCode,
    ).toBe(204);
    expect(lifecycle.state).toBe("ready");
    await store.update((state) => {
      const task = state.threadMeta["managed-parent"]?.teamOrchestration?.tasks.managed;
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = "managed-terminal";
      task.result = { outcome: "success", summary: "Recovered", source: "status" };
      task.delivery = {
        status: "delivered",
        claimId: "managed-claim",
        parentTurnId: "parent-terminal",
      };
    });
    const historyOnly = await app.inject({
      method: "POST",
      url: "/api/v1/internal/restart/prepare",
      headers: { "x-codexnest-restart-token": token },
    });
    expect(historyOnly.json()).toMatchObject({ hasManagedWork: false, quiescent: true });
    await lifecycle.resume(token);
    await app.close();
    await lifecycle.close();
  });

  it("releases mutation tracking after the handler settles despite a client disconnect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-aborted-mutation-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    const tokenPath = join(directory, "restart-token");
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => true,
      checkpoint: () => store.checkpoint(),
      drainTimeoutMs: 500,
    });
    await lifecycle.initialize();
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        lifecycle,
      },
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    app.put("/api/v1/test/slow-mutation", async () => {
      markStarted();
      await handlerGate;
      await store.update((state) => {
        state.uiLanguage = "ru";
      });
      return { ok: true };
    });
    lifecycle.ready();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${address.port}/api/v1/test/slow-mutation`, {
      method: "PUT",
      headers: { authorization: "Bearer correct" },
      signal: controller.signal,
    }).then(
      () => "completed",
      () => "aborted",
    );
    await started;
    controller.abort();
    await expect(response).resolves.toBe("aborted");

    const token = (await readFile(tokenPath, "utf8")).trim();
    let prepared = false;
    const preparing = lifecycle.prepare(token).then(() => {
      prepared = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(prepared).toBe(false);

    releaseHandler();
    await preparing;
    expect(lifecycle.state).toBe("draining");
    await lifecycle.resume(token);
    expect(lifecycle.state).toBe("ready");
    await app.close();
    await lifecycle.close();
  });

  it("recovers to ready while preserving accepted messages for missing sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-startup-recovery-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
      state.threadMeta["queued-thread"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      state.messageQueues = {
        "queued-thread": [
          {
            id: "queued-message",
            threadId: "queued-thread",
            text: "Recover me",
            createdAt: 1,
            status: "dispatching",
          },
        ],
      };
    });
    const bridge = new EventEmitter() as EventEmitter & {
      state: "ready";
      request: ReturnType<typeof vi.fn>;
    };
    bridge.state = "ready";
    bridge.request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "thread/list") {
        if (params.archived) return { data: [], nextCursor: null, backwardsCursor: null };
        return {
          data: [
            {
              ...testThread("orphan-thread"),
              status: { type: "idle" as const },
              updatedAt: 5,
              recencyAt: 5,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list" && params.threadId === "orphan-thread") {
        throw new RpcError(-32_600, "no rollout found for thread id orphan-thread");
      }
      if (method === "thread/turns/list" && params.threadId === "queued-thread") {
        throw new RpcError(-32_600, "no rollout found for thread id queued-thread");
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      if (method === "thread/turns/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    const tokenPath = join(directory, "restart-token");
    const lifecycle = new RuntimeLifecycle({
      transport: "daemon",
      tokenPath,
      bridgeReady: () => true,
      checkpoint: () => store.checkpoint(),
      drainLeaseMs: 1_000,
    });
    await lifecycle.initialize();
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        lifecycle,
      },
    );
    lifecycle.syncing();
    await projection.sync();
    await vi.waitFor(() => expect(lifecycle.state).toBe("ready"));
    expect(store.snapshot().threadMeta["orphan-thread"]).toBeUndefined();
    expect(store.snapshot().threadMeta["queued-thread"]).toBeDefined();
    expect(store.snapshot().messageQueues?.["queued-thread"]).toMatchObject([
      { id: "queued-message", text: "Recover me", deliveryError: { retryable: false } },
    ]);
    await app.close();
    await lifecycle.close();
  });

  it("keeps health public and rejects missing, query, and bad tokens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => "0.145.0",
      spawnProcess: () => {
        throw new Error("not started");
      },
    });
    await bridge.start();
    bridge.stop();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge, store, attention);
    const config = loadConfig({
      statePath: store.path,
      clientDist: join(directory, "missing"),
      allowedOrigins: new Set(["http://localhost"]),
      websocketAuthTimeoutMs: 25,
    });
    const app = await buildApp(config, {
      bridge,
      store,
      projection,
      attention,
      projectRoot: directory,
    });

    const health = await app.inject({ url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "degraded",
      appServer: {
        state: "unavailable",
        installedVersion: "0.145.0",
        message: "Codex app-server is unavailable",
      },
    });
    expect(health.json().appServer).not.toHaveProperty("expectedVersion");
    expect((await app.inject({ url: "/api/v1/summary" })).json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect((await app.inject({ url: "/api/v1/settings/codex" })).json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect((await app.inject({ url: "/api/v1/summary?token=correct" })).json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(
      (await app.inject({ url: "/api/v1/summary", headers: { authorization: "Bearer wrong" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({ url: "/api/v1/summary", headers: { authorization: "Bearer correct" } })
      ).json(),
    ).toMatchObject({ threadCount: 0 });
    expect(
      (
        await app.inject({
          url: "/api/v1/summary",
          headers: { origin: "https://evil.example", authorization: "Bearer correct" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/v1/summary",
          headers: {
            host: "codexnest.home:4310",
            origin: "http://codexnest.home:4310",
            authorization: "Bearer correct",
          },
        })
      ).statusCode,
    ).toBe(200);

    const authorization = { authorization: "Bearer correct" };
    const languageChanged = new Promise<Record<string, unknown>>((resolve) => {
      const listener = (_sequence: number, event: Record<string, unknown>) => {
        if (event.type !== "uiLanguage.changed") return;
        projection.off("event", listener);
        resolve(event);
      };
      projection.on("event", listener);
    });
    const languageUpdate = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/ui-language",
      headers: authorization,
      payload: { language: "ru" },
    });
    expect(languageUpdate.statusCode).toBe(200);
    expect(languageUpdate.json()).toEqual({ language: "ru" });
    expect(store.snapshot().uiLanguage).toBe("ru");
    expect(projection.snapshot().uiLanguage).toBe("ru");
    await expect(languageChanged).resolves.toEqual({
      type: "uiLanguage.changed",
      language: "ru",
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/settings/ui-language",
          headers: authorization,
          payload: { language: "de" },
        })
      ).statusCode,
    ).toBe(400);

    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const listing = await app.inject({ url: "/api/v1/directories", headers: authorization });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({
      rootPath: directory,
      path: directory,
      parentPath: null,
      directories: [{ name: "workspace", path: workspace }],
    });

    const createdDirectory = await app.inject({
      method: "POST",
      url: "/api/v1/directories",
      headers: authorization,
      payload: { parentPath: workspace, name: "new-project" },
    });
    expect(createdDirectory.statusCode).toBe(201);
    const createdPath = join(workspace, "new-project");
    expect(createdDirectory.json()).toEqual({
      rootPath: directory,
      path: createdPath,
      parentPath: workspace,
      directories: [],
    });
    const duplicateDirectory = await app.inject({
      method: "POST",
      url: "/api/v1/directories",
      headers: authorization,
      payload: { parentPath: workspace, name: "new-project" },
    });
    expect(duplicateDirectory.statusCode).toBe(409);
    expect(duplicateDirectory.json()).toMatchObject({ error: { code: "conflict" } });

    const createdProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: authorization,
      payload: { path: createdPath },
    });
    expect(createdProject.statusCode).toBe(201);
    expect(createdProject.json()).toMatchObject({
      displayName: "new-project",
      path: await realpath(createdPath),
    });

    const legacyPath = join(workspace, "legacy-project");
    await mkdir(legacyPath);
    const legacyProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: authorization,
      payload: { path: legacyPath, displayName: "Ignored manual name" },
    });
    expect(legacyProject.statusCode).toBe(201);
    expect(legacyProject.json()).toMatchObject({ displayName: "legacy-project" });

    const reorderedEvent = new Promise<Record<string, unknown>>((resolve) => {
      const listener = (_sequence: number, event: Record<string, unknown>) => {
        if (event.type !== "projects.reordered") return;
        projection.off("event", listener);
        resolve(event);
      };
      projection.on("event", listener);
    });
    const movedProject = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${legacyProject.json().id as string}/move`,
      headers: authorization,
      payload: { direction: "up" },
    });
    expect(movedProject.statusCode).toBe(200);
    expect(
      movedProject.json().map((project: { displayName: string }) => project.displayName),
    ).toEqual(["legacy-project", "new-project"]);
    await expect(reorderedEvent).resolves.toMatchObject({
      type: "projects.reordered",
      projects: [{ displayName: "legacy-project" }, { displayName: "new-project" }],
    });
    expect(store.snapshot().projects.map((project) => project.displayName)).toEqual([
      "legacy-project",
      "new-project",
    ]);

    const targetReorderedEvent = new Promise<Record<string, unknown>>((resolve) => {
      const listener = (_sequence: number, event: Record<string, unknown>) => {
        if (event.type !== "projects.reordered") return;
        projection.off("event", listener);
        resolve(event);
      };
      projection.on("event", listener);
    });
    const targetMovedProject = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${legacyProject.json().id as string}/move`,
      headers: authorization,
      payload: { targetIndex: 1 },
    });
    expect(targetMovedProject.statusCode).toBe(200);
    expect(
      targetMovedProject.json().map((project: { displayName: string }) => project.displayName),
    ).toEqual(["new-project", "legacy-project"]);
    await expect(targetReorderedEvent).resolves.toMatchObject({
      type: "projects.reordered",
      projects: [{ displayName: "new-project" }, { displayName: "legacy-project" }],
    });
    expect(store.snapshot().projects.map((project) => project.displayName)).toEqual([
      "new-project",
      "legacy-project",
    ]);

    const boundaryMove = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${legacyProject.json().id as string}/move`,
      headers: authorization,
      payload: { direction: "down" },
    });
    expect(boundaryMove.statusCode).toBe(200);
    expect(boundaryMove.json().map((project: { id: string }) => project.id)).toEqual(
      store.snapshot().projects.map((project) => project.id),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/projects/missing/move",
          headers: authorization,
          payload: { direction: "up" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${createdProject.json().id as string}/move`,
          headers: authorization,
          payload: { direction: "sideways" },
        })
      ).statusCode,
    ).toBe(400);
    const publishProjectsReordered = vi.spyOn(projection, "publishProjectsReordered");
    const unchangedTargetMove = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${createdProject.json().id as string}/move`,
      headers: authorization,
      payload: { targetIndex: 0 },
    });
    expect(unchangedTargetMove.statusCode).toBe(200);
    expect(
      unchangedTargetMove.json().map((project: { displayName: string }) => project.displayName),
    ).toEqual(["new-project", "legacy-project"]);
    expect(publishProjectsReordered).not.toHaveBeenCalled();

    for (const payload of [
      {},
      { direction: "up", targetIndex: 0 },
      { targetIndex: -1 },
      { targetIndex: 0.5 },
      { targetIndex: null },
      { targetIndex: 2 },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/projects/${createdProject.json().id as string}/move`,
            headers: authorization,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }

    const outside = await app.inject({
      url: `/api/v1/directories?path=${encodeURIComponent(join(directory, ".."))}`,
      headers: authorization,
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json()).toMatchObject({ error: { code: "validation_failed" } });

    const missing = await app.inject({
      url: `/api/v1/directories?path=${encodeURIComponent(join(directory, "missing"))}`,
      headers: authorization,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "not_found" } });

    const locked = join(directory, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const forbidden = await app.inject({
        url: `/api/v1/directories?path=${encodeURIComponent(locked)}`,
        headers: authorization,
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ error: { code: "forbidden" } });
    } finally {
      await chmod(locked, 0o700);
    }

    await app.ready();
    const authorized = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    const snapshot = new Promise<Record<string, unknown>>((resolve) => {
      authorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    authorized.send(JSON.stringify({ type: "authenticate", token: "correct" }));
    const firstSnapshot = await snapshot;
    expect(firstSnapshot).toMatchObject({ type: "snapshot" });

    const secondAuthorized = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    const secondSnapshot = new Promise<Record<string, unknown>>((resolve) => {
      secondAuthorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    secondAuthorized.send(JSON.stringify({ type: "authenticate", token: "correct" }));
    await expect(secondSnapshot).resolves.toMatchObject({ type: "snapshot" });

    const firstEvent = new Promise<Record<string, unknown>>((resolve) => {
      authorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    const secondEvent = new Promise<Record<string, unknown>>((resolve) => {
      secondAuthorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    projection.upsertThread(testThread("broadcast"));
    const [firstBroadcast, secondBroadcast] = await Promise.all([firstEvent, secondEvent]);
    expect(firstBroadcast).toMatchObject({
      type: "event",
      sequence: expect.any(Number),
      version: {
        instanceId: expect.any(String),
        sequence: expect.any(Number),
      },
      event: { type: "thread.upserted" },
    });
    expect((firstBroadcast.version as { sequence: number }).sequence).toBe(firstBroadcast.sequence);
    expect((firstBroadcast.version as { instanceId: string }).instanceId).toBe(
      (firstSnapshot.snapshot as { instanceId: string }).instanceId,
    );
    expect(secondBroadcast).toEqual(firstBroadcast);

    const resynced = new Promise<Record<string, unknown>>((resolve) => {
      authorized.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    projection.emit("event", 999, { type: "resync.required" });
    await expect(resynced).resolves.toMatchObject({
      type: "snapshot",
      snapshot: {
        threads: [expect.objectContaining({ id: "broadcast" })],
      },
    });

    const backpressureFrames = websocketFrames(authorized);
    const unexpectedlyClosed = vi.fn();
    authorized.once("close", unexpectedlyClosed);
    authorized.pause();
    projection.upsertThread({
      ...testThread("large-broadcast-a"),
      preview: "a".repeat(1_500_000),
    });
    projection.upsertThread({
      ...testThread("large-broadcast-b"),
      preview: "b".repeat(1_000_000),
    });
    authorized.resume();

    let catchupSnapshot: Record<string, unknown>;
    do {
      catchupSnapshot = await backpressureFrames.nextType("snapshot");
    } while (
      !(catchupSnapshot.snapshot as { threads: Array<{ id: string }> }).threads.some(
        (thread) => thread.id === "large-broadcast-b",
      )
    );
    expect(unexpectedlyClosed).not.toHaveBeenCalled();

    const afterCatchup = backpressureFrames.nextType("event");
    projection.upsertThread(testThread("after-backpressure"));
    await expect(afterCatchup).resolves.toMatchObject({
      event: { type: "thread.upserted", thread: { id: "after-backpressure" } },
    });

    await projection.removeOrphanedThread("large-broadcast-a");
    await projection.removeOrphanedThread("large-broadcast-b");
    await projection.removeOrphanedThread("after-backpressure");

    authorized.terminate();
    secondAuthorized.terminate();

    const unauthorized = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    let unauthorizedMessages = 0;
    unauthorized.on("message", () => {
      unauthorizedMessages += 1;
    });
    const closed = new Promise<number>((resolve) => unauthorized.once("close", resolve));
    unauthorized.send(JSON.stringify({ type: "authenticate", token: "wrong" }));
    await expect(closed).resolves.toBe(1008);
    expect(unauthorizedMessages).toBe(0);

    await expect(
      app.injectWS("/api/v1/events?token=correct", { headers: { origin: "http://localhost" } }),
    ).rejects.toThrow("400");

    const idle = await app.injectWS("/api/v1/events", { headers: { origin: "http://localhost" } });
    const idleClosed = new Promise<number>((resolve) => idle.once("close", resolve));
    await expect(idleClosed).resolves.toBe(1008);

    await expect(
      app.injectWS("/api/v1/events", { headers: { origin: "https://evil.example" } }),
    ).rejects.toThrow();

    const lanOrigin = await app.injectWS("/api/v1/events", {
      headers: { host: "codexnest.home:4310", origin: "http://codexnest.home:4310" },
    });
    const lanSnapshot = new Promise<Record<string, unknown>>((resolve) => {
      lanOrigin.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    lanOrigin.send(JSON.stringify({ type: "authenticate", token: "correct" }));
    await expect(lanSnapshot).resolves.toMatchObject({ type: "snapshot" });
    lanOrigin.terminate();

    const revocable = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    const revocableSnapshot = new Promise<void>((resolve) =>
      revocable.once("message", () => resolve()),
    );
    revocable.send(JSON.stringify({ type: "authenticate", token: "correct" }));
    await revocableSnapshot;
    const revoked = new Promise<number>((resolve) => revocable.once("close", resolve));
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("rotated");
    });
    await expect(revoked).resolves.toBe(1008);

    const shutdownSocket = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost" },
    });
    const shutdownSnapshot = new Promise<void>((resolve) =>
      shutdownSocket.once("message", () => resolve()),
    );
    shutdownSocket.send(JSON.stringify({ type: "authenticate", token: "rotated" }));
    await shutdownSnapshot;
    const shutdownClosed = new Promise<void>((resolve) =>
      shutdownSocket.once("close", () => resolve()),
    );
    await expect(app.close()).resolves.toBeUndefined();
    await shutdownClosed;
  });
});

describe("skills API and explicit invocation", () => {
  it("lists installed skills for an allowed cwd and toggles a discovered path", async () => {
    const harness = await createSkillsHarness();

    const listed = await harness.app.inject({
      url: "/api/v1/skills?cwd=%2Fwork&forceReload=true",
      headers: harness.headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ cwd: "/work" });
    expect(listed.json().skills).toContainEqual(
      expect.objectContaining({
        name: "review",
        displayName: "Code Review",
        path: "/skills/review/SKILL.md",
        enabled: true,
      }),
    );
    expect(listed.json().skills).not.toContainEqual(
      expect.objectContaining({ name: "openai-templates:artifact-template-analytics-dashboard" }),
    );

    const updated = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/skills/config",
      headers: harness.headers,
      payload: { cwd: "/work", path: "/skills/review/SKILL.md", enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ path: "/skills/review/SKILL.md", enabled: false });
    expect(harness.bridge.request).toHaveBeenCalledWith("skills/config/write", {
      path: "/skills/review/SKILL.md",
      enabled: false,
    });

    await harness.app.close();
  });

  it("enriches dollar markers from the cached catalog without a send-path skills RPC", async () => {
    const harness = await createSkillsHarness();
    await harness.app.inject({
      url: "/api/v1/skills?cwd=%2Fwork&forceReload=false",
      headers: harness.headers,
    });
    const listCalls = harness.bridge.request.mock.calls.filter(
      ([method]) => method === "skills/list",
    ).length;

    const started = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers: harness.headers,
      payload: { clientMessageId: "direct-test-33253", input: "$review, this change" },
    });

    expect(started.statusCode).toBe(201);
    expect(
      harness.bridge.request.mock.calls.filter(([method]) => method === "skills/list"),
    ).toHaveLength(listCalls);
    expect(
      harness.bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      input: [
        { type: "text", text: "$review, this change", text_elements: [] },
        { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
      ],
    });

    await harness.app.close();
  });

  it("keeps an uncached dollar marker as text instead of blocking send on discovery", async () => {
    const harness = await createSkillsHarness();
    harness.bridge.request.mockClear();

    const started = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers: harness.headers,
      payload: { clientMessageId: "direct-test-34174", input: "$review immediately" },
    });

    expect(started.statusCode).toBe(201);
    expect(
      harness.bridge.request.mock.calls.filter(([method]) => method === "skills/list"),
    ).toHaveLength(0);
    expect(
      harness.bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      input: [{ type: "text", text: "$review immediately", text_elements: [] }],
    });

    await harness.app.close();
  });
});

describe("project removal", () => {
  it("blocks active work, hides sessions, preserves files, and restores sessions on re-add", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-project-removal-api-test-"));
    directories.push(directory);
    const projectPath = join(directory, "project");
    await mkdir(projectPath);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
      state.projects.push({
        id: "project",
        displayName: "Project",
        path: projectPath,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    projection.upsertThread({ ...testThread("project-thread"), cwd: projectPath });
    projection.upsertThread({ ...testThread("unrelated"), cwd: join(directory, "other") });
    const config = loadConfig({
      statePath: store.path,
      clientDist: join(directory, "missing"),
      allowedOrigins: new Set(["http://localhost"]),
      websocketAuthTimeoutMs: 25,
    });
    const app = await buildApp(config, {
      bridge: bridge as unknown as CodexBridge,
      store,
      projection,
      attention,
      projectRoot: directory,
    });
    const headers = { authorization: "Bearer correct" };

    await projection.setCurrentTurn("project-thread", "active-turn");
    const activeRemoval = await app.inject({
      method: "DELETE",
      url: "/api/v1/projects/project",
      headers,
    });
    expect(activeRemoval.statusCode).toBe(409);
    expect(activeRemoval.json()).toMatchObject({ error: { code: "conflict" } });
    expect(store.snapshot().projects).toHaveLength(1);

    projection.upsertThread({ ...testThread("project-thread"), cwd: projectPath });
    await store.update((state) => {
      state.threadMeta["project-thread"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        awaitingPlanResponse: true,
      };
    });
    const attentionRemoval = await app.inject({
      method: "DELETE",
      url: "/api/v1/projects/project",
      headers,
    });
    expect(attentionRemoval.statusCode).toBe(409);

    await store.update((state) => {
      state.threadMeta["project-thread"]!.awaitingPlanResponse = false;
      state.messageQueues = {
        "project-thread": [
          {
            id: "queued",
            threadId: "project-thread",
            text: "Продолжить",
            createdAt: 1,
            status: "queued",
          },
        ],
      };
    });
    const queuedRemoval = await app.inject({
      method: "DELETE",
      url: "/api/v1/projects/project",
      headers,
    });
    expect(queuedRemoval.statusCode).toBe(409);

    await store.update((state) => {
      delete state.messageQueues?.["project-thread"];
    });
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/projects/project",
      headers,
    });
    expect(removed.statusCode).toBe(204);
    expect(await realpath(projectPath)).toBe(projectPath);
    expect(store.snapshot().dismissedProjectPaths).toEqual([projectPath]);
    expect(projection.snapshot().threads.map((thread) => thread.id)).toEqual(["unrelated"]);

    const restored = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { path: projectPath },
    });
    expect(restored.statusCode).toBe(201);
    expect(store.snapshot().dismissedProjectPaths).toBeUndefined();
    expect(projection.snapshot().threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "project-thread",
          projectId: restored.json().id as string,
        }),
        expect.objectContaining({ id: "unrelated", projectId: null }),
      ]),
    );

    await app.close();
  });
});

describe("audio transcriptions", () => {
  it("keeps config and audio uploads authenticated and maps provider failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-transcription-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    const transcription = {
      configuration: vi.fn(() => ({
        providers: ["local" as const, "openai" as const],
        provider: "local" as const,
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKeyConfigured: true,
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: true,
        refinementModel: "gpt-5.6-luna",
        maxRecordingSeconds: 300,
        maxUploadBytes: 24 * 1024 * 1024,
        timingEstimate: {
          sampleCount: 0,
          estimatedFixedProcessingMs: null,
          estimatedProcessingMsPerAudioSecond: null,
        },
      })),
      updateConfiguration: vi.fn(async () => ({
        providers: ["local" as const, "openai" as const],
        provider: "openai" as const,
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKeyConfigured: true,
        openAiModel: "gpt-4o-mini-transcribe",
        language: "ru",
        refineLocal: false,
        refinementModel: "gpt-5.6-luna",
        maxRecordingSeconds: 300,
        maxUploadBytes: 24 * 1024 * 1024,
        timingEstimate: {
          sampleCount: 0,
          estimatedFixedProcessingMs: null,
          estimatedProcessingMsPerAudioSecond: null,
        },
      })),
      transcribe: vi.fn(async () => "распознанный текст"),
    };
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        transcription,
      },
    );
    const authorization = { authorization: "Bearer correct" };

    expect((await app.inject({ url: "/api/v1/transcriptions/config" })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/api/v1/transcriptions/config", headers: authorization })).json(),
    ).toEqual(transcription.configuration());

    const transcribed = await app.inject({
      method: "POST",
      url: "/api/v1/transcriptions",
      headers: { ...authorization, "content-type": "audio/webm;codecs=opus" },
      payload: Buffer.from("audio"),
    });
    expect(transcribed.statusCode).toBe(200);
    expect(transcribed.json()).toEqual({
      text: "распознанный текст",
      timingEstimate: {
        sampleCount: 0,
        estimatedFixedProcessingMs: null,
        estimatedProcessingMsPerAudioSecond: null,
      },
    });
    expect(transcription.transcribe).toHaveBeenCalledWith(
      Buffer.from("audio"),
      "audio/webm;codecs=opus",
    );

    const timed = await app.inject({
      method: "POST",
      url: "/api/v1/transcriptions",
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "2000",
      },
      payload: Buffer.from("audio"),
    });
    expect(timed.statusCode).toBe(200);
    expect(timed.json().timingEstimate).toMatchObject({
      sampleCount: 1,
      estimatedFixedProcessingMs: null,
      estimatedProcessingMsPerAudioSecond: null,
    });
    expect(Object.values(store.snapshot().transcriptionTimings ?? {})).toHaveLength(1);
    expect(Object.values(store.snapshot().transcriptionTimings ?? {})[0]).toEqual([
      {
        audioDurationMs: 2_000,
        processingMs: expect.any(Number),
      },
    ]);

    const invalidDuration = await app.inject({
      method: "POST",
      url: "/api/v1/transcriptions",
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "unknown",
      },
      payload: Buffer.from("audio"),
    });
    expect(invalidDuration.statusCode).toBe(400);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/transcription",
      headers: { ...authorization, "content-type": "application/json" },
      payload: {
        provider: "openai",
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKey: "new-secret",
        openAiModel: "gpt-4o-mini-transcribe",
        language: "ru",
        refineLocal: false,
        refinementModel: "gpt-5.6-luna",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).not.toHaveProperty("openAiApiKey");
    expect(transcription.updateConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", openAiApiKey: "new-secret" }),
    );

    const insecureKeyUpdate = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/transcription",
      remoteAddress: "192.168.2.99",
      headers: { ...authorization, "content-type": "application/json" },
      payload: {
        provider: "local",
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKey: "must-not-be-accepted",
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: true,
        refinementModel: "gpt-5.6-luna",
      },
    });
    expect(insecureKeyUpdate.statusCode).toBe(400);
    expect(transcription.updateConfiguration).toHaveBeenCalledTimes(1);

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/transcriptions",
          headers: { ...authorization, "content-type": "audio/mpeg" },
          payload: Buffer.from("audio"),
        })
      ).statusCode,
    ).toBe(400);

    transcription.transcribe.mockRejectedValueOnce(
      new TranscriptionError("unavailable", "Local transcription is not configured"),
    );
    const unavailable = await app.inject({
      method: "POST",
      url: "/api/v1/transcriptions",
      headers: { ...authorization, "content-type": "audio/mp4" },
      payload: Buffer.from("audio"),
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      error: { code: "transcription_unavailable" },
    });

    await app.close();
  });

  it("uploads question clips independently, preserves edits, and durably submits the whole set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-question-voice-api-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    await projection.setDraft("thread", {
      input: "Composer stays",
      images: [],
      annotations: [],
      goalMode: false,
    });
    const finish: Array<(text: string) => void> = [];
    const transcription = {
      configuration: vi.fn(() => ({
        providers: ["local" as const],
        provider: "local" as const,
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKeyConfigured: false,
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: false,
        refinementModel: "gpt-5.6-luna",
        maxRecordingSeconds: 300,
        maxUploadBytes: 24 * 1024 * 1024,
        timingEstimate: {
          sampleCount: 0,
          estimatedFixedProcessingMs: null,
          estimatedProcessingMsPerAudioSecond: null,
        },
      })),
      updateConfiguration: vi.fn(),
      transcribe: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish.push(resolve);
          }),
      ),
    };
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      { bridge: bridge as unknown as CodexBridge, store, projection, attention, transcription },
    );
    try {
      const pending = attention.receive(dismissibleQuestion("questions"), {
        respond: vi.fn(),
        respondError: vi.fn(),
      } as unknown as JsonlTransport);
      const request = projection
        .snapshot()
        .attention.find((candidate) => candidate.id === pending.id);
      if (request?.kind !== "userInput") throw new Error("Expected question");
      const draftKey = request.draftKey!;
      const headers = { authorization: "Bearer correct" };
      const upload = (id: string, order: number, key = draftKey) =>
        app.inject({
          method: "POST",
          url:
            "/api/v1/threads/thread/voice-transcriptions?" +
            new URLSearchParams({
              mode: "draft",
              selectionStart: "0",
              selectionEnd: "0",
              draftUpdatedAt: "none",
              clientUploadId: id,
              userInput: JSON.stringify({ draftKey: key, questionId: "choice", order }),
            }),
          headers: {
            ...headers,
            "content-type": "audio/webm",
            "x-codexnest-audio-duration-ms": "1000",
          },
          payload: Buffer.from("audio"),
        });
      expect((await upload("wrong", 1, "b".repeat(64))).statusCode).toBe(409);
      expect((await upload("clip-one", 1)).statusCode).toBe(202);
      expect((await upload("clip-two", 2)).statusCode).toBe(202);
      await vi.waitFor(() => expect(finish).toHaveLength(1));
      finish[0]!("spoken");
      await vi.waitFor(() => expect(finish).toHaveLength(2));
      const updated = await app.inject({
        method: "PUT",
        url: `/api/v1/attention/${pending.id}/draft`,
        headers,
        payload: {
          answers: { choice: ["Edited"] },
          currentQuestionId: "choice",
          appliedRecordingIds: [],
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        answers: { choice: ["Edited spoken"] },
        appliedRecordingIds: ["clip-one"],
      });
      const submitted = await app.inject({
        method: "POST",
        url: `/api/v1/threads/thread/user-input/${draftKey}/submit`,
        headers,
        payload: {
          draft: {
            answers: { choice: ["Corrected"] },
            currentQuestionId: "choice",
            appliedRecordingIds: ["clip-one"],
          },
          recordingIds: ["clip-one", "clip-two"],
        },
      });
      expect(submitted.statusCode).toBe(202);
      expect(store.view().threadMeta.thread!.userInputDrafts![draftKey]!.submission?.status).toBe(
        "waiting",
      );
      const clientMessageId =
        store.view().threadMeta.thread!.userInputDrafts![draftKey]!.submission!.clientMessageId;
      const lateEdit = await app.inject({
        method: "PUT",
        url: `/api/v1/attention/${pending.id}/draft`,
        headers,
        payload: { answers: { choice: ["Late edit"] }, currentQuestionId: "choice" },
      });
      expect(lateEdit.statusCode).toBe(409);
      finish[1]!("more");
      await vi.waitFor(() =>
        expect(
          Object.values(store.view().messageQueues ?? {})
            .flat()
            .some(
              (message) => message.replyToUserInput?.answers.choice?.[0] === "Corrected more",
            ) ||
            Object.values(store.view().messageReceipts ?? {}).some(
              (receipt) => receipt.threadId === "thread",
            ),
        ).toBe(true),
      );
      expect(store.view().threadMeta.thread!.draft!.input).toBe("Composer stays");
      attention.expire(pending.id);
      const replay = await app.inject({
        method: "POST",
        url: `/api/v1/threads/thread/user-input/${draftKey}/submit`,
        headers,
        payload: {
          clientMessageId,
          draft: { answers: { choice: ["Must not resend"] }, currentQuestionId: "choice" },
          recordingIds: ["clip-one", "clip-two"],
        },
      });
      expect(replay.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });

  it("durably accepts a thread voice job and locks its composer until completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-voice-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    projection.upsertThread(testThread("voice"));
    await projection.setDraft("voice", {
      input: "Начало конец",
      images: [],
      goalMode: false,
      annotations: [],
    });
    let resolveTranscript: ((value: string) => void) | undefined;
    const transcription = {
      configuration: vi.fn(() => ({
        providers: ["local" as const],
        provider: "local" as const,
        localUrl: "http://127.0.0.1:8178/inference",
        openAiApiKeyConfigured: false,
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: false,
        refinementModel: "gpt-5.6-luna",
        maxRecordingSeconds: 300,
        maxUploadBytes: 24 * 1024 * 1024,
        timingEstimate: {
          sampleCount: 0,
          estimatedFixedProcessingMs: null,
          estimatedProcessingMsPerAudioSecond: null,
        },
      })),
      updateConfiguration: vi.fn(),
      transcribe: vi.fn(
        (_audio: Buffer, _contentType: string, signal?: AbortSignal) =>
          new Promise<string>((resolve, reject) => {
            resolveTranscript = resolve;
            signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
      ),
    };
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        transcription,
      },
    );
    const authorization = { authorization: "Bearer correct" };
    let updatedAt = store.snapshot().threadMeta.voice!.draft!.updatedAt;
    await store.update((state) => {
      state.threadMeta.voice!.draft = {
        input: "Более новый черновик",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: updatedAt + 1,
      };
      state.voiceTranscriptions!.voice = {
        id: "failed-voice",
        threadId: "voice",
        mode: "draft",
        status: "failed",
        createdAt: 1,
        startedAt: null,
        audioDurationMs: 1_000,
        estimatedTotalSeconds: null,
        error: "failed",
        contentType: "audio/webm",
        audioBytes: 5,
        selectionStart: 0,
        selectionEnd: 0,
      };
    });

    const staleDraft = await app.inject({
      method: "PUT",
      url: `/api/v1/threads/voice/draft?expectedUpdatedAt=${updatedAt}`,
      headers: authorization,
      payload: { input: "Начало конец", images: [], goalMode: false, annotations: [] },
    });
    expect(staleDraft.statusCode).toBe(409);
    expect(staleDraft.json()).toMatchObject({ error: { code: "draft_conflict" } });
    expect(store.snapshot().threadMeta.voice!.draft!.input).toBe("Более новый черновик");
    expect(store.snapshot().voiceTranscriptions!.voice!.id).toBe("failed-voice");

    const equivalentDraft = await app.inject({
      method: "PUT",
      url: `/api/v1/threads/voice/draft?expectedUpdatedAt=${updatedAt}`,
      headers: authorization,
      payload: {
        input: "Более новый черновик",
        images: [],
        goalMode: false,
        annotations: [],
      },
    });
    expect(equivalentDraft.statusCode).toBe(200);
    expect(equivalentDraft.json().updatedAt).toBe(updatedAt + 1);
    expect(store.snapshot().voiceTranscriptions!.voice).toBeUndefined();

    const restoredDraft = await app.inject({
      method: "PUT",
      url: `/api/v1/threads/voice/draft?expectedUpdatedAt=${updatedAt + 1}`,
      headers: authorization,
      payload: { input: "Начало конец", images: [], goalMode: false, annotations: [] },
    });
    expect(restoredDraft.statusCode).toBe(200);
    updatedAt = restoredDraft.json().updatedAt;

    const sameMillisecond = vi.spyOn(Date, "now").mockReturnValue(updatedAt);
    const competingDrafts = await Promise.all(
      ["Версия A", "Версия B"].map((input) =>
        app.inject({
          method: "PUT",
          url: `/api/v1/threads/voice/draft?expectedUpdatedAt=${updatedAt}`,
          headers: authorization,
          payload: { input, images: [], goalMode: false, annotations: [] },
        }),
      ),
    );
    sameMillisecond.mockRestore();
    expect(competingDrafts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winningDraft = competingDrafts.find((response) => response.statusCode === 200)!;
    expect(winningDraft.json().updatedAt).toBe(updatedAt + 1);

    const finalDraft = await app.inject({
      method: "PUT",
      url: `/api/v1/threads/voice/draft?expectedUpdatedAt=${updatedAt + 1}`,
      headers: authorization,
      payload: { input: "Начало конец", images: [], goalMode: false, annotations: [] },
    });
    expect(finalDraft.statusCode).toBe(200);
    updatedAt = finalDraft.json().updatedAt;

    const preparedDraftUpdatedAt = updatedAt;
    await store.update((state) => {
      state.threadMeta.voice!.draft = {
        input: "x",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: preparedDraftUpdatedAt + 1,
      };
    });
    const lateDraftConflict = await app.inject({
      method: "POST",
      url:
        "/api/v1/threads/voice/voice-transcriptions?" +
        new URLSearchParams({
          mode: "draft",
          selectionStart: "7",
          selectionEnd: "7",
          draftUpdatedAt: String(preparedDraftUpdatedAt),
          clientUploadId: "late-conflict",
        }),
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "2000",
      },
      payload: Buffer.from("audio"),
    });
    expect(lateDraftConflict.statusCode).toBe(409);
    expect(lateDraftConflict.json()).toMatchObject({ error: { code: "draft_conflict" } });
    expect(store.snapshot().voiceTranscriptions?.voice).toBeUndefined();

    const restoredAfterLateConflict = await app.inject({
      method: "PUT",
      url: `/api/v1/threads/voice/draft?expectedUpdatedAt=${preparedDraftUpdatedAt + 1}`,
      headers: authorization,
      payload: { input: "Начало конец", images: [], goalMode: false, annotations: [] },
    });
    expect(restoredAfterLateConflict.statusCode).toBe(200);
    updatedAt = restoredAfterLateConflict.json().updatedAt;

    const writeStarted = Promise.withResolvers<void>();
    const continueWrite = Promise.withResolvers<void>();
    const managerPrototype = VoiceTranscriptionManager.prototype as unknown as {
      writeAudio(temporary: string, target: string, audio: Buffer): Promise<void>;
    };
    const originalWriteAudio = managerPrototype.writeAudio;
    const writeAudio = vi
      .spyOn(managerPrototype, "writeAudio")
      .mockImplementation(async function (temporary, target, audio) {
        writeStarted.resolve();
        await continueWrite.promise;
        await originalWriteAudio.call(this, temporary, target, audio);
      });
    const atomicConflictRequest = app.inject({
      method: "POST",
      url:
        "/api/v1/threads/voice/voice-transcriptions?" +
        new URLSearchParams({
          mode: "draft",
          selectionStart: "7",
          selectionEnd: "7",
          draftUpdatedAt: String(updatedAt),
          clientUploadId: "atomic-late-conflict",
        }),
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "2000",
      },
      payload: Buffer.from("audio"),
    });
    await writeStarted.promise;
    const concurrentDraft = await app.inject({
      method: "PUT",
      url: `/api/v1/threads/voice/draft?expectedUpdatedAt=${updatedAt}`,
      headers: authorization,
      payload: { input: "Конкурентный черновик", images: [], goalMode: false, annotations: [] },
    });
    expect(concurrentDraft.statusCode).toBe(200);
    updatedAt = concurrentDraft.json().updatedAt;
    continueWrite.resolve();
    const atomicConflict = await atomicConflictRequest;
    writeAudio.mockRestore();
    expect(atomicConflict.statusCode).toBe(409);
    expect(atomicConflict.json()).toMatchObject({ error: { code: "draft_conflict" } });
    expect(store.snapshot().voiceTranscriptions?.voice).toBeUndefined();
    await expect(
      access(join(directory, "state.json.voice-transcriptions", "atomic-late-conflict.webm")),
    ).rejects.toThrow();

    const restoredAfterAtomicConflict = await app.inject({
      method: "PUT",
      url: `/api/v1/threads/voice/draft?expectedUpdatedAt=${updatedAt}`,
      headers: authorization,
      payload: { input: "Начало конец", images: [], goalMode: false, annotations: [] },
    });
    expect(restoredAfterAtomicConflict.statusCode).toBe(200);
    updatedAt = restoredAfterAtomicConflict.json().updatedAt;

    const accepted = await app.inject({
      method: "POST",
      url:
        "/api/v1/threads/voice/voice-transcriptions?" +
        new URLSearchParams({
          mode: "draft",
          selectionStart: "7",
          selectionEnd: "7",
          draftUpdatedAt: String(updatedAt),
          clientUploadId: "completed-voice",
        }),
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "2000",
      },
      payload: Buffer.from("audio"),
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      threadId: "voice",
      mode: "draft",
      status: "queued",
    });
    expect(store.snapshot().voiceTranscriptions?.voice).toBeDefined();

    const locked = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/voice/draft",
      headers: authorization,
      payload: { input: "Нельзя", images: [], goalMode: false, annotations: [] },
    });
    expect(locked.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/threads/voice/turns",
          headers: authorization,
          payload: { clientMessageId: "direct-test-55790", input: "Нельзя отправить" },
        })
      ).statusCode,
    ).toBe(409);

    await vi.waitFor(() => expect(transcription.transcribe).toHaveBeenCalledOnce());
    const backwardClock = vi.spyOn(Date, "now").mockReturnValue(updatedAt - 1);
    resolveTranscript?.("голос");
    await vi.waitFor(() => {
      expect(store.snapshot().voiceTranscriptions?.voice).toBeUndefined();
    });
    backwardClock.mockRestore();
    expect(store.snapshot().threadMeta.voice?.draft?.input).toBe("Начало голос конец");
    expect(store.snapshot().threadMeta.voice?.draft?.updatedAt).toBe(updatedAt + 1);

    const repeated = await app.inject({
      method: "POST",
      url:
        "/api/v1/threads/voice/voice-transcriptions?" +
        new URLSearchParams({
          mode: "draft",
          selectionStart: "999",
          selectionEnd: "999",
          draftUpdatedAt: "none",
          clientUploadId: "completed-voice",
        }),
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "2000",
      },
      payload: Buffer.from("audio-again"),
    });
    expect(repeated.statusCode).toBe(204);
    expect(transcription.transcribe).toHaveBeenCalledOnce();

    const cancellationTarget = await app.inject({
      method: "POST",
      url:
        "/api/v1/threads/voice/voice-transcriptions?" +
        new URLSearchParams({
          mode: "draft",
          selectionStart: "0",
          selectionEnd: "0",
          draftUpdatedAt: String(store.snapshot().threadMeta.voice!.draft!.updatedAt),
          clientUploadId: "cancel-voice",
        }),
      headers: {
        ...authorization,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "1000",
      },
      payload: Buffer.from("cancel-audio"),
    });
    expect(cancellationTarget.statusCode).toBe(202);
    await vi.waitFor(() => expect(transcription.transcribe).toHaveBeenCalledTimes(2));

    const cancelled = await app.inject({
      method: "DELETE",
      url: "/api/v1/threads/voice/voice-transcriptions",
      headers: authorization,
    });
    expect(cancelled.statusCode).toBe(204);
    expect(store.snapshot().voiceTranscriptions?.voice).toBeUndefined();

    await app.close();
  });
});

describe("file downloads", () => {
  it("allows only canonical tool image paths from this session outside its workspace without RPCs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-tool-download-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const imagePath = join(directory, "screenshot.png");
    const otherPath = join(directory, "other.png");
    const secretPath = join(directory, "secret.txt");
    const linkPath = join(directory, "link.png");
    const missingPath = join(directory, "missing.png");
    await Promise.all([
      writeFile(imagePath, "image"),
      writeFile(otherPath, "other"),
      writeFile(secretPath, "secret"),
    ]);
    await symlink(otherPath, linkPath);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    projection.upsertThread({ ...testThread("images"), cwd: workspace });
    projection.upsertThread({ ...testThread("other"), cwd: workspace });
    for (const path of [imagePath, linkPath, missingPath, secretPath]) {
      bridge.emit("notification", {
        method: "item/completed",
        params: {
          threadId: "images",
          turnId: "turn",
          completedAtMs: 1000,
          item: { type: "imageView", id: path, path },
        },
      });
    }
    const app = await buildApp(
      loadConfig({ statePath: store.path, clientDist: join(directory, "no-client") }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        projectRoot: workspace,
      },
    );
    await app.ready();
    const requests = vi.spyOn(bridge, "request").mockClear();
    const issue = (path: string, threadId = "images") =>
      app.inject({
        method: "POST",
        url: `/api/v1/threads/${threadId}/downloads`,
        headers: { authorization: "Bearer correct" },
        payload: { path },
      });
    try {
      const ticket = await issue(imagePath);
      expect(ticket.statusCode).toBe(201);
      const response = await app.inject({ url: ticket.json().downloadUrl });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("image");
      expect((await issue(imagePath, "other")).statusCode).toBe(403);
      expect((await issue(otherPath)).statusCode).toBe(403);
      expect((await issue(secretPath)).statusCode).toBe(403);
      expect((await issue(linkPath)).statusCode).toBe(403);
      expect((await issue(missingPath)).statusCode).toBe(404);
      const swapped = await issue(imagePath);
      await unlink(imagePath);
      await symlink(otherPath, imagePath);
      expect((await app.inject({ url: swapped.json().downloadUrl })).statusCode).toBe(404);
      expect(requests).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("issues short-lived tickets and confines downloads to the task directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-download-api-test-"));
    directories.push(directory);
    const taskRoot = join(directory, "task");
    const nested = join(taskRoot, "build", "app-debug.apk");
    const outside = join(directory, "outside.bin");
    const locked = join(taskRoot, "locked.bin");
    const escapedLink = join(taskRoot, "escaped.bin");
    const swappable = join(taskRoot, "swappable.bin");
    await mkdir(join(taskRoot, "build"), { recursive: true });
    await Promise.all([
      writeFile(nested, Buffer.from([0, 1, 2, 255])),
      writeFile(outside, "outside"),
      writeFile(locked, "locked"),
      writeFile(swappable, "original"),
    ]);
    await symlink(outside, escapedLink);

    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    projection.upsertThread({ ...testThread("download"), cwd: taskRoot });
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        projectRoot: directory,
      },
    );
    const headers = { authorization: "Bearer correct" };
    const issue = (path: string, requestHeaders: Record<string, string> = headers) =>
      app.inject({
        method: "POST",
        url: "/api/v1/threads/download/downloads",
        headers: requestHeaders,
        payload: { path },
      });

    expect((await issue(nested, {})).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/threads/missing/downloads",
          headers,
          payload: { path: nested },
        })
      ).statusCode,
    ).toBe(404);
    expect((await issue(outside)).statusCode).toBe(403);
    expect((await issue(escapedLink)).statusCode).toBe(403);
    expect((await issue(taskRoot)).statusCode).toBe(400);
    expect((await issue(join(taskRoot, "missing.bin"))).statusCode).toBe(404);

    await chmod(locked, 0o000);
    try {
      expect((await issue(locked)).statusCode).toBe(403);
    } finally {
      await chmod(locked, 0o600);
    }

    const issued = await issue(nested);
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({
      downloadUrl: expect.stringMatching(/^\/downloads\/[A-Za-z0-9_-]+\/app-debug\.apk$/),
      expiresAt: expect.any(Number),
      fileName: "app-debug.apk",
      size: 4,
    });
    expect(issued.json().downloadUrl).not.toContain("correct");
    expect(issued.json().downloadUrl).not.toContain(taskRoot);

    const downloaded = await app.inject({ url: issued.json().downloadUrl });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(downloaded.headers["content-type"]).toBe("application/octet-stream");
    expect(downloaded.headers["cache-control"]).toBe("private, no-store");
    expect(downloaded.headers["content-disposition"]).toContain("attachment");
    expect(downloaded.headers["content-disposition"]).toContain("app-debug.apk");
    expect((await app.inject({ url: issued.json().downloadUrl })).statusCode).toBe(404);

    const changedName = await issue(nested);
    const tamperedUrl = String(changedName.json().downloadUrl).replace(
      /app-debug\.apk$/,
      "renamed.apk",
    );
    expect((await app.inject({ url: tamperedUrl })).statusCode).toBe(404);
    expect((await app.inject({ url: changedName.json().downloadUrl })).statusCode).toBe(404);

    const swapped = await issue(swappable);
    await unlink(swappable);
    await symlink(outside, swappable);
    expect((await app.inject({ url: swapped.json().downloadUrl })).statusCode).toBe(404);

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const expiring = await issue(nested);
      expect(expiring.json().expiresAt).toBe(61_000);
      dateNow.mockReturnValue(61_001);
      expect((await app.inject({ url: expiring.json().downloadUrl })).statusCode).toBe(404);
    } finally {
      dateNow.mockRestore();
    }

    await app.close();
  });
});

describe("session forks", () => {
  it("refreshes a missing cached rollout path before estimating a compressed fork", async () => {
    const harness = await createForkHarness();
    const rolloutPath = join(dirname(harness.store.path), "estimate-source.jsonl");
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          type: "compacted",
          payload: {
            message: "",
            replacement_history: [{ type: "message", id: "summary", role: "user", content: [] }],
          },
        }),
        JSON.stringify({ type: "turn_context", payload: { turn_id: "selected-turn" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            id: "selected-answer",
            role: "assistant",
            content: [{ type: "output_text", text: "Готовый ответ" }],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "selected-turn" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    harness.bridge.threadReadPath = rolloutPath;
    harness.bridge.request.mockClear();

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-estimate",
      headers: harness.headers,
      payload: { lastTurnId: "selected-turn", agentMessageId: "item-1630" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sourceBytes: expect.any(Number),
      compressed: {
        available: true,
        estimatedBytes: null,
        estimatedSeconds: { minSeconds: 60, maxSeconds: 600 },
      },
      exact: { available: true, estimatedBytes: expect.any(Number) },
    });
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/read",
      { threadId: "thread", includeTurns: false },
      30_000,
    );
    expect(harness.projection.rolloutPath("thread")).toBeNull();
    await harness.app.close();
  });

  it("persists a refreshed rollout path when creating a fork without an estimate", async () => {
    const harness = await createForkHarness();
    const rolloutPath = join(dirname(harness.store.path), "operation-source.jsonl");
    await writeSafeForkRollout(rolloutPath);
    harness.bridge.threadReadPath = rolloutPath;
    harness.bridge.state = "disconnected" as never;

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "path-refresh-operation",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "compressed",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(harness.store.snapshot().forkOperations?.["path-refresh-operation"].rolloutPath).toBe(
      rolloutPath,
    );
    await harness.app.close();
  });

  it("persists an idempotent 202 operation, reloads pending detail, and transfers composer state", async () => {
    const harness = await createForkHarness();
    await harness.projection.setSettings("thread", {
      collaborationMode: "default",
      model: "gpt-a",
      serviceTier: "fast",
    });
    harness.bridge.state = "disconnected" as never;
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("selected-turn", "completed"),
        itemsView: "full",
        items: [agentMessage("selected-answer", "Готовый ответ")],
      },
    ]);
    const payload = {
      operationId: "operation",
      lastTurnId: "selected-turn",
      agentMessageId: "selected-answer",
      mode: "exact",
    };

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload,
    });
    expect(created.statusCode).toBe(202);
    expect(created.json().operation).toMatchObject({
      id: "operation",
      status: "preparing",
      title: "Ответвление: Thread",
      queuedMessageCount: 0,
      targetThreadId: null,
    });
    expect(harness.bridge.request).not.toHaveBeenCalledWith("thread/fork", expect.anything());

    const repeated = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload,
    });
    expect(repeated.statusCode).toBe(202);
    const conflict = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: { ...payload, mode: "compressed" },
    });
    expect(conflict.statusCode).toBe(409);

    expect(
      (
        await harness.app.inject({
          method: "PUT",
          url: "/api/v1/fork-operations/operation/draft?expectedUpdatedAt=none",
          headers: harness.headers,
          payload: { input: "pending", images: [], goalMode: false, annotations: [] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: "/api/v1/fork-operations/operation/queue",
          headers: harness.headers,
          payload: { input: "queued", clientMessageId: "queued-message" },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await harness.app.inject({
          method: "PUT",
          url: "/api/v1/fork-operations/operation/draft?expectedUpdatedAt=none",
          headers: harness.headers,
          payload: { input: "pending", images: [], goalMode: false, annotations: [] },
        })
      ).statusCode,
    ).toBe(200);

    const detail = await harness.app.inject({
      url: "/api/v1/fork-operations/operation",
      headers: harness.headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      operation: { id: "operation", status: "preparing", queuedMessageCount: 1 },
      queuedMessages: [
        { id: "queued-message", threadId: "operation", text: "queued", status: "queued" },
      ],
      draft: { input: "pending", images: [], goalMode: false, annotations: [] },
    });

    harness.bridge.state = "ready";
    harness.bridge.emit("state", "ready");
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.operation).toMatchObject({
        status: "ready",
        error: null,
      });
    });
    expect(harness.store.snapshot().forkOperations?.operation.targetThreadId).toBe("fork");
    expect(harness.store.snapshot().threadMeta.fork?.logicalFork).toEqual({
      sourceThreadId: "thread",
      operationId: "operation",
      mode: "exact",
    });
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/fork",
      expect.objectContaining({
        threadId: "thread",
        threadSource: "codexnest-fork:operation",
        excludeTurns: true,
        serviceTier: "fast",
      }),
      600_000,
    );
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: "fork", serviceTier: "fast" }),
    );
    await harness.app.close();
  });

  it("retries an exact fork when the live response id differs from the historical id", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("selected-turn", "completed"),
        itemsView: "full",
        items: [agentMessage("item-19", "Готовый ответ из истории")],
      },
    ]);
    const payload = {
      operationId: "unstable-response-id",
      lastTurnId: "selected-turn",
      agentMessageId: "msg_live_final_answer",
      mode: "exact",
    } as const;

    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: "/api/v1/threads/thread/fork-operations",
          headers: harness.headers,
          payload,
        })
      ).statusCode,
    ).toBe(202);
    await harness.store.update((state) => {
      const operation = state.forkOperations?.[payload.operationId];
      if (!operation) return;
      operation.status = "failed";
      operation.error =
        "agentMessageId must select the last non-empty agent message or plan of the turn";
    });

    const retried = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload,
    });
    expect(retried.statusCode).toBe(202);
    expect(harness.store.snapshot().forkOperations?.[payload.operationId]).toMatchObject({
      status: "preparing",
      agentMessageId: "msg_live_final_answer",
      error: null,
    });

    harness.bridge.state = "ready";
    harness.bridge.emit("state", "ready");
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.[payload.operationId]).toMatchObject({
        status: "ready",
        agentText: "Готовый ответ из истории",
        error: null,
      });
    });
    expect(harness.threadTitles.generate).toHaveBeenCalledWith("Готовый ответ из истории", {
      cwd: "/work",
      model: "gpt-b",
      effort: "low",
    });
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/fork",
      expect.objectContaining({
        threadId: "thread",
        lastTurnId: "selected-turn",
        threadSource: "codexnest-fork:unstable-response-id",
      }),
      600_000,
    );
    await harness.app.close();
  });

  it("deletes operation-owned temporary and target threads before removing a failed fork", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "failed-cleanup",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "compressed",
      },
    });
    await harness.store.update((state) => {
      const operation = state.forkOperations?.["failed-cleanup"];
      if (!operation) return;
      operation.status = "failed";
      operation.error = "compact failed";
      operation.targetThreadId = "failed-target";
      operation.compressedPreparation = {
        temporaryThreadId: "failed-temporary",
        rolloutPath: join(dirname(harness.store.path), "failed-temporary.jsonl"),
        compactFromBytes: 0,
        phase: "compacting",
        startedAt: Date.now(),
        sequence: 1,
      };
    });

    const response = await harness.app.inject({
      method: "DELETE",
      url: "/api/v1/fork-operations/failed-cleanup",
      headers: harness.headers,
    });

    expect(response.statusCode).toBe(204);
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/delete",
      { threadId: "failed-temporary" },
      30_000,
    );
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/delete",
      { threadId: "failed-target" },
      30_000,
    );
    expect(harness.store.snapshot().forkOperations?.["failed-cleanup"]).toBeUndefined();
    await harness.app.close();
  });

  it("cleans a failed fork before retrying with a fresh compact operation", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    const payload = {
      operationId: "failed-retry",
      lastTurnId: "selected-turn",
      agentMessageId: "selected-answer",
      mode: "compressed",
    } as const;
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload,
    });
    await harness.store.update((state) => {
      const operation = state.forkOperations?.[payload.operationId];
      if (!operation) return;
      operation.status = "failed";
      operation.error = "compact failed";
      operation.targetThreadId = "failed-retry-target";
      operation.estimate = {
        available: true,
        estimatedBytes: 42,
        estimatedSeconds: { minSeconds: 1, maxSeconds: 2 },
        unavailableReason: null,
      };
      operation.agentText = "stale answer";
      operation.nativeAttempt = { startedAt: 1, sequence: 1 };
      operation.compressedPreparation = {
        temporaryThreadId: "failed-retry-temporary",
        rolloutPath: join(dirname(harness.store.path), "failed-retry-temporary.jsonl"),
        compactFromBytes: 0,
        phase: "compacted",
        startedAt: 1,
        sequence: 1,
      };
      operation.compressedMaterialization = { phase: "injected", startedAt: 1 };
    });

    const requestImplementation = harness.bridge.request.getMockImplementation()!;
    harness.bridge.request.mockImplementation(async (method, params) => {
      if (method === "thread/delete") throw new Error("cleanup failed");
      return requestImplementation(method, params);
    });
    const failedCleanup = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload,
    });
    expect(failedCleanup.statusCode).toBe(500);
    expect(harness.store.snapshot().forkOperations?.[payload.operationId]).toMatchObject({
      status: "failed",
      error: "compact failed",
      targetThreadId: "failed-retry-target",
    });

    harness.bridge.request.mockImplementation(requestImplementation).mockClear();
    const retried = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload,
    });

    expect(retried.statusCode).toBe(202);
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/delete",
      { threadId: "failed-retry-temporary" },
      30_000,
    );
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/delete",
      { threadId: "failed-retry-target" },
      30_000,
    );
    expect(harness.store.snapshot().forkOperations?.[payload.operationId]).toMatchObject({
      status: "preparing",
      targetThreadId: null,
      estimate: null,
      error: null,
      agentText: "",
    });
    expect(
      harness.store.snapshot().forkOperations?.[payload.operationId].nativeAttempt,
    ).toBeUndefined();
    expect(
      harness.store.snapshot().forkOperations?.[payload.operationId].compressedPreparation,
    ).toBeUndefined();
    expect(
      harness.store.snapshot().forkOperations?.[payload.operationId].compressedMaterialization,
    ).toBeUndefined();
    await harness.app.close();
  });

  it("creates a fresh compaction in a temporary fork and injects only its replacement", async () => {
    const harness = await createForkHarness();
    await harness.projection.setSettings("thread", {
      collaborationMode: "default",
      model: "gpt-a",
      serviceTier: "fast",
    });
    const directory = await mkdtemp(join(tmpdir(), "codexnest-compressed-fork-test-"));
    directories.push(directory);
    const rolloutPath = join(directory, "rollout.jsonl");
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          type: "compacted",
          payload: {
            message: "",
            replacement_history: [
              { type: "message", id: "summary", role: "user", content: [] },
              {
                type: "compaction",
                id: "encrypted-summary",
                encrypted_content: "opaque",
              },
            ],
          },
        }),
        JSON.stringify({ type: "turn_context", payload: { turn_id: "selected-turn" } }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", id: "answer-item", role: "assistant", content: [] },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "selected-turn" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    harness.projection.upsertThread({ ...testThread(), path: rolloutPath });
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("selected-turn", "completed"),
        itemsView: "full",
        items: [agentMessage("selected-answer", "Готовый ответ")],
      },
    ]);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "compressed-operation",
        lastTurnId: "selected-turn",
        agentMessageId: "msg_live_final_answer",
        mode: "compressed",
      },
    });
    expect(created.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["compressed-operation"].status).toBe(
        "ready",
      );
    });
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/fork",
      expect.objectContaining({
        threadId: "thread",
        lastTurnId: "selected-turn",
        threadSource: "codexnest-fork-temp:compressed-operation",
        serviceTier: "fast",
      }),
      600_000,
    );
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/compact/start",
      { threadId: "temporary-fork" },
      600_000,
    );
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        cwd: "/work",
        model: "gpt-a",
        serviceTier: "fast",
        threadSource: "codexnest-fork:compressed-operation",
      }),
      600_000,
    );
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/inject_items",
      {
        threadId: "created",
        items: [
          {
            type: "message",
            id: "fresh-summary",
            role: "user",
            content: [],
          },
          {
            type: "compaction",
            id: "fresh-encrypted-summary",
            encrypted_content: "fresh-opaque",
          },
        ],
      },
      600_000,
    );
    expect(
      harness.bridge.request.mock.calls.some(
        ([method, params]) =>
          method === "thread/fork" &&
          (params as Record<string, unknown>).threadSource ===
            "codexnest-fork:compressed-operation",
      ),
    ).toBe(false);
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/delete",
      { threadId: "temporary-fork" },
      30_000,
    );
    expect(harness.store.snapshot().threadMeta.created?.logicalFork).toEqual({
      sourceThreadId: "thread",
      operationId: "compressed-operation",
      mode: "compressed",
    });
    await harness.app.close();
  });

  it("leaves the source untouched and removes the full temporary history", async () => {
    const harness = await createForkHarness();
    harness.bridge.freshCompactionItems = [
      { type: "message", id: "fresh-summary", role: "user", content: [] },
      { type: "compaction", encrypted_content: "fresh-opaque" },
    ];
    const directory = await mkdtemp(join(tmpdir(), "codexnest-compact-size-test-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.jsonl");
    const targetPath = join(directory, "target.jsonl");
    const sourceContent = `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: "large-source",
        role: "user",
        content: [{ type: "input_text", text: "x".repeat(2 * 1024 * 1024) }],
      },
    })}\n`;
    await Promise.all([
      writeFile(sourcePath, sourceContent, "utf8"),
      writeFile(targetPath, "", "utf8"),
    ]);
    harness.bridge.threadReadPath = sourcePath;
    harness.bridge.nextForkTargetPath = targetPath;
    harness.bridge.threadTurns.set("thread", [completedForkTurn()]);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "small-final-compressed",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "compressed",
      },
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["small-final-compressed"].status).toBe(
        "ready",
      );
    });
    expect(await readFile(sourcePath, "utf8")).toBe(sourceContent);
    expect((await readFile(targetPath)).byteLength).toBeLessThan(
      Buffer.byteLength(sourceContent) / 100,
    );
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/compact/start",
      { threadId: "temporary-fork" },
      600_000,
    );
    expect(harness.bridge.request).not.toHaveBeenCalledWith(
      "thread/compact/start",
      { threadId: "thread" },
      expect.anything(),
    );
    await expect(access(harness.bridge.lastDeletedThreadPath!)).rejects.toThrow();
    await harness.app.close();
  });

  it("surfaces native compaction errors without falling back to an exact fork", async () => {
    const harness = await createForkHarness();
    harness.bridge.failCompactionWith = new Error("fresh compaction failed");
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("selected-turn", "completed"),
        itemsView: "full",
        items: [agentMessage("selected-answer", "Готовый ответ")],
      },
    ]);
    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: "/api/v1/threads/thread/fork-operations",
          headers: harness.headers,
          payload: {
            operationId: "unavailable-compressed",
            lastTurnId: "selected-turn",
            agentMessageId: "selected-answer",
            mode: "compressed",
          },
        })
      ).statusCode,
    ).toBe(202);
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["unavailable-compressed"].status).toBe(
        "failed",
      );
    });
    expect(harness.store.snapshot().forkOperations?.["unavailable-compressed"].error).toBe(
      "fresh compaction failed",
    );
    expect(
      harness.bridge.request.mock.calls.filter(([method]) => method === "thread/start"),
    ).toHaveLength(0);
    expect(
      harness.bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "thread/fork" &&
          (params as Record<string, unknown>).threadSource ===
            "codexnest-fork:unavailable-compressed",
      ),
    ).toHaveLength(0);
    await harness.app.close();
  });

  it("reconciles an exact fork by threadSource after the native call times out", async () => {
    const harness = await createForkHarness();
    harness.bridge.timeoutForkAfterCreate = true;
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("selected-turn", "completed"),
        itemsView: "full",
        items: [agentMessage("selected-answer", "Готовый ответ")],
      },
    ]);

    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: "/api/v1/threads/thread/fork-operations",
          headers: harness.headers,
          payload: {
            operationId: "timeout-operation",
            lastTurnId: "selected-turn",
            agentMessageId: "selected-answer",
            mode: "exact",
          },
        })
      ).statusCode,
    ).toBe(202);
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["timeout-operation"].status).toBe("ready");
    });
    expect(
      harness.bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "thread/fork" &&
          (params as Record<string, unknown>).threadSource === "codexnest-fork:timeout-operation",
      ),
    ).toHaveLength(1);
    expect(harness.store.snapshot().forkOperations?.["timeout-operation"].targetThreadId).toBe(
      "fork",
    );
    await harness.app.close();
  });

  it("retries a persisted crash-before-native-RPC only after the uncertainty window", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    const selectedTurn = completedForkTurn();
    harness.bridge.threadTurns.set("thread", [selectedTurn]);
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "crash-before-rpc",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "exact",
      },
    });
    await harness.store.update((state) => {
      const operation = state.forkOperations?.["crash-before-rpc"];
      if (!operation) return;
      operation.status = "reconciling";
      operation.nativeAttempt = { startedAt: 1_000, sequence: 1 };
    });
    await harness.app.close();

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_000);
    let restarted: Awaited<ReturnType<typeof restartForkApp>> | undefined;
    try {
      const bridge = new SettingsBridge();
      bridge.threadTurns.set("thread", [selectedTurn]);
      restarted = await restartForkApp(harness.store, bridge, harness.threadTitles);
      await flushImmediates();
      expect(forkRequests(bridge, "crash-before-rpc")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(629_999);
      await flushImmediates();
      expect(forkRequests(bridge, "crash-before-rpc")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      await flushImmediates(8);
      expect(forkRequests(bridge, "crash-before-rpc")).toHaveLength(1);
      expect(harness.store.snapshot().forkOperations?.["crash-before-rpc"].status).toBe("ready");
    } finally {
      await restarted?.app.close();
      vi.useRealTimers();
    }
  });

  it("reconciles a late exact target after restart without a duplicate native call", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    const selectedTurn = completedForkTurn();
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "late-timeout-target",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "exact",
      },
    });
    await harness.store.update((state) => {
      const operation = state.forkOperations?.["late-timeout-target"];
      if (!operation) return;
      operation.status = "reconciling";
      operation.nativeAttempt = { startedAt: Date.now(), sequence: 1 };
    });
    await harness.app.close();

    const bridge = new SettingsBridge();
    bridge.threadTurns.set("thread", [selectedTurn]);
    bridge.managedThreads.push({
      ...testThread("late-fork"),
      threadSource: "codexnest-fork:late-timeout-target",
      forkedFromId: "thread",
    });
    const restarted = await restartForkApp(harness.store, bridge, harness.threadTitles);
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["late-timeout-target"].status).toBe("ready");
    });
    expect(forkRequests(bridge, "late-timeout-target")).toHaveLength(0);
    expect(
      harness.store.snapshot().forkOperations?.["late-timeout-target"].nativeAttempt,
    ).toBeUndefined();
    await restarted.app.close();
  });

  it("replaces a partially injected compressed target before retrying injection", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    const sourcePath = join(dirname(harness.store.path), "compressed-source-before.jsonl");
    const targetPath = join(dirname(harness.store.path), "compressed-target-before.jsonl");
    await Promise.all([
      writeSafeForkRollout(sourcePath),
      writeFile(
        targetPath,
        `${JSON.stringify({
          type: "response_item",
          payload: { type: "message", id: "fresh-summary", role: "user", content: [] },
        })}\n`,
        "utf8",
      ),
    ]);
    harness.projection.upsertThread({ ...testThread(), path: sourcePath });
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "compressed-before-inject",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "compressed",
      },
    });
    await harness.store.update((state) => {
      const operation = state.forkOperations?.["compressed-before-inject"];
      if (!operation) return;
      operation.status = "reconciling";
      operation.targetThreadId = "compressed-target";
      operation.compressedMaterialization = {
        phase: "injecting",
        startedAt: Date.now() - 630_001,
      };
    });
    await harness.app.close();

    const bridge = new SettingsBridge();
    bridge.threadTurns.set("thread", [completedForkTurn()]);
    bridge.nextForkTargetPath = targetPath;
    bridge.managedThreads.push({
      ...testThread("compressed-target"),
      path: targetPath,
      threadSource: "codexnest-fork:compressed-before-inject",
    });
    const restarted = await restartForkApp(harness.store, bridge, harness.threadTitles);
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["compressed-before-inject"].status).toBe(
        "ready",
      );
    });
    expect(injectRequests(bridge)).toHaveLength(1);
    expect(bridge.request).toHaveBeenCalledWith(
      "thread/delete",
      { threadId: "compressed-target" },
      30_000,
    );
    expect(injectRequests(bridge)[0]?.[1]).toMatchObject({ threadId: "created" });
    expect(await readFile(targetPath, "utf8")).toContain("fresh-encrypted-summary");
    await restarted.app.close();
  });

  it("recovers a fresh compaction written before restart without compacting twice", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    harness.bridge.threadTurns.set("thread", [completedForkTurn()]);
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "compressed-after-compaction",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "compressed",
      },
    });
    const temporaryPath = join(dirname(harness.store.path), "compacted-before-restart.jsonl");
    const baseline = `${JSON.stringify({ type: "session_meta", payload: { id: "temp" } })}\n`;
    await writeFile(
      temporaryPath,
      `${baseline}${JSON.stringify({
        type: "compacted",
        payload: {
          message: "",
          replacement_history: [
            { type: "message", id: "recovered-summary", role: "user", content: [] },
            {
              type: "compaction",
              id: "recovered-compaction",
              encrypted_content: "recovered-opaque",
            },
          ],
        },
      })}\n`,
      "utf8",
    );
    await harness.store.update((state) => {
      const operation = state.forkOperations?.["compressed-after-compaction"];
      if (!operation) return;
      operation.status = "reconciling";
      operation.compressedPreparation = {
        temporaryThreadId: "temporary-recovered",
        rolloutPath: temporaryPath,
        compactFromBytes: Buffer.byteLength(baseline),
        phase: "compacting",
        startedAt: Date.now(),
        sequence: 1,
        compactTurnId: "completed-compact-turn",
      };
    });
    await harness.app.close();

    const bridge = new SettingsBridge();
    bridge.threadTurns.set("thread", [completedForkTurn()]);
    bridge.threadTurns.set("temporary-recovered", [
      testTurn("completed-compact-turn", "completed"),
    ]);
    bridge.managedThreads.push({
      ...testThread("temporary-recovered"),
      path: temporaryPath,
      forkedFromId: "thread",
      threadSource: "codexnest-fork-temp:compressed-after-compaction",
    });
    const restarted = await restartForkApp(harness.store, bridge, harness.threadTitles);
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["compressed-after-compaction"].status).toBe(
        "ready",
      );
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/compact/start"),
    ).toHaveLength(0);
    expect(injectRequests(bridge)[0]?.[1]).toMatchObject({
      items: [
        {
          type: "message",
          id: "recovered-summary",
          role: "user",
          content: [],
        },
        expect.objectContaining({
          type: "compaction",
          id: "recovered-compaction",
          encrypted_content: "recovered-opaque",
        }),
      ],
    });
    await restarted.app.close();
  });

  it("rejects appended compact context when the persisted compact turn failed", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    harness.bridge.threadTurns.set("thread", [completedForkTurn()]);
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "failed-compact-after-restart",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "compressed",
      },
    });
    const temporaryPath = join(dirname(harness.store.path), "failed-compact-turn.jsonl");
    const baseline = `${JSON.stringify({ type: "session_meta", payload: { id: "temp" } })}\n`;
    await writeFile(
      temporaryPath,
      `${baseline}${JSON.stringify({
        type: "compacted",
        payload: {
          message: "",
          replacement_history: [
            { type: "message", id: "untrusted-summary", role: "user", content: [] },
          ],
        },
      })}\n`,
      "utf8",
    );
    await harness.store.update((state) => {
      const operation = state.forkOperations?.["failed-compact-after-restart"];
      if (!operation) return;
      operation.status = "reconciling";
      operation.compressedPreparation = {
        temporaryThreadId: "failed-compact-temporary",
        rolloutPath: temporaryPath,
        compactFromBytes: Buffer.byteLength(baseline),
        phase: "compacting",
        startedAt: Date.now(),
        sequence: 1,
        compactTurnId: "failed-compact-turn",
      };
    });
    await harness.app.close();

    const bridge = new SettingsBridge();
    bridge.threadTurns.set("thread", [completedForkTurn()]);
    bridge.threadTurns.set("failed-compact-temporary", [
      {
        ...testTurn("failed-compact-turn", "failed"),
        error: {
          message: "compact terminal failed",
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    ]);
    bridge.managedThreads.push({
      ...testThread("failed-compact-temporary"),
      path: temporaryPath,
      forkedFromId: "thread",
      threadSource: "codexnest-fork-temp:failed-compact-after-restart",
    });
    const restarted = await restartForkApp(harness.store, bridge, harness.threadTitles);

    await vi.waitFor(() => {
      expect(
        harness.store.snapshot().forkOperations?.["failed-compact-after-restart"],
      ).toMatchObject({ status: "failed", error: "compact terminal failed" });
    });
    expect(injectRequests(bridge)).toHaveLength(0);
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/compact/start"),
    ).toHaveLength(0);
    await restarted.app.close();
  });

  it("does not replay an ambiguous in-flight compaction before its RPC settle window", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    harness.bridge.threadTurns.set("thread", [completedForkTurn()]);
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "compressed-in-flight",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "compressed",
      },
    });
    const temporaryPath = join(dirname(harness.store.path), "compacting-before-restart.jsonl");
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "temp" } })}\n`,
      "utf8",
    );
    await harness.store.update((state) => {
      const operation = state.forkOperations?.["compressed-in-flight"];
      if (!operation) return;
      operation.status = "reconciling";
      operation.compressedPreparation = {
        temporaryThreadId: "temporary-in-flight",
        rolloutPath: temporaryPath,
        compactFromBytes: 0,
        phase: "compacting",
        startedAt: Date.now() - 2_000,
        sequence: 1,
      };
    });
    await harness.app.close();

    const bridge = new SettingsBridge();
    bridge.threadTurns.set("thread", [completedForkTurn()]);
    bridge.managedThreads.push({
      ...testThread("temporary-in-flight"),
      path: temporaryPath,
      forkedFromId: "thread",
      threadSource: "codexnest-fork-temp:compressed-in-flight",
    });
    const restarted = await restartForkApp(harness.store, bridge, harness.threadTitles);
    await vi.waitFor(() => {
      expect(bridge.request).toHaveBeenCalledWith(
        "thread/read",
        { threadId: "temporary-in-flight", includeTurns: false },
        30_000,
      );
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/compact/start"),
    ).toHaveLength(0);
    expect(harness.store.snapshot().forkOperations?.["compressed-in-flight"].status).toBe(
      "reconciling",
    );
    await restarted.app.close();
  });

  it("verifies completed compressed injection after restart instead of replaying it", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    const sourcePath = join(dirname(harness.store.path), "compressed-source-after.jsonl");
    const targetPath = join(dirname(harness.store.path), "compressed-target-after.jsonl");
    await writeSafeForkRollout(sourcePath);
    await writeFile(
      targetPath,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "compaction",
          id: "fresh-encrypted-summary",
          encrypted_content: "fresh-opaque",
          internal_chat_message_metadata_passthrough: { turn_id: "injected" },
        },
      })}\n`,
      "utf8",
    );
    harness.projection.upsertThread({ ...testThread(), path: sourcePath });
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "compressed-after-inject",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "compressed",
      },
    });
    await harness.store.update((state) => {
      const operation = state.forkOperations?.["compressed-after-inject"];
      if (!operation) return;
      operation.status = "reconciling";
      operation.targetThreadId = "compressed-target";
      operation.compressedMaterialization = { phase: "injecting", startedAt: Date.now() };
    });
    await harness.app.close();

    const bridge = new SettingsBridge();
    bridge.threadTurns.set("thread", [completedForkTurn()]);
    bridge.managedThreads.push({
      ...testThread("compressed-target"),
      path: targetPath,
      threadSource: "codexnest-fork:compressed-after-inject",
    });
    const restarted = await restartForkApp(harness.store, bridge, harness.threadTitles);
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["compressed-after-inject"].status).toBe(
        "ready",
      );
    });
    expect(injectRequests(bridge)).toHaveLength(0);
    expect(await readFile(targetPath, "utf8")).toContain("fresh-encrypted-summary");
    await restarted.app.close();
  });

  it("reconciles compressed inject response loss from the persisted marker", async () => {
    const harness = await createForkHarness();
    const sourcePath = join(dirname(harness.store.path), "compressed-source-loss.jsonl");
    const targetPath = join(dirname(harness.store.path), "compressed-target-loss.jsonl");
    await Promise.all([writeSafeForkRollout(sourcePath), writeFile(targetPath, "", "utf8")]);
    harness.projection.upsertThread({ ...testThread(), path: sourcePath });
    harness.bridge.threadTurns.set("thread", [completedForkTurn()]);
    harness.bridge.nextForkTargetPath = targetPath;
    harness.bridge.timeoutInjectAfterWrite = true;

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "compressed-response-loss",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "compressed",
      },
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["compressed-response-loss"].status).toBe(
        "ready",
      );
    });
    expect(injectRequests(harness.bridge)).toHaveLength(1);
    expect(await readFile(targetPath, "utf8")).toContain("fresh-encrypted-summary");
    await harness.app.close();
  });

  it("recovers a persisted operation after restart without creating a duplicate", async () => {
    const harness = await createForkHarness();
    harness.bridge.state = "disconnected" as never;
    const selectedTurn = {
      ...testTurn("selected-turn", "completed"),
      itemsView: "full" as const,
      items: [agentMessage("selected-answer", "Готовый ответ")],
    };
    harness.bridge.threadTurns.set("thread", [selectedTurn]);
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "restart-operation",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "exact",
      },
    });
    await harness.app.close();

    const bridge = new SettingsBridge();
    bridge.threadTurns.set("thread", [selectedTurn]);
    bridge.managedThreads.push({
      ...testThread("recovered-fork"),
      threadSource: "codexnest-fork:restart-operation",
      forkedFromId: "thread",
    });
    const attention = new AttentionManager();
    const projection = new AppProjection(
      bridge as unknown as CodexBridge,
      harness.store,
      attention,
    );
    await projection.sync();
    const restarted = await buildApp(
      loadConfig({
        statePath: harness.store.path,
        clientDist: join(harness.store.path, "../missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store: harness.store,
        projection,
        attention,
        threadTitles: harness.threadTitles,
      },
    );

    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["restart-operation"].status).toBe("ready");
    });
    expect(harness.store.snapshot().forkOperations?.["restart-operation"].targetThreadId).toBe(
      "recovered-fork",
    );
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "thread/fork" &&
          (params as Record<string, unknown>).threadSource === "codexnest-fork:restart-operation",
      ),
    ).toHaveLength(0);
    await restarted.close();
  });

  it("keeps the fork ready when asynchronous title generation fails", async () => {
    const harness = await createForkHarness();
    harness.threadTitles.generate.mockRejectedValue(new Error("title unavailable"));
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("selected-turn", "completed"),
        itemsView: "full",
        items: [agentMessage("selected-answer", "Готовый ответ")],
      },
    ]);

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/fork-operations",
      headers: harness.headers,
      payload: {
        operationId: "title-failure",
        lastTurnId: "selected-turn",
        agentMessageId: "selected-answer",
        mode: "exact",
      },
    });
    await vi.waitFor(() => {
      expect(harness.store.snapshot().forkOperations?.["title-failure"].status).toBe("ready");
    });
    expect(harness.store.snapshot().forkOperations?.["title-failure"].error).toBeNull();
    await harness.app.close();
  });

  it("forks through the selected turn when live and historical response ids differ", async () => {
    const harness = await createForkHarness();
    await harness.store.update((state) => {
      state.taskDefaults = { titleModel: "gpt-a" };
    });
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("selected-turn", "completed"),
        itemsView: "full",
        items: [
          agentMessage("empty-before", "  "),
          agentMessage("selected-answer", "Готовая реализация с проверками"),
          agentMessage("empty-after", "\n"),
        ],
      },
    ]);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/forks",
      headers: harness.headers,
      payload: { lastTurnId: "selected-turn", agentMessageId: "msg_live_final_answer" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().thread).toMatchObject({
      id: "fork",
      title: "Готовая реализация",
      state: "completed",
      unread: true,
      unseen: true,
      pinned: false,
      currentTurnId: null,
      queuedMessageCount: 0,
      settings: {
        collaborationMode: "default",
        model: "gpt-b",
        reasoningEffort: "low",
      },
      relation: { kind: "session", sessionId: "fork", forkedFromId: "thread" },
    });
    expect(response.json().thread.relation).not.toHaveProperty("parentThreadId");
    expect(harness.threadTitles.generate).toHaveBeenCalledWith("Готовая реализация с проверками", {
      cwd: "/work",
      model: "gpt-a",
      effort: "high",
    });
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/turns/list",
      {
        threadId: "thread",
        cursor: null,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
      30_000,
    );
    expect(
      harness.bridge.request.mock.calls.some(([method]) => method === "thread/items/list"),
    ).toBe(false);
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/fork",
      {
        threadId: "thread",
        lastTurnId: "selected-turn",
        excludeTurns: true,
        serviceTier: null,
      },
      600_000,
    );
    expect(harness.threadTitles.generate.mock.invocationCallOrder[0]).toBeLessThan(
      harness.bridge.request.mock.invocationCallOrder[
        harness.bridge.request.mock.calls.findIndex(([method]) => method === "thread/fork")
      ]!,
    );
    expect(harness.bridge.request).toHaveBeenCalledWith("thread/goal/clear", {
      threadId: "fork",
    });
    expect(harness.bridge.request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "fork",
      name: "Готовая реализация",
    });
    expect(harness.store.snapshot().threadMeta.fork).toEqual({
      pinned: false,
      lastReadUpdatedAt: 0,
      lastOutcome: "completed",
      outcomeUpdatedAt: 4_000,
      settings: {
        collaborationMode: "default",
        model: "gpt-b",
        reasoningEffort: "low",
      },
      managedTeamToolsAvailable: true,
      sessionSnapshot: {
        sessionId: "fork",
        forkedFromId: "thread",
        name: "Готовая реализация",
        preview: "Thread",
        cwd: "/work",
        createdAt: 3,
        updatedAt: 4,
        archived: false,
        currentTurnId: null,
      },
    });
    expect(harness.store.snapshot().messageQueues?.fork).toBeUndefined();
    expect(harness.projection.summary("fork")).toEqual(response.json().thread);
    await harness.app.close();
  });

  it("forks through a completed plan and preserves Plan mode", async () => {
    const harness = await createForkHarness();
    await harness.projection.setSettings("thread", {
      collaborationMode: "plan",
      model: "gpt-b",
      reasoningEffort: "low",
    });
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("plan-turn", "completed"),
        itemsView: "full",
        items: [
          agentMessage("earlier-answer", "Предварительный ответ"),
          { type: "plan", id: "selected-plan", text: "План реализации с проверками" },
        ],
      },
    ]);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/forks",
      headers: harness.headers,
      payload: { lastTurnId: "plan-turn", agentMessageId: "selected-plan" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().thread).toMatchObject({
      id: "fork",
      state: "completed",
      settings: {
        collaborationMode: "plan",
        model: "gpt-b",
        reasoningEffort: "low",
      },
    });
    expect(harness.threadTitles.generate).toHaveBeenCalledWith("План реализации с проверками", {
      cwd: "/work",
      model: "gpt-b",
      effort: "low",
    });
    expect(harness.bridge.request).toHaveBeenCalledWith(
      "thread/fork",
      {
        threadId: "thread",
        lastTurnId: "plan-turn",
        excludeTurns: true,
        serviceTier: null,
      },
      600_000,
    );
    await harness.app.close();
  });

  it("rejects missing, subagent, unfinished, unknown, and empty fork points", async () => {
    const harness = await createForkHarness();
    harness.bridge.missingThreadIds.add("missing");
    harness.projection.upsertThread({
      ...testThread("child"),
      parentThreadId: "thread",
      ephemeral: true,
    });
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("running-turn", "inProgress"),
        itemsView: "full",
        items: [agentMessage("running-answer", "Ещё работаю")],
      },
      {
        ...testTurn("completed-turn", "completed"),
        itemsView: "full",
        items: [
          agentMessage("earlier-answer", "Первый ответ"),
          agentMessage("last-answer", "Последний ответ"),
        ],
      },
      {
        ...testTurn("empty-turn", "completed"),
        itemsView: "full",
        items: [agentMessage("empty-answer", "  ")],
      },
    ]);

    const issue = (id: string, lastTurnId: string, agentMessageId: string) =>
      harness.app.inject({
        method: "POST",
        url: `/api/v1/threads/${id}/forks`,
        headers: harness.headers,
        payload: { lastTurnId, agentMessageId },
      });

    expect((await issue("missing", "completed-turn", "last-answer")).statusCode).toBe(404);
    expect((await issue("child", "completed-turn", "last-answer")).statusCode).toBe(409);
    expect((await issue("thread", "running-turn", "running-answer")).statusCode).toBe(409);
    expect((await issue("thread", "unknown-turn", "last-answer")).statusCode).toBe(400);
    const empty = await issue("thread", "empty-turn", "empty-answer");
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({
      error: { message: expect.stringContaining("no non-empty agent message or plan") },
    });
    expect(harness.threadTitles.generate).not.toHaveBeenCalled();
    expect(harness.bridge.request).not.toHaveBeenCalledWith("thread/fork", expect.anything());
    await harness.app.close();
  });

  it("does not create a native fork when synchronous title generation fails", async () => {
    const harness = await createForkHarness();
    harness.bridge.threadTurns.set("thread", [
      {
        ...testTurn("completed-turn", "completed"),
        itemsView: "full",
        items: [agentMessage("answer", "Готовый ответ")],
      },
    ]);
    harness.threadTitles.generate.mockRejectedValueOnce(new Error("title failed"));

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/forks",
      headers: harness.headers,
      payload: { lastTurnId: "completed-turn", agentMessageId: "answer" },
    });

    expect(response.statusCode).toBe(500);
    expect(harness.bridge.request).not.toHaveBeenCalledWith("thread/fork", expect.anything());
    expect(harness.projection.summary("fork")).toBeUndefined();
    await harness.app.close();
  });
});

describe("task defaults", () => {
  it("uses the title model for first-turn naming without changing the session model", async () => {
    const harness = await createForkHarness();
    await harness.projection.markUnmaterialized("thread");
    await harness.store.update((state) => {
      state.taskDefaults = { titleModel: "gpt-a" };
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers: harness.headers,
      payload: { clientMessageId: "direct-test-115487", input: "Первое сообщение" },
    });

    expect(response.statusCode).toBe(201);
    await vi.waitFor(() =>
      expect(harness.threadTitles.generate).toHaveBeenCalledWith("Первое сообщение", {
        cwd: "/work",
        model: "gpt-a",
        effort: "high",
      }),
    );
    expect(harness.projection.summary("thread")?.settings).toMatchObject({
      model: "gpt-b",
      reasoningEffort: "low",
    });
    await harness.app.close();
  });

  it("generates a first-turn title from block-only pasted text", async () => {
    const harness = await createForkHarness();
    await harness.projection.markUnmaterialized("thread");
    const pastedSource = "Длинный вставленный текст для новой задачи";

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers: harness.headers,
      payload: {
        clientMessageId: "pasted-title-message",
        input: "",
        pasteBlocks: [{ id: "pasted-title", text: pastedSource }],
      },
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(harness.threadTitles.generate).toHaveBeenCalledWith(pastedSource, {
        cwd: "/work",
        model: "gpt-b",
        effort: "low",
      });
      expect(harness.bridge.request).toHaveBeenCalledWith("thread/name/set", {
        threadId: "thread",
        name: "Готовая реализация",
      });
    });
    await harness.app.close();
  });

  it("preserves omitted defaults and clears explicit null values", async () => {
    const harness = await createForkHarness();
    const save = (payload: Record<string, string | null>) =>
      harness.app.inject({
        method: "PUT",
        url: "/api/v1/settings/task-defaults",
        headers: harness.headers,
        payload,
      });

    expect(
      (
        await save({
          model: "gpt-a",
          titleModel: "gpt-b",
          serviceTier: "fast",
          personality: "friendly",
        })
      ).json(),
    ).toEqual({
      model: "gpt-a",
      titleModel: "gpt-b",
      serviceTier: "fast",
      personality: "friendly",
    });
    expect((await save({ titleModel: null })).json()).toEqual({
      model: "gpt-a",
      serviceTier: "fast",
      personality: "friendly",
    });
    expect((await save({ model: null })).json()).toEqual({
      serviceTier: "fast",
      personality: "friendly",
    });
    expect((await save({ serviceTier: null })).json()).toEqual({
      personality: "friendly",
    });

    await harness.store.update((state) => {
      state.taskDefaults = {
        model: "retired-session-model",
        titleModel: "retired-title-model",
        serviceTier: "legacy-tier",
        personality: "friendly",
      };
    });
    expect((await save({ personality: "friendly" })).json()).toEqual({
      model: "retired-session-model",
      titleModel: "retired-title-model",
      personality: "friendly",
    });
    expect(harness.projection.newSessionSettings).toEqual({
      collaborationMode: "plan",
      personality: "friendly",
    });
    expect((await save({ titleModel: null })).json()).toEqual({
      model: "retired-session-model",
      personality: "friendly",
    });
    await harness.app.close();
  });
});

describe("Fast session settings", () => {
  it("copies the default only into new sessions and persists canonical Fast", async () => {
    const { app, bridge, headers, projection, store } = await createForkHarness();
    try {
      const save = (payload: Record<string, string | null>) =>
        app.inject({
          method: "PUT",
          url: "/api/v1/settings/task-defaults",
          headers,
          payload,
        });
      const enabled = await save({ model: "gpt-a", serviceTier: "priority" });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toEqual({ model: "gpt-a", serviceTier: "fast" });
      expect(projection.summary("thread")?.settings).not.toHaveProperty("serviceTier");

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects/project/threads",
        headers,
        payload: { clientCreationId: "fast-default" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().thread.settings).toMatchObject({ model: "gpt-a", serviceTier: "fast" });
      expect(
        bridge.request.mock.calls.findLast(([method]) => method === "thread/start")?.[1],
      ).toMatchObject({ model: "gpt-a", serviceTier: "fast" });

      await store.flushed();
      const reopened = new StateStore(store.path);
      await reopened.load();
      expect(reopened.view().taskDefaults).toEqual({ model: "gpt-a", serviceTier: "fast" });
      expect(reopened.view().threadMeta.created?.settings?.serviceTier).toBe("fast");

      expect((await save({ serviceTier: null })).json()).toEqual({ model: "gpt-a" });
      expect(projection.summary("created")?.settings.serviceTier).toBe("fast");
      bridge.nextCreatedThreadId = "standard-after-default-change";
      const standard = await app.inject({
        method: "POST",
        url: "/api/v1/projects/project/threads",
        headers,
        payload: { clientCreationId: "standard-default" },
      });
      expect(standard.statusCode).toBe(201);
      expect(standard.json().thread.settings).not.toHaveProperty("serviceTier");
      expect(
        bridge.request.mock.calls.findLast(([method]) => method === "thread/start")?.[1],
      ).toMatchObject({ model: "gpt-a", serviceTier: null });
    } finally {
      await app.close();
    }
  });

  it("keeps the global Fast preference when the new-session model does not support it", async () => {
    const { app, bridge, headers, store } = await createForkHarness();
    try {
      const saved = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/task-defaults",
        headers,
        payload: { model: "gpt-b", serviceTier: "fast" },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ model: "gpt-b", serviceTier: "fast" });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects/project/threads",
        headers,
        payload: { clientCreationId: "unsupported-default" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().thread.settings).not.toHaveProperty("serviceTier");
      expect(
        bridge.request.mock.calls.findLast(([method]) => method === "thread/start")?.[1],
      ).toMatchObject({ model: "gpt-b", serviceTier: null });
      expect(store.view().taskDefaults?.serviceTier).toBe("fast");
    } finally {
      await app.close();
    }
  });

  it("normalizes Fast patches, ignores legacy tiers, clears explicitly, and validates model support", async () => {
    const { app, bridge, headers, projection, store } = await createForkHarness();
    try {
      const patch = (payload: Record<string, string | null>) =>
        app.inject({
          method: "PATCH",
          url: "/api/v1/threads/thread/settings",
          headers,
          payload,
        });
      expect((await patch({ serviceTier: "fast" })).statusCode).toBe(400);
      expect(projection.summary("thread")?.settings).not.toHaveProperty("serviceTier");
      bridge.request.mockClear();
      const enabled = await patch({ model: "gpt-a", serviceTier: "priority" });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json().settings).toMatchObject({ model: "gpt-a", serviceTier: "fast" });
      expect(store.view().threadMeta.thread?.settings?.serviceTier).toBe("fast");
      expect((await patch({ serviceTier: "legacy-tier" })).json().settings.serviceTier).toBe(
        "fast",
      );
      expect((await patch({ serviceTier: null })).json().settings).not.toHaveProperty(
        "serviceTier",
      );
      expect((await patch({ serviceTier: "fast" })).json().settings.serviceTier).toBe("fast");
      const switched = await patch({ model: "gpt-b" });
      expect(switched.statusCode).toBe(200);
      expect(switched.json().settings).not.toHaveProperty("serviceTier");
      expect((await patch({ serviceTier: "priority" })).statusCode).toBe(400);
      expect(bridge.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);

      bridge.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread", turn: testTurn("busy", "inProgress") },
      } satisfies ServerNotification);
      expect((await patch({ serviceTier: null })).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it.each([
    { tiers: [{ id: "fast", name: "Fast" }], wireTier: "fast" },
    { tiers: [{ id: "priority", name: "Priority" }], wireTier: "priority" },
    {
      tiers: [
        { id: "fast", name: "Fast" },
        { id: "priority", name: "Priority" },
      ],
      wireTier: "priority",
    },
  ])(
    "uses cached $wireTier support for creation, resume, and the retried message",
    async ({ tiers, wireTier }) => {
      const { app, bridge, headers, projection, store } = await createForkHarness();
      try {
        bridge.gptAServiceTiers = tiers;
        await projection.sync();
        await app.inject({
          method: "PUT",
          url: "/api/v1/settings/task-defaults",
          headers,
          payload: { model: "gpt-a", serviceTier: "fast" },
        });
        bridge.request.mockClear();
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects/project/threads",
          headers,
          payload: { clientCreationId: `wire-${wireTier}` },
        });
        expect(created.statusCode).toBe(201);
        expect(
          bridge.request.mock.calls.find(([method]) => method === "thread/start")?.[1],
        ).toMatchObject({ model: "gpt-a", serviceTier: wireTier });
        const original = bridge.request.getMockImplementation()!;
        let unloaded = true;
        bridge.request.mockImplementation(async (method, params = {}) => {
          if (method === "turn/start" && params.threadId === "created" && unloaded)
            throw new RpcError(-32600, "thread not loaded");
          if (method === "thread/resume" && params.threadId === "created") unloaded = false;
          return original(method, params);
        });
        const sent = await app.inject({
          method: "POST",
          url: "/api/v1/threads/created/queue",
          headers,
          payload: { input: "Continue in Fast", clientMessageId: `fast-${wireTier}` },
        });
        expect(sent.statusCode).toBe(202);
        await vi.waitFor(() =>
          expect(store.view().messageReceipts?.[`fast-${wireTier}`]?.turnId).toBeTruthy(),
        );
        const starts = bridge.request.mock.calls.filter(([method]) => method === "turn/start");
        expect(starts).toHaveLength(2);
        expect(starts[0]?.[1]).toEqual(starts[1]?.[1]);
        expect(starts[1]?.[1]).toMatchObject({ serviceTier: wireTier });
        expect(
          bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
        ).toMatchObject({ serviceTier: wireTier });
        expect(bridge.request.mock.calls.some(([method]) => method === "model/list")).toBe(false);
      } finally {
        await app.close();
      }
    },
  );

  it("sends an explicitly disabled session in the standard tier despite enabled defaults", async () => {
    const { app, bridge, headers, projection } = await createForkHarness();
    try {
      await app.inject({
        method: "PUT",
        url: "/api/v1/settings/task-defaults",
        headers,
        payload: { model: "gpt-a", serviceTier: "fast" },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/projects/project/threads",
        headers,
        payload: { clientCreationId: "off-before-first-turn" },
      });
      const cleared = await app.inject({
        method: "PATCH",
        url: "/api/v1/threads/created/settings",
        headers,
        payload: { serviceTier: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(projection.summary("created")?.settings).not.toHaveProperty("serviceTier");
      bridge.request.mockClear();
      const sent = await app.inject({
        method: "POST",
        url: "/api/v1/threads/created/turns",
        headers,
        payload: { input: "Standard first turn", clientMessageId: "standard-first-turn" },
      });
      expect(sent.statusCode).toBe(201);
      expect(
        bridge.request.mock.calls.find(([method]) => method === "turn/start")?.[1],
      ).toMatchObject({ model: "gpt-a", serviceTier: null });
    } finally {
      await app.close();
    }
  });

  it("preserves Fast in native forks while title generation keeps its standard options", async () => {
    const { app, bridge, headers, projection, threadTitles } = await createForkHarness();
    try {
      bridge.gptAServiceTiers = [{ id: "priority", name: "Priority" }];
      await projection.sync();
      await projection.setSettings("thread", {
        collaborationMode: "default",
        model: "gpt-a",
        serviceTier: "fast",
      });
      bridge.threadTurns.set("thread", [
        {
          ...testTurn("fast-fork-turn", "completed"),
          itemsView: "full",
          items: [agentMessage("fast-fork-answer", "Fork this answer")],
        },
      ]);
      const forked = await app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/forks",
        headers,
        payload: { lastTurnId: "fast-fork-turn", agentMessageId: "fast-fork-answer" },
      });
      expect(forked.statusCode).toBe(201);
      expect(forked.json().thread.settings).toMatchObject({ model: "gpt-a", serviceTier: "fast" });
      expect(
        bridge.request.mock.calls.findLast(([method]) => method === "thread/fork")?.[1],
      ).toMatchObject({ serviceTier: "priority" });
      expect(threadTitles.generate).toHaveBeenCalledWith("Fork this answer", {
        cwd: "/work",
        model: "gpt-a",
        effort: "high",
      });
      const sent = await app.inject({
        method: "POST",
        url: "/api/v1/threads/fork/turns",
        headers,
        payload: { input: "Continue fork", clientMessageId: "fast-fork-continued" },
      });
      expect(sent.statusCode).toBe(201);
      expect(
        bridge.request.mock.calls.findLast(([method]) => method === "turn/start")?.[1],
      ).toMatchObject({ serviceTier: "priority" });
    } finally {
      await app.close();
    }
  });

  it.each([
    { tiers: [{ id: "fast", name: "Fast" }], wireTier: "fast" },
    {
      tiers: [
        { id: "fast", name: "Fast" },
        { id: "priority", name: "Priority" },
      ],
      wireTier: "priority",
    },
    { tiers: [], wireTier: null },
  ])("inherits Team Fast using the child model's tier ($wireTier)", async ({ tiers, wireTier }) => {
    const { app, bridge, projection, store } = await createTeamHarness();
    try {
      bridge.managedModelServiceTiers = tiers;
      await projection.sync();
      await projection.setSettings("thread", {
        collaborationMode: "team",
        model: "gpt-a",
        reasoningEffort: "high",
        serviceTier: "fast",
      });
      bridge.request.mockClear();
      const spawned = dynamicToolJson(
        await callTeamTool(bridge, "thread", "spawn_task", {
          title: "Inherited Fast audit",
          prompt: "Inspect the API.",
          serviceTier: "legacy-tier",
        }),
      );
      await vi.waitFor(() =>
        expect(
          store.view().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]?.status,
        ).toBe("running"),
      );
      expect(
        store.view().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)],
      ).toMatchObject({ resolvedServiceTier: wireTier });
      for (const method of ["thread/start", "thread/resume", "turn/start"]) {
        const call = bridge.request.mock.calls.find(
          ([candidate, params]) =>
            candidate === method &&
            (method === "thread/start"
              ? String(params.threadSource).startsWith("codexnest-managed:")
              : params.threadId === spawned.threadId),
        );
        expect(call?.[1]).toMatchObject({ model: "gpt-5.6-sol", serviceTier: wireTier });
      }
      expect(bridge.request.mock.calls.some(([method]) => method === "model/list")).toBe(false);

      await callTeamTool(bridge, String(spawned.threadId), "submit_result", {
        outcome: "success",
        summary: "Inspection complete.",
      });
      bridge.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: String(spawned.threadId),
          turn: { ...testTurn(`turn-${String(spawned.threadId)}`, "completed"), itemsView: "full" },
        },
      } satisfies ServerNotification);
      await vi.waitFor(() =>
        expect(
          store.view().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]?.delivery
            ?.status,
        ).toBe("delivered"),
      );
      await projection.setSettings("thread", {
        collaborationMode: "team",
        model: "gpt-a",
        reasoningEffort: "high",
      });
      const followup = dynamicToolJson(
        await callTeamTool(bridge, "thread", "followup_task", {
          taskId: spawned.taskId,
          prompt: "Clarify the audit.",
        }),
      );
      await vi.waitFor(() =>
        expect(
          store.view().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)]?.status,
        ).toBe("running"),
      );
      expect(followup.threadId).toBe(spawned.threadId);
      expect(
        store.view().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)],
      ).toMatchObject({ resolvedServiceTier: null });
      expect(
        bridge.request.mock.calls.findLast(
          ([method, params]) => method === "turn/start" && params.threadId === spawned.threadId,
        )?.[1],
      ).toMatchObject({ serviceTier: null });
    } finally {
      await app.close();
    }
  });
});

describe("thread settings", () => {
  it("blocks direct delivery, not draft editing, when Codex refuses input", async () => {
    const { app, bridge, projection, store, headers } = await createForkHarness();
    projection.upsertThread({ ...testThread(), canAcceptDirectInput: false });
    bridge.request.mockClear();
    const send = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { clientMessageId: "direct-test-118025", input: "hello" },
    });
    expect(send.statusCode).toBe(409);
    expect(send.json().error.message).toContain("не принимает");
    expect(
      bridge.request.mock.calls.some(
        ([method]) => method === "turn/start" || method === "thread/resume",
      ),
    ).toBe(false);
    const draft = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread/draft",
      headers,
      payload: { input: "saved", images: [], annotations: [], goalMode: false },
    });
    expect(draft.statusCode).toBe(200);
    expect(store.view().threadMeta.thread?.draft?.input).toBe("saved");
    projection.upsertThread({ ...testThread(), canAcceptDirectInput: null });
    bridge.request.mockRejectedValueOnce(new RpcError(-32600, "thread not loaded"));
    bridge.request.mockResolvedValueOnce({
      thread: { ...testThread(), canAcceptDirectInput: false },
    });
    const resumedSend = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { clientMessageId: "direct-test-119045", input: "after resume" },
    });
    expect(resumedSend.statusCode).toBe(409);
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(store.view().threadMeta.thread?.draft?.input).toBe("saved");
    await app.close();
  });

  it("validates native search requests and returns compatibility failures explicitly", async () => {
    const { app, bridge, headers, projection } = await createForkHarness();
    await app.ready();
    bridge.request.mockClear();
    for (const url of [
      "/api/v1/threads/search?q=",
      "/api/v1/threads/search?q=x&archived=wrong",
      "/api/v1/threads/search?q=x&scope=wrong",
      "/api/v1/threads/search?q=x&scope=",
      "/api/v1/threads/thread/search?q=x&cursor=",
      "/api/v1/threads/thread/turns/turn",
    ]) {
      expect((await app.inject({ url, headers })).statusCode).toBe(400);
    }
    expect(bridge.request).not.toHaveBeenCalled();
    bridge.request.mockResolvedValueOnce({
      data: [{ thread: testThread("outside"), snippet: "text" }],
      nextCursor: "next",
    });
    const response = await app.inject({
      url: "/api/v1/threads/search?q=text&archived=true",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [{ thread: { id: "outside", archived: true }, snippet: "text" }],
      nextCursor: "next",
    });
    expect(bridge.request).toHaveBeenLastCalledWith(
      "thread/search",
      expect.objectContaining({ searchTerm: "text", archived: true }),
      30_000,
    );
    projection.upsertThread(
      {
        ...testThread("old-session"),
        name: "Обновить хедеры MEXC и задеплоить",
        preview: "надо обновить хедерсы",
        historyMode: "legacy",
      },
      true,
    );
    bridge.request.mockClear();
    const titles = await app.inject({
      url: `/api/v1/threads/search?q=${encodeURIComponent("MEXC ХЕДЕРЫ")}&scope=titles&archived=true`,
      headers,
    });
    expect(titles.statusCode).toBe(200);
    expect(titles.json()).toMatchObject({
      data: [
        {
          thread: { id: "old-session", title: "Обновить хедеры MEXC и задеплоить", archived: true },
          snippet: "",
        },
      ],
      nextCursor: null,
    });
    const invalidCursor = await app.inject({
      url: "/api/v1/threads/search?q=text&scope=titles&cursor=messages-page",
      headers,
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(bridge.request).not.toHaveBeenCalled();
    bridge.request.mockRejectedValueOnce(new RpcError(-32601, "not found"));
    expect((await app.inject({ url: "/api/v1/threads/search?q=text", headers })).statusCode).toBe(
      503,
    );
    await app.close();
  });
  it.each(["default", "plan", "team"] as const)(
    "explains explicit image delivery in existing %s sessions without an extra resume",
    async (collaborationMode) => {
      const { app, bridge, projection, store, headers } = await createTeamHarness();
      try {
        await projection.setSettings("thread", { collaborationMode });
        expect(store.view().threadMeta.thread?.sessionArtifactsVersion).toBeUndefined();
        const before = bridge.request.mock.calls.length;
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/threads/thread/turns",
          headers,
          payload: {
            clientMessageId: `image-delivery-${collaborationMode}`,
            input: "Покажи снимок",
          },
        });
        expect(response.statusCode).toBe(201);
        const calls = bridge.request.mock.calls.slice(before);
        expect(calls.filter(([method]) => method === "thread/resume")).toHaveLength(0);
        const starts = calls.filter(([method]) => method === "turn/start");
        expect(starts).toHaveLength(1);
        expect(starts[0]?.[1]).toMatchObject({
          additionalContext: {
            "codexnest.images": {
              kind: "application",
              value: expect.stringMatching(
                /only in expandable technical details.*Markdown image.*commentary, plan, or final message.*outside that directory.*view_image.*Do not claim to have shown/is,
              ),
            },
          },
        });
      } finally {
        await app.close();
      }
    },
  );

  it("persists settings on the server and maps plan mode into turn/start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-settings-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
      state.projects.push({
        id: "project",
        displayName: "Project",
        path: "/work",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    const activityEvents: ServerEvent[] = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "activity.upserted" && event.item.type === "userMessage") {
        activityEvents.push(event);
      }
    });
    const threadTitles = {
      generate: vi.fn(async (input: string) =>
        input === "Первое сообщение" ? "Первая задача" : "Начать работу",
      ),
    };
    const config = loadConfig({
      statePath: store.path,
      clientDist: join(directory, "missing"),
      allowedOrigins: new Set(["http://localhost"]),
      websocketAuthTimeoutMs: 25,
    });
    const app = await buildApp(config, {
      bridge: bridge as unknown as CodexBridge,
      store,
      projection,
      attention,
      threadTitles,
      projectRoot: directory,
    });
    const headers = { authorization: "Bearer correct" };

    const threadListsBeforeRefresh = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/list",
    ).length;
    const modelListsBeforeRefresh = bridge.request.mock.calls.filter(
      ([method]) => method === "model/list",
    ).length;
    const threadReadsBeforeRefresh = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/read",
    ).length;
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/refresh",
      headers,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      snapshot: {
        instanceId: expect.any(String),
        sequence: expect.any(Number),
      },
      detail: {
        version: {
          instanceId: expect.any(String),
          sequence: expect.any(Number),
        },
        summary: expect.objectContaining({ id: "thread" }),
        turns: [],
      },
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/list").length).toBe(
      threadListsBeforeRefresh,
    );
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/read").length,
    ).toBeGreaterThan(threadReadsBeforeRefresh);
    expect(bridge.request.mock.calls.filter(([method]) => method === "model/list").length).toBe(
      modelListsBeforeRefresh,
    );
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/turns/list")?.[1],
    ).toMatchObject({ threadId: "thread", itemsView: "full" });

    const requestLogger = vi.spyOn(app.log, "child").mockReturnValue(app.log);
    const errorLog = vi.spyOn(app.log, "error");
    bridge.nextTurnListError = new RpcError(-32_000, "Rollout changed while reading turns");
    const failedRefresh = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/refresh",
      headers,
    });
    expect(failedRefresh.statusCode).toBe(503);
    expect(failedRefresh.json()).toMatchObject({
      error: { code: "app_server_unavailable" },
    });
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
    requestLogger.mockRestore();

    await store.update((state) => {
      state.threadMeta.viewed = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastOutcome: "completed",
        outcomeUpdatedAt: 2_000,
      };
    });
    projection.upsertThread({ ...testThread("viewed"), status: { type: "idle" } });
    expect(projection.summary("viewed")).toMatchObject({ unread: true, unseen: true });

    const viewed = await app.inject({ url: "/api/v1/threads/viewed", headers });
    expect(viewed.statusCode).toBe(200);
    expect(viewed.json().summary).toMatchObject({ unread: true, unseen: true });
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBeUndefined();

    const refreshedViewed = await app.inject({
      method: "POST",
      url: "/api/v1/threads/viewed/refresh",
      headers,
    });
    expect(refreshedViewed.statusCode).toBe(200);
    expect(refreshedViewed.json().detail.summary).toMatchObject({ unread: true, unseen: true });
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBeUndefined();

    const viewedHistory = await app.inject({
      url: "/api/v1/threads/viewed/history?cursor=cursor&anchorTurnId=turn",
      headers,
    });
    expect(viewedHistory.statusCode).toBe(200);
    expect(viewedHistory.json()).toMatchObject({ anchorTurnId: "turn" });
    expect(projection.summary("viewed")).toMatchObject({ unread: true, unseen: true });
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBeUndefined();

    const legacyPage = await app.inject({
      url: "/api/v1/threads/viewed?cursor=cursor",
      headers,
    });
    expect(legacyPage.statusCode).toBe(200);
    expect(legacyPage.json()).toMatchObject({
      summary: { id: "viewed" },
      version: { instanceId: expect.any(String), sequence: expect.any(Number) },
    });

    const legacyChanges = await app.inject({
      url: "/api/v1/threads/viewed/changes?cursor=cursor&anchorTurnId=turn&anchorRevision=revision",
      headers,
    });
    expect(legacyChanges.statusCode).toBe(200);
    expect(legacyChanges.json()).toMatchObject({
      summary: { id: "viewed" },
      resetLatest: true,
      continuationCursor: null,
      syncPoint: null,
    });

    const markedViewed = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/viewed/viewed",
      headers,
      payload: { observedUpdatedAt: 2_000 },
    });
    expect(markedViewed.statusCode).toBe(204);
    expect(projection.summary("viewed")).toMatchObject({ unread: true, unseen: false });
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBe(2_000);

    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/threads/viewed/viewed",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/threads/missing/viewed",
          headers,
          payload: { observedUpdatedAt: 2_000 },
        })
      ).statusCode,
    ).toBe(404);

    projection.upsertThread({
      ...testThread("viewed"),
      updatedAt: 3,
      recencyAt: 3,
      status: { type: "idle" },
    });
    expect(projection.summary("viewed")?.unseen).toBe(true);
    const olderViewed = await app.inject({
      url: "/api/v1/threads/viewed?cursor=older",
      headers,
    });
    expect(olderViewed.statusCode).toBe(200);
    expect(projection.summary("viewed")?.unseen).toBe(true);
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBe(2_000);

    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/threads/viewed/viewed",
          headers,
          payload: { observedUpdatedAt: 2_000 },
        })
      ).statusCode,
    ).toBe(204);
    expect(projection.summary("viewed")?.unseen).toBe(true);
    expect(store.snapshot().threadMeta.viewed?.lastViewedUpdatedAt).toBe(2_000);

    const missingGitChanges = await app.inject({
      url: "/api/v1/threads/missing/git-changes",
      headers,
    });
    expect(missingGitChanges.statusCode).toBe(404);
    expect(missingGitChanges.json()).toMatchObject({ error: { code: "not_found" } });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/v1/threads/missing",
          headers,
        })
      ).statusCode,
    ).toBe(404);

    projection.upsertThread({
      ...testThread("child"),
      parentThreadId: "thread",
      ephemeral: true,
      agentNickname: "reviewer",
      agentRole: "worker",
    });
    expect(projection.summary("child")?.relation).toEqual({
      kind: "subagent",
      sessionId: "child",
      parentThreadId: "thread",
      nickname: "reviewer",
      role: "worker",
    });
    expect((await app.inject({ url: "/api/v1/threads/child", headers })).statusCode).toBe(200);
    for (const request of [
      {
        method: "PUT",
        url: "/api/v1/threads/child/draft",
        payload: { input: "Нет", images: [], goalMode: false, annotations: [] },
      },
      {
        method: "PATCH",
        url: "/api/v1/threads/child/settings",
        payload: { collaborationMode: "team" },
      },
      {
        method: "POST",
        url: "/api/v1/threads/child/turns",
        payload: { clientMessageId: "direct-test-129624", input: "Нет" },
      },
    ]) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: "conflict",
          message: "Subagent threads are managed by their parent session",
        },
      });
    }

    const turnsBeforeEmptyThread = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    const threadStartsBeforeEmptyThread = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/start",
    ).length;
    projection.upsertThread({
      ...testThread("stale-empty"),
      cwd: "/work",
      preview: "",
      updatedAt: 3,
      recencyAt: 3,
    });
    await projection.markUnmaterialized("stale-empty");
    await store.update((state) => {
      const meta = state.threadMeta["stale-empty"]!;
      meta.managedTeamToolsAvailable = true;
      meta.sessionArtifactsVersion = 1;
    });
    bridge.missingRolloutThreadIds.add("stale-empty");
    const [emptyCreated, emptyReopened] = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/projects/project/threads",
          payload: { clientCreationId: "test-creation" },
          headers,
        }),
      ),
    );
    expect(emptyCreated.statusCode).toBe(201);
    expect(emptyCreated.json().draft).toBeNull();
    expect(emptyReopened.json().thread.id).toBe(emptyCreated.json().thread.id);
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      threadStartsBeforeEmptyThread + 1,
    );
    expect(projection.summary("stale-empty")).toBeDefined();
    expect(bridge.request.mock.calls.some(([method]) => method === "thread/metadata/update")).toBe(
      false,
    );
    expect(emptyCreated.json().thread.settings).toEqual({ collaborationMode: "plan" });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/start").at(-1)?.[1],
    ).toMatchObject({ cwd: "/work", dynamicTools: expect.any(Array) });
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      turnsBeforeEmptyThread,
    );
    const disabledEmpty = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/created/settings",
      headers,
      payload: { collaborationMode: "default" },
    });
    expect(disabledEmpty.json().settings).toEqual({ collaborationMode: "default" });
    const resetEmpty = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      payload: { clientCreationId: "test-creation" },
      headers,
    });
    expect(resetEmpty.json().thread).toMatchObject({
      id: "created",
      settings: { collaborationMode: "default" },
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      threadStartsBeforeEmptyThread + 1,
    );
    const emptyDetail = await app.inject({
      url: "/api/v1/threads/created",
      headers,
    });
    expect(emptyDetail.statusCode).toBe(200);
    expect(emptyDetail.json().turns).toEqual([]);
    expect(emptyDetail.json().draft).toBeNull();
    const savedDraft = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/created/draft",
      headers,
      payload: {
        input: "  Черновик без обрезки  ",
        images: [
          {
            id: "image",
            name: "example.png",
            url: "data:image/png;base64,AA==",
          },
        ],
        goalMode: true,
        annotations: [
          {
            id: "annotation",
            messageId: "agent",
            source: "agentMessage",
            quote: "Фрагмент",
            startOffset: 0,
            endOffset: 8,
            comment: "Комментарий",
            createdAt: 1,
          },
        ],
      },
    });
    expect(savedDraft.statusCode).toBe(200);
    expect(savedDraft.json()).toMatchObject({
      input: "  Черновик без обрезки  ",
      goalMode: true,
      updatedAt: expect.any(Number),
    });
    expect(
      (
        await app.inject({
          url: "/api/v1/threads/created",
          headers,
        })
      ).json().draft,
    ).toEqual(savedDraft.json());
    const callsBeforeDraftReopen = bridge.request.mock.calls.length;
    const draftReopened = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      payload: { clientCreationId: "test-creation" },
      headers,
    });
    expect(draftReopened.statusCode).toBe(201);
    expect(draftReopened.json().thread.id).toBe("created");
    expect(draftReopened.json().draft).toEqual(savedDraft.json());
    expect(bridge.request.mock.calls.slice(callsBeforeDraftReopen)).toEqual([]);
    const teamResumeStart = bridge.request.mock.calls.length;
    const emptyTeam = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/created/settings",
      headers,
      payload: { collaborationMode: "team" },
    });
    expect(emptyTeam.statusCode).toBe(200);
    expect(emptyTeam.json().settings).toEqual({ collaborationMode: "team" });
    expect(
      bridge.request.mock.calls
        .slice(teamResumeStart)
        .filter(([method]) => method === "thread/resume" || method === "thread/metadata/update"),
    ).toEqual([
      [
        "thread/resume",
        expect.objectContaining({
          threadId: "created",
          config: { agents: { enabled: false } },
          developerInstructions: expect.stringMatching(/standalone final deliverables/i),
        }),
        30_000,
      ],
    ]);
    const resumesBeforeFirstTurn = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/resume",
    ).length;
    const firstTurn = await app.inject({
      method: "POST",
      url: "/api/v1/threads/created/turns",
      headers,
      payload: { clientMessageId: "direct-test-135941", input: "Первое сообщение" },
    });
    expect(firstTurn.statusCode).toBe(201);
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
      resumesBeforeFirstTurn,
    );
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      additionalContext: {
        "codexnest.team": {
          kind: "application",
          value: expect.stringContaining("codexnest managed-task tools"),
        },
      },
    });
    expect(store.snapshot().threadMeta.created?.unmaterialized).toBe(false);
    expect(store.snapshot().threadMeta.created?.draft).toBeUndefined();
    await vi.waitFor(() =>
      expect(threadTitles.generate).toHaveBeenCalledWith("Первое сообщение", {
        cwd: "/work",
        model: "gpt-a",
        effort: "high",
      }),
    );
    expect(bridge.request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "created",
      name: "Первая задача",
    });

    await projection.setSettings("thread", {
      collaborationMode: "default",
      model: "gpt-a",
      reasoningEffort: "high",
      serviceTier: "fast",
      personality: "friendly",
    });

    const preferredEffort = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { reasoningEffort: "high" },
    });
    expect(preferredEffort.statusCode).toBe(200);
    expect(store.snapshot().defaultReasoningEffort).toBe("high");

    bridge.nextCreatedThreadId = "inherited";
    const inherited = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      payload: { clientCreationId: "inherited-creation" },
      headers,
    });
    expect(inherited.statusCode).toBe(201);
    expect(inherited.json().draft).toBeNull();
    expect(inherited.json().thread.settings).toEqual({
      collaborationMode: "plan",
      reasoningEffort: "high",
    });

    const resetPreference = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { collaborationMode: "default", reasoningEffort: null },
    });
    expect(resetPreference.statusCode).toBe(200);
    expect(resetPreference.json().settings).toEqual({
      collaborationMode: "default",
      model: "gpt-a",
      serviceTier: "fast",
      personality: "friendly",
    });
    expect(store.snapshot().defaultReasoningEffort).toBeUndefined();

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { model: "gpt-b", collaborationMode: "plan" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings).toEqual({
      collaborationMode: "plan",
      model: "gpt-b",
    });
    expect(store.snapshot().threadMeta.thread?.settings).toEqual(updated.json().settings);

    const clientOverride = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: {
        clientMessageId: "direct-test-138920",
        input: "Не используй это",
        settings: { collaborationMode: "default", model: "gpt-a" },
      },
    });
    expect(clientOverride.statusCode).toBe(400);

    const started = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { input: "Составь план", clientMessageId: "client-started" },
    });
    expect(started.statusCode).toBe(201);
    const resumeCall = bridge.request.mock.calls
      .filter(([method]) => method === "thread/resume")
      .at(-1);
    expect(resumeCall?.[1]).not.toHaveProperty("sandbox");
    expect(resumeCall?.[1]).not.toHaveProperty("approvalPolicy");
    expect(resumeCall?.[1]).not.toHaveProperty("approvalsReviewer");
    const startCall = bridge.request.mock.calls
      .filter(([method]) => method === "turn/start")
      .at(-1);
    expect(startCall?.[1]).toMatchObject({
      threadId: "thread",
      clientUserMessageId: "client-started",
      model: "gpt-b",
      additionalContext: {
        "codexnest.plan": {
          kind: "application",
          value: expect.stringMatching(
            /Follow the built-in Plan mode instructions.*incorporate all agreed clarifications.*one full replacement <proposed_plan> block.*even if the plan itself is unchanged.*questions remain unresolved.*do not present an incomplete plan/s,
          ),
        },
      },
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-b",
          reasoning_effort: "low",
          developer_instructions: null,
        },
      },
    });
    expect(startCall?.[1]).not.toHaveProperty("approvalPolicy");
    expect(startCall?.[1]).not.toHaveProperty("approvalsReviewer");
    expect(activityEvents.at(-1)).toMatchObject({
      threadId: "thread",
      turnId: "turn",
      item: {
        type: "userMessage",
        id: "client-started",
        text: "Составь план",
      },
    });

    const userInputTransport = {
      respond: vi.fn(),
      respondError: vi.fn(),
    };
    const userInputRequest = attention.receive(
      {
        method: "item/tool/requestUserInput",
        id: 7,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "question",
          autoResolutionMs: null,
          questions: [
            {
              id: "transition",
              header: "Переходы",
              question: "Что делать с раскрытой веткой?",
              isOther: true,
              isSecret: false,
              options: [
                {
                  label: "Оставлять открытой",
                  description: "Сохранять состояние.",
                },
              ],
            },
          ],
        },
      } as ServerRequest,
      userInputTransport as unknown as JsonlTransport,
    );
    const asyncDraft = {
      input: "Не отправлять черновик",
      images: [],
      annotations: [],
      goalMode: false,
      updatedAt: 1,
    };
    await store.update((state) => {
      state.threadMeta.thread!.draft = asyncDraft;
    });
    const asyncResponse = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: {
        input: "Отдельный вопрос\nОтвет",
        clientMessageId: "async-reply",
        replyToAsyncQuestion: { turnId: "turn", itemId: "async-question" },
      },
    });
    expect(asyncResponse.statusCode).toBe(202);
    expect(asyncResponse.json().replyToAsyncQuestion).toEqual({
      turnId: "turn",
      itemId: "async-question",
    });
    await vi.waitFor(() =>
      expect(store.snapshot().messageReceipts?.["async-reply"]?.turnId).toBeDefined(),
    );
    expect(userInputTransport.respond).not.toHaveBeenCalled();
    expect(attention.get(userInputRequest.id)).toBeDefined();
    expect(store.snapshot().threadMeta.thread?.draft).toEqual(asyncDraft);
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/steer").at(-1)?.[1],
    ).toMatchObject({
      clientUserMessageId: "async-reply",
      input: [expect.objectContaining({ text: "Отдельный вопрос\nОтвет" })],
    });
    const steersBeforeUserInput = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/steer",
    ).length;
    const queuedUserInput = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Закрывать автоматически", clientMessageId: "client-user-input" },
    });
    expect(queuedUserInput.statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(bridge.request).toHaveBeenCalledWith(
        "turn/steer",
        expect.objectContaining({
          clientUserMessageId: "client-user-input",
          input: [expect.objectContaining({ text: "Закрывать автоматически" })],
          userInputResponse: {
            itemId: "question",
            response: {
              answers: {},
            },
          },
        }),
      ),
    );
    await vi.waitFor(() => expect(store.snapshot().messageQueues?.thread).toBeUndefined());
    expect(attention.list()).not.toContainEqual(
      expect.objectContaining({ id: userInputRequest.id }),
    );
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(
      steersBeforeUserInput + 1,
    );
    expect(store.snapshot().threadMeta.thread?.timelineArtifacts?.turn ?? []).not.toContainEqual(
      expect.objectContaining({
        type: "userInputResponse",
      }),
    );
    const repeatedUserInputSend = await app.inject({
      method: "POST",
      url: `/api/v1/threads/thread/queue/${queuedUserInput.json().id}/send`,
      headers,
    });
    expect(repeatedUserInputSend.statusCode).toBe(200);
    expect(repeatedUserInputSend.json()).toEqual({ turnId: "turn" });

    bridge.nextCreatedThreadId = "team-root";
    const teamRoot = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      payload: { clientCreationId: "team-root-creation" },
      headers,
    });
    expect(teamRoot.statusCode).toBe(201);
    const teamThreadId = teamRoot.json().thread.id as string;
    const teamSettings = await app.inject({
      method: "PATCH",
      url: `/api/v1/threads/${teamThreadId}/settings`,
      headers,
      payload: {
        collaborationMode: "team",
        model: "gpt-a",
        reasoningEffort: "high",
      },
    });
    expect(teamSettings.statusCode).toBe(200);
    expect(teamSettings.json().settings).toEqual({
      collaborationMode: "team",
      model: "gpt-a",
      reasoningEffort: "high",
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "thread/resume").at(-1)?.[1],
    ).toMatchObject({
      config: { agents: { enabled: false } },
    });
    const teamThreadStart = bridge.request.mock.calls
      .filter(([method]) => method === "thread/start")
      .at(-1)?.[1] as {
      dynamicTools?: Array<{
        type: string;
        tools?: Array<{
          name: string;
          description: string;
          inputSchema: { properties?: Record<string, unknown> };
        }>;
      }>;
    };
    const teamCreated = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${teamThreadId}/turns`,
      headers,
      payload: { clientMessageId: "direct-test-145681", input: "Выполни многошаговый план" },
    });
    expect(teamCreated.statusCode).toBe(201);
    const managedTools = teamThreadStart.dynamicTools?.find(
      (candidate) => candidate.type === "namespace",
    )?.tools;
    for (const toolName of ["spawn_task", "followup_task"]) {
      const properties = managedTools?.find((candidate) => candidate.name === toolName)?.inputSchema
        .properties;
      expect(properties).toHaveProperty("reasoningEffort");
      expect(properties).not.toHaveProperty("serviceTier");
      expect(properties).not.toHaveProperty("model");
      expect(properties).not.toHaveProperty("tokenBudget");
      expect(properties).not.toHaveProperty("timeoutMinutes");
    }
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      effort: "high",
      collaborationMode: {
        mode: "default",
        settings: { model: "gpt-a", reasoning_effort: "high" },
      },
      additionalContext: {
        "codexnest.team": {
          kind: "application",
          value: expect.stringMatching(
            /may perform any part.*inspecting.*analyzing.*editing.*testing.*Delegate only.*materially useful.*codexnest managed-task tools.*never use native subagent tools.*smallest sufficient solution.*concrete, confirmed risk.*Before calling codexnest\.spawn_task.*necessary to achieve the user's original goal.*Honor an explicit user request.*main session.*Do not create managed tasks for optional improvements.*checks without a concrete target.*asks to stop or cancel subagents.*codexnest\.list_tasks.*codexnest\.cancel_task.*queued, starting, or running.*Do not create replacement tasks.*After every meaningful stage.*reassess the remaining plan.*only with steps that are still necessary.*Every test, command run, and checklist item.*specific product risk or an observed defect.*Omit it otherwise.*full conversation and complete plan only in the root coordinator's context.*only the single assigned plan step and the minimum task-specific context.*Never copy or summarize the conversation.*Once work is delegated.*do not duplicate the same scope.*fixed delay.*start, initial health check, sleep, and final inspection.*never wait in the parent.*codexnest\.inspect_task.*steer_task.*cancel_task.*prompts and steering messages in English.*task titles.*user's language/is,
          ),
        },
      },
    });
    const teamContext = (
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1] as {
        additionalContext?: Record<string, { value?: unknown }>;
      }
    ).additionalContext?.["codexnest.team"]?.value;
    expect(teamContext).toEqual(
      expect.stringMatching(
        /^This session is in CodexNest Team mode\..*Managed tasks are event-driven:.*automatically delivers its result and resumes this parent session\./s,
      ),
    );
    expect(teamContext).toEqual(
      expect.stringMatching(
        /Never keep the parent turn open.*queued or running.*never call tools merely to keep the turn alive.*finishing all independent parent work.*immediately finish the turn\./s,
      ),
    );
    expect(teamContext).toEqual(
      expect.stringMatching(
        /Never call sleep.*codexnest\.list_tasks.*codexnest\.inspect_task.*check whether a child is done.*waiting loop.*polling\./s,
      ),
    );
    expect(managedTools?.find((tool) => tool.name === "list_tasks")?.description).toMatch(
      /one-time snapshot.*explicit status request.*cancellation.*coordination decision.*Never use this tool to wait or poll.*completion automatically resumes the parent/i,
    );
    expect(managedTools?.find((tool) => tool.name === "inspect_task")?.description).toMatch(
      /explicit status request.*watchdog investigation.*corrective action.*terminal-result workspace review.*Never use this tool to monitor progress, wait, or poll.*completion automatically resumes the parent/i,
    );
    expect(teamContext).toEqual(
      expect.stringContaining(
        "set access.network to true in that case and leave it false for local-only work",
      ),
    );
    expect(teamContext).toEqual(
      expect.stringContaining("Never run parallel sharedWrite tasks whose write paths overlap"),
    );
    expect(teamContext).toEqual(
      expect.stringContaining("Parallel isolatedWrite tasks may edit overlapping files"),
    );
    expect(teamContext).toEqual(
      expect.stringContaining("codexnest.inspect_task to obtain workspacePath"),
    );
    const startsBeforeInvalidTeamGoal = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    const invalidTeamGoal = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${teamThreadId}/turns`,
      headers,
      payload: { clientMessageId: "direct-test-150477", input: "Несовместимо", goal: true },
    });
    expect(invalidTeamGoal.statusCode).toBe(409);
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      startsBeforeInvalidTeamGoal,
    );

    await app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread/draft",
      headers,
      payload: { input: "Черновик очереди", images: [], goalMode: false, annotations: [] },
    });
    expect(store.snapshot().threadMeta.thread?.draft?.input).toBe("Черновик очереди");
    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Поставь в очередь", clientMessageId: "client-queued" },
    });
    expect(queued.statusCode).toBe(202);
    expect(store.snapshot().threadMeta.thread?.draft).toBeUndefined();
    expect(store.snapshot().messageQueues?.thread).toEqual([
      expect.objectContaining({
        id: "client-queued",
        text: "Поставь в очередь",
        status: "queued",
      }),
    ]);
    const editedQueued = await app.inject({
      method: "PATCH",
      url: `/api/v1/threads/thread/queue/${queued.json().id}`,
      headers,
      payload: { input: "  Исправленный текст  " },
    });
    expect(editedQueued.statusCode).toBe(200);
    expect(editedQueued.json()).toMatchObject({
      id: "client-queued",
      text: "Исправленный текст",
      status: "queued",
    });
    const invalidQueuedEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/threads/thread/queue/${queued.json().id}`,
      headers,
      payload: { input: " " },
    });
    expect(invalidQueuedEdit.statusCode).toBe(400);

    const cancellable = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Удалить из очереди", clientMessageId: "client-cancelled" },
    });
    const cancelled = await app.inject({
      method: "DELETE",
      url: `/api/v1/threads/thread/queue/${cancellable.json().id}`,
      headers,
    });
    expect(cancelled.statusCode).toBe(204);
    expect(store.snapshot().messageQueues?.thread).toEqual([
      expect.objectContaining({ id: "client-queued", text: "Исправленный текст" }),
    ]);

    const sentNow = await app.inject({
      method: "POST",
      url: `/api/v1/threads/thread/queue/${queued.json().id}/send`,
      headers,
    });
    expect(sentNow.statusCode).toBe(200);
    expect(sentNow.json()).toEqual({ turnId: "turn" });
    expect(queued.json().id).toBe("client-queued");
    expect(store.snapshot().messageQueues?.thread).toBeUndefined();
    expect(store.snapshot().messageReceipts?.["client-queued"]?.turnId).toBe("turn");
    expect(projection.summary("thread")?.currentTurnId).toBe("turn");
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/steer").at(-1)?.[1],
    ).toMatchObject({
      clientUserMessageId: queued.json().id,
      input: [{ type: "text", text: "Исправленный текст", text_elements: [] }],
    });
    expect(activityEvents.at(-1)).toMatchObject({
      threadId: "thread",
      turnId: "turn",
      item: {
        type: "userMessage",
        id: "client-queued",
        text: "Исправленный текст",
      },
    });

    const queuedAfterSteer = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Продолжить после steering", clientMessageId: "client-after-steer" },
    });
    expect(queuedAfterSteer.statusCode).toBe(202);
    const startsBeforeSteeredCompletion = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread", turn: testTurn("turn", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        startsBeforeSteeredCompletion + 1,
      ),
    );
    await vi.waitFor(() => expect(store.snapshot().messageQueues?.thread).toBeUndefined());
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({ clientUserMessageId: "client-after-steer" });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { collaborationMode: "automatic" },
    });
    expect(invalid.statusCode).toBe(400);

    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread", turn: testTurn("running", "inProgress") },
    } satisfies ServerNotification);
    expect(projection.summary("thread")?.currentTurnId).toBe("running");
    const conflict = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { collaborationMode: "default" },
    });
    expect(conflict.statusCode).toBe(409);

    const nextQueued = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { clientMessageId: "direct-test-155974", input: "Следующий ход" },
    });
    expect(nextQueued.statusCode).toBe(202);
    const startsBeforeCompletion = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread", turn: testTurn("running", "completed") },
    } satisfies ServerNotification);
    await vi.waitFor(() =>
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        startsBeforeCompletion + 1,
      ),
    );
    await vi.waitFor(() => expect(store.snapshot().messageQueues?.thread).toBeUndefined());

    const image = `data:image/png;base64,${"a".repeat(1_100_000)}`;
    const imageTurn = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: {
        clientMessageId: "direct-test-156840",
        input: "Проверь изображение",
        images: [image],
      },
    });
    expect(imageTurn.statusCode).toBe(201);
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      input: [
        { type: "text", text: "Проверь изображение", text_elements: [] },
        { type: "image", url: image },
      ],
    });

    const defaults = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/task-defaults",
      headers,
      payload: {
        model: "gpt-a",
        titleModel: "gpt-b",
        serviceTier: "fast",
        personality: "friendly",
      },
    });
    expect(defaults.statusCode).toBe(200);
    expect(store.snapshot().taskDefaults).toEqual({
      model: "gpt-a",
      titleModel: "gpt-b",
      serviceTier: "fast",
      personality: "friendly",
    });
    expect(projection.summary("thread")?.settings).not.toMatchObject({ serviceTier: "fast" });
    bridge.nextCreatedThreadId = "with-defaults";
    const withDefaults = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      payload: { clientCreationId: "defaults-creation" },
      headers,
    });
    expect(withDefaults.json().thread.settings).toMatchObject({
      model: "gpt-a",
      serviceTier: "fast",
      personality: "friendly",
    });

    const goalCallStart = bridge.request.mock.calls.length;
    const goalStart = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: {
        clientMessageId: "direct-test-158276",
        input: "Доведи задачу до конца",
        goal: true,
      },
    });
    expect(goalStart.statusCode).toBe(201);
    expect(
      bridge.request.mock.calls
        .slice(goalCallStart)
        .map(([method, params]) => [
          method,
          method === "thread/goal/set" ? params.status : undefined,
        ]),
    ).toEqual([
      ["thread/goal/set", "paused"],
      ["turn/start", undefined],
      ["thread/goal/set", "active"],
    ]);
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({ collaborationMode: { mode: "default" } });
    expect(
      (await app.inject({ url: "/api/v1/threads/thread/goal", headers })).json(),
    ).toMatchObject({ objective: "Доведи задачу до конца", status: "active" });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/threads/thread/goal",
          headers,
          payload: { status: "paused" },
        })
      ).json(),
    ).toMatchObject({ status: "paused" });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/threads/thread/goal",
          headers,
          payload: { status: "active" },
        })
      ).json(),
    ).toMatchObject({ status: "active" });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/v1/threads/thread/goal",
          headers,
        })
      ).statusCode,
    ).toBe(204);

    bridge.failNextTurnStart = true;
    await app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread/draft",
      headers,
      payload: { input: "Черновик ошибки", images: [], goalMode: true, annotations: [] },
    });
    const activityCountBeforeFailure = activityEvents.length;
    const failedFirstTurn = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: {
        input: "Эта цель не запустится",
        goal: true,
        clientMessageId: "client-failed",
      },
    });
    expect(failedFirstTurn.statusCode).toBe(500);
    expect(bridge.goal).toBeNull();
    expect(activityEvents).toHaveLength(activityCountBeforeFailure);
    expect(store.snapshot().threadMeta.thread?.draft?.input).toBe("Черновик ошибки");

    bridge.failNextGoalActivation = true;
    const failedActivation = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: {
        clientMessageId: "direct-test-160774",
        input: "Цель останется на паузе",
        goal: true,
      },
    });
    expect(failedActivation.statusCode).toBe(201);
    expect(failedActivation.json().goalWarning).toMatch(/осталась на паузе/i);
    expect(bridge.goal).toMatchObject({ status: "paused" });
    expect(store.snapshot().threadMeta.thread?.draft).toBeUndefined();

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/threads/thread",
      headers,
    });
    expect(deleted.statusCode).toBe(404);
    expect(bridge.request).not.toHaveBeenCalledWith("thread/delete", { threadId: "thread" });
    expect(store.snapshot().threadMeta.thread).toBeDefined();
    await app.close();
  });

  it("saves validated active user-input drafts and rejects stale or incompatible requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-user-input-draft-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      { bridge: bridge as unknown as CodexBridge, store, projection, attention },
    );
    const headers = { authorization: "Bearer correct" };
    const userInput = attention.receive(
      {
        method: "item/tool/requestUserInput",
        id: 501,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          autoResolutionMs: null,
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Which one?",
              isOther: true,
              isSecret: false,
              options: null,
            },
          ],
        },
      } as ServerRequest,
      { respond: vi.fn(), respondError: vi.fn() } as unknown as JsonlTransport,
    );

    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/attention/${userInput.id}/draft`,
      headers,
      payload: { answers: { choice: ["First"] }, currentQuestionId: "choice" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      answers: { choice: ["First"] },
      currentQuestionId: "choice",
      revision: 1,
      updatedAt: expect.any(Number),
    });

    for (const payload of [
      { answers: { unknown: ["value"] }, currentQuestionId: null },
      { answers: { choice: [] }, currentQuestionId: null },
      { answers: { choice: ["   "] }, currentQuestionId: null },
      { answers: { choice: ["one", "two"] }, currentQuestionId: null },
      { answers: {}, currentQuestionId: "unknown" },
    ]) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/v1/attention/${userInput.id}/draft`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }

    attention.expireAll();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/attention/${userInput.id}/draft`,
          headers,
          payload: { answers: {}, currentQuestionId: null },
        })
      ).statusCode,
    ).toBe(409);
    const approval = attention.receive(
      {
        method: "item/commandExecution/requestApproval",
        id: 502,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "command",
          startedAtMs: 1,
          environmentId: null,
          command: "pwd",
          cwd: "/work",
        },
      } as ServerRequest,
      { respond: vi.fn(), respondError: vi.fn() } as unknown as JsonlTransport,
    );
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/attention/${approval.id}/draft`,
          headers,
          payload: { answers: {}, currentQuestionId: null },
        })
      ).statusCode,
    ).toBe(409);
    await app.close();
  });

  it("reads and atomically updates global Codex permission presets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-permissions-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
    });
    const bridge = new SettingsBridge();
    const { codexManager, codexStatus } = createCodexManagerMock();
    const { appManager, appStatus } = createAppManagerMock();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
        websocketAuthTimeoutMs: 25,
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
        codexManager,
        appManager,
        projectRoot: directory,
      },
    );
    const headers = { authorization: "Bearer correct" };

    const read = await app.inject({ url: "/api/v1/settings/permissions", headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      preset: "auto",
      version: "version-1",
      overridden: false,
      message: null,
    });

    expect(
      bridge.request.mock.calls.filter(([method]) => method === "account/rateLimits/read"),
    ).toHaveLength(1);
    const rateLimits = await app.inject({ url: "/api/v1/codex/rate-limits", headers });
    expect(rateLimits.statusCode).toBe(200);
    expect(rateLimits.json()).toEqual({
      ordinaryUsageAllowed: null,
      spendControlReached: null,
      rateLimitReachedType: null,
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_785_258_183_000 },
      secondary: {
        usedPercent: 40,
        windowDurationMins: 10_080,
        resetsAt: 1_785_344_583_000,
      },
    });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "account/rateLimits/read"),
    ).toEqual([
      ["account/rateLimits/read", undefined],
      ["account/rateLimits/read", undefined],
    ]);

    const management = await app.inject({ url: "/api/v1/settings/codex", headers });
    expect(management.statusCode).toBe(200);
    expect(management.json()).toEqual(codexStatus);
    expect(JSON.stringify(management.json())).not.toContain("secret");

    const appManagement = await app.inject({ url: "/api/v1/settings/app", headers });
    expect(appManagement.statusCode).toBe(200);
    expect(appManagement.json()).toEqual(appStatus);
    const checkedApp = await app.inject({
      method: "POST",
      url: "/api/v1/settings/app/check",
      headers,
    });
    expect(checkedApp.json()).toMatchObject({ latestVersion: "0.2.0", updateAvailable: true });
    const queuedApp = await app.inject({
      method: "POST",
      url: "/api/v1/settings/app/update",
      headers,
    });
    expect(queuedApp.json()).toMatchObject({ operation: "preparing" });
    expect(appManager.check).toHaveBeenCalledOnce();
    expect(appManager.update).toHaveBeenCalledOnce();

    const appliedProxy = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/codex/proxy",
      headers,
      payload: { proxy: "proxy.example:8000:user:secret" },
    });
    expect(appliedProxy.statusCode).toBe(200);
    expect(codexManager.applyProxy).toHaveBeenCalledWith("proxy.example:8000:user:secret");
    expect(JSON.stringify(appliedProxy.json())).not.toContain("secret");

    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/permissions",
      headers,
      payload: { preset: "full-access", expectedVersion: "version-1" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ preset: "full-access", version: "version-2" });
    expect(
      bridge.request.mock.calls.filter(([method]) => method === "config/batchWrite").at(-1)?.[1],
    ).toEqual({
      edits: [
        { keyPath: "sandbox_mode", value: "danger-full-access", mergeStrategy: "replace" },
        { keyPath: "approval_policy", value: "never", mergeStrategy: "replace" },
        { keyPath: "approvals_reviewer", value: "user", mergeStrategy: "replace" },
      ],
      expectedVersion: "version-1",
      reloadUserConfig: true,
    });

    bridge.permissionConfig = {
      sandbox_mode: "read-only",
      approval_policy: "never",
      approvals_reviewer: "user",
    };
    expect(
      (await app.inject({ url: "/api/v1/settings/permissions", headers })).json().preset,
    ).toBeNull();

    bridge.writeStatus = "okOverridden";
    bridge.writeMessage = "Managed by policy";
    const overridden = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/permissions",
      headers,
      payload: { preset: "ask", expectedVersion: "version-2" },
    });
    expect(overridden.json()).toMatchObject({
      preset: "ask",
      overridden: true,
      message: "Managed by policy",
    });

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/permissions",
      headers,
      payload: { preset: "unsafe" },
    });
    expect(invalid.statusCode).toBe(400);

    bridge.conflictingVersion = "stale";
    const conflict = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/permissions",
      headers,
      payload: { preset: "auto", expectedVersion: "stale" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "conflict" } });

    await app.close();
  });
});

describe("empty-session Team activation", () => {
  async function createEmptySessionHarness() {
    const harness = await createForkHarness(0);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      headers: harness.headers,
      payload: { clientCreationId: "empty-team" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().thread.id as string;
    const settings = { collaborationMode: "plan" as const, model: "gpt-a" };
    await harness.projection.setSettings(id, settings);
    const draft = await harness.projection.setDraft(id, {
      input: "Сохранить черновик",
      images: [{ id: "image", name: "photo.png", url: "data:image/png;base64,AA==" }],
      annotations: [],
      goalMode: false,
    });
    return { ...harness, id, settings, draft };
  }

  it.each(
    [true, false].flatMap((unmaterialized) =>
      [
        "no rollout found for thread id created",
        "invalid paginated history lineage for created: missing source rollout",
      ].map((message) => ({ unmaterialized, message })),
    ),
  )(
    "recovers the same empty session after $message (unmaterialized=$unmaterialized)",
    async ({ unmaterialized, message }) => {
      const { app, bridge, headers, store, projection, id } = await createEmptySessionHarness();
      try {
        const upload = await app.inject({
          method: "POST",
          url: `/api/v1/threads/${id}/attachments?name=notes.txt&mediaType=text%2Fplain`,
          headers: { ...headers, "content-type": "application/octet-stream" },
          payload: Buffer.from("Keep this attachment"),
        });
        expect(upload.statusCode).toBe(201);
        const file = upload.json();
        const draft = await projection.setDraft(id, {
          ...store.view().threadMeta[id]!.draft!,
          files: [file],
        });
        projection.upsertThread({
          ...testThread(id),
          name: "Моя сессия",
          gitInfo: { sha: "existing-sha", branch: "main", originUrl: null },
        });
        if (unmaterialized) await projection.markUnmaterialized(id);
        const original = bridge.request.getMockImplementation()!;
        bridge.request.mockClear();
        let persisted = false;
        bridge.request.mockImplementation(async (method, params = {}) => {
          if (method === "thread/resume" && params.threadId === id && !persisted) {
            throw new RpcError(-32600, message);
          }
          const response = await original(method, params);
          if (method === "thread/read" && params.threadId === id && params.includeTurns === true) {
            persisted = true;
          }
          return response;
        });
        const enabled = await app.inject({
          method: "PATCH",
          url: `/api/v1/threads/${id}/settings`,
          headers,
          payload: { collaborationMode: "team" },
        });
        expect(enabled.statusCode, enabled.body).toBe(200);
        expect(enabled.json()).toMatchObject({
          id,
          title: "Моя сессия",
          settings: { collaborationMode: "team", model: "gpt-a" },
        });
        expect(store.view().threadMeta[id]?.draft).toEqual(draft);
        expect(projection.isUnmaterialized(id)).toBe(false);
        await expect(readFile(file.path, "utf8")).resolves.toBe("Keep this attachment");
        expect(
          bridge.request.mock.calls.filter(
            ([method]) => method === "thread/read" || method === "thread/resume",
          ),
        ).toEqual([
          [
            "thread/resume",
            expect.objectContaining({ config: { agents: { enabled: false } } }),
            30_000,
          ],
          ["thread/read", { threadId: id, includeTurns: true }, 30_000],
          [
            "thread/resume",
            expect.objectContaining({ config: { agents: { enabled: false } } }),
            30_000,
          ],
        ]);
        expect(bridge.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
        expect(bridge.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
        expect(bridge.request.mock.calls.some(([method]) => method === "thread/name/set")).toBe(
          false,
        );
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "thread/metadata/update"),
        ).toEqual([
          ["thread/metadata/update", { threadId: id, gitInfo: { sha: "existing-sha" } }, 30_000],
        ]);

        const send = {
          method: "POST" as const,
          url: `/api/v1/threads/${id}/turns`,
          headers,
          payload: { input: "Первое сообщение", clientMessageId: "first-team-message" },
        };
        expect((await app.inject(send)).statusCode).toBe(201);
        expect((await app.inject(send)).statusCode).toBe(201);
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "turn/start"),
        ).toHaveLength(1);
        expect(store.view().threadMeta[id]?.draft).toBeUndefined();
      } finally {
        await app.close();
      }
    },
  );

  it.each(["history", "fork", "result", "delivered input", "uncertain input", "unknown origin"])(
    "does not materialize a session with %s after missing history",
    async (condition) => {
      const { app, bridge, headers, store, projection, id, settings, draft } =
        await createEmptySessionHarness();
      try {
        if (condition === "history") {
          projection.upsertThread({ ...testThread(id), turns: [testTurn("old", "completed")] });
        } else if (condition === "fork") {
          projection.upsertThread({ ...testThread(id), forkedFromId: "source" });
        } else {
          await store.update((state) => {
            if (condition === "result") {
              state.threadMeta[id]!.lastResult = { turnId: "old", completedAt: 1 };
            } else if (condition === "unknown origin") {
              state.threadCreations = {};
            } else {
              state.messageReceipts ??= {};
              state.messageReceipts.previous = {
                threadId: id,
                turnId: condition === "delivered input" ? "old" : null,
                contentHash: messageContentHash("Previous input", [], [], false),
                createdAt: 1,
                status: condition === "delivered input" ? "delivered" : "prepared",
              };
            }
          });
        }
        const original = bridge.request.getMockImplementation()!;
        bridge.request.mockClear();
        bridge.request.mockImplementation(async (method, params = {}) => {
          if (method === "thread/resume" && params.threadId === id) {
            throw new RpcError(
              -32600,
              `invalid paginated history lineage for ${id}: missing source rollout`,
            );
          }
          return original(method, params);
        });
        const failed = await app.inject({
          method: "PATCH",
          url: `/api/v1/threads/${id}/settings`,
          headers,
          payload: { collaborationMode: "team" },
        });
        expect(failed.statusCode).toBe(500);
        expect(projection.summary(id)?.settings).toEqual(settings);
        expect(store.view().threadMeta[id]?.draft).toEqual(draft);
        expect(bridge.request.mock.calls.some(([method]) => method === "thread/read")).toBe(false);
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "thread/resume"),
        ).toHaveLength(1);
      } finally {
        await app.close();
      }
    },
  );

  it.each(["materialization", "second resume"])(
    "preserves the mode and draft after failed %s without retrying again",
    async (stage) => {
      const { app, bridge, headers, store, projection, id, settings, draft } =
        await createEmptySessionHarness();
      try {
        await projection.markUnmaterialized(id);
        const original = bridge.request.getMockImplementation()!;
        bridge.request.mockClear();
        bridge.request.mockImplementation(async (method, params = {}) => {
          if (params.threadId === id) {
            if (method === "thread/resume") {
              throw new RpcError(
                -32600,
                `invalid paginated history lineage for ${id}: missing source rollout`,
              );
            }
            if (method === "thread/read" && stage === "materialization") {
              throw new Error("History persistence failed");
            }
          }
          return original(method, params);
        });
        const failed = await app.inject({
          method: "PATCH",
          url: `/api/v1/threads/${id}/settings`,
          headers,
          payload: { collaborationMode: "team" },
        });
        expect(failed.statusCode).toBe(500);
        expect(projection.summary(id)?.settings).toEqual(settings);
        expect(store.view().threadMeta[id]?.draft).toEqual(draft);
        expect(projection.isUnmaterialized(id)).toBe(stage === "materialization");
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "thread/read"),
        ).toHaveLength(1);
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "thread/resume"),
        ).toHaveLength(stage === "materialization" ? 1 : 2);
      } finally {
        await app.close();
      }
    },
  );

  it.each([
    "invalid paginated history lineage for created: cycle detected",
    "invalid paginated history lineage for another-thread: missing source rollout",
  ])("does not materialize an empty session after unrelated failure: %s", async (message) => {
    const { app, bridge, headers, projection, id, settings } = await createEmptySessionHarness();
    try {
      const original = bridge.request.getMockImplementation()!;
      bridge.request.mockClear();
      bridge.request.mockImplementation(async (method, params = {}) => {
        if (method === "thread/resume") throw new RpcError(-32600, message);
        return original(method, params);
      });
      const failed = await app.inject({
        method: "PATCH",
        url: `/api/v1/threads/${id}/settings`,
        headers,
        payload: { collaborationMode: "team" },
      });
      expect(failed.statusCode).toBe(500);
      expect(projection.summary(id)?.settings).toEqual(settings);
      expect(bridge.request.mock.calls.some(([method]) => method === "thread/read")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("retries failed empty-session persistence with the same creation ID and keeps its draft", async () => {
    const { app, bridge, headers, store, projection } = await createForkHarness(0);
    try {
      const original = bridge.request.getMockImplementation()!;
      let failRead = true;
      bridge.request.mockImplementation(async (method, params = {}) => {
        if (method === "thread/read" && params.threadId === "created" && failRead) {
          failRead = false;
          throw new Error("Empty history persistence failed");
        }
        return original(method, params);
      });
      const request = {
        method: "POST" as const,
        url: "/api/v1/projects/project/threads",
        headers,
        payload: { clientCreationId: "retry-empty-team" },
      };
      expect((await app.inject(request)).statusCode).toBe(500);
      expect(projection.isUnmaterialized("created")).toBe(true);
      const draft = await projection.setDraft("created", {
        input: "Черновик после сбоя",
        images: [],
        annotations: [],
        goalMode: false,
      });
      const retried = await app.inject(request);
      expect(retried.statusCode, retried.body).toBe(201);
      expect(retried.json()).toMatchObject({ thread: { id: "created" }, draft });
      expect(projection.isUnmaterialized("created")).toBe(false);
      expect(store.view().threadMeta.created?.draft).toEqual(draft);
      expect(
        bridge.request.mock.calls.filter(([method]) => method === "thread/start"),
      ).toHaveLength(1);
      expect(bridge.request.mock.calls.filter(([method]) => method === "thread/read")).toHaveLength(
        2,
      );
      expect(bridge.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
      expect(
        bridge.request.mock.calls.filter(([method]) => method === "thread/metadata/update"),
      ).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});

describe("browser thread lifecycle", () => {
  it("requires explicit opt-in, rejects busy changes, rolls back attach, and fully disables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-browser-api-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
      state.projects.push({
        id: "project",
        displayName: "Project",
        path: "/work",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    await projection.setSettings("thread", {
      collaborationMode: "team",
      model: "gpt-a",
      reasoningEffort: "high",
    });
    await store.update((state) => {
      state.threadMeta.thread!.managedTeamToolsAvailable = true;
    });
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      {
        bridge: bridge as unknown as CodexBridge,
        store,
        projection,
        attention,
      },
    );
    await app.ready();
    projection.upsertThread({ ...testThread("native-child"), parentThreadId: "thread" });
    projection.upsertThread(testThread("archived-browser"), true);
    projection.upsertThread({ ...testThread("outside-project"), cwd: "/outside" });
    projection.upsertThread(testThread("managed-child"));
    await store.update((state) => {
      state.threadMeta["managed-child"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedParent: { parentThreadId: "thread", taskId: "task" },
      };
    });
    for (const threadId of [
      "native-child",
      "archived-browser",
      "outside-project",
      "managed-child",
    ]) {
      const rejected = await app.inject({
        method: "PATCH",
        url: `/api/v1/threads/${threadId}`,
        headers: { authorization: "Bearer correct" },
        payload: { browserEnabled: true },
      });
      expect(rejected.statusCode).toBe(409);
      expect(store.view().threadMeta[threadId]?.browserEnabled).toBeUndefined();
    }
    await store.update((state) => {
      state.threadMeta.thread!.browserBinding = {
        bindingId: "legacy-binding",
        instanceId: "extension-instance-1",
        attachedAt: 1,
      };
    });
    expect(projection.summary("thread")?.browserStatus).toBe("disabled");
    const socket = await app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: "http://localhost" },
    });
    const frames = websocketFrames(socket);
    socket.send(
      JSON.stringify({
        type: "client.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: BROWSER_EXTENSION_PROTOCOL_VERSION,
        token: "correct",
        instanceId: "extension-instance-1",
        extensionVersion: "0.1.6",
        browser: { name: "chrome", version: "128" },
        capabilities: {
          tools: BROWSER_TOOL_NAMES,
          maxProjectFileBytes: 100 * 1024 * 1024,
          screenshots: ["image/jpeg", "image/png"],
        },
        bindings: [],
      }),
    );
    await frames.nextType("server.hello");

    const invalidCombinedPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread",
      headers: { authorization: "Bearer correct" },
      payload: { browserEnabled: true, pinned: "yes" },
    });
    expect(invalidCombinedPatch.statusCode).toBe(400);
    expect(store.view().threadMeta.thread?.browserEnabled).toBeUndefined();

    await projection.setCurrentTurn("thread", "busy-turn");
    const busyEnable = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread",
      headers: { authorization: "Bearer correct" },
      payload: { browserEnabled: true },
    });
    expect(busyEnable.statusCode).toBe(409);
    expect(store.view().threadMeta.thread?.browserEnabled).toBeUndefined();
    await projection.markInterrupted("thread", ["busy-turn"]);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread",
      headers: { authorization: "Bearer correct" },
      payload: { browserEnabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ browserStatus: "disconnected" });
    expect(store.view().threadMeta.thread?.browserEnabled).toBe(true);
    expect(store.view().threadMeta.thread?.browserBinding).toBeUndefined();
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).not.toHaveProperty("config.mcp_servers");

    await projection.setCurrentTurn("thread", "busy-attach");
    socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-busy",
        target: { kind: "existing", threadId: "thread" },
        tab: browserTabSummary(),
      }),
    );
    expect(await frames.nextType("session.error")).toMatchObject({
      requestId: "attach-busy",
      error: { code: "thread_busy" },
    });
    await projection.markInterrupted("thread", ["busy-attach"]);

    bridge.failBrowserResumeOnce = true;
    socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-failed",
        target: { kind: "existing", threadId: "thread" },
        tab: browserTabSummary(),
      }),
    );
    expect(await frames.nextType("session.error")).toMatchObject({
      requestId: "attach-failed",
      error: expect.any(Object),
    });
    expect(store.view().threadMeta.thread?.browserBinding).toBeUndefined();
    const rollbackCalls = bridge.request.mock.calls
      .filter(([method]) => method === "thread/resume")
      .slice(-2);
    expect(rollbackCalls[0]?.[1]).toMatchObject({
      config: {
        agents: { enabled: false },
        mcp_servers: { codexnest_browser: expect.any(Object) },
      },
    });
    expect(rollbackCalls[1]?.[1]).toMatchObject({ config: { agents: { enabled: false } } });
    expect(rollbackCalls[1]?.[1]).not.toHaveProperty("config.mcp_servers");

    socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-success",
        target: { kind: "existing", threadId: "thread" },
        tab: browserTabSummary(),
      }),
    );
    expect(await frames.nextType("session.result")).toMatchObject({
      requestId: "attach-success",
      action: "attached",
    });
    const binding = store.view().threadMeta.thread?.browserBinding;
    expect(binding).toMatchObject({ instanceId: "extension-instance-1" });
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).toMatchObject({
      config: {
        agents: { enabled: false },
        mcp_servers: { codexnest_browser: expect.any(Object) },
      },
    });

    const turn = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers: { authorization: "Bearer correct" },
      payload: { clientMessageId: "direct-test-178034", input: "Use the attached browser" },
    });
    expect(turn.statusCode).toBe(201);
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).toMatchObject({
      config: {
        agents: { enabled: false },
        mcp_servers: { codexnest_browser: expect.any(Object) },
      },
    });
    const detached = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread",
      headers: { authorization: "Bearer correct" },
      payload: { browserEnabled: false },
    });
    expect(detached.statusCode).toBe(409);
    expect(store.view().threadMeta.thread?.browserEnabled).toBe(true);

    const interrupted = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/interrupt",
      headers: { authorization: "Bearer correct" },
      payload: { turnId: turn.json().turnId },
    });
    expect(interrupted.statusCode).toBe(204);

    const disabled = await app.inject({
      method: "DELETE",
      url: "/api/v1/threads/thread/browser-binding",
      headers: { authorization: "Bearer correct" },
    });
    expect(disabled.statusCode).toBe(204);
    expect(await frames.nextType("binding.detach")).toMatchObject({ threadId: "thread" });
    expect(store.view().threadMeta.thread?.browserBinding).toBeUndefined();
    expect(store.view().threadMeta.thread?.browserEnabled).toBeUndefined();
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).toMatchObject({
      config: { agents: { enabled: false } },
    });
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).not.toHaveProperty("config.mcp_servers");

    socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "create-fresh",
        target: { kind: "new", projectId: "project" },
        tab: browserTabSummary(),
      }),
    );
    expect(await frames.nextType("session.error")).toMatchObject({
      requestId: "create-fresh",
      error: { code: "unsupported" },
    });

    socket.terminate();
    await app.close();
  });

  it("moves an explicitly detached binding to another extension and keeps it on resume failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-browser-transfer-test-"));
    directories.push(directory);
    const store = new StateStore(join(directory, "state.json"));
    await store.load();
    await store.update((state) => {
      state.auth.tokenSha256 = hashToken("correct");
      state.projects.push({
        id: "project",
        displayName: "Project",
        path: "/work",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
    });
    const bridge = new SettingsBridge();
    const attention = new AttentionManager();
    const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
    await projection.sync();
    const app = await buildApp(
      loadConfig({
        statePath: store.path,
        clientDist: join(directory, "missing"),
        allowedOrigins: new Set(["http://localhost"]),
      }),
      { bridge: bridge as unknown as CodexBridge, store, projection, attention },
    );
    await app.ready();

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread",
      headers: { authorization: "Bearer correct" },
      payload: { browserEnabled: true },
    });
    expect(enabled.statusCode).toBe(200);

    const connect = async (instanceId: string) => {
      const socket = await app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
        headers: { origin: "http://localhost" },
      });
      const frames = websocketFrames(socket);
      socket.send(
        JSON.stringify({
          type: "client.hello",
          protocol: BROWSER_EXTENSION_PROTOCOL,
          version: BROWSER_EXTENSION_PROTOCOL_VERSION,
          token: "correct",
          instanceId,
          extensionVersion: "0.1.9",
          browser: { name: "chrome", version: "128" },
          capabilities: {
            tools: BROWSER_TOOL_NAMES,
            maxProjectFileBytes: 100 * 1024 * 1024,
            screenshots: ["image/jpeg", "image/png"],
          },
          bindings: [],
        }),
      );
      return { socket, frames, hello: await frames.nextType("server.hello") };
    };
    const first = await connect("extension-instance-1");
    expect(first.hello.threads).toEqual([expect.objectContaining({ id: "thread" })]);
    first.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-first",
        target: { kind: "existing", threadId: "thread" },
        tab: browserTabSummary(),
      }),
    );
    expect(await first.frames.nextType("session.result")).toMatchObject({
      requestId: "attach-first",
    });
    const original = structuredClone(store.view().threadMeta.thread?.browserBinding);
    expect(original).toMatchObject({ instanceId: "extension-instance-1" });
    const binding = {
      threadId: "thread",
      projectId: "project",
      title: "thread",
      groupId: 1,
      tabIds: [1],
      createdAt: 1,
      updatedAt: 1,
    };
    first.socket.send(JSON.stringify({ type: "binding.updated", binding }));
    await vi.waitFor(() => expect(projection.summary("thread")?.browserStatus).toBe("connected"));
    const second = await connect("extension-instance-2");
    expect(second.hello.threads).toEqual([]);
    first.socket.send(JSON.stringify({ type: "binding.detached", binding }));
    await vi.waitFor(() =>
      expect(store.view().threadMeta.thread?.browserBinding?.detachedAt).toEqual(
        expect.any(Number),
      ),
    );
    expect((await second.frames.nextType("catalog.updated")).threads).toEqual([
      expect.objectContaining({ id: "thread" }),
    ]);
    const detached = structuredClone(store.view().threadMeta.thread?.browserBinding);

    bridge.failBrowserResumeOnce = true;
    second.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "transfer-failed",
        target: { kind: "existing", threadId: "thread" },
        tab: browserTabSummary(),
      }),
    );
    expect(await second.frames.nextType("session.error")).toMatchObject({
      requestId: "transfer-failed",
    });
    expect(store.view().threadMeta.thread?.browserBinding).toEqual(detached);

    second.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "transfer-success",
        target: { kind: "existing", threadId: "thread" },
        tab: browserTabSummary(),
      }),
    );
    expect(await second.frames.nextType("session.result")).toMatchObject({
      requestId: "transfer-success",
    });
    const transferred = store.view().threadMeta.thread?.browserBinding;
    expect(transferred?.instanceId).toBe("extension-instance-2");
    expect(transferred?.bindingId).not.toBe(original?.bindingId);
    expect(transferred?.detachedAt).toBeUndefined();
    expect(await first.frames.nextType("binding.detach")).toMatchObject({ threadId: "thread" });
    expect(
      bridge.request.mock.calls.findLast(([method]) => method === "thread/resume")?.[1],
    ).toMatchObject({
      config: {
        mcp_servers: {
          codexnest_browser: {
            url: expect.stringContaining(transferred!.bindingId),
          },
        },
      },
    });

    first.socket.close();
    second.socket.close();
    await app.close();
  });
});

describe("explicit session artifacts", () => {
  it("does not reuse an old empty root that lacks the artifact tool", async () => {
    const { app, bridge, headers } = await createTeamHarness();
    const startsBefore = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/start",
    ).length;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      payload: { clientCreationId: "test-creation" },
      headers,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().thread.id).toBe("created");
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      startsBefore + 1,
    );
    await app.close();
  });

  it("attaches only to new roots and validates, persists, deduplicates, and lists files", async () => {
    const repository = await createApiTestRepository();
    await mkdir(join(repository, "deliverables"));
    await writeFile(join(repository, "deliverables", "report.txt"), "report\n");
    await writeFile(join(repository, "deliverables", "notes.txt"), "notes\n");
    const outside = await mkdtemp(join(tmpdir(), "codexnest-artifact-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(repository, "deliverables", "escape.txt"));

    const { app, bridge, headers, store } = await createTeamHarness({ projectPath: repository });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/threads",
      payload: { clientCreationId: "test-creation" },
      headers,
    });
    expect(created.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/threads/created/settings",
          headers,
          payload: { collaborationMode: "team", model: "gpt-a", reasoningEffort: "high" },
        })
      ).statusCode,
    ).toBe(200);
    expect(store.snapshot().threadMeta.created).toMatchObject({
      managedTeamToolsAvailable: true,
      sessionArtifactsVersion: 1,
    });
    const rootStart = bridge.request.mock.calls
      .filter(
        ([method, params]) =>
          method === "thread/start" &&
          !String(params.threadSource).startsWith("codexnest-managed:"),
      )
      .at(-1)?.[1] as Record<string, unknown>;
    expect(rootStart.developerInstructions).toMatch(/standalone final deliverables/i);
    expect(
      (rootStart.dynamicTools as Array<{ tools: Array<{ name: string }> }>)[0]?.tools.map(
        (tool) => tool.name,
      ),
    ).toContain("publish_artifact");

    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const first = dynamicToolJson(
      await callTeamTool(
        bridge,
        "created",
        "publish_artifact",
        { path: "deliverables/report.txt" },
        "publish-first",
        "turn-first",
      ),
    ).artifact as Record<string, unknown>;
    expect(first).toMatchObject({
      label: "report.txt",
      path: "deliverables/report.txt",
      turnId: "turn-first",
      createdAt: 100,
    });
    clock.mockReturnValue(200);
    await callTeamTool(bridge, "created", "publish_artifact", {
      path: join(repository, "deliverables", "notes.txt"),
      label: "Release notes",
    });
    clock.mockReturnValue(300);
    const republished = dynamicToolJson(
      await callTeamTool(
        bridge,
        "created",
        "publish_artifact",
        {
          path: "deliverables/report.txt",
          label: "Final report",
        },
        "publish-again",
        "turn-republish",
      ),
    ).artifact as Record<string, unknown>;
    clock.mockRestore();
    expect(republished).toMatchObject({
      id: first.id,
      label: "Final report",
      turnId: "turn-republish",
      createdAt: 300,
    });
    expect(store.snapshot().threadMeta.created?.sessionArtifacts).toEqual([
      expect.objectContaining({ id: first.id, path: "deliverables/report.txt" }),
      expect.objectContaining({ path: "deliverables/notes.txt" }),
    ]);

    for (const path of [
      "../secret.txt",
      "deliverables/missing.txt",
      "deliverables",
      "deliverables/escape.txt",
    ]) {
      const rejected = await callTeamTool(bridge, "created", "publish_artifact", { path });
      expect(rejected.success, path).toBe(false);
    }

    const listed = await app.inject({ url: "/api/v1/threads/created/artifacts", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      capability: "explicit",
      artifacts: [
        expect.objectContaining({
          id: first.id,
          label: "Final report",
          path: await realpath(join(repository, "deliverables", "report.txt")),
        }),
        expect.objectContaining({
          label: "Release notes",
          path: await realpath(join(repository, "deliverables", "notes.txt")),
        }),
      ],
    });

    expect(
      (
        await callTeamTool(bridge, "thread", "publish_artifact", {
          path: "src/index.ts",
        })
      ).success,
    ).toBe(false);
    expect((await app.inject({ url: "/api/v1/threads/thread/artifacts", headers })).json()).toEqual(
      {
        capability: "unavailable",
        artifacts: [],
      },
    );

    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "created", "spawn_task", {
        title: "Prepare supporting result",
        prompt: "Return a result without publishing it to the session.",
      }),
    );
    const childId = String(spawned.threadId);
    expect(
      (
        await callTeamTool(bridge, childId, "publish_artifact", {
          path: "deliverables/report.txt",
        })
      ).success,
    ).toBe(false);
    const childStart = bridge.request.mock.calls
      .filter(
        ([method, params]) =>
          method === "thread/start" && String(params.threadSource).startsWith("codexnest-managed:"),
      )
      .at(-1)?.[1] as { dynamicTools: Array<{ tools: Array<{ name: string }> }> };
    expect(childStart.dynamicTools[0]?.tools.map((tool) => tool.name)).toEqual(["submit_result"]);
    await callTeamTool(bridge, childId, "submit_result", {
      outcome: "success",
      summary: "Supporting result",
      artifacts: [{ label: "Team report", path: "deliverables/report.txt" }],
    });
    expect(store.snapshot().threadMeta.created?.sessionArtifacts).toHaveLength(2);

    await app.close();
  });
});

describe("Team orchestration", () => {
  it("reattaches an ambiguously created child by its durable source marker", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const callId = "ambiguous-spawn-call";
    const operationKey = createHash("sha256")
      .update(`thread\0turn-thread\0${callId}\0spawn_task`)
      .digest("hex");
    const childThreadSource = `codexnest-managed:${operationKey.slice(0, 32)}`;
    bridge.managedThreads.push({
      ...testThread("recovered-managed"),
      threadSource: childThreadSource,
    });
    await store.update((state) => {
      state.teamToolOperations = {
        [operationKey]: {
          threadId: "thread",
          turnId: "turn-thread",
          callId,
          tool: "spawn_task",
          argumentsHash: createHash("sha256")
            .update('{"prompt":"Восстанови созданный child.","title":"Восстановить создание"}')
            .digest("hex"),
          status: "prepared",
          createdAt: 1,
          updatedAt: 1,
          taskId: "recovered-task",
          childThreadSource,
        },
      };
    });
    const response = dynamicToolJson(
      await callTeamTool(
        bridge,
        "thread",
        "spawn_task",
        {
          title: "Восстановить создание",
          prompt: "Восстанови созданный child.",
        },
        callId,
      ),
    );
    expect(response).toMatchObject({
      taskId: "recovered-task",
      threadId: "recovered-managed",
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      0,
    );
    await app.close();
  });

  it("replays mutating tool calls without duplicating child threads or steering messages", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const requestId = "stable-spawn-call";
    const args = {
      title: "Идемпотентная задача",
      prompt: "Проверь идемпотентность.",
    };
    const first = await callTeamTool(bridge, "thread", "spawn_task", args, requestId);
    const managedStartsAfterFirst = bridge.request.mock.calls.filter(
      ([method, params]) =>
        method === "thread/start" &&
        String((params as Record<string, unknown>).threadSource).startsWith("codexnest-managed:"),
    ).length;
    const replay = await callTeamTool(bridge, "thread", "spawn_task", args, requestId);
    expect(replay).toEqual(first);
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "thread/start" &&
          String((params as Record<string, unknown>).threadSource).startsWith("codexnest-managed:"),
      ),
    ).toHaveLength(managedStartsAfterFirst);
    const conflict = await callTeamTool(
      bridge,
      "thread",
      "spawn_task",
      { ...args, prompt: "Другие аргументы." },
      requestId,
    );
    expect(conflict.success).toBe(false);

    const spawned = dynamicToolJson(first);
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    const steerArgs = { taskId: spawned.taskId, message: "Продолжай один раз." };
    const steer = await callTeamTool(
      bridge,
      "thread",
      "steer_task",
      steerArgs,
      "stable-steer-call",
    );
    const steerCount = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/steer",
    ).length;
    const steerOperationKey = createHash("sha256")
      .update("thread\0turn-thread\0stable-steer-call\0steer_task")
      .digest("hex");
    await store.update((state) => {
      const operation = state.teamToolOperations?.[steerOperationKey];
      if (!operation) return;
      operation.status = "prepared";
      delete operation.response;
    });
    const steerReplay = await callTeamTool(
      bridge,
      "thread",
      "steer_task",
      steerArgs,
      "stable-steer-call",
    );
    expect(steerReplay).toEqual(steer);
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(
      steerCount,
    );

    await app.close();
  });

  it("uses the durable receipt when the tool response transport is lost", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const requestId = "lost-response-spawn";
    bridge.emit(
      "request",
      {
        method: "item/tool/call",
        id: requestId,
        params: {
          threadId: "thread",
          turnId: "turn-thread",
          callId: requestId,
          namespace: "codexnest",
          tool: "spawn_task",
          arguments: {
            title: "Ответ потерян",
            prompt: "Не создавай дубль после replay.",
          },
        },
      },
      {
        respond() {
          throw new Error("transport disconnected");
        },
        respondError() {
          throw new Error("transport disconnected");
        },
      },
    );
    await vi.waitFor(() =>
      expect(Object.values(store.snapshot().teamToolOperations ?? {})[0]?.status).toBe("applied"),
    );
    expect(
      Object.values(store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {}),
    ).toEqual([expect.objectContaining({ status: "queued" })]);

    const replay = await callTeamTool(
      bridge,
      "thread",
      "spawn_task",
      {
        title: "Ответ потерян",
        prompt: "Не создавай дубль после replay.",
      },
      requestId,
    );
    expect(replay.success).toBe(true);
    await vi.waitFor(() =>
      expect(
        Object.values(store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {})[0]
          ?.status,
      ).toBe("running"),
    );
    expect(bridge.managedThreads).toHaveLength(1);
    await app.close();
  });

  it("deduplicates replayed tool requests while reconnect recovery is pending", async () => {
    const { app, bridge, lifecycle, projection, store } = await createTeamHarness({
      lifecycle: true,
    });
    const requestId = "reconnect-spawn";
    const request = {
      method: "item/tool/call",
      id: requestId,
      params: {
        threadId: "thread",
        turnId: "turn-thread",
        callId: requestId,
        namespace: "codexnest",
        tool: "spawn_task",
        arguments: {
          title: "Replay после reconnect",
          prompt: "Создай ровно одну задачу.",
        },
      },
    };
    const staleRespond = vi.fn();
    let resolveResponse!: (response: TestDynamicToolResponse) => void;
    const response = new Promise<TestDynamicToolResponse>((resolve) => {
      resolveResponse = resolve;
    });
    bridge.emit("request", request, {
      respond: staleRespond,
      respondError: vi.fn(),
    });
    bridge.emit("request", request, {
      respond: (_id: string, result: TestDynamicToolResponse) => resolveResponse(result),
      respondError: (_id: string, _code: number, message: string) =>
        resolveResponse({
          success: false,
          contentItems: [{ type: "inputText", text: message }],
        }),
    });
    expect(bridge.managedThreads).toHaveLength(0);

    projection.emit("event", 3, { type: "resync.required" });
    expect((await response).success).toBe(true);
    await vi.waitFor(() =>
      expect(
        Object.values(store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {})[0]
          ?.status,
      ).toBe("running"),
    );
    expect(staleRespond).not.toHaveBeenCalled();
    expect(bridge.managedThreads).toHaveLength(1);
    expect(lifecycle?.state).toBe("ready");
    await app.close();
    await lifecycle?.close();
  });

  it("recovers starting tasks and delivered parent claims from persisted delivery receipts", async () => {
    const { app, bridge, projection, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Восстановить задачу",
        prompt: "Проверь восстановление.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (!task) return;
      task.status = "starting";
      delete task.childTurnId;
    });
    projection.emit("event", 0, { type: "resync.required" });
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)],
      ).toMatchObject({ status: "running", childTurnId: `turn-${String(spawned.threadId)}` }),
    );

    const claimId = "recovered-claim";
    const markerId = `codexnest-team-continuation:${claimId}`;
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = "child-terminal";
      task.result = { summary: "Готово", source: "submitted" };
      task.delivery = {
        status: "claimed",
        claimId,
        markerId,
        dispatchStartedAt: Date.now(),
      };
    });
    await store.update((state) => {
      state.messageReceipts ??= {};
      state.messageReceipts[markerId] = {
        threadId: "thread",
        turnId: "recovered-parent-turn",
        contentHash: createHash("sha256").update("saved-claim").digest("hex"),
        createdAt: Date.now(),
        status: "delivered",
        deliveryVersion: 1,
      };
    });
    bridge.threadTurns.set("thread", [
      {
        ...testTurn("recovered-parent-turn", "completed"),
        itemsView: "full",
        items: [
          {
            type: "userMessage",
            id: "claim-marker",
            clientId: markerId,
            content: [{ type: "text", text: TEAM_MARKER_TEXT, text_elements: [] }],
          },
        ],
      },
    ]);
    const parentStarts = bridge.request.mock.calls.filter(
      ([method, params]) =>
        method === "turn/start" && (params as Record<string, unknown>).threadId === "thread",
    ).length;
    projection.emit("event", 1, { type: "resync.required" });
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.delivery,
      ).toMatchObject({ status: "delivered", parentTurnId: "recovered-parent-turn" }),
    );
    expect(
      store.snapshot().threadMeta.thread?.timelineArtifacts?.["recovered-parent-turn"]?.[0],
    ).toMatchObject({ afterItemId: null });
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "turn/start" && (params as Record<string, unknown>).threadId === "thread",
      ),
    ).toHaveLength(parentStarts);
    await app.close();
  });

  it("serializes claim recovery with an in-flight parent continuation", async () => {
    const { app, bridge, projection, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Deliver once",
        prompt: "Return one result.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    await callTeamTool(bridge, String(spawned.threadId), "submit_result", {
      outcome: "success",
      summary: "One durable result",
    });

    let releaseParentStart!: () => void;
    bridge.parentTurnStartGate = new Promise<void>((resolve) => {
      releaseParentStart = resolve;
    });
    let markParentStartEntered!: () => void;
    const parentStartEntered = new Promise<void>((resolve) => {
      markParentStartEntered = resolve;
    });
    bridge.parentTurnStartEntered = markParentStartEntered;
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(spawned.threadId),
        turn: {
          ...testTurn(`turn-${String(spawned.threadId)}`, "completed"),
          itemsView: "full",
        },
      },
    } satisfies ServerNotification);

    await parentStartEntered;
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.delivery,
    ).toMatchObject({ status: "claimed" });
    projection.emit("event", 2, { type: "resync.required" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    bridge.parentTurnStartGate = null;
    releaseParentStart();
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.delivery,
      ).toMatchObject({ status: "delivered" }),
    );
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "turn/start" && (params as Record<string, unknown>).threadId === "thread",
      ),
    ).toHaveLength(1);
    await app.close();
  });

  it("keeps an ambiguous legacy parent claim parked without repeating work or spinning recovery", async () => {
    const { app, bridge, projection, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Не потерять результат",
        prompt: "Проверь восстановление claim.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    await projection.setCurrentTurn("thread", "active-parent-turn");
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = "child-terminal";
      task.result = { summary: "Готово", source: "submitted" };
      task.delivery = {
        status: "claimed",
        claimId: "ambiguous-claim",
        markerId: "codexnest-team-claim:ambiguous-claim",
        dispatchStartedAt: Date.now(),
      };
    });

    projection.emit("event", 2, { type: "resync.required" });
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.delivery,
      ).toMatchObject({ status: "claimed" }),
    );
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: testTurn("active-parent-turn", "completed"),
      },
    } satisfies ServerNotification);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "turn/start" && (params as Record<string, unknown>).threadId === "thread",
      ),
    ).toHaveLength(0);
    await app.close();
  });

  it("spawns managed threads and continues the parent after a submitted result becomes terminal", async () => {
    const { app, bridge, projection, store } = await createTeamHarness();
    const first = await callTeamTool(bridge, "thread", "spawn_task", {
      title: "Проверить интерфейс",
      prompt: "Проверь интерфейс и верни результат.",
    });
    const second = await callTeamTool(bridge, "thread", "spawn_task", {
      title: "Проверить сервер",
      prompt: "Проверь сервер и верни результат.",
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const firstResult = dynamicToolJson(first);
    const secondResult = dynamicToolJson(second);
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks;
      expect(tasks?.[String(firstResult.taskId)]?.status).toBe("running");
      expect(tasks?.[String(secondResult.taskId)]?.status).toBe("running");
    });
    expect(projection.summary(String(firstResult.threadId))?.relation).toMatchObject({
      kind: "subagent",
      parentThreadId: "thread",
    });

    const submitted = await callTeamTool(bridge, String(firstResult.threadId), "submit_result", {
      outcome: "success",
      summary: "Интерфейс проверен",
      details: "Ошибок не обнаружено.",
    });
    expect(submitted.success).toBe(true);
    const startsBefore = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;
    const firstChildTurnId =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(firstResult.taskId)]
        ?.childTurnId;

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(firstResult.threadId),
        turn: {
          ...testTurn(String(firstChildTurnId), "completed"),
          items: [
            {
              type: "agentMessage",
              id: "child-final",
              text: "Интерфейс проверен",
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
          itemsView: "full",
        },
      },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        startsBefore + 1,
      ),
    );
    const continuation = bridge.request.mock.calls
      .filter(([method]) => method === "turn/start")
      .at(-1)?.[1] as Record<string, unknown>;
    expect(continuation).toMatchObject({
      threadId: "thread",
      clientUserMessageId: expect.stringMatching(/^codexnest-team-claim:/),
      input: [{ type: "text", text: TEAM_MARKER_TEXT, text_elements: [] }],
      additionalContext: {
        "codexnest.team.results": {
          kind: "application",
          value: expect.stringMatching(
            /Проверить интерфейс.*Summary: Интерфейс проверен.*Проверить сервер/is,
          ),
        },
      },
    });
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(firstResult.taskId)]
          ?.delivery,
      ).toMatchObject({ status: "delivered" }),
    );
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(secondResult.taskId)],
    ).toMatchObject({ status: "running" });
    await vi.waitFor(() =>
      expect(store.snapshot().threadMeta.thread?.timelineArtifacts?.turn).toEqual([
        expect.objectContaining({
          type: "orchestrationNotice",
          agents: [
            expect.objectContaining({
              threadId: firstResult.threadId,
              title: "Проверить интерфейс",
              outcome: "completed",
            }),
          ],
        }),
      ]),
    );
    const deliveredChild = projection.summary(String(firstResult.threadId));
    expect(deliveredChild).toMatchObject({
      unread: false,
    });
    expect(store.snapshot().threadMeta[String(firstResult.threadId)]?.lastReadUpdatedAt).toBe(
      deliveredChild?.updatedAt,
    );
    expect(projection.summary("thread")?.currentTurnId).toBe("turn");

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(firstResult.threadId),
        turn: testTurn(String(firstChildTurnId), "completed"),
      },
    } satisfies ServerNotification);
    await nextImmediate();
    await nextImmediate();
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      startsBefore + 1,
    );

    await app.close();
    await store.flushed();
  });

  it("extracts a final answer and delivers a queued user message before the continuation", async () => {
    const { app, bridge, headers, projection, store } = await createTeamHarness();
    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread", turn: testTurn("parent-running", "inProgress") },
    } satisfies ServerNotification);
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Собрать данные",
        prompt: "Собери данные и верни результат.",
      }),
    );
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      expect(task?.status).toBe("running");
    });
    const childTurnId =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.childTurnId;
    const childUpdates: Array<Record<string, unknown>> = [];
    projection.on("event", (_sequence, event) => {
      if (event.type === "thread.upserted" && event.thread.id === spawned.threadId) {
        childUpdates.push(event.thread);
      }
    });
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(spawned.threadId),
        turn: {
          ...testTurn(String(childTurnId), "completed"),
          itemsView: "full",
          items: [
            {
              type: "agentMessage",
              id: "final",
              text: "Данные собраны\n\nПолный отчёт",
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const tracked =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      expect(tracked?.status).toBe("completed");
      expect(tracked?.result).toMatchObject({
        summary: "Данные собраны",
        details: "Данные собраны\n\nПолный отчёт",
        source: "final_answer",
      });
      expect(tracked?.delivery).toBeUndefined();
    });
    expect(childUpdates.at(-1)).toMatchObject({ state: "completed", currentTurnId: null });

    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "Сначала ответь на это", clientMessageId: "user-priority" },
    });
    expect(queued.statusCode).toBe(202);
    const startsBefore = bridge.request.mock.calls.filter(
      ([method]) => method === "turn/start",
    ).length;

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread", turn: testTurn("parent-running", "completed") },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        startsBefore + 1,
      ),
    );
    const continuation = bridge.request.mock.calls
      .filter(([method]) => method === "turn/start")
      .at(-1)?.[1] as Record<string, unknown>;
    expect(continuation).toMatchObject({
      clientUserMessageId: "user-priority",
      input: [{ type: "text", text: "Сначала ответь на это", text_elements: [] }],
      additionalContext: {
        "codexnest.team.results": {
          kind: "application",
          value: expect.stringContaining("If this turn also contains an explicit user message"),
        },
      },
    });
    await vi.waitFor(() => expect(store.snapshot().messageQueues?.thread).toBeUndefined());
    expect(projection.summary("thread")?.currentTurnId).toBe("turn");

    await nextImmediate();
    expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      startsBefore + 1,
    );
    await app.close();
    await store.flushed();
  });

  it("runs ten child tasks and starts the eleventh from the FIFO queue", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const spawned = [];
    for (let index = 1; index <= 11; index += 1) {
      spawned.push(
        dynamicToolJson(
          await callTeamTool(bridge, "thread", "spawn_task", {
            title: `Задача ${index}`,
            prompt: `Выполни задачу ${index}.`,
          }),
        ),
      );
    }
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(Object.values(tasks).filter((task) => task.status === "running")).toHaveLength(10);
      expect(tasks[String(spawned[10]!.taskId)]?.status).toBe("queued");
    });
    const firstTurnId =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned[0]!.taskId)]
        ?.childTurnId;

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(spawned[0]!.threadId),
        turn: {
          ...testTurn(String(firstTurnId), "completed"),
          itemsView: "full",
          items: [
            {
              type: "agentMessage",
              id: "first-final",
              text: "Первая задача готова",
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      },
    } satisfies ServerNotification);

    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(tasks[String(spawned[10]!.taskId)]?.status).toBe("running");
    });
    const childStarts = bridge.request.mock.calls.filter(
      ([method, params]) =>
        method === "turn/start" &&
        String((params as Record<string, unknown>).threadId) !== "thread",
    );
    expect(childStarts).toHaveLength(11);
    await app.close();
    await store.flushed();
  });

  it("arms the inactivity watchdog and lets the parent inspect, steer, and cancel", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Долгая задача",
        prompt: "Выполни долгую задачу.",
      }),
    );
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      expect(task?.status).toBe("running");
    });
    const now = Date.now();
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (task) task.lastActivityAt = now - 11 * 60_000;
    });
    await expect(triggerTeamWatchdogs(store, new Map(), now)).resolves.toEqual(new Set(["thread"]));
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.watchdog,
    ).toMatchObject({ status: "pending" });

    expect(
      (
        await callTeamTool(bridge, "thread", "inspect_task", {
          taskId: spawned.taskId,
        })
      ).success,
    ).toBe(true);
    expect(
      (
        await callTeamTool(bridge, "thread", "steer_task", {
          taskId: spawned.taskId,
          message: "Проверь, не заблокирован ли процесс.",
        })
      ).success,
    ).toBe(true);
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.watchdog,
    ).toBeUndefined();

    expect(
      (
        await callTeamTool(bridge, "thread", "cancel_task", {
          taskId: spawned.taskId,
          reason: "Больше не требуется",
        })
      ).success,
    ).toBe(true);
    expect(
      bridge.request.mock.calls.some(
        ([method, params]) =>
          method === "turn/interrupt" &&
          (params as Record<string, unknown>).threadId === spawned.threadId,
      ),
    ).toBe(true);

    await app.close();
    await store.flushed();
  });

  it("stops a completed Team orchestration without interrupting managed children", async () => {
    const { app, bridge, headers, projection, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Долгая задача",
        prompt: "Выполни долгую задачу.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = "child-terminal";
      task.result = { summary: "Готово", source: "submitted" };
    });
    expect(projection.summary("thread")).toMatchObject({
      state: "running",
      currentTurnId: null,
    });

    const stopped = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/interrupt",
      headers,
      payload: {},
    });

    expect(stopped.statusCode).toBe(204);
    expect(store.snapshot().threadMeta.thread?.teamOrchestration).toBeUndefined();
    expect(
      bridge.request.mock.calls.some(
        ([method, params]) =>
          method === "turn/interrupt" &&
          (params as Record<string, unknown>).threadId === spawned.threadId,
      ),
    ).toBe(false);
    expect(projection.summary("thread")).toMatchObject({
      state: "interrupted",
      currentTurnId: null,
    });
    await app.close();
    await store.flushed();
  });

  it("keeps Team enabled until the root agent cancels and processes running subagents", async () => {
    const { app, bridge, headers, projection, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Остановить по запросу",
        prompt: "Жди команды главного агента.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    await projection.setCurrentTurn("thread", "parent-running");

    const stopped = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/interrupt",
      headers,
      payload: { turnId: "parent-running" },
    });
    expect(stopped.statusCode).toBe(204);
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]?.status,
    ).toBe("running");
    expect(
      bridge.request.mock.calls.some(
        ([method, params]) =>
          method === "turn/interrupt" &&
          (params as Record<string, unknown>).threadId === spawned.threadId,
      ),
    ).toBe(false);

    const blocked = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { collaborationMode: "default" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: {
        code: "conflict",
        message:
          "Нельзя выключить Team, пока субагенты работают или их результаты ещё не обработаны. Попросите главного агента завершить или отменить их.",
      },
    });
    expect(projection.summary("thread")?.settings.collaborationMode).toBe("team");

    expect(
      (
        await callTeamTool(bridge, "thread", "cancel_task", {
          taskId: spawned.taskId,
          reason: "Пользователь попросил остановить субагентов",
        })
      ).success,
    ).toBe(true);
    const processed = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/turns",
      headers,
      payload: { clientMessageId: "direct-test-218106", input: "Останови субагентов" },
    });
    expect(processed.statusCode).toBe(201);
    expect(store.snapshot().threadMeta.thread?.teamOrchestration).toBeUndefined();

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: testTurn(String(processed.json().turnId), "completed"),
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => expect(projection.summary("thread")?.currentTurnId).toBeNull());

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/v1/threads/thread/settings",
      headers,
      payload: { collaborationMode: "default" },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().settings.collaborationMode).toBe("default");
    await app.close();
    await store.flushed();
  });

  it("keeps stopped Team state while workspace work still needs a decision", async () => {
    const { app, bridge, headers, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Preserve isolated changes",
        prompt: "Prepare an isolated change.",
      }),
    );
    const cleanup = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Retry workspace cleanup",
        prompt: "Wait for cleanup recovery.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        Object.values(store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {}).map(
          (task) => task.status,
        ),
      ).toEqual(["running", "running"]),
    );
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = String(task.childTurnId);
      task.result = { outcome: "success", summary: "Change prepared.", source: "submitted" };
      task.workspace = {
        lifecycle: "ready",
        repositoryRoot: "/work",
        gitCommonDir: "/work/.git",
        worktreePath: `/work/.git/codexnest/worktrees/${String(spawned.taskId)}`,
        head: "a".repeat(40),
        baseline: {},
        changedPaths: ["src/change.ts"],
        createdAt: 1,
        updatedAt: 2,
      };
      const cleanupTask = state.threadMeta.thread?.teamOrchestration?.tasks[String(cleanup.taskId)];
      if (!cleanupTask) return;
      cleanupTask.status = "completed";
      cleanupTask.terminalTurnId = String(cleanupTask.childTurnId);
      cleanupTask.result = { outcome: "success", summary: "Integrated.", source: "submitted" };
      cleanupTask.workspace = {
        lifecycle: "integrated",
        repositoryRoot: "/work",
        gitCommonDir: "/work/.git",
        worktreePath: `/work/.git/codexnest/worktrees/${String(cleanup.taskId)}`,
        head: "b".repeat(40),
        baseline: {},
        error: "cleanup pending",
        createdAt: 1,
        updatedAt: 2,
      };
    });

    const stopped = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/interrupt",
      headers,
      payload: {},
    });

    expect(stopped.statusCode).toBe(204);
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.workspace,
    ).toMatchObject({ lifecycle: "ready", changedPaths: ["src/change.ts"] });
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(cleanup.taskId)]
        ?.workspace,
    ).toMatchObject({ lifecycle: "integrated", error: "cleanup pending" });
    await app.close();
    await store.flushed();
  });

  it("enforces Team task settings and preserves structured results", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const unsafeWriteRoot = await callTeamTool(bridge, "thread", "spawn_task", {
      title: "Unsafe Git metadata write",
      prompt: "Do not start.",
      access: { mode: "sharedWrite", writePaths: ["src/.GiT/config"] },
    });
    expect(unsafeWriteRoot.success).toBe(false);
    expect(unsafeWriteRoot.contentItems[0]?.text).toContain(
      "Unsafe repository-relative write path",
    );
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Read-only audit",
        prompt: "Inspect the current implementation.",
        access: { mode: "readOnly", network: false },
        reasoningEffort: "high",
        serviceTier: "fast",
      }),
    );
    await vi.waitFor(() => {
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running");
    });
    const childStart = bridge.request.mock.calls.find(
      ([method, params]) =>
        method === "turn/start" &&
        (params as Record<string, unknown>).threadId === spawned.threadId,
    )?.[1];
    expect(childStart).toMatchObject({
      cwd: "/work",
      runtimeWorkspaceRoots: ["/work"],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: null,
    });
    const childThreadStart = bridge.request.mock.calls.find(
      ([method, params]) =>
        method === "thread/start" &&
        String((params as Record<string, unknown>).threadSource).startsWith("codexnest-managed:"),
    )?.[1];
    expect(childThreadStart).toMatchObject({ model: "gpt-5.6-sol", serviceTier: null });
    const childResume = bridge.request.mock.calls.find(
      ([method, params]) =>
        method === "thread/resume" &&
        (params as Record<string, unknown>).threadId === spawned.threadId,
    )?.[1];
    expect(childResume).toMatchObject({ model: "gpt-5.6-sol", serviceTier: null });

    const submitted = await callTeamTool(bridge, String(spawned.threadId), "submit_result", {
      outcome: "success",
      summary: "Audit complete",
      details: "No defects found.",
      checks: [{ name: "server tests", outcome: "passed" }],
      risks: ["None observed"],
      artifacts: [{ label: "Reference", url: "https://example.com/result" }],
    });
    expect(submitted.success).toBe(true);
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(spawned.threadId),
        turn: { ...testTurn(`turn-${String(spawned.threadId)}`, "completed"), itemsView: "full" },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.result,
      ).toMatchObject({
        outcome: "success",
        summary: "Audit complete",
        checks: [{ name: "server tests", outcome: "passed" }],
        risks: ["None observed"],
        artifacts: [{ label: "Reference", url: "https://example.com/result" }],
      });
    });
    const listed = dynamicToolJson(await callTeamTool(bridge, "thread", "list_tasks", {}));
    expect(listed.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: spawned.taskId,
          access: { mode: "readOnly", network: false },
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        }),
      ]),
    );
    expect((listed.tasks as Array<Record<string, unknown>>)[0]).not.toHaveProperty("tokenBudget");
    expect((listed.tasks as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      "timeoutMinutes",
    );
    await app.close();
    await store.flushed();
  });

  it("rejects unsupported managed-child effort before creating a thread", async () => {
    const { app, bridge } = await createTeamHarness();

    const response = await callTeamTool(bridge, "thread", "spawn_task", {
      title: "Unsupported effort",
      prompt: "Do not start.",
      reasoningEffort: "low",
    });

    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.text).toContain(
      "The requested reasoning effort is unavailable",
    );
    expect(bridge.managedThreads).toHaveLength(0);
    await app.close();
  });

  it("rejects managed tasks when gpt-5.6-sol is unavailable", async () => {
    const { app, bridge } = await createTeamHarness({ includeManagedModel: false });

    const response = await callTeamTool(bridge, "thread", "spawn_task", {
      title: "Missing fixed model",
      prompt: "Do not start.",
    });

    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.text).toContain(
      "The required managed-task model gpt-5.6-sol is unavailable",
    );
    expect(bridge.managedThreads).toHaveLength(0);
    await app.close();
  });

  it("blocks isolated integration while a shared-write task is active", async () => {
    const repository = await createApiTestRepository();
    const { app, bridge, store } = await createTeamHarness({
      projectPath: repository,
    });
    const isolated = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Prepare isolated change",
        prompt: "Change src/index.ts.",
        access: { mode: "isolatedWrite", writePaths: ["src"] },
      }),
    );
    const shared = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Update shared files",
        prompt: "Work in the parent repository.",
        access: { mode: "sharedWrite", writePaths: ["src"] },
      }),
    );
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(tasks[String(isolated.taskId)]?.workspace).toBeTruthy();
      expect(tasks[String(shared.taskId)]?.status).toBe("running");
    });
    await store.update((state) => {
      const task = state.threadMeta.thread?.teamOrchestration?.tasks[String(isolated.taskId)];
      if (!task) return;
      task.status = "completed";
      task.terminalTurnId = String(task.childTurnId);
      task.result = { outcome: "success", summary: "Change ready.", source: "submitted" };
    });

    const response = await callTeamTool(bridge, "thread", "integrate_task", {
      taskId: isolated.taskId,
    });
    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.text).toContain(
      `Wait for shared-write task Update shared files [${String(shared.taskId)}]`,
    );
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(isolated.taskId)]
        ?.workspace?.lifecycle,
    ).not.toBe("integrating");
    await app.close();
    await store.flushed();
  });

  it("exposes overlapping isolated workspaces for sequential root-side synthesis", async () => {
    const repository = await createApiTestRepository();
    const { app, bridge, store } = await createTeamHarness({
      projectPath: repository,
    });
    const first = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "First isolated approach",
        prompt: "Change src/index.ts using the first approach.",
        access: { mode: "isolatedWrite", writePaths: ["src"] },
      }),
    );
    const second = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Second isolated approach",
        prompt: "Change src/index.ts using the second approach.",
        access: { mode: "isolatedWrite", writePaths: ["src"] },
      }),
    );
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(tasks[String(first.taskId)]?.status).toBe("running");
      expect(tasks[String(second.taskId)]?.status).toBe("running");
      expect(tasks[String(first.taskId)]?.workspace?.worktreePath).toBeTruthy();
      expect(tasks[String(second.taskId)]?.workspace?.worktreePath).toBeTruthy();
    });
    const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
    const firstWorkspace = tasks[String(first.taskId)]?.workspace;
    const secondWorkspace = tasks[String(second.taskId)]?.workspace;
    if (!firstWorkspace || !secondWorkspace) throw new Error("Expected isolated workspaces");
    expect(firstWorkspace.worktreePath).not.toBe(secondWorkspace.worktreePath);

    await writeFile(join(firstWorkspace.worktreePath, "src", "index.ts"), "first approach\n");
    await writeFile(join(secondWorkspace.worktreePath, "src", "index.ts"), "second approach\n");
    await store.update((state) => {
      for (const taskId of [String(first.taskId), String(second.taskId)]) {
        const task = state.threadMeta.thread?.teamOrchestration?.tasks[taskId];
        if (!task) continue;
        task.status = "completed";
        task.terminalTurnId = String(task.childTurnId);
        task.result = { outcome: "success", summary: "Approach ready.", source: "submitted" };
      }
    });

    expect(
      (
        await callTeamTool(bridge, "thread", "integrate_task", {
          taskId: first.taskId,
        })
      ).success,
    ).toBe(true);
    const conflicting = await callTeamTool(bridge, "thread", "integrate_task", {
      taskId: second.taskId,
    });
    expect(conflicting.success).toBe(false);
    expect(conflicting.contentItems[0]?.text).toContain("parent workspace changed");

    const inspected = dynamicToolJson(
      await callTeamTool(bridge, "thread", "inspect_task", { taskId: second.taskId }),
    );
    expect(inspected.workspacePath).toBe(secondWorkspace.worktreePath);
    expect(inspected.workspace).toMatchObject({
      lifecycle: "conflicted",
      conflictPaths: ["src/index.ts"],
    });

    await writeFile(join(repository, "src", "index.ts"), "merged first and second approaches\n");
    expect(
      (
        await callTeamTool(bridge, "thread", "discard_task_changes", {
          taskId: second.taskId,
        })
      ).success,
    ).toBe(true);
    await expect(readFile(join(repository, "src", "index.ts"), "utf8")).resolves.toBe(
      "merged first and second approaches\n",
    );
    await app.close();
    await store.flushed();
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "keeps failed integrated-workspace cleanup retryable",
    async () => {
      const repository = await createApiTestRepository();
      const workspace = await createTeamWorkspace(repository, "cleanup recovery");
      const { app, headers, projection, store } = await createTeamHarness({
        projectPath: repository,
      });
      await store.update((state) => {
        state.threadMeta.thread!.teamOrchestration = {
          tasks: {
            cleanup: {
              id: "cleanup",
              parentThreadId: "thread",
              childThreadId: "managed-cleanup",
              childThreadSource: "codexnest-managed:cleanup",
              title: "Cleanup integrated workspace",
              prompt: "Cleanup only.",
              status: "completed",
              createdAt: 1,
              startedAt: 2,
              lastActivityAt: 3,
              completedAt: 3,
              terminalTurnId: "managed-cleanup-turn",
              result: { outcome: "success", summary: "Integrated.", source: "submitted" },
              workspace: {
                ...workspace,
                lifecycle: "integrated",
                error: "cleanup pending",
                createdAt: 1,
                updatedAt: 1,
              },
            },
          },
        };
      });

      const gitDirectory = join(repository, ".git");
      await chmod(gitDirectory, 0o000);
      try {
        projection.emit("event", 101, { type: "resync.required" });
        await vi.waitFor(() => {
          const recovered =
            store.snapshot().threadMeta.thread?.teamOrchestration?.tasks.cleanup?.workspace;
          expect(recovered?.lifecycle).toBe("integrated");
          expect(recovered?.error).toBeTruthy();
          expect(recovered?.error).not.toBe("cleanup pending");
        });
      } finally {
        await chmod(gitDirectory, 0o700);
      }

      const deletion = await app.inject({
        method: "DELETE",
        url: "/api/v1/threads/thread",
        headers,
      });
      expect(deletion.statusCode).toBe(404);
      const disableTeam = await app.inject({
        method: "PATCH",
        url: "/api/v1/threads/thread/settings",
        headers,
        payload: { collaborationMode: "default" },
      });
      expect(disableTeam.statusCode).toBe(409);
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks.cleanup?.workspace,
      ).toMatchObject({ lifecycle: "integrated", error: expect.any(String) });

      projection.emit("event", 102, { type: "resync.required" });
      await vi.waitFor(() =>
        expect(
          store.snapshot().threadMeta.thread?.teamOrchestration?.tasks.cleanup?.workspace,
        ).toMatchObject({ lifecycle: "integrated", error: undefined }),
      );
      await expect(access(workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      await app.close();
      await store.flushed();
    },
  );

  it("removes implicit temporary-directory writes from isolated child sandboxes", async () => {
    const repository = await createApiTestRepository();
    const { app, bridge, store } = await createTeamHarness({
      projectPath: repository,
    });
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Scoped temporary repository write",
        prompt: "Edit only src.",
        access: { mode: "isolatedWrite", writePaths: ["src"] },
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.status,
      ).toBe("running"),
    );
    const workspace =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
        ?.workspace;
    if (!workspace) throw new Error("Expected an isolated Team workspace");
    for (const name of [".agents", ".codex"]) {
      expect((await lstat(join(workspace.worktreePath, name))).isDirectory()).toBe(true);
      await expect(access(join(repository, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(computeTeamWorkspaceDelta(workspace)).resolves.toEqual({
      changedPaths: [],
      changes: [],
    });
    const childTurnStart = bridge.request.mock.calls.find(
      ([method, params]) =>
        method === "turn/start" &&
        (params as Record<string, unknown>).threadId === spawned.threadId,
    )?.[1];
    expect(childTurnStart).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
    await app.close();
    await store.flushed();
  });

  it("recreates sandbox mountpoints when an isolated workspace is reused", async () => {
    const repository = await createApiTestRepository();
    const { app, bridge, store } = await createTeamHarness({
      projectPath: repository,
    });
    const first = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Prepare a reusable isolated change",
        prompt: "Edit src/index.ts.",
        access: { mode: "isolatedWrite", writePaths: ["src"] },
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(first.taskId)]?.status,
      ).toBe("running"),
    );
    const running =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(first.taskId)];
    if (!running?.workspace || !running.childTurnId) {
      throw new Error("Expected a running task with an isolated workspace");
    }
    await writeFile(
      join(running.workspace.worktreePath, "src", "index.ts"),
      "export const value = 2;\n",
    );
    await callTeamTool(bridge, String(first.threadId), "submit_result", {
      outcome: "success",
      summary: "Change prepared.",
    });
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(first.threadId),
        turn: { ...testTurn(running.childTurnId, "completed"), itemsView: "full" },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const completed =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(first.taskId)];
      expect(completed?.status).toBe("completed");
      expect(completed?.delivery?.status).toBe("delivered");
      expect(completed?.workspace?.lifecycle).toBe("ready");
    });

    for (const name of [".agents", ".codex"]) {
      await rm(join(running.workspace.worktreePath, name), { recursive: true });
    }
    const followup = dynamicToolJson(
      await callTeamTool(bridge, "thread", "followup_task", {
        taskId: first.taskId,
        prompt: "Continue in the existing workspace.",
      }),
    );
    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)]
          ?.status,
      ).toBe("running"),
    );
    const reused =
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)]
        ?.workspace;
    expect(reused?.worktreePath).toBe(running.workspace.worktreePath);
    for (const name of [".agents", ".codex"]) {
      expect((await lstat(join(running.workspace.worktreePath, name))).isDirectory()).toBe(true);
    }
    await app.close();
    await store.flushed();
  });

  it("tracks Team task usage without enforcing retired token or time budgets", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const taskResult = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Unbounded task",
        prompt: "Inspect briefly.",
        // Simulate a stale caller that still sends retired fields. Production tool schemas reject
        // these additional properties, and the handler must never turn them into hard limits.
        tokenBudget: 10,
        timeoutMinutes: 1,
      }),
    );
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(taskResult.taskId)];
      expect(task?.status).toBe("running");
      expect(task).not.toHaveProperty("tokenBudget");
      expect(task).not.toHaveProperty("timeoutMinutes");
    });
    const usage = {
      totalTokens: 10,
      inputTokens: 6,
      cachedInputTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
    };
    bridge.failInterrupts = 1;
    bridge.emit("notification", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: String(taskResult.threadId),
        turnId: `turn-${String(taskResult.threadId)}`,
        tokenUsage: { total: usage, last: usage, modelContextWindow: 100_000 },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(taskResult.taskId)];
      expect(task?.tokensUsed).toBe(10);
      expect(task).not.toHaveProperty("budgetReason");
    });
    expect(
      bridge.request.mock.calls.filter(
        ([method, params]) =>
          method === "turn/interrupt" &&
          (params as Record<string, unknown>).threadId === taskResult.threadId,
      ),
    ).toHaveLength(0);

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(taskResult.threadId),
        turn: {
          ...testTurn(`turn-${String(taskResult.threadId)}`, "completed"),
          itemsView: "full",
        },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(taskResult.taskId)];
      expect(task?.result).toMatchObject({
        outcome: "success",
        summary: "Managed task completed without an agent message.",
      });
      expect(task?.failureReason).toBeUndefined();
    });
    await app.close();
    await store.flushed();
  });

  it("waits for delivered dependencies and reuses a child thread for follow-up work", async () => {
    const { app, bridge, projection, store } = await createTeamHarness();
    const first = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Inspect API",
        prompt: "Inspect the API.",
      }),
    );
    const dependent = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Use inspection",
        prompt: "Use the completed inspection.",
        dependsOn: [first.taskId],
      }),
    );
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(tasks[String(first.taskId)]?.status).toBe("running");
      expect(tasks[String(dependent.taskId)]?.status).toBe("queued");
    });

    await callTeamTool(bridge, String(first.threadId), "submit_result", {
      outcome: "success",
      summary: "Inspection complete",
    });
    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(first.threadId),
        turn: { ...testTurn(`turn-${String(first.threadId)}`, "completed"), itemsView: "full" },
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
      expect(tasks[String(first.taskId)]?.delivery?.status).toBe("delivered");
      expect(tasks[String(dependent.taskId)]?.status).toBe("running");
    });

    const childStartsBeforeFollowup = bridge.request.mock.calls.filter(
      ([method]) => method === "thread/start",
    ).length;
    const followup = dynamicToolJson(
      await callTeamTool(bridge, "thread", "followup_task", {
        taskId: first.taskId,
        prompt: "Clarify one point from the inspection.",
      }),
    );
    expect(followup).toMatchObject({ threadId: first.threadId });
    expect(followup.taskId).not.toBe(first.taskId);
    await vi.waitFor(() => {
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)]
          ?.status,
      ).toBe("running");
    });
    expect(bridge.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      childStartsBeforeFollowup,
    );

    const tasks = store.snapshot().threadMeta.thread?.teamOrchestration?.tasks ?? {};
    const predecessorTurnId = tasks[String(first.taskId)]?.childTurnId;
    const followupTurnId = tasks[String(followup.taskId)]?.childTurnId;
    expect(predecessorTurnId).toBe(`turn-${String(first.threadId)}`);
    expect(followupTurnId).toBe(`turn-${String(first.threadId)}-2`);

    bridge.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: String(first.threadId),
        turn: { ...testTurn(String(predecessorTurnId), "completed"), itemsView: "full" },
      },
    } satisfies ServerNotification);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await store.flushed();
    expect(
      store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)],
    ).toMatchObject({ status: "running", childTurnId: followupTurnId });

    await projection.markInterrupted(String(first.threadId), [String(followupTurnId)]);
    await store.update((state) => {
      const current = state.threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)];
      if (!current) return;
      current.status = "starting";
      delete current.childTurnId;
      delete current.startedAt;
    });
    bridge.threadTurns.set(String(first.threadId), [
      {
        ...testTurn(String(predecessorTurnId), "completed"),
        itemsView: "full",
        items: [],
      },
    ]);
    projection.emit("event", 20, { type: "resync.required" });
    await vi.waitFor(() => {
      const recovered =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(followup.taskId)];
      expect(recovered?.status).toBe("running");
      expect(recovered?.childTurnId).not.toBe(predecessorTurnId);
      expect(recovered?.result).toBeUndefined();
    });
    await app.close();
    await store.flushed();
  });

  it("pauses the watchdog while a managed child uses the built-in sleep tool", async () => {
    const { app, bridge, store } = await createTeamHarness();
    const spawned = dynamicToolJson(
      await callTeamTool(bridge, "thread", "spawn_task", {
        title: "Проверить результат через час",
        prompt: "Запусти скрипт и проверь результат через час.",
      }),
    );
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      expect(task?.status).toBe("running");
    });

    const childStart = bridge.request.mock.calls.find(
      ([method, params]) =>
        method === "thread/start" &&
        String((params as Record<string, unknown>).threadSource).startsWith("codexnest-managed:"),
    );
    expect(childStart?.[1]).toMatchObject({
      developerInstructions: expect.stringMatching(
        /fixed delay.*asynchronously.*startup check.*built-in sleep tool once.*remaining time.*submit_result with outcome/is,
      ),
    });
    expect(
      bridge.request.mock.calls.find(
        ([method, params]) =>
          method === "turn/start" &&
          (params as Record<string, unknown>).threadId === spawned.threadId,
      )?.[1],
    ).toMatchObject({
      additionalContext: {
        "codexnest.images": {
          kind: "application",
          value: expect.stringContaining("explicitly include a Markdown image"),
        },
      },
    });

    const startedAt = Date.now();
    bridge.emit("notification", {
      method: "item/started",
      params: {
        threadId: String(spawned.threadId),
        turnId: `turn-${String(spawned.threadId)}`,
        item: { type: "sleep", id: "sleep", durationMs: 60 * 60_000 },
        startedAtMs: startedAt,
      },
    } satisfies ServerNotification);

    await vi.waitFor(() =>
      expect(
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)]
          ?.expectedWakeAt,
      ).toBe(startedAt + 60 * 60_000),
    );
    await expect(triggerTeamWatchdogs(store, new Map(), startedAt + 69 * 60_000)).resolves.toEqual(
      new Set(),
    );
    await expect(triggerTeamWatchdogs(store, new Map(), startedAt + 70 * 60_000)).resolves.toEqual(
      new Set(["thread"]),
    );

    bridge.emit("notification", {
      method: "item/completed",
      params: {
        threadId: String(spawned.threadId),
        turnId: `turn-${String(spawned.threadId)}`,
        item: { type: "sleep", id: "sleep", durationMs: 60 * 60_000 },
        completedAtMs: startedAt + 60 * 60_000,
      },
    } satisfies ServerNotification);
    await vi.waitFor(() => {
      const task =
        store.snapshot().threadMeta.thread?.teamOrchestration?.tasks[String(spawned.taskId)];
      expect(task?.expectedWakeAt).toBeUndefined();
      expect(task?.watchdog).toBeUndefined();
    });

    await app.close();
    await store.flushed();
  });
});

function createCodexManagerMock() {
  const codexStatus = {
    supported: true,
    unavailableReason: null,
    operation: "idle" as const,
    activeTurnCount: 0,
    daemonStatus: "running",
    cliVersion: "0.144.6",
    appServerVersion: "0.144.6",
    latestVersion: null,
    updateAvailable: null,
    networkStatus: "unknown" as const,
    networkMessage: null,
    proxy: {
      configured: true,
      protocol: "http" as const,
      host: "proxy.example",
      port: 8000,
      username: "user",
      hasPassword: true,
      error: null,
    },
  };
  const codexManager = {
    maintenanceActive: false,
    assertTurnsAllowed: vi.fn(),
    status: vi.fn(async () => codexStatus),
    check: vi.fn(async () => ({
      ...codexStatus,
      latestVersion: "0.145.0",
      updateAvailable: true,
      networkStatus: "ok" as const,
    })),
    applyProxy: vi.fn(async () => codexStatus),
    update: vi.fn(async () => codexStatus),
    restart: vi.fn(async () => codexStatus),
    forceRestart: vi.fn(async () => codexStatus),
  } as unknown as CodexManager;
  return { codexManager, codexStatus };
}

function createAppManagerMock() {
  const appStatus = {
    supported: true,
    currentVersion: "0.1.0",
    latestVersion: null,
    updateAvailable: null,
    operation: "idle" as const,
    result: "none" as const,
    message: null,
    checkedAt: null,
    updatedAt: null,
  };
  const appManager = {
    status: vi.fn(async () => appStatus),
    check: vi.fn(async () => ({
      ...appStatus,
      latestVersion: "0.2.0",
      updateAvailable: true,
    })),
    update: vi.fn(async () => ({ ...appStatus, operation: "preparing" as const })),
    forceRestart: vi.fn(async () => ({ accepted: true as const })),
  } as unknown as AppManager;
  return { appManager, appStatus };
}

class SettingsBridge extends EventEmitter {
  state = "ready" as const;
  deliveryVersion: number | undefined = 1;
  private nativeReceipts = new Map<string, { params: string; response: unknown }>();
  actualVersion = "0.144.6";
  permissionConfig: Record<string, unknown> = {
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    approvals_reviewer: "auto_review",
  };
  configVersion = 1;
  writeStatus: "ok" | "okOverridden" = "ok";
  writeMessage: string | null = null;
  conflictingVersion: string | null = null;
  goal: ThreadGoal | null = null;
  failNextTurnStart = false;
  notifyTurnStarted = true;
  failBrowserResumeOnce = false;
  failNextGoalActivation = false;
  failInterrupts = 0;
  timeoutForkAfterCreate = false;
  timeoutInjectAfterWrite = false;
  nextForkTargetPath: string | null = null;
  threadReadPath: string | null = null;
  freshCompactionItems: Record<string, unknown>[] = [
    { type: "message", id: "fresh-summary", role: "user", content: [] },
    { type: "compaction", id: "fresh-encrypted-summary", encrypted_content: "fresh-opaque" },
  ];
  failCompactionWith: Error | null = null;
  lastDeletedThreadPath: string | null = null;
  parentTurnStartEntered: (() => void) | null = null;
  parentTurnStartGate: Promise<void> | null = null;
  nextTurnListError: RpcError | null = null;
  missingRolloutThreadIds = new Set<string>();
  missingThreadIds = new Set<string>();
  managedThreadSequence = 0;
  managedTurnSequences = new Map<string, number>();
  managedThreads: Thread[] = [];
  threadTurns = new Map<string, Turn[]>();
  includeManagedModel = true;
  gptAServiceTiers = [{ id: "fast", name: "Fast" }];
  managedModelServiceTiers = [{ id: "fast", name: "Fast" }];
  skills = [
    {
      name: "review",
      description: "Review a change",
      interface: { displayName: "Code Review", shortDescription: "Review this change" },
      path: "/skills/review/SKILL.md",
      scope: "user",
      enabled: true,
    },
    {
      name: "disabled",
      description: "Disabled skill",
      path: "/skills/disabled/SKILL.md",
      scope: "system",
      enabled: false,
    },
    {
      name: "openai-templates:artifact-template-analytics-dashboard",
      description: "Create a spreadsheet from the default Analytics Dashboard template",
      path: "/plugins/openai-templates/skills/artifact-template-analytics-dashboard/SKILL.md",
      scope: "user",
      enabled: true,
    },
  ];
  nextCreatedThreadId = "created";
  request = vi.fn(
    async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      const clientId =
        method === "thread/start" ? params.clientCreationId : params.clientUserMessageId;
      const keyed =
        this.deliveryVersion === 1 &&
        typeof clientId === "string" &&
        ["thread/start", "turn/start", "turn/steer"].includes(method);
      const key = `${method}:${params.threadId ?? ""}:${clientId}`;
      const previous = keyed ? this.nativeReceipts.get(key) : undefined;
      if (previous) {
        if (previous.params !== JSON.stringify(params))
          throw new RpcError(-32602, "delivery conflict");
        return structuredClone(previous.response);
      }
      const response = await this.handleRequest(method, params);
      if (!keyed) return response;
      const value = response as { thread?: Thread; turn?: Turn; turnId?: string };
      const accepted = {
        ...value,
        deliveryReceipt: {
          version: 1,
          clientId,
          threadId: value.thread?.id ?? params.threadId,
          turnId: value.turn?.id ?? value.turnId ?? null,
        },
      };
      this.nativeReceipts.set(key, {
        params: JSON.stringify(params),
        response: structuredClone(accepted),
      });
      return accepted;
    },
  );

  private async handleRequest(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (method === "thread/list") {
      return params.archived
        ? { data: [], nextCursor: null, backwardsCursor: null }
        : { data: [testThread(), ...this.managedThreads], nextCursor: null, backwardsCursor: null };
    }
    if (method === "thread/loaded/list") {
      return { data: ["thread"], nextCursor: null };
    }
    if (method === "model/list") {
      return {
        data: [
          testModel("gpt-a", "high", true, this.gptAServiceTiers),
          testModel("gpt-b", "low", false, []),
          ...(this.includeManagedModel
            ? [testModel("gpt-5.6-sol", "high", true, this.managedModelServiceTiers)]
            : []),
        ],
        nextCursor: null,
      };
    }
    if (method === "skills/list") {
      return {
        data: (Array.isArray(params.cwds) ? params.cwds : ["/work"]).map((cwd) => ({
          cwd,
          skills: this.skills,
          errors: [],
        })),
      };
    }
    if (method === "skills/config/write") {
      const enabled = Boolean(params.enabled);
      const skill = this.skills.find((candidate) => candidate.path === params.path);
      if (skill) skill.enabled = enabled;
      return { effectiveEnabled: enabled };
    }
    if (method === "thread/start") {
      if (String(params.threadSource).startsWith("codexnest-managed:")) {
        this.managedThreadSequence += 1;
        const thread = {
          ...testThread(`managed-${this.managedThreadSequence}`),
          threadSource: String(params.threadSource),
        };
        this.managedThreads.push(thread);
        return { thread };
      }
      const thread = {
        ...testThread(this.nextCreatedThreadId),
        cwd: String(params.cwd ?? "/work"),
        path: this.nextForkTargetPath,
        threadSource: typeof params.threadSource === "string" ? params.threadSource : null,
      };
      if (thread.threadSource) this.managedThreads.push(thread);
      return { thread };
    }
    if (method === "thread/fork") {
      const temporary = String(params.threadSource).startsWith("codexnest-fork-temp:");
      let temporaryPath: string | null = null;
      if (temporary) {
        const directory = await mkdtemp(join(tmpdir(), "codexnest-api-compact-fork-"));
        directories.push(directory);
        temporaryPath = join(directory, "rollout.jsonl");
        if (this.threadReadPath) await copyFile(this.threadReadPath, temporaryPath);
        else {
          await writeFile(
            temporaryPath,
            `${JSON.stringify({ type: "session_meta", payload: { id: "temporary" } })}\n`,
            "utf8",
          );
        }
      }
      const thread = {
        ...testThread(temporary ? "temporary-fork" : "fork"),
        sessionId: temporary ? "temporary-fork" : "fork",
        forkedFromId: String(params.threadId),
        createdAt: 3,
        updatedAt: 4,
        recencyAt: 4,
        status: { type: "idle" as const },
        path: temporaryPath,
        threadSource: typeof params.threadSource === "string" ? params.threadSource : null,
      };
      this.managedThreads.push(thread);
      if (this.timeoutForkAfterCreate) {
        this.timeoutForkAfterCreate = false;
        throw new RpcTimeoutError("thread/fork", 600_000);
      }
      return { thread };
    }
    if (method === "thread/compact/start") {
      if (this.failCompactionWith) throw this.failCompactionWith;
      const thread = this.managedThreads.find((candidate) => candidate.id === params.threadId);
      if (!thread?.path) throw new Error("temporary rollout is missing");
      await appendFile(
        thread.path,
        `${JSON.stringify({
          type: "compacted",
          payload: { message: "", replacement_history: this.freshCompactionItems },
        })}\n`,
        "utf8",
      );
      const compactTurn = {
        ...testTurn(`compact-${thread.id}`, "completed"),
        itemsView: "full" as const,
        items: [{ type: "contextCompaction" as const, id: `compaction-${thread.id}` }],
      };
      this.threadTurns.set(thread.id, [...(this.threadTurns.get(thread.id) ?? []), compactTurn]);
      this.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: thread.id,
          turn: compactTurn,
        },
      } satisfies ServerNotification);
      return {};
    }
    if (method === "thread/resume") {
      const threadId = String(params.threadId);
      if (this.missingRolloutThreadIds.delete(threadId)) {
        throw new RpcError(-32_600, `no rollout found for thread id ${threadId}`);
      }
      const config = params.config;
      if (
        this.failBrowserResumeOnce &&
        config &&
        typeof config === "object" &&
        "mcp_servers" in config
      ) {
        this.failBrowserResumeOnce = false;
        throw new Error("browser resume failed");
      }
      return {
        thread:
          this.managedThreads.find((thread) => thread.id === threadId) ?? testThread(threadId),
      };
    }
    if (method === "thread/unsubscribe") return {};
    if (method === "thread/metadata/update") {
      const threadId = String(params.threadId);
      if (this.missingRolloutThreadIds.delete(threadId)) {
        throw new RpcError(-32_600, `no rollout found for thread id ${threadId}`);
      }
      return { thread: testThread(String(params.threadId)) };
    }
    if (method === "thread/name/set") return {};
    if (method === "thread/inject_items") {
      const thread = this.managedThreads.find((candidate) => candidate.id === params.threadId);
      if (thread?.path && Array.isArray(params.items)) {
        await appendFile(
          thread.path,
          `${params.items
            .map((payload) => JSON.stringify({ type: "response_item", payload }))
            .join("\n")}\n`,
          "utf8",
        );
      }
      if (this.timeoutInjectAfterWrite) {
        this.timeoutInjectAfterWrite = false;
        throw new RpcTimeoutError("thread/inject_items", 600_000);
      }
      return {};
    }
    if (method === "thread/delete") {
      const index = this.managedThreads.findIndex((thread) => thread.id === params.threadId);
      if (index >= 0) {
        const [thread] = this.managedThreads.splice(index, 1);
        this.lastDeletedThreadPath = thread?.path ?? null;
        if (thread?.path) await rm(thread.path, { force: true });
      }
      return {};
    }
    if (method === "thread/turns/list") {
      if (this.nextTurnListError) {
        const error = this.nextTurnListError;
        this.nextTurnListError = null;
        throw error;
      }
      return {
        data: [...(this.threadTurns.get(String(params.threadId)) ?? [])].reverse(),
        nextCursor: null,
        backwardsCursor: null,
      };
    }
    if (method === "thread/items/list") {
      const turn = (this.threadTurns.get(String(params.threadId)) ?? []).find(
        (candidate) => candidate.id === params.turnId,
      );
      return {
        data: turn?.items ?? [],
        nextCursor: null,
        backwardsCursor: null,
      };
    }
    if (method === "thread/read") {
      const threadId = String(params.threadId);
      if (this.missingThreadIds.has(threadId)) {
        throw new RpcError(-32_600, `thread ${threadId} not found`);
      }
      const thread =
        threadId === "thread"
          ? { ...testThread(), path: this.threadReadPath }
          : (this.managedThreads.find((candidate) => candidate.id === threadId) ??
            testThread(threadId));
      return { thread: { ...thread, turns: this.threadTurns.get(threadId) ?? [] } };
    }
    if (method === "turn/start") {
      if (this.failNextTurnStart) {
        this.failNextTurnStart = false;
        throw new Error("turn failed");
      }
      const threadId = String(params.threadId ?? "thread");
      if (threadId === "thread" && this.parentTurnStartGate) {
        this.parentTurnStartEntered?.();
        await this.parentTurnStartGate;
      }
      const managedTurnSequence = (this.managedTurnSequences.get(threadId) ?? 0) + 1;
      this.managedTurnSequences.set(threadId, managedTurnSequence);
      const turnId =
        threadId === "thread"
          ? String(params.clientUserMessageId).startsWith(CAPACITY_RETRY_MESSAGE_PREFIX)
            ? `capacity-turn-${managedTurnSequence}`
            : "turn"
          : managedTurnSequence === 1
            ? `turn-${threadId}`
            : `turn-${threadId}-${managedTurnSequence}`;
      const input = Array.isArray(params.input) ? params.input : [];
      const turn: Turn = {
        ...testTurn(turnId, "inProgress"),
        itemsView: "full",
        items: input.length
          ? [
              {
                type: "userMessage",
                id: `user-${turnId}`,
                clientId:
                  typeof params.clientUserMessageId === "string"
                    ? params.clientUserMessageId
                    : null,
                content: input as Extract<ThreadItem, { type: "userMessage" }>["content"],
              },
            ]
          : [],
      };
      this.threadTurns.set(threadId, [...(this.threadTurns.get(threadId) ?? []), turn]);
      if (this.notifyTurnStarted) {
        this.emit("notification", { method: "turn/started", params: { threadId, turn } });
      }
      return {
        turn,
      };
    }
    if (method === "turn/steer") {
      const threadId = String(params.threadId);
      const turns = this.threadTurns.get(threadId) ?? [];
      const active = turns.at(-1);
      if (active && Array.isArray(params.input)) {
        active.items.push({
          type: "userMessage",
          id: `user-steer-${active.items.length}`,
          clientId:
            typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : null,
          content: params.input as Extract<ThreadItem, { type: "userMessage" }>["content"],
        });
      }
      return { turnId: String(params.expectedTurnId) };
    }
    if (method === "turn/interrupt") {
      if (this.failInterrupts > 0) {
        this.failInterrupts -= 1;
        throw new RpcError(-32_000, "interrupt temporarily unavailable");
      }
      return {};
    }
    if (method === "thread/goal/get") return { goal: this.goal };
    if (method === "thread/goal/clear") {
      this.goal = null;
      return { cleared: true };
    }
    if (method === "thread/goal/set") {
      if (params.status === "active" && this.failNextGoalActivation) {
        this.failNextGoalActivation = false;
        throw new Error("activation failed");
      }
      this.goal = {
        threadId: String(params.threadId),
        objective:
          typeof params.objective === "string" ? params.objective : (this.goal?.objective ?? ""),
        status: params.status === "active" ? "active" : "paused",
        tokenBudget: null,
        tokensUsed: this.goal?.tokensUsed ?? 0,
        timeUsedSeconds: this.goal?.timeUsedSeconds ?? 0,
        createdAt: this.goal?.createdAt ?? 1,
        updatedAt: 2,
      };
      return { goal: this.goal };
    }
    if (method === "account/rateLimits/read") {
      const common = {
        limitName: null,
        credits: null,
        individualLimit: null,
        planType: null,
        rateLimitReachedType: null,
      };
      return {
        rateLimits: {
          ...common,
          limitId: null,
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
        rateLimitsByLimitId: {
          codex: {
            ...common,
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_785_258_183 },
            secondary: {
              usedPercent: 40,
              windowDurationMins: 10_080,
              resetsAt: 1_785_344_583,
            },
          },
        },
        rateLimitResetCredits: null,
      };
    }
    if (method === "config/read") {
      return {
        config: this.permissionConfig,
        origins: {},
        layers: [
          {
            name: { type: "user", file: "/home/hon/.codex/config.toml", profile: null },
            version: `version-${this.configVersion}`,
            config: this.permissionConfig,
            disabledReason: null,
          },
        ],
      };
    }
    if (method === "config/batchWrite") {
      if (params.expectedVersion === this.conflictingVersion) {
        throw new RpcError(-32_000, "Config version changed");
      }
      for (const edit of params.edits as Array<{ keyPath: string; value: unknown }>) {
        this.permissionConfig[edit.keyPath] = edit.value;
      }
      this.configVersion += 1;
      return {
        status: this.writeStatus,
        version: `version-${this.configVersion}`,
        filePath: "/home/hon/.codex/config.toml",
        overriddenMetadata:
          this.writeStatus === "okOverridden"
            ? {
                message: this.writeMessage,
                overridingLayer: { name: { type: "system", file: "/etc/codex/config.toml" } },
                effectiveValue: null,
              }
            : null,
      };
    }
    throw new Error(`Unexpected ${method}`);
  }
}

async function createSkillsHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-skills-api-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.auth.tokenSha256 = hashToken("correct");
    state.projects.push({
      id: "project",
      displayName: "Project",
      path: "/work",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
  });
  const bridge = new SettingsBridge();
  const attention = new AttentionManager();
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  await projection.sync();
  const app = await buildApp(
    loadConfig({
      statePath: store.path,
      clientDist: join(directory, "missing"),
      allowedOrigins: new Set(["http://localhost"]),
    }),
    {
      bridge: bridge as unknown as CodexBridge,
      store,
      projection,
      attention,
    },
  );
  return {
    app,
    bridge,
    headers: { authorization: "Bearer correct" },
  };
}

function dismissibleQuestion(itemId: string, isBlocking = true): ServerRequest {
  return {
    method: "item/tool/requestUserInput",
    id: 901,
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId,
      isBlocking,
      autoResolutionMs: null,
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Which?",
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    },
  } as ServerRequest;
}

async function createForkHarness(deliveryVersion: number | undefined = 1) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-fork-api-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.auth.tokenSha256 = hashToken("correct");
    state.projects.push({
      id: "project",
      displayName: "Project",
      path: "/work",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
  });
  const bridge = new SettingsBridge();
  bridge.deliveryVersion = deliveryVersion || undefined;
  const attention = new AttentionManager();
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  await projection.sync();
  await projection.setSettings("thread", {
    collaborationMode: "default",
    model: "gpt-b",
    reasoningEffort: "low",
  });
  await store.update((state) => {
    const meta = state.threadMeta.thread!;
    meta.pinned = true;
    meta.managedTeamToolsAvailable = true;
    meta.draft = {
      input: "source draft",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 1,
    };
    meta.teamOrchestration = { tasks: {} };
  });
  const threadTitles = {
    generate: vi.fn(async () => "Готовая реализация"),
  };
  const app = await buildApp(
    loadConfig({
      statePath: store.path,
      clientDist: join(directory, "missing"),
      allowedOrigins: new Set(["http://localhost"]),
    }),
    {
      bridge: bridge as unknown as CodexBridge,
      store,
      projection,
      attention,
      threadTitles,
    },
  );
  return {
    app,
    bridge,
    headers: { authorization: "Bearer correct" },
    projection,
    store,
    threadTitles,
    attention,
  };
}

describe("shared project drafts", () => {
  const empty = { input: "", images: [], files: [], goalMode: false, annotations: [] };

  it("clears an accepted first-voice draft only when its revision is still current", async () => {
    const { app, headers, store } = await createForkHarness();
    try {
      const save = (input: string) =>
        app.inject({
          method: "PUT",
          url: "/api/v1/projects/project/draft",
          headers,
          payload: { base: empty, value: { ...empty, input } },
        });
      const original = (await save("Контекст первого голосового")).json();
      const newer = (await save("Новый черновик с другого устройства")).json();
      const clear = (updatedAt: number) =>
        app.inject({
          method: "PUT",
          url: `/api/v1/projects/project/draft?expectedUpdatedAt=${updatedAt}`,
          headers,
          payload: { base: { ...empty, input: original.input }, value: empty },
        });
      const stale = await clear(original.updatedAt);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe("draft_conflict");
      expect(store.view().projectDrafts?.project).toEqual(newer);
      const accepted = await clear(newer.updatedAt);
      expect(accepted.statusCode).toBe(200);
      expect(store.view().projectDrafts?.project).toMatchObject(empty);
    } finally {
      await app.close();
    }
  });

  it("merges text and images from two devices, broadcasts and persists without starting a session", async () => {
    const { app, headers, bridge, projection, store } = await createForkHarness();
    try {
      bridge.request.mockClear();
      const events = vi.fn();
      projection.on("event", events);
      const initial = await app.inject({
        method: "GET",
        url: "/api/v1/projects/project/draft",
        headers,
      });
      expect(initial.json()).toBeNull();
      const first = await app.inject({
        method: "PUT",
        url: "/api/v1/projects/project/draft",
        headers,
        payload: { base: empty, value: { ...empty, input: "Текст с первого устройства" } },
      });
      expect(first.statusCode).toBe(200);
      const image = { id: "image", name: "photo.png", url: "data:image/png;base64,aGVsbG8=" };
      const second = await app.inject({
        method: "PUT",
        url: "/api/v1/projects/project/draft",
        headers,
        payload: { base: empty, value: { ...empty, images: [image] } },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ input: "Текст с первого устройства", images: [image] });
      expect(second.json().updatedAt).toBeGreaterThan(first.json().updatedAt);
      expect(events).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          type: "projectDraft.changed",
          projectId: "project",
          draft: second.json(),
        }),
      );
      expect(
        bridge.request.mock.calls.filter(([method]) => method !== "account/rateLimits/read"),
      ).toEqual([]);
      const reopened = new StateStore(store.path);
      await reopened.load();
      expect(reopened.view().projectDrafts?.project).toEqual(second.json());
      const fetched = await app.inject({
        method: "GET",
        url: "/api/v1/projects/project/draft",
        headers,
      });
      expect(fetched.json()).toEqual(second.json());
    } finally {
      await app.close();
    }
  });

  it("clears the consumed draft after durable enqueue and retains later edits", async () => {
    const { app, headers, store, bridge } = await createForkHarness();
    try {
      const save = (input: string) =>
        app.inject({
          method: "PUT",
          url: "/api/v1/projects/project/draft",
          headers,
          payload: { base: empty, value: { ...empty, input } },
        });
      const saved = (await save("Первое сообщение")).json();
      const enqueue = (id: string, updatedAt: number) =>
        app.inject({
          method: "POST",
          url: "/api/v1/threads/thread/queue",
          headers,
          payload: {
            input: "Первое сообщение",
            clientMessageId: id,
            projectDraft: { projectId: "project", updatedAt },
          },
        });
      bridge.request.mockClear();
      const accepted = await enqueue("shared-send", saved.updatedAt);
      expect(accepted.statusCode).toBe(202);
      expect(store.view().projectDrafts?.project?.input).toBe("");
      expect(store.view().projectDrafts?.project?.updatedAt).toBeGreaterThan(saved.updatedAt);
      const next = (await save("Следующий запрос")).json();
      expect((await enqueue("shared-send", saved.updatedAt)).statusCode).toBe(202);
      expect(store.view().projectDrafts?.project).toEqual(next);
      const another = (await save("Дополнение с другого устройства")).json();
      expect((await enqueue("shared-send-later", next.updatedAt)).statusCode).toBe(202);
      expect(store.view().projectDrafts?.project).toEqual(another);
    } finally {
      await app.close();
    }
  });

  it("uploads project files before first send and transfers them when creating the session", async () => {
    const { app, headers, bridge } = await createForkHarness();
    try {
      bridge.request.mockClear();
      const uploaded = await app.inject({
        method: "POST",
        url: "/api/v1/projects/project/attachments?name=notes.txt&mediaType=text/plain",
        headers: { ...headers, "content-type": "application/octet-stream" },
        payload: Buffer.from("hello"),
      });
      expect(uploaded.statusCode).toBe(201);
      const value = { ...empty, input: "Прочитай файл", files: [uploaded.json()] };
      const saved = await app.inject({
        method: "PUT",
        url: "/api/v1/projects/project/draft",
        headers,
        payload: { base: empty, value },
      });
      expect(saved.statusCode).toBe(200);
      expect(
        bridge.request.mock.calls.filter(([method]) => method !== "account/rateLimits/read"),
      ).toEqual([]);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects/project/threads",
        headers,
        payload: { clientCreationId: "shared-file", draft: value },
      });
      expect(created.statusCode).toBe(201);
      const draft = created.json().draft;
      expect(draft.files).toHaveLength(1);
      expect(draft.files[0].path).not.toBe(uploaded.json().path);
      expect(await readFile(draft.files[0].path, "utf8")).toBe("hello");
      const retry = await app.inject({
        method: "POST",
        url: "/api/v1/projects/project/threads",
        headers,
        payload: { clientCreationId: "shared-file", draft: value },
      });
      expect(retry.json().draft).toEqual(draft);
      const queued = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${created.json().thread.id}/queue`,
        headers,
        payload: {
          input: value.input,
          files: draft.files,
          clientMessageId: "shared-file-send",
          projectDraft: { projectId: "project", updatedAt: saved.json().updatedAt },
        },
      });
      expect(queued.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });
});

describe.each([1, 0])("reliable first messages (delivery version %s)", (deliveryVersion) => {
  it.each([false, true])(
    "restores an acknowledged start and its question without a start notification (interrupted=%s)",
    async (interrupted) => {
      const { app, bridge, headers, projection } = await createForkHarness(deliveryVersion);
      try {
        if (interrupted) {
          projection.upsertThread({
            ...testThread(),
            status: { type: "active", activeFlags: [] },
            turns: [testTurn("old-turn", "inProgress")],
          });
          expect(
            (
              await app.inject({
                method: "POST",
                url: "/api/v1/threads/thread/interrupt",
                headers,
                payload: { turnId: "old-turn" },
              })
            ).statusCode,
          ).toBe(204);
        }
        bridge.notifyTurnStarted = false;
        const request = bridge.request.getMockImplementation()!;
        bridge.request.mockImplementation(async (method, params) => {
          const result = await request(method, params);
          if (method === "thread/resume") {
            bridge.emit("request", dismissibleQuestion("new-question"), {
              respond: vi.fn(),
              respondError: vi.fn(),
            });
          }
          return result;
        });
        bridge.request.mockClear();
        const message = {
          method: "POST" as const,
          url: "/api/v1/threads/thread/turns",
          headers,
          payload: { input: "Continue with my instructions", clientMessageId: "missing-start" },
        };
        const delivered = await app.inject(message);
        expect(delivered.statusCode).toBe(201);
        expect(delivered.json()).toMatchObject({ turnId: "turn" });
        expect(
          bridge.request.mock.calls
            .map(([method]) => method)
            .filter((method) => method.startsWith("turn/") || method === "thread/resume"),
        ).toEqual(["turn/start", "thread/resume"]);
        expect(projection.summary("thread")).toMatchObject({
          currentTurnId: "turn",
          state: "needsAttention",
        });
        expect(projection.snapshot().attention).toEqual([
          expect.objectContaining({ turnId: "turn", itemId: "new-question" }),
        ]);
        expect((await app.inject(message)).statusCode).toBe(201);
        await projection.readThread("thread");
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "thread/resume"),
        ).toHaveLength(1);
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "turn/start"),
        ).toHaveLength(1);
      } finally {
        await app.close();
      }
    },
  );

  it("keeps an early completion terminal when the start acknowledgement and notification arrive later", async () => {
    const { app, bridge, headers, projection } = await createForkHarness(deliveryVersion);
    try {
      bridge.notifyTurnStarted = false;
      const request = bridge.request.getMockImplementation()!;
      bridge.request.mockImplementation(async (method, params) => {
        const result = await request(method, params);
        if (method === "turn/start") {
          bridge.emit("notification", {
            method: "turn/completed",
            params: { threadId: "thread", turn: testTurn("turn", "completed") },
          } satisfies ServerNotification);
          await vi.waitFor(() => expect(projection.summary("thread")?.state).toBe("completed"));
        }
        return result;
      });
      bridge.request.mockClear();
      const message = {
        method: "POST" as const,
        url: "/api/v1/threads/thread/turns",
        headers,
        payload: { input: "Finish quickly", clientMessageId: "early-completion" },
      };
      expect((await app.inject(message)).statusCode).toBe(201);
      bridge.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread", turn: testTurn("turn", "inProgress") },
      } satisfies ServerNotification);
      expect((await app.inject(message)).statusCode).toBe(201);
      expect(projection.summary("thread")).toMatchObject({
        state: "completed",
        currentTurnId: null,
      });
      expect(
        bridge.request.mock.calls
          .map(([method]) => method)
          .filter((method) => method.startsWith("turn/") || method === "thread/resume"),
      ).toEqual(["turn/start"]);
    } finally {
      await app.close();
    }
  });

  it("starts a follow-up after interrupting a question without restoring its form", async () => {
    const { app, bridge, headers, store, projection, attention } =
      await createForkHarness(deliveryVersion);
    try {
      await projection.setCurrentTurn("thread", "turn");
      const respond = vi.fn();
      const pending = attention.receive(dismissibleQuestion("question"), {
        respond,
      } as unknown as JsonlTransport);
      if (pending.kind !== "userInput") throw new Error("Expected question");
      await projection.updateUserInputDraft(pending, {
        answers: { choice: ["Unsent answer"] },
        currentQuestionId: "choice",
      });
      const stopped = await app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/interrupt",
        headers,
        payload: { turnId: "turn" },
      });
      expect(stopped.statusCode).toBe(204);
      expect(attention.get(pending.id)).toBeUndefined();

      const message = {
        method: "POST" as const,
        url: "/api/v1/threads/thread/queue",
        headers,
        payload: {
          input: "Use my new instructions",
          clientMessageId: "after-interruption",
          dismissUserInput: { turnId: "turn", itemId: "question" },
        },
      };
      expect((await app.inject(message)).statusCode).toBe(202);
      await vi.waitFor(() =>
        expect(store.view().messageReceipts?.["after-interruption"]?.turnId).toBeTruthy(),
      );
      expect((await app.inject(message)).statusCode).toBe(202);
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        1,
      );
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(
        0,
      );
      expect(projection.snapshot().attention).toEqual([]);
      expect(store.view().threadMeta.thread?.userInputDrafts).toBeUndefined();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([true, false])(
    "dismisses a question (blocking=%s) and delivers the new instruction once",
    async (isBlocking) => {
      const { app, bridge, headers, store, projection, attention } =
        await createForkHarness(deliveryVersion);
      try {
        await projection.setCurrentTurn("thread", "turn");
        const respond = vi.fn();
        const pending = attention.receive(dismissibleQuestion("question", isBlocking), {
          respond,
        } as unknown as JsonlTransport);
        if (pending.kind !== "userInput") throw new Error("Expected question");
        await projection.updateUserInputDraft(pending, {
          answers: { choice: ["Unsent answer"] },
          currentQuestionId: "choice",
        });
        const request = {
          method: "POST" as const,
          url: "/api/v1/threads/thread/queue",
          headers,
          payload: {
            input: "Use my new instructions",
            clientMessageId: "dismiss-question",
            dismissUserInput: { turnId: "turn", itemId: "question" },
          },
        };
        expect((await app.inject(request)).statusCode).toBe(202);
        await vi.waitFor(() =>
          expect(store.view().messageReceipts?.["dismiss-question"]?.turnId).toBe("turn"),
        );
        await vi.waitFor(() => expect(attention.get(pending.id)).toBeUndefined());
        expect(store.view().threadMeta.thread?.userInputDrafts ?? {}).toEqual({});
        expect(store.view().threadMeta.thread?.timelineArtifacts?.turn ?? []).not.toContainEqual(
          expect.objectContaining({ type: "userInputResponse" }),
        );
        expect((await app.inject(request)).statusCode).toBe(202);
        const steers = bridge.request.mock.calls.filter(([method]) => method === "turn/steer");
        expect(steers).toHaveLength(1);
        expect(steers[0]?.[1]).toMatchObject({
          input: [expect.objectContaining({ text: "Use my new instructions" })],
        });
        if (deliveryVersion === 1) {
          expect(steers[0]?.[1]).toHaveProperty("userInputResponse", {
            itemId: "question",
            response: { answers: {} },
          });
          expect(respond).not.toHaveBeenCalled();
        } else {
          expect(respond).toHaveBeenCalledExactlyOnceWith(901, { answers: {} });
        }
        expect(
          (
            await app.inject({
              ...request,
              payload: {
                ...request.payload,
                dismissUserInput: { turnId: "turn", itemId: "different" },
              },
            })
          ).statusCode,
        ).toBe(409);
      } finally {
        await app.close();
      }
    },
  );

  it("leaves a newer question open when a delayed dismissal arrives", async () => {
    const { app, bridge, headers, store, projection, attention } =
      await createForkHarness(deliveryVersion);
    try {
      await projection.setCurrentTurn("thread", "turn");
      const respond = vi.fn();
      const newer = attention.receive(dismissibleQuestion("new-question"), {
        respond,
      } as unknown as JsonlTransport);
      const payload = {
        input: "Delayed voice transcript",
        clientMessageId: "delayed-voice",
        dismissUserInput: { turnId: "old-turn", itemId: "old-question" },
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/threads/thread/queue",
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(202);
      await vi.waitFor(() =>
        expect(store.view().messageReceipts?.["delayed-voice"]?.turnId).toBe("turn"),
      );
      expect(attention.get(newer.id)).toBeDefined();
      expect(respond).not.toHaveBeenCalled();
      const steer = bridge.request.mock.calls.find(([method]) => method === "turn/steer");
      expect(steer?.[1]).not.toHaveProperty("userInputResponse");
      for (const invalid of [
        null,
        {},
        { turnId: "turn", itemId: 5 },
        { turnId: "turn", itemId: "question", extra: true },
      ]) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/v1/threads/thread/queue",
              headers,
              payload: { ...payload, dismissUserInput: invalid },
            })
          ).statusCode,
        ).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it("keeps the question and its draft after a rejected dismissal", async () => {
    const { app, bridge, headers, store, projection, attention } =
      await createForkHarness(deliveryVersion);
    try {
      await projection.setCurrentTurn("thread", "turn");
      const respond = vi.fn();
      const pending = attention.receive(dismissibleQuestion("question"), {
        respond,
      } as unknown as JsonlTransport);
      if (pending.kind !== "userInput") throw new Error("Expected question");
      await projection.updateUserInputDraft(pending, {
        answers: { choice: ["Keep this draft"] },
        currentQuestionId: "choice",
      });
      const original = bridge.request.getMockImplementation()!;
      bridge.request.mockImplementation(async (method, params) => {
        if (method === "turn/steer") throw new RpcError(-32602, "Rejected before delivery");
        return original(method, params);
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/queue",
        headers,
        payload: {
          input: "New instructions",
          clientMessageId: "rejected-dismissal",
          dismissUserInput: { turnId: "turn", itemId: "question" },
        },
      });
      await vi.waitFor(() =>
        expect(store.view().messageQueues?.thread?.[0]?.deliveryError).toBeDefined(),
      );
      expect(attention.get(pending.id)).toBeDefined();
      expect(respond).not.toHaveBeenCalled();
      expect(Object.values(store.view().threadMeta.thread?.userInputDrafts ?? {})).toContainEqual(
        expect.objectContaining({ answers: { choice: ["Keep this draft"] } }),
      );
    } finally {
      await app.close();
    }
  });

  it("creates a session once, persists it, and steers an active turn", async () => {
    const { app, bridge, headers, store } = await createForkHarness(deliveryVersion);
    try {
      const request = {
        method: "POST" as const,
        url: "/api/v1/projects/project/threads",
        headers,
        payload: { clientCreationId: "same-creation" },
      };
      const first = await app.inject(request);
      expect(first.statusCode).toBe(201);
      const id = first.json().thread.id;
      expect((await app.inject(request)).json().thread.id).toBe(id);
      expect(
        bridge.request.mock.calls.filter(([method]) => method === "thread/start"),
      ).toHaveLength(1);
      expect(
        bridge.request.mock.calls.filter(([method]) => method === "thread/metadata/update"),
      ).toHaveLength(deliveryVersion === 1 ? 0 : 1);
      expect(
        bridge.request.mock.calls.filter(
          ([method, params]) =>
            method === "thread/read" && params.threadId === id && params.includeTurns === true,
        ),
      ).toHaveLength(deliveryVersion === 1 ? 0 : 1);
      const send = (clientMessageId: string) =>
        app.inject({
          method: "POST",
          url: `/api/v1/threads/${id}/queue`,
          headers,
          payload: { input: clientMessageId, clientMessageId },
        });
      await send("first");
      await vi.waitFor(() => expect(store.view().messageReceipts?.first?.turnId).toBeTruthy());
      expect(
        bridge.request.mock.calls
          .filter(
            ([method, params]) =>
              ["turn/start", "thread/resume", "thread/turns/list"].includes(method) &&
              params.threadId === id,
          )
          .map(([method]) => method),
      ).toEqual(["turn/start"]);
      await send("steer");
      const result = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${id}/queue/steer/send`,
        headers,
      });
      expect(result.statusCode).toBe(200);
      expect(store.view().messageReceipts?.steer?.turnId).toBe(
        store.view().messageReceipts?.first?.turnId,
      );
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(
        1,
      );
      const detail = (await app.inject({ url: `/api/v1/threads/${id}`, headers })).json();
      expect(detail.turns.flatMap((turn: { items: unknown[] }) => turn.items)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "first",
            deliveryReceipt: {
              version: deliveryVersion,
              clientId: "first",
              threadId: id,
              turnId: store.view().messageReceipts?.first?.turnId,
            },
          }),
          expect.objectContaining({
            id: "steer",
            deliveryReceipt: {
              version: deliveryVersion,
              clientId: "steer",
              threadId: id,
              turnId: store.view().messageReceipts?.steer?.turnId,
            },
          }),
        ]),
      );
    } finally {
      await app.close();
    }
  });

  it("answers a blocking question through the receiver's supported protocol", async () => {
    const { app, bridge, headers, store, projection, attention } =
      await createForkHarness(deliveryVersion);
    try {
      await projection.setCurrentTurn("thread", "turn");
      const respond = vi.fn();
      const pending = attention.receive(
        {
          method: "item/tool/requestUserInput",
          id: 901,
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "question",
            autoResolutionMs: null,
            questions: [
              {
                id: "choice",
                header: "Choice",
                question: "Which?",
                isOther: true,
                isSecret: false,
                options: null,
              },
            ],
          },
        } as ServerRequest,
        { respond, respondError: vi.fn() } as unknown as JsonlTransport,
      );
      const request = {
        method: "POST" as const,
        url: "/api/v1/threads/thread/queue",
        headers,
        payload: {
          input: "First",
          clientMessageId: "answer",
          replyToUserInput: { turnId: "turn", itemId: "question", answers: { choice: ["First"] } },
        },
      };
      expect((await app.inject(request)).statusCode).toBe(202);
      await vi.waitFor(() => expect(store.view().messageReceipts?.answer?.turnId).toBe("turn"));
      expect(attention.get(pending.id)).toBeUndefined();
      await app.inject(request);
      if (deliveryVersion === 1) {
        expect(respond).not.toHaveBeenCalled();
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "turn/steer"),
        ).toHaveLength(1);
      } else {
        expect(respond).toHaveBeenCalledExactlyOnceWith(901, {
          answers: { choice: { answers: ["First"] } },
        });
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "turn/steer"),
        ).toHaveLength(0);
      }
    } finally {
      await app.close();
    }
  });

  it.each(["thread not loaded", "thread not found: created"])(
    "resumes a new session after %s and retries the same message id",
    async (errorMessage) => {
      const { app, bridge, headers, store } = await createForkHarness(deliveryVersion);
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects/project/threads",
          payload: { clientCreationId: "test-creation" },
          headers,
        });
        expect(created.statusCode).toBe(201);
        const id = created.json().thread.id as string;
        const original = bridge.request.getMockImplementation()!;
        let unloaded = true;
        bridge.request.mockImplementation(async (method, params = {}) => {
          if (method === "turn/start" && params.threadId === id && unloaded) {
            throw new RpcError(-32600, errorMessage);
          }
          if (method === "thread/resume" && params.threadId === id) unloaded = false;
          return original(method, params);
        });
        const body = { input: "Первое после перезапуска", clientMessageId: "first-id" };
        const accepted = await app.inject({
          method: "POST",
          url: `/api/v1/threads/${id}/queue`,
          headers,
          payload: body,
        });
        expect(accepted.statusCode).toBe(202);
        await vi.waitFor(() =>
          expect(store.snapshot().messageReceipts?.[body.clientMessageId]?.turnId).toBeTruthy(),
        );
        const starts = bridge.request.mock.calls.filter(
          ([method, params]) => method === "turn/start" && params?.threadId === id,
        );
        expect(starts).toHaveLength(2);
        expect(
          starts.every(([, params]) => params?.clientUserMessageId === body.clientMessageId),
        ).toBe(true);
        expect(
          bridge.request.mock.calls.filter(
            ([method, params]) => method === "thread/resume" && params?.threadId === id,
          ),
        ).toHaveLength(1);
        expect(bridge.threadTurns.get(id)).toHaveLength(1);
        await app.inject({
          method: "POST",
          url: `/api/v1/threads/${id}/queue`,
          headers,
          payload: body,
        });
        expect(bridge.threadTurns.get(id)).toHaveLength(1);
      } finally {
        await app.close();
      }
    },
  );

  it("sends blocked persisted messages with attachments in order after restoring the session", async () => {
    const { app, bridge, headers, store, projection } = await createForkHarness(deliveryVersion);
    try {
      const image = "data:image/png;base64,aW1hZ2U=";
      await store.update((state) => {
        state.messageQueues = {
          thread: [
            {
              id: "blocked-first",
              threadId: "thread",
              text: "Обсудим эти изображения",
              images: [image],
              createdAt: 1,
              status: "queued",
              deliveryVersion: 1,
              deliveryError: {
                message: "Сессия недоступна. Сообщение сохранено.",
                retryable: false,
              },
            },
            {
              id: "blocked-second",
              threadId: "thread",
              text: "Давай обсудим это",
              createdAt: 2,
              status: "queued",
              deliveryVersion: 1,
            },
          ],
        };
      });
      const reopened = new StateStore(store.path);
      await reopened.load();
      expect(reopened.view().messageQueues?.thread).toEqual(store.view().messageQueues?.thread);
      const original = bridge.request.getMockImplementation()!;
      let unloaded = true;
      const commands: string[] = [];
      bridge.request.mockImplementation(async (method, params = {}) => {
        if (params.threadId === "thread" && ["turn/start", "thread/resume"].includes(method)) {
          commands.push(method);
          if (method === "turn/start" && unloaded)
            throw new RpcError(-32600, "thread not found: thread");
          if (method === "thread/resume") unloaded = false;
        }
        return original(method, params);
      });
      const sent = await app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/queue/blocked-first/send",
        headers,
      });
      expect(sent.statusCode).toBe(200);
      expect(commands).toEqual(["turn/start", "thread/resume", "turn/start"]);
      expect(store.view().messageQueues?.thread).toMatchObject([{ id: "blocked-second" }]);
      const first = bridge.threadTurns.get("thread")!.at(-1)!;
      expect(first.items).toMatchObject([
        {
          type: "userMessage",
          clientId: "blocked-first",
          content: [
            { type: "text", text: "Обсудим эти изображения" },
            { type: "image", url: image },
          ],
        },
      ]);
      const starts = bridge.request.mock.calls.filter(
        ([method, params]) => method === "turn/start" && params.threadId === "thread",
      );
      expect(starts[0]?.[1]).toEqual(starts[1]?.[1]);
      expect(starts[1]?.[1]).toMatchObject({
        clientUserMessageId: "blocked-first",
        model: "gpt-b",
      });
      first.status = "completed";
      bridge.emit("notification", {
        method: "turn/completed",
        params: { threadId: "thread", turn: first },
      } satisfies ServerNotification);
      await vi.waitFor(() => expect(store.view().messageQueues?.thread).toBeUndefined());
      expect(
        bridge.threadTurns
          .get("thread")!
          .flatMap((turn) =>
            turn.items.filter((item) => item.type === "userMessage").map((item) => item.clientId),
          ),
      ).toEqual(["blocked-first", "blocked-second"]);
      expect(commands).toEqual(["turn/start", "thread/resume", "turn/start", "turn/start"]);
      expect(projection.summary("thread")).toBeDefined();
      for (const id of ["blocked-first", "blocked-second"]) {
        expect(store.view().messageReceipts?.[id]?.status).toBe("delivered");
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/v1/threads/thread/queue/${id}/send`,
              headers,
            })
          ).statusCode,
        ).toBe(200);
      }
      expect(commands).toHaveLength(4);
    } finally {
      await app.close();
    }
  });

  it.each([false, true])(
    "recovers an accepted message after a lost response without duplicates (unloaded: %s)",
    async (unloadAfterAcceptance) => {
      const { app, bridge, headers, store, projection } = await createForkHarness(deliveryVersion);
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects/project/threads",
          payload: { clientCreationId: "test-creation" },
          headers,
        });
        const id = created.json().thread.id as string;
        const original = bridge.request.getMockImplementation()!;
        let loseReply = true;
        let unloaded = false;
        bridge.request.mockImplementation(async (method, params = {}) => {
          if (params.threadId === id) {
            if (unloaded && ["turn/start", "thread/turns/list"].includes(method))
              throw new RpcError(-32600, `thread not found: ${id}`);
            if (method === "thread/resume") unloaded = false;
          }
          if (method === "turn/start" && params.threadId === id && loseReply) {
            loseReply = false;
            await original(method, params);
            unloaded = unloadAfterAcceptance;
            throw new Error("Response lost after acceptance");
          }
          if (method === "thread/turns/list" && params.threadId === id && !params.cursor) {
            return { data: [], nextCursor: "accepted-page", backwardsCursor: null };
          }
          return original(method, params);
        });
        const payload = { input: "Принято без ответа", clientMessageId: "lost-response-id" };
        const accepted = await app.inject({
          method: "POST",
          url: `/api/v1/threads/${id}/queue`,
          headers,
          payload,
        });
        expect(accepted.statusCode).toBe(202);
        await vi.waitFor(() =>
          expect(store.snapshot().messageReceipts?.[payload.clientMessageId]?.status).toBe(
            "delivered",
          ),
        );
        expect(projection.isUnmaterialized(id)).toBe(false);
        const detail = await projection.readThread(id);
        expect(detail.turns.flatMap((turn) => turn.items)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "userMessage", text: payload.input }),
          ]),
        );
        expect(bridge.threadTurns.get(id)).toHaveLength(1);
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "turn/start"),
        ).toHaveLength(deliveryVersion === 1 ? (unloadAfterAcceptance ? 3 : 2) : 1);
        expect(
          bridge.request.mock.calls.filter(
            ([method, params]) => method === "thread/resume" && params.threadId === id,
          ),
        ).toHaveLength(unloadAfterAcceptance ? 1 : 0);
        const attempts = bridge.request.mock.calls.filter(([method]) => method === "turn/start");
        for (const attempt of attempts) expect(attempt[1]).toEqual(attempts[0]?.[1]);
      } finally {
        await app.close();
      }
    },
  );

  it.each(["no rollout found for thread id thread", "thread not found: thread"])(
    "preserves messages and attachments when session history is missing after %s",
    async (errorMessage) => {
      const { app, bridge, headers, store, projection } = await createForkHarness(deliveryVersion);
      try {
        const upload = await app.inject({
          method: "POST",
          url: "/api/v1/threads/thread/attachments?name=notes.txt&mediaType=text%2Fplain",
          headers: { ...headers, "content-type": "application/octet-stream" },
          payload: Buffer.from("Keep this file"),
        });
        expect(upload.statusCode).toBe(201);
        const file = upload.json();
        const original = bridge.request.getMockImplementation()!;
        bridge.request.mockClear();
        bridge.request.mockImplementation(async (method, params = {}) => {
          if (
            ["turn/start", "thread/resume", "thread/turns/list"].includes(method) &&
            params.threadId === "thread"
          ) {
            throw new RpcError(
              -32600,
              method === "turn/start" ? errorMessage : "no rollout found for thread id thread",
            );
          }
          return original(method, params);
        });
        const accepted = await app.inject({
          method: "POST",
          url: "/api/v1/threads/thread/queue",
          headers,
          payload: { input: "Сохранить при сбое", files: [file], clientMessageId: "keep-id" },
        });
        expect(accepted.statusCode).toBe(202);
        await vi.waitFor(() =>
          expect(store.snapshot().messageQueues?.thread?.[0]?.deliveryError?.retryable).toBe(false),
        );
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "turn/start"),
        ).toHaveLength(1);
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "thread/resume"),
        ).toHaveLength(errorMessage === "thread not found: thread" ? 1 : 0);
        await projection.removeOrphanedThread("thread");
        expect(projection.summary("thread")).toBeDefined();
        await projection.invalidateHistory("thread");
        const detail = await app.inject({ url: "/api/v1/threads/thread", headers });
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toMatchObject({
          historyError: { retryable: false },
          queuedMessages: [{ id: "keep-id", text: "Сохранить при сбое", files: [file] }],
        });
        await expect(readFile(file.path, "utf8")).resolves.toBe("Keep this file");
      } finally {
        await app.close();
      }
    },
  );
});

describe.each([1, 0])("missing first-session recovery (delivery version %s)", (deliveryVersion) => {
  it.skipIf(deliveryVersion !== 0)(
    "recovers a stalled first message only on explicit retry without losing pasted text or photos",
    async () => {
      const { app, bridge, headers, store } = await createForkHarness(deliveryVersion);
      try {
        await app.inject({
          method: "POST",
          url: "/api/v1/projects/project/threads",
          headers,
          payload: { clientCreationId: "original" },
        });
        const images = [
          "data:image/png;base64,AA==",
          "data:image/png;base64,AQ==",
          "data:image/png;base64,Ag==",
        ];
        const pasteBlocks = [{ id: "paste", text: "Полный исходный текст" }];
        const hash = messageContentHash("", images, [], false, undefined, undefined, {
          pasteBlocks,
        });
        await store.update((state) => {
          state.messageQueues ??= {};
          state.messageQueues.created = [
            {
              id: "stalled",
              threadId: "created",
              text: "",
              images,
              pasteBlocks,
              createdAt: 1,
              status: "dispatching",
              deliveryError: {
                message: "Проверяем, было ли сообщение отправлено.",
                retryable: false,
              },
            },
          ];
          state.messageReceipts ??= {};
          state.messageReceipts.stalled = {
            threadId: "created",
            turnId: null,
            contentHash: hash,
            createdAt: 1,
            status: "prepared",
            request: {
              method: "turn/start",
              params: { threadId: "created", clientUserMessageId: "stalled", input: [] },
            },
          };
        });
        const original = bridge.request.getMockImplementation()!;
        bridge.request.mockImplementation(async (method, params = {}) => {
          if (
            ["thread/turns/list", "thread/resume"].includes(method) &&
            params.threadId === "created"
          ) {
            throw new RpcError(
              -32600,
              "invalid paginated history lineage for created: missing source rollout",
            );
          }
          return original(method, params);
        });
        const retry = (explicit = false) =>
          app.inject({
            method: "POST",
            url: "/api/v1/threads/created/queue/stalled/send",
            headers,
            ...(explicit ? { payload: { retryUnconfirmed: true } } : {}),
          });
        expect((await retry()).statusCode).toBe(409);
        expect(store.view().messageReceipts?.stalled?.status).toBe("prepared");
        bridge.nextCreatedThreadId = "replacement";
        const responses = await Promise.all([retry(true), retry(true)]);
        for (const response of responses) {
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json()).toMatchObject({
            thread: { id: "replacement" },
            turnId: "turn-replacement",
          });
        }
        const started = bridge.request.mock.calls.filter(([method]) => method === "turn/start");
        expect(started).toHaveLength(1);
        expect(started[0]![1]).toMatchObject({
          threadId: "replacement",
          clientUserMessageId: "stalled",
          input: expect.arrayContaining(images.map((url) => ({ type: "image", url }))),
        });
        expect(JSON.stringify(started[0]![1].input)).toContain("Полный исходный текст");
        expect(store.view().messageQueues?.created).toEqual([]);
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "thread/start"),
        ).toHaveLength(2);
      } finally {
        await app.close();
      }
    },
  );

  it("moves the preserved first message and its attachment once when explicitly retried", async () => {
    const { app, bridge, headers, store, projection } = await createForkHarness(deliveryVersion);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects/project/threads",
        headers,
        payload: { clientCreationId: "original" },
      });
      expect(created.statusCode).toBe(201);
      const upload = await app.inject({
        method: "POST",
        url: "/api/v1/threads/created/attachments?name=notes.txt&mediaType=text%2Fplain",
        headers: { ...headers, "content-type": "application/octet-stream" },
        payload: Buffer.from("Saved file"),
      });
      const file = upload.json();
      const original = bridge.request.getMockImplementation()!;
      bridge.request.mockImplementation(async (method, params = {}) => {
        if (
          ["turn/start", "thread/resume", "thread/turns/list"].includes(method) &&
          params.threadId === "created"
        ) {
          throw new RpcError(-32602, "no rollout found for thread id created", {
            delivery: "rejected",
          });
        }
        return original(method, params);
      });
      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/threads/created/queue",
        headers,
        payload: {
          input: "Первое сообщение",
          images: ["data:image/png;base64,AA=="],
          files: [file],
          clientMessageId: "saved-first",
        },
      });
      expect(accepted.statusCode).toBe(202);
      await vi.waitFor(() =>
        expect(store.snapshot().messageQueues?.created?.[0]?.deliveryError?.retryable).toBe(false),
      );
      await projection.setDraft("created", {
        input: "Следующий черновик",
        images: [],
        annotations: [],
        goalMode: false,
      });
      const fastDefaults = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/task-defaults",
        headers,
        payload: { model: "gpt-a", serviceTier: "fast" },
      });
      expect(fastDefaults.statusCode).toBe(200);
      bridge.nextCreatedThreadId = "replacement";
      const retry = () =>
        app.inject({
          method: "POST",
          url: "/api/v1/threads/created/queue/saved-first/send",
          headers,
        });
      const response = await retry();
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        thread: { id: "replacement" },
        turnId: "turn-replacement",
      });
      expect(response.json().thread.settings).not.toHaveProperty("serviceTier");
      expect(
        bridge.request.mock.calls.findLast(([method]) => method === "thread/start")?.[1],
      ).toMatchObject({ serviceTier: "fast" });
      expect(store.snapshot().messageQueues?.created).toEqual([]);
      expect(store.snapshot().threadMeta.replacement?.draft?.input).toBe("Следующий черновик");
      const started = bridge.request.mock.calls.find(
        ([method, params]) => method === "turn/start" && params.threadId === "replacement",
      );
      expect(started?.[1]).toMatchObject({ serviceTier: null });
      expect(started?.[1].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "image", url: "data:image/png;base64,AA==" }),
        ]),
      );
      const deliveredFile = (started?.[1].input as Array<{ type: string; path?: string }>).find(
        (item) => item.type === "mention",
      );
      expect(deliveredFile?.path).not.toBe(file.path);
      await expect(readFile(deliveredFile!.path, "utf8")).resolves.toBe("Saved file");
      expect((await retry()).statusCode).toBe(200);
      expect(bridge.threadTurns.get("replacement")).toHaveLength(1);
      expect(
        bridge.request.mock.calls.filter(([method]) => method === "thread/start"),
      ).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
  it.each(["history", "ambiguous"])(
    "keeps %s sessions intact instead of copying their messages",
    async (kind) => {
      const { app, bridge, headers, store, projection } = await createForkHarness(deliveryVersion);
      try {
        await app.inject({
          method: "POST",
          url: "/api/v1/projects/project/threads",
          headers,
          payload: { clientCreationId: "old" },
        });
        if (kind === "history")
          projection.upsertThread({
            ...testThread("created"),
            turns: [testTurn("past", "completed")],
          });
        await store.update((state) => {
          state.messageQueues ??= {};
          state.messageQueues.created = [
            {
              id: "blocked",
              threadId: "created",
              text: "Saved",
              createdAt: 1,
              status: "queued",
              deliveryError: {
                message: "Сессия недоступна. Сообщение сохранено.",
                retryable: false,
              },
            },
          ];
          if (kind === "ambiguous") {
            state.messageReceipts ??= {};
            state.messageReceipts.blocked = {
              threadId: "created",
              turnId: null,
              contentHash: "0".repeat(64),
              status: "prepared",
              createdAt: 1,
            };
          }
        });
        const original = bridge.request.getMockImplementation()!;
        bridge.request.mockImplementation(async (method, params = {}) => {
          if (
            ["turn/start", "thread/turns/list", "thread/resume"].includes(method) &&
            params.threadId === "created"
          )
            throw new RpcError(-32600, "no rollout found for thread id created");
          return original(method, params);
        });
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/threads/created/queue/blocked/send",
          headers,
        });
        expect(response.statusCode).not.toBe(200);
        expect(store.snapshot().messageQueues?.created?.[0]?.id).toBe("blocked");
        expect(
          bridge.request.mock.calls.filter(([method]) => method === "thread/start"),
        ).toHaveLength(1);
      } finally {
        await app.close();
      }
    },
  );
});

describe("completion recovery", () => {
  it("releases a queued message exactly once after history confirms a missed completion", async () => {
    const { app, bridge, projection, store, headers } = await createTeamHarness();
    try {
      await projection.setSettings("thread", { collaborationMode: "default" });
      bridge.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread", turn: testTurn("finished", "inProgress") },
      } satisfies ServerNotification);
      await vi.waitFor(() => expect(projection.summary("thread")?.currentTurnId).toBe("finished"));
      const queued = await app.inject({
        method: "POST",
        url: "/api/v1/threads/thread/queue",
        headers,
        payload: { input: "Next request", clientMessageId: "after-missed-completion" },
      });
      expect(queued.statusCode).toBe(202);
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        0,
      );
      bridge.threadTurns.set("thread", [
        {
          ...testTurn("finished", "completed"),
          itemsView: "full",
          items: [agentMessage("final", "Finished")],
        },
      ]);

      const detail = await app.inject({ url: "/api/v1/threads/thread", headers });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().turns).toContainEqual(
        expect.objectContaining({ id: "finished", status: "completed" }),
      );
      await vi.waitFor(() =>
        expect(store.view().messageReceipts?.["after-missed-completion"]).toMatchObject({
          status: "delivered",
          turnId: "turn",
        }),
      );
      expect(store.view().messageQueues?.thread).toBeUndefined();

      await app.inject({ url: "/api/v1/threads/thread", headers });
      expect(bridge.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        1,
      );
      expect(projection.summary("thread")).toMatchObject({
        state: "running",
        currentTurnId: "turn",
      });
    } finally {
      await app.close();
    }
  });
});

describe("file attachments", () => {
  it("uploads, persists, dispatches, and downloads a file attachment", async () => {
    const repository = await createApiTestRepository();
    const { app, bridge, headers } = await createTeamHarness({ projectPath: repository });
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/attachments?name=notes.txt&mediaType=text%2Fplain",
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: Buffer.from("attachment contents"),
    });
    expect(uploaded.statusCode).toBe(201);
    const file = uploaded.json();
    expect(file).toMatchObject({ name: "notes.txt", size: 19, mediaType: "text/plain" });
    await expect(readFile(file.path, "utf8")).resolves.toBe("attachment contents");

    const draft = await app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread/draft",
      headers,
      payload: { input: "", images: [], files: [file], goalMode: false, annotations: [] },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().files).toEqual([file]);

    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: { input: "", files: [file], clientMessageId: "file-message" },
    });
    expect(queued.statusCode).toBe(202);
    await vi.waitFor(() => {
      const start = bridge.request.mock.calls.find(([method]) => method === "turn/start");
      expect(start?.[1]).toMatchObject({
        input: [
          { type: "text", text: expect.stringContaining(file.path) },
          { type: "mention", name: "notes.txt", path: file.path },
        ],
      });
    });

    const ticket = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/downloads",
      headers,
      payload: { path: file.path },
    });
    expect(ticket.statusCode).toBe(201);
    const download = await app.inject({ url: ticket.json().downloadUrl });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("attachment contents");
    await app.close();
  });

  it("rejects forged cross-session attachment metadata", async () => {
    const repository = await createApiTestRepository();
    const { app, headers } = await createTeamHarness({ projectPath: repository });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread/queue",
      headers,
      payload: {
        clientMessageId: "direct-test-279098",
        input: "",
        files: [
          {
            id: "00000000-0000-0000-0000-000000000000",
            name: "secret.txt",
            path: join(repository, "secret.txt"),
            size: 1,
            mediaType: "text/plain",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("does not belong to this session");
    await app.close();
  });
});

async function restartForkApp(
  store: StateStore,
  bridge: SettingsBridge,
  threadTitles: ThreadTitleGenerator,
) {
  const attention = new AttentionManager();
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  await projection.sync();
  const app = await buildApp(
    loadConfig({
      statePath: store.path,
      clientDist: join(dirname(store.path), "missing"),
      allowedOrigins: new Set(["http://localhost"]),
    }),
    {
      bridge: bridge as unknown as CodexBridge,
      store,
      projection,
      attention,
      threadTitles,
    },
  );
  return { app, projection };
}

function completedForkTurn(): Turn {
  return {
    ...testTurn("selected-turn", "completed"),
    itemsView: "full",
    items: [agentMessage("selected-answer", "Готовый ответ")],
  };
}

async function writeSafeForkRollout(path: string): Promise<void> {
  await writeFile(
    path,
    [
      JSON.stringify({
        type: "compacted",
        payload: {
          message: "",
          replacement_history: [{ type: "message", id: "summary", role: "user", content: [] }],
        },
      }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "selected-turn" } }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", id: "answer-item", role: "assistant", content: [] },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "selected-turn" },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
}

async function flushImmediates(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function forkRequests(bridge: SettingsBridge, operationId: string) {
  return bridge.request.mock.calls.filter(
    ([method, params]) =>
      method === "thread/fork" &&
      (params as Record<string, unknown>).threadSource === `codexnest-fork:${operationId}`,
  );
}

function injectRequests(bridge: SettingsBridge) {
  return bridge.request.mock.calls.filter(([method]) => method === "thread/inject_items");
}

async function createTeamHarness(
  options: { lifecycle?: boolean; projectPath?: string; includeManagedModel?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-team-api-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.auth.tokenSha256 = hashToken("correct");
    state.projects.push({
      id: "project",
      displayName: "Project",
      path: options.projectPath ?? "/work",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
  });
  const bridge = new SettingsBridge();
  bridge.includeManagedModel = options.includeManagedModel ?? true;
  const attention = new AttentionManager();
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  await projection.sync();
  if (options.projectPath) {
    projection.upsertThread({ ...testThread(), cwd: options.projectPath });
  }
  await projection.setSettings("thread", {
    collaborationMode: "team",
    model: "gpt-a",
    reasoningEffort: "high",
  });
  await store.update((state) => {
    const meta = state.threadMeta.thread ?? { pinned: false, lastReadUpdatedAt: 0 };
    meta.managedTeamToolsAvailable = true;
    state.threadMeta.thread = meta;
  });
  const config = loadConfig({
    statePath: store.path,
    clientDist: join(directory, "missing"),
    allowedOrigins: new Set(["http://localhost"]),
    websocketAuthTimeoutMs: 25,
  });
  const lifecycle = options.lifecycle
    ? new RuntimeLifecycle({
        transport: "daemon",
        tokenPath: join(directory, "restart-token"),
        bridgeReady: () => true,
        checkpoint: () => store.checkpoint(),
      })
    : undefined;
  await lifecycle?.initialize();
  const app = await buildApp(config, {
    bridge: bridge as unknown as CodexBridge,
    store,
    projection,
    attention,
    projectRoot: directory,
    lifecycle,
  });
  return {
    app,
    bridge,
    headers: { authorization: "Bearer correct" },
    projection,
    store,
    lifecycle,
  };
}

async function createApiTestRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-team-api-repository-"));
  directories.push(directory);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["-C", directory, "init", "--quiet"]);
  await execFileAsync("git", ["-C", directory, "add", "."]);
  await execFileAsync("git", [
    "-C",
    directory,
    "-c",
    "user.name=CodexNest Test",
    "-c",
    "user.email=test@codexnest.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  return directory;
}

type TestDynamicToolResponse = {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
};

async function callTeamTool(
  bridge: SettingsBridge,
  threadId: string,
  tool: string,
  args: Record<string, unknown>,
  requestId = `tool-${Math.random()}`,
  turnId = `turn-${threadId}`,
): Promise<TestDynamicToolResponse> {
  return new Promise((resolve, reject) => {
    bridge.emit(
      "request",
      {
        method: "item/tool/call",
        id: requestId,
        params: {
          threadId,
          turnId,
          callId: requestId,
          namespace: "codexnest",
          tool,
          arguments: args,
        },
      },
      {
        respond(id: string, result: TestDynamicToolResponse) {
          if (id !== requestId) {
            reject(new Error("Unexpected dynamic tool response id"));
            return;
          }
          resolve(result);
        },
        respondError(_id: string, _code: number, message: string) {
          reject(new Error(message));
        },
      },
    );
  });
}

function dynamicToolJson(response: TestDynamicToolResponse): Record<string, unknown> {
  const text = response.contentItems.find((item) => item.type === "inputText")?.text;
  if (!text) throw new Error("Dynamic tool response has no text");
  return JSON.parse(text) as Record<string, unknown>;
}

function websocketFrames(socket: WebSocket) {
  const queued: Array<Record<string, unknown>> = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queued.push(frame);
  });
  const next = (): Promise<Record<string, unknown>> => {
    const frame = queued.shift();
    return frame ? Promise.resolve(frame) : new Promise((resolve) => waiters.push(resolve));
  };
  return {
    async nextType(type: string): Promise<Record<string, unknown>> {
      for (;;) {
        const frame = await next();
        if (frame.type === type) return frame;
      }
    },
  };
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function browserTabSummary() {
  return {
    id: 1,
    windowId: 1,
    groupId: -1,
    active: true,
    title: "Tab",
    url: "https://example.com",
  };
}

function testModel(
  id: string,
  effort: string,
  supportsPersonality: boolean,
  serviceTiers: Array<{ id: string; name: string }>,
) {
  return {
    id,
    model: id,
    displayName: id,
    description: "",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: effort, description: "" }],
    defaultReasoningEffort: effort,
    inputModalities: ["text"],
    supportsPersonality,
    additionalSpeedTiers: [],
    serviceTiers,
    defaultServiceTier: null,
    isDefault: id === "gpt-a",
  };
}

function testThread(id = "thread"): Thread {
  return {
    id,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: id === "created" ? "" : "Thread",
    ephemeral: false,
    historyMode: "full",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "notLoaded" },
    path: null,
    cwd: "/work",
    cliVersion: "0.144.6",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function testTurn(id: string, status: Turn["status"]): Turn {
  return {
    id,
    items: [],
    itemsView: "summary",
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function agentMessage(id: string, text: string): ThreadItem {
  return { type: "agentMessage", id, text, phase: null, memoryCitation: null };
}
