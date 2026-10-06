import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "@playwright/test";

// Generated assets are checked in: ordinary builds do not need a browser.
const brands = {
  codexnest: { favicon: "../../client/public/favicon.svg", output: "../public/chrome/icons" },
  claudenest: {
    favicon: "../../client/public/claude/favicon.svg",
    output: "../public/claude/icons",
  },
};
const selected = process.argv[2] ? [process.argv[2]] : Object.keys(brands);
for (const name of selected) {
  if (!brands[name]) throw new Error(`Unknown brand ${name}`);
  await generate(name, brands[name]);
}

async function generate(name, { favicon, output: outputPath }) {
  const source = await readFile(new URL(favicon, import.meta.url), "utf8");
  const output = resolve(import.meta.dirname, outputPath);
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const size of [16, 32, 48, 128]) {
      const png = await page.evaluate(
        async ({ source, size }) => {
          const image = new Image();
          image.src = `data:image/svg+xml,${encodeURIComponent(source)}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          canvas.getContext("2d").drawImage(image, 0, 0, size, size);
          return canvas.toDataURL("image/png").split(",")[1];
        },
        { source, size },
      );
      await writeFile(resolve(output, `${name}-${size}.png`), Buffer.from(png, "base64"));
    }
  } finally {
    await browser.close();
  }
}
