import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";

type DialogLabel = { ariaLabel: string; titleId?: never } | { ariaLabel?: never; titleId: string };

type DialogProps = DialogLabel & {
  backdropClassName?: string;
  children: ReactNode;
  className?: string;
  closeOnBackdrop: boolean;
  closeOnEscape: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

const focusableSelector =
  "a[href], button, input:not([type='hidden']), select, textarea, summary, [tabindex]";
const DialogDepthContext = createContext(0);

export function Dialog({
  ariaLabel,
  backdropClassName,
  children,
  className,
  closeOnBackdrop,
  closeOnEscape,
  initialFocusRef,
  onClose,
  returnFocusRef,
  titleId,
}: DialogProps) {
  const depth = useContext(DialogDepthContext);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const latestRef = useRef({ closeOnEscape, onClose });
  latestRef.current = { closeOnEscape, onClose };

  if (!restoreFocusRef.current && typeof document !== "undefined") {
    restoreFocusRef.current =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const dialogElement = dialog;
    const ownerDocument = dialogElement.ownerDocument;

    // React focuses an autoFocus field itself and leaves no autofocus attribute to find.
    const focusedInside =
      ownerDocument.activeElement instanceof HTMLElement &&
      dialogElement.contains(ownerDocument.activeElement)
        ? ownerDocument.activeElement
        : null;
    const initialFocus =
      initialFocusRef?.current ??
      focusedInside ??
      dialogElement.querySelector<HTMLElement>("[autofocus]") ??
      focusableElements(dialogElement)[0] ??
      dialogElement;
    initialFocus.focus({ preventScroll: true });

    function handleKeyDown(event: KeyboardEvent) {
      const dialogs = ownerDocument.querySelectorAll<HTMLElement>('.dialog-surface[role="dialog"]');
      const topDialog = Array.from(dialogs).reduce<HTMLElement | null>((top, candidate) => {
        if (!top) return candidate;
        return Number(candidate.dataset.dialogDepth) >= Number(top.dataset.dialogDepth)
          ? candidate
          : top;
      }, null);
      if (topDialog !== dialogElement) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (latestRef.current.closeOnEscape) latestRef.current.onClose();
        return;
      }
      if (event.key === "Tab" && !event.defaultPrevented) keepTabFocus(event, dialogElement);
    }

    ownerDocument.addEventListener("keydown", handleKeyDown);
    return () => {
      ownerDocument.removeEventListener("keydown", handleKeyDown);
      const restoreFocus = returnFocusRef?.current ?? restoreFocusRef.current;
      if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    };
  }, [initialFocusRef, returnFocusRef]);

  return createPortal(
    <div
      className={`dialog-backdrop${backdropClassName ? ` ${backdropClassName}` : ""}`}
      data-dialog-depth={depth}
      role="presentation"
      style={{ zIndex: 100 + depth }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && closeOnBackdrop) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`dialog-surface${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={titleId}
        data-dialog-depth={depth}
        tabIndex={-1}
      >
        <DialogDepthContext.Provider value={depth + 1}>{children}</DialogDepthContext.Provider>
      </div>
    </div>,
    document.body,
  );
}

export function keepTabFocus(event: KeyboardEvent, surface: HTMLElement) {
  const focusable = focusableElements(surface);
  const edge = event.shiftKey ? focusable[0] : focusable.at(-1);
  const target = event.shiftKey ? focusable.at(-1) : focusable[0];
  const activeElement = surface.ownerDocument.activeElement;
  const pastEdge = event.shiftKey
    ? Node.DOCUMENT_POSITION_PRECEDING
    : Node.DOCUMENT_POSITION_FOLLOWING;
  if (
    !edge ||
    !activeElement ||
    activeElement === edge ||
    !surface.contains(activeElement) ||
    (edge.compareDocumentPosition(activeElement) & pastEdge) !== 0
  ) {
    event.preventDefault();
    (target ?? surface).focus();
  }
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  const hasLayout = dialog.getClientRects().length > 0;
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      !element.closest(
        '[hidden], [inert], [aria-hidden="true"], details:not([open]) > :not(summary)',
      ) &&
      (!hasLayout ||
        (element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility === "visible")),
  );
}
