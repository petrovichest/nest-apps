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
  const handle = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: () => Promise<T>,
  ) => {
    try {
      service.wake();
      return await operation();
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
  const run = (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: () => Promise<KanbanBoard>,
  ) => handle(request, reply, async () => links(await operation(), request));
  app.get<{ Params: { id: string; cardId: string } }>(
    `${root}/cards/:cardId/image`,
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return handle(request, reply, () =>
        service.readImage(projectPath(request.params.id), request.params.cardId),
      );
    },
  );
  app.get<{ Params: { id: string } }>(root, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return run(request, reply, () => service.read(projectPath(request.params.id)));
  });
  app.post<{ Params: { id: string }; Body: Parameters<KanbanService["createCard"]>[1] }>(
    `${root}/cards`,
    { bodyLimit: 15 * 1024 * 1024 },
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
  app.delete<{ Params: { id: string; cardId: string } }>(
    `${root}/cards/:cardId`,
    async (request, reply) =>
      run(request, reply, () =>
        service.deleteCard(projectPath(request.params.id), request.params.cardId),
      ),
  );
  app.patch<{
    Params: { id: string; stageId: string };
    Body: Parameters<KanbanService["updateStage"]>[2];
  }>(`${root}/stages/:stageId`, async (request, reply) =>
    run(request, reply, () =>
      service.updateStage(projectPath(request.params.id), request.params.stageId, request.body),
    ),
  );
  app.delete<{ Params: { id: string; stageId: string } }>(
    `${root}/stages/:stageId`,
    async (request, reply) =>
      run(request, reply, () =>
        service.deleteStage(projectPath(request.params.id), request.params.stageId),
      ),
  );
  app.post<{ Params: { id: string }; Body: Parameters<KanbanService["action"]>[1] }>(
    `${root}/actions`,
    async (request, reply) =>
      run(request, reply, () => service.action(projectPath(request.params.id), request.body)),
  );
}
