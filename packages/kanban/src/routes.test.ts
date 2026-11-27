import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_ARCHITECT_ID,
  type KanbanBoard,
  type WorkerCatalogue,
  type WorkerProfile,
} from "@codexnest/protocol";
import { registerKanbanRoutes } from "./routes.js";
import type { KanbanService } from "./service.js";
import { KanbanError } from "./store.js";
import { registerWorkerRoutes } from "./worker-routes.js";
import { WorkerStore } from "./workers.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});
function fixture() {
  const board: KanbanBoard = {
    id: "board",
    projectPath: "/shared/project",
    revision: 3,
    stages: [],
    categories: [],
    cards: [],
    createdAt: 1,
    updatedAt: 2,
    runs: ["codex", "claude"].map((provider) => ({
      id: provider,
      kind: "execute",
      cardIds: [],
      provider,
      threadId: provider,
      sessionUrl: `/threads/${provider}`,
      status: "running",
      error: null,
      createdAt: 1,
      updatedAt: 1,
    })) as KanbanBoard["runs"],
  };
  const service = {
    workers: {
      list: vi.fn(async () => []),
      projectKey: vi.fn(async () => "canonical-project"),
      listForProjects: vi.fn(async () => [
        { id: "architect", projectKey: null },
        { id: "lead", projectKey: "canonical-project" },
      ]),
    },
    wake: vi.fn(),
    read: vi.fn(async () => board),
    createCard: vi.fn(async () => board),
    readImage: vi.fn(async () => ({ name: "shot.png", url: "data:image/png;base64,aW1hZ2U=" })),
    createStage: vi.fn(async () => board),
    updateStage: vi.fn(async () => board),
    deleteStage: vi.fn(async () => board),
    deleteCard: vi.fn(async () => board),
    action: vi.fn(async () => board),
  };
  const app = Fastify();
  apps.push(app);
  registerKanbanRoutes(
    app,
    service as unknown as KanbanService,
    (id) => {
      if (id !== "local-project-id") throw new KanbanError("not_found", "Project not found", 404);
      return "/shared/project";
    },
    "codex",
  );
  return { app, service };
}
describe("shared board HTTP routes", () => {
  it("returns the Architect and the requested local projects in one read", async () => {
    const { app, service } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workers/catalog",
      payload: { projectIds: ["local-project-id"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      common: [{ id: "architect", projectKey: null }],
      projects: [
        {
          projectId: "local-project-id",
          workers: [{ id: "lead", projectKey: "canonical-project" }],
        },
      ],
    });
    expect(service.workers.listForProjects).toHaveBeenCalledOnce();
    expect(service.read).not.toHaveBeenCalled();
  });

  it("moves legacy project workers by final index and keeps the order after reopening", async ({
    onTestFinished,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "kanban-worker-order-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const otherDirectory = join(directory, "other");
    const workers = new WorkerStore(join(directory, "workers"));
    await Promise.all([mkdir(otherDirectory), mkdir(workers.directory)]);
    const [projectKey, otherKey] = await Promise.all([
      workers.projectKey(directory),
      workers.projectKey(otherDirectory),
    ]);
    const fields = { role: "Review changes", instructions: "Check results", settings: {} };
    const profile = (name: string, projectKey: string | null): WorkerProfile => ({
      ...fields,
      name,
      projectKey,
      id: randomUUID(),
      revision: 1,
    });
    const lead = profile("Lead", projectKey);
    const backend = profile("Backend", projectKey);
    const frontend = profile("Frontend", projectKey);
    const qa = profile("QA", projectKey);
    const otherLead = profile("Other lead", otherKey);
    const otherBackend = profile("Other backend", otherKey);
    const architect = { ...profile("Architect", null), id: WORKER_ARCHITECT_ID };
    const retired = profile("Legacy common worker", null);
    const memory = [{ id: randomUUID(), kind: "notes", projectKey, text: "Run tests" }];
    const registry = join(workers.directory, "workers.json");
    const legacy = Object.fromEntries(
      [lead, otherLead, backend, retired, architect, otherBackend, frontend, qa].map((worker) => [
        worker.id,
        { profile: worker, memory: worker === backend ? memory : [] },
      ]),
    );
    const original = JSON.stringify(legacy, null, 2);
    await writeFile(registry, original);

    const appFor = (store: WorkerStore) => {
      const app = Fastify();
      apps.push(app);
      registerWorkerRoutes(
        app,
        store,
        (id) => {
          if (id === "project") return directory;
          if (id === "other") return otherDirectory;
          throw new KanbanError("not_found", "Project not found", 404);
        },
        "codex",
        vi.fn(),
      );
      return app;
    };
    const app = appFor(workers);
    const move = (
      workerId: unknown,
      targetIndex: unknown,
      query: Record<string, string> = { projectId: "project" },
    ) =>
      app.inject({
        method: "PATCH",
        url: "/api/v1/workers/order",
        query,
        payload: { workerId, targetIndex },
      });

    for (const id of [otherLead.id, retired.id, WORKER_ARCHITECT_ID, randomUUID()]) {
      const response = await move(id, 0);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "worker_not_found" } });
    }
    for (const [response, code] of [
      [await move(lead.id, 0, {}), "worker_project_required"],
      [await move(123, 0), "invalid_worker"],
    ] as const) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code } });
    }
    for (const targetIndex of [undefined, null, true, "1", -1, 1.5, 4]) {
      const response = await move(lead.id, targetIndex);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "validation_failed" } });
    }
    for (const response of [await move(lead.id, 0), await move(qa.id, 3)]) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toStrictEqual([lead, backend, frontend, qa]);
    }
    expect(await readFile(registry, "utf8")).toBe(original);

    const down = await move(lead.id, 3);
    expect(down.statusCode).toBe(200);
    expect(down.json()).toStrictEqual([backend, frontend, qa, lead]);
    const up = await move(qa.id, 0);
    expect(up.statusCode).toBe(200);
    expect(up.json()).toStrictEqual([qa, backend, frontend, lead]);
    const persisted = JSON.parse(await readFile(registry, "utf8")) as typeof legacy;
    expect(persisted).toStrictEqual(legacy);
    expect(Object.keys(persisted)).toStrictEqual(
      [qa, otherLead, backend, retired, architect, otherBackend, frontend, lead].map(
        ({ id }) => id,
      ),
    );

    const restarted = new WorkerStore(workers.directory);
    const proposal = await restarted.propose({
      ...fields,
      name: "Testing",
      projectId: "project",
      projectKey,
      provider: "codex",
      settings: { collaborationMode: "default" },
    });
    const added = await restarted.approveProposal(proposal);
    const expected = [qa, backend, frontend, lead, added];
    const reopened = appFor(restarted);
    const list = await reopened.inject("/api/v1/workers?projectId=project");
    expect(list.statusCode).toBe(200);
    expect(list.json<WorkerProfile[]>()).toStrictEqual([architect, ...expected]);
    const catalogue = await reopened.inject({
      method: "POST",
      url: "/api/v1/workers/catalog",
      payload: { projectIds: ["project", "other"] },
    });
    expect(catalogue.statusCode).toBe(200);
    expect(catalogue.json<WorkerCatalogue>()).toStrictEqual({
      common: [architect],
      projects: [
        { projectId: "project", workers: expected },
        { projectId: "other", workers: [otherLead, otherBackend] },
      ],
    });
  });

  it.for([true, false, undefined])(
    "returns a plain proposal role and preserves coordinates %s through approval and catalogue",
    async (coordinates, { onTestFinished }) => {
      const directory = await mkdtemp(join(tmpdir(), "kanban-worker-routes-"));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const workers = new WorkerStore(join(directory, "workers"));
      const app = Fastify();
      apps.push(app);
      registerWorkerRoutes(app, workers, () => directory, "codex", vi.fn());

      const proposal = await workers.propose({
        provider: "codex",
        projectId: "project",
        projectKey: await workers.projectKey(directory),
        name: "Lead",
        role: "Review changes",
        instructions: "Check results",
        settings: { collaborationMode: "default" },
        ...(coordinates === undefined ? {} : { coordinates }),
      });
      const url = `/api/v1/workers/proposals/${proposal.id}`;
      const preview = await app.inject(url);
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toStrictEqual(proposal);

      const approve = () => app.inject({ method: "POST", url: `${url}/approve` });
      const profile = {
        id: proposal.id,
        projectKey: proposal.projectKey,
        name: proposal.name,
        role: proposal.role,
        instructions: proposal.instructions,
        settings: { codex: proposal.settings },
        revision: 1,
        ...(coordinates === undefined ? {} : { coordinates }),
      };
      for (const approval of await Promise.all([approve(), approve()])) {
        expect(approval.statusCode).toBe(200);
        expect(approval.json()).toStrictEqual(profile);
      }

      const catalogue = await app.inject({
        method: "POST",
        url: "/api/v1/workers/catalog",
        payload: { projectIds: ["project"] },
      });
      expect(catalogue.statusCode).toBe(200);
      expect(catalogue.json<WorkerCatalogue>().projects).toStrictEqual([
        { projectId: "project", workers: [profile] },
      ]);
    },
  );

  it("lists the global catalogue without reading the board", async () => {
    const { app, service } = fixture();
    const response = await app.inject({ method: "GET", url: "/api/v1/workers" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(service.workers.list).toHaveBeenCalledWith(null);
    expect(service.read).not.toHaveBeenCalled();
  });

  it("routes stage edits, stage removal and archived task deletion to the shared board", async () => {
    const { app, service } = fixture();
    const base = "/api/v1/projects/local-project-id/kanban";
    const patch = { name: "Deploy", beforeStageId: null };
    expect(
      (await app.inject({ method: "PATCH", url: `${base}/stages/stage`, payload: patch }))
        .statusCode,
    ).toBe(200);
    expect(service.updateStage).toHaveBeenCalledWith("/shared/project", "stage", patch);
    expect((await app.inject({ method: "DELETE", url: `${base}/stages/stage` })).statusCode).toBe(
      200,
    );
    expect(service.deleteStage).toHaveBeenCalledWith("/shared/project", "stage");
    expect((await app.inject({ method: "DELETE", url: `${base}/cards/card` })).statusCode).toBe(
      200,
    );
    expect(service.deleteCard).toHaveBeenCalledWith("/shared/project", "card");
  });

  it("resolves local IDs and sibling session links without baking localhost into persisted state", async () => {
    const { app, service } = fixture();
    const response = await app.inject({
      url: "/api/v1/projects/local-project-id/kanban",
      headers: { host: "nest.private:4310" },
    });
    expect(response.statusCode).toBe(200);
    expect(service.read).toHaveBeenCalledWith("/shared/project");
    expect(response.json().runs.map((run: { sessionUrl: string }) => run.sessionUrl)).toEqual([
      "/threads/codex",
      "http://nest.private:4311/threads/claude",
    ]);
    expect((await service.read()).runs[1]!.sessionUrl).toBe("/threads/claude");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("accepts image payloads above Fastify's default limit and reads images by project and card", async () => {
    const { app, service } = fixture();
    const image = { name: "shot.png", url: `data:image/png;base64,${"A".repeat(1_100_000)}` };
    const payload = { description: "Match image", clientCreationId: "creation", image };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/local-project-id/kanban/cards",
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(service.createCard).toHaveBeenCalledWith("/shared/project", payload);
    const result = await app.inject("/api/v1/projects/local-project-id/kanban/cards/card/image");
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(service.readImage).toHaveBeenCalledWith("/shared/project", "card", 0);
    service.readImage.mockRejectedValueOnce(
      new KanbanError("not_found", "Task image not found", 404),
    );
    expect(
      (await app.inject("/api/v1/projects/local-project-id/kanban/cards/missing/image")).statusCode,
    ).toBe(404);
    expect((await app.inject("/api/v1/projects/missing/kanban/cards/card/image")).statusCode).toBe(
      404,
    );
  });
  it("supports configured sibling URLs and reports actionable service errors", async () => {
    vi.stubEnv("KANBAN_CLAUDE_URL", "https://claude.private");
    const { app, service } = fixture();
    const response = await app.inject("/api/v1/projects/local-project-id/kanban");
    expect(response.json().runs[1].sessionUrl).toBe("https://claude.private/threads/claude");
    service.action.mockRejectedValueOnce(
      new KanbanError("already_running", "Task already running", 409),
    );
    const failure = await app.inject({
      method: "POST",
      url: "/api/v1/projects/local-project-id/kanban/actions",
      payload: { action: "execute", cardIds: ["one"], clientActionId: "stable" },
    });
    expect(failure.statusCode).toBe(409);
    expect(failure.json().error.message).toBe("Task already running");
    expect((await app.inject("/api/v1/projects/missing/kanban")).statusCode).toBe(404);
  });
});
