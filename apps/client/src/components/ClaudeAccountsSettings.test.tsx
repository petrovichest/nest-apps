import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAccount, ClaudeAccountsStatus, ClaudeLoginStatus } from "@codexnest/protocol";

import { ClaudeAccountsSettings } from "./ClaudeAccountsSettings";

const connection = vi.hoisted(() => vi.fn());
const copyText = vi.hoisted(() => vi.fn());
const isNativePlatform = vi.hoisted(() => vi.fn());
const openBrowser = vi.hoisted(() => vi.fn());
vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../clipboard", () => ({ copyText }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform } }));
vi.mock("@capacitor/browser", () => ({ Browser: { open: openBrowser } }));

beforeEach(() => {
  connection.mockReset();
  copyText.mockReset().mockResolvedValue(undefined);
  isNativePlatform.mockReset().mockReturnValue(false);
  openBrowser.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ClaudeAccountsSettings", () => {
  it("shows equal email accounts, weekly exhaustion and unknown limits without polling usage on render", async () => {
    const api = mockApi(
      status({
        accounts: [
          account(),
          account({ id: "weekly", email: "weekly@example.com", rateLimits: limits(10, 100) }),
          account({
            id: "unknown",
            email: null,
            authenticated: false,
            rateLimits: { limits: null, updatedAt: null, refreshing: false, refreshError: false },
          }),
        ],
      }),
    );
    render(<ClaudeAccountsSettings />);
    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
    expect(screen.getByText("Недельный лимит")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Лимит недоступен")).toHaveLength(2);
    expect(screen.getByText("Войдите в аккаунт, чтобы получить лимиты.")).toBeInTheDocument();
    expect(screen.queryByText(/Основной|Резервный|Личный|Оплачено до/)).not.toBeInTheDocument();
    expect(api.readClaudeAccounts).toHaveBeenCalledOnce();
    expect(api.refreshClaudeAccounts).not.toHaveBeenCalled();
    expect(api.testClaudeProxy).not.toHaveBeenCalled();
  });

  it("updates the application switch and offers manual account selection only when disabled", async () => {
    const api = mockApi(
      status({ accounts: [account(), account({ id: "other", email: "other@example.com" })] }),
    );
    api.updateClaudeAutoSwitch.mockImplementation(async (autoSwitch: boolean) =>
      status({
        autoSwitch,
        accounts: [account(), account({ id: "other", email: "other@example.com" })],
      }),
    );
    render(<ClaudeAccountsSettings />);
    const toggle = await screen.findByRole("switch", { name: "Автопереключение" });
    expect(toggle).toBeChecked();
    expect(screen.queryByRole("button", { name: "Использовать аккаунт" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.updateClaudeAutoSwitch).toHaveBeenCalledWith(false));
    const second = screen.getByRole("article", { name: "other@example.com" });
    fireEvent.click(within(second).getByLabelText("Действия аккаунта other@example.com"));
    fireEvent.click(within(second).getByRole("button", { name: "Использовать аккаунт" }));
    await waitFor(() => expect(api.selectClaudeAccount).toHaveBeenCalledWith("other"));
  });

  it("shows one usage error and explicit retry without inventing network failures or unknown reset data", async () => {
    const api = mockApi(
      status({
        accounts: [
          account({
            plan: "pro",
            connectionError: "Could not refresh this account's connection or limits",
            rateLimits: { limits: null, updatedAt: null, refreshing: false, refreshError: true },
          }),
        ],
      }),
    );
    render(<ClaudeAccountsSettings />);
    const card = await screen.findByRole("article", { name: "person@example.com" });
    expect(within(card).getByText("Pro")).toBeInTheDocument();
    expect(within(card).getAllByRole("status")).toHaveLength(1);
    expect(within(card).getByText("Не удалось получить лимиты")).toBeInTheDocument();
    expect(within(card).queryByText("Ошибка подключения")).not.toBeInTheDocument();
    expect(within(card).queryByText("Показаны последние данные.")).not.toBeInTheDocument();
    expect(within(card).queryByText("Время сброса неизвестно")).not.toBeInTheDocument();
    expect(within(card).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(card.querySelectorAll(".claude-account-quota-track")).toHaveLength(0);
    fireEvent.click(within(card).getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(api.refreshClaudeAccounts).toHaveBeenCalledExactlyOnceWith("account"),
    );
  });

  it("mentions previous usage only when the card has real quota values", async () => {
    mockApi(
      status({ accounts: [account({ rateLimits: { ...limits(62, 38), refreshError: true } })] }),
    );
    render(<ClaudeAccountsSettings />);
    const card = await screen.findByRole("article", { name: "person@example.com" });
    expect(within(card).getByText("Показаны последние данные.")).toBeInTheDocument();
    expect(within(card).getAllByRole("progressbar")).toHaveLength(2);
    expect(within(card).getByText("38%")).toBeInTheDocument();
  });

  it("keeps positive fractional quotas available for manual selection", async () => {
    const api = mockApi(
      status({
        autoSwitch: false,
        accounts: [
          account(),
          account({
            id: "fractional",
            email: "fractional@example.com",
            rateLimits: limits(99.6, 99.6),
          }),
        ],
      }),
    );
    render(<ClaudeAccountsSettings />);
    const card = await screen.findByRole("article", { name: "fractional@example.com" });
    expect(within(card).getAllByText("<1%")).toHaveLength(2);
    expect(within(card).queryByText("Недельный лимит")).not.toBeInTheDocument();
    expect(within(card).queryByText("Лимит на 5 часов")).not.toBeInTheDocument();
    fireEvent.click(within(card).getByLabelText("Действия аккаунта fractional@example.com"));
    const select = within(card).getByRole("button", { name: "Использовать аккаунт" });
    expect(select).toBeEnabled();
    fireEvent.click(select);
    await waitFor(() => expect(api.selectClaudeAccount).toHaveBeenCalledWith("fractional"));
  });

  it("accepts SOCKS5, masks parsed credentials and tests only after an explicit click", async () => {
    const api = mockApi();
    render(<ClaudeAccountsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Добавить аккаунт" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Через прокси")).toBeChecked();
    const input = within(dialog).getByLabelText("Прокси");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, {
      target: { value: "socks5://proxy-user:private-password@proxy.example:1080" },
    });
    expect(within(dialog).getByLabelText("Тип прокси")).toHaveValue("socks5");
    expect(within(dialog).getByText("proxy.example:1080")).toBeInTheDocument();
    expect(within(dialog).getByText("proxy-user")).toBeInTheDocument();
    expect(within(dialog).queryByText("private-password")).not.toBeInTheDocument();
    expect(api.testClaudeProxy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить прокси" }));
    await waitFor(() =>
      expect(api.testClaudeProxy).toHaveBeenCalledWith({
        enabled: true,
        protocol: "socks5",
        value: "socks5h://proxy-user:private-password@proxy.example:1080",
      }),
    );
    expect(await within(dialog).findByText("Подключение доступно · 148 мс")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Перейти к входу" }));
    await waitFor(() =>
      expect(api.startClaudeLogin).toHaveBeenCalledWith({
        proxy: {
          enabled: true,
          protocol: "socks5",
          value: "socks5h://proxy-user:private-password@proxy.example:1080",
        },
      }),
    );
  });

  it("offers ambiguous proxy interpretations without retyping and changes explicit protocols", async () => {
    const api = mockApi();
    render(<ClaudeAccountsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Добавить аккаунт" }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText("Прокси");
    fireEvent.change(input, { target: { value: "one:80:two:90" } });
    expect(
      within(dialog).getByRole("group", { name: "Выберите правильный разбор прокси" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Перейти к входу" })).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/HTTP · one:80/));
    expect(within(dialog).getByRole("button", { name: "Перейти к входу" })).toBeEnabled();
    expect(input).toHaveValue("one:80:two:90");
    fireEvent.change(input, { target: { value: "http://proxy.example:8080" } });
    fireEvent.change(within(dialog).getByLabelText("Тип прокси"), { target: { value: "https" } });
    expect(input).toHaveValue("https://proxy.example:8080");
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить прокси" }));
    await waitFor(() =>
      expect(api.testClaudeProxy).toHaveBeenCalledWith({
        enabled: true,
        protocol: "https",
        value: "https://proxy.example:8080",
      }),
    );
  });

  it("keeps invalid input local and does not echo secret backend errors", async () => {
    const api = mockApi();
    render(<ClaudeAccountsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Добавить аккаунт" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Прокси"), {
      target: { value: "private-password" },
    });
    expect(
      within(dialog).getByText("Не удалось распознать прокси. Проверьте адрес и порт в строке."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Проверить прокси" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Прокси"), {
      target: { value: "user:secret@proxy.example:8080" },
    });
    api.testClaudeProxy.mockRejectedValueOnce(
      new Error("Bad password secret for user:secret@proxy.example:8080"),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить прокси" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Не удалось проверить подключение через прокси.",
    );
    expect(within(dialog).queryByText(/Bad password/)).not.toBeInTheDocument();
  });

  it("offers opening and copying the native login link, sends the full code and reloads verified accounts", async () => {
    const api = mockApi();
    api.submitClaudeLoginCode.mockResolvedValueOnce(login({ state: "completed" }));
    render(<ClaudeAccountsSettings />);
    await openDirectLogin();
    const dialog = screen.getByRole("dialog");
    const link = within(dialog).getByRole("link", { name: "Открыть страницу входа" });
    expect(link).toHaveAttribute("href", "https://claude.ai/oauth/authorize?state=state");
    expect(link).toHaveAttribute("target", "_blank");
    expect(openBrowser).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Скопировать ссылку" }));
    await waitFor(() =>
      expect(copyText).toHaveBeenCalledWith("https://claude.ai/oauth/authorize?state=state"),
    );
    fireEvent.change(within(dialog).getByLabelText("Код авторизации"), {
      target: { value: " full-code#state " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Подтвердить код" }));
    await waitFor(() =>
      expect(api.submitClaudeLoginCode).toHaveBeenCalledWith("login", "full-code#state"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.readClaudeAccounts).toHaveBeenCalledTimes(2);
    expect(api.cancelClaudeLogin).not.toHaveBeenCalled();
  });

  it("opens native authorization in the system browser only after a user click", async () => {
    isNativePlatform.mockReturnValue(true);
    mockApi();
    render(<ClaudeAccountsSettings />);
    await openDirectLogin();
    expect(openBrowser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Открыть страницу входа" }));
    await waitFor(() =>
      expect(openBrowser).toHaveBeenCalledWith({
        url: "https://claude.ai/oauth/authorize?state=state",
      }),
    );
  });

  it("polls an active login, then cancels once and stops polling when closed", async () => {
    const api = mockApi();
    render(<ClaudeAccountsSettings />);
    await screen.findByText("person@example.com");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Добавить аккаунт" }));
    fireEvent.click(screen.getByLabelText("Без прокси"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Перейти к входу" }));
    });
    expect(screen.getByRole("link", { name: "Открыть страницу входа" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(api.readClaudeLogin).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.cancelClaudeLogin).toHaveBeenCalledExactlyOnceWith("login");
    expect(api.readClaudeLogin).toHaveBeenCalledOnce();
  });

  it("cancels a login that started after its dialog was closed", async () => {
    const api = mockApi();
    let finish!: (value: ClaudeLoginStatus) => void;
    api.startClaudeLogin.mockImplementationOnce(
      () =>
        new Promise<ClaudeLoginStatus>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ClaudeAccountsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Добавить аккаунт" }));
    fireEvent.click(screen.getByLabelText("Без прокси"));
    fireEvent.click(screen.getByRole("button", { name: "Перейти к входу" }));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    await act(async () => {
      finish(login());
    });
    expect(api.cancelClaudeLogin).toHaveBeenCalledExactlyOnceWith("login");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preserves the existing proxy on reauthentication and requires fresh credentials for editing", async () => {
    const api = mockApi();
    render(<ClaudeAccountsSettings />);
    await screen.findByText("person@example.com");
    fireEvent.click(screen.getByLabelText("Действия аккаунта person@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Войти заново" }));
    await screen.findByRole("link", { name: "Открыть страницу входа" });
    expect(api.startClaudeLogin).toHaveBeenCalledWith({ accountId: "account" });
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    fireEvent.click(screen.getByRole("button", { name: "Настроить" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Сохранить подключение" })).toBeDisabled();
    expect(
      within(dialog).getByText("Текущее подключение: HTTPS · proxy.example:8443"),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Прокси"), {
      target: { value: "new.example:8080:new-user:new-password" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить подключение" }));
    await waitFor(() =>
      expect(api.updateClaudeAccountProxy).toHaveBeenCalledWith("account", {
        enabled: true,
        protocol: "https",
        value: "https://new-user:new-password@new.example:8080",
      }),
    );
  });

  it("uses live account events without an additional usage request", async () => {
    const initial = status();
    const api = mockApi(initial);
    connection.mockReturnValue({ api, state: { snapshot: { claudeAccounts: initial } } });
    const { rerender } = render(<ClaudeAccountsSettings />);
    await screen.findByText("person@example.com");
    const updated = status({ accounts: [account({ rateLimits: limits(80, 20) })] });
    connection.mockReturnValue({ api, state: { snapshot: { claudeAccounts: updated } } });
    rerender(<ClaudeAccountsSettings />);
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(api.readClaudeAccounts).toHaveBeenCalledOnce();
    expect(api.refreshClaudeAccounts).not.toHaveBeenCalled();
  });
});

async function openDirectLogin() {
  fireEvent.click(await screen.findByRole("button", { name: "Добавить аккаунт" }));
  fireEvent.click(screen.getByLabelText("Без прокси"));
  fireEvent.click(screen.getByRole("button", { name: "Перейти к входу" }));
  await screen.findByRole("link", { name: "Открыть страницу входа" });
}

function mockApi(initial = status()) {
  const api = {
    readClaudeAccounts: vi.fn(async () => initial),
    refreshClaudeAccounts: vi.fn(async () => initial),
    updateClaudeAutoSwitch: vi.fn(async (enabled: boolean) => ({
      ...initial,
      autoSwitch: enabled,
    })),
    selectClaudeAccount: vi.fn(async () => initial),
    removeClaudeAccount: vi.fn(async () => initial),
    updateClaudeAccountProxy: vi.fn(async () => initial),
    testClaudeProxy: vi.fn(async () => ({
      ok: true,
      latencyMs: 148,
      error: null,
      proxy: account().proxy,
    })),
    startClaudeLogin: vi.fn(async () => login()),
    readClaudeLogin: vi.fn(async () => login()),
    submitClaudeLoginCode: vi.fn(async () => login({ state: "checking" })),
    cancelClaudeLogin: vi.fn(async () => login({ state: "cancelled" })),
  };
  connection.mockReturnValue({ api, state: null });
  return api;
}

function status(overrides: Partial<ClaudeAccountsStatus> = {}): ClaudeAccountsStatus {
  return {
    cliVersion: "2.1.289",
    autoSwitch: true,
    warmLimits: true,
    currentAccountId: "account",
    accounts: [account()],
    ...overrides,
  };
}

function account(overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    id: "account",
    email: "person@example.com",
    plan: "Max",
    authenticated: true,
    proxy: {
      enabled: true,
      protocol: "https",
      host: "proxy.example",
      port: 8443,
      username: "user",
      hasPassword: true,
    },
    rateLimits: limits(62, 38),
    connectionError: null,
    ...overrides,
  };
}

function limits(primary: number, secondary: number): ClaudeAccount["rateLimits"] {
  return {
    limits: {
      primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: 1_800_000_000_000 },
      secondary: {
        usedPercent: secondary,
        windowDurationMins: 10_080,
        resetsAt: 1_800_200_000_000,
      },
    },
    updatedAt: 1_799_900_000_000,
    refreshing: false,
    refreshError: false,
  };
}

function login(overrides: Partial<ClaudeLoginStatus> = {}): ClaudeLoginStatus {
  return {
    id: "login",
    state: "waitingCode",
    url: "https://claude.ai/oauth/authorize?state=state",
    accountId: null,
    error: null,
    ...overrides,
  };
}
