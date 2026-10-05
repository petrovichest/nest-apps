import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AttentionResponse,
  QueueMessageRequest,
  SessionSettings,
  UpdateThreadDraftRequest,
  UpdateTranscriptionSettingsRequest,
  UpdateUserInputDraftRequest,
} from "@codexnest/protocol";
import type { UiService } from "./ui-service";
import { mergeProjectDraft, pastedText, validPastedText } from "@codexnest/protocol";
import { emptyDraft, validateDraft } from "./ui-service";
import { AppError, record, type ClaudePermissionMode } from "./types";
import { ClaudeVoiceService } from "./voice";
import { UiVoiceJobs } from "./ui-voice";

type Params = {
  id: string;
  messageId?: string;
  attachmentId?: string;
  turnId?: string;
  jobId?: string;
};
const params = (request: FastifyRequest) => request.params as Params;
const query = (request: FastifyRequest) => request.query as Record<string, string | undefined>;
function string(value: unknown, name: string, limit = 200_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new AppError("invalid_request", `${name} must be nonempty text`);
  return value;
}
function permission(mode: ClaudePermissionMode, version: number) {
  return {
    preset:
      mode === "bypassPermissions"
        ? ("full-access" as const)
        : mode === "acceptEdits"
          ? ("auto" as const)
          : ("ask" as const),
    version: String(version),
    overridden: false,
    message: null,
  };
}

