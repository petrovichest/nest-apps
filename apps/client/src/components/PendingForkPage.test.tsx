import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";

import type { ThreadDetail, ThreadSummary } from "@codexnest/protocol";

import type { ForkOperationSummary } from "../forks";
import { PendingForkPage } from "./PendingForkPage";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));

const source: ThreadSummary = {
  id: "source",
  relation: { kind: "session", sessionId: "source" },
  projectId: "project",
  title: "Исходная задача",
  preview: "",
  cwd: "/work",
  state: "completed",
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

const operation: ForkOperationSummary = {
  id: "operation",
  sourceThreadId: source.id,
  lastTurnId: "included",
  agentMessageId: "included-answer",
  mode: "exact",
  status: "preparing",
  title: "",
  createdAt: 1,
  updatedAt: 1,
  targetThreadId: null,
  queuedMessageCount: 1,
  estimate: null,
  error: null,
};

const detail: ThreadDetail = {
  summary: source,
  olderTurnsCursor: null,
  queuedMessages: [],
  draft: null,
  turns: [
    turn("included", "included-answer", "История до точки ответвления"),
    turn("excluded", "later-answer", "Более поздний ответ не показывается"),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

describe("PendingForkPage", () => {
  it("shows the fresh compaction stage without implying that the source changes", async () => {
    const compacting = {
      ...operation,
      mode: "compressed" as const,
      status: "reconciling" as const,
      stage: "compacting" as const,
    };
    connection.mockReturnValue(pendingContext(pendingApi(), compacting));
    renderPage(compacting);

    expect(await screen.findByText("Сжимаем контекст")).toBeVisible();
    expect(
      screen.getByText("Создаём свежее сжатие во временной копии. Исходная сессия не меняется."),
    ).toBeVisible();
  });

  it("shows source history through the selected turn and persists draft/queue on the operation", async () => {
    const api = pendingApi();
    const context = pendingContext(api, operation);
    connection.mockReturnValue(context);
    renderPage(operation);

    expect(await screen.findByText("История до точки ответвления")).toBeVisible();
    expect(screen.queryByText("Более поздний ответ не показывается")).not.toBeInTheDocument();
    expect(screen.getByText("Готовим ветку")).toBeVisible();

    const composer = await screen.findByRole("textbox", { name: "Сообщение в очередь" });
    expect(composer).toHaveValue("Сохранённый черновик");
    fireEvent.change(composer, { target: { value: "Сообщение во время подготовки" } });
    await waitFor(() =>
      expect(api.updateForkOperationDraft).toHaveBeenCalledWith(
        operation.id,
        expect.objectContaining({ input: "Сообщение во время подготовки" }),
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));
    await waitFor(() =>
      expect(api.enqueueForkOperation).toHaveBeenCalledWith(
        operation.id,
        expect.objectContaining({ input: "Сообщение во время подготовки" }),
      ),
    );
    expect(await screen.findByText("Сообщение во время подготовки")).toBeVisible();
  });

  it("replaces the pending route when ready after flushing the draft", async () => {
    const api = pendingApi();
    const context = pendingContext(api, operation);
    connection.mockReturnValue(context);
    const rendered = renderPage(operation);
    await screen.findByRole("textbox", { name: "Сообщение в очередь" });

    context.state.snapshot.forkOperations = [
      { ...operation, status: "ready", targetThreadId: "target", updatedAt: 2 },
    ];
    rendered.rerender(page(operation));

    expect(await screen.findByTestId("ready-thread")).toHaveTextContent("target");
    expect(api.updateForkOperationDraft).toHaveBeenCalled();
  });

  it.each([true, false])(
    "leaves a removed failure when source availability is %s",
    async (sourceAvailable) => {
      const failed = { ...operation, status: "failed" as const };
      const api = pendingApi();
      const context = pendingContext(api, failed);
      connection.mockReturnValue(context);
      const rendered = renderPage(failed);
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Сообщение в очередь" })).toHaveValue(
          "Сохранённый черновик",
        ),
      );

      context.state.snapshot.forkOperations = [];
      if (!sourceAvailable) context.state.snapshot.threads = [];
      rendered.rerender(page(failed));

      const route = await screen.findByTestId("ready-thread");
      expect(route).toHaveTextContent(sourceAvailable ? "source:true" : "home");
      expect(api.updateForkOperationDraft).not.toHaveBeenCalled();
    },
  );

  it("keeps the pending page on a legacy snapshot without a fork operation list", async () => {
    const api = pendingApi();
    const context = pendingContext(api, operation);
    connection.mockReturnValue(context);
    const rendered = renderPage(operation);
    await screen.findByText("Готовим ветку");

    connection.mockReturnValue({
      ...context,
      state: {
        ...context.state,
        snapshot: { ...context.state.snapshot, forkOperations: undefined },
      },
    });
    rendered.rerender(page(operation));
    expect(screen.getByText("Готовим ветку")).toBeVisible();
    expect(screen.queryByTestId("ready-thread")).toBeNull();
  });

  it("retries a failed operation with the same id", async () => {
    const failed = { ...operation, status: "failed" as const, error: "fork failed" };
    const api = pendingApi();
    connection.mockReturnValue(pendingContext(api, failed));
    renderPage(failed);

    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));

    await waitFor(() =>
      expect(api.createForkOperation).toHaveBeenCalledWith(source.id, {
        operationId: failed.id,
        lastTurnId: failed.lastTurnId,
        agentMessageId: failed.agentMessageId,
        mode: failed.mode,
      }),
    );
  });
});

