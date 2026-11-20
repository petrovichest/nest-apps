import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Engine } from "./engine";
import { buildApp } from "./app";
import { cleanups, setup } from "./test-fixture";

describe("durable OpenCode facade", () => {
  it("imports the complete native session inventory beyond the native default first hundred", async () => {
    const { engine, native, project, config } = await setup();
    for (let index = 0; index < 125; index++) {
      const id = `ses_historical_${index}`;
      native.sessions.set(id, {
        id,
        directory: project.path,
        title: `History ${index}`,
        time: { created: index, updated: index },
      });
      native.messages.set(id, []);
    }
    await engine.close();
    native.calls.length = 0;
    const restored = new Engine(config, { native: native.client() });
    cleanups.push(() => restored.close());
    await restored.initialize({ watch: false });
    await restored.reconcile();
    expect(
      restored.snapshot().threads.filter((thread) => thread.projectId === project.id),
    ).toHaveLength(126);
    const inventory = native.calls.filter(
      (call) => call.method === "GET" && /^\/session(?:\?|$)/.test(call.path),
    );
    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.path).toBe("/session?limit=2147483647");
    expect(native.calls.some((call) => call.path.endsWith("/message"))).toBe(false);
  });
  it("reuses one native creation and rejects a creation identifier from another project", async () => {
    const { engine, project, thread, native, scratch } = await setup();
    expect((await engine.createThread(project.id, "creation")).thread.id).toBe(thread.id);
    expect(
      native.calls.filter((call) => call.method === "POST" && call.path === "/session"),
    ).toHaveLength(1);
    const other = await engine.addProject(scratch);
    await expect(engine.createThread(other.id, "creation")).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it("does not duplicate a retried message and preserves the full provider model ID", async () => {
    const { engine, thread, native } = await setup();
    const message = { input: "hello", clientMessageId: "same-id" };
    await engine.send(thread.id, message);
    await engine.send(thread.id, message);
    expect(native.prompts()).toHaveLength(1);
    expect(native.prompts()[0]!.body.model).toEqual({
      providerID: "openrouter",
      modelID: "vendor/test",
    });
    await expect(
      engine.send(thread.id, { input: "different", clientMessageId: "same-id" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("reconciles a persisted native message after ambiguous HTTP delivery without replay", async () => {
    const { engine, thread, native, config } = await setup();
    native.ambiguous = true;
    await engine.send(thread.id, { input: "run once", clientMessageId: "uncertain" });
    expect(engine.detail(thread.id).queuedMessages[0]?.deliveryError?.retryable).toBe(false);
    await engine.close();
    const restored = new Engine(config, { native: native.client() });
    cleanups.push(() => restored.close());
    await restored.initialize({ watch: false });
    native.ambiguous = false;
    await restored.reconcile();
    await restored.send(thread.id, { input: "run once", clientMessageId: "uncertain" });
    expect(restored.detail(thread.id).queuedMessages).toHaveLength(0);
    expect(native.prompts()).toHaveLength(1);
  });
  it("does not replay an uncertain send absent from native history after API restart", async () => {
    const { engine, thread, native, config } = await setup();
    native.ambiguous = true;
    await engine.send(thread.id, { input: "uncertain", clientMessageId: "missing" });
    native.messages.set(thread.id, []);
    await engine.close();
    const restored = new Engine(config, { native: native.client() });
    cleanups.push(() => restored.close());
    await restored.initialize({ watch: false });
    native.ambiguous = false;
    await restored.reconcile();
    await restored.send(thread.id, { input: "uncertain", clientMessageId: "missing" });
    expect(native.prompts()).toHaveLength(1);
    expect(restored.detail(thread.id).queuedMessages[0]?.deliveryError?.retryable).toBe(false);
  });
  it("recovers an ambiguous receipt on a native heartbeat without replay", async () => {
    const { engine, thread, native } = await setup();
    native.ambiguous = true;
    await engine.send(thread.id, {
      input: "accepted before timeout",
      clientMessageId: "heartbeat",
    });
    expect(engine.ready).toBe(false);
    native.ambiguous = false;
    await engine.onNativeEvent({ type: "server.heartbeat", properties: {} });
    expect(engine.ready).toBe(true);
    expect(engine.detail(thread.id).queuedMessages).toHaveLength(0);
    expect(native.prompts()).toHaveLength(1);
  });
  it("coalesces reconciliation and prevents admission during incomplete native inventory", async () => {
    const { engine, thread, native } = await setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    native.beforeStatus = () => held;
    const syncing = engine.reconcile();
    expect(engine.reconcile()).toBe(syncing);
    const send = engine.send(thread.id, { input: "after inventory", clientMessageId: "syncing" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(native.prompts()).toHaveLength(0);
    release();
    await syncing;
    await send;
    expect(native.prompts()).toHaveLength(1);
  });
  it("suppresses buffered deltas already included in a history snapshot and refreshes at idle", async () => {
    const { engine, thread, native } = await setup();
    native.messages.set(thread.id, [
      {
        info: { id: "user", role: "user", time: { created: 1 } },
        parts: [{ id: "user_part", type: "text", text: "hello" }],
      },
      {
        info: { id: "assistant", role: "assistant", parentID: "user", time: { created: 2 } },
        parts: [{ id: "reply_part", type: "text", text: "Hello" }],
      },
    ]);
    await engine.refreshThread(thread.id);
    await engine.onNativeEvent({
      type: "message.part.delta",
      properties: {
        sessionID: thread.id,
        messageID: "assistant",
        partID: "reply_part",
        field: "text",
        delta: "Hello",
      },
    });
    const visibleText = () =>
      engine
        .detail(thread.id)
        .turns.flatMap((turn) => turn.items)
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.text);
    expect(visibleText()).toEqual(["Hello"]);
    native.messages.get(thread.id)![1]!.parts[0]!.text = "Hello again";
    await engine.onNativeEvent({ type: "session.idle", properties: { sessionID: thread.id } });
    await vi.waitFor(() => expect(visibleText()).toEqual(["Hello again"]));
  });
  it("rechecks a deferred FIFO admission after the queued message was deleted", async () => {
    const { engine, thread, project, native, config } = await setup();
    const app = await buildApp(engine);
    cleanups.push(() => app.close());
    await engine.send(thread.id, { input: "running", clientMessageId: "running" });
    await engine.send(thread.id, { input: "delete me", clientMessageId: "deleted" }, true);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    native.beforeCreate = () => held;
    const creating = engine.createThread(project.id, "blocks-dispatch");
    await new Promise((resolve) => setImmediate(resolve));
    await engine.onNativeEvent({ type: "session.idle", properties: { sessionID: thread.id } });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/threads/${thread.id}/queue/deleted`,
      headers: { authorization: `Bearer ${config.token}` },
    });
    expect(deleted.statusCode).toBe(200);
    release();
    await creating;
    await new Promise((resolve) => setImmediate(resolve));
    expect(native.prompts()).toHaveLength(1);
  });
  it("delivers quoted pasted context to the native model instead of dropping it", async () => {
    const { engine, thread, native } = await setup();
    await engine.send(thread.id, {
      input: "summarize this",
      clientMessageId: "pasted",
      pasteBlocks: [{ id: "p1", text: "Important pasted content" }],
    });
    expect(native.prompts()[0]!.body.parts[0].text).toContain("Important pasted content");
    expect(native.prompts()[0]!.body.parts[0].text).toContain("summarize this");
  });
  it.each(["session.idle", "session.error"])(
    "keeps native %s authoritative when it precedes the HTTP acknowledgement",
    async (type) => {
      const { engine, native, thread } = await setup();
      native.beforeAck = (id) => engine.onNativeEvent({ type, properties: { sessionID: id } });
      await engine.send(thread.id, { input: "quick response", clientMessageId: "fast" });
      expect(engine.summary(thread.id).currentTurnId).toBeNull();
      expect(engine.summary(thread.id).state).toBe(
        type === "session.error" ? "failed" : "completed",
      );
    },
  );
  it("drains FIFO only after native idle and keeps separate native message IDs", async () => {
    const { engine, native, thread } = await setup();
    await engine.send(thread.id, { input: "first", clientMessageId: "one" });
    await engine.send(thread.id, { input: "second", clientMessageId: "two" }, true);
    expect(native.prompts()).toHaveLength(1);
    await engine.onNativeEvent({
      type: "session.status",
      properties: { sessionID: thread.id, status: { type: "idle" } },
    });
    await vi.waitFor(() => expect(native.prompts()).toHaveLength(2));
    expect(native.prompts()[0]!.body.messageID).not.toBe(native.prompts()[1]!.body.messageID);
    expect(native.prompts()[1]!.body.parts[0].text).toBe("second");
  });
  it("preserves pending native questions through API restart and replies by native identity", async () => {
    const { engine, native, thread, config } = await setup();
    native.questions = [
      {
        id: "q_one",
        sessionID: thread.id,
        questions: [
          {
            header: "Scope",
            question: "Which scope?",
            options: [{ label: "One", description: "Only one" }],
            multiple: false,
          },
        ],
      },
    ];
    await engine.close();
    const restored = new Engine(config, { native: native.client() });
    cleanups.push(() => restored.close());
    await restored.initialize({ watch: false });
    await restored.reconcile();
    const attention = restored.snapshot().attention[0]!;
    expect(attention.id).toBe("question:q_one");
    expect(restored.summary(thread.id).state).toBe("needsAttention");
    await restored.respond(attention.id, { kind: "userInput", answers: { "0": ["One"] } });
    expect(native.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/question/q_one/reply",
      body: { answers: [["One"]] },
    });
  });
  it("does not infer saved or verified authorization from provider.connected", async () => {
    const { engine } = await setup();
    expect(engine.connectionStatus().apiKeyConfigured).toBe(false);
  });
  it("stores only a saved-key flag and refreshes only checked managed/default instances", async () => {
    const { engine, config, native, project } = await setup();
    const key = "sk-or-fixture-secret";
    const status = await engine.setApiKey(key);
    expect(status.apiKeyConfigured).toBe(true);
    expect(status.message).toContain("not been verified");
    const disk = await readFile(join(config.stateDir, "ui.json"), "utf8");
    expect(disk).not.toContain(key);
    expect(JSON.stringify(engine.snapshot())).not.toContain(key);
    const disposals = native.calls.filter((call) => call.path === "/instance/dispose");
    expect(disposals.map((call) => call.directory)).toEqual([undefined, project.path]);
    expect(native.calls.some((call) => call.path === "/global/dispose")).toBe(false);
  });
  it("refuses key changes when another native session in the same cwd is busy", async () => {
    const { engine, native, project } = await setup();
    native.statuses.set(project.path, { foreign_session: { type: "busy" } });
    await expect(engine.setApiKey("sk-or-replacement")).rejects.toMatchObject({ statusCode: 409 });
    expect(native.calls.some((call) => call.path === "/auth/openrouter")).toBe(false);
    expect(native.calls.some((call) => call.path === "/instance/dispose")).toBe(false);
  });
  it("blocks connection changes for external cwd work beyond a hundred native sessions without disposing it", async () => {
    const { engine, native, scratch, project } = await setup();
    for (let index = 0; index < 125; index++) {
      const id = `ses_external_${index}`;
      native.sessions.set(id, {
        id,
        directory: project.path,
        title: "Older external session",
        time: { created: index, updated: index },
      });
    }
    const directory = join(scratch, "external"),
      id = "ses_external_busy";
    native.sessions.set(id, {
      id,
      directory,
      title: "External busy work",
      time: { created: 0, updated: 0 },
    });
    native.statuses.set(directory, { [id]: { type: "busy" } });
    await expect(engine.withIdleNative(async () => "restart native")).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(engine.setApiKey("sk-or-replacement")).rejects.toMatchObject({ statusCode: 409 });
    expect(native.calls.some((call) => call.path === "/auth/openrouter")).toBe(false);
    expect(native.calls.some((call) => call.path === "/instance/dispose")).toBe(false);
    native.statuses.delete(directory);
    engine.ready = false;
    await engine.setApiKey("sk-or-idle-replacement");
    expect(
      native.calls
        .filter((call) => call.path === "/instance/dispose")
        .map((call) => call.directory),
    ).toEqual([undefined, project.path]);
    expect(native.calls.some((call) => call.path === "/global/dispose")).toBe(false);
  });
  it("grants only native session-scoped rules and answers once instead of a durable project approval", async () => {
    const { engine, native, thread } = await setup();
    await engine.onNativeEvent({
      type: "permission.asked",
      properties: {
        id: "permission_one",
        sessionID: thread.id,
        permission: "bash",
        patterns: ["git status"],
      },
    });
    await engine.respond("permission:permission_one", {
      kind: "approval",
      decision: "acceptForSession",
    });
    const patch = native.calls.find(
      (call) => call.method === "PATCH" && call.path === `/session/${thread.id}`,
    )!;
    expect(patch.body.permission).toContainEqual({
      permission: "bash",
      pattern: "git status",
      action: "allow",
    });
    expect(native.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/permission/permission_one/reply",
      body: { reply: "once" },
    });
    expect(native.calls.some((call) => call.body?.reply === "always")).toBe(false);
    await engine.onNativeEvent({
      type: "permission.asked",
      properties: {
        id: "permission_two",
        sessionID: thread.id,
        permission: "bash",
        patterns: ["git status"],
      },
    });
    await vi.waitFor(() =>
      expect(
        native.calls.some(
          (call) => call.path === "/permission/permission_two/reply" && call.body.reply === "once",
        ),
      ).toBe(true),
    );
    expect(engine.snapshot().attention).toHaveLength(0);
  });
  it("merges workflow exclusions with ask and session grants without prompt.tools replacing permissions", async () => {
    const { engine, native, thread } = await setup();
    engine.thread(thread.id).sessionGrants = [{ permission: "bash", pattern: "git status" }];
    let tools: Record<string, boolean> = { task: false, browser_get_page_text: false };
    engine.setWorkflowHooks({ beforeDispatch: async () => ({ tools }) });
    await engine.send(thread.id, { input: "Start managed work", clientMessageId: "scoped-first" });
    const policies = () =>
      native.calls.filter(
        (call) => call.method === "PATCH" && call.path === `/session/${thread.id}`,
      );
    expect(policies().at(-1)?.body.permission).toEqual(
      expect.arrayContaining([
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "git status", action: "allow" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "browser_get_page_text", pattern: "*", action: "deny" },
      ]),
    );
    expect(native.prompts().at(-1)?.body.tools).toBeUndefined();
    tools = { task: false };
    await engine.send(thread.id, {
      input: "Browser is attached now",
      clientMessageId: "scoped-second",
    });
    expect(policies().at(-1)?.body.permission).not.toContainEqual({
      permission: "browser_get_page_text",
      pattern: "*",
      action: "deny",
    });
    await engine.setPermissions("full-access");
    await engine.send(thread.id, {
      input: "Current full-access rules",
      clientMessageId: "scoped-third",
    });
    expect(policies().at(-1)?.body.permission).toContainEqual({
      permission: "*",
      pattern: "*",
      action: "allow",
    });
    expect(policies().at(-1)?.body.permission).toContainEqual({
      permission: "task",
      pattern: "*",
      action: "deny",
    });
  });
  it("keeps interrupted preparation visible and does not invent a replacement native session", async () => {
    const { engine, project, native, config } = await setup();
    engine.data.creations.lost = { projectId: project.id, threadId: null };
    await writeFile(join(config.stateDir, "ui.json"), JSON.stringify(engine.data));
    const before = native.count;
    await expect(engine.createThread(project.id, "lost")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(native.count).toBe(before);
  });
});

describe("OpenNest API boundaries", () => {
  it("authenticates settings, rejects foreign origins, and distinguishes configuration from verification", async () => {
    const { engine, config } = await setup();
    const app = await buildApp(engine);
    cleanups.push(() => app.close());
    expect((await app.inject({ url: "/api/v1/settings/open" })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${config.token}` };
    expect(
      (
        await app.inject({
          url: "/api/v1/settings/open",
          headers: { ...headers, origin: "https://foreign.invalid" },
        })
      ).statusCode,
    ).toBe(403);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/open",
      headers,
      payload: { apiKey: "sk-or-fixture" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().apiKeyConfigured).toBe(true);
    expect(saved.body).not.toContain("sk-or-fixture");
    const tested = await app.inject({ method: "POST", url: "/api/v1/settings/open/test", headers });
    expect(tested.json().message).toContain("checked when a model request runs");
  });
  it("does not report healthy readiness while native reconciliation is incomplete", async () => {
    const { engine, config } = await setup();
    const app = await buildApp(engine);
    cleanups.push(() => app.close());
    engine.ready = false;
    const response = await app.inject({
      url: "/api/v1/health",
      headers: { authorization: `Bearer ${config.token}` },
    });
    expect(response.json()).toMatchObject({
      status: "degraded",
      recoveryState: "unavailable",
      appServer: { state: "unavailable" },
    });
  });
});

describe("session cost", () => {
  const usage = (
    engine: Engine,
    sessionID: string,
    id: string,
    cost: number | undefined,
    tokens?: Record<string, unknown>,
  ) =>
    engine.onNativeEvent({
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id,
          sessionID,
          role: "assistant",
          providerID: "openrouter",
          modelID: "vendor/test",
          time: { created: 1 },
          ...(cost === undefined ? {} : { cost }),
          ...(tokens ? { tokens } : {}),
        },
      },
    });

  it("hides the total until the first usage and sums billed assistant costs", async () => {
    const { engine, thread } = await setup();
    expect(engine.summary(thread.id).costUsage).toBeUndefined();
    await usage(engine, thread.id, "assistant_1", 0.5);
    expect(engine.summary(thread.id).costUsage).toEqual({ usd: 0.5, estimated: false });
    await usage(engine, thread.id, "assistant_2", 1.25);
    expect(engine.summary(thread.id).costUsage).toEqual({ usd: 1.75, estimated: false });
  });

  it("shows zero for a free model once usage is reported", async () => {
    const { engine, thread } = await setup();
    await usage(engine, thread.id, "assistant_free", 0);
    expect(engine.summary(thread.id).costUsage).toEqual({ usd: 0, estimated: false });
  });

  it("never lets the total decrease when native history shrinks", async () => {
    const { engine, thread, native } = await setup();
    await usage(engine, thread.id, "assistant_1", 2);
    native.messages.set(thread.id, []);
    await engine.refreshThread(thread.id);
    expect(engine.summary(thread.id).costUsage).toEqual({ usd: 2, estimated: false });
  });

  it("estimates a missing billed cost from the provider price table", async () => {
    const { engine, thread } = await setup();
    await usage(engine, thread.id, "assistant_estimated", undefined, {
      input: 1_000_000,
      output: 1_000_000,
    });
    expect(engine.summary(thread.id).costUsage).toEqual({ usd: 3, estimated: true });
  });

  it("includes native subagent sessions in the parent total and republishes it", async () => {
    const { engine, thread, project } = await setup();
    await usage(engine, thread.id, "assistant_parent", 0.5);
    const published = vi.spyOn(engine, "publish");
    await engine.onNativeEvent({
      type: "session.created",
      properties: {
        info: {
          id: "ses_native_child",
          directory: project.path,
          title: "Explore",
          parentID: thread.id,
          time: { created: 1, updated: 1 },
        },
      },
    });
    await usage(engine, "ses_native_child", "assistant_child", 0.25);
    expect(engine.summary(thread.id).costUsage).toEqual({ usd: 0.75, estimated: false });
    expect(engine.summary("ses_native_child").costUsage).toEqual({
      usd: 0.25,
      estimated: false,
    });
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.upserted",
        thread: expect.objectContaining({
          id: thread.id,
          costUsage: { usd: 0.75, estimated: false },
        }),
      }),
    );
  });

  it("starts a fork at zero by discounting the copied history", async () => {
    const { engine, thread, native } = await setup();
    native.sessions.get(thread.id)!.cost = 2;
    native.messages.set(thread.id, [
      {
        info: { id: "user", role: "user", time: { created: 1 } },
        parts: [{ id: "user_part", type: "text", text: "hello" }],
      },
      {
        info: {
          id: "assistant",
          role: "assistant",
          parentID: "user",
          cost: 2,
          time: { created: 2 },
        },
        parts: [{ id: "reply_part", type: "text", text: "Hello" }],
      },
    ]);
    await engine.refreshThread(thread.id);
    expect(engine.summary(thread.id).costUsage).toEqual({ usd: 2, estimated: false });
    const forked = await engine.fork(thread.id);
    expect(forked.costUsage).toEqual({ usd: 0, estimated: false });
    await usage(engine, forked.id, "assistant_new", 0.4);
    expect(engine.summary(forked.id).costUsage).toEqual({
      usd: expect.closeTo(0.4, 10),
      estimated: false,
    });
  });

  it("keeps the persisted total across a restart", async () => {
    const { engine, thread, native, config } = await setup();
    await usage(engine, thread.id, "assistant_1", 1.5);
    await engine.save();
    await engine.close();
    const restored = new Engine(config, { native: native.client() });
    cleanups.push(() => restored.close());
    await restored.initialize({ watch: false });
    await restored.reconcile();
    expect(restored.summary(thread.id).costUsage).toEqual({ usd: 1.5, estimated: false });
  });

  it("remembers zero-cost usage across a restart", async () => {
    const { engine, thread, native, config } = await setup();
    await usage(engine, thread.id, "assistant_free", 0);
    await engine.save();
    await engine.close();
    const restored = new Engine(config, { native: native.client() });
    cleanups.push(() => restored.close());
    await restored.initialize({ watch: false });
    await restored.reconcile();
    expect(restored.summary(thread.id).costUsage).toEqual({ usd: 0, estimated: false });
  });
});
