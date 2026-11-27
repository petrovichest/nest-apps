import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import type {
  CreateForkOperationRequest,
  ForkModeEstimate,
  ForkOperationDetailResponse,
  ForkOperationResponse,
  ForkOperationSummary,
  ForkThreadRequest,
  QueueMessageRequest,
  UpdateQueuedMessageRequest,
  UpdateThreadDraftRequest,
} from "@codexnest/protocol";
import { readOpenRouterKey } from "../../claude-server/src/openrouter-gateway";
import { AppError, record, stableUuid, type RpcMessage } from "../../claude-server/src/types";
import type { UiService } from "../../claude-server/src/ui-service";
import {
  findForkOperation,
  forkOperation,
  forkTarget,
  touchFork,
  type UiForkOperation,
  type UiThread,
} from "../../claude-server/src/ui-store";
import {
  discardStagedClaudeFork,
  hasClaudeForkCompaction,
  installClaudeFork,
  readClaudeForkPoint,
  stageClaudeFork,
  syncClaudeFork,
} from "./claude-fork-history";

const COMPACTION_TIMEOUT_MS = 180_000;
const COMPACTION_FLUSH_MS = 5_000;

function idField(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 500)
    throw new AppError("invalid_request", `${name} is required`);
  return value;
}

function forkPoint(body: Record<string, unknown>): ForkThreadRequest {
  return {
    lastTurnId: idField(body.lastTurnId, "lastTurnId"),
    agentMessageId: idField(body.agentMessageId, "agentMessageId"),
  };
}

async function compactionUnavailable(ui: UiService, source: UiThread): Promise<string | null> {
  const profile = ui.manager.config.openRouter!;
  if (/^(?:1|true|yes|on)$/i.test(process.env.DISABLE_COMPACT ?? ""))
    return "Claude Code context compaction is disabled";
  const model = source.settings.model ?? profile.models.find((item) => item.isDefault)?.id;
  if (!profile.models.some((item) => item.id === model))
    return "Choose a supported OpenRouter model for context compression";
  return readOpenRouterKey(profile.keyFile).then(
    () => null,
    () => "Configure an OpenRouter key before compressing context",
  );
}

function exactEstimate(bytes: number): ForkModeEstimate {
  return {
    available: true,
    estimatedBytes: bytes,
    estimatedSeconds: null,
    unavailableReason: null,
  };
}

async function compressedEstimate(ui: UiService, source: UiThread): Promise<ForkModeEstimate> {
  const unavailableReason = await compactionUnavailable(ui, source);
  return {
    available: !unavailableReason,
    estimatedBytes: null,
    estimatedSeconds: null,
    unavailableReason,
  };
}

type ForkIdentity = Omit<CreateForkOperationRequest, "operationId"> & { sourceThreadId: string };

function matches(left: ForkIdentity, right: ForkIdentity): boolean {
  return (
    left.sourceThreadId === right.sourceThreadId &&
    left.lastTurnId === right.lastTurnId &&
    left.agentMessageId === right.agentMessageId &&
    left.mode === right.mode
  );
}

async function awaitCompaction(
  ui: UiService,
  targetId: string,
  shutdown: AbortSignal,
): Promise<boolean> {
  const owner = await ui.manager.subscribe(targetId).catch(() => undefined);
  if (!owner) {
    if (await ui.manager.launcher.active(targetId))
      throw new AppError("unavailable", "The fork owner is unreachable; retry to reconcile", 503);
    return false;
  }
  try {
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(COMPACTION_TIMEOUT_MS)]);
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const done = (error?: unknown) => {
        signal.removeEventListener("abort", abort);
        owner.off("message", message);
        owner.off("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const abort = () =>
        done(
          new AppError(
            "unavailable",
            "Native compaction has not finished; retry to reconcile",
            503,
          ),
        );
      const closed = () =>
        done(new AppError("unavailable", "The fork owner disconnected; retry to reconcile", 503));
      const settled = (state: unknown, awaiting: unknown) =>
        state === "failed" ||
        state === "closed" ||
        ((state === "idle" || state === "interrupted") && awaiting !== true);
      const message = (frame: RpcMessage) => {
        if ("snapshot" in frame && settled(frame.snapshot.state, frame.snapshot.awaitingResult))
          done();
        else if ("event" in frame && frame.event.kind === "state") {
          const data = record(frame.event.data);
          if (settled(data.state, data.awaitingResult)) done();
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      owner.on("message", message);
      owner.once("close", closed);
      void owner.request("subscribe", {}).catch(done);
    });
  } finally {
    owner.close();
  }
  return true;
}

