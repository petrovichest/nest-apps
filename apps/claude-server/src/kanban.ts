import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerFrame, ThreadSummary } from "@codexnest/protocol";
import { KanbanService, lastReply, registerKanbanRoutes } from "@nest-apps/kanban";
import type { UiService } from "./ui-service";
import type { ClaudeVoiceService } from "./voice";

/**
 * A new session looks finished for a moment: its first message is accepted before its runner
 * attaches. The board waits until no turn is in progress.
 */
export function boardThreadState(thread: Pick<ThreadSummary, "state" | "currentTurnId">): string {
  return thread.currentTurnId && ["completed", "idle"].includes(thread.state)
    ? "running"
    : thread.state;
}

export async function registerClaudeKanban(
  app: FastifyInstance,
  ui: UiService,
  voice?: Pick<ClaudeVoiceService, "transcribe">,
): Promise<void> {
  const service = new KanbanService({
    provider: "claude",
    ...(voice
      ? {
          transcribe: (audio: Buffer, contentType: string, durationMs: number) =>
            voice.transcribe(audio, contentType, undefined, { audioDurationMs: durationMs }),
        }
      : {}),
    ...((process.env.NODE_ENV === "test" || process.env.VITEST) && !process.env.KANBAN_DATA_DIR
      ? { dataDir: join(dirname(ui.store.path), "kanban") }
      : {}),
    adapter: {
      available: () => ui.manager.accepting,
      async launch(job) {
        const project = ui.store.data.projects.find((item) => item.path === job.projectPath);
        if (!project) throw new Error("Project not found");
        const { thread } = await ui.createThread(project.id, job.id, undefined, {
          cwd: job.cwd,
          title: job.title,
          // Task classification is a short routine step: run it on the fastest, cheapest model.
          ...(job.kind === "classify" ? { model: "haiku" } : {}),
        });
        // Settings chosen in the task field, applied like a new session's before its first message.
        if (job.settings)
          await ui.settings(thread.id, {
            collaborationMode: job.settings.collaborationMode,
            model: job.settings.model ?? "default",
            reasoningEffort: job.settings.reasoningEffort,
          });
        await ui.enqueue(thread.id, {
          input: job.prompt,
          ...(job.images?.length ? { images: job.images } : {}),
          clientMessageId: `kanban:${job.id}:start`,
        });
        return { threadId: thread.id, sessionUrl: `/threads/${encodeURIComponent(thread.id)}` };
      },
      async resume(job) {
        await ui.enqueue(job.threadId, {
          input: job.prompt,
          ...(job.images?.length ? { images: job.images } : {}),
          clientMessageId: `kanban:${job.id}:resume`,
        });
      },
      async threadState(id) {
        return ui.store.data.threads[id] ? boardThreadState(ui.summary(id)) : null;
      },
      async interrupt(id) {
        if (ui.store.data.threads[id]) await ui.interrupt(id);
      },
      async archive(id) {
        await ui.store.update((data) => {
          if (data.threads[id]) data.threads[id]!.archived = true;
        });
        ui.publish({ type: "thread.upserted", thread: ui.summary(id) });
      },
      async awaitsAnswer(id) {
        if (!ui.checkReply || !ui.store.data.threads[id]) return null;
        const reply = lastReply((await ui.detail(id)).turns);
        return reply ? ui.checkReply(reply) : null;
      },
    },
  });
  registerKanbanRoutes(app, service, (id) => ui.project(id).path, "claude");
  const observe = (frame: ServerFrame) => {
    if (frame.type === "event" && frame.event.type === "thread.upserted") {
      void service
        .notifyThread(frame.event.thread.id, boardThreadState(frame.event.thread))
        .catch(() => undefined);
    }
  };
  ui.on("frame", observe);
  app.addHook("onReady", () => service.initialize());
  app.addHook("onClose", async () => {
    ui.off("frame", observe);
    await service.close();
  });
}
