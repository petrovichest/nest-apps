import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAccount, CodexAccountsStatus, CodexLoginStatus } from "@codexnest/protocol";
import { I18nProvider } from "../i18n";
import { CodexAccountsSettings } from "./CodexAccountsSettings";

const connection = vi.hoisted(() => vi.fn());
const copy = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../clipboard", () => ({ copyText: copy }));
beforeEach(() => {
  connection.mockReset();
  copy.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CodexAccountsSettings", () => {
  it("switches saved accounts without restarting Codex or refreshing quotas on render", async () => {
    const { api } = mock();
    render(<CodexAccountsSettings />);
    const card = await screen.findByRole("article", { name: "second@example.test" });
    fireEvent.click(within(card).getAllByRole("button", { name: "Использовать аккаунт" }).at(-1)!);
    await waitFor(() => expect(api.selectCodexAccount).toHaveBeenCalledExactlyOnceWith("second"));
    expect(within(card).getByText("Используется")).toBeInTheDocument();
    expect(api.refreshCodexAccounts).not.toHaveBeenCalled();
    expect(api.startCodexLogin).not.toHaveBeenCalled();
  });

  it("disables selection while any device has an active turn and updates from the live snapshot", async () => {
    const h = mock(true);
    const view = render(<CodexAccountsSettings />);
    const card = await screen.findByRole("article", { name: "second@example.test" });
    expect(
      within(card)
        .getAllByRole("button", { name: "Использовать аккаунт" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(
      screen.getByText("Переключить аккаунт можно после завершения активных ответов."),
    ).toBeInTheDocument();
    h.state.snapshot.threads = [];
    h.state.snapshot.codexAccounts = { ...h.initial, currentAccountId: "second" };
    view.rerender(<CodexAccountsSettings />);
    expect(within(card).getByText("Используется")).toBeInTheDocument();
  });

  it("shows the device code and finishes after delayed status polling", async () => {
    vi.useFakeTimers();
    const h = mock();
    await act(async () => {
      render(<CodexAccountsSettings />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Добавить аккаунт" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Получить код входа" }));
    });
    expect(screen.getByLabelText("Код для входа в ChatGPT")).toHaveValue("ABCD-EFGH");
    expect(screen.getByRole("link", { name: "Открыть страницу входа" })).toHaveAttribute(
      "href",
      "https://auth.openai.com/codex/device",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Скопировать код" }));
    });
    expect(copy).toHaveBeenCalledWith("ABCD-EFGH");
    h.api.readCodexLogin.mockResolvedValue({ ...login(), state: "completed", accountId: "third" });
    h.api.readCodexAccounts.mockResolvedValue({
      ...h.initial,
      accounts: [...h.initial.accounts, account("third")],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "third@example.test" })).toBeInTheDocument();
    expect(h.api.cancelCodexLogin).not.toHaveBeenCalled();
  });

  it("cancels a login whose start finishes after the dialog closes", async () => {
    const h = mock();
    let resolve!: (value: CodexLoginStatus) => void;
    h.api.startCodexLogin.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<CodexAccountsSettings />);
    await screen.findByRole("article", { name: "first@example.test" });
    fireEvent.click(screen.getByRole("button", { name: "Добавить аккаунт" }));
    fireEvent.click(screen.getByRole("button", { name: "Получить код входа" }));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    await act(async () => {
      resolve(login());
    });
    expect(h.api.cancelCodexLogin).toHaveBeenCalledExactlyOnceWith("login");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("retries a transient polling failure and keeps native details out of errors", async () => {
    vi.useFakeTimers();
    const h = mock();
    h.api.readCodexLogin.mockRejectedValueOnce(new Error("Bearer secret-native-output"));
    await act(async () => {
      render(<CodexAccountsSettings />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Добавить аккаунт" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Получить код входа" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole("alert")).not.toHaveTextContent("secret-native-output");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(h.api.readCodexLogin).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows English account controls and preserves the current account on a failed switch", async () => {
    const h = mock();
    h.api.selectCodexAccount.mockRejectedValue(
      new Error("Wait for active Codex responses before switching accounts"),
    );
    localStorage.setItem("codexnest.uiLanguage", "en");
    render(
      <I18nProvider>
        <CodexAccountsSettings />
      </I18nProvider>,
    );
    const card = await screen.findByRole("article", { name: "second@example.test" });
    fireEvent.click(within(card).getAllByRole("button", { name: "Use account" }).at(-1)!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait for active Codex responses");
    expect(
      within(screen.getByRole("article", { name: "first@example.test" })).getByText("In use"),
    ).toBeInTheDocument();
  });
});

function account(id: string): CodexAccount {
  return {
    id,
    email: `${id}@example.test`,
    plan: "plus",
    authenticated: true,
    connectionError: null,
    rateLimits: {
      limits: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
      updatedAt: 1,
      refreshing: false,
      refreshError: false,
    },
  };
}
function login(): CodexLoginStatus {
  return {
    id: "login",
    state: "waiting",
    url: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    accountId: null,
    error: null,
  };
}
function mock(active = false) {
  const initial: CodexAccountsStatus = {
    currentAccountId: "first",
    accounts: [account("first"), account("second")],
  };
  const state = {
    snapshot: {
      codexAccounts: initial,
      threads: active ? [{ currentTurnId: "turn" }] : ([] as { currentTurnId: string }[]),
    },
  };
  const api = {
    readCodexAccounts: vi.fn(async () => initial),
    refreshCodexAccounts: vi.fn(async () => initial),
    selectCodexAccount: vi.fn(async (id: string) => ({ ...initial, currentAccountId: id })),
    removeCodexAccount: vi.fn(async () => initial),
    startCodexLogin: vi.fn<(_id?: string) => Promise<CodexLoginStatus>>(async () => login()),
    readCodexLogin: vi.fn<(_id: string) => Promise<CodexLoginStatus>>(async () => login()),
    cancelCodexLogin: vi.fn<(_id: string) => Promise<CodexLoginStatus>>(async () => ({
      ...login(),
      state: "cancelled" as const,
    })),
  };
  connection.mockReturnValue({ api, state });
  return { api, state, initial };
}
