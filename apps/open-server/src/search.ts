import type { FastifyInstance } from "fastify";
import { AppError, text, type Engine } from "./engine";
import { NativeHistorySearchError, searchNativeHistory } from "./history-search";

export function registerSearchRoutes(app: FastifyInstance, engine: Engine) {
  const search = async (
    query: string,
    sessionIds: string[],
    cursor?: string,
    distinctSessions = false,
  ) => {
    try {
      return await searchNativeHistory({
        databasePath: engine.config.nativeDatabasePath,
        query,
        sessionIds,
        cursor,
        limit: distinctSessions ? 50 : 20,
        distinctSessions,
      });
    } catch (error) {
      if (error instanceof NativeHistorySearchError)
        throw new AppError(
          error.code === "invalid_cursor"
            ? "history_changed"
            : error.code === "invalid_query"
              ? "validation_failed"
              : "app_server_unavailable",
          error.message,
          error.code === "invalid_cursor" ? 409 : error.code === "invalid_query" ? 400 : 503,
        );
      throw error;
    }
  };
  app.get<{ Querystring: { q?: string; archived?: string; scope?: string; cursor?: string } }>(
    "/api/v1/threads/search",
    async (request) => {
      const query = text(request.query.q ?? "", "query", 500).trim();
      if (!query) return { data: [], nextCursor: null };
      const candidates = Object.keys(engine.data.threads).filter(
        (id) => engine.thread(id).summary.archived === (request.query.archived === "true"),
      );
      if (request.query.scope === "titles") {
        const offset = request.query.cursor ? Number(request.query.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new AppError("validation_failed", "Invalid search cursor");
        const matches = candidates
          .map((id) => engine.summary(id))
          .filter((thread) => thread.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .sort((left, right) => right.updatedAt - left.updatedAt);
        return {
          data: matches
            .slice(offset, offset + 50)
            .map((thread) => ({ thread, snippet: thread.preview })),
          nextCursor: offset + 50 < matches.length ? String(offset + 50) : null,
        };
      }
      const result = await search(query, candidates, request.query.cursor, true);
      return {
        data: result.data.map((hit) => ({
          thread: engine.summary(hit.sessionId),
          snippet: hit.snippet,
        })),
        nextCursor: result.nextCursor,
      };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { q?: string; cursor?: string } }>(
    "/api/v1/threads/:id/search",
    async (request) => {
      engine.thread(request.params.id);
      const query = text(request.query.q ?? "", "query", 500).trim();
      if (!query) return { data: [], nextCursor: null };
      const result = await search(query, [request.params.id], request.query.cursor);
      return {
        data: result.data.map((hit) => ({
          turnId: hit.turnId,
          itemId: hit.itemId,
          snippet: hit.snippet,
          snippetMatchRange: hit.snippetMatchRange,
          turnCursor: hit.turnId,
        })),
        nextCursor: result.nextCursor,
      };
    },
  );
  app.get<{ Params: { id: string; turnId: string } }>(
    "/api/v1/threads/:id/turns/:turnId",
    async (request) => {
      const detail = await engine.refreshThread(request.params.id),
        turn = detail.turns.find((candidate) => candidate.id === request.params.turnId);
      if (!turn) throw new AppError("not_found", "Turn not found", 404);
      return { instanceId: engine.instanceId, turn };
    },
  );
  engine.enableCapabilities({ fullTextSearch: true });
}
