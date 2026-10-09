import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ThreadDetail } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

const previewImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aI9sAAAAASUVORK5CYII=";

async function openAnnotations(
  page: Page,
  theme: "light" | "dark",
  count: number,
  attachments: "mixed" | "paste" | "files" | "none" = count === 2 ? "mixed" : "none",
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
        attachments === "files"
          ? [
              {
                id: "file-one",
                name: "first-interface-review.md",
                path: "/work/first-interface-review.md",
                size: 148000,
                mediaType: "text/markdown",
              },
              {
                id: "file-two",
                name: "second-interface-review.md",
                path: "/work/second-interface-review.md",
                size: 248000,
                mediaType: "text/markdown",
              },
            ]
          : attachments === "mixed"
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
        attachments === "mixed" || attachments === "paste"
          ? [{ id: "context", text: "Контекст для проверки интерфейса" }]
          : [],
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

async function expectNoListOverflow(panel: Locator, allowDecorativeOverflow = false) {
  const dimensions = await panel.evaluate((element) =>
    [element, ...element.querySelectorAll(".annotation-bubble-list, .composer-attachments")].map(
      (list) => {
        const style = getComputedStyle(list);
        list.scrollTop = 100;
        list.scrollLeft = 100;
        return {
          clientWidth: list.clientWidth,
          scrollWidth: list.scrollWidth,
          clientHeight: list.clientHeight,
          scrollHeight: list.scrollHeight,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          scrollTop: list.scrollTop,
          scrollLeft: list.scrollLeft,
        };
      },
    ),
  );
  for (const dimension of dimensions) {
    expect(["auto", "scroll"]).not.toContain(dimension.overflowX);
    expect(["auto", "scroll"]).not.toContain(dimension.overflowY);
    expect(dimension.scrollTop).toBe(0);
    expect(dimension.scrollLeft).toBe(0);
    // Removal buttons extend beyond thumbnails without making the list scrollable.
    if (!allowDecorativeOverflow) {
      expect(dimension.scrollWidth).toBeLessThanOrEqual(dimension.clientWidth + 1);
      expect(dimension.scrollHeight).toBeLessThanOrEqual(dimension.clientHeight + 1);
    }
  }
}

async function settleComposerLayout(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      ),
  );
}

async function visibleMessageAnchor(page: Page) {
  const index = await page.locator(".message-markdown p").evaluateAll((paragraphs) => {
    const scrollTop = document.querySelector(".conversation-scroll")!.getBoundingClientRect().top;
    const composerTop = document.querySelector(".composer-box")!.getBoundingClientRect().top;
    return paragraphs.findIndex((paragraph) => {
      const bounds = paragraph.getBoundingClientRect();
      return bounds.top >= scrollTop + 16 && bounds.bottom < composerTop - 120;
    });
  });
  expect(index).toBeGreaterThanOrEqual(0);
  return page.locator(".message-markdown p").nth(index);
}

async function conversationPosition(page: Page, anchor: Locator) {
  return {
    ...(await page.locator(".conversation-scroll").evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      reservedHeight: getComputedStyle(element.closest(".conversation-pane")!)
        .getPropertyValue("--composer-overlay-height")
        .trim(),
      timelinePadding: getComputedStyle(element.querySelector(".timeline")!).paddingBottom,
      composerHeight: document.querySelector(".composer")!.getBoundingClientRect().height,
      composerBoxHeight: document.querySelector(".composer-box")!.getBoundingClientRect().height,
    }))),
    anchorTop: (await anchor.boundingBox())!.y,
  };
}

async function readConversationHistory(page: Page) {
  const scroll = page.locator(".conversation-scroll");
  const previous = await scroll.evaluate((element) => element.scrollTop);
  await scroll.hover({ position: { x: 20, y: 200 } });
  await page.mouse.wheel(0, -600);
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBeLessThan(previous - 100);
  await expect(
    page.getByRole("button", { name: "Прокрутить к последнему сообщению" }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const top = await scroll.evaluate((element) => element.scrollTop);
      await settleComposerLayout(page);
      return (await scroll.evaluate((element) => element.scrollTop)) - top;
    })
    .toBe(0);
}

