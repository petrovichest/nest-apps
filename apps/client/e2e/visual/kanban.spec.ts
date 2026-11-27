import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  CreateKanbanCardRequest,
  KanbanBoard,
  UpdateKanbanCardRequest,
} from "@codexnest/protocol";
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
          const search = options.getByRole("searchbox", {
            name: language === "ru" ? "Найти проект" : "Find a project",
          });
          const projectOptions = options.getByRole("button");
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
          const open = () => (isPhone ? trigger.tap() : trigger.click());

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
          const titleBounds = (await header.locator(".workspace-title").boundingBox())!;
          const triggerBounds = (await trigger.boundingBox())!;
          if (isPhone) {
            expect(triggerBounds.y).toBeGreaterThan(titleBounds.y + titleBounds.height);
            const stages = (await page.locator(".kanban-stage-bar").boundingBox())!;
            expect(stages.y).toBeGreaterThan(triggerBounds.y + triggerBounds.height);
          } else {
            expect(triggerBounds.x).toBeGreaterThan(titleBounds.x + titleBounds.width);
            expect(triggerBounds.y).toBe(titleBounds.y);
          }
          await expect(options).toBeHidden();
          await capture("02-closed");

          await open();
          await expect(search).toBeFocused();
          await expect(projectOptions).toHaveText(["CodexNest", "Минеральный атлас"]);
          const menu = (await options.boundingBox())!;
          expect(menu.width).toBeGreaterThanOrEqual(210);
          expect(menu.y).toBeGreaterThan(triggerBounds.y + triggerBounds.height);
          expect(menu.x).toBeCloseTo(triggerBounds.x, 0);
          await expect(nestOption).toHaveAttribute("aria-pressed", "true");
          await expect(mineralOption).toHaveAttribute("aria-pressed", "false");
          if (isPhone) await expect(nestOption).toHaveCSS("min-height", "44px");
          expect([...new Set(reads)]).toEqual(["project-nest"]);
          await capture("03-search");
          const searchTop = (await search.boundingBox())!.y;
          await page.keyboard.insertText("  мИНЕральный  ");
          await expect(projectOptions).toHaveText(["Минеральный атлас"]);
          expect((await search.boundingBox())!.y).toBe(searchTop);
          await capture("04-filtered");
          await search.fill("zebra");
          await expect(options.getByRole("status")).toHaveText(
            language === "ru" ? "Совпадений нет" : "No matches",
          );
          await expect(projectOptions).toHaveCount(0);
          await search.press("Enter");
          await expect(page).toHaveURL(/\/projects\/project-nest\/kanban$/);
          await capture("05-empty");
          await header.getByRole("heading", { name: boardLabel, exact: true }).click();
          await expect(options).toBeHidden();

          await open();
          await expect(search).toBeFocused();
          await expect(search).toHaveValue("");
          const beforeSelectingCurrent = await page.evaluate(() => history.length);
          if (isPhone) await nestOption.tap();
          else await nestOption.click();
          await expect(trigger).toBeFocused();
          await expect(options).toBeHidden();
          await expect(page).toHaveURL(/\/projects\/project-nest\/kanban$/);
          expect(await page.evaluate(() => history.length)).toBe(beforeSelectingCurrent);

          if (isPhone) {
            await trigger.tap();
            await expect(search).toBeFocused();
            await search.fill("атлас");
            await mineralOption.tap();
          } else {
            const filter = header.locator(".kanban-category-filter summary");
            await filter.click();
            await header.getByRole("button", { name: "Фронтенд", exact: true }).click();
            await page.getByRole("button", { name: nestCard, exact: true }).click();
            const card = page.getByRole("complementary", { name: nestCard });
            await expect(card).toBeVisible();
            await trigger.press("Enter");
            await expect(search).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(nestOption).toBeFocused();
            await page.keyboard.press("ArrowDown");
            await expect(mineralOption).toBeFocused();
            await page.keyboard.press("Escape");
            await expect(trigger).toBeFocused();
            await expect(options).toBeHidden();
            await trigger.press("Space");
            await expect(search).toBeFocused();
            await search.fill("codex");
            await search.press("Enter");
            await expect(card).toBeVisible();
            await expect(filter).toHaveText("Фронтенд");
            await expect(options).toBeHidden();
            await expect(trigger).toBeFocused();
            await trigger.press("ArrowUp");
            await expect(search).toBeFocused();
            await search.fill("  мИНЕральный  ");
            await search.press("Enter");
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
          await capture("06-mineral");
          const beforeBack = reads.length;
          await page.goBack();
          await expect(page).toHaveURL(/\/projects\/project-nest\/kanban$/);
          await expect(page.getByRole("button", { name: nestCard, exact: true })).toBeVisible();
          await expect(trigger).toHaveText("CodexNest");
          expect(reads[beforeBack]).toBe("project-nest");
          await capture("07-back");
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
        const search = options.getByRole("searchbox", {
          name: ru ? "Найти проект" : "Find a project",
        });
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
        if (isPhone) {
          await page.setViewportSize({ width: 320, height: viewport.height });
          const title = header.getByRole("heading", { level: 1 });
          expect(
            await title.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          ).toBe(true);
          await page.setViewportSize(viewport);
        }
        await open();
        await expect(search).toBeFocused();
        await expect(options).toHaveAccessibleDescription(reason);
        await expect(options).toBeInViewport({ ratio: 1 });
        await expect(current).toBeEnabled();
        await expect(alternative).toBeDisabled();
        await capture("voice-recording");
        if (isPhone) await alternative.tap({ force: true });
        else await alternative.click({ force: true });
        await expect(page).toHaveURL(/\/projects\/project-nest\/kanban$/);
        await search.fill("атлас");
        await expect(alternative).toBeDisabled();
        await search.press("Enter");
        await expect(page).toHaveURL(/\/projects\/project-nest\/kanban$/);
        await search.fill("");
        await search.press("Tab");
        await expect(current).toBeFocused();
        await page.keyboard.press("End");
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
        await search.fill("атлас");
        await expect(alternative).toBeEnabled();
        await search.press("Enter");
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
    const actionsBounds = (await actions.boundingBox())!;
    if (triggerBounds.y < actionsBounds.y + actionsBounds.height) {
      expect(triggerBounds.x + triggerBounds.width).toBeLessThanOrEqual(actionsBounds.x);
    } else {
      const firstRow = page
        .locator(width <= 820 ? ".kanban-stage-bar" : ".kanban-lane-head")
        .first();
      expect((await firstRow.boundingBox())!.y).toBeGreaterThan(
        triggerBounds.y + triggerBounds.height,
      );
    }
    await expect(add).toBeInViewport();
    const compactFilter = header.locator(".kanban-filter-menu");
    const more = compactFilter.locator("summary");
    await expect(more).toBeVisible();
    if (width >= 820) {
      const categories = compactFilter.locator(".action-menu-popover");
      const frontend = categories.getByRole("button", { name: "Фронтенд", exact: true });
      await more.focus();
      await page.keyboard.press("ArrowDown");
      await expect(
        categories.getByRole("button", { name: "Все категории", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(frontend).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(categories).toBeHidden();
      await expect(more).toBeFocused();
      await expect(more).toHaveCSS("outline-style", "solid");
      await expect(more).toHaveCSS("outline-width", "2px");
      await page.screenshot({ path: info.outputPath(`compact-filter-focus-${width}.png`) });

      await more.press("ArrowDown");
      await expect(frontend).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("Escape");
      await expect(categories).toBeHidden();
      await expect(more).toBeFocused();
      await more.press("ArrowDown");
      await page.keyboard.press("Enter");
    }
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

test.describe("kanban project switcher above the mobile keyboard", () => {
  test.use({ viewport: PHONE_VIEWPORT, hasTouch: true, isMobile: true });

  test("scrolls long results under a stationary search field", async ({ page }, info) => {
    const additionalProjects = Array.from({ length: 18 }, (_, index) => ({
      ...snapshot.projects[0]!,
      id: `project-${index}`,
      displayName: `Проект ${index}`,
    }));
    await installVisualFixture(page, {
      theme: "dark",
      snapshot: { ...snapshot, projects: [...snapshot.projects, ...additionalProjects] },
    });
    await mockProjectBoards(page);
    await page.goto("/projects/project-nest/kanban");
    const trigger = page.locator("summary[aria-label='Выбрать проект']");
    await trigger.tap();
    const popup = page.getByRole("group", { name: "Выбрать проект" });
    const search = popup.getByRole("searchbox", { name: "Найти проект" });
    const results = popup.locator(".kanban-project-results");
    await expect(search).toBeFocused();
    await expect(results.getByRole("button")).toHaveCount(20);
    await page.evaluate(() => {
      const visual = window.visualViewport!;
      Object.defineProperty(visual, "height", { configurable: true, value: 260 });
      visual.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(async () => {
        const bounds = (await popup.boundingBox())!;
        return bounds.y + bounds.height;
      })
      .toBeLessThanOrEqual(260);
    const searchTop = (await search.boundingBox())!.y;
    await results.evaluate((list) => (list.scrollTop = list.scrollHeight));
    expect(await results.evaluate((list) => list.scrollTop)).toBeGreaterThan(0);
    expect((await search.boundingBox())!.y).toBe(searchTop);
    await expectFullyHittable(results.getByRole("button").last(), results);
    await search.fill("  ПРОекТ 12  ");
    await expect(results.getByRole("button")).toHaveText(["Проект 12"]);
    expect(await results.evaluate((list) => list.scrollTop)).toBe(0);
    expect((await search.boundingBox())!.y).toBe(searchTop);
    await page.screenshot({ path: info.outputPath("phone-dark-keyboard-viewport.png") });
  });
});

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
      const panel = page.getByRole(width < 1280 ? "dialog" : "complementary", {
        name: "Убрать пробелы в адресе",
      });
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
      const panel = page.getByRole(width < 1280 ? "dialog" : "complementary", {
        name: "Сохранить настройки фильтров",
      });
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
      await create.locator('input[type="file"]').setInputFiles([
        { name: "screenshot.png", mimeType: "image/png", buffer: png },
        { name: "extra.png", mimeType: "image/png", buffer: png },
      ]);
      const preview = create.getByRole("button", { name: "Открыть изображение screenshot.png" });
      await expect(preview).toHaveCSS("border-radius", "20px");
      await preview.click();
      const viewer = page.getByRole("dialog", { name: "Просмотр изображений" });
      await expect(viewer.getByRole("img", { name: "screenshot.png" })).toBeVisible();
      await viewer.getByRole("button", { name: "Закрыть", exact: true }).click();
      await expect(viewer).toBeHidden();
      await create.getByRole("button", { name: "Удалить изображение extra.png" }).click();
      await expect(create.getByRole("img", { name: "extra.png" })).toHaveCount(0);
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
      const saved = page.getByRole(width < 1280 ? "dialog" : "complementary", {
        name: "Исправить по скриншоту",
      });
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
    const panel = page.getByRole(width < 1280 ? "dialog" : "complementary", {
      name: "Добавить поиск по категориям",
    });
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

const accessRoute = "/projects/project-nest/kanban";

async function installKanbanAccessFixture(
  page: Page,
  {
    theme = "light",
    language = "ru",
    manyCards = false,
    query = "",
    configureBoard,
  }: {
    theme?: "light" | "dark";
    language?: "ru" | "en";
    manyCards?: boolean;
    query?: string;
    configureBoard?: (board: KanbanBoard) => void;
  } = {},
) {
  const board = seedBoard();
  const ru = language === "ru";
  const card = board.cards[0]!;
  const archived = {
    ...card,
    id: "archived",
    title: ru ? "Карточка в архиве" : "Archived task",
    archivedAt: board.updatedAt,
  };
  board.cards.push(archived);
  if (manyCards) {
    for (const stageId of ["todo", "ready"]) {
      for (let index = 1; index <= 25; index++) {
        const title = `${stageId} position ${index}`;
        board.cards.push({
          ...card,
          stageId,
          id: `${stageId}-${index}`,
          title,
          description: title,
        });
      }
    }
  }
  card.description = Array.from({ length: 60 }, (_, index) =>
    ru ? `Строка ${index + 1}. Проверено вручную.` : `Line ${index + 1}. Verified by hand.`,
  ).join("\n");

  const workers = Array.from({ length: 30 }, (_, index) => ({
    id: `worker-${index + 1}`,
    name: ru ? `Работник ${index + 1}` : `Worker ${index + 1}`,
  }));
  // A distinct name at the end catches reordering and gives search a unique match.
  workers.at(-1)!.name = ru ? "Анна Морозова" : "Anna Morozova";

  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
  let catalogueReads = 0;
  const patches: UpdateKanbanCardRequest[] = [];
  const creations: CreateKanbanCardRequest[] = [];
  await installVisualFixture(page, { language, theme });
  await page.route("**/api/v1/workers/catalog", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    catalogueReads++;
    return route.fulfill({
      headers,
      json: { ready: true, projects: [{ projectId: "project-nest", workers }] },
    });
  });
  await page.route("**/api/v1/projects/project-nest/kanban**", async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (method === "PATCH") {
      const patch = route.request().postDataJSON() as UpdateKanbanCardRequest;
      patches.push(patch);
      const cardId = new URL(route.request().url()).pathname.split("/").at(-1);
      const updated = board.cards.find((item) => item.id === cardId)!;
      if ("workerId" in patch) updated.workerId = patch.workerId ?? undefined;
      if (patch.stageId) updated.stageId = patch.stageId;
      if (patch.archived === false) delete updated.archivedAt;
      board.revision++;
    }
    if (method === "POST") {
      const creation = route.request().postDataJSON() as CreateKanbanCardRequest;
      creations.push(creation);
      board.cards.push({
        ...card,
        id: "created",
        workerId: creation.workerId,
        title: creation.description,
        description: creation.description,
      });
      board.revision++;
    }
    await route.fulfill({ headers, json: board });
  });
  configureBoard?.(board);
  await page.goto(accessRoute + query);
  await expect(query ? page.locator(".kanban-panel") : page.locator(".kanban-board")).toBeVisible();
  await waitForVisualReady(page);
  return {
    card,
    archived,
    workers,
    patches,
    creations,
    catalogueReads: () => catalogueReads,
    labels: {
      add: ru ? "Добавить задачу" : "Add task",
      archive: ru ? "Архив" : "Archive",
      close: ru ? "Закрыть" : "Close",
      search: ru ? "Найти работника" : "Find a worker",
      defaultWorker: ru ? "Стандартная сессия" : "Standard session",
      message: ru ? "Сообщение для Codex" : "Message for Codex",
      submit: ru ? "Отправить" : "Submit",
    },
  };
}

async function scrollWorkerList(page: Page, list: Locator, input: "wheel" | "swipe" | "scrollTop") {
  const box = (await list.boundingBox())!;
  const { distance, top } = await list.evaluate((node) => ({
    distance: node.scrollHeight - node.clientHeight,
    top: node.scrollTop,
  }));
  expect(top).toBe(0);
  expect(distance).toBeGreaterThan(0);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  if (input === "swipe") {
    const cdp = await page.context().newCDPSession(page);
    try {
      const start = Math.floor(box.y + box.height - 12);
      const end = Math.ceil(box.y + 12);
      const steps = 5;
      const maxSwipes = Math.ceil(distance / (start - end - 24)) + 3;
      for (let swipe = 0; swipe < maxSwipes; swipe++) {
        const scrollTop = await list.evaluate((node) => node.scrollTop);
        if (scrollTop >= distance - 1) break;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y: start }],
        });
        for (let step = 1; step <= steps; step++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: Math.round(start + ((end - start) * step) / steps) }],
          });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(scrollTop);
      }
    } finally {
      await cdp.detach();
    }
  } else if (input === "wheel") {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, distance + 100);
  } else {
    // The mobile WebKit driver supports tapping, but has no wheel or swipe API.
    await list.evaluate((node) => (node.scrollTop = node.scrollHeight));
  }
  await expect
    .poll(() => list.evaluate((node) => node.scrollTop))
    .toBeGreaterThanOrEqual(distance - 1);
}

