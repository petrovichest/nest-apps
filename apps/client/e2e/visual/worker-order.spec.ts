import { expect, test, type Locator, type Page } from "@playwright/test";
import type { KanbanBoard, WorkerProfile } from "@codexnest/protocol";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  installVisualFixture,
  snapshot,
  waitForVisualReady,
} from "./fixtures";

const projectId = "project-nest";
const cardTitle = "Проверить навигацию";
const now = Date.UTC(2026, 10, 3, 12);
const board: KanbanBoard = {
  id: "board",
  projectPath: "/work/codex-nest",
  revision: 1,
  createdAt: now,
  updatedAt: now,
  stages: [
    { id: "todo", role: "todo", name: "К выполнению", description: "" },
    { id: "working", role: "working", name: "В работе", description: "" },
  ],
  categories: [],
  cards: [
    {
      id: "existing-card",
      title: cardTitle,
      description: "",
      stageId: "todo",
      classification: "ready",
      error: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
  runs: [],
};
const architect: WorkerProfile = {
  id: "architect",
  projectKey: null,
  name: "Architect",
  role: "",
  instructions: "",
  settings: {},
  revision: 0,
};
const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
};
const grid = (page: Page, id = projectId) => page.locator(`.workers-grid[data-project-id="${id}"]`);

async function fixture(
  page: Page,
  theme: "light" | "dark",
  language: "ru" | "en",
  count = 4,
  rejectFirstMove = false,
) {
  const ru = language === "ru";
  const projects = [
    { ...snapshot.projects[0]!, displayName: "Nest Apps" },
    snapshot.projects[1]!,
    {
      ...snapshot.projects[0]!,
      id: "project-research",
      path: "/work/research",
      displayName: ru ? "Проект исследований" : "Research project",
    },
  ];
  await installVisualFixture(page, { theme, language, snapshot: { ...snapshot, projects } });
  const names = ru
    ? ["Тимлид", "Фронтенд", "Бэкенд", "Контролёр"]
    : ["Team lead", "Frontend", "Backend", "Reviewer"];
  const roles = ru
    ? [
        "Координирует работу",
        "Разрабатывает интерфейс",
        "Поддерживает сервер",
        "Проверяет сценарии",
      ]
    : [
        "Coordinates project work",
        "Builds client screens",
        "Maintains the server",
        "Checks user flows",
      ];
  function profiles(key: string, groupIndex: number, length: number): WorkerProfile[] {
    return Array.from({ length }, (_, index) => ({
      ...architect,
      id: `843d721f-ae11-4d09-b3e3-b61d08fcc${(groupIndex * 100 + index).toString(16).padStart(3, "0")}`,
      projectKey: key,
      name: names[index] ?? `Worker ${index + 1}`,
      role: roles[index] ?? roles[0]!,
      revision: 1,
      coordinates: index === 0,
    }));
  }
  const groups = projects.map(({ id }, index) => ({
    projectId: id,
    workers: profiles(
      ["project-b", "canonical-mineral", "project-a"][index]!,
      index,
      index === 0 ? count : 4,
    ),
  }));
  const project = groups[0]!;
  const requests: { workerId: string; targetIndex: number }[] = [];
  const launches: string[] = [];
  let catalogueReads = 0;
  await page.route("**/api/v1/workers/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname.endsWith("/catalog")) {
      expect(request.method()).toBe("POST");
      catalogueReads++;
      return route.fulfill({
        headers,
        json: {
          common: [architect],
          projects: groups.filter(({ projectId }) =>
            request.postDataJSON().projectIds.includes(projectId),
          ),
        },
      });
    }
    expect(url.searchParams.get("projectId")).toBe(projectId);
    const id = url.pathname.split("/")[4]!;
    if (url.pathname.endsWith("/sessions")) {
      expect(request.method()).toBe("POST");
      launches.push(id);
      return route.fulfill({ headers, json: { threadId: "session-main" } });
    }
    if (id !== "order") {
      expect(request.method()).toBe("GET");
      return route.fulfill({
        headers,
        json: { profile: project.workers.find((worker) => worker.id === id), memory: [] },
      });
    }
    expect(request.method()).toBe("PATCH");
    const move = request.postDataJSON();
    requests.push(move);
    if (rejectFirstMove && requests.length === 1) {
      return route.fulfill({
        headers,
        status: 409,
        json: { error: { message: "Order write rejected" } },
      });
    }
    const workers = [...project.workers];
    const from = workers.findIndex(({ id }) => id === move.workerId);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(move.targetIndex).not.toBe(from);
    expect(move.targetIndex).toBeGreaterThanOrEqual(0);
    expect(move.targetIndex).toBeLessThan(workers.length);
    const [moved] = workers.splice(from, 1);
    workers.splice(move.targetIndex, 0, moved!);
    project.workers = workers;
    return route.fulfill({ headers, json: workers });
  });
  await page.route("**/api/v1/projects/project-nest/kanban", (route) =>
    route.fulfill({ headers, json: board }),
  );
  await page.goto("/workers");
  await expect(grid(page).locator(".worker-tile")).toHaveCount(count);
  await waitForVisualReady(page);
  return {
    workers: project.workers,
    names,
    requests,
    launches,
    catalogueReads: () => catalogueReads,
  };
}

