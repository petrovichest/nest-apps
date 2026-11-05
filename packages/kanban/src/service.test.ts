import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KanbanBoard, KanbanRun } from "@codexnest/protocol";
import { PUBLISH_PROMPT } from "./agent.js";
import { atomicJson, type KanbanDocument } from "./store.js";
import type { ReplyVerdict } from "./reply.js";
import { KanbanService, type KanbanLaunch } from "./service.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
  classifies?: () => boolean,
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
  // The fast check of a finished turn: what the agent asks, by session.
  const questions = new Map<string, string | null>();
  // Sessions whose last reply says the work was pushed.
  const pushed = new Set<string>();
  // The operator's first message, by session.
  const requests = new Map<string, string>();
  const services = {} as Record<"codex" | "claude", KanbanService>;
  for (const provider of ["codex", "claude"] as const) {
    const service = new KanbanService({
      provider,
      ...(transcribe ? { transcribe } : {}),
      ...(classifies ? { classifies } : {}),
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
        readReply: async (threadId) => ({
          question: questions.get(threadId) ?? null,
          published: pushed.has(threadId),
        }),
        readRequest: async (threadId) => requests.get(threadId) ?? null,
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
  /** The session runs one turn and finishes it; question is what the fast check reads. */
  async function finish(run: KanbanRun, question: string | null = null) {
    const service = services[run.provider];
    questions.set(run.threadId!, question);
    await service.notifyThread(run.threadId!, "running");
    await service.notifyThread(run.threadId!, "completed");
    return service.read(project);
  }
  async function card(description: string) {
    const board = await services.codex.createCard(project, {
      description,
      clientCreationId: randomUUID(),
    });
    // New cards are placed at the top of To do.
    const value = board.cards[0]!;
    const run = await running("classify", value.id);
    expect((await command(run, "report", { title: description, category: "General" }))?.ok).toBe(
      true,
    );
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
    questions,
    pushed,
    requests,
    running,
    command,
    finish,
    card,
  };
}

const stage = (board: KanbanBoard, id: string) =>
  board.stages.find((item) => item.id === board.cards.find((card) => card.id === id)?.stageId)
    ?.role;
const runOf = (board: KanbanBoard, id: string) => board.runs.find((run) => run.id === id);

describe("shared provider board service", () => {
  it.each(["codex", "claude"] as const)(
    "starts a %s task as an ordinary session in the project with only its text",
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
      const launch = f.inputs[provider].find((input) => input.id === executor.id)!;
      expect(launch).toMatchObject({
        cwd: f.project,
        projectPath: f.project,
        kind: "execute",
        title: "Attach an image when creating a task",
      });
      expect(launch.prompt).toBe("Attach an image when creating a task");
      // Only classification gets a board capability; the task knows nothing about the board.
      const capabilities = await readdir(join(service.store.directory, "capabilities"));
      expect(capabilities.some((name) => name.startsWith(executor.id))).toBe(false);
      let board = await f.finish(executor);
      expect(stage(board, id)).toBe("ready");
      expect(runOf(board, executor.id)?.status).toBe("completed");

      board = await service.action(f.project, {
        action: "rework",
        cardIds: [id],
        comment: "Also support clipboard images",
        clientActionId: randomUUID(),
      });
      expect(stage(board, id)).toBe("working");
      const rework = await f.running("execute", id, service);
      expect(rework.id).not.toBe(executor.id);
      expect(rework.threadId).toBe(executor.threadId);
      expect(f.prompts.get(rework.id)).toBe("Also support clipboard images");
      expect(f.launches[provider]).not.toContain(rework.id);
    },
  );
  it("starts a task with the settings chosen in the application that received it", async () => {
    const f = await fixture();
    const settings = { collaborationMode: "plan", model: "opus", reasoningEffort: "high" } as const;
    const request = { description: "Plan the board", clientCreationId: randomUUID(), settings };
    const created = await f.services.claude.createCard(f.project, request);
    const id = created.cards[0]!.id;
    // A retry with the same settings is the same task; other settings are another request.
    expect((await f.services.claude.createCard(f.project, request)).cards).toHaveLength(1);
    await expect(
      f.services.claude.createCard(f.project, {
        ...request,
        settings: { ...settings, model: "sonnet" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.services.claude.createCard(f.project, {
        description: "Broken",
        clientCreationId: randomUUID(),
        settings: { collaborationMode: "fast" } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const classifier = await f.running("classify", id, f.services.claude);
    expect(f.inputs.claude.find((input) => input.id === classifier.id)?.settings).toBeUndefined();
    await f.command(classifier, "report", { title: "Plan", category: "Board" });
    await f.services.claude.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", id, f.services.claude);
    expect(f.inputs.claude.find((input) => input.id === executor.id)?.settings).toEqual(settings);
    // The other application's models differ: its session uses its own defaults.
    await f.services.claude.notifyThread(executor.threadId!, "needsAttention");
    await f.services.codex.action(f.project, {
      action: "restart",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const restarted = await f.running("execute", id, f.services.codex);
    expect(f.inputs.codex.find((input) => input.id === restarted.id)?.settings).toBeUndefined();
  });
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
        })
      )?.ok,
    ).toBe(true);
    expect((await f.services.claude.read(f.project)).cards[0]).toMatchObject({
      title: "Layout",
      classification: "ready",
    });
    // A category reported by its id is that category, not a new one named after the id.
    const { categories } = await f.services.codex.read(f.project);
    const second = await f.services.codex.createCard(f.project, {
      description: "Fix spacing",
      clientCreationId: randomUUID(),
    });
    const secondId = second.cards.find((card) => card.description === "Fix spacing")!.id;
    await f.command(await f.running("classify", secondId), "report", {
      title: "Spacing",
      category: categories[0]!.id,
    });
    const after = await f.services.codex.read(f.project);
    expect(after.categories).toEqual(categories);
    expect(after.cards.find((card) => card.id === secondId)?.categoryId).toBe(categories[0]!.id);
  });
  it.each(["codex", "claude"] as const)(
    "persists images outside board JSON and delivers them once, when %s starts the session",
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
      await f.command(classify, "report", { title: "Screenshot", category: "UI" });
      await service.action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      });
      const execute = await f.running("execute", id, service);
      expect(f.inputs[provider].find((input) => input.id === execute.id)?.images).toEqual([
        image.url,
      ]);
      await f.finish(execute);
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
      // The session already has the task's pictures; a rework sends only its own.
      expect(f.resumedInputs[0]?.images).toBeUndefined();
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
  it("sends several tasks to one session and moves them together", async () => {
    const f = await fixture();
    const first = await f.card("Add a login form");
    const second = await f.card("Validate the email field");
    const other = await f.card("Unrelated task");
    let board = await f.services.claude.action(f.project, {
      action: "execute",
      cardIds: [first, second],
      clientActionId: randomUUID(),
    });
    expect([stage(board, first), stage(board, second), stage(board, other)]).toEqual([
      "working",
      "working",
      "todo",
    ]);
    // The tasks keep their order at the top of the column.
    expect(board.cards.slice(0, 2).map((card) => card.id)).toEqual([first, second]);
    const run = await f.running("execute", first, f.services.claude);
    expect(run.cardIds).toEqual([first, second]);
    expect(f.inputs.claude).toHaveLength(1);
    expect(f.inputs.claude[0]).toMatchObject({
      title: "Add a login form; Validate the email field",
      prompt: "## Задача 1\n\nAdd a login form\n\n## Задача 2\n\nValidate the email field",
    });
    // A task already in a session cannot be started again in another one.
    await expect(
      f.services.claude.action(f.project, {
        action: "execute",
        cardIds: [other, second],
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "already_running" });
    board = await f.finish(run);
    expect([stage(board, first), stage(board, second)]).toEqual(["ready", "ready"]);

    // A comment on one task continues the shared session and takes both tasks back to work.
    board = await f.services.claude.action(f.project, {
      action: "rework",
      cardIds: [second],
      comment: "Show the error under the field",
      clientActionId: randomUUID(),
    });
    expect([stage(board, first), stage(board, second)]).toEqual(["working", "working"]);
    const rework = await until(
      () => f.running("execute", first, f.services.claude),
      (value) => value.id !== run.id,
    );
    expect(rework).toMatchObject({ cardIds: [first, second], threadId: run.threadId });
    await expect(
      f.services.claude.action(f.project, {
        action: "rework",
        cardIds: [first],
        comment: "Also trim spaces",
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "already_running" });
    await f.finish(rework);

    // Publishing both sends the session one request.
    board = await f.services.claude.action(f.project, {
      action: "publish",
      cardIds: [first, second],
      clientActionId: randomUUID(),
    });
    const publications = board.runs.filter((item) => item.kind === "publish");
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({ cardIds: [first, second] });
    const publish = await f.running("publish", second, f.services.claude);
    board = await f.finish(publish);
    expect([stage(board, first), stage(board, second)]).toEqual(["done", "done"]);

    // Starting again sends both original texts to a new session.
    await f.services.claude.updateCard(f.project, first, { stageId: board.stages[0]!.id });
    await f.services.claude.action(f.project, {
      action: "restart",
      cardIds: [first],
      clientActionId: randomUUID(),
    });
    const restart = await until(
      () => f.running("execute", second, f.services.claude),
      (value) => value.id !== rework.id,
    );
    expect(restart.cardIds).toEqual([first, second]);
    expect(restart.threadId).not.toBe(run.threadId);
    expect(f.prompts.get(restart.id)).toContain("## Задача 2\n\nValidate the email field");
  });
  it("moves the card by its session: working, waiting for an answer, ready", async () => {
    const f = await fixture();
    const id = await f.card("Pick a database");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const run = await f.running("execute", id);
    const notify = async (state: string) => {
      await f.services.codex.notifyThread(run.threadId!, state);
      return f.services.codex.read(f.project);
    };
    let board = await notify("needsAttention");
    expect(stage(board, id)).toBe("waiting");
    expect(runOf(board, run.id)?.status).toBe("waiting");
    board = await notify("running");
    expect(stage(board, id)).toBe("working");
    // A question asked in plain text is recognised by the fast check of the last reply.
    f.questions.set(run.threadId!, "Which database should I use?");
    board = await notify("completed");
    expect(stage(board, id)).toBe("waiting");
    expect(board.cards[0]).toMatchObject({ question: "Which database should I use?", error: null });
    // The operator answers in the session itself.
    board = await notify("running");
    expect(stage(board, id)).toBe("working");
    expect(board.cards[0]!.question).toBeNull();
    f.questions.set(run.threadId!, null);
    board = await notify("completed");
    expect(stage(board, id)).toBe("ready");
    expect(runOf(board, run.id)?.status).toBe("completed");

    await f.services.claude.action(f.project, {
      action: "rework",
      cardIds: [id],
      comment: "Use SQLite",
      clientActionId: randomUUID(),
    });
    const rework = await f.running("execute", id);
    // The rework continues the Codex session, so CodexNest sends it.
    expect(rework.provider).toBe("codex");
    await f.services.codex.notifyThread(rework.threadId!, "running");
    await f.services.codex.notifyThread(rework.threadId!, "interrupted");
    board = await f.services.codex.read(f.project);
    expect(stage(board, id)).toBe("waiting");
    expect(board.cards[0]!.error).toContain("stopped");
  });
  it("returns a finished task to work when the operator writes to its session", async () => {
    const f = await fixture();
    const id = await f.card("Draw the price formula");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const run = await f.running("execute", id);
    await f.finish(run);
    const thread = run.threadId!;
    await f.services.codex.notifyThread(thread, "running");
    let board = await f.services.codex.read(f.project);
    expect(stage(board, id)).toBe("working");
    const continued = board.runs.at(-1)!;
    expect(continued).toMatchObject({ kind: "execute", status: "running", threadId: thread });
    expect(f.resumes.codex).toEqual([]);
    await f.services.codex.notifyThread(thread, "completed");
    board = await f.services.codex.read(f.project);
    expect(stage(board, id)).toBe("ready");
    expect(runOf(board, continued.id)?.status).toBe("completed");

    // After a publication the next turn is new work, not another publication.
    await f.services.codex.action(f.project, {
      action: "publish",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    board = await f.finish(await f.running("publish", id));
    expect(stage(board, id)).toBe("done");
    // The application restarted meanwhile.
    await f.services.codex.close();
    const restarted = new KanbanService({
      provider: "codex",
      dataDir: join(f.directory, "shared"),
      adapter: {
        launch: async () => {
          throw new Error("Nothing to launch");
        },
        resume: async () => undefined,
        awaitsAnswer: async () => null,
      },
    });
    await restarted.initialize();
    cleanups.push(() => restarted.close());
    await restarted.notifyThread(thread, "running");
    board = await restarted.read(f.project);
    expect(stage(board, id)).toBe("working");
    expect(board.runs.at(-1)).toMatchObject({ kind: "execute", status: "running" });
    await restarted.notifyThread(thread, "completed");
    board = await restarted.read(f.project);
    expect(stage(board, id)).toBe("ready");
  });
  it("does not take a continued session's previous outcome for the new turn", async () => {
    const f = await fixture();
    const id = await f.card("Continue");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const run = await f.running("execute", id);
    await f.finish(run);
    await f.services.codex.action(f.project, {
      action: "rework",
      cardIds: [id],
      comment: "More",
      clientActionId: randomUUID(),
    });
    const rework = await f.running("execute", id);
    // Until the new turn starts the session still reports the previous one.
    await f.services.codex.notifyThread(rework.threadId!, "completed");
    let board = await f.services.codex.read(f.project);
    expect(stage(board, id)).toBe("working");
    expect(runOf(board, rework.id)?.status).toBe("running");
    board = await f.finish(rework);
    expect(stage(board, id)).toBe("ready");
  });
  it("follows a session started in the project as one task in progress", async () => {
    const f = await fixture();
    const request = { description: "Fix the login form", clientCreationId: randomUUID() };
    let board = await f.services.codex.createCard(f.project, { ...request, threadId: "own-1" });
    const id = board.cards[0]!.id;
    expect(board.cards[0]).toMatchObject({
      title: "Fix the login form",
      classification: "pending",
    });
    expect(stage(board, id)).toBe("working");
    const run = board.runs.find((item) => item.kind === "execute")!;
    expect(run).toMatchObject({
      provider: "codex",
      cardIds: [id],
      threadId: "own-1",
      sessionUrl: "/threads/own-1",
      status: "running",
    });
    // Retried creation does not add the session twice.
    board = await f.services.codex.createCard(f.project, { ...request, threadId: "own-1" });
    expect(board.cards).toHaveLength(1);
    // The classifier names the task, but a task with its session is never split.
    const classifier = await f.running("classify", id);
    expect(
      (
        await f.command(classifier, "report", {
          tasks: [
            { title: "Login form", category: "Auth", text: "Fix the login" },
            { title: "Other", category: "UI", text: "form" },
          ],
        })
      )?.ok,
    ).toBe(true);
    board = await f.services.codex.read(f.project);
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0]).toMatchObject({ title: "Login form", classification: "ready" });
    // The session before its first message is not a finished task.
    await f.services.codex.notifyThread("own-1", "idle");
    board = await f.services.codex.read(f.project);
    expect(stage(board, id)).toBe("working");
    board = await f.finish(run);
    expect(stage(board, id)).toBe("ready");
    expect(f.launches.codex).not.toContain(run.id);
  });
  it("reads a recorded first message from the session, then classifies it", async () => {
    const f = await fixture();
    let board = await f.services.claude.createCard(f.project, {
      description: "",
      clientCreationId: randomUUID(),
      threadId: "spoken-1",
    });
    const id = board.cards[0]!.id;
    expect(board.cards[0]).toMatchObject({ title: "", classification: "pending" });
    expect(board.runs.map((run) => run.kind)).toEqual(["execute"]);
    // Speech recognition is not done yet: the session has no text.
    await f.services.claude.notifyThread("spoken-1", "queued");
    board = await f.services.claude.read(f.project);
    expect(board.cards[0]!.description).toBe("");
    f.requests.set("spoken-1", "Speed up the price table");
    await f.services.claude.notifyThread("spoken-1", "running");
    board = await f.services.claude.read(f.project);
    expect(board.cards[0]).toMatchObject({
      title: "Speed up the price table",
      description: "Speed up the price table",
    });
    expect(stage(board, id)).toBe("working");
    await f.running("classify", id, f.services.claude);
  });
  it("publishes a task whose agent reports its work pushed, unless it asks something", async () => {
    const f = await fixture();
    const id = await f.card("Pushed");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const run = await f.running("execute", id);
    f.pushed.add(run.threadId!);
    let board = await f.finish(run, "Checks failed; should I retry?");
    expect(stage(board, id)).toBe("waiting");
    board = await f.finish(run);
    expect(stage(board, id)).toBe("done");
    expect(runOf(board, run.id)?.status).toBe("completed");
    expect(board.cards[0]!.doneAt).toEqual(expect.any(Number));
  });
  it("keeps the card working when a new turn starts while the last reply is checked", async () => {
    const f = await fixture();
    const id = await f.card("Race");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const run = await f.running("execute", id);
    let release!: (verdict: ReplyVerdict | null) => void;
    f.questions.clear();
    const service = f.services.codex as unknown as {
      options: { adapter: { readReply: (id: string) => Promise<ReplyVerdict | null> } };
    };
    service.options.adapter.readReply = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    await f.services.codex.notifyThread(run.threadId!, "running");
    const checking = f.services.codex.notifyThread(run.threadId!, "completed");
    await until(
      async () => release,
      (value) => Boolean(value),
    );
    await f.services.codex.notifyThread(run.threadId!, "running");
    release({ question: "Old question", published: false });
    await checking;
    const board = await f.services.codex.read(f.project);
    expect(stage(board, id)).toBe("working");
    expect(runOf(board, run.id)?.status).toBe("running");
    expect(board.cards[0]!.question).toBeNull();
  });
  it("waits for the operator when the last reply cannot be checked", async () => {
    const f = await fixture();
    const errors: unknown[] = [];
    await f.services.codex.close();
    const service = new KanbanService({
      provider: "codex",
      dataDir: f.services.codex.store.directory,
      onError: (error) => errors.push(error),
      adapter: {
        launch: async (job) => ({ threadId: job.id }),
        resume: async () => {},
        readReply: async () => {
          throw new Error("Model unavailable");
        },
      },
    });
    cleanups.push(() => service.close());
    await service.initialize();
    const id = await f.card("Check fails");
    await service.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const run = await f.running("execute", id, service);
    await service.notifyThread(run.threadId!, "completed");
    const board = await service.read(f.project);
    expect(stage(board, id)).toBe("waiting");
    expect(board.cards[0]!.error).toContain("open the session");
    expect(errors).toHaveLength(1);
  });
  it("publishes in each task's own session, one card at a time", async () => {
    const f = await fixture();
    const ids: string[] = [];
    const sessions = new Map<string, KanbanRun>();
    for (const [index, provider] of (["codex", "claude"] as const).entries()) {
      const id = await f.card(`Task ${index}`);
      await f.services[provider].action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      });
      const run = await f.running("execute", id, f.services[provider]);
      await f.finish(run);
      sessions.set(id, run);
      ids.push(id);
    }
    // A card that never ran has nothing to push.
    const idle = await f.card("Nothing done");
    await f.services.codex.updateCard(f.project, idle, { stageId: "ready" });
    let board = await f.services.claude.action(f.project, {
      action: "publish",
      cardIds: [...ids, idle],
      clientActionId: randomUUID(),
    });
    expect(stage(board, idle)).toBe("done");
    const publications = () =>
      f.services.codex
        .read(f.project)
        .then((board) => board.runs.filter((run) => run.kind === "publish"));
    const first = (
      await until(publications, (runs) => runs.some((run) => run.status === "running"))
    ).find((run) => run.status === "running")!;
    const firstCard = first.cardIds[0]!;
    const secondCard = ids.find((id) => id !== firstCard)!;
    expect(first.threadId).toBe(sessions.get(firstCard)!.threadId);
    expect(first.provider).toBe(sessions.get(firstCard)!.provider);
    expect(f.prompts.get(first.id)).toBe(PUBLISH_PROMPT);
    // The other publication waits: both push the same branch from the same folder.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await publications()).find((run) => run.cardIds.includes(secondCard))?.status).toBe(
      "queued",
    );
    await f.services[first.provider].notifyThread(first.threadId!, "running");
    board = await f.services.codex.read(f.project);
    expect(stage(board, firstCard)).toBe("ready");
    await f.services[first.provider].notifyThread(first.threadId!, "completed");
    board = await f.services.codex.read(f.project);
    expect(stage(board, firstCard)).toBe("done");
    expect(board.cards.find((card) => card.id === firstCard)!.doneAt).toEqual(expect.any(Number));

    const second = await f.running(
      "publish",
      secondCard,
      f.services[sessions.get(secondCard)!.provider],
    );
    expect(second.threadId).toBe(sessions.get(secondCard)!.threadId);
    board = await f.finish(second, "GitHub Actions failed: lint");
    expect(stage(board, secondCard)).toBe("waiting");
    expect(board.cards.find((card) => card.id === secondCard)!.question).toContain("lint");
  });
  it("starts a task again in the application that asks, with the original text", async () => {
    const f = await fixture();
    const id = await f.card("Draw a chart");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const first = await f.running("execute", id);
    // Another application cannot stop a working session.
    await expect(
      f.services.claude.action(f.project, {
        action: "restart",
        cardIds: [id],
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "already_running" });
    await f.services.codex.action(f.project, {
      action: "restart",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const second = await until(
      () => f.running("execute", id),
      (run) => run.id !== first.id,
    );
    expect(f.interrupted.codex).toEqual([first.threadId]);
    expect(second.threadId).not.toBe(first.threadId);
    expect(f.prompts.get(second.id)).toBe("Draw a chart");
    expect(runOf(await f.services.codex.read(f.project), first.id)?.status).toBe("completed");

    await f.services.codex.notifyThread(second.threadId!, "needsAttention");
    await f.services.claude.action(f.project, {
      action: "restart",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const third = await f.running("execute", id, f.services.claude);
    expect(third.provider).toBe("claude");
    expect(f.interrupted.claude).toEqual([]);
    const board = await f.services.claude.read(f.project);
    expect(runOf(board, second.id)?.status).toBe("completed");
    expect(stage(board, id)).toBe("working");
    await expect(
      f.services.claude.action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "already_running" });
  });
  it("keeps a working card in place and lets the operator move a waiting one on", async () => {
    const f = await fixture();
    const id = await f.card("Move me");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const run = await f.running("execute", id);
    await expect(
      f.services.codex.updateCard(f.project, id, { stageId: "ready" }),
    ).rejects.toMatchObject({ code: "already_running" });
    await f.finish(run, "Which file?");
    let board = await f.services.codex.updateCard(f.project, id, { stageId: "ready" });
    expect(stage(board, id)).toBe("ready");
    expect(runOf(board, run.id)?.status).toBe("completed");
    expect(board.cards[0]!.question).toBeNull();
    await expect(
      f.services.codex.action(f.project, {
        action: "rework",
        cardIds: [id],
        comment: "  ",
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    board = await f.services.codex.read(f.project);
    expect(stage(board, id)).toBe("ready");
  });
  it.each(["completed", "idle", "interrupted", "failed", "unavailable"])(
    "allows classification to be retried after a session ends with %s without reporting",
    async (state) => {
      const f = await fixture();
      const created = await f.services.codex.createCard(f.project, {
        description: "Classify this task",
        clientCreationId: randomUUID(),
      });
      const id = created.cards[0]!.id;
      const run = await f.running("classify", id);
      // Finish the dispatch before simulating a later terminal session notification.
      await f.services.codex.close();
      await f.services.codex.initialize();
      await f.services.codex.notifyThread(run.threadId!, state);
      const board = await f.services.codex.read(f.project);
      expect(board.cards[0]).toMatchObject({ classification: "failed" });
      expect(board.cards[0]?.error).toContain("retry classification");
      expect(board.runs.find((item) => item.id === run.id)?.status).toBe("failed");
      // The failed classifier stays out of the session list like a finished one.
      expect(f.archived.codex).toEqual([run.threadId]);
      await f.services.codex.action(f.project, {
        action: "retry-classification",
        cardIds: [id],
        clientActionId: randomUUID(),
      });
      const retry = await f.running("classify", id);
      expect(retry.id).not.toBe(run.id);
      expect((await f.command(retry, "report", { title: "Task", category: "Tasks" }))?.ok).toBe(
        true,
      );
      expect((await f.services.codex.read(f.project)).cards[0]).toMatchObject({
        classification: "ready",
        error: null,
      });
    },
  );
  it("does not mistake an idle newly created classifier for a completed turn", async () => {
    const f = await fixture();
    await f.services.codex.close();
    const service = new KanbanService({
      provider: "codex",
      dataDir: f.services.codex.store.directory,
      adapter: {
        launch: async (job) => ({ threadId: job.id }),
        resume: async () => {},
        threadState: () => "idle",
      },
    });
    cleanups.push(() => service.close());
    await service.initialize();
    const created = await service.createCard(f.project, {
      description: "Task",
      clientCreationId: randomUUID(),
    });
    await until(
      () => service.read(f.project),
      (board) => Boolean(board.runs[0]?.threadId),
    );
    await service.close();
    const board = await service.read(f.project);
    expect(board.cards[0]).toMatchObject({ classification: "pending", error: null });
    expect(board.runs[0]).toMatchObject({ status: "running", error: null });
    expect(created.cards[0]?.id).toBe(board.cards[0]?.id);
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
  it("does not scan idle boards continuously after watcher events settle", async () => {
    const f = await fixture();
    await f.services.codex.read(f.project);
    const calls = vi.spyOn(f.services.codex.store, "list");
    await new Promise((resolve) => setTimeout(resolve, 120));
    calls.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls).not.toHaveBeenCalled();
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
    const board = await service.read(f.project);
    const run = board.runs.find((run) => run.kind === "execute" && run.cardIds.includes(id));
    expect(run?.status).toBe("completed");
    expect(stage(board, id)).toBe("ready");
  });
  it.each(["codex", "claude"] as const)(
    "serves HTTP while %s startup recovery waits for a reply check",
    async (provider) => {
      const f = await fixture();
      const id = await f.card("Restore a finished task");
      await f.services[provider].action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      });
      const original = await f.running("execute", id, f.services[provider]);
      await f.services[provider].close();
      let release!: (verdict: ReplyVerdict) => void;
      const blocked = new Promise<ReplyVerdict>((resolve) => {
        release = resolve;
      });
      const readReply = vi.fn(() => blocked);
      const launch = vi.fn(async () => {
        throw new Error("Must not relaunch an existing session");
      });
      const restored = new KanbanService({
        provider,
        dataDir: f.services[provider].store.directory,
        adapter: { launch, resume: async () => {}, threadState: () => "completed", readReply },
      });
      const app = Fastify({ pluginTimeout: 1000 });
      app.addHook("onReady", () => restored.initialize());
      app.addHook("onClose", () => restored.close());
      app.get("/", async () => "app shell");
      app.get("/api/v1/health", async () => ({ status: "ok" }));
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        await until(
          async () => readReply.mock.calls.length,
          (calls) => calls > 0,
        );
        expect((await app.inject("/")).body).toBe("app shell");
        expect((await app.inject("/api/v1/health")).json()).toEqual({ status: "ok" });
        expect(runOf(await restored.read(f.project), original.id)?.status).toBe("running");
        release({ question: null, published: false });
        const board = await until(
          () => restored.read(f.project),
          (board) => runOf(board, original.id)?.status === "completed",
        );
        expect(stage(board, id)).toBe("ready");
        expect(readReply).toHaveBeenCalledExactlyOnceWith(original.threadId);
        expect(launch).not.toHaveBeenCalled();
      } finally {
        release({ question: null, published: false });
        await app.close();
      }
    },
  );
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
      const board = await until(
        () => restored.read(f.project),
        (board) => runOf(board, original.id)?.status === (state ? "completed" : "waiting"),
      );
      // A finished turn is checked once; a vanished session waits for the operator.
      expect(board.runs.find((run) => run.id === original.id)?.status).toBe(
        state ? "completed" : "waiting",
      );
      expect(stage(board, id)).toBe(state ? "ready" : "waiting");
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

  it("archives cards without a working agent, restores them and moves week-old published cards to the archive", async () => {
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
    await f.finish(executor, "Which colour?");
    // A task waiting for an answer can be archived; its question is dropped.
    let board = await f.services.codex.updateCard(f.project, id, { archived: true });
    expect(runOf(board, executor.id)?.status).toBe("completed");
    expect(board.cards[0]!.question).toBeNull();
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

  it("deletes only archived cards with this application's sessions", async () => {
    const f = await fixture();
    const id = await f.card("Delete me");
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", id);
    await f.finish(executor);
    await expect(f.services.codex.deleteCard(f.project, id)).rejects.toMatchObject({
      code: "not_archived",
    });
    await f.services.codex.updateCard(f.project, id, { archived: true });
    const board = await f.services.claude.deleteCard(f.project, id);
    expect(board.cards).toEqual([]);
    expect(board.runs.filter((run) => run.cardIds.includes(id))).toEqual([]);
    // Only the application that owns a session archives it.
    expect(f.archived.claude).not.toContain(executor.threadId);
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

  it("splits a task of several categories into cards with their own text and pictures", async () => {
    const f = await fixture();
    // Distinct bytes show which stored file each card ends up with.
    const picture = (name: string, mark: number) => ({
      name,
      url: `data:image/png;base64,${Buffer.concat([
        Buffer.from(png.url.split(",")[1]!, "base64"),
        Buffer.from([mark]),
      ]).toString("base64")}`,
    });
    const [first, second, third] = [picture("a.png", 1), picture("b.png", 2), picture("c.png", 3)];
    const settings = { collaborationMode: "default", model: "opus" } as const;
    let board = await f.services.claude.createCard(f.project, {
      description: "Fix the header. Speed up the API.",
      clientCreationId: randomUUID(),
      images: [first, second, third],
      settings,
    });
    const id = board.cards[0]!.id;
    const classifier = await f.running("classify", id, f.services.claude);
    const prompt = f.prompts.get(classifier.id)!;
    expect(prompt).toContain('"tasks"');
    expect(prompt).toContain("verbatim");
    expect(prompt).toContain("3 attached pictures");
    await expect(
      f.command(classifier, "report", {
        tasks: [
          { title: "Header", category: "UI", text: "Fix the header.", images: [4] },
          { title: "API", category: "Server", text: "Speed up the API." },
        ],
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(
      (
        await f.command(classifier, "report", {
          tasks: [
            { title: "Header", category: "UI", text: "Fix the header.", images: [2] },
            { title: "API", category: "Server", text: "Speed up the API.", images: [1] },
          ],
        })
      )?.ok,
    ).toBe(true);
    board = await f.services.codex.read(f.project);
    const category = (name: string) => board.categories.find((item) => item.name === name)?.id;
    // The new card sits under the original; the third picture, claimed by none, goes to both.
    expect(board.cards.map((card) => [card.title, card.description, card.categoryId])).toEqual([
      ["Header", "Fix the header.", category("UI")],
      ["API", "Speed up the API.", category("Server")],
    ]);
    expect(board.cards.every((card) => card.classification === "ready")).toBe(true);
    const split = board.cards[1]!.id;
    for (const [cardId, expected] of [
      [id, [second, third]],
      [split, [first, third]],
    ] as const) {
      const card = board.cards.find((item) => item.id === cardId)!;
      expect(card.images?.map((image) => image.name)).toEqual(expected.map((image) => image.name));
      for (const [index, image] of expected.entries())
        expect(await f.services.codex.readImage(f.project, cardId, index)).toEqual(image);
    }
    await expect(f.services.codex.readImage(f.project, id, 2)).rejects.toThrow();
    // The split task starts with its pictures and the settings chosen with the original.
    await f.services.claude.action(f.project, {
      action: "execute",
      cardIds: [split],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", split, f.services.claude);
    const input = f.inputs.claude.find((item) => item.id === executor.id)!;
    expect(input.prompt).toBe("Speed up the API.");
    expect(input.images).toEqual([first.url, third.url]);
    expect(input.settings).toEqual(settings);
  });

  it("keeps the operator's text whole when it changed during classification or is one task", async () => {
    const f = await fixture();
    let board = await f.services.codex.createCard(f.project, {
      description: "Fix the header.",
      clientCreationId: randomUUID(),
    });
    const id = board.cards[0]!.id;
    let classifier = await f.running("classify", id);
    await f.services.codex.updateCard(f.project, id, {
      description: "Fix the header. Speed up the API.",
    });
    const tasks = [
      { title: "Header", category: "UI", text: "Fix the header." },
      { title: "API", category: "Server", text: "Speed up the API." },
    ];
    expect((await f.command(classifier, "report", { tasks }))?.ok).toBe(true);
    board = await f.services.codex.read(f.project);
    expect(board.cards.map((card) => [card.title, card.description])).toEqual([
      ["Header", "Fix the header. Speed up the API."],
    ]);
    board = await f.services.codex.createCard(f.project, {
      description: "Fix the header, please.",
      clientCreationId: randomUUID(),
    });
    const other = board.cards[0]!.id;
    classifier = await f.running("classify", other);
    expect((await f.command(classifier, "report", { tasks: tasks.slice(0, 1) }))?.ok).toBe(true);
    board = await f.services.codex.read(f.project);
    expect(board.cards.map((card) => [card.title, card.description])).toEqual([
      ["Header", "Fix the header, please."],
      ["Header", "Fix the header. Speed up the API."],
    ]);
  });

  it("keeps new tasks unclassified, with their text as the title, when classification is off", async () => {
    let classifies = false;
    const f = await fixture(
      undefined,
      async () => "Spoken details",
      () => classifies,
    );
    let board = await f.services.codex.createCard(f.project, {
      description: "Fix the  login\nform on Safari",
      clientCreationId: randomUUID(),
    });
    const typed = board.cards[0]!.id;
    expect(board.cards[0]).toMatchObject({
      title: "Fix the login form on Safari",
      categoryId: null,
      classification: "ready",
    });
    board = await f.services.codex.createCard(f.project, {
      description: "Typed start",
      clientCreationId: randomUUID(),
      audio: recording("voice"),
    });
    const spoken = board.cards[0]!.id;
    board = await until(
      () => f.services.codex.read(f.project),
      (value) => value.cards.find((card) => card.id === spoken)?.classification === "ready",
    );
    expect(board.cards.find((card) => card.id === spoken)?.title).toBe(
      "Typed start Spoken details",
    );
    expect(board.runs.filter((run) => run.kind === "classify")).toEqual([]);
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [typed],
      clientActionId: randomUUID(),
    });
    await f.running("execute", typed);

    // Turned on again, the next task is classified.
    classifies = true;
    board = await f.services.codex.createCard(f.project, {
      description: "Another task",
      clientCreationId: randomUUID(),
    });
    expect(board.cards[0]!.classification).toBe("pending");
    await f.running("classify", board.cards[0]!.id);
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
    await f.finish(executor);
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
    expect(f.prompts.get(resumed.id)).toBe("Keep the header\n\nAlso handle the empty state");
    expect(f.resumedInputs.at(-1)?.images).toHaveLength(1);
  });

  it("adds text, pictures and a recording to a task no agent has taken yet", async () => {
    const transcribe = vi.fn(async () => "Spoken addition");
    const f = await fixture(undefined, transcribe);
    const id = await f.card("Fix the list");
    let board = await f.services.codex.action(f.project, {
      action: "append",
      cardIds: [id],
      comment: "  Also on the phone  ",
      images: [png],
      clientActionId: randomUUID(),
    });
    expect(board.cards[0]).toMatchObject({
      title: "Fix the list",
      description: "Fix the list\n\nAlso on the phone",
    });
    expect(board.cards[0]!.images?.map((image) => image.name)).toEqual(["shot.png"]);
    expect(stage(board, id)).toBe("todo");
    expect(board.runs.filter((run) => run.kind !== "classify")).toEqual([]);

    // A recording joins the task once the app that received it has transcribed it.
    board = await f.services.claude.action(f.project, {
      action: "append",
      cardIds: [id],
      comment: "Typed with the recording",
      images: [{ ...png, name: "second.png" }],
      audio: recording("addition"),
      clientActionId: randomUUID(),
    });
    expect(board.cards[0]!.voice).toMatchObject({ purpose: "append", provider: "claude" });
    await expect(
      f.services.codex.action(f.project, {
        action: "execute",
        cardIds: [id],
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "voice_pending" });
    board = await until(
      () => f.services.codex.read(f.project),
      (current) => !current.cards[0]?.voice,
    );
    expect(board.cards[0]!.description).toBe(
      "Fix the list\n\nAlso on the phone\n\nTyped with the recording\n\nSpoken addition",
    );
    expect(board.cards[0]!.images?.map((image) => image.name)).toEqual(["shot.png", "second.png"]);
    expect((await f.services.codex.readImage(f.project, id, 1)).name).toBe("second.png");
    await expect(
      f.services.codex.action(f.project, {
        action: "append",
        cardIds: [id],
        images: Array.from({ length: 9 }, () => png),
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "too_many_images" });

    // Pictures sent with a silent recording are still added.
    transcribe.mockResolvedValueOnce("");
    await f.services.codex.action(f.project, {
      action: "append",
      cardIds: [id],
      images: [{ ...png, name: "third.png" }],
      audio: recording("silence"),
      clientActionId: randomUUID(),
    });
    board = await until(
      () => f.services.codex.read(f.project),
      (current) => !current.cards[0]?.voice,
    );
    expect(board.cards[0]!.images).toHaveLength(3);
    expect(board.cards[0]!.description).toMatch(/Spoken addition$/);

    // The agent gets everything with the task; afterwards additions go to its session.
    await f.services.codex.action(f.project, {
      action: "execute",
      cardIds: [id],
      clientActionId: randomUUID(),
    });
    const executor = await f.running("execute", id);
    expect(f.prompts.get(executor.id)).toContain("Spoken addition");
    expect(f.inputs.codex.at(-1)?.images).toHaveLength(3);
    await expect(
      f.services.codex.action(f.project, {
        action: "append",
        cardIds: [id],
        comment: "Too late",
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "already_running" });
    await f.finish(executor);
    await expect(
      f.services.codex.action(f.project, {
        action: "append",
        cardIds: [id],
        comment: "Too late",
        clientActionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "already_started" });
  });
});
