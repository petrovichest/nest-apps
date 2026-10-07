import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";

import { DEFAULT_SESSION_SETTINGS } from "@codexnest/protocol";
import type {
  ActivityItem,
  AttentionRequest,
  ModelOption,
  QueuedMessage,
  ThreadDetail,
  ThreadDraft,
  ThreadSummary,
  TranscriptionConfigResponse,
  TurnProgress,
  UpdateThreadDraftRequest,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";

import { annotationStorageKey, type PendingAnnotation } from "../annotations";
import { ApiClientError } from "../api";
import type { ForkOperationSummary } from "../forks";
import type { OptimisticMessage } from "../state";
import { Activity, ThreadPage, formatMessageTime, initialSessionSettings } from "./ThreadPage";

const connection = vi.hoisted(() => vi.fn());
const loadLocalDraft = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const openDownloadUrl = vi.hoisted(() => vi.fn());
const deleteLocalDraft = vi.hoisted(() =>
  vi.fn<(settings: unknown, threadId: string) => Promise<void>>(() => Promise.resolve()),
);
const saveLocalDraft = vi.hoisted(() =>
  vi.fn(
    async (
      _settings: unknown,
      threadId: string,
      value: UpdateThreadDraftRequest,
      updatedAt = Date.now(),
    ) => ({ key: threadId, connectionKey: "test", threadId, value, updatedAt }),
  ),
);
const acknowledgePendingThread = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const releaseActiveThread = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../downloads", () => ({ openDownloadUrl }));
vi.mock("../push", () => ({ acknowledgePendingThread, releaseActiveThread }));
vi.mock("../offline-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteLocalDraft,
  saveLocalDraft,
  loadLocalDraft,
}));

const summary: ThreadSummary = {
  id: "thread",
  relation: { kind: "session", sessionId: "session" },
  projectId: "project",
  title: "Тестовая задача",
  preview: "",
  cwd: "/work/project",
  state: "idle",
  unread: false,
  unseen: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  currentTurnId: null,
  queuedMessageCount: 0,
  browserStatus: "disabled",
  settings: { collaborationMode: "default" },
};

