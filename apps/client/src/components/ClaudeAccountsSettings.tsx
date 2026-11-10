import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  parseClaudeProxyCandidates,
  type ClaudeAccount,
  type ClaudeAccountsStatus,
  type ClaudeLoginStatus,
  type CodexLoginStatus,
  type ClaudeProxyInput,
  type ClaudeProxyProtocol,
  type ClaudeProxyStatus,
  type CodexRateLimitWindow,
} from "@codexnest/protocol";

import type { ApiClient } from "../api";
import { copyText } from "../clipboard";
import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { ActionLabel } from "./ActionLabel";
import { Dialog } from "./Dialog";
import {
  ArrowRightIcon,
  BrowserIcon,
  CheckIcon,
  CopyIcon,
  MoreIcon,
  PlusIcon,
  RefreshIcon,
  SlidersIcon,
  XIcon,
} from "./Icons";

type AccountDialog = { mode: "add" } | { mode: "proxy" | "login"; account: ClaudeAccount };

export function ClaudeAccountsSettings({ provider = "Claude" }: { provider?: "Claude" | "Codex" }) {
  const { api, state } = useConnection();
  const { language, t } = useI18n();
  const snapshotStatus =
    provider === "Codex" ? state?.snapshot?.codexAccounts : state?.snapshot?.claudeAccounts;
  const [status, setStatus] = useState<ClaudeAccountsStatus | null>(snapshotStatus ?? null);
  const [loading, setLoading] = useState(!snapshotStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const headingId = useId();
  const localizationRef = useRef({ language, t });
  localizationRef.current = { language, t };

  useEffect(() => {
    let cancelled = false;
    void (provider === "Codex" ? api.readCodexAccounts() : api.readClaudeAccounts()).then(
      (next) => {
        if (!cancelled) {
          setStatus(next);
          setLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setError(
            localizationRef.current.t(
              provider === "Codex"
                ? "Не удалось загрузить аккаунты Codex. Повторите обновление."
                : "Не удалось загрузить аккаунты Claude. Повторите обновление.",
            ),
          );
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, provider]);

  useEffect(() => {
    if (snapshotStatus) setStatus(snapshotStatus);
  }, [snapshotStatus]);

  async function perform(task: () => Promise<ClaudeAccountsStatus>) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await task());
    } catch (caught) {
      setError(
        knownError(
          caught,
          t(
            provider === "Codex"
              ? "Не удалось изменить аккаунты Codex. Повторите попытку."
              : "Не удалось изменить настройки аккаунтов Claude.",
          ),
          language,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const accounts = status?.accounts ?? [];
  const updatedAt = accounts.reduce<number | null>((latest, account) => {
    const value = account.rateLimits.updatedAt;
    return value !== null && (latest === null || value > latest) ? value : latest;
  }, null);

  return (
    <section className="claude-accounts" aria-labelledby={headingId} aria-busy={loading || busy}>
      <header className="claude-accounts-heading">
        <div>
          <h2 id={headingId}>{provider === "Codex" ? "Codex CLI" : "Claude Code CLI"}</h2>
          <p className="claude-account-meta">
            {status?.cliVersion ?? t("Версия CLI недоступна")}
            {status && (
              <>
                {" "}
                ·{" "}
                {t("Аккаунтов: {{count}}", {
                  count: accounts.length,
                })}
              </>
            )}
          </p>
        </div>
        <div className="claude-account-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t("Обновить лимиты аккаунтов")}
            disabled={loading || busy}
            onClick={() =>
              void perform(() =>
                provider === "Codex" ? api.refreshCodexAccounts() : api.refreshClaudeAccounts(),
              )
            }
          >
            <RefreshIcon />
          </button>
          <button
            type="button"
            className="claude-account-primary claude-add-account"
            aria-label={t("Добавить аккаунт")}
            disabled={loading || busy}
            onClick={() => setDialog({ mode: "add" })}
          >
            <PlusIcon />
            <span className="claude-add-account-label">{t("Добавить аккаунт")}</span>
          </button>
        </div>
      </header>

      {provider === "Codex" && (
        <p className="claude-account-hint">
          {t(
            "Выбор аккаунта действует для новых сессий. Запущенные задачи сохраняют свой аккаунт и подключение.",
          )}
        </p>
      )}
      {error && (
        <p className="settings-notice danger" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="muted">
          <span className="working-text">{t("Загружаем аккаунты…")}</span>
        </p>
      )}
      {status && (
        <div className="claude-auto-switch claude-account-surface">
          <div>
            <label htmlFor={`${headingId}-auto`}>{t("Автопереключение")}</label>
            <p>
              {t(
                "Сначала тратится аккаунт, у которого 5-часовой лимит сбросится раньше; при лимите или потере авторизации — другой доступный.",
              )}
            </p>
          </div>
          <input
            id={`${headingId}-auto`}
            className="claude-account-switch"
            type="checkbox"
            role="switch"
            checked={status.autoSwitch}
            disabled={busy}
            onChange={(event) =>
              void perform(() =>
                provider === "Codex"
                  ? api.updateCodexAutoSwitch(event.target.checked)
                  : api.updateClaudeAutoSwitch(event.target.checked),
              )
            }
          />
        </div>
      )}
      {status && (
        <div className="claude-auto-switch claude-account-surface">
          <div>
            <label htmlFor={`${headingId}-warm`}>{t("Прогрев лимитов")}</label>
            <p>
              {t("Равномерно распределять сбросы 5-часовых лимитов, прогревая свободные аккаунты.")}
            </p>
          </div>
          <input
            id={`${headingId}-warm`}
            className="claude-account-switch"
            type="checkbox"
            role="switch"
            checked={status.warmLimits}
            disabled={busy}
            onChange={(event) =>
              void perform(() =>
                provider === "Codex"
                  ? api.updateCodexWarmLimits(event.target.checked)
                  : api.updateClaudeWarmLimits(event.target.checked),
              )
            }
          />
        </div>
      )}
      {!loading && status && accounts.length === 0 && (
        <div className="claude-account-surface claude-account-empty">
          <h3>{t(provider === "Codex" ? "Добавьте аккаунт Codex" : "Добавьте аккаунт Claude")}</h3>
          <p>{t("Войдите через приложение и настройте подключение для аккаунта.")}</p>
          <button
            type="button"
            className="claude-account-primary"
            disabled={busy}
            onClick={() => setDialog({ mode: "add" })}
          >
            <PlusIcon />
            {t("Добавить аккаунт")}
          </button>
        </div>
      )}
      {accounts.map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          provider={provider}
          current={account.id === status?.currentAccountId}
          autoSwitch={status?.autoSwitch ?? true}
          busy={busy}
          onConfigure={() => setDialog({ mode: "proxy", account })}
          onLogin={() => setDialog({ mode: "login", account })}
          onRefresh={() =>
            void perform(() =>
              provider === "Codex"
                ? api.refreshCodexAccounts(account.id)
                : api.refreshClaudeAccounts(account.id),
            )
          }
          onSelect={() =>
            void perform(() =>
              provider === "Codex"
                ? api.selectCodexAccount(account.id)
                : api.selectClaudeAccount(account.id),
            )
          }
          onRemove={() => {
            if (
              window.confirm(
                t("Удалить аккаунт {{email}}? История чатов сохранится.", {
                  email: account.email ?? t("Без авторизации"),
                }),
              )
            ) {
              void perform(() =>
                provider === "Codex"
                  ? api.removeCodexAccount(account.id)
                  : api.removeClaudeAccount(account.id),
              );
            }
          }}
        />
      ))}
      {updatedAt !== null && (
        <p className="claude-account-meta claude-account-updated">
          <RefreshIcon />
          {t("Лимиты обновлены в {{time}}", { time: formatTime(updatedAt, language) })}
        </p>
      )}
      {dialog && (
        <AccountWizard
          api={api}
          dialog={dialog}
          provider={provider}
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

export function AccountCard({
  account,
  current,
  autoSwitch,
  busy,
  onConfigure,
  onLogin,
  onRefresh,
  onSelect,
  onRemove,
  provider = "Claude",
  selectionDisabled = false,
}: {
  account: Omit<ClaudeAccount, "proxy"> & { proxy?: ClaudeProxyStatus };
  current: boolean;
  autoSwitch: boolean;
  busy: boolean;
  onConfigure?(): void;
  onLogin(): void;
  onRefresh(): void;
  onSelect(): void;
  onRemove(): void;
  provider?: "Claude" | "Codex";
  selectionDisabled?: boolean;
}) {
  const { language, t } = useI18n();
  const weeklyExhausted = quotaExhausted(account.rateLimits.limits?.secondary);
  const fiveHourExhausted = quotaExhausted(account.rateLimits.limits?.primary);
  const blocked =
    !account.authenticated ||
    account.connectionError !== null ||
    weeklyExhausted ||
    fiveHourExhausted;
  const label = !account.authenticated
    ? account.email
      ? t("Нужен вход")
      : null
    : weeklyExhausted
      ? t("Недельный лимит")
      : fiveHourExhausted
        ? t("Лимит на 5 часов")
        : current
          ? t("Используется")
          : account.authenticated
            ? t("Авторизован")
            : null;
  const hasKnownLimits =
    remaining(account.rateLimits.limits?.primary) !== null ||
    remaining(account.rateLimits.limits?.secondary) !== null;
  const usageFailed =
    account.authenticated && Boolean(account.connectionError || account.rateLimits.refreshError);

  return (
    <article
      className="claude-account-surface claude-account-card"
      aria-label={account.email ?? t("Аккаунт без авторизации")}
    >
      <header className="claude-account-card-heading">
        <span aria-hidden="true" className="claude-account-avatar">
          {(account.email?.[0] ?? "C").toUpperCase()}
        </span>
        <div className="claude-account-identity">
          <h3>{account.email ?? t("Без авторизации")}</h3>
          <p className="claude-account-meta claude-account-identity-meta">
            <span
              className={`claude-account-dot${account.authenticated ? " authenticated" : ""}`}
            />
            {account.plan ? formatPlan(account.plan) : t("Тариф неизвестен")}
            {label && (
              <span
                className={`claude-account-state${!account.authenticated || weeklyExhausted || fiveHourExhausted ? " warning" : current ? " current" : " authenticated"}`}
              >
                {label}
              </span>
            )}
          </p>
        </div>
        <details className="claude-account-menu">
          <summary
            aria-label={t("Действия аккаунта {{email}}", {
              email: account.email ?? t("Без авторизации"),
            })}
          >
            <MoreIcon />
          </summary>
          <div>
            {!autoSwitch && !current && (
              <button
                type="button"
                disabled={busy || blocked || selectionDisabled}
                onClick={onSelect}
              >
                {t("Использовать аккаунт")}
              </button>
            )}
            <button type="button" disabled={busy} onClick={onLogin}>
              {t(
                account.authenticated
                  ? "Войти заново"
                  : provider === "Codex"
                    ? "Войти в Codex"
                    : "Войти в Claude",
              )}
            </button>
            <button type="button" disabled={busy || !account.authenticated} onClick={onRefresh}>
              {t("Обновить лимиты")}
            </button>
            <button type="button" className="danger" disabled={busy} onClick={onRemove}>
              {t("Удалить аккаунт")}
            </button>
          </div>
        </details>
      </header>
      <div className="claude-account-quota-group" role="group" aria-label={t("Остаток лимитов")}>
        <p className="claude-account-meta">{t("Остаток лимитов")}</p>
        <div className="claude-account-quotas">
          <Quota
            label={t("5 часов")}
            window={account.rateLimits.limits?.primary}
            language={language}
            t={t}
          />
          <Quota
            label={t("7 дней")}
            window={account.rateLimits.limits?.secondary}
            language={language}
            t={t}
          />
        </div>
      </div>
      {!account.authenticated ? (
        <p className="claude-account-hint" role="status">
          {t(
            account.email
              ? "Войдите заново, чтобы вернуть аккаунт в работу."
              : "Войдите в аккаунт, чтобы получить лимиты.",
          )}
        </p>
      ) : usageFailed ? (
        <div className="claude-account-feedback" role="status">
          <div>
            <p>{t("Не удалось получить лимиты")}</p>
            {hasKnownLimits && (
              <p className="claude-account-hint">{t("Показаны последние данные.")}</p>
            )}
          </div>
          <button
            type="button"
            disabled={busy || account.rateLimits.refreshing}
            onClick={onRefresh}
          >
            {t("Повторить")}
          </button>
        </div>
      ) : (
        !hasKnownLimits && (
          <p className="claude-account-hint" role="status">
            {account.rateLimits.refreshing ? (
              <span className="working-text">{t("Получаем лимиты…")}</span>
            ) : (
              t("Лимиты ещё не получены.")
            )}
          </p>
        )
      )}
      {(account.proxy || onConfigure || !account.authenticated || !current) && (
        <footer className="claude-account-footer">
          {account.proxy && (
            <p>
              <BrowserIcon />
              <span
                className={account.proxy.enabled ? "claude-account-connection-value" : undefined}
              >
                {proxyDescription(account.proxy, t)}
              </span>
            </p>
          )}
          {account.proxy?.enabled && account.proxy.url && (
            <ProxyCopyButton value={account.proxy.url} />
          )}
          {!account.authenticated && (
            <button
              type="button"
              disabled={busy}
              onClick={onLogin}
              aria-label={t(provider === "Codex" ? "Войти в Codex" : "Войти в Claude")}
            >
              {t(account.email ? "Войти заново" : "Войти")}
            </button>
          )}
          {onConfigure && (
            <button
              type="button"
              className="claude-configure-account"
              disabled={busy}
              onClick={onConfigure}
              aria-label={t("Настроить")}
            >
              <SlidersIcon />
              <span>{t("Настроить")}</span>
            </button>
          )}
          {provider === "Codex" && !autoSwitch && !current && account.authenticated && (
            <button
              type="button"
              disabled={busy || selectionDisabled || blocked}
              onClick={onSelect}
            >
              {t("Использовать аккаунт")}
            </button>
          )}
        </footer>
      )}
    </article>
  );
}

function ProxyCopyButton({ value, disabled = false }: { value: string; disabled?: boolean }) {
  const { t } = useI18n();
  const [feedback, setFeedback] = useState<{ value: string; state: "idle" | "copied" | "failed" }>({
    value,
    state: "idle",
  });
  const result = feedback.value === value ? feedback.state : "idle";
  const label = t(
    result === "copied"
      ? "Скопировано"
      : result === "failed"
        ? "Не удалось скопировать"
        : "Скопировать прокси",
  );
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      disabled={disabled || !value.trim()}
      onClick={() =>
        void copyText(value).then(
          () => setFeedback({ value, state: "copied" }),
          () => setFeedback({ value, state: "failed" }),
        )
      }
    >
      {result === "copied" ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function Quota({
  label,
  window,
  language,
  t,
}: {
  label: string;
  window?: CodexRateLimitWindow | null;
  language: string;
  t: Translate;
}) {
  const value = remaining(window);
  return (
    <div className={`claude-account-quota${value === 0 ? " exhausted" : ""}`}>
      <div className="claude-account-quota-label">
        <span>{label}</span>
        <strong
          aria-label={
            value === null
              ? t("Лимит недоступен")
              : t("Осталось {{percent}}%", {
                  percent: value > 0 && value < 1 ? "<1" : Math.round(value),
                })
          }
        >
          {value === null ? "—" : `${value > 0 && value < 1 ? "<1" : Math.round(value)}%`}
        </strong>
      </div>
      {value !== null && (
        <div
          className="claude-account-quota-track"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value}
        >
          <span style={{ width: `${value}%` }} />
        </div>
      )}
      {window?.resetsAt && (
        <p className="claude-account-meta">
          {t("Сброс: {{time}}", {
            time: new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", {
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(window.resetsAt)),
          })}
        </p>
      )}
    </div>
  );
}

function AccountWizard({
  provider,
  api,
  dialog,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  dialog: AccountDialog;
  provider: "Claude" | "Codex";
  onClose(): void;
  onSaved(status: ClaudeAccountsStatus): void;
}) {
  const { language, t } = useI18n();
  const account = dialog.mode === "add" ? null : dialog.account;
  const [step, setStep] = useState<"connection" | "login">(
    dialog.mode === "login" ? "login" : "connection",
  );
  const [enabled, setEnabled] = useState(account?.proxy.enabled ?? true);
  const [protocol, setProtocol] = useState<ClaudeProxyProtocol>(account?.proxy.protocol ?? "http");
  const [rawProxy, setRawProxy] = useState(account?.proxy.url ?? "");
  const [choice, setChoice] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; latencyMs: number | null } | null>(null);
  const [login, setLogin] = useState<ClaudeLoginStatus | CodexLoginStatus | null>(null);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const headingId = useId();
  const aliveRef = useRef(true);
  const generationRef = useRef(0);
  const loginRef = useRef<ClaudeLoginStatus | CodexLoginStatus | null>(null);
  const completionRef = useRef<string | null>(null);
  const startRef = useRef<() => Promise<void>>(async () => undefined);
  loginRef.current = login;

  const parsed = useMemo(() => {
    if (!enabled || !rawProxy.trim()) return { candidates: [], error: false };
    try {
      const candidates = parseClaudeProxyCandidates(rawProxy, protocol);
      return { candidates, error: candidates.length === 0 };
    } catch {
      return { candidates: [], error: true };
    }
  }, [enabled, protocol, rawProxy]);
  const selected =
    parsed.candidates.length === 1
      ? parsed.candidates[0]
      : parsed.candidates.find((candidate) => candidate.url === choice);
  const proxy: ClaudeProxyInput = {
    enabled,
    protocol: selected?.protocol ?? protocol,
    value: enabled ? (selected?.url ?? rawProxy.trim()) : "",
  };
  const canConnect = !enabled || Boolean(selected);

  const cancelActive = useCallback(() => {
    generationRef.current += 1;
    const active = loginRef.current;
    loginRef.current = null;
    if (active && !terminalLogin(active))
      void (
        provider === "Codex" ? api.cancelCodexLogin(active.id) : api.cancelClaudeLogin(active.id)
      ).catch(() => undefined);
  }, [api, provider]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelActive();
    };
  }, [cancelActive]);

  async function startLogin() {
    const generation = ++generationRef.current;
    setBusy(true);
    setError(null);
    setLogin(null);
    setCode("");
    setCopied(false);
    try {
      const next = await (
        provider === "Codex" ? api.startCodexLogin.bind(api) : api.startClaudeLogin.bind(api)
      )(
        account && !changed
          ? { accountId: account.id }
          : { proxy, ...(account ? { accountId: account.id } : {}) },
      );
      if (!aliveRef.current || generation !== generationRef.current) {
        if (!terminalLogin(next))
          void (
            provider === "Codex" ? api.cancelCodexLogin(next.id) : api.cancelClaudeLogin(next.id)
          ).catch(() => undefined);
        return;
      }
      loginRef.current = next;
      setLogin(next);
      setStep("login");
    } catch (caught) {
      if (aliveRef.current && generation === generationRef.current) {
        setError(
          knownError(
            caught,
            t("Не удалось начать вход. Проверьте подключение и попробуйте снова."),
            language,
          ),
        );
      }
    } finally {
      if (aliveRef.current && generation === generationRef.current) setBusy(false);
    }
  }
  startRef.current = startLogin;

  useEffect(() => {
    if (dialog.mode === "login") void startRef.current();
  }, [dialog.mode]);

  useEffect(() => {
    if (!login || terminalLogin(login)) return;
    let cancelled = false;
    const generation = generationRef.current;
    const timer = window.setTimeout(() => {
      void (
        provider === "Codex" ? api.readCodexLogin(login.id) : api.readClaudeLogin(login.id)
      ).then(
        (next) => {
          if (!cancelled && aliveRef.current && generation === generationRef.current) {
            setError(null);
            setLogin(next);
          }
        },
        () => {
          if (!cancelled && aliveRef.current && generation === generationRef.current) {
            setError(t("Не удалось проверить вход. Повторяем проверку…"));
            setLogin({ ...login });
          }
        },
      );
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, login, t]);

  useEffect(() => {
    if (login?.state !== "completed" || completionRef.current === login.id) return;
    completionRef.current = login.id;
    void (provider === "Codex" ? api.readCodexAccounts() : api.readClaudeAccounts()).then(
      (next) => {
        if (aliveRef.current) onSaved(next);
      },
      () => {
        if (aliveRef.current)
          setError(
            t(
              "Вход выполнен. Не удалось обновить список аккаунтов; закройте окно и нажмите обновление.",
            ),
          );
      },
    );
  }, [api, login, onSaved, t]);

  function close() {
    cancelActive();
    onClose();
  }

  function changeConnection() {
    setChanged(true);
    setTest(null);
    setError(null);
    setChoice(null);
  }

  async function checkProxy() {
    setBusy(true);
    setError(null);
    setTest(null);
    try {
      const result = await (provider === "Codex"
        ? api.testCodexProxy(proxy)
        : api.testClaudeProxy(proxy));
      if (aliveRef.current) {
        setTest(result);
        if (!result.ok)
          setError(t("Подключение недоступно. Проверьте адрес, порт, логин и пароль прокси."));
      }
    } catch (caught) {
      if (aliveRef.current)
        setError(knownError(caught, t("Не удалось проверить подключение через прокси."), language));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function saveProxy(event: FormEvent) {
    event.preventDefault();
    if (!canConnect || !account) return;
    setBusy(true);
    setError(null);
    try {
      const next = await (provider === "Codex"
        ? api.updateCodexAccountProxy(account.id, proxy)
        : api.updateClaudeAccountProxy(account.id, proxy));
      if (aliveRef.current) onSaved(next);
    } catch (caught) {
      if (aliveRef.current)
        setError(knownError(caught, t("Не удалось сохранить подключение аккаунта."), language));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (!login || !code.trim()) return;
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.submitClaudeLoginCode(login.id, code.trim());
      if (aliveRef.current && generation === generationRef.current) {
        setLogin(next);
        setCode("");
      }
    } catch (caught) {
      if (aliveRef.current && generation === generationRef.current)
        setError(
          knownError(
            caught,
            t("Не удалось подтвердить код. Вставьте его целиком или начните вход заново."),
            language,
          ),
        );
    } finally {
      if (aliveRef.current && generation === generationRef.current) setBusy(false);
    }
  }

  const connection =
    account && !changed
      ? proxyDescription(account.proxy, t)
      : selected
        ? `${selected.protocol.toUpperCase()} · ${endpoint(selected.host, selected.port)}`
        : t("Без прокси");
  const title =
    step === "login"
      ? t(provider === "Codex" ? "Войти в Codex" : "Войти в Claude")
      : dialog.mode === "proxy"
        ? t("Подключение аккаунта")
        : t("Добавить аккаунт");

  return (
    <Dialog
      titleId={headingId}
      className="claude-account-dialog"
      closeOnBackdrop
      closeOnEscape
      onClose={close}
    >
      <div className="dialog-header">
        <div className="dialog-heading">
          <h2 id={headingId}>{title}</h2>
          <p>
            {step === "login"
              ? t(
                  provider === "Codex"
                    ? "Откройте страницу ChatGPT и введите код ниже. Завершите вход в нужный аккаунт."
                    : "Откройте страницу Claude и войдите в нужный аккаунт. Вернитесь сюда, чтобы завершить подключение.",
                )
              : (account?.email ??
                t(
                  provider === "Codex"
                    ? "Сначала настройте подключение. Почта аккаунта появится после входа в ChatGPT."
                    : "Сначала настройте подключение. Почта аккаунта появится после входа в Claude.",
                ))}
          </p>
        </div>
        <button type="button" className="icon-button" aria-label={t("Закрыть")} onClick={close}>
          <XIcon />
        </button>
      </div>
      {step === "connection" ? (
        <form
          className="claude-account-form"
          onSubmit={
            dialog.mode === "proxy"
              ? saveProxy
              : (event) => {
                  event.preventDefault();
                  if (canConnect) void startLogin();
                }
          }
        >
          <fieldset className="claude-connection-options" disabled={busy}>
            <legend>{t("Подключение")}</legend>
            <div>
              <label className={enabled ? "selected" : ""}>
                <input
                  type="radio"
                  name={`${headingId}-connection`}
                  checked={enabled}
                  onChange={() => {
                    setEnabled(true);
                    changeConnection();
                  }}
                />
                {t("Через прокси")}
              </label>
              <label className={!enabled ? "selected" : ""}>
                <input
                  type="radio"
                  name={`${headingId}-connection`}
                  checked={!enabled}
                  onChange={() => {
                    setEnabled(false);
                    changeConnection();
                  }}
                />
                {t("Без прокси")}
              </label>
            </div>
          </fieldset>
          {account && !changed && (
            <p className="claude-account-hint">
              {t("Текущее подключение: {{connection}}", { connection })}
            </p>
          )}
          {enabled && (
            <>
              <label htmlFor={`${headingId}-proxy`}>{t("Прокси")}</label>
              <div className="claude-proxy-input">
                <input
                  id={`${headingId}-proxy`}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={rawProxy}
                  disabled={busy}
                  placeholder={
                    account
                      ? t("Вставьте новый прокси, чтобы изменить подключение")
                      : t("Вставьте прокси в любом формате")
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    setRawProxy(value);
                    const scheme = value
                      .trim()
                      .match(/^(https?|socks5h?|socks):\/\//i)?.[1]
                      ?.toLowerCase();
                    if (scheme)
                      setProtocol(
                        scheme.startsWith("socks") ? "socks5" : (scheme as ClaudeProxyProtocol),
                      );
                    changeConnection();
                  }}
                />
                <ProxyCopyButton value={selected?.url ?? rawProxy.trim()} disabled={busy} />
              </div>
              <p className="claude-account-hint">
                {t("Вставьте строку как получили от провайдера — разберём автоматически.")}
              </p>
              <label htmlFor={`${headingId}-protocol`}>{t("Тип прокси")}</label>
              <select
                id={`${headingId}-protocol`}
                disabled={busy}
                value={selected?.protocol ?? protocol}
                onChange={(event) => {
                  const next = event.target.value as ClaudeProxyProtocol;
                  setProtocol(next);
                  setRawProxy((value) =>
                    value.replace(/^(https?|socks5h?|socks):\/\//i, `${next}://`),
                  );
                  changeConnection();
                }}
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
              {parsed.error && (
                <p className="claude-account-hint danger" role="status">
                  {t("Не удалось распознать прокси. Проверьте адрес и порт в строке.")}
                </p>
              )}
              {parsed.candidates.length > 1 && (
                <fieldset className="claude-proxy-candidates">
                  <legend>{t("Выберите правильный разбор прокси")}</legend>
                  {parsed.candidates.map((candidate) => (
                    <label key={candidate.url}>
                      <input
                        type="radio"
                        name={`${headingId}-candidate`}
                        checked={choice === candidate.url}
                        onChange={() => {
                          setChoice(candidate.url);
                          setTest(null);
                        }}
                      />
                      <span className="claude-account-connection-value">
                        {candidate.protocol.toUpperCase()} ·{" "}
                        {endpoint(candidate.host, candidate.port)}
                        {candidate.username && (
                          <small>
                            {t("Логин: {{username}}", { username: candidate.username })}
                          </small>
                        )}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              {selected && (
                <div className="claude-proxy-preview">
                  <p>
                    <CheckIcon />
                    {t("Прокси распознан")}
                  </p>
                  <dl>
                    <dt>{t("Адрес")}</dt>
                    <dd>{endpoint(selected.host, selected.port)}</dd>
                    <dt>{t("Логин")}</dt>
                    <dd>{selected.username ?? "—"}</dd>
                    <dt>{t("Пароль")}</dt>
                    <dd>{selected.password || "—"}</dd>
                  </dl>
                </div>
              )}
            </>
          )}
          <div className="claude-proxy-test">
            <button type="button" disabled={busy || !canConnect} onClick={() => void checkProxy()}>
              <BrowserIcon />
              <ActionLabel
                idle={t(enabled ? "Проверить прокси" : "Проверить подключение")}
                busy={t("Проверяем…")}
                pending={busy}
              />
            </button>
            {test?.ok && (
              <p className="claude-account-success" role="status">
                <CheckIcon />
                {test.latencyMs === null
                  ? t("Подключение доступно")
                  : t("Подключение доступно · {{latency}} мс", { latency: test.latencyMs })}
              </p>
            )}
          </div>
          {error && (
            <p className="settings-notice danger" role="alert">
              {error}
            </p>
          )}
          <p className="claude-account-hint">
            {t(
              enabled
                ? provider === "Codex"
                  ? "Запросы Codex для этого аккаунта будут идти через выбранный прокси. При ошибке прокси прямого подключения не будет."
                  : "Запросы Claude Code для этого аккаунта будут идти через выбранный прокси."
                : provider === "Codex"
                  ? "Запросы Codex для этого аккаунта будут идти без прокси."
                  : "Запросы Claude Code для этого аккаунта будут идти без прокси.",
            )}
          </p>
          <div className="claude-dialog-actions">
            <button type="button" onClick={close}>
              {t("Отмена")}
            </button>
            <button
              type="submit"
              className="claude-account-primary"
              disabled={busy || !canConnect || (dialog.mode === "proxy" && !changed)}
            >
              <ArrowRightIcon />
              <ActionLabel
                idle={t(dialog.mode === "proxy" ? "Сохранить подключение" : "Перейти к входу")}
                busy={t("Подключаем…")}
                pending={busy}
              />
            </button>
          </div>
        </form>
      ) : (
        <div className="claude-account-form">
          <div className="claude-login-connection">
            <span className="claude-account-hint">{t("Подключение")}</span>
            <p>
              <BrowserIcon />
              <span className={enabled ? "claude-account-connection-value" : undefined}>
                {connection}
              </span>
            </p>
          </div>
          {login?.url && (
            <>
              <a
                className="settings-action-link claude-login-open claude-account-primary"
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
                <BrowserIcon />
                {t("Открыть страницу входа")}
              </a>
              <button
                type="button"
                onClick={() => {
                  void copyText(login.url!).then(
                    () => setCopied(true),
                    () => setError(t("Не удалось скопировать ссылку.")),
                  );
                }}
              >
                <CopyIcon />
                {t(copied ? "Ссылка скопирована" : "Скопировать ссылку")}
              </button>
            </>
          )}
          <p className="claude-login-status claude-account-meta" role="status">
            <span
              className={
                login?.state === "checking" ||
                !["waitingCode", "waiting", "completed", "failed", "cancelled"].includes(
                  login?.state ?? "",
                )
                  ? "working-text"
                  : undefined
              }
            >
              {t(
                login?.state === "waiting"
                  ? "Ожидаем вход в ChatGPT…"
                  : login?.state === "waitingCode"
                    ? "Ожидаем код авторизации…"
                    : login?.state === "checking"
                      ? "Проверяем авторизацию…"
                      : login?.state === "completed"
                        ? "Вход выполнен"
                        : login?.state === "failed"
                          ? "Вход не завершён. Начните заново."
                          : login?.state === "cancelled"
                            ? "Вход отменён"
                            : "Готовим страницу входа…",
              )}
            </span>
          </p>
          {login && "userCode" in login && login.userCode && (
            <div className="claude-login-code">
              <label htmlFor={`${headingId}-device-code`}>{t("Код для входа в ChatGPT")}</label>
              <input
                id={`${headingId}-device-code`}
                value={login.userCode}
                readOnly
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() =>
                  void copyText(login.userCode!).then(
                    () => setCopied(true),
                    () => setError(t("Не удалось скопировать код.")),
                  )
                }
              >
                <CopyIcon />
                {t("Скопировать код")}
              </button>
            </div>
          )}
          {provider === "Codex" && login?.state === "failed" && (
            <p className="settings-notice danger" role="alert">
              {knownError(
                new Error(login.error ?? ""),
                t(
                  "Вход Codex не завершён. Проверьте прокси и разрешите вход по коду устройства в настройках безопасности ChatGPT.",
                ),
                language,
              )}
            </p>
          )}
          {login?.state === "waitingCode" && (
            <form className="claude-login-code" onSubmit={submitCode}>
              <p className="claude-account-hint">
                {t("Скопируйте выданный Claude код целиком и вставьте сюда.")}
              </p>
              <label htmlFor={`${headingId}-code`}>{t("Код авторизации")}</label>
              <input
                id={`${headingId}-code`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("Вставьте код из браузера")}
                disabled={busy}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <button type="submit" disabled={busy || !code.trim()}>
                <CheckIcon />
                <ActionLabel idle={t("Подтвердить код")} busy={t("Проверяем…")} pending={busy} />
              </button>
            </form>
          )}
          {(login?.state === "failed" || login?.state === "cancelled" || (!login && !busy)) && (
            <button
              type="button"
              className="claude-account-primary"
              disabled={busy}
              onClick={() => void startLogin()}
            >
              {t("Начать вход заново")}
            </button>
          )}
          {error && (
            <p className="settings-notice danger" role="alert">
              {error}
            </p>
          )}
          <p className="claude-account-hint claude-login-note">
            <CheckIcon />
            {t("После входа покажем почту и лимиты аккаунта.")}
          </p>
          <div className="claude-dialog-actions">
            {dialog.mode === "add" && (
              <button
                type="button"
                onClick={() => {
                  cancelActive();
                  setLogin(null);
                  setBusy(false);
                  setError(null);
                  setStep("connection");
                }}
              >
                {t("Назад")}
              </button>
            )}
            <button type="button" onClick={close}>
              {t("Отмена")}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function remaining(window?: CodexRateLimitWindow | null): number | null {
  return window && Number.isFinite(window.usedPercent)
    ? Math.max(0, Math.min(100, 100 - window.usedPercent))
    : null;
}

function formatPlan(plan: string): string {
  return (
    (
      {
        free: "Free",
        plus: "Plus",
        pro: "Pro",
        max: "Max",
        team: "Team",
        business: "Business",
        enterprise: "Enterprise",
      } as Record<string, string>
    )[plan.toLowerCase()] ?? plan
  );
}

function quotaExhausted(window?: CodexRateLimitWindow | null): boolean {
  return Boolean(window && Number.isFinite(window.usedPercent) && window.usedPercent >= 100);
}

function endpoint(host: string, port: number): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

function proxyDescription(proxy: ClaudeProxyStatus, t: Translate): string {
  return proxy.enabled
    ? (proxy.url ??
        `${proxy.protocol.toUpperCase()} · ${proxy.host && proxy.port ? endpoint(proxy.host, proxy.port) : t("Адрес недоступен")}`)
    : t("Без прокси");
}

function terminalLogin(login: ClaudeLoginStatus | CodexLoginStatus): boolean {
  return login.state === "completed" || login.state === "failed" || login.state === "cancelled";
}

function formatTime(value: number, language: string): string {
  return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function knownError(caught: unknown, fallback: string, language: "ru" | "en"): string {
  // Unknown backend output can contain native CLI arguments or provider credentials.
  if (!(caught instanceof Error)) return fallback;
  const translated = localizeKnownServerText("en", caught.message);
  if (
    !translated ||
    (translated === caught.message &&
      localizeKnownServerText("ru", caught.message) === caught.message)
  )
    return fallback;
  return localizeKnownServerText(language, caught.message) ?? fallback;
}
