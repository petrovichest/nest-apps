import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Project,
  SessionSettings,
  TranscriptionConfigResponse,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import {
  Composer,
  type ComposerImage,
  type ComposerSubmitIntent,
  type ComposerTranscriptionStatus,
} from "./Composer";

const connection = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));

const models = [
  {
    id: "gpt-sol",
    displayName: "GPT-5.6-Sol",
    description: "",
    isDefault: true,
    reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
    serviceTiers: [],
    supportsPersonality: true,
  },
  {
    id: "gpt-terra",
    displayName: "GPT-5.6-Terra",
    description: "",
    isDefault: false,
    reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
    serviceTiers: [],
    supportsPersonality: true,
  },
  {
    id: "other",
    displayName: "Other Model",
    description: "",
    isDefault: false,
    reasoningEfforts: [{ value: "high", description: null, isDefault: true }],
    serviceTiers: [],
    supportsPersonality: true,
  },
];

const projects: Project[] = [
  {
    id: "one",
    displayName: "Первый",
    path: "/work/one",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
  {
    id: "two",
    displayName: "Второй",
    path: "/work/two",
    createdAt: "2026-01-02",
    updatedAt: "2026-01-02",
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

beforeEach(() => {
  connection.mockReset();
  connection.mockReturnValue({
    api: {
      listSkills: vi.fn().mockResolvedValue({
        cwd: "/work/project",
        skills: [
          {
            name: "review",
            displayName: "Review",
            description: "Review the current changes",
            shortDescription: null,
            path: "/skills/review/SKILL.md",
            scope: "user",
            enabled: true,
          },
          {
            name: "docs",
            displayName: "Docs",
            description: "Write documentation",
            shortDescription: null,
            path: "/skills/docs/SKILL.md",
            scope: "repo",
            enabled: true,
          },
          {
            name: "disabled",
            displayName: "Disabled",
            description: "Not available",
            shortDescription: null,
            path: "/skills/disabled/SKILL.md",
            scope: "system",
            enabled: false,
          },
        ],
        errors: [],
      }),
    },
  });
});

describe("Composer", () => {
  it("places the caret at the end on opening and after a delayed draft or session change", () => {
    const view = render(<Harness autoFocus input="Черновик" sessionIdentity="one" />);
    const textarea = screen.getByRole("textbox", {
      name: "Сообщение для Codex",
    }) as HTMLTextAreaElement;
    const expectEnd = () => {
      expect(textarea).toHaveFocus();
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([
        textarea.value.length,
        textarea.value.length,
      ]);
    };
    expectEnd();
    view.rerender(<Harness autoFocus input="Поздний\nчерновик" sessionIdentity="one" />);
    expectEnd();
    fireEvent.keyDown(textarea, { key: "Home" });
    textarea.setSelectionRange(0, 0);
    view.rerender(<Harness autoFocus input="Поздний\nчерновик" sessionIdentity="two" />);
    expectEnd();
    view.rerender(<Harness autoFocus input="" sessionIdentity="three" />);
    expectEnd();
  });

  it.each(["keyboard", "pointer", "typing"])(
    "preserves a manually chosen caret after %s interaction and draft synchronization",
    (interaction) => {
      const props = { autoFocus: true, input: "Редактируемый текст", sessionIdentity: "one" };
      const view = render(<Harness {...props} />);
      const textarea = screen.getByRole("textbox", {
        name: "Сообщение для Codex",
      }) as HTMLTextAreaElement;
      if (interaction === "keyboard") fireEvent.keyDown(textarea, { key: "ArrowLeft" });
      if (interaction === "pointer") fireEvent.pointerDown(textarea);
      if (interaction === "typing")
        fireEvent.change(textarea, { target: { value: "Изменённый текст" } });
      textarea.setSelectionRange(2, 5);
      view.rerender(
        <Harness {...props} input={textarea.value} inputSyncRevision={1} hasSupplementalContent />,
      );
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 5]);
    },
  );

  it("restores an explicit fork selection after its draft arrives, until editing starts", () => {
    const props = { autoFocus: true, initialSelection: { start: 3, end: 8 } };
    const view = render(<Harness {...props} input="" />);
    const textarea = screen.getByRole("textbox", {
      name: "Сообщение для Codex",
    }) as HTMLTextAreaElement;
    view.rerender(<Harness {...props} input="Черновик ответвления" />);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 8]);
    fireEvent.keyDown(textarea, { key: "ArrowRight" });
    textarea.setSelectionRange(10, 10);
    view.rerender(<Harness {...props} input="Черновик ответвления" inputSyncRevision={1} />);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([10, 10]);
  });

  it("keeps the draft editable but disables send and recording until direct input is available", () => {
    installMediaRecorder(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    const onSubmit = vi.fn();
    const props = {
      input: "Черновик",
      onInput: vi.fn(),
      transcriptionConfig,
      transcriptionProvider: transcriptionConfig.provider,
      onRecordingReady: vi.fn(),
      images: [],
      onImagesChange: vi.fn(),
      onSubmit,
      busy: false,
      settings: { collaborationMode: "default" as const, model: "chosen", reasoningEffort: "low" },
      onSettingsChange: vi.fn(),
      models,
      error: null,
      codexSettings: { model: "native", reasoningEffort: "high" },
    };
    const view = render(<Composer {...props} inputUnavailable />);
    const textbox = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    expect(textbox).toBeEnabled();
    expect(textbox).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeDisabled();
    fireEvent.change(textbox, { target: { value: "Исправленный черновик" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    expect(screen.getByText("В Codex: native · high")).toBeInTheDocument();
    view.rerender(<Composer {...props} inputUnavailable={false} />);
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
    expect(textbox).toHaveValue("Исправленный черновик");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
    view.rerender(
      <Composer {...props} codexSettings={{ model: "chosen", reasoningEffort: "low" }} />,
    );
    expect(screen.queryByText(/^В Codex:/)).not.toBeInTheDocument();
    expect(textbox).toHaveValue("Исправленный черновик");
  });
  it("opens filtered skill suggestions for a dollar token and inserts with Enter", async () => {
    const api = connection().api;
    const onInput = vi.fn();
    render(<Harness cwd="/work/project" input="" onInput={onInput} />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    expect(screen.queryByRole("listbox", { name: "Доступные скиллы" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Скиллы" })).toBeNull();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "$rev" } });

    await waitFor(() => expect(api.listSkills).toHaveBeenCalledWith("/work/project", false));
    const list = await screen.findByRole("listbox", { name: "Доступные скиллы" });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    expect(within(list).getByRole("option")).toHaveTextContent("$review");

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea).toHaveValue("$review "));
    expect(onInput.mock.calls).toEqual([["$rev"], ["$review "]]);
    expect(screen.queryByRole("listbox", { name: "Доступные скиллы" })).toBeNull();
  });

  it("owns local typing until the parent supplies a new draft or requests synchronization", () => {
    const onInput = vi.fn();
    const view = render(
      <Harness input="Сохранено" inputSyncRevision={0} onInput={onInput} sessionIdentity="one" />,
    );
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.change(textarea, { target: { value: "Локальный текст" } });
    expect(textarea).toHaveValue("Локальный текст");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
    expect(onInput).toHaveBeenCalledOnce();
    expect(onInput).toHaveBeenCalledWith("Локальный текст");

    view.rerender(
      <Harness input="Сохранено" onInput={onInput} sessionIdentity="one" hasSupplementalContent />,
    );
    expect(textarea).toHaveValue("Локальный текст");

    view.rerender(
      <Harness input="Сохранено" inputSyncRevision={1} onInput={onInput} sessionIdentity="one" />,
    );
    expect(textarea).toHaveValue("Сохранено");

    fireEvent.change(textarea, { target: { value: "Ещё один локальный текст" } });
    view.rerender(
      <Harness
        input="Сохранено"
        inputSyncRevision={1}
        onInput={onInput}
        sessionIdentity="one"
        hasSupplementalContent
      />,
    );
    expect(textarea).toHaveValue("Ещё один локальный текст");

    view.rerender(
      <Harness input="" inputSyncRevision={2} onInput={onInput} sessionIdentity="one" />,
    );
    expect(textarea).toHaveValue("");
    view.rerender(<Harness input="Восстановлено" onInput={onInput} sessionIdentity="one" />);
    expect(textarea).toHaveValue("Восстановлено");

    fireEvent.change(textarea, { target: { value: "Черновик первой сессии" } });
    view.rerender(<Harness input="Восстановлено" onInput={onInput} sessionIdentity="two" />);
    expect(textarea).toHaveValue("Восстановлено");
    view.rerender(<Harness input="Черновик второй сессии" sessionIdentity="two" />);
    expect(textarea).toHaveValue("Черновик второй сессии");
  });

  it("flushes the parent draft callback when the textarea blurs", () => {
    const onDraftFlush = vi.fn();
    render(<Harness onDraftFlush={onDraftFlush} />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.focus(textarea);
    fireEvent.blur(textarea);

    expect(onDraftFlush).toHaveBeenCalledOnce();
  });

  it("replaces only the active skill token and preserves following punctuation", async () => {
    render(<Harness cwd="/work/project" initialInput="$rev, дальше" />);
    const textarea = screen.getByRole("textbox", {
      name: "Сообщение для Codex",
    }) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(4, 4);
    fireEvent.select(textarea);

    const list = await screen.findByRole("listbox", { name: "Доступные скиллы" });
    fireEvent.pointerDown(within(list).getByRole("option"));
    fireEvent.click(within(list).getByRole("option"));

    await waitFor(() => expect(textarea).toHaveValue("$review, дальше"));
    expect(textarea.selectionStart).toBe(7);
    expect(screen.queryByRole("listbox", { name: "Доступные скиллы" })).toBeNull();
  });

  it("supports keyboard navigation and ignores dollar signs inside words", async () => {
    render(<Harness cwd="/work/project" />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "price$docs" } });
    expect(screen.queryByRole("listbox", { name: "Доступные скиллы" })).toBeNull();

    fireEvent.change(textarea, { target: { value: "$" } });
    const list = await screen.findByRole("listbox", { name: "Доступные скиллы" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    await waitFor(() =>
      expect(within(list).getByRole("option", { selected: true })).toHaveTextContent("$review"),
    );
    fireEvent.keyDown(textarea, { key: "Tab" });
    await waitFor(() => expect(textarea).toHaveValue("$review "));
  });

  it("closes skill suggestions with Escape and reopens after editing", async () => {
    render(<Harness cwd="/work/project" />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "$r" } });
    await screen.findByRole("listbox", { name: "Доступные скиллы" });

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Доступные скиллы" })).toBeNull();
    fireEvent.change(textarea, { target: { value: "$re" } });
    expect(await screen.findByRole("listbox", { name: "Доступные скиллы" })).toBeInTheDocument();
  });

  it("uses queue for form and plain Enter submissions and immediate for modifier Enter", () => {
    const onSubmit = vi.fn<(intent: ComposerSubmitIntent) => void>();
    const onSendQueuedNow = vi.fn();
    const view = render(
      <Harness initialInput="Сообщение" onSubmit={onSubmit} onSendQueuedNow={onSendQueuedNow} />,
    );
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    const form = view.container.querySelector("form")!;

    expect(fireEvent.submit(form)).toBe(false);
    expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(textarea, { key: "Enter", metaKey: true })).toBe(false);
    expect(fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true })).toBe(false);

    expect(onSubmit.mock.calls).toEqual([["queue"], ["queue"], ["immediate"], ["immediate"]]);
    expect(onSendQueuedNow).not.toHaveBeenCalled();
  });

  it("sends a queued message with modifier Enter when the composer is empty", () => {
    const onSubmit = vi.fn<(intent: ComposerSubmitIntent) => void>();
    const onSendQueuedNow = vi.fn();
    render(<Harness onSubmit={onSubmit} onSendQueuedNow={onSendQueuedNow} />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, repeat: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSendQueuedNow).toHaveBeenCalledTimes(2);
  });

  it("keeps Shift+Enter native and ignores composing and repeated submit shortcuts", () => {
    const onSubmit = vi.fn<(intent: ComposerSubmitIntent) => void>();
    render(<Harness initialInput="Сообщение" onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    expect(fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, isComposing: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, repeat: true })).toBe(false);
    expect(fireEvent.keyDown(textarea, { key: "Enter", repeat: true })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("respects canSubmit for textarea and form submissions", () => {
    const onSubmit = vi.fn<(intent: ComposerSubmitIntent) => void>();
    const view = render(<Harness initialInput="Сообщение" busy onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(textarea, { key: "Enter", metaKey: true })).toBe(false);
    expect(fireEvent.submit(view.container.querySelector("form")!)).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["Сообщение", ""])("blocks sending %j while settings are being saved", (input) => {
    const onSubmit = vi.fn();
    const onSendQueuedNow = vi.fn();
    installMediaRecorder(vi.fn());
    const speechProps = { transcriptionConfig, onTranscribe: vi.fn() };
    const view = render(
      <Harness
        {...speechProps}
        input={input}
        settingsBusy
        onSubmit={onSubmit}
        onSendQueuedNow={onSendQueuedNow}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    expect(textarea).toBeEnabled();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeDisabled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    fireEvent.submit(view.container.querySelector("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSendQueuedNow).not.toHaveBeenCalled();

    view.rerender(
      <Harness
        {...speechProps}
        input={input}
        onSubmit={onSubmit}
        onSendQueuedNow={onSendQueuedNow}
      />,
    );
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(input ? onSubmit : onSendQueuedNow).toHaveBeenCalledOnce();
  });

  it("allows messages while settings are read-only", () => {
    const onSubmit = vi.fn();
    const onSettingsChange = vi.fn();
    render(
      <Harness
        initialInput="Сообщение"
        settingsDisabled
        onSubmit={onSubmit}
        onSettingsChange={onSettingsChange}
      />,
    );
    expect(screen.getByRole("button", { name: "Модель и уровень рассуждений" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });
    expect(onSettingsChange).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("queue");
  });

  it("submits modified Enter instead of selecting a skill suggestion", async () => {
    const onSubmit = vi.fn<(intent: ComposerSubmitIntent) => void>();
    render(<Harness cwd="/work/project" onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "$rev" } });
    await screen.findByRole("listbox", { name: "Доступные скиллы" });

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("immediate");
    expect(textarea).toHaveValue("$rev");
  });

  it("toggles Plan with Shift+Tab when its control is eligible", () => {
    const onGoalModeChange = vi.fn();
    const onSettingsChange = vi.fn();
    render(
      <Harness
        goalMode
        initialInput="Сообщение"
        onGoalModeChange={onGoalModeChange}
        onSettingsChange={onSettingsChange}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    expect(fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true })).toBe(false);
    expect(screen.getByRole("button", { name: "Выключить режим планирования" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(onGoalModeChange).toHaveBeenLastCalledWith(false);
    expect(onSettingsChange).toHaveBeenLastCalledWith({ collaborationMode: "plan" });

    expect(fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true })).toBe(false);
    expect(screen.getByRole("button", { name: "Включить режим планирования" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(onSettingsChange).toHaveBeenLastCalledWith({ collaborationMode: "default" });

    expect(fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true, repeat: true })).toBe(false);
    expect(onGoalModeChange).toHaveBeenCalledTimes(2);
    expect(onSettingsChange).toHaveBeenCalledTimes(2);
  });

  it("leaves Shift+Tab focus traversal native when the Plan control is ineligible", () => {
    const onGoalModeChange = vi.fn();
    const onSettingsChange = vi.fn();
    render(
      <Harness
        busy
        initialInput="Сообщение"
        onGoalModeChange={onGoalModeChange}
        onSettingsChange={onSettingsChange}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });

    expect(fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true })).toBe(true);
    expect(onGoalModeChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("opens model and reasoning effort in one popup", () => {
    render(<Harness />);
    const toggle = screen.getByLabelText("Модель и уровень рассуждений");
    expect(toggle).toHaveTextContent("5.6sol");
    expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.queryByRole("dialog", { name: "Настройки модели" })).toBeNull();

    fireEvent.click(toggle);
    const dialog = screen.getByRole("dialog", { name: "Настройки модели" });
    expect(within(dialog).queryByRole("heading", { name: "Настройки модели" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Закрыть" })).toHaveFocus();
    const modelOptions = within(dialog).getByRole("radiogroup", { name: "Модель" });
    const effortOptions = within(dialog).getByRole("radiogroup", {
      name: "Уровень рассуждений",
    });

    expect(within(modelOptions).getAllByRole("radio")).toHaveLength(4);
    expect(within(modelOptions).getByRole("radio", { name: /По умолчанию/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(effortOptions).getByRole("radio", { name: /По умолчанию/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(within(modelOptions).getByRole("radio", { name: "GPT-5.6-Terra" }));
    expect(toggle).toHaveTextContent("5.6terra");
    expect(within(modelOptions).getByRole("radio", { name: "GPT-5.6-Terra" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(within(effortOptions).getByRole("radio", { name: "high" }));
    expect(within(effortOptions).getByRole("radio", { name: "high" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Настройки модели" })).toBeNull();
    expect(toggle).toHaveFocus();

    fireEvent.click(toggle);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Настройки модели" })).getByRole("button", {
        name: "Закрыть",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Настройки модели" })).toBeNull();
    expect(toggle).toHaveFocus();
  });

  it("clears Fast mode when changing to an unsupported model", () => {
    const onSettingsChange = vi.fn();
    render(
      <Harness
        initialSettings={{ collaborationMode: "default", serviceTier: "fast" }}
        onSettingsChange={onSettingsChange}
      />,
    );

    fireEvent.click(screen.getByLabelText("Модель и уровень рассуждений"));
    const modelOptions = within(screen.getByRole("dialog", { name: "Настройки модели" })).getByRole(
      "radiogroup",
      { name: "Модель" },
    );
    fireEvent.click(within(modelOptions).getByRole("radio", { name: "GPT-5.6-Terra" }));

    expect(onSettingsChange).toHaveBeenCalledWith({ model: "gpt-terra", serviceTier: null });
  });

  it("keeps pointer focus in the textarea for direct toolbar and attachment controls", () => {
    const view = render(
      <Harness
        initialInput="Сообщение"
        initialImages={[{ id: "one", name: "one.png", url: "data:image/png;base64,b25l" }]}
      >
        <button type="button">Дочернее действие</button>
      </Harness>,
    );
    const textarea = screen.getByRole("textbox", {
      name: "Сообщение для Codex",
    }) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(4, 4);

    const ownedControls = view.container.querySelectorAll(
      ".composer-toolbar button:not(:disabled), .composer-attachments button:not(:disabled), .composer-toolbar summary",
    );
    expect(ownedControls.length).toBeGreaterThan(0);
    for (const control of ownedControls) {
      expect(fireEvent.pointerDown(control)).toBe(false);
      expect(textarea).toHaveFocus();
      expect(textarea.selectionStart).toBe(4);
    }

    expect(fireEvent.pointerDown(screen.getByRole("button", { name: "Дочернее действие" }))).toBe(
      true,
    );
  });

  it("returns focus after a pointer project selection but preserves keyboard focus", () => {
    render(<Harness projects={projects} initialProjectId="one" />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    const project = screen.getByRole("combobox", { name: "Проект" });

    textarea.focus();
    expect(fireEvent.pointerDown(project)).toBe(true);
    project.focus();
    fireEvent.change(project, { target: { value: "two" } });
    expect(textarea).toHaveFocus();

    project.focus();
    fireEvent.change(project, { target: { value: "one" } });
    expect(project).toHaveFocus();
  });

  it("restores model dialog focus to the pointer or keyboard opener", () => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    const toggle = screen.getByRole("button", { name: "Модель и уровень рассуждений" });

    textarea.focus();
    expect(fireEvent.pointerDown(toggle)).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(textarea).toHaveFocus();

    toggle.focus();
    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle).toHaveFocus();
  });

  it("renders plan, team, and goal as compact mutually exclusive controls", () => {
    const view = render(<Harness />);
    const settings = view.container.querySelector(".settings-picker");
    const plan = screen.getByRole("button", { name: "Включить режим планирования" });
    const team = screen.getByRole("button", { name: "Включить командный режим" });
    const goal = screen.getByRole("button", { name: "Включить режим цели" });

    expect(settings).toBeInTheDocument();
    expect(plan.querySelector("span")).toBeNull();
    expect(plan.querySelectorAll("svg")).toHaveLength(1);
    expect(team.querySelector("span")).toBeNull();
    expect(team.querySelectorAll("svg")).toHaveLength(1);
    expect(goal.querySelector("span")).toBeNull();
    expect(goal.querySelectorAll("svg")).toHaveLength(1);

    fireEvent.click(team);
    expect(screen.getByRole("button", { name: "Выключить командный режим" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(plan);
    expect(screen.getByRole("button", { name: "Выключить режим планирования" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows the microphone without an auto-send toggle", () => {
    installMediaRecorder(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    render(<Harness transcriptionConfig={transcriptionConfig} onRecordingReady={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /автоотправку/ })).not.toBeInTheDocument();
  });

  it("uses native field sizing without scheduling JavaScript measurement", () => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => true) });
    const requestFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    render(<Harness />);
    const textarea = screen.getByRole("textbox", {
      name: "Сообщение для Codex",
    }) as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute("rows", "1");

    const scrollHeight = vi.fn(() => 240);
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: scrollHeight });
    fireEvent.change(textarea, { target: { value: "Длинное\n".repeat(30) } });

    expect(requestFrame).not.toHaveBeenCalled();
    expect(scrollHeight).not.toHaveBeenCalled();
    expect(textarea.style.height).toBe("");
  });

  it("coalesces fallback auto-sizing, reads once, caps height, and cancels stale frames", () => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
    const frames = installAnimationFrames();
    const view = render(<Harness input="" sessionIdentity="one" />);
    const textarea = screen.getByRole("textbox", {
      name: "Сообщение для Codex",
    }) as HTMLTextAreaElement;

    expect(frames.request).toHaveBeenCalledOnce();
    act(() => frames.runNext());

    let measuredHeight = 240;
    const scrollHeight = vi.fn(() => measuredHeight);
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: scrollHeight });
    fireEvent.change(textarea, { target: { value: "Длинное\n".repeat(30) } });
    fireEvent.change(textarea, { target: { value: "Ещё длиннее\n".repeat(30) } });
    expect(frames.request).toHaveBeenCalledTimes(2);
    expect(frames.pending()).toHaveLength(1);
    expect(scrollHeight).not.toHaveBeenCalled();

    act(() => frames.runNext());
    expect(scrollHeight).toHaveBeenCalledOnce();
    expect(textarea).toHaveStyle({ height: "190px", overflowY: "auto" });

    measuredHeight = 40;
    fireEvent.change(textarea, { target: { value: "Короткое" } });
    act(() => frames.runNext());
    expect(scrollHeight).toHaveBeenCalledTimes(2);
    expect(textarea).toHaveStyle({ height: "40px", overflowY: "hidden" });

    fireEvent.change(textarea, { target: { value: "Ожидает замера" } });
    const staleFrame = frames.pending()[0]!;
    view.rerender(<Harness input="" sessionIdentity="two" />);
    expect(frames.cancel).toHaveBeenCalledWith(staleFrame);
    expect(frames.pending()).toHaveLength(1);

    const pendingFrame = frames.pending()[0]!;
    view.unmount();
    expect(frames.cancel).toHaveBeenCalledWith(pendingFrame);
    expect(frames.pending()).toHaveLength(0);
  });

  it("opens draft images as a gallery and keeps their remove buttons visible", async () => {
    const view = render(<Harness />);
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(["one"], "one.png", { type: "image/png" }),
          new File(["two"], "two.jpg", { type: "image/jpeg" }),
        ],
      },
    });

    const first = await screen.findByRole("button", { name: "Открыть изображение one.png" });
    expect(screen.getByRole("button", { name: "Открыть изображение two.jpg" })).toBeInTheDocument();
    const removeFirst = screen.getByRole("button", { name: "Удалить изображение one.png" });
    expect(screen.getByRole("button", { name: "Удалить изображение two.jpg" })).toBeInTheDocument();

    fireEvent.click(first);
    const dialog = screen.getByRole("dialog", { name: "Просмотр изображений" });
    expect(within(dialog).getByAltText("one.png")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Следующее изображение" }));
    expect(within(dialog).getByAltText("two.jpg")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть" }));
    expect(first).toHaveFocus();

    fireEvent.click(removeFirst);

    await waitFor(() => expect(screen.queryByAltText("one.png")).toBeNull());
    expect(screen.getByAltText("two.jpg")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Просмотр изображений" })).toBeNull();
  });

  it("restores attachment viewer focus based on pointer or keyboard activation", () => {
    render(
      <Harness
        initialImages={[{ id: "one", name: "one.png", url: "data:image/png;base64,b25l" }]}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    const preview = screen.getByRole("button", { name: "Открыть изображение one.png" });

    textarea.focus();
    expect(fireEvent.pointerDown(preview)).toBe(false);
    fireEvent.click(preview);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(textarea).toHaveFocus();

    preview.focus();
    fireEvent.click(preview);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(preview).toHaveFocus();
  });

  it("attaches pasted clipboard images without cancelling ordinary paste behavior", async () => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    const png = new File(["clipboard-one"], "", { type: "image/png" });
    const jpeg = new File(["clipboard-two"], "screen.jpg", { type: "image/jpeg" });

    expect(
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [
            { kind: "file", type: "image/png", getAsFile: () => png },
            { kind: "file", type: "image/jpeg", getAsFile: () => jpeg },
          ],
          files: [],
        },
      }),
    ).toBe(true);

    expect(await screen.findByAltText("pasted-image-1.png")).toBeInTheDocument();
    expect(screen.getByAltText("screen.jpg")).toBeInTheDocument();
    expect(
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
          files: [],
        },
      }),
    ).toBe(true);
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("enables sending when annotations provide supplemental content", () => {
    const view = render(<Harness />);
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();

    view.rerender(<Harness hasSupplementalContent />);
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
  });

  it("keeps textarea focus for buttons across the page while the mobile keyboard is open", () => {
    const initialHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const onExternalClick = vi.fn();
    const view = render(
      <>
        <button type="button" onClick={onExternalClick}>
          Внешнее действие
        </button>
        <Harness />
      </>,
    );
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    view.container.querySelector("form")?.addEventListener("submit", onSubmit);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    const external = screen.getByRole("button", { name: "Внешнее действие" });
    const addImage = screen.getByRole("button", { name: "Добавить изображения" });
    const send = screen.getByRole("button", { name: "Отправить" });

    fireEvent.change(textarea, { target: { value: "Сообщение" } });
    textarea.focus();
    expect(fireEvent.pointerDown(external)).toBe(true);

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    fireEvent(window, new Event("resize"));
    expect(fireEvent.pointerDown(external)).toBe(false);
    expect(fireEvent.pointerDown(addImage)).toBe(false);
    expect(fireEvent.pointerDown(send)).toBe(false);
    expect(textarea).toHaveFocus();

    fireEvent.click(external);
    fireEvent.click(send);
    expect(onExternalClick).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: initialHeight });
  });

  it("removes the mobile safe-area gap while the keyboard shrinks the viewport", () => {
    const initialHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const view = render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "Сообщение для Codex" });
    const composer = view.container.querySelector(".composer");

    textarea.focus();
    expect(textarea).toHaveFocus();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    fireEvent(window, new Event("resize"));
    expect(composer).toHaveClass("keyboard-open");

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    fireEvent(window, new Event("resize"));
    expect(composer).not.toHaveClass("keyboard-open");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: initialHeight });
  });

  it("records on the first click and inserts the transcript at the saved cursor", async () => {
    const track = { stop: vi.fn() };
    installMediaRecorder(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
    let resolveTranscription: ((transcript: string) => void) | undefined;
    const onTranscribe = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    const onInput = vi.fn();
    const view = render(
      <Harness
        input="Начало конец"
        onInput={onInput}
        transcriptionConfig={transcriptionConfig}
        onTranscribe={onTranscribe}
      />,
    );
    const textarea = screen.getByRole("textbox", {
      name: "Сообщение для Codex",
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Начало новое конец" } });
    textarea.focus();
    textarea.setSelectionRange(7, 7);
    fireEvent.select(textarea);

    const start = screen.getByRole("button", { name: "Начать запись" });
    fireEvent.pointerDown(start);
    fireEvent.click(start);
    const stop = await screen.findByRole("button", { name: "Остановить запись" });
    expect(within(stop).getByText("0")).toBeInTheDocument();
    expect(stop).toHaveClass("timing");
    expect(textarea).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Отправить" })).toBeNull();
    expect(screen.getByRole("button", { name: "Отменить запись" })).toBeEnabled();
    view.rerender(
      <Harness
        busy
        input="Начало конец"
        onInput={onInput}
        transcriptionConfig={transcriptionConfig}
        onTranscribe={onTranscribe}
      />,
    );
    expect(stop).toBeEnabled();
    expect(textarea).toHaveValue("Начало новое конец");

    fireEvent.click(stop);
    const transcribing = await screen.findByRole("button", { name: "Распознаём запись" });
    expect(within(transcribing).getByText("0")).toBeInTheDocument();
    expect(transcribing).toHaveClass("timing");
    await act(async () => resolveTranscription?.("голос"));
    await waitFor(() => expect(textarea).toHaveValue("Начало голос новое конец"));
    expect(onInput.mock.calls).toEqual([["Начало новое конец"], ["Начало голос новое конец"]]);
    expect(onTranscribe).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audio/webm;codecs=opus" }),
      expect.any(Number),
    );
    expect(track.stop).toHaveBeenCalled();
    expect(textarea).not.toHaveAttribute("readonly");
    view.rerender(
      <Harness
        input="Начало конец"
        onInput={onInput}
        transcriptionConfig={transcriptionConfig}
        onTranscribe={onTranscribe}
      />,
    );
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
    expect(textarea).toHaveValue("Начало голос новое конец");
  });

  it.each(["local", "background"] as const)(
    "discards an active %s recording without transcription or upload",
    async (path) => {
      const track = { stop: vi.fn() };
      installMediaRecorder(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
      const onTranscribe = vi.fn(async () => "не вставлять");
      const onRecordingReady = vi.fn(async () => undefined);
      render(
        <Harness
          initialInput="Не менять"
          transcriptionConfig={transcriptionConfig}
          onTranscribe={path === "local" ? onTranscribe : undefined}
          onRecordingReady={path === "background" ? onRecordingReady : undefined}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
      await screen.findByRole("button", { name: "Остановить запись" });
      expect(screen.queryByRole("button", { name: "Отправить" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Отменить запись" }));

      await screen.findByRole("button", { name: "Начать запись" });
      expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
      expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("Не менять");
      expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).not.toHaveAttribute(
        "readonly",
      );
      expect(onTranscribe).not.toHaveBeenCalled();
      expect(onRecordingReady).not.toHaveBeenCalled();
      expect(track.stop).toHaveBeenCalledOnce();
    },
  );

  it("finalizes an active background recording for its source session on session switch", async () => {
    installMediaRecorder(
      async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
    );
    const sourceReady = vi.fn<NonNullable<Parameters<typeof Composer>[0]["onRecordingReady"]>>(
      async () => undefined,
    );
    const nextReady = vi.fn<NonNullable<Parameters<typeof Composer>[0]["onRecordingReady"]>>(
      async () => undefined,
    );
    const view = render(
      <Harness
        sessionIdentity="source"
        transcriptionConfig={transcriptionConfig}
        onRecordingReady={sourceReady}
        preserveRecordingOnSessionChange
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    await screen.findByRole("button", { name: "Остановить запись" });
    view.rerender(
      <Harness
        sessionIdentity="next"
        transcriptionConfig={transcriptionConfig}
        onRecordingReady={nextReady}
        preserveRecordingOnSessionChange
      />,
    );

    await waitFor(() => expect(sourceReady).toHaveBeenCalledOnce());
    expect(sourceReady.mock.calls[0]?.[0]).toMatchObject({
      id: expect.any(String),
      audio: expect.objectContaining({ type: "audio/webm;codecs=opus" }),
    });
    expect(nextReady).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Начать запись" })).toBeEnabled();
  });

  it("keeps delayed source chunks isolated from a new-session recording", async () => {
    const recorders = installDeferredMediaRecorder();
    const sourceReady = vi.fn<NonNullable<Parameters<typeof Composer>[0]["onRecordingReady"]>>(
      async () => undefined,
    );
    const nextReady = vi.fn<NonNullable<Parameters<typeof Composer>[0]["onRecordingReady"]>>(
      async () => undefined,
    );
    const view = render(
      <Harness
        sessionIdentity="source"
        transcriptionConfig={transcriptionConfig}
        onRecordingReady={sourceReady}
        preserveRecordingOnSessionChange
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    await screen.findByRole("button", { name: "Остановить запись" });
    view.rerender(
      <Harness
        sessionIdentity="next"
        transcriptionConfig={transcriptionConfig}
        onRecordingReady={nextReady}
        preserveRecordingOnSessionChange
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Начать запись" }));
    fireEvent.click(await screen.findByRole("button", { name: "Остановить запись" }));

    await act(async () => recorders[0]!.flush("source-audio"));
    await waitFor(() => expect(sourceReady).toHaveBeenCalledOnce());
    expect(sourceReady.mock.calls[0]![0].audio.size).toBe(12);
    expect(nextReady).not.toHaveBeenCalled();

    await act(async () => recorders[1]!.flush("next-audio"));
    await waitFor(() => expect(nextReady).toHaveBeenCalledOnce());
    expect(nextReady.mock.calls[0]![0].audio.size).toBe(10);
  });

  it("retains a failed background recording and retries it with the same upload id", async () => {
    installMediaRecorder(
      async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
    );
    const onRecordingReady = vi
      .fn<NonNullable<Parameters<typeof Composer>[0]["onRecordingReady"]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    render(
      <Harness transcriptionConfig={transcriptionConfig} onRecordingReady={onRecordingReady} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    fireEvent.click(await screen.findByRole("button", { name: "Остановить запись" }));

    const retry = await screen.findByRole("button", { name: "Повторить" });
    expect(screen.getByText("offline")).toBeInTheDocument();
    const first = onRecordingReady.mock.calls[0]?.[0];
    expect(first?.id).toBeTruthy();

    fireEvent.click(retry);
    await waitFor(() => expect(onRecordingReady).toHaveBeenCalledTimes(2));
    expect(onRecordingReady.mock.calls[1]?.[0]).toBe(first);
    await screen.findByRole("button", { name: "Начать запись" });
  });

  it("keeps the existing text when microphone permission is denied", async () => {
    installMediaRecorder(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    render(
      <Harness
        initialInput="Не менять"
        transcriptionConfig={transcriptionConfig}
        onTranscribe={vi.fn(async () => "текст")}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Начать запись" }));
    expect(await screen.findByText(/Нет доступа к микрофону/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveValue("Не менять");
  });

  it("disables the microphone when the server has no configured provider", () => {
    render(<Harness transcriptionConfig={{ ...transcriptionConfig, providers: [] }} />);
    expect(screen.getByRole("button", { name: "Распознавание речи не настроено" })).toBeDisabled();
  });

  it("shows upload, queue, and learned countdowns in the draft composer", () => {
    const view = render(
      <Harness
        initialInput="Черновик"
        transcriptionConfig={transcriptionConfig}
        transcriptionStatus={{
          elapsedSeconds: 2,
          estimatedTotalSeconds: 10,
        }}
      />,
    );

    expect(
      within(screen.getByRole("button", { name: "Распознаём запись" })).getByText("≈8"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "На сервере · распознаём · осталось ≈ 0:08",
    );
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveAttribute(
      "readonly",
    );

    view.rerender(
      <Harness
        initialInput="Черновик"
        transcriptionConfig={transcriptionConfig}
        transcriptionStatus={{
          elapsedSeconds: 13,
          estimatedTotalSeconds: 10,
        }}
      />,
    );
    expect(
      within(screen.getByRole("button", { name: "Распознаём запись" })).getByText("+3"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "На сервере · распознаём · дольше прогноза на 0:03",
    );

    view.rerender(
      <Harness
        initialInput="Черновик"
        transcriptionConfig={transcriptionConfig}
        transcriptionStatus={{
          elapsedSeconds: 4,
          estimatedTotalSeconds: null,
        }}
      />,
    );
    expect(
      within(screen.getByRole("button", { name: "Распознаём запись" })).getByText("4"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("На сервере · распознаём · прошло 0:04");

    view.rerender(
      <Harness
        initialInput="Черновик"
        transcriptionConfig={transcriptionConfig}
        transcriptionStatus={{
          elapsedSeconds: 4,
          estimatedTotalSeconds: null,
          status: "queued",
        }}
      />,
    );
    expect(
      within(screen.getByRole("button", { name: "Запись на сервере · можно закрыть" })).getByText(
        "4",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("На сервере · ожидание 0:04");

    view.rerender(
      <Harness
        initialInput="Черновик"
        transcriptionConfig={transcriptionConfig}
        voiceInputLocked
      />,
    );
    expect(view.container.querySelector(".microphone")).toBeDisabled();
    expect(view.container.querySelector(".microphone")).not.toHaveClass("timing");
    expect(screen.getByRole("textbox", { name: "Сообщение для Codex" })).toHaveAttribute(
      "readonly",
    );
  });
});

const transcriptionConfig: TranscriptionConfigResponse = {
  providers: ["local", "openai"],
  provider: "local",
  localUrl: "http://127.0.0.1:8178/inference",
  openAiApiKeyConfigured: true,
  openAiModel: "gpt-4o-transcribe",
  language: "ru",
  refineLocal: true,
  refinementModel: "gpt-5.6-luna",
  maxRecordingSeconds: 300,
  maxUploadBytes: 24 * 1024 * 1024,
  timingEstimate: {
    sampleCount: 0,
    estimatedFixedProcessingMs: null,
    estimatedProcessingMsPerAudioSecond: null,
  },
};

function Harness({
  autoFocus = false,
  initialSelection,
  busy = false,
  settingsBusy = false,
  settingsDisabled = false,
  children,
  cwd,
  goalMode = false,
  hasSupplementalContent = false,
  initialImages = [],
  initialInput = "",
  input: controlledInput,
  inputSyncRevision,
  initialProjectId,
  initialSettings = { collaborationMode: "default" },
  onDraftFlush,
  onGoalModeChange,
  onInput,
  onSettingsChange,
  onSubmit = () => undefined,
  onSendQueuedNow,
  projects: projectOptions,
  sessionIdentity,
  transcriptionConfig: speechConfig,
  onTranscribe,
  onRecordingReady,
  preserveRecordingOnSessionChange = false,
  transcriptionStatus = null,
  voiceInputLocked = false,
}: {
  autoFocus?: boolean;
  initialSelection?: { start: number; end: number };
  busy?: boolean;
  settingsBusy?: boolean;
  settingsDisabled?: boolean;
  children?: ReactNode;
  cwd?: string;
  goalMode?: boolean;
  hasSupplementalContent?: boolean;
  initialImages?: ComposerImage[];
  initialInput?: string;
  input?: string;
  inputSyncRevision?: number;
  initialProjectId?: string;
  initialSettings?: SessionSettings;
  onDraftFlush?(): void;
  onGoalModeChange?(value: boolean): void;
  onInput?(value: string): void;
  onSettingsChange?(patch: UpdateThreadSettingsRequest): void;
  onSubmit?(intent: ComposerSubmitIntent): void;
  onSendQueuedNow?(): void;
  projects?: Project[];
  sessionIdentity?: string;
  transcriptionConfig?: TranscriptionConfigResponse;
  onTranscribe?(audio: Blob): Promise<string>;
  onRecordingReady?: Parameters<typeof Composer>[0]["onRecordingReady"];
  preserveRecordingOnSessionChange?: boolean;
  transcriptionStatus?: ComposerTranscriptionStatus | null;
  voiceInputLocked?: boolean;
}) {
  const [input, setInput] = useState(initialInput);
  const [images, setImages] = useState<ComposerImage[]>(initialImages);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [settings, setSettings] = useState<SessionSettings>(initialSettings);
  return (
    <Composer
      autoFocus={autoFocus}
      initialSelection={initialSelection}
      input={controlledInput ?? input}
      onInput={(value) => {
        onInput?.(value);
        if (controlledInput === undefined) setInput(value);
      }}
      onDraftFlush={onDraftFlush}
      inputSyncRevision={inputSyncRevision}
      images={images}
      onImagesChange={setImages}
      onSubmit={onSubmit}
      onSendQueuedNow={onSendQueuedNow}
      busy={busy}
      settingsBusy={settingsBusy}
      settingsDisabled={settingsDisabled}
      cwd={cwd}
      projects={projectOptions}
      projectId={projectId}
      onProjectChange={setProjectId}
      settings={settings}
      onSettingsChange={(patch) => {
        onSettingsChange?.(patch);
        setSettings((current) => {
          const next = { ...current };
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete next[key as keyof SessionSettings];
            else if (value !== undefined) Object.assign(next, { [key]: value });
          }
          return next;
        });
      }}
      goalMode={goalMode}
      onGoalModeChange={onGoalModeChange}
      models={models}
      transcriptionConfig={speechConfig}
      transcriptionProvider={speechConfig?.provider ?? null}
      onTranscribe={onTranscribe}
      onRecordingReady={onRecordingReady}
      preserveRecordingOnSessionChange={preserveRecordingOnSessionChange}
      voiceInputLocked={voiceInputLocked}
      transcriptionStatus={transcriptionStatus}
      sessionIdentity={sessionIdentity}
      error={null}
      hasSupplementalContent={hasSupplementalContent}
    >
      {children}
    </Composer>
  );
}

function installAnimationFrames() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => callbacks.delete(id));
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  return {
    request,
    cancel,
    pending: () => [...callbacks.keys()],
    runNext: () => {
      const next = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!next) throw new Error("No animation frame is pending");
      callbacks.delete(next[0]);
      next[1](0);
    },
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

function installDeferredMediaRecorder() {
  class DeferredMediaRecorder extends EventTarget {
    static isTypeSupported = vi.fn(() => true);
    readonly mimeType: string;
    state: RecordingState = "inactive";

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      super();
      this.mimeType = options?.mimeType ?? "audio/webm";
      instances.push(this);
    }

    start() {
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";
    }

    async flush(value: string) {
      const data = new Blob([value], { type: this.mimeType });
      const dataEvent = new Event("dataavailable") as BlobEvent;
      Object.defineProperty(dataEvent, "data", { value: data });
      this.dispatchEvent(dataEvent);
      this.dispatchEvent(new Event("stop"));
      await Promise.resolve();
    }
  }

  const instances: DeferredMediaRecorder[] = [];
  vi.stubGlobal("MediaRecorder", DeferredMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
      }),
    },
  });
  return instances;
}