async function expectFullyHittable(option: Locator, list: Locator) {
  const box = (await option.boundingBox())!;
  const listBox = (await list.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(listBox.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  expect(
    await option.evaluate(
      (node, point) => node.contains(document.elementFromPoint(point.x, point.y)),
      { x, y },
    ),
  ).toBe(true);
  return { x, y };
}

for (const viewport of [DESKTOP_VIEWPORT, PHONE_VIEWPORT, { width: 320, height: 480 }]) {
  const touch = viewport.width < 821;
  test.describe(`Kanban worker selection ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: touch, isMobile: touch });

    for (const theme of ["light", "dark"] as const) {
      for (const language of ["ru", "en"] as const) {
        test(`selects the last worker in the card and in creation, ${theme} ${language}`, async ({
          page,
          browserName,
        }, info) => {
          const { card, workers, patches, creations, catalogueReads, labels } =
            await installKanbanAccessFixture(page, { theme, language });
          const lastWorker = workers.at(-1)!;
          const press = (locator: Locator) => (touch ? locator.tap() : locator.click());
          for (const surface of ["edit", "create"] as const) {
            const editing = surface === "edit";
            const opener = page.getByRole("button", {
              name: editing ? card.title : labels.add,
              exact: true,
            });
            await press(opener);
            const panel = page.getByRole(editing && !touch ? "complementary" : "dialog", {
              name: editing ? card.title : labels.add,
            });
            const trigger = panel.locator(".kanban-assignee-trigger");
            const list = panel.locator(".kanban-assignee-options");
            const search = panel.getByRole("searchbox", { name: labels.search });
            if (editing) {
              const body = panel.locator(".kanban-panel-body");
              await body.evaluate((node) => (node.scrollTop = node.scrollHeight));
              expect(await body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
            }
            await press(trigger);
            await expect(search).toBeFocused();
            await expect(list.getByRole("button")).toHaveText([
              labels.defaultWorker,
              ...workers.map(({ name }) => name),
            ]);
            const panelBounds = (await panel.boundingBox())!;
            const listBounds = (await list.boundingBox())!;
            expect(listBounds.y).toBeGreaterThanOrEqual(panelBounds.y);
            expect(listBounds.y + listBounds.height).toBeLessThanOrEqual(
              panelBounds.y + panelBounds.height,
            );
            const searchY = (await search.boundingBox())!.y;
            await scrollWorkerList(
              page,
              list,
              touch ? (browserName === "chromium" ? "swipe" : "scrollTop") : "wheel",
            );
            expect((await search.boundingBox())!.y).toBeCloseTo(searchY, 0);
            const last = list.getByRole("button", { name: lastWorker.name });
            const { x, y } = await expectFullyHittable(last, list);
            if (!touch) await page.mouse.move(x, y);
            await page.screenshot({ path: info.outputPath(`${surface}-last-worker.png`) });
            // Use coordinates so the driver cannot auto-scroll an obscured or clipped option into view.
            if (touch) await page.touchscreen.tap(x, y);
            else await page.mouse.click(x, y);
            await expect(trigger).toContainText(lastWorker.name);
            await expect(list).toBeHidden();

            if (editing) {
              expect(patches).toEqual([{ workerId: lastWorker.id }]);
              await panel.getByRole("button", { name: labels.close, exact: true }).click();
              await expect(opener).toBeFocused();
            } else {
              const text = language === "ru" ? "Создать задачу для Анны" : "Create a task for Anna";
              const message = panel.getByRole("textbox", { name: labels.message });
              await message.fill(text);
              await expect(message).toBeFocused();
              await press(panel.getByRole("button", { name: labels.submit, exact: true }));
              await expect(panel).toBeHidden();
              expect(creations).toEqual([
                expect.objectContaining({ description: text, workerId: lastWorker.id }),
              ]);
            }
          }
          expect(catalogueReads()).toBe(2);
        });
      }
    }
  });
}

for (const viewport of [DESKTOP_VIEWPORT, PHONE_VIEWPORT]) {
  const mobile = viewport.width < 821;
  test.describe(`Kanban keyboard ${viewport.width}px`, () => {
    test.use({ viewport });

    test("search keeps the catalogue order and Escape closes one layer at a time", async ({
      page,
    }, info) => {
      const { card, workers, labels, patches, catalogueReads } = await installKanbanAccessFixture(
        page,
        {
          theme: mobile ? "dark" : "light",
          language: mobile ? "en" : "ru",
        },
      );
      const cardTrigger = page.getByRole("button", { name: card.title, exact: true });
      await cardTrigger.press("Enter");
      const panel = page.getByRole(mobile ? "dialog" : "complementary", { name: card.title });
      const trigger = panel.locator(".kanban-assignee-trigger");
      const list = panel.locator(".kanban-assignee-options");
      const search = panel.getByRole("searchbox", { name: labels.search });
      await trigger.scrollIntoViewIfNeeded();
      await trigger.press("Enter");
      await expect(search).toBeFocused();
      await expect(list.getByRole("button")).toHaveCount(31);
      const searchY = (await search.boundingBox())!.y;
      await search.fill("no-result-357");
      await expect(list.getByRole("status")).toHaveText(mobile ? "No matches" : "Совпадений нет");
      await search.fill(mobile ? "worker 1" : "работник 1");
      await search.press("Enter");
      await expect(search).toBeFocused();
      expect(patches).toEqual([]);
      await search.fill(mobile ? "  MOROZ  " : "  МОРОЗ  ");
      const matched = list.getByRole("button", { name: workers.at(-1)!.name, exact: true });
      await expect(list.getByRole("button")).toHaveCount(1);
      await expect(matched).toBeVisible();
      expect((await search.boundingBox())!.y).toBeCloseTo(searchY, 0);
      await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
      await expect(search).toBeFocused();
      expect(patches).toEqual([]);
      await page.screenshot({ path: info.outputPath("edit-worker-search.png") });
      await search.press("Enter");
      await expect(trigger).toBeFocused();
      await expect(trigger).toContainText(workers.at(-1)!.name);
      expect(patches).toEqual([{ workerId: workers.at(-1)!.id }]);

      await trigger.press("Enter");
      await expect(search).toHaveValue("");
      await expect(matched).toHaveAttribute("aria-pressed", "true");
      await search.press("ArrowDown");
      await expect(list.getByRole("button", { name: labels.defaultWorker })).toBeFocused();
      await page.keyboard.press("End");
      await expect(matched).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(list).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(panel).toBeVisible();
      await page.screenshot({ path: info.outputPath("edit-picker-focus.png") });
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(cardTrigger).toBeFocused();

      await page.getByRole("button", { name: labels.add, exact: true }).press("Enter");
      const dialog = page.getByRole("dialog", { name: labels.add });
      const draftTrigger = dialog.locator(".kanban-assignee-trigger");
      await draftTrigger.press("Enter");
      const draftSearch = dialog.getByRole("searchbox", { name: labels.search });
      await expect(draftSearch).toBeFocused();
      await draftSearch.fill("no-result-357");
      const message = dialog.getByRole("textbox", { name: labels.message });
      await message.click();
      await expect(draftSearch).toBeHidden();
      await expect(message).toBeFocused();
      await draftTrigger.press("Enter");
      await expect(draftSearch).toHaveValue("");
      await page.keyboard.press("Escape");
      await expect(draftTrigger).toBeFocused();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(catalogueReads()).toBe(4);
    });

    test("archive focus returns to the visible opener", async ({ page }, info) => {
      const { archived, labels, patches } = await installKanbanAccessFixture(page, {
        theme: mobile ? "dark" : "light",
        language: mobile ? "en" : "ru",
      });
      const compact = page.locator(".kanban-filter-menu");
      const opener = mobile ? compact.locator("summary") : page.locator(".kanban-archive-button");
      await opener.press("Enter");
      if (mobile)
        await compact.getByRole("button", { name: labels.archive, exact: true }).press("Enter");
      const archive = page.getByRole(mobile ? "dialog" : "complementary", { name: labels.archive });
      const close = archive.getByRole("button", { name: labels.close, exact: true });
      const restore = archive.getByRole("button", {
        name: mobile ? "Restore" : "Вернуть",
        exact: true,
      });
      const deleteTask = archive.getByRole("button", {
        name: mobile ? "Delete permanently" : "Удалить навсегда",
        exact: true,
      });
      await expect(archive.getByText(archived.title, { exact: true })).toBeVisible();
      await expect(archive.locator("#kanban-archive-title")).toBeFocused();
      if (mobile) {
        await page.keyboard.press("Tab");
        await expect(close).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(deleteTask).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(close).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(restore).toBeFocused();
        await deleteTask.press("Enter");
        const confirm = page.getByRole("dialog", { name: "Delete the task permanently?" });
        await expect(confirm).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(confirm).toBeHidden();
        await expect(deleteTask).toBeFocused();
      } else {
        // The stage actions and navigation still receive focus beside a desktop archive.
        const boardControl = page.locator(".kanban-add-button");
        await boardControl.focus();
        await expect(boardControl).toBeFocused();
      }
      await restore.focus();
      await page.screenshot({ path: info.outputPath("archive-focus.png") });
      await page.keyboard.press("Escape");
      await expect(archive).toBeHidden();
      await expect(opener).toBeFocused();
      await page.screenshot({ path: info.outputPath("archive-opener-focus.png") });

      await opener.press("Enter");
      if (mobile)
        await compact.getByRole("button", { name: labels.archive, exact: true }).press("Enter");
      await restore.press("Enter");
      await expect(archive.getByText(archived.title, { exact: true })).toBeHidden();
      expect(patches).toEqual([{ archived: false }]);
      await expect(archive.locator("#kanban-archive-title")).toBeFocused();
      await close.click();
      await expect(opener).toBeFocused();
    });
  });
}

test("Kanban changes panel modality at 1280px and keeps Tab on the mobile card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const { card } = await installKanbanAccessFixture(page);
  const opener = page
    .locator(".kanban-pane")
    .getByRole("button", { name: card.title, exact: true });
  await opener.press("Enter");
  const desktop = page.getByRole("complementary", { name: card.title });
  await expect(desktop).toBeVisible();
  await expect(desktop).not.toHaveAttribute("aria-modal", "true");
  const board = page.locator(".kanban-pane");
  await expect(board).not.toHaveAttribute("inert");
  await opener.focus();
  await expect(opener).toBeFocused();

  await page.setViewportSize({ width: 1279, height: 844 });
  const overlay = page.getByRole("dialog", { name: card.title });
  await expect(overlay).toHaveAttribute("aria-modal", "true");
  await expect(board).toHaveAttribute("inert", "");
  await expect(overlay.locator("#kanban-card-title")).toBeFocused();
  await page.setViewportSize(PHONE_VIEWPORT);
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press(key);
      expect(await overlay.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
  }
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
  await expect(opener).toBeFocused();
});

test("Kanban stage and task menus close with Escape and return focus", async ({ page }) => {
  const { card } = await installKanbanAccessFixture(page);
  const stage = page.locator(".kanban-lane-menu").first();
  const stageTrigger = stage.locator("summary");
  await stageTrigger.press("Enter");
  await stage.getByRole("button", { name: "Изменить", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(stage).not.toHaveAttribute("open");
  await expect(stageTrigger).toBeFocused();

  await page.getByRole("button", { name: card.title, exact: true }).press("Enter");
  const panel = page.getByRole("complementary", { name: card.title });
  const menu = panel.locator(".kanban-panel-menu");
  const trigger = menu.locator("summary");
  await trigger.press("Enter");
  await menu.getByRole("button", { name: "В архив", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open");
  await expect(trigger).toBeFocused();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("Kanban worker search keeps its result above the reduced visual viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: { writable: true, value: 480 },
      offsetTop: { writable: true, value: 0 },
    });
    Object.defineProperty(window, "visualViewport", { value: viewport });
  });
  const { card, labels, workers } = await installKanbanAccessFixture(page);
  for (const [opener, surfaceName] of [
    [card.title, card.title],
    [labels.add, labels.add],
  ] as const) {
    await page.getByRole("button", { name: opener, exact: true }).first().press("Enter");
    const surface = page.getByRole("dialog", { name: surfaceName });
    const trigger = surface.locator(".kanban-assignee-trigger");
    await trigger.scrollIntoViewIfNeeded();
    await trigger.press("Enter");
    const search = surface.getByRole("searchbox", { name: labels.search });
    await expect(search).toBeFocused();
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.assign(viewport, { offsetTop: 48, height: 228 });
      viewport.dispatchEvent(new Event("resize"));
    });
    await search.fill("мороз");
    const option = surface.getByRole("button", { name: workers.at(-1)!.name, exact: true });
    await expect(option).toBeVisible();
    const searchBounds = (await search.boundingBox())!;
    const optionBounds = (await option.boundingBox())!;
    expect(searchBounds.y).toBeGreaterThanOrEqual(48);
    expect(optionBounds.y + optionBounds.height).toBeLessThanOrEqual(276);
    await expectFullyHittable(option, surface.locator(".kanban-assignee-options"));
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.assign(viewport, { offsetTop: 0, height: 480 });
      viewport.dispatchEvent(new Event("resize"));
    });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(surface).toBeHidden();
  }
});

async function refreshKanban(page: Page) {
  const response = page.waitForResponse(
    (response) => response.url().endsWith("/kanban") && response.request().method() === "GET",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await (await response).finished();
}

for (const [theme, language] of [
  ["light", "ru"],
  ["dark", "en"],
] as const) {
  const ru = language === "ru";

  test(`Kanban starts an explicitly selected mobile stage at the top, ${theme} ${language}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    await installKanbanAccessFixture(page, { theme, language, manyCards: true });
    const scroller = page.locator(".kanban-scroll");
    const todo = page.getByRole("tab", { name: ru ? /^К выполнению/ : /^To do/ });
    const ready = page.getByRole("tab", { name: ru ? /^Готовые/ : /^Ready/ });
    const scroll = () =>
      scroller.evaluate((node) => {
        node.scrollTop = 950;
        return node.scrollTop;
      });
    const position = () => scroller.evaluate((node) => node.scrollTop);
    expect(await scroll()).toBe(950);
    await refreshKanban(page);
    expect(await position()).toBe(950);

    await ready.click();
    await expect(ready).toHaveAttribute("aria-selected", "true");
    await expect.poll(position).toBe(0);
    await expect(
      page.getByRole("link", { name: "Добавить поиск по категориям", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: info.outputPath("stage-start.png") });

    expect(await scroll()).toBe(950);
    await ready.click();
    expect(await position()).toBe(950);
    await ready.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: ru ? /^Опубликовано/ : /^Published/ }),
    ).toBeFocused();
    expect(await position()).toBe(0);
    await todo.click();
    await expect(
      page.getByRole("button", { name: "Сохранить настройки фильтров", exact: true }),
    ).toBeInViewport();
  });

  test(`Kanban mobile stages retain bulk actions while desktop columns retain their layout, ${theme} ${language}`, async ({
    page,
  }, info) => {
    await installKanbanAccessFixture(page, { theme, language, manyCards: true });
    const todo = page.locator('.kanban-lane[data-stage-id="todo"]');
    const ready = page.locator('.kanban-lane[data-stage-id="ready"]');
    await todo.getByRole("separator").press("ArrowRight");
    const width = (await todo.boundingBox())!.width;
    for (const lane of [todo, ready]) {
      await lane.locator(".kanban-lane-menu > summary").click();
      await lane.getByRole("button", { name: ru ? "Свернуть" : "Collapse", exact: true }).click();
      await expect(lane.locator(".kanban-lane-strip")).toBeVisible();
      await expect(lane.locator(".kanban-lane-action")).toBeHidden();
    }
    await page.setViewportSize(PHONE_VIEWPORT);
    await todo.getByRole("checkbox").nth(0).check();
    await todo.getByRole("checkbox").nth(1).check();
    await expect(
      todo.getByRole("button", { name: ru ? "Запустить вместе (2)" : "Start together (2)" }),
    ).toBeEnabled();
    await page.screenshot({ path: info.outputPath("mobile-start-together.png") });
    await page.getByRole("tab", { name: ru ? /^Готовые/ : /^Ready/ }).click();
    await expect(
      ready.getByRole("button", { name: ru ? "Опубликовать все" : "Publish all" }),
    ).toBeEnabled();
    await page.screenshot({ path: info.outputPath("mobile-publish-all.png") });

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await expect(ready.locator(".kanban-lane-strip")).toBeVisible();
    await todo.locator(".kanban-lane-strip").click();
    await expect.poll(async () => (await todo.boundingBox())?.width).toBe(width);
  });
}

