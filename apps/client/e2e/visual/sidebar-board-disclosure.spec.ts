import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { KanbanBoard, ThreadSummary } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const width of [320, 390, 1440]) {
  test.describe(`project session navigation at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width <= 820 });

    test("pages project sessions, shows all Active sessions and opens a folded project's board", async ({
      page,
    }, info) => {
      const seed = structuredClone(snapshot);
      const base = seed.threads[0]!;
      seed.threads = Array.from({ length: 14 }, (_, index): ThreadSummary => ({
        ...base,
        id: `sidebar-session-${index}`,
        title: `Сессия ${index + 1}`,
        relation: { kind: "session", sessionId: `sidebar-session-${index}` },
        pinned: index < 2,
        state: index < 2 || index >= 10 ? "completed" : "running",
        unread: index >= 10,
        updatedAt: base.updatedAt - index,
      }));
      seed.threads.push({
        ...base,
        id: "sidebar-history",
        title: "Прочитанная сессия",
        relation: { kind: "session", sessionId: "sidebar-history" },
        state: "completed",
        unread: false,
        updatedAt: base.updatedAt + 1,
      });
      await installVisualFixture(page, {
        theme: "light",
        snapshot: seed,
        preserveLocalStorage: true,
      });
      const board: KanbanBoard = {
        id: "sidebar-board",
        projectPath: "/work/codex-nest",
        revision: 1,
        stages: [{ id: "todo", name: "К выполнению", description: "", role: "todo" }],
        categories: [],
        cards: [],
        runs: [],
        createdAt: 1,
        updatedAt: 1,
      };
      let boardReads = 0;
      await page.route("**/api/v1/projects/project-nest/kanban", (route) => {
        boardReads++;
        return route.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(board),
        });
      });
      await page.goto("/threads/sidebar-session-2");
      await waitForVisualReady(page);
      const openDrawer = async () => {
        if (width <= 820) await page.getByRole("button", { name: "Открыть список задач" }).click();
      };
      await openDrawer();
      const nav = page.getByRole("navigation", { name: "Задачи" });
      const group = nav.locator('[data-project-id="project-nest"]');
      const sessions = group.locator(".project-sessions");
      const rows = sessions.locator(":scope > .thread-branch");
      const toggle = group.getByRole("button", { name: "CodexNest", exact: true });
      await expect(rows).toHaveCount(5);
      await expect(rows.locator(".thread-link-title")).toHaveText([
        "Сессия 1",
        "Сессия 2",
        "Сессия 3",
        "Сессия 4",
        "Сессия 5",
      ]);
      await expect(nav.locator(".board-navigation-stage")).toHaveCount(0);
      expect(boardReads).toBe(0);
      await page.screenshot({ path: info.outputPath(`projects-${width}.png`) });
      expect((await new AxeBuilder({ page }).include(".sidebar").analyze()).violations).toEqual([]);
      await sessions.getByRole("button", { name: "Показать ещё 5" }).click();
      await expect(rows).toHaveCount(10);
      await sessions.getByRole("button", { name: "Показать ещё 5" }).click();
      await expect(rows).toHaveCount(15);
      await sessions.getByRole("button", { name: "Показать меньше" }).click();
      await expect(rows).toHaveCount(5);

      await page.getByRole("button", { name: "Активные", exact: true }).click();
      await expect(nav.locator(".active-session-list .thread-link")).toHaveCount(14);
      await expect(nav.locator(".show-more")).toHaveCount(0);
      await expect(nav.getByText("Прочитанная сессия")).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`active-${width}.png`) });
      await page.getByRole("button", { name: "Проекты", exact: true }).click();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");

      await page.reload();
      await waitForVisualReady(page);
      await openDrawer();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      const boardLink = group.getByRole("link", { name: "Доска проекта CodexNest" });
      if (width <= 820) await boardLink.tap();
      else await boardLink.click();
      await expect(page).toHaveURL(/\/projects\/project-nest\/kanban$/);
      await expect(page.getByRole("heading", { name: "Доска задач", exact: true })).toBeVisible();
      if (width <= 820) await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
      await openDrawer();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(boardLink).toHaveAttribute("aria-current", "page");
      await toggle.click();
      await expect(rows).toHaveCount(5);
    });
  });
}
