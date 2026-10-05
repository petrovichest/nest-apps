import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";

import type { ThreadFileAttachment } from "@codexnest/protocol";

export type FileAttachment = ThreadFileAttachment;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 250 * 1024 * 1024;
const CONTEXT_START = "<claudenest_attachments>";
const CONTEXT_END = "</claudenest_attachments>";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class AttachmentTooLargeError extends Error {
  readonly statusCode = 413;
}
export class AttachmentValidationError extends Error {
  readonly statusCode = 400;
}

export function appendAttachmentContext(
  text: string,
  attachments: readonly FileAttachment[],
): string {
  const input = text.trim();
  if (!attachments.length) return input;
  const context = [
    CONTEXT_START,
    "The user attached local files. Read them from these absolute paths before responding:",
    JSON.stringify(
      attachments.map(({ name, path }) => ({ name, path })),
      null,
      2,
    ),
    CONTEXT_END,
  ].join("\n");
  return input ? `${input}\n\n${context}` : context;
}

export function stripAttachmentContext(text: string): string {
  const start = text.lastIndexOf(`\n\n${CONTEXT_START}`);
  if (start >= 0 && text.trimEnd().endsWith(CONTEXT_END)) return text.slice(0, start).trimEnd();
  return text.startsWith(CONTEXT_START) && text.trimEnd().endsWith(CONTEXT_END) ? "" : text;
}

/** Private durable files, independent of both native CLI histories and CodexNest storage. */
export class AttachmentStore {
  readonly root: string;

  constructor(rootPath: string) {
    if (!isAbsolute(rootPath))
      throw new AttachmentValidationError("Attachment root must be absolute");
    this.root = resolve(rootPath);
  }

