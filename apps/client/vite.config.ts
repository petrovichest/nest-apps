import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

export default defineConfig(({ mode }) => {
  const claude = mode === "claude";
  return {
    plugins: [
      react(),
      ...(claude
        ? [
            {
              name: "claudenest-identity",
              transformIndexHtml(html: string) {
                return html
                  .replaceAll("CodexNest", "ClaudeNest")
                  .replace('<html lang="en">', '<html lang="en" data-application="claudenest">')
                  .replace('href="/manifest.webmanifest"', 'href="/claude/manifest.webmanifest"')
                  .replace('href="/apple-touch-icon.png"', 'href="/claude/apple-touch-icon.png"')
                  .replace('href="/favicon.svg"', 'href="/claude/favicon.svg"');
              },
            },
          ]
        : []),
    ],
    define: {
      ...(claude ? { "import.meta.env.VITE_APP_PROVIDER": JSON.stringify("claude") } : {}),
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
      port: claude ? 5174 : 5173,
      proxy: {
        "/api": { target: claude ? "http://127.0.0.1:4311" : "http://127.0.0.1:4310", ws: true },
      },
    },
    build: { sourcemap: true, outDir: claude ? "dist-claude" : "dist" },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      exclude: [...configDefaults.exclude, "e2e/**"],
    },
  };
});
