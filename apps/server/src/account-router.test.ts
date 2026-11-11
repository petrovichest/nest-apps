import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { CodexAccountRouter } from "./account-router";
import type { AccountRuntimePool } from "./account-runtime";
import type { CodexBridge } from "./codex/bridge";
import type { ServerRequest } from "./codex/generated/index";
import type { JsonlTransport } from "./codex/transport";
import { AttentionManager } from "./attention";

it("blocks background dispatch and keeps legacy resumes on Native before update confirmation", async () => {
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
      workAllowed: () => false,
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
    expect(pool.ensure).not.toHaveBeenCalled();
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
  await router.close();
});
