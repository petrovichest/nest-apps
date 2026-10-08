export async function copyMarkdown(text: string): Promise<void> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      // Start the write in the user gesture; load the renderer only when copying.
      const html = import("./markdown-clipboard").then(
        ({ renderMarkdownHtml }) => new Blob([renderMarkdownHtml(text)], { type: "text/html" }),
      );
      // Some implementations reject write() before consuming the promised HTML.
      void html.catch(() => undefined);
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": html,
        }),
      ]);
      return;
    } catch {
      // Restricted WebViews and browsers without rich clipboard support.
    }
  }
  await copyText(text);
}

export async function copyText(text: string | Promise<string>): Promise<void> {
  if (typeof text !== "string") {
    // Safari requires starting the write in the click handler, before async data arrives.
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      void blob.catch(() => undefined);
      try {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
        return;
      } catch {
        // Restricted WebViews and browsers without promised clipboard support.
      }
    }
    text = await text;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through for insecure HTTP origins and restricted WebViews.
  }

  const textarea = document.createElement("textarea");
  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  let copied: boolean;
  try {
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
  if (!copied) throw new Error("Clipboard is unavailable");
}
