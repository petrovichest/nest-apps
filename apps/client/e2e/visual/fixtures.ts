import type { Page, Route } from "@playwright/test";

import type {
  AppSnapshot,
  AppUpdateStatus,
  CodexManagementStatus,
  ThreadDetail,
  ThreadSummary,
  TranscriptionConfigResponse,
} from "@codexnest/protocol";

export const DESKTOP_VIEWPORT = { width: 1440, height: 1000 } as const;
export const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

const FIXED_NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
const SERVER_ORIGIN = "https://codexnest.visual";
const TOKEN = "visual-test-token";
const MARKDOWN_ARTIFACT = `# Отчёт по последним 50 транзакциям кошелька

Кошелёк: \`7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5\`. Снимок зафиксирован и обработан офлайн.

## Общая картина

Срез охватывает 50 канонических PumpSwap-операций. Профиль похож на автоматизированную высокочастотную ротацию.

- Успешные операции: 45
- Неуспешные операции: 5

| Метрика | Значение |
| --- | ---: |
| Уникальные mint | 26 |
| Среднее удержание | 457,2 секунды |
`;

const projects: AppSnapshot["projects"] = [
  {
    id: "project-nest",
    displayName: "CodexNest",
    path: "/work/codex-nest",
    createdAt: "2026-07-12T09:00:00.000Z",
    updatedAt: "2026-08-03T11:40:00.000Z",
  },
  {
    id: "project-mineral",
    displayName: "Минеральный атлас",
    path: "/work/mineral-atlas",
    createdAt: "2026-07-20T10:15:00.000Z",
    updatedAt: "2026-08-02T18:20:00.000Z",
  },
];

function thread(
  id: string,
  title: string,
  state: ThreadSummary["state"],
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    id,
    projectId: "project-nest",
    title,
    preview: "Детерминированное состояние для визуальной проверки интерфейса.",
    cwd: "/work/codex-nest",
    state,
    unread: false,
    unseen: false,
    pinned: false,
    archived: false,
    createdAt: FIXED_NOW - 86_400_000,
    updatedAt: FIXED_NOW - 600_000,
    currentTurnId: null,
    queuedMessageCount: 0,
    settings: {
      collaborationMode: "plan",
      model: "gpt-5.6-codex",
      reasoningEffort: "high",
      personality: "pragmatic",
    },
    relation: { kind: "session", sessionId: id },
    ...overrides,
  };
}

export const mainThread = thread("session-main", "Полировка мастерской", "completed", {
  pinned: true,
  settings: {
    collaborationMode: "team",
    model: "gpt-5.6-codex",
    reasoningEffort: "high",
    personality: "pragmatic",
  },
});

export const attentionThread = thread(
  "session-attention",
  "Выбор материала панели",
  "needsAttention",
  {
    unread: true,
    currentTurnId: "turn-attention",
    updatedAt: FIXED_NOW - 120_000,
  },
);

const threads: ThreadSummary[] = [
  thread("session-active", "Сверка токенов темы", "running", {
    currentTurnId: "turn-active",
    unread: true,
    updatedAt: FIXED_NOW - 30_000,
  }),
  attentionThread,
  thread("session-queued", "Очередь мобильных правок", "queued", {
    queuedMessageCount: 2,
    updatedAt: FIXED_NOW - 300_000,
  }),
  mainThread,
  thread("session-complete", "Проверка контрастности", "completed", {
    projectId: "project-mineral",
    cwd: "/work/mineral-atlas",
    updatedAt: FIXED_NOW - 3_600_000,
  }),
  thread("session-child", "Аудит диалогов", "completed", {
    preview: "Ветка Team: проверены фокус, Escape и возврат к вызывающему элементу.",
    relation: {
      kind: "subagent",
      sessionId: "session-main",
      parentThreadId: "session-main",
      nickname: "Кварц",
      role: "accessibility",
    },
    updatedAt: FIXED_NOW - 420_000,
  }),
];

const forkThreads: ThreadSummary[] = [
  thread("session-fork-active", "Проверка активной ветки", "needsAttention", {
    relation: {
      kind: "session",
      sessionId: "session-fork-tree",
      forkedFromId: mainThread.id,
    },
    updatedAt: FIXED_NOW - 20_000,
  }),
  thread("session-fork-queued", "Очередь альтернативы", "queued", {
    relation: {
      kind: "session",
      sessionId: "session-fork-tree",
      forkedFromId: mainThread.id,
    },
    updatedAt: FIXED_NOW - 40_000,
  }),
  thread("session-fork-archived", "Архивная гипотеза", "completed", {
    archived: true,
    relation: {
      kind: "session",
      sessionId: "session-fork-tree",
      forkedFromId: mainThread.id,
    },
    updatedAt: FIXED_NOW - 10_000,
  }),
  thread("session-fork-grandchild", "Уточнение активной ветки", "running", {
    currentTurnId: "turn-fork-grandchild",
    relation: {
      kind: "session",
      sessionId: "session-fork-tree",
      forkedFromId: "session-fork-active",
    },
    updatedAt: FIXED_NOW - 5_000,
  }),
];

