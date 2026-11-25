import { expect, test } from "@playwright/test";
import type { QueueMessageRequest, ThreadDetail } from "@codexnest/protocol";
import { installVisualFixture, mainThread, snapshot, PHONE_VIEWPORT } from "./fixtures";

test("async replies preserve the composer and survive acceptance and history reloads", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(PHONE_VIEWPORT);
  const summary = {
    ...mainThread,
    state: "needsAttention" as const,
    currentTurnId: "questions-turn",
  };
  const fixtureSnapshot = {
    ...snapshot,
    threads: snapshot.threads.map((thread) => (thread.id === mainThread.id ? summary : thread)),
  };
  await installVisualFixture(page, { theme: "dark", snapshot: fixtureSnapshot });
  const detail: ThreadDetail = {
    summary,
    olderTurnsCursor: null,
    queuedMessages: [],
    draft: {
      input: "Мой основной черновик",
      images: [],
      annotations: [],
      goalMode: false,
      updatedAt: 1,
    },
    turns: [
      {
        id: "questions-turn",
        status: "inProgress",
        startedAt: 1,
        completedAt: null,
        durationMs: null,
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
            id: "live-question",
            questionKey: "stable-question",
            text: "",
            delivery: "async",
            questions: [
              {
                title: "Какие проверки выполнить перед завершением?",
                options: ["Профильные тесты", "Полный набор проверок"],
              },
            ],
            images: [],
            status: "completed",
            timestamp: 1,
            phase: "commentary",
          },
        ],
      },
    ],
  };
  const requests: QueueMessageRequest[] = [];
  await page.route("https://codexnest.visual/api/v1/threads/session-main**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*",
        },
        body: JSON.stringify(body),
      });
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*",
        },
      });
    if (path === "/api/v1/threads/session-main" && request.method() === "GET") return json(detail);
    if (path === "/api/v1/threads/session-main/draft" && request.method() === "PUT") {
      detail.draft = { ...request.postDataJSON(), updatedAt: Date.now() };
      return json(detail.draft);
    }
    if (path === "/api/v1/threads/session-main/queue" && request.method() === "POST") {
      const body = request.postDataJSON() as QueueMessageRequest;
      requests.push(body);
      detail.queuedMessages = [
        {
          id: body.clientMessageId!,
          threadId: summary.id,
          text: body.input,
          status: "queued",
          createdAt: Date.now(),
          replyToAsyncQuestion: body.replyToAsyncQuestion,
        },
      ];
      return json(detail.queuedMessages[0], 202);
    }
    return route.fallback();
  });
  await page.goto("/threads/session-main");
  const sessionStatus = page.locator('.thread-link[href="/threads/session-main"] .status').first();
  await expect(sessionStatus).toHaveClass(/status-needsAttention/u);
  await expect(sessionStatus).toHaveCSS("background-color", "rgb(229, 166, 43)");
  const activity = page.locator(".turn-activity-row");
  await expect(activity).toContainText("Codex работает");
  await expect(activity.locator(".spinner")).toHaveCount(1);
  await expect(activity.locator(".turn-activity-duration")).toHaveCount(1);
  const composer = page.getByRole("textbox", { name: "Направить текущую задачу" });
  await expect(composer).toHaveValue("Мой основной черновик");
  const card = page.getByRole("region", { name: "Вопросы Codex" });
  await expect(card).toHaveCSS("background-color", "rgb(36, 39, 34)");
  await expect(card.getByRole("button", { name: "Ответить", exact: true })).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(card.getByRole("radio", { name: "Профильные тесты" })).toBeChecked();
  await card.getByRole("radio", { name: "Свой ответ" }).check();
  await expect(card.getByRole("textbox")).toHaveCSS("border-radius", "20px");
  await expect(card.getByRole("textbox")).toHaveCSS("background-color", "rgb(36, 39, 34)");
  await expect(card.getByRole("textbox")).not.toHaveCSS("box-shadow", "none");
  await composer.focus();
  const focusedShadow = await page
    .locator(".composer-box")
    .evaluate((el) => getComputedStyle(el).boxShadow);
  await card.getByRole("textbox").click();
  await expect(card.getByRole("textbox")).toHaveCSS("outline-style", "none");
  await expect(card.getByRole("textbox")).toHaveCSS("box-shadow", focusedShadow);
  await card.getByRole("radio", { name: "Полный набор проверок" }).check();
  const option = card.locator(".check").first();
  await option.hover();
  await expect(option).toHaveCSS("background-color", "rgb(36, 39, 34)");
  await expect(option).not.toHaveCSS("box-shadow", "none");
  await card.locator("fieldset").evaluate((el: HTMLFieldSetElement) => (el.disabled = true));
  await expect(option).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(option).toHaveCSS("box-shadow", "none");
  await card.locator("fieldset").evaluate((el: HTMLFieldSetElement) => (el.disabled = false));
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath("async-questions-mobile.png") });
  await card.getByRole("button", { name: "Ответить", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]?.replyToAsyncQuestion).toEqual({
    turnId: "questions-turn",
    itemId: "live-question",
  });
  await expect(composer).toHaveValue("Мой основной черновик");
  await expect(card.getByRole("status")).toContainText("Ответ принят сервером");
  await page.reload();
  await expect(card.getByRole("status")).toContainText("Ответ принят сервером");
  await expect(composer).toHaveValue("Мой основной черновик");
  expect(requests).toHaveLength(1);

  detail.queuedMessages = [];
  detail.turns[0]!.items[0]!.id = "item-19";
  detail.turns.push({
    ...detail.turns[0]!,
    id: "follow-up",
    status: "completed",
    items: [
      {
        type: "userMessage",
        id: requests[0]!.clientMessageId!,
        text: requests[0]!.input,
        images: [],
        status: "completed",
        timestamp: 2,
        phase: null,
      },
    ],
  });
  await page.reload();
  await expect(card.getByRole("status")).toContainText("Ответ доставлен Codex");
  await expect(card.getByRole("button", { name: "Ответить", exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("Мой основной черновик");
  expect(requests).toHaveLength(1);
});
