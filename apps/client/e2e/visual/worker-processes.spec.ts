import { resolve } from "node:path";
import type { WorkerProcess, WorkerProcessSession } from "@codexnest/protocol";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { installVisualFixture, waitForVisualReady } from "./fixtures";

function session(
  id: string,
  workerName: string,
  title: string,
  details: Partial<WorkerProcessSession> = {},
): WorkerProcessSession {
  return {
    id,
    workerId: id,
    workerName,
    parentId: null,
    title,
    provider: "codex",
    threadId: id,
    sessionUrl: `/threads/${id}`,
    kind: "session",
    status: "running",
    waitingFor: [],
    createdAt: 1,
    updatedAt: 2,
    ...details,
  };
}

const project = { projectKey: "mineral", projectName: "Минеральный атлас" };
const processes: WorkerProcess[] = [
  {
    ...project,
    id: "import",
    sessions: [
      session("import", "Тимлид импорта", "Исправить импорт CSV", {
        status: "waiting",
        waitingFor: ["review-import"],
      }),
      session("parser", "Разработчик", "Исправить разбор CSV", {
        parentId: "import",
        kind: "assignment",
        status: "completed",
        result: "Исправил разбор полей с кавычками и переносами строк. Проверки импорта прошли.",
      }),
      session("sample", "Тестировщик", "Как воспроизвести сбой импорта?", {
        parentId: "parser",
        kind: "question",
        status: "completed",
      }),
      session("review-import", "Ревьюер", "Проверить изменения парсера", {
        workerId: "reviewer",
        parentId: "import",
        kind: "assignment",
        description:
          "Проверить разбор полей с кавычками и переносами строк. Вернуть замечания и список проверок.",
      }),
      session("edge-cases", "Ревьюер", "Какие случаи проверить?", {
        workerId: "reviewer",
        parentId: "import",
        kind: "question",
        status: "completed",
      }),
    ],
  },
  {
    ...project,
    id: "release",
    sessions: [
      session("release", "Тимлид релиза", "Подготовить релиз каталога", {
        provider: "claude",
        sessionUrl: "https://claudenest.visual/threads/release",
      }),
      session("review-release", "Ревьюер", "Проверить изменения к релизу", {
        workerId: "reviewer",
        parentId: "release",
        provider: "claude",
        kind: "assignment",
        sessionUrl: "https://claudenest.visual/threads/review-release",
      }),
    ],
  },
];

async function installProcessesFixture(
  page: Page,
  theme: "light" | "dark",
  entries: WorkerProcess[],
) {
  await installVisualFixture(page, { theme });
  await page.route("http://127.0.0.1:4173/api/**", (route) => route.abort());
  await page.route("https://codexnest.visual/api/v1/workers/processes**", (route) => {
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "GET, OPTIONS",
    };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const processId = new URL(route.request().url()).searchParams.get("processId");
    return route.fulfill({
      headers,
      json: processId ? entries.filter(({ id }) => id === processId) : entries,
    });
  });
}

async function captureProcessPreview(page: Page, info: TestInfo, name: string) {
  if (info.project.name !== "chromium" || !process.env.NEST_WORKER_PROCESS_SCREENSHOTS) return;
  await waitForVisualReady(page);
  await page.screenshot({
    path: resolve(process.env.NEST_WORKER_PROCESS_SCREENSHOTS, `${name}.png`),
    animations: "disabled",
  });
}

