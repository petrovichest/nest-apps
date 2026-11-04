import { expect, test } from "@playwright/test";
import type { CreateKanbanCardRequest, KanbanBoard } from "@codexnest/protocol";
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
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=",
        "base64",
      );
      let creation: CreateKanbanCardRequest | undefined;
      let imageReads = 0;
      await page.route("**/api/v1/projects/project-nest/kanban**", async (route) => {
        const request = route.request();
        const headers = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "Authorization, Content-Type",
          "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
        };
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (request.url().endsWith("/image")) {
          imageReads++;
          return route.fulfill({
            contentType: "application/json",
            headers,
            body: JSON.stringify(creation!.images![0]),
          });
        }
        if (request.method() === "POST") {
          creation = request.postDataJSON();
          board.cards.push({
            ...board.cards[0],
            id: "image-task",
            stageId: "todo",
            title: creation!.description,
            description: creation!.description,
            images: [
              { name: creation!.images![0]!.name, size: png.length, mediaType: "image/png" },
            ],
          });
          board.revision++;
        }
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
      // Lanes have no surface; cards use the floating tone of the navigation panel.
      await expect(page.locator(".kanban-lane").first()).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(page.locator(".kanban-card").first()).toHaveCSS(
        "background-color",
        theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)",
      );
      if (width < 821)
        await expect(page.getByRole("tab", { name: /К выполнению/ })).toHaveAttribute(
          "aria-selected",
          "true",
        );
      else
        await expect(
          page.getByRole("button", { name: "Развернуть стадию «Готово», задач: 1" }),
        ).toBeVisible();
      await page.screenshot({ path: info.outputPath(`kanban-${width}-${theme}.png`) });
      await page.getByRole("button", { name: "Сохранить настройки фильтров", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Сохранить настройки фильтров" });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("button", { name: "Запустить агента" })).toBeVisible();
      await panel.getByRole("combobox", { name: "Стадия", exact: true }).selectOption("review");
      await expect(panel.getByRole("button", { name: "Принять", exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`kanban-card-${width}-${theme}.png`) });
      await panel.getByRole("button", { name: "Закрыть", exact: true }).click();
      await expect(panel).toBeHidden();
      await page.getByRole("button", { name: "Добавить задачу", exact: true }).first().click();
      await expect(page.getByRole("dialog", { name: "Добавить задачу" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Начать запись", exact: true })).toBeVisible();
      const create = page.getByRole("dialog", { name: "Добавить задачу" });
      await create.getByLabel("Задача", { exact: true }).fill("Исправить по скриншоту");
      const chooser = page.waitForEvent("filechooser");
      await create.getByRole("button", { name: "Прикрепить изображение", exact: true }).click();
      await (
        await chooser
      ).setFiles({ name: "screenshot.png", mimeType: "image/png", buffer: png });
      await expect(create.getByRole("img", { name: "screenshot.png", exact: true })).toBeVisible();
      expect(imageReads).toBe(0);
      await page.screenshot({ path: info.outputPath(`kanban-create-${width}-${theme}.png`) });
      await create.getByRole("button", { name: "Отправить", exact: true }).click();
      await expect(create).toBeHidden();
      expect(creation!.images).toEqual([
        {
          name: "screenshot.png",
          url: `data:image/png;base64,${png.toString("base64")}`,
        },
      ]);
      await page.getByRole("button", { name: "Исправить по скриншоту", exact: true }).click();
      const saved = page.getByRole("complementary", { name: "Исправить по скриншоту" });
      await expect(saved.getByText("screenshot.png", { exact: true })).toBeVisible();
      const thumbnail = saved.getByRole("button", {
        name: "Открыть изображение Изображение 1",
        exact: true,
      });
      await expect(thumbnail).toBeEnabled();
      await thumbnail.click();
      await expect(page.locator(".chat-image-viewer")).toBeVisible();
      // Vite runs React StrictMode, which mounts data-loading effects twice.
      expect(imageReads).toBeLessThanOrEqual(2);
      const reads = imageReads;
      const refreshed = page.waitForResponse(
        (response) => response.url().endsWith("/kanban") && response.request().method() === "GET",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await refreshed;
      expect(imageReads).toBe(reads);
    });
  }
}
