import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "./fixtures";

for (const locale of ["en-US", "ru-RU"]) {
  test.describe(locale, () => {
    test.use({ locale });

    for (const surface of ["popup", "panel"]) {
      test(`${surface} uses the bundled font and preserves input through theme changes`, async ({
        context,
        extensionId,
      }, testInfo) => {
        const page = await context.newPage();
        await page.setViewportSize({ width: 360, height: 844 });
        await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
        const remoteRequests: string[] = [];
        page.on("request", (request) => {
          if (/^https?:/.test(request.url())) remoteRequests.push(request.url());
        });
        await page.goto(`chrome-extension://${extensionId}/${surface}.html`);
        const theme = page.getByLabel(locale === "ru-RU" ? "Тема" : "Theme", { exact: true });
        const address = page.locator("#base-url");
        await expect(address).toBeVisible();
        // The client role scale must not change the compact extension forms.
        await expect(address).toHaveCSS("font-size", "12.5px");
        await expect(theme).toHaveCSS("font-size", "11px");
        const logo = page.locator("img.nest-logo");
        await expect(logo).toBeVisible();
        await expect
          .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
          .toBeGreaterThan(0);
        const logoSource = await logo.evaluate(async (img: HTMLImageElement) =>
          (await fetch(img.src)).text(),
        );
        const expectedLogo = await readFile(
          resolve(import.meta.dirname, "../../client/public/favicon.svg"),
          "utf8",
        );
        const marks = await page.evaluate(
          (sources) =>
            sources.map((source) =>
              [
                ...new DOMParser().parseFromString(source, "image/svg+xml").querySelectorAll("*"),
              ].map((element) => [
                element.tagName,
                [...element.attributes].map((attr) => [attr.name, attr.value]),
              ]),
            ),
          [logoSource, expectedLogo],
        );
        expect(marks[0]).toEqual(marks[1]);
        await expect(theme).toHaveValue("system");
        await expect(page.locator("html")).toHaveAttribute("data-resolved-theme", "dark");
        await expect(page.locator("body")).toHaveCSS("background-color", "rgb(23, 24, 23)");
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(() =>
            [...document.fonts].some((font) => font.family === "Onest" && font.status === "loaded"),
          ),
        ).toBe(true);
        await expect(page).toHaveScreenshot(`${surface}-${locale}-dark.png`, {
          animations: "disabled",
          caret: "hide",
        });

        await address.fill("http://draft.example");
        const originalAddress = await address.elementHandle();
        await theme.selectOption("light");
        await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
        await expect(address).toHaveValue("http://draft.example");
        expect(
          await page.evaluate(
            (node) => node === document.querySelector("#base-url"),
            originalAddress,
          ),
        ).toBe(true);
        await expect(page).toHaveScreenshot(`${surface}-${locale}-light.png`, {
          animations: "disabled",
          caret: "hide",
        });

        await page.emulateMedia({ colorScheme: "dark" });
        await expect(page.locator("html")).toHaveAttribute("data-resolved-theme", "light");
        await theme.selectOption("system");
        await expect(page.locator("html")).toHaveAttribute("data-resolved-theme", "dark");
        await address.focus();
        await page.emulateMedia({ colorScheme: "light" });
        await expect(page.locator("html")).toHaveAttribute("data-resolved-theme", "light");
        await expect(address).toBeFocused();
        await expect(address).toHaveCSS("outline-style", "none");
        const focusShadow = await address.evaluate((el) => getComputedStyle(el).boxShadow);
        await theme.focus();
        await expect(theme).toHaveCSS("outline-style", "none");
        await expect(theme).toHaveCSS("box-shadow", focusShadow);
        await expect(address).not.toHaveCSS("box-shadow", focusShadow);
        await page.emulateMedia({ forcedColors: "active" });
        await expect(theme).toHaveCSS("outline-style", "solid");
        await address.focus();
        await expect(address).toHaveCSS("outline-style", "solid");
        await page.emulateMedia({ forcedColors: "none" });

        await theme.selectOption("dark");
        await page.reload();
        await expect(theme).toHaveValue("dark");
        await expect(page.locator("html")).toHaveAttribute("data-resolved-theme", "dark");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(remoteRequests).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`${surface}-${locale}-restored.png`) });
      });

      test(`${surface} keeps a connected session selected in both themes`, async ({
        browserServer,
        context,
        extensionId,
      }) => {
        await context.route("http://appearance.test/", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>A long browser tab title for the connected appearance contract</title>",
          }),
        );
        const target = await context.newPage();
        await target.goto("http://appearance.test/");
        const page = await context.newPage();
        await page.setViewportSize({ width: 360, height: 640 });
        await page.goto(`chrome-extension://${extensionId}/${surface}.html`);
        await page.locator("#base-url").fill(browserServer.baseUrl);
        await page.locator("#owner-token").fill("fixture-token");
        await page.getByRole("button", { name: /^(Connect|Подключить)$/ }).click();
        await expect(page.locator(".status-connected")).toBeVisible();
        await page.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          const target = tabs.find((tab) => tab.url === "http://appearance.test/");
          if (target?.id === undefined) throw new Error("Target tab is unavailable");
          await chrome.tabs.update(target.id, { active: true });
        });
        await expect(page.locator(".tab-copy strong")).toHaveText(
          "A long browser tab title for the connected appearance contract",
        );
        const session = page.getByRole("combobox", {
          name: locale === "ru-RU" ? "Сессия" : "Session",
          exact: true,
        });
        await session.selectOption("thread-existing");
        const originalSession = await session.elementHandle();
        for (const theme of ["dark", "light"]) {
          await page.locator("#extension-theme").selectOption(theme);
          await expect(session).toHaveValue("thread-existing");
          expect(
            await session.evaluate((node, original) => node === original, originalSession),
          ).toBe(true);
          await expect(page.locator(".status-dot")).toHaveCSS(
            "background-color",
            theme === "dark" ? "rgb(90, 200, 120)" : "rgb(43, 162, 76)",
          );
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await expect(page).toHaveScreenshot(`${surface}-${locale}-connected-${theme}.png`);
        }
      });
    }
  });
}

