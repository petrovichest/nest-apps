import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import type {
  ServerEvent,
  ThreadArtifactsResponse,
  ThreadDetail,
  ThreadSummary,
  TurnView,
} from "@codexnest/protocol";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  installVisualFixture,
  mainThread,
  snapshot,
  waitForVisualReady,
} from "./fixtures";

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function geometry(locator: Locator) {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

function unchanged(before: Awaited<ReturnType<typeof geometry>>, after: typeof before) {
  expect(after).toHaveLength(before.length);
  before.forEach((box, index) => {
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(box[key] - after[index]![key]),
        `element ${index}: ${key}`,
      ).toBeLessThanOrEqual(1);
    }
  });
}

for (const viewport of [
  { width: 320, height: 568 },
  PHONE_VIEWPORT,
  { width: 740, height: 360 },
  { width: 1024, height: 768 },
  DESKTOP_VIEWPORT,
]) {
  test(`session inspector at ${viewport.width}px keeps controls stationary across artifact states`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await installVisualFixture(page, { theme: viewport.width === 320 ? "light" : "dark" });
    const inspector = page.getByRole("complementary", { name: "Сведения о задаче" });
    const chrome = inspector.locator(
      ":scope,.inspector-heading,.inspector-heading button,.inspector-tabs,[role=tab]",
    );
    const overview = inspector.getByRole("tab", { name: "Обзор", exact: true });
    const artifacts = inspector.getByRole("tab", { name: /^Артефакты/u });
    const endpoint = "**/api/v1/threads/session-main/artifacts";

    for (const state of ["empty", "unavailable", "error", "populated"] as const) {
      await test.step(state, async () => {
        const loading = deferred();
        let fail = state === "error";
        const response: ThreadArtifactsResponse = {
          capability: state === "unavailable" ? "unavailable" : "explicit",
          artifacts:
            state === "populated"
              ? Array.from({ length: 30 }, (_, index) => ({
                  id: `artifact-${index}`,
                  label: `Отчёт ${index}`,
                  path: `/work/codex-nest/reports/report-${index}.md`,
                  relativePath: `reports/report-${index}.md`,
                  fileName: `report-${index}.md`,
                  turnId: "turn-main",
                  createdAt: mainThread.updatedAt,
                }))
              : [],
        };
        const handler = async (route: Route) => {
          if (route.request().method() === "OPTIONS") return route.fallback();
          await loading.promise;
          return fail ? json(route, { error: "Fixture failure" }, 500) : json(route, response);
        };
        await page.route(endpoint, handler);
        try {
          await page.goto("/threads/session-main");
          await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
          await expect(inspector.getByText("3 файла", { exact: true })).toBeVisible();
          await waitForVisualReady(page);
          const before = await geometry(chrome);
          expect(before).toHaveLength(6);
          const checkGeometry = async () => {
            await waitForVisualReady(page);
            unchanged(before, await geometry(chrome));
          };

          await artifacts.click();
          await expect(inspector.getByRole("status")).toBeVisible();
          await checkGeometry();
          loading.resolve();

          if (state === "error") {
            await expect(inspector.getByRole("alert")).toBeVisible();
            await checkGeometry();
            fail = false;
            await inspector.getByRole("button", { name: "Повторить", exact: true }).click();
          }
          if (state === "populated") {
            await expect(inspector.locator(".inspector-artifact-item")).toHaveCount(30);
          } else {
            await expect(
              inspector.getByText(
                state === "unavailable"
                  ? "Артефакты недоступны для этой сессии"
                  : "В этой сессии пока нет артефактов",
                { exact: true },
              ),
            ).toBeVisible();
          }
          await checkGeometry();

          if (state === "populated") {
            const panel = inspector.getByRole("tabpanel");
            await panel.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
            await expect(
              inspector.getByRole("button", { name: "Открыть report-29.md" }),
            ).toBeInViewport();
            await expect(
              inspector.getByRole("button", { name: "Закрыть сведения" }),
            ).toBeInViewport();
            await expect(overview).toBeInViewport();
            await expect(artifacts).toBeInViewport();
            await checkGeometry();
          }

          await overview.click();
          await expect(inspector.getByText("Рабочая папка", { exact: true })).toBeAttached();
          await checkGeometry();
        } finally {
          loading.resolve();
          await page.unroute(endpoint, handler);
        }
      });
    }
  });
}

test("new session inspector keeps its compact mobile height", async ({ page }) => {
  await page.setViewportSize(PHONE_VIEWPORT);
  await installVisualFixture(page, { theme: "dark" });
  await page.goto("/threads/session-main");
  await page.getByRole("button", { name: "Открыть список задач", exact: true }).click();
  await page.getByRole("button", { name: "Создать новую сессию в проекте CodexNest" }).click();
  await expect(page).toHaveURL(/\/new\?/u);
  await page.getByRole("button", { name: "Показать сведения", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Сведения о новой задаче" });
  await expect(
    inspector.getByText("Задача будет создана после отправки первого сообщения."),
  ).toBeVisible();
  await waitForVisualReady(page);
  expect((await inspector.boundingBox())!.height).toBeLessThan(
    Math.min(PHONE_VIEWPORT.height * 0.82, 680),
  );
  expect(
    await inspector.locator(".inspector-panel").evaluate((el) => el.scrollHeight - el.clientHeight),
  ).toBeLessThanOrEqual(1);
});

async function expectPackedActions(page: Page) {
  const actions = page.locator(".composer-actions");
  const bounds = (await actions.boundingBox())!;
  const buttons = await geometry(actions.locator(":scope > button"));
  expect(buttons[0]!.x).toBeCloseTo(bounds.x, 1);
  const last = buttons.at(-1)!;
  expect(last.x + last.width).toBeCloseTo(bounds.x + bounds.width, 1);
  for (let index = 1; index < buttons.length; index++) {
    const previous = buttons[index - 1]!;
    const current = buttons[index]!;
    const gap = current.x - previous.x - previous.width;
    expect(gap).toBeGreaterThanOrEqual(2);
    expect(gap).toBeLessThanOrEqual(4);
    expect(current.y + current.height / 2).toBeCloseTo(previous.y + previous.height / 2, 1);
  }
}

async function verticalGap(before: Locator, after: Locator) {
  const next = await after.elementHandle();
  try {
    // Image loading can scroll the viewport between two separate boundingBox calls.
    // Measure both elements in the same browser task to keep their coordinates aligned.
    return await before.evaluate((element, following) => {
      if (!following) throw new Error("Missing following element");
      const first = element.getBoundingClientRect();
      const second = following.getBoundingClientRect();
      return second.y - first.y - first.height;
    }, next);
  } finally {
    await next?.dispose();
  }
}

async function mockRecorder(page: Page) {
  await page.addInitScript(() => {
    class Recorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      state = "inactive";
      mimeType = "audio/webm";
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      },
    });
  });
}

