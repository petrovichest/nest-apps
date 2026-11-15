import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { CodexAccountRouter } from "./account-router";
import type { AccountRuntimePool } from "./account-runtime";
import type { CodexBridge } from "./codex/bridge";
import type { ServerRequest } from "./codex/generated/index";
import type { JsonlTransport } from "./codex/transport";
import { AttentionManager } from "./attention";

it.each(["none", "resume", "save"])(
  "preserves live history and hides internal archive events during a handover (%s failure)",
  async (failure) => {
    const state = { threadOwners: { chat: "native" }, legacyAccountId: "account" };
    let writer: string | null = "native";
    let archived = false;
    let failedSave = false;
    let filter: (notice: any) => boolean;
    const bridge = Object.assign(new EventEmitter(), {
      setRequestRouter: vi.fn(),
      setNativeNotificationFilter: (next: any) => {
        filter = next;
      },
      threadActive: () => false,
      acceptNotification: vi.fn(),
      requestNative: vi.fn(async (method: string) => {
        if (method === "thread/read") return { thread: { status: { type: "idle" } } };
        if (method === "thread/archive") {
          writer = null;
          archived = true;
          for (const method of ["thread/archived", "thread/closed"]) {
            const notice = { method, params: { threadId: "chat" } };
            if (filter(notice)) bridge.acceptNotification(notice);
          }
        }
        if (method === "thread/unarchive") archived = false;
        if (method === "thread/resume") {
          expect(writer).toBeNull();
          writer = "native";
        }
        return {};
      }),
    });
    const target = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/archive") {
          writer = null;
          archived = true;
        }
        if (method === "thread/unarchive") {
          archived = false;
          pool.emit(
            "notification",
            { id: "next" },
            {
              method: "thread/unarchived",
              params: { threadId: "chat" },
            },
          );
        }
        if (method === "thread/resume") {
          expect(writer).toBeNull();
          if (failure === "resume") throw new Error("target resume failed");
          writer = "next";
        }
        return {};
      }),
    };
    const pool = Object.assign(new EventEmitter(), {
      ensure: async () => ({ descriptor: { id: "next" }, bridge: target }),
      close: async () => undefined,
    });
    const router = new CodexAccountRouter(
      bridge as unknown as CodexBridge,
      pool as unknown as AccountRuntimePool,
      {
        state,
        selected: () => null,
        save: async () => {
          if (failure === "save" && !failedSave && state.threadOwners.chat === "next") {
            failedSave = true;
            throw new Error("metadata write failed");
          }
        },
        observe: () => undefined,
        userWork: () => undefined,
        account: () => null,
        beforeStart: () => undefined,
      },
    );
    try {
      const transfer = router.move("chat", {
        id: "account",
        native: false,
        home: "/fixture",
        proxy: null,
      });
      if (failure === "none") await transfer;
      else
        await expect(transfer).rejects.toThrow(
          failure === "save" ? "metadata write failed" : "target resume failed",
        );
      expect(archived).toBe(false);
      expect(writer).toBe(failure === "none" ? "next" : "native");
      expect(state.threadOwners.chat).toBe(writer);
      expect(bridge.acceptNotification).not.toHaveBeenCalled();
    } finally {
      await router.close();
    }
  },
);

it("blocks background dispatch and keeps legacy resumes on Native before update confirmation", async () => {
  let admitted = false;
  const nativeRequest = vi.fn(async () => ({ thread: { id: "legacy" } }));
  const bridge = Object.assign(new EventEmitter(), {
    setRequestRouter: vi.fn(),
    setNativeNotificationFilter: vi.fn(),
    requestNative: nativeRequest,
  });
  const pool = Object.assign(new EventEmitter(), {
    ensure: vi.fn(),
    close: vi.fn(async () => undefined),
  });
  const router = new CodexAccountRouter(
    bridge as unknown as CodexBridge,
    pool as unknown as AccountRuntimePool,
    {
      state: { threadOwners: {}, legacyAccountId: "account" },
      selected: () => ({ id: "account", native: true, home: "/fixture", proxy: null }),
      save: async () => undefined,
      observe: () => undefined,
      userWork: () => undefined,
      account: () => null,
      beforeStart: () => undefined,
      workAllowed: () => admitted,
    },
  );
  const route = bridge.setRequestRouter.mock.calls[0]![0] as (
    method: string,
    params: unknown,
    timeout: number,
  ) => Promise<unknown>;
  try {
    for (const method of [
      "turn/start",
      "thread/start",
      "thread/fork",
      "thread/compact/start",
      "thread/goal/set",
    ]) {
      await expect(route(method, { threadId: "legacy" }, 1000)).rejects.toThrow(
        "finalizing the update",
      );
    }
    expect(nativeRequest).not.toHaveBeenCalled();
    expect(pool.ensure).not.toHaveBeenCalled();
    await route("thread/resume", { threadId: "legacy", excludeTurns: true }, 1000);
    expect(nativeRequest).toHaveBeenCalledOnce();
    for (const method of ["model/list", "account/read", "getAuthStatus"]) {
      await route(method, {}, 1000);
      expect(nativeRequest).toHaveBeenLastCalledWith(method, {}, 1000);
    }
    expect(pool.ensure).not.toHaveBeenCalled();
    admitted = true;
    const request = vi.fn(async () => ({ data: ["account-model"] }));
    pool.ensure.mockResolvedValue({ descriptor: { id: "runtime" }, bridge: { request } });
    await expect(route("model/list", {}, 1000)).resolves.toEqual({ data: ["account-model"] });
    expect(pool.ensure).toHaveBeenCalledOnce();
  } finally {
    await router.close();
  }
});

