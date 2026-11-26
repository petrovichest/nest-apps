import { resolve } from "node:path";
import type { WorkerProcess, WorkerProcessSession } from "@codexnest/protocol";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

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
  language: "ru" | "en" = "ru",
) {
  await installVisualFixture(page, { theme, snapshot: { ...snapshot, uiLanguage: language } });
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
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await installProcessesFixture(page, "light", processes);
    await page.goto("/workers/processes");
    const rows = page.locator(".process-overview-run");
    await expect(rows).toHaveCount(2);
    const importing = page.getByRole("region", { name: "Ждёт результата" });
    const releasing = page.getByRole("region", { name: "В работе" });
    await expect(importing).toContainText("Тимлид импорта");
    await expect(releasing).toContainText("Тимлид релиза");
    await expect(releasing).toContainText("ClaudeNest");
    await captureProcessPreview(page, info, `overview-${width}`);
    await importing.getByRole("link", { name: /^Тимлид импорта/ }).click();
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
    await releasing.getByRole("link", { name: /^Ревьюер/ }).click();
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

async function expectRegularOverviewLabels(page: Page) {
  const labels = page.locator(
    [
      ".workers-tabs a",
      ".process-filter span",
      ".process-filter select",
      ".process-section > h2",
      ".process-project > h3",
      ".process-worker-label > *",
      ".process-session-list > li > span",
    ].join(", "),
  );
  const styles = await labels.evaluateAll((elements) =>
    elements.map((element) => {
      const { fontFamily, fontWeight } = getComputedStyle(element);
      return { label: element.textContent, fontFamily, fontWeight };
    }),
  );
  for (const { label, fontFamily, fontWeight } of styles) {
    expect(fontFamily, label ?? undefined).toMatch(/^Onest\b/);
    expect(fontWeight, label ?? undefined).toBe("400");
  }
}

async function expectPressedOverviewLabels(page: Page, link: Locator) {
  await link.evaluate((element) =>
    element.addEventListener("click", (event) => event.preventDefault(), { once: true }),
  );
  await page.mouse.down();
  await expect(link).toHaveCSS("box-shadow", /inset/);
  await expectRegularOverviewLabels(page);
  await page.mouse.up();
}

for (const theme of ["light", "dark"] as const) {
  test(`process overview states on desktop in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await installProcessesFixture(page, theme, overviewPreview);
    await page.goto(overviewPath);

    const nav = page.getByRole("navigation", { name: "Раздел работников" });
    const workersTab = nav.getByRole("link", { name: "Работники" });
    const activeTab = nav.getByRole("link", { name: "Процессы" });
    const row = page.getByRole("link", { name: new RegExp(`^${architect}`) });
    const sidebar = page.locator(".sidebar");
    await expect(activeTab).toHaveAttribute("aria-current", "page");
    await expect(row).toHaveAccessibleName(`${architect} CodexNest В работе`);
    await expect(page.getByRole("heading", { name: strategy.projectName, level: 3 })).toHaveCount(
      2,
    );
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
    await expectRegularOverviewLabels(page);
    await captureProcessPreview(page, info, `desktop-${theme}-rest`);

    const rowBounds = await row.boundingBox();
    await row.hover();
    await expect(row).toHaveCSS("background-color", surface);
    await expect(row).toHaveCSS("box-shadow", elevation);
    expect(await row.boundingBox()).toEqual(rowBounds);
    await expectRegularOverviewLabels(page);
    await captureProcessPreview(page, info, `desktop-${theme}-hover`);

    await expectPressedOverviewLabels(page, row);

    for (const tab of [workersTab, activeTab]) {
      await tab.hover();
      await expect(tab).toHaveCSS("box-shadow", elevation);
      await expectRegularOverviewLabels(page);
      await expectPressedOverviewLabels(page, tab);
    }
    await expect(activeTab).toHaveCSS("box-shadow", elevation);
    await page.mouse.move(1360, 700);
    await workersTab.focus();
    await page.keyboard.press("Tab");
    await expect(activeTab).toBeFocused();
    await expect(activeTab).toHaveCSS("outline-style", "solid");
    await expectRegularOverviewLabels(page);
    await page.keyboard.press("Shift+Tab");
    await expect(workersTab).toBeFocused();
    await expect(workersTab).toHaveCSS("outline-style", "solid");
    await expectRegularOverviewLabels(page);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const filter = page.getByRole("combobox", { name: "Статус" });
    await expect(filter).toBeFocused();
    await expect(filter).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("ArrowDown");
    await expect(filter).toHaveValue("В работе");
    await expect(page.locator(".process-section > h2")).toHaveText(["В работе"]);
    await page.keyboard.press("Home");
    await expect(filter).toHaveValue("all");
    await page.keyboard.press("Tab");
    await expect(row).toBeFocused();
    await expect(row).toHaveCSS("outline-style", "solid");
    await expect(row).toHaveCSS("box-shadow", elevation);
    await expectRegularOverviewLabels(page);
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
      await expectRegularOverviewLabels(page);
      await captureProcessPreview(page, info, `touch-${width}-${theme}-rest`);
      const filter = page.getByRole("combobox", { name: "Статус" });
      await filter.tap();
      await filter.selectOption("Ждёт результата");
      await expect(page.locator(".process-section > h2")).toHaveText(["Ждёт результата"]);
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

const asking: WorkerProcess = {
  ...strategy,
  id: "outline",
  sessions: [
    session("outline", "Редактор каталога", "Согласовать структуру каталога", {
      status: "waiting",
    }),
    session("samples", "Аналитик", "Собрать примеры для каталога", {
      parentId: "outline",
      kind: "assignment",
    }),
  ],
};

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["ru", "en"] as const) {
      test(`process status sections at ${width}px, ${theme}, ${language}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        await installProcessesFixture(page, theme, [...overviewPreview, asking], language);
        await page.goto(overviewPath);

        const names =
          language === "ru"
            ? ["Ждёт ответа", "В работе", "Ждёт результата"]
            : ["Awaiting an answer", "In progress", "Awaiting result"];
        const headings = page.locator(".process-section > h2");
        const filter = page.getByRole("combobox", {
          name: language === "ru" ? "Статус" : "Status",
        });
        await expect(filter).toHaveValue("all");
        await expect(filter.locator("option")).toHaveText([
          language === "ru" ? "Все" : "All",
          ...names,
        ]);
        await expect(headings).toHaveText(names);
        const waiting = page.getByRole("region", { name: names[0] });
        const child = waiting.getByRole("link", { name: /^Аналитик/ });
        await expect(child).toHaveAttribute("href", `${overviewPath}/outline?session=samples`);
        await expect(child.locator(".process-status")).toHaveText(names[1]!);
        await expect(page.getByRole("region", { name: names[1] })).not.toContainText("Аналитик");
        await expectRegularOverviewLabels(page);
        const content = page.locator(".processes-content");
        const fits = () =>
          content.evaluate((element) => element.scrollWidth <= element.clientWidth);
        expect(await fits()).toBe(true);
        await captureProcessPreview(page, info, `all-${width}-${theme}-${language}`);

        await filter.selectOption({ label: names[0]! });
        await expect(headings).toHaveText([names[0]!]);
        await expect(child.locator(".process-status")).toHaveText(names[1]!);
        expect(await fits()).toBe(true);
        await captureProcessPreview(page, info, `filtered-${width}-${theme}-${language}`);

        await child.click();
        await expect(page).toHaveURL(`${overviewPath}/outline?session=samples`);
        await expect(page.locator(".process-inspector")).toContainText(
          "Собрать примеры для каталога",
        );
        await expect(filter).toHaveCount(0);
        if (width === 390) {
          await page.locator(".process-breadcrumb a").click();
        } else {
          await page.goBack();
        }
        await expect(filter).toHaveValue("Ждёт ответа");
        await expect(headings).toHaveText([names[0]!]);

        await filter.selectOption("all");
        await expect(headings).toHaveText(names);
      });
    }
  }
}