function expectConversationPositionUnchanged(
  before: Awaited<ReturnType<typeof conversationPosition>>,
  after: Awaited<ReturnType<typeof conversationPosition>>,
) {
  expect(after.scrollTop).toBeCloseTo(before.scrollTop, 0);
  expect(after.anchorTop).toBeCloseTo(before.anchorTop, 0);
  expect(after.reservedHeight).toBe(before.reservedHeight);
  expect(after.timelinePadding).toBe(before.timelinePadding);
  expect(after.scrollHeight).toBe(before.scrollHeight);
}

for (const width of [390, 1440]) {
  for (const position of ["tail", "reading"] as const) {
    test(`annotation category opening preserves conversation position at ${position} at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await openAnnotations(page, "light", 3, "none");
      const scroll = page.locator(".conversation-scroll");
      await expect
        .poll(() =>
          scroll.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      if (position === "reading") await readConversationHistory(page);
      const anchor = await visibleMessageAnchor(page);
      const before = await conversationPosition(page, anchor);
      const category = page.getByRole("button", { name: "Аннотации (3)", exact: true });
      await category.click();
      await expect(category).toHaveAttribute("aria-expanded", "true");
      await settleComposerLayout(page);
      const opened = await conversationPosition(page, anchor);
      await category.click();
      await expect(category).toHaveAttribute("aria-expanded", "false");
      await settleComposerLayout(page);
      const closed = await conversationPosition(page, anchor);
      await testInfo.attach("conversation-position", {
        body: JSON.stringify({ position, before, opened, closed }, null, 2),
        contentType: "application/json",
      });
      for (const state of [opened, closed]) expectConversationPositionUnchanged(before, state);
    });
  }

  test(`textarea autoheight reserves conversation space at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openAnnotations(page, "light", 3, "none");
    const anchor = await visibleMessageAnchor(page);
    const before = await conversationPosition(page, anchor);
    const textarea = page.getByRole("textbox", { name: "Сообщение для Codex" });
    await textarea.fill("Многострочный черновик\n".repeat(8).trim());
    await settleComposerLayout(page);
    const after = await conversationPosition(page, anchor);
    const growth = after.composerBoxHeight - before.composerBoxHeight;
    expect(growth).toBeGreaterThan(40);
    expect(
      Math.abs(parseFloat(after.timelinePadding) - parseFloat(before.timelinePadding) - growth),
    ).toBeLessThanOrEqual(1);
    expect(after.scrollHeight - after.clientHeight - after.scrollTop).toBeLessThanOrEqual(1);
    const message = (await page.locator(".message.agentMessage").boundingBox())!;
    const input = (await page.locator(".composer-box").boundingBox())!;
    expect(message.y + message.height).toBeLessThanOrEqual(input.y);
  });
}

