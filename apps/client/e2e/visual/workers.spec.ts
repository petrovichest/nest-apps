import { expect, test } from "@playwright/test";
import type { WorkerProfile } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

const projects = [
  ...snapshot.projects,
  ...(
    [
      ["Документация", "docs"],
      ["Мобильный клиент", "mobile"],
      ["Атлас материалов", "material-atlas"],
      ["Интеграции", "integrations"],
      ["Инфраструктура", "infrastructure"],
      ["Мониторинг", "monitoring"],
    ] as const
  ).map(([displayName, directory]) => ({
    ...snapshot.projects[0]!,
    id: `project-${directory}`,
    displayName,
    path: `/work/${directory}`,
  })),
];

for (const width of [1440, 390]) {
  test(`opens the worker catalogue and edits a profile at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await installVisualFixture(page, {
      theme: width === 1440 ? "light" : "dark",
      snapshot: { ...snapshot, projects },
    });
    const architect: WorkerProfile = {
      id: "architect",
      name: "Архитектор работников",
      role: "Помогает создать работника",
      instructions: "",
      projectKey: null,
      settings: {},
      revision: 0,
    };
    const common = {
      ...architect,
      id: "reviewer",
      name: "Ревьюер",
      role: "Проверяет изменения в коде",
      revision: 1,
    };
    let lead = {
      ...common,
      id: "lead",
      name: "Тимлид",
      role: "Планирует работу",
      projectKey: "canonical-project",
    };
    const starts: string[] = [];
    const projectCreationIds: string[] = [];
    await page.route("**/api/v1/workers/**", async (route) => {
      const request = route.request();
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "Authorization, Content-Type",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/catalog"))
        return route.fulfill({
          headers,
          json: {
            common: [architect, common],
            projects: [{ projectId: "project-nest", workers: [lead] }],
          },
        });
      if (path.endsWith("/lead") && request.method() === "PATCH") {
        lead = { ...lead, name: request.postDataJSON().name, revision: lead.revision + 1 };
        return route.fulfill({ headers, json: lead });
      }
      if (path.endsWith("/architect"))
        return route.fulfill({ headers, json: { profile: architect, memory: [] } });
      if (path.endsWith("/lead"))
        return route.fulfill({ headers, json: { profile: lead, memory: [] } });
      if (path.endsWith("/sessions")) {
        const projectId = new URL(request.url()).searchParams.get("projectId") ?? "";
        starts.push(projectId);
        if (projectId === "project-nest") {
          projectCreationIds.push(request.postDataJSON().creationId);
          if (projectCreationIds.length === 1)
            return route.fulfill({
              status: 503,
              headers,
              json: { error: { code: "app_server_unavailable", message: "Network unavailable" } },
            });
        }
        return route.fulfill({ headers, json: { threadId: "session-main" } });
      }
      return route.fulfill({
        status: 404,
        headers,
        json: { error: { message: "Worker not found" } },
      });
    });
    await page.goto("/workers");
    await expect(page.getByRole("heading", { name: "Работники" })).toBeVisible();
    const tiles = page.locator(".worker-tile");
    await expect(tiles).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "Общие", exact: true })).toHaveCount(0);
    await expect(tiles.filter({ hasText: "Ревьюер" })).toHaveCount(0);
    await expect(tiles.first()).toContainText("Архитектор");
    expect(
      await tiles.evaluateAll((nodes) =>
        nodes.every((node) => {
          const { width, height } = node.getBoundingClientRect();
          return Math.abs(width - height) <= 1;
        }),
      ),
    ).toBe(true);
    await waitForVisualReady(page);
    await page.screenshot({ path: info.outputPath("workers.png") });
    const architectTile = tiles.filter({ hasText: "Архитектор" });
    await architectTile.click();
    const architectProjects = page.getByRole("dialog", { name: "Запустить «Архитектор»" });
    const search = architectProjects.getByRole("searchbox", { name: "Найти проект" });
    const options = architectProjects.locator(".worker-project-option");
    await expect(search).toBeFocused();
    await expect(options).toHaveCount(projects.length);
    expect(starts).toEqual([]);
    await page.screenshot({ path: info.outputPath("worker-project-picker.png") });
    const searchTop = await search.evaluate((input) => input.getBoundingClientRect().top);
    const fullHeight = await architectProjects.evaluate((dialog) => dialog.clientHeight);
    const results = architectProjects.locator(".project-directory-list");
    await results.evaluate((list) => (list.scrollTop = list.scrollHeight));
    await page.keyboard.insertText("атлас");
    await expect(options).toHaveCount(2);
    await expect(
      architectProjects.getByRole("button", { name: /^Минеральный атлас/ }),
    ).toBeVisible();
    await expect(
      architectProjects.getByRole("button", { name: /^Атлас материалов/ }),
    ).toBeVisible();
    expect(await results.evaluate((list) => list.scrollTop)).toBe(0);
    expect(await search.evaluate((input) => input.getBoundingClientRect().top)).toBeCloseTo(
      searchTop,
      0,
    );
    expect(await architectProjects.evaluate((dialog) => dialog.clientHeight)).toBeLessThan(
      fullHeight,
    );
    await page.screenshot({ path: info.outputPath("worker-project-filtered.png") });
    await search.press("Enter");
    expect(starts).toEqual([]);
    await search.fill("Нет такого проекта");
    await expect(architectProjects.getByRole("status")).toHaveText("Совпадений нет");
    await expect(options).toHaveCount(0);
    await search.fill("");
    await expect(options).toHaveCount(projects.length);
    await page.keyboard.press("Escape");
    await expect(architectProjects).toBeHidden();
    await architectTile.focus();
    await architectTile.press("Enter");
    await expect(architectProjects).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(architectProjects).toBeHidden();
    await expect(architectTile).toBeFocused();
    await architectTile.click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await search.fill(" мИНЕральный ");
    await expect(options).toHaveCount(1);
    await search.press("Enter");
    await expect(page).toHaveURL(/\/threads\/session-main$/u);
    expect(starts).toEqual(["project-mineral"]);
    await page.goto("/workers");
    await page.getByRole("button", { name: "Настройки работника «Архитектор»" }).click();
    const architectSettings = page.getByRole("dialog", { name: "Архитектор", exact: true });
    await expect(
      architectSettings.getByText("Архитектор использует настройки приложения по умолчанию."),
    ).toBeVisible();
    await architectSettings.getByRole("button", { name: "Закрыть" }).click();
    await page.getByRole("button", { name: "Настройки работника «Тимлид»" }).click();
    const settings = page.getByRole("dialog", { name: "Тимлид" });
    await expect(settings.getByRole("textbox", { name: "Постоянные инструкции" })).toHaveCSS(
      "border-radius",
      "20px",
    );
    await expect(settings.getByRole("textbox", { name: "Имя" })).toHaveCSS(
      "border-radius",
      "999px",
    );
    await settings.getByRole("textbox", { name: "Имя" }).fill("Руководитель");
    await settings.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(tiles.last()).toContainText("Руководитель");
    await tiles.last().focus();
    await tiles.last().press("Enter");
    await expect(page.getByRole("alert")).toHaveText("Network unavailable");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(tiles.last()).toBeFocused();
    await tiles.last().press("Enter");
    await expect(page).toHaveURL(/\/threads\/session-main$/u);
    expect(starts).toEqual(["project-mineral", "project-nest", "project-nest"]);
    expect(projectCreationIds[0]).toBeTruthy();
    expect(projectCreationIds[1]).toBe(projectCreationIds[0]);
  });
}