  async save(
    threadId: string,
    requestedName: string,
    requestedMediaType: string,
    body: Readable,
    contentLength?: number,
    signal?: AbortSignal,
  ): Promise<FileAttachment> {
    signal?.throwIfAborted();
    if (
      typeof requestedName !== "string" ||
      typeof requestedMediaType !== "string" ||
      !body ||
      typeof body[Symbol.asyncIterator] !== "function"
    ) {
      throw new AttachmentValidationError("File name, media type, and upload stream are required");
    }
    if (
      contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) || contentLength < 0)
    ) {
      throw new AttachmentValidationError("Invalid file content length");
    }
    if (contentLength !== undefined && contentLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentTooLargeError("File exceeds the 100 MiB limit");
    }
    const id = randomUUID();
    const name = safeFileName(requestedName);
    const mediaType = safeMediaType(requestedMediaType);
    const threadDirectory = this.threadDirectory(threadId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await realpath(this.root)) !== this.root) {
      throw new AttachmentValidationError("Attachment directory must not contain symlinks");
    }
    await mkdir(threadDirectory, { recursive: true, mode: 0o700 });
    if ((await realpath(threadDirectory)) !== threadDirectory) {
      throw new AttachmentValidationError("Attachment directory must not contain symlinks");
    }
    await chmod(this.root, 0o700);
    await chmod(threadDirectory, 0o700);
    const directory = join(threadDirectory, id);
    await mkdir(directory, { mode: 0o700 });
    const temporary = join(directory, ".upload");
    const path = join(directory, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let size = 0;
    const onAbort = () => body.destroy();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      handle = await open(temporary, "wx", 0o600);
      for await (const value of body) {
        signal?.throwIfAborted();
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        size += chunk.length;
        if (size > MAX_ATTACHMENT_BYTES)
          throw new AttachmentTooLargeError("File exceeds the 100 MiB limit");
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten <= 0) throw new Error("Failed to write file attachment");
          offset += bytesWritten;
        }
      }
      signal?.throwIfAborted();
      if (contentLength !== undefined && contentLength !== size) {
        throw new AttachmentValidationError("Incomplete file upload");
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      // Acknowledgement follows both file and directory persistence barriers.
      for (let current = directory; ; current = dirname(current)) {
        const entry = await open(current, "r");
        try {
          await entry.sync();
        } finally {
          await entry.close();
        }
        if (current === dirname(this.root)) break;
      }
      signal?.throwIfAborted();
      return { id, name, path, size, mediaType };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async validate(
    threadId: string,
    attachments: readonly FileAttachment[],
  ): Promise<FileAttachment[]> {
    if (!Array.isArray(attachments))
      throw new AttachmentValidationError("Invalid file attachments");
    let total = 0;
    const validated: FileAttachment[] = [];
    const seen = new Set<string>();
    for (const attachment of attachments) {
      if (!isAttachmentShape(attachment) || seen.has(attachment.id)) {
        throw new AttachmentValidationError("Invalid or duplicate file attachment");
      }
      seen.add(attachment.id);
      const expected = join(this.threadDirectory(threadId), attachment.id, attachment.name);
      if (attachment.path !== expected) {
        throw new AttachmentValidationError("File attachment does not belong to this session");
      }
      const current = await realpath(expected).catch(() => null);
      if (!current || current !== expected)
        throw new AttachmentValidationError("File attachment is unavailable");
      const info = await Promise.all([stat(current), access(current, constants.R_OK)])
        .then(([value]) => value)
        .catch(() => null);
      if (!info?.isFile() || info.size !== attachment.size) {
        throw new AttachmentValidationError("File attachment is unavailable");
      }
      total += info.size;
      if (total > MAX_MESSAGE_ATTACHMENT_BYTES) {
        throw new AttachmentTooLargeError("Attachments exceed the 250 MiB message limit");
      }
      validated.push({ ...attachment });
    }
    return validated;
  }

  async remove(threadId: string, attachmentId: string): Promise<void> {
    if (!validAttachmentId(attachmentId))
      throw new AttachmentValidationError("Invalid file attachment id");
    await rm(join(this.threadDirectory(threadId), attachmentId), { recursive: true, force: true });
  }

  async removeThread(threadId: string): Promise<void> {
    await rm(this.threadDirectory(threadId), { recursive: true, force: true });
  }

  async resolveDownload(
    threadId: string,
    input: string,
  ): Promise<{ root: string; path: string; fileName: string; size: number } | null> {
    if (!isAbsolute(input)) return null;
    const root = this.threadDirectory(threadId);
    const path = await realpath(input).catch(() => null);
    const nested = path ? relative(root, path) : "";
    if (
      !path ||
      path !== input ||
      !nested ||
      nested.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      nested === ".." ||
      isAbsolute(nested)
    )
      return null;
    const info = await Promise.all([stat(path), access(path, constants.R_OK)])
      .then(([value]) => value)
      .catch(() => null);
    return info?.isFile() ? { root, path, fileName: basename(path), size: info.size } : null;
  }

  async imageDataUrl(threadId: string, attachment: FileAttachment): Promise<string> {
    const [reference] = await this.validate(threadId, [attachment]);
    if (!reference || !IMAGE_TYPES.has(reference.mediaType)) {
      throw new AttachmentValidationError("Unsupported image attachment format");
    }
    const bytes = await readFile(reference.path);
    if (bytes.length !== reference.size)
      throw new AttachmentValidationError("Image attachment changed");
    return `data:${reference.mediaType};base64,${bytes.toString("base64")}`;
  }

  private threadDirectory(threadId: string): string {
    if (typeof threadId !== "string" || !threadId || threadId.length > 500) {
      throw new AttachmentValidationError("Invalid attachment session id");
    }
    return join(this.root, createHash("sha256").update(threadId).digest("hex"));
  }
}

export function isAttachmentShape(value: unknown): value is FileAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<FileAttachment>;
  return (
    validAttachmentId(item.id) &&
    typeof item.name === "string" &&
    item.name === safeFileName(item.name) &&
    typeof item.path === "string" &&
    isAbsolute(item.path) &&
    typeof item.size === "number" &&
    Number.isSafeInteger(item.size) &&
    item.size >= 0 &&
    item.size <= MAX_ATTACHMENT_BYTES &&
    typeof item.mediaType === "string" &&
    item.mediaType === safeMediaType(item.mediaType)
  );
}

function validAttachmentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  );
}

function safeFileName(value: string): string {
  const normalized = basename(value.replace(/[\\/]/gu, "_"))
    .replace(/\p{Cc}/gu, "_")
    .trim();
  const fallback = normalized && normalized !== "." && normalized !== ".." ? normalized : "file";
  let result = "";
  for (const character of fallback) {
    if (Buffer.byteLength(result + character) > 200) break;
    result += character;
  }
  return result || "file";
}

function safeMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)
    ? normalized
    : "application/octet-stream";
}