async function center(card: Locator) {
  const box = await card.boundingBox();
  if (!box) throw new Error("Worker card has no layout");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragInput(page: Page, touch: boolean) {
  const cdp = touch ? await page.context().newCDPSession(page) : undefined;
  return {
    async start(card: Locator, hold = touch) {
      const point = await center(card);
      if (cdp) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        if (hold) await expect(card.locator("..")).toHaveAttribute("data-worker-dragging", "true");
      } else {
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
      }
      return point;
    },
    async move(point: { x: number; y: number }) {
      if (cdp)
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
      else await page.mouse.move(point.x, point.y, { steps: 6 });
    },
    async end(cancel = false) {
      if (cdp) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: cancel ? "touchCancel" : "touchEnd",
          touchPoints: [],
        });
      } else {
        if (cancel) await page.keyboard.press("Escape");
        await page.mouse.up();
      }
    },
  };
}

for (const viewport of [DESKTOP_VIEWPORT, PHONE_VIEWPORT]) {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["ru", "en"] as const) {
      const mobile = viewport.width === 390;
      test(`reorders worker cards at ${viewport.width}px ${theme}/${language}`, async ({
        browser,
        browserName,
        baseURL,
      }, info) => {
        const page = await browser.newPage({
          baseURL,
          viewport,
          hasTouch: mobile,
          reducedMotion: "reduce",
        });
        try {
          const touch = mobile && browserName === "chromium";
          const ru = language === "ru";
          const rejectFirst = !mobile && theme === "light" && ru;
          const { workers, names, requests, launches, catalogueReads } = await fixture(
            page,
            theme,
            language,
            4,
            rejectFirst,
          );
          const [first, second, third, fourth] = names;
          const catalogue = page.locator(".worker-catalogue");
          const cards = grid(page).locator(".worker-tile");
          const labels = cards.locator("strong");
          const other = grid(page, "project-mineral").locator("strong");
          const lead = cards.filter({ has: page.getByText(first!, { exact: true }) });
          const target = cards.nth(1);
          const drag = await dragInput(page, touch);
          const dragSource = grid(page).locator("[data-worker-dragging]");
          const drop = grid(page).locator("[data-worker-drop]");
          const screenshot = (name: string) => page.screenshot({ path: info.outputPath(name) });
          const before = catalogueReads();
          await expect(
            catalogue.locator("section").first().locator(".worker-tile strong"),
          ).toHaveText(ru ? "Архитектор" : "Architect");
          await expect(
            catalogue.locator("section").first().locator(".worker-tile"),
          ).not.toHaveAttribute("aria-keyshortcuts");
          await expect(
            catalogue.getByRole("button", { name: /Изменить порядок|Change order/ }),
          ).toHaveCount(0);
          await expect(labels).toHaveText(names);
          await screenshot("workers-idle.png");

          let point = await drag.start(lead);
          await drag.move({ ...point, x: point.x + 8 });
          await expect(dragSource).toContainText(first!);
          await expect(drop).toHaveCount(0);
          await drag.end();
          await expect(dragSource).toHaveCount(0);

          await drag.start(lead);
          await drag.move(await center(target));
          await expect(drop).toContainText(second!);
          await screenshot("workers-during-drag.png");
          await drag.end(true);
          await expect(drop).toHaveCount(0);
          await expect(lead).toBeFocused();

          await drag.start(lead);
          await drag.move(await center(target));
          await expect(drop).toHaveCount(1);
          point = mobile
            ? { x: 4, y: 300 }
            : await center(grid(page, "project-mineral").locator(".worker-tile").first());
          await drag.move(point);
          await expect(catalogue.locator("[data-worker-drop]")).toHaveCount(0);
          await drag.end();
          await expect(labels).toHaveText(names);
          expect(requests).toEqual([]);
          expect(launches).toEqual([]);

          const move = { workerId: workers[0]!.id, targetIndex: 1 };
          async function dropOnSecond() {
            await drag.start(lead);
            await drag.move(await center(target));
            await expect(drop).toContainText(second!);
            await drag.end();
          }
          await dropOnSecond();
          if (rejectFirst) {
            await expect(catalogue.getByRole("alert")).toHaveText(
              "Не удалось сохранить порядок. Повторите перемещение.",
            );
            await expect(labels).toHaveText(names);
            await expect(lead).toBeFocused();
            expect(requests).toEqual([move]);
            await screenshot("workers-save-error.png");
            await dropOnSecond();
          }
          let ordered = [second!, first!, third!, fourth!];
          await expect(labels).toHaveText(ordered);
          await expect(lead).toBeFocused();
          await expect(other).toHaveText(names);
          expect(requests).toEqual(rejectFirst ? [move, move] : [move]);
          expect(launches).toEqual([]);

          // On the phone, also move into another row. Desktop cross-row and
          // sustained autoscroll are covered by the long catalogue below.
          if (mobile) {
            await drag.start(lead);
            await drag.move(await center(cards.last()));
            await expect(drop).toContainText(fourth!);
            await screenshot("workers-during-cross-row-drag.png");
            await drag.end();
            ordered = [second!, third!, fourth!, first!];
            await expect(labels).toHaveText(ordered);
            expect(requests.at(-1)).toEqual({ ...move, targetIndex: 3 });
            expect(requests).toHaveLength(2);
            await page.setViewportSize({ width: 320, height: 640 });
            expect(
              await catalogue.evaluate((node) => node.scrollWidth - node.clientWidth),
            ).toBeLessThanOrEqual(1);
            await page.setViewportSize(viewport);
          } else if (rejectFirst) {
            await lead.press("Alt+ArrowRight");
            ordered = [second!, third!, first!, fourth!];
            await expect(labels).toHaveText(ordered);
            await expect(lead).toBeFocused();
            expect(requests).toEqual([move, move, { ...move, targetIndex: 2 }]);
          }
          expect(catalogueReads()).toBe(before);
          await page.reload();
          await expect(labels).toHaveText(ordered);
          const settings = grid(page).getByRole("button", {
            name: ru ? `Настройки работника «${second}»` : `Settings for ${second}`,
          });
          await settings.click();
          const profile = page.getByRole("dialog", { name: second, exact: true });
          await expect(profile.locator("input").first()).toHaveValue(second!);
          await page.keyboard.press("Escape");
          await expect(settings).toBeFocused();

          const beforeKanban = catalogueReads();
          await page.goto(`/projects/${projectId}/kanban`);
          const add = ru ? "Добавить задачу" : "Add task";
          await page.getByRole("button", { name: add, exact: true }).first().click();
          const create = page.getByRole("dialog", { name: add });
          async function checkPicker(container: Locator, name: string) {
            await container.locator(".kanban-assignee-trigger").click();
            const list = container.locator(".kanban-assignee-options");
            const options = list.getByRole("button");
            const expectedOrder = [ru ? "Стандартная сессия" : "Standard session", ...ordered];
            await expect(options).toHaveText(expectedOrder);
            if (container === create) {
              const search = container.getByRole("searchbox");
              const geometry = () =>
                Promise.all([
                  container.boundingBox(),
                  search.boundingBox(),
                  container.evaluate((element) => element.scrollTop),
                  page.evaluate(() => document.scrollingElement!.scrollTop),
                ]);
              const beforeScroll = await geometry();
              // Search stays fixed while the results scroll to reveal the last worker.
              await list.evaluate((element) => (element.scrollTop = element.scrollHeight));
              const last = options.last();
              await expect(last).toBeInViewport({ ratio: 1 });
              expect(
                await last.evaluate(
                  (element, { x, y }) => element.contains(document.elementFromPoint(x, y)),
                  await center(last),
                ),
              ).toBe(true);
              expect(await geometry()).toEqual(beforeScroll);
              await expect(options).toHaveText(expectedOrder);
            }
            await waitForVisualReady(page);
            await screenshot(name);
            await page.keyboard.press("Escape");
          }
          await checkPicker(create, "kanban-create.png");
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: cardTitle, exact: true }).click();
          await checkPicker(page.locator(".kanban-panel"), "kanban-edit.png");
          expect(catalogueReads()).toBe(beforeKanban + 2);

          await page.goto("/workers");
          if (touch) await cards.first().tap();
          else await cards.first().click();
          await expect(page).toHaveURL(/\/threads\/session-main$/u);
          await page.goto("/workers");
          await cards.first().press("Enter");
          await expect(page).toHaveURL(/\/threads\/session-main$/u);
          expect(launches).toEqual([workers[1]!.id, workers[1]!.id]);
        } finally {
          await page.close();
        }
      });
    }
  }
}

