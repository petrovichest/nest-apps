import { expect, test } from "@playwright/test";

import { installVisualFixture, waitForVisualReady } from "./fixtures";

for (const width of [320, 1440]) {
  test(`copies a local session reference from the menu at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await installVisualFixture(page, { theme: "light" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          async write(items: ClipboardItem[]) {
            const blob = await items[0]!.getType("text/plain");
            (window as Window & { copiedReference?: string }).copiedReference = await blob.text();
          },
        },
      });
    });
    let reads = 0;
    await page.route("**/api/v1/threads/session-main/reference", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      reads += 1;
      await route.fulfill({
        json: {
          threadId: "session-main",
          cwd: "/work/project with spaces",
          historyPath: "/native/sessions/session-main.jsonl",
        },
        headers: { "access-control-allow-origin": "*" },
      });
    });
    await page.goto("/threads/session-main");
    await waitForVisualReady(page);
    await page.getByLabel("Действия с задачей", { exact: true }).click();
    const copy = page.getByRole("button", { name: "Копировать ссылку на сессию", exact: true });
    await expect(copy).toBeVisible();
    expect(reads).toBe(0);
    const menu = page.locator(".action-menu-popover");
    expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("session-reference-menu.png") });
    await copy.click();
    await expect(page.getByRole("button", { name: "Скопировано", exact: true })).toBeVisible();
    expect(reads).toBe(1);
    expect(
      await page.evaluate(() => (window as Window & { copiedReference?: string }).copiedReference),
    ).toBe(
      "Сессия: CodexNest\nID: session-main\nРабочая папка: /work/project with spaces\nФайл истории: /native/sessions/session-main.jsonl",
    );
  });
}
