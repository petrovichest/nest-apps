import { ActionLabel } from "./ActionLabel";
import { useEffect, useRef, useState } from "react";

import type { AppUpdateStatus, CodexManagementStatus } from "@codexnest/protocol";

import { ApiClientError } from "../api";
import { application } from "../application";
import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";
import { AlertIcon } from "./Icons";
import { SettingsGroup } from "./SettingsPresentation";

type RecoveryAction = "app" | "codex" | null;
type Feedback = { kind: "error" | "success"; message: string } | null;

const APP_RESTART_TIMEOUT_MS = 90_000;
const reloadPage = () => window.location.reload();

export function RecoverySettingsCard({
  appStatus,
  codexStatus,
  onReload = reloadPage,
}: {
  appStatus: AppUpdateStatus | null;
  codexStatus: CodexManagementStatus | null;
  onReload?(): void;
}) {
  const { api, state } = useConnection();
  const { language, t } = useI18n();
  const [action, setAction] = useState<RecoveryAction>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const sawAppDisconnect = useRef(false);

  useEffect(() => {
    if (action !== "app") return;
    if (state.network !== "connected") {
      sawAppDisconnect.current = true;
      return;
    }
    if (sawAppDisconnect.current) {
      sawAppDisconnect.current = false;
      setAction(null);
      onReload();
    }
  }, [action, onReload, state.network]);

  useEffect(() => {
    if (action !== "app") return;
    const timer = window.setTimeout(() => {
      setAction(null);
      setFeedback({
        kind: "error",
        message: t("CodexNest не восстановил соединение после перезапуска."),
      });
    }, APP_RESTART_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [action, t]);

  async function forceRestartApp() {
    if (
      !window.confirm(
        t(
          application.capabilities.codexManagement
            ? "Жёстко перезапустить CodexNest? Текущее обновление будет остановлено, а незавершённые операции интерфейса могут быть прерваны. Codex daemon останется запущен."
            : "Жёстко перезапустить CodexNest? Текущее обновление будет остановлено, а незавершённые операции интерфейса могут быть прерваны. Сессии Codex продолжат работу.",
        ),
      )
    ) {
      return;
    }
    sawAppDisconnect.current = false;
    setAction("app");
    setFeedback(null);
    try {
      await api.forceRestartApp();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === "connection_failed") return;
      setAction(null);
      setFeedback({
        kind: "error",
        message: errorMessage(
          caught,
          t("Не удалось запустить аварийный перезапуск CodexNest"),
          language,
        ),
      });
    }
  }

  async function forceRestartCodex() {
    if (
      !window.confirm(
        t("Жёстко перезапустить Codex daemon? Все активные ответы Codex будут прерваны."),
      )
    ) {
      return;
    }
    setAction("codex");
    setFeedback(null);
    try {
      await api.forceRestartCodex();
      setFeedback({ kind: "success", message: t("Codex daemon аварийно перезапущен.") });
    } catch (caught) {
      setFeedback({
        kind: "error",
        message: errorMessage(
          caught,
          t("Не удалось аварийно перезапустить Codex daemon"),
          language,
        ),
      });
    } finally {
      setAction(null);
    }
  }

  const disconnected = state.network !== "connected";
  const recoveryInProgress = action !== null;
  const activeTurnCount =
    state.snapshot?.threads?.filter((thread) => thread.currentTurnId !== null).length ?? 0;

  return (
    <SettingsGroup
      className="recovery-settings-card"
      description={t(
        "Используйте только если обычное обновление или работа сессий зависли. Эти действия обходят безопасное ожидание активных задач.",
      )}
      icon={<AlertIcon />}
      title={t("Аварийное восстановление")}
    >
      <div className="settings-feedback-slot">
        <div className="settings-notice danger" role="status">
          {activeTurnCount > 0
            ? t("Активных ответов: {{count}}. Жёсткий перезапуск может их прервать.", {
                count: activeTurnCount,
              })
            : t("Жёсткий перезапуск может прервать незавершённые операции.")}
        </div>

        {feedback && (
          <div
            className={`settings-notice ${feedback.kind === "error" ? "danger" : "success"}`}
            role={feedback.kind === "error" ? "alert" : "status"}
          >
            {feedback.message}
          </div>
        )}
      </div>

      <div className="settings-actions codex-actions recovery-actions">
        <button
          className="danger"
          disabled={appStatus?.supported !== true || disconnected || recoveryInProgress}
          type="button"
          onClick={() => void forceRestartApp()}
        >
          <ActionLabel
            idle={t("Жёстко перезапустить CodexNest")}
            busy={t("Перезапускаем CodexNest…")}
            pending={action === "app"}
          />
        </button>
        {application.capabilities.codexManagement && (
          <button
            className="danger"
            disabled={codexStatus?.supported !== true || disconnected || recoveryInProgress}
            type="button"
            onClick={() => void forceRestartCodex()}
          >
            <ActionLabel
              idle={t("Жёстко перезапустить Codex")}
              busy={t("Перезапускаем Codex…")}
              pending={action === "codex"}
            />
          </button>
        )}
      </div>
    </SettingsGroup>
  );
}

function errorMessage(error: unknown, fallback: string, language: "en" | "ru"): string {
  return error instanceof Error
    ? (localizeKnownServerText(language, error.message) ?? error.message)
    : fallback;
}
