import { expect, test, type Page } from "@playwright/test";
import type { ThreadDetail } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

const previewImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aI9sAAAAASUVORK5CYII=";

async function openAnnotations(
  page: Page,
  theme: "light" | "dark",
  count: number,
  attachments: "mixed" | "paste" | "none" = count === 2 ? "mixed" : "none",
) {
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
      images:
        attachments === "mixed"
          ? [
              { id: "image-one", name: "preview-1.png", url: previewImage },
              { id: "image-two", name: "preview-2.png", url: previewImage },
            ]
          : [],
      files:
        attachments === "mixed"
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
      pasteBlocks:
        attachments !== "none" ? [{ id: "context", text: "Контекст для проверки интерфейса" }] : [],
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
      const row = composer.locator(".composer-card-filters");
      const input = composer.locator(".composer-box");
      const panels = composer.locator(".composer-card-panel");
      const annotationFilter = row.getByRole("button", { name: "Аннотации (2)", exact: true });
      await expect(row.locator(".composer-card-filter")).toHaveCount(4);
      await expect(annotationFilter).toHaveAttribute("aria-expanded", "false");
      for (const panel of await panels.all()) await expect(panel).toBeHidden();
      const rowPosition = (await row.boundingBox())!;
      const inputPosition = (await input.boundingBox())!;
      await composer.screenshot({ path: testInfo.outputPath("annotation-filters-collapsed.png") });

      const textarea = composer.getByRole("textbox", { name: "Сообщение для Codex" });
      const pointerFilter = row.getByRole("button", { name: "Изображения (2)", exact: true });
      await textarea.focus();
      await pointerFilter.click();
      await expect(textarea).toBeFocused();
      await expect(textarea).toHaveValue("Учти эти замечания");
      await pointerFilter.click();
      await expect(textarea).toBeFocused();
      await expect(pointerFilter).toHaveAttribute("aria-expanded", "false");

      await annotationFilter.focus();
      await page.keyboard.press("Enter");
      await expect(annotationFilter).toHaveAttribute("aria-expanded", "true");
      await expect(annotationFilter).toBeFocused();
      const annotationPanel = composer.locator('.composer-card-panel[data-kind="annotations"]');
      await expect(annotationPanel).toBeVisible();
      expect((await annotationPanel.boundingBox())!.y).toBeLessThan(rowPosition.y);
      expect((await row.boundingBox())!.y).toBeCloseTo(rowPosition.y, 0);
      expect((await input.boundingBox())!.y).toBeCloseTo(inputPosition.y, 0);
      for (const kind of ["images", "files", "text"])
        await expect(composer.locator(`.composer-card-panel[data-kind="${kind}"]`)).toBeHidden();
      const bubbles = annotationPanel.getByRole("group", { name: "Аннотации", exact: true });
      const cards = bubbles.locator(".annotation-bubble");
      await expect(cards).toHaveCount(2);
      const first = (await cards.nth(0).boundingBox())!;
      const second = (await cards.nth(1).boundingBox())!;
      expect(second.x).toBe(first.x);
      expect(second.y - first.y - first.height).toBeCloseTo(8, 0);
      expect(first.width).toBeLessThanOrEqual(440);
      expect(first.x).toBeGreaterThanOrEqual(0);
      expect(first.x + first.width).toBeLessThanOrEqual(width);
      expect(second.y + second.height).toBeLessThanOrEqual(rowPosition.y);
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

      const imageFilter = row.getByRole("button", { name: "Изображения (2)", exact: true });
      await imageFilter.focus();
      await page.keyboard.press("Enter");
      const imagePanel = composer.locator('.composer-card-panel[data-kind="images"]');
      await expect(imagePanel).toBeVisible();
      await expect(annotationPanel).toBeHidden();
      expect((await imagePanel.boundingBox())!.y).toBeLessThan(rowPosition.y);
      expect((await row.boundingBox())!.y).toBeCloseTo(rowPosition.y, 0);
      expect((await input.boundingBox())!.y).toBeCloseTo(inputPosition.y, 0);
      const imageOpener = imagePanel.getByRole("button", {
        name: "Открыть изображение preview-1.png",
        exact: true,
      });
      await imageOpener.focus();
      await page.keyboard.press("Enter");
      const viewer = page.getByRole("dialog", { name: "Просмотр изображений" });
      await expect(viewer.getByAltText("preview-1.png")).toBeVisible();
      await viewer.getByRole("button", { name: "Следующее изображение" }).click();
      await expect(viewer.getByAltText("preview-2.png")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(viewer).toBeHidden();
      await expect(imageOpener).toBeFocused();

      await row.getByRole("button", { name: "Файлы (1)", exact: true }).click();
      await expect(composer.locator('.composer-card-panel[data-kind="files"]')).toBeVisible();
      await expect(composer.getByText("interface.png", { exact: true })).toBeVisible();
      await expect(imagePanel).toBeHidden();
      const textFilter = row.getByRole("button", { name: "Вставки текста (1)", exact: true });
      await textFilter.click();
      await expect(composer.locator('.composer-card-panel[data-kind="text"]')).toBeVisible();
      await expect(composer.locator('.composer-card-panel[data-kind="files"]')).toBeHidden();
      await expect(composer.locator(".paste-card-snippet")).toHaveText(
        "Контекст для проверки интерфейса",
      );
      await textFilter.focus();
      await page.keyboard.press("Enter");
      await expect(textFilter).toHaveAttribute("aria-expanded", "false");
      for (const panel of await panels.all()) await expect(panel).toBeHidden();
      expect((await row.boundingBox())!.y).toBeCloseTo(rowPosition.y, 0);
      expect((await input.boundingBox())!.y).toBeCloseTo(inputPosition.y, 0);
      await annotationFilter.click();

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
          await expect(page.locator(".composer-card-filters")).toHaveCount(0);
        } else {
          const filter = page.getByRole("button", { name: "Аннотации (8)", exact: true });
          await expect(filter).toHaveAttribute("aria-expanded", "false");
          await filter.click();
          const list = page.locator('.composer-card-panel[data-kind="annotations"]');
          await expect(bubbles.locator(".annotation-bubble")).toHaveCount(count);
          const heightLimit = await page.evaluate(() => Math.min(240, innerHeight * 0.3));
          expect((await list.boundingBox())!.height).toBeLessThanOrEqual(heightLimit + 1);
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

test("adding a third card hides an unfinished paste edit without losing text or focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAnnotations(page, "light", 1, "paste");
  const composer = page.locator(".composer");
  await expect(composer.locator(".composer-card-filters")).toHaveCount(0);
  await expect(composer.getByRole("group", { name: "Аннотации", exact: true })).toBeVisible();
  await composer.getByRole("button", { name: /Вставленный текст/ }).click();
  await composer.getByRole("button", { name: "Редактировать вставленный текст" }).click();
  const source = composer.getByRole("textbox", { name: "Исходный вставленный текст" });
  await source.fill("Несохранённый контекст");
  await expect(source).toBeFocused();
  await composer.locator('input[type="file"]').setInputFiles({
    name: "extra.png",
    mimeType: "image/png",
    buffer: Buffer.from(previewImage.split(",")[1]!, "base64"),
  });
  const filter = composer.getByRole("button", { name: "Вставки текста (1)", exact: true });
  await expect(filter).toBeVisible();
  await expect(source).toBeHidden();
  await expect(composer.getByRole("textbox", { name: "Сообщение для Codex" })).toBeFocused();
  await filter.click();
  await expect(source).toHaveValue("Несохранённый контекст");
  await composer.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(composer.locator(".paste-card-snippet")).toHaveText("Несохранённый контекст");
});
