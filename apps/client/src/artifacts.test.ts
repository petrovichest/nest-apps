import { describe, expect, it } from "vitest";

import {
  artifactDescriptor,
  formatArtifactSize,
  localDownloadPath,
  safeArtifactHtml,
  sessionArtifacts,
} from "./artifacts";

describe("artifactDescriptor", () => {
  it("classifies supported artifact files without treating Office files as previewable", () => {
    expect(artifactDescriptor("/work/report.PDF")).toMatchObject({ kind: "pdf", format: "PDF" });
    expect(artifactDescriptor("/work/notes.md")).toMatchObject({
      kind: "markdown",
      format: "Markdown",
    });
    expect(artifactDescriptor("/work/dashboard.html")).toMatchObject({
      kind: "html",
      format: "HTML",
    });
    expect(artifactDescriptor("/work/image.webp")).toMatchObject({
      kind: "image",
      format: "WEBP",
    });
    expect(artifactDescriptor("/work/deck.pptx")).toBeNull();
  });

  it("formats compact file sizes", () => {
    expect(formatArtifactSize(12)).toBe("12 B");
    expect(formatArtifactSize(1_025)).toBe("2 KB");
    expect(formatArtifactSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("safeArtifactHtml", () => {
  it("keeps document styling while removing active and remote content", () => {
    const html = safeArtifactHtml(`
      <html><head><style>h1 { color: red }</style></head><body>
        <h1 onclick="alert(1)">Report</h1>
        <script>alert(1)</script>
        <img src="https://tracker.example/pixel.png">
        <img src="data:image/png;base64,AA==">
        <a href="https://tracker.example/report">Open</a>
        <form action="https://example.com"><input></form>
      </body></html>
    `);

    expect(html).toContain("h1 { color: red }");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("data:image/png;base64,AA==");
    expect(html).not.toContain("<form");
    expect(html).toContain("Content-Security-Policy");
  });

  it("keeps fragment links in srcdoc without accepting other URLs", () => {
    const doc = new DOMParser().parseFromString(
      safeArtifactHtml(`
        <a id="local" href=" #results " target="_blank">Results</a>
        <a id="external" href="https://example.com/#results" target="_self">External</a>
        <a id="other" href="about:srcdoc#results">Other</a>
      `),
      "text/html",
    );

    expect(doc.getElementById("local")?.getAttribute("href")).toBe("about:srcdoc#results");
    expect(doc.getElementById("local")?.getAttribute("target")).toBe("_self");
    expect(doc.getElementById("external")?.getAttribute("href")).toBeNull();
    expect(doc.getElementById("other")?.getAttribute("href")).toBeNull();
  });
});

describe("localDownloadPath", () => {
  it("decodes confined absolute paths and rejects other hrefs", () => {
    expect(localDownloadPath("/work/report%20final.pdf", "/work/")).toBe("/work/report final.pdf");
    expect(localDownloadPath("/work", "/work/")).toBe("/work");
    expect(localDownloadPath("report.pdf", "/work")).toBeNull();
    expect(localDownloadPath("/workspace/report.pdf", "/work")).toBeNull();
    expect(localDownloadPath("/work/../outside/report.pdf", "/work")).toBeNull();
    expect(localDownloadPath("/work/%2E%2E/outside/report.pdf", "/work")).toBeNull();
    expect(localDownloadPath("/work/%E0%A4%A", "/work")).toBeNull();
  });
});

describe("sessionArtifacts", () => {
  it("enriches only the explicit artifacts returned by the server", () => {
    expect(
      sessionArtifacts({
        capability: "explicit",
        artifacts: [
          {
            id: "artifact-1",
            label: "Итоговый отчёт",
            path: "/work/reports/report.md",
            relativePath: "reports/report.md",
            fileName: "report.md",
            turnId: "turn-1",
            createdAt: 1,
          },
          {
            id: "artifact-2",
            label: "Презентация",
            path: "/work/deck.pptx",
            relativePath: "deck.pptx",
            fileName: "deck.pptx",
            turnId: "turn-1",
            createdAt: 2,
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "artifact-1",
        label: "Итоговый отчёт",
        format: "Markdown",
        preview: expect.objectContaining({ kind: "markdown" }),
      }),
      expect.objectContaining({
        id: "artifact-2",
        format: "PPTX",
        preview: null,
      }),
    ]);
  });
});
