import { application } from "../application";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ModelOption,
  OpenRouterEndpoint,
  SessionSettings,
  ThreadGoal,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";
import { fastServiceTier, isFastServiceTier } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { useI18n, type Translate } from "../i18n";
import { Dialog } from "./Dialog";
import { CheckIcon, ModelIcon, PlanIcon, SearchIcon, TargetIcon, TeamIcon, XIcon } from "./Icons";

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
  const openRouterRuntime = models.some((option) => option.openRouter);
  const defaultModel = effectiveModel(models);
  const model = effectiveModel(models, value.model);
  const modelDisplayName = model ? compactModelName(model.displayName) : t("Модель");
  const defaultEffort = model?.reasoningEfforts.find((option) => option.isDefault)?.value;
  const effortDisplayName = value.reasoningEffort ?? defaultEffort ?? t("По умолчанию");
  const fastEnabled = application.isCodex && isFastServiceTier(value.serviceTier);

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
        title={`${modelDisplayName} · ${effortDisplayName}${fastEnabled ? " · Fast" : ""}`}
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
        {fastEnabled && <small className="model-fast-badge">Fast</small>}
      </button>
      {modelPopupOpen && (
        <ModelSettingsPopup
          models={models}
          model={model}
          defaultModelName={defaultModel?.displayName}
          modelId={value.model ?? null}
          endpoint={value.openRouterEndpoint ?? null}
          onEndpointChange={(openRouterEndpoint) => onChange({ openRouterEndpoint })}
          reasoningEffort={value.reasoningEffort ?? null}
          defaultEffort={defaultEffort}
          disabled={disabled}
          effortDisabled={effortDisabled}
          fastEnabled={fastEnabled}
          opener={modelPopupOpenerRef.current}
          onModelChange={changeModel}
          onEffortChange={(reasoningEffort) => onChange({ reasoningEffort })}
          onFastChange={(enabled) => onChange({ serviceTier: enabled ? "fast" : null })}
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

      {application.capabilities.team && !openRouterRuntime && (
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

      {/* A field without goal mode (a board task) shows no goal toggle. */}
      {application.capabilities.goal &&
        !openRouterRuntime &&
        (goal || onGoalModeChange) &&
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
    if (fastEnabled && !fastServiceTier(nextModel)) patch.serviceTier = null;
    onChange(patch);
  }
}

const openRouterDevelopers: Record<string, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  google: "Google",
  "meta-llama": "Meta",
  minimax: "MiniMax",
  mistralai: "Mistral AI",
  moonshotai: "Moonshot AI",
  openai: "OpenAI",
  qwen: "Qwen",
  "x-ai": "xAI",
  "z-ai": "Z.ai",
};

function developerName(id: string): string {
  return openRouterDevelopers[id] ?? id;
}

function ModelSettingsPopup({
  models,
  model,
  defaultModelName,
  modelId,
  endpoint,
  onEndpointChange,
  reasoningEffort,
  defaultEffort,
  disabled,
  effortDisabled,
  fastEnabled,
  opener,
  onModelChange,
  onEffortChange,
  onFastChange,
  onClose,
}: {
  models: ModelOption[];
  model: ModelOption | undefined;
  defaultModelName: string | undefined;
  modelId: string | null;
  endpoint: string | null;
  onEndpointChange(endpoint: string | null): void;
  reasoningEffort: string | null;
  defaultEffort: string | undefined;
  disabled: boolean;
  effortDisabled: boolean;
  fastEnabled: boolean;
  opener: HTMLElement | null;
  onModelChange(modelId: string | null): void;
  onEffortChange(reasoningEffort: string | null): void;
  onFastChange(enabled: boolean): void;
  onClose(): void;
}) {
  const { language, t } = useI18n();
  const [query, setQuery] = useState("");
  const [developer, setDeveloper] = useState("");
  const [sort, setSort] = useState("");
  const developers = [
    ...new Set(
      models.flatMap((option) => (option.openRouter ? [option.openRouter.developer] : [])),
    ),
  ].sort((a, b) => developerName(a).localeCompare(developerName(b), language));
  const search = query.trim().toLowerCase();
  const matches = models.filter(
    (option) =>
      (!developer || option.openRouter?.developer === developer) &&
      (!search ||
        [option.displayName, option.id, developerName(option.openRouter?.developer ?? "")].some(
          (value) => value.toLowerCase().includes(search),
        )),
  );
  if (sort === "developer") {
    matches.sort((a, b) =>
      developerName(a.openRouter?.developer ?? "").localeCompare(
        developerName(b.openRouter?.developer ?? ""),
        language,
      ),
    );
  } else if (sort === "inputPrice" || sort === "outputPrice") {
    matches.sort((a, b) => (a.openRouter?.[sort] ?? Infinity) - (b.openRouter?.[sort] ?? Infinity));
  }
  const rate = new Intl.NumberFormat(language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
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
        {developers.length > 0 && (
          <>
            <label className="skills-settings-search">
              <SearchIcon />
              <input
                type="search"
                aria-label={t("Поиск моделей")}
                placeholder={t("Поиск по названию или ID")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="model-settings-options">
              <div className="model-settings-section">
                <h3>
                  <label htmlFor="catalog-developer">{t("Разработчик")}</label>
                </h3>
                <select
                  id="catalog-developer"
                  value={developer}
                  onChange={(event) => setDeveloper(event.target.value)}
                >
                  <option value="">{t("Все разработчики")}</option>
                  {developers.map((id) => (
                    <option key={id} value={id}>
                      {developerName(id)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="model-settings-section">
                <h3>
                  <label htmlFor="catalog-sort">{t("Сортировка")}</label>
                </h3>
                <select
                  id="catalog-sort"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="">{t("Рекомендуемые")}</option>
                  <option value="inputPrice">{t("Цена входа")}</option>
                  <option value="outputPrice">{t("Цена выхода")}</option>
                  <option value="developer">{t("По разработчику")}</option>
                </select>
              </div>
            </div>
          </>
        )}
        {model?.openRouter && (
          <OpenRouterSupplierPicker
            key={model.id}
            model={model}
            endpoint={endpoint}
            disabled={disabled}
            onChange={onEndpointChange}
          />
        )}
        {matches.length === 0 && (
          <p className="muted" role="status">
            {t("Модели не найдены")}
          </p>
        )}
        <div className="model-settings-options" role="radiogroup" aria-label={t("Модель")}>
          {!search && !developer && (
            <SelectionOption
              title={t("По умолчанию")}
              description={defaultModelName}
              selected={modelId === null}
              disabled={disabled}
              onClick={() => onModelChange(null)}
            />
          )}
          {matches.map((option) => (
            <SelectionOption
              title={option.displayName}
              description={
                option.openRouter
                  ? t("${{input}} вход · ${{output}} выход за 1 млн", {
                      input: rate.format(option.openRouter.inputPrice),
                      output: rate.format(option.openRouter.outputPrice),
                    })
                  : option.description || undefined
              }
              selected={modelId === option.id}
              disabled={disabled}
              onClick={() => onModelChange(option.id)}
              key={option.id}
            />
          ))}
        </div>
      </section>

      {application.capabilities.reasoningEffort &&
        (application.isCodex || !!model?.reasoningEfforts.length) && (
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
      {application.isCodex && (
        <section className="model-settings-section">
          <button
            type="button"
            role="switch"
            aria-checked={fastEnabled}
            className={`model-settings-option${fastEnabled ? " active" : ""}`}
            disabled={disabled || !fastServiceTier(model)}
            onClick={() => onFastChange(!fastEnabled)}
          >
            <span>
              <strong>Fast mode</strong>
              <small>{t("Ускоряет ответы Codex и увеличивает расход лимитов.")}</small>
              {!fastServiceTier(model) && (
                <small>{t("Fast mode недоступен для этой модели.")}</small>
              )}
            </span>
            <CheckIcon />
          </button>
        </section>
      )}
    </Dialog>
  );
}

function OpenRouterSupplierPicker({
  model,
  endpoint,
  disabled,
  onChange,
}: {
  model: ModelOption;
  endpoint: string | null;
  disabled: boolean;
  onChange(endpoint: string | null): void;
}) {
  const { api } = useConnection();
  const { language, t } = useI18n();
  const [state, setState] = useState<{ routes: OpenRouterEndpoint[] } | { error: true } | null>(
    null,
  );
  useEffect(() => {
    let current = true;
    void api.readOpenRouterEndpoints(model.id).then(
      (routes) => {
        if (current) setState({ routes });
      },
      () => {
        if (current) setState({ error: true });
      },
    );
    return () => {
      current = false;
    };
  }, [api, model.id]);
  const routes = state && "routes" in state ? state.routes : [];
  const selected = routes.find((route) => route.slug === endpoint);
  const rate = new Intl.NumberFormat(language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  return (
    <section className="model-settings-section">
      <h3>
        <label htmlFor="catalog-upstream">
          {t("Поставщик {{model}}", { model: model.displayName })}
        </label>
      </h3>
      <select
        id="catalog-upstream"
        value={endpoint ?? ""}
        disabled={disabled || !state}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{t("Авто · OpenRouter")}</option>
        {endpoint && !selected && <option value={endpoint}>{endpoint}</option>}
        {routes.map((route) => (
          <option key={route.slug} value={route.slug}>
            {route.provider} · {route.slug}
          </option>
        ))}
      </select>
      <small className="model-speed-description" role="status">
        {!state
          ? t("Загружаем поставщиков…")
          : "error" in state
            ? t("Не удалось загрузить поставщиков.")
            : selected
              ? t("Вход / выход: ${{input}} / ${{output}} за 1 млн · {{policy}}", {
                  input: rate.format(selected.inputPrice),
                  output: rate.format(selected.outputPrice),
                  policy: t(
                    selected.retention === "zero"
                      ? "Без обычного хранения (ZDR)"
                      : selected.retention === "safety"
                        ? "Хранение для безопасности"
                        : "Политика хранения не подтверждена",
                  ),
                })
              : endpoint
                ? t("Сведения о выбранном поставщике недоступны.")
                : t("OpenRouter выбирает маршрут по настройкам конфиденциальности.")}
      </small>
    </section>
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
