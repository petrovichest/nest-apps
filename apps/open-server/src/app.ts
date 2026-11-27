import { registerSessionMessaging } from "@nest-apps/kanban";
import { timingSafeEqual } from "node:crypto";
import { access, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type {
  AttentionResponse,
  QueueMessageRequest,
  ServerFrame,
  ThreadDraft,
} from "@codexnest/protocol";
import { mergeProjectDraft, pastedText, validPastedText } from "@codexnest/protocol";
import { readGitChanges } from "../../claude-server/src/git-changes";
import { AppError, blankDraft, type Engine, object, text } from "./engine";
import { OpenCodeError } from "./opencode";
import { registerAttachmentRoutes } from "./attachments";
import { registerArtifactRoutes } from "./artifacts";
import { registerVoiceRoutes } from "./voice-routes";
import { VoiceServiceError } from "./voice";
import { BrowserExtensionServer, BrowserExtensionError } from "./browser-extension";
import { OpenConnection, OpenConnectionError } from "./connection";
import { OPEN_BROWSER_EXTENSION_ORIGIN } from "@codexnest/protocol";
import { registerOpenKanban } from "./kanban";
import { registerSkillRoutes } from "./skills";
import { registerWorkflows } from "./workflows";
import { registerForkRoutes } from "./forks";
import { registerSearchRoutes } from "./search";
import { AppManager } from "./app-management";

function equalToken(value: unknown, expected: string) {
  if (typeof value !== "string") return false;
  const left = Buffer.from(value),
    right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function draft(input: unknown): ThreadDraft {
  const value = object(input);
  if (
    !Array.isArray(value.images) ||
    !Array.isArray(value.annotations) ||
    typeof value.goalMode !== "boolean"
  )
    throw new AppError("validation_failed", "Invalid draft");
  const inputText = text(value.input);
  if (!validPastedText(value, inputText))
    throw new AppError("validation_failed", "Invalid pasted input");
  return {
    input: inputText,
    images: value.images,
    annotations: value.annotations,
    ...(value.files ? { files: value.files } : {}),
    ...pastedText(value),
    goalMode: value.goalMode,
    updatedAt: Date.now(),
  };
}

function recordTargetRuntime(body: unknown): "claude" | undefined {
  return body &&
    typeof body === "object" &&
    "targetRuntime" in body &&
    body.targetRuntime === "claude"
    ? "claude"
    : undefined;
}

export async function buildApp(engine: Engine) {
  const { config } = engine;
  const appManager = new AppManager(config);
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024, forceCloseConnections: true });
  await app.register(cors, {
    origin: (origin, callback) =>
      callback(
        null,
        !origin || origin === OPEN_BROWSER_EXTENSION_ORIGIN || config.allowedOrigins.has(origin),
      ),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-codexnest-audio-duration-ms"],
  });
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 },
    preClose(done) {
      for (const socket of this.websocketServer.clients) socket.terminate();
      this.websocketServer.close(() => done());
    },
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof OpenConnectionError || error instanceof VoiceServiceError)
      return reply.code(error.statusCode).send({
        error: {
          code: error instanceof OpenConnectionError ? error.code : error.kind,
          message: error.message,
        },
      });
    if (error instanceof BrowserExtensionError)
      return reply
        .code(error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof AppError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof OpenCodeError)
      return reply.code(503).send({
        error: {
          code: "app_server_unavailable",
          message:
            "OpenCode could not complete this request. Inspect native readiness before retrying.",
        },
      });
    const candidate = (error as { statusCode?: number }).statusCode;
    const statusCode =
      typeof candidate === "number" && candidate >= 400 && candidate < 500 ? candidate : 500;
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? "internal_error" : "validation_failed",
        message:
          statusCode === 500 ? "OpenNest could not complete this request." : "Invalid request.",
      },
    });
  });
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    if (
      request.headers.origin &&
      request.headers.origin !== OPEN_BROWSER_EXTENSION_ORIGIN &&
      !config.allowedOrigins.has(request.headers.origin)
    )
      return reply
        .code(403)
        .send({ error: { code: "forbidden", message: "Origin is not allowed" } });
    if (
      request.method === "OPTIONS" ||
      path === "/api/v1/ui/events" ||
      path === "/api/v1/browser-extension/events" ||
      path.startsWith("/api/v1/downloads/") ||
      path.startsWith("/api/v1/internal/browser-mcp/")
    )
      return;
    if (
      path.startsWith("/api/v1/internal/") &&
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip)
    )
      return reply.code(403).send({ error: { code: "forbidden", message: "Internal route" } });
    if (
      !equalToken(/^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1], config.token)
    )
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Authentication required" } });
  });
  const connection = new OpenConnection(config, {
    withIdleNative: (action) =>
      engine.withIdleNative(async () => {
        engine.ready = false;
        engine.publish({ type: "connection.changed", connection: engine.connection() });
        return action();
      }),
  });
  await connection.initialize();
  app.get("/api/v1/settings/open/proxy", () => connection.status());
  app.put("/api/v1/settings/open/proxy", async (request) => {
    const result = await connection.setProxy(object(request.body).proxy);
    await engine.reconcile();
    return result;
  });
  app.post("/api/v1/settings/open/proxy/test", () => connection.testProxy());
  const browser = new BrowserExtensionServer({ app, engine, config });
  browser.registerRoutes();
  registerAttachmentRoutes(app, engine);
  registerArtifactRoutes(app, engine);
  registerSkillRoutes(app, engine);
  registerSearchRoutes(app, engine);
  registerForkRoutes(app, engine);
  const messaging = registerSessionMessaging(app, {
    provider: "open",
    port: config.port,
    credential: config.token,
    thread: (id) => {
      const thread = Object.hasOwn(engine.data.threads, id) ? engine.data.threads[id] : undefined;
      return thread && !thread.workflow?.parentId ? engine.summary(id) : undefined;
    },
    enqueue: (id, input, clientMessageId) => engine.send(id, { input, clientMessageId }, true),
  });
  await registerWorkflows(app, engine, messaging.send);
  const { voice } = await registerVoiceRoutes(app, engine);
  await registerOpenKanban(app, engine, voice);
  engine.enableCapabilities({
    browserIntegration: true,
    artifacts: true,
    skills: true,
    sessionApprovalGrants: true,
    appUpdates: true,
  });
  app.get("/api/v1/health", () => ({
    app: "opennest",
    provider: "open",
    status: engine.ready ? "ok" : "degraded",
    serverVersion: config.version,
    recoveryState: !engine.accepting ? "draining" : engine.ready ? "ready" : "unavailable",
    restartProtocolVersion: 1,
    transport: "daemon",
    activeTurnCount: engine.snapshot().threads.filter((thread) => thread.currentTurnId).length,
    appServer: {
      state: engine.ready ? "ready" : "unavailable",
      installedVersion: engine.runtimeVersion,
      message: engine.connection().message,
    },
  }));
  app.get("/api/v1/summary", () => ({
    threadCount: Object.keys(engine.data.threads).length,
    projectCount: engine.data.projects.length,
    pendingAttentionCount: engine.snapshot().attention.length,
    syncedAt: engine.connection().syncedAt,
  }));
  app.get("/api/v1/snapshot", () => engine.snapshot());
  app.get("/api/v1/settings/open", () => engine.connectionStatus());
  app.put("/api/v1/settings/open", (request) =>
    engine.setApiKey(text(object(request.body).apiKey, "apiKey", 16_000)),
  );
  app.post("/api/v1/settings/open/test", async () => {
    await engine.reconcile();
    return {
      ...engine.connectionStatus(),
      message:
        "OpenCode is reachable. OpenRouter credentials are checked when a model request runs.",
    };
  });
  app.get("/api/v1/settings/permissions", () => engine.permissions());
  app.put("/api/v1/settings/permissions", async (request) => {
    const body = object(request.body);
    if (!["ask", "auto", "full-access"].includes(body.preset))
      throw new AppError("validation_failed", "Invalid permission preset");
    return engine.setPermissions(body.preset, body.expectedVersion);
  });
  app.get("/api/v1/settings/app", () => appManager.status());
  app.post("/api/v1/settings/app/check", () => appManager.check());
  app.post("/api/v1/settings/app/update", () => appManager.update());
  app.post("/api/v1/settings/app/force-restart", async (_request, reply) =>
    reply.code(202).send(await appManager.forceRestart()),
  );
  app.get("/api/v1/codex/rate-limits", () => ({ primary: null, secondary: null }));
  app.put("/api/v1/settings/task-defaults", async (request) => {
    const body = object(request.body);
    for (const key of [
      "model",
      "reasoningEffort",
      "titleModel",
      "classificationModel",
      "replyCheckModel",
    ] as const) {
      if (body[key] === null) delete engine.data.taskDefaults[key];
      else if (body[key] !== undefined) engine.data.taskDefaults[key] = text(body[key], key, 500);
    }
    if (body.classifyTasks !== undefined) {
      if (body.classifyTasks !== null && typeof body.classifyTasks !== "boolean")
        throw new AppError("validation_failed", "Invalid classifyTasks");
      if (body.classifyTasks === null) delete engine.data.taskDefaults.classifyTasks;
      else engine.data.taskDefaults.classifyTasks = body.classifyTasks;
    }
    await engine.save();
    engine.publish({ type: "taskDefaults.changed", taskDefaults: engine.data.taskDefaults });
    return engine.data.taskDefaults;
  });
  app.put("/api/v1/settings/ui-language", async (request) => {
    const language = object(request.body).language;
    if (language !== "ru" && language !== "en")
      throw new AppError("validation_failed", "Invalid language");
    engine.data.language = language;
    await engine.save();
    engine.publish({ type: "uiLanguage.changed", language });
    return { language };
  });
  app.post("/api/v1/internal/restart/prepare", (request) =>
    engine.prepareRestart(recordTargetRuntime(request.body)),
  );
  app.post("/api/v1/internal/restart/resume", () => {
    engine.resumeAccepting();
    return { resumed: true };
  });
  async function directories(path?: string) {
    const current = await realpath(path || homedir());
    const entries = await readdir(current, { withFileTypes: true });
    return {
      rootPath: homedir(),
      path: current,
      parentPath: dirname(current) === current ? null : dirname(current),
      directories: entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  app.get<{ Querystring: { path?: string } }>("/api/v1/directories", (request) =>
    directories(request.query.path),
  );
  app.post("/api/v1/directories", async (request) => {
    const body = object(request.body),
      name = text(body.name, "name", 200);
    if (!name || /[/\\\0]/.test(name) || name === "." || name === "..")
      throw new AppError("validation_failed", "Invalid directory name");
    const parent = await realpath(text(body.parentPath, "parentPath", 4096));
    const path = join(parent, name);
    await mkdir(path);
    return directories(path);
  });
  app.get("/api/v1/projects", () => engine.data.projects);
  app.post("/api/v1/projects", (request) => {
    const body = object(request.body);
    return engine.addProject(
      text(body.path, "path", 4096),
      body.displayName === undefined ? undefined : text(body.displayName, "displayName", 200),
    );
  });
  app.delete<{ Params: { id: string } }>("/api/v1/projects/:id", async (request) => {
    const id = engine.project(request.params.id).id;
    if (engine.snapshot().threads.some((thread) => thread.projectId === id && thread.currentTurnId))
      throw new AppError("conflict", "Project has active work", 409);
    engine.data.projects = engine.data.projects.filter((project) => project.id !== id);
    for (const thread of Object.values(engine.data.threads))
      if (thread.summary.projectId === id) thread.summary.projectId = null;
    await engine.save();
    engine.publish({ type: "project.removed", projectId: id });
    return { deleted: true };
  });
  app.post<{ Params: { id: string } }>("/api/v1/projects/:id/move", async (request) => {
    const project = engine.project(request.params.id),
      body = object(request.body);
    const from = engine.data.projects.indexOf(project),
      to = body.targetIndex ?? from + (body.direction === "up" ? -1 : 1);
    if (!Number.isInteger(to) || to < 0 || to >= engine.data.projects.length)
      throw new AppError("validation_failed", "Invalid project position");
    engine.data.projects.splice(from, 1);
    engine.data.projects.splice(to, 0, project);
    await engine.save();
    engine.publish({ type: "projects.reordered", projects: engine.data.projects });
    return engine.data.projects;
  });
  app.post<{ Params: { id: string } }>("/api/v1/projects/:id/threads", (request) => {
    const body = object(request.body);
    return engine.createThread(
      request.params.id,
      text(body.clientCreationId, "clientCreationId", 200),
      body.draft ? draft(body.draft) : undefined,
    );
  });
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/draft", (request) => {
    engine.project(request.params.id);
    return engine.data.projectDrafts[request.params.id] ?? null;
  });
  app.put<{ Params: { id: string } }>("/api/v1/projects/:id/draft", async (request) => {
    const id = engine.project(request.params.id).id,
      body = object(request.body);
    const next = {
      ...mergeProjectDraft(
        engine.data.projectDrafts[id] ?? blankDraft(),
        draft(body.base),
        draft(body.value),
      ),
      updatedAt: Date.now(),
    };
    engine.data.projectDrafts[id] = next;
    await engine.save();
    engine.publish({ type: "projectDraft.changed", projectId: id, draft: next });
    return next;
  });
  app.get<{ Params: { id: string } }>("/api/v1/threads/:id", (request) =>
    engine.refreshThread(request.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/refresh", async (request) => ({
    detail: await engine.refreshThread(request.params.id),
    snapshot: engine.snapshot(),
  }));
  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/reference", (request) => ({
    threadId: engine.thread(request.params.id).summary.id,
    cwd: engine.thread(request.params.id).summary.cwd,
    historyPath: null,
  }));
  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/git-changes", (request) =>
    readGitChanges(engine.thread(request.params.id).summary.cwd),
  );
  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/history", (request) => ({
    instanceId: engine.instanceId,
    anchorTurnId: engine.detail(request.params.id).turns[0]?.id ?? "",
    turns: [],
    olderTurnsCursor: null,
  }));
  app.get<{ Params: { id: string; turnId: string } }>(
    "/api/v1/threads/:id/turns/:turnId/items",
    (request) => {
      const turn = engine
        .detail(request.params.id)
        .turns.find((item) => item.id === request.params.turnId);
      if (!turn) throw new AppError("not_found", "Turn not found", 404);
      return { threadId: request.params.id, turnId: turn.id, items: turn.items };
    },
  );
  app.patch<{ Params: { id: string } }>("/api/v1/threads/:id/settings", (request) =>
    engine.settings(request.params.id, object(request.body)),
  );
  app.patch<{ Params: { id: string } }>("/api/v1/threads/:id", (request) =>
    (async () => {
      const body = object(request.body);
      if (typeof body.browserEnabled === "boolean") {
        if (body.browserEnabled) await browser.enableThread(request.params.id);
        else await browser.disableThread(request.params.id);
      }
      return engine.patchThread(request.params.id, body);
    })(),
  );
  app.delete<{ Params: { id: string } }>("/api/v1/threads/:id/browser-binding", (request) =>
    browser.detachThread(request.params.id),
  );
  for (const action of ["archive", "unarchive"] as const)
    app.post<{ Params: { id: string } }>(`/api/v1/threads/:id/${action}`, (request) =>
      engine.patchThread(request.params.id, { archived: action === "archive" }),
    );
  for (const action of ["read", "viewed"] as const)
    app.put<{ Params: { id: string } }>(`/api/v1/threads/:id/${action}`, async (request) => {
      const thread = engine.thread(request.params.id);
      if (object(request.body).observedUpdatedAt >= thread.summary.updatedAt) {
        thread.summary.unseen = false;
        if (action === "read") thread.summary.unread = false;
        await engine.save();
        engine.changed(request.params.id);
      }
      return engine.summary(request.params.id);
    });
  app.put<{ Params: { id: string }; Querystring: { expectedUpdatedAt?: string } }>(
    "/api/v1/threads/:id/draft",
    async (request) => {
      const thread = engine.thread(request.params.id);
      if (
        request.query.expectedUpdatedAt !== undefined &&
        (request.query.expectedUpdatedAt === "none"
          ? null
          : Number(request.query.expectedUpdatedAt)) !== (thread.draft?.updatedAt ?? null)
      )
        throw new AppError("draft_conflict", "Draft changed on another device", 409);
      thread.draft = draft(request.body);
      await engine.save();
      return thread.draft;
    },
  );
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/turns", async (request) => {
    await engine.send(request.params.id, object(request.body) as QueueMessageRequest);
    return { turnId: engine.summary(request.params.id).currentTurnId };
  });
  for (const action of ["queue", "steer"] as const)
    app.post<{ Params: { id: string } }>(`/api/v1/threads/:id/${action}`, (request) =>
      engine.send(
        request.params.id,
        object(request.body) as QueueMessageRequest,
        action === "queue",
      ),
    );
  app.post<{ Params: { id: string; messageId: string } }>(
    "/api/v1/threads/:id/queue/:messageId/send",
    (request) => engine.sendQueued(request.params.id, request.params.messageId),
  );
  app.patch<{ Params: { id: string; messageId: string } }>(
    "/api/v1/threads/:id/queue/:messageId",
    (request) =>
      engine.updateQueued(request.params.id, request.params.messageId, object(request.body)),
  );
  app.delete<{ Params: { id: string; messageId: string } }>(
    "/api/v1/threads/:id/queue/:messageId",
    async (request) => {
      const thread = engine.thread(request.params.id),
        message = thread.queue.find((m) => m.id === request.params.messageId);
      if (message?.status === "dispatching" && !message.deliveryError)
        throw new AppError("conflict", "Message is being dispatched", 409);
      thread.queue = thread.queue.filter((m) => m.id !== request.params.messageId);
      await engine.save();
      engine.publish({
        type: "queue.changed",
        threadId: request.params.id,
        messages: thread.queue,
      });
      return { deleted: true };
    },
  );
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/interrupt", async (request) => {
    await engine.interrupt(request.params.id);
    return { interrupted: true };
  });
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/compact", (request) =>
    engine.compact(request.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/fork", async (request) => ({
    thread: await engine.fork(
      request.params.id,
      request.body ? object(request.body).messageId : undefined,
    ),
  }));
  app.post<{ Params: { id: string } }>("/api/v1/attention/:id/respond", async (request) => {
    await engine.respond(request.params.id, object(request.body) as AttentionResponse);
    return { accepted: true };
  });
  app.put<{ Params: { id: string } }>("/api/v1/attention/:id/draft", async (request) => {
    const body = object(request.body),
      previous = engine.data.userInputDrafts?.[request.params.id];
    if (
      !body.answers ||
      typeof body.answers !== "object" ||
      Array.isArray(body.answers) ||
      !Object.values(body.answers).every(
        (answer) => Array.isArray(answer) && answer.every((item) => typeof item === "string"),
      )
    )
      throw new AppError("validation_failed", "Invalid answers");
    const saved = {
      answers: body.answers,
      currentQuestionId: typeof body.currentQuestionId === "string" ? body.currentQuestionId : null,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      ...(Array.isArray(body.appliedRecordingIds)
        ? { appliedRecordingIds: body.appliedRecordingIds }
        : {}),
    };
    (engine.data.userInputDrafts ??= {})[request.params.id] = saved;
    await engine.save();
    return saved;
  });
  app.get("/api/v1/attention", () => engine.snapshot().attention);
  app.get("/api/v1/ui/events", { websocket: true }, (socket) => {
    let authenticated = false;
    const timeout = setTimeout(() => socket.close(1008, "Authentication required"), 10_000);
    const send = (frame: ServerFrame) => {
      if (socket.readyState === 1) {
        if (socket.bufferedAmount > 4 * 1024 * 1024)
          socket.close(1013, "Reconnect for resynchronization");
        else socket.send(JSON.stringify(frame));
      }
    };
    socket.on("message", (raw) => {
      let frame: Record<string, any>;
      try {
        frame = object(JSON.parse(raw.toString()));
      } catch {
        socket.close(1008, "Invalid frame");
        return;
      }
      if (!authenticated) {
        if (frame.type !== "authenticate" || !equalToken(frame.token, config.token)) {
          socket.close(1008, "Authentication failed");
          return;
        }
        authenticated = true;
        clearTimeout(timeout);
        engine.on("frame", send);
        send({ type: "snapshot", snapshot: engine.snapshot() });
        return;
      }
      if (frame.type === "ping") send({ type: "pong" });
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      engine.off("frame", send);
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      engine.off("frame", send);
    });
  });
  if (
    await access(config.clientDist).then(
      () => true,
      () => false,
    )
  ) {
    await app.register(fastifyStatic, { root: config.clientDist, wildcard: false });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: { code: "not_found", message: "Route not found" } })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", () => engine.close());
  return app;
}
