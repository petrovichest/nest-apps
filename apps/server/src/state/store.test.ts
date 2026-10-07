import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "./store";

const directories: string[] = [];
async function temporaryState(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-state-test-"));
  directories.push(directory);
  return { directory, path: join(directory, "state.json") };
}
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

function managedTaskFixture(id: string, createdAt: number) {
  return {
    id,
    childThreadId: `${id}-child`,
    title: `Task ${id}`,
    prompt: `Complete ${id}.`,
    status: "completed",
    createdAt,
    lastActivityAt: createdAt,
  };
}

function validManagedTeamSerializedState(): any {
  return {
    schemaVersion: 1,
    auth: {},
    projects: [],
    threadMeta: {
      parent: {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedTeamToolsAvailable: true,
        teamOrchestration: {
          tasks: {
            base: managedTaskFixture("base", 1),
            task: {
              ...managedTaskFixture("task", 2),
              dependsOn: ["base"],
              access: {
                mode: "isolatedWrite",
                writePaths: ["apps/server/src"],
                network: false,
              },
              timeoutMinutes: 30,
              tokenBudget: 10_000,
              tokensUsed: 100,
              timeUsedSeconds: 10,
              workspace: {
                lifecycle: "ready",
                repositoryRoot: "/work/project",
                gitCommonDir: "/work/project/.git",
                worktreePath: "/work/project/.git/codexnest-team-worktrees/task",
                head: "a".repeat(40),
                baseline: {
                  "apps/server/src/api.ts": {
                    type: "file",
                    mode: 0o600,
                    digest: "b".repeat(64),
                  },
                },
                createdAt: 2,
                updatedAt: 2,
              },
              result: {
                outcome: "success",
                summary: "Done",
                checks: [{ name: "state tests", outcome: "passed" }],
                source: "submitted",
              },
            },
          },
        },
      },
    },
    uiLanguage: "en",
  };
}