export async function registerUiRoutes(
  app: FastifyInstance,
  ui: UiService,
): Promise<() => Promise<void>> {
  const voice = new ClaudeVoiceService({
    claudeBin: ui.manager.config.claudeBin,
    configDir: ui.manager.config.configDir,
    loadSettings: async () => ui.store.data.voiceSettings,
    saveSettings: async (settings) => {
      await ui.store.update((data) => {
        data.voiceSettings = { ...settings };
      });
    },
  });
  await voice.readSettings();
  const jobs = new UiVoiceJobs(ui, voice);
  await jobs.initialize();
  const syncTranscriptions = new AbortController();
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) =>
    done(null, payload),
  );
  app.addContentTypeParser(
    /^audio\//,
    { parseAs: "buffer", bodyLimit: 24 * 1024 * 1024 },
    (_request, payload, done) => done(null, payload),
  );

  app.get("/api/v1/summary", async () => ({
    threadCount: ui.threadIds.length,
    projectCount: ui.store.data.projects.length,
    pendingAttentionCount: ui.attention().length,
    syncedAt: new Date().toISOString(),
  }));
  app.get("/api/v1/threads/search", async (request) => {
    const q = query(request),
      needle = (q.q ?? "").toLocaleLowerCase();
    if (q.scope && q.scope !== "titles")
      throw new AppError("invalid_request", "Claude prototype supports title search");
    return {
      data: ui.threadIds
        .map((id) => ui.summary(id))
        .filter(
          (thread) =>
            thread.archived === (q.archived === "true") &&
            thread.title.toLocaleLowerCase().includes(needle),
        )
        .map((thread) => ({ thread, snippet: thread.title })),
      nextCursor: null,
    };
  });
  app.get("/api/v1/settings/permissions", async () =>
    permission(ui.store.data.permissionMode, ui.store.data.permissionVersion),
  );
  app.put("/api/v1/settings/permissions", async (request) => {
    const body = record(request.body),
      modes: Record<string, ClaudePermissionMode> = {
        ask: "manual",
        auto: "acceptEdits",
        "full-access": "bypassPermissions",
      };
    const mode = modes[String(body.preset)];
    if (!mode) throw new AppError("invalid_request", "Invalid permission preset");
    await ui.store.update((data) => {
      if (
        body.expectedVersion !== undefined &&
        body.expectedVersion !== String(data.permissionVersion)
      )
        throw new AppError("conflict", "Permission settings changed", 409);
      data.permissionMode = mode;
      data.permissionVersion++;
    });
    // Global preference applies to new CLI owners; live owner permission changes require explicit session controls.
    return permission(ui.store.data.permissionMode, ui.store.data.permissionVersion);
  });
  app.put("/api/v1/settings/task-defaults", async (request) => {
    const body = record(request.body);
    if (body.model && !ui.modelOptions().some((model) => model.id === body.model))
      throw new AppError("invalid_request", "Unknown Claude model");
    await ui.store.update((data) => {
      data.taskDefaults = { ...(typeof body.model === "string" ? { model: body.model } : {}) };
    });
    ui.publish({ type: "taskDefaults.changed", taskDefaults: ui.store.data.taskDefaults });
    return ui.store.data.taskDefaults;
  });
  app.put("/api/v1/settings/ui-language", async (request) => {
    const body = record(request.body);
    if (body.language !== "ru" && body.language !== "en")
      throw new AppError("invalid_request", "Invalid language");
    await ui.store.update((data) => {
      data.uiLanguage = body.language as "ru" | "en";
    });
    ui.publish({ type: "uiLanguage.changed", language: ui.store.data.uiLanguage });
    return { language: ui.store.data.uiLanguage };
  });
  const directories = async (path = homedir()) => {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory())
      throw new AppError("invalid_request", "Path must be a directory");
    const entries = await readdir(canonical, { withFileTypes: true });
    return {
      rootPath: "/",
      path: canonical,
      parentPath: canonical === "/" ? null : dirname(canonical),
      directories: entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => ({ name: entry.name, path: join(canonical, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  };
  app.get("/api/v1/directories", async (request) => directories(query(request).path));
  app.post("/api/v1/directories", async (request) => {
    const body = record(request.body),
      name = string(body.name, "name", 200);
    if (
      name === "." ||
      name === ".." ||
      /[/\\]/.test(name) ||
      [...name].some((character) => character.charCodeAt(0) < 32)
    )
      throw new AppError("invalid_request", "Invalid directory name");
    const parent = await realpath(string(body.parentPath, "parentPath", 4096));
    await mkdir(join(parent, name));
    return directories(join(parent, name));
  });
  app.post("/api/v1/projects", async (request) =>
    ui.createProject(string(record(request.body).path, "path", 4096)),
  );
  app.post("/api/v1/projects/:id/move", async (request) => {
    const id = params(request).id,
      body = record(request.body);
    ui.project(id);
    await ui.store.update((data) => {
      const index = data.projects.findIndex((project) => project.id === id),
        target = Number.isInteger(body.targetIndex)
          ? Number(body.targetIndex)
          : index + (body.direction === "up" ? -1 : 1);
      const [project] = data.projects.splice(index, 1);
      data.projects.splice(Math.max(0, Math.min(target, data.projects.length)), 0, project!);
    });
    ui.publish({ type: "projects.reordered", projects: ui.store.data.projects });
    return ui.store.data.projects;
  });
  app.delete("/api/v1/projects/:id", async (request, reply) => {
    const id = params(request).id;
    ui.project(id);
    await ui.store.update((data) => {
      data.projects = data.projects.filter((project) => project.id !== id);
      delete data.projectDrafts[id];
      for (const thread of Object.values(data.threads))
        if (thread.projectId === id) thread.projectId = null;
    });
    ui.publish({ type: "project.removed", projectId: id });
    for (const threadId of ui.threadIds)
      ui.publish({ type: "thread.upserted", thread: ui.summary(threadId) });
    return reply.code(204).send();
  });
  app.post("/api/v1/projects/:id/threads", async (request) => {
    const body = record(request.body);
    return ui.createThread(
      params(request).id,
      string(body.clientCreationId, "clientCreationId", 100),
      body.draft as UpdateThreadDraftRequest | undefined,
    );
  });
  app.get("/api/v1/projects/:id/draft", async (request) => {
    ui.project(params(request).id);
    return ui.store.data.projectDrafts[params(request).id] ?? null;
  });
  app.put("/api/v1/projects/:id/draft", async (request) => {
    const id = params(request).id;
    ui.project(id);
    const body = record(request.body),
      value = record(body.value) as UpdateThreadDraftRequest,
      base = record(body.base) as UpdateThreadDraftRequest;
    validateDraft(value);
    validateDraft(base);
    if (value.files?.length) await ui.attachments.validate(id, value.files);
    const draft = await ui.store.update((data) => {
      const prior = data.projectDrafts[id];
      const expected = query(request).expectedUpdatedAt;
      if (expected !== undefined && Number(expected) !== prior?.updatedAt)
        throw new AppError("conflict", "Project draft changed", 409);
      data.projectDrafts[id] = {
        ...mergeProjectDraft(prior ?? emptyDraft(), base, value),
        goalMode: false,
        updatedAt: Math.max(Date.now(), (prior?.updatedAt ?? 0) + 1),
      };
      return data.projectDrafts[id]!;
    });
    ui.publish({ type: "projectDraft.changed", projectId: id, draft });
    return draft;
  });
  for (const namespace of ["projects", "threads"])
    app.post(
      `/api/v1/${namespace}/:id/attachments`,
      { bodyLimit: 100 * 1024 * 1024 },
      async (request) => {
        const id = params(request).id;
        if (namespace === "projects") ui.project(id);
        else ui.thread(id);
        const q = query(request);
        return ui.attachments.save(
          id,
          string(q.name, "name", 1000),
          q.mediaType ?? "application/octet-stream",
          request.body as Readable,
          request.headers["content-length"] === undefined
            ? undefined
            : Number(request.headers["content-length"]),
        );
      },
    );
  app.delete("/api/v1/threads/:id/attachments/:attachmentId", async (request, reply) => {
    const p = params(request);
    ui.thread(p.id);
    const thread = ui.thread(p.id);
    if (thread.queue.some((message) => message.files?.some((file) => file.id === p.attachmentId)))
      throw new AppError("conflict", "Attachment is referenced by a queued message", 409);
    await ui.attachments.remove(p.id, p.attachmentId!);
    return reply.code(204).send();
  });
  app.get("/api/v1/threads/:id", async (request) => ui.detail(params(request).id));
  app.post("/api/v1/threads/:id/refresh", async (request) => ({
    detail: await ui.refresh(params(request).id),
    snapshot: ui.snapshot(),
  }));
  app.get("/api/v1/threads/:id/history", async (request) => {
    ui.thread(params(request).id);
    return { turns: [], olderTurnsCursor: null };
  });
  app.get("/api/v1/threads/:id/turns/:turnId/items", async (request) => {
    const p = params(request),
      detail = await ui.detail(p.id);
    return {
      threadId: p.id,
      turnId: p.turnId,
      items: detail.turns.find((turn) => turn.id === p.turnId)?.items ?? [],
    };
  });
  app.put("/api/v1/threads/:id/draft", async (request) =>
    ui.setDraft(
      params(request).id,
      record(request.body) as UpdateThreadDraftRequest,
      query(request).expectedUpdatedAt,
    ),
  );
  app.patch("/api/v1/threads/:id", async (request) => {
    const id = params(request).id;
    ui.thread(id);
    const body = record(request.body);
    await ui.store.update((data) => {
      const thread = data.threads[id]!;
      if (body.name !== undefined) thread.title = string(body.name, "name", 200);
      if (body.pinned !== undefined) {
        if (typeof body.pinned !== "boolean")
          throw new AppError("invalid_request", "Invalid pin value");
        thread.pinned = body.pinned;
      }
    });
    ui.publish({ type: "thread.upserted", thread: ui.summary(id) });
    return ui.summary(id);
  });
  app.patch("/api/v1/threads/:id/settings", async (request) =>
    ui.settings(params(request).id, record(request.body) as Partial<SessionSettings>),
  );
  for (const action of ["archive", "unarchive"])
    app.post(`/api/v1/threads/:id/${action}`, async (request) => {
      const id = params(request).id;
      ui.thread(id);
      await ui.store.update((data) => {
        data.threads[id]!.archived = action === "archive";
      });
      ui.publish({ type: "thread.upserted", thread: ui.summary(id) });
      return ui.summary(id);
    });
  for (const action of ["read", "viewed"])
    app.put(`/api/v1/threads/:id/${action}`, async (request, reply) => {
      const id = params(request).id;
      ui.thread(id);
      const observed = Number(record(request.body).observedUpdatedAt);
      await ui.store.update((data) => {
        const thread = data.threads[id]!;
        const value = Math.min(Number.isFinite(observed) ? observed : 0, thread.updatedAt);
        if (action === "read") thread.readAt = Math.max(thread.readAt, value);
        else thread.viewedAt = Math.max(thread.viewedAt, value);
      });
      ui.publish({ type: "thread.upserted", thread: ui.summary(id) });
      return reply.code(204).send();
    });
  app.post("/api/v1/threads/:id/queue", async (request, reply) =>
    reply
      .code(202)
      .send(await ui.enqueue(params(request).id, record(request.body) as QueueMessageRequest)),
  );
  app.post("/api/v1/threads/:id/turns", async (request, reply) => {
    const message = await ui.enqueue(
      params(request).id,
      record(request.body) as QueueMessageRequest,
    );
    return reply.code(202).send({
      turnId: message.id,
      deliveryReceipt: {
        version: 1,
        clientId: message.id,
        threadId: message.threadId,
        turnId: message.id,
      },
    });
  });
  app.patch("/api/v1/threads/:id/queue/:messageId", async (request) => {
    const p = params(request);
    ui.thread(p.id);
    const body = record(request.body);
    const text = typeof body.input === "string" ? body.input : string(body.input, "input");
    if (!validPastedText(body, text))
      throw new AppError("invalid_request", "Invalid pasted text metadata");
    const entry = await ui.store.update((data) => {
      const thread = data.threads[p.id]!,
        entry = thread.queue.find((item) => item.id === p.messageId);
      if (!entry) throw new AppError("not_found", "Queued message not found", 404);
      if (entry.status !== "queued" || entry.deliveryError)
        throw new AppError("conflict", "Cannot edit a message after dispatch began", 409);
      entry.text = text;
      delete entry.inlinePastes;
      delete entry.pasteBlocks;
      Object.assign(entry, pastedText(body));
      for (const value of Object.values(thread.deliveries))
        if (value.messageId === entry.id)
          value.fingerprint = createHash("sha256")
            .update(
              JSON.stringify({
                input: text,
                ...pastedText(entry),
                images: entry.images ?? [],
                files: entry.files ?? [],
              }),
            )
            .digest("hex");
      return entry;
    });
    ui.publishQueue(p.id);
    return entry;
  });
  app.delete("/api/v1/threads/:id/queue/:messageId", async (request, reply) => {
    const p = params(request);
    ui.thread(p.id);
    await ui.store.update((data) => {
      const thread = data.threads[p.id]!,
        entry = thread.queue.find((item) => item.id === p.messageId);
      if (
        entry?.status === "dispatching" ||
        (entry?.deliveryError && !entry.deliveryError.retryable)
      )
        throw new AppError("conflict", "Delivery outcome must be reconciled first", 409);
      thread.queue = thread.queue.filter((item) => item.id !== p.messageId);
    });
    ui.publishQueue(p.id);
    return reply.code(204).send();
  });
  app.post("/api/v1/threads/:id/queue/:messageId/send", async (request) => {
    const p = params(request);
    ui.thread(p.id);
    if (ui.summary(p.id).state === "running" || ui.summary(p.id).state === "needsAttention")
      throw new AppError("conflict", "Claude session is still running", 409);
    await ui.store.update((data) => {
      const queue = data.threads[p.id]!.queue,
        entry = queue.find((item) => item.id === p.messageId);
      if (!entry) throw new AppError("not_found", "Queued message not found", 404);
      if (entry.deliveryError && !entry.deliveryError.retryable)
        throw new AppError("conflict", "Unknown delivery must be reconciled before resending", 409);
      delete entry.deliveryError;
      entry.status = "queued";
      queue.splice(queue.indexOf(entry), 1);
      queue.unshift(entry);
    });
    ui.publishQueue(p.id);
    ui.schedule(p.id);
    return { turnId: p.messageId };
  });
  app.post("/api/v1/threads/:id/interrupt", async (request) => {
    const id = params(request).id;
    ui.thread(id);
    await ui.manager.command(id, "interrupt", { requestId: randomUUID() });
    return { interrupted: true };
  });
  app.post("/api/v1/attention/:id/respond", async (request, reply) => {
    await ui.respond(params(request).id, record(request.body) as AttentionResponse);
    return reply.code(204).send();
  });
  app.put("/api/v1/attention/:id/draft", async (request) => {
    const key = params(request).id;
    await ui.questionDraft(key, record(request.body) as UpdateUserInputDraftRequest);
    return ui.store.data.questionDrafts[key];
  });
  app.get("/api/v1/transcriptions/config", async () => voice.configuration());
  app.put("/api/v1/settings/transcription", async (request) =>
    voice.updateConfiguration(record(request.body) as UpdateTranscriptionSettingsRequest),
  );
  app.post("/api/v1/transcriptions", { bodyLimit: 24 * 1024 * 1024 }, async (request, reply) => {
    const disconnected = new AbortController();
    const abort = () => disconnected.abort(new Error("Recording request disconnected"));
    const close = () => {
      if (!reply.raw.writableFinished) abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", close);
    try {
      return {
        text: await voice.transcribe(
          request.body as Buffer,
          request.headers["content-type"] ?? "",
          AbortSignal.any([disconnected.signal, syncTranscriptions.signal]),
          {
            audioDurationMs: Number(request.headers["x-codexnest-audio-duration-ms"]) || undefined,
          },
        ),
        timingEstimate: voice.configuration().timingEstimate,
      };
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", close);
    }
  });
  app.post(
    "/api/v1/threads/:id/voice-transcriptions",
    { bodyLimit: 24 * 1024 * 1024 },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await jobs.create(
            params(request).id,
            request.body as Buffer,
            request.headers["content-type"] ?? "",
            query(request),
            Number(request.headers["x-codexnest-audio-duration-ms"]),
          ),
        ),
  );
  app.delete("/api/v1/threads/:id/voice-transcriptions", async (request, reply) => {
    await jobs.cancel(params(request).id);
    return reply.code(204).send();
  });
  app.post("/api/v1/threads/:id/voice-transcriptions/:jobId/retry", async (request, reply) => {
    await jobs.retry(params(request).id, params(request).jobId!);
    return reply.code(204).send();
  });
  const tickets = new Map<string, { path: string; fileName: string; expiresAt: number }>();
  app.post("/api/v1/threads/:id/downloads", async (request) => {
    const id = params(request).id;
    ui.thread(id);
    const download = await ui.attachments.resolveDownload(
      id,
      string(record(request.body).path, "path", 4096),
    );
    if (!download) throw new AppError("not_found", "Attachment not found", 404);
    for (const [key, value] of tickets) if (value.expiresAt <= Date.now()) tickets.delete(key);
    const ticket = randomUUID(),
      expiresAt = Date.now() + 60_000;
    tickets.set(ticket, { ...download, expiresAt });
    return {
      downloadUrl: `/downloads/${ticket}`,
      expiresAt,
      fileName: download.fileName,
      size: download.size,
    };
  });
  app.get("/downloads/:id", async (request, reply) => {
    const ticket = tickets.get(params(request).id);
    if (!ticket || ticket.expiresAt < Date.now())
      throw new AppError("not_found", "Download link expired", 404);
    reply.header("Cache-Control", "private, no-store");
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(ticket.fileName)}`,
    );
    return reply.send(createReadStream(ticket.path));
  });
  return async () => {
    syncTranscriptions.abort(new Error("ClaudeNest is restarting"));
    await jobs.close();
  };
}
