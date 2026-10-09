import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

import { type ArtifactDescriptor, formatArtifactSize, safeArtifactHtml } from "../artifacts";
import { useI18n } from "../i18n";
import { allowMarkdownElement } from "../markdown-elements";
import { ArrowDownIcon, ArrowLeftIcon, FileIcon, RefreshIcon, XIcon } from "./Icons";

export type ArtifactLoadResult =
  | { state: "ready"; data: ArrayBuffer; fileName: string; size: number }
  | { state: "tooLarge"; fileName: string; size: number };

export function ArtifactViewer({
  artifact,
  opener,
  onClose,
  onDownload,
  onLoad,
  returnToArtifacts = false,
}: {
  artifact: ArtifactDescriptor;
  opener: HTMLButtonElement | null;
  onClose(): void;
  onDownload(path: string): Promise<void>;
  onLoad(artifact: ArtifactDescriptor): Promise<ArtifactLoadResult>;
  returnToArtifacts?: boolean;
}) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<ArtifactLoadResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  useEffect(() => {
    let current = true;
    setResult(null);
    setFailed(false);
    void onLoad(artifact)
      .then((value) => {
        if (current) setResult(value);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [artifact, onLoad, revision]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    return () => {
      window.setTimeout(() => {
        const target = opener?.isConnected
          ? opener
          : [
              ...document.querySelectorAll<HTMLButtonElement>(
                ".inspector-artifact-open[data-artifact-path]",
              ),
            ].find((button) => button.dataset.artifactPath === artifact.path);
        target?.focus();
      }, 0);
    };
  }, [artifact.path, opener, returnToArtifacts]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    let disposed = false;
    let removeListener: (() => Promise<void>) | undefined;
    void CapacitorApp.addListener("backButton", onClose).then((handle) => {
      if (disposed) void handle.remove();
      else removeListener = () => handle.remove();
    });
    return () => {
      disposed = true;
      void removeListener?.();
    };
  }, [onClose]);

  async function download() {
    if (downloading) return;
    setDownloading(true);
    setDownloadFailed(false);
    try {
      await onDownload(artifact.path);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <aside
      className="artifact-viewer"
      aria-label={t("Просмотр файла {{name}}", { name: artifact.fileName })}
      data-android-back-layer
    >
      <header className="artifact-viewer-header">
        <span className="artifact-viewer-file-icon" aria-hidden="true">
          <FileIcon />
        </span>
        <span className="artifact-viewer-title">
          <strong title={result?.fileName ?? artifact.fileName}>
            {result?.fileName ?? artifact.fileName}
          </strong>
          <span>
            {artifact.format}
            {result ? ` · ${formatArtifactSize(result.size)}` : ""}
          </span>
        </span>
        <span className="artifact-viewer-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t("Обновить предпросмотр")}
            title={t("Обновить предпросмотр")}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("Скачать {{name}}", { name: artifact.fileName })}
            title={t("Скачать")}
            disabled={downloading}
            onClick={() => void download()}
          >
            <ArrowDownIcon />
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button"
            aria-label={returnToArtifacts ? t("Вернуться к артефактам") : t("Закрыть предпросмотр")}
            onClick={onClose}
          >
            {returnToArtifacts ? <ArrowLeftIcon /> : <XIcon />}
          </button>
        </span>
      </header>
      <div className={`artifact-viewer-stage artifact-viewer-${artifact.kind}`}>
        {downloadFailed && (
          <div className="artifact-download-error" role="alert">
            {t("Не удалось скачать файл. Нажмите ещё раз.")}
          </div>
        )}
        {!result && !failed && <ArtifactState spinner>{t("Загружаем файл…")}</ArtifactState>}
        {failed && (
          <ArtifactState>
            <strong>{t("Не удалось открыть файл")}</strong>
            <span>{t("Файл мог быть перемещён или удалён.")}</span>
            <button type="button" onClick={() => setRevision((value) => value + 1)}>
              {t("Повторить")}
            </button>
          </ArtifactState>
        )}
        {result?.state === "tooLarge" && (
          <ArtifactState>
            <strong>{t("Файл слишком большой для предпросмотра")}</strong>
            <span>
              {t("Размер файла — {{size}}. Его можно скачать.", {
                size: formatArtifactSize(result.size),
              })}
            </span>
            <button type="button" onClick={() => void download()}>
              <ArrowDownIcon /> {t("Скачать")}
            </button>
          </ArtifactState>
        )}
        {result?.state === "ready" && <ArtifactContent artifact={artifact} data={result.data} />}
      </div>
    </aside>
  );
}

