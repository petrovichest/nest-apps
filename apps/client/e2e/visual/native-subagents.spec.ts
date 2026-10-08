import { expect, test } from "@playwright/test";
import type { ThreadDetail, ThreadSummary } from "@codexnest/protocol";

import { installVisualFixture, mainThread, snapshot, waitForVisualReady } from "./fixtures";

const parent: ThreadSummary = {
  ...mainThread,
  title: "Исследование сигналов входа",
  state: "running",
  currentTurnId: "native-turn",
  settings: { collaborationMode: "default", model: "gpt-5.6-codex", reasoningEffort: "ultra" },
};
const children: ThreadSummary[] = [
  "Нелинейные входы",
  "Последовательности сделок",
  "Повторяющиеся ошибки",
].map((title, index) => ({
  ...parent,
  id: `native-${index}`,
  title,
  pinned: false,
  state: index === 2 ? "completed" : "running",
  currentTurnId: index === 2 ? null : `child-turn-${index}`,
  relation: {
    kind: "subagent",
    sessionId: `native-${index}`,
    parentThreadId: parent.id,
    nickname: ["Hubble", "Mencius", "Carson"][index]!,
    role: "worker",
  },
  codexSettings: { model: "gpt-6.1-sol", reasoningEffort: "ultra" },
}));
const detail: ThreadDetail = {
  summary: parent,
  olderTurnsCursor: null,
  queuedMessages: [],
  draft: null,
  turns: [
    {
      id: "native-turn",
      status: "inProgress",
      startedAt: Date.UTC(2026, 7, 3, 11, 41),
      completedAt: null,
      durationMs: null,
      progress: {
        startedAt: null,
        explanation: null,
        steps: [],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
      items: [
        {
          type: "userMessage",
          id: "input",
          status: "completed",
          text: "Посмотри, какие сигналы повторяются перед входом в сделку.",
          images: [],
          timestamp: Date.UTC(2026, 7, 3, 11, 41),
          phase: null,
        },
        {
          type: "agentMessage",
          id: "intro",
          status: "completed",
          text: "Разделю исследование на три направления. Сопоставлю выводы и соберу общий ответ.",
          images: [],
          timestamp: null,
          phase: "commentary",
        },
        ...children.map((child, index) => ({
          type: "subagentLaunch" as const,
          id: `launch-${index}`,
          source: "codex" as const,
          status: "completed" as const,
          title: child.title,
          threadId: child.id,
          agentPath: `/root/task_${index}`,
          timestamp: Date.UTC(2026, 7, 3, 11, 42),
        })),
        {
          type: "agentMessage",
          id: "outro",
          status: "completed",
          text: "Пока агенты исследуют свои части, сверяю общие условия и исходные данные.",
          images: [],
          timestamp: Date.UTC(2026, 7, 3, 11, 44),
          phase: "commentary",
        },
        ...Array.from({ length: 12 }, (_, index) => ({
          type: "agentMessage" as const,
          id: `update-${index}`,
          status: "completed" as const,
          text: "Параллельно идёт сбор данных для независимой проверки. Агенты исследуют разные части задачи, после чего сопоставлю их выводы.",
          images: [],
          timestamp: Date.UTC(2026, 7, 3, 11, 44 + index),
          phase: "commentary" as const,
        })),
      ],
    },
  ],
};

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 820, 821, 1440]) {
    for (const enlarged of [false, true]) {
      test(`native agents: ${theme}, ${width}px, ${enlarged ? "large" : "default"} type`, async ({
        page,
        browserName,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width <= 820 ? 844 : 1000 });
        await installVisualFixture(page, {
          theme,
          snapshot: {
            ...snapshot,
            attention: [],
            threads: [
              parent,
              {
                ...parent,
                id: "session-ordinary",
                title: "Обычная сессия без агентов",
                pinned: false,
                relation: { kind: "session", sessionId: "session-ordinary" },
              },
              ...children.map((child) =>
                enlarged && child.id === "native-2"
                  ? {
                      ...child,
                      title: "ПроверитьПовторяющиесяОшибкиБезПробеловИОченьДлинноеНазваниеЗадачи",
                    }
                  : child,
              ),
            ],
          },
        });
        if (enlarged)
          await page.addInitScript(() => {
            localStorage.setItem("codexnest.typography", JSON.stringify({ ui: 24, caption: 20 }));
          });
        const requests: string[] = [];
        page.on("request", (request) => requests.push(request.url()));
        await page.route("https://codexnest.visual/api/v1/threads/session-main", (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          return route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } });
        });
        await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
        await page.goto("/threads/session-main");
        await waitForVisualReady(page);
        const sidebarRow = page.locator(".sidebar .thread-branch-row").filter({
          has: page.locator('a[href="/threads/session-main"]'),
        });
        if (width <= 820) await page.getByRole("button", { name: "Открыть список задач" }).click();
        for (const mode of ["Проекты", "Активные"]) {
          await page.getByRole("button", { name: mode, exact: true }).click();
          const toggle = sidebarRow.locator(".thread-subagent-count");
          await expect(toggle).toHaveAccessibleName("Показать субагентов");
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          await expect(toggle).toHaveText(mode === "Проекты" ? "3" : "2");
          await expect(page.locator('.sidebar a[href^="/threads/native-"]')).toHaveCount(0);
          const title = (await sidebarRow.locator(".thread-link-title").boundingBox())!;
          const ordinary = (await page
            .locator('.sidebar a[href="/threads/session-ordinary"] .thread-link-title')
            .boundingBox())!;
          const counter = (await toggle.boundingBox())!;
          expect(title.x).toBe(ordinary.x);
          expect(title.x + title.width).toBeLessThanOrEqual(counter.x);
          expect(counter.width).toBeGreaterThanOrEqual(44);
          expect(counter.height).toBeGreaterThanOrEqual(32);
          const pin = (await sidebarRow.locator(".thread-pinned-marker").boundingBox())!;
          expect(counter.x + counter.width).toBeLessThanOrEqual(pin.x);
          expect(
            await toggle.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return {
                nestedInLink: Boolean(element.closest("a")),
                hit: element.contains(
                  document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
                ),
              };
            }),
          ).toEqual({ nestedInLink: false, hit: true });
          await toggle.locator("svg").click();
          await expect(page.locator('.sidebar a[href^="/threads/native-"]')).toHaveCount(
            mode === "Проекты" ? 3 : 2,
          );
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          await toggle.focus();
          await page.keyboard.press("Space");
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          await expect(page.locator('.sidebar a[href^="/threads/native-"]')).toHaveCount(0);
          await expect(page).toHaveURL(/\/threads\/session-main$/);
        }
        await page.getByRole("button", { name: "Проекты", exact: true }).click();
        if (width <= 820)
          await page
            .getByRole("button", { name: "Закрыть меню" })
            .click({ position: { x: width - 2, y: 10 } });
        const scroll = page.locator(".conversation-scroll");
        await scroll.evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
          element.scrollTop = 0;
        });
        const card = page.locator(".native-subagent-launches");
        await expect(card).toHaveCount(1);
        const cardToggle = card.getByRole("button");
        await expect(cardToggle).toHaveAttribute("aria-expanded", "false");
        await expect(card.getByRole("link")).toHaveCount(0);
        await page.mouse.move(0, 0);
        await expect(card).toHaveCSS("padding", "4px");
        await expect(card).toHaveCSS("border-radius", "20px");
        await expect(card).toHaveCSS("border-width", "0px");
        await expect(cardToggle).toHaveCSS("min-height", "44px");
        await expect(cardToggle).toHaveCSS("padding", "10px 12px");
        const heading = card.locator(".native-subagent-label strong");
        await expect(heading).toHaveCSS("font-size", enlarged ? "24px" : "14px");
        await expect(heading).toHaveCSS("font-weight", "400");
        await expect(heading).toHaveCSS("text-transform", "none");
        await expect(heading).toHaveCSS("letter-spacing", "normal");
        await expect(card.locator("time")).toHaveCSS("font-size", enlarged ? "20px" : "12px");
        if (width <= 820) {
          const title = (await heading.boundingBox())!;
          const metadata = (await card.locator(".native-subagent-summary").boundingBox())!;
          const time = (await card.locator("time").boundingBox())!;
          expect(metadata.y).toBeGreaterThanOrEqual(title.y + title.height);
          expect(time.x).toBeCloseTo(title.x, 1);
        }
        const surfaces = await card.evaluate((element) => {
          const reference = document.createElement("div");
          reference.style.cssText = "position: absolute; visibility: hidden; pointer-events: none";
          element.parentElement!.append(reference);
          const resolveSurface = (background: string, shadow: string) => {
            reference.style.background = `var(${background})`;
            reference.style.boxShadow = `var(${shadow})`;
            const style = getComputedStyle(reference);
            return { background: style.backgroundColor, shadow: style.boxShadow };
          };
          const result = {
            rest: resolveSurface("--color-floating", "--chat-inner-shadow"),
            raised: resolveSurface("--color-floating", "--sidebar-surface-shadow"),
            pressed: resolveSurface("--sidebar-control-active", "--sidebar-pressed-shadow"),
          };
          reference.remove();
          return result;
        });
        const expectSurface = async (surface: { background: string; shadow: string }) => {
          await expect(card).toHaveCSS("background-color", surface.background);
          await expect(card).toHaveCSS("box-shadow", surface.shadow);
          await expect(cardToggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await expect(cardToggle).toHaveCSS("box-shadow", "none");
        };
        await expectSurface(surfaces.rest);
        const collapsedBounds = (await card.boundingBox())!;
        if (width === 1440 && !enlarged) expect(collapsedBounds.height).toBe(52);
        const captureCard =
          browserName === "chromium" &&
          !enlarged &&
          ((width === 1440 && theme === "dark") || (width === 390 && theme === "light"));
        const screenshotCard = async (name: string) => {
          const bounds = (await card.boundingBox())!;
          const viewport = page.viewportSize()!;
          const x = Math.max(0, bounds.x - 32);
          const y = Math.max(0, bounds.y - 32);
          await page.screenshot({
            path: testInfo.outputPath(name),
            clip: {
              x,
              y,
              width: Math.min(viewport.width - x, bounds.x + bounds.width + 32 - x),
              height: Math.min(viewport.height - y, bounds.y + bounds.height + 32 - y),
            },
          });
        };
        if (captureCard) await screenshotCard("native-launch-card-collapsed.png");
        if (await page.evaluate(() => matchMedia("(hover: hover)").matches)) {
          await cardToggle.hover();
          await expectSurface(surfaces.raised);
          expect(await card.boundingBox()).toEqual(collapsedBounds);
        }
        await cardToggle.hover();
        await page.mouse.down();
        await expectSurface(surfaces.pressed);
        expect(await card.boundingBox()).toEqual(collapsedBounds);
        await page.mouse.move(0, 0);
        await page.mouse.up();
        await expect(cardToggle).toHaveAttribute("aria-expanded", "false");
        await expectSurface(surfaces.rest);
        await page.keyboard.press("Tab");
        await cardToggle.focus();
        await expect(card).toHaveCSS("outline-style", "solid");
        await expect(cardToggle).toHaveCSS("outline-style", "none");
        await expectSurface(surfaces.raised);
        expect(await card.boundingBox()).toEqual(collapsedBounds);
        await page.keyboard.press("Space");
        await expect(cardToggle).toHaveAttribute("aria-expanded", "true");
        await expect(card.getByRole("link")).toHaveCount(3);
        await page.keyboard.press("Enter");
        await expect(cardToggle).toHaveAttribute("aria-expanded", "false");
        await expect(card.getByRole("link")).toHaveCount(0);
        expect(await card.boundingBox()).toEqual(collapsedBounds);
        await cardToggle.click();
        await expect(card.getByRole("link")).toHaveCount(3);
        await expect(card.getByText("2 работают", { exact: true })).toBeVisible();
        await expect(card.getByText("1 готов", { exact: true })).toBeVisible();
        await expect(card.getByText(/Нажмите на задачу/)).toHaveCount(0);
        await expect(card.locator(".native-subagent-top strong").first()).toHaveCSS(
          "font-size",
          enlarged ? "24px" : "14px",
        );
        await expect(card.locator(".native-subagent-meta").first()).toHaveCSS(
          "font-size",
          enlarged ? "20px" : "12px",
        );
        expect(await card.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          false,
        );
        if (captureCard) {
          await cardToggle.evaluate((element) => element.blur());
          await page.mouse.move(0, 0);
          await expectSurface(surfaces.rest);
          await screenshotCard("native-launch-card-expanded.png");
        }
        const link = card.getByRole("link").first();
        await card.getByRole("button").focus();
        await page.keyboard.press("Tab");
        await expect(link).toBeFocused();
        await expect(link).toHaveCSS("outline-style", "solid");
        expect(requests.some((url) => /\/threads\/native-\d/.test(url))).toBe(false);

        await scroll.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const bar = page.locator(".subagent-activity");
        const barToggle = bar.locator(".subagent-activity-toggle");
        await expect(barToggle).toHaveAttribute("aria-expanded", "false");
        await expect(barToggle).toBeInViewport();
        await expect(card).not.toBeInViewport();
        await expect(bar.getByRole("status")).toHaveText("2 агента работают");
        await expect(barToggle).toHaveCSS(
          "font-size",
          enlarged ? (width <= 820 ? "20px" : "24px") : width <= 820 ? "12px" : "14px",
        );
        const topAtTail = await scroll.evaluate((element) => element.scrollTop);
        await barToggle.click();
        await expect(bar.getByRole("region")).toBeInViewport();
        await expect(bar.getByRole("link")).toHaveCount(3);
        expect(await scroll.evaluate((element) => element.scrollTop)).toBe(topAtTail);
        await page.keyboard.press("Escape");
        await expect(barToggle).toHaveAttribute("aria-expanded", "false");
        await expect(barToggle).toBeFocused();
        expect(requests.some((url) => url.endsWith("/interrupt"))).toBe(false);
        await scroll.evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
          element.scrollTop = 0;
        });
        await expect(barToggle).toBeInViewport();
        await barToggle.click();
        expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
        await page.keyboard.press("Escape");
        expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
        const geometry = await bar.evaluate((element) => {
          const composer = element.closest(".composer")!;
          const panel = element.querySelector(".subagent-activity-panel");
          return {
            contained: composer.contains(element),
            overflows: element.scrollWidth > element.clientWidth,
            pageOverflows: document.documentElement.scrollWidth > innerWidth,
            panelClosed: panel === null,
          };
        });
        expect(geometry).toEqual({
          contained: true,
          overflows: false,
          pageOverflows: false,
          panelClosed: true,
        });
        expect(requests.some((url) => /\/threads\/native-\d/.test(url))).toBe(false);

        if (
          browserName === "chromium" &&
          !enlarged &&
          ((width === 1440 && theme === "dark") || (width === 390 && theme === "light"))
        ) {
          await link.evaluate((element) => {
            element.blur();
          });
          await scroll.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          if (width === 390) await barToggle.click();
          await barToggle.evaluate((element) => {
            element.blur();
          });
          await page.screenshot({ path: testInfo.outputPath("native-subagents.png") });
        }
        if (width === 390 && theme === "light" && !enlarged) {
          await page.route("https://codexnest.visual/api/v1/threads/native-0", (route) =>
            route.fulfill({
              json: {
                ...detail,
                summary: children[0],
                turns: [
                  {
                    ...detail.turns[0],
                    items: [
                      {
                        type: "agentMessage",
                        id: "own-answer",
                        status: "completed",
                        text: "Собственный ответ субагента",
                        images: [],
                        timestamp: null,
                        phase: "final_answer",
                      },
                    ],
                  },
                ],
              },
              headers: { "access-control-allow-origin": "*" },
            }),
          );
          if ((await barToggle.getAttribute("aria-expanded")) !== "true") await barToggle.click();
          await bar.getByRole("link").first().focus();
          await page.keyboard.press("Enter");
          await expect(page).toHaveURL(/\/threads\/native-0$/);
          await expect(page.getByText("Собственный ответ субагента")).toBeVisible();
          await expect(page.locator(".subagent-readonly")).toBeVisible();
          await expect(page.locator(".composer-box textarea")).toHaveCount(0);
        }
      });
    }
  }
}

