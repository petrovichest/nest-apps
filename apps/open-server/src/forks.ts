import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type {
  ForkOperationSummary,
  QueuedMessage,
  ThreadDraft,
  ThreadFileAttachment,
} from "@codexnest/protocol";
import { pastedText, validPastedText } from "@codexnest/protocol";
import { AppError, blankDraft, object, text, type Engine } from "./engine";

export type StoredFork = {
  summary: ForkOperationSummary;
  draft: ThreadDraft | null;
  queue: QueuedMessage[];
  fingerprint: string;
  cutoff?: string;
  expectedLatest?: string;
  files?: Record<string, ThreadFileAttachment>;
};
function estimate(bytes: number) {
  return {
    sourceBytes: bytes,
    exact: {
      available: true,
      estimatedBytes: bytes,
      estimatedSeconds: null,
      unavailableReason: null,
    },
    compressed: {
      available: true,
      estimatedBytes: null,
      estimatedSeconds: null,
      unavailableReason: null,
    },
  };
}
function draft(value: unknown): ThreadDraft {
  const input = object(value);
  if (
    typeof input.goalMode !== "boolean" ||
    !Array.isArray(input.images) ||
    !Array.isArray(input.annotations) ||
    !validPastedText(input, input.input)
  )
    throw new AppError("validation_failed", "Invalid draft");
  return {
    input: text(input.input),
    ...pastedText(input),
    images: input.images,
    annotations: input.annotations,
    ...(input.files?.length ? { files: input.files } : {}),
    goalMode: input.goalMode,
    updatedAt: Date.now(),
  };
}
export function registerForkRoutes(app: FastifyInstance, engine: Engine) {
  let closed = false;
  const running = new Map<string, Promise<void>>();
  const admissions = new Map<
    string,
    { fingerprint: string; promise: Promise<{ operation: ForkOperationSummary }> }
  >();
  const get = (id: string) => {
    const stored = engine.data.forkOperations?.[id];
    if (!stored) throw new AppError("not_found", "Fork operation not found", 404);
    return stored;
  };
  const publish = (stored: StoredFork) => {
    stored.summary.updatedAt = Date.now();
    engine.publish({ type: "forkOperation.upserted", operation: stored.summary });
  };
  const transferFiles = async (stored: StoredFork, files: ThreadFileAttachment[] | undefined) => {
    if (!files?.length) return undefined;
    const target = stored.summary.targetThreadId;
    if (!target) throw new AppError("conflict", "Native target is not ready", 409);
    const result: ThreadFileAttachment[] = [];
    for (const file of files) {
      const previous = stored.files?.[file.id];
      if (previous) {
        result.push(previous);
        continue;
      }
      const [validated] = await engine.attachments.validate(stored.summary.id, [file]);
      const copied = await engine.attachments.save(
        target,
        validated!.name,
        validated!.mediaType,
        createReadStream(validated!.path),
        validated!.size,
      );
      (stored.files ??= {})[file.id] = copied;
      await engine.save();
      result.push(copied);
    }
    return result;
  };
  const boundary = async (id: string, body: Record<string, any>) => {
    if (engine.isBusy(id))
      throw new AppError("conflict", "Finish the active turn before branching", 409);
    const detail = await engine.refreshThread(id);
    const turn = detail.turns.find((candidate) => candidate.id === body.lastTurnId);
    if (
      !turn ||
      turn.status === "inProgress" ||
      !turn.items.some(
        (item) =>
          item.id === body.agentMessageId &&
          item.type === "agentMessage" &&
          item.phase === "final_answer",
      )
    )
      throw new AppError("conflict", "The selected final answer is no longer available", 409);
    const messages = engine.nativeMessages(id);
    const index = messages.findIndex(
      (message) =>
        message.info.role === "assistant" &&
        message.parts.some((part) => part.id === body.agentMessageId),
    );
    if (index < 0) throw new AppError("conflict", "The native branch boundary is unavailable", 409);
    return {
      cutoff: messages[index + 1]?.info.id,
      expectedLatest: messages[index + 1] ? undefined : messages[index]?.info.id,
      bytes: Buffer.byteLength(JSON.stringify(messages.slice(0, index + 1))),
    };
  };
  const finalize = async (stored: StoredFork) => {
    if (!stored.summary.targetThreadId || closed) return;
    const target = stored.summary.targetThreadId;
    await engine.refreshThread(target);
    if (engine.isBusy(target)) return;
    stored.summary.status = "ready";
    stored.summary.stage = "materializing";
    stored.summary.error = null;
    if (stored.draft) {
      engine.thread(target).draft = {
        ...stored.draft,
        files: await transferFiles(stored, stored.draft.files),
      };
      stored.draft = null;
    }
    await engine.save();
    publish(stored);
    for (const message of [...stored.queue]) {
      await engine.send(
        target,
        {
          input: message.text,
          ...pastedText(message),
          images: message.images,
          files: await transferFiles(stored, message.files),
          clientMessageId: `fork:${stored.summary.id}:${message.id}`,
        },
        true,
      );
      stored.queue = stored.queue.filter((candidate) => candidate.id !== message.id);
      stored.summary.queuedMessageCount = stored.queue.length;
      await engine.save();
    }
    publish(stored);
  };
  const execute = async (stored: StoredFork) => {
    try {
      if (!stored.summary.targetThreadId) {
        const child = await engine.fork(
          stored.summary.sourceThreadId,
          stored.cutoff,
          stored.expectedLatest,
        );
        stored.summary.targetThreadId = child.id;
        stored.summary.stage = "materializing";
        await engine.save();
        publish(stored);
      }
      if (closed) return;
      if (stored.summary.mode === "compressed") {
        stored.summary.stage = "compacting";
        await engine.save();
        publish(stored);
        const child = engine.thread(stored.summary.targetThreadId!);
        const selected =
          child.summary.settings.model ||
          engine.models.find((model) => model.isDefault)?.id ||
          engine.models[0]?.id;
        if (!selected?.startsWith("openrouter/"))
          throw new AppError("validation_failed", "Choose a model for context compression");
        await engine.native.request(
          "POST",
          `/session/${encodeURIComponent(child.summary.id)}/summarize`,
          {
            directory: child.summary.cwd,
            body: {
              providerID: "openrouter",
              modelID: selected.slice("openrouter/".length),
              auto: false,
            },
            timeoutMs: 120_000,
          },
        );
      }
      await finalize(stored);
    } catch {
      if (closed) return;
      stored.summary.status = "failed";
      stored.summary.error =
        "The native fork could not be confirmed. Inspect the saved target before retrying; it will not be duplicated automatically.";
      await engine.save();
      publish(stored);
    }
  };
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/fork-estimate", async (request) =>
    estimate((await boundary(request.params.id, object(request.body))).bytes),
  );
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/fork-operations", async (request) => {
    const body = object(request.body),
      operationId = text(body.operationId, "operationId", 200);
    if (!operationId || (body.mode !== "exact" && body.mode !== "compressed"))
      throw new AppError("validation_failed", "Invalid branch operation");
    const identity = JSON.stringify([
      request.params.id,
      body.lastTurnId,
      body.agentMessageId,
      body.mode,
    ]);
    const pending = admissions.get(operationId);
    if (pending) {
      if (pending.fingerprint !== identity)
        throw new AppError("conflict", "Branch identifier belongs to another operation", 409);
      return pending.promise;
    }
    const prior = engine.data.forkOperations?.[operationId];
    if (prior) {
      if (prior.fingerprint !== identity)
        throw new AppError("conflict", "Branch identifier belongs to a different operation", 409);
      return { operation: prior.summary };
    }
    const promise = (async () => {
      const source = engine.thread(request.params.id),
        checked = await boundary(request.params.id, body),
        now = Date.now();
      const stored: StoredFork = {
        fingerprint: identity,
        cutoff: checked.cutoff,
        expectedLatest: checked.expectedLatest,
        draft: blankDraft(),
        queue: [],
        summary: {
          id: operationId,
          sourceThreadId: source.summary.id,
          lastTurnId: body.lastTurnId,
          agentMessageId: body.agentMessageId,
          mode: body.mode,
          status: "preparing",
          stage: "preparing",
          title: `${source.summary.title} · fork`,
          createdAt: now,
          updatedAt: now,
          targetThreadId: null,
          queuedMessageCount: 0,
          estimate: estimate(checked.bytes)[body.mode as "exact" | "compressed"],
          error: null,
        },
      };
      (engine.data.forkOperations ??= {})[operationId] = stored;
      await engine.save();
      publish(stored);
      const task = execute(stored)
        .catch(() => {
          engine.ready = false;
          engine.emit("storageError");
        })
        .finally(() => running.delete(operationId));
      running.set(operationId, task);
      return { operation: stored.summary };
    })();
    admissions.set(operationId, { fingerprint: identity, promise });
    try {
      return await promise;
    } finally {
      admissions.delete(operationId);
    }
  });
  app.get<{ Params: { id: string } }>("/api/v1/fork-operations/:id", (request) => {
    const stored = get(request.params.id);
    return { operation: stored.summary, queuedMessages: stored.queue, draft: stored.draft };
  });
  app.put<{ Params: { id: string } }>("/api/v1/fork-operations/:id/draft", async (request) => {
    const stored = get(request.params.id),
      next = draft(request.body);
    if (stored.summary.status === "ready" && stored.summary.targetThreadId)
      engine.thread(stored.summary.targetThreadId).draft = {
        ...next,
        files: await transferFiles(stored, next.files),
      };
    else stored.draft = next;
    await engine.save();
    return next;
  });
  app.post<{ Params: { id: string } }>("/api/v1/fork-operations/:id/queue", async (request) => {
    const stored = get(request.params.id),
      body = object(request.body),
      input = text(body.input),
      id = body.clientMessageId ? text(body.clientMessageId, "clientMessageId", 200) : randomUUID();
    if (!input.trim() && !body.images?.length && !body.files?.length)
      throw new AppError("validation_failed", "Enter a message");
    if (!validPastedText(body, input))
      throw new AppError("validation_failed", "Invalid pasted input");
    if (stored.summary.status === "ready" && stored.summary.targetThreadId)
      return engine.send(
        stored.summary.targetThreadId,
        {
          ...body,
          input,
          files: await transferFiles(stored, body.files),
          clientMessageId: `fork:${stored.summary.id}:${id}`,
        },
        true,
      );
    const prior = stored.queue.find((message) => message.id === id);
    if (prior) {
      if (prior.text !== input) throw new AppError("conflict", "Message identifier reused", 409);
      return prior;
    }
    const message: QueuedMessage = {
      id,
      threadId: stored.summary.targetThreadId ?? stored.summary.id,
      text: input,
      ...pastedText(body),
      ...(body.images?.length ? { images: body.images } : {}),
      ...(body.files?.length ? { files: body.files } : {}),
      createdAt: Date.now(),
      status: "queued",
    };
    stored.queue.push(message);
    stored.summary.queuedMessageCount = stored.queue.length;
    await engine.save();
    publish(stored);
    return message;
  });
  app.patch<{ Params: { id: string; messageId: string } }>(
    "/api/v1/fork-operations/:id/queue/:messageId",
    async (request) => {
      const stored = get(request.params.id),
        message = stored.queue.find((candidate) => candidate.id === request.params.messageId);
      if (!message) throw new AppError("not_found", "Queued message not found", 404);
      const body = object(request.body),
        input = text(body.input);
      if (!validPastedText(body, input))
        throw new AppError("validation_failed", "Invalid pasted input");
      message.text = input;
      delete message.inlinePastes;
      delete message.pasteBlocks;
      Object.assign(message, pastedText(body));
      await engine.save();
      return message;
    },
  );
  app.delete<{ Params: { id: string; messageId: string } }>(
    "/api/v1/fork-operations/:id/queue/:messageId",
    async (request) => {
      const stored = get(request.params.id);
      stored.queue = stored.queue.filter((message) => message.id !== request.params.messageId);
      stored.summary.queuedMessageCount = stored.queue.length;
      await engine.save();
      publish(stored);
      return { deleted: true };
    },
  );
  app.delete<{ Params: { id: string } }>("/api/v1/fork-operations/:id", async (request) => {
    const stored = get(request.params.id);
    if (running.has(stored.summary.id))
      throw new AppError("conflict", "The native branch is still being prepared", 409);
    delete engine.data.forkOperations![stored.summary.id];
    await engine.save();
    engine.publish({ type: "forkOperation.removed", operationId: stored.summary.id });
    return { deleted: true };
  });
  const recover = async () => {
    for (const stored of Object.values(engine.data.forkOperations ?? {}))
      if (stored.summary.status === "preparing" || stored.summary.status === "reconciling") {
        if (
          stored.summary.targetThreadId &&
          engine.data.threads[stored.summary.targetThreadId] &&
          stored.summary.mode === "exact"
        )
          await finalize(stored);
        else {
          stored.summary.status = "failed";
          stored.summary.error =
            "Preparation was interrupted. The saved native branch is retained; no fork or paid compression is retried automatically.";
          await engine.save();
          publish(stored);
        }
      }
  };
  void recover().catch(() => {
    engine.ready = false;
    engine.emit("storageError");
  });
  app.addHook("onClose", async () => {
    closed = true;
  });
  engine.enableCapabilities({ forks: true });
}
