import { expect, test } from "@playwright/test";
import type { WorkerProfile } from "@codexnest/protocol";
import { installVisualFixture, waitForVisualReady } from "./fixtures";

for (const width of [1440, 390]) {
  test(`opens the worker catalogue and edits a profile at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await installVisualFixture(page, { theme: width === 1440 ? "light" : "dark" });
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
      if (path.endsWith("/lead/sessions"))
        return route.fulfill({ headers, json: { threadId: "session-main" } });
      return route.fulfill({
        status: 404,
        headers,
        json: { error: { message: "Worker not found" } },
      });
    });
    await page.goto("/workers");
    await expect(page.getByRole("heading", { name: "Работники" })).toBeVisible();
    const tiles = page.locator(".worker-tile");
    await expect(tiles).toHaveCount(3);
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
    await tiles.last().click();
    await expect(page).toHaveURL(/\/threads\/session-main$/u);
  });
}
