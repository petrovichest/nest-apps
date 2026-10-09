import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../i18n";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, XIcon } from "./Icons";

export type ViewerImage = {
  src: string;
  alt: string;
  status?: "loading" | "ready" | "failed";
};

type View = { scale: number; x: number; y: number };
type PointerPoint = {
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
  background: boolean;
};
type Pinch = { distance: number; scale: number; imageX: number; imageY: number };

const initialView: View = { scale: 1, x: 0, y: 0 };
const maxScale = 6;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function ImageViewer({
  images,
  index,
  opener,
  onIndexChange,
  onClose,
  onRetry,
  onDownload,
}: {
  images: ViewerImage[];
  index: number;
  opener: HTMLElement | null;
  onIndexChange(index: number): void;
  onClose(): void;
  onRetry?(): void;
  onDownload?(): Promise<void>;
}) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const viewRef = useRef(initialView);
  const pointersRef = useRef(new Map<number, PointerPoint>());
  const pinchRef = useRef<Pinch | null>(null);
  const hadPinchRef = useRef(false);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const safariPinchRef = useRef<{ scale: number } | null>(null);
  const downloadBusyRef = useRef(false);
  const [view, setView] = useState<View>(initialView);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const image = images[index];
  useEffect(() => setDownloadFailed(false), [index]);

  const updateView = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const fitView = useCallback((next: View): View => {
    const stage = stageRef.current;
    const content = imageRef.current;
    if (!stage || !content || !content.offsetWidth || !content.offsetHeight) return initialView;
    const scale = clamp(next.scale, 1, maxScale);
    const maxX = Math.max(0, (content.offsetWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (content.offsetHeight * scale - stage.clientHeight) / 2);
    return { scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
  }, []);

  const zoomAt = useCallback(
    (scale: number, clientX: number, clientY: number) => {
      const stage = stageRef.current;
      if (
        !stage ||
        !imageRef.current ||
        !Number.isFinite(scale) ||
        !Number.isFinite(clientX) ||
        !Number.isFinite(clientY)
      )
        return;
      const bounds = stage.getBoundingClientRect();
      const current = viewRef.current;
      const nextScale = clamp(scale, 1, maxScale);
      const anchorX = clientX - bounds.left - bounds.width / 2;
      const anchorY = clientY - bounds.top - bounds.height / 2;
      const ratio = nextScale / current.scale;
      updateView(
        fitView({
          scale: nextScale,
          x: anchorX - (anchorX - current.x) * ratio,
          y: anchorY - (anchorY - current.y) * ratio,
        }),
      );
    },
    [fitView, updateView],
  );

  useLayoutEffect(() => {
    pointersRef.current.clear();
    pinchRef.current = null;
    hadPinchRef.current = false;
    lastTapRef.current = null;
    safariPinchRef.current = null;
    updateView(initialView);
  }, [index, image?.src, image?.status, updateView]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateView(fitView(viewRef.current)));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fitView, updateView]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey || !imageRef.current) return;
      event.preventDefault();
      if (safariPinchRef.current) return;
      const stage = stageRef.current;
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage?.clientHeight || 1 : 1);
      zoomAt(viewRef.current.scale * Math.exp(-delta * 0.002), event.clientX, event.clientY);
    }
    type SafariGesture = Event & { scale: number; clientX?: number; clientY?: number };
    function gestureStart(event: Event) {
      if (!imageRef.current) return;
      event.preventDefault();
      if (pointersRef.current.size) return;
      safariPinchRef.current = { scale: viewRef.current.scale };
    }
    function gestureChange(event: Event) {
      if (pointersRef.current.size) {
        event.preventDefault();
        safariPinchRef.current = null;
        return;
      }
      const start = safariPinchRef.current;
      if (!start) return;
      event.preventDefault();
      const gesture = event as SafariGesture;
      const bounds = stageRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const hasPosition =
        Number.isFinite(gesture.clientX) &&
        Number.isFinite(gesture.clientY) &&
        (gesture.clientX !== 0 || gesture.clientY !== 0);
      zoomAt(
        start.scale * gesture.scale,
        hasPosition ? gesture.clientX! : bounds.left + bounds.width / 2,
        hasPosition ? gesture.clientY! : bounds.top + bounds.height / 2,
      );
    }
    function gestureEnd(event: Event) {
      if (!safariPinchRef.current) return;
      event.preventDefault();
      safariPinchRef.current = null;
    }
    dialog.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("gesturestart", gestureStart, { capture: true, passive: false });
    window.addEventListener("gesturechange", gestureChange, { capture: true, passive: false });
    window.addEventListener("gestureend", gestureEnd, { capture: true, passive: false });
    return () => {
      dialog.removeEventListener("wheel", wheel);
      window.removeEventListener("gesturestart", gestureStart, true);
      window.removeEventListener("gesturechange", gestureChange, true);
      window.removeEventListener("gestureend", gestureEnd, true);
    };
  }, [zoomAt]);

  function startPinch() {
    const stage = stageRef.current;
    const points = [...pointersRef.current.values()];
    if (!stage || points.length !== 2) return;
    const bounds = stage.getBoundingClientRect();
    const centerX = (points[0]!.x + points[1]!.x) / 2 - bounds.left - bounds.width / 2;
    const centerY = (points[0]!.y + points[1]!.y) / 2 - bounds.top - bounds.height / 2;
    const current = viewRef.current;
    pinchRef.current = {
      distance: Math.max(1, Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y)),
      scale: current.scale,
      imageX: (centerX - current.x) / current.scale,
      imageY: (centerY - current.y) / current.scale,
    };
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!imageRef.current || (event.target instanceof Element && event.target.closest("button")))
      return;
    if (
      event.pointerType === "mouse" &&
      (viewRef.current.scale === 1 || event.target !== imageRef.current)
    )
      return;
    const pointers = pointersRef.current;
    if (pointers.size >= 2) return;
    event.preventDefault();
    if (event.pointerType === "touch") safariPinchRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      background: event.target === event.currentTarget,
    });
    if (pointers.size === 2) {
      hadPinchRef.current = true;
      lastTapRef.current = null;
      startPinch();
    }
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const pointers = pointersRef.current;
    const point = pointers.get(event.pointerId);
    if (!point) return;
    event.preventDefault();
    const dx = event.clientX - point.x;
    const dy = event.clientY - point.y;
    point.x = event.clientX;
    point.y = event.clientY;
    if (Math.hypot(point.x - point.startX, point.y - point.startY) > 10) point.moved = true;
    if (pointers.size === 1 && viewRef.current.scale > 1) {
      const current = viewRef.current;
      updateView(fitView({ ...current, x: current.x + dx, y: current.y + dy }));
    } else if (pointers.size === 2 && pinchRef.current) {
      const stage = stageRef.current;
      if (!stage) return;
      const bounds = stage.getBoundingClientRect();
      const [first, second] = [...pointers.values()];
      const pinch = pinchRef.current;
      const scale = clamp(
        (pinch.scale * Math.hypot(first!.x - second!.x, first!.y - second!.y)) / pinch.distance,
        1,
        maxScale,
      );
      const centerX = (first!.x + second!.x) / 2 - bounds.left - bounds.width / 2;
      const centerY = (first!.y + second!.y) / 2 - bounds.top - bounds.height / 2;
      updateView(
        fitView({ scale, x: centerX - pinch.imageX * scale, y: centerY - pinch.imageY * scale }),
      );
    }
  }

  function pointerEnd(event: PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const pointers = pointersRef.current;
    const point = pointers.get(event.pointerId);
    if (!point) return;
    if (
      !cancelled &&
      event.pointerType === "touch" &&
      pointers.size === 1 &&
      !hadPinchRef.current &&
      !point.background &&
      !point.moved
    ) {
      const last = lastTapRef.current;
      if (
        last &&
        event.timeStamp - last.time < 320 &&
        Math.hypot(event.clientX - last.x, event.clientY - last.y) < 32
      ) {
        if (viewRef.current.scale > 1) updateView(initialView);
        else zoomAt(3, event.clientX, event.clientY);
        lastTapRef.current = null;
      } else {
        lastTapRef.current = { time: event.timeStamp, x: event.clientX, y: event.clientY };
      }
    }
    const closeBackground =
      !cancelled &&
      event.pointerType === "touch" &&
      pointers.size === 1 &&
      !hadPinchRef.current &&
      point.background &&
      !point.moved;
    pointers.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    pinchRef.current = null;
    if (!pointers.size) hadPinchRef.current = false;
    if (closeBackground) onClose();
  }

  useEffect(() => {
    closeButtonRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        onIndexChange(index - 1);
      } else if (event.key === "ArrowRight" && index < images.length - 1) {
        event.preventDefault();
        onIndexChange(index + 1);
      } else if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        imageRef.current &&
        ["+", "=", "-", "_", "0"].includes(event.key)
      ) {
        event.preventDefault();
        if (event.key === "0") updateView(initialView);
        else {
          const bounds = stageRef.current!.getBoundingClientRect();
          const factor = event.key === "+" || event.key === "=" ? 1.5 : 1 / 1.5;
          zoomAt(
            viewRef.current.scale * factor,
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2,
          );
        }
      } else if (event.key === "Tab") {
        const buttons = [
          ...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
            []),
        ];
        const first = buttons[0],
          last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [images.length, index, onClose, onIndexChange, updateView, zoomAt]);

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    let disposed = false;
    let remove: (() => Promise<void>) | undefined;
    void CapacitorApp.addListener("backButton", onClose).then((handle) => {
      if (disposed) void handle.remove();
      else remove = () => handle.remove();
    });
    return () => {
      disposed = true;
      void remove?.();
    };
  }, [onClose]);

  async function download() {
    if (!onDownload || downloadBusyRef.current) return;
    downloadBusyRef.current = true;
    setDownloading(true);
    setDownloadFailed(false);
    try {
      await onDownload();
    } catch {
      setDownloadFailed(true);
    } finally {
      downloadBusyRef.current = false;
      setDownloading(false);
    }
  }

  if (!image) return null;

  return createPortal(
    <div
      ref={dialogRef}
      className="image-viewer-backdrop chat-image-viewer"
      data-android-back-layer
      role="dialog"
      aria-modal="true"
      aria-label={t("Просмотр изображений")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="image-viewer-control image-viewer-close"
        aria-label={t("Закрыть")}
        onClick={onClose}
      >
        <XIcon />
      </button>
      {onDownload && (
        <button
          type="button"
          className="image-viewer-control image-viewer-download"
          aria-label={t("Скачать {{name}}", { name: image.alt })}
          title={t("Скачать")}
          disabled={downloading || (image.status !== undefined && image.status !== "ready")}
          onClick={() => void download()}
        >
          {downloading ? <span className="spinner small" /> : <ArrowDownIcon />}
        </button>
      )}
      {downloadFailed && (
        <div className="image-viewer-error" role="alert">
          {t("Не удалось скачать файл. Нажмите ещё раз.")}
        </div>
      )}
      <div
        ref={stageRef}
        className="image-viewer-stage"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={(event) => pointerEnd(event, false)}
        onPointerCancel={(event) => pointerEnd(event, true)}
      >
        {images.length > 1 && (
          <button
            type="button"
            className="image-viewer-control image-viewer-nav image-viewer-previous"
            aria-label={t("Предыдущее изображение")}
            disabled={index === 0}
            onClick={() => onIndexChange(index - 1)}
          >
            <ArrowLeftIcon />
          </button>
        )}
        {image.status === "loading" ? (
          <div className="image-viewer-status" role="status">
            <span className="spinner small" />
            <span className="working-text working-text-strong">{t("Загружаем изображение…")}</span>
          </div>
        ) : image.status === "failed" ? (
          <button type="button" className="image-viewer-retry" onClick={onRetry}>
            {t("Не удалось загрузить изображение. Повторить")}
          </button>
        ) : (
          <img
            ref={imageRef}
            className={`image-viewer-image${view.scale > 1 ? " is-zoomed" : ""}`}
            src={image.src}
            alt={image.alt}
            draggable={false}
            style={{
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          />
        )}
        {images.length > 1 && (
          <button
            type="button"
            className="image-viewer-control image-viewer-nav image-viewer-next"
            aria-label={t("Следующее изображение")}
            disabled={index === images.length - 1}
            onClick={() => onIndexChange(index + 1)}
          >
            <ArrowRightIcon />
          </button>
        )}
      </div>
      {images.length > 1 && (
        <div className="image-viewer-counter" aria-live="polite">
          {t("Изображение {{current}} из {{total}}", {
            current: index + 1,
            total: images.length,
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}
