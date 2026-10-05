import { application } from "../application";
import { useCallback, useRef, useState } from "react";

import type {
  ModelOption,
  SessionSettings,
  ThreadGoal,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { useI18n, type Translate } from "../i18n";
import { Dialog } from "./Dialog";
import { CheckIcon, ModelIcon, PlanIcon, TargetIcon, TeamIcon, XIcon } from "./Icons";

export function SettingsPicker({
  models,
  value,
  disabled,
  teamToggleDisabled = disabled,
  effortDisabled = false,
  onChange,
  goalMode,
  goal,
  goalBusy = false,
  onGoalModeChange,
  onGoalUpdate,
  onGoalClear,
}: {
  models: ModelOption[];
  value: SessionSettings;
  disabled: boolean;
  teamToggleDisabled?: boolean;
  effortDisabled?: boolean;
  onChange(value: UpdateThreadSettingsRequest): void;
  goalMode: boolean;
  goal?: ThreadGoal | null;
  goalBusy?: boolean;
  onGoalModeChange?(value: boolean): void;
  onGoalUpdate?(value: UpdateThreadGoalRequest): void;
  onGoalClear?(): void;
}) {
  const { language, t } = useI18n();
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const modelPopupOpenerRef = useRef<HTMLElement | null>(null);
  const [modelPopupOpen, setModelPopupOpen] = useState(false);
  const closeModelPopup = useCallback(() => setModelPopupOpen(false), []);
  const defaultModel = effectiveModel(models);
  const model = effectiveModel(models, value.model);
  const modelDisplayName = model ? compactModelName(model.displayName) : t("Модель");
  const defaultEffort = model?.reasoningEfforts.find((option) => option.isDefault)?.value;
  const effortDisplayName = value.reasoningEffort ?? defaultEffort ?? t("По умолчанию");

  return (
    <div className="settings-picker">
      <button
        ref={modelButtonRef}
        type="button"
        aria-label={t("Модель и уровень рассуждений")}
        aria-haspopup="dialog"
        aria-expanded={modelPopupOpen}
        className="setting-control model-toggle"
        disabled={disabled || !models.length}
        title={`${modelDisplayName} · ${effortDisplayName}`}
        onClick={(event) => {
          const activeElement = event.currentTarget.ownerDocument.activeElement;
          modelPopupOpenerRef.current =
            activeElement instanceof HTMLElement &&
            activeElement !== event.currentTarget.ownerDocument.body
              ? activeElement
              : event.currentTarget;
          setModelPopupOpen(true);
        }}
      >
        <ModelIcon />
        <span>{modelDisplayName}</span>
      </button>
      {modelPopupOpen && (
        <ModelSettingsPopup
          models={models}
          model={model}
          defaultModelName={defaultModel?.displayName}
          modelId={value.model ?? null}
          reasoningEffort={value.reasoningEffort ?? null}
          defaultEffort={defaultEffort}
          disabled={disabled}
          effortDisabled={effortDisabled}
          opener={modelPopupOpenerRef.current}
          onModelChange={changeModel}
          onEffortChange={(reasoningEffort) => onChange({ reasoningEffort })}
          onClose={closeModelPopup}
        />
      )}

      {application.capabilities.plan && (
        <button
          aria-label={
            value.collaborationMode === "plan"
              ? t("Выключить режим планирования")
              : t("Включить режим планирования")
          }
          aria-pressed={value.collaborationMode === "plan"}
          className={`setting-control plan-toggle${value.collaborationMode === "plan" ? " active" : ""}`}
          disabled={disabled || !model || Boolean(goal)}
          type="button"
          onClick={() => {
            onGoalModeChange?.(false);
            onChange({
              collaborationMode: value.collaborationMode === "plan" ? "default" : "plan",
            });
          }}
        >
          <PlanIcon />
        </button>
      )}

      {application.capabilities.team && (
        <button
          aria-label={
            value.collaborationMode === "team"
              ? t("Выключить командный режим")
              : t("Включить командный режим")
          }
          aria-pressed={value.collaborationMode === "team"}
          className={`setting-control team-toggle${value.collaborationMode === "team" ? " active" : ""}`}
          disabled={teamToggleDisabled || !model || Boolean(goal)}
          type="button"
          onClick={() => {
            onGoalModeChange?.(false);
            onChange({
              collaborationMode: value.collaborationMode === "team" ? "default" : "team",
            });
          }}
        >
          <TeamIcon />
        </button>
      )}

      {application.capabilities.goal &&
        (goal ? (
          <details className="goal-picker" data-dismiss-on-outside-click>
            <summary
              className="setting-control goal-toggle active"
              aria-label={t("Управление целью")}
            >
              <TargetIcon />
            </summary>
            <div className="goal-popover">
              <div className="goal-popover-heading">
                <strong>{goalStatusLabel(goal.status, t)}</strong>
                <span>{formatGoalUsage(goal, language, t)}</span>
              </div>
              <p>{goal.objective}</p>
              <div className="goal-popover-actions">
                {goal.status === "active" && (
                  <button
                    type="button"
                    disabled={goalBusy}
                    onClick={() => onGoalUpdate?.({ status: "paused" })}
                  >
                    {t("Пауза")}
                  </button>
                )}
                {["paused", "blocked"].includes(goal.status) && (
                  <button
                    type="button"
                    disabled={goalBusy}
                    onClick={() => onGoalUpdate?.({ status: "active" })}
                  >
                    {t("Продолжить")}
                  </button>
                )}
                <button type="button" disabled={goalBusy} onClick={onGoalClear}>
                  {t("Очистить")}
                </button>
              </div>
            </div>
          </details>
        ) : (
          <button
            aria-label={goalMode ? t("Выключить режим цели") : t("Включить режим цели")}
            aria-pressed={goalMode}
            className={`setting-control goal-toggle${goalMode ? " active" : ""}`}
            disabled={disabled || !model}
            type="button"
            onClick={() => {
              const next = !goalMode;
              if (next && value.collaborationMode !== "default") {
                onChange({ collaborationMode: "default" });
              }
              onGoalModeChange?.(next);
            }}
          >
            <TargetIcon />
          </button>
        ))}
    </div>
  );

  function changeModel(modelId: string | null) {
    const nextModel = effectiveModel(models, modelId ?? undefined);
    const patch: UpdateThreadSettingsRequest = { model: modelId };
    if (
      !effortDisabled &&
      value.reasoningEffort &&
      !nextModel?.reasoningEfforts.some((option) => option.value === value.reasoningEffort)
    ) {
      patch.reasoningEffort =
        nextModel?.reasoningEfforts.find((option) => option.isDefault)?.value ?? null;
    }
    if (value.personality && !nextModel?.supportsPersonality) patch.personality = null;
    onChange(patch);
  }
}

function ModelSettingsPopup({
  models,
  model,
  defaultModelName,
  modelId,
  reasoningEffort,
  defaultEffort,
  disabled,
  effortDisabled,
  opener,
  onModelChange,
  onEffortChange,
  onClose,
}: {
  models: ModelOption[];
  model: ModelOption | undefined;
  defaultModelName: string | undefined;
  modelId: string | null;
  reasoningEffort: string | null;
  defaultEffort: string | undefined;
  disabled: boolean;
  effortDisabled: boolean;
  opener: HTMLElement | null;
  onModelChange(modelId: string | null): void;
  onEffortChange(reasoningEffort: string | null): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(opener);
  openerRef.current = opener;

  return (
    <Dialog
      ariaLabel={t("Настройки модели")}
      className="model-settings-popup"
      backdropClassName="model-settings-backdrop"
      closeOnBackdrop
      closeOnEscape
      initialFocusRef={closeButtonRef}
      returnFocusRef={openerRef}
      onClose={onClose}
    >
      <section className="model-settings-section">
        <div className="model-settings-section-header">
          <h3>{t("Модель")}</h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button"
            aria-label={t("Закрыть")}
            onClick={onClose}
          >
            <XIcon />
          </button>
        </div>
        <div className="model-settings-options" role="radiogroup" aria-label={t("Модель")}>
          <SelectionOption
            title={t("По умолчанию")}
            description={defaultModelName}
            selected={modelId === null}
            disabled={disabled}
            onClick={() => onModelChange(null)}
          />
          {models.map((option) => (
            <SelectionOption
              title={option.displayName}
              description={option.description || undefined}
              selected={modelId === option.id}
              disabled={disabled}
              onClick={() => onModelChange(option.id)}
              key={option.id}
            />
          ))}
        </div>
      </section>

      {application.capabilities.reasoningEffort &&
        (!application.isClaude || !!model?.reasoningEfforts.length) && (
          <section className="model-settings-section">
            <h3>{t("Уровень рассуждений")}</h3>
            <div
              className="model-settings-options effort-options"
              role="radiogroup"
              aria-label={t("Уровень рассуждений")}
            >
              <SelectionOption
                title={t("По умолчанию")}
                description={defaultEffort}
                selected={reasoningEffort === null}
                disabled={disabled || effortDisabled || !model}
                onClick={() => onEffortChange(null)}
              />
              {model?.reasoningEfforts.map((option) => (
                <SelectionOption
                  title={option.value}
                  description={option.description ?? undefined}
                  selected={reasoningEffort === option.value}
                  disabled={disabled || effortDisabled}
                  onClick={() => onEffortChange(option.value)}
                  key={option.value}
                />
              ))}
            </div>
          </section>
        )}
    </Dialog>
  );
}

function SelectionOption({
  title,
  description,
  selected,
  disabled,
  onClick,
}: {
  title: string;
  description?: string;
  selected: boolean;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`model-settings-option${selected ? " active" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </span>
      <CheckIcon />
    </button>
  );
}

function goalStatusLabel(status: ThreadGoal["status"], t: Translate): string {
  const labels: Record<ThreadGoal["status"], string> = {
    active: "Цель активна",
    paused: "Цель на паузе",
    blocked: "Цель заблокирована",
    usageLimited: "Достигнут лимит использования",
    budgetLimited: "Достигнут бюджет цели",
    complete: "Цель выполнена",
  };
  return t(labels[status]);
}

function formatGoalUsage(goal: ThreadGoal, language: "en" | "ru", t: Translate): string {
  const minutes = Math.floor(goal.timeUsedSeconds / 60);
  const seconds = goal.timeUsedSeconds % 60;
  const time = minutes
    ? t("{{count}}м {{seconds}}с", { count: minutes, seconds })
    : t("{{count}}с", { count: seconds });
  const modulo100 = goal.tokensUsed % 100;
  const modulo10 = goal.tokensUsed % 10;
  const tokenLabel =
    language === "en"
      ? goal.tokensUsed === 1
        ? "{{count}} токен"
        : "{{count}} токенов"
      : modulo100 >= 11 && modulo100 <= 14
        ? "{{count}} токенов"
        : modulo10 === 1
          ? "{{count}} токен"
          : modulo10 >= 2 && modulo10 <= 4
            ? "{{count}} токена"
            : "{{count}} токенов";
  return `${t(tokenLabel, { count: goal.tokensUsed.toLocaleString(language) })} · ${time}`;
}

function effectiveModel(models: ModelOption[], modelId?: string): ModelOption | undefined {
  if (modelId) return models.find((model) => model.id === modelId);
  return models.find((model) => model.isDefault) ?? models[0];
}

function compactModelName(displayName: string): string {
  const match = /^gpt-([0-9]+(?:\.[0-9]+)*)(?:-(.+))?$/i.exec(displayName.trim());
  if (!match) return displayName;
  const [, version, variant] = match;
  return variant ? `${version}${variant.replaceAll("-", "").toLowerCase()}` : version;
}