for (const status of ["inProgress", "failed"] as const) {
  test(`native launch: English ${status} at 320px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await installVisualFixture(page, {
      theme: "dark",
      snapshot: { ...snapshot, uiLanguage: "en", attention: [], threads: [parent] },
    });
    await page.route("https://codexnest.visual/api/v1/threads/session-main", (route) =>
      route.fulfill({
        json: {
          ...detail,
          turns: [
            {
              ...detail.turns[0],
              items: [
                {
                  type: "subagentLaunch",
                  id: "launch-english",
                  source: "codex",
                  status,
                  title: "Check layout",
                  threadId: null,
                  timestamp: Date.UTC(2026, 7, 3, 11, 42),
                },
              ],
            },
          ],
        },
        headers: { "access-control-allow-origin": "*" },
      }),
    );
    await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
    await page.goto("/threads/session-main");
    await waitForVisualReady(page);
    const card = page.locator(".native-subagent-launches");
    await expect(
      card.getByText(status === "failed" ? "Failed to start subagent" : "Starting subagent", {
        exact: true,
      }),
    ).toBeVisible();
    await card.getByRole("button", { name: "Show subagents" }).click();
    await expect(card.getByText("Check layout", { exact: true })).toBeVisible();
    await expect(
      card.getByLabel(status === "failed" ? "Subagent status: Error" : "Subagent status: Starting"),
    ).toBeVisible();
    await expect(card.getByRole("link")).toHaveCount(0);
    expect(await card.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
  });
}