const mainDetail: ThreadDetail = {
  summary: mainThread,
  olderTurnsCursor: null,
  queuedMessages: [],
  draft: {
    input: "Добавить короткую подпись к итоговой проверке",
    images: [],
    goalMode: false,
    annotations: [],
    updatedAt: FIXED_NOW - 90_000,
  },
  turns: [
    {
      id: "turn-main",
      status: "completed",
      startedAt: FIXED_NOW - 780_000,
      completedAt: FIXED_NOW - 600_000,
      durationMs: 180_000,
      progress: {
        startedAt: FIXED_NOW - 780_000,
        explanation: "Проверяю визуальную систему и интерактивные состояния.",
        steps: [
          { step: "Сверить токены светлой и тёмной тем", status: "completed" },
          { step: "Проверить адаптивный композер", status: "completed" },
          { step: "Зафиксировать результат", status: "completed" },
        ],
        filesChanged: 3,
        additions: 148,
        deletions: 37,
      },
      items: [
        {
          type: "userMessage",
          id: "message-user",
          status: "completed",
          text: "Проверь редизайн как точную рабочую мастерскую: свет, минералы и ясная иерархия.",
          images: [],
          timestamp: FIXED_NOW - 780_000,
          phase: null,
        },
        {
          type: "reasoning",
          id: "message-reasoning",
          status: "completed",
          text: "Сначала сопоставлю семантические поверхности, затем проверю мобильные действия.",
          images: [],
          timestamp: FIXED_NOW - 760_000,
          phase: "commentary",
        },
        {
          type: "plan",
          id: "message-plan",
          status: "completed",
          text: "1. Сверить токены\n2. Проверить асимметрию диалога\n3. Зафиксировать доступность",
          images: [],
          timestamp: FIXED_NOW - 740_000,
          phase: "commentary",
        },
        {
          type: "planChecklist",
          id: "plan-progress",
          status: "completed",
          explanation: "Все контрольные точки пройдены.",
          steps: [
            { step: "Тема и поверхности", status: "completed" },
            { step: "Композер и activity rail", status: "completed" },
          ],
          timestamp: FIXED_NOW - 680_000,
          afterItemId: "message-plan",
        },
        {
          type: "command",
          id: "command-check",
          status: "completed",
          kind: "command",
          command: "npm test -- --runInBand",
          cwd: "/work/codex-nest/apps/client",
          output: "42 tests passed",
          exitCode: 0,
        },
        {
          type: "fileChange",
          id: "file-change",
          status: "completed",
          path: "apps/client/src/styles/tokens.css",
          patch: "+ --color-mineral: #607d8b;",
        },
        {
          type: "tool",
          id: "tool-browser",
          status: "completed",
          title: "Проверен интерфейс в браузере",
          detail: "Desktop и mobile состояния стабильны.",
        },
        {
          type: "agentMessage",
          id: "message-agent",
          status: "completed",
          text: "Готово. Контраст выровнен, transcript сохранил семантическую асимметрию, а действия на телефоне имеют безопасную область касания.",
          images: [],
          timestamp: FIXED_NOW - 600_000,
          phase: "final_answer",
        },
      ],
    },
  ],
};

