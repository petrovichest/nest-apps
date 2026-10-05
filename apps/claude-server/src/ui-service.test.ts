import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ServerFrame } from "@codexnest/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config";
import type { SessionManager } from "./manager";
import type { RunnerConnection } from "./rpc";
import {
  AppError,
  type CommandReceipt,
  type PendingRequest,
  type RunnerDescriptor,
  type RunnerEvent,
  type RunnerSnapshot,
} from "./types";
import { UiService, commandId } from "./ui-service";
import type { UiData } from "./ui-store";

type Delivery = { sessionId: string; requestId: string; cwd: string; prompt: string };
class FakeConnection extends EventEmitter {
  closed = false;
  constructor(private readonly snapshot: () => RunnerSnapshot) {
    super();
  }
  async request(method: string): Promise<unknown> {
    if (method !== "subscribe") throw new Error(`Unexpected RPC ${method}`);
    this.emit("message", { type: "snapshot", snapshot: structuredClone(this.snapshot()) });
    return { sequence: this.snapshot().sequence };
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
  }
}

/** Never invokes a CLI, starts a service, or uses the installed application's state. */
class FakeManager {
  accepting = false;
  readonly owners = new Map<string, RunnerSnapshot>();
  readonly connections = new Map<string, FakeConnection[]>();
  readonly external: Array<Record<string, unknown>> = [];
  readonly creates: Delivery[] = [];
  readonly sends: Delivery[] = [];
  readonly commands: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  outcome: "completed" | "unknown" | "lostAck" | "lostUnknownAck" = "completed";
  constructor(readonly config: Config) {}
  async list(): Promise<unknown[]> {
    return [
      ...this.external,
      ...[...this.owners.values()].map((owner) => ({
        sessionId: owner.sessionId,
        cwd: owner.cwd,
        managed: true,
        state: owner.state,
      })),
    ];
  }
  async descriptor(id: string): Promise<RunnerDescriptor | undefined> {
    if (!this.owners.has(id)) return undefined;
    return {
      sessionId: id,
      cwd: this.owners.get(id)!.cwd,
      claudeBin: this.config.claudeBin,
      nodeBin: this.config.nodeBin,
      configDir: this.config.configDir,
      runnerPath: this.config.runnerPath,
      releasePath: this.config.releasePath,
      stateDirectory: join(this.config.stateDir, id),
      socketPath: join(this.config.runtimeDir, `${id}.sock`),
      resume: true,
      protocolVersion: 1,
    };
  }
  async create(input: Delivery): Promise<CommandReceipt> {
    this.creates.push(input);
    return this.deliver(input);
  }
  async send(id: string, requestId: string, prompt: string): Promise<CommandReceipt> {
    const delivery = {
      sessionId: id,
      requestId,
      prompt,
      cwd: this.owners.get(id)?.cwd ?? this.config.stateDir,
    };
    this.sends.push(delivery);
    if (["running", "waiting"].includes(this.owners.get(id)?.state ?? ""))
      throw new AppError("conflict", "Native session is busy", 409);
    return this.deliver(delivery);
  }
  private deliver(input: Delivery): CommandReceipt {
    const owner = this.owners.get(input.sessionId) ?? snapshot(input.sessionId, input.cwd);
    const receipt: CommandReceipt = {
      requestId: input.requestId,
      kind: "send",
      fingerprint: `native-${input.requestId}`,
      status:
        this.outcome === "unknown" || this.outcome === "lostUnknownAck" ? "unknown" : "completed",
    };
    owner.commands.push(receipt);
    owner.state = receipt.status === "unknown" ? "failed" : "running";
    owner.currentEvents = [
      { type: "user", uuid: input.requestId, message: { role: "user", content: input.prompt } },
    ];
    this.owners.set(input.sessionId, owner);
    if (this.outcome === "lostAck" || this.outcome === "lostUnknownAck")
      throw new AppError("unavailable", "Owner response disconnected", 503);
    return receipt;
  }
  async snapshot(id: string): Promise<RunnerSnapshot> {
    const owner = this.owners.get(id);
    if (!owner) throw new AppError("not_found", "No owner", 404);
    return structuredClone(owner);
  }
  async subscribe(id: string): Promise<RunnerConnection> {
    if (!this.owners.has(id)) throw new AppError("not_found", "No owner", 404);
    const connection = new FakeConnection(() => this.owners.get(id)!);
    this.connections.set(id, [...(this.connections.get(id) ?? []), connection]);
    return connection as unknown as RunnerConnection;
  }
  async command(
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<CommandReceipt> {
    this.commands.push({ id, method, params });
    return {
      requestId: String(params.requestId),
      kind: method as CommandReceipt["kind"],
      fingerprint: "control",
      status: "completed",
    };
  }
  emit(id: string, kind: RunnerEvent["kind"], data: unknown): void {
    const owner = this.owners.get(id)!;
    if (kind === "state") owner.state = (data as { state: RunnerSnapshot["state"] }).state;
    const event: RunnerEvent = {
      sessionId: id,
      runnerInstanceId: owner.runnerInstanceId,
      sequence: ++owner.sequence,
      kind,
      data,
    };
    for (const connection of this.connections.get(id) ?? [])
      if (!connection.closed) connection.emit("message", { type: "event", event });
  }
}
function snapshot(id: string, cwd: string, pendingRequests: PendingRequest[] = []): RunnerSnapshot {
  return {
    sessionId: id,
    cwd,
    runnerInstanceId: randomUUID(),
    protocolVersion: 1,
    releasePath: "/test/release",
    claudeVersion: "test",
    runnerPid: 999999,
    state: pendingRequests.length ? "waiting" : "idle",
    sequence: 0,
    pendingRequests,
    currentEvents: [],
    commands: [],
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture() {
  const directory = await mkdtemp("/tmp/claude-ui-test-");
  const config: Config = {
    host: "127.0.0.1",
    port: 1,
    stateDir: join(directory, "state"),
    runtimeDir: join(directory, "runtime"),
    configDir: join(directory, "native"),
    claudeBin: "/fake/never-executed-claude",
    nodeBin: process.execPath,
    releasePath: "/test/release",
    runnerPath: "/test/release/runner.js",
    serverEnvFile: join(directory, "server.env"),
    token: "test-only-token",
    allowedOrigins: new Set(),
  };
  await mkdir(config.stateDir, { recursive: true });
  const manager = new FakeManager(config);
  const services: UiService[] = [];
  cleanup.push(async () => {
    for (const service of services) await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    const service = new UiService(manager as unknown as SessionManager);
    services.push(service);
    await service.initialize({ probeModels: false });
    return service;
  };
  const reserve = async (service: UiService) => {
    const project = await service.createProject(directory);
    const result = await service.createThread(project.id, randomUUID());
    return result.thread.id;
  };
  return { directory, config, manager, start, reserve };
}
async function waitForQueue(service: UiService, id: string, count: number): Promise<void> {
  await expect.poll(() => service.thread(id).queue.length).toBe(count);
}

describe("Claude UI durable session facade", () => {
  it("reserves a thread and draft without starting a native owner", async () => {
    const { manager, start, directory, config } = await fixture();
    const service = await start(),
      project = await service.createProject(directory),
      creationId = randomUUID();
    const draft = { input: "Unsent text", images: [], goalMode: false, annotations: [] };
    const first = await service.createThread(project.id, creationId, draft);
    const repeated = await service.createThread(project.id, creationId, draft);
    expect(repeated.thread.id).toBe(first.thread.id);
    expect((await service.detail(first.thread.id)).draft?.input).toBe("Unsent text");
    expect(manager.creates).toEqual([]);
    expect(manager.owners.size).toBe(0);
    const saved = JSON.parse(await readFile(join(config.stateDir, "ui.json"), "utf8")) as UiData;
    expect(saved.creations[creationId]?.threadId).toBe(first.thread.id);
    expect(saved.threads[first.thread.id]?.draft?.input).toBe("Unsent text");
  });

  it("keeps a shared project draft when reserving a blank thread", async () => {
    const { manager, start, directory } = await fixture();
    const service = await start(),
      project = await service.createProject(directory);
    const draft = {
      input: "Shared unsent input",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 41,
    };
    await service.store.update((data) => {
      data.projectDrafts[project.id] = draft;
    });
    const result = await service.createThread(project.id, randomUUID());
    expect(result.draft).toBeNull();
    expect(service.store.data.projectDrafts[project.id]).toEqual(draft);
    expect(manager.creates).toEqual([]);
  });

  it.each(["exactContent", "draftUpdatedAt"] as const)(
    "consumes the sent thread draft on durable enqueue using %s",
    async (guard) => {
      const { manager, start, reserve } = await fixture();
      const service = await start(),
        id = await reserve(service);
      const pasteBlocks = [{ id: "draft-context", text: "Supplied context from the composer" }];
      const draft = await service.setDraft(id, {
        input: "Ready to send",
        images: [],
        pasteBlocks,
        goalMode: false,
        annotations: [],
      });
      await service.enqueue(id, {
        input: draft.input,
        pasteBlocks,
        clientMessageId: randomUUID(),
        ...(guard === "draftUpdatedAt" ? { draftUpdatedAt: draft.updatedAt } : {}),
      });
      expect(service.thread(id).draft).toBeNull();
      expect((await service.detail(id)).draft).toBeNull();
      const saved = JSON.parse(await readFile(service.store.path, "utf8")) as UiData;
      expect(saved.threads[id]?.draft).toBeNull();
      expect(saved.threads[id]?.queue[0]).toMatchObject({ text: "Ready to send", pasteBlocks });
      expect(manager.creates).toEqual([]);
    },
  );

  it("preserves a newer thread draft when a send carries an older draft revision", async () => {
    const { manager, start, reserve } = await fixture();
    const service = await start(),
      id = await reserve(service);
    const old = await service.setDraft(id, {
      input: "Older input",
      images: [],
      goalMode: false,
      annotations: [],
    });
    const current = await service.setDraft(
      id,
      { input: "Newer input from another device", images: [], goalMode: false, annotations: [] },
      String(old.updatedAt),
    );
    expect(current.updatedAt).toBeGreaterThan(old.updatedAt);
    await service.enqueue(id, {
      input: old.input,
      clientMessageId: randomUUID(),
      draftUpdatedAt: old.updatedAt,
    });
    expect(service.thread(id).draft).toEqual(current);
    // The revision guard takes precedence even when the message matches the new content.
    await service.enqueue(id, {
      input: current.input,
      clientMessageId: randomUUID(),
      draftUpdatedAt: old.updatedAt,
    });
    expect((await service.detail(id)).draft).toEqual(current);
    expect(service.thread(id).queue).toHaveLength(2);
    expect(manager.creates).toEqual([]);
  });

  it.each(["missing", "invalid"] as const)(
    "does not reserve a thread or lose a project draft when its %s attachment cannot migrate",
    async (problem) => {
      const { manager, start, directory } = await fixture();
      const service = await start(),
        project = await service.createProject(directory),
        clientCreationId = randomUUID();
      const original = await service.attachments.save(
        project.id,
        "source.txt",
        "text/plain",
        Readable.from("Project attachment"),
      );
      const attachment =
        problem === "invalid" ? { ...original, path: join(directory, "outside.txt") } : original;
      if (problem === "missing") await rm(original.path);
      const draft = {
        input: "Keep this draft",
        images: [],
        files: [attachment],
        goalMode: false,
        annotations: [],
        updatedAt: 42,
      };
      await service.store.update((data) => {
        data.projectDrafts[project.id] = draft;
      });
      await expect(service.createThread(project.id, clientCreationId, draft)).rejects.toThrow();
      expect(service.threadIds).toEqual([]);
      expect(service.store.data.creations[clientCreationId]).toBeUndefined();
      expect(service.store.data.projectDrafts[project.id]).toEqual(draft);
      expect(manager.creates).toEqual([]);
    },
  );

  it("copies a project attachment once for simultaneous retries of the same thread reservation", async () => {
    const { start, directory } = await fixture();
    const service = await start(),
      project = await service.createProject(directory),
      clientCreationId = randomUUID();
    const contents = "One project attachment";
    const original = await service.attachments.save(
      project.id,
      "source.txt",
      "text/plain",
      Readable.from(contents),
    );
    const draft = {
      input: "Use attached file",
      images: [],
      files: [original],
      goalMode: false,
      annotations: [],
      updatedAt: 43,
    };
    await service.store.update((data) => {
      data.projectDrafts[project.id] = draft;
    });
    const save = vi.spyOn(service.attachments, "save");
    try {
      const results = await Promise.all([
        service.createThread(project.id, clientCreationId, draft),
        service.createThread(project.id, clientCreationId, draft),
      ]);
      expect(results[0]!.thread.id).toBe(results[1]!.thread.id);
      expect(service.threadIds).toHaveLength(1);
      expect(save).toHaveBeenCalledTimes(1);
      expect(results[0]!.draft?.files).toEqual(results[1]!.draft?.files);
      const copied = results[0]!.draft!.files![0]!;
      expect(copied.path).not.toBe(original.path);
      expect(await readFile(copied.path, "utf8")).toBe(contents);
      expect(await service.attachments.validate(results[0]!.thread.id, [copied])).toEqual([copied]);
      expect(await readFile(original.path, "utf8")).toBe(contents);
    } finally {
      save.mockRestore();
    }
  });

  it.each(["matching", "stale", "differentProject"] as const)(
    "clears only the matching project draft version on enqueue (%s reference)",
    async (reference) => {
      const { manager, start, directory } = await fixture();
      const service = await start(),
        project = await service.createProject(directory);
      const { thread } = await service.createThread(project.id, randomUUID());
      let draftProjectId = project.id;
      if (reference === "differentProject") {
        const otherDirectory = join(directory, "other");
        await mkdir(otherDirectory);
        draftProjectId = (await service.createProject(otherDirectory)).id;
      }
      const draft = {
        input: "Shared source draft",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 44,
      };
      await service.store.update((data) => {
        data.projectDrafts[draftProjectId] = draft;
      });
      const frames: ServerFrame[] = [];
      service.on("frame", (frame) => frames.push(frame));
      await service.enqueue(thread.id, {
        input: "Accepted message",
        clientMessageId: randomUUID(),
        projectDraft: { projectId: draftProjectId, updatedAt: reference === "stale" ? 43 : 44 },
      });
      const clearedEvents = frames.filter(
        (frame) => frame.type === "event" && frame.event.type === "projectDraft.changed",
      );
      if (reference === "matching") {
        expect(service.store.data.projectDrafts[project.id]).toMatchObject({
          input: "",
          images: [],
          annotations: [],
          goalMode: false,
        });
        expect(service.store.data.projectDrafts[project.id]!.updatedAt).toBeGreaterThan(44);
        expect(clearedEvents).toEqual([
          expect.objectContaining({
            event: {
              type: "projectDraft.changed",
              projectId: project.id,
              draft: expect.objectContaining({ input: "", images: [], annotations: [] }),
            },
          }),
        ]);
      } else {
        expect(service.store.data.projectDrafts[draftProjectId]).toEqual(draft);
        expect(clearedEvents).toEqual([]);
      }
      expect(service.thread(thread.id).queue).toHaveLength(1);
      expect(manager.creates).toEqual([]);
    },
  );

  it("persists FIFO messages before acknowledging and recovers their IDs after a backend reboot", async () => {
    const { manager, start, reserve, config } = await fixture();
    const service = await start(),
      id = await reserve(service),
      firstId = randomUUID(),
      secondId = "browser-message-2";
    const first = await service.enqueue(id, { input: "First", clientMessageId: firstId });
    const second = await service.enqueue(id, { input: "Second", clientMessageId: secondId });
    const saved = JSON.parse(await readFile(join(config.stateDir, "ui.json"), "utf8")) as UiData;
    expect(saved.threads[id]?.queue.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(manager.creates).toEqual([]);
    await service.close();
    const restarted = await start();
    expect((await restarted.detail(id)).queuedMessages.map((message) => message.text)).toEqual([
      "First",
      "Second",
    ]);
    expect(
      await restarted.enqueue(id, { input: "Second", clientMessageId: secondId }),
    ).toMatchObject({ id: commandId(secondId) });
    expect(restarted.thread(id).queue).toHaveLength(2);
    expect(manager.creates).toEqual([]);
  });

  it("persists a quoted-paste-only message and sends its full context after reboot", async () => {
    const { manager, start, reserve } = await fixture();
    const service = await start(),
      id = await reserve(service),
      clientMessageId = randomUUID();
    const pasteBlocks = [
      { id: "quoted-block", text: "Supplied document\nKeep every line of this context." },
    ];
    const message = await service.enqueue(id, { input: "", pasteBlocks, clientMessageId });
    expect(message).toMatchObject({ text: "", pasteBlocks });
    await service.close();
    const restarted = await start();
    expect(restarted.thread(id).queue[0]?.pasteBlocks).toEqual(pasteBlocks);
    await expect(
      restarted.enqueue(id, {
        input: "",
        pasteBlocks: [{ ...pasteBlocks[0]!, text: "Changed context" }],
        clientMessageId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    manager.accepting = true;
    restarted.schedule(id);
    await waitForQueue(restarted, id, 0);
    expect(manager.creates).toHaveLength(1);
    expect(manager.creates[0]?.prompt).toContain("Pasted text is quoted context");
    expect(manager.creates[0]?.prompt).toContain("Pasted context 1:");
    expect(manager.creates[0]?.prompt).toContain(pasteBlocks[0]!.text);
    expect(manager.creates[0]?.requestId).toBe(clientMessageId);
  });

  it("dispatches the next FIFO entry only when the current native turn finishes", async () => {
    const { manager, start, reserve } = await fixture();
    const service = await start(),
      id = await reserve(service),
      firstId = randomUUID(),
      secondId = randomUUID();
    await service.enqueue(id, { input: "First", clientMessageId: firstId });
    await service.enqueue(id, { input: "Second", clientMessageId: secondId });
    manager.accepting = true;
    service.schedule(id);
    await waitForQueue(service, id, 1);
    expect(manager.creates.map((input) => input.requestId)).toEqual([firstId]);
    await service.attach(id);
    service.schedule(id);
    await service.store.flush();
    expect(manager.sends).toEqual([]);
    manager.emit(id, "native", { type: "result", subtype: "success", is_error: false });
    manager.emit(id, "state", { state: "idle" });
    await waitForQueue(service, id, 0);
    expect(manager.sends.map((input) => [input.requestId, input.prompt])).toEqual([
      [secondId, "Second"],
    ]);
    expect(service.thread(id).deliveries[firstId]?.accepted).toBe(true);
    expect(service.thread(id).deliveries[secondId]?.accepted).toBe(true);
  });

  it("rejects reused IDs with different input before and after delivery without resending", async () => {
    const { manager, start, reserve } = await fixture();
    const service = await start(),
      id = await reserve(service),
      requestId = randomUUID();
    await service.enqueue(id, { input: "Original", clientMessageId: requestId });
    await expect(
      service.enqueue(id, { input: "Changed", clientMessageId: requestId }),
    ).rejects.toMatchObject({ code: "conflict" });
    manager.accepting = true;
    service.schedule(id);
    await waitForQueue(service, id, 0);
    expect(
      await service.enqueue(id, { input: "Original", clientMessageId: requestId }),
    ).toMatchObject({ id: requestId });
    await expect(
      service.enqueue(id, { input: "Changed", clientMessageId: requestId }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(manager.creates).toHaveLength(1);
    expect(manager.sends).toEqual([]);
  });

  it("admits simultaneous retries of one browser message once", async () => {
    const { manager, start, reserve } = await fixture();
    const service = await start(),
      id = await reserve(service),
      clientMessageId = randomUUID();
    const body = { input: "Retried concurrently", clientMessageId };
    const results = await Promise.all([service.enqueue(id, body), service.enqueue(id, body)]);
    expect(results.map((message) => message.id)).toEqual([clientMessageId, clientMessageId]);
    expect(service.thread(id).queue).toHaveLength(1);
    expect(Object.keys(service.thread(id).deliveries)).toEqual([clientMessageId]);
    expect(manager.creates).toEqual([]);
  });

  it("reconciles a completed first receipt after reboot and immediately advances FIFO", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service),
      firstId = randomUUID(),
      secondId = randomUUID();
    await service.enqueue(id, { input: "Already completed", clientMessageId: firstId });
    await service.enqueue(id, { input: "Next", clientMessageId: secondId });
    await service.close();
    const owner = snapshot(id, directory);
    owner.commands = [
      { requestId: firstId, kind: "send", fingerprint: "persisted", status: "completed" },
    ];
    manager.owners.set(id, owner);
    manager.accepting = true;
    const restarted = await start();
    await expect.poll(() => restarted.thread(id).queue.length, { timeout: 1_000 }).toBe(0);
    expect(manager.creates).toEqual([]);
    expect(manager.sends.map((delivery) => delivery.requestId)).toEqual([secondId]);
    expect(restarted.thread(id).deliveries[firstId]?.accepted).toBe(true);
  });

  it("reconciles a lost acknowledgement from the owner's receipt instead of sending twice", async () => {
    const { manager, start, reserve } = await fixture();
    const service = await start(),
      id = await reserve(service),
      requestId = randomUUID();
    manager.outcome = "lostAck";
    manager.accepting = true;
    await service.enqueue(id, { input: "Already delivered", clientMessageId: requestId });
    await waitForQueue(service, id, 0);
    await service.enqueue(id, { input: "Already delivered", clientMessageId: requestId });
    expect(manager.creates).toHaveLength(1);
    expect(manager.sends).toEqual([]);
    expect(service.thread(id).deliveries[requestId]?.accepted).toBe(true);
  });

  it("reattaches a disconnected waiting owner before considering queued delivery", async () => {
    const { manager, start, directory } = await fixture();
    const id = randomUUID();
    manager.owners.set(
      id,
      snapshot(id, directory, [
        { requestId: "still-pending", toolName: "Bash", input: { command: "pwd" } },
      ]),
    );
    const service = await start();
    await service.enqueue(id, {
      input: "Wait until approval completes",
      clientMessageId: randomUUID(),
    });
    for (const connection of manager.connections.get(id) ?? []) connection.close();
    manager.accepting = true;
    service.schedule(id);
    await expect.poll(() => service.summary(id).state).toBe("needsAttention");
    await service.close();
    expect(manager.sends).toEqual([]);
    expect(service.thread(id).queue).toHaveLength(1);
    expect(service.thread(id).queue[0]?.deliveryError).toBeUndefined();
  });

  it.each(["edit", "delete"] as const)(
    "honors a queued %s that commits before dispatch admission",
    async (mutation) => {
      const { manager, start, reserve } = await fixture();
      const service = await start(),
        id = await reserve(service);
      await service.enqueue(id, { input: "Original", clientMessageId: randomUUID() });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = service.store.update(async () => {
        enter();
        await gate;
      });
      await entered;
      const update = service.store.update((data) => {
        if (mutation === "edit") data.threads[id]!.queue[0]!.text = "Edited before admission";
        else data.threads[id]!.queue = [];
      });
      manager.accepting = true;
      service.schedule(id);
      release();
      await blocker;
      await update;
      if (mutation === "edit") await waitForQueue(service, id, 0);
      await service.close();
      expect(manager.creates.map((delivery) => delivery.prompt)).toEqual(
        mutation === "edit" ? ["Edited before admission"] : [],
      );
    },
  );

  it.each(["unknown", "lostUnknownAck"] as const)(
    "stops automatic delivery for an ambiguous %s receipt, including after reboot",
    async (outcome) => {
      const { manager, start, reserve } = await fixture();
      const service = await start(),
        id = await reserve(service),
        requestId = randomUUID();
      manager.outcome = outcome;
      manager.accepting = true;
      await service.enqueue(id, { input: "Uncertain delivery", clientMessageId: requestId });
      await expect
        .poll(() => service.thread(id).queue[0]?.deliveryError)
        .toMatchObject({ retryable: false });
      await service.enqueue(id, { input: "Uncertain delivery", clientMessageId: requestId });
      service.schedule(id);
      await service.close();
      const restarted = await start();
      await restarted.enqueue(id, { input: "Uncertain delivery", clientMessageId: requestId });
      restarted.schedule(id);
      await restarted.store.flush();
      expect(restarted.thread(id).queue[0]?.deliveryError?.retryable).toBe(false);
      expect(manager.creates).toHaveLength(1);
      expect(manager.sends).toEqual([]);
    },
  );

  it("recovers a persisted dispatch with an existing unknown owner receipt without invoking Claude", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service),
      firstId = randomUUID();
    await service.enqueue(id, { input: "Previously attempted", clientMessageId: firstId });
    await service.enqueue(id, {
      input: "Must remain behind uncertain delivery",
      clientMessageId: randomUUID(),
    });
    await service.store.update((data) => {
      data.threads[id]!.queue[0]!.status = "dispatching";
    });
    await service.close();
    const owner = snapshot(id, directory);
    owner.state = "failed";
    owner.commands = [
      { requestId: firstId, kind: "send", fingerprint: "persisted", status: "unknown" },
    ];
    manager.owners.set(id, owner);
    manager.accepting = true;
    const restarted = await start();
    await expect
      .poll(() => restarted.thread(id).queue[0]?.deliveryError)
      .toMatchObject({ retryable: false });
    expect(restarted.thread(id).queue).toHaveLength(2);
    expect(manager.creates).toEqual([]);
    expect(manager.sends).toEqual([]);
  });

  it("projects external native history read-only and resumes its existing session UUID", async () => {
    const { manager, config, directory, start } = await fixture();
    const id = randomUUID(),
      userId = randomUUID(),
      projectRoot = join(config.configDir, "projects", "test-project");
    await mkdir(projectRoot, { recursive: true });
    const path = join(projectRoot, `${id}.jsonl`);
    const contents =
      [
        {
          type: "user",
          uuid: userId,
          cwd: directory,
          message: { role: "user", content: "Native question" },
        },
        {
          type: "assistant",
          uuid: randomUUID(),
          cwd: directory,
          message: {
            id: "msg-native",
            role: "assistant",
            content: [{ type: "text", text: "Native answer" }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n";
    await writeFile(path, contents);
    const before = await stat(path);
    manager.external.push({
      sessionId: id,
      cwd: directory,
      title: "Imported native session",
      managed: false,
    });
    const service = await start(),
      detail = await service.detail(id);
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]?.status).toBe("completed");
    expect(JSON.stringify(detail.turns)).toContain("Native answer");
    expect(manager.creates).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(contents);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    await service.close();
    const restarted = await start();
    manager.accepting = true;
    // A backend can resume imported history before a browser loads thread detail.
    await restarted.enqueue(id, { input: "Resume", clientMessageId: randomUUID() });
    await waitForQueue(restarted, id, 0);
    expect(manager.creates).toEqual([]);
    expect(manager.sends[0]?.sessionId).toBe(id);
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("maps pending CLI questions and tool approvals, persists drafts, and sends native responses", async () => {
    const { manager, start, directory } = await fixture();
    const id = randomUUID(),
      originalQuestions = [
        {
          header: "Backend",
          question: "Which mode?",
          multiSelect: true,
          options: [
            { label: "Local", description: "On this PC" },
            { label: "Remote", description: "Elsewhere" },
          ],
        },
      ];
    manager.owners.set(
      id,
      snapshot(id, directory, [
        {
          requestId: "question-request",
          toolName: "AskUserQuestion",
          input: { questions: originalQuestions },
        },
        { requestId: "bash-request", toolName: "Bash", input: { command: "pwd" } },
        {
          requestId: "edit-request",
          toolName: "Edit",
          input: { file_path: "/test/a.ts", old_string: "a", new_string: "b" },
        },
      ]),
    );
    const service = await start(),
      questionKey = `${id}:question-request`;
    expect(service.summary(id).state).toBe("needsAttention");
    expect(service.attention()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: questionKey,
          kind: "userInput",
          questions: [
            expect.objectContaining({
              id: "question-0",
              multiSelect: true,
              question: "Which mode?",
            }),
          ],
        }),
        expect.objectContaining({
          id: `${id}:bash-request`,
          kind: "commandApproval",
          command: "pwd",
          cwd: directory,
          canAcceptForSession: false,
        }),
        expect.objectContaining({
          id: `${id}:edit-request`,
          kind: "fileChangeApproval",
          reason: "Edit: /test/a.ts",
          canAcceptForSession: false,
        }),
      ]),
    );
    await service.questionDraft(questionKey, {
      answers: { "question-0": ["Local"] },
      currentQuestionId: "question-0",
    });
    await service.close();
    const restarted = await start();
    expect(restarted.attention().find((item) => item.id === questionKey)).toMatchObject({
      draft: { answers: { "question-0": ["Local"] }, revision: 1 },
    });
    await restarted.respond(questionKey, {
      kind: "userInput",
      answers: { "question-0": ["Local", "Remote"] },
    });
    expect(manager.commands.at(-1)).toMatchObject({
      id,
      method: "respond",
      params: {
        targetRequestId: "question-request",
        response: {
          behavior: "allow",
          updatedInput: {
            questions: originalQuestions,
            answers: { "Which mode?": "Local, Remote" },
          },
        },
      },
    });
    await restarted.respond(`${id}:bash-request`, { kind: "approval", decision: "accept" });
    expect(manager.commands.at(-1)).toMatchObject({
      method: "respond",
      params: {
        targetRequestId: "bash-request",
        response: { behavior: "allow", updatedInput: { command: "pwd" } },
      },
    });
    await restarted.respond(`${id}:edit-request`, { kind: "approval", decision: "decline" });
    expect(manager.commands.at(-1)).toMatchObject({
      method: "respond",
      params: { targetRequestId: "edit-request", response: { behavior: "deny" } },
    });
    manager.emit(id, "request.cancelled", { requestId: "question-request" });
    await expect
      .poll(() => restarted.attention().some((item) => item.id === questionKey))
      .toBe(false);
    await expect(
      restarted.respond(questionKey, { kind: "userInput", answers: { "question-0": ["Local"] } }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("requires answers and avoids inventing session-wide approval grants", async () => {
    const { manager, start, directory } = await fixture();
    const id = randomUUID();
    manager.owners.set(
      id,
      snapshot(id, directory, [
        {
          requestId: "question",
          toolName: "AskUserQuestion",
          input: { questions: [{ question: "Choose" }] },
        },
        { requestId: "tool", toolName: "Bash", input: { command: "pwd" } },
      ]),
    );
    const service = await start();
    await expect(
      service.respond(`${id}:question`, { kind: "userInput", answers: {} }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      service.respond(`${id}:tool`, { kind: "approval", decision: "acceptForSession" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(manager.commands).toEqual([]);
    await service.respond(`${id}:tool`, { kind: "approval", decision: "cancel" });
    expect(manager.commands.at(-1)).toMatchObject({ id, method: "interrupt" });
  });
});