for (const width of [1440, 390]) {
  test(`renders separate process branches and waiting paths at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await installProcessesFixture(page, "light", processes);
    await page.goto("/workers/processes");
    const rows = page.locator(".process-overview-run");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Тимлид импорта");
    await expect(rows.last()).toContainText("Тимлид релиза");
    await expect(rows.last()).toContainText("ClaudeNest");
    await captureProcessPreview(page, info, `overview-${width}`);
    await rows
      .first()
      .getByRole("link", { name: /^Тимлид импорта/ })
      .click();
    const graph = page.getByRole("region", { name: "Схема процесса" });
    const inspector = graph.locator(".process-inspector");
    await expect(graph.getByText("3 дополнительных работника · 4 сессии")).toBeVisible();
    await expect(graph.getByText("Тестировщик")).toBeVisible();
    const waitingPath = graph.locator('[data-awaiting="true"]');
    await expect(waitingPath).toContainText("Ревьюер");
    const colors = await waitingPath.evaluate((branch) => {
      const trunk = branch.parentElement!;
      const stem =
        trunk.getBoundingClientRect().width <= 470 ? branch.previousElementSibling! : trunk;
      return {
        stem: getComputedStyle(stem, "::before").borderInlineStartColor,
        tip: getComputedStyle(branch.querySelector(":scope > svg")!).color,
      };
    });
    expect(colors.stem).toBe(colors.tip);
    if (width === 390) await captureProcessPreview(page, info, `graph-${width}`);
    await graph.getByRole("button", { name: /^Ревьюер/ }).click();
    await expect(inspector.getByText("Тимлид импорта ждёт результата")).toBeVisible();
    await expect(inspector.getByText("Какие случаи проверить?")).toBeVisible();
    await expect(inspector.getByText("Проверить изменения к релизу")).toHaveCount(0);
    if (width === 1440) await captureProcessPreview(page, info, `graph-${width}`);
    const developer = graph.getByRole("button", { name: /^Разработчик/ });
    await developer.press("Enter");
    await expect(developer).toHaveAttribute("aria-pressed", "true");
    await expect(inspector.getByText(/Проверки импорта прошли/)).toBeVisible();
    await page.getByRole("navigation", { name: "Раздел работников" }).getByText("Процессы").click();
    await rows
      .last()
      .getByRole("link", { name: /^Ревьюер/ })
      .click();
    await expect(inspector.getByText("Поручил Тимлид релиза", { exact: false })).toBeVisible();
    await expect(inspector.getByRole("link", { name: "Открыть сессию" })).toHaveAttribute(
      "href",
      "https://claudenest.visual/threads/review-release",
    );
  });
}

const architect = "Архитектор работников";
const longName = "Координатор междисциплинарных стратегических исследований";
const strategy = { projectKey: "strategy", projectName: "strategy-research" };
const overviewPreview: WorkerProcess[] = [
  { ...strategy, id: "architect", sessions: [session("architect", architect, architect)] },
  {
    ...strategy,
    id: "strategy",
    sessions: [
      session("strategy", longName, "Сверить выводы стратегического исследования", {
        status: "waiting",
        waitingFor: ["research"],
      }),
      session("research", "Исследователь", "Подготовить обзор источников", {
        workerId: "researcher",
        parentId: "strategy",
        kind: "assignment",
        provider: "claude",
      }),
      session("question", "Исследователь", "Уточнить критерии выборки", {
        workerId: "researcher",
        parentId: "strategy",
        kind: "question",
        provider: "claude",
        status: "queued",
      }),
      session("review", "Редактор", "Редактор", {
        parentId: "strategy",
        kind: "assignment",
        provider: "open",
      }),
    ],
  },
];

const overviewPath = "/workers/processes";

for (const theme of ["light", "dark"] as const) {
  test(`process overview states on desktop in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installProcessesFixture(page, theme, overviewPreview);
    await page.goto(overviewPath);

    const nav = page.getByRole("navigation", { name: "Раздел работников" });
    const workersTab = nav.getByRole("link", { name: "Работники" });
    const activeTab = nav.getByRole("link", { name: "Процессы" });
    const row = page.getByRole("link", { name: new RegExp(`^${architect}`) });
    const sidebar = page.locator(".sidebar");
    await expect(activeTab).toHaveAttribute("aria-current", "page");
    await expect(row).toHaveAccessibleName(`${architect} CodexNest В работе`);
    await expect(page.getByRole("heading", { name: strategy.projectName })).toBeVisible();
    await expect(page.getByText("Редактор", { exact: true })).toHaveCount(2);
    await expect(page.getByText("2 сессии")).toBeVisible();
    await expect(page.getByText("Подготовить обзор источников")).toBeVisible();
    await expect(page.getByText("Уточнить критерии выборки")).toBeVisible();

    const surface = await sidebar.evaluate((element) => getComputedStyle(element).backgroundColor);
    const elevation = await activeTab.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(elevation).not.toBe("none");
    await expect(activeTab).toHaveCSS("background-color", surface);
    await expect(workersTab).toHaveCSS("box-shadow", "none");
    await expect(row).toHaveCSS("box-shadow", "none");
    await captureProcessPreview(page, info, `desktop-${theme}-rest`);

    const rowBounds = await row.boundingBox();
    await row.hover();
    await expect(row).toHaveCSS("background-color", surface);
    await expect(row).toHaveCSS("box-shadow", elevation);
    expect(await row.boundingBox()).toEqual(rowBounds);
    await captureProcessPreview(page, info, `desktop-${theme}-hover`);

    await workersTab.hover();
    await expect(workersTab).toHaveCSS("box-shadow", elevation);
    await activeTab.hover();
    await page.mouse.down();
    await expect(activeTab).toHaveCSS("box-shadow", /inset/);
    await page.mouse.up();
    await expect(activeTab).toHaveCSS("box-shadow", elevation);
    await page.mouse.move(1360, 700);
    await activeTab.focus();
    await page.keyboard.press("Tab");
    await expect(row).toBeFocused();
    await expect(row).toHaveCSS("outline-style", "solid");
    await expect(row).toHaveCSS("box-shadow", elevation);
    await captureProcessPreview(page, info, `desktop-${theme}-focus`);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${overviewPath}/architect$`));
    await expect(page.getByRole("heading", { name: architect, level: 2 })).toBeVisible();
  });
}

test.describe("process overview on touch", () => {
  test.use({ hasTouch: true });
  for (const [width, theme] of [
    [390, "light"],
    [390, "dark"],
    [320, "dark"],
    [821, "light"],
  ] as const) {
    test(`wraps names and opens details at ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await installProcessesFixture(page, theme, overviewPreview);
      await page.goto(overviewPath);
      expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);

      const row = page.getByRole("link", { name: new RegExp(`^${longName}`) });
      const label = row.getByText(longName);
      await expect(label).toBeVisible();
      expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const activeTab = page
        .getByRole("navigation", { name: "Раздел работников" })
        .getByRole("link", { name: "Процессы" });
      await expect(row).toHaveCSS("box-shadow", "none");
      await captureProcessPreview(page, info, `touch-${width}-${theme}-rest`);
      const elevation = await activeTab.evaluate((element) => getComputedStyle(element).boxShadow);
      await activeTab.tap();
      await expect(activeTab).toHaveCSS("box-shadow", elevation);
      const child = page.getByRole("link", { name: /^Исследователь/ });
      await child.tap();
      await expect(page).toHaveURL(`${overviewPath}/strategy?session=research`);
      await expect(
        page.locator(".process-inspector").getByText("Подготовить обзор источников"),
      ).toBeVisible();
    });
  }
});
