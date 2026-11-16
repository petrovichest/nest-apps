import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api";
import { useConnection } from "../connection";
import { useI18n } from "../i18n";
import { SettingsGroup, SettingsRow } from "./SettingsPresentation";
import { ServerIcon } from "./Icons";
import { ActionLabel } from "./ActionLabel";

export function OpenProxySettings() {
  const { api } = useConnection();
  const { t } = useI18n();
  const [proxy, setProxy] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .readOpenProxy()
      .then(
        (status) => {
          if (!cancelled) {
            setConfigured(status.configured);
            setError(false);
          }
        },
        () => {
          if (!cancelled) {
            setError(true);
            setMessage(t("Не удалось загрузить настройки прокси."));
          }
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, t]);

  async function run(action: "save" | "test") {
    if (busy) return;
    setBusy(action);
    setError(false);
    try {
      if (action === "save") {
        const status = await api.saveOpenProxy(proxy.trim());
        if (!mounted.current) return;
        setProxy("");
        setConfigured(status.configured);
        setMessage(t("Прокси сохранён."));
      } else {
        const result = await api.testOpenProxy();
        if (!mounted.current) return;
        setError(!result.ok);
        setMessage(
          t(
            result.ok
              ? "Соединение через прокси проверено."
              : "Не удалось подключиться через прокси. Проверьте адрес и учётные данные.",
          ),
        );
      }
    } catch (failure) {
      if (!mounted.current) return;
      setError(true);
      setMessage(
        t(
          failure instanceof ApiClientError && failure.code === "validation_failed"
            ? "Проверьте адрес прокси."
            : failure instanceof ApiClientError && failure.code === "conflict"
              ? "Завершите активные задачи и повторите."
              : "Не удалось подключиться через прокси. Проверьте адрес и учётные данные.",
        ),
      );
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  return (
    <SettingsGroup
      icon={<ServerIcon />}
      title={t("Прокси OpenCode")}
      description={t("Прокси для запросов OpenCode к провайдерам моделей.")}
      loading={loading}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run("save");
        }}
      >
        <SettingsRow
          label={t("Адрес прокси")}
          labelFor="open-proxy"
          description={t(
            configured ? "Прокси настроен." : "HTTP, HTTPS или SOCKS5. Необязательная настройка.",
          )}
        >
          <input
            id="open-proxy"
            aria-describedby="open-proxy-status"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={proxy}
            onChange={(event) => setProxy(event.target.value)}
            placeholder="http://login:password@host:port"
            disabled={Boolean(busy)}
          />
        </SettingsRow>
        <div className="settings-actions">
          <button className="primary" type="submit" disabled={!proxy.trim() || Boolean(busy)}>
            <ActionLabel
              idle={t("Сохранить прокси")}
              busy={t("Сохраняем…")}
              pending={busy === "save"}
            />
          </button>
          <button
            type="button"
            disabled={!configured || Boolean(busy)}
            onClick={() => void run("test")}
          >
            <ActionLabel
              idle={t("Проверить соединение")}
              busy={t("Проверяем…")}
              pending={busy === "test"}
            />
          </button>
        </div>
        <p
          id="open-proxy-status"
          className="settings-feedback"
          style={{ minHeight: "3.2em" }}
          role={error ? "alert" : "status"}
        >
          {message || t("Изменение применяется к новым запросам.")}
        </p>
      </form>
    </SettingsGroup>
  );
}
