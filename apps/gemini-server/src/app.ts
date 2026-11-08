import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type {
  AttentionResponse,
  QueueMessageRequest,
  ThreadDraft,
  TranscriptionProvider,
  UpdateTranscriptionSettingsRequest,
  UpdateUserInputDraftRequest,
} from "@codexnest/protocol";
import {
  BROWSER_EXTENSION_WEBSOCKET_PATH,
  GEMINI_BROWSER_EXTENSION_ORIGIN,
  mergeProjectDraft,
  pastedText,
  validPastedText,
} from "@codexnest/protocol";
import {
  AttachmentTooLargeError,
  AttachmentValidationError,
} from "../../claude-server/src/attachments";
import { readGitChanges } from "../../claude-server/src/git-changes";
import { AppManager } from "./app-management";
import { isAuthorizedBrainArtifactPath, resolveGeminiSessionArtifacts } from "./artifacts";
import {
  BrowserExtensionError,
  BrowserExtensionServer,
  isLoopbackAddress,
  type BrowserExtensionOptions,
} from "./browser-extension";
import { type Engine, AppError, blankDraft, object, text } from "./engine";
import { registerGeminiKanban } from "./kanban";
import { nativeTranscriptPath, threadMessageMatch, turnOccurrences } from "./search";
import { listGeminiSkills, resolveGeminiSkillPath, syncNativeSkillsConfig } from "./skills";
import {
  GeminiVoiceJobs,
  GeminiVoiceService,
  MAX_TRANSCRIPTION_BYTES,
  VoiceServiceError,
  type VoiceUploadQuery,
} from "./voice";

