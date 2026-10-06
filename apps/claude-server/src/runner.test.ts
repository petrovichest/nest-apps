import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  livePermissionMode = true;
  supportedModels = [{ value: "sonnet", displayName: "Sonnet", description: "Test model" }];
  modelChanges = 0;
  permissionChanges = 0;
  rejectModel = false;
  rejectPermission = false;
  permissionHook?: () => void;
  interruptHook?: () => void;

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
    this.interruptHook?.();
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
    if (this.rejectPermission) throw new ClaudeControlRejectedError("Permission mode rejected");
    this.permissionHook?.();
    this.permissionChanges++;
    this.permissionMode = mode;
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
      {
        requestId: "approval-1",
        toolName: "Bash",
        input: { command: "touch example" },
        kind: "toolApproval",
      },
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

  it("records receipt times once and preserves them in live events, replay and snapshots", async () => {
    const { fake, runner, client } = await fixture();
    const first = await client();
    const live: RpcMessage[] = [];
    first.on("message", (message: RpcMessage) => live.push(message));
    await first.request("subscribe");
    const cursor = runner.snapshot().sequence;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const start = { type: "stream_event", event: { type: "message_start" } };
    fake.emit("event", start);
    now.mockReturnValue(2_000);
    fake.emit("event", { type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    now.mockReturnValue(3_000);
    fake.emit("event", { type: "assistant", message: { content: "Done" } });
    now.mockReturnValue(4_000);
    fake.emit("event", { type: "result", subtype: "success", result: "Done" });
    const expected = runner.snapshot().currentEvents;
    expect(expected.map((event) => event.timestamp)).toEqual([1_000, 2_000, 3_000, 4_000]);
    expect(start).not.toHaveProperty("timestamp");
    now.mockReturnValue(99_000);
    const second = await client();
    const replay: RpcMessage[] = [];
    second.on("message", (message: RpcMessage) => replay.push(message));
    await second.request("subscribe", {
      afterSequence: cursor,
      runnerInstanceId: runner.runnerInstanceId,
    });
    const nativeData = (messages: RpcMessage[]) =>
      messages.flatMap((message) =>
        message.type === "event" && message.event.kind === "native" ? [message.event.data] : [],
      );
    expect(nativeData(live)).toEqual(expected);
    expect(nativeData(replay)).toEqual(expected);
    expect((await second.request<RunnerSnapshot>("snapshot")).currentEvents).toEqual(expected);
    expect(now).toHaveBeenCalledTimes(4);
  });

  it("preserves valid native timestamps and replaces invalid ones on receipt", async () => {
    const { fake, runner } = await fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(8_000);
    for (const timestamp of [0, 1_000, "2026-10-06T00:47:00.000Z", null, "invalid", NaN, Infinity])
      fake.emit("event", { type: "assistant", timestamp, message: { content: "Text" } });
    expect(runner.snapshot().currentEvents.map((event) => event.timestamp)).toEqual([
      0,
      1_000,
      "2026-10-06T00:47:00.000Z",
      8_000,
      8_000,
      8_000,
      8_000,
    ]);
    expect(now).toHaveBeenCalledTimes(4);
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
  it("lets steer atomically start an idle task and waits for an interrupted task's terminal result", async () => {
    const { fake, runner, client } = await fixture();
    const connection = await client(),
      initialId = randomUUID();
    const states: Array<{ state?: string; awaitingResult?: boolean }> = [];
    connection.on("message", (message: RpcMessage) => {
      if ("event" in message && message.event.kind === "state")
        states.push(message.event.data as { state?: string; awaitingResult?: boolean });
    });
    await connection.request("subscribe");
    await connection.request("steer", { requestId: initialId, text: "Start from idle" });
    expect(runner.snapshot().state).toBe("running");
    expect(runner.snapshot().currentEvents[0]).toMatchObject({ type: "user", uuid: initialId });
    expect(runner.snapshot().currentEvents[0]).not.toHaveProperty("claudenest_delivery");
    await connection.request("interrupt", { requestId: randomUUID() });
    expect(runner.snapshot()).toMatchObject({ state: "interrupted", awaitingResult: true });
    await expect(
      connection.request("steer", { requestId: randomUUID(), text: "Too early" }),
    ).rejects.toMatchObject({ code: "conflict" });
    fake.emit("event", {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_tools",
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
    });
    expect(runner.snapshot()).toMatchObject({ state: "interrupted", awaitingResult: false });
    await expect
      .poll(() =>
        states
          .filter((event) => event.state === "interrupted")
          .map((event) => event.awaitingResult),
      )
      .toEqual([true, false]);
    const nextId = randomUUID();
    await connection.request("steer", { requestId: nextId, text: "Start after interruption" });
    expect(runner.snapshot().state).toBe("running");
    expect(runner.snapshot().currentEvents).toHaveLength(1);
    expect(runner.snapshot().currentEvents[0]).toMatchObject({ type: "user", uuid: nextId });
    expect(fake.interruptions).toBe(1);
  });

  it("keeps a cancelled unacknowledged steer uncertain and does not attach another task's result to it", async () => {
    const { fake, runner, client } = await fixture();
    const connection = await client();
    await connection.request("send", { requestId: randomUUID(), text: "Original" });
    fake.autoEcho = false;
    const steer = { requestId: randomUUID(), text: "Queued native refinement" };
    await connection.request("steer", steer);
    fake.emit("event", { type: "result", subtype: "success" });
    expect(runner.snapshot().state).toBe("running");
    fake.emit("event", {
      type: "system",
      subtype: "command_lifecycle",
      command_uuid: steer.requestId,
      state: "cancelled",
    });
    expect(runner.snapshot().state).toBe("idle");
    expect(await connection.request("steer", steer)).toMatchObject({
      kind: "steer",
      status: "unknown",
    });
    expect(fake.sends).toHaveLength(2);
  });

  it("uses validated local images and files for steering without resetting the ongoing task", async () => {
    const { directory, descriptor, fake, runner, client } = await fixture();
    descriptor.attachmentRoot = join(directory, "uploads");
    await mkdir(descriptor.attachmentRoot);
    const path = join(descriptor.attachmentRoot, "image.png");
    await writeFile(path, "small image");
    const connection = await client(),
      initialId = randomUUID();
    await connection.request("send", { requestId: initialId, text: "Original task" });
    const steer = {
      requestId: randomUUID(),
      text: "Use this image too",
      images: [{ id: randomUUID(), path, name: "image.png", size: 11, mediaType: "image/png" }],
    };
    await connection.request("steer", steer);
    await connection.request("steer", steer);
    expect(fake.sends).toHaveLength(2);
    expect(fake.sends[1]!.content).toContainEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: Buffer.from("small image").toString("base64"),
      },
    });
    expect(runner.snapshot().currentEvents[0]).toMatchObject({ uuid: initialId });
    expect(fake.interruptions).toBe(0);
  });

  it("steers a running task once after a lost acknowledgement without interrupting or resetting its output", async () => {
    const { fake, runner, client } = await fixture();
    const first = await client();
    expect(runner.snapshot().capabilities).toMatchObject({ steer: true, livePermissionMode: true });
    await first.request("send", { requestId: randomUUID(), text: "Original task" });
    fake.emit("event", {
      type: "assistant",
      message: { id: "partial", content: [{ type: "text", text: "Existing progress" }] },
    });
    const steer = { requestId: randomUUID(), text: "Keep working, refine the final answer" };
    fake.sendHook = () => first.close();
    await expect(first.request("steer", steer)).rejects.toThrow("disconnected");
    const next = await client();
    expect(await next.request("steer", steer)).toMatchObject({
      requestId: steer.requestId,
      kind: "steer",
      status: "completed",
    });
    expect(fake.sends.map((input) => input.text)).toEqual(["Original task", steer.text]);
    expect(fake.interruptions).toBe(0);
    expect(runner.snapshot().state).toBe("running");
    expect(runner.snapshot().currentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant",
          message: expect.objectContaining({ id: "partial" }),
        }),
        expect.objectContaining({
          type: "user",
          uuid: steer.requestId,
          claudenest_delivery: "steer",
        }),
      ]),
    );
    await expect(next.request("steer", { ...steer, text: "Changed" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("associates each steering receipt with its echoed UUID rather than another task's result", async () => {
    const { fake, runner, client } = await fixture();
    fake.autoEcho = false;
    const connection = await client(),
      original = randomUUID(),
      first = randomUUID(),
      second = randomUUID();
    await connection.request("send", { requestId: original, text: "Original" });
    await connection.request("steer", { requestId: first, text: "First refinement" });
    await connection.request("steer", { requestId: second, text: "Second refinement" });
    fake.emit("event", { type: "user", uuid: second, message: { content: "Second refinement" } });
    fake.emit("event", { type: "result", subtype: "success" });
    expect(runner.snapshot().commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: original, status: "completed" }),
        expect.objectContaining({ requestId: first, status: "accepted" }),
        expect.objectContaining({ requestId: second, status: "completed" }),
      ]),
    );
    expect(runner.snapshot().state).toBe("running");
    await expect(
      connection.request("send", { requestId: randomUUID(), text: "Too early" }),
    ).rejects.toMatchObject({ code: "conflict" });
    fake.emit("event", { type: "user", uuid: first, message: { content: "First refinement" } });
    fake.emit("event", { type: "result", subtype: "success" });
    expect(runner.snapshot().state).toBe("idle");
    expect(runner.snapshot().commands.find((receipt) => receipt.requestId === first)?.status).toBe(
      "completed",
    );
  });

  it("accepts steering while waiting for a question and preserves that question", async () => {
    const { fake, runner, client } = await fixture();
    const connection = await client();
    await connection.request("send", { requestId: randomUUID(), text: "Question task" });
    fake.emit("request", {
      request_id: "question",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [] } },
    });
    await connection.request("steer", { requestId: randomUUID(), text: "Additional context" });
    expect(runner.snapshot().state).toBe("waiting");
    expect(runner.snapshot().pendingRequests).toMatchObject([
      { requestId: "question", kind: "userQuestion" },
    ]);
    expect(fake.responses).toEqual([]);
    expect(fake.interruptions).toBe(0);
  });

  it("changes permissions during active work and allows tools while keeping user questions pending", async () => {
    const { fake, runner, client } = await fixture();
    const connection = await client();
    await connection.request("send", { requestId: randomUUID(), text: "Active work" });
    fake.emit("request", {
      request_id: "approval",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" } },
    });
    fake.emit("request", {
      request_id: "question",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [] } },
    });
    const update = { requestId: randomUUID(), permissionMode: "bypassPermissions" };
    await connection.request("setPermissionMode", update);
    await connection.request("setPermissionMode", update);
    expect(fake.permissionChanges).toBe(1);
    expect(fake.responses).toEqual([
      { requestId: "approval", response: { behavior: "allow", updatedInput: { command: "pwd" } } },
    ]);
    expect(runner.snapshot()).toMatchObject({
      permissionMode: "bypassPermissions",
      state: "waiting",
      pendingRequests: [{ requestId: "question", kind: "userQuestion" }],
    });
    fake.emit("request", {
      request_id: "read",
      request: { subtype: "can_use_tool", tool_name: "Read", input: { file_path: "a.ts" } },
    });
    expect(fake.responses.at(-1)).toEqual({
      requestId: "read",
      response: { behavior: "allow", updatedInput: { file_path: "a.ts" } },
    });
    expect(runner.snapshot().pendingRequests).toHaveLength(1);
  });

  it("does not allow a tool after rejection or cancellation of its permission change", async () => {
    const { fake, runner, client } = await fixture();
    const connection = await client();
    await connection.request("send", { requestId: randomUUID(), text: "Work" });
    fake.emit("request", {
      request_id: "approval",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" } },
    });
    fake.rejectPermission = true;
    await expect(
      connection.request("setPermissionMode", {
        requestId: randomUUID(),
        permissionMode: "bypassPermissions",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(runner.snapshot().state).toBe("waiting");
    expect(fake.responses).toEqual([]);
    fake.rejectPermission = false;
    fake.permissionHook = () => fake.emit("requestCancelled", "approval");
    await connection.request("setPermissionMode", {
      requestId: randomUUID(),
      permissionMode: "bypassPermissions",
    });
    expect(fake.responses).toEqual([]);
    expect(runner.snapshot().pendingRequests).toEqual([]);
    expect(runner.snapshot().state).toBe("running");
  });

  it("cleans a synchronous interruption result without failing the owner or retaining pending questions", async () => {
    const { fake, runner, client } = await fixture();
    const connection = await client();
    await connection.request("send", { requestId: randomUUID(), text: "Work" });
    fake.emit("request", {
      request_id: "question",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: {} },
    });
    fake.interruptHook = () =>
      fake.emit("event", {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] Request interrupted by user"],
      });
    await connection.request("interrupt", { requestId: randomUUID() });
    expect(runner.snapshot()).toMatchObject({ state: "interrupted", pendingRequests: [] });
    expect(runner.snapshot().currentEvents.at(-1)).toMatchObject({
      type: "result",
      claudenest_interrupted: true,
    });
    await connection.request("send", { requestId: randomUUID(), text: "Next task" });
    expect(runner.snapshot().state).toBe("running");
    expect(fake.stops).toBe(0);
  });

  it("publishes uncertain delivery and removes stale questions when the native owner fails", async () => {
    const { fake, runner, client } = await fixture();
    fake.autoEcho = false;
    const connection = await client(),
      requestId = randomUUID();
    const frames: RpcMessage[] = [];
    connection.on("message", (message) => frames.push(message));
    await connection.request("subscribe");
    await connection.request("send", { requestId, text: "Work" });
    fake.emit("request", {
      request_id: "question",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: {} },
    });
    fake.emit("error", new Error("Native pipe failed"));
    await expect
      .poll(() =>
        frames.some(
          (message) =>
            "event" in message &&
            message.event.kind === "command" &&
            (message.event.data as CommandReceipt).requestId === requestId &&
            (message.event.data as CommandReceipt).status === "unknown",
        ),
      )
      .toBe(true);
    expect(runner.snapshot()).toMatchObject({ state: "failed", pendingRequests: [] });
    fake.emit("request", {
      request_id: "late-question",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: {} },
    });
    expect(runner.snapshot().pendingRequests).toEqual([]);
    expect(fake.responses).toEqual([]);
    expect(await connection.request("release")).toEqual({ released: true });
  });

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