test("Kanban keeps action and refresh errors until their own retry", async ({ page }, info) => {
  const { card } = await installKanbanAccessFixture(page);
  const endpoint = "**/api/v1/projects/project-nest/kanban**";
  const readError = "Тестовая ошибка загрузки";
  const patchError = "Тестовая ошибка сохранения";
  let failRead = false;
  let failPatch = true;
  await page.route(endpoint, (route) => {
    const method = route.request().method();
    const message =
      method === "GET" && failRead
        ? readError
        : method === "PATCH" && failPatch
          ? patchError
          : null;
    if (!message) return route.fallback();
    return route.fulfill({
      status: method === "GET" ? 503 : 409,
      headers: { "access-control-allow-origin": "*" },
      json: { error: { code: "fixture", message } },
    });
  });

  await page.getByRole("button", { name: card.title, exact: true }).click();
  const panel = page.getByRole("complementary", { name: card.title });
  const stage = panel.getByRole("combobox", { name: "Стадия" });
  await stage.selectOption("ready");
  const actionAlert = panel.getByRole("alert").filter({ hasText: patchError });
  await expect(actionAlert).toBeVisible();
  await refreshKanban(page);
  await expect(actionAlert).toBeVisible();

  failRead = true;
  await refreshKanban(page);
  const banner = page.locator(".kanban-error");
  await expect(banner).toContainText(readError);
  await expect(actionAlert).toBeVisible();
  failRead = false;
  await banner.getByRole("button", { name: "Повторить" }).click();
  await expect(banner).not.toContainText(readError);
  await expect(actionAlert).toBeVisible();
  await page.screenshot({ path: info.outputPath("edit-error-after-refresh.png") });

  failPatch = false;
  await stage.selectOption("ready");
  await expect(actionAlert).toBeHidden();
  await expect(stage).toHaveValue("ready");
  await expect(banner).toBeHidden();
});

