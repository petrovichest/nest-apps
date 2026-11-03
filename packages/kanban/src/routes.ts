import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KanbanBoard, KanbanProvider } from "@codexnest/protocol";
import type { KanbanService } from "./service.js";
import { KanbanError } from "./store.js";

/** Both applications resolve their own project IDs to the same canonical board path. */
export function registerKanbanRoutes(
  app: FastifyInstance,
  service: KanbanService,
  projectPath: (id: string) => string,
  provider: KanbanProvider,
): void {
  const root = "/api/v1/projects/:id/kanban";
  const links = (board: KanbanBoard, request: FastifyRequest): KanbanBoard => ({
    ...board,
    runs: board.runs.map((run) => {
      if (!run.sessionUrl || run.provider === provider || !run.sessionUrl.startsWith("/"))
        return run;
      const configured =
        process.env[run.provider === "codex" ? "KANBAN_CODEX_URL" : "KANBAN_CLAUDE_URL"];
      const base = new URL(configured ?? `${request.protocol}://${request.host}`);
      if (!configured) base.port = run.provider === "codex" ? "4310" : "4311";
      return { ...run, sessionUrl: new URL(run.sessionUrl, base).href };
    }),
  });
  const run = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: () => Promise<KanbanBoard>,
  ) => {
    try {
      service.wake();
      return links(await operation(), request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Kanban operation failed";
      const status =
        error instanceof KanbanError
          ? error.status
          : /not found|does not exist/i.test(message)
            ? 404
            : /invalid|required|must be|too long/i.test(message)
              ? 400
              : 409;
      return reply.code(status).send({
        error: {
          code: status === 404 ? "not_found" : status === 400 ? "validation_failed" : "conflict",
          message,
        },
      });
    }
  };
  app.get<{ Params: { id: string } }>(root, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return run(request, reply, () => service.read(projectPath(request.params.id)));
  });
  app.post<{ Params: { id: string }; Body: Parameters<KanbanService["createCard"]>[1] }>(
    `${root}/cards`,
    async (request, reply) =>
      run(request, reply, () => service.createCard(projectPath(request.params.id), request.body)),
  );
  app.patch<{
    Params: { id: string; cardId: string };
    Body: Parameters<KanbanService["updateCard"]>[2];
  }>(`${root}/cards/:cardId`, async (request, reply) =>
    run(request, reply, () =>
      service.updateCard(projectPath(request.params.id), request.params.cardId, request.body),
    ),
  );
  app.post<{ Params: { id: string }; Body: Parameters<KanbanService["createStage"]>[1] }>(
    `${root}/stages`,
    async (request, reply) =>
      run(request, reply, () => service.createStage(projectPath(request.params.id), request.body)),
  );
  app.post<{ Params: { id: string }; Body: Parameters<KanbanService["action"]>[1] }>(
    `${root}/actions`,
    async (request, reply) =>
      run(request, reply, () => service.action(projectPath(request.params.id), request.body)),
  );
}
