import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUpdateStatus } from "@codexnest/protocol";

import { ApplicationSettingsCard } from "./ApplicationSettingsCard";

const connection = vi.hoisted(() => vi.fn());
const openDownloadUrl = vi.hoisted(() => vi.fn());
const isNativePlatform = vi.hoisted(() => vi.fn());
const getAppInfo = vi.hoisted(() => vi.fn());
const openBrowser = vi.hoisted(() => vi.fn());

vi.mock("../connection", () => ({ useConnection: connection }));
vi.mock("../downloads", () => ({ openDownloadUrl }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform } }));
vi.mock("@capacitor/app", () => ({ App: { getInfo: getAppInfo } }));
vi.mock("@capacitor/browser", () => ({ Browser: { open: openBrowser } }));

beforeEach(() => {
  connection.mockReset();
  openDownloadUrl.mockReset();
  openDownloadUrl.mockResolvedValue(undefined);
  isNativePlatform.mockReset();
  isNativePlatform.mockReturnValue(false);
  getAppInfo.mockReset();
  openBrowser.mockReset();
  openBrowser.mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

describe("ApplicationSettingsCard", () => {
  it("checks GitHub only after an explicit click", async () => {
    const initial = updateStatus();
    const checked = updateStatus({ latestVersion: "0.1.4-abcdef0", updateAvailable: true });
    const onStatusChange = vi.fn();
    const api = {
      readAppSettings: vi.fn(async () => initial),
      checkAppUpdate: vi.fn(async () => checked),
      updateApp: vi.fn(async () => checked),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard onStatusChange={onStatusChange} />);

    expect(await screen.findByText("Не проверялась")).toBeInTheDocument();
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Проверить обновления" }));

    expect(await screen.findByText("0.1.4-abcdef0")).toBeInTheDocument();
    expect(api.checkAppUpdate).toHaveBeenCalledOnce();
    expect(onStatusChange).toHaveBeenNthCalledWith(1, initial);
    expect(onStatusChange).toHaveBeenLastCalledWith(checked);
    expect(screen.getByRole("button", { name: "Обновить CodexNest" })).toBeEnabled();
    expect(screen.getByText("Установлено на сервере")).toBeInTheDocument();
    expect(screen.getByText("Актуальная версия в GitHub")).toBeInTheDocument();
    expect(screen.getByText("APK на этом устройстве")).toBeInTheDocument();
    expect(screen.getByText("Только в Android")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Скачать свежий APK" })).toBeEnabled();
    expect(getAppInfo).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Сервер, APK и расширение для Chrome обновляются из одной проверенной CI-сборки с автоматическим откатом.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the installed Android APK version and version code", async () => {
    isNativePlatform.mockReturnValue(true);
    getAppInfo.mockResolvedValue({
      name: "CodexNest",
      id: "com.codexnest.app",
      version: "0.1.4-abcdef0",
      build: "1000078",
    });
    const api = {
      readAppSettings: vi.fn(async () => updateStatus()),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);

    expect(await screen.findByText("0.1.4-abcdef0 (1000078)")).toBeInTheDocument();
    expect(getAppInfo).toHaveBeenCalledOnce();
  });

  it("links to the repository in a separate web tab without another API request", async () => {
    const api = {
      readAppSettings: vi.fn(async () => updateStatus()),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);

    const link = await screen.findByRole("link", { name: "Открыть GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/petrovichest/nest-apps");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(api.readAppSettings).toHaveBeenCalledOnce();
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
    expect(api.updateApp).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("opens the repository in the system browser on native platforms", async () => {
    isNativePlatform.mockReturnValue(true);
    getAppInfo.mockResolvedValue({
      name: "CodexNest",
      id: "com.codexnest.app",
      version: "0.1.9",
      build: "1000090",
    });
    const api = {
      readAppSettings: vi.fn(async () => updateStatus()),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);
    fireEvent.click(await screen.findByRole("link", { name: "Открыть GitHub" }));

    await waitFor(() =>
      expect(openBrowser).toHaveBeenCalledWith({
        url: "https://github.com/petrovichest/nest-apps",
      }),
    );
  });

  it("shows an error when the system browser cannot open GitHub", async () => {
    isNativePlatform.mockReturnValue(true);
    getAppInfo.mockResolvedValue({
      name: "CodexNest",
      id: "com.codexnest.app",
      version: "0.1.9",
      build: "1000090",
    });
    openBrowser.mockRejectedValueOnce(new Error("browser failed"));
    const api = {
      readAppSettings: vi.fn(async () => updateStatus()),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);
    fireEvent.click(await screen.findByRole("link", { name: "Открыть GitHub" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось открыть GitHub");
  });

  it("handles an unavailable Android APK version", async () => {
    isNativePlatform.mockReturnValue(true);
    getAppInfo.mockRejectedValue(new Error("unavailable"));
    const api = {
      readAppSettings: vi.fn(async () => updateStatus()),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);

    expect(await screen.findByText("Не удалось определить")).toBeInTheDocument();
  });

  it("requires confirmation before handing the update to systemd", async () => {
    const current = updateStatus({ latestVersion: "0.1.4-abcdef0", updateAvailable: true });
    const queued = updateStatus({
      latestVersion: "0.1.4-abcdef0",
      updateAvailable: true,
      operation: "preparing",
    });
    const api = {
      readAppSettings: vi.fn(async () => current),
      checkAppUpdate: vi.fn(async () => current),
      updateApp: vi.fn(async () => queued),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ApplicationSettingsCard />);
    await screen.findByText("0.1.4-abcdef0");
    fireEvent.click(screen.getByRole("button", { name: "Обновить CodexNest" }));

    await waitFor(() => expect(api.updateApp).toHaveBeenCalledOnce());
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("до версии 0.1.4-abcdef0"));
  });

  it("blocks the update while an agent turn is active", async () => {
    const current = updateStatus({ latestVersion: "0.1.4-abcdef0", updateAvailable: true });
    const api = {
      readAppSettings: vi.fn(async () => current),
      checkAppUpdate: vi.fn(async () => current),
      updateApp: vi.fn(async () => current),
    };
    connection.mockReturnValue({
      api,
      state: {
        network: "connected",
        snapshot: { threads: [{ currentTurnId: "turn-1" }] },
      },
    });
    const confirm = vi.spyOn(window, "confirm");

    render(<ApplicationSettingsCard />);

    expect(
      await screen.findByText("Дождитесь завершения активных ответов: 1."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Обновить CodexNest" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Обновить CodexNest" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(api.updateApp).not.toHaveBeenCalled();
  });

  it("opens the rolling Chrome extension download without another API request", async () => {
    const api = {
      settings: { baseUrl: "https://codex.home.arpa" },
      readAppSettings: vi.fn(async () => updateStatus({ supported: false })),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Скачать расширение для Chrome" }));

    await waitFor(() =>
      expect(openDownloadUrl).toHaveBeenCalledWith(
        "https://codex.home.arpa",
        "https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/codexnest-browser-latest.zip",
      ),
    );
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
    expect(api.updateApp).not.toHaveBeenCalled();
  });

  it("allows the update while daemon turns are active", async () => {
    const current = updateStatus({
      latestVersion: "0.1.4-abcdef0",
      updateAvailable: true,
      canUpdateWithActiveTurns: true,
    });
    const api = {
      readAppSettings: vi.fn(async () => current),
      checkAppUpdate: vi.fn(async () => current),
      updateApp: vi.fn(async () => current),
    };
    connection.mockReturnValue({
      api,
      state: {
        network: "connected",
        snapshot: { threads: [{ currentTurnId: "turn-1" }] },
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ApplicationSettingsCard />);

    const update = await screen.findByRole("button", { name: "Обновить CodexNest" });
    expect(update).toBeEnabled();
    expect(screen.queryByText("Дождитесь завершения активных ответов: 1.")).not.toBeInTheDocument();
    fireEvent.click(update);
    await waitFor(() => expect(api.updateApp).toHaveBeenCalledOnce());
  });

  it("explains when the current checkout is not managed", async () => {
    const api = {
      readAppSettings: vi.fn(async () =>
        updateStatus({ supported: false, message: "Managed installer is required" }),
      ),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);

    expect(await screen.findByText("Managed installer is required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить обновления" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Скачать свежий APK" })).toBeEnabled();
  });

  it("opens the rolling APK download without another API request", async () => {
    const api = {
      settings: { baseUrl: "https://codex.home.arpa" },
      readAppSettings: vi.fn(async () => updateStatus({ supported: false })),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Скачать свежий APK" }));

    await waitFor(() =>
      expect(openDownloadUrl).toHaveBeenCalledWith(
        "https://codex.home.arpa",
        "https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/CodexNest-latest.apk",
      ),
    );
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
    expect(api.updateApp).not.toHaveBeenCalled();
  });

  it("shows an error when the APK download cannot be opened", async () => {
    openDownloadUrl.mockRejectedValueOnce(new Error("browser failed"));
    const api = {
      settings: { baseUrl: "https://codex.home.arpa" },
      readAppSettings: vi.fn(async () => updateStatus()),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Скачать свежий APK" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось открыть загрузку APK");
  });

  it("shows an error when the Chrome extension download cannot be opened", async () => {
    openDownloadUrl.mockRejectedValueOnce(new Error("browser failed"));
    const api = {
      settings: { baseUrl: "https://codex.home.arpa" },
      readAppSettings: vi.fn(async () => updateStatus()),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    render(<ApplicationSettingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Скачать расширение для Chrome" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось открыть загрузку расширения для Chrome",
    );
  });

  it("keeps polling across a restart and shows the final updater result", async () => {
    vi.useFakeTimers();
    const preparing = updateStatus({
      latestVersion: "0.2.0",
      updateAvailable: true,
      operation: "restarting",
    });
    const updated = updateStatus({
      currentVersion: "0.2.0",
      latestVersion: "0.2.0",
      updateAvailable: false,
      result: "updated",
      message: "CodexNest was updated successfully",
    });
    const api = {
      readAppSettings: vi
        .fn()
        .mockResolvedValueOnce(preparing)
        .mockRejectedValueOnce(new Error("server restarting"))
        .mockResolvedValue(updated),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    connection.mockReturnValue({ api, state: { network: "connected" } });

    try {
      render(<ApplicationSettingsCard />);
      await act(async () => Promise.resolve());
      expect(screen.getByText("Перезапуск")).toBeInTheDocument();

      await act(async () => vi.advanceTimersByTimeAsync(1_500));
      await act(async () => vi.advanceTimersByTimeAsync(1_500));

      expect(api.readAppSettings).toHaveBeenCalledTimes(3);
      expect(screen.getByText("CodexNest was updated successfully")).toBeInTheDocument();
      expect(screen.getByText("Обновлено")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads the final updater result after the server reconnects", async () => {
    const interrupted = updateStatus({
      latestVersion: "0.2.0",
      updateAvailable: true,
      result: "failed",
      message: "Update interrupted",
    });
    const updated = updateStatus({
      currentVersion: "0.2.0",
      latestVersion: "0.2.0",
      updateAvailable: false,
      result: "updated",
      message: "CodexNest was updated successfully",
    });
    const api = {
      readAppSettings: vi.fn().mockResolvedValueOnce(interrupted).mockResolvedValue(updated),
      checkAppUpdate: vi.fn(),
      updateApp: vi.fn(),
    };
    let network = "connected";
    connection.mockImplementation(() => ({ api, state: { network } }));

    const view = render(<ApplicationSettingsCard />);
    expect(await screen.findByText("Update interrupted")).toBeInTheDocument();

    network = "offline";
    view.rerender(<ApplicationSettingsCard />);
    network = "connected";
    view.rerender(<ApplicationSettingsCard />);

    expect(await screen.findByText("CodexNest was updated successfully")).toBeInTheDocument();
    expect(screen.getByText("Обновлено")).toBeInTheDocument();
  });
});

function updateStatus(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    supported: true,
    canUpdateWithActiveTurns: false,
    currentVersion: "0.1.0",
    latestVersion: null,
    updateAvailable: null,
    operation: "idle",
    result: "none",
    message: null,
    checkedAt: null,
    updatedAt: null,
    ...overrides,
  };
}
