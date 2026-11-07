import { useEffect, useState } from "react";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import type { GeminiConnectionStatus } from "@codexnest/protocol";
import { useConnection } from "../connection";
import { useI18n } from "../i18n";
import { SettingsGroup, SettingsRow } from "./SettingsPresentation";
import { ServerIcon, ShieldIcon } from "./Icons";
import { ActionLabel } from "./ActionLabel";

export function GeminiConnectionSettings() {
  const { api } = useConnection();
  const { t } = useI18n();
  const [status, setStatus] = useState<GeminiConnectionStatus | null>(null);
  const [proxy, setProxy] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const login = status?.login;
  const loggingIn = login && ["starting", "awaiting_code", "exchanging"].includes(login.state);

  useEffect(() => {
    let cancelled = false;
    void api.readGeminiConnection().then(
      (value) => {
        if (!cancelled) setStatus(value);
      },
      () => {
        if (!cancelled) setError(t("Не удалось загрузить настройки Gemini."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, t]);
  useEffect(() => {
    if (!loggingIn) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.readGeminiConnection().then(
        (value) => {
          if (!cancelled) {
            setStatus(value);
            setError(null);
          }
        },
        () => {
          if (!cancelled) setError(t("Связь прервалась. Проверяем состояние входа…"));
        },
      );
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, loggingIn, t]);

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError(null);
    setFeedback(null);
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t("Не удалось выполнить действие. Повторите попытку."),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <SettingsGroup
        icon={<ServerIcon />}
        title={t("Прокси Gemini")}
        description={t(
          "Авторизация и запросы Gemini проходят через этот прокси. Для начала работы сохраните адрес.",
        )}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run("proxy", async () => {
              setStatus(await api.saveGeminiProxy(proxy));
              setProxy("");
              setFeedback(t("Прокси сохранён."));
            });
          }}
        >
          <SettingsRow
            label={t("Адрес прокси")}
            labelFor="gemini-proxy"
            description={
              status?.proxy.configured
                ? t("Настроен: {{address}}", { address: status.proxy.address ?? "" })
                : t("HTTP, HTTPS или SOCKS5. Можно вставить host:port:login:password.")
            }
          >
            <input
              id="gemini-proxy"
              type="password"
              autoComplete="new-password"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder="http://login:password@host:port"
              spellCheck={false}
              disabled={Boolean(busy || loggingIn)}
            />
          </SettingsRow>
          <div className="settings-actions">
            <button
              className="primary"
              type="submit"
              disabled={!proxy.trim() || Boolean(busy || loggingIn)}
            >
              <ActionLabel
                idle={t("Сохранить прокси")}
                busy={t("Сохраняем…")}
                pending={busy === "proxy"}
              />
            </button>
            <button
              type="button"
              disabled={!status?.proxy.configured || Boolean(busy)}
              onClick={() =>
                void run("test", async () => {
                  const result = await api.testGeminiProxy();
                  if (result.ok) setFeedback(t(result.message));
                  else setError(t(result.message));
                })
              }
            >
              <ActionLabel
                idle={t("Проверить соединение")}
                busy={t("Проверяем…")}
                pending={busy === "test"}
              />
            </button>
          </div>
        </form>
      </SettingsGroup>
      <SettingsGroup
        icon={<ShieldIcon />}
        title={t("Аккаунт Google")}
        description={t(
          "Войдите в аккаунт с подпиской Google AI Ultra. Доступ и авторизацию проверяет Antigravity CLI.",
        )}
      >
        <dl className="settings-status-list">
          <div>
            <dt>{t("Состояние")}</dt>
            <dd>{status?.authenticated ? t("Вход выполнен") : t("Требуется вход")}</dd>
          </div>
          <div>
            <dt>Antigravity CLI</dt>
            <dd>{status?.cliVersion ?? t("Не найден")}</dd>
          </div>
        </dl>
        {!loggingIn && (
          <div className="settings-actions">
            <button
              className="primary"
              type="button"
              disabled={!status?.cliVersion || !status.proxy.configured || Boolean(busy)}
              onClick={() =>
                void run("login", async () => {
                  setStatus(await api.startGeminiLogin());
                })
              }
            >
              <ActionLabel
                idle={status?.authenticated ? t("Войти заново") : t("Войти через Google")}
                busy={t("Начинаем вход…")}
                pending={busy === "login"}
              />
            </button>
          </div>
        )}
        {login?.state === "starting" && <p role="status">{t("Получаем ссылку для входа…")}</p>}
        {login?.state === "awaiting_code" && login.url && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run("code", async () => {
                setStatus(await api.submitGeminiLoginCode(login.id, code));
                setCode("");
              });
            }}
          >
            <p>
              <a
                className="button primary"
                href={login.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  if (!Capacitor.isNativePlatform()) return;
                  event.preventDefault();
                  void Browser.open({ url: login.url! }).catch(() =>
                    setError(
                      t(
                        "Не удалось открыть страницу входа. Скопируйте ссылку и откройте её в браузере.",
                      ),
                    ),
                  );
                }}
              >
                {t("Открыть вход Google")}
              </a>
            </p>
            <p>
              {t(
                "Страница Google использует настройки сети вашего браузера. При необходимости включите прокси и в нём.",
              )}
            </p>
            <SettingsRow
              label={t("Код или URL после входа")}
              labelFor="gemini-login-code"
              description={t(
                "После входа скопируйте код или полный адрес страницы и вставьте сюда.",
              )}
            >
              <input
                id="gemini-login-code"
                type="password"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={Boolean(busy)}
                spellCheck={false}
              />
            </SettingsRow>
            <div className="settings-actions">
              <button className="primary" type="submit" disabled={!code.trim() || Boolean(busy)}>
                <ActionLabel
                  idle={t("Завершить вход")}
                  busy={t("Отправляем…")}
                  pending={busy === "code"}
                />
              </button>
            </div>
          </form>
        )}
        {login?.state === "exchanging" && <p role="status">{t("Проверяем вход через прокси…")}</p>}
        {loggingIn && (
          <div className="settings-actions">
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("cancel", async () => {
                  setStatus(await api.cancelGeminiLogin());
                  setCode("");
                })
              }
            >
              {t("Отменить вход")}
            </button>
          </div>
        )}
        {login?.error && (
          <p className="settings-notice warning" role="alert">
            {login.error}
          </p>
        )}
        {feedback && (
          <p className="settings-notice" role="status">
            {feedback}
          </p>
        )}
        {error && (
          <p className="settings-notice warning" role="alert">
            {error}
          </p>
        )}
      </SettingsGroup>
    </>
  );
}