for (const viewport of [DESKTOP_VIEWPORT, PHONE_VIEWPORT, { width: 390, height: 500 }]) {
  const touch = viewport.width < 821;
  test.describe(`Kanban creation actions at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: touch, isMobile: touch });

    test("a single pointer action opens attachments or closes the form with the picker open", async ({
      page,
    }, info) => {
      const { labels } = await installKanbanAccessFixture(page, {
        theme: touch ? "dark" : "light",
      });
      const activate = (locator: Locator) => (touch ? locator.tap() : locator.click());
      await activate(page.getByRole("button", { name: labels.add, exact: true }));
      const dialog = page.getByRole("dialog", { name: labels.add, exact: true });
      const trigger = dialog.locator(".kanban-assignee-trigger");
      const search = dialog.getByRole("searchbox", { name: labels.search });
      const choice = dialog.getByRole("button", { name: "Анна Морозова", exact: true });
      await activate(trigger);
      await expect(choice).toBeAttached();
      await search.fill("мороз");
      await expect(choice).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath("creation-search.png") });
      await activate(dialog.getByRole("button", { name: "Добавить изображения", exact: true }));
      const attachments = dialog.getByRole("dialog", { name: "Вложения", exact: true });
      await expect(attachments).toBeVisible();
      await expect(search).toBeHidden();
      await page.screenshot({ path: info.outputPath("creation-attachments.png") });
      await page.keyboard.press("Escape");
      await expect(attachments).toBeHidden();
      await activate(trigger);
      await expect(choice).toBeAttached();
      await activate(dialog.getByRole("button", { name: labels.close, exact: true }));
      await expect(dialog).toBeHidden();
    });
  });
}

test("Kanban retries the unavailable catalogue and refreshes order on each opening", async ({
  page,
}, info) => {
  const { labels, workers, catalogueReads, creations } = await installKanbanAccessFixture(page);
  let unavailable = true;
  await page.route("**/api/v1/workers/catalog", (route) => {
    if (route.request().method() === "OPTIONS" || !unavailable) return route.fallback();
    unavailable = false;
    return route.fulfill({
      status: 503,
      headers: { "access-control-allow-origin": "*" },
      json: { error: { code: "fixture", message: "Catalogue unavailable" } },
    });
  });
  await page.getByRole("button", { name: labels.add, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: labels.add });
  const trigger = dialog.locator(".kanban-assignee-trigger");
  const options = dialog.locator(".kanban-assignee-options").getByRole("button");
  const names = () => [labels.defaultWorker, ...workers.map((worker) => worker.name)];
  expect(catalogueReads()).toBe(0);
  await trigger.press("Enter");
  await expect(
    dialog.getByRole("status").filter({ hasText: "Каталог работников недоступен." }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("catalogue-retry.png") });
  await dialog.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(options).toHaveText(names());
  const selected = workers.at(-1)!;
  await dialog.getByRole("searchbox").fill(selected.name);
  await dialog.getByRole("searchbox").press("Enter");
  await expect(trigger).toContainText(selected.name);
  workers.unshift(workers.pop()!);
  await trigger.press("Enter");
  await expect(options).toHaveText(names());
  await expect(options.nth(1)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  workers.shift();
  await trigger.press("Enter");
  await expect(options).toHaveText(names());
  await expect(trigger).toContainText("Назначенный работник");
  await page.keyboard.press("Escape");

  const message = dialog.getByRole("textbox", { name: labels.message });
  await message.fill("Оставить назначенного исполнителя");
  await message.press("Control+Enter");
  await expect(dialog).toBeHidden();
  expect(creations[0]?.workerId).toBe(selected.id);
  expect(catalogueReads()).toBe(3);
});

for (const { query, target, viewport = DESKTOP_VIEWPORT } of [
  { query: "?card=card-0", target: '.kanban-card[data-card-id="card-0"] button.kanban-card-open' },
  { query: "?thread=session-3", target: '.kanban-card[data-card-id="card-3"] .kanban-card-edit' },
  { query: "?card=archived", target: ".kanban-add-button" },
  { query: "?card=card-3", target: ".kanban-add-button", viewport: PHONE_VIEWPORT },
]) {
  test(`Kanban restores focus after ${query} at width ${viewport.width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await installKanbanAccessFixture(page, {
      query,
      configureBoard(board) {
        if (query !== "?thread=session-3") return;
        const group = board.runs.find((run) => run.threadId === "session-3")!;
        group.cardIds.unshift("card-0");
        board.runs.push({
          ...group,
          id: "new-session",
          cardIds: ["card-0"],
          threadId: "other-thread",
        });
      },
    });
    const panel = page.locator(".kanban-panel");
    await expect(panel.locator("#kanban-card-title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.locator(target)).toBeFocused();
    await expect(page.locator(target)).toBeInViewport();
    await page.screenshot({ path: info.outputPath("deep-link-focus.png") });
  });
}

test("Kanban locks stage and worker during work and deletion during classification", async ({
  page,
}, info) => {
  const { card, archived, patches, catalogueReads } = await installKanbanAccessFixture(page, {
    configureBoard(board) {
      board.runs.push(
        {
          ...board.runs[0]!,
          id: "execute-queued",
          cardIds: ["card-0"],
          status: "queued",
          threadId: null,
          sessionUrl: null,
        },
        {
          ...board.runs[0]!,
          id: "classify-preparing",
          kind: "classify",
          cardIds: ["archived"],
          status: "preparing",
          threadId: null,
          sessionUrl: null,
        },
      );
    },
  });
  await page.getByRole("button", { name: card.title, exact: true }).click();
  const panel = page.getByRole("complementary", { name: card.title });
  await expect(panel.getByRole("combobox", { name: "Стадия" })).toBeDisabled();
  await expect(panel.getByRole("combobox", { name: "Категория" })).toBeEnabled();
  await expect(panel.locator(".kanban-assignee-trigger")).toHaveAttribute("aria-disabled", "true");
  await panel.locator(".kanban-assignee-trigger").press("Enter");
  await expect(panel.getByRole("searchbox")).toBeHidden();
  expect(catalogueReads()).toBe(0);
  await panel.getByRole("button", { name: "Закрыть", exact: true }).click();

  await page.locator(".kanban-archive-button").click();
  const archive = page.getByRole("complementary", { name: "Архив" });
  const remove = archive.getByRole("button", { name: "Удалить навсегда" });
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAccessibleDescription(
    "Дождитесь завершения работы с задачей, чтобы удалить её.",
  );
  await expect(archive.getByRole("button", { name: "Вернуть" })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("archive-classifying.png") });
  await archive.getByRole("button", { name: "Вернуть" }).click();
  await expect(archive.getByText(archived.title)).toBeHidden();
  expect(patches).toEqual([{ archived: false }]);
});

for (const knownThread of [true, false]) {
  test(`Kanban shows only partners that still share the current session (thread: ${knownThread})`, async ({
    page,
  }, info) => {
    const { card } = await installKanbanAccessFixture(page, {
      configureBoard(board) {
        board.cards[0]!.description = "Проверить текущий состав группы.";
        const lead = board.cards[0]!;
        const joined = ["same-run", "same-thread", "moved", "other-provider", "archived"];
        board.cards.push(
          ...joined.slice(0, 4).map((id, index) => ({
            ...lead,
            id,
            title: [
              "Проверить сохранение в группе",
              "Добавить отчёт проверки",
              "Отдельная задача",
              "В другой сессии",
            ][index]!,
          })),
        );
        const group = {
          ...board.runs[0]!,
          id: "group",
          cardIds: [lead.id, ...joined],
          status: "completed" as const,
          threadId: knownThread ? "session-main" : null,
        };
        board.runs.push(
          group,
          {
            ...group,
            id: "same-thread-turn",
            cardIds: ["same-thread"],
            createdAt: group.createdAt - 1,
          },
          {
            ...group,
            id: "moved-turn",
            cardIds: ["moved"],
            threadId: null,
            sessionUrl: null,
            createdAt: group.createdAt - 1,
          },
          { ...group, id: "other-provider-turn", cardIds: ["other-provider"], provider: "claude" },
          { ...group, id: "classify", cardIds: ["same-run"], kind: "classify" },
        );
      },
    });
    await page
      .locator('.kanban-card[data-card-id="card-0"]')
      .locator(knownThread ? ".kanban-card-edit" : ".kanban-card-open")
      .click();
    const panel = page.getByRole("complementary", { name: card.title });
    const partners = panel
      .locator(".kanban-panel-section")
      .filter({ has: page.getByRole("heading", { name: "В той же сессии" }) });
    await expect(partners.getByRole("button")).toHaveText(
      knownThread
        ? ["Проверить сохранение в группеК выполнению", "Добавить отчёт проверкиК выполнению"]
        : ["Проверить сохранение в группеК выполнению"],
    );
    await page.screenshot({ path: info.outputPath("session-partners.png") });
  });
}

test("Kanban ignores a late catalogue response from the previous project", async ({ page }) => {
  const { labels } = await installKanbanAccessFixture(page);
  const projects: string[][] = [];
  let finishOld!: () => void;
  const oldResponse = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  await page.route("**/api/v1/projects/project-mineral/kanban", (route) =>
    route.fulfill({ headers, json: { ...seedBoard(), id: "mineral-board" } }),
  );
  await page.route("**/api/v1/workers/catalog", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const { projectIds } = route.request().postDataJSON() as { projectIds: string[] };
    projects.push(projectIds);
    const projectId = projectIds[0]!;
    if (projectId === "project-nest") await oldResponse;
    const name = projectId === "project-nest" ? "Работник первого проекта" : "Геолог";
    await route.fulfill({
      headers,
      json: { projects: [{ projectId, workers: [{ id: projectId, name }] }] },
    });
  });

  const openCreate = page.getByRole("button", { name: labels.add, exact: true });
  const dialog = page.getByRole("dialog", { name: labels.add });
  try {
    await openCreate.click();
    await dialog.locator(".kanban-assignee-trigger").press("Enter");
    await expect.poll(() => projects.length).toBe(1);
    await dialog.getByRole("button", { name: labels.close, exact: true }).click();
    const projectsMenu = page.locator(".kanban-project-picker");
    await projectsMenu.locator("summary").press("Enter");
    await projectsMenu.getByRole("button", { name: "Минеральный атлас", exact: true }).click();
    await expect(page).toHaveURL(/project-mineral\/kanban$/);
    expect(projects).toEqual([["project-nest"]]);
    await openCreate.click();
    await dialog.locator(".kanban-assignee-trigger").press("Enter");
    const workers = dialog.locator(".kanban-assignee-options").getByRole("button");
    await expect(workers).toHaveText([labels.defaultWorker, "Геолог"]);
    const oldLoaded = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.request().url().endsWith("/workers/catalog") &&
        response.request().postDataJSON().projectIds[0] === "project-nest",
    );
    finishOld();
    await (await oldLoaded).finished();
    await expect(workers).toHaveText([labels.defaultWorker, "Геолог"]);
    expect(projects).toEqual([["project-nest"], ["project-mineral"]]);
  } finally {
    finishOld();
  }
});

