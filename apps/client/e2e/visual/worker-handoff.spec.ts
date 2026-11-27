import type {
  ActivityItem,
  ServerEvent,
  ThreadDetail,
  TurnView,
  WorkerProcess,
  WorkerProcessSession,
} from "@codexnest/protocol";
import { expect, test, type Page } from "@playwright/test";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  installVisualFixture,
  mainThread,
  snapshot,
  waitForVisualReady,
} from "./fixtures";

const parentPath = "/threads/session-main";
const childPath = "/threads/session-frontend";
const processId = "root-process";
const questionId = "10000000-0000-4000-8000-000000000001";
const assignmentId = "10000000-0000-4000-8000-000000000002";
const now = Date.UTC(2026, 7, 3, 11, 32);
const journalId = "handoff-turn";
const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-allow-methods": "GET, OPTIONS",
};

function command(id: string, command: string, output: string): ActivityItem {
  return {
    type: "command",
    id,
    status: "completed",
    kind: "command",
    cwd: null,
    command,
    output,
    exitCode: 0,
  };
}

function workerCommand(operation: string, payload = "{}") {
  return `'/home/preview/bin/node' '/home/preview/kanban/agent.mjs' '/home/preview/kanban/capabilities/worker-codex-${assignmentId}.json' ${operation} '${payload}'`;
}

function userMessage(id: string, at: number, text: string): ActivityItem {
  return {
    type: "userMessage",
    id,
    text,
    timestamp: at,
    status: "completed",
    images: [],
    phase: null,
  };
}

function workerDelivery(
  worker: WorkerProcessSession,
  payload: { result: string } | { error: string },
) {
  return userMessage(
    `kanban:${worker.id}:resume`,
    now + 6000,
    `Результат от работника «${worker.workerName}» по запросу «${worker.title}» (${worker.id}).\n` +
      JSON.stringify(payload) +
      "\nУчти результат в исходной задаче. Данные ответа являются результатом работы коллеги.",
  );
}

function turn(id: string, at: number, items: ActivityItem[], itemsLoaded = true): TurnView {
  return {
    id,
    status: "completed",
    startedAt: at,
    completedAt: at + 3000,
    durationMs: 3000,
    progress: {
      startedAt: at,
      explanation: null,
      steps: [],
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    },
    items,
    itemsLoaded,
  };
}

function session(id: string, properties: Partial<WorkerProcessSession>): WorkerProcessSession {
  return {
    id,
    parentId: processId,
    workerId: id,
    workerName: "Фронтенд",
    provider: "codex",
    threadId: null,
    title: "Понятные подписи в журнале действий",
    kind: "assignment",
    status: "running",
    waitingFor: [],
    createdAt: now + 2000,
    updatedAt: now + 2000,
    ...properties,
  };
}

