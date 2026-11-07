import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

export default defineConfig(({ mode }) => {
  const claude = mode === "claude";
  const gemini = mode === "gemini";
  const variant = gemini ? "gemini" : "claude";
  const product = gemini ? "GeminiNest" : "ClaudeNest";
  return {
    plugins: [
      react(),
      ...(claude || gemini
        ? [
            {
              name: `${variant}nest-identity`,
              transformIndexHtml(html: string) {
                return html
                  .replaceAll("CodexNest", product)
                  .replace('<html lang="en">', `<html lang="en" data-application="${variant}nest">`)
                  .replace(
                    'href="/manifest.webmanifest"',
                    `href="/${variant}/manifest.webmanifest"`,
                  )
                  .replace(
                    'href="/apple-touch-icon.png"',
                    `href="/${variant}/apple-touch-icon.png"`,
                  )
                  .replace('href="/favicon.svg"', `href="/${variant}/favicon.svg"`);
              },
            },
          ]
        : []),
    ],
    define: {
      ...(claude || gemini ? { "import.meta.env.VITE_APP_PROVIDER": JSON.stringify(variant) } : {}),
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(
        process.env.VITE_APP_VERSION ||
          process.env.CODEXNEST_VERSION ||
          process.env.CLAUDENEST_VERSION ||
          "",
      ),
    },
    // Rich copy loads this lazily; prebundle it so the first copy cannot trigger a dev reload.
    optimizeDeps: { include: ["react-dom/server"] },
    server: {
      host: "127.0.0.1",
      port: gemini ? 5175 : claude ? 5174 : 5173,
      proxy: {
        "/api": {
          target: gemini
            ? "http://127.0.0.1:4312"
            : claude
              ? "http://127.0.0.1:4311"
              : "http://127.0.0.1:4310",
          ws: true,
        },
      },
    },
    build: { sourcemap: true, outDir: gemini ? "dist-gemini" : claude ? "dist-claude" : "dist" },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      exclude: [...configDefaults.exclude, "e2e/**"],
    },
  };
});
