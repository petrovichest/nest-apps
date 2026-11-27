import type { WorkerProcessSession } from "@codexnest/protocol";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { application } from "../application";
import { useI18n } from "../i18n";
import { workerProcessStatus, type WorkerHandoffEvent } from "../worker-handoff";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon } from "./Icons";

type RenderReply = (text: string) => ReactNode;

function WorkerStatus({ session }: { session: WorkerProcessSession }) {
  const { t } = useI18n();
  return (
    <span className="worker-handoff-status" data-status={session.status}>
      <span className="worker-handoff-dot" aria-hidden="true" />
      {t(session.status === "completed" ? "Завершено" : workerProcessStatus(session))}
    </span>
  );
}

function WorkerSessionLink({ session }: { session: WorkerProcessSession }) {
  const { t } = useI18n();
  const url =
    session.sessionUrl ||
    (session.threadId && session.provider === application.provider
      ? `/threads/${encodeURIComponent(session.threadId)}`
      : null);
  if (!url) return null;
  const content = (
    <>
      {t("Открыть сессию")}
      <ChevronRightIcon aria-hidden="true" />
    </>
  );
  return url.startsWith("/") && !url.startsWith("//") ? (
    <Link className="worker-handoff-link" to={url}>
      {content}
    </Link>
  ) : /^https?:\/\//i.test(url) ? (
    <a className="worker-handoff-link" href={url}>
      {content}
    </a>
  ) : null;
}

function WorkerReply({
  event,
  renderReply,
  onReplyLayoutChange,
}: {
  event: Extract<WorkerHandoffEvent, { type: "workerReply" }>;
  renderReply: RenderReply;
  onReplyLayoutChange: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const hasReport = Boolean(event.text.trim());
  const showingReport = hasReport && open;
  const wasShowingReport = useRef(false);
  useLayoutEffect(() => {
    if (wasShowingReport.current === showingReport) return;
    wasShowingReport.current = showingReport;
    onReplyLayoutChange();
  }, [showingReport, onReplyLayoutChange]);

  const label = t(
    event.status === "failed"
      ? "Ошибка в ответе от «{{worker}}»"
      : event.question
        ? "Ответ от «{{worker}}»"
        : "Результат от «{{worker}}»",
    { worker: event.workerName },
  );

  if (!hasReport) {
    return (
      <div className="worker-handoff-event">
        <ArrowDownIcon aria-hidden="true" />
        <div>
          <div className="worker-handoff-caption">{label}</div>
          <div className="worker-handoff-topic">{event.title}</div>
        </div>
      </div>
    );
  }

  return (
    <details
      className="worker-handoff-card worker-handoff-reply"
      data-status={event.status}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ArrowDownIcon className="worker-handoff-reply-icon" aria-hidden="true" />
        <span className="worker-handoff-label">{label}</span>
        <span className="worker-handoff-title">{event.title}</span>
        <ChevronDownIcon className="worker-handoff-chevron" aria-hidden="true" />
      </summary>
      {open && <div className="message worker-handoff-report">{renderReply(event.text)}</div>}
    </details>
  );
}

export function WorkerHandoff({
  event,
  renderReply,
  onReplyLayoutChange,
}: {
  event: WorkerHandoffEvent;
  renderReply: RenderReply;
  onReplyLayoutChange: () => void;
}) {
  const { t } = useI18n();
  if (event.type === "workerReply") {
    return (
      <WorkerReply
        event={event}
        renderReply={renderReply}
        onReplyLayoutChange={onReplyLayoutChange}
      />
    );
  }

  const { session } = event;
  if (session.kind === "question") {
    return (
      <div className="worker-handoff-event">
        <ArrowUpIcon aria-hidden="true" />
        <div>
          <div className="worker-handoff-caption">
            {t("Вопрос для «{{worker}}»", { worker: session.workerName })}
            {(session.status !== "completed" || !session.result?.trim()) && (
              <WorkerStatus session={session} />
            )}
          </div>
          <div className="worker-handoff-topic">{session.description || session.title}</div>
        </div>
      </div>
    );
  }

  return (
    <details className="worker-handoff-card">
      <summary>
        <span className="worker-handoff-avatar" aria-hidden="true">
          {[...session.workerName.trim()][0]?.toLocaleUpperCase()}
        </span>
        <span className="worker-handoff-label">
          {t("Поручение для «{{worker}}»", { worker: session.workerName })}
        </span>
        <span className="worker-handoff-title">{session.title}</span>
        <WorkerStatus session={session} />
        <ChevronDownIcon className="worker-handoff-chevron" aria-hidden="true" />
      </summary>
      <div className="worker-handoff-body">
        {session.description && <p>{session.description}</p>}
        {session.expectedResult && (
          <dl>
            <dt>{t("Ожидаемый результат")}</dt>
            <dd>{session.expectedResult}</dd>
          </dl>
        )}
        <WorkerSessionLink session={session} />
      </div>
    </details>
  );
}
