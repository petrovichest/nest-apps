import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanRun } from "@codexnest/protocol";
import { atomicJson } from "./store.js";
import { KanbanService } from "./service.js";

const fake = vi.hoisted(() => ({
  candidates: new Map<string, unknown[]>(),
  pauseValidation: false,
  validationEntered: () => {},
  validationReleased: Promise.resolve(),
  publicationAttempts: [] as string[],
  failSecondRepository: false,
  firstRepositoryAdvanced: false,
  published: false,
}));

vi.mock("./workspace.js", () => ({
  createTaskWorkspace: vi.fn(
    async (input: { taskId: string; projectPath: string; workspaceRoot: string }) => ({
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
      const name = basename(input.repositoryPath);
      const repository = {
        id: `${workspace.id}-${name}`,
        sourcePath: input.repositoryPath,
        relativePath: name,
        gitCommonDir: `/git/${name}`,
        workspacePath: `/isolated/${workspace.id}/${name}`,
        branch: `task/${workspace.id}`,
        targetBranch: input.targetBranch,
        baseSha: "a".repeat(40),
        targetSha: "a".repeat(40),
        remote: "origin",
      };
      workspace.repositories.push(repository);
      const candidates = fake.candidates.get(workspace.id) ?? [];
      candidates.push({ repository, sha: "b".repeat(40), changed: true });
      fake.candidates.set(workspace.id, candidates);
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
    }) => ({
      id: input.integrationId,
      projectPath: input.projectPath,
      rootPath: `/integration/${input.integrationId}`,
      repositories: input.results.map((item) => ({
        ...item.repository,
        id: `integration-${item.repository.id}`,
        inputShas: [item.sha],
        expectedTargetSha: "a".repeat(40),
        mergeStatus: "merged",
      })),
    }),
  ),
  validateIntegrationWorkspace: vi.fn(
    async (workspace: { repositories: { id: string; publishedSha?: string }[] }) => {
      if (fake.pauseValidation) {
        fake.validationEntered();
        await fake.validationReleased;
      }
      return workspace.repositories.map((repository) => ({ repository, sha: "c".repeat(40) }));
    },
  ),
  publishIntegrationRepository: vi.fn(
    async (repository: { id: string; sourcePath: string; targetBranch: string }) => {
      const name = basename(repository.sourcePath);
      fake.publicationAttempts.push(name);
      if (name === "a" && fake.firstRepositoryAdvanced)
        throw new Error("The already published target advanced externally");
      if (name === "b" && fake.failSecondRepository)
        throw new Error("Remote B temporarily rejected the push");
      fake.published = true;
      return {
        repositoryId: repository.id,
        sha: "c".repeat(40),
        targetBranch: repository.targetBranch,
        remote: "origin",
        pushed: true,
        localOnly: false,
      };
    },
  ),
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
beforeEach(() => {
  fake.candidates.clear();
  fake.publicationAttempts.length = 0;
  fake.pauseValidation = false;
  fake.validationEntered = () => {};
  fake.validationReleased = Promise.resolve();
  fake.failSecondRepository = false;
  fake.firstRepositoryAdvanced = false;
  fake.published = false;
});

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = await read();
    if (predicate(result)) return result;
    if (Date.now() > deadline) throw new Error("Timed out waiting for board operation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kanban-race-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  await mkdir(project);
  const executionStarts: { provider: string; afterPublication: boolean }[] = [];
  const services = {} as Record<"codex" | "claude", KanbanService>;
  for (const provider of ["codex", "claude"] as const) {
    const service = new KanbanService({
      provider,
      dataDir: join(directory, "shared"),
      adapter: {
        launch: async (input) => {
          if (input.kind === "execute")
            executionStarts.push({ provider, afterPublication: fake.published });
          return {
            threadId: `${provider}-${input.id}`,
            sessionUrl: `/threads/${provider}-${input.id}`,
          };
        },
        resume: async () => {},
      },
    });
    services[provider] = service;
    await service.initialize();
    cleanups.push(() => service.close());
  }
  const read = () => services.codex.read(project);
  async function running(kind: KanbanRun["kind"], cardId: string): Promise<KanbanRun> {
    const current = await until(read, (board) =>
      board.runs.some(
        (run) => run.kind === kind && run.cardIds.includes(cardId) && run.status === "running",
      ),
    );
    return current.runs.find(
      (run) => run.kind === kind && run.cardIds.includes(cardId) && run.status === "running",
    )!;
  }
  async function command(run: KanbanRun, command: string, payload: unknown = {}) {
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
    const result = await until(
      async () => {
        try {
          return JSON.parse(
            await readFile(join(service.store.directory, "results", `${id}.json`), "utf8"),
          ) as { ok: boolean; result?: { next?: string }; error?: string };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      (result) => result !== null,
    );
    return result!;
  }
  async function card(description: string) {
    const current = await services.codex.createCard(project, {
      description,
      clientCreationId: randomUUID(),
    });
    const id = current.cards.at(-1)!.id;
    expect(
      (
        await command(await running("classify", id), "report", {
          title: description,
          category: "Tasks",
          scope: "task",
        })
      ).ok,
    ).toBe(true);
    return id;
  }
  async function execution(id: string, repositories: string[]) {
    await services.codex.action(project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const run = await running("execute", id);
    for (const name of repositories)
      expect(
        (
          await command(run, "prepare-repository", {
            repositoryPath: join(project, name),
            targetBranch: "main",
          })
        ).ok,
      ).toBe(true);
    expect(await command(run, "report", { outcome: "completed" })).toMatchObject({
      ok: true,
      result: { next: "publish" },
    });
    expect((await command(run, "prepare-integration")).ok).toBe(true);
    return run;
  }
  return { project, services, executionStarts, read, running, command, card, execution };
}

describe("board publication races", () => {
  it("keeps another provider from starting execution while a solo publication is reserved", async () => {
    const f = await fixture();
    const first = await f.card("First task");
    const second = await f.card("Second task");
    const executor = await f.execution(first, ["a"]);
    let entered!: () => void;
    let release!: () => void;
    const enteredValidation = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fake.validationEntered = entered;
    fake.validationReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.pauseValidation = true;
    const publication = f.command(executor, "publish");
    await enteredValidation;
    const nextExecution = f.services.claude
      .action(f.project, { action: "execute", cardIds: [second], clientActionId: randomUUID() })
      .then(
        () => true,
        () => false,
      );
    try {
      // Both servers are alive and process filesystem events while the first publication
      // is deliberately held between validation and its Git side effects.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(f.executionStarts).toEqual([{ provider: "codex", afterPublication: false }]);
    } finally {
      fake.pauseValidation = false;
      release();
      expect((await publication).ok).toBe(true);
      if (await nextExecution) await f.running("execute", second);
    }
    expect(
      f.executionStarts
        .filter((start) => start.provider === "claude")
        .every((start) => start.afterPublication),
    ).toBe(true);
  });

  it("resumes only the missing repository after partial publication even when an earlier target advances", async () => {
    const f = await fixture();
    const id = await f.card("Change both repositories");
    const executor = await f.execution(id, ["a", "b"]);
    fake.failSecondRepository = true;
    expect(await f.command(executor, "publish")).toMatchObject({
      ok: false,
      error: "Remote B temporarily rejected the push",
    });
    let current = await f.read();
    expect(current.cards[0]!.repositories.map((repo) => repo.status)).toEqual([
      "published",
      "failed",
    ]);
    expect(current.cards[0]!.stageId).not.toBe("done");
    fake.firstRepositoryAdvanced = true;
    fake.failSecondRepository = false;
    expect(await f.command(executor, "publish")).toMatchObject({
      ok: true,
      result: { next: "done" },
    });
    current = await f.read();
    expect(current.cards[0]!.stageId).toBe("done");
    expect(current.cards[0]!.repositories.every((repo) => repo.status === "published")).toBe(true);
    expect(fake.publicationAttempts).toEqual(["a", "b", "b"]);
  });
});
