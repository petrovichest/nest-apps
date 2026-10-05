import { application } from "./application";
import { useSyncExternalStore } from "react";

export const TYPOGRAPHY_KEY = `${application.storagePrefix}.typography`;
export const TYPOGRAPHY_MIN = 10;
export const TYPOGRAPHY_MAX = 32;

export const TYPOGRAPHY_ROLES = {
  ui: { size: 14, token: "--text-ui", label: "Основной интерфейс", example: "Проекты · Настройки" },
  message: {
    size: 15,
    token: "--text-input",
    label: "Сообщения и поля ввода",
    example: "Напишите сообщение",
  },
  description: {
    size: 14,
    token: "--text-small",
    label: "Описания и пояснения",
    example: "Настройки на этом устройстве",
  },
  technical: {
    size: 14,
    token: "--text-code",
    label: "Код, логи и таблицы",
    example: "npm run build · 128 ms",
  },
  caption: {
    size: 12,
    token: "--text-caption",
    label: "Метаданные и компактные действия",
    example: "Сегодня, 12:30 · 3 файла",
  },
  micro: { size: 12, token: "--text-micro", label: "Мелкие индикаторы", example: "PNG · 12" },
  section: { size: 14, token: "--text-section", label: "Заголовки разделов", example: "Интерфейс" },
  dialog: {
    size: 14,
    token: "--text-dialog",
    label: "Заголовки диалогов и пустых состояний",
    example: "Новая задача",
  },
  display: {
    size: 22,
    token: "--text-display",
    label: "Заголовок экрана подключения",
    example: "Подключение к CodexNest",
  },
} as const;

export type TypographyRole = keyof typeof TYPOGRAPHY_ROLES;
export type TypographySettings = Record<TypographyRole, number>;
export const TYPOGRAPHY_DEFAULTS = Object.fromEntries(
  Object.entries(TYPOGRAPHY_ROLES).map(([role, definition]) => [role, definition.size]),
) as TypographySettings;

export function isFontSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= TYPOGRAPHY_MIN &&
    value <= TYPOGRAPHY_MAX
  );
}

export function parseTypography(serialized: string | null): TypographySettings {
  let value: unknown;
  try {
    value = JSON.parse(serialized ?? "null");
  } catch {
    return { ...TYPOGRAPHY_DEFAULTS };
  }
  const result = { ...TYPOGRAPHY_DEFAULTS };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const role of Object.keys(result) as TypographyRole[]) {
    const size = (value as Record<string, unknown>)[role];
    if (isFontSize(size)) result[role] = size;
  }
  return result;
}

let current = TYPOGRAPHY_DEFAULTS;
const listeners = new Set<() => void>();

function apply(settings: TypographySettings) {
  current = settings;
  const root = document.documentElement;
  for (const role of Object.keys(TYPOGRAPHY_ROLES) as TypographyRole[]) {
    root.style.setProperty(TYPOGRAPHY_ROLES[role].token, `${settings[role]}px`);
  }
  root.toggleAttribute(
    "data-custom-typography",
    Object.keys(settings).some(
      (key) => settings[key as TypographyRole] !== TYPOGRAPHY_DEFAULTS[key as TypographyRole],
    ),
  );
  listeners.forEach((listener) => listener());
}

/** Runs before React paints, including the disconnected setup screen. */
export function initializeTypography(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(TYPOGRAPHY_KEY);
  } catch {
    /* Use defaults when storage is unavailable. */
  }
  apply(parseTypography(stored));
}

function persist(settings: TypographySettings) {
  apply(settings);
  try {
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(settings));
  } catch {
    /* Changes still apply for this session. */
  }
}

export function setTypographySize(role: TypographyRole, size: number): void {
  if (isFontSize(size) && current[role] !== size) persist({ ...current, [role]: size });
}

export function resetTypography(): void {
  persist({ ...TYPOGRAPHY_DEFAULTS });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTypography(): TypographySettings {
  return useSyncExternalStore(subscribe, () => current);
}
