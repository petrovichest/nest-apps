import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AppSnapshot,
  CreateForkOperationRequest,
  ForkOperationDetailResponse,
  ForkOperationResponse,
  QueuedMessage,
  ThreadDetail,
} from "@codexnest/protocol";
import type { InjectOptions } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../../claude-server/src/app";
import type { Config } from "../../claude-server/src/config";
import { writeJsonAtomic } from "../../claude-server/src/io";
import { SessionManager } from "../../claude-server/src/manager";
import { stableUuid } from "../../claude-server/src/types";
import { UiService } from "../../claude-server/src/ui-service";
import { installClaudeFork, readClaudeForkPoint, stageClaudeFork } from "./claude-fork-history";
import { registerClaudeForkRoutes } from "./claude-forks";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
  vi.unstubAllEnvs();
});

const lines = (...rows: Record<string, unknown>[]) =>
  rows.map((row) => `${JSON.stringify(row)}\n`).join("");

async function fixture() {
  vi.stubEnv("DISABLE_COMPACT", "");
  const root = await mkdtemp(join(tmpdir(), "opennest-claude-forks-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config: Config = {
    host: "127.0.0.1",
    port: 1,
    configDir: join(root, "native"),
    stateDir: join(root, "state"),
    runtimeDir: join(root, "runtime"),
    claudeBin: "/fixture/never-use-real-credentials",
    nodeBin: process.execPath,
    releasePath: root,
    runnerPath: "/fixture/never-launch",
    serverEnvFile: join(root, "server.env"),
    token: "private-fixture-token",
    allowedOrigins: new Set(),
    openRouter: {
      keyFile: join(root, "key.json"),
      models: [
        {
          id: "anthropic/synthetic",
          displayName: "Synthetic",
          description: "",
          isDefault: true,
          reasoningEfforts: [],
          serviceTiers: [],
          supportsPersonality: false,
          openRouter: { developer: "anthropic", inputPrice: 1, outputPrice: 2 },
        },
      ],
      endpoints: async () => [],
    },
  };
  const source = randomUUID();
  const a = randomUUID();
  const commentary = randomUUID();
  const answer = randomUUID();
  const b = randomUUID();
  const directory = join(config.configDir, "projects", "fixture");
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(config.openRouter!.keyFile, "sk-or-synthetic-fixture");
  const sourcePath = join(directory, `${source}.jsonl`);
  const entry = {
    sessionId: source,
    cwd: root,
    version: "2.1.289",
    isSidechain: false,
    timestamp: "2026-11-27T12:00:00.000Z",
  };
  const aMessage = {
    role: "assistant",
    id: "msg_A",
    model: "anthropic/synthetic",
    stop_reason: "end_turn",
  };
  const base = lines(
    { ...entry, type: "user", uuid: a, parentUuid: null, message: { role: "user", content: "A" } },
    {
      ...entry,
      type: "assistant",
      uuid: commentary,
      parentUuid: a,
      apiBlockIndex: 0,
      message: { ...aMessage, content: [{ type: "text", text: "First block" }] },
    },
    {
      ...entry,
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: commentary,
      isSidechain: true,
      message: { ...aMessage, content: [{ type: "text", text: "Private subagent" }] },
    },
    {
      ...entry,
      type: "assistant",
      uuid: answer,
      parentUuid: commentary,
      apiBlockIndex: 1,
      message: {
        ...aMessage,
        content: [{ type: "text", text: "Final A" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
    {
      ...entry,
      type: "user",
      uuid: b,
      parentUuid: answer,
      message: { role: "user", content: "B later" },
    },
    {
      ...entry,
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: b,
      message: { ...aMessage, id: "msg_B", content: [{ type: "text", text: "Final B" }] },
    },
  );
  await writeFile(sourcePath, base);
  const point = { lastTurnId: a, agentMessageId: "msg_A:1" };
  const launcher = {
    available: vi.fn(async () => {}),
    active: vi.fn(async () => false),
    start: vi.fn(),
    stop: vi.fn(),
  };

  async function start(paused = false, listen = false) {
    const manager = new SessionManager({ ...config, startPaused: paused }, launcher);
    const ui = new UiService(manager);
    ui.forksEnabled = true;
    await manager.initialize();
    await ui.initialize({ probeModels: false, deferDispatch: true });
    const app = await buildApp(manager, ui);
    registerClaudeForkRoutes(app, ui);
    if (listen) await app.listen({ host: "127.0.0.1", port: 0 });
    else await app.ready();
    const close = async () => app.close();
    cleanup.push(close);
    const api = (
      method: InjectOptions["method"],
      path: string,
      payload?: InjectOptions["payload"],
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        payload,
        headers: { authorization: `Bearer ${config.token}` },
      });
    const create = (body: CreateForkOperationRequest) =>
      api("POST", `/threads/${source}/fork-operations`, body);
    const inspect = async (id: string) =>
      (await api("GET", `/fork-operations/${id}`)).json<ForkOperationDetailResponse>();
    return { api, create, inspect, manager, ui, close };
  }

  async function reserve(ui: UiService, request: CreateForkOperationRequest) {
    const cut = await readClaudeForkPoint(ui, source, request);
    const target = ui.createForkTarget(cut.source, "Branch", cut.uuid);
    const native = await stageClaudeFork(ui, cut, target.id);
    await ui.store.update((data) => {
      (data.forkOperations ??= {})[request.operationId] = {
        pending: target,
        targetId: target.id,
        ...native,
        summary: {
          ...point,
          id: request.operationId,
          sourceThreadId: source,
          mode: request.mode,
          status: "preparing",
          stage: "copying",
          title: target.title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          targetThreadId: null,
          error: null,
          estimate: null,
          queuedMessageCount: 0,
        },
      };
    });
    return { ...native, id: target.id };
  }

  return { root, source, sourcePath, base, answer, point, launcher, start, reserve };
}

it("uses the final native block at the selected turn and creates one exact branch without a runner", async () => {
  const { source, sourcePath, base, answer, point, launcher, start } = await fixture();
  const { api, create, inspect, ui } = await start();
  const upserts: string[] = [];
  ui.on("frame", (frame) => {
    if (frame.type === "event" && frame.event.type === "forkOperation.upserted")
      upserts.push(frame.event.operation.status);
  });
  const estimate = `/threads/${source}/fork-estimate`;
  const invalid = await api("POST", estimate, { ...point, agentMessageId: "msg_A:0" });
  expect(invalid.statusCode).toBe(409);
  expect((await api("POST", estimate, point)).json()).toMatchObject({
    sourceBytes: expect.any(Number),
    exact: { available: true },
    compressed: { available: true },
  });
  const payload = { ...point, mode: "exact", operationId: "__proto__" } as const;
  const [one, two] = await Promise.all([create(payload), create(payload)]);
  expect(one.statusCode).toBe(202);
  expect(one.json<ForkOperationResponse>().operation).toEqual(two.json().operation);
  await expect
    .poll(async () => (await inspect(payload.operationId)).operation.status)
    .toBe("ready");
  const target = (await inspect(payload.operationId)).operation.targetThreadId!;
  expect((await create(payload)).json<ForkOperationResponse>().operation.targetThreadId).toBe(
    target,
  );
  expect((await create({ ...payload, mode: "compressed" })).statusCode).toBe(409);
  const detail = (await api("GET", `/threads/${target}`)).json<ThreadDetail>();
  expect(detail.summary.relation).toEqual({
    kind: "session",
    sessionId: target,
    forkedFromId: source,
  });
  expect(detail.summary.costUsage).toBeUndefined();
  expect(detail.turns).toHaveLength(1);
  expect(detail.turns[0]?.items.at(-1)).toMatchObject({ text: "Final A", phase: "final_answer" });
  const history = (await api("GET", `/sessions/${target}/history`)).json();
  expect(history.messages.at(-1).uuid).toBe(answer);
  expect(history.messages.every((row: { sessionId: string }) => row.sessionId === target)).toBe(
    true,
  );
  expect(await readFile(sourcePath, "utf8")).toBe(base);
  expect(launcher.start).not.toHaveBeenCalled();
  expect(upserts).toEqual(["preparing", "ready"]);
  expect((await api("GET", "/snapshot")).json<AppSnapshot>().forkOperations).toHaveLength(1);
});

it("recovers a frozen exact fork and pending composer state after source deletion and restart", async () => {
  const { sourcePath, point, start, reserve, launcher } = await fixture();
  const before = await start();
  const request = { ...point, mode: "exact", operationId: randomUUID() } as const;
  const target = await reserve(before.ui, request);
  const path = `/fork-operations/${request.operationId}`;
  const savedDraft = { input: "Independent draft", images: [], annotations: [], goalMode: false };
  expect((await before.api("PUT", `${path}/draft`, savedDraft)).statusCode).toBe(200);
  const body = { input: "Queue", clientMessageId: randomUUID() };
  const response = await before.api("POST", `${path}/queue`, body);
  expect(response.statusCode).toBe(202);
  const pending = response.json<QueuedMessage>();
  expect(pending.threadId).toBe(request.operationId);
  expect(
    (await before.api("POST", `${path}/queue`, { ...body, input: "Changed" })).statusCode,
  ).toBe(409);
  expect(
    (await before.api("PATCH", `${path}/queue/${pending.id}`, { input: "Edited" })).statusCode,
  ).toBe(200);
  const remove = (
    await before.api("POST", `${path}/queue`, { input: "Remove me" })
  ).json<QueuedMessage>();
  expect((await before.api("DELETE", `${path}/queue/${remove.id}`)).statusCode).toBe(204);
  expect((await before.inspect(request.operationId)).queuedMessages).toHaveLength(1);
  await before.close();
  await rm(sourcePath);
  const after = await start(true, true);
  await expect
    .poll(async () => (await after.inspect(request.operationId)).operation.status)
    .toBe("ready");
  const detail = (await after.api("GET", `/threads/${target.id}`)).json<ThreadDetail>();
  expect(detail.draft).toMatchObject(savedDraft);
  expect(detail.queuedMessages).toMatchObject([
    { id: pending.id, threadId: target.id, text: "Edited" },
  ]);
  expect((await after.create(request)).json<ForkOperationResponse>().operation.targetThreadId).toBe(
    target.id,
  );
  expect(launcher.start).not.toHaveBeenCalled();
});

it("reconciles a saved compact boundary without re-admitting a paid command", async () => {
  const { point, start, reserve, launcher } = await fixture();
  const before = await start();
  const request = { ...point, mode: "compressed", operationId: randomUUID() } as const;
  const target = await reserve(before.ui, request);
  await installClaudeFork(target.transcriptPath, target.prefixBytes);
  const boundary = randomUUID();
  await appendFile(
    target.transcriptPath,
    lines(
      {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "manual" },
        uuid: boundary,
        sessionId: target.id,
        parentUuid: null,
      },
      {
        type: "user",
        isCompactSummary: true,
        uuid: randomUUID(),
        sessionId: target.id,
        parentUuid: boundary,
        message: { role: "user", content: "Compact summary" },
      },
    ),
  );
  await before.close();
  const after = await start(true, true);
  await expect
    .poll(async () => (await after.inspect(request.operationId)).operation.status)
    .toBe("ready");
  expect((await after.inspect(request.operationId)).operation.targetThreadId).toBe(target.id);
  expect(launcher.start).not.toHaveBeenCalled();
});

it("keeps an accepted but unconfirmed compression hidden and preserves its draft for retry or removal", async () => {
  const { root, point, start, reserve, launcher } = await fixture();
  const before = await start();
  const request = { ...point, mode: "compressed", operationId: randomUUID() } as const;
  const target = await reserve(before.ui, request);
  await installClaudeFork(target.transcriptPath, target.prefixBytes);
  await writeJsonAtomic(join(root, "state", "sessions", target.id, "commands.json"), [
    { requestId: stableUuid(`opennest-fork-compact:${target.id}`), status: "accepted" },
  ]);
  await before.ui.setDraft(
    request.operationId,
    { input: "Retain", images: [], annotations: [], goalMode: false },
    undefined,
    true,
  );
  await before.close();
  const after = await start(false, true);
  const failed = async () => {
    await expect
      .poll(async () => (await after.inspect(request.operationId)).operation.status)
      .toBe("failed");
    return after.inspect(request.operationId);
  };
  const first = await failed();
  expect(first.draft?.input).toBe("Retain");
  expect(first.operation.targetThreadId).toBeNull();
  expect(first.operation.error).toContain("did not confirm a compact context");
  expect((await after.api("GET", `/sessions/${target.id}/history`)).statusCode).toBe(404);
  expect((await after.api("GET", `/threads/${target.id}`)).statusCode).toBe(404);
  expect((await after.create(request)).statusCode).toBe(202);
  const again = await failed();
  expect(again.draft).toEqual(first.draft);
  expect(again.operation.targetThreadId).toBeNull();
  expect(launcher.start).not.toHaveBeenCalled();
  const path = `/fork-operations/${request.operationId}`;
  const removed = vi.fn();
  after.ui.on("frame", (frame) => {
    if (frame.type === "event" && frame.event.type === "forkOperation.removed")
      removed(frame.event.operationId);
  });
  expect((await after.api("DELETE", path)).statusCode).toBe(204);
  expect(removed).toHaveBeenCalledExactlyOnceWith(request.operationId);
  expect((await after.api("GET", path)).statusCode).toBe(404);
  expect((await after.create(request)).statusCode).toBe(409);
});

it("reports disabled compaction in estimates and refuses to admit it", async () => {
  const { source, point, start, launcher } = await fixture();
  const server = await start();
  vi.stubEnv("DISABLE_COMPACT", "1");
  expect(
    (await server.api("POST", `/threads/${source}/fork-estimate`, point)).json(),
  ).toMatchObject({
    exact: { available: true },
    compressed: {
      available: false,
      unavailableReason: "Claude Code context compaction is disabled",
    },
  });
  const request = { ...point, operationId: randomUUID(), mode: "compressed" } as const;
  expect((await server.create(request)).statusCode).toBe(409);
  expect((await server.api("GET", `/fork-operations/${request.operationId}`)).statusCode).toBe(404);
  expect(launcher.start).not.toHaveBeenCalled();
});
