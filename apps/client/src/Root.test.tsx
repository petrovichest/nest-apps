import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CapacitorCore from "@capacitor/core";

import { Root } from "./Root";
import type { ConnectionSettings } from "./storage";
import type * as ConnectionStorage from "./storage";

const native = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  setStyle: vi.fn().mockResolvedValue(undefined),
}));
const loadConnection = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", async (original) => ({
  ...(await original<typeof CapacitorCore>()),
  Capacitor: {
    getPlatform: native.getPlatform,
    isNativePlatform: () => native.getPlatform() !== "web",
  },
  SystemBars: { setStyle: native.setStyle },
  SystemBarsStyle: { Dark: "DARK", Light: "LIGHT" },
  SystemBarType: { StatusBar: "StatusBar", NavigationBar: "NavigationBar" },
}));
vi.mock("./storage", async (original) => ({
  ...(await original<typeof ConnectionStorage>()),
  loadConnectionSettings: loadConnection,
}));
vi.mock("./connection", () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./App", () => ({
  App: ({
    onDisconnected,
    onThemeChange,
  }: {
    onDisconnected(): void;
    onThemeChange(theme: string): void;
  }) => (
    <>
      <button onClick={() => onThemeChange("dark")}>Dark theme</button>
      <button onClick={onDisconnected}>Switch server</button>
    </>
  ),
}));

const listeners = new Set<() => void>();
let systemDark = false;

beforeEach(() => {
  localStorage.clear();
  native.getPlatform.mockReturnValue("web");
  native.setStyle.mockClear();
  loadConnection.mockReset().mockResolvedValue(null);
  systemDark = false;
  listeners.clear();
  document.documentElement.style.removeProperty("--safe-area-inset-top");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return systemDark;
      },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--safe-area-inset-top");
});

describe("Theme before connection", () => {
  it("follows the system while loading credentials and on the setup screen", async () => {
    let finishLoading!: (value: ConnectionSettings | null) => void;
    loadConnection.mockReturnValue(
      new Promise((resolve) => {
        finishLoading = resolve;
      }),
    );
    systemDark = true;
    const view = render(<Root />);
    expect(screen.getByText("CodexNest")).toHaveClass("splash");
    expect(document.documentElement.dataset.resolvedTheme).toBe("dark");

    await act(async () => finishLoading(null));
    expect(screen.getByRole("heading", { name: "Подключение к CodexNest" })).toBeVisible();
    systemDark = false;
    act(() => listeners.forEach((listener) => listener()));
    expect(document.documentElement.dataset.resolvedTheme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#FFFFFF",
    );
    expect(native.setStyle).not.toHaveBeenCalled();
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it.each(["light", "dark"])(
    "uses the saved %s theme and reapplies native icons before login",
    async (theme) => {
      localStorage.setItem("codexnest.theme", theme);
      systemDark = theme === "light";
      native.getPlatform.mockReturnValue("android");
      const view = render(<Root />);
      await screen.findByRole("heading", { name: "Подключение к CodexNest" });
      expect(document.documentElement.dataset.resolvedTheme).toBe(theme);
      // Insets arrive after mount on Android 15+. Older Android keeps OS-owned bars.
      expect(native.setStyle).not.toHaveBeenCalled();
      document.documentElement.style.setProperty("--safe-area-inset-top", "24px");
      act(() => window.dispatchEvent(new Event("codexnest:system-bars-reset")));
      expect(native.setStyle.mock.calls).toEqual([
        [{ bar: "StatusBar", style: theme.toUpperCase() }],
        [{ bar: "NavigationBar", style: theme.toUpperCase() }],
      ]);
      view.unmount();
      native.setStyle.mockClear();
      window.dispatchEvent(new Event("codexnest:system-bars-reset"));
      expect(native.setStyle).not.toHaveBeenCalled();
    },
  );

  it("keeps a theme chosen after connection when returning to setup", async () => {
    loadConnection.mockResolvedValue({ baseUrl: "https://pi.local", token: "test-token" });
    render(<Root />);
    fireEvent.click(await screen.findByRole("button", { name: "Dark theme" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch server" }));
    expect(screen.getByRole("heading", { name: "Подключение к CodexNest" })).toBeVisible();
    expect(document.documentElement.dataset.resolvedTheme).toBe("dark");
    expect(localStorage.getItem("codexnest.theme")).toBe("dark");
    expect(listeners.size).toBe(1);
    act(() => listeners.forEach((listener) => listener()));
    expect(document.documentElement.dataset.resolvedTheme).toBe("dark");
  });
});
