import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { CodexAccount, CodexAccountsStatus } from "@codexnest/protocol";
import { installVisualFixture, snapshot, waitForVisualReady } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}: saved Codex accounts and device login`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const account = (id: string, email: string): CodexAccount => ({
        id,
        email,
        plan: "plus",
        authenticated: true,
        proxy: {
          enabled: false,
          protocol: "http",
          host: null,
          port: null,
          username: null,
          hasPassword: false,
        },
        connectionError: null,
        rateLimits: {
          limits: {
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
            secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null },
          },
          updatedAt: 1,
          refreshing: false,
          refreshError: false,
        },
      });
      let status: CodexAccountsStatus = {
        cliVersion: "0.167.0",
        autoSwitch: false,
        warmLimits: false,
        currentAccountId: "first",
        accounts: [
          account("first", "primary@example.com"),
          account("second", "another.long.account.address@example.com"),
        ],
      };
      await installVisualFixture(page, {
        theme,
        snapshot: {
          ...snapshot,
          codexAccounts: status,
          threads: snapshot.threads.map((thread) => ({ ...thread, currentTurnId: null })),
        },
      });
      let cancelled = false;
      await page.route("**/api/v1/settings/codex/accounts**", async (route) => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        const headers = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization,content-type",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        };
        if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname.endsWith("/proxy/test"))
          return route.fulfill({ headers, json: { ok: true, latencyMs: 25, error: null } });
        if (url.pathname.endsWith("/select")) {
          status = { ...status, currentAccountId: "second" };
          return route.fulfill({ json: status, headers });
        }
        if (url.pathname.includes("/logins")) {
          if (method === "DELETE") cancelled = true;
          return route.fulfill({
            headers,
            json: {
              id: "login",
              state: method === "DELETE" ? "cancelled" : "waiting",
              url: "https://auth.openai.com/codex/device",
              userCode: "ABCD-EFGH",
              accountId: null,
              error: null,
            },
          });
        }
        return route.fulfill({ headers, json: status });
      });
      await page.goto("/settings?section=codex");
      await waitForVisualReady(page);
      const accounts = page.getByRole("region", { name: "Codex CLI" });
      const second = accounts.getByRole("article", {
        name: "another.long.account.address@example.com",
      });
      await second.getByRole("button", { name: "Использовать аккаунт" }).last().click();
      await expect(second.getByText("Используется")).toBeVisible();
      expect(
        await page
          .locator(".settings-scroll")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(
        (await new AxeBuilder({ page }).include(".claude-accounts").analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("accounts.png") });
      await accounts.getByRole("button", { name: "Добавить аккаунт" }).click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Прокси", { exact: true })
        .fill("socks5://account-user:account-password@proxy.example.test:1080");
      await expect(dialog.getByText("Прокси распознан")).toBeVisible();
      await dialog.getByRole("button", { name: "Проверить прокси", exact: true }).click();
      await expect(dialog.getByText("Подключение доступно · 25 мс")).toBeVisible();
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(
        (await new AxeBuilder({ page }).include(".claude-account-dialog").analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("connection.png") });
      await dialog.getByRole("button", { name: "Перейти к входу" }).click();
      await expect(dialog.getByRole("textbox", { name: "Код для входа в ChatGPT" })).toHaveValue(
        "ABCD-EFGH",
      );
      await expect(dialog.getByRole("link", { name: "Открыть страницу входа" })).toHaveAttribute(
        "target",
        "_blank",
      );
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(
        (await new AxeBuilder({ page }).include(".claude-account-dialog").analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("login.png") });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => cancelled).toBe(true);
    });
  }
}
