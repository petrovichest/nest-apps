import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerFrame, ThreadSummary } from "@codexnest/protocol";
import { firstRequest, KanbanService, lastReply, registerKanbanRoutes } from "@nest-apps/kanban";
import type { Engine } from "./engine";
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
      available: () => engine.canAcceptWork(),
      async launch(job) {
        const project = engine.data.projects.find((item) => item.path === job.projectPath);
        if (!project) throw new Error("Project not found");
        const { thread } = await engine.createThread(project.id, job.id, undefined, {
          cwd: job.cwd,
          title: job.title,
          ...(job.kind === "classify"
            ? { model: engine.data.taskDefaults.classificationModel ?? "gemini-3-flash" }
            : {}),
        });
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
        await engine.send(job.threadId, {
          input: job.prompt,
          ...(job.images?.length ? { images: job.images } : {}),
          clientMessageId: `kanban:${job.id}:resume`,
        });
      },
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
      async readRequest(id) {
        return engine.data.threads[id] ? firstRequest(engine.detail(id).turns) : null;
      },
    },
  });
  registerKanbanRoutes(app, service, (id) => engine.project(id).path, "gemini");
  const observe = (frame: ServerFrame) => {
    if (frame.type === "event" && frame.event.type === "thread.upserted") {
      void service
        .notifyThread(frame.event.thread.id, boardThreadState(frame.event.thread))
        .catch(() => undefined);
    }
  };
  engine.on("frame", observe);
  app.addHook("onReady", () => service.initialize());
  app.addHook("onClose", async () => {
    engine.off("frame", observe);
    await service.close();
  });
}