const attentionDetail: ThreadDetail = {
  summary: attentionThread,
  olderTurnsCursor: null,
  queuedMessages: [
    {
      id: "queued-note",
      threadId: attentionThread.id,
      text: "После решения обновить мобильную памятку.",
      createdAt: FIXED_NOW - 100_000,
      status: "queued",
    },
  ],
  draft: null,
  turns: [
    {
      id: "turn-attention",
      status: "inProgress",
      startedAt: FIXED_NOW - 240_000,
      completedAt: null,
      durationMs: null,
      progress: {
        startedAt: FIXED_NOW - 240_000,
        explanation: "Ожидаю выбор владельца продукта.",
        steps: [
          { step: "Выбрать материал панели", status: "inProgress" },
          { step: "Применить токены", status: "pending" },
        ],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
      items: [
        {
          type: "userMessage",
          id: "attention-user",
          status: "completed",
          text: "Подготовь два спокойных варианта панели для телефона.",
          images: [],
          timestamp: FIXED_NOW - 240_000,
          phase: null,
        },
        {
          type: "agentMessage",
          id: "attention-agent",
          status: "completed",
          text: "Варианты готовы. Нужен выбор направления перед финальной полировкой.",
          images: [],
          timestamp: FIXED_NOW - 180_000,
          phase: "commentary",
        },
      ],
    },
  ],
};

export const snapshot: AppSnapshot = {
  sequence: 24,
  uiLanguage: "ru",
  connection: {
    state: "ready",
    message: null,
    syncedAt: "2026-08-03T11:59:00.000Z",
  },
  projects,
  threads,
  forkOperations: [],
  attention: [
    {
      id: "attention-material",
      threadId: attentionThread.id,
      turnId: "turn-attention",
      itemId: null,
      createdAt: FIXED_NOW - 120_000,
      kind: "userInput",
      autoResolutionMs: null,
      questions: [
        {
          id: "material",
          header: "Материал",
          question: "Какую поверхность использовать для мобильной панели?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Светлый известняк", description: "Мягкий фон и графитовая типографика." },
            { label: "Тёмный сланец", description: "Глубокий фон и холодные минеральные акценты." },
          ],
        },
      ],
    },
  ],
  models: [
    {
      id: "gpt-5.6-codex",
      displayName: "GPT-5.6 Codex",
      description: "Точная инженерная работа",
      isDefault: true,
      reasoningEfforts: [
        { value: "medium", description: "Сбалансировано", isDefault: false },
        { value: "high", description: "Глубокая проверка", isDefault: true },
      ],
      serviceTiers: [],
      supportsPersonality: true,
    },
  ],
  defaultReasoningEffort: "high",
  taskDefaults: { personality: "pragmatic" },
  voiceTranscriptions: [],
};

const forkSnapshot: AppSnapshot = {
  ...snapshot,
  threads: [...snapshot.threads, ...forkThreads],
};

const transcriptionConfig: TranscriptionConfigResponse = {
  providers: ["local", "openai"],
  provider: "local",
  localUrl: "http://127.0.0.1:8178/inference",
  openAiApiKeyConfigured: true,
  openAiModel: "gpt-4o-transcribe",
  language: "ru",
  refineLocal: true,
  refinementModel: "gpt-5.6-codex",
  maxRecordingSeconds: 300,
  maxUploadBytes: 24 * 1024 * 1024,
  timingEstimate: {
    sampleCount: 8,
    estimatedFixedProcessingMs: 720,
    estimatedProcessingMsPerAudioSecond: 180,
  },
};

const appStatus: AppUpdateStatus = {
  supported: true,
  canUpdateWithActiveTurns: false,
  currentVersion: "0.1.6",
  latestVersion: "0.1.6",
  updateAvailable: false,
  operation: "idle",
  result: "none",
  message: null,
  checkedAt: "2026-08-03T11:45:00.000Z",
  updatedAt: null,
};

const codexStatus: CodexManagementStatus = {
  supported: true,
  unavailableReason: null,
  operation: "idle",
  activeTurnCount: 1,
  daemonStatus: "running",
  cliVersion: "0.144.6",
  appServerVersion: "0.144.6",
  latestVersion: "0.144.6",
  updateAvailable: false,
  networkStatus: "ok",
  networkMessage: null,
  proxy: {
    configured: true,
    protocol: "https",
    host: "proxy.example",
    port: 8443,
    username: "workshop",
    hasPassword: true,
    error: null,
  },
};

export type VisualFixtureOptions = {
  snapshot?: AppSnapshot;
  connected?: boolean;
  finishableSidebar?: boolean;
  forkEstimate?: "ready" | "loading" | "failure" | "unavailable";
  forkLineage?: boolean;
  notificationPrompt?: boolean;
  preserveLocalStorage?: boolean;
  reducedMotion?: "reduce" | "no-preference";
  sidebarSide?: "left" | "right";
  theme: "light" | "dark";
  voiceFailure?: boolean;
};

