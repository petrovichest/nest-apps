import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KanbanBoard } from "@codexnest/protocol";
import { registerKanbanRoutes } from "./routes.js";
import type { KanbanService } from "./service.js";
import { KanbanError } from "./store.js";

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
