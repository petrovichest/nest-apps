import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttentionRequest,
  ModelOption,
  QueuedMessage,
  ThreadDetail,
  ThreadSummary,
  TranscriptionConfigResponse,
} from "@codexnest/protocol";
import { SetupScreen } from "./SetupScreen";
import { SettingsPicker } from "./SettingsPicker";
import { AttentionPanel } from "./AttentionPanel";
import { ThreadSearchDialog } from "./ThreadSearchDialog";
import { SettingsPage } from "./SettingsPage";
import { Composer } from "./Composer";
import { ThreadPage } from "./ThreadPage";
import { ApiClientError } from "../api";

vi.hoisted(() => vi.stubEnv("VITE_APP_PROVIDER", "claude"));
const connection = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../offline-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadLocalDraft: async () => null,
  deleteLocalDraft: async () => undefined,
  saveLocalDraft: async (
    _settings: unknown,
    threadId: string,
    value: unknown,
    updatedAt = Date.now(),
  ) => ({
    key: threadId,
    threadId,
    value,
    updatedAt,
  }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

const models: ModelOption[] = [
  {
    id: "sonnet",
    displayName: "Sonnet",
    description: "",
    isDefault: true,
    reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
    serviceTiers: [],
    supportsPersonality: false,
  },
  {
    id: "haiku",
    displayName: "Haiku",
    description: "",
    isDefault: false,
    reasoningEfforts: [],
    serviceTiers: [],
    supportsPersonality: false,
  },
];

describe("the shared Claude interface", () => {
  it("starts setup at the current origin, verifies Claude identity and saves only its token", async () => {
    localStorage.setItem("codexnest.token", "keep-codex");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"status":"ok","provider":"claude"}'))
      .mockResolvedValueOnce(new Response('{"threadCount":0}'));
    vi.stubGlobal("fetch", fetchMock);
    const connected = vi.fn();
    render(<SetupScreen onConnected={connected} />);
    expect(screen.getByText("ClaudeNest", { selector: ".setup-identity" })).toBeInTheDocument();
    expect(screen.getByLabelText("Адрес сервера")).toHaveValue(window.location.origin);
    fireEvent.change(screen.getByLabelText("Bearer token"), { target: { value: "test-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    await waitFor(() => expect(connected).toHaveBeenCalledOnce());
    expect((fetchMock.mock.calls[0]![1].headers as Headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
    expect(localStorage.getItem("claudenest.token")).toBe("test-token");
    expect(localStorage.getItem("codexnest.token")).toBe("keep-codex");
  });

  it("rejects another provider before saving credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"ok","provider":"codex"}'));
    vi.stubGlobal("fetch", fetchMock);
    const connected = vi.fn();
    render(<SetupScreen onConnected={connected} />);
    fireEvent.change(screen.getByLabelText("Bearer token"), { target: { value: "test-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Это приложение подключается к ClaudeNest",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(localStorage.getItem("claudenest.token")).toBeNull();
    expect(connected).not.toHaveBeenCalled();
  });

  it("keeps live model switching while preventing effort changes and unsupported modes", () => {
    const onChange = vi.fn();
    render(
      <SettingsPicker
        models={models}
        value={{ collaborationMode: "default", model: "sonnet", reasoningEffort: "high" }}
        disabled={false}
        effortDisabled
        goalMode={false}
        onChange={onChange}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Включить режим планирования" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Включить командный режим" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Включить режим цели" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
    expect(screen.getByRole("radio", { name: "high" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Haiku" }));
    expect(onChange).toHaveBeenCalledWith({ model: "haiku" });
  });

  it("allows a supported effort when preparing a new session", () => {
    const onChange = vi.fn();
    render(
      <SettingsPicker
        models={models}
        value={{ collaborationMode: "default", model: "sonnet" }}
        disabled={false}
        goalMode={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    expect(onChange).toHaveBeenCalledWith({ reasoningEffort: "high" });
  });

  it("sends all selected question answers through the approval response API", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const sendReliable = vi.fn();
    const clearUserInputDraft = vi.fn();
    connection.mockReturnValue({ api: { respond }, sendReliable, clearUserInputDraft });
    const request: AttentionRequest = {
      id: "questions",
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      createdAt: 1,
      kind: "userInput",
      autoResolutionMs: null,
      questions: [
        {
          id: "features",
          header: "Возможности",
          question: "Что включить?",
          isOther: true,
          isSecret: false,
          multiSelect: true,
          options: [
            { label: "Голос", description: "Микрофон" },
            { label: "Файлы", description: "Вложения" },
          ],
        },
      ],
    };
    render(<AttentionPanel requests={[request]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Голос/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Файлы/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ещё одно" } });
    expect(screen.getByRole("checkbox", { name: /Голос/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Файлы/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("questions", {
        kind: "userInput",
        answers: { features: ["Голос", "Файлы", "Ещё одно"] },
      }),
    );
    expect(sendReliable).not.toHaveBeenCalled();
    expect(clearUserInputDraft).toHaveBeenCalledWith("questions");
  });

  it("keeps local voice and Claude refinement in the same settings page without Codex management calls", async () => {
    const api = {
      settings: { baseUrl: "https://claude.home.arpa" },
      readPermissionSettings: vi.fn(),
      readCodexSettings: vi.fn(),
      readSkills: vi.fn(),
      updateTranscriptionSettings: vi.fn().mockResolvedValue(transcriptionConfig),
    };
    connection.mockReturnValue({
      api,
      state: {
        network: "connected",
        snapshot: {
          models,
          taskDefaults: {},
          permissionSettings: {
            preset: "full-access",
            version: "1",
            overridden: false,
            message: null,
          },
        },
      },
    });
    render(
      <MemoryRouter>
        <SettingsPage
          onOpenNavigation={vi.fn()}
          onSwitchServer={vi.fn()}
          theme="system"
          onThemeChange={vi.fn()}
          sidebarSide="left"
          onSidebarSideChange={vi.fn()}
          projectListDirection="top-down"
          onProjectListDirectionChange={vi.fn()}
          transcriptionConfig={transcriptionConfig}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("tab", { name: "Claude" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Скиллы" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Обслуживание" })).not.toBeInTheDocument();
    const provider = screen.getByLabelText("Провайдер распознавания речи");
    expect(within(provider).queryByRole("option", { name: "OpenAI API" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Модель улучшения расшифровки")).toHaveValue("haiku");
    fireEvent.change(screen.getByLabelText("Модель улучшения расшифровки"), {
      target: { value: "sonnet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить распознавание" }));
    await waitFor(() =>
      expect(api.updateTranscriptionSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "local",
          refineLocal: true,
          refinementModel: "sonnet",
        }),
      ),
    );
    expect(api.readPermissionSettings).not.toHaveBeenCalled();
    expect(api.readCodexSettings).not.toHaveBeenCalled();
    expect(api.readSkills).not.toHaveBeenCalled();
  });

  it("shows the saved native permissions and saves ask mode without Codex reviewer options", async () => {
    const ask = { preset: "ask", version: "2", overridden: false, message: null };
    const api = {
      settings: { baseUrl: "https://claude.home.arpa" },
      readPermissionSettings: vi.fn(),
      updatePermissionSettings: vi.fn().mockResolvedValue(ask),
    };
    connection.mockReturnValue({
      api,
      state: {
        snapshot: {
          models,
          permissionSettings: { ...ask, preset: "full-access", version: "1" },
        },
      },
    });
    render(
      <MemoryRouter initialEntries={["/settings?section=codex"]}>
        <SettingsPage
          onOpenNavigation={vi.fn()}
          onSwitchServer={vi.fn()}
          theme="system"
          onThemeChange={vi.fn()}
          sidebarSide="left"
          onSidebarSideChange={vi.fn()}
          projectListDirection="top-down"
          onProjectListDirectionChange={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Разрешения Claude")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Полный доступ/ })).toBeChecked();
    expect(screen.queryByRole("radio", { name: /Подтверждать автоматически/ })).toBeNull();
    expect(api.readPermissionSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /Запрашивать разрешение/ }));
    const form = screen.getByText("Разрешения Claude").closest("form")!;
    fireEvent.click(within(form).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.updatePermissionSettings).toHaveBeenCalledWith({
        preset: "ask",
        expectedVersion: "1",
      }),
    );
    expect(screen.getByRole("radio", { name: /Запрашивать разрешение/ })).toBeChecked();
    await waitFor(() =>
      expect(within(form).getByRole("button", { name: "Сохранить" })).toBeDisabled(),
    );
    api.readPermissionSettings.mockResolvedValue({
      ...ask,
      preset: "full-access",
      version: "3",
    });
    api.updatePermissionSettings.mockRejectedValueOnce(
      new ApiClientError("conflict", "Changed", 409),
    );
    fireEvent.click(screen.getByRole("radio", { name: /Полный доступ/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Сохранить" }));
    await screen.findByText(
      "Конфигурация Claude изменилась. Проверьте значение и сохраните ещё раз.",
    );
    expect(api.readPermissionSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole("radio", { name: /Полный доступ/ })).toBeChecked();
  });

  it("steers active Claude input by default and leaves explicit queue controls available", () => {
    connection.mockReturnValue({ api: {} });
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    const view = render(
      <Composer
        input="Уточнение"
        images={[]}
        onInput={vi.fn()}
        onImagesChange={vi.fn()}
        onSubmit={onSubmit}
        onStop={onStop}
        busy={false}
        running
        permissionPreset="full-access"
        settings={{ collaborationMode: "default", model: "sonnet" }}
        onSettingsChange={vi.fn()}
        models={models}
        error={null}
      />,
    );
    const textarea = screen.getByRole("textbox");
    expect(screen.getByText("Полный доступ")).toBeInTheDocument();
    expect(screen.getByText(/Сообщение отправится Claude сразу/)).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.submit(view.container.querySelector("form")!);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Добавить в очередь" }));
    expect(onSubmit.mock.calls).toEqual([
      ["immediate"],
      ["immediate"],
      ["queue"],
      ["queue"],
      ["queue"],
    ]);
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Дополнить текущий ход" })).toBeEnabled();
  });

  it.each([
    ["active", false, "steer"],
    ["active", true, "queue"],
    [null, false, "steer"],
    [null, true, "queue"],
  ] as const)(
    "delivers active input with current turn=%s and explicit queue=%s without interrupting",
    async (currentTurnId, queue, mode) => {
      const context = renderActiveClaudeThread([], false, currentTurnId);
      const textarea = await screen.findByRole("textbox", { name: "Направить текущую задачу" });
      fireEvent.change(textarea, { target: { value: "Уточнение" } });
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: queue });
      await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
      expect(context.sendReliable.mock.calls[0]?.[1]).toMatchObject({
        input: "Уточнение",
        deliveryMode: mode,
        draftUpdatedAt: 100,
      });
      expect(context.api.interrupt).not.toHaveBeenCalled();
      expect(context.api.sendQueuedNow).not.toHaveBeenCalled();
      expect(context.dispatch).toHaveBeenCalledWith({
        type: "optimistic.add",
        message: expect.objectContaining({
          destination: mode === "steer" ? "turn" : "queue",
          turnId: mode === "steer" ? currentTurnId : null,
        }),
      });
      expect(screen.getByText("Полный доступ")).toBeInTheDocument();
    },
  );

  it.each([false, true])(
    "renders pending steer errors outside FIFO with local optimistic input=%s",
    (localSteer) => {
      const message = {
        threadId: "thread",
        images: [],
        createdAt: 1,
        status: "dispatching" as const,
      };
      const { view } = renderActiveClaudeThread(
        [
          {
            ...message,
            id: "steered",
            text: "Дополнение в активном ходе",
            deliveryMode: "steer",
            deliveryError: { message: "Claude delivery is not confirmed", retryable: false },
          },
          { ...message, id: "queued", text: "Следующая отдельная задача", status: "queued" },
        ],
        localSteer,
      );
      expect(screen.getByText("Дополнение в активном ходе")).toBeInTheDocument();
      expect(screen.getByText("Claude delivery is not confirmed")).toBeInTheDocument();
      expect(view.container.querySelectorAll(".queued-message")).toHaveLength(1);
      expect(view.container.querySelector(".queued-message")).toHaveTextContent(
        "Следующая отдельная задача",
      );
    },
  );

  it.each(["active", null])(
    "sends an active task recording with native steering when current turn=%s",
    async (currentTurnId) => {
      installMediaRecorder();
      const context = renderActiveClaudeThread([], false, currentTurnId);
      fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
      await screen.findByRole("button", { name: "Остановить запись" });
      fireEvent.click(screen.getByRole("button", { name: "Остановить запись" }));
      await waitFor(() => expect(context.queueVoiceRecording).toHaveBeenCalledOnce());
      expect(context.queueVoiceRecording.mock.calls[0]?.[0]).toMatchObject({
        threadId: "thread",
        mode: "steer",
        draftUpdatedAt: null,
      });
      expect(context.api.interrupt).not.toHaveBeenCalled();
    },
  );

  it("transcribes a question recording into its answer before sending the native reply", async () => {
    installMediaRecorder();
    const transcribe = vi.fn().mockResolvedValue({
      text: "Голосовой ответ",
      timingEstimate: transcriptionConfig.timingEstimate,
    });
    const respond = vi.fn().mockResolvedValue(undefined);
    const queueVoiceRecording = vi.fn();
    connection.mockReturnValue({
      api: { transcribe, respond },
      queueVoiceRecording,
      sendReliable: vi.fn(),
    });
    const request: AttentionRequest = {
      id: "question",
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      draftKey: "a".repeat(64),
      createdAt: 1,
      kind: "userInput",
      autoResolutionMs: null,
      questions: [
        {
          id: "answer",
          header: "Детали",
          question: "Что учесть?",
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    };
    render(
      <AttentionPanel
        requests={[request]}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    await screen.findByRole("button", { name: "Остановить запись" });
    fireEvent.click(screen.getByRole("button", { name: "Остановить запись" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Голосовой ответ"));
    expect(transcribe).toHaveBeenCalledOnce();
    expect(queueVoiceRecording).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("question", {
        kind: "userInput",
        answers: { answer: ["Голосовой ответ"] },
      }),
    );
  });

  it("keeps file attachments and queue submission while ignoring the disabled Plan shortcut", async () => {
    connection.mockReturnValue({ api: {} });
    const attachment = {
      id: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      path: "/work/notes.txt",
      createdAt: 1,
    };
    const upload = vi.fn().mockResolvedValue([attachment]);
    const onFilesChange = vi.fn();
    const onSettingsChange = vi.fn();
    const onSubmit = vi.fn();
    const view = render(
      <Composer
        input="Сообщение"
        onInput={vi.fn()}
        images={[]}
        onImagesChange={vi.fn()}
        files={[]}
        onFilesChange={onFilesChange}
        onUploadFiles={upload}
        onSubmit={onSubmit}
        busy={false}
        error={null}
        settings={{ collaborationMode: "default", model: "sonnet" }}
        onSettingsChange={onSettingsChange}
        models={models}
        sessionIdentity="thread"
      />,
    );
    const fileInput = view.container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    fireEvent.change(fileInput!, { target: { files: [file] } });
    await waitFor(() => expect(upload).toHaveBeenCalledWith([file], 0));
    expect(onFilesChange).toHaveBeenCalledWith([attachment], 0);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab", shiftKey: true });
    expect(onSettingsChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("queue");
  });

  it("limits search to titles and opens a match without message occurrence requests", async () => {
    const thread = {
      id: "thread",
      title: "Голос и файлы",
      cwd: "/work",
      updatedAt: 1,
      archived: false,
    } as ThreadSummary;
    const api = {
      searchThreads: vi.fn(async (_query, archived) => ({
        data: archived ? [] : [{ thread, snippet: "" }],
        nextCursor: null,
      })),
      searchOccurrences: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { snapshot: { instanceId: "instance" } } });
    render(
      <MemoryRouter>
        <ThreadSearchDialog open onClose={vi.fn()} onNavigate={vi.fn()} />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Текст для поиска" }), {
      target: { value: "Голос" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    const results = within(screen.getByRole("region", { name: "Не в архиве" }));
    fireEvent.click(await results.findByRole("button", { name: /Голос и файлы/ }));
    expect(screen.getByLabelText("route")).toHaveTextContent("/threads/thread");
    expect(api.searchThreads.mock.calls).toEqual([
      ["Голос", false, undefined, "titles"],
      ["Голос", true, undefined, "titles"],
    ]);
    expect(api.searchOccurrences).not.toHaveBeenCalled();
  });
});

function renderActiveClaudeThread(
  queuedMessages: QueuedMessage[] = [],
  localSteer = false,
  currentTurnId: string | null = "active",
) {
  const thread: ThreadSummary = {
    id: "thread",
    projectId: null,
    title: "Задача Claude",
    preview: "",
    cwd: "/work",
    relation: { kind: "session", sessionId: "session" },
    state: "running",
    currentTurnId,
    unread: false,
    unseen: false,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    queuedMessageCount: queuedMessages.filter((message) => message.deliveryMode !== "steer").length,
    browserStatus: "disabled",
    settings: { collaborationMode: "default", model: "sonnet" },
    permissionPreset: "full-access",
    canAcceptDirectInput: true,
  };
  const detail: ThreadDetail = {
    summary: thread,
    queuedMessages,
    olderTurnsCursor: null,
    draft: null,
    turns: [
      {
        id: "active",
        status: currentTurnId ? "inProgress" : "completed",
        startedAt: 1,
        completedAt: currentTurnId ? null : 2,
        durationMs: null,
        progress: {
          startedAt: 1,
          explanation: null,
          steps: [],
          filesChanged: 0,
          additions: 0,
          deletions: 0,
        },
        items: [],
      },
    ],
  };
  const api = {
    settings: { baseUrl: "https://claude.home.arpa", token: "test" },
    markViewed: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    updateThreadDraft: vi.fn(async (_id, value) => (value ? { ...value, updatedAt: 100 } : null)),
    interrupt: vi.fn().mockResolvedValue(undefined),
    sendQueuedNow: vi.fn().mockResolvedValue({ turnId: "active" }),
  };
  const context = {
    api,
    appActive: true,
    foregroundEpoch: 0,
    streamRecoveryEpoch: 0,
    state: {
      snapshot: {
        instanceId: "test",
        sequence: 1,
        projects: [],
        threads: [thread],
        attention: [],
        voiceTranscriptions: [],
        models,
        connection: { state: "ready" },
      },
      details: { thread: detail },
      expandedHistory: {},
      optimisticMessages: localSteer
        ? {
            thread: [
              {
                id: "steered",
                threadId: "thread",
                text: "Дополнение в активном ходе",
                images: [],
                createdAt: 1,
                destination: "turn" as const,
                turnId: "active",
              },
            ],
          }
        : {},
      voiceRemovals: {},
      network: "connected",
      snapshotEpoch: 1,
    },
    dispatch: vi.fn(),
    refreshDetail: vi.fn().mockResolvedValue(detail),
    forceRefreshDetail: vi.fn().mockResolvedValue(detail),
    loadOlderDetail: vi.fn(),
    loadTurnItems: vi.fn(),
    sendReliable: vi.fn(async (_id, _body, committed) => {
      committed?.();
      return "delivered";
    }),
    queueVoiceRecording: vi.fn().mockResolvedValue(undefined),
  };
  connection.mockReturnValue(context);
  const view = render(
    <MemoryRouter initialEntries={["/threads/thread"]}>
      <ThreadPage
        onOpenNavigation={vi.fn()}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />
    </MemoryRouter>,
  );
  return { ...context, view };
}

function LocationProbe() {
  return <output aria-label="route">{useLocation().pathname}</output>;
}

const transcriptionConfig: TranscriptionConfigResponse = {
  provider: "local",
  providers: ["local"],
  localUrl: "http://127.0.0.1:8178/inference",
  openAiModel: "gpt-4o-transcribe",
  openAiApiKeyConfigured: false,
  language: "ru",
  refineLocal: true,
  refinementModel: "haiku",
  maxRecordingSeconds: 300,
  maxUploadBytes: 24 * 1024 * 1024,
  timingEstimate: {
    sampleCount: 0,
    estimatedFixedProcessingMs: null,
    estimatedProcessingMsPerAudioSecond: null,
  },
};
function installMediaRecorder() {
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported = () => true;
    state = "inactive";
    mimeType = "audio/webm";
    start() {
      this.state = "recording";
    }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      const dataEvent = new Event("dataavailable");
      Object.defineProperty(dataEvent, "data", {
        value: new Blob(["audio"], { type: this.mimeType }),
      });
      this.dispatchEvent(dataEvent);
      this.dispatchEvent(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
  });
}