test("popup and panel share the appearance preference without resetting forms", async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage();
  const panel = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  const address = panel.locator("#base-url");
  await address.fill("http://preserve.example");
  await address.focus();
  await popup.locator("#extension-theme").selectOption("dark");
  await expect(panel.locator("#extension-theme")).toHaveValue("dark");
  await expect(panel.locator("html")).toHaveAttribute("data-resolved-theme", "dark");
  await expect(address).toHaveValue("http://preserve.example");
  await expect(address).toBeFocused();
  await panel.locator("#extension-theme").selectOption("light");
  await expect(popup.locator("#extension-theme")).toHaveValue("light");
});

test("includes the Onest license alongside the extension assets", async () => {
  const license = await readFile(
    resolve(import.meta.dirname, "../dist/chrome/assets/LICENSE-Onest-OFL.txt"),
    "utf8",
  );
  expect(license).toContain("SIL OPEN FONT LICENSE");
});

test("ships the shared CON mark for Chrome's toolbar and extension manager", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.icons).toEqual({
    "16": "icons/codexnest-16.png",
    "32": "icons/codexnest-32.png",
    "48": "icons/codexnest-48.png",
    "128": "icons/codexnest-128.png",
  });
  expect(manifest.action?.default_icon).toEqual({
    "16": manifest.icons!["16"],
    "32": manifest.icons!["32"],
  });
  const source = await readFile(
    resolve(import.meta.dirname, "../../client/public/favicon.svg"),
    "utf8",
  );
  for (const [size, path] of Object.entries(manifest.icons!)) {
    const png = await readFile(resolve(import.meta.dirname, "../dist/chrome", path));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([Number(size), Number(size)]);
    const difference = await page.evaluate(
      async ({ source, path, size }) => {
        const images = await Promise.all(
          [chrome.runtime.getURL(path), `data:image/svg+xml,${encodeURIComponent(source)}`].map(
            async (url) => {
              const image = new Image();
              image.src = url;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = size;
              const context = canvas.getContext("2d")!;
              context.drawImage(image, 0, 0, size, size);
              return context.getImageData(0, 0, size, size).data;
            },
          ),
        );
        return Math.max(...images[0]!.map((value, index) => Math.abs(value - images[1]![index]!)));
      },
      { source, path, size: Number(size) },
    );
    // Allow one level of rounding when PNG alpha is decoded back into the canvas.
    expect(difference, `${path} must be regenerated from favicon.svg`).toBeLessThanOrEqual(1);
  }
});
