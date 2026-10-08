import { afterEach, describe, expect, it, vi } from "vitest";
import { copyMarkdown, copyText } from "./clipboard";
import { renderMarkdownHtml } from "./markdown-clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

describe("rich Markdown clipboard", () => {
  it("renders safe GFM from source without controls, raw HTML, or remote image loads", () => {
    const html = renderMarkdownHtml(
      "# Title\n\n**bold** and [link](https://example.com)\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```\n\n![alt](https://example.com/private.png)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<table>");
    expect(html).toContain("<ul>");
    expect(html).toContain("language-ts");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toMatch(/<img|<script|javascript:|private.png|<button|download-ticket/);
  });

  it("writes HTML and the original Markdown in one user-gesture clipboard operation", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    let entries: Record<string, Blob | Promise<Blob>> = {};
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(value: typeof entries) {
          entries = value;
        }
      },
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText },
    });
    const source = "**bold** user@example.com [Email](mailto:user@example.com)";
    const copying = copyMarkdown(source);
    expect(write).toHaveBeenCalledOnce();
    await copying;
    expect(await blobText(await entries["text/plain"]!)).toBe(source);
    const html = await blobText(await entries["text/html"]!);
    expect(html).toContain("<strong>bold</strong> user@example.com Email");
    expect(html).not.toContain("<a");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to plain Markdown when rich clipboard is unavailable or denied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await copyMarkdown("**one**");
    expect(writeText).toHaveBeenLastCalledWith("**one**");
    vi.stubGlobal("ClipboardItem", class {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: vi.fn().mockRejectedValue(new Error("Denied")), writeText },
    });
    await copyMarkdown("**two**");
    expect(writeText).toHaveBeenLastCalledWith("**two**");
  });
});

describe("async text clipboard", () => {
  it("starts writing in the click before the reference request resolves", async () => {
    let resolve!: (value: string) => void;
    const source = new Promise<string>((done) => {
      resolve = done;
    });
    let entries: Record<string, Promise<Blob>> = {};
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(value: typeof entries) {
          entries = value;
        }
      },
    );
    const write = vi.fn(async () => {
      await entries["text/plain"];
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    const copying = copyText(source);
    expect(write).toHaveBeenCalledOnce();
    resolve("Local reference");
    await copying;
    expect(await blobText(await entries["text/plain"]!)).toBe("Local reference");
  });

  it("falls back to writeText and propagates failed reference requests", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", class {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: vi.fn().mockRejectedValue(new Error("Unsupported")), writeText },
    });
    await copyText(Promise.resolve("Local reference"));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Local reference");
    await expect(copyText(Promise.reject(new Error("Offline")))).rejects.toThrow("Offline");
    expect(writeText).toHaveBeenCalledOnce();
  });
});

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}
