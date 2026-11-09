import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { useEffect, useId, useRef, useState } from "react";
import type { CodexAccount, CodexAccountsStatus, CodexLoginStatus } from "@codexnest/protocol";

import type { ApiClient } from "../api";
import { copyText } from "../clipboard";
import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";
import { ActionLabel } from "./ActionLabel";
import { AccountCard } from "./ClaudeAccountsSettings";
import { Dialog } from "./Dialog";
import { BrowserIcon, CheckIcon, CopyIcon, PlusIcon, RefreshIcon, XIcon } from "./Icons";

export function CodexAccountsSettings() {
  const { api, state } = useConnection();
  const { language, t } = useI18n();
  const snapshot = state?.snapshot?.codexAccounts;
  const [status, setStatus] = useState<CodexAccountsStatus | null>(snapshot ?? null);
  const [loading, setLoading] = useState(!snapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ account?: CodexAccount } | null>(null);
  const headingId = useId();
  const localization = useRef({ t, language });
  localization.current = { t, language };
  const active = (state?.snapshot?.threads ?? []).some((thread) => thread.currentTurnId !== null);

  useEffect(() => {
    let cancelled = false;
    void api.readCodexAccounts().then(
      (next) => {
        if (!cancelled) {
          setStatus(next);
          setLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setError(
            localization.current.t("Не удалось загрузить аккаунты Codex. Повторите обновление."),
          );
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  useEffect(() => {
    if (snapshot) setStatus(snapshot);
  }, [snapshot]);

  async function perform(task: () => Promise<CodexAccountsStatus>) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await task());
    } catch (caught) {
      setError(
        accountError(caught, t("Не удалось изменить аккаунты Codex. Повторите попытку."), language),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="claude-accounts" aria-labelledby={headingId} aria-busy={loading || busy}>
      <header className="claude-accounts-heading">
        <div>
          <h2 id={headingId}>{t("Аккаунты Codex")}</h2>
          <p className="claude-account-meta">
            {t("Аккаунтов: {{count}}", { count: status?.accounts.length ?? 0 })}
          </p>
        </div>
        <div className="claude-account-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t("Обновить лимиты аккаунтов")}
            disabled={busy}
            onClick={() => void perform(() => api.refreshCodexAccounts())}
          >
            <RefreshIcon />
          </button>
          <button
            type="button"
            className="claude-account-primary claude-add-account"
            aria-label={t("Добавить аккаунт")}
            disabled={loading || busy}
            onClick={() => setDialog({})}
          >
            <PlusIcon />
            <span className="claude-add-account-label">{t("Добавить аккаунт")}</span>
          </button>
        </div>
      </header>
      <p className="claude-account-hint">
        {t(
          "Сохранённые аккаунты ChatGPT. Переключение сохраняет историю чатов. Для всех аккаунтов используются настройки подключения Codex.",
        )}
      </p>
      {active && (
        <p className="settings-notice" role="status">
          {t("Переключить аккаунт можно после завершения активных ответов.")}
        </p>
      )}
      {error && (
        <p className="settings-notice danger" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p className="muted" role="status">
          <span className="working-text">{t("Загружаем аккаунты…")}</span>
        </p>
      )}
      {status && status.accounts.length === 0 && (
        <div className="claude-account-surface claude-account-empty">
          <h3>{t("Добавьте аккаунт Codex")}</h3>
          <p>{t("Войдите в ChatGPT через браузер, чтобы подключить аккаунт.")}</p>
          <button type="button" disabled={busy} onClick={() => setDialog({})}>
            <PlusIcon />
            {t("Добавить аккаунт")}
          </button>
        </div>
      )}
      {status?.accounts.map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          current={status.currentAccountId === account.id}
          autoSwitch={false}
          provider="Codex"
          busy={busy}
          selectionDisabled={active}
          onLogin={() => setDialog({ account })}
          onRefresh={() => void perform(() => api.refreshCodexAccounts(account.id))}
          onSelect={() => void perform(() => api.selectCodexAccount(account.id))}
          onRemove={() => {
            if (
              window.confirm(
                t("Удалить аккаунт {{email}}? История чатов сохранится.", {
                  email: account.email ?? t("Без авторизации"),
                }),
              )
            )
              void perform(() => api.removeCodexAccount(account.id));
          }}
        />
      ))}
      {dialog && (
        <CodexLoginDialog
          api={api}
          account={dialog.account}
          onClose={() => setDialog(null)}
          onSaved={(next) => {
            setStatus(next);
            setDialog(null);
          }}
        />
      )}
    </section>
  );
}

function CodexLoginDialog({
  api,
  account,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  account?: CodexAccount;
  onClose(): void;
  onSaved(status: CodexAccountsStatus): void;
}) {
  const { language, t } = useI18n();
  const headingId = useId();
  const [login, setLogin] = useState<CodexLoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  const loginRef = useRef<CodexLoginStatus | null>(null);
  const generation = useRef(0);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const localization = useRef({ language, t });
  localization.current = { language, t };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      const current = loginRef.current;
      if (current && !terminal(current))
        void api.cancelCodexLogin(current.id).catch(() => undefined);
    };
  }, [api]);

  useEffect(() => {
    if (!login || terminal(login)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .readCodexLogin(login.id)
        .then(async (next) => {
          if (cancelled || !alive.current) return;
          loginRef.current = next;
          setLogin(next);
          setError(null);
          if (next.state === "completed") {
            const status = await api.readCodexAccounts();
            if (alive.current && loginRef.current?.id === next.id) saved.current(status);
          }
        })
        .catch(() => {
          if (!cancelled && alive.current) {
            setError(localization.current.t("Не удалось проверить вход. Повторяем проверку…"));
            setLogin((current) => current && { ...current });
          }
        });
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, login]);

  async function start() {
    const attempt = ++generation.current;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const previous = loginRef.current;
      if (previous && !terminal(previous)) await api.cancelCodexLogin(previous.id);
      const next = await api.startCodexLogin(account?.id);
      if (!alive.current || attempt !== generation.current) {
        if (!terminal(next)) void api.cancelCodexLogin(next.id).catch(() => undefined);
        return;
      }
      loginRef.current = next;
      setLogin(next);
      if (next.state === "completed") saved.current(await api.readCodexAccounts());
    } catch (caught) {
      if (alive.current && attempt === generation.current)
        setError(
          accountError(
            caught,
            t("Не удалось начать вход в Codex. Проверьте подключение и повторите попытку."),
            language,
          ),
        );
    } finally {
      if (alive.current && attempt === generation.current) setBusy(false);
    }
  }

  return (
    <Dialog
      titleId={headingId}
      className="claude-account-dialog"
      closeOnBackdrop
      closeOnEscape
      onClose={onClose}
    >
      <div className="dialog-header">
        <div className="dialog-heading">
          <h2 id={headingId}>{t("Войти в Codex")}</h2>
          <p>
            {account?.email ??
              t("Подключите аккаунт ChatGPT, который хотите использовать в Codex.")}
          </p>
        </div>
        <button type="button" className="icon-button" aria-label={t("Закрыть")} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="claude-account-form">
        <p className="claude-account-hint">
          {t(
            "Разрешите вход по коду устройства в настройках безопасности ChatGPT. Затем получите код и откройте страницу входа.",
          )}
        </p>
        {login?.userCode && (
          <>
            <label htmlFor={`${headingId}-code`}>{t("Код для входа в ChatGPT")}</label>
            <div className="claude-proxy-input">
              <input
                id={`${headingId}-code`}
                readOnly
                value={login.userCode}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={t(copied ? "Скопировано" : "Скопировать код")}
                onClick={() =>
                  void copyText(login.userCode!).then(
                    () => setCopied(true),
                    () => setError(t("Не удалось скопировать код.")),
                  )
                }
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
            </div>
            <p className="claude-account-hint">
              {t(
                "Введите этот код на странице ChatGPT. После входа вернитесь сюда — аккаунт сохранится автоматически.",
              )}
            </p>
          </>
        )}
        {login?.url && (
          <a
            className="settings-action-link claude-login-open claude-account-primary"
            href={login.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              if (!Capacitor.isNativePlatform()) return;
              event.preventDefault();
              void Browser.open({ url: login.url! }).catch(() =>
                setError(t("Не удалось открыть страницу входа. Откройте ссылку в браузере.")),
              );
            }}
          >
            <BrowserIcon />
            {t("Открыть страницу входа")}
          </a>
        )}
        {login && (
          <p className="claude-login-status claude-account-meta" role="status">
            <span className={!terminal(login) ? "working-text" : undefined}>
              {t(
                login.state === "completed"
                  ? "Вход выполнен"
                  : login.state === "failed"
                    ? "Вход не завершён. Начните заново."
                    : login.state === "cancelled"
                      ? "Вход отменён"
                      : login.state === "checking"
                        ? "Проверяем авторизацию…"
                        : "Ожидаем вход в ChatGPT…",
              )}
            </span>
          </p>
        )}
        {login?.state === "failed" && (
          <p className="settings-notice danger" role="alert">
            {t(
              "Не удалось войти в Codex. Проверьте разрешение входа по коду устройства в ChatGPT и начните заново.",
            )}
          </p>
        )}
        {error && (
          <p className="settings-notice danger" role="alert">
            {error}
          </p>
        )}
        <div className="claude-dialog-actions">
          <button type="button" onClick={onClose}>
            {t("Отмена")}
          </button>
          <button
            type="button"
            disabled={busy}
            className="claude-account-primary"
            onClick={() => {
              if (login?.state === "completed") {
                void api
                  .readCodexAccounts()
                  .then(saved.current, () =>
                    setError(
                      t(
                        "Вход выполнен. Не удалось обновить список аккаунтов — закройте окно и нажмите обновление.",
                      ),
                    ),
                  );
              } else void start();
            }}
          >
            <ActionLabel
              idle={t(
                login?.state === "completed"
                  ? "Готово"
                  : login
                    ? "Начать вход заново"
                    : "Получить код входа",
              )}
              busy={t("Подключаем…")}
              pending={busy}
            />
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function terminal(login: CodexLoginStatus): boolean {
  return ["completed", "failed", "cancelled"].includes(login.state);
}
function accountError(error: unknown, fallback: string, language: "ru" | "en"): string {
  if (!(error instanceof Error)) return fallback;
  if (localizeKnownServerText("ru", error.message) === error.message) return fallback;
  return localizeKnownServerText(language, error.message) ?? fallback;
}
