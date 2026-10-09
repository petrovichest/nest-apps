import { useEffect, useState } from "react";
import type { UserInputQuestion, VoiceTranscriptionJob } from "@codexnest/protocol";
import { localizeKnownServerText, useI18n } from "../i18n";
import { CheckIcon, ClockIcon } from "./Icons";
import { formatTranscriptionTimer } from "./speech-input";

export type QuestionVoiceRecording = Omit<VoiceTranscriptionJob, "status"> & {
  status: VoiceTranscriptionJob["status"] | "uploading";
};

export function UserInputVoiceQueue({
  questions,
  recordings,
  answers,
  compact = false,
  sending = false,
  error,
  onRetry,
  onEdit,
}: {
  questions: readonly UserInputQuestion[];
  recordings: readonly QuestionVoiceRecording[];
  answers: Record<string, string[]>;
  compact?: boolean;
  sending?: boolean;
  error?: string | null;
  onRetry(recording: QuestionVoiceRecording): void;
  onEdit?(): void;
}) {
  const { language, t } = useI18n();
  const [now, setNow] = useState(Date.now);
  const pending = recordings.some(
    (recording) => !["completed", "failed"].includes(recording.status),
  );
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pending]);
  const completed = recordings.filter((recording) => recording.status === "completed").length;
  return (
    <div
      className={`user-input-voice-queue${compact ? " compact" : ""}`}
      aria-label={t("Распознавание ответов")}
    >
      {!compact && (
        <>
          <div className="user-input-voice-title">
            <h3>{sending ? t("Отправляем ответы") : t("Готовим ответы")}</h3>
            <span>
              {t("{{done}} из {{total}} записей", { done: completed, total: recordings.length })}
            </span>
          </div>
          <progress
            max={Math.max(1, recordings.length)}
            value={completed}
            aria-label={t("Готовые записи")}
          />
        </>
      )}
      {questions.map((question, index) => {
        const all = recordings
          .filter((recording) => recording.userInput?.questionId === question.id)
          .sort((a, b) => a.userInput!.order - b.userInput!.order);
        const visible = compact ? all.filter((recording) => recording.status !== "completed") : all;
        if (compact && !visible.length) return null;
        return (
          <section className="user-input-voice-question" key={question.id}>
            {!compact && (
              <>
                <div className="user-input-voice-question-label">
                  <span>{index + 1}</span>
                  {question.header}
                </div>
                <p className="user-input-voice-question-text">{question.question}</p>
              </>
            )}
            {!compact && !all.length && (
              <p className="user-input-voice-transcript">
                {question.isSecret ? "••••••" : answers[question.id]?.[0]}
              </p>
            )}
            {visible.map((recording) => {
              const elapsed = Math.max(
                0,
                Math.floor((now - (recording.startedAt ?? recording.createdAt)) / 1_000),
              );
              const status =
                recording.status === "uploading"
                  ? t("Загружаем запись")
                  : recording.status === "queued"
                    ? t("В очереди")
                    : recording.status === "applying"
                      ? t("Добавляем текст")
                      : recording.status === "failed"
                        ? t("Не удалось распознать запись")
                        : t("Распознаём запись");
              return (
                <div
                  className={`user-input-voice-recording ${recording.status}`}
                  key={recording.id}
                >
                  <div className="user-input-voice-recording-title">
                    {recording.status === "completed" ? (
                      <CheckIcon />
                    ) : recording.status === "queued" || recording.status === "failed" ? (
                      <ClockIcon />
                    ) : (
                      <span className="spinner small" />
                    )}
                    <span>{t("Запись {{number}}", { number: recording.userInput!.order })}</span>
                    {!["completed", "failed"].includes(recording.status) && (
                      <time>
                        {recording.status === "transcribing"
                          ? formatTranscriptionTimer(elapsed, recording.estimatedTotalSeconds)
                          : elapsed}{" "}
                        {t("с")}
                      </time>
                    )}
                  </div>
                  {recording.status === "completed" ? (
                    <p className="user-input-voice-transcript">
                      {question.isSecret ? "••••••" : recording.transcript}
                    </p>
                  ) : (
                    <small>
                      {["queued", "failed"].includes(recording.status) ? (
                        status
                      ) : (
                        <span className="working-text">{status}</span>
                      )}
                    </small>
                  )}
                  {recording.error && (
                    <div className="user-input-speech-error" role="alert">
                      {localizeKnownServerText(language, recording.error) ?? recording.error}
                    </div>
                  )}
                  {(recording.status === "failed" || recording.error) && (
                    <button type="button" onClick={() => onRetry(recording)}>
                      {t("Повторить")}
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
      {!compact && (
        <>
          <p className="user-input-voice-note">
            {t("Отправим ответы после распознавания всех записей.")}
          </p>
          {error && (
            <div className="user-input-speech-error" role="alert">
              {localizeKnownServerText(language, error) ?? error}
            </div>
          )}
          {onEdit && !sending && (
            <button type="button" onClick={onEdit}>
              {t("Вернуться к редактированию")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
