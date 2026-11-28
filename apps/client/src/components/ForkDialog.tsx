import { ActionLabel } from "./ActionLabel";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { application } from "../application";
import { useConnection } from "../connection";
import {
  type ForkEstimateResponse,
  type ForkMode,
  type ForkModeEstimate,
  type ForkOperationSummary,
} from "../forks";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { CheckIcon, GitBranchIcon, XIcon } from "./Icons";
import { Dialog } from "./Dialog";

const UNKNOWN_EXACT: ForkModeEstimate = {
  available: true,
  estimatedBytes: null,
  estimatedSeconds: null,
  unavailableReason: null,
};

const FRESH_COMPRESSED: ForkModeEstimate = {
  available: true,
  estimatedBytes: null,
  estimatedSeconds: { minSeconds: 60, maxSeconds: 600 },
  unavailableReason: null,
};

export function ForkDialog({
  sourceThreadId,
  sourceTitle,
  lastTurnId,
  agentMessageId,
  openerRef,
  onClose,
  onCreated,
}: {
  sourceThreadId: string;
  sourceTitle: string;
  lastTurnId: string;
  agentMessageId: string;
  openerRef?: RefObject<HTMLElement | null>;
  onClose(): void;
  onCreated(operation: ForkOperationSummary): void;
}) {
  const { api } = useConnection();
  const { language, t } = useI18n();
  const operationIdRef = useRef(createOperationId());
  const submittingRef = useRef(false);
  const modeOptionsRef = useRef<HTMLDivElement>(null);
  const restoreModeFocusRef = useRef(false);
  const [estimate, setEstimate] = useState<ForkEstimateResponse | null>(null);
  const [estimateFailed, setEstimateFailed] = useState(false);
  const [preferredMode, setMode] = useState<ForkMode>("compressed");
  const [arrowNavigation, setArrowNavigation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .estimateFork(sourceThreadId, { lastTurnId, agentMessageId })
      .then((response) => {
        if (!active) return;
        if (application.isOpen && response.compressed?.available === false) {
          restoreModeFocusRef.current = Boolean(
            modeOptionsRef.current?.querySelector('input[value="compressed"]:focus'),
          );
        }
        setEstimate(response);
      })
      .catch(() => {
        if (!active) return;
        setEstimateFailed(true);
      });
    return () => {
      active = false;
    };
  }, [agentMessageId, api, lastTurnId, sourceThreadId]);

  const reportedCompression = estimate?.compressed;
  const compressed: ForkModeEstimate = {
    available: !application.isOpen || reportedCompression?.available !== false,
    estimatedBytes: application.isOpen ? (reportedCompression?.estimatedBytes ?? null) : null,
    estimatedSeconds: reportedCompression?.estimatedSeconds ?? FRESH_COMPRESSED.estimatedSeconds,
    unavailableReason: application.isOpen ? (reportedCompression?.unavailableReason ?? null) : null,
  };
  const exact: ForkModeEstimate = { ...UNKNOWN_EXACT, ...estimate?.exact };
  const mode =
    preferredMode === "compressed" && !compressed.available && exact.available
      ? "exact"
      : preferredMode;
  const selectedEstimate = mode === "compressed" ? compressed : exact;

  useLayoutEffect(() => {
    if (!restoreModeFocusRef.current) return;
    restoreModeFocusRef.current = false;
    (
      modeOptionsRef.current?.querySelector<HTMLInputElement>("input:checked:not(:disabled)") ??
      modeOptionsRef.current
    )?.focus();
  }, [estimate]);

  function close() {
    if (!submittingRef.current) onClose();
  }

  async function create() {
    if (!selectedEstimate.available || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const { operation } = await api.createForkOperation(sourceThreadId, {
        operationId: operationIdRef.current,
        lastTurnId,
        agentMessageId,
        mode,
      });
      onCreated(operation);
    } catch (caught) {
      submittingRef.current = false;
      setSubmitting(false);
      setError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось начать создание ответвления"),
      );
    }
  }

  return (
    <Dialog
      titleId="fork-dialog-title"
      className="fork-dialog chat-dialog"
      backdropClassName="fork-dialog-backdrop"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      returnFocusRef={openerRef}
      onClose={close}
    >
      <div className="dialog-header fork-dialog-header">
        <div className="dialog-heading">
          <h2 id="fork-dialog-title">{t("Создать ветку")}</h2>
          <p>{t("Выберите, сколько истории взять с собой.")}</p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={t("Закрыть")}
          disabled={submitting}
          onClick={close}
        >
          <XIcon />
        </button>
      </div>

      <div className="fork-dialog-body">
        <div className="fork-source-summary">
          <span className="fork-source-icon" aria-hidden="true">
            <GitBranchIcon />
          </span>
          <span className="fork-source-copy">
            <small>{t("Точка ответвления")}</small>
            <strong>{sourceTitle}</strong>
          </span>
          <span className={`fork-source-size${estimate || estimateFailed ? "" : " working-text"}`}>
            {estimate || estimateFailed
              ? estimate
                ? formatForkBytes(estimate.sourceBytes, language, t)
                : t("размер неизвестен")
              : t("Считаем…")}
          </span>
        </div>

        <div
          className={`fork-mode-options${arrowNavigation ? " arrow-navigation" : ""}`}
          ref={modeOptionsRef}
          tabIndex={-1}
          role="radiogroup"
          aria-label={t("Способ переноса контекста")}
          onKeyDown={(event) => {
            if (event.key.startsWith("Arrow")) setArrowNavigation(true);
          }}
          onPointerDown={() => setArrowNavigation(false)}
        >
          <ForkModeCard
            mode="compressed"
            title={t("Компактная")}
            badge={t("Быстрее")}
            description={t(
              "Создаёт свежее сжатие и переносит только компактный контекст. Лучше для больших сессий.",
            )}
            estimate={compressed}
            loading={!estimate && !estimateFailed}
            checked={mode === "compressed"}
            onChange={setMode}
            t={t}
            language={language}
          />
          <ForkModeCard
            mode="exact"
            title={t("Полная история")}
            description={t(
              "Копирует всё до выбранного ответа. Выбирайте, если важны дословные детали.",
            )}
            estimate={exact}
            loading={!estimate && !estimateFailed}
            checked={mode === "exact"}
            onChange={setMode}
            t={t}
            language={language}
          />
        </div>

        {error && (
          <div className="dialog-notice danger" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="dialog-actions fork-dialog-actions">
        <button type="button" disabled={submitting} onClick={close}>
          {t("Отмена")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!selectedEstimate.available || submitting}
          aria-busy={submitting || undefined}
          onClick={() => void create()}
        >
          <ActionLabel idle={t("Создать ветку")} busy={t("Создаём…")} pending={submitting} />
        </button>
      </div>
    </Dialog>
  );
}

function ForkModeCard({
  mode,
  title,
  badge,
  description,
  estimate,
  loading,
  checked,
  onChange,
  t,
  language,
}: {
  mode: ForkMode;
  title: string;
  badge?: string;
  description: string;
  estimate: ForkModeEstimate;
  loading: boolean;
  checked: boolean;
  onChange(mode: ForkMode): void;
  t: Translate;
  language: "ru" | "en";
}) {
  const unavailable = !loading && !estimate.available;
  return (
    <label
      className={`fork-mode-card${checked ? " selected" : ""}${unavailable ? " unavailable" : ""}`}
    >
      <input
        type="radio"
        name="fork-mode"
        value={mode}
        checked={checked}
        disabled={unavailable}
        onChange={() => onChange(mode)}
      />
      <span className="fork-mode-heading">
        <strong>{title}</strong>
        {badge && estimate.available && (
          <span className="fork-mode-badge">
            <CheckIcon />
            {badge}
          </span>
        )}
      </span>
      <span className="fork-mode-control" aria-hidden="true">
        {checked && <CheckIcon />}
      </span>
      <span className="fork-mode-description">{description}</span>
      <span className="fork-mode-metrics" aria-busy={loading || undefined}>
        {unavailable ? (
          <span className="fork-mode-unavailable">
            {localizeKnownServerText(language, estimate.unavailableReason) ??
              t("Этот способ сейчас недоступен")}
          </span>
        ) : (
          <>
            <span>
              <small>{t("Объём")}</small>
              <span
                className={`fork-metric-value${loading ? " working-text working-text-strong" : ""}`}
              >
                {loading
                  ? t("Считаем…")
                  : mode === "compressed" && estimate.estimatedBytes === null
                    ? t("рассчитается при создании")
                    : formatForkBytes(estimate.estimatedBytes, language, t)}
              </span>
            </span>
            <span>
              <small>{t("Время")}</small>
              <span
                className={`fork-metric-value${loading ? " working-text working-text-strong" : ""}`}
              >
                {loading ? t("Считаем…") : formatForkTime(estimate.estimatedSeconds, t)}
              </span>
            </span>
          </>
        )}
      </span>
    </label>
  );
}

export function formatForkBytes(bytes: number | null, language: "ru" | "en", t: Translate): string {
  if (bytes == null) return t("неизвестно");
  const units = [t("Б"), t("КБ"), t("МБ"), t("ГБ")];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", {
    maximumFractionDigits: unit === 0 ? 0 : value < 10 ? 1 : 0,
  }).format(value)} ${units[unit]}`;
}

export function formatForkTime(value: ForkModeEstimate["estimatedSeconds"], t: Translate): string {
  if (!value) return t("неизвестно");
  const compact = (seconds: number) =>
    seconds < 60
      ? t("{{count}} с", { count: seconds })
      : t("{{count}} мин", { count: Math.ceil(seconds / 60) });
  return value.minSeconds === value.maxSeconds
    ? `≈ ${compact(value.minSeconds)}`
    : `≈ ${compact(value.minSeconds)}–${compact(value.maxSeconds)}`;
}

function createOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
