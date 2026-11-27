import { expect, test } from "@playwright/test";
import type { ActivityItem, ServerEvent, ThreadDetail, WorkerProfile } from "@codexnest/protocol";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  installVisualFixture,
  snapshot,
  waitForVisualReady,
} from "./fixtures";

const worker: WorkerProfile = {
  id: "architect",
  name: "Архитектор работников",
  role: "Помогает создать работника",
  instructions: "",
  projectKey: null,
  settings: {},
  revision: 0,
};
const launchId = "12345678-1234-4123-8123-123456789abc";
const clientId = `kanban:${launchId}:start`;
const marker = `Инструмент работников Nest: 'node' '/fixture/agent.mjs' '/fixture/capabilities/worker-codex-${launchId}.json' COMMAND JSON
Используй memory_read с {} для чтения актуальных записей.`;
const sampleSecret = "sk-fixture-only-ARCHITECT-1234567890";
const greeting =
  "Поприветствуй пользователя и спроси, какого работника он хочет создать для этого проекта.";
const startup = `Ты встроенный Архитектор работников Nest.
Синтетическая настройка: ${sampleSecret}.

${marker}

${greeting}`;
const reply = "Какого работника вы хотите создать для этого проекта?";
const ordinary = "Нужен работник, который проверяет отчёты по проекту.";
const task = "Проверь отчёт по проекту.";
const taskPrefix = `Ты работаешь как «Ревьюер». Роль: Проверка.\n\n${marker}\n\nЗадача:\n`;
const pasted = "Проверь раздел «Результаты».\nСверь список файлов.";

