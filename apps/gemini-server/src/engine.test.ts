import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blankDraft, Engine } from "./engine";
import { paths } from "./config";
import type { AcpClient } from "./acp";
import { writeJsonAtomic } from "../../claude-server/src/io";

class FakeAcp extends EventEmitter {
  onRequest!: AcpClient["onRequest"];
  calls: Array<{ method: string; params: any }> = [];
  pending: Array<{ resolve(value: any): void; reject(error: Error): void }> = [];
  model = "gemini";
  async start() {
    return { protocolVersion: 1 };
  }
  request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === "session/prompt")
      return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
    if (method === "session/set_config_option") this.model = params.value;
    return Promise.resolve({
      sessionId: "native-session",
      configOptions: [
        {
          id: "model",
          category: "model",
          currentValue: this.model,
          options: [
            { value: "gemini", name: "Gemini" },
            { value: "fast", name: "Fast" },
          ],
        },
      ],
    });
  }
  notify(method: string, params: any) {
    this.calls.push({ method, params });
  }
  close() {
    this.emit("disconnected");
  }
  update(update: any) {
    this.emit("notification", "session/update", { sessionId: "native-session", update });
  }
}
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "gemininest-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = {
    ...paths({
      GEMININEST_CONFIG_DIR: join(root, "config"),
      GEMININEST_STATE_DIR: join(root, "state"),
      GEMININEST_RUNTIME_DIR: join(root, "run"),
      GEMININEST_AGY_BIN: "/bin/true",
    }),
    token: "t".repeat(48),
  };
  await writeJsonAtomic(join(config.configDir, "connection.json"), {
    proxy: "http://unused.example:3128",
    authenticated: true,
  });
  const fake = new FakeAcp();
  const engine = new Engine(config, () => fake as unknown as AcpClient);
  await engine.initialize();
  cleanups.push(() => engine.close());
  const project = await engine.addProject(root);
  const { thread } = await engine.createThread(project.id, "creation");
  return { engine, fake, thread, project, root, config };
}

