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

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
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
      if (event.key !== "Tab") return;

      const focusable = focusableElements(dialogElement);
      if (!focusable.length) {
        event.preventDefault();
        dialogElement.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = ownerDocument.activeElement;
      if (event.shiftKey && (activeElement === first || !dialogElement.contains(activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (
        !event.shiftKey &&
        (activeElement === last || !dialogElement.contains(activeElement))
      ) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
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

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" && !element.closest("[hidden], [inert]"),
  );
}