for (const viewport of [DESKTOP_VIEWPORT, PHONE_VIEWPORT]) {
  test(`autoscrolls within a long catalogue at ${viewport.width}px`, async ({
    browser,
    browserName,
    baseURL,
  }) => {
    const touch = viewport.width === 390;
    test.skip(touch && browserName !== "chromium", "Touch input uses Chromium CDP");
    const page = await browser.newPage({
      baseURL,
      viewport,
      hasTouch: touch,
      reducedMotion: "reduce",
    });
    try {
      const { workers, requests, launches } = await fixture(page, "dark", "en", 24);
      const cards = grid(page).locator(".worker-tile");
      const catalogue = page.locator(".worker-catalogue");
      const scrollTop = () => catalogue.evaluate((node) => node.scrollTop);
      const drag = await dragInput(page, touch);
      if (touch) {
        const point = await drag.start(cards.nth(4), false);
        await drag.move({ ...point, y: point.y - 150 });
        await drag.move({ ...point, y: point.y - 250 });
        await drag.end();
        await expect.poll(scrollTop).toBeGreaterThan(0);
        expect(requests).toEqual([]);
        expect(launches).toEqual([]);
        await cards.first().scrollIntoViewIfNeeded();
      }

      const point = await drag.start(cards.first());
      const bounds = (await catalogue.boundingBox())!;
      const initialScroll = await scrollTop();
      await drag.move({ x: point.x, y: bounds.y + bounds.height - 12 });
      await expect.poll(scrollTop).toBeGreaterThan(initialScroll + 50);
      const drop = grid(page).locator("[data-worker-drop]");
      await expect(drop).toHaveCount(1);
      expect(requests).toEqual([]);
      await drag.end();
      await expect.poll(() => requests).toHaveLength(1);
      expect(requests[0]!.workerId).toBe(workers[0]!.id);
      expect(requests[0]!.targetIndex).toBeGreaterThan(1);
      await expect(cards.nth(requests[0]!.targetIndex)).toContainText(workers[0]!.name);
      await expect(cards.nth(requests[0]!.targetIndex)).toBeFocused();
      await expect(cards.nth(requests[0]!.targetIndex)).toBeInViewport();
    } finally {
      await page.close();
    }
  });
}
