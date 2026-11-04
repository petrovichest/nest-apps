import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "./Dialog";

function DialogHarness({
  closeOnBackdrop = true,
  closeOnEscape = true,
  onClose = vi.fn(),
}: {
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  onClose?: () => void;
}) {
  const initialFocusRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      ariaLabel="Test dialog"
      closeOnBackdrop={closeOnBackdrop}
      closeOnEscape={closeOnEscape}
      initialFocusRef={initialFocusRef}
      onClose={onClose}
    >
      <button type="button">First</button>
      <input ref={initialFocusRef} aria-label="Initial" />
      <button type="button">Last</button>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("moves focus to the requested initial control", () => {
    render(<DialogHarness />);
    expect(screen.getByRole("textbox", { name: "Initial" })).toHaveFocus();
  });

  it("keeps the focus a field took with autoFocus", () => {
    render(
      <Dialog ariaLabel="Task" closeOnBackdrop closeOnEscape onClose={vi.fn()}>
        <button type="button">Close</button>
        <textarea aria-label="Task text" autoFocus />
      </Dialog>,
    );
    expect(screen.getByRole("textbox", { name: "Task text" })).toHaveFocus();
  });

  it("traps Tab and Shift+Tab at the dialog boundaries", () => {
    render(<DialogHarness />);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("closes with Escape only when allowed", () => {
    const allowedClose = vi.fn();
    const deniedClose = vi.fn();
    const allowed = render(<DialogHarness onClose={allowedClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(allowedClose).toHaveBeenCalledOnce();

    allowed.unmount();
    render(<DialogHarness closeOnEscape={false} onClose={deniedClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(deniedClose).not.toHaveBeenCalled();
  });

  it("closes from the backdrop only when allowed", () => {
    const allowedClose = vi.fn();
    const deniedClose = vi.fn();
    const allowed = render(<DialogHarness onClose={allowedClose} />);
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(allowedClose).toHaveBeenCalledOnce();

    allowed.unmount();
    render(<DialogHarness closeOnBackdrop={false} onClose={deniedClose} />);
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(deniedClose).not.toHaveBeenCalled();
  });

  it("returns focus to a connected opener", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && (
            <Dialog
              ariaLabel="Restoring dialog"
              closeOnBackdrop
              closeOnEscape
              onClose={() => setOpen(false)}
            >
              <button type="button">Inside</button>
            </Dialog>
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("button", { name: "Inside" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(opener).toHaveFocus();
  });

  it("lets only the top shared dialog handle Escape", () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    render(
      <Dialog ariaLabel="Outer" closeOnBackdrop closeOnEscape onClose={outerClose}>
        <Dialog ariaLabel="Inner" closeOnBackdrop closeOnEscape onClose={innerClose}>
          <button type="button">Inner action</button>
        </Dialog>
      </Dialog>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(innerClose).toHaveBeenCalledOnce();
    expect(outerClose).not.toHaveBeenCalled();
  });
});
