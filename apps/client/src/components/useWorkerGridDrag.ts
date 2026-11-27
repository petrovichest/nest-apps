import {
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type DragPreview = { grid: HTMLUListElement; from: number; target: number };

const START_DISTANCE = 6;
const TOUCH_HOLD = 350;
const SCROLL_EDGE = 48;
const SCROLL_SPEED = 12;

function targetAt(grid: HTMLUListElement, x: number, y: number) {
  const hit = document.elementFromPoint(x, y);
  if (hit?.closest(".workers-grid") !== grid) return -1;
  const card = hit.closest("li");
  if (card?.parentElement === grid) return Array.from(grid.children).indexOf(card);

  // Resolve the nearest row first, then the nearest column within it.
  // This also covers gaps and the empty columns of a short last row.
  let target = -1;
  let rowDistance = Infinity;
  let columnDistance = Infinity;
  for (const [index, card] of Array.from(grid.children).entries()) {
    const { top, bottom, left, right } = card.getBoundingClientRect();
    const dy = Math.max(top - y, y - bottom, 0);
    const dx = Math.max(left - x, x - right, 0);
    if (dy < rowDistance || (dy === rowDistance && dx < columnDistance)) {
      target = index;
      rowDistance = dy;
      columnDistance = dx;
    }
  }
  return target;
}

export function useWorkerGridDrag() {
  const pending = useRef<AbortController>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<DragPreview>();

  useEffect(() => () => pending.current?.abort(), []);

  function begin(
    event: ReactPointerEvent<HTMLButtonElement>,
    from: number,
    onDrop: (target: number, button: HTMLButtonElement) => void,
  ) {
    if (pending.current || !event.isPrimary || event.button !== 0) return;

    const button = event.currentTarget;
    const grid = button.closest<HTMLUListElement>(".workers-grid")!;
    const scroll = grid.closest<HTMLElement>(".worker-catalogue")!;
    const { pointerId, clientX: startX, clientY: startY } = event;
    const touch = event.pointerType === "touch";
    const gesture = new AbortController();
    const { signal } = gesture;
    pending.current = gesture;

    let x = startX;
    let y = startY;
    let active = false;
    let target = from;
    let timer = 0;
    let frame = 0;

    function updateTarget() {
      const next = targetAt(grid, x, y);
      if (next === target) return;
      target = next;
      setPreview({ grid, from, target });
    }

    function scrollAtEdge() {
      frame = 0;
      if (target < 0) return;
      const bounds = scroll.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(scroll).scrollPaddingBlockStart) || 0;
      const top = bounds.top + padding;
      const edge = Math.min(SCROLL_EDGE, (bounds.bottom - top) / 2);
      if (edge <= 0) return;
      const pressure = (distance: number) => Math.max(0, Math.min(1, distance / edge));
      const delta = Math.round(
        SCROLL_SPEED * (pressure(y - bounds.bottom + edge) - pressure(top + edge - y)),
      );
      if (!delta) return;
      // Keep the last row available when the pointer waits at an edge.
      const project = grid.getBoundingClientRect();
      const distance = delta > 0 ? project.bottom - y : y - project.top;
      const step = Math.min(Math.abs(delta), Math.max(0, Math.ceil(distance) - 1));
      const previous = scroll.scrollTop;
      scroll.scrollTop += Math.sign(delta) * step;
      if (scroll.scrollTop === previous) return;
      updateTarget();
      frame = requestAnimationFrame(scrollAtEdge);
    }

    function activate() {
      if (!button.isConnected || button.disabled) {
        gesture.abort();
        return;
      }
      active = true;
      suppressClick.current = true;
      button.focus({ preventScroll: true });
      button.setPointerCapture(pointerId);
      setPreview({ grid, from, target });
      updateTarget();
      frame = requestAnimationFrame(scrollAtEdge);
    }

    function move(event: PointerEvent) {
      if (event.pointerId !== pointerId) return;
      x = event.clientX;
      y = event.clientY;
      if (!active) {
        if (Math.hypot(x - startX, y - startY) < START_DISTANCE) return;
        if (touch) {
          suppressClick.current = true;
          gesture.abort();
          return;
        }
        activate();
        return;
      }
      updateTarget();
      if (!frame) frame = requestAnimationFrame(scrollAtEdge);
    }

    function finish(drop: boolean, restoreFocus = true) {
      gesture.abort();
      if (!active) return;
      setPreview(undefined);
      if (drop && target >= 0 && target !== from && grid.children[from]?.contains(button)) {
        onDrop(target, button);
      } else if (restoreFocus && document.activeElement === button) {
        button.scrollIntoView({ block: "nearest" });
      }
    }

    signal.addEventListener(
      "abort",
      () => {
        pending.current = null;
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        if (active && button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
      },
      { once: true },
    );

    window.addEventListener("pointermove", move, { signal });
    window.addEventListener(
      "pointerup",
      (event) => {
        if (event.pointerId !== pointerId) return;
        if (active) target = targetAt(grid, event.clientX, event.clientY);
        finish(true);
      },
      { signal },
    );
    window.addEventListener(
      "pointercancel",
      (event) => {
        if (event.pointerId === pointerId) finish(false);
      },
      { signal },
    );
    button.addEventListener(
      "lostpointercapture",
      (event) => {
        if (active && event.target === button && (event as PointerEvent).pointerId === pointerId) {
          finish(false);
        }
      },
      { signal },
    );
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick.current = true;
        finish(false);
      },
      { signal, capture: true },
    );
    window.addEventListener("blur", () => finish(false, false), { signal });
    scroll.addEventListener(
      "scroll",
      () => {
        if (active) updateTarget();
      },
      { signal, passive: true },
    );

    if (touch) {
      // Before the hold, native scrolling owns the gesture. After it, stop
      // scrolling here: changing touch-action mid-gesture cannot do that.
      scroll.addEventListener(
        "touchmove",
        (event) => {
          if (active && event.cancelable) event.preventDefault();
        },
        { signal, passive: false, capture: true },
      );
      button.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
      timer = window.setTimeout(activate, TOUCH_HOLD);
    }
  }

  return {
    preview,
    begin,
    resetClick(event: ReactPointerEvent) {
      if (event.isPrimary && !pending.current) suppressClick.current = false;
    },
    captureClick(event: MouseEvent) {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
