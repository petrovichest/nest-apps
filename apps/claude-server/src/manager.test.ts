import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { SessionManager, type SessionLauncher } from "./manager.js";
import { SessionRunner, type RunnerTransport } from "./runner.js";
import type { CommandReceipt, RunnerDescriptor } from "./types.js";

class FakeClaude extends EventEmitter implements RunnerTransport {
  readonly pid = 600001;
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

class FakeLauncher implements SessionLauncher {
  readonly owners = new Map<string, { runner: SessionRunner; transport: FakeClaude }>();
  starts = 0;
  loseNextLaunchAcknowledgement = false;
  readonly unavailableOwners = new Set<string>();
  async available(): Promise<void> {}
  async active(id: string): Promise<boolean> {
    return (
      this.unavailableOwners.has(id) ||
      (this.owners.has(id) && this.owners.get(id)!.runner.snapshot().state !== "closed")
    );
  }
  async start(descriptor: RunnerDescriptor): Promise<void> {
    this.starts++;
    const transport = new FakeClaude();
    const runner = new SessionRunner(descriptor, {
      transportFactory: () => transport,
      claudeVersion: "fake-2.1.289",
    });
    this.owners.set(descriptor.sessionId, { runner, transport });
    await runner.start();
    if (this.loseNextLaunchAcknowledgement) {
      this.loseNextLaunchAcknowledgement = false;
      throw new Error("Simulated lost launch acknowledgement");
    }
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const directory = await mkdtemp("/tmp/cnm-");
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
  const launcher = new FakeLauncher();
  const managers: SessionManager[] = [];
  cleanup.push(async () => {
    for (const manager of managers) await manager.close();
    for (const { runner } of launcher.owners.values()) await runner.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function backend() {
    const manager = new SessionManager(config, launcher);
    managers.push(manager);
    await manager.initialize();
    return manager;
  }
  const input = {
    sessionId: randomUUID(),
    requestId: randomUUID(),
    cwd: directory,
    prompt: "Do the work",
  };
  return { directory, config, launcher, backend, input };
}

describe("Claude backend manager integration", () => {
  it("steers a live owner durably without launching, interrupting, or resetting its native task", async () => {
    const { backend, launcher, input } = await fixture();
    const manager = await backend();
    await manager.create(input);
    const owner = launcher.owners.get(input.sessionId)!,
      before = await manager.snapshot(input.sessionId),
      requestId = randomUUID();
    expect(
      await manager.steer(input.sessionId, requestId, "Refine the final answer"),
    ).toMatchObject({ requestId, kind: "steer", status: "completed" });
    await manager.steer(input.sessionId, requestId, "Refine the final answer");
    expect(launcher.starts).toBe(1);
    expect(owner.transport.sends).toEqual([
      { requestId: input.requestId, text: input.prompt },
      { requestId, text: "Refine the final answer" },
    ]);
    expect(await manager.snapshot(input.sessionId)).toMatchObject({
      runnerInstanceId: before.runnerInstanceId,
      state: "running",
      capabilities: { steer: true },
    });
    expect(owner.transport.stops).toBe(0);
    await expect(
      manager.steer(input.sessionId, requestId, "Changed refinement"),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not start an owner to replay steering when no live owner exists", async () => {
    const { backend, launcher, input } = await fixture();
    const manager = await backend();
    await expect(
      manager.steer(input.sessionId, randomUUID(), "Busy refinement"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(launcher.starts).toBe(0);
  });

  it("serializes creation retries and refuses conflicting creation input without another launch", async () => {
    const { backend, launcher, input } = await fixture();
    const manager = await backend();
    const [first, retry] = await Promise.all([manager.create(input), manager.create(input)]);
    expect(first).toEqual(retry);
    expect(first).toMatchObject({ requestId: input.requestId, status: "completed" });
    expect(launcher.starts).toBe(1);
    expect(launcher.owners.get(input.sessionId)?.transport.sends).toEqual([
      { requestId: input.requestId, text: input.prompt },
    ]);
    await expect(manager.create({ ...input, prompt: "Changed prompt" })).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    expect(launcher.starts).toBe(1);
  });

  it("reconciles a launch that succeeded before its acknowledgement was lost, including after backend recreation", async () => {
    const { backend, launcher, input } = await fixture();
    const first = await backend();
    launcher.loseNextLaunchAcknowledgement = true;
    await expect(first.create(input)).rejects.toThrow("lost launch acknowledgement");
    const owner = launcher.owners.get(input.sessionId)!;
    const before = owner.runner.snapshot();
    expect(owner.transport.sends).toEqual([]);
    await first.close();
    const replacement = await backend();
    const receipt = (await replacement.create(input)) as CommandReceipt;
    expect(receipt.status).toBe("completed");
    expect(launcher.starts).toBe(1);
    expect(owner.transport.sends).toEqual([{ requestId: input.requestId, text: input.prompt }]);
    expect(await replacement.snapshot(input.sessionId)).toMatchObject({
      runnerInstanceId: before.runnerInstanceId,
      runnerPid: before.runnerPid,
      claudePid: before.claudePid,
    });
  });

  it("reconnects to the same owner and preserves permissions raised during backend downtime", async () => {
    const { backend, launcher, input } = await fixture();
    const first = await backend();
    await first.create(input);
    const before = await first.snapshot(input.sessionId);
    const owner = launcher.owners.get(input.sessionId)!;
    await first.close();
    owner.transport.emit("request", {
      request_id: "permission-while-offline",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "pwd" },
      },
    });
    owner.transport.emit("event", {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { text: "work continues" },
      },
    });
    const replacement = await backend();
    const after = await replacement.snapshot(input.sessionId);
    expect(after).toMatchObject({
      runnerInstanceId: before.runnerInstanceId,
      runnerPid: before.runnerPid,
      claudePid: before.claudePid,
      state: "waiting",
      pendingRequests: [
        { requestId: "permission-while-offline", toolName: "Bash", input: { command: "pwd" } },
      ],
    });
    expect(after.sequence).toBeGreaterThan(before.sequence);
    await replacement.command(input.sessionId, "respond", {
      requestId: randomUUID(),
      targetRequestId: "permission-while-offline",
      response: { behavior: "allow", updatedInput: { command: "pwd" } },
    });
    expect(owner.transport.responses).toEqual([
      {
        requestId: "permission-while-offline",
        response: { behavior: "allow", updatedInput: { command: "pwd" } },
      },
    ]);
    expect(owner.transport.stops).toBe(0);
    expect(launcher.starts).toBe(1);
  });

  it("rejects an incompatible update and resumes acceptance without disturbing live runners", async () => {
    const { backend, launcher, input } = await fixture();
    const manager = await backend();
    await manager.create(input);
    const before = await manager.snapshot(input.sessionId);
    await expect(manager.prepare([2])).rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(manager.accepting).toBe(true);
    const owner = launcher.owners.get(input.sessionId)!;
    owner.transport.emit("event", { type: "result", subtype: "success" });
    await manager.send(input.sessionId, randomUUID(), "Next explicit turn");
    expect(owner.transport.sends).toHaveLength(2);
    expect(await manager.snapshot(input.sessionId)).toMatchObject({
      runnerInstanceId: before.runnerInstanceId,
    });
    expect(owner.transport.stops).toBe(0);
    expect(await manager.prepare([1])).toMatchObject({
      runners: 1,
      releasePaths: [before.releasePath],
    });
    expect(manager.accepting).toBe(false);
    await expect(
      manager.send(input.sessionId, randomUUID(), "Blocked while draining"),
    ).rejects.toMatchObject({ code: "unavailable", status: 503 });
    manager.resume();
    expect(manager.accepting).toBe(true);
  });

  it("refuses to replace an owner reported active but unreachable", async () => {
    const { backend, launcher, input } = await fixture();
    const first = await backend();
    await first.create(input);
    await first.close();
    await launcher.owners.get(input.sessionId)!.runner.close();
    launcher.unavailableOwners.add(input.sessionId);
    const replacement = await backend();
    await expect(replacement.create(input)).rejects.toMatchObject({
      code: "unavailable",
      status: 503,
    });
    expect(launcher.starts).toBe(1);
  });

  it.each(["previous", "explicit"] as const)(
    "resumes native history with %s launch preferences after its old owner exits",
    async (preferenceSource) => {
      const { directory, config, backend, launcher, input } = await fixture();
      // This executable only serves a fake empty roster; model work stays in FakeClaude.
      config.claudeBin = join(directory, "fake-claude-roster");
      await writeFile(
        config.claudeBin,
        '#!/bin/sh\nif [ "$1" = agents ] && [ "$2" = --json ]; then printf \'[]\'; else exit 99; fi\n',
        { mode: 0o700 },
      );
      const first = await backend();
      await first.create({ ...input, model: "opus", effort: "high", permissionMode: "manual" });
      const previous = launcher.owners.get(input.sessionId)!;
      previous.transport.emit("event", { type: "result", subtype: "success" });
      await first.close();
      await previous.runner.close();
      const historyDirectory = join(config.configDir, "projects", "native-project");
      await mkdir(historyDirectory, { recursive: true });
      await writeFile(
        join(historyDirectory, `${input.sessionId}.jsonl`),
        JSON.stringify({
          type: "user",
          uuid: input.requestId,
          sessionId: input.sessionId,
          cwd: directory,
          message: { role: "user", content: input.prompt },
        }) + "\n",
      );
      const replacement = await backend();
      const requestId = randomUUID();
      const launch =
        preferenceSource === "explicit"
          ? { model: "sonnet", effort: "medium", permissionMode: "acceptEdits" as const }
          : undefined;
      expect(
        await replacement.send(
          input.sessionId,
          requestId,
          "Continue native history",
          undefined,
          launch,
        ),
      ).toMatchObject({ requestId, status: "completed" });
      expect(launcher.starts).toBe(2);
      const resumed = launcher.owners.get(input.sessionId)!;
      expect(resumed.runner.descriptor).toMatchObject({
        sessionId: input.sessionId,
        cwd: directory,
        resume: true,
        ...(launch ?? { model: "opus", effort: "high", permissionMode: "manual" }),
      });
      expect(resumed.transport.sends).toEqual([{ requestId, text: "Continue native history" }]);
      expect(previous.transport.sends).toHaveLength(1);
      expect(resumed.runner.snapshot().runnerInstanceId).not.toBe(
        previous.runner.snapshot().runnerInstanceId,
      );
    },
  );
});
