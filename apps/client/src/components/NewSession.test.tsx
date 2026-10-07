import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";

import type {
  ModelOption,
  Project,
  ThreadDraft,
  ThreadSummary,
  TranscriptionConfigResponse,
} from "@codexnest/protocol";

import { ApiClientError } from "../api";
import { mergeProjectDraft } from "@codexnest/protocol";
import type { LocalNewSessionDraft } from "../offline-store";
import { NewSession } from "./NewSession";

const connection = vi.hoisted(() => vi.fn());
const drafts = vi.hoisted(() => ({
  delete: vi.fn().mockResolvedValue(undefined),
  deleteLocal: vi.fn().mockResolvedValue(undefined),
  load: vi.fn().mockResolvedValue(null),
  loadLocal: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(true),
  saveLocal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../offline-store", () => ({
  deleteLocalDraft: drafts.deleteLocal,
  deleteNewSessionDraft: drafts.delete,
  loadNewSessionDraft: drafts.load,
  loadLocalDraft: drafts.loadLocal,
  saveLocalDraft: drafts.saveLocal,
  saveNewSessionDraft: drafts.save,
}));

const project: Project = {
  id: "project",
  displayName: "CodexNest",
  path: "/work/codex-nest",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const thread = {
  id: "created",
  projectId: project.id,
  relation: { kind: "root" },
  settings: { collaborationMode: "plan" },
} as unknown as ThreadSummary;

const connectionSettings = { baseUrl: "https://pi.local", token: "token" };
const model: ModelOption = {
  id: "gpt",
  displayName: "GPT",
  description: "",
  isDefault: true,
  reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
  serviceTiers: [],
  supportsPersonality: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  drafts.delete.mockResolvedValue(undefined);
  drafts.deleteLocal.mockResolvedValue(undefined);
  drafts.load.mockResolvedValue(null);
  drafts.loadLocal.mockResolvedValue(null);
  drafts.save.mockResolvedValue(true);
  drafts.saveLocal.mockResolvedValue(undefined);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("NewSession", () => {
  it("stages a minute of voice before creation, shows it immediately, and uploads it once", async () => {
    const microphone = installRecorder();
    const creation = deferred<{ thread: ThreadSummary }>();
    const upload = deferred<void>();
    const createProjectThread = vi.fn().mockReturnValue(creation.promise);
    const queueVoiceRecording = vi.fn().mockReturnValue(upload.promise);
    const context = mockConnection({ createProjectThread, queueVoiceRecording });
    connection.mockReturnValue(context);
    renderNewSession(voiceConfig);
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Контекст перед голосом" } });
    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    const stop = await screen.findByRole("button", { name: "Остановить запись" });
    expect(createProjectThread).not.toHaveBeenCalled();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    fireEvent.click(stop);
    fireEvent.click(stop);

    expect(await screen.findByRole("status", { name: "Отправляем запись" })).toHaveTextContent(
      "Контекст перед голосом",
    );
    expect(screen.queryByRole("button", { name: "Остановить запись" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Распознаём запись" })).not.toBeInTheDocument();
    expect(context.api.transcribe).not.toHaveBeenCalled();
    await waitFor(() => expect(createProjectThread).toHaveBeenCalledOnce());
    const staged = drafts.save.mock.calls.find((call) => call[3]?.voiceSubmission)?.[3];
    expect(staged.voiceSubmission.recording.durationMs).toBeGreaterThanOrEqual(60_000);
    expect(staged.voiceSubmission.recording.audio.size).toBeGreaterThan(0);
    expect(drafts.save.mock.invocationCallOrder[0]).toBeLessThan(
      createProjectThread.mock.invocationCallOrder[0],
    );
    expect(drafts.delete).not.toHaveBeenCalled();
    expect(context.api.updateProjectDraft).not.toHaveBeenCalled();
    creation.resolve({ thread });
    await waitFor(() => expect(queueVoiceRecording).toHaveBeenCalledOnce());
    expect(queueVoiceRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        id: staged.voiceSubmission.recording.id,
        threadId: thread.id,
        mode: "send",
        audio: staged.voiceSubmission.recording.audio,
        draft: expect.objectContaining({ input: "Контекст перед голосом" }),
      }),
    );
    expect(drafts.delete).not.toHaveBeenCalled();
    expect(context.api.updateProjectDraft).not.toHaveBeenCalled();
    upload.resolve();
    await waitFor(() => expect(drafts.delete).toHaveBeenCalled());
    expect(microphone.getUserMedia).toHaveBeenCalledOnce();
    expect(microphone.start).toHaveBeenCalledOnce();
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(context.sendReliable).not.toHaveBeenCalled();
  });

  it.each(["creation", "upload"])(
    "recovers voice after a %s failure and reopening without a new recording",
    async (failure) => {
      const microphone = installRecorder();
      const offline = new ApiClientError("connection_failed", "Нет связи");
      const createProjectThread =
        failure === "creation"
          ? vi.fn().mockRejectedValueOnce(offline).mockResolvedValue({ thread })
          : vi.fn().mockResolvedValue({
              thread,
              draft: { input: "", images: [], annotations: [], goalMode: false, updatedAt: 17 },
            });
      const queueVoiceRecording =
        failure === "upload"
          ? vi.fn().mockRejectedValueOnce(offline).mockResolvedValue(undefined)
          : vi.fn().mockResolvedValue(undefined);
      let persisted!: LocalNewSessionDraft;
      drafts.save.mockImplementation((_settings, _project, value, preparation) => {
        persisted = {
          ...preparation,
          value,
          voiceSubmission: preparation.voiceSubmission
            ? {
                ...preparation.voiceSubmission,
                recording: { ...preparation.voiceSubmission.recording },
              }
            : undefined,
        };
        return Promise.resolve(true);
      });
      const context = mockConnection({ createProjectThread, queueVoiceRecording });
      connection.mockReturnValue(context);
      const view = renderNewSession(voiceConfig);
      fireEvent.click(await screen.findByRole("button", { name: "Начать запись" }));
      fireEvent.click(await screen.findByRole("button", { name: "Остановить запись" }));
      await screen.findByRole("button", { name: "Повторить отправку" });
      expect(drafts.delete).not.toHaveBeenCalled();
      const id = persisted.voiceSubmission!.recording.id;
      const creationId = persisted.clientCreationId;
      view.unmount();
      await act(async () => undefined);
      drafts.load.mockResolvedValue(persisted);
      renderNewSession(voiceConfig);
      await waitFor(() => expect(drafts.delete).toHaveBeenCalled());
      expect(queueVoiceRecording.mock.calls.at(-1)?.[0]).toMatchObject({
        id,
        threadId: thread.id,
        mode: "send",
        draftUpdatedAt: failure === "upload" ? 17 : null,
      });
      expect(createProjectThread).toHaveBeenCalledTimes(failure === "creation" ? 2 : 1);
      expect(createProjectThread.mock.calls.at(-1)?.[1]).toBe(creationId);
      expect(microphone.getUserMedia).toHaveBeenCalledOnce();
      expect(context.api.transcribe).not.toHaveBeenCalled();
    },
  );

  it("keeps voice available for retry when local staging fails before any network request", async () => {
    const microphone = installRecorder();
    const createProjectThread = vi.fn().mockResolvedValue({ thread });
    const queueVoiceRecording = vi.fn().mockResolvedValue(undefined);
    const context = mockConnection({ createProjectThread, queueVoiceRecording });
    connection.mockReturnValue(context);
    drafts.save.mockResolvedValue(false);
    renderNewSession(voiceConfig);
    fireEvent.click(await screen.findByRole("button", { name: "Начать запись" }));
    fireEvent.click(await screen.findByRole("button", { name: "Остановить запись" }));
    const retry = await screen.findByRole("button", { name: "Повторить отправку" });
    expect(createProjectThread).not.toHaveBeenCalled();
    expect(queueVoiceRecording).not.toHaveBeenCalled();
    drafts.save.mockResolvedValue(true);
    fireEvent.click(retry);
    await waitFor(() => expect(queueVoiceRecording).toHaveBeenCalledOnce());
    expect(microphone.getUserMedia).toHaveBeenCalledOnce();
  });

  it("keeps the first voice draft, cursor, goal and transferred project files", async () => {
    installRecorder();
    const file = {
      id: "project-file",
      path: "/project/source.txt",
      name: "source.txt",
      size: 5,
      mediaType: "text/plain",
    };
    const transferred = { ...file, id: "thread-file", path: "/thread/source.txt" };
    const draft = {
      input: "До после",
      images: [{ id: "image", name: "image", url: "data:image/png;base64,aA==" }],
      files: [file],
      goalMode: true,
      annotations: [],
      updatedAt: 3,
    };
    const createProjectThread = vi
      .fn()
      .mockResolvedValue({ thread, draft: { ...draft, files: [transferred], updatedAt: 19 } });
    const upload = deferred<void>();
    const queueVoiceRecording = vi.fn().mockReturnValue(upload.promise);
    const context = mockConnection({
      readProjectDraft: vi.fn().mockResolvedValue(draft),
      createProjectThread,
      queueVoiceRecording,
    });
    connection.mockReturnValue(context);
    renderNewSession(voiceConfig);
    const textarea = (await screen.findByRole("textbox", {
      name: "Сообщение для Codex",
    })) as HTMLTextAreaElement;
    textarea.setSelectionRange(3, 3);
    fireEvent.select(textarea);
    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    fireEvent.click(await screen.findByRole("button", { name: "Остановить запись" }));
    await waitFor(() => expect(queueVoiceRecording).toHaveBeenCalledOnce());
    expect(createProjectThread).toHaveBeenCalledWith(
      project.id,
      expect.any(String),
      expect.objectContaining({ files: [file] }),
    );
    expect(queueVoiceRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionStart: 3,
        selectionEnd: 3,
        draftUpdatedAt: 19,
        newSessionProjectId: project.id,
        draft: expect.objectContaining({
          input: draft.input,
          images: draft.images,
          files: [transferred],
          goalMode: true,
        }),
      }),
    );
    expect(context.api.updateProjectDraft).not.toHaveBeenCalled();
    upload.resolve();
    await waitFor(() => expect(drafts.delete).toHaveBeenCalled());
    expect(context.api.updateProjectDraft).toHaveBeenCalledWith(
      project.id,
      { input: draft.input, images: draft.images, files: [file], goalMode: true, annotations: [] },
      expect.objectContaining({ input: "", images: [], goalMode: false }),
      { expectedUpdatedAt: draft.updatedAt },
    );
  });

  it("cancels a first recording without creating a session or submitting audio", async () => {
    installRecorder();
    const context = mockConnection({});
    connection.mockReturnValue(context);
    renderNewSession(voiceConfig);
    fireEvent.click(await screen.findByRole("button", { name: "Начать запись" }));
    fireEvent.click(await screen.findByRole("button", { name: "Отменить запись" }));
    await screen.findByRole("button", { name: "Начать запись" });
    expect(context.api.createProjectThread).not.toHaveBeenCalled();
    expect(context.queueVoiceRecording).not.toHaveBeenCalled();
    expect(drafts.save.mock.calls.some((call) => call[3]?.voiceSubmission)).toBe(false);
  });

  it("loads the server state before enabling input and persists a fast Enter", async () => {
    const hydration = deferred<ThreadDraft | null>();
    const creation = deferred<{ thread: ThreadSummary }>();
    const delivery = deferred<"delivered">();
    const createProjectThread = vi.fn().mockReturnValue(creation.promise);
    let commit: (() => void) | undefined;
    const sendReliable = vi.fn((_id, _body, onCommitted) => {
      commit = onCommitted;
      return delivery.promise;
    });
    connection.mockReturnValue(
      mockConnection({
        readProjectDraft: vi.fn().mockReturnValue(hydration.promise),
        createProjectThread,
        sendReliable,
      }),
    );
    renderNewSession();
    expect(screen.queryByRole("textbox", { name: "Сообщение для Codex" })).not.toBeInTheDocument();
    expect(createProjectThread).not.toHaveBeenCalled();
    await act(async () => hydration.resolve(null));
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Быстрое первое сообщение" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(createProjectThread).toHaveBeenCalledOnce());
    expect(drafts.save).toHaveBeenCalledWith(
      connectionSettings,
      project.id,
      expect.anything(),
      expect.objectContaining({
        submission: expect.objectContaining({
          id: expect.any(String),
          input: "Быстрое первое сообщение",
        }),
      }),
    );
    expect(textbox).toHaveValue("");
    expect(screen.getByText("Быстрое первое сообщение")).toBeInTheDocument();
    creation.resolve({ thread });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    act(() => commit!());
    delivery.resolve("delivered");
    await waitFor(() => expect(drafts.delete).toHaveBeenCalled());
  });

  it("continues a persisted first submission with its original id after reopening", async () => {
    const draft = { input: "Сохранённая отправка", images: [], goalMode: false, annotations: [] };
    drafts.load.mockResolvedValue({
      projectId: project.id,
      value: draft,
      threadId: thread.id,
      thread,
      phase: "transferring",
      revision: 1,
      submission: { id: "persisted-id", intent: "queue", input: draft.input, draft },
    });
    const createProjectThread = vi.fn();
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    renderNewSession();
    await waitFor(() =>
      expect(sendReliable).toHaveBeenCalledWith(
        thread.id,
        expect.objectContaining({ clientMessageId: "persisted-id", input: draft.input }),
        expect.any(Function),
        expect.objectContaining({ projectId: project.id }),
      ),
    );
    expect(createProjectThread).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("");
  });

  it("automatically retries creation without losing the first submission identity", async () => {
    const createProjectThread = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError("app_server_unavailable", "Временно недоступно", 503),
      )
      .mockResolvedValue({ thread });
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Повтори после сбоя" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() =>
      expect(
        screen.getByText("Сервер временно недоступен — повторим отправку"),
      ).toBeInTheDocument(),
    );
    const firstSubmission = drafts.save.mock.calls.find((call) => call[3]?.submission)?.[3]
      .submission;
    expect(firstSubmission?.id).toEqual(expect.any(String));
    expect(textbox).toHaveValue("");
    expect(screen.getByText("Повтори после сбоя")).toBeInTheDocument();
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce(), { timeout: 2500 });
    expect(sendReliable.mock.calls[0]?.[1].clientMessageId).toBe(firstSubmission.id);
    expect(createProjectThread).toHaveBeenCalledTimes(2);
  });

  it("recovers an Enter across a page reload while session creation is still pending", async () => {
    let stored: LocalNewSessionDraft | null = null;
    drafts.load.mockImplementation(async () => stored);
    drafts.save.mockImplementation(async (_settings, projectId, value, preparation) => {
      stored = structuredClone({
        key: "new",
        connectionKey: "test",
        projectId,
        value,
        ...preparation,
        updatedAt: 1,
      });
      return true;
    });
    const firstCreation = deferred<{ thread: ThreadSummary }>();
    const createProjectThread = vi
      .fn()
      .mockReturnValueOnce(firstCreation.promise)
      .mockResolvedValue({ thread });
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    const view = renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Пережить перезагрузку" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(createProjectThread).toHaveBeenCalledOnce());
    const messageId = stored!.submission!.id;
    view.unmount();
    renderNewSession();
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(sendReliable.mock.calls[0]?.[1]).toMatchObject({
      input: "Пережить перезагрузку",
      clientMessageId: messageId,
    });
    await act(async () => firstCreation.resolve({ thread }));
    expect(sendReliable).toHaveBeenCalledOnce();
  });

  it("carries immediate submission through session creation", async () => {
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    const sendQueuedNow = vi.fn().mockResolvedValue({ turnId: "turn" });
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockResolvedValue({ thread }),
        sendQueuedNow,
        sendReliable,
      }),
    );
    renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textbox, { target: { value: "Отправь сразу" } });
    fireEvent.keyDown(textbox, { key: "Enter", metaKey: true });

    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    const clientMessageId = sendReliable.mock.calls[0]?.[1].clientMessageId;
    expect(clientMessageId).toEqual(expect.any(String));
    expect(sendQueuedNow).toHaveBeenCalledWith(thread.id, clientMessageId);
  });

  it("retains the first draft and does not create a session when local persistence fails", async () => {
    drafts.save.mockResolvedValue(false);
    const createProjectThread = vi.fn();
    const sendReliable = vi.fn();
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Не очищать без копии" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByText("Не удалось сохранить черновик на устройстве")).toBeInTheDocument(),
    );
    expect(textbox).toHaveValue("Не очищать без копии");
    expect(createProjectThread).not.toHaveBeenCalled();
    expect(sendReliable).not.toHaveBeenCalled();
  });

  it("keeps the next draft separate while the first message waits for session creation", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const delivery = deferred<"delivered">();
    const sendReliable = vi.fn((_id, _body, commit) => {
      commit();
      return delivery.promise;
    });
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockReturnValue(creation.promise),
        sendReliable,
      }),
    );
    renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Первое" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(textbox).toHaveValue(""));
    fireEvent.change(textbox, { target: { value: "Следующее" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(sendReliable).not.toHaveBeenCalled();
    expect(screen.getByText("Первое")).toBeInTheDocument();
    creation.resolve({ thread });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(sendReliable.mock.calls[0]?.[1].input).toBe("Первое");
    expect(textbox).toHaveValue("Следующее");
    expect(drafts.save).toHaveBeenCalledWith(
      connectionSettings,
      project.id,
      expect.objectContaining({ input: "Следующее" }),
      expect.objectContaining({
        submission: expect.objectContaining({ input: "Первое", staged: true }),
      }),
    );
    await act(async () => delivery.resolve("delivered"));
    expect(textbox).toHaveValue("Следующее");
  });

  it("retains a permanently rejected first submission for explicit retry", async () => {
    const creation = deferred<{ thread: ThreadSummary }>();
    const createProjectThread = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError("invalid", "Cannot create", 400))
      .mockReturnValue(creation.promise);
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(mockConnection({ createProjectThread, sendReliable }));
    renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Повторить вручную" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(await screen.findByText("Не отправлено")).toBeInTheDocument();
    expect(screen.getByText("Повторить вручную")).toBeInTheDocument();
    expect(textbox).toHaveValue("");
    const id = drafts.save.mock.calls.find((call) => call[3]?.submission)?.[3].submission.id;
    expect(createProjectThread).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
    await waitFor(() => expect(createProjectThread).toHaveBeenCalledTimes(2));
    creation.resolve({ thread });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(sendReliable.mock.calls[0]?.[1].clientMessageId).toBe(id);
  });

  it("keeps the project draft on the server across reopening without starting a session", async () => {
    let shared: ThreadDraft | null = null;
    const readProjectDraft = vi.fn(async () => shared);
    const updateProjectDraft = vi.fn(async (_id, base, value) => {
      shared = { ...mergeProjectDraft(shared ?? base, base, value), updatedAt: Date.now() };
      return shared;
    });
    const createProjectThread = vi.fn().mockResolvedValue({ thread });
    const sendReliable = vi.fn().mockImplementation(async () => {
      shared = null;
      return "delivered";
    });
    connection.mockReturnValue(
      mockConnection({ readProjectDraft, updateProjectDraft, createProjectThread, sendReliable }),
    );
    let view = renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Не потерять черновик" } });
    view.unmount();
    await waitFor(() => expect(shared?.input).toBe("Не потерять черновик"));
    expect(createProjectThread).not.toHaveBeenCalled();
    expect(drafts.save).not.toHaveBeenCalled();
    view = renderNewSession();
    expect(await screen.findByDisplayValue("Не потерять черновик")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      key: "Enter",
    });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(sendReliable.mock.calls[0]?.[1]).toMatchObject({
      projectDraft: { projectId: project.id, updatedAt: expect.any(Number) },
    });
    await waitFor(() => expect(drafts.delete).toHaveBeenCalled());
    view.unmount();
    renderNewSession();
    expect(await screen.findByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("");
    expect(createProjectThread).toHaveBeenCalledOnce();
  });

  it("uploads files to the project without creating a session and sends transferred files", async () => {
    const projectFile = {
      id: "project-file",
      name: "notes.txt",
      path: "/project/notes.txt",
      size: 5,
      mediaType: "text/plain",
    };
    const nativeFile = { ...projectFile, id: "native-file", path: "/thread/notes.txt" };
    const uploadProjectAttachment = vi.fn().mockResolvedValue(projectFile);
    const createProjectThread = vi.fn(async (_id, _key, draft) => ({
      thread,
      draft: { ...draft, files: [nativeFile], updatedAt: 1 },
    }));
    const uploadAttachment = vi.fn();
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(
      mockConnection({
        createProjectThread,
        sendReliable,
        uploadAttachment,
        uploadProjectAttachment,
      }),
    );
    const view = renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(
      await screen.findByRole("button", { name: "Удалить файл notes.txt" }),
    ).toBeInTheDocument();
    expect(uploadProjectAttachment).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ name: "notes.txt", size: 5 }),
    );
    expect(createProjectThread).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(createProjectThread.mock.calls[0]?.[2].files).toEqual([projectFile]);
    expect(sendReliable.mock.calls[0]?.[1].files).toEqual([nativeFile]);
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it("uses server state instead of a stale local draft and legacy thread binding", async () => {
    drafts.load.mockResolvedValue({
      projectId: project.id,
      clientCreationId: "obsolete-id",
      threadId: "missing",
      value: { input: "Старый черновик", images: [], annotations: [], goalMode: false },
    });
    const readProjectDraft = vi.fn().mockResolvedValue({
      input: "Серверный черновик",
      images: [],
      annotations: [],
      goalMode: false,
      updatedAt: 5,
    });
    const createProjectThread = vi.fn().mockResolvedValue({ thread });
    const readThread = vi.fn();
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(
      mockConnection({ readProjectDraft, createProjectThread, readThread, sendReliable }),
    );
    renderNewSession();
    expect(await screen.findByDisplayValue("Серверный черновик")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Сообщение для Codex" }), {
      key: "Enter",
    });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(createProjectThread.mock.calls[0]?.[1]).not.toBe("obsolete-id");
    expect(readThread).not.toHaveBeenCalled();
  });

  it("loads text from one device, adds an image on another and sends both", async () => {
    const remote = {
      input: "Текст с первого устройства",
      images: [],
      files: [],
      annotations: [],
      goalMode: false,
      updatedAt: 7,
    };
    const readProjectDraft = vi.fn().mockResolvedValue(remote);
    const updateProjectDraft = vi.fn(async (_id, base, value) => ({
      ...mergeProjectDraft(remote, base, value),
      updatedAt: 8,
    }));
    const createProjectThread = vi.fn().mockResolvedValue({ thread });
    const sendReliable = vi.fn().mockResolvedValue("delivered");
    connection.mockReturnValue(
      mockConnection({ readProjectDraft, updateProjectDraft, createProjectThread, sendReliable }),
    );
    const view = renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    expect(textbox).toHaveValue(remote.input);
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["image"], "second.png", { type: "image/png" })] },
    });
    expect(await screen.findByAltText("second.png")).toBeInTheDocument();
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
    expect(sendReliable.mock.calls[0]?.[1]).toMatchObject({
      input: remote.input,
      images: [expect.stringMatching(/^data:image\/png/)],
      projectDraft: { projectId: project.id, updatedAt: 8 },
    });
  });

  it("keeps input unavailable after a failed server load and retries", async () => {
    const readProjectDraft = vi
      .fn()
      .mockRejectedValueOnce(new Error("Не удалось загрузить черновик"))
      .mockResolvedValue({
        input: "Восстановлен с сервера",
        images: [],
        annotations: [],
        goalMode: false,
        updatedAt: 1,
      });
    connection.mockReturnValue(mockConnection({ readProjectDraft }));
    renderNewSession();
    expect(await screen.findByText("Не удалось загрузить черновик")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Сообщение для Codex" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByDisplayValue("Восстановлен с сервера")).toBeInTheDocument();
    expect(readProjectDraft).toHaveBeenCalledTimes(2);
  });

  it("applies broadcasts to an open composer while preserving unsaved local text", async () => {
    const empty = { input: "", images: [], annotations: [], goalMode: false, updatedAt: 1 };
    const mock = mockConnection({ readProjectDraft: vi.fn().mockResolvedValue(empty) });
    connection.mockReturnValue(mock);
    const view = renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Локальный текст" } });
    const image = { id: "remote-image", name: "remote.png", url: "data:image/png;base64,aGVsbG8=" };
    Object.assign(mock.state, {
      projectDrafts: { [project.id]: { ...empty, images: [image], updatedAt: 2 } },
    });
    view.rerender(newSessionElement());
    expect(await screen.findByAltText("remote.png")).toBeInTheDocument();
    expect(textbox).toHaveValue("Локальный текст");
    Object.assign(mock.state, {
      projectDrafts: {
        [project.id]: {
          ...empty,
          input: "Текст на другом устройстве",
          images: [image],
          updatedAt: 3,
        },
      },
    });
    fireEvent.change(textbox, { target: { value: "" } });
    view.rerender(newSessionElement());
    // Returning to the base text leaves that field free to follow the server.
    expect(textbox).toHaveValue("Текст на другом устройстве");
  });

  it("does not create a session when /new is opened directly", async () => {
    const createProjectThread = vi.fn();
    connection.mockReturnValue(mockConnection({ createProjectThread }));

    render(
      <MemoryRouter initialEntries={["/new?projectId=project"]}>
        <Routes>
          <Route
            path="/new"
            element={<NewSession projects={[project]} onOpenNavigation={() => undefined} />}
          />
          <Route path="/" element={<div>Главная</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Главная")).toBeInTheDocument();
    expect(createProjectThread).not.toHaveBeenCalled();
  });

  it.each([
    { defaultTier: undefined, expectedTier: "fast" },
    { defaultTier: "fast", expectedTier: null },
  ])(
    "applies a pending Fast change to $expectedTier before the first message",
    async ({ defaultTier, expectedTier }) => {
      const creation = deferred<{ thread: ThreadSummary }>();
      const createProjectThread = vi.fn().mockReturnValue(creation.promise);
      const updateThreadSettings = vi.fn().mockResolvedValue({
        ...thread,
        settings: {
          collaborationMode: "plan",
          ...(expectedTier ? { serviceTier: expectedTier } : {}),
        },
      });
      const context = mockConnection({
        createProjectThread,
        updateThreadSettings,
        models: [{ ...model, serviceTiers: [{ id: "priority", displayName: "Fast" }] }],
        taskDefaults: { serviceTier: defaultTier },
      });
      connection.mockReturnValue(context);
      renderNewSession();
      const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
      fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
      fireEvent.click(screen.getByRole("switch", { name: /^Fast mode/ }));
      fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
      expect(updateThreadSettings).not.toHaveBeenCalled();
      fireEvent.change(textbox, { target: { value: "Первое сообщение" } });
      fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
      await waitFor(() => expect(createProjectThread).toHaveBeenCalledOnce());
      creation.resolve({
        thread: {
          ...thread,
          settings: {
            collaborationMode: "plan",
            ...(defaultTier ? { serviceTier: defaultTier } : {}),
          },
        },
      });
      await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
      expect(updateThreadSettings).toHaveBeenCalledWith(thread.id, { serviceTier: expectedTier });
      expect(updateThreadSettings.mock.invocationCallOrder[0]).toBeLessThan(
        context.sendReliable.mock.invocationCallOrder[0],
      );
    },
  );

  it.each([
    { restoredTier: undefined, defaultTier: "fast", createdTier: "fast", expectedTier: null },
    {
      restoredTier: "priority",
      defaultTier: undefined,
      createdTier: undefined,
      expectedTier: "fast",
    },
  ])(
    "restores saved Fast $restoredTier against a newer default $defaultTier",
    async ({ restoredTier, defaultTier, createdTier, expectedTier }) => {
      drafts.load.mockResolvedValue({
        value: { input: "Сохранённое сообщение", images: [], annotations: [], goalMode: false },
        settings: {
          collaborationMode: "plan",
          ...(restoredTier ? { serviceTier: restoredTier } : {}),
        },
        submission: {
          id: "saved-message",
          input: "Сохранённое сообщение",
          intent: "queue",
          draft: { input: "Сохранённое сообщение", images: [], annotations: [], goalMode: false },
        },
        phase: "creating",
        threadId: null,
        thread: null,
        revision: 1,
      });
      const created = {
        ...thread,
        settings: {
          collaborationMode: "plan" as const,
          ...(createdTier ? { serviceTier: createdTier } : {}),
        },
      };
      const updateThreadSettings = vi.fn().mockResolvedValue({
        ...thread,
        settings: {
          collaborationMode: "plan",
          ...(expectedTier ? { serviceTier: expectedTier } : {}),
        },
      });
      const creation = deferred<{ thread: ThreadSummary }>();
      const createProjectThread = vi.fn().mockReturnValue(creation.promise);
      const context = mockConnection({
        models: [{ ...model, serviceTiers: [{ id: "priority", displayName: "Fast" }] }],
        taskDefaults: { serviceTier: defaultTier },
        createProjectThread,
        updateThreadSettings,
      });
      connection.mockReturnValue(context);
      renderNewSession();
      await waitFor(() => expect(createProjectThread).toHaveBeenCalledOnce());
      const opener = screen.getByRole("button", { name: "Модель и уровень рассуждений" });
      if (restoredTier) expect(opener).toHaveTextContent("Fast");
      else expect(opener).not.toHaveTextContent("Fast");
      creation.resolve({ thread: created });
      await waitFor(() =>
        expect(updateThreadSettings).toHaveBeenCalledWith(thread.id, { serviceTier: expectedTier }),
      );
      await waitFor(() => expect(context.sendReliable).toHaveBeenCalledOnce());
      expect(updateThreadSettings.mock.invocationCallOrder[0]).toBeLessThan(
        context.sendReliable.mock.invocationCallOrder[0],
      );
    },
  );

  it("restores an abandoned early submission with Fast off on an unsupported model", async () => {
    let stored: {
      projectId: string;
      value: ThreadDraft;
      settings?: ThreadSummary["settings"];
      phase: "creating" | "transferring";
      threadId: string | null;
      thread: ThreadSummary | null;
      revision: number;
    } | null = null;
    drafts.load.mockImplementation(async () => stored);
    drafts.save.mockImplementation(
      async (
        _settings,
        projectId,
        value,
        preparation: Omit<NonNullable<typeof stored>, "projectId" | "value">,
      ) => {
        stored = {
          projectId,
          value: structuredClone(value),
          ...structuredClone(preparation),
        };
        return true;
      },
    );
    const abandonedCreation = deferred<{ thread: ThreadSummary }>();
    const createProjectThread = vi
      .fn()
      .mockReturnValueOnce(abandonedCreation.promise)
      .mockReturnValue(new Promise(() => undefined));
    const sendReliable = vi.fn();
    connection.mockReturnValue(
      mockConnection({
        createProjectThread,
        models: [model],
        sendReliable,
        taskDefaults: { serviceTier: "fast", personality: "friendly" },
      }),
    );

    const view = render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/new",
            search: "?projectId=project",
            state: { newSessionProjectId: project.id, newSessionWorkspaceId: "first" },
          },
        ]}
      >
        <Routes>
          <Route
            path="/new"
            element={
              <>
                <NewSession projects={[project]} onOpenNavigation={() => undefined} />
                <Link to="/away">Покинуть подготовку</Link>
              </>
            }
          />
          <Route
            path="/away"
            element={<Link to="/new?projectId=project">Открыть проект снова</Link>}
          />
        </Routes>
      </MemoryRouter>,
    );

    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Сохрани после ухода" } });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["image"], "saved.png", { type: "image/png" })] },
    });
    expect(await screen.findByAltText("saved.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Выключить режим планирования" }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(textbox).toHaveValue("Сохрани после ухода");

    fireEvent.click(screen.getByRole("link", { name: "Покинуть подготовку" }));
    expect(await screen.findByRole("link", { name: "Открыть проект снова" })).toBeInTheDocument();
    await waitFor(() => {
      expect(stored?.value.input).toBe("Сохрани после ухода");
      expect(stored?.value.images).toEqual([
        expect.objectContaining({
          name: "saved.png",
          url: expect.stringMatching(/^data:image\/png/),
        }),
      ]);
      expect(stored?.settings).toEqual({
        collaborationMode: "default",
        personality: "friendly",
      });
    });
    await act(async () => {
      abandonedCreation.resolve({
        thread: { ...thread, id: "abandoned", title: "Оставленная задача" },
      });
      await Promise.resolve();
    });
    expect(sendReliable).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "Открыть проект снова" }));

    expect(await screen.findByText("Сохрани после ухода")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("");
    expect(view.container.querySelector('img[src^="data:image/png"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toBeInTheDocument();
    await waitFor(() => expect(createProjectThread).toHaveBeenCalledOnce());
    expect(sendReliable).not.toHaveBeenCalled();
  });

  it("warns when the preparation cannot be stored locally", async () => {
    drafts.save.mockResolvedValue(false);
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockReturnValue(new Promise(() => undefined)),
      }),
    );

    renderNewSession();
    const textbox = await screen.findByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.change(textbox, { target: { value: "Отправить" } });
    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(
      await screen.findByText(
        "Локальное сохранение недоступно. Не закрывайте страницу до отправки сообщения.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the inspector closed until the user opens it", async () => {
    connection.mockReturnValue(
      mockConnection({
        createProjectThread: vi.fn().mockReturnValue(new Promise(() => undefined)),
      }),
    );
    renderNewSession();

    expect(screen.queryByLabelText("Сведения о новой задаче")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Показать сведения" }));
    expect(await screen.findByLabelText("Сведения о новой задаче")).toBeInTheDocument();
  });
});

