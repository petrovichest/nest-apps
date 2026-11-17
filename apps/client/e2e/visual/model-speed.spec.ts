import { expect, test, type WebSocketRoute } from "@playwright/test";
import type { ModelOption, SessionSettings, ThreadDetail } from "@codexnest/protocol";

import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

const model = (id: string, tiers: string[], isDefault = false): ModelOption => ({
  id,
  displayName: id
    .toUpperCase()
    .replace(/SOL$/, "Sol")
    .replace(/ASTRA$/, "Astra"),
  description: "",
  isDefault,
  supportsPersonality: false,
  serviceTiers: tiers.map((tier) => ({ id: tier, displayName: tier })),
  reasoningEfforts: [
    { value: "high", description: "", isDefault: true },
    { value: "ultra", description: "", isDefault: false },
  ],
});
const sol = model("gpt-6.2-sol", ["priority", "ultrafast"], true);
const astra = model("gpt-6.2-astra", ["priority"]);

for (const theme of ["light", "dark"] as const) {
  for (const language of ["ru", "en"] as const) {
    for (const width of [390, 1440]) {
      test(`model catalog and speed ${width} ${language} ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 1000 });
        const seed = structuredClone(snapshot);
        seed.instanceId = "model-speed";
        seed.uiLanguage = language;
        seed.models = [model("gpt-6.1-sol", ["priority"], true)];
        seed.taskDefaults = { model: sol.id, serviceTier: "ultrafast", reasoningEffort: "high" };
        const summary = seed.threads.find((thread) => thread.id === "session-main")!;
        summary.settings = { collaborationMode: "default", model: "gpt-6.1-sol" };
        const detail: ThreadDetail = {
          version: { instanceId: seed.instanceId, sequence: seed.sequence },
          summary,
          turns: [],
          olderTurnsCursor: null,
          queuedMessages: [],
          draft: null,
        };
        await installVisualFixture(page, { theme, snapshot: seed });
        await page.route("http://127.0.0.1:4310/**", (route) => route.abort());
        let socket: WebSocketRoute | undefined;
        let connections = 0;
        await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (ws) => {
          connections++;
          socket = ws;
          ws.onMessage((message) => {
            if (JSON.parse(String(message)).type === "authenticate")
              ws.send(JSON.stringify({ type: "snapshot", snapshot: seed }));
          });
        });
        const patches: Array<Record<string, unknown>> = [];
        await page.route("**/api/v1/threads/session-main/settings", async (route) => {
          if (route.request().method() === "OPTIONS") return route.fallback();
          const patch = route.request().postDataJSON();
          patches.push(patch);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete summary.settings[key as keyof SessionSettings];
            else Object.assign(summary.settings, { [key]: value });
          }
          await route.fulfill({ json: summary, headers: { "access-control-allow-origin": "*" } });
        });
        await page.route("**/api/v1/threads/session-main", (route) =>
          route.request().method() === "OPTIONS"
            ? route.fallback()
            : route.fulfill({ json: detail, headers: { "access-control-allow-origin": "*" } }),
        );
        await page.goto("/threads/session-main");
        await waitForVisualReady(page);
        const draft = page.getByRole("textbox", {
          name: language === "ru" ? "Сообщение для Codex" : "Message for Codex",
        });
        await draft.fill("Keep this draft while models refresh");
        const opener = page.getByRole("button", {
          name: language === "ru" ? "Модель и уровень рассуждений" : "Model and reasoning effort",
        });
        await opener.click();
        await expect(page.getByRole("radio", { name: sol.displayName, exact: true })).toHaveCount(
          0,
        );
        seed.models = [sol, astra];
        const sequence = ++seed.sequence;
        socket!.send(
          JSON.stringify({
            type: "event",
            sequence,
            version: { instanceId: seed.instanceId, sequence },
            event: { type: "models.changed", models: [sol, astra] },
          }),
        );
        await page.getByRole("radio", { name: sol.displayName, exact: true }).click();
        expect(connections).toBe(1);
        const speed = page.getByRole("combobox", {
          name: language === "ru" ? "Скорость" : "Speed",
          exact: true,
        });
        await expect(speed.locator("option")).toHaveText([
          language === "ru" ? "Обычная" : "Normal",
          "Fast",
          "Ultrafast",
        ]);
        const geometry = await speed.boundingBox();
        await speed.selectOption("ultrafast");
        await expect.poll(() => patches.at(-1)).toEqual({ serviceTier: "ultrafast" });
        await expect(speed).toHaveValue("ultrafast");
        expect(await speed.boundingBox()).toEqual(geometry);
        await page
          .getByRole("dialog")
          .screenshot({ path: testInfo.outputPath("session-speed.png") });
        await page.keyboard.press("Escape");
        await expect(opener).toContainText("Ultrafast");
        // The composer keeps pointer actions anchored to the draft field.
        await expect(draft).toBeFocused();
        await expect(draft).toHaveValue("Keep this draft while models refresh");
        await opener.click();
        await expect(speed).toHaveValue("ultrafast");
        await page.getByRole("radio", { name: astra.displayName, exact: true }).click();
        await expect(speed).toHaveValue("");
        await expect(speed.locator("option[value=ultrafast]")).toHaveCount(0);
        await expect.poll(() => patches.at(-1)).toEqual({ model: astra.id, serviceTier: null });
        await page.keyboard.press("Escape");
        await expect(draft).toHaveValue("Keep this draft while models refresh");

        await page.goto("/settings?section=codex");
        const defaults = page.getByRole("combobox", {
          name: language === "ru" ? "Скорость по умолчанию" : "Default speed",
          exact: true,
        });
        await expect(defaults).toHaveValue("ultrafast");
        await defaults.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("default-speed.png") });
        await page.locator("#settings-session-model").selectOption(astra.id);
        await expect(defaults).toHaveValue("");
        await expect(defaults.locator("option[value=ultrafast]")).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      });
    }
  }
}
