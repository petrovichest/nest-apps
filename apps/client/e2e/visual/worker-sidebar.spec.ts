import { expect, test } from "@playwright/test";
import type { ThreadSummary } from "@codexnest/protocol";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  installVisualFixture,
  mainThread,
  snapshot,
  waitForVisualReady,
} from "./fixtures";

for (const viewport of [DESKTOP_VIEWPORT, PHONE_VIEWPORT, { ...PHONE_VIEWPORT, width: 320 }]) {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["ru", "en"] as const) {
      test(`identifies worker sessions in the header and sidebar at ${viewport.width}px in ${theme}/${language}`, async ({
        page,
      }, info) => {
        const en = language === "en";
        const mobile = viewport.width <= PHONE_VIEWPORT.width;
        const label = en ? "Worker session" : "Сессия работника";
        const lead: ThreadSummary = {
          ...mainThread,
          title: en ? "Plan the client release" : "План релиза клиента",
          teamLead: true,
          workerSession: {
            name: en ? "Team lead for client" : "Тимлид разработки",
            workerId: "lead",
            projectKey: "canonical-project",
          },
        };
        const child: ThreadSummary = {
          ...lead,
          id: "worker-child",
          title: en
            ? "Review keyboard focus and accessible names"
            : "Проверить клавиатурный фокус и доступные названия",
          pinned: false,
          teamLead: false,
          relation: { kind: "session", sessionId: "worker-child" },
          workerSession: {
            name: en ? "Frontend" : "Фронтенд",
            parentThreadId: lead.id,
            workerId: "frontend",
            projectKey: lead.workerSession!.projectKey,
          },
        };
        const ordinary = {
          ...snapshot.threads.find((thread) => thread.id === "session-active")!,
          title: en ? "Check theme tokens" : "Сверка токенов темы",
        };
        const native = {
          ...snapshot.threads.find((thread) => thread.id === "session-child")!,
          title: en ? "Inspect dialog layout" : "Аудит диалогов",
        };
        const longProject = {
          ...snapshot.projects[1]!,
          displayName: (en ? "Client release workspace " : "Проект клиентского приложения ")
            .repeat(8)
            .trim(),
        };
        const legacy: ThreadSummary = {
          ...lead,
          id: "worker-legacy",
          projectId: longProject.id,
          cwd: longProject.path,
          pinned: false,
          teamLead: false,
          relation: { kind: "session", sessionId: "worker-legacy" },
          title: (en ? "Review mobile layout " : "Проверить мобильную шапку ").repeat(12).trim(),
          workerSession: {
            name: (en ? "Client release lead " : "Тимлид выпуска клиента ").repeat(12).trim(),
          },
        };
        await page.setViewportSize(viewport);
        await installVisualFixture(page, {
          theme,
          language,
          reducedMotion: "no-preference",
          snapshot: {
            ...snapshot,
            projects: [snapshot.projects[0]!, longProject],
            threads: [lead, ordinary, child, native, legacy],
          },
        });
        await page.goto(`/threads/${lead.id}`);
        const header = page.locator(".workspace-header");
        await expect(header.getByRole("heading", { name: lead.title })).toBeVisible();
        await expect(header.getByText(label, { exact: true })).toHaveCount(1);
        const identity = header.locator(".workspace-worker");
        const workerName = identity.locator(".workspace-worker-name");
        const portrait = identity.locator(".worker-avatar");
        const actions = header.locator(".workspace-actions");
        const actionBounds = await actions.boundingBox();
        await expect(workerName).toHaveText(lead.workerSession!.name);
        await expect(workerName).toHaveCSS("font-family", /^Onest,/u);
        await expect(workerName).toHaveCSS("font-weight", "400");
        if (viewport.width === PHONE_VIEWPORT.width) {
          expect(
            await workerName.evaluate((element) => element.scrollWidth - element.clientWidth),
          ).toBeLessThanOrEqual(1);
        }
        await expect(portrait).toBeVisible();
        await expect(portrait).toHaveAttribute("aria-hidden", "true");
        await expect(identity.locator("a, button, [tabindex]")).toHaveCount(0);
        if (mobile) {
          const navigation = header.getByRole("button", {
            name: en ? "Open task list" : "Открыть список задач",
          });
          await navigation.focus();
          await page.keyboard.press("Tab");
          await expect(actions.locator(".icon-button").first()).toBeFocused();
          await page.keyboard.press("Shift+Tab");
          await expect(navigation).toBeFocused();
          await navigation.press("Enter");
        }

        const sidebar = page.locator(".sidebar");
        const link = (id: string) => sidebar.locator(`a[href="/threads/${id}"]`);
        const leadLink = link(lead.id);
        const toggle = sidebar.locator(".thread-subagent-count");
        await toggle.focus();
        await toggle.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        for (const worker of [lead, child]) {
          const workerLink = link(worker.id);
          await expect(workerLink.locator(".thread-link-worker-title svg")).toBeVisible();
          await expect(workerLink).toHaveAccessibleName(new RegExp(worker.title, "u"));
          await expect(workerLink).toHaveAccessibleDescription(label);
          await expect(workerLink.locator(".thread-link-title-text")).toHaveText(worker.title);
        }
        for (const nonWorker of [ordinary, native]) {
          const ordinaryLink = link(nonWorker.id);
          await expect(ordinaryLink).toBeVisible();
          await expect(ordinaryLink.locator(".thread-link-worker-title")).toHaveCount(0);
          await expect(ordinaryLink).not.toHaveAccessibleDescription(label);
        }
        const childLink = link(child.id);
        const childTitle = childLink.locator(".thread-link-title");
        const childIcon = childLink.locator("svg").first();
        await expect(leadLink.locator(".thread-pinned-marker")).toBeVisible();
        await expect(childLink.locator(".status-completed")).toBeVisible();
        await expect(childTitle.locator(".thread-link-title-text")).toHaveCSS(
          "text-overflow",
          "ellipsis",
        );
        if (!mobile) {
          await childLink.hover();
          await expect(childTitle).toHaveAttribute("data-overflowing", "true");
          const oldPosition = await childIcon.boundingBox();
          await expect(childTitle.locator(".thread-link-title-text")).toHaveCSS(
            "animation-name",
            "thread-title-scroll",
          );
          expect(await childIcon.boundingBox()).toEqual(oldPosition);
          await page.mouse.move(viewport.width - 5, viewport.height - 5);
        }
        expect(
          await sidebar.evaluate((element) => element.scrollWidth - element.clientWidth),
        ).toBeLessThanOrEqual(1);
        await waitForVisualReady(page);
        await childLink.focus();
        await expect(childLink).toBeFocused();
        await page.screenshot({
          path: info.outputPath(`sidebar-${viewport.width}-${theme}-${language}.png`),
        });
        await childLink.press("Enter");
        await expect(page).toHaveURL(new RegExp(`/threads/${child.id}$`, "u"));
        await expect(header.getByRole("heading", { name: child.title })).toBeVisible();
        await expect(workerName).toHaveText(child.workerSession!.name);
        await expect(portrait).toBeVisible();
        await page.goto(`/threads/${ordinary.id}`);
        await expect(header.getByRole("heading", { name: ordinary.title })).toBeVisible();
        await expect(identity).toHaveCount(0);

        await page.goto(`/threads/${legacy.id}`);
        const heading = header.getByRole("heading", { name: legacy.title, exact: true });
        const project = header.locator(".workspace-context");
        await expect(heading).toBeVisible();
        await expect(workerName).toHaveText(legacy.workerSession!.name);
        await expect(workerName).toHaveAttribute("title", legacy.workerSession!.name);
        await expect(identity.locator("svg")).toBeVisible();
        await expect(portrait).toHaveCount(0);
        await waitForVisualReady(page);
        if (mobile) await expect(project).toBeHidden();
        for (const text of [heading, workerName, ...(mobile ? [] : [project])]) {
          await expect(text).toHaveCSS("text-overflow", "ellipsis");
          expect(await text.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
            true,
          );
        }
        expect(await actions.boundingBox()).toEqual(actionBounds);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
          viewport.width,
        );
      });
    }
  }
}

