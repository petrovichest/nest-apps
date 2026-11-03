import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerFrame } from "@codexnest/protocol";
import { KanbanService, registerKanbanRoutes } from "@nest-apps/kanban";
import type { UiService } from "./ui-service";

export async function registerClaudeKanban(app: FastifyInstance, ui: UiService): Promise<void> {
  const service = new KanbanService({
    provider: "claude",
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
        });
        await ui.enqueue(thread.id, {
          input: job.prompt,
          clientMessageId: `kanban:${job.id}:start`,
        });
        return { threadId: thread.id, sessionUrl: `/threads/${encodeURIComponent(thread.id)}` };
      },
      async resume(job) {
        await ui.enqueue(job.threadId, {
          input: job.prompt,
          clientMessageId: `kanban:${job.id}:resume`,
        });
      },
      async threadState(id) {
        return ui.store.data.threads[id] ? ui.summary(id).state : null;
      },
      async archive(id) {
        await ui.store.update((data) => {
          if (data.threads[id]) data.threads[id]!.archived = true;
        });
        ui.publish({ type: "thread.upserted", thread: ui.summary(id) });
      },
    },
  });
  registerKanbanRoutes(app, service, (id) => ui.project(id).path, "claude");
  const observe = (frame: ServerFrame) => {
    if (frame.type === "event" && frame.event.type === "thread.upserted") {
      void service
        .notifyThread(frame.event.thread.id, frame.event.thread.state)
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
