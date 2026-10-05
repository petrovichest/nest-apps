import { timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { stat } from "node:fs/promises";
import Fastify from "fastify";
import { readHistory } from "./history";
import type { SessionManager } from "./manager";
import type { RunnerConnection } from "./rpc";
import { AppError, assertUuid, record } from "./types";
import type { UiService } from "./ui-service";
import { registerUiRoutes } from "./ui-routes";
import { VoiceServiceError } from "./voice";
import { AttachmentTooLargeError, AttachmentValidationError } from "./attachments";

function text(value: unknown, name: string, limit = 200_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new AppError(
      "invalid_request",
      `${name} must be nonempty text (maximum ${limit} characters)`,
    );
  return value;
}
function equalToken(value: unknown, token: string): boolean {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildApp(manager: SessionManager, ui?: UiService) {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024, forceCloseConnections: true });
  await app.register(websocket, {
    options: { maxPayload: 1_048_576 },
    preClose(done) {
      for (const socket of this.websocketServer.clients) socket.terminate();
      this.websocketServer.close(() => done());
    },
  });
  app.setErrorHandler((error, _request, reply) => {
    const exposed =
      error instanceof VoiceServiceError ||
      error instanceof AttachmentTooLargeError ||
      error instanceof AttachmentValidationError;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const httpStatus = (error as { statusCode?: number }).statusCode;
    const status =
      error instanceof AppError
        ? error.status
        : exposed
          ? error.statusCode
          : missing
            ? 404
            : httpStatus && httpStatus >= 400 && httpStatus < 500
              ? httpStatus
              : 500;
    reply.code(status).send({
      error: {
        code:
          error instanceof AppError || exposed
            ? error instanceof AppError
              ? error.code
              : error instanceof VoiceServiceError
                ? error.kind
                : "invalid_request"
            : missing
              ? "not_found"
              : status >= 400 && status < 500
                ? "invalid_request"
                : "internal",
        message:
          error instanceof AppError || exposed
            ? error.message
            : missing
              ? "Native session history was not found"
              : status >= 400 && status < 500
                ? "Invalid request"
                : "ClaudeNest operation failed",
      },
    });
  });
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !manager.config.allowedOrigins.has(origin))
      return reply
        .code(403)
        .send({ error: { code: "unauthorized", message: "Origin not allowed" } });
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/") || path === "/api/v1/events" || path === "/api/v1/ui/events")
      return;
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (!equalToken(token, manager.config.token))
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Authentication required" } });
  });
  app.get("/api/v1/health", async () => ({
    status: "ok",
    app: "claudenest",
    provider: "claude",
    serverVersion: "0.1.0",
    runnerProtocolVersion: 1,
    recoveryState: manager.accepting ? "ready" : "draining",
    releasePath: manager.config.releasePath,
    restartProtocolVersion: 1,
    transport: "daemon",
    appServer: { state: "ready", installedVersion: null, message: null },
  }));
  app.get<{ Querystring: { cwd?: string } }>("/api/v1/sessions", async (request) => ({
    sessions: await manager.list(request.query.cwd),
  }));
  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id/history", async (request) => {
    assertUuid(request.params.id, "sessionId");
    return readHistory(manager.config.configDir, request.params.id);
  });
  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id/snapshot", async (request) =>
    manager.snapshot(request.params.id),
  );
  app.post("/api/v1/sessions", async (request, reply) => {
    const body = record(request.body);
    assertUuid(body.sessionId, "sessionId");
    assertUuid(body.requestId, "requestId");
    const result = await manager.create({
      sessionId: body.sessionId,
      requestId: body.requestId,
      cwd: text(body.cwd, "cwd", 4096),
      prompt: text(body.prompt, "prompt"),
      model: body.model === undefined ? undefined : text(body.model, "model", 200),
    });
    return reply.code(202).send({ sessionId: body.sessionId.toLowerCase(), receipt: result });
  });
  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/messages", async (request, reply) => {
    const body = record(request.body);
    assertUuid(body.requestId, "requestId");
    return reply.code(202).send({
      receipt: await manager.send(request.params.id, body.requestId, text(body.prompt, "prompt")),
    });
  });
  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/interrupt", async (request) => {
    const body = record(request.body);
    assertUuid(body.requestId, "requestId");
    return manager.command(request.params.id, "interrupt", { requestId: body.requestId });
  });
  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/release", async (request) =>
    manager.command(request.params.id, "release", {}),
  );
  app.post<{ Params: { id: string } }>("/api/v1/requests/:id/responses", async (request) => {
    const body = record(request.body);
    assertUuid(body.sessionId, "sessionId");
    assertUuid(body.requestId, "requestId");
    const response = record(body.response);
    if (response.behavior !== "allow" && response.behavior !== "deny")
      throw new AppError("invalid_request", "response.behavior must be allow or deny");
    if (response.behavior === "allow") record(response.updatedInput);
    else text(response.message, "response.message", 10_000);
    return manager.command(body.sessionId, "respond", {
      requestId: body.requestId,
      targetRequestId: request.params.id,
      response,
    });
  });
  app.post("/api/v1/internal/restart/prepare", async (request) => {
    const body = record(request.body);
    if (
      !Array.isArray(body.supportedRunnerProtocols) ||
      !body.supportedRunnerProtocols.every(Number.isInteger)
    )
      throw new AppError("invalid_request", "supportedRunnerProtocols must be an integer array");
    return manager.prepare(body.supportedRunnerProtocols);
  });
  app.post("/api/v1/internal/restart/resume", async () => {
    manager.resume();
    return { resumed: true };
  });
  app.get("/api/v1/events", { websocket: true }, (socket) => {
    let authenticated = false;
    const subscriptions = new Map<string, RunnerConnection>();
    let handling = Promise.resolve();
    const timer = setTimeout(() => socket.close(1008, "Authentication timeout"), 5_000);
    const send = (value: unknown) => {
      const payload = JSON.stringify(value);
      if (socket.bufferedAmount + Buffer.byteLength(payload) > 16 * 1024 * 1024) {
        socket.close(1013, "Reconnect and resynchronize");
        return;
      }
      if (socket.readyState === 1) socket.send(payload);
    };
    socket.on("message", (raw) => {
      handling = handling
        .then(async () => {
          const message = record(JSON.parse(raw.toString()));
          if (!authenticated) {
            if (
              message.type !== "authenticate" ||
              !equalToken(message.token, manager.config.token)
            ) {
              socket.close(1008, "Authentication required");
              return;
            }
            authenticated = true;
            clearTimeout(timer);
            send({ type: "authenticated" });
            return;
          }
          if (message.type === "ping") {
            send({ type: "pong" });
            return;
          }
          if (message.type !== "subscribe")
            throw new AppError("invalid_request", "Expected subscribe or ping");
          assertUuid(message.sessionId, "sessionId");
          if (
            message.afterSequence !== undefined &&
            (!Number.isSafeInteger(message.afterSequence) || Number(message.afterSequence) < 0)
          )
            throw new AppError("invalid_request", "afterSequence must be a nonnegative integer");
          if (subscriptions.size >= 32 && !subscriptions.has(message.sessionId))
            throw new AppError("invalid_request", "Too many subscriptions");
          subscriptions.get(message.sessionId)?.close();
          const connection = await manager.subscribe(message.sessionId);
          if (socket.readyState !== 1) {
            connection.close();
            return;
          }
          subscriptions.set(message.sessionId, connection);
          connection.on("message", send);
          connection.on("close", () => {
            if (socket.readyState === 1)
              send({ type: "unavailable", sessionId: message.sessionId });
          });
          const result = await connection.request("subscribe", {
            afterSequence: message.afterSequence,
            runnerInstanceId: message.runnerInstanceId,
          });
          send({ type: "subscribed", sessionId: message.sessionId, result });
        })
        .catch((error: unknown) =>
          send({
            type: "error",
            error: {
              code: error instanceof AppError ? error.code : "invalid_request",
              message: error instanceof AppError ? error.message : "Invalid websocket message",
            },
          }),
        );
    });
    socket.on("close", () => {
      clearTimeout(timer);
      for (const connection of subscriptions.values()) connection.close();
      subscriptions.clear();
    });
  });
  let stopVoice: (() => Promise<void>) | undefined;
  if (ui) {
    stopVoice = await registerUiRoutes(app, ui);
    app.get("/api/v1/ui/events", { websocket: true }, (socket) => {
      let authenticated = false;
      const send = (frame: unknown) => {
        if (socket.readyState !== 1) return;
        const payload = JSON.stringify(frame);
        if (socket.bufferedAmount + Buffer.byteLength(payload) > 16 * 1024 * 1024) {
          socket.close(1013, "Reconnect and resynchronize");
          return;
        }
        socket.send(payload);
      };
      const timer = setTimeout(() => socket.close(1008, "Authentication timeout"), 5_000);
      socket.on("message", (raw) => {
        try {
          const frame = record(JSON.parse(raw.toString()));
          if (!authenticated) {
            if (frame.type !== "authenticate" || !equalToken(frame.token, manager.config.token)) {
              socket.close(1008, "Authentication required");
              return;
            }
            authenticated = true;
            clearTimeout(timer);
            ui.on("frame", send);
            send({ type: "snapshot", snapshot: ui.snapshot() });
          } else if (frame.type === "ping") send({ type: "pong" });
          else socket.close(1008, "Invalid websocket frame");
        } catch {
          socket.close(1008, "Invalid websocket frame");
        }
      });
      socket.on("close", () => {
        clearTimeout(timer);
        ui.off("frame", send);
      });
    });
  }
  const clientDist = manager.config.clientDist;
  if (
    clientDist &&
    (await stat(clientDist)
      .then((info) => info.isDirectory())
      .catch(() => false))
  ) {
    await app.register(fastifyStatic, {
      root: clientDist,
      wildcard: false,
      index: ["index.html"],
      setHeaders(response, path) {
        response.header("X-Content-Type-Options", "nosniff");
        if (path.endsWith("index.html") || path.endsWith("sw.js"))
          response.header("Cache-Control", "no-cache");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        !request.url.startsWith("/api/") &&
        !request.url.startsWith("/downloads/") &&
        request.headers.accept?.includes("text/html")
      )
        return reply.sendFile("index.html");
      return reply.code(404).send({ error: { code: "not_found", message: "Route not found" } });
    });
  }
  app.addHook("onClose", async () => {
    await stopVoice?.();
    await ui?.close();
    await manager.close();
  });
  return app;
}
