import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../../..");
const scratch = await mkdtemp(join(tmpdir(), "gemininest-browser-"));
const screenshots = join(root, "output/gemini-smoke");
await mkdir(screenshots, { recursive: true });
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const token = randomBytes(32).toString("hex");
await writeFile(join(scratch, "token"), token, { mode: 0o600 });
await writeFile(
  join(scratch, "connection.json"),
  JSON.stringify({ proxy: "http://fixture:password@127.0.0.1:9", authenticated: false }),
  { mode: 0o600 },
);
const child = spawn(process.execPath, [join(root, "apps/gemini-server/dist/daemon.js"), "--tcp"], {
  env: {
    ...process.env,
    GEMININEST_CONFIG_DIR: scratch,
    GEMININEST_STATE_DIR: join(scratch, "state"),
    GEMININEST_RUNTIME_DIR: join(scratch, "run"),
    GEMININEST_PORT: String(port),
    GEMININEST_AGY_BIN: join(root, "apps/gemini-server/scripts/fixture-agent.mjs"),
    GEMININEST_RELEASE_PATH: root,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const url = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(`${url}/api/v1/health`, { headers }).then(
        (r) => r.ok,
        () => false,
      )
    ) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, output);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "ru-RU" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
  await page.addInitScript(() => {
    localStorage.setItem("gemininest.uiLanguage", "ru");
    localStorage.setItem("gemininest.notificationPromptDismissed", "true");
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel("Bearer token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Подключиться", exact: true }).click();
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("tab", { name: "Gemini", exact: true }).click();
  await page.getByRole("button", { name: "Войти через Google", exact: true }).click();
  const loginUrl = page.getByLabel("Ссылка для входа", { exact: true });
  await loginUrl.waitFor();
  const googleUrl = await loginUrl.inputValue();
  assert.ok(googleUrl.startsWith("https://accounts.google.com/"));
  assert.equal(await loginUrl.getAttribute("readonly"), "");
  assert.equal(
    await page.getByRole("link", { name: "Открыть вход Google", exact: true }).getAttribute("href"),
    googleUrl,
  );
  await page.getByRole("button", { name: "Скопировать ссылку", exact: true }).click();
  await page.getByRole("button", { name: "Ссылка скопирована", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), googleUrl);
  await page.screenshot({ path: join(screenshots, "desktop-login.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await loginUrl.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Ссылка скопирована", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), googleUrl);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(screenshots, "phone-login.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("Код или URL после входа", { exact: true }).fill("fixture-code");
  await page.getByRole("button", { name: "Завершить вход", exact: true }).click();
  await page.getByText("Вход выполнен", { exact: true }).waitFor();
  assert.equal(await page.locator('input[value*="password"]').count(), 0);
  await page.screenshot({ path: join(screenshots, "desktop-settings.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(screenshots, "phone-settings.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const project = await fetch(`${url}/api/v1/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path: scratch, displayName: "Gemini smoke" }),
  }).then((r) => r.json());
  const creation = await fetch(`${url}/api/v1/projects/${project.id}/threads`, {
    method: "POST",
    headers,
    body: JSON.stringify({ clientCreationId: "fixture" }),
  }).then((r) => r.json());
  await page.goto(`${url}/threads/${creation.thread.id}`);
  await page.locator(".composer textarea").fill("approval please");
  await page.locator(".composer textarea").press("Enter");
  await page.getByText("Fixture file write", { exact: true }).first().waitFor();
  await page.screenshot({ path: join(screenshots, "desktop-approval.png") });
  // Refresh the browser while the native request remains pending.
  await page.reload();
  await page.getByText("Fixture file write", { exact: true }).first().waitFor();
  const decisions = await fetch(`${url}/api/v1/threads/${creation.thread.id}`, { headers }).then(
    (r) => r.json(),
  );
  assert.equal(decisions.summary.state, "needsAttention");
  await page.getByRole("button", { name: "Разрешить один раз", exact: true }).click();
  await page.getByText("Gemini fixture completed.", { exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, "desktop-chat.png") });
  assert.deepEqual(errors, []);
  console.log(
    "Gemini browser smoke passed: Google sign-in link and clipboard, login, proxy redaction, responsive settings, chat, approval and reconnect.",
  );
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else {
      child.once("exit", resolve);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000).unref();
    }
  });
  await rm(scratch, { recursive: true, force: true });
}