const threadWithWorker: ThreadSummary = {
  ...mainThread,
  title: "План релиза клиента",
  workerSession: {
    name: "Тимлид разработки",
    workerId: "lead",
    projectKey: "canonical-project",
  },
};
const workerSnapshot = {
  ...snapshot,
  threads: snapshot.threads.map((thread) =>
    thread.id === mainThread.id ? threadWithWorker : thread,
  ),
};

test("keeps worker typography consistent and the project visible at the desktop breakpoint", async ({
  page,
}, info) => {
  await installVisualFixture(page, { theme: "light", language: "ru", snapshot: workerSnapshot });
  await page.goto(`/threads/${threadWithWorker.id}`);
  const header = page.locator(".workspace-header");
  const name = header.locator(".workspace-worker-name");
  const project = header.locator(".workspace-context");
  for (const width of [520, 521, 821, 850]) {
    await page.setViewportSize({ width, height: 844 });
    await waitForVisualReady(page);
    await expect(name).toHaveCSS("font-size", "12px");
    if (width >= 821) {
      await expect(project).toBeVisible();
      expect(await project.evaluate((element) => element.clientWidth)).toBeGreaterThan(20);
      await page.screenshot({ path: info.outputPath(`worker-header-${width}.png`) });
    }
  }
});

test("fits the largest worker caption into the mobile header", async ({ page }, info) => {
  await page.setViewportSize(PHONE_VIEWPORT);
  await installVisualFixture(page, { theme: "light", language: "ru", snapshot: workerSnapshot });
  await page.addInitScript(() =>
    localStorage.setItem("codexnest.typography", JSON.stringify({ caption: 32 })),
  );
  await page.goto(`/threads/${threadWithWorker.id}`);
  await waitForVisualReady(page);
  const header = page.locator(".workspace-header");
  const name = header.locator(".workspace-worker-name");
  await expect(name).toHaveCSS("font-size", "32px");
  const box = await name.evaluate((element) => ({
    visible: element.clientHeight,
    content: element.scrollHeight,
  }));
  expect(box.visible).toBeGreaterThanOrEqual(box.content);
  const titleBounds = (await header.locator(".workspace-title").boundingBox())!;
  const headerBounds = (await header.boundingBox())!;
  expect(titleBounds.y + titleBounds.height).toBeLessThanOrEqual(
    headerBounds.y + headerBounds.height,
  );
  await expect(header.getByRole("button", { name: "Показать сведения" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("worker-header-font32.png") });
});
