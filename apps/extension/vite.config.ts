import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const brands = { chrome: "CodexNest", claude: "ClaudeNest" } as const;

export default ({ mode }: { mode: string }) => {
  if (!(mode in brands)) throw new Error("Build with --mode chrome or --mode claude");
  const appName = brands[mode as keyof typeof brands];
  return {
    publicDir: `public/${mode}`,
    define: { __APP_NAME__: JSON.stringify(appName) },
    plugins: [
      {
        name: "app-name",
        transformIndexHtml: (html: string) => html.replaceAll("CodexNest", appName),
      } satisfies Plugin,
      {
        name: "onest-license",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "assets/LICENSE-Onest-OFL.txt",
            source: readFileSync(
              new URL("../client/src/assets/fonts/LICENSE-Onest-OFL.txt", import.meta.url),
              "utf8",
            ),
          });
        },
      } satisfies Plugin,
    ],
    build: {
      emptyOutDir: true,
      outDir: `dist/${mode}`,
      rollupOptions: {
        input: {
          popup: "popup.html",
          panel: "panel.html",
          background: "src/background.ts",
          content: "src/content.ts",
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
      sourcemap: true,
      target: "chrome116",
    },
  };
};
