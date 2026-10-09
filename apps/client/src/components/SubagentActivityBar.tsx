import { useEffect, useId, useRef, useState } from "react";
import type { ModelOption, ThreadSummary, TurnView } from "@codexnest/protocol";

import { useI18n } from "../i18n";
import { ChevronDownIcon, TeamIcon, XIcon } from "./Icons";
import { SubagentList, subagentMetadata } from "./NativeSubagentLaunchCard";

export function SubagentActivityBar({
  threads,
  models,
  turns = [],
}: {
  threads: ThreadSummary[];
  models: ModelOption[];
  turns?: TurnView[];
}) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const children = threads.filter((thread) => !thread.archived);
  const running = children.filter((thread) => thread.state === "running");
  const queued = children.filter(
    (thread) =>
      thread.state === "queued" || (thread.state === "idle" && thread.queuedMessageCount > 0),
  );
  const attention = children.filter((thread) => thread.state === "needsAttention");
  const activeCount = running.length + queued.length + attention.length;
  const visible = activeCount > 0;
  const open = expanded && visible;

  useEffect(() => {
    if (!visible) setExpanded(false);
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      // Escape dismisses this list before the composer's stop-task shortcut.
      event.stopImmediatePropagation();
      setExpanded(false);
      triggerRef.current?.focus();
    }
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    }
    window.addEventListener("keydown", closeWithEscape, true);
    window.addEventListener("pointerdown", closeOutside, true);
    return () => {
      window.removeEventListener("keydown", closeWithEscape, true);
      window.removeEventListener("pointerdown", closeOutside, true);
    };
  }, [open]);

  if (!visible) return null;

  const launchTitles = new Map<string, string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === "subagentLaunch" && item.threadId) {
        const title = item.title || item.agentPath?.split("/").filter(Boolean).at(-1);
        if (title) launchTitles.set(item.threadId, title);
      }
    }
  }

  const plural = new Intl.PluralRules(language).select(running.length);
  const label = [
    running.length > 0
      ? t(
          plural === "one"
            ? "{{count}} агент работает"
            : plural === "few"
              ? "{{count}} агента работают"
              : "{{count}} агентов работают",
          { count: running.length },
        )
      : null,
    queued.length > 0 ? t("В очереди: {{count}}", { count: queued.length }) : null,
    attention.length > 0 ? t("Требуется внимание: {{count}}", { count: attention.length }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const status =
    attention.length > 0 ? "needsAttention" : running.length > 0 ? "running" : "queued";
  const activeIds = new Set([...running, ...queued, ...attention].map((thread) => thread.id));
  const agents = [...children]
    .sort(
      (a, b) =>
        Number(activeIds.has(b.id)) - Number(activeIds.has(a.id)) || a.createdAt - b.createdAt,
    )
    .map((thread) => ({
      id: thread.id,
      threadId: thread.id,
      title:
        thread.title && thread.title !== "Без названия"
          ? thread.title
          : launchTitles.get(thread.id) ||
            (thread.relation.kind === "subagent" && thread.relation.nickname) ||
            t("Субагент"),
      state: thread.state,
      metadata: subagentMetadata(thread, models),
    }));
  const names = [...running, ...queued, ...attention]
    .map((thread) => (thread.relation.kind === "subagent" ? thread.relation.nickname : null))
    .filter(Boolean)
    .join(" · ");

  function close() {
    setExpanded(false);
    triggerRef.current?.focus();
  }

  return (
    <div
      className="subagent-activity"
      ref={containerRef}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false);
        }
      }}
    >
      <button
        className="subagent-activity-toggle"
        type="button"
        ref={triggerRef}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t(open ? "Свернуть субагентов" : "Показать субагентов")}
        onClick={() => setExpanded(!open)}
      >
        <TeamIcon />
        <span className={`native-subagent-status state-${status}`} aria-hidden="true" />
        <span
          className={`subagent-activity-label${status === "running" ? " working-text" : ""}`}
          role="status"
        >
          {label}
        </span>
        {names && (
          <span className="subagent-activity-names" aria-hidden="true">
            {names}
          </span>
        )}
        <ChevronDownIcon />
      </button>
      {open && (
        <section
          id={panelId}
          className="subagent-activity-panel"
          aria-labelledby={`${panelId}-title`}
        >
          <div className="subagent-activity-heading">
            <strong id={`${panelId}-title`}>
              {t("Субагенты · {{count}}", { count: agents.length })}
            </strong>
            <button
              type="button"
              className="icon-button"
              aria-label={t("Свернуть субагентов")}
              onClick={close}
            >
              <XIcon />
            </button>
          </div>
          <SubagentList agents={agents} />
        </section>
      )}
    </div>
  );
}