export async function installVisualFixture(
  page: Page,
  {
    connected = true,
    finishableSidebar = false,
    forkEstimate = "ready",
    forkLineage = false,
    notificationPrompt = false,
    preserveLocalStorage = false,
    reducedMotion = "reduce",
    sidebarSide = "left",
    snapshot: suppliedSnapshot,
    theme,
    voiceFailure = false,
  }: VisualFixtureOptions,
): Promise<void> {
  const baseSnapshot = suppliedSnapshot ?? (forkLineage ? forkSnapshot : snapshot);
  const sidebarSnapshot: AppSnapshot = finishableSidebar
    ? {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((candidate) =>
          candidate.id === mainThread.id ? { ...candidate, unread: true } : candidate,
        ),
      }
    : baseSnapshot;
  const fixtureSnapshot: AppSnapshot = voiceFailure
    ? {
        ...sidebarSnapshot,
        voiceTranscriptions: [
          {
            id: "voice-no-speech",
            threadId: mainThread.id,
            mode: "send",
            status: "failed",
            createdAt: FIXED_NOW - 30_000,
            startedAt: FIXED_NOW - 29_000,
            audioDurationMs: 10_680,
            estimatedTotalSeconds: 8,
            error: "No speech was detected in the recording",
          },
        ],
      }
    : sidebarSnapshot;
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
  await page.addInitScript(
    ({
      connected: seedConnection,
      disableMotion,
      fixedNow,
      notificationPrompt: showPrompt,
      preserveLocalStorage: keepLocalStorage,
      serverOrigin,
      sidebarSide: seededSidebarSide,
      theme: seededTheme,
      token,
    }) => {
      Date.now = () => fixedNow;
      try {
        if (!keepLocalStorage) localStorage.clear();
        localStorage.setItem("codexnest.theme", seededTheme);
        localStorage.setItem("codexnest.uiLanguage", "ru");
        localStorage.setItem("codexnest.layoutDefaultsVersion", "1");
        localStorage.setItem("codexnest.sidebarSide", seededSidebarSide);
        localStorage.setItem("codexnest.projectListDirection", "top-down");
        localStorage.setItem("codexnest.sessionListMode", "projects");
        if (seedConnection) {
          localStorage.setItem("codexnest.serverUrl", serverOrigin);
          localStorage.setItem("codexnest.token", token);
        }
        if (!showPrompt) {
          localStorage.setItem("codexnest.notificationPromptDismissed", "true");
        }
      } catch {
        // The init script also runs in the initial opaque document.
      }

      class VisualNotification {
        static permission: NotificationPermission = showPrompt ? "default" : "denied";
        static requestPermission = async (): Promise<NotificationPermission> =>
          VisualNotification.permission;
      }
      try {
        Object.defineProperty(window, "Notification", {
          configurable: true,
          value: VisualNotification,
        });
      } catch {
        // WebKit can expose a non-configurable Notification constructor.
      }

      const reduceMotion = () => {
        const style = document.createElement("style");
        style.dataset.visualTestMotion = "true";
        style.textContent =
          "*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;transition-delay:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}";
        document.head.append(style);
      };
      if (disableMotion) {
        if (document.head) reduceMotion();
        else document.addEventListener("DOMContentLoaded", reduceMotion, { once: true });
      }
    },
    {
      connected,
      disableMotion: reducedMotion === "reduce",
      fixedNow: FIXED_NOW,
      notificationPrompt,
      preserveLocalStorage,
      serverOrigin: SERVER_ORIGIN,
      sidebarSide,
      theme,
      token: TOKEN,
    },
  );

  await page.route(`${SERVER_ORIGIN}/api/v1/**`, (route) =>
    mockHttpRoute(route, fixtureSnapshot, forkEstimate),
  );
  await page.route(`${SERVER_ORIGIN}/downloads/**`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
      body: MARKDOWN_ARTIFACT,
    }),
  );
  await page.routeWebSocket(
    `${SERVER_ORIGIN.replace("https://", "wss://")}/api/v1/events`,
    (ws) => {
      ws.onMessage((message) => {
        const frame = JSON.parse(typeof message === "string" ? message : message.toString()) as {
          type?: string;
        };
        if (frame.type === "authenticate") {
          ws.send(JSON.stringify({ type: "snapshot", snapshot: fixtureSnapshot }));
        } else if (frame.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      });
    },
  );
}

export async function waitForVisualReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

function detailFor(id: string, fixtureSnapshot: AppSnapshot): ThreadDetail {
  const summary = fixtureSnapshot.threads.find((candidate) => candidate.id === id);
  if (!summary) throw new Error(`Unknown fixture thread: ${id}`);
  if (id === mainThread.id) return { ...mainDetail, summary };
  if (id === attentionThread.id) return { ...attentionDetail, summary };
  return { summary, turns: [], queuedMessages: [], olderTurnsCursor: null, draft: null };
}

