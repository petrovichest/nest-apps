import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionReference } from "@codexnest/protocol";

import { application } from "../application";
import { SessionReferenceCopy } from "./SessionReferenceCopy";

const reference: SessionReference = {
  threadId: "native-id",
  cwd: "/work/project with spaces",
  historyPath: "/native/sessions/rollout-native-id.jsonl",
};
const writeText = vi.fn();
const originalName = application.name;

beforeEach(() => {
  localStorage.clear();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => {
  application.name = originalName;
  vi.useRealTimers();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

describe("SessionReferenceCopy", () => {
  it.each(["CodexNest", "ClaudeNest"])(
    "copies the local pointer for %s only on click",
    async (name) => {
      application.name = name;
      const api = { readSessionReference: vi.fn().mockResolvedValue(reference) };
      render(<SessionReferenceCopy api={api} threadId="native-id" />);
      expect(api.readSessionReference).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Копировать ссылку на сессию" }));
      expect(await screen.findByRole("button", { name: "Скопировано" })).toBeEnabled();
      expect(api.readSessionReference).toHaveBeenCalledExactlyOnceWith("native-id");
      expect(writeText).toHaveBeenCalledWith(
        `Сессия: ${name}\nID: native-id\nРабочая папка: /work/project with spaces\nФайл истории: /native/sessions/rollout-native-id.jsonl`,
      );
      expect(screen.getByRole("status")).toHaveTextContent("Ссылка на сессию скопирована");
    },
  );

  it("marks missing history explicitly while keeping ID and cwd", async () => {
    const api = {
      readSessionReference: vi.fn().mockResolvedValue({ ...reference, historyPath: null }),
    };
    render(<SessionReferenceCopy api={api} threadId="native-id" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]?.[0]).toContain(
      "ID: native-id\nРабочая папка: /work/project with spaces",
    );
    expect(writeText.mock.calls[0]?.[0]).toContain("Файл истории: Файл истории недоступен");
  });

  it.each(["request", "clipboard"])("reports %s failures and permits retry", async (failure) => {
    const api = { readSessionReference: vi.fn().mockResolvedValue(reference) };
    if (failure === "request") api.readSessionReference.mockRejectedValueOnce(new Error("Offline"));
    else writeText.mockRejectedValueOnce(new Error("Denied"));
    render(<SessionReferenceCopy api={api} threadId="native-id" />);
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось скопировать ссылку на сессию",
    );
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("button", { name: "Скопировано" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not copy a pending response after navigating to another session", async () => {
    let resolve!: (value: SessionReference) => void;
    const api = {
      readSessionReference: vi.fn(
        () =>
          new Promise<SessionReference>((done) => {
            resolve = done;
          }),
      ),
    };
    const view = render(<SessionReferenceCopy key="one" api={api} threadId="one" />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toBeDisabled();
    view.rerender(<SessionReferenceCopy key="two" api={api} threadId="two" />);
    await act(async () => resolve(reference));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Копировать ссылку на сессию" })).toBeEnabled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("clears success after two seconds", async () => {
    vi.useFakeTimers();
    const api = { readSessionReference: vi.fn().mockResolvedValue(reference) };
    render(<SessionReferenceCopy api={api} threadId="native-id" />);
    await act(async () => fireEvent.click(screen.getByRole("button")));
    expect(screen.getByRole("button", { name: "Скопировано" })).toBeEnabled();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("button", { name: "Копировать ссылку на сессию" })).toBeEnabled();
  });
});
