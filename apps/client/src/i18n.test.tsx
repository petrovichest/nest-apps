import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  I18nProvider,
  localizeKnownServerText,
  readInitialLanguage,
  translate,
  useI18n,
} from "./i18n";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = "";
});

describe("interface localization", () => {
  it("defaults fresh clients to English and preserves Russian for legacy clients", () => {
    expect(readInitialLanguage()).toBe("en");

    localStorage.setItem("codexnest.theme", "dark");
    expect(readInitialLanguage()).toBe("ru");

    localStorage.setItem("codexnest.uiLanguage", "en");
    expect(readInitialLanguage()).toBe("en");
  });

  it("translates variables and changes the document language", () => {
    expect(translate("en", "Показать ещё {{count}}", { count: 3 })).toBe("Show 3 more");
    expect(translate("en", "Это сообщение уже отправлено")).toBe(
      "This message has already been sent",
    );

    render(
      <I18nProvider>
        <LanguageProbe />
      </I18nProvider>,
    );
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Настройки")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("ru");
    expect(localStorage.getItem("codexnest.uiLanguage")).toBe("ru");
  });

  it("localizes the Team shutdown conflict", () => {
    expect(
      localizeKnownServerText(
        "en",
        "Нельзя выключить Team, пока субагенты работают или их результаты ещё не обработаны. Попросите главного агента завершить или отменить их.",
      ),
    ).toBe(
      "Team mode cannot be disabled while subagents are running or their results are still pending. Ask the root agent to finish or cancel them.",
    );
  });

  it("localizes a recording without detected speech", () => {
    expect(localizeKnownServerText("ru", "No speech was detected in the recording")).toBe(
      "В записи не обнаружена речь. Проверьте микрофон и запишите ещё раз.",
    );
    expect(localizeKnownServerText("en", "No speech was detected in the recording")).toBe(
      "No speech was detected. Check your microphone and record again.",
    );
  });

  it("localizes Fast mode availability and usage", () => {
    expect(translate("en", "Fast mode по умолчанию")).toBe("Fast mode by default");
    expect(translate("en", "Ускоряет ответы Codex и увеличивает расход лимитов.")).toBe(
      "Speeds up Codex responses and increases quota usage.",
    );
    expect(localizeKnownServerText("ru", "Fast mode is not supported by the selected model")).toBe(
      "Fast mode недоступен для этой модели.",
    );
  });

  it("localizes reliable fork choices and pending states", () => {
    expect(translate("en", "Создать ветку")).toBe("Create a fork");
    expect(translate("en", "Компактная")).toBe("Compact");
    expect(translate("en", "Полная история")).toBe("Full history");
    expect(translate("en", "Сверяем контекст")).toBe("Reconciling context");
    expect(translate("en", "Контекст перенесён в сжатом виде из исходной ветки.")).toBe(
      "Context was transferred from the source branch in compressed form.",
    );
  });

  it("localizes rich Team result metadata", () => {
    expect(translate("en", "Статус результата: {{status}}", { status: "Partial" })).toBe(
      "Result status: Partial",
    );
    expect(translate("en", "Проверки результата")).toBe("Result checks");
    expect(translate("en", "Показано {{shown}} из {{total}}", { shown: 20, total: 24 })).toBe(
      "Showing 20 of 24",
    );
    expect(translate("en", "Изменения интегрированы")).toBe("Changes integrated");
    expect(translate("en", "Исчерпан бюджет токенов")).toBe("Token budget exhausted");
  });

  it("describes the shared Claude APK release and server rollback accurately", () => {
    expect(
      translate(
        "en",
        "Сервер, веб-интерфейс и APK выпускаются из одной проверенной CI-сборки. При неудачном обновлении сервер автоматически возвращается к предыдущей версии.",
      ),
    ).toBe(
      "The server, web interface, and APK are released from the same verified CI build. If a server update fails, the server automatically returns to the previous version.",
    );
  });
});

function LanguageProbe() {
  const { language, setLanguage, t } = useI18n();
  return (
    <button type="button" onClick={() => setLanguage(language === "en" ? "ru" : "en")}>
      {t("Настройки")}
    </button>
  );
}
