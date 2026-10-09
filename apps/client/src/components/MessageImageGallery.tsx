import { Capacitor } from "@capacitor/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { collectMessageImages, messageImage, type MessageImage } from "../message-images";
import { openDownloadUrl } from "../downloads";
import { useI18n } from "../i18n";
import { ImageIcon } from "./Icons";
import { ImageViewer } from "./ImageViewer";

type ImageState = { src: string; status: "loading" | "ready" | "failed" };
type Gallery = {
  images: MessageImage[];
  states: Record<string, ImageState>;
  attempts: Record<string, number>;
  find(src?: string, explicit?: boolean): MessageImage | undefined;
  open(key: string, opener: HTMLButtonElement): void;
  retry(key: string): void;
  update(key: string, state: ImageState): void;
  onLoadImage?: (path: string) => Promise<Blob>;
};
const GalleryContext = createContext<Gallery | null>(null);
export const useMessageImageGallery = () => useContext(GalleryContext);
const noImages: string[] = [];

export function MessageImageProvider({
  text,
  images = noImages,
  toolImages = false,
  cwd,
  onLoadImage,
  onDownload,
  children,
}: {
  text: string;
  images?: string[];
  toolImages?: boolean;
  cwd?: string;
  onLoadImage?: (path: string) => Promise<Blob>;
  onDownload?: (path: string) => Promise<void>;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const collection = useMemo(
    () => collectMessageImages(text, images, cwd, toolImages),
    [text, images, cwd, toolImages],
  );
  const [states, setStates] = useState<Record<string, ImageState>>({});
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const [viewer, setViewer] = useState<{ key: string; opener: HTMLButtonElement } | null>(null);
  const open = useCallback(
    (key: string, opener: HTMLButtonElement) => setViewer({ key, opener }),
    [],
  );
  const close = useCallback(() => setViewer(null), []);
  const retry = useCallback(
    (key: string) => setAttempts((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 })),
    [],
  );
  const update = useCallback(
    (key: string, state: ImageState) => setStates((current) => ({ ...current, [key]: state })),
    [],
  );
  const index = collection.findIndex((image) => image.key === viewer?.key);
  const selected = collection[index];
  useEffect(() => {
    if (viewer && index < 0) setViewer(null);
  }, [index, viewer]);
  const value = useMemo<Gallery>(
    () => ({
      images: collection,
      states,
      attempts,
      open,
      retry,
      update,
      onLoadImage,
      find: (src, explicit) => {
        const key = messageImage(src, cwd, explicit)?.key;
        return collection.find((image) => image.key === key);
      },
    }),
    [collection, states, attempts, open, retry, update, onLoadImage, cwd],
  );

  async function download() {
    if (!selected) return;
    if (selected.localPath && onDownload) return onDownload(selected.localPath);
    if (Capacitor.isNativePlatform() && /^https?:\/\//i.test(selected.src))
      return openDownloadUrl(window.location.origin, selected.src);
    const response = await fetch(states[selected.key]?.src || selected.src);
    if (!response.ok) throw new Error("Image download failed");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const fileName = new URL(selected.src, window.location.href).pathname.split("/").at(-1);
    link.download =
      !selected.src.startsWith("data:") && fileName?.includes(".")
        ? decodeURIComponent(fileName)
        : `image.${blob.type.split("/")[1]?.replace("svg+xml", "svg") || "png"}`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <GalleryContext.Provider value={value}>
      {children}
      {viewer && selected && (
        <ImageViewer
          images={collection.map((image, i) => ({
            src: states[image.key]?.src ?? "",
            status: states[image.key]?.status ?? "loading",
            alt: image.label || t("Изображение {{number}}", { number: i + 1 }),
          }))}
          index={index}
          opener={viewer.opener}
          onIndexChange={(next) => setViewer({ ...viewer, key: collection[next]!.key })}
          onClose={close}
          onRetry={() => retry(selected.key)}
          onDownload={download}
        />
      )}
    </GalleryContext.Provider>
  );
}

export function GalleryImageLink({
  image,
  children,
  title,
}: {
  image: MessageImage;
  children?: ReactNode;
  title?: string;
}) {
  const gallery = useMessageImageGallery()!;
  const { t } = useI18n();
  const label =
    image.label || t("Изображение {{number}}", { number: gallery.images.indexOf(image) + 1 });
  return (
    <button
      type="button"
      className="download-link gallery-image-link"
      title={title}
      aria-label={t("Открыть изображение {{name}}", { name: label })}
      onClick={(event) => gallery.open(image.key, event.currentTarget)}
    >
      <ImageIcon />
      {children || label}
    </button>
  );
}

export function MessageImageGallery() {
  const gallery = useMessageImageGallery();
  const { t } = useI18n();
  if (!gallery?.images.length) return null;
  return (
    <div className="message-image-gallery" role="group" aria-label={t("Изображения")}>
      {gallery.images.map((image, index) => (
        <GalleryThumbnail key={image.key} image={image} index={index} />
      ))}
    </div>
  );
}

function GalleryThumbnail({ image, index }: { image: MessageImage; index: number }) {
  const { t } = useI18n();
  const gallery = useMessageImageGallery()!;
  const { update, onLoadImage } = gallery;
  const state = gallery.states[image.key];
  const attempt = gallery.attempts[image.key] ?? 0;
  const label = image.label || t("Изображение {{number}}", { number: index + 1 });
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    update(image.key, { status: "loading", src: image.localPath && onLoadImage ? "" : image.src });
    if (image.localPath && onLoadImage) {
      void onLoadImage(image.localPath)
        .then((blob) => {
          if (!active) return;
          objectUrl = URL.createObjectURL(blob);
          update(image.key, { status: "loading", src: objectUrl });
        })
        .catch(() => {
          if (active) update(image.key, { status: "failed", src: "" });
        });
    }
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.key, image.src, image.localPath, attempt, onLoadImage, update]);
  const status = state?.status ?? "loading";
  return (
    <button
      type="button"
      className={`gallery-thumbnail is-${status}`}
      disabled={status === "loading"}
      aria-busy={status === "loading"}
      aria-label={
        status === "failed"
          ? `${label}: ${t("Не удалось загрузить изображение. Повторить")}`
          : t("Открыть изображение {{name}}", { name: label })
      }
      onClick={(event) =>
        status === "failed"
          ? gallery.retry(image.key)
          : gallery.open(image.key, event.currentTarget)
      }
    >
      {status === "loading" && (
        <span role="status">
          <span className="spinner small" />
          <span className="working-text">{t("Загружаем изображение…")}</span>
        </span>
      )}
      {status === "failed" && <span>{t("Не удалось загрузить изображение. Повторить")}</span>}
      {state?.src && status !== "failed" && (
        <img
          key={`${image.key}:${attempt}`}
          src={state.src}
          alt={label}
          onLoad={() => update(image.key, { src: state.src, status: "ready" })}
          onError={() => update(image.key, { src: state.src, status: "failed" })}
        />
      )}
    </button>
  );
}
