import { application } from "./application";
import { useCallback, useEffect, useState } from "react";
import { Capacitor, SystemBars, SystemBarsStyle, SystemBarType } from "@capacitor/core";

const THEME_KEY = `${application.storagePrefix}.theme`;
const DARK_THEME_QUERY = "(prefers-color-scheme: dark)";
const THEME_COLOR = { dark: "#171817", light: "#FFFFFF" } as const;

export type ThemeMode = "dark" | "light" | "system";

function themeMode(value: string | null): ThemeMode {
  return value === "dark" || value === "light" ? value : "system";
}

function storedTheme(): ThemeMode {
  try {
    return themeMode(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** Owned by Root so setup, loading and the connected app share one lifecycle. */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(storedTheme);
  const onThemeChange = useCallback((value: string) => setTheme(themeMode(value)), []);

  useEffect(() => {
    const colorScheme = window.matchMedia(DARK_THEME_QUERY);
    const android = Capacitor.getPlatform() === "android";
    const syncTheme = () => {
      const resolved =
        theme === "dark" || (theme === "system" && colorScheme.matches) ? "dark" : "light";
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.resolvedTheme = resolved;
      let themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (!themeColor) {
        themeColor = document.createElement("meta");
        themeColor.name = "theme-color";
        document.head.append(themeColor);
      }
      themeColor.content = THEME_COLOR[resolved];

      // Android 15+ supplies edge-to-edge insets. Older versions keep opaque,
      // OS-themed bars and must retain matching OS-themed icons.
      if (!android || !document.documentElement.style.getPropertyValue("--safe-area-inset-top"))
        return;
      const style = resolved === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light;
      // The IME owns its navigation bar; target each app-window bar explicitly.
      void SystemBars.setStyle({ bar: SystemBarType.StatusBar, style }).catch(() => undefined);
      void SystemBars.setStyle({ bar: SystemBarType.NavigationBar, style }).catch(() => undefined);
    };
    syncTheme();
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Applying a theme must not depend on storage availability.
    }
    colorScheme.addEventListener("change", syncTheme);
    if (android) window.addEventListener("codexnest:system-bars-reset", syncTheme);
    return () => {
      colorScheme.removeEventListener("change", syncTheme);
      window.removeEventListener("codexnest:system-bars-reset", syncTheme);
    };
  }, [theme]);

  return { theme, onThemeChange };
}