function equalToken(a: unknown, b: string) {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function draft(input: any): ThreadDraft {
  const value = object(input);
  if (
    typeof value.input !== "string" ||
    !Array.isArray(value.images) ||
    !Array.isArray(value.annotations)
  )
    throw new AppError("Invalid draft");
  return {
    ...value,
    input: value.input,
    images: value.images,
    annotations: value.annotations,
    goalMode: false,
    updatedAt: Date.now(),
  };
}

export interface BuildAppOptions {
  voice?: GeminiVoiceService;
  browserTimeouts?: Pick<BrowserExtensionOptions, "disconnectWaitMs" | "toolResponseMs">;
  appManager?: AppManager;
}

export async function buildApp(engine: Engine, options: BuildAppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024, forceCloseConnections: true });
  const { config } = engine;
  const appManager = options.appManager ?? new AppManager(config);
  const voice =
    options.voice ??
    new GeminiVoiceService({
      config,
      resolveEnv: async () => (engine.account.status().authenticated ? process.env : null),
      loadSettings: async () => engine.data.voiceSettings,
      saveSettings: async (settings) => {
        engine.data.voiceSettings = settings;
        await engine.save();
      },
      loadTimings: (profile) => engine.data.voiceTimings?.[profile],
      saveTimings: async (profile, samples) => {
        (engine.data.voiceTimings ??= {})[profile] = samples;
        await engine.save();
      },
    });
  await voice.readSettings();
  const voiceJobs = new GeminiVoiceJobs(engine, voice);
  await voiceJobs.initialize();
  await syncNativeSkillsConfig(config.nativeDir, engine.data.skillOverrides ?? {}).catch(
    () => undefined,
  );

  await app.register(cors, {
    origin: (origin, cb) =>
      cb(
        null,
        !origin || origin === GEMINI_BROWSER_EXTENSION_ORIGIN || config.allowedOrigins.has(origin),
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
  const browser = new BrowserExtensionServer({
    app,
    engine,
    config,
    ...options.browserTimeouts,
  });
  browser.registerRoutes();
  await registerGeminiKanban(app, engine, voice);

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof VoiceServiceError) {
      return reply.code(error.statusCode).send({
        error: { code: error.kind, message: error.message },
      });
    }
    if (error instanceof BrowserExtensionError) {
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "not_writable"
            ? 400
            : error.code === "disconnected"
              ? 503
              : 409;
      return reply.code(status).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof AttachmentTooLargeError) {
      return reply.code(413).send({
        error: { code: "payload_too_large", message: error.message },
      });
    }
    if (error instanceof AttachmentValidationError) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: error.message },
      });
    }
    const status =
      (error as { statusCode?: number }).statusCode ??
      ((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500);
    reply.code(status).send({
      error: {
        code:
          error instanceof AppError ? error.code : status === 404 ? "not_found" : "internal_error",
        message:
          error instanceof AppError
            ? error.message
            : "Не удалось выполнить действие GeminiNest. Проверьте настройки и повторите попытку.",
      },
    });
  });
  const downloads = new Map<string, { path: string; name: string; expires: number }>();
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  });
  app.addHook("onRequest", async (req, reply) => {
    if (
      req.headers.origin &&
      req.headers.origin !== GEMINI_BROWSER_EXTENSION_ORIGIN &&
      !config.allowedOrigins.has(req.headers.origin)
    )
      return reply.code(403).send({ error: { code: "forbidden", message: "Origin not allowed" } });
    if (req.method === "OPTIONS") return;
    const path = req.url.split("?")[0];
    if (
      !path?.startsWith("/api/") ||
      path === "/api/v1/ui/events" ||
      path === BROWSER_EXTENSION_WEBSOCKET_PATH ||
      path.startsWith("/api/v1/internal/browser-mcp/") ||
      path.startsWith("/api/v1/downloads/")
    )
      return;
    if (
      path.startsWith("/api/v1/internal/") &&
      req.socket.remoteAddress &&
      !isLoopbackAddress(req.socket.remoteAddress)
    ) {
      return reply.code(403).send({ error: { code: "forbidden", message: "Internal route" } });
    }
    if (!equalToken(/^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1], config.token))
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Authentication required" } });
  });
  app.get("/api/v1/health", () => ({
    status: "ok",
    app: "gemininest",
    provider: "gemini",
    serverVersion: config.version,
    recoveryState: engine.accepting ? "ready" : "draining",
    releasePath: config.releasePath,
    restartProtocolVersion: 1,
    transport: "daemon",
    activeTurnCount: engine.activeCount,
    appServer: { state: "ready", installedVersion: engine.account.cliVersion, message: null },
  }));
  app.get("/api/v1/settings/app", () => appManager.status());
  app.post("/api/v1/settings/app/check", () => appManager.check());
  app.post("/api/v1/settings/app/update", () => appManager.update());
  app.post("/api/v1/settings/app/force-restart", async (_req, reply) =>
    reply.code(202).send(await appManager.forceRestart()),
  );
  app.post("/api/v1/internal/restart/prepare", async (req) => {
    const body = req.body ? object(req.body) : {};
    if (
      body.supportedRunnerProtocols !== undefined &&
      (!Array.isArray(body.supportedRunnerProtocols) ||
        !body.supportedRunnerProtocols.every(Number.isInteger))
    )
      throw new AppError("invalid_request", "supportedRunnerProtocols must be an integer array");
    return engine.prepareRestart(body.supportedRunnerProtocols);
  });
  app.post("/api/v1/internal/restart/resume", async () => {
    engine.resumeAccepting();
    return { resumed: true };
  });
  app.get("/api/v1/summary", () => ({
    threadCount: Object.keys(engine.data.threads).length,
    projectCount: engine.data.projects.length,
    pendingAttentionCount: engine.snapshot().attention.length,
    syncedAt: new Date().toISOString(),
  }));
  app.get("/api/v1/settings/gemini", () => engine.account.status());
  app.put("/api/v1/settings/gemini/proxy", async (req) => {
    const value = text(object(req.body).proxy, "proxy", 4096);
    try {
      return await engine.reconfigure(() => engine.account.setProxy(value));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("Не удалось сохранить прокси. Проверьте адрес и завершите текущий вход.");
    }
  });
  app.post("/api/v1/settings/gemini/proxy/test", () => engine.account.testProxy());
  app.post("/api/v1/settings/gemini/logins", async () => {
    try {
      return await engine.reconfigure(() => engine.account.startLogin());
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "Не удалось запустить вход. Настройте прокси и проверьте установку Antigravity CLI.",
      );
    }
  });
  app.post<{ Params: { id: string } }>("/api/v1/settings/gemini/logins/:id/code", (req) => {
    try {
      return engine.account.submitCode(req.params.id, text(object(req.body).code, "code", 16_000));
    } catch {
      throw new AppError("Запрос входа закрыт или код некорректен. Начните вход заново.");
    }
  });
  app.delete("/api/v1/settings/gemini/logins/current", () =>
    engine.reconfigure(() => engine.account.cancelLogin()),
  );
  app.get("/api/v1/settings/permissions", () => engine.permissions());
  app.put("/api/v1/settings/permissions", async (req) => {
    const body = object(req.body);
    if (!["ask", "full-access"].includes(body.preset))
      throw new AppError("Выберите подтверждения или полный доступ.");
    if (body.expectedVersion && body.expectedVersion !== String(engine.data.permissionVersion))
      throw new AppError("Настройки изменились. Обновите страницу.", 409, "conflict");
    engine.data.permission = body.preset;
    engine.data.permissionVersion++;
    await engine.save();
    engine.publish({ type: "permissions.changed", permissionSettings: engine.permissions() });
    return engine.permissions();
  });
  app.put("/api/v1/settings/task-defaults", async (req) => {
    const body = object(req.body);
    for (const key of [
      "model",
      "reasoningEffort",
      "titleModel",
      "classificationModel",
      "replyCheckModel",
    ] as const)
      if (Object.hasOwn(body, key)) {
        if (body[key] === null) delete engine.data.taskDefaults[key];
        else engine.data.taskDefaults[key] = text(body[key], key, 200);
      }
    if (Object.hasOwn(body, "classifyTasks")) {
      if (body.classifyTasks === null) delete engine.data.taskDefaults.classifyTasks;
      else if (typeof body.classifyTasks === "boolean")
        engine.data.taskDefaults.classifyTasks = body.classifyTasks;
      else throw new AppError("Invalid classifyTasks");
    }
    await engine.save();
    engine.publish({ type: "taskDefaults.changed", taskDefaults: engine.data.taskDefaults });
    return engine.data.taskDefaults;
  });
  app.put("/api/v1/settings/ui-language", async (req) => {
    const language = object(req.body).language;
    if (language !== "ru" && language !== "en") throw new AppError("Invalid language");
    engine.data.language = language;
    await engine.save();
    engine.publish({ type: "uiLanguage.changed", language });
    return { language };
  });
  for (const mediaType of ["audio/webm", "audio/mp4"] as const) {
    app.addContentTypeParser(
      mediaType,
      { parseAs: "buffer", bodyLimit: MAX_TRANSCRIPTION_BYTES },
      (_req, body, done) => done(null, body),
    );
  }
  app.get("/api/v1/transcriptions/config", () => voice.configuration());
  app.put("/api/v1/settings/transcription", (req) =>
    voice.updateConfiguration(req.body as UpdateTranscriptionSettingsRequest),
  );
  app.post<{
    Querystring: {
      provider?: string;
      language?: string;
      refine?: string;
      refinementModel?: string;
    };
  }>("/api/v1/transcriptions", { bodyLimit: MAX_TRANSCRIPTION_BYTES }, async (req) => {
    if (!Buffer.isBuffer(req.body))
      throw new AppError("invalid_request", "Audio recording is required");
    const durationHeader = req.headers["x-codexnest-audio-duration-ms"];
    const audioDurationMs =
      durationHeader !== undefined && durationHeader !== "" ? Number(durationHeader) : undefined;
    const provider = req.query.provider as TranscriptionProvider | undefined;
    if (provider !== undefined && provider !== "local" && provider !== "openai")
      throw new AppError("invalid_request", "Invalid transcription provider");
    const refineLocal =
      req.query.refine === "true" ? true : req.query.refine === "false" ? false : undefined;
    const transcript = await voice.transcribe(
      req.body,
      req.headers["content-type"] ?? "",
      undefined,
      {
        audioDurationMs,
        provider,
        language: req.query.language,
        refineLocal,
        refinementModel: req.query.refinementModel,
      },
    );
    return {
      text: transcript,
      timingEstimate: voice.configuration().timingEstimate,
    };
  });
  app.post<{ Params: { id: string }; Querystring: VoiceUploadQuery }>(
    "/api/v1/threads/:id/voice-transcriptions",
    { bodyLimit: MAX_TRANSCRIPTION_BYTES },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body))
        throw new AppError("invalid_request", "Audio recording is required");
      const audioDurationMs = Number(req.headers["x-codexnest-audio-duration-ms"]);
      return reply.code(202).send({
        job: await voiceJobs.create(
          req.params.id,
          req.body,
          req.headers["content-type"] ?? "",
          req.query,
          audioDurationMs,
        ),
      });
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/threads/:id/voice-transcriptions",
    async (req) => {
      await voiceJobs.cancel(req.params.id);
      return { cancelled: true };
    },
  );
  app.post<{ Params: { id: string; jobId: string } }>(
    "/api/v1/threads/:id/voice-transcriptions/:jobId/retry",
    async (req) => {
      await voiceJobs.retry(req.params.id, req.params.jobId);
      return { retried: true };
    },
  );
  app.get<{ Querystring: { cwd?: string; forceReload?: string } }>(
    "/api/v1/skills",
    async (req) => {
      const requestedCwd = req.query.cwd ? text(req.query.cwd, "cwd", 4096) : undefined;
      const defaultCwd = requestedCwd ?? engine.data.projects[0]?.path ?? config.configDir;
      return listGeminiSkills({
        cwd: defaultCwd,
        configDir: config.configDir,
        nativeDir: config.nativeDir,
        overrides: engine.data.skillOverrides,
      });
    },
  );
  app.put("/api/v1/skills/config", async (req) => {
    const body = object(req.body);
    if (typeof body.enabled !== "boolean")
      throw new AppError("invalid_request", "enabled must be a boolean");
    const targetPath = await resolveGeminiSkillPath({
      path: text(body.path, "path", 4096),
      cwd: body.cwd ? text(body.cwd, "cwd", 4096) : undefined,
      projectPaths: engine.data.projects.map((p) => p.path),
      threadCwds: Object.values(engine.data.threads).map((t) => t.detail.summary.cwd),
      configDir: config.configDir,
      nativeDir: config.nativeDir,
    });
    (engine.data.skillOverrides ??= {})[targetPath] = body.enabled;
    await syncNativeSkillsConfig(config.nativeDir, engine.data.skillOverrides);
    await engine.save();
    engine.publish({ type: "skills.changed" });
    return { path: targetPath, enabled: body.enabled };
  });

  async function directories(path?: string) {
    const root = homedir();
    const current = await realpath(path || root);
    const entries = await readdir(current, { withFileTypes: true });
    return {
      rootPath: root,
      path: current,
      parentPath: dirname(current) === current ? null : dirname(current),
      directories: entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, path: join(current, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  app.get<{ Querystring: { path?: string } }>("/api/v1/directories", (req) =>
    directories(req.query.path),
  );
  app.post("/api/v1/directories", async (req) => {
    const body = object(req.body);
    const name = text(body.name, "name", 200);
    if (!name || /[/\\\0]/.test(name) || name === "." || name === "..")
      throw new AppError("Invalid directory name");
    const parent = await realpath(text(body.parentPath, "parentPath", 4096));
    const path = join(parent, name);
    await mkdir(path);
    return directories(path);
  });
  app.get("/api/v1/projects", () => engine.data.projects);
  app.post("/api/v1/projects", (req) => {
    const b = object(req.body);
    return engine.addProject(
      text(b.path, "path", 4096),
      b.displayName === undefined ? undefined : text(b.displayName, "displayName", 200),
    );
  });
  app.delete<{ Params: { id: string } }>("/api/v1/projects/:id", async (req) => {
    engine.project(req.params.id);
    if (
      Object.values(engine.data.threads).some(
        (t) => t.detail.summary.projectId === req.params.id && t.detail.summary.currentTurnId,
      )
    )
      throw new AppError("В проекте выполняются задачи.", 409, "conflict");
    engine.data.projects = engine.data.projects.filter((p) => p.id !== req.params.id);
    for (const thread of Object.values(engine.data.threads))
      if (thread.detail.summary.projectId === req.params.id) {
        thread.detail.summary.projectId = null;
        engine.changed(thread.detail.summary.id);
      }
    await engine.save();
    engine.publish({ type: "project.removed", projectId: req.params.id });
    return { deleted: true };
  });
  app.post<{ Params: { id: string } }>("/api/v1/projects/:id/move", async (req) => {
    const project = engine.project(req.params.id);
    const body = object(req.body);
    const from = engine.data.projects.indexOf(project);
    const to = body.targetIndex ?? from + (body.direction === "up" ? -1 : 1);
    if (!Number.isInteger(to) || to < 0 || to >= engine.data.projects.length)
      throw new AppError("Invalid project position");
    engine.data.projects.splice(from, 1);
    engine.data.projects.splice(to, 0, project);
    await engine.save();
    engine.publish({ type: "projects.reordered", projects: engine.data.projects });
    return engine.data.projects;
  });
  app.post<{ Params: { id: string } }>("/api/v1/projects/:id/threads", (req) => {
    const body = object(req.body);
    return engine.createThread(
      req.params.id,
      text(body.clientCreationId, "clientCreationId", 200),
      body.draft ? draft(body.draft) : undefined,
    );
  });
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/draft", (req) => {
    engine.project(req.params.id);
    return engine.data.projectDrafts[req.params.id] ?? null;
  });
  app.put<{ Params: { id: string }; Querystring: { expectedUpdatedAt?: string } }>(
    "/api/v1/projects/:id/draft",
    async (req) => {
      engine.project(req.params.id);
      const body = object(req.body);
      const current = engine.data.projectDrafts[req.params.id] ?? blankDraft();
      const next = {
        ...mergeProjectDraft(current, draft(body.base), draft(body.value)),
        updatedAt: Date.now(),
      };
      engine.data.projectDrafts[req.params.id] = next;
      await engine.save();
      engine.publish({ type: "projectDraft.changed", projectId: req.params.id, draft: next });
      return next;
    },
  );
  app.get<{
    Querystring: { q?: string; archived?: string; scope?: string; cursor?: string };
  }>("/api/v1/threads/search", async (req) => {
    const q = text(req.query.q ?? "", "query", 500).trim();
    if (!q) return { data: [], nextCursor: null };
    const archived = req.query.archived === "true";
    const scope = req.query.scope === "messages" ? "messages" : "titles";
    if (scope !== "messages") {
      const needle = q.toLocaleLowerCase();
      return {
        data: Object.values(engine.data.threads)
          .filter(
            (t) =>
              t.detail.summary.archived === archived &&
              t.detail.summary.title.toLocaleLowerCase().includes(needle),
          )
          .sort((a, b) => b.detail.summary.updatedAt - a.detail.summary.updatedAt)
          .map((t) => ({
            thread: engine.summary(t.detail.summary.id),
            snippet: t.detail.summary.preview,
          })),
        nextCursor: null,
      };
    }
    const offset = req.query.cursor ? Number.parseInt(req.query.cursor, 10) : 0;
    if (!Number.isInteger(offset) || offset < 0)
      throw new AppError("invalid_request", "Invalid search cursor");
    const candidates = Object.values(engine.data.threads)
      .filter((t) => t.detail.summary.archived === archived)
      .sort((a, b) => b.detail.summary.updatedAt - a.detail.summary.updatedAt);
    const matches: Array<{
      thread: ReturnType<Engine["summary"]>;
      snippet: string;
      turnId?: string;
    }> = [];
    for (const candidate of candidates) {
      const match = await threadMessageMatch(
        candidate.detail.turns,
        config.nativeDir,
        candidate.nativeId,
        q,
      );
      if (match) {
        matches.push({
          thread: engine.summary(candidate.detail.summary.id),
          snippet: match.snippet,
          turnId: match.turnId,
        });
      }
    }
    const pageSize = 50;
    const slice = matches.slice(offset, offset + pageSize);
    return {
      data: slice,
      nextCursor: offset + pageSize < matches.length ? String(offset + pageSize) : null,
    };
  });
  app.get<{ Params: { id: string }; Querystring: { q?: string; cursor?: string } }>(
    "/api/v1/threads/:id/search",
    (req) => {
      const detail = engine.detail(req.params.id);
      const q = text(req.query.q ?? "", "query", 500).trim();
      const offset = req.query.cursor === undefined ? 0 : Number(req.query.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new AppError("invalid_request", "Invalid search cursor");
      const occurrences = q ? turnOccurrences(detail.turns, q) : [];
      const pageSize = 20;
      return {
        data: occurrences.slice(offset, offset + pageSize),
        nextCursor: offset + pageSize < occurrences.length ? String(offset + pageSize) : null,
      };
    },
  );
  app.get<{ Params: { id: string; turnId: string } }>(
    "/api/v1/threads/:id/turns/:turnId",
    (req) => {
      const detail = engine.detail(req.params.id);
      const turn = detail.turns.find((t) => t.id === req.params.turnId);
      if (!turn) throw new AppError("not_found", "Turn not found", 404);
      return {
        instanceId: engine.instanceId,
        turn,
      };
    },
  );
  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/history", (req) => {
    const detail = engine.detail(req.params.id);
    return {
      instanceId: engine.instanceId,
      anchorTurnId: detail.turns[0]?.id ?? "",
      turns: [],
      olderTurnsCursor: null,
    };
  });
  app.get<{ Params: { id: string; turnId: string } }>(
    "/api/v1/threads/:id/turns/:turnId/items",
    (req) => {
      const detail = engine.detail(req.params.id);
      const turn = detail.turns.find((t) => t.id === req.params.turnId);
      if (!turn) throw new AppError("not_found", "Turn not found", 404);
      return {
        threadId: req.params.id,
        turnId: req.params.turnId,
        items: turn.items,
      };
    },
  );
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/compact", async (req, reply) => {
    await engine.send(req.params.id, {
      input: "/compact",
      clientMessageId: `compact:${randomUUID()}`,
    });
    return reply.code(202).send({ compacted: true });
  });
  app.get<{ Params: { id: string } }>("/api/v1/threads/:id", (req) => engine.detail(req.params.id));
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/refresh", (req) => ({
    snapshot: engine.snapshot(),
    detail: engine.detail(req.params.id),
  }));
  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/reference", async (req) => {
    const thread = engine.thread(req.params.id);
    return {
      threadId: thread.nativeId || req.params.id,
      cwd: thread.detail.summary.cwd,
      historyPath: await nativeTranscriptPath(config.nativeDir, thread.nativeId),
    };
  });
  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/git-changes", (req) =>
    readGitChanges(engine.thread(req.params.id).detail.summary.cwd),
  );
  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/artifacts", async (req) => {
    const thread = engine.thread(req.params.id);
    const resolved = await resolveGeminiSessionArtifacts({
      cwd: thread.detail.summary.cwd,
      nativeDir: config.nativeDir,
      nativeId: thread.nativeId,
      stored: thread.artifacts,
      latestTurnId: thread.detail.turns.at(-1)?.id ?? null,
    });
    return {
      capability: "explicit" as const,
      artifacts: resolved.artifacts,
    };
  });
  app.patch<{ Params: { id: string } }>("/api/v1/threads/:id/settings", (req) =>
    engine.settings(req.params.id, object(req.body)),
  );
  app.patch<{ Params: { id: string } }>("/api/v1/threads/:id", async (req) => {
    const body = object(req.body);
    if (typeof body.browserEnabled === "boolean") {
      if (body.browserEnabled) await browser.enableThread(req.params.id);
      else await browser.disableThread(req.params.id);
    }
    const hasMetaPatch =
      body.title !== undefined || typeof body.pinned === "boolean" || body.projectId !== undefined;
    if (hasMetaPatch) {
      return engine.patchThread(req.params.id, {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      });
    }
    return engine.summary(req.params.id);
  });
  app.delete<{ Params: { id: string } }>("/api/v1/threads/:id/browser-binding", (req) =>
    browser.detachThread(req.params.id),
  );
  for (const action of ["archive", "unarchive"] as const)
    app.post<{ Params: { id: string } }>(`/api/v1/threads/:id/${action}`, (req) =>
      engine.patchThread(req.params.id, { archived: action === "archive" }),
    );
  for (const action of ["read", "viewed"] as const)
    app.put<{ Params: { id: string } }>(`/api/v1/threads/:id/${action}`, async (req) => {
      const summary = engine.thread(req.params.id).detail.summary;
      if (object(req.body).observedUpdatedAt >= summary.updatedAt) {
        summary.unseen = false;
        if (action === "read") summary.unread = false;
      }
      await engine.save();
      engine.changed(summary.id);
      return summary;
    });
  app.put<{ Params: { id: string }; Querystring: { expectedUpdatedAt?: string } }>(
    "/api/v1/threads/:id/draft",
    async (req) => {
      const detail = engine.thread(req.params.id).detail;
      if (
        req.query.expectedUpdatedAt !== undefined &&
        (req.query.expectedUpdatedAt === "none" ? null : Number(req.query.expectedUpdatedAt)) !==
          (detail.draft?.updatedAt ?? null)
      )
        throw new AppError("Черновик изменился на другом устройстве.", 409, "draft_conflict");
      detail.draft = draft(req.body);
      await engine.save();
      return detail.draft;
    },
  );
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/turns", async (req) => {
    await engine.send(req.params.id, object(req.body) as QueueMessageRequest);
    return { turnId: engine.thread(req.params.id).detail.summary.currentTurnId };
  });
  for (const action of ["queue", "steer"] as const)
    app.post<{ Params: { id: string } }>(`/api/v1/threads/:id/${action}`, (req) =>
      engine.send(req.params.id, object(req.body) as QueueMessageRequest, action === "queue"),
    );
  app.post<{ Params: { id: string; messageId: string } }>(
    "/api/v1/threads/:id/queue/:messageId/send",
    async (req) => {
      await engine.sendQueued(req.params.id, req.params.messageId);
      const detail = engine.detail(req.params.id);
      return {
        turnId: detail.summary.currentTurnId ?? detail.turns.at(-1)?.id,
        thread: detail.summary,
      };
    },
  );
  app.delete<{ Params: { id: string; messageId: string } }>(
    "/api/v1/threads/:id/queue/:messageId",
    async (req) => {
      const detail = engine.thread(req.params.id).detail;
      const message = detail.queuedMessages.find((m) => m.id === req.params.messageId);
      if (message?.status === "dispatching" && !message.deliveryError)
        throw new AppError("Сообщение уже отправляется.", 409, "conflict");
      detail.queuedMessages = detail.queuedMessages.filter((m) => m.id !== req.params.messageId);
      await engine.save();
      engine.changed(req.params.id);
      return { deleted: true };
    },
  );
  app.patch<{ Params: { id: string; messageId: string } }>(
    "/api/v1/threads/:id/queue/:messageId",
    async (req) => {
      const message = engine
        .thread(req.params.id)
        .detail.queuedMessages.find((m) => m.id === req.params.messageId);
      if (!message || message.status !== "queued")
        throw new AppError("Сообщение уже отправлено.", 409, "conflict");
      const body = object(req.body);
      const input = text(body.input);
      if (!validPastedText(body, input)) throw new AppError("Invalid pasted input");
      if (!input.trim() && !message.files?.length && !message.images?.length)
        throw new AppError("Введите сообщение.");
      message.text = input;
      delete message.pasteBlocks;
      delete message.inlinePastes;
      Object.assign(message, pastedText(body));
      await engine.save();
      engine.changed(req.params.id);
      return message;
    },
  );
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/interrupt", (req) => {
    engine.cancel(req.params.id);
    return { interrupted: true };
  });
  app.post<{ Params: { id: string } }>("/api/v1/attention/:id/respond", (req) => {
    engine.respond(req.params.id, object(req.body) as AttentionResponse);
    return { accepted: true };
  });
  app.put<{ Params: { id: string } }>("/api/v1/attention/:id/draft", async (req) => {
    const body = object(req.body) as UpdateUserInputDraftRequest;
    const previous = engine.data.userInputDrafts?.[req.params.id];
    const saved = {
      answers: body.answers ?? {},
      currentQuestionId: body.currentQuestionId ?? null,
      ...(body.appliedRecordingIds ? { appliedRecordingIds: body.appliedRecordingIds } : {}),
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    (engine.data.userInputDrafts ??= {})[req.params.id] = saved;
    await engine.save();
    return saved;
  });
  app.addContentTypeParser("application/octet-stream", (_req, stream, done) => done(null, stream));
  for (const scope of ["projects", "threads"] as const)
    app.post<{ Params: { id: string }; Querystring: { name: string; mediaType: string } }>(
      `/api/v1/${scope}/:id/attachments`,
      { bodyLimit: 100 * 1024 * 1024 },
      (req) => {
        if (scope === "projects") engine.project(req.params.id);
        else engine.thread(req.params.id);
        return engine.attachments.save(
          req.params.id,
          req.query.name,
          req.query.mediaType,
          req.body as Readable,
          req.headers["content-length"] ? Number(req.headers["content-length"]) : undefined,
        );
      },
    );
  app.delete<{ Params: { id: string; attachmentId: string } }>(
    "/api/v1/threads/:id/attachments/:attachmentId",
    async (req) => {
      const used = Object.values(engine.thread(req.params.id).receipts).some((receipt) =>
        receipt.message.files?.some((file) => file.id === req.params.attachmentId),
      );
      if (used) throw new AppError("Вложение уже отправлено в сессию.", 409, "conflict");
      await engine.attachments.remove(req.params.id, req.params.attachmentId);
      return { deleted: true };
    },
  );
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/downloads", async (req) => {
    const thread = engine.thread(req.params.id);
    const path = await realpath(text(object(req.body).path, "path", 4096));
    const cwd = await realpath(thread.detail.summary.cwd);
    const nested = relative(cwd, path);
    const attachment = await engine.attachments.resolveDownload(req.params.id, path);
    const brainArtifact = await isAuthorizedBrainArtifactPath(
      config.nativeDir,
      thread.nativeId,
      path,
    );
    if (
      !attachment &&
      !brainArtifact &&
      (nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested))
    )
      throw new AppError("Файл находится вне каталога задачи.", 403, "forbidden");
    const info = await stat(path);
    if (!info.isFile()) throw new AppError("Выберите файл.");
    const ticket = randomUUID();
    downloads.set(ticket, { path, name: basename(path), expires: Date.now() + 60_000 });
    for (const [id, item] of downloads) if (item.expires < Date.now()) downloads.delete(id);
    return {
      downloadUrl: `/api/v1/downloads/${ticket}`,
      expiresAt: Date.now() + 60_000,
      fileName: basename(path),
      size: info.size,
    };
  });
  app.get<{ Params: { ticket: string } }>("/api/v1/downloads/:ticket", async (req, reply) => {
    const file = downloads.get(req.params.ticket);
    if (!file || file.expires < Date.now()) throw new AppError("Ссылка истекла.", 404, "not_found");
    if ((await realpath(file.path)) !== file.path)
      throw new AppError("Файл изменился. Запросите новую ссылку.", 409, "conflict");
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .header("Cache-Control", "no-store")
      .send(createReadStream(file.path));
  });
  app.get("/api/v1/ui/events", { websocket: true }, (socket) => {
    let authenticated = false;
    const send = (value: unknown) => {
      const line = JSON.stringify(value);
      if (socket.bufferedAmount + Buffer.byteLength(line) > 16 * 1024 * 1024) {
        socket.close(1013, "Reconnect");
        return;
      }
      if (socket.readyState === 1) socket.send(line);
    };
    const timer = setTimeout(() => socket.close(1008, "Authentication timeout"), 5000);
    const onFrame = (frame: unknown) => {
      if (authenticated) send(frame);
    };
    engine.on("frame", onFrame);
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (!authenticated) {
          if (message.type !== "authenticate" || !equalToken(message.token, config.token)) {
            socket.close(1008, "Authentication required");
            return;
          }
          authenticated = true;
          clearTimeout(timer);
          send({ type: "snapshot", snapshot: engine.snapshot() });
        } else if (message.type === "ping") send({ type: "pong" });
      } catch {
        socket.close(1008, "Invalid message");
      }
    });
    socket.once("close", () => {
      clearTimeout(timer);
      engine.off("frame", onFrame);
    });
  });
  if (
    await stat(config.clientDist).then(
      (s) => s.isDirectory(),
      () => false,
    )
  ) {
    await app.register(fastifyStatic, { root: config.clientDist, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: { code: "not_found", message: "Unknown API route" } })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    await voiceJobs.close();
  });
  return app;
}
