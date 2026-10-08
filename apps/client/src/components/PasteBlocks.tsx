import "../styles/pasted-text.css";
import { useId, useState } from "react";
import type { PasteBlock } from "@codexnest/protocol";
import { useI18n } from "../i18n";
import { copyText } from "../clipboard";
import { CheckIcon, ChevronDownIcon, CopyIcon, FileIcon, PencilIcon, XIcon } from "./Icons";
import { PastedMarkdown } from "./PastedMarkdown";

export function PasteBlocks({
  blocks,
  visibleBlockId,
  onChange,
  disabled = false,
}: {
  blocks?: PasteBlock[];
  visibleBlockId?: string;
  onChange?(blocks: PasteBlock[]): void;
  disabled?: boolean;
}) {
  if (!blocks?.length) return null;
  return (
    <div className="paste-blocks">
      {blocks.map((block) => (
        <PasteCard
          key={block.id}
          block={block}
          hidden={visibleBlockId !== undefined && block.id !== visibleBlockId}
          disabled={disabled}
          onEdit={
            onChange
              ? (text) =>
                  onChange(blocks.map((item) => (item.id === block.id ? { ...item, text } : item)))
              : undefined
          }
          onRemove={
            onChange ? () => onChange(blocks.filter((item) => item.id !== block.id)) : undefined
          }
        />
      ))}
    </div>
  );
}

function PasteCard({
  block,
  hidden,
  disabled,
  onEdit,
  onRemove,
}: {
  block: PasteBlock;
  hidden: boolean;
  disabled: boolean;
  onEdit?(text: string): void;
  onRemove?(): void;
}) {
  const { t } = useI18n();
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return (
    <section className="paste-card" hidden={hidden}>
      <div className="paste-card-header">
        <button
          className="paste-card-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded(!expanded)}
        >
          <FileIcon />
          <span className="paste-card-label">
            <span>{t("Вставленный текст")}</span>
            <span className="paste-card-snippet">
              {block.text.split(/\r?\n/).find((line) => line.trim()) ?? block.text}
            </span>
          </span>
          <ChevronDownIcon
            className={expanded ? "paste-card-chevron expanded" : "paste-card-chevron"}
          />
        </button>
        {onRemove && (
          <button
            className="icon-button"
            type="button"
            disabled={disabled}
            aria-label={t("Удалить вставленный текст")}
            onClick={onRemove}
          >
            <XIcon />
          </button>
        )}
      </div>
      {expanded && (
        <div id={contentId} className="paste-card-expanded">
          {editing ? (
            <>
              <textarea
                className="paste-card-source"
                aria-label={t("Исходный вставленный текст")}
                value={source}
                disabled={disabled}
                onChange={(event) => setSource(event.currentTarget.value)}
              />
              <div className="paste-card-actions">
                <button type="button" onClick={() => setEditing(false)}>
                  {t("Отмена")}
                </button>
                <button
                  type="button"
                  disabled={disabled || !source.length}
                  onClick={() => {
                    onEdit?.(source);
                    setEditing(false);
                  }}
                >
                  {t("Сохранить")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div
                className="paste-card-preview markdown"
                tabIndex={0}
                role="region"
                aria-label={t("Содержимое вставки")}
              >
                <PastedMarkdown text={block.text} />
              </div>
              <div className="paste-card-actions">
                {onEdit && (
                  <button
                    className="icon-button"
                    type="button"
                    disabled={disabled}
                    aria-label={t("Редактировать вставленный текст")}
                    onClick={() => {
                      setSource(block.text);
                      setEditing(true);
                    }}
                  >
                    <PencilIcon />
                  </button>
                )}
                <button
                  className="icon-button"
                  type="button"
                  aria-label={copied ? t("Скопировано") : t("Скопировать вставленный текст")}
                  onClick={() => {
                    void copyText(block.text).then(
                      () => {
                        setCopied(true);
                        setCopyError(false);
                      },
                      () => setCopyError(true),
                    );
                  }}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
                {copyError && <span role="status">{t("Не удалось скопировать")}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