it("refuses to replace a connection when an active native turn is beyond the first loaded page", async () => {
  const bridge = Object.assign(new EventEmitter(), {
    setRequestRouter: vi.fn(),
    setNativeNotificationFilter: vi.fn(),
    threadActive: () => false,
  });
  const client = {
    request: vi.fn(async (method: string, params: { cursor?: string; threadId?: string }) => {
      if (method === "thread/loaded/list")
        return params.cursor
          ? { data: ["live"], nextCursor: null }
          : { data: Array.from({ length: 100 }, (_, i) => `idle-${i}`), nextCursor: "page-2" };
      return { thread: { status: { type: params.threadId === "live" ? "active" : "idle" } } };
    }),
  };
  const descriptor = { id: "old", accountId: "account", retired: false };
  const pool = Object.assign(new EventEmitter(), {
    descriptors: () => [descriptor],
    matches: () => false,
    connect: async () => client,
    active: () => false,
    ensure: vi.fn(),
    stop: vi.fn(),
    close: async () => undefined,
  });
  const router = new CodexAccountRouter(
    bridge as unknown as CodexBridge,
    pool as unknown as AccountRuntimePool,
    {
      state: { threadOwners: { live: "old" }, legacyAccountId: null },
      selected: () => null,
      save: async () => undefined,
      observe: () => undefined,
      userWork: () => undefined,
      account: () => null,
      beforeStart: () => undefined,
    },
  );
  try {
    await expect(
      router.replaceAccountConnection({
        id: "account",
        home: "/fixture",
        native: false,
        proxy: null,
      }),
    ).rejects.toThrow("active responses");
    expect(client.request).toHaveBeenCalledWith("thread/loaded/list", {
      limit: 100,
      cursor: "page-2",
    });
    expect(pool.stop).not.toHaveBeenCalled();
    expect(pool.ensure).not.toHaveBeenCalled();
    expect(descriptor.retired).toBe(false);
  } finally {
    await router.close();
  }
});

it("isolates identical native approval IDs and their resolution across account connections", async () => {
  const bridge = Object.assign(new EventEmitter(), {
    setRequestRouter: vi.fn(),
    setNativeNotificationFilter: vi.fn(),
    acceptNotification: vi.fn((notice) => {
      if (notice.method === "serverRequest/resolved")
        attention.expireByRpcId(notice.params.requestId);
    }),
  });
  const pool = Object.assign(new EventEmitter(), { close: vi.fn(async () => undefined) });
  const attention = new AttentionManager();
  bridge.on("request", (request, transport) => attention.receive(request, transport));
  const router = new CodexAccountRouter(
    bridge as unknown as CodexBridge,
    pool as unknown as AccountRuntimePool,
    {
      state: { threadOwners: {}, legacyAccountId: null },
      selected: () => null,
      save: async () => undefined,
      observe: () => undefined,
      userWork: () => undefined,
      account: () => null,
      beforeStart: () => undefined,
    },
  );
  const transportA = { respond: vi.fn(), respondError: vi.fn() },
    transportB = { respond: vi.fn(), respondError: vi.fn() };
  const request = (threadId: string): ServerRequest =>
    ({
      id: 0,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId: "turn",
        itemId: "item",
        command: "pwd",
        cwd: "/tmp",
        reason: null,
      },
    }) as ServerRequest;
  pool.emit(
    "request",
    { id: "runtime-A" },
    request("thread-A"),
    transportA as unknown as JsonlTransport,
  );
  pool.emit(
    "request",
    { id: "runtime-B" },
    request("thread-B"),
    transportB as unknown as JsonlTransport,
  );
  expect(attention.list()).toHaveLength(2);
  pool.emit(
    "notification",
    { id: "runtime-A" },
    { method: "serverRequest/resolved", params: { threadId: "thread-A", requestId: 0 } },
  );
  expect(attention.list().map((request) => request.threadId)).toEqual(["thread-B"]);
  attention.resolve(attention.list()[0]!.id, { kind: "approval", decision: "accept" });
  expect(transportA.respond).not.toHaveBeenCalled();
  expect(transportB.respond).toHaveBeenCalledWith(
    0,
    expect.objectContaining({ decision: "accept" }),
  );
  bridge.emit("request", request("legacy-thread"), transportA);
  pool.emit(
    "notification",
    { id: "runtime-A" },
    {
      method: "thread/started",
      params: { thread: { id: "helper", ephemeral: true } },
    },
  );
  pool.emit(
    "notification",
    { id: "runtime-A" },
    {
      method: "serverRequest/resolved",
      params: { threadId: "helper", requestId: 0 },
    },
  );
  expect(attention.list().map((request) => request.threadId)).toEqual(["legacy-thread"]);
  await router.close();
});