function renderPage(initialOperation: ForkOperationSummary) {
  return render(page(initialOperation));
}

function page(initialOperation: ForkOperationSummary) {
  return (
    <MemoryRouter
      initialEntries={[
        {
          pathname: `/fork-operations/${initialOperation.id}`,
          state: { forkOperation: initialOperation, focusComposer: true },
        },
      ]}
    >
      {routes(initialOperation)}
    </MemoryRouter>
  );
}

function routes(initialOperation: ForkOperationSummary) {
  return (
    <Routes>
      <Route
        path="/fork-operations/:id"
        element={
          <PendingForkPage
            operationId={initialOperation.id}
            onOpenNavigation={() => undefined}
            onCloseNavigation={() => undefined}
          />
        }
      />
      <Route path="/threads/:id" element={<ThreadRoute />} />
      <Route path="/" element={<output data-testid="ready-thread">home</output>} />
    </Routes>
  );
}

function ThreadRoute() {
  const { id } = useParams();
  const location = useLocation();
  return (
    <output data-testid="ready-thread">
      {id}:{String(location.state?.focusThreadTitle === true)}
    </output>
  );
}

function pendingContext(api: ReturnType<typeof pendingApi>, activeOperation: ForkOperationSummary) {
  return {
    api,
    dispatch: vi.fn(),
    refreshDetail: vi.fn().mockResolvedValue(detail),
    state: {
      snapshot: {
        sequence: 1,
        connection: { state: "ready", message: null, syncedAt: "2026-01-01" },
        projects: [],
        threads: [source],
        attention: [],
        models: [],
        forkOperations: [activeOperation],
      },
      details: { source: detail },
    },
  };
}

function pendingApi() {
  return {
    settings: { baseUrl: "https://example.test", token: "token" },
    listSkills: vi.fn().mockResolvedValue({ cwd: "/work", skills: [], errors: [] }),
    readForkOperation: vi.fn().mockResolvedValue({
      operation,
      queuedMessages: [
        {
          id: "queued",
          threadId: operation.id,
          text: "Уже в очереди",
          createdAt: 1,
          status: "queued",
        },
      ],
      draft: {
        input: "Сохранённый черновик",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 1,
      },
    }),
    updateForkOperationDraft: vi.fn().mockResolvedValue(null),
    enqueueForkOperation: vi.fn().mockImplementation((_id, body) =>
      Promise.resolve({
        id: body.clientMessageId,
        threadId: operation.id,
        text: body.input,
        createdAt: 2,
        status: "queued",
      }),
    ),
    updateForkOperationQueued: vi.fn(),
    deleteForkOperationQueued: vi.fn(),
    createForkOperation: vi.fn().mockResolvedValue({
      operation: { ...operation, status: "preparing", error: null },
    }),
  };
}

function turn(id: string, messageId: string, text: string): ThreadDetail["turns"][number] {
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
        type: "agentMessage",
        id: messageId,
        status: "completed",
        text,
        images: [],
        timestamp: 2,
        phase: "final_answer",
      },
    ],
  };
}