const messageText =
  "Одинаковое **сообщение** со ссылкой [пример](https://example.test).\n\n" +
  "Длинный текст должен целиком сохранять переносы и размеры до и после отправки. ".repeat(8);

function turn(id: string, text: string, messageId = id): TurnView {
  return {
    id,
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
        id: messageId,
        type: "userMessage",
        text,
        images: [],
        status: "completed",
        timestamp: 1,
        phase: null,
      },
    ],
  };
}

async function chat(
  page: Page,
  theme: "light" | "dark",
  text = messageText,
  options: {
    modelName?: string;
    voice?: boolean;
    reducedMotion?: "reduce" | "no-preference";
  } = {},
) {
  const summary: ThreadSummary = { ...mainThread, state: "completed", currentTurnId: null };
  const seed = structuredClone(snapshot);
  seed.attention = [];
  seed.threads = [summary];
  if (options.modelName) seed.models[0]!.displayName = options.modelName;
  const detail: ThreadDetail = {
    summary,
    turns: [turn("original", text)],
    olderTurnsCursor: null,
    draft: null,
    queuedMessages: [{ id: "queued", threadId: summary.id, text, status: "queued", createdAt: 1 }],
  };
  await installVisualFixture(page, { theme, snapshot: seed, reducedMotion: options.reducedMotion });
  if (options.voice === false)
    await page.route("**/api/v1/transcriptions/config", (route) =>
      json(route, { error: "Voice unavailable in this fixture" }, 503),
    );
  await page.route("**/api/v1/threads/session-main", (route) => json(route, detail));
  let sequence = seed.sequence;
  let send!: (event: ServerEvent) => void;
  await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (socket) => {
    send = (event) => socket.send(JSON.stringify({ type: "event", sequence: ++sequence, event }));
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "authenticate")
        socket.send(JSON.stringify({ type: "snapshot", snapshot: seed }));
      if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    });
  });
  await page.goto("/threads/session-main");
  await expect(page.locator(".queued-message-text")).toBeVisible();
  await waitForVisualReady(page);
  return { summary, detail, send: (event: ServerEvent) => send(event) };
}