export function registerClaudeForkRoutes(app: FastifyInstance, ui: UiService) {
  const shutdown = new AbortController();
  const running = new Map<string, Promise<void>>();
  const removing = new Set<string>();
  const admissions = new Map<
    string,
    { identity: ForkIdentity; result: Promise<ForkOperationResponse> }
  >();
  const get = (id: string) => forkOperation(ui.store.data, id);
  const accepting = () => {
    if (!ui.manager.accepting)
      throw new AppError("unavailable", "OpenNest is preparing a restart", 503);
  };
  const change = async (id: string, update: (fork: UiForkOperation) => void) => {
    await ui.store.update((data) => {
      shutdown.signal.throwIfAborted();
      const fork = forkOperation(data, id);
      update(fork);
      touchFork(fork);
    });
    ui.publishForkOperation(id);
  };

  const execute = async (id: string) => {
    try {
      const fork = get(id);
      const target = fork.pending!;
      await installClaudeFork(fork.transcriptPath, fork.prefixBytes);
      shutdown.signal.throwIfAborted();
      if (fork.summary.mode === "compressed") {
        const checkNative = () =>
          hasClaudeForkCompaction(fork.transcriptPath, target.id, fork.prefixBytes);
        const requestId = stableUuid(`opennest-fork-compact:${target.id}`);
        if (!(await checkNative())) {
          accepting();
          const refusal = await compactionUnavailable(ui, target);
          if (refusal) throw new AppError("conflict", refusal, 409);
          await change(id, (stored) => {
            stored.summary.stage = "compacting";
          });
          shutdown.signal.throwIfAborted();
          // SessionManager and the native owner share this durable command ID. A lost response
          // can be reconciled with the same ID, even after the process that accepted it exits.
          await ui.manager
            .send(target.id, requestId, "/compact", undefined, {
              model: target.settings.model,
              endpoint: target.settings.openRouterEndpoint,
              effort: target.settings.reasoningEffort,
              permissionMode: ui.permissionMode(target),
            })
            .catch((error: unknown) => {
              if (!(error instanceof AppError)) throw error;
            });
        }
        const live = await awaitCompaction(ui, target.id, shutdown.signal);
        // Claude can finish the stream before its asynchronous JSONL writer flushes the summary.
        const deadline = Date.now() + (live ? COMPACTION_FLUSH_MS : 0);
        while (!(await checkNative())) {
          if (Date.now() >= deadline)
            throw new AppError(
              "conflict",
              "Claude Code did not confirm a compact context. Check the model and compaction settings. An accepted command will not be sent again.",
              409,
            );
          await delay(100, undefined, { signal: shutdown.signal });
        }
        await syncClaudeFork(fork.transcriptPath);
      }
      await ui.store.update((data) => {
        shutdown.signal.throwIfAborted();
        const stored = forkOperation(data, id);
        const child = stored.pending!;
        if (data.threads[child.id]) throw new Error("Fork target already exists");
        if (!data.projects.some((project) => project.id === child.projectId))
          child.projectId = null;
        data.threads[child.id] = child;
        delete stored.pending;
        stored.summary.status = "ready";
        stored.summary.stage = null;
        stored.summary.targetThreadId = child.id;
        stored.summary.error = null;
        touchFork(stored);
      });
      ui.publish({ type: "thread.upserted", thread: ui.summary(target.id) });
      ui.publishForkOperation(id);
      if (ui.thread(target.id).queue.length) ui.schedule(target.id);
    } catch (error) {
      if (shutdown.signal.aborted) return;
      await change(id, (stored) => {
        stored.summary.status = "failed";
        stored.summary.stage = null;
        stored.summary.error =
          error instanceof AppError ? error.message : "The native fork could not be materialized";
      });
    }
  };

  const run = (id: string) => {
    if (running.has(id) || shutdown.signal.aborted) return;
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => {
        if (!shutdown.signal.aborted) return execute(id);
      })
      .catch(() => {
        process.stderr.write("OpenNest could not persist fork operation status.\n");
      })
      .finally(() => running.delete(id));
    running.set(id, task);
  };

  const admit = async (operationId: string, body: ForkIdentity): Promise<ForkOperationResponse> => {
    if (removing.has(operationId))
      throw new AppError("conflict", "The fork operation is being removed", 409);
    const source = body.sourceThreadId;
    const prior = findForkOperation(ui.store.data, operationId);
    if (prior) {
      if (prior.removed || !matches(prior.summary, body))
        throw new AppError("conflict", "operationId has already been used", 409);
      if (prior.summary.status === "failed" && !running.has(operationId)) {
        accepting();
        await change(operationId, (stored) => {
          stored.summary.status = "reconciling";
          stored.summary.error = null;
        });
      }
      if (["preparing", "reconciling"].includes(get(operationId).summary.status)) run(operationId);
      return { operation: get(operationId).summary };
    }

    accepting();
    const point = await readClaudeForkPoint(ui, source, body);
    const selected =
      body.mode === "exact"
        ? exactEstimate(point.bytes)
        : await compressedEstimate(ui, point.source);
    if (!selected.available) throw new AppError("conflict", selected.unavailableReason!, 409);
    const title = `${point.source.title} · fork`;
    const target = ui.createForkTarget(point.source, title, point.uuid);
    const native = await stageClaudeFork(ui, point, target.id);
    const now = Date.now();
    const summary: ForkOperationSummary = {
      id: operationId,
      sourceThreadId: source,
      lastTurnId: body.lastTurnId,
      agentMessageId: body.agentMessageId,
      mode: body.mode,
      title,
      status: "preparing",
      stage: "copying",
      targetThreadId: null,
      queuedMessageCount: 0,
      estimate: selected,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    // Retain the frozen prefix if metadata persistence fails after its rename.
    await ui.store.update((data) => {
      data.forkOperations = {
        ...data.forkOperations,
        [operationId]: { summary, targetId: target.id, pending: target, ...native },
      };
    });
    ui.publishForkOperation(operationId);
    run(operationId);
    return { operation: summary };
  };

  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/fork-estimate", async (request) => {
    const body = record(request.body);
    if (Object.keys(body).some((key) => !["lastTurnId", "agentMessageId"].includes(key)))
      throw new AppError("invalid_request", "Unknown fork field");
    const point = await readClaudeForkPoint(ui, request.params.id, forkPoint(body));
    return {
      sourceBytes: point.bytes,
      exact: exactEstimate(point.bytes),
      compressed: await compressedEstimate(ui, point.source),
    };
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/threads/:id/fork-operations",
    async (request, reply) => {
      const input = record(request.body);
      if (
        Object.keys(input).some(
          (key) => !["operationId", "lastTurnId", "agentMessageId", "mode"].includes(key),
        )
      )
        throw new AppError("invalid_request", "Unknown fork operation field");
      const operationId = idField(input.operationId, "operationId");
      const { mode } = input;
      if (mode !== "exact" && mode !== "compressed")
        throw new AppError("invalid_request", "mode must be compressed or exact");
      const identity = {
        ...forkPoint(input),
        mode,
        sourceThreadId: request.params.id.toLowerCase(),
      } satisfies ForkIdentity;
      const pending = admissions.get(operationId);
      if (pending) {
        if (!matches(pending.identity, identity))
          throw new AppError("conflict", "operationId has already been used", 409);
        return reply.code(202).send(await pending.result);
      }
      const result = admit(operationId, identity);
      admissions.set(operationId, { identity, result });
      try {
        return reply.code(202).send(await result);
      } finally {
        admissions.delete(operationId);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/fork-operations/:id",
    (request): ForkOperationDetailResponse => {
      const { id } = request.params;
      const stored = get(id);
      const target = forkTarget(ui.store.data, id);
      return {
        operation: stored.summary,
        draft: target.draft,
        queuedMessages: stored.pending
          ? target.queue.map((message) => ({ ...message, threadId: id }))
          : target.queue,
      };
    },
  );

  app.put<{ Params: { id: string }; Querystring: { expectedUpdatedAt?: string } }>(
    "/api/v1/fork-operations/:id/draft",
    (request) =>
      ui.setDraft(
        request.params.id,
        record(request.body) as UpdateThreadDraftRequest,
        request.query.expectedUpdatedAt,
        true,
      ),
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/fork-operations/:id/queue",
    async (request, reply) => {
      const body = record(request.body) as QueueMessageRequest;
      if (
        typeof body.input !== "string" ||
        (body.images !== undefined && !Array.isArray(body.images)) ||
        (body.files !== undefined && !Array.isArray(body.files))
      )
        throw new AppError("invalid_request", "Invalid queued message");
      return reply.code(202).send(await ui.enqueue(request.params.id, body, true));
    },
  );

  type QueueParams = { id: string; messageId: string };
  app.patch<{ Params: QueueParams }>("/api/v1/fork-operations/:id/queue/:messageId", (request) =>
    ui.updateQueued(
      request.params.id,
      request.params.messageId,
      record(request.body) as UpdateQueuedMessageRequest,
      true,
    ),
  );
  app.delete<{ Params: QueueParams }>(
    "/api/v1/fork-operations/:id/queue/:messageId",
    async (request, reply) => {
      await ui.deleteQueued(request.params.id, request.params.messageId, true);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/fork-operations/:id", async (request, reply) => {
    const { id } = request.params;
    const fork = get(id);
    if (
      fork.summary.status !== "failed" ||
      admissions.has(id) ||
      running.has(id) ||
      removing.has(id)
    )
      throw new AppError("conflict", "Only failed fork operations may be removed", 409);
    removing.add(id);
    try {
      if (fork.summary.mode === "compressed" && (await ui.manager.launcher.active(fork.targetId)))
        await ui.manager.stop(fork.targetId);
      await discardStagedClaudeFork(fork.transcriptPath);
      await ui.store.update((data) => {
        const stored = forkOperation(data, id);
        delete stored.pending;
        stored.removed = true;
      });
    } finally {
      removing.delete(id);
    }
    ui.publish({ type: "forkOperation.removed", operationId: id });
    return reply.code(204).send();
  });

  app.addHook("onListen", async () => {
    for (const fork of Object.values(ui.store.data.forkOperations ?? {}))
      if (!fork.removed && ["preparing", "reconciling"].includes(fork.summary.status))
        run(fork.summary.id);
  });
  app.addHook("preClose", async () => shutdown.abort());
  app.addHook("onClose", async () => {
    await Promise.allSettled(running.values());
  });
}
