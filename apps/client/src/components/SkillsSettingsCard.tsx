import { useEffect, useMemo, useRef, useState } from "react";

import type { Project, SkillCatalogItem } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";
import { useSkillsCatalog } from "../useSkillsCatalog";
import { RefreshIcon, SearchIcon, SkillsIcon } from "./Icons";
import { SettingsGroup, SettingsRow } from "./SettingsPresentation";

export function SkillsSettingsCard({
  projects,
  skillsEpoch,
}: {
  projects: Project[];
  skillsEpoch: number;
}) {
  const { api } = useConnection();
  const { language, t } = useI18n();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null;
  const [query, setQuery] = useState("");
  const [savingPaths, setSavingPaths] = useState<Set<string>>(() => new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const projectGenerationRef = useRef({ id: project?.id ?? null, generation: 0 });
  if (projectGenerationRef.current.id !== (project?.id ?? null)) {
    projectGenerationRef.current = {
      id: project?.id ?? null,
      generation: projectGenerationRef.current.generation + 1,
    };
  }
  const { catalog, error, loading, mutate, refresh } = useSkillsCatalog(
    project?.path ?? null,
    skillsEpoch,
    Boolean(project),
  );

  useEffect(() => {
    if (project || !projects.length) return;
    setProjectId(projects[0]!.id);
  }, [project, projects]);

  useEffect(() => {
    setQuery("");
    setSaveError(null);
    setSavingPaths(new Set());
  }, [project?.id]);

  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(language);
    if (!normalized) return catalog?.skills ?? [];
    return (catalog?.skills ?? []).filter((skill) =>
      [skill.name, skill.displayName, skill.description, skill.shortDescription]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase(language).includes(normalized)),
    );
  }, [catalog?.skills, language, query]);

  async function toggleSkill(skill: SkillCatalogItem, enabled: boolean) {
    if (!project || savingPaths.has(skill.path)) return;
    const generation = projectGenerationRef.current.generation;
    setSavingPaths((current) => new Set(current).add(skill.path));
    setSaveError(null);
    try {
      const updated = await api.updateSkillConfig({ cwd: project.path, path: skill.path, enabled });
      if (projectGenerationRef.current.generation !== generation) return;
      mutate((current) => ({
        ...current,
        skills: current.skills.map((candidate) =>
          candidate.path === updated.path ? { ...candidate, enabled: updated.enabled } : candidate,
        ),
      }));
    } catch (caught) {
      if (projectGenerationRef.current.generation !== generation) return;
      setSaveError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось изменить состояние скилла"),
      );
    } finally {
      if (projectGenerationRef.current.generation === generation) {
        setSavingPaths((current) => {
          const next = new Set(current);
          next.delete(skill.path);
          return next;
        });
      }
    }
  }

  const loadError =
    error instanceof Error
      ? (localizeKnownServerText(language, error.message) ?? error.message)
      : error
        ? t("Не удалось загрузить скиллы")
        : null;

  return (
    <SettingsGroup
      className="skills-settings-card"
      description={t("Установленные возможности Codex для выбранного проекта.")}
      icon={<SkillsIcon />}
      title={t("Скиллы")}
    >
      {projects.length ? (
        <SettingsRow
          description={t("Каталог и переключатели ниже относятся к выбранному проекту.")}
          label={t("Проект")}
          labelFor="settings-skills-project"
        >
          <div className="skills-settings-controls">
            <select
              aria-label={t("Проект для скиллов")}
              id="settings-skills-project"
              value={project?.id ?? ""}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((candidate) => (
                <option value={candidate.id} key={candidate.id}>
                  {candidate.displayName}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              type="button"
              aria-label={t("Обновить список скиллов")}
              disabled={!project || loading}
              onClick={refresh}
            >
              <RefreshIcon />
            </button>
          </div>
        </SettingsRow>
      ) : (
        <div className="settings-notice warning" role="status">
          {t("Добавьте проект, чтобы посмотреть доступные для него скиллы.")}
        </div>
      )}

      {project && (
        <label className="skills-settings-search">
          <span className="sr-only">{t("Поиск скиллов")}</span>
          <SearchIcon />
          <input
            type="search"
            value={query}
            aria-label={t("Поиск скиллов")}
            placeholder={t("Поиск по названию и описанию")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}

      {project && !catalog && loading && (
        <div className="skills-settings-state" role="status">
          <span className="spinner small" />{" "}
          <span className="working-text">{t("Загружаем скиллы…")}</span>
        </div>
      )}
      {(loadError || saveError) && (
        <div className="settings-notice danger" role="alert">
          {saveError ?? loadError}
        </div>
      )}
      {catalog?.errors.length ? (
        <div className="settings-notice warning" role="status">
          {t("Ошибки обнаружения: {{count}}", { count: catalog.errors.length })}
        </div>
      ) : null}

      {catalog && !catalog.skills.length && (
        <div className="skills-settings-state">{t("Скиллы не найдены")}</div>
      )}
      {catalog && catalog.skills.length > 0 && !filteredSkills.length && (
        <div className="skills-settings-state">{t("Ничего не найдено")}</div>
      )}
      {filteredSkills.length > 0 && (
        <div className="skills-settings-list">
          {filteredSkills.map((skill) => (
            <article
              className={`skills-settings-row${skill.enabled ? "" : " disabled"}`}
              key={skill.path}
            >
              <div className="skills-settings-copy">
                <div>
                  <strong>{skill.displayName || skill.name}</strong>
                  <code>${skill.name}</code>
                </div>
                <p>{skill.shortDescription || skill.description || t("Описание не указано")}</p>
                <small>{skillScopeLabel(skill.scope, t)}</small>
              </div>
              <label className="skill-switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={skill.enabled}
                  disabled={savingPaths.has(skill.path)}
                  aria-label={
                    skill.enabled
                      ? t("Выключить скилл {{name}}", { name: skill.displayName || skill.name })
                      : t("Включить скилл {{name}}", { name: skill.displayName || skill.name })
                  }
                  onChange={(event) => void toggleSkill(skill, event.target.checked)}
                />
                <span aria-hidden="true" />
              </label>
            </article>
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}

function skillScopeLabel(scope: SkillCatalogItem["scope"], t: (value: string) => string): string {
  switch (scope) {
    case "repo":
      return t("Проектный");
    case "user":
      return t("Пользовательский");
    case "admin":
      return t("Административный");
    case "system":
      return t("Системный");
  }
}
