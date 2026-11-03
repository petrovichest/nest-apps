import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installVisualFixture, snapshot, waitForVisualReady, PHONE_VIEWPORT } from "./fixtures";

async function openSidebar(page: Page, theme: "light" | "dark", pinnedCount?: number) {
  const seed = structuredClone(snapshot);
  if (pinnedCount !== undefined) {
    const main = seed.threads.find((thread) => thread.id === "session-main")!;
    main.pinned = pinnedCount > 0;
    for (let index = 1; index < pinnedCount; index++) {
      const id = `extra-pin-${index}`;
      seed.threads.push({ ...main, id, relation: { kind: "session", sessionId: id } });
    }
  }
  await installVisualFixture(page, { theme, snapshot: seed });
  await page.route("**/api/v1/threads/session-main", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const thread = seed.threads.find((candidate) => candidate.id === "session-main")!;
    thread.pinned = route.request().postDataJSON().pinned;
    await route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(thread),
    });
  });
  await page.route("**/api/v1/projects/project-nest/threads", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const thread = {
      ...seed.threads[0]!,
      id: "created-session",
      title: "Новая задача",
      pinned: false,
      state: "idle" as const,
    };
    seed.threads.push(thread);
    await route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ thread }),
    });
  });
  await page.goto("/threads/session-active");
  await expect(page.locator(".thread-link").first()).toBeAttached();
  await waitForVisualReady(page);
}