for (const [viewport, theme] of [
  [DESKTOP_VIEWPORT, "light"],
  [PHONE_VIEWPORT, "dark"],
] as const) {
  test(`architect launch stays out of the conversation at ${viewport.width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    const seed = structuredClone(snapshot);
    const projectId = seed.projects[0]!.id;
    const thread = seed.threads[0]!;
    Object.assign(thread, {
      id: "session-architect",
      title: worker.name,
      state: "queued",
      currentTurnId: null,
      queuedMessageCount: 1,
      workerSession: { name: worker.name, workerId: worker.id, projectKey: "canonical-project" },
      settings: { ...thread.settings, collaborationMode: "default" },
      relation: { kind: "session", sessionId: "session-architect" },
    });
    seed.threads = [];
    seed.attention = [];
    const message = (id: string, text: string): ActivityItem => ({
      type: "userMessage",
      id,
      text,
      images: [],
      status: "completed",
      timestamp: thread.updatedAt,
      phase: null,
    });
    const detail: ThreadDetail = {
      summary: thread,
      turns: [],
      queuedMessages: [
        {
          id: clientId,
          threadId: thread.id,
          text: startup,
          createdAt: thread.updatedAt,
          status: "dispatching",
        },
      ],
      olderTurnsCursor: null,
    };
    const turn: ThreadDetail["turns"][number] = {
      id: "turn-architect",
      status: "completed",
      startedAt: thread.updatedAt,
      completedAt: thread.updatedAt + 1000,
      durationMs: 1000,
      progress: {
        startedAt: thread.updatedAt,
        explanation: null,
        steps: [],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
      items: [
        message(clientId, startup),
        { ...message("reply", reply), type: "agentMessage", phase: "final_answer" },
      ],
    };

    await installVisualFixture(page, { theme, snapshot: seed });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.copiedText = text;
          },
        },
      });
    });
    const headers = { "access-control-allow-origin": "*" };
    await page.route(`**/api/v1/threads/${thread.id}`, (route) =>
      route.fulfill({ json: detail, headers }),
    );
    await page.route(`**/api/v1/projects/${projectId}/draft`, (route) =>
      route.fulfill({ json: null, headers }),
    );
    await page.route("**/api/v1/workers/catalog", (route) =>
      route.fulfill({ json: { common: [worker], projects: [] }, headers }),
    );
    await page.route("**/api/v1/workers/architect/sessions?**", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      expect(new URL(route.request().url()).searchParams.get("projectId")).toBe(projectId);
      seed.threads = [thread];
      send({ type: "thread.upserted", thread });
      return route.fulfill({ json: { threadId: thread.id }, headers });
    });
    let sequence = seed.sequence;
    let send!: (event: ServerEvent) => void;
    await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (socket) => {
      send = (event) => socket.send(JSON.stringify({ type: "event", sequence: ++sequence, event }));
      socket.onMessage((data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === "authenticate")
          socket.send(JSON.stringify({ type: "snapshot", snapshot: { ...seed, sequence } }));
        if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      });
    });

    await page.goto("/workers");
    const tile = page.locator(".worker-tile").filter({ hasText: "Архитектор" });
    const cataloguePortrait = await tile.locator(".worker-avatar").innerHTML();
    await tile.click();
    await page
      .getByRole("dialog", { name: "Запустить «Архитектор»" })
      .getByRole("button", { name: /^CodexNest/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`/threads/${thread.id}$`));
    const headerIdentity = page.locator(".workspace-header .workspace-worker");
    await expect(headerIdentity.getByText("Архитектор", { exact: true })).toBeVisible();
    expect(await headerIdentity.locator(".worker-avatar").innerHTML()).toBe(cataloguePortrait);

    const launchRow = page.locator(`[data-message-id="${clientId}"]`);
    const noStartupText = async () => {
      await expect(page.locator("body")).not.toContainText(sampleSecret);
      await expect(page.locator("body")).not.toContainText("Инструмент работников Nest");
      await expect(page.locator("body")).not.toContainText(greeting);
    };
    await waitForVisualReady(page);
    await expect(launchRow).toBeVisible();
    await page.screenshot({ path: info.outputPath("queued.png") });
    await expect(launchRow).toContainText("Запуск работника");
    await noStartupText();
    send({
      type: "queue.changed",
      threadId: thread.id,
      messages: detail.queuedMessages.map((message) => ({
        ...message,
        deliveryError: { message: "Ошибка доставки для проверки", retryable: true },
      })),
    });
    await expect(launchRow).toContainText("Ошибка доставки для проверки");
    await expect(launchRow.getByRole("button", { name: /копировать сообщение/iu })).toHaveCount(0);
    await noStartupText();

    detail.queuedMessages = [];
    thread.state = "completed";
    thread.queuedMessageCount = 0;
    send({ type: "turn.replaced", threadId: thread.id, turn: { ...turn, items: [] } });
    for (const item of turn.items)
      send({ type: "activity.upserted", threadId: thread.id, turnId: turn.id, item });
    send({ type: "queue.changed", threadId: thread.id, messages: [] });
    send({ type: "thread.upserted", thread });
    await expect(page.getByText(reply, { exact: true })).toBeVisible();
    await noStartupText();
    await expect(launchRow).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("fresh.png") });

    detail.turns = [
      { ...turn, items: [message("native-user-message", startup), turn.items[1]!] },
      {
        ...turn,
        id: "saved-follow-up",
        items: [
          message("ordinary-input", ordinary),
          {
            ...message("worker-task", taskPrefix + task),
            inlinePastes: [
              { id: "inline-paste", start: taskPrefix.length, end: taskPrefix.length + 7 },
            ],
            pasteBlocks: [{ id: "paste-block", text: pasted }],
            files: [{ name: "отчёт.md", path: "/fixture/report.md" }],
          },
        ],
      },
    ];
    await page.reload();
    const taskRow = page.locator('[data-message-id="worker-task"]');
    await expect(taskRow.getByText(task, { exact: false })).toBeVisible();
    await expect(taskRow.locator(".paste-inline")).toHaveText("Проверь");
    await expect(taskRow.getByText("отчёт.md", { exact: true })).toBeVisible();
    await expect(page.locator('[data-message-id="native-user-message"]')).toHaveCount(0);
    await noStartupText();
    const ordinaryRow = page.locator('[data-message-id="ordinary-input"]');
    await expect(ordinaryRow).toContainText(ordinary);
    await waitForVisualReady(page);
    await page.screenshot({ path: info.outputPath("historical.png") });
    await ordinaryRow.getByRole("button", { name: "Копировать сообщение" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-copied-text", ordinary);
    await taskRow.getByRole("button", { name: "Копировать сообщение" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-copied-text", `${pasted}\n\n${task}`);
  });
}