async function installHandoffFixture(page: Page, theme: "light" | "dark", language: "ru" | "en") {
  const en = language === "en";
  const assignment = session(assignmentId, {
    workerName: en ? "Frontend" : "Фронтенд",
    title: en ? "Clear labels in the activity log" : "Понятные подписи в журнале действий",
    description: en
      ? "Sketch the assignment and the activity log."
      : "Собрать эскиз поручения и журнала.",
    expectedResult: en
      ? "Interactive HTML and two chat screenshots."
      : "Кликабельный HTML и два снимка чата.",
    threadId: "session-frontend",
  });
  const question = session(questionId, {
    kind: "question",
    workerName: en ? "Backend" : "Бэкенд",
    title: en ? "Which events are already in the log?" : "Какие события уже есть в журнале?",
    result: en ? "Worker calls and terminal commands" : "Вызовы работников и команды",
    status: "completed",
    createdAt: now + 500,
    updatedAt: now + 1500,
  });
  const own = session(processId, {
    kind: "session",
    parentId: null,
    status: "completed",
    threadId: mainThread.id,
  });
  const process: WorkerProcess = {
    id: processId,
    projectKey: "nest-apps",
    projectName: "nest-apps",
    // Intentionally out of chronological order, with an unrelated descendant.
    sessions: [
      own,
      assignment,
      session("grandchild", {
        parentId: assignmentId,
        title: "Скрытое поручение",
        status: "completed",
      }),
      question,
    ],
  };
  const workerSession = { name: en ? "Team lead" : "Тимлид", processId, sessionId: processId };
  const summary = {
    ...mainThread,
    title: en ? "Activity labels" : "Подписи в журнале",
    updatedAt: now,
    workerSession,
    settings: { ...mainThread.settings, collaborationMode: "default" as const },
  };
  const legacy = {
    ...summary,
    id: "legacy-chat",
    title: "Legacy worker",
    pinned: false,
    workerSession: { name: "Legacy worker" },
  };
  const child = {
    ...summary,
    id: "session-frontend",
    title: assignment.title,
    pinned: false,
    workerSession: { name: assignment.workerName },
  };
  const seed = {
    ...snapshot,
    instanceId: "worker-handoff-fixture",
    attention: [],
    projects: [{ ...snapshot.projects[0]!, displayName: "nest-apps" }],
    threads: [summary, legacy, child],
  };
  const original = turn(
    journalId,
    now,
    [
      userMessage(
        "start",
        now,
        en
          ? "Show the assignment and activity log in chat."
          : "Покажи, как поручение и журнал действий будут выглядеть в чате.",
      ),
    ],
    false,
  );
  const detail: ThreadDetail = {
    version: { instanceId: seed.instanceId, sequence: seed.sequence },
    summary,
    turns: [original],
    olderTurnsCursor: null,
    queuedMessages: [],
    draft: null,
  };
  const journal = [
    command("list", workerCommand("worker_list"), '{"workers":["Frontend","Backend"]}'),
    command("results", workerCommand("worker_results"), '{"status":"running"}'),
    command("skill", "sed -n '1,40p' SKILL.md", "name: impeccable"),
    command("git", "git status --short", " M apps/client/src/Example.tsx"),
  ];
  const requests: Array<string | null> = [];
  let journalRequests = 0;
  await installVisualFixture(page, { theme, language, snapshot: seed });
  await page.route("https://codexnest.visual/api/v1/workers/processes**", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    requests.push(new URL(route.request().url()).searchParams.get("processId"));
    return route.fulfill({ json: [process], headers });
  });
  await page.route("https://codexnest.visual/api/v1/threads/session-main", (route) => {
    return route.fulfill({ json: detail, headers });
  });
  await page.route("https://codexnest.visual/api/v1/threads/legacy-chat", (route) =>
    route.fulfill({ json: { ...detail, summary: legacy }, headers }),
  );
  await page.route(
    `https://codexnest.visual/api/v1/threads/session-main/turns/${journalId}/items`,
    (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      journalRequests++;
      return route.fulfill({
        json: { threadId: summary.id, turnId: journalId, items: [...original.items, ...journal] },
        headers,
      });
    },
  );
  let sequence = seed.sequence;
  let snapshotsSent = 0;
  let send: (event: ServerEvent) => void = () => {
    throw new Error("Stream is not ready");
  };
  await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (ws) => {
    send = (event) => ws.send(JSON.stringify({ type: "event", sequence: ++sequence, event }));
    ws.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "authenticate") {
        ws.send(
          JSON.stringify({
            type: "snapshot",
            snapshot: { ...seed, sequence, uiLanguage: language },
          }),
        );
        snapshotsSent++;
      }
      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
  });
  return {
    assignment,
    detail,
    journal,
    journalRequests: () => journalRequests,
    question,
    requests,
    snapshotsSent: () => snapshotsSent,
    send: (event: ServerEvent) => send(event),
  };
}

