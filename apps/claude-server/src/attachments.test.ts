import { mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ failSync: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (faults.failSync && String(args[0]).endsWith(".upload")) {
        handle.sync = async () => {
          throw new Error("Injected persistence failure");
        };
      }
      return handle;
    },
  };
});

import {
  appendAttachmentContext,
  AttachmentStore,
  AttachmentTooLargeError,
  AttachmentValidationError,
  isAttachmentShape,
  MAX_ATTACHMENT_BYTES,
  stripAttachmentContext,
} from "./attachments";

const directories: string[] = [];
afterEach(async () => {
  faults.failSync = false;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function store(): Promise<AttachmentStore> {
  const directory = await mkdtemp(join(tmpdir(), "claudenest-attachments-test-"));
  directories.push(directory);
  return new AttachmentStore(join(directory, "attachments"));
}

describe("ClaudeNest attachment storage", () => {
  it("acknowledges private, complete streamed files that a new store can validate", async () => {
    const first = await store();
    const attachment = await first.save(
      "thread",
      "пример.txt",
      "TEXT/PLAIN",
      Readable.from(["one", "two"]),
      6,
    );
    expect(await readFile(attachment.path, "utf8")).toBe("onetwo");
    expect(await new AttachmentStore(first.root).validate("thread", [attachment])).toEqual([
      attachment,
    ]);
    for (const path of [first.root, dirname(dirname(attachment.path)), dirname(attachment.path)]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    expect((await stat(attachment.path)).mode & 0o777).toBe(0o600);
    expect(attachment.mediaType).toBe("text/plain");
  });

  it("sanitizes path traversal, control characters and long UTF-8 filenames", async () => {
    const files = await store();
    const attachment = await files.save(
      "../../thread",
      `../../\\bad\n${"я".repeat(200)}.txt`,
      "bad\r\nheader",
      Readable.from(["x"]),
    );
    expect(attachment.name).not.toMatch(/[\\/\n]/);
    expect(Buffer.byteLength(attachment.name)).toBeLessThanOrEqual(200);
    expect(attachment.mediaType).toBe("application/octet-stream");
    expect(attachment.path.startsWith(`${files.root}/`)).toBe(true);
    expect(isAttachmentShape(attachment)).toBe(true);
  });

  it("rejects references from another session, duplicates, forged paths and modified sizes", async () => {
    const files = await store();
    const attachment = await files.save(
      "one",
      "example.txt",
      "text/plain",
      Readable.from(["hello"]),
    );
    await expect(files.validate("two", [attachment])).rejects.toThrow("does not belong");
    await expect(files.validate("one", [attachment, attachment])).rejects.toThrow("duplicate");
    await expect(files.validate("one", [{ ...attachment, path: "/etc/passwd" }])).rejects.toThrow(
      "does not belong",
    );
    await writeFile(attachment.path, "changed");
    await expect(files.validate("one", [attachment])).rejects.toThrow("unavailable");
    expect(isAttachmentShape({ ...attachment, name: "../file" })).toBe(false);
  });

  it("refuses symlink storage and downloads without reading outside the session", async () => {
    const files = await store();
    const attachment = await files.save(
      "one",
      "example.txt",
      "text/plain",
      Readable.from(["hello"]),
    );
    const outside = join(dirname(files.root), "outside.txt");
    await writeFile(outside, "private");
    await rm(attachment.path);
    await symlink(outside, attachment.path);
    await expect(files.validate("one", [attachment])).rejects.toThrow("unavailable");
    expect(await files.resolveDownload("one", attachment.path)).toBeNull();
    expect(await files.resolveDownload("one", outside)).toBeNull();
    const linkedRoot = join(dirname(files.root), "linked-root");
    await symlink(files.root, linkedRoot);
    await expect(
      new AttachmentStore(linkedRoot).save("two", "a", "text/plain", Readable.from(["x"])),
    ).rejects.toThrow("symlinks");
  });

  it("cleans incomplete and failed uploads instead of returning an acknowledged reference", async () => {
    const files = await store();
    await expect(
      files.save("thread", "a.txt", "text/plain", Readable.from(["short"]), 12),
    ).rejects.toThrow("Incomplete");
    faults.failSync = true;
    await expect(
      files.save("thread", "a.txt", "text/plain", Readable.from(["unsaved"])),
    ).rejects.toThrow("persistence failure");
    const [threadDirectory] = await readdir(files.root);
    expect(await readdir(join(files.root, threadDirectory!))).toEqual([]);
  });

  it("enforces both declared and streamed per-file limits", async () => {
    const files = await store();
    await expect(
      files.save("thread", "a", "text/plain", Readable.from([]), MAX_ATTACHMENT_BYTES + 1),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    await expect(
      files.save(
        "thread",
        "a",
        "text/plain",
        Readable.from([Buffer.allocUnsafe(MAX_ATTACHMENT_BYTES + 1)]),
      ),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    const [threadDirectory] = await readdir(files.root);
    expect(await readdir(join(files.root, threadDirectory!))).toEqual([]);
  });

  it("enforces the cumulative limit using actual filesystem sizes", async () => {
    const files = await store();
    const references = [];
    for (const size of [MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES, 51 * 1024 * 1024]) {
      const reference = await files.save(
        "thread",
        "large.bin",
        "application/octet-stream",
        Readable.from([]),
      );
      const handle = await open(reference.path, "r+");
      try {
        await handle.truncate(size);
      } finally {
        await handle.close();
      }
      references.push({ ...reference, size });
    }
    await expect(files.validate("thread", references)).rejects.toThrow("250 MiB");
  });

  it("aborts a stalled upload and removes its partial file", async () => {
    const files = await store();
    const body = new PassThrough();
    const controller = new AbortController();
    const saved = files.save("thread", "a.txt", "text/plain", body, undefined, controller.signal);
    const assertion = expect(saved).rejects.toThrow("cancel upload");
    await vi.waitFor(async () => expect(await readdir(files.root)).toHaveLength(1));
    controller.abort(new Error("cancel upload"));
    await assertion;
    const [threadDirectory] = await readdir(files.root);
    expect(await readdir(join(files.root, threadDirectory!))).toEqual([]);
  });

  it("offers validated image upload references and independent download/delete operations", async () => {
    const files = await store();
    const image = await files.save("one", "image.png", "image/png", Readable.from(["image"]));
    const other = await files.save("two", "keep.txt", "text/plain", Readable.from(["keep"]));
    expect(await files.imageDataUrl("one", image)).toBe("data:image/png;base64,aW1hZ2U=");
    await expect(files.imageDataUrl("two", image)).rejects.toBeInstanceOf(
      AttachmentValidationError,
    );
    await expect(files.imageDataUrl("two", other)).rejects.toThrow("Unsupported image");
    expect(await files.resolveDownload("one", image.path)).toMatchObject({
      path: image.path,
      fileName: "image.png",
      size: 5,
    });
    await files.remove("one", image.id);
    expect(await files.resolveDownload("one", image.path)).toBeNull();
    await files.removeThread("one");
    expect(await readFile(other.path, "utf8")).toBe("keep");
    await expect(files.remove("two", "../one")).rejects.toBeInstanceOf(AttachmentValidationError);
  });

  it("round trips its own appended context without removing an ordinary user mention", () => {
    const path = "/private/file.txt";
    const attachment = {
      id: "00000000-0000-4000-8000-000000000000",
      name: "file.txt",
      path,
      size: 1,
      mediaType: "text/plain",
    };
    expect(stripAttachmentContext(appendAttachmentContext("hello", [attachment]))).toBe("hello");
    expect(stripAttachmentContext(appendAttachmentContext("", [attachment]))).toBe("");
    const mention = "hello\n\n<claudenest_attachments> is a tag";
    expect(stripAttachmentContext(mention)).toBe(mention);
  });
});
