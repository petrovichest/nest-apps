import { application } from "../application";
import { ActionLabel } from "./ActionLabel";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import type { AppUpdateStatus } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { openDownloadUrl } from "../downloads";
import {
  ArrowUpIcon,
  BrowserIcon,
  DownloadIcon,
  GitHubIcon,
  RefreshIcon,
  ServerIcon,
} from "./Icons";
import { SettingsGroup } from "./SettingsPresentation";

type Action = "checking" | "updating" | null;

const LATEST_ANDROID_APK_URL = `https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/${application.name}-latest.apk`;
const LATEST_CHROME_EXTENSION_URL = `https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/${application.name.toLowerCase()}-browser-latest.zip`;
const REPOSITORY_URL = "https://github.com/petrovichest/nest-apps";

export function ApplicationSettingsCard({
  initialStatus,
  onStatusChange,
  poll = true,
}: {
  initialStatus?: AppUpdateStatus | null;
  poll?: boolean;
  onStatusChange?(status: AppUpdateStatus): void;
}) {
  const { api, state } = useConnection();
  const { language, t } = useI18n();
  const actionsId = useId();
  const localizationRef = useRef({ language, t });
  localizationRef.current = { language, t };
  const [status, setStatus] = useState<AppUpdateStatus | null>(initialStatus ?? null);
  const hasStatus = useRef(initialStatus !== null && initialStatus !== undefined);
  const [loading, setLoading] = useState(initialStatus === null || initialStatus === undefined);
  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);
  const [apkVersion, setApkVersion] = useState<string | null>(null);
  const [apkVersionFailed, setApkVersionFailed] = useState(false);
  const nativePlatform = Capacitor.isNativePlatform();
  const apkVersionLabel = nativePlatform
    ? (apkVersion ?? (apkVersionFailed ? t("Не удалось определить") : t("Определяем…")))
    : t("Только в Android");

  useEffect(() => {
    if (!initialStatus) return;
    hasStatus.current = true;
    setStatus(initialStatus);
    setLoading(false);
  }, [initialStatus]);

  const load = useCallback(async () => {
    setLoading(!hasStatus.current);
    try {
      const next = await api.readAppSettings();
      hasStatus.current = true;
      setStatus(next);
      onStatusChange?.(next);
      setError(null);
    } catch (caught) {
      const localization = localizationRef.current;
      setError(
        message(
          caught,
          localization.t("Не удалось получить состояние CodexNest"),
          localization.language,
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [api, onStatusChange]);

  useEffect(() => {
    if (state.network !== "connected") return;
    void load();
  }, [load, state.network]);

  useEffect(() => {
    if (!nativePlatform) return;
    let active = true;
    void CapacitorApp.getInfo()
      .then((info) => {
        if (active) setApkVersion(`${info.version} (${info.build})`);
      })
      .catch(() => {
        if (active) setApkVersionFailed(true);
      });
    return () => {
      active = false;
    };
  }, [nativePlatform]);

  useEffect(() => {
    if (!poll || !status || status.operation === "idle") return;
    const timer = window.setInterval(() => {
      void api
        .readAppSettings()
        .then((updated) => {
          setStatus(updated);
          onStatusChange?.(updated);
          if (updated.operation === "idle") setAction(null);
        })
        .catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [api, onStatusChange, poll, status]);

  async function check() {
    setAction("checking");
    setError(null);
    try {
      const next = await api.checkAppUpdate();
      setStatus(next);
      onStatusChange?.(next);
    } catch (caught) {
      setError(message(caught, t("Не удалось проверить обновления CodexNest"), language));
    } finally {
      setAction(null);
    }
  }

  async function update() {
    const target = status?.latestVersion
      ? t(" до версии {{version}}", { version: status.latestVersion })
      : "";
    if (
      !window.confirm(
        t("Обновить CodexNest{{target}}? Интерфейс ненадолго переподключится.", { target }),
      )
    ) {
      return;
    }
    setAction("updating");
    setError(null);
    try {
      const next = await api.updateApp();
      setStatus(next);
      onStatusChange?.(next);
    } catch (caught) {
      setAction(null);
      setError(message(caught, t("Не удалось запустить обновление CodexNest"), language));
    }
  }

  async function downloadApk() {
    setError(null);
    try {
      await openDownloadUrl(api.settings.baseUrl, LATEST_ANDROID_APK_URL);
    } catch {
      setError(t("Не удалось открыть загрузку APK"));
    }
  }

  async function downloadChromeExtension() {
    setError(null);
    try {
      await openDownloadUrl(api.settings.baseUrl, LATEST_CHROME_EXTENSION_URL);
    } catch {
      setError(t("Не удалось открыть загрузку расширения для Chrome"));
    }
  }

  async function openRepository() {
    setError(null);
    try {
      await Browser.open({ url: REPOSITORY_URL });
    } catch {
      setError(t("Не удалось открыть GitHub"));
    }
  }

  const activeTurnCount =
    state.snapshot?.threads?.filter((thread) => thread.currentTurnId !== null).length ?? 0;
  const activeTurnsBlockUpdate = activeTurnCount > 0 && status?.canUpdateWithActiveTurns !== true;
  const busy = action !== null || (status !== null && status.operation !== "idle");

  return (
    <SettingsGroup
      loading={loading}
      className="application-settings-card"
      description={t(
        application.isClaude
          ? "Сервер, веб-интерфейс и APK выпускаются из одной проверенной CI-сборки. При неудачном обновлении сервер автоматически возвращается к предыдущей версии."
          : "Сервер, APK и расширение для Chrome обновляются из одной проверенной CI-сборки с автоматическим откатом.",
      )}
      icon={<ServerIcon />}
      title={t("Обновление CodexNest")}
    >
      {loading && (
        <span className="sr-only" role="status">
          {t("Получаем версию CodexNest…")}
        </span>
      )}
      <>
        <dl className="settings-status-list">
          <div>
            <dt>{t("Установлено на сервере")}</dt>
            <dd className="settings-technical">{status?.currentVersion ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("Актуальная версия в GitHub")}</dt>
            <dd className="settings-technical">{status?.latestVersion ?? t("Не проверялась")}</dd>
          </div>
          <div>
            <dt>{t("APK на этом устройстве")}</dt>
            <dd className="settings-technical">{apkVersionLabel}</dd>
          </div>
          <div>
            <dt>{t("Состояние")}</dt>
            <dd>{operationLabel(status?.operation, t)}</dd>
          </div>
          <div>
            <dt>{t("Результат")}</dt>
            <dd>{resultLabel(status?.result, t)}</dd>
          </div>
        </dl>

        <div className="settings-feedback-slot">
          {!loading && !status?.supported && (
            <div className="settings-notice warning" role="status">
              {status?.message
                ? (localizeKnownServerText(language, status.message) ?? status.message)
                : t("Обновления доступны только для установки через install.sh.")}
            </div>
          )}
          {status?.supported && status.message && (
            <div
              className={`settings-notice ${status.result === "failed" ? "danger" : "success"}`}
              role={status.result === "failed" ? "alert" : "status"}
            >
              {localizeKnownServerText(language, status.message) ?? status.message}
            </div>
          )}
          {activeTurnsBlockUpdate && (
            <div className="settings-notice warning" role="status">
              {t("Дождитесь завершения активных ответов: {{count}}.", {
                count: activeTurnCount,
              })}
            </div>
          )}
          {error && (
            <div className="settings-notice danger" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="application-settings-actions">
          <div
            aria-labelledby={`${actionsId}-update`}
            className="application-settings-action-group"
            role="group"
          >
            <p className="application-settings-action-label" id={`${actionsId}-update`}>
              {t("Обновление")}
            </p>
            <div className="settings-actions application-update-actions">
              <button
                disabled={!status?.supported || busy}
                type="button"
                onClick={() => void check()}
              >
                <RefreshIcon />
                <ActionLabel
                  idle={t("Проверить обновления")}
                  busy={t("Проверяем…")}
                  pending={action === "checking"}
                />
              </button>
              <button
                disabled={
                  !status?.supported ||
                  busy ||
                  activeTurnsBlockUpdate ||
                  status?.updateAvailable !== true
                }
                type="button"
                onClick={() => void update()}
              >
                <ArrowUpIcon />
                <ActionLabel
                  idle={t("Обновить CodexNest")}
                  busy={t("Обновляем…")}
                  pending={
                    action === "updating" || (status !== null && status.operation !== "idle")
                  }
                />
              </button>
            </div>
          </div>
          <div
            aria-labelledby={`${actionsId}-downloads`}
            className="application-settings-action-group"
            role="group"
          >
            <p className="application-settings-action-label" id={`${actionsId}-downloads`}>
              {t("Загрузки и ссылки")}
            </p>
            <div className="settings-actions application-download-actions">
              <a
                className="settings-action-link"
                href={REPOSITORY_URL}
                rel="noopener noreferrer"
                target="_blank"
                onClick={(event) => {
                  if (!nativePlatform) return;
                  event.preventDefault();
                  void openRepository();
                }}
              >
                <GitHubIcon />
                <span>{t("Открыть GitHub")}</span>
              </a>
              <button type="button" onClick={() => void downloadApk()}>
                <DownloadIcon />
                <span>{t("Скачать свежий APK")}</span>
              </button>
              <button type="button" onClick={() => void downloadChromeExtension()}>
                <BrowserIcon />
                <span>{t("Скачать расширение для Chrome")}</span>
              </button>
            </div>
          </div>
        </div>
      </>
    </SettingsGroup>
  );
}

function operationLabel(operation: AppUpdateStatus["operation"] | undefined, t: Translate): string {
  if (!operation || operation === "idle") return t("Готово");
  if (operation === "checking") return t("Проверка");
  if (operation === "preparing") return t("Подготовка");
  if (operation === "building") return t("Сборка");
  if (operation === "switching") return t("Переключение версии");
  return t("Перезапуск");
}

function resultLabel(result: AppUpdateStatus["result"] | undefined, t: Translate): string {
  if (result === "updated") return t("Обновлено");
  if (result === "rolled_back") return t("Выполнен откат");
  if (result === "failed") return t("Ошибка");
  return "—";
}

function message(error: unknown, fallback: string, language: "en" | "ru"): string {
  return error instanceof Error
    ? (localizeKnownServerText(language, error.message) ?? error.message)
    : fallback;
}
