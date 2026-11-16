import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api";
import { useConnection } from "../connection";
import { useI18n } from "../i18n";
import { SettingsGroup, SettingsRow } from "./SettingsPresentation";
import { ShieldIcon } from "./Icons";
import { ActionLabel } from "./ActionLabel";

export function OpenConnectionSettings() {
  const { api } = useConnection();
  const { t } = useI18n();
  const [key, setKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
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
      .readOpenConnection()
      .then(
        (status) => {
          if (!cancelled) {
            setConfigured(status.apiKeyConfigured);
            setError("");
          }
        },
        () => {
          if (!cancelled) setError(t("Не удалось загрузить настройки OpenCode."));
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
    setError("");
    setFeedback("");
    try {
      const status =
        action === "save" ? await api.saveOpenKey(key.trim()) : await api.testOpenConnection();
      if (!mounted.current) return;
      setConfigured(status.apiKeyConfigured);
      if (action === "save") {
        setKey("");
        setFeedback(t("Ключ сохранён."));
      } else if (status.runtime === "ready")
        setFeedback(t("OpenCode доступен. Ключ проверяется при запросе к модели."));
      else setError(t("OpenCode недоступен. Повторите проверку."));
    } catch (failure) {
      if (!mounted.current) return;
      setError(
        t(
          failure instanceof ApiClientError && failure.code === "validation_failed"
            ? "Проверьте формат API-ключа."
            : failure instanceof ApiClientError && failure.code === "conflict"
              ? "Завершите активные задачи и повторите."
              : action === "save"
                ? "OpenCode недоступен. Повторите сохранение."
                : "OpenCode недоступен. Повторите проверку.",
        ),
      );
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  return (
    <SettingsGroup
      icon={<ShieldIcon />}
      title="OpenRouter"
      description={t("Модели и выполнение задач — через OpenCode.")}
      loading={loading}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run("save");
        }}
      >
        <SettingsRow
          label={t("API-ключ OpenRouter")}
          labelFor="openrouter-key"
          description={t("Ключ хранится на сервере, в OpenCode.")}
        >
          <input
            id="openrouter-key"
            aria-describedby="openrouter-key-status"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="sk-or-…"
            disabled={Boolean(busy)}
          />
        </SettingsRow>
        <div className="settings-actions">
          <button className="primary" type="submit" disabled={!key.trim() || Boolean(busy)}>
            <ActionLabel
              idle={t("Сохранить ключ")}
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
              idle={t("Проверить OpenCode")}
              busy={t("Проверяем…")}
              pending={busy === "test"}
            />
          </button>
        </div>
        <p
          id="openrouter-key-status"
          className={error ? "form-error" : "settings-feedback"}
          role={error ? "alert" : "status"}
          style={{ minHeight: "3.2em" }}
        >
          {error || feedback || t("Ключ проверяется при запросе к модели.")}
        </p>
      </form>
    </SettingsGroup>
  );
}
