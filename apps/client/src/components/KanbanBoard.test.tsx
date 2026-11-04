import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KanbanBoard as Board,
  KanbanCard,
  KanbanRun,
  ModelOption,
  Project,
  ThreadSummary,
  TranscriptionConfigResponse,
} from "@codexnest/protocol";
import type * as OfflineStore from "../offline-store";
import { KanbanBoard } from "./KanbanBoard";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));
// Board task drafts live in IndexedDB; a map stands in for it.
const drafts = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../offline-store", async (importOriginal) => ({
  ...(await importOriginal<typeof OfflineStore>()),
  loadBoardTaskDraft: async (_settings: unknown, projectId: string) =>
    structuredClone(drafts.get(projectId) ?? null),
  saveBoardTaskDraft: async (_settings: unknown, projectId: string, value: unknown) => {
    drafts.set(projectId, structuredClone(value));
  },
}));
const models: ModelOption[] = [
  {
    id: "gpt-a",
    displayName: "GPT A",
    description: "",
    isDefault: true,
    reasoningEfforts: [{ value: "medium", description: null, isDefault: true }],
    serviceTiers: [],
    supportsPersonality: false,
  },
  {
    id: "gpt-b",
    displayName: "GPT B",
    description: "",
    isDefault: false,
    reasoningEfforts: [{ value: "low", description: null, isDefault: true }],
    serviceTiers: [],
    supportsPersonality: false,
  },
];
const project: Project = {
  id: "project",
  path: "/work/app",
  displayName: "App",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
function card(id: string, stageId = "todo"): KanbanCard {
  return {
    id,
    title: `Task ${id}`,
    description: `Description ${id}`,
    stageId,
    categoryId: "front",
    classification: "ready",
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
}
function board(cards = [card("one")]): Board {
  return {
    id: "board",
    projectPath: project.path,
    revision: 1,
    stages: [
      { id: "todo", name: "К выполнению", description: "", role: "todo" },
      { id: "working", name: "В работе", description: "", role: "working" },
      { id: "waiting", name: "Ждёт ответа", description: "", role: "waiting" },
      { id: "ready", name: "Готовые", description: "", role: "ready" },
      { id: "done", name: "Опубликовано", description: "", role: "done" },
    ],
    categories: [{ id: "front", name: "Frontend" }],
    cards,
    runs: [],
    createdAt: 1,
    updatedAt: 1,
  };
}
const voice: TranscriptionConfigResponse = {
  providers: ["local"],
  provider: "local",
  localUrl: null,
  openAiApiKeyConfigured: false,
  openAiModel: "test",
  language: "ru",
  refineLocal: false,
  refinementModel: "test",
  maxRecordingSeconds: 60,
  maxUploadBytes: 100_000,
  timingEstimate: {
    sampleCount: 0,
    estimatedFixedProcessingMs: null,
    estimatedProcessingMsPerAudioSecond: null,
  },
};
let api: {
  readKanbanImage: ReturnType<typeof vi.fn>;
  readKanban: ReturnType<typeof vi.fn>;
  createKanbanCard: ReturnType<typeof vi.fn>;
  updateKanbanCard: ReturnType<typeof vi.fn>;
  createKanbanStage: ReturnType<typeof vi.fn>;
  kanbanAction: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
  deleteKanbanCard: ReturnType<typeof vi.fn>;
  updateKanbanStage: ReturnType<typeof vi.fn>;
  deleteKanbanStage: ReturnType<typeof vi.fn>;
};
function show(
  config: TranscriptionConfigResponse | null = null,
  path = "/projects/project/kanban",
  threads: ThreadSummary[] = [],
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/projects/:projectId/kanban"
          element={
            <KanbanBoard
              projects={[project]}
              threads={threads}
              transcriptionConfig={config}
              transcriptionProvider={config?.provider ?? null}
              onOpenNavigation={vi.fn()}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  api = {
    readKanbanImage: vi.fn(),
    readKanban: vi.fn().mockResolvedValue(board()),
    createKanbanCard: vi.fn().mockResolvedValue(board()),
    updateKanbanCard: vi.fn().mockResolvedValue(board()),
    createKanbanStage: vi.fn().mockResolvedValue(board()),
    kanbanAction: vi.fn().mockResolvedValue(board()),
    transcribe: vi.fn(),
    deleteKanbanCard: vi.fn().mockResolvedValue(board()),
    updateKanbanStage: vi.fn().mockResolvedValue(board()),
    deleteKanbanStage: vi.fn().mockResolvedValue(board()),
  };
  connection.mockReturnValue({
    api: Object.assign(api, { settings: { baseUrl: "http://nest.test", token: "token" } }),
    state: { snapshot: { models } },
  });
  drafts.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function transfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "all",
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
}
function execution(cardId: string, status: KanbanRun["status"] = "completed"): KanbanRun {
  return {
    id: `run-${cardId}`,
    kind: "execute",
    cardIds: [cardId],
    provider: "codex",
    threadId: `thread-${cardId}`,
    sessionUrl: null,
    status,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("KanbanBoard", () => {
  it("filters categories locally from the header menu and restores focus on selection or Escape", async () => {
    const seed = board([card("one"), { ...card("two"), categoryId: "back" }]);
    seed.categories.push({ id: "back", name: "Backend" });
    api.readKanban.mockResolvedValue(seed);
    show();
    await screen.findByRole("button", { name: "Task one" });
    const options = screen.getByRole("group", { name: "Категория", hidden: true });
    const menu = options.closest("details")!;
    const trigger = menu.querySelector("summary")!;
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(menu.open).toBe(true);
    expect(within(options).getByRole("button", { name: "Backend" })).toHaveFocus();
    fireEvent.click(document.activeElement!);
    expect(menu.open).toBe(false);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent("Backend");
    expect(screen.queryByRole("button", { name: "Task one" })).toBeNull();
    expect(screen.getByRole("button", { name: "Task two" })).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const all = within(options).getByRole("button", { name: "Все категории" });
    expect(all).toHaveFocus();
    expect(within(options).getByRole("button", { name: "Backend" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.keyDown(all, { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent("Backend");
    fireEvent.keyDown(trigger, { key: "Home" });
    fireEvent.click(all);
    expect(trigger).toHaveTextContent("Все категории");
    expect(screen.getByRole("button", { name: "Task one" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Task two" })).toBeInTheDocument();
    expect(api.readKanban).toHaveBeenCalledTimes(1);
    expect(api.updateKanbanCard).not.toHaveBeenCalled();
  });

  it("localizes canonical server stages by role and preserves custom names", async () => {
    const seed = board();
    const names = ["To do", "In progress", "Waiting for answer", "Ready", "Published"];
    seed.stages.forEach((stage, index) => {
      stage.name = names[index];
    });
    seed.stages.push({
      id: "custom",
      name: "Review",
      description: "Custom operator stage",
      role: null,
    });
    api.readKanban.mockResolvedValue(seed);
    show();
    await screen.findByRole("region", { name: "К выполнению" });
    expect(screen.getByRole("region", { name: "В работе" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Ждёт ответа" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Готовые" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Опубликовано" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Review" })).toHaveTextContent(
      "Custom operator stage",
    );
    expect(screen.getByText(project.displayName)).toBeInTheDocument();
  });

  it("keeps a failed new task editable and sends only its text and creation identity", async () => {
    api.createKanbanCard.mockRejectedValueOnce(new Error("Cannot save task"));
    show();
    await screen.findByRole("button", { name: "Task one" });
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить задачу" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Добавить задачу" });
    const send = within(dialog).getByRole("button", { name: "Отправить" });
    expect(send).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "  Fix the login  " },
    });
    fireEvent.click(send);
    await within(dialog).findByText("Cannot save task");
    expect(within(dialog).getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue(
      "  Fix the login  ",
    );
    const firstId = api.createKanbanCard.mock.calls[0][1].clientCreationId;
    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.createKanbanCard).toHaveBeenLastCalledWith("project", {
      description: "Fix the login",
      clientCreationId: firstId,
    });
  });

  it("starts the task field focused, keeps its draft until Enter sends it", async () => {
    const tree = (projects: Project[]) => (
      <MemoryRouter initialEntries={["/projects/project/kanban"]}>
        <Routes>
          <Route
            path="/projects/:projectId/kanban"
            element={<KanbanBoard projects={projects} onOpenNavigation={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>
    );
    const view = render(tree([project]));
    await screen.findByRole("button", { name: "Task one" });
    const open = () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Добавить задачу" })[0]);
      const dialog = screen.getByRole("dialog", { name: "Добавить задачу" });
      return {
        dialog,
        field: within(dialog).getByRole("textbox", { name: "Сообщение для Codex" }),
      };
    };
    const { dialog, field: first } = open();
    let field = first;
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "Keep this text" } });
    // A reconnect brings a new project list; the open field stays as it is.
    view.rerender(tree([{ ...project }]));
    expect(screen.getByRole("dialog", { name: "Добавить задачу" })).toBe(dialog);
    expect(field).toHaveValue("Keep this text");
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть" }));
    ({ field } = open());
    expect(field).toHaveValue("Keep this text");
    // The draft is saved on the device and comes back after a reload.
    await waitFor(() => expect(drafts.get("project")).toMatchObject({ input: "Keep this text" }));
    view.unmount();
    render(tree([project]));
    await screen.findByRole("button", { name: "Task one" });
    ({ field } = open());
    await waitFor(() => expect(field).toHaveValue("Keep this text"));
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.createKanbanCard).toHaveBeenCalledWith("project", {
      description: "Keep this text",
      clientCreationId: expect.any(String),
    });
    await waitFor(() => expect(drafts.get("project")).toMatchObject({ input: "", images: [] }));
  });

  it("sends the settings chosen in the task field with the task", async () => {
    show();
    await screen.findByRole("button", { name: "Task one" });
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить задачу" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Добавить задачу" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Use the other model" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Модель и уровень рассуждений" }));
    const picker = screen.getByRole("dialog", { name: "Настройки модели" });
    fireEvent.click(within(picker).getByRole("radio", { name: /GPT B/ }));
    fireEvent.click(within(picker).getByRole("button", { name: "Закрыть" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(api.createKanbanCard).toHaveBeenCalledWith("project", {
        description: "Use the other model",
        clientCreationId: expect.any(String),
        settings: { collaborationMode: "default", model: "gpt-b" },
      }),
    );
  });

  it("previews an image, retains it on failed creation and retries with the same identity", async () => {
    api.createKanbanCard.mockRejectedValueOnce(new Error("Cannot save task"));
    show();
    await screen.findByRole("button", { name: "Task one" });
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить задачу" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Добавить задачу" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Fix screenshot" },
    });
    const file = new File(["image bytes"], "screenshot.png", { type: "image/png" });
    fireEvent.change(dialog.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [file] },
    });
    await within(dialog).findByRole("img", { name: file.name });
    const send = within(dialog).getByRole("button", { name: "Отправить" });
    fireEvent.click(send);
    await within(dialog).findByText("Cannot save task");
    const request = api.createKanbanCard.mock.calls[0][1];
    expect(request.images).toEqual([
      {
        name: file.name,
        url: "data:image/png;base64,aW1hZ2UgYnl0ZXM=",
      },
    ]);
    expect(within(dialog).getByRole("img", { name: file.name })).toBeInTheDocument();
    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.createKanbanCard).toHaveBeenLastCalledWith("project", request);
  });
  it("pastes and removes images, and rejects unsupported or oversized files", async () => {
    show();
    await screen.findByRole("button", { name: "Task one" });
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить задачу" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Добавить задачу" });
    const field = within(dialog).getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(field, { target: { value: "Task" } });
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    for (const file of [
      new File(["svg"], "bad.svg", { type: "image/svg+xml" }),
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
    ]) {
      fireEvent.change(input, { target: { files: [file] } });
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("до 10 МБ");
    }
    const file = new File(["image"], "paste.png", { type: "image/png" });
    fireEvent.paste(field, {
      clipboardData: { items: [{ kind: "file", type: file.type, getAsFile: () => file }] },
    });
    await within(dialog).findByRole("img", { name: file.name });
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить изображение paste.png" }));
    expect(within(dialog).queryByRole("img")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(api.createKanbanCard).toHaveBeenCalled());
    expect(api.createKanbanCard.mock.calls[0][1]).not.toHaveProperty("images");
  });
  it("loads saved images only when opening a card, without refetching on board updates", async () => {
    const seed = board();
    seed.cards[0].image = { name: "screenshot.png", mediaType: "image/png", size: 5 };
    api.readKanban.mockResolvedValue(seed);
    api.readKanbanImage
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({ name: "screenshot.png", url: "data:image/png;base64,aW1hZ2U=" });
    show();
    const open = await screen.findByRole("button", { name: "Task one" });
    expect(api.readKanbanImage).not.toHaveBeenCalled();
    fireEvent.click(open);
    fireEvent.click(
      await screen.findByRole("button", { name: "Не удалось загрузить изображение. Повторить" }),
    );
    await screen.findByText("screenshot.png");
    expect(api.readKanbanImage).toHaveBeenLastCalledWith("project", "one", 0);
    fireEvent.focus(window);
    await waitFor(() => expect(api.readKanban).toHaveBeenCalledTimes(2));
    expect(api.readKanbanImage).toHaveBeenCalledTimes(2);
  });
  it("moves a card with the keyboard without starting or stopping a session", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
    fireEvent.change(screen.getByLabelText("Стадия"), { target: { value: "working" } });
    await waitFor(() =>
      expect(api.updateKanbanCard).toHaveBeenCalledWith("project", "one", { stageId: "working" }),
    );
    expect(api.kanbanAction).not.toHaveBeenCalled();
  });

  it("publishes every ready card from the column header", async () => {
    const seed = board([card("one", "ready"), card("two", "ready"), card("three")]);
    seed.runs.push(execution("one"), execution("two"));
    api.readKanban.mockResolvedValue(seed);
    show();
    expect(await screen.findByRole("button", { name: "Task two" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Опубликовать все" }));
    await waitFor(() =>
      expect(api.kanbanAction).toHaveBeenCalledWith("project", {
        action: "publish",
        cardIds: ["one", "two"],
        clientActionId: expect.any(String),
      }),
    );
  });

  it("links to the task's session, publishes it and sends rework comments to it", async () => {
    const seed = board([card("one", "ready")]);
    seed.runs.push(
      {
        id: "run",
        kind: "execute",
        cardIds: ["one"],
        provider: "claude",
        threadId: "original",
        sessionUrl: "http://localhost:4311/threads/original",
        status: "completed",
        error: null,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "rework",
        kind: "execute",
        cardIds: ["one"],
        provider: "claude",
        threadId: "original",
        sessionUrl: "http://localhost:4311/threads/original",
        status: "completed",
        error: null,
        createdAt: 2,
        updatedAt: 3,
      },
    );
    api.readKanban.mockResolvedValue(seed);
    api.kanbanAction.mockResolvedValue(seed);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
    const panel = screen.getByRole("complementary", { name: "Task one" });
    // A continuation is a turn of the same session, listed once.
    expect(within(panel).getAllByRole("link", { name: /Выполнение/ })).toHaveLength(1);
    expect(within(panel).getByRole("link", { name: /Выполнение/ })).toHaveAttribute(
      "href",
      "http://localhost:4311/threads/original",
    );
    expect(within(panel).queryByRole("button", { name: "Запустить агента" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Опубликовать" }));
    await waitFor(() =>
      expect(api.kanbanAction).toHaveBeenCalledWith("project", {
        action: "publish",
        cardIds: ["one"],
        clientActionId: expect.any(String),
      }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "На доработку" }));
    fireEvent.change(within(panel).getByLabelText("Комментарий для доработки"), {
      target: { value: "Fix the missing error state" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Отправить на доработку" }));
    await waitFor(() =>
      expect(api.kanbanAction).toHaveBeenCalledWith("project", {
        action: "rework",
        cardIds: ["one"],
        comment: "Fix the missing error state",
        clientActionId: expect.any(String),
      }),
    );
  });

  it("shows what a waiting agent asks, opens its session to answer and starts again", async () => {
    const seed = board([
      { ...card("one", "waiting"), question: "Which file should change?" },
      card("two"),
    ]);
    seed.runs.push({ ...execution("one", "waiting"), sessionUrl: "/threads/thread-one" });
    api.readKanban.mockResolvedValue(seed);
    api.kanbanAction.mockResolvedValue(seed);
    show();
    const waiting = (await screen.findByRole("button", { name: "Task one" })).closest("article")!;
    expect(waiting).toHaveTextContent("Which file should change?");
    fireEvent.click(screen.getByRole("button", { name: "Task one" }));
    const panel = screen.getByRole("complementary", { name: "Task one" });
    expect(within(panel).getByRole("link", { name: "Ответить" })).toHaveAttribute(
      "href",
      "/threads/thread-one",
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Начать заново" }));
    await waitFor(() =>
      expect(api.kanbanAction).toHaveBeenCalledWith("project", {
        action: "restart",
        cardIds: ["one"],
        clientActionId: expect.any(String),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Task two" }));
    expect(
      within(screen.getByRole("complementary", { name: "Task two" })).getByRole("button", {
        name: "Запустить агента",
      }),
    ).toBeInTheDocument();
  });

  it("translates the board's own reasons for waiting", async () => {
    const seed = board([
      { ...card("one", "waiting"), error: "The session was stopped; continue it or start again" },
    ]);
    api.readKanban.mockResolvedValue(seed);
    show();
    expect(
      (await screen.findByRole("button", { name: "Task one" })).closest("article"),
    ).toHaveTextContent("Сессия остановлена. Продолжите её или начните заново.");
  });

  it("sends a recorded task at once with the typed text and leaves transcription to the server", async () => {
    installRecorder();
    show(voice);
    await screen.findByRole("button", { name: "Task one" });
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить задачу" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Добавить задачу" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Сообщение для Codex" }), {
      target: { value: "Fix login" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Начать запись" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Остановить запись" }));
    await waitFor(() =>
      expect(api.createKanbanCard).toHaveBeenCalledWith("project", {
        description: "Fix login",
        clientCreationId: expect.any(String),
        audio: {
          mediaType: expect.stringMatching(/^audio\//),
          data: "YXVkaW8=",
          durationMs: expect.any(Number),
        },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.transcribe).not.toHaveBeenCalled();
  });

  it("dictates a task from the header without opening a dialog", async () => {
    installRecorder();
    show(voice);
    fireEvent.click(await screen.findByRole("button", { name: "Надиктовать задачу" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Остановить запись и создать задачу" }),
    );
    await waitFor(() =>
      expect(api.createKanbanCard).toHaveBeenCalledWith("project", {
        description: "",
        clientCreationId: expect.stringMatching(/^voice:/),
        audio: expect.objectContaining({ data: "YXVkaW8=" }),
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a transcribing card and retries a failed recording", async () => {
    const seed = board([
      { ...card("one"), title: "", description: "" },
      { ...card("two"), title: "", description: "" },
    ]);
    seed.cards[0]!.voice = {
      purpose: "create",
      status: "transcribing",
      error: null,
      provider: "codex",
    };
    seed.cards[1]!.voice = {
      purpose: "create",
      status: "failed",
      error: "Recognizer offline",
      provider: "codex",
    };
    api.readKanban.mockResolvedValue(seed);
    show();
    const [pending, failed] = (
      await screen.findAllByRole("button", { name: "Голосовая задача" })
    ).map((button) => button.closest("article")!);
    expect(pending).toHaveTextContent("Распознаём запись…");
    expect(failed).toHaveTextContent("Не удалось распознать запись");
    fireEvent.click(within(failed!).getByRole("button", { name: "Голосовая задача" }));
    const panel = screen.getByRole("complementary");
    expect(panel).toHaveTextContent("Recognizer offline");
    fireEvent.click(within(panel).getByRole("button", { name: "Повторить распознавание" }));
    await waitFor(() =>
      expect(api.kanbanAction).toHaveBeenCalledWith("project", {
        action: "retry-transcription",
        cardIds: ["two"],
        clientActionId: expect.any(String),
      }),
    );
  });

  it("opens the card of a linked session and closes its panel with Escape", async () => {
    const seed = board([card("one", "working"), card("two")]);
    seed.runs.push({
      id: "run",
      kind: "execute",
      cardIds: ["one"],
      provider: "codex",
      threadId: "session-one",
      sessionUrl: "/threads/session-one",
      status: "running",
      error: null,
      createdAt: 1,
      updatedAt: 2,
    });
    api.readKanban.mockResolvedValue(seed);
    show(null, "/projects/project/kanban?thread=session-one");
    const panel = await screen.findByRole("complementary", { name: "Task one" });
    expect(within(panel).getByRole("link", { name: "Открыть сессию" })).toHaveAttribute(
      "href",
      "/threads/session-one",
    );
    expect(within(panel).queryByRole("button", { name: "Запустить агента" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("shows the agent state on a card only while it needs attention", async () => {
    const seed = board([card("one", "working"), card("two", "ready")]);
    seed.runs.push(
      {
        id: "waiting",
        kind: "execute",
        cardIds: ["one"],
        provider: "codex",
        threadId: "a",
        sessionUrl: null,
        status: "waiting",
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "done",
        kind: "execute",
        cardIds: ["two"],
        provider: "codex",
        threadId: "b",
        sessionUrl: null,
        status: "completed",
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
    );
    api.readKanban.mockResolvedValue(seed);
    show();
    const waiting = (await screen.findByRole("button", { name: "Task one" })).closest("article")!;
    expect(waiting).toHaveTextContent("Ждёт ответа");
    expect(waiting.querySelector(".kanban-card-status.status-needsAttention")).not.toBeNull();
    const finished = screen.getByRole("button", { name: "Task two" }).closest("article")!;
    expect(finished).not.toHaveTextContent("Завершено");
    expect(finished.querySelector(".kanban-card-status")).toBeNull();
  });

  it("colours a card like its session in this application", async () => {
    const session = (id: string, state: ThreadSummary["state"], unread: boolean) =>
      ({
        id,
        state,
        unread,
        unseen: unread,
        archived: false,
        queuedMessageCount: 0,
      }) as ThreadSummary;
    const run = (
      id: string,
      status: KanbanRun["status"],
      provider: KanbanRun["provider"] = "codex",
    ) => ({
      ...execution(id, status),
      threadId: id,
      provider,
    });
    const seed = board(
      ["unread", "read", "stopped", "seen", "elsewhere"].map((id) => card(id, "ready")),
    );
    seed.runs.push(
      run("unread", "completed"),
      run("read", "completed"),
      run("stopped", "waiting"),
      run("seen", "failed"),
      run("elsewhere", "failed", "claude"),
    );
    api.readKanban.mockResolvedValue(seed);
    show(null, undefined, [
      session("unread", "completed", true),
      session("read", "completed", false),
      session("stopped", "interrupted", true),
      session("seen", "completed", false),
      session("elsewhere", "completed", false),
    ]);
    const marker = async (id: string) =>
      (await screen.findByRole("button", { name: `Task ${id}` }))
        .closest("article")!
        .querySelector(".kanban-card-status")?.className;
    expect(await marker("unread")).toContain("status-completed-unread");
    expect(await marker("read")).toBeUndefined();
    expect(await marker("stopped")).toContain("status-interrupted");
    expect(
      screen.getByRole("button", { name: "Task stopped" }).closest("article"),
    ).toHaveTextContent("Прервана");
    expect(await marker("seen")).toContain("status-failed-read");
    // The other application's session is unknown here: the board's own outcome decides.
    expect(await marker("elsewhere")).toBe("kanban-card-status status-failed");
    expect(
      screen.getByRole("button", { name: "Task unread" }).closest("article"),
    ).not.toHaveTextContent("Завершено");
  });

  it("keeps collapsed and resized columns on this device", async () => {
    const view = show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Развернуть стадию «Опубликовано», задач: 0" }),
    );
    const menu = screen.getByLabelText("Действия со стадией «К выполнению»").closest("details")!;
    fireEvent.click(within(menu).getByRole("button", { name: "Свернуть" }));
    expect(
      screen.getByRole("button", { name: "Развернуть стадию «К выполнению», задач: 1" }),
    ).toBeInTheDocument();
    const width = screen.getByRole("separator", { name: "Ширина стадии «В работе»" });
    fireEvent.keyDown(width, { key: "ArrowRight" });
    fireEvent.keyDown(width, { key: "ArrowRight" });
    expect(width).toHaveAttribute("aria-valuenow", "216");
    view.unmount();
    show();
    expect(
      await screen.findByRole("button", { name: "Развернуть стадию «К выполнению», задач: 1" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Развернуть стадию «Опубликовано»/ })).toBeNull();
    expect(screen.getByRole("separator", { name: "Ширина стадии «В работе»" })).toHaveAttribute(
      "aria-valuenow",
      "216",
    );
    fireEvent.keyDown(screen.getByRole("separator", { name: "Ширина стадии «В работе»" }), {
      key: "Home",
    });
    expect(screen.getByRole("separator", { name: "Ширина стадии «В работе»" })).not.toHaveAttribute(
      "aria-valuenow",
    );
  });

  it("runs the step's action on drop and fades stages that refuse the card", async () => {
    show();
    const card = (await screen.findByRole("button", { name: "Task one" })).closest("article")!;
    const dataTransfer = transfer();
    fireEvent.dragStart(card, { dataTransfer });
    expect(screen.getByRole("region", { name: "Ждёт ответа" })).toHaveClass("drop-disabled");
    expect(screen.getByRole("region", { name: "В работе" })).not.toHaveClass("drop-disabled");
    const working = screen.getByRole("region", { name: "В работе" });
    fireEvent.dragOver(working, { dataTransfer });
    expect(working.querySelector(".kanban-drop-slot")).not.toBeNull();
    fireEvent.drop(working, { dataTransfer });
    await waitFor(() =>
      expect(api.kanbanAction).toHaveBeenCalledWith("project", {
        action: "execute",
        cardIds: ["one"],
        clientActionId: expect.any(String),
      }),
    );
    expect(api.updateKanbanCard).not.toHaveBeenCalled();
  });

  it("publishes a ready card dropped into Published and keeps a running card in its stage", async () => {
    const seed = board([card("one", "ready"), card("two", "working")]);
    seed.runs.push(execution("one"), execution("two", "running"));
    api.readKanban.mockResolvedValue(seed);
    show();
    const running = (await screen.findByRole("button", { name: "Task two" })).closest("article")!;
    fireEvent.dragStart(running, { dataTransfer: transfer() });
    expect(screen.getByRole("region", { name: "К выполнению" })).toHaveClass("drop-disabled");
    fireEvent.dragEnd(running);
    const ready = screen.getByRole("button", { name: "Task one" }).closest("article")!;
    const dataTransfer = transfer();
    fireEvent.dragStart(ready, { dataTransfer });
    expect(screen.getByRole("region", { name: "Ждёт ответа" })).toHaveClass("drop-disabled");
    const published = screen.getByRole("region", { name: "Опубликовано" });
    fireEvent.dragOver(published, { dataTransfer });
    fireEvent.drop(published, { dataTransfer });
    await waitFor(() =>
      expect(api.kanbanAction).toHaveBeenCalledWith("project", {
        action: "publish",
        cardIds: ["one"],
        clientActionId: expect.any(String),
      }),
    );
  });

  it("reorders cards with Alt and the arrow keys", async () => {
    const seed = board([card("one"), card("two"), card("three")]);
    api.readKanban.mockResolvedValue(seed);
    api.updateKanbanCard.mockResolvedValue(seed);
    show();
    fireEvent.keyDown(await screen.findByRole("button", { name: "Task three" }), {
      key: "ArrowUp",
      altKey: true,
    });
    await waitFor(() =>
      expect(api.updateKanbanCard).toHaveBeenCalledWith("project", "three", {
        beforeCardId: "two",
      }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Task one" }), {
      key: "ArrowDown",
      altKey: true,
    });
    await waitFor(() =>
      expect(api.updateKanbanCard).toHaveBeenLastCalledWith("project", "one", {
        beforeCardId: "three",
      }),
    );
  });

  it("archives, restores and permanently deletes a task", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
    const panel = screen.getByRole("complementary", { name: "Task one" });
    fireEvent.click(within(panel).getByRole("button", { name: "В архив" }));
    await waitFor(() =>
      expect(api.updateKanbanCard).toHaveBeenCalledWith("project", "one", { archived: true }),
    );
    const archived = board([{ ...card("one"), archivedAt: Date.UTC(2026, 10, 3) }]);
    api.readKanban.mockResolvedValue(archived);
    api.updateKanbanCard.mockResolvedValue(archived);
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Task one" })).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Архив" })[0]!);
    const archive = screen.getByRole("complementary", { name: "Архив" });
    expect(archive).toHaveTextContent("Task one");
    fireEvent.click(within(archive).getByRole("button", { name: "Вернуть" }));
    await waitFor(() =>
      expect(api.updateKanbanCard).toHaveBeenLastCalledWith("project", "one", {
        archived: false,
      }),
    );
    fireEvent.click(within(archive).getByRole("button", { name: "Удалить навсегда" }));
    const dialog = screen.getByRole("dialog", { name: "Удалить задачу навсегда?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить навсегда" }));
    await waitFor(() => expect(api.deleteKanbanCard).toHaveBeenCalledWith("project", "one"));
  });

  it("edits a task title in place and cancels with Escape", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
    const panel = screen.getByRole("complementary", { name: "Task one" });
    fireEvent.click(within(panel).getByRole("button", { name: "Task one" }));
    const field = within(panel).getByLabelText("Название");
    fireEvent.change(field, { target: { value: "Renamed task" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(api.updateKanbanCard).toHaveBeenCalledWith("project", "one", {
        title: "Renamed task",
      }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Description one" }));
    fireEvent.keyDown(within(panel).getByLabelText("Описание"), { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Task one" })).toBeInTheDocument();
    expect(api.updateKanbanCard).toHaveBeenCalledTimes(1);
  });

  it("adds to a short task's text before it starts instead of replacing it", async () => {
    const short = { ...card("one"), title: "Fix login", description: "Fix login" };
    api.readKanban.mockResolvedValue(board([short]));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Fix login" }));
    const panel = screen.getByRole("complementary", { name: "Fix login" });
    fireEvent.click(within(panel).getByRole("button", { name: "Дописать задачу" }));
    const field = within(panel).getByLabelText("Описание");
    expect(field).toHaveValue("Fix login");
    fireEvent.change(field, { target: { value: "Fix login\nKeep the session after a reload" } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(api.updateKanbanCard).toHaveBeenCalledWith("project", "one", {
        description: "Fix login\nKeep the session after a reload",
      }),
    );
  });

  it("edits, moves and deletes a custom stage", async () => {
    const seed = board([card("one", "custom")]);
    seed.stages.push({ id: "custom", name: "Deploy", description: "", role: null });
    api.readKanban.mockResolvedValue(seed);
    api.updateKanbanStage.mockResolvedValue(seed);
    show();
    await screen.findByRole("region", { name: "Deploy" });
    const menu = screen.getByLabelText("Действия со стадией «Deploy»").closest("details")!;
    expect(within(menu).queryByRole("button", { name: "Сдвинуть вправо" })).toBeNull();
    fireEvent.click(within(menu).getByRole("button", { name: "Сдвинуть влево" }));
    await waitFor(() =>
      expect(api.updateKanbanStage).toHaveBeenCalledWith("project", "custom", {
        beforeStageId: "done",
      }),
    );
    fireEvent.click(within(menu).getByRole("button", { name: "Изменить" }));
    const dialog = screen.getByRole("dialog", { name: "Изменить стадию" });
    expect(within(dialog).getByLabelText("Название")).toHaveValue("Deploy");
    fireEvent.change(within(dialog).getByLabelText("Описание (необязательно)"), {
      target: { value: "Ship manually" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.updateKanbanStage).toHaveBeenLastCalledWith("project", "custom", {
        description: "Ship manually",
      }),
    );
    fireEvent.click(within(menu).getByRole("button", { name: "Удалить" }));
    const confirm = screen.getByRole("dialog", { name: "Удалить стадию «Deploy»?" });
    expect(confirm).toHaveTextContent("Задачи из неё (1) переедут в «К выполнению».");
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить стадию" }));
    await waitFor(() => expect(api.deleteKanbanStage).toHaveBeenCalledWith("project", "custom"));
  });

  it("does not refresh a hidden or unmounted board", async () => {
    vi.useFakeTimers();
    const view = show();
    await act(async () => {});
    expect(api.readKanban).toHaveBeenCalledOnce();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTime(12_000));
    expect(api.readKanban).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(api.readKanban).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => vi.advanceTimersByTime(12_000));
    expect(api.readKanban).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });
});

function installRecorder() {
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      const event = new Event("dataavailable");
      Object.defineProperty(event, "data", { value: new Blob(["audio"], { type: "audio/webm" }) });
      this.dispatchEvent(event);
      this.dispatchEvent(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
  });
}