beforeEach(() => {
  vi.clearAllMocks();
  loadLocalDraft.mockReset().mockResolvedValue(null);
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("model capacity waiting", () => {
  it("counts down on the server's retry and offers Stop without an active turn", async () => {
    vi.useFakeTimers();
    try {
      const api = threadApi();
      const waiting: ThreadSummary = {
        ...summary,
        state: "running",
        currentTurnId: null,
        capacityRetry: { failedTurnId: "failed", nextAttemptAt: Date.now() + 300_000 },
      };
      mockThreadConnection(api, waiting, {
        turns: [
          {
            id: "failed",
            status: "failed",
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
            progress: progress(),
            items: [
              {
                type: "error",
                id: "error",
                status: "failed",
                message: "Selected model is at capacity. Please try a different model.",
              },
            ],
          },
        ],
      });
      const view = renderThread();
      expect(
        screen.getByText(
          "Возникла ошибка перегрузки модели. Продолжаем попытки — следующая через 5м 0с",
        ),
      ).toBeVisible();
      expect(
        screen.queryByText("Selected model is at capacity. Please try a different model."),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/^Ошибка через/)).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1_000));
      expect(
        screen.getByText(
          "Возникла ошибка перегрузки модели. Продолжаем попытки — следующая через 4м 59с",
        ),
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Остановить задачу" }));
      await act(async () => {});
      expect(api.interrupt).toHaveBeenCalledWith("thread", undefined);
      expect(api.startTurn).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["inProgress", "completed"] as const)(
    "keeps previous capacity failures neutral while the next turn is %s",
    (status) => {
      mockThreadConnection(
        threadApi(),
        {
          ...summary,
          state: status === "inProgress" ? "running" : "completed",
          currentTurnId: status === "inProgress" ? "next" : null,
        },
        {
          turns: [
            {
              id: "failed",
              status: "failed",
              failureKind: "modelCapacity",
              startedAt: 1,
              completedAt: 2,
              durationMs: 1,
              progress: progress(),
              items: [
                {
                  type: "error",
                  id: "error",
                  status: "failed",
                  failureKind: "modelCapacity",
                  message: "Selected model is at capacity.",
                },
              ],
            },
            {
              id: "next",
              status,
              startedAt: 3,
              completedAt: status === "completed" ? 4 : null,
              durationMs: null,
              progress: progress(),
              items: [],
            },
          ],
        },
      );
      const view = renderThread();
      expect(screen.getByText("Перегрузка модели")).toBeVisible();
      expect(screen.queryByText(/^Ошибка через/)).not.toBeInTheDocument();
      expect(view.container.querySelector(".turn-activity-state-failed")).toBeNull();
      expect(screen.queryByText("Selected model is at capacity.")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Технические детали" }));
      expect(screen.getByText("Selected model is at capacity.").closest("article")).toHaveClass(
        "activity-capacity",
      );
    },
  );

  it("shows a live overload neutrally before the turn completes", () => {
    mockThreadConnection(
      threadApi(),
      { ...summary, state: "running", currentTurnId: "live" },
      {
        turns: [
          {
            id: "live",
            status: "inProgress",
            startedAt: 1,
            completedAt: null,
            durationMs: null,
            progress: progress(),
            items: [
              {
                type: "error",
                id: "live-error",
                status: "failed",
                failureKind: "modelCapacity",
                message: "Selected model is at capacity.",
              },
            ],
          },
        ],
      },
    );
    const view = renderThread();
    expect(
      screen.getByText("Возникла ошибка перегрузки модели. Продолжаем попытки…"),
    ).toBeVisible();
    expect(screen.queryByText("Selected model is at capacity.")).not.toBeInTheDocument();
    expect(view.container.querySelector(".turn-activity-state-failed")).toBeNull();
  });
});

describe("initialSessionSettings", () => {
  const taskDefaults = { serviceTier: "fast", personality: "friendly" };

  it("keeps Fast off when model metadata is missing", () => {
    expect(initialSessionSettings("high", [], taskDefaults)).toEqual({
      ...DEFAULT_SESSION_SETTINGS,
      reasoningEffort: "high",
      personality: "friendly",
    });
  });

  it.each(["fast", "priority"])("inherits Fast for a model advertising %s", (tier) => {
    const model: ModelOption = {
      id: "gpt",
      displayName: "GPT",
      description: "",
      isDefault: true,
      reasoningEfforts: [],
      serviceTiers: [{ id: tier, displayName: "Fast" }],
      supportsPersonality: false,
    };
    expect(initialSessionSettings(undefined, [model], { serviceTier: tier })).toEqual({
      ...DEFAULT_SESSION_SETTINGS,
      serviceTier: "fast",
    });
    expect(initialSessionSettings(undefined, [model], { serviceTier: "legacy-tier" })).toEqual(
      DEFAULT_SESSION_SETTINGS,
    );
    expect(initialSessionSettings(undefined, [model], {})).toEqual(DEFAULT_SESSION_SETTINGS);
  });

  it("falls back from a stale model without carrying unsupported dependent defaults", () => {
    const staleModel: ModelOption = {
      id: "gpt",
      displayName: "GPT",
      description: "",
      isDefault: true,
      reasoningEfforts: [{ value: "low", description: null, isDefault: true }],
      serviceTiers: [],
      supportsPersonality: false,
    };

    expect(
      initialSessionSettings("high", [staleModel], { model: "retired", ...taskDefaults }),
    ).toEqual(DEFAULT_SESSION_SETTINGS);
  });

  it("uses the selected default model when it is available", () => {
    const model: ModelOption = {
      id: "gpt",
      displayName: "GPT",
      description: "",
      isDefault: true,
      reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
      serviceTiers: [],
      supportsPersonality: false,
    };

    expect(initialSessionSettings("high", [model], { model: "gpt" })).toEqual({
      ...DEFAULT_SESSION_SETTINGS,
      model: "gpt",
      reasoningEffort: "high",
    });
  });
});

describe("Activity", () => {
  it("sends pasted context with annotations and restores the complete draft after rejection", async () => {
    const api = threadApi();
    const pasteBlocks = [{ id: "log", text: "# Log\n42" }];
    const inlinePastes = [{ id: "short", start: 2, end: 7 }];
    const annotation = pendingAnnotation();
    const context = mockThreadConnection(api, summary, {
      turns: [completedAgentTurn()],
      draft: {
        input: "  pasted  ",
        inlinePastes,
        pasteBlocks,
        images: [],
        goalMode: false,
        annotations: [annotation],
        updatedAt: 10,
      },
    });
    context.sendReliable.mockRejectedValueOnce(new Error("Rejected pasted message"));
    renderThread();
    expect(document.querySelectorAll(".composer .paste-blocks .paste-card")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
    const body = context.sendReliable.mock.calls[0]![1];
    expect(body).toMatchObject({ inlinePastes: [{ id: "short", start: 0, end: 5 }], pasteBlocks });
    expect(body.input).toContain(annotation.comment);
    await screen.findByText("Rejected pasted message");
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("  pasted  ");
    expect(document.querySelectorAll(".composer .paste-blocks .paste-card")).toHaveLength(1);
    expect(document.querySelector(".composer mark")?.textContent).toBe("paste");
  });

  it("preserves an async form across item renumbering and separates repeated questions", async () => {
    const question: ActivityItem = {
      type: "agentMessage",
      id: "live-question",
      questionKey: "same-questions",
      text: "",
      questions: [{ title: "Как проверять?", options: ["Быстро", "Подробно"] }],
      delivery: "async",
      status: "completed",
      images: [],
      timestamp: 1,
      phase: "commentary",
    };
    const turn = {
      ...completedAgentTurn(),
      items: [question, { ...question, id: "second-question" }],
    };
    const context = mockThreadConnection(threadApi(), summary, { turns: [turn] });
    const view = renderThread();
    const cards = screen.getAllByRole("region", { name: "Вопросы Codex" });
    fireEvent.click(within(cards[0]!).getByRole("radio", { name: "Свой ответ" }));
    fireEvent.change(within(cards[0]!).getByRole("textbox"), { target: { value: "Вручную" } });
    context.state.details.thread = {
      ...context.state.details.thread,
      turns: [
        {
          ...turn,
          items: [
            { ...question, id: "item-10" },
            { ...question, id: "item-11" },
          ],
        },
      ],
    };
    view.rerender(threadRoute());
    const refreshed = screen.getAllByRole("region", { name: "Вопросы Codex" });
    expect(within(refreshed[0]!).getByRole("textbox")).toHaveValue("Вручную");
    fireEvent.click(within(refreshed[0]!).getByRole("button", { name: "Ответить" }));
    fireEvent.click(within(refreshed[1]!).getByRole("button", { name: "Ответить" }));
    await waitFor(() => expect(context.sendReliable).toHaveBeenCalledTimes(2));
    expect(context.sendReliable.mock.calls[0]?.[1]).toMatchObject({
      input: "Как проверять?\nВручную",
      replyToAsyncQuestion: { turnId: turn.id, itemId: "item-10" },
    });
    expect(context.sendReliable.mock.calls[0]?.[1].clientMessageId).not.toBe(
      context.sendReliable.mock.calls[1]?.[1].clientMessageId,
    );
  });

  it("renders user and agent messages without legacy labels", () => {
    const { rerender } = render(
      <Activity
        item={{
          type: "userMessage",
          id: "user",
          status: "completed",
          text: "Сообщение",
          images: [],
          timestamp: null,
          phase: null,
        }}
      />,
    );
    expect(screen.getByText("Сообщение").closest("article")).toHaveClass("userMessage");
    const userArticle = screen.getByText("Сообщение").closest("article")!;
    expect(userArticle.querySelector(":scope > .message-body")?.nextElementSibling).toHaveClass(
      "message-footer",
    );
    expect(screen.queryByText("Вы")).not.toBeInTheDocument();

    rerender(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Ответ",
          images: [],
          timestamp: null,
          phase: "final_answer",
        }}
      />,
    );
    expect(screen.getByText("Ответ").closest("article")).toHaveClass("agentMessage");
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();

    rerender(
      <Activity
        item={{
          type: "reasoning",
          id: "reasoning",
          status: "completed",
          text: "Проверяю",
          images: [],
          timestamp: null,
          phase: null,
        }}
      />,
    );
    const reasoningDetails = screen.getByText("Рассуждение").closest("details")!;
    expect(reasoningDetails).toHaveClass("activity-card");
    expect(screen.queryByText("Проверяю")).toBeNull();
    fireEvent.click(reasoningDetails.querySelector("summary")!);
    fireEvent(reasoningDetails, new Event("toggle"));
    expect(screen.getByText("Проверяю")).toBeInTheDocument();
    expect(screen.queryByText("Ход работы")).not.toBeInTheDocument();
  });

  it("stops animating unfinished steps when their checklist is no longer active", () => {
    const item = {
      type: "planChecklist" as const,
      id: "checklist",
      status: "inProgress" as const,
      explanation: "Проверяю",
      steps: [
        { step: "Готово", status: "completed" as const },
        { step: "Остановлено", status: "inProgress" as const },
        { step: "Позже", status: "pending" as const },
      ],
      timestamp: 1,
      afterItemId: null,
    };
    const view = render(<Activity item={item} />);

    expect(screen.getByText("Остановлено").closest("li")).toHaveClass("inProgress");
    expect(view.container.querySelector(".plan-checklist .spinner")).not.toBeNull();

    view.rerender(<Activity item={{ ...item, status: "completed" }} />);

    expect(screen.getByText("Готово").closest("li")).toHaveClass("completed");
    expect(screen.getByText("Остановлено").closest("li")).toHaveClass("pending");
    expect(view.container.querySelector(".plan-checklist .spinner")).toBeNull();
  });

  it("renders GFM tables and task lists", () => {
    const view = render(
      <Activity
        item={{
          type: "agentMessage",
          id: "markdown",
          status: "completed",
          text: "| Поле | Значение |\n| --- | --- |\n| Статус | Готово |\n\n- [x] Проверено",
          images: [],
          timestamp: null,
          phase: "final_answer",
        }}
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Таблица" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("columnheader", { name: "Поле" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "" })).toBeChecked();
    expect(view.container.querySelector(".markdown-table-scroll")).not.toBeNull();
  });

  it("preserves horizontal table scroll while a message is streaming", () => {
    const item = {
      type: "agentMessage" as const,
      id: "streaming-markdown",
      status: "inProgress" as const,
      text: "| Поле | Значение |\n| --- | --- |\n| Статус | Готово |\n\nНачало ответа",
      images: [],
      timestamp: null,
      phase: "commentary" as const,
    };
    const view = render(<Activity item={item} />);
    const tableScroll = view.container.querySelector<HTMLDivElement>(".markdown-table-scroll")!;
    tableScroll.scrollLeft = 180;

    view.rerender(<Activity item={{ ...item, text: `${item.text}\n\nНовый фрагмент` }} />);

    expect(view.container.querySelector(".markdown-table-scroll")).toBe(tableScroll);
    expect(tableScroll.scrollLeft).toBe(180);
  });

  it("renders submitted questions and answers as one user message", () => {
    render(
      <Activity
        item={{
          type: "userInputResponse",
          id: "answers",
          status: "completed",
          entries: [
            { header: "Хранение", question: "Где хранить?", answers: ["На сервере"] },
            { header: "Токен", question: "Какой токен?", answers: ["secret-value"] },
          ],
          timestamp: Date.now(),
          afterItemId: "request",
        }}
      />,
    );

    const article = screen.getByText("Где хранить?").closest("article");
    expect(article).toHaveClass("userMessage", "user-input-response");
    expect(screen.getByText("На сервере")).toBeInTheDocument();
    expect(screen.getByText("secret-value")).toBeInTheDocument();
  });

  it("hides only the trailing recommendation marker while copying the original answers", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const answers = [
      "По сумме продажи (Recommended)",
      "Первая строка\n\nВторая строка",
      "Пометка (Recommended) внутри ответа",
      "(Recommended)",
    ];
    const view = render(
      <Activity
        item={{
          type: "userInputResponse",
          id: "answers",
          status: "completed",
          entries: [{ header: "Тейк-профит", question: "Как фиксировать?", answers }],
          timestamp: Date.now(),
          afterItemId: null,
        }}
      />,
    );

    expect(
      Array.from(view.container.querySelectorAll(".user-input-answer"), (node) => node.textContent),
    ).toEqual(["По сумме продажи", ...answers.slice(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Копировать сообщение" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(["Как фиксировать?", ...answers].join("\n")),
    );
    expect(answers[0]).toBe("По сумме продажи (Recommended)");
  });

  it("renders delivered subagent results as links in the timeline", () => {
    render(
      <MemoryRouter>
        <Activity
          item={{
            type: "orchestrationNotice",
            id: "orchestration",
            status: "completed",
            agents: [
              {
                threadId: "child",
                title: "Проверить интерфейс",
                nickname: "reviewer",
                outcome: "completed",
              },
            ],
            timestamp: Date.now(),
            afterItemId: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Получен результат субагента")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "reviewer · Проверить интерфейс" })).toHaveAttribute(
      "href",
      "/threads/child",
    );
    expect(screen.getByText("Завершена")).toBeInTheDocument();
  });

  it("renders rich subagent results compactly with an accessible status and child link", () => {
    render(
      <MemoryRouter>
        <Activity
          item={{
            type: "orchestrationNotice",
            id: "orchestration-v2",
            status: "completed",
            agents: [
              {
                threadId: "child/v2",
                taskId: "task-v2",
                title: "Проверить интерфейс",
                nickname: "reviewer",
                outcome: "completed",
                result: {
                  outcome: "partial",
                  summary: "Карточка обновлена без отдельной панели.",
                  checks: [
                    { name: "Тесты клиента", outcome: "passed", details: "12 тестов" },
                    { name: "Снимок экрана", outcome: "notRun" },
                  ],
                },
                budgetReason: "tokenBudget",
                failureReason: "Визуальная проверка недоступна.",
                changedPaths: ["apps/client/src/components/ThreadPage.tsx"],
                changedPathCount: 24,
                workspaceIntegrationStatus: "integrated",
              },
            ],
            timestamp: Date.now(),
            afterItemId: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "reviewer · Проверить интерфейс" })).toHaveAttribute(
      "href",
      "/threads/child%2Fv2",
    );
    expect(screen.getByLabelText("Статус результата: Частично")).toHaveTextContent("Частично");
    expect(screen.getByText("Карточка обновлена без отдельной панели.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Проверки результата" })).toHaveTextContent(
      "Тесты клиентаПройдена12 тестовСнимок экранаНе запускалась",
    );
    expect(screen.getByText("Лимит").closest("div")).toHaveTextContent("Исчерпан бюджет токенов");
    expect(screen.getByText("Визуальная проверка недоступна.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Изменённые файлы" })).toHaveTextContent(
      "apps/client/src/components/ThreadPage.tsx",
    );
    expect(screen.getByText("Показано 1 из 24")).toBeInTheDocument();
    expect(screen.getByText("Изменения интегрированы")).toBeInTheDocument();
  });

  it("falls back to the v1 outcome for a malformed partial rich result", () => {
    render(
      <MemoryRouter>
        <Activity
          item={
            {
              type: "orchestrationNotice",
              id: "orchestration-partial-result",
              status: "completed",
              agents: [
                {
                  threadId: "child",
                  title: "Legacy-compatible result",
                  nickname: null,
                  outcome: "completed",
                  result: { summary: "Outcome was omitted." },
                },
              ],
              timestamp: Date.now(),
              afterItemId: null,
            } as ActivityItem
          }
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Статус результата: Завершена")).toHaveTextContent("Завершена");
  });

  it("renders a successful subagent launch as a linked orchestration card", () => {
    render(
      <MemoryRouter>
        <Activity
          item={{
            type: "subagentLaunch",
            id: "launch",
            status: "completed",
            title: "Проверить интерфейс",
            threadId: "child",
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Запущен субагент")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Проверить интерфейс" })).toHaveAttribute(
      "href",
      "/threads/child",
    );
    expect(screen.getByText("Запущен субагент").closest("article")).toHaveClass(
      "orchestration-notice",
    );
  });

  it("renders pending and failed subagent launches without broken links", () => {
    const view = render(
      <MemoryRouter>
        <Activity
          item={{
            type: "subagentLaunch",
            id: "launch",
            status: "inProgress",
            title: "Проверить интерфейс",
            threadId: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Запуск субагента")).toBeInTheDocument();
    expect(screen.getByText("Выполняется")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <Activity
          item={{
            type: "subagentLaunch",
            id: "launch",
            status: "failed",
            title: "Проверить интерфейс",
            threadId: null,
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Не удалось запустить субагента")).toBeInTheDocument();
    expect(screen.getByText("Ошибка")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("groups native launches and updates child status from the snapshot without fetching children", () => {
    const api = threadApi();
    const launches: ActivityItem[] = ["first", "second"].map((id) => ({
      type: "subagentLaunch",
      id,
      source: "codex",
      status: "completed",
      title: id,
      threadId: `child-${id}`,
      agentPath: `/root/${id}`,
      timestamp: 1_000,
    }));
    const context = mockThreadConnection(api, summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: launches,
        },
      ],
    });
    const child: ThreadSummary = {
      ...summary,
      id: "child-first",
      title: "Проверить интерфейс",
      state: "running",
      relation: {
        kind: "subagent",
        sessionId: "child-first",
        parentThreadId: "thread",
        nickname: "Hubble",
        role: "worker",
      },
      codexSettings: { model: "native-model", reasoningEffort: "ultra" },
      settings: { collaborationMode: "default", model: "incorrect-default" },
    };
    context.state.snapshot.threads.push(child);
    const view = renderThread();
    const card = view.container.querySelector(".native-subagent-launches")!;
    expect(view.container.querySelectorAll(".native-subagent-launches")).toHaveLength(1);
    expect(within(card as HTMLElement).getByText("Запущены 2 субагента")).toBeVisible();
    const toggle = within(card as HTMLElement).getByRole("button", { name: "Показать субагентов" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(card as HTMLElement).queryByRole("link")).not.toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("1 работает")).toBeVisible();
    fireEvent.click(toggle);
    expect(screen.getByText("Hubble · native-model · Ultra")).toBeVisible();
    expect(screen.queryByText(/incorrect-default/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Статус субагента: Работает")).toBeVisible();
    expect(screen.getByLabelText("Статус субагента: Запущен")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Открыть диалог субагента: Проверить интерфейс" }),
    ).toHaveAttribute("href", "/threads/child-first");
    expect(screen.queryByText(/Нажмите на задачу/)).not.toBeInTheDocument();
    context.state.snapshot.threads = context.state.snapshot.threads.map((thread) =>
      thread.id === child.id ? { ...thread, state: "completed" } : thread,
    );
    view.rerender(threadRoute());
    expect(screen.getByLabelText("Статус субагента: Готово")).toBeVisible();
    expect(screen.queryByLabelText("Статус субагента: Работает")).not.toBeInTheDocument();
    expect(context.refreshDetail).not.toHaveBeenCalledWith("child-first");
    expect(context.loadTurnItems).not.toHaveBeenCalled();
  });

  it.each(["default", "team"] as const)(
    "keeps %s agents visible without loaded launch history and dismisses their list without stopping the task",
    (collaborationMode) => {
      const api = threadApi();
      const context = mockThreadConnection(
        api,
        {
          ...summary,
          state: "running",
          currentTurnId: "active-turn",
          settings: { collaborationMode },
        },
        { olderTurnsCursor: "unloaded-launches" },
      );
      const child = (
        id: string,
        state: ThreadSummary["state"],
        parentThreadId = "thread",
      ): ThreadSummary => ({
        ...summary,
        id,
        title: `Задача ${id}`,
        state,
        relation: { kind: "subagent", sessionId: id, parentThreadId, nickname: id, role: "worker" },
        codexSettings: { model: "gpt", reasoningEffort: "ultra" },
        settings: { collaborationMode: "default", model: "incorrect-default" },
      });
      const children = [
        child("Hubble", "running"),
        child("Mencius", "queued"),
        child("Carson", "needsAttention"),
        child("ready", "completed"),
      ];
      context.state.snapshot.threads.push(
        ...children,
        child("unrelated", "running", "other"),
        child("nested", "running", "Hubble"),
        { ...child("archived", "running"), archived: true },
      );
      const view = renderThread();
      const bar = view.container.querySelector(".subagent-activity") as HTMLElement;
      expect(bar.closest(".conversation-scroll")).toBeNull();
      expect(within(bar).getByRole("status")).toHaveTextContent(
        "1 агент работает · В очереди: 1 · Требуется внимание: 1",
      );
      const toggle = within(bar).getByRole("button", { name: "Показать субагентов" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(within(bar).queryByRole("link")).not.toBeInTheDocument();
      fireEvent.click(toggle);
      expect(within(bar).getAllByRole("link")).toHaveLength(4);
      expect(within(bar).getByText("Hubble · GPT · Ultra")).toBeVisible();
      expect(within(bar).getByLabelText("Статус субагента: Готово")).toBeVisible();
      expect(within(bar).queryByText(/incorrect-default|unrelated|nested|archived/)).toBeNull();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveFocus();
      expect(api.interrupt).not.toHaveBeenCalled();
      expect(api.startTurn).not.toHaveBeenCalled();
      context.state.snapshot.threads = context.state.snapshot.threads.map((thread) =>
        thread.id === "Hubble" ? { ...thread, title: "Без названия" } : thread,
      );
      view.rerender(threadRoute());
      fireEvent.click(toggle);
      expect(
        within(bar).getByRole("link", { name: "Открыть диалог субагента: Hubble" }),
      ).toBeVisible();
      fireEvent.keyDown(window, { key: "Escape" });
      context.state.details.thread.turns = [
        {
          id: "unloaded-launches",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "subagentLaunch",
              source: "codex",
              id: "launch-Hubble",
              status: "completed",
              title: "Проверить интерфейс",
              threadId: "Hubble",
            },
          ],
        },
      ];
      view.rerender(threadRoute());
      fireEvent.click(toggle);
      expect(
        within(bar).getByRole("link", { name: "Открыть диалог субагента: Проверить интерфейс" }),
      ).toBeVisible();
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.click(toggle);
      fireEvent.pointerDown(screen.getByRole("textbox", { name: "Направить текущую задачу" }));
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      context.state.snapshot.threads = context.state.snapshot.threads.map((thread) =>
        children.some((entry) => entry.id === thread.id)
          ? { ...thread, state: "completed" }
          : thread,
      );
      view.rerender(threadRoute());
      expect(view.container.querySelector(".subagent-activity")).toBeNull();
      context.state.snapshot.threads = context.state.snapshot.threads.map((thread) =>
        thread.id === "Hubble" ? { ...thread, state: "running" } : thread,
      );
      view.rerender(threadRoute());
      expect(view.container.querySelector(".subagent-activity-toggle")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      for (const entry of children)
        expect(context.refreshDetail).not.toHaveBeenCalledWith(entry.id);
      expect(context.loadTurnItems).not.toHaveBeenCalled();
    },
  );

  it("keeps native launch groups on their side of intervening messages", () => {
    const launch = (id: string): ActivityItem => ({
      type: "subagentLaunch",
      source: "codex",
      id,
      title: id,
      threadId: id,
      status: "completed",
    });
    const context = mockThreadConnection(threadApi(), summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            launch("first"),
            {
              type: "agentMessage",
              id: "between",
              status: "completed",
              text: "Продолжим исследование",
              timestamp: 1,
              phase: "commentary",
              images: [],
            },
            launch("second"),
          ],
        },
      ],
    });
    const view = renderThread();
    expect(view.container.querySelectorAll(".native-subagent-launches")).toHaveLength(2);
    expect(context.loadTurnItems).not.toHaveBeenCalled();
  });

  it("shows nested native launches in the read-only child transcript", () => {
    const child: ThreadSummary = {
      ...summary,
      relation: {
        kind: "subagent",
        sessionId: "thread",
        parentThreadId: "parent",
        nickname: "Hubble",
        role: "worker",
      },
    };
    mockThreadConnection(threadApi(), child, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "subagentLaunch",
              source: "codex",
              id: "launch",
              status: "completed",
              title: "Вложенная задача",
              threadId: "nested",
            },
          ],
        },
      ],
    });
    renderThread();
    fireEvent.click(screen.getByRole("button", { name: "Показать субагентов" }));
    expect(
      screen.getByRole("link", { name: "Открыть диалог субагента: Вложенная задача" }),
    ).toHaveAttribute("href", "/threads/nested");
    expect(screen.queryByRole("textbox", { name: "Сообщение Codex" })).not.toBeInTheDocument();
  });

  it("renders native launch failures without links and uses the agent path when metadata is absent", () => {
    const view = render(
      <MemoryRouter>
        <Activity
          item={{
            type: "subagentLaunch",
            source: "codex",
            id: "launch",
            status: "inProgress",
            title: "",
            threadId: null,
            agentPath: "/root/mobile_review",
          }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Показать субагентов" }));
    expect(screen.getByText("mobile_review")).toBeVisible();
    expect(screen.getByLabelText("Статус субагента: Запуск")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    view.rerender(
      <MemoryRouter>
        <Activity
          item={{
            type: "subagentLaunch",
            source: "codex",
            id: "launch",
            status: "failed",
            title: "Проверить интерфейс",
            threadId: "unavailable-child",
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Не удалось запустить субагента")).toBeVisible();
    expect(screen.getByLabelText("Статус субагента: Ошибка")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("omits empty text activities and hides copy for image-only messages", () => {
    const view = render(
      <Activity
        item={{
          type: "userMessage",
          id: "image",
          status: "completed",
          text: "  ",
          images: ["data:image/png;base64,aW1hZ2U="],
          timestamp: Date.now(),
          phase: null,
        }}
      />,
    );

    expect(screen.getByAltText("Изображение 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть изображение 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Копировать сообщение" })).toBeNull();

    view.rerender(
      <Activity
        item={{
          type: "agentMessage",
          id: "empty",
          status: "inProgress",
          text: "\n",
          images: [],
          timestamp: Date.now(),
          phase: "commentary",
        }}
      />,
    );
    expect(view.container).toBeEmptyDOMElement();
  });

  it("keeps command output and file patches in compact details", () => {
    const { rerender } = render(
      <Activity
        item={{
          type: "command",
          id: "command",
          status: "completed",
          kind: "command",
          command: "npm test",
          cwd: "/work",
          output: "5 tests passed",
          exitCode: 0,
        }}
      />,
    );
    const commandDetails = screen.getByText("npm test").closest("details")!;
    expect(commandDetails).toHaveClass("activity-card");
    expect(within(commandDetails).getByText("готово")).toHaveClass("sr-only");
    expect(commandDetails.querySelector(".activity-status svg")).not.toBeNull();
    fireEvent.click(within(commandDetails).getByText("npm test"));
    fireEvent(commandDetails, new Event("toggle"));
    expect(screen.getByText("5 tests passed")).toBeInTheDocument();

    rerender(
      <Activity
        item={{
          type: "fileChange",
          id: "file",
          status: "completed",
          path: "src/App.tsx",
          patch: "+new line",
        }}
      />,
    );
    expect(screen.getByText("Изменён src/App.tsx")).toBeInTheDocument();
    const fileDetails = screen.getByText("Изменён src/App.tsx").closest("details")!;
    fileDetails.open = true;
    fireEvent(fileDetails, new Event("toggle"));
    expect(screen.getByText("+new line")).toBeInTheDocument();
  });

  it("keeps important compact activity states visible", () => {
    const item = {
      type: "command" as const,
      id: "command",
      kind: "command" as const,
      command: "npm test",
      cwd: "/work",
      output: "",
      exitCode: null,
    };
    const view = render(<Activity item={{ ...item, status: "inProgress" }} />);
    expect(screen.getByText("выполняется")).toBeVisible();

    view.rerender(<Activity item={{ ...item, status: "failed" }} />);
    expect(screen.getByText("ошибка")).toBeVisible();
  });

  it("shows failed activity only after its group is expanded", () => {
    const api = threadApi();
    mockThreadConnection(api, summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "command",
              id: "failed-command",
              status: "failed",
              kind: "command",
              command: "npm test",
              cwd: "/work/project",
              output: "1 test failed",
              exitCode: 1,
            },
          ],
        },
      ],
    });
    renderThread();

    const toggle = screen.getByRole("button", { name: "Технические детали" });
    const group = toggle.closest<HTMLElement>(".turn-activity-disclosure")!;

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Готово за 0с").closest("button")).toBe(toggle);
    expect(toggle).not.toHaveTextContent("Ошибка");
    expect(within(group).queryByText("ошибка")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(group).getByText("ошибка")).toBeVisible();
  });

  it("loads technical turn items only when their details are expanded", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          itemsLoaded: false,
          items: [
            {
              type: "agentMessage",
              id: "answer",
              status: "completed",
              text: "Готово",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    expect(context.loadTurnItems).not.toHaveBeenCalled();
    const toggle = screen.getByRole("button", { name: "Технические детали" });
    expect(screen.getByText("Готово за 0с").closest("button")).toBe(toggle);
    const footer = toggle.closest("footer")!;
    expect(footer).toHaveClass("message-footer-with-status");
    expect(footer.lastElementChild).toBe(toggle.closest(".turn-activity-row"));
    expect(within(footer).getByRole("button", { name: "Копировать сообщение" })).toBeVisible();
    expect(
      within(footer).getByRole("button", { name: "Создать ответвление отсюда" }),
    ).toBeVisible();
    expect(footer.querySelector(".turn-activity-state")).toBeNull();
    expect(screen.getAllByText("Готово за 0с")).toHaveLength(1);
    fireEvent.click(toggle);
    await waitFor(() => expect(context.loadTurnItems).toHaveBeenCalledWith("thread", "turn"));
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(context.loadTurnItems).toHaveBeenCalledTimes(1);
  });

  it("shows the assistant explanation between a submitted quiz question and the next quiz", () => {
    const context = mockThreadConnection(
      threadApi(),
      {
        ...summary,
        state: "needsAttention",
        currentTurnId: "turn",
      },
      {
        turns: [
          {
            id: "turn",
            status: "inProgress",
            startedAt: 1,
            completedAt: null,
            durationMs: null,
            progress: progress(),
            itemsLoaded: false,
            items: [
              {
                type: "userInputResponse",
                id: "response",
                status: "completed",
                afterItemId: "previous",
                timestamp: 2,
                entries: [
                  {
                    header: "Восстановление",
                    question: "Как исправлять?",
                    answers: ["У нас перестали идти котировки от Titan?"],
                  },
                ],
              },
              {
                type: "agentMessage",
                id: "explanation",
                status: "completed",
                text: "Не Titan целиком. Зависли две подписки STONK.",
                images: [],
                phase: "commentary",
                timestamp: 3,
              },
            ],
          },
        ],
        attention: [
          {
            id: "next-quiz",
            kind: "userInput",
            threadId: "thread",
            turnId: "turn",
            itemId: "call_next",
            createdAt: 4,
            autoResolutionMs: null,
            draft: null,
            questions: [
              {
                id: "fix",
                header: "Исправление",
                question: "Фиксируем автоматическое восстановление?",
                isOther: true,
                isSecret: false,
                options: null,
              },
            ],
          },
        ],
      },
    );
    renderThread();
    const question = screen.getByText("У нас перестали идти котировки от Titan?");
    const explanation = screen.getByText("Не Titan целиком. Зависли две подписки STONK.");
    const nextQuiz = screen.getByText("Фиксируем автоматическое восстановление?");
    expect(explanation).toBeVisible();
    expect(
      question.compareDocumentPosition(explanation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      explanation.compareDocumentPosition(nextQuiz) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(context.loadTurnItems).not.toHaveBeenCalled();
  });

  it("waits for every blocking question to close before resuming activity and elapsed time", () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now() - 3_000;
      const context = mockThreadConnection(
        threadApi(),
        { ...summary, state: "running", currentTurnId: "turn" },
        {
          turns: [
            {
              id: "turn",
              status: "inProgress",
              startedAt,
              completedAt: null,
              durationMs: null,
              progress: { ...progress(), startedAt, explanation: "Проверяю результат" },
              items: [
                {
                  id: "tool",
                  type: "tool",
                  status: "completed",
                  title: "Проверка завершена",
                  detail: "",
                },
              ],
            },
          ],
        },
      );
      const view = renderThread();
      const activity = view.container.querySelector(".turn-activity-row")!;
      expect(activity).toHaveTextContent("Проверяю результат");
      expect(activity.querySelector(".spinner")).not.toBeNull();
      expect(activity.querySelector(".turn-activity-duration")).toHaveTextContent("3с");
      fireEvent.click(screen.getByRole("button", { name: "Технические детали" }));

      context.state.snapshot.attention = [
        pendingInputRequest(),
        { ...pendingInputRequest("second-question"), id: "second-attention", isBlocking: true },
      ];
      view.rerender(threadRoute());
      expect(within(activity as HTMLElement).getByRole("status")).toHaveTextContent(
        "Ждёт вашего ответа",
      );
      expect(activity).not.toHaveTextContent("Проверяю результат");
      expect(activity.querySelector(".spinner")).toBeNull();
      expect(activity.querySelector(".turn-activity-state svg")).not.toBeNull();
      expect(activity.querySelector(".turn-activity-duration")).toBeNull();
      expect(screen.getByText("Проверка завершена")).toBeVisible();
      act(() => vi.advanceTimersByTime(10_000));

      context.state.snapshot.attention = [context.state.snapshot.attention[1]!];
      view.rerender(threadRoute());
      expect(activity).toHaveTextContent("Ждёт вашего ответа");
      expect(activity.querySelector(".spinner")).toBeNull();

      context.state.snapshot.attention = [];
      view.rerender(threadRoute());
      expect(activity).toHaveTextContent("Проверяю результат");
      expect(activity.querySelector(".spinner")).not.toBeNull();
      expect(activity.querySelector(".turn-activity-duration")).toHaveTextContent("13с");
      act(() => vi.advanceTimersByTime(1_000));
      expect(activity.querySelector(".turn-activity-duration")).toHaveTextContent("14с");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting while history arrives and after reopening the thread", () => {
    const context = mockThreadConnection(
      threadApi(),
      { ...summary, state: "needsAttention", currentTurnId: "turn" },
      { attention: [pendingInputRequest()] },
    );
    const view = renderThread();
    expect(view.container.querySelector(".active-turn-placeholder")).toHaveTextContent(
      "Ждёт вашего ответа",
    );
    context.state.details.thread.turns = [
      {
        id: "turn",
        status: "inProgress",
        startedAt: 1,
        completedAt: null,
        durationMs: null,
        progress: progress(),
        items: [],
      },
    ];
    view.rerender(threadRoute());
    expect(view.container.querySelector(".active-turn-placeholder")).toBeNull();
    expect(view.container.querySelector(".turn-activity-row")).toHaveTextContent(
      "Ждёт вашего ответа",
    );
    view.unmount();
    const reopened = renderThread();
    expect(reopened.container.querySelector(".turn-activity-row")).toHaveTextContent(
      "Ждёт вашего ответа",
    );
    expect(reopened.container.querySelector(".turn-activity-row .spinner")).toBeNull();
  });

  it.each([
    { label: "non-blocking", patch: { isBlocking: false } },
    { label: "another turn", patch: { turnId: "other-turn" } },
    { label: "another thread", patch: { threadId: "other-thread" } },
  ])("keeps working for a $label question", ({ patch }) => {
    mockThreadConnection(
      threadApi(),
      { ...summary, state: "running", currentTurnId: "turn" },
      { attention: [{ ...pendingInputRequest(), ...patch }] },
    );
    const view = renderThread();
    const activity = view.container.querySelector(".turn-activity-row")!;
    expect(activity).toHaveTextContent("Codex работает");
    expect(activity.querySelector(".spinner")).not.toBeNull();
    expect(screen.queryByText("Ждёт вашего ответа")).toBeNull();
  });

  it("keeps lazy-load retry inline", async () => {
    const context = mockThreadConnection(threadApi(), summary, {
      turns: [
        {
          id: "turn",
          status: "failed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          itemsLoaded: false,
          items: [],
        },
      ],
    });
    context.loadTurnItems
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    renderThread();

    fireEvent.click(screen.getByLabelText("Технические детали"));
    fireEvent.click(await screen.findByText("Повторить загрузку технических деталей"));
    await waitFor(() => expect(context.loadTurnItems).toHaveBeenCalledTimes(2));
  });

  it("keeps an opened activity journal open through streamed items", () => {
    const context = mockThreadConnection(threadApi(), summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "command",
              id: "command",
              status: "completed",
              kind: "command",
              command: "npm test",
              cwd: "/work",
              output: "passed",
              exitCode: 0,
            },
          ],
        },
      ],
    });
    const view = renderThread();
    const toggle = screen.getByRole("button", { name: "Технические детали" });
    fireEvent.click(toggle);
    expect(screen.getByText("npm test")).toBeInTheDocument();

    const currentTurn = context.state.details.thread.turns[0]!;
    context.state.details.thread = {
      ...context.state.details.thread,
      turns: [
        {
          ...currentTurn,
          items: [
            ...currentTurn.items,
            {
              type: "tool",
              id: "streamed-tool",
              status: "inProgress",
              title: "Проверка окружения",
              detail: "Детали проверки",
            },
          ],
        },
      ],
    };
    view.rerender(threadRoute());

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Проверка окружения")).toBeInTheDocument();
  });

  it("copies message text and formats timestamps for today and older days", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const timestamp = Date.now();
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Текст ответа",
          images: [],
          timestamp,
          phase: "final_answer",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Копировать сообщение" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Текст ответа"));
    expect(screen.getByRole("status")).toHaveTextContent("Скопировано");
    expect(screen.getByText(formatMessageTime(timestamp))).toBeInTheDocument();
    const copyButton = screen.getByRole("button", { name: "Копировать сообщение" });
    expect(copyButton.nextElementSibling).toBeNull();
    expect(formatMessageTime(timestamp - 3 * 86_400_000)).toMatch(/\d{2}:\d{2}/);
  });

  it("copies fenced code blocks separately from the whole message", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Готовый промпт:\n\n```text\nПервая строка\nВторая строка\n```\n\n`inline`",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Копировать блок" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Копировать блок" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Первая строка\nВторая строка"));
    expect(screen.getByRole("button", { name: "Блок скопирован" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Копировать сообщение" })).toBeInTheDocument();
  });

  it("keeps fenced code mounted after opening the annotation editor", async () => {
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "```text\nВыделенный кодовый фрагмент\n```",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
      />,
    );

    const code = screen.getByText("Выделенный кодовый фрагмент");
    selectText(code, 0, 10);
    fireEvent.pointerUp(code);

    expect(
      await screen.findByRole("textbox", { name: "Комментарий к выделенному тексту" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Выделенный кодовый фрагмент")).toBe(code);
  });

  it("creates an annotation from an exact text selection", async () => {
    const onCreate = vi.fn().mockReturnValue(true);
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Выделенный фрагмент ответа",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
        onCreateAnnotation={onCreate}
      />,
    );

    const text = screen.getByText("Выделенный фрагмент ответа");
    selectText(text, 0, 10);
    fireEvent.pointerUp(text);
    await screen.findByRole("textbox", { name: "Комментарий к выделенному тексту" });
    expect(screen.queryByText("Новая аннотация")).toBeNull();
    expect(screen.getByPlaceholderText("Комментарий")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить аннотацию" })).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Удалить аннотацию" })).toHaveTextContent("");
    fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
      target: { value: "Перепроверь это" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить аннотацию" }));

    expect(onCreate).toHaveBeenCalledWith({
      messageId: "agent",
      source: "agentMessage",
      quote: "Выделенный",
      startOffset: 0,
      endOffset: 10,
      comment: "Перепроверь это",
    });
  });

  it("copies the selected fragment from the editor with ctrl+c", async () => {
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Скопируй только это",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
      />,
    );

    const text = screen.getByText("Скопируй только это");
    selectText(text, 9, 15);
    fireEvent.pointerUp(text);
    const field = await screen.findByRole("textbox", { name: "Комментарий к выделенному тексту" });
    const setData = vi.fn();
    fireEvent.copy(field, { clipboardData: { setData } });

    expect(setData).toHaveBeenCalledWith("text/plain", "только");
  });

  it("saves the annotation on Enter", async () => {
    const onCreate = vi.fn().mockReturnValue(true);
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Сохрани по Enter",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
        onCreateAnnotation={onCreate}
      />,
    );

    const text = screen.getByText("Сохрани по Enter");
    selectText(text, 0, 7);
    fireEvent.pointerUp(text);
    const field = await screen.findByRole("textbox", { name: "Комментарий к выделенному тексту" });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "Готово" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ quote: "Сохрани", comment: "Готово" }),
    );
  });

  it("places the annotation editor below the selected range", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          top: 100,
          bottom: 120,
          left: 40,
          right: 80,
          width: 40,
          height: 20,
          x: 40,
          y: 100,
          toJSON: () => ({}),
        }) satisfies DOMRect,
    });
    try {
      render(
        <Activity
          item={{
            type: "agentMessage",
            id: "agent",
            status: "completed",
            text: "Выделение снизу",
            images: [],
            timestamp: 1,
            phase: "final_answer",
          }}
          annotationEnabled
        />,
      );

      const text = screen.getByText("Выделение снизу");
      selectText(text, 0, 9);
      fireEvent.pointerUp(text);

      expect(
        (await screen.findByRole("textbox", { name: "Комментарий к выделенному тексту" })).closest(
          "form",
        ),
      ).toHaveStyle({
        top: "128px",
      });
    } finally {
      if (descriptor) Object.defineProperty(Range.prototype, "getBoundingClientRect", descriptor);
      else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });

  it("edits and deletes an annotation through its numbered marker", async () => {
    const onUpdate = vi.fn().mockReturnValue(true);
    const onDelete = vi.fn().mockReturnValue(true);
    const annotation: PendingAnnotation = {
      id: "note",
      messageId: "agent",
      source: "agentMessage",
      quote: "фрагментом",
      startOffset: 8,
      endOffset: 18,
      comment: "Старый комментарий",
      createdAt: 1,
    };
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Ответ с фрагментом",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotations={[annotation]}
        onUpdateAnnotation={onUpdate}
        onDeleteAnnotation={onDelete}
      />,
    );

    const marker = await screen.findByRole("button", { name: "Аннотация 1" });
    fireEvent.click(marker);
    const editor = screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" });
    expect(editor).toHaveValue("Старый комментарий");
    fireEvent.change(editor, { target: { value: "Новый комментарий" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить аннотацию" }));
    expect(onUpdate).toHaveBeenCalledWith("note", "Новый комментарий");

    fireEvent.click(marker);
    fireEvent.click(screen.getByRole("button", { name: "Удалить аннотацию" }));
    expect(onDelete).toHaveBeenCalledWith("note");
  });

  it("saves a non-empty new annotation on outside click and discards an empty one", async () => {
    const onCreate = vi.fn().mockReturnValue(true);
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Фрагмент для пометки",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
        onCreateAnnotation={onCreate}
      />,
    );

    const text = screen.getByText("Фрагмент для пометки");
    selectText(text, 0, 8);
    fireEvent.pointerUp(text);
    await screen.findByRole("textbox", { name: "Комментарий к выделенному тексту" });
    fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
      target: { value: "Сохранить снаружи" },
    });
    fireEvent.pointerDown(document.body);

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ quote: "Фрагмент", comment: "Сохранить снаружи" }),
    );
    expect(screen.queryByRole("textbox", { name: "Комментарий к выделенному тексту" })).toBeNull();

    selectText(text, 9, 12);
    fireEvent.pointerUp(text);
    await screen.findByRole("textbox", { name: "Комментарий к выделенному тексту" });
    fireEvent.pointerDown(document.body);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "Комментарий к выделенному тексту" })).toBeNull();
  });

  it("does not erase an existing annotation when its input is cleared and closed outside", async () => {
    const onUpdate = vi.fn().mockReturnValue(true);
    const annotation: PendingAnnotation = {
      id: "note",
      messageId: "agent",
      source: "agentMessage",
      quote: "фрагментом",
      startOffset: 8,
      endOffset: 18,
      comment: "Сохранённый комментарий",
      createdAt: 1,
    };
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Ответ с фрагментом",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotations={[annotation]}
        onUpdateAnnotation={onUpdate}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Аннотация 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
      target: { value: "" },
    });
    fireEvent.pointerDown(document.body);

    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Аннотация 1" })).toBeInTheDocument();
  });

  it("keeps the editor open when saving on an outside click fails", async () => {
    const onCreate = vi.fn().mockReturnValue(false);
    render(
      <Activity
        item={{
          type: "agentMessage",
          id: "agent",
          status: "completed",
          text: "Фрагмент с ошибкой",
          images: [],
          timestamp: 1,
          phase: "final_answer",
        }}
        annotationEnabled
        onCreateAnnotation={onCreate}
      />,
    );

    const text = screen.getByText("Фрагмент с ошибкой");
    selectText(text, 0, 8);
    fireEvent.pointerUp(text);
    await screen.findByRole("textbox", { name: "Комментарий к выделенному тексту" });
    fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
      target: { value: "Не потерять" },
    });
    fireEvent.pointerDown(document.body);

    expect(onCreate).toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" })).toHaveValue(
      "Не потерять",
    );
  });

  it("shows a live turn timer and a final duration", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-21T12:00:05Z"));
      const runningSummary = {
        ...summary,
        state: "running" as const,
        currentTurnId: "running",
      };
      const running = {
        id: "running",
        status: "inProgress" as const,
        startedAt: Date.now() - 5_000,
        completedAt: null,
        durationMs: null,
        progress: { ...progress(), explanation: "  Проверяю изменения  " },
        items: [],
      };
      const context = mockThreadConnection(threadApi(), runningSummary, { turns: [running] });
      const view = renderThread();
      expect(screen.getByRole("status")).toHaveTextContent("Проверяю изменения");
      expect(screen.getByText("5с")).toHaveAttribute("aria-live", "off");
      act(() => vi.advanceTimersByTime(2_000));
      expect(screen.getByText("7с")).toBeInTheDocument();

      const completedSummary = { ...summary, state: "completed" as const };
      context.state.snapshot.threads = [completedSummary];
      context.state.details.thread = {
        ...context.state.details.thread,
        summary: completedSummary,
        turns: [
          {
            ...running,
            status: "completed",
            completedAt: running.startedAt + 8_000,
            durationMs: 8_000,
          },
        ],
      };
      view.rerender(threadRoute());
      expect(screen.getByText("Готово за 8с")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["agentMessage", "plan"] as const)(
    "moves completion into the last %s footer without losing the open journal",
    (type) => {
      const message: ActivityItem = {
        type,
        id: "final-response",
        text: "Итоговый ответ",
        status: "completed",
        images: [],
        timestamp: 2,
        phase: type === "agentMessage" ? "final_answer" : null,
      };
      const runningSummary: ThreadSummary = {
        ...summary,
        state: "running",
        currentTurnId: "turn",
      };
      const current: ThreadDetail["turns"][number] = {
        id: "turn",
        status: "inProgress",
        startedAt: 1,
        completedAt: null,
        durationMs: null,
        progress: progress(),
        items: [
          {
            ...message,
            type: "agentMessage",
            id: "commentary",
            text: "Подготовка",
            phase: "commentary",
          },
          message,
          {
            type: "tool",
            id: "tool",
            status: "completed",
            title: "Проверка",
            detail: "Журнал проверки",
          },
        ],
      };
      const context = mockThreadConnection(threadApi(), runningSummary, { turns: [current] });
      const view = renderThread();
      const answer = screen.getByText("Итоговый ответ").closest("article")!;
      fireEvent.click(screen.getByRole("button", { name: "Технические детали" }));
      const journal = view.container.querySelector(".turn-activity-journal")!;
      expect(journal).toBeVisible();
      const completedSummary = {
        ...runningSummary,
        state: "completed" as const,
        currentTurnId: null,
      };
      context.state.snapshot.threads = [completedSummary];
      context.state.details.thread = {
        ...context.state.details.thread!,
        summary: completedSummary,
        turns: [{ ...current, status: "completed", completedAt: 61001, durationMs: 61000 }],
      };
      view.rerender(threadRoute());
      const toggle = screen.getByRole("button", { name: "Технические детали" });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(toggle.closest("article")).toBe(answer);
      expect(screen.getAllByText("Готово за 1м 1с")).toHaveLength(1);
      expect(answer.querySelector(".turn-activity-state")).toBeNull();
      expect(journal).toBeVisible();
      expect(view.container.querySelector(".turn-activity-journal")).toBe(journal);
      expect(
        screen.getByText("Подготовка").closest("article")!.querySelector(".turn-activity-row"),
      ).toBeNull();
      fireEvent.click(toggle);
      expect(journal).not.toBeVisible();
    },
  );

  it("uses outcome-specific labels with and without durations", () => {
    mockThreadConnection(threadApi(), summary, {
      turns: [
        {
          id: "completed",
          status: "completed",
          startedAt: 1_000,
          completedAt: 4_000,
          durationMs: 3_000,
          progress: progress(),
          items: [],
        },
        {
          id: "failed",
          status: "failed",
          startedAt: 1_000,
          completedAt: 5_000,
          durationMs: 4_000,
          progress: progress(),
          items: [],
        },
        {
          id: "interrupted",
          status: "interrupted",
          startedAt: null,
          completedAt: null,
          durationMs: null,
          progress: { ...progress(), startedAt: null },
          items: [],
        },
      ],
    });
    renderThread();

    expect(screen.getByText("Готово за 3с")).toBeInTheDocument();
    expect(screen.getByText("Ошибка через 4с")).toBeInTheDocument();
    expect(screen.getByText("Прервано")).toBeInTheDocument();
    expect(screen.queryByLabelText("Технические детали")).toBeNull();
  });

  it("downloads task file links once and leaves other links unchanged", async () => {
    const api = threadApi();
    let resolveTicket: ((ticket: { downloadUrl: string; expiresAt: number }) => void) | undefined;
    api.createDownload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTicket = resolve;
        }),
    );
    mockThreadConnection(api, summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "agent",
              status: "completed",
              text: [
                "[Скачать APK](/work/project/build/app-debug.apk)",
                "[Внешняя ссылка](https://example.com/file.apk)",
                "[Раздел приложения](/settings)",
              ].join("\n\n"),
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    const fileLink = screen.getByRole("link", { name: "Скачать APK" });
    fireEvent.click(fileLink);
    fireEvent.click(fileLink);
    expect(api.createDownload).toHaveBeenCalledTimes(1);
    expect(api.createDownload).toHaveBeenCalledWith("thread", "/work/project/build/app-debug.apk");
    expect(fileLink).toHaveAttribute("aria-busy", "true");

    resolveTicket?.({ downloadUrl: "/downloads/ticket/app-debug.apk", expiresAt: 61_000 });
    await waitFor(() =>
      expect(openDownloadUrl).toHaveBeenCalledWith(
        "https://codex.home.arpa",
        "/downloads/ticket/app-debug.apk",
      ),
    );
    expect(fileLink).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("link", { name: "Внешняя ссылка" })).toHaveAttribute(
      "href",
      "https://example.com/file.apk",
    );
    expect(screen.getByRole("link", { name: "Раздел приложения" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it.each(["/work/project/artifacts/chart.png", "/tmp/chart.png"])(
    "loads an explicitly linked image %s through a download ticket",
    async (imagePath) => {
      const api = threadApi();
      api.createDownload.mockResolvedValueOnce({
        downloadUrl: "/downloads/ticket/chart.png",
        expiresAt: 61_000,
        fileName: "chart.png",
        size: 3,
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const createObjectURL = vi.fn(() => "blob:https://codex.home.arpa/chart");
      const revokeObjectURL = vi.fn();
      const ObjectUrl = class extends URL {};
      Object.defineProperties(ObjectUrl, {
        createObjectURL: { value: createObjectURL },
        revokeObjectURL: { value: revokeObjectURL },
      });
      vi.stubGlobal("URL", ObjectUrl);
      mockThreadConnection(api, summary, {
        turns: [
          {
            id: "turn",
            status: "completed",
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
            progress: progress(),
            items: [
              {
                type: "agentMessage",
                id: "agent",
                status: "completed",
                text: `![График](<${imagePath}>)`,
                images: [],
                timestamp: 2,
                phase: "final_answer",
              },
            ],
          },
        ],
      });

      const view = renderThread();

      await waitFor(() => expect(api.createDownload).toHaveBeenCalledWith("thread", imagePath));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(api.createDownload).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        "https://codex.home.arpa/downloads/ticket/chart.png",
      );
      expect(fetchMock.mock.calls[0]![1]).toEqual({ cache: "no-store" });
      const preview = await within(screen.getByRole("group", { name: "Изображения" })).findByRole(
        "button",
        { name: "Открыть изображение График" },
      );
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(screen.getByRole("img", { name: "График" })).toHaveAttribute(
        "src",
        "blob:https://codex.home.arpa/chart",
      );
      expect(preview).toBeDisabled();
      fireEvent.load(screen.getByRole("img", { name: "График" }));
      expect(preview).toBeEnabled();
      fireEvent.click(preview);
      expect(
        await screen.findByRole("dialog", { name: "Просмотр изображений" }),
      ).toBeInTheDocument();
      expect(api.createDownload).toHaveBeenCalledTimes(1);

      view.unmount();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:https://codex.home.arpa/chart");
    },
  );

  it("shows a retryable error when a file ticket cannot be issued", async () => {
    const api = threadApi();
    api.createDownload
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ downloadUrl: "/downloads/retry/file.bin", expiresAt: 61_000 });
    mockThreadConnection(api, summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "agent",
              status: "completed",
              text: "[Скачать файл](/work/project/file.bin)",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    const downloadLink = screen.getByRole("link", { name: "Скачать файл" });
    fireEvent.click(downloadLink);
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось скачать файл");

    fireEvent.click(downloadLink);
    await waitFor(() => expect(openDownloadUrl).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens previewable agent files inline and keeps unsupported files downloadable", async () => {
    const api = threadApi();
    api.createDownload
      .mockResolvedValueOnce({
        downloadUrl: "/downloads/ticket/report.md",
        expiresAt: 61_000,
        fileName: "report.md",
        size: 8,
      })
      .mockResolvedValueOnce({
        downloadUrl: "/downloads/ticket/report.md",
        expiresAt: 61_000,
        fileName: "report.md",
        size: 8,
      });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("# Report", { status: 200 })));
    mockThreadConnection(api, summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "agent",
              status: "completed",
              text: "[universe.rs:183](/work/project/src/universe.rs)\n[Готовый отчёт](/work/project/output/report.md)",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    expect(screen.getByRole("link", { name: "universe.rs:183" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть report.md" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Скачать report.md" }));
    await waitFor(() =>
      expect(openDownloadUrl).toHaveBeenCalledWith(
        "https://codex.home.arpa",
        "/downloads/ticket/report.md",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Открыть report.md" }));
    expect(await screen.findByRole("heading", { name: "Report" })).toBeInTheDocument();
    expect(screen.getByText("Готовый отчёт")).toBeInTheDocument();
  });

  it("applies pin responses from the page menu and exposes recoverable errors", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary);
    api.updateThread.mockRejectedValueOnce(new Error("Сервер недоступен"));
    renderThread();
    fireEvent.click(screen.getByLabelText("Действия с задачей"));
    const pin = screen.getByRole("button", { name: "Закрепить" });
    fireEvent.click(pin);
    expect(await screen.findByText("Сервер недоступен")).toBeInTheDocument();
    expect(pin).toBeEnabled();
    const updated = { ...summary, pinned: true };
    api.updateThread.mockResolvedValueOnce(updated);
    fireEvent.click(pin);
    await waitFor(() =>
      expect(context.dispatch).toHaveBeenCalledWith({ type: "thread", thread: updated }),
    );
    expect(screen.queryByText("Сервер недоступен")).not.toBeInTheDocument();
  });

  it("keeps send, pin, rename and archive actions wired to the existing API", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    renderThread();

    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Продолжай" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: "Продолжай", clientMessageId: expect.any(String) }),
      ),
    );

    fireEvent.click(screen.getByLabelText("Действия с задачей"));
    fireEvent.click(screen.getByRole("button", { name: "Закрепить" }));
    expect(api.updateThread).toHaveBeenCalledWith("thread", { pinned: true });

    fireEvent.click(screen.getByRole("button", { name: "Переименовать" }));
    const renameDialog = screen.getByRole("dialog", { name: "Переименовать" });
    const renameInput = within(renameDialog).getByRole("textbox", { name: "Название" });
    expect(renameInput).toHaveFocus();
    fireEvent.change(renameInput, {
      target: { value: "Новое имя" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.updateThread).toHaveBeenCalledWith("thread", { name: "Новое имя" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Архивировать" }));
    expect(api.archive).toHaveBeenCalledWith("thread", true);
  });

  it.each([
    ["disabled", "Включить браузер", "false"],
    ["disconnected", "Выключить браузер", "true"],
    ["connected", "Выключить браузер", "true"],
  ] as const)(
    "shows the %s browser state as a single accessible header button",
    (browserStatus, accessibleLabel, pressed) => {
      const api = threadApi();
      mockThreadConnection(api, { ...summary, browserStatus });
      renderThread();

      const button = screen.getByRole("button", { name: accessibleLabel });
      expect(button.textContent).toBe("");
      expect(button).toHaveClass("icon-button");
      expect(button).toHaveAttribute("aria-pressed", pressed);
      expect(button).toHaveClass(`browser-session-status-${browserStatus}`);
      expect(button).toHaveAttribute("title", accessibleLabel);
    },
  );

  it("waits for the browser update response, dispatches it, and blocks a second request", async () => {
    const api = threadApi();
    const browserThread = { ...summary, browserStatus: "disabled" as const };
    const updatedThread = { ...browserThread, browserStatus: "disconnected" as const };
    let resolveUpdate: ((thread: ThreadSummary) => void) | undefined;
    api.updateThread.mockImplementationOnce(
      () => new Promise<ThreadSummary>((resolve) => (resolveUpdate = resolve)),
    );
    const context = mockThreadConnection(api, browserThread);
    renderThread();

    const button = screen.getByRole("button", { name: "Включить браузер" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(api.updateThread).toHaveBeenCalledOnce();
    expect(api.updateThread).toHaveBeenCalledWith("thread", { browserEnabled: true });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAccessibleName("Включить браузер");
    expect(context.dispatch).not.toHaveBeenCalled();

    await act(async () => resolveUpdate?.(updatedThread));

    expect(context.dispatch).toHaveBeenCalledWith({ type: "thread", thread: updatedThread });
  });

  it("requests browser opt-out from a pressed state", async () => {
    const api = threadApi();
    const browserThread = { ...summary, browserStatus: "connected" as const };
    const updatedThread = { ...browserThread, browserStatus: "disabled" as const };
    api.updateThread.mockResolvedValueOnce(updatedThread);
    const context = mockThreadConnection(api, browserThread);
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Выключить браузер" }));

    await waitFor(() =>
      expect(api.updateThread).toHaveBeenCalledWith("thread", { browserEnabled: false }),
    );
    expect(context.dispatch).toHaveBeenCalledWith({ type: "thread", thread: updatedThread });
  });

  it.each([
    ["active turn", "idle", "active-turn"],
    ["running state", "running", null],
    ["queued state", "queued", null],
    ["attention state", "needsAttention", null],
  ] as const)("locks browser switching for %s", (_label, state, currentTurnId) => {
    const api = threadApi();
    mockThreadConnection(api, { ...summary, state, currentTurnId });
    renderThread();

    const button = screen.getByRole("button", { name: "Включить браузер" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Дождитесь завершения текущего хода, чтобы изменить доступ браузера",
    );
    fireEvent.click(button);
    expect(api.updateThread).not.toHaveBeenCalled();
  });

  it.each([
    ["archived", { archived: true }],
    [
      "subagent",
      {
        relation: {
          kind: "subagent" as const,
          sessionId: "session",
          parentThreadId: "parent",
          nickname: null,
          role: null,
        },
      },
    ],
  ])("hides browser switching for %s sessions", (_label, patch) => {
    const api = threadApi();
    mockThreadConnection(api, { ...summary, ...patch });
    renderThread();

    expect(screen.queryByRole("button", { name: "Включить браузер" })).not.toBeInTheDocument();
  });

  it("blocks an exact duplicate of the active turn user message and preserves the draft", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "active-turn" };
    mockThreadConnection(api, running, {
      turns: [
        {
          id: "active-turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            {
              type: "userMessage",
              id: "active-message",
              status: "completed",
              text: "Повтори проверку",
              images: [],
              timestamp: 1,
              phase: null,
            },
          ],
        },
      ],
    });
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.change(textarea, { target: { value: "  Повтори проверку  " } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));

    expect(await screen.findByText("Это сообщение уже отправлено")).toBeInTheDocument();
    expect(textarea).toHaveValue("  Повтори проверку  ");
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(api.enqueue).not.toHaveBeenCalled();
    expect(api.updateThreadSettings).not.toHaveBeenCalled();
  });

  it("treats the latest root user message as active while a Team parent runs between turns", async () => {
    const api = threadApi();
    const teamParent = {
      ...summary,
      state: "running" as const,
      settings: { collaborationMode: "team" as const },
    };
    mockThreadConnection(api, teamParent, {
      turns: [
        {
          id: "root-turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "userMessage",
              id: "root-message",
              status: "completed",
              text: "Оркестрируй задачу",
              images: [],
              timestamp: 1,
              phase: null,
            },
          ],
        },
      ],
    });
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.change(textarea, { target: { value: "Оркестрируй задачу" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));

    expect(await screen.findByText("Это сообщение уже отправлено")).toBeInTheDocument();
    expect(textarea).toHaveValue("Оркестрируй задачу");
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(api.enqueue).not.toHaveBeenCalled();
  });

  it.each(["queued", "optimistic"] as const)(
    "blocks an exact duplicate of an active %s message",
    async (source) => {
      const api = threadApi();
      const context = mockThreadConnection(api, summary, {
        queuedMessages:
          source === "queued"
            ? [
                {
                  id: "queued-message",
                  threadId: "thread",
                  text: "Не дублируй",
                  images: [],
                  createdAt: 1,
                  status: "queued",
                },
              ]
            : [],
      });
      if (source === "optimistic") {
        context.state.optimisticMessages.thread = [
          {
            id: "optimistic-message",
            threadId: "thread",
            text: "Не дублируй",
            images: [],
            createdAt: 1,
            destination: "queue",
            turnId: null,
          },
        ];
      }
      renderThread();
      const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
      fireEvent.change(textarea, { target: { value: "Не дублируй" } });

      fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

      expect(await screen.findByText("Это сообщение уже отправлено")).toBeInTheDocument();
      expect(api.startTurn).not.toHaveBeenCalled();
      expect(textarea).toHaveValue("Не дублируй");
    },
  );

  it("allows a completed message to be sent again", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary, {
      turns: [
        {
          id: "completed-turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "userMessage",
              id: "completed-message",
              status: "completed",
              text: "Запусти снова",
              images: [],
              timestamp: 1,
              phase: null,
            },
          ],
        },
      ],
    });
    renderThread();

    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Запусти снова" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: "Запусти снова" }),
      ),
    );
  });

  it("acknowledges the thread notification as soon as its route opens", async () => {
    mockThreadConnection(threadApi(), summary);

    const view = renderThread();

    await waitFor(() => expect(acknowledgePendingThread).toHaveBeenCalledWith("thread"));
    expect(acknowledgePendingThread).toHaveBeenCalledOnce();

    view.unmount();
    expect(releaseActiveThread).toHaveBeenCalledWith("thread");
  });

  it.each(["agentMessage", "plan"] as const)(
    "opens a %s annotation from its bubble and synchronizes edits and deletion",
    async (source) => {
      const api = threadApi();
      const annotation = pendingAnnotation({ source });
      const turn = completedAgentTurn();
      mockThreadConnection(api, summary, {
        turns: [{ ...turn, items: [{ ...turn.items[0]!, type: source }] }],
        draft: {
          input: "Сохрани ввод",
          images: [],
          goalMode: false,
          annotations: [annotation],
          updatedAt: 2,
        },
      });
      renderThread();

      const bubbles = await screen.findByRole("group", { name: "Аннотации" });
      expect(within(bubbles).getByText("«фрагмент ответа»")).toBeVisible();
      expect(within(bubbles).getByText(annotation.comment)).toBeVisible();
      const marker = await screen.findByRole("button", { name: "Аннотация 1" });
      const scrollIntoView = vi.fn();
      marker.scrollIntoView = scrollIntoView;
      fireEvent.click(within(bubbles).getByRole("button", { name: "Перейти к аннотации 1" }));

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
      const editor = screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" });
      expect(editor).toHaveValue(annotation.comment);
      expect(editor).toHaveFocus();
      fireEvent.change(editor, { target: { value: "Обновлённый комментарий" } });
      fireEvent.click(screen.getByRole("button", { name: "Сохранить аннотацию" }));
      expect(within(bubbles).getByText("Обновлённый комментарий")).toBeVisible();
      await waitFor(() =>
        expect(api.updateThreadDraft).toHaveBeenCalledWith(
          "thread",
          expect.objectContaining({
            annotations: [{ ...annotation, comment: "Обновлённый комментарий" }],
          }),
          { keepalive: false },
        ),
      );

      fireEvent.click(within(bubbles).getByRole("button", { name: "Перейти к аннотации 1" }));
      // Keyboard activation has no outside pointerdown to close the source editor.
      fireEvent.click(within(bubbles).getByRole("button", { name: "Удалить аннотацию 1" }));
      expect(screen.queryByRole("group", { name: "Аннотации" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Аннотация 1" })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("textbox", { name: "Комментарий к выделенному тексту" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue(
        "Сохрани ввод",
      );
      await waitFor(() =>
        expect(api.updateThreadDraft).toHaveBeenCalledWith(
          "thread",
          expect.objectContaining({ annotations: [], input: "Сохрани ввод" }),
          { keepalive: false },
        ),
      );
    },
  );

  it.each(["same", "another", "multiple"] as const)(
    "saves and closes the current editor before keyboard navigation to the %s source",
    async (target) => {
      const annotation = pendingAnnotation();
      const second = pendingAnnotation({
        id: "second-note",
        messageId: "second-answer",
        comment: "Второй комментарий",
      });
      const turn = completedAgentTurn();
      const api = threadApi();
      mockThreadConnection(api, summary, {
        turns: [
          turn,
          {
            ...turn,
            id: "second-turn",
            items: [{ ...turn.items[0]!, id: second.messageId }],
          },
        ],
        draft: {
          input: "",
          images: [],
          goalMode: false,
          annotations: [annotation, second],
          updatedAt: 2,
        },
      });
      renderThread();
      const firstMarker = await screen.findByRole("button", { name: "Аннотация 1" });
      const secondMarker = screen.getByRole("button", { name: "Аннотация 2" });
      firstMarker.scrollIntoView = vi.fn();
      secondMarker.scrollIntoView = vi.fn();
      fireEvent.click(firstMarker);
      fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
        target: { value: "Сохранить перед переходом" },
      });
      if (target === "multiple") {
        fireEvent.click(secondMarker);
        fireEvent.change(
          within(secondMarker.closest("article")!).getByRole("textbox", {
            name: "Комментарий к выделенному тексту",
          }),
          { target: { value: "Сохранить второй комментарий" } },
        );
      }
      const bubbles = screen.getByRole("group", { name: "Аннотации" });

      fireEvent.click(
        within(bubbles).getByRole("button", {
          name: `Перейти к аннотации ${target === "another" ? 2 : 1}`,
        }),
      );

      expect(
        screen.getAllByRole("textbox", { name: "Комментарий к выделенному тексту" }),
      ).toHaveLength(1);
      expect(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" })).toHaveValue(
        target === "another" ? second.comment : "Сохранить перед переходом",
      );
      expect(within(bubbles).getByText("Сохранить перед переходом")).toBeVisible();
      await waitFor(() =>
        expect(api.updateThreadDraft).toHaveBeenCalledWith(
          "thread",
          expect.objectContaining({
            annotations: [
              { ...annotation, comment: "Сохранить перед переходом" },
              target === "multiple"
                ? { ...second, comment: "Сохранить второй комментарий" }
                : second,
            ],
          }),
          { keepalive: false },
        ),
      );
    },
  );

  it("keeps bubble numbers aligned with markers across answers and plans after deletion", async () => {
    const answer = pendingAnnotation();
    const plan = pendingAnnotation({
      id: "plan-note",
      messageId: "plan-answer",
      source: "plan",
      comment: "Уточни план",
      createdAt: 2,
    });
    const turn = completedAgentTurn();
    mockThreadConnection(threadApi(), summary, {
      turns: [
        turn,
        {
          ...turn,
          id: "plan-turn",
          items: [{ ...turn.items[0]!, id: "plan-answer", type: "plan" }],
        },
      ],
      draft: {
        input: "",
        images: [],
        goalMode: false,
        annotations: [answer, plan],
        updatedAt: 2,
      },
    });
    const view = renderThread();
    const bubbles = await screen.findByRole("group", { name: "Аннотации" });
    expect(within(bubbles).getByRole("button", { name: "Перейти к аннотации 2" })).toBeVisible();
    expect(view.container.querySelector(".message.plan .annotation-marker")).toHaveTextContent("2");

    fireEvent.click(within(bubbles).getByRole("button", { name: "Удалить аннотацию 1" }));

    expect(
      within(bubbles).getByRole("button", { name: "Перейти к аннотации 1" }),
    ).toHaveTextContent("Уточни план");
    expect(view.container.querySelector(".message.plan .annotation-marker")).toHaveTextContent("1");
    expect(within(bubbles).queryByRole("button", { name: "Перейти к аннотации 2" })).toBeNull();
  });

  it("preserves an annotation with an unavailable source without loading more history", async () => {
    const annotation = pendingAnnotation({ messageId: "unloaded-answer" });
    const api = threadApi();
    const context = mockThreadConnection(api, summary, {
      turns: [completedAgentTurn()],
      olderTurnsCursor: "older-history",
      draft: {
        input: "",
        images: [],
        goalMode: false,
        annotations: [annotation],
        updatedAt: 2,
      },
    });
    renderThread();
    const bubbles = await screen.findByRole("group", { name: "Аннотации" });

    fireEvent.click(within(bubbles).getByRole("button", { name: "Перейти к аннотации 1" }));

    expect(screen.getByText("Исходная цитата не найдена в загруженной истории.")).toBeVisible();
    expect(within(bubbles).getByText(annotation.comment)).toBeVisible();
    expect(context.loadOlderDetail).not.toHaveBeenCalled();
    expect(context.loadTurnItems).not.toHaveBeenCalled();
    expect(api.updateThreadDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
  });

  it("sends annotation-only drafts as a visible user message and clears them on success", async () => {
    const api = threadApi();
    const annotation = pendingAnnotation();
    localStorage.setItem(annotationStorageKey("thread"), JSON.stringify([annotation]));
    const context = mockThreadConnection(api, summary, {
      turns: [completedAgentTurn()],
    });
    renderThread();

    expect(await screen.findByRole("group", { name: "Аннотации" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          input: expect.stringContaining("## Аннотации к предыдущему ответу агента"),
          clientMessageId: expect.any(String),
        }),
      ),
    );
    expect(api.startTurn.mock.calls[0]?.[1].input).toContain("> фрагмент ответа");
    expect(api.startTurn.mock.calls[0]?.[1].input).toContain("Уточни формулировку");
    expect(
      context.dispatch.mock.calls.find(([action]) => action.type === "optimistic.add")?.[0].message
        .text,
    ).toContain("### Аннотация 1");
    await waitFor(() => expect(localStorage.getItem(annotationStorageKey("thread"))).toBeNull());
    expect(screen.queryByRole("group", { name: "Аннотации" })).not.toBeInTheDocument();
  });

  it("persists a comment on the server and restores it from the numbered marker", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary, { turns: [completedAgentTurn()] });
    renderThread();

    const text = screen.getByText("Готовый фрагмент ответа");
    selectText(text, 8, 16);
    fireEvent.pointerUp(text);
    await screen.findByRole("textbox", { name: "Комментарий к выделенному тексту" });
    fireEvent.change(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" }), {
      target: { value: "Локальный комментарий" },
    });
    fireEvent.pointerDown(document.body);

    const marker = await screen.findByRole("button", { name: "Аннотация 1" });
    expect(
      within(screen.getByRole("group", { name: "Аннотации" })).getByText("Локальный комментарий"),
    ).toBeVisible();
    await waitFor(() =>
      expect(api.updateThreadDraft).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          annotations: [expect.objectContaining({ comment: "Локальный комментарий" })],
        }),
        { keepalive: false },
      ),
    );
    fireEvent.click(marker);
    expect(screen.getByRole("textbox", { name: "Комментарий к выделенному тексту" })).toHaveValue(
      "Локальный комментарий",
    );
  });

  it("keeps server-backed annotations when sending fails", async () => {
    const api = threadApi();
    api.startTurn.mockRejectedValueOnce(new Error("Сеть недоступна"));
    const annotation = pendingAnnotation();
    localStorage.setItem(annotationStorageKey("thread"), JSON.stringify([annotation]));
    mockThreadConnection(api, summary, { turns: [completedAgentTurn()] });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Сеть недоступна")).toBeInTheDocument();
    expect(api.updateThreadDraft).toHaveBeenCalledWith(
      "thread",
      expect.objectContaining({ annotations: [annotation] }),
      { keepalive: false },
    );
    expect(screen.getByRole("button", { name: "Аннотация 1" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Аннотации" })).getByText(annotation.comment),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
  });

  it("offers annotation actions only on the latest completed agent response", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary, {
      turns: [
        {
          ...completedAgentTurn(),
          id: "older-turn",
          items: [{ ...completedAgentTurn().items[0]!, id: "older", text: "Старый ответ" }],
        },
        {
          ...completedAgentTurn(),
          id: "latest-turn",
          items: [{ ...completedAgentTurn().items[0]!, id: "latest", text: "Новый ответ" }],
        },
      ],
    });
    renderThread();

    const older = screen.getByText("Старый ответ");
    selectText(older, 0, 6);
    fireEvent.pointerUp(older);
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 100)));
    expect(screen.queryByRole("textbox", { name: "Комментарий к выделенному тексту" })).toBeNull();

    const latest = screen.getByText("Новый ответ");
    selectText(latest, 0, 5);
    fireEvent.pointerUp(latest);
    expect(
      await screen.findByRole("textbox", { name: "Комментарий к выделенному тексту" }),
    ).toBeInTheDocument();
  });

  it("queues annotation-only drafts and clears them after queue acceptance", async () => {
    const api = threadApi();
    const annotation = pendingAnnotation();
    localStorage.setItem(annotationStorageKey("thread"), JSON.stringify([annotation]));
    const running = { ...summary, state: "running" as const, currentTurnId: "running-turn" };
    mockThreadConnection(api, running, {
      turns: [
        completedAgentTurn(),
        {
          id: "running-turn",
          status: "inProgress",
          startedAt: 3,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [],
        },
      ],
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));

    await waitFor(() =>
      expect(api.enqueue).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: expect.stringContaining("### Аннотация 1") }),
      ),
    );
    expect(localStorage.getItem(annotationStorageKey("thread"))).toBeNull();
  });

  it("keeps a completed session green until the user finishes it", async () => {
    let resolveFinish: (() => void) | undefined;
    const api = threadApi();
    api.markRead.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveFinish = resolve;
      }),
    );
    const unfinished = {
      ...summary,
      state: "completed" as const,
      unread: true,
      updatedAt: 123,
    };
    const context = mockThreadConnection(api, unfinished, {
      turns: [
        {
          id: "completed-turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "answer",
              status: "completed",
              text: "Готово",
              images: [],
              timestamp: 2,
              phase: null,
            },
          ],
        },
      ],
    });
    const view = renderThread();

    expect(api.markRead).not.toHaveBeenCalled();
    const finish = screen.getByRole("button", { name: "Закончить" });
    expect(view.container.querySelector(".timeline")?.lastElementChild).toBe(finish);

    fireEvent.click(finish);
    expect(api.markRead).toHaveBeenCalledWith("thread", { observedUpdatedAt: 123 });
    expect(screen.getByRole("button", { name: "Заканчиваем…" })).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Ещё вопрос" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: "Ещё вопрос", clientMessageId: expect.any(String) }),
      ),
    );

    resolveFinish?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Закончить" })).toBeEnabled());

    const finished = { ...unfinished, unread: false };
    context.state.snapshot.threads = [finished];
    context.state.details.thread.summary = finished;
    view.rerender(threadRoute());
    expect(screen.queryByRole("button", { name: "Закончить" })).toBeNull();
  });

  it("offers a fork only on the last non-empty completed agent reply of each completed turn", () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary, {
      turns: [
        {
          ...completedAgentTurn(),
          id: "eligible-turn",
          items: [
            { ...completedAgentTurn().items[0]!, id: "earlier", text: "Ранний ответ" },
            { ...completedAgentTurn().items[0]!, id: "last", text: "Последний ответ" },
            { ...completedAgentTurn().items[0]!, id: "empty", text: "  " },
          ],
        },
        {
          ...completedAgentTurn(),
          id: "failed-turn",
          status: "failed",
          items: [{ ...completedAgentTurn().items[0]!, id: "failed", text: "Ошибка" }],
        },
        {
          ...completedAgentTurn(),
          id: "active-turn",
          status: "inProgress",
          completedAt: null,
          items: [{ ...completedAgentTurn().items[0]!, id: "active", text: "Работаю" }],
        },
      ],
    });
    const view = renderThread();

    const fork = screen.getByRole("button", { name: "Создать ответвление отсюда" });
    expect(fork.closest("article")).toHaveTextContent("Последний ответ");
    expect(fork.closest("article")).not.toHaveTextContent("Ранний ответ");
    expect(fork.querySelector("svg")).not.toBeNull();

    const child = {
      ...summary,
      relation: {
        kind: "subagent" as const,
        sessionId: "child",
        parentThreadId: "parent",
        nickname: null,
        role: null,
      },
    };
    context.state.snapshot.threads = [child];
    context.state.details.thread.summary = child;
    view.rerender(threadRoute());
    expect(screen.queryByRole("button", { name: "Создать ответвление отсюда" })).toBeNull();
  });

  it("links a fork to its parent and shows a non-link fallback when the parent is unavailable", () => {
    const fork = {
      ...summary,
      relation: { kind: "session" as const, sessionId: "fork-tree", forkedFromId: "parent" },
    };
    const parent = { ...summary, id: "parent", title: "Родительская задача" };
    const context = mockThreadConnection(threadApi(), fork);
    context.state.snapshot.threads = [fork, parent];
    const view = renderThread();

    expect(screen.getByText("Проект")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Ответвление от Родительская задача" }),
    ).toHaveAttribute("href", "/threads/parent");

    context.state.snapshot.threads = [fork];
    view.rerender(threadRoute());

    expect(screen.queryByRole("link", { name: /Ответвление от/ })).toBeNull();
    expect(screen.getByText("Ответвление · Родитель недоступен")).toBeInTheDocument();
  });

  it("lists only direct forks by work priority, keeps archived forks last, and supports a middle node", () => {
    const middle = {
      ...summary,
      relation: {
        kind: "session" as const,
        sessionId: "fork-tree",
        forkedFromId: "grandparent",
      },
    };
    const grandparent = { ...summary, id: "grandparent", title: "Исходная задача" };
    const child = (
      id: string,
      title: string,
      state: ThreadSummary["state"],
      updatedAt: number,
      archived = false,
    ): ThreadSummary => ({
      ...summary,
      id,
      title,
      state,
      updatedAt,
      archived,
      relation: { kind: "session", sessionId: "fork-tree", forkedFromId: "thread" },
    });
    const children = [
      child("completed", "Недавно завершена", "completed", 100),
      child("queued", "В очереди", "queued", 8),
      child("running", "Выполняется", "running", 9),
      child("attention", "Нужно решение", "needsAttention", 10),
      child("idle", "Старая открытая", "idle", 7),
      child("archived", "Архивная", "completed", 1_000, true),
    ];
    const indirect = {
      ...child("grandchild", "Внук", "running", 2_000),
      relation: {
        kind: "session" as const,
        sessionId: "fork-tree",
        forkedFromId: "running",
      },
    };
    const context = mockThreadConnection(threadApi(), middle);
    context.state.snapshot.threads = [middle, grandparent, ...children, indirect];
    render(forkThreadRoute());

    expect(screen.getByRole("link", { name: "Ответвление от Исходная задача" })).toBeVisible();
    const trigger = screen.getByLabelText("Показать ответвления: 6");
    fireEvent.click(trigger);
    const popover = screen.getByText("Ответвления").parentElement!;
    const links = within(popover).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Нужно решение",
      "Выполняется",
      "В очереди",
      "Недавно завершена",
      "Старая открытая",
      "АрхивнаяАрхив",
    ]);
    expect(within(popover).queryByText("Внук")).toBeNull();

    fireEvent.click(within(popover).getByRole("link", { name: /Нужно решение/ }));
    expect(screen.getByTestId("fork-location")).toHaveTextContent("/threads/attention:true");
  });

  it("offers a fork on a completed plan alongside all implementation choices", async () => {
    const api = threadApi();
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    mockThreadConnection(api, planThread, completedPlanDetail());
    renderThread();

    const fork = screen.getByRole("button", { name: "Создать ответвление отсюда" });
    expect(fork.closest("article")).toHaveClass("plan");
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Запустить в режиме цели" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Запустить в режиме оркестратора" }),
    ).toBeInTheDocument();

    fireEvent.click(fork);

    await waitFor(() =>
      expect(api.estimateFork).toHaveBeenCalledWith("thread", {
        lastTurnId: "plan-turn",
        agentMessageId: "plan",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Создать ветку" })).toBeVisible();
  });

  it("creates one reliable operation, dispatches it, and navigates to the pending route", async () => {
    let resolveFork: ((value: { operation: ForkOperationSummary }) => void) | undefined;
    const api = threadApi();
    api.createForkOperation.mockReturnValue(
      new Promise<{ operation: ForkOperationSummary }>((resolve) => {
        resolveFork = resolve;
      }),
    );
    const context = mockThreadConnection(api, summary, {
      turns: [
        { ...completedAgentTurn(), id: "first-turn" },
        {
          ...completedAgentTurn(),
          id: "second-turn",
          items: [{ ...completedAgentTurn().items[0]!, id: "second-answer" }],
        },
      ],
    });
    const operation: ForkOperationSummary = {
      id: "fork-operation",
      sourceThreadId: "thread",
      lastTurnId: "second-turn",
      agentMessageId: "second-answer",
      mode: "compressed",
      status: "preparing",
      title: "",
      createdAt: 3,
      updatedAt: 3,
      targetThreadId: null,
      queuedMessageCount: 0,
      estimate: null,
      error: null,
    };
    render(forkThreadRoute());

    const buttons = screen.getAllByRole("button", { name: "Создать ответвление отсюда" });
    fireEvent.click(buttons[1]!);
    await screen.findByRole("dialog", { name: "Создать ветку" });
    await waitFor(() => expect(screen.getByRole("radio", { name: /Компактная/ })).toBeChecked());
    const create = screen.getByRole("button", { name: "Создать ветку" });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(api.createForkOperation).toHaveBeenCalledOnce();
    expect(api.createForkOperation).toHaveBeenCalledWith("thread", {
      operationId: expect.any(String),
      lastTurnId: "second-turn",
      agentMessageId: "second-answer",
      mode: "compressed",
    });
    expect(create).toBeDisabled();

    await act(async () => resolveFork?.({ operation }));

    expect(context.dispatch).toHaveBeenCalledWith({ type: "forkOperation", operation });
    await waitFor(() =>
      expect(screen.getByTestId("fork-location")).toHaveTextContent(
        "/fork-operations/fork-operation:true",
      ),
    );
  });

  it("surfaces operation creation errors without navigating and restores Create", async () => {
    const api = threadApi();
    api.createForkOperation.mockRejectedValue(new Error("Не удалось создать fork"));
    mockThreadConnection(api, summary, { turns: [completedAgentTurn()] });
    render(forkThreadRoute());

    fireEvent.click(screen.getByRole("button", { name: "Создать ответвление отсюда" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Компактная/ })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Создать ветку" }));

    expect(await screen.findByText("Не удалось создать fork")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать ветку" })).toBeEnabled();
    expect(screen.getByTestId("fork-location")).toHaveTextContent("/threads/thread:false");
  });

  it("treats a newer in-progress detail turn as running when the snapshot is stale", () => {
    const staleCompleted = {
      ...summary,
      state: "completed" as const,
      unread: true,
      updatedAt: 2_000,
    };
    const context = mockThreadConnection(threadApi(), staleCompleted, {
      turns: [
        {
          id: "new-turn",
          status: "inProgress",
          startedAt: 2_000,
          completedAt: null,
          durationMs: null,
          progress: { ...progress(), startedAt: 2_000 },
          items: [],
        },
      ],
    });
    context.state.details.thread.summary = {
      ...staleCompleted,
      state: "running",
      unread: false,
      updatedAt: 2_000,
      currentTurnId: "new-turn",
    };

    renderThread();

    expect(screen.queryByRole("button", { name: "Закончить" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Направить текущую задачу" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Остановить задачу" })).toBeInTheDocument();
  });

  it("keeps an interrupted session purple until the user finishes it", () => {
    const api = threadApi();
    const interrupted = {
      ...summary,
      state: "interrupted" as const,
      unread: true,
      updatedAt: 123,
    };
    const context = mockThreadConnection(api, interrupted, {
      turns: [
        {
          id: "interrupted-turn",
          status: "interrupted",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [],
        },
      ],
    });
    const view = renderThread();

    expect(api.markRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Закончить" }));
    expect(api.markRead).toHaveBeenCalledWith("thread", { observedUpdatedAt: 123 });

    const finished = { ...interrupted, unread: false };
    context.state.snapshot.threads = [finished];
    context.state.details.thread.summary = finished;
    view.rerender(threadRoute());
    expect(screen.queryByRole("button", { name: "Закончить" })).toBeNull();
  });

  it("keeps a failed session pending until the user finishes it", () => {
    const api = threadApi();
    mockThreadConnection(
      api,
      {
        ...summary,
        state: "failed",
        unread: true,
        updatedAt: 123,
      },
      {
        turns: [
          {
            id: "failed-turn",
            status: "failed",
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
            progress: progress(),
            items: [],
          },
        ],
      },
    );

    renderThread();

    expect(api.markRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Закончить" }));
    expect(api.markRead).toHaveBeenCalledWith("thread", { observedUpdatedAt: 123 });
  });

  it("keeps the finish action available when marking the session fails", async () => {
    const api = threadApi();
    api.markRead.mockRejectedValue(new Error("Сервер недоступен"));
    mockThreadConnection(api, {
      ...summary,
      state: "completed",
      unread: true,
      updatedAt: 123,
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Закончить" }));

    expect(await screen.findByText("Сервер недоступен")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закончить" })).toBeEnabled();
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(api.interrupt).not.toHaveBeenCalled();
  });

  it("does not expose permanent session deletion", () => {
    const api = threadApi();
    mockThreadConnection(api, { ...summary, title: "Без названия", preview: "" });
    renderThread();

    fireEvent.click(screen.getByLabelText("Действия с задачей"));
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
  });

  it("shows a subagent transcript as read-only and links back to its parent", () => {
    const api = threadApi();
    const child: ThreadSummary = {
      ...summary,
      title: "Worker",
      relation: {
        kind: "subagent",
        sessionId: "child-session",
        parentThreadId: "parent",
        nickname: "reviewer",
        role: "worker",
      },
    };
    const context = mockThreadConnection(api, child, {
      olderTurnsCursor: "parent-history",
      turns: [
        {
          id: "child-turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "userMessage",
              id: "input",
              status: "completed",
              text: "Проверь результат",
              images: [],
              timestamp: 1,
              phase: null,
            },
            {
              type: "reasoning",
              id: "reasoning",
              status: "completed",
              text: "Скрытое рассуждение",
              images: [],
              timestamp: 1,
              phase: null,
            },
            {
              type: "agentMessage",
              id: "commentary",
              status: "completed",
              text: "Проверяю результат",
              images: [],
              timestamp: 1,
              phase: "commentary",
            },
            {
              type: "command",
              id: "command",
              status: "completed",
              kind: "command",
              command: "npm test",
              cwd: "/work",
              output: "passed",
              exitCode: 0,
            },
            {
              type: "tool",
              id: "tool",
              status: "completed",
              title: "Внутренний инструмент",
              detail: "Служебные детали",
            },
            {
              type: "plan",
              id: "plan",
              status: "completed",
              text: "Скрытый план",
              images: [],
              timestamp: 1,
              phase: null,
            },
            {
              type: "fileChange",
              id: "file",
              status: "completed",
              path: "/work/file.ts",
              patch: "+change",
            },
            {
              type: "planChecklist",
              id: "checklist",
              status: "completed",
              explanation: "Скрытый checklist",
              steps: [{ step: "Скрытый шаг", status: "completed" }],
              timestamp: 1,
              afterItemId: null,
            },
            {
              type: "userInputResponse",
              id: "response",
              status: "completed",
              entries: [
                {
                  header: "Скрытый ответ",
                  question: "Скрытый вопрос",
                  answers: ["Скрытое значение"],
                },
              ],
              timestamp: 1,
              afterItemId: null,
            },
            {
              type: "error",
              id: "error",
              status: "failed",
              message: "Скрытая ошибка",
            },
            {
              type: "agentMessage",
              id: "answer",
              status: "completed",
              text: "Результат субагента",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
        {
          id: "technical-only",
          status: "completed",
          startedAt: 3,
          completedAt: 4,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "tool",
              id: "technical-tool",
              status: "completed",
              title: "Только техническое действие",
              detail: "",
            },
          ],
        },
      ],
    });
    context.state.snapshot.threads.push({
      ...summary,
      id: "parent",
      title: "Главная сессия",
    });

    const view = renderThread();

    const input = screen.getByText("Проверь результат").closest("article")!;
    const commentary = screen.getByText("Проверяю результат").closest("article")!;
    const answer = screen.getByText("Результат субагента").closest("article")!;
    expect(input).toHaveClass("userMessage");
    expect(commentary).toHaveClass("agentMessage");
    expect(answer).toHaveClass("agentMessage");
    expect(
      input.compareDocumentPosition(commentary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      commentary.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Результат субагента")).toBeInTheDocument();
    for (const hidden of [
      "Скрытое рассуждение",
      "Внутренний инструмент",
      "Скрытый план",
      "Скрытый checklist",
      "Скрытый шаг",
      "Скрытый ответ",
      "Скрытая ошибка",
      "Только техническое действие",
    ]) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
    expect(view.container.querySelectorAll(".turn")).toHaveLength(2);
    expect(view.container.querySelectorAll(".turn-activity-static")).toHaveLength(2);
    expect(screen.getAllByText("Готово за 0с")).toHaveLength(2);
    expect(screen.queryByLabelText("Технические детали")).toBeNull();
    expect(view.container.querySelector(".turn-timing")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Сообщение для Codex" })).toBeNull();
    expect(screen.queryByLabelText("Действия с задачей")).toBeNull();
    expect(
      screen.getByText(
        "Субагент управляется родительской сессией. Здесь доступен только просмотр.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Открыть родительскую сессию/ })).toHaveAttribute(
      "href",
      "/threads/parent",
    );
    expect(api.readGoal).not.toHaveBeenCalled();
    expect(api.updateThreadDraft).not.toHaveBeenCalled();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    fireEvent.wheel(scroll, { deltaY: -30 });
    scroll.scrollTop = 0;
    fireEvent.scroll(scroll);
    expect(context.loadOlderDetail).not.toHaveBeenCalled();
  });

  it("keeps live status and approval requests in the filtered subagent view", () => {
    const api = threadApi();
    const child: ThreadSummary = {
      ...summary,
      state: "running",
      currentTurnId: "child-turn",
      relation: {
        kind: "subagent",
        sessionId: "child-session",
        parentThreadId: "parent",
        nickname: null,
        role: "worker",
      },
    };
    mockThreadConnection(api, child, {
      turns: [
        {
          id: "child-turn",
          status: "inProgress",
          startedAt: Date.now() - 1_000,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            {
              type: "tool",
              id: "running-tool",
              status: "inProgress",
              title: "Скрытый активный инструмент",
              detail: "",
            },
          ],
        },
      ],
      attention: [
        {
          id: "child-attention",
          threadId: "thread",
          turnId: "child-turn",
          itemId: null,
          createdAt: 1,
          kind: "commandApproval",
          command: "npm test",
          cwd: "/work",
          reason: null,
          networkHost: null,
          canAcceptForSession: false,
          proposedPolicyChanges: [],
        },
      ],
    });

    renderThread();

    expect(screen.queryByText("Скрытый активный инструмент")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Codex работает");
    expect(screen.queryByLabelText("Технические детали")).toBeNull();
    expect(screen.getByRole("region", { name: "Требуется внимание" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Разрешить один раз" })).toBeInTheDocument();
  });

  it("loads Git changes when the inspector opens and refreshes after a turn completes", async () => {
    const api = threadApi();
    api.readGitChanges
      .mockResolvedValueOnce({ state: "dirty", filesChanged: 1, additions: 2, deletions: 1 })
      .mockResolvedValueOnce({ state: "clean", filesChanged: 0, additions: 0, deletions: 0 });
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    const view = renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    await waitFor(() => expect(api.readGitChanges).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("1 файл")).toBeInTheDocument();

    const completed = { ...summary, state: "completed" as const, updatedAt: 3 };
    context.state.snapshot.threads = [completed];
    context.state.details.thread.summary = completed;
    view.rerender(threadRoute());

    await waitFor(() => expect(api.readGitChanges).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Нет изменений")).toBeInTheDocument();
  });

  it("keeps the inspector closed until the user opens it on wide screens", () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    mockThreadConnection(threadApi(), summary);
    renderThread();

    expect(screen.queryByLabelText("Сведения о задаче")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    expect(screen.getByLabelText("Сведения о задаче")).toBeInTheDocument();
  });

  it("loads semantic artifacts lazily without loading historical turns", async () => {
    const api = threadApi();
    api.readThreadArtifacts.mockResolvedValueOnce({
      capability: "explicit",
      artifacts: [
        {
          id: "artifact-latest",
          label: "Свежий отчёт",
          path: "/work/project/reports/latest.md",
          relativePath: "reports/latest.md",
          fileName: "latest.md",
          turnId: "latest",
          createdAt: 1,
        },
      ],
    });
    const context = mockThreadConnection(api, summary, {
      olderTurnsCursor: "older-1",
      turns: [
        {
          id: "latest",
          status: "completed",
          startedAt: 30,
          completedAt: 40,
          durationMs: 10,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "latest-answer",
              status: "completed",
              text: "[universe.rs:183](/work/project/src/universe.rs)",
              images: [],
              timestamp: 40,
              phase: "final_answer",
            },
            {
              type: "reasoning",
              id: "reasoning-link",
              status: "completed",
              text: "[Проверка](/work/project/checks/reasoning.log)",
              images: [],
              timestamp: 39,
              phase: null,
            },
            {
              type: "plan",
              id: "plan-link",
              status: "completed",
              text: "[Пункт плана](/work/project/plan.md)",
              images: [],
              timestamp: 38,
              phase: null,
            },
          ],
        },
      ],
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    expect(api.readThreadArtifacts).not.toHaveBeenCalled();
    expect(context.loadOlderDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Артефакты" }));

    await waitFor(() => expect(api.readThreadArtifacts).toHaveBeenCalledWith("thread"));
    expect(context.loadOlderDetail).not.toHaveBeenCalled();
    const inspector = screen.getByLabelText("Сведения о задаче");
    expect(within(inspector).getByText("reports/latest.md")).toBeInTheDocument();
    expect(within(inspector).queryByText("src/universe.rs")).not.toBeInTheDocument();
    expect(within(inspector).queryByText("checks/reasoning.log")).not.toBeInTheDocument();
    expect(within(inspector).queryByText("plan.md")).not.toBeInTheDocument();
    expect(within(inspector).getByRole("tab", { name: "Артефакты, 1" })).toBeInTheDocument();
  });

  it("refreshes semantic artifacts when a turn completes while the tab is open", async () => {
    const api = threadApi();
    api.readThreadArtifacts
      .mockResolvedValueOnce({ capability: "explicit", artifacts: [] })
      .mockResolvedValueOnce({
        capability: "explicit",
        artifacts: [
          {
            id: "artifact-result",
            label: "Результат",
            path: "/work/project/result.pdf",
            relativePath: "result.pdf",
            fileName: "result.pdf",
            turnId: "turn",
            createdAt: 1,
          },
        ],
      });
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    const view = renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    fireEvent.click(screen.getByRole("tab", { name: "Артефакты" }));
    await waitFor(() => expect(api.readThreadArtifacts).toHaveBeenCalledTimes(1));

    const completed = {
      ...running,
      state: "completed" as const,
      currentTurnId: null,
      updatedAt: 3,
    };
    context.state.snapshot.threads = [completed];
    context.state.details.thread.summary = completed;
    view.rerender(threadRoute());

    await waitFor(() => expect(api.readThreadArtifacts).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Результат")).toBeInTheDocument();
  });

  it("returns from an inspector artifact preview to the artifact shelf", async () => {
    const api = threadApi();
    api.createDownload.mockResolvedValueOnce({
      downloadUrl: "/downloads/ticket/report.md",
      expiresAt: 61_000,
      fileName: "report.md",
      size: 8,
    });
    api.readThreadArtifacts.mockResolvedValueOnce({
      capability: "explicit",
      artifacts: [
        {
          id: "artifact-report",
          label: "Отчёт",
          path: "/work/project/report.md",
          relativePath: "report.md",
          fileName: "report.md",
          turnId: "turn",
          createdAt: 1,
        },
      ],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("# Report", { status: 200 })));
    mockThreadConnection(api, summary, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "answer",
              status: "completed",
              text: "[Отчёт](/work/project/report.md)",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    fireEvent.click(screen.getByRole("tab", { name: "Артефакты" }));
    await screen.findByRole("tab", { name: "Артефакты, 1" });
    const inspector = screen.getByLabelText("Сведения о задаче");
    fireEvent.click(within(inspector).getByRole("button", { name: "Открыть report.md" }));

    expect(await screen.findByRole("heading", { name: "Report" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Вернуться к артефактам" }));

    const reopened = await screen.findByLabelText("Сведения о задаче");
    const artifactButton = within(reopened).getByRole("button", { name: "Открыть report.md" });
    await waitFor(() => expect(artifactButton).toHaveFocus());
  });

  it("forces an authoritative session refresh from the header", async () => {
    const context = mockThreadConnection(threadApi(), summary);
    renderThread();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Принудительно обновить сессию",
      }),
    );

    expect(
      screen.getByRole("button", {
        name: "Обновляем состояние сессии",
      }),
    ).toBeDisabled();
    await waitFor(() => expect(context.forceRefreshDetail).toHaveBeenCalledWith("thread"));
    expect(
      await screen.findByRole("button", {
        name: "Принудительно обновить сессию",
      }),
    ).toBeEnabled();
  });

  it("keeps a known session after a refresh returns not found", async () => {
    const context = mockThreadConnection(threadApi(), summary);
    context.forceRefreshDetail.mockRejectedValue(
      new ApiClientError("not_found", "Thread not found", 404),
    );
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Принудительно обновить сессию" }));

    await waitFor(() => expect(context.forceRefreshDetail).toHaveBeenCalledWith("thread"));
    expect(context.dispatch).not.toHaveBeenCalledWith({
      type: "thread.remove",
      threadId: "thread",
    });
    expect(screen.getByText("Тестовая задача")).toBeInTheDocument();
  });

  it("restores a local draft and offers retry when history cannot be loaded", async () => {
    const context = mockThreadConnection(threadApi(), summary);
    Reflect.deleteProperty(context.state.details, "thread");
    context.refreshDetail.mockRejectedValue(
      new ApiClientError("not_found", "Session history is unavailable", 404),
    );
    loadLocalDraft.mockResolvedValue({
      value: { input: "Черновик без истории", images: [], annotations: [], goalMode: false },
      updatedAt: 2,
    });
    renderThread();
    expect(await screen.findByDisplayValue("Черновик без истории")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Повторить загрузку истории" }),
    ).toBeInTheDocument();
    context.refreshDetail.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку истории" }));
    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(2));
    expect(screen.getByDisplayValue("Черновик без истории")).toBeInTheDocument();
  });

  it("shows a preserved failed message with a copy action instead of only a sending spinner", () => {
    mockThreadConnection(threadApi(), summary, {
      queuedMessages: [
        {
          id: "failed",
          threadId: "thread",
          text: "Принятое сообщение",
          createdAt: 1,
          status: "dispatching",
          deliveryError: { message: "Сессия недоступна. Сообщение сохранено.", retryable: false },
        },
      ],
    });
    renderThread();
    expect(screen.getByText("Принятое сообщение")).toBeInTheDocument();
    expect(screen.getByText("Сессия недоступна. Сообщение сохранено.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Скопировать сообщение" })).toBeEnabled();
  });

  it("opens the replacement session when retrying a preserved first message", async () => {
    const api = threadApi();
    api.sendQueuedNow.mockResolvedValue({
      turnId: "recovered-turn",
      thread: { ...summary, id: "recovered" },
    });
    const context = mockThreadConnection(api, summary, {
      queuedMessages: [
        {
          id: "saved",
          threadId: "thread",
          text: "Первое сообщение",
          createdAt: 1,
          status: "queued",
          deliveryError: { message: "Сессия недоступна. Сообщение сохранено.", retryable: false },
        },
      ],
    });
    render(forkThreadRoute());
    fireEvent.click(screen.getByRole("button", { name: "Отправить сейчас" }));
    await waitFor(() =>
      expect(screen.getByTestId("fork-location")).toHaveTextContent("/threads/recovered:true"),
    );
    expect(context.dispatch).toHaveBeenCalledWith({
      type: "thread",
      thread: expect.objectContaining({ id: "recovered" }),
    });
  });

  it("allows retrying a confirmed stalled message while keeping edit and delete disabled", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary, {
      queuedMessages: [
        {
          id: "stalled",
          threadId: "thread",
          text: "Сохранённое сообщение",
          createdAt: 1,
          status: "dispatching",
          images: ["data:image/png;base64,AA=="],
          deliveryError: { message: "Проверяем, было ли сообщение отправлено.", retryable: false },
        },
      ],
    });
    renderThread();
    const retry = screen.getByRole("button", { name: "Повторить отправку" });
    expect(retry).toBeEnabled();
    expect(screen.getByRole("button", { name: "Изменить сообщение в очереди" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Удалить сообщение из очереди" })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(api.sendQueuedNow).toHaveBeenCalledWith("thread", "stalled", true));
    expect(api.sendQueuedNow).toHaveBeenCalledOnce();
  });

  it("keeps retry disabled while a confirmed message is still being dispatched", () => {
    mockThreadConnection(threadApi(), summary, {
      queuedMessages: [
        {
          id: "sending",
          threadId: "thread",
          text: "Ещё отправляется",
          createdAt: 1,
          status: "dispatching",
        },
      ],
    });
    renderThread();
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить сейчас" })).toBeDisabled();
  });

  it("shows a local draft even when the missing session has no summary", async () => {
    const context = mockThreadConnection(threadApi(), summary);
    context.state.snapshot.threads = [];
    Reflect.deleteProperty(context.state.details, "thread");
    context.refreshDetail.mockRejectedValue(
      new ApiClientError("not_found", "Session history is unavailable", 404),
    );
    loadLocalDraft.mockResolvedValue({
      value: {
        input: "Доступен для копирования",
        images: [{ id: "draft-image", url: "data:image/png;base64,aW1hZ2U=" }],
        annotations: [],
        goalMode: false,
      },
      updatedAt: 2,
    });
    renderThread();
    expect(await screen.findByDisplayValue("Доступен для копирования")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(document.querySelector('img[src="data:image/png;base64,aW1hZ2U="]')).not.toBeNull();
    expect(
      await screen.findByRole("button", { name: "Повторить загрузку истории" }),
    ).toBeInTheDocument();
  });

  it("refreshes Git changes when the active turn diff changes", async () => {
    const api = threadApi();
    api.readGitChanges
      .mockResolvedValueOnce({ state: "clean", filesChanged: 0, additions: 0, deletions: 0 })
      .mockResolvedValueOnce({ state: "dirty", filesChanged: 2, additions: 4, deletions: 1 })
      .mockResolvedValueOnce({ state: "clean", filesChanged: 0, additions: 0, deletions: 0 });
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [],
        },
      ],
    });
    const view = renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Показать сведения" }));
    await waitFor(() => expect(api.readGitChanges).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Нет изменений")).toBeInTheDocument();

    context.state.details.thread.turns[0]!.progress = {
      ...progress(),
      filesChanged: 2,
      additions: 4,
      deletions: 1,
    };
    view.rerender(threadRoute());

    await waitFor(() => expect(api.readGitChanges).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("2 файла")).toBeInTheDocument();

    context.state.details.thread.turns[0]!.progress = {
      ...context.state.details.thread.turns[0]!.progress,
      explanation: "Счётчики не изменились",
    };
    view.rerender(threadRoute());
    expect(api.readGitChanges).toHaveBeenCalledTimes(2);

    context.state.details.thread.turns[0]!.progress = progress();
    view.rerender(threadRoute());

    await waitFor(() => expect(api.readGitChanges).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Нет изменений")).toBeInTheDocument();
  });

  it("queues and interrupts a running task", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, {
      ...summary,
      state: "running",
      currentTurnId: "turn",
    });
    renderThread();

    const textbox = screen.getByRole("textbox", { name: "Направить текущую задачу" });
    fireEvent.change(textbox, {
      target: { value: "Сначала проверь тесты" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));
    await waitFor(() => expect(textbox).toHaveValue(""));
    await waitFor(() =>
      expect(context.dispatch).toHaveBeenCalledWith({
        type: "optimistic.add",
        message: expect.objectContaining({
          text: "Сначала проверь тесты",
          destination: "queue",
        }),
      }),
    );
    await waitFor(() =>
      expect(api.enqueue).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          input: "Сначала проверь тесты",
          clientMessageId: expect.any(String),
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Остановить задачу" }));
    expect(api.interrupt).toHaveBeenCalledWith("thread", "turn");
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Включить командный режим" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Модель и уровень рассуждений" })).toBeDisabled();
  });

  it("stops a running task with Escape", async () => {
    const api = threadApi();
    mockThreadConnection(api, {
      ...summary,
      state: "running",
      currentTurnId: "turn",
    });
    renderThread();

    const textbox = screen.getByRole("textbox", { name: "Направить текущую задачу" });
    fireEvent.keyDown(textbox, { key: "Escape" });

    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith("thread", "turn"));
    expect(api.interrupt).toHaveBeenCalledTimes(1);
  });

  it("stops a Team orchestration while the parent is between turns", async () => {
    const api = threadApi();
    mockThreadConnection(api, {
      ...summary,
      state: "running",
      currentTurnId: null,
      settings: { ...summary.settings, collaborationMode: "team" },
    });
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Остановить задачу" }));

    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith("thread", undefined));
  });

  it("explains why a running Team orchestration cannot be disabled", async () => {
    const api = threadApi();
    const warning =
      "Нельзя выключить Team, пока субагенты работают или их результаты ещё не обработаны. Попросите главного агента завершить или отменить их.";
    api.updateThreadSettings.mockRejectedValueOnce(new Error(warning));
    mockThreadConnection(api, {
      ...summary,
      state: "running",
      currentTurnId: null,
      settings: { ...summary.settings, collaborationMode: "team" },
    });
    renderThread();

    const team = screen.getByRole("button", { name: "Выключить командный режим" });
    expect(team).toBeEnabled();
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Модель и уровень рассуждений" })).toBeDisabled();

    fireEvent.click(team);

    await waitFor(() =>
      expect(api.updateThreadSettings).toHaveBeenCalledWith("thread", {
        collaborationMode: "default",
      }),
    );
    expect(await screen.findByText(warning)).toBeInTheDocument();
    expect(team).toHaveAttribute("aria-pressed", "true");
  });

  it("restores the complete draft and debounces rapid text into one latest local and server save", async () => {
    vi.useFakeTimers();
    try {
      const api = threadApi();
      const annotation = pendingAnnotation();
      mockThreadConnection(api, summary, {
        turns: [completedAgentTurn()],
        draft: {
          input: "Сохранённый текст",
          images: [
            {
              id: "draft-image",
              name: "draft.png",
              url: "data:image/png;base64,AA==",
            },
          ],
          goalMode: true,
          annotations: [annotation],
          updatedAt: 10,
        },
      });
      renderThread();

      const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
      expect(textbox).toHaveValue("Сохранённый текст");
      expect(screen.getByAltText("draft.png")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Выключить режим цели" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Аннотация 1" })).toBeInTheDocument();

      fireEvent.change(textbox, { target: { value: "О" } });
      fireEvent.change(textbox, { target: { value: "Обновлённый" } });
      fireEvent.change(textbox, { target: { value: "Обновлённый текст" } });
      expect(saveLocalDraft).not.toHaveBeenCalled();
      expect(api.updateThreadDraft).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(499));
      expect(saveLocalDraft).not.toHaveBeenCalled();
      expect(api.updateThreadDraft).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(saveLocalDraft).toHaveBeenCalledTimes(1);
      expect(saveLocalDraft).toHaveBeenCalledWith(
        api.settings,
        "thread",
        expect.objectContaining({
          input: "Обновлённый текст",
          images: [expect.objectContaining({ name: "draft.png" })],
          goalMode: true,
          annotations: [annotation],
        }),
        expect.any(Number),
      );
      expect(api.updateThreadDraft).toHaveBeenCalledTimes(1);
      expect(api.updateThreadDraft).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          input: "Обновлённый текст",
          images: [expect.objectContaining({ name: "draft.png" })],
          goalMode: true,
          annotations: [annotation],
        }),
        { keepalive: false },
      );
      expect(saveLocalDraft.mock.invocationCallOrder[0]!).toBeLessThan(
        api.updateThreadDraft.mock.invocationCallOrder[0]!,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps completed agent and plan history memoized across input and unrelated state", () => {
    let agentTextReads = 0;
    let planTextReads = 0;
    const agentMessage: Parameters<typeof Activity>[0]["item"] = {
      ...completedAgentTurn().items[0]!,
      get text() {
        agentTextReads += 1;
        return "Старый ответ";
      },
    };
    const planMessage: Parameters<typeof Activity>[0]["item"] = {
      type: "plan",
      id: "stable-plan",
      status: "completed",
      get text() {
        planTextReads += 1;
        return "# Стабильный план";
      },
      images: [],
      timestamp: 2,
      phase: null,
    };
    mockThreadConnection(
      threadApi(),
      { ...summary, settings: { collaborationMode: "plan" } },
      {
        turns: [
          { ...completedAgentTurn(), id: "agent-turn", items: [agentMessage] },
          { ...completedAgentTurn(), id: "plan-turn", items: [planMessage] },
        ],
      },
    );
    const view = renderThread();
    const readsAfterInitialRender = { agent: agentTextReads, plan: planTextReads };

    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, {
      target: { value: "Новый черновик" },
    });
    expect({ agent: agentTextReads, plan: planTextReads }).toEqual(readsAfterInitialRender);

    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 100 },
    });
    fireEvent.wheel(scroll, { deltaY: -30 });
    scroll.scrollTop = 0;
    fireEvent.scroll(scroll);

    expect(
      screen.getByRole("button", { name: "Прокрутить к последнему сообщению" }),
    ).toBeInTheDocument();
    expect(textbox).toHaveValue("Новый черновик");
    expect({ agent: agentTextReads, plan: planTextReads }).toEqual(readsAfterInitialRender);
  });

  it("flushes the latest text immediately when the document becomes hidden", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    renderThread();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textbox, { target: { value: "Черновик" } });
    fireEvent.change(textbox, { target: { value: "Последний скрытый черновик" } });
    expect(saveLocalDraft).not.toHaveBeenCalled();
    expect(api.updateThreadDraft).not.toHaveBeenCalled();

    const previousVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(saveLocalDraft).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(api.updateThreadDraft).toHaveBeenCalledWith(
          "thread",
          expect.objectContaining({ input: "Последний скрытый черновик" }),
          { keepalive: true },
        ),
      );
    } finally {
      if (previousVisibility) {
        Object.defineProperty(document, "visibilityState", previousVisibility);
      } else {
        delete (document as unknown as Record<string, unknown>).visibilityState;
      }
    }
  });

  it("coalesces draft revisions queued behind a slow save", async () => {
    const api = threadApi();
    const saves: Array<{
      draft: UpdateThreadDraftRequest;
      resolve(value: ThreadDraft | null): void;
    }> = [];
    api.updateThreadDraft.mockImplementation(
      (_id, draft) =>
        new Promise<ThreadDraft | null>((resolve) => {
          saves.push({ draft, resolve });
        }),
    );
    const context = mockThreadConnection(api, summary);
    renderThread();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textbox, { target: { value: "Первая версия" } });
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    await waitFor(() => expect(saves).toHaveLength(1));

    fireEvent.change(textbox, { target: { value: "Вторая версия" } });
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    fireEvent.change(textbox, { target: { value: "Последняя версия" } });
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    expect(saves).toHaveLength(1);

    await act(async () => {
      saves[0]!.resolve({ ...saves[0]!.draft, updatedAt: 10 });
      await Promise.resolve();
    });
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]!.draft.input).toBe("Последняя версия");
    expect(
      context.dispatch.mock.calls.some(
        ([action]) => action.type === "draft" && action.draft?.input === "Первая версия",
      ),
    ).toBe(false);

    await act(async () => {
      saves[1]!.resolve({ ...saves[1]!.draft, updatedAt: 20 });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(context.dispatch).toHaveBeenCalledWith({
        type: "draft",
        threadId: "thread",
        draft: expect.objectContaining({ input: "Последняя версия" }),
      }),
    );
    expect(saves).toHaveLength(2);
  });

  it("sends image-only messages, keeps attachments after errors, and clears them after success", async () => {
    const api = threadApi();
    api.startTurn
      .mockRejectedValueOnce(new Error("Сеть недоступна"))
      .mockResolvedValueOnce({ turnId: "turn" });
    mockThreadConnection(api, summary);
    const view = renderThread();
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(fileInput, {
      target: { files: [new File(["image"], "screen.png", { type: "image/png" })] },
    });
    expect(await screen.findByAltText("screen.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Сеть недоступна")).toBeInTheDocument();
    expect(screen.getByAltText("screen.png")).toBeInTheDocument();
    expect(api.startTurn.mock.calls[0]?.[1]).toMatchObject({
      input: "",
      images: [expect.stringMatching(/^data:image\/png;base64,/)],
    });

    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(screen.queryByAltText("screen.png")).toBeNull());
  });

  it("uploads and sends a file-only message", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    const view = renderThread();
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(fileInput, {
      target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] },
    });

    expect(
      await screen.findByRole("button", { name: "Удалить файл notes.txt" }),
    ).toBeInTheDocument();
    expect(api.uploadAttachment).toHaveBeenCalledWith("thread", expect.any(File));
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          input: "",
          files: [expect.objectContaining({ name: "notes.txt", path: "/attachments/notes.txt" })],
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Удалить файл notes.txt" })).toBeNull(),
    );
  });

  it("does not roll back a delivered message when local draft cleanup rejects", async () => {
    deleteLocalDraft.mockRejectedValueOnce(new Error("IndexedDB недоступен"));
    const api = threadApi();
    const context = mockThreadConnection(api, summary);
    renderThread();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Уже доставлено" } });

    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() => expect(api.startTurn).toHaveBeenCalledOnce());
    await waitFor(() => expect(textbox).toHaveValue(""));
    expect(screen.queryByText("IndexedDB недоступен")).not.toBeInTheDocument();
    expect(context.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "optimistic.remove",
      }),
    );
  });

  it("keeps task settings in the composer without permission controls", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    renderThread();

    expect(
      screen.queryByRole("combobox", { name: "Уровень подтверждений" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
    const modelDialog = screen.getByRole("dialog", { name: "Настройки модели" });
    expect(within(modelDialog).getByRole("radiogroup", { name: "Модель" })).toBeInTheDocument();
    expect(
      within(modelDialog).getByRole("radiogroup", { name: "Уровень рассуждений" }),
    ).toBeInTheDocument();
    fireEvent.click(within(modelDialog).getByRole("button", { name: "Закрыть" }));
    expect(
      screen.queryByRole("combobox", { name: "Проверка подтверждений" }),
    ).not.toBeInTheDocument();
    const plan = screen.getByRole("button", { name: "Включить режим планирования" });
    expect(plan).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(plan);
    await waitFor(() =>
      expect(api.updateThreadSettings).toHaveBeenCalledWith("thread", {
        collaborationMode: "plan",
      }),
    );
  });

  it.each(["saved", "failed"])(
    "blocks message dispatch until a model change is settled: %s",
    async (outcome) => {
      const api = threadApi();
      const context = mockThreadConnection(api, summary, {
        queuedMessages: [
          { id: "queued", threadId: "thread", text: "В очереди", createdAt: 1, status: "queued" },
        ],
      });
      context.state.snapshot.models.push({
        ...context.state.snapshot.models[0]!,
        id: "gpt-6-astra",
        displayName: "6astra",
        isDefault: false,
      });
      let resolveSettings!: (thread: ThreadSummary) => void;
      let rejectSettings!: (error: Error) => void;
      api.updateThreadSettings.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveSettings = resolve;
            rejectSettings = reject;
          }),
      );
      renderThread();
      expect(screen.getByRole("button", { name: "Отправить сейчас" })).toBeEnabled();
      const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
      fireEvent.change(textbox, { target: { value: "Первое сообщение" } });
      fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
      fireEvent.click(screen.getByRole("radio", { name: "6astra" }));
      expect(api.updateThreadSettings).toHaveBeenCalledWith("thread", { model: "gpt-6-astra" });
      fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));

      expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Отправить сейчас" })).not.toBeInTheDocument();
      fireEvent.keyDown(textbox, { key: "Enter" });
      fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });
      expect(context.sendReliable).not.toHaveBeenCalled();
      expect(textbox).toHaveValue("Первое сообщение");

      const configured = { ...summary, settings: { ...summary.settings, model: "gpt-6-astra" } };
      await act(async () => {
        if (outcome === "saved") resolveSettings(configured);
        else rejectSettings(new Error("Модель недоступна"));
      });
      expect(context.sendReliable).not.toHaveBeenCalled();
      expect(textbox).toHaveValue("Первое сообщение");
      if (outcome === "failed") {
        expect(screen.getByText("Модель недоступна")).toBeInTheDocument();
        return;
      }
      expect(context.dispatch).toHaveBeenCalledWith({ type: "thread", thread: configured });
      expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Отправить сейчас" })).toBeEnabled();
      fireEvent.keyDown(textbox, { key: "Enter" });
      await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
    },
  );

  it("shows native goal state and exposes pause and clear actions", async () => {
    const api = threadApi();
    api.updateGoal.mockResolvedValue({
      threadId: "thread",
      objective: "Завершить интерфейс",
      status: "paused",
      tokenBudget: null,
      tokensUsed: 120,
      timeUsedSeconds: 15,
      createdAt: 1,
      updatedAt: 2,
    });
    const context = mockThreadConnection(api, summary);
    Object.assign(context.state, {
      goals: {
        thread: {
          threadId: "thread",
          objective: "Завершить интерфейс",
          status: "active",
          tokenBudget: null,
          tokensUsed: 120,
          timeUsedSeconds: 15,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    });
    renderThread();

    const goalControl = screen.getByLabelText("Управление целью");
    expect(goalControl.querySelector("span")).toBeNull();
    expect(goalControl.querySelectorAll("svg")).toHaveLength(1);
    fireEvent.click(goalControl);
    expect(screen.getByText("Завершить интерфейс")).toBeInTheDocument();
    expect(screen.getByText(/120 токенов/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));
    await waitFor(() =>
      expect(api.updateGoal).toHaveBeenCalledWith("thread", { status: "paused" }),
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Очистить" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Очистить" }));
    await waitFor(() => expect(api.clearGoal).toHaveBeenCalledWith("thread"));
  });

  it("submits on Enter, keeps Shift+Enter for a newline, and ignores IME composition", async () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textarea, { target: { value: "Сообщение" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(api.startTurn).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: "Сообщение", clientMessageId: expect.any(String) }),
      ),
    );
    expect(api.sendQueuedNow).not.toHaveBeenCalled();
  });

  it("keeps the composer text until reliable delivery has a durable owner", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary);
    let commit: (() => void) | undefined;
    let resolveDelivery: ((delivery: "delivered") => void) | undefined;
    context.sendReliable.mockImplementation(
      (_threadId, _body, onCommitted?: () => void) =>
        new Promise<"delivered">((resolve) => {
          commit = onCommitted;
          resolveDelivery = resolve;
        }),
    );
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textarea, { target: { value: "Сначала сохрани" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
    expect(textarea).toHaveValue("Сначала сохрани");
    expect(context.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "optimistic.add" }),
    );

    act(() => commit?.());

    expect(textarea).toHaveValue("");
    expect(context.dispatch).toHaveBeenCalledWith({
      type: "optimistic.add",
      message: expect.objectContaining({ text: "Сначала сохрани" }),
    });

    await act(async () => resolveDelivery?.("delivered"));
  });

  it.each([
    { modifier: "Meta", keys: { metaKey: true } },
    { modifier: "Control", keys: { ctrlKey: true } },
  ])("sends the new message immediately with $modifier+Enter", async ({ keys }) => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running, {
      queuedMessages: [
        {
          id: "older-message",
          threadId: "thread",
          text: "Старое сообщение",
          createdAt: 1,
          status: "queued",
        },
      ],
    });
    context.sendReliable.mockImplementation(async (threadId, body) => {
      await api.enqueue(threadId, body);
      return "delivered";
    });
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.change(textarea, { target: { value: "Сразу" } });
    fireEvent.keyDown(textarea, { key: "Enter", ...keys });

    await waitFor(() => expect(api.sendQueuedNow).toHaveBeenCalledOnce());
    const clientMessageId = api.enqueue.mock.calls[0]?.[1].clientMessageId;
    expect(clientMessageId).toEqual(expect.any(String));
    expect(api.sendQueuedNow).toHaveBeenCalledWith("thread", clientMessageId);
    expect(api.sendQueuedNow).not.toHaveBeenCalledWith("thread", "older-message");
  });

  it("sends queued messages oldest first with modifier Enter when the composer is empty", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const first = {
      id: "first-message",
      threadId: "thread",
      text: "Первое",
      createdAt: 1,
      status: "queued" as const,
    };
    const second = {
      id: "second-message",
      threadId: "thread",
      text: "Второе",
      createdAt: 2,
      status: "queued" as const,
    };
    const context = mockThreadConnection(api, running, { queuedMessages: [first, second] });
    const view = renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sendQueuedNow).toHaveBeenCalledWith("thread", first.id));
    expect(api.enqueue).not.toHaveBeenCalled();

    context.state.details.thread.queuedMessages = [second];
    view.rerender(threadRoute());
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(api.sendQueuedNow).toHaveBeenCalledTimes(2));
    expect(api.sendQueuedNow.mock.calls).toEqual([
      ["thread", first.id],
      ["thread", second.id],
    ]);
  });

  it("does not skip a dispatching message at the head of the queue", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      queuedMessages: [
        {
          id: "first-message",
          threadId: "thread",
          text: "Первое",
          createdAt: 1,
          status: "dispatching",
        },
        {
          id: "second-message",
          threadId: "thread",
          text: "Второе",
          createdAt: 2,
          status: "queued",
        },
      ],
    });
    renderThread();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Направить текущую задачу" }), {
      key: "Enter",
      metaKey: true,
    });

    expect(api.sendQueuedNow).not.toHaveBeenCalled();
  });

  it("keeps an accepted immediate message queued when send-now fails", async () => {
    const api = threadApi();
    api.sendQueuedNow.mockRejectedValueOnce(new Error("offline"));
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    context.sendReliable.mockImplementation(async (threadId, body) => {
      await api.enqueue(threadId, body);
      return "delivered";
    });
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.change(textarea, { target: { value: "Сразу" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(
      await screen.findByText("Не удалось отправить сразу — сообщение осталось в очереди"),
    ).toBeInTheDocument();
    expect(textarea).toHaveValue("");
    expect(context.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "optimistic.remove" }),
    );
  });

  it("does not request send-now while reliable delivery is pending", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    context.sendReliable.mockResolvedValueOnce("pending");
    renderThread();
    const textarea = screen.getByRole("textbox", { name: "Направить текущую задачу" });

    fireEvent.change(textarea, { target: { value: "После подключения" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
    expect(api.sendQueuedNow).not.toHaveBeenCalled();
  });

  it("focuses the composer only when navigation marks the session as newly created", () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    const view = renderThread({ focusComposer: true });
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveFocus();

    view.unmount();
    renderThread();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).not.toHaveFocus();
  });

  it.each([
    ["default", "Да, реализуй этот план"],
    ["goal", "Запустить в режиме цели"],
    ["team", "Запустить в режиме оркестратора"],
  ] as const)(
    "durably submits a completed plan in %s mode without a settings request",
    async (mode, label) => {
      const api = threadApi();
      const context = mockThreadConnection(
        api,
        {
          ...summary,
          settings: { collaborationMode: "plan" },
        },
        completedPlanDetail(),
      );
      renderThread();
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(context.sendReliable).toHaveBeenCalledWith(
          "thread",
          expect.objectContaining({
            planImplementationMode: mode,
            clientMessageId: expect.any(String),
            ...(mode === "goal" ? { goal: true } : {}),
          }),
          expect.any(Function),
        ),
      );
      expect(api.updateThreadSettings).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /Отклонить/ })).not.toBeInTheDocument();
    },
  );

  it.each(["plan", "default"] as const)(
    "dismisses a plan in %s mode and keeps implementation and finish actions",
    async (mode) => {
      const api = threadApi();
      const pending = {
        ...summary,
        state: "needsAttention" as const,
        awaitingPlanResponse: true,
        settings: { collaborationMode: mode },
      };
      const dismissed = {
        ...pending,
        state: "completed" as const,
        unread: true,
        awaitingPlanResponse: false,
        dismissedPlanTurnId: "plan-turn",
      };
      let resolve!: (thread: ThreadSummary) => void;
      api.dismissPlan.mockReturnValueOnce(
        new Promise<ThreadSummary>((done) => {
          resolve = done;
        }),
      );
      const context = mockThreadConnection(api, pending, completedPlanDetail());
      const view = renderThread();
      const button = screen.getByRole("button", { name: "Отказаться от плана" });
      fireEvent.click(button);
      fireEvent.click(button);
      expect(api.dismissPlan).toHaveBeenCalledExactlyOnceWith("thread", {
        turnId: "plan-turn",
        observedUpdatedAt: summary.updatedAt,
      });
      expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Да, реализуй этот план" }));
      await act(async () => resolve(dismissed));
      expect(context.dispatch).toHaveBeenCalledWith({ type: "thread", thread: dismissed });
      expect(context.sendReliable).not.toHaveBeenCalled();
      expect(api.updateThreadSettings).not.toHaveBeenCalled();
      expect(api.markRead).not.toHaveBeenCalled();
      context.state.snapshot.threads = [dismissed];
      context.state.details.thread.summary = dismissed;
      view.rerender(threadRoute());
      expect(screen.queryByRole("button", { name: "Отказаться от плана" })).toBeNull();
      expect(screen.getByText("Сделать")).toBeInTheDocument();
      for (const name of [
        "Да, реализуй этот план",
        "Запустить в режиме цели",
        "Запустить в режиме оркестратора",
      ]) {
        expect(screen.getByRole("button", { name })).toBeEnabled();
      }
      fireEvent.click(screen.getByRole("button", { name: "Закончить" }));
      await waitFor(() => expect(api.markRead).toHaveBeenCalled());
    },
  );

  it("allows dismissal with an unsent draft and plan annotations, retaining both on failure and success", async () => {
    const api = threadApi();
    api.dismissPlan.mockRejectedValueOnce(new Error("Не удалось отказаться от плана"));
    const pending = {
      ...summary,
      state: "needsAttention" as const,
      awaitingPlanResponse: true,
      settings: { collaborationMode: "plan" as const },
    };
    api.dismissPlan.mockResolvedValueOnce({
      ...pending,
      state: "completed",
      awaitingPlanResponse: false,
      dismissedPlanTurnId: "plan-turn",
    });
    const annotation = pendingAnnotation({
      messageId: "plan",
      source: "plan",
      quote: "Сделать",
      startOffset: 8,
      endOffset: 15,
    });
    const context = mockThreadConnection(api, pending, {
      ...completedPlanDetail(),
      draft: {
        input: "Позже обсудим",
        images: [],
        annotations: [annotation],
        goalMode: false,
        updatedAt: 1,
      },
    });
    renderThread();
    const input = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Отказаться от плана" }));
    await screen.findByText("Не удалось отказаться от плана");
    expect(input).toHaveValue("Позже обсудим");
    expect(screen.getByRole("button", { name: "Отказаться от плана" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Отказаться от плана" }));
    await waitFor(() =>
      expect(context.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread" })),
    );
    expect(input).toHaveValue("Позже обсудим");
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
    expect(context.sendReliable).not.toHaveBeenCalled();
  });

  it("restores plan actions after a previous client changed mode without delivering acceptance", () => {
    mockThreadConnection(
      threadApi(),
      {
        ...summary,
        state: "needsAttention",
        awaitingPlanResponse: true,
        settings: { collaborationMode: "default" },
      },
      completedPlanDetail(),
    );
    renderThread();
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeEnabled();
  });

  it("keeps the latest plan in chronological order when switching out of Plan mode", () => {
    const planThread = { ...summary, settings: { collaborationMode: "plan" as const } };
    const planTurn = completedPlanDetail().turns![0]!;
    const context = mockThreadConnection(threadApi(), planThread, {
      turns: [{ ...planTurn, items: [...planTurn.items, ...completedAgentTurn().items] }],
    });
    const view = renderThread();
    const plan = screen.getByText("Сделать").closest("article")!;
    const tail = plan.closest(".latest-plan")!;
    expect(tail.closest("[data-turn-id]")).toHaveAttribute("data-turn-id", "plan-turn");
    expect(screen.getAllByText("Сделать")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeEnabled();
    expect(
      plan.compareDocumentPosition(screen.getByText("Готовый фрагмент ответа")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    context.state.snapshot.threads = [summary];
    context.state.details.thread = { ...context.state.details.thread, summary };
    view.rerender(threadRoute());

    expect(screen.queryByRole("button", { name: "Да, реализуй этот план" })).toBeNull();
    expect(screen.getByText("Сделать").closest("article")).toBe(plan);
    expect(screen.getByText("Сделать").closest("[data-turn-id]")).toHaveAttribute(
      "data-turn-id",
      "plan-turn",
    );
    expect(
      screen
        .getByText("Сделать")
        .compareDocumentPosition(screen.getByText("Готовый фрагмент ответа")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps an old plan above its clarification and blocks all implementation choices", () => {
    const api = threadApi();
    const planThread = { ...summary, settings: { collaborationMode: "plan" as const } };
    const planTurn = completedPlanDetail().turns![0]!;
    const clarification: ActivityItem = {
      type: "userMessage",
      id: "clarification",
      status: "completed",
      text: "Добавь прогрев соединений",
      images: [],
      timestamp: 3,
      phase: null,
    };
    const followup = {
      ...completedAgentTurn(),
      items: [clarification, ...completedAgentTurn().items],
    };
    const context = mockThreadConnection(api, planThread, { turns: [planTurn, followup] });
    const view = renderThread();

    const tail = screen.getByText("Сделать").closest(".latest-plan")!;
    expect(tail.closest("[data-turn-id]")).toHaveAttribute("data-turn-id", "plan-turn");
    expect(
      tail.compareDocumentPosition(screen.getByText(clarification.text)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("План ещё не обновлён после уточнений")).toBeVisible();
    for (const button of tail.querySelectorAll(".implement-plan")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(api.updateThreadSettings).not.toHaveBeenCalled();
    expect(api.startTurn).not.toHaveBeenCalled();

    context.state.details.thread = {
      ...context.state.details.thread,
      turns: [
        planTurn,
        {
          ...followup,
          items: [
            ...followup.items,
            { ...planTurn.items[0]!, id: "revised-plan", text: "План с прогревом соединений" },
          ],
        },
      ],
    };
    view.rerender(threadRoute());

    expect(screen.queryByText("План ещё не обновлён после уточнений")).toBeNull();
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeEnabled();
    expect(screen.getByText("Сделать").closest(".latest-plan")).toBeNull();
    expect(screen.getAllByText("План с прогревом соединений")).toHaveLength(1);
    const revisedTail = screen.getByText("План с прогревом соединений").closest(".latest-plan")!;
    expect(revisedTail.closest("[data-turn-id]")).toHaveAttribute("data-turn-id", followup.id);
    expect(
      screen.getByText(clarification.text).compareDocumentPosition(revisedTail) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Да, реализуй этот план" })).toHaveLength(1);

    view.unmount();
    renderThread();
    expect(screen.getByText("План с прогревом соединений").closest(".latest-plan")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeEnabled();
  });

  it.each(["detached", "same-turn", "queue"] as const)(
    "keeps a %s optimistic clarification below the plan through server confirmation",
    (destination) => {
      const planTurn = completedPlanDetail().turns![0]!;
      const planThread = {
        ...summary,
        settings: { collaborationMode: "plan" as const },
        ...(destination === "same-turn"
          ? { currentTurnId: planTurn.id, state: "running" as const }
          : {}),
      };
      const context = mockThreadConnection(threadApi(), planThread, { turns: [planTurn] });
      const view = renderThread();
      const originalPlan = screen.getByText("Сделать").closest("article")!;
      const message = {
        id: "clarification",
        threadId: "thread",
        text: "Уточнение после плана",
        images: [],
        createdAt: 3,
        destination: destination === "queue" ? ("queue" as const) : ("turn" as const),
        turnId: destination === "same-turn" ? planTurn.id : null,
      };
      context.state.optimisticMessages.thread = [message];
      view.rerender(threadRoute());

      const clarification = screen.getByText(message.text);
      expect(
        originalPlan.compareDocumentPosition(clarification) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
      if (destination === "same-turn") {
        const pending = clarification.closest<HTMLElement>(".turn-pending-messages")!;
        expect(Number(pending.style.gridRow)).toBeGreaterThan(
          Number(originalPlan.parentElement!.style.gridRow),
        );
      }

      context.state.optimisticMessages.thread = [];
      const reply: ActivityItem = {
        type: "userMessage",
        id: message.id,
        text: message.text,
        status: "completed",
        timestamp: 3,
        images: [],
        phase: null,
      };
      context.state.details.thread = {
        ...context.state.details.thread,
        turns:
          destination === "same-turn"
            ? [{ ...planTurn, items: [...planTurn.items, reply] }]
            : [
                planTurn,
                { ...completedAgentTurn(), items: [reply, ...completedAgentTurn().items] },
              ],
      };
      view.rerender(threadRoute());
      expect(screen.getByText("Сделать").closest("article")).toBe(originalPlan);
      expect(screen.getAllByText(message.text)).toHaveLength(1);
      expect(
        originalPlan.compareDocumentPosition(screen.getByText(message.text)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
    },
  );

  it.each(["userMessage", "userInputResponse"] as const)(
    "blocks a plan followed by a %s in the same turn",
    (type) => {
      const planThread = { ...summary, settings: { collaborationMode: "plan" as const } };
      const planTurn = completedPlanDetail().turns![0]!;
      const reply: ActivityItem =
        type === "userMessage"
          ? {
              type,
              id: "reply",
              status: "completed",
              text: "Используем два прокси",
              images: [],
              timestamp: 3,
              phase: null,
            }
          : {
              type,
              id: "reply",
              status: "completed",
              timestamp: 3,
              afterItemId: "plan",
              entries: [{ header: "Прокси", question: "Сколько?", answers: ["Два"] }],
            };
      mockThreadConnection(threadApi(), planThread, {
        turns: [{ ...planTurn, items: [...planTurn.items, reply, ...completedAgentTurn().items] }],
      });
      renderThread();

      expect(screen.getByText("План ещё не обновлён после уточнений")).toBeVisible();
      expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
      expect(
        screen
          .getByText("Сделать")
          .compareDocumentPosition(
            screen.getByText(type === "userMessage" ? "Используем два прокси" : "Два"),
          ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    },
  );

  it("keeps a streaming plan in its turn and enables it only after successful completion", () => {
    const planTurn = completedPlanDetail().turns![0]!;
    const planThread = { ...summary, settings: { collaborationMode: "plan" as const } };
    const running = { ...planThread, state: "running" as const, currentTurnId: planTurn.id };
    const context = mockThreadConnection(threadApi(), running, {
      turns: [
        {
          ...planTurn,
          status: "inProgress",
          items: [{ ...planTurn.items[0]!, status: "inProgress" }],
        },
      ],
    });
    const view = renderThread();
    expect(screen.getByText("Сделать").closest(".latest-plan")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();

    context.state.details.thread = {
      ...context.state.details.thread,
      turns: [{ ...planTurn, status: "inProgress" }],
    };
    view.rerender(threadRoute());
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();

    context.state.snapshot.threads = [planThread];
    context.state.details.thread = {
      ...context.state.details.thread,
      summary: planThread,
      turns: [planTurn],
    };
    view.rerender(threadRoute());
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeEnabled();
  });

  it.each(["interrupted", "failed"] as const)("does not accept a plan from a %s turn", (status) => {
    const planThread = {
      ...summary,
      state: status,
      settings: { collaborationMode: "plan" as const },
    };
    const planTurn = completedPlanDetail().turns![0]!;
    mockThreadConnection(threadApi(), planThread, { turns: [{ ...planTurn, status }] });
    renderThread();

    expect(screen.getByText("План не завершён")).toBeVisible();
    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Запустить в режиме цели" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Запустить в режиме оркестратора" })).toBeDisabled();
  });

  it.each(["userInput", "fileChangeApproval"] as const)(
    "explains a plan blocked by %s and enables all choices once the request and turn end",
    (kind) => {
      const api = threadApi();
      const planThread = {
        ...summary,
        settings: { collaborationMode: "plan" as const },
      };
      const request: AttentionRequest =
        kind === "userInput"
          ? pendingInputRequest()
          : {
              id: "approval",
              kind,
              threadId: "thread",
              turnId: "turn",
              itemId: "files",
              createdAt: 2,
              reason: null,
              grantRoot: null,
              canAcceptForSession: true,
            };
      const context = mockThreadConnection(
        api,
        { ...planThread, state: "needsAttention", currentTurnId: "turn" },
        { ...completedPlanDetail(), attention: [request] },
      );
      const view = renderThread();
      const reason =
        kind === "userInput"
          ? "Сначала ответьте на вопросы агента"
          : "Сначала обработайте запросы, требующие внимания";
      const buttons = Array.from(view.container.querySelectorAll(".implement-plan"));
      expect(buttons).toHaveLength(3);
      expect(screen.getByText(reason)).toBeVisible();
      expect(screen.getByText(reason)).toHaveAttribute("role", "status");
      for (const button of buttons) {
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("title", reason);
        fireEvent.click(button);
      }
      expect(api.updateThreadSettings).not.toHaveBeenCalled();
      expect(api.startTurn).not.toHaveBeenCalled();

      context.state.snapshot.attention = [];
      context.state.snapshot.threads = [{ ...planThread, state: "running", currentTurnId: "turn" }];
      view.rerender(threadRoute());
      expect(screen.queryByText(reason)).toBeNull();
      for (const button of buttons) expect(button).toBeDisabled();

      context.state.snapshot.threads = [planThread];
      context.state.details.thread.summary = planThread;
      view.rerender(threadRoute());
      for (const button of buttons) {
        expect(button).toBeEnabled();
        expect(button).not.toHaveAttribute("title");
      }
    },
  );

  it("lets only one completed-plan implementation button start at a time", async () => {
    const api = threadApi();
    const context = mockThreadConnection(
      api,
      {
        ...summary,
        settings: { collaborationMode: "plan" },
      },
      completedPlanDetail(),
    );
    let resolveDelivery!: (value: string) => void;
    context.sendReliable.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelivery = resolve;
        }),
    );
    renderThread();
    const defaultButton = screen.getByRole("button", { name: "Да, реализуй этот план" });
    const teamButton = screen.getByRole("button", { name: "Запустить в режиме оркестратора" });
    act(() => {
      defaultButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      teamButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(context.sendReliable).toHaveBeenCalledOnce();
    expect(api.updateThreadSettings).not.toHaveBeenCalled();
    expect(screen.getByText("Это сообщение уже отправлено")).toBeInTheDocument();
    expect(screen.getByText("Запускаем выполнение плана…")).toBeInTheDocument();
    await act(async () => resolveDelivery("pending"));
    expect(screen.queryByText("Запускаем выполнение плана…")).not.toBeInTheDocument();
  });

  it("does not mutate Plan settings when its implementation message is already active", async () => {
    const api = threadApi();
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    const context = mockThreadConnection(api, planThread, completedPlanDetail());
    context.state.optimisticMessages.thread = [
      {
        id: "active-plan-acceptance",
        threadId: "thread",
        text: "Да, реализуй этот план",
        images: [],
        createdAt: 3,
        destination: "turn",
        turnId: null,
      },
    ];
    renderThread();

    fireEvent.click(screen.getByRole("button", { name: "Да, реализуй этот план" }));

    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
    expect(api.updateThreadSettings).not.toHaveBeenCalled();
    expect(api.startTurn).not.toHaveBeenCalled();
  });

  it.each(["Да, реализуй этот план", "Запустить в режиме цели", "Запустить в режиме оркестратора"])(
    "keeps Plan mode and allows retry if %s cannot be saved",
    async (label) => {
      const api = threadApi();
      const context = mockThreadConnection(
        api,
        {
          ...summary,
          settings: { collaborationMode: "plan" },
        },
        completedPlanDetail(),
      );
      context.sendReliable.mockRejectedValueOnce(new Error("Не удалось сохранить сообщение"));
      renderThread();
      const button = screen.getByRole("button", { name: label });
      fireEvent.click(button);
      expect(await screen.findByText("Не удалось сохранить сообщение")).toBeInTheDocument();
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      await waitFor(() => expect(context.sendReliable).toHaveBeenCalledTimes(2));
      expect(api.updateThreadSettings).not.toHaveBeenCalled();
    },
  );

  it("sends plan annotations as revision feedback and blocks plan acceptance", async () => {
    const api = threadApi();
    const planThread = {
      ...summary,
      settings: { collaborationMode: "plan" as const },
    };
    const annotation = pendingAnnotation({
      messageId: "plan",
      source: "plan",
      quote: "Сделать",
      startOffset: 7,
      endOffset: 14,
    });
    localStorage.setItem(annotationStorageKey("thread"), JSON.stringify([annotation]));
    mockThreadConnection(api, planThread, completedPlanDetail());
    renderThread();

    expect(screen.getByRole("button", { name: "Да, реализуй этот план" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Запустить в режиме цели" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Запустить в режиме оркестратора" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(api.startTurn).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ input: expect.stringContaining("### Аннотация 1") }),
      ),
    );
    expect(api.updateThreadSettings).not.toHaveBeenCalled();
  });

  it("shows outgoing messages in the timeline and supports queue actions", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      queuedMessages: [
        {
          id: "queued",
          threadId: "thread",
          text: "Срочная правка",
          createdAt: 1,
          status: "queued",
        },
        {
          id: "second",
          threadId: "thread",
          text: "Следующее сообщение",
          createdAt: 2,
          status: "queued",
        },
      ],
    });
    renderThread();

    const queue = screen.getByRole("region", { name: "Очередь сообщений" });
    expect(queue.closest("form")).toBeNull();
    expect(queue.closest(".timeline")).not.toBeNull();
    expect(
      Array.from(queue.querySelectorAll("[data-message-id]")).map((node) =>
        node.getAttribute("data-message-id"),
      ),
    ).toEqual(["queued", "second"]);
    expect(
      Array.from(queue.querySelectorAll(".queued-message-order")).map((node) => node.textContent),
    ).toEqual([]);
    expect(queue.querySelector(".queued-messages-count")).toBeNull();
    expect(screen.queryByText("Отправлено")).not.toBeInTheDocument();
    expect(screen.getAllByText("В очереди")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Изменить сообщение в очереди" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Текст сообщения в очереди" }), {
      target: { value: "Исправленная срочная правка" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.updateQueued).toHaveBeenCalledWith("thread", "queued", {
        input: "Исправленная срочная правка",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Текст сообщения в очереди" })).toBeNull(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Изменить сообщение в очереди" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Текст сообщения в очереди" }), {
      target: { value: "Не сохранять" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(api.updateQueued).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("button", { name: "Удалить сообщение из очереди" })[0]!);
    await waitFor(() => expect(api.deleteQueued).toHaveBeenCalledWith("thread", "queued"));

    fireEvent.click(screen.getAllByRole("button", { name: "Отправить сейчас" })[0]!);
    await waitFor(() => expect(api.sendQueuedNow).toHaveBeenCalledWith("thread", "queued"));
  });

  it("shows a submitted user-input response once and hides stale delivery records", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            {
              type: "userInputResponse",
              id: "response",
              status: "completed",
              entries: [
                {
                  header: "Положение",
                  question: "Где разместить точку статуса?",
                  answers: ["Перед поиском"],
                },
              ],
              timestamp: 2,
              afterItemId: "request",
            },
            {
              type: "userMessage",
              id: "user-input:delivered",
              status: "completed",
              text: "Где разместить точку статуса?\nПеред поиском",
              images: [],
              timestamp: 2,
              phase: null,
            },
          ],
        },
      ],
      queuedMessages: [
        {
          id: "server-confirmed-answer",
          threadId: "thread",
          text: "Где разместить точку статуса?\nПеред поиском",
          createdAt: 2,
          status: "dispatching",
          replyToUserInput: {
            turnId: "turn",
            itemId: "request",
            answers: { position: ["Перед поиском"] },
          },
        },
      ],
    });
    context.state.optimisticMessages.thread = [
      {
        id: "user-input:late-optimistic-state",
        threadId: "thread",
        text: "Где разместить точку статуса?\nПеред поиском",
        images: [],
        createdAt: 3,
        destination: "queue",
        turnId: null,
        serverAccepted: true,
      },
    ];

    const view = renderThread();

    expect(screen.getAllByText("Где разместить точку статуса?")).toHaveLength(1);
    expect(screen.getAllByText("Перед поиском")).toHaveLength(1);
    expect(view.container.querySelector('[data-message-id="user-input:delivered"]')).toBeNull();
    expect(screen.queryByRole("region", { name: "Очередь сообщений" })).toBeNull();
  });

  it("hides a dismissed form on text commit and restores its inputs on delivery failure", async () => {
    const api = threadApi();
    const request = pendingInputRequest();
    const running = { ...summary, state: "needsAttention" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running, { attention: [request] });
    context.dispatch.mockImplementation((action) => {
      if (action.type === "optimistic.add")
        context.state.optimisticMessages.thread = [action.message];
    });
    const view = renderThread();
    fireEvent.click(screen.getByRole("button", { name: /Вопрос 2 из 2:/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Свой ответ" }), {
      target: { value: "Сохранить мой ответ" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Направить текущую задачу" }), {
      target: { value: "Новое указание" },
    });
    expect(screen.getByRole("region", { name: "Требуется внимание" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));
    await waitFor(() =>
      expect(api.enqueue).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          input: "Новое указание",
          dismissUserInput: { turnId: "turn", itemId: "question" },
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Требуется внимание" })).toBeNull(),
    );
    expect(view.container.querySelector(".attention-stack")).toHaveAttribute("hidden");
    expect(view.container.querySelector(".turn-activity-row")).toHaveTextContent(
      "Ждёт вашего ответа",
    );
    expect(api.enqueue.mock.calls[0]?.[1]).not.toHaveProperty("replyToUserInput");
    context.state.optimisticMessages.thread![0]!.deliveryError = {
      message: "Не удалось доставить",
      retryable: false,
    };
    view.rerender(threadRoute());
    expect(screen.getByRole("textbox", { name: "Свой ответ" })).toHaveValue("Сохранить мой ответ");
    expect(view.container.querySelector(".turn-activity-row")).toHaveTextContent(
      "Ждёт вашего ответа",
    );
    expect(screen.getByRole("button", { name: /Вопрос 2 из 2:/ })).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("hides only the referenced form across queue reloads and keeps approvals visible", () => {
    const oldQuestion = pendingInputRequest();
    const newQuestion = { ...pendingInputRequest("new-question"), id: "new-attention" };
    const approval: AttentionRequest = {
      id: "approval",
      kind: "fileChangeApproval",
      threadId: "thread",
      turnId: "turn",
      itemId: "files",
      createdAt: 2,
      reason: null,
      grantRoot: null,
      canAcceptForSession: true,
    };
    const context = mockThreadConnection(
      threadApi(),
      { ...summary, state: "needsAttention", currentTurnId: "turn" },
      {
        attention: [oldQuestion, newQuestion, approval],
        queuedMessages: [
          {
            id: "message",
            threadId: "thread",
            text: "Новое указание",
            createdAt: 3,
            status: "queued",
            dismissUserInput: { turnId: "turn", itemId: "question" },
          },
        ],
      },
    );
    const view = renderThread();
    expect(view.container.querySelectorAll(".attention-card[hidden]")).toHaveLength(1);
    expect(screen.getAllByRole("textbox", { name: "Свой ответ" })).toHaveLength(1);
    expect(view.container.querySelectorAll(".attention-card:not([hidden])")).toHaveLength(2);
    view.unmount();
    const reopened = renderThread();
    expect(reopened.container.querySelectorAll(".attention-card[hidden]")).toHaveLength(1);
    context.state.details.thread.queuedMessages = [];
    reopened.rerender(threadRoute());
    expect(screen.getAllByRole("textbox", { name: "Свой ответ" })).toHaveLength(2);
  });

  it("keeps an async answer inside its question card without a second user message", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "async-question",
              status: "completed",
              text: "",
              questions: [{ title: "Как проверять?", options: ["Быстро", "Подробно"] }],
              questionKey: "stable-question",
              delivery: "async",
              images: [],
              timestamp: 1,
              phase: "commentary",
            },
            {
              type: "userMessage",
              id: "async-answer:thread:turn:stable-question",
              status: "completed",
              text: "Как проверять?\nПодробно",
              images: [],
              timestamp: 2,
              phase: null,
            },
          ],
        },
      ],
    });

    const view = renderThread();

    const questionCard = screen.getByRole("region", { name: "Вопросы Codex" });
    expect(questionCard).toHaveTextContent("Как проверять? Подробно");
    expect(
      view.container.querySelector('[data-message-id="async-answer:thread:turn:stable-question"]'),
    ).toBeNull();
  });

  it("keeps failed question replies visible and retryable", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    context.state.optimisticMessages.thread = [
      {
        id: "user-input:failed",
        threadId: "thread",
        text: "Ответ, который не удалось доставить",
        images: [],
        createdAt: 1,
        destination: "queue",
        turnId: null,
        deliveryError: { message: "Нет связи — повторим отправку", retryable: true },
      },
    ];

    const view = renderThread();

    expect(screen.getByRole("region", { name: "Очередь сообщений" })).toBeInTheDocument();
    expect(screen.getByText("Нет связи — повторим отправку")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Повторить отправку" })).toBeEnabled();
    expect(view.container.querySelector('[data-message-id="user-input:failed"]')).not.toBeNull();
  });

  it("disables queue actions until optimistic messages are confirmed", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const context = mockThreadConnection(api, running);
    context.state.optimisticMessages.thread = [
      {
        id: "optimistic",
        threadId: "thread",
        text: "Добавляется",
        images: [],
        createdAt: 1,
        destination: "queue",
        turnId: null,
      },
    ];
    renderThread();

    expect(screen.getByText("Отправляется…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Изменить сообщение в очереди" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Удалить сообщение из очереди" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отправить сейчас" })).toBeDisabled();
  });

  it("shows chronological plan checklists inside the turn without a composer status pill", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: Date.now() - 5_000,
          completedAt: null,
          durationMs: null,
          progress: {
            startedAt: Date.now() - 5_000,
            explanation: "Проверяем изменения",
            steps: [
              { step: "Прочитать код", status: "completed" },
              { step: "Исправить чат", status: "inProgress" },
              { step: "Запустить тесты", status: "pending" },
            ],
            filesChanged: 2,
            additions: 12,
            deletions: 3,
          },
          items: [
            {
              type: "planChecklist",
              id: "turn-plan-checklist-started",
              status: "inProgress",
              explanation: "Читаем код",
              steps: [
                { step: "Прочитать код", status: "inProgress" },
                { step: "Исправить чат", status: "pending" },
                { step: "Запустить тесты", status: "pending" },
              ],
              timestamp: Date.now() - 2_000,
              afterItemId: null,
            },
            {
              type: "agentMessage",
              id: "progress-message",
              status: "completed",
              text: "Код прочитан",
              images: [],
              timestamp: Date.now() - 1_000,
              phase: "commentary",
            },
            {
              type: "planChecklist",
              id: "turn-plan-checklist-next",
              status: "inProgress",
              explanation: "Проверяем изменения",
              steps: [
                { step: "Прочитать код", status: "completed" },
                { step: "Исправить чат", status: "inProgress" },
                { step: "Запустить тесты", status: "pending" },
              ],
              timestamp: Date.now(),
              afterItemId: null,
            },
          ],
        },
      ],
    });
    const view = renderThread();

    expect(screen.getAllByText("Ход работы")).toHaveLength(2);
    expect(screen.getByText("Код прочитан")).toBeInTheDocument();
    expect(screen.getAllByText("Прочитать код")).toHaveLength(2);
    expect(screen.getAllByText("Исправить чат")).toHaveLength(2);
    expect(screen.getAllByText("Запустить тесты")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
    expect(screen.getAllByRole("checkbox")[3]).toBeChecked();
    const cards = view.container.querySelectorAll(".plan-checklist");
    expect(cards[0]).toHaveTextContent("Читаем код");
    expect(cards[1]).toHaveTextContent("Проверяем изменения");
    expect(screen.getAllByText("Проверяем изменения").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".turn-progress")).toBeNull();
  });

  it("keeps response order, question focus and draft when steering splits a live response", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    const message = (
      type: "agentMessage" | "userMessage",
      id: string,
      text: string,
    ): ActivityItem => ({
      type,
      id,
      text,
      images: [],
      status: "completed",
      timestamp: 1,
      phase: type === "agentMessage" ? "commentary" : null,
    });
    const context = mockThreadConnection(api, running, {
      attention: [pendingInputRequest()],
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            message("userMessage", "user", "Начни работу"),
            message("agentMessage", "agent", "Первый шаг"),
          ],
        },
      ],
    });
    const view = renderThread();
    const input = screen.getByRole("textbox", { name: "Свой ответ" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Сохранить мой ответ" } });
    input.focus();
    input.setSelectionRange(4, 9);
    const originalMessage = screen.getByText("Первый шаг").closest("article");
    expect(view.container.querySelectorAll(".response-surface")).toHaveLength(1);
    expect(input.closest(".turn")?.getAttribute("data-turn-id")).toBe("turn");

    const detail = context.state.details.thread;
    context.state.details.thread = {
      ...detail,
      turns: [
        {
          ...detail.turns[0]!,
          items: [
            ...detail.turns[0]!.items,
            message("userMessage", "steer", "И ещё пожелание"),
            message("agentMessage", "next", "Продолжаю с уточнением"),
          ],
        },
      ],
    };
    view.rerender(threadRoute());

    expect(screen.getByRole("textbox", { name: "Свой ответ" })).toBe(input);
    expect(input).toHaveValue("Сохранить мой ответ");
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 9]);
    expect(screen.getByText("Первый шаг").closest("article")).toBe(originalMessage);
    expect(view.container.querySelectorAll(".response-surface")).toHaveLength(2);
    expect(originalMessage!.parentElement).toHaveClass("response-start", "response-end");
    expect(screen.getByText("Продолжаю с уточнением").closest(".response-piece")).toHaveClass(
      "response-start",
    );
    expect(
      Array.from(
        view.container.querySelectorAll(".turn .message-body"),
        (node) => node.textContent,
      ),
    ).toEqual(["Начни работу", "Первый шаг", "И ещё пожелание", "Продолжаю с уточнением"]);

    const updated = context.state.details.thread;
    context.state.details.thread = { ...updated, turns: [completedAgentTurn(), ...updated.turns] };
    view.rerender(threadRoute());
    expect(screen.getByRole("textbox", { name: "Свой ответ" })).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Сохранить мой ответ");
    await act(async () => undefined);
  });

  it("keeps a question draft and selection when its history arrives after the form", () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary, { attention: [pendingInputRequest()] });
    const view = renderThread();
    const input = screen.getByRole("textbox", { name: "Свой ответ" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Ещё не отправленный ответ" } });
    input.focus();
    input.setSelectionRange(5, 12);
    expect(input.closest(".turn")).toBeNull();

    context.state.details.thread = {
      ...context.state.details.thread,
      turns: [{ ...completedAgentTurn(), id: "turn" }],
    };
    view.rerender(threadRoute());

    expect(screen.getByRole("textbox", { name: "Свой ответ" })).toBe(input);
    expect(input).toHaveValue("Ещё не отправленный ответ");
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 12]);
    expect(input.closest(".turn")).toBeNull();
  });

  it("shows a final checklist above its separate final answer", () => {
    const api = threadApi();
    const completed = { ...summary, state: "completed" as const };
    mockThreadConnection(api, completed, {
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "final-answer",
              status: "completed",
              text: "Итоговый ответ",
              images: [],
              timestamp: 2,
              phase: "final_answer",
            },
            {
              type: "planChecklist",
              id: "final-checklist",
              status: "completed",
              explanation: "Работа завершена",
              steps: [{ step: "Проверить результат", status: "completed" }],
              timestamp: 3,
              afterItemId: "unrendered-reasoning-item",
            },
          ],
        },
      ],
    });
    const view = renderThread();

    const checklist = screen.getByText("Проверить результат").closest("article");
    const answer = screen.getByText("Итоговый ответ").closest("article");
    const timing = view.container.querySelector(".turn-activity-row");
    expect(checklist).toHaveClass("plan-checklist");
    expect(checklist).toHaveTextContent("Работа завершена");
    expect(answer).toHaveClass("agentMessage");
    expect(checklist).not.toBe(answer);
    expect(checklist!.compareDocumentPosition(answer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(answer!.compareDocumentPosition(timing!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("does not leave timeline gaps for empty streamed activities", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: Date.now() - 3_000,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "empty-agent",
              status: "inProgress",
              text: "",
              images: [],
              timestamp: Date.now(),
              phase: "commentary",
            },
            {
              type: "reasoning",
              id: "empty-reasoning",
              status: "inProgress",
              text: " \n ",
              images: [],
              timestamp: Date.now(),
              phase: null,
            },
          ],
        },
      ],
    });
    const view = renderThread();

    expect(screen.queryByRole("button", { name: "Копировать сообщение" })).toBeNull();
    expect(view.container.querySelector('.turn > div:not([aria-hidden="true"]):empty')).toBeNull();
    expect(screen.queryByLabelText("Технические детали")).toBeNull();
    expect(view.container.querySelector(".turn-activity-static")).not.toBeNull();
  });

  it("renders attention requests after the active turn inside the timeline", () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    mockThreadConnection(api, running, {
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [
            {
              type: "agentMessage",
              id: "agent",
              status: "completed",
              text: "Перед запросом",
              images: [],
              timestamp: 1,
              phase: "commentary",
            },
          ],
        },
      ],
      attention: [
        {
          id: "attention",
          threadId: "thread",
          turnId: "turn",
          itemId: null,
          createdAt: 1,
          kind: "commandApproval",
          command: "npm test",
          cwd: "/work",
          reason: null,
          networkHost: null,
          canAcceptForSession: false,
          proposedPolicyChanges: [],
        },
      ],
    });
    const view = renderThread();
    const turn = view.container.querySelector(".turn")!;
    const attention = view.container.querySelector(".attention-stack")!;

    expect(turn.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attention.closest(".timeline")).not.toBeNull();
  });

  it("renders a reliable optimistic message before the running indicator", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    let resolveStart: ((value: { turnId: string }) => void) | undefined;
    const api = threadApi();
    api.startTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    const context = mockThreadConnection(api, summary);
    const view = renderThread();
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textbox, { target: { value: "Появись сразу" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() => expect(textbox).toHaveValue(""));
    const optimistic = await waitFor(() => {
      const message = context.dispatch.mock.calls.find(
        ([action]) => action.type === "optimistic.add",
      )?.[0].message;
      expect(message).toBeDefined();
      return message;
    });
    expect(optimistic).toMatchObject({
      text: "Появись сразу",
      destination: "queue",
    });

    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    context.state.snapshot.threads = [running];
    context.state.details.thread = {
      ...context.state.details.thread,
      summary: running,
      turns: [
        {
          id: "turn",
          status: "inProgress",
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [],
        },
      ],
    };
    context.state.optimisticMessages.thread = [optimistic];
    view.rerender(threadRoute());

    const message = screen.getByText("Появись сразу").closest("article")!;
    expect(message).toHaveAttribute("data-message-id", optimistic.id);

    await act(async () => resolveStart?.({ turnId: "turn" }));
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it.each(["queue", "turn"] as const)(
    "returns to the tail after a submitted message appears in the %s and resumes following",
    async (destination) => {
      const context = mockThreadConnection(threadApi(), summary);
      const view = renderThread();
      const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
      let height = 1_000;
      Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, get: () => height },
        clientHeight: { configurable: true, value: 500 },
        scrollTo: {
          configurable: true,
          value: ({ top }: ScrollToOptions) => {
            scroll.scrollTop = Math.min(top ?? 0, height - scroll.clientHeight);
          },
        },
      });
      fireEvent.wheel(scroll, { deltaY: -30 });
      scroll.scrollTop = 200;
      fireEvent.scroll(scroll);
      fireEvent.change(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
        target: { value: "Продолжим" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
      await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
      const optimistic = context.dispatch.mock.calls.find(
        ([action]) => action.type === "optimistic.add",
      )![0].message;
      context.state.optimisticMessages.thread = [{ ...optimistic, destination }];
      view.rerender(threadRoute());
      expect(scroll.scrollTop).toBe(500);
      expect(
        screen.queryByRole("button", { name: "Прокрутить к последнему сообщению" }),
      ).toBeNull();
      fireEvent.scroll(scroll);
      height = 1_200;
      context.state.details.thread = { ...context.state.details.thread };
      view.rerender(threadRoute());
      expect(scroll.scrollTop).toBe(700);
    },
  );

  it("loads older turns near the top and preserves the visible scroll position", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary, { olderTurnsCursor: "older-page" });
    let scrollHeight = 1_000;
    context.loadOlderDetail.mockImplementation(async () => {
      scrollHeight = 1_300;
      const current = context.state.details.thread;
      context.state.details.thread = {
        ...current,
        turns: [
          {
            id: "older",
            status: "completed",
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
            progress: progress(),
            items: [],
          },
          ...current.turns,
        ],
        olderTurnsCursor: null,
      };
      return context.state.details.thread;
    });
    const view = renderThread();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroll, "clientHeight", { configurable: true, get: () => 500 });
    fireEvent.wheel(scroll, { deltaY: -30 });
    scroll.scrollTop = 50;

    fireEvent.scroll(scroll);

    await waitFor(() =>
      expect(context.loadOlderDetail).toHaveBeenCalledWith("thread", "older-page"),
    );
    await waitFor(() => expect(scroll.scrollTop).toBe(350));
  });

  it("corrects a late browser scroll without loading older history or losing tail following", async () => {
    const context = mockThreadConnection(threadApi(), summary, { olderTurnsCursor: "older" });
    const view = renderThread();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    let height = 1_500;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 500 },
      scrollTo: {
        configurable: true,
        value: ({ top }: ScrollToOptions) => {
          scroll.scrollTop = Math.min(top ?? 0, height - scroll.clientHeight);
        },
      },
    });
    scroll.scrollTop = 1_000;
    fireEvent.scroll(scroll);
    // A late browser/layout adjustment is not a request to read old messages.
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    fireEvent.scroll(scroll);
    await waitFor(() => expect(scroll.scrollTop).toBe(1_000));
    expect(context.loadOlderDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Прокрутить к последнему сообщению" })).toBeNull();

    height = 1_800;
    context.state.details.thread = { ...context.state.details.thread };
    view.rerender(threadRoute());
    expect(scroll.scrollTop).toBe(1_300);
  });

  it.each(["wheel", "unmount", "session switch"])(
    "cancels a pending tail correction on %s",
    async (action) => {
      const context = mockThreadConnection(threadApi(), summary);
      const other = { ...summary, id: "other" };
      context.state.snapshot.threads.push(other);
      Object.assign(context.state.details, {
        other: { ...context.state.details.thread, summary: other },
      });
      const view = render(voiceThreadRoute());
      const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
      const scrollTo = vi.fn();
      Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, value: 1_000 },
        clientHeight: { configurable: true, value: 500 },
        scrollTo: { configurable: true, value: scrollTo },
      });
      const cancelled = vi.spyOn(window, "cancelAnimationFrame");
      try {
        scroll.scrollTop = 250;
        fireEvent.scroll(scroll);
        if (action === "wheel") fireEvent.wheel(scroll, { deltaY: -30 });
        else if (action === "session switch") {
          fireEvent.click(screen.getByText("Открыть B"));
          scrollTo.mockClear();
        } else view.unmount();
        expect(cancelled).toHaveBeenCalled();
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        expect(scrollTo).not.toHaveBeenCalled();
      } finally {
        cancelled.mockRestore();
      }
    },
  );

  it("respects manual scrolling before the initial history arrives", () => {
    const context = mockThreadConnection(threadApi(), summary, {
      attention: [pendingInputRequest()],
    });
    const detail = context.state.details.thread;
    delete (context.state.details as Record<string, ThreadDetail>).thread;
    const view = renderThread();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    const scrollTo = vi.fn();
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_500 },
      clientHeight: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.wheel(scroll, { deltaY: -30 });
    scroll.scrollTop = 600;
    fireEvent.scroll(scroll);
    context.state.details.thread = detail;
    view.rerender(threadRoute());
    expect(scroll.scrollTop).toBe(600);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("lets focus reveal a question without correcting its scroll back to the tail", async () => {
    mockThreadConnection(threadApi(), summary, { attention: [pendingInputRequest()] });
    const view = renderThread();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    const scrollTo = vi.fn();
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_500 },
      clientHeight: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    scroll.scrollTop = 600;
    fireEvent.scroll(scroll);
    const input = screen.getByRole("textbox", { name: "Свой ответ" });
    act(() => input.focus());
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(input).toHaveFocus();
    expect(scroll.scrollTop).toBe(600);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("shows a button away from the latest message and smoothly scrolls back", () => {
    const api = threadApi();
    mockThreadConnection(api, summary);
    const view = renderThread();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    const scrollTo = vi.fn();
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    fireEvent.wheel(scroll, { deltaY: -30 });
    scroll.scrollTop = 250;
    fireEvent.scroll(scroll);

    const button = screen.getByRole("button", {
      name: "Прокрутить к последнему сообщению",
    });
    fireEvent.click(button);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "smooth" });

    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    expect(button).toBeInTheDocument();

    scroll.scrollTop = 500;
    fireEvent.scroll(scroll);
    expect(screen.queryByRole("button", { name: "Прокрутить к последнему сообщению" })).toBeNull();
  });

  it.each(["scrollbar", "wheel", "touch", "keyboard"])(
    "follows the stream only at the bottom after %s scrolling",
    (input) => {
      const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
      const item = {
        type: "agentMessage" as const,
        id: "streaming-answer",
        status: "inProgress" as const,
        text: "Первая часть ответа",
        images: [],
        timestamp: 1,
        phase: "commentary" as const,
      };
      const context = mockThreadConnection(threadApi(), running, {
        turns: [
          {
            id: "turn",
            status: "inProgress",
            startedAt: 1,
            completedAt: null,
            durationMs: null,
            progress: progress(),
            items: [item],
          },
        ],
      });
      const view = renderThread();
      const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
      const scrollTo = vi.fn();
      let scrollHeight = 1_000;
      Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, get: () => scrollHeight },
        clientHeight: { configurable: true, value: 500 },
        scrollTo: { configurable: true, value: scrollTo },
      });
      scroll.scrollTop = 500;
      fireEvent.scroll(scroll);

      if (input === "scrollbar") fireEvent.pointerDown(scroll);
      if (input === "keyboard") fireEvent.keyDown(scroll, { key: "PageUp" });
      if (input === "wheel") fireEvent.wheel(scroll, { deltaY: -30 });
      if (input === "touch") {
        fireEvent.touchStart(scroll, { touches: [{ clientX: 100, clientY: 200 }] });
        fireEvent.touchMove(scroll, { touches: [{ clientX: 102, clientY: 230 }] });
      }
      // A queued event from the previous automatic scroll must not undo the gesture.
      fireEvent.scroll(scroll);
      scroll.scrollTop = 470;
      fireEvent.scroll(scroll);

      expect(
        screen.getByRole("button", { name: "Прокрутить к последнему сообщению" }),
      ).toBeInTheDocument();

      const appendText = () => {
        scrollHeight += 100;
        context.state.details.thread = {
          ...context.state.details.thread,
          turns: [
            {
              ...context.state.details.thread.turns[0],
              items: [{ ...item, text: `${item.text}. Продолжение ${scrollHeight}` }],
            },
          ],
        };
        view.rerender(threadRoute());
      };

      appendText();

      expect(scrollTo).not.toHaveBeenCalled();
      expect(scroll.scrollTop).toBe(470);

      // Approaching the bottom is insufficient; reaching it resumes following.
      scroll.scrollTop = scrollHeight - scroll.clientHeight - 10;
      fireEvent.scroll(scroll);
      appendText();
      expect(scrollTo).not.toHaveBeenCalled();

      scroll.scrollTop = scrollHeight - scroll.clientHeight - 0.5;
      fireEvent.scroll(scroll);
      expect(
        screen.queryByRole("button", { name: "Прокрутить к последнему сообщению" }),
      ).toBeNull();
      appendText();
      expect(scrollTo).toHaveBeenLastCalledWith({ top: scrollHeight, behavior: "auto" });

      scrollTo.mockClear();
      fireEvent.wheel(scroll, { deltaY: -2 });
      scroll.scrollTop = scrollHeight - scroll.clientHeight - 2;
      fireEvent.scroll(scroll);
      appendText();
      expect(scrollTo).not.toHaveBeenCalled();
    },
  );

  it("reloads the open chat after a reconnect snapshot without duplicating the initial read", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary);
    const view = renderThread();
    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(1));

    context.streamRecoveryEpoch += 1;
    view.rerender(threadRoute());

    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(2));
    expect(context.refreshDetail).toHaveBeenLastCalledWith("thread", { force: true });
  });

  it("retries a transient detail failure with bounded exponential backoff", async () => {
    vi.useFakeTimers();
    try {
      const context = mockThreadConnection(threadApi(), summary);
      context.refreshDetail
        .mockRejectedValueOnce(new ApiClientError("app_server_unavailable", "retry", 503))
        .mockResolvedValue(context.state.details.thread);
      renderThread();
      await act(async () => Promise.resolve());
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);

      act(() => vi.advanceTimersByTime(999));
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(context.refreshDetail).toHaveBeenCalledTimes(2);
      expect(context.refreshDetail).toHaveBeenLastCalledWith("thread", { force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a scheduled detail retry when the connection goes offline", async () => {
    vi.useFakeTimers();
    try {
      const context = mockThreadConnection(threadApi(), summary);
      context.refreshDetail.mockRejectedValue(
        new ApiClientError("app_server_unavailable", "retry", 503),
      );
      const view = renderThread();
      await act(async () => Promise.resolve());
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);

      context.state.network = "offline";
      view.rerender(threadRoute());
      act(() => vi.advanceTimersByTime(30_000));
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads the open chat as soon as the native app returns to the foreground", async () => {
    const api = threadApi();
    const context = mockThreadConnection(api, summary);
    const view = renderThread();
    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(1));

    context.foregroundEpoch += 1;
    view.rerender(threadRoute());

    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(2));
    expect(context.refreshDetail).toHaveBeenLastCalledWith("thread", { force: true });
  });

  it("marks an unseen open thread as viewed only while the app is active", async () => {
    const api = threadApi();
    const unseen = {
      ...summary,
      state: "completed" as const,
      unread: true,
      unseen: true,
      updatedAt: 123,
    };
    const context = mockThreadConnection(api, unseen);
    context.appActive = false;
    const view = renderThread();

    expect(api.markViewed).not.toHaveBeenCalled();
    context.appActive = true;
    view.rerender(threadRoute());

    await waitFor(() =>
      expect(api.markViewed).toHaveBeenCalledWith("thread", { observedUpdatedAt: 123 }),
    );
  });

  it("deduplicates viewed marks per thread version and marks a newer outcome", async () => {
    const api = threadApi();
    const unseen = {
      ...summary,
      state: "completed" as const,
      unread: true,
      unseen: true,
      updatedAt: 123,
    };
    const context = mockThreadConnection(api, unseen);
    const view = renderThread();
    await waitFor(() => expect(api.markViewed).toHaveBeenCalledTimes(1));

    view.rerender(threadRoute());
    expect(api.markViewed).toHaveBeenCalledTimes(1);

    const newer = { ...unseen, updatedAt: 456 };
    context.state.snapshot.threads = [newer];
    context.state.details.thread = { ...context.state.details.thread, summary: newer };
    view.rerender(threadRoute());

    await waitFor(() => expect(api.markViewed).toHaveBeenCalledTimes(2));
    expect(api.markViewed).toHaveBeenLastCalledWith("thread", { observedUpdatedAt: 456 });
  });

  it("retries a failed viewed mark after the connection recovers", async () => {
    const api = threadApi();
    api.markViewed.mockRejectedValueOnce(new Error("offline"));
    const unseen = {
      ...summary,
      state: "completed" as const,
      unread: true,
      unseen: true,
      updatedAt: 123,
    };
    const context = mockThreadConnection(api, unseen);
    const view = renderThread();
    await waitFor(() => expect(api.markViewed).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());

    context.state.network = "offline";
    view.rerender(threadRoute());
    context.state.network = "connected";
    view.rerender(threadRoute());

    await waitFor(() => expect(api.markViewed).toHaveBeenCalledTimes(2));
  });

  it("does not poll completed chat content when only a plan is available", () => {
    vi.useFakeTimers();
    try {
      const completed = { ...summary, state: "completed" as const, updatedAt: 3 };
      const context = mockThreadConnection(threadApi(), completed, {
        turns: [
          {
            id: "turn",
            status: "completed",
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
            progress: progress(),
            items: [
              {
                type: "plan",
                id: "plan",
                status: "completed",
                text: "План",
                images: [],
                timestamp: 2,
                phase: null,
              },
            ],
          },
        ],
      });
      renderThread();

      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(499));
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(1));
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(5_000));
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a completed chat that already has a final answer", () => {
    vi.useFakeTimers();
    try {
      const completed = { ...summary, state: "completed" as const, updatedAt: 3 };
      const context = mockThreadConnection(threadApi(), completed, {
        turns: [completedAgentTurn()],
      });
      renderThread();

      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(500));
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending completed chat retry when the page closes", () => {
    vi.useFakeTimers();
    try {
      const completed = { ...summary, state: "completed" as const, updatedAt: 3 };
      const context = mockThreadConnection(threadApi(), completed, {
        turns: [
          {
            id: "turn",
            status: "completed",
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
            progress: progress(),
            items: [
              {
                type: "plan",
                id: "plan",
                status: "completed",
                text: "План",
                images: [],
                timestamp: 2,
                phase: null,
              },
            ],
          },
        ],
      });
      const view = renderThread();

      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
      view.unmount();
      act(() => vi.advanceTimersByTime(500));
      expect(context.refreshDetail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start content-based recovery reads when turn details disagree", async () => {
    const api = threadApi();
    const running = { ...summary, state: "running" as const, currentTurnId: "missing-turn" };
    const context = mockThreadConnection(api, running, {
      turns: [
        {
          id: "plan-turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          progress: progress(),
          items: [
            {
              type: "plan",
              id: "plan",
              status: "completed",
              text: "Одобренный план",
              images: [],
              timestamp: 2,
              phase: null,
            },
          ],
        },
      ],
    });
    const view = renderThread();

    expect(screen.getByText("Codex работает")).toBeInTheDocument();
    await waitFor(() => expect(context.refreshDetail).toHaveBeenCalledTimes(1));
    expect(context.refreshDetail).not.toHaveBeenCalledWith("thread", { authoritative: true });
    expect(context.forceRefreshDetail).not.toHaveBeenCalled();

    context.state.snapshot.threads = [{ ...running, state: "completed", currentTurnId: null }];
    context.state.details.thread = {
      ...context.state.details.thread,
      summary: { ...running, state: "completed", currentTurnId: null },
      turns: [
        {
          id: "stale-turn",
          status: "inProgress",
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
          progress: progress(),
          items: [],
        },
      ],
    };
    view.rerender(threadRoute());
    expect(screen.queryByText(/Codex работает/)).toBeNull();
    expect(context.refreshDetail).toHaveBeenCalledTimes(1);

    context.state.details.thread = {
      ...context.state.details.thread,
      turns: [
        {
          ...context.state.details.thread.turns[0]!,
          status: "completed",
          completedAt: Date.now(),
        },
      ],
    };
    view.rerender(threadRoute());
    expect(context.refreshDetail).toHaveBeenCalledTimes(1);
  });

  it("opens a loaded conversation at the bottom", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 900,
    });
    const api = threadApi();
    mockThreadConnection(api, summary);
    const view = renderThread();
    const scroll = view.container.querySelector(".conversation-scroll") as HTMLDivElement;
    expect(scroll.scrollTop).toBe(900);
    delete (HTMLElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
  });

  it("offers an explicit retry for a recording retained after reload", async () => {
    const api = threadApi();
    const initialDraft: ThreadDraft = {
      input: "Текущий черновик",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 20,
    };
    const context = mockThreadConnection(api, summary, { draft: initialDraft });
    context.pendingVoiceRecordingThreadIds = ["thread"];
    context.pendingVoiceRecordingErrors = {
      thread: "The draft changed before voice upload",
    };
    render(voiceThreadRoute());

    const retry = await screen.findByRole("button", { name: "Повторить сохранённую запись" });
    expect(
      screen.getByText(
        "Черновик изменился; сохранённая запись не была потеряна. Повторите восстановление.",
      ),
    ).toBeTruthy();
    fireEvent.click(retry);

    await waitFor(() => expect(context.retryPendingVoiceRecording).toHaveBeenCalledOnce());
    expect(context.retryPendingVoiceRecording).toHaveBeenCalledWith({
      threadId: "thread",
      mode: "send",
      draft: expect.objectContaining({ input: "Текущий черновик" }),
      draftUpdatedAt: expect.any(Number),
    });
  });

  it("uploads voice for its source session and leaves other sessions usable", async () => {
    installMediaRecorder(async () => {
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    });
    let resolveAccepted:
      | ((value: {
          id: string;
          threadId: string;
          mode: "send";
          status: "queued";
          createdAt: number;
          startedAt: null;
          audioDurationMs: number;
          estimatedTotalSeconds: null;
          error: null;
        }) => void)
      | undefined;
    const api = threadApi();
    api.createVoiceTranscription.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccepted = resolve;
        }),
    );
    const initialDraft: ThreadDraft = {
      input: "Начало конец",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 1,
    };
    const context = mockThreadConnection(api, summary, { draft: initialDraft });
    const other = { ...summary, id: "other", title: "Другая задача" };
    const details = context.state.details as Record<string, ThreadDetail>;
    context.state.snapshot.threads = [summary, other];
    details.other = {
      summary: other,
      turns: [],
      queuedMessages: [],
      olderTurnsCursor: null,
      draft: null,
    };
    render(voiceThreadRoute());

    const textarea = (await screen.findByRole("textbox", {
      name: "Сообщение для Codex",
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).toHaveValue("Начало конец"));
    textarea.setSelectionRange(7, 7);
    fireEvent.select(textarea);
    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    await screen.findByRole("button", { name: "Остановить запись" });
    fireEvent.click(screen.getByRole("link", { name: "Открыть B" }));

    await screen.findByRole("heading", { name: "Другая задача" });
    await waitFor(() => expect(api.createVoiceTranscription).toHaveBeenCalledOnce());
    expect(context.queueVoiceRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread",
        draft: expect.objectContaining({ input: "Начало конец" }),
      }),
    );
    expect(api.updateThreadDraft).not.toHaveBeenCalled();
    expect(api.createVoiceTranscription).toHaveBeenCalledWith(
      "thread",
      expect.objectContaining({ type: "audio/webm;codecs=opus" }),
      expect.objectContaining({
        mode: "send",
        selectionStart: 7,
        selectionEnd: 7,
        draftUpdatedAt: expect.any(Number),
      }),
    );
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).not.toHaveAttribute(
      "readonly",
    );
    resolveAccepted?.({
      id: "voice",
      threadId: "thread",
      mode: "send",
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      audioDurationMs: 1,
      estimatedTotalSeconds: null,
      error: null,
    });
  });

  it.each([
    { running: false, storedMode: "draft", expectedMode: "send" },
    { running: false, storedMode: "send", expectedMode: "send" },
    { running: true, storedMode: "draft", expectedMode: "steer" },
    { running: true, storedMode: "send", expectedMode: "steer" },
  ] as const)(
    "routes voice to $expectedMode when running=$running with legacy preference=$storedMode",
    async ({ running, storedMode, expectedMode }) => {
      localStorage.setItem("codexnest.voiceInputMode", storedMode);
      installMediaRecorder(async () => {
        return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
      });
      const api = threadApi();
      api.createVoiceTranscription.mockImplementation(() => new Promise(() => undefined));
      const thread = running
        ? { ...summary, state: "running" as const, currentTurnId: "turn" }
        : summary;
      mockThreadConnection(api, thread, {
        draft: {
          input: "Черновик",
          images: [],
          goalMode: false,
          annotations: [],
          updatedAt: 1,
        },
      });
      const view = render(voiceThreadRoute());
      await waitFor(() =>
        expect(
          screen.getByRole("textbox", {
            name: running ? "Направить текущую задачу" : "Сообщение для Codex",
          }),
        ).toHaveValue("Черновик"),
      );

      fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
      fireEvent.click(await screen.findByRole("button", { name: "Остановить запись" }));

      await waitFor(() =>
        expect(api.createVoiceTranscription).toHaveBeenCalledWith(
          "thread",
          expect.any(Blob),
          expect.objectContaining({ mode: expectedMode }),
        ),
      );
      expect(Boolean(view.container.querySelector(".voice-transcription-message"))).toBe(true);
    },
  );

  it("uses the agent state at recording stop rather than recording start", async () => {
    installMediaRecorder(async () => {
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    });
    const api = threadApi();
    api.createVoiceTranscription.mockImplementation(() => new Promise(() => undefined));
    const context = mockThreadConnection(api, summary);
    const view = render(voiceThreadRoute());

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    const stop = await screen.findByRole("button", { name: "Остановить запись" });
    const running = { ...summary, state: "running" as const, currentTurnId: "turn" };
    context.state.snapshot.threads = [running];
    context.state.details.thread.summary = running;
    view.rerender(voiceThreadRoute());
    fireEvent.click(stop);

    await waitFor(() =>
      expect(api.createVoiceTranscription).toHaveBeenCalledWith(
        "thread",
        expect.any(Blob),
        expect.objectContaining({ mode: "steer" }),
      ),
    );
  });

  it("hides questions during voice upload and restores the same form after an upload error", async () => {
    installMediaRecorder(
      async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
    );
    const api = threadApi();
    let rejectUpload!: (error: Error) => void;
    api.createVoiceTranscription.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        }),
    );
    const context = mockThreadConnection(
      api,
      { ...summary, state: "needsAttention", currentTurnId: "turn" },
      {
        attention: [pendingInputRequest()],
        draft: {
          input: "Текст к записи",
          images: [],
          goalMode: false,
          annotations: [],
          updatedAt: 1,
        },
      },
    );
    const view = render(voiceThreadRoute());
    fireEvent.change(screen.getByRole("textbox", { name: "Свой ответ" }), {
      target: { value: "Несохранённый ответ" },
    });
    const composer = within(view.container.querySelector(".composer")! as HTMLElement);
    fireEvent.click(composer.getByRole("button", { name: "Начать запись" }));
    await composer.findByRole("button", { name: "Остановить запись" });
    expect(screen.getByRole("region", { name: "Требуется внимание" })).toBeVisible();
    fireEvent.click(composer.getByRole("button", { name: "Остановить запись" }));
    await waitFor(() =>
      expect(context.queueVoiceRecording).toHaveBeenCalledWith(
        expect.objectContaining({ dismissUserInput: { turnId: "turn", itemId: "question" } }),
      ),
    );
    expect(screen.queryByRole("region", { name: "Требуется внимание" })).toBeNull();
    const uploading = await screen.findByRole("status", { name: "Отправляем запись" });
    expect(uploading).toHaveTextContent("Текст к записи");
    expect(composer.getByRole("textbox", { name: "Направить текущую задачу" })).toHaveValue("");
    await act(async () => rejectUpload(new Error("Upload failed")));
    expect(screen.getByRole("textbox", { name: "Свой ответ" })).toHaveValue("Несохранённый ответ");
    expect(composer.getByRole("textbox", { name: "Направить текущую задачу" })).toHaveValue(
      "Текст к записи",
    );
  });

  it.each(["failed", "cancelled", "draft"])("restores questions for a %s voice job", (outcome) => {
    const context = mockThreadConnection(
      threadApi(),
      { ...summary, state: "needsAttention", currentTurnId: "turn" },
      { attention: [pendingInputRequest()] },
    );
    const job: VoiceTranscriptionJob = {
      id: "voice",
      threadId: "thread",
      mode: "queue",
      status: "transcribing",
      createdAt: 2,
      startedAt: 2,
      audioDurationMs: 1000,
      estimatedTotalSeconds: null,
      error: null,
      dismissUserInput: { turnId: "turn", itemId: "question" },
    };
    context.state.snapshot.voiceTranscriptions = [job];
    const view = render(voiceThreadRoute());
    expect(screen.queryByRole("region", { name: "Требуется внимание" })).toBeNull();
    context.state.snapshot.voiceTranscriptions =
      outcome === "cancelled"
        ? []
        : [
            {
              ...job,
              ...(outcome === "failed"
                ? { status: "failed" as const, error: "No speech" }
                : { mode: "draft" as const }),
            },
          ];
    view.rerender(voiceThreadRoute());
    expect(screen.getByRole("region", { name: "Требуется внимание" })).toBeVisible();
  });

  it("blocks for a remote voice job without presenting it as a local recording", async () => {
    const context = mockThreadConnection(threadApi(), summary, {
      draft: {
        input: "Оставить в поле",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 1,
      },
    });
    context.state.snapshot.voiceTranscriptions = [
      {
        id: "voice",
        threadId: "thread",
        mode: "draft",
        status: "queued",
        createdAt: Date.now(),
        startedAt: null,
        audioDurationMs: 2_000,
        estimatedTotalSeconds: null,
        error: null,
      },
    ];
    const view = render(voiceThreadRoute());

    const microphone = view.container.querySelector<HTMLButtonElement>("button.microphone");
    expect(microphone).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveAttribute(
      "readonly",
    );
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue(
      "Оставить в поле",
    );
    expect(microphone!).toBeDisabled();
    expect(within(microphone!).queryByText("0:00")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отменить обработку записи" }));
    await waitFor(() =>
      expect(context.api.cancelVoiceTranscription).toHaveBeenCalledWith("thread"),
    );
  });

  it.each(["send", "queue", "steer"] as const)(
    "restores a %s transcription countdown as a user bubble",
    async (mode) => {
      const context = mockThreadConnection(threadApi(), {
        ...summary,
        state: "completed",
        unread: true,
      });
      context.state.snapshot.voiceTranscriptions = [
        {
          id: "voice",
          threadId: "thread",
          mode,
          status: "queued",
          createdAt: Date.now(),
          startedAt: null,
          audioDurationMs: 2_000,
          estimatedTotalSeconds: 10,
          error: null,
        },
      ];
      const view = render(voiceThreadRoute());

      const queued = await screen.findByRole("status", { name: "На сервере · ожидание" });
      expect(queued).toHaveTextContent("0:00");

      context.state.snapshot.voiceTranscriptions[0] = {
        ...context.state.snapshot.voiceTranscriptions[0]!,
        status: "transcribing",
        startedAt: Date.now() - 2_000,
      };
      view.rerender(voiceThreadRoute());

      const progress = await screen.findByRole("status", { name: "Распознаём" });
      expect(progress).toHaveClass("message", "userMessage", "voice-transcription-message");
      expect(progress).toHaveTextContent("Распознаём");
      expect(progress).toHaveTextContent("≈0:08");
      expect(view.container.querySelector(".composer .microphone")).not.toHaveClass("timing");
      expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveAttribute(
        "readonly",
      );
      expect(screen.queryByRole("button", { name: "Закончить" })).toBeNull();
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "shows the pending voice draft in the chat and restores it when %s",
    async (outcome) => {
      const draft: ThreadDraft = {
        input: "Проверь этот скриншот",
        images: [{ id: "image", name: "screen.png", url: "data:image/png;base64,AA==" }],
        files: [
          {
            id: "file",
            name: "notes.txt",
            path: "/work/project/notes.txt",
            size: 12,
            mediaType: "text/plain",
          },
        ],
        goalMode: false,
        annotations: [],
        updatedAt: 1,
      };
      const context = mockThreadConnection(threadApi(), summary, { draft });
      context.state.snapshot.voiceTranscriptions = [
        {
          id: "voice",
          threadId: "thread",
          mode: "send",
          status: "transcribing",
          createdAt: Date.now(),
          startedAt: Date.now(),
          audioDurationMs: 2_000,
          estimatedTotalSeconds: null,
          error: null,
        },
      ];
      const view = render(voiceThreadRoute());

      const progress = await screen.findByRole("status", { name: "Распознаём" });
      expect(progress).toHaveTextContent("Проверь этот скриншот");
      expect(within(progress).getByRole("button", { name: "Открыть изображение 1" })).toBeVisible();
      expect(within(progress).getByRole("button", { name: "notes.txt" })).toBeVisible();
      expect(
        progress
          .querySelector(".voice-transcription-status")!
          .compareDocumentPosition(within(progress).getByText("Проверь этот скриншот")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("");
      expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveAttribute(
        "readonly",
      );
      expect(view.container.querySelector(".composer-attachments")).toBeNull();

      if (outcome === "failed") {
        context.state.snapshot.voiceTranscriptions[0] = {
          ...context.state.snapshot.voiceTranscriptions[0]!,
          status: "failed",
          error: "No speech",
        };
      } else {
        context.state.snapshot.voiceTranscriptions = [];
      }
      view.rerender(voiceThreadRoute());

      expect(screen.queryByRole("status", { name: "Распознаём" })).toBeNull();
      expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue(
        "Проверь этот скриншот",
      );
      expect(screen.getByRole("button", { name: "Открыть изображение screen.png" })).toBeVisible();
      expect(screen.getByText("notes.txt")).toBeVisible();
    },
  );

  it("shows a recovered local draft in the voice bubble when history is unavailable", async () => {
    const context = mockThreadConnection(threadApi(), summary);
    Reflect.deleteProperty(context.state.details, "thread");
    context.refreshDetail.mockRejectedValue(
      new ApiClientError("not_found", "Session history is unavailable", 404),
    );
    loadLocalDraft.mockResolvedValue({
      value: {
        input: "Сохранённый текст",
        images: [{ id: "image", name: "screen.png", url: "data:image/png;base64,AA==" }],
        goalMode: false,
        annotations: [],
      },
      updatedAt: 2,
    });
    context.state.snapshot.voiceTranscriptions = [
      {
        id: "voice",
        threadId: "thread",
        mode: "send",
        status: "transcribing",
        createdAt: Date.now(),
        startedAt: Date.now(),
        audioDurationMs: 2_000,
        estimatedTotalSeconds: null,
        error: null,
      },
    ];
    render(voiceThreadRoute());

    const progress = await screen.findByRole("status", { name: "Распознаём" });
    await waitFor(() => expect(progress).toHaveTextContent("Сохранённый текст"));
    expect(within(progress).getByRole("button", { name: "Открыть изображение 1" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Повторить загрузку истории" })).toBeVisible();
  });

  it("hides an automatic transcription bubble once its queued message materializes", () => {
    const context = mockThreadConnection(threadApi(), summary, {
      draft: {
        input: "Черновик",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 1,
      },
      queuedMessages: [
        {
          id: "voice",
          threadId: "thread",
          text: "Распознанный текст",
          createdAt: Date.now(),
          status: "queued",
        },
      ],
    });
    context.state.snapshot.voiceTranscriptions = [
      {
        id: "voice",
        threadId: "thread",
        mode: "send",
        status: "applying",
        createdAt: Date.now() - 3_000,
        startedAt: Date.now() - 2_000,
        audioDurationMs: 2_000,
        estimatedTotalSeconds: 2,
        error: null,
      },
    ];
    const view = render(voiceThreadRoute());

    expect(view.container.querySelector(".voice-transcription-message")).toBeNull();
    expect(screen.getByText("Распознанный текст")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("");
  });

  it("restores a failed voice job without keeping the composer locked", async () => {
    installMediaRecorder(async () => {
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    });
    const context = mockThreadConnection(threadApi(), summary);
    context.state.snapshot.voiceTranscriptions = [
      {
        id: "voice",
        threadId: "thread",
        mode: "draft",
        status: "failed",
        createdAt: Date.now(),
        startedAt: Date.now(),
        audioDurationMs: 2_000,
        estimatedTotalSeconds: null,
        error: "No speech was detected in the recording",
      },
    ];
    render(voiceThreadRoute());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "В записи не обнаружена речь. Проверьте микрофон и запишите ещё раз.",
    );
    expect(alert).toHaveClass("voice-transcription-error");
    expect(alert.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).not.toHaveAttribute(
      "readonly",
    );
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
  });

  it("refreshes the draft after a background transcription completes", async () => {
    const context = mockThreadConnection(threadApi(), summary);
    const view = render(voiceThreadRoute());
    await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    context.refreshDetail.mockClear();

    context.state.voiceRemovals.thread = {
      jobId: "voice-draft",
      outcome: "draft",
    };
    view.rerender(voiceThreadRoute());

    await waitFor(() =>
      expect(context.refreshDetail).toHaveBeenCalledWith("thread", { force: true }),
    );
  });

  it("clears text and images after background auto-send before refreshing the draft", async () => {
    let finishLocalDraftDelete: (() => void) | undefined;
    deleteLocalDraft.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLocalDraftDelete = resolve;
        }),
    );
    const api = threadApi();
    const context = mockThreadConnection(api, summary, {
      draft: {
        input: "Текст и голос",
        images: [
          {
            id: "voice-image",
            name: "screenshot.png",
            url: "data:image/png;base64,AA==",
          },
        ],
        goalMode: false,
        annotations: [],
        updatedAt: 1,
      },
    });
    const view = render(voiceThreadRoute());
    const textarea = await screen.findByRole("textbox", {
      name: "Сообщение для Codex",
    });
    await waitFor(() => expect(textarea).toHaveValue("Текст и голос"));
    expect(screen.getByAltText("screenshot.png")).toBeInTheDocument();
    context.dispatch.mockClear();
    context.refreshDetail.mockClear();

    context.state.voiceRemovals.thread = {
      jobId: "voice-send",
      outcome: "send",
    };
    view.rerender(voiceThreadRoute());

    await waitFor(() => expect(textarea).toHaveValue(""));
    expect(screen.queryByAltText("screenshot.png")).toBeNull();
    expect(context.dispatch).toHaveBeenCalledWith({
      type: "draft",
      threadId: "thread",
      draft: null,
    });
    expect(deleteLocalDraft).toHaveBeenCalledWith(api.settings, "thread");
    expect(context.refreshDetail).not.toHaveBeenCalled();

    await act(async () => finishLocalDraftDelete?.());

    expect(context.refreshDetail).toHaveBeenCalledWith("thread", { force: true });
  });
});

function pendingInputRequest(
  itemId = "question",
): Extract<AttentionRequest, { kind: "userInput" }> {
  return {
    id: "attention",
    threadId: "thread",
    turnId: "turn",
    itemId,
    createdAt: 1,
    kind: "userInput",
    autoResolutionMs: null,
    questions: ["Первый", "Второй"].map((header, index) => ({
      id: `question-${index}`,
      header,
      question: `${header} вопрос?`,
      isOther: true,
      isSecret: false,
      options: null,
    })),
  };
}

function renderThread(state?: Record<string, unknown>) {
  return render(threadRoute(state));
}

function threadRoute(state?: Record<string, unknown>) {
  return (
    <MemoryRouter initialEntries={[{ pathname: "/threads/thread", state }]}>
      <Routes>
        <Route
          path="/threads/:threadId"
          element={<ThreadPage onOpenNavigation={() => undefined} />}
        />
        <Route path="/" element={<div>Нет открытых сессий</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function forkThreadRoute() {
  return (
    <MemoryRouter initialEntries={["/threads/thread"]}>
      <Routes>
        <Route
          path="/threads/:threadId"
          element={
            <>
              <ThreadPage onOpenNavigation={() => undefined} />
              <ForkLocation />
            </>
          }
        />
        <Route path="/fork-operations/:operationId" element={<ForkLocation />} />
      </Routes>
    </MemoryRouter>
  );
}

function ForkLocation() {
  const location = useLocation();
  return (
    <output data-testid="fork-location">
      {location.pathname}:
      {String((location.state as { focusComposer?: unknown } | null)?.focusComposer === true)}
    </output>
  );
}

function voiceThreadRoute() {
  return (
    <MemoryRouter initialEntries={["/threads/thread"]}>
      <Link to="/threads/thread">Открыть A</Link>
      <Link to="/threads/other">Открыть B</Link>
      <Routes>
        <Route
          path="/threads/:threadId"
          element={
            <ThreadPage
              transcriptionConfig={transcriptionConfig}
              transcriptionProvider="local"
              onOpenNavigation={() => undefined}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

const transcriptionConfig: TranscriptionConfigResponse = {
  providers: ["local"],
  provider: "local",
  localUrl: "http://127.0.0.1:8178/inference",
  openAiApiKeyConfigured: false,
  openAiModel: "gpt-4o-transcribe",
  language: "ru",
  refineLocal: false,
  refinementModel: "gpt-5.6-luna",
  maxRecordingSeconds: 300,
  maxUploadBytes: 24 * 1024 * 1024,
  timingEstimate: {
    sampleCount: 5,
    estimatedFixedProcessingMs: 2_000,
    estimatedProcessingMsPerAudioSecond: 4_000,
  },
};

function installMediaRecorder(getUserMedia: () => Promise<MediaStream>) {
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported = vi.fn(() => true);
    readonly mimeType: string;
    state: RecordingState = "inactive";

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      super();
      this.mimeType = options?.mimeType ?? "audio/webm";
    }

    start() {
      this.state = "recording";
    }

    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      const data = new Blob(["audio"], { type: this.mimeType });
      const dataEvent = new Event("dataavailable") as BlobEvent;
      Object.defineProperty(dataEvent, "data", { value: data });
      this.dispatchEvent(dataEvent);
      this.dispatchEvent(new Event("stop"));
    }
  }

  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia) },
  });
}

function completedPlanDetail() {
  return {
    turns: [
      {
        id: "plan-turn",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
        progress: progress(),
        items: [
          {
            type: "plan",
            id: "plan",
            status: "completed",
            text: "# План\n\nСделать",
            images: [],
            timestamp: 2,
            phase: null,
          },
        ],
      },
    ],
  } satisfies NonNullable<Parameters<typeof mockThreadConnection>[2]>;
}

function threadApi() {
  return {
    settings: { baseUrl: "https://codex.home.arpa", token: "secret" },
    createDownload: vi.fn().mockResolvedValue({
      downloadUrl: "/downloads/ticket/file.bin",
      expiresAt: Date.now() + 60_000,
    }),
    estimateFork: vi.fn().mockResolvedValue({
      sourceBytes: 1_000,
      compressed: {
        available: true,
        estimatedBytes: 300,
        estimatedSeconds: { minSeconds: 1, maxSeconds: 2 },
        unavailableReason: null,
      },
      exact: {
        available: true,
        estimatedBytes: 1_000,
        estimatedSeconds: { minSeconds: 2, maxSeconds: 4 },
        unavailableReason: null,
      },
    }),
    createForkOperation: vi.fn().mockResolvedValue({
      operation: {
        id: "operation",
        sourceThreadId: "thread",
        lastTurnId: "turn",
        agentMessageId: "answer",
        mode: "compressed",
        status: "preparing",
        title: "",
        createdAt: 1,
        updatedAt: 1,
        targetThreadId: null,
        queuedMessageCount: 0,
        estimate: null,
        error: null,
      },
    }),
    startTurn: vi.fn().mockResolvedValue({ turnId: "turn" }),
    updateThreadDraft: vi
      .fn()
      .mockImplementation((_id, draft) =>
        Promise.resolve(
          draft.input ||
            draft.images.length ||
            draft.files?.length ||
            draft.goalMode ||
            draft.annotations.length
            ? { ...draft, updatedAt: Date.now() }
            : null,
        ),
      ),
    uploadAttachment: vi.fn().mockImplementation((_id, file: File) =>
      Promise.resolve({
        id: "00000000-0000-0000-0000-000000000001",
        name: file.name,
        path: `/attachments/${file.name}`,
        size: file.size,
        mediaType: file.type || "application/octet-stream",
      }),
    ),
    deleteAttachment: vi.fn().mockResolvedValue(undefined),
    enqueue: vi.fn().mockResolvedValue({ id: "queued" }),
    sendQueuedNow: vi.fn().mockResolvedValue({ turnId: "turn" }),
    updateQueued: vi.fn().mockResolvedValue({ id: "queued" }),
    deleteQueued: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    updateThread: vi.fn().mockResolvedValue(summary),
    updateThreadSettings: vi.fn().mockImplementation((_id, patch) =>
      Promise.resolve({
        ...summary,
        settings: { ...summary.settings, ...patch },
      }),
    ),
    archive: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    dismissPlan: vi
      .fn<
        (id: string, body: { turnId: string; observedUpdatedAt: number }) => Promise<ThreadSummary>
      >()
      .mockResolvedValue(summary),
    markViewed: vi.fn().mockResolvedValue(undefined),
    readGitChanges: vi
      .fn()
      .mockResolvedValue({ state: "clean", filesChanged: 0, additions: 0, deletions: 0 }),
    readThreadArtifacts: vi.fn().mockResolvedValue({ capability: "explicit", artifacts: [] }),
    readGoal: vi.fn().mockResolvedValue(null),
    updateGoal: vi.fn().mockResolvedValue(null),
    clearGoal: vi.fn().mockResolvedValue(undefined),
    transcribe: vi.fn().mockResolvedValue({
      text: "голос",
      timingEstimate: {
        sampleCount: 5,
        estimatedFixedProcessingMs: 2_000,
        estimatedProcessingMsPerAudioSecond: 4_000,
      },
    }),
    createVoiceTranscription: vi.fn().mockResolvedValue({
      id: "voice",
      threadId: "thread",
      mode: "draft",
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      audioDurationMs: 1_000,
      estimatedTotalSeconds: null,
      error: null,
    }),
    cancelVoiceTranscription: vi.fn().mockResolvedValue(undefined),
  };
}

function mockThreadConnection(
  api: ReturnType<typeof threadApi>,
  thread: ThreadSummary,
  detailPatch: Partial<{
    turns: Array<{
      id: string;
      status: "inProgress" | "completed" | "failed" | "interrupted";
      failureKind?: "modelCapacity";
      startedAt: number | null;
      completedAt: number | null;
      durationMs: number | null;
      progress: ReturnType<typeof progress>;
      items: Array<Parameters<typeof Activity>[0]["item"]>;
      itemsLoaded?: boolean;
    }>;
    queuedMessages: QueuedMessage[];
    olderTurnsCursor: string | null;
    draft: ThreadDetail["draft"];
    attention: AttentionRequest[];
  }> = {},
) {
  const detail = {
    summary: thread,
    turns: detailPatch.turns ?? [],
    queuedMessages: detailPatch.queuedMessages ?? [],
    olderTurnsCursor: detailPatch.olderTurnsCursor ?? null,
    draft: detailPatch.draft ?? null,
  };
  const value = {
    api,
    appActive: true,
    foregroundEpoch: 0,
    streamRecoveryEpoch: 0,
    state: {
      snapshot: {
        instanceId: "test-instance",
        sequence: 1,
        projects: [
          {
            id: "project",
            displayName: "Проект",
            path: "/work/project",
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
          },
        ],
        threads: [thread] as ThreadSummary[],
        attention: detailPatch.attention ?? [],
        voiceTranscriptions: [] as VoiceTranscriptionJob[],
        models: [
          {
            id: "gpt",
            displayName: "GPT",
            description: "",
            isDefault: true,
            reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
            serviceTiers: [],
            supportsPersonality: true,
          },
        ],
        connection: { state: "ready" },
      },
      details: { thread: detail },
      expandedHistory: {},
      optimisticMessages: {} as Record<string, OptimisticMessage[]>,
      voiceRemovals: {} as Record<
        string,
        { jobId: string; outcome: "draft" | "send" | "cancelled" }
      >,
      network: "connected",
      snapshotEpoch: 1,
    },
    refreshDetail: vi.fn().mockResolvedValue(detail),
    forceRefreshDetail: vi.fn().mockResolvedValue(detail),
    loadOlderDetail: vi.fn().mockResolvedValue(detail),
    loadTurnItems: vi.fn().mockResolvedValue(undefined),
    sendReliable: vi.fn().mockImplementation((threadId, body, onCommitted?: () => void) => {
      const delivery = thread.currentTurnId
        ? api.enqueue(threadId, body)
        : api.startTurn(threadId, body);
      onCommitted?.();
      return delivery;
    }),
    queueVoiceRecording: vi.fn().mockImplementation((recording) =>
      api.createVoiceTranscription(recording.threadId, recording.audio, {
        recordingDurationMs: recording.durationMs,
        mode: recording.mode,
        selectionStart: recording.selectionStart,
        selectionEnd: recording.selectionEnd,
        draftUpdatedAt: recording.draftUpdatedAt,
        clientUploadId: recording.id,
      }),
    ),
    pendingVoiceRecordingThreadIds: [] as string[],
    pendingVoiceRecordingErrors: {} as Record<string, string>,
    retryPendingVoiceRecording: vi.fn().mockResolvedValue(undefined),
    dispatch: vi.fn(),
  };
  connection.mockReturnValue(value);
  return value;
}

function pendingAnnotation(overrides: Partial<PendingAnnotation> = {}): PendingAnnotation {
  return {
    id: "annotation",
    messageId: "agent-answer",
    source: "agentMessage",
    quote: "фрагмент ответа",
    startOffset: 8,
    endOffset: 23,
    comment: "Уточни формулировку",
    createdAt: 1,
    ...overrides,
  };
}

function completedAgentTurn() {
  return {
    id: "completed-turn",
    status: "completed" as const,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    progress: progress(),
    items: [
      {
        type: "agentMessage" as const,
        id: "agent-answer",
        status: "completed" as const,
        text: "Готовый фрагмент ответа",
        images: [],
        timestamp: 2,
        phase: "final_answer" as const,
      },
    ],
  };
}

function progress(): TurnProgress {
  return {
    startedAt: 1,
    explanation: null,
    steps: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
}

function selectText(element: HTMLElement, start: number, end: number) {
  const node = element.firstChild!;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}
