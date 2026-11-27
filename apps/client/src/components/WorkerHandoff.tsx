import type { WorkerProcessSession } from "@codexnest/protocol";
import { Link } from "react-router";
import { application } from "../application";
import { useI18n } from "../i18n";
import { workerProcessStatus, type WorkerHandoffEvent } from "../worker-handoff";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon } from "./Icons";

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

export function WorkerHandoff({ event }: { event: WorkerHandoffEvent }) {
  const { t } = useI18n();
  if (event.type === "workerReply") {
    return (
      <div className="worker-handoff-event">
        <ArrowDownIcon aria-hidden="true" />
        <div>
          <div className="worker-handoff-caption">
            {t(
              event.status === "failed"
                ? "Ошибка в ответе от «{{worker}}»"
                : event.question
                  ? "Ответ от «{{worker}}»"
                  : "Результат от «{{worker}}»",
              { worker: event.workerName },
            )}
          </div>
          <div className="worker-handoff-topic">{event.text || event.title}</div>
        </div>
      </div>
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
