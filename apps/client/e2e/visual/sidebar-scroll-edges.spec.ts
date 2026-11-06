import type { ServerEvent } from "@codexnest/protocol";
import { expect, test, type Page } from "@playwright/test";

import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

function longSidebarSnapshot() {
  const seed = structuredClone(snapshot);
  const main = seed.threads.find((thread) => thread.id === "session-main")!;
  for (let index = 0; index < 24; index++) {
    const id = `scroll-session-${index}`;
    seed.threads.push({
      ...main,
      id,
      title: `Проверка плавных краёв ${index + 1}`,
      relation: { kind: "session", sessionId: id },
    });
  }
  return seed;
}

async function expectFades(page: Page, top: number, bottom: number) {
  await expect
    .poll(() =>
      page
        .locator(".thread-nav")
        .evaluate((navigation) => [
          parseFloat(navigation.style.getPropertyValue("--thread-nav-fade-top")),
          parseFloat(navigation.style.getPropertyValue("--thread-nav-fade-bottom")),
        ]),
    )
    .toEqual([top, bottom]);
}

for (const { width, side, theme } of [
  { width: 390, side: "left", theme: "light" },
  { width: 390, side: "right", theme: "dark" },
  { width: 1440, side: "left", theme: "light" },
  { width: 1440, side: "right", theme: "dark" },
] as const) {
  test(`scroll edges at ${width}px on the ${side} in ${theme}`, async ({ page }) => {
    const mobile = width <= 820;
    await page.setViewportSize({ width, height: 844 });
    await installVisualFixture(page, {
      theme,
      sidebarSide: side,
      snapshot: longSidebarSnapshot(),
    });
    await page.goto("/threads/session-main");
    await expect(page.locator(".thread-link").first()).toBeAttached();
    if (mobile) await page.getByRole("button", { name: "Открыть список задач" }).click();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    await expectFades(page, 0, 28);

    const navigation = page.locator(".thread-nav");
    const sidebar = page.locator(".sidebar");
    const controls = await page.locator(".sidebar-controls").boundingBox();
    await navigation.evaluate((element) => (element.scrollTop = 4));
    await expectFades(page, 4, 28);
    await navigation.evaluate((element) => (element.scrollTop = 90));
    await expectFades(page, 28, 28);
    expect(await page.locator(".sidebar-controls").boundingBox()).toEqual(controls);
    await waitForVisualReady(page);
    const screenshotName = `sidebar-soft-edges-${width}-${side}-${theme}.png`;
    if (mobile) await expect(page).toHaveScreenshot(screenshotName);
    else await expect(sidebar).toHaveScreenshot(screenshotName);

    await navigation.evaluate((element) => (element.scrollTop = element.scrollHeight));
    await expectFades(page, 28, 0);
    await page.locator(".pinned-group-toggle").click();
    await expectFades(page, 0, 0);
    await page.locator(".pinned-group-toggle").click();
    await expectFades(page, 0, 28);
    await page.setViewportSize({ width, height: 2200 });
    await expectFades(page, 0, 0);
    await page.setViewportSize({ width, height: 844 });
    await expectFades(page, 0, 28);

    if (mobile) {
      const backdrop = page.locator(".drawer-backdrop");
      await expect(backdrop).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(backdrop).toHaveCSS("backdrop-filter", "blur(8px)");
      await expect(sidebar).not.toHaveCSS("box-shadow", "none");
      const start = { identifier: 1, clientX: width / 2, clientY: 700 };
      await sidebar.dispatchEvent("touchstart", { touches: [start] });
      await sidebar.dispatchEvent("touchmove", {
        touches: [{ ...start, clientX: start.clientX + (side === "left" ? -40 : 40) }],
      });
      await expect(page.locator(".app-frame")).toHaveClass(/drawer-dragging/);
      await expect(backdrop).toHaveCSS("backdrop-filter", "blur(8px)");
      const opacity = await backdrop.evaluate((element) =>
        Number(getComputedStyle(element).opacity),
      );
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThan(1);
      await sidebar.dispatchEvent("touchend", { touches: [] });
      await expect(sidebar).toHaveClass(/open/);
      const position = { x: side === "left" ? width - 2 : 2, y: 100 };
      await backdrop.hover({ position });
      await expect(backdrop).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await backdrop.click({ position });
      await expect(sidebar).not.toHaveClass(/open/);
      await expect(sidebar).toHaveCSS("box-shadow", "none");
    }
  });
}

test("bottom-up projects initialize at the bottom and reset fades when switching modes", async ({
  page,
}) => {
  // Project previews are paged; use enough projects to overflow without expanding sessions.
  const seed = longSidebarSnapshot();
  seed.projects.push(
    ...Array.from({ length: 12 }, (_, index) => ({
      ...seed.projects[0]!,
      id: `scroll-project-${index}`,
      displayName: `Проект ${index + 1}`,
      path: `/work/scroll-project-${index}`,
    })),
  );
  await installVisualFixture(page, { theme: "light", snapshot: seed });
  await page.addInitScript(() =>
    localStorage.setItem("codexnest.projectListDirection", "bottom-up"),
  );
  await page.goto("/threads/session-main");
  await expectFades(page, 28, 0);
  await page.getByRole("button", { name: "Активные", exact: true }).click();
  await expectFades(page, 0, 28);
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await expectFades(page, 28, 0);
});

test("incoming sessions update overflow without moving the list", async ({ page }) => {
  const seed = structuredClone(snapshot);
  const main = seed.threads.find((thread) => thread.id === "session-main")!;
  seed.threads = [main];
  await installVisualFixture(page, { theme: "light", snapshot: seed });
  let sequence = seed.sequence;
  let send!: (event: ServerEvent) => void;
  await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (socket) => {
    send = (event) => socket.send(JSON.stringify({ type: "event", sequence: ++sequence, event }));
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "authenticate") {
        socket.send(JSON.stringify({ type: "snapshot", snapshot: seed }));
      }
      if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    });
  });
  await page.goto("/threads/session-main");
  await page.getByRole("button", { name: "Активные", exact: true }).click();
  await expectFades(page, 0, 0);
  for (const thread of longSidebarSnapshot().threads.filter((thread) =>
    thread.id.startsWith("scroll-session-"),
  )) {
    send({ type: "thread.upserted", thread });
  }
  await expectFades(page, 0, 28);
  expect(await page.locator(".thread-nav").evaluate((element) => element.scrollTop)).toBe(0);
});