for (const count of [0, 1]) {
  test(`saving annotation ${count + 1} preserves conversation position below the compact threshold`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAnnotations(page, "light", count, "none");
    const paragraph = await visibleMessageAnchor(page);
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 0);
      range.setEnd(element.firstChild!, 15);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    const editor = page.getByRole("textbox", { name: "Комментарий к выделенному тексту" });
    await expect(editor).toBeFocused();
    await editor.fill("Новое замечание без сдвига переписки");
    await settleComposerLayout(page);
    const anchor = await visibleMessageAnchor(page);
    const before = await conversationPosition(page, anchor);
    await editor.press("Enter");
    await expect(editor).toHaveCount(0);
    const bubbles = page.locator(".composer .annotation-bubble");
    await expect(bubbles).toHaveCount(count + 1);
    await expect(page.locator(".composer-card-filters")).toHaveCount(0);
    await settleComposerLayout(page);
    expectConversationPositionUnchanged(before, await conversationPosition(page, anchor));
    await bubbles
      .last()
      .getByRole("button", { name: `Удалить аннотацию ${count + 1}`, exact: true })
      .click();
    await expect(bubbles).toHaveCount(count);
    await settleComposerLayout(page);
    expectConversationPositionUnchanged(before, await conversationPosition(page, anchor));
  });
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
      const pager = composer.locator(".composer-card-pager");
      const annotationFilter = row.getByRole("button", { name: "Аннотации (2)", exact: true });
      await expect(row.locator(".composer-card-filter")).toHaveCount(4);
      for (const circle of await row.locator(".composer-card-filter").all()) {
        const bounds = (await circle.boundingBox())!;
        expect(bounds.width).toBe(48);
        expect(bounds.height).toBe(48);
        const icon = (await circle.locator("svg").boundingBox())!;
        const count = (await circle.locator(".composer-card-count").boundingBox())!;
        expect(count.y).toBeGreaterThanOrEqual(icon.y + icon.height);
        expect(count.y + count.height).toBeLessThanOrEqual(bounds.y + bounds.height);
        expect(count.x).toBeGreaterThanOrEqual(bounds.x);
        expect(count.x + count.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        const surface = await circle.evaluate((element) => {
          const style = getComputedStyle(element);
          const expected = document.createElement("span");
          expected.style.backgroundColor = "var(--color-floating)";
          element.appendChild(expected);
          const background = getComputedStyle(expected).backgroundColor;
          expected.remove();
          return { actual: style.backgroundColor, expected: background };
        });
        expect(surface.actual).toBe(surface.expected);
      }
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
      await expect(cards.filter({ visible: true })).toHaveCount(1);
      const first = (await cards.nth(0).boundingBox())!;
      await expect(cards.nth(1)).toBeHidden();
      expect(first.width).toBeLessThanOrEqual(440);
      expect(first.x).toBeGreaterThanOrEqual(0);
      expect(first.x + first.width).toBeLessThanOrEqual(width);
      expect(first.y + first.height).toBeLessThanOrEqual(rowPosition.y);
      await expect(pager.getByRole("status")).toHaveText("1 из 2");
      await expect(annotationPanel).toHaveAttribute("data-stack-depth", "1");
      const previousAnnotation = pager.getByRole("button", {
        name: "Предыдущее вложение",
        exact: true,
      });
      const nextAnnotation = pager.getByRole("button", {
        name: "Следующее вложение",
        exact: true,
      });
      await expect(previousAnnotation).toBeDisabled();
      await nextAnnotation.click();
      await expect(pager.getByRole("status")).toHaveText("2 из 2");
      await expect(cards.nth(0)).toBeHidden();
      await expect(cards.nth(1)).toBeVisible();
      await expect(annotationPanel).toHaveAttribute("data-stack-depth", "0");
      await expect(nextAnnotation).toBeDisabled();
      expect((await row.boundingBox())!.y).toBeCloseTo(rowPosition.y, 0);
      expect((await input.boundingBox())!.y).toBeCloseTo(inputPosition.y, 0);
      await previousAnnotation.click();
      await expect(cards.nth(0)).toBeVisible();
      await expectNoListOverflow(annotationPanel);
      const numberStyle = await cards
        .first()
        .locator(".annotation-bubble-number")
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(numberStyle).toBe("rgba(0, 0, 0, 0)");
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
      await expect(
        imagePanel.locator(".composer-attachment").filter({ visible: true }),
      ).toHaveCount(1);
      await expect(pager.getByRole("status")).toHaveText("1 из 2");
      await expectNoListOverflow(imagePanel, true);
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
      await pager.getByRole("button", { name: "Следующее вложение", exact: true }).click();
      await expect(pager.getByRole("status")).toHaveText("2 из 2");
      await expect(imageOpener).toBeHidden();
      await expect(
        imagePanel.getByRole("button", { name: "Открыть изображение preview-2.png", exact: true }),
      ).toBeVisible();
      await expectNoListOverflow(imagePanel, true);

      await row.getByRole("button", { name: "Файлы (1)", exact: true }).click();
      const filePanel = composer.locator('.composer-card-panel[data-kind="files"]');
      await expect(filePanel).toBeVisible();
      await expect(composer.getByText("interface.png", { exact: true })).toBeVisible();
      await expect(imagePanel).toBeHidden();
      await expectNoListOverflow(filePanel, true);
      const textFilter = row.getByRole("button", { name: "Вставки текста (1)", exact: true });
      await textFilter.click();
      await expect(composer.locator('.composer-card-panel[data-kind="text"]')).toBeVisible();
      await expect(composer.locator('.composer-card-panel[data-kind="files"]')).toBeHidden();
      await expect(composer.locator(".paste-card-snippet")).toHaveText(
        "Контекст для проверки интерфейса",
      );
      await expectNoListOverflow(composer.locator('.composer-card-panel[data-kind="text"]'));
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

    for (const count of [0, 2, 3, 8]) {
      test(`annotation stack with ${count} notes at ${width}px in ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: 844 });
        await openAnnotations(page, theme, count, "none");
        const panel = page.locator('.composer-card-panel[data-kind="annotations"]');
        const bubbles = panel.getByRole("group", { name: "Аннотации", exact: true });
        if (count === 0) {
          await expect(bubbles).toHaveCount(0);
          await expect(page.locator(".composer-card-filters")).toHaveCount(0);
        } else if (count <= 2) {
          await expect(page.locator(".composer-card-filters")).toHaveCount(0);
          await expect(bubbles.locator(".annotation-bubble").filter({ visible: true })).toHaveCount(
            count,
          );
          await expect(page.locator(".composer-card-pager")).toHaveCount(0);
          await expectNoListOverflow(bubbles.locator(".annotation-bubble-list"));
        } else {
          const filter = page.getByRole("button", { name: `Аннотации (${count})`, exact: true });
          await expect(filter).toHaveAttribute("aria-expanded", "false");
          await filter.click();
          await expect(bubbles.locator(".annotation-bubble")).toHaveCount(count);
          const row = page.locator(".composer-card-filters");
          const input = page.locator(".composer-box");
          const pager = page.locator(".composer-card-pager");
          const rowPosition = (await row.boundingBox())!;
          const inputPosition = (await input.boundingBox())!;
          const previous = pager.getByRole("button", {
            name: "Предыдущее вложение",
            exact: true,
          });
          const next = pager.getByRole("button", {
            name: "Следующее вложение",
            exact: true,
          });
          for (let index = 0; index < count; index += 1) {
            await expect(pager.getByRole("status")).toHaveText(`${index + 1} из ${count}`);
            await expect(panel).toHaveAttribute(
              "data-stack-depth",
              String(Math.min(2, count - index - 1)),
            );
            await expect(
              bubbles.locator(".annotation-bubble").filter({ visible: true }),
            ).toHaveCount(1);
            await expect(
              bubbles.getByRole("button", {
                name: `Перейти к аннотации ${index + 1}`,
                exact: true,
              }),
            ).toBeVisible();
            await expectNoListOverflow(panel);
            expect((await row.boundingBox())!.y).toBeCloseTo(rowPosition.y, 0);
            expect((await input.boundingBox())!.y).toBeCloseTo(inputPosition.y, 0);
            if (index === 0 && count === 8 && width === 390) {
              await page.locator(".composer").screenshot({
                path: testInfo.outputPath("annotation-stack-first.png"),
              });
            }
            if (index === 0) await expect(previous).toBeDisabled();
            if (index === count - 1) await expect(next).toBeDisabled();
            else await next.click();
          }
          await previous.click();
          await expect(pager.getByRole("status")).toHaveText(`${count - 1} из ${count}`);
          await filter.click();
          await expect(panel).toBeHidden();
          await expect(filter).toHaveAttribute("aria-expanded", "false");
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

test("two files wrap on a narrow screen without a card list scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 420 });
  await openAnnotations(page, "light", 0, "files");
  const composer = page.locator(".composer");
  await expect(composer.locator(".composer-card-filters")).toHaveCount(0);
  const panel = composer.locator('.composer-card-panel[data-kind="files"]');
  const cards = panel.locator(".composer-file-attachment");
  await expect(cards.filter({ visible: true })).toHaveCount(2);
  const first = (await cards.nth(0).boundingBox())!;
  const second = (await cards.nth(1).boundingBox())!;
  expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
  await expectNoListOverflow(panel);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("two annotations remain expanded without a scrollbar on a short viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 420 });
  await openAnnotations(page, "dark", 2, "none");
  const composer = page.locator(".composer");
  await expect(composer.locator(".composer-card-filters")).toHaveCount(0);
  const panel = composer.locator('.composer-card-panel[data-kind="annotations"]');
  await expect(panel.locator(".annotation-bubble").filter({ visible: true })).toHaveCount(2);
  await expectNoListOverflow(panel.locator(".annotation-bubble-list"));
  await expect(composer.getByRole("textbox", { name: "Сообщение для Codex" })).toBeVisible();
});

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
  await composer.getByRole("button", { name: "Изображения (1)", exact: true }).click();
  await expect(source).toBeHidden();
  await filter.click();
  await expect(source).toHaveValue("Несохранённый контекст");
  await composer.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(composer.locator(".paste-card-snippet")).toHaveText("Несохранённый контекст");
});
