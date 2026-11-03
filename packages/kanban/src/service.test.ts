import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanRun } from "@codexnest/protocol";
import { atomicJson, type KanbanDocument } from "./store.js";
import { KanbanService } from "./service.js";

const fake = vi.hoisted(() => ({
  candidates: new Map<string, unknown[]>(),
  groups: [] as unknown[][],
}));
vi.mock("./workspace.js", () => ({
  createTaskWorkspace: vi.fn(
    async (input: { projectPath: string; workspaceRoot: string; taskId: string }) => ({
      id: input.taskId,
      projectPath: input.projectPath,
      rootPath: join(input.workspaceRoot, input.taskId),
      repositories: [],
    }),
  ),
  prepareRepository: vi.fn(
    async (
      workspace: { id: string; repositories: unknown[] },
      input: { repositoryPath: string; targetBranch: string },
    ) => {
      const repository = {
        id: `${workspace.id}-${input.repositoryPath}-${input.targetBranch}`,
        sourcePath: input.repositoryPath,
        relativePath: "repo",
        gitCommonDir: `${input.repositoryPath}/.git`,
        workspacePath: `/isolated/${workspace.id}`,
        branch: `task/${workspace.id}`,
        targetBranch: input.targetBranch,
        baseSha: "a".repeat(40),
        targetSha: "a".repeat(40),
        remote: null,
      };
      workspace.repositories.push(repository);
      fake.candidates.set(
        workspace.id,
        workspace.repositories.map((repository) => ({
          repository,
          sha: "b".repeat(40),
          changed: true,
        })),
      );
      return repository;
    },
  ),
  validateTaskWorkspace: vi.fn(
    async (workspace: { id: string }) => fake.candidates.get(workspace.id) ?? [],
  ),
  prepareIntegrationWorkspace: vi.fn(
    async (input: {
      integrationId: string;
      projectPath: string;
      results: { repository: Record<string, unknown>; sha: string }[];
    }) => {
      fake.groups.push(input.results);
      return {
        id: input.integrationId,
        projectPath: input.projectPath,
        rootPath: `/integrations/${input.integrationId}`,
        repositories: input.results.map((item) => ({
          ...item.repository,
          id: `integration-${item.repository.id}`,
          inputShas: [item.sha],
          expectedTargetSha: "a".repeat(40),
          mergeStatus: "merged",
        })),
      };
    },
  ),
  validateIntegrationWorkspace: vi.fn(async (workspace: { repositories: { id: string }[] }) =>
    workspace.repositories.map((repository) => ({ repository, sha: "c".repeat(40) })),
  ),
  publishIntegrationRepository: vi.fn(async (repository: { id: string; targetBranch: string }) => ({
    repositoryId: repository.id,
    sha: "c".repeat(40),
    targetBranch: repository.targetBranch,
    remote: null,
    pushed: false,
    localOnly: true,
  })),
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
beforeEach(() => {
  fake.candidates.clear();
  fake.groups.length = 0;
});
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4000;
  while (true) {
    const result = await read();
    if (predicate(result)) return result;
    if (Date.now() > deadline) throw new Error("Timed out waiting for durable board operation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(available?: () => boolean) {
  const directory = await mkdtemp(join(tmpdir(), "kanban-service-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  await mkdir(project);
  const launches = { codex: [] as string[], claude: [] as string[] };
  const resumes = { codex: [] as string[], claude: [] as string[] };
  const prompts = new Map<string, string>();
  const services = {} as Record<"codex" | "claude", KanbanService>;
  for (const provider of ["codex", "claude"] as const) {
    const service = new KanbanService({
      provider,
      dataDir: join(directory, "shared"),
      adapter: {
        ...(available ? { available } : {}),
        launch: async (input) => {
          prompts.set(input.id, input.prompt);
          launches[provider].push(input.id);
          return {
            threadId: `${provider}-${input.id}`,
            sessionUrl: `/threads/${provider}-${input.id}`,
          };
        },
        resume: async (input) => {
          prompts.set(input.id, input.prompt);
          resumes[provider].push(input.threadId);
        },
      },
    });
    services[provider] = service;
    await service.initialize();
    cleanups.push(() => service.close());
  }
  async function running(kind: KanbanRun["kind"], cardId: string, provider = services.codex) {
    const board = await until(
      () => provider.read(project),
      (board) =>
        board.runs.some(
          (run) => run.kind === kind && run.cardIds.includes(cardId) && run.status === "running",
        ),
    );
    return board.runs
      .filter(
        (run) => run.kind === kind && run.cardIds.includes(cardId) && run.status === "running",
      )
      .at(-1)!;
  }
  async function command(run: KanbanRun, command: string, payload: unknown) {
    const service = services[run.provider];
    const document = await service.store.read(project);
    const id = randomUUID();
    await atomicJson(join(service.store.directory, "inbox", `${id}.json`), {
      id,
      boardId: document.board.id,
      runId: run.id,
      token: document.runs[run.id]!.token,
      command,
      payload,
    });
    return until(
      async () => {
        try {
          return JSON.parse(
            await readFile(join(service.store.directory, "results", `${id}.json`), "utf8"),
          ) as { ok: boolean; result?: Record<string, unknown>; error?: string };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      (result) => result !== null,
    );
  }
  async function card(description: string, scope = "task") {
    const board = await services.codex.createCard(project, {
      description,
      clientCreationId: randomUUID(),
    });
    const value = board.cards.at(-1)!;
    const run = await running("classify", value.id);
    expect(
      (await command(run, "report", { title: description, category: "General", scope }))?.ok,
    ).toBe(true);
    return value.id;
  }
  return { directory, project, services, launches, resumes, prompts, running, command, card };
}

describe("shared provider board service", () => {
  it.each(["codex", "claude"] as const)(
    "delivers readable assignments and fresh workflow files for %s launch and rework",
    async (provider) => {
      const f = await fixture();
      const id = await f.card("Attach an image when creating a task");
      const service = f.services[provider];
      await service.action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      });
      const executor = await f.running("execute", id, service);
      const instructionsPath = (run: KanbanRun) =>
        join(service.store.directory, "capabilities", `${run.id}.md`);
      expect(f.prompts.get(executor.id)).toContain("Attach an image when creating a task");
      expect(f.prompts.get(executor.id)).toContain(JSON.stringify(instructionsPath(executor)));
      expect(await readFile(instructionsPath(executor), "utf8")).toContain("prepare-repository");
      expect((await f.command(executor, "report", { outcome: "completed" }))?.ok).toBe(true);

      await service.action(f.project, {
        action: "rework",
        cardIds: [id],
        comment: "Also support clipboard images",
        clientActionId: randomUUID(),
      });
      const rework = await f.running("execute", id, service);
      expect(rework.id).not.toBe(executor.id);
      expect(rework.threadId).toBe(executor.threadId);
      expect(f.prompts.get(rework.id)).toContain("Also support clipboard images");
      expect(f.prompts.get(rework.id)).toContain(JSON.stringify(instructionsPath(rework)));
      expect(await readFile(instructionsPath(rework), "utf8")).toContain(
        "Operator instruction: Also support clipboard images",
      );
    },
  );
  it("creates exactly one card for retried creation and agent classification is shared", async () => {
    const f = await fixture();
    const request = { description: "Fix layout", clientCreationId: randomUUID() };
    await Promise.all([
      f.services.codex.createCard(f.project, request),
      f.services.claude.createCard(f.project, request),
    ]);
    const board = await f.services.codex.read(f.project);
    expect(board.cards).toHaveLength(1);
    const classifier = await f.running("classify", board.cards[0]!.id);
    expect(
      (
        await f.command(classifier, "report", {
          title: "Layout",
          category: "Interface",
          scope: "task",
        })
      )?.ok,
    ).toBe(true);
    expect((await f.services.claude.read(f.project)).cards[0]).toMatchObject({
      title: "Layout",
      classification: "ready",
    });
  });
  it("prevents concurrent execution across providers and routes rework to the original provider", async () => {
    const f = await fixture();
    const id = await f.card("Implement A");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", id);
    await expect(
      f.services.claude.action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      }),
    ).rejects.toThrow("active session");
    expect((await f.command(executor, "report", { outcome: "completed" }))?.ok).toBe(true);
    await f.services.claude.action(f.project, {
      action: "rework",
      cardIds: [id],
      comment: "Improve it",
      clientActionId: randomUUID(),
    });
    await until(
      async () => f.resumes.codex,
      (values) => values.length === 1,
    );
    expect(f.resumes.codex[0]).toBe(executor.threadId);
    expect(f.resumes.claude).toEqual([]);
  });
  it("enforces worker card scope and rejects Done without publication evidence", async () => {
    const f = await fixture();
    const first = await f.card("Implement A"),
      second = await f.card("Implement B");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [first],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", first);
    await f.services.codex.store.update(f.project, (data) => {
      data.board.cards
        .find((card) => card.id === second)!
        .repositories.push({
          id: "context-repository",
          path: "/original/repo",
          targetBranch: "experiment",
          branch: "task/other",
          baseSha: "a".repeat(40),
          commit: null,
          status: "working",
          error: null,
        });
    });
    const context = await f.command(executor, "read", {});
    const other = (await f.services.codex.read(f.project)).cards.find(
      (card) => card.id === second,
    )!;
    expect(context?.result?.readOnlyContext).toEqual([
      {
        id: second,
        title: "Implement B",
        stageId: other.stageId,
        categoryId: other.categoryId,
        repositories: [{ path: "/original/repo", targetBranch: "experiment", status: "working" }],
      },
    ]);
    expect(
      (context?.result?.board as { cards: { id: string }[] }).cards.map((card) => card.id),
    ).toEqual([first]);
    expect(
      (
        await f.command(executor, "update-card", {
          cardId: second,
          patch: { title: "Unauthorized" },
        })
      )?.ok,
    ).toBe(false);
    expect((await f.command(executor, "move", { cardId: first, stageId: "done" }))?.ok).toBe(false);
    expect(
      (await f.services.codex.read(f.project)).cards.find((card) => card.id === second)?.title,
    ).toBe("Implement B");
  });
  it("lets an explicitly assigned board audit close a no-output card", async () => {
    const f = await fixture();
    const target = await f.card("Already done outside this board"),
      audit = await f.card("Audit and close fulfilled cards", "board");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [audit],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", audit);
    expect((await f.command(executor, "move", { cardId: target, stageId: "done" }))?.ok).toBe(true);
    expect(
      (await f.services.codex.read(f.project)).cards.find((card) => card.id === target)?.stageId,
    ).toBe("done");
  });
  it("keeps native turn completion waiting and returns to working on operator continuation", async () => {
    const f = await fixture();
    const id = await f.card("Implement A");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const run = await f.running("execute", id);
    await f.services.codex.notifyThread(run.threadId!, "completed");
    let board = await f.services.codex.read(f.project);
    expect(board.runs.find((item) => item.id === run.id)?.status).toBe("waiting");
    expect(board.cards[0]?.stageId).not.toBe("done");
    const custom = await f.services.codex.createStage(f.project, {
      name: "Operator",
      description: "Needs intervention",
    });
    await f.services.codex.updateCard(f.project, id, { stageId: custom.stages.at(-1)!.id });
    await f.services.codex.notifyThread(run.threadId!, "running");
    board = await f.services.codex.read(f.project);
    expect(board.cards[0]?.stageId).toBe("working");
  });
  it("resumes provider-owned durable queued jobs after service initialization", async () => {
    const f = await fixture();
    await f.services.codex.close();
    const board = await f.services.codex.createCard(f.project, {
      description: "Deferred",
      clientCreationId: randomUUID(),
    });
    const queuedId = board.runs[0]!.id;
    await f.services.codex.initialize();
    await f.running("classify", board.cards[0]!.id);
    expect(f.launches.codex.filter((id) => id === queuedId)).toHaveLength(1);
  });
  it("automatically groups different target branches and marks every selected card after publication", async () => {
    const f = await fixture();
    const first = await f.card("Main feature"),
      second = await f.card("Experimental feature");
    for (const id of [first, second])
      await f.services.codex.action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      });
    const runs = await Promise.all([f.running("execute", first), f.running("execute", second)]);
    for (const [index, run] of runs.entries()) {
      expect(
        (
          await f.command(run, "prepare-repository", {
            repositoryPath: f.project,
            targetBranch: index ? "experiment" : "main",
          })
        )?.ok,
      ).toBe(true);
      expect((await f.command(run, "report", { outcome: "completed" }))?.result?.next).toBe(
        "review",
      );
      await f.services.codex.action(f.project, {
        action: "accept",
        cardIds: run.cardIds,
        clientActionId: randomUUID(),
      });
    }
    await f.services.codex.action(f.project, {
      action: "integrate",
      cardIds: [first, second],
      clientActionId: randomUUID(),
    });
    const integrator = await f.running("integrate", first);
    expect((await f.command(integrator, "prepare-integration", {}))?.ok).toBe(true);
    expect(fake.groups).toHaveLength(2);
    expect((await f.command(integrator, "publish", {}))?.ok).toBe(true);
    const board = await f.services.codex.read(f.project);
    expect(board.cards.every((card) => card.stageId === "done")).toBe(true);
  });
  it("completes solo no-code work directly without a review gate", async () => {
    const f = await fixture();
    const id = await f.card("Explain the architecture");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", id);
    expect((await f.command(executor, "report", { outcome: "completed" }))?.result?.next).toBe(
      "done",
    );
    expect((await f.services.codex.read(f.project)).cards[0]?.stageId).toBe("done");
  });
  it("does not scan idle boards continuously after watcher events settle", async () => {
    const f = await fixture();
    await f.services.codex.read(f.project);
    const calls = vi.spyOn(f.services.codex.store, "list");
    await new Promise((resolve) => setTimeout(resolve, 120));
    calls.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls).not.toHaveBeenCalled();
  });
  it("revalidates exact accepted commits again after integration was prepared", async () => {
    const f = await fixture();
    const id = await f.card("A solo code change");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", id);
    await f.command(executor, "prepare-repository", {
      repositoryPath: f.project,
      targetBranch: "main",
    });
    expect((await f.command(executor, "report", { outcome: "completed" }))?.result?.next).toBe(
      "publish",
    );
    expect((await f.command(executor, "prepare-integration", {}))?.ok).toBe(true);
    const results = fake.candidates.get(id)! as { repository: unknown; sha: string }[];
    results[0]!.sha = "d".repeat(40);
    const published = await f.command(executor, "publish", {});
    expect(published?.ok).toBe(false);
    expect(published?.error).toContain("changed after integration");
    expect((await f.services.codex.read(f.project)).cards[0]?.stageId).not.toBe("done");
  });

  it("serializes concurrent repository preparations within one task capability", async () => {
    const f = await fixture();
    const id = await f.card("A two-repository change");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", id);
    const responses = await Promise.all([
      f.command(executor, "prepare-repository", {
        repositoryPath: join(f.project, "one"),
        targetBranch: "main",
      }),
      f.command(executor, "prepare-repository", {
        repositoryPath: join(f.project, "two"),
        targetBranch: "main",
      }),
    ]);
    expect(responses.every((response) => response?.ok)).toBe(true);
    const document = await f.services.codex.store.read(f.project);
    expect(document.cards[id]?.workspace?.repositories).toHaveLength(2);
    expect(document.board.cards[0]?.repositories).toHaveLength(2);
  });
  it("waits for a launching adapter to persist its thread before close returns", async () => {
    const f = await fixture();
    const dataDir = join(f.directory, "closing");
    let unblock!: () => void, started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const service = new KanbanService({
      provider: "codex",
      dataDir,
      adapter: {
        launch: async (input) => {
          started();
          await blocked;
          return { threadId: input.id };
        },
        resume: async () => {},
      },
    });
    await service.initialize();
    cleanups.push(() => service.close());
    const board = await service.createCard(f.project, {
      description: "Closing fixture",
      clientCreationId: randomUUID(),
    });
    await entered;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    unblock();
    await closing;
    expect((await service.read(f.project)).runs[0]?.threadId).toBe(board.runs[0]?.id);
  });
  it("keeps unavailable-provider jobs queued and starts them only after wake", async () => {
    let available = false;
    const f = await fixture(() => available);
    const board = await f.services.codex.createCard(f.project, {
      description: "Wait until ready",
      clientCreationId: randomUUID(),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.launches.codex).toEqual([]);
    expect((await f.services.codex.read(f.project)).runs[0]?.status).toBe("queued");
    available = true;
    f.services.codex.wake();
    await f.running("classify", board.cards[0]!.id);
    expect(f.launches.codex).toHaveLength(1);
  });
  it("handles a turn completing immediately when the running session is persisted", async () => {
    const f = await fixture();
    const id = await f.card("Immediate completion");
    const service = f.services.codex;
    const update = service.store.updateById.bind(service.store);
    let notified = false;
    vi.spyOn(service.store, "updateById").mockImplementation(async function <T>(
      boardId: string,
      mutate: (document: KanbanDocument) => T | Promise<T>,
    ) {
      const saved = await update(boardId, mutate);
      const justAttached = saved.board.runs.find(
        (run) =>
          run.kind === "execute" &&
          run.cardIds.includes(id) &&
          run.status === "running" &&
          run.threadId,
      );
      if (justAttached && !notified) {
        notified = true;
        await service.notifyThread(justAttached.threadId!, "completed");
      }
      return saved;
    });
    await service.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    await until(
      async () => notified,
      (value) => value,
    );
    await service.close();
    const run = (await service.read(f.project)).runs.find(
      (run) => run.kind === "execute" && run.cardIds.includes(id),
    );
    expect(run?.status).toBe("waiting");
    expect(run?.error).toContain("without a task report");
  });
  it.each(["completed", null] as const)(
    "reconciles a persisted running session once on startup when local state is %s",
    async (state) => {
      const f = await fixture();
      const id = await f.card("Restore an existing session");
      await f.services.codex.action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      });
      const original = await f.running("execute", id);
      await f.services.codex.close();
      const threadState = vi.fn(async () => state);
      const launch = vi.fn(async () => {
        throw new Error("Must not relaunch an existing session");
      });
      const restored = new KanbanService({
        provider: "codex",
        dataDir: f.services.codex.store.directory,
        adapter: { launch, resume: async () => {}, threadState },
      });
      cleanups.push(() => restored.close());
      await restored.initialize();
      const board = await restored.read(f.project);
      expect(board.runs.find((run) => run.id === original.id)?.status).toBe("waiting");
      expect(board.cards.find((card) => card.id === id)?.stageId).not.toBe("done");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(threadState).toHaveBeenCalledExactlyOnceWith(original.threadId);
      expect(launch).not.toHaveBeenCalled();
    },
  );
});
