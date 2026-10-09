import { application } from "../application";
import { useEffect, useRef, useState } from "react";

import type { GitChangesSummary, Project, ThreadSummary } from "@codexnest/protocol";

import type { SessionArtifact } from "../artifacts";
import { copyText } from "../clipboard";
import { useI18n, type Translate } from "../i18n";
import { threadStatusClasses } from "../thread-status";
import {
  ArrowDownIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  ServerIcon,
  XIcon,
} from "./Icons";

export type GitChangesView = GitChangesSummary | "error" | null;
export type InspectorTab = "overview" | "artifacts";
export type ArtifactLoadState = "idle" | "loading" | "error";

export function SessionInspector({
  open,
  summary,
  project,
  gitChanges,
  activeTab,
  artifacts,
  artifactCapability,
  artifactLoadState,
  onClose,
  onTabChange,
  onArtifactOpen,
  onArtifactDownload,
  onArtifactRetry,
}: {
  open: boolean;
  summary: ThreadSummary;
  project: Project | null;
  gitChanges: GitChangesView;
  activeTab: InspectorTab;
  artifacts: SessionArtifact[];
  artifactCapability: "explicit" | "unavailable" | null;
  artifactLoadState: ArtifactLoadState;
  onClose(): void;
  onTabChange(tab: InspectorTab): void;
  onArtifactOpen(artifact: SessionArtifact, opener: HTMLButtonElement): void;
  onArtifactDownload(path: string): Promise<void>;
  onArtifactRetry(): void;
}) {
  const { language, t } = useI18n();
  if (!open) return null;
  const artifactsTabLabel = artifactCapability
    ? t("Артефакты, {{count}}", { count: artifacts.length })
    : t("Артефакты");
  return (
    <aside className="session-inspector open" aria-label={t("Сведения о задаче")}>
      <div className="inspector-heading">
        <strong>{t("Сессия")}</strong>
        <button className="icon-button" aria-label={t("Закрыть сведения")} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label={t("Разделы сведений")}>
        <button
          type="button"
          id="session-overview-tab"
          role="tab"
          aria-controls="session-overview-panel"
          aria-selected={activeTab === "overview"}
          className={activeTab === "overview" ? "active" : undefined}
          onClick={() => onTabChange("overview")}
        >
          {t("Обзор")}
        </button>
        {application.capabilities.artifacts && (
          <button
            type="button"
            id="session-artifacts-tab"
            role="tab"
            aria-controls="session-artifacts-panel"
            aria-label={artifactsTabLabel}
            aria-selected={activeTab === "artifacts"}
            className={activeTab === "artifacts" ? "active" : undefined}
            onClick={() => onTabChange("artifacts")}
          >
            <span>{t("Артефакты")}</span>
            <span className="inspector-tab-count" aria-hidden="true">
              {artifactCapability ? artifacts.length : "…"}
            </span>
          </button>
        )}
      </div>

      {activeTab === "overview" ? (
        <div
          id="session-overview-panel"
          className="inspector-panel inspector-overview"
          role="tabpanel"
          aria-labelledby="session-overview-tab"
        >
          <section className="inspector-section">
            <h2>
              <FolderIcon />
              {t("Проект")}
            </h2>
            <div className="inspector-project-name">{project?.displayName ?? t("Без проекта")}</div>
            <InspectorPath key={summary.cwd} path={summary.cwd} />
            <dl className="inspector-list">
              {application.capabilities.gitChanges && (
                <InspectorRow technical label={t("Изменения Git")}>
                  <GitChangesValue value={gitChanges} />
                </InspectorRow>
              )}
            </dl>
          </section>
          <section className="inspector-section">
            <h2>
              <ServerIcon />
              {t("Выполнение")}
            </h2>
            <dl className="inspector-list">
              <InspectorRow label={t("Статус")}>
                <span className={`status-label status-label-${summary.state}`}>
                  <span className={threadStatusClasses(summary)} />
                  <span
                    className={
                      summary.state === "running" ? "working-text working-text-strong" : undefined
                    }
                  >
                    {stateLabel(summary.state, t)}
                  </span>
                </span>
              </InspectorRow>
              <InspectorRow label={t("Модель")}>
                {summary.codexSettings?.model ?? t("Не сообщено")}
              </InspectorRow>
              <InspectorRow label={t("Усилие")}>
                {summary.codexSettings?.reasoningEffort ?? t("Не сообщено")}
              </InspectorRow>
              <InspectorRow label={t("Приём сообщений")}>
                {summary.canAcceptDirectInput == null
                  ? t("Не сообщено")
                  : summary.canAcceptDirectInput
                    ? t("Доступен")
                    : t("Временно недоступен")}
              </InspectorRow>
            </dl>
          </section>
          <section className="inspector-section">
            <h2>
              <ClockIcon />
              {t("Активность")}
            </h2>
            <dl className="inspector-list inspector-dates">
              <InspectorRow label={t("Создана")}>
                <time dateTime={new Date(summary.createdAt).toISOString()}>
                  {formatDate(summary.createdAt, language)}
                </time>
              </InspectorRow>
              <InspectorRow label={t("Обновлена")}>
                <time dateTime={new Date(summary.updatedAt).toISOString()}>
                  {formatDate(summary.updatedAt, language)}
                </time>
              </InspectorRow>
            </dl>
          </section>
        </div>
      ) : (
        <div
          id="session-artifacts-panel"
          className="inspector-panel inspector-artifacts"
          role="tabpanel"
          aria-labelledby="session-artifacts-tab"
        >
          {artifacts.length > 0 && (
            <div className="inspector-artifact-list">
              {artifacts.map((artifact) => (
                <InspectorArtifact
                  artifact={artifact}
                  key={artifact.id}
                  onDownload={onArtifactDownload}
                  onOpen={onArtifactOpen}
                />
              ))}
            </div>
          )}
          {artifactLoadState === "loading" && (
            <div className="inspector-artifact-progress" role="status">
              <span className="spinner small" />
              <span className="working-text">{t("Загружаем артефакты…")}</span>
            </div>
          )}
          {artifactLoadState === "error" && (
            <div className="inspector-artifact-error" role="alert">
              <span>{t("Не удалось загрузить артефакты.")}</span>
              <button type="button" onClick={onArtifactRetry}>
                {t("Повторить")}
              </button>
            </div>
          )}
          {artifactCapability === "explicit" && artifacts.length === 0 && (
            <div className="inspector-artifact-empty">
              <span className="inspector-artifact-empty-icon">
                <FileIcon />
              </span>
              <strong>{t("В этой сессии пока нет артефактов")}</strong>
              <span>{t("Файлы появятся здесь, когда Codex приложит их к ответу.")}</span>
            </div>
          )}
          {artifactCapability === "unavailable" && (
            <div className="inspector-artifact-empty">
              <span className="inspector-artifact-empty-icon">
                <FileIcon />
              </span>
              <strong>{t("Артефакты недоступны для этой сессии")}</strong>
              <span>{t("Явные артефакты доступны в новых сессиях.")}</span>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

export function NewSessionInspector({
  open,
  project,
  onClose,
}: {
  open: boolean;
  project: Project | null;
  onClose(): void;
}) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <aside className="session-inspector open" aria-label={t("Сведения о новой задаче")}>
      <div className="inspector-heading">
        <strong>{t("Новая задача")}</strong>
        <button className="icon-button" aria-label={t("Закрыть сведения")} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="inspector-panel inspector-overview new-session-inspector-panel">
        <section className="inspector-section">
          <h2>
            <FolderIcon />
            {t("Проект")}
          </h2>
          <div className="inspector-project-name">{project?.displayName ?? t("Не выбран")}</div>
          {project && <InspectorPath key={project.path} path={project.path} />}
        </section>
        <p className="inspector-note">
          {t("Задача будет создана после отправки первого сообщения.")}
        </p>
      </div>
    </aside>
  );
}

function InspectorPath({ path }: { path: string }) {
  const { t } = useI18n();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await copyText(path);
      if (!mounted.current) return;
      setCopyState("copied");
      timer.current = setTimeout(() => setCopyState("idle"), 2_000);
    } catch {
      if (mounted.current) setCopyState("failed");
    }
  }

  const label = copyState === "copied" ? t("Путь скопирован") : t("Копировать путь");
  return (
    <div className="inspector-path">
      <span className="sr-only">{t("Рабочая папка")}</span>
      <div className="inspector-path-row">
        <code>{path}</code>
        <button
          type="button"
          className="icon-button inspector-path-copy"
          aria-label={label}
          title={label}
          onClick={() => void copy()}
        >
          {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <span className="sr-only" role="status">
        {copyState === "copied" ? t("Путь скопирован") : ""}
      </span>
      {copyState === "failed" && (
        <span className="inspector-copy-error" role="alert">
          {t("Не удалось скопировать путь")}
        </span>
      )}
    </div>
  );
}

function InspectorArtifact({
  artifact,
  onOpen,
  onDownload,
}: {
  artifact: SessionArtifact;
  onOpen(artifact: SessionArtifact, opener: HTMLButtonElement): void;
  onDownload(path: string): Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onDownload(artifact.path);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const actionLabel = artifact.preview
    ? t("Открыть {{name}}", { name: artifact.fileName })
    : t("Скачать {{name}}", { name: artifact.fileName });

  return (
    <div className="inspector-artifact-item">
      <div className="inspector-artifact-row">
        <button
          type="button"
          className="inspector-artifact-open"
          data-artifact-path={artifact.path}
          aria-label={actionLabel}
          onClick={(event) => {
            if (artifact.preview) onOpen(artifact, event.currentTarget);
            else void download();
          }}
        >
          <span className="inspector-artifact-stamp">{artifactStamp(artifact)}</span>
          <span className="inspector-artifact-copy">
            <strong>{artifact.label}</strong>
            <span>{artifact.relativePath}</span>
          </span>
        </button>
        <button
          type="button"
          className="inspector-artifact-download"
          aria-label={t("Скачать {{name}}", { name: artifact.fileName })}
          disabled={busy}
          onClick={() => void download()}
        >
          {busy ? <span className="spinner small" /> : <ArrowDownIcon />}
        </button>
      </div>
      {failed && (
        <span className="download-link-error" role="alert">
          {t("Не удалось скачать файл. Нажмите ещё раз.")}
        </span>
      )}
    </div>
  );
}

function artifactStamp(artifact: SessionArtifact): string {
  const extension = artifact.fileName.split(".").at(-1)?.toUpperCase();
  if (extension === "MARKDOWN") return "MD";
  if (extension === "JPEG") return "JPG";
  return extension?.slice(0, 4) || "FILE";
}

function GitChangesValue({ value }: { value: GitChangesView }) {
  const { language, t } = useI18n();
  if (value === null)
    return <span className="working-text working-text-strong">{t("Загрузка…")}</span>;
  if (value === "error") return <>{t("Недоступно")}</>;
  if (value.state === "notRepository") return <>{t("Не Git-репозиторий")}</>;
  if (value.state === "clean") return <>{t("Нет изменений")}</>;
  return (
    <span className="git-changes-summary">
      <span>{formatFileCount(value.filesChanged, language, t)}</span>
      <b className="diff-add">+{value.additions}</b>
      <b className="diff-delete">−{value.deletions}</b>
    </span>
  );
}

function InspectorRow({
  label,
  technical = false,
  children,
}: {
  label: string;
  technical?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={technical ? "inspector-value-technical" : undefined}>{children}</dd>
    </div>
  );
}

function formatDate(value: number, language: "en" | "ru"): string {
  return new Date(value).toLocaleString(language, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFileCount(count: number, language: "en" | "ru", t: Translate): string {
  if (language === "en") return t(count === 1 ? "{{count}} file" : "{{count}} files", { count });
  const modulo100 = count % 100;
  const modulo10 = count % 10;
  const suffix =
    modulo100 >= 11 && modulo100 <= 14
      ? "файлов"
      : modulo10 === 1
        ? "файл"
        : modulo10 >= 2 && modulo10 <= 4
          ? "файла"
          : "файлов";
  return t(`{{count}} ${suffix}`, { count });
}

function stateLabel(state: string, t: Translate): string {
  const labels: Record<string, string> = {
    needsAttention: "Нужно решение",
    running: "Выполняется",
    completed: "Завершена",
    failed: "Ошибка",
    interrupted: "Прервана",
    idle: "Готова",
    unavailable: "Недоступна",
  };
  return labels[state] ? t(labels[state]) : state;
}
