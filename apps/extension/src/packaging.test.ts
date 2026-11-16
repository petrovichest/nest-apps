import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const extensionRoot = resolve(import.meta.dirname, "..");

describe("browser packaging", () => {
  it("keeps the fixed Chrome identity and debugger service worker manifest", async () => {
    const manifest = await readJson("public/chrome/manifest.json");
    expect(manifest).toMatchObject({
      manifest_version: 3,
      minimum_chrome_version: "116",
      action: { default_popup: "popup.html" },
      side_panel: { default_path: "panel.html" },
      background: { service_worker: "background.js", type: "module" },
      permissions: expect.arrayContaining(["debugger", "sidePanel"]),
    });
    expect(manifest.key).toMatch(/^MIGf/);
  });

  it("pins a separate OpenNest identity to the protocol origin", async () => {
    const { createHash } = await import("node:crypto");
    const { OPEN_BROWSER_EXTENSION_ID } = await import("@codexnest/protocol");
    const manifest = await readJson("public/open/manifest.json");
    const id = [
      ...createHash("sha256")
        .update(Buffer.from(manifest.key, "base64"))
        .digest("hex")
        .slice(0, 32),
    ]
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join("");
    expect(id).toBe(OPEN_BROWSER_EXTENSION_ID);
    expect(manifest.name).toBe("OpenNest Browser");
    expect(manifest.key).not.toBe((await readJson("public/chrome/manifest.json")).key);
    expect(Object.values(manifest.icons)).toContain("icons/opennest-128.png");
  });

  it("ships popup and panel surfaces from the shared popup entrypoint", async () => {
    const [popup, panel] = await Promise.all([
      readFile(resolve(extensionRoot, "popup.html"), "utf8"),
      readFile(resolve(extensionRoot, "panel.html"), "utf8"),
    ]);

    expect(popup).toContain('<body data-surface="popup">');
    expect(panel).toContain('<body data-surface="panel">');
    expect(popup).toContain('<script type="module" src="/src/popup.ts"></script>');
    expect(panel).toContain('<script type="module" src="/src/popup.ts"></script>');
  });

  it("declares the Chrome ZIP package names", async () => {
    const script = await readFile(resolve(extensionRoot, "scripts/package.mjs"), "utf8");
    expect(script).toContain("${artifactPrefixes[variant]}-browser-${manifest.version}.zip");
    for (const variant of ["chrome", "claude", "gemini", "open"])
      expect(script).toContain(variant + ":");
  });

  it("gives the ClaudeNest and GeminiNest builds their own identities and icons", async () => {
    const [codex, claude, gemini] = await Promise.all([
      readJson("public/chrome/manifest.json"),
      readJson("public/claude/manifest.json"),
      readJson("public/gemini/manifest.json"),
    ]);
    expect(claude).toMatchObject({ name: "ClaudeNest Browser", version: codex.version });
    expect(gemini).toMatchObject({ name: "GeminiNest Browser", version: codex.version });
    expect(claude.key).toMatch(/^MIIB/);
    expect(gemini.key).toMatch(/^MIIB/);
    expect(claude.key).not.toBe(codex.key);
    expect(gemini.key).not.toBe(codex.key);
    expect(gemini.key).not.toBe(claude.key);
    expect(Object.values(claude.icons)).toEqual(
      expect.arrayContaining(["icons/claudenest-16.png", "icons/claudenest-128.png"]),
    );
    expect(Object.values(gemini.icons)).toEqual(
      expect.arrayContaining(["icons/gemininest-16.png", "icons/gemininest-128.png"]),
    );
    expect({
      ...claude,
      name: "",
      short_name: "",
      description: "",
      key: "",
      icons: {},
      action: {},
    }).toEqual({
      ...codex,
      name: "",
      short_name: "",
      description: "",
      key: "",
      icons: {},
      action: {},
    });
    expect({
      ...gemini,
      name: "",
      short_name: "",
      description: "",
      key: "",
      icons: {},
      action: {},
    }).toEqual({
      ...codex,
      name: "",
      short_name: "",
      description: "",
      key: "",
      icons: {},
      action: {},
    });
  });
});

async function readJson(relativePath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve(extensionRoot, relativePath), "utf8"));
}
