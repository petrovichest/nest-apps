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
  type ClaudePermissionMode,
  type CommandReceipt,
  type PendingRequest,
  type RunnerDescriptor,
  type RunnerEvent,
  type RunnerAttachment,
  type RunnerSnapshot,
} from "./types";
import { UiService, commandId } from "./ui-service";
import { parseClaudeUsage } from "./rate-limits";
import type { UiData } from "./ui-store";

type Delivery = {
  sessionId: string;
  requestId: string;
  cwd: string;
  prompt: string;
  files?: RunnerAttachment[];
  images?: RunnerAttachment[];
  permissionMode?: ClaudePermissionMode;
  model?: string;
  effort?: string;
};
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
  readonly steers: Delivery[] = [];
  readonly commands: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  readonly launcher = { active: async (id: string) => this.owners.has(id) };
  outcome: "completed" | "accepted" | "unknown" | "lostAck" | "lostAcceptedAck" | "lostUnknownAck" =
    "completed";
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
  async send(
    id: string,
    requestId: string,
    prompt: string,
    content?: Pick<Delivery, "files" | "images">,
    launch?: Pick<Delivery, "permissionMode" | "model" | "effort">,
  ): Promise<CommandReceipt> {
    const delivery = {
      sessionId: id,
      requestId,
      prompt,
      cwd: this.owners.get(id)?.cwd ?? this.config.stateDir,
      ...content,
      ...launch,
    };
    this.sends.push(delivery);
    if (["running", "waiting"].includes(this.owners.get(id)?.state ?? ""))
      throw new AppError("conflict", "Native session is busy", 409);
    return this.deliver(delivery);
  }
  async steer(
    id: string,
    requestId: string,
    prompt: string,
    content?: Pick<Delivery, "files" | "images">,
  ): Promise<CommandReceipt> {
    const delivery = {
      sessionId: id,
      requestId,
      prompt,
      cwd: this.owners.get(id)!.cwd,
      ...content,
    };
    this.steers.push(delivery);
    return this.deliver(delivery, "steer");
  }
  private deliver(input: Delivery, kind: "send" | "steer" = "send"): CommandReceipt {
    const owner = this.owners.get(input.sessionId) ?? snapshot(input.sessionId, input.cwd);
    const receipt: CommandReceipt = {
      requestId: input.requestId,
      kind,
      fingerprint: `native-${input.requestId}`,
      status:
        this.outcome === "unknown" || this.outcome === "lostUnknownAck"
          ? "unknown"
          : this.outcome === "accepted" || this.outcome === "lostAcceptedAck"
            ? "accepted"
            : "completed",
    };
    owner.commands.push(receipt);
    owner.state = receipt.status === "unknown" ? "failed" : "running";
    const user = {
      type: "user",
      uuid: input.requestId,
      message: { role: "user", content: input.prompt },
    };
    if (receipt.status === "completed")
      owner.currentEvents = kind === "steer" ? [...owner.currentEvents, user] : [user];
    if (input.permissionMode) owner.permissionMode = input.permissionMode;
    this.owners.set(input.sessionId, owner);
    if (
      this.outcome === "lostAck" ||
      this.outcome === "lostAcceptedAck" ||
      this.outcome === "lostUnknownAck"
    )
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
    const owner = this.owners.get(id);
    if (owner && method === "setPermissionMode")
      owner.permissionMode = params.permissionMode as ClaudePermissionMode;
    if (owner && method === "respond") {
      owner.pendingRequests = owner.pendingRequests.filter(
        (request) => request.requestId !== params.targetRequestId,
      );
      this.emit(id, "request.cancelled", { requestId: params.targetRequestId });
    }
    if (method === "release") this.owners.delete(id);
    return {
      requestId: String(params.requestId),
      kind: method as CommandReceipt["kind"],
      fingerprint: "control",
      status: "completed",
    };
  }
  emit(id: string, kind: RunnerEvent["kind"], data: unknown): void {
    const owner = this.owners.get(id)!;
    if (kind === "state") {
      const state = data as { state: RunnerSnapshot["state"]; awaitingResult?: boolean };
      owner.state = state.state;
      if (typeof state.awaitingResult === "boolean") owner.awaitingResult = state.awaitingResult;
    }
    if (kind === "native" && (data as { type?: string }).type === "result")
      owner.awaitingResult = false;
    if (kind === "command") {
      const receipt = data as CommandReceipt;
      owner.commands = [
        ...owner.commands.filter((entry) => entry.requestId !== receipt.requestId),
        receipt,
      ];
    }
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
    permissionMode: "bypassPermissions",
    capabilities: {
      contentBlocks: true,
      uploadedImages: true,
      setModel: true,
      setPermissionMode: true,
      steer: true,
      livePermissionMode: true,
    },
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
  const start = async (permissionMode?: ClaudePermissionMode) => {
    const service = new UiService(manager as unknown as SessionManager);
    services.push(service);
    if (permissionMode) {
      await service.store.initialize();
      await service.store.update((data) => {
        data.permissionMode = permissionMode;
      });
      for (const owner of manager.owners.values()) owner.permissionMode = permissionMode;
    }
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

  it("steers an active owner without interrupting it or releasing an explicit FIFO message", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service);
    const owner = snapshot(id, directory);
    owner.state = "running";
    owner.currentEvents = [{ type: "user", uuid: randomUUID(), message: { content: "Original" } }];
    manager.owners.set(id, owner);
    await service.attach(id);
    manager.accepting = true;
    const queued = await service.enqueue(id, {
      input: "Later",
      deliveryMode: "queue",
      clientMessageId: randomUUID(),
    });
    const clientMessageId = randomUUID();
    await service.steer(id, { input: "Adjust the active task", clientMessageId });
    await expect.poll(() => service.thread(id).deliveries[clientMessageId]?.accepted).toBe(true);
    expect(manager.steers.map((delivery) => delivery.prompt)).toEqual(["Adjust the active task"]);
    expect(manager.sends).toEqual([]);
    expect(manager.creates).toEqual([]);
    expect(manager.commands).toEqual([]);
    expect(manager.owners.get(id)?.currentEvents).toHaveLength(2);
    expect(service.thread(id).queue.map((message) => message.id)).toEqual([queued.id]);
    expect(service.summary(id).queuedMessageCount).toBe(1);
    manager.emit(id, "state", { state: "idle" });
    await waitForQueue(service, id, 0);
    expect(manager.sends.map((delivery) => delivery.prompt)).toEqual(["Later"]);
  });

  it("keeps acknowledged steering in the timeline before later replies and preserves its send time", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service);
    const owner = snapshot(id, directory);
    owner.state = "running";
    owner.currentEvents = [
      {
        type: "user",
        uuid: "original",
        timestamp: Date.now() - 5000,
        message: { content: "Original task" },
      },
    ];
    manager.owners.set(id, owner);
    await service.attach(id);
    manager.accepting = true;
    const input = await service.steer(id, {
      input: "Show the variants",
      clientMessageId: randomUUID(),
    });
    await waitForQueue(service, id, 0);
    manager.emit(id, "native", {
      type: "assistant",
      timestamp: input.createdAt + 2000,
      message: { id: "later", content: [{ type: "text", text: "Checking screenshots" }] },
    });
    await expect.poll(async () => (await service.detail(id)).turns[0]?.items.length).toBe(3);
    manager.emit(id, "native", {
      type: "user",
      uuid: input.id,
      timestamp: input.createdAt + 3000,
      claudenest_delivery: "steer",
      message: { content: input.text },
    });
    await service.store.flush();
    const detail = await service.detail(id);
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]!.items.map((item) => item.id)).toEqual([
      "original",
      input.id,
      "later:0",
    ]);
    expect(detail.turns[0]!.items[1]).toMatchObject({ timestamp: input.createdAt });
    expect(detail.queuedMessages).toEqual([]);
  });

  it("preserves attachments, pasted context, and a newer draft during steering admission", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service);
    const owner = snapshot(id, directory);
    owner.state = "running";
    manager.owners.set(id, owner);
    await service.attach(id);
    const file = await service.attachments.save(
      id,
      "notes.txt",
      "text/plain",
      Readable.from("attachment"),
    );
    const images = ["data:image/png;base64,aW1hZ2U="];
    const draft = await service.setDraft(id, {
      input: "Different new draft",
      images: [],
      goalMode: false,
      annotations: [],
    });
    const clientMessageId = randomUUID();
    await service.steer(id, {
      input: "Steer with context",
      images,
      files: [file],
      pasteBlocks: [{ id: "context", text: "Exact supplied context" }],
      clientMessageId,
    });
    manager.accepting = true;
    service.schedule(id);
    await waitForQueue(service, id, 0);
    expect(manager.steers[0]).toMatchObject({
      requestId: clientMessageId,
      files: [file],
      images: [expect.objectContaining({ mediaType: "image/png", size: 5 })],
    });
    expect(manager.steers[0]?.prompt).toContain("Exact supplied context");
    expect(service.thread(id).draft).toEqual(draft);
    expect(await service.attachments.validate(id, [file])).toEqual([file]);
  });

  it("retains accepted input and its attachments when the owner snapshot precedes its native echo", async () => {
    const { manager, start, reserve } = await fixture();
    const service = await start(),
      id = await reserve(service);
    manager.accepting = true;
    manager.outcome = "accepted";
    const input = await service.enqueue(id, {
      input: "Inspect the image",
      clientMessageId: randomUUID(),
      images: ["data:image/png;base64,aW1hZ2U="],
    });
    await waitForQueue(service, id, 0);
    await service.attach(id);
    const first = await service.detail(id);
    expect(first.turns).toHaveLength(1);
    expect(first.turns[0]!.items[0]).toMatchObject({
      id: input.id,
      timestamp: input.createdAt,
      images: ["data:image/png;base64,aW1hZ2U="],
    });
    const connection = manager.connections.get(id)!.at(-1)!;
    await connection.request("subscribe", {});
    manager.emit(id, "native", {
      type: "assistant",
      message: {
        id: "response",
        content: [{ type: "text", text: "Image received" }],
      },
    });
    await expect.poll(async () => (await service.detail(id)).turns[0]?.items.length).toBe(2);
    manager.emit(id, "native", {
      type: "user",
      uuid: input.id,
      message: { content: "Inspect the image" },
    });
    await service.store.flush();
    const after = await service.detail(id);
    expect(after.turns).toHaveLength(1);
    expect(after.turns[0]!.items.map((item) => item.id)).toEqual([input.id, "response:0"]);
    expect(after.turns[0]!.items[0]).toMatchObject({
      timestamp: input.createdAt,
      images: ["data:image/png;base64,aW1hZ2U="],
    });
    expect(after.turns[0]!.items[1]).toMatchObject({ timestamp: expect.any(Number) });
  });

  it("deduplicates steering after a lost acknowledgement and after backend recovery", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service);
    const owner = snapshot(id, directory);
    owner.state = "running";
    manager.owners.set(id, owner);
    await service.attach(id);
    manager.accepting = true;
    manager.outcome = "lostAck";
    const body = { input: "Accepted steering", clientMessageId: randomUUID() };
    await Promise.all([service.steer(id, body), service.steer(id, body)]);
    await waitForQueue(service, id, 0);
    await service.close();
    const restarted = await start();
    await restarted.steer(id, body);
    await restarted.store.flush();
    expect(manager.steers).toHaveLength(1);
    expect(manager.steers[0]?.requestId).toBe(body.clientMessageId);
    expect(manager.sends).toEqual([]);
    expect(manager.commands).toEqual([]);
    expect(restarted.thread(id).deliveries[body.clientMessageId]?.accepted).toBe(true);
    await expect(restarted.steer(id, { ...body, input: "Changed intent" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it.each(["unknown", "lostUnknownAck"] as const)(
    "does not resend steering with an %s outcome after recovery",
    async (outcome) => {
      const { manager, start, reserve, directory } = await fixture();
      const service = await start(),
        id = await reserve(service);
      const owner = snapshot(id, directory);
      owner.state = "running";
      manager.owners.set(id, owner);
      await service.attach(id);
      manager.accepting = true;
      manager.outcome = outcome;
      const body = { input: "Uncertain steering", clientMessageId: randomUUID() };
      await service.steer(id, body);
      await expect.poll(() => service.thread(id).queue[0]?.deliveryError?.retryable).toBe(false);
      await service.close();
      const restarted = await start();
      await restarted.steer(id, body);
      restarted.schedule(id);
      await restarted.close();
      expect(manager.steers).toHaveLength(1);
      expect(manager.sends).toEqual([]);
      expect(restarted.thread(id).queue[0]?.deliveryError?.retryable).toBe(false);
    },
  );

  it("keeps a legacy active owner intact and upgrades it only after the active turn finishes", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service);
    const owner = snapshot(id, directory);
    delete owner.capabilities;
    owner.state = "running";
    manager.owners.set(id, owner);
    await service.attach(id);
    manager.accepting = true;
    const message = await service.steer(id, {
      input: "Steer after safe upgrade",
      clientMessageId: randomUUID(),
    });
    await service.store.flush();
    expect(service.thread(id).queue[0]).toMatchObject({ id: message.id, deliveryMode: "steer" });
    expect(service.thread(id).queue[0]?.deliveryError).toBeUndefined();
    expect(manager.commands).toEqual([]);
    expect(manager.steers).toEqual([]);
    expect(manager.sends).toEqual([]);
    manager.emit(id, "state", { state: "idle" });
    await waitForQueue(service, id, 0);
    expect(manager.commands.map((command) => command.method)).toEqual(["release"]);
    expect(manager.sends).toMatchObject([
      { requestId: message.id, permissionMode: "bypassPermissions" },
    ]);
    expect(manager.owners.get(id)?.capabilities?.steer).toBe(true);
  });

  it("waits for the native terminal result after interruption before admitting input", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service);
    const owner = snapshot(id, directory);
    owner.state = "interrupted";
    owner.awaitingResult = true;
    manager.owners.set(id, owner);
    await service.attach(id);
    manager.accepting = true;
    const message = await service.steer(id, {
      input: "Continue after interruption",
      clientMessageId: randomUUID(),
    });
    await service.store.flush();
    expect(manager.steers).toEqual([]);
    expect(manager.sends).toEqual([]);
    expect(manager.commands).toEqual([]);
    expect(service.thread(id).queue[0]).toMatchObject({ id: message.id, status: "queued" });
    manager.emit(id, "native", {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
    });
    await waitForQueue(service, id, 0);
    expect(manager.steers.map((delivery) => delivery.requestId)).toEqual([message.id]);
    expect(service.thread(id).deliveries[message.id]?.accepted).toBe(true);
  });

  it("retries a busy interruption admission only after its terminal event even when the old snapshot omits awaitingResult", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service);
    const owner = snapshot(id, directory);
    owner.state = "interrupted";
    manager.owners.set(id, owner);
    await service.attach(id);
    const transport = vi
      .spyOn(manager, "steer")
      .mockRejectedValueOnce(
        new AppError("conflict", "Native interrupt is still awaiting its result", 409),
      );
    manager.accepting = true;
    const message = await service.steer(id, {
      input: "After terminal",
      clientMessageId: randomUUID(),
    });
    await expect.poll(() => transport.mock.calls.length).toBe(1);
    await expect.poll(() => service.thread(id).queue[0]?.status).toBe("queued");
    expect(service.thread(id).queue[0]?.deliveryError).toBeUndefined();
    expect(manager.commands).toEqual([]);
    manager.emit(id, "native", {
      type: "result",
      subtype: "error_during_execution",
      terminal_reason: "aborted_tools",
      is_error: true,
    });
    await waitForQueue(service, id, 0);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(manager.steers.map((delivery) => delivery.requestId)).toEqual([message.id]);
    expect(manager.sends).toEqual([]);
  });

  it("launches new sessions with full access by default and persists an explicit manual choice", async () => {
    const { manager, start, reserve } = await fixture();
    const service = await start(),
      first = await reserve(service);
    expect(service.permissionSettings()).toMatchObject({ preset: "full-access", version: "1" });
    manager.accepting = true;
    await service.steer(first, { input: "First", clientMessageId: randomUUID() });
    await waitForQueue(service, first, 0);
    expect(manager.creates[0]?.permissionMode).toBe("bypassPermissions");
    await service.setPermissions("manual", "1");
    expect(manager.commands).toMatchObject([
      { id: first, method: "setPermissionMode", params: { permissionMode: "manual" } },
    ]);
    await service.close();
    const restarted = await start(),
      second = await reserve(restarted);
    expect(restarted.permissionSettings()).toMatchObject({ preset: "ask", version: "2" });
    await restarted.steer(second, { input: "Second", clientMessageId: randomUUID() });
    await waitForQueue(restarted, second, 0);
    expect(manager.creates[1]?.permissionMode).toBe("manual");
    await expect(restarted.setPermissions("bypassPermissions", "1")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(restarted.permissionSettings().preset).toBe("ask");
  });

  it("autoallows ordinary legacy approvals under full access while keeping questions and other controls pending", async () => {
    const { manager, start, directory } = await fixture();
    const id = randomUUID(),
      question = {
        requestId: "question",
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Choose" }] },
        kind: "userQuestion" as const,
      };
    const owner = snapshot(id, directory, [
      { requestId: "legacy-bash", toolName: "Bash", input: { command: "pwd" } },
      question,
      { requestId: "other", toolName: "elicitation", input: {}, kind: "other" },
    ]);
    delete owner.capabilities;
    owner.permissionMode = "manual";
    manager.owners.set(id, owner);
    const service = await start();
    expect(
      manager.commands.map((command) => [command.method, command.params.targetRequestId]),
    ).toEqual([["respond", "legacy-bash"]]);
    expect(manager.commands[0]?.params.response).toEqual({
      behavior: "allow",
      updatedInput: { command: "pwd" },
    });
    expect(service.attention().map((request) => request.id)).toEqual(
      expect.arrayContaining([`${id}:question`, `${id}:other`]),
    );
    expect(manager.owners.get(id)?.pendingRequests).toEqual([
      question,
      expect.objectContaining({ requestId: "other" }),
    ]);
    manager.emit(id, "request", {
      requestId: "new-edit",
      toolName: "Edit",
      kind: "toolApproval",
      input: { file_path: "a.ts" },
    });
    await expect.poll(() => manager.commands.length).toBe(2);
    expect(manager.commands[1]?.params.targetRequestId).toBe("new-edit");
    expect(service.attention().some((request) => request.id === `${id}:question`)).toBe(true);
    expect(manager.commands.some((command) => command.method === "interrupt")).toBe(false);
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
    const service = await start("manual");
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
    const service = await start("manual"),
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

  it("keeps an accepted steering intent visible across the original result and admits a second steering intent", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service);
    const owner = snapshot(id, directory);
    owner.state = "running";
    manager.owners.set(id, owner);
    await service.attach(id);
    manager.accepting = true;
    manager.outcome = "accepted";
    const fifo = await service.enqueue(id, {
      input: "FIFO after both native inputs",
      clientMessageId: randomUUID(),
    });
    const first = await service.steer(id, {
      input: "First saved intent",
      clientMessageId: randomUUID(),
    });
    await expect.poll(() => manager.steers.length).toBe(1);
    await expect
      .poll(() => service.thread(id).queue.find((message) => message.id === first.id)?.status)
      .toBe("dispatching");
    expect(service.thread(id).deliveries[first.id]?.accepted).toBe(false);
    manager.emit(id, "native", { type: "result", subtype: "success", is_error: false });
    await service.store.flush();
    expect(service.thread(id).queue.map((message) => message.id)).toEqual([fifo.id, first.id]);
    expect(manager.sends).toEqual([]);
    const second = await service.steer(id, {
      input: "Second saved intent",
      clientMessageId: randomUUID(),
    });
    await expect.poll(() => manager.steers.length).toBe(2);
    await expect
      .poll(() => service.thread(id).queue.find((message) => message.id === second.id)?.status)
      .toBe("dispatching");
    expect(service.summary(id).queuedMessageCount).toBe(1);
    manager.emit(id, "command", {
      ...owner.commands.find((receipt) => receipt.requestId === first.id)!,
      status: "completed",
    });
    await expect.poll(() => service.thread(id).deliveries[first.id]?.accepted).toBe(true);
    expect(service.thread(id).queue.map((message) => message.id)).toEqual([fifo.id, second.id]);
    expect(manager.sends).toEqual([]);
    manager.emit(id, "command", {
      ...owner.commands.find((receipt) => receipt.requestId === second.id)!,
      status: "completed",
    });
    await expect.poll(() => service.thread(id).deliveries[second.id]?.accepted).toBe(true);
    expect(service.thread(id).queue.map((message) => message.id)).toEqual([fifo.id]);
    expect(manager.sends).toEqual([]);
    manager.outcome = "completed";
    manager.emit(id, "state", { state: "idle" });
    await waitForQueue(service, id, 0);
    expect(manager.sends.map((delivery) => delivery.requestId)).toEqual([fifo.id]);
    expect(manager.commands).toEqual([]);
  });

  it.each(["accepted", "lostAcceptedAck"] as const)(
    "preserves an %s steering intent across backend recovery without resending until native confirmation",
    async (outcome) => {
      const { manager, start, reserve, directory } = await fixture();
      const service = await start(),
        id = await reserve(service);
      const owner = snapshot(id, directory);
      owner.state = "running";
      manager.owners.set(id, owner);
      await service.attach(id);
      manager.accepting = true;
      manager.outcome = outcome;
      const body = { input: "Saved but not echoed", clientMessageId: randomUUID() };
      await service.steer(id, body);
      await expect.poll(() => manager.steers.length).toBe(1);
      await expect.poll(() => service.thread(id).queue[0]?.status).toBe("dispatching");
      await service.close();
      const restarted = await start();
      await restarted.steer(id, body);
      restarted.schedule(id);
      await restarted.store.flush();
      expect(manager.steers).toHaveLength(1);
      expect(restarted.thread(id).queue[0]).toMatchObject({
        id: body.clientMessageId,
        text: body.input,
        status: "dispatching",
      });
      expect(restarted.thread(id).deliveries[body.clientMessageId]?.accepted).toBe(false);
      manager.emit(id, "command", {
        ...owner.commands.find((receipt) => receipt.requestId === body.clientMessageId)!,
        status: "completed",
      });
      await waitForQueue(restarted, id, 0);
      expect(restarted.thread(id).deliveries[body.clientMessageId]?.accepted).toBe(true);
      expect(manager.steers).toHaveLength(1);
      expect(manager.sends).toEqual([]);
    },
  );

  it("retains the original text when a saved steering intent becomes unknown and never automatically resends it after recovery", async () => {
    const { manager, start, reserve, directory } = await fixture();
    const service = await start(),
      id = await reserve(service);
    const owner = snapshot(id, directory);
    owner.state = "running";
    manager.owners.set(id, owner);
    await service.attach(id);
    manager.accepting = true;
    manager.outcome = "accepted";
    const body = {
      input: "Preserve this uncertain clarification",
      clientMessageId: randomUUID(),
      pasteBlocks: [{ id: "paste", text: "Original quoted context" }],
    };
    await service.steer(id, body);
    await expect.poll(() => service.thread(id).queue[0]?.status).toBe("dispatching");
    manager.emit(id, "command", {
      ...owner.commands.find((receipt) => receipt.requestId === body.clientMessageId)!,
      status: "unknown",
    });
    await expect.poll(() => service.thread(id).queue[0]?.deliveryError?.retryable).toBe(false);
    expect(service.thread(id).queue[0]).toMatchObject({
      text: body.input,
      pasteBlocks: body.pasteBlocks,
    });
    await service.close();
    const restarted = await start();
    await restarted.steer(id, body);
    restarted.schedule(id);
    await restarted.close();
    expect(restarted.thread(id).queue[0]).toMatchObject({
      id: body.clientMessageId,
      text: body.input,
      pasteBlocks: body.pasteBlocks,
      deliveryError: { retryable: false },
    });
    expect(restarted.thread(id).deliveries[body.clientMessageId]?.accepted).toBe(false);
    expect(manager.steers).toHaveLength(1);
    expect(manager.sends).toEqual([]);
  });

  it.each(["completed", "unknown"] as const)(
    "does not overwrite a newer %s command event with a delayed accepted steering response",
    async (status) => {
      const { manager, start, reserve, directory } = await fixture();
      const service = await start(),
        id = await reserve(service);
      const owner = snapshot(id, directory);
      owner.state = "running";
      manager.owners.set(id, owner);
      await service.attach(id);
      manager.accepting = true;
      manager.outcome = "accepted";
      const nativeSteer = manager.steer.bind(manager);
      let acknowledge!: () => void;
      const ack = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      vi.spyOn(manager, "steer").mockImplementation(async (...args) => {
        const receipt = await nativeSteer(...args);
        manager.emit(id, "command", { ...receipt, status });
        await ack;
        return receipt;
      });
      const body = { input: "Race with native event", clientMessageId: randomUUID() };
      await service.steer(id, body);
      if (status === "completed")
        await expect
          .poll(() => service.thread(id).deliveries[body.clientMessageId]?.accepted)
          .toBe(true);
      else
        await expect.poll(() => service.thread(id).queue[0]?.deliveryError?.retryable).toBe(false);
      acknowledge();
      await service.close();
      const restarted = await start();
      await restarted.steer(id, body);
      await restarted.close();
      expect(manager.steers).toHaveLength(1);
      if (status === "completed") expect(restarted.thread(id).queue).toEqual([]);
      else
        expect(restarted.thread(id).queue[0]).toMatchObject({
          text: body.input,
          deliveryError: { retryable: false },
        });
      expect(
        owner.commands.find((receipt) => receipt.requestId === body.clientMessageId)?.status,
      ).toBe(status);
    },
  );

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
    const service = await start("manual");
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

describe("Claude plan rate limits", () => {
  it("shares one CLI usage read, publishes progress, and keeps the last limits after a failure", async () => {
    const { start } = await fixture();
    const service = await start();
    expect(service.snapshot().capabilities?.rateLimits).toBe(true);
    const limits = {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_000 },
      secondary: null,
    };
    let finish!: (value: typeof limits) => void;
    const read = vi
      .spyOn(service, "readRateLimits")
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockImplementationOnce(async () =>
        parseClaudeUsage({ rate_limits_available: true, rate_limits: null }),
      );
    const frames: ServerFrame[] = [];
    service.on("frame", (frame: ServerFrame) => frames.push(frame));

    const first = service.refreshRateLimits();
    expect(service.refreshRateLimits()).toBe(first);
    expect(service.snapshot().codexRateLimits).toMatchObject({ limits: null, refreshing: true });
    finish(limits);
    await expect(first).resolves.toEqual(limits);
    expect(read).toHaveBeenCalledTimes(1);
    expect(service.snapshot().codexRateLimits).toMatchObject({
      limits,
      refreshing: false,
      refreshError: false,
    });

    await expect(service.refreshRateLimits()).rejects.toThrow("usage is currently unavailable");
    expect(service.snapshot().codexRateLimits).toMatchObject({
      limits,
      refreshing: false,
      refreshError: true,
    });
    expect(
      frames.map((frame) =>
        frame.type === "event" && frame.event.type === "codexRateLimits.changed"
          ? [frame.event.codexRateLimits.refreshing, frame.event.codexRateLimits.refreshError]
          : null,
      ),
    ).toEqual([
      [true, false],
      [false, false],
      [true, false],
      [false, true],
    ]);
  });
});

