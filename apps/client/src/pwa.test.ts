import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

type WebAppManifest = {
  id?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  icons?: Array<{
    src: string;
    sizes: string;
    type: string;
    purpose?: string;
  }>;
};

describe("PWA metadata", () => {
  it("keeps every client route inside the standalone app scope", () => {
    const manifest = readManifest();

    expect(manifest).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
  });

  it("links the manifest and iOS Home Screen metadata from the app shell", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const document = new DOMParser().parseFromString(html, "text/html");

    expect(document.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe(
      "/manifest.webmanifest",
    );
    expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
      "/apple-touch-icon.png",
    );
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute("content"),
    ).toBe("yes");
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content"),
    ).toBe("CodexNest");
  });

  it("ships valid PNG icons at every declared size", () => {
    const manifest = readManifest();
    expect(manifest.icons).toHaveLength(2);

    for (const icon of manifest.icons ?? []) {
      expect(icon.type).toBe("image/png");
      expect(icon.purpose?.split(/\s+/)).toEqual(expect.arrayContaining(["any", "maskable"]));
      const size = Number(icon.sizes.split("x")[0]);
      expect(readPngSize(icon.src)).toEqual({ width: size, height: size });
    }

    expect(readPngSize("/apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
  });

  it("ships a separate Claude standalone identity and correctly sized icons", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/claude/manifest.webmanifest"), "utf8"),
    );
    expect(manifest).toMatchObject({
      name: "ClaudeNest",
      short_name: "ClaudeNest",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    for (const icon of manifest.icons) {
      const size = Number(icon.sizes.split("x")[0]);
      expect(icon.src).toMatch(/^\/claude\//);
      expect(readPngSize(icon.src)).toEqual({ width: size, height: size });
    }
    expect(readPngSize("/claude/apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
  });

  it("reads the Claude theme without accessing Codex preferences before React starts", () => {
    const shell = new DOMParser().parseFromString(
      '<html data-application="claudenest"><head><meta name="theme-color" content="#FFFFFF"></head></html>',
      "text/html",
    );
    const requestedKeys: string[] = [];
    runInNewContext(readFileSync(resolve(process.cwd(), "public/theme-init.js"), "utf8"), {
      document: shell,
      localStorage: {
        getItem: (key: string) => {
          requestedKeys.push(key);
          return "dark";
        },
      },
      window: { matchMedia: () => ({ matches: false }) },
    });
    expect(requestedKeys).toEqual(["claudenest.theme"]);
    expect(shell.documentElement.dataset.resolvedTheme).toBe("dark");
  });

  it("loads a blocking same-origin theme script before the app under production CSP", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const shell = new DOMParser().parseFromString(html, "text/html");
    const script = shell.head.querySelector('script[src="/theme-init.js"]');
    expect(script).not.toBeNull();
    for (const attr of ["async", "defer", "type"]) expect(script?.hasAttribute(attr)).toBe(false);
    expect(shell.querySelector("script:not([src])")).toBeNull();
  });

  it.each([
    { stored: null, dark: true, mode: "system", resolved: "dark" },
    { stored: "invalid", dark: false, mode: "system", resolved: "light" },
    { stored: "light", dark: true, mode: "light", resolved: "light" },
    { stored: "dark", dark: false, mode: "dark", resolved: "dark" },
  ])(
    "applies $resolved before React with saved $stored and system dark=$dark",
    ({ stored, dark, mode, resolved }) => {
      const shell = new DOMParser().parseFromString(
        '<meta name="theme-color" content="#FFFFFF">',
        "text/html",
      );
      runInNewContext(readFileSync(resolve(process.cwd(), "public/theme-init.js"), "utf8"), {
        document: shell,
        localStorage: { getItem: () => stored },
        window: { matchMedia: () => ({ matches: dark }) },
      });
      expect(shell.documentElement.dataset.theme).toBe(mode);
      expect(shell.documentElement.dataset.resolvedTheme).toBe(resolved);
      expect(shell.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
        resolved === "dark" ? "#171817" : "#FFFFFF",
      );
    },
  );
});

function readManifest(): WebAppManifest {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8"),
  ) as WebAppManifest;
}

function readPngSize(src: string): { width: number; height: number } {
  const file = readFileSync(resolve(process.cwd(), "public", src.replace(/^\//, "")));
  expect(Array.from(file.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
}
