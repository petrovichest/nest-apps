import "../styles/annotation-bubbles.css";
import "../styles/pasted-text.css";
import type { PendingAnnotation } from "../annotations";
import { useI18n } from "../i18n";
import { ArrowUpIcon, XIcon } from "./Icons";

export function AnnotationBubbles({
  annotations,
  disabled,
  onOpen,
  onDelete,
}: {
  annotations: PendingAnnotation[];
  disabled: boolean;
  onOpen(annotationId: string): void;
  onDelete(annotationId: string): void;
}) {
  const { t } = useI18n();
  if (!annotations.length) return null;
  return (
    <div className="annotation-bubbles" role="group" aria-label={t("Аннотации")}>
      <div className="annotation-bubble-list">
        {annotations.map((annotation, index) => (
          <section className="paste-card annotation-bubble" key={annotation.id}>
            <div className="paste-card-header">
              <button
                className="paste-card-toggle"
                type="button"
                disabled={disabled}
                aria-label={t("Перейти к аннотации {{number}}", { number: index + 1 })}
                title={`${annotation.quote}\n\n${annotation.comment}`}
                onClick={() => onOpen(annotation.id)}
              >
                <span className="annotation-bubble-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="paste-card-label">
                  <span className="annotation-bubble-quote">«{annotation.quote}»</span>
                  <span className="annotation-bubble-comment">{annotation.comment}</span>
                </span>
                <ArrowUpIcon className="annotation-bubble-jump" />
              </button>
              <button
                className="icon-button"
                type="button"
                disabled={disabled}
                aria-label={t("Удалить аннотацию {{number}}", { number: index + 1 })}
                onClick={() => onDelete(annotation.id)}
              >
                <XIcon />
              </button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