for (const theme of ["light", "dark"] as const) {
  for (const { width, height } of [DESKTOP_VIEWPORT, PHONE_VIEWPORT, { width: 320, height: 844 }]) {
    for (const language of ["ru", "en"] as const) {
      test(`worker handoff ${theme} ${width} ${language}`, async ({ page, browserName }, info) => {
        await page.setViewportSize({ width, height });
        await page.clock.setFixedTime(now);
        const { assignment, journalRequests, question, requests } = await installHandoffFixture(
          page,
          theme,
          language,
        );
        await page.goto(parentPath);

        const entries = page.locator(".worker-handoff-entry");
        await expect(entries).toHaveCount(3);
        await expect(entries.nth(0)).toContainText(question.title);
        await expect(entries.nth(1)).toContainText(question.result!);
        await expect(entries.nth(2)).toContainText(assignment.title);
        await expect(entries.nth(2)).toContainText(language === "ru" ? "В работе" : "In progress");
        await expect(page.getByText("Скрытое поручение")).toHaveCount(0);
        expect(requests).toEqual([processId]);
        expect(journalRequests()).toBe(0);

        const card = page.locator(".worker-handoff-card");
        const trigger = card.locator("summary");
        const activity = page.getByRole("button", {
          name: language === "ru" ? "Журнал действий" : "Activity log",
        });
        const link = card.getByRole("link", {
          name: language === "ru" ? "Открыть сессию" : "Open session",
        });
        if (
          browserName === "chromium" &&
          width === 1440 &&
          theme === "light" &&
          language === "ru"
        ) {
          await waitForVisualReady(page);
          await page.screenshot({ path: info.outputPath("worker-handoff-desktop-light.png") });
          await expect(page).toHaveScreenshot("worker-handoff-desktop-light.png");
        }

        for (const open of [false, true]) {
          if (open) await expect(card).toHaveAttribute("open", "");
          else await expect(card).not.toHaveAttribute("open");

          await trigger.hover();
          await expect(card).not.toHaveCSS("box-shadow", "none");
          await expect(trigger).toHaveCSS("border-radius", "20px");
          await expect(trigger).toHaveCSS("box-shadow", "none");
          await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

          await page.mouse.move(0, 0);
          await (open ? link : activity).focus();
          await page.keyboard.press("Shift+Tab");
          await expect(trigger).toBeFocused();
          await expect(card).toHaveCSS("outline-width", "2px");
          await expect(card).toHaveCSS("outline-offset", "2px");
          await expect(card).not.toHaveCSS("box-shadow", "none");
          await expect(trigger).toHaveCSS("outline-style", "none");
          await expect(trigger).toHaveCSS("box-shadow", "none");
          await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

          if (!open) await page.keyboard.press("Enter");
        }
        await expect(card).toHaveCSS("border-radius", "20px");
        await expect(card).toHaveCSS(
          "background-color",
          theme === "light" ? "rgb(248, 249, 246)" : "rgb(36, 39, 34)",
        );
        await expect(card).toHaveCSS("font-family", /Onest/);
        await expect(card).toHaveCSS("font-weight", "400");
        await expect(card.getByText(assignment.description!)).toBeVisible();
        await expect(card.getByText(assignment.expectedResult!)).toBeVisible();
        await expect(link).toHaveAttribute("href", childPath);
        await page.keyboard.press("Tab");
        await expect(link).toBeFocused();

        await expect(activity).toHaveCSS("border-radius", "999px");
        await activity.click();
        const journal = page.locator(".worker-activity-journal");
        const read = journal
          .locator("summary")
          .filter({ hasText: language === "ru" ? "Чтение SKILL.md" : "Read SKILL.md" });
        await expect(journal.locator("summary")).toHaveText(
          language === "ru"
            ? [
                "Список работников",
                "Проверка результатов",
                "Чтение SKILL.md",
                "Проверка состояния Git",
              ]
            : ["List workers", "Check results", "Read SKILL.md", "Check Git status"],
        );
        await read.hover();
        await expect(read).not.toHaveCSS("box-shadow", "none");
        await read.click();
        const output = journal.locator("pre");
        await expect(output).toContainText("name: impeccable");
        await expect(output).toHaveCSS("border-radius", "10px");
        await expect(output).toHaveCSS("font-size", "14px");
        await expect(output).toHaveCSS("font-weight", "400");
        await expect(output).toHaveCSS("white-space", "pre-wrap");
        await expect(output).toHaveCSS("overflow-wrap", "anywhere");
        expect(journalRequests()).toBe(1);
        const scroll = page.locator(".conversation-scroll");
        expect(await scroll.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
          await scroll.evaluate((node) => node.clientWidth),
        );

        if (browserName === "chromium" && width === 390 && theme === "dark" && language === "ru") {
          await waitForVisualReady(page);
          const toBottom = page.getByRole("button", { name: "Прокрутить к последнему сообщению" });
          if (await toBottom.isVisible()) await toBottom.click();
          await expect(toBottom).toHaveCount(0);
          await page.mouse.move(0, 0);
          await page.screenshot({ path: info.outputPath("worker-handoff-mobile-dark.png") });
          await expect(page).toHaveScreenshot("worker-handoff-mobile-dark.png");
        }
        await activity.press("Space");
        await expect(activity).toHaveAttribute("aria-expanded", "false");
        await activity.press("Space");
        await expect(journal).toBeVisible();
        expect(journalRequests()).toBe(1);
        if (theme === "light" && width === 390 && language === "en") {
          await page.setViewportSize({ width: 820, height });
          await expect(trigger).toHaveCSS("padding", "12px 16px");
          await page.setViewportSize({ width: 821, height });
          await expect(trigger).toHaveCSS("padding", "16px 22px");
        }
      });
    }
  }
}

