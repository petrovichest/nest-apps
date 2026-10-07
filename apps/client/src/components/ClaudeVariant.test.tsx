import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CapacitorCore from "@capacitor/core";
import type {
  AppUpdateStatus,
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
import { ApplicationSettingsCard } from "./ApplicationSettingsCard";
import { Composer } from "./Composer";
import { ThreadPage } from "./ThreadPage";
import { ApiClientError } from "../api";

vi.hoisted(() => vi.stubEnv("VITE_APP_PROVIDER", "claude"));
const connection = vi.hoisted(() => vi.fn());
const openDownloadUrl = vi.hoisted(() => vi.fn());
const isNativePlatform = vi.hoisted(() => vi.fn());
const getAppInfo = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../downloads", () => ({ openDownloadUrl }));
vi.mock("@capacitor/core", async (importOriginal) => {
  const original = await importOriginal<typeof CapacitorCore>();
  return { ...original, Capacitor: { ...original.Capacitor, isNativePlatform } };
});
vi.mock("@capacitor/app", () => ({ App: { getInfo: getAppInfo } }));
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
  isNativePlatform.mockReturnValue(false);
  openDownloadUrl.mockResolvedValue(undefined);
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
  it.each([true, false])("downloads the Claude APK with managed updates %s", async (supported) => {
    const api = {
      settings: { baseUrl: "https://claude.home.arpa" },
      readAppSettings: vi.fn(async () => claudeUpdateStatus({ supported })),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);

    expect(await screen.findByText("0.1.9")).toBeInTheDocument();
    expect(screen.getByText("Обновление ClaudeNest")).toBeInTheDocument();
    const download = screen.getByRole("button", { name: "Скачать свежий APK" });
    expect(download).toBeEnabled();
    expect(screen.getByRole("button", { name: "Скачать расширение для Chrome" })).toBeEnabled();
    expect(screen.getByText("APK на этом устройстве")).toBeInTheDocument();
    expect(screen.getByText("Только в Android")).toBeInTheDocument();
    expect(getAppInfo).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Сервер, веб-интерфейс и APK выпускаются из одной проверенной CI-сборки. При неудачном обновлении сервер автоматически возвращается к предыдущей версии.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(download);
    await waitFor(() =>
      expect(openDownloadUrl).toHaveBeenCalledWith(
        "https://claude.home.arpa",
        "https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/ClaudeNest-latest.apk",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Скачать расширение для Chrome" }));
    await waitFor(() =>
      expect(openDownloadUrl).toHaveBeenCalledWith(
        "https://claude.home.arpa",
        "https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/claudenest-browser-latest.zip",
      ),
    );
    expect(api.readAppSettings).toHaveBeenCalledOnce();
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
    expect(api.updateApp).not.toHaveBeenCalled();
  });

  it("shows the installed Claude Android APK version and build", async () => {
    isNativePlatform.mockReturnValue(true);
    getAppInfo.mockResolvedValue({
      name: "ClaudeNest",
      id: "com.claudenest.app",
      version: "0.1.9-abcdef0",
      build: "1000090",
    });
    connection.mockReturnValue({ api: {}, state: { network: "disconnected" } });

    render(<ApplicationSettingsCard initialStatus={claudeUpdateStatus()} />);

    expect(await screen.findByText("0.1.9-abcdef0 (1000090)")).toBeInTheDocument();
    expect(getAppInfo).toHaveBeenCalledOnce();
  });

  it("reports a failed Claude APK download", async () => {
    openDownloadUrl.mockRejectedValueOnce(new Error("browser failed"));
    connection.mockReturnValue({
      api: { settings: { baseUrl: "https://claude.home.arpa" } },
      state: { network: "disconnected" },
    });

    render(<ApplicationSettingsCard initialStatus={claudeUpdateStatus()} />);
    fireEvent.click(screen.getByRole("button", { name: "Скачать свежий APK" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось открыть загрузку APK");
  });

  it("asks for the Claude server address in Android instead of using the WebView origin", () => {
    isNativePlatform.mockReturnValue(true);
    render(<SetupScreen onConnected={vi.fn()} />);

    expect(screen.getByLabelText("Адрес сервера")).toHaveValue("http://");
    expect(screen.getByLabelText("Адрес сервера")).toHaveAttribute(
      "placeholder",
      "http://192.168.1.42:4311",
    );
  });

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

  it("keeps live model switching and Plan mode while preventing effort changes and unsupported modes", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Включить режим планирования" }));
    expect(onChange).toHaveBeenCalledWith({ collaborationMode: "plan" });
    expect(
      screen.queryByRole("button", { name: "Включить командный режим" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Включить режим цели" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
    expect(screen.queryByRole("switch", { name: /Fast mode/ })).not.toBeInTheDocument();
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
      readClaudeAccounts: vi.fn().mockResolvedValue(null),
      readSkills: vi.fn(),
      updateTranscriptionSettings: vi.fn().mockResolvedValue(transcriptionConfig),
    };
    connection.mockReturnValue({
      api,
      state: {
        network: "connected",
        snapshot: {
          models,
          threads: [],
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
    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
    expect(screen.queryByRole("switch", { name: /Fast mode/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Приложение" }));
    expect(screen.queryByRole("tab", { name: "Скиллы" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Обслуживание" })).toBeInTheDocument();
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
      readClaudeAccounts: vi.fn(async () => ({
        cliVersion: "2.1.289",
        autoSwitch: true,
        warmLimits: true,
        currentAccountId: null,
        accounts: [],
      })),
    };
    connection.mockReturnValue({
      api,
      state: {
        snapshot: {
          models,
          threads: [],
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

  it("queues active Claude input like Codex and steers with the modifier shortcut", () => {
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
        codexSettings={{ model: "claude-opus-5", reasoningEffort: null }}
        settings={{ collaborationMode: "default", model: "sonnet" }}
        onSettingsChange={vi.fn()}
        models={models}
        error={null}
      />,
    );
    const textarea = screen.getByRole("textbox");
    expect(screen.queryByText("Полный доступ")).not.toBeInTheDocument();
    expect(view.container.querySelector(".codex-settings-hint")).toBeNull();
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.submit(view.container.querySelector("form")!);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSubmit.mock.calls).toEqual([["queue"], ["queue"], ["immediate"], ["immediate"]]);
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Добавить в очередь" })).toBeEnabled();
    expect(screen.getByText("Сообщение будет добавлено в очередь")).toBeInTheDocument();
  });

  it.each([
    ["active", true, "steer"],
    ["active", false, "queue"],
    [null, true, "steer"],
    [null, false, "queue"],
  ] as const)(
    "delivers active input with current turn=%s and steer shortcut=%s without interrupting",
    async (currentTurnId, steer, mode) => {
      const context = renderActiveClaudeThread([], false, currentTurnId);
      const textarea = await screen.findByRole("textbox", { name: "Направить текущую задачу" });
      fireEvent.change(textarea, { target: { value: "Уточнение" } });
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: steer });
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
      expect(screen.queryByText("Полный доступ")).not.toBeInTheDocument();
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

  it("keeps file attachments and queue submission and toggles Plan mode with Shift+Tab", async () => {
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
    expect(onSettingsChange).toHaveBeenCalledWith({ collaborationMode: "plan" });
    expect(screen.getByRole("button", { name: /план/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /оркестратор/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /цели/i })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("queue");
  });

  it("searches titles before native message history and opens title matches directly", async () => {
    const thread = {
      id: "thread",
      title: "Голос и файлы",
      cwd: "/work",
      updatedAt: 1,
      archived: false,
    } as ThreadSummary;
    const api = {
      searchThreads: vi.fn(async (_query, archived, _cursor, scope) => ({
        data: archived || scope !== "titles" ? [] : [{ thread, snippet: "" }],
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
    await waitFor(() => expect(api.searchThreads).toHaveBeenCalledTimes(4));
    expect(api.searchThreads.mock.calls).toEqual(
      expect.arrayContaining([
        ["Голос", false, undefined, "titles"],
        ["Голос", false, undefined, "messages"],
        ["Голос", true, undefined, "titles"],
        ["Голос", true, undefined, "messages"],
      ]),
    );
    expect(api.searchOccurrences).not.toHaveBeenCalled();
  });
});

function claudeUpdateStatus(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    supported: true,
    canUpdateWithActiveTurns: true,
    currentVersion: "0.1.9",
    latestVersion: null,
    updateAvailable: false,
    operation: "idle",
    result: "none",
    message: null,
    checkedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

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
