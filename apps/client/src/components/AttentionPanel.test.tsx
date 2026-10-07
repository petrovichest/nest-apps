import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AttentionRequest,
  VoiceTranscriptionJob,
  TranscriptionConfigResponse,
} from "@codexnest/protocol";

import { AttentionPanel } from "./AttentionPanel";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

afterEach(() => vi.unstubAllGlobals());

describe("AttentionPanel", () => {
  it.each([false, true])(
    "records several questions and submits (without secure crypto: %s)",
    async (withoutSecureCrypto) => {
      if (withoutSecureCrypto) vi.stubGlobal("crypto", {});
      installMediaRecorder(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
      const request = {
        ...freeformRequest(),
        draftKey: "a".repeat(64),
        clientMessageId: `user-input:${"b".repeat(64)}`,
        questions: [
          freeformRequest().questions[0]!,
          {
            ...freeformRequest().questions[0]!,
            id: "second",
            header: "Отправка",
            question: "Когда отправлять?",
          },
        ],
      };
      const pending: Array<Record<string, unknown>> = [];
      const sendReliable = vi.fn(() => new Promise(() => undefined));
      const queueVoiceRecording = vi.fn((recording) => {
        pending.push({ ...recording, createdAt: Date.now(), lastError: null });
        return new Promise<void>(() => undefined);
      });
      connection.mockReturnValue({
        api: { transcribe: vi.fn() },
        queueVoiceRecording,
        sendReliable,
        pendingQuestionRecordings: pending,
      });
      render(
        <AttentionPanel
          requests={[request]}
          transcriptionConfig={transcriptionConfig}
          transcriptionProvider="local"
        />,
      );
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Написанный ответ" } });
      fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Остановить запись" })).toBeEnabled(),
      );
      expect(screen.getByRole("button", { name: "Далее" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Остановить запись" }));
      await waitFor(() => expect(queueVoiceRecording).toHaveBeenCalledOnce());
      expect(screen.getByRole("button", { name: "Далее" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Далее" }));
      fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Остановить запись" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Остановить запись" }));
      await waitFor(() => expect(queueVoiceRecording).toHaveBeenCalledTimes(2));
      expect(queueVoiceRecording.mock.calls[0]?.[0].id).toEqual(expect.any(String));
      expect(queueVoiceRecording.mock.calls[1]?.[0].id).not.toBe(
        queueVoiceRecording.mock.calls[0]?.[0].id,
      );
      expect(queueVoiceRecording.mock.calls.map(([recording]) => recording.userInput)).toEqual([
        { draftKey: request.draftKey, questionId: "details", order: 1 },
        { draftKey: request.draftKey, questionId: "second", order: 1 },
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Назад" }));
      expect(screen.getByRole("textbox")).toHaveValue("Написанный ответ");
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Исправленный ответ" } });
      fireEvent.click(screen.getByRole("button", { name: "Далее" }));
      fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));
      await waitFor(() => expect(sendReliable).toHaveBeenCalledOnce());
      expect(sendReliable.mock.calls[0]).toEqual([
        "thread",
        expect.objectContaining({
          clientMessageId: request.clientMessageId,
          userInputSubmission: {
            draftKey: request.draftKey,
            draft: expect.objectContaining({ answers: { details: ["Исправленный ответ"] } }),
            recordingIds: pending.map((recording) => recording.id),
          },
        }),
      ]);
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByText("Что учесть?")).toBeInTheDocument();
      expect(screen.getByText("Когда отправлять?")).toBeInTheDocument();
      expect(screen.getAllByText("Запись 1")).toHaveLength(2);
    },
  );

  it("retries question answers with the server ID without secure crypto", async () => {
    vi.stubGlobal("crypto", {});
    const request = {
      ...freeformRequest(),
      clientMessageId: `user-input:${"b".repeat(64)}`,
    };
    const sendReliable = vi
      .fn()
      .mockRejectedValueOnce(new Error("Соединение потеряно"))
      .mockResolvedValueOnce("delivered");
    connection.mockReturnValue({ api: {}, sendReliable });
    render(<AttentionPanel requests={[request]} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ответ" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));
    expect(await screen.findByText("Соединение потеряно")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));

    await waitFor(() => expect(sendReliable).toHaveBeenCalledTimes(2));
    for (const call of sendReliable.mock.calls) {
      expect(call).toEqual([
        "thread",
        expect.objectContaining({
          clientMessageId: request.clientMessageId,
          replyToUserInput: {
            turnId: "turn",
            itemId: "item",
            answers: { details: ["Ответ"] },
          },
        }),
        expect.any(Function),
      ]);
    }
  });

  it("shows each completed transcript under its recording and keeps questions visible", () => {
    const job: VoiceTranscriptionJob = {
      id: "clip",
      threadId: "thread",
      mode: "draft",
      userInput: { draftKey: "a".repeat(64), questionId: "details", order: 1 },
      status: "completed",
      transcript: "Распознанный текст",
      createdAt: 1,
      startedAt: 2,
      audioDurationMs: 1000,
      estimatedTotalSeconds: 1,
      error: null,
    };
    const request: Extract<AttentionRequest, { kind: "userInput" }> = {
      ...freeformRequest(),
      draftKey: job.userInput!.draftKey,
      draft: {
        answers: { details: ["Распознанный текст"] },
        currentQuestionId: "details",
        revision: 2,
        updatedAt: 2,
        appliedRecordingIds: [job.id],
        recordings: [job],
        submission: { recordingIds: [job.id], clientMessageId: "reply", status: "waiting" },
      },
    };
    connection.mockReturnValue({ api: {} });
    render(<AttentionPanel requests={[request]} />);
    expect(screen.getByText("Что учесть?")).toBeInTheDocument();
    expect(screen.getByText("Запись 1")).toBeInTheDocument();
    expect(screen.getByText("Распознанный текст")).toBeInTheDocument();
    expect(screen.queryByText("Ваш ответ")).not.toBeInTheDocument();
    expect(screen.queryByText("Готово")).not.toBeInTheDocument();
  });

  it.each([undefined, true, false])(
    "keeps countdowns only for blocking requests (%s)",
    (isBlocking) => {
      connection.mockReturnValue({ api: { respond: vi.fn() } });
      render(
        <AttentionPanel
          requests={[
            {
              ...multiQuestionRequest(),
              isBlocking,
              createdAt: Date.now(),
              autoResolutionMs: 60_000,
            },
          ]}
        />,
      );
      if (isBlocking === false) {
        expect(screen.queryByText(/Автовыбор через/)).not.toBeInTheDocument();
        expect(screen.getByText("Можно ответить, пока Codex работает")).toBeInTheDocument();
      } else {
        expect(screen.getByText(/Автовыбор через/)).toBeInTheDocument();
        expect(screen.getByText("Требуется внимание")).toBeInTheDocument();
      }
    },
  );

  it("responds to approvals through the existing API", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    connection.mockReturnValue({ api: { respond } });
    render(
      <AttentionPanel
        requests={[
          {
            id: "attention",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "commandApproval",
            command: "npm test",
            cwd: "/work",
            reason: "Нужно проверить изменения",
            networkHost: null,
            canAcceptForSession: true,
            proposedPolicyChanges: [],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Разрешить один раз" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("attention", {
        kind: "approval",
        decision: "accept",
      }),
    );
  });

  it("shows user-input questions one at a time and submits all answers at the end", async () => {
    const sendReliable = vi.fn().mockResolvedValue("pending");
    connection.mockReturnValue({ api: { respond: vi.fn() }, sendReliable });
    render(
      <AttentionPanel
        requests={[
          {
            id: "questions",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "userInput",
            autoResolutionMs: null,
            questions: [
              {
                id: "storage",
                header: "Хранение",
                question: "Где хранить вложения?",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "На сервере", description: "Единое хранилище." },
                  { label: "В проекте", description: "Только локальные файлы." },
                ],
              },
              {
                id: "source",
                header: "Источники",
                question: "Как выбирать изображение?",
                isOther: false,
                isSecret: false,
                options: [
                  { label: "Камера", description: "Сделать новый снимок." },
                  { label: "Галерея", description: "Выбрать готовый файл." },
                ],
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Вопрос 1 из 2")).toBeInTheDocument();
    expect(screen.getByText("Где хранить вложения?")).toBeInTheDocument();
    expect(screen.queryByText("Как выбирать изображение?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Далее" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Вопрос 1 из 2: Хранение/ })).toHaveAttribute(
      "aria-current",
      "step",
    );

    fireEvent.click(screen.getByRole("radio", { name: /На сервере/ }));
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));

    expect(screen.getByText("Вопрос 2 из 2")).toBeInTheDocument();
    expect(screen.queryByText("Где хранить вложения?")).not.toBeInTheDocument();
    expect(screen.getByText("Как выбирать изображение?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить ответы" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Назад" })).toBeEnabled();
    expect(sendReliable).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: /Галерея/ }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));

    await waitFor(() =>
      expect(sendReliable).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          clientMessageId: expect.stringMatching(/^user-input:[a-f0-9]{64}$/u),
          replyToUserInput: {
            turnId: "turn",
            itemId: "item",
            answers: { storage: ["На сервере"], source: ["Галерея"] },
          },
        }),
        expect.any(Function),
      ),
    );
  });

  it("supports direct unanswered navigation, clearing, and an empty final submit", async () => {
    const sendReliable = vi.fn().mockResolvedValue("pending");
    const updateUserInputDraft = vi.fn();
    connection.mockReturnValue({
      api: { respond: vi.fn() },
      sendReliable,
      updateUserInputDraft,
      clearUserInputDraft: vi.fn(),
    });
    render(<AttentionPanel requests={[multiQuestionRequest()]} />);

    fireEvent.click(screen.getByRole("button", { name: /Вопрос 3 из 3: Итог/ }));
    expect(screen.getByText("Что отправить?")).toBeInTheDocument();
    expect(updateUserInputDraft).toHaveBeenLastCalledWith(
      "questions",
      { answers: {}, currentQuestionId: "final" },
      "immediate",
    );

    fireEvent.click(screen.getByRole("button", { name: /Вопрос 1 из 3: Режим/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Быстро/ }));
    expect(screen.getByRole("button", { name: "Очистить ответ" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Очистить ответ" }));
    expect(screen.queryByRole("button", { name: "Очистить ответ" })).toBeNull();
    expect(updateUserInputDraft).toHaveBeenLastCalledWith(
      "questions",
      { answers: {}, currentQuestionId: "mode" },
      "immediate",
    );
    fireEvent.click(screen.getByRole("button", { name: /Вопрос 2 из 3: Детали/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Свой ответ" }), {
      target: { value: "   " },
    });
    expect(screen.queryByRole("button", { name: "Очистить ответ" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Вопрос 3 из 3: Итог/ }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));
    await waitFor(() =>
      expect(sendReliable).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          clientMessageId: expect.stringMatching(/^user-input:[a-f0-9]{64}$/u),
          replyToUserInput: { turnId: "turn", itemId: "item", answers: {} },
        }),
        expect.any(Function),
      ),
    );
  });

  it("debounces freeform persistence mode and blocks navigation while speech is requesting", async () => {
    installMediaRecorder(() => new Promise<MediaStream>(() => undefined));
    const updateUserInputDraft = vi.fn();
    connection.mockReturnValue({
      api: { respond: vi.fn(), transcribe: vi.fn() },
      updateUserInputDraft,
    });
    render(
      <AttentionPanel
        requests={[multiQuestionRequest()]}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Вопрос 2 из 3: Детали/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Свой ответ" }), {
      target: { value: "Текст" },
    });
    expect(updateUserInputDraft).toHaveBeenLastCalledWith(
      "questions",
      { answers: { details: ["Текст"] }, currentQuestionId: "details" },
      "debounced",
    );

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    expect(screen.getByRole("button", { name: "Назад" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Далее" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Очистить ответ" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Вопрос 1 из 3/ })).toBeDisabled();
  });

  it("replaces clean answers and jumps when a newer provider draft arrives", async () => {
    const request = multiQuestionRequest();
    const providerDraft = (answers: Record<string, string[]>, currentQuestionId: string) => ({
      answers,
      currentQuestionId,
      serverRevision: 1,
      localVersion: 0,
      savedVersion: 0,
      saving: false,
      error: null,
    });
    connection.mockReturnValue({
      api: { respond: vi.fn() },
      state: { userInputDrafts: { questions: providerDraft({ mode: ["Быстро"] }, "mode") } },
    });
    const view = render(<AttentionPanel requests={[request]} />);
    expect(screen.getByText("Как работать?")).toBeInTheDocument();

    connection.mockReturnValue({
      api: { respond: vi.fn() },
      state: { userInputDrafts: { questions: providerDraft({ final: ["Всё"] }, "final") } },
    });
    view.rerender(<AttentionPanel requests={[request]} />);
    expect(await screen.findByText("Что отправить?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Всё/ })).toBeChecked();
    expect(screen.getByRole("button", { name: /Вопрос 1 из 3/ })).not.toHaveClass("answered");
  });

  it("records a freeform answer, inserts the transcript at the cursor, and waits for submit", async () => {
    const track = { stop: vi.fn() };
    installMediaRecorder(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
    const sendReliable = vi.fn().mockResolvedValue("pending");
    const updatedTimingEstimate = {
      sampleCount: 6,
      estimatedFixedProcessingMs: 1_500,
      estimatedProcessingMsPerAudioSecond: 3_000,
    };
    let resolveTranscription:
      | ((response: { text: string; timingEstimate: typeof updatedTimingEstimate }) => void)
      | undefined;
    const transcribe = vi.fn(
      () =>
        new Promise<{ text: string; timingEstimate: typeof updatedTimingEstimate }>((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    const timingChanged = vi.fn();
    connection.mockReturnValue({ sendReliable, api: { transcribe } });
    render(
      <AttentionPanel
        requests={[
          {
            id: "questions",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "userInput",
            autoResolutionMs: null,
            questions: [
              {
                id: "details",
                header: "Детали",
                question: "Что учесть?",
                isOther: true,
                isSecret: false,
                options: [{ label: "Ничего", description: "Оставить как есть." }],
              },
            ],
          },
        ]}
        transcriptionConfig={{
          ...transcriptionConfig,
          timingEstimate: {
            sampleCount: 5,
            estimatedFixedProcessingMs: 2_000,
            estimatedProcessingMsPerAudioSecond: 0,
          },
        }}
        transcriptionProvider="local"
        onTranscriptionTimingEstimateChange={timingChanged}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Свой ответ" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Начало конец" } });
    input.focus();
    input.setSelectionRange(7, 7);
    fireEvent.select(input);

    const start = screen.getByRole("button", { name: "Начать запись" });
    fireEvent.pointerDown(start);
    fireEvent.click(start);
    const stop = await screen.findByRole("button", { name: "Остановить запись" });
    expect(input).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Отправить ответы" })).toBeDisabled();

    fireEvent.click(stop);
    expect(await screen.findByRole("button", { name: "Распознаём запись" })).toHaveTextContent(
      "≈2",
    );
    await act(async () =>
      resolveTranscription?.({
        text: "голос",
        timingEstimate: updatedTimingEstimate,
      }),
    );
    await waitFor(() => expect(input).toHaveValue("Начало голос конец"));
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audio/webm;codecs=opus" }),
      expect.any(Number),
    );
    expect(sendReliable).not.toHaveBeenCalled();
    expect(timingChanged).toHaveBeenCalledWith(updatedTimingEstimate);
    expect(track.stop).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Отправить ответы" }));
    await waitFor(() =>
      expect(sendReliable).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({
          clientMessageId: expect.stringMatching(/^user-input:[a-f0-9]{64}$/u),
          replyToUserInput: {
            turnId: "turn",
            itemId: "item",
            answers: { details: ["Начало голос конец"] },
          },
        }),
        expect.any(Function),
      ),
    );
  });

  it("offers voice only for freeform answers, including secret questions", () => {
    installMediaRecorder(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    const respond = vi.fn().mockResolvedValue(undefined);
    connection.mockReturnValue({ api: { respond, transcribe: vi.fn() } });
    render(
      <AttentionPanel
        requests={[
          {
            id: "questions",
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            createdAt: 1,
            kind: "userInput",
            autoResolutionMs: null,
            questions: [
              {
                id: "choice",
                header: "Режим",
                question: "Какой режим?",
                isOther: false,
                isSecret: false,
                options: [{ label: "Обычный", description: "Без дополнений." }],
              },
              {
                id: "token",
                header: "Токен",
                question: "Какой токен?",
                isOther: true,
                isSecret: true,
                options: null,
              },
            ],
          },
        ]}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />,
    );

    expect(screen.queryByRole("button", { name: "Начать запись" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Обычный/ }));
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));

    const secret = screen.getByLabelText("Свой ответ");
    expect(secret).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeInTheDocument();
  });

  it.each([true, false])(
    "uses seconds for question recording and transcription (estimate: %s)",
    async (estimated) => {
      vi.useFakeTimers();
      const track = { stop: vi.fn() };
      installMediaRecorder(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
      const transcribe = vi.fn(() => new Promise(() => undefined));
      connection.mockReturnValue({ api: { respond: vi.fn(), transcribe } });
      const view = render(
        <AttentionPanel
          requests={[freeformRequest()]}
          transcriptionConfig={{
            ...transcriptionConfig,
            timingEstimate: estimated
              ? {
                  sampleCount: 1,
                  estimatedFixedProcessingMs: 8000,
                  estimatedProcessingMsPerAudioSecond: 0,
                }
              : {
                  sampleCount: 0,
                  estimatedFixedProcessingMs: null,
                  estimatedProcessingMsPerAudioSecond: null,
                },
          }}
          transcriptionProvider="local"
        />,
      );
      try {
        const input = screen.getByRole("textbox", { name: "Свой ответ" });
        fireEvent.change(input, { target: { value: "Сохранить ответ" } });
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: "Начать запись" })),
        );
        const recording = screen.getByRole("button", { name: "Остановить запись" });
        let elapsed = 0;
        for (const seconds of [5, 59, 60, 99, 100, 125]) {
          await act(async () => vi.advanceTimersByTime((seconds - elapsed) * 1000));
          expect(recording).toHaveTextContent(new RegExp(`^${seconds}$`));
          elapsed = seconds;
        }
        fireEvent.click(recording);
        const processing = screen.getByRole("button", { name: "Распознаём запись" });
        expect(processing).toHaveTextContent(estimated ? /^≈8$/ : /^0$/);
        await act(async () => vi.advanceTimersByTime(11000));
        expect(processing).toHaveTextContent(estimated ? /^\+3$/ : /^11$/);
        expect(input).toHaveValue("Сохранить ответ");
        expect(track.stop).toHaveBeenCalledOnce();
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    },
  );

  it("cancels an active answer recording without changing the answer", async () => {
    const track = { stop: vi.fn() };
    installMediaRecorder(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
    const transcribe = vi.fn();
    connection.mockReturnValue({
      api: { respond: vi.fn().mockResolvedValue(undefined), transcribe },
    });
    render(
      <AttentionPanel
        requests={[freeformRequest()]}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />,
    );
    const input = screen.getByRole("textbox", { name: "Свой ответ" });
    fireEvent.change(input, { target: { value: "Не менять" } });

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    await screen.findByRole("button", { name: "Остановить запись" });
    fireEvent.click(screen.getByRole("button", { name: "Отменить запись" }));

    await screen.findByRole("button", { name: "Начать запись" });
    expect(input).toHaveValue("Не менять");
    expect(transcribe).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("preserves the answer and recovers after transcription errors", async () => {
    installMediaRecorder(
      async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
    );
    connection.mockReturnValue({
      api: {
        respond: vi.fn().mockResolvedValue(undefined),
        transcribe: vi.fn().mockRejectedValue(new Error("STT недоступен")),
      },
    });
    render(
      <AttentionPanel
        requests={[freeformRequest()]}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />,
    );
    const input = screen.getByRole("textbox", { name: "Свой ответ" });
    fireEvent.change(input, { target: { value: "Сохранить" } });

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    fireEvent.click(await screen.findByRole("button", { name: "Остановить запись" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("STT недоступен");
    expect(input).toHaveValue("Сохранить");
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
  });

  it("disables voice when STT is not configured and releases the microphone on unmount", async () => {
    connection.mockReturnValue({
      api: { respond: vi.fn().mockResolvedValue(undefined), transcribe: vi.fn() },
    });
    const disabled = render(
      <AttentionPanel
        requests={[freeformRequest()]}
        transcriptionConfig={{ ...transcriptionConfig, providers: [], provider: null }}
      />,
    );
    expect(screen.getByRole("button", { name: "Распознавание речи не настроено" })).toBeDisabled();
    disabled.unmount();

    const track = { stop: vi.fn() };
    installMediaRecorder(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
    const active = render(
      <AttentionPanel
        requests={[freeformRequest()]}
        transcriptionConfig={transcriptionConfig}
        transcriptionProvider="local"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    await screen.findByRole("button", { name: "Остановить запись" });
    active.unmount();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});

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
    sampleCount: 0,
    estimatedFixedProcessingMs: null,
    estimatedProcessingMsPerAudioSecond: null,
  },
};

function freeformRequest() {
  return {
    id: "questions",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    createdAt: 1,
    kind: "userInput" as const,
    autoResolutionMs: null,
    questions: [
      {
        id: "details",
        header: "Детали",
        question: "Что учесть?",
        isOther: true,
        isSecret: false,
        options: null,
      },
    ],
  };
}

function multiQuestionRequest() {
  return {
    id: "questions",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    createdAt: 1,
    kind: "userInput" as const,
    autoResolutionMs: null,
    questions: [
      {
        id: "mode",
        header: "Режим",
        question: "Как работать?",
        isOther: false,
        isSecret: false,
        options: [{ label: "Быстро", description: "Без задержек." }],
      },
      {
        id: "details",
        header: "Детали",
        question: "Что учесть?",
        isOther: true,
        isSecret: false,
        options: null,
      },
      {
        id: "final",
        header: "Итог",
        question: "Что отправить?",
        isOther: false,
        isSecret: false,
        options: [{ label: "Всё", description: "Отправить всё." }],
      },
    ],
  };
}

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