for (const width of [390, 1440]) {
  test(`chat follows streamed messages only at the bottom at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { summary, send } = await chat(page, "light", messageText.repeat(4), {
      reducedMotion: "no-preference",
    });
    const scroll = page.locator(".conversation-scroll");
    const jump = page.getByRole("button", { name: "Прокрутить к последнему сообщению" });
    const distance = () =>
      scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(distance).toBeLessThanOrEqual(1);
    send({ type: "queue.changed", threadId: summary.id, messages: [] });
    send({
      type: "thread.upserted",
      thread: { ...summary, state: "running", currentTurnId: "streaming" },
    });
    send({
      type: "turn.replaced",
      threadId: summary.id,
      turn: {
        ...turn("streaming", ""),
        status: "inProgress",
        completedAt: null,
        items: [
          {
            id: "streamed-answer",
            type: "agentMessage",
            text: "Начало ответа",
            images: [],
            status: "inProgress",
            timestamp: 3,
            phase: "commentary",
          },
        ],
      },
    });
    const answer = page.locator(".message.agentMessage").filter({ hasText: "Начало ответа" });
    await expect(answer).toBeVisible();
    let chunk = 0;
    const append = async () => {
      const marker = `Часть ${++chunk}:`;
      send({
        type: "activity.delta",
        threadId: summary.id,
        turnId: "streaming",
        itemId: "streamed-answer",
        activityType: "agentMessage",
        delta: `\n\n${marker} ${"Продолжение потокового ответа. ".repeat(30)}`,
      });
      await expect(answer).toContainText(marker);
      await waitForVisualReady(page);
    };
    await append();
    await expect.poll(distance).toBeLessThanOrEqual(1);

    // Scrollbar and keyboard scrolling have no preceding wheel/touch event.
    await scroll.evaluate((el) => {
      el.scrollTop -= 16;
    });
    await expect(jump).toBeVisible();
    const readingTop = await scroll.evaluate((el) => el.scrollTop);
    await append();
    expect(await scroll.evaluate((el) => el.scrollTop)).toBeCloseTo(readingTop, 0);

    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight - 8;
    });
    await expect.poll(distance).toBeCloseTo(8, 0);
    await expect(jump).toBeVisible();
    const nearBottom = await scroll.evaluate((el) => el.scrollTop);
    await append();
    expect(await scroll.evaluate((el) => el.scrollTop)).toBeCloseTo(nearBottom, 0);

    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(jump).toBeHidden();
    await append();
    await expect.poll(distance).toBeLessThanOrEqual(1);

    await scroll.hover({ position: { x: 30, y: 100 } });
    await page.mouse.wheel(0, -120);
    await expect(jump).toBeVisible();
    await expect.poll(distance).toBeGreaterThan(10);
    await jump.click();
    await expect.poll(distance).toBeLessThanOrEqual(1);
    await expect(jump).toBeHidden();
    await append();
    await expect.poll(distance).toBeLessThanOrEqual(1);
  });
}

for (const width of [320, 390, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`floating composer at ${width}px in ${theme}: overlay, resizing and scroll position`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width < 610 ? 844 : 1000 });
      const { send } = await chat(page, theme, messageText.repeat(4));
      const scroll = page.locator(".conversation-scroll");
      const composer = page.locator(".composer");
      const bubble = page.locator(".composer-box");
      const input = bubble.locator("textarea");
      const queue = page.locator(".outgoing-messages");
      const distanceFromTail = () =>
        scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
      const expectMeasured = () =>
        expect
          .poll(() =>
            composer.evaluate((el) =>
              Math.max(
                Math.abs(
                  parseFloat(getComputedStyle(el).getPropertyValue("--composer-overlay-height")) -
                    Math.ceil(
                      el.getBoundingClientRect().bottom -
                        el.querySelector(".composer-base")!.getBoundingClientRect().top,
                    ),
                ),
                Math.abs(
                  parseFloat(getComputedStyle(el).getPropertyValue("--composer-full-height")) -
                    Math.ceil(el.getBoundingClientRect().height),
                ),
              ),
            ),
          )
          .toBeLessThan(1);
      const expectTailVisible = async () => {
        await expectMeasured();
        await expect.poll(distanceFromTail).toBeLessThanOrEqual(1);
        expect(await verticalGap(queue, bubble)).toBeGreaterThanOrEqual(15);
      };
      await expectTailVisible();
      const original = (await bubble.boundingBox())!;
      const viewport = (await scroll.boundingBox())!;
      const mobile = width <= 820;
      if (mobile) {
        const bottomGap = await composer.evaluate((el) =>
          parseFloat(getComputedStyle(el).paddingBottom),
        );
        expect(viewport.y + viewport.height).toBe(original.y + original.height + bottomGap);
      } else {
        expect(viewport.y + viewport.height).toBeGreaterThan(original.y + original.height);
      }
      // The compact layout's side gutter exposes the scroll viewport beside the composer.
      const scrollPoint = mobile
        ? { x: original.x / 2, y: original.y + original.height / 2 }
        : { x: original.x + original.width / 2, y: original.y + original.height + 6 };
      expect(
        await page.evaluate(
          ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".conversation-scroll")),
          scrollPoint,
        ),
      ).toBe(true);

      await page.mouse.move(scrollPoint.x, scrollPoint.y);
      await page.mouse.wheel(0, -400);
      await expect(
        page.getByRole("button", { name: "Прокрутить к последнему сообщению" }),
      ).toBeVisible();
      await expect.poll(distanceFromTail).toBeGreaterThan(300);
      // Read the existing turn, above the queue where newly arrived turns are inserted.
      await scroll.evaluate((el) => {
        el.scrollTop = 100;
      });
      await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(100);
      const readingTop = await scroll.evaluate((el) => el.scrollTop);
      unchanged([original], await geometry(bubble));

      await input.fill("Длинный ввод\n".repeat(12));
      await expectMeasured();
      expect((await bubble.boundingBox())!.height).toBeGreaterThan(original.height);
      expect(await scroll.evaluate((el) => el.scrollTop)).toBeCloseTo(readingTop, 0);
      const readingMessage = scroll.locator(".turn").first();
      const readingGeometry = await geometry(readingMessage);
      send({
        type: "turn.replaced",
        threadId: mainThread.id,
        turn: turn("arrived", "Новое сообщение во время чтения истории"),
      });
      await expect(
        page.getByText("Новое сообщение во время чтения истории", { exact: true }),
      ).toHaveCount(1);
      unchanged(readingGeometry, await geometry(readingMessage));
      await expect.poll(distanceFromTail).toBeGreaterThan(300);

      await page.getByRole("button", { name: "Прокрутить к последнему сообщению" }).click();
      await expectTailVisible();
      await input.fill("");
      await expectTailVisible();
      await composer.locator('input[type="file"]').setInputFiles({
        name: "preview.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
          "base64",
        ),
      });
      await expect(page.locator(".composer-attachments")).toBeVisible();
      await expectTailVisible();
      await page
        .getByRole("button", { name: "Удалить изображение preview.png", exact: true })
        .click();
      await expect(page.locator(".composer-attachments")).toHaveCount(0);
      await expectTailVisible();

      await input.focus();
      await page.setViewportSize({ width, height: 520 });
      await expectTailVisible();
      await expectPackedActions(page);
    });
  }
}

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`running agents at ${width}px in ${theme}: chat tail stays reachable through floating card changes`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width < 610 ? 844 : 1000 });
      const { summary, send } = await chat(page, theme, messageText.repeat(4));
      send({ type: "queue.changed", threadId: summary.id, messages: [] });
      send({
        type: "thread.upserted",
        thread: { ...summary, state: "running", currentTurnId: "running" },
      });
      for (const index of [1, 2]) {
        const id = `running-child-${index}`;
        send({
          type: "thread.upserted",
          thread: {
            ...summary,
            id,
            title: `Проверка ${index}`,
            state: "running",
            currentTurnId: `${id}-turn`,
            pinned: false,
            relation: {
              kind: "subagent",
              sessionId: id,
              parentThreadId: summary.id,
              nickname: `Агент ${index}`,
              role: "worker",
            },
          },
        });
      }
      const scroll = page.locator(".conversation-scroll");
      const tail = page.locator(".active-turn-placeholder .turn-activity-row");
      const bar = page.locator(".subagent-activity");
      const toggle = bar.getByRole("button", { name: "Показать субагентов", exact: true });
      const box = page.locator(".composer-box");
      await expect(bar.getByRole("status")).toHaveText("2 агента работают");
      await expect(tail).toContainText("Codex работает");

      const expectTailReachable = async () => {
        await waitForVisualReady(page);
        await scroll.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect
          .poll(() =>
            scroll.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await expect(tail).toBeInViewport({ ratio: 1 });
        await expect(toggle).toBeInViewport({ ratio: 1 });
        expect(await verticalGap(tail, bar)).toBeGreaterThanOrEqual(16);
      };
      await expectTailReachable();
      const stationary = await geometry(
        page.locator(
          ".active-turn-placeholder .turn-activity-row,.subagent-activity,.composer-box",
        ),
      );
      const scrollHeight = await scroll.evaluate((element) => element.scrollHeight);
      const scrollTop = await scroll.evaluate((element) => element.scrollTop);

      await page.locator('.composer input[type="file"]').setInputFiles(
        [1, 2, 3].map((index) => ({
          name: `preview-${index}.png`,
          mimeType: "image/png",
          buffer: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
            "base64",
          ),
        })),
      );
      const filter = page.getByRole("button", { name: "Изображения (3)", exact: true });
      await expect(filter).toHaveAttribute("aria-expanded", "false");

      const expectCardsFloat = async () => {
        await waitForVisualReady(page);
        expect(await scroll.evaluate((element) => element.scrollHeight)).toBe(scrollHeight);
        expect(await scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(scrollTop, 0);
        unchanged(
          stationary,
          await geometry(
            page.locator(
              ".active-turn-placeholder .turn-activity-row,.subagent-activity,.composer-box",
            ),
          ),
        );
        await expectTailReachable();
      };
      await expectCardsFloat();
      await filter.click();
      await expect(page.locator('.composer-card-panel[data-kind="images"]')).toBeVisible();
      await expect(filter).toHaveAttribute("aria-expanded", "true");
      await expectCardsFloat();
      await filter.click();
      await expect(filter).toHaveAttribute("aria-expanded", "false");
      await expectCardsFloat();
      expect(await verticalGap(bar, box)).toBeGreaterThanOrEqual(8);
    });
  }
}

for (const mobile of [false, true]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${mobile ? "mobile" : "desktop"} ${theme}: queue typography and delivery geometry`, async ({
      page,
    }) => {
      await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
      const { detail, send } = await chat(page, theme);
      const original = page.locator('[data-message-id="original"] > .message-body');
      const queued = page.locator('[data-message-id="queued"] > .message-body');
      const compare = async (locator: Locator) =>
        locator.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
            font: style.fontFamily,
            size: style.fontSize,
            lineHeight: style.lineHeight,
          };
        });
      const before = await compare(queued);
      expect(before.size).toBe("15px");
      expect(before.lineHeight).toBe("22.5px");
      expect(before).toEqual(await compare(original));
      await expect(queued.locator("strong")).toHaveText("сообщение");
      expect(
        await queued
          .locator("p")
          .last()
          .evaluate((el) => el.scrollHeight <= el.clientHeight),
      ).toBe(true);
      send({
        type: "turn.replaced",
        threadId: mainThread.id,
        turn: turn("delivered", messageText, "queued"),
      });
      detail.queuedMessages = [];
      send({ type: "queue.changed", threadId: mainThread.id, messages: [] });
      await expect(page.locator(".queued-message")).toHaveCount(0);
      expect(await compare(queued)).toEqual(before);
    });

    test(`${mobile ? "mobile" : "desktop"} ${theme}: toolbar stays compact through running and voice states`, async ({
      page,
    }) => {
      await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
      await mockRecorder(page);
      const { summary, send } = await chat(page, theme, "Проверка");
      const controls = page.locator(
        ".composer-add-image,.model-toggle,.plan-toggle,.team-toggle,.goal-toggle,.composer-actions > .microphone,.composer-actions > .composer-action:last-child",
      );
      const before = await geometry(controls);
      await expectPackedActions(page);
      if (mobile) {
        for (const control of before) expect(control.y).toBeCloseTo(before[0]!.y, 0);
        expect((await page.locator(".composer-toolbar").boundingBox())!.height).toBeLessThanOrEqual(
          50,
        );
      }
      send({
        type: "thread.upserted",
        thread: { ...summary, state: "running", currentTurnId: "running" },
      });
      await expect(
        page.getByRole("button", { name: "Остановить задачу", exact: true }),
      ).toBeVisible();
      const running = await geometry(controls);
      unchanged(before.slice(0, 5), running.slice(0, 5));
      unchanged(before.slice(-1), running.slice(-1));
      await expectPackedActions(page);
      const now = await page.evaluate(() => Date.now());
      await page.getByRole("button", { name: "Начать запись", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Остановить запись", exact: true }),
      ).toBeVisible();
      let recording: Awaited<ReturnType<typeof geometry>> | undefined;
      for (const elapsed of [9, 10, 59, 60, 599, 600]) {
        await page.evaluate(
          (time) => {
            Date.now = () => time;
          },
          now + elapsed * 1000,
        );
        await expect(page.locator(".composer-action-timer")).toHaveText(String(elapsed));
        const current = await geometry(controls);
        if (recording) unchanged(recording, current);
        recording = current;
        unchanged(before.slice(-1), current.slice(-1));
        await expectPackedActions(page);
      }
      await page.getByRole("button", { name: "Отменить запись", exact: true }).click();
      send({
        type: "voiceTranscription.upserted",
        job: {
          id: "voice",
          threadId: summary.id,
          mode: "draft",
          status: "failed",
          createdAt: now,
          startedAt: now,
          audioDurationMs: 10000,
          estimatedTotalSeconds: null,
          error: "No speech was detected in the recording",
        },
      });
      await expect(page.locator(".composer-error")).toBeVisible();
      unchanged(running, await geometry(controls));
      await expectPackedActions(page);
      expect(
        await page.locator(".composer-options").evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    });
  }

  for (const voice of [false, true]) {
    for (const modelName of ["6astra", "Model with an unusually long display name"]) {
      test(`${mobile ? "mobile" : "desktop"}: compact ${modelName} controls with voice ${voice ? "enabled" : "unavailable"}`, async ({
        page,
      }) => {
        await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
        const { summary, send } = await chat(page, "light", "Проверка", { modelName, voice });
        await expect(page.locator(".composer-actions > button")).toHaveCount(voice ? 2 : 1);
        await expectPackedActions(page);
        const model = page.locator(".model-toggle");
        const modelBounds = (await model.boundingBox())!;
        expect(modelBounds.width).toBeLessThanOrEqual(mobile ? 60 : 150);
        if (modelName === "6astra") {
          expect(modelBounds.width).toBeLessThan(mobile ? 60 : 100);
          expect(
            await model.locator("span").evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
        }
        if (voice) {
          const microphone = (await page.locator(".composer-actions > .microphone").boundingBox())!;
          expect(microphone.width).toBe(mobile ? 32 : 34);
        }
        send({
          type: "thread.upserted",
          thread: { ...summary, state: "running", currentTurnId: "running" },
        });
        await expect(
          page.getByRole("button", { name: "Остановить задачу", exact: true }),
        ).toBeVisible();
        await expectPackedActions(page);
        send({ type: "thread.upserted", thread: summary });
        await expect(
          page.getByRole("button", { name: "Остановить задачу", exact: true }),
        ).toHaveCount(0);
        await expectPackedActions(page);
      });
    }
  }

  test(`${mobile ? "mobile" : "desktop"}: queue spacing after messages, questions and finish action`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    const { summary, detail, send } = await chat(page, "dark", "Короткое сообщение");
    const queue = page.locator(".outgoing-messages");
    const previousTurn = page.locator(".turn").last();
    const finish = page.locator(".finish-thread-action");
    expect(await verticalGap(previousTurn, queue)).toBe(24);
    send({ type: "thread.upserted", thread: { ...summary, unread: true } });
    await expect(finish).toBeVisible();
    expect(await verticalGap(finish, queue)).toBe(16);
    await page.route("https://images.example/queue.svg", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="gray"/></svg>',
      }),
    );
    const messages = [
      detail.queuedMessages[0]!,
      { ...detail.queuedMessages[0]!, id: "queued-long", text: messageText },
      {
        ...detail.queuedMessages[0]!,
        id: "queued-image",
        text: "![Пример](https://images.example/queue.svg)",
      },
    ];
    send({ type: "queue.changed", threadId: summary.id, messages });
    const cards = queue.locator(".queued-message");
    await expect(cards).toHaveCount(3);
    await expect(cards.last().locator("img")).toBeVisible();
    const checkSpacing = async () => {
      for (let index = 0; index < 3; index++) {
        const card = cards.nth(index);
        expect(
          await verticalGap(card.locator(".message-body"), card.locator(".message-footer")),
        ).toBe(7);
        if (index > 0) expect(await verticalGap(cards.nth(index - 1), card)).toBe(16);
      }
    };
    await checkSpacing();
    await cards
      .first()
      .getByRole("button", { name: "Изменить сообщение в очереди", exact: true })
      .click();
    await expect(cards.first().getByRole("textbox")).toBeVisible();
    await checkSpacing();
    await cards.first().getByRole("button", { name: "Отмена", exact: true }).click();
    send({ type: "thread.upserted", thread: summary });
    await expect(finish).toHaveCount(0);
    expect(await verticalGap(previousTurn, queue)).toBe(24);
    const attention = { ...snapshot.attention[0]!, threadId: summary.id };
    send({ type: "attention.upserted", attention });
    const questions = page.locator(".attention-stack");
    await expect(questions).toBeVisible();
    expect(await verticalGap(questions, queue)).toBe(16);
    send({ type: "attention.removed", attentionId: attention.id });
    await expect(questions).toHaveCount(0);
    send({ type: "thread.upserted", thread: { ...summary, unread: true } });
    await expect(finish).toBeVisible();
    send({ type: "queue.changed", threadId: summary.id, messages: [] });
    await expect(queue).toHaveCount(0);
    await expect(finish).toHaveCSS("margin-bottom", "0px");
    await expect(finish).toHaveCSS("margin-top", "24px");
  });

  test(`${mobile ? "mobile" : "desktop"}: settings and fork loading keep their controls anchored`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    await installVisualFixture(page, { theme: "light" });
    const loading = deferred();
    await page.route("**/api/v1/settings/codex", async (route) => {
      await loading.promise;
      return route.fallback();
    });
    await page.goto("/settings?section=maintenance");
    const card = page.locator(".codex-settings-card").first();
    await expect(card.locator(".settings-group-body")).toHaveAttribute("aria-busy", "true");
    await waitForVisualReady(page);
    const actions = card.locator(".settings-actions button");
    const initial = await geometry(actions);
    loading.resolve();
    await expect(card.locator(".settings-group-body")).not.toHaveAttribute("aria-busy");
    unchanged(initial, await geometry(actions));
    const checking = deferred();
    await page.route("**/api/v1/settings/app/check", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      await checking.promise;
      return json(route, { error: "Fixture failure" }, 500);
    });
    const app = page.locator(".application-settings-card");
    const appActions = app.locator(".settings-actions > button, .settings-actions > a");
    await appActions.last().scrollIntoViewIfNeeded();
    const before = await geometry(appActions);
    const feedback = app.locator(".settings-feedback-slot");
    const feedbackHeight = (await feedback.boundingBox())!.height;
    await app.getByRole("button", { name: "Проверить обновления", exact: true }).click();
    await expect(app.getByRole("button", { name: "Проверяем…", exact: true })).toBeVisible();
    unchanged(before, await geometry(appActions));
    checking.resolve();
    await expect(app.getByRole("alert")).toBeVisible();
    // Adding an error below the active-turn warning can expand the feedback
    // region. Controls move together by that height, with no size/layout change.
    const feedbackGrowth = (await feedback.boundingBox())!.height - feedbackHeight;
    expect(feedbackGrowth).toBeGreaterThanOrEqual(0);
    unchanged(
      before.map((box) => ({ ...box, y: box.y + feedbackGrowth })),
      await geometry(appActions),
    );
    expect(
      await feedback.evaluate((element) => element.scrollHeight - element.clientHeight),
    ).toBeLessThanOrEqual(1);
    const restarting = deferred();
    await page.route("**/api/v1/settings/codex/force-restart", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      await restarting.promise;
      return json(route, {});
    });
    const recovery = page.locator(".recovery-settings-card");
    const recoveryActions = recovery.locator(".settings-actions button");
    await recoveryActions.last().scrollIntoViewIfNeeded();
    const recoveryBefore = await geometry(recoveryActions);
    page.once("dialog", (dialog) => dialog.accept());
    await recovery.getByRole("button", { name: "Жёстко перезапустить Codex", exact: true }).click();
    await expect(
      recovery.getByRole("button", { name: "Перезапускаем Codex…", exact: true }),
    ).toBeVisible();
    unchanged(recoveryBefore, await geometry(recoveryActions));
    restarting.resolve();
    await expect(recovery.getByText("Codex daemon аварийно перезапущен.")).toBeVisible();
    unchanged(recoveryBefore, await geometry(recoveryActions));
    await page.goto("/threads/session-main");
    const estimate = deferred();
    await page.route("**/fork-estimate", async (route) => {
      await estimate.promise;
      return route.fallback();
    });
    await page.getByRole("button", { name: "Создать ответвление отсюда" }).click();
    const dialog = page.getByRole("dialog", { name: "Создать ветку" });
    await expect(dialog.getByText("Считаем…").first()).toBeVisible();
    const chrome = dialog.locator(".dialog-header,.fork-dialog-actions");
    const pending = await geometry(chrome);
    estimate.resolve();
    await expect(dialog.getByText("Считаем…")).toHaveCount(0);
    unchanged(pending, await geometry(chrome));
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`sidebar ${theme} typography and actual title animation use fixed geometry and speed`, async ({
    page,
  }) => {
    const seed = structuredClone(snapshot);
    seed.threads.find((thread) => thread.id === mainThread.id)!.title =
      "Очень длинное название сессии для проверки одинаковой скорости движения текста";
    seed.threads.find((thread) => thread.id === "session-active")!.title = "Коротко";
    await installVisualFixture(page, {
      theme,
      snapshot: seed,
      reducedMotion: "no-preference",
    });
    await page.goto("/threads/session-main");
    await expect(page.locator(".sidebar-control-action").first()).toBeVisible();
    await waitForVisualReady(page);
    const fonts = await page.locator(".sidebar-control-action").evaluateAll((elements) =>
      elements.map((el) => {
        const s = getComputedStyle(el);
        return [s.fontSize, s.lineHeight, s.fontFamily];
      }),
    );
    expect(new Set(fonts.map((font) => JSON.stringify(font))).size).toBe(1);
    expect(fonts[0]![0]).toBe("14px");
    for (const mode of ["Проекты", "Активные"]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.mouse.move(1000, 850);
      const row = page.locator('a[href="/threads/session-main"]').locator("..");
      const title = row.locator(".thread-link-title");
      const text = title.locator(".thread-link-title-text");
      const before = await geometry(title);
      const rowBefore = await geometry(row);
      await expect(title).toHaveCSS("mask-image", "none");
      // Enter via the menu before the title has ever received a mouseenter.
      const menu = (await row.locator("summary").boundingBox())!;
      await page.mouse.move(menu.x + menu.width / 2, menu.y + menu.height / 2);
      await expect(title).toHaveAttribute("data-overflowing", "true");
      for (const [targetIndex, target] of [row.locator("summary"), title, title].entries()) {
        const box = (await target.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await expect(text).toHaveCSS("animation-name", "thread-title-scroll");
        await expect(title).toHaveCSS("mask-image", /linear-gradient\(.*12px\)/);
        const movement = await text.evaluate(async (el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const frames: number[] = [];
          const started = performance.now();
          while (performance.now() - started < 300) {
            await new Promise(requestAnimationFrame);
            frames.push(range.getBoundingClientRect().x);
          }
          return frames;
        });
        expect(movement[0]! - movement.at(-1)!).toBeGreaterThan(5);
        for (let i = 1; i < movement.length; i++) {
          expect(movement[i]!).toBeLessThanOrEqual(movement[i - 1]! + 0.1);
        }
        const positions = await text.evaluate((el) => {
          const animation = el.getAnimations()[0]!;
          const range = document.createRange();
          range.selectNodeContents(el);
          animation.pause();
          return [0, 200, 400].map((time) => {
            animation.currentTime = time;
            return range.getBoundingClientRect().x;
          });
        });
        expect((positions[0]! - positions[1]!) / 0.2).toBeCloseTo(45, 1);
        expect((positions[1]! - positions[2]!) / 0.2).toBeCloseTo(45, 1);
        if (mode === "Активные" && targetIndex === 0) {
          await expect(row).toHaveScreenshot(`sidebar-title-fade-${theme}.png`, {
            animations: "allow",
          });
        }
        const end = await text.evaluate((el) => {
          el.getAnimations()[0]!.finish();
          return el.getBoundingClientRect().right - el.parentElement!.getBoundingClientRect().right;
        });
        expect(Math.abs(end)).toBeLessThanOrEqual(1);
        unchanged(before, await geometry(title));
        unchanged(rowBefore, await geometry(row));
        await page.mouse.move(1000, 850);
        await expect(text).toHaveCSS("transform", "none");
        await expect(text).toHaveCSS("text-overflow", "ellipsis");
        await expect(title).toHaveCSS("mask-image", "none");
      }
      await title.hover();
      await text.evaluate((el) => el.getAnimations()[0]!.finish());
      await row.locator("summary").click();
      const distanceError = () =>
        title.evaluate((el) => {
          const content = el.firstElementChild!;
          return (
            parseFloat(
              (el as HTMLElement).style.getPropertyValue("--thread-title-scroll-distance"),
            ) -
            (content.scrollWidth - el.clientWidth)
          );
        });
      await expect.poll(distanceError).toBe(0);
      unchanged(rowBefore, await geometry(row));
      await page.keyboard.press("Escape");
      await expect(row.locator("summary")).toBeFocused();
      await expect.poll(distanceError).toBe(0);
      unchanged(before, await geometry(title));
      const fittingTitle = page.locator('a[href="/threads/session-active"] .thread-link-title');
      await fittingTitle.hover();
      await expect(fittingTitle).not.toHaveAttribute("data-overflowing");
      await expect(fittingTitle).toHaveCSS("mask-image", "none");
      await expect(fittingTitle.locator(".thread-link-title-text")).toHaveCSS("transform", "none");
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator('a[href="/threads/session-main"] .thread-link-title').hover();
    const reducedText = page.locator('a[href="/threads/session-main"] .thread-link-title-text');
    await expect(reducedText).toHaveCSS("animation-name", "none");
    await expect(reducedText).toHaveCSS("transform", "none");
    await expect(reducedText).toHaveCSS("text-overflow", "ellipsis");
    await expect(reducedText.locator("..")).toHaveCSS("mask-image", "none");
  });
}

