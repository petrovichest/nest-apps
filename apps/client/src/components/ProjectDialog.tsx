import { ActionLabel } from "./ActionLabel";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DirectoryListing } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n, type Translate } from "../i18n";
import { Dialog } from "./Dialog";
import { ArrowLeftIcon, ChevronRightIcon, FolderIcon, PlusIcon, XIcon } from "./Icons";

type Operation = "loading" | "creating" | "selecting" | null;

export function ProjectDialog({ onClose }: { onClose(): void }) {
  const { api } = useConnection();
  const { language, t } = useI18n();
  const localizationRef = useRef({ language, t });
  localizationRef.current = { language, t };
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [operation, setOperation] = useState<Operation>("loading");
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [directoryName, setDirectoryName] = useState("");
  const busy = operation !== null;

  const openDirectory = useCallback(
    async (path?: string) => {
      setOperation("loading");
      setError(null);
      try {
        setListing(await api.listDirectories(path));
        setShowCreate(false);
        setDirectoryName("");
      } catch (caught) {
        const localization = localizationRef.current;
        setError(
          messageFor(caught, localization.t("Не удалось открыть папку"), localization.language),
        );
      } finally {
        setOperation(null);
      }
    },
    [api],
  );

  useEffect(() => {
    void openDirectory();
  }, [openDirectory]);

  const visibleDirectories = useMemo(
    () => listing?.directories.filter((entry) => showHidden || !entry.name.startsWith(".")) ?? [],
    [listing, showHidden],
  );

  async function createNewDirectory(event: FormEvent) {
    event.preventDefault();
    if (!listing || !directoryName.trim()) return;
    setOperation("creating");
    setError(null);
    try {
      const created = await api.createDirectory({
        parentPath: listing.path,
        name: directoryName,
      });
      setListing(created);
      setShowCreate(false);
      setDirectoryName("");
    } catch (caught) {
      setError(messageFor(caught, t("Не удалось создать папку"), language));
    } finally {
      setOperation(null);
    }
  }

  async function selectDirectory() {
    if (!listing) return;
    setOperation("selecting");
    setError(null);
    try {
      await api.createProject({ path: listing.path });
      onClose();
    } catch (caught) {
      setError(messageFor(caught, t("Не удалось добавить проект"), language));
      setOperation(null);
    }
  }

  return (
    <Dialog
      titleId="project-dialog-title"
      className="project-browser-modal"
      backdropClassName="project-browser-backdrop"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      onClose={onClose}
    >
      <div className="dialog-header">
        <div className="dialog-heading">
          <span className="dialog-eyebrow">{t("Рабочая папка на сервере")}</span>
          <h2 id="project-dialog-title">{t("Добавить проект")}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t("Закрыть")}
          disabled={busy}
          onClick={onClose}
        >
          <XIcon />
        </button>
      </div>

      <div className="project-browser-navigation">
        <button
          type="button"
          className="icon-button"
          aria-label={t("На уровень выше")}
          disabled={busy || !listing?.parentPath}
          onClick={() => void openDirectory(listing?.parentPath ?? undefined)}
        >
          <ArrowLeftIcon />
        </button>
        <nav className="project-breadcrumbs" aria-label={t("Путь к папке")}>
          {listing ? (
            breadcrumbs(listing, t).map((item, index, items) => (
              <span className="project-breadcrumb" key={item.path}>
                {index > 0 && <ChevronRightIcon />}
                <button
                  type="button"
                  disabled={busy || index === items.length - 1}
                  onClick={() => void openDirectory(item.path)}
                >
                  {item.label}
                </button>
              </span>
            ))
          ) : (
            <span className="project-breadcrumb-placeholder">{t("Домашняя папка")}</span>
          )}
        </nav>
        <span className="project-browser-loading">
          {operation === "loading" && <div className="spinner small" aria-label={t("Загрузка")} />}
        </span>
      </div>

      <div className="project-browser-controls">
        <button
          type="button"
          disabled={busy || !listing}
          onClick={() => {
            setShowCreate((value) => !value);
            setDirectoryName("");
            setError(null);
          }}
        >
          <PlusIcon /> {t("Новая папка")}
        </button>
        <label className="project-hidden-toggle">
          <input
            type="checkbox"
            checked={showHidden}
            disabled={busy}
            onChange={(event) => setShowHidden(event.target.checked)}
          />
          {t("Показывать скрытые")}
        </label>
      </div>

      {showCreate && listing && (
        <form className="project-directory-create" onSubmit={createNewDirectory}>
          <input
            autoFocus
            aria-label={t("Название новой папки")}
            value={directoryName}
            disabled={busy}
            placeholder={t("Название новой папки")}
            onChange={(event) => setDirectoryName(event.target.value)}
          />
          <button type="submit" className="primary" disabled={busy || !directoryName.trim()}>
            <ActionLabel
              idle={t("Создать")}
              busy={t("Создаём…")}
              pending={operation === "creating"}
            />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setShowCreate(false);
              setDirectoryName("");
            }}
          >
            {t("Отмена")}
          </button>
        </form>
      )}

      {error && (
        <div className="dialog-notice danger project-browser-error" role="alert">
          <span>{error}</span>
          {!listing && (
            <button type="button" disabled={busy} onClick={() => void openDirectory()}>
              {t("Повторить")}
            </button>
          )}
        </div>
      )}

      <div className="project-directory-list" aria-label={t("Папки")}>
        {!listing && operation === "loading" && (
          <div className="project-directory-empty">
            <div className="spinner" />
            <span className="working-text">{t("Получаем папки с сервера…")}</span>
          </div>
        )}
        {listing && visibleDirectories.length === 0 && (
          <div className="project-directory-empty">
            <FolderIcon />
            <span>
              {listing.directories.length > 0
                ? t("Скрытые папки не показаны")
                : t("В этой папке нет других папок")}
            </span>
          </div>
        )}
        {visibleDirectories.map((entry) => (
          <button
            type="button"
            className="project-directory-entry"
            key={entry.path}
            disabled={busy}
            onClick={() => void openDirectory(entry.path)}
          >
            <FolderIcon />
            <span>{entry.name}</span>
            <ChevronRightIcon />
          </button>
        ))}
      </div>

      <div className="dialog-actions project-browser-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          {t("Отмена")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !listing}
          onClick={() => void selectDirectory()}
        >
          <FolderIcon />{" "}
          <ActionLabel
            idle={t("Выбрать эту папку")}
            busy={t("Добавляем…")}
            pending={operation === "selecting"}
          />
        </button>
      </div>
    </Dialog>
  );
}

function breadcrumbs(
  listing: DirectoryListing,
  t: Translate,
): Array<{ label: string; path: string }> {
  const result = [{ label: t("Домашняя"), path: listing.rootPath }];
  const suffix = listing.path.slice(listing.rootPath.length);
  let path = listing.rootPath;
  for (const segment of suffix.split("/").filter(Boolean)) {
    path = path === "/" ? `/${segment}` : `${path}/${segment}`;
    result.push({ label: segment, path });
  }
  return result;
}

function messageFor(caught: unknown, fallback: string, language: "en" | "ru"): string {
  return caught instanceof Error && caught.message
    ? (localizeKnownServerText(language, caught.message) ?? caught.message)
    : fallback;
}