function renderNewSession(transcriptionConfig?: TranscriptionConfigResponse) {
  return render(newSessionElement(transcriptionConfig));
}

function newSessionElement(transcriptionConfig?: TranscriptionConfigResponse) {
  return (
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/new",
          search: "?projectId=project",
          state: { newSessionProjectId: project.id },
        },
      ]}
    >
      <Routes>
        <Route
          path="*"
          element={<PersistentNewSessionRoute transcriptionConfig={transcriptionConfig} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

function PersistentNewSessionRoute({
  transcriptionConfig,
}: {
  transcriptionConfig?: TranscriptionConfigResponse;
}) {
  const location = useLocation();
  return (
    <>
      <NewSession
        projects={[project]}
        onOpenNavigation={() => undefined}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider={transcriptionConfig?.provider}
      />
      {location.pathname.startsWith("/threads/") && <div>Созданная сессия</div>}
    </>
  );
}

function mockConnection({
  readProjectDraft = vi.fn().mockResolvedValue(null),
  updateProjectDraft = vi.fn(async (_id, base, value) => ({
    ...mergeProjectDraft(base, base, value),
    updatedAt: Date.now(),
  })),
  uploadProjectAttachment = vi.fn(),
  createProjectThread = vi.fn(),
  uploadAttachment = vi.fn(),
  models = [],
  readThread = vi.fn(),
  sendQueuedNow = vi.fn(),
  sendReliable = vi.fn(),
  taskDefaults,
  updateThreadSettings = vi.fn(),
  updateThreadDraft = vi.fn(),
  dispatch = vi.fn(),
  queueVoiceRecording = vi.fn(),
}: {
  readProjectDraft?: ReturnType<typeof vi.fn>;
  updateProjectDraft?: ReturnType<typeof vi.fn>;
  uploadProjectAttachment?: ReturnType<typeof vi.fn>;
  createProjectThread?: ReturnType<typeof vi.fn>;
  uploadAttachment?: ReturnType<typeof vi.fn>;
  models?: ModelOption[];
  readThread?: ReturnType<typeof vi.fn>;
  sendQueuedNow?: ReturnType<typeof vi.fn>;
  sendReliable?: ReturnType<typeof vi.fn>;
  taskDefaults?: {
    model?: string;
    titleModel?: string;
    serviceTier?: string;
    personality?: string;
  };
  updateThreadSettings?: ReturnType<typeof vi.fn>;
  updateThreadDraft?: ReturnType<typeof vi.fn>;
  dispatch?: ReturnType<typeof vi.fn>;
  queueVoiceRecording?: ReturnType<typeof vi.fn>;
}) {
  return {
    api: {
      readProjectDraft,
      updateProjectDraft,
      uploadProjectAttachment,
      createProjectThread,
      uploadAttachment,
      readThread,
      sendQueuedNow,
      settings: connectionSettings,
      transcribe: vi.fn(),
      updateThreadDraft,
      updateThreadSettings,
    },
    dispatch,
    sendReliable,
    queueVoiceRecording,
    state: {
      details: {},
      snapshot: { connection: { state: "ready" }, models, taskDefaults, threads: [] },
      network: "connected",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const voiceConfig = {
  providers: ["local"],
  provider: "local",
  maxRecordingSeconds: 300,
  maxUploadBytes: 24 * 1024 * 1024,
} as TranscriptionConfigResponse;

function installRecorder() {
  const start = vi.fn();
  const stop = vi.fn();
  class Recorder extends EventTarget {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    constructor(
      _stream: MediaStream,
      readonly options: MediaRecorderOptions,
    ) {
      super();
    }
    start() {
      this.state = "recording";
      start();
    }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      stop();
      const event = new Event("dataavailable");
      Object.defineProperty(event, "data", {
        value: new Blob(["voice"], { type: this.options.mimeType }),
      });
      this.dispatchEvent(event);
      this.dispatchEvent(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop() {} }] }));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  return { start, stop, getUserMedia };
}