describe("Claude owner release upgrades", () => {
  it.each(["running", "waiting"] as const)(
    "keeps a steer-capable prior-release %s owner alive and resumes its UUID at the next idle admission",
    async (state) => {
      const { manager, start, reserve, directory, config } = await fixture();
      const service = await start(),
        id = await reserve(service);
      const owner = snapshot(id, directory);
      owner.releasePath = "/test/previous-release";
      owner.state = state;
      manager.owners.set(id, owner);
      await service.attach(id);
      manager.accepting = true;
      const first = await service.enqueue(id, {
        input: "Next turn with current delivery guidance",
        clientMessageId: randomUUID(),
      });
      await service.store.flush();
      expect(manager.commands).toEqual([]);
      expect(manager.sends).toEqual([]);
      expect(manager.owners.get(id)).toBe(owner);
      expect(service.thread(id).queue[0]).toMatchObject({ id: first.id, status: "queued" });

      manager.emit(id, "state", { state: "idle" });
      await waitForQueue(service, id, 0);
      expect(manager.commands.map((command) => command.method)).toEqual(["release"]);
      expect(manager.creates).toEqual([]);
      expect(manager.sends).toMatchObject([{ sessionId: id, requestId: first.id }]);
      expect(manager.owners.get(id)?.releasePath).toBe(config.releasePath);
      expect(manager.owners.get(id)?.runnerInstanceId).not.toBe(owner.runnerInstanceId);

      manager.emit(id, "state", { state: "idle" });
      const next = await service.enqueue(id, {
        input: "Another turn on the upgraded owner",
        clientMessageId: randomUUID(),
      });
      await waitForQueue(service, id, 0);
      expect(manager.commands.map((command) => command.method)).toEqual(["release"]);
      expect(manager.sends.map((delivery) => [delivery.sessionId, delivery.requestId])).toEqual([
        [id, first.id],
        [id, next.id],
      ]);
    },
  );
});
