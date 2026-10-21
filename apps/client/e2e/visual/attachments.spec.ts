import { expect, test, type Page } from "@playwright/test";
import { installVisualFixture, waitForVisualReady } from "./fixtures";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=",
  "base64",
);

async function openChat(page: Page, theme: "light" | "dark") {
  await installVisualFixture(page, { theme });
  await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
  await page.goto("/threads/session-main");
  await expect(page.locator(".composer-add-image")).toBeVisible();
  await waitForVisualReady(page);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}: plus opens a visible menu and native file and image choosers`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openChat(page, theme);
      const trigger = page.locator(".composer-add-image");
      const textarea = page.locator(".composer-box textarea");
      await textarea.focus();
      await trigger.click();
      const menu = page.getByRole("dialog", { name: "Вложения" });
      await expect(menu).toBeVisible();
      const bounds = (await menu.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();

      for (const imagesOnly of [false, true]) {
        await trigger.click();
        const chooser = page.waitForEvent("filechooser");
        await menu
          .getByRole("button", {
            name: imagesOnly ? "Добавить изображения" : "Добавить файлы",
            exact: true,
          })
          .click();
        const picker = await chooser;
        expect(picker.isMultiple()).toBe(true);
        expect(await picker.element().getAttribute("accept")).toBe(imagesOnly ? "image/*" : "");
        await picker.setFiles([]);
        await expect(menu).toBeHidden();
      }

      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(menu.getByRole("button", { name: "Добавить файлы", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    });
  }
}

test("files dropped on history attach to the draft with upload feedback and image previews", async ({
  page,
}) => {
  await openChat(page, "light");
  const originalInput = await page.locator(".composer-box textarea").inputValue();
  const uploads: string[] = [];
  let finishUpload!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishUpload = resolve;
  });
  await page.route("**/api/v1/threads/session-main/attachments?**", async (route) => {
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Authorization, Content-Type",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const name = new URL(route.request().url()).searchParams.get("name")!;
    uploads.push(name);
    await pending;
    await route.fulfill({
      headers,
      json: { id: "dropped-file", name, path: `/work/${name}`, size: 5, mediaType: "text/plain" },
    });
  });
  const dataTransfer = await page.evaluateHandle((encoded) => {
    const data = new DataTransfer();
    data.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
    data.items.add(
      new File([Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0))], "screen.png", {
        type: "image/png",
      }),
    );
    return data;
  }, png.toString("base64"));
  const history = page.locator(".conversation-scroll");
  await history.dispatchEvent("dragenter", { dataTransfer });
  const hint = page.locator(".composer-drop-target");
  await expect(hint).toBeVisible();
  const paneBounds = (await page.locator(".conversation-pane").boundingBox())!;
  const hintBounds = (await hint.boundingBox())!;
  expect(hintBounds.height).toBeGreaterThan(paneBounds.height * 0.8);
  await history.dispatchEvent("dragover", { dataTransfer });
  await history.dispatchEvent("drop", { dataTransfer });
  await expect(hint).toBeHidden();
  await expect(page.getByText("Прикрепляем файлы…", { exact: true })).toBeVisible();
  finishUpload();
  await expect(page.getByText("Прикрепляем файлы…", { exact: true })).toBeHidden();
  await expect(page.locator(".composer-file-summary")).toContainText("notes.txt");
  await expect(page.getByRole("button", { name: "Открыть изображение screen.png" })).toBeVisible();
  expect(uploads).toEqual(["notes.txt"]);
  await expect(page.locator(".composer-box textarea")).toHaveValue(originalInput);
  await dataTransfer.dispose();
});
