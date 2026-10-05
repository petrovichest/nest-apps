import { application } from "./application";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

import type { UiLanguage } from "@codexnest/protocol";

import { translate } from "./i18n";

export interface ConnectionSettings {
  baseUrl: string;
  token: string;
}

const URL_KEY = `${application.storagePrefix}.serverUrl`;
const TOKEN_KEY = `${application.storagePrefix}.token`;

export async function loadConnectionSettings(): Promise<ConnectionSettings | null> {
  if (Capacitor.isNativePlatform()) {
    const [{ value: baseUrl }, token] = await Promise.all([
      Preferences.get({ key: URL_KEY }),
      SecureStorage.get(TOKEN_KEY),
    ]);
    return typeof baseUrl === "string" && typeof token === "string" ? { baseUrl, token } : null;
  }
  const baseUrl = localStorage.getItem(URL_KEY);
  const token = localStorage.getItem(TOKEN_KEY);
  return baseUrl && token ? { baseUrl, token } : null;
}

export async function saveConnectionSettings(settings: ConnectionSettings): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Promise.all([
      Preferences.set({ key: URL_KEY, value: settings.baseUrl }),
      SecureStorage.set(TOKEN_KEY, settings.token),
    ]);
    return;
  }
  localStorage.setItem(URL_KEY, settings.baseUrl);
  localStorage.setItem(TOKEN_KEY, settings.token);
}

export async function clearConnectionSettings(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Promise.all([Preferences.remove({ key: URL_KEY }), SecureStorage.remove(TOKEN_KEY)]);
    return;
  }
  localStorage.removeItem(URL_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

export function normalizeBaseUrl(value: string, language: UiLanguage = "ru"): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(translate(language, "Разрешены только адреса http:// и https://"));
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}
