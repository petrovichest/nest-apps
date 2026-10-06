import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../../..");
const temporary = await mkdtemp(join(root, "node_modules/.cache-claude-smoke-"));
const screenshots = join(root, "node_modules/.cache/claude-browser-smoke/screenshots");
await mkdir(screenshots, { recursive: true });
await build({
  entryPoints: [join(directory, "backend-fixture.ts")],
  outfile: join(temporary, "fixture.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node24",
  logLevel: "silent",
});
const { startFixture } = await import(pathToFileURL(join(temporary, "fixture.mjs")).href);
let fixture, browser, page;

async function assertSidebarLayout(page) {
  const layout = await page.locator(".sidebar-controls").evaluate((controls) => {
    const bounds = (element) => element.getBoundingClientRect().toJSON();
    return {
      controls: bounds(controls),
      settings: bounds(controls.querySelector('a[href="/settings"]')),
      update: bounds(controls.querySelector(".app-update-indicator")),
      limits: bounds(controls.querySelector(".codex-limits")),
      connection: bounds(controls.querySelector(".server-connection")),
      project: bounds(controls.querySelector("button.sidebar-control-action:not(.codex-limits)")),
      search: bounds(controls.querySelector(".sidebar-search-action")),
    };
  });
  const center = (bounds) => bounds.top + bounds.height / 2;
  assert.ok(
    Math.abs(center(layout.settings) - center(layout.update)) < 1,
    "Settings and app update stay on the same row",
  );
  assert.ok(
    Math.abs(center(layout.limits) - center(layout.connection)) < 1,
    "Plan limits and server status stay on the same row",
  );
  assert.ok(layout.limits.top >= layout.settings.bottom, "Plan limits use the second row");
  assert.ok(
    Math.abs(center(layout.project) - center(layout.search)) < 1,
    "Add project and search stay on the same row",
  );
  assert.ok(layout.project.top >= layout.limits.bottom, "Project controls use the third row");
  assert.ok(layout.project.width > layout.search.width * 3, "Add project keeps the wide column");
  for (const name of ["settings", "update", "limits", "connection", "project", "search"]) {
    assert.ok(
      layout[name].left >= layout.controls.left - 1 &&
        layout[name].right <= layout.controls.right + 1,
      `${name} stays within the sidebar`,
    );
  }
}

try {
  fixture = await startFixture(join(root, "apps/client/dist-claude"));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "ru-RU",
    reducedMotion: "reduce",
  });
  const errors = [];
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem("claudenest.serverUrl", baseUrl);
      localStorage.setItem("claudenest.token", token);
      localStorage.setItem("claudenest.uiLanguage", "ru");
      localStorage.setItem("claudenest.notificationPromptDismissed", "true");
      class FakeRecorder extends EventTarget {
        static isTypeSupported() {
          return true;
        }
        state = "inactive";
        mimeType = "audio/webm";
        start() {
          this.state = "recording";
        }
        stop() {
          if (this.state === "inactive") return;
          this.state = "inactive";
          const event = new Event("dataavailable");
          Object.defineProperty(event, "data", {
            value: new Blob(["isolated-audio"], { type: this.mimeType }),
          });
          this.dispatchEvent(event);
          this.dispatchEvent(new Event("stop"));
        }
      }
      window.MediaRecorder = FakeRecorder;
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
    },
    { baseUrl: fixture.baseUrl, token: fixture.token },
  );
  await page.goto(fixture.baseUrl);
  assert.equal(await page.title(), "ClaudeNest");
  await assertSidebarLayout(page);
  await page
    .getByRole("button", { name: /Создать новую сессию в проекте/ })
    .first()
    .click();
  const composer = page.locator(".composer textarea");
  await composer.fill("Первый запрос");
  await composer.press("Enter");
  await page.getByText("Что включить в проверку?", { exact: true }).waitFor();
  const threadId = /\/threads\/([^/]+)/.exec(new URL(page.url()).pathname)[1];
  assert.equal(fixture.launcher.owners.get(threadId).transport.permissionMode, "bypassPermissions");
  assert.equal(await page.locator(".composer-permissions-hint, .codex-settings-hint").count(), 0);
  await composer.fill("Уточнение текущего хода");
  await composer.press("Control+Enter");
  await page.getByText("Дополнение принято: Уточнение текущего хода", { exact: true }).waitFor();
  assert.equal(
    fixture.launcher.owners
      .get(threadId)
      .runner.snapshot()
      .currentEvents.filter((event) => event.type === "user").length,
    2,
  );
  assert.equal((await fixture.ui.detail(threadId)).queuedMessages.length, 0);
  await composer.fill("Второй запрос с вложением");
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment smoke"),
  });
  await page.getByText("notes.txt", { exact: true }).first().waitFor();
  await composer.press("Control+Enter");
  const composerVoice = page.locator(".composer");
  await composerVoice.getByRole("button", { name: "Начать запись", exact: true }).click();
  await composerVoice.getByRole("button", { name: "Остановить запись", exact: true }).waitFor();
  await page.waitForTimeout(150);
  await composerVoice.getByRole("button", { name: "Остановить запись", exact: true }).click();
  await page
    .getByText("Дополнение принято: Голосовая проверка работает", { exact: true })
    .waitFor();
  assert.equal(fixture.launcher.owners.get(threadId).transport.sends, 4);
  assert.equal(fixture.launcher.owners.get(threadId).transport.interruptions, 0);
  assert.equal(
    fixture.launcher.owners
      .get(threadId)
      .runner.snapshot()
      .currentEvents.filter((event) => event.type === "user").length,
    4,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator(".composer-permissions-hint, .codex-settings-hint").count(), 0);
  const sendBounds = await page.locator(".composer-action.send").boundingBox();
  assert.ok(
    sendBounds && sendBounds.x + sendBounds.width <= 390,
    "Mobile send stays inside viewport",
  );
  await page.screenshot({ path: join(screenshots, "phone-active-steering.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("checkbox", { name: /Голос/ }).check();
  await page.getByRole("checkbox", { name: /Файлы/ }).check();
  const attention = page.locator(".attention-stack");
  await attention.getByRole("button", { name: "Начать запись", exact: true }).click();
  await attention.getByRole("button", { name: "Остановить запись", exact: true }).waitFor();
  await page.waitForTimeout(150);
  await attention.getByRole("button", { name: "Остановить запись", exact: true }).click();
  await attention.getByRole("textbox").filter({ hasText: "" }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".attention-stack textarea")?.value === "Голосовая проверка работает",
  );
  await attention.getByRole("button", { name: "Отправить ответы", exact: true }).click();
  await page.getByText("Ответы приняты. Продолжаю работу.", { exact: true }).waitFor();
  assert.equal(fixture.launcher.owners.get(threadId).transport.sends, 4);
  assert.equal(fixture.launcher.owners.get(threadId).transport.interruptions, 0);
  assert.equal(
    fixture.requests.some((request) => request.method === "POST" && request.url.endsWith("/steer")),
    true,
  );
  assert.deepEqual(
    fixture.launcher.owners.get(threadId).transport.responses[0].updatedInput.answers,
    { "Что включить в проверку?": "Голос, Файлы, Голосовая проверка работает" },
  );
  await page.screenshot({ path: join(screenshots, "desktop-chat.png") });
  await page.getByRole("button", { name: "Поиск по диалогам", exact: true }).click();
  await page.getByRole("textbox", { name: "Текст для поиска" }).fill("Первый");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await page.locator(".thread-search-result").filter({ hasText: "Первый запрос" }).click();
  assert.equal(new URL(page.url()).pathname, `/threads/${threadId}`);
  assert.equal(
    fixture.requests
      .filter((request) => request.url.includes("/search"))
      .every((request) => /scope=(titles|messages)/.test(request.url)),
    true,
  );
  await page.getByRole("button", { name: "Модель и уровень рассуждений" }).click();
  await page.getByRole("radio", { name: /Haiku/ }).click();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".model-toggle")?.textContent.includes("Haiku"),
  );
  await composer.fill("Сохранённый черновик");
  await page.waitForTimeout(700);
  await page.reload();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), "Сохранённый черновик");
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("tab", { name: "Claude", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Обслуживание", exact: true }).count(), 1);
  assert.equal(await page.getByRole("tab", { name: "Скиллы", exact: true }).count(), 0);
  await page.getByRole("tab", { name: "Claude", exact: true }).click();
  await page.getByText("smoke@example.com", { exact: true }).waitFor();
  const automaticAccounts = page.getByRole("switch", {
    name: "Автоматическое переключение",
    exact: true,
  });
  assert.equal(await automaticAccounts.isChecked(), true);
  const changedAccounts = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === "/api/v1/settings/claude",
  );
  await automaticAccounts.click();
  assert.equal((await changedAccounts).status(), 200);
  await page.waitForFunction(() => !document.querySelector(".claude-account-switch").checked);
  const enabledAccounts = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === "/api/v1/settings/claude",
  );
  await automaticAccounts.click();
  assert.equal((await enabledAccounts).status(), 200);
  await page.waitForFunction(() => document.querySelector(".claude-account-switch").checked);
  await page.getByRole("button", { name: "Добавить аккаунт", exact: true }).click();
  const accountDialog = page.getByRole("dialog", { name: "Добавить аккаунт", exact: true });
  await accountDialog.waitFor();
  await accountDialog
    .getByLabel("Прокси", { exact: true })
    .fill("socks5://smoke-user:smoke-password@proxy.example:1080");
  assert.equal(
    await accountDialog.getByLabel("Тип прокси", { exact: true }).inputValue(),
    "socks5",
  );
  await accountDialog.getByText("proxy.example:1080", { exact: true }).waitFor();
  await accountDialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await page.getByRole("radio", { name: /Полный доступ/ }).waitFor();
  assert.equal(await page.getByRole("radio", { name: /Полный доступ/ }).isChecked(), true);
  assert.equal(await page.getByRole("radio", { name: /Подтверждать автоматически/ }).count(), 0);
  const permissionForm = page.locator("form").filter({
    has: page.getByText("Разрешения Claude", { exact: true }),
  });
  for (const [label, nativeMode] of [
    [/Запрашивать разрешение/, "manual"],
    [/Полный доступ/, "bypassPermissions"],
  ]) {
    await permissionForm.getByRole("radio", { name: label }).check();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === "/api/v1/settings/permissions",
    );
    await permissionForm.getByRole("button", { name: "Сохранить", exact: true }).click();
    assert.equal((await saved).status(), 200);
    assert.equal(fixture.launcher.owners.get(threadId).transport.permissionMode, nativeMode);
  }
  assert.equal(
    fixture.requests.some(
      (request) => request.method === "GET" && request.url === "/api/v1/settings/permissions",
    ),
    false,
    "Permission defaults come from the snapshot without polling",
  );
  await page.getByRole("tab", { name: "Приложение", exact: true }).click();
  await page.getByRole("checkbox", { name: /исправлять очевидные ошибки через Claude/ }).check();
  await page.getByLabel("Модель улучшения расшифровки").selectOption("haiku");
  await page.getByRole("button", { name: "Сохранить распознавание", exact: true }).click();
  await page
    .getByText("Настройки применены на сервере для всех клиентов.", { exact: true })
    .waitFor();
  await page.getByText("Распознавание речи", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("tab", { name: "Обслуживание" }).click();
  await page.getByText("Обновление ClaudeNest", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Скачать свежий APK" }).count(), 1);
  assert.equal(
    await page.getByRole("button", { name: "Скачать расширение для Chrome" }).count(),
    0,
  );
  assert.equal(await page.getByRole("button", { name: "Жёстко перезапустить Codex" }).count(), 0);
  await page.screenshot({ path: join(screenshots, "desktop-settings.png") });
  await page.goto(`${fixture.baseUrl}/threads/${threadId}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await composer.waitFor();
  await assertSidebarLayout(page);
  await page.screenshot({ path: join(screenshots, "phone-chat.png") });
  assert.deepEqual(errors, [], "No uncaught browser errors");
  assert.equal(
    fixture.requests.some((request) =>
      /settings\/codex|rate-limits|\/skills|\/goal|git-changes|artifacts/.test(request.url),
    ),
    false,
    "No unsupported Codex API requests",
  );
  assert.deepEqual(
    fixture.requests.filter(
      (request) =>
        request.status >= 400 &&
        !(request.url === "/api/v1/settings/app/check" && request.status === 503),
    ),
    [],
    "Compatibility requests succeed; update probes are unavailable in this unmanaged fixture",
  );
  console.log(
    `Claude browser smoke passed: projects, session creation, active-turn text and voice steering without interruption, explicit FIFO, attachments, original composer controls, multi-select question voice, search, live model, draft reload, account settings, automatic switching and proxy parsing. Screenshots: ${screenshots}`,
  );
} catch (error) {
  console.error(
    "Smoke API failures:",
    fixture?.requests.filter((request) => request.status >= 400),
  );
  await page
    ?.screenshot({ path: join(screenshots, "failure.png"), fullPage: true })
    .catch(() => undefined);
  console.error(
    "Smoke browser text:",
    (
      await page
        ?.locator("body")
        .innerText()
        .catch(() => "")
    )?.slice(0, 3000),
  );
  throw error;
} finally {
  await browser?.close();
  await fixture?.close();
  await rm(temporary, { recursive: true, force: true });
}
