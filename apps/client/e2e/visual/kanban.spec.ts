import { expect, test, type Page } from "@playwright/test";
import type { CreateKanbanCardRequest, KanbanBoard } from "@codexnest/protocol";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  installVisualFixture,
  snapshot,
  waitForVisualReady,
} from "./fixtures";

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

async function mockProjectBoards(page: Page) {
  const nest = seedBoard();
  const mineralCard = "Проверить данные по месторождениям";
  const mineral = {
    ...nest,
    id: "board-mineral",
    projectPath: "/work/mineral-atlas",
    cards: [{ ...nest.cards[0]!, title: mineralCard, description: mineralCard }],
    runs: [],
  };
  const reads: string[] = [];
  for (const [id, board] of [
    ["project-nest", nest],
    ["project-mineral", mineral],
  ] as const) {
    await page.route(`https://codexnest.visual/api/v1/projects/${id}/kanban`, (route) => {
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "Authorization, Content-Type",
        "access-control-allow-methods": "GET, OPTIONS",
      };
      const method = route.request().method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
      expect(method).toBe("GET");
      reads.push(id);
      return route.fulfill({ contentType: "application/json", headers, json: board });
    });
  }
  return { reads, nestCard: nest.cards[0]!.title, mineralCard };
}

for (const [device, viewport] of [
  ["desktop", DESKTOP_VIEWPORT],
  ["phone", PHONE_VIEWPORT],
] as const) {
  const isPhone = device === "phone";
  test.describe(`kanban project switcher on ${device}`, () => {
    test.use({ viewport, hasTouch: isPhone, isMobile: isPhone });

    for (const theme of ["light", "dark"] as const) {
      for (const language of ["ru", "en"] as const) {
        test(`${theme} ${language}`, async ({ page }, info) => {
          await installVisualFixture(page, { theme, language, preserveLocalStorage: true });
          await page.addInitScript(() =>
            localStorage.setItem("codexnest.boardProject", "project-mineral"),
          );
          const { reads, nestCard, mineralCard } = await mockProjectBoards(page);
          const boardLabel = language === "ru" ? "Доска задач" : "Task board";
          const pickerLabel = language === "ru" ? "Выбрать проект" : "Choose project";
          const header = page.locator(".kanban-pane .workspace-header");
          const trigger = header.locator(`summary[aria-label="${pickerLabel}"]`);
          const options = header.getByRole("group", { name: pickerLabel });
          const nestOption = options.getByRole("button", { name: "CodexNest" });
          const mineralOption = options.getByRole("button", { name: "Минеральный атлас" });
          const readSavedProject = () =>
            page.evaluate(() => localStorage.getItem("codexnest.boardProject"));
          const capture = async (step: string) => {
            await waitForVisualReady(page);
            await page.screenshot({
              path: info.outputPath(`${device}-${theme}-${language}-${step}.png`),
            });
          };

          await page.goto("/threads/session-active");
          await expect(page.getByRole("heading", { name: "Сверка токенов темы" })).toBeVisible();
          if (isPhone) {
            await page
              .getByRole("button", {
                name: language === "ru" ? "Открыть список задач" : "Open task list",
              })
              .tap();
          }
          const controls = page.locator(".sidebar-controls");
          const boardLink = controls.getByRole("link", { name: boardLabel, exact: true });
          const workers = language === "ru" ? "Работники" : "Workers";
          await expect(boardLink).toHaveAttribute("href", "/projects/project-nest/kanban");
          await expect(
            controls.getByRole("link", { name: workers }).locator("xpath=following-sibling::*[1]"),
          ).toHaveText(boardLabel);
          await expect(boardLink.locator("svg")).toHaveCount(1);
          expect(await readSavedProject()).toBe("project-mineral");
          expect(reads).toEqual([]);
          await capture("01-menu");
          if (isPhone) await boardLink.tap();
          else await boardLink.click();

          await expect(page).toHaveURL(/\/projects\/project-nest\/kanban$/);
          await expect(
            header.getByRole("heading", { name: boardLabel, exact: true }),
          ).toBeVisible();
          await expect(page.getByRole("button", { name: nestCard, exact: true })).toBeVisible();
          await expect(trigger).toHaveText("CodexNest");
          await expect(trigger).toHaveCSS("font-family", /^"?Onest/);
          await expect(trigger).toHaveCSS("font-weight", "400");
          const projectNameFits = () =>
            trigger
              .locator("span")
              .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
          expect(await projectNameFits()).toBe(true);
          await expect(options).toBeHidden();
          await capture("02-nest");

          if (isPhone) await trigger.tap();
          else await trigger.click();
          await expect(options.getByRole("button")).toHaveText(["CodexNest", "Минеральный атлас"]);
          const menu = (await options.boundingBox())!;
          expect(menu.width).toBeGreaterThanOrEqual(210);
          expect(menu.y).toBeGreaterThanOrEqual((await trigger.boundingBox())!.y + 24);
          await expect(nestOption).toHaveAttribute("aria-pressed", "true");
          await expect(mineralOption).toHaveAttribute("aria-pressed", "false");
          if (isPhone) await expect(nestOption).toHaveCSS("min-height", "44px");
          expect([...new Set(reads)]).toEqual(["project-nest"]);
          await capture("03-picker");

          const beforeSelectingCurrent = await page.evaluate(() => history.length);
          if (isPhone) await nestOption.tap();
          else await nestOption.click();
          await expect(trigger).toBeFocused();
          await expect(options).toBeHidden();
          await expect(page).toHaveURL(/\/projects\/project-nest\/kanban$/);
          expect(await page.evaluate(() => history.length)).toBe(beforeSelectingCurrent);
          await trigger.click();
          await header.getByRole("heading", { name: boardLabel, exact: true }).click();
          await expect(options).toBeHidden();

          if (isPhone) {
            await trigger.tap();
            await mineralOption.tap();
          } else {
            const filter = header.locator(".kanban-category-filter summary");
            await filter.click();
            await header.getByRole("button", { name: "Фронтенд", exact: true }).click();
            await page.getByRole("button", { name: nestCard, exact: true }).click();
            const card = page.getByRole("complementary", { name: nestCard });
            await expect(card).toBeVisible();
            await trigger.press("ArrowDown");
            await expect(nestOption).toBeFocused();
            await page.keyboard.press("End");
            await expect(mineralOption).toBeFocused();
            await page.keyboard.press("Escape");
            await expect(trigger).toBeFocused();
            await expect(options).toBeHidden();
            await trigger.press("Space");
            await expect(options).toBeVisible();
            await page.keyboard.press("Tab");
            await expect(nestOption).toBeFocused();
            await page.keyboard.press("Enter");
            await expect(card).toBeVisible();
            await expect(filter).toHaveText("Фронтенд");
            await expect(options).toBeHidden();
            await expect(trigger).toBeFocused();
            await trigger.press("ArrowUp");
            await expect(mineralOption).toBeFocused();
            await page.keyboard.press("Enter");
            await expect(card).toBeHidden();
          }

          await expect(page).toHaveURL(/\/projects\/project-mineral\/kanban$/);
          await expect(page.getByRole("button", { name: mineralCard, exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: nestCard, exact: true })).toBeHidden();
          await expect(trigger).toHaveText("Минеральный атлас");
          expect(await projectNameFits()).toBe(true);
          await expect(options).toBeHidden();
          expect(await readSavedProject()).toBe("project-mineral");
          expect([...new Set(reads)]).toEqual(["project-nest", "project-mineral"]);
          await capture("04-mineral");
          const beforeBack = reads.length;
          await page.goBack();
          await expect(page).toHaveURL(/\/projects\/project-nest\/kanban$/);
          await expect(page.getByRole("button", { name: nestCard, exact: true })).toBeVisible();
          await expect(trigger).toHaveText("CodexNest");
          expect(reads[beforeBack]).toBe("project-nest");
          await capture("05-back");
        });
      }

      const language = theme === (isPhone ? "dark" : "light") ? "ru" : "en";
      test(`keeps an unsent recording on its board in ${theme} ${language}`, async ({
        page,
      }, info) => {
        await installVisualFixture(page, { theme, language });
        await mockProjectBoards(page);
        await page.addInitScript(() => {
          class Recorder extends EventTarget {
            static isTypeSupported() {
              return true;
            }
            state = "inactive";
            start() {
              this.state = "recording";
            }
            stop() {
              this.state = "inactive";
              const data = new Blob(["audio"], { type: "audio/webm" });
              this.dispatchEvent(Object.assign(new Event("dataavailable"), { data }));
              this.dispatchEvent(new Event("stop"));
            }
          }
          Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder });
          Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
          });
        });
        await page.route(
          "https://codexnest.visual/api/v1/projects/project-nest/kanban/cards",
          (route) => {
            const headers = {
              "access-control-allow-origin": "*",
              "access-control-allow-headers": "Authorization, Content-Type",
              "access-control-allow-methods": "POST, OPTIONS",
            };
            if (route.request().method() === "OPTIONS")
              return route.fulfill({ status: 204, headers });
            expect(route.request().method()).toBe("POST");
            expect(route.request().postDataJSON().audio.data).toBe("YXVkaW8=");
            return route.fulfill({
              status: 422,
              headers,
              json: {
                error: { code: "invalid_audio", message: "Не удалось отправить запись на сервер" },
              },
            });
          },
        );

        const ru = language === "ru";
        const pickerLabel = ru ? "Выбрать проект" : "Choose project";
        const reason = ru
          ? "Сначала отправьте или отмените запись."
          : "Send or discard the recording first.";
        const header = page.locator(".kanban-pane .workspace-header");
        const trigger = header.locator(`summary[aria-label="${pickerLabel}"]`);
        const options = header.getByRole("group", { name: pickerLabel });
        const current = options.getByRole("button", { name: "CodexNest" });
        const alternative = options.getByRole("button", { name: "Минеральный атлас" });
        const open = () => (isPhone ? trigger.tap() : trigger.click());
        const capture = async (state: string) => {
          await waitForVisualReady(page);
          await page.screenshot({
            path: info.outputPath(`${device}-${theme}-${language}-${state}.png`),
          });
        };

        await page.goto("/projects/project-nest/kanban");
        await header
          .getByRole("button", { name: ru ? "Надиктовать задачу" : "Dictate a task" })
          .click();
        const stop = header.getByRole("button", {
          name: ru ? "Остановить запись и создать задачу" : "Stop recording and create the task",
        });
        await expect(stop).toBeVisible();
        await open();
        await expect(options).toHaveAccessibleDescription(reason);
        await expect(options).toBeInViewport({ ratio: 1 });
        await expect(current).toBeEnabled();
        await expect(alternative).toBeDisabled();
        await capture("voice-recording");
        if (isPhone) await alternative.tap({ force: true });
        else await alternative.click({ force: true });
        await expect(page).toHaveURL(/\/projects\/project-nest\/kanban$/);
        await trigger.press("End");
        await expect(current).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(options).toBeHidden();
        await expect(trigger).toBeFocused();
        await expect(stop).toBeEnabled();

        await stop.click();
        const discard = page.getByRole("button", {
          name: ru ? "Удалить запись" : "Discard the recording",
        });
        await expect(discard).toBeVisible();
        await open();
        await expect(alternative).toBeDisabled();
        await capture("voice-retry");
        await trigger.press("Escape");
        await discard.click();
        await open();
        await expect(options.getByText(reason)).toHaveCount(0);
        await expect(alternative).toBeEnabled();
        if (isPhone) await alternative.tap();
        else await alternative.click();
        await expect(page).toHaveURL(/\/projects\/project-mineral\/kanban$/);
      });
    }
  });
}

