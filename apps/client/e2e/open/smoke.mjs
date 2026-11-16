import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect } from "@playwright/test";
import { startNativeFixture } from "./native-fixture.mjs";

const root = resolve(import.meta.dirname, "../../../..");
const scratch = await mkdtemp(join(tmpdir(), "opennest-browser-"));
const images = join(scratch, "screenshots");
await mkdir(images);
const portServer = createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const token = randomBytes(32).toString("hex");
await writeFile(join(scratch, "token"), token, { mode: 0o600 });
const projectPath = join(scratch, "project");
await mkdir(projectPath);
const native = await startNativeFixture();
const url = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const env = {
  ...process.env,
  OPENNEST_CONFIG_DIR: scratch,
  OPENNEST_STATE_DIR: join(scratch, "state"),
  OPENNEST_RUNTIME_DIR: join(scratch, "run"),
  OPENNEST_PORT: String(port),
  OPENNEST_NATIVE_URL: native.url,
  OPENNEST_NATIVE_PASSWORD: "",
  OPENNEST_MANAGED_INSTALL: "0",
  OPENNEST_RELEASE_PATH: root,
};
for (const key of [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENCODE_SERVER_PASSWORD",
])
  delete env[key];
let backend;
let browser;
let output = "";
const pageErrors = [];
function start() {
  const child = spawn(process.execPath, [join(root, "apps/open-server/dist/index.js")], {
    env,
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  return child;
}
async function ready() {
  await expect
    .poll(
      async () =>
        fetch(`${url}/api/v1/health`, { headers })
          .then((r) => r.json())
          .then((s) => s.recoveryState)
          .catch(() => "unavailable"),
      { timeout: 20_000, message: output },
    )
    .toBe("ready");
}
async function api(path, method = "GET", body) {
  const r = await fetch(url + path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`Facade ${method} ${path}: HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}
async function stop() {
  if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
  const child = backend;
  const closed = new Promise((r) => child.once("close", r));
  child.kill("SIGTERM");
  await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Isolated backend did not stop")), 5_000),
    ),
  ]);
}
try {
  backend = start();
  await ready();
  const project = await api("/api/v1/projects", "POST", {
    path: projectPath,
    displayName: "OpenNest",
  });
  const created = await api(`/api/v1/projects/${project.id}/threads`, "POST", {
    clientCreationId: "browser-contract",
  });
  const id = created.thread.id;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "ru-RU" });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("opennest.uiLanguage", "ru");
    localStorage.setItem("opennest.theme", "dark");
    localStorage.setItem("opennest.notificationPromptDismissed", "true");
  });
  await page.goto(url);
  await page.getByLabel("Bearer token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Подключиться", exact: true }).click();
  await page.goto(`${url}/settings?section=codex`);
  const key = page.getByLabel("API-ключ OpenRouter", { exact: true });
  await expect(key).toBeVisible();
  await key.fill("sk-or-browser-fixture");
  await page.getByRole("button", { name: "Сохранить ключ", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ключ сохранён." })).toBeVisible();
  await expect(key).toHaveValue("");
  assert.equal(native.savedKey, true);
  await page.getByRole("button", { name: "Проверить OpenCode", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "OpenCode доступен." })).toBeVisible();
  assert.equal(
    await page.evaluate(() => JSON.stringify(localStorage).includes("sk-or-browser-fixture")),
    false,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(images, "settings-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.getByRole("heading", { name: "OpenRouter", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(images, "settings-phone.png"), animations: "disabled" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.goto(`${url}/threads/${id}`);
  const composer = page.locator(".composer textarea");
  await expect(composer).toBeVisible();
  await page.getByRole("button", { name: "Модель и уровень рассуждений", exact: true }).click();
  await page.getByText("Gemini 2.5 Pro", { exact: true }).last().click();
  await expect
    .poll(async () => (await api(`/api/v1/threads/${id}`)).summary.settings.model)
    .toBe("openrouter/google/gemini-2.5-pro");
  await composer.fill("browser response");
  await composer.press("Enter");
  await expect(page.getByText("Fixture answer: browser response", { exact: true })).toBeVisible();
  assert.equal(native.prompts.at(-1).input.model.modelID, "google/gemini-2.5-pro");
  await page.screenshot({ path: join(images, "chat-phone.png"), animations: "disabled" });
  await composer.fill("question");
  await composer.press("Enter");
  await expect(page.getByText("Continue browser probe?", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Continue browser probe?", { exact: true })).toBeVisible();
  // Answer through the real facade; the browser must observe the native question disappear.
  const attention = (await api("/api/v1/snapshot")).attention.find((a) => a.threadId === id);
  await api(`/api/v1/attention/${encodeURIComponent(attention.id)}/respond`, "POST", {
    kind: "userInput",
    answers: { 0: ["Continue"] },
  });
  await expect(page.getByText("Question answered.", { exact: true })).toBeVisible();
  await composer.fill("hold");
  await composer.press("Enter");
  await expect.poll(async () => (await api(`/api/v1/threads/${id}`)).summary.state).toBe("running");
  await composer.fill("queued browser response");
  await composer.press("Enter");
  await expect.poll(async () => (await api(`/api/v1/threads/${id}`)).queuedMessages.length).toBe(1);
  const before = native.prompts.length;
  await stop();
  backend = start();
  await ready();
  await page.reload();
  await expect(composer).toBeVisible();
  assert.equal(native.prompts.length, before, "API restart must not repeat accepted prompts");
  await api(`/api/v1/threads/${id}/interrupt`, "POST", {});
  await expect(
    page.getByText("Fixture answer: queued browser response", { exact: true }),
  ).toBeVisible();
  assert.equal(
    native.prompts.filter((p) =>
      p.input.parts.some((part) => part.text === "queued browser response"),
    ).length,
    1,
  );
  assert.deepEqual(pageErrors, []);
  await writeFile(
    join(scratch, "report.json"),
    JSON.stringify(
      {
        scope:
          "real OpenNest facade/client with controlled native HTTP fixture; not native/release qualification",
        screenshots: images,
        keyCleared: true,
        modelSelection: true,
        pendingQuestionReload: true,
        queueApiRestart: true,
        pageErrors,
      },
      null,
      2,
    ),
  );
  console.log(`OpenNest browser smoke passed. Report: ${join(scratch, "report.json")}`);
} catch (error) {
  await writeFile(join(scratch, "backend.log"), output);
  if (browser) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    for (let i = 0; i < pages.length; i++)
      await pages[i]
        .screenshot({ path: join(images, `failure-${i}.png`), fullPage: true })
        .catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await stop();
  await native.close();
}
