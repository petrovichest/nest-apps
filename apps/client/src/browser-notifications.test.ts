import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, AttentionRequest, ThreadSummary } from "@codexnest/protocol";

import {
  BrowserNotificationTracker,
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
} from "./browser-notifications";

const notifications: MockNotification[] = [];

class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>();
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    notifications.push(this);
  }
}

beforeEach(() => {
  notifications.length = 0;
  MockNotification.permission = "granted";
  MockNotification.requestPermission.mockReset();
  vi.stubGlobal("Notification", MockNotification);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BrowserNotificationTracker", () => {
  it.each([
    { capacityRetry: { failedTurnId: "failed", nextAttemptAt: 300_000 } },
    { currentTurnId: "active-turn" },
    { queuedMessageCount: 1 },
  ])("only notifies a failed task after automatic work stops: %j", (recovery) => {
    const tracker = new BrowserNotificationTracker();
    tracker.acceptSnapshot(snapshot([thread("running", 10)]));
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...thread("failed", 20), ...recovery },
    });
    tracker.acceptSnapshot(snapshot([{ ...thread("failed", 30), unread: true, ...recovery }]));
    expect(notifications).toHaveLength(0);
    tracker.acceptEvent({ type: "thread.upserted", thread: thread("failed", 40) });
    tracker.acceptEvent({ type: "thread.upserted", thread: thread("failed", 41) });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Задача завершилась с ошибкой");
  });

  it("does not announce completion during a retry and still announces eventual success", () => {
    const tracker = new BrowserNotificationTracker();
    tracker.acceptSnapshot(snapshot([thread("running", 10)]));
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: {
        ...thread("completed", 20),
        capacityRetry: { failedTurnId: "failed", nextAttemptAt: 300_000 },
      },
    });
    expect(notifications).toHaveLength(0);
    tracker.acceptEvent({ type: "thread.upserted", thread: thread("completed", 30) });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Задача завершена");
  });

  it("stays silent during capacity retries, including reconnect, and notifies eventual completion", () => {
    const tracker = new BrowserNotificationTracker();
    const running = thread("running", 10);
    tracker.acceptSnapshot(snapshot([running]));
    const waiting = {
      ...running,
      updatedAt: 20,
      unread: true,
      capacityRetry: { failedTurnId: "failed", nextAttemptAt: 300_000 },
    };
    tracker.acceptEvent({ type: "thread.upserted", thread: waiting });
    tracker.acceptSnapshot(snapshot([{ ...waiting, updatedAt: 30 }]));
    tracker.acceptEvent({ type: "thread.upserted", thread: { ...running, updatedAt: 40 } });
    expect(notifications).toHaveLength(0);
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "completed", currentTurnId: null, updatedAt: 50 },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Задача завершена");
  });

  it("uses the initial snapshot as a baseline and notifies terminal state changes", () => {
    const tracker = new BrowserNotificationTracker();
    const running = thread("running", 10);
    tracker.acceptSnapshot(snapshot([running]));

    expect(notifications).toHaveLength(0);

    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "completed", currentTurnId: null, unread: true, updatedAt: 20 },
    });
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "completed", currentTurnId: null, unread: true, updatedAt: 21 },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Задача завершена");
    expect(notifications[0]?.options).toMatchObject({
      body: "Тестовая задача",
      tag: "completed:thread",
    });
  });

  it("notifies each attention request once and links to its thread", () => {
    const tracker = new BrowserNotificationTracker();
    tracker.acceptSnapshot(snapshot([thread("running", 10)]));
    const attention = attentionRequest(20);

    tracker.acceptEvent({ type: "attention.upserted", attention });
    tracker.acceptEvent({ type: "attention.upserted", attention });
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...thread("needsAttention", 21) },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Codex ждёт решения");
    expect(notifications[0]?.options?.body).toBe("Тестовая задача");
  });

  it("uses the server-synchronized language for notification chrome", () => {
    const tracker = new BrowserNotificationTracker();
    const running = thread("running", 10);
    tracker.acceptSnapshot(snapshot([running]));
    tracker.acceptEvent({ type: "uiLanguage.changed", language: "en" });

    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "failed", currentTurnId: null, updatedAt: 20 },
    });

    expect(notifications[0]?.title).toBe("Task failed");
    expect(notifications[0]?.options?.body).toBe("Тестовая задача");
  });

  it("notifies when a thread starts needing attention without an explicit request", () => {
    const tracker = new BrowserNotificationTracker();
    const running = thread("running", 10);
    tracker.acceptSnapshot(snapshot([running]));

    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "needsAttention", updatedAt: 20 },
    });
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "needsAttention", updatedAt: 21 },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Codex ждёт решения");
    expect(notifications[0]?.options).toMatchObject({
      body: "Тестовая задача",
      tag: "needs-attention:thread",
    });
  });

  it("never notifies child sessions from live events or reconnect snapshots", () => {
    const tracker = new BrowserNotificationTracker();
    const child = childThread("running", 10);
    tracker.acceptSnapshot(snapshot([child]));

    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...child, state: "completed", currentTurnId: null, unread: true, updatedAt: 20 },
    });
    tracker.acceptEvent({
      type: "attention.upserted",
      attention: attentionRequest(21, child.id),
    });
    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...child, state: "needsAttention", updatedAt: 22 },
    });
    tracker.acceptEvent({
      type: "attention.upserted",
      attention: attentionRequest(23, "unknown"),
    });
    tracker.acceptEvent({
      type: "attention.upserted",
      attention: attentionRequest(24, null),
    });
    tracker.acceptSnapshot(
      snapshot(
        [{ ...child, state: "failed", currentTurnId: null, unread: true, updatedAt: 30 }],
        [attentionRequest(31, child.id)],
      ),
    );

    expect(notifications).toHaveLength(0);
  });

  it("only notifies the direct worker for live outcomes and attention", () => {
    const tracker = new BrowserNotificationTracker();
    const workers = workerThreads();
    tracker.acceptSnapshot(snapshot(workers));

    for (const [index, worker] of workers.entries()) {
      const updatedAt = 20 + index * 10;
      const attention = attentionRequest(updatedAt, worker.id);
      tracker.acceptEvent({ type: "attention.upserted", attention });
      tracker.acceptEvent({ type: "attention.removed", attentionId: attention.id });

      for (const [offset, state] of (
        ["completed", "failed", "needsAttention"] as const
      ).entries()) {
        tracker.acceptEvent({
          type: "thread.upserted",
          thread: { ...worker, state, currentTurnId: null, updatedAt: updatedAt + offset + 1 },
        });
      }
    }

    expect(notifications.map(({ title, options }) => [title, options?.body, options?.tag])).toEqual(
      [
        ["Codex ждёт решения", "Прямой запуск", "attention:attention-20"],
        ["Задача завершена", "Прямой запуск", "completed:direct-worker"],
        ["Задача завершилась с ошибкой", "Прямой запуск", "failed:direct-worker"],
        ["Codex ждёт решения", "Прямой запуск", "needs-attention:direct-worker"],
      ],
    );
  });

  it.each([
    { state: "completed", tag: "completed:direct-worker" },
    { state: "failed", tag: "failed:direct-worker" },
    { state: "needsAttention", tag: "needs-attention:direct-worker" },
    { state: "running", tag: "attention:attention-30" },
  ] as const)("only notifies the direct worker on reconnect for $tag", ({ state, tag }) => {
    const tracker = new BrowserNotificationTracker();
    const workers = workerThreads();
    tracker.acceptSnapshot(snapshot(workers));
    tracker.acceptSnapshot(
      snapshot(
        workers.map((worker) => ({
          ...worker,
          state,
          currentTurnId: state === "running" ? worker.currentTurnId : null,
          unread: true,
          updatedAt: 20,
        })),
        state === "running"
          ? workers.map((worker, index) => attentionRequest(30 + index, worker.id))
          : [],
      ),
    );

    expect(notifications.map(({ options }) => options)).toEqual([{ body: "Прямой запуск", tag }]);
  });

  it("does not display system notifications while the page is visible", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const tracker = new BrowserNotificationTracker();
    const running = thread("running", 10);
    tracker.acceptSnapshot(snapshot([running]));

    tracker.acceptEvent({
      type: "thread.upserted",
      thread: { ...running, state: "failed", currentTurnId: null, updatedAt: 20 },
    });

    expect(notifications).toHaveLength(0);
  });

  it("catches up missed unread outcomes after a reconnect", () => {
    const tracker = new BrowserNotificationTracker();
    tracker.acceptSnapshot(snapshot([thread("running", 10)]));

    tracker.acceptSnapshot(
      snapshot([{ ...thread("completed", 20), unread: true }], [attentionRequest(21)]),
    );

    expect(notifications.map((notification) => notification.title)).toEqual([
      "Задача завершена",
      "Codex ждёт решения",
    ]);
  });

  it.each([10, 20])(
    "catches up a missed needs-attention state at %s after a reconnect",
    (updatedAt) => {
      const tracker = new BrowserNotificationTracker();
      tracker.acceptSnapshot(snapshot([thread("running", 10)]));

      tracker.acceptSnapshot(snapshot([thread("needsAttention", updatedAt)]));

      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.title).toBe("Codex ждёт решения");
    },
  );

  it("combines missed attention requests into one notification per session", () => {
    const tracker = new BrowserNotificationTracker();
    tracker.acceptSnapshot(snapshot([thread("running", 10)]));
    tracker.acceptSnapshot(
      snapshot([thread("needsAttention", 20)], [attentionRequest(21), attentionRequest(22)]),
    );
    expect(notifications).toHaveLength(1);
  });

  it("notifies once while async questions need attention, including reconnect and additional requests", () => {
    const tracker = new BrowserNotificationTracker();
    tracker.acceptSnapshot(snapshot([thread("running", 10)]));
    const waiting = { ...thread("needsAttention", 20), currentTurnId: "turn" };
    tracker.acceptEvent({ type: "thread.upserted", thread: waiting });
    tracker.acceptEvent({ type: "thread.upserted", thread: { ...waiting, updatedAt: 21 } });
    tracker.acceptSnapshot(snapshot([{ ...waiting, updatedAt: 30 }], [attentionRequest(31)]));
    tracker.acceptEvent({ type: "attention.upserted", attention: attentionRequest(32) });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe("Codex ждёт решения");
    expect(notifications[0]?.options).toMatchObject({ tag: "needs-attention:thread" });
    tracker.acceptEvent({ type: "attention.removed", attentionId: "attention-31" });
    tracker.acceptEvent({ type: "attention.removed", attentionId: "attention-32" });
    tracker.acceptEvent({ type: "thread.upserted", thread: thread("running", 40) });
    tracker.acceptEvent({ type: "thread.upserted", thread: { ...waiting, updatedAt: 50 } });
    expect(notifications).toHaveLength(2);
  });

  it("keeps async question notifications silent in the foreground and on reconnect", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const tracker = new BrowserNotificationTracker();
    tracker.acceptSnapshot(snapshot([thread("running", 10)]));
    const waiting = { ...thread("needsAttention", 20), currentTurnId: "turn" };
    tracker.acceptEvent({ type: "thread.upserted", thread: waiting });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    tracker.acceptSnapshot(snapshot([{ ...waiting, updatedAt: 30 }]));
    expect(notifications).toHaveLength(0);
  });
});

