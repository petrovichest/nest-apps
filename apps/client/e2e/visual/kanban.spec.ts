import { expect, test } from "@playwright/test";
import type { KanbanBoard } from "@codexnest/protocol";
import { installVisualFixture, waitForVisualReady } from "./fixtures";

function seedBoard(): KanbanBoard {
  const now = Date.UTC(2026, 10, 3, 12);
  const titles = [
    "Сохранить настройки фильтров",
    "Исправить повторное подключение",
    "Проверить мобильную навигацию",
    "Добавить поиск по категориям",
    "Обновить описание проекта",
  ];
  return {
    id: "board",
    projectPath: "/work/codex-nest",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    stages: [
      { id: "todo", role: "todo", name: "К выполнению", description: "" },
      { id: "working", role: "working", name: "В работе", description: "" },
      { id: "review", role: "review", name: "Проверка", description: "" },
      { id: "ready", role: "ready", name: "К объединению", description: "" },
      { id: "done", role: "done", name: "Готово", description: "" },
    ],
    categories: [
      { id: "front", name: "Фронтенд" },
      { id: "back", name: "Бэкенд" },
    ],
    cards: titles.map((title, i) => ({
      id: `card-${i}`,
      title,
      description:
        i === 0
          ? "Восстанавливать выбранные фильтры после перезапуска приложения."
          : i === 1
            ? "Соединение должно восстанавливаться после возвращения из фонового режима."
            : title,
      categoryId: i === 1 ? "back" : "front",
      stageId: ["todo", "working", "review", "ready", "done"][i],
      classification: "ready",
      scope: "task",
      repositories:
        i === 0
          ? []
          : [
              {
                id: "repo",
                path: "/work/codex-nest",
                branch: "kanban/task",
                targetBranch: "feature/project-board",
                baseSha: "abc",
                commit: null,
                status: i === 4 ? "published" : "working",
                error: null,
              },
            ],
      error: null,
      createdAt: now,
      updatedAt: now,
    })),
    runs: [
      {
        id: "run",
        kind: "execute",
        cardIds: ["card-1"],
        provider: "codex",
        threadId: "session-main",
        sessionUrl: "/threads/session-main",
        status: "running",
        workspacePath: "/tmp/task",
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`kanban follows app surfaces at ${width}px ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await installVisualFixture(page, { theme });
      const board = seedBoard();
      await page.route("**/api/v1/projects/project-nest/kanban**", async (route) => {
        const request = route.request();
        const headers = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "Authorization, Content-Type",
          "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
        };
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (request.method() === "PATCH") {
          const id = new URL(request.url()).pathname.split("/").at(-1);
          const card = board.cards.find((item) => item.id === id)!;
          card.stageId = request.postDataJSON().stageId;
          board.revision++;
        }
        await route.fulfill({
          contentType: "application/json",
          headers,
          body: JSON.stringify(board),
        });
      });
      await page.goto("/projects/project-nest/kanban");
      await expect(page.getByRole("heading", { name: "Доска задач", exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Сохранить настройки фильтров", exact: true }),
      ).toBeVisible();
      await waitForVisualReady(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(page.locator(".kanban-column").first()).toHaveCSS(
        "background-color",
        theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)",
      );
      await page.screenshot({ path: info.outputPath(`kanban-${width}-${theme}.png`) });
      await page.getByRole("button", { name: "Сохранить настройки фильтров", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Сохранить настройки фильтров" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("combobox", { name: "Стадия", exact: true }).selectOption("review");
      await expect(dialog.getByRole("button", { name: "Принять", exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`kanban-card-${width}-${theme}.png`) });
      await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
      await page.getByRole("button", { name: "Добавить задачу", exact: true }).first().click();
      await expect(page.getByRole("dialog", { name: "Добавить задачу" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Начать запись", exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`kanban-create-${width}-${theme}.png`) });
    });
  }
}
