import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerFrame, ThreadSummary } from "@codexnest/protocol";
import {
  firstRequest,
  KanbanService,
  lastReply,
  readArchitectSkill,
  registerKanbanRoutes,
} from "@nest-apps/kanban";
import type { Engine } from "./engine";
import { listGeminiSkills } from "./skills";
import type { GeminiVoiceService } from "./voice";

export function boardThreadState(thread: Pick<ThreadSummary, "state" | "currentTurnId">): string {
  return thread.currentTurnId && ["completed", "idle"].includes(thread.state)
    ? "running"
    : thread.state;
}

export async function registerGeminiKanban(
  app: FastifyInstance,
  engine: Engine,
  voice?: Pick<GeminiVoiceService, "transcribe">,
): Promise<void> {
  const service = new KanbanService({
    onWorkerSessionChanged: (id) => {
      if (Object.hasOwn(engine.data.threads, id))
        engine.publish({ type: "thread.upserted", thread: engine.summary(id) });
    },
    provider: "gemini",
    classifies: () => engine.data.taskDefaults.classifyTasks !== false,
    ...(voice
      ? {
          transcribe: (audio: Buffer, contentType: string, durationMs: number) =>
            voice.transcribe(audio, contentType, undefined, { audioDurationMs: durationMs }),
        }
      : {}),
    ...((process.env.NODE_ENV === "test" || process.env.VITEST) && !process.env.KANBAN_DATA_DIR
      ? { dataDir: join(engine.config.stateDir, "kanban") }
      : {}),
    adapter: {
      models: () => engine.data.models,
      chooseModel: (prompt) => engine.chooseWorkerModel(prompt),
      projects: () => engine.data.projects,
      architectSkill: async (cwd) =>
        readArchitectSkill(
          (
            await listGeminiSkills({
              cwd,
              configDir: engine.config.configDir,
              nativeDir: engine.config.nativeDir,
              overrides: engine.data.skillOverrides,
            })
          ).skills,
        ),
      available: () => engine.canAcceptWork(),
      createdThreadId(id, projectPath) {
        const project = engine.data.projects.find((candidate) => candidate.path === projectPath);
        return engine.data.creations[`${project?.id ?? ""}:${id}`];
      },
      async launch(job, beforePublish) {
        const project = engine.data.projects.find((item) => item.path === job.projectPath);
        if (job.projectPath && !project) throw new Error("Project not found");
        const { thread } = await engine.createThread(
          project?.id ?? "",
          job.id,
          undefined,
          {
            cwd: job.cwd,
            title: job.title,
            ...(job.kind === "classify"
              ? { model: engine.data.taskDefaults.classificationModel ?? "gemini-3.8-flash" }
              : {}),
          },
          beforePublish,
        );
        if (job.settings) {
          await engine.settings(thread.id, {
            collaborationMode: job.settings.collaborationMode,
            model: job.settings.model ?? null,
            reasoningEffort: job.settings.reasoningEffort ?? null,
          });
        }
        await engine.send(thread.id, {
          input: job.prompt,
          ...(job.images?.length ? { images: job.images } : {}),
          clientMessageId: `kanban:${job.id}:start`,
        });
        return { threadId: thread.id, sessionUrl: `/threads/${encodeURIComponent(thread.id)}` };
      },
      async resume(job) {
        const clientMessageId = `kanban:${job.id}:resume`;
        // An old result may already have been admitted in the legacy delivery mode.
        const previous = engine.data.threads[job.threadId]?.receipts[clientMessageId];
        await engine.send(
          job.threadId,
          {
            input: job.prompt,
            ...(job.images?.length ? { images: job.images } : {}),
            clientMessageId,
          },
          Boolean(job.workerResult && previous?.message.deliveryMode !== "steer"),
        );
      },
      threadSummary: (id) => (engine.data.threads[id] ? engine.summary(id) : undefined),
      async threadState(id) {
        return engine.data.threads[id] ? boardThreadState(engine.summary(id)) : null;
      },
      async interrupt(id) {
        if (engine.data.threads[id]) engine.cancel(id);
      },
      async archive(id) {
        if (engine.data.threads[id]) await engine.patchThread(id, { archived: true });
      },
      async readReply(id) {
        if (!engine.checkReply || !engine.data.threads[id]) return null;
        const reply = lastReply(engine.detail(id).turns);
        return reply ? engine.checkReply(reply, engine.data.taskDefaults.replyCheckModel) : null;
      },
      async readAnswer(id) {
        return engine.data.threads[id] ? lastReply(engine.detail(id).turns) : null;
      },
      async readRequest(id) {
        return engine.data.threads[id] ? firstRequest(engine.detail(id).turns) : null;
      },
    },
  });
  engine.setWorkerSessionProvider((id) => service.workerSession(id));
  registerKanbanRoutes(app, service, (id) => engine.project(id).path, "gemini");
  const observe = (frame: ServerFrame) => {
    if (frame.type !== "event") return;
    if (frame.event.type === "thread.upserted") {
      const { thread } = frame.event;
      void service.notifyThread(thread.id, boardThreadState(thread), thread).catch(() => undefined);
    } else if (frame.event.type === "connection.changed") {
      service.wake();
    }
  };
  engine.on("frame", observe);
  app.addHook("onReady", () => service.initialize());
  app.addHook("onClose", async () => {
    engine.off("frame", observe);
    await service.close();
  });
}