test("regroups a whole branch after polling and only shows statuses present in the overview", async ({
  page,
}, info) => {
  const entries: WorkerProcess[] = [
    asking,
    {
      ...project,
      id: "answered",
      sessions: [
        session("answered", "Консультант", "Уточнить правила", {
          kind: "question",
          status: "completed",
        }),
        session("check", "Проверяющий", "Проверить правила", { parentId: "answered" }),
      ],
    },
    {
      projectKey: null,
      projectName: null,
      id: "failed",
      sessions: [
        session("failed", "Сборщик", "Собрать каталог", { status: "failed" }),
        session("retry", "Проверяющий", "Проверить сборку", {
          parentId: "failed",
          status: "queued",
        }),
      ],
    },
    {
      ...project,
      id: "queued",
      sessions: [session("queued", "Тестировщик", "Проверить каталог", { status: "queued" })],
    },
  ];
  await page.clock.install();
  await installProcessesFixture(page, "light", entries);
  await page.goto(overviewPath);

  const headings = page.locator(".process-section").getByRole("heading", { level: 2 });
  await expect(headings).toHaveText(["Ждёт ответа", "В очереди", "Ошибка", "Готово"]);
  const done = page.getByRole("region", { name: "Готово" });
  await expect(done.getByRole("link", { name: /^Консультант/ })).toContainText("Ответил");
  await expect(done.getByRole("link", { name: /^Проверяющий/ })).toContainText("В работе");
  await expect(page.getByRole("region", { name: "Ошибка" })).toContainText("Без проекта");

  const filter = page.getByRole("combobox", { name: "Статус" });
  await filter.selectOption("Ждёт ответа");
  await filter.focus();
  await expect(headings).toHaveText(["Ждёт ответа"]);

  const [root, child] = asking.sessions as [WorkerProcessSession, WorkerProcessSession];
  entries[0] = { ...asking, sessions: [{ ...root, waitingFor: [child.id] }, child] };
  await page.clock.fastForward(4_000);
  await expect(page.locator(".process-overview").getByRole("status")).toHaveText(
    "Нет процессов с этим статусом",
  );
  await expect(filter).toHaveValue("Ждёт ответа");
  await expect(filter).toBeFocused();
  await expect(filter.locator("option")).toHaveText([
    "Все",
    "Ждёт ответа",
    "Ждёт результата",
    "В очереди",
    "Ошибка",
    "Готово",
  ]);
  await expect(headings).toHaveCount(0);
  await captureProcessPreview(page, info, "filtered-empty-1440-light-ru");

  await filter.selectOption("all");
  await expect(filter.locator("option", { hasText: "Ждёт ответа" })).toHaveCount(0);
  await expect(headings).toHaveText(["Ждёт результата", "В очереди", "Ошибка", "Готово"]);
  const waitingForResult = page.getByRole("region", { name: "Ждёт результата" });
  await expect(waitingForResult.getByRole("link", { name: /^Аналитик/ })).toContainText("В работе");

  entries[0] = { ...asking, sessions: [{ ...root, status: "running" }, child] };
  await page.clock.fastForward(4_000);
  await expect(headings).toHaveText(["В работе", "В очереди", "Ошибка", "Готово"]);
  await expect(page.getByRole("region", { name: "В работе" }).getByRole("link")).toHaveCount(2);

  entries.length = 0;
  await page.clock.fastForward(4_000);
  await expect(page.getByText("Нет активных процессов")).toBeVisible();
  await expect(headings).toHaveCount(0);
});
