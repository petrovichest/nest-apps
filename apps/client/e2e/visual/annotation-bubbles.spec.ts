import { expect, test, type Page } from "@playwright/test";
import type { ThreadDetail } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

async function openAnnotations(page: Page, theme: "light" | "dark", count: number) {
  const seed = structuredClone(snapshot);
  seed.attention = [];
  const summary = seed.threads.find((thread) => thread.id === "session-main")!;
  summary.settings.collaborationMode = "default";
  summary.browserStatus = "disabled";
  const quote = "Сначала сохраним черновик";
  const text = `${quote}\n\n${"Подробности решения и проверка поведения интерфейса.\n\n".repeat(50)}`;
  const detail: ThreadDetail = {
    summary,
    olderTurnsCursor: null,
    queuedMessages: [],
    draft: {
      input: "Учти эти замечания",
      images: [],
      files:
        count === 2
          ? [
              {
                id: "file",
                name: "interface.png",
                path: "/work/interface.png",
                size: 148000,
                mediaType: "image/png",
              },
            ]
          : [],
      pasteBlocks: count === 2 ? [{ id: "context", text: "Контекст для проверки интерфейса" }] : [],
      goalMode: false,
      annotations: Array.from({ length: count }, (_, index) => ({
        id: `note-${index}`,
        messageId: "answer",
        source: "agentMessage" as const,
        quote,
        startOffset: 0,
        endOffset: quote.length,
        comment:
          index === 0
            ? "Добавь проверку ошибок: если сохранение не удалось, текст остаётся в поле."
            : `Покажи аннотации вертикальной стопкой — замечание ${index + 1}`,
        createdAt: index + 1,
      })),
      updatedAt: summary.updatedAt,
    },
    turns: [
      {
        id: "turn",
        status: "completed",
        startedAt: summary.updatedAt - 1000,
        completedAt: summary.updatedAt,
        durationMs: 1000,
        items: [
          {
            id: "answer",
            type: "agentMessage",
            text,
            images: [],
            status: "completed",
            timestamp: summary.updatedAt,
            phase: "final_answer",
          },
        ],
      },
    ],
  };
  await installVisualFixture(page, { theme, snapshot: seed });
  await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
  await page.route("**/api/v1/threads/session-main", (route) =>
    route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } }),
  );
  await page.route("**/api/v1/threads/session-main/draft**", (route) =>
    route.fulfill({
      json: { ...route.request().postDataJSON(), updatedAt: summary.updatedAt + 1 },
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.goto("/threads/session-main");
  await expect(page.locator(".message.agentMessage")).toBeVisible();
  await waitForVisualReady(page);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 1440]) {
    test(`annotation bubbles at ${width}px in ${theme}: navigation, deletion and layout`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await openAnnotations(page, theme, 2);
      const composer = page.locator(".composer");
      const bubbles = composer.getByRole("group", { name: "Аннотации" });
      const cards = bubbles.locator(".annotation-bubble");
      await expect(cards).toHaveCount(2);
      const first = (await cards.nth(0).boundingBox())!;
      const second = (await cards.nth(1).boundingBox())!;
      expect(second.x).toBe(first.x);
      expect(second.y - first.y - first.height).toBeCloseTo(8, 0);
      expect(first.width).toBeLessThanOrEqual(440);
      expect(first.x).toBeGreaterThanOrEqual(0);
      expect(first.x + first.width).toBeLessThanOrEqual(width);
      expect((await composer.locator(".composer-attachments").boundingBox())!.y).toBeLessThan(
        first.y,
      );
      expect((await composer.locator(".paste-blocks").boundingBox())!.y).toBeGreaterThan(
        second.y + second.height,
      );
      expect(
        await cards
          .first()
          .locator(".annotation-bubble-comment")
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await composer.screenshot({ path: testInfo.outputPath("annotation-bubbles.png") });

      const scroll = page.locator(".conversation-scroll");
      const tail = await scroll.evaluate((element) => element.scrollTop);
      await bubbles.getByRole("button", { name: "Перейти к аннотации 1" }).click();
      const editor = page.locator(".annotation-editor");
      const field = editor.getByRole("textbox");
      await expect(field).toBeFocused();
      expect(await scroll.evaluate((element) => element.scrollTop)).toBeLessThan(tail);
      const sourcePosition = await scroll.evaluate((element) => element.scrollTop);
      await field.fill("Сохранённый комментарий");
      await editor.getByRole("button", { name: "Сохранить аннотацию" }).click();
      await expect(bubbles.getByText("Сохранённый комментарий")).toBeVisible();
      expect(await scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(sourcePosition, 0);

      await bubbles.getByRole("button", { name: "Перейти к аннотации 1" }).click();
      await bubbles.getByRole("button", { name: "Удалить аннотацию 1" }).focus();
      await page.keyboard.press("Enter");
      await expect(editor).toHaveCount(0);
      await expect(cards).toHaveCount(1);
      await expect(page.locator('.annotation-marker[data-annotation-id="note-1"]')).toHaveText("1");
    });

    for (const count of [0, 8]) {
      test(`annotation stack with ${count} notes at ${width}px in ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await openAnnotations(page, theme, count);
        const bubbles = page.getByRole("group", { name: "Аннотации" });
        if (count === 0) {
          await expect(bubbles).toHaveCount(0);
        } else {
          const list = bubbles.locator(".annotation-bubble-list");
          await expect(bubbles.locator(".annotation-bubble")).toHaveCount(count);
          expect((await list.boundingBox())!.height).toBeLessThanOrEqual(240);
          expect(
            await list.evaluate((element) => element.scrollHeight > element.clientHeight),
          ).toBe(true);
          await list.evaluate((element) => {
            element.scrollTop = 100;
          });
          expect(await list.evaluate((element) => element.scrollTop)).toBe(100);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await expect(page.locator(".composer").getByRole("textbox")).toHaveValue(
          "Учти эти замечания",
        );
      });
    }
  }
}