describe("Gemini session ownership", () => {
  it("admits an input once, streams native events and rejects ID reuse", async () => {
    const { engine, fake, thread } = await setup();
    const message = { input: "hello", clientMessageId: "one" };
    await Promise.all([engine.send(thread.id, message), engine.send(thread.id, message)]);
    expect(fake.calls.filter((c) => c.method === "session/prompt")).toHaveLength(1);
    await expect(engine.send(thread.id, { ...message, input: "different" })).rejects.toThrow("ID");
    fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
    fake.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " world" },
    });
    fake.pending[0]!.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(engine.detail(thread.id).summary.state).toBe("completed"));
    expect(engine.detail(thread.id).turns[0]!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agentMessage",
          text: "Hello world",
          phase: "final_answer",
        }),
      ]),
    );
    expect(engine.detail(thread.id).turns[0]!.items[0]).toMatchObject({
      deliveryReceipt: { version: 0, clientId: "one" },
    });
  });
  it("steers through prompt while explicit queued input waits for all active prompts", async () => {
    const { engine, fake, thread } = await setup();
    await engine.send(thread.id, { input: "first", clientMessageId: "first" });
    await engine.send(thread.id, { input: "later", clientMessageId: "later" }, true);
    await engine.send(thread.id, { input: "steer", clientMessageId: "steer" });
    expect(fake.pending).toHaveLength(2);
    fake.pending[1]!.resolve({ stopReason: "end_turn" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.detail(thread.id).summary.state).toBe("running");
    fake.pending[0]!.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(fake.pending).toHaveLength(3));
    expect(fake.calls.filter((c) => c.method === "session/prompt")[2]!.params.prompt[0].text).toBe(
      "later",
    );
  });
  it("retains permissions for reconnect, selects the native option and cancels requests", async () => {
    const { engine, fake, thread } = await setup();
    await engine.send(thread.id, { input: "edit", clientMessageId: "edit" });
    const decision = fake.onRequest(
      "session/request_permission",
      {
        sessionId: "native-session",
        toolCall: { toolCallId: "tool", title: "Write file" },
        options: [
          { optionId: "ok", kind: "allow_once" },
          { optionId: "no", kind: "reject_once" },
        ],
      },
      1,
    );
    const attention = engine.snapshot().attention[0]!;
    expect(engine.detail(thread.id).summary.state).toBe("needsAttention");
    engine.respond(attention.id, { kind: "approval", decision: "accept" });
    await expect(decision).resolves.toEqual({ outcome: { outcome: "selected", optionId: "ok" } });
    const question = fake.onRequest(
      "elicitation/create",
      {
        sessionId: "native-session",
        mode: "form",
        message: "Which file?",
        requestedSchema: { properties: { file: { type: "string" } }, required: ["file"] },
      },
      2,
    );
    expect(engine.snapshot().attention[0]!.kind).toBe("elicitation");
    engine.cancel(thread.id);
    await expect(question).resolves.toEqual({ action: "cancel" });
    expect(fake.calls.at(-1)!.method).toBe("session/cancel");
  });
  it("rejects another session's files and preserves native IDs across a daemon restart", async () => {
    const { engine, fake, thread, config, root } = await setup();
    await writeFile(join(root, "private.txt"), "private");
    await expect(
      engine.send(thread.id, {
        input: "read",
        files: [
          {
            id: "other",
            name: "private.txt",
            path: join(root, "private.txt"),
            size: 7,
            mediaType: "text/plain",
          },
        ],
      }),
    ).rejects.toThrow();
    await engine.send(thread.id, { input: "hello", clientMessageId: "persist" });
    fake.pending[0]!.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(engine.detail(thread.id).summary.state).toBe("completed"));
    await engine.close();
    const resumed = new FakeAcp();
    const restored = new Engine(config, () => resumed as unknown as AcpClient);
    await restored.initialize();
    cleanups.push(() => restored.close());
    await restored.send(thread.id, { input: "continue", clientMessageId: "next" });
    expect(resumed.calls[0]).toMatchObject({
      method: "session/load",
      params: { sessionId: "native-session" },
    });
    expect(restored.detail(thread.id).turns).toHaveLength(2);
  });
  it("does not launch a CLI before proxy and Google sign-in are configured", async () => {
    const { engine, fake, config, thread } = await setup();
    await writeJsonAtomic(join(config.configDir, "connection.json"), {
      proxy: "",
      authenticated: false,
    });
    await engine.account.initialize();
    await expect(engine.send(thread.id, { input: "hello" })).rejects.toThrow("Войдите");
    expect(fake.calls).toHaveLength(0);
  });

  it("serializes manual queue sends and waits for remaining work after a steer fails", async () => {
    const { engine, fake, thread } = await setup();
    await engine.send(thread.id, { input: "first", clientMessageId: "first" });
    await engine.send(thread.id, { input: "queued", clientMessageId: "queued" }, true);
    const deliveries = await Promise.allSettled([
      engine.sendQueued(thread.id, "queued"),
      engine.sendQueued(thread.id, "queued"),
    ]);
    expect(deliveries.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(fake.pending).toHaveLength(2);
    await engine.send(thread.id, { input: "next", clientMessageId: "next" }, true);
    fake.pending[1]!.reject(new Error("steer rejected"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(engine.detail(thread.id).summary.state).toBe("running");
    fake.pending[0]!.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(engine.detail(thread.id).summary.state).toBe("failed"));
    expect(fake.pending).toHaveLength(2);
    expect(engine.detail(thread.id).queuedMessages[0]!.id).toBe("next");
  });

  it("excludes message admissions while changing the connection and refuses changes during work", async () => {
    const { engine, thread } = await setup();
    let entered = false;
    let release!: () => void;
    const change = engine.reconfigure(async () => {
      entered = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    await expect(engine.send(thread.id, { input: "wait" })).rejects.toThrow("настроек");
    await expect(engine.reconfigure(async () => undefined)).rejects.toThrow("изменяются");
    release();
    await change;
    await engine.send(thread.id, { input: "go" });
    await expect(engine.reconfigure(async () => undefined)).rejects.toThrow("задач");
  });

  it("transfers project attachments exactly once and clears only the admitted shared draft", async () => {
    const { engine, project } = await setup();
    const file = await engine.attachments.save(
      project.id,
      "note.txt",
      "text/plain",
      Readable.from(["note"]),
      4,
    );
    const draft = { ...blankDraft(), input: "Read note", files: [file] };
    engine.data.projectDrafts[project.id] = draft;
    const [first, second] = await Promise.all([
      engine.createThread(project.id, "attachment-creation", draft),
      engine.createThread(project.id, "attachment-creation", draft),
    ]);
    expect(first.thread.id).toBe(second.thread.id);
    expect(first.draft!.files![0]!.path).not.toBe(file.path);
    await expect(
      engine.attachments.validate(first.thread.id, first.draft!.files!),
    ).resolves.toHaveLength(1);
    await engine.send(first.thread.id, {
      input: "Read note",
      files: first.draft!.files,
      projectDraft: { projectId: project.id, updatedAt: draft.updatedAt },
    });
    expect(engine.data.projectDrafts[project.id]!.input).toBe("");
  });

  it("restores the native session's initial model when the override is cleared", async () => {
    const { engine, fake, thread } = await setup();
    await engine.send(thread.id, { input: "first" });
    fake.pending[0]!.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(engine.detail(thread.id).summary.state).toBe("completed"));
    await engine.settings(thread.id, { model: "fast" });
    expect(fake.model).toBe("fast");
    await engine.settings(thread.id, { model: null });
    expect(fake.model).toBe("gemini");
  });
});
