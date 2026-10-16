import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../../..");
const temporary = await mkdtemp(join(root, "node_modules/.cache-claude-context-"));
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
let fixture, browser;

/** A saved session: one finished answer that used 84,002 of the default 200k window. */
async function seedSession() {
  const { thread } = await fixture.ui.createThread(fixture.project.id, randomUUID());
  const transcript = join(dirname(fixture.project.path), "native/projects/context");
  await mkdir(transcript, { recursive: true });
  const history = [
    { type: "user", uuid: randomUUID(), message: { content: "Долгая задача" } },
    {
      type: "assistant",
      uuid: randomUUID(),
      message: {
        id: "answer",
        model: "claude-sonnet-5-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Готово" }],
        usage: { input_tokens: 2, cache_read_input_tokens: 80_000, output_tokens: 4_000 },
      },
    },
  ].map((event) => ({
    ...event,
    timestamp: new Date().toISOString(),
    cwd: fixture.project.path,
    sessionId: thread.id,
  }));
  await writeFile(
    join(transcript, `${thread.id}.jsonl`),
    history.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  return thread.id;
}

/** Starts a session in a fresh thread and ends its first turn, so it is idle with 41% in use. */
async function liveSession(page) {
  const { thread } = await fixture.ui.createThread(fixture.project.id, randomUUID());
  await page.goto(`${fixture.baseUrl}/threads/${thread.id}`);
  const composer = page.locator(".composer textarea");
  await composer.fill("Первый запрос");
  await composer.press("Enter");
  await page.getByText("Что включить в проверку?", { exact: true }).waitFor();
  const threadId = thread.id;
  fixture.launcher.owners.get(threadId).transport.respond("smoke-question", {});
  await page.locator(".composer .context-meter").waitFor();
  await page.waitForFunction(
    () => document.querySelector(".composer .context-meter")?.textContent === "41%",
  );
  await page.waitForFunction(() => !document.querySelector(".composer .composer-task-stop"));
  return threadId;
}

try {
  fixture = await startFixture(join(root, "apps/client/dist-claude"));
  browser = await chromium.launch({ headless: true });
  const errors = [];
  async function open(options, threadId) {
    const context = await browser.newContext(options);
    await context.addInitScript(
      ({ baseUrl, token }) => {
        localStorage.setItem("claudenest.serverUrl", baseUrl);
        localStorage.setItem("claudenest.token", token);
        localStorage.setItem("claudenest.uiLanguage", "ru");
        localStorage.setItem("claudenest.notificationPromptDismissed", "true");
      },
      { baseUrl: fixture.baseUrl, token: fixture.token },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => errors.push(error.message));
    if (threadId) await page.goto(`${fixture.baseUrl}/threads/${threadId}`);
    return page;
  }

  // An empty session reports nothing yet, so there is no meter.
  const empty = await fixture.ui.createThread(fixture.project.id, randomUUID());
  const emptyPage = await open({ viewport: { width: 1280, height: 900 } }, empty.thread.id);
  await emptyPage.locator(".composer textarea").waitFor();
  assert.equal(await emptyPage.locator(".context-meter").count(), 0);
  assert.equal(await emptyPage.locator(".composer-hint").count(), 0);
  await emptyPage.close();

  // A saved session shows its fill at once; leaving the button cancels the first click.
  const savedId = await seedSession();
  const saved = await open({ viewport: { width: 1280, height: 900 } }, savedId);
  const savedMeter = saved.locator(".composer .context-meter");
  await savedMeter.waitFor();
  assert.equal(await savedMeter.innerText(), "42%");
  assert.equal(await savedMeter.getAttribute("aria-label"), "Контекст заполнен на 42%");
  await savedMeter.click();
  assert.equal(await savedMeter.getAttribute("aria-label"), "Сжать контекст");
  await saved.mouse.move(5, 5);
  assert.equal(await savedMeter.getAttribute("aria-label"), "Контекст заполнен на 42%");
  await saved.close();

  // Mouse: two clicks without leaving the button compact the live session.
  const desktop = await open({ viewport: { width: 1280, height: 900 } }, "");
  const desktopId = await liveSession(desktop);
  const meter = desktop.locator(".composer .context-meter");
  await meter.click();
  await meter.click();
  await desktop.waitForFunction(
    () => document.querySelector(".composer .context-meter")?.textContent === "—",
  );
  assert.equal(fixture.launcher.owners.get(desktopId).transport.sends, 2);
  await desktop.close();

  // Touch: a second tap after the time window starts over; one inside it compacts.
  const phone = await open(
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    "",
  );
  const phoneId = await liveSession(phone);
  const phoneMeter = phone.locator(".composer .context-meter");
  const box = await phoneMeter.boundingBox();
  const fits = await phone.evaluate(() => {
    const toolbar = document.querySelector(".composer-toolbar");
    return toolbar.scrollWidth <= toolbar.clientWidth;
  });
  assert.ok(fits, "The meter fits the phone toolbar without scrolling");
  await phone.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await phoneMeter.getAttribute("aria-label"), "Сжать контекст");
  await phone.waitForTimeout(3_300);
  assert.equal(await phoneMeter.getAttribute("aria-label"), "Контекст заполнен на 41%");
  await phone.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await phone.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await phone.waitForFunction(
    () => document.querySelector(".composer .context-meter")?.textContent === "—",
  );
  assert.equal(fixture.launcher.owners.get(phoneId).transport.sends, 2);
  await phone.close();

  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Claude context meter browser check passed (mouse, touch, compaction).");
} finally {
  await browser?.close();
  await fixture?.close();
  await rm(temporary, { recursive: true, force: true });
}
