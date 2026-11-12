import { ActionLabel } from "./ActionLabel";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import type { CodexManagementStatus } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { ToolIcon } from "./Icons";
import { SettingsGroup, SettingsRow } from "./SettingsPresentation";

type Action = "checking" | "proxy" | "updating" | "restarting" | null;
type Feedback = { kind: "error" | "success"; message: string } | null;

type CodexSettingsContextValue = {
  status: CodexManagementStatus | null;
  loading: boolean;
  action: Action;
  proxy: string;
  showProxy: boolean;
  loadError: string | null;
  codexFeedback: Feedback;
  proxyFeedback: Feedback;
  activeTurnCount: number;
  secure: boolean;
  supported: boolean;
  busy: boolean;
  maintenanceDisabled: boolean;
  setProxy(value: string): void;
  setShowProxy(value: boolean | ((current: boolean) => boolean)): void;
  applyProxy(event: FormEvent): Promise<void>;
  check(): Promise<void>;
  update(): Promise<void>;
  restart(): Promise<void>;
};

const CodexSettingsContext = createContext<CodexSettingsContextValue | null>(null);

export function CodexSettingsProvider({
  children,
  onStatusChange,
}: {
  children: ReactNode;
  onStatusChange?(status: CodexManagementStatus): void;
}) {
  const { api, state } = useConnection();
  const { language, t } = useI18n();
  const localizationRef = useRef({ language, t });
  localizationRef.current = { language, t };
  const [status, setStatus] = useState<CodexManagementStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action>(null);
  const [proxy, setProxy] = useState("");
  const [showProxy, setShowProxy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [codexFeedback, setCodexFeedback] = useState<Feedback>(null);
  const [proxyFeedback, setProxyFeedback] = useState<Feedback>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await api.readCodexSettings());
    } catch (caught) {
      const localization = localizationRef.current;
      setLoadError(
        errorMessage(
          caught,
          localization.t("Не удалось загрузить состояние Codex"),
          localization.language,
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!status || status.operation === "idle") return;
    const timer = window.setTimeout(() => {
      void api
        .readCodexSettings()
        .then(setStatus)
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [api, status]);

  useEffect(() => {
    if (status) onStatusChange?.(status);
  }, [onStatusChange, status]);

  const liveThreads = state?.snapshot?.threads;
  const activeTurnCount = liveThreads
    ? liveThreads.filter((thread) => thread.currentTurnId !== null).length
    : (status?.activeTurnCount ?? 0);
  const secure = secureServerUrl(api.settings.baseUrl);
  const supported = status?.supported ?? false;
  const busy = action !== null || (status !== null && status.operation !== "idle");
  const maintenanceDisabled = !supported || busy || activeTurnCount > 0;

  async function applyProxy(event: FormEvent) {
    event.preventDefault();
    if (!secure || !proxy.trim()) return;
    await perform("proxy", "proxy", async () => {
      const updated = await api.updateCodexProxy({ proxy });
      setStatus(updated);
      setProxy("");
      setShowProxy(false);
      setProxyFeedback({
        kind: "success",
        message: t("Прокси проверен и применён. Codex daemon готов к работе."),
      });
    });
  }

  async function check() {
    await perform("checking", "codex", async () => {
      const updated = await api.checkCodex();
      setStatus(updated);
      setCodexFeedback({
        kind: "success",
        message: t("Проверка Codex и соединения через прокси завершена."),
      });
    });
  }

  async function update() {
    if (!window.confirm(t("Обновить Codex и перезапустить daemon?"))) return;
    await perform("updating", "codex", async () => {
      const updated = await api.updateCodex();
      setStatus(updated);
      setCodexFeedback({
        kind: "success",
        message: t("Codex обновлён, проверен через прокси и перезапущен."),
      });
    });
  }

  async function restart() {
    if (!window.confirm(t("Перезапустить Codex daemon?"))) return;
    await perform("restarting", "codex", async () => {
      const updated = await api.restartCodex();
      setStatus(updated);
      setCodexFeedback({ kind: "success", message: t("Codex daemon перезапущен.") });
    });
  }

  async function perform(
    nextAction: Exclude<Action, null>,
    target: "codex" | "proxy",
    task: () => Promise<void>,
  ) {
    setAction(nextAction);
    if (target === "codex") setCodexFeedback(null);
    else setProxyFeedback(null);
    try {
      await task();
    } catch (caught) {
      const feedback: Feedback = {
        kind: "error",
        message: errorMessage(caught, t("Операция Codex завершилась ошибкой"), language),
      };
      if (target === "codex") setCodexFeedback(feedback);
      else setProxyFeedback(feedback);
      try {
        setStatus(await api.readCodexSettings());
      } catch {
        // Keep the operation error visible when refreshing status also fails.
      }
    } finally {
      setAction(null);
    }
  }

  return (
    <CodexSettingsContext.Provider
      value={{
        status,
        loading,
        action,
        proxy,
        showProxy,
        loadError,
        codexFeedback,
        proxyFeedback,
        activeTurnCount,
        secure,
        supported,
        busy,
        maintenanceDisabled,
        setProxy,
        setShowProxy,
        applyProxy,
        check,
        update,
        restart,
      }}
    >
      {children}
    </CodexSettingsContext.Provider>
  );
}

export function CodexSettingsCard() {
  const { language, t } = useI18n();
  const {
    status,
    loading,
    action,
    loadError,
    codexFeedback,
    activeTurnCount,
    supported,
    busy,
    maintenanceDisabled,
    check,
    update,
    restart,
  } = useCodexSettings();

  return (
    <SettingsGroup
      loading={loading}
      className="codex-settings-card"
      description={t("Версия и состояние Codex daemon на сервере.")}
      icon={<ToolIcon />}
      title="Codex CLI"
    >
      {loading && (
        <span className="sr-only" role="status">
          {t("Получаем состояние Codex…")}
        </span>
      )}
      <>
        <dl className="settings-status-list">
          <div>
            <dt>{t("Установленная версия Codex CLI")}</dt>
            <dd className="settings-technical">{status?.cliVersion ?? "—"}</dd>
          </div>
          <div>
            <dt>Daemon</dt>
            <dd className="settings-technical">{status?.appServerVersion ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("Состояние")}</dt>
            <dd>{daemonLabel(status?.daemonStatus, t)}</dd>
          </div>
          <div>
            <dt>{t("Актуальная версия Codex CLI")}</dt>
            <dd className="settings-technical">{status?.latestVersion ?? t("Не проверялась")}</dd>
          </div>
        </dl>

        <div className="settings-feedback-slot">
          {status?.unavailableReason && (
            <div className="settings-notice warning" role="status">
              {localizeKnownServerText(language, status.unavailableReason) ??
                status.unavailableReason}
            </div>
          )}
          {activeTurnCount > 0 && (
            <div className="settings-notice warning" role="status">
              {t("Дождитесь завершения активных ответов: {{count}}.", {
                count: activeTurnCount,
              })}
            </div>
          )}
          {loadError && (
            <div className="settings-notice danger" role="alert">
              {loadError}
            </div>
          )}
          <SettingsFeedback feedback={codexFeedback} />
        </div>

        <div className="settings-actions codex-actions">
          <button disabled={!supported || busy} type="button" onClick={() => void check()}>
            <ActionLabel
              idle={t("Проверить Codex CLI")}
              busy={t("Проверяем…")}
              pending={action === "checking"}
            />
          </button>
          <button
            disabled={maintenanceDisabled || status?.updateAvailable !== true}
            type="button"
            onClick={() => void update()}
          >
            <ActionLabel
              idle={t("Обновить Codex CLI")}
              busy={t("Обновляем…")}
              pending={action === "updating"}
            />
          </button>
          <button disabled={maintenanceDisabled} type="button" onClick={() => void restart()}>
            <ActionLabel
              idle={t("Перезапустить")}
              busy={t("Перезапускаем…")}
              pending={action === "restarting"}
            />
          </button>
        </div>
      </>
    </SettingsGroup>
  );
}

export function ProxySettingsCard() {
  const { language, t } = useI18n();
  const {
    status,
    loading,
    action,
    proxy,
    showProxy,
    loadError,
    proxyFeedback,
    secure,
    supported,
    busy,
    maintenanceDisabled,
    setProxy,
    setShowProxy,
    applyProxy,
  } = useCodexSettings();

  return (
    <SettingsGroup
      loading={loading}
      className="codex-settings-card"
      description={t(
        "Подключение общего Codex. Для сохранённых аккаунтов прокси настраивается в разделе аккаунтов.",
      )}
      icon={<ToolIcon />}
      title={t("Прокси")}
    >
      {loading && (
        <span className="sr-only" role="status">
          {t("Получаем состояние прокси…")}
        </span>
      )}
      <>
        <SettingsRow className="codex-proxy-summary" label={t("Текущий прокси")}>
          <code>{proxySummary(status, language, t)}</code>
        </SettingsRow>

        <div className="settings-feedback-slot">
          {status?.networkStatus === "ok" && (
            <div className="settings-notice success" role="status">
              {t("WebSocket ChatGPT/OpenAI доступен через прокси.")}
            </div>
          )}
          {!secure && (
            <div className="settings-notice danger" role="alert">
              {t("Ввод прокси с паролем доступен только через HTTPS или локальное подключение.")}
            </div>
          )}
          {loadError && (
            <div className="settings-notice danger" role="alert">
              {loadError}
            </div>
          )}

          <SettingsFeedback feedback={proxyFeedback} />
        </div>
        <form className="codex-proxy-form" onSubmit={applyProxy}>
          <SettingsRow
            description={t("Будет проверен до перезапуска Codex daemon.")}
            label={t("Новый HTTP/HTTPS-прокси")}
            labelFor="settings-codex-proxy"
          >
            <span className="codex-proxy-input">
              <input
                autoComplete="off"
                disabled={!supported || busy || !secure}
                id="settings-codex-proxy"
                placeholder="host:port:user:password"
                spellCheck={false}
                type={showProxy ? "text" : "password"}
                value={proxy}
                onChange={(event) => setProxy(event.target.value)}
              />
              <button
                disabled={!proxy}
                type="button"
                onClick={() => setShowProxy((current) => !current)}
              >
                <ActionLabel idle={t("Показать")} busy={t("Скрыть")} pending={showProxy} />
              </button>
            </span>
          </SettingsRow>
          <small>
            {t(
              "Форматы: host:port, host:port:user:password, user:password@host:port или полный URL.",
            )}
          </small>
          <div className="settings-actions codex-actions">
            <button
              className="primary"
              disabled={maintenanceDisabled || !secure || !proxy.trim()}
              type="submit"
            >
              <ActionLabel
                idle={t("Проверить и применить")}
                busy={t("Проверяем и применяем…")}
                pending={action === "proxy"}
              />
            </button>
          </div>
        </form>
      </>
    </SettingsGroup>
  );
}

function useCodexSettings(): CodexSettingsContextValue {
  const value = useContext(CodexSettingsContext);
  if (!value) throw new Error("Codex settings cards must be inside CodexSettingsProvider");
  return value;
}

function SettingsFeedback({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <div
      className={`settings-notice ${feedback.kind === "error" ? "danger" : "success"}`}
      role={feedback.kind === "error" ? "alert" : "status"}
    >
      {feedback.message}
    </div>
  );
}

function proxySummary(
  status: CodexManagementStatus | null,
  language: "en" | "ru",
  t: Translate,
): string {
  const proxy = status?.proxy;
  if (!proxy) return "—";
  if (proxy.error) return localizeKnownServerText(language, proxy.error) ?? proxy.error;
  if (!proxy.configured) return t("Не настроен");
  const user = proxy.username ? ` · ${proxy.username}` : "";
  const password = proxy.hasPassword ? t(" · пароль сохранён") : "";
  return `${proxy.protocol}://${proxy.host}:${proxy.port}${user}${password}`;
}

function daemonLabel(value: string | undefined, t: Translate): string {
  if (value === "running") return t("Работает");
  if (value === "unsupported") return t("Не поддерживается");
  if (!value || value === "unavailable") return t("Недоступен");
  return value;
}

function secureServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function errorMessage(error: unknown, fallback: string, language: "en" | "ru"): string {
  return error instanceof Error
    ? (localizeKnownServerText(language, error.message) ?? error.message)
    : fallback;
}
