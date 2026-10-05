import { application } from "./application";
import type { ThreadDraftAnnotation, UiLanguage } from "@codexnest/protocol";

export type PendingAnnotation = ThreadDraftAnnotation;

export type AnnotationDraft = Omit<PendingAnnotation, "id" | "createdAt">;

const STORAGE_PREFIX = `${application.storagePrefix}.pendingAnnotations.v1`;

export function loadPendingAnnotations(threadId: string): PendingAnnotation[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const stored = localStorage.getItem(storageKey(threadId));
    if (!stored) return [];
    const value: unknown = JSON.parse(stored);
    if (!Array.isArray(value)) return [];
    return value.filter(isPendingAnnotation).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export function savePendingAnnotations(threadId: string, annotations: PendingAnnotation[]): void {
  if (typeof localStorage === "undefined") return;
  const key = storageKey(threadId);
  if (annotations.length === 0) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify(annotations));
}

export function annotationStorageKey(threadId: string): string {
  return storageKey(threadId);
}

export function formatAnnotatedMessage(
  input: string,
  annotations: PendingAnnotation[],
  language: UiLanguage = "ru",
): string {
  const sections: string[] = [];
  const message = input.trim();
  if (message) sections.push(message);
  if (annotations.length) {
    const title =
      language === "en"
        ? "## Annotations for the agent's previous response"
        : "## Аннотации к предыдущему ответу агента";
    const annotationLabel = language === "en" ? "Annotation" : "Аннотация";
    const quoteLabel = language === "en" ? "Selected text:" : "Выделенный текст:";
    const commentLabel = language === "en" ? "Comment:" : "Комментарий:";
    sections.push(
      [
        title,
        ...annotations.map((annotation, index) =>
          [
            `### ${annotationLabel} ${index + 1}`,
            quoteLabel,
            markdownQuote(annotation.quote),
            commentLabel,
            annotation.comment.trim(),
          ].join("\n\n"),
        ),
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}

export function rangeOffsets(
  container: HTMLElement,
  range: Range,
): { startOffset: number; endOffset: number } | null {
  if (!container.contains(range.commonAncestorContainer)) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(container);
  try {
    prefix.setEnd(range.startContainer, range.startOffset);
  } catch {
    return null;
  }
  const startOffset = prefix.toString().length;
  return { startOffset, endOffset: startOffset + range.toString().length };
}

export function resolveAnnotationRange(
  container: HTMLElement,
  annotation: Pick<PendingAnnotation, "quote" | "startOffset" | "endOffset">,
): Range | null {
  const stored = rangeFromOffsets(container, annotation.startOffset, annotation.endOffset);
  if (stored?.toString() === annotation.quote) return stored;

  const text = container.textContent ?? "";
  let closest = -1;
  let distance = Number.POSITIVE_INFINITY;
  let index = text.indexOf(annotation.quote);
  while (index >= 0) {
    const candidateDistance = Math.abs(index - annotation.startOffset);
    if (candidateDistance < distance) {
      closest = index;
      distance = candidateDistance;
    }
    index = text.indexOf(annotation.quote, index + 1);
  }
  return closest < 0
    ? null
    : rangeFromOffsets(container, closest, closest + annotation.quote.length);
}

function rangeFromOffsets(
  container: HTMLElement,
  startOffset: number,
  endOffset: number,
): Range | null {
  if (startOffset < 0 || endOffset <= startOffset) return null;
  const walker = container.ownerDocument.createTreeWalker(container, 4);
  const range = container.ownerDocument.createRange();
  let offset = 0;
  let start: { node: Text; offset: number } | null = null;
  let end: { node: Text; offset: number } | null = null;
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    const nextOffset = offset + text.length;
    if (!start && startOffset >= offset && startOffset <= nextOffset) {
      start = { node: node as Text, offset: startOffset - offset };
    }
    if (endOffset >= offset && endOffset <= nextOffset) {
      end = { node: node as Text, offset: endOffset - offset };
      break;
    }
    offset = nextOffset;
    node = walker.nextNode();
  }
  if (!start || !end) return null;
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

function markdownQuote(value: string): string {
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function storageKey(threadId: string): string {
  return `${STORAGE_PREFIX}.${threadId}`;
}

function isPendingAnnotation(value: unknown): value is PendingAnnotation {
  if (!value || typeof value !== "object") return false;
  const annotation = value as Partial<PendingAnnotation>;
  return (
    typeof annotation.id === "string" &&
    Boolean(annotation.id) &&
    typeof annotation.messageId === "string" &&
    Boolean(annotation.messageId) &&
    (annotation.source === "agentMessage" || annotation.source === "plan") &&
    typeof annotation.quote === "string" &&
    Boolean(annotation.quote.trim()) &&
    Number.isInteger(annotation.startOffset) &&
    annotation.startOffset! >= 0 &&
    Number.isInteger(annotation.endOffset) &&
    annotation.endOffset! > annotation.startOffset! &&
    typeof annotation.comment === "string" &&
    Boolean(annotation.comment.trim()) &&
    typeof annotation.createdAt === "number" &&
    Number.isFinite(annotation.createdAt)
  );
}
