import type { CapacitorConfig } from "@capacitor/cli";

const provider = process.env.NEST_APP_PROVIDER ?? "codex";
if (!["codex", "claude", "gemini", "open"].includes(provider)) {
  throw new Error("NEST_APP_PROVIDER must be codex, claude, gemini or open");
}
const open = provider === "open";
const claude = provider === "claude";
const gemini = provider === "gemini";

const config: CapacitorConfig = {
  appId: open
    ? "com.opennest.app"
    : gemini
      ? "com.gemininest.app"
      : claude
        ? "com.claudenest.app"
        : "com.codexnest.app",
  appName: open ? "OpenNest" : gemini ? "GeminiNest" : claude ? "ClaudeNest" : "CodexNest",
  webDir: open ? "dist-open" : gemini ? "dist-gemini" : claude ? "dist-claude" : "dist",
  server: {
    androidScheme: "http",
    hostname: "localhost",
  },
  android: {
    minWebViewVersion: 83,
  },
};

export default config;
