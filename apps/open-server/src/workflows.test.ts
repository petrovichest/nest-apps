import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_TOOL_NAMES } from "@codexnest/protocol";
import type { ManagedTeamTaskState, TeamOrchestrationState } from "../../server/src/state/store";
import { paths, type Config } from "./config";
import { Engine } from "./engine";
import type { OpenCodeClient } from "./opencode";
import type { NativeMessage } from "./projection";
import { Workflows } from "./workflows";
import { MANAGED_FILESYSTEM_TOOLS } from "./tool-policy";

type Call = { method: string; path: string; directory?: string; body?: any };
class NativeFixture {
  calls: Call[] = [];
  sessions = new Map<
    string,
    { id: string; directory: string; title: string; time: { created: number; updated: number } }
  >();
  messages = new Map<string, NativeMessage[]>();
  statuses = new Map<string, { type: string }>();
  count = 0;
  beforeAck?: (id: string) => Promise<void>;
  async health() {
    return { healthy: true, version: "1.19.5" };
  }
  async request<T>(
    method: string,
    path: string,
    options: { directory?: string; body?: any } = {},
  ): Promise<T> {
    this.calls.push({ method, path, ...structuredClone(options) });
    let result: unknown;
    if (path === "/provider")
      result = {
        connected: ["openrouter"],
        default: { openrouter: "vendor/test" },
        all: [{ id: "openrouter", models: { "vendor/test": { name: "Fixture", variants: {} } } }],
      };
    else if (path === "/session/status")
      result = Object.fromEntries(
        [...this.statuses].filter(([id]) => this.sessions.get(id)?.directory === options.directory),
      );
    else if (path === "/permission" || path === "/question") result = [];
    else if (
      (path === "/session" || path.startsWith("/session?") || path === "/experimental/session") &&
      method === "GET"
    )
      result = [...this.sessions.values()].filter(
        (session) => path === "/experimental/session" || session.directory === options.directory,
      );
    else if (path === "/session" && method === "POST") {
      const time = Date.now() + ++this.count;
      const session = {
        id: `ses_fixture_${this.count}`,
        directory: options.directory!,
        title: options.body?.title ?? "Fixture",
        time: { created: time, updated: time },
      };
      this.sessions.set(session.id, session);
      this.messages.set(session.id, []);
      result = session;
    } else if (path.endsWith("/prompt_async")) {
      const id = path.split("/")[2]!;
      const time = Date.now() + this.count;
      this.messages.get(id)!.push({
        info: {
          id: options.body.messageID,
          sessionID: id,
          role: "user",
          time: { created: time },
        },
        parts: options.body.parts.map((part: any, index: number) => ({
          ...part,
          id: `${options.body.messageID}_${index}`,
        })),
      });
      this.statuses.set(id, { type: "busy" });
      if (this.beforeAck) await this.beforeAck(id);
    } else if (/^\/session\/[^/]+\/message$/.test(path) && method === "GET")
      result = this.messages.get(path.split("/")[2]!) ?? [];
    else if (path.endsWith("/abort")) {
      this.statuses.delete(path.split("/")[2]!);
      result = true;
    } else if (path === "/instance/dispose" || method === "PATCH") result = true;
    else throw new Error(`Unsupported fixture route ${method} ${path}`);
    return structuredClone(result) as T;
  }
  prompts(id?: string) {
    return this.calls.filter(
      (call) =>
        call.path.endsWith("/prompt_async") && (!id || call.path === `/session/${id}/prompt_async`),
    );
  }
  async finish(
    engine: Engine,
    id: string,
    answer: string,
    tokens?: NativeMessage["info"]["tokens"],
    failed = false,
  ) {
    const parent = this.messages.get(id)!.findLast((message) => message.info.role === "user")!;
    const now = Math.max(Date.now() + this.count, parent.info.time!.created! + 1);
    const assistant: NativeMessage = {
      info: {
        id: `reply_${parent.info.id}`,
        sessionID: id,
        parentID: parent.info.id,
        role: "assistant",
        finish: "stop",
        time: { created: now, completed: now + 10 },
        ...(tokens ? { tokens } : {}),
        ...(failed ? { error: { name: "FixtureFailure" } } : {}),
      },
      parts: [
        {
          id: `part_${parent.info.id}`,
          sessionID: id,
          messageID: `reply_${parent.info.id}`,
          type: "text",
          text: answer,
        },
      ],
    };
    this.messages.get(id)!.push(assistant);
    this.statuses.delete(id);
    await engine.onNativeEvent({ type: "message.updated", properties: { info: assistant.info } });
    await engine.onNativeEvent({
      type: "message.part.updated",
      properties: { part: assistant.parts[0]! },
    });
    await engine.onNativeEvent({ type: "session.idle", properties: { sessionID: id } });
  }
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
function attach(engine: Engine) {
  const workflows = new Workflows(engine);
  engine.setWorkflowHooks({
    validateSend: (id, input) => workflows.validateSend(id, input),
    beforeDispatch: (id, input) => workflows.beforeDispatch(id, input),
    onIdle: (id) => workflows.onIdle(id),
    onInterrupted: (id) => workflows.interrupted(id),
    onUsage: (id) => workflows.onUsage(id),
    collaborationAgent: (mode) => (mode === "plan" ? "plan" : "build"),
    decorateDetail: (id, detail) => workflows.decorateDetail(id, detail),
    decorateSummary: (id, summary) => workflows.decorateSummary(id, summary),
  });
  return workflows;
}
async function setup() {
  const scratch = await mkdtemp(join(tmpdir(), "opennest-workflows-"));
  cleanup.push(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, "project");
  await mkdir(directory);
  const config: Config = {
    ...paths({
      OPENNEST_CONFIG_DIR: join(scratch, "config"),
      OPENNEST_STATE_DIR: join(scratch, "state"),
      OPENNEST_RUNTIME_DIR: join(scratch, "run"),
      OPENNEST_CLIENT_DIST: join(scratch, "no-client"),
    }),
    token: "t".repeat(64),
  };
  const native = new NativeFixture(),
    engine = new Engine(config, { native: native as unknown as OpenCodeClient });
  await engine.initialize({ watch: false });
  const workflows = attach(engine);
  await engine.reconcile();
  cleanup.push(() => engine.close());
  const project = await engine.addProject(directory),
    { thread } = await engine.createThread(project.id, "initial");
  return { scratch, config, native, engine, workflows, project, thread };
}
const tasks = (engine: Engine, id: string) =>
  (engine.thread(id).teamOrchestration as unknown as TeamOrchestrationState).tasks;
const goalReceipts = (engine: Engine, id: string) =>
  Object.keys(engine.thread(id).receipts).filter((id) => id.startsWith("goal:"));
const resultReceipts = (engine: Engine, id: string) =>
  Object.keys(engine.thread(id).receipts).filter((id) => id.startsWith("team-result:"));
async function initializeRepository(directory: string) {
  const git = promisify(execFile);
  await git("git", ["init", "--quiet", directory]);
  await writeFile(join(directory, "result.txt"), "Parent baseline\n");
  await git("git", ["-C", directory, "add", "result.txt"]);
  await git("git", [
    "-C",
    directory,
    "-c",
    "user.name=OpenNest Fixture",
    "-c",
    "user.email=50870093+petrovichest@users.noreply.github.com",
    "commit",
    "--quiet",
    "-m",
    "Fixture baseline",
  ]);
}

describe("durable OpenNest workflows", () => {
  it("continues an unfinished goal once per completed turn and treats duplicate idle callbacks idempotently", async () => {
    const { engine, workflows, native, thread } = await setup();
    await workflows.createGoal(thread.id, "Finish the fixture objective");
    await engine.send(thread.id, { input: "Start", clientMessageId: "start" });
    await native.finish(engine, thread.id, "Progress, more work remains");
    await vi.waitFor(() => expect(native.prompts(thread.id)).toHaveLength(2));
    await workflows.onIdle(thread.id);
    await workflows.onIdle(thread.id);
    expect(goalReceipts(engine, thread.id)).toHaveLength(1);
    expect(native.prompts(thread.id)).toHaveLength(2);
    await engine.interrupt(thread.id);
    expect(engine.thread(thread.id).goal?.status).toBe("paused");
  });
  it("persists exhausted token budgets and includes native disjoint cache/reasoning usage without double counting", async () => {
    const { engine, workflows, native, thread, config } = await setup();
    await workflows.createGoal(thread.id, "Stay within the requested budget", 100);
    await engine.send(thread.id, { input: "Start", clientMessageId: "budget" });
    await native.finish(engine, thread.id, "Budget consumed", {
      input: 20,
      output: 10,
      reasoning: 30,
      cache: { read: 30, write: 10 },
    });
    await vi.waitFor(() => expect(engine.thread(thread.id).goal?.status).toBe("budgetLimited"));
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(config.stateDir, "ui.json"), "utf8"));
      expect(saved.threads[thread.id].goal.status).toBe("budgetLimited");
    });
    expect(engine.thread(thread.id).goal?.tokensUsed).toBe(100);
    expect(native.prompts(thread.id)).toHaveLength(1);
    expect(goalReceipts(engine, thread.id)).toHaveLength(0);
    await engine.close();
    const restored = new Engine(config, { native: native as unknown as OpenCodeClient });
    cleanup.push(() => restored.close());
    await restored.initialize({ watch: false });
    attach(restored);
    await restored.reconcile();
    expect(restored.thread(thread.id).goal?.status).toBe("budgetLimited");
    expect(native.prompts(thread.id)).toHaveLength(1);
  });
  it("blocks only after three consecutive unchanged outcomes, rather than one model failure", async () => {
    const { engine, workflows, native, thread } = await setup();
    await workflows.createGoal(thread.id, "Make progress");
    await engine.send(thread.id, { input: "Start", clientMessageId: "repeated" });
    for (let attempt = 0; attempt < 3; attempt++) {
      await native.finish(engine, thread.id, "The same blocking condition", undefined, true);
      if (attempt < 2) {
        await vi.waitFor(() => expect(native.prompts(thread.id)).toHaveLength(attempt + 2));
        expect(engine.thread(thread.id).goal?.status).toBe("active");
      }
    }
    await vi.waitFor(() => expect(engine.thread(thread.id).goal?.status).toBe("blocked"));
    expect(native.prompts(thread.id)).toHaveLength(3);
    await workflows.updateGoal(thread.id, { status: "active" }, true);
    await vi.waitFor(() => expect(native.prompts(thread.id)).toHaveLength(4));
    for (let attempt = 0; attempt < 3; attempt++) {
      await native.finish(engine, thread.id, "The same blocking condition", undefined, true);
      if (attempt < 2) {
        await vi.waitFor(() => expect(native.prompts(thread.id)).toHaveLength(attempt + 5));
        expect(engine.thread(thread.id).goal?.status).toBe("active");
      }
    }
    await vi.waitFor(() => expect(engine.thread(thread.id).goal?.status).toBe("blocked"));
    expect(native.prompts(thread.id)).toHaveLength(6);
  });
  it("handles native terminal completion before HTTP acknowledgement without losing goal continuation", async () => {
    const { engine, workflows, native, thread } = await setup();
    await workflows.createGoal(thread.id, "Continue after a fast native completion");
    native.beforeAck = async (id) => {
      native.beforeAck = undefined;
      await native.finish(engine, id, "First phase completed");
    };
    await engine.send(thread.id, { input: "Start", clientMessageId: "fast" });
    await vi.waitFor(() => expect(native.prompts(thread.id)).toHaveLength(2));
    expect(goalReceipts(engine, thread.id)).toHaveLength(1);
    await engine.interrupt(thread.id);
  });
  it("creates application-managed read-only children and delivers submitted results exactly once without native subagents", async () => {
    const { engine, workflows, native, thread, config } = await setup();
    await engine.settings(thread.id, { collaborationMode: "team" });
    const result = (await workflows.tool(
      thread.id,
      "spawn_task",
      { title: "Read the fixture", prompt: "Inspect only" },
      "spawn-one",
    )) as ManagedTeamTaskState;
    const task = tasks(engine, thread.id)[result.id]!;
    await vi.waitFor(() => expect(native.prompts(task.childThreadId)).toHaveLength(1));
    expect(task.access).toEqual({ mode: "readOnly", writePaths: [], network: false });
    const policy = JSON.parse(
      await readFile(join(config.stateDir, "tool-scopes", `${task.childThreadId}.json`), "utf8"),
    );
    expect(policy.mode).toBe("readOnly");
    expect(policy.network).toBe(false);
    expect(native.prompts(task.childThreadId)[0]!.body.tools).toBeUndefined();
    const permission = native.calls.findLast(
      (call) => call.method === "PATCH" && call.path === `/session/${task.childThreadId}`,
    )?.body.permission;
    expect(permission).toContainEqual({ permission: "task", pattern: "*", action: "deny" });
    for (const name of MANAGED_FILESYSTEM_TOOLS)
      expect(permission).toContainEqual({ permission: name, pattern: "*", action: "deny" });
    expect(native.prompts(task.childThreadId)[0]!.body.system).toContain("sandboxed bash");
    await expect(
      workflows.tool(task.childThreadId, "spawn_task", { title: "Nested", prompt: "No" }, "nested"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await workflows.tool(
      task.childThreadId,
      "submit_result",
      {
        summary: "Observed result",
        outcome: "success",
        checks: [{ name: "inspection", outcome: "passed" }],
      },
      "submitted",
    );
    await native.finish(engine, task.childThreadId, "Final response after structured result");
    await vi.waitFor(() => expect(task.delivery?.status).toBe("delivered"));
    expect(task.result?.source).toBe("submitted");
    expect(task.result?.summary).toBe("Observed result");
    await workflows.onIdle(task.childThreadId);
    await workflows.onIdle(task.childThreadId);
    expect(resultReceipts(engine, thread.id)).toHaveLength(1);
    expect(native.sessions.size).toBe(2);
    expect(
      native.calls.some((call) => call.path.includes("/task") || call.body?.agent === "explore"),
    ).toBe(false);
  });
  it("does not launch dependency children before predecessors finish and rejects unsafe scope", async () => {
    const { engine, workflows, native, thread } = await setup();
    await engine.settings(thread.id, { collaborationMode: "team" });
    const before = native.sessions.size;
    await expect(
      workflows.tool(
        thread.id,
        "spawn_task",
        {
          title: "Unsafe",
          prompt: "No",
          access: { mode: "sharedWrite", writePaths: ["../outside"] },
        },
        "invalid",
      ),
    ).rejects.toThrow();
    expect(native.sessions.size).toBe(before);
    const first = (await workflows.tool(
      thread.id,
      "spawn_task",
      { title: "First", prompt: "Inspect" },
      "dependency-first",
    )) as ManagedTeamTaskState;
    const next = (await workflows.tool(
      thread.id,
      "spawn_task",
      { title: "Next", prompt: "Use the predecessor result", dependsOn: [first.id] },
      "dependency-next",
    )) as ManagedTeamTaskState;
    expect(tasks(engine, thread.id)[next.id]!.childThreadId).toBe("");
    await vi.waitFor(() => expect(native.prompts(first.childThreadId)).toHaveLength(1));
    await native.finish(engine, first.childThreadId, "Predecessor result");
    await vi.waitFor(() => expect(tasks(engine, thread.id)[next.id]!.childThreadId).not.toBe(""));
    expect(tasks(engine, thread.id)[next.id]!.dependsOn).toEqual([first.id]);
    expect(native.sessions.size).toBe(3);
  });
  it.each(["partial", "blocked", "failed"])(
    "blocks a dependency after its predecessor submits a %s outcome",
    async (outcome) => {
      const { engine, workflows, native, thread } = await setup();
      await engine.settings(thread.id, { collaborationMode: "team" });
      const first = (await workflows.tool(
        thread.id,
        "spawn_task",
        { title: "Predecessor", prompt: "Inspect" },
        "predecessor",
      )) as ManagedTeamTaskState;
      const dependent = (await workflows.tool(
        thread.id,
        "spawn_task",
        { title: "Dependent", prompt: "Use a successful result", dependsOn: [first.id] },
        "dependent",
      )) as ManagedTeamTaskState;
      await workflows.tool(
        first.childThreadId,
        "submit_result",
        { summary: "The requested prerequisite was not achieved", outcome },
        "result",
      );
      await native.finish(
        engine,
        first.childThreadId,
        "Normal final answer describing the unsuccessful result",
      );
      await vi.waitFor(() => expect(tasks(engine, thread.id)[dependent.id]!.status).toBe("failed"));
      expect(tasks(engine, thread.id)[first.id]!.status).toBe("completed");
      expect(tasks(engine, thread.id)[dependent.id]!.result?.outcome).toBe("blocked");
      expect(tasks(engine, thread.id)[dependent.id]!.childThreadId).toBe("");
      expect(native.sessions.size).toBe(2);
    },
  );
  it.each(["isolatedWrite", "sharedWrite"])(
    "rejects nonexistent %s write scopes before creating a native child",
    async (mode) => {
      const { engine, workflows, native, thread } = await setup();
      await engine.settings(thread.id, { collaborationMode: "team" });
      await expect(
        workflows.tool(
          thread.id,
          "spawn_task",
          {
            title: "Create a file",
            prompt: "Write the result",
            access: { mode, writePaths: ["missing.txt"] },
          },
          "missing-scope",
        ),
      ).rejects.toThrow("existing parent-directory scope");
      expect(native.sessions.size).toBe(1);
      expect(engine.thread(thread.id).teamOrchestration).toBeUndefined();
    },
  );
  it("launches a dependent only after the real isolated workspace is integrated", async () => {
    const { engine, workflows, native, thread } = await setup();
    await initializeRepository(thread.cwd);
    await engine.settings(thread.id, { collaborationMode: "team" });
    const first = (await workflows.tool(
      thread.id,
      "spawn_task",
      {
        title: "Isolated edit",
        prompt: "Change the result",
        access: { mode: "isolatedWrite", writePaths: ["result.txt"] },
      },
      "isolated",
    )) as ManagedTeamTaskState;
    const task = tasks(engine, thread.id)[first.id]!;
    expect(task.workspace?.worktreePath).not.toBe(thread.cwd);
    await writeFile(join(task.workspace!.worktreePath, "result.txt"), "Child result\n");
    const next = (await workflows.tool(
      thread.id,
      "spawn_task",
      { title: "Dependent", prompt: "Use the integrated result", dependsOn: [first.id] },
      "next",
    )) as ManagedTeamTaskState;
    await native.finish(engine, first.childThreadId, "Completed the isolated change");
    await vi.waitFor(() => expect(task.delivery?.status).toBe("delivered"));
    expect(task.workspace!.changedPaths).toEqual(["result.txt"]);
    expect(tasks(engine, thread.id)[next.id]!.status).toBe("queued");
    expect(await readFile(join(thread.cwd, "result.txt"), "utf8")).toBe("Parent baseline\n");
    await workflows.tool(thread.id, "integrate_task", { taskId: first.id }, "integrate");
    expect(await readFile(join(thread.cwd, "result.txt"), "utf8")).toBe("Child result\n");
    expect(task.workspace!.lifecycle).toBe("integrated");
    await vi.waitFor(() => expect(tasks(engine, thread.id)[next.id]!.childThreadId).not.toBe(""));
    expect(native.sessions.size).toBe(3);
  });
  it("allows a dependency whose actual isolated workspace was discarded without changes", async () => {
    const { engine, workflows, native, thread } = await setup();
    await initializeRepository(thread.cwd);
    await engine.settings(thread.id, { collaborationMode: "team" });
    const first = (await workflows.tool(
      thread.id,
      "spawn_task",
      {
        title: "No edit needed",
        prompt: "Inspect the isolated files",
        access: { mode: "isolatedWrite", writePaths: ["result.txt"] },
      },
      "isolated",
    )) as ManagedTeamTaskState;
    const task = tasks(engine, thread.id)[first.id]!;
    const next = (await workflows.tool(
      thread.id,
      "spawn_task",
      { title: "Dependent", prompt: "Continue after inspection", dependsOn: [first.id] },
      "next",
    )) as ManagedTeamTaskState;
    await native.finish(
      engine,
      first.childThreadId,
      "The existing file already satisfies the request",
    );
    await vi.waitFor(() => expect(task.delivery?.status).toBe("delivered"));
    expect(task.workspace!.changedPaths).toEqual([]);
    expect(tasks(engine, thread.id)[next.id]!.status).toBe("queued");
    await workflows.tool(thread.id, "discard_task_changes", { taskId: first.id }, "discard");
    expect(task.workspace!.lifecycle).toBe("discarded");
    await vi.waitFor(() => expect(tasks(engine, thread.id)[next.id]!.childThreadId).not.toBe(""));
    expect(await readFile(join(thread.cwd, "result.txt"), "utf8")).toBe("Parent baseline\n");
  });
  it("validates submitted structured arrays before persisting model-provided results", async () => {
    const { engine, workflows, thread, scratch } = await setup();
    await engine.settings(thread.id, { collaborationMode: "team" });
    const first = (await workflows.tool(
      thread.id,
      "spawn_task",
      { title: "Report", prompt: "Inspect" },
      "child",
    )) as ManagedTeamTaskState;
    await writeFile(join(scratch, "outside.txt"), "Private fixture data");
    await symlink(join(scratch, "outside.txt"), join(thread.cwd, "escape.txt"));
    const invalid = [
      { checks: {} },
      { checks: ["invalid"] },
      { checks: [{ name: "Check", outcome: "invented" }] },
      { risks: [42] },
      { risks: Array.from({ length: 101 }, () => "Too many") },
      { artifacts: [{ label: "Missing location" }] },
      { artifacts: [{ label: "Traversal", path: "../outside.txt" }] },
      { artifacts: [{ label: "Symlink", path: "escape.txt" }] },
      { artifacts: [{ label: "Unsafe URL", url: "javascript:alert(1)" }] },
      {
        artifacts: [{ label: "Credential URL", url: "https://fixture:secret@example.com/result" }],
      },
    ];
    for (let index = 0; index < invalid.length; index++) {
      await expect(
        workflows.tool(
          first.childThreadId,
          "submit_result",
          { summary: "Report", outcome: "success", ...invalid[index] },
          `invalid-${index}`,
        ),
      ).rejects.toMatchObject({ code: "validation_failed" });
      expect(tasks(engine, thread.id)[first.id]!.resultCandidate).toBeUndefined();
    }
    await writeFile(join(thread.cwd, "report.txt"), "Standalone report");
    await workflows.tool(
      first.childThreadId,
      "submit_result",
      {
        summary: "Report",
        outcome: "success",
        checks: [{ name: "Inspection", outcome: "passed" }],
        risks: ["A bounded risk"],
        artifacts: [{ label: "Report", path: "report.txt" }],
      },
      "valid-result",
    );
    expect(tasks(engine, thread.id)[first.id]!.resultCandidate).toMatchObject({
      checks: [{ name: "Inspection", outcome: "passed" }],
      risks: ["A bounded risk"],
      artifacts: [{ label: "Report", path: "report.txt" }],
    });
  });
  it("recovers a persisted goal continuation intent after a crash before admission without replay", async () => {
    const { engine, workflows, native, thread, config } = await setup();
    await workflows.createGoal(thread.id, "Recover the saved continuation intent");
    await engine.send(thread.id, { input: "Start", clientMessageId: "before-crash" });
    const send = engine.send.bind(engine);
    vi.spyOn(engine, "send").mockImplementation(async (id, input, queued) => {
      if (input.clientMessageId?.startsWith("goal:"))
        throw new Error("Fixture crash before durable admission");
      return send(id, input, queued);
    });
    await native.finish(engine, thread.id, "Progress before API shutdown");
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(config.stateDir, "ui.json"), "utf8"));
      expect(saved.threads[thread.id].workflow.goalPendingContinuation?.id).toMatch(/^goal:/);
    });
    await engine.close();
    const restored = new Engine(config, { native: native as unknown as OpenCodeClient });
    cleanup.push(() => restored.close());
    await restored.initialize({ watch: false });
    const recovered = attach(restored);
    await restored.reconcile();
    await recovered.recover();
    await recovered.recover();
    await vi.waitFor(() => expect(native.prompts(thread.id)).toHaveLength(2));
    expect(goalReceipts(restored, thread.id)).toHaveLength(1);
    expect(restored.thread(thread.id).workflow?.goalPendingContinuation).toBeUndefined();
    await restored.interrupt(thread.id);
  });
  it("reattaches managed children after API restart and delivers their surviving native result once", async () => {
    const { engine, workflows, native, thread, config } = await setup();
    await engine.settings(thread.id, { collaborationMode: "team" });
    const created = (await workflows.tool(
      thread.id,
      "spawn_task",
      { title: "Surviving native child", prompt: "Inspect the fixture" },
      "surviving-child",
    )) as ManagedTeamTaskState;
    await vi.waitFor(() => expect(native.prompts(created.childThreadId)).toHaveLength(1));
    await engine.close();
    const restored = new Engine(config, { native: native as unknown as OpenCodeClient });
    cleanup.push(() => restored.close());
    await restored.initialize({ watch: false });
    const recovered = attach(restored);
    await restored.reconcile();
    await recovered.recover();
    expect(native.prompts(created.childThreadId)).toHaveLength(1);
    expect(tasks(restored, thread.id)[created.id]!.status).toBe("running");
    await native.finish(
      restored,
      created.childThreadId,
      "Finished while preserving the original native admission",
    );
    await vi.waitFor(() =>
      expect(tasks(restored, thread.id)[created.id]!.delivery?.status).toBe("delivered"),
    );
    await recovered.recover();
    expect(resultReceipts(restored, thread.id)).toHaveLength(1);
    expect(native.prompts(created.childThreadId)).toHaveLength(1);
    expect(native.sessions.size).toBe(2);
  });
});

