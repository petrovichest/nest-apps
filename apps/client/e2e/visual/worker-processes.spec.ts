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
    const rows = page.locator(".process-card");
    await expect(rows).toHaveCount(2);
    const importing = page.getByRole("region", { name: "Ждёт результата" });
    const releasing = page.getByRole("region", { name: "В работе" });
    await expect(importing).toContainText("Тимлид импорта");
    await expect(releasing).toContainText("Тимлид релиза");
    await expect(importing.locator(".process-signal-dots")).toHaveCount(0);
    await captureProcessPreview(page, info, `overview-${width}`);
    await importing.getByRole("link", { name: "Исправить импорт CSV" }).click();
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
    await releasing.getByRole("link", { name: "Подготовить релиз каталога" }).click();
    await graph.getByRole("button", { name: /^Ревьюер/ }).click();
    await expect(inspector.getByText("Поручил Тимлид релиза", { exact: false })).toBeVisible();
    await expect(inspector.getByRole("link", { name: "Открыть сессию" })).toHaveAttribute(
      "href",
      "https://claudenest.visual/threads/review-release",
    );
  });
}

const overviewPath = "/workers/processes";
const questionTitle = "Как назвать раздел о новых экспонатах?";
const resultText = "Подготовлены три варианта обложки.";
const sourceDescription = "Служебное поручение дизайнеру согласовать заголовок.";
const resultUrl = "https://claudenest.visual/threads/references";
const longTitle = "Согласовать правила импорта архивных карточек с неполными описаниями и датами";
const issue: WorkerProcess = {
  ...project,
  id: "issue",
  sessions: [
    session("issue", "Тимлид каталога", "Подготовить весенний выпуск каталога", {
      status: "waiting",
    }),
    session("title-question", "Дизайнер", questionTitle, {
      parentId: "issue",
      kind: "question",
      status: "waiting",
      signal: "actionRequired",
      description: sourceDescription,
    }),
    session("design", "Исследователь", "Проверить обложку", {
      parentId: "title-question",
      workerId: "researcher",
      provider: "claude",
    }),
    session("references", "Исследователь", "Подборка примеров для обложки", {
      parentId: "title-question",
      workerId: "researcher",
      provider: "claude",
      sessionUrl: resultUrl,
      kind: "assignment",
      status: "completed",
      signal: "unseenCompletion",
      result: resultText,
    }),
    session("extra", "Исследователь", "Архивные примеры для обложки", {
      parentId: "title-question",
      workerId: "researcher",
      status: "completed",
      signal: "unseenCompletion",
    }),
  ],
};
const archiveTitle = "Уточнить доступ к закрытым фондам";
const finished: WorkerProcess = {
  ...project,
  id: "catalogue",
  sessions: [
    session("catalogue", "Тимлид каталога", "Собрать выпуск каталога", { status: "completed" }),
    session("layout", "Верстальщик", "Собрать страницы", {
      parentId: "catalogue",
      status: "completed",
    }),
    session("verification", "Контролёр", "Сверить страницы", {
      parentId: "layout",
      provider: "open",
      status: "completed",
      signal: "unseenCompletion",
    }),
  ],
};
const entries: WorkerProcess[] = [
  issue,
  {
    ...project,
    id: "rules",
    sessions: [
      session("rules", "Куратор данных", longTitle, { status: "waiting", provider: "claude" }),
    ],
  },
  {
    projectKey: "archive",
    projectName: "Архив коллекции",
    id: "archive",
    sessions: [
      session("archive", "Архивист", archiveTitle, { status: "waiting", signal: "actionRequired" }),
    ],
  },
  {
    ...project,
    id: "online",
    sessions: [
      session("online", "Публикатор", "Проверить каталог перед публикацией", { provider: "open" }),
    ],
  },
  finished,
];

const amber = "status-needsAttention";
const green = "status-completed-unread";

async function expectDots(container: Locator, colors: string[]) {
  await expect(container.locator(".process-signal-dots > span")).toHaveClass(
    colors.map((color) => `status ${color}`),
  );
}