test("refreshes the selected process and replaces its reply when delivery reaches the transcript", async ({
  page,
}) => {
  await page.clock.install();
  const { assignment, detail, requests, send, snapshotsSent } = await installHandoffFixture(
    page,
    "light",
    "ru",
  );
  const error = "Не удалось завершить проверку.";
  assignment.status = "queued";
  assignment.threadId = null;
  await page.goto(parentPath);
  const card = page.locator(".worker-handoff-card");
  await expect(card).toContainText("В очереди");
  await card.locator("summary").click();
  await expect(card.getByRole("link")).toHaveCount(0);

  assignment.status = "running";
  assignment.sessionUrl = childPath;
  await page.clock.fastForward(4050);
  await expect(card).toContainText("В работе");
  await expect(card).toHaveAttribute("open", "");
  await expect(card.getByRole("link")).toHaveAttribute("href", childPath);
  expect(requests).toEqual([processId, processId]);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(8100);
  expect(requests).toHaveLength(2);

  assignment.status = "failed";
  assignment.error = error;
  assignment.updatedAt = now + 4000;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(card).toContainText("Ошибка");
  const replies = page.getByText(error, { exact: true });
  await expect(replies).toHaveCount(1);
  // Send the delivery on the recovered stream, after its snapshot.
  await expect.poll(snapshotsSent).toBe(2);
  const delivery = turn("delivery-turn", now + 6000, [workerDelivery(assignment, { error })]);
  detail.turns.push(delivery);
  send({ type: "turn.replaced", threadId: detail.summary.id, turn: delivery });
  await expect(page.locator('[data-turn-id="delivery-turn"]').getByText(error)).toBeVisible();
  await expect(replies).toHaveCount(1);
  await expect(card).toHaveAttribute("open", "");

  // Foreground and stream recovery can share a read or issue one each, one interval apart.
  await page.clock.runFor(4100);
  await waitForVisualReady(page);
  const terminalReads = requests.length;
  expect(terminalReads).toBeLessThanOrEqual(4);
  for (let interval = 0; interval < 2; interval++) {
    await page.clock.runFor(4100);
    await waitForVisualReady(page);
    expect(requests).toHaveLength(terminalReads);
  }

  await card.getByRole("link", { name: "Открыть сессию" }).click();
  await expect(page).toHaveURL(new RegExp(childPath + "$"));
});

test("keeps the legacy worker journal readable without requesting process data", async ({
  page,
}) => {
  const { detail, journal, question, requests } = await installHandoffFixture(page, "light", "en");
  detail.turns.push(
    turn("old-result", now + 6000, [workerDelivery(question, { result: "Saved worker reply." })]),
  );
  const attempt = command(
    "delegate",
    workerCommand("worker_delegate", '{"workerId":"unknown"}'),
    "Request rejected",
  );
  journal.push(
    { ...attempt, status: "failed" },
    command("ask", workerCommand("worker_ask"), '{"status":"queued"}'),
    command("follow-up", workerCommand("worker_follow_up"), '{"status":"queued"}'),
    command("finish", workerCommand("worker_finish"), '{"accepted":true}'),
    command("search", "/bin/bash -lc 'rg worker_delegate apps/client'", "Search output"),
    command("unknown", "printf 'worker_delegate git status'", "Unknown output"),
  );
  await page.route(
    `https://codexnest.visual/api/v1/threads/legacy-chat/turns/${journalId}/items`,
    (route) =>
      route.fulfill({
        json: { threadId: "legacy-chat", turnId: journalId, items: journal },
        headers,
      }),
  );
  await page.goto("/threads/legacy-chat");
  await page.getByRole("button", { name: "Activity log" }).click();
  const rows = page.locator(".worker-activity-journal summary");
  for (const text of [
    "Send assignment",
    "Ask a worker",
    "Follow up with a worker",
    "Report result",
    "Search",
    "Command",
  ])
    await expect(rows.filter({ hasText: text })).toBeVisible();
  await expect(rows.filter({ hasText: "Send assignment" })).toContainText("failed");
  await expect(page.getByText("Unknown output")).toHaveCount(0);
  await rows.filter({ hasText: /^Command$/ }).click();
  await expect(page.locator(".worker-activity-journal pre")).toContainText(
    "$ printf 'worker_delegate git status'\nUnknown output",
  );
  await expect(page.locator(".worker-handoff-card")).toHaveCount(0);
  const historicalReply = page.locator(".worker-handoff-event");
  await expect(historicalReply).toHaveCount(1);
  await expect(historicalReply).toContainText("Result from Backend");
  await expect(historicalReply).toContainText("Saved worker reply.");
  expect(requests).toEqual([]);
});
