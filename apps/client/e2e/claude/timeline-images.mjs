import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../../..");
const temporary = await mkdtemp(join(root, "node_modules/.cache-claude-timeline-"));
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
try {
  fixture = await startFixture(join(root, "apps/client/dist-claude"));
  const { thread } = await fixture.ui.createThread(fixture.project.id, randomUUID());
  const fixtureRoot = dirname(fixture.project.path);
  const imagePath = join(fixtureRoot, "screenshot.png");
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=";
  await writeFile(imagePath, Buffer.from(data, "base64"));
  const transcript = join(fixtureRoot, "native/projects/timeline");
  await mkdir(transcript, { recursive: true });
  const history = [
    {
      type: "user",
      uuid: "initial",
      timestamp: "2026-10-05T22:43:00Z",
      message: { content: "Initial task" },
    },
    {
      type: "assistant",
      apiBlockIndex: 0,
      timestamp: "2026-10-05T22:44:00Z",
      message: {
        id: "first-response",
        content: [{ type: "thinking", thinking: "Inspecting" }],
      },
    },
    {
      type: "assistant",
      apiBlockIndex: 1,
      timestamp: "2026-10-05T22:44:01Z",
      message: {
        id: "first-response",
        stop_reason: "tool_use",
        content: [{ type: "text", text: "Working on the task" }],
      },
    },
    {
      type: "attachment",
      attachment: {
        type: "queued_command",
        source_uuid: "steer",
        prompt: "Show the variants",
        timestamp: "2026-10-05T22:45:36Z",
      },
    },
    {
      type: "assistant",
      timestamp: "2026-10-05T22:47:11Z",
      message: {
        id: "comment",
        stop_reason: "tool_use",
        content: [{ type: "text", text: "Checking the screenshots" }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-10-05T22:47:12Z",
      message: {
        id: "read",
        content: [
          { type: "tool_use", id: "read-image", name: "Read", input: { file_path: imagePath } },
        ],
      },
    },
    {
      type: "user",
      timestamp: "2026-10-05T22:47:12Z",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-image",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "companion",
      isMeta: true,
      turnCompanion: true,
      message: { content: "[Image: original 2880x1800]" },
    },
    {
      type: "assistant",
      timestamp: "2026-10-05T22:47:28Z",
      message: {
        id: "final",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `Here is the screenshot: [Screenshot](${imagePath})` }],
      },
    },
  ].map((event) => ({ ...event, cwd: fixture.project.path, sessionId: thread.id }));
  await writeFile(
    join(transcript, `${thread.id}.jsonl`),
    history.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    timezoneId: "Europe/Minsk",
  });
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const messages = page.locator(".timeline .message.userMessage, .timeline .message.agentMessage");
  const expected = [
    "Initial task",
    "Inspecting",
    "Working on the task",
    "Show the variants",
    "Checking the screenshots",
    "Here is the screenshot:",
  ];
  async function verify() {
    await page.getByText("Show the variants", { exact: true }).waitFor();
    await page.locator(".message-image-gallery .gallery-thumbnail.is-ready").waitFor();
    assert.equal(await messages.count(), expected.length);
    const texts = await messages.locator(".message-body").allTextContents();
    for (const [index, text] of texts.entries())
      assert.ok(text.includes(expected[index]), `Message ${index} stays in chronological order`);
    const times = await messages.locator("time").allTextContents();
    assert.equal(times.length, expected.length);
    assert.ok(times[3].endsWith("01:45"));
    assert.ok(times[4].endsWith("01:47"));
    assert.ok(times[5].endsWith("01:47"));
    assert.equal(await page.getByText("[Image: original 2880x1800]", { exact: true }).count(), 0);
    assert.equal(
      await page.locator(".message-image-gallery img").evaluate((image) => image.naturalWidth),
      1,
    );
  }
  await page.goto(`${fixture.baseUrl}/threads/${thread.id}`);
  await verify();
  await page.reload();
  await verify();
  await page.locator(".message-image-gallery .gallery-thumbnail.is-ready").click();
  await page.getByRole("dialog").waitFor();
  assert.ok(
    fixture.requests.some(
      (request) =>
        request.method === "POST" && request.url.endsWith("/downloads") && request.status === 200,
    ),
  );
  assert.equal(errors.length, 0);
  console.log("Claude timeline and image browser regression passed (including reload and viewer).");
} finally {
  await browser?.close();
  await fixture?.close();
  await rm(temporary, { recursive: true, force: true });
}
