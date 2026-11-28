import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { application } from "../application";
import type { ForkEstimateResponse, ForkOperationSummary } from "../forks";
import { translate } from "../i18n";
import { ForkDialog, formatForkBytes, formatForkTime } from "./ForkDialog";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));

const estimate: ForkEstimateResponse = {
  sourceBytes: 12_345_678,
  compressed: {
    available: true,
    estimatedBytes: null,
    estimatedSeconds: { minSeconds: 60, maxSeconds: 600 },
    unavailableReason: null,
  },
  exact: {
    available: true,
    estimatedBytes: 12_345_678,
    estimatedSeconds: { minSeconds: 65, maxSeconds: 125 },
    unavailableReason: null,
  },
};

const operation: ForkOperationSummary = {
  id: "operation-id",
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
  estimate: estimate.compressed,
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "stable-operation-id") });
});

const originalIsOpen = application.isOpen;
afterEach(() => {
  application.isOpen = originalIsOpen;
});

describe("ForkDialog", () => {
  it("paints while estimating, defaults to compressed when available, and creates once", async () => {
    let resolveEstimate!: (value: ForkEstimateResponse) => void;
    const estimateFork = vi.fn(
      () => new Promise<ForkEstimateResponse>((resolve) => (resolveEstimate = resolve)),
    );
    let resolveCreate!: (value: { operation: ForkOperationSummary }) => void;
    const createForkOperation = vi.fn(
      () =>
        new Promise<{ operation: ForkOperationSummary }>((resolve) => (resolveCreate = resolve)),
    );
    connection.mockReturnValue({ api: { estimateFork, createForkOperation } });
    const onCreated = vi.fn();

    renderDialog({ onCreated });
    const dialog = screen.getByRole("dialog", { name: "Создать ветку" });
    expect(dialog).toBeVisible();
    expect(within(dialog).getAllByText("Считаем…").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Объём")).toHaveLength(2);
    expect(within(dialog).getAllByText("Время")).toHaveLength(2);
    expect(dialog.querySelectorAll('.fork-mode-metrics[aria-busy="true"]')).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: "Закрыть" })).toHaveFocus();

    await act(async () => resolveEstimate(estimate));
    expect(dialog.querySelectorAll('.fork-mode-metrics[aria-busy="true"]')).toHaveLength(0);
    expect(within(dialog).getByText("рассчитается при создании")).toBeVisible();
    const compressed = within(dialog).getByRole("radio", { name: /Компактная/ });
    expect(compressed).toBeChecked();
    const create = within(dialog).getByRole("button", { name: "Создать ветку" });
    fireEvent.click(create);
    fireEvent.click(create);

    expect(createForkOperation).toHaveBeenCalledOnce();
    expect(createForkOperation).toHaveBeenCalledWith("thread", {
      operationId: "stable-operation-id",
      lastTurnId: "turn",
      agentMessageId: "answer",
      mode: "compressed",
    });
    await act(async () => resolveCreate({ operation }));
    expect(onCreated).toHaveBeenCalledWith(operation);
  });

  it("keeps compact selected and available when estimation fails", async () => {
    connection.mockReturnValue({
      api: {
        estimateFork: vi.fn().mockRejectedValue(new Error("offline")),
        createForkOperation: vi.fn(),
      },
    });
    renderDialog();

    const compact = await screen.findByRole("radio", { name: /Компактная/ });
    await waitFor(() => expect(compact).toBeChecked());
    expect(compact).toBeEnabled();
    expect(screen.getByText("рассчитается при создании")).toBeVisible();
    expect(screen.getByRole("button", { name: "Создать ветку" })).toBeEnabled();
  });

  it("keeps compact available when an older estimate marks it unavailable", async () => {
    const onClose = vi.fn();
    connection.mockReturnValue({
      api: {
        estimateFork: vi.fn().mockResolvedValue({
          ...estimate,
          compressed: {
            available: false,
            estimatedBytes: null,
            estimatedSeconds: null,
            unavailableReason: "Недостаточно данных для безопасного сжатия",
          },
        }),
        createForkOperation: vi.fn(),
      },
    });
    renderDialog({ onClose });
    const compact = await screen.findByRole("radio", { name: /Компактная/ });
    expect(compact).toBeChecked();
    expect(compact).toBeEnabled();
    expect(screen.getByText("рассчитается при создании")).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the OpenNest refusal and creates only the available exact fork", async () => {
    application.isOpen = true;
    const createForkOperation = vi.fn().mockResolvedValue({ operation });
    connection.mockReturnValue({
      api: {
        estimateFork: vi.fn().mockResolvedValue({
          ...estimate,
          compressed: {
            available: false,
            unavailableReason: "Claude Code context compaction is disabled",
          },
        }),
        createForkOperation,
      },
    });
    renderDialog();

    expect(await screen.findByText("Сжатие контекста отключено в Claude Code.")).toBeVisible();
    expect(screen.getByRole("radio", { name: /Компактная/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Полная история/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Создать ветку" }));
    await waitFor(() =>
      expect(createForkOperation).toHaveBeenCalledWith(
        "thread",
        expect.objectContaining({ mode: "exact" }),
      ),
    );
  });

  it("keeps both OpenNest choices usable when an old estimate omits mode metadata", async () => {
    application.isOpen = true;
    connection.mockReturnValue({
      api: {
        estimateFork: vi.fn().mockResolvedValue({
          sourceBytes: 100,
          compressed: {},
          exact: { available: true, estimatedBytes: 100 },
        }),
      },
    });
    renderDialog();

    expect(await screen.findByText("рассчитается при создании")).toBeVisible();
    expect(screen.getByRole("radio", { name: /Компактная/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Полная история/ })).toBeEnabled();
  });

  it("formats large estimates without unbounded precision", () => {
    expect(
      formatForkBytes(9_876_543_210, "en", (key, values) => translate("en", key, values)),
    ).toBe("9.2 GB");
    expect(
      formatForkTime({ minSeconds: 65, maxSeconds: 125 }, (key, values) =>
        key.replace("{{count}}", String(values?.count)),
      ),
    ).toBe("≈ 2 мин–3 мин");
  });
});

function renderDialog({
  onClose = vi.fn(),
  onCreated = vi.fn(),
}: {
  onClose?: () => void;
  onCreated?: (operation: ForkOperationSummary) => void;
} = {}) {
  return render(
    <ForkDialog
      sourceThreadId="thread"
      sourceTitle="Очень длинное название исходной задачи"
      lastTurnId="turn"
      agentMessageId="answer"
      onClose={onClose}
      onCreated={onCreated}
    />,
  );
}
