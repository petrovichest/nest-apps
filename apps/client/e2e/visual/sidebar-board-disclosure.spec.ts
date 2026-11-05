import { expect, test } from "@playwright/test";
import type { KanbanBoard } from "@codexnest/protocol";
import { installVisualFixture, waitForVisualReady } from "./fixtures";

for (const width of [390, 1440]) {
  test(`board sidebar keeps category choices and pages long lists at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installVisualFixture(page, { theme: "light", preserveLocalStorage: true });
    const board: KanbanBoard = {
      id: "sidebar-board",
      projectPath: "/work/codex-nest",
      revision: 1,
      stages: [
        { id: "todo", name: "К выполнению", description: "", role: "todo" },
        { id: "done", name: "Опубликовано", description: "", role: "done" },
      ],
      categories: [],
      cards: ["todo", "done"].flatMap((stageId) =>
        Array.from({ length: stageId === "todo" ? 27 : 7 }, (_, index) => ({
          id: `${stageId}-${index}`,
          title: `Задача ${stageId} ${index + 1}`,
          description: "",
          stageId,
          categoryId: null,
          classification: "ready" as const,
          error: null,
          createdAt: 1,
          updatedAt: 1,
        })),
      ),
      runs: [],
      createdAt: 1,
      updatedAt: 1,
    };
    await page.route("**/api/v1/projects/project-nest/kanban", (route) =>
      route.fulfill({
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(board),
      }),
    );
    await page.goto("/threads/session-active");
    await waitForVisualReady(page);
    const openDrawer = async () => {
      if (width <= 820) await page.getByRole("button", { name: "Открыть список задач" }).click();
    };
    await openDrawer();
    const nav = page.getByRole("navigation", { name: "Задачи" });
    const todo = nav.locator(".board-navigation-stage").filter({ hasText: "К выполнению" });
    const done = nav.locator(".board-navigation-stage").filter({ hasText: "Опубликовано" });
    const todoToggle = todo.getByRole("button", { name: /К выполнению/ });
    const doneToggle = done.getByRole("button", { name: /Опубликовано/ });
    await expect(todo.locator(".thread-link")).toHaveCount(5);
    await todo.getByRole("button", { name: "Показать ещё 5" }).click();
    await expect(todo.locator(".thread-link")).toHaveCount(10);
    await todoToggle.click();
    await doneToggle.click();
    await expect(done.locator(".thread-link")).toHaveCount(5);

    await page.getByRole("button", { name: "Активные", exact: true }).click();
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    await expect(todoToggle).toHaveAttribute("aria-expanded", "false");
    await expect(doneToggle).toHaveAttribute("aria-expanded", "true");
    const projectToggle = nav.getByRole("button", { name: "CodexNest", exact: true });
    await projectToggle.click();
    await projectToggle.click();
    await expect(todoToggle).toHaveAttribute("aria-expanded", "false");

    await page.reload();
    await waitForVisualReady(page);
    await openDrawer();
    await expect(todoToggle).toHaveAttribute("aria-expanded", "false");
    await expect(doneToggle).toHaveAttribute("aria-expanded", "true");
    await todoToggle.click();
    await expect(todo.locator(".thread-link")).toHaveCount(5);
    await todo.getByRole("button", { name: "Показать ещё 5" }).click();
    await expect(todo.locator(".thread-link")).toHaveCount(10);
  });
}