async function modeButtonBounds(page: Page) {
  return page.locator(".session-list-mode button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

for (const width of [320, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`sidebar ${width} ${theme} custom typography preserves shadows and control access`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await installVisualFixture(page, { theme, preserveLocalStorage: true });
      await page.goto("/threads/session-active");
      await waitForVisualReady(page);
      const openDrawer = async () => {
        if (width <= 820) await page.getByRole("button", { name: "Открыть список задач" }).click();
      };
      await openDrawer();
      const navigation = page.locator(".thread-nav");
      const normalNav = await navigation.boundingBox();
      const normalButtons = await modeButtonBounds(page);

      for (const sizes of [{ message: 16 }, { ui: 32, caption: 32 }]) {
        await page.evaluate(
          (value) => localStorage.setItem("codexnest.typography", JSON.stringify(value)),
          sizes,
        );
        await page.reload();
        await waitForVisualReady(page);
        await openDrawer();
        const mode = page.locator(".session-list-mode");
        const active = mode.getByRole("button", { name: "Активные", exact: true });
        await active.click();

        if ("message" in sizes) {
          expect(await navigation.boundingBox()).toEqual(normalNav);
          expect((await modeButtonBounds(page)).map(({ y, height }) => ({ y, height }))).toEqual(
            normalButtons.map(({ y, height }) => ({ y, height })),
          );
          await page.mouse.move(width - 1, 899);
          const sidebar = (await page.locator(".sidebar").boundingBox())!;
          const button = (await active.boundingBox())!;
          const nav = (await navigation.boundingBox())!;
          await expect(page).toHaveScreenshot(`sidebar-mode-shadow-${width}-${theme}.png`, {
            clip: {
              x: sidebar.x,
              y: button.y - 24,
              width: sidebar.width,
              height: nav.y + 70 - (button.y - 24),
            },
          });
        } else {
          expect(await mode.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
          await mode.getByRole("button", { name: "Проекты", exact: true }).click();
          await expect(mode.getByRole("button", { name: "Проекты", exact: true })).toHaveAttribute(
            "aria-pressed",
            "true",
          );
          await active.click();
        }

        const pinned = mode.locator(".pinned-group-toggle");
        await pinned.click();
        await expect(pinned).toHaveAttribute("aria-expanded", "false");
        await pinned.click();
        await expect(pinned).toHaveAttribute("aria-expanded", "true");

        // The scroller's transparent shadow space must not intercept nearby controls.
        for (const selector of [".sidebar-control-action", ".codex-limits", ".thread-link"]) {
          expect(
            await page
              .locator(selector)
              .first()
              .evaluate((el) => {
                const box = el.getBoundingClientRect();
                return el.contains(document.elementFromPoint(box.x + 8, box.y + box.height / 2));
              }),
          ).toBe(true);
        }
        await page.locator('.thread-link[href="/threads/session-main"]').click();
        await expect(page).toHaveURL(/\/threads\/session-main$/);
        await openDrawer();
        await page.getByRole("link", { name: "Настройки", exact: true }).click();
        await expect(page).toHaveURL(/\/settings\?section=application$/);
      }
    });
  }
}

for (const { width, side } of [
  { width: 320, side: "left" },
  { width: 390, side: "right" },
  { width: 820, side: "left" },
  { width: 821, side: "right" },
  { width: 1440, side: "left" },
] as const) {
  test.describe(`bubble navigation at ${width}px on the ${side}`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width <= 820 });

    for (const theme of ["light", "dark"] as const) {
      test(`${theme} aligned groups, inset session contents and control states`, async ({
        page,
      }) => {
        await installVisualFixture(page, { theme, sidebarSide: side });
        await page.goto("/threads/session-active");
        await waitForVisualReady(page);
        if (width <= 820) {
          await page.getByRole("button", { name: "Открыть список задач" }).tap();
        }
        const sidebar = page.locator(".sidebar");
        const controls = sidebar.locator(".sidebar-controls");
        const switcher = sidebar.locator(".session-list-mode");
        const settings = controls.locator(".sidebar-control-action").first();
        const limits = controls.locator(".codex-limits");
        const panel = (await sidebar.boundingBox())!;
        const gutter = width <= 820 ? 8 : 20;
        expect(panel.y).toBe(width <= 820 ? 0 : 8);
        expect(panel.height).toBe(width <= 820 ? 900 : 872);
        expect(side === "left" ? panel.x : width - panel.x - panel.width).toBe(gutter);
        const expectVerticalAlignment = async () => {
          const panel = (await sidebar.boundingBox())!;
          const header = (await page.locator(".workspace-header").boundingBox())!;
          const composer = (await page.locator(".composer-box").boundingBox())!;
          expect(panel.y).toBe(header.y);
          expect(panel.y + panel.height).toBe(composer.y + composer.height);
        };
        await expectVerticalAlignment();
        await expect(sidebar).toHaveCSS("border-radius", "28px");
        await expect(sidebar).not.toHaveCSS("box-shadow", "none");
        const content = (await page.locator(".content").boundingBox())!;
        expect(content.x).toBe(width <= 820 || side === "right" ? 0 : 332);
        expect(content.width).toBe(width <= 820 ? width : width - 332);
        await expect(settings).toHaveCSS("height", "38px");
        await expect(switcher.locator("button").first()).toHaveCSS("height", "34px");
        await expect(settings).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(settings).toHaveCSS("box-shadow", "none");

        for (const mode of ["Проекты", "Активные"]) {
          await page.getByRole("button", { name: mode, exact: true }).click();
          const topBounds = (await controls.boundingBox())!;
          const modeBounds = (await switcher.boundingBox())!;
          expect(topBounds.x).toBe(modeBounds.x);
          expect(topBounds.width).toBe(modeBounds.width);
          await expect(controls).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await expect(switcher).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await expect(switcher).toHaveCSS("box-shadow", "none");
          await expect(switcher.locator('[aria-pressed="true"]')).not.toHaveCSS(
            "background-color",
            "rgba(0, 0, 0, 0)",
          );
          const link = sidebar.locator(".thread-link.active");
          const selected = switcher.locator('[aria-pressed="true"]');
          await expect(selected).toHaveCSS(
            "background-color",
            await link.evaluate((node) => getComputedStyle(node).backgroundColor),
          );
          await expect(selected).toHaveCSS(
            "box-shadow",
            await link.evaluate((node) => getComputedStyle(node).boxShadow),
          );
          const linkBounds = (await link.boundingBox())!;
          const title = (await link.locator(".thread-link-title").boundingBox())!;
          const status = (await link.locator(".status").boundingBox())!;
          expect(title.x - linkBounds.x).toBe(12);
          expect(linkBounds.x + linkBounds.width - status.x - status.width).toBeCloseTo(10, 4);
          expect(status.width).toBe(3);
          expect(status.height).toBe(20);
          // Reserve room for the status pulse as well as the marker itself.
          expect(status.y - 4).toBeGreaterThanOrEqual(linkBounds.y);
          expect(status.y + status.height + 4).toBeLessThanOrEqual(
            linkBounds.y + linkBounds.height,
          );
          if (mode === "Проекты") {
            const row = (await link.locator("..").boundingBox())!;
            expect(title.x - row.x).toBe(32);
          }
        }

        if (width <= 820) {
          await limits.tap();
          await expect(limits).toHaveAttribute("aria-busy", "false");
          await expect(limits).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await expect(limits).toHaveCSS("box-shadow", "none");
          if (width <= 390) {
            await page.evaluate(() => {
              document.documentElement.style.setProperty("--safe-area-inset-left", "12px");
              document.documentElement.style.setProperty("--safe-area-inset-right", "16px");
              document.documentElement.style.setProperty("--safe-area-inset-top", "20px");
              document.documentElement.style.setProperty("--safe-area-inset-bottom", "24px");
            });
            const panel = (await sidebar.boundingBox())!;
            const top = (await controls.boundingBox())!;
            const modes = (await switcher.boundingBox())!;
            expect(panel.y).toBe(20);
            expect(panel.y + panel.height).toBe(876);
            await expectVerticalAlignment();
            expect(side === "left" ? panel.x : width - panel.x - panel.width).toBe(
              side === "left" ? 20 : 24,
            );
            expect(panel.x).toBeGreaterThanOrEqual(20);
            expect(panel.x + panel.width).toBeLessThanOrEqual(width - 24);
            expect(top.x - panel.x).toBe(8);
            expect(panel.x + panel.width - top.x - top.width).toBeCloseTo(8, 4);
            expect(modes.x).toBe(top.x);
            expect(modes.width).toBe(top.width);
            expect(top.y - panel.y).toBe(8);
            expect(await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
              true,
            );

            // A short reverse swipe must interpolate from the actual inset position,
            // then return to it. A longer swipe must hide the surface and its shadow.
            const frame = page.locator(".app-frame");
            const direction = side === "left" ? -1 : 1;
            const start = { identifier: 1, clientX: width / 2, clientY: 700 };
            for (const distance of [40, 120]) {
              await sidebar.dispatchEvent("touchstart", { touches: [start] });
              await sidebar.dispatchEvent("touchmove", {
                touches: [{ ...start, clientX: start.clientX + direction * distance }],
              });
              await expect(frame).toHaveClass(/drawer-dragging/);
              const translated = (await sidebar.boundingBox())!;
              const edge = side === "left" ? panel.x : width - panel.x - panel.width;
              const shift = (panel.width * 1.04 + edge) * (distance / panel.width);
              expect(translated.x).toBeCloseTo(panel.x + direction * shift, 1);
              await sidebar.dispatchEvent("touchend", { touches: [] });
              if (distance === 40) {
                await expect(sidebar).toHaveClass(/open/);
                expect(await sidebar.boundingBox()).toEqual(panel);
              }
            }
            await expect(sidebar).not.toHaveClass(/open/);
            await expect(sidebar).toHaveCSS("box-shadow", "none");
            const hidden = (await sidebar.boundingBox())!;
            expect(side === "left" ? hidden.x + hidden.width <= 0 : hidden.x >= width).toBe(true);
            await page.getByRole("button", { name: "Открыть список задач" }).tap();
            expect(await sidebar.boundingBox()).toEqual(panel);
          }
          return;
        }

        const restBounds = await settings.boundingBox();
        const sessionShadow = await sidebar
          .locator(".thread-link.active")
          .evaluate((node) => getComputedStyle(node).boxShadow);
        await settings.hover();
        await expect(settings).toHaveCSS("box-shadow", sessionShadow);
        expect(await settings.boundingBox()).toEqual(restBounds);
        await page.mouse.down();
        await expect(settings).toHaveCSS("box-shadow", /inset/);
        expect(await settings.boundingBox()).toEqual(restBounds);
        await page.mouse.move(width / 2, 850);
        await page.mouse.up();
        await expect(settings).toHaveCSS("box-shadow", "none");
        const selected = switcher.locator('[aria-pressed="true"]');
        const selectedBounds = await selected.boundingBox();
        await selected.hover();
        await page.mouse.down();
        await expect(selected).toHaveCSS("box-shadow", /inset/);
        expect(await selected.boundingBox()).toEqual(selectedBounds);
        await page.mouse.up();
        await page.mouse.move(width / 2, 850);
        await expect(selected).toHaveCSS("box-shadow", sessionShadow);
        await settings.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(settings).toBeFocused();
        await expect(settings).toHaveCSS("outline-style", "solid");
        await expect(settings).toHaveCSS("box-shadow", sessionShadow);
        await settings.evaluate((node) => (node as HTMLElement).blur());
        await limits.evaluate((node) => ((node as HTMLButtonElement).disabled = true));
        await limits.hover({ force: true });
        await expect(limits).toHaveCSS("box-shadow", "none");
        await expect(limits).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await limits.evaluate((node) => ((node as HTMLButtonElement).disabled = false));

        if (width === 1440) {
          await page.getByRole("button", { name: "Проекты", exact: true }).click();
          await settings.hover();
          await expect(sidebar).toHaveScreenshot(`sidebar-hover-${theme}.png`);
          await expect(page).toHaveScreenshot(`sidebar-floating-${theme}.png`);
        }
      });
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`desktop ${theme} active alignment, hover actions and pin persistence`, async ({ page }) => {
    await openSidebar(page, theme);
    const switcher = page.locator(".session-list-mode");
    const switcherBefore = await switcher.boundingBox();
    const buttonsBefore = await modeButtonBounds(page);
    const navBefore = await page.locator(".thread-nav").boundingBox();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    expect(await switcher.boundingBox()).toEqual(switcherBefore);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    expect(await page.locator(".thread-nav").boundingBox()).toEqual(navBefore);
    const roots = page.locator(
      ".active-session-list > .thread-branch > .thread-branch-row, .active-pinned-sessions > .thread-branch > .thread-branch-row",
    );
    const row = roots.filter({ has: page.locator('a[href="/threads/session-main"]') });
    await expect(roots.first()).toContainText("Полировка мастерской");
    const topRowBounds = await row.boundingBox();
    expect(topRowBounds!.y).toBe(navBefore!.y + 8);
    expect(topRowBounds!.height).toBe(42);
    const collapse = page.locator(".pinned-group-toggle");
    await expect(collapse).toHaveAccessibleName("Свернуть закрепленные (1)");
    await collapse.focus();
    await page.keyboard.press("Enter");
    await expect(row).toBeHidden();
    await expect(collapse).toHaveAttribute("aria-expanded", "false");
    expect(await switcher.boundingBox()).toEqual(switcherBefore);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    const ordinary = page.locator('a[href="/threads/session-active"]');
    expect((await ordinary.boundingBox())!.y).toBe(topRowBounds!.y);
    await expect(page.locator(".sidebar")).toHaveScreenshot(
      `sidebar-pinned-collapsed-${theme}.png`,
      {
        maxDiffPixelRatio: 0,
      },
    );
    await page.keyboard.press("Tab");
    await expect(ordinary).toBeFocused();
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    await expect(collapse).toBeVisible();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    await expect(collapse).toHaveAttribute("aria-expanded", "false");
    await expect(row).toBeHidden();
    await collapse.focus();
    await page.keyboard.press("Space");
    await expect(row).toBeVisible();
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    const title = row.locator(".thread-link-title");
    const expectedLeft = await page
      .locator(".sidebar-control-action svg")
      .first()
      .evaluate((element) => element.getBoundingClientRect().left);
    expect(await title.evaluate((element) => element.getBoundingClientRect().left)).toBe(
      expectedLeft,
    );
    const before = await title.boundingBox();
    const plainRow = roots.filter({ has: page.locator('a[href="/threads/session-active"]') });
    const plainTitleBounds = await plainRow.locator(".thread-link-title").boundingBox();
    const plainStatusBounds = await plainRow.locator(".status").boundingBox();
    expect(plainTitleBounds!.width).toBeGreaterThan(0);
    expect(plainTitleBounds!.x + plainTitleBounds!.width).toBeLessThan(plainStatusBounds!.x);
    const create = row.getByRole("button", { name: "Создать новую сессию в проекте CodexNest" });
    const pin = row.getByRole("button", { name: "Открепить сессию «Полировка мастерской»" });
    const trigger = row.getByLabel("Действия с сессией «Полировка мастерской»");
    const menu = row.locator(".thread-row-menu");
    await expect(trigger).toHaveCSS("opacity", "0");
    await expect(create).toBeHidden();
    await expect(pin).toBeHidden();
    const restingPin = await row.locator(".thread-pinned-marker").boundingBox();
    expect(before!.x + before!.width).toBeLessThanOrEqual(restingPin!.x);
    expect(restingPin!.x - (before!.x + before!.width)).toBeLessThanOrEqual(12);
    await trigger.focus();
    await expect(trigger).toHaveCSS("opacity", "1");
    await title.hover();
    const hovered = await title.boundingBox();
    expect(hovered!.x).toBe(before!.x);
    expect(hovered).toEqual(before);
    const triggerBounds = await trigger.boundingBox();
    expect(hovered!.x + hovered!.width).toBeLessThanOrEqual(triggerBounds!.x);
    const statusBounds = await row.locator(".status").boundingBox();
    expect(triggerBounds!.x + triggerBounds!.width).toBeLessThanOrEqual(statusBounds!.x);
    await expect(create).toBeHidden();
    await trigger.click();
    await expect(create).toBeVisible();
    await expect(pin).toBeVisible();
    await expect(trigger).toBeHidden();
    await expect(row.locator(".thread-pinned-marker")).toBeHidden();
    expect(await row.boundingBox()).toEqual(topRowBounds);
    expect(await row.locator(".status").boundingBox()).toEqual(statusBounds);
    const actions = row.locator(".thread-row-actions");
    const actionBounds = (await actions.boundingBox())!;
    const expandedTitle = (await title.boundingBox())!;
    expect(expandedTitle.x + expandedTitle.width).toBeLessThanOrEqual(actionBounds.x);
    expect(actionBounds.y).toBeGreaterThanOrEqual(topRowBounds!.y);
    expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(
      topRowBounds!.y + topRowBounds!.height,
    );
    expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(statusBounds!.x);
    await page.getByRole("button", { name: "Активные", exact: true }).hover();
    await expect(menu).not.toHaveAttribute("open");
    await expect(trigger).toHaveCSS("opacity", "0");
    await expect(create).toBeHidden();
    expect(await title.boundingBox()).toEqual(before);
    await title.hover();
    await expect(trigger).toHaveCSS("opacity", "1");
    await expect(create).toBeHidden();
    await trigger.click();
    await expect(page.locator(".sidebar")).toHaveScreenshot(`sidebar-active-${theme}.png`, {
      maxDiffPixelRatio: 0,
    });
    expect((await new AxeBuilder({ page }).include(".sidebar").analyze()).violations).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(create).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(create).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(pin).toBeFocused();
    await page.getByRole("button", { name: "Активные", exact: true }).hover();
    await expect(pin).toBeFocused();
    await expect(menu).toHaveAttribute("open", "");
    await page.keyboard.press("Tab");
    await expect(menu).not.toHaveAttribute("open");
    await trigger.focus();
    await page.keyboard.press("Space");
    await expect(create).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.evaluate((element) => (element as HTMLElement).blur());
    await page.getByRole("button", { name: "Активные", exact: true }).hover();
    expect(await title.boundingBox()).toEqual(before);

    await title.hover();
    await trigger.click();
    await pin.click();
    await expect(row).toHaveCount(0);
    await expect(collapse).toHaveText(/0$/);
    expect(await switcher.boundingBox()).toEqual(switcherBefore);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    await page.getByLabel("Действия с сессией «Полировка мастерской»").focus();
    await page.getByLabel("Действия с сессией «Полировка мастерской»").click();
    await page.getByRole("button", { name: "Закрепить сессию «Полировка мастерской»" }).click();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    await expect(roots.first()).toContainText("Полировка мастерской");
    await page.reload();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    await expect(roots.first()).toContainText("Полировка мастерской");
    await row.locator(".thread-link").hover();
    await trigger.click();
    await create.click();
    await expect(page.getByRole("heading", { name: "Новая задача", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/threads\/created-session|\/new\?projectId=project-nest/);
  });
}

for (const count of [0, 1, 12]) {
  test(`keeps each mode button fixed in a narrow sidebar with ${count} pins`, async ({ page }) => {
    await openSidebar(page, "light", count);
    await page.locator(".sidebar").evaluate((element) => {
      (element as HTMLElement).style.width = "240px";
    });
    const switcher = page.locator(".session-list-mode");
    const before = await switcher.boundingBox();
    const buttonsBefore = await modeButtonBounds(page);
    expect(buttonsBefore).toHaveLength(3);
    expect(buttonsBefore[0]!.width).toBe(buttonsBefore[1]!.width);
    const pinned = page.locator(".pinned-group-toggle");
    await pinned.click();
    expect(await switcher.boundingBox()).toEqual(before);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    await expect(page.getByRole("button", { name: "Активные", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(pinned).toHaveAttribute("aria-expanded", String(count > 0));
    await pinned.click();
    await expect(pinned).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Проекты", exact: true }).click();
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    await pinned.click();
    await expect(pinned).toHaveAttribute("aria-expanded", String(count > 0));
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    expect(
      await switcher.locator("button").evaluateAll((buttons) =>
        buttons.every((button) => {
          const bounds = button.getBoundingClientRect();
          const parent = button.parentElement!.getBoundingClientRect();
          return (
            bounds.left >= parent.left &&
            bounds.right <= parent.right &&
            bounds.top >= parent.top &&
            bounds.bottom <= parent.bottom &&
            button.scrollWidth <= button.clientWidth
          );
        }),
      ),
    ).toBe(true);
  });
}

test.describe("touch sidebar actions", () => {
  test.use({ hasTouch: true, viewport: PHONE_VIEWPORT });

  test("fits all four actions in the session row and keeps finish confirmation actionable", async ({
    page,
  }) => {
    await installVisualFixture(page, { theme: "dark", finishableSidebar: true });
    await page.goto("/threads/session-active");
    await waitForVisualReady(page);
    await page.getByRole("button", { name: "Открыть список задач" }).tap();
    await page.locator(".pinned-group-toggle").tap();
    const row = page
      .locator(".thread-branch-row")
      .filter({ has: page.locator('a[href="/threads/session-main"]') });
    const before = await row.boundingBox();
    const status = await row.locator(".status").boundingBox();
    await row.getByLabel("Действия с сессией «Полировка мастерской»").tap();
    const actions = row.locator(".thread-row-actions");
    await expect(actions.locator("button")).toHaveCount(4);
    const bounds = (await actions.boundingBox())!;
    const title = (await row.locator(".thread-link-title").boundingBox())!;
    expect(await row.boundingBox()).toEqual(before);
    expect(await row.locator(".status").boundingBox()).toEqual(status);
    expect(title.width).toBeGreaterThan(0);
    expect(title.x + title.width).toBeLessThanOrEqual(bounds.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(status!.x);
    for (const button of await actions.locator("button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeGreaterThanOrEqual(before!.y);
      expect(box.y + box.height).toBeLessThanOrEqual(before!.y + before!.height);
    }
    const finish = row.getByRole("button", { name: "Закончить сессию «Полировка мастерской»" });
    await finish.tap();
    await expect(finish).toHaveClass(/confirming/);
    await expect(page.locator(".sidebar")).toHaveScreenshot("sidebar-touch-finish-dark.png");
    expect((await new AxeBuilder({ page }).include(".sidebar").analyze()).violations).toEqual([]);
    await page.locator(".sidebar").tap({ position: { x: 20, y: PHONE_VIEWPORT.height - 40 } });
    await row.getByLabel("Действия с сессией «Полировка мастерской»").tap();
    await expect(finish).not.toHaveClass(/confirming/);
  });

  test("opens inline actions, pins without navigation and creates in the same project", async ({
    page,
  }) => {
    await openSidebar(page, "light");
    await page.getByRole("button", { name: "Открыть список задач" }).click();
    const switcher = page.locator(".session-list-mode");
    const switcherBefore = await switcher.boundingBox();
    const buttonsBefore = await modeButtonBounds(page);
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    expect(await switcher.boundingBox()).toEqual(switcherBefore);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    const collapse = page.locator(".pinned-group-toggle");
    expect((await collapse.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    await collapse.tap();
    await expect(page.locator(".active-pinned-sessions")).toBeHidden();
    expect(await switcher.boundingBox()).toEqual(switcherBefore);
    expect(await modeButtonBounds(page)).toEqual(buttonsBefore);
    await collapse.tap();
    await expect(page.locator(".active-pinned-sessions")).toBeVisible();
    const trigger = page.getByLabel("Действия с сессией «Полировка мастерской»");
    const menu = trigger.locator("..");
    await expect(menu.locator(".thread-row-actions")).toBeHidden();
    const touchBounds = await trigger.boundingBox();
    expect(touchBounds!.width).toBeGreaterThanOrEqual(44);
    expect(touchBounds!.height).toBeGreaterThanOrEqual(44);
    const row = menu.locator("..");
    const rowBefore = await row.boundingBox();
    await trigger.tap();
    await expect(menu.locator(".thread-row-actions")).toBeVisible();
    await expect(trigger).toBeHidden();
    expect(await row.boundingBox()).toEqual(rowBefore);
    for (const button of await menu.locator("button").all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.y).toBeGreaterThanOrEqual(rowBefore!.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(rowBefore!.y + rowBefore!.height);
    }
    await expect(page).toHaveURL(/\/threads\/session-active$/);
    await expect(page.locator(".sidebar")).toHaveScreenshot("sidebar-touch-actions.png", {
      maxDiffPixelRatio: 0,
    });
    expect((await new AxeBuilder({ page }).include(".sidebar").analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(menu.locator(".thread-row-actions")).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.tap();
    await page.locator(".sidebar").tap({ position: { x: 20, y: PHONE_VIEWPORT.height - 40 } });
    await expect(menu.locator(".thread-row-actions")).toBeHidden();
    await expect(trigger).toBeVisible();
    await trigger.tap();
    await menu.getByRole("button", { name: "Открепить сессию «Полировка мастерской»" }).tap();
    await expect(trigger).toHaveCount(0);
    await expect(page).toHaveURL(/\/threads\/session-active$/);
    await page.getByRole("button", { name: "Проекты", exact: true }).tap();
    await trigger.tap();
    await menu.getByRole("button", { name: "Закрепить сессию «Полировка мастерской»" }).tap();
    await expect(menu.locator(".thread-row-actions")).toBeHidden();
    await page.getByRole("button", { name: "Активные", exact: true }).tap();
    await trigger.tap();
    await menu.getByRole("button", { name: "Создать новую сессию в проекте CodexNest" }).tap();
    await expect(page.getByRole("heading", { name: "Новая задача", exact: true })).toBeVisible();
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  });
});