for (const width of [1440, 390, 320]) {
  test.describe(`process cards at ${width}px`, () => {
    test.use({ hasTouch: width !== 1440 });
    for (const theme of ["light", "dark"] as const) {
      for (const language of ["ru", "en"] as const) {
        test(`${theme}, ${language}`, async ({ page }, info) => {
          await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
          await installProcessesFixture(page, theme, entries, language);
          await page.goto(overviewPath);

          const copy =
            language === "ru"
              ? {
                  filter: "Статус",
                  all: "Все",
                  waiting: "Ждёт ответа",
                  running: "В работе",
                  done: "Готово",
                  action: "Требуется действие",
                  result: "Новый результат",
                  open: "Открыть сессию",
                }
              : {
                  filter: "Status",
                  all: "All",
                  waiting: "Awaiting an answer",
                  running: "In progress",
                  done: "Ready",
                  action: "Action required",
                  result: "New result",
                  open: "Open session",
                };
          const filter = page.getByRole("group", { name: copy.filter });
          const all = filter.getByRole("button", { name: copy.all, exact: true });
          const waiting = filter.getByRole("button", { name: copy.waiting, exact: true });
          const headings = page.locator(".process-section > h2");
          const cards = page.locator(".process-card");
          const issueCard = cards.filter({ hasText: "Подготовить весенний выпуск каталога" });
          const question = issueCard.getByRole("link", { name: new RegExp(`^${copy.action}`) });
          const result = issueCard.getByRole("link", { name: new RegExp(`^${copy.result}`) });
          const activate = async (link: Locator) =>
            width === 1440 ? link.press("Enter") : link.tap();

          await expect(headings).toHaveText([copy.waiting, copy.running, copy.done]);
          await expect(cards).toHaveCount(5);
          await expect(all).toHaveAttribute("aria-pressed", "true");
          await expectDots(all, []);
          await expectDots(waiting, [amber, green]);
          await expect(waiting).toHaveAccessibleDescription(`${copy.action}. ${copy.result}`);
          await expectDots(headings.first(), [amber, green]);
          await expectDots(headings.last(), [green]);
          await expectDots(headings.nth(1), []);
          await expect(issueCard.getByText(copy.waiting, { exact: true })).toHaveCount(1);
          await expect(issueCard).not.toContainText(sourceDescription);
          await expect(question).toContainText(questionTitle);
          await expect(result).toContainText(resultText);
          await expect(question.locator(`.${amber}`)).toBeVisible();
          await expect(result.locator(`.${green}`)).toBeVisible();
          await expect(
            cards.filter({ hasText: archiveTitle }).getByText(archiveTitle, { exact: true }),
          ).toHaveCount(1);
          await expect(headings.first()).toHaveCSS("border-bottom-width", "0px");
          await expect(cards.first()).toHaveCSS("border-radius", "20px");
          await expect(issueCard).toContainText("Минеральный атлас · Тимлид каталога");
          const geometry = await page.locator(".processes-content").evaluate((content) => {
            const cards = [...content.querySelectorAll(".process-card")];
            return {
              fits:
                content.scrollWidth <= content.clientWidth &&
                cards.every((card) => card.scrollWidth <= card.clientWidth),
              typography: [
                ...content.querySelectorAll(".process-card a, .process-card p, h2, button"),
              ].every(
                (el) =>
                  getComputedStyle(el).fontFamily.startsWith("Onest") &&
                  getComputedStyle(el).fontWeight === "400",
              ),
              aligned: cards.every((card) => {
                const title = card.querySelector(".process-card-title")!.getBoundingClientRect();
                const arrow = card
                  .querySelector(".process-card-title svg")!
                  .getBoundingClientRect();
                const status = card
                  .querySelector("footer .process-status")!
                  .getBoundingClientRect();
                return (
                  Math.abs(title.left - status.left) < 1 && Math.abs(title.right - arrow.right) < 1
                );
              }),
            };
          });
          expect(geometry).toEqual({ fits: true, typography: true, aligned: true });
          await captureProcessPreview(page, info, `all-${width}-${theme}-${language}`);

          await activate(waiting);
          await expect(headings).toHaveText([copy.waiting]);
          await expect(cards).toHaveCount(3);
          await captureProcessPreview(page, info, `filtered-${width}-${theme}-${language}`);

          await activate(question);
          await expect(page).toHaveURL(`${overviewPath}/issue?session=title-question`);
          const inspector = page.locator(".process-inspector");
          const opened = inspector.locator("details[open]");
          await expect(opened).toContainText(questionTitle);
          await expect(opened.getByText(copy.action, { exact: true })).toBeVisible();
          await expect(opened.getByRole("link", { name: copy.open })).toHaveAttribute(
            "href",
            "/threads/title-question",
          );
          if (width !== 1440) await expect(inspector).toBeFocused();
          await page.goBack();
          await expect(waiting).toHaveAttribute("aria-pressed", "true");

          await activate(result);
          await expect(page).toHaveURL(`${overviewPath}/issue?session=references`);
          await expect(opened).toContainText(resultText);
          await expect(opened.getByText(copy.result, { exact: true })).toBeVisible();
          await expect(inspector).toContainText("ClaudeNest");
          await expect(inspector.getByText("Архивные примеры для обложки")).toBeVisible();
          const open = opened.getByRole("link", { name: copy.open });
          await expect(open).toHaveAttribute("href", resultUrl);
          if (width === 390 && theme === "light" && language === "ru") {
            await page.route(resultUrl, (route) => route.fulfill({ body: "ClaudeNest" }));
            await open.tap();
            await expect(page).toHaveURL(resultUrl);
          } else {
            await page.goBack();
            await expect(waiting).toHaveAttribute("aria-pressed", "true");
            await activate(all);
            await expect(cards).toHaveCount(5);
          }
        });
      }
    }
  });
}

