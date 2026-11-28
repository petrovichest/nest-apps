import type { ThreadArtifactsResponse as ProtocolThreadArtifactsResponse } from "@codexnest/protocol";

export type ArtifactPreviewKind = "html" | "image" | "markdown" | "pdf" | "text";

export type ArtifactDescriptor = {
  fileName: string;
  format: string;
  kind: ArtifactPreviewKind;
  maxBytes: number;
  path: string;
};

export type SessionArtifact = {
  id: string;
  label: string;
  path: string;
  fileName: string;
  relativePath: string;
  turnId: string;
  createdAt: number;
  format: string;
  preview: ArtifactDescriptor | null;
};

export type ThreadArtifactsResponse = ProtocolThreadArtifactsResponse;

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const IMAGE_PREVIEW_LIMIT = 25 * 1024 * 1024;
const PDF_PREVIEW_LIMIT = 50 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpeg", "jpg", "png", "webp"]);
const TEXT_EXTENSIONS = new Set(["csv", "json", "log", "text", "txt", "yaml", "yml"]);

export function artifactDescriptor(path: string): ArtifactDescriptor | null {
  const fileName = path.split("/").at(-1) || path;
  const extension = fileName.includes(".") ? fileName.split(".").at(-1)?.toLowerCase() : undefined;
  if (!extension) return null;

  if (IMAGE_EXTENSIONS.has(extension)) {
    return {
      fileName,
      format: extensionLabel(extension),
      kind: "image",
      maxBytes: IMAGE_PREVIEW_LIMIT,
      path,
    };
  }
  if (extension === "pdf") {
    return { fileName, format: "PDF", kind: "pdf", maxBytes: PDF_PREVIEW_LIMIT, path };
  }
  if (extension === "md" || extension === "markdown") {
    return { fileName, format: "Markdown", kind: "markdown", maxBytes: TEXT_PREVIEW_LIMIT, path };
  }
  if (extension === "html" || extension === "htm") {
    return { fileName, format: "HTML", kind: "html", maxBytes: TEXT_PREVIEW_LIMIT, path };
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return {
      fileName,
      format: extension.toUpperCase(),
      kind: "text",
      maxBytes: TEXT_PREVIEW_LIMIT,
      path,
    };
  }
  return null;
}

export function localDownloadPath(href: string | undefined, cwd: string): string | null {
  if (!href?.startsWith("/")) return null;
  let path: string;
  try {
    path = decodeURI(href);
  } catch {
    return null;
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  const root = cwd.replace(/\/+$/, "") || "/";
  if (root === "/" || path === root || path.startsWith(`${root}/`)) return path;
  return null;
}

export function sessionArtifacts(response: ThreadArtifactsResponse | null): SessionArtifact[] {
  return (response?.artifacts ?? []).map((artifact) => {
    const preview = artifactDescriptor(artifact.path);
    return {
      ...artifact,
      format: preview?.format ?? downloadFormat(artifact.fileName),
      preview,
    };
  });
}

function downloadFormat(fileName: string): string {
  const extensionAt = fileName.lastIndexOf(".");
  return extensionAt >= 0 && extensionAt < fileName.length - 1
    ? fileName.slice(extensionAt + 1).toUpperCase()
    : "FILE";
}

function extensionLabel(extension: string): string {
  if (extension === "jpg" || extension === "jpeg") return "JPEG";
  return extension.toUpperCase();
}

export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function safeArtifactHtml(source: string): string {
  const document = new DOMParser().parseFromString(source, "text/html");
  document
    .querySelectorAll("script, iframe, frame, object, embed, form, base, meta[http-equiv]")
    .forEach((element) => element.remove());

  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        ["action", "formaction", "href", "poster", "src", "srcset", "xlink:href"].includes(name) &&
        !safeEmbeddedUrl(value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element instanceof HTMLAnchorElement) {
      const fragment = element.getAttribute("href")?.trim();
      if (fragment?.startsWith("#")) {
        // A bare fragment in srcdoc would resolve against the embedding page.
        element.setAttribute("href", `about:srcdoc${fragment}`);
        element.target = "_self";
      } else {
        element.target = "_blank";
      }
      element.rel = "noopener noreferrer";
    }
  }

  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  document.head.prepend(policy);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function safeEmbeddedUrl(value: string): boolean {
  if (!value || value.startsWith("#")) return true;
  return /^(?:data|blob):/i.test(value);
}
