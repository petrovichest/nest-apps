import type { CapacitorConfig } from "@capacitor/cli";

const provider = process.env.NEST_APP_PROVIDER ?? "codex";
if (!["codex", "claude", "gemini"].includes(provider)) {
  throw new Error("NEST_APP_PROVIDER must be codex, claude or gemini");
}
const claude = provider === "claude";
const gemini = provider === "gemini";

const config: CapacitorConfig = {
  appId: gemini ? "com.gemininest.app" : claude ? "com.claudenest.app" : "com.codexnest.app",
  appName: gemini ? "GeminiNest" : claude ? "ClaudeNest" : "CodexNest",
  webDir: gemini ? "dist-gemini" : claude ? "dist-claude" : "dist",
  server: {
    androidScheme: "http",
    hostname: "localhost",
  },
  android: {
    minWebViewVersion: 83,
  },
};

export default config;