describe("StateStore", () => {
  it("creates a private database and serializes concurrent updates", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    expect(store.snapshot().uiLanguage).toBe("en");
    await Promise.all([
      store.update((state) => {
        state.threadMeta.a = { pinned: false, lastReadUpdatedAt: 1 };
      }),
      store.update((state) => {
        state.threadMeta.b = { pinned: true, lastReadUpdatedAt: 2 };
      }),
    ]);
    expect(Object.keys(store.snapshot().threadMeta)).toEqual(["a", "b"]);
    expect((await stat(store.databasePath)).mode & 0o777).toBe(0o600);
    const database = new DatabaseSync(store.databasePath, { readOnly: true });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    database.close();
  });

  it("rejects corrupt and unsupported schemas", async () => {
    const { path } = await temporaryState();
    await writeFile(path, '{"schemaVersion":2}', "utf8");
    await expect(new StateStore(path).load()).rejects.toThrow("Unsupported or corrupt");
  });

  it("normalizes a legacy empty devices map out of active state and persistence", async () => {
    const { path } = await temporaryState();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        auth: {},
        projects: [],
        threadMeta: {},
        devices: {},
        uiLanguage: "en",
      }),
      "utf8",
    );

    const store = new StateStore(path);
    await store.load();
    expect(store.snapshot()).not.toHaveProperty("devices");

    const database = new DatabaseSync(store.databasePath, { readOnly: true });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM state_entries WHERE namespace = 'devices'")
        .get(),
    ).toEqual({ count: 0 });
    database.close();

    await store.checkpoint();
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("devices");
  });

  it("accepts legacy permission fields for backward-compatible state loading", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.defaultReasoningEffort = "high";
      state.threadMeta.legacy = { pinned: false, lastReadUpdatedAt: 1 };
      state.threadMeta.configured = {
        pinned: false,
        lastReadUpdatedAt: 2,
        lastViewedUpdatedAt: 2,
        settings: {
          collaborationMode: "plan",
          model: "gpt",
          reasoningEffort: "high",
          serviceTier: "priority",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
        },
      };
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().defaultReasoningEffort).toBe("high");
    expect(reloaded.snapshot().threadMeta.legacy?.settings).toBeUndefined();
    expect(reloaded.snapshot().threadMeta.configured?.lastViewedUpdatedAt).toBe(2);
    expect(reloaded.snapshot().threadMeta.configured?.settings).toEqual({
      collaborationMode: "plan",
      model: "gpt",
      reasoningEffort: "high",
      serviceTier: "fast",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  });

  it("persists stable result versions alongside legacy sessions and empty results", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.threadMeta.legacy = { pinned: false, lastReadUpdatedAt: 0 };
      state.threadMeta.empty = { pinned: false, lastReadUpdatedAt: 0, lastResult: null };
      state.threadMeta.viewed = {
        pinned: false,
        lastReadUpdatedAt: 0,
        lastViewedUpdatedAt: 10_000,
        lastResult: { turnId: "result", completedAt: 10_000 },
      };
    });
    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.view().threadMeta).toEqual(store.view().threadMeta);
  });

  it.each([
    { turnId: 1, completedAt: 10_000 },
    { turnId: "result", completedAt: "10000" },
    { turnId: "result", completedAt: null },
  ])("rejects malformed persisted results: %j", async (lastResult) => {
    const { path } = await temporaryState();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        auth: {},
        projects: [],
        threadMeta: { one: { pinned: false, lastReadUpdatedAt: 0, lastResult } },
      }),
    );
    await expect(new StateStore(path).load()).rejects.toThrow("Corrupt thread metadata");
  });

  it.each(["fast", "priority"])(
    "normalizes and persists %s in settings and task defaults",
    async (serviceTier) => {
      const { path } = await temporaryState();
      const store = new StateStore(path);
      await store.load();
      await store.update((state) => {
        state.taskDefaults = {
          model: "gpt-a",
          titleModel: "gpt-b",
          serviceTier,
          personality: "friendly",
        };
        state.threadMeta.one = {
          pinned: false,
          lastReadUpdatedAt: 0,
          settings: { collaborationMode: "default", serviceTier },
        };
      });

      const reloaded = new StateStore(path);
      await reloaded.load();

      expect(reloaded.snapshot().taskDefaults).toEqual({
        model: "gpt-a",
        titleModel: "gpt-b",
        serviceTier: "fast",
        personality: "friendly",
      });
      expect(reloaded.view().threadMeta.one?.settings).toEqual({
        collaborationMode: "default",
        serviceTier: "fast",
      });

      await reloaded.update((state) => {
        delete state.taskDefaults!.serviceTier;
        delete state.threadMeta.one!.settings!.serviceTier;
      });
      const cleared = new StateStore(path);
      await cleared.load();
      expect(cleared.view().taskDefaults).not.toHaveProperty("serviceTier");
      expect(cleared.view().threadMeta.one?.settings).not.toHaveProperty("serviceTier");
    },
  );

  it.each([
    { serviceTier: "fast", expected: "fast" },
    { serviceTier: "priority", expected: "fast" },
    { serviceTier: "unknown", expected: undefined },
    { serviceTier: null, expected: undefined },
  ])("loads legacy serviceTier $serviceTier as $expected", async ({ serviceTier, expected }) => {
    const { path } = await temporaryState();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        auth: {},
        projects: [],
        taskDefaults: { model: "gpt", serviceTier },
        threadMeta: {
          one: {
            pinned: false,
            lastReadUpdatedAt: 0,
            settings: { collaborationMode: "default", serviceTier },
          },
        },
      }),
    );
    const store = new StateStore(path);
    await store.load();
    expect(store.view().taskDefaults?.serviceTier).toBe(expected);
    expect(store.view().threadMeta.one?.settings?.serviceTier).toBe(expected);
    await store.checkpoint();
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.taskDefaults.serviceTier).toBe(expected);
    expect(saved.threadMeta.one.settings.serviceTier).toBe(expected);
  });

  it("persists user-input drafts inside existing thread metadata", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    const key = "a".repeat(64);
    await store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        userInputDrafts: {
          [key]: {
            turnId: "turn",
            itemId: "item",
            fingerprint: "b".repeat(64),
            answers: { question: ["answer"] },
            currentQuestionId: "question",
            revision: 3,
            updatedAt: 123,
          },
        },
      };
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().threadMeta.thread?.userInputDrafts?.[key]).toMatchObject({
      turnId: "turn",
      itemId: "item",
      answers: { question: ["answer"] },
      revision: 3,
    });
  });

  it("loads legacy state and queued messages without the new optional fields", async () => {
    const { path } = await temporaryState();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        auth: {},
        projects: [],
        threadMeta: {},
        messageQueues: {
          thread: [
            {
              id: "queued",
              threadId: "thread",
              text: "Старое сообщение",
              createdAt: 1,
              status: "queued",
            },
          ],
        },
      }),
      "utf8",
    );

    const store = new StateStore(path);
    await store.load();
    expect(store.snapshot().uiLanguage).toBe("ru");
    expect(store.snapshot().messageQueues?.thread).toEqual([
      expect.objectContaining({ id: "queued", text: "Старое сообщение" }),
    ]);
    expect(store.snapshot().dismissedProjectPaths).toBeUndefined();
  });

  it("persists dismissed project paths without changing the state schema", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.dismissedProjectPaths = ["/work/removed"];
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot()).toMatchObject({
      schemaVersion: 1,
      dismissedProjectPaths: ["/work/removed"],
    });
  });

  it("persists browser ownership and detached state in thread metadata", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.threadMeta.browser = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
        browserBinding: {
          bindingId: "binding-1",
          instanceId: "extension-instance-1",
          attachedAt: 100,
          detachedAt: 200,
        },
      };
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().threadMeta.browser?.browserEnabled).toBe(true);
    expect(reloaded.snapshot().threadMeta.browser?.browserBinding).toEqual({
      bindingId: "binding-1",
      instanceId: "extension-instance-1",
      attachedAt: 100,
      detachedAt: 200,
    });
  });

  it("persists pending Team results and their timeline notices", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
        teamOrchestration: {
          tasks: {
            task: {
              id: "task",
              childThreadId: "child",
              childThreadSource: "codexnest-managed:receipt",
              startMessageId: "codexnest-team-task:task",
              title: "Проверить интерфейс",
              prompt: "Проверить интерфейс и вернуть результат.",
              status: "completed",
              createdAt: 1,
              lastActivityAt: 2,
              terminalTurnId: "child-turn",
              result: {
                summary: "Интерфейс проверен",
                source: "submitted",
              },
              delivery: {
                status: "claimed",
                claimId: "claim",
                markerId: "codexnest-team-claim:claim",
                dispatchStartedAt: 3,
                contextHash: "a".repeat(64),
              },
            },
            sleeping: {
              id: "sleeping",
              childThreadId: "sleeping-child",
              title: "Проверить результат позже",
              prompt: "Проверить результат через час.",
              status: "running",
              createdAt: 3,
              lastActivityAt: 4,
              expectedWakeAt: 3_604_000,
            },
          },
        },
        timelineArtifacts: {
          "parent-turn": [
            {
              type: "orchestrationNotice",
              id: "notice",
              status: "completed",
              agents: [
                {
                  threadId: "child",
                  title: "Проверить интерфейс",
                  nickname: "reviewer",
                  outcome: "completed",
                },
              ],
              timestamp: 1,
              afterItemId: null,
            },
          ],
        },
      };
      state.teamToolOperations = {
        receipt: {
          threadId: "parent",
          turnId: "parent-turn",
          callId: "call",
          tool: "spawn_task",
          argumentsHash: "b".repeat(64),
          status: "applied",
          createdAt: 1,
          updatedAt: 2,
          taskId: "task",
          childThreadSource: "codexnest-managed:receipt",
          response: {
            success: true,
            contentItems: [{ type: "inputText", text: '{"taskId":"task"}' }],
          },
        },
      };
    });
    await store.checkpoint();

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().threadMeta.parent).toMatchObject({
      teamOrchestration: {
        tasks: {
          task: {
            childThreadId: "child",
            status: "completed",
            terminalTurnId: "child-turn",
            startMessageId: "codexnest-team-task:task",
            result: {
              summary: "Интерфейс проверен",
              source: "submitted",
            },
          },
          sleeping: {
            childThreadId: "sleeping-child",
            status: "running",
            expectedWakeAt: 3_604_000,
          },
        },
      },
      timelineArtifacts: {
        "parent-turn": [
          {
            type: "orchestrationNotice",
            agents: [{ threadId: "child", outcome: "completed" }],
          },
        ],
      },
    });
    expect(reloaded.snapshot().teamToolOperations).toMatchObject({
      receipt: {
        status: "applied",
        taskId: "task",
        response: { success: true },
      },
    });
  });

  it("round-trips the current managed Team task state", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
        managedTeamToolsAvailable: true,
        teamOrchestration: {
          tasks: {
            legacy: {
              id: "legacy",
              childThreadId: "legacy-child",
              title: "Legacy task",
              prompt: "Keep the minimal stored shape valid.",
              status: "completed",
              createdAt: 1,
              lastActivityAt: 2,
              result: { summary: "Legacy result", source: "submitted" },
            },
            isolated: {
              id: "isolated",
              childThreadId: "isolated-child",
              title: "Isolated task",
              prompt: "Implement the scoped change.",
              status: "completed",
              dependsOn: ["legacy"],
              access: {
                mode: "isolatedWrite",
                writePaths: ["apps/server/src", "apps/server/package.json"],
                network: false,
              },
              resolvedModel: "gpt-5.6-codex",
              resolvedReasoningEffort: "high",
              resolvedServiceTier: "priority",
              timeoutMinutes: 30,
              tokenBudget: 50_000,
              tokensUsed: 12_345,
              timeUsedSeconds: 83.5,
              createdAt: 3,
              startedAt: 4,
              lastActivityAt: 5,
              workspace: {
                lifecycle: "integrated",
                repositoryRoot: "/work/project",
                gitCommonDir: "/work/project/.git",
                worktreePath: "/work/project/.git/codexnest-team-worktrees/isolated",
                head: "a".repeat(40),
                baseline: {
                  "apps/server/src/api.ts": {
                    type: "file",
                    mode: 0o600,
                    digest: "b".repeat(64),
                  },
                  "apps/server/run": { type: "symlink", target: "scripts/run.sh" },
                },
                createdAt: 4,
                updatedAt: 6,
                changedPaths: ["apps/server/src/api.ts"],
              },
              result: {
                outcome: "success",
                summary: "Implemented and checked",
                details: "The scoped change is ready.",
                checks: [{ name: "state tests", outcome: "passed", details: "12 passed" }],
                risks: ["Integration still needs the root test suite."],
                artifacts: [
                  { label: "Patch", path: "apps/server/src/api.ts" },
                  { label: "Reference", url: "https://example.test/result/isolated" },
                ],
                source: "submitted",
              },
            },
            followup: {
              id: "followup",
              childThreadId: "isolated-child",
              title: "Follow-up task",
              prompt: "Continue after the delivered predecessor.",
              status: "failed",
              predecessorTaskId: "isolated",
              access: { mode: "readOnly", network: true },
              resolvedModel: "gpt-5.6-codex",
              resolvedReasoningEffort: null,
              resolvedServiceTier: null,
              timeoutMinutes: 5,
              tokenBudget: 1_000,
              tokensUsed: 1_001,
              timeUsedSeconds: 301,
              failureReason: "The hard task budget was exhausted.",
              budgetReason: "tokenBudget",
              createdAt: 7,
              lastActivityAt: 8,
              resultCandidate: {
                outcome: "partial",
                summary: "Stopped at the budget boundary",
                checks: [{ name: "typecheck", outcome: "notRun" }],
                submittedAt: 8,
                callId: "result-call",
              },
            },
          },
        },
      };
      state.teamToolOperations = {
        integration: {
          threadId: "parent",
          turnId: "parent-turn",
          callId: "integrate-call",
          tool: "integrate_task",
          argumentsHash: "c".repeat(64),
          status: "prepared",
          createdAt: 9,
          updatedAt: 9,
          taskId: "isolated",
        },
      };
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().threadMeta.parent).toMatchObject({
      managedTeamToolsAvailable: true,
      teamOrchestration: {
        tasks: {
          legacy: {
            result: { summary: "Legacy result" },
          },
          isolated: {
            dependsOn: ["legacy"],
            access: { mode: "isolatedWrite", network: false },
            resolvedModel: "gpt-5.6-codex",
            timeoutMinutes: 30,
            tokenBudget: 50_000,
            tokensUsed: 12_345,
            workspace: {
              lifecycle: "integrated",
              changedPaths: ["apps/server/src/api.ts"],
              baseline: {},
            },
            result: {
              outcome: "success",
              checks: [{ name: "state tests", outcome: "passed" }],
              artifacts: [
                { label: "Patch", path: "apps/server/src/api.ts" },
                { label: "Reference", url: "https://example.test/result/isolated" },
              ],
            },
          },
          followup: {
            predecessorTaskId: "isolated",
            budgetReason: "tokenBudget",
            failureReason: "The hard task budget was exhausted.",
            resultCandidate: { outcome: "partial" },
          },
        },
      },
    });
    expect(reloaded.snapshot().teamToolOperations?.integration).toMatchObject({
      tool: "integrate_task",
      status: "prepared",
      taskId: "isolated",
    });
  });

  it("retires hard budgets from unfinished tasks while preserving completed history", async () => {
    const { path } = await temporaryState();
    const state = validManagedTeamSerializedState();
    state.threadMeta.parent.teamOrchestration.tasks.running = {
      ...managedTaskFixture("running", 3),
      status: "running",
      childTurnId: "running-turn",
      timeoutMinutes: 5,
      tokenBudget: 1_000,
      budgetReason: "tokenBudget",
    };
    await writeFile(path, JSON.stringify(state), "utf8");

    const store = new StateStore(path);
    await store.load();

    const tasks = store.snapshot().threadMeta.parent?.teamOrchestration?.tasks;
    expect(tasks?.running).not.toHaveProperty("timeoutMinutes");
    expect(tasks?.running).not.toHaveProperty("tokenBudget");
    expect(tasks?.running).not.toHaveProperty("budgetReason");
    expect(tasks?.task).toMatchObject({ timeoutMinutes: 30, tokenBudget: 10_000 });
  });

  it("migrates the latest versioned Team state to the single managed-tool contract", async () => {
    const { path } = await temporaryState();
    const state = validManagedTeamSerializedState();
    delete state.threadMeta.parent.managedTeamToolsAvailable;
    state.threadMeta.parent.teamToolsVersion = 2;
    await writeFile(path, JSON.stringify(state), "utf8");

    const store = new StateStore(path);
    await store.load();

    expect(store.snapshot().threadMeta.parent).toMatchObject({
      managedTeamToolsAvailable: true,
      teamOrchestration: { tasks: { task: { id: "task" } } },
    });
    expect("teamToolsVersion" in store.snapshot().threadMeta.parent!).toBe(false);
  });

  it("keeps empty legacy Team chats but retires their orchestration mode", async () => {
    const { path } = await temporaryState();
    const state = validManagedTeamSerializedState();
    delete state.threadMeta.parent.managedTeamToolsAvailable;
    state.threadMeta.parent.teamToolsVersion = 1;
    state.threadMeta.parent.settings = {
      collaborationMode: "team",
      model: "gpt-a",
      reasoningEffort: "high",
    };
    state.threadMeta.parent.teamOrchestration = { tasks: {} };
    await writeFile(path, JSON.stringify(state), "utf8");

    const store = new StateStore(path);
    await store.load();

    expect(store.snapshot().threadMeta.parent).toMatchObject({
      settings: { collaborationMode: "default" },
    });
    expect(store.snapshot().threadMeta.parent?.managedTeamToolsAvailable).toBeUndefined();
    expect(store.snapshot().threadMeta.parent?.teamOrchestration).toBeUndefined();
  });

  it("fails closed instead of discarding unfinished legacy Team work", async () => {
    const { path } = await temporaryState();
    const state = validManagedTeamSerializedState();
    delete state.threadMeta.parent.managedTeamToolsAvailable;
    state.threadMeta.parent.teamToolsVersion = 1;
    await writeFile(path, JSON.stringify(state), "utf8");

    await expect(new StateStore(path).load()).rejects.toThrow(
      "Unsupported unfinished legacy Team orchestration in CodexNest state",
    );
  });

  it("rejects malformed or pathologically unsafe managed Team task state", async () => {
    const cases: Array<[string, (state: any) => void]> = [
      [
        "invalid managed-tool capability",
        (state) => (state.threadMeta.parent.managedTeamToolsAvailable = false),
      ],
      [
        "missing dependency",
        (state) => (state.threadMeta.parent.teamOrchestration.tasks.task.dependsOn = ["missing"]),
      ],
      [
        "self dependency",
        (state) => (state.threadMeta.parent.teamOrchestration.tasks.task.dependsOn = ["task"]),
      ],
      [
        "dependency cycle",
        (state) => {
          state.threadMeta.parent.teamOrchestration.tasks.base.dependsOn = ["task"];
        },
      ],
      [
        "too many dependencies",
        (state) => {
          const tasks = state.threadMeta.parent.teamOrchestration.tasks;
          for (let index = 0; index < 51; index += 1) {
            const id = `dependency-${index}`;
            tasks[id] = managedTaskFixture(id, index + 10);
          }
          tasks.task.dependsOn = Object.keys(tasks).filter((id) => id.startsWith("dependency-"));
        },
      ],
      [
        "write path traversal",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.access.writePaths = ["../api.ts"]),
      ],
      [
        "Git metadata write path",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.access.writePaths = [
            "nested/.GiT/config",
          ]),
      ],
      [
        "read-only write path",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.access = {
            mode: "readOnly",
            writePaths: ["apps"],
          }),
      ],
      [
        "invalid timeout",
        (state) => (state.threadMeta.parent.teamOrchestration.tasks.task.timeoutMinutes = 1_441),
      ],
      [
        "invalid token usage",
        (state) => (state.threadMeta.parent.teamOrchestration.tasks.task.tokensUsed = -1),
      ],
      [
        "oversized structured result",
        (state) => {
          state.threadMeta.parent.teamOrchestration.tasks.task.result.checks = Array.from(
            { length: 101 },
            (_, index) => ({ name: `check-${index}`, outcome: "passed" }),
          );
        },
      ],
      [
        "unsafe artifact URL",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.result.artifacts = [
            { label: "secret", url: "file:///etc/passwd" },
          ]),
      ],
      [
        "external worktree",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.workspace.worktreePath =
            "/work/other/task"),
      ],
      [
        "baseline traversal",
        (state) => {
          state.threadMeta.parent.teamOrchestration.tasks.task.workspace.baseline = {
            "../outside": { type: "file", mode: 0o644, digest: "b".repeat(64) },
          };
        },
      ],
      [
        "invalid baseline digest",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.workspace.baseline[
            "apps/server/src/api.ts"
          ].digest = "short"),
      ],
      [
        "invalid baseline mode",
        (state) =>
          (state.threadMeta.parent.teamOrchestration.tasks.task.workspace.baseline[
            "apps/server/src/api.ts"
          ].mode = 0o1000),
      ],
    ];

    for (const [name, mutate] of cases) {
      const { path } = await temporaryState();
      const state = validManagedTeamSerializedState();
      mutate(state);
      await writeFile(path, JSON.stringify(state), "utf8");
      await expect(new StateStore(path).load(), name).rejects.toThrow(
        "Corrupt thread metadata in CodexNest state",
      );
    }
  });

  it("persists explicit session artifacts and rejects unsafe metadata", async () => {
    const { path } = await temporaryState();
    const state = validManagedTeamSerializedState();
    state.threadMeta.parent.sessionArtifactsVersion = 1;
    state.threadMeta.parent.sessionArtifacts = [
      {
        id: "artifact-id",
        label: "Final report",
        path: "deliverables/report.txt",
        turnId: "turn-1",
        createdAt: 10,
      },
    ];
    await writeFile(path, JSON.stringify(state), "utf8");
    const store = new StateStore(path);
    await store.load();
    expect(store.snapshot().threadMeta.parent?.sessionArtifacts).toEqual(
      state.threadMeta.parent.sessionArtifacts,
    );

    for (const mutate of [
      (value: any) => (value.threadMeta.parent.sessionArtifactsVersion = 2),
      (value: any) => (value.threadMeta.parent.sessionArtifacts[0].path = "../secret.txt"),
      (value: any) => (value.threadMeta.parent.sessionArtifacts[0].label = "x".repeat(501)),
    ]) {
      const invalid = structuredClone(state);
      mutate(invalid);
      const candidate = await temporaryState();
      await writeFile(candidate.path, JSON.stringify(invalid), "utf8");
      await expect(new StateStore(candidate.path).load()).rejects.toThrow(
        "Corrupt thread metadata in CodexNest state",
      );
    }
  });

  it("loads legacy and fork-aware session snapshots and rejects an empty fork parent", async () => {
    const snapshot = {
      sessionId: "fork-tree",
      name: "Fork",
      preview: "Preview",
      cwd: "/work",
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      currentTurnId: null,
    };

    const legacyState = validManagedTeamSerializedState();
    legacyState.threadMeta.parent.sessionSnapshot = snapshot;
    const legacy = await temporaryState();
    await writeFile(legacy.path, JSON.stringify(legacyState), "utf8");
    const legacyStore = new StateStore(legacy.path);
    await legacyStore.load();
    expect(legacyStore.snapshot().threadMeta.parent?.sessionSnapshot?.forkedFromId).toBeUndefined();

    const forkState = structuredClone(legacyState);
    forkState.threadMeta.parent.sessionSnapshot.forkedFromId = "source";
    const fork = await temporaryState();
    await writeFile(fork.path, JSON.stringify(forkState), "utf8");
    const forkStore = new StateStore(fork.path);
    await forkStore.load();
    expect(forkStore.snapshot().threadMeta.parent?.sessionSnapshot?.forkedFromId).toBe("source");

    forkState.threadMeta.parent.sessionSnapshot.forkedFromId = "";
    const invalid = await temporaryState();
    await writeFile(invalid.path, JSON.stringify(forkState), "utf8");
    await expect(new StateStore(invalid.path).load()).rejects.toThrow(
      "Corrupt thread metadata in CodexNest state",
    );
  });

  it("reloads unmaterialized sessions and complete server drafts", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    await store.update((state) => {
      state.transcriptionTimings = {
        "local:http://127.0.0.1:8178/inference:raw": [
          { audioDurationMs: 2_000, processingMs: 6_000 },
          { audioDurationMs: 3_000, processingMs: 7_000 },
        ],
      };
      state.voiceTranscriptions = {
        thread: {
          id: "voice",
          threadId: "thread",
          mode: "steer",
          status: "queued",
          createdAt: 1,
          startedAt: null,
          audioDurationMs: 2_000,
          estimatedTotalSeconds: 6,
          error: null,
          contentType: "audio/webm",
          audioFile: "voice.webm",
          audioBytes: 5,
          selectionStart: 0,
          selectionEnd: 0,
          timingProfile: "local:test",
        },
      };
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        unmaterialized: true,
        draft: {
          input: "Черновик",
          images: [
            {
              id: "image",
              name: "draft.png",
              url: "data:image/png;base64,AA==",
            },
          ],
          goalMode: true,
          annotations: [
            {
              id: "annotation",
              messageId: "message",
              source: "agentMessage",
              quote: "Цитата",
              startOffset: 0,
              endOffset: 6,
              comment: "Комментарий",
              createdAt: 1,
            },
          ],
          updatedAt: 2,
        },
      };
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().threadMeta.thread).toMatchObject({
      unmaterialized: true,
      draft: {
        input: "Черновик",
        images: [{ name: "draft.png" }],
        goalMode: true,
        annotations: [{ comment: "Комментарий" }],
      },
    });
    expect(reloaded.snapshot().transcriptionTimings).toEqual({
      "local:http://127.0.0.1:8178/inference:raw": [
        { audioDurationMs: 2_000, processingMs: 6_000 },
        { audioDurationMs: 3_000, processingMs: 7_000 },
      ],
    });
    expect(reloaded.snapshot().voiceTranscriptions?.thread).toMatchObject({
      id: "voice",
      mode: "steer",
      status: "queued",
      audioFile: "voice.webm",
    });
  });

  it("discards legacy timing coefficients that lack audio durations", async () => {
    const { path } = await temporaryState();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        auth: {},
        projects: [],
        threadMeta: {},
        uiLanguage: "ru",
        transcriptionTimings: {
          "local:http://127.0.0.1:8178/inference:raw": [2_000, 3_000],
        },
      }),
      "utf8",
    );

    const store = new StateStore(path);
    await store.load();
    expect(store.snapshot().transcriptionTimings).toEqual({
      "local:http://127.0.0.1:8178/inference:raw": [],
    });
  });

  it("migrates legacy JSON with a backup and exports a compact rollback checkpoint", async () => {
    const { path } = await temporaryState();
    const legacy = {
      schemaVersion: 1,
      auth: {},
      projects: [],
      threadMeta: {},
      messageQueues: {
        original: [
          {
            id: "before",
            threadId: "original",
            text: "before",
            createdAt: 1,
            status: "queued",
          },
        ],
      },
      uiLanguage: "en",
    };
    const serialized = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(path, serialized, { mode: 0o600 });

    const store = new StateStore(path);
    await store.load();
    expect(await readFile(`${path}.pre-sqlite`, "utf8")).toBe(serialized);
    expect((await stat(`${path}.pre-sqlite`)).mode & 0o777).toBe(0o600);

    await store.update((state) => {
      state.messageQueues!.current = [
        {
          id: "after",
          threadId: "current",
          text: "after",
          createdAt: 2,
          status: "queued",
        },
      ];
    });
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("messageQueues.current");

    await store.checkpoint();
    const checkpoint = await readFile(path, "utf8");
    expect(checkpoint).not.toContain("\n  ");
    expect(JSON.parse(checkpoint).messageQueues.current).toEqual([
      expect.objectContaining({ id: "after", text: "after" }),
    ]);

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().messageQueues).toMatchObject({
      original: [expect.objectContaining({ id: "before" })],
      current: [expect.objectContaining({ id: "after" })],
    });
  });

  it("keeps view reads zero-copy while updates use copy-on-write", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    const before = store.view();
    const beforeProjects = before.projects;

    await store.update((state) => {
      state.threadMeta.first = { pinned: false, lastReadUpdatedAt: 1 };
    });

    const after = store.view();
    expect(after).not.toBe(before);
    expect(after.projects).toBe(beforeProjects);
    expect(before.threadMeta).toEqual({});
    expect(after.threadMeta.first).toEqual({ pinned: false, lastReadUpdatedAt: 1 });
    const exported = store.snapshot();
    exported.threadMeta.first!.pinned = true;
    expect(store.view().threadMeta.first?.pinned).toBe(false);
  });

  it("skips SQLite writes for no-op updates", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    const database = new DatabaseSync(store.databasePath);
    database.exec(`
      CREATE TABLE write_audit (kind TEXT NOT NULL);
      CREATE TRIGGER audit_insert AFTER INSERT ON state_entries BEGIN
        INSERT INTO write_audit(kind) VALUES ('insert');
      END;
      CREATE TRIGGER audit_update AFTER UPDATE ON state_entries BEGIN
        INSERT INTO write_audit(kind) VALUES ('update');
      END;
      CREATE TRIGGER audit_delete AFTER DELETE ON state_entries BEGIN
        INSERT INTO write_audit(kind) VALUES ('delete');
      END;
    `);

    await store.update(() => undefined);
    await store.update((state) => {
      state.uiLanguage = "en";
    });
    expect(database.prepare("SELECT count(*) AS count FROM write_audit").get()).toEqual({
      count: 0,
    });
    database.close();
  });

  it("rolls back a failed SQLite transaction without publishing the draft", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    const before = store.view();
    const database = new DatabaseSync(store.databasePath);
    database.exec(`
      CREATE TRIGGER reject_broken_metadata BEFORE INSERT ON state_entries
      WHEN NEW.namespace = 'threadMeta' AND NEW.entry_key = 'broken'
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);

    await expect(
      store.update((state) => {
        state.threadMeta.broken = { pinned: false, lastReadUpdatedAt: 1 };
      }),
    ).rejects.toThrow("forced rollback");
    expect(store.view()).toBe(before);
    expect(store.view().threadMeta.broken).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT json FROM state_entries WHERE namespace = 'threadMeta' AND entry_key = 'broken'",
        )
        .get(),
    ).toBeUndefined();
    database.close();
  });

  it("batches deferred activity updates into one transaction", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path, { deferredFlushMs: 25 });
    await store.load();
    await store.update((state) => {
      state.threadMeta.parent = {
        pinned: false,
        lastReadUpdatedAt: 0,
        teamOrchestration: {
          tasks: {
            task: {
              id: "task",
              childThreadId: "child",
              title: "Activity",
              prompt: "Track activity.",
              status: "running",
              createdAt: 1,
              lastActivityAt: 1,
            },
          },
        },
      };
    });
    const database = new DatabaseSync(store.databasePath);
    database.exec(`
      CREATE TABLE deferred_audit (value INTEGER NOT NULL);
      CREATE TRIGGER audit_parent_activity AFTER UPDATE ON state_entries
      WHEN NEW.namespace = 'threadMeta' AND NEW.entry_key = 'parent'
      BEGIN
        INSERT INTO deferred_audit(value) VALUES (1);
      END;
    `);

    await store.updateDeferred((state) => {
      const task = state.threadMeta.parent!.teamOrchestration!.tasks.task!;
      task.lastActivityAt = 2;
      task.tokensUsed = 10;
    });
    await store.updateDeferred((state) => {
      const task = state.threadMeta.parent!.teamOrchestration!.tasks.task!;
      task.lastActivityAt = 3;
      task.tokensUsed = 20;
    });
    const beforeFlush = JSON.parse(
      String(
        (
          database
            .prepare(
              "SELECT json FROM state_entries WHERE namespace = 'threadMeta' AND entry_key = 'parent'",
            )
            .get() as { json: string }
        ).json,
      ),
    );
    expect(beforeFlush.teamOrchestration.tasks.task.lastActivityAt).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await store.flushed();
    const afterFlush = JSON.parse(
      (
        database
          .prepare(
            "SELECT json FROM state_entries WHERE namespace = 'threadMeta' AND entry_key = 'parent'",
          )
          .get() as { json: string }
      ).json,
    );
    expect(afterFlush.teamOrchestration.tasks.task).toMatchObject({
      lastActivityAt: 3,
      tokensUsed: 20,
    });
    expect(database.prepare("SELECT count(*) AS count FROM deferred_audit").get()).toEqual({
      count: 1,
    });
    database.close();
  });

  it("fails closed when the SQLite database is corrupt", async () => {
    const { directory, path } = await temporaryState();
    const databasePath = join(directory, "custom.sqlite");
    await writeFile(databasePath, "not a sqlite database", { mode: 0o600 });
    await expect(new StateStore(path, { databasePath }).load()).rejects.toThrow();
  });

  it("compacts terminal workspace baselines without losing lifecycle details", async () => {
    const { path } = await temporaryState();
    const state = validManagedTeamSerializedState();
    const workspace = state.threadMeta.parent.teamOrchestration.tasks.task.workspace;
    workspace.lifecycle = "discarded";
    workspace.changedPaths = ["apps/server/src/api.ts"];
    workspace.error = "cleanup will retry";
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });

    const store = new StateStore(path);
    await store.load();
    expect(store.view().threadMeta.parent?.teamOrchestration?.tasks.task?.workspace).toEqual(
      expect.objectContaining({
        lifecycle: "discarded",
        baseline: {},
        changedPaths: ["apps/server/src/api.ts"],
        error: "cleanup will retry",
      }),
    );
  });

  it("handles hon-scale state with targeted writes from eight concurrent sessions", async () => {
    const { path } = await temporaryState();
    const state = validManagedTeamSerializedState();
    const baseline: Record<string, unknown> = {};
    for (let index = 0; index < 8_500; index += 1) {
      baseline[`src/generated/file-${index}.ts`] = {
        type: "file",
        mode: 0o644,
        digest: index.toString(16).padStart(64, "0"),
      };
    }
    const task = state.threadMeta.parent.teamOrchestration.tasks.task;
    task.status = "running";
    task.workspace.baseline = baseline;
    for (let index = 0; index < 582; index += 1) {
      state.threadMeta[`thread-${index}`] = {
        pinned: false,
        lastReadUpdatedAt: index,
        ...(index < 8
          ? {
              teamOrchestration: {
                tasks: {
                  [`task-${index}`]: {
                    id: `task-${index}`,
                    childThreadId: `child-${index}`,
                    title: `Session ${index}`,
                    prompt: `Run session ${index}.`,
                    status: "running",
                    createdAt: index + 10,
                    lastActivityAt: index + 10,
                  },
                },
              },
            }
          : {}),
      };
    }
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });

    const startedAt = performance.now();
    const store = new StateStore(path, { deferredFlushMs: 25 });
    await store.load();
    const loadMs = performance.now() - startedAt;
    expect(Object.keys(store.view().threadMeta)).toHaveLength(583);
    expect(loadMs).toBeLessThan(1_000);

    const updateStartedAt = performance.now();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.updateDeferred((draft) => {
          const managed =
            draft.threadMeta[`thread-${index}`]!.teamOrchestration!.tasks[`task-${index}`]!;
          managed.lastActivityAt = 1_000 + index;
          managed.tokensUsed = 10_000 + index;
        }),
      ),
    );
    await store.flushed();
    expect(performance.now() - updateStartedAt).toBeLessThan(1_000);

    const fullJsonBytes = Buffer.byteLength(JSON.stringify(store.snapshot()));
    const walBytes = (await stat(`${store.databasePath}-wal`)).size;
    expect(walBytes).toBeLessThan(fullJsonBytes * 0.1);
    const database = new DatabaseSync(store.databasePath, { readOnly: true });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    database.close();
  }, 10_000);

  it("reloads an externally rotated verifier and emits revocation", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    const database = new DatabaseSync(store.databasePath);
    database.exec(`
      CREATE TABLE auth_audit (namespace TEXT NOT NULL, entry_key TEXT NOT NULL);
      CREATE TRIGGER audit_auth_rotation AFTER UPDATE ON state_entries BEGIN
        INSERT INTO auth_audit(namespace, entry_key) VALUES (NEW.namespace, NEW.entry_key);
      END;
    `);
    const rotated = store.snapshot();
    rotated.auth.tokenSha256 = "a".repeat(64);
    await writeFile(path, JSON.stringify(rotated), { mode: 0o600 });
    const revoked = new Promise<void>((resolve) => store.once("authRotated", resolve));
    await expect(store.refreshAuthVerifier()).resolves.toBe(true);
    await revoked;
    expect(store.snapshot().auth.tokenSha256).toBe("a".repeat(64));
    expect(database.prepare("SELECT namespace, entry_key FROM auth_audit").all()).toEqual([
      { namespace: "root", entry_key: "auth" },
    ]);
    database.close();
  });

  it("persists fork operations in an optional map namespace without a schema change", async () => {
    const { path } = await temporaryState();
    const store = new StateStore(path);
    await store.load();
    expect(store.snapshot().forkOperations).toBeUndefined();

    await store.update((state) => {
      state.forkOperations = {
        operation: {
          id: "operation",
          sourceThreadId: "source",
          lastTurnId: "turn",
          agentMessageId: "answer",
          mode: "compressed",
          status: "reconciling",
          title: "Ответвление: Source",
          createdAt: 1,
          updatedAt: 1,
          targetThreadId: null,
          estimate: null,
          error: null,
          sourceCwd: "/work",
          sourceSettings: { collaborationMode: "default" },
          rolloutPath: null,
          agentText: "",
          nativeAttempt: { startedAt: 2, sequence: 1 },
          compressedMaterialization: { phase: "injecting", startedAt: 3 },
          queuedMessages: [],
        },
      };
    });

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot().schemaVersion).toBe(1);
    expect(reloaded.snapshot().forkOperations?.operation).toMatchObject({
      mode: "compressed",
      status: "reconciling",
      sourceThreadId: "source",
      nativeAttempt: { startedAt: 2, sequence: 1 },
      compressedMaterialization: { phase: "injecting", startedAt: 3 },
    });
  });
});
