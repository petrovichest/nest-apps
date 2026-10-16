import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { ThreadSummary } from "@codexnest/protocol";

import { useI18n } from "../i18n";
import { CompactIcon } from "./Icons";

/** From this share of the window the figure turns amber, then red. */
export const CONTEXT_WARN_PERCENT = 75;
export const CONTEXT_HIGH_PERCENT = 90;
/** Below this there is nothing worth compacting. */
const MIN_COMPACTABLE_PERCENT = 5;
/** How long a tap or key press waits for the confirming second one. */
const CONFIRM_WINDOW_MS = 3_000;
/** A mouse cancels by leaving the button; this only covers a pointer left resting on it. */
const POINTER_REST_LIMIT_MS = 8_000;

type Armer = "pointer" | "other";

export function contextPercent(usage: ThreadSummary["contextUsage"]): number | null {
  if (!usage || usage.usedTokens === null || usage.windowTokens <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((usage.usedTokens / usage.windowTokens) * 100)));
}

/**
 * The share of the context window in use. The first press swaps the ring for the compaction icon;
 * pressing again compacts. A mouse that leaves the button, or a tap that is not confirmed within a
 * few seconds, puts the ring back.
 */
export function ContextMeter({
  usage,
  running,
  compacting,
  onCompact,
}: {
  usage: NonNullable<ThreadSummary["contextUsage"]>;
  running: boolean;
  compacting: boolean;
  onCompact(): void;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const armerRef = useRef<Armer>("other");
  const lastPointerRef = useRef("");
  const timerRef = useRef<number | undefined>(undefined);
  const percent = contextPercent(usage);
  const available =
    !running && !compacting && percent !== null && percent >= MIN_COMPACTABLE_PERCENT;
  const showIcon = armed && available;
  const level =
    percent !== null && percent >= CONTEXT_HIGH_PERCENT
      ? "high"
      : percent !== null && percent >= CONTEXT_WARN_PERCENT
        ? "warn"
        : "ok";

  function disarm() {
    window.clearTimeout(timerRef.current);
    setArmed(false);
  }

  useEffect(() => {
    if (!available) disarm();
  }, [available]);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  useEffect(() => {
    if (!armed) return;
    // A press anywhere else, or Escape, cancels the pending confirmation.
    const outside = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node)) disarm();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") disarm();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [armed]);

  const label = compacting
    ? t("Сжимаем контекст")
    : showIcon
      ? t("Сжать контекст")
      : percent === null
        ? t("Заполненность контекста неизвестна")
        : t("Контекст заполнен на {{percent}}%", { percent });

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`setting-control context-meter${showIcon ? " active" : ""}`}
      data-level={level}
      data-compacting={compacting || undefined}
      aria-label={label}
      aria-disabled={!available || undefined}
      onPointerDown={(event) => {
        lastPointerRef.current = event.pointerType;
      }}
      onPointerLeave={(event) => {
        if (armerRef.current === "pointer" && event.pointerType !== "touch") disarm();
      }}
      onBlur={() => {
        if (armerRef.current === "other") disarm();
      }}
      onClick={(event) => {
        if (!available) return;
        if (armed) {
          disarm();
          onCompact();
          return;
        }
        // A click with no preceding pointer press came from the keyboard.
        const pointerType = event.detail === 0 ? "" : lastPointerRef.current;
        const mouse = pointerType === "mouse" || pointerType === "pen";
        armerRef.current = mouse ? "pointer" : "other";
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(
          disarm,
          mouse ? POINTER_REST_LIMIT_MS : CONFIRM_WINDOW_MS,
        );
        setArmed(true);
      }}
    >
      <span className="context-slot">
        {compacting ? (
          <span className="spinner" />
        ) : showIcon ? (
          <CompactIcon className="context-icon" />
        ) : (
          <span
            className="context-ring"
            data-empty={!percent || undefined}
            style={{ "--context-angle": `${(percent ?? 0) * 3.6}deg` } as CSSProperties}
          />
        )}
      </span>
      <span className="context-value">{percent === null ? "—" : `${percent}%`}</span>
    </button>
  );
}
