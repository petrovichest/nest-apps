import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { SessionManager, type SessionLauncher } from "./manager.js";
import { SessionRunner, type RunnerTransport } from "./runner.js";
import type { RunnerDescriptor } from "./types.js";

class FakeClaude extends EventEmitter implements RunnerTransport {
  readonly pid = 600002;
  readonly sends: Array<{ requestId: string; text: string }> = [];
  readonly responses: Array<{ requestId: string; response: Record<string, unknown> }> = [];
  stops = 0;
  async start(): Promise<void> {}
  sendUser(requestId: string, text: string): void {
    this.sends.push({ requestId, text });
    this.emit("event", { type: "user", uuid: requestId, message: { role: "user", content: text } });
  }
  respond(requestId: string, response: Record<string, unknown>): void {
    this.responses.push({ requestId, response });
  }
  async interrupt(): Promise<void> {
    this.emit("event", { type: "result", subtype: "interrupted" });
  }
  async stop(): Promise<void> {
    this.stops++;
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const directory = await mkdtemp("/tmp/cna-");
  const config: Config = {
    host: "127.0.0.1",
    port: 4311,
    stateDir: join(directory, "state"),
    runtimeDir: join(directory, "run"),
    configDir: join(directory, "native"),
    claudeBin: "/fake/installed/claude",
    nodeBin: process.execPath,
    releasePath: join(directory, "immutable-release"),
    runnerPath: join(directory, "immutable-release", "runner-main.js"),
    serverEnvFile: join(directory, "server.env"),
    token: "test-token-with-at-least-thirty-two-characters",
    allowedOrigins: new Set(["http://localhost:4311"]),
  };
  await Promise.all(
    [config.runtimeDir, config.configDir, config.releasePath].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const owners = new Map<string, { runner: SessionRunner; transport: FakeClaude }>();
  let starts = 0;
  const launcher: SessionLauncher = {
    available: async () => {},
    active: async (id) => owners.has(id),
    start: async (descriptor: RunnerDescriptor) => {
      starts++;
      const transport = new FakeClaude();
      const runner = new SessionRunner(descriptor, {
        transportFactory: () => transport,
        claudeVersion: "fake-2.1.289",
      });
      owners.set(descriptor.sessionId, { runner, transport });
      await runner.start();
    },
  };
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  cleanup.push(async () => {
    for (const app of apps) await app.close();
    for (const { runner } of owners.values()) await runner.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function backend() {
    const manager = new SessionManager(config, launcher);
    await manager.initialize();
    const app = await buildApp(manager);
    apps.push(app);
    await app.ready();
    return { app, manager };
  }
  const headers = { authorization: `Bearer ${config.token}`, origin: "http://localhost:4311" };
  const input = {
    sessionId: randomUUID(),
    requestId: randomUUID(),
    cwd: directory,
    prompt: "Perform a task",
  };
  return { directory, config, owners, backend, headers, input, launchCount: () => starts };
}

describe("Claude backend HTTP and WebSocket integration", () => {
  it("requires its own bearer token, rejects foreign origins, and validates input", async () => {
    const { backend, headers, input, launchCount } = await fixture();
    const { app } = await backend();
    expect((await app.inject({ url: "/api/v1/health" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/v1/health",
          headers: { ...headers, authorization: "Bearer incorrect" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/v1/health",
          headers: { ...headers, origin: "https://unrelated.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: "/api/v1/health", headers })).json()).toMatchObject({
      app: "claudenest",
      recoveryState: "ready",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/sessions",
          headers,
          payload: { ...input, sessionId: "not-a-uuid" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/sessions",
          headers,
          payload: { ...input, prompt: " " },
        })
      ).statusCode,
    ).toBe(400);
    expect(launchCount()).toBe(0);
  });

  it("retries HTTP creation and restores the same permission request after the whole backend app closes", async () => {
    const { backend, headers, input, owners, launchCount } = await fixture();
    const first = await backend();
    const create = { method: "POST" as const, url: "/api/v1/sessions", headers, payload: input };
    const response = await first.app.inject(create);
    expect(response.statusCode).toBe(202);
    const retry = await first.app.inject(create);
    expect(retry.json()).toEqual(response.json());
    const before = (
      await first.app.inject({ url: `/api/v1/sessions/${input.sessionId}/snapshot`, headers })
    ).json();
    await first.app.close();
    const owner = owners.get(input.sessionId)!;
    expect(owner.transport.stops).toBe(0);
    owner.transport.emit("request", {
      request_id: "offline-question",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Choose?" }] },
      },
    });
    const second = await backend();
    const snapshot = (
      await second.app.inject({ url: `/api/v1/sessions/${input.sessionId}/snapshot`, headers })
    ).json();
    expect(snapshot).toMatchObject({
      runnerInstanceId: before.runnerInstanceId,
      runnerPid: before.runnerPid,
      claudePid: before.claudePid,
      state: "waiting",
      pendingRequests: [{ requestId: "offline-question", toolName: "AskUserQuestion" }],
    });
    const answer = await second.app.inject({
      method: "POST",
      url: "/api/v1/requests/offline-question/responses",
      headers,
      payload: {
        sessionId: input.sessionId,
        requestId: randomUUID(),
        response: { behavior: "allow", updatedInput: { answers: { "Choose?": "A" } } },
      },
    });
    expect(answer.statusCode).toBe(200);
    expect(owner.transport.responses).toEqual([
      {
        requestId: "offline-question",
        response: { behavior: "allow", updatedInput: { answers: { "Choose?": "A" } } },
      },
    ]);
    expect(owner.transport.sends).toHaveLength(1);
    expect(launchCount()).toBe(1);
  });

  it("reports native external sessions as unmanaged and maps absent history to 404", async () => {
    const { backend, headers, input, config } = await fixture();
    const project = join(config.configDir, "projects", "-external-project");
    await mkdir(project, { recursive: true });
    const native = {
      type: "user",
      sessionId: input.sessionId,
      cwd: "/external/project",
      message: { role: "user", content: "Native terminal task" },
    };
    await writeFile(join(project, `${input.sessionId}.jsonl`), JSON.stringify(native) + "\n");
    const { app } = await backend();
    const list = await app.inject({ url: "/api/v1/sessions", headers });
    expect(list.json().sessions).toEqual([
      expect.objectContaining({
        sessionId: input.sessionId,
        managed: false,
        title: "Native terminal task",
      }),
    ]);
    const history = await app.inject({
      url: `/api/v1/sessions/${input.sessionId}/history`,
      headers,
    });
    expect(history.json()).toMatchObject({
      sessionId: input.sessionId,
      cwd: "/external/project",
      messages: [native],
    });
    const absent = await app.inject({ url: `/api/v1/sessions/${randomUUID()}/history`, headers });
    expect(absent.statusCode).toBe(404);
    expect(absent.json().error.code).toBe("not_found");
    const collision = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers,
      payload: input,
    });
    expect(collision.statusCode).toBe(409);
  });

  it("authenticates WebSocket frames before subscription and streams snapshots and native events", async () => {
    const { backend, headers, input, config, owners } = await fixture();
    const { app } = await backend();
    await app.inject({ method: "POST", url: "/api/v1/sessions", headers, payload: input });
    await expect(
      app.injectWS("/api/v1/events", { headers: { origin: "https://unrelated.example" } }),
    ).rejects.toThrow("403");
    const denied = await app.injectWS("/api/v1/events", { headers });
    const deniedClose = once(denied, "close");
    denied.send(JSON.stringify({ type: "subscribe", sessionId: input.sessionId }));
    expect((await deniedClose)[0]).toBe(1008);
    const socket = await app.injectWS("/api/v1/events", {
      headers: { origin: "http://localhost:4311" },
    });
    const received: Array<Record<string, any>> = [];
    socket.on("message", (data) => received.push(JSON.parse(data.toString())));
    socket.send(JSON.stringify({ type: "authenticate", token: config.token }));
    await expect
      .poll(() => received.find((message) => message.type === "authenticated"))
      .toEqual({ type: "authenticated" });
    socket.send(JSON.stringify({ type: "subscribe", sessionId: input.sessionId }));
    await expect
      .poll(() => received.find((message) => message.type === "snapshot"))
      .toMatchObject({ snapshot: { sessionId: input.sessionId } });
    await expect
      .poll(() => received.find((message) => message.type === "subscribed"))
      .toMatchObject({ sessionId: input.sessionId });
    owners.get(input.sessionId)!.transport.emit("event", {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { text: "live response" },
      },
    });
    await expect
      .poll(() =>
        received.find(
          (message) =>
            message.type === "event" &&
            message.event.kind === "native" &&
            message.event.data.type === "stream_event",
        ),
      )
      .toMatchObject({
        event: {
          sessionId: input.sessionId,
          data: { event: { delta: { text: "live response" } } },
        },
      });
    const socketClosed = once(socket, "close");
    socket.close();
    await socketClosed;
  });
});
