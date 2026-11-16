import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ApiClientError } from "../api";
import { OpenConnectionSettings } from "./OpenConnectionSettings";
import { OpenProxySettings } from "./OpenProxySettings";

vi.hoisted(() => vi.stubEnv("VITE_APP_PROVIDER", "open"));
const api = vi.hoisted(() => ({
  readOpenConnection: vi.fn(),
  saveOpenKey: vi.fn(),
  testOpenConnection: vi.fn(),
  readOpenProxy: vi.fn(),
  saveOpenProxy: vi.fn(),
  testOpenProxy: vi.fn(),
}));
vi.mock("../connection", () => ({ useConnection: () => ({ api }) }));
const status = {
  runtime: "ready",
  runtimeVersion: "1.19.5",
  provider: "openrouter",
  apiKeyConfigured: false,
  message: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  localStorage.setItem("opennest.uiLanguage", "ru");
  api.readOpenConnection.mockResolvedValue(status);
  api.saveOpenKey.mockResolvedValue({ ...status, apiKeyConfigured: true });
  api.testOpenConnection.mockResolvedValue({ ...status, apiKeyConfigured: true });
  api.readOpenProxy.mockResolvedValue({ configured: false, address: null, hasPassword: false });
  api.saveOpenProxy.mockResolvedValue({
    configured: true,
    address: "http://proxy.example:8080",
    hasPassword: true,
  });
  api.testOpenProxy.mockResolvedValue({ ok: true, message: "checked" });
});
afterEach(cleanup);

describe("approved OpenNest connection controls", () => {
  it("clears a saved key without persisting it in browser settings or claiming provider authentication", async () => {
    render(
      <I18nProvider>
        <OpenConnectionSettings />
      </I18nProvider>,
    );
    const input = screen.getByLabelText("API-ключ OpenRouter");
    await waitFor(() => expect(input.closest('[aria-busy="true"]')).toBeNull());
    fireEvent.change(input, { target: { value: "sk-or-private" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
    await screen.findByText("Ключ сохранён.");
    expect(api.saveOpenKey).toHaveBeenCalledExactlyOnceWith("sk-or-private");
    expect(input).toHaveValue("");
    expect(JSON.stringify(localStorage)).not.toContain("sk-or-private");
    fireEvent.click(screen.getByRole("button", { name: "Проверить OpenCode" }));
    await screen.findByText("OpenCode доступен. Ключ проверяется при запросе к модели.");
    expect(screen.queryByText("Вход выполнен")).not.toBeInTheDocument();
  });
  it("preserves an unsaved key and a retry action after a native connection failure", async () => {
    api.saveOpenKey.mockRejectedValue(
      new ApiClientError("app_server_unavailable", "Safe native error", 503),
    );
    render(
      <I18nProvider>
        <OpenConnectionSettings />
      </I18nProvider>,
    );
    const input = screen.getByLabelText("API-ключ OpenRouter");
    await waitFor(() => expect(input.closest('[aria-busy="true"]')).toBeNull());
    fireEvent.change(input, { target: { value: "sk-or-retain" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "OpenCode недоступен. Повторите сохранение.",
    );
    expect(input).toHaveValue("sk-or-retain");
    expect(screen.getByRole("button", { name: "Сохранить ключ" })).toBeEnabled();
    expect(input).toHaveAttribute("aria-describedby", "openrouter-key-status");
  });
  it("reports invalid key syntax as a field error instead of an unavailable runtime", async () => {
    api.saveOpenKey.mockRejectedValue(
      new ApiClientError("validation_failed", "Invalid API key", 400),
    );
    render(
      <I18nProvider>
        <OpenConnectionSettings />
      </I18nProvider>,
    );
    const input = screen.getByLabelText("API-ключ OpenRouter");
    await waitFor(() => expect(input.closest('[aria-busy="true"]')).toBeNull());
    fireEvent.change(input, { target: { value: "invalid key" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Проверьте формат API-ключа.");
    expect(input).toHaveValue("invalid key");
  });

  it("loads only redacted proxy state and clears newly saved credentials", async () => {
    api.readOpenProxy.mockResolvedValue({
      configured: true,
      address: "http://proxy.example:8080",
      hasPassword: true,
    });
    render(
      <I18nProvider>
        <OpenProxySettings />
      </I18nProvider>,
    );
    const input = screen.getByLabelText("Адрес прокси");
    await screen.findByText("Прокси настроен.");
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "http://user:private@proxy.example:8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить прокси" }));
    await screen.findByText("Прокси сохранён.");
    expect(api.saveOpenProxy).toHaveBeenCalledExactlyOnceWith(
      "http://user:private@proxy.example:8080",
    );
    expect(input).toHaveValue("");
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  });
  it("retains a proxy draft while active tasks prevent reconfiguration", async () => {
    api.saveOpenProxy.mockRejectedValue(new ApiClientError("conflict", "Work is active", 409));
    render(
      <I18nProvider>
        <OpenProxySettings />
      </I18nProvider>,
    );
    const input = screen.getByLabelText("Адрес прокси");
    await waitFor(() => expect(input.closest('[aria-busy="true"]')).toBeNull());
    fireEvent.change(input, { target: { value: "http://proxy.example:8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить прокси" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Завершите активные задачи и повторите.",
    );
    expect(input).toHaveValue("http://proxy.example:8080");
  });
});