test.describe("Kanban interrupted touch drag", () => {
  test.use({ hasTouch: true, viewport: PHONE_VIEWPORT });

  test("cancelling a lifted card clears its slot and the next release still reorders", async ({
    page,
    browserName,
  }, info) => {
    test.skip(browserName !== "chromium", "Touch drag input uses Chromium CDP");
    const { patches } = await installKanbanAccessFixture(page, { manyCards: true });
    const source = page.locator('.kanban-card[data-card-id="todo-2"]');
    const first = page.locator('.kanban-card[data-card-id="card-0"]');
    const slot = page.locator(".kanban-drop-slot");
    const cdp = await page.context().newCDPSession(page);
    try {
      for (const type of ["touchCancel", "touchEnd"] as const) {
        const box = (await source.boundingBox())!;
        const target = (await first.boundingBox())!;
        const x = box.x + box.width / 2;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y: box.y + box.height * 0.65 }],
        });
        await expect(source).toHaveClass(/dragging/);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: target.y + 8 }],
        });
        await expect(slot).toBeVisible();
        if (type === "touchCancel") {
          await page.screenshot({ path: info.outputPath("touch-lifted.png") });
        }
        await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: [] });
        await expect(slot).toBeHidden();
        await expect(source).not.toHaveClass(/dragging/);
        if (type === "touchCancel") {
          await page.waitForLoadState("networkidle");
          expect(patches).toEqual([]);
          await page.screenshot({ path: info.outputPath("touch-cancelled.png") });
        } else {
          await expect.poll(() => patches).toEqual([{ beforeCardId: "card-0" }]);
        }
      }
    } finally {
      await cdp.detach();
    }
  });
});

