import { resolve } from "node:path";
import type { WorkerProcess, WorkerProcessSession } from "@codexnest/protocol";
import { expect, test } from "@playwright/test";
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

for (const width of [1440, 390]) {
  test(`renders separate process branches and waiting paths at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await installVisualFixture(page, { theme: "light" });
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
        json: processId ? processes.filter(({ id }) => id === processId) : processes,
      });
    });
    const capture = async (name: string) => {
      if (info.project.name !== "chromium" || !process.env.NEST_WORKER_PROCESS_SCREENSHOTS) return;
      await waitForVisualReady(page);
      await page.screenshot({
        path: resolve(process.env.NEST_WORKER_PROCESS_SCREENSHOTS, `${name}-${width}.png`),
        animations: "disabled",
      });
    };

    await page.goto("/workers/processes");
    const rows = page.locator(".process-overview-run");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Тимлид импорта");
    await expect(rows.last()).toContainText("Тимлид релиза");
    await expect(rows.last()).toContainText("ClaudeNest");
    await capture("overview");
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
    if (width === 390) await capture("graph");
    await graph.getByRole("button", { name: /^Ревьюер/ }).click();
    await expect(inspector.getByText("Тимлид импорта ждёт результата")).toBeVisible();
    await expect(inspector.getByText("Какие случаи проверить?")).toBeVisible();
    await expect(inspector.getByText("Проверить изменения к релизу")).toHaveCount(0);
    if (width === 1440) await capture("graph");
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
