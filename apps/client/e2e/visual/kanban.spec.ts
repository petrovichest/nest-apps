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
      { id: "waiting", role: "waiting", name: "Ждёт ответа", description: "" },
      { id: "ready", role: "ready", name: "Готовые", description: "" },
      { id: "done", role: "done", name: "Опубликовано", description: "" },
    ],
    categories: [
      { id: "front", name: "Фронтенд" },
      { id: "back", name: "Бэкенд" },
      ...[
        "Производство",
        "Админка",
        "Слайсинг",
        "Конфигуратор",
        "Кабинет",
        "Заказ и доставка",
        "Оплата",
        "Данные и закон",
        "Эксплуатация",
        "Развитие и долгосрочное планирование работы проекта",
      ].map((name, index) => ({ id: `category-${index}`, name })),
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
      stageId: ["todo", "working", "waiting", "ready", "done"][i],
      classification: "ready",
      ...(i === 2 ? { question: "Какую ширину колонки категорий оставить на телефоне?" } : {}),
      error: null,
      createdAt: now,
      updatedAt: now,
    })),
    runs: (["running", "waiting", "completed", "completed"] as const).map((status, index) => ({
      id: `run-${index + 1}`,
      kind: "execute",
      cardIds: [`card-${index + 1}`],
      provider: "codex",
      threadId: index === 0 ? "session-main" : `session-${index + 1}`,
      sessionUrl: index === 0 ? "/threads/session-main" : `/threads/session-${index + 1}`,
      status,
      error: null,
      createdAt: now,
      updatedAt: now,
    })),
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
      const categoryMenu = page.locator(
        width < 821 ? ".kanban-filter-menu" : ".kanban-category-filter",
      );
      const categoryTrigger = categoryMenu.locator("summary");
      await categoryTrigger.click();
      const categoryOptions = categoryMenu.locator(".action-menu-popover");
      await expect(categoryOptions).toBeVisible();
      await expect(categoryOptions).toHaveCSS(
        "background-color",
        theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)",
      );
      await expect(categoryOptions).toHaveCSS("border-radius", "24px");
      const bounds = await categoryOptions.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await categoryOptions.evaluate((menu) => menu.scrollHeight > menu.clientHeight)).toBe(
        true,
      );
      const lastCategory = categoryOptions.getByRole("button", { name: /Развитие и/ });
      await lastCategory.scrollIntoViewIfNeeded();
      await expect(lastCategory).toBeInViewport();
      expect(await categoryOptions.evaluate((menu) => menu.scrollWidth <= menu.clientWidth)).toBe(
        true,
      );
      await categoryOptions.evaluate((menu) => (menu.scrollTop = 0));
      await page.screenshot({ path: info.outputPath(`kanban-categories-${width}-${theme}.png`) });
      await categoryOptions.getByRole("button", { name: "Бэкенд", exact: true }).click();
      await expect(categoryOptions).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Сохранить настройки фильтров", exact: true }),
      ).toBeHidden();
      await categoryTrigger.click();
      await expect(
        categoryOptions.getByRole("button", { name: "Бэкенд", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await categoryOptions.getByRole("button", { name: "Все категории", exact: true }).click();
      if (width >= 821) {
        await expect(categoryTrigger).toBeFocused();
        await categoryTrigger.press("ArrowDown");
        await expect(
          categoryOptions.getByRole("button", { name: "Все категории", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(categoryOptions).toBeHidden();
        await expect(categoryTrigger).toBeFocused();
      }
      await categoryTrigger.click();
      await page.getByRole("heading", { name: "Доска задач", exact: true }).click();
      await expect(categoryOptions).toBeHidden();
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
          page.getByRole("button", { name: "Развернуть стадию «Опубликовано», задач: 1" }),
        ).toBeVisible();
      await page.screenshot({ path: info.outputPath(`kanban-${width}-${theme}.png`) });
      if (width >= 821) {
        // A waiting task shows what the agent asks; answering opens its session.
        await page
          .getByRole("button", { name: "Проверить мобильную навигацию", exact: true })
          .click();
        const waiting = page.getByRole("complementary", { name: "Проверить мобильную навигацию" });
        await expect(
          waiting.getByText("Какую ширину колонки категорий оставить на телефоне?"),
        ).toBeVisible();
        await expect(waiting.getByRole("link", { name: "Ответить" })).toHaveAttribute(
          "href",
          "/threads/session-2",
        );
        await expect(page.getByRole("button", { name: "Опубликовать все" })).toBeVisible();
        await page.screenshot({ path: info.outputPath(`kanban-waiting-${width}-${theme}.png`) });
        await waiting.getByRole("button", { name: "Закрыть", exact: true }).click();
        await expect(waiting).toBeHidden();
      }
      await page.getByRole("button", { name: "Сохранить настройки фильтров", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Сохранить настройки фильтров" });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("button", { name: "Запустить агента" })).toBeVisible();
      await panel.getByRole("combobox", { name: "Стадия", exact: true }).selectOption("ready");
      // A task that never ran has no session to publish or rework.
      await expect(panel.getByRole("button", { name: "Запустить агента" })).toBeHidden();
      await expect(panel.getByRole("button", { name: "Опубликовать", exact: true })).toBeHidden();
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
