import { useId, useState } from "react";
import { Link } from "react-router";
import type { ActivityItem, ModelOption, ThreadState, ThreadSummary } from "@codexnest/protocol";

import { useI18n, type Translate } from "../i18n";
import { ArrowRightIcon, ChevronDownIcon, TeamIcon } from "./Icons";

type SubagentLaunch = Extract<ActivityItem, { type: "subagentLaunch" }>;
export type SubagentState = ThreadState | "launching" | "launched";
export type SubagentEntry = {
  id: string;
  threadId: string | null;
  title: string;
  state: SubagentState;
  metadata: string[];
};

export function subagentMetadata(thread: ThreadSummary | undefined, models: ModelOption[]) {
  const nickname = thread?.relation.kind === "subagent" ? thread.relation.nickname : null;
  const model = thread?.codexSettings?.model;
  const effort = thread?.codexSettings?.reasoningEffort;
  return [
    nickname,
    model ? (models.find((option) => option.id === model)?.displayName ?? model) : null,
    effort === "ultra" ? "Ultra" : effort,
  ].filter((value): value is string => Boolean(value));
}

export function isNativeSubagentLaunch(
  item: ActivityItem,
): item is SubagentLaunch & { source: "codex" | "claude" } {
  return item.type === "subagentLaunch" && item.source !== undefined;
}

export function NativeSubagentLaunchCard({
  items,
  threads = [],
  models = [],
}: {
  items: SubagentLaunch[];
  threads?: ThreadSummary[];
  models?: ModelOption[];
}) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const summaries = new Map(threads.map((thread) => [thread.id, thread]));
  const launches = [...new Map(items.map((item) => [item.id, item])).values()];
  const agents = launches.map((item) => {
    const child = item.threadId ? summaries.get(item.threadId) : undefined;
    const state: SubagentState =
      item.status === "failed"
        ? "failed"
        : (child?.state ?? (item.status === "inProgress" ? "launching" : "launched"));
    const title =
      (child?.title && child.title !== "Без названия" ? child.title : null) ||
      item.title ||
      item.agentPath?.split("/").filter(Boolean).at(-1) ||
      t("Субагент");
    return {
      id: item.id,
      threadId: item.status === "failed" ? null : item.threadId,
      title,
      state,
      metadata: subagentMetadata(child, models),
    };
  });
  const counts = new Map<SubagentState, number>();
  for (const agent of agents) counts.set(agent.state, (counts.get(agent.state) ?? 0) + 1);
  const timestamp = launches.find((item) => item.timestamp != null)?.timestamp;
  const pending = launches.some((item) => item.status === "inProgress");
  const failed = launches.some((item) => item.status === "failed");
  const count = launches.length;
  const plural = new Intl.PluralRules(language).select(count);
  const heading =
    count === 1
      ? failed
        ? t("Не удалось запустить субагента")
        : pending
          ? t("Запуск субагента")
          : t("Запущен субагент")
      : failed
        ? t("Запуски субагентов: {{count}}", { count })
        : pending
          ? t("Запуск субагентов: {{count}}", { count })
          : t(
              plural === "one"
                ? "Запущен {{count}} субагент"
                : plural === "few"
                  ? "Запущены {{count}} субагента"
                  : "Запущены {{count}} субагентов",
              { count },
            );

  return (
    <article className="message orchestration-notice native-subagent-launches">
      <button
        className="native-subagent-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={t(expanded ? "Свернуть субагентов" : "Показать субагентов")}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="native-subagent-heading">
          <span className="native-subagent-label">
            <TeamIcon />
            <strong>{heading}</strong>
          </span>
          {timestamp != null && (
            <time
              dateTime={new Date(timestamp).toISOString()}
              title={new Date(timestamp).toLocaleString(language)}
            >
              {new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", {
                hour: "2-digit",
                minute: "2-digit",
              }).format(timestamp)}
            </time>
          )}
        </span>
        <span className="native-subagent-summary">
          {[...counts].map(([state, count]) => (
            <span className={`native-subagent-status state-${state}`} key={state}>
              {state === "running"
                ? t(count === 1 ? "{{count}} работает" : "{{count}} работают", { count })
                : state === "completed"
                  ? t(count === 1 ? "{{count}} готов" : "{{count}} готовы", { count })
                  : `${count} · ${subagentStateLabel(state, t)}`}
            </span>
          ))}
        </span>
        <ChevronDownIcon />
      </button>
      <div id={listId} hidden={!expanded}>
        {expanded && <SubagentList agents={agents} />}
      </div>
    </article>
  );
}

export function SubagentList({ agents }: { agents: SubagentEntry[] }) {
  const { t } = useI18n();
  return (
    <ul className="native-subagent-list">
      {agents.map(({ id, threadId, title, state, metadata }) => {
        const content = (
          <>
            <span className="native-subagent-node" aria-hidden="true" />
            <span className="native-subagent-copy">
              <span className="native-subagent-top">
                <strong>{title}</strong>
                <span
                  className={`native-subagent-status state-${state}`}
                  aria-label={t("Статус субагента: {{status}}", {
                    status: subagentStateLabel(state, t),
                  })}
                >
                  {subagentStateLabel(state, t)}
                </span>
              </span>
              {metadata.length > 0 && (
                <span className="native-subagent-meta">{metadata.join(" · ")}</span>
              )}
            </span>
            {threadId && (
              <span className="native-subagent-arrow" aria-hidden="true">
                <ArrowRightIcon />
              </span>
            )}
          </>
        );
        return (
          <li key={id}>
            {threadId ? (
              <Link
                className="native-subagent-row"
                to={`/threads/${encodeURIComponent(threadId)}`}
                aria-label={t("Открыть диалог субагента: {{title}}", { title })}
              >
                {content}
              </Link>
            ) : (
              <div className="native-subagent-row">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function subagentStateLabel(state: SubagentState, t: Translate): string {
  switch (state) {
    case "running":
      return t("Работает");
    case "completed":
      return t("Готово");
    case "needsAttention":
      return t("Требуется внимание");
    case "queued":
      return t("В очереди");
    case "failed":
      return t("Ошибка");
    case "interrupted":
      return t("Прервано");
    case "unavailable":
      return t("Недоступна");
    case "idle":
      return t("Ожидает");
    case "launching":
      return t("Запуск");
    case "launched":
      return t("Запущен");
  }
}
