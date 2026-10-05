import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerConnection } from "./rpc.js";
import { ClaudeControlRejectedError } from "./claude.js";
import { SessionRunner, type RunnerOptions, type RunnerTransport } from "./runner.js";
import type {
  ClaudePermissionMode,
  CommandReceipt,
  RpcMessage,
  RunnerDescriptor,
  RunnerSnapshot,
} from "./types.js";

class FakeClaude extends EventEmitter implements RunnerTransport {
  readonly pid = 4242;
  readonly sends: Array<{ requestId: string; text: string; content?: Record<string, unknown>[] }> =
    [];
  readonly responses: Array<{ requestId: string; response: Record<string, unknown> }> = [];
  interruptions = 0;
  stops = 0;
  autoEcho = true;
  sendHook?: () => void;
  sendError?: Error;
  model = "sonnet";
  permissionMode: ClaudePermissionMode = "manual";
  supportedModels = [{ value: "sonnet", displayName: "Sonnet", description: "Test model" }];
  modelChanges = 0;
  permissionChanges = 0;
  rejectModel = false;

  async start(): Promise<void> {}
  sendUser(requestId: string, text: string, content?: Record<string, unknown>[]): void {
    this.sends.push({ requestId, text, ...(content ? { content } : {}) });
    this.sendHook?.();
    if (this.sendError) throw this.sendError;
    if (this.autoEcho)
      this.emit("event", {
        type: "user",
        uuid: requestId,
        message: { role: "user", content: content ?? text },
      });
  }
  respond(requestId: string, response: Record<string, unknown>): void {
    this.responses.push({ requestId, response });
  }
  async interrupt(): Promise<void> {
    this.interruptions++;
  }
  async stop(): Promise<void> {
    this.stops++;
  }
  async setModel(model: string): Promise<void> {
    if (this.rejectModel) throw new ClaudeControlRejectedError("Model unavailable");
    this.modelChanges++;
    this.model = model;
  }
  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.permissionChanges++;
    this.permissionMode = mode;
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(options: RunnerOptions = {}) {
  const directory = await mkdtemp("/tmp/cnr-");
  const descriptor: RunnerDescriptor = {
    sessionId: randomUUID(),
    cwd: directory,
    claudeBin: "/fake/claude",
    nodeBin: process.execPath,
    releasePath: "/immutable/release",
    runnerPath: "/immutable/release/runner-main.js",
    configDir: directory,
    socketPath: join(directory, "r.sock"),
    stateDirectory: join(directory, "state"),
    resume: false,
    protocolVersion: 1,
  };
  const fake = new FakeClaude();
  const runner = new SessionRunner(descriptor, {
    ...options,
    transportFactory: () => fake,
    claudeVersion: "test-version",
  });
  await runner.start();
  cleanup.push(async () => {
    await runner.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  async function client() {
    const connection = await RunnerConnection.open(descriptor.socketPath);
    cleanup.push(async () => connection.close());
    return connection;
  }
  return { directory, descriptor, fake, runner, client };
}

describe("isolated Claude session runner", () => {
  it("keeps the same Claude owner alive and permissions pending after backend disconnect", async () => {
    const { fake, runner, client, descriptor } = await fixture();
    const first = await client();
    const before = await first.request<RunnerSnapshot>("hello");
    await first.request("send", { requestId: randomUUID(), text: "perform a task" });
    first.close();
    fake.emit("request", {
      request_id: "approval-1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "touch example" } },
    });
    fake.emit("event", {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { text: "still running" } },
    });
    expect(fake.stops).toBe(0);
    expect(fake.responses).toHaveLength(0);
    const second = await client();
    const after = await second.request<RunnerSnapshot>("hello");
    expect(after.runnerInstanceId).toBe(before.runnerInstanceId);
    expect(after.runnerPid).toBe(before.runnerPid);
    expect(after.claudePid).toBe(4242);
    expect(after.state).toBe("waiting");
    expect(after.pendingRequests).toEqual([
      { requestId: "approval-1", toolName: "Bash", input: { command: "touch example" } },
    ]);
    await second.request("respond", {
      requestId: randomUUID(),
      targetRequestId: "approval-1",
      response: { behavior: "allow", updatedInput: { command: "touch example" } },
    });
    expect(fake.responses).toHaveLength(1);
    expect(runner.snapshot().state).toBe("running");
    expect((await stat(descriptor.socketPath)).mode & 0o777).toBe(0o600);
  });

  it("reconciles a lost acknowledgement without sending the same message twice", async () => {
    const { fake, client } = await fixture();
    const first = await client();
    fake.sendHook = () => first.close();
    const command = { requestId: randomUUID(), text: "only once" };
    await expect(first.request("send", command)).rejects.toThrow("disconnected");
    const second = await client();
    const receipt = await second.request<CommandReceipt>("send", command);
    expect(receipt.status).toBe("completed");
    expect(fake.sends).toEqual([command]);
    await expect(
      second.request("send", { ...command, text: "different text" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("serializes concurrent commands and rejects another turn while running or waiting", async () => {
    const { fake, client } = await fixture();
    const connection = await client();
    const commands = await Promise.allSettled([
      connection.request("send", { requestId: randomUUID(), text: "first" }),
      connection.request("send", { requestId: randomUUID(), text: "second" }),
    ]);
    expect(commands.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(fake.sends).toHaveLength(1);
    fake.emit("request", {
      request_id: "question-1",
      request: {
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Which option?" }] },
      },
    });
    await expect(
      connection.request("send", { requestId: randomUUID(), text: "third" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(connection.request("release")).rejects.toMatchObject({ code: "conflict" });
  });

  it("replays ordered events or sends a current snapshot when the cursor is too old", async () => {
    const { fake, runner, client } = await fixture({ replayByteLimit: 700 });
    const connection = await client();
    const messages: RpcMessage[] = [];
    connection.on("message", (message: RpcMessage) => messages.push(message));
    await connection.request("subscribe");
    expect(messages[0]).toMatchObject({
      type: "snapshot",
      snapshot: { runnerInstanceId: runner.runnerInstanceId },
    });
    const cursor = runner.snapshot().sequence;
    fake.emit("event", { type: "assistant", message: { content: "new output" } });
    const second = await client();
    const replay: RpcMessage[] = [];
    second.on("message", (message: RpcMessage) => replay.push(message));
    expect(
      await second.request("subscribe", {
        afterSequence: cursor,
        runnerInstanceId: runner.runnerInstanceId,
      }),
    ).toMatchObject({ resync: false });
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      type: "event",
      event: { sequence: cursor + 1, kind: "native" },
    });
    for (let i = 0; i < 10; i++)
      fake.emit("event", { type: "assistant", index: i, message: { content: "x".repeat(200) } });
    const third = await client();
    const resync: RpcMessage[] = [];
    third.on("message", (message: RpcMessage) => resync.push(message));
    expect(await third.request("subscribe", { afterSequence: cursor })).toMatchObject({
      resync: true,
    });
    expect(resync[0]).toMatchObject({
      type: "snapshot",
      snapshot: { sequence: runner.snapshot().sequence },
    });
    const fourth = await client();
    expect(
      await fourth.request("subscribe", {
        afterSequence: runner.snapshot().sequence,
        runnerInstanceId: "old-instance",
      }),
    ).toMatchObject({ resync: true });
  });

  it("retains completed output when the task finishes while disconnected", async () => {
    const { fake, runner, client } = await fixture();
    const first = await client();
    await first.request("send", { requestId: randomUUID(), text: "finish in background" });
    first.close();
    fake.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Done" }] },
    });
    fake.emit("event", { type: "result", subtype: "success", result: "Done" });
    const second = await client();
    const snapshot = await second.request<RunnerSnapshot>("snapshot");
    expect(snapshot.state).toBe("idle");
    expect(snapshot.currentEvents.at(-1)).toMatchObject({ type: "result", result: "Done" });
    expect(fake.stops).toBe(0);
    expect(runner.snapshot().runnerInstanceId).toBe(snapshot.runnerInstanceId);
    await second.request("send", { requestId: randomUUID(), text: "next turn" });
    expect(fake.sends).toHaveLength(2);
  });

  it("preserves uncertain command receipts across owner replacement and never blindly resends", async () => {
    const { descriptor, fake, runner, client } = await fixture();
    fake.autoEcho = false;
    const first = await client();
    const command = { requestId: randomUUID(), text: "uncertain delivery" };
    expect(await first.request<CommandReceipt>("send", command)).toMatchObject({
      status: "accepted",
    });
    await runner.close();
    const nextFake = new FakeClaude();
    const replacement = new SessionRunner(descriptor, { transportFactory: () => nextFake });
    await replacement.start();
    cleanup.push(async () => replacement.close());
    const second = await client();
    expect(await second.request<CommandReceipt>("send", command)).toMatchObject({
      status: "unknown",
    });
    expect(nextFake.sends).toHaveLength(0);
    const saved = JSON.parse(
      await readFile(join(descriptor.stateDirectory, "commands.json"), "utf8"),
    ) as CommandReceipt[];
    expect(saved).toContainEqual(
      expect.objectContaining({ requestId: command.requestId, status: "unknown" }),
    );
  });

  it("does not retry a command after the transport throws during delivery", async () => {
    const { fake, runner, client } = await fixture();
    fake.sendError = new Error("pipe closed");
    const connection = await client();
    const command = { requestId: randomUUID(), text: "may have been sent" };
    await expect(connection.request("send", command)).rejects.toMatchObject({
      code: "delivery_unknown",
    });
    expect(await connection.request<CommandReceipt>("send", command)).toMatchObject({
      status: "unknown",
    });
    expect(fake.sends).toHaveLength(1);
    expect(runner.snapshot().state).toBe("failed");
  });

  it("deduplicates permission responses and safely interrupts pending questions", async () => {
    const { fake, runner, client } = await fixture();
    const connection = await client();
    await connection.request("send", { requestId: randomUUID(), text: "needs input" });
    fake.emit("request", { request_id: "approve", request: { tool_name: "Bash", input: {} } });
    const answer = {
      requestId: randomUUID(),
      targetRequestId: "approve",
      response: { behavior: "deny", message: "No" },
    };
    await connection.request("respond", answer);
    await connection.request("respond", answer);
    expect(fake.responses).toHaveLength(1);
    fake.emit("request", {
      request_id: "question",
      request: { tool_name: "AskUserQuestion", input: {} },
    });
    const interrupt = { requestId: randomUUID() };
    await connection.request("interrupt", interrupt);
    await connection.request("interrupt", interrupt);
    expect(fake.interruptions).toBe(1);
    expect(runner.snapshot().pendingRequests).toEqual([]);
    expect(runner.snapshot().state).toBe("interrupted");
    await expect(
      connection.request("send", { requestId: randomUUID(), text: "too early" }),
    ).rejects.toMatchObject({ code: "conflict" });
    fake.emit("event", { type: "result", subtype: "error_during_execution" });
    await connection.request("send", { requestId: randomUUID(), text: "next turn" });
    expect(fake.sends).toHaveLength(2);
  });

  it("releases an idle owner explicitly and persists its terminal state", async () => {
    const { descriptor, fake, runner, client } = await fixture();
    const connection = await client();
    expect(await connection.request("release")).toEqual({ released: true });
    await runner.close();
    expect(fake.stops).toBe(1);
    const saved = JSON.parse(
      await readFile(join(descriptor.stateDirectory, "runner-state.json"), "utf8"),
    ) as RunnerSnapshot;
    expect(saved).toMatchObject({
      state: "closed",
      currentEvents: [],
      runnerInstanceId: runner.runnerInstanceId,
    });
    await expect(stat(descriptor.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not fail the owner when a permission is cancelled while its answer is admitted", async () => {
    const { fake, runner, client } = await fixture();
    const connection = await client();
    await connection.request("send", { requestId: randomUUID(), text: "needs permission" });
    fake.emit("request", {
      request_id: "cancelled-approval",
      request: { tool_name: "Bash", input: {} },
    });
    const answer = {
      requestId: randomUUID(),
      targetRequestId: "cancelled-approval",
      response: { behavior: "deny", message: "No" },
    };
    const pending = connection.request("respond", answer);
    await new Promise<void>((resolve) => {
      const check = () => {
        if (runner.snapshot().commands.some((command) => command.requestId === answer.requestId)) {
          fake.emit("requestCancelled", "cancelled-approval");
          resolve();
        } else setImmediate(check);
      };
      check();
    });
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    expect(fake.responses).toHaveLength(0);
    expect(runner.snapshot().state).toBe("running");
    expect(await connection.request<CommandReceipt>("respond", answer)).toMatchObject({
      status: "completed",
      error: "Request was cancelled before response dispatch",
    });
  });

  it("refuses a duplicate socket owner before rewriting any existing receipts", async () => {
    const { descriptor, fake, runner, client } = await fixture();
    fake.autoEcho = false;
    const connection = await client();
    const command = { requestId: randomUUID(), text: "stay running" };
    await connection.request("send", command);
    const duplicate = new SessionRunner(descriptor, { transportFactory: () => new FakeClaude() });
    await expect(duplicate.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    const saved = JSON.parse(
      await readFile(join(descriptor.stateDirectory, "commands.json"), "utf8"),
    ) as CommandReceipt[];
    expect(saved).toContainEqual(
      expect.objectContaining({ requestId: command.requestId, status: "accepted" }),
    );
    expect(runner.snapshot().state).toBe("running");
    expect(fake.stops).toBe(0);
  });

  it("never dispatches without a durable receipt and still closes after disk writes fail", async () => {
    const { descriptor, fake, runner, client } = await fixture();
    // A directory at the receipt filename simulates an atomic-rename failure.
    await mkdir(join(descriptor.stateDirectory, "commands.json"));
    const connection = await client();
    const command = { requestId: randomUUID(), text: "must not run" };
    await expect(connection.request("send", command)).rejects.toThrow();
    expect(fake.sends).toHaveLength(0);
    expect(await connection.request<CommandReceipt>("send", command)).toMatchObject({
      status: "unknown",
    });
    await expect(runner.close()).rejects.toThrow();
    expect(fake.stops).toBe(1);
    await expect(stat(descriptor.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds snapshots and disconnects an oversized socket line without harming Claude", async () => {
    const { descriptor, fake, runner } = await fixture({
      maxLineBytes: 128,
      snapshotByteLimit: 500,
    });
    for (let i = 0; i < 10; i++) fake.emit("event", { type: "assistant", text: "x".repeat(300) });
    expect(runner.snapshot().currentEvents[0]).toEqual({ type: "claudenest_history_required" });
    expect(runner.snapshot().currentEvents.length).toBeLessThan(10);
    const socket = connect(descriptor.socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("x".repeat(256));
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(fake.stops).toBe(0);
    expect(runner.snapshot().state).toBe("idle");
  });
});

describe("additive protocol-1 features", () => {
  it("advertises model controls and deduplicates idle-only settings changes", async () => {
    const { fake, runner, client } = await fixture();
    const connection = await client();
    expect(await connection.request("hello")).toMatchObject({
      protocolVersion: 1,
      capabilities: { setModel: true, setPermissionMode: true },
      supportedModels: fake.supportedModels,
    });
    const update = { requestId: randomUUID(), model: "opus" };
    await connection.request("setModel", update);
    await connection.request("setModel", update);
    expect(fake.modelChanges).toBe(1);
    await connection.request("setPermissionMode", {
      requestId: randomUUID(),
      permissionMode: "acceptEdits",
    });
    expect(runner.snapshot()).toMatchObject({ model: "opus", permissionMode: "acceptEdits" });
    await connection.request("send", { requestId: randomUUID(), text: "work" });
    await expect(
      connection.request("setModel", { requestId: randomUUID(), model: "sonnet" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("keeps a healthy owner usable after a native setting rejection", async () => {
    const { fake, runner, client } = await fixture();
    fake.rejectModel = true;
    const connection = await client();
    const update = { requestId: randomUUID(), model: "missing" };
    await expect(connection.request("setModel", update)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(runner.snapshot().state).toBe("idle");
    expect(await connection.request("setModel", update)).toMatchObject({
      status: "completed",
      error: "Model unavailable",
    });
    await connection.request("send", { requestId: randomUUID(), text: "still works" });
    expect(fake.sends).toHaveLength(1);
  });
  it("builds native images from bounded uploaded refs while retaining file cards", async () => {
    const { directory, descriptor, fake, client } = await fixture();
    descriptor.attachmentRoot = join(directory, "uploads");
    await mkdir(descriptor.attachmentRoot);
    const image = join(descriptor.attachmentRoot, "picture.png");
    const file = join(descriptor.attachmentRoot, "notes.txt");
    await writeFile(image, "image bytes");
    await writeFile(file, "notes");
    const connection = await client();
    const command = {
      requestId: randomUUID(),
      text: "inspect",
      files: [
        { id: randomUUID(), name: "notes.txt", path: file, size: 5, mediaType: "text/plain" },
      ],
      images: [
        { id: randomUUID(), name: "picture.png", path: image, size: 11, mediaType: "image/png" },
      ],
    };
    await connection.request("send", command);
    await connection.request("send", command);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.content).toContainEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: Buffer.from("image bytes").toString("base64"),
      },
    });
    expect(fake.sends[0]!.text).toContain(file);
    expect(JSON.stringify(command)).not.toContain(Buffer.from("image bytes").toString("base64"));
  });
  it("rejects paths outside uploads and oversized images before persisting dispatch intent", async () => {
    const { directory, descriptor, fake, runner, client } = await fixture();
    descriptor.attachmentRoot = join(directory, "uploads");
    await mkdir(descriptor.attachmentRoot);
    const connection = await client();
    const outside = join(directory, "outside.png");
    await writeFile(outside, "x");
    await expect(
      connection.request("send", {
        requestId: randomUUID(),
        text: "",
        images: [
          { id: randomUUID(), name: "outside.png", path: outside, size: 1, mediaType: "image/png" },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const huge = join(descriptor.attachmentRoot, "huge.png");
    await writeFile(huge, Buffer.alloc(9 * 1024 * 1024));
    await expect(
      connection.request("send", {
        requestId: randomUUID(),
        text: "",
        images: [
          {
            id: randomUUID(),
            name: "huge.png",
            path: huge,
            size: 9 * 1024 * 1024,
            mediaType: "image/png",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.sends).toHaveLength(0);
    expect(runner.snapshot().commands).toEqual([]);
    expect(runner.snapshot().state).toBe("idle");
  });
});
