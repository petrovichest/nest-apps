import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanRun } from "@codexnest/protocol";
import { atomicJson, type KanbanDocument } from "./store.js";
import { KanbanService, type KanbanLaunch } from "./service.js";

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
  removeTaskWorkspace: vi.fn(async () => {}),
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
async function fixture(
  available?: () => boolean,
  transcribe?: (audio: Buffer, contentType: string, durationMs: number) => Promise<string>,
) {
  const directory = await mkdtemp(join(tmpdir(), "kanban-service-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  await mkdir(project);
  const launches = { codex: [] as string[], claude: [] as string[] };
  const inputs = { codex: [] as KanbanLaunch[], claude: [] as KanbanLaunch[] };
  const resumedInputs: { images?: string[] }[] = [];
  const resumes = { codex: [] as string[], claude: [] as string[] };
  const archived = { codex: [] as string[], claude: [] as string[] };
  const interrupted = { codex: [] as string[], claude: [] as string[] };
  const prompts = new Map<string, string>();
  const services = {} as Record<"codex" | "claude", KanbanService>;
  for (const provider of ["codex", "claude"] as const) {
    const service = new KanbanService({
      provider,
      ...(transcribe ? { transcribe } : {}),
      dataDir: join(directory, "shared"),
      adapter: {
        ...(available ? { available } : {}),
        launch: async (input) => {
          prompts.set(input.id, input.prompt);
          launches[provider].push(input.id);
          inputs[provider].push(input);
          return {
            threadId: `${provider}-${input.id}`,
            sessionUrl: `/threads/${provider}-${input.id}`,
          };
        },
        resume: async (input) => {
          prompts.set(input.id, input.prompt);
          resumes[provider].push(input.threadId);
          resumedInputs.push(input);
        },
        archive: async (threadId) => {
          archived[provider].push(threadId);
        },
        interrupt: async (threadId) => {
          interrupted[provider].push(threadId);
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
    // New cards are placed at the top of To do.
    const value = board.cards[0]!;
    const run = await running("classify", value.id);
    expect(
      (await command(run, "report", { title: description, category: "General", scope }))?.ok,
    ).toBe(true);
    return value.id;
  }
  return {
    directory,
    project,
    services,
    launches,
    inputs,
    resumedInputs,
    resumes,
    archived,
    interrupted,
    prompts,
    running,
    command,
    card,
  };
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
  it.each(["codex", "claude"] as const)(
    "persists images outside board JSON and delivers them on %s launch and rework",
    async (provider) => {
      const f = await fixture();
      const service = f.services[provider];
      const sibling = f.services[provider === "codex" ? "claude" : "codex"];
      const image = {
        name: "../screenshot.png",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
      };
      const request = { description: "Match screenshot", clientCreationId: randomUUID(), image };
      const created = await service.createCard(f.project, request);
      const id = created.cards[0]!.id;
      expect(created.cards[0]!.images?.[0]).toMatchObject({
        name: image.name,
        mediaType: "image/png",
      });
      expect(JSON.stringify(created)).not.toContain(image.url);
      expect(await sibling.readImage(f.project, id)).toEqual(image);
      expect((await sibling.createCard(f.project, request)).cards).toHaveLength(1);
      await expect(
        service.createCard(f.project, { ...request, image: { ...image, name: "different.png" } }),
      ).rejects.toThrow("different content");
      await expect(service.createCard(f.project, { ...request, image: undefined })).rejects.toThrow(
        "different content",
      );
      const classify = await f.running("classify", id, service);
      expect(f.inputs[provider].find((input) => input.id === classify.id)?.images).toEqual([
        image.url,
      ]);
      await f.command(classify, "report", { title: "Screenshot", category: "UI", scope: "task" });
      await service.action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      });
      const execute = await f.running("execute", id, service);
      expect(f.inputs[provider].find((input) => input.id === execute.id)?.images).toEqual([
        image.url,
      ]);
      await f.command(execute, "report", { outcome: "completed" });
      await sibling.action(f.project, {
        action: "rework",
        cardIds: [id],
        comment: "Try again",
        clientActionId: randomUUID(),
      });
      await until(
        async () => f.resumedInputs,
        (inputs) => inputs.length === 1,
      );
      expect(f.resumedInputs[0]?.images).toEqual([image.url]);
    },
  );
  it("rejects invalid images without creating cards and scopes image reads to the project", async () => {
    const f = await fixture();
    const service = f.services.codex;
    for (const image of [
      null,
      {},
      { name: "bad.svg", url: "data:image/svg+xml;base64,PHN2Zy8+" },
      { name: "bad.png", url: "https://example.com/image.png" },
      { name: "bad.png", url: "data:image/png;base64,AAAA" },
      { name: "large.png", url: `data:image/png;base64,${"A".repeat(14 * 1024 * 1024)}` },
    ]) {
      await expect(
        service.createCard(f.project, {
          description: "Invalid",
          clientCreationId: randomUUID(),
          image,
        } as never),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect((await service.read(f.project)).cards).toHaveLength(0);
    const id = await f.card("Text only");
    await expect(service.readImage(f.project, id)).rejects.toMatchObject({ status: 404 });
    const other = join(f.directory, "other");
    await mkdir(other);
    await expect(service.readImage(other, id)).rejects.toMatchObject({ status: 404 });
  });
  it("runs one agent per application side by side and asks which result to accept", async () => {
    const f = await fixture();
    const id = await f.card("Implement A");
    const start = (provider: "codex" | "claude", extra: Record<string, unknown> = {}) =>
      f.services[provider].action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
        ...extra,
      });
    await start("codex");
    const codex = await f.running("execute", id);
    await expect(start("codex")).rejects.toThrow("active session");
    await start("claude");
    const claude = await until(
      () => f.services.claude.read(f.project),
      (board) =>
        board.runs.some(
          (run) => run.provider === "claude" && run.kind === "execute" && run.status === "running",
        ),
    ).then((board) => board.runs.find((run) => run.provider === "claude")!);
    // Each agent works in its own clean copy and branch.
    expect(codex.workspacePath).not.toBe(claude.workspacePath);
    for (const run of [codex, claude])
      expect(
        (
          await f.command(run, "prepare-repository", {
            repositoryPath: f.project,
            targetBranch: "main",
          })
        )?.ok,
      ).toBe(true);
    // The first result waits for the other agent instead of publishing on its own.
    expect((await f.command(codex, "report", { outcome: "completed" }))?.result?.next).toBe(
      "review",
    );
    expect((await f.services.codex.read(f.project)).cards[0]?.stageId).toBe("working");
    await expect(start("codex")).rejects.toThrow("use rework or restart");
    expect((await f.command(claude, "report", { outcome: "completed" }))?.result?.next).toBe(
      "review",
    );
    expect((await f.services.codex.read(f.project)).cards[0]?.stageId).toBe("review");
    await expect(
      f.services.codex.action(f.project, {
        action: "accept",
        cardIds: [id],
        clientActionId: randomUUID(),
      }),
    ).rejects.toThrow("choose one");
    const board = await f.services.codex.action(f.project, {
      action: "accept",
      cardIds: [id],
      provider: "claude",
      clientActionId: randomUUID(),
    });
    const accepted = board.cards.find((card) => card.id === id)!;
    expect(accepted.stageId).toBe("ready");
    expect(accepted.repositories.map((repository) => repository.branch)).toEqual([
      `task/${id}-${claude.id.slice(0, 8)}`,
    ]);
  });
  it("restarts an agent from a clean copy, stops its session and routes rework to it", async () => {
    const f = await fixture();
    const id = await f.card("Implement A");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const first = await f.running("execute", id);
    expect(
      (
        await f.command(first, "prepare-repository", {
          repositoryPath: f.project,
          targetBranch: "main",
        })
      )?.ok,
    ).toBe(true);
    // A restart requested from the other application reaches the agent that owns the task.
    await f.services.claude.action(f.project, {
      action: "restart",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const second = await until(
      () => f.services.codex.read(f.project),
      (board) => board.runs.some((run) => run.status === "running" && run.id !== first.id),
    ).then((board) => board.runs.find((run) => run.status === "running")!);
    expect(second.provider).toBe("codex");
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.workspacePath).not.toBe(first.workspacePath);
    expect(f.interrupted.codex).toEqual([first.threadId]);
    expect(f.prompts.get(second.id)).toContain("Implement A");
    const board = await f.services.codex.read(f.project);
    expect(board.runs.find((run) => run.id === first.id)?.status).toBe("completed");
    // The old session can no longer report for the task.
    expect((await f.command(first, "report", { outcome: "completed" }))?.error).toContain(
      "already finished",
    );
    expect((await f.command(second, "report", { outcome: "completed" }))?.ok).toBe(true);
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
    expect(f.resumes.codex[0]).toBe(second.threadId);
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

  it("keeps a manual order: new and moved cards go on top, cards move within their stage", async () => {
    const f = await fixture();
    const create = (description: string) =>
      f.services.codex.createCard(f.project, { description, clientCreationId: randomUUID() });
    await create("A");
    await create("B");
    let board = await create("C");
    const [c, b, a] = board.cards.map((item) => item.id);
    expect(board.cards.map((item) => item.title)).toEqual(["C", "B", "A"]);
    board = await f.services.codex.updateCard(f.project, a!, { beforeCardId: c! });
    expect(board.cards.map((item) => item.title)).toEqual(["A", "C", "B"]);
    board = await f.services.codex.updateCard(f.project, c!, { beforeCardId: null });
    expect(board.cards.map((item) => item.title)).toEqual(["A", "B", "C"]);
    board = await f.services.codex.createStage(f.project, { name: "Deploy" });
    const deploy = board.stages.at(-1)!.id;
    board = await f.services.codex.updateCard(f.project, b!, { stageId: deploy });
    expect(board.cards.map((item) => item.title)).toEqual(["B", "A", "C"]);
    await expect(
      f.services.codex.updateCard(f.project, a!, { beforeCardId: b! }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("archives idle cards only, restores them and moves week-old Done cards to the archive", async () => {
    const f = await fixture();
    const id = await f.card("Archive me");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", id);
    await expect(
      f.services.codex.updateCard(f.project, id, { archived: true }),
    ).rejects.toMatchObject({ code: "already_running" });
    expect((await f.command(executor, "report", { outcome: "completed" }))?.ok).toBe(true);
    let board = await f.services.codex.updateCard(f.project, id, { archived: true });
    expect(board.cards[0]!.archivedAt).toEqual(expect.any(Number));
    await expect(
      f.services.claude.action(f.project, {
        action: "rework",
        cardIds: [id],
        comment: "More",
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "archived" });
    board = await f.services.codex.updateCard(f.project, id, { archived: false });
    expect(board.cards[0]!.archivedAt).toBeUndefined();

    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await f.services.codex.store.update(f.project, (data) => {
      const card = data.board.cards[0]!;
      card.stageId = data.board.stages.find((stage) => stage.role === "done")!.id;
      card.doneAt = old;
    });
    board = await f.services.claude.read(f.project);
    expect(board.cards[0]!.archivedAt).toBeGreaterThan(old);
    board = await f.services.codex.updateCard(f.project, id, { archived: false });
    expect(board.cards[0]!.doneAt).toBeGreaterThan(old);
    expect((await f.services.codex.read(f.project)).cards[0]!.archivedAt).toBeUndefined();
  });

  it("deletes only archived cards with their worktrees and this application's sessions", async () => {
    const workspace = await import("./workspace.js");
    const f = await fixture();
    const id = await f.card("Delete me");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", id);
    expect((await f.command(executor, "report", { outcome: "completed" }))?.ok).toBe(true);
    const task = { id: "task", projectPath: f.project, rootPath: "/w/task", repositories: [] };
    await f.services.codex.store.update(f.project, (data) => {
      data.cards[id]!.workspace = task;
    });
    await expect(f.services.codex.deleteCard(f.project, id)).rejects.toMatchObject({
      code: "not_archived",
    });
    await f.services.codex.updateCard(f.project, id, { archived: true });
    const board = await f.services.codex.deleteCard(f.project, id);
    expect(board.cards).toEqual([]);
    expect(board.runs.filter((run) => run.cardIds.includes(id))).toEqual([]);
    expect(workspace.removeTaskWorkspace).toHaveBeenCalledWith(
      task,
      join(f.services.codex.store.directory, "workspaces"),
    );
    expect(f.archived.codex).toContain(executor.threadId);
    expect(Object.keys((await f.services.codex.store.read(f.project)).cards)).toEqual([]);
  });

  it("renames, describes, reorders and deletes stages without moving standard ones", async () => {
    const f = await fixture();
    await f.services.codex.createStage(f.project, { name: "Deploy" });
    let board = await f.services.codex.createStage(f.project, { name: "Later" });
    const todo = board.stages.find((stage) => stage.role === "todo")!.id;
    const [deploy, later] = board.stages.slice(-2).map((stage) => stage.id);
    board = await f.services.codex.updateStage(f.project, todo, {
      name: "Backlog",
      description: "Ideas",
    });
    expect(board.stages[0]).toMatchObject({ name: "Backlog", description: "Ideas", renamed: true });
    board = await f.services.codex.updateStage(f.project, later!, { beforeStageId: todo });
    expect(board.stages.map((stage) => stage.name).slice(0, 2)).toEqual(["Later", "Backlog"]);
    await expect(
      f.services.codex.updateStage(f.project, todo, { beforeStageId: null }),
    ).rejects.toMatchObject({ code: "standard_stage" });
    await expect(f.services.codex.deleteStage(f.project, todo)).rejects.toMatchObject({
      code: "standard_stage",
    });
    await expect(
      f.services.codex.updateStage(f.project, deploy!, { name: "later" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.services.codex.createCard(f.project, {
      description: "Keep",
      clientCreationId: randomUUID(),
    });
    board = await f.services.codex.createCard(f.project, {
      description: "Ship",
      clientCreationId: randomUUID(),
    });
    await f.services.codex.updateCard(f.project, board.cards[0]!.id, { stageId: deploy! });
    board = await f.services.codex.deleteStage(f.project, deploy!);
    expect(board.stages.some((stage) => stage.id === deploy)).toBe(false);
    expect(board.cards.map((card) => [card.title, card.stageId])).toEqual([
      ["Ship", todo],
      ["Keep", todo],
    ]);
  });

  const png = {
    name: "shot.png",
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=",
  };
  const recording = (text: string) => ({
    mediaType: "audio/webm;codecs=opus",
    data: Buffer.from(text).toString("base64"),
    durationMs: 1200,
  });

  it("creates a spoken task at once, transcribes it, then classifies and passes every image", async () => {
    const transcribe = vi.fn(async () => "Spoken details");
    const f = await fixture(undefined, transcribe);
    let board = await f.services.codex.createCard(f.project, {
      description: "Typed start",
      clientCreationId: randomUUID(),
      images: [png, { ...png, name: "second.png" }],
      audio: recording("voice"),
    });
    const id = board.cards[0]!.id;
    expect(board.cards[0]).toMatchObject({
      description: "Typed start",
      voice: { purpose: "create", status: "transcribing", provider: "codex" },
    });
    expect(board.cards[0]!.images?.map((image) => image.name)).toEqual(["shot.png", "second.png"]);
    expect(board.runs.filter((run) => run.kind === "classify")).toEqual([]);
    const classifier = await f.running("classify", id);
    board = await f.services.claude.read(f.project);
    expect(board.cards[0]).toMatchObject({ description: "Typed start\n\nSpoken details" });
    expect(board.cards[0]!.voice).toBeUndefined();
    expect(transcribe).toHaveBeenCalledWith(Buffer.from("voice"), "audio/webm;codecs=opus", 1200);
    expect((await f.services.codex.readImage(f.project, id, 1)).name).toBe("second.png");
    expect(
      (await f.command(classifier, "report", { title: "Spoken", category: "General" }))?.ok,
    ).toBe(true);
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    await f.running("execute", id);
    expect(f.inputs.codex.at(-1)?.images).toHaveLength(2);
  });

  it("keeps a failed recording retryable and refuses recordings without speech recognition", async () => {
    const transcribe = vi
      .fn<(audio: Buffer, contentType: string, durationMs: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error("Recognizer offline"))
      .mockResolvedValue("Second try");
    const f = await fixture(undefined, transcribe);
    let board = await f.services.codex.createCard(f.project, {
      description: "",
      clientCreationId: randomUUID(),
      audio: recording("voice"),
    });
    const id = board.cards[0]!.id;
    board = await until(
      () => f.services.codex.read(f.project),
      (current) => current.cards[0]?.voice?.status === "failed",
    );
    expect(board.cards[0]!.voice?.error).toBe("Recognizer offline");
    await expect(
      f.services.codex.action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "voice_pending" });
    await f.services.codex.action(f.project, {
      action: "retry-transcription",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    await f.running("classify", id);
    expect((await f.services.codex.read(f.project)).cards[0]!.title).toBe("Second try");

    const plain = await fixture();
    await expect(
      plain.services.codex.createCard(plain.project, {
        description: "",
        clientCreationId: randomUUID(),
        audio: recording("voice"),
      }),
    ).rejects.toMatchObject({ code: "transcription_unavailable" });
  });

  it("transcribes a spoken rework comment and resumes the original session with its images", async () => {
    const transcribe = vi.fn(async () => "Also handle the empty state");
    const f = await fixture(undefined, transcribe);
    const id = await f.card("Fix the list");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", id);
    expect((await f.command(executor, "report", { outcome: "completed" }))?.ok).toBe(true);
    const board = await f.services.claude.action(f.project, {
      action: "rework",
      cardIds: [id],
      comment: "Keep the header",
      images: [png],
      audio: recording("rework"),
      clientActionId: randomUUID(),
    });
    expect(board.cards[0]!.voice).toMatchObject({ purpose: "rework", provider: "claude" });
    const rework = await until(
      () => f.services.codex.read(f.project),
      (current) =>
        current.runs.filter((run) => run.kind === "execute" && run.cardIds.includes(id)).length ===
        2,
    );
    expect(rework.cards[0]!.voice).toBeUndefined();
    const resumed = await f.running("execute", id);
    expect(resumed.threadId).toBe(executor.threadId);
    expect(f.prompts.get(resumed.id)).toContain("Keep the header\n\nAlso handle the empty state");
    expect(f.resumedInputs.at(-1)?.images).toHaveLength(1);
  });
});
