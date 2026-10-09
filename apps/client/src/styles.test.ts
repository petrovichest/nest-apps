// @vitest-environment node

import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

// Optical geometry, not surface radii: document/image edge and inline-link focus.
const opticalRadii = new Map([
  [".artifact-document, .artifact-html-frame", "2px"],
  [".artifact-image", "2px"],
  [".fork-parent-link:focus-visible", "3px"],
]);

describe("shared surface radii", () => {
  for (const file of globSync(["apps/client/src/**/*.css", "apps/extension/src/**/*.css"], {
    cwd: root,
  }).sort()) {
    it(`${file} uses the shared scale or explicit component geometry`, () => {
      const css = readFileSync(resolve(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const violations: string[] = [];
      for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = block[1]!.trim().replace(/\s+/g, " ");
        for (const declaration of block[2]!.matchAll(/\bborder(?:-[\w-]+)?-radius:\s*([^;]+);/g)) {
          const value = declaration[1]!.trim();
          if (opticalRadii.get(selector) === value) continue;
          // The composer keeps its existing compact mobile radius.
          if (selector === ".composer-box" && value === "24px") continue;
          const remaining = value
            .replace(/var\(--radius-(?:sm|md|lg)\)/g, "")
            .replace(/var\(--chat-radius(?:-(?:control|card|surface|compact|checkbox))?\)/g, "")
            .replace(/var\(--sidebar-radius-(?:row|menu)\)/g, "")
            .replace(/\b(?:0|50%|999px)(?=\s|$)/g, "")
            .trim();
          if (remaining) violations.push(`${selector}: ${value}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

describe("application typography roles", () => {
  for (const file of globSync("apps/client/src/**/*.css", { cwd: root }).sort()) {
    it(`${file} uses role tokens for font sizes, including shorthand`, () => {
      const css = readFileSync(resolve(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const violations: string[] = [];
      for (const declaration of css.matchAll(/\b(font-size|font):\s*([^;{}]+);/g)) {
        const value = declaration[2]!.trim();
        if (value === "inherit" || /var\(--text-[\w-]+\)/.test(value)) continue;
        violations.push(declaration[0]);
      }
      expect(violations).toEqual([]);
    });
  }
});

describe("working text glint", () => {
  it("is emitted only for users who accept motion and default colours", () => {
    const css = readFileSync(resolve(root, "apps/client/src/styles.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const start = css.indexOf(
      "@media (prefers-reduced-motion: no-preference) and (forced-colors: none)",
    );
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let index = css.indexOf("{", start); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}" && (depth -= 1) === 0) {
        end = index;
        break;
      }
    }
    expect(end).toBeGreaterThan(start);
    const gated = css.slice(start, end + 1);
    const outside = css.slice(0, start) + css.slice(end + 1);
    expect(gated).toContain(".working-text {");
    expect(gated).toContain(".working-text-strong {");
    expect(gated).toContain("animation: working-text-glint");
    // Nothing may style the class outside the gate, otherwise reduced motion would not keep plain text.
    expect(outside).not.toMatch(/\.working-text/);
    expect(outside).toContain("@keyframes working-text-glint");
  });
});

describe("spinner", () => {
  const css = readFileSync(resolve(root, "apps/client/src/styles.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it("is a masked ring whose thickness is a variable, not a border", () => {
    const rule = css.match(/\n\.spinner \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("--spinner-w:");
    expect(rule).toMatch(/\bmask:/);
    expect(rule).not.toMatch(/\bborder(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?:/);
    // A border draws nothing on the spinner, so a thinner ring has to go through the variable.
    for (const block of css.matchAll(/([^{}]*\.spinner[^{}]*)\{([^{}]*)\}/g)) {
      expect(block[2], block[1]!.trim()).not.toMatch(/\bborder-width:/);
    }
  });

  it("stays still and takes the running colour under reduced motion", () => {
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)]
      .map((match) => match[0])
      .join("\n");
    expect(reduced).toMatch(/\.spinner\s*\{[^}]*--spinner-color:\s*var\(--status-running\)/);
    expect(reduced).toMatch(/\.spinner,[^{]*\{\s*animation:\s*none/);
  });
});