function ArtifactState({ children, spinner = false }: { children: ReactNode; spinner?: boolean }) {
  return (
    <div className="artifact-viewer-state" role="status">
      {spinner && <span className="spinner" />}
      {spinner ? <span className="working-text">{children}</span> : children}
    </div>
  );
}

function ArtifactContent({ artifact, data }: { artifact: ArtifactDescriptor; data: ArrayBuffer }) {
  if (artifact.kind === "image") return <ImageArtifact artifact={artifact} data={data} />;
  if (artifact.kind === "pdf") return <PdfArtifact data={data} />;
  const text = new TextDecoder().decode(data);
  if (artifact.kind === "markdown") {
    return (
      <article className="artifact-document artifact-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          allowElement={allowMarkdownElement}
          unwrapDisallowed
          components={{
            table: ArtifactMarkdownTable,
            a({ children, href }) {
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {text}
        </ReactMarkdown>
      </article>
    );
  }
  if (artifact.kind === "html") {
    return (
      <iframe
        className="artifact-html-frame"
        title={artifact.fileName}
        sandbox=""
        srcDoc={safeArtifactHtml(text)}
      />
    );
  }
  return <pre className="artifact-document artifact-text">{text}</pre>;
}

function ArtifactMarkdownTable({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="markdown-table-scroll" role="group" aria-label={t("Таблица")} tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}

function ImageArtifact({ artifact, data }: { artifact: ArtifactDescriptor; data: ArrayBuffer }) {
  const source = useMemo(
    () => URL.createObjectURL(new Blob([data], { type: imageMimeType(artifact.path) })),
    [artifact.path, data],
  );
  useEffect(() => () => URL.revokeObjectURL(source), [source]);
  return <img className="artifact-image" src={source} alt={artifact.fileName} />;
}

function imageMimeType(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return `image/${extension || "png"}`;
}

function PdfArtifact({ data }: { data: ArrayBuffer }) {
  const { t } = useI18n();
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let current = true;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let loadedDocument: PDFDocumentProxy | null = null;
    void Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")])
      .then(async ([pdfjs, worker]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        loadingTask = pdfjs.getDocument({ data: data.slice(0) });
        loadedDocument = await loadingTask.promise;
        if (current) setDocument(loadedDocument);
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
      void loadedDocument?.cleanup();
      void loadingTask?.destroy();
    };
  }, [data]);

  if (error) {
    return (
      <ArtifactState>
        <strong>{t("Не удалось отобразить PDF")}</strong>
        <span>{t("Скачайте файл, чтобы открыть его в другом приложении.")}</span>
      </ArtifactState>
    );
  }
  if (!document) return <ArtifactState spinner>{t("Готовим страницы PDF…")}</ArtifactState>;
  return (
    <div className="artifact-pdf-pages">
      {Array.from({ length: document.numPages }, (_, index) => (
        <PdfPage document={document} pageNumber={index + 1} key={index + 1} />
      ))}
    </div>
  );
}

function PdfPage({ document, pageNumber }: { document: PDFDocumentProxy; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    let renderTask: { cancel(): void; promise: Promise<void> } | null = null;
    void document
      .getPage(pageNumber)
      .then(async (page) => {
        const canvas = canvasRef.current;
        if (!current || !canvas) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const cssScale = Math.min(1.35, 900 / baseViewport.width);
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: cssScale * pixelRatio });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`;
        canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`;
        renderTask = page.render({ canvas, viewport });
        await renderTask.promise;
      })
      .catch((error: unknown) => {
        if (current && (error as { name?: string }).name !== "RenderingCancelledException") {
          setFailed(true);
        }
      });
    return () => {
      current = false;
      renderTask?.cancel();
    };
  }, [document, pageNumber]);

  return failed ? (
    <div className="artifact-pdf-page-error">{pageNumber}</div>
  ) : (
    <canvas className="artifact-pdf-page" ref={canvasRef} aria-label={`PDF ${pageNumber}`} />
  );
}