async function mockHttpRoute(
  route: Route,
  fixtureSnapshot: AppSnapshot,
  forkEstimate: NonNullable<VisualFixtureOptions["forkEstimate"]>,
): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  const corsHeaders = {
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-origin": "*",
  };
  const json = (body: unknown, status = 200) =>
    route.fulfill({
      status,
      headers: { ...corsHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const empty = () => route.fulfill({ status: 204, headers: corsHeaders });

  if (method === "OPTIONS") return empty();
  if (path === "/api/v1/health") {
    return json({
      status: "ok",
      serverVersion: "0.1.6",
      recoveryState: "ready",
      restartProtocolVersion: 1,
      transport: "daemon",
      appServer: { state: "ready", installedVersion: "0.144.6", message: null },
    });
  }
  if (path === "/api/v1/summary") {
    return json({
      threadCount: fixtureSnapshot.threads.length,
      projectCount: fixtureSnapshot.projects.length,
      pendingAttentionCount: fixtureSnapshot.attention.length,
      syncedAt: fixtureSnapshot.connection.syncedAt,
    });
  }
  if (path === "/api/v1/transcriptions/config") return json(transcriptionConfig);
  if (path === "/api/v1/codex/rate-limits") {
    return json({
      primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: FIXED_NOW + 7_200_000 },
      secondary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: FIXED_NOW + 345_600_000 },
    });
  }
  if (path === "/api/v1/settings/app" || path === "/api/v1/settings/app/check") {
    return json(appStatus);
  }
  if (path === "/api/v1/settings/codex") return json(codexStatus);
  if (path === "/api/v1/settings/codex/accounts")
    return json({ currentAccountId: null, accounts: [] });
  if (path === "/api/v1/settings/permissions") {
    return json({ preset: "auto", version: "visual-v1", overridden: false, message: null });
  }
  if (path === "/api/v1/settings/task-defaults" && method === "PUT") return json(body ?? {});
  if (path === "/api/v1/directories") {
    return json({
      rootPath: "/home/codex",
      path: "/home/codex/workspaces",
      parentPath: "/home/codex",
      directories: [
        { name: "codex-nest", path: "/home/codex/workspaces/codex-nest" },
        { name: "mineral-atlas", path: "/home/codex/workspaces/mineral-atlas" },
      ],
    });
  }

  if (/^\/api\/v1\/threads\/[^/]+\/fork-estimate$/u.test(path) && method === "POST") {
    if (forkEstimate === "loading") return;
    if (forkEstimate === "failure")
      return json({ error: { code: "estimate_failed", message: "Estimate unavailable" } }, 500);
    return json({
      sourceBytes: 987_654_321_012,
      compressed:
        forkEstimate === "unavailable"
          ? {
              available: false,
              estimatedBytes: null,
              estimatedSeconds: null,
              unavailableReason:
                "Для этой очень длинной истории пока недостаточно надёжных данных для безопасного сжатия",
            }
          : {
              available: true,
              estimatedBytes: null,
              estimatedSeconds: { minSeconds: 60, maxSeconds: 600 },
              unavailableReason: null,
            },
      exact: {
        available: true,
        estimatedBytes: 987_654_321_012,
        estimatedSeconds: { minSeconds: 185, maxSeconds: 425 },
        unavailableReason: null,
      },
    });
  }

  const threadMatch = path.match(/^\/api\/v1\/threads\/([^/]+)$/u);
  if (threadMatch && method === "GET") {
    return json(detailFor(decodeURIComponent(threadMatch[1]!), fixtureSnapshot));
  }
  if (/^\/api\/v1\/threads\/[^/]+\/(read|viewed)$/u.test(path)) return empty();
  if (/^\/api\/v1\/threads\/[^/]+\/goal$/u.test(path) && method === "GET") return json(null);
  if (/^\/api\/v1\/threads\/[^/]+\/git-changes$/u.test(path)) {
    return json({ state: "dirty", filesChanged: 3, additions: 148, deletions: 37 });
  }
  if (/^\/api\/v1\/threads\/[^/]+\/downloads$/u.test(path) && method === "POST") {
    return json({
      downloadUrl: "/downloads/visual-audit.md",
      expiresAt: FIXED_NOW + 60_000,
      fileName: "visual-audit.md",
      size: new TextEncoder().encode(MARKDOWN_ARTIFACT).byteLength,
    });
  }
  if (/^\/api\/v1\/threads\/[^/]+\/artifacts$/u.test(path)) {
    return json({
      capability: "explicit",
      artifacts: [
        {
          id: "artifact-report",
          label: "Отчёт о визуальной проверке",
          path: "/work/codex-nest/reports/visual-audit.md",
          relativePath: "reports/visual-audit.md",
          fileName: "visual-audit.md",
          turnId: "turn-main",
          createdAt: FIXED_NOW - 590_000,
        },
      ],
    });
  }

  return json(
    { error: { code: "not_found", message: `Unmocked visual-test API: ${method} ${path}` } },
    501,
  );
}
