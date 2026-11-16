import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { AppError, type Engine } from "./engine";

export function registerAttachmentRoutes(app: FastifyInstance, engine: Engine) {
  app.addContentTypeParser("application/octet-stream", (_request, stream, done) =>
    done(null, stream),
  );
  for (const scope of ["projects", "threads"] as const) {
    app.post<{ Params: { id: string }; Querystring: { name: string; mediaType: string } }>(
      `/api/v1/${scope}/:id/attachments`,
      { bodyLimit: 100 * 1024 * 1024 },
      (request) => {
        if (scope === "projects") engine.project(request.params.id);
        else if (!engine.data.forkOperations?.[request.params.id]) engine.thread(request.params.id);
        return engine.attachments.save(
          request.params.id,
          request.query.name,
          request.query.mediaType,
          request.body as Readable,
          request.headers["content-length"] ? Number(request.headers["content-length"]) : undefined,
        );
      },
    );
  }
  app.delete<{ Params: { id: string; attachmentId: string } }>(
    "/api/v1/threads/:id/attachments/:attachmentId",
    async (request) => {
      const thread = engine.thread(request.params.id);
      if (
        Object.values(thread.receipts).some((receipt) =>
          receipt.message.files?.some((file) => file.id === request.params.attachmentId),
        )
      )
        throw new AppError("conflict", "This attachment is already part of a sent message", 409);
      await engine.attachments.remove(request.params.id, request.params.attachmentId);
      return { deleted: true };
    },
  );
}