for (const width of [320, 820, 821]) {
  test(`kanban project switcher fits long names at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const longName =
      "Долгосрочное планирование развития и сопровождения производственной платформы";
    await installVisualFixture(page, {
      theme: "light",
      language: "ru",
      sidebarSide: "right",
      preserveLocalStorage: true,
      snapshot: {
        ...snapshot,
        projects: snapshot.projects.map((project, index) => ({
          ...project,
          displayName: `${longName} ${index + 1}`,
        })),
      },
    });
    await page.addInitScript(() => localStorage.setItem("codexnest.sidebarWidth", "440"));
    const { nestCard, mineralCard } = await mockProjectBoards(page);
    await page.goto("/projects/project-nest/kanban");
    await expect(page.getByRole("button", { name: nestCard, exact: true })).toBeVisible();
    await waitForVisualReady(page);
    const header = page.locator(".kanban-pane .workspace-header");
    const title = header.getByRole("heading", { name: "Доска задач", exact: true });
    expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    const trigger = header.locator("summary[aria-label='Выбрать проект']");
    const add = header.getByRole("button", { name: "Добавить задачу" });
    const actions = header.locator(".workspace-actions");
    const triggerBounds = (await trigger.boundingBox())!;
    expect(triggerBounds.x + triggerBounds.width).toBeLessThanOrEqual(
      (await actions.boundingBox())!.x,
    );
    await expect(add).toBeInViewport();
    await expect(header.getByLabel("Ещё", { exact: true })).toBeVisible();
    await trigger.click();
    const options = header.getByRole("group", { name: "Выбрать проект" });
    const pane = (await page.locator(".kanban-pane").boundingBox())!;
    const menu = (await options.boundingBox())!;
    expect(menu.x).toBeGreaterThanOrEqual(pane.x);
    expect(menu.x + menu.width).toBeLessThanOrEqual(pane.x + pane.width);
    expect(await options.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`long-project-names-${width}.png`) });
    await options.getByRole("button", { name: `${longName} 2` }).click();
    await expect(page.getByRole("button", { name: mineralCard, exact: true })).toBeVisible();
  });
}

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`kanban starts selected tasks together at ${width}px ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await installVisualFixture(page, { theme });
      const board = seedBoard();
      const todo = board.cards[0]!;
      board.cards.splice(
        1,
        0,
        {
          ...todo,
          id: "todo-2",
          title: "Показать ошибку под полем",
          description: "Показать ошибку под полем",
        },
        {
          ...todo,
          id: "todo-3",
          title: "Убрать пробелы в адресе",
          description: "Убрать пробелы в адресе",
        },
      );
      let started: string[] | undefined;
      await page.route("**/api/v1/projects/project-nest/kanban**", async (route) => {
        const request = route.request();
        const headers = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "Authorization, Content-Type",
          "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
        };
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (request.method() === "POST" && request.url().endsWith("/actions")) {
          started = request.postDataJSON().cardIds;
          for (const card of board.cards) if (started!.includes(card.id)) card.stageId = "working";
          board.runs.push({
            ...board.runs[0]!,
            id: "run-together",
            cardIds: started!,
            threadId: "session-together",
            sessionUrl: "/threads/session-together",
          });
          board.revision++;
        }
        await route.fulfill({
          contentType: "application/json",
          headers,
          body: JSON.stringify(board),
        });
      });
      await page.goto("/projects/project-nest/kanban");
      await waitForVisualReady(page);
      const todoLane = page.getByRole("region", { name: "К выполнению" });
      await todoLane
        .getByRole("checkbox", { name: "Выбрать задачу «Сохранить настройки фильтров»" })
        .click();
      await todoLane
        .getByRole("checkbox", { name: "Выбрать задачу «Убрать пробелы в адресе»" })
        .click();
      const start = todoLane.getByRole("button", { name: "Запустить вместе (2)" });
      await expect(start).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: info.outputPath(`kanban-select-${width}-${theme}.png`) });
      await start.click();
      await expect(start).toBeHidden();
      expect(started).toEqual(["card-0", "todo-3"]);
      if (width < 821) await page.getByRole("tab", { name: /В работе/ }).click();
      await page
        .getByRole("button", { name: "Изменить задачу «Убрать пробелы в адресе»", exact: true })
        .click();
      const panel = page.getByRole("complementary", { name: "Убрать пробелы в адресе" });
      await expect(panel.getByRole("heading", { name: "В той же сессии" })).toBeVisible();
      await expect(
        panel.getByRole("button", { name: /Сохранить настройки фильтров/ }),
      ).toBeVisible();
      await page.screenshot({ path: info.outputPath(`kanban-together-${width}-${theme}.png`) });
    });
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
          .getByRole("button", {
            name: "Изменить задачу «Проверить мобильную навигацию»",
            exact: true,
          })
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
      const create = page.getByRole("dialog", { name: "Добавить задачу" });
      // The task field is the session's composer, focused at once.
      const field = create.getByRole("textbox", { name: "Сообщение для Codex" });
      await expect(field).toBeFocused();
      const recorder = create.getByRole("button", {
        name: /^(Начать запись|Запись с микрофона не поддерживается на этом устройстве|Этот браузер не поддерживает запись WebM или MP4)$/,
      });
      await expect(recorder).toBeVisible();
      await expect(create.locator(".kanban-assignee-trigger")).toHaveAccessibleName("Исполнитель");
      await create.getByRole("button", { name: "Добавить изображения" }).click();
      // The attachment menu opens upwards and stays inside the dialog.
      const attachments = create.getByRole("dialog", { name: "Вложения" });
      await expect(attachments).toBeVisible();
      const menuBox = (await attachments.boundingBox())!;
      const dialogBox = (await create.boundingBox())!;
      expect(menuBox.y).toBeGreaterThanOrEqual(dialogBox.y);
      await page.screenshot({ path: info.outputPath(`kanban-create-empty-${width}-${theme}.png`) });
      await page.keyboard.press("Escape");
      await expect(attachments).toBeHidden();
      await expect(create).toBeVisible();
      await field.fill("Исправить по скриншоту");
      await create
        .locator('input[type="file"]')
        .setInputFiles({ name: "screenshot.png", mimeType: "image/png", buffer: png });
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

for (const width of [390, 1440]) {
  test(`kanban panel keeps a long description above its fields at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await installVisualFixture(page, { theme: "light" });
    const board = seedBoard();
    board.cards[3]!.description = Array.from(
      { length: 60 },
      (_, index) => `Строка ${index + 1}: проверено вручную и автотестами.`,
    ).join("\n");
    await page.route("**/api/v1/projects/project-nest/kanban**", (route) =>
      route.fulfill({
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(board),
      }),
    );
    await page.goto("/projects/project-nest/kanban");
    if (width < 821) await page.getByRole("tab", { name: /Готовые/ }).click();
    await page
      .getByRole("button", { name: "Изменить задачу «Добавить поиск по категориям»", exact: true })
      .click();
    const panel = page.getByRole("complementary", { name: "Добавить поиск по категориям" });
    const description = panel.locator(".kanban-panel-description");
    const fields = panel.locator(".kanban-panel-fields");
    await expect(fields).toBeAttached();
    const text = await description.boundingBox();
    expect(await description.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(
      true,
    );
    expect(text!.y + text!.height).toBeLessThanOrEqual((await fields.boundingBox())!.y);
    await fields.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`kanban-long-description-${width}.png`) });
  });
}
