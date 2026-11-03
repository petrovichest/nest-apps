import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KanbanBoard as Board,
  KanbanCard,
  Project,
  TranscriptionConfigResponse,
} from "@codexnest/protocol";
import { KanbanBoard } from "./KanbanBoard";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));
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
    scope: "task",
    repositories: [],
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
      { id: "review", name: "Проверка", description: "", role: "review" },
      { id: "ready", name: "К объединению", description: "", role: "ready" },
      { id: "done", name: "Готово", description: "", role: "done" },
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
  readKanban: ReturnType<typeof vi.fn>;
  createKanbanCard: ReturnType<typeof vi.fn>;
  updateKanbanCard: ReturnType<typeof vi.fn>;
  createKanbanStage: ReturnType<typeof vi.fn>;
  kanbanAction: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
};
function show(config: TranscriptionConfigResponse | null = null) {
  return render(
    <MemoryRouter initialEntries={["/projects/project/kanban"]}>
      <Routes>
        <Route
          path="/projects/:projectId/kanban"
          element={
            <KanbanBoard
              projects={[project]}
              transcriptionConfig={config}
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
    readKanban: vi.fn().mockResolvedValue(board()),
    createKanbanCard: vi.fn().mockResolvedValue(board()),
    updateKanbanCard: vi.fn().mockResolvedValue(board()),
    createKanbanStage: vi.fn().mockResolvedValue(board()),
    kanbanAction: vi.fn().mockResolvedValue(board()),
    transcribe: vi.fn(),
  };
  connection.mockReturnValue({ api });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("KanbanBoard", () => {
  it("localizes canonical server stages by role and preserves custom names", async () => {
    const seed = board();
    const names = ["To do", "In progress", "Review", "Ready for integration", "Done"];
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
    expect(screen.getByRole("region", { name: "Проверка" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "К объединению" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Готово" })).toBeInTheDocument();
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
    fireEvent.change(within(dialog).getByLabelText("Задача"), {
      target: { value: "  Fix the login  " },
    });
    fireEvent.click(send);
    await within(dialog).findByText("Cannot save task");
    expect(within(dialog).getByLabelText("Задача")).toHaveValue("  Fix the login  ");
    const firstId = api.createKanbanCard.mock.calls[0][1].clientCreationId;
    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.createKanbanCard).toHaveBeenLastCalledWith("project", {
      description: "Fix the login",
      clientCreationId: firstId,
    });
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

  it("merges only selected accepted cards", async () => {
    api.readKanban.mockResolvedValue(
      board([card("one", "ready"), card("two", "ready"), card("three")]),
    );
    show();
    fireEvent.click(await screen.findByLabelText("Выбрать задачу Task two"));
    fireEvent.click(screen.getByRole("button", { name: "Объединить выбранные (1)" }));
    await waitFor(() =>
      expect(api.kanbanAction).toHaveBeenCalledWith("project", {
        action: "integrate",
        cardIds: ["two"],
        clientActionId: expect.any(String),
      }),
    );
  });

  it("links to the original provider and sends rework comments without a new executor selection", async () => {
    const seed = board([card("one", "review")]);
    seed.runs.push({
      id: "run",
      kind: "execute",
      cardIds: ["one"],
      provider: "claude",
      threadId: "original",
      sessionUrl: "http://localhost:4311/threads/original",
      status: "completed",
      workspacePath: "/tmp/task",
      error: null,
      createdAt: 1,
      updatedAt: 2,
    });
    api.readKanban.mockResolvedValue(seed);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
    expect(screen.getByRole("link", { name: "Открыть сессию" })).toHaveAttribute(
      "href",
      "http://localhost:4311/threads/original",
    );
    fireEvent.click(screen.getByRole("button", { name: "На доработку" }));
    const dialog = screen.getByRole("dialog", { name: "На доработку" });
    fireEvent.change(within(dialog).getByLabelText("Комментарий"), {
      target: { value: "Fix the missing error state" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Отправить на доработку" }));
    await waitFor(() =>
      expect(api.kanbanAction).toHaveBeenCalledWith("project", {
        action: "rework",
        cardIds: ["one"],
        comment: "Fix the missing error state",
        clientActionId: expect.any(String),
      }),
    );
  });

  it("inserts dictated text at the captured cursor while retaining edits made during transcription", async () => {
    installRecorder();
    let finish!: (result: { text: string }) => void;
    api.transcribe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    show(voice);
    await screen.findByRole("button", { name: "Task one" });
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить задачу" })[0]);
    const input = screen.getByLabelText("Задача") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "one two" } });
    input.setSelectionRange(4, 4);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Начать запись" }));
    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    const stop = await screen.findByRole("button", { name: "Остановить запись" });
    fireEvent.click(stop);
    await waitFor(() => expect(api.transcribe).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "one two!" } });
    await act(async () => finish({ text: "spoken" }));
    expect(input).toHaveValue("one spoken two!");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
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
