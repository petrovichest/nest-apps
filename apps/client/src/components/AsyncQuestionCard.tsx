import { useRef, useState } from "react";

import { asyncQuestionReplyMessageId, type ActivityItem } from "@codexnest/protocol";

import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";

export function AsyncQuestionCard({
  item,
  threadId,
  turnId,
  readOnly,
}: {
  item: Extract<ActivityItem, { text: string }>;
  threadId: string;
  turnId: string;
  readOnly: boolean;
}) {
  const { state, dispatch, sendReliable, retryReliableMessage, api } = useConnection();
  const { language, t } = useI18n();
  const questions = item.questions ?? [];
  const messageId = asyncQuestionReplyMessageId(threadId, turnId, item.questionKey ?? item.id);
  const [choices, setChoices] = useState<Record<number, number>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [committedText, setCommittedText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const detail = state.details[threadId];
  const snapshot = state.snapshot;
  const summary =
    detail?.version &&
    snapshot &&
    detail.version.instanceId === snapshot.instanceId &&
    detail.version.sequence >= snapshot.sequence
      ? detail.summary
      : (snapshot?.threads.find((thread) => thread.id === threadId) ?? detail?.summary);
  const inputUnavailable = summary?.canAcceptDirectInput === false;
  const delivered = detail?.turns
    .flatMap((turn) => turn.items)
    .find((candidate) => candidate.type === "userMessage" && candidate.id === messageId);
  const queued = detail?.queuedMessages.find((candidate) => candidate.id === messageId);
  const outgoing = state.optimisticMessages[threadId]?.find(
    (candidate) => candidate.id === messageId,
  );
  const accepted = Boolean(queued || outgoing?.serverAccepted);
  const deliveryError = queued?.deliveryError ?? outgoing?.deliveryError;
  const savedText =
    delivered && "text" in delivered
      ? delivered.text
      : (queued?.text ?? outgoing?.text ?? committedText);
  const locked = busy || (savedText !== null && savedText !== undefined);
  const answers = questions.map((question, index) => {
    const choice = choices[index] ?? (question.options?.length ? 0 : -1);
    return choice === -1 ? (custom[index] ?? "").trim() : (question.options?.[choice] ?? "");
  });

  async function submit() {
    if (
      busyRef.current ||
      locked ||
      readOnly ||
      inputUnavailable ||
      answers.some((answer) => !answer)
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const text = questions
      .map((question, index) => `${question.title}\n${answers[index]}`)
      .join("\n\n");
    try {
      await sendReliable(
        threadId,
        {
          input: text,
          clientMessageId: messageId,
          replyToAsyncQuestion: { turnId, itemId: item.id },
        },
        () => {
          setCommittedText(text);
          dispatch({
            type: "optimistic.add",
            message: {
              id: messageId,
              threadId,
              text,
              images: [],
              createdAt: Date.now(),
              destination: "queue",
              turnId: null,
            },
          });
        },
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отправить ответ"),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function retry() {
    if (busyRef.current || inputUnavailable || readOnly) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (queued) await api.sendQueuedNow(threadId, messageId);
      else await retryReliableMessage(threadId, messageId);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось отправить ответ"),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="async-question-card" aria-label={t("Вопросы Codex")}>
      {savedText ? (
        <div className="async-question-saved">{savedText}</div>
      ) : readOnly ? (
        questions.map((question, index) => (
          <div key={index}>
            <p>{question.title}</p>
            {question.options?.length ? (
              <ul>
                {question.options.map((option, optionIndex) => (
                  <li key={optionIndex}>{option}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {questions.map((question, index) => {
            const choice = choices[index] ?? (question.options?.length ? 0 : -1);
            return (
              <fieldset key={index} disabled={locked}>
                <legend>{question.title}</legend>
                {question.options?.map((option, optionIndex) => (
                  <label className="check" key={optionIndex}>
                    <input
                      type="radio"
                      name={`${messageId}:${index}`}
                      checked={choice === optionIndex}
                      onChange={() =>
                        setChoices((previous) => ({ ...previous, [index]: optionIndex }))
                      }
                    />
                    <span>{option}</span>
                  </label>
                ))}
                {!!question.options?.length && (
                  <label className="check">
                    <input
                      type="radio"
                      name={`${messageId}:${index}`}
                      checked={choice === -1}
                      onChange={() => setChoices((previous) => ({ ...previous, [index]: -1 }))}
                    />
                    <span>{t("Свой ответ")}</span>
                  </label>
                )}
                {choice === -1 && (
                  <textarea
                    aria-label={question.title}
                    value={custom[index] ?? ""}
                    rows={2}
                    required
                    onChange={(event) =>
                      setCustom((previous) => ({ ...previous, [index]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key !== "Enter" ||
                        event.shiftKey ||
                        event.altKey ||
                        event.nativeEvent.isComposing
                      ) {
                        return;
                      }
                      event.preventDefault();
                      if (!event.repeat) event.currentTarget.form?.requestSubmit();
                    }}
                  />
                )}
              </fieldset>
            );
          })}
          <button
            type="submit"
            className="primary"
            disabled={locked || inputUnavailable || answers.some((answer) => !answer)}
          >
            {t("Ответить")}
          </button>
        </form>
      )}
      {!readOnly && (
        <div className="async-question-status" role="status">
          {delivered
            ? t("Ответ доставлен Codex")
            : deliveryError
              ? localizeKnownServerText(language, deliveryError.message)
              : accepted
                ? t("Ответ принят сервером — передаём Codex")
                : savedText
                  ? t("Ответ сохранён на устройстве — ожидает отправки")
                  : inputUnavailable
                    ? t("Codex временно не принимает сообщения")
                    : t("Можно ответить, пока Codex работает")}
          {!delivered && deliveryError?.retryable === false && (
            <button type="button" disabled={busy || inputUnavailable} onClick={() => void retry()}>
              {t("Повторить отправку")}
            </button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
