import { expect, test } from "@playwright/test";
import type { WorkerProfile, WorkerProposal } from "@codexnest/protocol";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  installVisualFixture,
  snapshot,
  waitForVisualReady,
} from "./fixtures";

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
};

const projects = [
  ...snapshot.projects,
  ...(
    [
      ["Документация", "docs"],
      ["Мобильный клиент", "mobile"],
      ["Атлас материалов", "material-atlas"],
      ["Интеграции", "integrations"],
      ["Инфраструктура", "infrastructure"],
      ["Мониторинг", "monitoring"],
    ] as const
  ).map(([displayName, directory]) => ({
    ...snapshot.projects[0]!,
    id: `project-${directory}`,
    displayName,
    path: `/work/${directory}`,
  })),
];

for (const width of [1440, 390]) {
  test(`opens the worker catalogue and edits a profile at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize(width === 1440 ? DESKTOP_VIEWPORT : PHONE_VIEWPORT);
    await installVisualFixture(page, {
      theme: width === 1440 ? "light" : "dark",
      snapshot: { ...snapshot, projects },
    });
    const architect: WorkerProfile = {
      id: "architect",
      name: "Архитектор работников",
      role: "Помогает создать работника",
      instructions: "",
      projectKey: null,
      settings: {},
      revision: 0,
    };
    const common = {
      ...architect,
      id: "reviewer",
      name: "Ревьюер",
      role: "Проверяет изменения в коде",
      revision: 1,
    };
    let lead = {
      ...common,
      id: "lead",
      name: "Тимлид",
      role: "Планирует работу",
      projectKey: "canonical-project",
      coordinates: true,
    };
    const starts: string[] = [];
    const projectCreationIds: string[] = [];
    await page.route("**/api/v1/workers/**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/catalog"))
        return route.fulfill({
          headers,
          json: {
            common: [architect, common],
            projects: [{ projectId: "project-nest", workers: [lead] }],
          },
        });
      if (path.endsWith("/lead") && request.method() === "PATCH") {
        lead = { ...lead, name: request.postDataJSON().name, revision: lead.revision + 1 };
        return route.fulfill({ headers, json: lead });
      }
      if (path.endsWith("/architect"))
        return route.fulfill({ headers, json: { profile: architect, memory: [] } });
      if (path.endsWith("/lead"))
        return route.fulfill({ headers, json: { profile: lead, memory: [] } });
      if (path.endsWith("/sessions")) {
        const projectId = new URL(request.url()).searchParams.get("projectId") ?? "";
        starts.push(projectId);
        if (projectId === "project-nest") {
          projectCreationIds.push(request.postDataJSON().creationId);
          if (projectCreationIds.length === 1)
            return route.fulfill({
              status: 503,
              headers,
              json: { error: { code: "app_server_unavailable", message: "Network unavailable" } },
            });
        }
        return route.fulfill({ headers, json: { threadId: "session-main" } });
      }
      return route.fulfill({
        status: 404,
        headers,
        json: { error: { message: "Worker not found" } },
      });
    });
    await page.goto("/workers");
    await expect(page.getByRole("heading", { name: "Работники" })).toBeVisible();
    const tiles = page.locator(".worker-tile");
    await expect(tiles).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "Общие", exact: true })).toHaveCount(0);
    await expect(tiles.filter({ hasText: "Ревьюер" })).toHaveCount(0);
    await expect(tiles.first()).toContainText("Архитектор");
    await expect(tiles.first().locator(".worker-delegation")).toHaveText(
      "Не может поручать задачи",
    );
    await expect(tiles.last().locator(".worker-delegation")).toHaveText("Может поручать задачи");
    await waitForVisualReady(page);
    await page.screenshot({ path: info.outputPath("workers.png") });
    const architectTile = tiles.filter({ hasText: "Архитектор" });
    await architectTile.click();
    const architectProjects = page.getByRole("dialog", { name: "Запустить «Архитектор»" });
    const search = architectProjects.getByRole("searchbox", { name: "Найти проект" });
    const options = architectProjects.locator(".worker-project-option");
    await expect(search).toBeFocused();
    await expect(options).toHaveCount(projects.length);
    expect(starts).toEqual([]);
    await page.screenshot({ path: info.outputPath("worker-project-picker.png") });
    const searchTop = await search.evaluate((input) => input.getBoundingClientRect().top);
    const fullHeight = await architectProjects.evaluate((dialog) => dialog.clientHeight);
    const results = architectProjects.locator(".project-directory-list");
    await results.evaluate((list) => (list.scrollTop = list.scrollHeight));
    await page.keyboard.insertText("атлас");
    await expect(options).toHaveCount(2);
    await expect(
      architectProjects.getByRole("button", { name: /^Минеральный атлас/ }),
    ).toBeVisible();
    await expect(
      architectProjects.getByRole("button", { name: /^Атлас материалов/ }),
    ).toBeVisible();
    expect(await results.evaluate((list) => list.scrollTop)).toBe(0);
    expect(await search.evaluate((input) => input.getBoundingClientRect().top)).toBeCloseTo(
      searchTop,
      0,
    );
    expect(await architectProjects.evaluate((dialog) => dialog.clientHeight)).toBeLessThan(
      fullHeight,
    );
    await page.screenshot({ path: info.outputPath("worker-project-filtered.png") });
    await search.press("Enter");
    expect(starts).toEqual([]);
    await search.fill("Нет такого проекта");
    await expect(architectProjects.getByRole("status")).toHaveText("Совпадений нет");
    await expect(options).toHaveCount(0);
    await search.fill("");
    await expect(options).toHaveCount(projects.length);
    await page.keyboard.press("Escape");
    await expect(architectProjects).toBeHidden();
    await architectTile.focus();
    await architectTile.press("Enter");
    await expect(architectProjects).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(architectProjects).toBeHidden();
    await expect(architectTile).toBeFocused();
    await architectTile.click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await search.fill(" мИНЕральный ");
    await expect(options).toHaveCount(1);
    await search.press("Enter");
    await expect(page).toHaveURL(/\/threads\/session-main$/u);
    expect(starts).toEqual(["project-mineral"]);
    await page.goto("/workers");
    await page.getByRole("button", { name: "Настройки работника «Архитектор»" }).click();
    const architectSettings = page.getByRole("dialog", { name: "Архитектор", exact: true });
    await expect(
      architectSettings.getByText("Архитектор использует настройки приложения по умолчанию."),
    ).toBeVisible();
    await architectSettings.getByRole("button", { name: "Закрыть" }).click();
    await page.getByRole("button", { name: "Настройки работника «Тимлид»" }).click();
    const settings = page.getByRole("dialog", { name: "Тимлид" });
    await expect(settings.getByRole("textbox", { name: "Постоянные инструкции" })).toHaveCSS(
      "border-radius",
      "20px",
    );
    await expect(settings.getByRole("textbox", { name: "Имя" })).toHaveCSS(
      "border-radius",
      "999px",
    );
    const leadPortrait = await tiles.last().locator(".worker-avatar").innerHTML();
    await settings.getByRole("textbox", { name: "Имя" }).fill("Руководитель");
    await settings.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(tiles.last()).toContainText("Руководитель");
    await expect(tiles.last().locator(".worker-avatar")).toHaveJSProperty(
      "innerHTML",
      leadPortrait,
    );
    await tiles.last().focus();
    await tiles.last().press("Enter");
    await expect(page.getByRole("alert")).toHaveText("Network unavailable");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(tiles.last()).toBeFocused();
    await tiles.last().press("Enter");
    await expect(page).toHaveURL(/\/threads\/session-main$/u);
    expect(starts).toEqual(["project-mineral", "project-nest", "project-nest"]);
    expect(projectCreationIds[0]).toBeTruthy();
    expect(projectCreationIds[1]).toBe(projectCreationIds[0]);
  });
}

const architect: WorkerProfile = {
  id: "architect",
  name: "Архитектор",
  role: "",
  instructions: "",
  projectKey: null,
  settings: {},
  revision: 0,
  coordinates: true,
};

const catalogueViewports = [DESKTOP_VIEWPORT, PHONE_VIEWPORT, { width: 1840, height: 1000 }];
for (const viewport of catalogueViewports) {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["ru", "en"] as const) {
      if (viewport.width === 1840 && (theme !== "light" || language !== "ru")) continue;
      test(`fits worker cards at ${viewport.width}px in ${theme}/${language}`, async ({
        page,
      }, info) => {
        await page.setViewportSize(viewport);
        await installVisualFixture(page, { theme, language });
        const en = language === "en";
        const names = en
          ? ["Team Lead", "Frontend", "Backend", "Frontend Accessibility Reviewer", "Release", "QA"]
          : [
              "Тимлид",
              "Фронтенд",
              "Бэкенд",
              "Фронтенд-контролёр доступности",
              "Релиз-инженер",
              "Тестировщик",
            ];
        const roles = en
          ? [
              "Coordinates project work",
              "Builds client screens",
              "Maintains the server API",
              "Checks keyboard and screen reader flows",
              "Prepares releases",
              "Tests user scenarios",
            ]
          : [
              "Координирует работу проекта",
              "Дорабатывает экраны клиента",
              "Поддерживает API сервера",
              "Проверяет клавиатуру и экранные дикторы",
              "Готовит релизы",
              "Проверяет пользовательские сценарии",
            ];
        const workers = names.map((name, index): WorkerProfile => ({
          ...architect,
          id: `843d721f-ae11-4d09-b3e3-b61d08fcc61${index}`,
          name,
          role: roles[index]!,
          projectKey: "canonical-project",
          coordinates: [true, false, undefined, undefined, false, true][index],
          revision: 1,
        }));
        await page.route("**/api/v1/workers/catalog", (route) =>
          route.request().method() === "OPTIONS"
            ? route.fulfill({ status: 204, headers })
            : route.fulfill({
                headers,
                json: {
                  common: [architect],
                  projects: [
                    { projectId: "project-nest", workers },
                    {
                      projectId: "project-mineral",
                      workers: [
                        {
                          ...workers[2]!,
                          id: "worker-mineral",
                          name: en ? "Materials Editor" : "Редактор материалов",
                          role: en ? "Maintains the atlas" : "Поддерживает атлас",
                          projectKey: "canonical-mineral",
                        },
                      ],
                    },
                  ],
                },
              }),
        );
        await page.goto("/workers");
        const tiles = page.locator(".worker-tile");
        await expect(tiles).toHaveCount(8);
        const yes = en ? "Can delegate tasks" : "Может поручать задачи";
        const no = en ? "Cannot delegate tasks" : "Не может поручать задачи";
        await expect(tiles.locator(".worker-delegation")).toHaveText([
          no,
          yes,
          no,
          no,
          no,
          no,
          yes,
          no,
        ]);
        await expect(tiles.first().locator("strong")).toHaveText(en ? "Architect" : "Архитектор");
        const portraits = tiles.locator("svg.worker-avatar");
        await expect(portraits).toHaveCount(8);
        const drawings = await portraits.evaluateAll((nodes) =>
          nodes.map((node) => node.innerHTML),
        );
        expect(new Set(drawings).size).toBe(drawings.length);
        await expect(portraits.first()).toHaveAttribute("aria-hidden", "true");
        await expect(portraits.first()).toHaveCSS("width", "44px");
        await expect(portraits.first()).toHaveCSS("height", "44px");
        const workingArea = page.locator(".worker-catalogue");
        const grid = workingArea.locator(".workers-grid").nth(1);
        await expect(grid.getByText(names[3]!, { exact: true })).toBeVisible();
        await expect(grid.locator("strong").first()).toHaveCSS("font-weight", "400");
        await expect(grid.locator("strong").first()).toHaveCSS("font-family", /Onest/);
        await expect(workingArea.getByRole("heading", { name: "CodexNest" })).toHaveCSS(
          "font-weight",
          "400",
        );
        await expect(page.locator(".workers-tabs a").first()).toHaveCSS("font-weight", "400");
        await waitForVisualReady(page);

        async function assertLayout(minColumns: number) {
          const bounds = await workingArea.evaluate((area) => {
            const grids = area.querySelectorAll(".workers-grid");
            const tile = grids[1]!.querySelector(".worker-tile")!.getBoundingClientRect();
            const columns = getComputedStyle(grids[1]!).gridTemplateColumns.split(" ").length;
            const statusesFit = [...area.querySelectorAll(".worker-delegation")].every((label) => {
              const range = document.createRange();
              range.selectNodeContents(label);
              const card = label.closest(".worker-tile")!.getBoundingClientRect();
              return [...range.getClientRects()].every(
                (rect) =>
                  rect.left >= card.left && rect.right <= card.right && rect.bottom <= card.bottom,
              );
            });
            return {
              area: area.getBoundingClientRect().width,
              pane: area.parentElement!.getBoundingClientRect().width,
              overflow: Math.max(
                area.scrollWidth - area.clientWidth,
                document.documentElement.scrollWidth - document.documentElement.clientWidth,
              ),
              columns,
              tileWidth: tile.width,
              statusesFit,
            };
          });
          expect(bounds.area).toBeCloseTo(bounds.pane, 0);
          expect(bounds.overflow).toBeLessThanOrEqual(1);
          expect(bounds.columns).toBeGreaterThanOrEqual(minColumns);
          expect(bounds.tileWidth).toBeLessThanOrEqual(300);
          expect(bounds.statusesFit).toBe(true);
        }
        await assertLayout(viewport.width === 1840 ? 6 : viewport.width === 1440 ? 4 : 2);
        await page.screenshot({
          path: info.outputPath(`catalogue-${viewport.width}-${theme}-${language}.png`),
        });
        if (viewport.width === 1840) {
          for (const width of [320, 600, 601, 820, 821]) {
            await page.setViewportSize({ width, height: 844 });
            await assertLayout(width === 320 ? 1 : 2);
          }
        }
      });
    }
  }
}

for (const [viewport, theme, language] of [
  ...[DESKTOP_VIEWPORT, PHONE_VIEWPORT].flatMap((viewport) =>
    (["light", "dark"] as const).flatMap((theme) =>
      (["ru", "en"] as const).map((language) => [viewport, theme, language] as const),
    ),
  ),
] as const) {
  test(`renders worker creation and updates at ${viewport.width}px in ${theme}/${language}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await installVisualFixture(page, { theme, language });
    const en = language === "en";
    const yes = en ? "Can delegate tasks" : "Может поручать задачи";
    const no = en ? "Cannot delegate tasks" : "Не может поручать задачи";
    const creation: WorkerProposal = {
      id: "843d721f-ae11-4d09-b3e3-b61d08fcc616",
      provider: "codex",
      projectId: "project-nest",
      projectName: "CodexNest",
      projectKey: "canonical-project",
      name: en ? "Frontend Accessibility Reviewer" : "Фронтенд-контролёр доступности",
      role: en ? "Checks client flows" : "Проверяет сценарии клиента",
      instructions: en
        ? "Review the workers page in both themes. Check keyboard focus, long names and the delegation label."
        : "Проверь каталог работников в обеих темах. Сверь порядок фокуса, длинные имена и подпись права поручений.",
      settings: { model: "gpt-5.6-codex", reasoningEffort: "high" },
      coordinates: true,
    };
    const profile: WorkerProfile = {
      id: creation.id,
      projectKey: creation.projectKey,
      name: creation.name,
      role: creation.role,
      instructions: creation.instructions,
      settings: { codex: creation.settings },
      coordinates: creation.coordinates,
      revision: 1,
    };
    const update = {
      ...creation,
      target: { id: profile.id, revision: 1, previousInstructions: profile.instructions },
    };
    const proposals: Record<string, WorkerProposal> = {
      [creation.id]: creation,
      "create-default": {
        ...creation,
        id: "create-default",
        coordinates: undefined,
        role: creation.role.repeat(28).slice(0, 500),
      },
      "edit-instructions": { ...update, id: "edit-instructions", coordinates: undefined },
      "edit-permissions": { ...update, id: "edit-permissions", coordinates: false },
    };
    let created = false;
    let approveAttempts = 0;
    let releaseApproval!: () => void;
    const approval = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    let releaseProposal!: () => void;
    const proposal = new Promise<void>((resolve) => {
      releaseProposal = resolve;
    });
    await page.route("**/api/v1/workers/**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/catalog")) {
        return route.fulfill({
          headers,
          json: {
            common: [architect],
            projects: created ? [{ projectId: "project-nest", workers: [profile] }] : [],
          },
        });
      }
      if (path.endsWith(`/${creation.id}/approve`)) {
        if (++approveAttempts === 1) {
          await approval;
          return route.fulfill({
            headers,
            status: 409,
            json: { error: { message: "Proposal rejected" } },
          });
        }
        created = true;
        return route.fulfill({ headers, json: profile });
      }
      if (path.endsWith(`/${creation.id}`)) await proposal;
      const data = proposals[path.split("/").at(-1)!];
      return data
        ? route.fulfill({ headers, json: data })
        : route.fulfill({
            headers,
            status: 404,
            json: { error: { message: "Proposal unavailable" } },
          });
    });
    await page.goto(`/workers?proposal=${creation.id}`);
    const dialog = page.getByRole("dialog");
    const close = dialog.getByRole("button", { name: en ? "Close" : "Закрыть" });
    await expect(close).toBeFocused();
    await expect(dialog.getByRole("status")).toBeVisible();
    releaseProposal();
    await expect(dialog.getByRole("heading")).toHaveText(creation.name);
    await expect(dialog.locator(".worker-delegation")).toHaveText(yes);
    await expect(dialog.locator(".worker-proposal-role")).toHaveText(
      `${creation.role} · CodexNest`,
    );
    const avatar = dialog.locator(".worker-avatar");
    await expect(avatar).toBeVisible();
    const portrait = await avatar.innerHTML();
    expect(
      await dialog.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    await waitForVisualReady(page);
    await page.screenshot({
      path: info.outputPath(`proposal-${viewport.width}-${theme}-${language}.png`),
    });
    const approve = dialog.getByRole("button", {
      name: en ? "Create worker" : "Создать работника",
    });
    await page.keyboard.press("Shift+Tab");
    await expect(approve).toBeFocused();
    await approve.press("Enter");
    await expect(
      dialog.getByRole("button", { name: en ? "Creating…" : "Создаём…" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    releaseApproval();
    await expect(dialog.getByRole("alert")).toHaveText("Proposal rejected");
    await approve.click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/workers$/u);
    const savedAvatar = page
      .locator(".worker-tile")
      .filter({ hasText: profile.name })
      .locator(".worker-avatar");
    await expect(savedAvatar).toHaveJSProperty("innerHTML", portrait);
    await page.reload();
    await expect(savedAvatar).toHaveJSProperty("innerHTML", portrait);
    await page.goto("/workers?proposal=create-default");
    await expect(dialog.locator(".worker-delegation")).toHaveText(no);
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(approve).toBeFocused();
    await expect(approve).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.goto("/workers?proposal=edit-instructions");
    await expect(dialog.locator(".worker-avatar")).toHaveJSProperty("innerHTML", portrait);
    await expect(dialog.locator(".worker-delegation")).toHaveCount(0);
    await page.goto("/workers?proposal=edit-permissions");
    await expect(dialog.locator(".worker-avatar")).toHaveJSProperty("innerHTML", portrait);
    await expect(dialog.locator(".worker-delegation")).toHaveText(no);
    await page.goto("/workers?proposal=missing");
    await expect(dialog.getByRole("alert")).toHaveText("Proposal unavailable");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
}