test("Kanban offers one archive action and restores its visible opener at compact widths", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1000, height: 844 });
  await installKanbanAccessFixture(page);
  const pane = page.locator(".kanban-pane");
  const footprint = 1000 - (await pane.boundingBox())!.width;
  const direct = page.locator(".kanban-archive-button");
  const compact = page.locator(".kanban-filter-menu");
  const more = compact.locator("summary");
  const headerArchive = page
    .locator(".workspace-header")
    .getByRole("button", { name: "Архив", exact: true });
  const archive = page.getByRole("dialog", { name: "Архив" });

  for (const width of [390, 360, footprint + 640]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(direct).toBeHidden();
    await more.press("Enter");
    await expect(headerArchive).toHaveCount(1);
    await expect(headerArchive).toBeVisible();
    if (width === 390) await page.screenshot({ path: info.outputPath("compact-archive.png") });
    await headerArchive.press("Enter");
    await expect(archive.locator("#kanban-archive-title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(archive).toBeHidden();
    await expect(more).toBeFocused();
  }

  await page.setViewportSize({ width: footprint + 641, height: 844 });
  await expect(compact).toBeHidden();
  await expect(direct).toBeVisible();
  await expect(headerArchive).toHaveCount(1);
  await direct.press("Enter");
  await expect(archive).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(direct).toBeFocused();

  await direct.press("Enter");
  await expect(archive).toBeVisible();
  await page.setViewportSize({ width: footprint + 640, height: 844 });
  await page.keyboard.press("Escape");
  await expect(archive).toBeHidden();
  await expect(more).toBeFocused();
});