test.describe("compact mobile controls", () => {
  test.use({ hasTouch: true });

  for (const width of [320, 360, 390, 412]) {
    test(`one toolbar row at ${width}px with a reduced viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const { summary, send } = await chat(page, "dark", "Проверка");
      await page.locator(".composer-box textarea").focus();
      send({
        type: "thread.upserted",
        thread: { ...summary, state: "running", currentTurnId: "running" },
      });
      await expect(
        page.getByRole("button", { name: "Остановить задачу", exact: true }),
      ).toBeVisible();
      for (const height of [844, 520]) {
        await page.setViewportSize({ width, height });
        const toolbar = (await page.locator(".composer-toolbar").boundingBox())!;
        const buttons = await geometry(
          page.locator(".composer-add-image,.settings-picker > button,.composer-actions > button"),
        );
        expect(buttons).toHaveLength(8);
        expect(toolbar.height).toBeLessThanOrEqual(50);
        for (const button of buttons) {
          expect(button.y).toBeCloseTo(buttons[0]!.y, 0);
          expect(button.x).toBeGreaterThanOrEqual(toolbar.x);
          expect(button.x + button.width).toBeLessThanOrEqual(toolbar.x + toolbar.width);
          expect(button.width).toBeGreaterThanOrEqual(32);
        }
      }
    });
  }

  test("session titles use the space up to the menu when markers are absent", async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    const seed = structuredClone(snapshot);
    seed.threads.find((thread) => thread.id === "session-active")!.title =
      "Очень длинное название сессии на сенсорном экране";
    await installVisualFixture(page, {
      theme: "dark",
      snapshot: seed,
      reducedMotion: "no-preference",
    });
    await page.goto("/threads/session-active");
    await page.getByRole("button", { name: "Открыть список задач" }).click();
    await page.getByRole("button", { name: "Активные", exact: true }).click();
    const row = page
      .locator('.active-session-list a[href="/threads/session-active"]')
      .locator("..");
    const title = row.locator(".thread-link-title");
    const before = (await title.boundingBox())!;
    const trigger = (await row.locator("summary").boundingBox())!;
    expect(trigger.x - before.x - before.width).toBeLessThanOrEqual(5);
    await row.locator("summary").click();
    await expect(title).toHaveAttribute("data-overflowing", "true");
    await expect(title.locator(".thread-link-title-text")).toHaveCSS("animation-name", "none");
    await expect(title.locator(".thread-link-title-text")).toHaveCSS("text-overflow", "ellipsis");
    const expanded = (await title.boundingBox())!;
    const actions = (await row.locator(".thread-row-actions").boundingBox())!;
    expect(expanded.x).toBe(before.x);
    expect(expanded.width).toBeLessThan(before.width);
    expect(expanded.x + expanded.width).toBeLessThanOrEqual(actions.x);
    await page.keyboard.press("Escape");
    expect(await title.boundingBox()).toEqual(before);
  });
});

test.describe("recording paint bounds", () => {
  test.use({ hasTouch: true });

  for (const theme of ["light", "dark"] as const) {
    for (const width of [320, 360, 390, 412, 820, 821]) {
      test(`recording paint at ${width}px in ${theme}`, async ({ browserName, page }) => {
        await page.setViewportSize({ width, height: 520 });
        await mockRecorder(page);
        const { summary, send } = await chat(page, theme, "Проверка", {
          modelName: "5.6sol",
          reducedMotion: "no-preference",
        });
        const now = await page.evaluate(() => Date.now());
        await page.getByRole("button", { name: "Начать запись", exact: true }).click();
        const microphone = page.getByRole("button", { name: "Остановить запись", exact: true });
        await expect(microphone).toBeVisible();
        await page.evaluate((time) => {
          Date.now = () => time;
        }, now + 125000);
        await expect(page.locator(".composer-action-timer")).toHaveText("125");
        expect(
          await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
        ).toBe(false);
        await expect(page.locator("style[data-visual-test-motion]")).toHaveCount(0);

        for (const running of [false, true]) {
          if (running) {
            send({
              type: "thread.upserted",
              thread: { ...summary, state: "running", currentTurnId: "running" },
            });
            await expect(
              page.getByRole("button", { name: "Остановить задачу", exact: true }),
            ).toBeVisible();
          }
          const toolbar = (await page.locator(".composer-toolbar").boundingBox())!;
          const controls = page.locator(
            ".composer-add-image,.settings-picker > button,.composer-actions > button",
          );
          const before = await geometry(controls);
          expect(before).toHaveLength(running ? 8 : 7);
          for (const [index, button] of before.entries()) {
            expect(button.width).toBeGreaterThanOrEqual(32);
            expect(button.height).toBeGreaterThanOrEqual(32);
            expect(button.x).toBeGreaterThanOrEqual(toolbar.x);
            expect(button.x + button.width).toBeLessThanOrEqual(toolbar.x + toolbar.width);
            expect(button.y + button.height / 2).toBeCloseTo(
              before[0]!.y + before[0]!.height / 2,
              0,
            );
            if (index > 0)
              expect(
                button.x - before[index - 1]!.x - before[index - 1]!.width,
              ).toBeGreaterThanOrEqual(-0.1);
          }
          await expectPackedActions(page);
          // Pause the real CSS animation at multiple points, including its maximum extent.
          for (const time of [0, 350, 700, 1050, 1399]) {
            const shadow = await microphone.evaluate((element, time) => {
              const animation = element
                .getAnimations()
                .find(
                  (animation) => (animation as CSSAnimation).animationName === "microphone-pulse",
                );
              if (!animation) throw new Error("Recording animation must be enabled in this test");
              animation.pause();
              animation.currentTime = time;
              return getComputedStyle(element).boxShadow;
            }, time);
            // Ignore commas inside color functions, then check every shadow layer.
            for (const layer of shadow.replace(/\([^)]*\)/g, "").split(",")) {
              expect(layer).toContain("inset");
            }
            await expect(microphone).toHaveCSS("transform", "none");
            unchanged(before, await geometry(controls));
            // Pixel baselines are Chromium-only; geometry and motion run in both engines.
            if (time === 700 && (width === 320 || width === 390) && browserName === "chromium") {
              await expect(page.locator(".composer-box")).toHaveScreenshot(
                `recording-${theme}-${running ? "running" : "idle"}${width === 320 ? "-320" : ""}.png`,
                { animations: "allow" },
              );
            }
          }
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect(microphone).toHaveCSS("animation-name", "none");
        expect(
          await microphone.evaluate((element) => getComputedStyle(element).boxShadow),
        ).toContain("inset");
        await expectPackedActions(page);
        await page.getByRole("button", { name: "Отменить запись", exact: true }).click();
        await expect(page.locator(".composer-action-timer")).toHaveCount(0);
        await expectPackedActions(page);
      });
    }
  }
});

test("image loading and retry stay compact, then fit the image proportions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  const image = deferred();
  let failImage = true;
  await page.route("https://image.test/preview.svg", async (route) => {
    await image.promise;
    if (failImage) return route.abort();
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="240"><rect width="80" height="240" fill="#888"/></svg>',
    });
  });
  await chat(page, "light", "![Превью](https://image.test/preview.svg)\n\nТекст под изображением.");
  const frames = page.locator(".markdown-image-preview,.markdown-image-state");
  await expect(frames).toHaveCount(2);
  const paragraphs = page.getByText("Текст под изображением.", { exact: true });
  const following = await geometry(paragraphs);
  const before = await geometry(frames);
  image.resolve();
  await expect(page.locator(".markdown-image-retry")).toHaveCount(2);
  unchanged(before, await geometry(frames));
  unchanged(following, await geometry(paragraphs));
  failImage = false;
  for (let remaining = 2; remaining > 0; remaining--) {
    await page.locator(".markdown-image-retry").first().click();
    await expect(page.locator(".markdown-image-retry")).toHaveCount(remaining - 1);
  }
  await expect
    .poll(() =>
      frames
        .locator("img")
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  await expect(page.locator(".markdown-image-preview.is-loading")).toHaveCount(0);
  for (const frame of await geometry(frames)) {
    expect(frame.width).toBe(80);
    expect(frame.height).toBe(240);
  }
  for (const frame of before) expect(frame.height).toBeLessThanOrEqual(80);
});

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: English busy labels keep adjacent actions stationary`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    await installVisualFixture(page, {
      theme: "light",
      snapshot: { ...snapshot, uiLanguage: "en" },
    });
    const checking = deferred();
    await page.route("**/api/v1/settings/app/check", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      await checking.promise;
      return json(route, { error: "Fixture failure" }, 500);
    });
    await page.goto("/settings?section=maintenance");
    const card = page.locator(".application-settings-card");
    const check = card.getByRole("button", { name: "Check for updates", exact: true });
    await expect(check).toBeEnabled();
    const controls = card.locator(".settings-actions > button, .settings-actions > a");
    await controls.last().scrollIntoViewIfNeeded();
    const before = await geometry(controls);
    await check.click();
    await expect(card.getByRole("button", { name: "Checking…", exact: true })).toBeVisible();
    unchanged(before, await geometry(controls));
    checking.resolve();
    await expect(card.getByRole("alert")).toBeVisible();
    unchanged(before, await geometry(controls));
  });

  test(`${mobile ? "mobile" : "desktop"}: background updates preserve the reader's scroll position`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT);
    const { summary, send } = await chat(page, "light", (messageText + "\n\n").repeat(12));
    const scroll = page.locator(".conversation-scroll");
    await scroll.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
      element.scrollTop = 250;
    });
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(250);
    const before = await geometry(
      page.locator(
        '.workspace-header,.composer-toolbar,[data-message-id="original"] > .message-body',
      ),
    );
    send({
      type: "thread.upserted",
      thread: {
        ...summary,
        state: "running",
        currentTurnId: "new-turn",
        updatedAt: summary.updatedAt + 1,
      },
    });
    send({
      type: "turn.replaced",
      threadId: summary.id,
      turn: turn("new-turn", "Новое сообщение в конце истории."),
    });
    await expect(page.getByText("Новое сообщение в конце истории.", { exact: true })).toHaveCount(
      1,
    );
    await waitForVisualReady(page);
    expect(await scroll.evaluate((element) => element.scrollTop)).toBe(250);
    unchanged(
      before,
      await geometry(
        page.locator(
          '.workspace-header,.composer-toolbar,[data-message-id="original"] > .message-body',
        ),
      ),
    );
  });
}