test("process cards preserve focus, hover and pressed states", async ({ page }, info) => {
  await installProcessesFixture(page, "light", entries);
  await page.goto(overviewPath);
  const card = page.locator(".process-card").first();
  const title = card.getByRole("link").first();
  await expect(card).toBeVisible();
  const rest = await card.evaluate((element) => getComputedStyle(element).boxShadow);
  await title.focus();
  await expect(card).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Tab");
  await expect(card.getByRole("link", { name: /^Требуется действие/ })).toBeFocused();
  await captureProcessPreview(page, info, "focus-1440-light-ru");
  await card.hover();
  await expect
    .poll(() => card.evaluate((element) => getComputedStyle(element).boxShadow))
    .not.toBe(rest);
  await page.mouse.down();
  await expect(card).toHaveCSS("box-shadow", /inset/);
  await page.mouse.move(1400, 800);
  await page.mouse.up();
  const meta = (await card.locator(".process-card-meta").boundingBox())!;
  await page.mouse.click(meta.x + meta.width / 2, meta.y + meta.height / 2);
  await expect(page).toHaveURL(`${overviewPath}/issue`);
});

test("card signals follow the GET response and the focused filter survives polling", async ({
  page,
}) => {
  const response = [...entries];
  await page.clock.install();
  await installProcessesFixture(page, "light", response);
  await page.goto(overviewPath);
  const filter = page.getByRole("group", { name: "Статус" });
  const waiting = filter.getByRole("button", { name: "Ждёт ответа", exact: true });
  const done = filter.getByRole("button", { name: "Готово", exact: true });
  const verification = page.locator(".process-card").filter({ hasText: "Собрать выпуск каталога" });
  await expect(verification.getByRole("link", { name: "Новый результат" })).toHaveAttribute(
    "href",
    `${overviewPath}/catalogue?session=verification`,
  );
  await waiting.press("Enter");
  await page.clock.fastForward(4_000);
  await expectDots(waiting, [amber, green]);

  response[0] = {
    ...issue,
    sessions: issue.sessions.map((value) =>
      value.signal === "unseenCompletion" ? { ...value, signal: undefined } : value,
    ),
  };
  response.pop();
  await page.clock.fastForward(4_000);
  await expectDots(waiting, [amber]);
  await expect(done).toHaveCount(0);
  await expect(page.getByText(resultText)).toHaveCount(0);
  await expect(waiting).toBeFocused();

  response.splice(0, response.length, entries[3]!);
  await page.clock.fastForward(4_000);
  await expect(page.getByText("Нет процессов с этим статусом")).toBeVisible();
  await expectDots(waiting, []);
  await expect(waiting).toHaveAttribute("aria-pressed", "true");
  await expect(waiting).toBeFocused();
  await filter.getByRole("button", { name: "Все", exact: true }).press("Enter");
  await expect(
    page.getByRole("heading", { level: 2, name: "В работе", exact: true }),
  ).toBeVisible();
});
