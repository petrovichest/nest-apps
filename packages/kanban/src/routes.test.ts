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
      workspacePath: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
    })) as KanbanBoard["runs"],
  };
  const service = {
    wake: vi.fn(),
    read: vi.fn(async () => board),
    createStage: vi.fn(async () => board),
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