describe("workflow admission and stop boundaries", () => {
  it("excludes unavailable browser tools and restores them after a browser is attached", async () => {
    const { engine, workflows, thread } = await setup();
    const unavailable = await workflows.beforeDispatch(thread.id);
    for (const name of BROWSER_TOOL_NAMES)
      expect(unavailable.tools?.[`browser_${name}`]).toBe(false);
    Object.assign(engine.thread(thread.id), {
      browserEnabled: true,
      browserBinding: { bindingId: "binding-fixture", instanceId: "extension-fixture" },
    });
    expect((await workflows.beforeDispatch(thread.id)).tools).toBeUndefined();
    engine.thread(thread.id).browserBinding!.detachedAt = Date.now();
    for (const name of BROWSER_TOOL_NAMES)
      expect((await workflows.beforeDispatch(thread.id)).tools?.[`browser_${name}`]).toBe(false);
  });
  it("interrupts an exhausted goal during native model steps, before terminal idle", async () => {
    const { engine, workflows, native, thread } = await setup();
    await workflows.createGoal(thread.id, "Bound native model work", 10);
    await engine.send(thread.id, { input: "Start", clientMessageId: "budget-step" });
    const parent = native.messages.get(thread.id)![0]!;
    await engine.onNativeEvent({
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-step",
          parentID: parent.info.id,
          sessionID: thread.id,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          tokens: { input: 4, output: 6 },
        },
      },
    });
    expect(engine.thread(thread.id).goal?.status).toBe("budgetLimited");
    expect(native.calls.filter((call) => call.path.endsWith("/abort"))).toHaveLength(1);
    expect(native.prompts(thread.id)).toHaveLength(1);
    await expect(workflows.updateGoal(thread.id, { status: "active" }, true)).rejects.toMatchObject(
      { statusCode: 409 },
    );
  });
  it("stop removes prepared goal controls while preserving separately admitted user work", async () => {
    const { engine, workflows, native, thread } = await setup();
    const goal = await workflows.createGoal(thread.id, "Stop pending continuation");
    await engine.send(thread.id, { input: "Initial", clientMessageId: "start-stop" });
    const control = `goal:${goal.createdAt}:pending`;
    await engine.send(
      thread.id,
      { input: "Automatic continuation", clientMessageId: control },
      true,
    );
    await engine.send(
      thread.id,
      { input: "Independent user work", clientMessageId: "user-next" },
      true,
    );
    await engine.interrupt(thread.id);
    expect(engine.thread(thread.id).goal?.status).toBe("paused");
    expect(engine.thread(thread.id).queue.some((message) => message.id === control)).toBe(false);
    expect(engine.thread(thread.id).receipts["user-next"]).toBeDefined();
    await workflows.recover();
    expect(
      native
        .prompts(thread.id)
        .some((call) => call.body.parts[0]?.text === "Automatic continuation"),
    ).toBe(false);
  });
  it("distinguishes native call IDs for identical arguments and rejects identity reuse", async () => {
    const { engine, workflows, native, thread } = await setup();
    await engine.settings(thread.id, { collaborationMode: "team" });
    const args = { title: "Same title", prompt: "Same task text" };
    const first = (await workflows.tool(
      thread.id,
      "spawn_task",
      args,
      "same-message",
      "call-one",
    )) as ManagedTeamTaskState;
    const next = (await workflows.tool(
      thread.id,
      "spawn_task",
      args,
      "same-message",
      "call-two",
    )) as ManagedTeamTaskState;
    expect(next.id).not.toBe(first.id);
    expect(
      (
        (await workflows.tool(
          thread.id,
          "spawn_task",
          args,
          "same-message",
          "call-one",
        )) as ManagedTeamTaskState
      ).id,
    ).toBe(first.id);
    await expect(
      workflows.tool(
        thread.id,
        "spawn_task",
        { ...args, prompt: "Changed" },
        "same-message",
        "call-one",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(native.sessions.size).toBe(3);
  });
  it("retains an uncertain side-effect marker after a late operation error", async () => {
    const { engine, workflows, thread } = await setup();
    let effects = 0;
    vi.spyOn(engine, "publishArtifact").mockImplementation(async () => {
      effects++;
      throw new Error("Fixture late I/O failure");
    });
    await expect(
      workflows.tool(thread.id, "publish_artifact", { path: "report.txt" }, "message", "same-call"),
    ).rejects.toThrow("late I/O");
    await expect(
      workflows.tool(thread.id, "publish_artifact", { path: "report.txt" }, "message", "same-call"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(effects).toBe(1);
  });
  it("keeps a Team parent active while children run and stops the whole managed group without an automatic wake", async () => {
    const { engine, workflows, native, thread, config } = await setup();
    await engine.settings(thread.id, { collaborationMode: "team" });
    const created = (await workflows.tool(
      thread.id,
      "spawn_task",
      { title: "Managed child", prompt: "Inspect only" },
      "spawn",
      "call-stop",
    )) as ManagedTeamTaskState;
    await vi.waitFor(() => expect(native.prompts(created.childThreadId)).toHaveLength(1));
    expect(engine.summary(thread.id).state).toBe("running");
    await engine.interrupt(thread.id);
    expect(tasks(engine, thread.id)[created.id]!.status).toBe("interrupted");
    expect(engine.thread(thread.id).workflow?.teamPaused).toBe(true);
    expect(native.prompts(thread.id)).toHaveLength(0);
    await engine.close();
    const restored = new Engine(config, { native: native as unknown as OpenCodeClient });
    cleanup.push(() => restored.close());
    await restored.initialize({ watch: false });
    const recovered = attach(restored);
    await restored.reconcile();
    await recovered.recover();
    expect(native.prompts(thread.id)).toHaveLength(0);
    expect(native.prompts(created.childThreadId)).toHaveLength(1);
  });
});
