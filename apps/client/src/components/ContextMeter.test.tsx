import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextMeter, contextPercent } from "./ContextMeter";

const usage = (usedTokens: number | null, windowTokens = 200_000) => ({ usedTokens, windowTokens });

function renderMeter(props: Partial<Parameters<typeof ContextMeter>[0]> = {}, onCompact = vi.fn()) {
  const view = render(
    <ContextMeter
      usage={usage(84_000)}
      running={false}
      compacting={false}
      onCompact={onCompact}
      {...props}
    />,
  );
  return { ...view, onCompact, button: () => screen.getByRole("button") };
}

/** One press the way a browser delivers it: a pointer press, then a click carrying a click count. */
function press(button: HTMLElement, pointerType: "mouse" | "touch") {
  fireEvent.pointerDown(button, { pointerType });
  fireEvent.click(button, { detail: 1 });
}

describe("ContextMeter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("computes the share of the window and clamps it", () => {
    expect(contextPercent(usage(84_000))).toBe(42);
    expect(contextPercent(usage(250_000))).toBe(100);
    expect(contextPercent(usage(null))).toBeNull();
    expect(contextPercent(undefined)).toBeNull();
    expect(contextPercent({ usedTokens: 10, windowTokens: 0 })).toBeNull();
  });

  it("shows the percentage with a level that turns amber, then red", () => {
    const view = renderMeter();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(view.button()).toHaveAttribute("aria-label", "Контекст заполнен на 42%");
    expect(view.button()).toHaveAttribute("data-level", "ok");
    view.rerender(
      <ContextMeter
        usage={usage(160_000)}
        running={false}
        compacting={false}
        onCompact={vi.fn()}
      />,
    );
    expect(view.button()).toHaveAttribute("data-level", "warn");
    view.rerender(
      <ContextMeter
        usage={usage(190_000)}
        running={false}
        compacting={false}
        onCompact={vi.fn()}
      />,
    );
    expect(view.button()).toHaveAttribute("data-level", "high");
  });

  it("shows a dash right after a compaction until the next answer reports the size", () => {
    const view = renderMeter({ usage: usage(null) });
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(view.button()).toHaveAttribute("aria-label", "Заполненность контекста неизвестна");
    expect(view.container.querySelector(".context-ring")).toHaveAttribute("data-empty");
    press(view.button(), "mouse");
    expect(view.container.querySelector(".context-icon")).toBeNull();
    expect(view.onCompact).not.toHaveBeenCalled();
  });

  it("with a mouse, shows the compact icon on the first click and compacts on the second", () => {
    const view = renderMeter();
    press(view.button(), "mouse");
    expect(view.button()).toHaveAttribute("aria-label", "Сжать контекст");
    expect(view.button()).toHaveClass("active");
    expect(view.container.querySelector(".context-icon")).not.toBeNull();
    expect(screen.getByText("42%")).toBeInTheDocument();
    // A resting pointer is not cancelled by time inside the safety limit.
    act(() => void vi.advanceTimersByTime(7_000));
    expect(view.button()).toHaveAttribute("aria-label", "Сжать контекст");
    press(view.button(), "mouse");
    expect(view.onCompact).toHaveBeenCalledTimes(1);
    expect(view.button()).toHaveAttribute("aria-label", "Контекст заполнен на 42%");
  });

  it("with a mouse, leaving the button starts over", () => {
    const view = renderMeter();
    press(view.button(), "mouse");
    fireEvent.pointerLeave(view.button(), { pointerType: "mouse" });
    expect(view.button()).toHaveAttribute("aria-label", "Контекст заполнен на 42%");
    press(view.button(), "mouse");
    expect(view.onCompact).not.toHaveBeenCalled();
  });

  it("with a mouse, still lets go of a pointer left resting on the button", () => {
    const view = renderMeter();
    press(view.button(), "mouse");
    act(() => void vi.advanceTimersByTime(8_100));
    expect(view.button()).toHaveAttribute("aria-label", "Контекст заполнен на 42%");
  });

  it("with a finger, gives a few seconds for the second tap and ignores the pointer leaving", () => {
    const view = renderMeter();
    press(view.button(), "touch");
    fireEvent.pointerLeave(view.button(), { pointerType: "touch" });
    expect(view.button()).toHaveAttribute("aria-label", "Сжать контекст");
    act(() => void vi.advanceTimersByTime(3_100));
    expect(view.button()).toHaveAttribute("aria-label", "Контекст заполнен на 42%");
    press(view.button(), "touch");
    act(() => void vi.advanceTimersByTime(2_000));
    press(view.button(), "touch");
    expect(view.onCompact).toHaveBeenCalledTimes(1);
  });

  it("with the keyboard, confirms with a second press and cancels on blur or Escape", () => {
    const view = renderMeter();
    fireEvent.click(view.button(), { detail: 0 });
    expect(view.button()).toHaveAttribute("aria-label", "Сжать контекст");
    fireEvent.blur(view.button());
    expect(view.button()).toHaveAttribute("aria-label", "Контекст заполнен на 42%");
    fireEvent.click(view.button(), { detail: 0 });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.button()).toHaveAttribute("aria-label", "Контекст заполнен на 42%");
    fireEvent.click(view.button(), { detail: 0 });
    fireEvent.click(view.button(), { detail: 0 });
    expect(view.onCompact).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending confirmation when something else is pressed", () => {
    const view = renderMeter();
    press(view.button(), "touch");
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(view.button()).toHaveAttribute("aria-label", "Контекст заполнен на 42%");
  });

  it("does not react while the agent works, while compacting, or when there is nothing to compact", () => {
    const working = renderMeter({ running: true });
    expect(working.button()).toHaveAttribute("aria-disabled", "true");
    press(working.button(), "mouse");
    expect(working.container.querySelector(".context-icon")).toBeNull();
    working.unmount();

    const compacting = renderMeter({ compacting: true });
    expect(compacting.button()).toHaveAttribute("aria-label", "Сжимаем контекст");
    expect(compacting.container.querySelector(".spinner")).not.toBeNull();
    press(compacting.button(), "mouse");
    expect(compacting.onCompact).not.toHaveBeenCalled();
    compacting.unmount();

    const tiny = renderMeter({ usage: usage(4_000) });
    press(tiny.button(), "mouse");
    expect(tiny.container.querySelector(".context-icon")).toBeNull();
    expect(tiny.onCompact).not.toHaveBeenCalled();
  });

  it("drops the compact icon when the agent starts working while it is shown", () => {
    const view = renderMeter();
    press(view.button(), "mouse");
    expect(view.container.querySelector(".context-icon")).not.toBeNull();
    view.rerender(
      <ContextMeter usage={usage(84_000)} running compacting={false} onCompact={vi.fn()} />,
    );
    expect(view.container.querySelector(".context-icon")).toBeNull();
  });
});