describe("browser notification permission", () => {
  it("requests permission in a supported browser", async () => {
    MockNotification.permission = "default";
    MockNotification.requestPermission.mockResolvedValue("granted");

    expect(getBrowserNotificationPermission()).toBe("default");
    await expect(requestBrowserNotificationPermission()).resolves.toBe("granted");
    expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("allows HTTP when the browser exposes the notification API", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    MockNotification.permission = "default";
    MockNotification.requestPermission.mockResolvedValue("granted");

    expect(getBrowserNotificationPermission()).toBe("default");
    await expect(requestBrowserNotificationPermission()).resolves.toBe("granted");
  });

  it("reports unsupported when the browser does not expose the notification API", () => {
    vi.stubGlobal("Notification", undefined);

    expect(getBrowserNotificationPermission()).toBe("unsupported");
  });
});

function thread(state: ThreadSummary["state"], updatedAt: number): ThreadSummary {
  return {
    id: "thread",
    relation: { kind: "session", sessionId: "session" },
    projectId: "project",
    title: "Тестовая задача",
    preview: "",
    cwd: "/work/project",
    state,
    unread: false,
    unseen: false,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt,
    currentTurnId: state === "running" ? "turn" : null,
    queuedMessageCount: 0,
    browserStatus: "disabled",
    settings: { collaborationMode: "default" },
  };
}

function childThread(state: ThreadSummary["state"], updatedAt: number): ThreadSummary {
  return {
    ...thread(state, updatedAt),
    id: "child",
    relation: {
      kind: "subagent",
      sessionId: "child-session",
      parentThreadId: "thread",
      nickname: null,
      role: null,
    },
  };
}

function workerThreads(): ThreadSummary[] {
  const running = thread("running", 10);
  return [
    {
      ...running,
      id: "direct-worker",
      title: "Прямой запуск",
      workerSession: { name: "Ревьюер" },
    },
    {
      ...running,
      id: "delegated-question",
      title: "Вопрос коллеге без родителя у провайдера",
      workerSession: { name: "Ревьюер", delegated: true },
    },
    {
      ...running,
      id: "nested-assignment",
      title: "Вложенное поручение на старом сервере",
      workerSession: { name: "Ревьюер", parentThreadId: "delegated-question" },
    },
  ];
}

function attentionRequest(createdAt: number, threadId: string | null = "thread"): AttentionRequest {
  return {
    id: `attention-${createdAt}`,
    threadId,
    turnId: "turn",
    itemId: "item",
    createdAt,
    kind: "unsupported",
    method: "test",
    message: "test",
  };
}

function snapshot(
  threads: ThreadSummary[],
  attention: AttentionRequest[] = [],
  uiLanguage: AppSnapshot["uiLanguage"] = "ru",
): AppSnapshot {
  return {
    sequence: 1,
    uiLanguage,
    connection: { state: "ready", message: null, syncedAt: null },
    projects: [],
    threads,
    forkOperations: [],
    attention,
    models: [],
  };
}
