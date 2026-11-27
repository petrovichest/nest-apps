import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Route, type WebSocketRoute } from "@playwright/test";
import type {
  CodexRateLimitsState,
  ThreadDetail,
  ThreadSearchOccurrence,
  TurnView,
} from "@codexnest/protocol";
import {
  installVisualFixture,
  mainThread,
  snapshot,
  waitForVisualReady,
  PHONE_VIEWPORT,
  DESKTOP_VIEWPORT,
} from "./fixtures";

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

for (const { mobile, theme, sidebarSide, updateAvailable } of [
  { mobile: false, theme: "light", sidebarSide: "left", updateAvailable: false },
  { mobile: false, theme: "dark", sidebarSide: "right", updateAvailable: true },
  { mobile: true, theme: "light", sidebarSide: "right", updateAvailable: true },
  { mobile: true, theme: "dark", sidebarSide: "left", updateAvailable: false },
] as const) {
  test(`sidebar control grid on ${mobile ? "mobile" : "desktop"} ${theme}`, async ({ page }) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    await installVisualFixture(page, { theme, sidebarSide });
    let checks = 0;
    let searches = 0;
    await page.route("**/api/v1/settings/app{,/check}", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      if (new URL(route.request().url()).pathname.endsWith("/check")) checks++;
      return json(route, {
        supported: true,
        canUpdateWithActiveTurns: false,
        currentVersion: "0.1.6",
        latestVersion: updateAvailable ? "0.1.7" : "0.1.6",
        updateAvailable,
        operation: "idle",
        result: "none",
        message: null,
        checkedAt: "2026-08-03T11:45:00.000Z",
        updatedAt: null,
      });
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/threads/search") searches++;
    });
    await page.goto("/threads/session-main");
    await waitForVisualReady(page);
    await expect.poll(() => checks).toBe(1);
    if (mobile) await page.getByRole("button", { name: "Открыть список задач" }).click();
    const sidebar = page.locator(".sidebar");
    const controls = sidebar.locator(".sidebar-controls");
    const settings = controls.getByRole("link", { name: "Настройки", exact: true });
    const update = controls.getByRole("link", {
      name: updateAvailable ? "Доступно обновление CodexNest" : "Обновление CodexNest",
      exact: true,
    });
    const limits = controls.locator(".codex-limits");
    const connection = controls.getByRole("status", {
      name: "Состояние сервера: Подключено",
    });
    const workers = controls.getByRole("link", { name: "Работники", exact: true });
    const board = controls.getByRole("link", { name: "Доска задач", exact: true });
    const addProject = controls.getByRole("button", { name: "Добавить проект", exact: true });
    const search = controls.getByRole("button", { name: "Поиск по диалогам", exact: true });
    await expect(page.locator(".app-frame")).toHaveAttribute("data-sidebar-side", sidebarSide);
    await expect(settings).toBeVisible();
    await expect(update).toBeVisible();
    if (updateAvailable) await expect(update).toHaveClass(/update-available/);
    else await expect(update).not.toHaveClass(/update-available/);
    await expect(connection.locator(".connection-dot.connected")).toBeVisible();
    await expect(search).toBeVisible();
    await expect(search).toHaveText("");
    await expect(search).toHaveAttribute("title", "Поиск по диалогам");
    await expect(sidebar.getByText("Поиск по диалогам", { exact: true })).toHaveCount(0);
    const cells = [settings, update, limits, connection, workers, board, addProject, search];
    await expect(controls.locator(":scope > *")).toHaveCount(cells.length);
    for (const [index, cell] of cells.entries()) {
      expect(
        await cell.evaluate(
          (element, position) => element === element.parentElement?.children[position],
          index,
        ),
      ).toBe(true);
    }
    expect((await settings.locator("svg").boundingBox())!.x).toBe(
      (await limits.locator("svg").boundingBox())!.x,
    );
    const settingsBox = (await settings.boundingBox())!;
    const updateBox = (await update.boundingBox())!;
    const limitsBox = (await limits.boundingBox())!;
    const connectionBox = (await connection.boundingBox())!;
    const addProjectBox = (await addProject.boundingBox())!;
    const searchBox = (await search.boundingBox())!;
    expect(settingsBox.x).toBe(limitsBox.x);
    expect(settingsBox.x).toBe(addProjectBox.x);
    expect(settingsBox.width).toBe(limitsBox.width);
    expect(settingsBox.width).toBe(addProjectBox.width);
    expect(updateBox.x).toBe(connectionBox.x);
    expect(updateBox.x).toBe(searchBox.x);
    expect(updateBox.width).toBe(connectionBox.width);
    expect(updateBox.width).toBe(searchBox.width);
    expect(updateBox.width).toBe(updateBox.height);
    expect(connectionBox.width).toBe(connectionBox.height);
    expect(searchBox.width).toBe(searchBox.height);
    expect(updateBox.x - (settingsBox.x + settingsBox.width)).toBe(8);
    expect(connectionBox.x - (limitsBox.x + limitsBox.width)).toBe(8);
    expect(searchBox.x - (addProjectBox.x + addProjectBox.width)).toBe(8);
    expect(settingsBox.y + settingsBox.height / 2).toBe(updateBox.y + updateBox.height / 2);
    expect(limitsBox.y + limitsBox.height / 2).toBe(connectionBox.y + connectionBox.height / 2);
    expect(addProjectBox.y + addProjectBox.height / 2).toBe(searchBox.y + searchBox.height / 2);
    await settings.focus();
    await page.keyboard.press("Tab");
    await expect(update).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(limits).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(workers).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(board).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(addProject).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(search).toBeFocused();
    await expect(controls).toHaveScreenshot(
      `sidebar-header-${mobile ? "mobile" : "desktop"}-${theme}.png`,
    );
    expect(
      (await new AxeBuilder({ page }).include(".sidebar-controls").analyze()).violations,
    ).toEqual([]);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Поиск по диалогам" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox")).toBeFocused();
    expect(searches).toBe(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(search).toBeFocused();
    await update.click();
    await expect(page).toHaveURL(/\/settings\?section=maintenance$/);
    await expect(page.getByRole("tab", { name: "Обслуживание" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    if (mobile) await expect(sidebar).not.toHaveClass(/open/);
  });
}

for (const mobile of [false, true]) {
  test(`title search opens an unloaded session on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    const searchSnapshot = { ...snapshot, instanceId: "title-search-fixture" };
    await installVisualFixture(page, {
      theme: mobile ? "dark" : "light",
      snapshot: searchSnapshot,
    });
    const found = {
      ...mainThread,
      id: "title-only",
      title: "Обновить хедеры MEXC и задеплоить",
      preview: "надо обновить хедерсы",
      relation: { kind: "session" as const, sessionId: "title-only" },
    };
    let occurrenceReads = 0;
    const scopes: string[] = [];
    await page.route("https://codexnest.visual/api/v1/**", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      const url = new URL(route.request().url());
      if (url.pathname === "/api/v1/threads/search") {
        scopes.push(url.searchParams.get("scope")!);
        expect(url.searchParams.get("q")).toBe("хедеры");
        return json(route, {
          data:
            url.searchParams.get("scope") === "titles" &&
            url.searchParams.get("archived") === "false"
              ? [{ thread: found, snippet: "" }]
              : [],
          nextCursor: null,
        });
      }
      if (url.pathname === "/api/v1/threads/title-only/search") {
        occurrenceReads++;
        return json(
          route,
          { error: { code: "app_server_unavailable", message: "not supported" } },
          503,
        );
      }
      if (url.pathname === "/api/v1/threads/title-only")
        return json(route, {
          version: { instanceId: searchSnapshot.instanceId, sequence: searchSnapshot.sequence },
          summary: found,
          turns: [],
          queuedMessages: [],
          olderTurnsCursor: null,
          draft: null,
        } satisfies ThreadDetail);
      return route.fallback();
    });
    await page.goto("/threads/session-main");
    if (mobile) await page.getByRole("button", { name: "Открыть список задач" }).click();
    await page.getByRole("button", { name: "Поиск по диалогам", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Поиск по диалогам" });
    await dialog.getByRole("textbox").fill("хедеры");
    await dialog.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(dialog.getByText(found.title, { exact: true })).toHaveCount(1);
    await expect.poll(() => scopes.length).toBe(4);
    await dialog.getByRole("button", { name: /Обновить хедеры MEXC/ }).click();
    await expect(page).toHaveURL(/\/threads\/title-only$/);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Сообщение для Codex" })).toBeVisible();
    expect(occurrenceReads).toBe(0);
  });

  test(`global history search and rich copy on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    const searchSnapshot = { ...snapshot, instanceId: "search-fixture" };
    await installVisualFixture(page, {
      theme: mobile ? "dark" : "light",
      snapshot: searchSnapshot,
    });
    const found = {
      ...mainThread,
      id: "outside",
      title: "Архивный диалог о поиске",
      archived: true,
      relation: { kind: "session" as const, sessionId: "outside" },
      canAcceptDirectInput: false,
      codexSettings: { model: "native-model", reasoningEffort: "high" },
    };
    const occurrence: ThreadSearchOccurrence = {
      turnId: "old",
      itemId: "match",
      snippet: "Помню редкий фрагмент из диалога",
      snippetMatchRange: { start: 6, end: 20 },
      turnCursor: "exact-cursor",
    };
    const oldTurn: TurnView = {
      id: "old",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      progress: {
        startedAt: 1,
        explanation: null,
        steps: [],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
      items: [
        {
          type: "agentMessage",
          id: "match",
          text: "## Редкий фрагмент\n\n**Форматирование** сохраняется.\n\n| Поле | Значение |\n| --- | --- |\n| Режим | Архив |",
          images: [],
          timestamp: 2,
          phase: "final_answer",
          status: "completed",
        },
      ],
    };
    const detail: ThreadDetail = {
      version: { instanceId: searchSnapshot.instanceId, sequence: searchSnapshot.sequence },
      summary: found,
      olderTurnsCursor: "canonical-older",
      queuedMessages: [],
      turns: [
        {
          ...oldTurn,
          id: "latest",
          items: [
            {
              ...oldTurn.items[0]!,
              id: "latest-item",
              text: "Текущий ответ",
            } as TurnView["items"][number],
          ],
        },
      ],
    };
    const searches: string[] = [];
    const historyReads: string[] = [];
    let mutations = 0;
    await page.route("https://codexnest.visual/api/v1/**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") return route.fallback();
      const url = new URL(request.url());
      if (
        request.method() !== "GET" &&
        /outside$|outside\/queue|outside\/turns$/.test(url.pathname)
      )
        mutations++;
      if (url.pathname === "/api/v1/threads/search") {
        searches.push(url.search);
        return json(route, {
          data:
            url.searchParams.get("archived") === "true" &&
            url.searchParams.get("scope") === "messages"
              ? [{ thread: found, snippet: occurrence.snippet }]
              : [],
          nextCursor: null,
        });
      }
      if (url.pathname === "/api/v1/threads/outside/search")
        return json(route, { data: [occurrence], nextCursor: null });
      if (url.pathname === "/api/v1/threads/outside/turns/old") {
        historyReads.push(url.searchParams.get("cursor")!);
        return json(route, { instanceId: searchSnapshot.instanceId, turn: oldTurn });
      }
      if (url.pathname === "/api/v1/threads/outside") return json(route, detail);
      if (url.pathname === "/api/v1/threads/outside/draft" && request.method() === "PUT") {
        detail.draft = { ...request.postDataJSON(), updatedAt: Date.now() };
        return json(route, detail.draft);
      }
      return route.fallback();
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          write: async (items: ClipboardItem[]) => {
            const entry = items[0]!;
            const plain = await (await entry.getType("text/plain")).text();
            const html = await (await entry.getType("text/html")).text();
            Object.assign(window, { copiedMessage: { plain, html } });
          },
        },
      });
    });
    await page.goto("/threads/session-main");
    if (mobile) await page.getByRole("button", { name: "Открыть список задач" }).click();
    await page.getByRole("button", { name: "Поиск по диалогам", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Поиск по диалогам" });
    await dialog.getByRole("textbox").fill("редкий фрагмент");
    expect(searches).toHaveLength(0);
    await dialog.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(dialog.getByText("Архивный диалог о поиске")).toBeVisible();
    await expect(dialog.locator(".search-result-title")).toHaveCSS("font-size", "14px");
    await expect(dialog.locator(".search-snippet")).toHaveCSS("font-size", "14px");
    await expect(dialog.locator(".search-context").first()).toHaveCSS("font-size", "14px");
    expect(searches).toHaveLength(4);
    await page.screenshot({ path: testInfo.outputPath("history-search.png") });
    expect(
      (await new AxeBuilder({ page }).include(".thread-search-dialog").analyze()).violations,
    ).toEqual([]);
    await dialog.getByRole("button", { name: /Помню редкий фрагмент/ }).click();
    await dialog.getByRole("button", { name: occurrence.snippet }).click();
    await expect(page.locator(".search-history-match")).toContainText("Форматирование");
    // The development fixture uses React StrictMode, which replays mount effects.
    expect(new Set(historyReads)).toEqual(new Set(["exact-cursor"]));
    expect(historyReads.length).toBeLessThanOrEqual(2);
    await expect(page.getByText("Текущий ответ", { exact: true })).toHaveCount(0);
    const composer = page.getByRole("textbox", { name: "Сообщение для Codex" });
    await expect(composer).toBeEditable();
    // Browsers without a recording codec show a different accessible label.
    await expect(page.locator(".composer-action.microphone")).toBeDisabled();
    await composer.fill("Черновик остаётся доступным");
    await expect(page.getByRole("button", { name: "Отправить", exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("history-target.png") });
    await page
      .locator(".search-history-match")
      .getByRole("button", { name: "Копировать сообщение" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { copiedMessage?: { html: string } }).copiedMessage?.html,
        ),
      )
      .toContain("<table>");
    await page.getByRole("button", { name: "К текущему диалогу" }).click();
    await expect(page.getByText("Текущий ответ", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("Черновик остаётся доступным");
    expect(mutations).toBe(0);
    if (mobile) await page.getByRole("button", { name: "Открыть список задач" }).click();
    await page.getByRole("button", { name: "Поиск по диалогам", exact: true }).click();
    await expect(dialog.getByRole("textbox")).toHaveValue("редкий фрагмент");
    expect(searches).toHaveLength(4);
  });
}

for (const mobile of [false, true]) {
  test(`quota values stream and survive refresh failures on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    await installVisualFixture(page, { theme: mobile ? "dark" : "light" });
    let limits: CodexRateLimitsState = {
      limits: {
        primary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: Date.UTC(2026, 8, 25) },
        secondary: null,
      },
      updatedAt: Date.UTC(2026, 8, 21, 12),
      refreshing: false,
      refreshError: false,
    };
    let sequence = snapshot.sequence;
    let socket: WebSocketRoute;
    await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (ws) => {
      socket = ws;
      ws.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.type === "authenticate") {
          ws.send(
            JSON.stringify({
              type: "snapshot",
              snapshot: {
                ...snapshot,
                instanceId: "limits-server",
                sequence,
                codexRateLimits: limits,
              },
            }),
          );
        } else if (frame.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      });
    });
    const publish = (next: CodexRateLimitsState) => {
      limits = next;
      sequence++;
      socket.send(
        JSON.stringify({
          type: "event",
          sequence,
          version: { instanceId: "limits-server", sequence },
          event: { type: "codexRateLimits.changed", codexRateLimits: limits },
        }),
      );
    };
    let reads = 0;
    await page.route("https://codexnest.visual/api/v1/codex/rate-limits", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      reads++;
      if (reads === 1) {
        publish({ ...limits, refreshError: true });
        return json(
          route,
          { error: { code: "app_server_unavailable", message: "Unavailable" } },
          503,
        );
      }
      publish({
        ...limits,
        refreshError: false,
        updatedAt: limits.updatedAt! + 300_000,
        limits: { ...limits.limits!, primary: { ...limits.limits!.primary!, usedPercent: 12 } },
      });
      return json(route, limits.limits);
    });
    await page.goto("/threads/session-main");
    await expect(page.getByRole("heading", { name: "Полировка мастерской" })).toBeVisible();
    if (mobile) await page.getByRole("button", { name: "Открыть список задач" }).click();
    expect(reads).toBe(0);
    const button = page.locator(".codex-limits");
    const dialog = page.getByRole("dialog", { name: "Лимиты Codex" });
    await expect(button).toHaveText("25.09 92%");
    publish({ ...limits, refreshing: true });
    await expect(button).toBeDisabled();
    await expect(button).toHaveText("25.09 92%");
    publish({
      ...limits,
      refreshing: false,
      updatedAt: limits.updatedAt! + 300_000,
      limits: { ...limits.limits!, primary: { ...limits.limits!.primary!, usedPercent: 10 } },
    });
    await expect(button).toHaveText("25.09 90%");
    expect(reads).toBe(0);
    await button.click();
    await expect(button).toHaveText("25.09 90%");
    await expect(button).toHaveAttribute("title", /Не удалось обновить лимиты Codex/);
    await expect(dialog).toHaveCount(0);
    expect(reads).toBe(1);
    await button.click();
    await expect(button).toHaveText("25.09 88%");
    await expect(dialog).toHaveCount(0);
    expect(reads).toBe(2);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Полировка мастерской" })).toBeVisible();
    if (mobile) await page.getByRole("button", { name: "Открыть список задач" }).click();
    await expect(button).toHaveText("25.09 88%");
    expect(reads).toBe(2);
    await page.screenshot({ path: testInfo.outputPath("inline-limits.png") });
  });
}
